import type { Decimal } from 'decimal.js';
import { inArray, max } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import {
  CASH_FLOWS_NATURAL_KEY_INDEX,
  CONVOYEUR_JOURNAL_DAY_INDEX,
  CONVOYEUR_JOURNAL_STEP_INDEX,
  cashFlows,
  convoyeurJournal,
} from '../adapters/schema.js';
import { clientOrderIdConvoyage, eurDebite, montantATransferer } from './regles.js';
import type { Achat, Convoyage, DernierConvoyage, Etape, EurAmount, UsdcAmount } from './types.js';

/**
 * La base du convoyeur (lot Y4a du plan `ubac-convoyeur`) : son journal et
 * l'apport, **et rien d'autre**. Trois operations, sous le role du convoyeur
 * (Q9) : `INSERT` sur `cash_flows`, `SELECT` et `INSERT` sur son journal. Aucune
 * requete n'en demande davantage : ni `UPDATE`, ni `DELETE`, ni `RETURNING`
 * (qui exigerait `SELECT` sur `cash_flows`), ni lecture prealable de
 * l'apport. Une seconde ecriture se reconnait au nom de l'index qui la refuse.
 *
 * Aucune horloge : chaque instant entre en parametre (piege 1 d'Y4b).
 */

// --- Erreur de frontiere ----------------------------------------------------

/** Un journal que la base rend et que le convoyeur ne sait pas lire, ou un apport qu'il refuse d'ecrire. */
export class ConvoyeurBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvoyeurBaseError';
  }
}

// --- Le port ----------------------------------------------------------------

/** L'issue d'une ecriture : la ligne est posee, ou elle l'etait deja. */
export type Ecriture = 'RECORDED' | 'ALREADY_RECORDED';

/**
 * Une etape a ecrire, **avant** l'appel qu'elle annonce (DC6). `le` est
 * l'instant que l'etape porte : celui de la demande pour `TRANSFERT_DEMANDE`
 * (`demandeLe`), celui du transfert retenu pour `TRANSFERE` (`transfereLe`,
 * DC5 ; a la reprise, celui de la demande, plan point 3).
 */
export type EtapeAEcrire =
  | { readonly etape: 'ACHAT_DEMANDE'; readonly convoyage: Convoyage; readonly le: Date }
  | { readonly etape: 'ACHETE'; readonly convoyage: Convoyage; readonly le: Date; readonly achat: Achat }
  | {
      readonly etape: 'TRANSFERT_DEMANDE';
      readonly convoyage: Convoyage;
      readonly le: Date;
      readonly montant: UsdcAmount;
    }
  | { readonly etape: 'TRANSFERE'; readonly convoyage: Convoyage; readonly le: Date }
  | { readonly etape: 'ENREGISTRE'; readonly convoyage: Convoyage; readonly le: Date }
  | { readonly etape: 'EN_PANNE'; readonly convoyage: Convoyage; readonly le: Date; readonly motif: string };

/** L'apport d'un convoyage : l'USDC de son achat, a l'instant de son transfert (DC4, DC5). */
export interface Apport {
  readonly convoyage: Convoyage;
  readonly achat: Achat;
  readonly transfereLe: Date;
}

export interface ConvoyeurBase {
  /** La derniere etape du convoyage le plus recent ; `undefined` si le journal est vide. */
  dernierConvoyage(): Promise<DernierConvoyage | undefined>;
  /** `ALREADY_RECORDED` si cette etape de ce convoyage est deja ecrite. */
  ecrireEtape(etape: EtapeAEcrire): Promise<Ecriture>;
  /** `ALREADY_RECORDED` si l'apport de ce convoyage est deja dans `cash_flows` (CV11). */
  ecrireApport(apport: Apport): Promise<Ecriture>;
}

export interface ConvoyeurBaseReelle extends ConvoyeurBase {
  close(): Promise<void>;
}

// --- Les lignes, sans IO ----------------------------------------------------

/** Une ligne du journal, telle qu'elle s'ecrit et se relit (sans `id`). */
export interface LigneJournal {
  /** Le `client_order_id` du convoyage (schema) : un jour, un identifiant. */
  readonly convoyage: string;
  readonly day: Convoyage;
  readonly step: Etape;
  readonly occurredAt: Date;
  readonly amountUsdc: Decimal | null;
  /** `filled_value + total_fees` : l'EUR qui a quitte *Primary*. */
  readonly debitedEur: Decimal | null;
  readonly feesEur: Decimal | null;
  readonly exchangeOrderId: string | null;
  readonly reason: string | null;
}

