import type { TransitionToRecord } from '../../src/adapters/db.js';
import type { Holdings } from '../../src/core/portfolio.js';
import type { ReconciledBalances, ReconcileResult } from '../../src/jobs/reconcile.js';

/**
 * Test de types, verifie par `tsc --noEmit` et jamais collecte par Vitest —
 * meme convention que `test/core/types.test-d.ts`. Chaque `@ts-expect-error` est
 * une assertion : si la protection qu'il documente disparait, tsc echoue sur la
 * directive devenue inutile.
 *
 * Ce que ce fichier verrouille : **on ne decide pas sur des soldes qu'on n'a pas
 * reconcilies**, et ce n'est pas une consigne mais une impossibilite de typage.
 */

declare const holdings: Holdings;
declare const result: ReconcileResult;

/** Ce qu'un consommateur exigera en Q4b. */
declare function decideSur(balances: ReconciledBalances): void;

// La marque est un symbole que le module n'exporte pas : le litteral ne peut
// pas la nommer, donc aucun ReconciledBalances ne se fabrique a la main.
// @ts-expect-error
const forge: ReconciledBalances = { holdings, comparedTo: 'INTERNAL_SNAPSHOT' };
void forge;

// Des soldes bruts ne sont pas des soldes reconcilies.
// @ts-expect-error
decideSur({ holdings, comparedTo: 'INTERNAL_SNAPSHOT' });

// Le resultat porte toujours des soldes : la branche d'abandon a disparu avec la
// divergence bloquante, donc il n'y a plus rien a discriminer pour les lire.
decideSur(result.balances);
const lu: Holdings = result.balances.holdings;
void lu;

// Un jour de resynchronisation en porte aussi, et ce sont ceux de l'exchange :
// c'est le cache qui s'est rendu, pas le run qui s'est arrete.
if (result.resync.status === 'RESYNCHRONIZED') {
  decideSur(result.balances);
  const ecarts = result.resync.divergences;
  void ecarts;
}

// Le motif, lui, n'existe que sur cette branche-la : un resultat non discrimine
// ne peut pas affirmer qu'un etat s'est resynchronise.
// @ts-expect-error
void result.resync.reason;

// La ligne a ecrire lie le statut a son instant (E38) : un ordre ouvert n'a pas
// d'instant de denouement, et une issue en a toujours un.
declare const commune: Omit<TransitionToRecord, 'status' | 'settledAt'>;
declare const instant: Date;
const ouverte: TransitionToRecord = { ...commune, status: 'PARTIAL', settledAt: null };
const issue: TransitionToRecord = { ...commune, status: 'FILLED', settledAt: instant };
// @ts-expect-error
const ouverteDatee: TransitionToRecord = { ...commune, status: 'PENDING', settledAt: instant };
// @ts-expect-error
const issueSansDate: TransitionToRecord = { ...commune, status: 'CANCELLED', settledAt: null };
// @ts-expect-error — `EXPIRED` n'est pas une valeur du §4 : il s'ecrit `CANCELLED`.
const horsDuPara4: TransitionToRecord = { ...commune, status: 'EXPIRED', settledAt: instant };
void [ouverte, issue, ouverteDatee, issueSansDate, horsDuPara4];
