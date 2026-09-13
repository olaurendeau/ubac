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
import type { CompletedRun, DailyReportInput, ReportOutcome } from '../../src/report/daily-report.js';
import {
  REPORT_TAG,
  bandDistance,
  renderDailyReport,
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
  outcomes: OUTCOMES,
};

/** La photo de la veille : c'est elle qui rend le P&L du jour calculable. */
const VEILLE = { runDate: '2026-09-12', benchmarks: { [PORTFOLIO_KEYS.index]: dec('1.20') } };

const INPUT: DailyReportInput = {
  run: RUN,
  params: DEFAULT_REBALANCE_PARAMS,
  previous: VEILLE,
};

const avecRun = (patch: Partial<CompletedRun>): DailyReportInput => ({
  ...INPUT,
  run: { ...RUN, ...patch },
});

/**
 * Le texte du rapport, cellule par cellule. Les separateurs sont poses avant que
 * les balises ne tombent : sans eux, deux cellules voisines se recolleraient et
 * une valeur disparaitrait dans la suivante sans qu'aucune assertion ne bronche.
 */
function lignes(html: string): readonly string[] {
  return html
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<\/(tr|p|h1|h2|div|table)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((ligne) => ligne.replace(/\s+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter((ligne) => ligne.length > 0);
}

// --- Le rapport entier, sur l'etat fige -------------------------------------

describe('rendu — la sortie attendue, ligne a ligne', () => {
  it('rend exactement le rapport de l’etat fige', () => {
    expect(lignes(renderDailyReport(INPUT).html)).toEqual([
      'Ubac — rapport du 2026-09-13',
      "Prix de cloture du 2026-09-12. Phase 1 : observation, aucun ordre n'est place.",
      'Valeur totale | P&L jour (TWR) | P&L cumule (TWR)',
      '100000.00 USDC | +4.17 % | +25.00 %',
      'Distance au prochain declenchement',
      'Bande | Constate | Bornes | Distance',
      'Bande de cash (A) | USDC 31.00 % | [24.00 %, 36.00 %] | 5.00 pt de la borne haute',
      "Declencheur B desarme : le ratio BTC/ETH n'est pas surveille en production (§5.2).",
      'Decision du jour',
      'Strategie | Trigger | Jambes | Risque | Motif',
      'rebalance | NONE | 0 jambe(s) | ACCEPTED | poids USDC dans la bande : aucun reequilibrage',
      'rebalance_ab (ombre) | NONE | 0 jambe(s) | ACCEPTED | ratio dans la bande : aucun reequilibrage',
      'ladder (ombre) | NONE | 0 jambe(s) | ACCEPTED | ancres posees au cours du jour',
      'dca (ombre) | NONE | 0 jambe(s) | ACCEPTED | hors jour de DCA',
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
      "Portefeuille : TWR depuis la premiere photo. Hold : fenetre OHLCV de 3 jour(s), du 2026-09-10 au 2026-09-12. Les deux periodes ne coincident pas tant que le systeme n'a pas tourne aussi longtemps que la fenetre.",
      "Recul actuel depuis le plus haut : -3.85 %. Ce n'est pas un max drawdown : la photo porte l'indice et son sommet, pas la serie — ni le pire recul passe ni le Sharpe du portefeuille ne s'en lisent.",
      "Ladder et DCA : aucune courbe en phase 1, aucun ordre n'etant place. Leur decision du jour figure ci-dessus.",
    ]);
  });

  it('porte le tag du §9, un objet lisible et rien d’externe', () => {
    const mail = renderDailyReport(INPUT);
    expect(mail.tags).toEqual([REPORT_TAG]);
    expect(REPORT_TAG).toBe('daily-report');
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — aucun declenchement');
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
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — CASH_BAND, 1 jambe(s)');
    expect(lignes(mail.html)).toContain(
      'rebalance | CASH_BAND | 1 jambe(s) | ACCEPTED | poids USDC sous la borne basse : retour a la cible',
    );
  });

  it('met la suspension du §6 devant le trigger, et la rend en clair', () => {
    const mail = renderDailyReport(
      avecRun({ suspension: { status: 'ACTIVE', drawdown: dec('-0.2612'), reason: 'SUSPENSION_DRAWDOWN : recul a -26.12 %' } }),
    );
    expect(mail.subject).toBe('Ubac 2026-09-13 — 100000.00 USDC — SUSPENDU (recul -26.12 %)');
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
    const sansVeille = renderDailyReport({ run: RUN, params: DEFAULT_REBALANCE_PARAMS });
    expect(lignes(sansVeille.html)).toContain('100000.00 USDC | indisponible | +25.00 %');
    expect(sansVeille.html).toContain('une variation de valeur brute n&#39;en serait pas un (C27)');
  });

  it('refuse la photo du jour meme comme reference : le quotient vaudrait 1', () => {
    const memeJour = renderDailyReport({ ...INPUT, previous: { runDate: '2026-09-13', benchmarks: BENCHMARKS } });
    expect(lignes(memeJour.html)).toContain('100000.00 USDC | indisponible | +25.00 %');
    expect(memeJour.html).toContain('se lirait comme une journee plate');
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
