import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import {
  MAX_EXPOSURE_PCT,
  MIN_CASH_PCT,
  REBALANCE_TOO_LARGE_PCT,
  validate,
} from '../../src/core/risk.js';
import type { RiskContext } from '../../src/core/risk.js';
import type {
  Intent,
  IntentLeg,
  Price,
  Quantity,
  Rejection,
  RejectionCode,
  Side,
  UsdcAmount,
  Weight,
  Weights,
} from '../../src/core/types.js';
const usdc = (v: string): UsdcAmount => new Decimal(v) as UsdcAmount;
const qty = (v: string): Quantity => new Decimal(v) as Quantity;
const price = (v: string): Price => new Decimal(v) as Price;
const weight = (v: string): Weight => new Decimal(v) as Weight;
const BTC = price('60000');
const ETH = price('3000');
const PRICES: Prices = { BTC, ETH };
const WEIGHTS: Weights = { BTC: weight('0.4'), ETH: weight('0.3'), USDC: weight('0.3') };
/** Portefeuille a 100 000 USDC : BTC 40 / ETH 30 / USDC 30. */
function holdingsAt(usdcShare: string): Holdings {
  const cash = new Decimal(usdcShare).times(100_000);
  const rest = new Decimal(100_000).sub(cash);
  const btcValue = rest.times('0.4').div('0.7');
  const ethValue = rest.sub(btcValue);
  return {
    BTC: qty(btcValue.div(BTC).toString()),
    ETH: qty(ethValue.div(ETH).toString()),
    USDC: qty(cash.toString()),
  };
}
const BASE_HOLDINGS = holdingsAt('0.3');
function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    makeClientOrderId: ({ runDate, asset, side, legIndex }) =>
      `${runDate}|${asset}|${side}|${legIndex}`,
    mids: { BTC, ETH },
    lastCompleteRebalanceOn: null,
    balances: [],
    holdings: BASE_HOLDINGS,
    prices: PRICES,
    ...overrides,
  };
}
function leg(overrides: Partial<IntentLeg> = {}): IntentLeg {
  const asset = overrides.asset ?? 'BTC';
  return {
    quote: 'USDC',
    side: 'BUY' as Side,
    amount: usdc('1500'),
    ...overrides,
    asset,
    limitPrice: overrides.limitPrice ?? (asset === 'ETH' ? ETH : BTC),
  };
}
function intent(legs: readonly IntentLeg[]): Intent {
  return {
    runDate: '2026-08-31',
    strategy: 'rebalance',
    trigger: 'CASH_BAND',
    reason: 'test etat projete',
    weightsBefore: WEIGHTS,
    weightsTarget: WEIGHTS,
    legs,
  };
}
function codes(i: Intent, ctx: RiskContext = context()): readonly RejectionCode[] {
  const verdict = validate(i, ctx);
  return verdict.status === 'REJECTED' ? verdict.rejections.map((r) => r.code) : [];
}
function rejections(i: Intent, ctx: RiskContext = context()): readonly Rejection[] {
  const verdict = validate(i, ctx);
  if (verdict.status !== 'REJECTED') {
    throw new Error('run accepte alors qu\'un motif bloquant etait attendu');
  }
  return verdict.rejections;
}
function accepted(i: Intent, ctx: RiskContext = context()) {
  const verdict = validate(i, ctx);
  if (verdict.status !== 'ACCEPTED') {
    throw new Error(`run rejete : ${verdict.rejections.map((r) => r.code).join(', ')}`);
  }
  return verdict;
}
describe('MIN_CASH (C16, C17)', () => {
  it('ne rejet pas un cash courant a 20 % sans jambe executee (C16)', () => {
    const ctx = context({ holdings: holdingsAt('0.2') });
    expect(validate(intent([]), ctx).status).toBe('ACCEPTED');
    expect(validate(intent([leg({ amount: usdc('12') })]), ctx).status).toBe('ACCEPTED');
  });
  it('rejette un etat projete a 21 % (C16)', () => {
    expect(MIN_CASH_PCT.toString()).toBe('0.22');
    expect(codes(intent([leg({ amount: usdc('9000') })]))).toEqual(['MIN_CASH']);
  });
  it('laisse passer un retour a 24 % en band_edge (C17)', () => {
    const ctx = context({ holdings: holdingsAt('0.2') });
    const verdict = accepted(intent([leg({ side: 'SELL', amount: usdc('4000') })]), ctx);
    expect(verdict.orders).toHaveLength(1);
  });
  it('accepte un cash projete exactement a 22 %', () => {
    expect(validate(intent([leg({ amount: usdc('8000') })]), context()).status).toBe('ACCEPTED');
  });
  it('projette une vente ETH (branche miroir de BTC)', () => {
    expect(
      accepted(intent([leg({ asset: 'ETH', side: 'SELL', amount: usdc('1000'), limitPrice: ETH })])),
    ).toMatchObject({ status: 'ACCEPTED' });
  });
});