export function ligneJournal(e: EtapeAEcrire): LigneJournal {
  const vide = {
    convoyage: clientOrderIdConvoyage(e.convoyage),
    day: e.convoyage,
    step: e.etape,
    occurredAt: e.le,
    amountUsdc: null,
    debitedEur: null,
    feesEur: null,
    exchangeOrderId: null,
    reason: null,
  };
  switch (e.etape) {
    case 'ACHETE':
      return {
        ...vide,
        amountUsdc: e.achat.filledSize,
        debitedEur: eurDebite(e.achat),
        feesEur: e.achat.totalFees,
        exchangeOrderId: e.achat.orderId,
      };
    case 'TRANSFERT_DEMANDE':
      return { ...vide, amountUsdc: e.montant };
    case 'EN_PANNE':
      return { ...vide, reason: e.motif };
    case 'ACHAT_DEMANDE':
    case 'TRANSFERE':
    case 'ENREGISTRE':
      return vide;
  }
}

/** `EN_PANNE` clot un convoyage ; sinon l'etape la plus avancee est la derniere. */
const RANG: Readonly<Record<Etape, number>> = {
  ACHAT_DEMANDE: 0,
  ACHETE: 1,
  TRANSFERT_DEMANDE: 2,
  TRANSFERE: 3,
  ENREGISTRE: 4,
  EN_PANNE: 5,
};

function requis<T>(valeur: T | null | undefined, quoi: string): T {
  if (valeur === null || valeur === undefined) {
    throw new ConvoyeurBaseError(`journal du convoyeur illisible : ${quoi} absent.`);
  }
  return valeur;
}

function achatDe(lignes: readonly LigneJournal[], convoyage: Convoyage): Achat {
  const achete = requis(
    lignes.find((l) => l.step === 'ACHETE'),
    `ACHETE du convoyage ${convoyage}`,
  );
  const fees = requis(achete.feesEur, `fees_eur d'ACHETE (${convoyage})`);
  return {
    orderId: requis(achete.exchangeOrderId, `exchange_order_id d'ACHETE (${convoyage})`),
    filledSize: requis(achete.amountUsdc, `amount_usdc d'ACHETE (${convoyage})`) as UsdcAmount,
    // L'inverse exact d'`eurDebite` : des `Decimal`, aucun arrondi.
    filledValue: requis(achete.debitedEur, `debited_eur d'ACHETE (${convoyage})`).minus(fees) as EurAmount,
    totalFees: fees as EurAmount,
  };
}

/**
 * La derniere etape d'un convoyage, a partir de **ses** lignes. Le journal est
 * en ajout seul : l'etat est l'etape la plus avancee, et chaque variante ne
 * porte que ce que le journal a constate. Des lignes de deux convoyages, ou un
 * identifiant qui ne derive pas de son jour, sont refusees : le journal dirait
 * autre chose que ce qu'il promet.
 */
export function dernierDepuisLignes(lignes: readonly LigneJournal[]): DernierConvoyage | undefined {
  const [premiere] = lignes;
  if (premiere === undefined) return undefined;
  const convoyage = premiere.day;
  const identifiant = clientOrderIdConvoyage(convoyage);
  for (const ligne of lignes) {
    if (ligne.day !== convoyage || ligne.convoyage !== identifiant) {
      throw new ConvoyeurBaseError(
        `journal du convoyeur illisible : ${ligne.convoyage} du ${ligne.day} parmi le convoyage ${identifiant} du ${convoyage}.`,
      );
    }
  }
  const derniere = lignes.reduce((a, b) => (RANG[b.step] > RANG[a.step] ? b : a));
  switch (derniere.step) {
    case 'ACHAT_DEMANDE':
    case 'ENREGISTRE':
      return { etape: derniere.step, convoyage };
    case 'ACHETE':
      return { etape: 'ACHETE', convoyage, achat: achatDe(lignes, convoyage) };
    case 'TRANSFERT_DEMANDE':
      return {
        etape: 'TRANSFERT_DEMANDE',
        convoyage,
        achat: achatDe(lignes, convoyage),
        demandeLe: derniere.occurredAt,
      };
    case 'TRANSFERE':
      return {
        etape: 'TRANSFERE',
        convoyage,
        achat: achatDe(lignes, convoyage),
        transfereLe: derniere.occurredAt,
      };
    case 'EN_PANNE':
      return { etape: 'EN_PANNE', convoyage, motif: requis(derniere.reason, `motif d'EN_PANNE (${convoyage})`) };
  }
}

/** Une ligne `cash_flows` du convoyeur, telle qu'elle s'ecrit. */
export interface LigneApport {
  readonly occurredAt: Date;
  readonly amountUsdc: UsdcAmount;
  readonly note: string;
  readonly origin: 'CONVOYEUR';
  readonly naturalKey: string;
}

