import { Decimal } from 'decimal.js';

import type { Holdings, PricedAsset, Prices, Valuation } from '../portfolio.js';
import { valuate } from '../portfolio.js';
import type { Clock, IntentLeg, IsoDate, Price, Side, StrategyName, UsdcAmount } from '../types.js';

/**
 * Ladder a ancre unique, strategie **shadow**. Elle ne passe aucun ordre en
 * phase 0 : elle propose des jambes que le rejeu applique a un portefeuille
 * simule, pour comparer son resultat a celui du reequilibrage a bandes. C'est
 * le concurrent direct, conserve pour arbitrer empiriquement.
 *
 * Une ancre par actif, et elle ne bouge **que lorsqu'une tranche part**. C'est
 * tout le principe : une ancre qui suivrait le cours du jour rendrait l'ecart a
 * l'ancre toujours nul et rien ne se declencherait jamais.
 *
 * L'etat est un parametre, comme l'horloge. `decide` prend les ancres d'avant
 * le run et retourne celles d'apres sans rien muter : deux appels sur le meme
 * etat donnent le meme resultat par construction, pas par discipline.
 *
 * Quatre points que ni la spec de phase 0 ni la v2.0 ne tranchent, decides ici
 * et testes comme tels :
 *
 * - **Initialisation de l'ancre.** Au premier jour du rejeu il n'y a pas
 *   d'ancre. Elle est posee au cours de cloture de ce jour et aucune tranche ne
 *   part. Toute autre convention decale la serie entiere du ladder shadow.
 * - **Une tranche par actif et par jour au plus.** Un effondrement de 20 %
 *   dans la journee vaut trois pas de 7 % ; le ladder n'en achete qu'un, puis
 *   repose son ancre au cours du jour, d'ou le suivant se mesure.
 * - **Bornes inclusives.** Un cours exactement a -7 % de l'ancre achete.
 * - **Le cash est un budget de run, pas un solde par actif.** Deux achats le
 *   meme jour, ce qu'un krach correle BTC+ETH produit, puisent dans le meme
 *   solde : chaque tranche est plafonnee au cash **non encore engage par ce
 *   run**, dans l'ordre de parcours. Les ventes du jour ne le realimentent pas,
 *   leur produit n'etant pas encaisse tant que les jambes ne sont pas
 *   appliquees. Sans cela le rejeu se deroule sur un cash negatif.
 */

// --- Parametres -------------------------------------------------------------

export interface LadderParams {
  /** Baisse depuis l'ancre qui declenche un achat, en fraction de 1. */
  readonly buyStep: Decimal;
  /** Hausse depuis l'ancre qui declenche une vente, en fraction de 1. */
  readonly sellStep: Decimal;
}

/**
 * Les pas de l'annexe de `ubac-rebalance.md`. Ils different d'un actif a
 * l'autre, et c'est la premiere chose qu'une implementation distraite
 * uniformise : appliquer -7 % a ETH le fait acheter deux points trop tot, tous
 * les jours du rejeu, sans qu'aucune jambe n'ait l'air fausse. Exportes pour
 * que le test les fige.
 */
export const LADDER_PARAMS = {
  BTC: { buyStep: new Decimal('0.07'), sellStep: new Decimal('0.12') },
  ETH: { buyStep: new Decimal('0.09'), sellStep: new Decimal('0.15') },
} as const satisfies Readonly<Record<PricedAsset, LadderParams>>;

/** Taille d'une tranche, identique sur les deux actifs. */
export const TRANCHE_USDC = new Decimal('500') as UsdcAmount;

/** Cash de depart d'un run dont le portefeuille n'a pas pu etre valorise. */
const ZERO_USDC = new Decimal(0) as UsdcAmount;

/**
 * Ordre de parcours fige, jamais `Object.keys`. L'ordre des jambes fait partie
 * du resultat, et l'ordre d'insertion des ancres se retrouve dans toute
 * serialisation du rejeu, qui se compare octet pour octet.
 */
const LADDER_ASSETS = ['BTC', 'ETH'] as const satisfies readonly PricedAsset[];

// --- Etat et resultat -------------------------------------------------------

