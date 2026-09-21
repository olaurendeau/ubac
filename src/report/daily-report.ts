import { Decimal } from 'decimal.js';

import { SHARPE_WINDOW } from '../core/benchmark.js';
import type { Holdings } from '../core/portfolio.js';
import { ASSETS } from '../core/portfolio.js';
import type { RebalanceParams } from '../core/strategy/rebalance.js';
import { cashBand, ratioBand } from '../core/strategy/rebalance.js';
import type {
  AllowedAsset,
  Intent,
  IsoDate,
  StrategyName,
  UsdcAmount,
  Verdict,
  Weights,
} from '../core/types.js';
import { lexique } from './lexique.js';

/**
 * Le **rendu** du rapport quotidien du §9. Pur : aucun reseau, aucune horloge,
 * aucun environnement. Il rend un objet ; `src/adapters/mailer.ts` l'envoie.
 *
 * Les motifs sont dans `docs/rapport-quotidien.md`. Six proprietes en resume :
 *
 * 1. **aucune metrique n'est calculee ici** — les cinq du noyau arrivent
 *    calculees dans `benchmarks`, ce module les lit par leur cle ;
 * 2. **une seule valeur y echappe, la distance au prochain declenchement**, que
 *    le noyau ne produit pas : donc la seule qui puisse etre fausse sans qu'aucun
 *    test du noyau ne bronche ;
 * 3. **le P&L est un TWR**, jamais une variation de valeur brute (C27) ;
 * 4. **le rapport part toujours**, `trigger NONE` compris : aucune branche de ce
 *    fichier ne rend `undefined` ;
 * 5. **une metrique absente se dit absente, avec son motif**, jamais par un zero ;
 * 6. **le rendu ne connait pas `src/jobs/`** — `eslint.config.js` l'interdit, et
 *    `test/report/contrat-run.test-d.ts` ferme la compatibilite par le typage.
 *
 * Le corps est **sans accent**, comme les `reason` du noyau qu'il cite telles
 * quelles.
 */

// --- Ce que le rendu consomme du run ----------------------------------------

/** Une cle absente de `benchmarks`, et son motif. `code` reste ouvert : ce module cite le vocabulaire des refus, il ne le decide pas. */
export interface ReportGap {
  readonly key: string;
  readonly code: string;
  readonly reason: string;
}

export type ReportDrawdown =
  | { readonly status: 'COMPUTED'; readonly drawdown: Decimal }
  | { readonly status: 'UNAVAILABLE'; readonly code: string; readonly reason: string };

export type ReportSuspension =
  | { readonly status: 'ACTIVE'; readonly drawdown: Decimal; readonly reason: string }
  | { readonly status: 'INACTIVE' };

/** Une strategie du §8 : ce qu'elle a decide, et ce que la couche risque en a dit. */
export interface ReportOutcome {
  readonly strategy: StrategyName;
  readonly isShadow: boolean;
  readonly intent: Intent;
  readonly verdict: Verdict;
}

/** Un jour de la fenetre OHLCV. Reduit a sa date : le rendu n'en lit rien d'autre. */
export interface ReportMarketDay {
  readonly date: string;
}

/** Le run acheve, vu par le rapport : plus etroit que `DailyRunResult`, ce qui n'y est pas n'est pas lu. */
export interface CompletedRun {
  readonly runDate: IsoDate;
  /** Dernier jour clos : celui dont les clotures ont servi de prix. */
  readonly pricedOn: IsoDate;
  readonly totalValue: UsdcAmount;
  readonly weights: Weights;
  readonly holdings: Holdings;
  readonly history: Readonly<Record<'BTC' | 'ETH', readonly ReportMarketDay[]>>;
  readonly benchmarks: Readonly<Record<string, Decimal>>;
  readonly benchmarkGaps: readonly ReportGap[];
  readonly drawdown: ReportDrawdown;
  readonly suspension: ReportSuspension;
  readonly outcomes: readonly ReportOutcome[];
}

