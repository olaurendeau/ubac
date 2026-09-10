import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { REBALANCE_CONFIGS } from '../../src/core/config.js';
import type { Holdings, Prices } from '../../src/core/portfolio.js';
import { valuate } from '../../src/core/portfolio.js';
import type {
  Decision,
  RebalanceParams,
  RebalanceState,
} from '../../src/core/strategy/rebalance.js';
import { DEFAULT_REBALANCE_PARAMS, decide, ratioBand } from '../../src/core/strategy/rebalance.js';
import type { Clock, IntentLeg, IsoDate, Price, Quantity, Weight } from '../../src/core/types.js';

const price = (value: string): Price => new Decimal(value) as Price;
const weight = (value: string): Weight => new Decimal(value) as Weight;

/** La tolerance de C4, reprise ici pour « cash inchange » et « ratio remis sur sa cible ». */
const TOLERANCE = new Decimal('1e-8');

const RUN_DATE: IsoDate = '2026-03-14';
const CLOCK: Clock = { today: () => RUN_DATE };

/** Memes prix ronds qu'aux etapes 10 et 11 : les poids vises tombent juste. */
const BTC_PRICE = price('50000');
const ETH_PRICE = price('2500');
const PRICES: Prices = { BTC: BTC_PRICE, ETH: ETH_PRICE };

const PROD = REBALANCE_CONFIGS.rebalance;
const SHADOW = REBALANCE_CONFIGS.rebalance_ab;

const RATIO_BAND = ratioBand(SHADOW);

/**
 * Le declencheur B raisonne sur un quotient d'expositions : les construire
 * directement en USDC dit ce que le test veut dire, la ou passer par des poids
 * obligerait a resoudre `crypto x r / (1 + r)` a la main a chaque cas.
 */
function stateAt(btc: Decimal | string, eth: Decimal | string, usdc: Decimal | string) {
  return {
    holdings: {
      BTC: new Decimal(btc).div(BTC_PRICE) as Quantity,
      ETH: new Decimal(eth).div(ETH_PRICE) as Quantity,
      USDC: new Decimal(usdc) as Quantity,
    },
    prices: PRICES,
  } satisfies RebalanceState;
}

/**
 * Portefeuille de 100 000 USDC dont les lignes crypto realisent le ratio
 * demande. Le cash vaut 30 000 par defaut, soit 30 % : au milieu de la bande de
 * A, seule position ou B est seul en cause. Le sortir de cette bande met les
 * deux declencheurs hors bande en meme temps, ce que mesure la section C10.
 */
const TOTAL = new Decimal('100000');
const CASH = new Decimal('30000');

