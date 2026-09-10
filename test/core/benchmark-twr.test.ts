import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  DailyValue,
  HoldInput,
  MarketDay,
  Return,
  SeriesResult,
  ValueSeries,
} from '../../src/core/benchmark.js';
import {
  HOLD_50_50,
  HOLD_BTC,
  holdSeries,
  timeWeightedReturn,
} from '../../src/core/benchmark.js';
import { ASSETS } from '../../src/core/portfolio.js';
import type {
  CashFlow,
  IsoDate,
  Price,
  UsdcAmount,
  Weight,
  Weights,
} from '../../src/core/types.js';

const price = (value: string): Price => new Decimal(value) as Price;
const usdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;
const weight = (value: string): Weight => new Decimal(value) as Weight;

const marketDay = (date: IsoDate, btc: string, eth: string): MarketDay => ({
  date,
  prices: { BTC: price(btc), ETH: price(eth) },
});

const cashFlow = (occurredOn: IsoDate, amount: string): CashFlow => ({
  occurredOn,
  amount: usdc(amount),
});

/** Retrecit l'union sur la branche valorisee, en echouant au lieu de la sauter. */
function valued(result: SeriesResult): Extract<SeriesResult, { status: 'VALUED' }> {
  if (result.status !== 'VALUED') {
    throw new Error(`attendu VALUED, recu REJECTED (${result.code} : ${result.reason})`);
  }
  return result;
}

function rejected(result: SeriesResult): Extract<SeriesResult, { status: 'REJECTED' }> {
  if (result.status !== 'REJECTED') throw new Error('attendu REJECTED, recu VALUED');
  return result;
}

function twrOf(series: ValueSeries): Return {
  const result = timeWeightedReturn(series);
  if (result.status !== 'COMPUTED') {
    throw new Error(`attendu COMPUTED, recu REJECTED (${result.code} : ${result.reason})`);
  }
  return result.twr;
}

const holdTwr = (allocation: Weights, input: HoldInput): Return =>
  twrOf(valued(holdSeries(allocation, input)).series);

/**
 * Comparaison lache, pour les cas ou la division a 20 chiffres significatifs de
 * decimal.js empeche l'egalite exacte. Passer par les chiffres significatifs
 * plutot que par un `lte` sur un ecart garde un message d'echec lisible.
 */
const around = (value: Decimal): string => value.toSignificantDigits(15).toString();

const CAPITAL = usdc('120000');

/** 120 000 USDC a ces prix donnent des quantites exactes : 2 BTC, ou 1 BTC + 20 ETH. */
const FLAT = [
  marketDay('2024-01-01', '60000', '3000'),
  marketDay('2024-01-02', '60000', '3000'),
  marketDay('2024-01-03', '60000', '3000'),
];

