import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Holdings, PricedAsset, Prices } from '../../src/core/portfolio.js';
import { valuate } from '../../src/core/portfolio.js';
import type {
  Decision,
  RebalanceParams,
  RebalanceState,
} from '../../src/core/strategy/rebalance.js';
import {
  DEFAULT_REBALANCE_PARAMS,
  cashBand,
  decide,
} from '../../src/core/strategy/rebalance.js';
import type { Clock, IntentLeg, IsoDate, Price, Quantity, Weight } from '../../src/core/types.js';

const qty = (value: string): Quantity => new Decimal(value) as Quantity;
const price = (value: string): Price => new Decimal(value) as Price;
const weight = (value: string): Weight => new Decimal(value) as Weight;

/** Tolerance de C8, la meme que celle de C4 sur la somme des poids. */
const TOLERANCE = new Decimal('1e-8');

const RUN_DATE: IsoDate = '2026-03-14';

const clockAt = (date: IsoDate): Clock => ({ today: () => date });

const CLOCK = clockAt(RUN_DATE);

/**
 * Prix ronds et total de 100 000 USDC : chaque poids vise ci-dessous est
 * atteint exactement, sans arrondi. Les bornes de C6 et C7 se mesurent au
 * quatrieme chiffre, un portefeuille approximatif ne les testerait pas.
 */
const BTC_PRICE = price('50000');
const ETH_PRICE = price('2500');
const PRICES: Prices = { BTC: BTC_PRICE, ETH: ETH_PRICE };
const TOTAL = new Decimal('100000');

/** Construit le portefeuille qui realise exactement les poids demandes. */
function stateAt(btc: string, eth: string, usdc: string): RebalanceState {
  return {
    holdings: {
      BTC: TOTAL.mul(btc).div(BTC_PRICE) as Quantity,
      ETH: TOTAL.mul(eth).div(ETH_PRICE) as Quantity,
      USDC: TOTAL.mul(usdc) as Quantity,
    },
    prices: PRICES,
  };
}

function decided(decision: Decision): Extract<Decision, { status: 'DECIDED' }> {
  if (decision.status !== 'DECIDED') {
    throw new Error(`attendu DECIDED, recu ${decision.status} (${decision.code})`);
  }
  return decision;
}

function undecidable(decision: Decision): Extract<Decision, { status: 'UNDECIDABLE' }> {
  if (decision.status !== 'UNDECIDABLE') throw new Error('attendu UNDECIDABLE, recu DECIDED');
  return decision;
}

const intentAt = (state: RebalanceState, params = DEFAULT_REBALANCE_PARAMS) =>
  decided(decide(state, CLOCK, params)).intent;

/** Refuse au passage toute jambe sur une ligne qui n'a pas de prix de marche. */
function pricedAsset(asset: string): PricedAsset {
  if (asset !== 'BTC' && asset !== 'ETH') {
    throw new Error(`jambe sur ${asset} : seuls BTC et ETH donnent lieu a un ordre`);
  }
  return asset;
}

/**
 * Rejoue les jambes sur les soldes, comme le ferait une execution parfaite :
 * la quantite d'actif est le montant de la jambe divise par le prix limite, et
 * la contrepartie en cash est le montant lui-meme. C'est le seul moyen de
 * verifier C8 sur le resultat plutot que sur l'intention.
 */
function applyLegs(state: RebalanceState, legs: readonly IntentLeg[]): Holdings {
  const holdings: Record<'BTC' | 'ETH' | 'USDC', Decimal> = { ...state.holdings };

  for (const leg of legs) {
    const asset = pricedAsset(leg.asset);
    const quantity = leg.amount.div(leg.limitPrice);
    const sign = leg.side === 'BUY' ? 1 : -1;

    holdings[asset] = holdings[asset].plus(quantity.mul(sign));
    holdings.USDC = holdings.USDC.minus(leg.amount.mul(sign));
  }

  return holdings as Holdings;
}

