import type { Decimal } from 'decimal.js';

import type { IsoDate } from '../core/types.js';

/**
 * Vocabulaire du convoyeur. Des types, et la seule liste des etapes du
 * journal, dont le type derive.
 *
 * Le convoyeur est un second arbre (plan `ubac-convoyeur`, point 1) : il
 * n'emprunte au noyau d'Ubac que des types, et ses montants ne sont pas ceux
 * d'Ubac. Un `UsdcAmount` d'Ubac est une valeur de portefeuille ou une jambe ;
 * celui du convoyeur est de l'USDC achete dans *Primary*. Les deux marques sont
 * distinctes pour qu'aucun montant ne passe d'un arbre a l'autre sans une
 * requalification ecrite.
 */

type Branded<B extends string> = Decimal & { readonly __brand: B };

/** Somme en euros : l'EUR de *Primary*, l'EUR engage, les frais (en EUR, piege 4 d'Y2). */
export type EurAmount = Branded<'ConvoyeurEur'>;

/** Somme en USDC, du point de vue du convoyeur : l'USDC recu, relu, transfere. */
export type UsdcAmount = Branded<'ConvoyeurUsdc'>;

/**
 * Identifiant d'un convoyage : le jour UTC du passage qui l'ouvre. Un jour, un
 * convoyage au plus (DC8) ; l'index unique du journal en fait une propriete de
 * la base (Y1).
 */
export type Convoyage = IsoDate;

/**
 * Les etapes du journal, dans l'ordre (plan, point 2). Le journal est en ajout
 * seul : l'etat d'un convoyage est sa derniere etape.
 */
export const ETAPES = [
  'ACHAT_DEMANDE',
  'ACHETE',
  'TRANSFERT_DEMANDE',
  'TRANSFERE',
  'ENREGISTRE',
  'EN_PANNE',
] as const;

export type Etape = (typeof ETAPES)[number];

/** Ce que l'ordre rempli dit de l'achat (S6), lu sur l'exchange. */
export interface Achat {
  /** Identifiant d'ordre de l'exchange, pour la note (DC4). */
  readonly orderId: string;
  /** `filled_size` : l'USDC recu, tel quel. C'est le montant a transferer (CV8). */
  readonly filledSize: UsdcAmount;
  /** `filled_value` : l'EUR echange, hors frais. */
  readonly filledValue: EurAmount;
  /** `total_fees`, en EUR. */
  readonly totalFees: EurAmount;
}

/**
 * La derniere etape du dernier convoyage, telle que le journal la porte. Chaque
 * variante ne porte que ce que son etape a pu constater : un convoyage a
 * `ACHAT_DEMANDE` n'a pas d'achat, et le type interdit de lui en inventer un.
 */
export type DernierConvoyage =
  | { readonly etape: 'ACHAT_DEMANDE'; readonly convoyage: Convoyage }
  | { readonly etape: 'ACHETE'; readonly convoyage: Convoyage; readonly achat: Achat }
  | {
      readonly etape: 'TRANSFERT_DEMANDE';
      readonly convoyage: Convoyage;
      readonly achat: Achat;
      /** Instant ecrit juste avant `move_funds` (plan, point 3). */
      readonly demandeLe: Date;
    }
  | {
      readonly etape: 'TRANSFERE';
      readonly convoyage: Convoyage;
      readonly achat: Achat;
      /** Instant du transfert retenu pour `occurred_at` (DC5). */
      readonly transfereLe: Date;
    }
  | { readonly etape: 'ENREGISTRE'; readonly convoyage: Convoyage }
  | { readonly etape: 'EN_PANNE'; readonly convoyage: Convoyage; readonly motif: string };

/** Priorite d'une notification ; memes niveaux que le canal d'Ubac. */
export type Priorite = 'URGENT' | 'HIGH';
