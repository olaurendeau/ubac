-- Rôle Neon du convoyeur (Q9, CV19) : INSERT sur cash_flows, SELECT et INSERT
-- sur son journal, rien d'autre. Voir docs/base-de-donnees.md, section 5.
--
-- Idempotent : se rejoue après CHAQUE `drizzle-kit push` qui touche
-- cash_flows ou convoyeur_journal. Les droits ne sont pas dans le schéma
-- Drizzle, et un push qui recrée une table les efface.
--
-- Aucun mot de passe ici : il se pose depuis le poste, par `\password
-- ubac_convoyeur` dans psql, et ne passe jamais par le dépôt.
--
-- À lancer par le propriétaire des tables (le rôle d'Ubac, celui qui pousse
-- le schéma) : `ALTER DEFAULT PRIVILEGES FOR ROLE` exige d'en être membre.
-- Les REVOKE ... FROM PUBLIC valent pour toute la base : le propriétaire garde
-- ses droits de propriétaire, qu'ils ne touchent pas.

\set ON_ERROR_STOP on

BEGIN;

-- Le rôle, créé s'il n'existe pas. LOGIN sans mot de passe : il ne peut pas
-- se connecter tant que l'opérateur n'en a pas posé un. Attributs par défaut
-- (NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS) : aucun n'est rejoué,
-- car les modifier exige des droits que le propriétaire n'a pas sur Neon.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ubac_convoyeur') THEN
    CREATE ROLE ubac_convoyeur LOGIN;
  END IF;
END
$$;

-- Ce que PUBLIC donne à tout rôle, retiré. Chaque ligne est rejouée même quand
-- c'est déjà le défaut, pour ne pas en dépendre.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Ce qu'un push futur créerait. Forme globale, sans IN SCHEMA : Postgres
-- accorde EXECUTE à PUBLIC sur toute fonction neuve par un défaut GLOBAL, et
-- un défaut par schéma ne peut que s'y ajouter, jamais le retirer.
DO $$
DECLARE
  proprietaire text;
BEGIN
  SELECT tableowner INTO STRICT proprietaire
    FROM pg_tables WHERE schemaname = 'public' AND tablename = 'cash_flows';
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC', proprietaire);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC', proprietaire);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', proprietaire);
END
$$;

-- TEMPORARY retiré à PUBLIC. CONNECT reste à PUBLIC : il n'ouvre aucune donnée,
-- et le retirer risquerait de couper des rôles de Neon que le dépôt ne connaît
-- pas. Il est accordé nommément au rôle pour ne pas en dépendre.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ubac_convoyeur', current_database());
END
$$;

-- Ce que le rôle tient, nommément. Un REVOKE ALL d'abord : un droit accordé à
-- la main entre deux rejeux ne survit pas au script.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ubac_convoyeur;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ubac_convoyeur;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ubac_convoyeur;
REVOKE CREATE ON SCHEMA public FROM ubac_convoyeur;
GRANT USAGE ON SCHEMA public TO ubac_convoyeur;
GRANT INSERT ON cash_flows TO ubac_convoyeur;
GRANT SELECT, INSERT ON convoyeur_journal TO ubac_convoyeur;

COMMIT;