/** Ecart maximal entre les poids obtenus apres execution et les cibles. */
function driftFromTarget(state: RebalanceState, legs: readonly IntentLeg[]): Decimal {
  const after = valuate(applyLegs(state, legs), state.prices);
  if (after.status !== 'VALUED') throw new Error(`portefeuille non valorisable : ${after.code}`);

  return Decimal.max(
    after.weights.BTC.minus(DEFAULT_REBALANCE_PARAMS.targets.BTC).abs(),
    after.weights.ETH.minus(DEFAULT_REBALANCE_PARAMS.targets.ETH).abs(),
    after.weights.USDC.minus(DEFAULT_REBALANCE_PARAMS.targets.USDC).abs(),
  );
}

describe('bande de cash', () => {
  it('vaut [0.24, 0.36] pour une cible a 30 % et un ecart relatif de 20 %', () => {
    const band = cashBand(DEFAULT_REBALANCE_PARAMS);

    expect(band.lower.toString()).toBe('0.24');
    expect(band.upper.toString()).toBe('0.36');
  });
});

/*
 * Les quatre tests de borne. Ils encadrent le seuil au dix-millieme : c'est la
 * seule facon de distinguer `lt` de `lte`, et de voir une comparaison qui serait
 * partie en coercition de chaine plutot qu'en comparaison numerique.
 */
describe('C6 : bornes incluses, A ne tire pas dans [0.24, 0.36]', () => {
  it('ne tire pas au poids USDC de 0.24 exactement', () => {
    const intent = intentAt(stateAt('0.40', '0.36', '0.24'));

    expect(intent.weightsBefore.USDC.toString()).toBe('0.24');
    expect(intent.trigger).toBe('NONE');
    expect(intent.legs).toEqual([]);
  });

  it('ne tire pas au poids USDC de 0.36 exactement', () => {
    const intent = intentAt(stateAt('0.34', '0.30', '0.36'));

    expect(intent.weightsBefore.USDC.toString()).toBe('0.36');
    expect(intent.trigger).toBe('NONE');
    expect(intent.legs).toEqual([]);
  });

  it('ne tire pas au centre de la bande, meme si BTC et ETH ont derive', () => {
    const intent = intentAt(stateAt('0.55', '0.15', '0.30'));

    expect(intent.trigger).toBe('NONE');
    expect(intent.legs).toEqual([]);
  });
});

describe('C7 : A tire a 0.2399 et a 0.3601', () => {
  it('tire au poids USDC de 0.2399', () => {
    const intent = intentAt(stateAt('0.44', '0.3201', '0.2399'));

    expect(intent.weightsBefore.USDC.toString()).toBe('0.2399');
    expect(intent.trigger).toBe('CASH_BAND');
    expect(intent.legs.length).toBeGreaterThan(0);
  });

  it('tire au poids USDC de 0.3601', () => {
    const intent = intentAt(stateAt('0.32', '0.3199', '0.3601'));

    expect(intent.weightsBefore.USDC.toString()).toBe('0.3601');
    expect(intent.trigger).toBe('CASH_BAND');
    expect(intent.legs.length).toBeGreaterThan(0);
  });
});

