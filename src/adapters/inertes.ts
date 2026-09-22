import type { Order } from '../core/types.js';
import type { DailyReportMail } from '../report/daily-report.js';
import type { CancelOutcome, ExecutionPort, PlacedOrder } from './coinbase.js';
import { createOrderBody } from './coinbase.js';
import type { DecisionToRecord, RecordDecisionOutcome, SnapshotToRecord, UbacDatabase } from './db.js';
import type { Healthcheck, PingOutcome, RunPulse } from './healthcheck.js';
import type { MailOutcome, Mailer } from './mailer.js';
import type { Alert, AlertOutcome, Notifier } from './notifier.js';
import { alertKey } from './notifier.js';

/**
 * Les ports inertes : des implementations **des memes types** que les vrais,
 * qui journalisent ce qu'elles auraient fait et ne le font pas (E14 a E16 de la
 * phase 3). Aucune ne sait dans quel mode elle tourne, et aucun module en aval
 * ne sait s'il leur parle : c'est `src/jobs/daily-main.ts` qui les compose a la
 * place des vrais, et lui seul (E15). `docs/run-quotidien.md` §8.
 *
 * Trois proprietes gouvernent ce fichier.
 *
 * 1. **Lire reste reel, ecrire ne l'est plus.** La base inerte garde les
 *    lectures de la vraie : un run sur une photo absente et sans flux ne
 *    rejouerait rien de la journee. Ses deux ecritures, elles, ne partent pas.
 * 2. **Une reponse nominale, jamais degradee.** Chaque port rend ce que le vrai
 *    rendrait un jour sans panne — `RECORDED`, `SENT`, `PINGED`. Un `FAILED`
 *    ferait sortir le run en 1 et le pulse en `NON_RENDU` pour une raison qui
 *    n'est pas la sienne : on croirait avoir trouve un bug.
 * 3. **Chaque port dit ce qu'il retient, sur sa propre ligne**, juste avant la
 *    ligne ou `daily.ts` rapporte la reponse. Ni secret ni URL : aucun de ces
 *    ports n'en recoit.
 */

/** Une ligne de journal, sans niveau : le meme contrat que `RunLogger`. */
export type Journal = (line: string) => void;

/**
 * Les ports dont un appel laisse une trace hors du processus : les deux
 * ecritures en base, les trois envois du §9, et l'exchange. Tout ce que le
 * `DRY_RUN` doit remplacer, et rien de plus : les lectures de l'exchange et du
 * marche restent celles des vrais adapters.
 */
export interface Effets {
  readonly db: UbacDatabase;
  readonly notifier: Notifier;
  readonly mailer: Mailer;
  readonly healthcheck: Healthcheck;
  readonly execution: ExecutionPort;
}

/**
 * L'identifiant d'une decision qui n'a pas ete ecrite : l'UUID nul. Il a la
 * forme de `decisions.id` — un port en aval qui le recopierait ne leverait pas —
 * et aucune ligne reelle ne le porte, `defaultRandom()` ne le tirant jamais.
 */
export const DECISION_NON_ECRITE = '00000000-0000-0000-0000-000000000000';

/**
 * Le statut HTTP d'un echange qui n'a pas eu lieu. Zero, et jamais un code que
 * Brevo aurait pu rendre : la ligne « parti (HTTP 0) » se lit pour ce qu'elle
 * est.
 */
export const AUCUN_ECHANGE_HTTP = 0;

/** Le prefixe de l'identifiant d'exchange d'un ordre journalise, jamais place. */
export const ORDRE_NON_PLACE = 'non-place-';

/**
 * La base, sans ses ecritures. Le type est `UbacDatabase` **en entier**, et non
 * un `Pick` : une operation ajoutee a la base ne compile pas ici tant qu'on n'a
 * pas decide si c'est une lecture, qui passe, ou une ecriture, qui se retient.
 *
 * `RECORDED` et non `ALREADY_RECORDED` : le `DRY_RUN` ne sait pas si le run du
 * jour a deja eu lieu, et ne le demande pas. Il rejoue la journee comme si elle
 * etait la premiere, ce qui est la seule facon de voir ce qu'elle deciderait.
 */
