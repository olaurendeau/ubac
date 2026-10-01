import { Decimal } from 'decimal.js';

import type {
  CancelOutcome,
  CoinbaseReader,
  ExecutionPort,
  OrderStatus,
  PlacementOutcome,
} from '../adapters/coinbase.js';
import type { UbacDatabase } from '../adapters/db.js';
import type { Order, Quantity } from '../core/types.js';
import type { CancellationIntent } from './reconcile.js';

/**
 * Le seul module de `src/jobs/` qui ecrit sur l'exchange (E11 de la phase 3) :
 * A23 de `test/jobs/purete.test.ts` lui reserve l'appel des methodes du port et
 * des routes d'ecriture, et exige qu'il y figure.
 *
 * Il ne decide rien et ne valide rien : il **applique** des ordres deja valides
 * et des annulations deja decidees, par un port qu'il recoit. C'est ce qui
 * permet un second appelant sans allonger la liste d'E11 : le run quotidien
 * lui passe les ordres d'un verdict `ACCEPTED` de la production, la sortie
 * propre (S11) ses cessions et ses annulations, et la reconciliation lui rend
 * des intentions d'annulation (S8, T4) au lieu d'annuler elle-meme.
 * `core/risk.ts` n'est pas dans ce chemin, donc pas dans celui de la sortie (E48).
 *
 * Le port recu est le reel en mode normal et le journalisant en `DRY_RUN` ;
 * `daily-main.ts` choisit, et ce module ne le sait pas (E15).
 */

/** Un lot d'ordres que ce module refuse d'envoyer, avant toute ecriture. */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/**
 * Le pas de quantite de BTC-USDC et d'ETH-USDC : `base_increment` 1e-8. Une
 * quantite plus fine est refusee par l'exchange. Constante, et non lue : si
 * Coinbase la changeait, les ordres seraient rejetes — journalises, sans rien
 * placer de faux.
 */
const PAS_DE_QUANTITE = 8;

/**
 * L'ordre tel qu'il part au carnet (E20) : la quantite validee par le risque,
 * arrondie **vers le bas**, pour ne jamais engager plus. **Le prix n'est pas
 * touche** : il a ete pose au carnet avant `validate` (`prixLimite`, etape 5 de
 * `daily.ts`), et c'est celui que la couche risque a accepte qui part
 * (`docs/specs/ubac-prix-au-carnet.md`, D3). Le reecrire ici rouvrirait K3 : un
 * prix envoye que personne n'a valide.
 */
export function auCarnet(ordre: Order): Order {
  return { ...ordre, quantity: ordre.quantity.toDecimalPlaces(PAS_DE_QUANTITE, Decimal.ROUND_DOWN) as Quantity };
}

/** Ce qu'il faut pour placer : l'exchange, et la base qui ecrit avant lui. */
export interface Execution {
  readonly port: ExecutionPort;
  readonly db: Pick<UbacDatabase, 'recordOrder' | 'recordPlacement'>;
}

/** Les ordres d'une decision, rattaches a elle par son identifiant. */
export interface Lot {
  readonly decisionId: string;
  readonly createdAt: Date;
  readonly ordres: readonly Order[];
}

/**
 * L'issue d'une jambe. `ALREADY_RECORDED` : la cle primaire d'`orders` a refuse
 * la ligne, l'ordre n'est **pas** place une seconde fois (E24).
 */
export type IssueDeJambe = PlacementOutcome | { readonly kind: 'ALREADY_RECORDED'; readonly clientOrderId: string };

/**
 * Place les ordres **un par un, dans l'ordre recu** : une interruption laisse un
 * prefixe connu, pas un sous-ensemble quelconque.
 *
 * **Chaque ordre est ecrit en `PENDING` avant d'etre place (E23)**, et l'ordre
 * inverse n'existe pas ici. Un job qui meurt entre les deux laisse une ligne
 * `PENDING` sans `exchange_id`, que la reconciliation rattrape ; un ordre place
 * sans ligne ne serait reclame par rien.
 *
 * Un rejet de l'exchange — post-only qui croiserait — est une issue, pas une
 * erreur : il est ecrit, et la jambe suivante part. **Rien n'est replace** dans
 * ce run (E26) : le suivant relit les poids reels.
 *
 * Deux ordres du meme `client_order_id` font refuser le lot avant toute
 * ecriture : l'exchange rendrait au second l'ordre du premier, au titre du
 * doublon et sans erreur — et la jambe manquerait en silence.
 *
 * **`issues` est fourni par l'appelant, et alimente au fil de l'eau** : chaque
 * issue y entre des que l'exchange l'a rendue, **avant** son ecriture. Si une
 * ecriture posterieure leve — l'issue de cette jambe ou d'une suivante —,
 * l'exception remonte telle quelle, mais l'appelant tient deja toutes les
 * jambes parties et peut les dire (alerte du jour) avant de la relancer. Une
 * valeur de retour se perdrait avec l'exception ; une erreur qui transporterait
 * les issues ne couvrirait que les exceptions que ce module sait envelopper.
 */
