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
import type { HttpOutcome, HttpRequest, HttpSend } from '../../src/adapters/http.js';
import { RUN_MARKER, openHealthcheck } from '../../src/adapters/healthcheck.js';
import { openMailer } from '../../src/adapters/mailer.js';
import type { AlertEvent } from '../../src/adapters/notifier.js';
import { openNotifier } from '../../src/adapters/notifier.js';
import type { UbacConfig } from '../../src/config/env.js';
import { loadConfig, NTFY_CANAL_OUVERT } from '../../src/config/env.js';
import { expectedCalendar } from '../../src/fixture/normalise.js';
import type { Price, Quantity, UsdcAmount } from '../../src/core/types.js';
import type { DailyPorts, DailyRunResult, RunClock } from '../../src/jobs/daily.js';
import { DailyRunError, NTFY_CANAL_OUVERT_LIGNE, reported, runDaily } from '../../src/jobs/daily.js';
import { RESYNC_MARKER } from '../../src/jobs/reconcile.js';
import { REPORT_TAG } from '../../src/report/daily-report.js';
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
 *
 * Les trois canaux du §9 sont eprouves **contre les vrais `openNotifier`,
 * `openMailer` et `openHealthcheck`**, montes chacun sur son transport double.
 * Un double de `Notifier`, de `Mailer` ou de `Healthcheck` aurait sonde le
 * cablage sans sonder ce qui part ; ici le corps reellement publie est lisible
 * des trois cotes, et les garanties « un compte rendu qui echoue ne fait pas
 * tomber le run » sont eprouvees sur le code qui les porte et non sur une
 * imitation complaisante. Pour le healthcheck cela va plus loin : un double
 * aurait laisse passer la seule chose qui compte — le marqueur present ou
 * absent — puisque c'est l'adapter qui le pose. Aucun reseau : `openHttp` n'est
 * jamais appele, les transports sont trois fonctions du test.
 *
 * **Trois transports et non un.** Les partager aurait rendu impossible de faire
 * echouer un canal sans les autres, donc impossible de distinguer « l'alerte
 * n'est pas partie », « le rapport n'est pas parti » et « le ping n'est pas
 * parti » — trois pannes differentes, dont les deux premieres doivent se voir
 * dans le pulse et le code de sortie, et la troisieme dans ni l'un ni l'autre.
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
  /** Le transport du notifieur. Par defaut : tout part. */
  readonly transport?: HttpSend;
  /** Le transport de l'envoi Brevo. Par defaut : tout part. */
  readonly courrier?: HttpSend;
  /** Le transport du healthcheck. Par defaut : le ping passe. */
  readonly pulse?: HttpSend;
  /**
   * Le port qui leve, pour eprouver les chemins d'exception. Trois profondeurs
   * de l'enchainement : avant la premiere lecture, au milieu des lectures, apres
   * la derniere ecriture.
   */
  readonly panne?: 'keyPermissions' | 'dailyCandles' | 'recordSnapshot';
  /** Variables d'environnement ajoutees a `ENV` avant `loadConfig`. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Ce que leve le port en panne. Reconnaissable, et sans rapport avec le metier. */
const PANNE = 'panne simulee';

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
  /** Les publications ntfy reellement tentees, corps JSON compris. */
  readonly pushes: { readonly url: string; readonly payload: NtfyPayload }[];
  /** Les envois Brevo reellement tentes, corps JSON compris. */
  readonly courriers: { readonly url: string; readonly payload: BrevoPayload }[];
  /** Les pings reellement tentes, corps en clair compris. Au plus un par run. */
  readonly pings: { readonly url: string; readonly body: string }[];
}

/**
 * Le corps JSON que `notifier.ts` publie. Relu tel quel, sans indulgence.
 *
 * `tags` porte deux choses et dans cet ordre — l'evenement, puis la cle
 * deterministe de Q6a1. Le type le dit en tuple plutot qu'en tableau : une
 * sonde qui lirait `tags[0]` sur une liste dont l'ordre aurait change passerait
 * en silence.
 */
interface NtfyPayload {
  readonly topic: string;
  readonly title: string;
  readonly message: string;
  readonly priority: number;
  readonly tags: readonly [AlertEvent, string];
}

/**
 * Le corps JSON que `mailer.ts` publie sur `/v3/smtp/email`. La forme exacte
 * que Brevo a acceptee en reel ; `test/adapters/mailer.test.ts` la relit champ
 * par champ, ici on relit ce que **le run** y met.
 */
interface BrevoPayload {
  readonly sender: { readonly email: string };
  readonly to: readonly { readonly email: string }[];
  readonly subject: string;
  readonly htmlContent: string;
  readonly tags: readonly string[];
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
  COINBASE_PORTFOLIO_UUID: '00000000-0000-4000-8000-000000000001',
  BREVO_API_KEY: 'brevo-de-test',
  BREVO_SENDER: 'ubac@exemple.test',
  BREVO_RECIPIENT: 'operateur@exemple.test',
  NTFY_TOKEN: 'ntfy-de-test',
  HEALTHCHECK_URL: 'https://exemple.invalid/ping',
  NTFY_URL: 'https://exemple.invalid/ntfy',
  NTFY_TOPIC: 'ubac-test',
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
  const pushes: { url: string; payload: NtfyPayload }[] = [];
  const courriers: { url: string; payload: BrevoPayload }[] = [];
  const pings: { url: string; body: string }[] = [];
  if (scenario.snapshot !== undefined) photos.set(scenario.snapshot.runDate, scenario.snapshot);
  const runDate = scenario.runDate ?? RUN_DATE;
  const closes = scenario.closes ?? { BTC: BTC_CLOSE, ETH: ETH_CLOSE };

  const portfolio: PortfolioBalances = {
    portfolioUuid: PORTFOLIO,
    balances: scenario.balances ?? [],
  };

  const config = loadConfig({ ...ENV, ...scenario.env });
  const transport: HttpSend = async (request: HttpRequest): Promise<HttpOutcome> => {
    appels.push('notify');
    pushes.push({ url: request.url, payload: JSON.parse(request.body) as NtfyPayload });
    return scenario.transport === undefined
      ? { status: 'OK', httpStatus: 200 }
      : scenario.transport(request);
  };
  const postier: HttpSend = async (request: HttpRequest): Promise<HttpOutcome> => {
    appels.push('sendReport');
    courriers.push({ url: request.url, payload: JSON.parse(request.body) as BrevoPayload });
    return scenario.courrier === undefined
      ? { status: 'OK', httpStatus: 201 }
      : scenario.courrier(request);
  };
  const pulse: HttpSend = async (request: HttpRequest): Promise<HttpOutcome> => {
    appels.push('ping');
    pings.push({ url: request.url, body: request.body });
    return scenario.pulse === undefined ? { status: 'OK', httpStatus: 200 } : scenario.pulse(request);
  };

