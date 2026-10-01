import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * CV4 et la frontiere du convoyeur (plan ubac-convoyeur, point 1, lot Y3).
 * Chaque regle du bloc convoyeur d'`eslint.config.js` a sa fixture, lintee sous
 * un chemin virtuel comme dans `test/structure.test.ts` ; l'arbre reel est lint
 * par le dernier bloc de ce dernier.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = resolve(ROOT, 'test/lint/fixtures');
const eslint = new ESLint({ cwd: ROOT });

async function lint(fixture: string, virtualPath: string): Promise<ESLint.LintResult> {
  const code = await readFile(resolve(FIXTURES, `${fixture}.fixture`), 'utf8');
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, virtualPath) });
  if (result === undefined) throw new Error(`aucun resultat de lint pour ${virtualPath}`);
  return result;
}

function ruleCounts(result: ESLint.LintResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of result.messages) {
    const rule = message.ruleId ?? '(directive)';
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

const TRANSPORT = 'src/convoyeur/coinbase.ts';
/** Un fichier du convoyeur sans bloc propre (le futur point d'entree d'Y5). */
const AUTRE = 'src/convoyeur/main.ts';
const PASSAGE = 'src/convoyeur/passage.ts';
const PUR = 'src/convoyeur/regles.ts';
const BASE = 'src/convoyeur/base.ts';

describe('CV4 — aucune route v2 ni sortie de ccxt dans le convoyeur', () => {
  it.each([TRANSPORT, AUTRE])('refuse chaque acces de la fixture dans %s', async (chemin) => {
    const result = await lint('convoyeur-bad-v2', chemin);
    expect(ruleCounts(result)).toEqual({ 'no-restricted-syntax': 12 });
    /*
     * Une ligne par acces, deux messages quand le membre et la chaine mordent
     * ensemble : `['v2…']`, `request(…, ['v2', …])`, `fetch2('/v2/…')`.
     */
    expect(result.messages.map((m) => m.line)).toEqual([3, 4, 5, 5, 6, 7, 7, 8, 8, 9, 10, 11]);
  });

  it('refuse un acces calcule dans le transport, et seulement la', async () => {
    expect(ruleCounts(await lint('convoyeur-bad-computed', TRANSPORT))).toEqual({
      'no-restricted-syntax': 1,
    });
    expect((await lint('convoyeur-bad-computed', AUTRE)).messages).toEqual([]);
  });

  it('refuse fetch et les globales qui menent au reseau', async () => {
    for (const nom of ['fetch', 'XMLHttpRequest', 'WebSocket', 'globalThis', 'require']) {
      const [result] = await eslint.lintText(`export const x = ${nom};`, {
        filePath: resolve(ROOT, AUTRE),
      });
      expect(result === undefined ? {} : ruleCounts(result), nom).toEqual({ 'no-restricted-globals': 1 });
    }
  });

  it('ne laisse pas un eslint-disable desarmer la regle v2', async () => {
    const code =
      '// eslint-disable-next-line no-restricted-syntax\nexport const f = (e) => e.v2PrivateGetAccounts();';
    const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, AUTRE) });
    expect(result === undefined ? {} : ruleCounts(result)).toEqual({
      '(directive)': 1,
      'no-restricted-syntax': 1,
    });
  });

  /*
   * Le filet textuel, pour ce qu'une regle de syntaxe ne voit pas : un fichier
   * pur (`regles.ts`) n'a pas la regle v2, il a celles du noyau, qui lui
   * interdisent deja ccxt et le reseau. Aucune mention de la v2 dans l'arbre.
   */
  it('ne mentionne la v2 nulle part dans src/convoyeur/', async () => {
    const dossier = resolve(ROOT, 'src/convoyeur');
    const fichiers = (await readdir(dossier, { recursive: true })).filter((f) => f.endsWith('.ts'));
    expect(fichiers).toContain('coinbase.ts');
    for (const fichier of fichiers) {
      const source = await readFile(resolve(dossier, fichier), 'utf8');
      expect(source.match(/\bv2[A-Z_]|\/v2\//g) ?? [], fichier).toEqual([]);
    }
  });

  /*
   * L'enumeration positive des membres lus sur l'instance ccxt : les six
   * methodes v3 des six routes, et la fermeture. Une methode unifiee
   * (`fetchBalance` passe par `/v2/accounts`) ou une septieme route rougit ici.
   */
  it('ne lit sur l’instance ccxt que les six methodes v3 et close', async () => {
    const source = await readFile(resolve(ROOT, TRANSPORT), 'utf8');
    const membres = new Set([...source.matchAll(/\bexchange\.(\w+)/g)].map((m) => m[1]));
    expect([...membres].sort()).toEqual([
      'close',
      'v3PrivateGetBrokerageAccounts',
      'v3PrivateGetBrokerageKeyPermissions',
      'v3PrivateGetBrokerageOrdersHistoricalBatch',
      'v3PrivateGetBrokerageTransactionSummary',
      'v3PrivatePostBrokerageOrders',
      'v3PrivatePostBrokeragePortfoliosMoveFunds',
    ]);
  });
});

