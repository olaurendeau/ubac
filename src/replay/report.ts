/**
 * Tableau comparatif du rejeu + CLI `npm run replay`.
 * C30 : ASCII fixe, pas de locale, ordre fige `SERIES_NAMES`.
 * C31 : produit le rapport, ne juge aucune strategie.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';

import type { MarketDay } from '../core/benchmark.js';
import type { CashFlow, IsoDate, Price, UsdcAmount } from '../core/types.js';
import type { ReplayInput, ReplayResult, SeriesMetrics, SeriesName } from './engine.js';
import { SERIES_NAMES, replay } from './engine.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = resolve(ROOT, 'test/fixtures');

const asPrice = (value: string): Price => new Decimal(value) as Price;
const asUsdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;

const VALUE_SCALE = 2;
const RATIO_SCALE = 6;

const pad = (text: string, width: number): string =>
  text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
const padStart = (text: string, width: number): string =>
  text.length >= width ? text : `${' '.repeat(width - text.length)}${text}`;

const fmtValue = (value: Decimal): string => value.toFixed(VALUE_SCALE);
const fmtRatio = (value: Decimal): string => value.toFixed(RATIO_SCALE);

const COLUMNS = [
  { key: 'name', title: 'serie', width: 14 },
  { key: 'finalValue', title: 'valeur_finale', width: 16 },
  { key: 'twr', title: 'twr', width: 12 },
  { key: 'sharpe90', title: 'sharpe_90j', width: 12 },
  { key: 'maxDrawdown', title: 'max_drawdown', width: 14 },
  { key: 'triggerCount', title: 'declenchements', width: 14 },
] as const;

type ColumnKey = (typeof COLUMNS)[number]['key'];

function cell(metrics: SeriesMetrics, key: ColumnKey): string {
  switch (key) {
    case 'name':
      return metrics.name;
    case 'finalValue':
      return fmtValue(metrics.finalValue);
    case 'twr':
      return fmtRatio(metrics.twr);
    case 'sharpe90':
      return fmtRatio(metrics.sharpe90);
    case 'maxDrawdown':
      return fmtRatio(metrics.maxDrawdown);
    case 'triggerCount':
      return String(metrics.triggerCount);
  }
}

/** Tableau texte des six series, ordre `SERIES_NAMES`. */
export function formatReport(result: ReplayResult): string {
  if (result.series.length !== SERIES_NAMES.length) {
    throw new RangeError(`rapport : ${String(result.series.length)} series`);
  }
  const byName = new Map<SeriesName, SeriesMetrics>();
  for (const metrics of result.series) {
    if (byName.has(metrics.name)) throw new RangeError(`serie en double « ${metrics.name} »`);
    byName.set(metrics.name, metrics);
  }
  const ordered: SeriesMetrics[] = [];
  for (const name of SERIES_NAMES) {
    const metrics = byName.get(name);
    if (metrics === undefined) throw new RangeError(`serie manquante « ${name} »`);
    ordered.push(metrics);
  }

  const header = COLUMNS.map((c) => pad(c.title, c.width)).join('  ');
  const rule = COLUMNS.map((c) => '-'.repeat(c.width)).join('  ');
  const rows = ordered.map((metrics) =>
    COLUMNS.map((c) => {
      const raw = cell(metrics, c.key);
      return c.key === 'name' ? pad(raw, c.width) : padStart(raw, c.width);
    }).join('  '),
  );
  return ['Ubac phase 0 — rejeu historique', header, rule, ...rows, ''].join('\n');
}

function parseCsv(content: string): { date: string; close: string }[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== 'date,open,high,low,close') {
    throw new RangeError(`CSV en-tete inattendu`);
  }
  return lines.slice(1).map((line, index) => {
    const parts = line.split(',');
    const date = parts[0];
    const close = parts[4];
    if (date === undefined || close === undefined || parts.length !== 5) {
      throw new RangeError(`CSV ligne ${String(index + 2)}`);
    }
    return { date, close };
  });
}

/** Charge la fixture ; separe le capital initial des autres flux. */
export async function loadReplayInput(fixturesDir: string = FIXTURES): Promise<ReplayInput> {
  const [btcRaw, ethRaw, flowsRaw] = await Promise.all([
    readFile(resolve(fixturesDir, 'candles-btc-usdc.csv'), 'utf8'),
    readFile(resolve(fixturesDir, 'candles-eth-usdc.csv'), 'utf8'),
    readFile(resolve(fixturesDir, 'cash-flows.json'), 'utf8'),
  ]);

  const btc = parseCsv(btcRaw);
  const eth = parseCsv(ethRaw);
  if (btc.length !== eth.length) {
    throw new RangeError(`jours BTC/ETH desalignees`);
  }

  const days: MarketDay[] = [];
  for (let i = 0; i < btc.length; i += 1) {
    const b = btc[i]!;
    const e = eth[i]!;
    if (b.date !== e.date) throw new RangeError(`dates ${b.date} / ${e.date}`);
    days.push({
      date: b.date as IsoDate,
      prices: { BTC: asPrice(b.close), ETH: asPrice(e.close) },
    });
  }

  const rows = JSON.parse(flowsRaw) as {
    occurredOn: string;
    amount: string;
    note?: string;
  }[];
  if (!Array.isArray(rows)) throw new RangeError('cash-flows.json invalide');

  let initialCapital: UsdcAmount | undefined;
  const cashFlows: CashFlow[] = [];
  for (const row of rows) {
    const amount = asUsdc(row.amount);
    if (row.note === 'capital initial') {
      if (initialCapital !== undefined) throw new RangeError('capital initial en double');
      initialCapital = amount;
      continue;
    }
    cashFlows.push({
      occurredOn: row.occurredOn,
      amount,
      ...(row.note === undefined ? {} : { note: row.note }),
    });
  }
  if (initialCapital === undefined) throw new RangeError('capital initial manquant');
  return { days, cashFlows, initialCapital };
}

export async function renderReplay(fixturesDir: string = FIXTURES): Promise<string> {
  return formatReport(replay(await loadReplayInput(fixturesDir)));
}

async function main(): Promise<void> {
  process.stdout.write(await renderReplay());
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
