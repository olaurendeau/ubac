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

/**
 * Valeurs figees pour cette fixture ; ce ne sont pas des jugements de performance (C31).
 * `rebalance*` passent par `validate()`, donc par le plafond reduit de la phase 3 :
 * un retour a la cible refuse laisse le jour suivant hors bande, qui recompte un
 * declenchement. Chaque geste sur le plafond (E34) refige ces deux-la.
 * Avant la decision du 2026-11-12, a 11 % (2026-09-27), `rebalance` ne connaissait plus aucun refus : ses valeurs etaient
 * exactement celles de la phase 0 a 25 %, et ses 12 declenchements etaient ses 12
 * executions (a 8 % : 176 declenchements, 166 jours refuses). `rebalance_ab`, qui
 * arme le declencheur B en shadow, butait encore 84 jours sur 97 declenchements.
 *
 * Decision du 2026-11-12 : bande cash a +/-10 % (de [0.24, 0.36] a [0.27, 0.33]) et
 * jambe minimale a 100 USDC. Les deux lignes `rebalance*` sont refigees : `rebalance`
 * passe de 12 a 32 declenchements (valeur finale 23 368.54 -> 23 296.17, TWR 44.62 % ->
 * 44.94 %), `rebalance_ab` de 97 a 36 (23 304.05 -> 23 296.17). Les quatre autres series
 * ne bougent pas. Ce sont des valeurs de non-regression, pas un verdict de rentabilite.
 * `rebalance` et `rebalance_ab` ont desormais les memes valeurs, ce qui n'est pas un
 * copier-coller : les 4 declenchements de plus de `rebalance_ab` sont des RATIO_BAND
 * (2025-08-22, 23, 24 et 26), tous refuses en REBALANCE_TOO_LARGE (environ 16 % du
 * portefeuille), donc sans effet sur la valeur. Le rejeu versionne ne compte aucun frais.
 */
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
    finalValue: '23296.172979587367173',
    twr: '0.4493756821886858144',
    sharpe90: '2.1444679979252002858',
    maxDrawdown: '-0.45195142480476058102',
    triggerCount: 32,
  },
  rebalance_ab: {
    finalValue: '23296.172979587367173',
    twr: '0.4493756821886858144',
    sharpe90: '2.1444679979252002858',
    maxDrawdown: '-0.45195142480476058102',
    triggerCount: 36,
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
