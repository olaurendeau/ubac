import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type {
  DrawdownResult,
  MarketDay,
  RollingSharpeResult,
  Sharpe,
  SharpePoint,
  ValueSeries,
} from '../../src/core/benchmark.js';
import {
  HOLD_BTC,
  SHARPE_WINDOW,
  holdSeries,
  maxDrawdown,
  rollingSharpe,
} from '../../src/core/benchmark.js';
import type { CashFlow, IsoDate, Price, UsdcAmount } from '../../src/core/types.js';

const price = (value: string): Price => new Decimal(value) as Price;
const usdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;

/** Les dates ne sont que des etiquettes ici : les deux metriques ne les lisent pas. */
const START = Date.UTC(2024, 0, 1);
const dateAt = (index: number): IsoDate =>
  new Date(START + index * 86_400_000).toISOString().slice(0, 10);

/**
 * Serie de valeurs sans aucun flux : la valeur du jour est a la fois la cloture
 * de la sous-periode qui finit et l'ouverture de la suivante. Les rendements
 * sont alors exactement les rapports successifs des valeurs, ce qui permet de
 * poser des series dont le drawdown et le Sharpe se calculent de tete.
 */
const seriesOf = (values: readonly string[]): ValueSeries =>
  values.map((value, index) => ({
    date: dateAt(index),
    valueBeforeFlow: usdc(value),
    flow: usdc('0'),
    valueAfterFlow: usdc(value),
  }));

const marketDay = (date: IsoDate, btc: string): MarketDay => ({
  date,
  prices: { BTC: price(btc), ETH: price('3000') },
});

const cashFlow = (occurredOn: IsoDate, amount: string): CashFlow => ({
  occurredOn,
  amount: usdc(amount),
});

const CAPITAL = usdc('120000');

/** Retrecit sur la branche calculee, en echouant au lieu de sauter le test. */
function computed(result: DrawdownResult): Extract<DrawdownResult, { status: 'COMPUTED' }> {
  if (result.status !== 'COMPUTED') {
    throw new Error(`attendu COMPUTED, recu REJECTED (${result.code} : ${result.reason})`);
  }
  return result;
}

function pointsOf(result: RollingSharpeResult): readonly SharpePoint[] {
  if (result.status !== 'COMPUTED') {
    throw new Error(`attendu COMPUTED, recu REJECTED (${result.code} : ${result.reason})`);
  }
  return result.points;
}

function definedAt(points: readonly SharpePoint[], index: number): Sharpe {
  const point = points[index];
  if (point === undefined) throw new Error(`aucun point a l'indice ${String(index)}`);
  if (point.status !== 'DEFINED') {
    throw new Error(`point ${point.date} attendu DEFINED, recu UNDEFINED (${point.code})`);
  }
  return point.sharpe;
}

function undefinedAt(points: readonly SharpePoint[], index: number): string {
  const point = points[index];
  if (point === undefined) throw new Error(`aucun point a l'indice ${String(index)}`);
  if (point.status !== 'UNDEFINED') {
    throw new Error(`point ${point.date} attendu UNDEFINED, recu ${point.sharpe.toString()}`);
  }
  return point.code;
}

