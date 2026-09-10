import { Decimal } from 'decimal.js';

import type { Holdings, PricedAsset, Prices, ValuationIssue } from '../portfolio.js';
import { ASSETS, valuate } from '../portfolio.js';
import type {
  Clock,
  Intent,
  IntentLeg,
  StrategyName,
  Trigger,
  UsdcAmount,
  Weight,
  Weights,
} from '../types.js';

/**
 * Declencheur A : la bande de cash. Le poids USDC sort de `[0.24, 0.36]`, on
 * ramene toutes les lignes a la cible exacte (mode `target`, defaut du §5.3) ou
 * seulement au bord franchi (mode `band_edge`).
 *
 * BTC et ETH sont correles a environ 0,85 : ils montent et descendent ensemble,
 * donc la bande qui travaille reellement est crypto contre cash. C'est de cette
 * ligne que viennent 80 % des declenchements attendus.
 *
 * Declencheur B : la bande du ratio BTC/ETH, secondaire et derriere un drapeau.
 * Il arbitre BTC contre ETH a ligne cash inchangee. Le cadrage l'a sorti de la
 * production et mis en shadow : c'est un pari que la v2.0 qualifie elle-meme de
 * moins fonde et plus bruyant, et a 1 a 3 evenements par an son P&L n'est pas
 * attribuable. D'ou `ratioBandEnabled`, faux par defaut.
 *
 * Module pur : ni horloge propre, ni IO. La date de run vient du `Clock`
 * injecte, que le rejeu alimente ligne a ligne depuis la fixture.
 */

/**
 * Ordre de parcours fige des lignes qui donnent lieu a une jambe. USDC n'y
 * figure pas : c'est la contrepartie de chaque jambe, pas une ligne qu'on
 * achete. `Object.keys` est proscrit ici — l'ordre d'enumeration d'un objet
 * est stable en pratique mais n'est pas un contrat, et C23 exige l'identite de
 * l'ordre des jambes, pas seulement de leur ensemble.
 */
const PRICED_ASSETS = ['BTC', 'ETH'] as const satisfies readonly PricedAsset[];

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Tolerance de C4, reutilisee pour verifier que les cibles somment a 1. */
const SUM_TOLERANCE = new Decimal('1e-8');

/** Nombre de decimales des poids dans `reason`. Journalise, donc fige. */
const REASON_SCALE = 6;

// --- Parametres -------------------------------------------------------------

/**
 * `target` ramene chaque ligne a sa cible permanente. `band_edge` ne ramene le
 * cash qu'au bord franchi : il trade moins et laisse le portefeuille derive de
 * ce qui separe ce bord de la cible (§5.3). Le defaut de l'annexe est `target`.
 */
export type RebalanceMode = 'target' | 'band_edge';

export interface RebalanceParams {
  /** Nom journalise dans l'intention. Le rejeu compte les declenchements par la. */
  readonly strategy: StrategyName;
  /** Allocation visee. Somme a 1 a 1e-8 pres, verifie a chaque appel. */
  readonly targets: Weights;
  /** Ecart relatif tolere autour de la cible USDC : 0.20 donne `[0.24, 0.36]`. */
  readonly cashBandRelative: Decimal;
  /** Ou se pose le run une fois qu'il a tire : sur la cible, ou sur le bord. */
  readonly rebalanceMode: RebalanceMode;
  /**
   * Declencheur B. Faux par defaut, et ce defaut est le sujet de C13 : un
   * defaut a vrai ferait entrer B en production par omission, ce que le cadrage
   * a explicitement refuse en le renvoyant en shadow.
   */
  readonly ratioBandEnabled: boolean;
  /** Ecart relatif tolere sur le ratio BTC/ETH : 0.30 donne `[0.93, 1.73]`. */
  readonly ratioBandRelative: Decimal;
}

/** Les defauts de l'annexe de `ubac-rebalance.md`, en decimal exact. */
export const DEFAULT_REBALANCE_PARAMS: RebalanceParams = {
  strategy: 'rebalance',
  targets: {
    BTC: new Decimal('0.40') as Weight,
    ETH: new Decimal('0.30') as Weight,
    USDC: new Decimal('0.30') as Weight,
  },
  cashBandRelative: new Decimal('0.20'),
  rebalanceMode: 'target',
  ratioBandEnabled: false,
  ratioBandRelative: new Decimal('0.30'),
};

