import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { SnapshotRecord } from '../../src/adapters/db.js';
import type { DailyCandle } from '../../src/adapters/market.js';
import { expectedCalendar } from '../../src/fixture/normalise.js';
import type { Holdings, PricedAsset } from '../../src/core/portfolio.js';
import type { Price, Quantity, UsdcAmount, Weight, Weights } from '../../src/core/types.js';
import type { SnapshotStepInput } from '../../src/jobs/snapshot.js';
import {
  DRAWDOWN_SUSPENSION_THRESHOLD,
  HOLD_5050_KEYS,
  HOLD_BTC_KEYS,
  PORTFOLIO_KEYS,
  prepareSnapshot,
  SUSPENSION_MARKER,
} from '../../src/jobs/snapshot.js';

/**
 * L'etape 7 et la suspension du §6, contre des entrees fabriquees. **Aucun
 * reseau, aucune base** : les deux imports d'adapters sont des `import type`.
 *
 * Ce que ce fichier etablit, garde-fou par garde-fou :
 *
 * - le premier run rend l'indisponibilite du drawdown, et **n'ecrit pas** la
 *   cle `portfolio_drawdown` — un zero s'y lirait « tout va bien » ;
 * - le drawdown est neutre aux apports et aux retraits, des deux cotes ;
 * - le plus-haut ne se reinitialise pas sur l'indice du jour ;
 * - le seuil de -25 % est sonde de part et d'autre, borne comprise ;
 * - une photo deja prise n'est pas rechainee, et le drawdown qu'elle porte est
 *   relu pour que deux runs du meme jour suspendent pareil.
 */

// --- Fenetre de marche ------------------------------------------------------

const JOURS = expectedCalendar('2026-02-24', '2026-09-11');

function serie(close: (index: number) => string): readonly DailyCandle[] {
  return JOURS.map((date, index) => {
    const prix = new Decimal(close(index)) as Price;
    return { date, open: prix, high: prix, low: prix, close: prix };
  });
}

/** Prix constants : les deux hold ne rendent rien, et leur Sharpe n'existe pas. */
const PLAT: Readonly<Record<PricedAsset, readonly DailyCandle[]>> = {
  BTC: serie(() => '50000'),
  ETH: serie(() => '2500'),
};

/** Une tendance et un creux periodique : de la volatilite, donc un Sharpe. */
const oscille = (base: string, tendance: string): readonly DailyCandle[] =>
  serie((index) =>
    new Decimal(base)
      .mul(new Decimal(tendance).pow(index))
      .mul(index % 5 === 0 ? '0.97' : '1')
      .toFixed(2),
  );

const MOUVANT: Readonly<Record<PricedAsset, readonly DailyCandle[]>> = {
  BTC: oscille('50000', '1.002'),
  ETH: oscille('2500', '1.001'),
};

// --- Entrees ----------------------------------------------------------------

const w = (value: string): Weight => new Decimal(value) as Weight;
const q = (value: string): Quantity => new Decimal(value) as Quantity;
const usdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;

const POIDS: Weights = { BTC: w('0.4'), ETH: w('0.3'), USDC: w('0.3') };
const AVOIRS: Holdings = { BTC: q('0.8'), ETH: q('12'), USDC: q('30000') };
const RUN_DATE = '2026-09-12';
const INSTANT = new Date(`${RUN_DATE}T07:00:00.000Z`);

function entree(over: Partial<SnapshotStepInput> = {}): SnapshotStepInput {
  return {
    runDate: RUN_DATE,
    runInstant: INSTANT,
    holdings: AVOIRS,
    weights: POIDS,
    totalValue: usdc('100000'),
    history: PLAT,
    previous: undefined,
    flows: [],
    ...over,
  };
}

const DEPART = { [PORTFOLIO_KEYS.index]: '1', [PORTFOLIO_KEYS.peak]: '1' };

