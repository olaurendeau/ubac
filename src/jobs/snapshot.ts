import { Decimal } from 'decimal.js';

import type { SnapshotRecord, SnapshotToRecord } from '../adapters/db.js';
import type { DailyCandle } from '../adapters/market.js';
import type {
  MarketDay,
  Return,
  SeriesIssue,
  SharpeGap,
  SharpeIssue,
  SubPeriodIssue,
  ValueSeries,
} from '../core/benchmark.js';
import {
  HOLD_50_50,
  HOLD_BTC,
  holdSeries,
  maxDrawdown,
  rollingSharpe,
  SHARPE_WINDOW,
  timeWeightedReturn,
} from '../core/benchmark.js';
import type { Holdings, PricedAsset, Prices } from '../core/portfolio.js';
import type { IsoDate, UsdcAmount, Weights } from '../core/types.js';

/**
 * L'etape 7 du §8 — **benchmarks et photo du jour** — et la regle de suspension
 * au drawdown du §6. Ce module ne touche pas la base : il rend la photo a
 * ecrire, `daily.ts` l'ecrit.
 *
 * Aucune metrique n'est calculee ici. Les cinq de `src/core/benchmark.ts` — hold
 * BTC, hold 50/50, TWR, max drawdown, Sharpe glissant — sont appelees telles
 * quelles, y compris pour le rendement de sous-periode du chainage, qui passe
 * par `timeWeightedReturn` sur les deux clotures qui le bornent plutot que par
 * une division ecrite ici : la convention d'ordre des flux est celle du noyau et
 * la recopier la ferait deriver.
 *
 * Six proprietes gouvernent ce fichier.
 *
 * 1. **Le drawdown se mesure sur l'indice de croissance, pas sur la valeur en
 *    USDC**, pour le motif que `maxDrawdown` donne deja : un retrait de la
 *    moitie du portefeuille creuse la valeur de 50 % sans qu'aucun prix n'ait
 *    bouge, et le seuil du §6 suspendrait sur un virement sortant. L'indice part
 *    de 1 a la premiere photo et ne bouge que des rendements, flux exclus.
 * 2. **La fenetre est l'historique entier.** Ni 90 jours ni 200 : un drawdown
 *    qui oublie son plus haut n'est pas un drawdown. La source est donc **la
 *    serie des snapshots passes**, seul enregistrement de la valeur du
 *    portefeuille que le depot possede.
 * 3. **Cette serie est portee, pas relue.** `UbacDatabase` n'expose que
 *    `latestSnapshot()` : la tete de la serie, pas la serie. Chaque photo porte
 *    donc dans `benchmarks` les deux seuls nombres dont la suivante a besoin,
 *    l'indice et son plus-haut. C'est la serie condensee sans perte —
 *    `peak(t) = max(peak(t-1), index(t))` est un maximum courant — et le prix de
 *    ce choix est la propriete suivante.
 * 4. **Une photo par jour, et seulement si la precedente lui est anterieure.**
 *    Le maximum est idempotent, le produit ne l'est pas : rechainer l'indice sur
 *    une photo du jour deja prise compterait deux fois le rendement du jour. Un
 *    second run du meme jour ne reecrit donc rien et **relit** le drawdown que
 *    la photo porte, ce qui lui fait suspendre comme le premier. Un rejeu d'un
 *    jour anterieur a une photo existante ne reecrit rien non plus : les photos
 *    posterieures ont ete chainees sur l'ancienne valeur. Compromis assume —
 *    entre une photo legerement perimee et un indice faux, la photo.
 * 5. **Le premier run n'a pas de drawdown et ne le remplace pas par zero.** La
 *    cle `portfolio_drawdown` est **absente**, et son absence est ce qui
 *    enregistre l'indisponibilite. Un zero se lirait « tout va bien » et ce
 *    serait faux ; c'est le choix du Sharpe 90 j de la phase 0, `UNDEFINED` sur
 *    les 89 premiers jours. Consequence : un drawdown indisponible ne suspend
 *    pas — la regle dit « un drawdown de 25 % suspend », inconnu n'est pas 25 %.
 * 6. **Les courbes d'ombre `ladder` et `dca` du §4 ne sont pas ecrites.** En
 *    phase 1 aucune strategie ne place d'ordre : les trois portefeuilles simules
 *    seraient le portefeuille reel au centime pres, et trois courbes identiques
 *    feraient lire une comparaison la ou il n'y en a aucune. Les cles sont
 *    absentes, pas nulles ; le rejeu historique reste l'endroit ou ces deux
 *    strategies se comparent.
 */

