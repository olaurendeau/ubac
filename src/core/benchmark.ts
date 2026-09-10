import { Decimal } from 'decimal.js';

import { ASSETS, valuate } from './portfolio.js';
import type { Holdings, Prices, ValuationIssue } from './portfolio.js';
import type { CashFlow, IsoDate, Price, Quantity, UsdcAmount, Weight, Weights } from './types.js';

/**
 * Benchmarks passifs et metriques de performance. Pur, sans horloge, sans IO :
 * la serie des jours et les flux sont des parametres.
 *
 * Deux benchmarks hold construisent une `ValueSeries` ; trois metriques s'y
 * lisent — TWR, max drawdown et Sharpe glissant. Les trois passent par la meme
 * decomposition en sous-periodes bornees par les flux, ce qui les rend toutes
 * les trois insensibles au calendrier des apports.
 */

// --- Grandeurs --------------------------------------------------------------

/**
 * Rendement, en fraction de 1 : 0.05 vaut +5 %. Sans dimension, donc distinct
 * des quatre marques de `core/types.ts` — un rendement ne s'ajoute pas a un
 * poids et ne se compare pas a un montant. La marque est declaree ici et non
 * dans `types.ts`, qui est hors du perimetre de cette etape.
 */
export type Return = Decimal & { readonly __brand: 'Return' };

/**
 * Les operations de decimal.js rendent un `Decimal` nu : la marque se perd a
 * chaque calcul et doit etre reposee explicitement. Ces fonctions, plus
 * `asSharpe` plus bas, sont les seuls endroits du module ou cela arrive.
 */
const asUsdc = (value: Decimal): UsdcAmount => value as UsdcAmount;
const asQuantity = (value: Decimal): Quantity => value as Quantity;
const asReturn = (value: Decimal): Return => value as Return;

const ZERO_USDC = asUsdc(new Decimal(0));
const ZERO_QUANTITY = asQuantity(new Decimal(0));
const EMPTY_HOLDINGS: Holdings = { BTC: ZERO_QUANTITY, ETH: ZERO_QUANTITY, USDC: ZERO_QUANTITY };

/** Meme tolerance que C4 : la somme d'une allocation vaut 1 a 1e-8 pres. */
const UNIT_TOLERANCE = new Decimal('1e-8');

const asWeight = (value: string): Weight => new Decimal(value) as Weight;

// --- Les deux benchmarks hold -----------------------------------------------

/**
 * Hold BTC : tout le capital en BTC au premier jour, plus aucun arbitrage.
 * Hold 50/50 : moitie BTC, moitie ETH au premier jour, et **aucun
 * rebalancement** ensuite. Les poids derivent, c'est le principe : un hold
 * 50/50 qui se rebalancerait serait deja une strategie de reequilibrage, donc
 * un benchmark contamine par ce que le rejeu cherche justement a comparer.
 */
export const HOLD_BTC: Weights = { BTC: asWeight('1'), ETH: asWeight('0'), USDC: asWeight('0') };

export const HOLD_50_50: Weights = {
  BTC: asWeight('0.5'),
  ETH: asWeight('0.5'),
  USDC: asWeight('0'),
};

// --- Entree et sortie -------------------------------------------------------

/**
 * Un jour de marche : la date et les prix de cloture. Les bougies sont deja
 * groupees par jour par l'appelant ; ce module ne connait ni fixture, ni CSV.
 */
export interface MarketDay {
  readonly date: IsoDate;
  readonly prices: Prices;
}

/**
 * Un point de la serie de valeurs. Les deux valeurs encadrent le flux du jour :
 * `valueBeforeFlow` cloture la sous-periode qui se termine, `valueAfterFlow`
 * ouvre la suivante. C'est cette separation qui rend le TWR insensible aux
 * apports, et la garder explicite dans la donnee evite de la reconstituer de
 * memoire a chaque metrique.
 */
export interface DailyValue {
  readonly date: IsoDate;
  /** Valeur en USDC a la cloture, avant application du flux du jour. */
  readonly valueBeforeFlow: UsdcAmount;
  /** Flux net du jour. Positif pour un apport, negatif pour un retrait. */
  readonly flow: UsdcAmount;
  /** Valeur en USDC apres application du flux. Point de depart du jour suivant. */
  readonly valueAfterFlow: UsdcAmount;
}