describe('MAX_EXPOSURE', () => {
  /** 45 / 15 / 40 : assez de cash pour monter BTC sans mordre MIN_CASH. */
  const highBtc: Holdings = {
    BTC: qty(new Decimal('45000').div('60000').toString()),
    ETH: qty(new Decimal('15000').div('3000').toString()),
    USDC: qty('40000'),
  };
  it('rejette une exposition projetee BTC au-dela de 50 %', () => {
    expect(MAX_EXPOSURE_PCT.toString()).toBe('0.5');
    const verdict = rejections(intent([leg({ amount: usdc('10000') })]), context({ holdings: highBtc }));
    expect(verdict).toEqual([expect.objectContaining({ code: 'MAX_EXPOSURE' })]);
    expect(verdict[0]?.reason).toContain('BTC');
  });
  it('accepte une exposition projetee exactement a 50 %', () => {
    expect(
      validate(intent([leg({ amount: usdc('5000') })]), context({ holdings: highBtc })).status,
    ).toBe('ACCEPTED');
  });
});

describe('REBALANCE_TOO_LARGE (C20)', () => {
  it('rejette quand la somme des jambes depasse 25 % de la valeur totale', () => {
    expect(REBALANCE_TOO_LARGE_PCT.toString()).toBe('0.25');
    expect(
      codes(
        intent([
          leg({ asset: 'BTC', side: 'SELL', amount: usdc('13000') }),
          leg({ asset: 'ETH', side: 'BUY', amount: usdc('13000') }),
        ]),
      ),
    ).toEqual(['REBALANCE_TOO_LARGE']);
  });
  it('accepte une somme exactement a 25 %', () => {
    expect(
      validate(
        intent([
          leg({ asset: 'BTC', side: 'SELL', amount: usdc('12500') }),
          leg({ asset: 'ETH', side: 'BUY', amount: usdc('12500') }),
        ]),
        context(),
      ).status,
    ).toBe('ACCEPTED');
  });
  it('ignore les jambes LEG_TOO_SMALL dans la somme', () => {
    expect(
      validate(
        intent([
          leg({ asset: 'BTC', side: 'SELL', amount: usdc('12450') }),
          leg({ asset: 'ETH', side: 'BUY', amount: usdc('12450') }),
          leg({ amount: usdc('12') }),
        ]),
        context(),
      ).status,
    ).toBe('ACCEPTED');
  });
});

describe('portefeuille non valorisable', () => {
  it('refuse un etat courant a valeur nulle des qu\'une jambe est conservee', () => {
    expect(() =>
      validate(
        intent([leg()]),
        context({ holdings: { BTC: qty('0'), ETH: qty('0'), USDC: qty('0') } }),
      ),
    ).toThrow(/non valorisable/);
  });
  it('refuse un etat projete a valeur non positive', () => {
    const absurd = price('1000000000000000000');
    expect(() =>
      validate(
        intent([leg({ amount: usdc('2000'), limitPrice: absurd })]),
        context({
          holdings: { BTC: qty('0'), ETH: qty('0'), USDC: qty('1000') },
          mids: { BTC: absurd, ETH },
        }),
      ),
    ).toThrow(/etat projete non valorisable/);
  });
});