/**
 * Les cibles arrivent de la configuration, donc de l'exterieur. Une somme qui
 * ne fait pas 1 casse silencieusement la symetrie de C8 : les jambes BTC et ETH
 * impliquent une variation de cash de `-(dBTC + dETH)`, qui n'egale la variation
 * de cash visee que si les deux vecteurs de poids somment a la meme chose.
 *
 * Chaque cible est controlee finie avant que la somme ne soit calculee, et pas
 * seulement la somme : `Decimal.gt` repond false sur un NaN, donc un controle
 * reduit a `somme - 1 > tolerance` laisserait passer une cible NaN, qui
 * ressortirait en poids NaN sans qu'aucune ligne de code ne soit sautee. Meme
 * piege que le total non fini de `portfolio.ts`, meme parade.
 */
function paramsIssue(params: RebalanceParams): string | null {
  if (!params.cashBandRelative.isFinite() || params.cashBandRelative.isNegative()) {
    return (
      `bande relative de cash a ${params.cashBandRelative.toString()}` +
      ' : attendue finie et positive ou nulle'
    );
  }

  for (const asset of ASSETS) {
    if (!params.targets[asset].isFinite() || params.targets[asset].isNegative()) {
      return (
        `cible ${asset} a ${params.targets[asset].toString()}` +
        ' : attendue finie et positive ou nulle'
      );
    }
  }

  const total = ASSETS.reduce<Decimal>((acc, asset) => acc.plus(params.targets[asset]), ZERO);

  if (total.minus(ONE).abs().gt(SUM_TOLERANCE)) {
    return `somme des cibles a ${total.toString()} : attendue 1 a ${SUM_TOLERANCE.toString()} pres`;
  }

  /*
   * En `band_edge`, le solde hors cash se repartit entre BTC et ETH au prorata
   * de leurs cibles ; une allocation entierement en cash rend ce prorata
   * indefini. `Decimal.div` sur 0 / 0 rend NaN, qui ressortirait en poids vise
   * NaN puis en jambes NaN sans qu'aucune comparaison ne morde, `Decimal.gt`
   * repondant false sur un NaN. La configuration est degeneree : elle se refuse
   * ici plutot que de sortir en silence. En mode `target` elle reste licite,
   * puisque les cibles sont alors utilisees telles quelles.
   */
  if (params.rebalanceMode === 'band_edge' && riskyTargets(params).isZero()) {
    return 'cibles BTC et ETH nulles en mode band_edge : le solde hors cash est sans repartition';
  }

  /*
   * Les gardes du declencheur B ne s'appliquent que quand B est arme : une
   * configuration de production qui n'evalue jamais le ratio n'a pas a etre
   * refusee sur des parametres qu'elle n'utilise pas.
   */
  if (params.ratioBandEnabled) {
    if (!params.ratioBandRelative.isFinite() || params.ratioBandRelative.isNegative()) {
      return (
        `bande relative de ratio a ${params.ratioBandRelative.toString()}` +
        ' : attendue finie et positive ou nulle'
      );
    }

    /*
     * Un seul controle sur la bande calculee couvre les trois configurations
     * degenerees, parce que toutes les trois se lisent sur ses bornes : cible
     * ETH nulle (ratio cible infini ou NaN), cible BTC nulle (bande reduite a
     * `[0, 0]`), et ecart relatif superieur ou egal a 1 (borne basse negative
     * ou nulle). Les deux dernieres comptent parce que `band_edge` vise la
     * borne franchie : un ratio vise nul ou negatif decrirait une ligne BTC
     * negative, et `1 + ratio` a -1 diviserait par zero.
     */
    const band = ratioBand(params);

    if (!band.lower.isFinite() || !band.upper.isFinite() || !band.lower.gt(ZERO)) {
      return (
        `bande de ratio BTC/ETH [${band.lower.toString()}, ${band.upper.toString()}]` +
        ' : attendue finie et de borne basse strictement positive'
      );
    }
  }

  return null;
}

// --- Bande de cash ----------------------------------------------------------

export interface CashBand {
  readonly lower: Weight;
  readonly upper: Weight;
}

/** `[cible x (1 - ecart), cible x (1 + ecart)]`, soit `[0.24, 0.36]` par defaut. */
export function cashBand(params: RebalanceParams): CashBand {
  return {
    lower: params.targets.USDC.mul(ONE.minus(params.cashBandRelative)) as Weight,
    upper: params.targets.USDC.mul(ONE.plus(params.cashBandRelative)) as Weight,
  };
}

