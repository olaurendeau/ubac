/**
 * Construit la fixture de bougies daily du rejeu : telecharge BTC-USDC et
 * ETH-USDC chez Coinbase, fait tout valider par src/fixture/normalise.ts, puis
 * ecrit les deux CSV. La note de source est docs/fixture-source.md ; ce fichier
 * en est l'implementation, la note en est le contrat.
 *
 * Ce script est le seul endroit du depot qui ouvre le reseau et qui ecrit sur le
 * disque. Il ne porte volontairement aucune regle de validation : tout controle
 * — alignement sur 00:00 UTC, unite de l'horodatage, prix non positif, doublon
 * contradictoire, jour manquant — vit dans src/fixture/normalise.ts, ou il est
 * atteignable depuis un test. Un controle ecrit ici serait verifiable par
 * personne, ce qui est exactement le defaut que E20 corrigeait.
 *
 * L'ecriture est tout ou rien. Ecrire le CSV de BTC avant de telecharger ETH
 * laisserait, sur un echec d'ETH, une fixture a moitie regeneree sur le disque
 * pendant que le script annonce n'avoir rien ecrit. On telecharge donc les deux
 * actifs, on valide tout, on rend les deux CSV en memoire, et on ne touche au
 * disque qu'ensuite, par fichiers temporaires renommes.
 *
 *   npx tsx scripts/build-fixture.ts --dry-run   telecharge, valide, n'ecrit rien
 *   npx tsx scripts/build-fixture.ts             ecrit test/fixtures/*.csv
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  expectedCalendar,
  FixtureRefused,
  normaliseSeries,
  PRICE_FIELDS,
  SECONDS_PER_DAY,
  type NormalisedCandle,
  type UtcDay,
} from '../src/fixture/normalise.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- Ce que la fixture fige -------------------------------------------------

/** Bornes du rejeu, incluses. Elles viennent de la spec, pas de la source. */
const FIRST_DAY = '2024-01-01';
const LAST_DAY = '2026-08-31';

/**
 * Coinbase Advanced Trade, donnees de marche publiques : pas de cle, pas de
 * signature. C'est la meme maison que celle qui executera les ordres en phase 3,
 * donc le rejeu et la production liront le meme carnet.
 */
const API_BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const GRANULARITY = 'ONE_DAY';

/**
 * L'API refuse au-dela de 350 bougies par requete. On pagine par 300 : la marge
 * absorbe un eventuel durcissement de la limite sans changer la fixture.
 */
const PAGE_DAYS = 300;

/** Trois tentatives par page. Un GET est idempotent, le rejouer ne cree rien. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

interface Product {
  readonly productId: string;
  readonly output: string;
}

const PRODUCTS: readonly Product[] = [
  { productId: 'BTC-USDC', output: 'test/fixtures/candles-btc-usdc.csv' },
  { productId: 'ETH-USDC', output: 'test/fixtures/candles-eth-usdc.csv' },
];

/**
 * Colonnes du CSV. `date` d'abord, puis les quatre prix dans l'ordre de
 * PRICE_FIELDS : la fixture se relit ligne a ligne face a la source.
 */
const CSV_HEADER = ['date', ...PRICE_FIELDS].join(',');

// --- Telechargement ---------------------------------------------------------

class DownloadFailed extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Une page de bougies brutes, rendue telle quelle. Aucun champ n'est lu ici en
 * dehors de l'enveloppe `candles` : les bougies partent intactes vers
 * normalise.ts, qui est seul juge de leur contenu.
 */
