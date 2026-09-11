import { Decimal } from 'decimal.js';
import ccxt from 'ccxt';

import type { Secrets } from '../config/env.js';
import type { Price, Quantity, Side } from '../core/types.js';

/**
 * La lecture du compte Coinbase. **Lecture, et rien d'autre.**
 *
 * La surface est close par le type et pas par la discipline : `CoinbaseTransport`
 * n'a qu'un verbe, `read`, qui ne prend qu'une valeur de `CoinbaseRoute`. Aucune
 * ecriture n'est **exprimable**, pas meme en composant ce que ce module exporte,
 * la ou le lint d'`eslint.config.js` interdit seulement d'en ecrire le nom.
 *
 * Trois constats mesures contre la vraie cle le 2026-09-11 gouvernent ce
 * fichier ; `docs/coinbase-lecture.md` les argumente.
 *
 * 1. **Le scoping de la cle au portefeuille est une reduction de surface, pas
 *    une barriere** : il tient sur les endpoints v3 brokerage, pas sur l'API v2,
 *    ou la meme cle a rendu 100 comptes du compte principal contre 1 en v3. Or
 *    le defaut de `fetchBalance()` chez ccxt est `v2PrivateGetAccounts` (4.5.78,
 *    `coinbase.js:440`). D'ou la route `accounts` en v3 **et** le controle de
 *    `retail_portfolio_id` : voir `balanceFrom`, ou est ecrit pourquoi les deux
 *    ne font pas double emploi.
 * 2. **Le claim `uri` du JWT ne doit pas porter la chaine de requete**, sous
 *    peine de 401 sur tout appel parametre. ccxt le tronque ; le test le fige.
 * 3. **Les grandeurs entrent par la chaine d'origine.** On lit les reponses
 *    brutes, jamais les structures unifiees de ccxt, qui rendent des `number`.
 */

// --- Erreur de frontiere ----------------------------------------------------

/**
 * Une reponse qui ne ressemble pas a ce que ce module attend. L'echec est
 * bruyant, comme cote base : une valeur douteuse convertie en `Decimal`
 * contamine tout ce qui la lit ensuite.
 */
export class CoinbaseFrontierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoinbaseFrontierError';
  }
}

// --- Decimal <-> texte d'API ------------------------------------------------

/**
 * Decimale litterale, sans exposant ni hexadecimal. Motif recopie de
 * `src/adapters/schema.ts` et pour la meme raison : `decimal.js` accepte `NaN`,
 * `Infinity` et `0x10`, contre lesquels `gt` et `lt` repondent tous les deux
 * `false` — aucun seuil ne mord.
 */
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Le seul chemin d'entree des grandeurs. Un prix deja rendu en flottant par ccxt
 * a perdu sa precision avant qu'on le voie : le convertir en `Decimal` figerait
 * l'erreur au lieu de l'eviter, d'ou le refus explicite du `number`.
 */
export function decimalFromApi(value: unknown, contexte: string): Decimal {
  if (typeof value !== 'string') {
    throw new CoinbaseFrontierError(
      `${contexte} : chaine attendue de l'API, recu ${typeof value}. Une grandeur deja convertie en number a perdu sa precision, la reconvertir fige l'erreur.`,
    );
  }
  if (!DECIMAL_TEXT.test(value)) {
    throw new CoinbaseFrontierError(
      `${contexte} : decimale litterale attendue, recu "${value}".`,
    );
  }
  return new Decimal(value);
}

// --- Paires : USDC et rien d'autre ------------------------------------------

/** La seule contrepartie que l'agent connaisse. Contrainte fiscale, spec §11. */
export const QUOTE = 'USDC';

export interface ProductPair {
  readonly base: string;
  readonly quote: string;
}

/**
 * Refuse toute paire non cotee en USDC, **a la frontiere**, en plus du rejet
 * `QUOTE_NOT_ALLOWED` du noyau : celui-ci controle ce que l'agent veut faire,
 * celui-la ce que l'exchange raconte. Une cession vers EUR etant un fait
 * generateur d'imposition (spec §11), un ordre `*-EUR` ouvert dans ce
 * portefeuille est une anomalie qui arrete la lecture, pas une donnee a filtrer.
 */
