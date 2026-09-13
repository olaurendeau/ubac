import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { AssetBalance, KeyPermissions, PortfolioBalances } from '../../src/adapters/coinbase.js';
import type {
  CashFlowRecord,
  DecisionToRecord,
  RecordDecisionOutcome,
  SnapshotRecord,
} from '../../src/adapters/db.js';
import { PORTFOLIO_KEYS, SUSPENSION_MARKER } from '../../src/jobs/snapshot.js';
import type { DailyCandle, DailyWindow } from '../../src/adapters/market.js';
import type { UbacConfig } from '../../src/config/env.js';
import { loadConfig } from '../../src/config/env.js';
import { expectedCalendar } from '../../src/fixture/normalise.js';
import type { Price, Quantity, UsdcAmount } from '../../src/core/types.js';
import type { DailyPorts, DailyRunResult, RunClock } from '../../src/jobs/daily.js';
import { DailyRunError, runDaily } from '../../src/jobs/daily.js';
import { photo, PORTFOLIO, qty, solde } from './doubles.js';

/**
 * Le run quotidien, §8 etapes 1 a 5, contre des doubles. **Aucun reseau, aucune
 * cle, aucune base** : les imports d'adapters ci-dessus sont des `import type`,
 * effaces a la compilation, et `src/jobs/daily.ts` n'en connait lui-meme que les
 * types — ni `ccxt` ni `pg` n'est charge. C'est ce que tient A20 de
 * `test/jobs/purete.test.ts`, et c'est ce qui rend le run eprouvable contre des
 * doubles plutot que contre une cle et une base.
 *
 * Quatre garde-fous sont eprouves ici, et chacun a sa mutation dans le rapport
 * du lot :
 *
 * - la reconciliation precede toute decision, et un abandon n'ecrit rien ;
 * - un trigger `NONE` est persiste comme les autres ;
 * - la fenetre demandee s'arrete au dernier jour **clos** ;
 * - deux runs le meme jour ne produisent qu'une decision par strategie, parce
 *   que la **base** refuse la seconde — pas parce que le code s'abstient.
 */

// --- Doubles ----------------------------------------------------------------

const RUN_DATE = '2026-09-12';
/** Le dernier jour clos au moment du run : la bougie du 12 est encore ouverte. */
const PRICED_ON = '2026-09-11';
const GIT_SHA = '15b29e4c0ffee1234567890abcdefabcdefabcde';

const BTC_CLOSE = '50000';
const ETH_CLOSE = '2500';

const price = (value: string): Price => new Decimal(value) as Price;

function bougies(window: DailyWindow, close: string): readonly DailyCandle[] {
  return expectedCalendar(window.firstDay, window.lastDay).map((date) => ({
    date,
    open: price(close),
    high: price(close),
    low: price(close),
    close: price(close),
  }));
}

function flux(occurredOn: string, amount: string, note: string | null = null): CashFlowRecord {
  return {
    id: `flux-${occurredOn}`,
    occurredAt: new Date(`${occurredOn}T09:00:00.000Z`),
    occurredOn,
    amount: new Decimal(amount) as UsdcAmount,
    note,
  };
}

interface Scenario {
  readonly balances?: readonly AssetBalance[];
  readonly snapshot?: SnapshotRecord | undefined;
  readonly cashFlows?: readonly CashFlowRecord[];
  readonly closes?: Readonly<Record<'BTC' | 'ETH', string>>;
  /** Remplace la serie rendue : sert a produire une serie mal bornee. */
  readonly serie?: (asset: string, window: DailyWindow) => readonly DailyCandle[];
  readonly runDate?: string;
}

