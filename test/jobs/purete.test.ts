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
 * ## Ce que ces garde-fous attrapent, et sous quelles formes
 *
 * Cinq gardiens lintent le meme glob, `src/jobs`, chacun avec ses propres
 * regles : ce que l'un refuse est refuse.
 *
 * 1. **L'horloge et l'aleatoire** : `Date.now()`, `new Date()` sans argument,
 *    `Math.random()`, l'acces calcule `Date['now']()`, et les globales `crypto`,
 *    `performance`, `globalThis` et `global`. Les deux dernieres n'ont rien a
 *    voir avec le temps : elles sont refusees parce qu'elles rouvrent nommement
 *    tout ce que les autres regles ferment.
 * 2. **Les modules refuses** — `process`, `crypto` hors `createHash`,
 *    `perf_hooks` — par **toute** forme d'import plutot que par une liste
 *    de formes : nomme, renomme, par defaut, namespace, effet de bord,
 *    `export … from`, `export *`, `import x = require(…)` et `import(…)`, avec
 *    ou sans le prefixe `node:`. S'y ajoute le nom ecrit **ailleurs qu'en
 *    position d'import** — `createRequire(…)('process')`, une table de
 *    resolution — la aussi avec ou sans le prefixe : dans `src/jobs/`, ces trois
 *    noms ne s'ecrivent pas comme chaine litterale, et le mot employe comme
 *    donnee tombe avec eux, faux positif assume et constate par un test. S'y
 *    ajoute enfin l'import dynamique dont le specificateur est calcule, qu'aucun
 *    controle de nom ne peut lire.
 * 3. **La configuration** : `process.env`, et **toute autre mention du nom
 *    `process` comme valeur** — `const p = process`, `p = process`,
 *    `const { env } = process`, `process['env']`, `lire(process)`,
 *    `(p = process) => …`, `{ p: process }`. Les seules proprietes admises sont
 *    nommees une a une : `argv`, `exitCode`, `stdout`, `stderr`.
 * 4. **La lecture des soldes** hors de `reconcile.ts`.
 * 5. **L'import de valeur d'un adapter**, qui chargerait `ccxt` et `pg`.
 *
 * Les points 2 et 3 sont ecrits ainsi a la suite d'une revue. Un selecteur qui
 * refusait `import { env } from 'node:process'` laissait passer
 * `import p from 'node:process'` puis `p.env`, et douze tests restaient verts.
 * La lecon n'est pas qu'il manquait une forme : c'est qu'enumerer les formes
 * fautives est perdant. Refuser le module quelle que soit la forme, et
 * n'autoriser du nom que trois proprietes, l'est moins.
 *
 * ## Ce qu'ils ne peuvent pas attraper
 *
 * Meme honnetete que `docs/phase-1-frontieres.md` pour le garde-fou d'ecriture
 * d'ordre, qui ecrit noir sur blanc que le nom de methode calcule lui echappe,
 * et que `test/core/risk-contract.test.ts` pour sa recherche de chaines. Des
 * categories, donc, et surtout pas une liste qui se pretendrait complete :
 *
 * - **l'evaluation** : `eval('process.env.X')`, `new Function('return process')` ;
 * - **la repartition dynamique sur un objet lui-meme calcule** : `o[k][m]()`,
 *   `Reflect.get(…)`. Le seul acces calcule ferme ici est celui dont l'objet est
 *   nomme (`Date`, `Math`, `process`), qui est la forme courte, donc la forme
 *   probable ;
 * - **l'indirection par un module du depot** : un `src/partage/machin.ts` qui
 *   lit `process.env` et exporte le resultat ; le job l'importerait sans
 *   prononcer aucun interdit. Ce trou n'existe que parce que le glob s'arrete a
 *   `src/jobs`. Le cas ou le nom survit au passage —
 *   `import { process } from '../partage/machin.js'` — est attrape par le point
 *   3, qui juge le nom et pas la provenance ; le cas ou il est renomme, non ;
 * - **l'indirection par une dependance** : un paquet qui lit l'environnement ou
 *   l'horloge pour son compte, en dehors de tout code du depot ;
 * - **le specificateur assemble hors position d'import** :
 *   `createRequire(…)('proc' + 'ess')`, `createRequire(…)(nom)`. Le filet de
 *   chaines lit un litteral ; il ne concatene pas et ne resout pas une variable.
 *   `import(…)` est le seul endroit ou le specificateur cesse d'etre litteral et
 *   ou la forme entiere reste refusable, parce qu'elle est reconnaissable ; un
 *   appel quelconque ne l'est pas ;
 * - **les autres builtins Node** : `node:fs` sait lire un `.env`,
 *   `node:child_process` transmettre un environnement, `node:os` decrire la
 *   machine. Seuls les trois modules nommes plus haut sont refuses ;
 * - **tout ce qui vit hors de `src/jobs`**, ce fichier ne lintant que ce glob.
 *
 * ## Ce que vaut ce controle
 *
 * C'est un garde-fou contre l'inattention, pas une preuve contre la
 * determination. Il rend l'interdit visible, couteux a franchir et bruyant en
 * relecture ; il ne rend pas le franchissement impossible. Qui veut lire
 * l'environnement depuis un job y arrivera — ce fichier fait seulement qu'il
 * devra l'ecrire expres.
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

