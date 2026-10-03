import { createHash } from 'node:crypto';

import { Decimal } from 'decimal.js';

import type {
  Achat,
  Convoyage,
  DernierConvoyage,
  Etape,
  EurAmount,
  Priorite,
  UsdcAmount,
} from './types.js';

/**
 * Les regles du convoyeur (lot Y2 du plan `ubac-convoyeur`). Aucune IO, aucune
 * horloge, aucun `number` sur un montant : le passage (Y4b) lit, appelle ces
 * regles, et agit.
 */

// --- Montant ------------------------------------------------------------------

/** Q3, Q6 : exactement 100 EUR par passage, jamais plus, jamais moins. */
export const MONTANT_CONVOYE = new Decimal('100') as EurAmount;

/**
 * Decision de l'operateur du 2026-10-03 (spec, DC10) : un USDC de *Primary*
 * strictement sous ce seuil est de la poussiere. Sans convoyage ouvert, il
 * n'est pas etranger (CV10) ; pendant un convoyage, il n'est pas l'USDC de
 * l'achat. Il n'est jamais transfere, et il est dit dans la notification.
 */
export const SEUIL_POUSSIERE_USDC = new Decimal('1') as UsdcAmount;

/** Un USDC lisible, positif ou nul, strictement sous `SEUIL_POUSSIERE_USDC`. */
export function estPoussiere(usdc: UsdcAmount): boolean {
  return usdc.isFinite() && usdc.gte(0) && usdc.lt(SEUIL_POUSSIERE_USDC);
}

/** Le surplus laisse dans *Primary* quand un convoyage commence (CV7). */
export function surplus(eurDisponible: EurAmount): EurAmount {
  return eurDisponible.minus(MONTANT_CONVOYE) as EurAmount;
}

/**
 * CV8 : l'USDC a transferer est celui que l'ordre a recu, `filled_size`, tel
 * quel. Jamais le solde relu : un solde qui differe de `filled_size` est une
 * anomalie (piege 4), et la table de reprise l'arrete au lieu de la deplacer.
 */
export function montantATransferer(achat: Achat): UsdcAmount {
  return achat.filledSize;
}

/**
 * L'EUR debite par l'achat : `filled_value` hors frais, plus `total_fees`. Les
 * frais d'un `BUY` USDC-EUR sont en EUR (piege 4), l'USDC recu ne les porte pas.
 */
export function eurDebite(achat: Achat): EurAmount {
  return achat.filledValue.plus(achat.totalFees) as EurAmount;
}

// --- Identifiant --------------------------------------------------------------

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Un jour de calendrier reel, pas seulement de la bonne forme : `2026-02-30`
 * donnerait un identifiant que rien ne peut reproduire depuis un instant.
 */
function estJour(texte: string): boolean {
  if (!JOUR.test(texte)) return false;
  const date = new Date(`${texte}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === texte;
}

/**
 * Le convoyage qu'ouvrirait un passage a cet instant : son jour UTC. L'instant
 * est un parametre ; l'heure d'ete ne change rien (U7), seul le jour UTC compte.
 */
export function jourDuPassage(instant: Date): Convoyage {
  // `toISOString` leve `RangeError` sur un instant invalide ; l'annee a cinq chiffres, ici.
  const jour = instant.toISOString().slice(0, 10);
  if (!estJour(jour)) throw new RangeError(`jourDuPassage : ${instant.toISOString()} sans jour.`);
  return jour;
}

/**
 * Le motif de `src/core/order-id.ts`, recopie et non importe (plan, point 1) :
 * domaine propre et versionne, encodage prefixe par longueur, sha256 tronque a
 * 24 hexadecimaux (34 caracteres, sous la limite usuelle de 36).
 */
const DOMAINE_CLIENT_ORDER_ID = 'ubac.convoyeur.client-order-id.v1';

/**
 * CV6 : le `client_order_id` du `BUY` d'un convoyage, derive de son jour. Un
 * rejeu redit le meme identifiant, et l'exchange rend l'ordre existant au lieu
 * d'en creer un second (S5). Le test fige la valeur.
 */
export function clientOrderIdConvoyage(convoyage: Convoyage): string {
  if (!estJour(convoyage)) {
    throw new RangeError(
      `clientOrderIdConvoyage : ${JSON.stringify(convoyage)} n'est pas un jour YYYY-MM-DD.`,
    );
  }
  const canonique = [DOMAINE_CLIENT_ORDER_ID, convoyage]
    .map((champ) => `${String(champ.length)}:${champ}`)
    .join('');
  const digest = createHash('sha256').update(canonique, 'utf8').digest('hex');
  return `convoyeur-${digest.slice(0, 24)}`;
}

