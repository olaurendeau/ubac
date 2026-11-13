import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Prices } from '../../src/core/portfolio.js';
import { decisionPricing } from '../../src/core/risk.js';
import type { DecisionPricing, MidPrices } from '../../src/core/risk.js';
import type { Price } from '../../src/core/types.js';

/*
 * D7 : sur quel prix dimensionner la decision de production. Les cas du
 * 2026-11-13 servent de repere : cloture BTC 71369.9 / ETH 2017.36, mids a
 * environ -4,6 % et -5,3 %.
 */
const price = (v: string): Price => new Decimal(v) as Price;
const CLOSES: Prices = { BTC: price('60000'), ETH: price('3000') };
const mids = (btc: string, eth: string): MidPrices => ({ BTC: price(btc), ETH: price(eth) });

function notRecomputed(result: DecisionPricing): string {
  if (result.status !== 'NOT_RECOMPUTED') {
    throw new Error(`NOT_RECOMPUTED attendu, recu ${result.status}`);
  }
  return result.reason;
}

describe('decisionPricing — CLOSE', () => {
  it('garde la cloture quand chaque mid est a 2 % ou moins', () => {
    expect(decisionPricing(CLOSES, mids('60000', '3000'))).toEqual({ status: 'CLOSE' });
    expect(decisionPricing(CLOSES, mids('61000', '2950'))).toEqual({ status: 'CLOSE' });
  });
  it('2 % pile reste CLOSE, des deux cotes', () => {
    expect(decisionPricing(CLOSES, mids('61200', '2940'))).toEqual({ status: 'CLOSE' });
    expect(decisionPricing(CLOSES, mids('58800', '3060'))).toEqual({ status: 'CLOSE' });
  });
  it('un mid absent ou invalide reste l\'affaire de validate quand l\'autre est proche', () => {
    expect(decisionPricing(CLOSES, { BTC: price('60500') })).toEqual({ status: 'CLOSE' });
    expect(decisionPricing(CLOSES, { ETH: price('3000') })).toEqual({ status: 'CLOSE' });
    expect(decisionPricing(CLOSES, {})).toEqual({ status: 'CLOSE' });
    expect(decisionPricing(CLOSES, mids('0', '3000'))).toEqual({ status: 'CLOSE' });
    expect(decisionPricing(CLOSES, mids('NaN', '-1'))).toEqual({ status: 'CLOSE' });
  });
});

describe('decisionPricing — LIVE', () => {
  it('recalcule sur les deux mids des qu\'un seul actif derive de plus de 2 %', () => {
    const result = decisionPricing(CLOSES, mids('61201', '3010'));
    expect(result.status).toBe('LIVE');
    if (result.status !== 'LIVE') return;
    expect(result.prices.BTC.toString()).toBe('61201');
    expect(result.prices.ETH.toString()).toBe('3010');
  });
  it('2,01 % bascule en LIVE, des deux cotes', () => {
    expect(decisionPricing(CLOSES, mids('61206', '3000')).status).toBe('LIVE');
    expect(decisionPricing(CLOSES, mids('60000', '2939.7')).status).toBe('LIVE');
  });
  it('rend les ecarts signes (mid - cloture) / cloture', () => {
    const result = decisionPricing(CLOSES, mids('57000', '3300'));
    expect(result.status).toBe('LIVE');
    if (result.status !== 'LIVE') return;
    expect(result.drifts.BTC.toString()).toBe('-0.05');
    expect(result.drifts.ETH.toString()).toBe('0.1');
  });
  it('le cas du 2026-11-13 : -4,6 % et -5,3 % se recalculent', () => {
    const closes: Prices = { BTC: price('71369.9'), ETH: price('2017.36') };
    const result = decisionPricing(closes, mids('68066', '1909.8'));
    expect(result.status).toBe('LIVE');
    if (result.status !== 'LIVE') return;
    expect(result.drifts.BTC.lt(0) && result.drifts.BTC.gt('-0.05')).toBe(true);
    expect(result.drifts.ETH.lt('-0.05') && result.drifts.ETH.gt('-0.06')).toBe(true);
  });
  it('20 % pile reste LIVE, des deux cotes', () => {
    expect(decisionPricing(CLOSES, mids('72000', '2400')).status).toBe('LIVE');
    expect(decisionPricing(CLOSES, mids('48000', '3600')).status).toBe('LIVE');
  });
});

describe('decisionPricing — NOT_RECOMPUTED', () => {
  it('au-dela de 20 %, des deux cotes, avec la raison et l\'actif', () => {
    expect(notRecomputed(decisionPricing(CLOSES, mids('72006', '3000')))).toMatch(
      /plus de 20 % de la cloture sur BTC : carnet aberrant/,
    );
    expect(notRecomputed(decisionPricing(CLOSES, mids('60000', '2399')))).toMatch(
      /plus de 20 % de la cloture sur ETH/,
    );
    expect(notRecomputed(decisionPricing(CLOSES, mids('80000', '1000')))).toMatch(/sur BTC, ETH/);
  });
  it('un actif a plus de 20 % l\'emporte sur l\'autre qui n\'a derive que de 5 %', () => {
    expect(decisionPricing(CLOSES, mids('63000', '4000')).status).toBe('NOT_RECOMPUTED');
  });
  it('un ecart au-dela de 2 % avec un mid absent', () => {
    expect(notRecomputed(decisionPricing(CLOSES, { BTC: price('63000') }))).toMatch(
      /sur BTC mais mid ETH absent ou invalide/,
    );
    expect(notRecomputed(decisionPricing(CLOSES, { ETH: price('3300') }))).toMatch(
      /sur ETH mais mid BTC absent ou invalide/,
    );
  });
  it('un ecart au-dela de 2 % avec un mid nul, negatif ou non fini', () => {
    for (const invalide of ['0', '-5', 'NaN', 'Infinity']) {
      expect(notRecomputed(decisionPricing(CLOSES, mids('63000', invalide)))).toMatch(
        /mid ETH absent ou invalide/,
      );
    }
  });
  it('une cloture nulle, negative ou non finie, meme sans ecart', () => {
    for (const invalide of ['0', '-1', 'NaN', 'Infinity']) {
      expect(
        notRecomputed(decisionPricing({ BTC: price(invalide), ETH: price('3000') }, mids('60000', '3000'))),
      ).toMatch(/^cloture BTC a .* n'est comparable a rien$/);
      expect(
        notRecomputed(decisionPricing({ BTC: price('60000'), ETH: price(invalide) }, mids('60000', '3000'))),
      ).toMatch(/^cloture ETH a /);
    }
  });
});
