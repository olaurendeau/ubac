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
 * Empreintes figees le 2026-09-10 (bougies) et 2026-09-10 (cash-flows). Les
 * changer exige une raison — jamais un effet de bord d'une autre etape.
 */
const SHA256_CANDLES = {
  'candles-btc-usdc.csv':
    'e0fad0a1d037093df5e5cd3db66638775dc0b7bc4ff900c06a46e3500925a5be',
  'candles-eth-usdc.csv':
    '7fc3bfe1dd2c2dbf3de05c3d5624a22f667117209c311f2f171e6db4962c6942',
} as const;

/**
 * Capital 5 000 + 32 apports mensuels de 500 + 1 retrait de 1 000.
 * Montants en chaines decimales (jamais un `number` JSON).
 */
const SHA256_CASH_FLOWS =
  '21ea7bf3d22c0e69a9ca4a6c059912feaf7c85bbd565e3fe615537835c165758';
const EXPECTED_CASH_FLOWS = 34;
const EXPECTED_MONTHLY_APPORTS = 32;

const CSV_HEADER = ['date', ...PRICE_FIELDS].join(',');
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

interface CandleRow {
  readonly date: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

/** Forme JSON alignee sur `CashFlow` : `amount` est une chaine, pas un number. */
interface CashFlowRow {
  readonly occurredOn: string;
  readonly amount: string;
  readonly note: string;
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

const loadCsv = async (
  name: keyof typeof SHA256_CANDLES,
): Promise<{ content: string; rows: CandleRow[] }> => {
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

  for (const file of Object.keys(SHA256_CANDLES) as (keyof typeof SHA256_CANDLES)[]) {
    describe(file, () => {
      it('porte l empreinte SHA-256 figee et le bon nombre de lignes', async () => {
        const { content, rows } = await loadCsv(file);
        expect(sha256(content), `${file} : empreinte`).toBe(SHA256_CANDLES[file]);
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

const loadCashFlows = async (): Promise<{ content: string; flows: CashFlowRow[] }> => {
  const content = await readFile(resolve(FIXTURES, 'cash-flows.json'), 'utf8');
  expect(content.endsWith('\n'), 'cash-flows.json : retour final manquant').toBe(true);

  const parsed: unknown = JSON.parse(content);
  expect(Array.isArray(parsed), 'cash-flows.json : tableau racine').toBe(true);
  const rows = parsed as unknown[];

  const flows = rows.map((row, index) => {
    expect(row !== null && typeof row === 'object', `entree ${String(index)}`).toBe(true);
    const record = row as Record<string, unknown>;
    expect(typeof record['occurredOn'], `entree ${String(index)} : occurredOn`).toBe('string');
    expect(typeof record['amount'], `entree ${String(index)} : amount (chaine, pas number)`).toBe(
      'string',
    );
    expect(typeof record['note'], `entree ${String(index)} : note`).toBe('string');
    expect(Object.keys(record).sort()).toEqual(['amount', 'note', 'occurredOn']);
    return {
      occurredOn: record['occurredOn'] as string,
      amount: record['amount'] as string,
      note: record['note'] as string,
    };
  });

  return { content, flows };
};

describe('integrite de la fixture de cash-flows', () => {
  it('porte l empreinte SHA-256 figee et exactement 34 entrees', async () => {
    const { content, flows } = await loadCashFlows();
    expect(sha256(content)).toBe(SHA256_CASH_FLOWS);
    expect(flows).toHaveLength(EXPECTED_CASH_FLOWS);
  });

  it('ordonne les dates de facon monotone non stricte (meme jour autorise)', async () => {
    const { flows } = await loadCashFlows();
    for (let i = 0; i < flows.length; i += 1) {
      expect(flows[i]!.occurredOn, `entree ${String(i)}`).toMatch(DAY_SHAPE);
      expect(flows[i]!.occurredOn >= FIRST_DAY).toBe(true);
      expect(flows[i]!.occurredOn <= LAST_DAY).toBe(true);
      if (i === 0) continue;
      expect(
        flows[i]!.occurredOn >= flows[i - 1]!.occurredOn,
        `monotonie a ${flows[i]!.occurredOn}`,
      ).toBe(true);
    }
  });

  it('refuse tout montant nul, non fini ou vide ; signe selon le type', async () => {
    const { flows } = await loadCashFlows();
    const byNote = {
      'capital initial': 0,
      'apport mensuel': 0,
      retrait: 0,
    };

    for (const flow of flows) {
      const amount = new Decimal(flow.amount);
      expect(amount.isFinite() && !amount.isZero(), `montant « ${flow.amount} »`).toBe(true);

      if (flow.note === 'capital initial') {
        expect(amount.gt(0), `capital ${flow.occurredOn}`).toBe(true);
        expect(flow.occurredOn).toBe(FIRST_DAY);
        expect(flow.amount).toBe('5000');
        byNote['capital initial'] += 1;
      } else if (flow.note === 'apport mensuel') {
        expect(amount.gt(0), `apport ${flow.occurredOn}`).toBe(true);
        expect(flow.amount).toBe('500');
        expect(flow.occurredOn.endsWith('-01'), `apport hors 1er : ${flow.occurredOn}`).toBe(true);
        byNote['apport mensuel'] += 1;
      } else if (flow.note === 'retrait') {
        expect(amount.lt(0), `retrait ${flow.occurredOn}`).toBe(true);
        expect(flow.amount).toBe('-1000');
        expect(flow.occurredOn).toBe('2025-06-15');
        byNote.retrait += 1;
      } else {
        expect.fail(`note inconnue : « ${flow.note} »`);
      }
    }

    expect(byNote).toEqual({
      'capital initial': 1,
      'apport mensuel': EXPECTED_MONTHLY_APPORTS,
      retrait: 1,
    });
  });

  it('pose les preconditions structurelles de C25 et C26', async () => {
    /*
     * C25 : un apport positif a J gele A jusqu'a J+7 exclu. Chaque apport du
     * 1er ouvre une fenetre 1..7 ; le run du 8 n'est plus gele. C26 : ce gel
     * ne touche pas B — la fixture fournit les gels, elle ne force pas un
     * franchissement de bande B (ca depend des bougies + du harnais).
     */
    const { flows } = await loadCashFlows();
    const apports = flows.filter((f) => f.note === 'apport mensuel');
    expect(apports).toHaveLength(EXPECTED_MONTHLY_APPORTS);
    expect(apports.every((f) => new Decimal(f.amount).gt(0))).toBe(true);
    expect(apports[0]!.occurredOn).toBe('2024-01-01');
    expect(apports[apports.length - 1]!.occurredOn).toBe('2026-08-01');

    const retrait = flows.find((f) => f.note === 'retrait');
    expect(retrait, 'sans retrait la branche montant negatif de C25 est morte').toBeDefined();
    expect(new Decimal(retrait!.amount).lt(0)).toBe(true);
  });
});
