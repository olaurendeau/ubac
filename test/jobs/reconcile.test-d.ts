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

// Le resultat non discrimine ne rend aucun solde : il faut narrower sur `status`.
// @ts-expect-error
void result.balances;

// Et la branche abandonnee n'en porte pas non plus.
if (result.status === 'ABORTED') {
  // @ts-expect-error
  void result.balances;
  void result.divergences;
}

if (result.status === 'RECONCILED') {
  decideSur(result.balances);
  const lu: Holdings = result.balances.holdings;
  void lu;
}
