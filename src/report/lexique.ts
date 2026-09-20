import { SHARPE_WINDOW } from '../core/benchmark.js';
import type { RejectionCode, Trigger } from '../core/types.js';

/**
 * Le **vocabulaire** du rapport quotidien, et rien d'autre. Pur, sans mise en
 * forme : `daily-report.ts` en fait une section, ce module dit quoi y mettre.
 *
 * Trois proprietes le tiennent :
 *
 * 1. **le terme d'une entree est ce que le corps imprime**, pas le nom savant de
 *    la chose. Un operateur qui bute sur « Risque » cherche « risque », pas
 *    « verdict de la couche de risque ». C'est aussi ce qui rend R3 verifiable :
 *    une entree dont le terme n'apparait nulle part dans le corps est une entree
 *    morte, et le test la refuse ;
 * 2. **les deux vocabulaires fermes du noyau sont exhaustifs par le typage** —
 *    `Record<Trigger, string>` et `Record<RejectionCode, string>`. Un code ajoute
 *    au noyau sans sa glose fait echouer `tsc` chez celui qui l'ajoute, pas chez
 *    le lecteur du rapport six mois plus tard ;
 * 3. **le texte est sans accent**, comme tout le corps du rapport et comme les
 *    `reason` du noyau qu'il cite telles quelles.
 *
 * Les entrees conditionnelles suivent ce que le rapport du jour imprime : gloser
 * les neuf codes de refus tous les jours serait neuf lignes de bruit pour des
 * rejets qui n'arrivent pas en phase 1.
 */

export interface EntreeLexique {
  /** Le mot tel que le corps du rapport l'imprime. */
  readonly terme: string;
  /** Une phrase, et une seule. */
  readonly definition: string;
}

/** Ce que le rapport du jour imprime, et qui decide des entrees conditionnelles. */
export interface LexiqueContexte {
  /** Les triggers effectivement rendus, doublons compris : ce module les reduit. */
  readonly triggers: readonly Trigger[];
  /** Les codes de refus effectivement rendus. */
  readonly rejets: readonly RejectionCode[];
  /** L'encadre de suspension est-il present. */
  readonly suspendu: boolean;
  /** Le tableau « Metriques indisponibles » est-il present. */
  readonly metriquesIndisponibles: boolean;
}

const entree = (terme: string, definition: string): EntreeLexique => ({ terme, definition });

/**
 * Les entrees presentes chaque jour, parce que les titres de section et les
 * en-tetes de colonne qui les portent le sont. L'ordre est celui de la lecture :
 * les mots de l'en-tete d'abord, ceux du bas du rapport ensuite.
 */
const FIXES: readonly EntreeLexique[] = [
  entree(
    'P&L',
    "Profit and loss : ce que le portefeuille a gagne ou perdu sur la periode, en pourcentage de ce qu'il valait.",
  ),
  entree(
    'TWR',
    "Time-weighted return : le rendement une fois les apports et les retraits neutralises, donc ce que la gestion a fait et non ce qu'un virement a ajoute.",
  ),
  entree(
    'indice de croissance',
    "Le cumul des rendements quotidiens, flux exclus, parti de 1,00 a la premiere photo : a 1,25 le portefeuille a gagne 25 % depuis l'origine.",
  ),
  entree(
    'photo',
    "L'etat du portefeuille enregistre une fois par jour — valeur, poids, quantites et metriques — et jamais recalcule ensuite.",
  ),
  entree(
    'prix de cloture',
    "Le dernier cours du dernier jour clos, le seul qui ne bouge plus ; celui du jour en cours change encore, et une decision prise dessus serait fausse sans qu'aucun seuil ne morde.",
  ),
  entree(
    'USDC',
    "Le dollar numerique qui sert de monnaie au portefeuille : tout y est valorise, et le cash n'est detenu que sous cette forme.",
  ),
  entree(
    'bande',
    "L'intervalle dans lequel une grandeur surveillee a le droit de flotter sans qu'aucun reequilibrage ne soit propose.",
  ),
  entree(
    'borne',
    "L'une des deux extremites d'une bande. Elle appartient a la bande : etre exactement dessus ne declenche rien, le pas suivant si.",
  ),
  entree(
    'trigger',
    "Ce qui a declenche la decision du jour, ou NONE quand rien ne l'a declenchee.",
  ),
  entree(
    'jambe',
    "Un ordre elementaire d'un reequilibrage : un actif, un sens et un montant. Une decision en compte zero, une, ou plusieurs.",
  ),
  entree(
    'risque',
    'Le verdict de la couche de risque sur la decision du jour : ACCEPTED si elle passe, REJECTED suivi du code du refus sinon.',
  ),
  entree(
    'poids',
    'La part que represente une ligne dans la valeur totale, en pourcentage. La colonne Cible donne la part visee, la colonne Ecart la difference des deux.',
  ),
  entree(
    'ombre',
    "Une strategie evaluee chaque jour mais qui ne place jamais d'ordre : elle sert de point de comparaison, pas de gestion.",
  ),
  entree(
    'hold',
    "Ne rien faire, et le mesurer : Hold BTC garde du BTC seul, Hold 50/50 garde moitie BTC moitie ETH, aucun des deux n'arbitre jamais.",
  ),
  entree(
    'ladder',
    "Une strategie en echelle : une ancre par actif, un achat quand le cours passe un palier sous elle, une vente quand il en passe un au-dessus. En phase 1 elle est en ombre.",
  ),
  entree(
    'DCA',
    'Dollar cost averaging : acheter un montant fixe a intervalle fixe, sans regarder le cours. En phase 1 elle est en ombre.',
  ),
  entree(
    'max drawdown',
    "La pire baisse jamais subie entre un sommet et le creux qui l'a suivi, sur toute la periode mesuree.",
  ),
  entree(
    'recul actuel depuis le plus haut',
    "De combien l'indice est descendu sous son plus haut connu, aujourd'hui et non dans le passe. C'est la mesure sur laquelle la suspension se declenche.",
  ),
  entree(
    `Sharpe ${String(SHARPE_WINDOW)} j`,
    `Le rendement rapporte a son agitation sur les ${String(SHARPE_WINDOW)} derniers jours : plus il est haut, plus la performance a ete reguliere plutot que chanceuse.`,
  ),
  entree(
    'fenetre OHLCV',
    'Le nombre de jours de cours — ouverture, haut, bas, cloture, volume — que le run a relus pour calculer les courbes de reference.',
  ),
];

