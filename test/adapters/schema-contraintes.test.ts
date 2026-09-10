import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DECISIONS_UNIQUE_INDEX } from '../../src/adapters/schema.js';

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
    await brut.query('TRUNCATE decisions, orders, snapshots, cash_flows');
  });

  /**
   * `make db-push` a appliqué `src/adapters/schema.ts` : les quatre tables du §4
   * existent, et le `TRUNCATE` ci-dessus le vérifie déjà — il échouerait sur une
   * table manquante. Ce qui suit va plus loin et interroge le catalogue : ce
   * sont les **clés** qui portent l'idempotence, pas la seule présence des
   * tables.
   */
  it('les quatre tables portent les clés du §4', async () => {
    const cles = await brut.query<{ table_name: string; constraint_name: string }>(`
      SELECT tc.table_name, tc.constraint_name
        FROM information_schema.table_constraints tc
       WHERE tc.table_schema = 'public'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY tc.table_name`);

    expect(cles.rows.map((r) => r.table_name)).toEqual([
      'cash_flows',
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
});