/**
 * Une table de sondes : pour chaque forme, le code a linter et le nombre exact
 * de messages attendu. Le compte plutot qu'un « au moins un » : un zero de trop
 * signale une forme qui passe, un deux inattendu signale une regle qui deborde
 * sur le terrain d'une autre. Les deux cas sont des defauts.
 */
type Sondes = Readonly<Record<string, readonly [code: string, messages: number]>>;

/** Lance chaque sonde et rend, par nom, le nombre de messages obtenus. */
async function verdicts(eslint: ESLint, sondes: Sondes): Promise<Record<string, number>> {
  const lus = await Promise.all(
    Object.entries(sondes).map(
      async ([nom, [code]]) => [nom, await messagesDe(eslint, code)] as const,
    ),
  );
  return Object.fromEntries(lus);
}

/** Les comptes attendus, lus dans la meme table : un seul endroit a tenir. */
function attendus(sondes: Sondes): Record<string, number> {
  return Object.fromEntries(Object.entries(sondes).map(([nom, [, n]]) => [nom, n]));
}

/** Les formes qui doivent passer : meme table, compte attendu nul partout. */
function permises(codes: Readonly<Record<string, string>>): Sondes {
  return Object.fromEntries(Object.entries(codes).map(([nom, code]) => [nom, [code, 0]]));
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
     *
     * `global` est le meme objet sous l'autre nom, celui que Node expose depuis
     * toujours : `global.process.env` marche exactement comme la forme
     * precedente. Fermer une porte en laissant sa jumelle ouverte ne ferme rien.
     */
    {
      name: 'globalThis',
      message: 'globalThis rouvre Date, Math, process et crypto : la porte derobee de ce fichier',
    },
    { name: 'global', message: "global est globalThis sous l'autre nom que Node expose" },
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
const h = global.process.env.DATABASE_URL;
export { a, b, c, d, e, f, g, h };
`;

describe('src/jobs/ n’a ni horloge propre ni aleatoire', () => {
  it('la regle mord sur les huit formes, acces calcule, globalThis et global compris', async () => {
    expect(await messagesDe(HORLOGE, SONDE_HORLOGE)).toBe(8);
  });

  it('un horodatage recu en parametre reste permis', async () => {
    // L'horloge est injectee, pas bannie : `new Date(valeur)` lit une donnee.
    expect(await messagesDe(HORLOGE, "export const d = new Date('2026-09-11T00:00:00Z');")).toBe(0);
  });

  it('aucun module de jobs/ ne lit l’horloge, l’aleatoire ni les globales', async () => {
    expect(fautifs(await HORLOGE.lintFiles([JOBS]))).toEqual([]);
  });
});

// --- Les modules refuses ----------------------------------------------------

/**
 * Trois modules rouvrent ce que les regles voisines ferment : `node:process`
 * exporte `env`, `node:crypto` exporte `randomUUID` et `randomBytes`,
 * `node:perf_hooks` exporte `performance`. Refuser la globale sans refuser le
 * module ne refuse rien — c'est exactement le defaut qu'une revue a trouve sur
 * ce fichier.
 *
 * ### Refuser le module, pas la forme
 *
 * `no-restricted-imports` juge le **specificateur**, donc toutes les formes
 * d'import d'un coup : nomme, renomme, par defaut, namespace, effet de bord,
 * `export … from`, `export *`, `import x = require(…)`. C'est ce qui distingue
 * cette regle d'un selecteur pose sur `ImportSpecifier`, qui ne voit que la
 * forme qu'on a pensee. Les deux orthographes sont listees : `node:process`
 * comme `process`, que Node resout au meme module.
 *
 * Restent trois chemins que `no-restricted-imports` ne regarde pas, fermes par
 * selecteur :
 *
 * - `import('node:process')` : la regle ignore l'import dynamique ;
 * - `import(`node:${x}`)`, `import('node:' + 'process')`, `import(m)` : le
 *   specificateur n'est plus un litteral, donc plus aucun controle de nom ne
 *   peut le lire. La forme entiere est refusee, pas son contenu ;
 * - `createRequire(import.meta.url)('process')` et toute autre route qui ecrit
 *   le specificateur ailleurs qu'en position d'import : le filet attrape les
 *   trois noms, prefixes ou nus, ou que la chaine se trouve — sauf en position de
 *   source d'import, deja jugee plus haut, pour qu'un import ne rende pas deux
 *   messages pour une faute.
 *
 * ### Le nom nu, et son prix paye expres
 *
 * Ce dernier filet a d'abord ete borne au prefixe, pour ne pas faire mordre la
 * regle sur le mot employe comme donnee — `export const s = 'crypto'`. La borne
 * se defendait, mais elle laissait `createRequire(…)('process')` charger le
 * module alors que l'entete promettait « avec ou sans prefixe ». Entre resserrer
 * la promesse et fermer le trou, c'est le trou qui est ferme : un garde-fou dont
 * on surestime la portee est pire qu'un garde-fou absent.
 *
 * Le faux positif est donc assume, et constate par une sonde plutot que passe
 * sous silence. Il coute peu : il est bruyant au lint, il se contourne en
 * nommant la donnee autrement, `src/jobs/` n'ecrit aujourd'hui aucun de ces
 * trois mots, et le mot reste libre partout ailleurs dans le depot — ce fichier
 * ne linte que ce glob.
 *
 * `createHash` reste admis, pour la meme raison que dans core : le hachage est
 * une fonction pure, et il sert au client_order_id deterministe.
 */
const CRYPTO = 'node:crypto expose randomUUID et randomBytes : seul createHash est deterministe.';
const MODULES = gardien({
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: 'process',
          message: 'process expose env : la configuration entre par src/config/env.ts.',
        },
        {
          name: 'node:process',
          message: 'node:process expose env : la configuration entre par src/config/env.ts.',
        },
        { name: 'crypto', allowImportNames: ['createHash'], message: CRYPTO },
        { name: 'node:crypto', allowImportNames: ['createHash'], message: CRYPTO },
        { name: 'perf_hooks', message: 'perf_hooks expose performance : c’est une horloge.' },
        { name: 'node:perf_hooks', message: 'node:perf_hooks expose performance : c’est une horloge.' },
      ],
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "ImportExpression[source.value=/^(node:)?(process|crypto|perf_hooks)$/]",
      message: "import dynamique : no-restricted-imports ne le voit pas, ce module reste refuse.",
    },
    {
      selector: "ImportExpression:not([source.type='Literal'])",
      message:
        "import dynamique a specificateur calcule : aucun controle de nom ne peut lire ce qui sera charge.",
    },
    {
      selector: [
        "Literal[value=/^(node:)?(process|crypto|perf_hooks)$/]",
        ':not(ImportDeclaration > .source)',
        ':not(ImportExpression > .source)',
        ':not(ExportNamedDeclaration > .source)',
        ':not(ExportAllDeclaration > .source)',
        ':not(TSExternalModuleReference > .expression)',
      ].join(''),
      message:
        "nom d'un module refuse, prefixe ou non, hors position d'import : createRequire et les tables de resolution chargent le module sans qu'aucune declaration d'import ne le dise. Le mot employe comme donnee tombe avec : nommer la donnee autrement.",
    },
  ],
});

/**
 * Les formes d'import, une par une. `import p from 'node:process'` est celle
 * que la revue a trouvee ; le namespace et l'absence de prefixe en sont les
 * variantes immediates. Le compte exact vaut mutation : supprimer une regle
 * fait passer une ligne a zero, et la table nomme laquelle.
 */
const FORMES_D_IMPORT: Sondes = {
  nomme: ["import { env } from 'node:process';\nexport const a = env.DATABASE_URL;", 1],
  renomme: ["import { env as e } from 'node:process';\nexport const a = e.DATABASE_URL;", 1],
  'par defaut': ["import p from 'node:process';\nexport const a = p.env.DATABASE_URL;", 1],
  namespace: ["import * as p from 'node:process';\nexport const a = p.env.DATABASE_URL;", 1],
  'effet de bord': ["import 'node:process';\nexport const a = 1;", 1],
  'sans le prefixe node:': ["import p from 'process';\nexport const a = p.env.DATABASE_URL;", 1],
  'reexport nomme': ["export { env } from 'node:process';", 1],
  'reexport total': ["export * from 'node:process';", 1],
  'reexport en namespace': ["export * as p from 'node:process';", 1],
  'import egale require': ["import p = require('node:process');\nexport const a = p;", 1],
  dynamique: ["export const p = await import('node:process');", 1],
  /*
   * Trois specificateurs qui ne sont plus litteraux, trois comptes voulus. Le
   * gabarit n'ecrit aucun litteral de chaine au sens de l'AST : seul le filet
   * des specificateurs calcules parle. Les deux autres ecrivent le nom en clair
   * quelque part, et le filet de chaines le lit aussi : deux defauts distincts,
   * donc deux messages.
   */
  'dynamique en gabarit': ['export const p = await import(`node:process`);', 1],
  'dynamique concatene': ["export const p = await import('node:' + 'process');", 2],
  'dynamique par variable': ["const m = 'node:process';\nexport const p = await import(m);", 2],
  'node:crypto nomme': ["import { randomUUID } from 'node:crypto';\nexport const a = randomUUID();", 1],
  'node:crypto namespace': ["import * as c from 'node:crypto';\nexport const a = c.randomBytes(8);", 1],
  'node:crypto dynamique': ["export const c = await import('node:crypto');", 1],
  'crypto sans le prefixe node:': [
    "import { randomUUID } from 'crypto';\nexport const a = randomUUID();",
    1,
  ],
  'node:perf_hooks': [
    "import { performance as p } from 'node:perf_hooks';\nexport const a = p.now();",
    1,
  ],
  'perf_hooks sans le prefixe node:': [
    "import { performance as p } from 'perf_hooks';\nexport const a = p.now();",
    1,
  ],
};

const IMPORTS_PERMIS = permises({
  'createHash, parce que le hachage est pur':
    "import { createHash } from 'node:crypto';\nexport const a = createHash('sha256');",
  'createHash sans le prefixe node:, meme raison':
    "import { createHash } from 'crypto';\nexport const a = createHash('sha256');",
  'la porte de configuration':
    "import { loadConfig } from '../config/env.js';\nexport const c = loadConfig();",
  'un adapter en type': "import type { UbacDatabase } from '../adapters/db.js';\nexport type X = UbacDatabase;",
  'un import dynamique a specificateur litteral': "export const a = await import('../adapters/db.js');",
});

/** L'entete d'un module qui se procure `require` : la route la plus courte. */
const EXIGER = [
  "import { createRequire } from 'node:module';",
  'const exiger = createRequire(import.meta.url);',
  '',
].join('\n');

/**
 * Le nom d'un module refuse, ecrit ailleurs qu'en position d'import. Les six
 * premieres lignes sont la mutation qui compte : les trois modules, chacun avec
 * et sans le prefixe. Rendre au selecteur sa borne `^node:` fait passer les trois
 * lignes nues a zero et les trois prefixees restent a un, ce qui est exactement
 * le trou qu'une revue a trouve ; la table nomme lesquelles.
 *
 * La table de resolution est la pour dire que le filet ne connait pas
 * `createRequire` et n'a pas a le connaitre : il juge la chaine, pas l'appel.
 * Toute autre route qui ecrit le nom en clair tombe de la meme facon.
 *
 * La derniere ligne est le prix de cette portee, constate plutot que promis.
 */
const SPECIFICATEURS_HORS_IMPORT: Sondes = {
  'createRequire node:process': [`${EXIGER}export const p = exiger('node:process');`, 1],
  'createRequire process': [`${EXIGER}export const p = exiger('process');`, 1],
  'createRequire node:crypto': [`${EXIGER}export const c = exiger('node:crypto');`, 1],
  'createRequire crypto': [`${EXIGER}export const c = exiger('crypto');`, 1],
  'createRequire node:perf_hooks': [`${EXIGER}export const h = exiger('node:perf_hooks');`, 1],
  'createRequire perf_hooks': [`${EXIGER}export const h = exiger('perf_hooks');`, 1],
  'table de resolution': ["const TABLE = { p: 'process' } as const;\nexport const nom = TABLE.p;", 1],
  'le mot employe comme donnee, faux positif assume': ["export const s = 'crypto';", 1],
};

describe('un module refuse n’entre par aucune forme d’import', () => {
  it('les vingt formes recoivent le verdict attendu', async () => {
    expect(await verdicts(MODULES, FORMES_D_IMPORT)).toEqual(attendus(FORMES_D_IMPORT));
  });

  it('le nom hors position d’import tombe, avec et sans prefixe, pour les trois modules', async () => {
    expect(await verdicts(MODULES, SPECIFICATEURS_HORS_IMPORT)).toEqual(
      attendus(SPECIFICATEURS_HORS_IMPORT),
    );
  });

  it('ce qui est legitime passe : createHash, la porte de configuration, les types', async () => {
    expect(await verdicts(MODULES, IMPORTS_PERMIS)).toEqual(attendus(IMPORTS_PERMIS));
  });

  /*
   * Une limite declaree qu'aucun test ne constate est une promesse. Celle qui
   * reste apres ce tour est que le filet lit un **litteral** : il ne concatene
   * pas, et il ne resout pas une variable. `import(…)` est le seul endroit ou le
   * specificateur calcule est refuse en bloc, parce que la forme entiere y est
   * reconnaissable ; un appel quelconque ne l'est pas, et refuser tout appel a
   * argument calcule refuserait la moitie du langage. Si un jour l'une de ces
   * deux formes se ferme, ce test devient rouge, et c'est le signal attendu.
   */
  it('la limite qui reste est constatee : hors import, le filet lit un litteral et rien de plus', async () => {
    const assemble = `${EXIGER}export const p = exiger('proc' + 'ess');`;
    expect(await messagesDe(MODULES, assemble)).toBe(0);

    const resolu = `${EXIGER}export const lire = (nom: string) => exiger(nom);`;
    expect(await messagesDe(MODULES, resolu)).toBe(0);
  });

  it('aucun module de jobs/ n’importe process, crypto ni perf_hooks', async () => {
    expect(fautifs(await MODULES.lintFiles([JOBS]))).toEqual([]);
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
 * `../config/env.js` reste permis — c'est la porte, pas le contournement. Le
 * module `node:process`, lui, est refuse par le gardien precedent, quelle que
 * soit la forme de l'import.
 *
 * ### Une liste blanche, et non une liste des detours connus
 *
 * Le premier jet enumerait les detours : `process.env`, `process['env']`,
 * `const { env } = process`. Chaque revue en a trouve un de plus, parce qu'un
 * controle de noms attrape ce a quoi on a pense et rien d'autre. La regle est
 * donc inversee : **toute** mention du nom `process` comme valeur est refusee,
 * et trois proprietes sont nommement exemptees.
 *
 * Le selecteur ne parle que des positions ou `process` designe la globale. Un
 * champ appele `process` sur un autre objet — `file.process`, `{ process: f }`,
 * `interface I { process: number }` — n'est pas la globale et reste permis,
 * sans quoi la regle mordrait sur un mot francais courant en anglais.
 *
 * ### Portee exacte, et ce qui est laisse passer **expres**
 *
 * `process.argv`, `process.exitCode`, `process.stdout` et `process.stderr`
 * restent permis : `jobs/` est le point d'entree executable, et
 * `src/replay/report.ts` montre a quoi cela ressemble en phase 0. Ce qui passe
 * par cette exclusion n'est pas de la configuration ; le jour ou un job lirait
 * un reglage dans `process.argv`, c'est cette exclusion qu'il faudrait
 * resserrer, et elle est ecrite pour cela. Toute autre propriete —
 * `process.cwd()`, `process.uptime()` — tombe : une liste blanche s'ouvre
 * expres, un cas a la fois.
 *
 * `globalThis.process.env` et `global.process.env` echappent a ce gardien : leur
 * MemberExpression n'a pas `process` pour objet. Ils tombent sur celui de
 * l'horloge, qui refuse les deux globales. Les tests ci-dessous le disent noir
 * sur blanc plutot que de laisser croire a ce selecteur une portee qu'il n'a
 * pas.
 */

/** Les proprietes de `process` qu'un job a le droit de nommer. */
const PROPRIETES_ADMISES = '/^(argv|exitCode|stdout|stderr|env)$/';

/**
 * Les positions ou `process` est un nom de champ et non la globale. `env` figure
 * dans les proprietes admises ci-dessus parce que `process.env` a son propre
 * message, plus precis : l'exempter ici evite deux messages pour une faute.
 */
const NOM_DE_CHAMP = [
  'MemberExpression[computed=false] > .property',
  'Property[computed=false] > .key',
  'PropertyDefinition[computed=false] > .key',
  'MethodDefinition[computed=false] > .key',
  'TSPropertySignature[computed=false] > .key',
  'TSMethodSignature[computed=false] > .key',
];

const CONFIGURATION = gardien({
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[object.name='process'][property.name='env']",
      message:
        'la configuration entre par src/config/env.ts : une lecture directe contourne la validation des secrets, le refus du prefixe UBAC_RISK_ et le filtre des litteraux decimaux.',
    },
    {
      selector: [
        "Identifier[name='process']",
        `:not(MemberExpression[computed=false][property.name=${PROPRIETES_ADMISES}] > .object)`,
        ...NOM_DE_CHAMP.map((position) => `:not(${position})`),
      ].join(''),
      message:
        "mention de la globale process : alias, destructuration, acces calcule ou passage en parametre, toutes menent a env. Seuls argv, exitCode, stdout et stderr sont assumes.",
    },
  ],
});

/**
 * Les chemins de lecture de l'environnement. Les cinq premiers etaient couverts
 * par autant de selecteurs ; les cinq suivants ne l'etaient pas, et c'est la
 * liste blanche — un seul selecteur — qui les ferme.
 */
const LECTURES_D_ENVIRONNEMENT: Sondes = {
  'process.env': ['export const a = process.env.DATABASE_URL;', 1],
  'destructuration du resultat': [
    'const { UBAC_RISK_MIN_CASH_PCT: b } = process.env;\nexport { b };',
    1,
  ],
  'acces calcule': ["export const c = process['env'].UBAC_STRATEGIES;", 1],
  'destructuration de process': ['const { env } = process;\nexport const d = env.DATABASE_URL;', 1],
  'alias par declaration': ['const p = process;\nexport const e = p.env.DATABASE_URL;', 1],
  'alias par affectation': ['let p;\np = process;\nexport const f = p.env.DATABASE_URL;', 1],
  'passage en parametre': [
    'const lire = (p: { env: Record<string, string | undefined> }) => p.env.DATABASE_URL;\nexport const g = lire(process);',
    1,
  ],
  'valeur dans un objet': ['export const h = { source: process };', 1],
  'parametre par defaut': ['export const i = (p = process) => p.env.DATABASE_URL;', 1],
  'propriete hors de la liste blanche': ['export const j = process.cwd();', 1],
};

const CONFIGURATION_PERMISE = permises({
  'loadConfig et un UbacConfig recu en parametre': [
    "import { loadConfig } from '../config/env.js';",
    "import type { UbacConfig } from '../config/env.js';",
    'export const url = (c: UbacConfig = loadConfig()) => c.secrets.databaseUrl;',
  ].join('\n'),
  'argv, exitCode et stdout : jobs/ est le point d’entree':
    "export const run = () => {\n  process.exitCode = process.argv.length;\n  process.stdout.write('ok');\n};",
  'une methode nommee process sur un autre objet':
    'export const f = (q: { process(): void }) => q.process();',
  'une cle nommee process': 'export const o = { process: 1 };',
  'un champ de type nomme process':
    "export interface I {\n  process: number;\n}\nexport type T = I['process'];",
});

describe('la configuration d’un job entre par src/config/env.ts', () => {
  it('les dix chemins de lecture de l’environnement recoivent le verdict attendu', async () => {
    expect(await verdicts(CONFIGURATION, LECTURES_D_ENVIRONNEMENT)).toEqual(
      attendus(LECTURES_D_ENVIRONNEMENT),
    );
  });

  it('la porte reste ouverte, et un champ nomme process sur un autre objet aussi', async () => {
    expect(await verdicts(CONFIGURATION, CONFIGURATION_PERMISE)).toEqual(
      attendus(CONFIGURATION_PERMISE),
    );
  });

  it('globalThis.process.env et global.process.env tombent sur le garde-fou de l’horloge', async () => {
    for (const code of [
      'export const a = globalThis.process.env.DATABASE_URL;',
      'export const a = global.process.env.DATABASE_URL;',
    ]) {
      expect(await messagesDe(CONFIGURATION, code)).toBe(0);
      expect(await messagesDe(HORLOGE, code)).toBe(1);
    }
  });

  /*
   * Les deux limites que l'entete nomme, constatees plutot que promises.
   * L'evaluation : la lecture est dans une chaine, aucun selecteur d'AST ne la
   * voit. Le relais par un module du depot : la valeur traverse une frontiere
   * que ce glob ne linte pas, et le job ne prononce plus rien d'interdit. Le
   * jour ou l'un des deux se ferme, ce test devient rouge — c'est le signal.
   *
   * La troisieme assertion dit ou s'arrete la limite : le nom, lui, est juge
   * sans egard a la provenance. `process` importe d'un module du depot est
   * prononce trois fois — specificateur importe, nom local, usage — donc trois
   * messages.
   */
  it('les limites declarees sont constatees, et le nom reste juge sans egard a la provenance', async () => {
    expect(await messagesDe(CONFIGURATION, "export const a = eval('process.env.X');")).toBe(0);

    const relais = "import { seuil } from '../partage/machin.js';\nexport const b = seuil;";
    expect(await messagesDe(CONFIGURATION, relais)).toBe(0);

    const nomRepris =
      "import { process } from '../partage/machin.js';\nexport const c = process.env.X;";
    expect(await messagesDe(CONFIGURATION, nomRepris)).toBe(3);
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
