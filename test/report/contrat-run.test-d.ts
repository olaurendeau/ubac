import type { SnapshotRecord } from '../../src/adapters/db.js';
import type { DailyRunResult } from '../../src/jobs/daily.js';
import type {
  CompletedRun,
  PreviousSnapshot,
  ReportDrawdown,
  ReportGap,
  ReportMarketDay,
  ReportOutcome,
  ReportSuspension,
} from '../../src/report/daily-report.js';

/**
 * Test de types, verifie par `tsc --noEmit` et jamais collecte par Vitest —
 * meme convention que `test/jobs/reconcile.test-d.ts`.
 *
 * Ce qu'il verrouille : **le rendu consomme le run sans l'importer**.
 * `eslint.config.js` l'interdit a `src/report/`, donc `CompletedRun` est une
 * forme recopiee — et « structurellement compatible » est le genre de promesse
 * qui devient fausse en silence : le jour ou `DailyRunResult` renomme un champ,
 * le rendu ne le sait pas, et l'ecart n'apparait qu'au branchement.
 *
 * L'arbre de test, lui, importe les deux. La compatibilite est donc fermee par
 * le typage, une sonde par variante annoncee : le tout, chaque champ lu, chaque
 * branche de chaque union, et ce qui doit rester refuse.
 */

type Completed = Extract<DailyRunResult, { status: 'COMPLETED' }>;
type Aborted = Extract<DailyRunResult, { status: 'ABORTED' }>;

declare const acheve: Completed;
declare const abandonne: Aborted;
declare const photo: SnapshotRecord;

/** V1 — le run acheve satisfait la forme entiere, sans adaptation. */
const entier: CompletedRun = acheve;
void entier;

/** V2 — un run abandonne ne la satisfait pas : ni valeur, ni poids, ni photo. Refus de typage, pas consigne. */
// @ts-expect-error
const refuse: CompletedRun = abandonne;
void refuse;

/** V3 — champ par champ, pour qu'un renommage dise **lequel** a bouge. Les onze champs lus, et rien d'autre. */
const runDate: CompletedRun['runDate'] = acheve.runDate;
const pricedOn: CompletedRun['pricedOn'] = acheve.pricedOn;
const totalValue: CompletedRun['totalValue'] = acheve.totalValue;
const weights: CompletedRun['weights'] = acheve.weights;
const holdings: CompletedRun['holdings'] = acheve.holdings;
const history: CompletedRun['history'] = acheve.history;
const benchmarks: CompletedRun['benchmarks'] = acheve.benchmarks;
const gaps: readonly ReportGap[] = acheve.benchmarkGaps;
const drawdown: ReportDrawdown = acheve.drawdown;
const suspension: ReportSuspension = acheve.suspension;
const outcomes: readonly ReportOutcome[] = acheve.outcomes;
void [runDate, pricedOn, totalValue, weights, holdings, history, benchmarks, gaps, drawdown, suspension, outcomes];

/**
 * V4 — les deux branches de chaque union. L'assignation du type entier ne dirait
 * rien du jour ou une branche perdrait son motif, et c'est le motif qui separe
 * une absence d'un oubli.
 */
declare const dessine: Extract<Completed['drawdown'], { status: 'COMPUTED' }>;
declare const sansDrawdown: Extract<Completed['drawdown'], { status: 'UNAVAILABLE' }>;
declare const suspendu: Extract<Completed['suspension'], { status: 'ACTIVE' }>;
declare const libre: Extract<Completed['suspension'], { status: 'INACTIVE' }>;
const branches: readonly [ReportDrawdown, ReportDrawdown, ReportSuspension, ReportSuspension] = [
  dessine,
  sansDrawdown,
  suspendu,
  libre,
];
void branches;

/** V5 — une bougie du run est un jour de marche du rapport : seule sa date est lue. */
declare const bougies: Completed['history']['BTC'];
const jours: readonly ReportMarketDay[] = bougies;
void jours;

