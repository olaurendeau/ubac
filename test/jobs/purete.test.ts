import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/**
 * `src/jobs/` vit **hors** de `src/core/`, donc les regles de purete
 * d'`eslint.config.js` ne le couvrent pas : elles sont posees sur le glob
 * `src/core/**` et rien d'autre. Le seul garde-fou que la phase 1 y applique
 * porte sur les noms d'ecriture d'ordre, pas sur l'horloge.
 *
 * Ce fichier tient le reste. Le piege est nomme par le plan de la phase 1 :
 * « le job vit hors de core/, donc la regle de purete ne le protege pas. C'est
 * la que se glisse une lecture de l'horloge systeme. » Un `new Date()` dans le
 * run rendrait la `run_date` dependante de l'heure de declenchement : un run
 * lance a 23 h 59 UTC et son rejeu a 00 h 01 porteraient deux dates, et l'index
 * unique de `decisions` ne protegerait plus rien.
 *
 * Le controle passe par ESLint sur l'AST, pas par une recherche de texte : un
 * motif textuel se declenche sur un commentaire qui **decrit** l'interdit, ce
 * qui apprend a ne plus le documenter. Chaque regle est accompagnee d'un
 * contre-exemple qui doit la faire mordre : une regle branchee sur un selecteur
 * faux rendrait tous les verdicts verts.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JOBS = 'src/jobs/**/*.ts';
const RECONCILE = 'src/jobs/reconcile.ts';

const BASE: Linter.Config = {
  files: ['**/*.ts'],
  languageOptions: {
    parser: tseslint.parser as Linter.Parser,
    parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
  },
  // Un garde-fou qu'on eteint depuis le fichier qu'il surveille n'en est pas un.
  linterOptions: { noInlineConfig: true },
};

function gardien(rules: Linter.Config['rules']): ESLint {
  return new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [{ ...BASE, rules }],
  });
}

/** Les fichiers, relatifs a la racine, sur lesquels une regle a parle. */
function fautifs(results: readonly ESLint.LintResult[]): string[] {
  return results
    .filter((r) => r.messages.length > 0)
    .map((r) => relative(ROOT, r.filePath))
    .sort();
}

async function messagesDe(eslint: ESLint, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, 'src/jobs/sonde.ts') });
  return result?.messages.length ?? 0;
}

// --- Horloge et aleatoire ---------------------------------------------------

/** Recopie des selecteurs que `eslint.config.js` applique a core, sans les imports. */
const HORLOGE = gardien({
  'no-restricted-syntax': [
    'error',
    { selector: "MemberExpression[object.name='Date'][property.name='now']", message: 'horloge' },
    { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'horloge' },
    { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'aleatoire' },
    {
      selector: "MemberExpression[computed=true][object.name=/^(Date|Math)$/]",
      message: "acces calcule : il contourne les trois selecteurs ci-dessus",
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'crypto', message: 'randomUUID et randomBytes cassent le determinisme' },
    { name: 'performance', message: 'performance.now() est une horloge' },
  ],
});

const SONDE_HORLOGE = `
const a = Date.now();
const b = new Date();
const c = Math.random();
const d = Date['now']();
const e = crypto.randomUUID();
const f = performance.now();
export { a, b, c, d, e, f };
`;

describe('src/jobs/ n’a ni horloge propre ni aleatoire', () => {
  it('la regle mord sur les six formes, y compris l’acces calcule', async () => {
    expect(await messagesDe(HORLOGE, SONDE_HORLOGE)).toBe(6);
  });

  it('un horodatage recu en parametre reste permis', async () => {
    // L'horloge est injectee, pas bannie : `new Date(valeur)` lit une donnee.
    expect(await messagesDe(HORLOGE, "export const d = new Date('2026-09-11T00:00:00Z');")).toBe(0);
  });

  it('aucun module de jobs/ ne lit l’horloge ni l’aleatoire', async () => {
    expect(fautifs(await HORLOGE.lintFiles([JOBS]))).toEqual([]);
  });
});

// --- La reconciliation precede toute decision -------------------------------

/**
 * La seconde moitie de « la reconciliation precede toute decision ».
 *
 * La premiere est portee par le type : `ReconciledBalances` est marque par un
 * symbole que `reconcile.ts` n'exporte pas, donc aucun autre module ne sait en
 * fabriquer un, et le champ `holdings` n'existe que sur la branche reconciliee.
 * Un run ne peut pas obtenir de soldes valides sans reconcilier.
 *
 * Restait un contournement : appeler soi-meme `exchange.balances()` et se
 * fabriquer un `Holdings` a la main. C'est ce que ce bloc ferme. La lecture des
 * soldes appartient a `reconcile.ts` ; tout autre job passe par son resultat.
 *
 * Le controle est vide aujourd'hui — `reconcile.ts` est le seul job livre — et
 * devient un verrou au premier module de Q4b, sans que ce lot ait a y penser.
 * Meme construction que le lint de `src/adapters/**` en Q1.
 */
const LECTURE_DES_SOLDES = gardien({
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='balances']",
      message:
        'la lecture des soldes appartient a reconcile.ts : un run qui lit lui-meme decide sur un etat non reconcilie.',
    },
  ],
});

describe('seule la reconciliation lit les soldes de l’exchange', () => {
  it('reconcile.ts est le seul fichier de jobs/ ou la regle parle', async () => {
    /*
     * Les deux assertions du garde-fou en une : reconcile.ts **doit** y figurer,
     * sinon le selecteur ne designe rien et le controle serait vide ; et aucun
     * autre fichier ne doit s'y ajouter.
     */
    expect(fautifs(await LECTURE_DES_SOLDES.lintFiles([JOBS]))).toEqual([RECONCILE]);
  });
});

// --- Hors ligne -------------------------------------------------------------

/**
 * Les tests de ce repertoire tournent sans reseau, sans cle et sans base. Ils le
 * tiennent parce que `jobs/` n'importe des adapters que des **types** :
 * `import type` est efface a la compilation, donc ni `ccxt` ni `pg` n'est
 * charge. Un import de valeur suffirait a rompre la propriete sans qu'aucun test
 * fonctionnel ne bronche — jusqu'au jour ou la suite tourne sans reseau.
 *
 * Le run, lui, compose les adapters : il les importera en valeur. Ce controle
 * dit donc que la **reconciliation** n'en a pas besoin, ce qui est ce qui la
 * rend testable contre des doubles.
 */
const IMPORTS_DE_VALEUR = gardien({
  'no-restricted-syntax': [
    'error',
    {
      selector: "ImportDeclaration[importKind='value'][source.value=/adapters/]",
      message: "jobs/ n'importe des adapters que leurs types : un import de valeur charge ccxt et pg.",
    },
  ],
});

describe('les adapters n’entrent dans la reconciliation que par leurs types', () => {
  it('la regle mord sur un import de valeur', async () => {
    const code = "import { openDatabase } from '../adapters/db.js';\nexport const x = openDatabase;";
    expect(await messagesDe(IMPORTS_DE_VALEUR, code)).toBe(1);
  });

  it('elle laisse passer un import de types', async () => {
    const code = "import type { UbacDatabase } from '../adapters/db.js';\nexport type X = UbacDatabase;";
    expect(await messagesDe(IMPORTS_DE_VALEUR, code)).toBe(0);
  });

  it('aucun module de jobs/ n’importe un adapter en valeur', async () => {
    expect(fautifs(await IMPORTS_DE_VALEUR.lintFiles([JOBS]))).toEqual([]);
  });
});