describe('max drawdown', () => {
  it('C28 - une serie qui ne baisse jamais a un drawdown nul', () => {
    /* 100 -> 110 -> 120 -> 130 : chaque jour est un nouveau plus haut. */
    const result = computed(maxDrawdown(seriesOf(['100', '110', '120', '130'])));

    expect(result.maxDrawdown.toString()).toBe('0');
    /* Pic et creux au premier jour : cela se lit "aucune baisse", pas "baisse nulle le jour J". */
    expect(result.peakDate).toBe('2024-01-01');
    expect(result.troughDate).toBe('2024-01-01');
  });

  it('C28 - serie en V : 200 puis 100, soit la moitie perdue', () => {
    /* 100 -> 200 -> 100 -> 150. Le pic est a 200, le creux a 100 : -50 %. */
    const result = computed(maxDrawdown(seriesOf(['100', '200', '100', '150'])));

    expect(result.maxDrawdown.toString()).toBe('-0.5');
    expect(result.peakDate).toBe('2024-01-02');
    expect(result.troughDate).toBe('2024-01-03');
  });

  it('C28 - retient le pic le plus proche du creux, pas le premier point', () => {
    /*
     * 100 -> 80 -> 120 -> 60 -> 90. Deux baisses : -20 % depuis le depart, puis
     * -50 % depuis le plus haut a 120. La seconde est la bonne reponse ; mesurer
     * la chute depuis le premier point rendrait -40 %, et mesurer depuis le
     * premier plus haut rencontre en rendrait -40 % aussi.
     */
    const result = computed(maxDrawdown(seriesOf(['100', '80', '120', '60', '90'])));

    expect(result.maxDrawdown.toString()).toBe('-0.5');
    expect(result.peakDate).toBe('2024-01-03');
    expect(result.troughDate).toBe('2024-01-04');
  });

  it('mesure l indice de croissance, pas la valeur en USDC', () => {
    /*
     * Le BTC est divise par deux puis revient : le drawdown est de -50 %. Un
     * retrait de 30 000 USDC au creux ne change rien a cette baisse, alors que
     * la valeur, elle, tombe de 120 000 a 30 000 — soit -75 % lus a tort sur la
     * valeur. Sans cette distinction, le tableau de rejeu classerait des
     * calendriers d'apports plutot que des strategies.
     */
    const days = [
      marketDay('2024-01-01', '60000'),
      marketDay('2024-01-02', '30000'),
      marketDay('2024-01-03', '60000'),
    ];
    const withdrawn = holdSeries(HOLD_BTC, {
      days,
      cashFlows: [cashFlow('2024-01-02', '-30000')],
      initialCapital: CAPITAL,
    });
    if (withdrawn.status !== 'VALUED') throw new Error(withdrawn.reason);

    expect(withdrawn.series[1]?.valueAfterFlow.toString()).toBe('30000');
    expect(computed(maxDrawdown(withdrawn.series)).maxDrawdown.toString()).toBe('-0.5');

    /* Le meme parcours de prix sans flux donne le meme drawdown. */
    const untouched = holdSeries(HOLD_BTC, { days, cashFlows: [], initialCapital: CAPITAL });
    if (untouched.status !== 'VALUED') throw new Error(untouched.reason);
    expect(computed(maxDrawdown(untouched.series)).maxDrawdown.toString()).toBe('-0.5');
  });
});

describe('max drawdown : refus', () => {
  it('refuse une serie sans sous-periode plutot que de rendre 0', () => {
    for (const values of [[], ['100']]) {
      const result = maxDrawdown(seriesOf(values));
      expect(result.status).toBe('REJECTED');
      if (result.status === 'REJECTED') expect(result.code).toBe('NO_SUB_PERIOD');
    }
  });

  it('refuse une valeur non finie', () => {
    const result = maxDrawdown(seriesOf(['100', 'NaN']));

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.code).toBe('NON_FINITE_VALUE');
      expect(result.reason).toContain('2024-01-02');
    }
  });

  it('refuse une sous-periode qui part d une valeur nulle', () => {
    const result = maxDrawdown(seriesOf(['100', '0', '50']));

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') expect(result.code).toBe('UNDEFINED_SUB_PERIOD');
  });
});