function photoPassee(
  runDate: string,
  totalValue: string,
  porte: Readonly<Record<string, string>> = DEPART,
): SnapshotRecord {
  const benchmarks: Record<string, Decimal> = {};
  for (const [cle, valeur] of Object.entries(porte)) benchmarks[cle] = new Decimal(valeur);
  return {
    runDate,
    totalValueUsdc: usdc(totalValue),
    weights: POIDS,
    positions: AVOIRS,
    benchmarks,
    createdAt: new Date(`${runDate}T07:00:00.000Z`),
  };
}

/** La veille a 100 000 USDC, indice et sommet a 1. Le cas nominal du chainage. */
const VEILLE = photoPassee('2026-09-11', '100000');

const flux = (at: string, amount: string) => ({
  occurredAt: new Date(at),
  amount: usdc(amount),
});

const valeur = (step: ReturnType<typeof prepareSnapshot>, cle: string): string | undefined =>
  step.benchmarks[cle]?.toString();

// --- Le premier run ---------------------------------------------------------

describe('le premier run n’a pas de drawdown, et ne le remplace pas par zero', () => {
  it('rend l’indisponibilite, ouvre la chaine a 1, et n’ecrit pas la cle', () => {
    const step = prepareSnapshot(entree());

    expect(step.drawdown).toMatchObject({ status: 'UNAVAILABLE', code: 'NO_PREVIOUS_SNAPSHOT' });
    // L'absence de la cle EST l'enregistrement de l'indisponibilite.
    expect(Object.keys(step.benchmarks)).not.toContain(PORTFOLIO_KEYS.drawdown);
    expect(step.gaps.map((g) => g.key)).toContain(PORTFOLIO_KEYS.drawdown);
    expect(valeur(step, PORTFOLIO_KEYS.index)).toBe('1');
    expect(valeur(step, PORTFOLIO_KEYS.peak)).toBe('1');
    // Inconnu n'est pas 25 % : rien n'est suspendu.
    expect(step.suspension.status).toBe('INACTIVE');
    expect(step.write.status).toBe('TO_RECORD');
  });

  it('photographie les avoirs, les poids et l’instant injecte', () => {
    const step = prepareSnapshot(entree());

    expect(step.write.status === 'TO_RECORD' && step.write.record).toMatchObject({
      runDate: RUN_DATE,
      positions: AVOIRS,
      weights: POIDS,
      createdAt: INSTANT,
    });
    if (step.write.status === 'TO_RECORD') {
      expect(step.write.record.totalValueUsdc.toString()).toBe('100000');
    }
  });
});

// --- Le chainage ------------------------------------------------------------

