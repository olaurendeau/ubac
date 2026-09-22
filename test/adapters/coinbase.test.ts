import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ccxt from 'ccxt';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import * as coinbase from '../../src/adapters/coinbase.js';
import {
  CoinbaseFrontierError,
  ccxtTransport,
  openCoinbase,
  READ_ROUTES,
  requireUsdcQuote,
} from '../../src/adapters/coinbase.js';
import type {
  CoinbaseReader,
  CoinbaseRoute,
  CoinbaseTransport,
  KnownOrderStatus,
  OrderStatus,
} from '../../src/adapters/coinbase.js';

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
 *   telles a chaque fois. Celles d'un ordre execute (T2, lot S2) sont des
 *   fichiers : chacune porte un champ `_fabrique`, que `fabriquee` exige et que
 *   `reelle` refuse — une fixture fabriquee ne se charge pas comme une capture.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function fixture(nom: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(FIXTURES, `${nom}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function reelle(nom: string): Promise<Record<string, unknown>> {
  const lue = await fixture(nom);
  if ('_fabrique' in lue) throw new Error(`${nom} est fabriquee, pas capturee.`);
  return lue;
}

async function fabriquee(nom: string): Promise<Record<string, unknown>> {
  const lue = await fixture(nom);
  if (!String(lue['_fabrique']).startsWith('FABRIQUEE, PAS CAPTUREE')) {
    throw new Error(`${nom} ne se declare pas fabriquee : capturee, elle se charge par reelle().`);
  }
  return lue;
}

const PORTEFEUILLE = '00000000-0000-4000-8000-000000000001';

// 64 octets : graine de 32 + cle publique, la forme reelle du secret CDP.
const SECRET = Buffer.alloc(64, 7).toString('base64');
const CLE = PORTEFEUILLE;

/** La reponse reelle de `key_permissions`, que toute lecture verifie d'abord. */
const PERMISSIONS_REELLES = await reelle('coinbase-key-permissions');

/** L'ordre execute et ses deux executions, **fabriques** (T2). */
const ORDRE_EXECUTE = 'ab12cd34-0000-4000-8000-0000000000f1';
const LISTE_EXECUTE = await fabriquee('coinbase-order-filled');
const EXECUTIONS = await fabriquee('coinbase-order-fills');

/** La liste filtree sur l'ordre execute, dont on fait varier des champs. */
function execute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const [brut] = LISTE_EXECUTE['orders'] as Record<string, unknown>[];
  return { ...LISTE_EXECUTE, orders: [{ ...brut, ...overrides }] };
}

/**
 * Journalise les routes demandees : c'est la preuve de ce que le module appelle.
 * `key_permissions` rend la reponse reelle sauf mention contraire : chaque
 * lecture commence par elle, `openOrders` compris.
 */
function transportDe(
  reponses: Partial<Record<CoinbaseRoute['kind'], unknown | readonly unknown[]>>,
): { transport: CoinbaseTransport; routes: CoinbaseRoute[] } {
  const routes: CoinbaseRoute[] = [];
  const restes = new Map<string, unknown[]>();
  for (const [kind, valeur] of Object.entries({ key_permissions: PERMISSIONS_REELLES, ...reponses })) {
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

/** Le lecteur, attendant le portefeuille de la fixture, et le journal qu'il a ecrit. */
function lecteurDe(
  transport: CoinbaseTransport,
  portfolioUuid = PORTEFEUILLE,
): { lecteur: CoinbaseReader; journal: string[] } {
  const journal: string[] = [];
  return { journal, lecteur: openCoinbase(transport, { portfolioUuid, log: (l) => journal.push(l) }) };
}

function ouvrir(transport: CoinbaseTransport): CoinbaseReader {
  return lecteurDe(transport).lecteur;
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

  it('n’expose sur le lecteur que cinq lectures et une fermeture', () => {
    const { transport } = transportDe({});
    // `close` ferme le transport HTTP ; il ne denote pas une fermeture d'ordre,
    // et la regexp ci-dessus ne le confond pas (`close` seul n'y correspond pas).
    const noms = Object.keys(ouvrir(transport)).sort();
    expect(noms).toEqual(['balances', 'close', 'keyPermissions', 'openOrders', 'orderFills', 'orderStatus']);
    expect(noms.filter((nom) => ECRITURE.test(nom))).toEqual([]);
  });

  it('n’a que six routes, toutes en lecture', () => {
    expect([...READ_ROUTES]).toEqual([
      'key_permissions',
      'accounts',
      'open_orders',
      'daily_candles',
      'order',
      'fills',
    ]);
    expect([...READ_ROUTES].filter((route) => ECRITURE.test(route))).toEqual([]);
  });

  it('n’emet que des routes de cette liste, sur un run de lecture complet', async () => {
    const { transport, routes } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: await reelle('coinbase-accounts'),
      open_orders: await reelle('coinbase-orders-open-empty'),
      order: execute(),
      fills: EXECUTIONS,
    });
    const lecteur = ouvrir(transport);
    await lecteur.keyPermissions();
    await lecteur.balances();
    await lecteur.openOrders();
    await lecteur.orderStatus(ORDRE_EXECUTE);
    await lecteur.orderFills(ORDRE_EXECUTE);
    await lecteur.close();
    expect(routes.map((route) => route.kind)).toEqual([
      'key_permissions',
      'accounts',
      'open_orders',
      'order',
      'fills',
    ]);
  });
});

describe('reponses reelles capturees le 2026-09-11', () => {
  it('lit les permissions effectives de la cle', async () => {
    const { transport } = transportDe({ key_permissions: await reelle('coinbase-key-permissions') });
    expect(await ouvrir(transport).keyPermissions()).toEqual({
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
    const { portfolioUuid, balances } = await ouvrir(transport).balances();
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
    expect(await ouvrir(transport).openOrders()).toEqual([]);
  });
});

describe('permissions — la cle ne doit rien pouvoir de plus que lire', () => {
  it('refuse une permission accordee au-dela de la lecture et du trade', async () => {
    /*
     * `can_transfer` s'ecrit ici et pas dans `src/adapters/` : `eslint.config.js`
     * y interdit le mot meme en lecture, et `noInlineConfig` empeche de
     * desarmer la regle. L'adapter refuse donc **toute** permission qu'il ne
     * connait pas et qui n'est pas franchement refusee, sans la nommer ; ce test
     * verifie que ce detour attrape bien celle qui compte.
     */
    const { transport } = transportDe({
      key_permissions: { can_view: true, can_trade: false, can_transfer: true, portfolio_uuid: PORTEFEUILLE },
    });
    await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(/can_transfer/);
  });

  it('refuse une permission que Coinbase ajouterait demain', async () => {
    const { transport } = transportDe({
      key_permissions: { can_view: true, can_trade: false, can_stake: true, portfolio_uuid: PORTEFEUILLE },
    });
    await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(/can_stake/);
  });

  /*
   * Le bloquant de la revue de S1 : le filtre s'ecrivait `valeur === true`, et
   * `can_transfer: "true"` passait. Seul le booleen `false` vaut refus ; toute
   * autre valeur est lue comme accordee, `"false"` compris — le contrat de
   * l'API est un booleen, une chaine en sort deja, et rien ne dit alors si elle
   * se lit par son texte ou, comme en JavaScript, comme une valeur vraie.
   */
  it.each([['true'], ['false'], [1], [0], [null], [{ value: false }]])(
    'refuse la permission de sortie rendue %j, faute d’un refus franc',
    async (valeur) => {
      const { transport } = transportDe({
        key_permissions: { ...PERMISSIONS_REELLES, can_transfer: valeur },
      });
      await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(
        /permission inattendue.*\(can_transfer\)/,
      );
    },
  );

  it.each([
    ['nommee comme les autres, en chaine', { can_stake: 'true' }, /\(can_stake\)/],
    ['sous un nom sans prefixe', { withdrawal_enabled: 'yes' }, /\(withdrawal_enabled\)/],
  ])('refuse une permission inconnue %s', async (_cas, ecart, nom) => {
    const { transport } = transportDe({ key_permissions: { ...PERMISSIONS_REELLES, ...ecart } });
    await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(nom);
  });

  it('refuse une cle qui ne peut meme pas lire', async () => {
    const { transport } = transportDe({
      key_permissions: { can_view: false, can_trade: false, portfolio_uuid: PORTEFEUILLE },
    });
    await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(CoinbaseFrontierError);
  });

  it.each([['true'], [1], [null]])('refuse une lecture rendue %j, pas le booleen true', async (valeur) => {
    const { transport } = transportDe({ key_permissions: { ...PERMISSIONS_REELLES, can_view: valeur } });
    await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(/can_view vaut/);
  });

  /*
   * Le trade est admis dans les deux sens, mais `canTrade` ne se devine pas :
   * une valeur qui n'est ni `true` ni `false` arrete la lecture plutot que de
   * se lire « refuse », le meme trou que la permission de sortie, a l'envers.
   */
  it.each([['true'], ['false'], [1], [null], [undefined]])(
    'refuse un trade rendu %j, ni vrai ni faux',
    async (valeur) => {
      const { transport } = transportDe({ key_permissions: { ...PERMISSIONS_REELLES, can_trade: valeur } });
      await expect(ouvrir(transport).keyPermissions()).rejects.toThrow(/can_trade vaut/);
    },
  );
});

/** Le portefeuille de la fixture, faux d'un seul caractere : le dernier. */
const VOISIN = '00000000-0000-4000-8000-000000000002';

/** Un autre portefeuille du meme compte : *Primary*, selectionne par defaut dans le CDP Portal. */
const PRIMARY = '00000000-0000-4000-8000-0000000000aa';

describe('E6 — la cle est celle du portefeuille que l’operateur attend', () => {
  it('refuse une cle scopee sur un portefeuille faux d’un seul caractere', async () => {
    const { transport } = transportDe({});
    await expect(lecteurDe(transport, VOISIN).lecteur.keyPermissions()).rejects.toThrow(
      /COINBASE_PORTFOLIO_UUID/,
    );
  });

  /*
   * Le cas pour lequel E6 existe. Une cle creee sur *Primary* rend une reponse
   * **coherente avec elle-meme** : ses comptes sont rattaches au portefeuille
   * qu'elle declare, et le controle de `balanceFrom` n'a rien a redire. Si la
   * valeur attendue etait lue dans la reponse plutot que dans la configuration,
   * c'est ce test qui passerait au vert — et celui-la seul le dirait.
   */
  it('arrete une cle coherente avec elle-meme, mais scopee sur un autre portefeuille', async () => {
    const { transport, routes } = transportDe({
      key_permissions: { ...PERMISSIONS_REELLES, portfolio_uuid: PRIMARY },
      accounts: comptes(compte({ retail_portfolio_id: PRIMARY })),
    });
    await expect(ouvrir(transport).balances()).rejects.toThrow(
      `la cle est scopee sur le portefeuille ${PRIMARY}, alors que COINBASE_PORTFOLIO_UUID attend ${PORTEFEUILLE}`,
    );
    expect(routes.map((route) => route.kind)).toEqual(['key_permissions']);
  });

  /*
   * Piege (5) du plan : `keyPermissions` est memoisee, donc un controle pose
   * dans une seule methode dependrait de l'ordre d'appel. Chaque lecture
   * commence par la verification, et un refus reste un refus.
   */
  it.each(['keyPermissions', 'balances', 'openOrders'] as const)(
    'ne lit rien d’autre quand %s est appelee la premiere, et refuse les suivantes',
    async (premiere) => {
      const { transport, routes } = transportDe({ accounts: comptes(compte()), open_orders: ordres() });
      const { lecteur } = lecteurDe(transport, VOISIN);
      await expect(lecteur[premiere]()).rejects.toThrow(/COINBASE_PORTFOLIO_UUID/);
      await expect(lecteur.keyPermissions()).rejects.toThrow(/COINBASE_PORTFOLIO_UUID/);
      await expect(lecteur.balances()).rejects.toThrow(/COINBASE_PORTFOLIO_UUID/);
      await expect(lecteur.openOrders()).rejects.toThrow(/COINBASE_PORTFOLIO_UUID/);
      expect(routes.map((route) => route.kind)).toEqual(['key_permissions']);
    },
  );

  it.each(['orderStatus', 'orderFills'] as const)(
    'ne lit aucun ordre avec une cle refusee, par %s',
    async (lecture) => {
      const { transport, routes } = transportDe({ order: execute(), fills: EXECUTIONS });
      await expect(lecteurDe(transport, VOISIN).lecteur[lecture](ORDRE_EXECUTE)).rejects.toThrow(
        /COINBASE_PORTFOLIO_UUID/,
      );
      expect(routes.map((route) => route.kind)).toEqual(['key_permissions']);
    },
  );

  /*
   * **Fabriquee, pas capturee** : la cle de phase 3 n'existe pas encore (E4).
   * C'est la reponse reelle de la cle de phase 1, `can_trade` bascule. La
   * moitie acquise d'E7 : le trade est admis, et lui seul en plus de la
   * lecture — le refus du reste est le bloc precedent, inchange.
   */
  it('admet la cle de phase 3, lecture et trade, sur le bon portefeuille', async () => {
    const { transport } = transportDe({ key_permissions: { ...PERMISSIONS_REELLES, can_trade: true } });
    expect(await ouvrir(transport).keyPermissions()).toEqual({
      canView: true,
      canTrade: true,
      portfolioUuid: PORTEFEUILLE,
    });
  });
});

describe('E8 — les permissions effectives et le portefeuille, au journal de chaque run', () => {
  it('ecrit une ligne et une seule, quel que soit l’ordre des lectures', async () => {
    const { transport } = transportDe({
      accounts: await reelle('coinbase-accounts'),
      open_orders: await reelle('coinbase-orders-open-empty'),
    });
    const { lecteur, journal } = lecteurDe(transport);
    await lecteur.openOrders();
    await lecteur.balances();
    await lecteur.keyPermissions();
    expect(journal).toEqual([
      `cle coinbase — portefeuille=${PORTEFEUILLE} attendu=oui can_view=true can_trade=false can_transfer=false`,
    ]);
  });

  it.each([
    ['sur un autre portefeuille', { portfolio_uuid: PRIMARY }, `portefeuille=${PRIMARY} attendu=NON`],
    ['avec la permission de sortie', { can_transfer: true }, 'can_transfer=true'],
  ])('journalise la cle telle qu’elle est, avant de la refuser %s', async (_cas, ecart, attendu) => {
    const { transport } = transportDe({ key_permissions: { ...PERMISSIONS_REELLES, ...ecart } });
    const { lecteur, journal } = lecteurDe(transport);
    await expect(lecteur.keyPermissions()).rejects.toThrow(CoinbaseFrontierError);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain(attendu);
  });

  /*
   * Par le **vrai** transport, signature comprise, la couche HTTP de ccxt
   * interceptee : c'est la chaine entiere qui ne laisse rien passer, pas le
   * seul lecteur, qui n'a jamais la cle en main. Le jeton signe compte parmi
   * les secrets : il vaut la cle pendant sa duree de vie.
   */
  it('ne laisse passer ni la cle, ni son secret, ni le jeton signe', async () => {
    const CLE_API = '11111111-2222-4333-8444-555555555555';
    const prototype = ccxt.coinbase.prototype as unknown as Record<string, unknown>;
    const original = prototype['fetch'];
    const jetons: string[] = [];
    prototype['fetch'] = (_url: string, _methode: string, entetes?: Record<string, string>) => {
      jetons.push((entetes?.['Authorization'] ?? '').replace('Bearer ', ''));
      return Promise.resolve({ ...PERMISSIONS_REELLES });
    };
    const vus: string[] = [];
    try {
      for (const attendu of [PORTEFEUILLE, PRIMARY]) {
        const transport = ccxtTransport({ coinbaseApiKey: CLE_API, coinbaseApiSecret: SECRET });
        const lecteur = openCoinbase(transport, { portfolioUuid: attendu, log: (l) => vus.push(l) });
        await lecteur.keyPermissions().catch((e: unknown) => vus.push((e as Error).message));
        await transport.close();
      }
    } finally {
      prototype['fetch'] = original;
    }
    // Deux lignes de journal et un refus ; deux jetons signes, donc bien deux appels reels.
    expect(vus).toHaveLength(3);
    expect(jetons).toHaveLength(2);
    for (const secret of [CLE_API, SECRET, ...jetons]) {
      expect(secret.length).toBeGreaterThan(30);
      expect(vus.join('\n')).not.toContain(secret);
    }
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
    await expect(ouvrir(transport).balances()).rejects.toThrow(/sort du portefeuille dedie/);
  });

  it('additionne disponible et bloque sans passer par un flottant', async () => {
    const { transport } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: comptes(compte({ available_balance: { value: '0.1', currency: 'BTC' }, hold: { value: '0.2', currency: 'BTC' } })),
    });
    const { balances } = await ouvrir(transport).balances();
    // 0.1 + 0.2 vaut 0.30000000000000004 en IEEE-754, et 0.3 ici.
    expect(balances[0]?.total.toString()).toBe('0.3');
  });

  it('refuse un solde publie en nombre plutot qu’en chaine', async () => {
    const { transport } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: comptes(compte({ available_balance: { value: 0.03313174, currency: 'BTC' } })),
    });
    await expect(ouvrir(transport).balances()).rejects.toThrow(/a perdu sa precision/);
  });

  it('suit la pagination jusqu’au bout', async () => {
    const { transport, routes } = transportDe({
      key_permissions: await reelle('coinbase-key-permissions'),
      accounts: [
        { accounts: [compte()], has_next: true, cursor: 'page2', size: 1 },
        { accounts: [compte({ currency: 'ETH' })], has_next: false, cursor: '', size: 1 },
      ],
    });
    const { balances } = await ouvrir(transport).balances();
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
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/ETH-EUR refusee/);
  });
});

describe('ordres ouverts', () => {
  it('lit un ordre limit avec ses grandeurs en Decimal', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre()) });
    const [lu] = await ouvrir(transport).openOrders();
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
    const [lu] = await ouvrir(transport).openOrders();
    expect(lu?.quantity.toString()).toBe('1.5');
  });

  it('refuse un ordre sans prix limite', async () => {
    const { transport } = transportDe({
      open_orders: ordres(ordre({ order_configuration: { market_market_ioc: { quote_size: '6.36' } } })),
    });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/aucune configuration limite/);
  });

  it('refuse un sens inconnu', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ side: 'LONG' })) });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/BUY ou SELL/);
  });
});

async function statutDe(reponse: unknown, exchangeId = ORDRE_EXECUTE): Promise<OrderStatus> {
  const { transport } = transportDe({ order: reponse });
  return ouvrir(transport).orderStatus(exchangeId);
}

function connu(statut: OrderStatus): KnownOrderStatus {
  if (statut.kind === 'INDETERMINABLE') throw new Error(`issue attendue, lu : ${statut.reason}`);
  return statut;
}

/**
 * E37, la moitie de l'adapter. **S2 porte la lecture, S8 le branchement dans
 * `reconcile.ts` ; E37 n'est clos qu'apres les deux.** Toutes les reponses
 * d'ordre de ce bloc sont fabriquees (T2), sauf la liste vide, capturee.
 */
describe('E37 — le statut reel d’un ordre donne', () => {
  it('lit un ordre execute, grandeurs et frais en Decimal', async () => {
    const statut = connu(await statutDe(execute()));
    expect(statut).toMatchObject({ kind: 'FILLED', exchangeId: ORDRE_EXECUTE, clientOrderId: '3f2a1b' });
    expect(statut.filled.toFixed()).toBe('0.3');
    expect(statut.averageFilledPrice?.toFixed()).toBe('2503.19');
    expect(statut.fees.toFixed()).toBe('3.003828');
  });

  it('distingue execute, annule, expire et rejete — ccxt replie les trois derniers', async () => {
    const issues: string[] = [];
    for (const status of ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED']) {
      issues.push((await statutDe(execute({ status }))).kind);
    }
    expect(issues).toEqual(['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED']);
  });

  it.each(['PENDING', 'QUEUED', 'OPEN', 'CANCEL_QUEUED'])('lit %s comme un ordre encore vivant', async (status) => {
    expect((await statutDe(execute({ status }))).kind).toBe('OPEN');
  });

  it('garde la quantite executee d’un ordre partiellement execute puis annule', async () => {
    const statut = connu(
      await statutDe(execute({ status: 'CANCELLED', filled_size: '0.1', total_fees: '1.001276' })),
    );
    expect(statut.kind).toBe('CANCELLED');
    expect(statut.filled.toFixed()).toBe('0.1');
    expect(statut.averageFilledPrice?.toFixed()).toBe('2503.19');
    expect(statut.fees.toFixed()).toBe('1.001276');
  });

  it('ne donne pas de prix moyen a un ordre dont rien n’est execute', async () => {
    const statut = connu(
      await statutDe(execute({ status: 'CANCELLED', filled_size: '0', average_filled_price: '0', total_fees: '0' })),
    );
    expect(statut.filled.isZero()).toBe(true);
    expect(statut.averageFilledPrice).toBeNull();
  });

  it('laisse INDETERMINABLE un ordre que l’exchange ne connait pas', async () => {
    // La liste vide reelle du 2026-09-11 : la forme exacte que prend « aucun ordre ».
    const statut = await statutDe(await reelle('coinbase-orders-open-empty'));
    expect(statut).toEqual({ kind: 'INDETERMINABLE', reason: expect.stringMatching(/inconnu de l'exchange/) as unknown });
  });

  /*
   * La sonde du piege de `docs/reconciliation.md` §4, et celle que la mutation
   * de reference doit faire rougir : un statut inconnu replie sur `CANCELLED`
   * classerait en annule cet ordre execute a 100 %.
   */
  it('ne replie pas sur CANCELLED un ordre execute dont le statut est illisible', async () => {
    const statut = await statutDe(execute({ status: 'UNKNOWN_ORDER_STATUS' }));
    expect(statut.kind).toBe('INDETERMINABLE');
    expect(statut).toMatchObject({ reason: expect.stringContaining('quantite executee 0.3') as unknown });
  });

  it.each(['EDIT_QUEUED', 'SETTLED', 'filled', 'toString', 'constructor'])(
    'laisse INDETERMINABLE le statut inconnu %s',
    async (status) => {
      expect((await statutDe(execute({ status }))).kind).toBe('INDETERMINABLE');
    },
  );

  it.each([
    ['un autre ordre', [{ order_id: 'ab12cd34-0000-4000-8000-0000000000f2' }]],
    ['deux ordres', [{}, { order_id: 'ab12cd34-0000-4000-8000-0000000000f2' }]],
  ])('refuse une reponse qui porte %s : le filtre n’a pas ete honore', async (_cas, ecarts) => {
    const [brut] = execute()['orders'] as Record<string, unknown>[];
    const reponse = { ...LISTE_EXECUTE, orders: ecarts.map((ecart) => ({ ...brut, ...ecart })) };
    await expect(statutDe(reponse)).rejects.toThrow(/order_ids n'a pas ete honore/);
  });

  it.each([
    ['des frais publies en nombre', { total_fees: 3.003828 }, /a perdu sa precision/],
    ['une quantite executee illisible', { filled_size: '3e-1' }, /decimale litterale attendue/],
    ['une paire en EUR', { product_id: 'ETH-EUR' }, /ETH-EUR refusee/],
  ])('refuse %s', async (_cas, ecart, motif) => {
    await expect(statutDe(execute(ecart))).rejects.toThrow(motif);
  });
});

describe('E37 — les executions d’un ordre', () => {
  it('les lit sans flottant : leurs sommes sont exactement celles de l’ordre', async () => {
    // La fixture ne prouverait rien si le flottant tombait juste : il se trompe sur les deux.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(1.001276 + 2.002552).not.toBe(3.003828);
    const { transport } = transportDe({ order: execute(), fills: EXECUTIONS });
    const lecteur = ouvrir(transport);
    const ordre = connu(await lecteur.orderStatus(ORDRE_EXECUTE));
    const executions = await lecteur.orderFills(ORDRE_EXECUTE);
    expect(Decimal.sum(...executions.map((e) => e.size)).toFixed()).toBe(ordre.filled.toFixed());
    expect(Decimal.sum(...executions.map((e) => e.commission)).toFixed()).toBe(ordre.fees.toFixed());
    expect(executions.map((e) => [e.tradeId, e.price.toFixed(), e.tradeTime.toISOString()])).toEqual([
      ['00000000-0000-4000-8000-0000000000e1', '2503.19', '2026-09-10T07:12:03.481Z'],
      ['00000000-0000-4000-8000-0000000000e2', '2503.19', '2026-09-10T09:47:55.020Z'],
    ]);
  });

  it('suit le curseur, que la reponse n’accompagne pas de has_next', async () => {
    const [premiere, seconde] = EXECUTIONS['fills'] as unknown[];
    const { transport, routes } = transportDe({
      fills: [
        { fills: [premiere], cursor: 'p2' },
        { fills: [seconde], cursor: '' },
      ],
    });
    const executions = await ouvrir(transport).orderFills(ORDRE_EXECUTE);
    expect(executions.map((e) => e.size.toFixed())).toEqual(['0.1', '0.2']);
    expect(routes.flatMap((r) => (r.kind === 'fills' ? [r.cursor] : []))).toEqual([undefined, 'p2']);
  });

  it('rend une liste vide pour un ordre sans execution', async () => {
    const { transport } = transportDe({ fills: { fills: [], cursor: '' } });
    expect(await ouvrir(transport).orderFills(ORDRE_EXECUTE)).toEqual([]);
  });

  it.each([
    ['d’un autre ordre', { order_id: 'ab12cd34-0000-4000-8000-0000000000f2' }, /order_ids n'a pas ete honore/],
    ['qui corrige une execution', { trade_type: 'REVERSAL' }, /seul FILL/],
    ['dont la taille est en devise de cotation', { size_in_quote: true }, /size_in_quote vaut true/],
    ['dont l’unite de taille n’est pas dite', { size_in_quote: undefined }, /size_in_quote vaut undefined/],
    ['dont la commission est un nombre', { commission: 1.001276 }, /a perdu sa precision/],
  ])('refuse une execution %s', async (_cas, ecart, motif) => {
    const [premiere] = EXECUTIONS['fills'] as Record<string, unknown>[];
    const { transport } = transportDe({ fills: { fills: [{ ...premiere, ...ecart }], cursor: '' } });
    await expect(ouvrir(transport).orderFills(ORDRE_EXECUTE)).rejects.toThrow(motif);
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

  /*
   * Pourquoi la route `order` lit la liste filtree et pas
   * `orders/historical/{order_id}` : l'erreur que ccxt garde dans son source
   * pour un ordre inconnu ne s'y lit pas `OrderNotFound`, mais comme n'importe
   * quelle panne. Un ordre inconnu y arreterait le run au lieu d'etre dit.
   */
  it('ne reconnait pas un ordre inconnu dans le 404 de la lecture par identifiant', () => {
    const corps =
      '{"error":"unknown","error_details":"order with this orderID was not found","message":"order with this orderID was not found"}';
    let erreur: unknown;
    try {
      new ccxt.coinbase({}).handleErrors(404, 'Not Found', '', 'GET', {}, corps, JSON.parse(corps), {}, '');
    } catch (e) {
      erreur = e;
    }
    expect(erreur).toBeInstanceOf(ccxt.ExchangeError);
    expect(erreur).not.toBeInstanceOf(ccxt.OrderNotFound);
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
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/objet attendu/);
  });

  it('refuse un champ de liste qui n’en est pas une', async () => {
    const { transport } = transportDe({ open_orders: { orders: 'aucun', has_next: false } });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/liste attendue/);
  });

  it.each([undefined, '', 7])('refuse un identifiant de produit %p', async (valeur) => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ product_id: valeur })) });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/chaine non vide attendue/);
  });

  it('refuse un horodatage de creation illisible', async () => {
    const { transport } = transportDe({ open_orders: ordres(ordre({ created_time: 'hier' })) });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/horodatage illisible/);
  });

  it('ignore une configuration nulle sans planter', async () => {
    const { transport } = transportDe({
      open_orders: ordres(ordre({ order_configuration: { twap_limit_gtd: null } })),
    });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/aucune configuration limite/);
  });

  it.each(['NaN', 'Infinity', '1e-8', '0x10', '', '1,5'])(
    'refuse la grandeur « %s », que decimal.js accepterait',
    async (valeur) => {
      const { transport } = transportDe({
        key_permissions: await reelle('coinbase-key-permissions'),
        accounts: comptes(compte({ available_balance: { value: valeur, currency: 'BTC' } })),
      });
      await expect(ouvrir(transport).balances()).rejects.toThrow(/decimale litterale attendue/);
    },
  );

  it('arrete une pagination dont le curseur ne progresse pas', async () => {
    const boucle = { orders: [], has_next: true, cursor: 'toujours-la' };
    const { transport, routes } = transportDe({ open_orders: boucle });
    await expect(ouvrir(transport).openOrders()).rejects.toThrow(/ne progresse probablement pas/);
    expect(routes.filter((route) => route.kind === 'open_orders')).toHaveLength(20);
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

  it('lit un ordre par la liste filtree, et ses executions par la leur', async () => {
    const [ordre, executions, suite] = await urlsDe([
      { kind: 'order', exchangeId: ORDRE_EXECUTE },
      { kind: 'fills', exchangeId: ORDRE_EXECUTE },
      { kind: 'fills', exchangeId: ORDRE_EXECUTE, cursor: 'p2' },
    ]);
    expect(ordre).toContain(`/api/v3/brokerage/orders/historical/batch?order_ids=${ORDRE_EXECUTE}`);
    expect(ordre).not.toContain('order_status');
    expect(executions).toContain(`/api/v3/brokerage/orders/historical/fills?order_ids=${ORDRE_EXECUTE}`);
    expect(executions).toContain('limit=250');
    expect(executions).not.toContain('cursor=');
    expect(suite).toContain('cursor=p2');
  });
});
