import type { Alert, AlertEvent, AlertPriority } from '../adapters/notifier.js';
import type { IsoDate, Rejection, StrategyName, UsdcAmount, Verdict } from '../core/types.js';
import type { Suspension } from './snapshot.js';

/**
 * Ce qui merite un push, et comment ca se lit sur un telephone. **Module pur** :
 * aucune IO, aucune horloge, aucun envoi. Il prend l'etat d'un run et rend une
 * liste d'alertes ; c'est `daily.ts` qui les fait partir.
 *
 * Cette separation n'est pas decorative. Elle permet d'eprouver « quel
 * evenement declenche quoi » sans reseau, sans jeton et sans double de
 * transport — et c'est la moitie du lot qui a le plus de chances de se tromper.
 *
 * ## Les sept evenements : un ajout a la spec, et un nom elargi
 *
 * Leurs **noms** sont figes depuis Q6a1, dans `ALERT_EVENTS` : ce module y
 * ajoute la priorite, l'ordre d'emission et le declencheur de chacun.
 *
 * Le §9 en nomme six : reequilibrage execute, drawdown, `REBALANCE_TOO_LARGE`,
 * divergence de reconciliation, jambe rejetee, job en echec. Deux ecarts sont
 * assumes, et `docs/alertes.md` §2 bis porte le detail :
 *
 * - **`RUN_ABORTED` est ajoute.** Le §9 ne prevoit d'alerte d'abandon que pour
 *   la divergence de reconciliation. Or un run abandonne n'ecrit **rien** — ni
 *   decision, ni photo — donc depuis la base il est indistinguable d'un job qui
 *   n'a pas tourne. Le cas s'est produit en reel : portefeuille vide, valeur
 *   totale nulle, abandon propre a l'etape de **valorisation**, aucune trace. Un
 *   evenement qui ne couvrirait que la divergence aurait laisse ce run-la muet.
 *   `RUN_ABORTED` couvre donc tout abandon dont la cause n'est pas la
 *   divergence, et les deux se **partagent** les abandons : jamais deux alertes
 *   pour un meme abandon, jamais zero.
 * - **`RISK_REJECTED` est plus large que « jambe rejetee ».** La couche risque
 *   rejette aussi au niveau du run, sans indice de jambe — `MIN_CASH` et
 *   `MAX_EXPOSURE` en particulier, qui disent que le portefeuille est hors de
 *   ses propres limites. S'en tenir litteralement a la jambe aurait rendu ces
 *   deux-la silencieux. L'evenement couvre donc **tout code de rejet** autre que
 *   `REBALANCE_TOO_LARGE`, lequel garde le sien parce que le §9 le nomme a part.
 *
 * ## Ce qui n'alerte pas
 *
 * `verdict.ignored` ne declenche rien. Une jambe residuelle de 12 USDC ecartee
 * en `LEG_TOO_SMALL` n'est pas un rejet : c'est le fonctionnement normal, et
 * `core/types.ts` separe les deux listes precisement pour qu'on ne les confonde
 * pas. Les confondre donnerait un push quasi quotidien, donc un operateur qui
 * apprend a ignorer ses alertes.
 *
 * Un run qui conclut sans rien de tout cela ne produit **aucune** alerte. Le
 * silence est le cas nominal ; c'est le healthcheck externe, au lot suivant, qui
 * distingue un silence normal d'un job qui n'a pas tourne.
 */

/** Les etapes ou `daily.ts` peut abandonner. Le type suit son `DailyAbort`. */
export type AbortStep = 'RECONCILE' | 'VALUATION' | 'DECIDE';

export type RunEnding =
  | { readonly status: 'COMPLETED' }
  | {
      readonly status: 'ABORTED';
      readonly step: AbortStep;
      readonly code: string;
      readonly reason: string;
    }
  /** Une exception a echappe au run : le job est en echec, pas abandonne. */
  | { readonly status: 'FAILED'; readonly reason: string };

/** Le verdict de la couche risque pour une strategie, tel que le run l'a obtenu. */
export interface RiskOutcome {
  readonly strategy: StrategyName;
  readonly isShadow: boolean;
  readonly verdict: Verdict;
}

/**
 * Un reequilibrage reellement passe. **Toujours vide en phase 1** : rien ne
 * s'execute, le garde-fou de noms d'`eslint.config.js` refuse le code qui le
 * ferait, et `daily.ts` passe une liste vide en le disant. Le chemin existe et
 * est eprouve directement ; il s'alimentera de la table `orders` en phase 3.
 */
