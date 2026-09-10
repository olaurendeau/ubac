import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { REBALANCE_CONFIGS } from '../../src/core/config.js';
import type { Prices } from '../../src/core/portfolio.js';
import type {
  Decision,
  RebalanceParams,
  RebalanceState,
} from '../../src/core/strategy/rebalance.js';
import { decide } from '../../src/core/strategy/rebalance.js';
import type {
  CashFlow,
  Clock,
  IsoDate,
  Price,
  Quantity,
  UsdcAmount,
} from '../../src/core/types.js';

/**
 * La carence de 7 jours sur les apports (§5.4) : ce qu'elle gele, jusqu'a quand,
 * et ce qu'elle ne gele pas.
 *
 * Les deux criteres tiennent sur une seule borne et un seul mot. La borne est
 * exclusive — « jusqu'a J+7 exclu, le run de J+7 n'est plus gele » — donc un
 * `<=` a la place d'un `<` decale le degel d'un jour et seul le run a exactement
 * sept jours le voit. Le mot est « positif » : un retrait retire du cash, il n'en
 * pose pas a investir, et il ne gele rien.
 *
 * Les intervalles sont ecrits en dates litterales, jamais calcules : le sujet est
 * l'arithmetique des dates, et la refaire dans le test reviendrait a la comparer
 * a elle-meme.
 */

const price = (value: string): Price => new Decimal(value) as Price;

const BTC_PRICE = price('50000');
const ETH_PRICE = price('2500');
const PRICES: Prices = { BTC: BTC_PRICE, ETH: ETH_PRICE };

const PROD = REBALANCE_CONFIGS.rebalance;
const SHADOW = REBALANCE_CONFIGS.rebalance_ab;

const TOTAL = new Decimal('100000');

const clockAt = (date: IsoDate): Clock => ({ today: () => date });

const flow = (occurredOn: IsoDate, amount: string): CashFlow => ({
  occurredOn,
  amount: new Decimal(amount) as UsdcAmount,
});

/** Un apport : montant strictement positif, le seul qui gele. */
const apport = (occurredOn: IsoDate, amount = '20000'): CashFlow => flow(occurredOn, amount);

/** Un retrait : montant negatif. Il ne gele rien, c'est tout le sujet de C25. */
const retrait = (occurredOn: IsoDate, amount = '-20000'): CashFlow => flow(occurredOn, amount);

/**
 * Portefeuille de 100 000 USDC realisant le poids de cash et le ratio BTC/ETH
 * demandes, plus l'historique de flux que `decide` doit lire. Meme construction
 * que `rebalance-ab.test.ts` : les deux bandes se pilotent separement, ce qui
 * est necessaire pour montrer que la carence en gele une et pas l'autre.
 */