// --- Cle et portefeuilles -----------------------------------------------------

export type Verdict = { readonly admis: true } | { readonly admis: false; readonly motif: string };

const ADMIS: Verdict = { admis: true };

const refus = (motif: string): Verdict => ({ admis: false, motif });

/**
 * Seul le booleen `true` vaut permission : `"true"`, `1` ou un champ absent ne
 * prouvent rien. La lecture de `permissionsFrom` d'Ubac, retournee : une cle qui
 * ne peut pas transferer ne doit pas convertir (DC2).
 */
function accordee(reponse: Readonly<Record<string, unknown>>, nom: string): Verdict {
  if (reponse[nom] === true) return ADMIS;
  const lu = nom in reponse ? JSON.stringify(reponse[nom]) : 'absent';
  return refus(`key_permissions : ${nom} vaut ${lu}, seul le booleen true vaut permission.`);
}

/**
 * CV1, DC2 : la cle est-elle celle du convoyeur ? Scopee sur l'UUID de
 * *Primary* que l'operateur a pose, a egalite exacte ; de type `DEFAULT` ;
 * `can_view`, `can_trade` et `can_transfer` au booleen `true`.
 */
export function verifierCle(
  reponse: Readonly<Record<string, unknown>>,
  primaryUuid: string,
): Verdict {
  const portefeuille = reponse['portfolio_uuid'];
  if (portefeuille !== primaryUuid) {
    return refus(
      `key_permissions : la cle est scopee sur ${JSON.stringify(portefeuille)}, alors que Primary attend ${primaryUuid}.`,
    );
  }
  const type = JSON.stringify(reponse['portfolio_type']);
  if (reponse['portfolio_type'] !== 'DEFAULT') {
    return refus(`key_permissions : portfolio_type vaut ${type}, alors que Primary est DEFAULT.`);
  }
  for (const nom of ['can_transfer', 'can_trade', 'can_view']) {
    const verdict = accordee(reponse, nom);
    if (!verdict.admis) return verdict;
  }
  return ADMIS;
}

export interface Portefeuilles {
  readonly primaryUuid: string;
  readonly destinationUuid: string;
}

/**
 * CV2, DC2 : un `move_funds` n'a qu'une source et qu'une destination, a
 * egalite exacte avec la configuration. Ni prefixe, ni casse, ni espace : un
 * UUID altere d'un caractere est un autre portefeuille.
 */
export function transfertAdmis(
  demande: { readonly source: string; readonly destination: string },
  attendus: Portefeuilles,
): Verdict {
  if (demande.source !== attendus.primaryUuid) {
    return refus(`move_funds : source ${demande.source}, seul Primary ${attendus.primaryUuid}.`);
  }
  if (demande.destination !== attendus.destinationUuid) {
    return refus(
      `move_funds : destination ${demande.destination}, seul ubac-agent ${attendus.destinationUuid}.`,
    );
  }
  return ADMIS;
}

// --- Reprise ------------------------------------------------------------------

