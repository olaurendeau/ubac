import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
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
import type {
  Clock,
  IntentLeg,
  IsoDate,
  Price,
  Quantity,
  Weight,
  Weights,
} from '../../src/core/types.js';

const qty = (value: string): Quantity => new Decimal(value) as Quantity;
const price = (value: string): Price => new Decimal(value) as Price;
const weight = (value: string): Weight => new Decimal(value) as Weight;

/** La tolerance de C4 et de C8, reprise ici pour l'egalite au bord de C9. */
const TOLERANCE = new Decimal('1e-8');

const RUN_DATE: IsoDate = '2026-03-14';
const CLOCK: Clock = { today: () => RUN_DATE };

/** Memes prix ronds et meme total qu'en mode `target` : les bornes se mesurent au dix-millieme. */
const BTC_PRICE = price('50000');
const ETH_PRICE = price('2500');
const PRICES: Prices = { BTC: BTC_PRICE, ETH: ETH_PRICE };
const TOTAL = new Decimal('100000');

/** Les defauts de production, au seul mode pres. C'est le sujet de l'etape. */
const BAND_EDGE: RebalanceParams = { ...DEFAULT_REBALANCE_PARAMS, rebalanceMode: 'band_edge' };

const BAND = cashBand(DEFAULT_REBALANCE_PARAMS);

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

const intentAt = (state: RebalanceState, params: RebalanceParams = BAND_EDGE) =>
  decided(decide(state, CLOCK, params)).intent;

/**
 * Rejoue les jambes sur les soldes, comme le ferait une execution parfaite : la
 * quantite d'actif est le montant divise par le prix limite, la contrepartie en
 * cash est le montant lui-meme. C9 porte sur les poids **recalcules** apres
 * application des jambes, pas sur ce que l'intention declare viser : la seule
 * lecture qui vaille passe donc par ce rejeu, puis par `valuate`.
 */
function applyLegs(state: RebalanceState, legs: readonly IntentLeg[]): Holdings {
  const holdings: Record<'BTC' | 'ETH' | 'USDC', Decimal> = { ...state.holdings };

  for (const leg of legs) {
    if (leg.asset !== 'BTC' && leg.asset !== 'ETH') {
      throw new Error(`jambe sur ${leg.asset} : seuls BTC et ETH donnent lieu a un ordre`);
    }

    const sign = leg.side === 'BUY' ? 1 : -1;

    holdings[leg.asset] = holdings[leg.asset].plus(leg.amount.div(leg.limitPrice).mul(sign));
    holdings.USDC = holdings.USDC.minus(leg.amount.mul(sign));
  }

  return holdings as Holdings;
}

/** Poids obtenus une fois les jambes executees. */
function weightsAfter(state: RebalanceState, params: RebalanceParams = BAND_EDGE): Weights {
  const after = valuate(applyLegs(state, intentAt(state, params).legs), state.prices);
  if (after.status !== 'VALUED') throw new Error(`portefeuille non valorisable : ${after.code}`);

  return after.weights;
}

const near = (actual: Decimal, expected: Decimal | string): boolean =>
  actual.minus(expected).abs().lte(TOLERANCE);

/*
 * Les deux tests que le plan exige, un par sens de franchissement. Le sens haut
 * est celui qui compte : ramener systematiquement le cash a 24 %, quel que soit
 * le bord franchi, passe le test du bas sans broncher. Ici un cash a 40 % doit
 * redescendre a 36 %, et rien d'autre ne le distingue.
 */
