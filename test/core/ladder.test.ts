import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import type { Anchors, LadderDecision, LadderInput } from '../../src/core/strategy/ladder.js';
import {
  LADDER_PARAMS,
  NO_ANCHORS,
  TRANCHE_USDC,
  decide,
} from '../../src/core/strategy/ladder.js';
import type { Clock, IsoDate, Price, Quantity } from '../../src/core/types.js';

const qty = (v: string): Quantity => new Decimal(v) as Quantity;
const price = (v: string): Price => new Decimal(v) as Price;

const clockAt = (day: IsoDate): Clock => ({ today: () => day });

/** De quoi acheter comme vendre : ni le cash ni les lignes ne bornent le run. */
const RICH: Holdings = { BTC: qty('1'), ETH: qty('10'), USDC: qty('50000') };

/**
 * Ancres de reference. Tous les seuils tombent juste :
 *
 * | actif | achat            | vente             |
 * |-------|------------------|-------------------|
 * | BTC   | -7 %  -> 55 800  | +12 % -> 67 200   |
 * | ETH   | -9 %  ->  2 730  | +15 % ->  3 450   |
 */
const ANCHORED: Anchors = { BTC: price('60000'), ETH: price('3000') };

/** Cours poses sur les ancres : aucun pas franchi. */
const CALM: Prices = { BTC: price('60000'), ETH: price('3000') };

const at = (asset: 'BTC' | 'ETH', value: string): Prices => ({ ...CALM, [asset]: price(value) });

function run(prices: Prices, overrides: Partial<LadderInput> = {}): LadderDecision {
  return decide({
    clock: clockAt('2026-08-31'),
    holdings: RICH,
    anchors: ANCHORED,
    prices,
    ...overrides,
  });
}

/** Forme compacte d'une jambe, pour comparer sans dependre de l'egalite de Decimal. */
const shape = (decision: LadderDecision): readonly string[] =>
  decision.legs.map(
    (leg) =>
      `${leg.asset}-${leg.quote} ${leg.side} ${leg.amount.toString()} @ ${leg.limitPrice.toString()}`,
  );

const anchorsOf = (decision: LadderDecision): Record<string, string> =>
  Object.fromEntries(
    Object.entries(decision.anchors).map(([asset, anchor]) => [asset, anchor.toString()]),
  );

describe('parametres', () => {
  it('fige les pas de l annexe, distincts d un actif a l autre', () => {
    expect(LADDER_PARAMS.BTC.buyStep.toString()).toBe('0.07');
    expect(LADDER_PARAMS.BTC.sellStep.toString()).toBe('0.12');
    expect(LADDER_PARAMS.ETH.buyStep.toString()).toBe('0.09');
    expect(LADDER_PARAMS.ETH.sellStep.toString()).toBe('0.15');
    expect(TRANCHE_USDC.toString()).toBe('500');
  });
});

describe('premier jour du rejeu', () => {
  /*
   * Ni la spec de phase 0 ni la v2.0 ne disent d'ou vient la premiere ancre.
   * Convention retenue : le cours de cloture du premier jour, sans tranche. Ces
   * deux tests sont ce qui rend le choix explicite au lieu d'implicite.
   */
  it('pose l ancre au cours de cloture et n achete rien', () => {
    const decision = run(at('BTC', '42000'), { anchors: NO_ANCHORS });

    expect(decision.legs).toEqual([]);
    expect(decision.trigger).toBe('NONE');
    expect(anchorsOf(decision)).toEqual({ BTC: '42000', ETH: '3000' });
    expect(decision.reason).toContain('ancre posee au cours de cloture');
  });

  it('l ancre posee sert des le lendemain', () => {
    const first = run(at('BTC', '60000'), { anchors: NO_ANCHORS });
    const second = run(at('BTC', '55800'), { anchors: first.anchors });

    expect(shape(second)).toEqual(['BTC-USDC BUY 500 @ 55800']);
  });
});

describe('seuils', () => {
  it('achete BTC au cours exact de -7 %, borne incluse', () => {
    const decision = run(at('BTC', '55800'));

    expect(shape(decision)).toEqual(['BTC-USDC BUY 500 @ 55800']);
    expect(decision.trigger).toBe('ANCHOR_CROSSED');
  });

  it('n achete pas BTC un centieme au dessus du seuil', () => {
    expect(run(at('BTC', '55800.01')).legs).toEqual([]);
  });

  it('vend BTC au cours exact de +12 %, borne incluse', () => {
    expect(shape(run(at('BTC', '67200')))).toEqual(['BTC-USDC SELL 500 @ 67200']);
  });

  it('ne vend pas BTC un centieme sous le seuil', () => {
    expect(run(at('BTC', '67199.99')).legs).toEqual([]);
  });

  /*
   * Les deux tests qui rattrapent l uniformisation des pas : a -7 % et a +12 %,
   * ETH ne bouge pas. Une implementation qui appliquerait les pas de BTC aux
   * deux actifs passerait tous les tests ci-dessus et echouerait ici.
   */
  it('ne touche pas ETH aux pas de BTC', () => {
    expect(run(at('ETH', '2790')).legs).toEqual([]);
    expect(run(at('ETH', '3360')).legs).toEqual([]);
  });

  it('achete ETH a -9 % et le vend a +15 %', () => {
    expect(shape(run(at('ETH', '2730')))).toEqual(['ETH-USDC BUY 500 @ 2730']);
    expect(shape(run(at('ETH', '3450')))).toEqual(['ETH-USDC SELL 500 @ 3450']);
  });
});

