import { Decimal } from 'decimal.js';

import type { CoinbaseReader, OrderStatus } from '../adapters/coinbase.js';
import type { Order, Quantity, StrategyName, UsdcAmount } from '../core/types.js';
import type { IssueDeJambe } from './execute.js';

/**
 * **Ce qui est parti**, lu apres l'etape 6 : le seul endroit ou le run apprend
 * ce que l'exchange a fait de ses ordres (E27, E28). Il ne place rien, n'annule
 * rien et n'ecrit rien — il **lit** le statut de chaque ordre accepte, par la
 * lecture qu'E37 a ouverte, et le classe.
 *
 * La lecture a lieu **dans le run qui a place**, quelques instants apres : un
 * limit post-only au repos est le plus souvent encore ouvert, et le compte
 * execute vaut alors zero. C'est vrai, et c'est ce que l'alerte et le rapport
 * disent. Ce qui s'execute ensuite releve de la reconciliation du lendemain et
 * de la persistance des transitions (S8), pas de ce module.
 *
 * **Aucune lecture ne fait echouer le run.** Les ordres sont deja partis et
 * ecrits : une exception ici ferait sortir le run en `JOB_FAILED`, et l'alerte
 * d'execution ne partirait pas — le trou exact que ce lot ferme. Un statut
 * illisible se classe `NON_LU`, avec son motif, et n'est compte ni execute ni
 * non execute.
 */

/**
 * Les quatre etats d'un ordre **place**. `PARTIEL` : une quantite executee non
 * nulle sans que l'ordre soit `FILLED` — ouvert, ou annule ou expire apres un
 * debut d'execution. `NON_LU` n'est pas un etat de l'ordre, c'est l'aveu que le
 * run ne le connait pas ; il ne se replie sur aucun des trois autres.
 */
export type EtatDOrdre = 'EXECUTE' | 'PARTIEL' | 'NON_EXECUTE' | 'NON_LU';

/** Un ordre accepte par l'exchange, et ce que le run en sait apres l'avoir place. */
export interface OrdreSuivi {
  readonly order: Order;
  readonly etat: EtatDOrdre;
  readonly filled: Quantity;
  /** `total_fees` de l'exchange, en USDC ; `null` quand le statut n'a pas ete lu. */
  readonly fees: UsdcAmount | null;
}

/** Une jambe que l'exchange a refusee. `postOnly` : le refus normal du §7. */
export interface RejetDeJambe {
  readonly order: Order;
  readonly reason: string;
  readonly postOnly: boolean;
}

/** L'etape 6 d'une strategie, vue depuis l'exchange. */
export interface ExecutionDeStrategie {
  readonly strategy: StrategyName;
  readonly ordres: readonly OrdreSuivi[];
  readonly rejets: readonly RejetDeJambe[];
}

/**
 * Les codes d'un refus post-only, tels que `placedFrom` les joint : `error`,
 * puis `preview_failure_reason`, et le premier vaut souvent
 * `UNKNOWN_FAILURE_REASON`. **Egalite exacte, jamais une sous-chaine** : un code
 * inconnu qui contiendrait `POST_ONLY` alerterait plutot que d'etre tu.
 */
const CODES_POST_ONLY: ReadonlySet<string> = new Set([
  'INVALID_LIMIT_PRICE_POST_ONLY',
  'PREVIEW_INVALID_LIMIT_PRICE_POST_ONLY',
]);
const CODE_MUET = 'UNKNOWN_FAILURE_REASON';

/**
 * Un refus est post-only si l'un de ses codes le dit et qu'aucun autre ne dit
 * autre chose. Tout le reste — fonds insuffisants, produit suspendu, taille
 * refusee — n'est pas le fonctionnement normal, et doit se voir.
 */
export function refusPostOnly(reason: string): boolean {
  const codes = reason.split(' / ');
  return (
    codes.some((code) => CODES_POST_ONLY.has(code)) &&
    codes.every((code) => CODES_POST_ONLY.has(code) || code === CODE_MUET)
  );
}

/** Le statut lu, rendu a l'un des quatre etats. `FILLED` seul vaut execute. */
export function etatDe(status: OrderStatus): EtatDOrdre {
  if (status.kind === 'INDETERMINABLE') return 'NON_LU';
  if (status.kind === 'FILLED') return 'EXECUTE';
  return status.filled.isZero() ? 'NON_EXECUTE' : 'PARTIEL';
}

const ZERO = new Decimal(0);

async function lire(
  exchange: Pick<CoinbaseReader, 'orderStatus'>,
  order: Order,
  exchangeId: string,
  log: (line: string) => void,
): Promise<OrdreSuivi> {
  let status: OrderStatus;
  try {
    status = await exchange.orderStatus(exchangeId);
  } catch (error) {
    status = { kind: 'INDETERMINABLE', reason: error instanceof Error ? error.message : String(error) };
  }
  if (status.kind === 'INDETERMINABLE') {
    log(`${order.clientOrderId} : statut non lu — ${status.reason}`);
    return { order, etat: 'NON_LU', filled: ZERO as Quantity, fees: null };
  }
  return { order, etat: etatDe(status), filled: status.filled, fees: status.fees };
}

/**
 * Suit les issues d'un lot place. Les ordres `ALREADY_RECORDED` ne sont pas
 * partis aujourd'hui (E24) et ne sont pas comptes. Sequentiel, dans l'ordre de
 * placement : le rapport les rend dans cet ordre.
 */
export async function suivre(
  exchange: Pick<CoinbaseReader, 'orderStatus'>,
  strategy: StrategyName,
  ordres: readonly Order[],
  issues: readonly IssueDeJambe[],
  log: (line: string) => void,
): Promise<ExecutionDeStrategie> {
  const parId = new Map(ordres.map((order) => [order.clientOrderId, order]));
  const suivis: OrdreSuivi[] = [];
  const rejets: RejetDeJambe[] = [];
  for (const issue of issues) {
    const order = parId.get(issue.clientOrderId);
    if (order === undefined || issue.kind === 'ALREADY_RECORDED') continue;
    if (issue.kind === 'REJECTED') {
      rejets.push({ order, reason: issue.reason, postOnly: refusPostOnly(issue.reason) });
      continue;
    }
    suivis.push(await lire(exchange, order, issue.exchangeId, log));
  }
  return { strategy, ordres: suivis, rejets };
}

/** Les ordres d'une strategie dans un etat donne. */
export const compter = (execution: ExecutionDeStrategie, etat: EtatDOrdre): number =>
  execution.ordres.filter((ordre) => ordre.etat === etat).length;

/** La somme des frais lus. Un ordre `NON_LU` n'y entre pas : ses frais sont inconnus, pas nuls. */
export const fraisReels = (execution: ExecutionDeStrategie): UsdcAmount =>
  execution.ordres.reduce((total, ordre) => (ordre.fees === null ? total : total.plus(ordre.fees)), ZERO) as UsdcAmount;

/** Le montant engage au prix limite, arrondi par l'affichage et jamais ici. */
export const engage = (execution: ExecutionDeStrategie): UsdcAmount =>
  execution.ordres.reduce((total, { order }) => total.plus(order.quantity.times(order.limitPrice)), ZERO) as UsdcAmount;