async function fetchPage(productId: string, from: number, to: number): Promise<unknown[]> {
  const url =
    `${API_BASE}/${productId}/candles` +
    `?start=${from}&end=${to}&granularity=${GRANULARITY}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new DownloadFailed(
      `${productId} : ${response.status} ${response.statusText} sur ${url}\n${await response.text()}`,
    );
  }
  const payload: unknown = await response.json();
  const candles =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['candles']
      : undefined;
  if (!Array.isArray(candles)) {
    throw new DownloadFailed(`${productId} : reponse sans tableau « candles » sur ${url}`);
  }
  return candles;
}

async function fetchPageWithRetries(
  productId: string,
  from: number,
  to: number,
): Promise<unknown[]> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await fetchPage(productId, from, to);
    } catch (error) {
      last = error;
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw new DownloadFailed(
    `${productId} : ${ATTEMPTS} tentatives echouees. ${last instanceof Error ? last.message : String(last)}`,
  );
}

interface Downloaded {
  readonly raws: readonly unknown[];
  readonly pages: number;
}

/**
 * Toutes les bougies couvrant le calendrier, en une ou plusieurs pages. Les
 * bornes de l'API sont incluses des deux cotes ; les doublons de bord et le
 * debordement de pagination sont laisses tels quels, normaliseSeries sait les
 * dedupliquer et ecarter ce qui sort du calendrier.
 */
async function download(productId: string, calendar: readonly UtcDay[]): Promise<Downloaded> {
  const first = dayStartSeconds(calendar[0]);
  const last = dayStartSeconds(calendar[calendar.length - 1]);
  const raws: unknown[] = [];
  let pages = 0;
  for (let from = first; from <= last; from += PAGE_DAYS * SECONDS_PER_DAY) {
    const to = Math.min(from + (PAGE_DAYS - 1) * SECONDS_PER_DAY, last);
    raws.push(...(await fetchPageWithRetries(productId, from, to)));
    pages += 1;
  }
  return { raws, pages };
}

/**
 * Le calendrier est deja valide par expectedCalendar : ses entrees sont des
 * jours UTC existants. Le seul cas d'echec ici serait un calendrier vide, que
 * expectedCalendar ne produit jamais — d'ou le refus net plutot qu'un NaN qui
 * partirait dans une URL.
 */
function dayStartSeconds(day: UtcDay | undefined): number {
  const seconds = day === undefined ? Number.NaN : Date.parse(`${day}T00:00:00Z`) / 1000;
  if (!Number.isSafeInteger(seconds)) {
    throw new DownloadFailed(`calendrier vide ou illisible (${String(day)})`);
  }
  return seconds;
}

// --- Rendu ------------------------------------------------------------------

/**
 * Un CSV a fins de ligne LF et retour final, prix repris **verbatim** de la
 * source. Les reserialiser depuis un Decimal leur ferait perdre des chiffres et
 * la fixture ne serait plus comparable a la source. Aucun echappement n'est
 * necessaire : normalise.ts n'a laisse passer que des nombres relus par
 * decimal.js, qui ne peuvent contenir ni virgule, ni guillemet, ni saut de ligne.
 */
function toCsv(candles: readonly NormalisedCandle[]): string {
  const lines = [CSV_HEADER];
  for (const candle of candles) {
    lines.push([candle.date, ...PRICE_FIELDS.map((field) => candle[field])].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// --- Ecriture, tout ou rien -------------------------------------------------

interface Rendered {
  readonly productId: string;
  readonly output: string;
  readonly csv: string;
  readonly days: number;
  readonly pages: number;
}

/**
 * Ecrit d'abord tous les temporaires, ne renomme qu'ensuite. Un echec pendant la
 * phase d'ecriture ne laisse que des `.tmp`, qui sont nettoyes : la fixture reste
 * celle d'avant. Les deux renommages ne forment pas une transaction — POSIX ne
 * l'offre pas sur deux fichiers — mais chacun est atomique et la fenetre entre
 * les deux ne contient plus ni reseau ni validation, seulement deux appels
 * systeme. C'est le plus loin qu'on aille sans repertoire de fixture versionne.
 */
async function writeAll(rendered: readonly Rendered[]): Promise<void> {
  const staged = rendered.map((item) => {
    const target = resolve(ROOT, item.output);
    return { target, temporary: `${target}.tmp`, csv: item.csv };
  });
  try {
    for (const { target, temporary, csv } of staged) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporary, csv, 'utf8');
    }
    for (const { target, temporary } of staged) {
      await rename(temporary, target);
    }
  } catch (error) {
    for (const { temporary } of staged) {
      await rm(temporary, { force: true });
    }
    throw error;
  }
}

// --- Point d'entree ---------------------------------------------------------

function parseDryRun(args: readonly string[]): boolean {
  const unknown = args.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    throw new Error(
      `argument inconnu : ${unknown.join(', ')}\n` +
        'usage : tsx scripts/build-fixture.ts [--dry-run]',
    );
  }
  return args.includes('--dry-run');
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const calendar = expectedCalendar(FIRST_DAY, LAST_DAY);

  console.log('ubac : construction de la fixture de bougies');
  console.log(`  source         : Coinbase Advanced Trade, ${API_BASE}/{product}/candles`);
  console.log(`  granularite    : ${GRANULARITY}, buckets ouvrant a 00:00:00 UTC`);
  console.log(`  plage          : ${FIRST_DAY} a ${LAST_DAY}, bornes incluses`);
  console.log(`  jours attendus : ${calendar.length}`);
  console.log('  trous          : aucun remplissage, la serie entiere est refusee');

  const rendered: Rendered[] = [];
  for (const { productId, output } of PRODUCTS) {
    const { raws, pages } = await download(productId, calendar);
    // normaliseSeries leve des qu'un jour manque, qu'un prix est non positif ou
    // que la source ne cloture pas a 00:00 UTC. Rien n'est ecrit avant que les
    // deux actifs soient passes ici.
    const candles = normaliseSeries(productId, raws, calendar);
    const csv = toCsv(candles);
    rendered.push({ productId, output, csv, days: candles.length, pages });
    console.log(
      `  ${productId} : ${pages} requete(s), ${raws.length} bougies recues, ` +
        `${candles.length}/${calendar.length} jours retenus`,
    );
  }

  for (const item of rendered) {
    console.log(`  ${item.output} : ${item.days + 1} lignes, sha256 ${sha256(item.csv)}`);
  }

  if (dryRun) {
    console.log('  --dry-run : tout est telecharge et valide, aucun fichier ecrit.');
    return;
  }
  await writeAll(rendered);
  console.log(`  ${rendered.length} fichier(s) ecrit(s).`);
}

/**
 * Un refus de normalise.ts sort avec son code : c'est ce qui distingue « la
 * source ne cloture pas a 00:00 UTC » de « le reseau a laché », et ce que
 * l'operateur lit en premier.
 */
function describe(error: unknown): string {
  if (error instanceof FixtureRefused) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

try {
  await main();
} catch (error) {
  console.error('echec, aucun fichier ecrit :');
  console.error(describe(error));
  process.exitCode = 1;
}
