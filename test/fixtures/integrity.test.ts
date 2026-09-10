/**
 * Integrite de la fixture versionnee. La relecture porte ici et sur les
 * empreintes, pas sur les ~1 950 lignes de bougies : toute regeneration qui
 * change un octet casse ce fichier, et doit etre une PR consciente.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { expectedCalendar, PRICE_FIELDS } from '../../src/fixture/normalise.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = resolve(ROOT, 'test/fixtures');

const FIRST_DAY = '2024-01-01';
const LAST_DAY = '2026-08-31';
const EXPECTED_DAYS = 974;
const EXPECTED_LINES = EXPECTED_DAYS + 1; // en-tete inclus

/**
 * Empreintes figees le 2026-09-10. Les changer exige une raison (source qui
 * reecrit son historique, correction de format) — jamais un effet de bord.
 */
const SHA256 = {
  'candles-btc-usdc.csv':
    'e0fad0a1d037093df5e5cd3db66638775dc0b7bc4ff900c06a46e3500925a5be',
  'candles-eth-usdc.csv':
    '7fc3bfe1dd2c2dbf3de05c3d5624a22f667117209c311f2f171e6db4962c6942',
} as const;

const CSV_HEADER = ['date', ...PRICE_FIELDS].join(',');
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

interface CandleRow {
  readonly date: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

const loadCsv = async (name: keyof typeof SHA256): Promise<{ content: string; rows: CandleRow[] }> => {
  const content = await readFile(resolve(FIXTURES, name), 'utf8');
  const lines = content.split('\n');
  // Fins de ligne LF avec retour final : split produit une derniere entree vide.
  expect(lines.at(-1), `${name} : retour final manquant`).toBe('');
  const body = lines.slice(0, -1);
  expect(body[0], `${name} : en-tete`).toBe(CSV_HEADER);

  const rows = body.slice(1).map((line, index) => {
    const parts = line.split(',');
    expect(parts, `${name} ligne ${String(index + 2)} : ${String(PRICE_FIELDS.length + 1)} colonnes`).toHaveLength(
      PRICE_FIELDS.length + 1,
    );
    const [date, open, high, low, close] = parts;
    expect(date).toBeDefined();
    expect(open).toBeDefined();
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(close).toBeDefined();
    return { date: date!, open: open!, high: high!, low: low!, close: close! };
  });

  return { content, rows };
};

describe('integrite de la fixture de bougies', () => {
  const calendar = expectedCalendar(FIRST_DAY, LAST_DAY);

  it('le calendrier du rejeu compte exactement 974 jours', () => {
    expect(calendar).toHaveLength(EXPECTED_DAYS);
    expect(calendar[0]).toBe(FIRST_DAY);
    expect(calendar[calendar.length - 1]).toBe(LAST_DAY);
  });

  for (const file of Object.keys(SHA256) as (keyof typeof SHA256)[]) {
    describe(file, () => {
      it('porte l empreinte SHA-256 figee et le bon nombre de lignes', async () => {
        const { content, rows } = await loadCsv(file);
        expect(sha256(content), `${file} : empreinte`).toBe(SHA256[file]);
        expect(rows, `${file} : jours`).toHaveLength(EXPECTED_DAYS);
        // 975 lignes = en-tete + 974 jours ; le split compte aussi le '' final.
        expect(content.split('\n')).toHaveLength(EXPECTED_LINES + 1);
      });

      it('couvre le calendrier sans trou, en dates croissantes strictes', async () => {
        const { rows } = await loadCsv(file);
        const dates = rows.map((row) => row.date);
        expect(dates).toEqual([...calendar]);

        for (let i = 0; i < dates.length; i += 1) {
          expect(dates[i], `${file} ligne ${String(i + 2)}`).toMatch(DAY_SHAPE);
          if (i === 0) continue;
          expect(dates[i]! > dates[i - 1]!, `${file} : monotonie a ${dates[i]}`).toBe(true);
        }
      });

      it('refuse tout prix nul, negatif, non fini ou vide', async () => {
        const { rows } = await loadCsv(file);
        for (const row of rows) {
          for (const field of PRICE_FIELDS) {
            const raw = row[field];
            const price = new Decimal(raw);
            expect(
              price.isFinite() && price.gt(0),
              `${file} ${row.date} ${field}=« ${raw} »`,
            ).toBe(true);
          }
        }
      });
    });
  }
});
