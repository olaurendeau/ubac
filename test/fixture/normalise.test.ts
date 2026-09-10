import { describe, expect, it } from 'vitest';

import {
  EARLIEST_START_SECONDS,
  expectedCalendar,
  FixtureRefused,
  LATEST_START_SECONDS,
  normaliseCandle,
  normaliseSeries,
  PRICE_FIELDS,
  SECONDS_PER_DAY,
  type RefusalCode,
} from '../../src/fixture/normalise.js';

const SOURCE = 'BTC-USDC';
const JAN_1 = 1_704_067_200; // 2024-01-01T00:00:00Z
const HOUR = 3_600;

/** La seule forme de date que le module a le droit de produire. */
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Une bougie brute plausible, telle qu'une API publique la renvoie. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start: String(JAN_1),
    open: '42283.58',
    high: '44000.01',
    low: '42000.00000001',
    close: '43000.42',
    volume: '1234.5', // un champ de trop ne doit pas gener
    ...overrides,
  };
}

function dayAfter(days: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return raw({ start: String(JAN_1 + days * SECONDS_PER_DAY), ...overrides });
}

/**
 * Vise la cause du refus, pas son texte : un message reformule ne doit pas
 * casser un test, un refus reclasse doit le casser.
 */
function expectRefusal(run: () => unknown, code: RefusalCode): FixtureRefused {
  let refusal: unknown;
  try {
    run();
  } catch (error) {
    refusal = error;
  }
  expect(refusal, 'un refus etait attendu, rien n’a ete leve').toBeInstanceOf(FixtureRefused);
  const refused = refusal as FixtureRefused;
  expect(refused.code).toBe(code);
  return refused;
}

describe('expectedCalendar', () => {
  it('enumere les jours bornes incluses, sans trou', () => {
    expect(expectedCalendar('2024-01-01', '2024-01-04')).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
    ]);
  });

  it('accepte une plage d’un seul jour', () => {
    expect(expectedCalendar('2024-01-01', '2024-01-01')).toEqual(['2024-01-01']);
  });

  it('traverse le 29 fevrier d’une annee bissextile', () => {
    expect(expectedCalendar('2024-02-28', '2024-03-01')).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
  });

  it('compte 974 jours sur la plage du rejeu', () => {
    const calendar = expectedCalendar('2024-01-01', '2026-08-31');
    expect(calendar).toHaveLength(974);
    expect(calendar.at(0)).toBe('2024-01-01');
    expect(calendar.at(-1)).toBe('2026-08-31');
  });

  it('refuse une date inexistante, que Date.parse reporterait en silence', () => {
    expectRefusal(() => expectedCalendar('2024-02-30', '2024-03-05'), 'RANGE_MALFORMED');
  });

  it.each(['01/01/2024', '2024-1-1', '2024-01-01T00:00:00Z', ''])(
    'refuse la borne « %s », qui n’est pas au format YYYY-MM-DD',
    (day) => {
      expectRefusal(() => expectedCalendar(day, '2024-03-05'), 'RANGE_MALFORMED');
    },
  );

  it('refuse une borne de fin anterieure a la borne de debut', () => {
    expectRefusal(() => expectedCalendar('2024-03-05', '2024-03-04'), 'RANGE_MALFORMED');
  });
});

describe('normaliseCandle — la bougie nominale', () => {
  it('accepte un bucket ouvrant a 00:00:00 UTC et en deduit le jour', () => {
    expect(normaliseCandle(SOURCE, raw())).toEqual({
      date: '2024-01-01',
      open: '42283.58',
      high: '44000.01',
      low: '42000.00000001',
      close: '43000.42',
    });
  });

  it('conserve l’ecriture des prix de la source', () => {
    // Un aller-retour par Decimal rendrait « 42283.5800 » puis « 42283.58 » :
    // la fixture ne serait plus comparable a la source ligne pour ligne.
    const candle = normaliseCandle(SOURCE, raw({ open: '42283.5800', close: '43000' }));
    expect(candle.open).toBe('42283.5800');
    expect(candle.close).toBe('43000');
  });

  it('accepte un horodatage publie en nombre plutot qu’en chaine', () => {
    expect(normaliseCandle(SOURCE, raw({ start: JAN_1 })).date).toBe('2024-01-01');
  });
});