/**
 * Une ancre par actif cote. L'absence d'ancre est l'etat du premier jour du
 * rejeu, pas une anomalie.
 */
export type Anchors = Readonly<Partial<Record<PricedAsset, Price>>>;

/** Etat de depart du rejeu : aucune ancre posee. */
export const NO_ANCHORS: Anchors = {};

export interface LadderInput {
  readonly clock: Clock;
  readonly holdings: Holdings;
  /** Cours de cloture du jour. */
  readonly prices: Prices;
  /** Ancres a l'entree du run, telles que retournees par le run precedent. */
  readonly anchors: Anchors;
}

/**
 * `Trigger`, dans `core/types.ts`, ne connait que les declencheurs du
 * reequilibrage a bandes : aucune de ses valeurs ne decrit une ancre franchie.
 * Le ladder porte donc son propre declencheur plutot que de se journaliser en
 * `NONE` un jour ou il a tire. Le rejeu compte les declenchements par
 * strategie : un `NONE` complaisant les compterait a zero et fausserait la
 * comparaison sans qu'aucun test de jambe ne bronche.
 */
export type LadderTrigger = 'NONE' | 'ANCHOR_CROSSED';

export interface LadderDecision {
  readonly runDate: IsoDate;
  readonly strategy: Extract<StrategyName, 'ladder'>;
  readonly trigger: LadderTrigger;
  /** Lisible : ce qu'a fait chaque actif, dans l'ordre de parcours. */
  readonly reason: string;
  readonly legs: readonly IntentLeg[];
  /** Ancres a la sortie du run, a repasser telles quelles au run suivant. */
  readonly anchors: Anchors;
}

// --- Regle -----------------------------------------------------------------

/**
 * Un cours nul, negatif, NaN ou infini n'est pas seulement inexploitable : il
 * empoisonne l'ancre. Une ancre a zero rend les deux seuils nuls, donc tout
 * cours superieur ou egal au seuil de vente, donc une vente par jour jusqu'a la
 * fin du rejeu. La normalisation de la fixture interdit ce cas en amont ; le
 * ladder n'a aucun moyen de le savoir, et une ancre est un etat qui se propage.
 */
function isSound(price: Price): boolean {
  return price.isFinite() && price.gt(0);
}

interface Crossing {
  readonly side: Side;
  readonly threshold: Price;
}

/**
 * L'achat est examine avant la vente. Les deux seuils ne peuvent pas etre
 * franchis par le meme cours, l'un etant sous l'ancre et l'autre au dessus :
 * l'ordre est une convention de lecture, pas une priorite.
 */
function crossing(asset: PricedAsset, anchor: Price, price: Price): Crossing | null {
  const { buyStep, sellStep } = LADDER_PARAMS[asset];

  const buyAt = anchor.mul(new Decimal(1).minus(buyStep)) as Price;
  if (price.lte(buyAt)) return { side: 'BUY', threshold: buyAt };

  const sellAt = anchor.mul(new Decimal(1).plus(sellStep)) as Price;
  if (price.gte(sellAt)) return { side: 'SELL', threshold: sellAt };

  return null;
}

/**
 * Ce que le portefeuille peut reellement engager sur cette jambe : le cash
 * encore libre pour un achat, la valeur detenue sur l'actif pour une vente.
 * Sans ce plafond le ladder achete ou vend ce qu'il ne detient pas et le rejeu
 * se deroule sur des soldes negatifs. Aucun des 9 codes de rejet ne couvre le
 * manque de contrepartie, et les regles de `risk.ts` sont taillees pour le
 * reequilibrage, pas pour une strategie shadow : personne en aval ne
 * rattraperait la jambe.
 *
 * `remainingCash` est le cash d'entree diminue des achats deja decides ce run.
 * C'est la seule grandeur partagee entre les deux actifs : les lignes d'actif,
 * elles, ne se chevauchent pas, la vente de BTC se plafonne a l'exposition BTC
 * qu'aucune autre jambe ne touche.
 */
function budget(
  side: Side,
  asset: PricedAsset,
  valuation: Valuation,
  remainingCash: UsdcAmount,
): UsdcAmount | null {
  if (valuation.status !== 'VALUED') return null;

  return side === 'BUY' ? remainingCash : valuation.exposure[asset];
}