describe('ancre unique', () => {
  it('ne suit pas le cours tant qu aucune tranche ne part', () => {
    const drifted = run(at('BTC', '58000'));

    expect(drifted.legs).toEqual([]);
    expect(anchorsOf(drifted)).toEqual({ BTC: '60000', ETH: '3000' });

    /*
     * Le cours a deja baisse de 3,3 %, mais le pas se mesure toujours depuis
     * 60 000. Une ancre qui aurait suivi le cours a 58 000 attendrait 53 940 et
     * ne tirerait pas ici : c'est l'erreur que ce test ferme.
     */
    const fired = run(at('BTC', '55800'), { anchors: drifted.anchors });
    expect(shape(fired)).toEqual(['BTC-USDC BUY 500 @ 55800']);
  });

  it('repose l ancre au cours du jour quand la tranche part', () => {
    const bought = run(at('BTC', '55800'));

    expect(anchorsOf(bought)).toEqual({ BTC: '55800', ETH: '3000' });

    // Le pas suivant se mesure depuis 55 800 : 55 800 x 0,93 = 51 894.
    expect(run(at('BTC', '51894.01'), { anchors: bought.anchors }).legs).toEqual([]);
    expect(shape(run(at('BTC', '51894'), { anchors: bought.anchors }))).toEqual([
      'BTC-USDC BUY 500 @ 51894',
    ]);
  });

  it('n achete qu une tranche par actif et par jour, meme sur un effondrement', () => {
    // -30 % en un jour vaut plus de quatre pas de 7 %. Une seule tranche part.
    const decision = run(at('BTC', '42000'));

    expect(shape(decision)).toEqual(['BTC-USDC BUY 500 @ 42000']);
    expect(anchorsOf(decision)).toEqual({ BTC: '42000', ETH: '3000' });
  });
});

describe('les deux actifs sont independants', () => {
  it('produit les jambes dans l ordre BTC puis ETH', () => {
    const decision = run({ BTC: price('55800'), ETH: price('3450') });

    expect(shape(decision)).toEqual([
      'BTC-USDC BUY 500 @ 55800',
      'ETH-USDC SELL 500 @ 3450',
    ]);
    expect(anchorsOf(decision)).toEqual({ BTC: '55800', ETH: '3450' });
  });

  it('serialise les ancres dans un ordre fige', () => {
    expect(Object.keys(run(CALM).anchors)).toEqual(['BTC', 'ETH']);
  });
});