describe('le drawdown se chaine sur la photo anterieure', () => {
  it('une baisse de 30 % donne -0.3, et le sommet ne bouge pas', () => {
    const step = prepareSnapshot(entree({ previous: VEILLE, totalValue: usdc('70000') }));

    expect(step.drawdown.status).toBe('COMPUTED');
    expect(valeur(step, PORTFOLIO_KEYS.drawdown)).toBe('-0.3');
    expect(valeur(step, PORTFOLIO_KEYS.index)).toBe('0.7');
    expect(valeur(step, PORTFOLIO_KEYS.peak)).toBe('1');
  });

  it('une hausse porte le sommet, et le drawdown retombe a zero', () => {
    const step = prepareSnapshot(entree({ previous: VEILLE, totalValue: usdc('110000') }));

    expect(valeur(step, PORTFOLIO_KEYS.index)).toBe('1.1');
    expect(valeur(step, PORTFOLIO_KEYS.peak)).toBe('1.1');
    expect(valeur(step, PORTFOLIO_KEYS.drawdown)).toBe('0');
  });

  /*
   * La propriete que le chainage existe pour avoir : le sommet est un maximum
   * courant, pas l'indice de la veille. Un rebond partiel depuis un creux reste
   * un drawdown tant que le sommet n'est pas repris.
   */
  it('remonter depuis un creux ne remet pas le sommet a l’indice du jour', () => {
    const creux = photoPassee('2026-09-11', '70000', {
      [PORTFOLIO_KEYS.index]: '0.7',
      [PORTFOLIO_KEYS.peak]: '1',
      [PORTFOLIO_KEYS.drawdown]: '-0.3',
    });
    const step = prepareSnapshot(entree({ previous: creux, totalValue: usdc('84000') }));

    expect(valeur(step, PORTFOLIO_KEYS.index)).toBe('0.84');
    expect(valeur(step, PORTFOLIO_KEYS.peak)).toBe('1');
    expect(valeur(step, PORTFOLIO_KEYS.drawdown)).toBe('-0.16');
  });

  /*
   * « Une photo sans indice lisible » a deux formes atteignables : la cle
   * absente et la valeur nulle ou negative. La troisieme du garde — non finie —
   * est **inatteignable par l'adapter** : `decimalFromText` refuse NaN et
   * Infinity a la frontiere de la base, ce que tient deja
   * `test/adapters/frontiere-decimal.test.ts`. Declaree, pas sondee ici.
   */
  it.each([
    ['aucune cle', {}],
    ['un sommet nul', { [PORTFOLIO_KEYS.index]: '1', [PORTFOLIO_KEYS.peak]: '0' }],
  ])('une photo anterieure avec %s ne se chaine pas, et rien n’est ecrit', (_cas, porte) => {
    const step = prepareSnapshot(entree({ previous: photoPassee('2026-09-11', '100000', porte) }));

    expect(step.drawdown).toMatchObject({ status: 'UNAVAILABLE', code: 'MALFORMED_CARRIED_INDEX' });
    expect(step.write).toMatchObject({ status: 'SKIPPED', code: 'NO_CARRIED_INDEX' });
  });

  /* Le refus vient du noyau : une sous-periode partant de zero n'a pas de rendement. */
  it('une photo anterieure a valeur nulle ne borne aucune sous-periode', () => {
    const step = prepareSnapshot(entree({ previous: photoPassee('2026-09-11', '0') }));

    expect(step.drawdown).toMatchObject({ status: 'UNAVAILABLE', code: 'UNDEFINED_SUB_PERIOD' });
    expect(step.write).toMatchObject({ status: 'SKIPPED', code: 'NO_CARRIED_INDEX' });
  });
});

// --- La neutralite aux flux -------------------------------------------------

describe('le drawdown se lit sur l’indice de croissance, jamais sur la valeur', () => {
  /*
   * Le garde-fou central du §6 : lu sur la valeur en USDC, chacun de ces deux
   * cas bougerait l'indice de 25 % sans qu'aucun prix n'ait change, et le
   * premier suspendrait les reequilibrages sur un virement sortant.
   */
  it.each([
    ['un retrait de 25 000 USDC', '75000', '-25000'],
    ['un apport de 25 000 USDC', '125000', '25000'],
  ])('%s ne bouge ni l’indice ni le drawdown', (_cas, total, montant) => {
    const step = prepareSnapshot(
      entree({
        previous: VEILLE,
        totalValue: usdc(total),
        flows: [flux(`${RUN_DATE}T06:00:00.000Z`, montant)],
      }),
    );

    expect(valeur(step, PORTFOLIO_KEYS.index)).toBe('1');
    expect(valeur(step, PORTFOLIO_KEYS.drawdown)).toBe('0');
    expect(step.suspension.status).toBe('INACTIVE');
  });

  /*
   * Les deux bornes de la fenetre de flux, une sonde chacune. Elles ne sont pas
   * symetriques : l'ouverte exclut ce que la valeur de la photo precedente
   * contenait deja, la fermee un flux post-date qui n'a pas touche les soldes.
   */
  it.each([
    ['avant la photo precedente', '2026-09-11T06:59:59.000Z'],
    ['apres l’instant du run', '2026-09-12T07:00:01.000Z'],
  ])('un flux %s ne compte pas dans la sous-periode', (_cas, at) => {
    const step = prepareSnapshot(
      entree({ previous: VEILLE, totalValue: usdc('75000'), flows: [flux(at, '-25000')] }),
    );

    expect(valeur(step, PORTFOLIO_KEYS.drawdown)).toBe('-0.25');
  });

  it('un retrait superieur a la valeur ne rend pas un drawdown, il rend son absence', () => {
    const step = prepareSnapshot(
      entree({
        previous: VEILLE,
        totalValue: usdc('1000'),
        flows: [flux(`${RUN_DATE}T06:00:00.000Z`, '2000')],
      }),
    );

    expect(step.drawdown).toMatchObject({ status: 'UNAVAILABLE', code: 'FLOW_EXCEEDS_VALUE' });
    expect(Object.keys(step.benchmarks)).not.toContain(PORTFOLIO_KEYS.drawdown);
  });
});

