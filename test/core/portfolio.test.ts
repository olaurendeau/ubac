import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices, Valuation } from '../../src/core/portfolio.js';
import * as portfolio from '../../src/core/portfolio.js';
import { ASSETS, valuate } from '../../src/core/portfolio.js';
import type { Price, Quantity } from '../../src/core/types.js';

const qty = (value: string): Quantity => new Decimal(value) as Quantity;
const price = (value: string): Price => new Decimal(value) as Price;

/** Tolerance de C4. La somme des poids vaut 1 a 1e-8 pres, pas exactement 1. */
const TOLERANCE = new Decimal('1e-8');

const sumOf = (values: readonly Decimal[]): Decimal =>
  values.reduce((acc, value) => acc.plus(value), new Decimal(0));

/** Retrecit l'union sur la branche valorisee, en echouant au lieu de la sauter. */
function valued(valuation: Valuation): Extract<Valuation, { status: 'VALUED' }> {
  if (valuation.status !== 'VALUED') {
    throw new Error(`attendu VALUED, recu ${valuation.status} (${valuation.code})`);
  }
  return valuation;
}

function rejected(valuation: Valuation): Extract<Valuation, { status: 'REJECTED' }> {
  if (valuation.status !== 'REJECTED') throw new Error('attendu REJECTED, recu VALUED');
  return valuation;
}

/** 30 000 + 30 000 + 40 000 = 100 000 USDC, soit 0.3 / 0.3 / 0.4. */
const HOLDINGS: Holdings = { BTC: qty('0.5'), ETH: qty('10'), USDC: qty('40000') };
const PRICES: Prices = { BTC: price('60000'), ETH: price('3000') };

const EMPTY: Holdings = { BTC: qty('0'), ETH: qty('0'), USDC: qty('0') };

describe('surface publique', () => {
  /*
   * Le vrai correctif de cette etape n'est pas une ligne de code, c'est une
   * absence : `exposureOf` et `totalValue` ne sortent plus du module. Exportees,
   * elles rendaient une valeur non finie sans passer par le garde de `valuate`,
   * et un seuil compare a un NaN ne mord jamais (`Decimal.gte(NaN)` vaut false).
   * Aucun test de couverture ne detecte ce trou : la ligne de comparaison est
   * bien executee, elle repond juste toujours non. Le seul garde-fou possible
   * est de figer la surface, pour que la reexporter redevienne un acte conscient
   * qui casse un test.
   */
  it('n exporte aucun calcul de valeur en dehors de valuate', () => {
    expect(Object.keys(portfolio).sort()).toEqual(['ASSETS', 'valuate']);
  });
});

describe('exposition et valeur totale', () => {
  it('valorise chaque ligne en USDC, USDC a son propre prix de 1', () => {
    const { exposure } = valued(valuate(HOLDINGS, PRICES));

    expect(exposure.BTC.toString()).toBe('30000');
    expect(exposure.ETH.toString()).toBe('30000');
    expect(exposure.USDC.toString()).toBe('40000');
  });

  it('somme les expositions en valeur totale', () => {
    const { total, exposure } = valued(valuate(HOLDINGS, PRICES));

    expect(total.toString()).toBe('100000');
    expect(sumOf(ASSETS.map((asset) => exposure[asset])).toString()).toBe(total.toString());
  });
});

