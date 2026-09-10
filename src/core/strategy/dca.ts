import { Decimal } from 'decimal.js';

import type { Holdings, PricedAsset, Prices, ValuationIssue } from '../portfolio.js';
import { valuate } from '../portfolio.js';
import type { Clock, Intent, IntentLeg, IsoDate, Quantity, UsdcAmount, Weight } from '../types.js';

/**
 * DCA shadow : un montant fixe, a une date fixe du mois, reparti sur les actifs
 * cotes. C'est le benchmark de simplicite du §5.6 de `ubac-rebalance.md` — si le
 * reequilibrage ne le bat pas, il ne se justifie pas. Il n'execute rien en
 * phase 0 : `decide()` retourne une intention, personne ne la passe.
 *
 * Deux choix que ni la spec ni le plan ne tranchent, et qui changent les
 * chiffres du rejeu :
 *
 * - **Le jour de repli.** Un DCA cale au 29, 30 ou 31 n'a pas de jour d'achat
 *   tous les mois. La regle retenue est le **dernier jour du mois** : un DCA au
 *   31 achete le 28 fevrier, le 29 en annee bissextile, le 30 avril. Reporter au
 *   jour suivant aurait fait deborder l'achat du 31 janvier sur le 1er mars des
 *   mois courts — deux achats un mois, zero l'autre. Le repli sur le dernier
 *   jour garde exactement un achat par mois, ce qu'un DCA doit garantir avant
 *   toute autre propriete.
 * - **La repartition.** 50/50 BTC/ETH par defaut, la meme que le benchmark hold
 *   50/50. Le DCA ne differe alors du hold que par la date d'entree de l'argent,
 *   ce qu'un benchmark de DCA est cense isoler. Une repartition 40/30 alignee
 *   sur les cibles du reequilibrage melangerait deux differences en une.
 */

/**
 * Ordre de parcours fige, donc ordre des jambes. C23 exige des jambes
 * identiques **dans le meme ordre** d'un appel a l'autre : l'ordre
 * d'enumeration d'un objet est stable en pratique mais n'est pas un contrat.
 */
const PRICED_ORDER = ['BTC', 'ETH'] as const satisfies readonly PricedAsset[];

/** La seule devise de cotation de la phase 0. Une jambe DCA achete avec du cash. */
const QUOTE = 'USDC';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Repartition du montant entre les actifs cotes. Somme exactement 1. */
export type DcaAllocation = Readonly<Record<PricedAsset, Weight>>;

export interface DcaConfig {
  /** 1 a 31. Un mois plus court ramene l'achat a son dernier jour. */
  readonly dayOfMonth: number;
  /** Montant investi a chaque achat, en USDC. Toujours strictement positif. */
  readonly amount: UsdcAmount;
  readonly allocation: DcaAllocation;
}

/**
 * 500 USDC le 1er de chaque mois, moitie BTC moitie ETH.
 *
 * Le montant n'est pas cosmetique : reparti en deux, il donne des jambes de 250
 * USDC, au-dessus du seuil `MIN_LEG_USDC` de 200 de `core/risk.ts`. Un DCA de
 * 300 USDC produirait deux jambes de 150 que la couche risque ecarterait au
 * titre de C19 — sans rejeter le run, donc sans que rien ne l'annonce. Le
 * benchmark n'acheterait jamais rien et le rejeu comparerait le reequilibrage a
 * un portefeuille immobile.
 */
export const DCA_DEFAULTS: DcaConfig = {
  dayOfMonth: 1,
  amount: new Decimal('500') as UsdcAmount,
  allocation: {
    BTC: new Decimal('0.5') as Weight,
    ETH: new Decimal('0.5') as Weight,
  },
};

export interface DcaInput {
  readonly clock: Clock;
  readonly holdings: Holdings;
  readonly prices: Prices;
  readonly config: DcaConfig;
}

/**
 * Un portefeuille de valeur nulle ou non finie n'a pas de poids, et `Intent` en
 * exige. Le cas sort par une branche propre plutot que par des `NaN` glisses
 * dans `weightsBefore`, ou aucun seuil de la couche risque ne mordrait ensuite.
 */