export interface RebalanceExecuted {
  readonly strategy: StrategyName;
  readonly orders: number;
  readonly notional: UsdcAmount;
}

export interface AlertInput {
  readonly runDate: IsoDate;
  readonly ending: RunEnding;
  readonly suspension: Suspension;
  readonly outcomes: readonly RiskOutcome[];
  readonly executed: readonly RebalanceExecuted[];
}

/**
 * Le catalogue : une entree par evenement, et **une seule table pour les deux
 * choses** qu'un evenement porte en propre — sa priorite et son rang dans le
 * flot. Deux tables auraient pu diverger ; celle-ci est indexee par
 * `AlertEvent`, donc un evenement ajoute sans entree ne compile pas.
 *
 * `URGENT` traverse le mode « ne pas deranger » ; il est reserve a ce qui ne
 * peut pas attendre le lendemain matin — le capital bouge mal, ou le systeme ne
 * fait pas son travail. `HIGH` va a ce qui marche comme prevu et se raconte :
 * un reequilibrage passe, un garde-fou qui a mordu. Tout mettre en `URGENT`
 * reviendrait a n'avoir qu'un niveau, et l'operateur apprendrait a les ignorer
 * tous.
 *
 * Rien n'est importe d'`adapters/` en valeur : `src/jobs/` ne connait des
 * adapters que leurs types, et `test/jobs/purete.test.ts` (A20) le tient. C'est
 * pourquoi l'ordre est relu de cette table plutot que du tableau
 * `ALERT_EVENTS` de `notifier.ts`, et c'est une sonde — pas un import — qui
 * verifie que les deux listes disent la meme chose.
 */
const CATALOGUE: Readonly<Record<AlertEvent, AlertPriority>> = {
  REBALANCE_EXECUTED: 'HIGH',
  DRAWDOWN: 'URGENT',
  REBALANCE_TOO_LARGE: 'URGENT',
  RECONCILIATION_DRIFT: 'URGENT',
  RISK_REJECTED: 'HIGH',
  RUN_ABORTED: 'URGENT',
  JOB_FAILED: 'URGENT',
};

/**
 * L'ordre d'emission, lu de l'ordre de declaration du catalogue. Le recopier a
 * la main aurait donne un second endroit a tenir d'accord ; `Object.keys` sur
 * des cles non numeriques rend l'ordre d'insertion, et c'est celui du catalogue.
 */
export const ALERT_ORDER: readonly AlertEvent[] = Object.keys(CATALOGUE) as AlertEvent[];

/**
 * Le fabricant, et **le seul**. `runDate` est un champ de l'`Alert` depuis
 * Q6a1 : il entre dans la cle deterministe, donc deux runs du meme evenement a
 * deux jours differents ne portent pas la meme cle. Il reste aussi dans le
 * titre, ou c'est l'operateur qui le lit ; la cle, elle, ne se lit pas sur un
 * ecran verrouille.
 */
function alert(runDate: IsoDate, event: AlertEvent, title: string, body: string): Alert {
  return { event, priority: CATALOGUE[event], runDate, title, body };
}

/** Une strategie nommee comme la lit l'operateur : la production, ou une ombre. */
function nommer(strategy: StrategyName, isShadow: boolean): string {
  return isShadow ? `${strategy} (ombre)` : strategy;
}

/** Un rejet, une ligne : le code, la jambe s'il y en a une, puis le motif. */
function ligne(rejection: Rejection): string {
  const jambe = rejection.legIndex === undefined ? '' : ` (jambe ${String(rejection.legIndex)})`;
  return `${rejection.code}${jambe} : ${rejection.reason}`;
}

/**
 * Les codes d'un verdict rejete se **partagent** entre deux evenements :
 * `REBALANCE_TOO_LARGE` d'un cote, tout le reste de l'autre. Un partage, donc :
 * aucun code n'apparait deux fois, aucun ne disparait, et un verdict qui porte
 * les deux sortes produit exactement deux alertes.
 */
