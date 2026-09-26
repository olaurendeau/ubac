import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { CancelOutcome, CreateOrderBody, ExecutionPort } from '../../src/adapters/coinbase.js';
import type { OrderToRecord, PlacementToRecord, RecordOrderOutcome } from '../../src/adapters/db.js';
import type { Order, Price, Quantity } from '../../src/core/types.js';
import type { Execution } from '../../src/jobs/execute.js';
import { annuler, auCarnet, ExecutionError, placer } from '../../src/jobs/execute.js';

/**
 * Le port et la base sont des doubles qui journalisent **le debut et la fin**
 * de chaque appel dans un seul journal : l'ordre ecriture → placement se lit
 * directement, et un envoi en parallele se verrait.
 */
function executionDe(options: { rejete?: readonly string[]; dejaEcrits?: readonly string[] } = {}): {
  execution: Execution;
  journal: string[];
  lignes: Map<string, string>;
} {
  const journal: string[] = [];
  const lignes = new Map<string, string>((options.dejaEcrits ?? []).map((id) => [id, 'PENDING']));
  const port: ExecutionPort = {
    async placeOrder(order: Order) {
      journal.push(`debut ${order.clientOrderId}`);
      await Promise.resolve();
      journal.push(`fin ${order.clientOrderId}`);
      if (options.rejete?.includes(order.clientOrderId) === true) {
        return { kind: 'REJECTED', clientOrderId: order.clientOrderId, reason: 'INVALID_LIMIT_PRICE_POST_ONLY' };
      }
      return { kind: 'PLACED', exchangeId: `x-${order.clientOrderId}`, clientOrderId: order.clientOrderId };
    },
    async cancelOrders(ids: readonly string[]): Promise<readonly CancelOutcome[]> {
      journal.push(`annule ${ids.join(',')}`);
      return ids.map((exchangeId) => ({ kind: 'CANCELLED', exchangeId }));
    },
  };
  const db: Execution['db'] = {
    async recordOrder(input: OrderToRecord): Promise<RecordOrderOutcome> {
      const id = input.order.clientOrderId;
      if (lignes.has(id)) return { status: 'ALREADY_RECORDED' };
      await Promise.resolve();
      lignes.set(id, `PENDING ${input.decisionId}`);
      journal.push(`ecrit ${id}`);
      return { status: 'RECORDED' };
    },
    async recordPlacement(input: PlacementToRecord): Promise<void> {
      lignes.set(input.clientOrderId, input.kind === 'PLACED' ? `PENDING ${input.exchangeId}` : 'REJECTED');
      journal.push(`issue ${input.clientOrderId} ${input.kind}`);
    },
  };
  return { execution: { port, db }, journal, lignes };
}

function ordre(clientOrderId: string, side: Order['side'] = 'SELL'): Order {
  return {
    clientOrderId,
    asset: 'ETH',
    quote: 'USDC',
    side,
    quantity: new Decimal('0.5') as Quantity,
    limitPrice: new Decimal('3000') as Price,
  };
}

const LOT = { decisionId: 'decision-1', createdAt: new Date('2026-10-01T07:00:00.000Z') };

describe('execute — ecrire avant de placer (E23)', () => {
  it('ecrit chaque ordre en PENDING, puis le place, puis son issue, un par un', async () => {
    const { execution, journal, lignes } = executionDe();
    const issues = await placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b')] });
    expect(journal).toEqual([
      'ecrit a', 'debut a', 'fin a', 'issue a PLACED',
      'ecrit b', 'debut b', 'fin b', 'issue b PLACED',
    ]);
    expect(issues.map((issue) => issue.kind)).toEqual(['PLACED', 'PLACED']);
    expect(lignes.get('a')).toBe('PENDING x-a');
  });

  /*
   * La sonde de l'interruption. Le job meurt pendant l'ecriture : rien n'est
   * place. Il meurt pendant le placement : la ligne PENDING existe deja,
   * rattachee a sa decision, et c'est elle que la reconciliation rattrape.
   */
  it('un job interrompu a l’ecriture ne place rien', async () => {
    const { execution, journal } = executionDe();
    const mort = { ...execution, db: { ...execution.db, recordOrder: () => Promise.reject(new Error('job tue')) } };
    await expect(placer(mort, { ...LOT, ordres: [ordre('a')] })).rejects.toThrow('job tue');
    expect(journal).toEqual([]);
  });

  it('un job interrompu au placement laisse la ligne PENDING de sa decision', async () => {
    const { execution, lignes } = executionDe();
    const mort = { ...execution, port: { ...execution.port, placeOrder: () => Promise.reject(new Error('job tue')) } };
    await expect(placer(mort, { ...LOT, ordres: [ordre('a')] })).rejects.toThrow('job tue');
    expect(lignes.get('a')).toBe('PENDING decision-1');
  });
});

