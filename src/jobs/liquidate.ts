import { Decimal } from 'decimal.js';

import type { OpenOrder } from '../adapters/coinbase.js';
import { clientOrderId } from '../core/order-id.js';
import type { Holdings } from '../core/portfolio.js';
import { MIN_LEG_USDC, QUOTE } from '../core/risk.js';
import type { MidPrices, TradableAsset } from '../core/risk.js';
import type { IsoDate, Order, Price, Quantity, UsdcAmount } from '../core/types.js';
import type { ReconciledBalances } from './reconcile.js';

/**
 * La sortie propre de la spec §14 : le jour ou on veut arreter, on n'improvise
 * pas un script a la main. Le deroule complet existe donc des la phase 1, ecrit
 * et relu a froid — et **il ne peut pas s'appliquer**.
 *
 * Ce module est une **fonction de calcul**. Il prend un etat deja lu et rend une
 * **sequence d'intentions** : ce qu'il faudrait faire, dans l'ordre du §14,
 * jamais un appel a l'exchange. Meme forme que `reconcile.ts`, qui calcule et
 * rend les transitions d'ordres sans en persister aucune.
 *
 * La difference entre une intention et un ordre parti n'est pas une convention
 * de nommage, elle est structurelle. Quatre proprietes la tiennent, toutes
 * sondees par `test/jobs/liquidate-verrou.test.ts` :
 *
 * 1. **Ce module est synchrone** (V6) — ni `async`, ni `await`, ni promesse, et
 *    c'est un lint sur l'arbre du fichier livre, pas une affirmation d'en-tete.
 *    Une fonction qui ne sait pas attendre ne sait pas parler a un exchange.
 * 2. **Ses imports sont enumeres** (V7) — `decimal.js`, quatre modules de
 *    `core/`, et deux **types**. Un `import type` est efface a la compilation :
 *    ni `ccxt` ni `pg` n'est joignable d'ici.
 * 3. **Il ne prend aucun port** (V10) — `SortieInput` ne porte que des donnees.
 * 4. **`appliquerSortie` ne rend qu'une forme, le refus** (V10) —
 *    `SortieVerrouillee` n'est pas une union : aucun type ne decrit un succes
 *    d'application. Le verrou ne se leve pas, il se retire, en ecrivant ce type
 *    et son chemin. Il n'a aucun parametre : ni argument, ni variable
 *    d'environnement, ni drapeau d'aucune sorte.
 *
 * Ce module n'est **pas** un point d'entree — la commande CLI du §14 n'existe
 * pas —, **pas** une validation de risque — `validate()` n'est pas appele, et
 * V7 le verifie —, et son rapport est **projete**, pas constate.
 *
 * `docs/sortie-propre.md` porte les motifs : pourquoi les seuils de
 * rebalancement ne s'appliquent pas a un arret, ce que le verrou ne prouve pas,
 * le decalage des numeros de jambe, et le point laisse ouvert sur l'ordre des
 * etapes.
 */

/** Une entree dont la sortie ne peut rien faire : elle refuse au lieu de deviner. */
export class SortieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SortieError';
  }
}

// --- Le verrou --------------------------------------------------------------

/**
 * Les deux phases du §13 qui comptent ici. Elles ne pilotent aucune condition :
 * ce sont les valeurs que le refus **cite**, pour qu'il dise pourquoi il refuse
 * plutot que de refuser sans rien dire.
 *
 * Un drapeau aurait ete le contraire d'un verrou. `PHASE_COURANTE` pose a 3 ne
 * debloquerait rien : il faudrait encore ecrire le type du succes, le chemin qui
 * l'emprunte, et le port qui l'applique — c'est-a-dire le lot de phase 3, relu.
 */
export const PHASE_COURANTE = 1;

/** La phase ou l'execution est activee (§13). La sortie ne s'applique pas avant. */
export const PHASE_D_APPLICATION = 3;

// --- Parametres d'execution, spec §7 ----------------------------------------

/**
 * Le mid ± 0,1 % du §7. Une vente se pose **au-dessus** du mid : c'est ce qui la
 * laisse au repos dans le carnet, donc ce qui la rend acceptable en post-only.
 * Une vente sous le mid croiserait le carnet et l'exchange la refuserait — le
 * signe de cette marge est la moitie utile du post-only, la seconde etant le
 * drapeau lui-meme.
 */