// --- Les cles de `snapshots.benchmarks` -------------------------------------

/** Le suffixe suit la fenetre du noyau : la changer ne peut pas oublier la cle. */
const SHARPE_SUFFIX = `sharpe_${String(SHARPE_WINDOW)}d`;

/**
 * Les trois cles d'un hold, derivees d'un seul prefixe. Les ecrire deux fois —
 * ici pour le lecteur, dans le calcul pour la valeur — les ferait deriver.
 */
export interface HoldKeys {
  readonly label: string;
  readonly twr: string;
  readonly maxDrawdown: string;
  readonly sharpe: string;
}

const holdKeys = (label: string): HoldKeys => ({
  label,
  twr: `${label}_twr`,
  maxDrawdown: `${label}_max_drawdown`,
  sharpe: `${label}_${SHARPE_SUFFIX}`,
});

export const HOLD_BTC_KEYS = holdKeys('hold_btc');
export const HOLD_5050_KEYS = holdKeys('hold_5050');

export const PORTFOLIO_KEYS = {
  /** Indice de croissance du portefeuille, 1 a la premiere photo. */
  index: 'portfolio_twr_index',
  /** Plus-haut de cet indice : maximum courant, jamais reinitialise. */
  peak: 'portfolio_twr_peak',
  /** Recul depuis ce plus-haut, negatif ou nul. **Absent** quand il n'existe pas. */
  drawdown: 'portfolio_drawdown',
} as const;

/**
 * Une metrique que le noyau n'a pas pu rendre. Sa cle manque dans `benchmarks`
 * et le motif remonte ici : une absence sans motif serait indistinguable d'un
 * oubli, et le lot des alertes n'aurait rien a dire.
 */
export interface BenchmarkGap {
  readonly key: string;
  readonly code: SeriesIssue | SharpeIssue | SharpeGap | DrawdownGap | 'HISTORY_MISALIGNED';
  readonly reason: string;
}

// --- Les deux benchmarks hold -----------------------------------------------

/**
 * Capital de reference des deux hold : **1 USDC, et aucun flux**. Le TWR est
 * invariant d'echelle sur une serie sans flux, donc ce 1 ne choisit rien. Le
 * capital reel demanderait la valeur du portefeuille au premier jour de la
 * fenetre, que le depot n'a pas, et le melanger a des flux reels donnerait une
 * courbe qui n'est le hold de personne.
 */
const HOLD_CAPITAL = new Decimal(1) as UsdcAmount;

/**
 * Les jours de la fenetre, apparies par indice. Deux series de longueurs ou de
 * dates differentes ne se recollent pas : apparier au plus court ferait taire un
 * trou d'un cote. L'adapter refuse deja une serie trouee ; ce garde tient le
 * port, pas l'adapter.
 */
function marketDays(
  history: Readonly<Record<PricedAsset, readonly DailyCandle[]>>,
): { readonly days: readonly MarketDay[] } | { readonly gap: BenchmarkGap } {
  const { BTC, ETH } = history;
  const desaccord = (reason: string) => ({
    gap: { key: 'hold_*', code: 'HISTORY_MISALIGNED', reason } as const,
  });
  if (BTC.length !== ETH.length) {
    return desaccord(`${String(BTC.length)} jours cote BTC contre ${String(ETH.length)} cote ETH`);
  }
  const days: MarketDay[] = [];
  for (const [index, btc] of BTC.entries()) {
    /*
     * `eth === undefined` est **inatteignable** : le controle de longueur
     * ci-dessus l'a deja exclu. Il reste parce que l'indexation d'un tableau
     * rend `T | undefined` et qu'une assertion non nulle mentirait sur ce que
     * le type sait. Declare, pas masque.
     */
    const eth = ETH[index];
    if (eth === undefined || eth.date !== btc.date) {
      return desaccord(`jour ${String(index)} : ${btc.date} cote BTC, ${eth?.date ?? 'rien'} cote ETH`);
    }
    const prices: Prices = { BTC: btc.close, ETH: eth.close };
    days.push({ date: btc.date, prices });
  }
  return { days };
}