/** La photo de reference du P&L du jour : un `SnapshotRecord` reduit au necessaire. */
export interface PreviousSnapshot {
  readonly runDate: IsoDate;
  readonly benchmarks: Readonly<Record<string, Decimal>>;
}

export interface DailyReportInput {
  readonly run: CompletedRun;
  /** Cibles et bandes de la configuration de **production**. */
  readonly params: RebalanceParams;
  /** Absente au premier run, ou quand l'appelant ne l'a pas lue. */
  readonly previous?: PreviousSnapshot;
}

/** Ce que le rendu produit, et tout ce dont l'envoi a besoin. */
export interface DailyReportMail {
  readonly subject: string;
  readonly html: string;
  /** §9 : « Tag `daily-report` sur chaque envoi ». */
  readonly tags: readonly string[];
}

/** §9. Fige ici, consomme par l'envoi : deux litteraux divergeraient. */
export const REPORT_TAG = 'daily-report';

// --- Les cles de `snapshots.benchmarks` -------------------------------------

/**
 * Les cles sous lesquelles `src/jobs/snapshot.ts` ecrit ses metriques,
 * **recopiees** et non importees : le rendu n'importe pas un job. Une recopie
 * derive en silence — un rapport qui lit `holdbtc_twr` n'affiche pas une erreur,
 * il affiche « indisponible ». Un test confronte les deux tables. Le suffixe du
 * Sharpe, lui, est derive de la fenetre du noyau : la changer ne peut pas
 * oublier la cle.
 */
const SHARPE_SUFFIX = `sharpe_${String(SHARPE_WINDOW)}d`;

export interface HoldKeys {
  readonly label: string;
  readonly twr: string;
  readonly maxDrawdown: string;
  readonly sharpe: string;
}

const holdKeys = (label: string): HoldKeys => ({
  label,
  twr: `${label}_twr`,
  maxDrawdown: `${label}_max_drawdown`,
  sharpe: `${label}_${SHARPE_SUFFIX}`,
});

export const HOLD_BTC_KEYS = holdKeys('hold_btc');
export const HOLD_5050_KEYS = holdKeys('hold_5050');

export const PORTFOLIO_KEYS = {
  index: 'portfolio_twr_index',
  peak: 'portfolio_twr_peak',
  drawdown: 'portfolio_drawdown',
} as const;

// --- Lecture des metriques --------------------------------------------------

export type Metric =
  | { readonly status: 'VALUE'; readonly value: Decimal }
  | { readonly status: 'MISSING'; readonly reason: string };

const missing = (reason: string): Metric => ({ status: 'MISSING', reason });

/**
 * `snapshot.ts` groupe deux familles de refus sous une cle terminee par `*` —
 * `hold_btc_*` quand tout un hold est refuse, `hold_*` quand les series de
 * marche ne s'apparient pas. Le prefixe fait remonter le vrai motif.
 */
function gapFor(key: string, gaps: readonly ReportGap[]): ReportGap | undefined {
  return (
    gaps.find((gap) => gap.key === key) ??
    gaps.find((gap) => gap.key.endsWith('*') && key.startsWith(gap.key.slice(0, -1)))
  );
}

/** Une valeur non finie vaut absence : « NaN % » la ou le rapport doit dire qu'il ne sait pas. */
function metricOf(key: string, run: CompletedRun): Metric {
  const value = run.benchmarks[key];
  if (value !== undefined && value.isFinite()) return { status: 'VALUE', value };
  const gap = gapFor(key, run.benchmarkGaps);
  if (gap !== undefined) return missing(`${gap.code} : ${gap.reason}`);
  return missing(
    value === undefined
      ? `cle ${key} absente de la photo du jour, et aucun motif ne l'accompagne.`
      : `cle ${key} a ${value.toString()} : valeur non finie, aucune mise en forme n'en decoule.`,
  );
}

/**
 * P&L cumule. L'indice vaut 1 a la premiere photo et ne bouge que des rendements,
 * flux exclus : `indice - 1` **est** le TWR depuis l'origine, au meme titre que
 * `timeWeightedReturn` rend son produit moins 1. Unite, pas second calcul.
 */