/**
 * `edge` porte la borne franchie, pas une borne fixe : c'est ce dont a besoin
 * le mode `band_edge` de C9, qui remonte le cash a 24 % par le bas et le
 * redescend a 36 % par le haut.
 */
type BandPosition =
  | { readonly side: 'INSIDE' }
  | { readonly side: 'BELOW'; readonly edge: Weight }
  | { readonly side: 'ABOVE'; readonly edge: Weight };

/**
 * Bornes incluses (C6) : on tire strictement sous 0.24 et strictement au-dessus
 * de 0.36, jamais dessus. D'ou `lt` et `gt`, jamais `lte` ni `gte`.
 *
 * Et jamais non plus `<` ni `>` : sur deux objets `Decimal`, JavaScript passe
 * par la coercition et compare des chaines. Le resultat reste plausible sur des
 * poids inferieurs a 1 — donc les tests passent — mais la comparaison n'est plus
 * numerique. Exactement aux bornes que C6 et C7 mesurent, c'est indetectable a
 * la lecture du resultat.
 */
function locate(cashWeight: Weight, band: CashBand): BandPosition {
  if (cashWeight.lt(band.lower)) return { side: 'BELOW', edge: band.lower };
  if (cashWeight.gt(band.upper)) return { side: 'ABOVE', edge: band.upper };
  return { side: 'INSIDE' };
}

// --- Bande de ratio BTC/ETH (declencheur B) ---------------------------------

/**
 * Le ratio n'est pas un poids : c'est le quotient de deux poids, donc sans
 * marque. `Weight` designe une fraction du portefeuille, et un quotient de
 * fractions n'en est pas une — 1.73 n'a aucun sens comme poids.
 */
export interface RatioBand {
  readonly target: Decimal;
  readonly lower: Decimal;
  readonly upper: Decimal;
}

/**
 * `[cible x (1 - ecart), cible x (1 + ecart)]` autour de `cibleBTC / cibleETH`,
 * soit `[0.933333, 1.733333]` autour de 4/3 par defaut — les `0.93 - 1.73` du
 * §5.2. La bande est bien plus large que celle du cash, et volontairement :
 * l'arbitrage BTC contre ETH est le pari le moins fonde des deux.
 */
export function ratioBand(params: RebalanceParams): RatioBand {
  const target = params.targets.BTC.div(params.targets.ETH);

  return {
    target,
    lower: target.mul(ONE.minus(params.ratioBandRelative)),
    upper: target.mul(ONE.plus(params.ratioBandRelative)),
  };
}

/**
 * `UNDEFINED` n'est pas `INSIDE` deguise. Un portefeuille sans BTC ni ETH donne
 * un ratio `0 / 0`, donc NaN, et `Decimal.lt` comme `Decimal.gt` repondent false
 * sur un NaN : sans cette branche le cas ressortirait « dans la bande », avec un
 * `NaN` imprime dans le motif journalise. Le rendre explicite est la meme parade
 * que celle du total non fini de `portfolio.ts`.
 *
 * Un ratio infini, lui, est un vrai depassement : plus d'ETH du tout et du BTC
 * en portefeuille, c'est exactement la situation que B doit rattraper.
 */
type RatioPosition =
  | { readonly side: 'INSIDE' }
  | { readonly side: 'UNDEFINED' }
  | { readonly side: 'BELOW'; readonly edge: Decimal }
  | { readonly side: 'ABOVE'; readonly edge: Decimal };

/** Bornes incluses, comme pour le cash : `lt` et `gt`, jamais `lte` ni `gte`. */
function locateRatio(ratio: Decimal, band: RatioBand): RatioPosition {
  if (ratio.isNaN()) return { side: 'UNDEFINED' };
  if (ratio.lt(band.lower)) return { side: 'BELOW', edge: band.lower };
  if (ratio.gt(band.upper)) return { side: 'ABOVE', edge: band.upper };
  return { side: 'INSIDE' };
}

/**
 * Le ratio vise par un run de B : la cible, ou la borne franchie en `band_edge`.
 * Le parametre n'accepte qu'une position hors bande — il n'y a rien a viser
 * quand le ratio est dedans ou indefini, et le type l'impose plutot que de
 * laisser une branche morte repondre a la question.
 */
function aimedRatio(
  band: RatioBand,
  position: Extract<RatioPosition, { readonly edge: Decimal }>,
  mode: RebalanceMode,
): Decimal {
  return mode === 'target' ? band.target : position.edge;
}

