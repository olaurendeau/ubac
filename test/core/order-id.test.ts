import { describe, expect, it } from 'vitest';

import { clientOrderId, type OrderIdParts } from '../../src/core/order-id.js';

/**
 * C24 : `client_order_id` est stable pour un `(run_date, asset, side,
 * leg_index)` donne, et differe des que l'une des quatre composantes change.
 */

const REFERENCE: OrderIdParts = {
  runDate: '2026-09-10',
  asset: 'BTC',
  side: 'BUY',
  legIndex: 0,
};

function withChange(change: Partial<OrderIdParts>): string {
  return clientOrderId({ ...REFERENCE, ...change });
}

describe('clientOrderId, stabilite', () => {
  it('rend le meme identifiant pour le meme quadruplet', () => {
    expect(clientOrderId(REFERENCE)).toBe(clientOrderId({ ...REFERENCE }));
  });

  /**
   * Le test ci-dessus ne prouve que la stabilite a l'interieur d'un processus,
   * ce qui ne protege de rien : le doublon se joue entre deux deploiements. La
   * valeur est donc figee ici. Si ce test casse, l'encodage a change et tous les
   * ordres deja passes ont perdu leur protection contre le rejeu — c'est une
   * decision a prendre, pas une valeur a reactualiser.
   */
  it('fige la valeur attendue de la reference', () => {
    expect(clientOrderId(REFERENCE)).toBe('ubac-2ee322105c1054837d490f1a8d8');
  });

  it('produit un identifiant de forme constante', () => {
    const id = clientOrderId(REFERENCE);
    expect(id).toMatch(/^ubac-[0-9a-f]{27}$/);
    expect(id).toHaveLength(32);
  });
});

describe('clientOrderId, divergence composante par composante', () => {
  it('diverge sur run_date', () => {
    expect(withChange({ runDate: '2026-09-11' })).not.toBe(clientOrderId(REFERENCE));
  });

  it('diverge sur asset', () => {
    expect(withChange({ asset: 'ETH' })).not.toBe(clientOrderId(REFERENCE));
  });

  it('diverge sur side', () => {
    expect(withChange({ side: 'SELL' })).not.toBe(clientOrderId(REFERENCE));
  });

  it('diverge sur leg_index', () => {
    expect(withChange({ legIndex: 1 })).not.toBe(clientOrderId(REFERENCE));
  });

  /**
   * Les quatre tests precedents montrent qu'un changement isole diverge sur un
   * point. Ils ne disent rien des collisions croisees, ou deux quadruplets
   * differents sur deux composantes se rejoignent. Le balayage les couvre.
   */
  it('ne donne jamais le meme identifiant a deux jambes distinctes', () => {
    const ids = new Set<string>();
    let quadruplets = 0;

    for (const runDate of ['2026-09-10', '2026-09-11', '2026-10-09']) {
      for (const asset of ['BTC', 'ETH', 'USDC'] as const) {
        for (const side of ['BUY', 'SELL'] as const) {
          for (let legIndex = 0; legIndex < 4; legIndex += 1) {
            ids.add(clientOrderId({ runDate, asset, side, legIndex }));
            quadruplets += 1;
          }
        }
      }
    }

    expect(ids.size).toBe(quadruplets);
  });
});

describe('clientOrderId, entrees refusees', () => {
  // NaN se serialiserait en "NaN" et donnerait le meme identifiant a deux jambes
  // differentes : precisement la collision que le module doit rendre impossible.
  it.each([
    ['NaN', Number.NaN],
    ['negatif', -1],
    ['fractionnaire', 1.5],
    ['infini', Number.POSITIVE_INFINITY],
  ])('refuse un leg_index %s', (_label, legIndex) => {
    expect(() => clientOrderId({ ...REFERENCE, legIndex })).toThrow(RangeError);
  });
});
