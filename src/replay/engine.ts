/**
 * Moteur de rejeu historique. Hors de `core/` : serie de jours et flux en
 * memoire seulement. Horloge = date de la ligne courante. Pas de `Date.now()`,
 * `new Date()` sans argument, ni `Math.random()`.
 *
 * Six series (C29 partiel). Aucune comparaison de performance (C31).
 */
import { Decimal } from 'decimal.js';

import type { DailyValue, MarketDay, Return, Sharpe, ValueSeries } from '../core/benchmark.js';
import {
  HOLD_50_50,
  HOLD_BTC,
  holdSeries,
  maxDrawdown,
  rollingSharpe,
  SHARPE_WINDOW,
  timeWeightedReturn,
} from '../core/benchmark.js';
import { REBALANCE_CONFIGS } from '../core/config.js';
import { clientOrderId } from '../core/order-id.js';
import type { Holdings, Prices } from '../core/portfolio.js';
import { valuate } from '../core/portfolio.js';
import type { RebalanceExecution } from '../core/risk.js';
import { armsCooldown, validate } from '../core/risk.js';
import { DCA_DEFAULTS, decide as decideDca } from '../core/strategy/dca.js';
import type { Anchors } from '../core/strategy/ladder.js';
import { NO_ANCHORS, decide as decideLadder } from '../core/strategy/ladder.js';
import type { RebalanceParams } from '../core/strategy/rebalance.js';
import { decide as decideRebalance } from '../core/strategy/rebalance.js';
import type {
  CashFlow,
  Clock,
  IntentLeg,
  IsoDate,
  Order,
  Quantity,
  StrategyName,
  UsdcAmount,
  Weights,
} from '../core/types.js';

export const SERIES_NAMES = [
  'rebalance',
  'rebalance_ab',
  'ladder',
  'dca',
  'hold_btc',
  'hold_50_50',
] as const;

export type SeriesName = (typeof SERIES_NAMES)[number];

export interface SeriesMetrics {
  readonly name: SeriesName;
  readonly finalValue: UsdcAmount;
  readonly twr: Return;
  readonly sharpe90: Sharpe;
  readonly maxDrawdown: Return;
  readonly triggerCount: number;
}

export interface ReplayResult {
  readonly series: readonly SeriesMetrics[];
}

export interface ReplayInput {
  readonly days: readonly MarketDay[];
  /** Flux hors capital initial (`initialCapital`). */
  readonly cashFlows: readonly CashFlow[];
  readonly initialCapital: UsdcAmount;
}

const ZERO_QTY = new Decimal(0) as Quantity;
const EMPTY: Holdings = { BTC: ZERO_QTY, ETH: ZERO_QTY, USDC: ZERO_QTY };
const ZERO_USDC = new Decimal(0) as UsdcAmount;

const asQty = (value: Decimal): Quantity => value as Quantity;
const asUsdc = (value: Decimal): UsdcAmount => value as UsdcAmount;
const clockAt = (day: IsoDate): Clock => ({ today: () => day });

function netFlowByDate(
  cashFlows: readonly CashFlow[],
  knownDates: ReadonlySet<IsoDate>,
): ReadonlyMap<IsoDate, Decimal> {
  const byDate = new Map<IsoDate, Decimal>();
  for (const flow of cashFlows) {
    if (!flow.amount.isFinite()) {
      throw new RangeError(`flux du ${flow.occurredOn} non fini`);
    }
    if (!knownDates.has(flow.occurredOn)) {
      throw new RangeError(`flux du ${flow.occurredOn} hors serie`);
    }
    byDate.set(flow.occurredOn, (byDate.get(flow.occurredOn) ?? new Decimal(0)).plus(flow.amount));
  }
  return byDate;
}

function applyLegs(holdings: Holdings, legs: readonly IntentLeg[]): Holdings {
  let btc: Decimal = holdings.BTC;
  let eth: Decimal = holdings.ETH;
  let cash: Decimal = holdings.USDC;
  for (const leg of legs) {
    if (leg.asset !== 'BTC' && leg.asset !== 'ETH') {
      throw new RangeError(`jambe sur ${leg.asset} non rejouable`);
    }
    const qty = leg.amount.div(leg.limitPrice);
    if (leg.side === 'BUY') {
      cash = cash.minus(leg.amount);
      if (leg.asset === 'BTC') btc = btc.plus(qty);
      else eth = eth.plus(qty);
    } else {
      cash = cash.plus(leg.amount);
      if (leg.asset === 'BTC') btc = btc.minus(qty);
      else eth = eth.minus(qty);
    }
  }
  return { BTC: asQty(btc), ETH: asQty(eth), USDC: asQty(cash) };
}

