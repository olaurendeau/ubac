import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ccxt from 'ccxt';
import { describe, expect, it } from 'vitest';

import * as coinbase from '../../src/adapters/coinbase.js';
import {
  CoinbaseFrontierError,
  ccxtTransport,
  openCoinbase,
  READ_ROUTES,
  requireUsdcQuote,
} from '../../src/adapters/coinbase.js';
import type { CoinbaseRoute, CoinbaseTransport } from '../../src/adapters/coinbase.js';

/**
 * Aucun de ces tests ne touche au reseau. Deux regimes cohabitent :
 *
 * - **des reponses reelles**, capturees le 2026-09-11 contre la vraie cle en
 *   lecture seule et versionnees dans `fixtures/`, identifiants de compte
 *   remplaces par des UUID de test. Elles portent les champs inattendus et les
 *   types surprenants que personne n'invente : `available_balance` en
 *   `{value, currency}` et pas en nombre, `"value": "0"` et pas `"0.00"`,
 *   `deleted_at: null`, `sequence: "0"`, `proof_token_required`.
 * - **des reponses fabriquees**, pour les cas que le portefeuille dedie ne
 *   contient pas — il est vide et n'a jamais passe d'ordre. Elles sont calquees
 *   sur l'echantillon reel que ccxt conserve dans son propre source
 *   (`coinbase.js`, reponse de `orders/historical/batch`) et signalees comme
 *   telles a chaque fois.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function reelle(nom: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(FIXTURES, `${nom}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

const PORTEFEUILLE = '00000000-0000-4000-8000-000000000001';

// 64 octets : graine de 32 + cle publique, la forme reelle du secret CDP.
const SECRET = Buffer.alloc(64, 7).toString('base64');
const CLE = PORTEFEUILLE;

/** Journalise les routes demandees : c'est la preuve de ce que le module appelle. */
function transportDe(
  reponses: Partial<Record<CoinbaseRoute['kind'], unknown | readonly unknown[]>>,
): { transport: CoinbaseTransport; routes: CoinbaseRoute[] } {
  const routes: CoinbaseRoute[] = [];
  const restes = new Map<string, unknown[]>();
  for (const [kind, valeur] of Object.entries(reponses)) {
    restes.set(kind, Array.isArray(valeur) ? [...valeur] : [valeur]);
  }
  return {
    routes,
    transport: {
      async read(route: CoinbaseRoute): Promise<unknown> {
        routes.push(route);
        const file = restes.get(route.kind);
        if (file === undefined || file.length === 0) {
          throw new Error(`aucune reponse prevue pour la route ${route.kind}`);
        }
        return file.length === 1 ? file[0] : file.shift();
      },
      async close(): Promise<void> {},
    },
  };
}

/** Un compte v3 calque sur la reponse reelle, dont on fait varier un champ. */
function compte(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: '00000000-0000-4000-8000-000000000002',
    name: 'BTC Wallet',
    currency: 'BTC',
    available_balance: { value: '0.03313174', currency: 'BTC' },
    default: false,
    active: true,
    type: 'ACCOUNT_TYPE_CRYPTO',
    ready: true,
    hold: { value: '0.00100000', currency: 'BTC' },
    retail_portfolio_id: PORTEFEUILLE,
    platform: 'ACCOUNT_PLATFORM_CONSUMER',
    ...overrides,
  };
}

function comptes(...liste: Record<string, unknown>[]): Record<string, unknown> {
  return { accounts: liste, has_next: false, cursor: '', size: liste.length };
}

/**
 * Un ordre ouvert, forme de `orders/historical/batch`. **Fabrique** : la cle est
 * en lecture seule et le portefeuille dedie n'a jamais passe d'ordre, donc
 * aucune capture reelle n'existe. La forme suit l'echantillon que ccxt garde
 * dans son source, avec la configuration `limit_limit_gtc` qu'impose la spec §7.
 */
function ordre(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: 'ab12cd34-0000-4000-8000-0000000000ff',
    product_id: 'BTC-USDC',
    client_order_id: '3f2a1b',
    order_configuration: {
      limit_limit_gtc: { base_size: '0.01234567', limit_price: '64321.09', post_only: true },
    },
    side: 'SELL',
    status: 'OPEN',
    time_in_force: 'GOOD_UNTIL_CANCELLED',
    created_time: '2026-09-10T07:00:00.123456Z',
    completion_percentage: '0',
    filled_size: '0',
    fee: '',
    number_of_fills: '0',
    pending_cancel: false,
    product_type: 'SPOT',
    ...overrides,
  };
}