/**
 * V6 — la photo precedente, telle que la base la rend, est une reference
 * valable, et c'est **celle que le run porte** : `previousSnapshot` est lu par
 * le branchement de Q5b, donc la compatibilite est fermee sur le champ reel et
 * pas seulement sur le type de l'adapter. `undefined` en fait partie — au
 * premier run il n'y a pas de veille, et le rendu le dit plutot que de se
 * replier sur une variation de valeur brute (C27).
 */
const veille: PreviousSnapshot = photo;
const veilleDuRun: PreviousSnapshot | undefined = acheve.previousSnapshot;
void [veille, veilleDuRun];

/** V7 — et la forme n'exige rien de plus : sans cette sonde, `CompletedRun` gagnerait une exigence que seul le branchement decouvrirait. */
declare function rendre(run: CompletedRun): void;
rendre({
  runDate: acheve.runDate,
  pricedOn: acheve.pricedOn,
  totalValue: acheve.totalValue,
  weights: acheve.weights,
  holdings: acheve.holdings,
  history: acheve.history,
  benchmarks: acheve.benchmarks,
  benchmarkGaps: acheve.benchmarkGaps,
  drawdown: acheve.drawdown,
  suspension: acheve.suspension,
  outcomes: acheve.outcomes,
});

/**
 * V8 — ce que le run porte et que le rendu ne lit pas. Un champ **ajoute** a
 * `DailyRunResult` passerait sans bruit dans V1 : la forme du rendu est plus
 * etroite, et un objet plus large lui reste assignable. C'est voulu — le rapport
 * n'a pas a lire tout le run — mais « sans bruit » est exactement ce qui laisse
 * un nouveau champ ne jamais arriver au rapport, sans que personne n'ait
 * decide qu'il ne devait pas. La liste des champs non lus est donc figee dans
 * les deux sens : un ajout au run la casse, une suppression aussi, et il faut
 * alors dire ici si le rapport doit rendre ce champ ou non.
 */
type NonLus = Exclude<keyof Completed, keyof CompletedRun>;
/**
 * `report` rejoint la liste en Q6a2, et c'est une decision, pas un oubli : il
 * porte le sort des alertes push, qui sont le canal **court**. Le rapport
 * quotidien est le canal long ; y recopier ce qui vient d'etre pousse sur le
 * telephone donnerait la meme nouvelle deux fois, la seconde avec un jour de
 * retard. Ce qui manque au rapport d'un abandon, c'est le rapport lui-meme —
 * un run abandonne n'en produit aucun — et cela se regle par l'alerte, pas par
 * une colonne de plus. Q5b n'a rien change a cette decision : `deliverReport`
 * rend `SKIPPED` sur un abandon, avec son motif.
 *
 * `previousSnapshot` rejoint la liste en Q5b, et c'est le cas inverse : le
 * rapport **le lit**, mais pas a travers `CompletedRun`. C'est le second
 * parametre du rendu, `DailyReportInput.previous`, et V6 ci-dessus etablit
 * qu'un `SnapshotRecord` y est assignable. Il ne peut donc pas entrer dans la
 * forme du run acheve sans y etre lu deux fois.
 *
 * `resync` rejoint la liste en Q10, et c'est la meme decision que pour `report`,
 * pour la meme raison. Une resynchronisation de l'etat interne part en alerte
 * `RECONCILIATION_DRIFT` le jour meme, en `URGENT`, et sa trace durable est le
 * marqueur en tete de `decisions.reason` — deux canaux qui ne dependent pas du
 * courrier du lendemain. Le rapport quotidien la repeterait au petit dejeuner
 * sans rien apprendre a personne. Si cette decision devait changer, c'est ici
 * qu'on le verrait.
 */
type NonLusAttendus =
  | 'status'
  | 'gitSha'
  | 'prices'
  | 'cashFlows'
  | 'observations'
  | 'resync'
  | 'snapshot'
  | 'report'
  | 'previousSnapshot';
type MemeEnsemble<A extends B, B> = A;
declare const nonLus: [MemeEnsemble<NonLus, NonLusAttendus>, MemeEnsemble<NonLusAttendus, NonLus>];
void nonLus;
