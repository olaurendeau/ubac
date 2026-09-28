import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CASH_FLOWS_CONVOYEUR_KEY_CHECK,
  CASH_FLOWS_NATURAL_KEY_INDEX,
  CASH_FLOWS_ORIGIN_CHECK,
  CONVOYEUR_JOURNAL_DAY_INDEX,
  CONVOYEUR_JOURNAL_STEP_CHECK,
  CONVOYEUR_JOURNAL_STEP_INDEX,
  DECISIONS_UNIQUE_INDEX,
} from '../../src/adapters/schema.js';

/** Le code et la contrainte d'une requete refusee, ou `undefined` si elle passe. */
async function refus(
  client: pg.Client,
  requete: string,
  params: readonly unknown[],
): Promise<{ code?: string; constraint?: string } | undefined> {
  return client
    .query(requete, [...params])
    .then(() => undefined)
    .catch((cause: unknown) => cause as { code?: string; constraint?: string });
}

/**
 * Ce que la **base** garantit, éprouvé sur un vrai Postgres et **sans passer
 * par du code à nous**. Un client `pg` nu, du SQL, et rien d'autre : une
 * démonstration qui emprunterait l'adapter ne prouverait que l'adapter.
 *
 * Ces tests sont ignorés tant que `UBAC_TEST_DATABASE_URL` n'est pas posée, ce
 * qui est le cas de `make test` : la base est une dépendance de développement,
 * pas une dépendance de la suite. `make test-db` la pose, après avoir appliqué
 * le schéma.
 *
 * La variable est **volontairement distincte de `DATABASE_URL`**. Si la suite
 * lisait `DATABASE_URL`, un poste où la vraie chaîne est exportée verrait ses
 * tests tronquer des tables de production. Aucune commande de ce dépôt ne pose
 * `UBAC_TEST_DATABASE_URL` ailleurs que sur la base jetable de Compose.
 */
const URL_DE_TEST = process.env['UBAC_TEST_DATABASE_URL'];