function ordres(...liste: Record<string, unknown>[]): Record<string, unknown> {
  return { orders: liste, sequence: '0', has_next: false, cursor: '', proof_token_required: false };
}

/**
 * La meme regexp de noms d'ecriture qu'`eslint.config.js` applique a
 * `src/adapters/`. Recopiee ici a dessein : le lint garde le **source**, ce test
 * garde la **surface exportee a l'execution**, y compris ce qu'une refonte
 * future y ajouterait par un chemin que le lint ne regarde pas.
 */
const VERBES = ['create', 'place', 'submit', 'send', 'post', 'edit', 'amend', 'modify', 'replace', 'cancel', 'close'];
const ECRITURE = new RegExp(
  `^(?:(?:${VERBES.join('|')})[A-Za-z_]*[Oo]rders?|[A-Za-z_]*(?:[Ww]ithdraw|[Tt]ransfer)[A-Za-z_]*)$`,
);

describe('surface du module — aucune ecriture, ni exportee ni atteignable', () => {
  it('n’exporte aucun nom de placement, d’annulation ou de retrait', () => {
    expect(Object.keys(coinbase).filter((nom) => ECRITURE.test(nom))).toEqual([]);
  });

  it('n’expose sur le transport qu’un verbe de lecture et une fermeture', () => {
    expect(Object.keys(ccxtTransport({ coinbaseApiKey: CLE, coinbaseApiSecret: SECRET })).sort()).toEqual([
      'close',
      'read',
    ]);
  });

  it('n’expose sur le lecteur que trois lectures et une fermeture', () => {
    const { transport } = transportDe({});
    // `close` ferme le transport HTTP ; il ne denote pas une fermeture d'ordre,
    // et la regexp ci-dessus ne le confond pas (`close` seul n'y correspond pas).
    expect(Object.keys(openCoinbase(transport)).sort()).toEqual([
      'balances',
      'close',
      'keyPermissions',
      'openOrders',
    ]);
  });

  it('n’a que quatre routes, toutes en lecture', () => {
    expect([...READ_ROUTES]).toEqual(['key_permissions', 'accounts', 'open_orders', 'daily_candles']);
    expect([...READ_ROUTES].filter((route) => ECRITURE.test(route))).toEqual([]);
  });

  it('n’emet que des routes de cette liste, sur un run de lecture complet', async () => {
    const { transport, routes } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: await reelle('coinbase-accounts'),
      open_orders: await reelle('coinbase-orders-open-empty'),
    });
    const lecteur = openCoinbase(transport);
    await lecteur.keyPermissions();
    await lecteur.balances();
    await lecteur.openOrders();
    await lecteur.close();
    expect(routes.map((route) => route.kind)).toEqual(['key_permissions', 'accounts', 'open_orders']);
  });
});

describe('reponses reelles capturees le 2026-09-11', () => {
  it('lit les permissions effectives de la cle', async () => {
    const { transport } = transportDe({ key_permissions: await reelle('coinbase-key-permissions') });
    expect(await openCoinbase(transport).keyPermissions()).toEqual({
      canView: true,
      canTrade: false,
      portfolioUuid: PORTEFEUILLE,
    });
  });

  it('lit le portefeuille dedie tel qu’il est : un compte EUR a zero', async () => {
    const { transport } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: await reelle('coinbase-accounts'),
    });
    const { portfolioUuid, balances } = await openCoinbase(transport).balances();
    expect(portfolioUuid).toBe(PORTEFEUILLE);
    /*
     * Le portefeuille reel contient un compte EUR, cree par Coinbase avec le
     * portefeuille. Une devise n'est pas une paire : refuser EUR ici ferait
     * echouer la lecture des le premier run, alors que la contrainte fiscale du
     * §11 porte sur les paires cotees, pas sur les soldes constates.
     */
    expect(balances).toHaveLength(1);
    expect(balances[0]?.currency).toBe('EUR');
    expect(balances[0]?.available.toString()).toBe('0');
    expect(balances[0]?.total.toString()).toBe('0');
  });

  it('lit une absence d’ordre ouvert sans la confondre avec une erreur', async () => {
    const { transport } = transportDe({ open_orders: await reelle('coinbase-orders-open-empty') });
    expect(await openCoinbase(transport).openOrders()).toEqual([]);
  });
});