interface Harnais {
  readonly ports: DailyPorts;
  readonly clock: RunClock;
  readonly config: UbacConfig;
  readonly gitSha: string;
  readonly log: (line: string) => void;
  /** Les appels de port dans leur ordre reel. */
  readonly appels: string[];
  readonly lignes: string[];
  /** Les fenetres demandees a l'adapter de marche, par actif. */
  readonly fenetres: { asset: string; window: DailyWindow }[];
  /** Les instants passes a `recentCashFlows`. */
  readonly depuis: Date[];
  /** Le journal `decisions`, indexe par l'index unique du §4. */
  readonly table: Map<string, DecisionToRecord>;
  /** La table `snapshots`, indexee par sa cle primaire `run_date`. */
  readonly photos: Map<string, SnapshotRecord>;
}

/**
 * L'environnement minimal que `src/config/env.ts` exige. Valeurs inventees et
 * inertes : aucun secret ne vit dans le depot, et `loadConfig` prend son
 * environnement en parametre precisement pour ne pas muter celui du processus.
 */
const ENV = {
  DATABASE_URL: 'postgres://ubac:mot-de-passe-de-test@localhost:5432/ubac',
  COINBASE_API_KEY: 'cle-de-test',
  COINBASE_API_SECRET: 'secret-de-test',
  BREVO_API_KEY: 'brevo-de-test',
  NTFY_TOKEN: 'ntfy-de-test',
  HEALTHCHECK_URL: 'https://exemple.invalid/ping',
};

const PERMISSIONS: KeyPermissions = { canView: true, canTrade: false, portfolioUuid: PORTFOLIO };

/**
 * Le double de `recordDecision` reproduit **l'index unique**
 * `(run_date, strategy, is_shadow)` et rien d'autre : aucune condition
 * supplementaire, aucune lecture prealable. Que le vrai adapter traduise bien
 * le refus de Postgres en `ALREADY_RECORDED` est etabli par Q2, contre une base
 * jetable, dans `test/adapters/db.test.ts`.
 */
function harnais(scenario: Scenario = {}): Harnais {
  const appels: string[] = [];
  const lignes: string[] = [];
  const fenetres: { asset: string; window: DailyWindow }[] = [];
  const depuis: Date[] = [];
  const table = new Map<string, DecisionToRecord>();
  /*
   * `snapshots` a une cle primaire, pas un index unique refusant : l'adapter y
   * remplace la ligne du jour. Le double fait exactement cela, pour que ce soit
   * le code du run — et non le double — qui tienne la photo unique du jour.
   */
  const photos = new Map<string, SnapshotRecord>();
  if (scenario.snapshot !== undefined) photos.set(scenario.snapshot.runDate, scenario.snapshot);
  const runDate = scenario.runDate ?? RUN_DATE;
  const closes = scenario.closes ?? { BTC: BTC_CLOSE, ETH: ETH_CLOSE };

  const portfolio: PortfolioBalances = {
    portfolioUuid: PORTFOLIO,
    balances: scenario.balances ?? [],
  };

  return {
    appels,
    lignes,
    fenetres,
    depuis,
    table,
    photos,
    gitSha: GIT_SHA,
    clock: { today: () => runDate, instant: () => new Date(`${runDate}T07:00:00.000Z`) },
    config: loadConfig(ENV),
    log: (line) => lignes.push(line),
    ports: {
      exchange: {
        keyPermissions: () => {
          appels.push('keyPermissions');
          return Promise.resolve(PERMISSIONS);
        },
        balances: () => {
          appels.push('balances');
          return Promise.resolve(portfolio);
        },
        openOrders: () => {
          appels.push('openOrders');
          return Promise.resolve([]);
        },
      },
      market: {
        dailyCandles: (asset, window) => {
          appels.push(`dailyCandles:${asset}`);
          fenetres.push({ asset, window });
          const rendue =
            scenario.serie?.(asset, window) ??
            bougies(window, asset === 'BTC' ? closes.BTC : closes.ETH);
          return Promise.resolve(rendue);
        },
      },
      db: {
        pendingOrders: () => {
          appels.push('pendingOrders');
          return Promise.resolve([]);
        },
        latestSnapshot: () => {
          appels.push('latestSnapshot');
          const derniere = [...photos.keys()].sort().pop();
          return Promise.resolve(derniere === undefined ? undefined : photos.get(derniere));
        },
        recordSnapshot: (input) => {
          appels.push('recordSnapshot');
          photos.set(input.runDate, input);
          return Promise.resolve();
        },
        recentCashFlows: (since) => {
          appels.push('recentCashFlows');
          depuis.push(since);
          return Promise.resolve(scenario.cashFlows ?? []);
        },
        recordDecision: (input) => {
          appels.push('recordDecision');
          const cle = `${input.intent.runDate}|${input.intent.strategy}|${String(input.isShadow)}`;
          if (table.has(cle)) {
            return Promise.resolve<RecordDecisionOutcome>({ status: 'ALREADY_RECORDED' });
          }
          table.set(cle, input);
          return Promise.resolve<RecordDecisionOutcome>({
            status: 'RECORDED',
            id: `decision-${String(table.size)}`,
          });
        },
      },
    },
  };
}