  return {
    appels,
    lignes,
    fenetres,
    depuis,
    table,
    photos,
    pushes,
    courriers,
    pings,
    gitSha: GIT_SHA,
    clock: { today: () => runDate, instant: () => new Date(`${runDate}T07:00:00.000Z`) },
    config,
    log: (line) => lignes.push(line),
    ports: {
      exchange: {
        keyPermissions: () => {
          appels.push('keyPermissions');
          if (scenario.panne === 'keyPermissions') throw new Error(PANNE);
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
          if (scenario.panne === 'dailyCandles') throw new Error(PANNE);
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
        /* La serie du graphe, lue sur la meme table que `latestSnapshot` et reduite aux deux colonnes que le rapport lit. */
        snapshotSeries: () => {
          appels.push('snapshotSeries');
          return Promise.resolve(
            [...photos.keys()].sort().map((runDate) => ({
              runDate,
              benchmarks: photos.get(runDate)?.benchmarks ?? {},
            })),
          );
        },
        recordSnapshot: (input) => {
          appels.push('recordSnapshot');
          if (scenario.panne === 'recordSnapshot') throw new Error(PANNE);
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
      notifier: openNotifier(config.secrets, transport),
      mailer: openMailer(config.secrets, postier),
      healthcheck: openHealthcheck(config.secrets, pulse),
    },
  };
}

/** Le corps du ping du run, ou `undefined` si aucun ping n'est parti. */
const corpsDuPing = (h: Harnais): string | undefined => h.pings[0]?.body;

/** Les evenements pousses, dans l'ordre d'envoi. Premier tag, cf. `NtfyPayload`. */
const evenements = (h: Harnais): AlertEvent[] => h.pushes.map((push) => push.payload.tags[0]);

/** La cle deterministe de Q6a1 : `cle-` et douze hexadecimaux, jamais autre chose. */
const CLE = expect.stringMatching(/^cle-[0-9a-f]{12}$/) as unknown as string;

const lance = (h: Harnais): Promise<DailyRunResult> => runDaily(h);

function complete(result: DailyRunResult): Extract<DailyRunResult, { status: 'COMPLETED' }> {
  if (result.status !== 'COMPLETED') {
    throw new Error(`run abandonne : ${result.abort.reason}`);
  }
  return result;
}

/**
 * Une photo de la veille, **chainable** : elle porte l'indice de croissance.
 * Sans lui, l'etape 7 refuse d'en reposer une (`NO_CARRIED_INDEX`) et le cache
 * ne se rafraichirait pas — ce qui rendrait muettes les sondes de Q10.
 */
function cache(positions: Readonly<Record<string, Quantity>>, total: string): SnapshotRecord {
  return photo(positions, {
    runDate: PRICED_ON,
    totalValueUsdc: new Decimal(total) as UsdcAmount,
    benchmarks: {
      [PORTFOLIO_KEYS.index]: new Decimal('1'),
      [PORTFOLIO_KEYS.peak]: new Decimal('1'),
    },
    createdAt: new Date(`${PRICED_ON}T07:00:00.000Z`),
  });
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
      // La serie du graphe du rapport, lue ici et pas juste avant l'envoi : une
      // lecture posterieure aux ecritures ferait echouer, apres coup, un run qui
      // a deja tout ecrit.
      'snapshotSeries',
      'recordDecision',
      'recordDecision',
      'recordDecision',
      'recordDecision',
      // La photo ferme le run : un abandon rend avant d'y arriver.
      'recordSnapshot',
      // Puis le compte rendu, hors de l'enchainement : ici rien n'alerte, donc
      // le rapport vient seul apres la derniere ecriture.
      'sendReport',
      // Et le ping ferme le tout, apres la derniere ecriture comme apres le
      // dernier compte rendu. Le rang relatif des trois est sonde plus bas.
      'ping',
    ]);
  });

  /*
   * **Q10 : la divergence ne coupe plus le run.** Avant ce lot, ce scenario
   * rendait `ABORTED` sans rien ecrire — donc sans poser de photo, donc en
   * condamnant tous les runs suivants a relire le meme cache faux. Desormais le
   * cache se rend : le run decide sur les soldes de l'exchange, journalise ses
   * quatre lignes et repose une photo aux quantites reelles.
   */
  it('resynchronise sur divergence et poursuit le run jusqu’a la photo', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      // 0.9 BTC en interne contre 0.8 reels : 11 % d'ecart, au-dela de 1 %.
      snapshot: cache({ BTC: qty('0.9'), ETH: qty('12'), USDC: qty('30000') }, '100000'),
    });
    const result = complete(await lance(h));

    expect(result.resync.status).toBe('RESYNCHRONIZED');
    // Les soldes decides sont ceux de l'exchange, jamais ceux du cache.
    expect(result.holdings.BTC.toString()).toBe('0.8');
    expect(h.table.size).toBe(LES_QUATRE.length);
    expect(h.appels).toContain('recordSnapshot');
    // Et la photo reposee porte les quantites reelles : c'est le rafraichissement.
    expect(h.photos.get(RUN_DATE)?.positions.BTC?.toString()).toBe('0.8');
  });

  /*
   * **La trace durable du lot.** L'alerte reveille le jour meme ; elle ne se
   * relit pas six mois plus tard. Le marqueur en tete de `decisions.reason` est
   * ce qui permet a un lecteur du journal des decisions de dire « ce jour-la,
   * quelqu'un a bouge le portefeuille hors du systeme ». Les **quatre** lignes le
   * portent : l'etat resynchronise est celui du portefeuille, pas d'une
   * strategie, et c'est la ligne qu'on ne lit pas qui mentirait.
   */
  it('marque les quatre lignes de decisions, et seulement un jour de resynchronisation', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      snapshot: cache({ BTC: qty('0.9'), ETH: qty('12'), USDC: qty('30000') }, '100000'),
    });
    await lance(h);

    const motifs = [...h.table.values()].map((d) => d.intent.reason);
    expect(motifs).toHaveLength(LES_QUATRE.length);
    for (const motif of motifs) expect(motif.startsWith(RESYNC_MARKER)).toBe(true);
    // Le motif de la strategie survit au marqueur : il le precede, il ne le remplace pas.
    expect(motifs.every((m) => m.split('\n').length > 1)).toBe(true);

    const sain = harnais({ balances: DANS_LA_BANDE });
    await lance(sain);
    for (const decision of sain.table.values()) {
      expect(decision.intent.reason).not.toContain(RESYNC_MARKER);
    }
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
   * indistinguable d'un job qui n'a pas tourne ; c'est l'alerte `RUN_ABORTED` qui
   * fait desormais la difference, et le bloc « §9 » plus bas la sonde. Ce lot ne
   * doit pas non plus aggraver la chose en photographiant un run abandonne.
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

// --- L'impasse reelle, fermee de bout en bout -------------------------------

/**
 * **Le cas qui a motive le lot, rejoue tel quel.** L'operateur a reequilibre son
 * portefeuille a la main, hors du systeme, entre deux runs : BTC 0,0159 → 0,0284,
 * ETH 0,5155 → 0,6729, USDC 2 946 → 1 620. Le run suivant a trouve 44 %, 23 % et
 * 45 % d'ecart et abandonne **avant toute ecriture**, donc sans poser de nouvelle
 * photo — si bien que le run d'apres relisait la meme photo perimee et abandonnait
 * de nouveau. Chaque jour, pour toujours.
 *
 * Ce bloc ne sonde pas un run mais **deux, consecutifs**, et c'est le second qui
 * porte l'affirmation : sans le rafraichissement, il abandonnerait comme le
 * premier. Un test sur un run unique laisserait passer une implementation qui
 * alerte, marque, et oublie de reposer la photo.
 */
