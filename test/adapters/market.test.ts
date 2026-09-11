import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CoinbaseFrontierError } from '../../src/adapters/coinbase.js';
import type { CoinbaseRoute, CoinbaseTransport } from '../../src/adapters/coinbase.js';
import { openMarketData } from '../../src/adapters/market.js';
import { FixtureRefused, SECONDS_PER_DAY } from '../../src/fixture/normalise.js';
import type { RefusalCode } from '../../src/fixture/normalise.js';

/**
 * Sans reseau. La serie de reference est **reelle** : huit bougies daily
 * BTC-USDC capturees le 2026-09-11 sur `/api/v3/brokerage/market/.../candles`.
 * Elle porte les deux formes que personne n'invente — un horodatage `start`
 * publie en **chaine** de secondes, et des prix entiers ecrits sans decimale
 * (`"76440"`) a cote de prix a deux decimales.
 *
 * Ce fichier ne teste pas le normaliseur : `test/fixture/normalise.test.ts` le
 * fait depuis la phase 0. Il teste que l'adapter lui passe bien la main, et que
 * le refus arrive intact jusqu'a l'appelant.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** La fenetre exacte que couvre la capture. */
const PREMIER = '2026-09-04';
const DERNIER = '2026-09-11';
const PREMIER_SECONDES = 1_788_480_000;

async function captureReelle(): Promise<Record<string, unknown>[]> {
  const brut = JSON.parse(
    await readFile(resolve(FIXTURES, 'coinbase-candles-btc-usdc.json'), 'utf8'),
  ) as { candles: Record<string, unknown>[] };
  return brut.candles;
}

function transportDe(reponse: unknown): { transport: CoinbaseTransport; routes: CoinbaseRoute[] } {
  const routes: CoinbaseRoute[] = [];
  return {
    routes,
    transport: {
      async read(route: CoinbaseRoute): Promise<unknown> {
        routes.push(route);
        return reponse;
      },
      async close(): Promise<void> {},
    },
  };
}

/** Vise le code de refus, pas son texte : un message reformule reste valide. */
async function refusDe(promesse: Promise<unknown>): Promise<RefusalCode> {
  try {
    await promesse;
  } catch (error) {
    if (error instanceof FixtureRefused) return error.code;
    throw error;
  }
  throw new Error('aucun refus, alors qu’un refus etait attendu');
}

describe('serie reelle capturee le 2026-09-11', () => {
  it('rend la fenetre entiere, ordonnee du plus ancien au plus recent', async () => {
    const { transport } = transportDe({ candles: await captureReelle() });
    const serie = await openMarketData(transport).dailyCandles('BTC', {
      firstDay: PREMIER,
      lastDay: DERNIER,
    });
    expect(serie).toHaveLength(8);
    // L'API les rend du plus recent au plus ancien ; c'est le calendrier du
    // normaliseur qui remet l'ordre, pas l'ordre d'arrivee.
    expect(serie.map((c) => c.date)).toEqual([
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]);
  });

  it('conserve les prix tels que la source les a ecrits', async () => {
    const { transport } = transportDe({ candles: await captureReelle() });
    const serie = await openMarketData(transport).dailyCandles('BTC', {
      firstDay: PREMIER,
      lastDay: DERNIER,
    });
    const veille = serie.find((c) => c.date === '2026-09-10');
    // "76440" sans decimale dans la capture, et 76440 exactement ici.
    expect(veille?.low.toString()).toBe('76440');
    expect(veille?.close.toString()).toBe('76536.55');
    expect(veille?.close.toFixed(2)).toBe('76536.55');
  });

  it('demande la fenetre en secondes, bornes aux ouvertures de jour', async () => {
    const { transport, routes } = transportDe({ candles: await captureReelle() });
    await openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER });
    expect(routes).toEqual([
      {
        kind: 'daily_candles',
        product: 'BTC-USDC',
        startSeconds: PREMIER_SECONDES,
        endSeconds: PREMIER_SECONDES + 7 * SECONDS_PER_DAY,
      },
    ]);
  });
});

