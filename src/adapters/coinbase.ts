import ccxt from 'ccxt';

import type { Secrets } from '../config/env.js';

/**
 * Le transport vers Coinbase. **Lecture, et rien d'autre.**
 *
 * La surface est close par le type et pas par la discipline : `CoinbaseTransport`
 * n'a qu'un verbe, `read`, qui ne prend qu'une valeur de `CoinbaseRoute`. Aucune
 * ecriture n'est **exprimable**, pas meme en composant ce que ce module exporte,
 * la ou le lint d'`eslint.config.js` interdit seulement d'en ecrire le nom.
 *
 * Ce lot cable ccxt et fige la forme d'authentification ; il ne relit aucune
 * reponse. Les lecteurs — soldes, ordres ouverts, controle de perimetre —
 * viennent au lot suivant, les bougies a celui d'apres.
 *
 * Deux constats mesures contre la vraie cle le 2026-09-11 gouvernent ce
 * fichier ; `docs/coinbase-lecture.md` §3 les argumente.
 *
 * 1. **Le claim `uri` du JWT ne doit pas porter la chaine de requete**, sous
 *    peine de 401 sur tout appel parametre. ccxt le tronque ; le test le fige.
 * 2. **Les grandeurs sortent d'ici en chaines.** `read` rend la reponse brute de
 *    l'API, jamais les structures unifiees de ccxt, qui rendent des `number`.
 */

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
 * Un verbe, `read`. C'est la couche que les tests des lots suivants remplacent :
 * ils rejouent des reponses reelles capturees, sans reseau et sans cle.
 */
export interface CoinbaseTransport {
  read(route: CoinbaseRoute): Promise<unknown>;
  close(): Promise<void>;
}

/** Nombre maximal de bougies daily par appel, impose par l'API Coinbase. */
export const MAX_CANDLES_PER_CALL = 350;

/** Taille de page des routes paginees. */
export const PAGE_SIZE = 250;

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
           * **v3 et jamais v2.** Le defaut de `fetchBalance()` chez ccxt est
           * `v2PrivateGetAccounts` (4.5.78, `coinbase.js:440`), et le scoping de
           * la cle au portefeuille ne couvre pas la v2 : la meme cle y rend le
           * compte principal. Le constat complet, et le controle de perimetre
           * qui en decoule, appartiennent au lot des lecteurs.
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
