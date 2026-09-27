import type { CancelOutcome, PlacementOutcome, openCoinbaseExecution } from '../../src/adapters/coinbase.js';
import type {
  RecordDecisionOutcome,
  RecordOrderOutcome,
  RecordTransitionOutcome,
  openDatabase,
} from '../../src/adapters/db.js';
import type { PingOutcome, openHealthcheck } from '../../src/adapters/healthcheck.js';
import type { MailOutcome, openMailer } from '../../src/adapters/mailer.js';
import type { AlertOutcome, openNotifier } from '../../src/adapters/notifier.js';

/**
 * Test de types, verifie par `tsc --noEmit` (`make typecheck`), hors de Vitest.
 *
 * **Un adapter reel ne peut pas rendre `RETENU`.** `daily.ts` le compte comme
 * rendu (`toutParti`), `execute.ts` compte une annulation retenue comme un ordre
 * ferme : un vrai envoi manque qui le rendrait ferait taire le code de sortie.
 * Chaque fabrique reelle declare donc un type de retour etroit, sans `RETENU` ;
 * seul `inertes.ts` rend le type large du port, que `daily.ts` consomme sans
 * savoir dans quel mode il tourne (E15).
 *
 * Ce fichier tient la seconde moitie : il lit le type **declare** par chaque
 * fabrique. Qui le rendrait large — `openMailer(...): Mailer` — pour y faire
 * passer un `RETENU` ferait echouer l'assignation de `true` ci-dessous.
 */

/** `true` si aucune variante de `T` n'est `RETENU`, par `status` ou par `kind`. */
type SansRetenu<T> = [Extract<T, { readonly status: 'RETENU' } | { readonly kind: 'RETENU' }>] extends [never]
  ? true
  : false;

/** L'issue que rend la methode `M` du port construit par la fabrique `F`. */
type IssueDe<F extends (...args: never[]) => unknown, M extends keyof Awaited<ReturnType<F>>> =
  Awaited<ReturnType<F>>[M] extends (...args: never[]) => infer R ? Awaited<R> : never;

// Les fabriques reelles : aucune issue RETENU.
export const mailer: SansRetenu<IssueDe<typeof openMailer, 'sendReport'>> = true;
export const notifier: SansRetenu<IssueDe<typeof openNotifier, 'notify'>> = true;
export const healthcheck: SansRetenu<IssueDe<typeof openHealthcheck, 'ping'>> = true;
export const decision: SansRetenu<IssueDe<typeof openDatabase, 'recordDecision'>> = true;
export const ordre: SansRetenu<IssueDe<typeof openDatabase, 'recordOrder'>> = true;
export const transition: SansRetenu<IssueDe<typeof openDatabase, 'recordTransition'>> = true;
export const placement: SansRetenu<IssueDe<typeof openCoinbaseExecution, 'placeOrder'>> = true;
export const annulation: SansRetenu<IssueDe<typeof openCoinbaseExecution, 'cancelOrders'>[number]> = true;

// Le predicat n'est pas vide : les types larges des ports, eux, portent RETENU.
export const mailLarge: SansRetenu<MailOutcome> = false;
export const alerteLarge: SansRetenu<AlertOutcome> = false;
export const pingLarge: SansRetenu<PingOutcome> = false;
export const decisionLarge: SansRetenu<RecordDecisionOutcome> = false;
export const ordreLarge: SansRetenu<RecordOrderOutcome> = false;
export const transitionLarge: SansRetenu<RecordTransitionOutcome> = false;
export const placementLarge: SansRetenu<PlacementOutcome> = false;
export const annulationLarge: SansRetenu<CancelOutcome> = false;