describe('refus — horodatage non multiple de 86 400 s', () => {
  // Le controle central de l'etape : une source qui cloture ailleurs qu'a
  // 00:00 UTC decale toute la serie sans faire echouer un seul test du rejeu.
  it.each([
    ['cloture a 01:00 UTC', HOUR],
    ['cloture a 22:00 UTC, veille', -2 * HOUR],
    ['cloture a 08:00 UTC, fuseau asiatique', 8 * HOUR],
    ['une seconde avant minuit', SECONDS_PER_DAY - 1],
  ])('refuse une bougie decalee (%s)', (_label, offset) => {
    const refusal = expectRefusal(
      () => normaliseCandle(SOURCE, raw({ start: String(JAN_1 + offset) })),
      'TIMESTAMP_NOT_UTC_MIDNIGHT',
    );
    expect(refusal.message).toContain('00:00 UTC');
  });

  it.each([
    ['absent', undefined],
    ['vide', ''],
    ['non numerique', 'hier'],
    ['fractionnaire', JAN_1 + 0.5],
    ['hors des entiers surs', 1e21],
  ])('refuse un horodatage %s', (_label, start) => {
    expectRefusal(() => normaliseCandle(SOURCE, raw({ start })), 'CANDLE_MALFORMED');
  });

  it('refuse une bougie qui n’est pas un objet', () => {
    expectRefusal(() => normaliseCandle(SOURCE, null), 'CANDLE_MALFORMED');
    expectRefusal(() => normaliseCandle(SOURCE, '2024-01-01'), 'CANDLE_MALFORMED');
  });
});

describe('refus — horodatage qui n’est pas exprime en secondes', () => {
  // Le talon d'Achille du controle d'alignement : il est aveugle a l'unite. Si s
  // est multiple de 86 400, alors s x 1000 et s x 1e6 le sont aussi. Sans borne
  // de plausibilite, une source qui passe en millisecondes traverse le module
  // sans qu'aucun refus ne se declenche — et decale toute la fixture.
  it('refuse un horodatage publie en millisecondes et nomme l’unite probable', () => {
    const refusal = expectRefusal(
      () => normaliseCandle(SOURCE, raw({ start: String(JAN_1 * 1_000) })),
      'TIMESTAMP_OUT_OF_RANGE',
    );
    expect(refusal.message).toContain('millisecondes');
  });

  it('refuse un horodatage publie en microsecondes et nomme l’unite probable', () => {
    const refusal = expectRefusal(
      () => normaliseCandle(SOURCE, raw({ start: JAN_1 * 1_000_000 })),
      'TIMESTAMP_OUT_OF_RANGE',
    );
    expect(refusal.message).toContain('microsecondes');
  });

  it('ne rend jamais une date de l’an 55969 pour un horodatage en millisecondes', () => {
    // La sortie reelle de la version precedente sur 1 704 067 200 000 :
    // « +055969-09 », que toISOString().slice(0, 10) produit sans broncher hors
    // des annees 1000 a 9999. Ce n'etait pas un YYYY-MM-DD et rien ne le disait.
    expectRefusal(
      () => normaliseCandle(SOURCE, raw({ start: 1_704_067_200_000 })),
      'TIMESTAMP_OUT_OF_RANGE',
    );
  });

  it('leve un refus code, pas un RangeError, hors des bornes de Date', () => {
    // Number.isSafeInteger etait la seule borne : au-dela des bornes de Date,
    // toISOString levait « Invalid time value », que l'appelant ne voyait pas
    // passer en attrapant FixtureRefused. expectRefusal exige l'instance.
    const refusal = expectRefusal(
      () => normaliseCandle(SOURCE, raw({ start: Number.MAX_SAFE_INTEGER })),
      'TIMESTAMP_OUT_OF_RANGE',
    );
    // Aucune unite ne colle : mieux vaut ne rien affirmer que deviner faux.
    expect(refusal.message).not.toContain('vraisemblablement');
  });

  it.each([
    ['la borne basse', EARLIEST_START_SECONDS, '2009-01-01'],
    ['la borne haute', LATEST_START_SECONDS, '2100-01-01'],
  ])('accepte %s de la plage, incluse', (_label, start, day) => {
    expect(normaliseCandle(SOURCE, raw({ start: String(start) })).date).toBe(day);
  });

  it.each([
    ['la veille de la borne basse', EARLIEST_START_SECONDS - SECONDS_PER_DAY],
    ['le lendemain de la borne haute', LATEST_START_SECONDS + SECONDS_PER_DAY],
    ['l’epoch elle-meme', 0],
    ['un horodatage negatif', -SECONDS_PER_DAY],
  ])('refuse %s', (_label, start) => {
    expectRefusal(() => normaliseCandle(SOURCE, raw({ start })), 'TIMESTAMP_OUT_OF_RANGE');
  });
});

