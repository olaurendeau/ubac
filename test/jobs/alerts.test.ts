import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Alert, AlertEvent } from '../../src/adapters/notifier.js';
import { ALERT_EVENTS } from '../../src/adapters/notifier.js';
import type { Return } from '../../src/core/benchmark.js';
import type {
  Quantity,
  Rejection,
  RejectionCode,
  StrategyName,
  UsdcAmount,
  Verdict,
} from '../../src/core/types.js';
import type { AlertInput, RunEnding } from '../../src/jobs/alerts.js';
import { ALERT_ORDER, alertsFor } from '../../src/jobs/alerts.js';
import type { BalanceDivergence, Resynchronization } from '../../src/jobs/reconcile.js';
import { RESYNC_MARKER } from '../../src/jobs/reconcile.js';
import type { Suspension } from '../../src/jobs/snapshot.js';

/**
 * Le catalogue d'alertes. Module pur : ces sondes n'ouvrent rien, ne stubent
 * rien et ne connaissent pas ntfy.
 *
 * Ce que ce fichier etablit, affirmation par affirmation :
 *
 * - le catalogue et le tableau d'`adapters/notifier.ts` disent la meme chose,
 *   sans que `src/jobs/` importe le second en valeur (A20) ;
 * - chacun des sept evenements est **atteignable**, un par un ;
 * - tout abandon part en `RUN_ABORTED`, jamais zero, jamais deux ;
 * - une resynchronisation de l'etat interne part en `RECONCILIATION_DRIFT`, et
 *   peut accompagner un abandon du meme jour ;
 * - les codes de rejet se partagent de meme, et **les neuf** sont couverts ;
 * - `ignored` n'alerte pas ;
 * - un run sain est silencieux.
 */

const RUN_DATE = '2026-09-12';

const usdc = (value: string): UsdcAmount => new Decimal(value) as UsdcAmount;

const SAIN: AlertInput = {
  runDate: RUN_DATE,
  ending: { status: 'COMPLETED' },
  suspension: { status: 'INACTIVE' },
  resync: { status: 'NOT_NEEDED' },
  outcomes: [],
  executed: [],
};

const entree = (overrides: Partial<AlertInput> = {}): AlertInput => ({ ...SAIN, ...overrides });

const rejet = (code: RejectionCode, legIndex?: number): Rejection => ({
  code,
  reason: `motif ${code}`,
  ...(legIndex === undefined ? {} : { legIndex }),
});

const rejete = (rejections: readonly Rejection[]): Verdict => ({ status: 'REJECTED', rejections });

function verdicts(
  verdict: Verdict,
  strategy: StrategyName = 'rebalance',
  isShadow = false,
): AlertInput {
  return entree({ outcomes: [{ strategy, isShadow, verdict }] });
}

const SUSPENDU: Extract<Suspension, { status: 'ACTIVE' }> = {
  status: 'ACTIVE',
  drawdown: new Decimal('-0.27') as Return,
  reason: 'SUSPENSION_DRAWDOWN : drawdown a -27.00 % depuis le plus haut',
};

/**
 * Un etat resynchronise, tel que `reconcile.ts` le rend. Le motif porte le
 * marqueur : c'est le meme texte qui va dans `decisions.reason`, et l'alerte ne
 * le reecrit pas.
 */
const ecart = (asset: string): BalanceDivergence => ({
  asset,
  onExchange: new Decimal('0.0284') as Quantity,
  internal: new Decimal('0.0159') as Quantity,
  drift: new Decimal('0.44'),
});

const RESYNCHRONISE: Extract<Resynchronization, { status: 'RESYNCHRONIZED' }> = {
  status: 'RESYNCHRONIZED',
  divergences: [ecart('BTC')],
  reason: `${RESYNC_MARKER} : divergence superieure a 1 % entre les soldes reels et l'etat interne`,
};

const abandon = (step: 'VALUATION' | 'DECIDE'): RunEnding => ({
  status: 'ABORTED',
  step,
  code: `CODE_${step}`,
  reason: `motif ${step}`,
});

const evenements = (alerts: readonly Alert[]): AlertEvent[] => alerts.map((a) => a.event);