/**
 * Ou est l'USDC d'un achat, d'apres le solde relu de *Primary* (DC3, DC10) :
 *
 * - `PRESENT` : le solde est `montant` plus une poussiere, `0 <= solde - montant < 1` ;
 * - `PARTI` : il ne reste qu'une poussiere, `0 <= solde < 1` ;
 * - `INCOHERENT` : ni l'un ni l'autre, ou illisible.
 *
 * Les deux premiers sont disjoints parce que `montant >= SEUIL_POUSSIERE_USDC`,
 * que la table exige avant de consulter ce constat. Une seule fonction, pour que
 * la table et la relecture apres `move_funds` (Y4b) lisent le meme solde de la
 * meme facon. La poussiere n'a pas a etre connue d'avance : les recompenses
 * USDC la font varier, une egalite a un montant note la casserait.
 *
 * `minus` arrondit a 20 chiffres significatifs : un reste sous 1 le reste, sauf
 * plus de vingt 9 apres la virgule, arrondis a 1, donc `INCOHERENT`. L'arrondi
 * ne va que vers la panne, jamais vers un transfert.
 */
export type Constat =
  | { readonly usdc: 'PRESENT' | 'PARTI'; readonly poussiere: UsdcAmount }
  | { readonly usdc: 'INCOHERENT' };

export function constater(usdcRelu: UsdcAmount, montant: UsdcAmount): Constat {
  const reste = usdcRelu.minus(montant) as UsdcAmount;
  if (estPoussiere(reste)) return { usdc: 'PRESENT', poussiere: reste };
  if (estPoussiere(usdcRelu)) return { usdc: 'PARTI', poussiere: usdcRelu };
  return { usdc: 'INCOHERENT' };
}

/** Un convoyage que le journal laisse ouvert : toute derniere etape sauf `ENREGISTRE`. */
export type ConvoyageOuvert = Exclude<DernierConvoyage, { readonly etape: 'ENREGISTRE' }>;

/** Ce que la table de reprise (plan, point 3) demande de faire ensuite. */
export type Suite =
  | { readonly faire: 'RELIRE_ORDRE'; readonly clientOrderId: string }
  | {
      readonly faire: 'TRANSFERER';
      readonly montant: UsdcAmount;
      readonly achat: Achat;
      /** Ce que *Primary* garde en plus de l'achat : jamais transfere (DC10). */
      readonly poussiere: UsdcAmount;
    }
  | {
      readonly faire: 'NOTER_TRANSFERE';
      readonly transfereLe: Date;
      readonly achat: Achat;
      readonly poussiere: UsdcAmount;
    }
  | { readonly faire: 'ENREGISTRER'; readonly transfereLe: Date; readonly achat: Achat }
  | { readonly faire: 'PANNE'; readonly motif: string };

function panne(motif: string): Suite {
  return { faire: 'PANNE', motif };
}

/**
 * La table de reprise. Elle vaut au debut d'un passage qui trouve un convoyage
 * ouvert, et entre deux etapes d'un meme passage : dans *Primary*, l'USDC
 * n'appartient qu'au convoyeur (DC3), donc ce qu'il reste a deplacer se relit.
 *
 * `usdcRelu` n'est consulte qu'aux etapes qui ont un achat constate. A
 * `ACHAT_DEMANDE`, l'USDC present peut etre celui de l'ordre qu'on va relire ;
 * a `TRANSFERE`, le transfert est deja constate.
 */
export function reprendre(ouvert: ConvoyageOuvert, usdcRelu: UsdcAmount): Suite {
  switch (ouvert.etape) {
    case 'ACHAT_DEMANDE':
      return { faire: 'RELIRE_ORDRE', clientOrderId: clientOrderIdConvoyage(ouvert.convoyage) };
    case 'EN_PANNE':
      return panne(
        `convoyage ${ouvert.convoyage} en panne (${ouvert.motif}) : rien ne reprend sans le geste de l'operateur.`,
      );
    case 'TRANSFERE':
      return { faire: 'ENREGISTRER', transfereLe: ouvert.transfereLe, achat: ouvert.achat };
    case 'ACHETE':
    case 'TRANSFERT_DEMANDE':
      return reprendreApresAchat(ouvert, usdcRelu);
  }
}