const lance = (h: Harnais): Promise<DailyRunResult> => runDaily(h);

function complete(result: DailyRunResult): Extract<DailyRunResult, { status: 'COMPLETED' }> {
  if (result.status !== 'COMPLETED') {
    throw new Error(`run abandonne : ${result.abort.reason}`);
  }
  return result;
}

/** Portefeuille a la cible exacte : 40 000 / 30 000 / 30 000 sur 100 000 USDC. */
const DANS_LA_BANDE: readonly AssetBalance[] = [
  solde('BTC', '0.8'),
  solde('ETH', '12'),
  solde('USDC', '30000'),
];

/** Cash a 10 % : sous la borne basse de 24 %, le declencheur A tire. */
const HORS_BANDE: readonly AssetBalance[] = [
  solde('BTC', '1'),
  solde('ETH', '16'),
  solde('USDC', '10000'),
];

const LES_QUATRE = ['rebalance', 'rebalance_ab', 'ladder', 'dca'];

// --- Enchainement -----------------------------------------------------------

describe('§8 etapes 1 a 5 — l’enchainement du run', () => {
  it('journalise le git_sha au demarrage, apres le healthcheck de la cle', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    expect(h.appels[0]).toBe('keyPermissions');
    expect(h.lignes[0]).toContain(`git_sha=${GIT_SHA}`);
    expect(h.lignes[0]).toContain(`run_date=${RUN_DATE}`);
  });

  /*
   * L'ordre entier, et pas seulement « la reconciliation d'abord » : c'est le
   * meme test qui dit que les prix sont lus apres les soldes et que rien n'est
   * ecrit avant d'avoir tout lu.
   */
  it('reconcilie avant de lire les prix, et n’ecrit qu’apres avoir tout lu', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    expect(h.appels).toEqual([
      'keyPermissions',
      'balances',
      'openOrders',
      'pendingOrders',
      'latestSnapshot',
      'dailyCandles:BTC',
      'dailyCandles:ETH',
      'recentCashFlows',
      // Seconde lecture de la meme ligne : la reconciliation y prend les
      // positions, l'etape 7 la valeur et l'indice. Aucun flux n'est redemande,
      // faute de photo precedente.
      'latestSnapshot',
      'recordDecision',
      'recordDecision',
      'recordDecision',
      'recordDecision',
      // La photo ferme le run : un abandon rend avant d'y arriver.
      'recordSnapshot',
    ]);
  });

  it('abandonne sur divergence de reconciliation, sans ecrire aucune decision', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      // 0.9 BTC en interne contre 0.8 reels : 11 % d'ecart, au-dela de 1 %.
      snapshot: photo({ BTC: qty('0.9'), ETH: qty('12'), USDC: qty('30000') }),
    });
    const result = await lance(h);

    expect(result.status).toBe('ABORTED');
    if (result.status === 'ABORTED') {
      expect(result.abort.step).toBe('RECONCILE');
      expect(result.abort.code).toBe('RECONCILIATION_DRIFT');
    }
    expect(h.appels).not.toContain('recordDecision');
    expect(h.appels).not.toContain('dailyCandles:BTC');
    expect(h.appels).not.toContain('recordSnapshot');
    expect(h.table.size).toBe(0);
  });

  /*
   * Les quatre strategies sont decidees avant que la premiere ne soit ecrite.
   * Sans ce deux-temps, une strategie indecidable laisserait derriere elle les
   * lignes des precedentes, et le run du jour serait a moitie journalise.
   */
  it('abandonne si une strategie ne peut pas decider, avant toute ecriture', async () => {
    const nonFini: CashFlowRecord = { ...flux('2026-09-10', '1'), amount: new Decimal(Number.NaN) as UsdcAmount };
    const h = harnais({ balances: DANS_LA_BANDE, cashFlows: [nonFini] });
    const result = await lance(h);

    expect(result.status).toBe('ABORTED');
    if (result.status === 'ABORTED' && result.abort.step === 'DECIDE') {
      expect(result.abort.strategy).toBe('rebalance');
      expect(result.abort.code).toBe('INVALID_CASH_FLOW');
    } else {
      expect.unreachable('un flux non fini doit arreter la decision');
    }
    expect(h.table.size).toBe(0);
    expect(h.appels).not.toContain('recordSnapshot');
  });

  /*
   * La date de run vient de l'exterieur : c'est un argument, pas une lecture
   * d'horloge. Trois formes la rendent inutilisable, et les trois sont sondees
   * parce qu'elles ne tombent pas au meme endroit : la chaine hors motif, le
   * mois inexistant que le constructeur refuse, et le **report silencieux** —
   * `new Date('2026-02-30T00:00:00.000Z')` rend le 2 mars sous Node 22, et une
   * date reportee decalerait la fenetre de marche sans rien dire.
   */
  it.each(['12 septembre', '2026-13-01', '2026-02-30'])(
    'refuse la date de run « %s » avant toute lecture de marche',
    async (runDate) => {
      const h = harnais({ balances: DANS_LA_BANDE, runDate });

      await expect(lance(h)).rejects.toThrow(DailyRunError);
      expect(h.appels).not.toContain('dailyCandles:BTC');
      expect(h.table.size).toBe(0);
    },
  );

  /*
   * Le cas constate en reel sur le compte de l'operateur : portefeuille vide,
   * valeur totale nulle, aucun poids definissable. Le run abandonne proprement et
   * **n'ecrit rien** — ni decision, ni photo. Depuis la base, cet abandon reste
   * indistinguable d'un job qui n'a pas tourne : c'est l'alerte du lot suivant qui
   * le dira, et ce lot ne doit surtout pas aggraver la chose en photographiant un
   * run abandonne.
   */
  it('abandonne sur un portefeuille non valorisable, sans ecrire ni decision ni photo', async () => {
    const h = harnais({ balances: [solde('BTC', '0'), solde('ETH', '0'), solde('USDC', '0')] });
    const result = await lance(h);

    expect(result.status).toBe('ABORTED');
    if (result.status === 'ABORTED') expect(result.abort.step).toBe('VALUATION');
    expect(h.table.size).toBe(0);
    expect(h.appels).not.toContain('recordSnapshot');
    expect(h.photos.size).toBe(0);
  });
});

