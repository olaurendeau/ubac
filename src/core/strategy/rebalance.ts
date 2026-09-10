import { Decimal } from 'decimal.js';

import type { Holdings, PricedAsset, Prices, ValuationIssue } from '../portfolio.js';
import { ASSETS, valuate } from '../portfolio.js';
import type {
  CashFlow,
  Clock,
  Intent,
  IntentLeg,
  IsoDate,
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
 * A l'emporte sur B : quand la bande de cash est franchie, le reequilibrage
 * complet remet deja le ratio sur sa cible, donc B n'est meme pas evalue. Et B
 * porte son propre cooldown de 7 jours, distinct de celui de A qu'applique
 * `core/risk.ts` : la v2.0 n'en donnait aucun a B, qui pouvait donc tirer tous
 * les jours tant que la bande de ratio restait franchie. Le cadrage a comble ce
 * trou.
 *
 * Carence sur apport (§5.4) : un virement d'argent frais deplace les poids et
 * ferait tirer A le jour meme, ce qui revient a investir la totalite de l'apport
 * au prix du jour. Un apport gele donc A pendant sept jours. Il ne gele que A —
 * B arbitre BTC contre ETH a ligne cash inchangee, donc il ne peut pas investir
 * l'apport et rien ne justifie de l'arreter (C26).
 *
 * D'ou la lecture exacte de la priorite : B est evalue des que **A ne tire
 * pas**, et pas seulement quand le poids de cash est dans sa bande. Les deux
 * formulations coincident partout sauf pendant une carence, ou seule la
 * premiere reste vraie. C'est celle du cadrage.
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
   * Jours calendaires pendant lesquels un apport gele le declencheur A (§5.4).
   * Meme unite et meme forme que `ratioCooldownDays` : un compte de dates, pas
   * une grandeur de marche.
   *
   * `0` desarme franchement la carence, ce qui redonne la politique `immediate`
   * de la v2.0 sans une enumeration a trois valeurs dont la phase 0 n'aurait
   * teste qu'une branche. La politique `manual`, elle, suppose une intervention
   * humaine : elle n'a pas de sens dans un module pur et sort du perimetre.
   */
  readonly newCashFreezeDays: number;
  /**
   * Declencheur B. Faux par defaut, et ce defaut est le sujet de C13 : un
   * defaut a vrai ferait entrer B en production par omission, ce que le cadrage
   * a explicitement refuse en le renvoyant en shadow.
   */
  readonly ratioBandEnabled: boolean;
  /** Ecart relatif tolere sur le ratio BTC/ETH : 0.30 donne `[0.93, 1.73]`. */
  readonly ratioBandRelative: Decimal;
  /**
   * Jours calendaires entre deux arbitrages de ratio. Entier positif ou nul, et
   * en jours et non en `Decimal` : c'est un compte de dates, pas une grandeur de
   * marche. Distinct du cooldown de A, que `core/risk.ts` applique de son cote.
   */
  readonly ratioCooldownDays: number;
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
  newCashFreezeDays: 7,
  ratioBandEnabled: false,
  ratioBandRelative: new Decimal('0.30'),
  ratioCooldownDays: 7,
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

  /*
   * Meme forme que le cooldown de B, mais controle sur toutes les
   * configurations et non derriere un drapeau : la carence porte sur A, que
   * toute configuration de ce module evalue. Un seuil fractionnaire ou negatif
   * ne se compare a rien de sense — `0` est la facon franche de la desarmer.
   */
  if (!Number.isInteger(params.newCashFreezeDays) || params.newCashFreezeDays < 0) {
    return (
      `carence sur apport a ${String(params.newCashFreezeDays)} jours` +
      ' : attendu un entier positif ou nul'
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
    /*
     * Un cooldown fractionnaire ou negatif ne se compare a rien de sense : les
     * jours ecoules sont des entiers, et un seuil negatif rendrait la regle
     * morte au lieu de la desarmer franchement — ce que `0` fait, lui.
     */
    if (!Number.isInteger(params.ratioCooldownDays) || params.ratioCooldownDays < 0) {
      return (
        `cooldown de ratio a ${String(params.ratioCooldownDays)} jours` +
        ' : attendu un entier positif ou nul'
      );
    }

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

// --- Delais dates : cooldown de B, carence sur apport de A -------------------

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

/**
 * Numero de jour absolu d'une date ISO, ou `null` si la date n'existe pas.
 * L'origine n'a aucune importance : seule la difference de deux numeros est
 * lue, et c'est elle qui donne les jours calendaires ecoules.
 *
 * L'arithmetique est faite a la main, sans passer par `Date` : `Date.parse` et
 * `Date.UTC` reportent le 2026-02-30 au 2 mars au lieu de le refuser, et un
 * cooldown compte a partir d'une date silencieusement decalee laisse tirer B
 * un jour trop tot sans qu'aucune assertion ne bronche. Le meme choix, pour la
 * meme raison, est fait dans `strategy/dca.ts` — les deux modules portent
 * chacun leur calendrier faute d'un `core/calendar.ts`, que le plan n'ouvre
 * dans le perimetre d'aucune etape.
 */
function dayNumber(date: IsoDate): number | null {
  if (!ISO_DATE.test(date)) return null;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  /* Jours des annees pleines precedentes, regle gregorienne comprise. */
  const past = year - 1;
  let days = past * 365 + Math.floor(past / 4) - Math.floor(past / 100) + Math.floor(past / 400);

  for (let m = 1; m < month; m += 1) days += daysInMonth(year, m);

  return days + day;
}

/** Une date deja lue au calendrier : la chaine journalisee et son numero de jour. */
interface ReadDate {
  readonly date: IsoDate;
  readonly day: number;
}

function readDate(date: IsoDate): ReadDate | null {
  const day = dayNumber(date);

  return day === null ? null : { date, day };
}

/**
 * L'etat, au jour du run, de l'un des deux delais que ce module tient : le
 * cooldown propre a B (C12) et la carence sur apport qui gele A (C25). `NEVER`
 * n'est pas « zero jour ecoule » : rien ne s'est produit, donc rien ne peut
 * bloquer, alors que zero jour ecoule bloque.
 *
 * Les deux delais partagent ce type, la soustraction qui le remplit et la
 * comparaison qui le lit. Ils ne partagent pas leur libelle. C'est voulu : la
 * borne exclusive de C12 et celle de C25 sont exactement la meme comparaison, et
 * deux implementations separees, ce serait deux fois l'occasion de decaler le
 * degel d'un jour.
 */
type Delay =
  | { readonly state: 'NEVER' }
  | { readonly state: 'SINCE'; readonly since: IsoDate; readonly elapsed: number }
  | { readonly state: 'UNREADABLE'; readonly reason: string };

/** Ce qu'un declencheur peut recevoir : une date illisible n'arrive jamais jusqu'a lui. */
type ResolvedDelay = Exclude<Delay, { readonly state: 'UNREADABLE' }>;

/** Un delai qui court : l'evenement a eu lieu, a une date lisible. */
type ArmedDelay = Extract<Delay, { readonly state: 'SINCE' }>;

const NOTHING_YET: ResolvedDelay = { state: 'NEVER' };

/**
 * Les jours ecoules depuis un evenement deja lu au calendrier. Seul endroit du
 * module ou cette soustraction est ecrite, pour les deux delais.
 */
function delayFrom(runDay: number, since: ReadDate | null): ResolvedDelay {
  if (since === null) return NOTHING_YET;

  return { state: 'SINCE', since: since.date, elapsed: runDay - since.day };
}

/**
 * Le cooldown de B au jour du run. La date du dernier arbitrage est refusee
 * drapeau baisse, y compris sur une configuration qui n'evalue jamais le
 * ratio : la remonter seulement quand elle est lue ferait dependre la validite
 * d'un etat de la configuration qui le regarde.
 */
function ratioCooldown(runDay: number, since: IsoDate | null): Delay {
  if (since === null) return NOTHING_YET;

  const read = readDate(since);

  if (read === null) {
    return {
      state: 'UNREADABLE',
      reason: `date du dernier arbitrage de ratio inexistante au calendrier : « ${since} »`,
    };
  }

  return delayFrom(runDay, read);
}

/**
 * Le delai qui bloque ce run, ou `null` s'il n'y en a pas. Une seule fonction
 * repond a la fois pour la decision et pour le motif : deux fonctions separees
 * permettraient d'afficher un constat sur un run qui n'a pas ete bloque, et de
 * bloquer sans le dire.
 *
 * Sept jours d'intervalle passent, six ne passent pas — le cooldown de C12 et la
 * carence de C25, dont la borne J+7 est exclue, disent la meme chose. Le seuil
 * est atteint, donc `>=`. Un `>` decalerait le degel d'un jour, et seuls les
 * deux tests a exactement sept jours le verraient.
 *
 * Un `elapsed` negatif — un evenement date dans le futur du run — bloque par la
 * meme comparaison. C'est un etat incoherent que ce module ne sait pas arbitrer ;
 * ne pas trader est la reponse conservatrice.
 */
function blockingDelay(delay: ResolvedDelay, requiredDays: number): ArmedDelay | null {
  if (delay.state === 'NEVER' || delay.elapsed >= requiredDays) return null;

  return delay;
}

function cooldownConstat(blocking: ArmedDelay, requiredDays: number): string {
  return (
    `dernier arbitrage de ratio le ${blocking.since}` +
    `, ${String(blocking.elapsed)} jours ecoules sur les ${String(requiredDays)} du cooldown`
  );
}

/**
 * Le constat de carence. Il nomme un apport, pas « le dernier flux » : un
 * retrait ne gele rien, et ce motif part dans `decisions`, ou il doit se lire
 * sans avoir a deviner quel flux a compte.
 */
function freezeConstat(blocking: ArmedDelay, requiredDays: number): string {
  return (
    `apport du ${blocking.since}` +
    `, ${String(blocking.elapsed)} jours ecoules sur les ${String(requiredDays)} de carence`
  );
}

// --- Apports d'argent frais (carence du declencheur A) -----------------------

/**
 * Le dernier apport connu, ou l'etat illisible qui empeche de le designer.
 *
 * C'est le module qui filtre, et non l'appelant : « un `cash_flow` positif » est
 * la regle de C25, elle appartient a `core` et a sa couverture. Un retrait ne
 * gele rien — il retire du cash, il n'en pose pas a investir — et un flux nul
 * n'est pas un apport. D'ou `gt(ZERO)` plutot que `isPositive()`, qui repond
 * vrai sur zero dans decimal.js.
 *
 * Le balayage retient le jour le plus grand, donc son resultat ne depend pas de
 * l'ordre de la liste : l'appelant passe l'historique tel qu'il le tient, sans
 * avoir a le trier ni a le filtrer, et C23 tient quel que soit cet ordre. Un
 * retrait plus recent qu'un apport ne raccourcit rien, puisqu'il n'entre jamais
 * dans la comparaison.
 *
 * Un flux illisible arrete le run plutot que d'etre saute : le sauter en silence
 * ferait tirer A au lendemain d'un apport, ce qui est exactement le run que la
 * carence existe pour empecher.
 */
type FundingScan =
  | { readonly status: 'SCANNED'; readonly last: ReadDate | null }
  | {
      readonly status: 'UNREADABLE';
      readonly code: Extract<UndecidableCode, 'INVALID_DATE' | 'INVALID_CASH_FLOW'>;
      readonly reason: string;
    };

function lastFunding(flows: readonly CashFlow[]): FundingScan {
  let last: ReadDate | null = null;

  for (const flow of flows) {
    const read = readDate(flow.occurredOn);

    if (read === null) {
      return {
        status: 'UNREADABLE',
        code: 'INVALID_DATE',
        reason: `date de flux de tresorerie inexistante au calendrier : « ${flow.occurredOn} »`,
      };
    }

    /*
     * Un montant non fini n'a pas de signe : `gt` repond false sur un NaN, donc
     * le flux passerait pour un retrait et ne gelerait rien. Le refuser est la
     * meme parade que celle des cibles non finies.
     */
    if (!flow.amount.isFinite()) {
      return {
        status: 'UNREADABLE',
        code: 'INVALID_CASH_FLOW',
        reason: `montant du flux du ${read.date} non fini : « ${flow.amount.toString()} »`,
      };
    }

    if (flow.amount.gt(ZERO) && (last === null || read.day > last.day)) last = read;
  }

  return { status: 'SCANNED', last };
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
  /**
   * Date du dernier arbitrage de ratio effectivement passe, ou absente s'il n'y
   * en a jamais eu. C'est l'appelant qui la tient — le rejeu en phase 0, le job
   * quotidien ensuite — parce que `decide` est pure : elle n'a aucune memoire
   * d'un appel a l'autre et ne peut pas armer son propre compteur.
   *
   * Elle ne porte que les runs de B. La date du dernier reequilibrage de A vit
   * ailleurs, dans le `COOLDOWN` de `core/risk.ts`, et les deux compteurs sont
   * independants : c'est exactement ce que demande C12.
   */
  readonly lastRatioRebalanceOn?: IsoDate | null;
  /**
   * Les apports et retraits connus, dans l'ordre ou l'appelant les tient.
   * Absent quand il n'y en a aucun.
   *
   * La liste entiere, et non la date du dernier apport : c'est `decide` qui doit
   * dire ce qui compte comme apport, sinon la regle de C25 se retrouverait chez
   * l'appelant, hors de `core` et hors de sa couverture. Le cout est un
   * balayage par run sur une liste qui compte quelques dizaines de lignes.
   *
   * Rien n'y est consomme : contrairement au cooldown de B, dont l'appelant
   * avance la date a chaque arbitrage, la carence se lit sur un historique que
   * `decide` ne modifie pas — elle est pure comme le reste du module.
   */
  readonly cashFlows?: readonly CashFlow[];
}

/**
 * `INVALID_PARAMS` couvre une configuration incoherente, pas un etat de marche.
 * `INVALID_DATE` couvre une date de run, de dernier arbitrage ou de flux de
 * tresorerie qui n'existe pas au calendrier : depuis que deux delais se comptent
 * en jours, une date n'est plus une simple etiquette journalisee.
 * `INVALID_CASH_FLOW` couvre un montant de flux non fini, qui n'a pas de signe
 * et ne peut donc ni geler ni laisser passer.
 */
export type UndecidableCode =
  | ValuationIssue
  | 'INVALID_PARAMS'
  | 'INVALID_DATE'
  | 'INVALID_CASH_FLOW';

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
 * Cette priorite est mesuree par `rebalance-ab.test.ts`, sur des etats dont les
 * deux bandes sont franchies a la fois : c'est le seul endroit ou l'ordre des
 * deux blocs ci-dessous se voit.
 *
 * La carence s'intercale entre les deux, et elle ne fait pas sortir du bloc :
 * quand la bande de cash est franchie mais qu'un apport recent gele A, le run
 * continue vers B au lieu de tirer. C'est le fond de C26 — B ne touche pas a la
 * ligne cash, donc il ne peut pas investir l'apport que la carence protege — et
 * c'est ce qui donne a C11 sa lecture exacte : B est evalue des que A ne tire
 * pas. Le sauter aussi pendant une carence rendrait le gel de A contagieux.
 *
 * Chaque delai est le dernier gardien de son declencheur, apres sa bande et non
 * avant elle : une bande non franchie n'a rien a dire d'un compteur, et
 * l'annoncer dans `reason` ferait lire une occasion manquee la ou il n'y en
 * avait aucune.
 */
function aimOf(
  params: RebalanceParams,
  weights: Weights,
  cooldown: ResolvedDelay,
  freeze: ResolvedDelay,
): Aim {
  const band = cashBand(params);
  const position = locate(weights.USDC, band);
  const constats = [cashConstat(weights.USDC, band, position)];

  if (position.side !== 'INSIDE') {
    const frozen = blockingDelay(freeze, params.newCashFreezeDays);

    if (frozen === null) {
      return {
        trigger: 'CASH_BAND',
        weights: aimedWeights(params, position),
        reason: explain(constats, true, params.rebalanceMode),
      };
    }

    constats.push(freezeConstat(frozen, params.newCashFreezeDays));
  }

  if (!params.ratioBandEnabled) {
    return {
      trigger: 'NONE',
      weights: params.targets,
      reason: explain(constats, false, params.rebalanceMode),
    };
  }

  const rBand = ratioBand(params);
  const ratio = weights.BTC.div(weights.ETH);
  const rPosition = locateRatio(ratio, rBand);

  constats.push(ratioConstat(ratio, rBand, rPosition));

  if (rPosition.side === 'INSIDE' || rPosition.side === 'UNDEFINED') {
    return {
      trigger: 'NONE',
      weights: params.targets,
      reason: explain(constats, false, params.rebalanceMode),
    };
  }

  const blocking = blockingDelay(cooldown, params.ratioCooldownDays);

  if (blocking !== null) {
    constats.push(cooldownConstat(blocking, params.ratioCooldownDays));

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

  const runDate = clock.today();

  /*
   * La date de run est controlee pour toutes les configurations : elle est
   * journalisee dans `decisions`, elle ordonne le rejeu, et les deux delais du
   * module se comptent a partir d'elle. Une date qui n'existe pas au calendrier
   * est un etat illisible, pas une etiquette anodine.
   */
  const run = readDate(runDate);

  if (run === null) {
    return {
      status: 'UNDECIDABLE',
      code: 'INVALID_DATE',
      reason: `date de run inexistante au calendrier : « ${runDate} »`,
    };
  }

  const cooldown = ratioCooldown(run.day, state.lastRatioRebalanceOn ?? null);

  if (cooldown.state === 'UNREADABLE') {
    return { status: 'UNDECIDABLE', code: 'INVALID_DATE', reason: cooldown.reason };
  }

  const funding = lastFunding(state.cashFlows ?? []);

  if (funding.status === 'UNREADABLE') {
    return { status: 'UNDECIDABLE', code: funding.code, reason: funding.reason };
  }

  const valuation = valuate(state.holdings, state.prices);

  if (valuation.status === 'REJECTED') {
    return { status: 'UNDECIDABLE', code: valuation.code, reason: valuation.reason };
  }

  const aim = aimOf(params, valuation.weights, cooldown, delayFrom(run.day, funding.last));
  const triggered = aim.trigger !== 'NONE';

  return {
    status: 'DECIDED',
    intent: {
      runDate,
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