export type ValueSeries = readonly DailyValue[];

export interface HoldInput {
  /** Jours de marche, dates strictement croissantes. */
  readonly days: readonly MarketDay[];
  /** Flux de tresorerie du rejeu. Plusieurs flux le meme jour sont sommes. */
  readonly cashFlows: readonly CashFlow[];
  /** Capital place au premier jour. Compte comme un flux, pas comme un gain. */
  readonly initialCapital: UsdcAmount;
}

/**
 * `ValuationIssue` est repris tel quel : un prix aberrant est deja diagnostique
 * par `portfolio.valuate`, le redecrire ici donnerait deux vocabulaires pour la
 * meme faute.
 */
export type SeriesIssue =
  | ValuationIssue
  | 'INVALID_ALLOCATION'
  | 'EMPTY_SERIES'
  | 'DATES_NOT_INCREASING'
  | 'INVALID_CAPITAL'
  | 'NON_FINITE_FLOW'
  | 'FLOW_OUTSIDE_SERIES'
  | 'FLOW_EXCEEDS_VALUE';

export type SeriesResult =
  | {
      readonly status: 'VALUED';
      readonly series: ValueSeries;
      /** Valeur au dernier jour, flux de ce jour inclus. */
      readonly finalValue: UsdcAmount;
    }
  | { readonly status: 'REJECTED'; readonly code: SeriesIssue; readonly reason: string };

type SeriesRejection = Extract<SeriesResult, { status: 'REJECTED' }>;

const rejectSeries = (code: SeriesIssue, reason: string): SeriesRejection => ({
  status: 'REJECTED',
  code,
  reason,
});

// --- Construction d'une serie hold ------------------------------------------

/**
 * Quantite achetee pour un montant, a un poids cible et un prix donnes.
 *
 * Le court-circuit sur un poids nul n'est pas une optimisation : hold BTC vise
 * ETH a 0, et `0 x prix / prix` rend NaN des que ce prix est nul. Le NaN ne
 * remonterait pas ici mais a la valorisation du lendemain, ou il se lit comme un
 * prix aberrant alors que la faute serait dans cette ligne.
 */
function unitsOf(amount: Decimal, weight: Weight, price: Price): Quantity {
  return weight.isZero() ? ZERO_QUANTITY : asQuantity(amount.mul(weight).div(price));
}

/** Repartit un montant selon l'allocation cible. Sert au premier financement. */
function allocate(amount: Decimal, allocation: Weights, prices: Prices): Holdings {
  return {
    BTC: unitsOf(amount, allocation.BTC, prices.BTC),
    ETH: unitsOf(amount, allocation.ETH, prices.ETH),
    /* USDC n'a pas de prix : 1 USDC vaut 1 USDC, par definition de la cotation. */
    USDC: asQuantity(amount.mul(allocation.USDC)),
  };
}

/**
 * Applique un flux au prorata des lignes deja detenues, sans regarder
 * l'allocation cible. C'est ce qui fait de ce benchmark un vrai hold : un apport
 * place a la cible ramenerait les poids vers 50/50 et introduirait un
 * reequilibrage partiel dans le benchmark. Effet mesurable de ce choix : le TWR
 * devient independant du calendrier des apports, ce qui est exactement la
 * propriete qu'un rendement pondere par le temps doit avoir.
 */
function scaleHoldings(holdings: Holdings, factor: Decimal): Holdings {
  return {
    BTC: asQuantity(holdings.BTC.mul(factor)),
    ETH: asQuantity(holdings.ETH.mul(factor)),
    USDC: asQuantity(holdings.USDC.mul(factor)),
  };
}

const isEmpty = (holdings: Holdings): boolean =>
  ASSETS.every((asset) => holdings[asset].isZero());

function checkAllocation(allocation: Weights): SeriesRejection | undefined {
  for (const asset of ASSETS) {
    const weight = allocation[asset];
    if (!weight.isFinite() || weight.lt(0)) {
      return rejectSeries(
        'INVALID_ALLOCATION',
        `poids ${asset} a ${weight.toString()} : une allocation est finie et positive`,
      );
    }
  }

  const total = ASSETS.reduce<Decimal>((acc, asset) => acc.plus(allocation[asset]), new Decimal(0));
  if (total.minus(1).abs().gt(UNIT_TOLERANCE)) {
    return rejectSeries(
      'INVALID_ALLOCATION',
      `somme des poids a ${total.toString()} : une allocation somme a 1 a 1e-8 pres`,
    );
  }

  return undefined;
}

