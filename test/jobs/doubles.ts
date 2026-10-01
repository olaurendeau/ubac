import { Decimal } from 'decimal.js';

import type {
  AssetBalance,
  KnownOrderStatus,
  OpenOrder,
  OrderStatus,
  PortfolioBalances,
} from '../../src/adapters/coinbase.js';
import type { PendingOrderRecord, SnapshotRecord } from '../../src/adapters/db.js';
import type { ReconcileInput } from '../../src/jobs/reconcile.js';
import type { IsoDate, Price, Quantity, UsdcAmount, Weight, Weights } from '../../src/core/types.js';

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
    runDate: null,
    exchangeId: 'exch-1',
    side: 'BUY',
    asset: 'BTC',
    requestedQty: qty('0.5'),
    limitPrice: new Decimal('60000') as Price,
    createdAt: new Date('2026-09-10T07:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Ce que l'exchange dit d'un ordre qu'il connait. Des grandeurs a huit decimales
 * que `numeric(20,8)` porte telles quelles et qu'un flottant ne rendrait pas :
 * `0.1 + 0.2` n'y survivrait pas plus que ces frais.
 */
export function statutConnu(overrides: Partial<KnownOrderStatus> = {}): KnownOrderStatus {
  return {
    kind: 'FILLED',
    exchangeId: 'exch-1',
    clientOrderId: 'coid-1',
    filled: qty('0.5'),
    averageFilledPrice: new Decimal('60000.12345678') as Price,
    fees: new Decimal('75.00015432') as UsdcAmount,
    ...overrides,
  };
}

/** L'instant du run par defaut : le lendemain des ordres fabriques ci-dessus, a la meme heure. */
export const MAINTENANT = new Date('2026-09-11T07:00:00.000Z');
export const JOUR_DU_RUN: IsoDate = '2026-09-11';

const POIDS_NEUTRES: Weights = {
  BTC: new Decimal('0.4') as Weight,
  ETH: new Decimal('0.4') as Weight,
  USDC: new Decimal('0.2') as Weight,
};

/**
 * Le cache interne. Seules `positions` comptent pour la reconciliation ; les
 * surcharges servent au chainage du drawdown, qui lit la date, la valeur,
 * l'horodatage et l'indice porte.
 */
export function photo(
  positions: Readonly<Record<string, Quantity>>,
  overrides: Partial<SnapshotRecord> = {},
): SnapshotRecord {
  return {
    runDate: '2026-09-10',
    totalValueUsdc: new Decimal('130000') as UsdcAmount,
    weights: POIDS_NEUTRES,
    positions,
    benchmarks: {},
    createdAt: new Date('2026-09-10T07:00:00.000Z'),
    ...overrides,
  };
}

export interface Scenario {
  readonly balances?: readonly AssetBalance[];
  readonly open?: readonly OpenOrder[];
  readonly pending?: readonly PendingOrderRecord[];
  readonly snapshot?: SnapshotRecord | undefined;
  /**
   * Ce que `orderStatus` rend, par identifiant d'exchange ; une `Error` y est
   * levee. Sans entree : l'ordre ouvert qui porte cet identifiant, vu par sa
   * propre lecture, et `INDETERMINABLE` pour un identifiant que rien ne porte.
   */
  readonly statuts?: Readonly<Record<string, OrderStatus | Error>>;
  readonly now?: Date;
  /** Le jour du run ; par defaut celui de `MAINTENANT`. */
  readonly runDate?: IsoDate;
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
        orderStatus: (exchangeId) => {
          appels.push('orderStatus');
          const prevu = scenario.statuts?.[exchangeId];
          if (prevu instanceof Error) return Promise.reject(prevu);
          if (prevu !== undefined) return Promise.resolve(prevu);
          const ouvert = scenario.open?.find((ordre) => ordre.exchangeId === exchangeId);
          if (ouvert === undefined) {
            return Promise.resolve({ kind: 'INDETERMINABLE', reason: `${exchangeId} inconnu de l'exchange` });
          }
          return Promise.resolve(
            statutConnu({
              kind: 'OPEN',
              exchangeId,
              clientOrderId: ouvert.clientOrderId,
              filled: ouvert.filled,
              averageFilledPrice: ouvert.filled.isZero() ? null : ouvert.limitPrice,
              fees: new Decimal(0) as UsdcAmount,
            }),
          );
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
      now: scenario.now ?? MAINTENANT,
      runDate: scenario.runDate ?? JOUR_DU_RUN,
    },
  };
}
