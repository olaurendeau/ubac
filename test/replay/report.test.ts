/**
 * Rapport : production + determinisme (C29–C31).
 * C31 : aucune assertion ne compare une strategie a une autre.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Return, Sharpe } from '../../src/core/benchmark.js';
import type { UsdcAmount } from '../../src/core/types.js';
import type { ReplayResult, SeriesMetrics } from '../../src/replay/engine.js';
import { SERIES_NAMES, replay } from '../../src/replay/engine.js';
import { formatReport, loadReplayInput, renderReplay } from '../../src/replay/report.js';

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

describe('renderReplay', () => {
  it('deux executions identiques octet pour octet', async () => {
    const first = await renderReplay();
    const second = await renderReplay();
    expect(first.length).toBeGreaterThan(100);
    expect(first).toBe(second);
    for (const name of SERIES_NAMES) expect(first).toContain(name);
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
