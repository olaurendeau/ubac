import type { Decimal } from 'decimal.js';

import type { CoinbaseReader, ExecutionPort } from '../adapters/coinbase.js';
import type {
  CashFlowRecord,
  RecordDecisionOutcome,
  SnapshotPoint,
  SnapshotRecord,
  UbacDatabase,
} from '../adapters/db.js';
import type { Healthcheck, PingOutcome, RunPulse } from '../adapters/healthcheck.js';
import type { MailOutcome, Mailer } from '../adapters/mailer.js';
import type { DailyCandle, DailyWindow, MarketReader } from '../adapters/market.js';
import type { AlertOutcome, Notifier } from '../adapters/notifier.js';
import type { UbacConfig } from '../config/env.js';
import { REBALANCE_CONFIGS } from '../core/config.js';
import type { RebalanceStrategyName } from '../core/config.js';
import { clientOrderId } from '../core/order-id.js';
import type { Holdings, PricedAsset, Prices, ValuationIssue } from '../core/portfolio.js';
import { valuate } from '../core/portfolio.js';
import { validate } from '../core/risk.js';
import { DCA_DEFAULTS, decide as decideDca } from '../core/strategy/dca.js';
import type { LadderDecision } from '../core/strategy/ladder.js';
import { NO_ANCHORS, decide as decideLadder } from '../core/strategy/ladder.js';
import type { RebalanceParams, UndecidableCode } from '../core/strategy/rebalance.js';
import { decide as decideRebalance } from '../core/strategy/rebalance.js';
import type {
  CashFlow,
  Clock,
  Intent,
  IsoDate,
  StrategyName,
  UsdcAmount,
  Verdict,
  Weights,
} from '../core/types.js';
import { renderDailyReport } from '../report/daily-report.js';
import type { AlertInput } from './alerts.js';
import { alertsFor } from './alerts.js';
import type { IssueDeJambe } from './execute.js';
import { auCarnet, placer } from './execute.js';
import type { ReconcileObservations, Resynchronization } from './reconcile.js';
import { reconcile } from './reconcile.js';
import type { BenchmarkGap, DrawdownState, SnapshotWrite, Suspension } from './snapshot.js';
import { prepareSnapshot } from './snapshot.js';

/**
 * Le run quotidien de la spec §8, **etapes 1 a 9**. Il lit, il decide, il
 * journalise, il transmet les ordres de la production, il photographie, il rend
 * compte.
 *
 * **L'etape 6 ne sait pas a qui elle parle.** Les ordres d'un verdict
 * `ACCEPTED` de la seule production passent par `execute.ts` vers le port
 * d'execution, ouvert a l'etape 1 ; `daily-main.ts` compose le port **reel** en
 * mode normal et le **journalisant** d'`inertes.ts` en `DRY_RUN`. Aucune
 * condition de mode n'est ecrite ici (E15) : ce module appelle les memes ports.
 *
 * **Tout le §9 part d'ici** : les alertes push (`alerts.ts`, `docs/alertes.md`),
 * le rapport quotidien (`src/report/daily-report.ts`,
 * `docs/rapport-quotidien.md`) et le ping du healthcheck (`healthcheck.ts`,
 * `docs/healthcheck.md`).
 *
 * Cinq proprietes gouvernent ce fichier.
 *
 * 1. **L'horloge est un parametre, `run_date` comprise.** Rien ici ne lit
 *    l'heure : un run lance a 23 h 59 UTC et son rejeu a 00 h 01 porteraient
 *    sinon deux dates, et l'index unique de `decisions` ne protegerait plus de
 *    rien. L'horloge entre par `DailyRun`, `run_date` et horodatage compris ;
 *    `test/jobs/purete.test.ts` verifie qu'aucun module de `src/jobs/` n'en lit
 *    une autre.
 * 2. **La reconciliation precede toute decision.** Elle n'est pas seulement
 *    appelee en premier : les soldes sortent de `ReconciledBalances`, marque par
 *    un symbole que `reconcile.ts` n'exporte pas, donc un run qui deciderait
 *    d'abord n'aurait aucun `Holdings` a donner a `decide()`. Elle **n'arrete
 *    plus le run** : au-dela du seuil, c'est le cache qui se rend, le run
 *    poursuit sur les soldes reels et la photo de l'etape 7 le rafraichit. Le
 *    jour est alors marque — en alerte, et en tete de `decisions.reason`.
 * 3. **La bougie du jour en cours est incomplete.** L'adapter la rend telle
 *    quelle et documente que c'est a l'appelant de ne pas la demander : c'est
 *    ici. La fenetre s'arrete au dernier jour **clos**, et `closingPrices` refuse
 *    une serie qui ne finit pas dessus.
 * 4. **L'idempotence de `decisions` vient de la base.** Aucune condition de ce
 *    fichier ne verifie qu'un run a deja eu lieu : `recordDecision` est appelee
 *    a chaque run, et c'est l'index unique `(run_date, strategy, is_shadow)` qui
 *    refuse la seconde ecriture en rendant `ALREADY_RECORDED`. Celle de
 *    `snapshots` ne peut pas venir de la meme place : sa cle primaire accepte le
 *    remplacement, et l'indice de croissance qu'une photo porte ne se rechaine
 *    pas sur lui-meme. C'est `snapshot.ts` qui la tient, et le motif y est.
 * 5. **La photo est calculee avant l'etape 5 et ecrite apres.** La suspension au
 *    drawdown du §6 est une entree de la decision : elle ne peut pas attendre
 *    l'etape 7. L'ecriture, elle, reste en derniere position, ce qui donne
 *    gratuitement la propriete que la spec attend d'un abandon — **un run
 *    abandonne n'ecrit aucune photo**, parce qu'il rend avant d'y arriver.
 *
 * Une sixieme propriete vient de ce qui se raconte. **Alertes et rapport partent
 * apres le run, jamais pendant.** `runDaily` enveloppe l'enchainement complet,
 * le laisse rendre son resultat ou lever, puis rend compte de ce qu'il constate.
 * Consequence voulue : rien de ce qui se raconte ne peut changer ce que le run
 * ecrit, et le run ne peut pas tomber parce qu'un compte rendu n'est pas parti —
 * `notifier.ts` et `mailer.ts` garantissent chacun de ne jamais rejeter, et
 * c'est la, en un seul endroit par canal, que la garantie vit.
 *
 * **Les deux canaux ne disent pas la meme chose, et l'ordre le dit.** Les
 * alertes partent d'abord : c'est le canal court, celui qui reveille. Le rapport
 * suit : c'est le canal long, celui qui se lit au petit dejeuner. Un run qui
 * n'a rien a alerter envoie quand meme son rapport — `trigger NONE` compris —,
 * parce qu'un operateur qui ne recoit rien ne distingue pas un systeme qui n'a
 * rien eu a faire d'un systeme qui n'a pas tourne.
 *
 * Une septieme vient du healthcheck, et elle se lit a l'envers des six autres :
 * **c'est l'absence de ping qui alerte.** Le ping part en toute derniere
 * position, apres les alertes, et une exception n'en envoie **aucun** — pas meme
 * un ping d'echec. Le motif est sous `runDaily`, et il est le coeur du lot :
 * un ping d'echec suppose que le code a survecu assez pour le decider, et une
 * exception n'offre pas cette garantie.
 *
 * Deux branches de ce fichier sont **inatteignables par construction**, et le
 * disent la ou elles se trouvent : le franchissement d'ancre du ladder, prive
 * de memoire faute d'ancre persistee, et le rejet de valorisation du DCA, que
 * l'etape 4 a deja exclu. Aucune sonde ne les couvre ; c'est declare, pas
 * masque.
 */

