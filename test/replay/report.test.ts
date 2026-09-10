/**
 * Rapport : production + determinisme + oracles C29 (C29–C31).
 * C31 : aucune assertion ne compare une strategie a une autre.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Return, Sharpe } from '../../src/core/benchmark.js';
import type { UsdcAmount } from '../../src/core/types.js';
import type { ReplayResult, SeriesMetrics } from '../../src/replay/engine.js';
import { SERIES_NAMES, replay } from '../../src/replay/engine.js';
import { formatReport, loadReplayInput, renderReplay } from '../../src/replay/report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const asUsdc = (v: string): UsdcAmount => new Decimal(v) as UsdcAmount;
const asReturn = (v: string): Return => new Decimal(v) as Return;
const asSharpe = (v: string): Sharpe => new Decimal(v) as Sharpe;

const fake = (name: (typeof SERIES_NAMES)[number], n: number): SeriesMetrics => ({
  name,
  finalValue: asUsdc('10000.00'),
  twr: asReturn('0.100000'),
  sharpe90: asSharpe('1.250000'),
  maxDrawdown: asReturn('-0.200000'),
  triggerCount: n,
});

/** Rapport ASCII fige pour la fixture (toFixed 2/6) — oracle de contenu, pas de classement (C31). */
const EXPECTED_REPORT = [
  'Ubac phase 0 — rejeu historique',
  'serie           valeur_finale     twr           sharpe_90j    max_drawdown    declenchements',
  '--------------  ----------------  ------------  ------------  --------------  --------------',
  'rebalance               23368.54      0.446203      2.181820       -0.457047              12',
  'rebalance_ab            23430.45      0.449910      2.181752       -0.451144              14',
  'ladder                  20985.00      0.068455      2.181232       -0.048270              27',
  'dca                     20064.33      0.060182      2.141429       -0.503161              32',
  'hold_btc                25099.90      0.776602      1.916047       -0.530758               0',
  'hold_50_50              22152.77      0.412641      2.085464       -0.586363               0',
  '',
].join('\n');

function replayInSubprocess(): string {
  return execFileSync(process.execPath, ['--import', 'tsx', resolve(ROOT, 'src/replay/report.ts')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
}

describe('formatReport', () => {
  it('affiche les six series dans l ordre fige', () => {
    const result: ReplayResult = { series: SERIES_NAMES.map((name, i) => fake(name, i)) };
    const text = formatReport(result);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('Ubac phase 0 — rejeu historique');
    expect(lines[1]).toContain('valeur_finale');
    expect(lines[1]).toContain('declenchements');
    for (const [i, name] of SERIES_NAMES.entries()) {
      expect(lines[3 + i]).toContain(name);
    }
  });

  it('est stable sur un resultat identique', () => {
    const result: ReplayResult = { series: SERIES_NAMES.map((name) => fake(name, 0)) };
    expect(formatReport(result)).toBe(formatReport(result));
  });
});

/**
 * Chaque test de ce bloc rejoue la fixture complete (974 jours x 6 series), au
 * moins deux fois : figer C29 exige deux rendus independants, et l'egalite
 * formatReport(replay(load)) == renderReplay() compare deux calculs distincts.
 * Un rejeu coute ~1,4 s, et ~3,8 s sous instrumentation de couverture (v8) :
 * ces tests tiennent en ~2,9 s avec `npm test` mais atteignent ~7,7 s avec
 * `npm run test:coverage`, au-dela du testTimeout global de 5 s. Le delai est
 * pose ici, sur le seul bloc concerne, plutot qu'en global : un test reellement
 * bloque ailleurs dans la suite doit continuer d'echouer en 5 s.
 * Lenteur assumee, pas negligee — ne pas la generaliser au reste de la suite.
 */
describe('renderReplay', { timeout: 30_000 }, () => {
  it('fige les six series C29 et reste identique octet pour octet', async () => {
    const first = await renderReplay();
    const second = await renderReplay();
    expect(first).toBe(EXPECTED_REPORT);
    expect(second).toBe(EXPECTED_REPORT);
  });

  it('deux processus distincts produisent la meme sortie (C30)', () => {
    const a = replayInSubprocess();
    const b = replayInSubprocess();
    expect(a).toBe(EXPECTED_REPORT);
    expect(b).toBe(EXPECTED_REPORT);
  });

  it('separe le capital initial des apports', async () => {
    const input = await loadReplayInput();
    expect(input.initialCapital.toString()).toBe('5000');
    expect(input.cashFlows.some((f) => f.note === 'capital initial')).toBe(false);
    expect(input.days[0]?.date).toBe('2024-01-01');
    expect(input.days.at(-1)?.date).toBe('2026-08-31');
  });

  it('formatReport(replay(load)) == renderReplay()', async () => {
    expect(formatReport(replay(await loadReplayInput()))).toBe(await renderReplay());
  });
});
