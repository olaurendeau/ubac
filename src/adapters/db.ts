import type { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { Secrets } from '../config/env.js';
import type {
  AllowedAsset,
  Intent,
  IntentLeg,
  IsoDate,
  Order,
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
  ORDERS_PRIMARY_KEY,
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

/**
 * Un ordre **avant** son placement (E23). `decisionId` est obligatoire : c'est
 * le seul rattachement d'`orders` a son run, par `decisions.run_date`, et le
 * cooldown (S9) groupe les ordres par run a travers lui.
 */
export interface OrderToRecord {
  readonly order: Order;
  readonly decisionId: string;
  readonly createdAt: Date;
}

/**
 * `ALREADY_RECORDED` est la seconde ligne de defense d'E24 : la cle primaire
 * `client_order_id` refuse la ligne d'un ordre deja ecrit, et l'appelant ne le
 * place pas une seconde fois.
 */
export type RecordOrderOutcome = { readonly status: 'RECORDED' } | { readonly status: 'ALREADY_RECORDED' };

/**
 * L'issue d'un placement, sur une ligne encore `PENDING` et sans `exchange_id`.
 * Place, la ligne reste `PENDING` et gagne son identifiant d'exchange ; rejete
 * par l'exchange — post-only compris —, elle passe `REJECTED`. Une ligne
 * `PENDING` **sans** `exchange_id` est donc celle d'un ordre dont le placement
 * n'a jamais ete confirme.
 */
export type PlacementToRecord =
  | { readonly kind: 'PLACED'; readonly clientOrderId: string; readonly exchangeId: string }
  | { readonly kind: 'REJECTED'; readonly clientOrderId: string };

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
 * Une photo reduite aux **deux colonnes que le graphe du rapport lit** : sa date
 * et ses metriques. Ni valeur totale, ni poids, ni position — une serie entiere
 * de `SnapshotRecord` couterait plusieurs fois ce que le graphe consomme, et
 * porterait une valeur totale que le graphe n'a justement pas le droit de tracer.
 */
export interface SnapshotPoint {
  readonly runDate: IsoDate;
  readonly benchmarks: Readonly<Record<string, Decimal>>;
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
  /**
   * Toutes les photos, de la plus ancienne a la plus recente, reduites aux deux
   * colonnes utiles. Elle **ne remplace pas** `latestSnapshot()`, que la
   * reconciliation appelle aussi pour ses positions : deriver l'une de l'autre
   * ferait entrer un lot integre dans le perimetre, pour economiser une requete
   * que rien ne rend couteuse.
   *
   * Sans plafond : la serie relit toutes les photos chaque jour, 365 lignes
   * apres un an. Le jour ou un plafond serait necessaire, ce sera une decision.
   */
  snapshotSeries(): Promise<readonly SnapshotPoint[]>;
  /** Flux dont `occurred_at >= since`, du plus ancien au plus recent. */
  recentCashFlows(since: Date): Promise<readonly CashFlowRecord[]>;
  pendingOrders(): Promise<readonly PendingOrderRecord[]>;
  /** L'ordre en `PENDING`, **avant** son placement (E23). */
  recordOrder(input: OrderToRecord): Promise<RecordOrderOutcome>;
  recordPlacement(input: PlacementToRecord): Promise<void>;
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
   * va dans `reason`, qui est la colonne faite pour ca : voir `decisionReasonText`.
   */
  return `REJECTED:${premier.code}`;
}

/**
 * La colonne `reason` d'une decision. Acceptee, c'est le motif de l'intention tel
 * que `decide()` l'a formule. Refusee, ce motif **reste en tete** et chaque rejet
 * s'y ajoute sur sa ligne : l'intention dit ce que la strategie voulait faire et
 * pourquoi, le rejet dit pourquoi ca n'a pas eu lieu. Ne garder que le second
 * effacerait le premier de l'historique ; ne garder que le premier laissait
 * `decisions` sans le motif quantifie du refus, que seule l'alerte portait (E32).
 *
 * Toutes les decisions refusees passent ici, des quatre strategies et pour tous
 * les codes, pas seulement `REBALANCE_TOO_LARGE` : une colonne qui porterait le
 * motif du refus pour un code et pas pour les autres se lirait a deux vitesses.
 *
 * Le texte du rejet vient de `core/risk.ts` et n'est pas reecrit ici, et son
 * ordre est celui du verdict : un run rejoue ecrit la meme ligne. Un verdict
 * rejete sans motif est refuse par `riskVerdictText`, dans la meme insertion.
 */
export function decisionReasonText(intent: Intent, verdict: Verdict): string {
  if (verdict.status === 'ACCEPTED') return intent.reason;
  const refus = verdict.rejections.map((rejection) => {
    const jambe = rejection.legIndex === undefined ? '' : ` (jambe ${String(rejection.legIndex)})`;
    return `refus ${rejection.code}${jambe} : ${rejection.reason}`;
  });
  return [intent.reason, ...refus].join('\n');
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
            reason: decisionReasonText(intent, input.verdict),
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

    async snapshotSeries(): Promise<readonly SnapshotPoint[]> {
      /*
       * Deux colonnes selectionnees, pas `select()` : la serie entiere passe sur
       * le reseau chaque jour, et `positions` comme `weights` sont des jsonb que
       * personne ne lira ici.
       */
      const lignes = await db
        .select({ runDate: snapshots.runDate, benchmarks: snapshots.benchmarks })
        .from(snapshots)
        .orderBy(asc(snapshots.runDate));
      return lignes.map((ligne) => ({
        runDate: ligne.runDate,
        benchmarks: decimalMapFromJson(ligne.benchmarks, `benchmarks (${ligne.runDate})`),
      }));
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

    async recordOrder(input: OrderToRecord): Promise<RecordOrderOutcome> {
      const { order } = input;
      try {
        await db.insert(orders).values({
          clientOrderId: order.clientOrderId,
          decisionId: input.decisionId,
          side: order.side,
          asset: order.asset,
          requestedQty: order.quantity,
          limitPrice: order.limitPrice,
          status: 'PENDING',
          createdAt: input.createdAt,
        });
        return { status: 'RECORDED' };
      } catch (error) {
        // Meme traduction que `recordDecision`, sur la seule cle primaire d'`orders`.
        if (isUniqueViolation(error, ORDERS_PRIMARY_KEY)) return { status: 'ALREADY_RECORDED' };
        throw error;
      }
    },

    async recordPlacement(input: PlacementToRecord): Promise<void> {
      const issue =
        input.kind === 'PLACED' ? { exchangeId: input.exchangeId } : { status: 'REJECTED' };
      const lignes = await db
        .update(orders)
        .set(issue)
        .where(
          and(
            eq(orders.clientOrderId, input.clientOrderId),
            eq(orders.status, 'PENDING'),
            isNull(orders.exchangeId),
          ),
        )
        .returning({ clientOrderId: orders.clientOrderId });
      // Une issue sans sa ligne ne se pose pas en silence : l'ordre ne serait plus reclame par rien.
      if (lignes.length !== 1) {
        throw new DbFrontierError(
          `orders : aucune ligne PENDING sans exchange_id pour ${input.clientOrderId}, issue ${input.kind} non ecrite.`,
        );
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
