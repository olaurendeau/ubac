import { Decimal } from 'decimal.js';
import ccxt from 'ccxt';

import type { Secrets } from '../config/env.js';
import type { Order, Price, Quantity, Side, UsdcAmount } from '../core/types.js';

/**
 * Le compte Coinbase : sa lecture, et depuis le lot S4 de la phase 3 le port qui
 * y ecrit.
 *
 * Les deux surfaces sont closes par le type et **enumerees**, pas filtrees par
 * nom. Le lecteur recoit un `CoinbaseTransport`, dont le seul verbe est `read` et
 * qui ne prend qu'une `CoinbaseRoute` : il ne sait toujours rien ecrire, pas meme
 * en composant ce que ce module exporte. L'ecriture passe par un second
 * transport, `CoinbaseWriteTransport`, que seul `openCoinbaseExecution` recoit,
 * et par deux routes, `WRITE_ROUTES`. `test/adapters/coinbase.test.ts` enumere
 * les routes et les methodes du port (E10), `test/jobs/purete.test.ts` en
 * reserve l'appel a `src/jobs/execute.ts` (E11) ; la regle de noms qui
 * interdisait de les ecrire est retiree le meme jour (B4,
 * `docs/phase-1-frontieres.md` §1).
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
 *
 * Et un controle que la cle ne peut pas faire sur elle-meme (E6 de la phase 3) :
 * le lecteur se construit avec le portefeuille **attendu**, pose par
 * l'operateur, et aucune lecture ne rend quoi que ce soit tant que
 * `key_permissions` n'a pas rendu exactement celui-la. Voir `openCoinbase`.
 *
 * Et une lecture que la reconciliation attendait (E37, lot S2) : le statut reel
 * d'un ordre donne et ses executions — `orderStatus`, `orderFills`. **S2 porte
 * la lecture, S8 porte le branchement dans `src/jobs/reconcile.ts`, et E37 n'est
 * clos qu'apres les deux** : d'ici S8, `statusOf` rend encore `INDETERMINABLE`
 * pour tout ordre denoue.
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

// --- Les six requetes -------------------------------------------------------

/**
 * Les seules lectures que ce module sait formuler. Aucune ne place, n'annule ni
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
    }
  | { readonly kind: 'order'; readonly exchangeId: string }
  | { readonly kind: 'fills'; readonly exchangeId: string; readonly cursor?: string };

/** Les six `kind` ci-dessus, enumerables a l'execution pour le test de surface. */
export const READ_ROUTES = [
  'key_permissions',
  'accounts',
  'open_orders',
  'daily_candles',
  'order',
  'fills',
] as const;

/**
 * Un verbe, `read`. C'est la couche que les tests remplacent : ils rejouent des
 * reponses reelles capturees, sans reseau et sans cle.
 */
export interface CoinbaseTransport {
  read(route: CoinbaseRoute): Promise<unknown>;
  close(): Promise<void>;
}

// --- Les deux ecritures -----------------------------------------------------

/**
 * Le corps de `POST /api/v3/brokerage/orders`, grandeurs en chaines. Une seule
 * configuration, `limit_limit_gtc`, et `post_only` du type `true` : le §7
 * n'admet ni ordre au marche ni ordre qui croise le carnet, et `false` ne
 * compile pas.
 */
export interface CreateOrderBody {
  readonly client_order_id: string;
  readonly product_id: string;
  readonly side: Side;
  readonly order_configuration: {
    readonly limit_limit_gtc: {
      readonly base_size: string;
      readonly limit_price: string;
      readonly post_only: true;
    };
  };
}

/**
 * Les seules ecritures que ce module sait formuler : placer un ordre limite, et
 * annuler des ordres par l'identifiant que l'exchange leur a donne. Aucune ne
 * retire ni ne transfere, et pas plus qu'en lecture il n'existe de route
 * generique : ajouter une ecriture modifie ce type **et** `WRITE_ROUTES`, et
 * l'enumeration d'E10 rougit.
 */