describe('la date produite est toujours un YYYY-MM-DD', () => {
  it('sur toute la plage du rejeu, calendrier comme bougies', () => {
    const calendar = expectedCalendar('2024-01-01', '2026-08-31');
    expect(calendar.filter((day) => !DAY_SHAPE.test(day))).toEqual([]);

    const series = normaliseSeries(
      SOURCE,
      calendar.map((_day, index) => dayAfter(index)),
      calendar,
    );
    expect(series).toHaveLength(calendar.length);
    expect(series.filter((candle) => !DAY_SHAPE.test(candle.date))).toEqual([]);
  });

  it('n’accepte pas un calendrier de chaines nues', () => {
    // La marque UtcDay n'existe qu'a la compilation : c'est tsc qui refuse ici,
    // pas le test. Si la marque s'effondrait sur string, l'attente ci-dessous
    // ne serait plus satisfaite et le typecheck echouerait.
    // @ts-expect-error un calendrier se fabrique par expectedCalendar, pas a la main
    expect(normaliseSeries(SOURCE, [raw()], ['2024-01-01'])).toHaveLength(1);
  });
});

describe('refus — prix nul ou negatif', () => {
  it.each(PRICE_FIELDS)('refuse un prix nul sur %s', (field) => {
    expectRefusal(() => normaliseCandle(SOURCE, raw({ [field]: '0' })), 'PRICE_NOT_POSITIVE');
  });

  it.each(PRICE_FIELDS)('refuse un prix negatif sur %s', (field) => {
    expectRefusal(() => normaliseCandle(SOURCE, raw({ [field]: '-1.5' })), 'PRICE_NOT_POSITIVE');
  });

  it.each(['0.00000000', '-0', 'NaN', 'Infinity', '-Infinity'])(
    'refuse le prix « %s »',
    (value) => {
      expectRefusal(() => normaliseCandle(SOURCE, raw({ close: value })), 'PRICE_NOT_POSITIVE');
    },
  );

  it('refuse un prix publie en nombre JSON', () => {
    // Il est deja passe par un flottant binaire avant qu'on le voie : on ne peut
    // plus verifier ce qu'il valait. C'est la frontiere ou la regle « aucun
    // number flottant sur un prix » se joue.
    expectRefusal(() => normaliseCandle(SOURCE, raw({ close: 43000.42 })), 'CANDLE_MALFORMED');
  });

  it.each([['prix absent', undefined], ['prix illisible', '42 000,10']])(
    'refuse un %s',
    (_label, value) => {
      expectRefusal(() => normaliseCandle(SOURCE, raw({ high: value })), 'CANDLE_MALFORMED');
    },
  );
});

