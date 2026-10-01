import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { CancelOutcome, CreateOrderBody, ExecutionPort, Fourchette, KnownOrderStatus } from '../../src/adapters/coinbase.js';
import type { OrderToRecord, PlacementToRecord, RecordOrderOutcome } from '../../src/adapters/db.js';
import type { Order, Price, Quantity, UsdcAmount } from '../../src/core/types.js';
import type { Annulation, Execution, IssueDeJambe } from '../../src/jobs/execute.js';
import { annuler, auCarnet, ExecutionError, placer } from '../../src/jobs/execute.js';
import { prixLimite } from '../../src/jobs/liquidate.js';

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
    const issues = await placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b')] }, []);
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
    await expect(placer(mort, { ...LOT, ordres: [ordre('a')] }, [])).rejects.toThrow('job tue');
    expect(journal).toEqual([]);
  });

  it('un job interrompu au placement laisse la ligne PENDING de sa decision', async () => {
    const { execution, lignes } = executionDe();
    const mort = { ...execution, port: { ...execution.port, placeOrder: () => Promise.reject(new Error('job tue')) } };
    await expect(placer(mort, { ...LOT, ordres: [ordre('a')] }, [])).rejects.toThrow('job tue');
    expect(lignes.get('a')).toBe('PENDING decision-1');
  });

  /*
   * L'exception remonte, mais ce qui est parti reste connu de l'appelant : la
   * premiere jambe, placee et ecrite, et la seconde, placee et non ecrite.
   */
  it('une issue non ecrite a la deuxieme jambe laisse les deux issues a l’appelant', async () => {
    const { execution } = executionDe();
    const mort = {
      ...execution,
      db: {
        ...execution.db,
        recordPlacement: (input: PlacementToRecord) =>
          input.clientOrderId === 'b' ? Promise.reject(new Error('job tue')) : execution.db.recordPlacement(input),
      },
    };
    const issues: IssueDeJambe[] = [];
    await expect(placer(mort, { ...LOT, ordres: [ordre('a'), ordre('b')] }, issues)).rejects.toThrow('job tue');
    expect(issues).toEqual([
      { kind: 'PLACED', exchangeId: 'x-a', clientOrderId: 'a' },
      { kind: 'PLACED', exchangeId: 'x-b', clientOrderId: 'b' },
    ]);
  });
});

describe('execute — un rejet est une issue, et rien n’est replace (§7, E26)', () => {
  it('ecrit le rejet post-only et passe a la jambe suivante, sans rien replacer', async () => {
    const { execution, journal, lignes } = executionDe({ rejete: ['a'] });
    const issues = await placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b')] }, []);
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
    const issues = await placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b')] }, []);
    expect(issues[0]).toEqual({ kind: 'ALREADY_RECORDED', clientOrderId: 'a' });
    expect(journal.filter((l) => l.startsWith('debut'))).toEqual(['debut b']);
  });

  it('refuse un lot ou un client_order_id revient, avant toute ecriture', async () => {
    const { execution, journal } = executionDe();
    await expect(placer(execution, { ...LOT, ordres: [ordre('a'), ordre('b'), ordre('a')] }, [])).rejects.toThrow(
      ExecutionError,
    );
    expect(journal).toEqual([]);
  });
});

describe('prixLimite — au meilleur cote du carnet, sans marge (D2, critere 5)', () => {
  const fourchette = (bid: string, ask: string): Fourchette => ({ bid: new Decimal(bid) as Price, ask: new Decimal(ask) as Price });

  it('achete au meilleur acheteur et vend au meilleur vendeur', () => {
    const carnet = fourchette('2604.11', '2604.12');
    expect(prixLimite('BUY', carnet).toFixed()).toBe('2604.11');
    expect(prixLimite('SELL', carnet).toFixed()).toBe('2604.12');
  });

  it('arrondit au centime en s’eloignant du mid : vers le bas a l’achat, vers le haut a la vente', () => {
    const carnet = fourchette('64321.0999', '64321.1001');
    expect(prixLimite('BUY', carnet).toFixed()).toBe('64321.09');
    expect(prixLimite('SELL', carnet).toFixed()).toBe('64321.11');
  });
});

