import { Decimal } from 'decimal.js';

import type {
  AllowedAsset,
  Intent,
  IntentLeg,
  IsoDate,
  Order,
  Quantity,
  Rejection,
  Side,
  Verdict,
} from './types.js';

/**
 * Couche de risque. Elle est le seul point de passage entre une `Intent`, qui
 * n'est qu'une proposition, et des `Order`, qui sont executables.
 *
 * Cette etape pose la structure de `validate()` et les trois regles qui se
 * jugent jambe par jambe. Les regles sur l'etat projete (`MAX_EXPOSURE`,
 * `MIN_CASH`, `REBALANCE_TOO_LARGE`) et les regles contextuelles (`COOLDOWN`,
 * `PRICE_SANITY`, `RECONCILIATION_DRIFT`) viennent aux etapes suivantes et se
 * greffent sur `RiskContext` et sur la passe run.
 *
 * Aucune fonction publique n'accepte de parametre de contournement : il n'y a
 * pas de mode degrade, pas de drapeau d'essai, pas d'option de passage en
 * cavalier. Une intention est valide ou elle ne l'est pas.
 */

// --- Parametres -------------------------------------------------------------

/**
 * Seuil sous lequel une jambe est ecartee du run (C19). Strict : une jambe a
 * exactement 200 USDC passe, c'est *sous* le seuil qu'on ecarte.
 */
export const MIN_LEG_USDC = new Decimal('200');

/** La seule devise de cotation de la phase 0 (C18). */
export const QUOTE: Extract<AllowedAsset, 'USDC'> = 'USDC';

/**
 * Actifs negociables. USDC n'en fait pas partie : c'est la devise de cotation,
 * pas une ligne qu'on achete. Une jambe `USDC-USDC` n'a pas de sens et tombe
 * donc sous `ASSET_NOT_ALLOWED` — mieux vaut la refuser bruyamment que de la
 * laisser produire un ordre sur soi-meme.
 */
const TRADABLE_ASSETS = ['BTC', 'ETH'] as const;

type TradableAsset = (typeof TRADABLE_ASSETS)[number];

// --- Contexte ---------------------------------------------------------------

/** Les quatre composantes dont depend un `client_order_id` deterministe. */
export interface OrderIdParts {
  readonly runDate: IsoDate;
  readonly asset: AllowedAsset;
  readonly side: Side;
  readonly legIndex: number;
}

/**
 * `core/order-id.ts` n'existe pas encore : la fabrique est injectee, comme
 * l'horloge. Elle est requise et sans valeur par defaut — un defaut serait un
 * generateur muet qu'on oublierait de remplacer, et deux ordres distincts
 * pourraient partager un identifiant sans que rien ne le signale.
 */
export type MakeClientOrderId = (parts: OrderIdParts) => string;

/**
 * Ce dont la validation a besoin en plus de l'intention. Grandit aux etapes
 * suivantes : etat du portefeuille, date du dernier reequilibrage complet,
 * prix de reference, soldes constates.
 */
export interface RiskContext {
  readonly makeClientOrderId: MakeClientOrderId;
}

// --- Regles par jambe -------------------------------------------------------

/**
 * Le resultat porte l'actif restreint plutot qu'un simple booleen : c'est ce
 * qui permet a `toOrder()` de construire un `Order` sans re-affirmer par un
 * cast ce que le controle vient d'etablir.
 */
type Screening =
  | { readonly ok: true; readonly asset: TradableAsset }
  | { readonly ok: false; readonly rejection: Rejection };

function isTradable(asset: string): asset is TradableAsset {
  return (TRADABLE_ASSETS as readonly string[]).includes(asset);
}

/**
 * Les deux regles bloquantes de cette etape. Elles passent avant le filtre de
 * taille : une jambe de 12 USDC libellee en EUR est le symptome d'un bug en
 * amont, l'ecarter en silence parce qu'elle est petite reviendrait a l'effacer.
 */
function screenLeg(leg: IntentLeg, legIndex: number): Screening {
  if (!isTradable(leg.asset)) {
    return {
      ok: false,
      rejection: {
        code: 'ASSET_NOT_ALLOWED',
        reason: `actif ${leg.asset} hors liste blanche (${TRADABLE_ASSETS.join(', ')})`,
        legIndex,
      },
    };
  }

  if (leg.quote !== QUOTE) {
    return {
      ok: false,
      rejection: {
        code: 'QUOTE_NOT_ALLOWED',
        reason: `paire ${leg.asset}-${leg.quote} : la phase 0 ne cote qu'en ${QUOTE}`,
        legIndex,
      },
    };
  }

  return { ok: true, asset: leg.asset };
}

/**
 * `LEG_TOO_SMALL` n'est pas un rejet, c'est un filtre (C19). Il sort par
 * `ignored`, jamais par `rejections` : confondre les deux fait echouer un
 * reequilibrage entier a cause d'un residu de 12 USDC.
 */
function tooSmall(leg: IntentLeg, legIndex: number): Rejection {
  return {
    code: 'LEG_TOO_SMALL',
    reason: `jambe a ${leg.amount.toString()} USDC, sous le minimum de ${MIN_LEG_USDC.toString()} USDC`,
    legIndex,
  };
}

/**
 * Le seul endroit du systeme ou la division par le prix limite a lieu. La
 * jambe est libellee en USDC, l'ordre en unites d'actif : reporter le montant
 * tel quel dans `quantity` enverrait un ordre plusieurs ordres de grandeur
 * trop gros. Le changement de marque est ce qui interdit de l'oublier.
 */
function toOrder(
  runDate: IsoDate,
  leg: IntentLeg,
  asset: TradableAsset,
  legIndex: number,
  context: RiskContext,
): Order {
  return {
    clientOrderId: context.makeClientOrderId({ runDate, asset, side: leg.side, legIndex }),
    asset,
    quote: QUOTE,
    side: leg.side,
    quantity: leg.amount.div(leg.limitPrice) as Quantity,
    limitPrice: leg.limitPrice,
  };
}

// --- Point d'entree ---------------------------------------------------------

/**
 * Traduit une intention en verdict. Un seul motif bloquant sur une jambe rejette
 * le run entier : les jambes d'un reequilibrage ne sont pas independantes, en
 * executer la moitie laisserait le portefeuille dans un etat que personne n'a
 * decide.
 *
 * L'ordre des ordres suit l'ordre des jambes, sans tri ni regroupement (C23).
 */
export function validate(intent: Intent, context: RiskContext): Verdict {
  const rejections: Rejection[] = [];
  const ignored: Rejection[] = [];
  const orders: Order[] = [];

  for (const [legIndex, leg] of intent.legs.entries()) {
    const screening = screenLeg(leg, legIndex);

    if (!screening.ok) {
      rejections.push(screening.rejection);
      continue;
    }

    if (leg.amount.lt(MIN_LEG_USDC)) {
      ignored.push(tooSmall(leg, legIndex));
      continue;
    }

    orders.push(toOrder(intent.runDate, leg, screening.asset, legIndex, context));
  }

  if (rejections.length > 0) {
    return { status: 'REJECTED', rejections };
  }

  return { status: 'ACCEPTED', orders, ignored };
}