/**
 * Une entree qui atteint chaque evenement, une par une. C'est la table qui rend
 * l'affirmation « les sept evenements existent » verifiable : un evenement
 * ajoute au catalogue sans entree ici fait echouer la sonde de couverture.
 */
const ATTEINT: Readonly<Record<AlertEvent, AlertInput>> = {
  REBALANCE_EXECUTED: entree({
    executed: [{ strategy: 'rebalance', orders: 2, notional: usdc('12345.678') }],
  }),
  DRAWDOWN: entree({ suspension: SUSPENDU }),
  REBALANCE_TOO_LARGE: verdicts(rejete([rejet('REBALANCE_TOO_LARGE')])),
  RECONCILIATION_DRIFT: entree({ resync: RESYNCHRONISE }),
  RISK_REJECTED: verdicts(rejete([rejet('MIN_CASH')])),
  RUN_ABORTED: entree({ ending: abandon('VALUATION') }),
  JOB_FAILED: entree({ ending: { status: 'FAILED', reason: 'boum' } }),
};

// --- Le catalogue -----------------------------------------------------------

describe('le catalogue', () => {
  /*
   * `src/jobs/` ne connait des adapters que leurs types (A20), donc l'ordre est
   * relu d'une table locale et non du tableau `ALERT_EVENTS`. Les deux listes
   * doivent alors dire exactement la meme chose, et c'est cette sonde — pas un
   * import — qui le tient. Sans elle, les deux pourraient diverger en silence,
   * et un evenement absent de l'ordre finirait en tete par un rang de -1.
   */
  it('declare les memes sept evenements que notifier.ts, dans le meme ordre', () => {
    expect(ALERT_ORDER).toEqual([...ALERT_EVENTS]);
  });

  it.each(ALERT_EVENTS)('l’evenement %s est atteignable', (event) => {
    expect(evenements(alertsFor(ATTEINT[event]))).toContain(event);
  });

  /*
   * Les priorites annoncees, une sonde par evenement. `URGENT` est reserve a ce
   * qui ne peut pas attendre le lendemain matin — le capital bouge mal, ou le
   * systeme ne fait pas son travail.
   */
  it.each([
    ['REBALANCE_EXECUTED', 'HIGH'],
    ['DRAWDOWN', 'URGENT'],
    ['REBALANCE_TOO_LARGE', 'URGENT'],
    ['RECONCILIATION_DRIFT', 'URGENT'],
    ['RISK_REJECTED', 'HIGH'],
    ['RUN_ABORTED', 'URGENT'],
    ['JOB_FAILED', 'URGENT'],
  ] as const)('%s part en priorite %s', (event, priority) => {
    const alerte = alertsFor(ATTEINT[event]).find((a) => a.event === event);
    expect(alerte?.priority).toBe(priority);
  });

  it('nomme la date de run dans chaque titre', () => {
    for (const event of ALERT_EVENTS) {
      for (const alerte of alertsFor(ATTEINT[event])) {
        expect(alerte.title, event).toContain(RUN_DATE);
      }
    }
  });
});

// --- Le silence -------------------------------------------------------------

describe('le silence est le cas nominal', () => {
  it('n’alerte de rien quand un run conclut sans incident', () => {
    expect(alertsFor(SAIN)).toEqual([]);
  });

  it('n’alerte pas sur un verdict accepte, meme avec des jambes ignorees', () => {
    const accepte: Verdict = {
      status: 'ACCEPTED',
      orders: [],
      ignored: [rejet('LEG_TOO_SMALL', 0), rejet('LEG_TOO_SMALL', 1)],
    };
    expect(alertsFor(verdicts(accepte))).toEqual([]);
  });

  it('n’alerte pas au drawdown tant que la suspension est inactive', () => {
    expect(alertsFor(entree({ suspension: { status: 'INACTIVE' } }))).toEqual([]);
  });

  it('n’alerte pas d’un reequilibrage execute quand la liste est vide', () => {
    expect(evenements(alertsFor(entree({ executed: [] })))).not.toContain('REBALANCE_EXECUTED');
  });
});

// --- Le partage des abandons ------------------------------------------------