// --- La bougie du jour en cours ---------------------------------------------

describe('§8 etape 3 — la fenetre s’arrete au dernier jour clos', () => {
  it('demande les 200 jours qui finissent la veille du run, jamais le jour en cours', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    const attendue: DailyWindow = { firstDay: '2026-02-24', lastDay: PRICED_ON };
    expect(h.fenetres).toEqual([
      { asset: 'BTC', window: attendue },
      { asset: 'ETH', window: attendue },
    ]);
    // 200 jours bornes incluses : le compte est celui de la spec, pas 199 ni 201.
    expect(expectedCalendar(attendue.firstDay, attendue.lastDay)).toHaveLength(200);
    // La fenetre entiere ressort du run : les benchmarks la consommeront sans
    // relire l'API, et une serie tronquee se verrait ici.
    const result = complete(await lance(h));
    expect(result.history.BTC).toHaveLength(200);
    expect(result.history.ETH[199]?.date).toBe(PRICED_ON);
  });

  /*
   * Le controle de bornes n'est pas decoratif. Une serie qui va jusqu'au jour du
   * run porte une cloture qui n'en est pas une — mesuree mouvante par Q3 — et
   * une decision prise dessus serait fausse sans qu'aucun seuil ne morde.
   */
  it('refuse une serie qui inclut la bougie du jour en cours', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      serie: (_asset, window) => bougies({ firstDay: window.firstDay, lastDay: RUN_DATE }, BTC_CLOSE),
    });

    await expect(lance(h)).rejects.toThrow(DailyRunError);
    await expect(lance(h)).rejects.toThrow(/dernier jour clos/);
  });

  it('refuse une serie vide', async () => {
    const h = harnais({ balances: DANS_LA_BANDE, serie: () => [] });
    await expect(lance(h)).rejects.toThrow(/serie de bougies vide/);
  });

  it('prend la cloture du dernier jour clos, sans jamais passer par un flottant', async () => {
    // Une valeur qu'un double binaire ne sait pas porter : Number la reecrit.
    const exact = '50000.123456789012345';
    expect(String(Number(exact))).not.toBe(exact);

    const h = harnais({ balances: DANS_LA_BANDE, closes: { BTC: exact, ETH: ETH_CLOSE } });
    const result = complete(await lance(h));

    expect(result.pricedOn).toBe(PRICED_ON);
    expect(result.prices.BTC.toString()).toBe(exact);
  });
});