/** TWR, max drawdown et dernier Sharpe glissant d'un hold, dans `values` et `gaps`. */
function holdMetrics(
  keys: HoldKeys,
  allocation: Weights,
  days: readonly MarketDay[],
  values: Record<string, Decimal>,
  gaps: BenchmarkGap[],
): void {
  const serie = holdSeries(allocation, { days, cashFlows: [], initialCapital: HOLD_CAPITAL });
  if (serie.status === 'REJECTED') {
    gaps.push({ key: `${keys.label}_*`, code: serie.code, reason: serie.reason });
    return;
  }

  const twr = timeWeightedReturn(serie.series);
  if (twr.status === 'COMPUTED') values[keys.twr] = twr.twr;
  else gaps.push({ key: keys.twr, code: twr.code, reason: twr.reason });

  const recul = maxDrawdown(serie.series);
  if (recul.status === 'COMPUTED') values[keys.maxDrawdown] = recul.maxDrawdown;
  else gaps.push({ key: keys.maxDrawdown, code: recul.code, reason: recul.reason });

  const sharpe = rollingSharpe(serie.series);
  if (sharpe.status === 'REJECTED') {
    gaps.push({ key: keys.sharpe, code: sharpe.code, reason: sharpe.reason });
    return;
  }
  /* Le point du jour, pas la serie : une colonne de photo porte une valeur. */
  const dernier = sharpe.points[sharpe.points.length - 1];
  if (dernier?.status === 'DEFINED') values[keys.sharpe] = dernier.sharpe;
  else {
    gaps.push({
      key: keys.sharpe,
      /* Meme motif : `rollingSharpe` rend au moins un point des qu'il ne refuse pas. */
      code: dernier?.code ?? 'NO_SUB_PERIOD',
      reason: `Sharpe du dernier jour indisponible : la fenetre de ${String(SHARPE_WINDOW)} rendements n'est pas pleine, ou sa volatilite est nulle`,
    });
  }
}

// --- Le drawdown du portefeuille --------------------------------------------

const ONE = new Decimal(1);
const ZERO_USDC = new Decimal(0) as UsdcAmount;

/** L'indice de croissance et son plus-haut, tels qu'une photo les porte. */
export interface CarriedIndex {
  readonly index: Decimal;
  readonly peak: Decimal;
}

/** Origine de la chaine : le premier jour vaut 1 et est son propre sommet. */
const INCEPTION: CarriedIndex = { index: ONE, peak: ONE };

export type DrawdownGap =
  | 'NO_PREVIOUS_SNAPSHOT'
  | 'SNAPSHOT_NOT_ANTERIOR'
  | 'MALFORMED_CARRIED_INDEX'
  | 'FLOW_EXCEEDS_VALUE'
  | SubPeriodIssue;

export type DrawdownState =
  | {
      readonly status: 'COMPUTED';
      /** Negatif ou nul : -0.27 se lit « 27 % perdus depuis le plus haut ». */
      readonly drawdown: Return;
      readonly carried: CarriedIndex;
    }
  | { readonly status: 'UNAVAILABLE'; readonly code: DrawdownGap; readonly reason: string };

/** Un flux tel que la base le rend, reduit a ce que le chainage regarde. */
export interface FlowInstant {
  readonly occurredAt: Date;
  readonly amount: UsdcAmount;
}

const asReturn = (value: Decimal): Return => value as Return;

