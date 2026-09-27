import { Decimal } from 'decimal.js';

import type {
  AssetBalance,
  CoinbaseReader,
  KnownOrderStatus,
  OpenOrder,
  OrderStatus,
} from '../adapters/coinbase.js';
import type { PendingOrderRecord, TransitionToRecord, UbacDatabase } from '../adapters/db.js';
import type { Holdings } from '../core/portfolio.js';
import { ASSETS } from '../core/portfolio.js';
import { RECONCILIATION_DRIFT_PCT } from '../core/risk.js';
import type { AllowedAsset, Quantity } from '../core/types.js';

/**
 * La reconciliation de la spec §7 : **ce que l'exchange dit, confronte a ce que
 * la base croit**, avant qu'aucune decision ne soit prise.
 *
 * Trois principes gouvernent ce fichier.
 *
 * 1. **L'etat de l'exchange fait foi ; l'etat interne n'est qu'un cache.** Le
 *    principe se lit dans les deux sens, et c'est la seconde moitie qui gouverne
 *    ici : au-dela du seuil, ce n'est pas le run qui se rend, c'est le cache. La
 *    divergence ne corrige rien sur l'exchange — rien ici n'ecrit ou n'annule —,
 *    elle **abandonne la valeur du cache** et laisse le run poursuivre sur les
 *    soldes reels. Abandonner le run faisait l'inverse : il gelait la photo
 *    perimee, donc le run suivant la relisait et abandonnait de nouveau, chaque
 *    jour, pour toujours. Une intervention manuelle condamnait le job sans
 *    chemin de retour ; c'est arrive, `docs/reconciliation.md` §1 bis porte le
 *    cas reel.
 * 2. **Ce module ne persiste rien.** Il lit et il rend un resultat — y compris
 *    quand ce resultat dit que le cache doit se rendre : le rafraichissement est
 *    l'ecriture de la photo du jour, a l'etape 7 de `daily.ts`, sur les soldes
 *    que ce module vient de rendre. Les transitions d'ordres suivent la meme
 *    regle (E38) : ce module lit le statut reel de chaque ordre ouvert en base
 *    — la lecture de S2, branchee ici en S8, qui clot E37 — et rend la ligne a
 *    ecrire ; c'est `daily.ts` qui l'ecrit.
 * 3. **L'horloge est un parametre, jamais une lecture.** `ReconcileInput.now`
 *    est l'instant du run (E35) : il date le denouement d'un ordre, et mesure
 *    l'age de ceux qui restent ouverts — au-dela de 24 h, ce module rend une
 *    **intention** d'annulation, que `execute.ts` applique (T4 : E11 garde un
 *    seul module d'ecriture). Ce module n'en lit aucune autre, et `src/jobs/` etant hors du glob de purete
 *    d'`eslint.config.js`, cet interdit tient par un garde-fou de `test/jobs/`
 *    (A7), pas par le lint.
 *
 * `docs/reconciliation.md` porte les motifs : le choix de la base de comparaison
 * du seuil, le report de D2, et la lecture que ce module n'utilise pas encore.
 */

// --- La reconciliation precede toute decision -------------------------------

/**
 * Marque de `ReconciledBalances`. **Ce symbole n'est pas exporte**, et c'est tout
 * son interet : hors de ce module, aucun litteral d'objet ne peut nommer la
 * propriete, donc personne ne fabrique un `ReconciledBalances` sans passer par
 * `reconcile`. C'est ce qui rend « la reconciliation precede TOUTE decision »
 * structurelle et non disciplinaire — un run qui voudrait decider d'abord
 * n'aurait aucun `Holdings` a donner a `decide()`.
 *
 * La marque n'empeche pas un autre job d'appeler lui-meme `exchange.balances()`.
 * Cette moitie-la est tenue par un garde-fou de `test/jobs/`, qui reserve la
 * lecture des soldes a ce fichier. Voir `docs/reconciliation.md` §5.
 */
const RECONCILIE: unique symbol = Symbol('ubac.reconciled-balances');

/**
 * Les soldes reels, valides. La seule porte de sortie des grandeurs de ce
 * module quand tout va bien.
 */
