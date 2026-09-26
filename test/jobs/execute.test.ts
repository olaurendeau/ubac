import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { CancelOutcome, ExecutionPort } from '../../src/adapters/coinbase.js';
import type { Order, Price, Quantity } from '../../src/core/types.js';
import { annuler, ExecutionError, placer } from '../../src/jobs/execute.js';

/**
 * `execute.ts` n'a pas d'appelant a la fin du lot S4 : ces tests sont les seuls
 * a le faire tourner. Le port est un double qui journalise **le debut et la fin**
 * de chaque placement, pour qu'un envoi en parallele se voie.
 */
function portDe(): { port: ExecutionPort; journal: string[] } {
  const journal: string[] = [];
  return {
    journal,
    port: {
      async placeOrder(order: Order) {
        journal.push(`debut ${order.clientOrderId}`);
        await Promise.resolve();
        journal.push(`fin ${order.clientOrderId}`);
        return { kind: 'PLACED' as const, exchangeId: `x-${order.clientOrderId}`, clientOrderId: order.clientOrderId };
      },
      async cancelOrders(ids: readonly string[]): Promise<readonly CancelOutcome[]> {
        journal.push(`annule ${ids.join(',')}`);
        return ids.map((exchangeId) => ({ kind: 'CANCELLED', exchangeId }));
      },
    },
  };
}

function ordre(clientOrderId: string): Order {
  return {
    clientOrderId,
    asset: 'ETH',
    quote: 'USDC',
    side: 'SELL',
    quantity: new Decimal('0.5') as Quantity,
    limitPrice: new Decimal('3000.30') as Price,
  };
}

describe('execute — le seul module de jobs/ qui ecrit sur l’exchange', () => {
  it('place un par un, dans l’ordre recu', async () => {
    const { port, journal } = portDe();
    const places = await placer(port, [ordre('a'), ordre('b')]);
    expect(journal).toEqual(['debut a', 'fin a', 'debut b', 'fin b']);
    expect(places.map((p) => (p.kind === 'PLACED' ? p.exchangeId : p.kind))).toEqual(['x-a', 'x-b']);
  });

  it('refuse un lot ou un client_order_id revient, avant tout envoi', async () => {
    const { port, journal } = portDe();
    await expect(placer(port, [ordre('a'), ordre('b'), ordre('a')])).rejects.toThrow(ExecutionError);
    expect(journal).toEqual([]);
  });

  it('annule par identifiant et rend l’issue du port telle quelle', async () => {
    const { port, journal } = portDe();
    expect(await annuler(port, ['e1', 'e2'])).toEqual([
      { kind: 'CANCELLED', exchangeId: 'e1' },
      { kind: 'CANCELLED', exchangeId: 'e2' },
    ]);
    expect(journal).toEqual(['annule e1,e2']);
  });
});