/**
 * Flux nets tombes **apres** la photo precedente et **au plus tard** a l'instant
 * du run. Les deux bornes comptent : l'ouverte exclut ce que la valeur de la
 * photo precedente contenait deja, la fermee un flux post-date qui n'a pas
 * encore touche les soldes lus. Des instants, pas des jours : comparer des jours
 * ferait passer un apport de 18 h pour anterieur a la photo de 7 h du meme jour.
 */
function netFlow(flows: readonly FlowInstant[], after: Date, until: Date): UsdcAmount {
  return flows
    .filter((flux) => flux.occurredAt > after && flux.occurredAt <= until)
    .reduce<Decimal>((acc, flux) => acc.plus(flux.amount), new Decimal(0)) as UsdcAmount;
}

/** L'indice porte par une photo. Une photo sans indice lisible n'en fournit pas. */
function carriedFrom(snapshot: SnapshotRecord): CarriedIndex | undefined {
  const index = snapshot.benchmarks[PORTFOLIO_KEYS.index];
  const peak = snapshot.benchmarks[PORTFOLIO_KEYS.peak];
  if (index === undefined || peak === undefined) return undefined;
  if (!index.isFinite() || !peak.isFinite() || index.lte(0) || peak.lte(0)) return undefined;
  return { index, peak };
}

interface ChainInput {
  readonly runDate: IsoDate;
  readonly runInstant: Date;
  readonly totalValue: UsdcAmount;
  readonly previous: SnapshotRecord;
  readonly flows: readonly FlowInstant[];
}

/** Prolonge la chaine d'un jour, a partir d'une photo strictement anterieure. */
function chain(input: ChainInput): DrawdownState {
  const { previous } = input;
  const porte = carriedFrom(previous);
  if (porte === undefined) {
    return {
      status: 'UNAVAILABLE',
      code: 'MALFORMED_CARRIED_INDEX',
      reason: `photo du ${previous.runDate} sans indice de croissance lisible : repartir de 1 effacerait le sommet historique, donc le drawdown n'est pas rendu.`,
    };
  }

  const net = netFlow(input.flows, previous.createdAt, input.runInstant);
  const valueBeforeFlow = input.totalValue.minus(net) as UsdcAmount;
  if (valueBeforeFlow.lte(0)) {
    return {
      status: 'UNAVAILABLE',
      code: 'FLOW_EXCEEDS_VALUE',
      reason: `valeur du jour a ${input.totalValue.toString()} USDC pour ${net.toString()} USDC de flux depuis la photo du ${previous.runDate} : la sous-periode se fermerait sur un portefeuille negatif ou nul.`,
    };
  }

  const serie: ValueSeries = [
    {
      date: previous.runDate,
      valueBeforeFlow: previous.totalValueUsdc,
      flow: ZERO_USDC,
      valueAfterFlow: previous.totalValueUsdc,
    },
    { date: input.runDate, valueBeforeFlow, flow: net, valueAfterFlow: input.totalValue },
  ];

  const periode = timeWeightedReturn(serie);
  if (periode.status === 'REJECTED') {
    return { status: 'UNAVAILABLE', code: periode.code, reason: periode.reason };
  }

  const index = porte.index.mul(periode.twr.plus(1));
  const carried: CarriedIndex = { index, peak: Decimal.max(porte.peak, index) };
  return { status: 'COMPUTED', drawdown: asReturn(index.div(carried.peak).minus(1)), carried };
}

/**
 * La photo du jour existe deja, ou une plus recente existe : la chaine ne se
 * reprend pas par le milieu. Dans le premier cas on relit ce que la photo du
 * jour porte — c'est ce qui fait que deux runs du meme jour suspendent
 * pareil —, dans le second on declare l'indisponibilite.
 */