function cumulativeReturn(run: CompletedRun): Metric {
  const index = metricOf(PORTFOLIO_KEYS.index, run);
  return index.status === 'VALUE' ? { status: 'VALUE', value: index.value.minus(1) } : index;
}

/**
 * P&L du jour : le quotient de deux indices consecutifs, moins 1, tous deux
 * chaines flux exclus. La photo de reference doit etre **strictement
 * anterieure** — un second run du meme jour relit la photo du jour, le quotient
 * vaudrait 1 et le rapport annoncerait une journee plate qui n'a pas eu lieu.
 */
function dayReturn(run: CompletedRun, previous: PreviousSnapshot | undefined): Metric {
  const today = metricOf(PORTFOLIO_KEYS.index, run);
  if (today.status === 'MISSING') return today;
  if (previous === undefined) {
    return missing(
      "aucune photo de reference : le P&L du jour demande l'indice de la veille, et une variation de valeur brute n'en serait pas un (C27).",
    );
  }
  if (previous.runDate >= run.runDate) {
    return missing(
      `photo de reference du ${previous.runDate}, non anterieure au run du ${run.runDate} : le quotient vaudrait 1 et se lirait comme une journee plate.`,
    );
  }
  const before = previous.benchmarks[PORTFOLIO_KEYS.index];
  if (before === undefined || !before.isFinite() || before.lte(0)) {
    return missing(
      `photo du ${previous.runDate} sans indice de croissance exploitable : le quotient n'est pas defini.`,
    );
  }
  return { status: 'VALUE', value: today.value.div(before).minus(1) };
}

// --- Distance au prochain declenchement -------------------------------------

/**
 * De combien il s'en faut pour que la bande soit franchie. La seule valeur du
 * rapport que le noyau ne produit pas ; `docs/rapport-quotidien.md` §3 porte les
 * motifs, resumes ici.
 *
 * **Les bornes sont dans la bande** (C6) : `decide()` tire strictement sous la
 * borne basse et strictement au-dessus de la haute, jamais dessus. Les memes
 * comparaisons sont ecrites ici — `lt` et `gt`, jamais `lte` ni `gte` —, et un
 * test confronte le verdict de ce module a celui de `decide()` sur le meme etat.
 *
 * Deux cas que le §9 ne tranche pas, tranches ici :
 *
 * - **exactement sur une borne** : distance nulle, statut `INSIDE`, drapeau
 *   `onEdge`. Rendre `CROSSED` avancerait le declenchement d'un jour ; taire
 *   `onEdge` afficherait « 0.00 pt » sans qu'on sache si c'est une marge nulle.
 * - **deja hors bande** : plus aucune distance a parcourir, statut `CROSSED`, et
 *   la valeur utile devient le **depassement**. Afficher « 0 » confondrait « au
 *   bord » et « dehors » — l'un annonce, l'autre constate.
 *
 * A egalite des deux marges, c'est la borne **basse** qui est designee : choix
 * arbitraire mais deterministe, un rapport se rejoue a l'identique.
 */
export type BandDistance =
  | {
      readonly status: 'INSIDE';
      /** Marge jusqu'a la borne basse : `valeur - basse`, positive ou nulle. */
      readonly toLower: Decimal;
      /** Marge jusqu'a la borne haute : `haute - valeur`, positive ou nulle. */
      readonly toUpper: Decimal;
      /** La borne la plus proche, et la marge qui l'en separe. */
      readonly side: 'LOWER' | 'UPPER';
      readonly gap: Decimal;
      /** Marge nulle : sur la borne, pas encore franchie. */
      readonly onEdge: boolean;
    }
  | {
      readonly status: 'CROSSED';
      readonly side: 'LOWER' | 'UPPER';
      /** De combien la borne est depassee. Strictement positif. */
      readonly overshoot: Decimal;
    }
  | { readonly status: 'UNDEFINED'; readonly reason: string };

