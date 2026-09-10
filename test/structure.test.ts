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

const BAD_FIXTURES = [
  'bad-cross-layer-import',
  'bad-io-import',
  'bad-module-escape',
  'bad-crypto-random',
  'bad-clock',
  'bad-global-io',
];

// Doit lister exactement les noms de CORE_FORBIDDEN_GLOBALS dans eslint.config.js.
// La config est en .js et hors tsconfig : elle ne peut pas etre importee ici sans
// casser le typecheck, donc la liste est recopiee et ce test la verrouille.
const FORBIDDEN_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'crypto',
  'performance',
  'globalThis',
  'console',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'require',
];

/**
 * Les fixtures vivent dans test/, mais les regles de purete sont volontairement
 * restreintes au glob src/core/**. On les lint donc sous un chemin virtuel : le
 * contenu vient du disque, la resolution de config se fait comme si le fichier
 * etait dans core. C'est ce qui evite d'avoir a sortir les fixtures de tsconfig.
 */
async function lintCode(code: string, virtualPath: string): Promise<ESLint.LintResult> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, virtualPath) });
  if (result === undefined) throw new Error(`aucun resultat de lint pour ${virtualPath}`);
  return result;
}

async function lintAs(fixture: string, virtualPath: string): Promise<ESLint.LintResult> {
  return lintCode(await readFile(resolve(FIXTURES, `${fixture}.fixture`), 'utf8'), virtualPath);
}

function lintAsCore(fixture: string): Promise<ESLint.LintResult> {
  return lintAs(fixture, `src/core/${fixture}.ts`);
}