interface Step {
  /** Ancre a reporter au run suivant. `undefined` : toujours pas d'ancre. */
  readonly anchor: Price | undefined;
  readonly leg: IntentLeg | undefined;
  readonly note: string;
}

function step(
  asset: PricedAsset,
  input: LadderInput,
  valuation: Valuation,
  remainingCash: UsdcAmount,
): Step {
  const price = input.prices[asset];
  const anchor = input.anchors[asset];

  if (!isSound(price)) {
    return {
      anchor,
      leg: undefined,
      note: `${asset} : cours ${price.toString()} inexploitable, ancre inchangee`,
    };
  }

  if (anchor === undefined || !isSound(anchor)) {
    return {
      anchor: price,
      leg: undefined,
      note: `${asset} : ancre posee au cours de cloture ${price.toString()}`,
    };
  }

  const crossed = crossing(asset, anchor, price);
  if (crossed === null) {
    return {
      anchor,
      leg: undefined,
      note: `${asset} : cours ${price.toString()} dans les pas de l'ancre ${anchor.toString()}`,
    };
  }

  /*
   * L'ancre ne bouge pas quand la tranche ne part pas. Elle marque le cours du
   * dernier echange, pas le dernier signal : la deplacer sur un signal non
   * honore consommerait le franchissement et exigerait un pas entier de plus
   * pour reessayer, alors que le portefeuille redevient peut-etre solvable
   * des le lendemain.
   */
  const available = budget(crossed.side, asset, valuation, remainingCash);
  if (available === null || available.lte(0)) {
    return {
      anchor,
      leg: undefined,
      note: `${asset} : ${crossed.side} a ${price.toString()} sans contrepartie disponible, ancre inchangee`,
    };
  }

  /*
   * Une tranche tronquee reste une jambe : c'est a la couche risque, et a elle
   * seule, de decider qu'une jambe de 12 USDC ne vaut pas la peine. Rejouer ici
   * le seuil de `LEG_TOO_SMALL` en ferait deux sources de verite.
   */
  const amount = Decimal.min(TRANCHE_USDC, available) as UsdcAmount;

  return {
    anchor: price,
    leg: { asset, quote: 'USDC', side: crossed.side, amount, limitPrice: price },
    note:
      `${asset} : ${crossed.side} de ${amount.toString()} USDC, cours ${price.toString()} ` +
      `au dela du seuil ${crossed.threshold.toString()} de l'ancre ${anchor.toString()}`,
  };
}

// --- Point d'entree ---------------------------------------------------------

/**
 * Deroule un jour de ladder. Le cours utilise est celui de cloture du jour ;
 * `limitPrice` le reprend tel quel, sans decalage : la strategie est shadow,
 * aucune de ses jambes ne part chez un exchange en phase 0.
 */
export function decide(input: LadderInput): LadderDecision {
  const valuation = valuate(input.holdings, input.prices);

  const anchors: { -readonly [K in PricedAsset]?: Price } = {};
  const legs: IntentLeg[] = [];
  const notes: string[] = [];

  /*
   * Le seul etat qui traverse la boucle. Un cash lu une fois pour toutes hors
   * de la boucle laisserait chaque actif engager la totalite du solde : deux
   * achats le meme jour sur 600 USDC de cash produiraient deux tranches de 500
   * et un solde a -400.
   */
  let remainingCash = valuation.status === 'VALUED' ? valuation.exposure.USDC : ZERO_USDC;

  for (const asset of LADDER_ASSETS) {
    const outcome = step(asset, input, valuation, remainingCash);

    if (outcome.anchor !== undefined) anchors[asset] = outcome.anchor;

    if (outcome.leg !== undefined) {
      legs.push(outcome.leg);
      if (outcome.leg.side === 'BUY') {
        remainingCash = remainingCash.minus(outcome.leg.amount) as UsdcAmount;
      }
    }

    notes.push(outcome.note);
  }

  return {
    runDate: input.clock.today(),
    strategy: 'ladder',
    trigger: legs.length > 0 ? 'ANCHOR_CROSSED' : 'NONE',
    reason: notes.join(' ; '),
    legs,
    anchors,
  };
}
