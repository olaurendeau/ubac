import { Decimal } from 'decimal.js';

import type { AssetBalance, CoinbaseReader, OpenOrder } from '../adapters/coinbase.js';
import type { PendingOrderRecord, UbacDatabase } from '../adapters/db.js';
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
 *    que ce module vient de rendre. Voir la section « ordres » ci-dessous et
 *    `docs/reconciliation.md` : l'ecriture manque, et la *lecture* du statut
 *    d'un ordre denoue, que l'adapter sait faire depuis S2, n'est pas encore
 *    branchee ici. **S2 porte la lecture, S8 porte le branchement, et E37 n'est
 *    clos qu'apres les deux.**
 * 3. **Aucune horloge.** Ni systeme, ni injectee : aucune decision de ce module
 *    ne depend du temps. La seule regle du §7 qui en dependait, l'annulation des
 *    ordres de plus de 24 h, est reportee en phase 3. Le jour ou elle arrive,
 *    l'horloge devient un parametre de `ReconcileInput` ; elle ne se lit pas
 *    ici. `src/jobs/` etant hors du glob de purete d'`eslint.config.js`, cet
 *    interdit tient par un garde-fou de `test/jobs/`, pas par le lint.
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

// --- Ordres : ce que la phase 1 sait lire, et ce qu'elle ne sait pas ---------

/**
 * Le statut reel d'un ordre `PENDING`, pour ce que le depot **sait lire**.
 *
 * `PENDING` et `PARTIAL` reprennent les valeurs de la colonne `status` du §4.
 * `INDETERMINABLE` n'en est pas une : ce module ne lit que les ordres
 * **ouverts**, donc un `PENDING` absent de cette liste s'est denoue — execute,
 * annule ou rejete — et rien de ce qu'il lit ne dit lequel. L'adapter sait le
 * lire depuis S2 (`orderStatus`, `orderFills`) ; le brancher ici est S8.
 * `docs/reconciliation.md` §4 l'argumente.
 *
 * L'union force l'appelant a traiter le troisieme cas. Le replier sur une valeur
 * par defaut classerait un ordre execute en annule, ce qui est pire que de ne
 * pas le classer.
 */
export type ReconciledOrderStatus =
  | { readonly kind: 'PENDING' }
  | { readonly kind: 'PARTIAL'; readonly filled: Quantity }
  | { readonly kind: 'INDETERMINABLE'; readonly reason: string };

export interface PendingOrderReconciliation {
  readonly order: PendingOrderRecord;
  readonly status: ReconciledOrderStatus;
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
 * Ce que la reconciliation rend. **Il n'y a pas de branche d'abandon**, et c'est
 * le lot : le seul motif que le §7 en donnait — la divergence de solde —
 * rafraichit desormais le cache au lieu de geler le systeme. Une branche
 * d'abandon que plus rien n'atteint n'aurait eu ni sonde ni lecteur ; le depot
 * refuse le code mort desarme, ici comme pour l'annulation a 24 h.
 */
export interface ReconcileResult {
  readonly balances: ReconciledBalances;
  readonly orders: readonly PendingOrderReconciliation[];
  readonly observations: ReconcileObservations;
  readonly resync: Resynchronization;
}

/**
 * `Pick` plutot que les interfaces entieres : le type dit exactement ce que la
 * reconciliation touche. Elle ne ferme ni la connexion ni le pool — le run
 * possede leur cycle de vie —, et elle n'ecrit nulle part.
 */
export interface ReconcileInput {
  readonly exchange: Pick<CoinbaseReader, 'balances' | 'openOrders'>;
  readonly db: Pick<UbacDatabase, 'pendingOrders' | 'latestSnapshot'>;
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

function statusOf(surExchange: OpenOrder | undefined, order: PendingOrderRecord): ReconciledOrderStatus {
  if (surExchange === undefined) {
    return {
      kind: 'INDETERMINABLE',
      reason: `ordre ${order.clientOrderId} absent des ordres ouverts : il s'est denoue, mais la reconciliation ne dit pas encore comment. Determiner l'issue demande le statut d'un ordre donne ou ses executions, que l'adapter lit mais que ce module n'utilise pas encore.`,
    };
  }
  // Un ordre encore ouvert et partiellement execute reste ouvert chez Coinbase :
  // la quantite executee est la seule chose qui distingue PARTIAL de PENDING.
  if (surExchange.filled.isZero()) return { kind: 'PENDING' };
  return { kind: 'PARTIAL', filled: surExchange.filled };
}

// --- Reconciliation ---------------------------------------------------------

/**
 * §7, dans l'ordre de la spec : lire, confronter les ordres, confronter les
 * soldes. L'etape 3 — annuler les ordres limit de plus de 24 h — est reportee en
 * phase 3 ; le motif est dans `docs/reconciliation.md` et ce n'est pas un oubli.
 *
 * Les deux lectures de l'exchange sont sequentielles et **ne sont pas
 * atomiques** : un ordre peut se denouer entre les deux. La consequence va
 * toujours dans le sens de la verite de l'exchange — soit la ligne apparait
 * `INDETERMINABLE`, soit les soldes divergent du cache et la divergence est
 * declaree —, jamais dans celui d'un etat perime accepte en silence. En phase 1
 * la fenetre est theorique : aucun ordre n'est place.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const portfolio = await input.exchange.balances();
  const ouverts = await input.exchange.openOrders();
  const totaux = totalsByCurrency(portfolio.balances);

  const enAttente = await input.db.pendingOrders();
  const parClientId = new Map(ouverts.map((ordre) => [ordre.clientOrderId, ordre]));
  const orders = enAttente.map((order) => ({
    order,
    status: statusOf(parClientId.get(order.clientOrderId), order),
  }));

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
    observations,
    resync:
      divergences.length > 0
        ? { status: 'RESYNCHRONIZED', divergences, reason: resyncReason(divergences) }
        : { status: 'NOT_NEEDED' },
  };
}