describe('une intervention manuelle ne condamne plus le job', () => {
  const REEL: readonly AssetBalance[] = [
    solde('BTC', '0.0284'),
    solde('ETH', '0.6729'),
    solde('USDC', '1620'),
  ];
  /**
   * Ce que la base croyait encore : la photo d'avant l'intervention. Elle valait
   * 5 029,75 USDC aux clotures du double — le reequilibrage manuel a deplace de
   * la valeur entre lignes, il n'a pas apporte d'argent.
   */
  const CACHE_PERIME = cache(
    { BTC: qty('0.0159'), ETH: qty('0.5155'), USDC: qty('2946') },
    '5029.75',
  );
  const LENDEMAIN = '2026-09-13';

  it('le premier run resynchronise, alerte, et repose une photo aux soldes reels', async () => {
    const h = harnais({ balances: REEL, snapshot: CACHE_PERIME });
    const result = complete(await lance(h));

    expect(result.resync.status).toBe('RESYNCHRONIZED');
    expect(evenements(h)).toContain('RECONCILIATION_DRIFT');
    const reposee = h.photos.get(RUN_DATE);
    expect(reposee?.positions.BTC?.toString()).toBe('0.0284');
    expect(reposee?.positions.ETH?.toString()).toBe('0.6729');
    expect(reposee?.positions.USDC?.toString()).toBe('1620');
  });

  /*
   * **L'impasse elle-meme.** Le second run part de la photo que le premier a
   * posee, sur les memes soldes reels : plus aucune divergence, aucune alerte de
   * reconciliation, et une journee ordinaire. C'est exactement ce que l'ancien
   * comportement rendait impossible.
   */
  it('le second run conclut normalement, sans divergence ni alerte', async () => {
    const premier = harnais({ balances: REEL, snapshot: CACHE_PERIME });
    await lance(premier);

    /*
     * **Le controle qui empeche cette sonde de mentir.** Si le premier run
     * abandonnait — le comportement d'avant Q10 — il ne poserait aucune photo, le
     * second partirait sans cache et conclurait pour la mauvaise raison :
     * `NO_INTERNAL_STATE` au lieu d'une comparaison reussie. La sonde passerait
     * alors sur le code qu'elle est censee interdire.
     */
    const reposee = premier.photos.get(RUN_DATE);
    expect(reposee?.positions.BTC?.toString()).toBe('0.0284');

    const second = harnais({ balances: REEL, snapshot: reposee, runDate: LENDEMAIN });
    const result = complete(await lance(second));

    expect(result.resync.status).toBe('NOT_NEEDED');
    expect(evenements(second)).not.toContain('RECONCILIATION_DRIFT');
    expect(second.table.size).toBe(LES_QUATRE.length);
    for (const decision of second.table.values()) {
      expect(decision.intent.reason).not.toContain(RESYNC_MARKER);
    }
    expect(reported(result)).toBe(true);
  });

  /*
   * Et la trace reste lisible apres coup : le journal des decisions distingue le
   * jour de l'intervention du lendemain, sans qu'on ait rien conserve d'autre que
   * la base. C'est la moitie du marqueur qu'une alerte ne peut pas tenir.
   */
  it('le journal des decisions distingue les deux jours', async () => {
    const premier = harnais({ balances: REEL, snapshot: CACHE_PERIME });
    await lance(premier);
    const second = harnais({
      balances: REEL,
      snapshot: premier.photos.get(RUN_DATE),
      runDate: LENDEMAIN,
    });
    await lance(second);
    expect(second.table.size).toBe(LES_QUATRE.length);

    const marquees = (h: Harnais): string[] =>
      [...h.table.keys()].filter((cle) =>
        (h.table.get(cle)?.intent.reason ?? '').includes(RESYNC_MARKER),
      );
    expect(marquees(premier)).toHaveLength(LES_QUATRE.length);
    expect(marquees(second)).toEqual([]);
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
  return cache({ BTC: qty('1'), ETH: qty('16'), USDC: qty('10000') }, total);
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


// --- §9, le rapport quotidien ----------------------------------------------

/** Le courrier reellement poste, ou l'echec de la sonde si rien n'est parti. */
function courrier(h: Harnais): BrevoPayload {
  const envoye = h.courriers[0]?.payload;
  if (envoye === undefined) throw new Error('aucun rapport n’a ete poste');
  return envoye;
}

describe('§9 — le rapport quotidien part par Brevo', () => {
  /*
   * **Le piege nomme par le brief.** Un run sans action doit quand meme dire a
   * l'operateur que le systeme a tourne : sans ce courrier, une journee calme ne
   * se distingue pas d'un job qui n'a pas demarre. Le §9 demande d'ailleurs la
   * decision du jour « y compris quand le trigger est NONE ».
   */
  it('part meme sur trigger NONE, et le sujet le dit', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    const result = complete(await lance(h));

    expect(result.outcomes.every((o) => o.intent.trigger === 'NONE')).toBe(true);
    expect(h.courriers).toHaveLength(1);
    expect(courrier(h).subject).toBe(
      `Ubac ${RUN_DATE} — 100000.00 USDC — aucun declenchement`,
    );
    expect(result.report.mail).toEqual({ status: 'SENT', httpStatus: 201 });
  });

  /* Les deux autres sujets : le declenchement, et la suspension qui passe devant. */
  it('part aussi quand le run declenche, et quand il est suspendu', async () => {
    const declenche = harnais({ balances: HORS_BANDE });
    await lance(declenche);
    expect(courrier(declenche).subject).toContain('CASH_BAND, 2 jambe(s)');

    const suspendu = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    await lance(suspendu);
    expect(courrier(suspendu).subject).toContain('SUSPENDU (recul -50.00 %)');
  });

  it('porte l’expediteur, le destinataire et le tag daily-report du §9', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    const poste = courrier(h);
    expect(poste.sender).toEqual({ email: 'ubac@exemple.test' });
    expect(poste.to).toEqual([{ email: 'operateur@exemple.test' }]);
    expect(poste.tags).toContain(REPORT_TAG);
    expect(h.courriers[0]?.url).toBe('https://api.brevo.com/v3/smtp/email');
  });

  /*
   * Le corps est celui du rendu, et non une seconde mise en forme du run : la
   * sonde lit trois sections que `daily-report.ts` fabrique et que rien d'autre
   * ici ne saurait produire. `test/report/daily-report.test.ts` tient le rendu
   * ligne a ligne ; ce qui est etabli ici est le **branchement**.
   */
  it('poste le rendu du §9, pas une seconde mise en forme', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    const html = courrier(h).htmlContent;
    expect(html).toContain('Distance au prochain declenchement');
    expect(html).toContain('Decision du jour');
    expect(html).toContain('Comparaison');
    expect(html).toContain(`rapport du ${RUN_DATE}`);
    // Le prix vient du dernier jour clos, pas du jour de run.
    expect(html).toContain(`Prix de cloture du ${PRICED_ON}`);
  });

  /*
   * La production n'arme pas le declencheur B (C13), et c'est **la configuration
   * de production** que le rapport confronte aux poids : passer `config.rebalance`
   * tel quel afficherait une bande de ratio que la production n'arbitre pas.
   */
  it('confronte les poids aux bandes de la production, declencheur B desarme', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    await lance(h);

    const html = courrier(h).htmlContent;
    expect(html).toContain('Bande de cash (A)');
    expect(html).not.toContain('Bande de ratio (B)');
    expect(html).toContain('Declencheur B desarme');
  });

  /*
   * La sonde qui separe reellement `config.rebalance` de la configuration de
   * production. `UBAC_RATIO_BAND_ENABLED` ne decide de rien dans le run — c'est
   * le **nom** de la configuration qui arme B (C13), et `rebalance` ne l'arme
   * pas —, mais elle vit dans `config.rebalance`. Passer celui-ci au rendu
   * afficherait une bande de ratio que la production n'arbitre jamais, avec une
   * distance au declenchement qui ne declencherait rien : une information de
   * confiance, et fausse.
   *
   * Sans cette sonde, les deux formes se confondent sur l'environnement par
   * defaut, ou le drapeau vaut deja faux des deux cotes.
   */
  it('ignore UBAC_RATIO_BAND_ENABLED : la production n’arbitre pas le ratio', async () => {
    const h = harnais({ balances: DANS_LA_BANDE, env: { UBAC_RATIO_BAND_ENABLED: 'true' } });
    const result = complete(await lance(h));

    // La variable est bien armee dans la configuration chargee...
    expect(h.config.rebalance.ratioBandEnabled).toBe(true);
    // ...et la production continue de ne pas declencher sur le ratio.
    const production = result.outcomes.find((o) => !o.isShadow);
    expect(production?.strategy).toBe('rebalance');
    // Le rapport suit la production, pas la variable.
    const html = courrier(h).htmlContent;
    expect(html).not.toContain('Bande de ratio (B)');
    expect(html).toContain('Declencheur B desarme');
  });

  /*
   * Le P&L du jour est le quotient de deux indices consecutifs : il demande la
   * photo de la **veille**. Le run la porte dans `previousSnapshot` — relire
   * `latestSnapshot()` apres l'etape 7 rendrait celle d'aujourd'hui, le quotient
   * vaudrait 1 et le rapport annoncerait une journee plate qui n'a pas eu lieu.
   */
  it('lit la photo d’avant le run pour le P&L du jour, pas celle qu’il vient d’ecrire', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('100000') });
    const result = complete(await lance(h));

    expect(result.previousSnapshot?.runDate).toBe(PRICED_ON);
    const html = courrier(h).htmlContent;
    expect(html).toContain('P&L jour (TWR)');
    // La note ne parait que sur un P&L indisponible : ici la valeur est rendue.
    expect(html).not.toContain('P&L du jour :');
  });

  /*
   * Au premier run il n'y a pas de veille, et le rendu le **dit** avec son
   * motif plutot que d'afficher un zero : un zero se lirait « journee plate ».
   * C'est le pendant de la sonde precedente — les deux branches de `previous`
   * arrivent bien au courrier.
   */
  it('dit pourquoi il ne sait pas, au premier run, plutot que d’afficher un zero', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    const result = complete(await lance(h));

    expect(result.previousSnapshot).toBeUndefined();
    expect(courrier(h).htmlContent).toContain('aucune photo de reference');
  });

  /*
   * L'ordre des deux canaux : le court d'abord, le long ensuite — et les deux
   * apres la derniere ecriture. Un rapport envoye en cours de route porterait un
   * etat que le run n'aurait finalement pas ecrit.
   */
  it('part apres les alertes, et apres la derniere ecriture', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    await lance(h);

    expect(h.appels.indexOf('sendReport')).toBeGreaterThan(h.appels.lastIndexOf('notify'));
    expect(h.appels.indexOf('sendReport')).toBeGreaterThan(h.appels.lastIndexOf('recordSnapshot'));
    expect(h.appels.indexOf('sendReport')).toBeGreaterThan(h.appels.lastIndexOf('recordDecision'));
  });

  /*
   * **La seconde decision du lot.** Un run abandonne n'envoie pas de rapport :
   * le rendu demande un run conclu, l'abandon est deja parti en push urgent, et
   * un courrier dont cinq sections sur six diraient « indisponible » apprendrait
   * a ne plus ouvrir le courrier. Le cas prend une **branche nommee**, qui
   * journalise son motif — il ne se resout pas par l'absence de code.
   */
  it('n’envoie aucun rapport sur un abandon, et dit pourquoi', async () => {
    const h = harnais({ balances: [solde('BTC', '0'), solde('ETH', '0'), solde('USDC', '0')] });
    const result = await lance(h);

    expect(result.status).toBe('ABORTED');
    expect(h.courriers).toEqual([]);
    expect(result.report.mail.status).toBe('SKIPPED');
    expect(h.lignes.some((l) => l.includes('rapport quotidien non envoye'))).toBe(true);
    // Le silence est ferme par l'autre canal, pas par le rapport.
    expect(evenements(h)).toEqual(['RUN_ABORTED']);
  });

  /*
   * Une divergence, elle, n'est plus un abandon depuis Q10 : le run conclut, donc
   * il a un rapport a rendre. Le courrier part comme n'importe quel autre jour —
   * la resynchronisation, elle, s'est deja dite en push `URGENT`.
   */
  it('envoie son rapport un jour de resynchronisation, qui reste un run conclu', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      snapshot: cache({ BTC: qty('0.9'), ETH: qty('12'), USDC: qty('30000') }, '100000'),
    });
    const result = await lance(h);

    expect(result.status).toBe('COMPLETED');
    expect(result.report.mail.status).toBe('SENT');
    expect(h.courriers).toHaveLength(1);
    expect(evenements(h)).toEqual(['RECONCILIATION_DRIFT']);
  });

  it('n’envoie aucun rapport quand une exception echappe au run', async () => {
    const h = harnais({ balances: DANS_LA_BANDE, runDate: '2026-02-30' });

    await expect(lance(h)).rejects.toThrow(DailyRunError);
    expect(h.courriers).toEqual([]);
  });

  /*
   * **Le troisieme point du brief.** Un echec d'envoi ne defait rien : le run
   * garde son statut, ses quatre lignes et sa photo. Mais il n'est pas
   * silencieux — ligne de journal, sort rendu, et code de sortie non nul par
   * `reported`.
   */
  it('un echec d’envoi ne defait rien du run, et ne passe pas en silence', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      courrier: () =>
        Promise.resolve<HttpOutcome>({
          status: 'FAILED',
          failure: { kind: 'REFUS', httpStatus: 401 },
        }),
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(h.photos.has(RUN_DATE)).toBe(true);
    expect(result.report.mail).toEqual({
      status: 'FAILED',
      reason: 'refus du serveur, HTTP 401',
    });
    expect(h.lignes.some((l) => l.includes('rapport quotidien : NON PARTI'))).toBe(true);
    expect(reported(result)).toBe(false);
  });

  /*
   * La garantie « ne rejette jamais » vit dans `mailer.ts`, en un seul endroit.
   * Le run ne l'entoure d'aucun `try` : si elle cedait, le run tomberait apres
   * avoir tout ecrit — exactement ce que ce lot ne doit pas faire.
   */
  it('un transport qui leve ne fait pas tomber le run', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      courrier: () => {
        throw new TypeError('socket fermee');
      },
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(result.report.mail).toEqual({ status: 'FAILED', reason: 'envoi en echec' });
  });

  /*
   * Les deux canaux ne tombent pas ensemble : une panne ntfy n'empeche pas le
   * rapport de partir, et une panne Brevo n'empeche pas l'alerte. Les partager
   * aurait rendu cette propriete invisible.
   */
  it('une panne d’un canal n’emporte pas l’autre', async () => {
    const ntfyMuet = harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      transport: () =>
        Promise.resolve<HttpOutcome>({
          status: 'FAILED',
          failure: { kind: 'REFUS', httpStatus: 401 },
        }),
    });
    const sansAlerte = complete(await lance(ntfyMuet));
    expect(sansAlerte.report.alerts[0]?.status).toBe('FAILED');
    expect(sansAlerte.report.mail.status).toBe('SENT');

    const brevoMuet = harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      courrier: () =>
        Promise.resolve<HttpOutcome>({
          status: 'FAILED',
          failure: { kind: 'RESEAU' },
        }),
    });
    const sansRapport = complete(await lance(brevoMuet));
    expect(sansRapport.report.alerts[0]?.status).toBe('SENT');
    expect(sansRapport.report.mail).toEqual({ status: 'FAILED', reason: 'echec reseau' });
  });

  /*
   * Le code de sortie du point d'entree sort de `reported`, et le rapport y
   * entre au meme titre que les alertes : une journee que personne ne lira n'est
   * pas un succes. C'est le seul endroit ou un rapport non parti se voie de
   * l'exterieur — le catalogue des sept evenements du §9 n'a pas d'entree pour
   * lui, et en detourner une dirait quelque chose de faux sur le canal urgent.
   */
  it('un rapport non parti fait un run non reussi, alertes parties ou non', async () => {
    const sain = await lance(harnais({ balances: DANS_LA_BANDE }));
    expect(reported(sain)).toBe(true);

    const muet = await lance(
      harnais({
        balances: DANS_LA_BANDE,
        courrier: () =>
          Promise.resolve<HttpOutcome>({ status: 'FAILED', failure: { kind: 'INCONNU' } }),
      }),
    );
    expect(muet.status).toBe('COMPLETED');
    expect(muet.report.alerts).toEqual([]);
    expect(reported(muet)).toBe(false);
  });
});

