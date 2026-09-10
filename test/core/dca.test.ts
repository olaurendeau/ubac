import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import { valuate } from '../../src/core/portfolio.js';
import { MIN_LEG_USDC } from '../../src/core/risk.js';
import type { DcaConfig, DcaDecision } from '../../src/core/strategy/dca.js';
import { DCA_DEFAULTS, decide } from '../../src/core/strategy/dca.js';
import type { Clock, Intent, Price, Quantity, UsdcAmount, Weight } from '../../src/core/types.js';

const qty = (value: string): Quantity => new Decimal(value) as Quantity;
const price = (value: string): Price => new Decimal(value) as Price;
const usdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;
const weight = (value: string): Weight => new Decimal(value) as Weight;

/** L'horloge est un parametre : le test fixe le jour, le module ne le lit jamais. */
const at = (day: string): Clock => ({ today: () => day });

/** 30 000 + 30 000 + 40 000 = 100 000 USDC, soit 0.3 / 0.3 / 0.4. */
const HOLDINGS: Holdings = {
  BTC: qty('0.5'),
  ETH: qty('10'),
  USDC: qty('40000'),
};
const PRICES: Prices = { BTC: price('60000'), ETH: price('3000') };

const ON_THE_31ST: DcaConfig = { ...DCA_DEFAULTS, dayOfMonth: 31 };

function decided(decision: DcaDecision): Intent {
  if (decision.status !== 'DECIDED') {
    throw new Error(`attendu DECIDED, recu ${decision.status} (${decision.code})`);
  }
  return decision.intent;
}

function unvalued(decision: DcaDecision): Extract<DcaDecision, { status: 'UNVALUED' }> {
  if (decision.status !== 'UNVALUED') throw new Error('attendu UNVALUED, recu DECIDED');
  return decision;
}

function run(
  day: string,
  config: DcaConfig = DCA_DEFAULTS,
  holdings: Holdings = HOLDINGS,
  prices: Prices = PRICES,
): Intent {
  return decided(decide({ clock: at(day), holdings, prices, config }));
}

/** Forme comparable d'une jambe : contenu **et** rang, ce que C23 exige. */
const serialise = (intent: Intent): string =>
  intent.legs
    .map((leg) =>
      [leg.asset, leg.quote, leg.side, leg.amount.toString(), leg.limitPrice.toString()].join(' '),
    )
    .join(' | ');