function ruleCounts(result: ESLint.LintResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of result.messages) {
    const rule = message.ruleId ?? '(fatal)';
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

/**
 * `ruleCounts` compte tout, y compris les messages sans regle qu'ESLint emet
 * pour signaler une directive inline sans effet. Quand c'est justement l'effet
 * de `noInlineConfig` qu'on mesure, seule compte la regle nommee.
 */
function errorCount(result: ESLint.LintResult, ruleId: string): number {
  return result.messages.filter((m) => m.ruleId === ruleId && m.severity === 2).length;
}

/** Messages lisibles : un echec doit dire quel fichier et quelle regle. */
function messageLines(results: readonly ESLint.LintResult[]): string[] {
  return results.flatMap((r) =>
    r.messages.map((m) => `${r.filePath}: ${m.ruleId ?? 'fatal'} — ${m.message}`),
  );
}

describe('C1 — core n’importe ni adapters/, ni jobs/, ni module d’IO', () => {
  it('refuse un import qui franchit la frontiere de couche', async () => {
    const result = await lintAsCore('bad-cross-layer-import');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-imports': 2 });
  });

  it('refuse les imports nus hors liste blanche, builtins Node compris', async () => {
    const result = await lintAsCore('bad-io-import');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-syntax': 3 });
  });

  it('refuse les formes qui font entrer un module sans ImportDeclaration', async () => {
    // import = require, export *, export ... from, et import() dynamique.
    const result = await lintAsCore('bad-module-escape');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-syntax': 4, 'no-restricted-imports': 1 });
  });
});

describe('C2 — core ne lit ni l’horloge systeme ni l’aleatoire', () => {
  it('refuse Date.now(), new Date() sans argument, Math.random() et leurs acces calcules', async () => {
    const result = await lintAsCore('bad-clock');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-syntax': 5 });
  });

  it('refuse l’aleatoire de node:crypto, dont seul createHash est autorise', async () => {
    const result = await lintAsCore('bad-crypto-random');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-imports': 1 });
  });
});

describe('C1 et C2 — les globales, qui ne passent par aucun import', () => {
  it('refuse un module qui lit env, horloge, aleatoire et reseau sans rien importer', async () => {
    const result = await lintAsCore('bad-global-io');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-globals': 6 });
  });

  // Une liste blanche d'imports est aveugle a ces noms : ils sont deja dans la
  // portee globale. Un par un, sinon une entree ajoutee a la config sans effet
  // reel passerait inapercue.
  it.each(FORBIDDEN_GLOBALS)('refuse la globale %s', async (name) => {
    const result = await lintCode(`export const echappatoire = ${name};`, 'src/core/probe.ts');
    expect(ruleCounts(result)).toEqual({ 'no-restricted-globals': 1 });
  });
});

describe('les regles ne se declenchent pas a tort', () => {
  it('accepte un module core conforme', async () => {
    const result = await lintAsCore('good-core-module');
    expect(result.messages).toEqual([]);
  });

  // Meme code fautif, mais hors du glob src/core/**. Sans ce test, une regle
  // appliquee au depot entier passerait inapercue jusqu'a casser E22.
  it.each(BAD_FIXTURES)('laisse passer %s hors de core', async (fixture) => {
    const result = await lintAs(fixture, 'src/replay/engine.ts');
    expect(result.messages).toEqual([]);
  });
});

/**
 * C32, phase 0 : « src/adapters et src/jobs n'existent pas ». La phase 1 fait
 * entrer ces deux repertoires, donc la garantie ne peut plus porter sur
 * l'arborescence. Elle se deplace sur les **appels** : les repertoires existent,
 * et aucun chemin d'execution ne place, n'annule ni ne retire.
 *
 * Le controle est un controle de noms, pas une preuve. `docs/phase-1-frontieres.md`
 * dit ce qu'il laisse passer. Le remplacer par un test de presence de fichier
 * aurait donne un garde-fou qui ne garantit rien du tout.
 */
describe("C32 (phase 1) — adapters/ et jobs/ existent, mais rien n'y passe d'ordre", () => {
  it.each(['src/adapters/coinbase.ts', 'src/jobs/daily.ts'])(
    'refuse placement, annulation et retrait dans %s',
    async (virtualPath) => {
      const result = await lintAs('bad-order-write', virtualPath);
      // Cinq formes distinctes dans la fixture : appel de methode, reference
      // sans appel, acces calcule par chaine, nom snake_case, retrait.
      expect(ruleCounts(result)).toEqual({ 'no-restricted-syntax': 5 });
    },
  );

  // Un garde-fou qu'on eteint depuis le fichier qu'il surveille n'en est pas un.
  it('ne se laisse pas desarmer par un commentaire eslint-disable', async () => {
    const result = await lintAs('bad-order-write-disabled', 'src/adapters/coinbase.ts');
    expect(errorCount(result, 'no-restricted-syntax')).toBeGreaterThan(0);
  });

  it('laisse ecrire un adapter de lecture', async () => {
    const result = await lintAs('good-adapter-module', 'src/adapters/coinbase.ts');
    expect(result.messages).toEqual([]);
  });

  // Le rejeu manipule legitimement des ordres simules : la regle est restreinte
  // aux deux couches qui touchent l'exterieur, et ce test le verrouille.
  it('n’applique pas la regle hors adapters/ et jobs/', async () => {
    const result = await lintAs('bad-order-write', 'src/replay/engine.ts');
    expect(result.messages).toEqual([]);
  });

  /*
   * Les fixtures prouvent que la regle mord ; ce test prouve qu'elle est
   * branchee sur le code reel. Les deux globs sont vides tant qu'aucun adapter
   * n'est livre, et deviennent un verrou au premier fichier, sans qu'aucun lot
   * ulterieur ait a y penser.
   */
  it('lint l’arbre reel de adapters/ et jobs/ sans erreur', async () => {
    const results = await eslint.lintFiles(['src/adapters/**/*.ts', 'src/jobs/**/*.ts']);
    expect(messageLines(results)).toEqual([]);
  });
});

describe('frontieres de couche — jobs/ est le point d’entree, personne ne l’importe', () => {
  it.each(['src/adapters/coinbase.ts', 'src/config/env.ts'])(
    'refuse un import de jobs/ depuis %s',
    async (virtualPath) => {
      const result = await lintAs('bad-jobs-import', virtualPath);
      // Un message par import : le chemin relatif et le chemin nu.
      expect(ruleCounts(result)).toEqual({ 'no-restricted-imports': 2 });
    },
  );

  it('laisse un job importer un autre job', async () => {
    const result = await lintAs('bad-jobs-import', 'src/jobs/daily.ts');
    expect(result.messages).toEqual([]);
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
    expect(messageLines(results)).toEqual([]);
  });
});