// --- §9, les alertes --------------------------------------------------------

/**
 * Un transport qui echoue les `combien` premiers envois, puis accepte. Permet
 * de distinguer « l'alerte suivante part quand meme » de « l'envoi s'arrete a
 * la premiere panne », ce qu'un transport uniformement en echec ne dirait pas.
 */
function transportFaillible(combien: number): HttpSend {
  let restants = combien;
  return () => {
    if (restants > 0) {
      restants -= 1;
      return Promise.resolve<HttpOutcome>({
        status: 'FAILED',
        failure: { kind: 'REFUS', httpStatus: 401 },
      });
    }
    return Promise.resolve<HttpOutcome>({ status: 'OK', httpStatus: 200 });
  };
}

describe('§9 — les alertes push', () => {
  it('ne pousse rien quand le run conclut sans incident', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    const result = await lance(h);

    expect(result.status).toBe('COMPLETED');
    expect(h.pushes).toEqual([]);
    expect(result.report.alerts).toEqual([]);
  });

  /*
   * La phase 1 ne place rien : `executed` est toujours vide, donc le run ne peut
   * pas produire `REBALANCE_EXECUTED`. Le chemin existe et `alerts.test.ts`
   * l'eprouve directement ; ici on constate qu'aucun run ne l'atteint, y compris
   * celui qui declenche un reequilibrage complet et le fait accepter.
   */
  it('ne pousse jamais REBALANCE_EXECUTED, meme sur un reequilibrage declenche', async () => {
    const h = harnais({ balances: HORS_BANDE });
    const result = complete(await lance(h));

    expect(result.outcomes.some((o) => o.intent.legs.length > 0)).toBe(true);
    expect(evenements(h)).not.toContain('REBALANCE_EXECUTED');
  });

  /*
   * **Une resynchronisation silencieuse serait pire que l'impasse qu'elle
   * remplace** : le run conclurait normalement, la base porterait de nouveaux
   * soldes, et personne ne saurait que le portefeuille a bouge hors du systeme.
   * Le push `URGENT` est ce qui rend le rafraichissement acceptable.
   */
  it('pousse RECONCILIATION_DRIFT sur une resynchronisation, et rien d’autre', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      snapshot: cache({ BTC: qty('0.9'), ETH: qty('12'), USDC: qty('30000') }, '100000'),
    });
    const result = complete(await lance(h));

    expect(result.resync.status).toBe('RESYNCHRONIZED');
    expect(evenements(h)).toEqual(['RECONCILIATION_DRIFT']);
    expect(h.pushes[0]?.payload.priority).toBe(5);
    expect(h.pushes[0]?.payload.message).toContain(RESYNC_MARKER);
    // Le meme texte que la ligne de `decisions` : une seule source, un seul ecart.
    expect(h.table.get(`${RUN_DATE}|rebalance|false`)?.intent.reason).toContain(
      h.pushes[0]?.payload.message ?? 'introuvable',
    );
  });

  /*
   * **La raison d'etre du lot.** Portefeuille vide, valeur totale nulle : le run
   * abandonne a l'etape de valorisation sans rien ecrire, et le §9 ne nomme
   * d'alerte d'abandon que pour la divergence de reconciliation. Sans
   * `RUN_ABORTED`, ce run-la reste muet et la journee est vide en base comme si
   * le job n'avait pas tourne.
   */
  it('pousse RUN_ABORTED sur un portefeuille non valorisable', async () => {
    const h = harnais({ balances: [solde('BTC', '0'), solde('ETH', '0'), solde('USDC', '0')] });
    const result = await lance(h);

    expect(result.status).toBe('ABORTED');
    expect(evenements(h)).toEqual(['RUN_ABORTED']);
    expect(h.pushes[0]?.payload.title).toContain('VALUATION');
    expect(h.pushes[0]?.payload.topic).toBe('ubac-test');
  });

  it('pousse DRAWDOWN quand la suspension du §6 est active', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    const result = complete(await lance(h));

    expect(result.suspension.status).toBe('ACTIVE');
    expect(evenements(h)).toEqual(['DRAWDOWN']);
    // Le meme texte que la ligne de `decisions` : une seule source, un seul chiffre.
    expect(h.pushes[0]?.payload.message).toBe(h.table.get(`${RUN_DATE}|rebalance|false`)?.intent.reason);
  });

  /*
   * Un abandon posterieur au calcul de la photo connait la suspension : les deux
   * faits partent, dans l'ordre du catalogue. Sans la suspension portee par le
   * resultat d'abandon, le drawdown de ce jour-la serait perdu.
   */
  it('pousse le drawdown ET l’abandon quand le run s’arrete apres la photo', async () => {
    const nonFini: CashFlowRecord = {
      ...flux('2026-09-10', '1'),
      amount: new Decimal(Number.NaN) as UsdcAmount,
    };
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000'), cashFlows: [nonFini] });
    const result = await lance(h);

    expect(result.status).toBe('ABORTED');
    expect(evenements(h)).toEqual(['DRAWDOWN', 'RUN_ABORTED']);
  });

  /*
   * L'ordre entier : les alertes partent **apres** la derniere ecriture. Une
   * alerte emise en cours de route pourrait partir sur un etat que le run
   * n'aurait finalement pas ecrit.
   */
  it('n’alerte qu’une fois tout ecrit', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    await lance(h);

    expect(h.appels.indexOf('notify')).toBeGreaterThan(h.appels.lastIndexOf('recordSnapshot'));
    expect(h.appels.indexOf('notify')).toBeGreaterThan(h.appels.lastIndexOf('recordDecision'));
  });

  /*
   * Le point que le brief demandait de trancher. Une alerte qui echoue ne defait
   * rien : le run garde son statut, ses quatre lignes et sa photo. Mais elle
   * n'est pas silencieuse — elle laisse sa ligne de journal et revient dans le
   * compte rendu, d'ou le point d'entree tire son code de sortie.
   */
  it('une alerte en echec ne defait rien du run, et ne passe pas en silence', async () => {
    const h = harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      transport: () =>
        Promise.resolve<HttpOutcome>({ status: 'FAILED', failure: { kind: 'REFUS', httpStatus: 401 } }),
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(h.photos.has(RUN_DATE)).toBe(true);
    expect(result.report.alerts).toEqual([
      { status: 'FAILED', event: 'DRAWDOWN', key: CLE, reason: 'refus du serveur, HTTP 401' },
    ]);
    expect(h.lignes.some((l) => l.includes('NON PARTIE') && l.includes('DRAWDOWN'))).toBe(true);
  });

  it('la panne d’une alerte n’emporte pas les suivantes', async () => {
    const nonFini: CashFlowRecord = {
      ...flux('2026-09-10', '1'),
      amount: new Decimal(Number.NaN) as UsdcAmount,
    };
    const h = harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      cashFlows: [nonFini],
      transport: transportFaillible(1),
    });
    const result = await lance(h);

    expect(evenements(h)).toEqual(['DRAWDOWN', 'RUN_ABORTED']);
    expect(result.report.alerts.map((a) => a.status)).toEqual(['FAILED', 'SENT']);
  });

  /*
   * Le code de sortie du point d'entree sort de `reported`, et les trois cas
   * sont sondes separement : un run muet vaut 1 comme un abandon, parce qu'un
   * evenement que personne ne verra n'est pas un succes.
   */
  it('un run conclu dont les alertes sont parties est le seul cas rendu comme reussi', async () => {
    const sain = await lance(harnais({ balances: DANS_LA_BANDE }));
    expect(reported(sain)).toBe(true);

    const alerte = await lance(harnais({ balances: HORS_BANDE, snapshot: veille('200000') }));
    expect(reported(alerte)).toBe(true);

    const muet = await lance(
      harnais({
        balances: HORS_BANDE,
        snapshot: veille('200000'),
        transport: () =>
          Promise.resolve<HttpOutcome>({
            status: 'FAILED',
            failure: { kind: 'REFUS', httpStatus: 401 },
          }),
      }),
    );
    expect(muet.status).toBe('COMPLETED');
    expect(reported(muet)).toBe(false);

    const abandonne = await lance(
      harnais({ balances: [solde('BTC', '0'), solde('ETH', '0'), solde('USDC', '0')] }),
    );
    expect(reported(abandonne)).toBe(false);
  });

  /*
   * La garantie « ne rejette jamais » vit dans `notifier.ts`, en un seul
   * endroit. Le run ne l'entoure d'aucun `try` : si elle cedait, le run
   * tomberait apres avoir tout ecrit.
   */
  it('un transport qui leve ne fait pas tomber le run', async () => {
    const h = harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      transport: () => {
        throw new TypeError('socket fermee');
      },
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(result.report.alerts).toEqual([
      { status: 'FAILED', event: 'DRAWDOWN', key: CLE, reason: 'transport en echec' },
    ]);
  });

  /*
   * Une exception alerte puis **continue** : `JOB_FAILED` part, et l'erreur
   * remonte telle quelle jusqu'au point d'entree, qui sort en 1. Alerter n'est
   * pas rattraper — un run qui avalerait son exception rendrait un succes.
   */
  it('pousse JOB_FAILED sur une exception, puis releve l’erreur', async () => {
    const h = harnais({ balances: DANS_LA_BANDE, runDate: '2026-02-30' });

    await expect(lance(h)).rejects.toThrow(DailyRunError);
    expect(evenements(h)).toEqual(['JOB_FAILED']);
    expect(h.pushes[0]?.payload.message).toContain('2026-02-30');
    expect(h.table.size).toBe(0);
  });

  it('n’avale pas l’exception quand l’alerte elle-meme echoue', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      runDate: '2026-02-30',
      transport: () => {
        throw new TypeError('socket fermee');
      },
    });

    await expect(lance(h)).rejects.toThrow(DailyRunError);
    expect(evenements(h)).toEqual(['JOB_FAILED']);
  });
});