/**
 * « Reequilibrage BTC vers ETH uniquement, ligne cash inchangee » (§5.2). Le
 * poids cumule des deux lignes crypto est repris tel quel et redistribue au
 * ratio vise : `BTC = crypto x r / (1 + r)`, `ETH = crypto / (1 + r)`. Le poids
 * USDC est recopie a l'identique, donc `legsToward` ne trouve aucun ecart a
 * combler sur le cash et les deux jambes se compensent.
 *
 * Les deux poids sont calcules chacun de leur cote, jamais l'un deduit de
 * l'autre par `crypto - BTC` : cette deduction les ferait sommer au poids
 * crypto par construction et masquerait une erreur de repartition derriere une
 * identite comptable toujours vraie — la meme raison qui interdit a
 * `portfolio.ts` de deduire le dernier poids des deux autres. Le prix a payer
 * est que la somme peut manquer le poids crypto de quelques ulps, douze ordres
 * de grandeur sous la tolerance de 1e-8 a laquelle le cash est dit constant.
 */
function ratioWeights(current: Weights, ratio: Decimal): Weights {
  const crypto = current.BTC.plus(current.ETH);
  const share = ONE.plus(ratio);

  return {
    BTC: crypto.mul(ratio).div(share) as Weight,
    ETH: crypto.div(share) as Weight,
    USDC: current.USDC,
  };
}

// --- Cible visee par le run -------------------------------------------------

/** Poids cible cumule des lignes qui ont un prix de marche, soit `1 - USDC`. */
function riskyTargets(params: RebalanceParams): Decimal {
  return PRICED_ASSETS.reduce<Decimal>((acc, asset) => acc.plus(params.targets[asset]), ZERO);
}

/**
 * Ou se pose le run. En `target`, sur la cible permanente. En `band_edge`, sur
 * `position.edge`, c'est-a-dire la borne **franchie** et non une borne fixe :
 * un cash a 20 % remonte a 24 %, un cash a 40 % redescend a 36 %. Ramener
 * systematiquement a 24 % est l'erreur naturelle et elle ne se voit que sur le
 * franchissement par le haut, ou elle vend tout le cash excedentaire au lieu de
 * la seule fraction qui depasse.
 *
 * Le solde `1 - bord` se repartit entre BTC et ETH au prorata de leurs cibles,
 * donc exactement au ratio cible. C'est ce qui garde vraie, dans les deux modes,
 * la raison pour laquelle B n'est pas evalue quand A tire : le reequilibrage
 * remet deja le ratio BTC/ETH sur sa cible. Ne conserver que le ratio courant
 * traderait un peu moins et laisserait le ratio hors bande sans que personne ne
 * le rattrape, B ayant deja ete saute.
 *
 * Hors declenchement, il n'y a pas de bord franchi et rien n'est vise : c'est la
 * cible permanente qui ressort, celle que le rapport affiche face aux poids
 * constates.
 */
function aimedWeights(params: RebalanceParams, position: BandPosition): Weights {
  if (position.side === 'INSIDE' || params.rebalanceMode === 'target') return params.targets;

  const risky = ONE.minus(position.edge);
  const share = riskyTargets(params);

  return {
    BTC: params.targets.BTC.div(share).mul(risky) as Weight,
    ETH: params.targets.ETH.div(share).mul(risky) as Weight,
    USDC: position.edge,
  };
}

// --- Jambes -----------------------------------------------------------------

/**
 * Une jambe par actif dont le poids s'ecarte de la cible visee, libellee en
 * USDC : `(visee - courant) x valeur totale`. Positif, on achete ; negatif, on
 * vend. Le montant sort en valeur absolue, le sens est porte par `side`.
 *
 * La visee arrive de `aimedWeights` : c'est la cible permanente en mode
 * `target`, l'allocation au bord franchi en mode `band_edge`. Le calcul des
 * jambes ne connait pas le mode, il ne connait que le vecteur qu'on lui donne.
 *
 * La ligne USDC ne produit pas de jambe : elle est la contrepartie des autres.
 * Comme les deux vecteurs de poids somment a 1, la variation de cash implicite
 * `-(dBTC + dETH)` vaut exactement la variation voulue `(viseeUSDC - USDC) x
 * total`. C'est ce qui rend la symetrie de C8 vraie par construction plutot que
 * par une troisieme jambe qu'il faudrait tenir en accord avec les deux autres.
 *
 * Chaque ligne de `PRICED_ASSETS` produit sa jambe, y compris quand l'ecart est
 * nul. L'index d'une jambe est donc sa position dans cette liste, et rien
 * d'autre : il ne depend pas de l'etat du portefeuille. C'est ce qui rend le
 * `client_order_id` de C24 stable, puisqu'il est hache sur `leg_index` (§7).
 *
 * Sauter la jambe nulle serait l'erreur inverse et elle est silencieuse : BTC
 * pile sur sa cible ferait remonter ETH de l'index 1 a l'index 0, et la meme
 * vente ressortirait sous un autre identifiant. Le cas se produit precisement
 * apres un reequilibrage partiellement execute — la jambe executee laisse sa
 * ligne a la cible — c'est-a-dire le cas ou le §7 exige justement qu'un rejeu ne
 * puisse pas doubler l'ordre.
 *
 * Une jambe a 0 USDC ne devient pas un ordre pour autant : `risk.ts` prend son
 * `legIndex` sur `intent.legs.entries()`, donc avant le filtre, puis l'ecarte
 * sous `LEG_TOO_SMALL` (seuil a 200 USDC) sans decaler personne. Son `side` vaut
 * `SELL` par la convention de l'expression ci-dessous ; sur un montant nul le
 * sens ne designe rien, et il n'atteint jamais l'exchange.
 */
