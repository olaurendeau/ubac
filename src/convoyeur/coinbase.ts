import { Decimal } from 'decimal.js';
import ccxt from 'ccxt';

import type { Quantity } from '../core/types.js';

/**
 * Le compte Coinbase du convoyeur : *Primary*, par sa propre cle (D1).
 *
 * `src/adapters/coinbase.ts` n'est pas reutilise, et c'est voulu (plan, point
 * 1) : ses types interdisent l'ordre au marche et ne savent pas transferer. Le
 * transport a ses six routes **enumerees** (`CONVOYEUR_ROUTES`), aucune
 * generique, aucune v2 ; le bloc convoyeur d'`eslint.config.js` tient CV4
 * sur l'arbre (lot Y3b). Trois proprietes :
 *
 * 1. **La cle se verifie avant toute action** (CV1) : *Primary* pose par
 *    l'operateur, `portfolio_type` `DEFAULT`, les trois permissions au booleen
 *    `true`. `keyPermissions` seule rend la cle sans verdict.
 * 2. **`moveFunds` refuse avant tout appel** une source autre que *Primary* ou
 *    une destination autre que `ubac-agent`, en egalite exacte (CV2, DC2).
 * 3. **`move_funds` ne rend rien d'utile** (S7) : `moveFunds` rend « demande »,
 *    jamais « fait », qui se constate a la relecture du solde (Y4b).
 */

export class ConvoyeurFrontierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvoyeurFrontierError';
  }
}

/**
 * Recopie de `src/adapters/coinbase.ts`, et non import : le convoyeur n'importe
 * d'`adapters/` que `schema.ts` et `http.ts` (point 1). Meme raison : `decimal.js`
 * accepte `NaN`, `Infinity` et `0x10`, contre lesquels aucun seuil ne mord, et
 * un `number` a deja perdu sa precision.
 */
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function decimalFromApi(value: unknown, contexte: string): Decimal {
  if (typeof value !== 'string' || !DECIMAL_TEXT.test(value)) {
    throw new ConvoyeurFrontierError(
      `${contexte} : decimale litterale en chaine attendue, recu ${JSON.stringify(value)}.`,
    );
  }
  return new Decimal(value);
}

// --- Les routes ---------------------------------------------------------------

export const PRODUIT = 'USDC-EUR';

/** Le seul montant engage (Q6, DC8). Type litteral : un autre montant ne compile pas. */
export const QUOTE_SIZE = '100';

/** Market `BUY` USDC-EUR en `quote_size` (Q8, S1). */
export interface MarketBuyBody {
  readonly client_order_id: string;
  readonly product_id: typeof PRODUIT;
  readonly side: 'BUY';
  readonly order_configuration: {
    readonly market_market_ioc: { readonly quote_size: typeof QUOTE_SIZE };
  };
}

/** Le corps de `move_funds` (S7), en USDC et rien d'autre. */
export interface MoveFundsBody {
  readonly funds: { readonly value: string; readonly currency: 'USDC' };
  readonly source_portfolio_uuid: string;
  readonly target_portfolio_uuid: string;
}

/** Ajouter une route modifie ce type **et** `CONVOYEUR_ROUTES`, que le test enumere. */
export type ConvoyeurRoute =
  | { readonly kind: 'key_permissions' }
  | { readonly kind: 'accounts'; readonly cursor?: string }
  | { readonly kind: 'create_market_buy'; readonly body: MarketBuyBody }
  | { readonly kind: 'order'; readonly exchangeId: string }
  | { readonly kind: 'move_funds'; readonly body: MoveFundsBody }
  | { readonly kind: 'transaction_summary' };

export const CONVOYEUR_ROUTES = [
  'key_permissions',
  'accounts',
  'create_market_buy',
  'order',
  'move_funds',
  'transaction_summary',
] as const satisfies readonly ConvoyeurRoute['kind'][];

/** La couche que les tests remplacent. */
export interface ConvoyeurTransport {
  call(route: ConvoyeurRoute): Promise<unknown>;
  close(): Promise<void>;
}

const PAGE_SIZE = 250;
const MAX_PAGES = 20;

/**
 * ccxt en pilote de signature et en client HTTP, jamais ses methodes unifiees,
 * qui passent par la v2 (`fetchBalance`, `withdraw`). Un refus de l'exchange
 * (`success: false`) y leve : le passage s'arrete, le corps dans le message.
 */