describe('poids', () => {
  it('rapporte chaque exposition a la valeur totale', () => {
    const { total, weights } = valued(valuate(HOLDINGS, PRICES));

    expect(total.toString()).toBe('100000');
    expect(weights.BTC.toString()).toBe('0.3');
    expect(weights.ETH.toString()).toBe('0.3');
    expect(weights.USDC.toString()).toBe('0.4');
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

          /*
           * Les quantites tirees sont positives ou nulles et les prix strictement
           * positifs : le seul rejet atteignable est le portefeuille tout a zero.
           * On le verifie sur les soldes eux-memes plutot que sur une valeur
           * totale recalculee, qui n'est plus observable de l'exterieur.
           */
          if (valuation.status === 'REJECTED') {
            expect(valuation.code).toBe('NON_POSITIVE_VALUE');
            expect(ASSETS.every((asset) => holdings[asset].isZero())).toBe(true);
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
    const { weights } = valued(valuate(third, { BTC: price('1'), ETH: price('1') }));

    /*
     * Chaque poids est calcule pour lui-meme. Deduire le dernier des deux autres
     * donnerait 0.33333333333333333334 et une somme exacte de 1 : l'identite
     * comptable serait vraie meme si la valorisation etait fausse.
     */
    for (const asset of ASSETS) {
      expect(weights[asset].toString()).toBe('0.33333333333333333333');
    }

    const total = sumOf(ASSETS.map((asset) => weights[asset]));
    expect(total.equals(1)).toBe(false);
    expect(total.minus(1).abs().lte(TOLERANCE)).toBe(true);
  });
});

describe('C5 - valeur totale nulle', () => {
  it('rejette explicitement au lieu de diviser par zero', () => {
    const valuation = rejected(valuate(EMPTY, PRICES));

    expect(valuation.code).toBe('NON_POSITIVE_VALUE');
    expect(valuation.reason).toContain('0');
  });

  it('rejette aussi une valeur totale negative', () => {
    const short: Holdings = { BTC: qty('0'), ETH: qty('0'), USDC: qty('-1000') };

    expect(rejected(valuate(short, PRICES)).code).toBe('NON_POSITIVE_VALUE');
  });
});

describe('valeur non finie', () => {
  it('rejette un prix NaN ou infini au lieu de propager NaN dans les poids', () => {
    const nan = rejected(valuate(HOLDINGS, { BTC: price('NaN'), ETH: price('3000') }));
    const infinite = rejected(valuate(HOLDINGS, { BTC: price('Infinity'), ETH: price('3000') }));

    expect(nan.code).toBe('NON_FINITE_VALUE');
    expect(infinite.code).toBe('NON_FINITE_VALUE');
  });

  it('rejette un solde NaN ou infini, pas seulement un prix', () => {
    const nanQty: Holdings = { ...HOLDINGS, ETH: qty('NaN') };
    const infiniteQty: Holdings = { ...HOLDINGS, ETH: qty('Infinity') };

    expect(rejected(valuate(nanQty, PRICES)).code).toBe('NON_FINITE_VALUE');
    expect(rejected(valuate(infiniteQty, PRICES)).code).toBe('NON_FINITE_VALUE');
  });

  it('rejette deux infinis de signes opposes, qui ne se compensent pas en un total fini', () => {
    /*
     * C'est ce cas qui justifie de ne garder qu'un seul controle, sur le total,
     * plutot qu'un controle par ligne : +Infinity et -Infinity ne s'annulent pas,
     * ils donnent NaN, donc un total non fini. Si decimal.js changeait cette
     * semantique, ce test tomberait et le controle unique deviendrait faux.
     */
    const opposed: Holdings = { BTC: qty('1'), ETH: qty('-1'), USDC: qty('0') };
    const valuation = rejected(
      valuate(opposed, { BTC: price('Infinity'), ETH: price('Infinity') }),
    );

    expect(valuation.code).toBe('NON_FINITE_VALUE');
    expect(valuation.reason).toContain('NaN');
  });

  it('ne laisse pas un total non fini franchir un seuil : c est la raison du garde', () => {
    /*
     * Reproduction directe du defaut signale en relecture. Un total NaN repond
     * false a `gte` comme a `lte` : le seuil de C15 MAX_EXPOSURE (50 % de la
     * valeur totale) et celui de C20 REBALANCE_TOO_LARGE (25 %) passeraient tous
     * les deux sans mordre. Le rejet en amont est la seule chose qui empeche ce
     * NaN d'atteindre E7.
     */
    const nanTotal = new Decimal('NaN');
    expect(nanTotal.gte(0)).toBe(false);
    expect(nanTotal.lte(0)).toBe(false);

    expect(rejected(valuate(HOLDINGS, { BTC: price('NaN'), ETH: price('3000') })).code).toBe(
      'NON_FINITE_VALUE',
    );
  });
});
