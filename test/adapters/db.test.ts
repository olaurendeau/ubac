import { Decimal } from 'decimal.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/adapters/db.js';
import type { UbacDatabase } from '../../src/adapters/db.js';
import { DbFrontierError } from '../../src/adapters/schema.js';
import type { Intent, Price, Quantity, UsdcAmount, Weight, Weights } from '../../src/core/types.js';

/**
 * Ces tests parlent a un vrai Postgres. Ils sont ignores tant que
 * `UBAC_TEST_DATABASE_URL` n'est pas posee, ce qui est le cas de `make test` :
 * la base est une dependance de developpement, pas une dependance de la suite.
 * `make test-db` la pose, apres avoir applique le schema.
 *
 * La variable est **volontairement distincte de `DATABASE_URL`**. Si la suite
 * lisait `DATABASE_URL`, un poste ou la vraie chaine est exportee verrait ses
 * tests tronquer des tables de production. Aucune commande de ce depot ne pose
 * `UBAC_TEST_DATABASE_URL` ailleurs que sur la base jetable de Compose.
 */
const URL_DE_TEST = process.env['UBAC_TEST_DATABASE_URL'];

const CREE_LE = new Date('2026-09-10T07:00:00.000Z');

function poids(btc: string, eth: string, usdc: string): Weights {
  return {
    BTC: new Decimal(btc) as Weight,
    ETH: new Decimal(eth) as Weight,
    USDC: new Decimal(usdc) as Weight,
  };
}

/** Les codes SQLSTATE de la chaine de causes : Drizzle emballe l'erreur du driver. */
function codesDe(error: unknown): readonly string[] {
  const codes: string[] = [];
  let courant: unknown = error;
  while (typeof courant === 'object' && courant !== null) {
    const candidat = courant as { code?: unknown; cause?: unknown };
    if (typeof candidat.code === 'string') codes.push(candidat.code);
    courant = candidat.cause;
  }
  return codes;
}

function intention(overrides: Partial<Intent> = {}): Intent {
  return {
    runDate: '2026-09-10',
    strategy: 'rebalance',
    trigger: 'CASH_BAND',
    reason: 'cash a 23.4 %, sous le bord bas 24 %',
    weightsBefore: poids('0.47', '0.296', '0.234'),
    weightsTarget: poids('0.40', '0.30', '0.30'),
    legs: [
      {
        asset: 'BTC',
        quote: 'USDC',
        side: 'SELL',
        amount: new Decimal('1234.56789012') as UsdcAmount,
        limitPrice: new Decimal('64321.09876543') as Price,
      },
    ],
    ...overrides,
  };
}