export function ccxtConvoyeurTransport(cle: {
  readonly apiKey: string;
  readonly apiSecret: string;
}): ConvoyeurTransport {
  const exchange = new ccxt.coinbase({ apiKey: cle.apiKey, secret: cle.apiSecret });
  return {
    async call(route: ConvoyeurRoute): Promise<unknown> {
      switch (route.kind) {
        case 'key_permissions':
          return exchange.v3PrivateGetBrokerageKeyPermissions();
        case 'accounts':
          return exchange.v3PrivateGetBrokerageAccounts({
            limit: PAGE_SIZE,
            ...(route.cursor === undefined ? {} : { cursor: route.cursor }),
          });
        case 'create_market_buy':
          return exchange.v3PrivatePostBrokerageOrders(route.body);
        case 'order':
          // La liste filtree, comme Ubac : un identifiant inconnu y rend `orders: []`.
          return exchange.v3PrivateGetBrokerageOrdersHistoricalBatch({ order_ids: [route.exchangeId] });
        case 'move_funds':
          return exchange.v3PrivatePostBrokeragePortfoliosMoveFunds(route.body);
        case 'transaction_summary':
          return exchange.v3PrivateGetBrokerageTransactionSummary({ product_type: 'SPOT' });
      }
    },
    close: () => exchange.close(),
  };
}

// --- Le port ------------------------------------------------------------------

export interface ClePermissions {
  readonly portfolioUuid: string;
  readonly portfolioType: string;
  readonly canView: boolean;
  readonly canTrade: boolean;
  readonly canTransfer: boolean;
}

/** Pose a la construction : un controle ne s'esquive pas par l'ordre des appels. */
export interface ConvoyeurAttendu {
  readonly primaryUuid: string;
  /** L'UUID d'`ubac-agent`, seule destination admise. */
  readonly destinationUuid: string;
  /** Recoit la ligne de la cle, une fois par passage, avant tout verdict. */
  readonly log: (line: string) => void;
}

/**
 * `Quantity`, comme les soldes d'Ubac : la requalification en montant EUR ou
 * USDC revient a l'appelant. `available` seul est negociable (U3).
 */
export interface Solde {
  readonly available: Quantity;
  readonly hold: Quantity;
}

/** `filledSize` est l'USDC recu ; `filledValue` et `totalFees` sont en EUR (S6). */
export interface OrdreConnu {
  readonly kind: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly filledSize: Quantity;
  readonly filledValue: Quantity;
  readonly totalFees: Quantity;
}

export interface ConvoyeurCoinbase {
  keyPermissions(): Promise<ClePermissions>;
  balances(): Promise<{ readonly eur: Solde; readonly usdc: Solde }>;
  /** Un `client_order_id` rejoue rend l'ordre existant (S5), sous le meme `exchangeId`. */
  marketBuy(clientOrderId: string): Promise<{ readonly exchangeId: string }>;
  order(exchangeId: string): Promise<OrdreConnu | { readonly kind: 'INDETERMINABLE'; readonly reason: string }>;
  moveFunds(demande: {
    readonly source: string;
    readonly destination: string;
    readonly usdc: Decimal;
  }): Promise<{ readonly kind: 'DEMANDE'; readonly usdc: Quantity }>;
  /** Le palier de frais de la cle (U2). */
  feeTier(): Promise<{ readonly pricingTier: string; readonly makerFeeRate: Decimal; readonly takerFeeRate: Decimal }>;
  close(): Promise<void>;
}

export const CONVOYEUR_METHODS = [
  'keyPermissions',
  'balances',
  'marketBuy',
  'order',
  'moveFunds',
  'feeTier',
  'close',
] as const satisfies readonly (keyof ConvoyeurCoinbase)[];

// --- Relecture ----------------------------------------------------------------

function asRecord(raw: unknown, contexte: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConvoyeurFrontierError(`${contexte} : objet attendu, recu ${JSON.stringify(raw)}.`);
  }
  return raw as Readonly<Record<string, unknown>>;
}

function asList(raw: unknown, contexte: string): readonly unknown[] {
  if (!Array.isArray(raw)) throw new ConvoyeurFrontierError(`${contexte} : liste attendue.`);
  return raw;
}

function asText(raw: unknown, contexte: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ConvoyeurFrontierError(`${contexte} : chaine non vide attendue, recu ${JSON.stringify(raw)}.`);
  }
  return raw;
}