/**
 * Le ping de fin de run, §9. **Trois fins, trois sondes**, et la troisieme est
 * celle qui compte : ce n'est pas l'envoi d'un ping qu'elle verifie, c'est son
 * absence.
 *
 * Les corps sont relus tels quels, marqueur compris. Ce que `RUN_MARKER` vaut
 * n'est jamais recopie ici — la constante est importee — parce que deux
 * litteraux divergent et que celui qui n'a pas de sonde gagne.
 */
describe('§9 — le ping du healthcheck', () => {
  /*
   * Le ping est en **toute** derniere position, et le rapport en fait partie :
   * `pulseOf` rapporte le sort des deux canaux, donc pinguer avant l'envoi
   * Brevo reviendrait a affirmer « tout est rendu » sans l'avoir seulement
   * tente. La seule facon de dire qu'un rapport n'est pas parti est d'avoir
   * essaye de l'envoyer d'abord — d'ou l'ordre sonde ici cran par cran.
   */
  it('pingue en dernier, apres le rapport, apres la derniere alerte et apres la derniere ecriture', async () => {
    const h = harnais({ balances: HORS_BANDE, snapshot: veille('200000') });
    await lance(h);

    expect(h.appels[h.appels.length - 1]).toBe('ping');
    expect(h.appels.lastIndexOf('recordSnapshot')).toBeLessThan(h.appels.indexOf('ping'));
    expect(h.appels.lastIndexOf('notify')).toBeLessThan(h.appels.indexOf('ping'));
    expect(h.appels.lastIndexOf('sendReport')).toBeLessThan(h.appels.indexOf('ping'));
  });

  it('un run conclu pingue avec le marqueur, et dit ce qui aide a investiguer', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });
    const result = await lance(h);

    expect(h.pings).toHaveLength(1);
    expect(corpsDuPing(h)).toContain(RUN_MARKER);
    expect(corpsDuPing(h)).toContain(`run_date=${RUN_DATE}`);
    expect(corpsDuPing(h)).toContain(`git_sha=${GIT_SHA}`);
    expect(corpsDuPing(h)).toContain('decisions=4');
    expect(result.report.ping).toEqual({ status: 'PINGED', marked: true });
  });

  /*
   * L'abandon pingue, et c'est la moitie de la regle qu'on oublie : le job a
   * tourne, il n'a simplement pas abouti. Sans marqueur, updown.io le lit DOWN
   * — donc exactement comme un job mort, ce qui est la lecture voulue — mais le
   * corps, lui, dit laquelle des deux pannes a eu lieu.
   */
  it('un run abandonne pingue SANS le marqueur, et nomme l’etape et le code', async () => {
    const h = harnais({ balances: [solde('BTC', '0'), solde('ETH', '0'), solde('USDC', '0')] });
    const result = await lance(h);

    expect(h.pings).toHaveLength(1);
    expect(corpsDuPing(h)).not.toContain(RUN_MARKER);
    expect(corpsDuPing(h)).toContain('etape=VALUATION');
    expect(corpsDuPing(h)).toContain('code=NON_POSITIVE_VALUE');
    expect(result.report.ping).toEqual({ status: 'PINGED', marked: false });
  });

  /*
   * **La sonde la plus importante du lot.** Un ping d'echec est une affirmation
   * — « j'ai tourne, je n'ai pas abouti » — et la formuler suppose que le code a
   * survecu assez loin pour la decider. Une exception n'offre pas cette
   * garantie : c'est l'absence de ping qui doit parler.
   *
   * Les deux alertes partent quand meme, elles : le canal court et la
   * surveillance d'absence ne se remplacent pas.
   */
  it('une exception ne pingue PAS, meme en echec', async () => {
    const h = harnais({ balances: DANS_LA_BANDE, runDate: '2026-02-30' });

    await expect(lance(h)).rejects.toThrow(DailyRunError);
    expect(h.pings).toEqual([]);
    expect(evenements(h)).toEqual(['JOB_FAILED']);
  });

  /*
   * Aucun chemin d'exception ne laisse passer un ping, et « aucun » se sonde en
   * les prenant un par un plutot qu'en croyant la phrase. Trois exceptions
   * levees a trois profondeurs differentes de l'enchainement : avant la
   * premiere lecture, au milieu des lectures, et apres la derniere ecriture —
   * la derniere etant celle qui aurait le plus de raisons de passer, le run
   * ayant alors tout fait.
   */
  it.each(['keyPermissions', 'dailyCandles', 'recordSnapshot'] as const)(
    'aucun ping quand %s leve',
    async (port) => {
      const h = harnais({ balances: DANS_LA_BANDE, panne: port });

      await expect(lance(h)).rejects.toThrow(PANNE);
      expect(h.pings).toEqual([]);
    },
  );

  /*
   * La tension du lot, tranchee et sondee. Le run a **conclu** — quatre lignes
   * de `decisions`, sa photo — mais une alerte n'est pas partie. Le ping part
   * sans marqueur : la panne d'une alerte est exactement la panne qu'aucune
   * alerte ne peut signaler, et le healthcheck est le seul canal restant qui ne
   * depende pas de ntfy.
   *
   * L'etat porte son propre nom, `RUN_NON_RENDU`, et non celui d'un abandon :
   * le travail est fait, et un corps qui pretendrait le contraire enverrait
   * l'operateur chercher une panne qui n'existe pas.
   */
  it('un run conclu dont une alerte n’est pas partie pingue SANS le marqueur', async () => {
    const h = harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      transport: transportFaillible(1),
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(corpsDuPing(h)).not.toContain(RUN_MARKER);
    expect(corpsDuPing(h)).toContain('RUN_NON_RENDU');
    expect(corpsDuPing(h)).toContain('alertes_non_parties=1');
    // Le rapport, lui, est bien parti : le corps doit dire laquelle des deux
    // pannes a eu lieu, pas seulement qu'il y en a eu une.
    expect(corpsDuPing(h)).toContain('rapport_non_parti=non');
    expect(result.report.ping.marked).toBe(false);
  });

  /*
   * **Le cas que la greffe en deux fois avait failli laisser passer.** Aucune
   * alerte perdue — il n'y en a meme aucune a envoyer — et pourtant le run n'a
   * pas rendu compte : Brevo a refuse. Le motif est exactement celui de
   * l'alerte perdue, mot pour mot : la panne d'un canal est la panne que ce
   * canal ne peut pas signaler, et le catalogue des sept evenements du §9 n'a
   * pas d'entree pour « rapport non envoye ».
   *
   * Sans cette sonde, un echec Brevo pingait **avec** le marqueur pendant que
   * `reported` valait faux : updown lisait `UP`, le declencheur lisait 1, et
   * les deux verdicts portaient sur le meme run.
   */
  it('un run conclu dont le rapport n’est pas parti pingue SANS le marqueur', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      courrier: () =>
        Promise.resolve<HttpOutcome>({
          status: 'FAILED',
          failure: { kind: 'REFUS', httpStatus: 401 },
        }),
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(result.report.alerts).toEqual([]);
    expect(corpsDuPing(h)).not.toContain(RUN_MARKER);
    expect(corpsDuPing(h)).toContain('RUN_NON_RENDU');
    expect(corpsDuPing(h)).toContain('alertes_non_parties=0');
    expect(corpsDuPing(h)).toContain('rapport_non_parti=oui');
    expect(result.report.ping.marked).toBe(false);
    expect(reported(result)).toBe(false);
  });

  /*
   * L'autre moitie de la tension : le ping, lui, ne change **rien** au code de
   * sortie. Son absence est deja ce qui fait sonner la surveillance, alors
   * qu'une alerte qui n'est pas partie ne laisse rien derriere elle. Voir
   * `reported` et docs/healthcheck.md §4.
   */
  it('un ping en echec ne defait rien et ne change pas le code de sortie', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      pulse: () =>
        Promise.resolve<HttpOutcome>({
          status: 'FAILED',
          failure: { kind: 'REFUS', httpStatus: 503 },
        }),
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(h.photos.size).toBe(1);
    expect(reported(result)).toBe(true);
    expect(result.report.ping).toEqual({
      status: 'FAILED',
      marked: true,
      reason: 'refus du serveur, HTTP 503',
    });
  });

  /*
   * La garantie « ne rejette jamais » vit dans `healthcheck.ts`, en un seul
   * endroit, et le run ne l'entoure d'aucun `try` : si elle cedait, le run
   * tomberait apres avoir tout ecrit — et apres avoir alerte.
   */
  it('un transport de ping qui leve ne fait pas tomber le run', async () => {
    const h = harnais({
      balances: DANS_LA_BANDE,
      pulse: () => {
        throw new TypeError('socket fermee');
      },
    });
    const result = complete(await lance(h));

    expect(h.table.size).toBe(4);
    expect(result.report.ping).toEqual({
      status: 'FAILED',
      marked: true,
      reason: 'transport en echec',
    });
  });

  /*
   * Un ping qui ne part pas ne doit pas etre muet : sans sa ligne, l'operateur
   * voit updown.io sonner sans pouvoir dire si le job est mort ou si c'est le
   * ping qui n'a pas abouti. Et la ligne ne porte pas l'URL — c'est un secret
   * de fait, qui la connait peut masquer un job mort.
   */
  it('journalise le ping, dans les deux sens, sans jamais citer l’URL', async () => {
    const parti = harnais({ balances: DANS_LA_BANDE });
    await lance(parti);
    expect(parti.lignes.some((l) => l.startsWith('healthcheck : pingue'))).toBe(true);

    const rate = harnais({
      balances: DANS_LA_BANDE,
      pulse: () =>
        Promise.resolve<HttpOutcome>({ status: 'FAILED', failure: { kind: 'RESEAU' } }),
    });
    await lance(rate);
    expect(rate.lignes.some((l) => l.includes('NON PINGUE') && l.includes('echec reseau'))).toBe(
      true,
    );
    expect([...parti.lignes, ...rate.lignes].join('\n')).not.toContain(
      ENV.HEALTHCHECK_URL,
    );
  });
});