function rejets(runDate: IsoDate, outcome: RiskOutcome): Alert[] {
  if (outcome.verdict.status !== 'REJECTED') return [];
  const qui = nommer(outcome.strategy, outcome.isShadow);
  const trop = outcome.verdict.rejections.filter((r) => r.code === 'REBALANCE_TOO_LARGE');
  const autres = outcome.verdict.rejections.filter((r) => r.code !== 'REBALANCE_TOO_LARGE');
  const alerts: Alert[] = [];
  if (trop.length > 0) {
    alerts.push(
      alert(
        runDate,
        'REBALANCE_TOO_LARGE',
        `Ubac ${runDate} — reequilibrage trop gros, ${qui}`,
        `Le reequilibrage propose depasse la part maximale que la couche risque autorise en une fois.\n${trop.map(ligne).join('\n')}`,
      ),
    );
  }
  if (autres.length > 0) {
    alerts.push(
      alert(
        runDate,
        'RISK_REJECTED',
        `Ubac ${runDate} — decision rejetee, ${qui}`,
        `La couche risque a refuse la decision du jour.\n${autres.map(ligne).join('\n')}`,
      ),
    );
  }
  return alerts;
}

/**
 * Les abandons se partagent eux aussi : `RECONCILE` d'un cote, les autres
 * etapes de l'autre. Le partage est exhaustif par construction — il n'y a pas
 * de troisieme branche — donc tout abandon alerte, y compris celui d'un
 * portefeuille non valorisable, qui est le cas reellement observe.
 */
function abandon(runDate: IsoDate, ending: Extract<RunEnding, { status: 'ABORTED' }>): Alert {
  if (ending.step === 'RECONCILE') {
    return alert(
      runDate,
      'RECONCILIATION_DRIFT',
      `Ubac ${runDate} — divergence de reconciliation`,
      `Les soldes de l'exchange et le cache interne ne concordent plus. Le run s'est arrete AVANT toute ecriture : ni decision, ni photo.\n${ending.code} : ${ending.reason}`,
    );
  }
  return alert(
    runDate,
    'RUN_ABORTED',
    `Ubac ${runDate} — run abandonne (${ending.step})`,
    `Le run s'est arrete avant de conclure, donc sans rien ecrire : ni decision, ni photo. Depuis la base, la journee est vide comme si le job n'avait pas tourne — c'est cette alerte qui fait la difference.\n${ending.code} : ${ending.reason}`,
  );
}

/**
 * Toutes les alertes d'un run, dans l'ordre du catalogue. L'ordre sort du tri
 * et non d'une liste recopiee a la main : ajouter une entree au catalogue la
 * place, sans qu'un second endroit ait a etre tenu d'accord. Le tri de
 * `Array.prototype.sort` etant stable, deux alertes du meme evenement gardent
 * l'ordre des strategies.
 *
 * **C'est le seul endroit du depot qui fabrique une alerte.** Le run n'en
 * construit aucune de son cote.
 */
export function alertsFor(input: AlertInput): readonly Alert[] {
  const alerts: Alert[] = [];

  for (const done of input.executed) {
    alerts.push(
      alert(
        input.runDate,
        'REBALANCE_EXECUTED',
        `Ubac ${input.runDate} — reequilibrage execute, ${done.strategy}`,
        `${String(done.orders)} ordre(s) passe(s), ${done.notional.toFixed(2)} USDC deplaces.`,
      ),
    );
  }

  if (input.suspension.status === 'ACTIVE') {
    /*
     * Le texte vient de `snapshot.ts` et n'est pas reecrit ici : c'est celui que
     * porte la ligne de `decisions` du jour. Une seule source, donc l'alerte et
     * la base ne peuvent pas raconter deux chiffres differents — et le seuil
     * reste celui du §6, borne incluse, sans qu'un second seuil existe.
     */
    alerts.push(
      alert(
        input.runDate,
        'DRAWDOWN',
        `Ubac ${input.runDate} — drawdown au seuil, production suspendue`,
        input.suspension.reason,
      ),
    );
  }

  for (const outcome of input.outcomes) alerts.push(...rejets(input.runDate, outcome));

  if (input.ending.status === 'ABORTED') alerts.push(abandon(input.runDate, input.ending));

  if (input.ending.status === 'FAILED') {
    alerts.push(
      alert(
        input.runDate,
        'JOB_FAILED',
        `Ubac ${input.runDate} — job en echec`,
        `Une exception a echappe au run. Ce qui etait ecrit avant l'exception l'est reste ; le reste n'a pas eu lieu.\n${input.ending.reason}`,
      ),
    );
  }

  const rang = (event: AlertEvent): number => ALERT_ORDER.indexOf(event);
  return [...alerts].sort((a, b) => rang(a.event) - rang(b.event));
}