describe('execute — un rejet est une issue, et rien n’est replace (§7, E26)', () => {
  it('ecrit le rejet post-only et passe a la jambe suivante, sans rien replacer', async () => {
    const { execution, journal, lignes } = executionDe({ rejete: ['a'] });
    const issues = await placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b')] });
    expect(issues).toEqual([
      { kind: 'REJECTED', clientOrderId: 'a', reason: 'INVALID_LIMIT_PRICE_POST_ONLY' },
      { kind: 'PLACED', exchangeId: 'x-b', clientOrderId: 'b' },
    ]);
    expect(lignes.get('a')).toBe('REJECTED');
    expect(journal.filter((l) => l.startsWith('debut'))).toEqual(['debut a', 'debut b']);
  });
});

describe('execute — la cle primaire d’orders, seconde ligne de defense d’E24', () => {
  it('ne place pas un ordre dont la ligne existe deja', async () => {
    const { execution, journal } = executionDe({ dejaEcrits: ['a'] });
    const issues = await placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b')] });
    expect(issues[0]).toEqual({ kind: 'ALREADY_RECORDED', clientOrderId: 'a' });
    expect(journal.filter((l) => l.startsWith('debut'))).toEqual(['debut b']);
  });

  it('refuse un lot ou un client_order_id revient, avant toute ecriture', async () => {
    const { execution, journal } = executionDe();
    await expect(placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b'), ordre('a')] })).rejects.toThrow(
      ExecutionError,
    );
    expect(journal).toEqual([]);
  });
});

describe('auCarnet — mid ± 0,1 %, du cote qui ne croise pas (E20)', () => {
  const MIDS = { ETH: new Decimal('3000') as Price, BTC: new Decimal('64321.09') as Price };

  it('achete sous le mid et vend au-dessus : le signe, pas seulement l’ecart', () => {
    const achat = auCarnet(ordre('a', 'BUY'), MIDS);
    const vente = auCarnet(ordre('b', 'SELL'), MIDS);
    expect(achat.limitPrice.lt(MIDS.ETH)).toBe(true);
    expect(vente.limitPrice.gt(MIDS.ETH)).toBe(true);
    expect(achat.limitPrice.toFixed()).toBe('2997');
    expect(vente.limitPrice.toFixed()).toBe('3003');
  });

  it('arrondit au pas en s’eloignant du mid, et la quantite vers le bas', () => {
    const btc = { ...ordre('a', 'BUY'), asset: 'BTC' as const, quantity: new Decimal('0.123456789') as Quantity };
    expect(auCarnet(btc, MIDS).limitPrice.toFixed()).toBe('64256.76');
    expect(auCarnet({ ...btc, side: 'SELL' }, MIDS).limitPrice.toFixed()).toBe('64385.42');
    expect(auCarnet(btc, MIDS).quantity.toFixed()).toBe('0.12345678');
  });

  it('refuse un ordre sans mid exploitable', () => {
    expect(() => auCarnet(ordre('a'), { BTC: MIDS.BTC })).toThrow(ExecutionError);
    expect(() => auCarnet(ordre('a'), { ETH: new Decimal(0) as Price })).toThrow(ExecutionError);
  });
});

describe('execute — les formes qui ne compilent pas (E19, E22)', () => {
  it('post_only: false et quote: EUR sont refuses par le type', () => {
    const corps: CreateOrderBody['order_configuration']['limit_limit_gtc'] = {
      base_size: '1',
      limit_price: '1',
      // @ts-expect-error §7 : un ordre qui pourrait croiser le carnet n'a pas de forme.
      post_only: false,
    };
    // @ts-expect-error §11 : la paire est en USDC, exclusivement.
    const enEuros: Order = { ...ordre('a'), quote: 'EUR' };
    expect([corps, enEuros]).toHaveLength(2);
  });
});

describe('execute — annuler', () => {
  it('annule par identifiant et rend l’issue du port telle quelle', async () => {
    const { execution, journal } = executionDe();
    expect(await annuler(execution.port, ['e1', 'e2'])).toEqual([
      { kind: 'CANCELLED', exchangeId: 'e1' },
      { kind: 'CANCELLED', exchangeId: 'e2' },
    ]);
    expect(journal).toEqual(['annule e1,e2']);
  });
});