// --- §9, la coherence des deux verdicts -------------------------------------

/**
 * **Le code de sortie et le marqueur du ping disent-ils la meme chose.**
 *
 * Ce sont les deux seuls verdicts qu'un run laisse derriere lui, et ils ne se
 * lisent pas au meme endroit : le premier sur la machine, par le declencheur ;
 * le second chez updown.io, qui cherche `RUN_CONCLU` dans le corps. Ils sortent
 * du **meme predicat**, `toutParti`, et cette suite est ce qui interdit qu'ils
 * divergent le jour ou l'un des deux chemins change.
 *
 * Le motif de les tenir ensemble est le meme des deux cotes : la panne d'un
 * canal est exactement la panne que ce canal ne peut pas signaler. Un operateur
 * qui verrait `UP` sur updown et 1 dans son declencheur ne saurait pas lequel
 * croire — et choisirait celui qui l'arrange.
 *
 * L'enumeration est exhaustive sur ce qu'un run peut rendre, et chaque ligne
 * nomme ses deux verdicts a la main plutot que de les deriver l'un de l'autre :
 * une sonde qui comparerait seulement `reported` et `marked` passerait au vert
 * le jour ou les deux tomberaient ensemble sur la mauvaise valeur.
 *
 * La sixieme fin — l'exception — n'a pas de ligne ici : elle ne rend aucun
 * resultat et ne pingue pas du tout, ce que sondent « une exception ne pingue
 * PAS » et « aucun ping quand %s leve ».
 */
