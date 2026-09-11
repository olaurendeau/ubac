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
 *
 * ## Ce que ces garde-fous ne peuvent pas attraper
 *
 * Meme honnetete que `docs/phase-1-frontieres.md` pour le garde-fou d'ecriture
 * d'ordre : ce sont des controles de **noms** sur l'arbre syntaxique, et un
 * controle de noms se contourne. Ce que l'AST ne voit pas, aucun selecteur ne le
 * rattrapera :
 *
 * - **la repartition dynamique** : `const m = 'now'; Date[m]()` ou `client[k]`,
 *   ou le nom est calcule a l'execution. Le seul acces calcule ferme ici est
 *   celui dont l'**objet** est nomme (`Date`, `Math`, `process`), qui est la
 *   forme courte et donc la forme probable ;
 * - **l'evaluation** : `eval('Date.now()')`, `new Function(…)` ;
 * - **l'indirection par un tiers** : un helper qui recoit l'objet en parametre
 *   (`lire(process)`), la reflexion (`Reflect.get`), une dependance transitive
 *   qui lit l'horloge ou l'environnement pour son compte ;
 * - **tout ce qui vit hors de `src/jobs/**`**, ce fichier ne lintant que ce
 *   glob.
 *
 * L'acces indirect par `globalThis` — `globalThis.Date.now()`,
 * `globalThis.process.env` — appartenait a cette liste. Il n'y est plus : la
 * globale `globalThis` est refusee en tant que telle par le garde-fou de
 * l'horloge ci-dessous, exactement comme `eslint.config.js` la refuse a core.
 * Elle reste la porte derobee commune a tous les interdits de ce fichier, et
 * les quatre garde-fous lintent le meme glob : ce que l'un refuse est refuse.
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
    /*
     * `globalThis` n'a pas sa place ici au titre de l'horloge : il y est parce
     * qu'il est l'acces indirect a tout le reste. `globalThis.Date.now()` ne
     * ressemble a aucun des selecteurs ci-dessus — l'objet de la
     * MemberExpression y est `globalThis.Date`, pas `Date` — et
     * `globalThis.process.env` echappe de la meme facon au garde-fou de
     * configuration plus bas. Refuser le nom ferme les deux d'un coup, et c'est
     * ce qu'`eslint.config.js` fait deja pour core.
     */
    {
      name: 'globalThis',
      message: 'globalThis rouvre Date, Math, process et crypto : la porte derobee de ce fichier',
    },
  ],
});

const SONDE_HORLOGE = `
const a = Date.now();
const b = new Date();
const c = Math.random();
const d = Date['now']();
const e = crypto.randomUUID();
const f = performance.now();
const g = globalThis.Date.now();
export { a, b, c, d, e, f, g };
`;

describe('src/jobs/ n’a ni horloge propre ni aleatoire', () => {
  it('la regle mord sur les sept formes, y compris l’acces calcule et globalThis', async () => {
    expect(await messagesDe(HORLOGE, SONDE_HORLOGE)).toBe(7);
  });

  it('un horodatage recu en parametre reste permis', async () => {
    // L'horloge est injectee, pas bannie : `new Date(valeur)` lit une donnee.
    expect(await messagesDe(HORLOGE, "export const d = new Date('2026-09-11T00:00:00Z');")).toBe(0);
  });

  it('aucun module de jobs/ ne lit l’horloge, l’aleatoire ni globalThis', async () => {
    expect(fautifs(await HORLOGE.lintFiles([JOBS]))).toEqual([]);
  });
});

// --- La configuration entre par src/config/env.ts ---------------------------

