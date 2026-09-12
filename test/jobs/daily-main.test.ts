import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

/**
 * Le point d'entree du run quotidien, **lance comme le runtime le lance**.
 *
 * Ce fichier ne peut pas importer `src/jobs/daily-main.ts`, et c'est voulu :
 * l'affirmation A22 de `purete.test.ts` refuse que quoi que ce soit l'importe,
 * parce que ce module appelle son `main` a l'evaluation — un `import` ne
 * chargerait pas seulement `ccxt` et `pg`, il lancerait le run. La seule facon de
 * l'eprouver est donc celle dont il est fait pour etre employe : un processus, des
 * arguments, un code de sortie. `test/replay/report.test.ts` fait deja tourner
 * `src/replay/report.ts` ainsi pour C30.
 *
 * Consequence directe : **ces sondes n'apparaissent pas dans la couverture**.
 * Le fils est un autre processus, que l'instrumentation v8 du parent ne voit pas.
 * `src/jobs/daily-main.ts` est donc a 0 % dans le rapport alors que son contrat
 * d'arguments est bien eprouve ici. Le dire vaut mieux que de deplacer le code
 * pour faire monter un chiffre.
 *
 * ## Aucun reseau, et pas par accident
 *
 * L'environnement du fils est **fabrique ici**, reduit a `PATH`. Aucun secret
 * n'y figure, donc `loadConfig()` refuse avant qu'aucun adapter n'ouvre quoi que
 * ce soit. Recopier `process.env` aurait rendu ces tests dependants du poste :
 * sur une machine ou `DATABASE_URL` et les cles Coinbase sont posees, le
 * quatrieme cas aurait ouvert une connexion et appele l'API.
 *
 * C'est aussi ce que ce quatrieme cas etablit : la configuration entre par
 * `src/config/env.ts`, et par lui seul. Le message attendu est celui de
 * `ConfigError`, qui nomme la variable **sans jamais citer sa valeur**.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTREE = resolve(ROOT, 'src/jobs/daily-main.ts');

const lancer = promisify(execFile);

interface Sortie {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Le point d'entree, avec ses arguments et rien d'autre dans l'environnement.
 * `execFile` rejette sur un code de sortie non nul ; les deux branches portent
 * la meme forme, pour que l'assertion parle du code et pas de la branche.
 */
async function run(...args: readonly string[]): Promise<Sortie> {
  const options = {
    cwd: ROOT,
    encoding: 'utf8' as const,
    // Ni secret, ni horloge, ni rien d'autre du poste : voir l'entete.
    env: { PATH: process.env.PATH ?? '' },
  };
  try {
    const { stdout, stderr } = await lancer(
      process.execPath,
      ['--import', 'tsx', ENTREE, ...args],
      options,
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const echec = error as { code?: number; stdout?: string; stderr?: string };
    return { code: echec.code ?? -1, stdout: echec.stdout ?? '', stderr: echec.stderr ?? '' };
  }
}

const JOUR = '2026-09-11';
const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * Delai cible pose sur le bloc, a 30 s comme les deux blocs de rejeu : chaque
 * sonde demarre un Node qui charge `tsx`, `ccxt` et `pg`, ce qu'aucun autre test
 * de la suite ne fait. Les sondes d'un meme test partent ensemble, donc le mur
 * est celui de la plus lente et non leur somme. Voir `docs/marge-des-delais.md` :
 * le delai global reste a 5 s, et ne doit pas bouger.
 */
describe('point d’entree du run quotidien', { timeout: 30_000 }, () => {
  it('refuse de tourner sans date de run, sans SHA, ou sur un instant illisible', async () => {
    const [sansRien, sansSha, mauvaisAt] = await Promise.all([
      run(),
      run(`--run-date=${JOUR}`),
      run(`--run-date=${JOUR}`, `--git-sha=${SHA}`, '--at=hier'),
    ]);

    for (const [nom, sortie, attendu] of [
      ['sans rien', sansRien, '--run-date manquant ou mal forme'],
      ['sans sha', sansSha, '--git-sha manquant'],
      ['instant illisible', mauvaisAt, '--at illisible'],
    ] as const) {
      expect(sortie.code, nom).toBe(1);
      expect(sortie.stderr, nom).toContain(attendu);
      // L'usage suit le motif, pour que l'operateur n'ait pas a le chercher.
      expect(sortie.stderr, nom).toContain('usage : tsx src/jobs/daily-main.ts');
      // Rien sur stdout : le journal du run n'a pas commence.
      expect(sortie.stdout, nom).toBe('');
    }
  });

  /*
   * La derniere occurrence gagne, et c'est ce qui fait que `npm run daily --
   * --run-date=2026-09-01` remplace le defaut du script sans que l'ordre des
   * arguments ait a etre devine — npm ajoute les arguments de l'operateur apres
   * ceux du script.
   *
   * La sonde est indirecte a dessein : si la premiere occurrence gagnait, le
   * message serait celui de `--run-date`. Qu'il soit celui de `--git-sha` dit
   * que la seconde a ete retenue, sans avoir a faire tourner un run pour le voir.
   */
  it('retient la derniere occurrence d’une option, et traite une valeur vide comme absente', async () => {
    const [derniereGagne, videVautAbsent] = await Promise.all([
      run('--run-date=pasunedate', `--run-date=${JOUR}`),
      run(`--run-date=${JOUR}`, '--git-sha='),
    ]);

    expect(derniereGagne.code).toBe(1);
    expect(derniereGagne.stderr).toContain('--git-sha manquant');
    expect(derniereGagne.stderr).not.toContain('--run-date manquant');

    expect(videVautAbsent.code).toBe(1);
    expect(videVautAbsent.stderr).toContain('--git-sha manquant');
  });

  /*
   * Arguments valides, environnement vide : le programme va jusqu'a la
   * configuration et s'arrete la. C'est la sonde qui etablit que la
   * configuration entre par `src/config/env.ts` — le message est celui de
   * `ConfigError`, avec les six variables nommees et aucune valeur citee — et
   * qu'aucun adapter n'ouvre quoi que ce soit avant elle : ni base, ni cle, ni
   * reseau.
   */
  it('lit la configuration par src/config/env.ts, qui refuse un environnement vide', async () => {
    const sortie = await run(`--run-date=${JOUR}`, `--git-sha=${SHA}`);

    expect(sortie.code).toBe(1);
    expect(sortie.stderr).toContain('configuration invalide');
    for (const variable of [
      'DATABASE_URL',
      'COINBASE_API_KEY',
      'COINBASE_API_SECRET',
      'BREVO_API_KEY',
      'NTFY_TOKEN',
      'HEALTHCHECK_URL',
    ]) {
      expect(sortie.stderr, variable).toContain(variable);
    }
    expect(sortie.stdout).toBe('');
  });
});