describe('frontiere du convoyeur — ce qu’il importe', () => {
  it('refuse les imports hors liste du point 1 ailleurs que dans le transport', async () => {
    // ccxt, node:https, adapters/coinbase, jobs/, valeur de core/, report/ ; jobs/ aussi par Ubac.
    expect(ruleCounts(await lint('convoyeur-bad-imports', AUTRE))).toEqual({
      '@typescript-eslint/no-restricted-imports': 6,
      'no-restricted-imports': 1,
    });
  });

  it('admet ccxt dans le transport, et rien de plus', async () => {
    expect(ruleCounts(await lint('convoyeur-bad-imports', TRANSPORT))).toEqual({
      '@typescript-eslint/no-restricted-imports': 5,
      'no-restricted-imports': 1,
    });
  });

  it('accepte decimal.js, schema, http, les types de core et l’interne', async () => {
    for (const chemin of [AUTRE, TRANSPORT]) {
      expect((await lint('convoyeur-good-module', chemin)).messages, chemin).toEqual([]);
    }
  });
});

describe('frontiere du convoyeur — la base, et seulement elle (Y4a)', () => {
  const PILOTE = [
    "import { inArray } from 'drizzle-orm';",
    "import { drizzle } from 'drizzle-orm/node-postgres';",
    "import pg from 'pg';",
    'export const x = [inArray, drizzle, pg];',
  ].join('\n');

  it('admet drizzle-orm et pg dans base.ts, et nulle part ailleurs', async () => {
    for (const [chemin, attendu] of [
      [BASE, {}],
      [AUTRE, { '@typescript-eslint/no-restricted-imports': 3 }],
      [TRANSPORT, { '@typescript-eslint/no-restricted-imports': 3 }],
    ] as const) {
      const [result] = await eslint.lintText(PILOTE, { filePath: resolve(ROOT, chemin) });
      expect(result === undefined ? {} : ruleCounts(result), chemin).toEqual(attendu);
    }
  });

  it('refuse dans base.ts les memes imports qu’ailleurs, adapters/db.js compris', async () => {
    expect(ruleCounts(await lint('convoyeur-bad-imports', BASE))).toEqual({
      '@typescript-eslint/no-restricted-imports': 6,
      'no-restricted-imports': 1,
    });
    const [result] = await eslint.lintText("export { openDatabase } from '../adapters/db.js';", {
      filePath: resolve(ROOT, BASE),
    });
    expect(result === undefined ? {} : ruleCounts(result)).toEqual({ '@typescript-eslint/no-restricted-imports': 1 });
  });

  it('garde la regle v2 dans base.ts', async () => {
    expect(ruleCounts(await lint('convoyeur-bad-v2', BASE))).toEqual({ 'no-restricted-syntax': 12 });
  });
});

describe('frontiere du convoyeur — personne dans Ubac ne l’importe', () => {
  it.each([
    'src/core/strategy/x.ts',
    'src/adapters/db.ts',
    'src/jobs/daily.ts',
    'src/report/daily-report.ts',
    'src/config/env.ts',
    'src/replay/engine.ts',
  ])('refuse un import du convoyeur depuis %s', async (chemin) => {
    // Un message par forme : l'import et le `export * from`.
    expect(ruleCounts(await lint('bad-convoyeur-import', chemin))).toEqual({
      'no-restricted-imports': 2,
    });
  });
});

describe('les regles du convoyeur sont pures : celles du noyau s’y appliquent', () => {
  it.each([
    ['bad-clock', { 'no-restricted-syntax': 5 }],
    ['bad-crypto-random', { 'no-restricted-imports': 1 }],
    ['bad-global-io', { 'no-restricted-globals': 6 }],
  ] as const)('refuse %s dans regles.ts comme dans core', async (fixture, attendu) => {
    expect(ruleCounts(await lint(fixture, PUR))).toEqual(attendu);
    expect(ruleCounts(await lint(fixture, 'src/convoyeur/types.ts'))).toEqual(attendu);
  });

  it('refuse dans regles.ts les imports du noyau et ceux du convoyeur, ensemble', async () => {
    expect(ruleCounts(await lint('convoyeur-bad-imports', PUR))).toEqual({
      '@typescript-eslint/no-restricted-imports': 6,
      'no-restricted-imports': 2,
      'no-restricted-syntax': 2,
    });
  });
});

describe('frontiere du convoyeur — le passage n’a pas d’horloge (Y4b)', () => {
  it('refuse l’horloge, l’aleatoire et l’acces calcule a Date ou Math', async () => {
    expect(ruleCounts(await lint('bad-clock', PASSAGE))).toEqual({ 'no-restricted-syntax': 5 });
    expect((await lint('bad-clock', AUTRE)).messages).toEqual([]);
  });

  it('refuse les minuteurs et les globales d’horloge ou d’IO', async () => {
    for (const nom of ['setTimeout', 'setInterval', 'setImmediate', 'performance', 'process', 'crypto', 'console']) {
      const [result] = await eslint.lintText(`export const x = ${nom};`, { filePath: resolve(ROOT, PASSAGE) });
      expect(result === undefined ? {} : ruleCounts(result), nom).toEqual({ 'no-restricted-globals': 1 });
    }
  });

  it('garde la regle v2 et la liste des imports du convoyeur', async () => {
    expect(ruleCounts(await lint('convoyeur-bad-v2', PASSAGE))).toEqual({ 'no-restricted-syntax': 12 });
    expect((await lint('convoyeur-good-module', PASSAGE)).messages).toEqual([]);
    expect(ruleCounts(await lint('convoyeur-bad-imports', PASSAGE))).toEqual({
      '@typescript-eslint/no-restricted-imports': 6,
      'no-restricted-imports': 1,
    });
  });
});
