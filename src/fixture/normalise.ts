/**
 * Normalisation des bougies daily de la fixture de rejeu. Pur : ni reseau, ni
 * acces disque, ni horloge. Le telechargement et l'ecriture des CSV vivent dans
 * scripts/ ; ce module ne fait que decider si une serie est acceptable, a partir
 * de bougies deja en memoire.
 *
 * Il repond a l'incertitude « la fixture n'est pas auditee » de la spec. Le
 * controle central est celui du fuseau de cloture : les bougies daily crypto
 * ouvrent a 00:00:00 UTC, et une source qui cloture en heure locale decale toute
 * la serie. Ce decalage ne casse aucun test du rejeu — il change juste tous les
 * resultats. C'est pour ca que le controle doit etre ici, importable depuis un
 * test, et pas affirme en commentaire au fond d'un script.
 *
 * L'alignement sur 86 400 s ne suffit pas a lui seul : il est aveugle a l'unite.
 * Si s est multiple de 86 400, s x 1000 (millisecondes) et s x 1e6
 * (microsecondes) le sont aussi, donc une source qui change d'unite le
 * franchirait sans bruit. Il faut le lire avec les bornes de plausibilite
 * ci-dessous : l'un dit « a la bonne heure », les autres « dans la bonne unite ».
 *
 * Ce module vit hors de src/core/, donc les regles de purete d'eslint.config.js
 * ne le couvrent pas : l'absence d'IO y est une discipline, pas une contrainte
 * outillee.
 */
import { Decimal } from 'decimal.js';

export const SECONDS_PER_DAY = 86_400;

/**
 * Bornes de plausibilite d'un horodatage exprime **en secondes**, incluses.
 *
 * Ce sont elles qui attrapent un changement d'unite de la source, que
 * l'alignement sur 86 400 s ne peut pas voir. Elles sont larges a dessein : le
 * premier bloc Bitcoin date de janvier 2009, et rien de plausible dans une
 * fixture de bougies ne se date au-dela de 2100. Une source qui publierait 2024
 * en millisecondes se place a 1.7e12 s, soit l'an 55969 — environ 400 fois la
 * borne haute, donc refusee sans la moindre ambiguite.
 */
export const EARLIEST_START_SECONDS = 1_230_768_000; // 2009-01-01T00:00:00Z
export const LATEST_START_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

/** Les quatre prix d'une bougie. L'ordre sert aussi aux messages d'erreur. */
export const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;

export type PriceField = (typeof PRICE_FIELDS)[number];

/**
 * Un jour UTC au format `YYYY-MM-DD`. La marque n'existe qu'a la compilation ;
 * elle vaut pour ce qu'elle interdit : construire une `NormalisedCandle` ou un
 * calendrier avec une chaine quelconque. `utcDay()` est le seul endroit qui la
 * pose, et c'est le seul endroit qui verifie la forme.
 *
 * Sans elle, `date: string` laissait passer « +055969-09 » — la sortie reelle
 * de `toISOString().slice(0, 10)` sur un horodatage publie en millisecondes.
 */
export type UtcDay = string & { readonly __brand: 'UtcDay' };

/**
 * Une bougie normalisee : un jour UTC, quatre prix conserves **tels que la
 * source les a ecrits**. Les prix restent des chaines : les reserialiser depuis
 * un Decimal leur ferait perdre des chiffres au passage, et la fixture doit
 * pouvoir etre comparee a la source ligne pour ligne.
 */
