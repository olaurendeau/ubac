/** Moteur de rejeu : six series + metriques (C29). Pas de « A bat B » (C31). */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ReplayResult, SeriesName } from '../../src/replay/engine.js';
import { SERIES_NAMES, replay } from '../../src/replay/engine.js';
import { loadReplayInput } from '../../src/replay/report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function assertShape(result: ReplayResult): void {
  expect(result.series.map((s) => s.name)).toEqual([...SERIES_NAMES]);
  for (const s of result.series) {
    expect(s.finalValue.isFinite(), s.name).toBe(true);
    expect(s.twr.isFinite(), s.name).toBe(true);
    expect(s.sharpe90.isFinite(), s.name).toBe(true);
    expect(s.maxDrawdown.isFinite(), s.name).toBe(true);
    expect(Number.isInteger(s.triggerCount)).toBe(true);
    expect(s.triggerCount).toBeGreaterThanOrEqual(0);
  }
}

describe('moteur de rejeu', () => {
  it('produit les 6 series avec les metriques C29', async () => {
    const result = replay(await loadReplayInput(resolve(ROOT, 'test/fixtures')));
    assertShape(result);
    const byName = Object.fromEntries(result.series.map((s) => [s.name, s])) as Record<
      SeriesName,
      (typeof result.series)[number]
    >;
    expect(byName.hold_btc.triggerCount).toBe(0);
    expect(byName.hold_50_50.triggerCount).toBe(0);
    expect(byName.dca.triggerCount).toBeGreaterThan(0);
  });

  it('accepte une entree tronquee (horloge = dates fournies)', async () => {
    const input = await loadReplayInput(resolve(ROOT, 'test/fixtures'));
    const last = input.days[119]!.date;
    assertShape(
      replay({
        ...input,
        days: input.days.slice(0, 120),
        cashFlows: input.cashFlows.filter((f) => f.occurredOn <= last),
      }),
    );
  });
});