function stateAtRatio(ratio: Decimal | string, cash: Decimal | string = CASH): RebalanceState {
  const r = new Decimal(ratio);
  const crypto = TOTAL.minus(cash);

  return stateAt(crypto.mul(r).div(r.plus(1)), crypto.div(r.plus(1)), cash);
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

const intentAt = (state: RebalanceState, params: RebalanceParams = SHADOW) =>
  decided(decide(state, CLOCK, params)).intent;

/** Rejoue les jambes sur les soldes, comme le ferait une execution parfaite. */
function applyLegs(state: RebalanceState, legs: readonly IntentLeg[]): Holdings {
  const holdings: Record<'BTC' | 'ETH' | 'USDC', Decimal> = { ...state.holdings };

  for (const leg of legs) {
    if (leg.asset !== 'BTC' && leg.asset !== 'ETH') {
      throw new Error(`jambe sur ${leg.asset} : B n'arbitre que BTC contre ETH`);
    }

    const sign = leg.side === 'BUY' ? 1 : -1;

    holdings[leg.asset] = holdings[leg.asset].plus(leg.amount.div(leg.limitPrice).mul(sign));
    holdings.USDC = holdings.USDC.minus(leg.amount.mul(sign));
  }

  return holdings as Holdings;
}

/** Poids obtenus une fois les jambes executees. */
function weightsAfter(state: RebalanceState, params: RebalanceParams = SHADOW) {
  const after = valuate(applyLegs(state, intentAt(state, params).legs), state.prices);
  if (after.status !== 'VALUED') throw new Error(`portefeuille non valorisable : ${after.code}`);

  return after.weights;
}

const near = (actual: Decimal, expected: Decimal | string): boolean =>
  actual.minus(expected).abs().lte(TOLERANCE);

/** Les 251 ratios de 0.5 a 3.0 par pas de 0.01, bornes comprises. */
const SWEEP: readonly Decimal[] = Array.from({ length: 251 }, (_, step) =>
  new Decimal('0.5').plus(new Decimal(step).div(100)),
);

// --- C13 --------------------------------------------------------------------

/*
 * Le drapeau est le seul sujet de C13, et son defaut est ce qui se casse en
 * silence : un `ratioBandEnabled` a vrai par defaut ferait entrer en production
 * un declencheur que le cadrage a explicitement renvoye en shadow, sans qu'une
 * seule ligne de configuration ne change. Le balayage ci-dessous est la seule
 * chose qui rattrape cette erreur.
 */
describe('C13 : le drapeau ratioBandEnabled', () => {
  it('vaut false dans les defauts et sur la configuration de production', () => {
    expect(DEFAULT_REBALANCE_PARAMS.ratioBandEnabled).toBe(false);
    expect(PROD.ratioBandEnabled).toBe(false);
  });

  it("n'est arme que sur la configuration shadow rebalance_ab", () => {
    expect(SHADOW.ratioBandEnabled).toBe(true);
    expect(SHADOW.strategy).toBe('rebalance_ab');
    expect(PROD.strategy).toBe('rebalance');
  });

  it('ne produit jamais de jambe sur la configuration rebalance, de 0.5 a 3.0', () => {
    for (const ratio of SWEEP) {
      const intent = intentAt(stateAtRatio(ratio), PROD);

      expect({ ratio: ratio.toFixed(2), trigger: intent.trigger, legs: intent.legs.length }).toEqual(
        { ratio: ratio.toFixed(2), trigger: 'NONE', legs: 0 },
      );
    }
  });

  /*
   * L'autre moitie de C13. Sans elle, un balayage qui ne traverserait aucune
   * borne passerait le test precedent en ne prouvant rien : ce sont les memes
   * 251 ratios qui doivent tirer une fois le drapeau arme.
   */
  it('en produit sur rebalance_ab, exactement hors de la bande', () => {
    const fired = SWEEP.filter((ratio) => intentAt(stateAtRatio(ratio), SHADOW).trigger !== 'NONE');
    const outside = SWEEP.filter(
      (ratio) => ratio.lt(RATIO_BAND.lower) || ratio.gt(RATIO_BAND.upper),
    );

    expect(fired.map((ratio) => ratio.toFixed(2))).toEqual(outside.map((ratio) => ratio.toFixed(2)));
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.length).toBeLessThan(SWEEP.length);
  });

  it('journalise RATIO_BAND et le nom de la strategie shadow', () => {
    const intent = intentAt(stateAtRatio('3.0'));

    expect(intent.trigger).toBe('RATIO_BAND');
    expect(intent.strategy).toBe('rebalance_ab');
    expect(intent.runDate).toBe(RUN_DATE);
  });
});

// --- C10 : A l'emporte sur B ------------------------------------------------

/*
 * L'ordre des deux declencheurs est ecrit dans ce module depuis qu'il connait
 * B : A est evalue en premier et B n'est meme pas regarde quand A tire. Tant
 * que tous les etats du fichier posent le cash a 30 %, au milieu de la bande de
 * A, cette priorite n'est affirmee que par un commentaire — inverser les deux
 * blocs laisse la campagne verte. D'ou ces cas, ou les deux bandes sont
 * franchies en meme temps : c'est le seul endroit ou la priorite se mesure.
 *
 * Le cooldown propre a B (C12) et le cas A dedans / B dehors (C11) restent a
 * l'etape 13.
 */