/** La clef naturelle d'un apport : derivee de son ordre, l'exchange ne donne pas d'identifiant de transfert (S7). */
export function cleApport(convoyage: Convoyage): string {
  return `CONVOYEUR:${clientOrderIdConvoyage(convoyage)}`;
}

/**
 * DC4 : le montant est `filled_size`, l'USDC deplace, jamais l'EUR. Il doit etre
 * positif, et tenir dans `numeric(20,8)` **sans arrondi** : la colonne
 * arrondirait en silence, et la ligne ne dirait plus l'USDC deplace. La note
 * porte l'EUR debite, les frais et l'ordre de l'exchange — aucun secret.
 */
export function ligneApport(apport: Apport): LigneApport {
  const { achat, convoyage } = apport;
  const montant = montantATransferer(achat);
  if (!(montant.isFinite() && montant.gt(0) && montant.decimalPlaces() <= 8)) {
    throw new ConvoyeurBaseError(
      `apport du convoyage ${convoyage} refuse : ${montant.toString()} USDC n'est pas un montant positif a 8 decimales au plus.`,
    );
  }
  return {
    occurredAt: apport.transfereLe,
    amountUsdc: montant,
    note:
      `convoyeur ${convoyage} : EUR debite ${eurDebite(achat).toFixed()}, ` +
      `frais ${achat.totalFees.toFixed()} EUR, ordre ${achat.orderId}`,
    origin: 'CONVOYEUR',
    naturalKey: cleApport(convoyage),
  };
}

// --- Violation d'unicite ----------------------------------------------------

/**
 * Recopie d'`isUniqueViolation` de `src/adapters/db.ts`, que le convoyeur
 * n'importe pas (plan, point 1). Le nom de l'index est verifie, pas seulement
 * le code : un 23505 sur une autre contrainte n'est pas un rejeu.
 */
function isUniqueViolation(error: unknown, constraints: readonly string[]): boolean {
  let courant: unknown = error;
  for (let profondeur = 0; profondeur < 8; profondeur += 1) {
    if (typeof courant !== 'object' || courant === null) return false;
    const candidat = courant as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidat.code === '23505' && constraints.includes(String(candidat.constraint))) return true;
    courant = candidat.cause;
  }
  return false;
}

/**
 * L'identifiant d'un convoyage derive de son jour : un second `ACHAT_DEMANDE`
 * du meme jour bute sur les deux index a la fois, et Postgres nomme l'un ou
 * l'autre. Les deux disent la meme ligne deja ecrite.
 */
const INDEX_DU_JOURNAL = [CONVOYEUR_JOURNAL_STEP_INDEX, CONVOYEUR_JOURNAL_DAY_INDEX];

// --- Ouverture --------------------------------------------------------------

/**
 * La chaine de connexion est celle du role du convoyeur (Q9) ; c'est le point
 * de composition (Y5) qui la lit. Une connexion : le passage est sequentiel.
 */
export function openConvoyeurBase(secrets: { readonly databaseUrl: string }): ConvoyeurBaseReelle {
  const pool = new pg.Pool({ connectionString: secrets.databaseUrl, max: 1 });
  const db = drizzle(pool);

  return {
    async dernierConvoyage(): Promise<DernierConvoyage | undefined> {
      const dernierJour = db.select({ day: max(convoyeurJournal.day) }).from(convoyeurJournal);
      const lignes = await db
        .select({
          convoyage: convoyeurJournal.convoyage,
          day: convoyeurJournal.day,
          step: convoyeurJournal.step,
          occurredAt: convoyeurJournal.occurredAt,
          amountUsdc: convoyeurJournal.amountUsdc,
          debitedEur: convoyeurJournal.debitedEur,
          feesEur: convoyeurJournal.feesEur,
          exchangeOrderId: convoyeurJournal.exchangeOrderId,
          reason: convoyeurJournal.reason,
        })
        .from(convoyeurJournal)
        .where(inArray(convoyeurJournal.day, dernierJour));
      return dernierDepuisLignes(lignes);
    },

    async ecrireEtape(etape: EtapeAEcrire): Promise<Ecriture> {
      try {
        await db.insert(convoyeurJournal).values(ligneJournal(etape));
        return 'RECORDED';
      } catch (error) {
        if (isUniqueViolation(error, INDEX_DU_JOURNAL)) return 'ALREADY_RECORDED';
        throw error;
      }
    },

    async ecrireApport(apport: Apport): Promise<Ecriture> {
      try {
        await db.insert(cashFlows).values(ligneApport(apport));
        return 'RECORDED';
      } catch (error) {
        if (isUniqueViolation(error, [CASH_FLOWS_NATURAL_KEY_INDEX])) return 'ALREADY_RECORDED';
        throw error;
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
