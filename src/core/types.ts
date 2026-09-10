import type { Decimal } from 'decimal.js';

/**
 * Vocabulaire de la phase 0. Declarations de types uniquement : ce fichier
 * n'emet aucun code a l'execution et s'importe avec `import type`.
 */

// --- Grandeurs numeriques ---------------------------------------------------

/**
 * `type Price = Decimal` ne protegerait de rien : le typage structurel rendrait
 * un prix et une quantite interchangeables. La marque est ce qui donne un sens
 * a C3 au-dela du simple bannissement de `number`.
 *
 * Elle n'existe qu'a la compilation. Les operations de decimal.js retournent un
 * `Decimal` nu : `prix.mul(qte)` perd la marque, et c'est voulu — le resultat
 * doit etre re-qualifie explicitement, pas herite par accident.
 */
type Branded<B extends string> = Decimal & { readonly __brand: B };

/**
 * Les quatre grandeurs sont dimensionnellement distinctes :
 *
 *     UsdcAmount = Price x Quantity
 *
 * `Price` est un nombre d'USDC **par unite d'actif**, `Quantity` un nombre
 * d'unites d'actif, `UsdcAmount` un nombre d'USDC. `Weight` est sans dimension.
 *
 * Donner la meme marque au montant en USDC d'une jambe et a la quantite d'actif
 * d'un ordre — les deux sont des `Decimal` positifs, la confusion est naturelle —
 * rend **compilable** une conversion intention vers ordre qui oublie la division
 * par le prix limite. L'ordre part alors plusieurs ordres de grandeur trop gros.
 * C'est exactement le bug que le marquage doit rendre impossible ; si les quatre
 * marques ne sont pas distinctes, le marquage ne sert a rien.
 */

/** Prix unitaire : nombre d'USDC par unite d'actif. */
export type Price = Branded<'Price'>;

/**
 * Quantite d'un actif, en unites de cet actif : 0.35 BTC, 4.2 ETH. Jamais une
 * somme d'argent, meme quand l'actif est USDC — c'est `UsdcAmount` qui la porte.
 */
export type Quantity = Branded<'Quantity'>;

/** Somme d'argent, en USDC. Une jambe, une valeur de portefeuille, un apport. */
export type UsdcAmount = Branded<'UsdcAmount'>;

/** Poids d'une ligne dans le portefeuille, en fraction de 1 — jamais en pourcent. */
export type Weight = Branded<'Weight'>;

// --- Vocabulaire ------------------------------------------------------------

/** Date de run au format `YYYY-MM-DD`, en UTC. La phase 0 est journaliere. */
export type IsoDate = string;

/** Liste blanche d'actifs de la phase 0. */
export type AllowedAsset = 'BTC' | 'ETH' | 'USDC';

export type Side = 'BUY' | 'SELL';

/** Journalise dans `decisions` et compte les declenchements du rejeu. */
export type Trigger = 'NONE' | 'CASH_BAND' | 'RATIO_BAND';

/** Les quatre configurations evaluees par le rejeu. Aucune n'execute en phase 0. */
export type StrategyName = 'rebalance' | 'rebalance_ab' | 'ladder' | 'dca';

export type RejectionCode =
  | 'ASSET_NOT_ALLOWED'
  | 'QUOTE_NOT_ALLOWED'
  | 'MAX_EXPOSURE'
  | 'MIN_CASH'
  | 'REBALANCE_TOO_LARGE'
  | 'LEG_TOO_SMALL'
  | 'COOLDOWN'
  | 'PRICE_SANITY'
  | 'RECONCILIATION_DRIFT';

/**
 * L'horloge est un parametre : core ne lit jamais l'horloge systeme. Le rejeu
 * l'alimente ligne a ligne depuis la fixture.
 */
export interface Clock {
  today(): IsoDate;
}

// --- Etat du portefeuille ---------------------------------------------------

/** Poids par actif. Leur somme vaut 1 a 1e-8 pres (C4). */
export type Weights = Readonly<Record<AllowedAsset, Weight>>;

/** Bougie journaliere. Cloture a 00:00 UTC, voir la note de source de la fixture. */
export interface Candle {
  readonly date: IsoDate;
  readonly asset: AllowedAsset;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
}

/** Apport (montant positif) ou retrait (montant negatif). */
export interface CashFlow {
  readonly occurredOn: IsoDate;
  readonly amount: UsdcAmount;
  readonly note?: string;
}

// --- Intention, ordre, verdict ----------------------------------------------

/**
 * `asset` et `quote` sont des chaines libres, pas `AllowedAsset`. Un type ferme
 * rendrait `ASSET_NOT_ALLOWED` et `QUOTE_NOT_ALLOWED` inatteignables : la couche
 * risque s'applique a toute intention quelle que soit son origine, elle doit
 * pouvoir en recevoir une invalide.
 *
 * Une jambe est libellee en USDC, pas en unites d'actif : c'est la forme dont
 * raisonnent C19 (jambe sous 200 USDC ignoree) et C20 (somme des jambes sur la
 * valeur totale). La quantite d'actif n'apparait qu'a la conversion en `Order`,
 * ou elle vaut `amount / limitPrice`.
 */
export interface IntentLeg {
  readonly asset: string;
  readonly quote: string;
  readonly side: Side;
  /** Toujours positif : le sens est porte par `side`. */
  readonly amount: UsdcAmount;
  readonly limitPrice: Price;
}

/** Sortie de `decide()`. Vide dans le cas nominal. */
export interface Intent {
  readonly runDate: IsoDate;
  readonly strategy: StrategyName;
  readonly trigger: Trigger;
  /** Lisible : poids constates face aux bandes. */
  readonly reason: string;
  readonly weightsBefore: Weights;
  readonly weightsTarget: Weights;
  readonly legs: readonly IntentLeg[];
}

/**
 * Jambe validee par la couche risque. `asset` y est ferme, `quote` fige a USDC.
 * `quantity` est en unites d'actif : la conversion depuis l'`UsdcAmount` de la
 * jambe est le seul endroit du systeme ou la division par le prix a lieu, et le
 * changement de marque est ce qui interdit de l'oublier.
 */
export interface Order {
  readonly clientOrderId: string;
  readonly asset: AllowedAsset;
  readonly quote: 'USDC';
  readonly side: Side;
  readonly quantity: Quantity;
  readonly limitPrice: Price;
}

export interface Rejection {
  readonly code: RejectionCode;
  readonly reason: string;
  /** Renseigne quand le motif porte sur une jambe et non sur le run. */
  readonly legIndex?: number;
}

/**
 * `ignored` porte les jambes filtrees, `LEG_TOO_SMALL` en particulier : une
 * jambe residuelle de 12 USDC est ecartee, elle ne fait pas echouer le run.
 * Confondre les deux est l'erreur que C19 interdit, la separer ici la rend
 * impossible a commettre en aval.
 */
export type Verdict =
  | {
      readonly status: 'ACCEPTED';
      readonly orders: readonly Order[];
      readonly ignored: readonly Rejection[];
    }
  | { readonly status: 'REJECTED'; readonly rejections: readonly Rejection[] };
