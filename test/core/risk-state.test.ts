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
/** Valeur totale de BASE_HOLDINGS : les montants du plafond s'en deduisent. */
const TOTAL = new Decimal(100_000);
/** Deux jambes a ce montant pesent exactement le plafond, quelle que soit sa valeur. */
const DEMI_PLAFOND = TOTAL.times(REBALANCE_TOO_LARGE_PCT).div(2);
/**
 * Cash a 23,2 % en quantites exactes : MIN_CASH se franchit par une jambe de
 * 2 % environ, sous le plafond, qui ne doit pas masquer la regle testee.
 */
const PRES_DU_MIN_CASH: Holdings = { BTC: qty('0.73'), ETH: qty('11'), USDC: qty('23200') };
function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    makeClientOrderId: ({ runDate, asset, side, legIndex }) =>
      `${runDate}|${asset}|${side}|${legIndex}`,
    mids: { BTC, ETH },
    closes: PRICES,
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
    const ctx = context({ holdings: PRES_DU_MIN_CASH });
    expect(codes(intent([leg({ amount: usdc('2200') })]), ctx)).toEqual(['MIN_CASH']);
  });
  it('laisse passer un retour a 24 % en band_edge (C17)', () => {
    const ctx = context({ holdings: holdingsAt('0.2') });
    const verdict = accepted(intent([leg({ side: 'SELL', amount: usdc('4000') })]), ctx);
    expect(verdict.orders).toHaveLength(1);
  });
  it('accepte un cash projete exactement a 22 %', () => {
    const ctx = context({ holdings: PRES_DU_MIN_CASH });
    expect(validate(intent([leg({ amount: usdc('1200') })]), ctx).status).toBe('ACCEPTED');
  });
  it('projette une vente ETH (branche miroir de BTC)', () => {
    expect(
      accepted(intent([leg({ asset: 'ETH', side: 'SELL', amount: usdc('1000'), limitPrice: ETH })])),
    ).toMatchObject({ status: 'ACCEPTED' });
  });
});

describe('MAX_EXPOSURE', () => {
  /**
   * 48 / 12 / 40 : assez de cash pour monter BTC sans mordre MIN_CASH, et BTC
   * assez pres du plafond d'exposition pour le franchir sous REBALANCE_TOO_LARGE.
   */
  const highBtc: Holdings = {
    BTC: qty(new Decimal('48000').div('60000').toString()),
    ETH: qty(new Decimal('12000').div('3000').toString()),
    USDC: qty('40000'),
  };
  it('rejette une exposition projetee BTC au-dela de 50 %', () => {
    expect(MAX_EXPOSURE_PCT.toString()).toBe('0.5');
    const verdict = rejections(intent([leg({ amount: usdc('3000') })]), context({ holdings: highBtc }));
    expect(verdict).toEqual([expect.objectContaining({ code: 'MAX_EXPOSURE' })]);
    expect(verdict[0]?.reason).toContain('BTC');
  });
  it('accepte une exposition projetee exactement a 50 %', () => {
    expect(
      validate(intent([leg({ amount: usdc('2000') })]), context({ holdings: highBtc })).status,
    ).toBe('ACCEPTED');
  });
});

/** Deux jambes qui se compensent en cash : seule l'ampleur du run peut mordre. */
function arbitrage(each: Decimal): readonly IntentLeg[] {
  return [
    leg({ asset: 'BTC', side: 'SELL', amount: each as UsdcAmount }),
    leg({ asset: 'ETH', side: 'BUY', amount: each as UsdcAmount }),
  ];
}

/*
 * Exprimes relativement au plafond, pas en montants recopies : ces cas eprouvent
 * la regle a toute valeur de REBALANCE_TOO_LARGE_PCT, et restent le cas qu'ils
 * testaient quand la phase 3 l'abaisse ou quand sa levee le remonte.
 */