function storedState(previous: SnapshotRecord, runDate: IsoDate): DrawdownState {
  if (previous.runDate > runDate) {
    return {
      status: 'UNAVAILABLE',
      code: 'SNAPSHOT_NOT_ANTERIOR',
      reason: `la photo la plus recente est du ${previous.runDate}, posterieure au run du ${runDate} : le rejeu d'un jour ancien ne relit pas la chaine par le milieu.`,
    };
  }

  const stocke = previous.benchmarks[PORTFOLIO_KEYS.drawdown];
  const carried = carriedFrom(previous);
  if (stocke === undefined || carried === undefined) {
    return {
      status: 'UNAVAILABLE',
      /* L'absence de la cle EST l'enregistrement de l'indisponibilite. */
      code: 'NO_PREVIOUS_SNAPSHOT',
      reason: `la photo du ${runDate} porte deja l'absence de drawdown : le run qui l'a posee n'avait pas de photo anterieure.`,
    };
  }
  return { status: 'COMPUTED', drawdown: asReturn(stocke), carried };
}

// --- La suspension du §6 -----------------------------------------------------

/**
 * Seuil du §6 : « un drawdown de 25 % declenche une alerte et une suspension des
 * reequilibrages ». Borne **incluse** — la spec dit « de 25 % », pas « de plus de
 * 25 % ». C'est l'inverse du seuil de reconciliation, ou 1 % pile passe ; les
 * deux cotes de celui-ci sont sondes.
 */
export const DRAWDOWN_SUSPENSION_THRESHOLD = new Decimal('-0.25');

/**
 * Marqueur en tete de `decisions.reason` d'une ligne suspendue. Sans lui, un
 * jour suspendu serait indistinguable d'un jour ou rien n'a declenche : les deux
 * portent `trigger NONE` et zero jambe.
 */
export const SUSPENSION_MARKER = 'SUSPENSION_DRAWDOWN';

export type Suspension =
  | { readonly status: 'ACTIVE'; readonly drawdown: Return; readonly reason: string }
  | { readonly status: 'INACTIVE' };

const pct = (value: Decimal): string => `${value.times(100).toFixed(2)} %`;

/**
 * La suspension porte sur la **seule strategie de production** ; les trois
 * strategies d'ombre continuent d'etre journalisees. Les ombres ne passent aucun
 * ordre : les suspendre ne protegerait rien et couperait la comparaison
 * exactement au moment ou elle est la plus interessante — un marche a -25 % est
 * precisement ou l'on veut savoir ce que le ladder et le DCA auraient fait. La
 * suspension protege le capital, et le capital n'est expose que par la
 * production. Consequence assumee : `rebalance_ab` tourne pendant qu'une
 * suspension bloque `rebalance`, et c'est ce que l'ombre existe pour dire.
 */
function suspensionOf(drawdown: DrawdownState): Suspension {
  if (drawdown.status !== 'COMPUTED') return { status: 'INACTIVE' };
  if (drawdown.drawdown.gt(DRAWDOWN_SUSPENSION_THRESHOLD)) return { status: 'INACTIVE' };
  return {
    status: 'ACTIVE',
    drawdown: drawdown.drawdown,
    reason:
      `${SUSPENSION_MARKER} : drawdown a ${pct(drawdown.drawdown)} depuis le plus haut, au seuil de ` +
      `${pct(DRAWDOWN_SUSPENSION_THRESHOLD)} ou au-dela (§6). Les reequilibrages de la strategie de ` +
      `production sont suspendus ; les strategies d'ombre restent journalisees. Aucune vente : la ` +
      `decision de sortir reste humaine.`,
  };
}

// --- L'etape 7 ---------------------------------------------------------------

export type SnapshotWrite =
  | { readonly status: 'TO_RECORD'; readonly record: SnapshotToRecord }
  | {
      readonly status: 'SKIPPED';
      readonly code: 'ALREADY_SNAPSHOTTED' | 'NO_CARRIED_INDEX';
      readonly reason: string;
    };

export interface SnapshotStepInput {
  readonly runDate: IsoDate;
  /** Horodatage injecte : `snapshots.created_at`, et borne haute des flux. */
  readonly runInstant: Date;
  readonly holdings: Holdings;
  readonly weights: Weights;
  readonly totalValue: UsdcAmount;
  /** La fenetre OHLCV du §8, rendue telle quelle par le run. */
  readonly history: Readonly<Record<PricedAsset, readonly DailyCandle[]>>;
  /** La tete de la serie de photos, ou rien au premier run. */
  readonly previous: SnapshotRecord | undefined;
  /** Flux depuis `previous.createdAt` ; vide quand il n'y a pas de photo. */
  readonly flows: readonly FlowInstant[];
}