function legsToward(
  current: Weights,
  aimed: Weights,
  total: UsdcAmount,
  prices: Prices,
): IntentLeg[] {
  const legs: IntentLeg[] = [];

  for (const asset of PRICED_ASSETS) {
    const delta = aimed[asset].minus(current[asset]).mul(total);

    legs.push({
      asset,
      quote: 'USDC',
      side: delta.gt(ZERO) ? 'BUY' : 'SELL',
      amount: delta.abs() as UsdcAmount,
      /*
       * Prix de marche du jour. L'offset de limite (`limitOffsetPct`) est un
       * parametre d'execution : il appartient a l'adapter, qui n'existe pas en
       * phase 0, et l'appliquer ici fausserait la symetrie de C8.
       */
      limitPrice: prices[asset],
    });
  }

  return legs;
}

// --- Point d'entree ---------------------------------------------------------

export interface RebalanceState {
  readonly holdings: Holdings;
  readonly prices: Prices;
}

/** `INVALID_PARAMS` couvre une configuration incoherente, pas un etat de marche. */
export type UndecidableCode = ValuationIssue | 'INVALID_PARAMS';

/**
 * Un portefeuille de valeur nulle n'a pas de poids : il n'y a pas de decision a
 * prendre, et repondre `trigger: 'NONE'` le ferait passer pour un portefeuille
 * sagement dans sa bande. Le cas sort par sa propre branche, avec le code de
 * rejet remonte tel quel depuis `valuate` (C5).
 */
export type Decision =
  | { readonly status: 'DECIDED'; readonly intent: Intent }
  | { readonly status: 'UNDECIDABLE'; readonly code: UndecidableCode; readonly reason: string };

const show = (value: Decimal): string => value.toFixed(REASON_SCALE);

/**
 * Ce que le run annonce viser. La borne franchie figure deja dans la phrase,
 * donc `band_edge` n'a pas a la repeter : il lui suffit de la designer.
 */
const AIM_LABEL: Readonly<Record<RebalanceMode, string>> = {
  target: 'retour a la cible',
  band_edge: 'retour a cette borne',
};

const NO_REBALANCE = 'aucun reequilibrage';

/**
 * Le motif est un constat par bande, puis la conclusion du run. Quand B est
 * arme, les deux constats se lisent dans l'ordre ou ils sont evalues : le cash
 * d'abord, le ratio ensuite. Aucun fragment ne porte de conclusion, sans quoi
 * une phrase a deux constats en annoncerait deux.
 */
const explain = (constats: readonly string[], triggered: boolean, mode: RebalanceMode): string =>
  `${constats.join(' ; ')} : ${triggered ? AIM_LABEL[mode] : NO_REBALANCE}`;

function cashConstat(cashWeight: Weight, band: CashBand, position: BandPosition): string {
  switch (position.side) {
    case 'BELOW':
      return `poids USDC ${show(cashWeight)} sous la borne basse ${show(band.lower)}`;
    case 'ABOVE':
      return `poids USDC ${show(cashWeight)} au-dessus de la borne haute ${show(band.upper)}`;
    case 'INSIDE':
      return (
        `poids USDC ${show(cashWeight)} dans la bande` +
        ` [${show(band.lower)}, ${show(band.upper)}]`
      );
  }
}

