/**
 * Moteur de rejeu : six series + metriques (C29).
 * Oracles de valeur sur la fixture versionnee — pas de « A bat B » (C31).
 * Egalite Decimal stricte (toString) : le rejeu est deterministe (C30), aucune tolerance.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ReplayResult, SeriesName } from '../../src/replay/engine.js';
import { SERIES_NAMES, replay } from '../../src/replay/engine.js';
import { loadReplayInput } from '../../src/replay/report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Valeurs figees pour cette fixture ; ce ne sont pas des jugements de performance (C31). */
const ORACLES: Record<
  SeriesName,
  {
    readonly finalValue: string;
    readonly twr: string;
    readonly sharpe90: string;
    readonly maxDrawdown: string;
    readonly triggerCount: number;
  }
> = {
  rebalance: {
    finalValue: '23368.544266268632033',
    twr: '0.4462025103433672621',
    sharpe90: '2.1818200100164471748',
    maxDrawdown: '-0.45704704034794534468',
    triggerCount: 12,
  },
  rebalance_ab: {
    finalValue: '23430.449591168219447',
    twr: '0.4499095282038598232',
    sharpe90: '2.1817515967209726402',
    maxDrawdown: '-0.45114446897190742638',
    triggerCount: 14,
  },
  ladder: {
    finalValue: '20984.999026077450747',
    twr: '0.0684554141920238408',
    sharpe90: '2.1812315206553759958',
    maxDrawdown: '-0.04826955240227378787',
    triggerCount: 27,
  },
  dca: {
    finalValue: '20064.329883353336904',
    twr: '0.0601819778055120741',
    sharpe90: '2.1414286569896722878',
    maxDrawdown: '-0.50316145009464050316',
    triggerCount: 32,
  },
  hold_btc: {
    finalValue: '25099.895107995098323',
    twr: '0.7766023123065671805',
    sharpe90: '1.9160470937601658404',
    maxDrawdown: '-0.53075779531589497758',
    triggerCount: 0,
  },
  hold_50_50: {
    finalValue: '22152.772298242160798',
    twr: '0.4126406552947174809',
    sharpe90: '2.0854636449358367438',
    maxDrawdown: '-0.58636345249863556465',
    triggerCount: 0,
  },
};

function assertOracles(result: ReplayResult): void {
  expect(result.series.map((s) => s.name)).toEqual([...SERIES_NAMES]);
  for (const s of result.series) {
    const o = ORACLES[s.name];
    expect(s.finalValue.toString(), `${s.name}.finalValue`).toBe(o.finalValue);
    expect(s.twr.toString(), `${s.name}.twr`).toBe(o.twr);
    expect(s.sharpe90.toString(), `${s.name}.sharpe90`).toBe(o.sharpe90);
    expect(s.maxDrawdown.toString(), `${s.name}.maxDrawdown`).toBe(o.maxDrawdown);
    expect(s.triggerCount, `${s.name}.triggerCount`).toBe(o.triggerCount);
  }
}

/**
 * Meme traitement que le bloc `renderReplay` de report.test.ts, pour la meme
 * raison : les deux tests de ce bloc chargent la fixture complete (974 jours
 * x 6 series) et le premier la rejoue entierement. Un rejeu coute ~1,5 s, et
 * ~4,6 s sous instrumentation de couverture (v8). Ce test tenait donc dans le
 * testTimeout global de 5 s a 7 % pres sous `npm run test:coverage` : il
 * passait, mais il echouait des que la machine etait chargee — vu une fois en
 * revue, puis vert au second essai. Une porte intermittente vaut a peine mieux
 * qu'une porte cassee.
 * Le delai est pose ici, sur le seul bloc concerne, plutot qu'en global : un
 * test reellement bloque ailleurs dans la suite doit continuer d'echouer en 5 s.
 * Lenteur assumee, pas negligee — ne pas la generaliser au reste de la suite.
 */
describe('moteur de rejeu', { timeout: 30_000 }, () => {
  it('produit les 6 series avec les metriques C29 figees', async () => {
    assertOracles(replay(await loadReplayInput(resolve(ROOT, 'test/fixtures'))));
  });

  it('accepte une entree tronquee (horloge = dates fournies)', async () => {
    const input = await loadReplayInput(resolve(ROOT, 'test/fixtures'));
    const last = input.days[119]!.date;
    const result = replay({
      ...input,
      days: input.days.slice(0, 120),
      cashFlows: input.cashFlows.filter((f) => f.occurredOn <= last),
    });
    expect(result.series.map((s) => s.name)).toEqual([...SERIES_NAMES]);
    for (const s of result.series) {
      expect(s.finalValue.isFinite(), s.name).toBe(true);
      expect(s.twr.isFinite(), s.name).toBe(true);
      expect(s.sharpe90.isFinite(), s.name).toBe(true);
      expect(s.maxDrawdown.isFinite(), s.name).toBe(true);
      expect(Number.isInteger(s.triggerCount)).toBe(true);
      expect(s.triggerCount).toBeGreaterThanOrEqual(0);
    }
  });
});
