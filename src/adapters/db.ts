import type { Decimal } from 'decimal.js';
import { asc, desc, eq, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { Secrets } from '../config/env.js';
import type {
  AllowedAsset,
  Intent,
  IntentLeg,
  IsoDate,
  Price,
  Quantity,
  RejectionCode,
  Side,
  UsdcAmount,
  Verdict,
  Weight,
  Weights,
} from '../core/types.js';
import type { BenchmarksText, LegText, PositionsText, WeightsText } from './schema.js';
import {
  cashFlows,
  DbFrontierError,
  DECISIONS_UNIQUE_INDEX,
  decimalFromText,
  decisions,
  orders,
  snapshots,
  textFromDecimal,
} from './schema.js';

/**
 * L'acces a Postgres, expose en **operations** et non en client. Rien ici ne
 * rend un `db` brut : le job quotidien enregistre une decision, lit le dernier
 * snapshot, lit les flux recents et lit les ordres en attente. Ce qui n'est pas
 * dans cette liste ne se fait pas depuis le job.
 *
 * Ce module ne lit jamais l'environnement. La chaine de connexion arrive
 * validee par `src/config/env.ts`, qui reste le seul point de lecture de
 * l'environnement du code qui tourne.
 *
 * Il ne migre rien non plus : le schema est applique **depuis le poste** par
 * `make db-push`, jamais par le job (spec §3). Un job qui peut modifier le
 * schema de sa base est un job qui peut la casser a 7 h du matin.
 */

// --- Formes exposees --------------------------------------------------------

/** `'ACCEPTED' | 'REJECTED:<code>'` du §4, ferme par le type plutot que par convention. */
export type RiskVerdictText = 'ACCEPTED' | `REJECTED:${RejectionCode}`;

/**
 * Ce qu'une decision ajoute a ce que le noyau a deja produit. `intent` et
 * `verdict` sont les valeurs de sortie de `decide()` et `validate()`, passees
 * telles quelles : l'adapter serialise, il ne recalcule rien.
 *
 * `createdAt` est un parametre et non `new Date()` : l'horloge est injectee,
 * ici comme dans le noyau, sinon aucun test n'est reproductible.
 */
export interface DecisionToRecord {
  readonly intent: Intent;
  readonly isShadow: boolean;
  readonly verdict: Verdict;
  readonly gitSha: string;
  readonly createdAt: Date;
}

/**
 * `ALREADY_RECORDED` n'est pas une erreur : c'est le cas nominal d'un second
 * run le meme jour. Le refus vient de l'index unique, pas d'une lecture
 * prealable — une lecture prealable laisserait une fenetre entre le `select` et
 * l'`insert`, et c'est exactement la fenetre par laquelle une double decision
 * passerait.
 */
export type RecordDecisionOutcome =
  | { readonly status: 'RECORDED'; readonly id: string }
  | { readonly status: 'ALREADY_RECORDED' };

export interface SnapshotToRecord {
  readonly runDate: IsoDate;
  readonly totalValueUsdc: UsdcAmount;
  readonly weights: Weights;
  /** Quantites detenues, en unites d'actif. */
  readonly positions: Readonly<Record<string, Quantity>>;
  /**
   * Courbes du §9 : `hold_btc`, `hold_5050`, `ladder`, `dca`. L'unite est celle
   * du lot qui les calcule ; la base n'en presume rien et garantit seulement
   * qu'aucune n'est passee par un flottant.
   */
  readonly benchmarks: Readonly<Record<string, Decimal>>;
  readonly createdAt: Date;
}

export type SnapshotRecord = SnapshotToRecord;

export interface CashFlowRecord {
  readonly id: string;
  readonly occurredAt: Date;
  /** Le jour UTC de l'apport, sous la forme dont raisonne le noyau. Le cron est en UTC (§8). */
  readonly occurredOn: IsoDate;
  /** Positif = apport, negatif = retrait. */
  readonly amount: UsdcAmount;
  readonly note: string | null;
}

/**
 * Un ordre non encore denoue. `status` n'y figure pas : il vaut `PENDING` par
 * construction, c'est le filtre de la requete et pas une donnee du resultat.
 */
export interface PendingOrderRecord {
  readonly clientOrderId: string;
  readonly decisionId: string | null;
  readonly exchangeId: string | null;
  readonly side: Side;
  readonly asset: string;
  readonly requestedQty: Quantity;
  readonly limitPrice: Price;
  readonly createdAt: Date;
}

/**
 * La surface entiere de la base pour le reste du programme. Ajouter une
 * operation ici est une decision ; ouvrir un client brut n'en est pas une.
 */
export interface UbacDatabase {
  recordDecision(input: DecisionToRecord): Promise<RecordDecisionOutcome>;
  /** Photo du jour : rejouer le meme jour la remplace, la date de run est la cle. */
  recordSnapshot(input: SnapshotToRecord): Promise<void>;
  latestSnapshot(): Promise<SnapshotRecord | undefined>;
  /** Flux dont `occurred_at >= since`, du plus ancien au plus recent. */
  recentCashFlows(since: Date): Promise<readonly CashFlowRecord[]>;
  pendingOrders(): Promise<readonly PendingOrderRecord[]>;
  close(): Promise<void>;
}

// --- Serialisation ----------------------------------------------------------

const SIDES: readonly string[] = ['BUY', 'SELL'] satisfies readonly Side[];

export function riskVerdictText(verdict: Verdict): RiskVerdictText {
  if (verdict.status === 'ACCEPTED') return 'ACCEPTED';
  const premier = verdict.rejections[0];
  if (premier === undefined) {
    throw new DbFrontierError(
      'verdict REJECTED sans motif : la colonne risk_verdict porte un code, il en faut un.',
    );
  }
  /*
   * Un seul code, comme le §4 le prevoit. Le detail lisible d'un rejet multiple
   * va dans `reason`, qui est la colonne faite pour ca.
   */
  return `REJECTED:${premier.code}`;
}

function weightsToJson(weights: Weights, contexte: string): WeightsText {
  return {
    BTC: textFromDecimal(weights.BTC, `${contexte}.BTC`),
    ETH: textFromDecimal(weights.ETH, `${contexte}.ETH`),
    USDC: textFromDecimal(weights.USDC, `${contexte}.USDC`),
  };
}

function decimalMapToJson(
  map: Readonly<Record<string, Decimal>>,
  contexte: string,
): Readonly<Record<string, string>> {
  const sortie: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(map)) {
    sortie[cle] = textFromDecimal(valeur, `${contexte}.${cle}`);
  }
  return sortie;
}