function applyOrders(holdings: Holdings, orders: readonly Order[]): Holdings {
  let btc: Decimal = holdings.BTC;
  let eth: Decimal = holdings.ETH;
  let cash: Decimal = holdings.USDC;
  for (const order of orders) {
    const notional = order.quantity.mul(order.limitPrice);
    if (order.side === 'BUY') {
      cash = cash.minus(notional);
      if (order.asset === 'BTC') btc = btc.plus(order.quantity);
      else eth = eth.plus(order.quantity);
    } else {
      cash = cash.plus(notional);
      if (order.asset === 'BTC') btc = btc.minus(order.quantity);
      else eth = eth.minus(order.quantity);
    }
  }
  return { BTC: asQty(btc), ETH: asQty(eth), USDC: asQty(cash) };
}

function allocate(amount: Decimal, weights: Weights, prices: Prices): Holdings {
  return {
    BTC: weights.BTC.isZero() ? ZERO_QTY : asQty(amount.mul(weights.BTC).div(prices.BTC)),
    ETH: weights.ETH.isZero() ? ZERO_QTY : asQty(amount.mul(weights.ETH).div(prices.ETH)),
    USDC: asQty(amount.mul(weights.USDC)),
  };
}

function valueOf(holdings: Holdings, prices: Prices): UsdcAmount {
  if (holdings.BTC.isZero() && holdings.ETH.isZero() && holdings.USDC.isZero()) {
    return ZERO_USDC;
  }
  const valuation = valuate(holdings, prices);
  if (valuation.status !== 'VALUED') {
    throw new RangeError(`non valorisable : ${valuation.code}`);
  }
  return valuation.total;
}

function creditCash(holdings: Holdings, flow: Decimal): Holdings {
  return {
    BTC: asQty(holdings.BTC),
    ETH: asQty(holdings.ETH),
    USDC: asQty(holdings.USDC.plus(flow)),
  };
}

function metricsOf(
  name: SeriesName,
  series: ValueSeries,
  finalValue: UsdcAmount,
  triggerCount: number,
): SeriesMetrics {
  const twr = timeWeightedReturn(series);
  if (twr.status !== 'COMPUTED') throw new RangeError(`${name} : TWR ${twr.code}`);
  const drawdown = maxDrawdown(series);
  if (drawdown.status !== 'COMPUTED') throw new RangeError(`${name} : DD ${drawdown.code}`);
  const sharpe = rollingSharpe(series, SHARPE_WINDOW);
  if (sharpe.status !== 'COMPUTED') throw new RangeError(`${name} : Sharpe ${sharpe.code}`);

  for (let i = sharpe.points.length - 1; i >= 0; i -= 1) {
    const point = sharpe.points[i];
    if (point?.status === 'DEFINED') {
      return {
        name,
        finalValue,
        twr: twr.twr,
        sharpe90: point.sharpe,
        maxDrawdown: drawdown.maxDrawdown,
        triggerCount,
      };
    }
  }
  throw new RangeError(`${name} : aucun Sharpe 90 j`);
}

function holdMetrics(name: SeriesName, allocation: Weights, input: ReplayInput): SeriesMetrics {
  const result = holdSeries(allocation, {
    days: input.days,
    cashFlows: input.cashFlows,
    initialCapital: input.initialCapital,
  });
  if (result.status !== 'VALUED') throw new RangeError(`${name} : ${result.code}`);
  return metricsOf(name, result.series, result.finalValue, 0);
}

interface StrategyRun {
  readonly series: ValueSeries;
  readonly finalValue: UsdcAmount;
  readonly triggerCount: number;
}

/**
 * Ouverture a la cible pour rebalance* : sans cela, 100 % cash fait rejeter le
 * premier run par REBALANCE_TOO_LARGE. Ce placement n'est pas un declenchement.
 */
function runRebalance(name: StrategyName, params: RebalanceParams, input: ReplayInput): StrategyRun {
  const known = new Set(input.days.map((d) => d.date));
  const flows = netFlowByDate(input.cashFlows, known);
  const first = input.days[0]?.date;
  const freezeFlows: readonly CashFlow[] =
    first === undefined
      ? input.cashFlows
      : [{ occurredOn: first, amount: input.initialCapital, note: 'capital initial' }, ...input.cashFlows];

  const points: DailyValue[] = [];
  let holdings = EMPTY;
  let lastComplete: IsoDate | null = null;
  let lastRatio: IsoDate | null = null;
  let triggers = 0;
  let finalValue = ZERO_USDC;
  let firstDay = true;

  for (const day of input.days) {
    const valueBeforeFlow = valueOf(holdings, day.prices);
    const dayFlow = flows.get(day.date) ?? new Decimal(0);
    const flow = asUsdc(firstDay ? dayFlow.plus(input.initialCapital) : dayFlow);
    const valueAfterFlow = asUsdc(valueBeforeFlow.plus(flow));
    if (valueAfterFlow.lt(0)) throw new RangeError(`${day.date} : retrait excessif`);

    if (!flow.isZero()) {
      holdings = valueBeforeFlow.isZero()
        ? allocate(flow, params.targets, day.prices)
        : creditCash(holdings, flow);
    }

    const decision = decideRebalance(
      {
        holdings,
        prices: day.prices,
        cashFlows: freezeFlows.filter((f) => f.occurredOn <= day.date),
        lastRatioRebalanceOn: lastRatio,
      },
      clockAt(day.date),
      params,
    );

    if (decision.status === 'DECIDED' && decision.intent.trigger !== 'NONE') {
      triggers += 1;
      const verdict = validate(decision.intent, {
        makeClientOrderId: clientOrderId,
        mids: day.prices,
        lastCompleteRebalanceOn: lastComplete,
        balances: [],
        holdings,
        prices: day.prices,
      });
      if (verdict.status === 'ACCEPTED' && verdict.orders.length > 0) {
        holdings = applyOrders(holdings, verdict.orders);
        const exec: RebalanceExecution = {
          runDate: day.date,
          ordersPlaced: verdict.orders.length,
          ordersFilled: verdict.orders.length,
        };
        if (armsCooldown(exec)) lastComplete = day.date;
        if (decision.intent.trigger === 'RATIO_BAND') lastRatio = day.date;
      }
    }

    points.push({ date: day.date, valueBeforeFlow, flow, valueAfterFlow });
    finalValue = valueOf(holdings, day.prices);
    firstDay = false;
  }

  return { series: points, finalValue, triggerCount: triggers };
}