describe('§9 — le code de sortie et le marqueur ne divergent pas', () => {
  const refus = (): Promise<HttpOutcome> =>
    Promise.resolve<HttpOutcome>({ status: 'FAILED', failure: { kind: 'REFUS', httpStatus: 401 } });

  /** Un run dont tout part : rien a alerter, rapport accepte. */
  const CONCLU = () => harnais({ balances: DANS_LA_BANDE });
  /** Le rebalancement alerte, et la premiere alerte n'aboutit pas. */
  const ALERTE_PERDUE = () =>
    harnais({ balances: HORS_BANDE, snapshot: veille('200000'), transport: transportFaillible(1) });
  /** Rien a alerter, mais Brevo refuse. */
  const RAPPORT_PERDU = () => harnais({ balances: DANS_LA_BANDE, courrier: refus });
  /** Les deux canaux muets sur le meme run. */
  const LES_DEUX_PERDUS = () =>
    harnais({
      balances: HORS_BANDE,
      snapshot: veille('200000'),
      transport: transportFaillible(1),
      courrier: refus,
    });
  /** Valorisation impossible : le run rend avant d'ecrire quoi que ce soit. */
  const ABANDON = () =>
    harnais({ balances: [solde('BTC', '0'), solde('ETH', '0'), solde('USDC', '0')] });
  /** Tout part, sauf le ping lui-meme — le seul echec qui ne compte dans aucun des deux. */
  const PING_PERDU = () => harnais({ balances: DANS_LA_BANDE, pulse: refus });

  it.each([
    ['un run conclu et entierement rendu', CONCLU, true, true],
    ['un run conclu dont une alerte n’est pas partie', ALERTE_PERDUE, false, false],
    ['un run conclu dont le rapport n’est pas parti', RAPPORT_PERDU, false, false],
    ['un run conclu dont aucun des deux n’est parti', LES_DEUX_PERDUS, false, false],
    ['un run abandonne', ABANDON, false, false],
    ['un run conclu dont seul le ping n’est pas parti', PING_PERDU, true, true],
  ])(
    '%s : le code de sortie et le marqueur s’accordent',
    async (_cas, scenario, reussi, marque) => {
      const h = scenario();
      const result = await lance(h);

      expect(reported(result)).toBe(reussi);
      expect(result.report.ping.marked).toBe(marque);
      /*
       * Et la meme chose lue sur le corps reellement poste, pas sur le sort
       * rendu : c'est cette chaine-la, et elle seule, qu'updown.io cherche. Un
       * `marked` juste sur un corps faux serait une panne invisible.
       */
      expect(corpsDuPing(h)?.includes(RUN_MARKER)).toBe(marque);
    },
  );

  /*
   * L'invariant, dit une fois pour toutes plutot que ligne par ligne : **tout
   * run qui rend un resultat porte le meme verdict des deux cotes.** C'est la
   * propriete que la fusion des deux predicats achete, et la seule facon de la
   * perdre serait d'ecrire un second predicat quelque part.
   */
  it('quel que soit le run, reported et le marqueur du ping sont le meme booleen', async () => {
    const scenarios = [CONCLU, ALERTE_PERDUE, RAPPORT_PERDU, LES_DEUX_PERDUS, ABANDON, PING_PERDU];

    for (const scenario of scenarios) {
      const h = scenario();
      const result = await lance(h);

      expect(result.report.ping.marked).toBe(reported(result));
    }
  });

  /*
   * Le corps d'un run non rendu nomme **lequel** des deux canaux a manque, et
   * les trois combinaisons se distinguent. Sans cela, l'operateur qui voit
   * sonner updown sait qu'un compte rendu manque mais pas lequel — or une
   * alerte perdue et un courrier perdu n'ont ni la meme cause ni la meme
   * urgence.
   */
  it.each([
    ['une alerte seule', ALERTE_PERDUE, 'alertes_non_parties=1', 'rapport_non_parti=non'],
    ['le rapport seul', RAPPORT_PERDU, 'alertes_non_parties=0', 'rapport_non_parti=oui'],
    ['les deux', LES_DEUX_PERDUS, 'alertes_non_parties=1', 'rapport_non_parti=oui'],
  ])('%s : le corps dit lequel des deux canaux a manque', async (_cas, scenario, ...attendus) => {
    const h = scenario();
    await lance(h);

    expect(corpsDuPing(h)).toContain('RUN_NON_RENDU');
    for (const attendu of attendus) expect(corpsDuPing(h)).toContain(attendu);
  });
});