export const MARGE_LIMITE_PCT = new Decimal('0.001');

/**
 * Le decalage des numeros de jambe de la sortie.
 *
 * Le `client_order_id` du §7 est `sha256(run_date | asset | side | leg_index)`.
 * Une sortie lancee le jour d'un reequilibrage vendrait BTC en `SELL` avec le
 * meme `leg_index` que le run quotidien, donc **sous le meme identifiant** :
 * l'exchange avalerait la seconde au titre du doublon, et le portefeuille
 * resterait a moitie liquide sans qu'aucune erreur ne remonte. Le decalage ecarte
 * les deux espaces de numerotation.
 *
 * Ce n'est pas la solution de fond. Celle-ci consiste a donner a la sortie son
 * propre domaine dans `src/core/order-id.ts` — le module en a deja un, versionne.
 * Elle touche `src/core/`, ce lot n'en a pas mandat. Le decalage est ce qui tient
 * en attendant, et `test/jobs/liquidate.test.ts` constate qu'il tient.
 */
export const DECALAGE_DE_JAMBE = 900;

/** Le cron du §8, celui que l'etape 3 desarme. */
export const CRON_QUOTIDIEN = '0 7 * * *';

/**
 * Les lignes cessibles, dans l'ordre ou la sortie les traite. USDC n'en est pas :
 * c'est la destination, pas une position.
 */
const CESSIBLES = ['BTC', 'ETH'] as const satisfies readonly TradableAsset[];

// --- Le deroule du §14 ------------------------------------------------------

/** Les quatre etapes du §14, dans leur ordre. */
export type EtapeDeSortie = 'ANNULATION' | 'CESSION' | 'DECLENCHEUR' | 'RAPPORT';

/**
 * Le §14 enumere, ce tableau le recopie, et `test/jobs/liquidate.test.ts`
 * confronte le plan a ce tableau plutot qu'a une liste reecrite dans le test.
 * Les trois premieres etapes sont des intentions ; la quatrieme n'en est pas
 * une, c'est `PlanDeSortie.rapport` — le rapport se produit, il ne s'applique
 * pas a l'exchange.
 */
export const ETAPES: readonly EtapeDeSortie[] = [
  'ANNULATION',
  'CESSION',
  'DECLENCHEUR',
  'RAPPORT',
];

/**
 * Etape 1 : un ordre ouvert a retirer du carnet. **Tous** les ordres ouverts, y
 * compris ceux que la base ne reclame pas et ceux libelles dans une autre
 * contrepartie : retirer un ordre n'est ni une cession ni un fait generateur,
 * et en laisser un en vol immobiliserait la quantite que l'etape 2 doit vendre.
 */
export interface IntentionDAnnulation {
  readonly etape: 'ANNULATION';
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly product: string;
}

/**
 * Etape 2 : une position cedee vers USDC. `ordre` est le type du noyau, donc sa
 * contrepartie est le litteral `'USDC'` — une paire `*-EUR` n'a pas de forme ici,
 * et le §11 en fait un fait generateur d'imposition que l'agent ne produit sous
 * aucune condition.
 */
export interface IntentionDeCession {
  readonly etape: 'CESSION';
  readonly product: string;
  /** Toujours vrai, et du type `true` : le §7 n'admet aucun autre ordre. */
  readonly postOnly: true;
  /** Le mid qui a servi de reference, pour que le prix limite soit verifiable. */
  readonly mid: Price;
  readonly ordre: Order;
}

/**
 * Etape 3 : le declencheur quotidien, desarme. Ce n'est pas un ordre mais une
 * operation d'infrastructure ; la phase 1 n'a pas de Scaleway, donc l'intention
 * nomme ce qu'il faut desarmer et pourquoi.
 */
export interface IntentionDeDeclencheur {
  readonly etape: 'DECLENCHEUR';
  readonly cron: string;
  readonly motif: string;
}

export type IntentionDeSortie = IntentionDAnnulation | IntentionDeCession | IntentionDeDeclencheur;

// --- Etape 4 : le rapport ---------------------------------------------------