describe('permissions — la cle ne doit rien pouvoir de plus que lire', () => {
  it('refuse une permission accordee au-dela de la lecture et du trade', async () => {
    /*
     * `can_transfer` s'ecrit ici et pas dans `src/adapters/` : `eslint.config.js`
     * y interdit le mot meme en lecture, et `noInlineConfig` empeche de
     * desarmer la regle. L'adapter refuse donc **toute** permission a vrai qu'il
     * ne connait pas, sans la nommer ; ce test verifie que ce detour attrape
     * bien celle qui compte.
     */
    const { transport } = transportDe({
      key_permissions: { can_view: true, can_trade: false, can_transfer: true, portfolio_uuid: PORTEFEUILLE },
    });
    await expect(openCoinbase(transport).keyPermissions()).rejects.toThrow(/can_transfer/);
  });

  it('refuse une permission que Coinbase ajouterait demain', async () => {
    const { transport } = transportDe({
      key_permissions: { can_view: true, can_trade: false, can_stake: true, portfolio_uuid: PORTEFEUILLE },
    });
    await expect(openCoinbase(transport).keyPermissions()).rejects.toThrow(/can_stake/);
  });

  it('refuse une cle qui ne peut meme pas lire', async () => {
    const { transport } = transportDe({
      key_permissions: { can_view: false, can_trade: false, portfolio_uuid: PORTEFEUILLE },
    });
    await expect(openCoinbase(transport).keyPermissions()).rejects.toThrow(CoinbaseFrontierError);
  });
});

describe('portee du portefeuille — une reduction de surface, pas une barriere', () => {
  it('refuse un compte rattache a un autre portefeuille', async () => {
    /*
     * Mesure du 2026-09-11 : `/api/v3/brokerage/accounts` rend 1 compte, celui
     * du portefeuille dedie, la ou le `/v2/accounts` qu'appelle `fetchBalance()`
     * de ccxt en rend 100 des la premiere page, du compte principal. Le scoping
     * de la cle ne couvre pas la v2 : ce controle n'est donc pas redondant avec
     * lui, et ce test est le filet qui attrape une regression vers la v2.
     */
    const { transport } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: comptes(compte(), compte({ retail_portfolio_id: '00000000-0000-4000-8000-0000000000aa' })),
    });
    await expect(openCoinbase(transport).balances()).rejects.toThrow(/sort du portefeuille dedie/);
  });

  it('additionne disponible et bloque sans passer par un flottant', async () => {
    const { transport } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: comptes(compte({ available_balance: { value: '0.1', currency: 'BTC' }, hold: { value: '0.2', currency: 'BTC' } })),
    });
    const { balances } = await openCoinbase(transport).balances();
    // 0.1 + 0.2 vaut 0.30000000000000004 en IEEE-754, et 0.3 ici.
    expect(balances[0]?.total.toString()).toBe('0.3');
  });

  it('refuse un solde publie en nombre plutot qu’en chaine', async () => {
    const { transport } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: comptes(compte({ available_balance: { value: 0.03313174, currency: 'BTC' } })),
    });
    await expect(openCoinbase(transport).balances()).rejects.toThrow(/a perdu sa precision/);
  });

  it('suit la pagination jusqu’au bout', async () => {
    const { transport, routes } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: [
        { accounts: [compte()], has_next: true, cursor: 'page2', size: 1 },
        { accounts: [compte({ currency: 'ETH' })], has_next: false, cursor: '', size: 1 },
      ],
    });
    const { balances } = await openCoinbase(transport).balances();
    expect(balances.map((b) => b.currency)).toEqual(['BTC', 'ETH']);
    expect(routes.filter((r) => r.kind === 'accounts').map((r) => r.cursor)).toEqual([
      undefined,
      'page2',
    ]);
  });
});