export function requireUsdcQuote(productId: string, contexte: string): ProductPair {
  const parts = productId.split('-');
  const base = parts[0];
  const quote = parts[1];
  if (parts.length !== 2 || base === undefined || quote === undefined || base.length === 0) {
    throw new CoinbaseFrontierError(
      `${contexte} : identifiant de produit attendu sous la forme BASE-${QUOTE}, recu "${productId}".`,
    );
  }
  if (quote !== QUOTE) {
    throw new CoinbaseFrontierError(
      `${contexte} : paire ${productId} refusee, l'agent ne cote qu'en ${QUOTE}. Une cession vers ${quote} serait un fait generateur d'imposition (spec §11).`,
    );
  }
  return { base, quote };
}

// --- Les quatre requetes -----------------------------------------------------

/**
 * Les seules requetes que la phase 1 sait formuler. Aucune ne place, n'annule ni
 * ne retire, et il n'existe pas de route generique par laquelle en fabriquer
 * une : ajouter un chemin est une modification visible de ce type.
 */
export type CoinbaseRoute =
  | { readonly kind: 'key_permissions' }
  | { readonly kind: 'accounts'; readonly cursor?: string }
  | { readonly kind: 'open_orders'; readonly cursor?: string }
  | {
      readonly kind: 'daily_candles';
      readonly product: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
    };

/** Les quatre `kind` ci-dessus, enumerables a l'execution pour le test de surface. */
export const READ_ROUTES = [
  'key_permissions',
  'accounts',
  'open_orders',
  'daily_candles',
] as const;

/**
 * Un verbe, `read`. C'est la couche que les tests remplacent : ils rejouent des
 * reponses reelles capturees, sans reseau et sans cle.
 */
export interface CoinbaseTransport {
  read(route: CoinbaseRoute): Promise<unknown>;
  close(): Promise<void>;
}

/** Nombre maximal de bougies daily par appel, impose par l'API Coinbase. */
export const MAX_CANDLES_PER_CALL = 350;

/** Taille de page des routes paginees, et borne du nombre de pages suivies. */
export const PAGE_SIZE = 250;
const MAX_PAGES = 20;

// --- Le transport reel -------------------------------------------------------

/**
 * ccxt en pilote de signature et en client HTTP, jamais pour ses structures
 * unifiees. Les methodes implicites appelees ici rendent la reponse brute,
 * chaines comprises.
 *
 * La cle est au format Ed25519 et non ECDSA/PEM ; ccxt 4.5.78 la reconnait a la
 * longueur du secret et signe en `EdDSA` (`coinbase.js:5243-5280`), verifie en
 * direct sur les quatre routes.
 */
export function ccxtTransport(
  secrets: Pick<Secrets, 'coinbaseApiKey' | 'coinbaseApiSecret'>,
): CoinbaseTransport {
  const exchange = new ccxt.coinbase({
    apiKey: secrets.coinbaseApiKey,
    secret: secrets.coinbaseApiSecret,
  });

  return {
    async read(route: CoinbaseRoute): Promise<unknown> {
      switch (route.kind) {
        case 'key_permissions':
          return exchange.v3PrivateGetBrokerageKeyPermissions();
        case 'accounts':
          /*
           * v3 et jamais v2 : c'est ici que la separation des portefeuilles
           * tient ou tombe. Voir l'en-tete du module, et `balanceFrom`.
           */
          return exchange.v3PrivateGetBrokerageAccounts({
            limit: PAGE_SIZE,
            ...(route.cursor === undefined ? {} : { cursor: route.cursor }),
          });
        case 'open_orders':
          return exchange.v3PrivateGetBrokerageOrdersHistoricalBatch({
            order_status: 'OPEN',
            limit: PAGE_SIZE,
            ...(route.cursor === undefined ? {} : { cursor: route.cursor }),
          });
        case 'daily_candles':
          /*
           * L'endpoint public : une bougie daily n'appartient a personne, et
           * s'en passer de signature evite de donner a la lecture de marche une
           * raison d'avoir la cle.
           */
          return exchange.v3PublicGetBrokerageMarketProductsProductIdCandles({
            product_id: route.product,
            start: String(route.startSeconds),
            end: String(route.endSeconds),
            granularity: 'ONE_DAY',
          });
      }
    },
    async close(): Promise<void> {
      await exchange.close();
    },
  };
}