export interface SnapshotStep {
  readonly drawdown: DrawdownState;
  readonly suspension: Suspension;
  readonly benchmarks: Readonly<Record<string, Decimal>>;
  readonly gaps: readonly BenchmarkGap[];
  readonly write: SnapshotWrite;
}

/**
 * L'etape 7 en entier : benchmarks, drawdown, suspension, et la photo a ecrire.
 *
 * Tout est **calcule** avant l'etape 5, alors que la spec place l'etape 7 apres,
 * parce que la suspension est une entree de la decision et ne peut pas
 * l'attendre. Seule l'**ecriture** reste a l'etape 7 : un run abandonne rend
 * avant d'y arriver et ne laisse donc aucune photo.
 */
export function prepareSnapshot(input: SnapshotStepInput): SnapshotStep {
  const { previous, runDate } = input;

  const drawdown: DrawdownState =
    previous === undefined
      ? {
          status: 'UNAVAILABLE',
          code: 'NO_PREVIOUS_SNAPSHOT',
          reason: `aucune photo anterieure au ${runDate} : il n'y a pas de sommet dont reculer, et ce n'est pas un drawdown nul.`,
        }
      : previous.runDate < runDate
        ? chain({ ...input, previous })
        : storedState(previous, runDate);

  /*
   * Le premier run n'a pas de drawdown mais a un indice : il ouvre la chaine a 1.
   * Les autres indisponibilites n'en ont pas — elles disent precisement qu'aucun
   * indice ne se calcule —, et c'est ce qui interdit d'ecrire la photo.
   */
  const carried =
    drawdown.status === 'COMPUTED'
      ? drawdown.carried
      : drawdown.code === 'NO_PREVIOUS_SNAPSHOT' && previous === undefined
        ? INCEPTION
        : undefined;

  const values: Record<string, Decimal> = {};
  const gaps: BenchmarkGap[] = [];
  const jours = marketDays(input.history);
  if ('gap' in jours) gaps.push(jours.gap);
  else {
    holdMetrics(HOLD_BTC_KEYS, HOLD_BTC, jours.days, values, gaps);
    holdMetrics(HOLD_5050_KEYS, HOLD_50_50, jours.days, values, gaps);
  }

  if (carried !== undefined) {
    values[PORTFOLIO_KEYS.index] = carried.index;
    values[PORTFOLIO_KEYS.peak] = carried.peak;
  }
  if (drawdown.status === 'COMPUTED') {
    values[PORTFOLIO_KEYS.drawdown] = drawdown.drawdown;
  } else {
    gaps.push({
      key: PORTFOLIO_KEYS.drawdown,
      code: drawdown.code,
      reason: drawdown.reason,
    });
  }

  return {
    drawdown,
    suspension: suspensionOf(drawdown),
    benchmarks: values,
    gaps,
    write: writeOf(input, values, carried),
  };
}

function writeOf(
  input: SnapshotStepInput,
  benchmarks: Readonly<Record<string, Decimal>>,
  carried: CarriedIndex | undefined,
): SnapshotWrite {
  const { previous, runDate } = input;
  if (previous !== undefined && previous.runDate === runDate) {
    return {
      status: 'SKIPPED',
      code: 'ALREADY_SNAPSHOTTED',
      reason: `photo du ${runDate} deja prise : la reecrire rechainerait l'indice sur lui-meme et compterait deux fois le rendement du jour.`,
    };
  }
  if (carried === undefined) {
    return {
      status: 'SKIPPED',
      code: 'NO_CARRIED_INDEX',
      reason: `aucun indice de croissance a porter pour le ${runDate} : la photo n'est pas ecrite plutot que de rompre la chaine.`,
    };
  }
  return {
    status: 'TO_RECORD',
    record: {
      runDate,
      totalValueUsdc: input.totalValue,
      weights: input.weights,
      positions: input.holdings,
      benchmarks,
      createdAt: input.runInstant,
    },
  };
}