export type DcaDecision =
  | { readonly status: 'DECIDED'; readonly intent: Intent }
  | {
      readonly status: 'UNVALUED';
      readonly code: ValuationIssue;
      readonly reason: string;
    };

// --- Calendrier -------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Regle gregorienne complete : 2000 est bissextile, 2100 ne l'est pas. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const length = MONTH_LENGTHS[month - 1];
  if (length === undefined) throw new RangeError(`mois hors calendrier : ${String(month)}`);
  return month === 2 && isLeapYear(year) ? 29 : length;
}

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Analyse arithmetique, sans passer par `Date` : `Date.parse('2026-02-30')`
 * reporte au 1er mars au lieu de refuser, et un run date silencieusement decale
 * fait manquer ou doubler un achat sans qu'aucune assertion ne bronche.
 */
function parseRunDate(runDate: IsoDate): CalendarDay {
  if (!ISO_DATE.test(runDate)) {
    throw new RangeError(`date de run attendue au format YYYY-MM-DD, recu « ${runDate} »`);
  }

  const year = Number(runDate.slice(0, 4));
  const month = Number(runDate.slice(5, 7));
  const day = Number(runDate.slice(8, 10));

  if (month < 1 || month > 12) throw new RangeError(`mois inexistant : « ${runDate} »`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`jour inexistant : « ${runDate} »`);
  }

  return { year, month, day };
}

/**
 * Le jour d'achat du mois de `today` : le jour configure, ramene au dernier jour
 * du mois quand le mois est plus court. Exactement un jour du mois y repond,
 * quelle que soit la configuration — c'est la propriete qui compte.
 */
function buyDayOf(today: CalendarDay, dayOfMonth: number): number {
  return Math.min(dayOfMonth, daysInMonth(today.year, today.month));
}

// --- Configuration ----------------------------------------------------------

function checkConfig(config: DcaConfig): void {
  if (!Number.isInteger(config.dayOfMonth) || config.dayOfMonth < 1 || config.dayOfMonth > 31) {
    throw new RangeError(
      `dayOfMonth doit etre un entier de 1 a 31, recu ${String(config.dayOfMonth)}`,
    );
  }

  if (!config.amount.isFinite() || config.amount.lte(ZERO)) {
    throw new RangeError(`montant DCA a ${config.amount.toString()} USDC : rien a investir`);
  }

  for (const asset of PRICED_ORDER) {
    if (config.allocation[asset].lt(ZERO)) {
      throw new RangeError(
        `part negative sur ${asset} (${config.allocation[asset].toString()}) : un DCA achete`,
      );
    }
  }

  /*
   * Somme exacte, pas approchee. Une repartition a 0.99 investirait 1 % de moins
   * chaque mois qu'annonce, et le reste ne partirait nulle part : l'ecart se lit
   * a la fin du rejeu comme une performance, pas comme un bug de configuration.
   */
  const total = PRICED_ORDER.reduce<Decimal>(
    (acc, asset) => acc.plus(config.allocation[asset]),
    ZERO,
  );
  if (!total.eq(ONE)) {
    throw new RangeError(`repartition a ${total.toString()} au lieu de 1 exactement`);
  }
}

// --- Achat ------------------------------------------------------------------

interface Purchase {
  readonly legs: readonly IntentLeg[];
  readonly projected: Holdings;
}

/**
 * Les jambes du jour et les soldes qu'elles laissent derriere elles.
 *
 * La derniere jambe prend le **reste** au lieu de sa part recalculee. Avec une
 * repartition qui somme a 1 exactement, les deux formes coincident tant que
 * `amount x part` tient dans les 20 chiffres significatifs de `Decimal` ; elles
 * divergent des que la multiplication arrondit. Le reste ne peut alors pas
 * laisser d'argent nulle part, une part recalculee si — et un DCA qui investit
 * 499.999... USDC au lieu de 500 ne fait echouer aucun test de forme.
 *
 * La division par le prix limite n'a lieu qu'ici, sur les soldes projetes : une
 * jambe reste libellee en USDC, c'est `Order.quantity` qui porte des unites
 * d'actif. Le changement de marque est ce qui interdit d'oublier la division.
 */