describe('C9 : les poids recalcules egalent la bande franchie', () => {
  it('remonte le cash a 0.24 quand il est passe sous la borne basse', () => {
    const after = weightsAfter(stateAt('0.45', '0.35', '0.20'));

    expect(after.USDC.toFixed(8)).toBe('0.24000000');
    expect(near(after.USDC, BAND.lower)).toBe(true);
  });

  it('redescend le cash a 0.36 quand il est passe au-dessus de la borne haute', () => {
    const after = weightsAfter(stateAt('0.30', '0.30', '0.40'));

    expect(after.USDC.toFixed(8)).toBe('0.36000000');
    expect(near(after.USDC, BAND.upper)).toBe(true);
  });

  /*
   * L'autre moitie de C9 : « la bande franchie, **pas la cible** ». Le meme etat
   * decide dans les deux modes est la seule facon de le constater plutot que de
   * l'affirmer — un mode `band_edge` qui serait reste branche sur la cible
   * donnerait 0.30 des deux cotes.
   */
  it('ne se pose pas sur la cible, la ou le mode target s y pose', () => {
    const below = stateAt('0.45', '0.35', '0.20');
    const above = stateAt('0.30', '0.30', '0.40');

    expect(weightsAfter(below, DEFAULT_REBALANCE_PARAMS).USDC.toFixed(8)).toBe('0.30000000');
    expect(weightsAfter(above, DEFAULT_REBALANCE_PARAMS).USDC.toFixed(8)).toBe('0.30000000');

    expect(weightsAfter(below).USDC.equals(DEFAULT_REBALANCE_PARAMS.targets.USDC)).toBe(false);
    expect(weightsAfter(above).USDC.equals(DEFAULT_REBALANCE_PARAMS.targets.USDC)).toBe(false);
  });

  /*
   * Le solde hors cash se repartit au prorata des cibles, donc au ratio cible de
   * 40/30. C'est ce qui garde vraie la raison pour laquelle le declencheur B est
   * saute quand A tire : le reequilibrage remet deja le ratio sur sa cible, dans
   * ce mode comme dans l'autre.
   */
  it('remet le ratio BTC/ETH sur sa cible dans les deux sens', () => {
    const target = DEFAULT_REBALANCE_PARAMS.targets.BTC.div(DEFAULT_REBALANCE_PARAMS.targets.ETH);

    for (const state of [stateAt('0.45', '0.35', '0.20'), stateAt('0.30', '0.30', '0.40')]) {
      const after = weightsAfter(state);

      expect(near(after.BTC.div(after.ETH), target)).toBe(true);
    }
  });

  /*
   * Les poids ecrits a la main tombent sur des divisions rondes. Le tirage
   * aleatoire produit des portefeuilles a vingt chiffres significatifs, des deux
   * cotes de la bande, et c'est la que se verrait une borne figee ou un signe
   * inverse sur un cas que personne n'a pense a ecrire.
   */
  it('se pose sur le bord franchi sur des portefeuilles tires au hasard', () => {
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

        const intent = intentAt(state);
        if (intent.trigger === 'NONE') return true;

        const edge = intent.weightsBefore.USDC.lt(BAND.lower) ? BAND.lower : BAND.upper;

        return near(weightsAfter(state).USDC, edge);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('jambes du mode band_edge', () => {
  /*
   * Le cash remonte de 0.20 a 0.24, soit 4 000 USDC sur un total de 100 000 :
   * c'est la somme des deux ventes, et rien de plus. En mode `target` la meme
   * situation deplacerait 10 000 USDC. « Trade moins » est cette difference.
   */
  it('ne deplace que ce qui separe le cash du bord franchi', () => {
    const { legs } = intentAt(stateAt('0.45', '0.35', '0.20'));

    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toFixed(4)])).toEqual([
      ['BTC', 'SELL', '1571.4286'],
      ['ETH', 'SELL', '2428.5714'],
    ]);

    const moved = legs.reduce((acc, leg) => acc.plus(leg.amount), new Decimal(0));
    expect(moved.toFixed(4)).toBe('4000.0000');
  });

  /*
   * Cash au-dessus de sa bande et pourtant BTC, sous-pondere, s'achete. Un code
   * qui deduirait le sens des jambes du cote de bande franchi passerait les deux
   * tests de bord et echouerait ici.
   */
  it('achete ou vend ligne par ligne, quel que soit le cote de bande franchi', () => {
    const { legs } = intentAt(stateAt('0.30', '0.30', '0.40'));

    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toFixed(4)])).toEqual([
      ['BTC', 'BUY', '6571.4286'],
      ['ETH', 'SELL', '2571.4286'],
    ]);
  });

  it('cote les jambes en USDC, dans le meme ordre fige qu en mode target', () => {
    const { legs } = intentAt(stateAt('0.30', '0.30', '0.40'));

    expect(legs.map((leg) => leg.asset)).toEqual(['BTC', 'ETH']);
    expect(legs.map((leg) => leg.quote)).toEqual(['USDC', 'USDC']);
    expect(legs.map((leg) => leg.limitPrice.toString())).toEqual(['50000', '2500']);
  });
});