describe('C10 : A et B hors bande en meme temps', () => {
  /** Cash a 10 % et a 45 %, donc de part et d'autre de `[0.24, 0.36]`. */
  const CASH_BELOW = new Decimal('10000');
  const CASH_ABOVE = new Decimal('45000');

  /** Ratios franchement dehors dans chaque sens, hors de `[0.93, 1.73]`. */
  const BOTH_OUT = [
    [CASH_BELOW, '3.0'],
    [CASH_ABOVE, '0.5'],
  ] as const;

  it('retourne CASH_BAND et non RATIO_BAND, dans les deux sens', () => {
    for (const [cash, ratio] of BOTH_OUT) {
      expect(intentAt(stateAtRatio(ratio, cash)).trigger).toBe('CASH_BAND');
    }
  });

  /*
   * 67 500 de BTC contre 22 500 d'ETH et 10 000 de cash. Les jambes de A menent
   * a la cible complete : vente de 27 500 sur BTC, achat de 7 500 sur ETH, et
   * les 20 000 d'ecart remontent le cash de 10 % a 30 %. Une jambe de B ajoutee
   * par-dessus, ou substituee, se compenserait a cash constant et laisserait le
   * portefeuille a 10 % de cash, c'est-a-dire hors de la bande qui a tire.
   */
  it('ne produit que les jambes de A, sans arbitrage BTC contre ETH separe', () => {
    const state = stateAtRatio('3.0', CASH_BELOW);
    const { legs } = intentAt(state);

    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toFixed(4)])).toEqual([
      ['BTC', 'SELL', '27500.0000'],
      ['ETH', 'BUY', '7500.0000'],
    ]);

    const after = weightsAfter(state);

    expect(near(after.USDC, '0.30')).toBe(true);
    expect(near(after.BTC, '0.40')).toBe(true);
    expect(near(after.ETH, '0.30')).toBe(true);
  });

  /*
   * La formulation la plus directe de « B n'est pas evalue » : drapeau arme ou
   * baisse, le run est le meme a son nom de strategie pres. Jambes, trigger,
   * poids vises et motif compris.
   */
  it('decide exactement comme la production, au nom de strategie pres', () => {
    for (const [cash, ratio] of BOTH_OUT) {
      const state = stateAtRatio(ratio, cash);

      expect({ ...intentAt(state, SHADOW), strategy: PROD.strategy }).toEqual(
        intentAt(state, PROD),
      );
    }
  });

  /* Le motif part dans `decisions` : il ne doit pas parler d'une bande sautee. */
  it('ne mentionne pas la bande de ratio dans le motif', () => {
    expect(intentAt(stateAtRatio('3.0', CASH_BELOW)).reason).toBe(
      'poids USDC 0.100000 sous la borne basse 0.240000 : retour a la cible',
    );
    expect(intentAt(stateAtRatio('0.5', CASH_ABOVE)).reason).toBe(
      'poids USDC 0.450000 au-dessus de la borne haute 0.360000 : retour a la cible',
    );
  });

  /*
   * La raison invoquee pour sauter B : le reequilibrage de A remet deja le ratio
   * sur sa cible. Elle doit rester vraie en `band_edge`, ou seul le cash s'arrete
   * au bord franchi tandis que le solde se repartit au prorata des cibles. Si
   * elle cessait de l'etre, sauter B laisserait le ratio dehors sans personne
   * pour le rattraper.
   */
  it('remet le ratio sur sa cible dans les deux modes, ce qui justifie de sauter B', () => {
    for (const rebalanceMode of ['target', 'band_edge'] as const) {
      for (const [cash, ratio] of BOTH_OUT) {
        const after = weightsAfter(stateAtRatio(ratio, cash), { ...SHADOW, rebalanceMode });

        expect(near(after.BTC.div(after.ETH), RATIO_BAND.target)).toBe(true);
      }
    }
  });

  /*
   * Les memes 251 ratios que C13, cash hors bande cette fois. Le balayage dit
   * que la priorite ne tient pas a la valeur du ratio : elle tient a ce que A
   * soit dehors, dedans ou dehors pour B.
   */
  it('ne laisse jamais B prendre la main, de 0.5 a 3.0', () => {
    for (const cash of [CASH_BELOW, CASH_ABOVE]) {
      for (const ratio of SWEEP) {
        const state = stateAtRatio(ratio, cash);
        const intent = intentAt(state, SHADOW);
        const seen = { cash: cash.toFixed(0), ratio: ratio.toFixed(2), trigger: intent.trigger };

        expect(seen).toEqual({ ...seen, trigger: 'CASH_BAND' });
        expect(intent.legs).toEqual(intentAt(state, PROD).legs);
      }
    }
  });
});