describe.skipIf(URL_DE_TEST === undefined)('le schéma appliqué, contre un Postgres réel', () => {
  let brut: pg.Client;

  beforeAll(async () => {
    brut = new pg.Client({ connectionString: URL_DE_TEST ?? '' });
    await brut.connect();
  });

  afterAll(async () => {
    await brut.end();
  });

  beforeEach(async () => {
    await brut.query('TRUNCATE decisions, orders, snapshots, cash_flows, convoyeur_journal');
  });

  /**
   * `make db-push` a appliqué `src/adapters/schema.ts` : les quatre tables du §4
   * existent, et le `TRUNCATE` ci-dessus le vérifie déjà — il échouerait sur une
   * table manquante. Ce qui suit va plus loin et interroge le catalogue : ce
   * sont les **clés** qui portent l'idempotence, pas la seule présence des
   * tables.
   */
  it('les quatre tables du §4 et le journal du convoyeur portent une clé primaire', async () => {
    const cles = await brut.query<{ table_name: string; constraint_name: string }>(`
      SELECT tc.table_name, tc.constraint_name
        FROM information_schema.table_constraints tc
       WHERE tc.table_schema = 'public'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY tc.table_name`);

    expect(cles.rows.map((r) => r.table_name)).toEqual([
      'cash_flows',
      'convoyeur_journal',
      'decisions',
      'orders',
      'snapshots',
    ]);
  });

  /**
   * Le nom de l'index est figé et exporté par `schema.ts` : c'est lui que
   * Postgres renvoie dans le champ `constraint` d'une violation `23505`, et
   * c'est ce que l'adapter reconnaîtra pour distinguer « déjà enregistré » de
   * n'importe quelle autre erreur d'écriture. Le vérifier ici amarre la
   * constante à ce que la base a réellement créé.
   */
  it('l’index unique de decisions porte le nom exporté, sur les trois colonnes', async () => {
    const index = await brut.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'decisions' AND indexname = $1`,
      [DECISIONS_UNIQUE_INDEX],
    );

    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain('UNIQUE');
    expect(index.rows[0]?.indexdef).toMatch(/\(run_date, strategy, is_shadow\)/);
  });

  /**
   * L'idempotence du run quotidien. Un second run le même jour ne peut pas
   * produire une seconde décision, et le refus vient de la base : il n'y a pas
   * de `if` à oublier, pas de fenêtre entre un `select` et un `insert`.
   */
  describe('idempotence du run quotidien', () => {
    const INSERT = `
      INSERT INTO decisions
        (run_date, strategy, is_shadow, trigger, reason,
         weights_before, weights_target, legs, risk_verdict, git_sha, created_at)
      VALUES ($1, $2, $3, 'NONE', 'motif', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
              'ACCEPTED', 'abc1234', now())`;

    it('la base refuse un second (run_date, strategy, is_shadow)', async () => {
      await brut.query(INSERT, ['2026-09-10', 'rebalance', false]);

      const erreur = await brut
        .query(INSERT, ['2026-09-10', 'rebalance', false])
        .then(() => undefined)
        .catch((cause: unknown) => cause as { code?: string; constraint?: string });

      expect(erreur?.code).toBe('23505');
      expect(erreur?.constraint).toBe(DECISIONS_UNIQUE_INDEX);
    });

    it('le même jour reste ouvert à une autre stratégie et au shadow', async () => {
      await brut.query(INSERT, ['2026-09-10', 'rebalance', false]);
      await brut.query(INSERT, ['2026-09-10', 'rebalance', true]);
      await brut.query(INSERT, ['2026-09-10', 'ladder', true]);

      const compte = await brut.query<{ n: string }>('SELECT count(*)::text AS n FROM decisions');
      expect(compte.rows[0]?.n).toBe('3');
    });
  });
  /**
   * DC7 : une ligne du convoyeur est reconnaissable et ne s'ecrit qu'une fois.
   * Le refus vient de la base ; `ALREADY_RECORDED` (Y4a) ne fera que le lire.
   */
  describe('cash_flows : origine et clé naturelle', () => {
    const INSERT = `
      INSERT INTO cash_flows (occurred_at, amount_usdc, origin, natural_key)
      VALUES ('2026-10-27T17:00:05Z', '99.5', $1, $2)`;

    it('une ligne insérée sans origine prend OPERATEUR, sans clé naturelle', async () => {
      await brut.query(`INSERT INTO cash_flows (occurred_at, amount_usdc) VALUES ('2026-09-01T00:00:00Z', '10')`);

      const lignes = await brut.query('SELECT origin, natural_key FROM cash_flows');
      expect(lignes.rows).toEqual([{ origin: 'OPERATEUR', natural_key: null }]);
    });

    it('la base refuse une seconde ligne de même clé naturelle, sur l’index nommé', async () => {
      await brut.query(INSERT, ['CONVOYEUR', 'CONVOYEUR:conv-2026-10-27']);

      const erreur = await refus(brut, INSERT, ['CONVOYEUR', 'CONVOYEUR:conv-2026-10-27']);

      expect(erreur?.code).toBe('23505');
      expect(erreur?.constraint).toBe(CASH_FLOWS_NATURAL_KEY_INDEX);
    });

    it('les saisies de l’opérateur, sans clé, ne se gênent pas', async () => {
      await brut.query(INSERT, ['OPERATEUR', null]);
      await brut.query(INSERT, ['OPERATEUR', null]);

      const compte = await brut.query<{ n: string }>('SELECT count(*)::text AS n FROM cash_flows');
      expect(compte.rows[0]?.n).toBe('2');
    });

    it('la base refuse une ligne CONVOYEUR sans clé naturelle', async () => {
      const erreur = await refus(brut, INSERT, ['CONVOYEUR', null]);

      expect(erreur?.code).toBe('23514');
      expect(erreur?.constraint).toBe(CASH_FLOWS_CONVOYEUR_KEY_CHECK);
    });

    it('la base refuse une origine inconnue', async () => {
      const erreur = await refus(brut, INSERT, ['convoyeur', 'k']);

      expect(erreur?.code).toBe('23514');
      expect(erreur?.constraint).toBe(CASH_FLOWS_ORIGIN_CHECK);
    });
  });

  /** Le journal du convoyeur, en ajout seul : une étape s'écrit une fois, un convoyage s'ouvre une fois par jour. */
  describe('convoyeur_journal', () => {
    const ETAPE = `
      INSERT INTO convoyeur_journal (convoyage, day, step, occurred_at)
      VALUES ($1, $2, $3, '2026-10-27T17:00:00Z')`;

    it('une étape déjà écrite bute sur l’index (convoyage, étape)', async () => {
      await brut.query(ETAPE, ['conv-a', '2026-10-27', 'ACHETE']);

      const erreur = await refus(brut, ETAPE, ['conv-a', '2026-10-27', 'ACHETE']);

      expect(erreur?.code).toBe('23505');
      expect(erreur?.constraint).toBe(CONVOYEUR_JOURNAL_STEP_INDEX);
    });

    it('un second convoyage ouvert le même jour bute sur l’index du jour', async () => {
      await brut.query(ETAPE, ['conv-a', '2026-10-27', 'ACHAT_DEMANDE']);

      const erreur = await refus(brut, ETAPE, ['conv-b', '2026-10-27', 'ACHAT_DEMANDE']);

      expect(erreur?.code).toBe('23505');
      expect(erreur?.constraint).toBe(CONVOYEUR_JOURNAL_DAY_INDEX);
    });

    it('les étapes suivantes et le jour suivant restent ouverts', async () => {
      await brut.query(ETAPE, ['conv-a', '2026-10-27', 'ACHAT_DEMANDE']);
      await brut.query(ETAPE, ['conv-a', '2026-10-27', 'ACHETE']);
      await brut.query(ETAPE, ['conv-a', '2026-10-27', 'TRANSFERT_DEMANDE']);
      await brut.query(ETAPE, ['conv-b', '2026-10-28', 'ACHAT_DEMANDE']);

      const compte = await brut.query<{ n: string }>('SELECT count(*)::text AS n FROM convoyeur_journal');
      expect(compte.rows[0]?.n).toBe('4');
    });

    it('une étape inconnue est refusée', async () => {
      const erreur = await refus(brut, ETAPE, ['conv-a', '2026-10-27', 'VENDU']);

      expect(erreur?.code).toBe('23514');
      expect(erreur?.constraint).toBe(CONVOYEUR_JOURNAL_STEP_CHECK);
    });
  });
});