/** Une anomalie de run : l'entree ne ressemble pas a ce que l'enchainement attend. */
export class DailyRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyRunError';
  }
}

// --- Horloge et calendrier --------------------------------------------------

/**
 * L'horloge du run. `today()` satisfait le `Clock` du noyau ; `instant()` porte
 * l'horodatage journalise dans `decisions.created_at`. Les deux sont fournies
 * par l'appelant : ce module n'a aucune horloge propre.
 */
export interface RunClock extends Clock {
  instant(): Date;
}

/** Journalisation du run. Une ligne, sans niveau : le tri appartient a l'appelant. */
export type RunLogger = (line: string) => void;

const MS_PER_DAY = 86_400_000;

/**
 * L'instant UTC d'un jour. **L'aller-retour est le controle**, et il l'est en
 * entier : une chaine dont la relecture ISO redonne exactement les dix memes
 * caracteres ne peut etre qu'un jour du calendrier. Les deux formes fautives y
 * tombent, et chacune sur sa moitie de la condition :
 * `new Date('2026-13-01T00:00:00.000Z')` rend `Invalid Date`, tandis que
 * `new Date('2026-02-30T00:00:00.000Z')` **reporte au 2 mars** sous Node 22 —
 * c'est le report silencieux qui compte, une `run_date` decalee decalant avec
 * elle la fenetre de marche et la cle de `decisions`.
 *
 * Un motif `^\d{4}-\d{2}-\d{2}$` en tete a ete essaye puis retire : aucune
 * sonde ne le distinguait de son absence, l'aller-retour refusant deja tout ce
 * qui n'est pas la forme canonique.
 */
function dayStart(date: IsoDate, champ: string): Date {
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new DailyRunError(`${champ} : date UTC attendue au format YYYY-MM-DD, recue "${date}".`);
  }
  return instant;
}

