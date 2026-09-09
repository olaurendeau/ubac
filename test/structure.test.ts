import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(ROOT, 'test/lint/fixtures');

// errorOnUnmatchedPattern: src/ n'existe pas avant E3, et un glob vide ne doit
// pas etre une erreur ici — c'est l'etat nominal de la phase 0 a ce stade.
const eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: false });

/**
 * Les fixtures vivent dans test/, mais les regles de purete sont volontairement
 * restreintes au glob src/core/**. On les lint donc sous un chemin virtuel : le
 * contenu vient du disque, la resolution de config se fait comme si le fichier
 * etait dans core. C'est ce qui evite d'avoir a sortir les fixtures de tsconfig.
 */
async function lintAsCore(fixture: string): Promise<ESLint.LintResult> {
  const code = await readFile(resolve(FIXTURES, `${fixture}.fixture`), 'utf8');
  const [result] = await eslint.lintText(code, {
    filePath: resolve(ROOT, `src/core/${fixture}.ts`),
  });
  if (result === undefined) throw new Error(`aucun resultat de lint pour ${fixture}`);
  return result;
}

function ruleIds(result: ESLint.LintResult): string[] {
  return result.messages.map((m) => m.ruleId ?? '(fatal)').sort();
}

describe('C1 — core n’importe ni adapters/, ni jobs/, ni module d’IO', () => {
  it('refuse un import qui franchit la frontiere de couche', async () => {
    const result = await lintAsCore('bad-cross-layer-import');
    expect(ruleIds(result)).toEqual(['no-restricted-imports', 'no-restricted-imports']);
  });

  it('refuse les imports nus hors liste blanche, builtins Node compris', async () => {
    const result = await lintAsCore('bad-io-import');
    expect(ruleIds(result)).toEqual([
      'no-restricted-syntax',
      'no-restricted-syntax',
      'no-restricted-syntax',
    ]);
  });
});

describe('C2 — core ne lit ni l’horloge systeme ni l’aleatoire', () => {
  it('refuse Date.now(), new Date() sans argument et Math.random()', async () => {
    const result = await lintAsCore('bad-clock');
    expect(ruleIds(result)).toEqual([
      'no-restricted-syntax',
      'no-restricted-syntax',
      'no-restricted-syntax',
    ]);
  });
});

describe('les regles ne se declenchent pas a tort', () => {
  it('accepte un module core conforme', async () => {
    const result = await lintAsCore('good-core-module');
    expect(result.messages).toEqual([]);
  });

  it('laisse passer hors de core ce qui est interdit dedans', async () => {
    // Meme code fautif, mais hors du glob src/core/**. Sans ce test, une regle
    // appliquee au depot entier passerait inapercue jusqu'a casser E22.
    const code = await readFile(resolve(FIXTURES, 'bad-clock.fixture'), 'utf8');
    const [result] = await eslint.lintText(code, {
      filePath: resolve(ROOT, 'src/replay/engine.ts'),
    });
    expect(result?.messages).toEqual([]);
  });
});

describe('C32 — aucun adapter ni job en phase 0', () => {
  it.each(['src/adapters', 'src/jobs'])('%s n’existe pas', (dir) => {
    expect(existsSync(resolve(ROOT, dir))).toBe(false);
  });
});

describe('les regles s’appliquent a l’arbre reel', () => {
  let results: ESLint.LintResult[];

  beforeAll(async () => {
    // Vide tant que E3 n'a pas livre src/. Devient un verrou reel des le premier
    // module de core, sans qu'aucune etape ulterieure ait a y penser.
    results = await eslint.lintFiles(['src/**/*.ts']);
  });

  it('ne remonte aucune erreur sur src/', () => {
    const errors = results.flatMap((r) =>
      r.messages.map((m) => `${r.filePath}: ${m.ruleId ?? 'fatal'} — ${m.message}`),
    );
    expect(errors).toEqual([]);
  });
});