describe('intention en mode band_edge', () => {
  /*
   * `weightsTarget` part dans `decisions` et s'affiche face aux poids constates.
   * Y journaliser 30 % pendant que les jambes menent a 24 % rendrait le rapport
   * faux sur le seul chiffre qu'on y lit.
   */
  it('journalise le bord franchi comme cible du run, pas la cible permanente', () => {
    const below = intentAt(stateAt('0.45', '0.35', '0.20'));
    const above = intentAt(stateAt('0.30', '0.30', '0.40'));

    expect(below.weightsTarget.USDC.toString()).toBe('0.24');
    expect(below.weightsTarget.BTC.toFixed(8)).toBe('0.43428571');
    expect(below.weightsTarget.ETH.toFixed(8)).toBe('0.32571429');

    expect(above.weightsTarget.USDC.toString()).toBe('0.36');
    expect(above.weightsTarget.BTC.toFixed(8)).toBe('0.36571429');
    expect(above.weightsTarget.ETH.toFixed(8)).toBe('0.27428571');
  });

  /*
   * Hors declenchement il n'y a pas de bord franchi : rien n'est vise, et c'est
   * la cible permanente qui ressort. La bande, elle, ne depend pas du mode.
   */
  it('ne tire pas dans la bande et journalise alors la cible permanente', () => {
    const intent = intentAt(stateAt('0.40', '0.36', '0.24'));

    expect(intent.trigger).toBe('NONE');
    expect(intent.legs).toEqual([]);
    expect(intent.weightsTarget.USDC.toString()).toBe('0.3');
    expect(intent.weightsTarget.BTC.toString()).toBe('0.4');
  });

  /* C30 exige une sortie de rejeu identique octet pour octet : format fige. */
  it('explique le declenchement en clair, a format fige', () => {
    expect(intentAt(stateAt('0.45', '0.35', '0.20')).reason).toBe(
      'poids USDC 0.200000 sous la borne basse 0.240000 : retour a cette borne',
    );
    expect(intentAt(stateAt('0.30', '0.30', '0.40')).reason).toBe(
      'poids USDC 0.400000 au-dessus de la borne haute 0.360000 : retour a cette borne',
    );
    expect(intentAt(stateAt('0.40', '0.30', '0.30')).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000] : aucun reequilibrage',
    );
  });

  /* C23 : memes etat, horloge et parametres donnent les memes jambes, dans le meme ordre. */
  it('rend deux fois la meme intention sur le meme etat', () => {
    const state = stateAt('0.30', '0.30', '0.40');
    const render = (legs: readonly IntentLeg[]) =>
      legs.map((leg) => [leg.asset, leg.side, leg.amount.toString()]);

    expect(render(intentAt(state).legs)).toEqual(render(intentAt(state).legs));
  });
});

/*
 * Le solde hors cash se repartit au prorata des cibles BTC et ETH : une
 * allocation entierement en cash rend ce prorata indefini. `Decimal.div` sur
 * 0 / 0 rend NaN, et `Decimal.gt` repond false sur un NaN : sans ce refus, les
 * jambes sortiraient a NaN sans qu'aucune comparaison ne morde, exactement le
 * chemin silencieux que `portfolio.ts` ferme sur la valeur totale.
 */
describe('parametres degeneres propres au mode', () => {
  const ALL_CASH = {
    BTC: weight('0'),
    ETH: weight('0'),
    USDC: weight('1'),
  };

  it('refuse une allocation entierement en cash en mode band_edge', () => {
    const params: RebalanceParams = { ...BAND_EDGE, targets: ALL_CASH };
    const decision = undecidable(decide(stateAt('0.40', '0.30', '0.30'), CLOCK, params));

    expect(decision.code).toBe('INVALID_PARAMS');
    expect(decision.reason).toContain('band_edge');
  });

  /* La meme allocation reste licite en mode target, ou les cibles servent telles quelles. */
  it('laisse passer la meme allocation en mode target', () => {
    const params: RebalanceParams = { ...DEFAULT_REBALANCE_PARAMS, targets: ALL_CASH };

    expect(decide(stateAt('0.40', '0.30', '0.30'), CLOCK, params).status).toBe('DECIDED');
  });
});
