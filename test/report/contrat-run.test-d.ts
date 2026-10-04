import type { CashFlowRecord, ExecutedOrderRecord, SnapshotPoint, SnapshotRecord } from '../../src/adapters/db.js';
import type { DailyRunResult } from '../../src/jobs/daily.js';
import type {
  CompletedRun,
  DailyReportInput,
  PreviousSnapshot,
  ReportCashFlow,
  ReportExecutedOrder,
  ReportMovements,
  ReportDrawdown,
  ReportExecution,
  ReportGap,
  ReportMarketDay,
  ReportOutcome,
  ReportResync,
  ReportSuspension,
  TwrPoint,
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
declare const point: SnapshotPoint;

/** V1 — le run acheve satisfait la forme entiere, sans adaptation. */
const entier: CompletedRun = acheve;
void entier;

/** V2 — un run abandonne ne la satisfait pas : ni valeur, ni poids, ni photo. Refus de typage, pas consigne. */
// @ts-expect-error
const refuse: CompletedRun = abandonne;
void refuse;

/** V3 — champ par champ, pour qu'un renommage dise **lequel** a bouge. Les treize champs lus, et rien d'autre. */
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
/** E28 (S7b) : l'etape 6 vue de l'exchange, que le rapport rend en « Ordres du jour ». */
const executions: readonly ReportExecution[] = acheve.executions;
/** CV15 (Y8) : un jour d'apport, la resynchronisation et le refus d'executer passent par le rapport. */
const resync: ReportResync = acheve.resync;
void [runDate, pricedOn, totalValue, weights, holdings, history, benchmarks, gaps, drawdown, suspension, outcomes, executions, resync];

/**
 * V4 — les deux branches de chaque union. L'assignation du type entier ne dirait
 * rien du jour ou une branche perdrait son motif, et c'est le motif qui separe
 * une absence d'un oubli.
 */
declare const dessine: Extract<Completed['drawdown'], { status: 'COMPUTED' }>;
declare const sansDrawdown: Extract<Completed['drawdown'], { status: 'UNAVAILABLE' }>;
declare const suspendu: Extract<Completed['suspension'], { status: 'ACTIVE' }>;
declare const libre: Extract<Completed['suspension'], { status: 'INACTIVE' }>;
declare const resynchronise: Extract<Completed['resync'], { status: 'RESYNCHRONIZED' }>;
declare const concordant: Extract<Completed['resync'], { status: 'NOT_NEEDED' }>;
const branches: readonly [ReportDrawdown, ReportDrawdown, ReportSuspension, ReportSuspension, ReportResync, ReportResync] = [
  dessine,
  sansDrawdown,
  suspendu,
  libre,
  resynchronise,
  concordant,
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
  resync: acheve.resync,
  outcomes: acheve.outcomes,
  executions: acheve.executions,
});

/**
 * V6 bis — la serie du graphe. Meme forme de sonde que V6, et meme motif : le
 * rendu la lit par `DailyReportInput.series` et non a travers `CompletedRun`,
 * donc la compatibilite se ferme sur le champ reel du run **et** sur le type que
 * l'adapter rend. Une photo reduite aux deux colonnes utiles est un point du
 * graphe ; l'inverse n'a pas a etre vrai.
 */
const unPoint: TwrPoint = point;
const serieDuRun: DailyReportInput['series'] = acheve.snapshotSeries;
void [unPoint, serieDuRun];

/**
 * V6 ter — les derniers mouvements, meme sonde que V6 bis : le rendu les lit par
 * `DailyReportInput.movements`. Un flux et un ordre execute tels que la base les
 * rend sont les deux sources du journal, et les deux branches du run — lu,
 * illisible — en sont une chacune.
 */
declare const flux: CashFlowRecord;
declare const ordre: ExecutedOrderRecord;
declare const lus: Extract<Completed['latestMovements'], { status: 'READ' }>;
declare const illisibles: Extract<Completed['latestMovements'], { status: 'UNREADABLE' }>;
const unFlux: ReportCashFlow = flux;
const unOrdre: ReportExecutedOrder = ordre;
const mouvementsDuRun: DailyReportInput['movements'] = acheve.latestMovements;
const deuxBranches: readonly [ReportMovements, ReportMovements] = [lus, illisibles];
void [unFlux, unOrdre, mouvementsDuRun, deuxBranches];

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
 * `resync` avait rejoint la liste en Q10, et **l'a quittee en Y8** (CV15) : c'est
 * ici que la decision change, comme ce commentaire l'annoncait. Une
 * resynchronisation non expliquee part toujours en `RECONCILIATION_DRIFT`, et le
 * rapport ne la repete pas. Mais le jour ou l'ecart est entierement explique par
 * les flux enregistres, l'alerte se tait, et c'est le rapport qui dit l'etat
 * resynchronise et le refus d'executer (E60, T6) : il lit donc `resync`.
 *
 * `snapshotSeries` rejoint la liste pour exactement le meme motif que
 * `previousSnapshot` : le graphe la lit, mais par `DailyReportInput.series`, et
 * V6 bis le tient. `latestMovements` la rejoint pour le meme motif encore : la
 * section « Derniers mouvements » le lit par `DailyReportInput.movements`, et V6 ter
 * le tient.
 */
type NonLusAttendus =
  | 'status'
  | 'gitSha'
  | 'prices'
  | 'cashFlows'
  | 'observations'
  | 'snapshot'
  | 'report'
  | 'previousSnapshot'
  | 'snapshotSeries'
  | 'latestMovements'
  | 'placements';
type MemeEnsemble<A extends B, B> = A;
declare const nonLus: [MemeEnsemble<NonLus, NonLusAttendus>, MemeEnsemble<NonLusAttendus, NonLus>];
void nonLus;
