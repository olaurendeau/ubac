import type { Decimal } from 'decimal.js';

import type { CoinbaseReader } from '../adapters/coinbase.js';
import type { CashFlowRecord, RecordDecisionOutcome, UbacDatabase } from '../adapters/db.js';
import type { Healthcheck, PingOutcome, RunPulse } from '../adapters/healthcheck.js';
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
import type { AlertInput } from './alerts.js';
import { alertsFor } from './alerts.js';
import type { ReconcileObservations } from './reconcile.js';
import { reconcile } from './reconcile.js';
import type { BenchmarkGap, DrawdownState, SnapshotWrite, Suspension } from './snapshot.js';
import { prepareSnapshot } from './snapshot.js';

/**
 * Le run quotidien de la spec §8, **etapes 1 a 5 et 7**. Il lit, il decide, il
 * journalise, il photographie, et il ne place rien.
 *
 * **L'etape 6, l'execution, n'existe pas.** Ce n'est pas une etape laissee vide :
 * aucun code de placement n'est ecrit ici, et le garde-fou de noms
 * d'`eslint.config.js` refuserait celui qui l'ecrirait. Le rapport Brevo
 * appartient a un lot suivant ; **les alertes push du §9 et le ping du
 * healthcheck, eux, partent d'ici** — voir `alerts.ts` et `docs/alertes.md`,
 * `healthcheck.ts` et `docs/healthcheck.md`.
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
 *    d'abord n'aurait aucun `Holdings` a donner a `decide()`. Un abandon de
 *    reconciliation arrete le run **avant** la premiere ecriture.
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
 * Une sixieme propriete vient des alertes. **Elles partent apres le run, jamais
 * pendant.** `runDaily` enveloppe l'enchainement complet, le laisse rendre son
 * resultat ou lever, puis alerte sur ce qu'il constate. Consequence voulue : une
 * alerte ne peut pas changer ce que le run ecrit, et le run ne peut pas tomber
 * parce qu'une alerte n'est pas partie — `notifier.ts` garantit de ne jamais
 * rejeter, et c'est la, en un seul endroit, que la garantie vit.
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
 * dit exactement ce qu'il touche, et rien ici ne peut ecrire sur l'exchange.
 *
 * `balances` figure dans le `Pick` sans que ce module l'appelle : il passe
 * l'objet a `reconcile`, seul fichier de `src/jobs/` autorise a lire les soldes.
 */
export interface DailyPorts {
  readonly exchange: Pick<CoinbaseReader, 'keyPermissions' | 'balances' | 'openOrders'>;
  readonly market: Pick<MarketReader, 'dailyCandles'>;
  readonly db: Pick<
    UbacDatabase,
    'recordDecision' | 'recordSnapshot' | 'latestSnapshot' | 'recentCashFlows' | 'pendingOrders'
  >;
  /** §9 : le canal court. Il ne rejette jamais, donc il n'est jamais entoure d'un `try`. */
  readonly notifier: Notifier;
  /** §9 : la surveillance d'absence. Elle ne rejette jamais non plus, meme motif. */
  readonly healthcheck: Healthcheck;
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
 * Ce que le run a fait savoir, sur ses deux canaux. Une entree par alerte emise,
 * dans l'ordre d'emission, puis le sort du ping de fin de run.
 *
 * `ping` est **toujours present** ici, et c'est ce qui le rend lisible : ce type
 * ne decrit que les runs qui ont rendu un resultat, et tous pinguent. Le seul
 * chemin qui ne pingue pas est l'exception, qui ne rend pas de `RunReport` du
 * tout — elle releve. Un `ping` optionnel aurait laisse croire le contraire.
 */
export interface RunReport {
  readonly alerts: readonly AlertOutcome[];
  readonly ping: PingOutcome;
}

export type DailyAbort =
  | { readonly step: 'RECONCILE'; readonly code: 'RECONCILIATION_DRIFT'; readonly reason: string }
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
      readonly observations: ReconcileObservations;
      readonly outcomes: readonly StrategyOutcome[];
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
 * §8, etapes 1 a 5 et 7. Rend un resultat ; ne leve que sur une entree qui ne
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

