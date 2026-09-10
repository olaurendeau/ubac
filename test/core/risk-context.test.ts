import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import {
  COOLDOWN_DAYS,
  PRICE_SANITY_PCT,
  RECONCILIATION_DRIFT_PCT,
  armsCooldown,
  cooldownAnchor,
  validate,
} from '../../src/core/risk.js';
import type { Balance, RebalanceExecution, RiskContext } from '../../src/core/risk.js';
import type {
  Intent,
  IntentLeg,
  IsoDate,
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
const MID_BTC = price('60000');
const MID_ETH = price('3000');
const PRICES: Prices = { BTC: MID_BTC, ETH: MID_ETH };
const WEIGHTS: Weights = { BTC: weight('0.4'), ETH: weight('0.3'), USDC: weight('0.3') };
const HOLDINGS: Holdings = {
  BTC: qty('0.6666666666666667'),
  ETH: qty('10'),
  USDC: qty('30000'),
};
function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    makeClientOrderId: ({ runDate, asset, side, legIndex }) =>
      `${runDate}|${asset}|${side}|${legIndex}`,
    mids: { BTC: MID_BTC, ETH: MID_ETH },
    lastCompleteRebalanceOn: null,
    balances: [],
    holdings: HOLDINGS,
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
    limitPrice: overrides.limitPrice ?? (asset === 'ETH' ? MID_ETH : MID_BTC),
  };
}
function intent(legs: readonly IntentLeg[], runDate: IsoDate = '2026-08-31'): Intent {
  return {
    runDate,
    strategy: 'rebalance',
    trigger: 'CASH_BAND',
    reason: 'test contextuel',
    weightsBefore: WEIGHTS,
    weightsTarget: WEIGHTS,
    legs,
  };
}
function codes(i: Intent, ctx: RiskContext): readonly RejectionCode[] {
  const verdict = validate(i, ctx);
  return verdict.status === 'REJECTED' ? verdict.rejections.map((r) => r.code) : [];
}
function rejections(i: Intent, ctx: RiskContext): readonly Rejection[] {
  const verdict = validate(i, ctx);
  if (verdict.status !== 'REJECTED') {
    throw new Error("run accepte alors qu'un motif bloquant etait attendu");
  }
  return verdict.rejections;
}
function accepted(i: Intent, ctx: RiskContext) {
  const verdict = validate(i, ctx);
  if (verdict.status !== 'ACCEPTED') {
    throw new Error(`run rejete : ${verdict.rejections.map((r) => r.code).join(', ')}`);
  }
  return verdict;
}
function complete(runDate: IsoDate): RebalanceExecution {
  return { runDate, ordersPlaced: 3, ordersFilled: 3 };
}
function partial(runDate: IsoDate): RebalanceExecution {
  return { runDate, ordersPlaced: 3, ordersFilled: 2 };
}
describe('armsCooldown / cooldownAnchor (C21)', () => {
  it('arme seulement un reequilibrage complet reussi', () => {
    expect(armsCooldown(complete('2026-08-30'))).toBe(true);
    expect(armsCooldown(partial('2026-08-30'))).toBe(false);
    expect(armsCooldown({ runDate: '2026-08-30', ordersPlaced: 0, ordersFilled: 0 })).toBe(false);
  });
  it('derive l\'ancre du journal : partiel n\'arme rien, complet recent gagne', () => {
    expect(cooldownAnchor([])).toBeNull();
    expect(cooldownAnchor([partial('2026-08-28'), partial('2026-08-30')])).toBeNull();
    expect(
      cooldownAnchor([complete('2026-08-24'), partial('2026-08-30'), complete('2026-08-10')]),
    ).toBe('2026-08-24');
  });
});