/**
 * `src/config/env.ts` est la frontiere **unique** par laquelle la configuration
 * entre dans le systeme ; `docs/phase-1-frontieres.md` §4 l'ecrit ainsi. Ce
 * n'est pas une preference de style : cette frontiere refuse un secret absent ou
 * vide en nommant la variable sans jamais citer sa valeur, elle rejette toute
 * variable du prefixe `UBAC_RISK_` pour qu'un seuil de risque ne puisse pas etre
 * cru modifie alors qu'il ne l'est pas, et elle valide les litteraux decimaux
 * avant de les donner a `Decimal`, pour qu'un `NaN` ne fasse pas cesser de
 * mordre une comparaison dont aucune couverture ne signalerait qu'elle repond
 * toujours `false`.
 *
 * `const seuil = process.env.UBAC_RISK_MIN_CASH_PCT` dans un job contourne les
 * trois en une ligne, et aucun test fonctionnel ne bronche : la variable est
 * lue, elle a une valeur, le run continue. Comme pour l'horloge, `src/jobs/`
 * vit hors du glob de purete d'`eslint.config.js`, qui interdit deja la globale
 * `process` a core ; ce fichier est le seul endroit du depot ou la regle peut
 * etre tenue pour les jobs.
 *
 * La configuration d'un job est donc un **parametre** : il recoit un
 * `UbacConfig` deja valide, ou appelle `loadConfig`. L'import de
 * `../config/env.js` reste permis — c'est la porte, pas le contournement.
 *
 * ### Portee exacte, et ce qui est laisse passer **expres**
 *
 * L'interdit porte sur `process.env`, pas sur `process`. `process.argv`,
 * `process.exitCode` et `process.stdout` restent permis : `jobs/` est le point
 * d'entree executable, et `src/replay/report.ts` montre a quoi cela ressemble
 * en phase 0. Ce qui passerait sans cette exclusion n'est pas de la
 * configuration ; le jour ou un job lirait un reglage dans `process.argv`, c'est
 * cette exclusion qu'il faudrait resserrer, et elle est ecrite pour cela.
 *
 * Le reste des trous est celui de l'entete : un helper qui recoit `process` en
 * parametre, un nom calcule sur un objet lui-meme calcule, `eval`. L'acces par
 * `globalThis.process.env`, lui, est ferme — par le garde-fou de l'horloge, pas
 * par celui-ci. Le test ci-dessous le dit noir sur blanc plutot que de laisser
 * croire a ce selecteur une portee qu'il n'a pas.
 */
const CONFIGURATION = gardien({
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[object.name='process'][property.name='env']",
      message:
        'la configuration entre par src/config/env.ts : une lecture directe contourne la validation des secrets, le refus du prefixe UBAC_RISK_ et le filtre des litteraux decimaux.',
    },
    {
      selector: "MemberExpression[computed=true][object.name='process']",
      message: "acces calcule : process['env'] contourne le selecteur ci-dessus.",
    },
    {
      /*
       * `const { env } = process` puis `env.DATABASE_URL` ne contient plus
       * aucune MemberExpression `process.env` : sans cette regle, la lecture
       * devient invisible au prix d'une ligne.
       */
      selector: "VariableDeclarator[init.name='process']",
      message: "alias de process : la lecture d'environnement s'y cache en une ligne.",
    },
    {
      // `node:process` exporte `env` directement : meme lecture, autre chemin.
      selector: "ImportDeclaration[source.value='node:process'] > ImportSpecifier[imported.name='env']",
      message: "node:process expose env : la configuration entre par src/config/env.ts.",
    },
  ],
});

const SONDE_CONFIGURATION = `
import { env } from 'node:process';
const a = process.env.DATABASE_URL;
const { UBAC_RISK_MIN_CASH_PCT: b } = process.env;
const c = process['env'].UBAC_STRATEGIES;
const { env: d } = process;
export { env, a, b, c, d };
`;

describe('la configuration d’un job entre par src/config/env.ts', () => {
  it('la regle mord sur les cinq chemins de lecture de l’environnement', async () => {
    expect(await messagesDe(CONFIGURATION, SONDE_CONFIGURATION)).toBe(5);
  });

  it('la porte reste ouverte : loadConfig et un UbacConfig recu en parametre', async () => {
    const code = [
      "import { loadConfig } from '../config/env.js';",
      "import type { UbacConfig } from '../config/env.js';",
      'export const url = (c: UbacConfig = loadConfig()) => c.secrets.databaseUrl;',
    ].join('\n');
    expect(await messagesDe(CONFIGURATION, code)).toBe(0);
  });

  it('process.argv et process.exitCode restent permis : jobs/ est le point d’entree', async () => {
    const code = 'export const run = () => {\n  process.exitCode = process.argv.length;\n};';
    expect(await messagesDe(CONFIGURATION, code)).toBe(0);
  });

  it('globalThis.process.env echappe a ce selecteur, et tombe sur celui de l’horloge', async () => {
    const code = 'export const a = globalThis.process.env.DATABASE_URL;';
    expect(await messagesDe(CONFIGURATION, code)).toBe(0);
    expect(await messagesDe(HORLOGE, code)).toBe(1);
  });

  it('aucun module de jobs/ ne lit l’environnement', async () => {
    expect(fautifs(await CONFIGURATION.lintFiles([JOBS]))).toEqual([]);
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