// --- Formes exposees --------------------------------------------------------

/**
 * Les permissions effectives de la cle. `can_view` et `can_trade` sont lues
 * nommement ; **toute autre permission a vrai fait echouer la lecture**, ce qui
 * couvre la permission de sortie sans la nommer — `eslint.config.js` en interdit
 * ici le mot meme en lecture — et attrape en prime une permission que Coinbase
 * ajouterait demain. Le test, lui, la nomme : la regle ne vaut pas dans `test/`.
 */
export interface KeyPermissions {
  readonly canView: boolean;
  readonly canTrade: boolean;
  readonly portfolioUuid: string;
}

/**
 * Le solde d'une devise dans le portefeuille. `Quantity` et pas `UsdcAmount`,
 * meme pour la ligne USDC : la requalification en somme d'argent est une
 * decision du job, qui doit s'ecrire, pas se deduire du nom de la devise.
 */
export interface AssetBalance {
  readonly currency: string;
  readonly available: Quantity;
  readonly hold: Quantity;
  readonly total: Quantity;
}

export interface PortfolioBalances {
  readonly portfolioUuid: string;
  readonly balances: readonly AssetBalance[];
}

/**
 * Un ordre non denoue sur l'exchange. `status` n'y figure pas : il vaut `OPEN`
 * par construction, c'est le filtre de la requete et pas une donnee du resultat
 * — meme raisonnement que `pendingOrders` cote base.
 */
export interface OpenOrder {
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly product: string;
  readonly asset: string;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly limitPrice: Price;
  readonly filled: Quantity;
  readonly createdAt: Date;
}

/**
 * La surface entiere de Coinbase pour le reste du programme. Trois lectures et
 * une fermeture. Ce qui n'est pas dans cette liste ne se fait pas.
 */
export interface CoinbaseReader {
  keyPermissions(): Promise<KeyPermissions>;
  balances(): Promise<PortfolioBalances>;
  openOrders(): Promise<readonly OpenOrder[]>;
  close(): Promise<void>;
}

// --- Relecture --------------------------------------------------------------

const SIDES: readonly string[] = ['BUY', 'SELL'] satisfies readonly Side[];

function asRecord(raw: unknown, contexte: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CoinbaseFrontierError(`${contexte} : objet attendu, recu ${JSON.stringify(raw)}.`);
  }
  return raw as Readonly<Record<string, unknown>>;
}

function asList(raw: unknown, contexte: string): readonly unknown[] {
  if (!Array.isArray(raw)) {
    throw new CoinbaseFrontierError(`${contexte} : liste attendue, recu ${typeof raw}.`);
  }
  return raw;
}

function asText(raw: unknown, contexte: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CoinbaseFrontierError(
      `${contexte} : chaine non vide attendue, recu ${JSON.stringify(raw)}.`,
    );
  }
  return raw;
}

/** Le `{value, currency}` que l'API pose sur `available_balance` et `hold`. */
function amount(raw: unknown, contexte: string): Decimal {
  return decimalFromApi(asRecord(raw, contexte)['value'], `${contexte}.value`);
}

function instant(raw: unknown, contexte: string): Date {
  const date = new Date(asText(raw, contexte));
  if (Number.isNaN(date.getTime())) {
    throw new CoinbaseFrontierError(`${contexte} : horodatage illisible (${String(raw)}).`);
  }
  return date;
}