export async function placer(
  execution: Execution,
  lot: Lot,
  issues: IssueDeJambe[],
): Promise<readonly IssueDeJambe[]> {
  const vus = new Set<string>();
  for (const { clientOrderId } of lot.ordres) {
    if (vus.has(clientOrderId)) {
      throw new ExecutionError(
        `client_order_id ${clientOrderId} en double dans le lot : aucun ordre n'est envoye.`,
      );
    }
    vus.add(clientOrderId);
  }
  for (const order of lot.ordres) {
    const ecrit = await execution.db.recordOrder({
      order,
      decisionId: lot.decisionId,
      createdAt: lot.createdAt,
    });
    if (ecrit.status === 'ALREADY_RECORDED') {
      issues.push({ kind: 'ALREADY_RECORDED', clientOrderId: order.clientOrderId });
      continue;
    }
    const issue = await execution.port.placeOrder(order);
    // Partie : connue de l'appelant avant que son ecriture puisse lever.
    issues.push(issue);
    // Un placement retenu n'a pas eu lieu : il n'y a pas d'issue a ecrire.
    if (issue.kind !== 'RETENU') await execution.db.recordPlacement(issue);
  }
  return issues;
}

/**
 * L'issue d'une annulation, **ordre par ordre** (E36). `DEJA_DENOUE` est un
 * succes : l'ordre n'est plus ouvert, c'est ce que l'annulation voulait. `ECHEC`
 * n'est pas une erreur du run non plus, mais l'ordre **reste ouvert**, et c'est
 * ce que l'appelant doit en retenir. `RETENU` : le port n'a rien envoye ; l'ordre
 * compte comme ferme, pour que la suite du run soit celle d'une annulation reussie.
 */
export type IssueDAnnulation =
  | { readonly kind: 'ANNULE' | 'RETENU'; readonly clientOrderId: string; readonly exchangeId: string }
  | { readonly kind: 'DEJA_DENOUE' | 'ECHEC'; readonly clientOrderId: string; readonly exchangeId: string; readonly reason: string };

/** Ce qu'il faut pour annuler : l'exchange qui ecrit, et celui qui relit un refus. */
export interface Annulation {
  readonly port: ExecutionPort;
  readonly exchange: Pick<CoinbaseReader, 'orderStatus'>;
}

function texte(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Un refus ne dit pas lui-meme s'il est benin : `failure_reason` est une
 * enumeration que l'API elargit, et deviner « deja denoue » sur son texte ferait
 * passer une vraie panne pour de l'idempotence. **Le statut de l'ordre tranche** :
 * denoue, le refus etait sans objet ; encore ouvert ou illisible, c'est un echec.
 */
async function classerLeRefus(
  exchange: Annulation['exchange'],
  intention: CancellationIntent,
  refus: string,
): Promise<IssueDAnnulation> {
  const { clientOrderId, exchangeId } = intention;
  let lu: OrderStatus;
  try {
    lu = await exchange.orderStatus(exchangeId);
  } catch (error) {
    lu = { kind: 'INDETERMINABLE', reason: texte(error) };
  }
  if (lu.kind === 'INDETERMINABLE') {
    return { kind: 'ECHEC', clientOrderId, exchangeId, reason: `${refus} ; statut illisible : ${lu.reason}` };
  }
  if (lu.kind === 'OPEN') {
    return { kind: 'ECHEC', clientOrderId, exchangeId, reason: `${refus} ; l'ordre est toujours ouvert` };
  }
  return { kind: 'DEJA_DENOUE', clientOrderId, exchangeId, reason: `${refus} ; l'ordre est ${lu.kind}` };
}

/**
 * Applique les annulations que la reconciliation a decidees (§7 point 3, T4),
 * **en un seul envoi** et avec une issue par ordre, dans l'ordre recu : un lot ne
 * se replie pas sur un booleen, sinon un refus pour une vraie raison passerait
 * pour un ordre deja denoue.
 *
 * **Ne leve pas.** Un envoi qui leve n'a rien annule qu'on sache : chaque ordre
 * est dit en `ECHEC`, donc toujours ouvert, et le run continue — c'est a
 * l'appelant de ne rien placer par-dessus. Annuler deux fois le meme ordre rend
 * `DEJA_DENOUE` la seconde fois (E36).
 */
export async function annuler(
  annulation: Annulation,
  intentions: readonly CancellationIntent[],
): Promise<readonly IssueDAnnulation[]> {
  if (intentions.length === 0) return [];
  let rendues: readonly CancelOutcome[];
  try {
    rendues = await annulation.port.cancelOrders(intentions.map((intention) => intention.exchangeId));
  } catch (error) {
    return intentions.map(({ clientOrderId, exchangeId }) => ({
      kind: 'ECHEC',
      clientOrderId,
      exchangeId,
      reason: `annulation en echec — ${texte(error)}`,
    }));
  }
  const parId = new Map(rendues.map((issue) => [issue.exchangeId, issue]));
  const issues: IssueDAnnulation[] = [];
  for (const intention of intentions) {
    const rendue = parId.get(intention.exchangeId);
    if (rendue?.kind === 'CANCELLED' || rendue?.kind === 'RETENU') {
      const kind = rendue.kind === 'CANCELLED' ? 'ANNULE' : 'RETENU';
      issues.push({ kind, clientOrderId: intention.clientOrderId, exchangeId: intention.exchangeId });
      continue;
    }
    issues.push(await classerLeRefus(annulation.exchange, intention, rendue?.reason ?? 'aucune issue rendue'));
  }
  return issues;
}
