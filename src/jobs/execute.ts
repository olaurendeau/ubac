import type { CancelOutcome, ExecutionPort, PlacedOrder } from '../adapters/coinbase.js';
import type { Order } from '../core/types.js';

/**
 * Le seul module de `src/jobs/` qui ecrit sur l'exchange (E11 de la phase 3) :
 * A23 de `test/jobs/purete.test.ts` lui reserve l'appel des methodes du port et
 * des routes d'ecriture, et exige qu'il y figure.
 *
 * Il ne decide rien et ne valide rien : il **applique** des ordres deja valides
 * et des annulations deja decidees, par un port qu'il recoit. C'est ce qui
 * permet un second appelant sans allonger la liste d'E11 : le run quotidien
 * (S7) lui passe les ordres d'un verdict `ACCEPTED`, la sortie propre (S11) ses
 * cessions et ses annulations, et la reconciliation lui rend des intentions
 * d'annulation (S8, T4) au lieu d'annuler elle-meme. `core/risk.ts` n'est pas
 * dans ce chemin, donc pas dans celui de la sortie (E48).
 *
 * **Rien ne l'appelle a la fin du lot S4**, et c'est voulu : le lot livre la
 * capacite, pas l'usage. Un garde-fou qui ne designe personne est vide ; ce
 * module existe d'abord pour que celui d'E11 designe quelqu'un.
 */

/** Un lot d'ordres que ce module refuse d'envoyer, avant tout envoi. */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/**
 * Place les ordres **un par un, dans l'ordre recu** : une interruption laisse un
 * prefixe connu, pas un sous-ensemble quelconque. Deux ordres du meme
 * `client_order_id` font refuser le lot avant tout envoi : l'exchange rendrait
 * au second l'ordre du premier, au titre du doublon et sans erreur, selon la
 * documentation de l'API — et la jambe manquerait en silence.
 */
export async function placer(
  port: ExecutionPort,
  ordres: readonly Order[],
): Promise<readonly PlacedOrder[]> {
  const vus = new Set<string>();
  for (const { clientOrderId } of ordres) {
    if (vus.has(clientOrderId)) {
      throw new ExecutionError(
        `client_order_id ${clientOrderId} en double dans le lot : aucun ordre n'est envoye.`,
      );
    }
    vus.add(clientOrderId);
  }
  const places: PlacedOrder[] = [];
  for (const ordre of ordres) places.push(await port.placeOrder(ordre));
  return places;
}

/** Annule par identifiant d'exchange ; l'issue reste ordre par ordre. */
export async function annuler(
  port: ExecutionPort,
  exchangeIds: readonly string[],
): Promise<readonly CancelOutcome[]> {
  return port.cancelOrders(exchangeIds);
}