function permissionsFrom(raw: unknown): KeyPermissions {
  const record = asRecord(raw, 'key_permissions');
  /*
   * Toute permission a vrai autre que les deux attendues arrete la lecture. Le
   * nom est repris tel quel dans le message : il vient de la reponse, pas d'un
   * litteral de ce fichier, donc le garde-fou de lint reste satisfait.
   */
  const inattendues = Object.entries(record)
    .filter(([nom, valeur]) => valeur === true && nom !== 'can_view' && nom !== 'can_trade')
    .map(([nom]) => nom);
  if (inattendues.length > 0) {
    throw new CoinbaseFrontierError(
      `key_permissions : permission inattendue accordee a la cle (${inattendues.join(', ')}). La spec §7 n'en admet que la lecture, et le trade a partir de la phase 3.`,
    );
  }
  if (record['can_view'] !== true) {
    throw new CoinbaseFrontierError(
      'key_permissions : can_view est faux, la cle ne peut rien lire du portefeuille.',
    );
  }
  return {
    canView: true,
    canTrade: record['can_trade'] === true,
    portfolioUuid: asText(record['portfolio_uuid'], 'key_permissions.portfolio_uuid'),
  };
}

function balanceFrom(raw: unknown, portfolioUuid: string): AssetBalance {
  const record = asRecord(raw, 'accounts[]');
  const currency = asText(record['currency'], 'accounts[].currency');
  const contexte = `accounts[${currency}]`;
  /*
   * **Ne pas supprimer ce controle en le croyant redondant avec le scoping de
   * la cle.** C'est la conclusion qu'appelle la lecture rapide, et elle est
   * fausse. Mesure du 2026-09-11, cle scopee sur le portefeuille dedie :
   * `/api/v3/brokerage/accounts` a rendu 1 compte, `/v2/accounts` en a rendu 100
   * sur la seule premiere page, portant des devises du compte principal. La
   * separation du portefeuille est une **reduction de surface, pas une
   * barriere** : elle tient sur les endpoints v3 brokerage, pas sur l'API v2.
   * `docs/cle-coinbase.md` porte la correction et la question laissee ouverte.
   *
   * Les deux ne portent donc pas sur le meme objet. Le scoping est une propriete
   * de la cle, evaluee chez Coinbase, dont la portee depend de l'endpoint
   * appele ; ce controle est une propriete de la reponse, evaluee ici, et il
   * vaut pour n'importe quel endpoint qu'un successeur brancherait sur ce
   * module. C'est la seule des deux que le depot possede et sait tester.
   *
   * Un compte rattache ailleurs arrete la lecture, il n'est pas filtre : filtrer
   * rendrait un solde plausible et partiel a partir d'une reponse qui prouve que
   * la cle a deborde de son perimetre.
   */
  const rattachement = asText(record['retail_portfolio_id'], `${contexte}.retail_portfolio_id`);
  if (rattachement !== portfolioUuid) {
    throw new CoinbaseFrontierError(
      `${contexte} : compte rattache au portefeuille ${rattachement}, alors que la cle est scopee sur ${portfolioUuid}. La lecture sort du portefeuille dedie.`,
    );
  }
  const available = amount(record['available_balance'], `${contexte}.available_balance`);
  const hold = amount(record['hold'], `${contexte}.hold`);
  return {
    currency,
    available: available as Quantity,
    hold: hold as Quantity,
    total: available.add(hold) as Quantity,
  };
}

/**
 * Le prix limite et la taille vivent dans `order_configuration`, sous une cle qui
 * depend de la duree de vie (`limit_limit_gtc`, `limit_limit_gtd`, …). On cherche
 * la configuration qui porte les deux **champs** plutot que d'enumerer les cles :
 * une variante future passe, et un ordre au marche est refuse — spec §7.
 */
function limitLegFrom(raw: unknown, contexte: string): { size: string; price: string } {
  for (const configuration of Object.values(asRecord(raw, contexte))) {
    if (typeof configuration !== 'object' || configuration === null) continue;
    const champs = configuration as Record<string, unknown>;
    const size = champs['base_size'];
    const price = champs['limit_price'];
    if (typeof size === 'string' && typeof price === 'string') return { size, price };
  }
  throw new CoinbaseFrontierError(
    `${contexte} : aucune configuration limite (base_size + limit_price). La spec §7 n'admet que des ordres limit, et un ordre au marche dans ce portefeuille est une anomalie.`,
  );
}