describe('auCarnet — la quantite au pas, le prix intouche (D3)', () => {
  it('garde le prix valide et arrondit la quantite vers le bas', () => {
    const btc = { ...ordre('a', 'BUY'), asset: 'BTC' as const, quantity: new Decimal('0.123456789') as Quantity, limitPrice: new Decimal('64321.09') as Price };
    const parti = auCarnet(btc);
    expect(parti.limitPrice).toBe(btc.limitPrice);
    expect(parti.quantity.toFixed()).toBe('0.12345678');
    expect(auCarnet({ ...btc, side: 'SELL' }).quantity.toFixed()).toBe('0.12345678');
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

/**
 * Un exchange qui se souvient : un ordre annule l'est pour de bon, et une seconde
 * annulation est refusee comme Coinbase la refuse — `success: false`, avec un
 * motif. `fermes` : les ordres deja denoues ailleurs, rempli entre la lecture et
 * l'annulation ; `bloques` : ceux dont l'annulation est refusee et qui restent
 * ouverts.
 */
function exchangeAnnulant(options: { fermes?: readonly string[]; bloques?: readonly string[]; statutIllisible?: true } = {}): {
  annulation: Annulation;
  envois: string[][];
} {
  const etat = new Map<string, KnownOrderStatus['kind']>((options.fermes ?? []).map((id) => [id, 'FILLED']));
  const envois: string[][] = [];
  const port: ExecutionPort = {
    placeOrder: () => Promise.reject(new Error('aucun placement ici')),
    cancelOrders(ids: readonly string[]): Promise<readonly CancelOutcome[]> {
      envois.push([...ids]);
      return Promise.resolve(
        ids.map((exchangeId): CancelOutcome => {
          if (options.bloques?.includes(exchangeId) === true) {
            return { kind: 'REFUSED', exchangeId, reason: 'COMMANDER_REJECTED_CANCEL_ORDER' };
          }
          if (etat.has(exchangeId)) return { kind: 'REFUSED', exchangeId, reason: 'UNKNOWN_CANCEL_ORDER' };
          etat.set(exchangeId, 'CANCELLED');
          return { kind: 'CANCELLED', exchangeId };
        }),
      );
    },
  };
  return {
    envois,
    annulation: {
      port,
      exchange: {
        orderStatus: (exchangeId) =>
          options.statutIllisible === true
            ? Promise.reject(new Error('reseau coupe'))
            : Promise.resolve({
                kind: etat.get(exchangeId) ?? 'OPEN',
                exchangeId,
                clientOrderId: `c-${exchangeId}`,
                filled: new Decimal('0') as Quantity,
                averageFilledPrice: null,
                fees: new Decimal('0') as UsdcAmount,
              }),
      },
    },
  };
}

const intention = (exchangeId: string) => ({ clientOrderId: `c-${exchangeId}`, exchangeId, placedOn: '2026-09-10' });

describe('execute — annuler (§7 point 3, E36)', () => {
  /*
   * **La sonde d'E36.** La meme annulation, demandee deux fois de suite : la
   * seconde est refusee par l'exchange, et ce refus n'est pas une erreur — l'ordre
   * est deja denoue, ce que l'annulation voulait.
   */
  it('annuler deux fois de suite le meme ordre : la seconde fois est un deja-denoue, pas un echec', async () => {
    const { annulation, envois } = exchangeAnnulant();
    const premiere = await annuler(annulation, [intention('e1')]);
    const seconde = await annuler(annulation, [intention('e1')]);

    expect(premiere).toEqual([{ kind: 'ANNULE', clientOrderId: 'c-e1', exchangeId: 'e1' }]);
    expect(seconde).toEqual([
      { kind: 'DEJA_DENOUE', clientOrderId: 'c-e1', exchangeId: 'e1', reason: "UNKNOWN_CANCEL_ORDER ; l'ordre est CANCELLED" },
    ]);
    expect(envois).toEqual([['e1'], ['e1']]);
  });

  it('un lot rend une issue par ordre, dans l’ordre recu, sans rien replier', async () => {
    const { annulation, envois } = exchangeAnnulant({ fermes: ['e2'], bloques: ['e3'] });
    const issues = await annuler(annulation, [intention('e1'), intention('e2'), intention('e3')]);

    expect(envois).toEqual([['e1', 'e2', 'e3']]);
    expect(issues.map((issue) => [issue.exchangeId, issue.kind])).toEqual([
      ['e1', 'ANNULE'],
      ['e2', 'DEJA_DENOUE'],
      ['e3', 'ECHEC'],
    ]);
    expect(issues[2]?.kind === 'ECHEC' ? issues[2].reason : '').toContain('toujours ouvert');
  });

  it('un refus dont le statut ne se relit pas est un echec : l’ordre peut etre ouvert', async () => {
    const { annulation } = exchangeAnnulant({ bloques: ['e1'], statutIllisible: true });
    const [issue] = await annuler(annulation, [intention('e1')]);
    expect(issue?.kind).toBe('ECHEC');
  });

  it('un envoi qui leve rend chaque ordre en echec, sans lever', async () => {
    const { annulation } = exchangeAnnulant();
    const enPanne = { ...annulation, port: { ...annulation.port, cancelOrders: () => Promise.reject(new Error('503')) } };
    const issues = await annuler(enPanne, [intention('e1'), intention('e2')]);
    expect(issues.map((issue) => issue.kind)).toEqual(['ECHEC', 'ECHEC']);
  });

  it('rien a annuler n’appelle pas l’exchange', async () => {
    const { annulation, envois } = exchangeAnnulant();
    expect(await annuler(annulation, [])).toEqual([]);
    expect(envois).toEqual([]);
  });
});