describe('contrepartie disponible', () => {
  it('plafonne l achat au cash restant', () => {
    const poor: Holdings = { ...RICH, USDC: qty('300') };

    expect(shape(run(at('BTC', '55800'), { holdings: poor }))).toEqual([
      'BTC-USDC BUY 300 @ 55800',
    ]);
  });

  it('plafonne la vente a la ligne detenue', () => {
    // 0,001 BTC a 67 200 valent 67,2 USDC : la tranche de 500 ne peut pas partir entiere.
    const thin: Holdings = { ...RICH, BTC: qty('0.001') };

    expect(shape(run(at('BTC', '67200'), { holdings: thin }))).toEqual([
      'BTC-USDC SELL 67.2 @ 67200',
    ]);
  });

  it('ne produit pas de jambe sans contrepartie et laisse l ancre en place', () => {
    const broke: Holdings = { ...RICH, USDC: qty('0') };
    const decision = run(at('BTC', '55800'), { holdings: broke });

    expect(decision.legs).toEqual([]);
    expect(decision.trigger).toBe('NONE');
    expect(anchorsOf(decision)).toEqual({ BTC: '60000', ETH: '3000' });

    /*
     * L'ancre immobile est ce qui permet a la tranche de partir des que le cash
     * revient. Deplacee sur un signal non honore, elle aurait consomme le
     * franchissement et il aurait fallu redescendre a 51 894.
     */
    const funded = run(at('BTC', '55800'), { anchors: decision.anchors });
    expect(shape(funded)).toEqual(['BTC-USDC BUY 500 @ 55800']);
  });

  /*
   * Le krach correle : BTC et ETH franchissent leur pas d'achat le meme jour et
   * puisent dans le meme solde. Avec 600 USDC de cash, un budget lu une fois
   * pour toutes donnait deux tranches de 500 et un cash a -400, sur lequel tout
   * le reste du rejeu se serait ensuite deroule.
   */
  it('partage un cash unique entre deux achats du meme jour', () => {
    const tight: Holdings = { ...RICH, USDC: qty('600') };
    const decision = run({ BTC: price('55800'), ETH: price('2730') }, { holdings: tight });

    expect(shape(decision)).toEqual(['BTC-USDC BUY 500 @ 55800', 'ETH-USDC BUY 100 @ 2730']);

    const engaged = decision.legs.reduce((acc, leg) => acc.plus(leg.amount), new Decimal(0));
    expect(engaged.toString()).toBe('600');
  });

  it('n achete pas le second actif quand le premier a pris tout le cash', () => {
    const tight: Holdings = { ...RICH, USDC: qty('500') };
    const decision = run({ BTC: price('55800'), ETH: price('2730') }, { holdings: tight });

    expect(shape(decision)).toEqual(['BTC-USDC BUY 500 @ 55800']);
    expect(decision.reason).toContain('ETH : BUY a 2730 sans contrepartie disponible');

    /*
     * L'ancre ETH reste a 3 000 : le franchissement n'a pas ete consomme et la
     * tranche partira des que le cash reviendra, sans exiger un pas de plus.
     */
    expect(anchorsOf(decision)).toEqual({ BTC: '55800', ETH: '3000' });
  });

  /*
   * Convention : le produit d'une vente n'est pas encaisse dans le run qui la
   * decide. Le rejeu applique les jambes apres coup ; faire financer l'achat
   * d'ETH par la vente de BTC le meme jour supposerait un reglement instantane
   * que rien ne garantit.
   */
  it('ne fait pas financer un achat par une vente du meme jour', () => {
    const noCash: Holdings = { ...RICH, USDC: qty('0') };
    const decision = run({ BTC: price('67200'), ETH: price('2730') }, { holdings: noCash });

    expect(shape(decision)).toEqual(['BTC-USDC SELL 500 @ 67200']);
    expect(anchorsOf(decision)).toEqual({ BTC: '67200', ETH: '3000' });
  });

  it('ne plafonne pas une vente au cash engage par l achat du meme jour', () => {
    const tight: Holdings = { ...RICH, USDC: qty('500') };
    const decision = run({ BTC: price('55800'), ETH: price('3450') }, { holdings: tight });

    expect(shape(decision)).toEqual(['BTC-USDC BUY 500 @ 55800', 'ETH-USDC SELL 500 @ 3450']);
  });

  it('ne produit rien sur un portefeuille que l on ne sait pas valoriser', () => {
    const empty: Holdings = { BTC: qty('0'), ETH: qty('0'), USDC: qty('0') };
    const decision = run(at('BTC', '55800'), { holdings: empty });

    expect(decision.legs).toEqual([]);
    expect(anchorsOf(decision)).toEqual({ BTC: '60000', ETH: '3000' });
  });
});

describe('cours inexploitable', () => {
  /*
   * Une ancre est un etat qui se propage d'un jour sur l'autre : un cours
   * aberrant qui y entre y reste. Une ancre a zero rend les deux seuils nuls,
   * donc tout cours superieur ou egal au seuil de vente, donc une vente par
   * jour jusqu'a la fin du rejeu.
   */
  it('ignore un cours nul sans toucher a l ancre', () => {
    const decision = run(at('BTC', '0'));

    expect(decision.legs).toEqual([]);
    expect(anchorsOf(decision)).toEqual({ BTC: '60000', ETH: '3000' });
    expect(decision.reason).toContain('inexploitable');
  });

  it('ignore un cours NaN ou negatif sans produire de jambe NaN', () => {
    for (const value of ['NaN', '-1', 'Infinity']) {
      const decision = run(at('BTC', value));

      expect(decision.legs).toEqual([]);
      expect(anchorsOf(decision).BTC).toBe('60000');
    }
  });

  it('repose une ancre aberrante recue en entree au lieu de tirer dessus', () => {
    const poisoned: Anchors = { BTC: price('0'), ETH: price('3000') };
    const decision = run(at('BTC', '55800'), { anchors: poisoned });

    expect(decision.legs).toEqual([]);
    expect(anchorsOf(decision)).toEqual({ BTC: '55800', ETH: '3000' });
  });
});

describe('purete', () => {
  it('ne mute pas les ancres recues', () => {
    const before: Anchors = { ...ANCHORED };
    const decision = run(at('BTC', '55800'), { anchors: before });

    expect(anchorsOf(decision).BTC).toBe('55800');
    expect(before.BTC?.toString()).toBe('60000');
  });

  it('deux appels sur le meme etat donnent le meme resultat', () => {
    const first = run(at('BTC', '55800'));
    const second = run(at('BTC', '55800'));

    expect(shape(second)).toEqual(shape(first));
    expect(anchorsOf(second)).toEqual(anchorsOf(first));
    expect(second.reason).toBe(first.reason);
  });

  it('prend sa date de run de l horloge injectee', () => {
    const decision = run(CALM, { clock: clockAt('2024-01-01') });

    expect(decision.runDate).toBe('2024-01-01');
    expect(decision.strategy).toBe('ladder');
  });
});