// --- La bande de ratio ------------------------------------------------------

describe('bande du ratio BTC/ETH', () => {
  /* Les `0.93 - 1.73` du §5.2, a l'ecart relatif de 30 % autour de 40/30. */
  it('encadre la cible 4/3 a plus ou moins 30 %', () => {
    expect(RATIO_BAND.target.toFixed(6)).toBe('1.333333');
    expect(RATIO_BAND.lower.toFixed(6)).toBe('0.933333');
    expect(RATIO_BAND.upper.toFixed(6)).toBe('1.733333');
  });

  /*
   * Bornes incluses, comme celles du cash : on tire strictement dehors. La cible
   * par defaut est 4/3, qui n'a pas d'ecriture decimale finie — ses bornes ne
   * sont donc atteignables qu'a un arrondi pres, et un test de borne a un
   * arrondi pres ne teste pas la borne. D'ou une cible de ratio a 2 pile, dont
   * la bande a plus ou moins 25 % tombe exactement sur [1.5, 2.5].
   */
  const EXACT: RebalanceParams = {
    ...SHADOW,
    targets: { BTC: weight('0.40'), ETH: weight('0.20'), USDC: weight('0.40') },
    ratioBandRelative: new Decimal('0.25'),
  };

  it('tombe sur des bornes exactes avec la cible de ratio a 2', () => {
    expect(ratioBand(EXACT).lower.toString()).toBe('1.5');
    expect(ratioBand(EXACT).upper.toString()).toBe('2.5');
  });

  it('ne tire pas sur les bornes elles-memes', () => {
    expect(intentAt(stateAt('36000', '24000', '40000'), EXACT).trigger).toBe('NONE');
    expect(intentAt(stateAt('40000', '16000', '44000'), EXACT).trigger).toBe('NONE');
  });

  it('tire juste au-dela des bornes', () => {
    expect(intentAt(stateAt('35990', '24010', '40000'), EXACT).trigger).toBe('RATIO_BAND');
    expect(intentAt(stateAt('40010', '15990', '44000'), EXACT).trigger).toBe('RATIO_BAND');
  });
});

// --- Les jambes -------------------------------------------------------------