/** Le jour UTC decale de `jours`, positif ou negatif. */
function shiftDay(date: IsoDate, jours: number, champ: string): IsoDate {
  return new Date(dayStart(date, champ).getTime() + jours * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

// --- Ports ------------------------------------------------------------------

/**
 * Ce que le run consomme, en `Pick` plutot qu'en interfaces entieres : le type
 * dit exactement ce qu'il touche. L'ecriture sur l'exchange n'y entre que par
 * `execution`, et n'est appelee que par `execute.ts` (E11, A23).
 *
 * `balances` figure dans le `Pick` sans que ce module l'appelle : il passe
 * l'objet a `reconcile`, seul fichier de `src/jobs/` autorise a lire les soldes.
 */
export interface DailyPorts {
  readonly exchange: Pick<CoinbaseReader, 'keyPermissions' | 'balances' | 'openOrders'>;
  readonly market: Pick<MarketReader, 'dailyCandles'>;
  readonly db: Pick<
    UbacDatabase,
    | 'recordDecision'
    | 'recordSnapshot'
    | 'latestSnapshot'
    | 'snapshotSeries'
    | 'recentCashFlows'
    | 'pendingOrders'
    | 'recordOrder'
    | 'recordPlacement'
  >;
  /** §9 : le canal court. Il ne rejette jamais, donc il n'est jamais entoure d'un `try`. */
  readonly notifier: Notifier;
  /** §9 : le canal long. Meme garantie, meme absence de `try`. */
  readonly mailer: Mailer;
  /** §9 : la surveillance d'absence. Elle ne rejette jamais non plus, meme motif. */
  readonly healthcheck: Healthcheck;
  /**
   * Etape 1 : ouvre le port d'execution, que l'etape 6 passe a `execute.ts`.
   * Ouvert **au demarrage** : le port reel leve sur une cle qui ne peut pas
   * trader (E7), et le run refuse alors de demarrer, alerte comprise.
   */
  readonly execution: () => Promise<ExecutionPort>;
}

export interface DailyRun {
  readonly ports: DailyPorts;
  readonly clock: RunClock;
  readonly config: UbacConfig;
  /** Persiste dans `decisions` : on doit pouvoir dire quel code tournait ce jour-la. */
  readonly gitSha: string;
  readonly log: RunLogger;
}

// --- Resultat ---------------------------------------------------------------

/**
 * Le sort du rapport quotidien. `SKIPPED` n'est pas un echec : c'est le seul
 * sort d'un run **abandonne**, et il porte son motif plutot que de se deviner a
 * l'absence des deux autres.
 */
export type ReportDelivery =
  | MailOutcome
  | { readonly status: 'SKIPPED'; readonly reason: string };

/**
 * Ce que le run a fait savoir, sur ses trois canaux, **dans l'ordre ou il l'a
 * fait savoir** : les alertes une par une, puis le rapport, puis le ping qui
 * rapporte le sort des deux premiers.
 *
 * `ping` est **toujours present** ici, et c'est ce qui le rend lisible : ce type
 * ne decrit que les runs qui ont rendu un resultat, et tous pinguent. Le seul
 * chemin qui ne pingue pas est l'exception, qui ne rend pas de `RunReport` du
 * tout — elle releve. Un `ping` optionnel aurait laisse croire le contraire.
 */
export interface RunReport {
  readonly alerts: readonly AlertOutcome[];
  readonly mail: ReportDelivery;
  readonly ping: PingOutcome;
}

/**
 * Les deux etapes ou le run peut encore s'arreter. **`RECONCILE` n'en est plus
 * une** : la divergence de solde etait son unique motif, et elle rafraichit
 * desormais le cache au lieu de geler le systeme.
 */
export type DailyAbort =
  | { readonly step: 'VALUATION'; readonly code: ValuationIssue; readonly reason: string }
  | {
      readonly step: 'DECIDE';
      readonly strategy: StrategyName;
      readonly code: UndecidableCode;
      readonly reason: string;
    };

export interface StrategyOutcome {
  readonly strategy: StrategyName;
  readonly isShadow: boolean;
  readonly intent: Intent;
  readonly verdict: Verdict;
  readonly recorded: RecordDecisionOutcome;
}

/**
 * Le resultat de l'enchainement seul, **avant** que la moindre alerte parte.
 * C'est ce que `runDaily` enveloppe : la separation est ce qui rend impossible
 * qu'une alerte modifie ce que le run a conclu.
 */
type DailyOutcome =
  | {
      readonly status: 'ABORTED';
      readonly runDate: IsoDate;
      readonly abort: DailyAbort;
      /**
       * Ce que le run savait de la suspension au moment d'abandonner. `INACTIVE`
       * pour un abandon anterieur a l'etape 4bis, qui la calcule ; l'abandon
       * d'une strategie indecidable, lui, survient apres, et un drawdown au
       * seuil ce jour-la doit alerter meme si le run s'arrete.
       */
      readonly suspension: Suspension;
      /**
       * Toujours connue, meme ici : les deux abandons restants sont posterieurs
       * a la reconciliation. Une resynchronisation suivie d'un abandon doit
       * alerter des deux faits — le portefeuille a bouge hors du systeme, et le
       * run ne s'est pas conclu.
       */
      readonly resync: Resynchronization;
    }
  | {
      readonly status: 'COMPLETED';
      readonly runDate: IsoDate;
      readonly gitSha: string;
      /** Le dernier jour **clos** : celui dont les cloture ont servi de prix. */
      readonly pricedOn: IsoDate;
      readonly holdings: Holdings;
      readonly prices: Prices;
      readonly weights: Weights;
      /** La fenetre du §8, rendue telle quelle : les benchmarks la consommeront. */
      readonly history: Readonly<Record<PricedAsset, readonly DailyCandle[]>>;
      readonly cashFlows: readonly CashFlow[];
      /**
       * La photo lue **avant** ce run, ou `undefined` au premier. Le P&L du jour
       * du §9 est le quotient de deux indices consecutifs : il demande celui de
       * la veille, et relire `latestSnapshot()` apres l'etape 7 rendrait la
       * photo d'aujourd'hui — le quotient vaudrait 1 et le rapport annoncerait
       * une journee plate qui n'a pas eu lieu. Elle est donc portee ici, pas
       * relue.
       */
      readonly previousSnapshot: SnapshotRecord | undefined;
      /**
       * Les photos lues a l'etape 4bis, de la plus ancienne a la plus recente et
       * **arretees a la veille** : celle du jour part a l'etape 7, apres cette
       * lecture. Le graphe du rapport y ajoute le point du jour lui-meme.
       *
       * Lue au milieu du run, et non juste avant l'envoi du rapport, bien que ce
       * soit la qu'elle serve : le rapport part **apres** que tout est ecrit, et
       * une lecture de base a cet endroit peut lever. Une exception posterieure
       * aux ecritures transformerait un run reussi en `JOB_FAILED` — pour un
       * graphe. Ici, une panne de base doit de toute facon arreter le run, et
       * elle ne ment sur rien.
       */
      readonly snapshotSeries: readonly SnapshotPoint[];
      readonly observations: ReconcileObservations;
      /** §7 : l'etat interne a-t-il du se rendre a l'exchange ce jour-la. */
      readonly resync: Resynchronization;
      readonly outcomes: readonly StrategyOutcome[];
      /** Etape 6 : l'issue de chaque jambe transmise, dans l'ordre de placement. */
      readonly placements: readonly IssueDeJambe[];
      readonly totalValue: UsdcAmount;
      /** Etape 7 : ce qui est parti dans `snapshots.benchmarks`. */
      readonly benchmarks: Readonly<Record<string, Decimal>>;
      /** Les metriques qu'aucune valeur ne represente, et leur motif. */
      readonly benchmarkGaps: readonly BenchmarkGap[];
      readonly drawdown: DrawdownState;
      /** §6 : la production est-elle suspendue ce jour-la. */
      readonly suspension: Suspension;
      readonly snapshot: SnapshotWrite;
    };

export type DailyRunResult = DailyOutcome & { readonly report: RunReport };

// --- Prix -------------------------------------------------------------------

/**
 * Fenetre OHLCV du §8. Aucune sonde d'ici ne verifie qu'elle tient dans un appel
 * de l'API, et il n'en faut pas : c'est l'adapter de marche qui compte les jours
 * demandes contre son plafond et **refuse** au-dela, plutot que de paginer en
 * silence. Un depassement echouerait bruyamment, pas discretement.
 */
const HISTORY_DAYS = 200;

const PRICED: readonly PricedAsset[] = ['BTC', 'ETH'];

/**
 * La cloture du dernier jour clos, par actif cote.
 *
 * Le controle de la derniere date n'est pas decoratif : c'est la seule chose qui
 * distingue une serie arretee hier d'une serie qui inclut la bougie du jour, et
 * cette derniere **bouge** — deux appels a quelques minutes d'intervalle ont
 * rendu deux clotures differentes le 2026-09-11 (voir `src/adapters/market.ts`).
 * Une decision prise dessus serait fausse sans qu'aucun seuil ne morde.
 */
function closingPrices(
  history: Readonly<Record<PricedAsset, readonly DailyCandle[]>>,
  pricedOn: IsoDate,
): Prices {
  const cloture = (asset: PricedAsset) => {
    const serie = history[asset];
    const derniere = serie[serie.length - 1];
    if (derniere === undefined) {
      throw new DailyRunError(`${asset} : serie de bougies vide sur la fenetre demandee.`);
    }
    if (derniere.date !== pricedOn) {
      throw new DailyRunError(
        `${asset} : serie arretee au ${derniere.date}, le dernier jour clos est le ${pricedOn}. La bougie du jour en cours est partielle et ne cloture rien.`,
      );
    }
    return derniere.close;
  };
  return { BTC: cloture('BTC'), ETH: cloture('ETH') };
}

// --- Flux de tresorerie -----------------------------------------------------

function toCashFlow(ligne: CashFlowRecord): CashFlow {
  return {
    occurredOn: ligne.occurredOn,
    amount: ligne.amount,
    ...(ligne.note === null ? {} : { note: ligne.note }),
  };
}

// --- Les quatre strategies --------------------------------------------------

/**
 * Les deux champs qui distinguent les deux configurations de rebalance viennent
 * de `core/config.ts`, qui les fige (C13) ; tout le reste — cibles, bandes,
 * mode, carence — vient de l'operateur. Deux consequences declarees :
 * `UBAC_RATIO_BAND_ENABLED` ne decide de rien ici, c'est le **nom** de la
 * configuration qui arme ou non le declencheur B ; et `UBAC_SHADOW_STRATEGIES`
 * n'en decide pas davantage, le §8 journalisant les quatre strategies toujours.
 */
function rebalanceParams(name: RebalanceStrategyName, config: UbacConfig): RebalanceParams {
  return {
    ...config.rebalance,
    strategy: REBALANCE_CONFIGS[name].strategy,
    ratioBandEnabled: REBALANCE_CONFIGS[name].ratioBandEnabled,
  };
}

/**
 * Le ladder n'a **aucune memoire** d'un run a l'autre en phase 1 : la table
 * `strategy_state` a disparu du modele (§4) et `decisions` ne porte pas d'ancre.
 * Chaque run repart donc de `NO_ANCHORS`, ce qui pose les ancres au cours du
 * jour sans rien franchir : `ANCHOR_CROSSED` est inatteignable.
 *
 * Le `NONE` journalise n'est donc pas le repli complaisant que `ladder.ts`
 * refuse — c'est l'etat reel d'une strategie privee de sa memoire. La
 * comparaison utile du ladder viendra du rejeu sur l'historique, pas de cette
 * ligne. Le garde-fou ci-dessous existe pour le jour ou une ancre serait
 * persistee : `Trigger` (§4) n'a pas de valeur pour un franchissement d'ancre,
 * et l'inventer serait une decision de modele, pas un ajustement de ce fichier.
 *
 * `weightsTarget` reprend les poids constates : le ladder ne vise aucune
 * allocation, et recopier la cible du rebalance ferait lire dans `decisions` une
 * intention qu'il n'a pas.
 */
function ladderIntent(decision: LadderDecision, weights: Weights): Intent {
  if (decision.trigger !== 'NONE') {
    throw new DailyRunError(
      `ladder : trigger ${decision.trigger} alors qu'aucune ancre n'est persistee. Journaliser un franchissement demande une valeur de Trigger que le §4 ne definit pas.`,
    );
  }
  return {
    runDate: decision.runDate,
    strategy: 'ladder',
    trigger: 'NONE',
    reason: decision.reason,
    weightsBefore: weights,
    weightsTarget: weights,
    legs: decision.legs,
  };
}

/**
 * La ligne que la production laisse dans `decisions` un jour suspendu : meme
 * forme qu'un run sans declenchement — `trigger NONE`, zero jambe — mais une
 * `reason` qui porte le marqueur et le chiffre. C'est **la** difference entre un
 * jour suspendu et un jour ou rien n'a tire, et sans elle la base ne permet pas
 * de les distinguer.
 *
 * `weightsTarget` reprend la cible permanente et non les poids constates,
 * contrairement au ladder : la production vise toujours cette allocation, elle
 * ne l'atteint simplement pas aujourd'hui. C'est aussi ce qu'ecrit `decide()`
 * quand il rend `NONE`, donc la colonne reste lisible d'une ligne a l'autre.
 */
function suspendedIntent(
  run: DailyRun,
  name: RebalanceStrategyName,
  weights: Weights,
  suspension: Extract<Suspension, { status: 'ACTIVE' }>,
): Intent {
  return {
    runDate: run.clock.today(),
    strategy: name,
    trigger: 'NONE',
    reason: suspension.reason,
    weightsBefore: weights,
    weightsTarget: rebalanceParams(name, run.config).targets,
    legs: [],
  };
}

/**
 * Le marqueur de resynchronisation, en tete de `decisions.reason`. **C'est la
 * trace durable du lot.** L'alerte reveille le jour meme, mais elle ne se relit
 * pas six mois plus tard ; la ligne de `decisions`, si. Un lecteur du journal
 * des decisions doit pouvoir dire, sans rien d'autre sous la main, que ce
 * jour-la quelqu'un a bouge le portefeuille hors du systeme — et c'est la seule
 * trace qui survive a un push manque.
 *
 * Le texte vient de `reconcile.ts` et n'est pas reecrit ici : une seule source,
 * donc l'alerte et la base ne peuvent pas annoncer deux ecarts differents. Meme
 * choix, et meme motif, que le motif de suspension qui vient de `snapshot.ts` ;
 * la forme est la meme aussi, un marqueur en tete de la `reason`.
 *
 * **Les quatre strategies sont marquees**, pas seulement la production. L'etat
 * resynchronise est celui du portefeuille, pas d'une strategie : n'en marquer
 * qu'une laisserait les trois autres raconter une journee ordinaire, et c'est la
 * ligne qu'on ne lit pas qui ment.
 *
 * Le marqueur **precede** le motif de la strategie et ne le remplace pas,
 * contrairement a la ligne d'un jour suspendu : la decision du jour a bien eu
 * lieu, sur les soldes reels, et son motif reste lisible tel que `decide()` l'a
 * formule.
 */
function marquer(intent: Intent, resync: Resynchronization): Intent {
  if (resync.status !== 'RESYNCHRONIZED') return intent;
  return { ...intent, reason: `${resync.reason}\n${intent.reason}` };
}

interface Decided {
  readonly strategy: StrategyName;
  readonly isShadow: boolean;
  readonly intent: Intent;
}

type DecideAll = { readonly ok: true; readonly decided: readonly Decided[] } | { readonly ok: false; readonly abort: DailyAbort };

/**
 * Les quatre strategies du §8, dans l'ordre, **avant toute ecriture**. Un
 * `UNDECIDABLE` arrete le run entier plutot que de laisser passer trois lignes
 * sur quatre : les quatre partagent le meme etat, et un etat qu'une strategie ne
 * sait pas lire n'est pas un etat sur lequel les autres devraient conclure.
 *
 * L'ordre compte : la premiere configuration de rebalance valide la date de run
 * et les flux avant que le DCA, qui leve au lieu de rendre un code, ne les voie.
 * Une suspension ne perce pas ce filet : elle ne peut porter que sur la
 * **production**, donc l'autre configuration de rebalance passe toujours par
 * `decide()`, avant le ladder et le DCA.
 */
function decideAll(
  run: DailyRun,
  holdings: Holdings,
  prices: Prices,
  weights: Weights,
  cashFlows: readonly CashFlow[],
  suspension: Suspension,
): DecideAll {
  const { clock, config } = run;
  const decided: Decided[] = [];
  const shadow = (name: StrategyName): boolean => name !== config.rebalance.strategy;

  for (const name of ['rebalance', 'rebalance_ab'] as const) {
    if (suspension.status === 'ACTIVE' && !shadow(name)) {
      decided.push({ strategy: name, isShadow: false, intent: suspendedIntent(run, name, weights, suspension) });
      continue;
    }
    const decision = decideRebalance(
      {
        holdings,
        prices,
        cashFlows,
        /*
         * Aucun arbitrage de ratio n'a jamais eu lieu : la phase 1 ne place rien,
         * donc le compteur de B est vide. Ce n'est pas un raccourci, c'est l'etat
         * reel. Il deviendra une lecture de la base quand `orders` portera des
         * executions.
         */
        lastRatioRebalanceOn: null,
      },
      clock,
      rebalanceParams(name, config),
    );
    if (decision.status === 'UNDECIDABLE') {
      return {
        ok: false,
        abort: { step: 'DECIDE', strategy: name, code: decision.code, reason: decision.reason },
      };
    }
    decided.push({ strategy: name, isShadow: shadow(name), intent: decision.intent });
  }

  const ladder = decideLadder({ clock, holdings, prices, anchors: NO_ANCHORS });
  decided.push({
    strategy: 'ladder',
    isShadow: shadow('ladder'),
    intent: ladderIntent(ladder, weights),
  });

  const dca = decideDca({ clock, holdings, prices, config: DCA_DEFAULTS });
  if (dca.status !== 'DECIDED') {
    return {
      ok: false,
      abort: { step: 'DECIDE', strategy: 'dca', code: dca.code, reason: dca.reason },
    };
  }
  decided.push({ strategy: 'dca', isShadow: shadow('dca'), intent: dca.intent });

  return { ok: true, decided };
}

// --- Le run -----------------------------------------------------------------

/**
 * §8, etapes 1 a 7. Rend un resultat ; ne leve que sur une entree qui ne
 * ressemble pas a ce que le type promet — une serie de bougies qui ne finit pas
 * ou l'on a demande, par exemple. **N'alerte pas** : c'est `runDaily` qui le
 * fait, une fois que celui-ci a rendu ou leve.
 */
async function executeRun(run: DailyRun): Promise<DailyOutcome> {
  const { ports, clock, config, gitSha, log } = run;
  const runDate = clock.today();

  // 1. Healthcheck de demarrage : la cle repond, et le run dit ce qu'il est.
  const permissions = await ports.exchange.keyPermissions();
  log(
    `run quotidien — run_date=${runDate} git_sha=${gitSha} portefeuille=${permissions.portfolioUuid} lecture=${String(permissions.canView)}`,
  );
  // E7 : avant toute lecture de solde, toute decision et toute ecriture.
  const execution = { port: await ports.execution(), db: ports.db };

  /*
   * 2. Reconciliation, avant toute decision. **Elle n'abandonne plus.** Au-dela
   * du seuil, le cache se rend : le run garde les soldes de l'exchange, qui font
   * foi, et la photo de l'etape 7 rafraichit la base. Ce n'est pas une
   * indulgence, c'est la sortie de l'impasse — un abandon ne posait aucune photo,
   * donc le run suivant relisait la meme photo perimee et abandonnait de nouveau.
   */
  const reconciled = await reconcile({ exchange: ports.exchange, db: ports.db });
  const { resync } = reconciled;
  const { holdings } = reconciled.balances;
  log(`soldes reconcilies (${reconciled.balances.comparedTo})`);
  if (resync.status === 'RESYNCHRONIZED') log(resync.reason);

  // 3. Soldes reels — ci-dessus — et prix du dernier jour clos.
  const pricedOn = shiftDay(runDate, -1, 'run_date');
  const window: DailyWindow = {
    firstDay: shiftDay(pricedOn, -(HISTORY_DAYS - 1), 'dernier jour clos'),
    lastDay: pricedOn,
  };
  const history: Record<PricedAsset, readonly DailyCandle[]> = { BTC: [], ETH: [] };
  for (const asset of PRICED) {
    history[asset] = await ports.market.dailyCandles(asset, window);
  }
  const prices = closingPrices(history, pricedOn);

  // 4. Poids, et flux de tresorerie assez recents pour geler le declencheur A.
  const valuation = valuate(holdings, prices);
  if (valuation.status === 'REJECTED') {
    log(`abandon : ${valuation.reason}`);
    return {
      status: 'ABORTED',
      runDate,
      abort: { step: 'VALUATION', code: valuation.code, reason: valuation.reason },
      suspension: { status: 'INACTIVE' },
      resync,
    };
  }
  const depuis = dayStart(
    shiftDay(runDate, -config.rebalance.newCashFreezeDays, 'run_date'),
    'debut de carence',
  );
  const cashFlows = (await ports.db.recentCashFlows(depuis)).map(toCashFlow);

  /*
   * 4bis. La photo du jour, **calculee** ici et ecrite a l'etape 7 : la
   * suspension du §6 est une entree de l'etape 5 et ne peut pas attendre.
   *
   * Seconde lecture de `latestSnapshot()` du run : la reconciliation lit la
   * meme ligne pour ses positions. Les faire partager une lecture demanderait de
   * changer le contrat de `reconcile`, qui appartient a un lot integre ; deux
   * lectures d'une ligne que rien n'ecrit entre-temps coutent moins que ca.
   *
   * La fenetre de flux du chainage n'est pas celle de la carence : elle part de
   * l'horodatage de la photo precedente, qui peut etre plus ancien que sept
   * jours si un run a saute. La requete est donc distincte, pas un filtre de la
   * precedente.
   */
  const createdAt = clock.instant();
  const previous = await ports.db.latestSnapshot();
  /* La serie du graphe du rapport, lue ici et pas apres les ecritures : voir `snapshotSeries` sur le resultat. */
  const serie = await ports.db.snapshotSeries();
  const flows = previous === undefined ? [] : await ports.db.recentCashFlows(previous.createdAt);
  const step = prepareSnapshot({
    runDate,
    runInstant: createdAt,
    holdings,
    weights: valuation.weights,
    totalValue: valuation.total,
    history,
    previous,
    flows,
  });
  if (step.suspension.status === 'ACTIVE') log(step.suspension.reason);
  for (const gap of step.gaps) log(`benchmark ${gap.key} indisponible (${gap.code}) : ${gap.reason}`);

  // 5. Les quatre strategies : decide(), validate(), puis persistance.
  const decided = decideAll(run, holdings, prices, valuation.weights, cashFlows, step.suspension);
  if (!decided.ok) {
    log(`abandon : ${decided.abort.reason}`);
    /*
     * Seul abandon posterieur a l'etape 4bis : la suspension est connue, et un
     * drawdown au seuil ce jour-la doit alerter meme si le run s'arrete la.
     */
    return { status: 'ABORTED', runDate, abort: decided.abort, suspension: step.suspension, resync };
  }

  const outcomes: StrategyOutcome[] = [];
  for (const { strategy, isShadow, intent: decide } of decided.decided) {
    const intent = marquer(decide, resync);
    const verdict = validate(intent, {
      makeClientOrderId: clientOrderId,
      mids: prices,
      /*
       * Aucun reequilibrage complet n'a jamais abouti : rien n'est place en
       * phase 1, donc le cooldown de A n'a pas d'ancre. Meme motif que celui de B.
       */
      lastCompleteRebalanceOn: null,
      /*
       * Vide, et non les soldes : la divergence a deja ete tranchee par la
       * reconciliation, qui abandonne le run avant toute decision. La redonner
       * ici ferait dependre deux fois le meme verdict de la meme donnee, et
       * `test/jobs/reconcile-accord-risque.test.ts` tient deja l'accord des deux
       * implementations du seuil.
       */
      balances: [],
      holdings,
      prices,
    });
    /*
     * Ecrite a chaque run, trigger `NONE` compris : un run sans action laisse
     * une trace. Aucune condition ne demande d'abord si la ligne existe — c'est
     * l'index unique qui refuse la seconde, et une lecture prealable laisserait
     * entre le `select` et l'`insert` exactement la fenetre par laquelle une
     * double decision passerait.
     */
    const recorded = await ports.db.recordDecision({
      intent,
      isShadow,
      verdict,
      gitSha,
      createdAt,
    });
    log(
      `${strategy}${isShadow ? ' (shadow)' : ''} : ${intent.trigger}, ${intent.legs.length} jambe(s), risque ${verdict.status} — ${recorded.status}`,
    );
    outcomes.push({ strategy, isShadow, intent, verdict, recorded });
  }

  /*
   * 6. L'execution, **de la production seule et d'un verdict `ACCEPTED`
   * seulement** (E18) : une ombre ne place rien, par definition, et ses
   * `client_order_id` — ceux de la production des que la jambe coincide — le
   * rendraient dangereux.
   *
   * **Premiere ligne de defense d'E24** : une decision `ALREADY_RECORDED` est
   * celle d'un run du jour deja passe, et rien n'est transmis. La seconde, la
   * cle primaire d'`orders`, est dans `execute.ts`. Le `decisionId` rattache
   * chaque ordre a son run, par `decisions.run_date` : S9 en depend.
   */
  const placements: IssueDeJambe[] = [];
  for (const { strategy, isShadow, verdict, recorded } of outcomes) {
    if (isShadow || verdict.status !== 'ACCEPTED' || verdict.orders.length === 0) continue;
    if (recorded.status !== 'RECORDED') {
      log(`${strategy} : decision du jour deja enregistree, aucun ordre transmis`);
      continue;
    }
    const ordres = verdict.orders.map((ordre) => auCarnet(ordre, prices));
    const issues = await placer(execution, { decisionId: recorded.id, createdAt, ordres });
    for (const issue of issues) {
      const detail = issue.kind === 'REJECTED' ? ` (${issue.reason})` : '';
      log(`${strategy} : ${issue.clientOrderId} ${issue.kind}${detail}`);
    }
    placements.push(...issues);
  }

  /*
   * 7. La photo, en derniere position. L'ecriture est le seul effet de l'etape
   * qui reste ici : tout le reste a ete calcule plus haut. C'est ce qui fait
   * qu'un abandon — reconciliation, valorisation, strategie indecidable — ne
   * laisse aucune ligne dans `snapshots`, sans qu'aucune condition ne le dise.
   */
  if (step.write.status === 'TO_RECORD') {
    await ports.db.recordSnapshot(step.write.record);
    log(`snapshot ${runDate} : ${valuation.total.toFixed(2)} USDC, ${String(Object.keys(step.benchmarks).length)} benchmark(s)`);
  } else {
    log(`snapshot ${runDate} non ecrit (${step.write.code}) : ${step.write.reason}`);
  }

  return {
    status: 'COMPLETED',
    runDate,
    gitSha,
    pricedOn,
    holdings,
    prices,
    weights: valuation.weights,
    history,
    cashFlows,
    previousSnapshot: previous,
    snapshotSeries: serie,
    observations: reconciled.observations,
    resync,
    outcomes,
    placements,
    totalValue: valuation.total,
    benchmarks: step.benchmarks,
    benchmarkGaps: step.gaps,
    drawdown: step.drawdown,
    suspension: step.suspension,
    snapshot: step.write,
  };
}

// --- Les alertes ------------------------------------------------------------

/** Le texte d'une erreur, sans supposer que c'en est une. */
function texte(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ce que `alerts.ts` regarde, lu sur ce que le run a conclu. Un seul endroit
 * fait cette traduction, et il est ici : `alerts.ts` reste pur et ne connait pas
 * `DailyOutcome`.
 *
 * `executed` est **vide, toujours**, et ce n'est pas un raccourci : la phase 1
 * ne place rien, donc aucun reequilibrage n'a jamais ete execute. Meme motif que
 * les deux ancres nulles de l'etape 5. Le champ se remplira de la table `orders`
 * quand elle portera des executions.
 */
function alertInputOf(outcome: DailyOutcome): AlertInput {
  if (outcome.status === 'ABORTED') {
    return {
      runDate: outcome.runDate,
      ending: {
        status: 'ABORTED',
        step: outcome.abort.step,
        code: outcome.abort.code,
        reason: outcome.abort.reason,
      },
      suspension: outcome.suspension,
      resync: outcome.resync,
      // Aucun verdict : un abandon survient avant que la couche risque ne parle.
      outcomes: [],
      executed: [],
    };
  }
  return {
    runDate: outcome.runDate,
    ending: { status: 'COMPLETED' },
    suspension: outcome.suspension,
    resync: outcome.resync,
    outcomes: outcome.outcomes.map(({ strategy, isShadow, verdict }) => ({
      strategy,
      isShadow,
      verdict,
    })),
    executed: [],
  };
}

/**
 * Les alertes du run, envoyees une par une et dans l'ordre. **Sequentiel et non
 * en parallele** : l'ordre du catalogue est ce qui met le plus urgent en tete de
 * l'ecran verrouille, et un `Promise.all` le perdrait.
 *
 * Aucun `try` ici, et c'est voulu : `notify` garantit de ne jamais rejeter. Un
 * echec revient donc en valeur, il est journalise sur sa propre ligne — **une
 * alerte qui ne part pas ne doit pas etre silencieuse** — et l'envoi continue
 * avec la suivante. Une panne de ntfy ne doit pas faire perdre les six autres
 * alertes du jour en plus de la premiere.
 */
async function announce(run: DailyRun, input: AlertInput): Promise<readonly AlertOutcome[]> {
  const outcomes: AlertOutcome[] = [];
  for (const alert of alertsFor(input)) {
    const sent = await run.ports.notifier.notify(alert);
    /*
     * L'evenement journalise est lu sur **notre** alerte, pas sur le sort rendu.
     * Deux raisons, et la seconde est la vraie. La premiere : `alertsFor` vient
     * de la fabriquer, donc cette lecture-la ne peut rien reserver. La seconde :
     * `UNREADABLE` ne porte pas d'evenement — c'est l'ecart declare de
     * `notifier.ts` §4 ter — et le lire sur le sort obligerait a une branche
     * qu'aucune sonde ne pourrait atteindre d'ici, nos alertes etant toutes
     * lisibles par construction. Un journal qui nomme l'alerte tentee dit de
     * toute facon plus qu'un journal qui nomme ce que le canal a su en relire.
     */
    run.log(
      sent.status === 'SENT'
        ? `alerte ${alert.event} : partie (${sent.key})`
        : `alerte ${alert.event} : NON PARTIE — ${sent.reason}`,
    );
    outcomes.push(sent);
  }
  return outcomes;
}

// --- Le rapport quotidien ---------------------------------------------------

/**
 * **Un run abandonne n'envoie pas de rapport, et c'est une decision.**
 *
 * Le rendu attend un run **conclu** : sa forme `CompletedRun` exige la valeur
 * totale, les poids, les benchmarks et la photo, qu'un abandon n'a jamais
 * calcules — `test/report/contrat-run.test-d.ts` refuse d'ailleurs l'assignation
 * par le typage. Restait a choisir entre fabriquer un second rendu, « rapport
 * d'abandon », et ne rien envoyer.
 *
 * C'est la seconde qui est retenue, pour deux raisons.
 *
 * 1. **L'abandon est deja dit, et mieux.** `RUN_ABORTED` part en push dans la
 *    minute, en priorite `URGENT`, avec l'etape, le code et le motif. Un
 *    courrier qui repeterait la meme nouvelle au petit dejeuner arriverait apres
 *    la bataille. Le silence que le §9 craignait — un abandon indistinguable
 *    d'un job qui n'a pas tourne — est ferme par l'alerte, pas par le rapport.
 * 2. **Un rapport d'abandon serait un rapport a trous.** Distance au
 *    declenchement, allocation, comparaison, P&L : rien de tout cela n'existe
 *    quand le run s'arrete a la valorisation. Un courrier dont cinq sections
 *    sur six disent « indisponible » apprend a ne plus ouvrir le courrier.
 *
 * Ce qui n'est pas retenu non plus : laisser le cas se resoudre tout seul.
 * L'abandon prend une branche nommee, qui journalise son motif et rend
 * `SKIPPED` — pas une absence de branche, dont on ne saurait pas dire si elle a
 * ete voulue.
 */
const MOTIF_ABANDON =
  "run abandonne : le rendu du §9 demande un run conclu, et l'abandon est deja parti en alerte push.";

/**
 * Les cibles et bandes de la **production**, celles que le rapport confronte aux
 * poids constates. Les deux configurations de rebalance partagent tout sauf
 * `ratioBandEnabled` (C13), et c'est justement ce drapeau que la section
 * « distance au prochain declenchement » lit pour savoir si la bande de ratio
 * est surveillee : prendre `config.rebalance` tel quel afficherait une bande B
 * que la production n'arbitre pas.
 *
 * `env.ts` ne laisse passer que ces deux noms pour `UBAC_STRATEGY` ; le repli
 * est celui de la production.
 */
function productionParams(config: UbacConfig): RebalanceParams {
  const name: RebalanceStrategyName =
    config.rebalance.strategy === 'rebalance_ab' ? 'rebalance_ab' : 'rebalance';
  return rebalanceParams(name, config);
}

/**
 * Le rapport du §9 : rendu ici, poste par `mailer.ts`.
 *
 * Aucun `try`, comme pour les alertes, et pour les deux memes motifs. Le rendu
 * est **pur et total** — `daily-report.ts` ne porte pas un seul `throw`, et
 * aucune de ses branches ne rend `undefined` : un run conclu produit toujours un
 * courrier, `trigger NONE` compris. L'envoi, lui, garantit de ne jamais rejeter,
 * et la garantie vit dans `mailer.ts`. Un echec revient donc en valeur, il est
 * journalise sur sa propre ligne — **un rapport qui ne part pas ne doit pas etre
 * silencieux** — et le run garde son statut : ce qu'il avait a ecrire est ecrit.
 */
async function deliverReport(run: DailyRun, outcome: DailyOutcome): Promise<ReportDelivery> {
  if (outcome.status === 'ABORTED') {
    run.log(`rapport quotidien non envoye — ${MOTIF_ABANDON}`);
    return { status: 'SKIPPED', reason: MOTIF_ABANDON };
  }
  const mail = renderDailyReport({
    run: outcome,
    params: productionParams(run.config),
    previous: outcome.previousSnapshot,
    series: outcome.snapshotSeries,
  });
  const sent = await run.ports.mailer.sendReport(mail);
  run.log(
    sent.status === 'SENT'
      ? `rapport quotidien : parti (HTTP ${String(sent.httpStatus)}) — ${mail.subject}`
      : `rapport quotidien : NON PARTI — ${sent.reason}`,
  );
  return sent;
}

// --- Ce que le run a fait savoir --------------------------------------------

/**
 * **Le compte rendu du run est-il entierement parti** — ses alertes et son
 * rapport.
 *
 * Un seul predicat, et c'est la seule chose qui compte ici. **Trois lecteurs
 * posent la meme question** : `reported` pour le code de sortie, `pulseOf` pour
 * ce que la surveillance lira, et l'operateur pour savoir s'il a tout recu.
 * Trois predicats voisins auraient diverge, et c'est celui qu'on ne relit
 * jamais — le ping, parti chez un tiers — qui se serait tu le jour ou il fallait
 * qu'il parle.
 *
 * Les deux canaux y entrent au meme titre, et pour la meme raison : **la panne
 * d'un canal est exactement la panne que ce canal ne peut pas signaler.** ntfy
 * tombe, le canal court est muet ; Brevo tombe, le canal long l'est aussi. Dans
 * les deux cas le healthcheck est le seul temoin qui ne depende pas du canal en
 * panne, et le code de sortie la seule trace qui reste sur la machine.
 *
 * `SKIPPED` rend faux, et ce n'est **jamais lu comme un echec** : il n'apparait
 * que sur un abandon, et les deux appelants tranchent l'abandon avant d'arriver
 * ici — `reported` exige `COMPLETED`, `pulseOf` rend `ABANDONNE` d'abord. Un
 * `SKIPPED` qui rendrait vrai serait pire : il ferait dire « tout est parti » a
 * un run qui n'a rien envoye.
 */
function toutParti(alerts: readonly AlertOutcome[], mail: ReportDelivery): boolean {
  return alerts.every((a) => a.status === 'SENT') && mail.status === 'SENT';
}

/**
 * Le run a-t-il conclu **et** rendu compte.
 *
 * Les deux moities sont voulues, et la seconde demande un mot. Un compte rendu
 * qui echoue ne fait pas echouer le *travail* du run : rien n'est defait, rien
 * n'est reecrit, le statut reste `COMPLETED`. Mais il fait echouer son *compte
 * rendu*, et ce sont deux choses differentes. Une alerte qui n'est pas partie
 * est un evenement que personne ne verra ; un rapport qui n'est pas parti est
 * une journee entiere que personne ne lira. Les compter comme des succes
 * rendrait le systeme muet exactement quand il a quelque chose a dire.
 *
 * **Le rapport y entre au meme titre que les alertes**, et c'est le seul endroit
 * ou son echec se voie de l'exterieur : le catalogue des sept evenements du §9
 * n'a pas d'entree pour « rapport non envoye », et en detourner une — `JOB_FAILED`
 * pousserait « une exception a echappe au run » — dirait quelque chose de faux
 * sur le canal le plus urgent. Le code de sortie, lui, ne ment pas : il dit que
 * la journee n'a pas ete entierement racontee, et c'est exactement le cas.
 *
 * **Le predicat est partage avec le ping**, et ce n'est pas une economie de
 * lignes : `toutParti` est le seul endroit qui dise ce qu'est un compte rendu
 * parti, pour que le code de sortie et le corps du pulse ne puissent pas
 * diverger. Le motif est sous `toutParti`, et il est teste par enumeration —
 * voir `test/jobs/daily.test.ts`, « la coherence du code de sortie et du
 * marqueur ».
 *
 * La regle vit ici et non dans le point d'entree : `daily-main.ts` n'apparait a
 * aucun rapport de couverture — rien ne peut l'importer (A22) — donc une regle
 * ecrite la-bas serait une regle sans sonde. Ici elle en a.
 *
 * **Le sort du ping n'en fait pas partie, et c'est decide.** Un ping qui n'est
 * pas parti se signale tout seul : son absence est precisement ce qui fait
 * sonner la surveillance. Une alerte qui n'est pas partie, elle, ne laisse rien
 * derriere — d'ou l'asymetrie. Le motif complet est dans `docs/healthcheck.md`
 * §4.
 */
export function reported(result: DailyRunResult): boolean {
  return result.status === 'COMPLETED' && toutParti(result.report.alerts, result.report.mail);
}

/**
 * Ce que le run raconte a sa surveillance, lu sur ce qu'il a conclu. Meme role
 * qu'`alertInputOf`, et meme motif : un seul endroit fait la traduction, et
 * `healthcheck.ts` n'a pas a connaitre `DailyOutcome`.
 *
 * **Trois fins, et la troisieme est la tension du lot tranchee.** Un run conclu
 * dont un compte rendu n'est pas parti — une alerte, le rapport, ou les deux —
 * n'est pas `CONCLU` : le corps ne portera pas le marqueur, et la surveillance
 * le lira `DOWN`. C'est le meme predicat que le code de sortie — `toutParti` —
 * et ce n'est pas une coincidence.
 *
 * Le motif tient en une phrase : **la panne d'un canal est exactement la panne
 * que ce canal ne peut pas signaler.** Si ntfy est tombe, le canal court est
 * muet par definition ; si Brevo est tombe, le canal long l'est aussi. Le
 * healthcheck est le seul canal restant qui ne depende ni de l'un ni de l'autre,
 * et se taire la reviendrait a faire dependre la surveillance du systeme
 * surveille — c'est-a-dire a perdre la raison d'etre du lot. Le travail du run
 * n'est pas defait pour autant : les quatre lignes de `decisions` et la photo
 * restent ecrites, et le statut reste `COMPLETED`. Ce que le pulse rapporte
 * n'est pas « le travail a echoue », c'est « ce run n'a pas rendu compte » —
 * d'ou un etat a lui, `NON_RENDU`, plutot qu'un abandon simule.
 *
 * **Le corps dit lequel des deux canaux a manque**, et ce n'est pas du confort :
 * l'operateur qui voit sonner updown doit savoir s'il lui manque une alerte ou
 * son courrier du matin, et les deux pannes n'ont ni la meme cause ni la meme
 * urgence. `alertsFailed` et `reportFailed` voyagent donc ensemble, et l'un peut
 * valoir zero pendant que l'autre vaut vrai.
 *
 * Le `gitSha` vient de `run` et non de l'`outcome` : un abandon n'en porte pas,
 * et c'est justement une fin dont on veut savoir quel code l'a produite.
 */
function pulseOf(
  run: DailyRun,
  outcome: DailyOutcome,
  alerts: readonly AlertOutcome[],
  mail: ReportDelivery,
): RunPulse {
  const entete = { runDate: outcome.runDate, gitSha: run.gitSha };
  if (outcome.status === 'ABORTED') {
    return {
      ...entete,
      ending: { kind: 'ABANDONNE', step: outcome.abort.step, code: outcome.abort.code },
    };
  }
  if (!toutParti(alerts, mail)) {
    const nonParties = alerts.filter((a) => a.status !== 'SENT').length;
    return {
      ...entete,
      ending: {
        kind: 'NON_RENDU',
        alertsFailed: nonParties,
        reportFailed: mail.status !== 'SENT',
      },
    };
  }
  return {
    ...entete,
    ending: { kind: 'CONCLU', decisions: outcome.outcomes.length, alerts: alerts.length },
  };
}

/**
 * Le ping, et sa ligne de journal.
 *
 * Aucun `try` ici, exactement comme pour les alertes : `ping` garantit de ne
 * jamais rejeter, et la garantie vit en un seul endroit, `healthcheck.ts`. Un
 * echec revient donc en valeur — le run a deja tout ecrit, et une surveillance
 * injoignable n'a pas a defaire son travail.
 *
 * **Mais il ne doit pas etre muet.** Un ping qui n'est pas parti est le debut
 * d'une fausse alerte d'absence : l'operateur verra sonner updown.io sans savoir
 * si le job est mort ou si c'est le ping qui n'a pas abouti. La ligne de journal
 * est ce qui separe les deux, et elle ne porte jamais `HEALTHCHECK_URL` — le
 * motif sort de `motifDe`, dont le vocabulaire est ferme.
 */
async function signal(run: DailyRun, pulse: RunPulse): Promise<PingOutcome> {
  const sent = await run.ports.healthcheck.ping(pulse);
  run.log(
    sent.status === 'PINGED'
      ? `healthcheck : pingue (${pulse.ending.kind})`
      : `healthcheck : NON PINGUE — ${sent.reason}`,
  );
  return sent;
}

/**
 * Le run quotidien, alertes, rapport et ping compris.
 *
 * L'enveloppe est mince et fait exactement quatre choses que l'enchainement ne
 * peut pas faire lui-meme.
 *
 * 1. **Elle alerte sur un abandon.** Un run abandonne n'ecrit rien — ni
 *    decision, ni photo — donc depuis la base il est indistinguable d'un job qui
 *    n'a pas tourne. C'est arrive en reel, sur un portefeuille vide. L'alerte
 *    est la premiere difference ; le ping d'echec ci-dessous en est une seconde,
 *    et elle ne passe pas par le systeme surveille.
 * 2. **Elle alerte sur une exception, puis la releve.** `JOB_FAILED` part, et
 *    l'erreur continue son chemin telle quelle : le point d'entree doit toujours
 *    la voir et sortir en 1. Alerter n'est pas rattraper. Ni rapport ni ping ne
 *    partent dans ce cas : le run n'a rien rendu dont il y aurait un rapport a
 *    rendre, et le motif du ping est plus bas.
 * 3. **Elle envoie le rapport du §9**, apres les alertes et jamais avant : le
 *    canal court passe devant le canal long.
 * 4. **Elle pingue le healthcheck, en toute derniere position.**
 *
 * Ce qu'elle ne fait pas : changer ce que le run a conclu. Le statut, les
 * ecritures et les valeurs rendues sont ceux d'`executeRun`, alertes, rapport et
 * ping ou pas.
 *
 * ### Les trois fins, et pourquoi la troisieme ne pingue pas
 *
 * Un run **conclu** pingue avec le marqueur ; un run **abandonne** pingue sans
 * lui, parce que le job a bien tourne et que la difference doit se voir cote
 * surveillance ; une **exception ne pingue pas du tout**.
 *
 * Ce troisieme cas est le plus important du lot, et c'est pour lui que le
 * `throw` ci-dessous ne passe par aucun ping. Un ping d'echec est une
 * **affirmation** : il dit « j'ai tourne, je n'ai pas abouti ». Or le formuler
 * suppose que le code a survecu assez loin pour le decider — ce qu'une exception
 * ne garantit pas, et ce qu'un processus tue, un conteneur evince ou une memoire
 * epuisee ne garantissent pas davantage. Une surveillance qui croirait un ping
 * d'echec la ou le programme est en train de mourir apprendrait a distinguer
 * deux etats qu'elle ne sait pas distinguer.
 *
 * C'est donc **l'absence de ping** qui parle, et elle a la propriete qu'aucune
 * ligne de code n'aura jamais : elle ne demande a rien de fonctionner. Un job
 * qui ne demarre pas, un job tue a la seconde etape et un job qui leve
 * produisent tous le meme silence, et ce silence est lu de l'exterieur.
 *
 * ### L'ordre des trois, et pourquoi il n'est pas interchangeable
 *
 * Alertes, puis rapport, puis ping — et chaque cran a son motif.
 *
 * Les **alertes d'abord** : c'est le canal court, celui qui reveille, et rien de
 * ce qui suit ne doit retarder une alerte `URGENT`.
 *
 * Le **rapport ensuite** : c'est le canal long, celui qui se lit au petit
 * dejeuner. Un run qui n'a rien a alerter envoie quand meme son rapport —
 * `trigger NONE` compris —, parce qu'un operateur qui ne recoit rien ne
 * distingue pas un systeme qui n'a rien eu a faire d'un systeme qui n'a pas
 * tourne.
 *
 * Le **ping en dernier**, et c'est le cran qui ne se deplace pas : il rapporte
 * ce que le run a **fait savoir**, alertes et rapport compris — voir `pulseOf`.
 * Le placer avant l'envoi du rapport l'obligerait a pinguer sur un courrier pas
 * encore parti, donc a affirmer « tout est rendu » sans l'avoir seulement
 * tente ; la seule facon de dire qu'un rapport n'est pas parti est d'avoir
 * essaye de l'envoyer d'abord.
 */
/**
 * Ce que le run dit de son canal d'alerte quand il part **sans jeton**.
 *
 * Une ligne de journal, tous les jours, et pas une note dans un document : un
 * document se lit une fois, une ligne quotidienne se voit passer. L'ecart est
 * assume (`docs/alertes.md` § 5 bis) mais il porte une echeance, et ce qui n'est
 * rappele nulle part est ce qu'on oublie au bout d'une semaine.
 *
 * Elle est **exportee** pour la meme raison que `RUN_MARKER` l'est depuis
 * `healthcheck.ts` : deux litteraux divergent, et c'est celui qui n'a pas de
 * sonde qui gagne.
 */
export const NTFY_CANAL_OUVERT_LIGNE =
  'ntfy : canal non authentifie declare — les alertes du jour partent en clair, sans jeton porteur. Ecart assume, docs/alertes.md § 5 bis.';

export async function runDaily(run: DailyRun): Promise<DailyRunResult> {
  /*
   * **Avant tout le reste**, y compris avant l'etape 1, et hors du `try`. Le
   * placer dans `executeRun` l'aurait fait dependre de la reponse de Coinbase :
   * un run qui echoue au premier appel est precisement celui ou l'operateur
   * regarde le journal, et c'est celui qui n'aurait rien dit de son canal.
   */
  if (run.config.secrets.ntfyToken === null) run.log(NTFY_CANAL_OUVERT_LIGNE);

  const runDate = run.clock.today();
  let outcome: DailyOutcome;
  try {
    outcome = await executeRun(run);
  } catch (error) {
    await announce(run, {
      runDate,
      ending: { status: 'FAILED', reason: texte(error) },
      suspension: { status: 'INACTIVE' },
      /*
       * `NOT_NEEDED` faute de mieux : l'exception a pu tomber avant meme la
       * reconciliation, et `executeRun` n'a rien rendu dont on pourrait lire le
       * resultat. Ne pas alerter deux fois du meme jour est preferable a affirmer
       * une resynchronisation qu'on n'a pas constatee — `JOB_FAILED` dit deja que
       * ce run n'a rien conclu.
       */
      resync: { status: 'NOT_NEEDED' },
      outcomes: [],
      executed: [],
    });
    /*
     * **Aucun ping ici, et c'est la seule ligne de ce fichier dont l'absence de
     * code est la fonctionnalite.** Voir l'en-tete ci-dessus : ajouter un ping
     * d'echec sur ce chemin rendrait muette la seule chose que la surveillance
     * sait vraiment constater.
     */
    throw error;
  }
  const alerts = await announce(run, alertInputOf(outcome));
  const mail = await deliverReport(run, outcome);
  const ping = await signal(run, pulseOf(run, outcome, alerts, mail));
  return { ...outcome, report: { alerts, mail, ping } };
}
