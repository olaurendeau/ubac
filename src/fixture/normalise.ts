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
 * Ce module vit hors de src/core/, donc les regles de purete d'eslint.config.js
 * ne le couvrent pas : l'absence d'IO y est une discipline, pas une contrainte
 * outillee.
 */
import { Decimal } from 'decimal.js';

export const SECONDS_PER_DAY = 86_400;

/** Les quatre prix d'une bougie. L'ordre sert aussi aux messages d'erreur. */
export const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;

export type PriceField = (typeof PRICE_FIELDS)[number];

/**
 * Une bougie normalisee : un jour UTC, quatre prix conserves **tels que la
 * source les a ecrits**. Les prix restent des chaines : les reserialiser depuis
 * un Decimal leur ferait perdre des chiffres au passage, et la fixture doit
 * pouvoir etre comparee a la source ligne pour ligne.
 */
export interface NormalisedCandle {
  readonly date: string;
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

function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function utcInstant(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
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
  if (!Number.isSafeInteger(seconds) || utcDay(seconds) !== day) {
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
function utcDayOf(source: string, raw: unknown): string {
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
  if (seconds % SECONDS_PER_DAY !== 0) {
    throw new FixtureRefused(
      'TIMESTAMP_NOT_UTC_MIDNIGHT',
      `${source} : bougie ouvrant a ${utcInstant(seconds)}, la source ne cloture pas a 00:00 UTC`,
    );
  }
  return utcDay(seconds);
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
export function expectedCalendar(firstDay: string, lastDay: string): string[] {
  const first = dayStart(firstDay, 'borne de debut');
  const last = dayStart(lastDay, 'borne de fin');
  if (last < first) {
    throw new FixtureRefused(
      'RANGE_MALFORMED',
      `borne de fin (${lastDay}) anterieure a la borne de debut (${firstDay})`,
    );
  }
  const days: string[] = [];
  for (let t = first; t <= last; t += SECONDS_PER_DAY) days.push(utcDay(t));
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
  calendar: readonly string[],
): NormalisedCandle[] {
  const wanted = new Set(calendar);
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

  const missing: string[] = [];
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
