/**
 * Constitue la fixture de bougies daily du rejeu : test/fixtures/candles-*.csv.
 *
 * Cet outil vit hors de `core` et hors du chemin d'execution du rejeu. Il tourne
 * a la main, son resultat est versionne, et le rejeu ne fait jamais d'appel
 * reseau. Les choix de source, de fuseau de cloture et de traitement des trous
 * sont figes dans docs/fixture-source.md : ce fichier les applique, il ne les
 * decide pas.
 *
 * Usage :
 *   npx tsx scripts/build-fixture.ts --dry-run   plan seul, aucun reseau, aucune ecriture
 *   npx tsx scripts/build-fixture.ts             telecharge, verifie, ecrit
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';

const SOURCE =
  'Coinbase Advanced Trade, GET /api/v3/brokerage/market/products/{id}/candles (public)';
const ENDPOINT = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const GRANULARITY = 'ONE_DAY';
const PRODUCTS = ['BTC-USDC', 'ETH-USDC'] as const;
const FIRST_DAY = '2024-01-01';
const LAST_DAY = '2026-08-31';
const DAY_MS = 86_400_000;
const CANDLES_PER_REQUEST = 300; // la borne de l'API est a 350
const CSV_HEADER = 'date,open,high,low,close';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'test/fixtures');

interface Row {
  readonly date: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Le calendrier attendu : un jour UTC par ligne, bornes incluses, sans trou. */
function expectedDates(): string[] {
  const dates: string[] = [];
  for (let t = dayStart(FIRST_DAY); t <= dayStart(LAST_DAY); t += DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

function outFile(product: string): string {
  return resolve(OUT_DIR, `candles-${product.toLowerCase()}.csv`);
}

/**
 * La chaine de la source est conservee telle quelle : la passer par un `number`
 * pour la revalider ensuite lui ferait perdre des chiffres avant tout controle.
 * `Decimal` sert ici de validateur, pas de convertisseur.
 */
function price(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} : prix absent ou non textuel`);
  const parsed = new Decimal(value); // leve si la chaine n'est pas un nombre
  if (!parsed.isFinite() || !parsed.gt(0)) throw new Error(`${where} : prix non positif (${value})`);
  return value;
}

/**
 * Le controle central de l'etape : une bougie dont le bucket n'ouvre pas
 * exactement a 00:00:00 UTC vient d'une source qui cloture ailleurs. Toute la
 * serie serait decalee sans qu'aucun test du rejeu ne bronche.
 */
function toRow(product: string, candle: unknown): Row {
  const fields = candle as Record<string, unknown>;
  const start = fields['start'];
  if (typeof start !== 'string') throw new Error(`${product} : bougie sans horodatage`);
  const opened = Number(start) * 1000;
  if (!Number.isSafeInteger(opened)) throw new Error(`${product} : horodatage illisible (${start})`);
  if (opened % DAY_MS !== 0) {
    const at = new Date(opened).toISOString();
    throw new Error(`${product} : bougie ouvrant a ${at}, la source ne cloture pas a 00:00 UTC`);
  }
  const date = new Date(opened).toISOString().slice(0, 10);
  return {
    date,
    open: price(fields['open'], `${product} ${date} open`),
    high: price(fields['high'], `${product} ${date} high`),
    low: price(fields['low'], `${product} ${date} low`),
    close: price(fields['close'], `${product} ${date} close`),
  };
}

async function fetchWindow(product: string, fromSec: number, toSec: number): Promise<unknown[]> {
  const url = `${ENDPOINT}/${product}/candles?granularity=${GRANULARITY}&start=${fromSec}&end=${toSec}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${product} : HTTP ${response.status} sur ${url}`);
  const body = (await response.json()) as { candles?: unknown };
  if (!Array.isArray(body.candles)) throw new Error(`${product} : reponse sans tableau candles`);
  return body.candles;
}

async function download(product: string, calendar: readonly string[]): Promise<Row[]> {
  const wanted = new Set(calendar);
  const last = dayStart(LAST_DAY);
  const rows: Row[] = [];
  for (let from = dayStart(FIRST_DAY); from <= last; from += CANDLES_PER_REQUEST * DAY_MS) {
    const to = Math.min(from + (CANDLES_PER_REQUEST - 1) * DAY_MS, last);
    // Fin de fenetre a la cloture du dernier bucket : l'API borne sur `start`,
    // et une borne exclusive couperait silencieusement le dernier jour.
    for (const candle of await fetchWindow(product, from / 1000, to / 1000 + 86_399)) {
      const row = toRow(product, candle);
      if (wanted.has(row.date)) rows.push(row); // la pagination deborde, c'est normal
    }
  }
  return rows;
}

/** Dedoublonne, ordonne, et refuse la fixture si un seul jour manque. */
function assemble(product: string, rows: readonly Row[], calendar: readonly string[]): Row[] {
  const byDate = new Map<string, Row>();
  for (const row of rows) {
    const seen = byDate.get(row.date);
    if (seen !== undefined && seen.close !== row.close) {
      throw new Error(`${product} : deux bougies contradictoires pour ${row.date}`);
    }
    byDate.set(row.date, row);
  }
  const missing = calendar.filter((date) => !byDate.has(date));
  if (missing.length > 0) {
    throw new Error(
      `${product} : ${missing.length} jour(s) absent(s) de la source (${missing.slice(0, 5).join(', ')}...). ` +
        'Aucun fichier ecrit : ni remplissage, ni report de la veille, ni interpolation. ' +
        'Voir docs/fixture-source.md.',
    );
  }
  return calendar.map((date) => byDate.get(date) as Row);
}

function toCsv(rows: readonly Row[]): string {
  const lines = rows.map((r) => `${r.date},${r.open},${r.high},${r.low},${r.close}`);
  return `${[CSV_HEADER, ...lines].join('\n')}\n`;
}

function printPlan(calendar: readonly string[]): void {
  console.log('fixture de bougies daily — plan');
  console.log(`  source         : ${SOURCE}`);
  console.log(`  granularite    : ${GRANULARITY}, bucket ouvrant a 00:00:00 UTC`);
  console.log(`  plage          : ${FIRST_DAY} -> ${LAST_DAY}, bornes incluses`);
  console.log(`  jours attendus : ${calendar.length}`);
  console.log(`  produits       : ${PRODUCTS.join(', ')}`);
  const requests = Math.ceil(calendar.length / CANDLES_PER_REQUEST);
  console.log(`  requetes       : ${requests} par produit, ${CANDLES_PER_REQUEST} bougies au plus`);
  console.log('  trous          : abandon sans ecriture, aucun remplissage');
  for (const product of PRODUCTS) {
    console.log(`  sortie         : ${relative(ROOT, outFile(product))}`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const calendar = expectedDates();
  printPlan(calendar);
  if (argv.includes('--dry-run')) {
    console.log('--dry-run : aucun appel reseau, aucun fichier ecrit.');
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });
  for (const product of PRODUCTS) {
    const rows = assemble(product, await download(product, calendar), calendar);
    await writeFile(outFile(product), toCsv(rows), 'utf8');
    console.log(`ecrit ${relative(ROOT, outFile(product))} : ${rows.length} jours`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`echec : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