function stateAt(
  cashWeight: Decimal | string,
  ratio: Decimal | string,
  cashFlows: readonly CashFlow[] = [],
  lastRatioRebalanceOn: IsoDate | null = null,
): RebalanceState {
  const crypto = TOTAL.mul(new Decimal(1).minus(cashWeight));
  const r = new Decimal(ratio);

  return {
    holdings: {
      BTC: crypto.mul(r).div(r.plus(1)).div(BTC_PRICE) as Quantity,
      ETH: crypto.div(r.plus(1)).div(ETH_PRICE) as Quantity,
      USDC: TOTAL.mul(cashWeight) as Quantity,
    },
    prices: PRICES,
    cashFlows,
    lastRatioRebalanceOn,
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

const intentAt = (state: RebalanceState, clock: Clock, params: RebalanceParams = PROD) =>
  decided(decide(state, clock, params)).intent;

/** Le couple qui resume un run : ce qui a tire, et combien de jambes en sortent. */
const outcome = (state: RebalanceState, clock: Clock, params: RebalanceParams = PROD) => {
  const intent = intentAt(state, clock, params);

  return { trigger: intent.trigger, legs: intent.legs.length };
};

const FIRED = { trigger: 'CASH_BAND', legs: 2 };
const IDLE = { trigger: 'NONE', legs: 0 };
const ARBITRATED = { trigger: 'RATIO_BAND', legs: 2 };

/**
 * Le poids de cash apres un apport : au-dessus de la bande, donc A veut vendre
 * du cash pour racheter du crypto. C'est exactement le run que la carence
 * existe pour empecher — investir la totalite de l'apport au prix du jour.
 */
const CASH_ABOVE = '0.45';
const CASH_BELOW = '0.10';
const CASH_INSIDE = '0.30';

const RATIO_INSIDE = '1.3333333333';
const RATIO_HIGH = '3.0';

// --- C25 --------------------------------------------------------------------

/*
 * « Un cash_flow positif a J gele le declencheur A jusqu'a J+7 exclu ; le run de
 * J+7 n'est plus gele. »
 */
describe('C25 : la carence de 7 jours sur les apports', () => {
  const APPORT_DAY: IsoDate = '2026-03-08';

  /** Les sept jours geles, J compris : J+0 a J+6. */
  const FROZEN_RUNS: readonly IsoDate[] = [
    '2026-03-08',
    '2026-03-09',
    '2026-03-10',
    '2026-03-11',
    '2026-03-12',
    '2026-03-13',
    '2026-03-14',
  ];

  it('gele A du jour de l apport jusqu au sixieme jour', () => {
    for (const day of FROZEN_RUNS) {
      const state = stateAt(CASH_ABOVE, RATIO_INSIDE, [apport(APPORT_DAY)]);

      expect({ day, ...outcome(state, clockAt(day)) }).toEqual({ day, ...IDLE });
    }
  });

  it('degele A au septieme jour', () => {
    expect(
      outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, [apport(APPORT_DAY)]), clockAt('2026-03-15')),
    ).toEqual(FIRED);
  });

  /*
   * La meme borne, promenee sur les discontinuites du calendrier. Chaque ligne
   * donne la date de l'apport, le run a 6 jours (gele) et le run a 7 jours
   * (degele). `Date.parse` reporterait le 2026-02-30 au 2 mars ; ces lignes sont
   * la pour qu'un tel report se voie.
   */
  const INTERVALS: readonly (readonly [IsoDate, IsoDate, IsoDate])[] = [
    /* Dans le mois. */
    ['2026-03-08', '2026-03-14', '2026-03-15'],
    /* Fevrier commun : le 6e jour tombe deja en mars. */
    ['2026-02-23', '2026-03-01', '2026-03-02'],
    /* Fevrier bissextile : le 6e jour est le 29, qui doit exister. */
    ['2024-02-23', '2024-02-29', '2024-03-01'],
    /* Changement d'annee. */
    ['2024-12-26', '2025-01-01', '2025-01-02'],
    /* 2000 est bissextile — regle des 400 ans. */
    ['2000-02-23', '2000-02-29', '2000-03-01'],
    /* 2100 ne l'est pas — regle des 100 ans. */
    ['2100-02-23', '2100-03-01', '2100-03-02'],
  ];

  it('tient la borne exclusive sur les discontinuites du calendrier', () => {
    for (const [on, sixDays, sevenDays] of INTERVALS) {
      const state = stateAt(CASH_ABOVE, RATIO_INSIDE, [apport(on)]);

      expect({ on, sixDays, ...outcome(state, clockAt(sixDays)) }).toEqual({
        on,
        sixDays,
        ...IDLE,
      });
      expect({ on, sevenDays, ...outcome(state, clockAt(sevenDays)) }).toEqual({
        on,
        sevenDays,
        ...FIRED,
      });
    }
  });

  it('laisse tirer bien au-dela de la carence', () => {
    expect(
      outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, [apport('2025-03-14')]), clockAt('2026-03-14')),
    ).toEqual(FIRED);
  });

  /*
   * C25 ne qualifie pas le sens du franchissement : un apport gele « le
   * declencheur A », pas sa moitie haute. Un apport pousse le cash vers le haut,
   * mais rien n'interdit qu'une hausse du crypto le repasse sous la bande dans
   * les sept jours, et le module ne se met pas a distinguer un cas que la spec
   * ne distingue pas.
   */
  it('gele les deux sens de franchissement de la bande', () => {
    for (const cash of [CASH_ABOVE, CASH_BELOW]) {
      const state = stateAt(cash, RATIO_INSIDE, [apport('2026-03-08')]);

      expect({ cash, ...outcome(state, clockAt('2026-03-14')) }).toEqual({ cash, ...IDLE });
      expect({ cash, ...outcome(state, clockAt('2026-03-15')) }).toEqual({ cash, ...FIRED });
    }
  });

  /*
   * « Un cash_flow positif. » Un retrait reduit le portefeuille, il ne pose pas
   * de cash a investir : rien a proteger, donc rien a geler. Un flux nul n'est
   * pas davantage un apport — et c'est le piege de decimal.js, dont
   * `isPositive()` repond vrai sur zero.
   */
  it('ne gele rien sur un retrait ni sur un flux nul', () => {
    for (const nonApport of [retrait('2026-03-14'), flow('2026-03-14', '0')]) {
      expect(
        outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, [nonApport]), clockAt('2026-03-14')),
      ).toEqual(FIRED);
    }
  });

  it('ne gele rien sans flux du tout', () => {
    expect(outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, []), clockAt('2026-03-14'))).toEqual(FIRED);

    const withoutField: RebalanceState = {
      holdings: stateAt(CASH_ABOVE, RATIO_INSIDE).holdings,
      prices: PRICES,
    };

    expect(outcome(withoutField, clockAt('2026-03-14'))).toEqual(FIRED);
  });

  /*
   * L'appelant passe l'historique tel qu'il le tient. C'est le module qui
   * designe l'apport qui compte — le plus recent — et sa reponse ne depend pas
   * de l'ordre de la liste, sans quoi C23 tomberait des que le rejeu changerait
   * de tri.
   */
  it('retient l apport le plus recent quel que soit l ordre de la liste', () => {
    const vieux = apport('2026-01-05');
    const recent = apport('2026-03-08');

    for (const flows of [
      [vieux, recent],
      [recent, vieux],
    ]) {
      expect(outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, flows), clockAt('2026-03-14'))).toEqual(
        IDLE,
      );
      expect(outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, flows), clockAt('2026-03-15'))).toEqual(
        FIRED,
      );
    }
  });

  /*
   * Un retrait posterieur a l'apport n'entre pas dans la comparaison : il ne
   * raccourcit pas la carence en cours, et il ne la prolonge pas non plus.
   */
  it('ignore un retrait plus recent que l apport', () => {
    const flows = [apport('2026-03-08'), retrait('2026-03-13')];

    expect(outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, flows), clockAt('2026-03-14'))).toEqual(IDLE);
    expect(outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, flows), clockAt('2026-03-15'))).toEqual(FIRED);
  });

  /*
   * Un apport date dans le futur du run est un etat incoherent que ce module ne
   * sait pas arbitrer. Il gele, par la meme comparaison que le cooldown de B :
   * ne pas trader est la reponse conservatrice.
   */
  it('gele sur un apport date apres le run', () => {
    expect(
      outcome(stateAt(CASH_ABOVE, RATIO_INSIDE, [apport('2026-04-01')]), clockAt('2026-03-14')),
    ).toEqual(IDLE);
  });

  /*
   * Le motif part dans `decisions`, que C30 exige identique octet pour octet
   * d'une execution a l'autre. Format fige, et il dit lequel des deux gardiens a
   * arrete le run.
   */
  it('journalise le constat de carence derriere celui de la bande franchie', () => {
    expect(
      intentAt(stateAt(CASH_ABOVE, RATIO_INSIDE, [apport('2026-03-08')]), clockAt('2026-03-14'))
        .reason,
    ).toBe(
      'poids USDC 0.450000 au-dessus de la borne haute 0.360000' +
        ' ; apport du 2026-03-08, 6 jours ecoules sur les 7 de carence' +
        ' : aucun reequilibrage',
    );
  });

  /*
   * La carence ne se prononce que sur un run qu'elle gele. Un poids de cash dans
   * sa bande n'a rien a dire d'un apport, et l'annoncer ferait lire une occasion
   * manquee la ou il n'y en avait aucune.
   */
  it('ne parle pas de carence quand A est dans sa bande', () => {
    expect(
      intentAt(stateAt(CASH_INSIDE, RATIO_INSIDE, [apport('2026-03-14')]), clockAt('2026-03-14'))
        .reason,
    ).not.toContain('carence');
  });

  /*
   * Un run gele reste un run sans reequilibrage comme les autres : il journalise
   * la cible permanente, pas une allocation visee qu'il n'a pas cherche a
   * atteindre.
   */
  it('journalise la cible permanente sur un run gele', () => {
    const intent = intentAt(
      stateAt(CASH_ABOVE, RATIO_INSIDE, [apport('2026-03-08')]),
      clockAt('2026-03-14'),
    );

    expect(intent.weightsTarget.BTC.toFixed(2)).toBe('0.40');
    expect(intent.weightsTarget.ETH.toFixed(2)).toBe('0.30');
    expect(intent.weightsTarget.USDC.toFixed(2)).toBe('0.30');
  });

  /*
   * Le seuil est un parametre, et `0` le desarme franchement : c'est la
   * politique `immediate` de la v2.0, sans enumeration a trois valeurs. Une
   * valeur negative ou fractionnaire, elle, ne se compare a rien de sense.
   */
  it('se desarme a 0 jour et refuse les seuils qui n en sont pas', () => {
    const immediate: RebalanceParams = { ...PROD, newCashFreezeDays: 0 };
    const state = stateAt(CASH_ABOVE, RATIO_INSIDE, [apport('2026-03-14')]);

    expect(outcome(state, clockAt('2026-03-14'), immediate)).toEqual(FIRED);

    for (const days of [-1, 0.5, Number.NaN]) {
      const params: RebalanceParams = { ...PROD, newCashFreezeDays: days };
      const decision = undecidable(decide(state, clockAt('2026-03-14'), params));

      expect(decision.code).toBe('INVALID_PARAMS');
      expect(decision.reason).toContain('carence sur apport');
    }
  });

  /*
   * Contrairement au cooldown de B, le seuil est controle sur toute
   * configuration : la carence porte sur A, que les deux configurations
   * evaluent, donc aucune ne peut se permettre un seuil qui n'en est pas un.
   */
  it('controle le seuil sur la configuration shadow aussi', () => {
    const params: RebalanceParams = { ...SHADOW, newCashFreezeDays: -1 };
    const state = stateAt(CASH_INSIDE, RATIO_INSIDE);
    const decision = undecidable(decide(state, clockAt('2026-03-14'), params));

    expect(decision.code).toBe('INVALID_PARAMS');
  });

  /*
   * Un flux illisible arrete le run au lieu d'etre saute : le sauter ferait
   * tirer A au lendemain d'un apport, c'est-a-dire exactement le run que la
   * carence existe pour empecher.
   */
  it('refuse une date de flux qui n existe pas au calendrier', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-03-00', '14/03/2026', '2026-3-14']) {
      const state = stateAt(CASH_ABOVE, RATIO_INSIDE, [apport(bad)]);
      const decision = undecidable(decide(state, clockAt('2026-03-14'), PROD));

      expect({ bad, code: decision.code }).toEqual({ bad, code: 'INVALID_DATE' });
      expect(decision.reason).toContain('flux de tresorerie');
    }
  });

  /*
   * Un montant non fini n'a pas de signe : `gt` repond false sur un NaN, donc le
   * flux passerait pour un retrait et ne gelerait rien. La date, elle, est
   * lisible : le refus a son propre code.
   */
  it('refuse un montant de flux non fini', () => {
    for (const amount of [Number.NaN, Infinity, -Infinity]) {
      const bad: CashFlow = {
        occurredOn: '2026-03-14',
        amount: new Decimal(amount) as UsdcAmount,
      };
      const state = stateAt(CASH_ABOVE, RATIO_INSIDE, [bad]);
      const decision = undecidable(decide(state, clockAt('2026-03-14'), PROD));

      expect(decision.code).toBe('INVALID_CASH_FLOW');
      expect(decision.reason).toContain('montant du flux du 2026-03-14');
    }
  });

  /* La valeur du §5.4, sur les deux configurations. Test de non-regression. */
  it('vaut 7 jours sur les deux configurations', () => {
    expect(PROD.newCashFreezeDays).toBe(7);
    expect(SHADOW.newCashFreezeDays).toBe(7);
  });
});

