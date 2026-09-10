import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { REBALANCE_CONFIGS } from '../../src/core/config.js';
import type { Prices } from '../../src/core/portfolio.js';
import type {
  Decision,
  RebalanceParams,
  RebalanceState,
} from '../../src/core/strategy/rebalance.js';
import { cashBand, decide, ratioBand } from '../../src/core/strategy/rebalance.js';
import type { Clock, IsoDate, Price, Quantity } from '../../src/core/types.js';

/**
 * L'interaction des deux declencheurs : qui l'emporte, quand l'autre est
 * regarde, et le compteur propre a B.
 *
 * Les jambes de chaque declencheur pris isolement sont mesurees ailleurs — A
 * dans `rebalance-a.test.ts`, B dans `rebalance-b.test.ts`. Ici, tout se joue
 * sur `trigger` et sur la presence ou non de jambes : c'est `trigger` qui part
 * dans `decisions` et qui compte les declenchements du rejeu, donc une valeur
 * fausse fausse la comparaison des strategies sans qu'aucun test de jambe ne
 * bronche.
 */

const price = (value: string): Price => new Decimal(value) as Price;

const BTC_PRICE = price('50000');
const ETH_PRICE = price('2500');
const PRICES: Prices = { BTC: BTC_PRICE, ETH: ETH_PRICE };

const PROD = REBALANCE_CONFIGS.rebalance;
const SHADOW = REBALANCE_CONFIGS.rebalance_ab;

const CASH_BAND = cashBand(SHADOW);
const RATIO_BAND = ratioBand(SHADOW);

const clockAt = (date: IsoDate): Clock => ({ today: () => date });

/** Un jour quelconque, quand la date du run n'est pas le sujet du test. */
const ANY_DAY = clockAt('2026-03-14');

const TOTAL = new Decimal('100000');

/**
 * Portefeuille de 100 000 USDC realisant le poids de cash et le ratio BTC/ETH
 * demandes. Les deux bandes se pilotent ainsi separement, ce qui est tout le
 * sujet : leurs quatre combinaisons dedans/dehors doivent etre atteignables.
 */
