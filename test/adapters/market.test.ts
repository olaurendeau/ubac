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
 *
 * La capture ne suffit pourtant pas a tout : aucun de ses prix n'est
 * **decimalement sensible**, donc aucun ne peut prouver que le chemin ne passe
 * pas par un flottant. C'est le role de `BOUGIE_SENSIBLE`, plus bas, qui est
 * fabriquee et non capturee.
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
    /*
     * Les quatre champs, pas deux : ils sont convertis par quatre appels
     * distincts, et n'en verifier que deux laissait passer un `open` branche
     * sur `high`. Verifie par mutation — la permutation passait les 14 tests.
     *
     * Ces valeurs-la disent la **correspondance** des champs et l'ecriture
     * conservee (« 76440 » sans decimale dans la capture, et 76440 ici). Elles
     * ne disent rien du flottant : aucune n'est decimalement sensible. C'est
     * `BOUGIE_SENSIBLE` qui porte cette preuve.
     */
    expect(veille?.open.toString()).toBe('78283.98');
    expect(veille?.high.toString()).toBe('78554.18');
    expect(veille?.low.toString()).toBe('76440');
    expect(veille?.close.toString()).toBe('76536.55');
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

/**
 * Une bougie **fabriquee**, et deliberement pas capturee.
 *
 * Aucun prix de la capture ne peut prouver qu'aucun flottant n'intervient :
 * « 76536.55 » repasse par un double et en ressort identique, parce que
 * `String(Number(x))` rend la plus courte ecriture qui retombe sur le meme
 * double. Mesure faite : en remplacant `candle.close` par
 * `String(Number(candle.close))` dans `market.ts`, les quatorze tests de ce
 * fichier restaient verts. Un test qui passe aussi sur une implementation
 * fausse ne couvre rien.
 *
 * Les quatre prix ci-dessous portent un chiffre au-dela de ce qu'un double
 * distingue. Autour de 78 000, l'exposant binaire vaut 16 : deux doubles
 * consecutifs y sont espaces de 2^(16-52), soit environ 1,46e-11. La derniere
 * decimale ecrite ici pese 1e-12, sous cet ecart — elle n'a pas de double a
 * elle, donc la conversion la perd et ne peut pas la rendre. Le `Decimal`
 * construit sur la chaine, lui, la garde : c'est toute la difference que ce
 * test mesure.
 *
 * Ne pas arrondir ces valeurs « pour simplifier » : un prix rond rendrait le
 * test muet sans rien casser. Le test « ces prix sont bien sensibles » plus bas
 * echoue si quelqu'un le fait quand meme.
 */
const JOUR_SENSIBLE = '2026-09-10';
const BOUGIE_SENSIBLE = {
  start: '1788998400',
  open: '78283.980000000001',
  high: '78554.179999999999',
  low: '76440.000000000001',
  close: '76536.550000000001',
  volume: '6390.76117588',
} as const;

describe('aucun flottant sur le chemin du prix', () => {
  it('ces prix sont bien sensibles : un aller-retour par Number les abime', () => {
    /*
     * Le garde-fou du garde-fou, et la raison d'ecrire les quatre a la main :
     * tant que ces quatre assertions tiennent, chaque comparaison du test
     * suivant distingue vraiment la chaine d'origine d'un flottant. Arrondir
     * un des prix fait tomber ce test-ci, avant meme l'autre.
     */
    expect(String(Number(BOUGIE_SENSIBLE.open))).toBe('78283.98');
    expect(String(Number(BOUGIE_SENSIBLE.high))).toBe('78554.18');
    expect(String(Number(BOUGIE_SENSIBLE.low))).toBe('76440');
    expect(String(Number(BOUGIE_SENSIBLE.close))).toBe('76536.55');
  });

  it('rend chaque prix chiffre pour chiffre, tel que la source l’a ecrit', async () => {
    const { transport } = transportDe({ candles: [BOUGIE_SENSIBLE] });
    const serie = await openMarketData(transport).dailyCandles('BTC', {
      firstDay: JOUR_SENSIBLE,
      lastDay: JOUR_SENSIBLE,
    });
    const bougie = serie[0];
    expect(bougie?.date).toBe(JOUR_SENSIBLE);
    /*
     * `toString()` et pas `eq` ni `toFixed` : une egalite numerique tolere la
     * perte des que les deux cotes ont fait le meme aller-retour, et un
     * arrondi a deux decimales l'efface. Seule la chaine exacte la montre.
     */
    expect(bougie?.open.toString()).toBe('78283.980000000001');
    expect(bougie?.high.toString()).toBe('78554.179999999999');
    expect(bougie?.low.toString()).toBe('76440.000000000001');
    expect(bougie?.close.toString()).toBe('76536.550000000001');
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