// --- C26 --------------------------------------------------------------------

/*
 * « Le gel de A ne gele pas B. »
 *
 * La raison est dimensionnelle, pas conventionnelle : B arbitre BTC contre ETH a
 * ligne cash inchangee, donc il ne peut pas investir l'apport que la carence
 * protege. L'arreter aussi ne protegerait rien et laisserait le ratio hors bande
 * pendant une semaine.
 *
 * C'est aussi ce qui donne a C11 sa lecture exacte. « B n'est evalue que lorsque
 * A est dans sa bande » et « B n'est evalue que si A ne tire pas » coincident
 * partout sauf ici, et le cadrage a retenu la seconde.
 */
describe('C26 : le gel de A ne gele pas B', () => {
  const FROZEN = [apport('2026-03-08')];
  const DURING: Clock = clockAt('2026-03-14');

  it('laisse B arbitrer alors que A est gele et hors bande', () => {
    expect(outcome(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN), DURING, SHADOW)).toEqual(ARBITRATED);
    expect(outcome(stateAt(CASH_BELOW, RATIO_HIGH, FROZEN), DURING, SHADOW)).toEqual(ARBITRATED);
  });

  /*
   * L'arbitrage de B pendant une carence ne touche pas au cash : c'est ce qui
   * rend C26 sans danger. Si une seule jambe deplacait la ligne USDC, le gel de
   * A serait contourne par B et la carence ne protegerait plus rien.
   */
  it('n investit pas l apport en arbitrant', () => {
    const intent = intentAt(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN), DURING, SHADOW);
    const net = intent.legs.reduce(
      (acc, leg) => (leg.side === 'BUY' ? acc.plus(leg.amount) : acc.minus(leg.amount)),
      new Decimal(0),
    );

    expect(intent.weightsTarget.USDC.eq(intent.weightsBefore.USDC)).toBe(true);
    expect(net.abs().lt('1e-6')).toBe(true);
  });

  /*
   * Le gel de A n'ouvre rien sur la production : B y est desarme, donc un run
   * gele reste un run sans jambe. C'est le temoin du test precedent.
   */
  it('ne fait rien tirer sur la configuration de production', () => {
    expect(outcome(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN), DURING, PROD)).toEqual(IDLE);
  });

  /*
   * Les deux compteurs restent independants : une carence en cours ne consomme
   * pas le cooldown de B et ne le remplace pas. B reste bloque par le sien, et
   * par lui seul.
   */
  it('ne dispense pas B de son propre cooldown', () => {
    expect(
      outcome(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN, '2026-03-13'), DURING, SHADOW),
    ).toEqual(IDLE);
    expect(
      outcome(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN, '2026-03-07'), DURING, SHADOW),
    ).toEqual(ARBITRATED);
  });

  /*
   * Le motif d'un run ou A est gele et B tire porte les trois constats, dans
   * l'ordre ou ils sont evalues : la bande de cash, la carence qui l'a arretee,
   * puis la bande de ratio.
   */
  it('journalise la carence puis le constat de ratio', () => {
    expect(intentAt(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN), DURING, SHADOW).reason).toBe(
      'poids USDC 0.450000 au-dessus de la borne haute 0.360000' +
        ' ; apport du 2026-03-08, 6 jours ecoules sur les 7 de carence' +
        ' ; ratio BTC/ETH 3.000000 au-dessus de la borne haute 1.733333' +
        ' : retour a la cible',
    );
  });

  /*
   * Une fois A degele, la priorite reprend ses droits : A tire, et B n'est plus
   * evalue du tout. La carence deplace le moment ou A tire, pas l'ordre des deux
   * declencheurs.
   */
  it('rend la main a A des le degel', () => {
    const intent = intentAt(stateAt(CASH_ABOVE, RATIO_HIGH, FROZEN), clockAt('2026-03-15'), SHADOW);

    expect({ trigger: intent.trigger, legs: intent.legs.length }).toEqual(FIRED);
    expect(intent.reason).not.toContain('ratio BTC/ETH');
    expect(intent.reason).not.toContain('carence');
  });
});