function ratioConstat(ratio: Decimal, band: RatioBand, position: RatioPosition): string {
  switch (position.side) {
    case 'BELOW':
      return `ratio BTC/ETH ${show(ratio)} sous la borne basse ${show(band.lower)}`;
    case 'ABOVE':
      return `ratio BTC/ETH ${show(ratio)} au-dessus de la borne haute ${show(band.upper)}`;
    case 'INSIDE':
      return (
        `ratio BTC/ETH ${show(ratio)} dans la bande` +
        ` [${show(band.lower)}, ${show(band.upper)}]`
      );
    case 'UNDEFINED':
      return 'ratio BTC/ETH indefini, aucune ligne BTC ni ETH';
  }
}

/** Ce que le run a decide de viser, avant toute mise en forme d'intention. */
interface Aim {
  readonly trigger: Trigger;
  readonly weights: Weights;
  readonly reason: string;
}

/**
 * L'ordre des deux declencheurs est celui du cadrage : A l'emporte. Quand A
 * tire, le reequilibrage complet remet deja le ratio BTC/ETH sur sa cible — les
 * deux modes le garantissent — donc B n'a rien a rattraper et n'est meme pas
 * evalue. Le calculer pour le jeter ensuite laisserait `trigger` a la merci d'un
 * oubli, alors qu'il est journalise dans `decisions` et sert a compter les
 * declenchements du rejeu.
 *
 * L'etape 13 ajoutera le cooldown propre a B et les tests de cette priorite.
 */
function aimOf(params: RebalanceParams, weights: Weights): Aim {
  const band = cashBand(params);
  const position = locate(weights.USDC, band);
  const cash = cashConstat(weights.USDC, band, position);

  if (position.side !== 'INSIDE') {
    return {
      trigger: 'CASH_BAND',
      weights: aimedWeights(params, position),
      reason: explain([cash], true, params.rebalanceMode),
    };
  }

  if (!params.ratioBandEnabled) {
    return {
      trigger: 'NONE',
      weights: params.targets,
      reason: explain([cash], false, params.rebalanceMode),
    };
  }

  const rBand = ratioBand(params);
  const ratio = weights.BTC.div(weights.ETH);
  const rPosition = locateRatio(ratio, rBand);
  const constats = [cash, ratioConstat(ratio, rBand, rPosition)];

  if (rPosition.side === 'INSIDE' || rPosition.side === 'UNDEFINED') {
    return {
      trigger: 'NONE',
      weights: params.targets,
      reason: explain(constats, false, params.rebalanceMode),
    };
  }

  return {
    trigger: 'RATIO_BAND',
    weights: ratioWeights(weights, aimedRatio(rBand, rPosition, params.rebalanceMode)),
    reason: explain(constats, true, params.rebalanceMode),
  };
}

/**
 * Decide du reequilibrage du jour. Deterministe : memes etat, meme horloge et
 * memes parametres donnent la meme intention, jambes comprises et dans le meme
 * ordre (C23).
 *
 * Aucun parametre de contournement, pas plus ici que dans la couche risque :
 * une intention se decide entierement a partir de l'etat observe.
 */
export function decide(state: RebalanceState, clock: Clock, params: RebalanceParams): Decision {
  const issue = paramsIssue(params);

  if (issue !== null) {
    return { status: 'UNDECIDABLE', code: 'INVALID_PARAMS', reason: issue };
  }

  const valuation = valuate(state.holdings, state.prices);

  if (valuation.status === 'REJECTED') {
    return { status: 'UNDECIDABLE', code: valuation.code, reason: valuation.reason };
  }

  const aim = aimOf(params, valuation.weights);
  const triggered = aim.trigger !== 'NONE';

  return {
    status: 'DECIDED',
    intent: {
      runDate: clock.today(),
      strategy: params.strategy,
      trigger: aim.trigger,
      reason: aim.reason,
      weightsBefore: valuation.weights,
      /*
       * Ce que le run vise reellement, et non la cible permanente : en
       * `band_edge` un run qui tire se pose sur le bord franchi, et journaliser
       * 30 % la ou les jambes menent a 24 % rendrait le rapport faux sur le seul
       * chiffre qu'on lit face aux poids constates. Sur un run de B c'est le
       * poids USDC constate qui ressort, puisque B n'y touche pas. En mode
       * `target`, et hors declenchement dans les deux modes, c'est bien la cible
       * permanente.
       */
      weightsTarget: aim.weights,
      legs: triggered
        ? legsToward(valuation.weights, aim.weights, valuation.total, state.prices)
        : [],
    },
  };
}
