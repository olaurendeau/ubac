import { Decimal } from 'decimal.js';

import { valuate } from './portfolio.js';
import type { Holdings, Prices } from './portfolio.js';
import type {
  AllowedAsset,
  Intent,
  IntentLeg,
  IsoDate,
  Order,
  Price,
  Quantity,
  Rejection,
  Side,
  UsdcAmount,
  Verdict,
} from './types.js';

/** Couche de risque : Intent -> Order. Pas de contournement. */
/** Seuil sous lequel une jambe est ecartee du run (C19). Strict : 200 passe. */
export const MIN_LEG_USDC = new Decimal('200');

export const QUOTE: Extract<AllowedAsset, 'USDC'> = 'USDC';

/** Exposition max par actif sur l'etat projete (C15). Stricte : 50 % passe. */
export const MAX_EXPOSURE_PCT = new Decimal('0.5');

/** Reserve USDC minimale apres application des jambes (C16, C17). */
export const MIN_CASH_PCT = new Decimal('0.22');

/** Ampleur max d'un run : somme des |jambes| / valeur totale (C20). */
export const REBALANCE_TOO_LARGE_PCT = new Decimal('0.25');

/** Delai min entre deux reequilibrages complets (C21). */
export const COOLDOWN_DAYS = 7;

/** Ecart max entre prix limite et mid. Strict : 2 % passe. */
export const PRICE_SANITY_PCT = new Decimal('0.02');

/** Divergence max exchange / interne. Stricte : 1 % passe. */
export const RECONCILIATION_DRIFT_PCT = new Decimal('0.01');

/** Actifs negociables (USDC = quote, pas une ligne). */
const TRADABLE_ASSETS = ['BTC', 'ETH'] as const;

export type TradableAsset = (typeof TRADABLE_ASSETS)[number];

export interface OrderIdParts {
  readonly runDate: IsoDate;
  readonly asset: AllowedAsset;
  readonly side: Side;
  readonly legIndex: number;
}

/** Fabrique injectee, requise, sans defaut. */
export type MakeClientOrderId = (parts: OrderIdParts) => string;

export type MidPrices = Readonly<Partial<Record<AllowedAsset, Price>>>;

/** Solde exchange vs interne ; l.union impose l.unite. */
export type Balance =
  | {
      readonly asset: TradableAsset;
      readonly onExchange: Quantity;
      readonly internal: Quantity;
    }
  | {
      readonly asset: 'USDC';
      readonly onExchange: UsdcAmount;
      readonly internal: UsdcAmount;
    };

/** Run journalise : distingue complet et partiel. */
export interface RebalanceExecution {
  readonly runDate: IsoDate;
  readonly ordersPlaced: number;
  readonly ordersFilled: number;
}

/** Contexte requis en entier : aucun champ optionnel. */
export interface RiskContext {
  readonly makeClientOrderId: MakeClientOrderId;
  readonly mids: MidPrices;
  readonly lastCompleteRebalanceOn: IsoDate | null;
  readonly balances: readonly Balance[];
  readonly holdings: Holdings;
  readonly prices: Prices;
}

const MS_PER_DAY = 86_400_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Jour UTC ; refuse les dates inexistantes via aller-retour ISO. */
function epochDay(field: string, date: IsoDate): number {
  const match = ISO_DATE.exec(date);
  const utc =
    match === null
      ? Number.NaN
      : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`${field} : date UTC attendue au format YYYY-MM-DD, recue "${date}"`);
  }
  return utc / MS_PER_DAY;
}

/** Complet reussi seulement (C21). */
export function armsCooldown(execution: RebalanceExecution): boolean {
  return execution.ordersPlaced > 0 && execution.ordersFilled === execution.ordersPlaced;
}

/** Plus recent run qui arme le cooldown. */
export function cooldownAnchor(history: readonly RebalanceExecution[]): IsoDate | null {
  let anchor: IsoDate | null = null;
  for (const execution of history) {
    if (armsCooldown(execution) && (anchor === null || execution.runDate > anchor)) {
      anchor = execution.runDate;
    }
  }
  return anchor;
}