describe('COOLDOWN (C21)', () => {
  it('refuse a 6 jours, accepte a 7, et compte par-dessus un mois', () => {
    expect(COOLDOWN_DAYS).toBe(7);
    expect(codes(intent([leg()], '2026-08-31'), context({ lastCompleteRebalanceOn: '2026-08-25' }))).toEqual([
      'COOLDOWN',
    ]);
    expect(
      validate(intent([leg()], '2026-08-31'), context({ lastCompleteRebalanceOn: '2026-08-24' }))
        .status,
    ).toBe('ACCEPTED');
    expect(
      validate(intent([leg()], '2026-09-07'), context({ lastCompleteRebalanceOn: '2026-08-31' }))
        .status,
    ).toBe('ACCEPTED');
    expect(
      validate(intent([leg()], '2026-09-06'), context({ lastCompleteRebalanceOn: '2026-08-31' }))
        .status,
    ).toBe('REJECTED');
  });
  it('complet a J arme ; partiel a J laisse J+1 passer', () => {
    expect(
      codes(
        intent([leg()], '2026-08-31'),
        context({ lastCompleteRebalanceOn: cooldownAnchor([complete('2026-08-30')]) }),
      ),
    ).toEqual(['COOLDOWN']);
    const history = [complete('2026-08-24'), partial('2026-08-30')];
    expect(
      accepted(
        intent([leg()], '2026-08-31'),
        context({ lastCompleteRebalanceOn: cooldownAnchor(history) }),
      ).orders,
    ).toHaveLength(1);
  });
  it('ne bloque pas sans ordre, accepte sans ancre, refuse une ancre future', () => {
    const ctx = context({ lastCompleteRebalanceOn: '2026-08-30' });
    expect(validate(intent([]), ctx).status).toBe('ACCEPTED');
    expect(validate(intent([leg({ amount: usdc('12') })]), ctx).status).toBe('ACCEPTED');
    expect(validate(intent([leg()]), context()).status).toBe('ACCEPTED');
    expect(codes(intent([leg()], '2026-08-20'), context({ lastCompleteRebalanceOn: '2026-08-25' }))).toEqual([
      'COOLDOWN',
    ]);
  });
  it('refuse une date hors format ou un jour inexistant', () => {
    expect(() =>
      validate(intent([leg()], '31/08/2026'), context({ lastCompleteRebalanceOn: '2026-08-24' })),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      validate(intent([leg()], '2026-08-31'), context({ lastCompleteRebalanceOn: '2026-02-30' })),
    ).toThrow(/2026-02-30/);
  });
});

describe('PRICE_SANITY', () => {
  it('borne a 2 % inclusive, rejette au-dela et sans mid / mid non positif', () => {
    expect(PRICE_SANITY_PCT.toString()).toBe('0.02');
    expect(validate(intent([leg({ limitPrice: price('61200') })]), context()).status).toBe(
      'ACCEPTED',
    );
    expect(codes(intent([leg({ limitPrice: price('61200.01') })]), context())).toEqual([
      'PRICE_SANITY',
    ]);
    expect(codes(intent([leg({ asset: 'ETH' })]), context({ mids: { BTC: MID_BTC } }))).toEqual([
      'PRICE_SANITY',
    ]);
    expect(codes(intent([leg()]), context({ mids: { BTC: price('0') } }))).toEqual(['PRICE_SANITY']);
    expect(codes(intent([leg()]), context({ mids: { BTC: price('-1') } }))).toEqual([
      'PRICE_SANITY',
    ]);
  });
  it('prime sur LEG_TOO_SMALL et ne se cumule pas a ASSET/QUOTE', () => {
    expect(
      codes(intent([leg({ amount: usdc('12'), limitPrice: price('90000') })]), context()),
    ).toEqual(['PRICE_SANITY']);
    expect(codes(intent([leg({ asset: 'SOL' })]), context())).toEqual(['ASSET_NOT_ALLOWED']);
  });
});

describe('RECONCILIATION_DRIFT', () => {
  const btc = (onExchange: string, internal: string): Balance => ({
    asset: 'BTC',
    onExchange: qty(onExchange),
    internal: qty(internal),
  });
  it('predicat pur : vide ok, 1 % ok, au-dela rejette, nuls coherents', () => {
    expect(RECONCILIATION_DRIFT_PCT.toString()).toBe('0.01');
    expect(validate(intent([leg()]), context({ balances: [] })).status).toBe('ACCEPTED');
    expect(validate(intent([leg()]), context({ balances: [btc('1', '0.99')] })).status).toBe(
      'ACCEPTED',
    );
    expect(codes(intent([leg()]), context({ balances: [btc('1', '0.98')] }))).toEqual([
      'RECONCILIATION_DRIFT',
    ]);
    expect(validate(intent([leg()]), context({ balances: [btc('0', '0')] })).status).toBe(
      'ACCEPTED',
    );
    expect(codes(intent([leg()]), context({ balances: [btc('0.5', '0')] }))).toEqual([
      'RECONCILIATION_DRIFT',
    ]);
  });
  it('compare USDC en USDC et abandonne avant toute autre regle', () => {
    const drifting: Balance = { asset: 'USDC', onExchange: usdc('10000'), internal: usdc('9800') };
    expect(codes(intent([leg()]), context({ balances: [drifting] }))).toEqual([
      'RECONCILIATION_DRIFT',
    ]);
    expect(
      codes(
        intent([leg({ quote: 'EUR' })]),
        context({ balances: [btc('1', '0.5')], lastCompleteRebalanceOn: '2026-08-30' }),
      ),
    ).toEqual(['RECONCILIATION_DRIFT']);
  });
});