export function bandDistance(value: Decimal, lower: Decimal, upper: Decimal): BandDistance {
  /* Sur un NaN, `lt` et `gt` repondent false : sans ce controle le cas ressortirait « dans la bande ». */
  if (!value.isFinite() || !lower.isFinite() || !upper.isFinite()) {
    return {
      status: 'UNDEFINED',
      reason: `valeur ${value.toString()} contre bande [${lower.toString()}, ${upper.toString()}] : une distance demande trois nombres finis.`,
    };
  }
  if (lower.gt(upper)) {
    return {
      status: 'UNDEFINED',
      reason: `bande [${lower.toString()}, ${upper.toString()}] inversee : aucune distance n'a de sens.`,
    };
  }
  if (value.lt(lower)) {
    return { status: 'CROSSED', side: 'LOWER', overshoot: lower.minus(value) };
  }
  if (value.gt(upper)) {
    return { status: 'CROSSED', side: 'UPPER', overshoot: value.minus(upper) };
  }
  const toLower = value.minus(lower);
  const toUpper = upper.minus(value);
  const gap = Decimal.min(toLower, toUpper);
  return {
    status: 'INSIDE',
    toLower,
    toUpper,
    side: toUpper.lt(toLower) ? 'UPPER' : 'LOWER',
    gap,
    onEdge: gap.isZero(),
  };
}

// --- Mise en forme ----------------------------------------------------------

/** Aucun `Number()`, aucun flottant : `Decimal.toFixed` rend directement la chaine. */
const SCALE = 2;

const usdc = (value: Decimal): string => `${value.toFixed(SCALE)} USDC`;

const pct = (value: Decimal): string => `${value.times(100).toFixed(SCALE)} %`;

/** Un rendement : le signe explicite evite de lire une perte comme un gain. */
const signedPct = (value: Decimal): string =>
  `${value.isNegative() ? '' : '+'}${value.times(100).toFixed(SCALE)} %`;

/** Une marge de bande de poids, en points de pourcentage : 0.048 se lit « 4.80 pt ». */
const points = (value: Decimal): string => `${value.times(100).toFixed(SCALE)} pt`;

/** Le ratio BTC/ETH et ses marges : un quotient de poids, sans unite et sans pourcentage. */
const RATIO_SCALE = 4;
const ratioText = (value: Decimal): string =>
  value.isFinite() ? value.toFixed(RATIO_SCALE) : value.toString();

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Aucune `reason` du noyau ne porte de balise aujourd'hui, et c'est pourquoi
 * l'echappement est ici : le jour ou l'une en portera, personne n'y reviendra.
 */
const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

const metricText = (metric: Metric, show: (value: Decimal) => string): string =>
  metric.status === 'VALUE' ? show(metric.value) : 'indisponible';

// --- Le corps HTML ----------------------------------------------------------

/* En ligne, une colonne, rien d'externe : un client qui bloque les ressources distantes rend le meme rapport. */
const BODY = 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.45;color:#16191d;max-width:520px;margin:0 auto;padding:12px';
const H2 = 'font-size:15px;margin:18px 0 6px;padding-bottom:4px;border-bottom:1px solid #d8dce1';
const TABLE = 'width:100%;border-collapse:collapse;font-size:14px';
const CELL = 'padding:4px 6px;border-bottom:1px solid #eceef1;text-align:left;vertical-align:top';
const HEAD = `${CELL};font-weight:600;color:#5a6472`;
const NOTE = 'font-size:13px;color:#5a6472;margin:6px 0';
const ALERT = 'background:#fdecec;border-left:3px solid #c0392b;padding:8px;margin:10px 0';

/**
 * Une cellule, etalee sur plusieurs colonnes quand une raison prend la place des
 * chiffres. Le cas n'existe que pour une ligne sans metrique : recopier la meme
 * phrase dans trois cellules, ou en laisser deux vides derriere elle, se lirait
 * comme un rendu casse.
 */
type Cell = string | { readonly text: string; readonly span: number };

const cells = (values: readonly Cell[], style: string): string =>
  values
    .map((value) =>
      typeof value === 'string'
        ? `<td style="${style}">${value}</td>`
        : `<td style="${style}" colspan="${String(value.span)}">${value.text}</td>`,
    )
    .join('');