function purchaseOf(config: DcaConfig, holdings: Holdings, prices: Prices): Purchase {
  const legs: IntentLeg[] = [];
  const units: Record<PricedAsset, Decimal> = {
    BTC: holdings.BTC,
    ETH: holdings.ETH,
  };
  let cash: Decimal = holdings.USDC;
  let remaining: Decimal = config.amount;

  for (const [index, asset] of PRICED_ORDER.entries()) {
    const isLast = index === PRICED_ORDER.length - 1;
    const amount = isLast ? remaining : config.amount.mul(config.allocation[asset]);
    remaining = remaining.minus(amount);

    // Une part nulle ne produit pas de jambe : un ordre de 0 USDC n'existe pas.
    if (amount.lte(ZERO)) continue;

    const limitPrice = prices[asset];
    legs.push({
      asset,
      quote: QUOTE,
      side: 'BUY',
      amount: amount as UsdcAmount,
      limitPrice,
    });
    units[asset] = units[asset].plus(amount.div(limitPrice));
    cash = cash.minus(amount);
  }

  return {
    legs,
    projected: {
      BTC: units.BTC as Quantity,
      ETH: units.ETH as Quantity,
      USDC: cash as Quantity,
    },
  };
}

function unvalued(issue: { readonly code: ValuationIssue; readonly reason: string }): DcaDecision {
  return { status: 'UNVALUED', code: issue.code, reason: issue.reason };
}

/**
 * `trigger` vaut `'NONE'` meme un jour d'achat : l'enumeration `Trigger` ne
 * connait que les deux declencheurs du reequilibrage, `CASH_BAND` et
 * `RATIO_BAND`, et il n'existe pas de valeur calendaire. Le rejeu compte donc
 * les declenchements du DCA sur `legs.length > 0`, pas sur `trigger`. Ecrire
 * `CASH_BAND` pour se donner un compteur fausserait `decisions`, qui sert a
 * comparer les strategies entre elles.
 */
const TRIGGER = 'NONE';

/**
 * `weightsTarget` porte les poids **projetes apres achat**, calcules par
 * `valuate` sur les soldes projetes. Un DCA n'a pas de poids cible : il achete
 * le meme montant quel que soit l'etat du portefeuille. La projection est la
 * seule lecture honnete du champ, et elle est verifiable — appliquer les jambes
 * a la main doit redonner exactement ces poids.
 */
export function decide(input: DcaInput): DcaDecision {
  const { clock, holdings, prices, config } = input;
  checkConfig(config);

  const runDate = clock.today();
  const today = parseRunDate(runDate);
  const buyDay = buyDayOf(today, config.dayOfMonth);
  const fallback = buyDay === config.dayOfMonth ? '' : ` (repli du ${String(config.dayOfMonth)})`;

  const before = valuate(holdings, prices);
  if (before.status === 'REJECTED') return unvalued(before);

  if (today.day !== buyDay) {
    return {
      status: 'DECIDED',
      intent: {
        runDate,
        strategy: 'dca',
        trigger: TRIGGER,
        reason: `hors date d'achat : achat le ${String(buyDay)} du mois${fallback}`,
        weightsBefore: before.weights,
        weightsTarget: before.weights,
        legs: [],
      },
    };
  }

  const { legs, projected } = purchaseOf(config, holdings, prices);

  /*
   * Un achat echange du cash contre de l'actif au meme prix : la valeur totale
   * ne bouge pas et cette branche est hors d'atteinte a prix sains. Elle mord
   * sur un prix nul ou negatif, ou la quantite achetee part a l'infini. Mieux
   * vaut la sortie explicite que des poids projetes a NaN.
   */
  const after = valuate(projected, prices);
  if (after.status === 'REJECTED') return unvalued(after);

  return {
    status: 'DECIDED',
    intent: {
      runDate,
      strategy: 'dca',
      trigger: TRIGGER,
      reason: `achat calendaire de ${config.amount.toString()} USDC${fallback}`,
      weightsBefore: before.weights,
      weightsTarget: after.weights,
      legs,
    },
  };
}
