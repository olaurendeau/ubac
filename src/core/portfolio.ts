import { Decimal } from 'decimal.js';

import type { AllowedAsset, Price, Quantity, UsdcAmount, Weight, Weights } from './types.js';

/**
 * Valorisation d'un portefeuille : exposition par actif en USDC, valeur totale
 * en USDC, poids par actif. Pur, sans horloge, sans IO.
 *
 * `valuate` est la seule facon exportee d'obtenir l'une de ces trois grandeurs.
 * Ce n'est pas de la coquetterie : une exposition et une valeur totale exportees
 * nues traversent le garde non fini ci-dessous et rendent NaN. Or `Decimal`
 * repond `false` a `gte`, `lte` et `gt` sur un NaN, donc un seuil compare a une
 * valeur totale NaN ne mord jamais. `MAX_EXPOSURE` (50 % de la valeur totale) et
 * `REBALANCE_TOO_LARGE` (25 % de la valeur totale) passeraient silencieusement,
 * sur un chemin qu'aucun test de couverture ne signale puisque la ligne de
 * comparaison, elle, est bien executee. La seule protection qui tienne est de ne
 * pas laisser sortir la grandeur non gardee.
 */

/**
 * Ordre de parcours fige. Toute somme et toute construction de `Weights` passe
 * par cette liste, jamais par `Object.keys` : l'ordre d'enumeration d'un objet
 * est stable en pratique mais n'est pas un contrat, et le rejeu compare des
 * sorties octet pour octet.
 */
export const ASSETS = ['BTC', 'ETH', 'USDC'] as const satisfies readonly AllowedAsset[];

/** Les actifs qui ont un prix de marche. USDC est la devise de cotation. */
export type PricedAsset = Exclude<AllowedAsset, 'USDC'>;

/** Soldes lus sur le compte, en unites de chaque actif. */
export type Holdings = Readonly<Record<AllowedAsset, Quantity>>;

/**
 * USDC n'y figure pas : son prix vaut 1 par definition de la devise de
 * cotation. Le faire porter par l'appelant ouvrirait la porte a un portefeuille
 * ou 1 USDC ne vaut pas 1 USDC.
 */
export type Prices = Readonly<Record<PricedAsset, Price>>;

/**
 * Valeur en USDC detenue sur chaque actif. C'est bien un montant, pas une
 * fraction : la fraction, c'est le poids. `MAX_EXPOSURE` compare l'une a 50 %
 * de la valeur totale, garder les deux formes distinctes evite de confondre le
 * seuil avec la grandeur qu'il borne.
 */
export type Exposure = Readonly<Record<AllowedAsset, UsdcAmount>>;

/**
 * Aucun des 9 codes de rejet de `RejectionCode` ne decrit un portefeuille qu'on
 * ne sait pas valoriser : ils qualifient une intention, pas un etat. D'ou des
 * codes propres a cette couche.
 */
export type ValuationIssue = 'NON_POSITIVE_VALUE' | 'NON_FINITE_VALUE';

export type Valuation =
  | {
      readonly status: 'VALUED';
      readonly total: UsdcAmount;
      readonly exposure: Exposure;
      readonly weights: Weights;
    }
  | {
      readonly status: 'REJECTED';
      readonly code: ValuationIssue;
      readonly reason: string;
    };

/** 1 USDC vaut 1 USDC. */
const USDC_PRICE = new Decimal(1) as Price;

const ZERO_USDC = new Decimal(0) as UsdcAmount;

/**
 * Les operations de decimal.js retournent un `Decimal` nu : la marque se perd a
 * chaque calcul et doit etre reposee explicitement. Ces deux fonctions sont les
 * seuls endroits du module ou cela arrive, ce qui les rend faciles a relire.
 */
const asUsdc = (value: Decimal): UsdcAmount => value as UsdcAmount;
const asWeight = (value: Decimal): Weight => value as Weight;

function priceOf(asset: AllowedAsset, prices: Prices): Price {
  return asset === 'USDC' ? USDC_PRICE : prices[asset];
}

/** Valeur en USDC de chaque ligne : quantite detenue x prix unitaire. */
function exposureOf(holdings: Holdings, prices: Prices): Exposure {
  return {
    BTC: asUsdc(holdings.BTC.mul(priceOf('BTC', prices))),
    ETH: asUsdc(holdings.ETH.mul(priceOf('ETH', prices))),
    USDC: asUsdc(holdings.USDC.mul(priceOf('USDC', prices))),
  };
}

function sum(exposure: Exposure): UsdcAmount {
  return asUsdc(ASSETS.reduce<Decimal>((acc, asset) => acc.plus(exposure[asset]), new Decimal(0)));
}

export function valuate(holdings: Holdings, prices: Prices): Valuation {
  const exposure = exposureOf(holdings, prices);
  const total = sum(exposure);

  /*
   * Un seul controle suffit pour les trois lignes : NaN et l'infini se
   * propagent par l'addition, une exposition non finie rend forcement le total
   * non fini. Deux infinis de signes opposes ne s'annulent pas en un total fini,
   * ils donnent NaN. Sans ce test, `Decimal.lte` renvoie false sur NaN et les
   * poids sortiraient tous a NaN au lieu d'etre rejetes.
   */
  if (!total.isFinite()) {
    return {
      status: 'REJECTED',
      code: 'NON_FINITE_VALUE',
      reason: `valeur totale non finie (${total.toString()}) : prix ou solde aberrant`,
    };
  }

  if (total.lte(ZERO_USDC)) {
    return {
      status: 'REJECTED',
      code: 'NON_POSITIVE_VALUE',
      reason: `valeur totale a ${total.toString()} USDC : aucun poids n'est defini`,
    };
  }

  /*
   * `Decimal.div` arrondit a 20 chiffres significatifs : sur trois actifs la
   * somme des poids peut manquer 1 de quelques ulps. C4 tolere 1e-8 et absorbe
   * cet ecart. Ne pas deduire le dernier poids des deux autres pour forcer la
   * somme a 1 : cela masquerait une vraie erreur de valorisation derriere une
   * identite comptable toujours vraie.
   */
  return {
    status: 'VALUED',
    total,
    exposure,
    weights: {
      BTC: asWeight(exposure.BTC.div(total)),
      ETH: asWeight(exposure.ETH.div(total)),
      USDC: asWeight(exposure.USDC.div(total)),
    },
  };
}