export interface ReconciledBalances {
  readonly [RECONCILIE]: true;
  /**
   * Soldes reels des trois actifs de la liste blanche, `available + hold`. Le
   * gele d'un ordre ouvert reste detenu : l'exclure ferait baisser la valeur du
   * portefeuille a chaque ordre en vol.
   */
  readonly holdings: Holdings;
  /** A quoi les soldes ont ete confrontes. Un premier run n'a pas de cache. */
  readonly comparedTo: 'INTERNAL_SNAPSHOT' | 'NO_INTERNAL_STATE';
}

// --- Ordres : le statut reel, lu ordre par ordre -----------------------------

/**
 * Le statut reel d'un ordre ouvert en base, tel que ce module l'a lu (E37).
 *
 * `PENDING` et `PARTIAL` reprennent les deux etats ouverts de la colonne
 * `status` du §4. `SETTLED` porte l'issue d'un ordre denoue — execute, annule,
 * expire ou rejete —, que `orderStatus` distingue depuis S2 et que ce module lit
 * depuis S8.
 *
 * **`INDETERMINABLE` cesse d'etre atteignable pour un ordre que l'exchange
 * connait**, et reste l'aveu de deux cas : une ligne sans `exchange_id` absente
 * des ordres ouverts — un placement jamais confirme, qu'E23 rend possible, et
 * que l'exchange ne laisse consulter que par l'identifiant qu'il donne —, et une
 * lecture qui ne dit rien d'interpretable. L'union force l'appelant a traiter ce
 * cas : le replier sur `CANCELLED` classerait un ordre execute en annule, ce qui
 * est pire que de ne pas le classer (`docs/reconciliation.md` §4).
 */
export type ReconciledOrderStatus =
  | { readonly kind: 'PENDING'; readonly exchangeId: string }
  | { readonly kind: 'PARTIAL'; readonly exchangeId: string; readonly filled: Quantity }
  | {
      readonly kind: 'SETTLED';
      readonly outcome: Exclude<KnownOrderStatus['kind'], 'OPEN'>;
      readonly filled: Quantity;
    }
  | { readonly kind: 'INDETERMINABLE'; readonly reason: string };

export interface PendingOrderReconciliation {
  readonly order: PendingOrderRecord;
  readonly status: ReconciledOrderStatus;
  /**
   * La ligne que `daily.ts` ecrit (E38), ou `null` quand rien de lu ne l'affine.
   * **Un `INDETERMINABLE` n'ecrit rien**, donc n'efface rien : persister est un
   * affinement, et la base le garantit a son tour (`recordTransition`).
   */
  readonly transition: TransitionToRecord | null;
}

// --- Divergences ------------------------------------------------------------

/**
 * Une ligne dont l'exchange et le cache ne disent pas la meme chose. `drift` est
 * une fraction de 1, jamais un pourcentage : meme convention que `Weight`.
 */
export interface BalanceDivergence {
  readonly asset: string;
  readonly onExchange: Quantity;
  readonly internal: Quantity;
  readonly drift: Decimal;
}

/**
 * Ce que la reconciliation a vu et qui ne change rien au deroulement du run.
 * Deux anomalies que seule cette confrontation peut reveler : un ordre ouvert
 * que la base ne reclame pas, et une devise detenue hors de la liste blanche.
 *
 * Elles sont rendues pour que le run les signale ; aucune ne l'interrompt.
 */
export interface ReconcileObservations {
  /** Ordres ouverts sur l'exchange qu'aucune ligne `PENDING` ne reclame. */
  readonly unknownOpenOrders: readonly OpenOrder[];
  /**
   * Lignes **non nulles** hors BTC / ETH / USDC. Nulles, elles sont normales :
   * le portefeuille reel porte un compte EUR a zero, capture en fixture.
   */
  readonly untrackedBalances: readonly AssetBalance[];
}

/**
 * Marqueur en tete du motif de resynchronisation, donc en tete de
 * `decisions.reason` le jour ou l'etat s'est resynchronise. Meme role et meme
 * forme que le `SUSPENSION_MARKER` de `snapshot.ts` : sans lui, un jour ou le
 * portefeuille a bouge hors du systeme serait indistinguable d'un jour
 * ordinaire des que le push aurait ete oublie.
 *
 * Il est **exporte** pour la meme raison que l'autre : deux litteraux divergent,
 * et c'est celui qui n'a pas de sonde qui gagne.
 */
