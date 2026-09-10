import { createHash } from 'node:crypto';

import type { AllowedAsset, IsoDate, Side } from './types.js';

/**
 * `client_order_id` deterministe. Implemente le §7 de `ubac-rebalance.md` :
 * sha256(run_date | asset | side | leg_index), tronque.
 *
 * L'identifiant est la ligne de defense contre le doublon. Rejouer le job d'un
 * meme jour redecrit la meme jambe, donc le meme identifiant, et l'exchange
 * refuse le second envoi. Deux proprietes en decoulent, et ce sont les seules
 * qui comptent ici :
 *
 * - **stable dans le temps**, pas seulement dans un processus. Un changement
 *   d'encodage entre deux deploiements rouvre la porte au doublon sans qu'aucun
 *   test de la forme "deux appels donnent la meme chose" ne bronche. Le test
 *   fige la valeur attendue : la faire bouger devient un acte conscient.
 * - **injectif**. Deux jambes distinctes qui partagent un identifiant, c'est la
 *   seconde avalee en silence par l'exchange au titre du doublon.
 */

/**
 * Separation de domaine : le hachage ne porte pas que les quatre composantes,
 * il porte aussi ce a quoi elles servent. Le suffixe de version dit qu'un
 * changement d'encodage est une rupture, pas un detail d'implementation.
 */
const DOMAIN = 'ubac.order-id.v1';

const PREFIX = 'ubac-';

/**
 * 27 hexadecimaux, soit 108 bits, pour un identifiant de 32 caracteres au
 * total. La troncature reste tres au-dela de ce que le volume de la phase 0
 * exige, et la longueur garde de la marge sous la limite usuelle de 36
 * caracteres des `client_order_id` d'exchange.
 */
const HEX_LENGTH = 27;

/** Les quatre composantes de C24, et rien d'autre. */
export interface OrderIdParts {
  readonly runDate: IsoDate;
  readonly asset: AllowedAsset;
  readonly side: Side;
  readonly legIndex: number;
}

/**
 * Encodage prefixe par longueur plutot que simple jointure par `|` : la
 * collision devient impossible par construction, au lieu de reposer sur une
 * convention concernant le contenu des champs. Un `AllowedAsset` ne peut certes
 * pas contenir de `|`, mais les types sont effaces a l'execution et cette
 * garantie disparait avec eux.
 */
function canonical(parts: OrderIdParts): string {
  return [DOMAIN, parts.runDate, parts.asset, parts.side, String(parts.legIndex)]
    .map((field) => `${String(field.length)}:${field}`)
    .join('');
}

/**
 * Un `legIndex` non entier ou negatif est un bug d'appel, et un bug silencieux :
 * `NaN` se serialise en `"NaN"` et donnerait le meme identifiant a deux jambes
 * differentes. C'est exactement la collision que le reste du module s'emploie a
 * rendre impossible, donc l'entree est refusee au lieu d'etre hachee.
 */
export function clientOrderId(parts: OrderIdParts): string {
  if (!Number.isSafeInteger(parts.legIndex) || parts.legIndex < 0) {
    throw new RangeError(
      `legIndex doit etre un entier positif ou nul, recu ${String(parts.legIndex)}`,
    );
  }

  const digest = createHash('sha256').update(canonical(parts), 'utf8').digest('hex');
  return `${PREFIX}${digest.slice(0, HEX_LENGTH)}`;
}
