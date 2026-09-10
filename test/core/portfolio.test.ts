import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import { ASSETS, exposureOf, totalValue, valuate } from '../../src/core/portfolio.js';
import type { Price, Quantity } from '../../src/core/types.js';

const qty = (value: string): Quantity => new Decimal(value) as Quantity;
const price = (value: string): Price => new Decimal(value) as Price;

/** Tolerance de C4. La somme des poids vaut 1 a 1e-8 pres, pas exactement 1. */
const TOLERANCE = new Decimal('1e-8');

const sumOf = (values: readonly Decimal[]): Decimal =>
  values.reduce((acc, value) => acc.plus(value), new Decimal(0));

/** 30 000 + 30 000 + 40 000 = 100 000 USDC, soit 0.3 / 0.3 / 0.4. */
const HOLDINGS: Holdings = { BTC: qty('0.5'), ETH: qty('10'), USDC: qty('40000') };
const PRICES: Prices = { BTC: price('60000'), ETH: price('3000') };

const EMPTY: Holdings = { BTC: qty('0'), ETH: qty('0'), USDC: qty('0') };

describe('exposition et valeur totale', () => {
  it('valorise chaque ligne en USDC, USDC a son propre prix de 1', () => {
    const exposure = exposureOf(HOLDINGS, PRICES);

    expect(exposure.BTC.toString()).toBe('30000');
    expect(exposure.ETH.toString()).toBe('30000');
    expect(exposure.USDC.toString()).toBe('40000');
  });

  it('somme les expositions en valeur totale', () => {
    expect(totalValue(HOLDINGS, PRICES).toString()).toBe('100000');
  });

  it('vaut 0 sur un portefeuille vide, sans NaN ni exception', () => {
    const total = totalValue(EMPTY, PRICES);

    expect(total.isNaN()).toBe(false);
    expect(total.isZero()).toBe(true);
  });
});

describe('poids', () => {
  it('rapporte chaque exposition a la valeur totale', () => {
    const valuation = valuate(HOLDINGS, PRICES);
    if (valuation.status !== 'VALUED') throw new Error(`attendu VALUED, recu ${valuation.status}`);

    expect(valuation.total.toString()).toBe('100000');
    expect(valuation.weights.BTC.toString()).toBe('0.3');
    expect(valuation.weights.ETH.toString()).toBe('0.3');
    expect(valuation.weights.USDC.toString()).toBe('0.4');
  });

  it('C4 - la somme des poids vaut 1 a 1e-8 pres sur des soldes et prix aleatoires', () => {
    /*
     * Les grandeurs sont tirees en entiers puis composees en chaine : passer par
     * un flottant JavaScript introduirait dans le tirage l'imprecision que ce
     * test est cense mesurer sur le calcul.
     */
    const quantityArb = fc
      .tuple(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 99_999_999 }))
      .map(([units, frac]) => qty(`${units}.${String(frac).padStart(8, '0')}`));

    const priceArb = fc
      .tuple(fc.integer({ min: 1, max: 200_000 }), fc.integer({ min: 0, max: 99 }))
      .map(([units, cents]) => price(`${units}.${String(cents).padStart(2, '0')}`));

    fc.assert(
      fc.property(
        fc.record({ BTC: quantityArb, ETH: quantityArb, USDC: quantityArb }),
        fc.record({ BTC: priceArb, ETH: priceArb }),
        (holdings: Holdings, prices: Prices) => {
          const valuation = valuate(holdings, prices);

          // Le seul cas ou aucun poids n'existe : tous les soldes tires a zero.
          if (valuation.status === 'REJECTED') {
            expect(valuation.code).toBe('NON_POSITIVE_VALUE');
            expect(totalValue(holdings, prices).isZero()).toBe(true);
            return;
          }

          const weights = ASSETS.map((asset) => valuation.weights[asset]);
          for (const weight of weights) {
            expect(weight.isNaN()).toBe(false);
            expect(weight.gte(0) && weight.lte(1)).toBe(true);
          }

          expect(sumOf(weights).minus(1).abs().lte(TOLERANCE)).toBe(true);
          expect(sumOf(ASSETS.map((asset) => valuation.exposure[asset])).toString()).toBe(
            valuation.total.toString(),
          );
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('C4 - trois lignes egales : la somme manque 1 de quelques ulps et on ne la corrige pas', () => {
    const third: Holdings = { BTC: qty('1'), ETH: qty('1'), USDC: qty('1') };
    const valuation = valuate(third, { BTC: price('1'), ETH: price('1') });
    if (valuation.status !== 'VALUED') throw new Error(`attendu VALUED, recu ${valuation.status}`);

    /*
     * Chaque poids est calcule pour lui-meme. Deduire le dernier des deux autres
     * donnerait 0.33333333333333333334 et une somme exacte de 1 : l'identite
     * comptable serait vraie meme si la valorisation etait fausse.
     */
    for (const asset of ASSETS) {
      expect(valuation.weights[asset].toString()).toBe('0.33333333333333333333');
    }

    const total = sumOf(ASSETS.map((asset) => valuation.weights[asset]));
    expect(total.equals(1)).toBe(false);
    expect(total.minus(1).abs().lte(TOLERANCE)).toBe(true);
  });
});

describe('C5 - valeur totale nulle', () => {
  it('rejette explicitement au lieu de diviser par zero', () => {
    const valuation = valuate(EMPTY, PRICES);

    expect(valuation.status).toBe('REJECTED');
    if (valuation.status !== 'REJECTED') return;
    expect(valuation.code).toBe('NON_POSITIVE_VALUE');
    expect(valuation.reason).toContain('0');
  });

  it('rejette aussi une valeur totale negative', () => {
    const short: Holdings = { BTC: qty('0'), ETH: qty('0'), USDC: qty('-1000') };
    const valuation = valuate(short, PRICES);

    expect(valuation.status).toBe('REJECTED');
    if (valuation.status !== 'REJECTED') return;
    expect(valuation.code).toBe('NON_POSITIVE_VALUE');
  });

  it('rejette une valeur non finie au lieu de propager NaN dans les poids', () => {
    const nan = valuate(HOLDINGS, { BTC: price('NaN'), ETH: price('3000') });
    const infinite = valuate(HOLDINGS, { BTC: price('Infinity'), ETH: price('3000') });

    expect(nan.status).toBe('REJECTED');
    if (nan.status !== 'REJECTED') return;
    expect(nan.code).toBe('NON_FINITE_VALUE');

    expect(infinite.status).toBe('REJECTED');
    if (infinite.status !== 'REJECTED') return;
    expect(infinite.code).toBe('NON_FINITE_VALUE');
  });
});