export interface LigneDeCession {
  readonly asset: TradableAsset;
  readonly quantity: Quantity;
  readonly limitPrice: Price;
  /** Produit **au prix limite**, donc attendu et non constate. */
  readonly produitUsdc: UsdcAmount;
  readonly clientOrderId: string;
}

/** Une ligne trop petite pour etre cedee : elle reste, et le rapport le dit. */
export interface LigneDeResidu {
  readonly asset: TradableAsset;
  readonly quantity: Quantity;
  readonly valeurUsdc: UsdcAmount;
  readonly motif: string;
}

/**
 * Etape 4 : le recapitulatif.
 *
 * `statut` vaut `PROJETE` et n'a pas d'autre valeur. Le §14 decrit un rapport
 * **final**, donc posterieur aux executions ; celui-ci precede tout, puisque
 * rien ne s'execute. Le dire dans le type evite qu'un lecteur prenne des
 * montants au prix limite pour des montants encaisses.
 */
export interface RapportDeSortie {
  readonly runDate: IsoDate;
  readonly statut: 'PROJETE';
  readonly ordresRetires: number;
  readonly cessions: readonly LigneDeCession[];
  readonly residus: readonly LigneDeResidu[];
  readonly produitTotalUsdc: UsdcAmount;
  /** USDC deja detenu, requalifie ici en somme d'argent : c'est une decision du job. */
  readonly usdcInitial: UsdcAmount;
  /** `usdcInitial + produitTotalUsdc`, au prix limite. Le fond de la sortie. */
  readonly usdcProjete: UsdcAmount;
}

export interface PlanDeSortie {
  readonly runDate: IsoDate;
  /** Les etapes 1 a 3, dans l'ordre du §14. L'etape 4 est `rapport`. */
  readonly intentions: readonly IntentionDeSortie[];
  readonly rapport: RapportDeSortie;
}

/**
 * Ce que la sortie consomme : **des donnees, aucun port**.
 *
 * `soldes` est un `ReconciledBalances`, que seul `reconcile.ts` sait fabriquer —
 * son symbole de marque n'est pas exporte. On ne liquide donc pas sur un etat
 * qu'un appelant se serait compose : la meme garantie qui fait que le run
 * quotidien ne decide pas avant d'avoir reconcilie.
 */
export interface SortieInput {
  readonly runDate: IsoDate;
  readonly soldes: ReconciledBalances;
  /** Les ordres ouverts lus sur l'exchange, tels quels. */
  readonly ouverts: readonly OpenOrder[];
  readonly mids: MidPrices;
}

/**
 * La seule forme que rend `appliquerSortie`. Pas une union : il n'existe aucun
 * type pour une sortie appliquee, et c'est cela, le verrou.
 */
export interface SortieVerrouillee {
  readonly statut: 'VERROUILLE';
  readonly phase: number;
  readonly phaseRequise: number;
  readonly motif: string;
  /** Le plan reste rendu : savoir ce qui **serait** fait est tout l'interet. */
  readonly plan: PlanDeSortie;
}

// --- Briques ----------------------------------------------------------------

const ZERO = new Decimal(0);

/**
 * L'aller-retour ISO comme dans `daily.ts` : il refuse a la fois la date
 * impossible et le report silencieux du 30 fevrier au 2 mars. Une `runDate`
 * fautive ne casse rien de visible, elle decale l'espace des `client_order_id`.
 */
function jourUtc(runDate: IsoDate): IsoDate {
  const instant = new Date(`${runDate}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== runDate) {
    throw new SortieError(
      `runDate : date UTC attendue au format YYYY-MM-DD, recue "${runDate}".`,
    );
  }
  return runDate;
}

/**
 * La paire d'une cession. La contrepartie vient de `core/risk.ts` et vaut USDC :
 * le §11 interdit `*-EUR`, une cession vers EUR etant un fait generateur
 * d'imposition en France.
 */
function paire(asset: TradableAsset): string {
  return `${asset}-${QUOTE}`;
}

function midDe(asset: TradableAsset, mids: MidPrices): Price {
  const mid = mids[asset];
  if (mid === undefined) {
    throw new SortieError(
      `${asset} : aucun prix de reference, le prix limite de la cession n'est calculable a rien.`,
    );
  }
  if (!mid.isFinite() || mid.lte(ZERO)) {
    throw new SortieError(
      `${asset} : prix de reference a ${mid.toString()}, un mid nul, negatif ou non fini ne cote rien.`,
    );
  }
  return mid;
}