describe('tout abandon alerte, et une seule fois', () => {
  /*
   * Les deux etapes ou `daily.ts` peut encore abandonner, une sonde chacune.
   * `VALUATION` est celle qui motive Q6a2 : un portefeuille non valorisable
   * abandonne la, le §9 ne la nomme pas, et le run n'ecrit rien — donc sans cette
   * alerte il est indistinguable d'un job qui n'a pas tourne. `RECONCILE` a
   * disparu de la liste : la reconciliation n'abandonne plus.
   */
  it.each([
    ['VALUATION', 'RUN_ABORTED'],
    ['DECIDE', 'RUN_ABORTED'],
  ] as const)('un abandon a l’etape %s part en %s, seul', (step, event) => {
    const alerts = alertsFor(entree({ ending: abandon(step) }));
    expect(evenements(alerts)).toEqual([event]);
    expect(alerts[0]?.body).toContain(`CODE_${step}`);
    expect(alerts[0]?.body).toContain(`motif ${step}`);
  });

  /*
   * Un abandon posterieur a l'etape 4bis connait la suspension : le drawdown
   * doit alerter meme si le run s'arrete la. Deux alertes, chacune sur son fait.
   */
  it('joint l’alerte de drawdown a l’abandon quand la suspension est connue', () => {
    const alerts = alertsFor(entree({ ending: abandon('DECIDE'), suspension: SUSPENDU }));
    expect(evenements(alerts)).toEqual(['DRAWDOWN', 'RUN_ABORTED']);
  });
});

// --- La resynchronisation de l'etat interne ---------------------------------

describe('une resynchronisation ne passe jamais en silence', () => {
  /*
   * **La moitie qui compte du lot Q10.** Rafraichir le cache sans le dire serait
   * pire que l'impasse qu'on remplace : le run conclurait normalement, la base
   * porterait de nouveaux soldes, et personne ne saurait que le portefeuille a
   * bouge hors du systeme. L'alerte est ce qui rend le rafraichissement
   * acceptable.
   */
  it('pousse RECONCILIATION_DRIFT, en URGENT, et rien d’autre', () => {
    const alerts = alertsFor(entree({ resync: RESYNCHRONISE }));
    expect(evenements(alerts)).toEqual(['RECONCILIATION_DRIFT']);
    expect(alerts[0]?.priority).toBe('URGENT');
  });

  /*
   * Le corps est **le texte de `reconcile.ts`**, pas une seconde redaction : le
   * meme va dans `decisions.reason`, donc l'ecran verrouille et la base ne
   * peuvent pas annoncer deux ecarts differents. Meme regle que le drawdown,
   * dont le texte vient de `snapshot.ts`.
   */
  it('reprend le motif marque tel quel, sans le reecrire', () => {
    const alerts = alertsFor(entree({ resync: RESYNCHRONISE }));
    expect(alerts[0]?.body).toBe(RESYNCHRONISE.reason);
    expect(alerts[0]?.body.startsWith(RESYNC_MARKER)).toBe(true);
  });

  /*
   * Le titre ne dit plus « divergence de reconciliation » : c'est ce qu'on lit
   * d'abord sur un ecran verrouille, et l'ancien libelle laissait croire a un run
   * arrete. Ce qui a change, c'est l'etat interne.
   */
  it('dit dans son titre que c’est l’etat interne qui s’est rendu', () => {
    const alerts = alertsFor(entree({ resync: RESYNCHRONISE }));
    expect(alerts[0]?.title).toContain('resynchronise');
    expect(alerts[0]?.title).toContain(RUN_DATE);
  });

  it('ne pousse rien quand les deux etats sont d’accord', () => {
    expect(evenements(alertsFor(entree({ resync: { status: 'NOT_NEEDED' } })))).toEqual([]);
  });

  /*
   * Les deux evenements s'excluaient tant que la divergence abandonnait le run.
   * Ils cohabitent desormais, et c'est exactement le jour ou il faut les deux :
   * l'etat a bouge hors du systeme **et** le run ne s'est pas conclu.
   */
  it('accompagne un abandon du meme jour au lieu de le remplacer', () => {
    const alerts = alertsFor(entree({ resync: RESYNCHRONISE, ending: abandon('VALUATION') }));
    expect(evenements(alerts)).toEqual(['RECONCILIATION_DRIFT', 'RUN_ABORTED']);
  });
});