/** Les jours d'une annee, dans l'ordre. `Date` est interdit dans core, pas ici. */
function daysOfYear(year: number): string[] {
  const days: string[] = [];
  for (let ms = Date.UTC(year, 0, 1); ms < Date.UTC(year + 1, 0, 1); ms += 86_400_000) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

describe('date fixe', () => {
  it('n achete pas hors du jour configure', () => {
    const intent = run('2026-02-15');

    expect(intent.legs).toEqual([]);
    expect(intent.strategy).toBe('dca');
    expect(intent.runDate).toBe('2026-02-15');
  });

  it('achete le jour configure, mois apres mois', () => {
    for (const day of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      expect(run(day).legs).toHaveLength(2);
    }
    expect(run('2026-03-02').legs).toEqual([]);
  });

  it('hors achat, les poids projetes sont les poids courants', () => {
    const intent = run('2026-02-15');

    expect(intent.weightsTarget.BTC.toString()).toBe(intent.weightsBefore.BTC.toString());
    expect(intent.weightsTarget.ETH.toString()).toBe(intent.weightsBefore.ETH.toString());
    expect(intent.weightsTarget.USDC.toString()).toBe(intent.weightsBefore.USDC.toString());
  });

  /*
   * `Trigger` ne connait que les deux declencheurs du reequilibrage. Un achat
   * DCA sort donc avec `NONE`, et le rejeu doit compter ses declenchements sur
   * les jambes. Ce test fige le choix : le jour ou quelqu'un ecrit `CASH_BAND`
   * pour se donner un compteur, il fausse `decisions` et casse ici.
   */
  it('ne revendique aucun declencheur de reequilibrage, meme un jour d achat', () => {
    expect(run('2026-02-01').trigger).toBe('NONE');
    expect(run('2026-02-15').trigger).toBe('NONE');
  });
});

describe('montant fixe', () => {
  it('repartit le montant selon la configuration, en achat, en USDC', () => {
    const [btc, eth] = run('2026-02-01').legs;

    expect(btc).toMatchObject({ asset: 'BTC', quote: 'USDC', side: 'BUY' });
    expect(eth).toMatchObject({ asset: 'ETH', quote: 'USDC', side: 'BUY' });
    expect(btc?.amount.toString()).toBe('250');
    expect(eth?.amount.toString()).toBe('250');
    expect(btc?.limitPrice.toString()).toBe('60000');
    expect(eth?.limitPrice.toString()).toBe('3000');
  });

  it('investit exactement le montant configure, pas un centime de plus', () => {
    for (const config of [DCA_DEFAULTS, { ...DCA_DEFAULTS, amount: usdc('999.99') }]) {
      const spent = run('2026-02-01', config).legs.reduce<Decimal>(
        (acc, leg) => acc.plus(leg.amount),
        new Decimal(0),
      );
      expect(spent.eq(config.amount)).toBe(true);
    }
  });

  it('suit une repartition desequilibree', () => {
    const config: DcaConfig = {
      ...DCA_DEFAULTS,
      amount: usdc('2000'),
      allocation: { BTC: weight('0.25'), ETH: weight('0.75') },
    };
    const [btc, eth] = run('2026-02-01', config).legs;

    expect(btc?.amount.toString()).toBe('500');
    expect(eth?.amount.toString()).toBe('1500');
  });

  it('ne produit pas de jambe pour une part nulle', () => {
    const onlyBtc: DcaConfig = {
      ...DCA_DEFAULTS,
      allocation: { BTC: weight('1'), ETH: weight('0') },
    };
    const onlyEth: DcaConfig = {
      ...DCA_DEFAULTS,
      allocation: { BTC: weight('0'), ETH: weight('1') },
    };

    expect(serialise(run('2026-02-01', onlyBtc))).toBe('BTC USDC BUY 500 60000');
    expect(serialise(run('2026-02-01', onlyEth))).toBe('ETH USDC BUY 500 3000');
  });

  /*
   * `Decimal` arrondit a 20 chiffres significatifs. Ici `amount x 0.5` deborde
   * et s'arrondit vers le haut : deux parts recalculees investiraient un
   * centieme de plus que le montant. La derniere jambe prend le reste, donc le
   * debordement ne peut pas se dupliquer.
   */
  it('donne le reste a la derniere jambe quand la multiplication arrondit', () => {
    const config: DcaConfig = {
      ...DCA_DEFAULTS,
      amount: usdc('1000.00000000000000001'),
    };
    const [btc, eth] = run('2026-02-01', config).legs;

    expect(btc?.amount.toString()).toBe('500.00000000000000001');
    expect(eth?.amount.toString()).toBe('500');
  });

  /*
   * Le defaut de 500 USDC n'est pas cosmetique : reparti en deux il donne des
   * jambes de 250, au-dessus du seuil de C19. Un defaut a 300 produirait deux
   * jambes de 150 que la couche risque ecarterait sans rejeter le run — le
   * benchmark n'acheterait jamais rien et personne ne le verrait.
   */
  it('produit par defaut des jambes au-dessus du seuil LEG_TOO_SMALL', () => {
    for (const leg of run('2026-02-01').legs) {
      expect(leg.amount.gte(MIN_LEG_USDC)).toBe(true);
    }
  });
});

describe('repli sur les mois trop courts', () => {
  it('achete le dernier jour de fevrier, annee commune', () => {
    expect(run('2026-02-27', ON_THE_31ST).legs).toEqual([]);
    expect(run('2026-02-28', ON_THE_31ST).legs).toHaveLength(2);
  });

  it('achete le 29 fevrier d une annee bissextile', () => {
    expect(run('2024-02-28', ON_THE_31ST).legs).toEqual([]);
    expect(run('2024-02-29', ON_THE_31ST).legs).toHaveLength(2);
  });

  /* La regle gregorienne complete : 2100 n'est pas bissextile, 2000 l'est. */
  it('applique la regle seculaire des annees bissextiles', () => {
    expect(run('2100-02-28', ON_THE_31ST).legs).toHaveLength(2);
    expect(run('2000-02-28', ON_THE_31ST).legs).toEqual([]);
    expect(run('2000-02-29', ON_THE_31ST).legs).toHaveLength(2);
  });

  it('achete le 30 dans un mois de 30 jours', () => {
    expect(run('2026-04-29', ON_THE_31ST).legs).toEqual([]);
    expect(run('2026-04-30', ON_THE_31ST).legs).toHaveLength(2);
  });

  it('ne replie pas un mois assez long', () => {
    const onThe29th: DcaConfig = { ...DCA_DEFAULTS, dayOfMonth: 29 };

    expect(run('2026-03-29', onThe29th).legs).toHaveLength(2);
    expect(run('2026-03-31', onThe29th).legs).toEqual([]);
  });

  /*
   * La propriete qui compte, et la raison du choix : reporter au jour suivant
   * aurait fait deborder l'achat du 31 janvier sur mars les annees ou fevrier
   * est court — deux achats un mois, zero l'autre.
   */
  it('achete une fois et une seule par mois sur une annee entiere', () => {
    const buys = daysOfYear(2024).filter((day) => run(day, ON_THE_31ST).legs.length > 0);

    expect(buys).toEqual([
      '2024-01-31',
      '2024-02-29',
      '2024-03-31',
      '2024-04-30',
      '2024-05-31',
      '2024-06-30',
      '2024-07-31',
      '2024-08-31',
      '2024-09-30',
      '2024-10-31',
      '2024-11-30',
      '2024-12-31',
    ]);
  });

  it('signale le repli dans la raison journalisee', () => {
    expect(run('2026-02-28', ON_THE_31ST).reason).toContain('repli du 31');
    expect(run('2026-03-31', ON_THE_31ST).reason).not.toContain('repli');
  });
});

describe('poids projetes', () => {
  it('rend les poids courants avant achat', () => {
    const intent = run('2026-02-01');

    expect(intent.weightsBefore.BTC.toString()).toBe('0.3');
    expect(intent.weightsBefore.ETH.toString()).toBe('0.3');
    expect(intent.weightsBefore.USDC.toString()).toBe('0.4');
  });

  /*
   * `weightsTarget` n'est pas une cible au sens du reequilibrage : un DCA achete
   * le meme montant quel que soit l'etat du portefeuille. C'est la projection
   * apres achat, et elle doit correspondre a l'application des jambes a la main.
   * Le test refait le chemin de son cote : oublier la division par le prix ou se
   * tromper de signe sur le cash se voit ici.
   */
  it('projette les poids obtenus en appliquant les jambes a la main', () => {
    const applied = valuate(
      {
        BTC: HOLDINGS.BTC.plus(usdc('250').div(PRICES.BTC)) as Quantity,
        ETH: HOLDINGS.ETH.plus(usdc('250').div(PRICES.ETH)) as Quantity,
        USDC: HOLDINGS.USDC.minus(usdc('500')) as Quantity,
      },
      PRICES,
    );
    if (applied.status !== 'VALUED') throw new Error('la projection du test doit se valoriser');

    const { weightsTarget } = run('2026-02-01');

    expect(weightsTarget.BTC.toString()).toBe(applied.weights.BTC.toString());
    expect(weightsTarget.ETH.toString()).toBe(applied.weights.ETH.toString());
    expect(weightsTarget.USDC.toString()).toBe(applied.weights.USDC.toString());
    expect(weightsTarget.USDC.lt(HOLDINGS.USDC.div('100000'))).toBe(true);
  });
});

describe('portefeuille invalide', () => {
  it('refuse un portefeuille de valeur nulle au lieu de diviser par zero', () => {
    const empty: Holdings = { BTC: qty('0'), ETH: qty('0'), USDC: qty('0') };

    expect(
      unvalued(
        decide({
          clock: at('2026-02-01'),
          holdings: empty,
          prices: PRICES,
          config: DCA_DEFAULTS,
        }),
      ).code,
    ).toBe('NON_POSITIVE_VALUE');
  });

  /*
   * Un prix nul envoie la quantite achetee a l'infini et la valeur projetee a
   * NaN. Sans le garde, `weightsTarget` sortirait a NaN et aucun seuil de la
   * couche risque ne mordrait ensuite : `Decimal.gte(NaN)` vaut false.
   */
  it('refuse un achat a prix nul plutot que de projeter des NaN', () => {
    const decision = decide({
      clock: at('2026-02-01'),
      holdings: HOLDINGS,
      prices: { BTC: price('0'), ETH: PRICES.ETH },
      config: DCA_DEFAULTS,
    });

    expect(unvalued(decision).code).toBe('NON_FINITE_VALUE');
  });
});

describe('configuration refusee', () => {
  const rejects = (config: Partial<DcaConfig>): void => {
    expect(() => run('2026-02-01', { ...DCA_DEFAULTS, ...config })).toThrow(RangeError);
  };

  it('refuse un jour hors calendrier', () => {
    rejects({ dayOfMonth: 0 });
    rejects({ dayOfMonth: 32 });
    rejects({ dayOfMonth: 1.5 });
    rejects({ dayOfMonth: Number.NaN });
  });

  it('refuse un montant nul ou negatif', () => {
    rejects({ amount: usdc('0') });
    rejects({ amount: usdc('-500') });
  });

  /* Une repartition a 0.99 laisserait 1 % du montant nulle part, chaque mois. */
  it('refuse une repartition qui ne somme pas a 1 exactement', () => {
    rejects({ allocation: { BTC: weight('0.5'), ETH: weight('0.49') } });
    rejects({ allocation: { BTC: weight('0.5'), ETH: weight('0.51') } });
  });

  it('refuse une part negative, qui serait une vente', () => {
    rejects({ allocation: { BTC: weight('-0.5'), ETH: weight('1.5') } });
  });
});

describe('date de run refusee', () => {
  const rejects = (day: string): void => {
    expect(() => run(day)).toThrow(RangeError);
  };

  /*
   * `Date.parse('2026-02-30')` reporte au 1er mars au lieu de refuser. Un run
   * date decale fait manquer ou doubler un achat sans qu'aucune assertion de
   * forme ne bronche : la date est analysee, pas interpretee.
   */
  it('refuse une date malformee ou inexistante', () => {
    rejects('2026-2-1');
    rejects('15/02/2026');
    rejects('2026-02-30');
    rejects('2026-13-01');
    rejects('2026-00-10');
  });
});

describe('idempotence', () => {
  it('produit les memes jambes, dans le meme ordre, a etat et horloge egaux', () => {
    const first = run('2026-02-01');
    const second = run('2026-02-01');

    expect(serialise(second)).toBe(serialise(first));
    expect(serialise(first)).toBe('BTC USDC BUY 250 60000 | ETH USDC BUY 250 3000');
  });
});
