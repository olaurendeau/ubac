import { execFile } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { VARIABLES_CONVOYEUR } from '../../src/convoyeur/env.js';

/**
 * Le point d'entree du convoyeur (Y5), **lance comme le runtime le lance** :
 * le motif de `test/jobs/daily-main.test.ts`. Il ne s'importe pas — il lance
 * le passage a l'evaluation —, et le second bloc le tient sur tout le
 * TypeScript du depot, sur le motif d'A22 de `test/jobs/purete.test.ts`, sans
 * toucher a A22.
 *
 * L'environnement du fils est reduit a `PATH` : aucun secret, donc le chargeur
 * refuse avant qu'un port ne s'ouvre, et ces sondes n'ont ni reseau ni base.
 * Elles n'entrent pas dans la couverture (autre processus).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTREE = 'src/convoyeur/main.ts';
const lancer = promisify(execFile);

interface Sortie {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: readonly string[], env: Record<string, string> = {}): Promise<Sortie> {
  try {
    const { stdout, stderr } = await lancer(process.execPath, ['--import', 'tsx', resolve(ROOT, ENTREE), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (erreur) {
    const echec = erreur as { code?: number; stdout?: string; stderr?: string };
    return { code: echec.code ?? -1, stdout: echec.stdout ?? '', stderr: echec.stderr ?? '' };
  }
}

const AT = '--at=2026-10-27T18:00:00Z';
const SHA = '--git-sha=0123456789abcdef0123456789abcdef01234567';

describe('point d’entree du convoyeur', { timeout: 30_000 }, () => {
  // Un fils par test : chacun charge tsx et ccxt, et a son propre delai (`docs/marge-des-delais.md`).
  it.each([
    [[AT, SHA, '--real'], 'argument inconnu : --real'],
    [[AT, SHA, '--reel=oui'], 'argument inconnu : --reel\n'],
    [[AT, SHA, '--dry-run'], 'argument inconnu : --dry-run'],
    [[SHA], '--at manquant ou illisible'],
    [['--at=hier', SHA], '--at manquant ou illisible'],
    [[AT], '--git-sha manquant'],
  ])('refuse %j avant toute ligne de journal', async (args, attendu) => {
    const sortie = await run(args);
    expect(sortie.code).toBe(1);
    expect(sortie.stderr).toContain(attendu);
    expect(sortie.stderr).toContain('usage : node dist/convoyeur/main.js');
    expect(sortie.stdout).toBe('');
    // Seul le nom est cite, jamais ce qui suit le `=`.
    expect(sortie.stderr).not.toContain('oui');
  });

  it('dit le mode en premiere ligne : DRY_RUN par defaut, REEL sur --reel seulement', async () => {
    const defaut = await run([AT, SHA]);
    const reel = await run([AT, SHA, '--reel']);
    expect(defaut.stdout.split('\n')[0]).toMatch(/^mode=DRY_RUN : /);
    expect(reel.stdout.split('\n')[0]).toMatch(/^mode=REEL : /);
    expect(defaut.stdout.split('\n')[1]).toBe(
      'passage du 2026-10-27T18:00:00.000Z, git_sha=0123456789abcdef0123456789abcdef01234567',
    );
  });

  it('CV3 : les secrets d’Ubac ne le demarrent pas, et chaque variable manquante est nommee', async () => {
    const ubac = { DATABASE_URL: 'postgresql://u:motdepasse@hote.test/ubac', COINBASE_API_KEY: 'cle', NTFY_TOKEN: 'jeton' };
    const sortie = await run([AT, SHA], ubac);
    expect(sortie.code).toBe(1);
    for (const nom of VARIABLES_CONVOYEUR) expect(sortie.stderr).toContain(`${nom} : variable requise, absente`);
    expect(sortie.stderr).not.toContain('motdepasse');
  });
});

// --- Rien n'importe le point d'entree : le motif d'A22 ------------------------

const POINT_D_ENTREE = "src/convoyeur/main.ts est un point d'entree : l'importer lance le passage.";
const SPEC = '/(^|\\/)convoyeur\\/main(\\.[jt]s)?$|^\\.\\/main(\\.[jt]s)?$/';
const SELECTEURS = [
  `ImportDeclaration[source.value=${SPEC}]`,
  `ImportExpression[source.value=${SPEC}]`,
  `ExportNamedDeclaration[source.value=${SPEC}]`,
  `ExportAllDeclaration[source.value=${SPEC}]`,
  `TSExternalModuleReference > Literal[value=${SPEC}]`,
];
const GARDIEN = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser as Linter.Parser,
        parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      },
      linterOptions: { noInlineConfig: true },
      rules: { 'no-restricted-syntax': ['error', ...SELECTEURS.map((selector) => ({ selector, message: POINT_D_ENTREE }))] },
    },
  ],
});

/**
 * Une forme par selecteur : A22 de `test/jobs/purete.test.ts` sonde deja les
 * onze formes d'A8 sur ces cinq types de noeud.
 */
function formes(spec: string): readonly string[] {
  return [
    `import type { X } from '${spec}';\nexport type Y = X;`,
    `export const a = await import('${spec}');`,
    `export { main } from '${spec}';`,
    `export * as x from '${spec}';`,
    `import x = require('${spec}');\nexport const a = x;`,
  ];
}

async function messages(code: string, chemin: string): Promise<number> {
  const [resultat] = await GARDIEN.lintText(code, { filePath: resolve(ROOT, chemin) });
  return resultat?.messages.length ?? 0;
}

describe('rien n’importe le point d’entree du convoyeur', () => {
  it('les cinq portes tombent, depuis l’arbre, depuis Ubac et depuis un test', async () => {
    for (const [spec, chemin] of [
      ['./main.js', 'src/convoyeur/sonde.ts'],
      ['../convoyeur/main.js', 'src/jobs/sonde.ts'],
      ['../../src/convoyeur/main.ts', 'test/convoyeur/sonde.test.ts'],
    ] as const) {
      const comptes = await Promise.all(formes(spec).map((code) => messages(code, chemin)));
      expect(comptes, spec).toEqual([1, 1, 1, 1, 1]);
    }
    // Le point d'entree d'Ubac et les modules voisins ne sont pas pris.
    expect(await messages("export * from './daily-main.js';\nexport * from './passage.js';", 'src/jobs/x.ts')).toBe(0);
  });

  it('ni src/, ni test/, ni la racine ne l’importe', { timeout: 30_000 }, async () => {
    const resultats = await GARDIEN.lintFiles(['src/**/*.ts', 'test/**/*.ts', '*.ts']);
    const lus = resultats.map((r) => relative(ROOT, r.filePath));
    expect(lus).toContain(ENTREE);
    expect(lus.some((f) => f.startsWith('test/'))).toBe(true);
    expect(lus.some((f) => !f.includes('/'))).toBe(true);
    expect(resultats.filter((r) => r.messages.length > 0).map((r) => relative(ROOT, r.filePath))).toEqual([]);
  });
});