function reprendreApresAchat(
  ouvert: Extract<ConvoyageOuvert, { readonly etape: 'ACHETE' | 'TRANSFERT_DEMANDE' }>,
  usdcRelu: UsdcAmount,
): Suite {
  const { achat } = ouvert;
  const montant = montantATransferer(achat);
  /*
   * Un `filled_size` sous le seuil de poussiere rendrait `PRESENT` et `PARTI`
   * vrais a la fois. Transferer une poussiere, ou croire fait un transfert
   * jamais demande : les deux sont faux, l'achat est a constater. 100 EUR en
   * achetent cent fois plus.
   */
  if (!(montant.isFinite() && montant.gte(SEUIL_POUSSIERE_USDC))) {
    return panne(
      `convoyage ${ouvert.convoyage} a ${ouvert.etape} avec filled_size ${montant.toFixed()}, sous le seuil de poussiere de ${SEUIL_POUSSIERE_USDC.toFixed()} USDC : aucun USDC a transferer.`,
    );
  }
  const constat = constater(usdcRelu, montant);
  if (constat.usdc === 'PRESENT') {
    // CV8 : `filled_size`, jamais le solde ; la poussiere reste dans Primary.
    return { faire: 'TRANSFERER', montant, achat, poussiere: constat.poussiere };
  }
  if (constat.usdc === 'PARTI') {
    if (ouvert.etape === 'TRANSFERT_DEMANDE') {
      // DC5 : fait entre la demande et la panne ; son instant est celui de la demande.
      return { faire: 'NOTER_TRANSFERE', transfereLe: ouvert.demandeLe, achat, poussiere: constat.poussiere };
    }
    return panne(
      `convoyage ${ouvert.convoyage} a ACHETE : l'USDC est parti de Primary sans demande de transfert.`,
    );
  }
  return panne(
    `convoyage ${ouvert.convoyage} a ${ouvert.etape} : ${usdcRelu.toFixed()} USDC dans Primary, ni une poussiere ni filled_size ${montant.toFixed()} plus une poussiere (seuil ${SEUIL_POUSSIERE_USDC.toFixed()} USDC). Aucun transfert.`,
  );
}

// --- Decision d'un passage ----------------------------------------------------

export interface EntreePassage {
  /** Le jour UTC du passage (`jourDuPassage`). */
  readonly jour: Convoyage;
  /** La derniere etape du dernier convoyage ; absente si le journal est vide. */
  readonly dernier: DernierConvoyage | undefined;
  /** L'EUR `available` de *Primary*, jamais `total` : un EUR bloque n'est pas la (U3). */
  readonly eurDisponible: EurAmount;
  /** L'USDC relu dans *Primary*. */
  readonly usdcRelu: UsdcAmount;
}

/**
 * Un passage fait au plus une chose : finir, ou commencer (plan, point 3).
 * `REPRENDRE` n'engage aucun EUR ; seul `COMMENCER` engage, et exactement
 * `MONTANT_CONVOYE`. `REFUSER` et une `Suite` a `PANNE` sont `urgent`.
 */
export type Decision =
  | {
      readonly action: 'RIEN';
      readonly motif: string;
      readonly eurDisponible: EurAmount;
      /** L'USDC de *Primary*, sous le seuil (DC10) ; zero le plus souvent. */
      readonly poussiere: UsdcAmount;
    }
  | {
      readonly action: 'COMMENCER';
      readonly convoyage: Convoyage;
      readonly clientOrderId: string;
      readonly quoteSize: EurAmount;
      readonly eurLaisse: EurAmount;
      readonly poussiere: UsdcAmount;
    }
  | { readonly action: 'REPRENDRE'; readonly convoyage: Convoyage; readonly suite: Suite }
  | { readonly action: 'REFUSER'; readonly motif: string };

/**
 * Ce que fait un passage, a partir de ce qu'il a lu. Dans l'ordre :
 *
 * 1. un convoyage ouvert se reprend, quel que soit l'EUR (DC6), et le passage ne
 *    commence rien d'autre ;
 * 2. sans convoyage ouvert, un USDC dans *Primary* d'au moins
 *    `SEUIL_POUSSIERE_USDC` est etranger : refus, aucun achat (CV10, DC3) ;
 *    en dessous, c'est une poussiere, ignoree et dite (DC10) ;
 * 3. un convoyage deja ferme ce jour-la, ou plus tard, n'en ouvre pas un second
 *    (DC8 ; second lancement du meme jour, piege 4 d'Y4b) ;
 * 4. EUR >= 100, seuil inclusif (Q6) : exactement 100 ; sinon rien (CV5).
 */
