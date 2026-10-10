import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings } from '../../src/core/portfolio.js';
import type { RebalanceParams } from '../../src/core/strategy/rebalance.js';
import {
  DEFAULT_REBALANCE_PARAMS,
  cashBand,
  decide,
} from '../../src/core/strategy/rebalance.js';
import type { Intent, Price, Quantity, UsdcAmount, Verdict, Weight, Weights } from '../../src/core/types.js';
import { HOLD_5050_KEYS, HOLD_BTC_KEYS, PORTFOLIO_KEYS } from '../../src/jobs/snapshot.js';
import type {
  CompletedRun,
  DailyReportInput,
  ReportCashFlow,
  ReportExecutedOrder,
  ReportMovements,
  ReportExecution,
  ReportOutcome,
  TwrPoint,
} from '../../src/report/daily-report.js';
import {
  DERNIERS_MOUVEMENTS,
  MAX_COLONNES,
  REPORT_TAG,
  bandDistance,
  journal,
  renderDailyReport,
  twrGraph,
  HOLD_5050_KEYS as REPORT_5050_KEYS,
  HOLD_BTC_KEYS as REPORT_BTC_KEYS,
  PORTFOLIO_KEYS as REPORT_PORTFOLIO_KEYS,
} from '../../src/report/daily-report.js';

/**
 * Le rendu du §9, sur un etat fige. **Aucun reseau, aucune cle, aucune base** :
 * ce fichier n'importe que du code pur, et `src/jobs/snapshot.ts` n'y sert qu'a
 * confronter deux tables de cles.
 *
 * Ce qu'il etablit : le rapport entier ligne a ligne sur un etat fige ; la
 * distance au prochain declenchement aux deux bornes, **dessus** et de part et
 * d'autre, et son accord avec `decide()` ; le P&L lu sur l'indice de croissance
 * et jamais sur la valeur ; un rapport qui part sur quatre triggers `NONE` ; une
 * metrique absente dite absente avec son motif ; et les cles lues ici egales a
 * celles que la photo ecrit.
 */

// --- L'etat fige ------------------------------------------------------------

const dec = (value: string): Decimal => new Decimal(value);
const poids = (value: string): Weight => dec(value) as Weight;

const WEIGHTS: Weights = { BTC: poids('0.41'), ETH: poids('0.28'), USDC: poids('0.31') };

const HOLDINGS: Holdings = {
  BTC: dec('0.5') as Quantity,
  ETH: dec('8') as Quantity,
  USDC: dec('31000') as Quantity,
};

const PRICES = { BTC: dec('82000') as Price, ETH: dec('3500') as Price };

/** Quatre lignes `NONE` : le cas nominal du §9, celui qui doit partir quand meme. */
const intent = (strategy: ReportOutcome['strategy'], reason: string): Intent => ({
  runDate: '2026-09-13',
  strategy,
  trigger: 'NONE',
  reason,
  weightsBefore: WEIGHTS,
  weightsTarget: DEFAULT_REBALANCE_PARAMS.targets,
  legs: [],
});

const ACCEPTE: Verdict = { status: 'ACCEPTED', orders: [], ignored: [] };

const OUTCOMES: readonly ReportOutcome[] = [
  { strategy: 'rebalance', isShadow: false, intent: intent('rebalance', 'poids USDC dans la bande : aucun reequilibrage'), verdict: ACCEPTE },
  { strategy: 'rebalance_ab', isShadow: true, intent: intent('rebalance_ab', 'ratio dans la bande : aucun reequilibrage'), verdict: ACCEPTE },
  { strategy: 'ladder', isShadow: true, intent: intent('ladder', 'ancres posees au cours du jour'), verdict: ACCEPTE },
  { strategy: 'dca', isShadow: true, intent: intent('dca', 'hors jour de DCA'), verdict: ACCEPTE },
];

/**
 * Ce que la photo du jour porte. Aucune valeur n'est ronde : un rendu qui en
 * remplacerait une par une constante ne rendrait pas ces chiffres-la, et
 * `0.9999` est la sonde d'arrondi du Sharpe.
 */
const BENCHMARKS: Readonly<Record<string, Decimal>> = {
  [PORTFOLIO_KEYS.index]: dec('1.25'),
  [PORTFOLIO_KEYS.peak]: dec('1.30'),
  [PORTFOLIO_KEYS.drawdown]: dec('-0.0385'),
  [HOLD_BTC_KEYS.twr]: dec('0.4123'),
  [HOLD_BTC_KEYS.maxDrawdown]: dec('-0.2718'),
  [HOLD_BTC_KEYS.sharpe]: dec('1.4142'),
  [HOLD_5050_KEYS.twr]: dec('0.3010'),
  [HOLD_5050_KEYS.maxDrawdown]: dec('-0.3141'),
  [HOLD_5050_KEYS.sharpe]: dec('0.9999'),
};

const RUN: CompletedRun = {
  runDate: '2026-09-13',
  pricedOn: '2026-09-12',
  totalValue: dec('100000') as UsdcAmount,
  weights: WEIGHTS,
  holdings: HOLDINGS,
  history: {
    BTC: [{ date: '2026-09-10' }, { date: '2026-09-11' }, { date: '2026-09-12' }],
    ETH: [{ date: '2026-09-10' }, { date: '2026-09-11' }, { date: '2026-09-12' }],
  },
  benchmarks: BENCHMARKS,
  benchmarkGaps: [],
  drawdown: { status: 'COMPUTED', drawdown: dec('-0.0385') },
  suspension: { status: 'INACTIVE' },
  resync: { status: 'NOT_NEEDED' },
  outcomes: OUTCOMES,
  executions: [],
};