/**
 * Le canal d'alerte non authentifie se **dit**, tous les jours, dans le journal
 * du run. C'est ce que l'ecart coute : un document se lit une fois, une ligne
 * quotidienne se voit passer, et un ecart qui porte une echeance ne doit pas
 * s'oublier au bout d'une semaine.
 *
 * Une sonde par variante annoncee dans l'en-tete de `NTFY_CANAL_OUVERT_LIGNE`.
 */
describe('la ligne du canal ouvert — §9, ecart assume', () => {
  const ouvert = (scenario: Parameters<typeof harnais>[0] = {}): Harnais =>
    harnais({ ...scenario, env: { NTFY_TOKEN: NTFY_CANAL_OUVERT } });

  it('journalise le canal ouvert, une fois, quand la sentinelle est posee', async () => {
    const h = ouvert({ balances: DANS_LA_BANDE });

    await lance(h);

    expect(h.lignes.filter((ligne) => ligne === NTFY_CANAL_OUVERT_LIGNE)).toHaveLength(1);
  });

  it('ne dit rien quand un jeton est pose', async () => {
    const h = harnais({ balances: DANS_LA_BANDE });

    await lance(h);

    expect(h.lignes).not.toContain(NTFY_CANAL_OUVERT_LIGNE);
  });

  /*
   * **Avant l'etape 1**, donc avant le premier appel de port. Le placer plus
   * loin l'aurait fait dependre de la reponse de Coinbase, et un run qui echoue
   * a sa premiere lecture est precisement celui dont on lit le journal.
   */
  it('le dit avant le premier appel de port', async () => {
    const h = ouvert({ balances: DANS_LA_BANDE });

    await lance(h);

    expect(h.lignes[0]).toBe(NTFY_CANAL_OUVERT_LIGNE);
    expect(h.appels).not.toHaveLength(0);
  });

  /*
   * Les trois profondeurs d'exception du §9, reprises telles quelles : la ligne
   * part meme quand le run leve, y compris a la toute premiere lecture.
   */
  it.each(['keyPermissions', 'dailyCandles', 'recordSnapshot'] as const)(
    'le dit quand meme si %s leve',
    async (port) => {
      const h = ouvert({ balances: DANS_LA_BANDE, panne: port });

      await expect(lance(h)).rejects.toThrow(PANNE);
      expect(h.lignes[0]).toBe(NTFY_CANAL_OUVERT_LIGNE);
    },
  );

  /*
   * Et il publie pour de vrai. Le harnais monte le **vrai** `openNotifier` sur
   * un transport double : un canal ouvert alerte comme un canal authentifie,
   * sinon l'ecart couterait les alertes elles-memes.
   */
  it('alerte comme d’habitude, sans jeton', async () => {
    const h = ouvert({ balances: HORS_BANDE, snapshot: veille('200000') });

    await lance(h);

    expect(h.pushes).not.toHaveLength(0);
    expect(h.pushes[0]?.payload.topic).toBe(ENV.NTFY_TOPIC);
  });
});