export function deciderPassage(entree: EntreePassage): Decision {
  const { jour, dernier, eurDisponible, usdcRelu } = entree;
  if (dernier !== undefined && dernier.etape !== 'ENREGISTRE') {
    const suite = reprendre(dernier, usdcRelu);
    return { action: 'REPRENDRE', convoyage: dernier.convoyage, suite };
  }
  if (!estPoussiere(usdcRelu)) {
    return {
      action: 'REFUSER',
      motif: `${usdcRelu.toFixed()} USDC dans Primary sans convoyage ouvert : USDC etranger, aucun achat.`,
    };
  }
  // DC10 : sous le seuil, le solde entier est une poussiere, ignoree et dite.
  const poussiere = usdcRelu;
  if (dernier !== undefined && dernier.convoyage >= jour) {
    return {
      action: 'RIEN',
      motif: `convoyage ${dernier.convoyage} deja enregistre : un passage par jour, un convoyage au plus.`,
      eurDisponible,
      poussiere,
    };
  }
  if (!eurDisponible.isFinite()) {
    return { action: 'REFUSER', motif: `EUR disponible illisible (${eurDisponible.toString()}).` };
  }
  if (eurDisponible.gte(MONTANT_CONVOYE)) {
    return {
      action: 'COMMENCER',
      convoyage: jour,
      clientOrderId: clientOrderIdConvoyage(jour),
      quoteSize: MONTANT_CONVOYE,
      eurLaisse: surplus(eurDisponible),
      poussiere,
    };
  }
  return {
    action: 'RIEN',
    motif: `${eurDisponible.toFixed()} EUR disponibles dans Primary, sous le seuil de ${MONTANT_CONVOYE.toFixed()} : rien a faire.`,
    eurDisponible,
    poussiere,
  };
}

/** CV7 : l'EUR qu'une decision engage. Zero, ou exactement `MONTANT_CONVOYE`. */
export function eurEngage(decision: Decision): EurAmount {
  return decision.action === 'COMMENCER' ? decision.quoteSize : (new Decimal(0) as EurAmount);
}

// --- Invariant et notification ------------------------------------------------

/**
 * DC6, CV13 : a la fin d'un passage, ce qui manque selon l'etape atteinte, et
 * ce que le run de 07:00 d'Ubac lira. Seul `ENREGISTRE` ne manque de rien.
 */
const RIEN_A_LIRE = "ni USDC ni ligne de ce convoyage : rien a lire, l'invariant tient.";

const ETAT_AU_RUN: Readonly<
  Record<Etape, { readonly manque: string | undefined; readonly runLira: string }>
> = {
  ENREGISTRE: { manque: undefined, runLira: "l'USDC et sa ligne cash_flows : l'apport est compte." },
  ACHAT_DEMANDE: { manque: 'achat non constate ; transfert et ligne absents', runLira: RIEN_A_LIRE },
  ACHETE: { manque: "transfert et ligne absents ; l'USDC reste dans Primary", runLira: RIEN_A_LIRE },
  TRANSFERT_DEMANDE: {
    manque: 'transfert non constate ; ligne absente',
    runLira: "si le transfert a eu lieu, l'USDC sans sa ligne, lu comme une performance ; sinon rien.",
  },
  TRANSFERE: {
    manque: 'ligne cash_flows absente',
    runLira: "l'USDC sans sa ligne : lu comme une performance, et une divergence USDC.",
  },
  EN_PANNE: {
    manque: "etat a constater par l'operateur",
    runLira: 'a constater : Primary, ubac-agent et cash_flows sont a relire.',
  },
};

export function etatAuRun(etape: Etape): (typeof ETAT_AU_RUN)[Etape] {
  return ETAT_AU_RUN[etape];
}