// --- Le partage des codes de rejet ------------------------------------------

/**
 * Les neuf codes de `RejectionCode`. La completude est verifiee a la
 * compilation par `Exhaustif` : un dixieme code ajoute au noyau sans etre
 * repris ici ne compile plus, plutot que de passer huit sondes sur neuf.
 */
const CODES = [
  'ASSET_NOT_ALLOWED',
  'QUOTE_NOT_ALLOWED',
  'MAX_EXPOSURE',
  'MIN_CASH',
  'REBALANCE_TOO_LARGE',
  'LEG_TOO_SMALL',
  'COOLDOWN',
  'PRICE_SANITY',
  'RECONCILIATION_DRIFT',
] as const satisfies readonly RejectionCode[];

type Exhaustif<T> = [Exclude<RejectionCode, T>] extends [never] ? true : never;
const TOUS_LES_CODES: Exhaustif<(typeof CODES)[number]> = true;

describe('les codes de rejet se partagent entre deux evenements', () => {
  it('couvre les neuf codes du noyau', () => {
    expect(TOUS_LES_CODES).toBe(true);
    expect(CODES).toHaveLength(9);
  });

  it('un rejet REBALANCE_TOO_LARGE seul ne produit que son evenement', () => {
    expect(evenements(alertsFor(verdicts(rejete([rejet('REBALANCE_TOO_LARGE')]))))).toEqual([
      'REBALANCE_TOO_LARGE',
    ]);
  });

  /*
   * Les rejets au niveau du run — sans indice de jambe — passent par
   * `RISK_REJECTED`. S'en tenir litteralement a « jambe rejetee » aurait rendu
   * MIN_CASH et MAX_EXPOSURE silencieux, alors qu'ils disent que le
   * portefeuille est hors de ses propres limites.
   */
  it.each(CODES.filter((code) => code !== 'REBALANCE_TOO_LARGE'))(
    'le code %s passe par RISK_REJECTED',
    (code) => {
      expect(evenements(alertsFor(verdicts(rejete([rejet(code)]))))).toEqual(['RISK_REJECTED']);
    },
  );

  it('un rejet de jambe nomme la jambe', () => {
    const alerts = alertsFor(verdicts(rejete([rejet('MAX_EXPOSURE', 2)])));
    expect(alerts[0]?.body).toContain('jambe 2');
  });

  /*
   * Le partage, eprouve sur les neuf codes d'un coup : chaque code apparait
   * dans **exactement une** alerte, aucun ne disparait, aucun n'est compte deux
   * fois. Une implementation qui n'aurait pas filtre la seconde liste ferait
   * apparaitre REBALANCE_TOO_LARGE deux fois et echouerait ici.
   */
  it('repartit les neuf codes sans perte ni doublon', () => {
    const alerts = alertsFor(verdicts(rejete(CODES.map((code) => rejet(code)))));

    expect(evenements(alerts)).toEqual(['REBALANCE_TOO_LARGE', 'RISK_REJECTED']);
    const corps = alerts.map((a) => a.body).join('\n');
    for (const code of CODES) {
      expect(corps.split(`${code} :`), code).toHaveLength(2);
    }
  });

  it('une alerte par strategie rejetee, la production et l’ombre nommees', () => {
    const alerts = alertsFor(
      entree({
        outcomes: [
          { strategy: 'rebalance', isShadow: false, verdict: rejete([rejet('MIN_CASH')]) },
          { strategy: 'rebalance_ab', isShadow: true, verdict: rejete([rejet('COOLDOWN')]) },
        ],
      }),
    );

    expect(evenements(alerts)).toEqual(['RISK_REJECTED', 'RISK_REJECTED']);
    expect(alerts[0]?.title).toContain('rebalance');
    expect(alerts[0]?.title).not.toContain('ombre');
    expect(alerts[1]?.title).toContain('rebalance_ab (ombre)');
  });
});

// --- Le contenu et l'ordre --------------------------------------------------

