/**
 * C23 : deux `decide()` sur le meme etat / horloge → jambes identiques, meme ordre.
 * Tests seuls ; `src/core/` intact.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { REBALANCE_CONFIGS } from '../../src/core/config.js';
import type { Holdings, Prices } from '../../src/core/portfolio.js';
import type { DcaDecision } from '../../src/core/strategy/dca.js';
import { DCA_DEFAULTS, decide as decideDca } from '../../src/core/strategy/dca.js';
import type { Anchors, LadderDecision } from '../../src/core/strategy/ladder.js';
import { decide as decideLadder } from '../../src/core/strategy/ladder.js';
import type { Decision } from '../../src/core/strategy/rebalance.js';
import { decide as decideRebalance } from '../../src/core/strategy/rebalance.js';
import type {
  CashFlow,
  Clock,
  IntentLeg,
  IsoDate,
  Price,
  Quantity,
  UsdcAmount,
} from '../../src/core/types.js';

const qty = (value: string): Quantity => new Decimal(value) as Quantity;
const price = (value: string): Price => new Decimal(value) as Price;
const usdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;
const clockAt = (day: IsoDate): Clock => ({ today: () => day });

const PRICES: Prices = { BTC: price('50000'), ETH: price('2500') };

/** 15k/75k = 0.20 < 0.24 : A tire. */
const OFF_BAND: Holdings = { BTC: qty('0.8'), ETH: qty('8'), USDC: qty('15000') };
const ANCHORS: Anchors = { BTC: price('60000'), ETH: price('3000') };
const DIP: Prices = { BTC: price('55000'), ETH: price('2700') };
const RICH: Holdings = { BTC: qty('1'), ETH: qty('10'), USDC: qty('50000') };
const FLOWS: readonly CashFlow[] = [{ occurredOn: '2026-01-01', amount: usdc('1000') }];

const serialise = (legs: readonly IntentLeg[]): string =>
  legs
    .map((leg) =>
      [leg.asset, leg.quote, leg.side, leg.amount.toString(), leg.limitPrice.toString()].join(' '),
    )
    .join(' | ');

function decidedRebalance(decision: Decision): Extract<Decision, { status: 'DECIDED' }> {
  if (decision.status !== 'DECIDED') {
    throw new Error(`attendu DECIDED, recu ${decision.status}`);
  }
  return decision;
}

function decidedDca(decision: DcaDecision): Extract<DcaDecision, { status: 'DECIDED' }> {
  if (decision.status !== 'DECIDED') {
    throw new Error(`attendu DECIDED, recu ${decision.status}`);
  }
  return decision;
}

function twiceEqual(left: string, right: string): void {
  expect(left).toBe(right);
  expect(left.length).toBeGreaterThan(0);
}

describe('C23 idempotence de decide()', () => {
  it('rebalance : memes jambes, meme ordre', () => {
    const state = { holdings: OFF_BAND, prices: PRICES, cashFlows: FLOWS };
    const clock = clockAt('2026-03-14');
    const params = REBALANCE_CONFIGS.rebalance;
    const a = serialise(decidedRebalance(decideRebalance(state, clock, params)).intent.legs);
    const b = serialise(decidedRebalance(decideRebalance(state, clock, params)).intent.legs);
    twiceEqual(a, b);
  });

  it('rebalance_ab : memes jambes, meme ordre', () => {
    const state = {
      holdings: { BTC: qty('1.2'), ETH: qty('4'), USDC: qty('30000') } satisfies Holdings,
      prices: PRICES,
      cashFlows: FLOWS,
      lastRatioRebalanceOn: null,
    };
    const clock = clockAt('2026-03-14');
    const params = REBALANCE_CONFIGS.rebalance_ab;
    const a = serialise(decidedRebalance(decideRebalance(state, clock, params)).intent.legs);
    const b = serialise(decidedRebalance(decideRebalance(state, clock, params)).intent.legs);
    twiceEqual(a, b);
  });

  it('ladder : memes jambes, meme ordre', () => {
    const input = {
      clock: clockAt('2026-03-14'),
      holdings: RICH,
      prices: DIP,
      anchors: ANCHORS,
    };
    const first: LadderDecision = decideLadder(input);
    const second: LadderDecision = decideLadder(input);
    twiceEqual(serialise(first.legs), serialise(second.legs));
  });

  it('dca : memes jambes, meme ordre', () => {
    const input = {
      clock: clockAt('2026-03-01'),
      holdings: OFF_BAND,
      prices: PRICES,
      config: DCA_DEFAULTS,
    };
    const a = serialise(decidedDca(decideDca(input)).intent.legs);
    const b = serialise(decidedDca(decideDca(input)).intent.legs);
    twiceEqual(a, b);
  });
});