// --- Les quatre strategies --------------------------------------------------

describe('§8 etape 5 — une decision par strategie, trigger NONE compris', () => {
  it('ecrit les quatre lignes d’un run sans action', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    const result = complete(await lance(h));

    expect(result.outcomes.map((o) => o.strategy)).toEqual(LES_QUATRE);
    expect(result.outcomes.map((o) => o.intent.trigger)).toEqual(['NONE', 'NONE', 'NONE', 'NONE']);
    expect(result.outcomes.map((o) => o.recorded.status)).toEqual([
      'RECORDED',
      'RECORDED',
      'RECORDED',
      'RECORDED',
    ]);
    expect([...h.table.keys()]).toEqual([
      `${RUN_DATE}|rebalance|false`,
      `${RUN_DATE}|rebalance_ab|true`,
      `${RUN_DATE}|ladder|true`,
      `${RUN_DATE}|dca|true`,
    ]);
  });

  it('journalise le git_sha, l’instant injecte et les poids constates sur chaque ligne', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    for (const ligne of h.table.values()) {
      expect(ligne.gitSha).toBe(GIT_SHA);
      expect(ligne.createdAt.toISOString()).toBe(`${RUN_DATE}T07:00:00.000Z`);
      expect(ligne.intent.weightsBefore.USDC.toString()).toBe('0.3');
      expect(ligne.verdict.status).toBe('ACCEPTED');
    }
  });

  it('persiste aussi un run qui declenche, avec ses jambes et son verdict', async () => {
    const h = harnais({ balances: HORS_BANDE });
    const result = complete(await lance(h));

    const [production] = result.outcomes;
    expect(production?.strategy).toBe('rebalance');
    expect(production?.isShadow).toBe(false);
    expect(production?.intent.trigger).toBe('CASH_BAND');
    // Retour a la cible : deux ventes de 10 000 USDC, 20 % de la valeur totale.
    expect(production?.intent.legs.map((l) => `${l.side} ${l.asset} ${l.amount.toString()}`)).toEqual([
      'SELL BTC 10000',
      'SELL ETH 10000',
    ]);
    expect(production?.verdict.status).toBe('ACCEPTED');
    // La couche risque a produit des ordres ; rien dans ce lot ne les place.
    if (production?.verdict.status === 'ACCEPTED') {
      expect(production.verdict.orders).toHaveLength(2);
    }
    expect(h.table.size).toBe(4);
  });

  it('le ladder journalise NONE : sans ancre persistee, rien ne se franchit', async () => {
    const h = harnais({ balances: HORS_BANDE });
    const result = complete(await lance(h));

    const ladder = result.outcomes.find((o) => o.strategy === 'ladder');
    expect(ladder?.intent.trigger).toBe('NONE');
    expect(ladder?.intent.legs).toEqual([]);
    expect(ladder?.intent.reason).toContain('ancre posee');
    // Le ladder ne vise aucune allocation : la cible recopie les poids constates.
    expect(ladder?.intent.weightsTarget).toEqual(ladder?.intent.weightsBefore);
  });

  it('le DCA achete le jour calendaire, et son achat est journalise', async () => {
    const h = harnais({ balances: DANS_LA_BANDE, runDate: '2026-10-01' });
    const result = complete(await lance(h));

    const dca = result.outcomes.find((o) => o.strategy === 'dca');
    expect(dca?.intent.legs.map((l) => l.amount.toString())).toEqual(['250', '250']);
    expect(dca?.intent.trigger).toBe('NONE');
  });

  /*
   * Le declencheur B distingue les deux configurations, et c'est `core/config.ts`
   * qui le fige (C13). Sans cette assertion, les deux lignes pourraient etre la
   * meme decision ecrite deux fois sous deux noms.
   */
  it('la configuration shadow arme le declencheur B, la production ne l’arme pas', async () => {
    // Ratio BTC/ETH a 2.0, au-dessus de la borne haute 1.733 : B tire, A non.
    const h = harnais({
      balances: [solde('BTC', '0.8'), solde('ETH', '8'), solde('USDC', '30000')],
      closes: { BTC: '50000', ETH: '2500' },
    });
    const result = complete(await lance(h));

    const parNom = new Map(result.outcomes.map((o) => [o.strategy, o]));
    expect(parNom.get('rebalance')?.intent.trigger).toBe('NONE');
    expect(parNom.get('rebalance_ab')?.intent.trigger).toBe('RATIO_BAND');
  });
});