export const RESYNC_MARKER = 'ETAT_RESYNCHRONISE';

/**
 * L'etat interne a-t-il du se rendre a l'exchange ce jour-la.
 *
 * **C'est le marqueur du lot, et il a deux lecteurs.** Le run le porte jusqu'a
 * `decisions.reason` et jusqu'a l'alerte `RECONCILIATION_DRIFT`, pour qu'un
 * lecteur du journal des decisions puisse dire, des mois plus tard, que
 * quelqu'un a bouge le portefeuille hors du systeme ce jour-la. Et un
 * **executeur futur** le consulte : en phase 3, une divergence constatee juste
 * avant de passer des ordres peut signifier qu'un ordre precedent a eu un sort
 * qu'on ignore, et l'ignorer serait exactement la mauvaise reponse. Le champ
 * existe pour qu'il ait de quoi refuser ; ce qu'il en fera se tranche **avant la
 * phase 3**, et `docs/reconciliation.md` §3 bis porte la question et son
 * echeance.
 */
export type Resynchronization =
  | { readonly status: 'NOT_NEEDED' }
  | {
      readonly status: 'RESYNCHRONIZED';
      /** Les lignes qui ont depasse le seuil, telles qu'elles ont ete vues. */
      readonly divergences: readonly BalanceDivergence[];
      /** Texte marque : source unique de l'alerte et de `decisions.reason`. */
      readonly reason: string;
    };

/**
 * §7, point 3 : tout ordre limit non execute de **plus de 24 h** s'annule (E35).
 * Strictement plus : un ordre de 24 h pile reste ouvert.
 */
export const MAX_ORDER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Une annulation a appliquer. Ce module la **decide** et ne l'applique pas : la
 * route d'ecriture appartient a `execute.ts` (E11, T4), comme les cessions de
 * `liquidate.ts`. `ageMs` est une duree entiere, pas une grandeur de marche.
 */
export interface CancellationIntent {
  readonly clientOrderId: string;
  readonly exchangeId: string;
  readonly ageMs: number;
}

/**
 * Ce que la reconciliation rend. **Il n'y a pas de branche d'abandon**, et c'est
 * le lot : le seul motif que le §7 en donnait — la divergence de solde —
 * rafraichit desormais le cache au lieu de geler le systeme. Une branche
 * d'abandon que plus rien n'atteint n'aurait eu ni sonde ni lecteur ; le depot
 * refuse le code mort desarme, ici comme pour l'annulation a 24 h.
 */
export interface ReconcileResult {
  readonly balances: ReconciledBalances;
  readonly orders: readonly PendingOrderReconciliation[];
  /** Les ordres encore ouverts de plus de 24 h, dans l'ordre de la base. */
  readonly cancellations: readonly CancellationIntent[];
  readonly observations: ReconcileObservations;
  readonly resync: Resynchronization;
}

/**
 * `Pick` plutot que les interfaces entieres : le type dit exactement ce que la
 * reconciliation touche. Elle ne ferme ni la connexion ni le pool — le run
 * possede leur cycle de vie —, et elle n'ecrit nulle part.
 */
export interface ReconcileInput {
  readonly exchange: Pick<CoinbaseReader, 'balances' | 'openOrders' | 'orderStatus'>;
  readonly db: Pick<UbacDatabase, 'pendingOrders' | 'latestSnapshot'>;
  /** L'instant du run, injecte (E35) : le seul temps que ce module connaisse. */
  readonly now: Date;
}

// --- Comparaison ------------------------------------------------------------

const ZERO = new Decimal(0);

const WHITELIST: readonly string[] = ASSETS;

/**
 * Ecart relatif entre deux grandeurs de meme unite. **Recopie a l'identique de
 * `relativeDrift` dans `src/core/risk.ts`**, qui ne l'exporte pas et que la
 * phase 1 n'a pas le droit de modifier — meme choix, et meme motif, que le
 * `DECIMAL_TEXT` recopie entre `config/env.ts`, `adapters/schema.ts` et
 * `adapters/coinbase.ts`. Une copie derive : c'est
 * `test/jobs/reconcile-accord-risque.test.ts` qui l'interdit, en confrontant les
 * deux verdicts sur la meme table de cas.
 *
 * Le denominateur est le plus grand des deux en valeur absolue, donc l'ecart
 * reste borne par 1 meme quand une des deux valeurs est nulle. Deux zeros ne
 * divergent pas.
 */