function openOrderFrom(raw: unknown): OpenOrder {
  const record = asRecord(raw, 'orders[]');
  const exchangeId = asText(record['order_id'], 'orders[].order_id');
  const contexte = `orders[${exchangeId}]`;
  const product = asText(record['product_id'], `${contexte}.product_id`);
  const { base } = requireUsdcQuote(product, contexte);
  const side = asText(record['side'], `${contexte}.side`);
  if (!SIDES.includes(side)) {
    throw new CoinbaseFrontierError(`${contexte}.side : BUY ou SELL attendu, recu "${side}".`);
  }
  const { size, price } = limitLegFrom(
    record['order_configuration'],
    `${contexte}.order_configuration`,
  );
  return {
    exchangeId,
    clientOrderId: asText(record['client_order_id'], `${contexte}.client_order_id`),
    product,
    asset: base,
    side: side as Side,
    quantity: decimalFromApi(size, `${contexte}.base_size`) as Quantity,
    limitPrice: decimalFromApi(price, `${contexte}.limit_price`) as Price,
    filled: decimalFromApi(record['filled_size'], `${contexte}.filled_size`) as Quantity,
    createdAt: instant(record['created_time'], `${contexte}.created_time`),
  };
}

// --- Pagination -------------------------------------------------------------

/**
 * Suit `has_next` / `cursor` et accumule les elements. La borne sur le nombre de
 * pages n'est pas de la paranoia : un curseur que l'API rendrait inchange
 * ferait tourner le job indefiniment, sans erreur et sans journal.
 */
async function allPages(
  transport: CoinbaseTransport,
  route: (cursor?: string) => CoinbaseRoute,
  champ: string,
): Promise<readonly unknown[]> {
  const elements: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const reponse = asRecord(await transport.read(route(cursor)), champ);
    elements.push(...asList(reponse[champ], champ));
    const suivant = reponse['cursor'];
    if (reponse['has_next'] !== true || typeof suivant !== 'string' || suivant.length === 0) {
      return elements;
    }
    cursor = suivant;
  }
  throw new CoinbaseFrontierError(
    `${champ} : plus de ${MAX_PAGES} pages, le curseur ne progresse probablement pas.`,
  );
}

// --- Ouverture --------------------------------------------------------------

/**
 * `transport` est un parametre et non une construction interne : c'est ce qui
 * rend le module testable contre des reponses reelles capturees, sans reseau et
 * sans cle. Le job compose `ccxtTransport(config.secrets)` avec ce lecteur.
 */
export function openCoinbase(transport: CoinbaseTransport): CoinbaseReader {
  /*
   * Lues une fois par run : elles ne changent pas en cours de route, et
   * `balances()` en a besoin a chaque appel pour son controle de portee.
   */
  let permissions: Promise<KeyPermissions> | undefined;

  const lirePermissions = (): Promise<KeyPermissions> => {
    permissions ??= transport.read({ kind: 'key_permissions' }).then(permissionsFrom);
    return permissions;
  };

  return {
    keyPermissions: lirePermissions,

    async balances(): Promise<PortfolioBalances> {
      const { portfolioUuid } = await lirePermissions();
      const comptes = await allPages(
        transport,
        (cursor) => ({ kind: 'accounts', ...(cursor === undefined ? {} : { cursor }) }),
        'accounts',
      );
      return {
        portfolioUuid,
        balances: comptes.map((compte) => balanceFrom(compte, portfolioUuid)),
      };
    },

    async openOrders(): Promise<readonly OpenOrder[]> {
      const bruts = await allPages(
        transport,
        (cursor) => ({ kind: 'open_orders', ...(cursor === undefined ? {} : { cursor }) }),
        'orders',
      );
      return bruts.map(openOrderFrom);
    },

    close: () => transport.close(),
  };
}