describe('jambes BTC contre ETH, a cash constant', () => {
  /*
   * 52 500 de BTC contre 17 500 d'ETH, soit un ratio de 3. La cible 40/30
   * ramene les deux lignes a 40 000 et 30 000 : une vente de 12 500 sur BTC, un
   * achat du meme montant sur ETH. Le cash ne bouge pas d'un USDC — c'est le
   * « ligne cash inchangee » du §5.2, et c'est ce qui distingue B de A.
   */
  it('vend le surpondere et achete le sous-pondere du meme montant', () => {
    const { legs } = intentAt(stateAtRatio('3.0'));

    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toFixed(4)])).toEqual([
      ['BTC', 'SELL', '12500.0000'],
      ['ETH', 'BUY', '12500.0000'],
    ]);
  });

  it('inverse les deux sens quand c est ETH qui est surpondere', () => {
    const { legs } = intentAt(stateAtRatio('0.5'));

    expect(legs.map((leg) => [leg.asset, leg.side, leg.amount.toFixed(4)])).toEqual([
      ['BTC', 'BUY', '16666.6667'],
      ['ETH', 'SELL', '16666.6667'],
    ]);
  });

  it('cote les jambes en USDC, dans le meme ordre fige que le declencheur A', () => {
    const { legs } = intentAt(stateAtRatio('3.0'));

    expect(legs.map((leg) => leg.asset)).toEqual(['BTC', 'ETH']);
    expect(legs.map((leg) => leg.quote)).toEqual(['USDC', 'USDC']);
    expect(legs.map((leg) => leg.limitPrice.toString())).toEqual(['50000', '2500']);
  });

  /*
   * Le cash varie d'un cas a l'autre, et jamais seulement a 30 % : une
   * implementation qui repartirait le poids crypto **cible** de 70 % au lieu du
   * poids crypto constate laisserait le cash constant sur un portefeuille pile
   * a sa cible, et sur lui seul.
   */
  it('remet le ratio sur sa cible et laisse le cash ou il est', () => {
    const cases = [
      ['0.5', '0.30'],
      ['0.9', '0.24'],
      ['1.8', '0.36'],
      ['3.0', '0.2777'],
    ] as const;

    for (const [ratio, cash] of cases) {
      const crypto = new Decimal(1).minus(cash).mul(100_000);
      const r = new Decimal(ratio);
      const state = stateAt(
        crypto.mul(r).div(r.plus(1)),
        crypto.div(r.plus(1)),
        new Decimal(cash).mul(100_000),
      );

      const before = intentAt(state).weightsBefore;
      const after = weightsAfter(state);

      expect(intentAt(state).trigger).toBe('RATIO_BAND');
      expect(near(after.BTC.div(after.ETH), RATIO_BAND.target)).toBe(true);
      expect(near(after.USDC, before.USDC)).toBe(true);
      expect(near(after.USDC, cash)).toBe(true);
    }
  });

  /*
   * Le balayage fixe le cash a 30 %. Le tirage aleatoire le promene dans toute
   * la bande de A et sur des expositions a vingt chiffres significatifs : c'est
   * la que se verrait une jambe de cash oubliee, qui ne se voit pas quand les
   * deux jambes crypto se compensent sur un portefeuille rond.
   */
  it('laisse le cash constant sur des portefeuilles tires au hasard', () => {
    const exposure = fc.integer({ min: 0, max: 10_000_000 });
    let fired = 0;

    fc.assert(
      fc.property(exposure, exposure, exposure, (btc, eth, usdc) => {
        fc.pre(btc + eth + usdc > 0);

        const state = stateAt(String(btc), String(eth), String(usdc));
        const intent = intentAt(state);

        /* Hors run de B il n'y a rien a constater : A a tire, ou personne. */
        if (intent.trigger !== 'RATIO_BAND') return true;

        fired += 1;

        const after = weightsAfter(state);

        return (
          near(after.USDC, intent.weightsBefore.USDC) &&
          near(after.BTC.div(after.ETH), RATIO_BAND.target)
        );
      }),
      { numRuns: 1000 },
    );

    /* Une propriete qui ne rencontre jamais son cas ne prouve rien. */
    expect(fired).toBeGreaterThan(0);
  });

  /*
   * `weightsTarget` part dans `decisions` et s'affiche face aux poids constates.
   * Sur un run de B, le poids USDC vise est celui qu'on a deja : y journaliser
   * la cible permanente de 30 % ferait lire un mouvement de cash qui n'a pas eu
   * lieu.
   */
  it('journalise comme cible du run le cash constate, pas la cible permanente', () => {
    const intent = intentAt(stateAt('52800', '13200', '34000'));

    expect(intent.trigger).toBe('RATIO_BAND');
    expect(intent.weightsTarget.USDC.toFixed(8)).toBe('0.34000000');
    expect(intent.weightsBefore.USDC.toFixed(8)).toBe('0.34000000');
    expect(intent.weightsTarget.BTC.plus(intent.weightsTarget.ETH).toFixed(8)).toBe('0.66000000');
  });
});