function relativeDrift(onExchange: Decimal, internal: Decimal): Decimal {
  const base = Decimal.max(onExchange.abs(), internal.abs());
  return base.isZero() ? ZERO : onExchange.sub(internal).abs().div(base);
}

/**
 * Soldes reels par devise. La somme, et non la premiere ligne trouvee : deux
 * comptes dans la meme devise sont improbables dans un portefeuille dedie, mais
 * en retenir un seul rendrait un solde faux et plausible.
 */
function totalsByCurrency(balances: readonly AssetBalance[]): ReadonlyMap<string, Decimal> {
  const totaux = new Map<string, Decimal>();
  for (const ligne of balances) {
    totaux.set(ligne.currency, (totaux.get(ligne.currency) ?? ZERO).add(ligne.total));
  }
  return totaux;
}

function holdingsFrom(totaux: ReadonlyMap<string, Decimal>): Holdings {
  const lu = (asset: AllowedAsset): Quantity => (totaux.get(asset) ?? ZERO) as Quantity;
  return { BTC: lu('BTC'), ETH: lu('ETH'), USDC: lu('USDC') };
}

/**
 * Le seuil de 1 % se compare **ligne a ligne**, sur les quantites, jamais sur la
 * valeur totale : `docs/reconciliation.md` §2 en donne les trois raisons.
 *
 * L'union des deux cotes, et pas les seules devises du compte : une ligne que le
 * cache porte et que l'exchange ne porte plus est exactement la divergence que
 * la reconciliation existe pour voir.
 */
function divergencesOf(
  onExchange: ReadonlyMap<string, Decimal>,
  internal: Readonly<Record<string, Quantity>>,
): readonly BalanceDivergence[] {
  const lignes = [...new Set([...onExchange.keys(), ...Object.keys(internal)])].sort();
  const divergences: BalanceDivergence[] = [];
  for (const asset of lignes) {
    const reel = onExchange.get(asset) ?? ZERO;
    const cache = internal[asset] ?? ZERO;
    const drift = relativeDrift(reel, cache);
    // Strict, comme `risk.ts` : une divergence de 1 % pile passe.
    if (drift.gt(RECONCILIATION_DRIFT_PCT)) {
      divergences.push({
        asset,
        onExchange: reel as Quantity,
        internal: cache as Quantity,
        drift,
      });
    }
  }
  return divergences;
}

/**
 * Le motif porte par une resynchronisation. **Une seule source** : l'alerte du
 * §9 et la ligne de `decisions` du jour portent ce texte-la, pas deux redactions
 * du meme fait qui pourraient annoncer deux chiffres differents.
 */
function resyncReason(divergences: readonly BalanceDivergence[]): string {
  const detail = divergences
    .map(
      (d) =>
        `${d.asset} : ${d.onExchange.toString()} sur l'exchange contre ${d.internal.toString()} en interne, soit ${d.drift.times(100).toFixed(4)} % d'ecart`,
    )
    .join(' ; ');
  return (
    `${RESYNC_MARKER} : divergence superieure a ${RECONCILIATION_DRIFT_PCT.times(100).toFixed()} % entre les soldes reels et ` +
    `l'etat interne — ${detail}. L'etat de l'exchange fait foi : le cache interne se rend, le run ` +
    `poursuit sur les soldes reels et la photo du jour repart de l'exchange. Le portefeuille a bouge ` +
    `hors du systeme ; rien n'a ete corrige sur l'exchange, et aucun ordre n'a ete place.`
  );
}

// --- Ordres -----------------------------------------------------------------