// --- Les flux de tresorerie -------------------------------------------------

describe('§8 etape 4 — les cash_flows recents gelent le declencheur A', () => {
  it('demande la fenetre de carence, et un apport recent empeche le run de tirer', async () => {
    const h = harnais({
      balances: HORS_BANDE,
      cashFlows: [flux('2026-09-10', '5000', 'virement mensuel'), flux('2026-09-11', '-100')],
    });
    const result = complete(await lance(h));

    // Sept jours de carence : la fenetre commence sept jours avant le run.
    expect(h.depuis.map((d) => d.toISOString())).toEqual(['2026-09-05T00:00:00.000Z']);
    expect(result.cashFlows.map((f) => f.occurredOn)).toEqual(['2026-09-10', '2026-09-11']);
    // `note` traverse la frontiere : `null` cote base, absent cote noyau.
    expect(result.cashFlows.map((f) => f.note)).toEqual(['virement mensuel', undefined]);

    const production = result.outcomes[0];
    expect(production?.intent.trigger).toBe('NONE');
    expect(production?.intent.reason).toContain('apport');
    // Le meme portefeuille sans apport tire : la difference vient bien du flux.
    const sansApport = complete(await lance(harnais({ balances: HORS_BANDE })));
    expect(sansApport.outcomes[0]?.intent.trigger).toBe('CASH_BAND');
  });
});

// --- Idempotence ------------------------------------------------------------

