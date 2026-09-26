import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { KnownOrderStatus, OrderStatus } from '../../src/adapters/coinbase.js';
import type { Order, Price, Quantity, UsdcAmount } from '../../src/core/types.js';
import { engage, etatDe, fraisReels, refusPostOnly, suivre } from '../../src/jobs/suivi.js';

/**
 * Ce que le run apprend de ses ordres apres l'etape 6 (E27, E28). Aucun reseau :
 * la lecture du statut est un double, et c'est `coinbase.test.ts` qui eprouve la
 * vraie contre des reponses capturees.
 */

function ordre(clientOrderId: string): Order {
  return {
    clientOrderId,
    asset: 'ETH',
    quote: 'USDC',
    side: 'SELL',
    quantity: new Decimal('0.5') as Quantity,
    limitPrice: new Decimal('3000.01') as Price,
  };
}

const connu = (kind: KnownOrderStatus['kind'], filled: string, fees = '0'): OrderStatus => ({
  kind,
  exchangeId: 'x',
  clientOrderId: 'a',
  filled: new Decimal(filled) as Quantity,
  averageFilledPrice: null,
  fees: new Decimal(fees) as UsdcAmount,
});

describe('les quatre etats d’un ordre place', () => {
  it.each([
    ['FILLED', '0.5', 'EXECUTE'],
    ['OPEN', '0', 'NON_EXECUTE'],
    ['OPEN', '0.1', 'PARTIEL'],
    ['CANCELLED', '0.1', 'PARTIEL'],
    ['EXPIRED', '0', 'NON_EXECUTE'],
    ['FAILED', '0', 'NON_EXECUTE'],
  ] as const)('%s rempli de %s vaut %s', (kind, filled, etat) => {
    expect(etatDe(connu(kind, filled))).toBe(etat);
  });

  it('un statut indeterminable n’est replie sur aucun des trois autres', () => {
    expect(etatDe({ kind: 'INDETERMINABLE', reason: 'inconnu' })).toBe('NON_LU');
  });
});

describe('le refus post-only, et lui seul, se tait', () => {
  it.each([
    'INVALID_LIMIT_PRICE_POST_ONLY',
    'INVALID_LIMIT_PRICE_POST_ONLY / PREVIEW_INVALID_LIMIT_PRICE_POST_ONLY',
    'UNKNOWN_FAILURE_REASON / PREVIEW_INVALID_LIMIT_PRICE_POST_ONLY',
  ])('%s est post-only', (reason) => {
    expect(refusPostOnly(reason)).toBe(true);
  });

  it.each([
    'INSUFFICIENT_FUND',
    'UNKNOWN_FAILURE_REASON',
    'INSUFFICIENT_FUND / PREVIEW_INVALID_LIMIT_PRICE_POST_ONLY',
    /* Egalite exacte : un code inconnu qui contient POST_ONLY alerte plutot que d'etre tu. */
    'POST_ONLY_MODE_ENABLED',
  ])('%s ne l’est pas', (reason) => {
    expect(refusPostOnly(reason)).toBe(false);
  });
});

describe('suivre — lire sans jamais faire echouer le run', () => {
  const ordres = [ordre('a'), ordre('b'), ordre('c'), ordre('d')];
  const issues = [
    { kind: 'PLACED', exchangeId: 'x-a', clientOrderId: 'a' },
    { kind: 'PLACED', exchangeId: 'x-b', clientOrderId: 'b' },
    { kind: 'REJECTED', clientOrderId: 'c', reason: 'INSUFFICIENT_FUND' },
    { kind: 'ALREADY_RECORDED', clientOrderId: 'd' },
  ] as const;

  it('classe chaque ordre place, garde les refus a part, et ne compte pas un ordre deja ecrit', async () => {
    const lus: string[] = [];
    const lignes: string[] = [];
    const exchange = {
      orderStatus: (id: string): Promise<OrderStatus> => {
        lus.push(id);
        return id === 'x-a' ? Promise.resolve(connu('FILLED', '0.5', '1.5')) : Promise.reject(new Error('reseau'));
      },
    };
    const suivi = await suivre(exchange, 'rebalance', ordres, issues, (l) => lignes.push(l));

    expect(lus).toEqual(['x-a', 'x-b']);
    expect(suivi.ordres.map((o) => [o.order.clientOrderId, o.etat])).toEqual([['a', 'EXECUTE'], ['b', 'NON_LU']]);
    expect(suivi.rejets).toEqual([{ order: ordres[2], reason: 'INSUFFICIENT_FUND', postOnly: false }]);
    expect(lignes).toEqual(['b : statut non lu — reseau']);
    /* Les frais d'un ordre non lu sont inconnus, pas nuls : ils n'entrent pas dans la somme. */
    expect(suivi.ordres[1]?.fees).toBeNull();
    expect(fraisReels(suivi).toFixed()).toBe('1.5');
    expect(engage(suivi).toFixed()).toBe('3000.01');
  });
});
