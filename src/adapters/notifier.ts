import { createHash } from 'node:crypto';

import type { Secrets } from '../config/env.js';
import type { IsoDate } from '../core/types.js';
import type { HttpFailure, HttpSend } from './http.js';
import { motifDe } from './http.js';

/**
 * Les alertes de la spec §9, en push immediat sur ntfy auto-heberge.
 *
 * « Le mail est un mauvais canal d'alerte : un drawdown le dimanche ne doit pas
 * attendre le lundi. » Ce module est donc le canal court ; le rapport quotidien
 * Brevo est un autre lot et un autre propos.
 *
 * Six choix sont poses ici, et chacun a son motif.
 *
 * 1. **Publication en JSON, pas en entetes.** ntfy accepte les deux : un POST
 *    sur `/<topic>` avec titre et priorite en entetes HTTP, ou un POST sur la
 *    racine avec un corps JSON qui les porte. C'est le second qui est retenu,
 *    parce qu'un entete HTTP n'est pas sur de transporter de l'UTF-8 : un titre
 *    accentue partirait mutile ou ferait echouer la requete, et une alerte
 *    illisible vaut a peine mieux qu'une alerte absente.
 * 2. **`notify` ne rejette jamais**, meme si le transport qu'on lui donne leve.
 *    `openHttp` garantit deja de ne pas rejeter, mais la garantie que ce module
 *    publie ne doit pas dependre du transport qu'on lui passe : c'est elle qui
 *    autorise le run a appeler `notify` sans `try`, et l'appelant ne choisit pas
 *    toujours le transport.
 * 3. **Une alerte, un appel.** Aucun lot, aucune file, aucune reprise. Une
 *    reprise supposerait de retenir le processus, et le job a cinq minutes ;
 *    l'echec est donc rendu a l'appelant, qui decide ce qu'il en fait.
 * 4. **Le jeton ne sort d'ici que dans l'entete `Authorization`.** Il n'entre
 *    dans aucun message, aucun motif, aucun corps. Ce module ne fabrique ni ne
 *    recopie **aucune** chaine d'echec : le motif rendu vient de `motifDe`, qui
 *    ne connait qu'un vocabulaire ferme, et le filet du point 2 rend une
 *    constante. Rien de ce qu'un transport ecrit ne traverse `notify`.
 * 5. **Lire le sort d'un transport est aussi une prise de risque.** Borner ce
 *    qui sort ne dit rien de l'**acte de lire** : `outcome.status` peut etre un
 *    getter, et un getter s'execute. Les deux seules lectures de ce que rend le
 *    transport sont donc a l'interieur du `try` du point 2 : un getter qui leve
 *    tombe dans le meme filet qu'un transport qui leve, et rend la meme
 *    constante. `motifDe` isole de son cote la lecture de la variante.
 * 6. **Chaque message porte une cle deterministe.** Elle ne dedoublonne rien —
 *    voir l'ecart declare sous `alertKey` — mais elle rend un doublon
 *    reconnaissable, par un humain comme par un traitement ulterieur.
 *
 * **Limite declaree, et c'est la frontiere du point 5.** Est traite comme
 * etranger ce que ce module ne construit pas : ce que leve ou rend le transport
 * injecte. L'`Alert` recue ne l'est pas — sa forme est declaree ici et remplie
 * par `src/jobs/alerts.ts` — et ses champs sont donc lus normalement, `alertKey`
 * comprise, hors du `try`. Un appelant qui y poserait un getter qui leve ferait
 * rejeter `notify` ; le couvrir demanderait un `AlertOutcome` sans evenement,
 * c'est-a-dire un sort qui ne dit plus de quelle alerte il parle. Ce qui
 * sortirait alors serait l'objet de cet appelant, jamais le jeton ni l'URL : ils
 * ne sont lus qu'apres, dans le `try`.
 *
 * Ce module ne decide **rien** de ce qui merite une alerte : la liste des
 * evenements et leur redaction vivent dans `src/jobs/alerts.ts`, qui est pur.
 * Ici il n'y a qu'un transport.
 */

/**
 * Les sept evenements qui declenchent un push. Six viennent du §9 ; le septieme
 * est declare dans `docs/alertes.md` avec son motif.
 *
 * La liste est la **source** du type, pas l'inverse : `AlertEvent` en derive,
 * donc toute table indexee par l'evenement est exhaustive a la compilation, et
 * un evenement ajoute sans priorite ne compile pas.
 */
export const ALERT_EVENTS = [
  'REBALANCE_EXECUTED',
  'DRAWDOWN',
  'REBALANCE_TOO_LARGE',
  'RECONCILIATION_DRIFT',
  'RISK_REJECTED',
  'RUN_ABORTED',
  'JOB_FAILED',
] as const;

export type AlertEvent = (typeof ALERT_EVENTS)[number];

/**
 * Deux niveaux, pas cinq. `URGENT` est celui qui traverse le mode « ne pas
 * deranger » d'Android : il est reserve a ce qui ne peut pas attendre le
 * lendemain matin. Tout mettre en urgent reviendrait a n'avoir qu'un niveau, et
 * l'operateur apprendrait a les ignorer tous.
 */
export type AlertPriority = 'URGENT' | 'HIGH';

/** L'echelle ntfy : 5 = max, 4 = high. */
const NTFY_PRIORITY: Readonly<Record<AlertPriority, number>> = { URGENT: 5, HIGH: 4 };