/** La photo de la veille : c'est elle qui rend le P&L du jour calculable. */
const VEILLE = { runDate: '2026-09-12', benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.20') } };

/**
 * Les photos lues a l'etape 4bis : quatre, **arretees a la veille**. Le point du
 * jour n'y est pas — il est compose par le rendu a partir du run —, et c'est
 * cette composition qui rend un second run identique au premier.
 */
const SERIE: readonly TwrPoint[] = [
  { runDate: '2026-09-09', benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.10') } },
  { runDate: '2026-09-10', benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.15') } },
  { runDate: '2026-09-11', benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.18') } },
  { runDate: '2026-09-12', benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.20') } },
];

/** Un flux tel que le run le lit, signe compris. `note` absente : personne n'a dit d'ou il venait. */
const flux = (instant: string, montant: string, note: string | null = null, id = `flux-${instant}`): ReportCashFlow => ({
  id,
  occurredAt: new Date(instant),
  occurredOn: instant.slice(0, 10),
  amount: dec(montant) as UsdcAmount,
  note,
});

/** Un ordre execute tel que le run le lit : `instant` est deja celui de D4, denouement ou creation. */
const ordre = (
  instant: string,
  side: 'BUY' | 'SELL',
  asset: string,
  quantite: string,
  prix: string,
  frais: string | null,
  options: { readonly open?: boolean; readonly id?: string } = {},
): ReportExecutedOrder => ({
  clientOrderId: options.id ?? `ubac-${instant}`,
  side,
  asset,
  filledQty: dec(quantite) as Quantity,
  filledPrice: dec(prix) as Price,
  fees: frais === null ? null : (dec(frais) as UsdcAmount),
  occurredAt: new Date(instant),
  occurredOn: instant.slice(0, 10),
  open: options.open ?? false,
});

const lus = (cashFlows: readonly ReportCashFlow[], orders: readonly ReportExecutedOrder[] = []): ReportMovements => ({
  status: 'READ',
  cashFlows,
  orders,
});

/** Le mouvement de la table reelle : un seul apport, anterieur au run. */
const MOUVEMENTS: ReportMovements = lus([flux('2026-09-01T10:00:00Z', '1000', 'virement initial')]);
const SANS_MOUVEMENT: ReportMovements = lus([]);

const INPUT: DailyReportInput = {
  run: RUN,
  params: DEFAULT_REBALANCE_PARAMS,
  previous: VEILLE,
  series: SERIE,
  movements: MOUVEMENTS,
};

/** Un point de serie, reduit a ce que le graphe lit. `indice` absent : la colonne restera vide. */
const point = (runDate: string, indice?: string): TwrPoint => ({
  runDate,
  benchmarks: indice === undefined ? {} : { [PORTFOLIO_KEYS.index]: dec(indice) },
});

/** Une serie de `n` photos, d'indice croissant et de dates distinctes, toutes anterieures au run. */
function serieDe(n: number): readonly TwrPoint[] {
  return Array.from({ length: n }, (_, rang) => {
    const jour = new Date(Date.UTC(2000, 0, 1) + rang * 86_400_000).toISOString().slice(0, 10);
    return point(jour, dec('1').plus(dec(String(rang)).div(10_000)).toFixed(6));
  });
}

const avecRun = (patch: Partial<CompletedRun>): DailyReportInput => ({
  ...INPUT,
  run: { ...RUN, ...patch },
});

/**
 * Le texte du rapport, cellule par cellule. Les separateurs sont poses avant que
 * les balises ne tombent : sans eux, deux cellules voisines se recolleraient et
 * une valeur disparaitrait dans la suivante sans qu'aucune assertion ne bronche.
 */
const ENTITES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function lignes(html: string): readonly string[] {
  return html
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<\/(tr|p|h1|h2|div|table)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    /* Apres la chute des balises, et pas avant : sinon un `&lt;b&gt;` echappe redeviendrait une balise et disparaitrait a son tour. */
    .replace(/&(amp|lt|gt|quot|#39);/g, (entite) => ENTITES[entite] ?? entite)
    .split('\n')
    .map((ligne) => ligne.replace(/\s+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter((ligne) => ligne.length > 0);
}

// --- Le rapport entier, sur l'etat fige -------------------------------------

describe('rendu — la sortie attendue, ligne a ligne', () => {
  it('rend exactement le rapport de l’etat fige', () => {
    expect(lignes(renderDailyReport(INPUT).html)).toEqual([
      'Ubac — rapport du 2026-09-13',
      "Prix de cloture du 2026-09-12. Les ordres de la production partent en limit post-only ; les ombres n'en placent aucun.",
      'Valeur totale | P&L jour (TWR) | P&L cumule (TWR)',
      '100000.00 USDC | +4.17 % | +25.00 %',
      'Distance au prochain declenchement',
      'Bande | Constate | Bornes | Distance',
      'Bande de cash (A) | USDC 31.00 % | [24.00 %, 36.00 %] | 5.00 pt de la borne haute',
      "Declencheur B desarme : le ratio BTC/ETH n'est pas surveille en production (§5.2).",
      'Evolution du portefeuille (TWR cumule)',
      "P&L cumule (TWR) depuis la premiere photo, lu sur l'indice de croissance : 5 photo(s), du 2026-09-09 au 2026-09-13, 1 colonne = 1 photo. Echelle de +10.00 % a +25.00 %, et non depuis zero : une variation faible occupe toute la hauteur.",
      'Decision du jour',
      'Strategie | Trigger | Jambes | Risque | Motif',
      'rebalance | NONE | 0 jambe(s) | ACCEPTED | poids USDC dans la bande : aucun reequilibrage',
      'rebalance_ab (ombre) | NONE | 0 jambe(s) | ACCEPTED | ratio dans la bande : aucun reequilibrage',
      'ladder (ombre) | NONE | 0 jambe(s) | ACCEPTED | ancres posees au cours du jour',
      'dca (ombre) | NONE | 0 jambe(s) | ACCEPTED | hors jour de DCA',
      'Ordres du jour',
      'Ordres | Nombre',
      'Place | 0',
      'Execute | 0',
      'Partiel | 0',
      'Non execute | 0',
      'Statut non lu | 0',
      'Rejete (post-only) | 0',
      'Rejete (autre motif) | 0',
      'Frais reels | 0.00 USDC',
      "Aucun ordre n'est parti aujourd'hui.",
      'Allocation',
      'Ligne | Quantite | Poids | Cible | Ecart',
      'BTC | 0.50000000 | 41.00 % | 40.00 % | +1.00 %',
      'ETH | 8.00000000 | 28.00 % | 30.00 % | -2.00 %',
      'USDC | 31000.00000000 | 31.00 % | 30.00 % | +1.00 %',
      'Comparaison',
      '| TWR cumule | Max drawdown | Sharpe 90 j',
      'Portefeuille | +25.00 % | indisponible | indisponible',
      'Hold BTC | +41.23 % | -27.18 % | 1.41',
      'Hold 50/50 | +30.10 % | -31.41 % | 1.00',
      "Ladder (ombre) | sans courbe en phase 1 : aucune strategie n'execute, son portefeuille simule serait le portefeuille reel",
      "DCA (ombre) | sans courbe en phase 1 : aucune strategie n'execute, son portefeuille simule serait le portefeuille reel",
      "Portefeuille : TWR depuis la premiere photo. Hold : fenetre OHLCV de 3 jour(s), du 2026-09-10 au 2026-09-12. Les deux periodes ne coincident pas tant que le systeme n'a pas tourne aussi longtemps que la fenetre.",
      "Recul actuel depuis le plus haut : -3.85 %. Ce n'est pas un max drawdown : la photo porte l'indice et son sommet, pas la serie — ni le pire recul passe ni le Sharpe du portefeuille ne s'en lisent.",
      'Ladder et DCA : leur decision du jour figure ci-dessus ; leur P&L demande un rejeu jour par jour, pas une photo.',
      'Derniers mouvements',
      'Date | Mouvement | Montant | Detail',
      '2026-09-01 | Apport | 1000.00 USDC | virement initial',
      'Les 8 plus recents au plus, apports, retraits et ordres executes confondus, du plus recent au plus ancien, quelle que soit leur date. Montant vu du cash : un retrait ou un achat est negatif, un apport ou une vente positif. Un ordre compte pour sa quantite executee au prix moyen, hors frais ; en cours, il est encore au carnet et date de sa creation.',
      'Lexique',
      'Terme | Definition',
      "P&L | Profit and loss : ce que le portefeuille a gagne ou perdu sur la periode, en pourcentage de ce qu'il valait.",
      "TWR | Time-weighted return : le rendement une fois les apports et les retraits neutralises, donc ce que la gestion a fait et non ce qu'un virement a ajoute.",
      "indice de croissance | Le cumul des rendements quotidiens, flux exclus, parti de 1,00 a la premiere photo : a 1,25 le portefeuille a gagne 25 % depuis l'origine.",
      "photo | L'etat du portefeuille enregistre une fois par jour — valeur, poids, quantites et metriques — et jamais recalcule ensuite.",
      "prix de cloture | Le dernier cours du dernier jour clos, le seul qui ne bouge plus ; celui du jour en cours change encore, et une decision prise dessus serait fausse sans qu'aucun seuil ne morde.",
      "USDC | Le dollar numerique qui sert de monnaie au portefeuille : tout y est valorise, et le cash n'est detenu que sous cette forme.",
      "bande | L'intervalle dans lequel une grandeur surveillee a le droit de flotter sans qu'aucun reequilibrage ne soit propose.",
      "borne | L'une des deux extremites d'une bande. Elle appartient a la bande : etre exactement dessus ne declenche rien, le pas suivant si.",
      "trigger | Ce qui a declenche la decision du jour, ou NONE quand rien ne l'a declenchee.",
      "jambe | Un ordre elementaire d'un reequilibrage : un actif, un sens et un montant. Une decision en compte zero, une, ou plusieurs.",
      'risque | Le verdict de la couche de risque sur la decision du jour : ACCEPTED si elle passe, REJECTED suivi du code du refus sinon.',
      "place | Un ordre que l'exchange a accepte et pose au carnet. Les quatre etats qui suivent se partagent les ordres places, et eux seuls.",
      'execute | Un ordre place entierement rempli : la quantite demandee a change de mains au prix limite ou mieux.',
      'partiel | Un ordre place dont une partie seulement a ete remplie ; la quantite remplie est donnee entre parentheses.',
      "non execute | Un ordre place dont rien n'a encore ete rempli, ou qui a pris fin sans l'etre.",
      "statut non lu | Un ordre place dont le run n'a pas pu relire l'etat : il n'est compte ni execute ni non execute, et ses frais restent inconnus.",
      "post-only | Un ordre qui ne doit jamais croiser le carnet : s'il le croisait, l'exchange le rejette, et c'est le fonctionnement normal, pas une panne.",
      "frais reels | Les frais que l'exchange a effectivement preleves sur les ordres du jour, tels qu'il les rend, et jamais une estimation.",
      'poids | La part que represente une ligne dans la valeur totale, en pourcentage. La colonne Cible donne la part visee, la colonne Ecart la difference des deux.',
      "ombre | Une strategie evaluee chaque jour mais qui ne place jamais d'ordre : elle sert de point de comparaison, pas de gestion.",
      "hold | Ne rien faire, et le mesurer : Hold BTC garde du BTC seul, Hold 50/50 garde moitie BTC moitie ETH, aucun des deux n'arbitre jamais.",
      "ladder | Une strategie en echelle : une ancre par actif, un achat quand le cours passe un palier sous elle, une vente quand il en passe un au-dessus. En phase 1 elle est en ombre.",
      'DCA | Dollar cost averaging : acheter un montant fixe a intervalle fixe, sans regarder le cours. En phase 1 elle est en ombre.',
      "max drawdown | La pire baisse jamais subie entre un sommet et le creux qui l'a suivi, sur toute la periode mesuree.",
      "recul actuel depuis le plus haut | De combien l'indice est descendu sous son plus haut connu, aujourd'hui et non dans le passe. C'est la mesure sur laquelle la suspension se declenche.",
      'Sharpe 90 j | Le rendement rapporte a son agitation sur les 90 derniers jours : plus il est haut, plus la performance a ete reguliere plutot que chanceuse.',
      'fenetre OHLCV | Le nombre de jours de cours — ouverture, haut, bas, cloture, volume — que le run a relus pour calculer les courbes de reference.',
      "mouvement | Une ligne des derniers mouvements : un apport ou un retrait d'USDC, ou un ordre execute en tout ou en partie. Le montant est vu du cash : un retrait ou un achat est negatif. Le TWR neutralise les apports et les retraits ; un ordre ne fait qu'echanger une ligne contre une autre.",
      "NONE | Aucune bande n'est franchie : le run constate l'etat du portefeuille et ne propose rien.",
    ]);
  });

  it('porte le tag du §9, un objet lisible et rien d’externe', () => {
    const mail = renderDailyReport(INPUT);
    expect(mail.tags).toEqual([REPORT_TAG]);
    expect(REPORT_TAG).toBe('daily-report');
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — jour +4.17 % · cumul +25.00 % — aucun declenchement');
    /* HTML en ligne : ni feuille distante, ni image, ni script. */
    expect(mail.html).not.toMatch(/<(link|img|script|style)\b/);
    expect(mail.html).toContain('style="font-family');
  });

  it('echappe ce qu’il cite : un motif balise ne devient pas du balisage', () => {
    const balise = { ...OUTCOMES[0]!, intent: intent('rebalance', 'poids <b>0.31</b> & "cible"') };
    const html = renderDailyReport(avecRun({ outcomes: [balise] })).html;
    expect(html).toContain('poids &lt;b&gt;0.31&lt;/b&gt; &amp; &quot;cible&quot;');
    expect(html).not.toContain('<b>0.31</b>');
  });
});

// --- Le rapport part meme sans declenchement --------------------------------

describe('§9 — un rapport part meme quand le trigger vaut NONE', () => {
  it('rend un courrier complet sur quatre triggers NONE', () => {
    const mail = renderDailyReport(INPUT);
    expect(RUN.outcomes.every((outcome) => outcome.intent.trigger === 'NONE')).toBe(true);
    expect(mail.html).toContain('Decision du jour');
    expect(mail.subject).toContain('aucun declenchement');
    expect(mail.html.length).toBeGreaterThan(500);
  });

  it('annonce le declenchement et les jambes quand il y en a', () => {
    const tire: ReportOutcome = {
      ...OUTCOMES[0]!,
      intent: {
        ...intent('rebalance', 'poids USDC sous la borne basse : retour a la cible'),
        trigger: 'CASH_BAND',
        legs: [
          { asset: 'BTC', quote: 'USDC', side: 'SELL', amount: dec('4000') as UsdcAmount, limitPrice: PRICES.BTC },
        ],
      },
    };
    const mail = renderDailyReport(avecRun({ outcomes: [tire, ...OUTCOMES.slice(1)] }));
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — jour +4.17 % · cumul +25.00 % — CASH_BAND, 1 jambe(s)');
    expect(lignes(mail.html)).toContain(
      'rebalance | CASH_BAND | 1 jambe(s) | ACCEPTED | poids USDC sous la borne basse : retour a la cible',
    );
  });

  it('met la suspension du §6 devant le trigger, et la rend en clair', () => {
    const mail = renderDailyReport(
      avecRun({ suspension: { status: 'ACTIVE', drawdown: dec('-0.2612'), reason: 'SUSPENSION_DRAWDOWN : recul a -26.12 %' } }),
    );
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — jour +4.17 % · cumul +25.00 % — SUSPENDU (recul -26.12 %)');
    expect(mail.html).toContain('SUSPENSION_DRAWDOWN : recul a -26.12 %');
  });

  it('le dit plutot que d’inventer un trigger quand aucune ligne n’est en production', () => {
    const mail = renderDailyReport(avecRun({ outcomes: OUTCOMES.slice(1) }));
    expect(mail.subject).toContain('aucune strategie de production');
  });

  it('rejette le verdict de risque avec son code', () => {
    const rejete: ReportOutcome = {
      ...OUTCOMES[0]!,
      verdict: { status: 'REJECTED', rejections: [{ code: 'MIN_CASH', reason: 'cash projete trop bas' }] },
    };
    expect(lignes(renderDailyReport(avecRun({ outcomes: [rejete] })).html)).toContain(
      'rebalance | NONE | 0 jambe(s) | REJECTED:MIN_CASH | poids USDC dans la bande : aucun reequilibrage',
    );
  });
});

describe('CV15 — un jour d’apport, le rapport dit ce que l’alerte ne dit plus', () => {
  /*
   * Le texte est celui du run : marqueur, ecart, apport, et la phrase du refus
   * d'executer (E60) que `daily.ts` y ajoute. Le rendu ne la connait pas et ne
   * la reecrit pas ; ce litteral en tient lieu.
   */
  const MOTIF =
    "ETAT_RESYNCHRONISE : USDC : 32100 sur l'exchange contre 30000 en interne, explique par 2100 USDC de flux enregistres depuis la photo. Jour de resynchronisation : le run refuse d'executer (O6).";
  const EXPLIQUE = { status: 'RESYNCHRONIZED', explainedByFlows: true, reason: MOTIF } as const;
  /** L'encadre et lui seul : les decisions de `OUTCOMES` ne portent pas ce motif, mais celles d'un vrai run, si. */
  const encadre = (html: string): readonly string[] =>
    lignes(html).filter((ligne) => ligne.startsWith('Etat interne resynchronise, ecart explique par les flux enregistres.'));

  it('l’encadre porte le motif entier, refus d’executer compris, et l’objet le resume', () => {
    const mail = renderDailyReport(avecRun({ resync: EXPLIQUE }));

    expect(encadre(mail.html)).toEqual([
      `Etat interne resynchronise, ecart explique par les flux enregistres. Aucune alerte n'est partie pour cet ecart : c'est ce rapport qui le dit. Aucun ordre n'est place aujourd'hui.${MOTIF}`,
    ]);
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — jour +4.17 % · cumul +25.00 % — etat resynchronise par un apport, aucun ordre');
  });

  /* Un ecart non explique part deja en `RECONCILIATION_DRIFT`, qui porte ce texte : le rapport ne le repete pas. */
  it('se tait sur un ecart non explique, et sur un jour sans resynchronisation', () => {
    for (const resync of [{ ...EXPLIQUE, explainedByFlows: false }, { status: 'NOT_NEEDED' }] as const) {
      const mail = renderDailyReport(avecRun({ resync }));
      expect(encadre(mail.html)).toEqual([]);
      expect(mail.subject).toContain('aucun declenchement');
      expect(lignes(mail.html).some((ligne) => ligne.startsWith('etat interne resynchronise |'))).toBe(false);
    }
  });

  it('la suspension garde la tete de l’objet', () => {
    const mail = renderDailyReport(
      avecRun({ resync: EXPLIQUE, suspension: { status: 'ACTIVE', drawdown: dec('-0.2612'), reason: 'SUSPENSION_DRAWDOWN' } }),
    );
    expect(mail.subject).toContain('SUSPENDU');
    expect(encadre(mail.html)).toHaveLength(1);
  });

  it('glose le terme au lexique ce jour-la, et il est imprime dans le corps', () => {
    const rendu = lignes(renderDailyReport(avecRun({ resync: EXPLIQUE })).html);
    const glose = rendu.filter((ligne) => ligne.startsWith('etat interne resynchronise |'));
    expect(glose).toHaveLength(1);
    expect(rendu.some((ligne) => ligne.toLowerCase().startsWith('etat interne resynchronise, ecart'))).toBe(true);
  });
});

// --- Le P&L est un TWR ------------------------------------------------------

describe('§9 et C27 — le P&L se lit sur l’indice de croissance, jamais sur la valeur', () => {
  it('lit le cumul comme indice - 1 et le jour comme quotient de deux indices', () => {
    /*
     * 1.25 / 1.20 - 1 = 4.1666… %. La valeur totale est la meme dans les deux
     * sondes, et le P&L change : c'est l'indice qui parle, pas la valeur.
     */
    expect(lignes(renderDailyReport(INPUT).html)).toContain('100000.00 USDC | +4.17 % | +25.00 %');

    const autreIndice: DailyReportInput = {
      ...INPUT,
      run: { ...RUN, benchmarks: { ...BENCHMARKS, [PORTFOLIO_KEYS.index]: dec('1.10') } },
    };
    expect(lignes(renderDailyReport(autreIndice).html)).toContain(
      '100000.00 USDC | -8.33 % | +10.00 %',
    );
  });

  it('declare le P&L du jour indisponible sans photo de reference, et ne se replie pas sur la valeur', () => {
    const sansVeille = renderDailyReport({ run: RUN, params: DEFAULT_REBALANCE_PARAMS, movements: SANS_MOUVEMENT });
    expect(lignes(sansVeille.html)).toContain('100000.00 USDC | indisponible | +25.00 %');
    expect(sansVeille.html).toContain('une variation de valeur brute n&#39;en serait pas un (C27)');
  });

  it('refuse la photo du jour meme comme reference : le quotient vaudrait 1', () => {
    const memeJour = renderDailyReport({ ...INPUT, previous: { runDate: '2026-09-13', benchmarks: BENCHMARKS } });
    expect(lignes(memeJour.html)).toContain('100000.00 USDC | indisponible | +25.00 %');
    expect(memeJour.html).toContain('se lirait comme une journee plate');
  });
});

// --- L'objet porte les deux TWR du corps ------------------------------------

/**
 * L'objet resume la case d'en-tete pour l'ecran verrouille : « jour X · cumul Y »
 * apres la valeur. Les sondes litterales tiennent le signe et l'ordre ; la
 * derniere confronte l'objet au corps sur une grille d'indices, de sorte qu'un
 * objet qui calculerait son propre P&L — ou arrondirait autrement — rougisse.
 */
describe('objet — les TWR du jour et cumule, ceux du corps et pas d’autres', () => {
  /** Le segment TWR de l'objet : entre la valeur et la mention finale. */
  const twrDe = (subject: string): string => subject.split(' — ')[2] ?? '';
  const avecIndices = (aujourdhui: string | undefined, veille: string | undefined): DailyReportInput => ({
    params: DEFAULT_REBALANCE_PARAMS,
    series: SERIE,
    movements: MOUVEMENTS,
    run: {
      ...RUN,
      benchmarks:
        aujourdhui === undefined
          ? Object.fromEntries(Object.entries(BENCHMARKS).filter(([cle]) => cle !== PORTFOLIO_KEYS.index))
          : { ...BENCHMARKS, [PORTFOLIO_KEYS.index]: dec(aujourdhui) },
    },
    ...(veille === undefined ? {} : { previous: { runDate: '2026-09-12', benchmarks: { [PORTFOLIO_KEYS.index]: dec(veille) } } }),
  });

  it.each([
    ['positifs', '1.25', '1.20', 'jour +4.17 % · cumul +25.00 %'],
    ['negatif le jour, positif en cumul', '1.10', '1.20', 'jour -8.33 % · cumul +10.00 %'],
    ['negatifs tous deux', '0.90', '0.95', 'jour -5.26 % · cumul -10.00 %'],
    ['nuls', '1', '1', 'jour +0.00 % · cumul +0.00 %'],
  ])('jour et cumul %s', (_cas, aujourdhui, veille, attendu) => {
    expect(renderDailyReport(avecIndices(aujourdhui, veille)).subject).toBe(
      `Ubac 2026-09-13 — 100000.00 USDC — ${attendu} — aucun declenchement`,
    );
  });

  it('dit « jour n/d » sans photo de la veille, jamais la variation de valeur (C27)', () => {
    expect(renderDailyReport(avecIndices('1.25', undefined)).subject).toBe(
      'Ubac 2026-09-13 — 100000.00 USDC — jour n/d · cumul +25.00 % — aucun declenchement',
    );
    /* Une photo du jour meme n'est pas une reference : le corps dit « indisponible », l'objet aussi. */
    const memeJour = renderDailyReport({ ...INPUT, previous: { runDate: '2026-09-13', benchmarks: BENCHMARKS } });
    expect(twrDe(memeJour.subject)).toBe('jour n/d · cumul +25.00 %');
  });

  it('dit « n/d » aux deux quand l’indice du jour manque ou n’est pas fini', () => {
    expect(twrDe(renderDailyReport(avecIndices(undefined, '1.20')).subject)).toBe('jour n/d · cumul n/d');
    expect(twrDe(renderDailyReport(avecIndices('NaN', '1.20')).subject)).toBe('jour n/d · cumul n/d');
  });

  it('garde le segment un jour de suspension, la mention SUSPENDU en fin', () => {
    const mail = renderDailyReport(
      avecRun({ suspension: { status: 'ACTIVE', drawdown: dec('-0.2612'), reason: 'SUSPENSION_DRAWDOWN' } }),
    );
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — jour +4.17 % · cumul +25.00 % — SUSPENDU (recul -26.12 %)');
  });

  it('garde le segment un jour de resynchronisation, la mention en fin', () => {
    const mail = renderDailyReport(
      avecRun({ resync: { status: 'RESYNCHRONIZED', explainedByFlows: true, reason: 'ETAT_RESYNCHRONISE' } }),
    );
    expect(mail.subject).toBe(
      'Ubac 2026-09-13 — 100000.00 USDC — jour +4.17 % · cumul +25.00 % — etat resynchronise par un apport, aucun ordre',
    );
  });

  it('rend exactement les chiffres de la case d’en-tete, absence comprise', () => {
    const indices = [undefined, '0.5', '0.95', '1', '1.0000499', '1.004999', '1.2', '1.25', '3.33333'];
    for (const aujourdhui of indices) {
      for (const veille of indices) {
        const mail = renderDailyReport(avecIndices(aujourdhui, veille));
        const caseEntete = lignes(mail.html).find((ligne) => ligne.startsWith('100000.00 USDC | '));
        const [, jour, cumul] = (caseEntete ?? '').split(' | ').map((cellule) => (cellule === 'indisponible' ? 'n/d' : cellule));
        expect(twrDe(mail.subject)).toBe(`jour ${jour ?? '?'} · cumul ${cumul ?? '?'}`);
      }
    }
  });
});

// --- Les metriques sont consommees, jamais recalculees ----------------------

describe('§9 — les metriques viennent de la photo, avec leur motif quand elles manquent', () => {
  it('dit « indisponible » et rend le motif plutot qu’un zero', () => {
    const troue = avecRun({
      benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.25') },
      benchmarkGaps: [
        { key: 'hold_btc_*', code: 'EMPTY_SERIES', reason: 'aucun jour de marche fourni' },
        { key: HOLD_5050_KEYS.sharpe, code: 'WINDOW_INCOMPLETE', reason: 'fenetre de 90 rendements non pleine' },
      ],
      drawdown: { status: 'UNAVAILABLE', code: 'NO_PREVIOUS_SNAPSHOT', reason: 'aucune photo anterieure' },
    });
    const rendu = lignes(renderDailyReport(troue).html);
    expect(rendu).toContain('Hold BTC | indisponible | indisponible | indisponible');
    expect(rendu).toContain('Hold 50/50 | indisponible | indisponible | indisponible');
    /* Le motif groupe sous `hold_btc_*` remonte sur les trois metriques du hold. */
    expect(rendu).toContain('hold_btc_* | EMPTY_SERIES | aucun jour de marche fourni');
    expect(rendu).toContain('hold_5050_sharpe_90d | WINDOW_INCOMPLETE | fenetre de 90 rendements non pleine');
    expect(rendu.join('\n')).toContain('Recul actuel depuis le plus haut : indisponible');
    expect(rendu.join('\n')).not.toMatch(/Hold BTC \| [+-]?0\.00 %/);
  });

  it('traite une valeur non finie comme une absence, pas comme un nombre', () => {
    const nan = avecRun({ benchmarks: { ...BENCHMARKS, [HOLD_BTC_KEYS.twr]: dec('NaN') } });
    const rendu = lignes(renderDailyReport(nan).html);
    expect(rendu).toContain('Hold BTC | indisponible | -27.18 % | 1.41');
    expect(renderDailyReport(nan).html).not.toContain('NaN %');
  });

  it('lit les cles que la photo ecrit — les deux tables sont les memes', () => {
    expect(REPORT_BTC_KEYS).toEqual(HOLD_BTC_KEYS);
    expect(REPORT_5050_KEYS).toEqual(HOLD_5050_KEYS);
    expect(REPORT_PORTFOLIO_KEYS).toEqual(PORTFOLIO_KEYS);
    /* Non vide : sans cette sonde, deux tables vides « s'accorderaient » aussi. */
    expect(Object.values(REPORT_BTC_KEYS)).toContain('hold_btc_twr');
  });
});

// --- Les quatre comparaisons du §9, dont deux sans courbe -------------------

/**
 * Le §9 demande quatre comparaisons — hold BTC, hold 50/50, ladder et DCA. Deux
 * n'ont pas de courbe en phase 1 : `snapshot.ts` ne les ecrit pas, aucune
 * strategie ne placant d'ordre, et trois portefeuilles simules identiques au
 * reel feraient lire une comparaison la ou il n'y en a aucune. L'ecart est
 * assume, et porte par `docs/rapport-quotidien.md` §6 ; ces deux sondes le
 * tiennent : la raison est **dans le tableau**, et rien n'y fabrique de chiffre.
 */
describe('§9 — ladder et DCA : l’absence de courbe se dit la ou on la cherche', () => {
  const ombreLignes = (rendu: readonly string[]): readonly string[] =>
    rendu.filter((ligne) => /^(Ladder|DCA) \(ombre\) \|/.test(ligne));

  it('porte la raison dans le tableau, entre les hold et les notes', () => {
    const mail = renderDailyReport(INPUT);
    const rendu = lignes(mail.html);
    const titre = rendu.indexOf('Comparaison');
    const ladder = rendu.findIndex((ligne) => ligne.startsWith('Ladder (ombre) |'));
    const dca = rendu.findIndex((ligne) => ligne.startsWith('DCA (ombre) |'));
    const note = rendu.findIndex((ligne) => ligne.startsWith('Portefeuille : TWR depuis'));

    /* Dans le tableau, pas apres : un operateur qui cherche ces deux lignes tombe sur la raison. */
    expect(titre).toBeGreaterThan(-1);
    expect(ladder).toBeGreaterThan(titre);
    expect(dca).toBeGreaterThan(ladder);
    expect(note).toBeGreaterThan(dca);

    for (const ligne of ombreLignes(rendu)) {
      expect(ligne).toContain("aucune strategie n'execute");
      expect(ligne).toContain('serait le portefeuille reel');
    }
    /* La raison couvre les trois colonnes de metriques : sans cela, deux cellules vides se liraient comme un rendu casse. */
    expect(mail.html).toContain('colspan="3"');
  });

  it('ne fabrique aucune courbe : la photo n’en porte pas la cle, et en poser une ne change rien', () => {
    /* L'etat fige est bien celui que la photo ecrit : aucune cle d'ombre. */
    expect(Object.keys(BENCHMARKS).filter((cle) => /ladder|dca/.test(cle))).toEqual([]);

    const attendu = renderDailyReport(INPUT).html;
    const ombres = ombreLignes(lignes(attendu));
    expect(ombres).toHaveLength(2);
    for (const ligne of ombres) {
      /* Ni chiffre, ni pourcentage : une valeur sur ces lignes serait inventee. */
      expect(ligne).not.toMatch(/[+-]?\d+[.,]\d+/);
      expect(ligne).not.toContain('%');
      /* Ni « indisponible » : ce n'est pas un trou de la photo, c'est une absence assumee. */
      expect(ligne).not.toContain('indisponible');
    }

    /*
     * Le rendu ne lit aucune cle d'ombre : en planter dans la photo ne fait
     * apparaitre aucune courbe. Le jour ou le rejeu les produira, il faudra
     * toucher ce fichier — et cette sonde est ce qui le dira.
     */
    const plante = avecRun({
      benchmarks: {
        ...BENCHMARKS,
        ladder_twr: dec('0.99'),
        ladder_max_drawdown: dec('-0.5'),
        dca_twr: dec('0.42'),
      },
    });
    expect(renderDailyReport(plante).html).toBe(attendu);
  });
});

// --- La distance au prochain declenchement ----------------------------------

/** La seule valeur que le noyau ne produit pas. Bande par defaut : `[0.24, 0.36]` autour d'une cible USDC a 0.30. */
describe('§9 — la distance au prochain declenchement, aux deux bornes', () => {
  const BANDE = cashBand(DEFAULT_REBALANCE_PARAMS);
  const distance = (cash: string) => bandDistance(dec(cash), BANDE.lower, BANDE.upper);

  it('la bande par defaut est bien [0.24, 0.36]', () => {
    expect(BANDE.lower.toFixed(2)).toBe('0.24');
    expect(BANDE.upper.toFixed(2)).toBe('0.36');
  });

  it('dans la bande : les deux marges, et la plus courte designee', () => {
    const bas = distance('0.26');
    expect(bas.status === 'INSIDE' && bas.toLower.toFixed(4)).toBe('0.0200');
    expect(bas.status === 'INSIDE' && bas.toUpper.toFixed(4)).toBe('0.1000');
    expect(bas.status === 'INSIDE' && bas.side).toBe('LOWER');
    expect(bas.status === 'INSIDE' && bas.onEdge).toBe(false);

    const haut = distance('0.35');
    expect(haut.status === 'INSIDE' && haut.gap.toFixed(4)).toBe('0.0100');
    expect(haut.status === 'INSIDE' && haut.side).toBe('UPPER');
  });

  it('exactement sur la borne basse : distance nulle, mais pas encore franchie', () => {
    const sur = distance('0.24');
    expect(sur.status).toBe('INSIDE');
    expect(sur.status === 'INSIDE' && sur.onEdge).toBe(true);
    expect(sur.status === 'INSIDE' && sur.gap.isZero()).toBe(true);
    expect(sur.status === 'INSIDE' && sur.side).toBe('LOWER');
  });

  it('exactement sur la borne haute : distance nulle, mais pas encore franchie', () => {
    const sur = distance('0.36');
    expect(sur.status).toBe('INSIDE');
    expect(sur.status === 'INSIDE' && sur.onEdge).toBe(true);
    expect(sur.status === 'INSIDE' && sur.side).toBe('UPPER');
  });

  it('le dernier pas avant chaque borne reste dedans, le premier apres est dehors', () => {
    expect(distance('0.2400000001').status).toBe('INSIDE');
    expect(distance('0.2399999999').status).toBe('CROSSED');
    expect(distance('0.3599999999').status).toBe('INSIDE');
    expect(distance('0.3600000001').status).toBe('CROSSED');
  });

  it('deja hors bande : aucune distance, le depassement a la place', () => {
    const dessous = distance('0.20');
    expect(dessous.status === 'CROSSED' && dessous.side).toBe('LOWER');
    expect(dessous.status === 'CROSSED' && dessous.overshoot.toFixed(4)).toBe('0.0400');

    const dessus = distance('0.42');
    expect(dessus.status === 'CROSSED' && dessus.side).toBe('UPPER');
    expect(dessus.status === 'CROSSED' && dessus.overshoot.toFixed(4)).toBe('0.0600');
  });

  it('a egalite parfaite, designe la borne basse, et toujours la meme', () => {
    const centre = distance('0.30');
    expect(centre.status === 'INSIDE' && centre.toLower.eq(centre.toUpper)).toBe(true);
    expect(centre.status === 'INSIDE' && centre.side).toBe('LOWER');
  });

  it('une valeur ou une bande non finie ne ressort pas « dans la bande »', () => {
    expect(distance('NaN').status).toBe('UNDEFINED');
    expect(bandDistance(dec('0.30'), dec('NaN'), BANDE.upper).status).toBe('UNDEFINED');
    expect(bandDistance(dec('0.30'), dec('0.36'), dec('0.24')).status).toBe('UNDEFINED');
  });

  /**
   * L'accord avec la strategie : sur le meme etat, ce que le rapport annonce et
   * ce que `decide()` fait ne peuvent pas diverger. C'est ce qui rend une
   * inversion de comparaison visible — `lte` a la place de `lt`.
   */
  it.each([
    ['0.24', 'INSIDE', 'NONE'],
    ['0.2399', 'CROSSED', 'CASH_BAND'],
    ['0.36', 'INSIDE', 'NONE'],
    ['0.3601', 'CROSSED', 'CASH_BAND'],
    ['0.31', 'INSIDE', 'NONE'],
  ] as const)('cash %s : le rapport dit %s, decide() dit %s', (cash, attendu, trigger) => {
    const total = dec('100000');
    const usdc = total.mul(dec(cash));
    const risque = total.minus(usdc);
    const holdings: Holdings = {
      BTC: risque.div(2).div(PRICES.BTC) as Quantity,
      ETH: risque.div(2).div(PRICES.ETH) as Quantity,
      USDC: usdc as Quantity,
    };
    const decision = decide(
      { holdings, prices: PRICES, lastRatioRebalanceOn: null },
      { today: () => '2026-09-13' },
      DEFAULT_REBALANCE_PARAMS,
    );
    expect(decision.status === 'DECIDED' && decision.intent.trigger).toBe(trigger);
    expect(distance(cash).status).toBe(attendu);
  });

  it('rend la bande de ratio quand le declencheur B est arme, et seulement alors', () => {
    const armed: RebalanceParams = { ...DEFAULT_REBALANCE_PARAMS, ratioBandEnabled: true };
    const rendu = lignes(renderDailyReport({ ...INPUT, params: armed }).html);
    /* 0.41 / 0.28 = 1.4643, dans [0.9333, 1.7333] : 0.2690 sous la borne haute, en unites de ratio. */
    expect(rendu).toContain('Bande de ratio (B) | BTC/ETH 1.4643 | [0.9333, 1.7333] | 0.2690 de la borne haute');
    expect(lignes(renderDailyReport(INPUT).html).join('\n')).not.toContain('Bande de ratio');
  });
});

// --- Le lexique -------------------------------------------------------------

/**
 * Le rapport porte lui-meme les definitions de son vocabulaire : l'operateur le
 * lit sur son telephone, et n'a rien a ouvrir ailleurs.
 *
 * Deux garde-fous plutot qu'une relecture. **R3** refuse une entree morte — un
 * mot defini que le rapport n'imprime pas —, et c'est ce qui force le terme
 * d'une entree a etre ce que le corps affiche et non le nom savant de la chose.
 * **R5** tient l'inverse pour les entrees conditionnelles : elles suivent ce que
 * le rapport du jour imprime, sinon les neuf codes de refus seraient glosses tous
 * les jours pour des rejets qui n'arrivent pas en phase 1.
 *
 * Ce qu'aucun test ne peut dire, et qui reste un point de relecture : les
 * `reason` du noyau sont du texte libre, cites tels quels, et peuvent contenir
 * un mot que le lexique ne couvre pas.
 */
describe('R1 a R6 — le lexique vit dans le rapport, et n’y est ni mort ni muet', () => {
  /** Les deux moities du corps, separees au titre de la section. */
  function coupe(html: string): { readonly corps: string; readonly lexique: string } {
    const index = html.indexOf('>Lexique<');
    expect(index).toBeGreaterThan(-1);
    return { corps: html.slice(0, index), lexique: html.slice(index) };
  }

  const entrees = (html: string): readonly string[] =>
    lignes(coupe(html).lexique).slice(2);

  it('R1 — la section est la derniere du corps, tableau des trous compris', () => {
    for (const input of [INPUT, avecRun({ benchmarkGaps: [{ key: 'hold_btc_twr', code: 'EMPTY_SERIES', reason: 'aucun jour' }] })]) {
      const rendu = lignes(renderDailyReport(input).html);
      expect(rendu.indexOf('Lexique')).toBeGreaterThan(rendu.indexOf('Comparaison'));
      /* Rien apres : le titre de la derniere section est « Lexique », et aucun autre ne le suit. */
      const titres = rendu.filter((ligne) => /^(Distance|Decision|Allocation|Comparaison|Metriques|Lexique)/.test(ligne));
      expect(titres[titres.length - 1]).toBe('Lexique');
    }
  });

  it('R2 — chaque entree porte un terme et une phrase, aucune vide', () => {
    for (const entree of entrees(renderDailyReport(INPUT).html)) {
      const [terme = '', definition = ''] = entree.split(' | ');
      expect(terme.trim().length).toBeGreaterThan(0);
      expect(definition.trim().length).toBeGreaterThan(20);
      expect(definition.trim().endsWith('.')).toBe(true);
    }
  });

  it('R3 — aucune entree morte : chaque terme est imprime ailleurs dans le corps', () => {
    const { corps, lexique } = coupe(renderDailyReport(INPUT).html);
    const texte = lignes(corps).join('\n').toLowerCase();
    const termes = lignes(lexique)
      .slice(2)
      .map((entree) => (entree.split(' | ')[0] ?? '').toLowerCase());

    expect(termes.length).toBe(29);
    for (const terme of termes) expect(texte).toContain(terme);
  });

  it('R5 — les entrees conditionnelles suivent ce que le rapport du jour imprime', () => {
    /* Le cas nominal : quatre triggers NONE, aucun rejet. Une seule glose de trigger, aucune de refus. */
    const nominal = entrees(renderDailyReport(INPUT).html);
    expect(nominal.filter((entree) => entree.startsWith('NONE |'))).toHaveLength(1);
    expect(nominal.some((entree) => /^(CASH_BAND|RATIO_BAND|MIN_CASH|COOLDOWN) \|/.test(entree))).toBe(false);

    /* Un refus : son code est glose, et lui seul des neuf. */
    const rejete: ReportOutcome = {
      ...OUTCOMES[0]!,
      verdict: { status: 'REJECTED', rejections: [{ code: 'MIN_CASH', reason: 'cash projete trop bas' }] },
    };
    const avecRejet = entrees(renderDailyReport(avecRun({ outcomes: [rejete, ...OUTCOMES.slice(1)] })).html);
    expect(avecRejet.some((entree) => entree.startsWith('MIN_CASH |'))).toBe(true);
    expect(avecRejet.filter((entree) => /^(ASSET_NOT_ALLOWED|COOLDOWN|PRICE_SANITY) \|/.test(entree))).toHaveLength(0);

    /* Une suspension : son entree apparait, et pas avant. */
    expect(nominal.some((entree) => entree.startsWith('suspension |'))).toBe(false);
    const suspendu = entrees(
      renderDailyReport(avecRun({ suspension: { status: 'ACTIVE', drawdown: dec('-0.2612'), reason: 'SUSPENSION_DRAWDOWN : recul a -26.12 %' } })).html,
    );
    expect(suspendu.some((entree) => entree.startsWith('suspension |'))).toBe(true);

    /* Le tableau des trous : la convention de nommage des cles est glosee avec lui, jamais sans. */
    expect(nominal.some((entree) => entree.startsWith('cle |'))).toBe(false);
    const troue = entrees(
      renderDailyReport(avecRun({ benchmarkGaps: [{ key: 'hold_btc_*', code: 'EMPTY_SERIES', reason: 'aucun jour de marche fourni' }] })).html,
    );
    expect(troue.some((entree) => entree.startsWith('cle |'))).toBe(true);
  });

  /**
   * Le corps est sans accent, comme les `reason` du noyau qu'il cite telles
   * quelles. C'est la contrainte la plus facile a violer de ce lot : on ecrit
   * vingt definitions en francais d'une traite, et « pondere » passe. La sonde
   * couvre donc **tout le HTML**, pas seulement la nouvelle section.
   */
  it('R6 — aucun caractere accentue dans le rapport rendu, lexique compris', () => {
    /* NFD decompose « e » accentue en « e » suivi d'une diacritique combinante ; ae et oe lies ne se decomposent pas. */
    const accentue = /[̀-ͯ]|[æœÆŒ]/;
    for (const input of [INPUT, avecRun({ benchmarkGaps: [{ key: 'hold_btc_*', code: 'EMPTY_SERIES', reason: 'aucun jour' }], suspension: { status: 'ACTIVE', drawdown: dec('-0.30'), reason: 'SUSPENSION_DRAWDOWN' } })]) {
      const mail = renderDailyReport(input);
      expect(mail.html.normalize('NFD')).not.toMatch(accentue);
      expect(mail.subject.normalize('NFD')).not.toMatch(accentue);
    }
    /* La sonde sait voir un accent : sans ce controle, une regex fausse rendrait le test vert pour toujours. */
    expect('pondere'.replace('e', 'é').normalize('NFD')).toMatch(accentue);
  });
});

// --- Le graphe --------------------------------------------------------------

/**
 * Une courbe, pas un chiffre : « comment le portefeuille a evolue depuis le
 * debut », d'un coup d'oeil. Faite de cellules de tableau, et jamais d'une
 * image — Gmail supprime `<svg>` du corps, une image distante est bloquee par
 * defaut, et une piece jointe serait un fichier a ouvrir.
 */
describe('R7 a R16 — le graphe du TWR cumule', () => {
  const TITRE = 'Evolution du portefeuille (TWR cumule)';

  /** Le corps d'une section : de la fin de son titre au titre suivant. */
  function corps(html: string, titre: string): string {
    const apres = html.split(`${titre}</h2>`)[1];
    expect(apres).toBeDefined();
    return (apres ?? '').split('<h2')[0] ?? '';
  }

  /** Le graphe rendu : toute sa section, titre exclu. */
  const graphe = (html: string): string => corps(html, TITRE);

  const hauteurs = (html: string): readonly string[] =>
    [...graphe(html).matchAll(/height:(\d+)px;background/g)].map(([, px]) => px ?? '');

  /** La position de chaque bloc dans le HTML : la valeur totale pour l'en-tete, le titre pour les sections. */
  function positions(html: string): readonly number[] {
    const blocs = ['>Valeur totale<', '>Distance au prochain declenchement<', `>${TITRE}<`, '>Decision du jour<'];
    const rangs = blocs.map((bloc) => html.indexOf(bloc));
    for (const rang of rangs) expect(rang).toBeGreaterThan(-1);
    return rangs;
  }

  const croissantes = (rangs: readonly number[]): boolean =>
    rangs.every((rang, i) => i === 0 || (rangs[i - 1] ?? Infinity) < rang);

  it('R7 — il est le troisieme bloc : en-tete, distance, graphe, puis la decision', () => {
    const html = renderDailyReport(INPUT).html;
    expect(croissantes(positions(html))).toBe(true);
    /* Sa section porte les barres et la note, rien d'autre. */
    expect(graphe(html)).toContain('<td style="width:4px');
    expect(graphe(html)).toContain('1 colonne = 1 photo');
    expect(graphe(html)).not.toContain('Max drawdown');
    /* Et pas ailleurs : une seule table de barres dans tout le rapport. */
    expect(html.split('table-layout:fixed')).toHaveLength(2);
  });

  it('R7 — la section « Comparaison » garde son tableau, sans le graphe', () => {
    const comparaison = corps(renderDailyReport(INPUT).html, 'Comparaison');
    /* Le tableau ouvre la section, sans rien avant lui. */
    expect(comparaison.startsWith('<table style="width:100%')).toBe(true);
    expect(comparaison).toContain('Max drawdown');
    expect(comparaison).not.toContain('table-layout:fixed');
    expect(comparaison).not.toContain('depuis la premiere photo, lu sur l');
  });

  it('R7 — graphe indisponible : la phrase occupe la meme place, sous la distance et avant la decision', () => {
    const html = renderDailyReport({ run: RUN, params: DEFAULT_REBALANCE_PARAMS, movements: SANS_MOUVEMENT }).html;
    expect(croissantes(positions(html))).toBe(true);
    expect(graphe(html)).toContain('Il apparaitra des le run suivant.');
    expect(corps(html, 'Comparaison')).not.toContain('Il apparaitra des le run suivant.');
  });

  it('R7 — alerte et resynchronisation restent au-dessus de l’en-tete, donc du graphe', () => {
    const html = renderDailyReport(
      avecRun({
        suspension: { status: 'ACTIVE', drawdown: dec('-0.2612'), reason: 'SUSPENSION_DRAWDOWN' },
        resync: { status: 'RESYNCHRONIZED', explainedByFlows: true, reason: 'ETAT_RESYNCHRONISE' },
      }),
    ).html;
    const entete = positions(html)[0] ?? -1;
    for (const tete of ['SUSPENSION_DRAWDOWN', 'Etat interne resynchronise']) {
      expect(html.indexOf(tete)).toBeGreaterThan(-1);
      expect(html.indexOf(tete)).toBeLessThan(entete);
    }
  });

  it('R8 — rien a charger : ni image, ni SVG, ni URL, sur le rapport entier', () => {
    const html = renderDailyReport(INPUT).html;
    for (const interdit of ['<img', '<svg', 'background-image', 'url(', 'http://', 'https://', '//']) {
      expect(html).not.toContain(interdit);
    }
  });

  it('R9 — il trace l’indice et jamais la valeur : doubler les valeurs ne change pas un octet', () => {
    const attendu = graphe(renderDailyReport(INPUT).html);
    const double = renderDailyReport({
      ...INPUT,
      run: { ...RUN, totalValue: dec('200000') as UsdcAmount },
      /* Et une valeur totale plantee dans chaque photo de la serie, qu'aucune forme ne permet de lire. */
      series: SERIE.map((photo) => ({ ...photo, benchmarks: { ...photo.benchmarks, total_value: dec('999999') } })),
    });
    expect(graphe(double.html)).toBe(attendu);
    /* La sonde n'est pas vide : la valeur a bien change ailleurs dans le rapport. */
    expect(double.html).toContain('200000.00 USDC');
  });

  it.each([1, 2, 89, 90, 91, 1_000, 5_000])(
    'R10 et R11 — %i photos : jamais plus de MAX_COLONNES, et la derniere est la plus recente',
    (n) => {
      const graph = twrGraph(serieDe(n));
      if (n < 2) {
        expect(graph.status).toBe('NONE');
        return;
      }
      expect(graph.status).toBe('DRAWN');
      if (graph.status !== 'DRAWN') return;
      expect(graph.columns.length).toBeLessThanOrEqual(MAX_COLONNES);
      expect(graph.columns.length).toBeGreaterThan(0);
      expect(graph.perColumn).toBe(Math.ceil(n / MAX_COLONNES));

      /* La derniere colonne porte la derniere photo, paquet incomplet ou non : c'est la propriete qui compte. */
      const derniere = graph.columns[graph.columns.length - 1];
      expect(derniere?.status === 'VALUE' && derniere.value.toFixed(6)).toBe(
        dec(String(n - 1)).div(10_000).toFixed(6),
      );
      /* Et l'echelle est bien celle des colonnes tracees, pas celle de toutes les photos. */
      expect(graph.high.eq(dec(String(n - 1)).div(10_000))).toBe(true);
    },
  );

  it('R12 — la note dit la periode et la resolution, et la resolution decroit avec l’age', () => {
    expect(graphe(renderDailyReport(INPUT).html)).toContain(
      '5 photo(s), du 2026-09-09 au 2026-09-13, 1 colonne = 1 photo.',
    );
    /* 200 photos : 3 photos par colonne, et la note le dit au pluriel. */
    const vieux = renderDailyReport({ ...INPUT, series: serieDe(200) });
    expect(graphe(vieux.html)).toContain('201 photo(s), du 2000-01-01 au 2026-09-13, 1 colonne = 3 photos.');
  });

  it('R13 — la note donne les deux bornes de l’echelle, et une serie plate ne divise pas par zero', () => {
    expect(graphe(renderDailyReport(INPUT).html)).toContain('Echelle de +10.00 % a +25.00 %');

    const plate = renderDailyReport({
      ...INPUT,
      run: { ...RUN, benchmarks: { ...BENCHMARKS, [PORTFOLIO_KEYS.index]: dec('1.10') } },
      series: [point('2026-09-11', '1.10'), point('2026-09-12', '1.10')],
    });
    expect(graphe(plate.html)).toContain('Echelle de +10.00 % a +10.00 %');
    expect(graphe(plate.html)).toContain('Serie plate : toutes les colonnes ont la meme hauteur.');
    expect([...new Set(hauteurs(plate.html))]).toEqual(['90']);
    expect(plate.html).not.toContain('NaN');
  });

  it('R14 — zero ou une photo : une phrase nommee, jamais un cadre vide', () => {
    /* Aucune serie lue : le rendu compose le point du jour, il reste seul. */
    const premier = renderDailyReport({ run: RUN, params: DEFAULT_REBALANCE_PARAMS, movements: SANS_MOUVEMENT });
    expect(graphe(premier.html)).toContain('1 photo(s) dans l');
    expect(graphe(premier.html)).toContain('Il apparaitra des le run suivant.');
    expect(graphe(premier.html)).not.toContain('<td');

    /* Zero photo ne peut pas sortir du rendu, qui compose toujours le point du jour ; la fonction le tient quand meme. */
    expect(twrGraph([]).status).toBe('NONE');
    /* Et une serie dont aucune photo ne porte d'indice ne fabrique pas un cadre vide non plus. */
    const muette = twrGraph([point('2026-09-11'), point('2026-09-12')]);
    expect(muette.status === 'NONE' && muette.reason).toContain("ne porte d'indice de croissance exploitable");
  });

  it('R15 — une photo sans indice laisse sa colonne vide, et la note les compte', () => {
    const troue = renderDailyReport({
      ...INPUT,
      series: [point('2026-09-10', '1.10'), point('2026-09-11'), point('2026-09-12', '1.20')],
    });
    /* Quatre colonnes, trois barres : celle du 11 est vide, ni interpolee ni mise a zero. */
    expect(graphe(troue.html).match(/<td /g)).toHaveLength(4);
    expect(hauteurs(troue.html)).toEqual(['1', '60', '90']);
    expect(graphe(troue.html)).toContain('1 colonne(s) vide(s)');
    expect(graphe(troue.html)).toContain('<td style="width:4px;padding:0 1px 0 0;vertical-align:bottom"></td>');
    /* Aucune colonne de hauteur nulle : elle serait indiscernable d'une colonne vide. */
    expect(hauteurs(troue.html)).not.toContain('0');
  });

  it('R16 — un second run du meme jour rend exactement le meme graphe', () => {
    const premier = renderDailyReport(INPUT);
    /* Au second run, la photo du jour est deja en base : la serie lue la porte. */
    const second = renderDailyReport({
      ...INPUT,
      series: [...SERIE, { runDate: RUN.runDate, benchmarks: BENCHMARKS }],
    });
    expect(graphe(second.html)).toBe(graphe(premier.html));
  });
});

/**
 * Le rapport est en dernier lieu un courrier, et Gmail coupe au-dela d'environ
 * 102 ko en affichant « Afficher le message entier ». Ce qu'il couperait, c'est
 * le lexique, qui est la derniere section. La borne de `MAX_COLONNES` est ce qui
 * empeche le graphe d'y mener ; cette sonde la mesure plutot que de faire
 * confiance au raisonnement.
 *
 * Delai cible plutot que global : rendre 5 000 photos reste rapide en `npm test`
 * mais passe par v8 sous `npm run test:coverage`, et un test bloque ailleurs dans
 * la suite doit continuer d'echouer en 5 s. Voir docs/marge-des-delais.md.
 */
describe('R17 — 5 000 photos tiennent loin sous la coupure de Gmail', { timeout: 30_000 }, () => {
  it('rend le rapport entier sous 100 000 caracteres', () => {
    const mail = renderDailyReport({ ...INPUT, series: serieDe(5_000) });
    expect(mail.html.length).toBeLessThan(100_000);
    /* Et le graphe est bien la : une sonde de taille passerait aussi sur un rapport ampute. */
    expect(mail.html).toContain('5001 photo(s)');
    expect(mail.html).toContain('Lexique');
  });
});

// --- E28 : les ordres du jour -----------------------------------------------

describe('E28 — le rapport distingue place, execute, partiel et non execute, et cite les frais reels', () => {
  const ordre = (clientOrderId: string, side: 'BUY' | 'SELL'): ReportExecution['rejets'][number]['order'] => ({
    clientOrderId,
    asset: 'BTC',
    quote: 'USDC',
    side,
    quantity: dec('0.14') as Quantity,
    limitPrice: dec('50050') as Price,
  });
  const EXECUTION: ReportExecution = {
    strategy: 'rebalance',
    ordres: [
      { order: ordre('a', 'SELL'), etat: 'EXECUTE', filled: dec('0.14'), fees: dec('4.2042') },
      { order: ordre('b', 'SELL'), etat: 'PARTIEL', filled: dec('0.05'), fees: dec('1.5') },
      { order: ordre('c', 'BUY'), etat: 'NON_EXECUTE', filled: dec('0'), fees: dec('0') },
      { order: ordre('d', 'BUY'), etat: 'NON_LU', filled: dec('0'), fees: null },
    ],
    rejets: [
      { order: ordre('e', 'BUY'), reason: 'INVALID_LIMIT_PRICE_POST_ONLY', postOnly: true },
      { order: ordre('f', 'SELL'), reason: 'INSUFFICIENT_FUND', postOnly: false },
    ],
  };
  const rendu = (): readonly string[] => lignes(renderDailyReport(avecRun({ executions: [EXECUTION] })).html);

  it('compte chaque etat a part : quatre places, un de chaque, et les deux refus separes', () => {
    const section = rendu();
    const debut = section.indexOf('Ordres du jour');
    expect(section.slice(debut, debut + 18)).toEqual([
      'Ordres du jour',
      'Ordres | Nombre',
      'Place | 4',
      'Execute | 1',
      'Partiel | 1',
      'Non execute | 1',
      'Statut non lu | 1',
      'Rejete (post-only) | 1',
      'Rejete (autre motif) | 1',
      /* 4.2042 + 1.5 + 0, et l'ordre non lu n'y entre pas : ses frais sont inconnus, pas nuls. */
      'Frais reels | 5.70 USDC',
      'Jambe | Limite | Etat | Frais ou motif',
      'SELL BTC 0.14000000 | 50050.00 USDC | Execute | 4.20 USDC',
      'SELL BTC 0.14000000 | 50050.00 USDC | Partiel (0.05000000) | 1.50 USDC',
      'BUY BTC 0.14000000 | 50050.00 USDC | Non execute | 0.00 USDC',
      'BUY BTC 0.14000000 | 50050.00 USDC | Statut non lu | inconnus',
      'BUY BTC 0.14000000 | 50050.00 USDC | Rejete (post-only) | INVALID_LIMIT_PRICE_POST_ONLY',
      'SELL BTC 0.14000000 | 50050.00 USDC | Rejete (autre motif) | INSUFFICIENT_FUND',
      "Etat lu juste apres le placement : un ordre limit au repos n'est en general pas encore execute, et la suite se lit les jours suivants. Aucune jambe refusee n'est replacee dans le run.",
    ]);
  });

  it('reste sans accent, sans ressource distante, et son lexique n’a aucune entree morte', () => {
    const html = renderDailyReport(avecRun({ executions: [EXECUTION] })).html;
    expect(html.normalize('NFD')).not.toMatch(/[̀-ͯ]|[æœÆŒ]/);
    for (const interdit of ['<img', '<svg', 'url(', 'http']) expect(html).not.toContain(interdit);
    const index = html.indexOf('>Lexique<');
    const corps = lignes(html.slice(0, index)).join('\n').toLowerCase();
    for (const entree of lignes(html.slice(index)).slice(2)) {
      expect(corps).toContain((entree.split(' | ')[0] ?? '').toLowerCase());
    }
  });
});

/**
 * Les derniers mouvements : un historique court, pas le flux du jour. La section
 * est la **tous les jours** — avec le tableau, avec la phrase qui dit qu'il n'y en
 * a pas, ou avec celle qui dit que la lecture a echoue —, parce qu'une section
 * qui disparait ne dit pas laquelle des trois est vraie.
 *
 * L'ordre et la borne de chaque source sont ceux des requetes, sondes contre
 * Postgres dans `test/adapters/db.test.ts` ; la fusion des deux, le tri par
 * instant et la coupe sont ici, fonction pure du rendu.
 */
describe('Derniers mouvements', () => {
  /** Les lignes de la section, titre compris, jusqu'au titre suivant. */
  function mouvements(input: DailyReportInput): readonly string[] {
    const rendu = lignes(renderDailyReport(input).html);
    const debut = rendu.indexOf('Derniers mouvements');
    expect(debut).toBeGreaterThan(-1);
    return rendu.slice(debut, rendu.indexOf('Lexique', debut));
  }

  const NOTE_MOUVEMENTS = 'Les 8 plus recents au plus, apports, retraits et ordres executes confondus, du plus recent au plus ancien, quelle que soit leur date. Montant vu du cash : un retrait ou un achat est negatif, un apport ou une vente positif. Un ordre compte pour sa quantite executee au prix moyen, hors frais ; en cours, il est encore au carnet et date de sa creation.';

  it('rend flux et ordres en un tableau : achat negatif, vente positive, frais en detail, ordre ouvert en cours', () => {
    const recus = lus(
      [
        flux('2026-09-27T09:00:00Z', '-300', 'retrait vers le compte courant'),
        flux('2026-09-26T08:00:00Z', '1000', 'virement du compte courant'),
        flux('2025-12-31T10:00:00Z', '5000.12345678', 'apport <initial>'),
      ],
      [
        ordre('2026-09-28T07:00:00Z', 'BUY', 'ETH', '0.5', '2400.10', null, { open: true }),
        ordre('2026-09-26T09:30:00Z', 'BUY', 'BTC', '0.01', '41230', '0.25'),
        ordre('2026-08-02T11:00:00Z', 'SELL', 'ETH', '1.23456789', '3210.5', '1.9876'),
      ],
    );
    expect(mouvements({ ...INPUT, movements: recus })).toEqual([
      'Derniers mouvements',
      'Date | Mouvement | Montant | Detail',
      '2026-09-28 | Achat ETH (en cours) | -1200.05 USDC | 0.50000000 ETH a 2400.10 USDC, frais inconnus',
      '2026-09-27 | Retrait | -300.00 USDC | retrait vers le compte courant',
      '2026-09-26 | Achat BTC | -412.30 USDC | 0.01000000 BTC a 41230.00 USDC, frais 0.25 USDC',
      '2026-09-26 | Apport | 1000.00 USDC | virement du compte courant',
      '2026-08-02 | Vente ETH | 3963.58 USDC | 1.23456789 ETH a 3210.50 USDC, frais 1.99 USDC',
      '2025-12-31 | Apport | 5000.12 USDC | apport <initial>',
      NOTE_MOUVEMENTS,
    ]);
  });

  it('un flux sans note porte un tiret', () => {
    expect(mouvements({ ...INPUT, movements: lus([flux('2026-06-15T10:00:00Z', '-50.25')]) })[2]).toBe(
      '2026-06-15 | Retrait | -50.25 USDC | —',
    );
  });

  it('fusionne huit flux et huit ordres et n’en garde que les huit plus recents, quel que soit l’ordre recu', () => {
    const jours = ['01', '02', '03', '04', '05', '06', '07', '08'];
    const huitFlux = jours.map((j) => flux(`2026-09-${j}T10:00:00Z`, '100'));
    const huitOrdres = jours.map((j) => ordre(`2026-09-${j}T12:00:00Z`, 'SELL', 'BTC', '0.001', '60000', '0.1'));
    const attendu = ['08', '07', '06', '05'].flatMap((j) => [`ubac-2026-09-${j}T12:00:00Z`, `flux-2026-09-${j}T10:00:00Z`]);
    const identifiants = (cashFlows: readonly ReportCashFlow[], orders: readonly ReportExecutedOrder[]): readonly string[] =>
      journal(cashFlows, orders).map((m) => (m.kind === 'FLUX' ? m.flux.id : m.ordre.clientOrderId));

    expect(DERNIERS_MOUVEMENTS).toBe(8);
    expect(identifiants([...huitFlux].reverse(), [...huitOrdres].reverse())).toEqual(attendu);
    expect(identifiants(huitFlux, huitOrdres)).toEqual(attendu);
  });

  it('a instant egal, le flux passe avant l’ordre, puis l’identifiant decroissant, comme dans la base', () => {
    const instant = '2026-09-20T07:00:00Z';
    const cashFlows = [flux(instant, '10', null, 'a'), flux(instant, '20', null, 'b')];
    const orders = [ordre(instant, 'BUY', 'BTC', '1', '1', '0', { id: 'ubac-a' }), ordre(instant, 'BUY', 'BTC', '1', '1', '0', { id: 'ubac-b' })];
    const identifiants = (f: readonly ReportCashFlow[], o: readonly ReportExecutedOrder[]): readonly string[] =>
      journal(f, o).map((m) => (m.kind === 'FLUX' ? m.flux.id : m.ordre.clientOrderId));

    expect(identifiants(cashFlows, orders)).toEqual(['b', 'a', 'ubac-b', 'ubac-a']);
    expect(identifiants([...cashFlows].reverse(), [...orders].reverse())).toEqual(['b', 'a', 'ubac-b', 'ubac-a']);
  });

  it('des ordres seuls font un journal', () => {
    expect(mouvements({ ...INPUT, movements: lus([], [ordre('2026-09-12T07:05:00Z', 'SELL', 'BTC', '0.1', '60000.005', '1')]) }).slice(1, 3)).toEqual([
      'Date | Mouvement | Montant | Detail',
      '2026-09-12 | Vente BTC | 6000.00 USDC | 0.10000000 BTC a 60000.01 USDC, frais 1.00 USDC',
    ]);
  });

  it('sans mouvement enregistre, une ligne le dit et la section reste', () => {
    expect(mouvements({ ...INPUT, movements: SANS_MOUVEMENT })).toEqual([
      'Derniers mouvements',
      'Aucun mouvement enregistre.',
    ]);
  });

  it('une lecture en echec se dit a la place de la liste, motif echappe', () => {
    const html = renderDailyReport({
      ...INPUT,
      movements: { status: 'UNREADABLE', reason: 'connexion <refusee>' },
    }).html;
    expect(html).toContain('connexion &lt;refusee&gt;');
    expect(mouvements({ ...INPUT, movements: { status: 'UNREADABLE', reason: 'connexion refusee' } })).toEqual([
      'Derniers mouvements',
      "Les derniers mouvements n'ont pas pu etre lus : connexion refusee. Le reste du rapport n'en depend pas.",
    ]);
  });

  it('se place avant le lexique, sans accent, et nomme le terme que le lexique glose', () => {
    for (const movements of [MOUVEMENTS, SANS_MOUVEMENT, { status: 'UNREADABLE', reason: 'panne' } as const]) {
      const html = renderDailyReport({ ...INPUT, movements }).html;
      const rendu = lignes(html);
      expect(rendu.indexOf('Derniers mouvements')).toBeGreaterThan(rendu.indexOf('Comparaison'));
      expect(rendu.indexOf('Derniers mouvements')).toBeLessThan(rendu.indexOf('Lexique'));
      expect(html.normalize('NFD')).not.toMatch(/[̀-ͯ]|[æœÆŒ]/);
      expect(rendu.some((ligne) => ligne.startsWith('mouvement | '))).toBe(true);
    }
  });
});