// --- Le seuil du §6 ---------------------------------------------------------

describe('§6 — la suspension au drawdown de 25 %', () => {
  /* Les deux cotes de la borne, et la borne elle-meme : « de 25 % » l'inclut. */
  it.each([
    ['75000.01', false],
    ['75000', true],
    ['60000', true],
  ])('valeur a %s USDC : suspension %s', (total, attendue) => {
    const step = prepareSnapshot(entree({ previous: VEILLE, totalValue: usdc(total) }));

    expect(step.suspension.status).toBe(attendue ? 'ACTIVE' : 'INACTIVE');
    if (step.suspension.status === 'ACTIVE') {
      expect(step.suspension.drawdown.lte(DRAWDOWN_SUSPENSION_THRESHOLD)).toBe(true);
      expect(step.suspension.reason).toContain(SUSPENSION_MARKER);
    }
  });

  it('un drawdown indisponible ne suspend pas', () => {
    const step = prepareSnapshot(entree({ previous: photoPassee('2026-09-11', '100000', {}) }));
    expect(step.suspension.status).toBe('INACTIVE');
  });
});

// --- Une photo par jour -----------------------------------------------------

describe('la photo du jour se prend une fois', () => {
  it('un second run du meme jour ne rechaine rien et relit le drawdown stocke', () => {
    const dejaPrise = photoPassee(RUN_DATE, '70000', {
      [PORTFOLIO_KEYS.index]: '0.7',
      [PORTFOLIO_KEYS.peak]: '1',
      [PORTFOLIO_KEYS.drawdown]: '-0.3',
    });
    const step = prepareSnapshot(entree({ previous: dejaPrise, totalValue: usdc('70000') }));

    expect(step.write).toMatchObject({ status: 'SKIPPED', code: 'ALREADY_SNAPSHOTTED' });
    // Meme chiffre que le premier run, donc meme decision de suspension.
    expect(step.drawdown.status === 'COMPUTED' && step.drawdown.drawdown.toString()).toBe('-0.3');
    expect(step.suspension.status).toBe('ACTIVE');
  });

  it('une photo du jour posee sans historique reste sans drawdown au second run', () => {
    const step = prepareSnapshot(entree({ previous: photoPassee(RUN_DATE, '100000') }));

    expect(step.drawdown).toMatchObject({ status: 'UNAVAILABLE', code: 'NO_PREVIOUS_SNAPSHOT' });
    expect(step.write).toMatchObject({ status: 'SKIPPED', code: 'ALREADY_SNAPSHOTTED' });
  });

  it('le rejeu d’un jour anterieur a une photo existante n’ecrase rien', () => {
    const step = prepareSnapshot(entree({ previous: photoPassee('2026-09-13', '90000') }));

    expect(step.drawdown).toMatchObject({ status: 'UNAVAILABLE', code: 'SNAPSHOT_NOT_ANTERIOR' });
    expect(step.write).toMatchObject({ status: 'SKIPPED', code: 'NO_CARRIED_INDEX' });
  });
});

// --- Les benchmarks du §9 ---------------------------------------------------

