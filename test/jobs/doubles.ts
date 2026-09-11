import { Decimal } from 'decimal.js';

import type { AssetBalance, OpenOrder, PortfolioBalances } from '../../src/adapters/coinbase.js';
import type { PendingOrderRecord, SnapshotRecord } from '../../src/adapters/db.js';
import type { ReconcileInput } from '../../src/jobs/reconcile.js';
import type { Price, Quantity, UsdcAmount, Weight, Weights } from '../../src/core/types.js';

/**
 * Les doubles de la reconciliation. **Aucun reseau, aucune cle, aucune base** :
 * les deux imports d'adapters ci-dessus sont des `import type`, donc effaces a
 * la compilation — ni `ccxt` ni `pg` n'est charge quand ces tests tournent.
 *
 * Les doubles enregistrent l'ordre des appels : le §7 impose de lire avant de
 * comparer, et cet ordre est une propriete testable, pas une intention.
 */

export const PORTFOLIO = '00000000-0000-4000-8000-000000000001';

export function qty(value: string): Quantity {
  return new Decimal(value) as Quantity;
}

export function solde(currency: string, available: string, hold = '0'): AssetBalance {
  const dispo = new Decimal(available);
  const gele = new Decimal(hold);
  return {
    currency,
    available: dispo as Quantity,
    hold: gele as Quantity,
    total: dispo.add(gele) as Quantity,
  };
}

export function ordreOuvert(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    exchangeId: 'exch-1',
    clientOrderId: 'coid-1',
    product: 'BTC-USDC',
    asset: 'BTC',
    side: 'BUY',
    quantity: qty('0.5'),
    limitPrice: new Decimal('60000') as Price,
    filled: qty('0'),
    createdAt: new Date('2026-09-10T07:00:00.000Z'),
    ...overrides,
  };
}

export function ordreEnAttente(overrides: Partial<PendingOrderRecord> = {}): PendingOrderRecord {
  return {
    clientOrderId: 'coid-1',
    decisionId: null,
    exchangeId: 'exch-1',
    side: 'BUY',
    asset: 'BTC',
    requestedQty: qty('0.5'),
    limitPrice: new Decimal('60000') as Price,
    createdAt: new Date('2026-09-10T07:00:00.000Z'),
    ...overrides,
  };
}

const POIDS_NEUTRES: Weights = {
  BTC: new Decimal('0.4') as Weight,
  ETH: new Decimal('0.4') as Weight,
  USDC: new Decimal('0.2') as Weight,
};

/** Le cache interne : seules `positions` comptent pour la reconciliation. */
export function photo(positions: Readonly<Record<string, Quantity>>): SnapshotRecord {
  return {
    runDate: '2026-09-10',
    totalValueUsdc: new Decimal('130000') as UsdcAmount,
    weights: POIDS_NEUTRES,
    positions,
    benchmarks: {},
    createdAt: new Date('2026-09-10T07:00:00.000Z'),
  };
}

export interface Scenario {
  readonly balances?: readonly AssetBalance[];
  readonly open?: readonly OpenOrder[];
  readonly pending?: readonly PendingOrderRecord[];
  readonly snapshot?: SnapshotRecord | undefined;
}

export interface Harnais {
  readonly input: ReconcileInput;
  /** Les appels dans leur ordre reel. */
  readonly appels: readonly string[];
}

export function harnais(scenario: Scenario = {}): Harnais {
  const appels: string[] = [];
  const portfolio: PortfolioBalances = {
    portfolioUuid: PORTFOLIO,
    balances: scenario.balances ?? [],
  };
  return {
    appels,
    input: {
      exchange: {
        balances: () => {
          appels.push('balances');
          return Promise.resolve(portfolio);
        },
        openOrders: () => {
          appels.push('openOrders');
          return Promise.resolve(scenario.open ?? []);
        },
      },
      db: {
        pendingOrders: () => {
          appels.push('pendingOrders');
          return Promise.resolve(scenario.pending ?? []);
        },
        latestSnapshot: () => {
          appels.push('latestSnapshot');
          return Promise.resolve(scenario.snapshot);
        },
      },
    },
  };
}