describe('§4 — deux runs le meme jour, une seule decision par strategie', () => {
  /*
   * Le second run est reellement lance, pas simule par un compteur d'appels.
   * C'est la difference entre « le code ne rappelle pas » et « la base refuse »,
   * et seule la seconde est l'idempotence que le §4 promet.
   */
  it('le second run rejoue tout et se fait refuser par l’index unique', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });

    const premier = complete(await lance(h));
    const second = complete(await lance(h));

    expect(premier.outcomes.map((o) => o.recorded.status)).toEqual([
      'RECORDED',
      'RECORDED',
      'RECORDED',
      'RECORDED',
    ]);
    expect(second.outcomes.map((o) => o.recorded.status)).toEqual([
      'ALREADY_RECORDED',
      'ALREADY_RECORDED',
      'ALREADY_RECORDED',
      'ALREADY_RECORDED',
    ]);

    // Huit tentatives d'ecriture, quatre lignes : le refus vient de la base.
    expect(h.appels.filter((a) => a === 'recordDecision')).toHaveLength(8);
    expect(h.table.size).toBe(4);
  });

  it('un run le lendemain ecrit ses propres lignes', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    const lendemain: Harnais = { ...h, clock: { today: () => '2026-09-13', instant: h.clock.instant } };
    const result = complete(await lance(lendemain));

    expect(result.outcomes.map((o) => o.recorded.status)).toEqual([
      'RECORDED',
      'RECORDED',
      'RECORDED',
      'RECORDED',
    ]);
    expect(h.table.size).toBe(8);
  });
});

// --- Etape 7 et suspension --------------------------------------------------

/** Une photo de la veille, chainable : positions accordees et indice a 1. */
function veille(total: string): SnapshotRecord {
  return photo(
    { BTC: qty('1'), ETH: qty('16'), USDC: qty('10000') },
    {
      runDate: PRICED_ON,
      totalValueUsdc: new Decimal(total) as UsdcAmount,
      benchmarks: {
        [PORTFOLIO_KEYS.index]: new Decimal('1'),
        [PORTFOLIO_KEYS.peak]: new Decimal('1'),
      },
      createdAt: new Date(`${PRICED_ON}T07:00:00.000Z`),
    },
  );
}

