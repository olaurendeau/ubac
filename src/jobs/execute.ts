import { Decimal } from 'decimal.js';

import type { CancelOutcome, ExecutionPort, PlacementOutcome } from '../adapters/coinbase.js';
import type { UbacDatabase } from '../adapters/db.js';
import type { MidPrices } from '../core/risk.js';
import type { Order, Price, Quantity } from '../core/types.js';
import { prixLimite } from './liquidate.js';

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
 * Les pas de BTC-USDC et d'ETH-USDC : `quote_increment` 0,01 USDC,
 * `base_increment` 1e-8. Un prix ou une quantite plus fins sont refuses par
 * l'exchange. Constantes, et non lus : si Coinbase les changeait, les ordres
 * seraient rejetes — journalises, sans rien placer de faux.
 */
const PAS_DE_PRIX = 2;
const PAS_DE_QUANTITE = 8;

/**
 * L'ordre tel qu'il part au carnet (E20) : le prix limite a mid ± 0,1 % du cote
 * qui ne croise pas, par `prixLimite` — la seule definition, partagee avec la
 * sortie (T3) —, arrondi au pas **en s'eloignant du mid** ; la quantite validee
 * par le risque, arrondie **vers le bas**, pour ne jamais engager plus.
 *
 * Le sens de l'arrondi n'est pas un biais a corriger : arrondir le prix vers le
 * mid pourrait le faire croiser le carnet, et l'exchange rejetterait l'ordre
 * post-only. Ne pas l'inverser.
 */
export function auCarnet(ordre: Order, mids: MidPrices): Order {
  const mid = mids[ordre.asset];
  if (mid === undefined || !mid.isFinite() || !mid.gt(0)) {
    throw new ExecutionError(`${ordre.clientOrderId} : aucun mid exploitable pour ${ordre.asset}.`);
  }
  const arrondi = ordre.side === 'BUY' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP;
  return {
    ...ordre,
    limitPrice: prixLimite(ordre.side, mid).toDecimalPlaces(PAS_DE_PRIX, arrondi) as Price,
    quantity: ordre.quantity.toDecimalPlaces(PAS_DE_QUANTITE, Decimal.ROUND_DOWN) as Quantity,
  };
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
 */
export async function placer(execution: Execution, lot: Lot): Promise<readonly IssueDeJambe[]> {
  const vus = new Set<string>();
  for (const { clientOrderId } of lot.ordres) {
    if (vus.has(clientOrderId)) {
      throw new ExecutionError(
        `client_order_id ${clientOrderId} en double dans le lot : aucun ordre n'est envoye.`,
      );
    }
    vus.add(clientOrderId);
  }
  const issues: IssueDeJambe[] = [];
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
    await execution.db.recordPlacement(issue);
    issues.push(issue);
  }
  return issues;
}

/** Annule par identifiant d'exchange ; l'issue reste ordre par ordre. */
export async function annuler(
  port: ExecutionPort,
  exchangeIds: readonly string[],
): Promise<readonly CancelOutcome[]> {
  return port.cancelOrders(exchangeIds);
}