export function baseSansEcriture(db: UbacDatabase, log: Journal): UbacDatabase {
  return {
    recordDecision(input: DecisionToRecord): Promise<RecordDecisionOutcome> {
      const { strategy, runDate } = input.intent;
      log(`base inerte : decision ${strategy}${input.isShadow ? ' (shadow)' : ''} du ${runDate} non ecrite`);
      return Promise.resolve({ status: 'RECORDED', id: DECISION_NON_ECRITE });
    },
    recordSnapshot(input: SnapshotToRecord): Promise<void> {
      log(`base inerte : photo du ${input.runDate} non ecrite`);
      return Promise.resolve();
    },
    latestSnapshot: () => db.latestSnapshot(),
    snapshotSeries: () => db.snapshotSeries(),
    recentCashFlows: (since) => db.recentCashFlows(since),
    pendingOrders: () => db.pendingOrders(),
    // Fermer la connexion des lectures : ce n'est pas une ecriture.
    close: () => db.close(),
  };
}

/** ntfy, sans l'envoi. Le titre est celui que l'ecran verrouille aurait affiche. */
export function notifierInerte(log: Journal): Notifier {
  return {
    notify(alert: Alert): Promise<AlertOutcome> {
      log(`ntfy inerte : alerte ${alert.event} retenue, non envoyee — ${alert.title}`);
      return Promise.resolve({ status: 'SENT', event: alert.event, key: alertKey(alert) });
    },
  };
}

/** Brevo, sans l'envoi (D10). Le rapport est rendu par `daily.ts`, seul son depart est retenu. */
export function mailerInerte(log: Journal): Mailer {
  return {
    sendReport(mail: DailyReportMail): Promise<MailOutcome> {
      log(`brevo inerte : rapport retenu, non envoye — ${mail.subject}`);
      return Promise.resolve({ status: 'SENT', httpStatus: AUCUN_ECHANGE_HTTP });
    },
  };
}

/**
 * Le ping, retenu : sans lui, updown.io croirait conclu un run qui n'a pas eu
 * lieu. `marked` dit ce que le corps aurait dit, comme `healthcheck.ts`.
 */
export function healthcheckInerte(log: Journal): Healthcheck {
  return {
    ping(pulse: RunPulse): Promise<PingOutcome> {
      log(`healthcheck inerte : ping retenu, non envoye (${pulse.ending.kind})`);
      return Promise.resolve({ status: 'PINGED', marked: pulse.ending.kind === 'CONCLU' });
    },
  };
}

/**
 * Le mock d'execution qui journalise (E14). Les six champs sont lus sur le
 * **corps meme** que l'executeur reel enverrait, `createOrderBody` : la paire,
 * les grandeurs en chaines et `post_only`, du type `true`, sont les siens. Un
 * ordre que l'executeur refuserait de formuler — une quantite nulle — leve ici
 * de la meme facon.
 *
 * Le `client_order_id` est celui de l'ordre recu, donc celui de
 * `core/order-id.ts` : le port n'en fabrique aucun, et le journal dit ce que
 * l'idempotence du lendemain rencontrerait.
 */
export function executionJournalisee(log: Journal): ExecutionPort {
  return {
    async placeOrder(order: Order): Promise<PlacedOrder> {
      const corps = createOrderBody(order);
      const limite = corps.order_configuration.limit_limit_gtc;
      log(
        `ordre non place (port journalisant) : client_order_id=${corps.client_order_id} paire=${corps.product_id} cote=${corps.side} quantite=${limite.base_size} prix_limite=${limite.limit_price} post_only=${String(limite.post_only)}`,
      );
      return { exchangeId: `${ORDRE_NON_PLACE}${corps.client_order_id}`, clientOrderId: order.clientOrderId };
    },

    async cancelOrders(exchangeIds: readonly string[]): Promise<readonly CancelOutcome[]> {
      for (const exchangeId of exchangeIds) log(`annulation non envoyee (port journalisant) : ${exchangeId}`);
      return exchangeIds.map((exchangeId) => ({ kind: 'CANCELLED', exchangeId }));
    },
  };
}

/**
 * **La substitution entiere, en un appel** : ce que `daily-main.ts` compose en
 * `DRY_RUN` a la place des vrais ports, et ce que les sondes du run complet
 * composent aussi — une seule definition, donc la sonde eprouve la composition
 * reelle et non une recopie.
 *
 * Des vrais ports, seule la base survit, et pour ses lectures. Les quatre autres
 * sont recus pour etre **ecartes** : le resultat ne garde aucune reference vers
 * eux, et c'est ce que la sonde de comptage constate.
 */
export function portsInertes(reels: Effets, log: Journal): Effets {
  return {
    db: baseSansEcriture(reels.db, log),
    notifier: notifierInerte(log),
    mailer: mailerInerte(log),
    healthcheck: healthcheckInerte(log),
    execution: executionJournalisee(log),
  };
}