/** Mid + 0,1 % : au repos dans le carnet, donc acceptable en post-only. */
function prixLimiteDeVente(mid: Price): Price {
  return mid.mul(new Decimal(1).add(MARGE_LIMITE_PCT)) as Price;
}

function quantiteDe(asset: TradableAsset, holdings: Holdings): Quantity {
  const quantite = holdings[asset];
  if (!quantite.isFinite()) {
    throw new SortieError(
      `${asset} : solde reconcilie a ${quantite.toString()}. Un solde non fini ne franchit aucun seuil — ni le plancher, ni le zero — et produirait une cession de quantite indefinie.`,
    );
  }
  if (quantite.lt(ZERO)) {
    throw new SortieError(
      `${asset} : solde reconcilie negatif (${quantite.toString()}). Le portefeuille est au comptant, un tel solde n'est pas un etat a liquider.`,
    );
  }
  return quantite;
}

// --- Etape 1 ----------------------------------------------------------------

/**
 * Tous les ordres ouverts, tries par identifiant d'exchange. Le tri n'est pas
 * cosmetique : il rend le plan identique d'une lecture a l'autre, alors que
 * l'ordre de la reponse de l'API n'est garanti nulle part.
 */
function annulations(ouverts: readonly OpenOrder[]): readonly IntentionDAnnulation[] {
  return [...ouverts]
    .sort((a, b) => (a.exchangeId < b.exchangeId ? -1 : a.exchangeId > b.exchangeId ? 1 : 0))
    .map((ouvert) => ({
      etape: 'ANNULATION' as const,
      exchangeId: ouvert.exchangeId,
      clientOrderId: ouvert.clientOrderId,
      product: ouvert.product,
    }));
}

// --- Etape 2 ----------------------------------------------------------------

interface Cessions {
  readonly intentions: readonly IntentionDeCession[];
  readonly lignes: readonly LigneDeCession[];
  readonly residus: readonly LigneDeResidu[];
}

/**
 * Les positions vers USDC.
 *
 * La quantite cedee est le solde **total**, gele compris : l'etape 1 retire les
 * ordres en vol, donc ce qui etait immobilise redevient disponible avant que
 * cette etape ne s'applique. Ceder le seul disponible laisserait derriere elle
 * exactement la part qu'un ordre ouvert tenait.
 *
 * Sous `MIN_LEG_USDC`, la ligne devient un residu au lieu d'un ordre : le seuil
 * est celui du noyau, et un ordre sous le minimum est refuse par l'exchange
 * plutot qu'execute. Une sortie qui laisse 12 USDC de poussiere est une sortie
 * propre ; une sortie qui emet un ordre irrecevable ne l'est pas.
 */
function cessions(runDate: IsoDate, holdings: Holdings, mids: MidPrices): Cessions {
  const intentions: IntentionDeCession[] = [];
  const lignes: LigneDeCession[] = [];
  const residus: LigneDeResidu[] = [];

  for (const asset of CESSIBLES) {
    const quantity = quantiteDe(asset, holdings);
    if (quantity.isZero()) continue;

    const mid = midDe(asset, mids);
    const valeur = quantity.mul(mid) as UsdcAmount;
    // Strict, comme `risk.ts` : une ligne a 200 USDC pile se cede.
    if (valeur.lt(MIN_LEG_USDC)) {
      residus.push({
        asset,
        quantity,
        valeurUsdc: valeur,
        motif: `${valeur.toString()} USDC au mid, sous le minimum de ${MIN_LEG_USDC.toString()} USDC : l'ordre serait refuse.`,
      });
      continue;
    }

    /*
     * Le numero de jambe suit le rang dans cette sequence, decale. Il depend de
     * la sequence et non de l'actif : deux sorties du meme jour sur le meme etat
     * redonnent les memes identifiants, ce qui est exactement la protection
     * contre le doublon que le §7 attend d'un rejeu.
     */
    const legIndex = DECALAGE_DE_JAMBE + intentions.length;
    const limitPrice = prixLimiteDeVente(mid);
    const identifiant = clientOrderId({ runDate, asset, side: 'SELL', legIndex });
    const ordre: Order = {
      clientOrderId: identifiant,
      asset,
      quote: QUOTE,
      side: 'SELL',
      quantity,
      limitPrice,
    };

    intentions.push({ etape: 'CESSION', product: paire(asset), postOnly: true, mid, ordre });
    lignes.push({
      asset,
      quantity,
      limitPrice,
      produitUsdc: quantity.mul(limitPrice) as UsdcAmount,
      clientOrderId: identifiant,
    });
  }

  return { intentions, lignes, residus };
}