export type CoinbaseWriteRoute =
  | { readonly kind: 'create_order'; readonly body: CreateOrderBody }
  | { readonly kind: 'cancel_orders'; readonly exchangeIds: readonly string[] };

/** Les deux `kind` ci-dessus, enumerables a l'execution pour E10, comme `READ_ROUTES`. */
export const WRITE_ROUTES = [
  'create_order',
  'cancel_orders',
] as const satisfies readonly CoinbaseWriteRoute['kind'][];

/**
 * Le verbe d'ecriture, sur une interface **distincte** de `CoinbaseTransport` :
 * `ccxtTransport` rend les deux, mais le lecteur ne recoit que la premiere et
 * l'executeur que la seconde.
 */
export interface CoinbaseWriteTransport {
  write(route: CoinbaseWriteRoute): Promise<unknown>;
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
): CoinbaseTransport & CoinbaseWriteTransport {
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
        case 'order':
          /*
           * La liste filtree, et non `orders/historical/{order_id}` : sur un
           * identifiant inconnu, celle-ci repond 404, et ccxt 4.5.78 en fait une
           * `ExchangeError` generique, indiscernable d'une panne — sa
           * correspondance `OrderNotFound` cherche le message dans le champ
           * `error`, qui vaut `unknown`. Le test le fige. Filtree, la liste rend
           * `orders: []` : « l'exchange ne connait pas cet ordre » est une
           * reponse, pas une exception a deviner.
           */
          return exchange.v3PrivateGetBrokerageOrdersHistoricalBatch({
            order_ids: [route.exchangeId],
          });
        case 'fills':
          return exchange.v3PrivateGetBrokerageOrdersHistoricalFills({
            order_ids: [route.exchangeId],
            limit: PAGE_SIZE,
            ...(route.cursor === undefined ? {} : { cursor: route.cursor }),
          });
      }
    },
    async write(route: CoinbaseWriteRoute): Promise<unknown> {
      switch (route.kind) {
        case 'create_order':
          /*
           * Un refus ne revient pas en `success: false` : ccxt leve des
           * qu'`error_response` est present (4.5.78, `coinbase.js:5435`), rejet
           * post-only compris. Le classer — journalise sans faire echouer le
           * run, dit le §7 — revient a l'appelant, en S7.
           */
          return exchange.v3PrivatePostBrokerageOrders(route.body);
        case 'cancel_orders':
          return exchange.v3PrivatePostBrokerageOrdersBatchCancel({
            order_ids: [...route.exchangeIds],
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
 * nommement ; **tout autre champ qui n'est pas le booleen `false` fait echouer
 * la lecture**, ce qui couvre la permission de sortie sans la nommer et attrape
 * en prime une permission que Coinbase ajouterait demain. Le mot etait
 * inecrivable ici tant que la regle de noms d'`eslint.config.js` valait ; elle
 * est retiree (B4), et **ce refus est desormais le seul controle sur ce
 * point** — l'absence du champ passe encore, et S7 doit l'exiger.
 */
export interface KeyPermissions {
  readonly canView: boolean;
  readonly canTrade: boolean;
  readonly portfolioUuid: string;
}

/**
 * Ce que le run attend de la cle. Pose **a la construction** du lecteur, et non
 * passe a une methode : un controle qu'on esquive en appelant la bonne lecture
 * dans le mauvais ordre n'en est pas un.
 */
export interface ExpectedKey {
  /**
   * `COINBASE_PORTFOLIO_UUID`, pose par l'operateur. Compare **exactement** au
   * `portfolio_uuid` que rend `key_permissions`.
   */
  readonly portfolioUuid: string;
  /**
   * Recoit, une fois par run, la ligne des permissions effectives et du
   * portefeuille (E8) — **avant** le verdict, pour qu'une cle refusee dise au
   * journal ce qu'elle est reellement.
   */
  readonly log: (line: string) => void;
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
 * Ce que l'exchange dit d'un ordre qu'il connait (E37). `OPEN` regroupe les
 * statuts ou l'ordre vit encore — `PENDING`, `QUEUED`, `OPEN`, `CANCEL_QUEUED` ;
 * les quatre autres sont ses issues, et restent **distinctes** : ccxt replie
 * `EXPIRED` et `FAILED` sur `canceled` dans ses structures unifiees, une raison
 * de plus de lire la reponse brute. `FAILED` est l'ordre rejete.
 *
 * `filled` est porte par toutes les issues, `CANCELLED` comprise : un ordre
 * partiellement execute puis annule existe, et le reduire a son statut perdrait
 * la quantite executee — celle qui compte pour le solde.
 */
export interface KnownOrderStatus {
  readonly kind: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly filled: Quantity;
  /** `null` tant que rien n'est execute : un prix moyen de zero n'est pas un prix. */
  readonly averageFilledPrice: Price | null;
  /** `total_fees`, dans la devise de cotation — USDC, la paire est verifiee. */
  readonly fees: UsdcAmount;
}

/**
 * `INDETERMINABLE` reste atteignable, et doit l'etre, dans deux cas : l'exchange
 * ne connait pas l'ordre — un ordre jamais accepte, qu'E23 rend possible —, ou
 * il rend un statut que ce module ne sait pas interpreter. **L'issue ne se
 * devine pas** : la replier sur `CANCELLED` classerait un ordre execute en
 * annule, ce qui est pire que de ne pas le classer (`docs/reconciliation.md` §4).
 */
export type OrderStatus =
  | KnownOrderStatus
  | { readonly kind: 'INDETERMINABLE'; readonly reason: string };

/** Une execution d'un ordre. `commission` est en devise de cotation, donc en USDC. */
export interface OrderFill {
  readonly tradeId: string;
  readonly price: Price;
  readonly size: Quantity;
  readonly commission: UsdcAmount;
  readonly tradeTime: Date;
}

/**
 * La surface de lecture de Coinbase pour le reste du programme : cinq lectures
 * et une fermeture. L'ecriture a la sienne, `ExecutionPort`, en fin de module.
 */
export interface CoinbaseReader {
  keyPermissions(): Promise<KeyPermissions>;
  balances(): Promise<PortfolioBalances>;
  openOrders(): Promise<readonly OpenOrder[]>;
  /** Le statut reel d'un ordre, par l'identifiant que l'exchange lui a donne. */
  orderStatus(exchangeId: string): Promise<OrderStatus>;
  /** Ses executions, toutes pages suivies. */
  orderFills(exchangeId: string): Promise<readonly OrderFill[]>;
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

/**
 * Les champs de `key_permissions` que ce module connait. `portfolio_type` n'est
 * pas une permission ; il est admis sans etre lu. Tout autre champ est une
 * permission a refuser franchement — voir `permissionsFrom`.
 */
const KEY_FIELDS: ReadonlySet<string> = new Set([
  'can_view',
  'can_trade',
  'portfolio_uuid',
  'portfolio_type',
]);

/**
 * La ligne d'E8 : les permissions **telles que la reponse les porte**, pas telles
 * que ce module les a comprises. Tous les champs `can_*`, dans l'ordre de la
 * reponse et avec leur forme JSON — une permission rendue `"true"` en chaine ne
 * se lit pas `true` —, celle de sortie comprise, que ce fichier journalise sans
 * avoir a la nommer. Aucun secret n'y entre : la reponse n'en porte pas, et le
 * lecteur n'a jamais la cle en main, seul le transport la tient.
 */
function keyLine(
  record: Readonly<Record<string, unknown>>,
  portfolioUuid: string,
  attendu: boolean,
): string {
  const permissions = Object.entries(record)
    .filter(([nom]) => nom.startsWith('can_'))
    .map(([nom, valeur]) => `${nom}=${JSON.stringify(valeur)}`)
    .join(' ');
  return `cle coinbase — portefeuille=${portfolioUuid} attendu=${attendu ? 'oui' : 'NON'} ${permissions}`;
}

function permissionsFrom(raw: unknown, attendue: ExpectedKey): KeyPermissions {
  const record = asRecord(raw, 'key_permissions');
  const portfolioUuid = asText(record['portfolio_uuid'], 'key_permissions.portfolio_uuid');
  const attendu = portfolioUuid === attendue.portfolioUuid;
  attendue.log(keyLine(record, portfolioUuid, attendu));
  /*
   * Sur une permission, la lecture la plus defavorable (`docs/cle-coinbase.md`).
   * Hors des champs que ce module connait, **seul le booleen `false` vaut
   * refus** : une chaine — `"false"` comprise —, un nombre, `null` ou un objet
   * est lu comme accorde, pas comme absent, parce que c'est le seul sens qui
   * echoue du bon cote. Un champ de nom inconnu est traite de meme, qu'il
   * commence par `can_` ou non. Le nom est repris tel quel dans le message.
   */
  const inattendues = Object.entries(record)
    .filter(([nom, valeur]) => !KEY_FIELDS.has(nom) && valeur !== false)
    .map(([nom]) => nom);
  if (inattendues.length > 0) {
    throw new CoinbaseFrontierError(
      `key_permissions : permission inattendue, accordee ou pas franchement refusee (${inattendues.join(', ')}). Seul le booleen false vaut refus ; la spec §7 n'admet que la lecture, et le trade a partir de la phase 3.`,
    );
  }
  // Deja du bon cote avant le correctif : `"true"` n'y vaut pas lecture. Seul le message change.
  if (record['can_view'] !== true) {
    throw new CoinbaseFrontierError(
      `key_permissions : can_view vaut ${JSON.stringify(record['can_view'])}, et seul le booleen true vaut lecture. La cle ne lit rien du portefeuille.`,
    );
  }
  const canTrade = record['can_trade'];
  if (typeof canTrade !== 'boolean') {
    throw new CoinbaseFrontierError(
      `key_permissions : can_trade vaut ${JSON.stringify(canTrade)}, ni true ni false. Ce que la cle peut faire ne se devine pas.`,
    );
  }
  /*
   * E6. **Ne pas confondre avec le controle de `balanceFrom`**, et ne supprimer
   * ni l'un ni l'autre en le croyant redondant. Celui-la compare chaque compte
   * a l'UUID que **la cle** declare : il prouve que la reponse est coherente
   * avec la cle. Celui-ci compare la cle a l'UUID que **l'operateur** a pose :
   * il prouve que la cle est scopee sur le bon portefeuille. Une cle creee par
   * erreur sur *Primary*, selectionne par defaut dans le CDP Portal, passe le
   * premier sans rien faire rougir, et c'est le second qui l'arrete.
   *
   * Les deux UUID sont cites, comme dans `balanceFrom` : sur un telephone, une
   * faute d'un caractere ne se trouve qu'en les voyant l'un sous l'autre.
   */
  if (!attendu) {
    throw new CoinbaseFrontierError(
      `key_permissions : la cle est scopee sur le portefeuille ${portfolioUuid}, alors que COINBASE_PORTFOLIO_UUID attend ${attendue.portfolioUuid}. Aucune lecture n'est faite avec une cle qui n'est pas celle du portefeuille dedie.`,
    );
  }
  return {
    canView: true,
    canTrade,
    portfolioUuid,
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

/**
 * Les statuts que ce module sait interpreter, et aucun autre : `UNKNOWN_ORDER_STATUS`,
 * valeur par defaut de l'enumeration Coinbase, n'y est pas, pas plus qu'un statut
 * que l'API ajouterait demain. Une `Map` et pas un litteral d'objet : un statut
 * `toString` ou `constructor` y trouverait sinon une valeur, heritee du prototype.
 */
const STATUTS = new Map<string, KnownOrderStatus['kind']>([
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
 * La liste est filtree sur un identifiant : elle en porte zero ou un, et c'est
 * **celui-la**. Un autre ordre dans la reponse prouve que le filtre n'a pas ete
 * honore, et lire le premier venu rendrait le statut d'un autre ordre — donc la
 * lecture s'arrete. Une liste vide, elle, est une reponse : l'ordre est inconnu.
 */
function orderStatusFrom(raw: unknown, exchangeId: string): OrderStatus {
  const liste = asList(asRecord(raw, 'order')['orders'], 'order.orders');
  const contexte = `order[${exchangeId}]`;
  const [brut] = liste;
  if (brut === undefined) {
    return {
      kind: 'INDETERMINABLE',
      reason: `${contexte} : inconnu de l'exchange — jamais accepte, ou identifiant faux. Son issue ne se deduit de rien.`,
    };
  }
  const record = asRecord(brut, contexte);
  const lu = asText(record['order_id'], `${contexte}.order_id`);
  if (liste.length > 1 || lu !== exchangeId) {
    throw new CoinbaseFrontierError(
      `${contexte} : la reponse porte ${String(liste.length)} ordre(s), dont ${lu}. Le filtre order_ids n'a pas ete honore.`,
    );
  }
  requireUsdcQuote(asText(record['product_id'], `${contexte}.product_id`), contexte);
  const filled = decimalFromApi(record['filled_size'], `${contexte}.filled_size`) as Quantity;
  const statut = asText(record['status'], `${contexte}.status`);
  const kind = STATUTS.get(statut);
  if (kind === undefined) {
    return {
      kind: 'INDETERMINABLE',
      reason: `${contexte} : statut ${statut}, que ce module ne sait pas interpreter, quantite executee ${filled.toFixed()}. Il n'est pas replie sur CANCELLED : ce serait classer en annule un ordre peut-etre execute.`,
    };
  }
  return {
    kind,
    exchangeId,
    clientOrderId: asText(record['client_order_id'], `${contexte}.client_order_id`),
    filled,
    averageFilledPrice: filled.isZero()
      ? null
      : (decimalFromApi(record['average_filled_price'], `${contexte}.average_filled_price`) as Price),
    fees: decimalFromApi(record['total_fees'], `${contexte}.total_fees`) as UsdcAmount,
  };
}

/**
 * Deux champs arretent la lecture plutot que d'etre interpretes. `trade_type`
 * autre que `FILL` — une correction ou une annulation d'execution ne s'additionne
 * pas sans regle. `size_in_quote` autre que le booleen `false` — la taille serait
 * en devise de cotation, ou son unite non dite, et une taille dont l'unite se
 * devine fausse le solde.
 */
function fillFrom(raw: unknown, exchangeId: string): OrderFill {
  const record = asRecord(raw, 'fills[]');
  const tradeId = asText(record['trade_id'], 'fills[].trade_id');
  const contexte = `fills[${tradeId}]`;
  const rattache = asText(record['order_id'], `${contexte}.order_id`);
  if (rattache !== exchangeId) {
    throw new CoinbaseFrontierError(
      `${contexte} : execution de l'ordre ${rattache}, alors que ${exchangeId} etait demande. Le filtre order_ids n'a pas ete honore.`,
    );
  }
  requireUsdcQuote(asText(record['product_id'], `${contexte}.product_id`), contexte);
  if (record['trade_type'] !== 'FILL') {
    throw new CoinbaseFrontierError(
      `${contexte} : trade_type ${JSON.stringify(record['trade_type'])}, seul FILL s'additionne.`,
    );
  }
  if (record['size_in_quote'] !== false) {
    throw new CoinbaseFrontierError(
      `${contexte} : size_in_quote vaut ${JSON.stringify(record['size_in_quote'])}, et seul le booleen false dit que la taille est en devise de base.`,
    );
  }
  return {
    tradeId,
    price: decimalFromApi(record['price'], `${contexte}.price`) as Price,
    size: decimalFromApi(record['size'], `${contexte}.size`) as Quantity,
    commission: decimalFromApi(record['commission'], `${contexte}.commission`) as UsdcAmount,
    tradeTime: instant(record['trade_time'], `${contexte}.trade_time`),
  };
}

// --- Pagination -------------------------------------------------------------

/** `has_next` et `cursor` : la forme des soldes et des ordres. */
function curseurAnnonce(reponse: Readonly<Record<string, unknown>>): string | undefined {
  const suivant = reponse['cursor'];
  return reponse['has_next'] === true && typeof suivant === 'string' && suivant.length > 0
    ? suivant
    : undefined;
}

/**
 * Les executions n'ont pas de `has_next` (echantillon de ccxt) : la suite existe
 * tant que le curseur n'est pas vide, et la page non plus. S'arreter faute de
 * `has_next` tronquerait en silence tout ce qui depasse la premiere page.
 */
function curseurSeul(
  reponse: Readonly<Record<string, unknown>>,
  page: readonly unknown[],
): string | undefined {
  const suivant = reponse['cursor'];
  return page.length > 0 && typeof suivant === 'string' && suivant.length > 0 ? suivant : undefined;
}

/**
 * Suit `has_next` / `cursor` et accumule les elements. La borne sur le nombre de
 * pages n'est pas de la paranoia : un curseur que l'API rendrait inchange
 * ferait tourner le job indefiniment, sans erreur et sans journal.
 */
async function allPages(
  transport: CoinbaseTransport,
  route: (cursor?: string) => CoinbaseRoute,
  champ: string,
  suite: typeof curseurSeul = curseurAnnonce,
): Promise<readonly unknown[]> {
  const elements: unknown[] = [];
  let cursor: string | undefined;
  for (let numero = 0; numero < MAX_PAGES; numero += 1) {
    const reponse = asRecord(await transport.read(route(cursor)), champ);
    const page = asList(reponse[champ], champ);
    elements.push(...page);
    cursor = suite(reponse, page);
    if (cursor === undefined) return elements;
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
 *
 * `attendue` porte le portefeuille que la cle doit servir. **Chaque lecture
 * commence par la verifier**, `openOrders` et les lectures d'un ordre compris,
 * qui n'ont pas besoin de l'UUID : le controle ne depend donc pas de l'ordre
 * dans lequel le run appelle les methodes. Le run quotidien lit `keyPermissions`
 * en premier, et c'est la qu'une cle mal scopee l'arrete, avant la
 * reconciliation.
 */
export function openCoinbase(transport: CoinbaseTransport, attendue: ExpectedKey): CoinbaseReader {
  /*
   * Lues une fois par run : elles ne changent pas en cours de route. Un refus
   * est memoise comme une reponse — la promesse rejetee reste rejetee —, donc
   * une cle refusee le reste pour toutes les lectures suivantes, et la ligne
   * d'E8 n'est ecrite qu'une fois.
   */
  let permissions: Promise<KeyPermissions> | undefined;

  const lirePermissions = (): Promise<KeyPermissions> => {
    permissions ??= transport
      .read({ kind: 'key_permissions' })
      .then((raw) => permissionsFrom(raw, attendue));
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
      await lirePermissions();
      const bruts = await allPages(
        transport,
        (cursor) => ({ kind: 'open_orders', ...(cursor === undefined ? {} : { cursor }) }),
        'orders',
      );
      return bruts.map(openOrderFrom);
    },

    async orderStatus(exchangeId: string): Promise<OrderStatus> {
      await lirePermissions();
      return orderStatusFrom(await transport.read({ kind: 'order', exchangeId }), exchangeId);
    },

    async orderFills(exchangeId: string): Promise<readonly OrderFill[]> {
      await lirePermissions();
      const bruts = await allPages(
        transport,
        (cursor) => ({ kind: 'fills', exchangeId, ...(cursor === undefined ? {} : { cursor }) }),
        'fills',
        curseurSeul,
      );
      return bruts.map((brut) => fillFrom(brut, exchangeId));
    },

    close: () => transport.close(),
  };
}

// --- L'execution : le port, et la cle qui le conditionne --------------------

/** Un ordre que l'exchange a accepte, sous l'identifiant qu'il lui a donne. */
export interface PlacedOrder {
  readonly exchangeId: string;
  readonly clientOrderId: string;
}

/**
 * L'issue d'une annulation, **ordre par ordre** : un lot ne se replie pas sur un
 * booleen, sinon un refus pour une vraie raison passerait pour un ordre deja
 * denoue. `reason` est le `failure_reason` de l'API tel quel ; distinguer
 * « deja denoue » d'une vraie panne revient a S8.
 */
export type CancelOutcome =
  | { readonly kind: 'CANCELLED'; readonly exchangeId: string }
  | { readonly kind: 'REFUSED'; readonly exchangeId: string; readonly reason: string };

/**
 * Le port d'execution : deux methodes, et rien d'autre — ni mode, ni drapeau,
 * ni `dryRun`, `force` ou `bypass`. Le `DRY_RUN` (S5) n'en est pas un parametre :
 * c'est une autre implementation de ce type, composee a la place de celle-ci au
 * point d'entree. Seul `src/jobs/execute.ts` appelle ces methodes (E11).
 */
export interface ExecutionPort {
  placeOrder(order: Order): Promise<PlacedOrder>;
  cancelOrders(exchangeIds: readonly string[]): Promise<readonly CancelOutcome[]>;
}

/** Les deux methodes ci-dessus, enumerables a l'execution pour E10 et A23. */
export const EXECUTION_METHODS = [
  'placeOrder',
  'cancelOrders',
] as const satisfies readonly (keyof ExecutionPort)[];

/**
 * La seule sortie des grandeurs vers l'API : `toFixed()` n'ecrit jamais
 * d'exposant, et une grandeur nulle, negative ou non finie ne part pas — `NaN`
 * ecrirait `"NaN"` dans un ordre. L'arrondi aux pas du produit n'est pas fait
 * ici : arrondir en silence changerait l'ordre que le noyau a valide.
 */
function textFromDecimal(value: Decimal, contexte: string): string {
  if (!value.isFinite() || !value.gt(0)) {
    throw new CoinbaseFrontierError(
      `${contexte} : grandeur positive et finie attendue, recu ${value.toString()}.`,
    );
  }
  return value.toFixed();
}

function createOrderBody(order: Order): CreateOrderBody {
  const contexte = `create_order[${order.clientOrderId}]`;
  return {
    client_order_id: order.clientOrderId,
    product_id: `${order.asset}-${order.quote}`,
    side: order.side,
    order_configuration: {
      limit_limit_gtc: {
        base_size: textFromDecimal(order.quantity, `${contexte}.base_size`),
        limit_price: textFromDecimal(order.limitPrice, `${contexte}.limit_price`),
        post_only: true,
      },
    },
  };
}

/**
 * Seul le booleen `success: true` vaut placement. L'exchange qui repond pour un
 * autre `client_order_id` arrete tout : l'identifiant deterministe est ce qui
 * rend le placement idempotent — un second envoi du meme identifiant rend
 * l'ordre existant au lieu d'en creer un, dit la documentation de l'API, que
 * rien n'a encore mesure —, et c'est donc lui qui se verifie.
 */
function placedFrom(raw: unknown, clientOrderId: string): PlacedOrder {
  const contexte = `create_order[${clientOrderId}]`;
  const reponse = asRecord(raw, contexte);
  if (reponse['success'] !== true) {
    throw new CoinbaseFrontierError(
      `${contexte} : ordre non accepte, success=${JSON.stringify(reponse['success'])} (${JSON.stringify(reponse['error_response'])}).`,
    );
  }
  const accepte = asRecord(reponse['success_response'], `${contexte}.success_response`);
  const rendu = asText(accepte['client_order_id'], `${contexte}.client_order_id`);
  if (rendu !== clientOrderId) {
    throw new CoinbaseFrontierError(`${contexte} : l'exchange repond pour ${rendu}.`);
  }
  return { exchangeId: asText(accepte['order_id'], `${contexte}.order_id`), clientOrderId };
}

/**
 * Une issue par ordre demande, et aucune autre : une issue qui manque ne se
 * devine pas, et une issue en trop dit que la reponse ne porte pas sur ce lot.
 */
function cancelledFrom(raw: unknown, exchangeIds: readonly string[]): readonly CancelOutcome[] {
  const resultats = asList(asRecord(raw, 'cancel_orders')['results'], 'cancel_orders.results');
  const issues = resultats.map((brut): CancelOutcome => {
    const record = asRecord(brut, 'cancel_orders.results[]');
    const exchangeId = asText(record['order_id'], 'cancel_orders.results[].order_id');
    const contexte = `cancel_orders[${exchangeId}]`;
    if (record['success'] === true) return { kind: 'CANCELLED', exchangeId };
    if (record['success'] === false) {
      const reason = asText(record['failure_reason'], `${contexte}.failure_reason`);
      return { kind: 'REFUSED', exchangeId, reason };
    }
    throw new CoinbaseFrontierError(
      `${contexte}.success : booleen attendu, recu ${JSON.stringify(record['success'])}.`,
    );
  });
  const demandes = [...exchangeIds].sort().join(',');
  const rendus = issues.map((issue) => issue.exchangeId).sort().join(',');
  if (rendus !== demandes) {
    throw new CoinbaseFrontierError(
      `cancel_orders : issues pour [${rendus}], alors que [${demandes}] etaient demandes.`,
    );
  }
  return issues;
}

/**
 * L'executeur. **`can_trade` est une condition de construction, pas un
 * drapeau** (E7) : avec une cle qui ne peut pas trader, il n'y a pas de port,
 * donc rien a appeler, et aucun parametre ne le fait exister autrement. Le run
 * qui le composera (S7) refusera donc de demarrer arme.
 *
 * La permission vient du lecteur, qui a deja verifie la cle contre le
 * portefeuille attendu (E6) et l'a journalisee (E8) : un seul controle de la cle
 * par run, le meme pour lire et pour ecrire, et une seule ligne au journal.
 */
export async function openCoinbaseExecution(
  transport: CoinbaseWriteTransport,
  reader: Pick<CoinbaseReader, 'keyPermissions'>,
): Promise<ExecutionPort> {
  const { canTrade, portfolioUuid } = await reader.keyPermissions();
  if (!canTrade) {
    throw new CoinbaseFrontierError(
      `key_permissions : can_trade vaut false sur le portefeuille ${portfolioUuid}. L'execution ne se construit pas avec une cle qui ne peut pas trader.`,
    );
  }
  return {
    async placeOrder(order: Order): Promise<PlacedOrder> {
      const body = createOrderBody(order);
      const reponse = await transport.write({ kind: 'create_order', body });
      return placedFrom(reponse, order.clientOrderId);
    },

    // Une liste vide n'appelle pas l'exchange : `order_ids: []` est une requete invalide.
    async cancelOrders(exchangeIds: readonly string[]): Promise<readonly CancelOutcome[]> {
      if (exchangeIds.length === 0) return [];
      const reponse = await transport.write({ kind: 'cancel_orders', exchangeIds });
      return cancelledFrom(reponse, exchangeIds);
    },
  };
}