describe('jambes', () => {
  it('vend les deux lignes crypto quand le cash est passe sous la bande', () => {
    const { legs } = intentAt(stateAt('0.44', '0.3201', '0.2399'));

    expect(legs).toHaveLength(2);
    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toString()])).toEqual([
      ['BTC', 'SELL', '4000'],
      ['ETH', 'SELL', '2010'],
    ]);
  });

  /*
   * Le sens se decide ligne par ligne, pas par declenchement : ici le cash est
   * au-dessus de sa bande et pourtant ETH, sur-pondere, se vend. Un code qui
   * deduirait le sens du cote de bande franchi passerait les deux tests de C7 et
   * echouerait sur celui-ci.
   */
  it('achete ou vend ligne par ligne, quel que soit le cote de bande franchi', () => {
    const { legs } = intentAt(stateAt('0.32', '0.3199', '0.3601'));

    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toString()])).toEqual([
      ['BTC', 'BUY', '8000'],
      ['ETH', 'SELL', '1990'],
    ]);
  });

  it('ne produit pas de jambe pour une ligne deja exactement a sa cible', () => {
    const { legs } = intentAt(stateAt('0.3399', '0.30', '0.3601'));

    expect(legs.map((leg) => leg.asset)).toEqual(['BTC']);
  });

  it('cote toutes les jambes en USDC, au prix de marche du jour', () => {
    const { legs } = intentAt(stateAt('0.44', '0.3201', '0.2399'));

    expect(legs.map((leg) => leg.quote)).toEqual(['USDC', 'USDC']);
    expect(legs.map((leg) => leg.limitPrice.toString())).toEqual(['50000', '2500']);
  });

  it('ne produit jamais de jambe sur la ligne de cash', () => {
    const { legs } = intentAt(stateAt('0.44', '0.3201', '0.2399'));

    expect(legs.map((leg) => leg.asset)).not.toContain('USDC');
  });
});