/**
 * Somme les flux par date. Deux apports le meme jour font un flux net : les
 * separer supposerait un ordre intra-journalier que la phase 0, journaliere,
 * n'a pas.
 */
function netFlowByDate(
  cashFlows: readonly CashFlow[],
  knownDates: ReadonlySet<IsoDate>,
): ReadonlyMap<IsoDate, Decimal> | SeriesRejection {
  const byDate = new Map<IsoDate, Decimal>();

  for (const flow of cashFlows) {
    if (!flow.amount.isFinite()) {
      return rejectSeries(
        'NON_FINITE_FLOW',
        `flux du ${flow.occurredOn} a ${flow.amount.toString()} : montant non fini`,
      );
    }
    /*
     * Un flux date d'un jour absent de la serie serait ignore en silence et
     * fausserait le TWR sans qu'aucune valeur ne paraisse anormale.
     */
    if (!knownDates.has(flow.occurredOn)) {
      return rejectSeries(
        'FLOW_OUTSIDE_SERIES',
        `flux du ${flow.occurredOn} hors de la serie de jours`,
      );
    }
    byDate.set(flow.occurredOn, (byDate.get(flow.occurredOn) ?? new Decimal(0)).plus(flow.amount));
  }

  return byDate;
}

/**
 * Deroule un benchmark hold sur la serie de jours.
 *
 * Le capital initial est traite comme le flux du premier jour : la valeur avant
 * flux y vaut donc 0, et le financement n'apparait jamais comme un gain.
 */
export function holdSeries(allocation: Weights, input: HoldInput): SeriesResult {
  const badAllocation = checkAllocation(allocation);
  if (badAllocation !== undefined) return badAllocation;

  if (!input.initialCapital.isFinite() || input.initialCapital.lte(0)) {
    return rejectSeries(
      'INVALID_CAPITAL',
      `capital initial a ${input.initialCapital.toString()} USDC : attendu un montant fini et strictement positif`,
    );
  }

  if (input.days.length === 0) {
    return rejectSeries('EMPTY_SERIES', 'aucun jour de marche fourni');
  }

  /*
   * Comparaison lexicographique : sur `YYYY-MM-DD` elle equivaut a l'ordre
   * chronologique. La forme des dates est garantie en amont, par la
   * normalisation de la fixture.
   */
  let previousDate: IsoDate | undefined;
  for (const day of input.days) {
    if (previousDate !== undefined && day.date <= previousDate) {
      return rejectSeries(
        'DATES_NOT_INCREASING',
        `${day.date} ne suit pas ${previousDate} : les jours doivent etre strictement croissants`,
      );
    }
    previousDate = day.date;
  }

  const flows = netFlowByDate(input.cashFlows, new Set(input.days.map((day) => day.date)));
  if ('status' in flows) return flows;

  const series: DailyValue[] = [];
  let holdings = EMPTY_HOLDINGS;
  let finalValue = ZERO_USDC;
  let isFirstDay = true;

  for (const day of input.days) {
    /*
     * Un portefeuille vide vaut 0 sans avoir a etre valorise : `valuate` le
     * rejetterait, a juste titre, puisqu'aucun poids n'y est defini.
     */
    let valueBeforeFlow = ZERO_USDC;
    if (!isEmpty(holdings)) {
      const valuation = valuate(holdings, day.prices);
      if (valuation.status === 'REJECTED') {
        return rejectSeries(valuation.code, `${day.date} : ${valuation.reason}`);
      }
      valueBeforeFlow = valuation.total;
    }

    const dayFlow = flows.get(day.date) ?? new Decimal(0);
    const flow = asUsdc(isFirstDay ? dayFlow.plus(input.initialCapital) : dayFlow);
    const valueAfterFlow = asUsdc(valueBeforeFlow.plus(flow));

    if (!flow.isZero()) {
      if (valueAfterFlow.lt(0)) {
        return rejectSeries(
          'FLOW_EXCEEDS_VALUE',
          `${day.date} : retrait de ${flow.abs().toString()} USDC sur un portefeuille a ${valueBeforeFlow.toString()} USDC`,
        );
      }
      holdings = valueBeforeFlow.isZero()
        ? allocate(flow, allocation, day.prices)
        : scaleHoldings(holdings, valueAfterFlow.div(valueBeforeFlow));
    }

    series.push({ date: day.date, valueBeforeFlow, flow, valueAfterFlow });
    finalValue = valueAfterFlow;
    isFirstDay = false;
  }

  return { status: 'VALUED', series, finalValue };
}