describe('Sharpe glissant', () => {
  it('rend un point par jour et n en definit aucun avant la 90e sous-periode', () => {
    /*
     * Le piege que ce test ferme : rendre 0 tant que la fenetre n'est pas pleine.
     * Un 0 se lit dans le tableau de rejeu comme une performance neutre
     * reellement constatee sur les trois premiers mois de chaque strategie.
     *
     * 90 rendements exigent 91 clotures : a 91 points le dernier est defini, a
     * 90 aucun ne l'est. C'est la seule paire qui fixe la borne.
     */
    const rising = (count: number): ValueSeries => {
      const values: string[] = [];
      let value = new Decimal(100);
      for (let index = 0; index < count; index += 1) {
        values.push(value.toString());
        value = value.mul(index % 2 === 0 ? '1.02' : '0.99');
      }
      return seriesOf(values);
    };

    const short = pointsOf(rollingSharpe(rising(SHARPE_WINDOW)));
    expect(short).toHaveLength(SHARPE_WINDOW);
    expect(short.every((point) => point.status === 'UNDEFINED')).toBe(true);

    const full = pointsOf(rollingSharpe(rising(SHARPE_WINDOW + 1)));
    expect(full).toHaveLength(SHARPE_WINDOW + 1);
    for (let index = 0; index < SHARPE_WINDOW; index += 1) {
      expect(undefinedAt(full, index)).toBe('WINDOW_INCOMPLETE');
    }
    expect(definedAt(full, SHARPE_WINDOW).isFinite()).toBe(true);
  });

  it('C28 - valeur calculee a la main sur trois rendements', () => {
    /*
     * 100 -> 110 -> 132 -> 171.6, soit des rendements de 0.1, 0.2 et 0.3.
     * Moyenne 0.2 ; ecart-type d'echantillon sqrt((0.01 + 0 + 0.01) / 2) = 0.1 ;
     * ratio par periode 0.2 / 0.1 = 2 ; annualise 2 x sqrt(365) = 38.20994635.
     */
    const points = pointsOf(rollingSharpe(seriesOf(['100', '110', '132', '171.6']), 3));

    expect(points).toHaveLength(4);
    expect(undefinedAt(points, 2)).toBe('WINDOW_INCOMPLETE');
    expect(definedAt(points, 3).toSignificantDigits(10).toString()).toBe('38.20994635');
    /* Le ratio par periode, isole de la convention d'annualisation. */
    expect(
      definedAt(points, 3).div(new Decimal(365).sqrt()).toSignificantDigits(15).toString(),
    ).toBe('2');
  });

  it('C28 - une serie qui perd rend un Sharpe negatif du meme module', () => {
    /* 100 -> 90 -> 72 -> 50.4 : rendements -0.1, -0.2, -0.3, l'exact miroir. */
    const points = pointsOf(rollingSharpe(seriesOf(['100', '90', '72', '50.4']), 3));

    expect(definedAt(points, 3).toSignificantDigits(10).toString()).toBe('-38.20994635');
  });

  it('la fenetre glisse : un rendement plus vieux qu elle ne compte pas', () => {
    /*
     * Meme serie que le test calcule a la main, precedee d'un effondrement de
     * -90 %. La fenetre de 3 ne doit plus le voir au dernier point ; une somme
     * cumulee depuis le debut, elle, en garderait la trace.
     */
    const points = pointsOf(
      rollingSharpe(seriesOf(['1000', '100', '110', '132', '171.6']), 3),
    );

    expect(definedAt(points, 4).toSignificantDigits(10).toString()).toBe('38.20994635');
    /* Le point precedent, lui, contient encore le krach : il est tres negatif. */
    expect(definedAt(points, 3).isNegative()).toBe(true);
  });

  it('un Sharpe nul et defini n est pas une fenetre incomplete', () => {
    /*
     * 100 -> 110 -> 99 -> 108.9 -> 98.01 : rendements +0.1, -0.1, +0.1, -0.1.
     * Moyenne exactement nulle, volatilite non nulle : le ratio vaut 0 et il est
     * bien mesure. C'est ce cas qui rend la distinction lisible cote appelant —
     * `DEFINED` a 0 et `UNDEFINED` ne se confondent pas.
     */
    const points = pointsOf(
      rollingSharpe(seriesOf(['100', '110', '99', '108.9', '98.01']), 4),
    );

    expect(definedAt(points, 4).toString()).toBe('0');
  });

  it('une fenetre a volatilite nulle n a pas de Sharpe, ni 0 ni infini', () => {
    /* 100 -> 110 -> 121 -> 133.1 : +10 % chaque jour, ecart-type nul. */
    const points = pointsOf(rollingSharpe(seriesOf(['100', '110', '121', '133.1']), 3));

    expect(undefinedAt(points, 3)).toBe('ZERO_VOLATILITY');
  });

  it('ne depend pas du calendrier des apports', () => {
    /*
     * Le Sharpe se lit sur les memes sous-periodes que le TWR : un apport les
     * borne sans entrer dans aucune. Deux rejeux du meme parcours de prix, l'un
     * avec un apport au milieu, doivent donner le meme ratio au dernier jour.
     */
    const days = [
      marketDay('2024-01-01', '60000'),
      marketDay('2024-01-02', '66000'),
      marketDay('2024-01-03', '60000'),
      marketDay('2024-01-04', '72000'),
      marketDay('2024-01-05', '66000'),
    ];
    const sharpeAtEnd = (cashFlows: readonly CashFlow[]): string => {
      const valued = holdSeries(HOLD_BTC, { days, cashFlows, initialCapital: CAPITAL });
      if (valued.status !== 'VALUED') throw new Error(valued.reason);
      const points = pointsOf(rollingSharpe(valued.series, 3));
      return definedAt(points, points.length - 1).toSignificantDigits(15).toString();
    };

    expect(sharpeAtEnd([cashFlow('2024-01-03', '60000')])).toBe(sharpeAtEnd([]));
  });
});

describe('Sharpe glissant : refus', () => {
  it('refuse une fenetre qui ne permet aucun ecart-type d echantillon', () => {
    for (const window of [1, 0, -3, 2.5, Number.NaN]) {
      const result = rollingSharpe(seriesOf(['100', '110', '132', '171.6']), window);
      expect(result.status).toBe('REJECTED');
      if (result.status === 'REJECTED') expect(result.code).toBe('INVALID_WINDOW');
    }
  });

  it('propage les refus de la decomposition en sous-periodes', () => {
    const empty = rollingSharpe(seriesOf(['100']), 3);
    expect(empty.status).toBe('REJECTED');
    if (empty.status === 'REJECTED') expect(empty.code).toBe('NO_SUB_PERIOD');

    const zeroed = rollingSharpe(seriesOf(['100', '0', '50']), 3);
    expect(zeroed.status).toBe('REJECTED');
    if (zeroed.status === 'REJECTED') expect(zeroed.code).toBe('UNDEFINED_SUB_PERIOD');
  });
});