describe('ce que porte chaque alerte', () => {
  /*
   * Le texte vient de `snapshot.ts` et n'est pas reecrit : c'est celui de la
   * ligne de `decisions` du jour. Une seule source, donc l'alerte et la base ne
   * peuvent pas raconter deux chiffres differents.
   */
  it('reprend mot pour mot le motif de suspension', () => {
    const alerts = alertsFor(entree({ suspension: SUSPENDU }));
    expect(alerts[0]?.body).toBe(SUSPENDU.reason);
  });

  /*
   * Le notionnel est un montant USDC : il sort en Decimal a deux decimales, pas
   * en flottant. `12345.678` arrondi a `12345.68` distingue une conversion
   * correcte d'un `Number()` qui aurait pu passer les autres sondes.
   */
  it('formate le notionnel d’un reequilibrage execute en USDC', () => {
    const alerts = alertsFor(ATTEINT.REBALANCE_EXECUTED);
    expect(alerts[0]?.body).toContain('2 ordre(s)');
    expect(alerts[0]?.body).toContain('12345.68 USDC');
  });

  it('dit qu’un abandon n’a rien ecrit', () => {
    const alerts = alertsFor(entree({ ending: abandon('VALUATION') }));
    expect(alerts[0]?.body).toContain('ni decision, ni photo');
  });

  /*
   * L'ordre est celui du catalogue : c'est lui qui met le plus urgent en tete
   * de l'ecran verrouille. Un run qui cumule tout le sert dans cet ordre, quel
   * que soit l'ordre dans lequel les faits ont ete constates.
   */
  it('sert les alertes dans l’ordre du catalogue', () => {
    const alerts = alertsFor({
      runDate: RUN_DATE,
      ending: abandon('DECIDE'),
      suspension: SUSPENDU,
      resync: RESYNCHRONISE,
      outcomes: [
        {
          strategy: 'rebalance',
          isShadow: false,
          verdict: rejete([rejet('MIN_CASH'), rejet('REBALANCE_TOO_LARGE')]),
        },
      ],
      executed: [{ strategy: 'rebalance', orders: 1, notional: usdc('100') }],
    });

    expect(evenements(alerts)).toEqual([
      'REBALANCE_EXECUTED',
      'DRAWDOWN',
      'REBALANCE_TOO_LARGE',
      'RECONCILIATION_DRIFT',
      'RISK_REJECTED',
      'RUN_ABORTED',
    ]);
  });

  /*
   * Le tri n'est pas decoratif, et cette sonde est celle qui le dit. Les faits
   * sont constates strategie par strategie : sans tri, le rejet de la premiere
   * strategie sortirait avant le `REBALANCE_TOO_LARGE` de la seconde, et
   * l'ecran verrouille montrerait le moins urgent en tete. Une premiere
   * redaction de ce fichier ne sondait l'ordre que sur une strategie unique, ou
   * l'ordre d'insertion coincide par accident avec celui du catalogue : la
   * mutation « retirer le tri » y survivait.
   */
  it('remet en ordre deux evenements que les strategies ont produits a l’envers', () => {
    const alerts = alertsFor(
      entree({
        outcomes: [
          { strategy: 'rebalance', isShadow: false, verdict: rejete([rejet('MIN_CASH')]) },
          {
            strategy: 'rebalance_ab',
            isShadow: true,
            verdict: rejete([rejet('REBALANCE_TOO_LARGE')]),
          },
        ],
      }),
    );

    expect(evenements(alerts)).toEqual(['REBALANCE_TOO_LARGE', 'RISK_REJECTED']);
    expect(alerts[0]?.title).toContain('rebalance_ab');
  });

  /** Le tri est stable : deux alertes du meme evenement gardent l'ordre des strategies. */
  it('garde l’ordre des strategies a evenement egal', () => {
    const alerts = alertsFor(
      entree({
        executed: [
          { strategy: 'rebalance', orders: 1, notional: usdc('1') },
          { strategy: 'rebalance_ab', orders: 1, notional: usdc('2') },
        ],
      }),
    );

    expect(alerts.map((a) => a.title)).toEqual([
      expect.stringContaining('rebalance'),
      expect.stringContaining('rebalance_ab'),
    ]);
  });
});