// --- Decomposition en sous-periodes -----------------------------------------

/**
 * Les trois metriques de ce module — TWR, max drawdown, Sharpe glissant — se
 * lisent sur la meme decomposition de la serie en sous-periodes bornees par les
 * flux, et partagent donc ses motifs de refus.
 */
export type SubPeriodIssue = 'NO_SUB_PERIOD' | 'UNDEFINED_SUB_PERIOD' | 'NON_FINITE_VALUE';

/** Un rendement de sous-periode, et les deux clotures qui le bornent. */
interface SubPeriod {
  /** Cloture apres flux qui ouvre la sous-periode. */
  readonly from: IsoDate;
  /** Cloture avant flux qui la ferme. */
  readonly to: IsoDate;
  readonly value: Return;
}

type Decomposition =
  | {
      readonly status: 'COMPUTED';
      /** Premier jour de la serie : origine de l'indice de croissance. */
      readonly startDate: IsoDate;
      readonly periods: readonly SubPeriod[];
    }
  | { readonly status: 'REJECTED'; readonly code: SubPeriodIssue; readonly reason: string };

/**
 * Decoupe la serie en sous-periodes. Une sous-periode va de la cloture apres
 * flux d'un jour a la cloture avant flux du jour suivant :
 *
 *     r(t) = valueBeforeFlow(t) / valueAfterFlow(t-1) - 1
 *
 * **Convention d'ordre, choisie ici** : le flux d'un jour est applique *apres* la
 * valorisation de ce jour. Il ne participe donc pas au rendement du jour ou il
 * tombe. La spec ne tranche pas et l'autre convention donne d'autres chiffres :
 * sur un portefeuille a 120 000 USDC qui gagne 10 % le jour J et recoit 132 000
 * USDC ce meme jour J, cette convention rend 10 %, tandis que compter l'apport
 * dans le denominateur rendrait 264 000 / 252 000 - 1, soit 4,76 % — l'apport
 * diluerait un gain qu'il n'a pas subi.
 */
function decompose(series: ValueSeries): Decomposition {
  const first = series[0];
  if (first === undefined || series.length < 2) {
    return {
      status: 'REJECTED',
      code: 'NO_SUB_PERIOD',
      /*
       * Ni 0 ni null : une serie sans sous-periode n'a pas de rendement nul, elle
       * n'en a pas du tout. Un 0 se lirait dans le tableau de rejeu comme une
       * performance neutre reellement constatee.
       */
      reason: `serie de ${series.length} point(s) : il faut au moins deux clotures`,
    };
  }

  const periods: SubPeriod[] = [];
  let previous: DailyValue | undefined;

  for (const day of series) {
    if (!day.valueBeforeFlow.isFinite() || !day.valueAfterFlow.isFinite()) {
      return {
        status: 'REJECTED',
        code: 'NON_FINITE_VALUE',
        reason: `${day.date} : valeur non finie, aucun rendement n'en decoule`,
      };
    }

    if (previous !== undefined) {
      const start = previous.valueAfterFlow;
      if (start.lte(0)) {
        return {
          status: 'REJECTED',
          code: 'UNDEFINED_SUB_PERIOD',
          reason: `sous-periode ${previous.date} -> ${day.date} partant de ${start.toString()} USDC : rendement indefini`,
        };
      }
      periods.push({
        from: previous.date,
        to: day.date,
        value: asReturn(day.valueBeforeFlow.div(start).minus(1)),
      });
    }

    previous = day;
  }

  return { status: 'COMPUTED', startDate: first.date, periods };
}

// --- Rendement pondere par le temps -----------------------------------------