// --- Mode band_edge ---------------------------------------------------------

/*
 * Le mode s'applique aux deux declencheurs. Le laisser sur la cible pour B
 * pendant que A se pose sur le bord franchi ferait trader B davantage que A
 * dans le mode qui est cense trader moins, sans qu'aucun test de A ne bronche.
 */
describe('declencheur B en mode band_edge', () => {
  const BAND_EDGE: RebalanceParams = { ...SHADOW, rebalanceMode: 'band_edge' };

  it('se pose sur le bord franchi et non sur la cible, dans les deux sens', () => {
    for (const [ratio, edge] of [
      ['3.0', RATIO_BAND.upper],
      ['0.5', RATIO_BAND.lower],
    ] as const) {
      const after = weightsAfter(stateAtRatio(ratio), BAND_EDGE);

      expect(near(after.BTC.div(after.ETH), edge)).toBe(true);
      expect(near(after.BTC.div(after.ETH), RATIO_BAND.target)).toBe(false);
    }
  });

  it('deplace moins que le mode target sur le meme etat', () => {
    const state = stateAtRatio('3.0');
    const moved = (params: RebalanceParams) =>
      intentAt(state, params).legs.reduce((acc, leg) => acc.plus(leg.amount), new Decimal(0));

    expect(moved(BAND_EDGE).toFixed(4)).toBe('16219.5122');
    expect(moved(SHADOW).toFixed(4)).toBe('25000.0000');
  });

  it('laisse le cash constant lui aussi', () => {
    const state = stateAtRatio('3.0');
    const before = intentAt(state, BAND_EDGE).weightsBefore;

    expect(near(weightsAfter(state, BAND_EDGE).USDC, before.USDC)).toBe(true);
  });
});

// --- Ratios degeneres -------------------------------------------------------

describe('ratios que la division ne definit pas', () => {
  /*
   * Plus d'ETH du tout : `Decimal.div` rend l'infini, qui est un vrai
   * depassement de borne haute. C'est meme le cas ou B sert le plus, et le
   * traiter comme une erreur laisserait le portefeuille sur une seule ligne
   * crypto indefiniment.
   */
  it('tire et rachete de l ETH quand la ligne ETH est vide', () => {
    const intent = intentAt(stateAt('70000', '0', '30000'));

    expect(intent.trigger).toBe('RATIO_BAND');
    expect(intent.legs.map((leg) => [leg.asset, leg.side, leg.amount.toFixed(4)])).toEqual([
      ['BTC', 'SELL', '30000.0000'],
      ['ETH', 'BUY', '30000.0000'],
    ]);
  });

  /*
   * Ni BTC ni ETH : le ratio est `0 / 0`, donc NaN, et `Decimal.lt` comme
   * `Decimal.gt` repondent false dessus. Sans branche explicite le cas
   * ressortirait « dans la bande » avec un NaN imprime dans le motif.
   *
   * Sous la bande de cash de production il est hors d'atteinte — un portefeuille
   * sans crypto est a 100 % de cash, donc A tire d'abord — d'ou la bande de cash
   * elargie ici, qui est la seule facon d'y arriver et donc de le tester.
   */
  it('ne tire pas et le dit quand il n y a ni BTC ni ETH', () => {
    const wide: RebalanceParams = { ...SHADOW, cashBandRelative: new Decimal('2.5') };
    const intent = intentAt(stateAt('0', '0', '100000'), wide);

    expect(intent.trigger).toBe('NONE');
    expect(intent.legs).toEqual([]);
    expect(intent.reason).toContain('ratio BTC/ETH indefini, aucune ligne BTC ni ETH');
  });
});

// --- Parametres degeneres ---------------------------------------------------