function legsToJson(legs: readonly IntentLeg[]): readonly LegText[] {
  return legs.map((leg, index) => ({
    asset: leg.asset,
    quote: leg.quote,
    side: leg.side,
    amountUsdc: textFromDecimal(leg.amount, `legs[${index}].amount`),
    limitPrice: textFromDecimal(leg.limitPrice, `legs[${index}].limitPrice`),
  }));
}

// --- Relecture --------------------------------------------------------------

/**
 * Le contenu d'une colonne `jsonb` est ce que quelqu'un y a mis, pas ce que le
 * type TypeScript promet. Tout ce qui en sort passe donc par une verification,
 * et `decimalFromText` refuse en particulier le `number` — la forme meme que
 * `JSON.parse` produirait sur le `{BTC: 0.47}` de la spec.
 */
function jsonRecord(raw: unknown, contexte: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DbFrontierError(`${contexte} : objet jsonb attendu, recu ${JSON.stringify(raw)}.`);
  }
  return raw as Readonly<Record<string, unknown>>;
}

function weightsFromJson(raw: unknown, contexte: string): Weights {
  const record = jsonRecord(raw, contexte);
  const lu = (asset: AllowedAsset): Weight =>
    decimalFromText(record[asset], `${contexte}.${asset}`) as Weight;
  return { BTC: lu('BTC'), ETH: lu('ETH'), USDC: lu('USDC') };
}

function decimalMapFromJson(raw: unknown, contexte: string): Readonly<Record<string, Decimal>> {
  const record = jsonRecord(raw, contexte);
  const sortie: Record<string, Decimal> = {};
  for (const [cle, valeur] of Object.entries(record)) {
    sortie[cle] = decimalFromText(valeur, `${contexte}.${cle}`);
  }
  return sortie;
}

/** Le jour UTC d'un instant. Le cron tourne en UTC et les bougies daily cloturent a 00:00 UTC (§8). */
function utcDay(instant: Date): IsoDate {
  return instant.toISOString().slice(0, 10);
}

function sideFromText(raw: string, contexte: string): Side {
  if (!SIDES.includes(raw)) {
    throw new DbFrontierError(`${contexte} : BUY ou SELL attendu, recu "${raw}".`);
  }
  return raw as Side;
}

// --- Violation d'unicite ----------------------------------------------------

/** `unique_violation`, table 24 des codes d'erreur Postgres. */
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle emballe l'erreur du driver ; le code et le nom de contrainte vivent
 * dans la cause. On ne se contente pas du code : un 23505 sur une autre
 * contrainte — la cle primaire d'`orders`, par exemple — n'est pas un second
 * run du jour et ne doit surtout pas etre avale comme tel.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let courant: unknown = error;
  for (let profondeur = 0; profondeur < 8; profondeur += 1) {
    if (typeof courant !== 'object' || courant === null) return false;
    const candidat = courant as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidat.code === UNIQUE_VIOLATION && candidat.constraint === constraint) return true;
    courant = candidat.cause;
  }
  return false;
}

// --- Ouverture --------------------------------------------------------------