const table = (header: readonly Cell[], rows: readonly (readonly Cell[])[]): string =>
  `<table style="${TABLE}"><tr>${cells(header, HEAD)}</tr>` +
  rows.map((row) => `<tr>${cells(row, CELL)}</tr>`).join('') +
  '</table>';

const section = (title: string, body: string): string => `<h2 style="${H2}">${title}</h2>${body}`;

/** L'unite est un parametre : une marge de poids se lit en points, une marge de ratio en unites de ratio. */
function distanceText(distance: BandDistance, show: (value: Decimal) => string): string {
  const borne = (side: 'LOWER' | 'UPPER'): string => (side === 'LOWER' ? 'basse' : 'haute');
  switch (distance.status) {
    case 'CROSSED':
      return `franchie — ${show(distance.overshoot)} au-dela de la borne ${borne(distance.side)}`;
    case 'INSIDE':
      return distance.onEdge
        ? `sur la borne ${borne(distance.side)} — la bande est fermee, le moindre pas au-dela declenche`
        : `${show(distance.gap)} de la borne ${borne(distance.side)}`;
    case 'UNDEFINED':
      return `indisponible — ${distance.reason}`;
  }
}

/**
 * Le poids USDC contre sa bande, le ratio BTC/ETH contre la sienne quand B est
 * arme. Sinon le rapport le dit : une ligne absente se lirait « rien a signaler »,
 * alors que la bande n'est simplement pas surveillee (§5.2).
 */
function distanceSection(input: DailyReportInput): string {
  const { run, params } = input;
  const bande = cashBand(params);
  const cash = bandDistance(run.weights.USDC, bande.lower, bande.upper);
  const rows: string[][] = [
    [
      'Bande de cash (A)',
      `USDC ${pct(run.weights.USDC)}`,
      `[${pct(bande.lower)}, ${pct(bande.upper)}]`,
      distanceText(cash, points),
    ],
  ];

  if (params.ratioBandEnabled) {
    const bandeRatio = ratioBand(params);
    const ratio = run.weights.BTC.div(run.weights.ETH);
    rows.push([
      'Bande de ratio (B)',
      `BTC/ETH ${ratioText(ratio)}`,
      `[${ratioText(bandeRatio.lower)}, ${ratioText(bandeRatio.upper)}]`,
      distanceText(bandDistance(ratio, bandeRatio.lower, bandeRatio.upper), ratioText),
    ]);
  }

  const note = params.ratioBandEnabled
    ? ''
    : `<p style="${NOTE}">Declencheur B desarme : le ratio BTC/ETH n'est pas surveille en production (§5.2).</p>`;

  return section(
    'Distance au prochain declenchement',
    table(['Bande', 'Constate', 'Bornes', 'Distance'], rows) + note,
  );
}

/** Poids constates contre cibles, ligne par ligne. */
function allocationSection(run: CompletedRun, targets: Weights): string {
  const rows = ASSETS.map((asset: AllowedAsset) => [
    asset,
    run.holdings[asset].toFixed(8),
    pct(run.weights[asset]),
    pct(targets[asset]),
    signedPct(run.weights[asset].minus(targets[asset])),
  ]);
  return section('Allocation', table(['Ligne', 'Quantite', 'Poids', 'Cible', 'Ecart'], rows));
}

/** La decision de chaque strategie, `trigger NONE` compris — le §9 l'exige nommement. */
function decisionSection(run: CompletedRun): string {
  const rows = run.outcomes.map((outcome) => [
    `${outcome.strategy}${outcome.isShadow ? ' (ombre)' : ''}`,
    outcome.intent.trigger,
    `${String(outcome.intent.legs.length)} jambe(s)`,
    outcome.verdict.status === 'ACCEPTED'
      ? 'ACCEPTED'
      : `REJECTED:${outcome.verdict.rejections.map((rejet) => rejet.code).join(',')}`,
    escape(outcome.intent.reason),
  ]);
  return section('Decision du jour', table(['Strategie', 'Trigger', 'Jambes', 'Risque', 'Motif'], rows));
}