describe('parametres degeneres du declencheur B', () => {
  const withRatioTargets = (btc: string, eth: string, usdc: string, params: RebalanceParams) => ({
    ...params,
    targets: { BTC: weight(btc), ETH: weight(eth), USDC: weight(usdc) },
  });

  const NOMINAL = stateAtRatio('1.333333333333333');

  it('refuse un ecart relatif negatif, qui inverserait les bornes', () => {
    const params: RebalanceParams = { ...SHADOW, ratioBandRelative: new Decimal('-0.30') };

    expect(undecidable(decide(NOMINAL, CLOCK, params)).code).toBe('INVALID_PARAMS');
  });

  /*
   * A 100 % d'ecart la borne basse tombe a zero, et au-dela elle passe negative.
   * Le mode `band_edge` viserait alors un ratio nul ou negatif, c'est-a-dire une
   * ligne BTC negative ; a -1 pile, `1 + ratio` diviserait par zero et les poids
   * vises sortiraient infinis.
   */
  it('refuse un ecart relatif qui rend la borne basse nulle', () => {
    const params: RebalanceParams = { ...SHADOW, ratioBandRelative: new Decimal('1') };
    const decision = undecidable(decide(NOMINAL, CLOCK, params));

    expect(decision.code).toBe('INVALID_PARAMS');
    expect(decision.reason).toContain('bande de ratio BTC/ETH [0,');
  });

  it('refuse une cible ETH nulle, qui rend le ratio cible infini', () => {
    const params = withRatioTargets('0.70', '0', '0.30', SHADOW);

    expect(undecidable(decide(NOMINAL, CLOCK, params)).code).toBe('INVALID_PARAMS');
  });

  it('refuse une cible BTC nulle, qui reduit la bande a un point', () => {
    const params = withRatioTargets('0', '0.70', '0.30', SHADOW);

    expect(undecidable(decide(NOMINAL, CLOCK, params)).code).toBe('INVALID_PARAMS');
  });

  /*
   * Les memes parametres sont licites drapeau baisse. Une configuration de
   * production qui n'evalue jamais le ratio n'a pas a etre refusee sur une
   * bande dont elle ne se sert pas.
   */
  it('laisse passer les memes parametres quand le drapeau est baisse', () => {
    expect(
      decide(NOMINAL, CLOCK, { ...PROD, ratioBandRelative: new Decimal('1') }).status,
    ).toBe('DECIDED');
    expect(decide(NOMINAL, CLOCK, withRatioTargets('0.70', '0', '0.30', PROD)).status).toBe(
      'DECIDED',
    );
  });
});

// --- Motif journalise -------------------------------------------------------

/*
 * C30 exige une sortie de rejeu identique octet pour octet : le format est fige
 * ici pour qu'un changement soit un acte conscient. Le constat de cash reste en
 * tete, inchange, et celui du ratio s'ajoute derriere lui dans l'ordre ou les
 * deux bandes sont evaluees.
 */
describe('motif journalise quand B est arme', () => {
  it('rend compte des deux bandes, a format fige', () => {
    expect(intentAt(stateAtRatio('3.0')).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000]' +
        ' ; ratio BTC/ETH 3.000000 au-dessus de la borne haute 1.733333 : retour a la cible',
    );
    expect(intentAt(stateAtRatio('0.5')).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000]' +
        ' ; ratio BTC/ETH 0.500000 sous la borne basse 0.933333 : retour a la cible',
    );
    expect(intentAt(stateAt('40000', '30000', '30000')).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000]' +
        ' ; ratio BTC/ETH 1.333333 dans la bande [0.933333, 1.733333] : aucun reequilibrage',
    );
  });

  it('designe la borne franchie en mode band_edge', () => {
    const params: RebalanceParams = { ...SHADOW, rebalanceMode: 'band_edge' };

    expect(intentAt(stateAtRatio('3.0'), params).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000]' +
        ' ; ratio BTC/ETH 3.000000 au-dessus de la borne haute 1.733333 : retour a cette borne',
    );
  });

  /* Drapeau baisse, le motif ne parle pas d'une bande qui n'a pas ete regardee. */
  it('ne mentionne pas le ratio sur la configuration de production', () => {
    expect(intentAt(stateAtRatio('3.0'), PROD).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000] : aucun reequilibrage',
    );
  });
});