describe('allocations hold', () => {
  it('HOLD_BTC place tout en BTC, HOLD_50_50 moitie-moitie, aucune ne garde de cash', () => {
    expect(HOLD_BTC.BTC.toString()).toBe('1');
    expect(HOLD_BTC.ETH.toString()).toBe('0');
    expect(HOLD_50_50.BTC.toString()).toBe('0.5');
    expect(HOLD_50_50.ETH.toString()).toBe('0.5');

    for (const allocation of [HOLD_BTC, HOLD_50_50]) {
      expect(allocation.USDC.toString()).toBe('0');
      const total = ASSETS.reduce<Decimal>(
        (acc, asset) => acc.plus(allocation[asset]),
        new Decimal(0),
      );
      expect(total.toString()).toBe('1');
    }
  });

  it('rejette une allocation qui ne somme pas a 1', () => {
    const lame: Weights = { BTC: weight('0.5'), ETH: weight('0.4'), USDC: weight('0') };
    const result = rejected(
      holdSeries(lame, { days: FLAT, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(result.code).toBe('INVALID_ALLOCATION');
    expect(result.reason).toContain('0.9');
  });

  it('rejette un poids negatif meme quand la somme fait 1', () => {
    /*
     * Le controle de somme seul laisserait passer un levier : 1.5 sur BTC finance
     * par -0.5 sur ETH somme bien a 1. Un benchmark hold n'emprunte pas.
     */
    const levered: Weights = { BTC: weight('1.5'), ETH: weight('-0.5'), USDC: weight('0') };

    expect(
      rejected(holdSeries(levered, { days: FLAT, cashFlows: [], initialCapital: CAPITAL })).code,
    ).toBe('INVALID_ALLOCATION');
  });

  it('rejette un poids non fini', () => {
    const nan: Weights = { BTC: weight('NaN'), ETH: weight('0'), USDC: weight('0') };

    expect(
      rejected(holdSeries(nan, { days: FLAT, cashFlows: [], initialCapital: CAPITAL })).code,
    ).toBe('INVALID_ALLOCATION');
  });
});

describe('serie de valeurs', () => {
  it('traite le capital initial comme le flux du premier jour, pas comme un gain', () => {
    const { series, finalValue } = valued(
      holdSeries(HOLD_BTC, { days: FLAT, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(series).toHaveLength(3);
    expect(series[0]?.valueBeforeFlow.toString()).toBe('0');
    expect(series[0]?.flow.toString()).toBe('120000');
    expect(series[0]?.valueAfterFlow.toString()).toBe('120000');
    expect(series[1]?.valueBeforeFlow.toString()).toBe('120000');
    expect(finalValue.toString()).toBe('120000');
  });

  it('hold BTC suit le prix du BTC', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '120000', '3000'),
    ];
    const { finalValue } = valued(
      holdSeries(HOLD_BTC, { days, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(finalValue.toString()).toBe('240000');
  });

  it('hold 50/50 ne prend que la moitie de la hausse du BTC', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '120000', '3000'),
    ];
    const { finalValue } = valued(
      holdSeries(HOLD_50_50, { days, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(finalValue.toString()).toBe('180000');
  });

  it('ne rebalance jamais : les poids derivent avec les prix', () => {
    /*
     * BTC double le jour 2, ETH double le jour 3. Un hold garde 1 BTC et 20 ETH
     * du debut a la fin et finit a 240 000. Un 50/50 rebalance le jour 2 aurait
     * vendu du BTC pour racheter de l'ETH (90 000 / 90 000) et finirait a
     * 270 000. C'est le seul test qui distingue les deux.
     */
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '120000', '3000'),
      marketDay('2024-01-03', '120000', '6000'),
    ];
    const { series, finalValue } = valued(
      holdSeries(HOLD_50_50, { days, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(series[1]?.valueBeforeFlow.toString()).toBe('180000');
    expect(finalValue.toString()).toBe('240000');
  });

  it('place un apport au prorata des lignes detenues, pas a l allocation cible', () => {
    /*
     * Au jour 2 le portefeuille a derive a 2/3 BTC. L'apport de 90 000 est place
     * dans cette proportion, ce qui donne 1.5 BTC et 30 ETH, soit 360 000 au
     * jour 3. Place a la cible 50/50, il aurait donne 1.375 BTC et 35 ETH, soit
     * 375 000 : le benchmark aurait rebalance a moitie sans le dire.
     */
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '120000', '3000'),
      marketDay('2024-01-03', '120000', '6000'),
    ];
    const { finalValue } = valued(
      holdSeries(HOLD_50_50, {
        days,
        cashFlows: [cashFlow('2024-01-02', '90000')],
        initialCapital: CAPITAL,
      }),
    );

    expect(finalValue.toString()).toBe('360000');
  });

  it('retire au prorata des lignes detenues', () => {
    const { series, finalValue } = valued(
      holdSeries(HOLD_BTC, {
        days: FLAT,
        cashFlows: [cashFlow('2024-01-02', '-60000')],
        initialCapital: CAPITAL,
      }),
    );

    expect(series[1]?.flow.toString()).toBe('-60000');
    expect(series[1]?.valueAfterFlow.toString()).toBe('60000');
    expect(finalValue.toString()).toBe('60000');
  });

  it('somme les flux du meme jour en un flux net', () => {
    const { series, finalValue } = valued(
      holdSeries(HOLD_BTC, {
        days: FLAT,
        cashFlows: [
          cashFlow('2024-01-02', '10000'),
          cashFlow('2024-01-02', '20000'),
          cashFlow('2024-01-02', '-5000'),
        ],
        initialCapital: CAPITAL,
      }),
    );

    expect(series[1]?.flow.toString()).toBe('25000');
    expect(finalValue.toString()).toBe('145000');
  });

  it('ajoute au capital un flux date du premier jour', () => {
    const { series } = valued(
      holdSeries(HOLD_BTC, {
        days: FLAT,
        cashFlows: [cashFlow('2024-01-01', '30000')],
        initialCapital: CAPITAL,
      }),
    );

    expect(series[0]?.flow.toString()).toBe('150000');
    expect(series[1]?.valueBeforeFlow.toString()).toBe('150000');
  });

  it('un poids nul ne divise pas par un prix nul', () => {
    /*
     * Hold BTC vise ETH a 0. Sans le court-circuit sur le poids nul, la quantite
     * d'ETH vaudrait 0 x 0 / 0, soit NaN, et la serie serait rejetee le lendemain
     * pour valeur non finie — un diagnostic qui accuserait le prix.
     */
    const days = [
      marketDay('2024-01-01', '60000', '0'),
      marketDay('2024-01-02', '60000', '0'),
    ];
    const { finalValue } = valued(
      holdSeries(HOLD_BTC, { days, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(finalValue.toString()).toBe('120000');
  });
});

describe('serie de valeurs : refus', () => {
  it('refuse une serie sans jour', () => {
    expect(
      rejected(holdSeries(HOLD_BTC, { days: [], cashFlows: [], initialCapital: CAPITAL })).code,
    ).toBe('EMPTY_SERIES');
  });

  it('refuse un capital nul, negatif ou non fini', () => {
    for (const capital of ['0', '-1000', 'NaN', 'Infinity']) {
      const result = rejected(
        holdSeries(HOLD_BTC, { days: FLAT, cashFlows: [], initialCapital: usdc(capital) }),
      );
      expect(result.code).toBe('INVALID_CAPITAL');
    }
  });

  it('refuse des dates non strictement croissantes', () => {
    const repeated = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-01', '60000', '3000'),
    ];
    const backwards = [
      marketDay('2024-01-02', '60000', '3000'),
      marketDay('2024-01-01', '60000', '3000'),
    ];

    for (const days of [repeated, backwards]) {
      expect(
        rejected(holdSeries(HOLD_BTC, { days, cashFlows: [], initialCapital: CAPITAL })).code,
      ).toBe('DATES_NOT_INCREASING');
    }
  });

  it('refuse un flux date d un jour absent de la serie', () => {
    /*
     * L'ignorer en silence ferait apparaitre l'apport comme une performance : la
     * valeur monterait sans qu'aucun flux ne borne la sous-periode.
     */
    const result = rejected(
      holdSeries(HOLD_BTC, {
        days: FLAT,
        cashFlows: [cashFlow('2024-01-04', '30000')],
        initialCapital: CAPITAL,
      }),
    );

    expect(result.code).toBe('FLOW_OUTSIDE_SERIES');
    expect(result.reason).toContain('2024-01-04');
  });

  it('refuse un flux non fini', () => {
    expect(
      rejected(
        holdSeries(HOLD_BTC, {
          days: FLAT,
          cashFlows: [cashFlow('2024-01-02', 'NaN')],
          initialCapital: CAPITAL,
        }),
      ).code,
    ).toBe('NON_FINITE_FLOW');
  });

  it('refuse un retrait superieur a la valeur du portefeuille', () => {
    const result = rejected(
      holdSeries(HOLD_BTC, {
        days: FLAT,
        cashFlows: [cashFlow('2024-01-02', '-200000')],
        initialCapital: CAPITAL,
      }),
    );

    expect(result.code).toBe('FLOW_EXCEEDS_VALUE');
    expect(result.reason).toContain('2024-01-02');
  });

  it('propage le diagnostic de valuate sur un prix non fini', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', 'NaN', '3000'),
    ];
    const result = rejected(
      holdSeries(HOLD_BTC, { days, cashFlows: [], initialCapital: CAPITAL }),
    );

    expect(result.code).toBe('NON_FINITE_VALUE');
    expect(result.reason).toContain('2024-01-02');
  });

  it('propage le diagnostic de valuate sur un prix negatif', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '-60000', '3000'),
    ];

    expect(
      rejected(holdSeries(HOLD_BTC, { days, cashFlows: [], initialCapital: CAPITAL })).code,
    ).toBe('NON_POSITIVE_VALUE');
  });
});

describe('TWR', () => {
  it('C27 - un apport a prix constants donne un TWR de 0, exactement', () => {
    /*
     * Le critere de la spec, mot pour mot. Les nombres sont choisis pour que les
     * quantites tombent juste (2 BTC, ou 1 BTC + 20 ETH) : le zero attendu est
     * alors exact et non a 1e-8 pres, donc un flux compte a tort dans une
     * sous-periode ne peut pas se cacher derriere une tolerance.
     */
    const input: HoldInput = {
      days: FLAT,
      cashFlows: [cashFlow('2024-01-02', '30000')],
      initialCapital: CAPITAL,
    };

    expect(holdTwr(HOLD_BTC, input).toString()).toBe('0');
    expect(holdTwr(HOLD_50_50, input).toString()).toBe('0');

    /* La valeur, elle, monte de l'apport : c'est bien un TWR, pas un rendement monetaire. */
    expect(valued(holdSeries(HOLD_BTC, input)).finalValue.toString()).toBe('150000');
  });

  it('C27 - un retrait a prix constants donne aussi un TWR de 0', () => {
    const input: HoldInput = {
      days: FLAT,
      cashFlows: [cashFlow('2024-01-02', '-60000')],
      initialCapital: CAPITAL,
    };

    expect(holdTwr(HOLD_BTC, input).toString()).toBe('0');
    expect(holdTwr(HOLD_50_50, input).toString()).toBe('0');
  });

  it('convention : le flux du jour J ne participe pas au rendement du jour J', () => {
    /*
     * Convention choisie ici, la spec ne tranche pas : le flux est applique apres
     * la valorisation du jour. Le portefeuille gagne 10 % le 2 janvier et recoit
     * 132 000 USDC ce meme jour ; le rendement du jour reste 10 %.
     *
     * L'autre convention, qui compte l'apport dans le denominateur de la
     * sous-periode, rendrait 264 000 / 252 000 - 1 = 4.76 % : l'apport diluerait
     * une hausse qu'il n'a pas subie. Les deux chiffres sont differents, c'est
     * pourquoi le choix est fige par ce test.
     */
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '66000', '3000'),
      marketDay('2024-01-03', '66000', '3000'),
    ];
    const twr = holdTwr(HOLD_BTC, {
      days,
      cashFlows: [cashFlow('2024-01-02', '132000')],
      initialCapital: CAPITAL,
    });

    expect(twr.toString()).toBe('0.1');
    expect(new Decimal('264000').div('252000').minus(1).toSignificantDigits(3).toString()).toBe(
      '0.0476',
    );
  });

  it('sans flux, le TWR egale le rendement de la valeur', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '120000', '3000'),
      marketDay('2024-01-03', '120000', '6000'),
    ];
    const input: HoldInput = { days, cashFlows: [], initialCapital: CAPITAL };
    const { finalValue } = valued(holdSeries(HOLD_50_50, input));

    /* 240 000 pour 120 000 places : +100 %. */
    expect(finalValue.div(CAPITAL).minus(1).toString()).toBe('1');
    expect(around(holdTwr(HOLD_50_50, input))).toBe('1');
  });

  it('hold BTC et hold 50/50 ne rendent pas la meme chose sur la meme hausse', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '120000', '3000'),
    ];
    const input: HoldInput = { days, cashFlows: [], initialCapital: CAPITAL };

    expect(holdTwr(HOLD_BTC, input).toString()).toBe('1');
    expect(holdTwr(HOLD_50_50, input).toString()).toBe('0.5');
  });

  it('rend un TWR negatif sur une baisse', () => {
    const days = [
      marketDay('2024-01-01', '60000', '3000'),
      marketDay('2024-01-02', '30000', '1500'),
    ];

    expect(
      holdTwr(HOLD_50_50, { days, cashFlows: [], initialCapital: CAPITAL }).toString(),
    ).toBe('-0.5');
  });

  it('C27 - le TWR ne depend ni du calendrier ni de la taille des apports', () => {
    /*
     * C'est la propriete qui definit un rendement pondere par le temps, et elle
     * decoule du placement au prorata : un apport place a l'allocation cible
     * changerait la composition du portefeuille et donc les rendements suivants,
     * et cette propriete tomberait.
     *
     * La comparaison est relative, sur les facteurs de croissance : sur cinq
     * sous-periodes dont chacune peut multiplier la valeur par cent, un ecart
     * absolu de 1e-15 ne voudrait rien dire.
     */
    const dateAt = (index: number): IsoDate => `2024-01-${String(index + 1).padStart(2, '0')}`;
    const DAY_COUNT = 6;
    const priceArb = fc.integer({ min: 1000, max: 100_000 });

    fc.assert(
      fc.property(
        fc.array(fc.tuple(priceArb, priceArb), { minLength: DAY_COUNT, maxLength: DAY_COUNT }),
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: DAY_COUNT - 1 }), fc.integer({ min: 1, max: 5_000 })),
          { maxLength: 4 },
        ),
        (prices, flowSpecs) => {
          const days = prices.map(([btc, eth], index) =>
            marketDay(dateAt(index), String(btc), String(eth)),
          );
          const cashFlows = flowSpecs.map(([index, amount]) =>
            cashFlow(dateAt(index), String(amount * 100)),
          );

          const withFlows = holdTwr(HOLD_50_50, { days, cashFlows, initialCapital: CAPITAL });
          const withoutFlows = holdTwr(HOLD_50_50, {
            days,
            cashFlows: [],
            initialCapital: CAPITAL,
          });

          const drift = withFlows.plus(1).div(withoutFlows.plus(1)).minus(1).abs();
          expect(drift.lte(new Decimal('1e-15'))).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('TWR : refus', () => {
  const point = (date: IsoDate, before: string, flow: string, after: string): DailyValue => ({
    date,
    valueBeforeFlow: usdc(before),
    flow: usdc(flow),
    valueAfterFlow: usdc(after),
  });

  it('refuse une serie sans sous-periode plutot que de rendre 0', () => {
    /*
     * Un 0 se lirait dans le tableau de rejeu comme une performance neutre
     * reellement constatee, alors qu'aucune periode n'a ete mesuree.
     */
    for (const series of [[], [point('2024-01-01', '0', '120000', '120000')]]) {
      const result = timeWeightedReturn(series);
      expect(result.status).toBe('REJECTED');
      if (result.status === 'REJECTED') expect(result.code).toBe('NO_SUB_PERIOD');
    }
  });

  it('refuse une sous-periode qui part d une valeur nulle', () => {
    /*
     * Atteint par un retrait total : le lendemain, le rendement n'est pas 0, il
     * n'existe pas. Le portefeuille vide n'est pas non plus valorise par
     * `valuate`, qui rejetterait une valeur totale nulle.
     */
    const emptied = valued(
      holdSeries(HOLD_BTC, {
        days: FLAT,
        cashFlows: [cashFlow('2024-01-02', '-120000')],
        initialCapital: CAPITAL,
      }),
    );
    expect(emptied.series[1]?.valueAfterFlow.toString()).toBe('0');
    expect(emptied.series[2]?.valueBeforeFlow.toString()).toBe('0');

    const result = timeWeightedReturn(emptied.series);
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') expect(result.code).toBe('UNDEFINED_SUB_PERIOD');
  });

  it('refuse une valeur non finie', () => {
    const series = [
      point('2024-01-01', '0', '120000', '120000'),
      point('2024-01-02', 'NaN', '0', 'NaN'),
    ];
    const result = timeWeightedReturn(series);

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.code).toBe('NON_FINITE_VALUE');
      expect(result.reason).toContain('2024-01-02');
    }
  });
});