export interface NormalisedCandle {
  readonly date: UtcDay;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

export type RefusalCode =
  /** La bougie n'a pas la forme attendue : champ absent, type inutilisable. */
  | 'CANDLE_MALFORMED'
  /** Le bucket n'ouvre pas a 00:00:00 UTC : la source ne cloture pas ou on l'attend. */
  | 'TIMESTAMP_NOT_UTC_MIDNIGHT'
  /** L'horodatage n'est pas un nombre de secondes plausible : unite changee, le plus souvent. */
  | 'TIMESTAMP_OUT_OF_RANGE'
  /** Un prix nul, negatif, infini ou NaN. */
  | 'PRICE_NOT_POSITIVE'
  /** Deux bougies du meme jour, aux valeurs differentes. */
  | 'DUPLICATE_MISMATCH'
  /** Un jour du calendrier attendu que la source ne fournit pas. */
  | 'DAY_MISSING'
  /** Les bornes demandees ne forment pas un calendrier. */
  | 'RANGE_MALFORMED';

/**
 * Un refus porte un code, pas seulement un message : c'est ce qui permet a un
 * test de viser une cause precise sans dependre du texte francais de l'erreur.
 */
export class FixtureRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FixtureRefused';
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SECONDS_PATTERN = /^\d+$/;

/** Borne de l'objet `Date` : au-dela, `toISOString()` leve un `RangeError`. */
const MAX_DATE_MS = 8.64e15;

function isoOf(seconds: number): string | null {
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * L'instant UTC d'un horodatage, pour les messages. Ne leve jamais : un
 * horodatage hors des bornes de `Date` se rend tel quel. Sinon le refus qu'on
 * est en train de construire serait masque par un `RangeError` nu.
 */
function utcInstant(seconds: number): string {
  return isoOf(seconds) ?? `${seconds} s depuis l'epoch`;
}

/**
 * Le jour UTC d'un horodatage, garanti au format `YYYY-MM-DD` — c'est le seul
 * endroit du module ou une `UtcDay` se fabrique.
 *
 * `toISOString()` ne rend cette forme que pour les annees 1000 a 9999. Ailleurs
 * il rend « +055969-09-06T... », dont `slice(0, 10)` donne « +055969-09 » ; et
 * hors des bornes de `Date` il leve un `RangeError`. Les deux sortent du module
 * sans code de refus — un appelant qui attrape `FixtureRefused` ne les voit pas
 * passer. Le controle ci-dessous est ce qui rend la fonction totale.
 */
function utcDay(seconds: number, code: RefusalCode, where: string): UtcDay {
  const day = isoOf(seconds)?.slice(0, 10);
  if (day === undefined || !DAY_PATTERN.test(day)) {
    throw new FixtureRefused(
      code,
      `${where} : ${seconds} s depuis l'epoch ne donne pas un jour au format YYYY-MM-DD`,
    );
  }
  return day as UtcDay;
}

/** L'horodatage tombe-t-il dans les bornes de plausibilite, en secondes ? */
function isPlausibleSeconds(seconds: number): boolean {
  return seconds >= EARLIEST_START_SECONDS && seconds <= LATEST_START_SECONDS;
}

/**
 * Millisecondes et microsecondes sont les deux unites qui se confondent avec la
 * seconde dans une API publique. Quand l'horodatage refuse redevient plausible
 * une fois divise, le dire : la cause n'est pas la valeur, c'est son echelle.
 * Les nanosecondes ne sont pas listees — a cet ordre de grandeur l'horodatage
 * n'est plus un entier sur, il est refuse en amont comme illisible.
 */
const CONFUSABLE_UNITS: readonly (readonly [number, string])[] = [
  [1_000, 'millisecondes'],
  [1_000_000, 'microsecondes'],
];

function unitHint(value: number): string {
  for (const [factor, unit] of CONFUSABLE_UNITS) {
    const seconds = value / factor;
    if (Number.isInteger(seconds) && isPlausibleSeconds(seconds)) {
      return ` — la source publie vraisemblablement en ${unit} (${utcInstant(seconds)})`;
    }
  }
  return '';
}

function dayStart(day: string, label: string): number {
  if (!DAY_PATTERN.test(day)) {
    throw new FixtureRefused(
      'RANGE_MALFORMED',
      `${label} : date attendue au format YYYY-MM-DD, recu « ${day} »`,
    );
  }
  const seconds = Date.parse(`${day}T00:00:00Z`) / 1000;
  // Date.parse reporte 2024-02-30 au 1er mars au lieu de refuser. Le tour de
  // piste par utcDay est le seul controle qui rattrape une date inexistante.
  if (!Number.isSafeInteger(seconds) || utcDay(seconds, 'RANGE_MALFORMED', label) !== day) {
    throw new FixtureRefused('RANGE_MALFORMED', `${label} : date inexistante (${day})`);
  }
  return seconds;
}

function asFields(source: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new FixtureRefused(
      'CANDLE_MALFORMED',
      `${source} : bougie attendue sous forme d'objet, recu ${typeof raw}`,
    );
  }
  return raw as Record<string, unknown>;
}

/**
 * Le prix reste la chaine de la source ; Decimal ne sert ici que de validateur.
 * Un prix publie en nombre JSON est refuse : il est deja passe par un flottant
 * binaire avant qu'on le voie, donc on ne peut plus verifier ce qu'il valait.
 * C'est la regle « aucun number flottant sur un prix » appliquee a la frontiere.
 */
function price(source: string, date: string, field: PriceField, value: unknown): string {
  const where = `${source} ${date} ${field}`;
  if (typeof value !== 'string') {
    throw new FixtureRefused(
      'CANDLE_MALFORMED',
      `${where} : prix attendu en chaine, recu ${typeof value}`,
    );
  }
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new FixtureRefused('CANDLE_MALFORMED', `${where} : prix illisible (« ${value} »)`);
  }
  if (!parsed.isFinite() || !parsed.gt(0)) {
    throw new FixtureRefused('PRICE_NOT_POSITIVE', `${where} : prix non positif (${value})`);
  }
  return value;
}

/**
 * Le jour UTC d'une bougie brute, sans regarder ses prix. Separe de
 * normaliseCandle parce que l'alignement est une propriete de la **source** :
 * il se controle meme sur les bougies que la pagination fait deborder hors du
 * calendrier demande, alors que leurs prix, eux, ne nous concernent pas.
 */