describe('C8 : symetrie, les poids obtenus egalent la cible', () => {
  it('ramene a la cible depuis un cash sous la bande', () => {
    const state = stateAt('0.44', '0.3201', '0.2399');

    expect(driftFromTarget(state, intentAt(state).legs).lte(TOLERANCE)).toBe(true);
  });

  it('ramene a la cible depuis un cash au-dessus de la bande', () => {
    const state = stateAt('0.32', '0.3199', '0.3601');

    expect(driftFromTarget(state, intentAt(state).legs).lte(TOLERANCE)).toBe(true);
  });

  it('ramene a la cible depuis un portefeuille entierement en cash', () => {
    const state = stateAt('0', '0', '1');

    expect(driftFromTarget(state, intentAt(state).legs).lte(TOLERANCE)).toBe(true);
  });

  /*
   * Les cas ecrits a la main ne couvrent que des poids ronds, ou les divisions
   * de decimal.js tombent juste. Le tirage aleatoire produit des poids a vingt
   * chiffres significatifs : c'est la que l'ecart de C8 se mesure vraiment.
   */
  it('ramene a la cible sur des portefeuilles tires au hasard', () => {
    const exposure = fc.integer({ min: 0, max: 10_000_000 });

    fc.assert(
      fc.property(exposure, exposure, exposure, (btc, eth, usdc) => {
        fc.pre(btc + eth + usdc > 0);

        const state: RebalanceState = {
          holdings: {
            BTC: new Decimal(btc).div(BTC_PRICE) as Quantity,
            ETH: new Decimal(eth).div(ETH_PRICE) as Quantity,
            USDC: qty(String(usdc)),
          },
          prices: PRICES,
        };

        const { trigger, legs } = intentAt(state);
        if (trigger === 'NONE') return true;

        return driftFromTarget(state, legs).lte(TOLERANCE);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('intention', () => {
  it('date le run avec l horloge injectee, jamais avec l horloge systeme', () => {
    const state = stateAt('0.40', '0.30', '0.30');

    expect(intentAt(stateAt('0.44', '0.3201', '0.2399')).runDate).toBe(RUN_DATE);
    expect(decided(decide(state, clockAt('2024-01-01'), DEFAULT_REBALANCE_PARAMS)).intent.runDate).toBe(
      '2024-01-01',
    );
  });

  it('journalise le nom de strategie et la cible permanente', () => {
    const intent = intentAt(stateAt('0.40', '0.30', '0.30'));

    expect(intent.strategy).toBe('rebalance');
    expect(intent.weightsTarget.BTC.toString()).toBe('0.4');
    expect(intent.weightsTarget.ETH.toString()).toBe('0.3');
    expect(intent.weightsTarget.USDC.toString()).toBe('0.3');
  });

  /*
   * `reason` part dans `decisions` et dans le rapport. C30 exige une sortie de
   * rejeu identique octet pour octet : la chaine est figee ici pour qu'un
   * changement de format soit un acte conscient.
   */
  it('explique le declenchement en clair, a format fige', () => {
    expect(intentAt(stateAt('0.44', '0.3201', '0.2399')).reason).toBe(
      'poids USDC 0.239900 sous la borne basse 0.240000 : retour a la cible',
    );
    expect(intentAt(stateAt('0.32', '0.3199', '0.3601')).reason).toBe(
      'poids USDC 0.360100 au-dessus de la borne haute 0.360000 : retour a la cible',
    );
    expect(intentAt(stateAt('0.40', '0.30', '0.30')).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000] : aucun reequilibrage',
    );
  });
});

describe('etats et parametres non decidables', () => {
  /*
   * Repondre `trigger: 'NONE'` ferait passer un portefeuille qu'on ne sait pas
   * valoriser pour un portefeuille sagement dans sa bande. Le rejet de C5
   * remonte tel quel.
   */
  it('remonte le rejet de valorisation sur un portefeuille de valeur nulle', () => {
    const empty: RebalanceState = {
      holdings: { BTC: qty('0'), ETH: qty('0'), USDC: qty('0') },
      prices: PRICES,
    };

    expect(undecidable(decide(empty, CLOCK, DEFAULT_REBALANCE_PARAMS)).code).toBe(
      'NON_POSITIVE_VALUE',
    );
  });

  it('refuse des cibles dont la somme ne fait pas 1', () => {
    const params: RebalanceParams = {
      ...DEFAULT_REBALANCE_PARAMS,
      targets: { BTC: weight('0.40'), ETH: weight('0.30'), USDC: weight('0.40') },
    };

    const decision = undecidable(decide(stateAt('0.40', '0.30', '0.30'), CLOCK, params));

    expect(decision.code).toBe('INVALID_PARAMS');
    expect(decision.reason).toContain('somme des cibles a 1.1');
  });

  /*
   * `Decimal.gt` repond false sur un NaN : un controle reduit a la somme des
   * cibles laisserait passer celle-ci, et les poids ressortiraient tous en NaN
   * sans qu'aucune ligne de code ne soit sautee. C'est le controle par cible,
   * en amont de la somme, qui l'arrete.
   */
  it('refuse une cible non finie que la comparaison de somme laisserait passer', () => {
    const params: RebalanceParams = {
      ...DEFAULT_REBALANCE_PARAMS,
      targets: { BTC: weight('NaN'), ETH: weight('0.30'), USDC: weight('0.30') },
    };

    expect(undecidable(decide(stateAt('0.40', '0.30', '0.30'), CLOCK, params)).code).toBe(
      'INVALID_PARAMS',
    );
  });

  it('refuse une cible negative', () => {
    const params: RebalanceParams = {
      ...DEFAULT_REBALANCE_PARAMS,
      targets: { BTC: weight('1.30'), ETH: weight('-0.30'), USDC: weight('0') },
    };

    expect(undecidable(decide(stateAt('0.40', '0.30', '0.30'), CLOCK, params)).code).toBe(
      'INVALID_PARAMS',
    );
  });

  /*
   * Une bande relative negative inverserait les bornes : la borne basse
   * passerait au-dessus de la borne haute et tout poids serait declare hors
   * bande, dans un sens choisi par l'ordre des `if`.
   */
  it('refuse une bande relative negative', () => {
    const params: RebalanceParams = {
      ...DEFAULT_REBALANCE_PARAMS,
      cashBandRelative: new Decimal('-0.20'),
    };

    expect(undecidable(decide(stateAt('0.40', '0.30', '0.30'), CLOCK, params)).code).toBe(
      'INVALID_PARAMS',
    );
  });
});