describe.skipIf(URL_DE_TEST === undefined)('adapter de base, contre un Postgres reel', () => {
  const url = URL_DE_TEST ?? '';
  let db: UbacDatabase;
  let brut: pg.Client;

  beforeAll(async () => {
    db = openDatabase({ databaseUrl: url });
    brut = new pg.Client({ connectionString: url });
    await brut.connect();
  });

  afterAll(async () => {
    await db.close();
    await brut.end();
  });

  beforeEach(async () => {
    await brut.query('TRUNCATE decisions, orders, snapshots, cash_flows');
  });

  /**
   * Le second run du meme jour est refuse par l'index unique, pas par le code.
   * Que la **base** refuse est demontre ailleurs, sans passer par du code a
   * nous : `test/adapters/schema-contraintes.test.ts`, un client `pg` nu. Ce
   * qui se joue ici est la moitie qui reste — l'adapter traduit ce refus-la, et
   * seulement celui-la, en cas nominal.
   */
  describe('idempotence du run quotidien', () => {
    it('recordDecision traduit le refus de la base en ALREADY_RECORDED', async () => {
      const decision = {
        intent: intention(),
        isShadow: false,
        verdict: { status: 'ACCEPTED', orders: [], ignored: [] },
        gitSha: 'abc1234',
        createdAt: CREE_LE,
      } as const;

      const premier = await db.recordDecision(decision);
      const second = await db.recordDecision({ ...decision, gitSha: 'def5678' });

      expect(premier.status).toBe('RECORDED');
      expect(second.status).toBe('ALREADY_RECORDED');

      // Ni doublon, ni ecrasement : la premiere decision est celle qui reste.
      const lignes = await brut.query('SELECT git_sha FROM decisions');
      expect(lignes.rows.map((r: { git_sha: string }) => r.git_sha)).toEqual(['abc1234']);
    });

    it('n’avale pas une erreur d’ecriture qui n’est pas le doublon du jour', async () => {
      // Date impossible : Postgres refuse avec un code qui n'est pas 23505.
      // Le rendre en ALREADY_RECORDED ferait croire au job que sa decision est
      // enregistree alors qu'aucune ligne n'existe.
      const erreur = await db
        .recordDecision({
          intent: intention({ runDate: '2026-13-45' }),
          isShadow: false,
          verdict: { status: 'ACCEPTED', orders: [], ignored: [] },
          gitSha: 'abc1234',
          createdAt: CREE_LE,
        })
        .then(() => undefined)
        .catch((cause: unknown) => cause);

      expect(erreur).toBeDefined();
      expect(codesDe(erreur).some((code) => code.startsWith('22'))).toBe(true);
    });

    it('laisse remonter une violation d’unicite qui n’est pas celle du jour', async () => {
      const insertOrdre = `
        INSERT INTO orders (client_order_id, side, asset, requested_qty, limit_price, status, created_at)
        VALUES ('id-fige', 'BUY', 'BTC', '0.01', '60000', 'PENDING', now())`;
      await brut.query(insertOrdre);
      await expect(brut.query(insertOrdre)).rejects.toMatchObject({
        code: '23505',
        constraint: 'orders_pkey',
      });
    });
  });

  /**
   * E23 et la seconde ligne de defense d'E24, contre la vraie cle primaire :
   * l'ordre est ecrit PENDING, rattache a sa decision, donc a son `run_date`.
   */
  describe('les ordres du run (E23, E24)', () => {
    const ORDRE = {
      clientOrderId: 'ubac-0123456789abcdef0123456789a',
      asset: 'BTC',
      quote: 'USDC',
      side: 'SELL',
      quantity: new Decimal('0.01234567') as Quantity,
      limitPrice: new Decimal('64385.42') as Price,
    } as const;

    async function decision(): Promise<string> {
      const ecrite = await db.recordDecision({
        intent: intention(),
        isShadow: false,
        verdict: { status: 'ACCEPTED', orders: [ORDRE], ignored: [] },
        gitSha: 'abc1234',
        createdAt: CREE_LE,
      });
      if (ecrite.status !== 'RECORDED') throw new Error('decision non ecrite');
      return ecrite.id;
    }

    it('ecrit PENDING, rattache au run, et refuse le meme client_order_id en ALREADY_RECORDED', async () => {
      const decisionId = await decision();
      const entree = { order: ORDRE, decisionId, createdAt: CREE_LE };

      expect(await db.recordOrder(entree)).toEqual({ status: 'RECORDED' });
      expect(await db.recordOrder(entree)).toEqual({ status: 'ALREADY_RECORDED' });

      const lignes = await brut.query(`
        SELECT o.status, o.exchange_id, o.requested_qty, o.limit_price, d.run_date::text AS run_date
        FROM orders o JOIN decisions d ON d.id = o.decision_id`);
      expect(lignes.rows).toEqual([
        {
          status: 'PENDING',
          exchange_id: null,
          requested_qty: '0.01234567',
          limit_price: '64385.42000000',
          run_date: '2026-09-10',
        },
      ]);
    });

    it('pose l’exchange_id d’un ordre place, et REJECTED sur un rejet', async () => {
      const decisionId = await decision();
      const autre = { ...ORDRE, clientOrderId: 'ubac-autre' };
      await db.recordOrder({ order: ORDRE, decisionId, createdAt: CREE_LE });
      await db.recordOrder({ order: autre, decisionId, createdAt: CREE_LE });

      await db.recordPlacement({ kind: 'PLACED', clientOrderId: ORDRE.clientOrderId, exchangeId: 'ex-1' });
      await db.recordPlacement({ kind: 'REJECTED', clientOrderId: autre.clientOrderId });

      const lignes = await brut.query('SELECT client_order_id, status, exchange_id FROM orders ORDER BY client_order_id');
      expect(lignes.rows).toEqual([
        { client_order_id: ORDRE.clientOrderId, status: 'PENDING', exchange_id: 'ex-1' },
        { client_order_id: 'ubac-autre', status: 'REJECTED', exchange_id: null },
      ]);
      // Une issue ne s'ecrit qu'une fois, et jamais sans sa ligne.
      await expect(
        db.recordPlacement({ kind: 'PLACED', clientOrderId: ORDRE.clientOrderId, exchangeId: 'ex-2' }),
      ).rejects.toThrow(DbFrontierError);
      await expect(db.recordPlacement({ kind: 'REJECTED', clientOrderId: 'inconnu' })).rejects.toThrow(
        DbFrontierError,
      );
    });
  });

  /**
   * E32, relu dans la colonne elle-meme : `risk_verdict` ne porte que le code,
   * et avant ce lot `reason` ne portait que le motif de l'intention. Le texte
   * quantifie du refus n'existait que dans l'alerte, qui ne se relit pas.
   */
  describe('le motif d’un refus dans decisions.reason (E32)', () => {
    it('garde le motif de l’intention et y ajoute le refus quantifie', async () => {
      const refus =
        'somme des |jambes| 9000 USDC soit 9.0000 % de 100000, au-dela de 8 %';
      await db.recordDecision({
        intent: intention(),
        isShadow: false,
        verdict: {
          status: 'REJECTED',
          rejections: [{ code: 'REBALANCE_TOO_LARGE', reason: refus }],
        },
        gitSha: 'abc1234',
        createdAt: CREE_LE,
      });

      const ligne = await brut.query('SELECT reason, risk_verdict FROM decisions');
      expect(ligne.rows).toEqual([
        {
          reason: `cash a 23.4 %, sous le bord bas 24 %\nrefus REBALANCE_TOO_LARGE : ${refus}`,
          risk_verdict: 'REJECTED:REBALANCE_TOO_LARGE',
        },
      ]);
    });
  });

  /**
   * Le coeur du lot : ce qui entre en `Decimal` ressort en `Decimal`, a l'unite
   * de la huitieme decimale. Les valeurs choisies ne sont pas representables en
   * double — `12345678901.12345678` vaut `12345678901.123457` en IEEE-754 — donc
   * la moindre conversion en flottant sur le trajet fait echouer ces tests.
   */
  describe('aller-retour des grandeurs', () => {
    const TOTAL = '12345678901.12345678';

    const snapshot = {
      runDate: '2026-09-10',
      totalValueUsdc: new Decimal(TOTAL) as UsdcAmount,
      weights: poids('0.47', '0.296', '0.234'),
      positions: { BTC: new Decimal('0.00000001') as Quantity },
      benchmarks: { hold_btc: new Decimal('1.23456789'), dca: new Decimal('-0.5') },
      createdAt: CREE_LE,
    } as const;

    it('rend exactement ce qui a ete ecrit', async () => {
      await db.recordSnapshot(snapshot);
      const relu = await db.latestSnapshot();

      expect(relu?.runDate).toBe('2026-09-10');
      expect(relu?.totalValueUsdc.toFixed()).toBe(TOTAL);
      expect(relu?.weights.BTC.toFixed()).toBe('0.47');
      expect(relu?.positions['BTC']?.toFixed()).toBe('0.00000001');
      expect(relu?.benchmarks['hold_btc']?.toFixed()).toBe('1.23456789');
      expect(relu?.benchmarks['dca']?.toFixed()).toBe('-0.5');
      expect(relu?.createdAt.toISOString()).toBe(CREE_LE.toISOString());
    });

    it('le driver rend bien le numeric en chaine, jamais en number', async () => {
      await db.recordSnapshot(snapshot);
      const ligne = await brut.query('SELECT total_value_usdc FROM snapshots');
      const valeur: unknown = ligne.rows[0]?.total_value_usdc;

      expect(typeof valeur).toBe('string');
      expect(valeur).toBe('12345678901.12345678');
    });

    it('les grandeurs stockees en jsonb sont des chaines, pas des nombres JSON', async () => {
      await db.recordSnapshot(snapshot);
      await db.recordDecision({
        intent: intention(),
        isShadow: false,
        verdict: { status: 'REJECTED', rejections: [{ code: 'MIN_CASH', reason: 'cash bas' }] },
        gitSha: 'abc1234',
        createdAt: CREE_LE,
      });

      // Le texte brut, pas l'objet deja parse : c'est la representation stockee
      // qu'on interroge. `{"BTC":0.47}` serait un double des la relecture.
      const stocke = await brut.query(
        `SELECT (SELECT weights::text FROM snapshots) AS w,
                (SELECT weights_before::text FROM decisions) AS wb,
                (SELECT legs::text FROM decisions) AS legs,
                (SELECT risk_verdict FROM decisions) AS verdict`,
      );
      const ligne = stocke.rows[0] as { w: string; wb: string; legs: string; verdict: string };

      expect(ligne.w).toContain('"0.47"');
      expect(JSON.parse(ligne.w)).toEqual({ BTC: '0.47', ETH: '0.296', USDC: '0.234' });
      expect(JSON.parse(ligne.wb)).toEqual({ BTC: '0.47', ETH: '0.296', USDC: '0.234' });
      expect(JSON.parse(ligne.legs)).toEqual([
        {
          asset: 'BTC',
          quote: 'USDC',
          side: 'SELL',
          amountUsdc: '1234.56789012',
          limitPrice: '64321.09876543',
        },
      ]);
      expect(ligne.verdict).toBe('REJECTED:MIN_CASH');
    });

    it('refuse a la relecture un jsonb ou un poids est un nombre JSON', async () => {
      await db.recordSnapshot(snapshot);
      // Exactement la forme qu'ecrit le §4 de la spec, et qu'on evite.
      await brut.query(`UPDATE snapshots SET weights = '{"BTC":0.47,"ETH":0.296,"USDC":0.234}'`);

      await expect(db.latestSnapshot()).rejects.toThrow(DbFrontierError);
    });

    it('refuse a la relecture un jsonb qui n’est pas un objet', async () => {
      await db.recordSnapshot(snapshot);
      await brut.query(`UPDATE snapshots SET positions = '[]'::jsonb`);

      await expect(db.latestSnapshot()).rejects.toThrow(DbFrontierError);
    });

    it('la colonne numeric(20,8) refuse ce qu’elle ne peut pas porter', async () => {
      // 21 chiffres avant la virgule : la base tranche, pas un arrondi silencieux.
      // 22003 = numeric_value_out_of_range. Drizzle emballe l'erreur du driver,
      // le code vit dans la cause — c'est la meme chaine que remonte l'adapter
      // pour reconnaitre une violation d'unicite.
      const erreur = await db
        .recordSnapshot({
          ...snapshot,
          runDate: '2026-09-11',
          totalValueUsdc: new Decimal('123456789012345678901') as UsdcAmount,
        })
        .then(() => undefined)
        .catch((cause: unknown) => cause);

      expect(codesDe(erreur)).toContain('22003');
    });

    it('la neuvieme decimale est arrondie par la colonne, pas par nous', async () => {
      // `numeric(20,8)` definit la precision : neuf decimales entrent, huit
      // sortent, arrondies par Postgres. C'est un arrondi decimal exact, pas la
      // troncature approximative d'un binaire.
      await db.recordSnapshot({
        ...snapshot,
        totalValueUsdc: new Decimal('1.123456789') as UsdcAmount,
      });
      expect((await db.latestSnapshot())?.totalValueUsdc.toFixed()).toBe('1.12345679');
    });

    it('la date de run ne derive pas d’un jour au passage', async () => {
      await db.recordSnapshot({ ...snapshot, runDate: '2026-01-01' });
      const ligne = await brut.query(`SELECT run_date::text AS d FROM snapshots`);
      expect(ligne.rows[0]?.d).toBe('2026-01-01');
      expect((await db.latestSnapshot())?.runDate).toBe('2026-01-01');
    });
  });

  describe('lectures du job quotidien', () => {
    it('latestSnapshot rend le plus recent, et rien quand la table est vide', async () => {
      expect(await db.latestSnapshot()).toBeUndefined();

      const base = {
        totalValueUsdc: new Decimal('100') as UsdcAmount,
        weights: poids('0.4', '0.3', '0.3'),
        positions: {},
        benchmarks: {},
        createdAt: CREE_LE,
      };
      await db.recordSnapshot({ ...base, runDate: '2026-09-10' });
      await db.recordSnapshot({ ...base, runDate: '2026-09-08' });

      expect((await db.latestSnapshot())?.runDate).toBe('2026-09-10');
    });

    it('recordSnapshot remplace la photo du jour au lieu de la dupliquer', async () => {
      const base = {
        runDate: '2026-09-10',
        weights: poids('0.4', '0.3', '0.3'),
        positions: {},
        benchmarks: {},
        createdAt: CREE_LE,
      };
      await db.recordSnapshot({ ...base, totalValueUsdc: new Decimal('100') as UsdcAmount });
      await db.recordSnapshot({ ...base, totalValueUsdc: new Decimal('101.5') as UsdcAmount });

      const compte = await brut.query('SELECT count(*)::text AS n FROM snapshots');
      expect(compte.rows[0]?.n).toBe('1');
      expect((await db.latestSnapshot())?.totalValueUsdc.toFixed()).toBe('101.5');
    });

    /**
     * R18 — la serie que le graphe du rapport lit. Elle **ne remplace pas**
     * `latestSnapshot()`, que la reconciliation appelle aussi pour ses positions :
     * les deux coexistent sur la meme table, et les appelants de la seconde sont
     * inchanges.
     */
    it('snapshotSeries rend toutes les photos, de la plus ancienne a la plus recente', async () => {
      expect(await db.snapshotSeries()).toEqual([]);

      const base = {
        totalValueUsdc: new Decimal('100') as UsdcAmount,
        weights: poids('0.4', '0.3', '0.3'),
        positions: { BTC: new Decimal('0.5') as Quantity },
        createdAt: CREE_LE,
      };
      // Ecrites dans le desordre : c'est la requete qui ordonne, pas l'insertion.
      await db.recordSnapshot({ ...base, runDate: '2026-09-10', benchmarks: { portfolio_twr_index: new Decimal('1.20000001') } });
      await db.recordSnapshot({ ...base, runDate: '2026-09-08', benchmarks: { portfolio_twr_index: new Decimal('1.1') } });
      await db.recordSnapshot({ ...base, runDate: '2026-09-09', benchmarks: {} });

      const serie = await db.snapshotSeries();

      expect(serie.map((point) => point.runDate)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10']);
      // La huitieme decimale survit : une conversion en flottant sur le trajet
      // rendrait 1.2000000099999999, et le graphe tracerait un nombre qui n'a
      // jamais ete ecrit.
      expect(serie[2]?.benchmarks['portfolio_twr_index']?.toFixed()).toBe('1.20000001');
      // Une photo sans metrique reste dans la serie : sa colonne sera vide, pas absente.
      expect(serie[1]?.benchmarks).toEqual({});

      // Reduite aux deux colonnes utiles : ni valeur totale, ni poids, ni position.
      expect(Object.keys(serie[0] ?? {}).sort()).toEqual(['benchmarks', 'runDate']);

      // Et `latestSnapshot` rend toujours la sienne, entiere : les deux lectures coexistent.
      const derniere = await db.latestSnapshot();
      expect(derniere?.runDate).toBe('2026-09-10');
      expect(derniere?.totalValueUsdc.toFixed()).toBe('100');
      expect(derniere?.positions['BTC']?.toFixed()).toBe('0.5');
    });

    it('snapshotSeries refuse un jsonb ou une metrique est un nombre JSON', async () => {
      await db.recordSnapshot({
        runDate: '2026-09-10',
        totalValueUsdc: new Decimal('100') as UsdcAmount,
        weights: poids('0.4', '0.3', '0.3'),
        positions: {},
        benchmarks: { portfolio_twr_index: new Decimal('1.2') },
        createdAt: CREE_LE,
      });
      // Exactement la forme que `JSON.parse` produirait sur `{index: 1.2}`, et
      // qu'on evite : un indice passe par un double n'est plus l'indice ecrit.
      await brut.query(`UPDATE snapshots SET benchmarks = '{"portfolio_twr_index":1.2}'`);

      await expect(db.snapshotSeries()).rejects.toThrow(DbFrontierError);
    });

    it('recentCashFlows filtre, ordonne et garde le signe des retraits', async () => {
      await brut.query(`
        INSERT INTO cash_flows (occurred_at, amount_usdc, note) VALUES
          ('2026-08-01T10:00:00Z', '5000.00000000', 'apport'),
          ('2026-09-05T23:30:00Z', '-250.12345678', NULL),
          ('2026-09-09T08:00:00Z', '1000', 'second apport')`);

      const flux = await db.recentCashFlows(new Date('2026-09-01T00:00:00Z'));

      expect(flux.map((f) => f.occurredOn)).toEqual(['2026-09-05', '2026-09-09']);
      expect(flux[0]?.amount.toFixed()).toBe('-250.12345678');
      expect(flux[0]?.note).toBeNull();
      expect(flux[1]?.note).toBe('second apport');
      expect(flux[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('pendingOrders ne rend que les ordres en attente', async () => {
      await brut.query(`
        INSERT INTO orders
          (client_order_id, side, asset, requested_qty, limit_price, status, created_at) VALUES
          ('ubac-2', 'SELL', 'ETH', '2.50000000', '3210.12345678', 'PENDING', '2026-09-10T07:01:00Z'),
          ('ubac-1', 'BUY', 'BTC', '0.01234567', '64321.09876543', 'PENDING', '2026-09-10T07:00:00Z'),
          ('ubac-3', 'BUY', 'BTC', '0.5', '60000', 'FILLED', '2026-09-09T07:00:00Z')`);

      const attente = await db.pendingOrders();

      expect(attente.map((o) => o.clientOrderId)).toEqual(['ubac-1', 'ubac-2']);
      expect(attente[0]?.requestedQty.toFixed()).toBe('0.01234567');
      expect(attente[0]?.limitPrice.toFixed()).toBe('64321.09876543');
      expect(attente[0]?.side).toBe('BUY');
      expect(attente[0]?.decisionId).toBeNull();
    });

    it('refuse un sens d’ordre que le noyau ne connait pas', async () => {
      await brut.query(`
        INSERT INTO orders
          (client_order_id, side, asset, requested_qty, limit_price, status, created_at)
        VALUES ('ubac-4', 'LONG', 'BTC', '1', '60000', 'PENDING', now())`);

      await expect(db.pendingOrders()).rejects.toThrow(DbFrontierError);
    });
  });
});
