import { Decimal } from 'decimal.js';
import { boolean, customType, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { AllowedAsset, IsoDate } from '../core/types.js';

/**
 * Les quatre tables du §4 de la spec, et la frontiere de conversion qui les
 * borde. Ce module ne parle a personne : il decrit des colonnes et sait
 * traduire une valeur SQL en valeur du noyau, et l'inverse.
 *
 * Tout tient a une regle : **`numeric(20,8)` entre et sort en chaine.** Le
 * driver Postgres ne convertit pas les numeriques en `number`, et c'est
 * heureux — `0.1 + 0.2` ne vaut pas `0.3` en IEEE-754, et un huitieme de
 * satoshi perdu a chaque lecture finirait par ne plus reconcilier. La chaine
 * est convertie en `Decimal` ici, une fois, et jamais en flottant.
 *
 * Le sens inverse compte autant : ce qui part vers la base est serialise par
 * `Decimal.toFixed()`, qui ne passe par aucun flottant intermediaire. Un
 * `Number(valeur)` ou un `valeur.toNumber()` sur ce chemin serait invisible au
 * typage et fatal a l'arrondi.
 */

// --- Erreur de frontiere ----------------------------------------------------

/**
 * Une valeur de la base qui ne ressemble pas a ce que le schema promet. Ce
 * n'est pas une erreur applicative : c'est le signe que la base contient autre
 * chose que ce que ce fichier decrit, ou que le driver a ete reconfigure sous
 * nos pieds. Echouer bruyamment est la seule reponse — un `Decimal` construit
 * sur une valeur douteuse contamine tout ce qui le lit ensuite.
 */
export class DbFrontierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbFrontierError';
  }
}

// --- Decimal <-> texte SQL --------------------------------------------------

/**
 * Decimale litterale, sans exposant ni hexadecimal. Meme motif et meme raison
 * que dans `src/config/env.ts` : `decimal.js` accepte `NaN`, `Infinity` et
 * `0x10`, et Postgres sait **stocker** `'NaN'` dans une colonne `numeric`. Un
 * poids `NaN` relu depuis la base ne declencherait aucun seuil, puisque
 * `Decimal.gt` et `Decimal.lt` repondent tous les deux `false` dessus.
 *
 * Le motif est recopie plutot qu'importe : `src/config/env.ts` appartient au
 * lot Q1b et ne l'exporte pas. Les deux copies sont volontairement identiques.
 */
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Une chaine SQL en `Decimal`. Le seul chemin d'entree des grandeurs. */
export function decimalFromText(value: unknown, contexte: string): Decimal {
  if (typeof value !== 'string') {
    throw new DbFrontierError(
      `${contexte} : chaine attendue du driver, recu ${typeof value}. Une grandeur convertie en number par le driver a deja perdu sa precision.`,
    );
  }
  if (!DECIMAL_TEXT.test(value)) {
    throw new DbFrontierError(
      `${contexte} : decimale litterale attendue, recu "${value}". NaN, Infinity et l'exposant sont refuses ici, pas en aval.`,
    );
  }
  return new Decimal(value);
}

/**
 * Un `Decimal` en chaine SQL. `toFixed()` sans argument rend la notation
 * normale complete, jamais d'exposant : Postgres refuserait `1e-8` sur une
 * colonne `numeric`, et l'arrondi a 8 decimales est laisse a la colonne, qui
 * en est la definition. Une valeur au-dela de `numeric(20,8)` fait echouer
 * l'insertion cote base, ce qui est le comportement voulu.
 */
export function textFromDecimal(value: Decimal, contexte: string): string {
  if (!value.isFinite()) {
    throw new DbFrontierError(
      `${contexte} : grandeur non finie (${value.toString()}). Postgres stockerait 'NaN' dans un numeric sans broncher.`,
    );
  }
  return value.toFixed();
}

/**
 * `numeric(20,8)` <-> `Decimal`. Les deux fonctions ci-dessus sont branchees
 * ici et nulle part ailleurs : aucune requete ne voit la chaine brute.
 */
const decimalColumn = customType<{ data: Decimal; driverData: string }>({
  dataType: () => 'numeric(20, 8)',
  fromDriver: (value) => decimalFromText(value, 'numeric(20,8)'),
  toDriver: (value) => textFromDecimal(value, 'numeric(20,8)'),
});

const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `date` <-> `IsoDate`. Le driver rend `'2026-09-10'` ; la convertir en `Date`
 * lui donnerait minuit **dans le fuseau du processus**, ce qui decale la date
 * d'un jour a l'ouest de Greenwich. Le noyau raisonne en `IsoDate` depuis la
 * phase 0 : la chaine reste une chaine.
 */
const isoDateColumn = customType<{ data: IsoDate; driverData: string }>({
  dataType: () => 'date',
  fromDriver: (value) => {
    if (typeof value !== 'string' || !ISO_DATE_TEXT.test(value)) {
      throw new DbFrontierError(
        `date : YYYY-MM-DD attendu du driver, recu ${JSON.stringify(value)}.`,
      );
    }
    return value;
  },
  toDriver: (value) => value,
});