  // 2. Reconciliation, avant toute decision.
  const reconciled = await reconcile({ exchange: ports.exchange, db: ports.db });
  if (reconciled.status === 'ABORTED') {
    log(`abandon : ${reconciled.reason}`);
    return {
      status: 'ABORTED',
      runDate,
      abort: { step: 'RECONCILE', code: reconciled.code, reason: reconciled.reason },
      // L'etape 4bis n'a pas eu lieu : il n'y a pas encore de drawdown a connaitre.
      suspension: { status: 'INACTIVE' },
    };
  }
  const { holdings } = reconciled.balances;
  log(`soldes reconcilies (${reconciled.balances.comparedTo})`);

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
    return { status: 'ABORTED', runDate, abort: decided.abort, suspension: step.suspension };
  }

  const outcomes: StrategyOutcome[] = [];
  for (const { strategy, isShadow, intent } of decided.decided) {
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
    observations: reconciled.observations,
    outcomes,
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
      // Aucun verdict : un abandon survient avant que la couche risque ne parle.
      outcomes: [],
      executed: [],
    };
  }
  return {
    runDate: outcome.runDate,
    ending: { status: 'COMPLETED' },
    suspension: outcome.suspension,
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

// --- Le healthcheck ---------------------------------------------------------

/**
 * Toutes les alertes du run sont-elles parties.
 *
 * Extraite pour une seule raison : **`reported` et `pulseOf` posent la meme
 * question**, l'un pour le code de sortie, l'autre pour ce que la surveillance
 * lira. Deux predicats voisins auraient diverge, et c'est celui des deux qu'on
 * ne relit pas — le ping, parti chez un tiers — qui se serait tu le jour ou il
 * fallait qu'il parle.
 */
function toutesParties(alerts: readonly AlertOutcome[]): boolean {
  return alerts.every((a) => a.status === 'SENT');
}

/**
 * Le run a-t-il conclu **et** rendu compte.
 *
 * Les deux moities sont voulues, et la seconde demande un mot. Une alerte qui
 * echoue ne fait pas echouer le *travail* du run : rien n'est defait, rien n'est
 * reecrit, le statut reste `COMPLETED`. Mais elle fait echouer son *compte
 * rendu*, et ce sont deux choses differentes. Une alerte qui n'est pas partie
 * est un evenement que personne ne verra ; la compter comme un succes rendrait
 * le systeme muet exactement quand il a quelque chose a dire.
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
  return result.status === 'COMPLETED' && toutesParties(result.report.alerts);
}

/**
 * Ce que le run raconte a sa surveillance, lu sur ce qu'il a conclu. Meme role
 * qu'`alertInputOf`, et meme motif : un seul endroit fait la traduction, et
 * `healthcheck.ts` n'a pas a connaitre `DailyOutcome`.
 *
 * **Trois fins, et la troisieme est la tension du lot tranchee.** Un run conclu
 * dont une alerte n'est pas partie n'est pas `CONCLU` : le corps ne portera pas
 * le marqueur, et la surveillance le lira `DOWN`. C'est le meme predicat que le
 * code de sortie — `toutesParties` — et ce n'est pas une coincidence.
 *
 * Le motif tient en une phrase : **la panne d'une alerte est exactement la panne
 * qu'aucune alerte ne peut signaler.** Si ntfy est tombe, le canal court est
 * muet par definition ; le healthcheck est le seul canal restant qui ne depende
 * pas de lui, et se taire la reviendrait a faire dependre la surveillance du
 * systeme surveille — c'est-a-dire a perdre la raison d'etre du lot. Le travail
 * du run n'est pas defait pour autant : les quatre lignes de `decisions` et la
 * photo restent ecrites, et le statut reste `COMPLETED`. Ce que le pulse
 * rapporte n'est pas « le travail a echoue », c'est « ce run n'a pas rendu
 * compte » — d'ou un etat a lui, `NON_RENDU`, plutot qu'un abandon simule.
 *
 * Le `gitSha` vient de `run` et non de l'`outcome` : un abandon n'en porte pas,
 * et c'est justement une fin dont on veut savoir quel code l'a produite.
 */
function pulseOf(
  run: DailyRun,
  outcome: DailyOutcome,
  alerts: readonly AlertOutcome[],
): RunPulse {
  const entete = { runDate: outcome.runDate, gitSha: run.gitSha };
  if (outcome.status === 'ABORTED') {
    return {
      ...entete,
      ending: { kind: 'ABANDONNE', step: outcome.abort.step, code: outcome.abort.code },
    };
  }
  if (!toutesParties(alerts)) {
    const nonParties = alerts.filter((a) => a.status !== 'SENT').length;
    return { ...entete, ending: { kind: 'NON_RENDU', alertsFailed: nonParties } };
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
 * Le run quotidien, alertes et ping compris.
 *
 * L'enveloppe est mince et fait exactement trois choses que l'enchainement ne
 * peut pas faire lui-meme.
 *
 * 1. **Elle alerte sur un abandon.** Un run abandonne n'ecrit rien — ni
 *    decision, ni photo — donc depuis la base il est indistinguable d'un job qui
 *    n'a pas tourne. C'est arrive en reel, sur un portefeuille vide. L'alerte
 *    est la premiere difference ; le ping d'echec ci-dessous en est une seconde,
 *    et elle ne passe pas par le systeme surveille.
 * 2. **Elle alerte sur une exception, puis la releve.** `JOB_FAILED` part, et
 *    l'erreur continue son chemin telle quelle : le point d'entree doit toujours
 *    la voir et sortir en 1. Alerter n'est pas rattraper.
 * 3. **Elle pingue le healthcheck, en toute derniere position.**
 *
 * Ce qu'elle ne fait pas : changer ce que le run a conclu. Le statut, les
 * ecritures et les valeurs rendues sont ceux d'`executeRun`, alertes ou pas,
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
 * ### Pourquoi apres les alertes
 *
 * Le ping est en derniere position pour une raison de fond : il rapporte ce que
 * le run a **fait savoir**, et les alertes en font partie — voir `pulseOf`. Le
 * placer avant aurait oblige a pinguer sur un compte rendu pas encore rendu.
 */
export async function runDaily(run: DailyRun): Promise<DailyRunResult> {
  const runDate = run.clock.today();
  let outcome: DailyOutcome;
  try {
    outcome = await executeRun(run);
  } catch (error) {
    await announce(run, {
      runDate,
      ending: { status: 'FAILED', reason: texte(error) },
      suspension: { status: 'INACTIVE' },
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
  const ping = await signal(run, pulseOf(run, outcome, alerts));
  return { ...outcome, report: { alerts, ping } };
}
