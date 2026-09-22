import { describe, expect, it } from 'vitest';

import { clientOrderId, exitClientOrderId, type OrderIdParts } from '../../src/core/order-id.js';

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

  /**
   * Le domaine de la sortie s'ajoute a cote de celui du run quotidien, sans le
   * toucher. Une seule valeur figee laisserait passer un changement d'encodage
   * qui epargnerait la reference — celui d'un `legIndex` non nul, par exemple.
   * Ces valeurs ont ete calculees sur le module d'avant le domaine de sortie.
   */
  it.each<[OrderIdParts, string]>([
    [
      { runDate: '2026-09-12', asset: 'ETH', side: 'SELL', legIndex: 3 },
      'ubac-a3c802efa357b0380ec2401a613',
    ],
    [
      { runDate: '2026-12-31', asset: 'BTC', side: 'SELL', legIndex: 17 },
      'ubac-a3079a48c554aefb970b23ecde7',
    ],
  ])('fige aussi %o', (parts, attendu) => {
    expect(clientOrderId(parts)).toBe(attendu);
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

describe('exitClientOrderId, le domaine propre de la sortie (E45)', () => {
  /**
   * La sonde d'E45. Elle garde le **meme** `legIndex` des deux cotes : avec le
   * decalage a 900 qui tenait lieu de domaine, deux identifiants differaient deja
   * parce que le numero de jambe differait, donc une sonde a numeros distincts
   * passait avant comme apres. Seule cette redaction distingue les deux.
   */
  it('une sortie et un run quotidien de la meme jambe ont deux identifiants', () => {
    const jambe: OrderIdParts = { runDate: '2026-09-12', asset: 'BTC', side: 'SELL', legIndex: 0 };
    expect(exitClientOrderId(jambe)).not.toBe(clientOrderId(jambe));
  });

  it('les deux espaces sont disjoints, et chacun reste injectif', () => {
    const quotidien = new Set<string>();
    const sortie = new Set<string>();
    let quadruplets = 0;

    for (const runDate of ['2026-09-10', '2026-09-11']) {
      for (const asset of ['BTC', 'ETH', 'USDC'] as const) {
        for (const side of ['BUY', 'SELL'] as const) {
          for (let legIndex = 0; legIndex < 4; legIndex += 1) {
            quotidien.add(clientOrderId({ runDate, asset, side, legIndex }));
            sortie.add(exitClientOrderId({ runDate, asset, side, legIndex }));
            quadruplets += 1;
          }
        }
      }
    }

    expect([quotidien.size, sortie.size]).toEqual([quadruplets, quadruplets]);
    expect([...sortie].filter((id) => quotidien.has(id))).toEqual([]);
  });

  /** Meme raison que pour le run quotidien : la sortie se rejoue d'un deploiement a l'autre. */
  it('fige la valeur attendue de la reference', () => {
    expect(exitClientOrderId(REFERENCE)).toBe('ubac-7705e63a5acded9c1bcc2dd62e4');
  });

  it('garde la forme de l’identifiant du run quotidien', () => {
    expect(exitClientOrderId(REFERENCE)).toMatch(/^ubac-[0-9a-f]{27}$/);
  });
});

describe('entrees refusees, dans les deux domaines', () => {
  // NaN se serialiserait en "NaN" et donnerait le meme identifiant a deux jambes
  // differentes : precisement la collision que le module doit rendre impossible.
  describe.each([
    ['clientOrderId', clientOrderId],
    ['exitClientOrderId', exitClientOrderId],
  ])('%s', (_nom, derive) => {
    it.each([
      ['NaN', Number.NaN],
      ['negatif', -1],
      ['fractionnaire', 1.5],
      ['infini', Number.POSITIVE_INFINITY],
    ])('refuse un leg_index %s', (_label, legIndex) => {
      expect(() => derive({ ...REFERENCE, legIndex })).toThrow(RangeError);
    });
  });
});