// --- Etape 3 ----------------------------------------------------------------

function declencheur(): IntentionDeDeclencheur {
  return {
    etape: 'DECLENCHEUR',
    cron: CRON_QUOTIDIEN,
    motif:
      "le run quotidien ne doit plus se declencher : laisse arme, le premier run qui suit la sortie relirait un portefeuille tout en cash et reconstituerait les positions que la sortie vient de ceder.",
  };
}

// --- Le plan ----------------------------------------------------------------

/**
 * Le deroule du §14, dans l'ordre de la spec : retirer les ordres ouverts, ceder
 * vers USDC, desarmer le declencheur, recapituler.
 *
 * Cette fonction est **pure** : memes entrees, meme plan, aucun effet. C'est ce
 * qui permet de l'eprouver entierement en phase 1 alors que rien ne s'execute.
 *
 * L'ordre est celui de la spec et pas celui qu'on choisirait : desarmer le
 * declencheur en premier fermerait la fenetre pendant laquelle un run quotidien
 * peut tomber au milieu d'une sortie. Le point est ouvert et documente dans
 * `docs/sortie-propre.md` ; le trancher est une decision, pas un ajustement.
 */
export function planifierSortie(entree: SortieInput): PlanDeSortie {
  const runDate = jourUtc(entree.runDate);
  const retraits = annulations(entree.ouverts);
  const cedees = cessions(runDate, entree.soldes.holdings, entree.mids);

  const produitTotalUsdc = cedees.lignes.reduce<Decimal>(
    (total, ligne) => total.add(ligne.produitUsdc),
    ZERO,
  ) as UsdcAmount;
  /*
   * La ligne USDC des soldes est une `Quantity` : `portfolio.ts` la tient ainsi
   * meme pour la contrepartie, et sa requalification en somme d'argent est une
   * decision du job, qui doit s'ecrire. Elle s'ecrit ici.
   */
  const usdcInitial = entree.soldes.holdings.USDC as Decimal as UsdcAmount;
  if (!usdcInitial.isFinite() || usdcInitial.lt(ZERO)) {
    throw new SortieError(
      `USDC : solde reconcilie a ${usdcInitial.toString()}, qui n'est pas un montant de cash valide.`,
    );
  }

  return {
    runDate,
    intentions: [...retraits, ...cedees.intentions, declencheur()],
    rapport: {
      runDate,
      statut: 'PROJETE',
      ordresRetires: retraits.length,
      cessions: cedees.lignes,
      residus: cedees.residus,
      produitTotalUsdc,
      usdcInitial,
      usdcProjete: usdcInitial.add(produitTotalUsdc) as UsdcAmount,
    },
  };
}

/**
 * Le point que la commande de sortie appellerait. Il **refuse**, toujours, et
 * rend le plan avec son refus.
 *
 * Il n'y a rien a lui passer pour qu'il fasse autre chose : pas de second
 * parametre, pas de champ d'entree, pas de variable d'environnement — `src/jobs/`
 * n'en lit aucune. Le refus ne se leve pas, il se **retire**, en ecrivant le type
 * d'un succes, le chemin qui y mene et le port qui l'applique. C'est le lot de
 * la phase 3, et il passera en revue comme le reste.
 */
export function appliquerSortie(entree: SortieInput): SortieVerrouillee {
  return {
    statut: 'VERROUILLE',
    phase: PHASE_COURANTE,
    phaseRequise: PHASE_D_APPLICATION,
    motif: `la sortie ne s'applique qu'a partir de la phase ${String(PHASE_D_APPLICATION)} (§13) ; le depot est en phase ${String(PHASE_COURANTE)}, ou aucun ordre ne part. Le plan ci-joint dit ce qui serait fait ; rien ne le fait.`,
    plan: planifierSortie(entree),
  };
}