describe('etape 7 — les benchmarks sont consommes, pas recalcules', () => {
  it('rend les deux hold sur la fenetre, et deux courbes distinctes', () => {
    const step = prepareSnapshot(entree({ history: MOUVANT }));

    expect(valeur(step, HOLD_BTC_KEYS.twr)).toBeDefined();
    expect(valeur(step, HOLD_5050_KEYS.twr)).toBeDefined();
    // BTC monte plus vite qu'ETH : melanger les deux ne peut pas donner le meme
    // chiffre, et un hold 50/50 recopie du hold BTC se verrait ici.
    expect(valeur(step, HOLD_BTC_KEYS.twr)).not.toBe(valeur(step, HOLD_5050_KEYS.twr));
    // Le creux periodique creuse les deux courbes : un max drawdown nul dirait
    // que la serie ne baisse jamais.
    expect(new Decimal(valeur(step, HOLD_BTC_KEYS.maxDrawdown) ?? '0').isNegative()).toBe(true);
    expect(valeur(step, HOLD_BTC_KEYS.sharpe)).toBeDefined();
    expect(step.gaps).toEqual([
      { key: PORTFOLIO_KEYS.drawdown, code: 'NO_PREVIOUS_SNAPSHOT', reason: expect.any(String) },
    ]);
  });

  it('une fenetre plate n’a pas de Sharpe, et le dit au lieu d’ecrire zero', () => {
    const step = prepareSnapshot(entree());

    expect(valeur(step, HOLD_BTC_KEYS.twr)).toBe('0');
    expect(Object.keys(step.benchmarks)).not.toContain(HOLD_BTC_KEYS.sharpe);
    expect(step.gaps.filter((g) => g.code === 'ZERO_VOLATILITY').map((g) => g.key)).toEqual([
      HOLD_BTC_KEYS.sharpe,
      HOLD_5050_KEYS.sharpe,
    ]);
  });

  /*
   * « Deux series de longueurs ou de dates differentes » annonce trois formes
   * et aucune ne tombe au meme endroit. Les deux longueurs ne sont pas
   * symetriques : la boucle parcourt BTC, donc une ETH trop courte s'y voit,
   * tandis qu'une BTC trop courte n'y laisse aucune trace et n'est attrapee que
   * par le controle de longueur. La troisieme forme ne touche que la date.
   */
  it.each([
    ['une bougie de moins cote ETH', { BTC: PLAT.BTC, ETH: PLAT.ETH.slice(0, -1) }],
    ['une bougie de moins cote BTC', { BTC: PLAT.BTC.slice(0, -1), ETH: PLAT.ETH }],
    ['dates decalees a longueur egale', { BTC: PLAT.BTC, ETH: [...PLAT.ETH.slice(1), PLAT.ETH[0]!] }],
  ])('%s : les deux series ne se recollent pas', (_cas, history) => {
    const step = prepareSnapshot(entree({ history }));

    expect(step.gaps.map((g) => g.code)).toContain('HISTORY_MISALIGNED');
    expect(Object.keys(step.benchmarks)).not.toContain(HOLD_BTC_KEYS.twr);
  });

  /*
   * Une metrique que le noyau refuse n'est jamais ecrite : son motif remonte en
   * `gaps` et sa cle reste absente. Les trois refus possibles d'une fenetre trop
   * courte tombent d'un coup, sur les deux hold.
   */
  it('une fenetre d’un seul jour ne rend aucune des trois metriques', () => {
    const unJour = { BTC: PLAT.BTC.slice(0, 1), ETH: PLAT.ETH.slice(0, 1) };
    const step = prepareSnapshot(entree({ history: unJour }));

    expect(step.gaps.filter((g) => g.code === 'NO_SUB_PERIOD').map((g) => g.key)).toEqual([
      HOLD_BTC_KEYS.twr,
      HOLD_BTC_KEYS.maxDrawdown,
      HOLD_BTC_KEYS.sharpe,
      HOLD_5050_KEYS.twr,
      HOLD_5050_KEYS.maxDrawdown,
      HOLD_5050_KEYS.sharpe,
    ]);
  });

  it('une fenetre vide est refusee par le noyau, hold par hold', () => {
    const step = prepareSnapshot(entree({ history: { BTC: [], ETH: [] } }));

    expect(step.gaps.filter((g) => g.code === 'EMPTY_SERIES').map((g) => g.key)).toEqual([
      `${HOLD_BTC_KEYS.label}_*`,
      `${HOLD_5050_KEYS.label}_*`,
    ]);
  });

  /* Les deux courbes d'ombre du §4 sont absentes, et c'est une decision. */
  it('n’ecrit ni courbe ladder ni courbe dca', () => {
    const step = prepareSnapshot(entree({ history: MOUVANT }));
    expect(Object.keys(step.benchmarks).filter((k) => /ladder|dca/.test(k))).toEqual([]);
  });
});