/** Ce qu'un passage qui agit rend a notifier (CV17). Un passage `RIEN` n'en rend pas. */
export interface CompteRendu {
  readonly nature: 'CONVOYAGE' | 'REPRISE' | 'REFUS' | 'PANNE';
  readonly convoyage: Convoyage | undefined;
  /** Derniere etape ecrite ; absente si rien n'a ete ecrit (refus avant tout). */
  readonly etape: Etape | undefined;
  readonly achat: Achat | undefined;
  /** L'EUR disponible laisse dans *Primary*, au dernier solde lu ; absent si aucun ne l'a ete. */
  readonly eurLaisse: EurAmount | undefined;
  readonly motif: string | undefined;
  /** La poussiere ignoree (DC10), au dernier constat ; absente si aucun ne l'a lue. */
  readonly poussiere: UsdcAmount | undefined;
}

/**
 * DC10 : la ligne d'information d'une poussiere, montant compris. Rien pour
 * une poussiere nulle ou absente. Elle ne change jamais la priorite.
 */
export function lignePoussiere(poussiere: UsdcAmount | undefined): string | undefined {
  if (poussiere === undefined || poussiere.isZero()) return undefined;
  return `poussiere ignoree dans Primary : ${poussiere.toFixed()} USDC, sous le seuil de ${SEUIL_POUSSIERE_USDC.toFixed()} USDC`;
}

export interface Notification {
  readonly titre: string;
  readonly corps: string;
  readonly priorite: Priorite;
}

function montant(valeur: Decimal | undefined, devise: string, absent = 'aucun'): string {
  return valeur === undefined ? absent : `${valeur.toFixed()} ${devise}`;
}

/**
 * CV17, CV13, DP4 : le texte d'une notification. Prefixe « convoyeur » ; EUR
 * debite, USDC recu, frais, etape atteinte, EUR laisse dans *Primary*. `URGENT`
 * des qu'un refus, une panne, ou une etape autre que `ENREGISTRE` laisse
 * transfert et ligne incomplets (CV13). Une poussiere ignoree est une ligne
 * d'information, sans effet sur la priorite (DC10).
 *
 * `marque` suit le prefixe dans le titre : le point de composition (Y5) y met le
 * nom du mode sans ecriture, et rien en reel (DP4 = 1). Ce fichier ne nomme pas
 * le mode : il n'a qu'un lieu (A25 de `test/jobs/purete.test.ts`), et le mode ne
 * voyage pas (piege 1 d'Y5).
 */
export function notification(compteRendu: CompteRendu, marque?: string): Notification {
  const { nature, convoyage, etape, achat, eurLaisse, motif, poussiere } = compteRendu;
  const information = lignePoussiere(poussiere);
  const prefixe = marque === undefined ? 'convoyeur' : `convoyeur ${marque}`;
  const complet = etape === 'ENREGISTRE' && (nature === 'CONVOYAGE' || nature === 'REPRISE');
  const lignes = [
    ...(convoyage === undefined ? [] : [`convoyage : ${convoyage}`]),
    `EUR debite : ${montant(achat === undefined ? undefined : eurDebite(achat), 'EUR')}`,
    `USDC recu : ${montant(achat?.filledSize, 'USDC')}`,
    `frais : ${montant(achat?.totalFees, 'EUR')}`,
    `etape atteinte : ${etape ?? 'aucune'}`,
    `EUR laisse dans Primary : ${montant(eurLaisse, 'EUR', 'non lu')}`,
    ...(information === undefined ? [] : [information]),
    ...(motif === undefined ? [] : [`motif : ${motif}`]),
  ];
  if (etape !== undefined) {
    const { manque, runLira } = etatAuRun(etape);
    if (manque !== undefined) lignes.push(`manque : ${manque}`);
    lignes.push(`le run de 07:00 lira : ${runLira}`);
  }
  return {
    titre: `${prefixe} — ${nature.toLowerCase()}`,
    corps: lignes.join('\n'),
    priorite: complet ? 'HIGH' : 'URGENT',
  };
}