/** L'en-tete du tableau de comparaison : le nom, puis les colonnes de metriques. */
const COMPARISON_HEADER: readonly string[] = [
  '',
  'TWR cumule',
  'Max drawdown',
  `Sharpe ${String(SHARPE_WINDOW)} j`,
];

/**
 * Le §9 demande quatre comparaisons ; deux n'ont pas de courbe en phase 1, et
 * c'est **le tableau** qui le dit, a la place exacte ou l'operateur les cherche.
 * Une absence dont la raison vit ailleurs — note de bas de rapport, commentaire
 * de source, page de documentation — se lit comme une panne. L'ecart avec la
 * spec est porte par `docs/rapport-quotidien.md` §6.
 */
const SANS_COURBE =
  "sans courbe en phase 1 : aucune strategie n'execute, son portefeuille simule serait le portefeuille reel";

/** La raison couvre toutes les colonnes de metriques, derivees de l'en-tete : en ajouter une ne peut pas laisser la ligne courte. */
const ombreRow = (label: string): readonly Cell[] => [
  label,
  { text: SANS_COURBE, span: COMPARISON_HEADER.length - 1 },
];

/**
 * Les fenetres ne coincident pas des deux cotes du tableau — hold sur la fenetre
 * OHLCV du run, portefeuille chaine depuis la premiere photo — et le rapport le
 * dit plutot que d'aligner deux chiffres qui ne se comparent pas.
 */
function comparisonSection(input: DailyReportInput): string {
  const { run } = input;
  const window = run.history.BTC;
  const first = window[0]?.date ?? '?';
  const last = window[window.length - 1]?.date ?? '?';

  const holdRow = (label: string, keys: HoldKeys): string[] => [
    label,
    metricText(metricOf(keys.twr, run), signedPct),
    metricText(metricOf(keys.maxDrawdown, run), signedPct),
    metricText(metricOf(keys.sharpe, run), (value) => value.toFixed(SCALE)),
  ];

  /* La photo porte l'indice et son sommet, pas la serie : ni pire recul passe ni Sharpe ne s'en lisent. */
  const sansSerie = metricText(missing('la photo ne porte pas la serie'), signedPct);
  const rows: (readonly Cell[])[] = [
    ['Portefeuille', metricText(cumulativeReturn(run), signedPct), sansSerie, sansSerie],
    holdRow('Hold BTC', HOLD_BTC_KEYS),
    holdRow('Hold 50/50', HOLD_5050_KEYS),
    ombreRow('Ladder (ombre)'),
    ombreRow('DCA (ombre)'),
  ];

  const recul = metricText(
    run.drawdown.status === 'COMPUTED'
      ? { status: 'VALUE', value: run.drawdown.drawdown }
      : missing(run.drawdown.reason),
    signedPct,
  );

  return section(
    'Comparaison',
    table(COMPARISON_HEADER, rows) +
      `<p style="${NOTE}">Portefeuille : TWR depuis la premiere photo. Hold : fenetre OHLCV de ${String(window.length)} jour(s), du ${escape(first)} au ${escape(last)}. Les deux periodes ne coincident pas tant que le systeme n'a pas tourne aussi longtemps que la fenetre.</p>` +
      `<p style="${NOTE}">Recul actuel depuis le plus haut : ${recul}. Ce n'est pas un max drawdown : la photo porte l'indice et son sommet, pas la serie — ni le pire recul passe ni le Sharpe du portefeuille ne s'en lisent.</p>` +
      `<p style="${NOTE}">Ladder et DCA : leur decision du jour figure ci-dessus ; leur P&L demande un rejeu jour par jour, pas une photo.</p>`,
  );
}

/** Ce que le noyau n'a pas pu rendre, et pourquoi. Une absence sans motif serait un oubli. */
function gapSection(run: CompletedRun): string {
  if (run.benchmarkGaps.length === 0) return '';
  const rows = run.benchmarkGaps.map((gap) => [
    escape(gap.key),
    escape(gap.code),
    escape(gap.reason),
  ]);
  return section('Metriques indisponibles', table(['Cle', 'Code', 'Motif'], rows));
}