describe('paires — USDC et rien d’autre (spec §11)', () => {
  it.each(['BTC-EUR', 'ETH-EUR', 'SOL-EUR'])('refuse la paire %s', (paire) => {
    expect(() => requireUsdcQuote(paire, 'test')).toThrow(/fait generateur d'imposition/);
  });

  it('accepte une paire cotee en USDC', () => {
    expect(requireUsdcQuote('BTC-USDC', 'test')).toEqual({ base: 'BTC', quote: 'USDC' });
  });

  it('refuse un identifiant qui n’est pas une paire', () => {
    expect(() => requireUsdcQuote('BTC', 'test')).toThrow(CoinbaseFrontierError);
  });

  it('refuse un ordre ouvert sur une paire en EUR au lieu de le filtrer', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ product_id: 'ETH-EUR' })) });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/ETH-EUR refusee/);
  });
});

describe('ordres ouverts', () => {
  it('lit un ordre limit avec ses grandeurs en Decimal', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre()) });
    const [lu] = await openCoinbase(transport).openOrders();
    expect(lu).toMatchObject({
      exchangeId: 'ab12cd34-0000-4000-8000-0000000000ff',
      clientOrderId: '3f2a1b',
      product: 'BTC-USDC',
      asset: 'BTC',
      side: 'SELL',
    });
    expect(lu?.quantity.toString()).toBe('0.01234567');
    expect(lu?.limitPrice.toString()).toBe('64321.09');
    expect(lu?.createdAt.toISOString()).toBe('2026-09-10T07:00:00.123Z');
  });

  it('lit une configuration a duree de vie bornee sans la connaitre', async () => {
    const { transport } = transportDe({
      open_orders: ordres(
        ordre({
          order_configuration: {
            limit_limit_gtd: { base_size: '1.5', limit_price: '2500', end_time: '2026-09-11T07:00:00Z' },
          },
        }),
      ),
    });
    const [lu] = await openCoinbase(transport).openOrders();
    expect(lu?.quantity.toString()).toBe('1.5');
  });

  it('refuse un ordre sans prix limite', async () => {
    const { transport } = transportDe({
      open_orders: ordres(ordre({ order_configuration: { market_market_ioc: { quote_size: '6.36' } } })),
    });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/aucune configuration limite/);
  });

  it('refuse un sens inconnu', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ side: 'LONG' })) });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/BUY ou SELL/);
  });
});

/**
 * Les deux pieges de `docs/cle-coinbase.md`, mesures par le coordinateur contre
 * l'API et figes ici sans reseau : `sign()` de ccxt ne fait que construire la
 * requete. Si une montee de version casse l'un des deux, ce test le dit avant
 * que la production ne recolte un 401 qui ressemble a une cle revoquee.
 */
describe('ccxt face a une cle Ed25519', () => {
  function jwtDe(): { header: Record<string, unknown>; payload: Record<string, unknown>; url: string } {
    const exchange = new ccxt.coinbase({ apiKey: CLE, secret: SECRET });
    const requete = exchange.sign(
      'brokerage/products/{product_id}/candles',
      ['v3', 'private'],
      'GET',
      { product_id: 'BTC-USDC', start: '1788825600', end: '1789084800', granularity: 'ONE_DAY' },
    );
    const entetes = requete.headers as Record<string, string>;
    const [header, payload] = (entetes['Authorization'] ?? '').replace('Bearer ', '').split('.');
    const lire = (part: string | undefined): Record<string, unknown> =>
      JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    return { header: lire(header), payload: lire(payload), url: requete.url as string };
  }

  it('signe en EdDSA, pas en ES256', () => {
    expect(SECRET).toHaveLength(88);
    expect(CLE).toHaveLength(36);
    expect(jwtDe().header['alg']).toBe('EdDSA');
  });

  it('ne met pas la chaine de requete dans le claim uri', () => {
    const { payload, url } = jwtDe();
    // L'URL porte bien les parametres : c'est le claim, et lui seul, qui doit
    // s'arreter avant le point d'interrogation. Avec la query, l'API repond 401.
    expect(url).toContain('?start=1788825600');
    const uris = payload['uris'] as string[];
    expect(uris[0]).toBe('GET api.coinbase.com/api/v3/brokerage/products/BTC-USDC/candles');
    expect(uris[0]).not.toContain('?');
  });
});

