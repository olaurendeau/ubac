import { Decimal } from 'decimal.js';

import type {
  AllowedAsset,
  CashFlow,
  Intent,
  IntentLeg,
  Order,
  Price,
  Quantity,
  Rejection,
  UsdcAmount,
  Verdict,
  Weight,
  Weights,
} from '../../src/core/types.js';

/**
 * Test de types, pas de comportement : il ne tourne pas sous Vitest, il est
 * verifie par `tsc --noEmit`. Son extension `.test-d.ts` le tient volontairement
 * hors du glob de collecte de Vitest, qui n'accepte que `.test.ts`.
 *
 * Chaque `@ts-expect-error` est une assertion a part entiere. Si la protection
 * qu'il documente disparait, tsc echoue sur la directive devenue inutile — la
 * suppression d'un garde-fou casse la compilation au lieu de passer inapercue.
 */

const price = new Decimal('68000') as Price;
const quantity = new Decimal('0.35') as Quantity;
const amount = new Decimal('1500') as UsdcAmount;
const weight = new Decimal('0.4') as Weight;

// --- C3 : aucun `number` flottant porteur d'un prix, d'une quantite, d'un poids

// @ts-expect-error un number n'est pas un Price
const notAPrice: Price = 68000;
// @ts-expect-error un number n'est pas une Quantity
const notAQuantity: Quantity = 0.35;
// @ts-expect-error un number n'est pas un UsdcAmount
const notAnAmount: UsdcAmount = 1500;
// @ts-expect-error un number n'est pas un Weight
const notAWeight: Weight = 0.4;

// --- La marque, sans quoi C3 s'arreterait au bannissement de `number` --------

// Un Decimal nu n'est aucune des quatre grandeurs : c'est ce qui empeche
// `prix.mul(qte)` de se glisser la ou un prix est attendu.
// @ts-expect-error un Decimal nu n'est pas un Price
const bare: Price = new Decimal('68000');

// @ts-expect-error un prix n'est pas une quantite
const confusion: Quantity = price;
// @ts-expect-error un poids n'est pas un prix
const inversion: Price = weight;

// Dans l'autre sens la marque ne gene pas : une grandeur reste un Decimal.
const widened: Decimal = price;

// --- La quatrieme marque : USDC = Price x Quantity ---------------------------

// Les trois confusions dimensionnelles qui rendaient compilable un ordre
// plusieurs ordres de grandeur trop gros, quand USDC et unites d'actif
// partageaient la marque `Quantity`.

// @ts-expect-error 1500 USDC n'est pas une quantite d'actif
const amountAsQuantity: Quantity = amount;
// @ts-expect-error 0.35 BTC n'est pas une somme en USDC
const quantityAsAmount: UsdcAmount = quantity;
// @ts-expect-error un prix unitaire n'est pas une somme en USDC
const priceAsAmount: UsdcAmount = price;

// --- Fermetures d'unions -----------------------------------------------------

// @ts-expect-error EUR n'est pas dans la liste blanche
const badAsset: AllowedAsset = 'EUR';

const leg: IntentLeg = {
  asset: 'BTC',
  // Chaine libre cote intention : sans cela QUOTE_NOT_ALLOWED serait inatteignable.
  quote: 'EUR',
  side: 'SELL',
  amount,
  limitPrice: price,
};

const badOrder: Order = {
  clientOrderId: 'a1b2c3d4',
  asset: 'BTC',
  // @ts-expect-error la quote d'un ordre valide est figee a USDC
  quote: 'EUR',
  side: 'SELL',
  quantity,
  limitPrice: price,
};

/**
 * Le bug que la quatrieme marque existe pour interdire : la conversion d'une
 * jambe en ordre qui reporte le montant en USDC dans `quantity` en oubliant la
 * division par le prix limite. Sous une marque unique, cette ligne compilait.
 */
const oversizedOrder: Order = {
  clientOrderId: 'a1b2c3d4',
  asset: 'BTC',
  quote: 'USDC',
  side: 'SELL',
  // @ts-expect-error 1500 USDC reportes tels quels donneraient un ordre de 1500 BTC
  quantity: leg.amount,
  limitPrice: leg.limitPrice,
};

// La conversion correcte perd la marque et doit etre re-qualifiee explicitement :
// c'est le seul endroit du systeme ou la division par le prix a lieu.
const sizedOrder: Order = {
  clientOrderId: 'a1b2c3d4',
  asset: 'BTC',
  quote: 'USDC',
  side: 'SELL',
  quantity: leg.amount.div(leg.limitPrice) as Quantity,
  limitPrice: leg.limitPrice,
};

// --- Formes composites -------------------------------------------------------

const weights: Weights = { BTC: weight, ETH: weight, USDC: weight };

const intent: Intent = {
  runDate: '2026-08-31',
  strategy: 'rebalance_ab',
  trigger: 'CASH_BAND',
  reason: 'poids USDC a 0.2399, sous la bande basse 0.24',
  weightsBefore: weights,
  weightsTarget: weights,
  legs: [leg],
};

const flow: CashFlow = { occurredOn: '2026-08-24', amount };

const ignored: Rejection = { code: 'LEG_TOO_SMALL', reason: 'jambe a 12 USDC', legIndex: 2 };

// @ts-expect-error un verdict ACCEPTED ne porte pas de rejets bloquants
const badVerdict: Verdict = { status: 'ACCEPTED', rejections: [] };

const verdict: Verdict = { status: 'ACCEPTED', orders: [], ignored: [ignored] };

// Consommes pour que rien ci-dessus ne soit elide, sans exporter de surface.
export type Anchors = [
  typeof notAPrice,
  typeof notAQuantity,
  typeof notAnAmount,
  typeof notAWeight,
  typeof bare,
  typeof confusion,
  typeof inversion,
  typeof widened,
  typeof amountAsQuantity,
  typeof quantityAsAmount,
  typeof priceAsAmount,
  typeof badAsset,
  typeof badOrder,
  typeof oversizedOrder,
  typeof sizedOrder,
  typeof intent,
  typeof flow,
  typeof verdict,
];