function runCashStrategy(
  input: ReplayInput,
  step: (day: MarketDay, holdings: Holdings) => { holdings: Holdings; triggered: boolean },
): StrategyRun {
  const known = new Set(input.days.map((d) => d.date));
  const flows = netFlowByDate(input.cashFlows, known);
  const points: DailyValue[] = [];
  let holdings = EMPTY;
  let triggers = 0;
  let finalValue = ZERO_USDC;
  let firstDay = true;

  for (const day of input.days) {
    const valueBeforeFlow = valueOf(holdings, day.prices);
    const dayFlow = flows.get(day.date) ?? new Decimal(0);
    const flow = asUsdc(firstDay ? dayFlow.plus(input.initialCapital) : dayFlow);
    const valueAfterFlow = asUsdc(valueBeforeFlow.plus(flow));
    if (valueAfterFlow.lt(0)) throw new RangeError(`${day.date} : retrait excessif`);
    if (!flow.isZero()) holdings = creditCash(holdings, flow);

    const outcome = step(day, holdings);
    holdings = outcome.holdings;
    if (outcome.triggered) triggers += 1;

    points.push({ date: day.date, valueBeforeFlow, flow, valueAfterFlow });
    finalValue = valueOf(holdings, day.prices);
    firstDay = false;
  }

  return { series: points, finalValue, triggerCount: triggers };
}

function runLadder(input: ReplayInput): StrategyRun {
  let anchors: Anchors = NO_ANCHORS;
  return runCashStrategy(input, (day, holdings) => {
    const decision = decideLadder({
      clock: clockAt(day.date),
      holdings,
      prices: day.prices,
      anchors,
    });
    anchors = decision.anchors;
    if (decision.trigger === 'NONE') return { holdings, triggered: false };
    return { holdings: applyLegs(holdings, decision.legs), triggered: true };
  });
}

function runDca(input: ReplayInput): StrategyRun {
  return runCashStrategy(input, (day, holdings) => {
    const decision = decideDca({
      clock: clockAt(day.date),
      holdings,
      prices: day.prices,
      config: DCA_DEFAULTS,
    });
    if (decision.status !== 'DECIDED' || decision.intent.legs.length === 0) {
      return { holdings, triggered: false };
    }
    return { holdings: applyLegs(holdings, decision.intent.legs), triggered: true };
  });
}

/** Deroule les six series. Deterministe sur l'entree fournie. */
export function replay(input: ReplayInput): ReplayResult {
  if (input.days.length === 0) throw new RangeError('aucun jour de marche');
  if (!input.initialCapital.isFinite() || input.initialCapital.lte(0)) {
    throw new RangeError(`capital initial invalide : ${input.initialCapital.toString()}`);
  }

  const rebalance = runRebalance('rebalance', REBALANCE_CONFIGS.rebalance, input);
  const rebalanceAb = runRebalance('rebalance_ab', REBALANCE_CONFIGS.rebalance_ab, input);
  const ladder = runLadder(input);
  const dca = runDca(input);

  return {
    series: [
      metricsOf('rebalance', rebalance.series, rebalance.finalValue, rebalance.triggerCount),
      metricsOf('rebalance_ab', rebalanceAb.series, rebalanceAb.finalValue, rebalanceAb.triggerCount),
      metricsOf('ladder', ladder.series, ladder.finalValue, ladder.triggerCount),
      metricsOf('dca', dca.series, dca.finalValue, dca.triggerCount),
      holdMetrics('hold_btc', HOLD_BTC, input),
      holdMetrics('hold_50_50', HOLD_50_50, input),
    ],
  };
}
