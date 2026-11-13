import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import {
  COOLDOWN_DAYS,
  LIVE_DRIFT_MAX_PCT,
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
    closes: PRICES,
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
  it('borne la limite au mid en direct a 2 % des deux cotes, 2 % pile accepte', () => {
    const accepte = (limite: string): string => validate(intent([leg({ limitPrice: price(limite) })]), context()).status;
    expect(accepte('58800')).toBe('ACCEPTED');
    expect(codes(intent([leg({ limitPrice: price('58799.99') })]), context())).toEqual(['PRICE_SANITY']);
    expect(rejections(intent([leg({ limitPrice: price('61200.01') })]), context())[0]?.reason).toMatch(
      /prix limite 61200.01 a 2.0000 % du mid 60000/,
    );
  });
  it('borne le mid en direct a 2 % de la cloture, des deux cotes, 2 % pile accepte', () => {
    const auMid = (mid: string): readonly RejectionCode[] =>
      codes(intent([leg({ limitPrice: price(mid) })]), context({ mids: { BTC: price(mid), ETH: MID_ETH } }));
    expect(auMid('61200')).toEqual([]);
    expect(auMid('58800')).toEqual([]);
    expect(auMid('61200.01')).toEqual(['PRICE_SANITY']);
    expect(auMid('58799.99')).toEqual(['PRICE_SANITY']);
    const [rejet] = rejections(
      intent([leg({ limitPrice: price('63000') })]),
      context({ mids: { BTC: price('63000'), ETH: MID_ETH } }),
    );
    expect(rejet?.reason).toMatch(
      /decision dimensionnee sur un prix 60000 dont le mid 63000 s'ecarte de 5.0000 %, au-dela de 2 % : a recalculer/,
    );
  });
  it('rejette un mid non fini, et une cloture nulle ou non finie lue dans closes', () => {
    for (const mid of ['NaN', 'Infinity']) {
      expect(codes(intent([leg()]), context({ mids: { BTC: price(mid) } }))).toEqual(['PRICE_SANITY']);
    }
    for (const cloture of ['0', 'NaN']) {
      const [rejet] = rejections(intent([leg()]), context({ closes: { BTC: price(cloture), ETH: MID_ETH } }));
      expect(rejet?.reason).toMatch(/^cloture BTC a .* n'est comparable a rien$/);
    }
  });
  it('rejette un prix de decision nul ou non fini', () => {
    for (const decision of ['0', 'NaN']) {
      const [rejet] = rejections(intent([leg()]), context({ prices: { BTC: price(decision), ETH: MID_ETH } }));
      expect(rejet?.reason).toMatch(/^prix de decision BTC a .* n'est comparable a rien$/);
    }
  });
  it('prime sur LEG_TOO_SMALL et ne se cumule pas a ASSET/QUOTE', () => {
    expect(
      codes(intent([leg({ amount: usdc('12'), limitPrice: price('90000') })]), context()),
    ).toEqual(['PRICE_SANITY']);
    expect(codes(intent([leg({ asset: 'SOL' })]), context())).toEqual(['ASSET_NOT_ALLOWED']);
  });
});

/*
 * D7 (2026-11-13) : le mid se compare a la cloture (`closes`) avec une borne de
 * 20 %, et au prix de decision (`prices`) avec la borne de 2 %. Mid, limite et
 * prix de decision valent ici le meme nombre quand rien ne les distingue.
 */
describe('PRICE_SANITY — mid a la cloture, borne a 20 %', () => {
  const surLeMid = (mid: string, prices: Prices = PRICES): readonly Rejection[] => {
    const verdict = validate(
      intent([leg({ limitPrice: price(mid) })]),
      context({ mids: { BTC: price(mid), ETH: MID_ETH }, prices }),
    );
    return verdict.status === 'REJECTED' ? verdict.rejections : [];
  };
  const prixAuMid = (mid: string): Prices => ({ BTC: price(mid), ETH: MID_ETH });

  it('la borne vaut 20 %', () => {
    expect(LIVE_DRIFT_MAX_PCT.toString()).toBe('0.2');
  });
  it('20 % pile passe, des deux cotes, quand la decision est dimensionnee sur le mid', () => {
    for (const mid of ['72000', '48000']) {
      expect(
        codes(
          intent([leg({ limitPrice: price(mid) })]),
          context({ mids: { BTC: price(mid), ETH: MID_ETH }, prices: prixAuMid(mid) }),
        ),
      ).toEqual([]);
    }
  });
  it('20,01 % rejette, des deux cotes, avec la raison, meme dimensionne sur le mid', () => {
    for (const mid of ['72006', '47994']) {
      const rejetees = surLeMid(mid, prixAuMid(mid));
      expect(rejetees).toHaveLength(1);
      expect(rejetees[0]?.code).toBe('PRICE_SANITY');
      expect(rejetees[0]?.legIndex).toBe(0);
      expect(rejetees[0]?.reason).toMatch(
        new RegExp(`mid en direct ${mid} a 20.0100 % de la cloture 60000, au-dela de 20 % : carnet aberrant`),
      );
    }
  });
  it('lit la cloture dans closes, pas dans prices', () => {
    // prices = mid : seule closes distingue un mid a 15 % (accepte) d'un mid a 25 % (rejete).
    const ctx = (closeBtc: string): RiskContext =>
      context({
        mids: { BTC: price('69000'), ETH: MID_ETH },
        prices: prixAuMid('69000'),
        closes: { BTC: price(closeBtc), ETH: MID_ETH },
      });
    const i = intent([leg({ limitPrice: price('69000') })]);
    expect(codes(i, ctx('60000'))).toEqual([]);
    expect(codes(i, ctx('55000'))).toEqual(['PRICE_SANITY']);
  });
  it('mid a 15 % de la cloture, decision dimensionnee sur le mid : accepte', () => {
    expect(surLeMid('69000', prixAuMid('69000'))).toEqual([]);
  });
  it('mid a 15 % de la cloture, decision restee sur la cloture : rejete, a recalculer', () => {
    const [rejet] = surLeMid('69000');
    expect(rejet?.reason).toMatch(/dont le mid 69000 s'ecarte de 15.0000 %.*a recalculer sur le mid/);
  });
  it('decision sur la cloture : 2 % pile accepte, 2,01 % rejette', () => {
    expect(surLeMid('61200')).toEqual([]);
    expect(surLeMid('61200.01')).toHaveLength(1);
    expect(surLeMid('58800')).toEqual([]);
    expect(surLeMid('58799.99')).toHaveLength(1);
  });
  it('le controle de la limite precede celui du prix de decision', () => {
    const [rejet] = rejections(
      intent([leg({ limitPrice: price('65000') })]),
      context({ mids: { BTC: price('69000'), ETH: MID_ETH } }),
    );
    expect(rejet?.reason).toMatch(/^prix limite 65000 a /);
  });
  it('le controle de la cloture precede celui de la limite', () => {
    const [rejet] = rejections(
      intent([leg({ limitPrice: price('1') })]),
      context({ mids: { BTC: price('80000'), ETH: MID_ETH }, prices: prixAuMid('80000') }),
    );
    expect(rejet?.reason).toMatch(/^mid en direct 80000 a 33.3333 % de la cloture 60000/);
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