function stateAt(
  cashWeight: Decimal | string,
  ratio: Decimal | string,
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

const intentAt = (
  state: RebalanceState,
  clock: Clock = ANY_DAY,
  params: RebalanceParams = SHADOW,
) => decided(decide(state, clock, params)).intent;

/** Le couple qui resume un run : ce qui a tire, et combien de jambes en sortent. */
const outcome = (
  state: RebalanceState,
  clock: Clock = ANY_DAY,
  params: RebalanceParams = SHADOW,
) => {
  const intent = intentAt(state, clock, params);

  return { trigger: intent.trigger, legs: intent.legs.length };
};

/** Cash franchement dehors dans chaque sens, et pile au milieu de la bande. */
const CASH_BELOW = '0.10';
const CASH_INSIDE = '0.30';
const CASH_ABOVE = '0.45';

/** Ratios franchement hors de `[0.93, 1.73]`, et la cible 4/3 qui est dedans. */
const RATIO_HIGH = '3.0';
const RATIO_INSIDE = '1.3333333333';
const RATIO_LOW = '0.5';

// --- C10 --------------------------------------------------------------------

/*
 * « Quand A et B sont tous deux hors bande, le trigger retourne est CASH_BAND et
 * aucune jambe BTC<->ETH separee n'est produite. »
 *
 * L'erreur naturelle est de calculer les jambes de B puis de les jeter quand A
 * tire, en laissant `trigger` a `RATIO_BAND`. Elle ne se voit sur aucune jambe :
 * les jambes sont bien celles de A, seul le compteur du rejeu ment.
 */
describe('C10 : A et B hors bande, A l emporte', () => {
  const BOTH_OUT = [
    [CASH_BELOW, RATIO_HIGH],
    [CASH_BELOW, RATIO_LOW],
    [CASH_ABOVE, RATIO_HIGH],
    [CASH_ABOVE, RATIO_LOW],
  ] as const;

  it('retourne CASH_BAND et jamais RATIO_BAND', () => {
    for (const [cash, ratio] of BOTH_OUT) {
      expect({ cash, ratio, ...outcome(stateAt(cash, ratio)) }).toEqual({
        cash,
        ratio,
        trigger: 'CASH_BAND',
        legs: 2,
      });
    }
  });

  /*
   * Les deux jambes sont celles de A, au dernier chiffre pres : B n'ajoute
   * aucun arbitrage par-dessus et n'en substitue aucun. La configuration de
   * production, ou B n'existe pas, sert de temoin — elle produit exactement le
   * meme run, au nom de strategie pres.
   */
  it('ne produit que les jambes de A, sans arbitrage BTC contre ETH separe', () => {
    for (const [cash, ratio] of BOTH_OUT) {
      const state = stateAt(cash, ratio);

      expect({ ...intentAt(state), strategy: PROD.strategy }).toEqual(
        intentAt(state, ANY_DAY, PROD),
      );
    }
  });

  /*
   * A tire, et le cooldown de B n'y est pour rien : ni pour l'autoriser, ni
   * pour l'empecher. Le meme etat donne le meme run, que B ait arbitre la
   * veille ou jamais.
   */
  it('tire quel que soit l etat du cooldown de B', () => {
    for (const [cash, ratio] of BOTH_OUT) {
      expect(outcome(stateAt(cash, ratio, '2026-03-13'))).toEqual({
        trigger: 'CASH_BAND',
        legs: 2,
      });
      expect(outcome(stateAt(cash, ratio, '2026-03-14'))).toEqual({
        trigger: 'CASH_BAND',
        legs: 2,
      });
    }
  });

  /*
   * Reciproquement, un run de A ne consomme pas le cooldown de B : c'est
   * l'appelant qui tient `lastRatioRebalanceOn`, et il ne l'avance que sur un
   * arbitrage de ratio. Un reequilibrage de A le 13 laisse donc B libre de tirer
   * le 14, des que le cash est rentre dans sa bande.
   */
  it('n arme pas le cooldown de B en tirant', () => {
    expect(outcome(stateAt(CASH_BELOW, RATIO_HIGH), clockAt('2026-03-13'))).toEqual({
      trigger: 'CASH_BAND',
      legs: 2,
    });
    expect(outcome(stateAt(CASH_INSIDE, RATIO_HIGH), clockAt('2026-03-14'))).toEqual({
      trigger: 'RATIO_BAND',
      legs: 2,
    });
  });

  /* Le motif part dans `decisions` : il ne doit pas parler d'une bande sautee. */
  it('ne mentionne ni la bande de ratio ni le cooldown dans le motif', () => {
    const { reason } = intentAt(stateAt(CASH_BELOW, RATIO_HIGH, '2026-03-13'));

    expect(reason).toBe('poids USDC 0.100000 sous la borne basse 0.240000 : retour a la cible');
  });
});

// --- C11 --------------------------------------------------------------------

/*
 * « B n'est evalue que lorsque A est dans sa bande. » Le balayage ci-dessous en
 * est la forme complete : ratio fige franchement dehors, poids de cash promene
 * de part et d'autre de sa bande, et un seul verdict attendu par point.
 */
describe('C11 : B n est evalue que si A est dans sa bande', () => {
  it('tire sur B quand A est dedans et B dehors', () => {
    expect(outcome(stateAt(CASH_INSIDE, RATIO_HIGH))).toEqual({ trigger: 'RATIO_BAND', legs: 2 });
    expect(outcome(stateAt(CASH_INSIDE, RATIO_LOW))).toEqual({ trigger: 'RATIO_BAND', legs: 2 });
  });

  it('ne tire pas quand les deux sont dans leur bande', () => {
    expect(outcome(stateAt(CASH_INSIDE, RATIO_INSIDE))).toEqual({ trigger: 'NONE', legs: 0 });
  });

  it('tire sur A quand A est dehors et B dedans', () => {
    expect(outcome(stateAt(CASH_BELOW, RATIO_INSIDE))).toEqual({ trigger: 'CASH_BAND', legs: 2 });
    expect(outcome(stateAt(CASH_ABOVE, RATIO_INSIDE))).toEqual({ trigger: 'CASH_BAND', legs: 2 });
  });

  /*
   * Les 41 poids de cash de 0.10 a 0.50, ratio a 3.0 sur toute la plage. B ne
   * prend la main que sur les points ou A est dans sa bande, bornes 0.24 et
   * 0.36 comprises — les memes bornes incluses que mesure C6, vues cette fois
   * depuis B.
   */
  it('ne prend la main que sur la bande de A, de 0.10 a 0.50 de cash', () => {
    const sweep = Array.from({ length: 41 }, (_, step) =>
      new Decimal('0.10').plus(new Decimal(step).div(100)),
    );

    for (const cash of sweep) {
      const inside = !cash.lt(CASH_BAND.lower) && !cash.gt(CASH_BAND.upper);
      const seen = { cash: cash.toFixed(2), ...outcome(stateAt(cash, RATIO_HIGH)) };

      expect(seen).toEqual({
        cash: cash.toFixed(2),
        trigger: inside ? 'RATIO_BAND' : 'CASH_BAND',
        legs: 2,
      });
    }
  });

  /*
   * Le motif dit lui aussi ce qui a ete regarde : le constat de ratio n'apparait
   * que sur les runs ou A etait dans sa bande.
   */
  it('ne constate le ratio que lorsque A est dans sa bande', () => {
    expect(intentAt(stateAt(CASH_INSIDE, RATIO_HIGH)).reason).toContain('ratio BTC/ETH');
    expect(intentAt(stateAt(CASH_BELOW, RATIO_HIGH)).reason).not.toContain('ratio BTC/ETH');
    expect(intentAt(stateAt(CASH_ABOVE, RATIO_HIGH)).reason).not.toContain('ratio BTC/ETH');
  });
});

// --- C12 --------------------------------------------------------------------

/*
 * « B respecte un cooldown propre de 7 jours, independant de celui de A : deux
 * tirs de B a 6 jours d'intervalle sont refuses, a 7 jours acceptes. »
 *
 * Les intervalles sont ecrits en dates litterales, pas calcules : le sujet du
 * test est justement l'arithmetique des dates, et la refaire dans le test
 * reviendrait a la comparer a elle-meme. Chaque ligne donne la date du dernier
 * arbitrage, le run a 6 jours (refuse) et le run a 7 jours (accepte).
 */
describe('C12 : le cooldown propre de B', () => {
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

  /** L'etat qui fait tirer B : A dans sa bande, ratio franchement dehors. */
  const wants = (since: IsoDate | null) => stateAt(CASH_INSIDE, RATIO_HIGH, since);

  it('refuse a 6 jours d intervalle', () => {
    for (const [since, sixDays] of INTERVALS) {
      expect({ since, sixDays, ...outcome(wants(since), clockAt(sixDays)) }).toEqual({
        since,
        sixDays,
        trigger: 'NONE',
        legs: 0,
      });
    }
  });

  it('accepte a 7 jours d intervalle', () => {
    for (const [since, , sevenDays] of INTERVALS) {
      expect({ since, sevenDays, ...outcome(wants(since), clockAt(sevenDays)) }).toEqual({
        since,
        sevenDays,
        trigger: 'RATIO_BAND',
        legs: 2,
      });
    }
  });

  /*
   * Les deux bouts de la plage refusee : le jour meme du dernier arbitrage, et
   * le lendemain. Un compteur qui partirait a 1 au lieu de 0 laisserait tirer
   * deux jours de suite.
   */
  it('refuse le jour meme et le lendemain', () => {
    expect(outcome(wants('2026-03-14'), clockAt('2026-03-14'))).toEqual({
      trigger: 'NONE',
      legs: 0,
    });
    expect(outcome(wants('2026-03-13'), clockAt('2026-03-14'))).toEqual({
      trigger: 'NONE',
      legs: 0,
    });
  });

  it('accepte bien au-dela de 7 jours', () => {
    expect(outcome(wants('2025-03-14'), clockAt('2026-03-14'))).toEqual({
      trigger: 'RATIO_BAND',
      legs: 2,
    });
  });

  /*
   * Jamais arbitre n'est pas « zero jour ecoule » : rien ne s'est passe, donc
   * rien ne bloque. Le champ absent et le champ a `null` disent la meme chose.
   */
  it('laisse tirer quand B n a jamais arbitre', () => {
    expect(outcome(wants(null))).toEqual({ trigger: 'RATIO_BAND', legs: 2 });

    const withoutField: RebalanceState = {
      holdings: wants(null).holdings,
      prices: PRICES,
    };

    expect(outcome(withoutField)).toEqual({ trigger: 'RATIO_BAND', legs: 2 });
  });

  /*
   * L'independance des deux compteurs, dans le sens que ce module peut mesurer :
   * un cooldown de B en cours n'empeche jamais A de tirer. Le sens inverse — le
   * `COOLDOWN` de A, qui vit dans `core/risk.ts` — n'existe pas encore et
   * n'appartient pas a cette etape.
   */
  it('ne bloque pas le declencheur A', () => {
    for (const cash of [CASH_BELOW, CASH_ABOVE]) {
      expect(outcome(stateAt(cash, RATIO_HIGH, '2026-03-14'), clockAt('2026-03-14'))).toEqual({
        trigger: 'CASH_BAND',
        legs: 2,
      });
    }
  });

  /*
   * Un dernier arbitrage date dans le futur du run est un etat incoherent que ce
   * module ne sait pas arbitrer. Il bloque, par la meme comparaison : ne pas
   * trader est la reponse conservatrice.
   */
  it('bloque sur une date d arbitrage posterieure au run', () => {
    expect(outcome(wants('2026-04-01'), clockAt('2026-03-14'))).toEqual({
      trigger: 'NONE',
      legs: 0,
    });
  });

  /*
   * Le motif dit pourquoi rien n'a bouge alors que la bande etait franchie.
   * Format fige : il part dans `decisions`, que C30 exige identique octet pour
   * octet d'une execution a l'autre.
   */
  it('journalise le constat de cooldown derriere celui de la bande franchie', () => {
    expect(intentAt(wants('2026-03-08'), clockAt('2026-03-14')).reason).toBe(
      'poids USDC 0.300000 dans la bande [0.240000, 0.360000]' +
        ' ; ratio BTC/ETH 3.000000 au-dessus de la borne haute 1.733333' +
        ' ; dernier arbitrage de ratio le 2026-03-08, 6 jours ecoules sur les 7 du cooldown' +
        ' : aucun reequilibrage',
    );
  });

  /*
   * Le cooldown ne se prononce que sur un run qu'il bloque. Un ratio dans sa
   * bande n'a rien a dire d'un compteur, et l'annoncer ferait lire une occasion
   * manquee la ou il n'y en avait aucune.
   */
  it('ne parle pas de cooldown quand le ratio est dans sa bande', () => {
    expect(intentAt(stateAt(CASH_INSIDE, RATIO_INSIDE, '2026-03-13')).reason).not.toContain(
      'cooldown',
    );
  });

  /*
   * Le run bloque reste un run sans reequilibrage comme les autres : il
   * journalise la cible permanente, pas une allocation visee qu'il n'a pas
   * cherche a atteindre.
   */
  it('journalise la cible permanente sur un run bloque', () => {
    const intent = intentAt(wants('2026-03-13'), clockAt('2026-03-14'));

    expect(intent.weightsTarget.BTC.toFixed(2)).toBe('0.40');
    expect(intent.weightsTarget.ETH.toFixed(2)).toBe('0.30');
    expect(intent.weightsTarget.USDC.toFixed(2)).toBe('0.30');
  });

  /*
   * Le seuil est un parametre, et `0` le desarme franchement : c'est la seule
   * facon honnete de retrouver le comportement de la v2.0, ou B pouvait tirer
   * tous les jours. Une valeur negative ou fractionnaire, elle, ne se compare a
   * rien de sense.
   */
  it('se desarme a 0 jour et refuse les seuils qui n en sont pas', () => {
    const noCooldown: RebalanceParams = { ...SHADOW, ratioCooldownDays: 0 };

    expect(outcome(wants('2026-03-14'), clockAt('2026-03-14'), noCooldown)).toEqual({
      trigger: 'RATIO_BAND',
      legs: 2,
    });

    for (const days of [-1, 0.5, Number.NaN]) {
      const params: RebalanceParams = { ...SHADOW, ratioCooldownDays: days };
      const decision = undecidable(decide(wants(null), ANY_DAY, params));

      expect(decision.code).toBe('INVALID_PARAMS');
      expect(decision.reason).toContain('cooldown de ratio');
    }
  });

  /*
   * Le seuil n'est controle que quand B est arme, comme les autres parametres du
   * declencheur : la production n'a pas a etre refusee sur une regle qu'elle
   * n'applique jamais.
   */
  it('ne controle pas le seuil sur la configuration de production', () => {
    const params: RebalanceParams = { ...PROD, ratioCooldownDays: -1 };

    expect(decide(wants(null), ANY_DAY, params).status).toBe('DECIDED');
  });

  /*
   * Depuis que le cooldown se compte en jours, la date de run n'est plus une
   * etiquette : une date qui n'existe pas au calendrier est un etat illisible.
   * Sans ce refus, `2026-02-30` serait reporte au 2 mars par `Date` et le
   * cooldown se compterait a partir d'un jour qui n'a pas eu lieu.
   */
  it('refuse une date qui n existe pas au calendrier', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-03-00', '14/03/2026', '2026-3-14']) {
      const decision = undecidable(decide(wants(null), clockAt(bad), SHADOW));

      expect({ bad, code: decision.code }).toEqual({ bad, code: 'INVALID_DATE' });
      expect(decision.reason).toContain('date de run');
    }

    const decision = undecidable(decide(wants('2026-02-30'), ANY_DAY, SHADOW));

    expect(decision.code).toBe('INVALID_DATE');
    expect(decision.reason).toContain('dernier arbitrage');
  });

  /* La bande de ratio reste celle du §5.2 : le cooldown ne la deplace pas. */
  it('laisse la bande de ratio ou elle est', () => {
    expect(RATIO_BAND.lower.toFixed(6)).toBe('0.933333');
    expect(RATIO_BAND.upper.toFixed(6)).toBe('1.733333');
    expect(SHADOW.ratioCooldownDays).toBe(7);
  });
});