describe('transport ccxt', () => {
  it('se construit a partir des secrets valides et se ferme', async () => {
    const transport = ccxtTransport({ coinbaseApiKey: CLE, coinbaseApiSecret: SECRET });
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

describe('formes de reponse inattendues', () => {
  it.each([
    ['une chaine', 'accounts'],
    ['un nombre', 42],
    ['nulle', null],
  ])('refuse une enveloppe qui est %s', async (_nom, enveloppe) => {
    const { transport } = transportDe({ open_orders: enveloppe });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/objet attendu/);
  });

  it('refuse un champ de liste qui n’en est pas une', async () => {
    const { transport } = transportDe({ open_orders: { orders: 'aucun', has_next: false } });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/liste attendue/);
  });

  it.each([undefined, '', 7])('refuse un identifiant de produit %p', async (valeur) => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ product_id: valeur })) });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/chaine non vide attendue/);
  });

  it('refuse un horodatage de creation illisible', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ created_time: 'hier' })) });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/horodatage illisible/);
  });

  it('ignore une configuration nulle sans planter', async () => {
    const { transport } = transportDe({
      open_orders: ordres(ordre({ order_configuration: { twap_limit_gtd: null } })),
    });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/aucune configuration limite/);
  });

  it.each(['NaN', 'Infinity', '1e-8', '0x10', '', '1,5'])(
    'refuse la grandeur « %s », que decimal.js accepterait',
    async (valeur) => {
      const { transport } = transportDe({
        key_permissions: await reelle('coinbase-key-permissions'),
        accounts: comptes(compte({ available_balance: { value: valeur, currency: 'BTC' } })),
      });
      await expect(openCoinbase(transport).balances()).rejects.toThrow(/decimale litterale attendue/);
    },
  );

  it('arrete une pagination dont le curseur ne progresse pas', async () => {
    const boucle = { orders: [], has_next: true, cursor: 'toujours-la' };
    const { transport, routes } = transportDe({ open_orders: boucle });
    await expect(openCoinbase(transport).openOrders()).rejects.toThrow(/ne progresse probablement pas/);
    expect(routes).toHaveLength(20);
  });
});

/**
 * Le mappage route -> endpoint, verifie sans reseau en interceptant la couche
 * HTTP de ccxt. C'est le test qui garde le constat central du lot : **v3 et
 * jamais v2**. `fetchBalance()` de ccxt appelle `/v2/accounts`, qui n'est pas
 * scope au portefeuille et a rendu 164 comptes de tout le compte Coinbase la ou
 * `/api/v3/brokerage/accounts` en rend 1.
 */
describe('mappage des routes vers les endpoints', () => {
  async function urlsDe(routes: readonly CoinbaseRoute[]): Promise<string[]> {
    const prototype = ccxt.coinbase.prototype as unknown as Record<string, unknown>;
    const original = prototype['fetch'];
    const vues: string[] = [];
    prototype['fetch'] = (url: string): Promise<unknown> => {
      vues.push(url);
      return Promise.resolve({});
    };
    try {
      const transport = ccxtTransport({ coinbaseApiKey: CLE, coinbaseApiSecret: SECRET });
      for (const route of routes) await transport.read(route);
      await transport.close();
    } finally {
      prototype['fetch'] = original;
    }
    return vues;
  }

  it('lit les soldes en v3, jamais en v2', async () => {
    const [url] = await urlsDe([{ kind: 'accounts' }]);
    expect(url).toContain('/api/v3/brokerage/accounts');
    expect(url).not.toContain('/v2/accounts');
  });

  it('couvre les quatre routes et rien d’autre', async () => {
    const urls = await urlsDe([
      { kind: 'key_permissions' },
      { kind: 'accounts', cursor: 'page2' },
      { kind: 'open_orders' },
      { kind: 'open_orders', cursor: 'page7' },
      { kind: 'daily_candles', product: 'BTC-USDC', startSeconds: 1_788_480_000, endSeconds: 1_789_084_800 },
    ]);
    expect(urls[0]).toContain('/api/v3/brokerage/key_permissions');
    expect(urls[1]).toContain('cursor=page2');
    expect(urls[2]).toContain('order_status=OPEN');
    expect(urls[2]).not.toContain('cursor=');
    expect(urls[3]).toContain('cursor=page7');
    expect(urls[4]).toContain('/api/v3/brokerage/market/products/BTC-USDC/candles');
    expect(urls[4]).toContain('granularity=ONE_DAY');
    expect(urls.every((url) => url.includes('/api/v3/'))).toBe(true);
  });
});