describe('le controle de serie reste celui de la phase 0', () => {
  it('refuse un trou plutot que de le combler', async () => {
    const capture = await captureReelle();
    const troue = capture.filter((c) => c['start'] !== '1788825600');
    const { transport } = transportDe({ candles: troue });
    const code = await refusDe(
      openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER }),
    );
    expect(code).toBe('DAY_MISSING');
  });

  it('refuse une bougie qui n’ouvre pas a 00:00 UTC', async () => {
    const capture = await captureReelle();
    const decale = capture.map((c, index) =>
      index === 0 ? { ...c, start: String(Number(c['start']) + 3_600) } : c,
    );
    const { transport } = transportDe({ candles: decale });
    const code = await refusDe(
      openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER }),
    );
    expect(code).toBe('TIMESTAMP_NOT_UTC_MIDNIGHT');
  });

  it('refuse un prix nul ou negatif', async () => {
    const capture = await captureReelle();
    const nul = capture.map((c, index) => (index === 0 ? { ...c, low: '0' } : c));
    const { transport } = transportDe({ candles: nul });
    const code = await refusDe(
      openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER }),
    );
    expect(code).toBe('PRICE_NOT_POSITIVE');
  });

  it('refuse un prix publie en nombre JSON, deja passe par un flottant', async () => {
    const capture = await captureReelle();
    const flottant = capture.map((c, index) => (index === 0 ? { ...c, close: 77215.57 } : c));
    const { transport } = transportDe({ candles: flottant });
    const code = await refusDe(
      openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER }),
    );
    expect(code).toBe('CANDLE_MALFORMED');
  });

  it('refuse une fenetre dont les bornes ne forment pas un calendrier', async () => {
    const { transport } = transportDe({ candles: [] });
    const code = await refusDe(
      openMarketData(transport).dailyCandles('BTC', { firstDay: DERNIER, lastDay: PREMIER }),
    );
    expect(code).toBe('RANGE_MALFORMED');
  });
});

describe('frontiere de l’adapter', () => {
  it('n’appelle pas l’API quand les bornes sont deja fautives', async () => {
    const { transport, routes } = transportDe({ candles: [] });
    await expect(
      openMarketData(transport).dailyCandles('BTC', { firstDay: '2026-02-30', lastDay: DERNIER }),
    ).rejects.toThrow(FixtureRefused);
    expect(routes).toEqual([]);
  });

  it('refuse USDC comme actif : c’est la contrepartie, pas une ligne', async () => {
    const { transport, routes } = transportDe({ candles: [] });
    await expect(
      openMarketData(transport).dailyCandles('USDC', { firstDay: PREMIER, lastDay: DERNIER }),
    ).rejects.toThrow(CoinbaseFrontierError);
    expect(routes).toEqual([]);
  });

  it('refuse une fenetre plus large que ce qu’un appel rend', async () => {
    const { transport } = transportDe({ candles: [] });
    await expect(
      openMarketData(transport).dailyCandles('BTC', { firstDay: '2025-01-01', lastDay: DERNIER }),
    ).rejects.toThrow(/Decouper la fenetre/);
  });

  it('accepte les 200 jours de la spec', async () => {
    const { transport, routes } = transportDe({ candles: [] });
    // La serie est vide, donc le refus vient du normaliseur et pas du plafond :
    // c'est bien que la fenetre, elle, est passee.
    const code = await refusDe(
      openMarketData(transport).dailyCandles('BTC', { firstDay: '2026-02-24', lastDay: DERNIER }),
    );
    expect(code).toBe('DAY_MISSING');
    expect(routes).toHaveLength(1);
  });

  it('refuse une reponse sans champ candles', async () => {
    const { transport } = transportDe({ erreur: 'INVALID_ARGUMENT' });
    await expect(
      openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER }),
    ).rejects.toThrow(/champ candles absent/);
  });

  it('refuse une reponse qui n’est pas un objet', async () => {
    const { transport } = transportDe('KO');
    await expect(
      openMarketData(transport).dailyCandles('BTC', { firstDay: PREMIER, lastDay: DERNIER }),
    ).rejects.toThrow(/objet attendu/);
  });
});