export interface Alert {
  readonly event: AlertEvent;
  readonly priority: AlertPriority;
  /** Le jour du run qui emet l'alerte. Premiere composante de la cle. */
  readonly runDate: IsoDate;
  /** Une ligne, lisible sur l'ecran verrouille d'un telephone. */
  readonly title: string;
  readonly body: string;
}

export type AlertOutcome =
  | { readonly status: 'SENT'; readonly event: AlertEvent; readonly key: string }
  | {
      readonly status: 'FAILED';
      readonly event: AlertEvent;
      readonly key: string;
      readonly reason: string;
    };

export interface Notifier {
  /** Rend le sort de l'alerte. **Ne rejette jamais.** */
  notify(alert: Alert): Promise<AlertOutcome>;
}

type NtfySecrets = Pick<Secrets, 'ntfyUrl' | 'ntfyTopic' | 'ntfyToken'>;

/**
 * Separation de domaine et suffixe de version, comme `clientOrderId` : la cle
 * ne porte pas que ses composantes, elle porte aussi ce a quoi elle sert, et un
 * changement d'encodage se declare au lieu de passer pour un detail.
 */
const KEY_DOMAIN = 'ubac.alert-key.v1';
const KEY_PREFIX = 'cle-';

/** 12 hexadecimaux, 48 bits. Quelques alertes par jour, lisibles d'un coup d'oeil. */
const KEY_HEX_LENGTH = 12;

/**
 * La cle deterministe d'une alerte : `sha256(domaine | run_date | evenement |
 * titre | corps)`, tronquee. Meme alerte le meme jour, meme cle ; une
 * composante qui bouge, cle differente.
 *
 * **Ecart assume avec la regle d'idempotence d'`AGENTS.md`.** Ce POST n'est pas
 * idempotent et ntfy ne dedoublonne pas : un rejeu du meme jour renvoie les
 * memes alertes. La cle ne l'empeche pas, elle rend le doublon
 * **reconnaissable** — dans les `tags` du message pour un humain, dans
 * l'`AlertOutcome` pour un journal. Le cout est benin pour une notification et
 * ne le serait pas pour un ordre : l'ecart vaut ici et nulle part ailleurs. Son
 * motif complet et ce qui le leverait sont dans `docs/alertes.md` §5.
 *
 * L'encodage est prefixe par longueur plutot que joint par un separateur : la
 * collision entre deux alertes distinctes devient impossible par construction,
 * au lieu de reposer sur l'absence du separateur dans un titre libre.
 */
export function alertKey(alert: Alert): string {
  const canonical = [KEY_DOMAIN, alert.runDate, alert.event, alert.title, alert.body]
    .map((champ) => `${String(champ.length)}:${champ}`)
    .join('');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${KEY_PREFIX}${digest.slice(0, KEY_HEX_LENGTH)}`;
}

/**
 * L'URL de publication est `NTFY_URL` telle quelle, normalisee par `URL`. Elle
 * n'est pas recomposee a partir de ses morceaux et le topic ne lui est pas
 * concatene : le topic voyage dans le corps JSON. Un serveur monte derriere un
 * prefixe de chemin continue donc de fonctionner, ce qu'un `new URL('/', base)`
 * aurait casse en silence.
 */
export function openNotifier(secrets: NtfySecrets, send: HttpSend): Notifier {
  const url = new URL(secrets.ntfyUrl).toString();
  return {
    async notify(alert: Alert): Promise<AlertOutcome> {
      const key = alertKey(alert);
      try {
        const outcome = await send({
          url,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secrets.ntfyToken}`,
          },
          body: JSON.stringify({
            topic: secrets.ntfyTopic,
            title: alert.title,
            message: alert.body,
            priority: NTFY_PRIORITY[alert.priority],
            tags: [alert.event, key],
          }),
        });
        if (outcome.status === 'OK') return { status: 'SENT', event: alert.event, key };
        /*
         * `outcome.failure` est **classe**, jamais recopie : `motifDe` n'en lit
         * que la variante. Un transport qui rendrait un motif en clair — le
         * `reason` d'une version anterieure de ce contrat, par exemple — le
         * verrait ignore, et c'est le but.
         *
         * Cette lecture-ci, comme celle de `status` juste au-dessus, est dans le
         * `try` : ce sont les deux seuls endroits ou ce module touche a un objet
         * qu'il n'a pas fabrique, et un getter qui leve y tombe dans le filet du
         * `catch` au lieu de faire rejeter `notify`.
         */
        const failure: HttpFailure | undefined = outcome.failure;
        return { status: 'FAILED', event: alert.event, key, reason: motifDe(failure) };
      } catch {
        /*
         * Le filet de la propriete 2, et une **constante**. L'erreur attrapee
         * n'est pas lue du tout : ni son message, ni son nom, ni sa cause, ni sa
         * pile. Pas meme pour la classer — la lire suffirait a executer un
         * getter, et un getter qui leve en citant le jeton ferait rejeter
         * `notify` en emportant ce jeton. Un transport tiers qui leve en citant
         * l'URL du topic ou le jeton ne nous fait donc rien ecrire, qu'il leve
         * la valeur ou qu'il leve a la lecture. Limite declaree : la contrepartie
         * est qu'un transport casse ne se distingue pas d'un autre dans le motif.
         */
        return { status: 'FAILED', event: alert.event, key, reason: 'transport en echec' };
      }
    },
  };
}