// --- Formes jsonb -----------------------------------------------------------

/**
 * Les colonnes `jsonb` portent des poids et des montants. Le §4 les ecrit
 * `{BTC: 0.47}` — en JSON, `0.47` est un double IEEE-754, et `JSON.parse` le
 * rend en `number`. Ecarter cette forme est le seul moyen de tenir la regle non
 * negociable jusque dans le journal : **les grandeurs sont serialisees en
 * chaines decimales**, `{"BTC":"0.47"}`, et relues par `decimalFromText`.
 *
 * Ecart assume par rapport a l'exemple de la spec, dont le jsonb n'a pas de
 * schema declare. Ce que la spec impose — les cles, le sens des valeurs — est
 * respecte ; la representation du nombre ne l'est pas, parce que la sienne perd
 * de la precision. Voir docs/base-de-donnees.md.
 */
export type WeightsText = Readonly<Record<AllowedAsset, string>>;

/** Une jambe telle qu'elle est journalisee. Superset du §4 : `quote` et le prix limite disent ce qui aurait ete envoye. */
export interface LegText {
  readonly asset: string;
  readonly quote: string;
  readonly side: string;
  readonly amountUsdc: string;
  readonly limitPrice: string;
}

/** Quantites detenues par actif, en unites d'actif. Cles libres : la base ne fait pas la liste blanche, `risk.ts` la fait. */
export type PositionsText = Readonly<Record<string, string>>;

/** Courbes de comparaison du §9 : `hold_btc`, `hold_5050`, `ladder`, `dca`. */
export type BenchmarksText = Readonly<Record<string, string>>;

// --- Tables -----------------------------------------------------------------

/**
 * Le nom de l'index est fige et exporte : c'est lui que Postgres renvoie dans
 * le champ `constraint` d'une violation 23505, et c'est ce que l'adapter
 * reconnait pour distinguer « deja enregistre » de n'importe quelle autre
 * erreur d'ecriture.
 */
export const DECISIONS_UNIQUE_INDEX = 'decisions_run_date_strategy_is_shadow_key';

/**
 * Journal immuable de chaque run, runs sans action compris. L'index unique
 * `(run_date, strategy, is_shadow)` **est** la garantie d'idempotence du job :
 * un second run le meme jour ne peut pas produire une seconde decision, et le
 * refus vient de la base, pas d'un `if` dans le job.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runDate: isoDateColumn('run_date').notNull(),
    strategy: text('strategy').notNull(),
    isShadow: boolean('is_shadow').notNull(),
    trigger: text('trigger').notNull(),
    reason: text('reason').notNull(),
    weightsBefore: jsonb('weights_before').$type<WeightsText>().notNull(),
    weightsTarget: jsonb('weights_target').$type<WeightsText>().notNull(),
    legs: jsonb('legs').$type<readonly LegText[]>().notNull(),
    riskVerdict: text('risk_verdict').notNull(),
    gitSha: text('git_sha').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex(DECISIONS_UNIQUE_INDEX).on(table.runDate, table.strategy, table.isShadow),
  ],
);

/**
 * Ordres. En phase 1 la table reste vide : rien n'est place. Elle existe parce
 * que `pendingOrders()` doit pouvoir la lire, et que la reconciliation du §7 en
 * depend des la phase 3.
 */
export const orders = pgTable('orders', {
  clientOrderId: text('client_order_id').primaryKey(),
  decisionId: uuid('decision_id').references(() => decisions.id),
  exchangeId: text('exchange_id'),
  side: text('side').notNull(),
  asset: text('asset').notNull(),
  requestedQty: decimalColumn('requested_qty').notNull(),
  limitPrice: decimalColumn('limit_price').notNull(),
  status: text('status').notNull(),
  filledQty: decimalColumn('filled_qty'),
  filledPrice: decimalColumn('filled_price'),
  fees: decimalColumn('fees'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});

/** Snapshot quotidien : rapport et courbes de benchmark. Une ligne par jour, la date est la cle. */
export const snapshots = pgTable('snapshots', {
  runDate: isoDateColumn('run_date').primaryKey(),
  totalValueUsdc: decimalColumn('total_value_usdc').notNull(),
  weights: jsonb('weights').$type<WeightsText>().notNull(),
  positions: jsonb('positions').$type<PositionsText>().notNull(),
  benchmarks: jsonb('benchmarks').$type<BenchmarksText>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/**
 * Apports et retraits. Sans eux un apport se lit comme une performance et
 * fausse tous les benchmarks : le rendement se calcule en time-weighted return,
 * pas en variation de valeur brute.
 */
export const cashFlows = pgTable('cash_flows', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  amountUsdc: decimalColumn('amount_usdc').notNull(),
  note: text('note'),
});