function utcDayOf(source: string, raw: unknown): UtcDay {
  const start = asFields(source, raw)['start'];
  // Les sources publient l'horodatage en secondes, tantot en chaine tantot en
  // nombre : les deux sont acceptes, un entier de secondes tient sans perte
  // dans un double a cet ordre de grandeur. Number('') vaut 0, d'ou le motif.
  const seconds =
    typeof start === 'number'
      ? start
      : typeof start === 'string' && SECONDS_PATTERN.test(start)
        ? Number(start)
        : Number.NaN;
  if (!Number.isSafeInteger(seconds)) {
    throw new FixtureRefused(
      'CANDLE_MALFORMED',
      `${source} : horodatage absent ou illisible (${String(start)})`,
    );
  }
  // Avant l'alignement, et pas apres : un horodatage en millisecondes est
  // multiple de 86 400 s des que celui en secondes l'est, donc il franchirait
  // l'alignement et ne serait refuse par rien. C'est aussi ce controle qui
  // garantit que utcInstant et utcDay travaillent dans les bornes de Date.
  if (!isPlausibleSeconds(seconds)) {
    throw new FixtureRefused(
      'TIMESTAMP_OUT_OF_RANGE',
      `${source} : horodatage ${seconds} hors de la plage plausible en secondes ` +
        `(${EARLIEST_START_SECONDS} a ${LATEST_START_SECONDS}, soit 2009-01-01 a ` +
        `2100-01-01)${unitHint(seconds)}`,
    );
  }
  if (seconds % SECONDS_PER_DAY !== 0) {
    throw new FixtureRefused(
      'TIMESTAMP_NOT_UTC_MIDNIGHT',
      `${source} : bougie ouvrant a ${utcInstant(seconds)}, la source ne cloture pas a 00:00 UTC`,
    );
  }
  return utcDay(seconds, 'TIMESTAMP_OUT_OF_RANGE', source);
}

/** Deux bougies du meme jour sont-elles d'accord ? Comparaison sur la valeur,
 * pas sur l'ecriture : « 100 » et « 100.0 » sont le meme prix. */
function agree(a: NormalisedCandle, b: NormalisedCandle): boolean {
  return PRICE_FIELDS.every((field) => new Decimal(a[field]).eq(b[field]));
}

/**
 * Le calendrier attendu : un jour UTC par entree, bornes incluses, sans trou.
 * C'est la reference contre laquelle normaliseSeries detecte un jour manquant.
 */
export function expectedCalendar(firstDay: string, lastDay: string): UtcDay[] {
  const first = dayStart(firstDay, 'borne de debut');
  const last = dayStart(lastDay, 'borne de fin');
  if (last < first) {
    throw new FixtureRefused(
      'RANGE_MALFORMED',
      `borne de fin (${lastDay}) anterieure a la borne de debut (${firstDay})`,
    );
  }
  const days: UtcDay[] = [];
  for (let t = first; t <= last; t += SECONDS_PER_DAY) {
    days.push(utcDay(t, 'RANGE_MALFORMED', 'calendrier attendu'));
  }
  return days;
}

/** Normalise une bougie brute isolee. Leve un FixtureRefused a la premiere cause. */
export function normaliseCandle(source: string, raw: unknown): NormalisedCandle {
  const date = utcDayOf(source, raw);
  const fields = asFields(source, raw);
  return {
    date,
    open: price(source, date, 'open', fields['open']),
    high: price(source, date, 'high', fields['high']),
    low: price(source, date, 'low', fields['low']),
    close: price(source, date, 'close', fields['close']),
  };
}

/**
 * Normalise une serie complete contre un calendrier attendu : ordonne, deduit
 * les doublons, et refuse la serie entiere des qu'un jour manque. Le refus est
 * total et sans reparation — ni remplissage, ni report de la veille, ni
 * interpolation : une bougie inventee est indiscernable d'une vraie dans le
 * rejeu, et fausserait tous les resultats en silence.
 */
export function normaliseSeries(
  source: string,
  raws: readonly unknown[],
  calendar: readonly UtcDay[],
): NormalisedCandle[] {
  const wanted = new Set<string>(calendar);
  const byDate = new Map<string, NormalisedCandle>();

  for (const raw of raws) {
    const date = utcDayOf(source, raw);
    if (!wanted.has(date)) continue; // la pagination deborde, c'est normal
    const candle = normaliseCandle(source, raw);
    const seen = byDate.get(date);
    if (seen !== undefined && !agree(seen, candle)) {
      throw new FixtureRefused(
        'DUPLICATE_MISMATCH',
        `${source} : deux bougies contradictoires pour ${date}`,
      );
    }
    byDate.set(date, candle);
  }

  const missing: UtcDay[] = [];
  const ordered: NormalisedCandle[] = [];
  for (const date of calendar) {
    const candle = byDate.get(date);
    if (candle === undefined) missing.push(date);
    else ordered.push(candle);
  }
  if (missing.length > 0) {
    throw new FixtureRefused(
      'DAY_MISSING',
      `${source} : ${missing.length} jour(s) absent(s) de la source ` +
        `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}). ` +
        'Aucun remplissage, aucun report de la veille, aucune interpolation.',
    );
  }
  return ordered;
}