/** Present et booleen : ni `"true"`, ni absent. Une permission ne se devine pas. */
function asBoolean(raw: unknown, contexte: string): boolean {
  if (typeof raw !== 'boolean') {
    throw new ConvoyeurFrontierError(`${contexte} : booleen attendu, recu ${JSON.stringify(raw)}.`);
  }
  return raw;
}

const KEY_FIELDS: ReadonlySet<string> = new Set([
  'can_view',
  'can_trade',
  'can_transfer',
  'portfolio_uuid',
  'portfolio_type',
]);

function permissionsFrom(raw: unknown): ClePermissions {
  const record = asRecord(raw, 'key_permissions');
  // Comme Ubac : un champ inconnu qui n'est pas le booleen `false` est refuse.
  const inconnus = Object.entries(record).filter(([nom, valeur]) => !KEY_FIELDS.has(nom) && valeur !== false);
  if (inconnus.length > 0) {
    throw new ConvoyeurFrontierError(
      `key_permissions : champ inconnu, pas franchement refuse (${inconnus.map(([nom]) => nom).join(', ')}).`,
    );
  }
  return {
    portfolioUuid: asText(record['portfolio_uuid'], 'key_permissions.portfolio_uuid'),
    portfolioType: asText(record['portfolio_type'], 'key_permissions.portfolio_type'),
    canView: asBoolean(record['can_view'], 'key_permissions.can_view'),
    canTrade: asBoolean(record['can_trade'], 'key_permissions.can_trade'),
    canTransfer: asBoolean(record['can_transfer'], 'key_permissions.can_transfer'),
  };
}

/** CV1 : les motifs de refus, vide pour la cle attendue. */
function refusDeCle(cle: ClePermissions, primaryUuid: string): readonly string[] {
  return [
    cle.portfolioUuid === primaryUuid ? '' : `portefeuille ${cle.portfolioUuid}, Primary attendu ${primaryUuid}`,
    cle.portfolioType === 'DEFAULT' ? '' : `portfolio_type ${cle.portfolioType}, DEFAULT attendu`,
    cle.canView ? '' : 'can_view false',
    cle.canTrade ? '' : 'can_trade false',
    cle.canTransfer ? '' : 'can_transfer false',
  ].filter((motif) => motif !== '');
}

/**
 * Le controle de `balanceFrom` d'Ubac, recopie : le scoping de la cle est une
 * reduction de surface, pas une barriere (`docs/cle-coinbase.md`). Un compte
 * d'un autre portefeuille arrete la lecture ; filtrer rendrait un solde faux.
 */
function soldeFrom(raw: unknown, primaryUuid: string): readonly [string, Solde] {
  const record = asRecord(raw, 'accounts[]');
  const currency = asText(record['currency'], 'accounts[].currency');
  const contexte = `accounts[${currency}]`;
  const rattachement = asText(record['retail_portfolio_id'], `${contexte}.retail_portfolio_id`);
  if (rattachement !== primaryUuid) {
    throw new ConvoyeurFrontierError(
      `${contexte} : compte rattache au portefeuille ${rattachement}, la cle est scopee sur ${primaryUuid}.`,
    );
  }
  const valeur = (brut: unknown, champ: string): Quantity =>
    decimalFromApi(asRecord(brut, `${contexte}.${champ}`)['value'], `${contexte}.${champ}`) as Quantity;
  return [
    currency,
    { available: valeur(record['available_balance'], 'available_balance'), hold: valeur(record['hold'], 'hold') },
  ];
}

/**
 * En v3, un compte n'existe qu'une fois la devise utilisee (capture d'Ubac du
 * 2026-09-11 : un seul compte, EUR). Absent, il vaut zero ; en double, il arrete.
 */
function soldeDe(soldes: readonly (readonly [string, Solde])[], devise: string): Solde {
  const trouves = soldes.filter(([currency]) => currency === devise);
  if (trouves.length > 1) throw new ConvoyeurFrontierError(`accounts : ${String(trouves.length)} comptes ${devise}.`);
  const zero = new Decimal(0) as Quantity;
  return trouves[0]?.[1] ?? { available: zero, hold: zero };
}