function cooldown(runDate: IsoDate, anchor: IsoDate | null): Rejection | null {
  if (anchor === null) {
    return null;
  }
  const elapsed = epochDay('runDate', runDate) - epochDay('lastCompleteRebalanceOn', anchor);
  if (elapsed >= COOLDOWN_DAYS) {
    return null;
  }
  return {
    code: 'COOLDOWN',
    reason: `dernier reequilibrage complet le ${anchor}, soit ${String(elapsed)} jour(s) : le minimum est de ${String(COOLDOWN_DAYS)}`,
  };
}

function relativeDrift(onExchange: Decimal, internal: Decimal): Decimal {
  const base = Decimal.max(onExchange.abs(), internal.abs());
  return base.isZero() ? new Decimal(0) : onExchange.sub(internal).abs().div(base);
}

/** Predicat pur (phase 0) ; sort seul avant le reste. */
function reconciliationDrift(balances: readonly Balance[]): Rejection[] {
  const rejections: Rejection[] = [];
  for (const balance of balances) {
    const drift = relativeDrift(balance.onExchange, balance.internal);
    if (drift.gt(RECONCILIATION_DRIFT_PCT)) {
      rejections.push({
        code: 'RECONCILIATION_DRIFT',
        reason: `solde ${balance.asset} : ${balance.onExchange.toString()} sur l'exchange contre ${balance.internal.toString()} en interne, soit ${drift.times(100).toFixed(4)} % d'ecart`,
      });
    }
  }
  return rejections;
}

const asQty = (value: Decimal): Quantity => value as Quantity;

function projectHoldings(
  holdings: Holdings,
  kept: readonly { readonly leg: IntentLeg; readonly asset: TradableAsset }[],
): Holdings {
  let btc: Decimal = holdings.BTC;
  let eth: Decimal = holdings.ETH;
  let cash: Decimal = holdings.USDC;
  for (const { leg, asset } of kept) {
    const qty = leg.amount.div(leg.limitPrice);
    if (leg.side === 'BUY') {
      cash = cash.sub(leg.amount);
      if (asset === 'BTC') btc = btc.add(qty);
      else eth = eth.add(qty);
    } else {
      cash = cash.add(leg.amount);
      if (asset === 'BTC') btc = btc.sub(qty);
      else eth = eth.sub(qty);
    }
  }
  return { BTC: asQty(btc), ETH: asQty(eth), USDC: asQty(cash) };
}

function totalValue(holdings: Holdings, prices: Prices): Decimal {
  const valuation = valuate(holdings, prices);
  if (valuation.status !== 'VALUED') {
    throw new RangeError(`portefeuille non valorisable : ${valuation.code} (${valuation.reason})`);
  }
  return valuation.total;
}

/** Ampleur + etat projete ; ignore si aucune jambe conservee (C16). */
function runStateRules(
  kept: readonly { readonly leg: IntentLeg; readonly asset: TradableAsset }[],
  context: RiskContext,
): Rejection[] {
  if (kept.length === 0) {
    return [];
  }
  const rejections: Rejection[] = [];
  const total = totalValue(context.holdings, context.prices);
  const notional = kept.reduce<Decimal>((acc, { leg }) => acc.add(leg.amount), new Decimal(0));
  if (notional.div(total).gt(REBALANCE_TOO_LARGE_PCT)) {
    rejections.push({
      code: 'REBALANCE_TOO_LARGE',
      reason: `somme des jambes ${notional.toString()} USDC soit ${notional.div(total).times(100).toFixed(4)} % de ${total.toString()}, au-dela de ${REBALANCE_TOO_LARGE_PCT.times(100).toString()} %`,
    });
  }
  const projected = projectHoldings(context.holdings, kept);
  const valuation = valuate(projected, context.prices);
  if (valuation.status !== 'VALUED') {
    throw new RangeError(
      `etat projete non valorisable : ${valuation.code} (${valuation.reason})`,
    );
  }
  for (const asset of TRADABLE_ASSETS) {
    const weight = valuation.weights[asset];
    if (weight.gt(MAX_EXPOSURE_PCT)) {
      rejections.push({
        code: 'MAX_EXPOSURE',
        reason: `exposition projetee ${asset} a ${weight.times(100).toFixed(4)} %, au-dela de ${MAX_EXPOSURE_PCT.times(100).toString()} %`,
      });
    }
  }
  if (valuation.weights.USDC.lt(MIN_CASH_PCT)) {
    rejections.push({
      code: 'MIN_CASH',
      reason: `cash projete a ${valuation.weights.USDC.times(100).toFixed(4)} %, sous le minimum de ${MIN_CASH_PCT.times(100).toString()} %`,
    });
  }
  return rejections;
}

