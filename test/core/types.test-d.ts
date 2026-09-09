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
const weight = new Decimal('0.4') as Weight;

// --- C3 : aucun `number` flottant porteur d'un prix, d'une quantite, d'un poids

// @ts-expect-error un number n'est pas un Price
const notAPrice: Price = 68000;
// @ts-expect-error un number n'est pas une Quantity
const notAQuantity: Quantity = 0.35;
// @ts-expect-error un number n'est pas un Weight
const notAWeight: Weight = 0.4;

// --- La marque, sans quoi C3 s'arreterait au bannissement de `number` --------

// Un Decimal nu n'est aucune des trois grandeurs : c'est ce qui empeche
// `prix.mul(qte)` de se glisser la ou un prix est attendu.
// @ts-expect-error un Decimal nu n'est pas un Price
const bare: Price = new Decimal('68000');

// @ts-expect-error un prix n'est pas une quantite
const confusion: Quantity = price;
// @ts-expect-error un poids n'est pas un prix
const inversion: Price = weight;

// Dans l'autre sens la marque ne gene pas : une grandeur reste un Decimal.
const widened: Decimal = price;

// --- Fermetures d'unions -----------------------------------------------------

// @ts-expect-error EUR n'est pas dans la liste blanche
const badAsset: AllowedAsset = 'EUR';

const leg: IntentLeg = {
  asset: 'BTC',
  // Chaine libre cote intention : sans cela QUOTE_NOT_ALLOWED serait inatteignable.
  quote: 'EUR',
  side: 'SELL',
  amountUsdc: quantity,
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

const flow: CashFlow = { occurredOn: '2026-08-24', amountUsdc: quantity };

const ignored: Rejection = { code: 'LEG_TOO_SMALL', reason: 'jambe a 12 USDC', legIndex: 2 };

// @ts-expect-error un verdict ACCEPTED ne porte pas de rejets bloquants
const badVerdict: Verdict = { status: 'ACCEPTED', rejections: [] };

const verdict: Verdict = { status: 'ACCEPTED', orders: [], ignored: [ignored] };

// Consommes pour que rien ci-dessus ne soit elide, sans exporter de surface.
export type Anchors = [
  typeof notAPrice,
  typeof notAQuantity,
  typeof notAWeight,
  typeof bare,
  typeof confusion,
  typeof inversion,
  typeof widened,
  typeof badAsset,
  typeof badOrder,
  typeof intent,
  typeof flow,
  typeof verdict,
];