describe('§6, §8 etape 7 — la photo du jour et la suspension au drawdown', () => {
  /*
   * Les deux cotes du seuil sur le meme portefeuille hors bande : a 200 000 USDC
   * la veille le recul vaut 50 %, a 130 000 il vaut 23 %. Seule la premiere
   * ligne change de comportement, donc la difference vient bien du drawdown.
   */
  it('au-dela du seuil, la production est suspendue et les ombres continuent', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    const result = complete(await lance(h));

    expect(result.suspension.status).toBe('ACTIVE');
    const parNom = new Map(result.outcomes.map((o) => [o.strategy, o]));
    expect(parNom.get('rebalance')?.intent.trigger).toBe('NONE');
    expect(parNom.get('rebalance')?.intent.legs).toEqual([]);
    // Les ombres ne passent aucun ordre : les suspendre couperait la comparaison
    // au moment ou elle est la plus interessante.
    expect(parNom.get('rebalance_ab')?.intent.trigger).toBe('CASH_BAND');
    expect(parNom.get('rebalance_ab')?.intent.legs).toHaveLength(2);
    expect(parNom.get('dca')?.isShadow).toBe(true);
    expect(h.table.size).toBe(4);
  });

  /*
   * La trace, et non le seul comportement : sans elle un jour suspendu porte
   * exactement la meme ligne qu'un jour ou rien n'a declenche — `trigger NONE`,
   * zero jambe — et la base ne permet plus de les distinguer.
   */
  it('la suspension laisse sa trace dans decisions, et le run la journalise', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    await lance(h);

    const ligne = h.table.get(`${RUN_DATE}|rebalance|false`);
    expect(ligne?.intent.reason).toContain(SUSPENSION_MARKER);
    expect(ligne?.intent.reason).toContain('-50.00 %');
    // La cible permanente reste lisible : la production la vise toujours.
    expect(ligne?.intent.weightsTarget.USDC.toString()).toBe('0.3');
    expect(h.lignes.some((l) => l.includes(SUSPENSION_MARKER))).toBe(true);
    // Le jour sans suspension n'a aucune ligne qui porte le marqueur.
    const sans = harnais({ balances: HORS_BANDE, snapshot: veille('130000') });
    await lance(sans);
    const libre = sans.table.get(`${RUN_DATE}|rebalance|false`);
    expect(libre?.intent.trigger).toBe('CASH_BAND');
    // Meme colonne `weights_target` suspendu ou non : la ligne reste lisible.
    expect(libre?.intent.weightsTarget.USDC.toString()).toBe('0.3');
  });

  it('ecrit la photo du jour, avec ses poids, ses positions et ses benchmarks', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    const result = complete(await lance(h));

    expect(result.snapshot.status).toBe('TO_RECORD');
    const photographie = h.photos.get(RUN_DATE);
    expect(photographie?.totalValueUsdc.toString()).toBe('100000');
    expect(photographie?.positions.BTC?.toString()).toBe('0.8');
    expect(photographie?.weights.USDC.toString()).toBe('0.3');
    expect(Object.keys(photographie?.benchmarks ?? {})).toContain(PORTFOLIO_KEYS.index);
    // Premier run : l'indisponibilite du drawdown s'ecrit par l'absence de la cle.
    expect(result.drawdown.status).toBe('UNAVAILABLE');
    expect(Object.keys(photographie?.benchmarks ?? {})).not.toContain(PORTFOLIO_KEYS.drawdown);
  });

  /*
   * Le second run est reellement lance, comme pour `decisions`. La difference
   * est que `snapshots` a une cle primaire qui **remplace** : ce n'est donc pas
   * la base qui tient l'unicite de la photo mais la regle d'anteriorite, et
   * c'est l'indice de croissance — non idempotent par multiplication — qu'elle
   * protege.
   */
  it('deux runs le meme jour n’ecrivent qu’une photo, et n’avancent pas l’indice', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('100000') });

    const premier = complete(await lance(h));
    const second = complete(await lance(h));

    expect(h.appels.filter((a) => a === 'recordSnapshot')).toHaveLength(1);
    expect(h.photos.size).toBe(2);
    expect(premier.snapshot.status).toBe('TO_RECORD');
    expect(second.snapshot).toMatchObject({ status: 'SKIPPED', code: 'ALREADY_SNAPSHOTTED' });
    // Le meme chiffre aux deux runs : la suspension ne peut pas basculer entre eux.
    expect(premier.drawdown.status === 'COMPUTED' && premier.drawdown.drawdown.toString()).toBe('0');
    expect(second.drawdown.status === 'COMPUTED' && second.drawdown.drawdown.toString()).toBe('0');
  });

  it('le lendemain chaine sa photo sur la veille, avec sa propre fenetre de flux', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    const lendemain: Harnais = {
      ...h,
      clock: { today: () => '2026-09-13', instant: () => new Date('2026-09-13T07:00:00.000Z') },
    };
    const result = complete(await lance(lendemain));

    expect(h.photos.size).toBe(2);
    expect(result.drawdown.status).toBe('COMPUTED');
    /*
     * Trois appels pour deux runs : le premier n'a demande que la fenetre de
     * carence, le second y a ajoute celle du chainage, qui part de l'horodatage
     * de la photo precedente et non de sept jours en arriere.
     */
    expect(h.appels.filter((a) => a === 'recentCashFlows')).toHaveLength(3);
    expect(h.depuis.map((d) => d.toISOString())).toEqual([
      '2026-09-05T00:00:00.000Z',
      '2026-09-06T00:00:00.000Z',
      '2026-09-12T07:00:00.000Z',
    ]);
  });
});