function achatFrom(raw: unknown, clientOrderId: string): { readonly exchangeId: string } {
  const contexte = `create_market_buy[${clientOrderId}]`;
  const reponse = asRecord(raw, contexte);
  if (reponse['success'] !== true) {
    throw new ConvoyeurFrontierError(`${contexte} : achat non accepte, ${JSON.stringify(reponse['error_response'])}.`);
  }
  // S5 : un rejeu rend l'ordre existant, sous la forme d'une creation — lu comme tel (Y3, piege 4).
  const accepte = asRecord(reponse['success_response'], `${contexte}.success_response`);
  const rendu = asText(accepte['client_order_id'], `${contexte}.client_order_id`);
  if (rendu !== clientOrderId) throw new ConvoyeurFrontierError(`${contexte} : l'exchange repond pour ${rendu}.`);
  return { exchangeId: asText(accepte['order_id'], `${contexte}.order_id`) };
}

const STATUTS = new Map<string, OrdreConnu['kind']>([
  ['PENDING', 'OPEN'],
  ['QUEUED', 'OPEN'],
  ['OPEN', 'OPEN'],
  ['CANCEL_QUEUED', 'OPEN'],
  ['FILLED', 'FILLED'],
  ['CANCELLED', 'CANCELLED'],
  ['EXPIRED', 'EXPIRED'],
  ['FAILED', 'FAILED'],
]);

/**
 * L'ordre lu est **celui du convoyeur** : `BUY` USDC-EUR de 100 EUR en
 * `quote_size`, sinon la lecture s'arrete — ce n'est pas son `filled_size` qui
 * doit partir vers `ubac-agent`. Un statut inconnu ne se replie sur rien.
 */
function ordreFrom(raw: unknown, exchangeId: string): Awaited<ReturnType<ConvoyeurCoinbase['order']>> {
  const liste = asList(asRecord(raw, 'order')['orders'], 'order.orders');
  const contexte = `order[${exchangeId}]`;
  const [brut] = liste;
  if (brut === undefined) return { kind: 'INDETERMINABLE', reason: `${contexte} : inconnu de l'exchange.` };
  const record = asRecord(brut, contexte);
  const lu = asText(record['order_id'], `${contexte}.order_id`);
  const configuration = asRecord(record['order_configuration'], `${contexte}.order_configuration`);
  const marche = asRecord(configuration['market_market_ioc'], `${contexte}.market_market_ioc`);
  const montant = decimalFromApi(marche['quote_size'], `${contexte}.quote_size`);
  const celuiDuConvoyeur =
    record['product_id'] === PRODUIT && record['side'] === 'BUY' && montant.eq(QUOTE_SIZE);
  if (liste.length > 1 || lu !== exchangeId || !celuiDuConvoyeur) {
    throw new ConvoyeurFrontierError(
      `${contexte} : ${String(liste.length)} ordre(s), dont ${lu}, ${String(record['side'])} ${String(record['product_id'])} de ${montant.toFixed()}. Pas l'achat du convoyeur.`,
    );
  }
  const filledSize = decimalFromApi(record['filled_size'], `${contexte}.filled_size`) as Quantity;
  const statut = asText(record['status'], `${contexte}.status`);
  const kind = STATUTS.get(statut);
  if (kind === undefined) {
    return { kind: 'INDETERMINABLE', reason: `${contexte} : statut ${statut}, USDC recu ${filledSize.toFixed()}.` };
  }
  return {
    kind,
    exchangeId,
    clientOrderId: asText(record['client_order_id'], `${contexte}.client_order_id`),
    filledSize,
    filledValue: decimalFromApi(record['filled_value'], `${contexte}.filled_value`) as Quantity,
    totalFees: decimalFromApi(record['total_fees'], `${contexte}.total_fees`) as Quantity,
  };
}

/** `has_next` / `cursor`, borne : un curseur qui ne progresse pas n'est pas une boucle infinie. */
async function comptes(transport: ConvoyeurTransport): Promise<readonly unknown[]> {
  const elements: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const route = { kind: 'accounts', ...(cursor === undefined ? {} : { cursor }) } as const;
    const reponse = asRecord(await transport.call(route), 'accounts');
    elements.push(...asList(reponse['accounts'], 'accounts'));
    const suivant = reponse['cursor'];
    if (reponse['has_next'] !== true || typeof suivant !== 'string' || suivant.length === 0) return elements;
    cursor = suivant;
  }
  throw new ConvoyeurFrontierError(`accounts : plus de ${String(MAX_PAGES)} pages.`);
}

// --- Ouverture ----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Le corps d'achat d'un convoyage. Le montant n'est pas un parametre. */
export function marketBuyBody(clientOrderId: string): MarketBuyBody {
  return {
    client_order_id: asText(clientOrderId, 'client_order_id'),
    product_id: PRODUIT,
    side: 'BUY',
    order_configuration: { market_market_ioc: { quote_size: QUOTE_SIZE } },
  };
}