describe('normaliseSeries — la serie nominale', () => {
  const calendar = expectedCalendar('2024-01-01', '2024-01-03');

  it('ordonne la serie et ignore le debordement de pagination', () => {
    const series = normaliseSeries(
      SOURCE,
      [dayAfter(2), dayAfter(0), dayAfter(7), dayAfter(1), dayAfter(-3)],
      calendar,
    );
    expect(series.map((candle) => candle.date)).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ]);
  });

  it('tolere un doublon exact, que le recouvrement des pages produit', () => {
    const series = normaliseSeries(
      SOURCE,
      [dayAfter(0), dayAfter(1), dayAfter(1), dayAfter(2)],
      calendar,
    );
    expect(series).toHaveLength(3);
  });

  it('retourne un tableau vide sans jamais toucher au disque ni au reseau', () => {
    expect(normaliseSeries(SOURCE, [], [])).toEqual([]);
  });
});

describe('refus — deux lignes du meme jour aux valeurs differentes', () => {
  const calendar = expectedCalendar('2024-01-01', '2024-01-02');

  it.each(PRICE_FIELDS)('refuse deux bougies qui divergent sur %s', (field) => {
    const refusal = expectRefusal(
      () =>
        normaliseSeries(
          SOURCE,
          [dayAfter(0), dayAfter(1), dayAfter(1, { [field]: '99999.99' })],
          calendar,
        ),
      'DUPLICATE_MISMATCH',
    );
    expect(refusal.message).toContain('2024-01-02');
  });

  it('ne voit pas de contradiction entre deux ecritures du meme prix', () => {
    // « 43000.42 » et « 43000.4200 » sont le meme prix. Comparer les chaines
    // ferait echouer la fixture sur une difference de formatage de la source.
    const series = normaliseSeries(
      SOURCE,
      [dayAfter(0), dayAfter(1), dayAfter(1, { close: '43000.4200' })],
      calendar,
    );
    expect(series).toHaveLength(2);
  });
});

describe('refus — jour manquant dans la serie', () => {
  const calendar = expectedCalendar('2024-01-01', '2024-01-04');

  it('refuse un trou au milieu de la serie et nomme le jour absent', () => {
    const refusal = expectRefusal(
      () => normaliseSeries(SOURCE, [dayAfter(0), dayAfter(1), dayAfter(3)], calendar),
      'DAY_MISSING',
    );
    expect(refusal.message).toContain('2024-01-03');
  });

  it('refuse un trou en fin de serie', () => {
    expectRefusal(
      () => normaliseSeries(SOURCE, [dayAfter(0), dayAfter(1), dayAfter(2)], calendar),
      'DAY_MISSING',
    );
  });

  it('refuse un trou meme quand le compte de bougies tombe juste', () => {
    // Un doublon et un debordement de pagination compensent le jour absent :
    // un controle par comptage laisserait passer, un controle par jour non.
    expectRefusal(
      () =>
        normaliseSeries(
          SOURCE,
          [dayAfter(0), dayAfter(1), dayAfter(1), dayAfter(3), dayAfter(9)],
          calendar,
        ),
      'DAY_MISSING',
    );
  });

  it('ne repare rien : le message exclut remplissage, report et interpolation', () => {
    const refusal = expectRefusal(
      () => normaliseSeries(SOURCE, [dayAfter(0), dayAfter(1), dayAfter(3)], calendar),
      'DAY_MISSING',
    );
    expect(refusal.message).toMatch(/remplissage/);
    expect(refusal.message).toMatch(/interpolation/);
  });
});

describe('l’alignement se controle sur la source, pas sur le calendrier', () => {
  it('refuse une bougie decalee meme si elle tombe hors du calendrier demande', () => {
    // Une bougie decalee hors plage prouve que la source cloture ailleurs : la
    // jeter avec le debordement de pagination masquerait exactement le decalage
    // que cette etape existe pour attraper.
    expectRefusal(
      () =>
        normaliseSeries(
          SOURCE,
          [dayAfter(0), dayAfter(1), raw({ start: String(JAN_1 + 30 * SECONDS_PER_DAY + HOUR) })],
          expectedCalendar('2024-01-01', '2024-01-02'),
        ),
      'TIMESTAMP_NOT_UTC_MIDNIGHT',
    );
  });
});
