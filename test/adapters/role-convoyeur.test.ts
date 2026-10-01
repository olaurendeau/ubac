import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CASH_FLOWS_NATURAL_KEY_INDEX } from '../../src/adapters/schema.js';

/**
 * CV19 : le rôle du convoyeur, créé par `scripts/role-convoyeur.sql` et
 * éprouvé par `SET ROLE` contre le Postgres local, où `ubac_dev` est
 * superutilisateur. Le rôle n'a pas de mot de passe et n'en a pas besoin ici.
 *
 * Ignoré hors de `make test-db`, comme les autres tests de base : c'est
 * `make test-db` qui tient cette défense, pas la chaîne (D2 de la phase 2).
 */
const URL_DE_TEST = process.env['UBAC_TEST_DATABASE_URL'];

const ROLE = 'ubac_convoyeur';

/**
 * Le script tel que l'opérateur le rejoue, moins ses méta-commandes psql
 * (`\set`), que le protocole simple de `pg` ne connaît pas.
 */
const SCRIPT = readFileSync(new URL('../../scripts/role-convoyeur.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((ligne) => !ligne.startsWith('\\'))
  .join('\n');

/** Ce que le rôle a le droit de tenir, et rien d'autre (Q9). */
const LISTE_BLANCHE: ReadonlySet<string> = new Set([
  'cash_flows:INSERT',
  'convoyeur_journal:SELECT',
  'convoyeur_journal:INSERT',
]);

const DROITS_DE_TABLE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const DROITS_DE_SEQUENCE = ['USAGE', 'SELECT', 'UPDATE'];

const LIGNE_CONVOYEUR = `
  INSERT INTO cash_flows (occurred_at, amount_usdc, note, origin, natural_key)
  VALUES ('2026-10-27T17:00:05Z', '99.5', 'convoyage', 'CONVOYEUR', $1)`;

const ETAPE = `
  INSERT INTO convoyeur_journal (convoyage, day, step, occurred_at)
  VALUES ('conv-2026-10-27', '2026-10-27', $1, '2026-10-27T17:00:00Z')`;

describe.skipIf(URL_DE_TEST === undefined)('CV19 — le rôle du convoyeur, contre un Postgres réel', () => {
  let brut: pg.Client;

  /** Une requête sous le rôle du convoyeur ; rend le code SQLSTATE, ou `OK`. */
  async function commeConvoyeur(requete: string, params: readonly unknown[] = []): Promise<string> {
    await brut.query('BEGIN');
    try {
      await brut.query(`SET LOCAL ROLE ${ROLE}`);
      await brut.query(requete, [...params]);
      await brut.query('COMMIT');
      return 'OK';
    } catch (cause) {
      await brut.query('ROLLBACK');
      return (cause as { code?: string }).code ?? 'SANS_CODE';
    }
  }

  /** Chaque droit que le rôle tient sur le schéma `public`, sous la forme `objet:droit`. */
  async function inventaire(): Promise<readonly string[]> {
    const tables = await brut.query<{ nom: string; genre: string }>(`
      SELECT c.relname AS nom, c.relkind::text AS genre
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`);
    const tenus: string[] = [];
    for (const { nom, genre } of tables.rows) {
      const droits = genre === 'S' ? DROITS_DE_SEQUENCE : DROITS_DE_TABLE;
      const fonction = genre === 'S' ? 'has_sequence_privilege' : 'has_table_privilege';
      for (const droit of droits) {
        const r = await brut.query<{ ok: boolean }>(`SELECT ${fonction}($1, $2, $3) AS ok`, [
          ROLE,
          `public.${nom}`,
          droit,
        ]);
        if (r.rows[0]?.ok === true) tenus.push(`${nom}:${droit}`);
      }
    }
    const fonctions = await brut.query<{ nom: string }>(`
      SELECT p.oid::regprocedure::text AS nom
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'`);
    for (const { nom } of fonctions.rows) {
      const r = await brut.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2, $3) AS ok', [
        ROLE,
        nom,
        'EXECUTE',
      ]);
      if (r.rows[0]?.ok === true) tenus.push(`${nom}:EXECUTE`);
    }
    return tenus.sort();
  }

  /**
   * La base locale garde l'etat du rejeu precedent : sans ce retour aux
   * defauts de Postgres (et au pire de ce que `PUBLIC` peut tenir), un script
   * ampute d'un `REVOKE` passerait sur les restes de sa version complete.
   */
  async function ouvrirAPublic(): Promise<void> {
    await brut.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    await brut.query(`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$`);
    await brut.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC');
  }

  beforeAll(async () => {
    brut = new pg.Client({ connectionString: URL_DE_TEST ?? '' });
    await brut.connect();
    await ouvrirAPublic();
    await brut.query(SCRIPT);
  });

  afterAll(async () => {
    await brut.end();
  });

  beforeEach(async () => {
    await brut.query('TRUNCATE cash_flows, convoyeur_journal');
  });

  afterEach(async () => {
    await brut.query('DROP FUNCTION IF EXISTS ubac_sonde_avant(), ubac_sonde_apres()');
    await brut.query('DROP SEQUENCE IF EXISTS ubac_sonde_sequence');
    // Ne sert que si un script ampute laissait passer le CREATE TABLE du rôle.
    await brut.query('DROP TABLE IF EXISTS public.ubac_sonde');
    await brut.query('REVOKE ALL ON decisions FROM PUBLIC');
  });

  describe('cash_flows : insérer, et rien d’autre', () => {
    it('une ligne CONVOYEUR est acceptée, sans RETURNING ni SELECT', async () => {
      expect(await commeConvoyeur(LIGNE_CONVOYEUR, ['CONVOYEUR:conv-2026-10-27'])).toBe('OK');

      const lignes = await brut.query<{ origin: string }>('SELECT origin FROM cash_flows');
      expect(lignes.rows).toEqual([{ origin: 'CONVOYEUR' }]);
    });

    it('le doublon de clé naturelle rend 23505 sur l’index nommé, pas un refus de droit', async () => {
      await commeConvoyeur(LIGNE_CONVOYEUR, ['CONVOYEUR:conv-2026-10-27']);

      await brut.query('BEGIN');
      await brut.query(`SET LOCAL ROLE ${ROLE}`);
      const erreur = await brut
        .query(LIGNE_CONVOYEUR, ['CONVOYEUR:conv-2026-10-27'])
        .then(() => undefined)
        .catch((cause: unknown) => cause as { code?: string; constraint?: string });
      await brut.query('ROLLBACK');

      expect(erreur?.code).toBe('23505');
      expect(erreur?.constraint).toBe(CASH_FLOWS_NATURAL_KEY_INDEX);
    });

    it.each([
      ['UPDATE', `UPDATE cash_flows SET note = 'x'`],
      ['DELETE', 'DELETE FROM cash_flows'],
      ['SELECT', 'SELECT * FROM cash_flows'],
      ['TRUNCATE', 'TRUNCATE cash_flows'],
    ])('%s sur cash_flows est refusé (42501)', async (_, requete) => {
      expect(await commeConvoyeur(requete)).toBe('42501');
    });
  });

  describe('decisions, snapshots, orders : ni lecture, ni écriture', () => {
    const cas = ['decisions', 'snapshots', 'orders'].flatMap((table) => [
      [table, 'SELECT', `SELECT * FROM ${table}`],
      [table, 'INSERT', `INSERT INTO ${table} DEFAULT VALUES`],
      [table, 'UPDATE', `UPDATE ${table} SET created_at = now()`],
      [table, 'DELETE', `DELETE FROM ${table}`],
    ]);

    it.each(cas)('%s : %s refusé (42501)', async (_, __, requete) => {
      expect(await commeConvoyeur(requete)).toBe('42501');
    });
  });

  describe('le journal : lire et ajouter, jamais réécrire', () => {
    it('SELECT et INSERT sont acceptés', async () => {
      expect(await commeConvoyeur(ETAPE, ['ACHAT_DEMANDE'])).toBe('OK');
      expect(await commeConvoyeur('SELECT step FROM convoyeur_journal')).toBe('OK');
    });

    it.each([
      ['UPDATE', `UPDATE convoyeur_journal SET reason = 'x'`],
      ['DELETE', 'DELETE FROM convoyeur_journal'],
    ])('%s est refusé (42501)', async (_, requete) => {
      expect(await commeConvoyeur(requete)).toBe('42501');
    });
  });

  describe('rien à créer', () => {
    it('CREATE TABLE dans public est refusé', async () => {
      expect(await commeConvoyeur('CREATE TABLE public.ubac_sonde (x int)')).toBe('42501');
    });

    it('CREATE TEMP TABLE est refusé', async () => {
      expect(await commeConvoyeur('CREATE TEMP TABLE ubac_sonde (x int)')).toBe('42501');
    });

    it('le schéma : USAGE seul ; la base : CONNECT, pas TEMP', async () => {
      const r = await brut.query<Record<string, boolean>>(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS usage,
                has_schema_privilege($1, 'public', 'CREATE') AS creer,
                has_database_privilege($1, current_database(), 'CONNECT') AS connecter,
                has_database_privilege($1, current_database(), 'TEMP') AS temp`,
        [ROLE],
      );
      expect(r.rows[0]).toEqual({ usage: true, creer: false, connecter: true, temp: false });
    });
  });

  describe('inventaire exhaustif', () => {
    /**
     * Ce que `PUBLIC` tiendrait est posé avant le script : une table ouverte en
     * lecture, une séquence, une fonction (Postgres accorde `EXECUTE` à
     * `PUBLIC` sur toute fonction neuve). L'inventaire n'est donc pas vide par
     * construction : il ne l'est que parce que le script a tout retiré.
     */
    it('le rôle ne tient rien hors de la liste blanche, même ce que PUBLIC avait reçu', async () => {
      await brut.query('GRANT SELECT ON decisions TO PUBLIC');
      await brut.query('CREATE SEQUENCE ubac_sonde_sequence');
      await brut.query('GRANT USAGE ON SEQUENCE ubac_sonde_sequence TO PUBLIC');
      await brut.query('CREATE FUNCTION ubac_sonde_avant() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      await brut.query('GRANT EXECUTE ON FUNCTION ubac_sonde_avant() TO PUBLIC');
      expect(await inventaire()).toEqual(
        expect.arrayContaining(['decisions:SELECT', 'ubac_sonde_sequence:USAGE', 'ubac_sonde_avant():EXECUTE']),
      );

      await brut.query(SCRIPT);

      expect(await inventaire()).toEqual([...LISTE_BLANCHE].sort());
    });

    it('une fonction créée après le script n’est pas exécutable par le rôle', async () => {
      await ouvrirAPublic();
      await brut.query(SCRIPT);
      await brut.query('CREATE FUNCTION ubac_sonde_apres() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');

      const r = await brut.query<{ ok: boolean }>(
        `SELECT has_function_privilege($1, 'ubac_sonde_apres()', 'EXECUTE') AS ok`,
        [ROLE],
      );
      expect(r.rows[0]?.ok).toBe(false);
      expect(await commeConvoyeur('SELECT ubac_sonde_apres()')).toBe('42501');
    });
  });

  describe('le script', () => {
    /** Les droits de tout ce que le script touche : tables, schéma, base, défauts. */
    async function acl(): Promise<unknown> {
      const r = await brut.query(`
        SELECT (SELECT json_agg(json_build_object(relname, relacl::text) ORDER BY relname)
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables,
               (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS schema,
               (SELECT datacl::text FROM pg_database WHERE datname = current_database()) AS base,
               (SELECT json_agg(defaclacl::text ORDER BY defaclobjtype) FROM pg_default_acl) AS defauts`);
      return r.rows[0];
    }

    it('rejoué, ne change rien', async () => {
      await brut.query(SCRIPT);
      const premier = await acl();
      await brut.query(SCRIPT);

      expect(await acl()).toEqual(premier);
    });

    it('le propriétaire des tables garde ses droits', async () => {
      const r = await brut.query<{ table: string; ok: boolean }>(`
        SELECT tablename AS table,
               has_table_privilege(tableowner, 'public.' || tablename, 'SELECT, INSERT, UPDATE, DELETE') AS ok
          FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);

      expect(r.rows.map((l) => l.table)).toEqual([
        'cash_flows',
        'convoyeur_journal',
        'decisions',
        'orders',
        'snapshots',
      ]);
      expect(r.rows.every((l) => l.ok)).toBe(true);
    });
  });
});