export function openConvoyeurCoinbase(transport: ConvoyeurTransport, attendu: ConvoyeurAttendu): ConvoyeurCoinbase {
  const { primaryUuid, destinationUuid } = attendu;
  if (!UUID.test(primaryUuid) || !UUID.test(destinationUuid) || primaryUuid === destinationUuid) {
    throw new ConvoyeurFrontierError(
      `Primary "${primaryUuid}" et ubac-agent "${destinationUuid}" : deux UUID distincts, en minuscules, attendus.`,
    );
  }

  // Lue une fois par passage ; une promesse rejetee reste un refus.
  let permissions: Promise<ClePermissions> | undefined;
  const lirePermissions = (): Promise<ClePermissions> => {
    permissions ??= transport.call({ kind: 'key_permissions' }).then((raw) => {
      const cle = permissionsFrom(raw);
      attendu.log(
        `cle convoyeur — portefeuille=${cle.portfolioUuid} type=${cle.portfolioType} can_view=${String(cle.canView)} can_trade=${String(cle.canTrade)} can_transfer=${String(cle.canTransfer)}`,
      );
      return cle;
    });
    return permissions;
  };
  const cleAcceptee = async (): Promise<void> => {
    const motifs = refusDeCle(await lirePermissions(), primaryUuid);
    if (motifs.length > 0) throw new ConvoyeurFrontierError(`key_permissions : cle refusee (${motifs.join(' ; ')}).`);
  };

  return {
    keyPermissions: lirePermissions,

    async balances() {
      await cleAcceptee();
      const soldes = (await comptes(transport)).map((brut) => soldeFrom(brut, primaryUuid));
      return { eur: soldeDe(soldes, 'EUR'), usdc: soldeDe(soldes, 'USDC') };
    },

    async marketBuy(clientOrderId) {
      const body = marketBuyBody(clientOrderId);
      await cleAcceptee();
      return achatFrom(await transport.call({ kind: 'create_market_buy', body }), clientOrderId);
    },

    async order(exchangeId) {
      await cleAcceptee();
      return ordreFrom(await transport.call({ kind: 'order', exchangeId }), exchangeId);
    },

    async moveFunds({ source, destination, usdc }) {
      // CV2 : avant tout appel, cle comprise. Egalite exacte : ni prefixe, ni casse repliee.
      if (source !== primaryUuid) {
        throw new ConvoyeurFrontierError(`move_funds : source ${source} refusee, seule Primary ${primaryUuid} est admise.`);
      }
      if (destination !== destinationUuid) {
        throw new ConvoyeurFrontierError(
          `move_funds : destination ${destination} refusee, seule ubac-agent ${destinationUuid} est admise.`,
        );
      }
      const value = usdc.toFixed();
      if (!DECIMAL_TEXT.test(value) || !usdc.gt(0)) {
        throw new ConvoyeurFrontierError(`move_funds : montant USDC ${value} refuse, positif attendu.`);
      }
      await cleAcceptee();
      const body: MoveFundsBody = {
        funds: { value, currency: 'USDC' },
        source_portfolio_uuid: primaryUuid,
        target_portfolio_uuid: destinationUuid,
      };
      const reponse = asRecord(await transport.call({ kind: 'move_funds', body }), 'move_funds');
      if (reponse['source_portfolio_uuid'] !== primaryUuid || reponse['target_portfolio_uuid'] !== destinationUuid) {
        throw new ConvoyeurFrontierError(`move_funds : reponse ${JSON.stringify(reponse)}, pas les portefeuilles demandes.`);
      }
      return { kind: 'DEMANDE', usdc: new Decimal(value) as Quantity };
    },

    async feeTier() {
      await cleAcceptee();
      const reponse = asRecord(await transport.call({ kind: 'transaction_summary' }), 'transaction_summary');
      const palier = asRecord(reponse['fee_tier'], 'fee_tier');
      return {
        pricingTier: asText(palier['pricing_tier'], 'fee_tier.pricing_tier'),
        makerFeeRate: decimalFromApi(palier['maker_fee_rate'], 'fee_tier.maker_fee_rate'),
        takerFeeRate: decimalFromApi(palier['taker_fee_rate'], 'fee_tier.taker_fee_rate'),
      };
    },

    close: () => transport.close(),
  };
}