describe('REBALANCE_TOO_LARGE (C20)', () => {
  it('rejette quand la somme des jambes depasse le plafond de la valeur totale', () => {
    expect(codes(intent(arbitrage(DEMI_PLAFOND.add(500))))).toEqual(['REBALANCE_TOO_LARGE']);
  });
  it('accepte une somme exactement au plafond', () => {
    expect(validate(intent(arbitrage(DEMI_PLAFOND)), context()).status).toBe('ACCEPTED');
  });
  /* Au plafond pile, la jambe de 12 USDC le ferait franchir si elle etait comptee. */
  it('ignore les jambes LEG_TOO_SMALL dans la somme', () => {
    const verdict = accepted(intent([...arbitrage(DEMI_PLAFOND), leg({ amount: usdc('12') })]));
    expect(verdict.ignored.map((r) => r.code)).toEqual(['LEG_TOO_SMALL']);
  });
  /**
   * C20 exige la somme des |jambes|. Sans `.abs()`, les deux jambes opposees se
   * compensent (somme signee 0) et le run passe a tort alors qu'il depasse le
   * plafond d'un point. Les deux jambes sont en BUY pour garder un cash projete
   * neutre : seule l'ampleur notional doit declencher le rejet.
   */
  it('rejette quand la somme des |jambes| depasse le plafond meme si la somme signee reste sous le seuil', () => {
    const each = DEMI_PLAFOND.add(500);
    expect(
      codes(
        intent([
          leg({ asset: 'ETH', side: 'BUY', amount: each as UsdcAmount }),
          leg({ asset: 'BTC', side: 'BUY', amount: each.neg() as UsdcAmount }),
        ]),
      ),
    ).toEqual(['REBALANCE_TOO_LARGE']);
  });
});

/*
 * Le plafond d'ampleur d'un run (B2, O1 = 3) : la valeur elle-meme. Ces sondes-ci
 * rougissent si la constante bouge ; les cas relatifs ci-dessus, non. 25 % en
 * phase 0, 8 % retenu le 2026-09-21, releve a 11 % le 2026-09-27, puis a 25 % le
 * 2026-11-12 par decision de l'operateur : chaque geste (O3 = 3, E34) est un
 * commit relu qui les change.
 */
describe('plafond d\'ampleur d\'un run (E29, E30, E32)', () => {
  it('vaut 25 %, la valeur de la phase 0 (decision du 2026-11-12)', () => {
    expect(REBALANCE_TOO_LARGE_PCT.toString()).toBe('0.25');
  });
  /* Le cas qui a motive le relevement : un retour a la cible de 13,2 %, le premier des quatre RATIO_BAND. */
  it('laisse passer un run a 13,2 % du portefeuille, que le plafond de 11 % refusait', () => {
    expect(validate(intent(arbitrage(new Decimal('6600'))), context()).status).toBe('ACCEPTED');
  });
  it('laisse passer un run pile a 25 % du portefeuille (strict)', () => {
    expect(validate(intent(arbitrage(new Decimal('12500'))), context()).status).toBe('ACCEPTED');
  });
  it('refuse un run juste au-dessus de 25 % du portefeuille', () => {
    expect(codes(intent(arbitrage(new Decimal('12501'))))).toEqual(['REBALANCE_TOO_LARGE']);
  });
  it('refuse le run entier, sans raboter ses jambes (O2 = 3)', () => {
    const verdict = validate(intent(arbitrage(new Decimal('15000'))), context());
    expect(verdict).toEqual({ status: 'REJECTED', rejections: [expect.anything()] });
  });
  it('le motif cite l\'ampleur du run et la valeur du plafond (E32)', () => {
    const [rejet] = rejections(intent(arbitrage(new Decimal('15000'))));
    expect(rejet?.reason).toBe(
      'somme des |jambes| 30000 USDC soit 30.0000 % de 100000, au-dela de 25 %',
    );
  });
});

/*
 * D7 : quand la decision est recalculee sur le mid, `prices` vaut le mid et les
 * regles d'etat (ampleur, MIN_CASH, MAX_EXPOSURE) valorisent le portefeuille au
 * mid, pas a la cloture. Chaque cas morde au mid et passe a la cloture, avec des
 * mids a 10-15 % de la cloture (donc dans la borne de 20 %).
 */