type Screening =
  | { readonly ok: true; readonly asset: TradableAsset }
  | { readonly ok: false; readonly rejection: Rejection };

function isTradable(asset: string): asset is TradableAsset {
  return (TRADABLE_ASSETS as readonly string[]).includes(asset);
}

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

function tooSmall(leg: IntentLeg, legIndex: number): Rejection {
  return {
    code: 'LEG_TOO_SMALL',
    reason: `jambe a ${leg.amount.toString()} USDC, sous le minimum de ${MIN_LEG_USDC.toString()} USDC`,
    legIndex,
  };
}

/** Ecart au mid ; absence de mid = rejet. */
function priceSanity(
  leg: IntentLeg,
  asset: TradableAsset,
  legIndex: number,
  mids: MidPrices,
): Rejection | null {
  const mid = mids[asset];
  if (mid === undefined) {
    return {
      code: 'PRICE_SANITY',
      reason: `aucun prix de reference pour ${asset} : le prix limite n'est comparable a rien`,
      legIndex,
    };
  }
  if (mid.lte(0)) {
    return {
      code: 'PRICE_SANITY',
      reason: `prix de reference ${asset} a ${mid.toString()} : un mid nul ou negatif n'a pas de sens`,
      legIndex,
    };
  }
  const deviation = leg.limitPrice.sub(mid).abs().div(mid);
  if (deviation.gt(PRICE_SANITY_PCT)) {
    return {
      code: 'PRICE_SANITY',
      reason: `prix limite ${leg.limitPrice.toString()} a ${deviation.times(100).toFixed(4)} % du mid ${mid.toString()}, au-dela de ${PRICE_SANITY_PCT.times(100).toString()} %`,
      legIndex,
    };
  }
  return null;
}

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

/** Intent -> Verdict. Un motif bloquant rejette tout le run. */
export function validate(intent: Intent, context: RiskContext): Verdict {
  const drift = reconciliationDrift(context.balances);
  if (drift.length > 0) {
    return { status: 'REJECTED', rejections: drift };
  }
  const rejections: Rejection[] = [];
  const ignored: Rejection[] = [];
  const orders: Order[] = [];
  const kept: { readonly leg: IntentLeg; readonly asset: TradableAsset }[] = [];
  for (const [legIndex, leg] of intent.legs.entries()) {
    const screening = screenLeg(leg, legIndex);
    if (!screening.ok) {
      rejections.push(screening.rejection);
      continue;
    }
    const aberrant = priceSanity(leg, screening.asset, legIndex, context.mids);
    if (aberrant !== null) {
      rejections.push(aberrant);
      continue;
    }
    if (leg.amount.lt(MIN_LEG_USDC)) {
      ignored.push(tooSmall(leg, legIndex));
      continue;
    }
    kept.push({ leg, asset: screening.asset });
    orders.push(toOrder(intent.runDate, leg, screening.asset, legIndex, context));
  }
  // Le cooldown espace des executions : sans ordre, rien a espacer.
  const tooSoon = orders.length > 0 ? cooldown(intent.runDate, context.lastCompleteRebalanceOn) : null;
  if (tooSoon !== null) {
    rejections.push(tooSoon);
  }
  if (rejections.length === 0) {
    rejections.push(...runStateRules(kept, context));
  }
  if (rejections.length > 0) {
    return { status: 'REJECTED', rejections };
  }
  return { status: 'ACCEPTED', orders, ignored };
}