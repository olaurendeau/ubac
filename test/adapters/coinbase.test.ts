import ccxt from 'ccxt';
import { describe, expect, it } from 'vitest';

import * as coinbase from '../../src/adapters/coinbase.js';
import { ccxtTransport, READ_ROUTES } from '../../src/adapters/coinbase.js';
import type { CoinbaseRoute } from '../../src/adapters/coinbase.js';

/**
 * Aucun de ces tests ne touche au reseau. Le transport n'ayant rien a relire,
 * tout se verifie soit sur la requete construite — `sign()` de ccxt ne fait que
 * la fabriquer — soit en interceptant la couche HTTP juste avant l'envoi.
 */

/**
 * La meme regexp de noms d'ecriture qu'`eslint.config.js` applique a
 * `src/adapters/`. Recopiee ici a dessein : le lint garde le **source**, ce test
 * garde la **surface exportee a l'execution**, y compris ce qu'une refonte
 * future y ajouterait par un chemin que le lint ne regarde pas.
 */
// 64 octets : graine de 32 + cle publique, la forme reelle du secret CDP.
const SECRET = Buffer.alloc(64, 7).toString('base64');
const CLE = '00000000-0000-4000-8000-000000000001';

const VERBES = ['create', 'place', 'submit', 'send', 'post', 'edit', 'amend', 'modify', 'replace', 'cancel', 'close'];
const ECRITURE = new RegExp(
  `^(?:(?:${VERBES.join('|')})[A-Za-z_]*[Oo]rders?|[A-Za-z_]*(?:[Ww]ithdraw|[Tt]ransfer)[A-Za-z_]*)$`,
);

describe('surface du transport — aucune ecriture, ni exportee ni atteignable', () => {
  it('n’exporte aucun nom de placement, d’annulation ou de retrait', () => {
    expect(Object.keys(coinbase).filter((nom) => ECRITURE.test(nom))).toEqual([]);
  });

  it('n’a que quatre routes, toutes en lecture', () => {
    expect([...READ_ROUTES]).toEqual(['key_permissions', 'accounts', 'open_orders', 'daily_candles']);
    expect([...READ_ROUTES].filter((route) => ECRITURE.test(route))).toEqual([]);
  });

  it('n’expose sur le transport qu’un verbe de lecture et une fermeture', () => {
    const transport = ccxtTransport({
      coinbaseApiKey: CLE,
      coinbaseApiSecret: SECRET,
    });
    // `close` ferme le transport HTTP ; il ne denote pas une fermeture d'ordre,
    // et la regexp ci-dessus ne le confond pas (`close` seul n'y correspond pas).
    expect(Object.keys(transport).sort()).toEqual(['close', 'read']);
  });
});

/**
 * Les deux pieges de `docs/cle-coinbase.md`, mesures contre l'API et figes ici
 * sans reseau. Si une montee de version casse l'un des deux, ce test le dit
 * avant que la production ne recolte un 401 qui ressemble a une cle revoquee.
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

/**
 * Le mappage route -> endpoint, verifie sans reseau en interceptant la couche
 * HTTP de ccxt. C'est le test qui garde le choix de la v3 : `fetchBalance()` de
 * ccxt appelle `/v2/accounts`, que le scoping de la cle ne couvre pas.
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

describe('transport ccxt', () => {
  it('se construit a partir des secrets valides et se ferme', async () => {
    const transport = ccxtTransport({ coinbaseApiKey: CLE, coinbaseApiSecret: SECRET });
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