describe('regles d\'etat reappliquees au prix de decision (D7)', () => {
  const auMid = (btc: string, eth: string): Pick<RiskContext, 'mids' | 'prices'> => {
    const mids = { BTC: price(btc), ETH: price(eth) };
    return { mids, prices: mids };
  };
  const jambe = (asset: 'BTC' | 'ETH', side: Side, amount: string, limit: string): IntentLeg =>
    leg({ asset, side, amount: usdc(amount), limitPrice: price(limit) });

  it('REBALANCE_TOO_LARGE : 24 % de la cloture, 26,8 % de la valeur au mid', () => {
    const jambes = (btc: string, eth: string): readonly IntentLeg[] => [
      jambe('BTC', 'SELL', '12000', btc),
      jambe('ETH', 'BUY', '12000', eth),
    ];
    expect(validate(intent(jambes('60000', '3000')), context()).status).toBe('ACCEPTED');
    const ctx = context(auMid('51000', '2550'));
    const [rejet] = rejections(intent(jambes('51000', '2550')), ctx);
    expect(rejet?.code).toBe('REBALANCE_TOO_LARGE');
    expect(rejet?.reason).toMatch(/^somme des \|jambes\| 24000 USDC soit 26\.8156 % de 89500/);
  });
  it('MIN_CASH : 22 % de la cloture, 19,7 % de la valeur au mid', () => {
    const ctxCloture = context({ holdings: PRES_DU_MIN_CASH });
    expect(
      validate(intent([jambe('BTC', 'BUY', '1200', '60000')]), ctxCloture).status,
    ).toBe('ACCEPTED');
    const ctx = context({ holdings: PRES_DU_MIN_CASH, ...auMid('69000', '3450') });
    const [rejet] = rejections(intent([jambe('BTC', 'BUY', '1200', '69000')]), ctx);
    expect(rejet?.code).toBe('MIN_CASH');
    expect(rejet?.reason).toMatch(/^cash projete a 19\.7\d* %/);
  });
  it('MAX_EXPOSURE : BTC a 49,5 % a la cloture, 50,8 % au mid', () => {
    const holdings: Holdings = { BTC: qty('0.8'), ETH: qty('6.666666666666667'), USDC: qty('32000') };
    expect(
      validate(intent([jambe('BTC', 'BUY', '1500', '60000')]), context({ holdings })).status,
    ).toBe('ACCEPTED');
    const ctx = context({ holdings, ...auMid('66000', '3300') });
    const [rejet] = rejections(intent([jambe('BTC', 'BUY', '1500', '66000')]), ctx);
    expect(rejet?.code).toBe('MAX_EXPOSURE');
    expect(rejet?.reason).toMatch(/^exposition projetee BTC a 50\.8\d* %/);
  });
  it('une cloture lointaine ne change pas la valorisation : seul prices compte', () => {
    // Memes mids et prices, closes a 15 % en dessous : le verdict est celui du mid.
    const ctx = context({
      holdings: PRES_DU_MIN_CASH,
      ...auMid('69000', '3450'),
      closes: { BTC: price('60000'), ETH: price('3000') },
    });
    expect(codes(intent([jambe('BTC', 'BUY', '1200', '69000')]), ctx)).toEqual(['MIN_CASH']);
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
  /*
   * Le mid ne peut plus s'ecarter de la cloture : c'est une limite a 2 % pile
   * au-dessus, sur un achat soixante fois plus grand que le portefeuille, qui
   * projette un total negatif (1 000 - 60 000 x 0,02 / 1,02).
   */
  it('refuse un etat projete a valeur non positive', () => {
    expect(() =>
      validate(
        intent([leg({ amount: usdc('60000'), limitPrice: price('61200') })]),
        context({ holdings: { BTC: qty('0'), ETH: qty('0'), USDC: qty('1000') } }),
      ),
    ).toThrow(/etat projete non valorisable/);
  });
});