export type TwrResult =
  | { readonly status: 'COMPUTED'; readonly twr: Return }
  | { readonly status: 'REJECTED'; readonly code: SubPeriodIssue; readonly reason: string };

/**
 * Rendement pondere par le temps : produit des rendements de sous-periode,
 * moins 1. Les flux bornent les sous-periodes et n'entrent dans aucune, donc
 * leur calendrier et leur taille n'influencent pas le resultat (C27).
 */
export function timeWeightedReturn(series: ValueSeries): TwrResult {
  const decomposed = decompose(series);
  if (decomposed.status === 'REJECTED') return decomposed;

  const growth = decomposed.periods.reduce<Decimal>(
    (acc, period) => acc.mul(period.value.plus(1)),
    new Decimal(1),
  );

  return { status: 'COMPUTED', twr: asReturn(growth.minus(1)) };
}

// --- Max drawdown -----------------------------------------------------------

export type DrawdownResult =
  | {
      readonly status: 'COMPUTED';
      /**
       * Rendement du pic au creux, donc **negatif ou nul** : -0.4 se lit
       * "quarante pour cent perdus depuis le plus haut".
       */
      readonly maxDrawdown: Return;
      readonly peakDate: IsoDate;
      readonly troughDate: IsoDate;
    }
  | { readonly status: 'REJECTED'; readonly code: SubPeriodIssue; readonly reason: string };

/**
 * Plus forte baisse d'un plus haut a un plus bas ulterieur.
 *
 * Mesuree sur l'indice de croissance, pas sur la valeur en USDC. Un retrait de
 * la moitie du portefeuille creuse la valeur de 50 % sans qu'aucun prix n'ait
 * bouge : lu sur la valeur, le tableau de rejeu classerait des calendriers
 * d'apports plutot que des strategies. L'indice part de 1 au premier jour et ne
 * bouge que des rendements de sous-periode.
 *
 * Signe : negatif ou nul. Une serie qui ne baisse jamais rend 0, avec pic et
 * creux au premier jour — cela se lit "aucune baisse", pas "baisse nulle ce
 * jour-la".
 */
export function maxDrawdown(series: ValueSeries): DrawdownResult {
  const decomposed = decompose(series);
  if (decomposed.status === 'REJECTED') return decomposed;

  let index = new Decimal(1);
  let peak = new Decimal(1);
  let peakDate = decomposed.startDate;
  let worst = new Decimal(0);
  let worstPeakDate = decomposed.startDate;
  let worstTroughDate = decomposed.startDate;

  for (const period of decomposed.periods) {
    index = index.mul(period.value.plus(1));

    /* Un nouveau plus haut deplace le pic et ne peut pas etre un creux. */
    if (index.gt(peak)) {
      peak = index;
      peakDate = period.to;
      continue;
    }

    const drawdown = index.div(peak).minus(1);
    if (drawdown.lt(worst)) {
      worst = drawdown;
      worstPeakDate = peakDate;
      worstTroughDate = period.to;
    }
  }

  return {
    status: 'COMPUTED',
    maxDrawdown: asReturn(worst),
    peakDate: worstPeakDate,
    troughDate: worstTroughDate,
  };
}

// --- Sharpe glissant --------------------------------------------------------

/**
 * Ratio de Sharpe annualise. Marque distincte de `Return` : les deux sont sans
 * dimension et portes par un `Decimal`, mais un Sharpe de 1.2 n'est pas un gain
 * de 120 % et les additionner n'a aucun sens.
 */
export type Sharpe = Decimal & { readonly __brand: 'Sharpe' };

const asSharpe = (value: Decimal): Sharpe => value as Sharpe;

/** Fenetre demandee par la spec : 90 rendements journaliers. */
export const SHARPE_WINDOW = 90;

/**
 * Annualisation, convention choisie ici : 365 periodes par an. La spec ne
 * tranche pas. Le marche crypto ne ferme ni le week-end ni les jours feries et
 * la fixture porte une bougie par jour calendaire ; prendre 252, la convention
 * des actions, sous-estimerait le facteur d'annualisation de 17 %.
 */
const PERIODS_PER_YEAR = new Decimal(365);

