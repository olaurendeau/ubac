import { defineConfig } from 'drizzle-kit';

/**
 * Configuration de l'outil de migration. Elle n'est lue que par `drizzle-kit`,
 * lance **depuis le poste** — jamais depuis le job, conformement au §3 de la
 * spec. Le job ouvre une connexion et ecrit des lignes ; il ne modifie aucun
 * schema, et il n'embarque meme pas drizzle-kit, qui est une devDependency.
 *
 * `DATABASE_URL` et pas `UBAC_DEV_DATABASE_URL` : c'est la meme variable que
 * l'execution, donc la meme commande vise la base de developpement ou Neon
 * selon ce qui est pose dans l'environnement. `make db-push` recopie la chaine
 * de developpement dedans (voir docker-compose.yml).
 *
 * La lecture directe de `process.env` est admise ici, contrairement a `src/` :
 * ce fichier est un outil de poste, hors du programme. `src/config/env.ts`
 * reste le seul point de lecture de l'environnement du code qui tourne.
 */
const databaseUrl = process.env['DATABASE_URL'];

if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
  throw new Error(
    'DATABASE_URL : variable requise pour drizzle-kit. Pour la base locale, passer par `make db-push`.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/adapters/schema.ts',
  dbCredentials: { url: databaseUrl },
  /*
   * `push` compare le schema TypeScript a la base vivante et applique la
   * difference : il ne produit aucun fichier de migration a versionner. C'est
   * le mecanisme que la spec retient pour la phase 1. La bascule vers des
   * migrations SQL relues avant application est un sujet de phase 2, discute
   * dans docs/base-de-donnees.md.
   */
});
