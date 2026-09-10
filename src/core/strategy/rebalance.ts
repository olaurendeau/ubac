import { Decimal } from 'decimal.js';

import type { Holdings, PricedAsset, Prices, ValuationIssue } from '../portfolio.js';
import { ASSETS, valuate } from '../portfolio.js';
import type {
  Clock,
  Intent,
  IntentLeg,
  StrategyName,
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

const show = (weight: Weight): string => weight.toFixed(REASON_SCALE);

/**
 * Ce que le run annonce viser. La borne franchie figure deja dans la phrase,
 * donc `band_edge` n'a pas a la repeter : il lui suffit de la designer.
 */
const AIM_LABEL: Readonly<Record<RebalanceMode, string>> = {
  target: 'retour a la cible',
  band_edge: 'retour a cette borne',
};

function explain(
  cashWeight: Weight,
  band: CashBand,
  position: BandPosition,
  mode: RebalanceMode,
): string {
  switch (position.side) {
    case 'BELOW':
      return (
        `poids USDC ${show(cashWeight)} sous la borne basse ${show(band.lower)}` +
        ` : ${AIM_LABEL[mode]}`
      );
    case 'ABOVE':
      return (
        `poids USDC ${show(cashWeight)} au-dessus de la borne haute ${show(band.upper)}` +
        ` : ${AIM_LABEL[mode]}`
      );
    case 'INSIDE':
      return (
        `poids USDC ${show(cashWeight)} dans la bande` +
        ` [${show(band.lower)}, ${show(band.upper)}] : aucun reequilibrage`
      );
  }
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

  const band = cashBand(params);
  const position = locate(valuation.weights.USDC, band);
  const triggered = position.side !== 'INSIDE';
  const aimed = aimedWeights(params, position);

  return {
    status: 'DECIDED',
    intent: {
      runDate: clock.today(),
      strategy: params.strategy,
      trigger: triggered ? 'CASH_BAND' : 'NONE',
      reason: explain(valuation.weights.USDC, band, position, params.rebalanceMode),
      weightsBefore: valuation.weights,
      /*
       * Ce que le run vise reellement, et non la cible permanente : en
       * `band_edge` un run qui tire se pose sur le bord franchi, et journaliser
       * 30 % la ou les jambes menent a 24 % rendrait le rapport faux sur le seul
       * chiffre qu'on lit face aux poids constates. En mode `target`, et hors
       * declenchement dans les deux modes, c'est bien la cible permanente.
       */
      weightsTarget: aimed,
      legs: triggered ? legsToward(valuation.weights, aimed, valuation.total, state.prices) : [],
    },
  };
}