/**
 * Taux sans risque, convention choisie ici : 0. La spec ne le mentionne pas, et
 * le rejeu compare des strategies entre elles sur la meme periode — un taux
 * commun non nul deplacerait tous les Sharpe du meme cote sans changer leur
 * ordre. Le poser a 0 evite d'inventer une courbe de taux 2024-2026.
 */
const RISK_FREE_PER_PERIOD = new Decimal(0);

export type SharpeGap = 'WINDOW_INCOMPLETE' | 'ZERO_VOLATILITY';

/**
 * Un point de la serie glissante, un par jour de la serie de valeurs — le
 * premier compris, qui n'a aucun rendement derriere lui.
 *
 * Quand le ratio n'est pas defini, il n'y a pas de nombre du tout : `status`
 * vaut `UNDEFINED` et `code` dit pourquoi. Rendre 0 tant que la fenetre n'est
 * pas pleine ferait lire une performance neutre reellement constatee sur les
 * trois premiers mois de chaque strategie.
 */
export type SharpePoint =
  | { readonly date: IsoDate; readonly status: 'DEFINED'; readonly sharpe: Sharpe }
  | { readonly date: IsoDate; readonly status: 'UNDEFINED'; readonly code: SharpeGap };

export type SharpeIssue = SubPeriodIssue | 'INVALID_WINDOW';

export type RollingSharpeResult =
  | { readonly status: 'COMPUTED'; readonly points: readonly SharpePoint[] }
  | { readonly status: 'REJECTED'; readonly code: SharpeIssue; readonly reason: string };

/**
 * Sharpe annualise d'une fenetre, ou `undefined` si sa volatilite est nulle.
 *
 * L'ecart-type est celui d'un echantillon, en n-1 : la fenetre est un
 * echantillon de rendements, pas la population complete des rendements
 * possibles. En n il serait biaise a la baisse, donc le ratio biaise a la
 * hausse — d'autant plus que la fenetre est courte.
 */
function windowSharpe(window: readonly SubPeriod[]): Decimal | undefined {
  const count = new Decimal(window.length);
  const mean = window
    .reduce<Decimal>((acc, period) => acc.plus(period.value), new Decimal(0))
    .div(count);
  const variance = window
    .reduce<Decimal>((acc, period) => acc.plus(period.value.minus(mean).pow(2)), new Decimal(0))
    .div(count.minus(1));
  const deviation = variance.sqrt();

  /* Une fenetre plate n'a pas un Sharpe infini : elle n'en a pas. */
  if (deviation.isZero()) return undefined;

  return mean.minus(RISK_FREE_PER_PERIOD).div(deviation).mul(PERIODS_PER_YEAR.sqrt());
}

/**
 * Serie glissante du ratio de Sharpe, un point par jour de la serie de valeurs.
 *
 * Le point du jour t regarde les `window` derniers rendements de sous-periode.
 * Une fenetre de 90 rendements exige 91 clotures : le premier point defini est
 * donc le 91e, et les 90 premiers sont `WINDOW_INCOMPLETE`.
 */
export function rollingSharpe(
  series: ValueSeries,
  window: number = SHARPE_WINDOW,
): RollingSharpeResult {
  if (!Number.isInteger(window) || window < 2) {
    return {
      status: 'REJECTED',
      code: 'INVALID_WINDOW',
      reason: `fenetre de ${String(window)} : il faut au moins deux rendements pour un ecart-type d'echantillon`,
    };
  }

  const decomposed = decompose(series);
  if (decomposed.status === 'REJECTED') return decomposed;

  const points: SharpePoint[] = [
    { date: decomposed.startDate, status: 'UNDEFINED', code: 'WINDOW_INCOMPLETE' },
  ];

  for (const [index, period] of decomposed.periods.entries()) {
    const available = index + 1;
    if (available < window) {
      points.push({ date: period.to, status: 'UNDEFINED', code: 'WINDOW_INCOMPLETE' });
      continue;
    }

    const sharpe = windowSharpe(decomposed.periods.slice(available - window, available));
    points.push(
      sharpe === undefined
        ? { date: period.to, status: 'UNDEFINED', code: 'ZERO_VOLATILITY' }
        : { date: period.to, status: 'DEFINED', sharpe: asSharpe(sharpe) },
    );
  }

  return { status: 'COMPUTED', points };
}