/**
 * Le vocabulaire du rapport, **en derniere section**. Une seule section, aucune
 * glose dans les tableaux : un en-tete `Max drawdown (pire recul subi depuis un
 * sommet)` triplerait la largeur de sa colonne et ferait deborder le tableau
 * horizontalement sur un telephone — il casserait precisement la lecture qu'on
 * cherche a reparer.
 *
 * Les entrees conditionnelles suivent ce que **ce** rapport imprime : le
 * contexte est lu sur le run, et pas devine.
 */
function lexiqueSection(run: CompletedRun): string {
  const entrees = lexique({
    triggers: run.outcomes.map((outcome) => outcome.intent.trigger),
    rejets: run.outcomes.flatMap((outcome) =>
      outcome.verdict.status === 'REJECTED'
        ? outcome.verdict.rejections.map((rejet) => rejet.code)
        : [],
    ),
    suspendu: run.suspension.status === 'ACTIVE',
    metriquesIndisponibles: run.benchmarkGaps.length > 0,
  });
  return section(
    'Lexique',
    table(
      ['Terme', 'Definition'],
      entrees.map((entree) => [escape(entree.terme), escape(entree.definition)]),
    ),
  );
}

// --- Point d'entree ---------------------------------------------------------

/** La strategie de production : la seule dont le trigger resume le run. */
const production = (run: CompletedRun): ReportOutcome | undefined =>
  run.outcomes.find((outcome) => !outcome.isShadow);

/** L'objet tient sur un ecran verrouille. Une suspension passe devant le trigger : c'est la seule ligne qui demande une decision humaine. */
function subjectOf(run: CompletedRun): string {
  const tete = `Ubac ${run.runDate} — ${usdc(run.totalValue)}`;
  if (run.suspension.status === 'ACTIVE') {
    return `${tete} — SUSPENDU (recul ${signedPct(run.suspension.drawdown)})`;
  }
  const prod = production(run);
  if (prod === undefined) return `${tete} — aucune strategie de production`;
  if (prod.intent.trigger === 'NONE') return `${tete} — aucun declenchement`;
  return `${tete} — ${prod.intent.trigger}, ${String(prod.intent.legs.length)} jambe(s)`;
}

/** Le rapport du §9. **Toujours un courrier**, `trigger NONE` compris. */
export function renderDailyReport(input: DailyReportInput): DailyReportMail {
  const { run } = input;

  const alerte =
    run.suspension.status === 'ACTIVE'
      ? `<div style="${ALERT}">${escape(run.suspension.reason)}</div>`
      : '';

  const jour = dayReturn(run, input.previous);
  const entete = table(
    ['Valeur totale', 'P&L jour (TWR)', 'P&L cumule (TWR)'],
    [[usdc(run.totalValue), metricText(jour, signedPct), metricText(cumulativeReturn(run), signedPct)]],
  );
  const noteJour =
    jour.status === 'MISSING' ? `<p style="${NOTE}">P&L du jour : ${escape(jour.reason)}</p>` : '';

  const html =
    `<div style="${BODY}">` +
    `<h1 style="font-size:17px;margin:0 0 4px">Ubac — rapport du ${escape(run.runDate)}</h1>` +
    `<p style="${NOTE}">Prix de cloture du ${escape(run.pricedOn)}. Phase 1 : observation, aucun ordre n'est place.</p>` +
    alerte +
    entete +
    noteJour +
    distanceSection(input) +
    decisionSection(run) +
    allocationSection(run, input.params.targets) +
    comparisonSection(input) +
    gapSection(run) +
    /* En dernier, et c'est donc ce que la coupure de Gmail emporte en premier, au-dela d'environ 102 ko. Le rapport en est loin ; ce qui l'en rapprocherait est un lot a venir, pas celui-ci. */
    lexiqueSection(run) +
    '</div>';

  return { subject: subjectOf(run), html, tags: [REPORT_TAG] };
}