/**
 * `Pick<Secrets, 'databaseUrl'>` plutot qu'une `string` nue : le type dit d'ou
 * la valeur doit venir. Le job passe `config.secrets`, deja valide ; personne
 * ne fabrique une chaine ici.
 */
export function openDatabase(secrets: Pick<Secrets, 'databaseUrl'>): UbacDatabase {
  /*
   * Deux connexions suffisent : le job est sequentiel et tourne cinq minutes au
   * plus. Un pool large sur une base serverless ne sert qu'a en laisser ouvertes.
   */
  const pool = new pg.Pool({ connectionString: secrets.databaseUrl, max: 2 });
  const db = drizzle(pool);

  return {
    async recordDecision(input: DecisionToRecord): Promise<RecordDecisionOutcome> {
      const { intent } = input;
      try {
        const lignes = await db
          .insert(decisions)
          .values({
            runDate: intent.runDate,
            strategy: intent.strategy,
            isShadow: input.isShadow,
            trigger: intent.trigger,
            reason: intent.reason,
            weightsBefore: weightsToJson(intent.weightsBefore, 'weights_before'),
            weightsTarget: weightsToJson(intent.weightsTarget, 'weights_target'),
            legs: legsToJson(intent.legs),
            riskVerdict: riskVerdictText(input.verdict),
            gitSha: input.gitSha,
            createdAt: input.createdAt,
          })
          .returning({ id: decisions.id });
        const ligne = lignes[0];
        if (ligne === undefined) {
          throw new DbFrontierError('insertion de decision sans ligne retournee.');
        }
        return { status: 'RECORDED', id: ligne.id };
      } catch (error) {
        /*
         * C'est ici, et nulle part ailleurs, que l'idempotence du run quotidien
         * se joue. Aucune lecture prealable, aucun `if` : l'index unique
         * `(run_date, strategy, is_shadow)` refuse la seconde insertion et on se
         * contente de traduire son refus.
         */
        if (isUniqueViolation(error, DECISIONS_UNIQUE_INDEX)) {
          return { status: 'ALREADY_RECORDED' };
        }
        throw error;
      }
    },

    async recordSnapshot(input: SnapshotToRecord): Promise<void> {
      const valeurs = {
        runDate: input.runDate,
        totalValueUsdc: input.totalValueUsdc,
        weights: weightsToJson(input.weights, 'weights'),
        positions: decimalMapToJson(input.positions, 'positions') satisfies PositionsText,
        benchmarks: decimalMapToJson(input.benchmarks, 'benchmarks') satisfies BenchmarksText,
        createdAt: input.createdAt,
      };
      /*
       * Le snapshot est une photo du jour, pas un journal : le rejouer le
       * remplace. C'est la difference avec `decisions`, ou le second run est
       * refuse — une decision engagee ne se reecrit pas, une photo si.
       */
      await db
        .insert(snapshots)
        .values(valeurs)
        .onConflictDoUpdate({ target: snapshots.runDate, set: valeurs });
    },

    async latestSnapshot(): Promise<SnapshotRecord | undefined> {
      const lignes = await db
        .select()
        .from(snapshots)
        .orderBy(desc(snapshots.runDate))
        .limit(1);
      const ligne = lignes[0];
      if (ligne === undefined) return undefined;
      return {
        runDate: ligne.runDate,
        totalValueUsdc: ligne.totalValueUsdc as UsdcAmount,
        weights: weightsFromJson(ligne.weights, 'weights'),
        positions: decimalMapFromJson(ligne.positions, 'positions') as Readonly<
          Record<string, Quantity>
        >,
        benchmarks: decimalMapFromJson(ligne.benchmarks, 'benchmarks'),
        createdAt: ligne.createdAt,
      };
    },

    async recentCashFlows(since: Date): Promise<readonly CashFlowRecord[]> {
      const lignes = await db
        .select()
        .from(cashFlows)
        .where(gte(cashFlows.occurredAt, since))
        .orderBy(asc(cashFlows.occurredAt));
      return lignes.map((ligne) => ({
        id: ligne.id,
        occurredAt: ligne.occurredAt,
        occurredOn: utcDay(ligne.occurredAt),
        amount: ligne.amountUsdc as UsdcAmount,
        note: ligne.note,
      }));
    },

    async pendingOrders(): Promise<readonly PendingOrderRecord[]> {
      const lignes = await db
        .select()
        .from(orders)
        .where(eq(orders.status, 'PENDING'))
        .orderBy(asc(orders.createdAt));
      return lignes.map((ligne) => ({
        clientOrderId: ligne.clientOrderId,
        decisionId: ligne.decisionId,
        exchangeId: ligne.exchangeId,
        side: sideFromText(ligne.side, `orders.side (${ligne.clientOrderId})`),
        asset: ligne.asset,
        requestedQty: ligne.requestedQty as Quantity,
        limitPrice: ligne.limitPrice as Price,
        createdAt: ligne.createdAt,
      }));
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