function texte(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Un ordre encore ouvert, rien d'execute ou une partie : la quantite executee est
 * la seule chose qui distingue `PARTIAL` de `PENDING`.
 */
function ouvertDe(exchangeId: string, filled: Quantity): ReconciledOrderStatus {
  return filled.isZero() ? { kind: 'PENDING', exchangeId } : { kind: 'PARTIAL', exchangeId, filled };
}

/**
 * La ligne a ecrire, lue sur ce que l'exchange a dit. `FAILED` est l'ordre
 * rejete. `EXPIRED` s'ecrit `CANCELLED` : le §4 n'a pas de sixieme valeur, un
 * ordre `limit_limit_gtc` n'expire pas, et les deux issues laissent le meme
 * solde — c'est la quantite executee, conservee, qui compte.
 *
 * `settledAt` est l'instant du run qui **constate** l'issue, pas celui ou
 * l'exchange l'a prononcee : une borne superieure, en retard d'un run au plus.
 * L'instant exact de chaque execution reste lisible par `orderFills`.
 */
function transitionDe(lu: KnownOrderStatus, now: Date): TransitionToRecord {
  const commune = {
    clientOrderId: lu.clientOrderId,
    exchangeId: lu.exchangeId,
    filledQty: lu.filled,
    filledPrice: lu.averageFilledPrice,
    fees: lu.fees,
  };
  if (lu.kind === 'OPEN') {
    return { ...commune, status: lu.filled.isZero() ? 'PENDING' : 'PARTIAL', settledAt: null };
  }
  const status = lu.kind === 'FILLED' ? 'FILLED' : lu.kind === 'FAILED' ? 'REJECTED' : 'CANCELLED';
  return { ...commune, status, settledAt: now };
}

/**
 * Le statut d'un ordre ouvert en base, **lu sur l'exchange** par son
 * identifiant — celui de la base, ou a defaut celui de la liste des ordres
 * ouverts, pour la ligne dont le placement n'a pas ete ecrit.
 *
 * Une lecture qui echoue ne fait pas tomber la reconciliation : l'ordre est dit
 * `INDETERMINABLE` avec son motif, ou garde la vue de la liste des ordres
 * ouverts s'il y figure, et rien n'est ecrit. Un seul ordre illisible ne doit
 * pas condamner tous les runs suivants — c'est l'impasse que Q10 a fermee.
 */
async function reconcilierOrdre(
  exchange: Pick<CoinbaseReader, 'orderStatus'>,
  order: PendingOrderRecord,
  ouvert: OpenOrder | undefined,
  now: Date,
): Promise<PendingOrderReconciliation> {
  const exchangeId = order.exchangeId ?? ouvert?.exchangeId;
  if (exchangeId === undefined) {
    return {
      order,
      status: {
        kind: 'INDETERMINABLE',
        reason: `ordre ${order.clientOrderId} sans exchange_id et absent des ordres ouverts : son placement n'a jamais ete confirme, et l'exchange ne se consulte que par l'identifiant qu'il donne.`,
      },
      transition: null,
    };
  }
  let lu: OrderStatus;
  try {
    lu = await exchange.orderStatus(exchangeId);
  } catch (error) {
    lu = { kind: 'INDETERMINABLE', reason: `lecture en echec — ${texte(error)}` };
  }
  // L'identifiant de la base designe un autre ordre : rien de ce qu'il dit n'est a nous.
  if (lu.kind !== 'INDETERMINABLE' && lu.clientOrderId !== order.clientOrderId) {
    lu = { kind: 'INDETERMINABLE', reason: `l'exchange rattache ${exchangeId} a ${lu.clientOrderId}` };
  }
  if (lu.kind === 'INDETERMINABLE') {
    return {
      order,
      status:
        ouvert === undefined
          ? {
              kind: 'INDETERMINABLE',
              reason: `ordre ${order.clientOrderId} absent des ordres ouverts, statut illisible : ${lu.reason}. Son issue ne se devine pas.`,
            }
          : ouvertDe(ouvert.exchangeId, ouvert.filled),
      transition: null,
    };
  }
  return {
    order,
    status:
      lu.kind === 'OPEN'
        ? ouvertDe(exchangeId, lu.filled)
        : { kind: 'SETTLED', outcome: lu.kind, filled: lu.filled },
    transition: transitionDe(lu, now),
  };
}

/**
 * Les ordres a annuler : **encore ouverts** — rien d'execute, ou une partie,
 * `non execute` voulant dire « pas entierement » — et de plus de 24 h.
 *
 * L'age se compte sur `orders.created_at`, que le run ecrit avec son propre
 * instant, contre `now`, l'instant du run suivant : deux lectures de la meme
 * horloge. Jamais sur le `created_time` de l'exchange — deux horloges, deux
 * fuseaux possibles, et un ordre annule une heure trop tot.
 */
function annulationsDe(
  orders: readonly PendingOrderReconciliation[],
  now: Date,
): readonly CancellationIntent[] {
  const intentions: CancellationIntent[] = [];
  for (const { order, status } of orders) {
    if (status.kind !== 'PENDING' && status.kind !== 'PARTIAL') continue;
    const ageMs = now.getTime() - order.createdAt.getTime();
    if (ageMs > MAX_ORDER_AGE_MS) {
      intentions.push({ clientOrderId: order.clientOrderId, exchangeId: status.exchangeId, ageMs });
    }
  }
  return intentions;
}

// --- Reconciliation ---------------------------------------------------------

/**
 * §7, dans l'ordre de la spec : lire, confronter les ordres, decider des
 * annulations, confronter les soldes. L'annulation est rendue, pas appliquee :
 * `daily.ts` la passe a `execute.ts` (`docs/reconciliation.md` §3).
 *
 * Les lectures de l'exchange sont sequentielles et **ne sont pas atomiques** :
 * un ordre peut se denouer entre les soldes et son statut. La consequence va
 * toujours dans le sens de la verite de l'exchange — le statut lu est le plus
 * recent, et un solde qui ne l'a pas encore vu diverge du cache et se declare —,
 * jamais dans celui d'un etat perime accepte en silence.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const portfolio = await input.exchange.balances();
  const ouverts = await input.exchange.openOrders();
  const totaux = totalsByCurrency(portfolio.balances);

  const enAttente = await input.db.pendingOrders();
  const parClientId = new Map(ouverts.map((ordre) => [ordre.clientOrderId, ordre]));
  const orders: PendingOrderReconciliation[] = [];
  // Un ordre a la fois, dans l'ordre de la base : le journal les dit dans cet ordre.
  for (const order of enAttente) {
    orders.push(await reconcilierOrdre(input.exchange, order, parClientId.get(order.clientOrderId), input.now));
  }
  const cancellations = annulationsDe(orders, input.now);

  const reclames = new Set(enAttente.map((order) => order.clientOrderId));
  const observations: ReconcileObservations = {
    unknownOpenOrders: ouverts.filter((ordre) => !reclames.has(ordre.clientOrderId)),
    untrackedBalances: portfolio.balances.filter(
      (ligne) => !WHITELIST.includes(ligne.currency) && !ligne.total.isZero(),
    ),
  };

  const photo = await input.db.latestSnapshot();
  const holdings = holdingsFrom(totaux);

  /*
   * Aucun snapshot : le cache n'existe pas encore, il n'y a rien a confronter.
   * Ce n'est pas une divergence nulle, c'est une absence de comparaison, et le
   * resultat le dit — un premier run ne doit pas se lire comme un run valide.
   */
  if (photo === undefined) {
    return {
      balances: { [RECONCILIE]: true, holdings, comparedTo: 'NO_INTERNAL_STATE' },
      orders,
      cancellations,
      observations,
      /*
       * Pas de comparaison, donc pas de resynchronisation. `NOT_NEEDED` n'est
       * pas « rien n'a diverge » ici : c'est `comparedTo` qui porte l'absence de
       * cache, et les deux champs ne disent pas la meme chose.
       */
      resync: { status: 'NOT_NEEDED' },
    };
  }

  /*
   * Le seuil et sa comparaison ligne a ligne ne bougent pas ; **seule la
   * consequence a change**. Au-dela du seuil, les soldes rendus restent ceux de
   * l'exchange — ils l'etaient deja — et le cache est declare perime au lieu
   * d'arreter le run.
   */
  const divergences = divergencesOf(totaux, photo.positions);
  return {
    balances: { [RECONCILIE]: true, holdings, comparedTo: 'INTERNAL_SNAPSHOT' },
    orders,
    cancellations,
    observations,
    resync:
      divergences.length > 0
        ? { status: 'RESYNCHRONIZED', divergences, reason: resyncReason(divergences) }
        : { status: 'NOT_NEEDED' },
  };
}