/**
 * Les trois valeurs de `Trigger`, fermees par le typage. En ajouter une au noyau
 * sans sa glose fait echouer `tsc` : c'est l'exhaustivite qui est tenue, pas la
 * relecture.
 */
const TRIGGERS: Readonly<Record<Trigger, string>> = {
  NONE: "Aucune bande n'est franchie : le run constate l'etat du portefeuille et ne propose rien.",
  CASH_BAND:
    "Le poids de l'USDC est sorti de sa bande : le declencheur A propose un retour aux cibles.",
  RATIO_BAND:
    'Le ratio BTC/ETH est sorti de sa bande : le declencheur B propose un arbitrage entre ces deux lignes seules.',
};

/** Les neuf codes de refus du noyau, fermes par le typage comme les triggers. */
const REJETS: Readonly<Record<RejectionCode, string>> = {
  ASSET_NOT_ALLOWED: "La decision touche un actif qui n'est pas sur la liste autorisee.",
  QUOTE_NOT_ALLOWED: "La decision passe par une monnaie de cotation autre que l'USDC.",
  MAX_EXPOSURE: 'La decision porterait une ligne au-dela de son exposition maximale.',
  MIN_CASH: 'La decision laisserait moins de cash que le plancher exige.',
  REBALANCE_TOO_LARGE:
    "Le reequilibrage deplacerait une part du portefeuille superieure au plafond d'un seul mouvement.",
  LEG_TOO_SMALL: 'Une jambe porte un montant trop petit pour valoir ses frais.',
  COOLDOWN: "Un reequilibrage trop recent interdit d'en declencher un autre tout de suite.",
  PRICE_SANITY: "Le prix limite d'une jambe s'ecarte trop du cours constate pour etre credible.",
  RECONCILIATION_DRIFT:
    "Les soldes lus sur l'exchange ne concordent pas avec la derniere photo : rien n'est decide tant que l'ecart n'est pas explique.",
};

const SUSPENSION = entree(
  'suspension',
  'La production est mise en pause parce que le recul depuis le plus haut a franchi son seuil ; aucun ordre ne sera propose tant qu\'elle dure.',
);

const CLE = entree(
  'cle',
  'Le nom sous lequel la photo range une metrique : le nom de la strategie, un tiret bas, puis celui de la metrique — hold_btc_twr est le TWR du hold BTC.',
);

/** L'ordre de declaration, sans doublon. Deux strategies au meme trigger ne le glosent pas deux fois. */
function uniques<T extends string>(valeurs: readonly T[], ordre: readonly T[]): readonly T[] {
  return ordre.filter((valeur) => valeurs.includes(valeur));
}

const ORDRE_TRIGGERS = Object.keys(TRIGGERS) as readonly Trigger[];
const ORDRE_REJETS = Object.keys(REJETS) as readonly RejectionCode[];

/**
 * Le lexique du rapport du jour : le vocabulaire fixe, puis ce que ce rapport-la
 * imprime en plus. Toujours dans le meme ordre — un lexique qui se reordonne
 * d'un jour sur l'autre se relit comme un rapport different.
 */
export function lexique(contexte: LexiqueContexte): readonly EntreeLexique[] {
  return [
    ...FIXES,
    ...uniques(contexte.triggers, ORDRE_TRIGGERS).map((trigger) =>
      entree(trigger, TRIGGERS[trigger]),
    ),
    ...uniques(contexte.rejets, ORDRE_REJETS).map((code) => entree(code, REJETS[code])),
    ...(contexte.suspendu ? [SUSPENSION] : []),
    ...(contexte.metriquesIndisponibles ? [CLE] : []),
  ];
}
