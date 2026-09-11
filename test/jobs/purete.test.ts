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
 * qui apprend a ne plus le documenter.
 *
 * ## Comment lire ce fichier
 *
 * Quatre revues ont trouve ici quatre defauts, dont deux n'etaient pas des
 * formes oubliees mais des **ecarts entre cette entete et le comportement des
 * selecteurs** : « toute forme d'import » quand le selecteur ne lisait
 * qu'`ImportDeclaration`, « avec ou sans prefixe » quand le filet exigeait le
 * prefixe. Chercher la forme suivante une par une ne termine jamais ; verifier
 * chaque affirmation, si.
 *
 * Chaque affirmation porte donc un numero — `A1`…`A21` pour ce qui est tenu,
 * `L1`…`L9` pour ce qui est declare ouvert — et chaque numero est cite par le
 * test qui le met a l'epreuve. Un numero sans test est un defaut de ce fichier.
 *
 * Ce qui est cherche n'est pas un garde-fou parfait — un controle statique de
 * noms est contournable par construction, et `docs/phase-1-frontieres.md` comme
 * `test/core/risk-contract.test.ts` l'ecrivent deja pour deux autres gardiens.
 * Ce qui est cherche, c'est que **tout ce que ce fichier affirme soit vrai**, et
 * que tout le reste soit declare ouvert : un lecteur doit pouvoir se fier a
 * l'entete sans la verifier.
 *
 * ## Le terrain
 *
 * - **A1** — aucune regle de purete d'`eslint.config.js` ne couvre `src/jobs/` :
 *   elles sont posees sur `src/core/**`. Sonde : la configuration **reelle** du
 *   depot, sur `Date.now()` et `process.env`, aux deux emplacements.
 * - **A2** — le seul garde-fou que la configuration du depot applique a
 *   `src/jobs/` porte sur les noms d'ecriture d'ordre. Meme sonde.
 * - **A3** — les cinq gardiens de ce fichier lintent le glob
 *   `src/jobs/**\/*.ts`, et ce glob designe aujourd'hui au moins un fichier.
 *   Sans cette derniere moitie, chaque verdict « aucun fautif » serait vrai par
 *   vacuite : c'est la sonde qui separe « rien a signaler » de « rien de lu ».
 * - **A4** — un `eslint-disable` ecrit dans le fichier surveille n'eteint aucun
 *   de ces gardiens.
 *
 * ## Ce que les cinq gardiens attrapent
 *
 * Cinq gardiens lintent le meme glob, chacun avec ses propres regles : ce que
 * l'un refuse est refuse.
 *
 * - **A5** — l'horloge, l'aleatoire et les globales tombent sous neuf formes
 *   nommees une a une : `Date.now()`, `new Date()` sans argument,
 *   `Math.random()`, `Date['now']()`, `Math['random']()`, et les globales
 *   `crypto`, `performance`, `globalThis` et `global`. Les deux dernieres n'ont
 *   rien a voir avec le temps : elles sont refusees parce qu'elles rouvrent
 *   nommement tout ce que les autres regles ferment.
 * - **A6** — `new Date(valeur)` reste permis : l'horloge est injectee, pas bannie.
 * - **A7** — aucun module de `src/jobs/` ne prononce l'une des neuf formes.
 * - **A8** — les trois modules refuses — `process`, `crypto`, `perf_hooks` —
 *   tombent sous **onze** formes d'import, avec et sans le prefixe `node:` :
 *   le produit complet, soixante-six cellules, une par cellule. Nomme, renomme,
 *   par defaut, namespace, effet de bord, **en type**, `export … from`,
 *   `export *`, `export * as`, `import x = require(…)`, `import(…)`.
 * - **A9** — de `crypto`, seul `createHash` passe, nomme comme renomme comme
 *   reexporte, avec ou sans prefixe : le hachage est pur, et il sert au
 *   client_order_id deterministe.
 * - **A10** — le nom d'un module refuse ecrit **ailleurs qu'en position
 *   d'import** tombe, prefixe ou nu, pour les trois modules :
 *   `createRequire(…)('process')`, une table de resolution. Dans `src/jobs/`,
 *   ces trois noms ne s'ecrivent pas comme chaine litterale.
 * - **A11** — un import dynamique dont le specificateur n'est plus un litteral
 *   tombe **en bloc**, quel que soit le module vise : aucun controle de nom ne
 *   peut lire ce qui sera charge.
 * - **A12** — aucun module de `src/jobs/` n'importe ni ne nomme ces trois modules.
 * - **A13** — dix chemins de lecture de l'environnement tombent : `process.env`,
 *   et **toute autre mention du nom `process` comme valeur** — `const p =
 *   process`, `p = process`, `const { env } = process`, `process['env']`,
 *   `lire(process)`, `(p = process) => …`, `{ p: process }`.
 * - **A14** — quatre proprietes sont admises et nommees une a une : `argv`,
 *   `exitCode`, `stdout`, `stderr`. Toute autre tombe.
 * - **A15** — un champ nomme `process` sur un autre objet reste permis, dans
 *   les six positions ou le nom est une cle et non la globale.
 * - **A16** — la porte `src/config/env.ts` reste ouverte.
 * - **A17** — `globalThis.process.env` et `global.process.env` echappent au
 *   gardien de configuration et tombent sur celui de l'horloge.
 * - **A18** — aucun module de `src/jobs/` ne lit l'environnement.
 * - **A19** — `x.balances()` tombe partout, et `reconcile.ts` est le seul
 *   fichier de `src/jobs/` ou la regle parle aujourd'hui.
 * - **A20** — un adapter n'entre dans `src/jobs/` que par ses types : les six
 *   formes qui en font entrer la **valeur** tombent — import, import dynamique,
 *   effet de bord, `export … from`, `export *`, `import x = require(…)`.
 * - **A21** — `import type` et `export type` d'un adapter passent.
 *
 * A8, A10 et A13 sont ecrits ainsi a la suite de revues : un selecteur qui
 * refusait `import { env } from 'node:process'` laissait passer
 * `import p from 'node:process'` puis `p.env`, et douze tests restaient verts.
 * Enumerer les formes fautives est perdant ; refuser le module quelle que soit
 * la forme, n'admettre du nom que quatre proprietes, et **sonder le produit
 * complet** plutot qu'un echantillon, l'est moins.
 *
 * ## Ce qu'ils ne peuvent pas attraper, et qui est constate
 *
 * Des categories, et surtout pas une liste qui se pretendrait complete. Chacune
 * a sa sonde : une limite declaree qu'aucun test ne constate est une promesse,
 * et le jour ou l'une se ferme, son test devient rouge — c'est le signal.
 *
 * - **L1 — l'evaluation** : `eval('process.env.X')`, `new Function('return
 *   process')`. La lecture est dans une chaine ; aucun selecteur d'AST ne la voit.
 * - **L2 — la repartition dynamique sur un objet lui-meme calcule** : `o[k][m]()`,
 *   `Reflect.get(…)`, et de meme `ex['balances']()` ou `const { balances } = ex`.
 *   Le seul acces calcule ferme ici est celui dont l'objet est nomme (`Date`,
 *   `Math`, `process`), qui est la forme courte, donc la forme probable.
 * - **L3 — l'indirection par un module du depot** : un `src/partage/machin.ts`
 *   qui lit `process.env` et exporte le resultat ; le job l'importerait sans
 *   prononcer aucun interdit. Ce trou n'existe que parce que le glob s'arrete a
 *   `src/jobs`. Le cas ou le nom survit au passage —
 *   `import { process } from '../partage/machin.js'` — est attrape par A13, qui
 *   juge le nom et pas la provenance ; le cas ou il est renomme, non.
 * - **L4 — l'indirection par une dependance** : un paquet qui lit
 *   l'environnement ou l'horloge pour son compte, hors de tout code du depot.
 * - **L5 — le specificateur assemble hors position d'import** :
 *   `createRequire(…)('proc' + 'ess')`, `createRequire(…)(nom)`, et de meme
 *   `createRequire(…)('../adapters/db.js')`. Le filet de chaines lit un
 *   litteral ; il ne concatene pas, ne resout pas une variable, et ne connait
 *   que les trois noms de modules refuses. `import(…)` est le seul endroit ou le
 *   specificateur cesse d'etre litteral et ou la forme entiere reste refusable,
 *   parce qu'elle est reconnaissable ; un appel quelconque ne l'est pas.
 * - **L6 — les autres builtins Node** : `node:fs` sait lire un `.env`,
 *   `node:child_process` transmettre un environnement, `node:os` decrire la
 *   machine. Seuls les trois modules nommes plus haut sont refuses.
 * - **L7 — tout ce qui vit hors de `src/jobs`**, ce fichier ne lintant que ce glob.
 * - **L8 — deux faux positifs assumes**, constates plutot que passes sous
 *   silence : le mot employe comme donnee (`const s = 'crypto'`) tombe avec le
 *   nom de module, et le specificateur de type ecrit en ligne
 *   (`import { type X } from '../adapters/db.js'`) tombe comme un import de
 *   valeur. Les deux se contournent en une reecriture : nommer la donnee
 *   autrement, ecrire `import type`, qui est deja la convention du depot.
 * - **L9 — une portee plus large que promise, assumee** : un import de **type**
 *   depuis l'un des trois modules refuses tombe aussi, alors qu'il est efface a
 *   la compilation. Ce n'est pas une fuite ; c'est que ces trois noms n'ont rien
 *   a faire dans `src/jobs/`, meme en position de type.
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

/** Les fichiers **lus**, qu'une regle y ait parle ou non : la portee du glob. */
function lus(results: readonly ESLint.LintResult[]): string[] {
  return results.map((r) => relative(ROOT, r.filePath)).sort();
}

async function messagesDe(eslint: ESLint, code: string, chemin = 'src/jobs/sonde.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, chemin) });
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
  const lues = await Promise.all(
    Object.entries(sondes).map(
      async ([nom, [code]]) => [nom, await messagesDe(eslint, code)] as const,
    ),
  );
  return Object.fromEntries(lues);
}

/** Les comptes attendus, lus dans la meme table : un seul endroit a tenir. */
function attendus(sondes: Sondes): Record<string, number> {
  return Object.fromEntries(Object.entries(sondes).map(([nom, [, n]]) => [nom, n]));
}

/** Les formes qui doivent passer : meme table, compte attendu nul partout. */
function permises(codes: Readonly<Record<string, string>>): Sondes {
  return Object.fromEntries(Object.entries(codes).map(([nom, code]) => [nom, [code, 0]]));
}

/** Les formes qui doivent toutes rendre exactement un message. */
function refusees(codes: Readonly<Record<string, string>>): Sondes {
  return Object.fromEntries(Object.entries(codes).map(([nom, code]) => [nom, [code, 1]]));
}

// --- A1, A2 : le terrain, mesure sur la configuration reelle du depot --------

/**
 * La premiere phrase de cette entete est une affirmation sur un **autre**
 * fichier : `eslint.config.js`. Elle est la raison d'etre de tout ce qui suit,
 * et elle etait jusqu'ici la seule a n'avoir aucune sonde. Si la configuration
 * du depot venait un jour couvrir `src/jobs/`, ce fichier ferait double emploi
 * sans que rien ne le dise ; si elle cessait d'y appliquer le garde-fou
 * d'ecriture d'ordre, l'entete mentirait dans l'autre sens.
 *
 * Ce gardien-ci n'est donc pas l'un des cinq : il ne pose aucune regle, il lit
 * celles du depot.
 */
const DEPOT = new ESLint({ cwd: ROOT });

describe('A1, A2 — le terrain que ce fichier declare', () => {
  it('A1 : la configuration du depot ne garde ni l’horloge ni l’environnement dans jobs/, mais les garde dans core/', async () => {
    const horloge = 'export const a = Date.now();';
    const environnement = 'export const a = process.env.DATABASE_URL;';

    expect(await messagesDe(DEPOT, horloge, 'src/jobs/sonde.ts')).toBe(0);
    expect(await messagesDe(DEPOT, environnement, 'src/jobs/sonde.ts')).toBe(0);

    expect(await messagesDe(DEPOT, horloge, 'src/core/sonde.ts')).toBe(1);
    expect(await messagesDe(DEPOT, environnement, 'src/core/sonde.ts')).toBe(1);
  });

  it('A2 : le seul garde-fou que le depot applique a jobs/ porte sur les noms d’ecriture d’ordre', async () => {
    const ordre = 'export const f = (c: Record<string, () => void>) => c.createOrder();';
    expect(await messagesDe(DEPOT, ordre, 'src/jobs/sonde.ts')).toBe(1);
  });
});

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
     * `globalThis` n'est pas ici au titre de l'horloge : il est l'acces indirect
     * a tout le reste. `globalThis.Date.now()` ne ressemble a aucun selecteur
     * ci-dessus — l'objet de la MemberExpression y est `globalThis.Date`, pas
     * `Date` — et `globalThis.process.env` echappe de la meme facon au garde-fou
     * de configuration. Refuser le nom ferme les deux d'un coup, comme
     * `eslint.config.js` le fait deja pour core. `global` est le meme objet sous
     * l'autre nom : fermer une porte en laissant sa jumelle ouverte ne ferme rien.
     */
    {
      name: 'globalThis',
      message: 'globalThis rouvre Date, Math, process et crypto : la porte derobee de ce fichier',
    },
    { name: 'global', message: "global est globalThis sous l'autre nom que Node expose" },
  ],
});

/**
 * Les neuf formes, une par ligne et une par verdict. La version precedente
 * lintait les huit premieres d'un bloc et comptait huit messages : un total
 * juste peut cacher une ligne muette compensee par une ligne bavarde. La table
 * nomme la forme qui manque.
 */
const FORMES_D_HORLOGE = refusees({
  'Date.now()': 'export const a = Date.now();',
  'new Date() sans argument': 'export const a = new Date();',
  'Math.random()': 'export const a = Math.random();',
  "Date['now']()": "export const a = Date['now']();",
  "Math['random']()": "export const a = Math['random']();",
  'la globale crypto': 'export const a = crypto.randomUUID();',
  'la globale performance': 'export const a = performance.now();',
  'globalThis, qui rouvre Date': 'export const a = globalThis.Date.now();',
  'global, qui rouvre process': 'export const a = global.process.env.DATABASE_URL;',
});

describe('A5, A6, A7 — src/jobs/ n’a ni horloge propre ni aleatoire', () => {
  it('A5 : les neuf formes recoivent le verdict attendu, acces calcules et globales compris', async () => {
    expect(await verdicts(HORLOGE, FORMES_D_HORLOGE)).toEqual(attendus(FORMES_D_HORLOGE));
  });

  it('A6 : un horodatage recu en parametre reste permis', async () => {
    // L'horloge est injectee, pas bannie : `new Date(valeur)` lit une donnee.
    expect(await messagesDe(HORLOGE, "export const d = new Date('2026-09-11T00:00:00Z');")).toBe(0);
  });

  it('A7 : aucun module de jobs/ ne lit l’horloge, l’aleatoire ni les globales', async () => {
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
 * `no-restricted-imports` juge le **specificateur**, donc presque toutes les
 * formes d'import d'un coup, la ou un selecteur pose sur `ImportSpecifier` ne
 * voit que la forme qu'on a pensee. Les deux orthographes sont listees :
 * `node:process` comme `process`, que Node resout au meme module.
 *
 * Restent quatre chemins que `no-restricted-imports` ne regarde pas, fermes par
 * selecteur. Les deux derniers sont une trouvaille du produit complet :
 *
 * - `import('node:process')` : la regle ignore l'import dynamique ;
 * - `import(`node:${x}`)`, `import('node:' + 'process')`, `import(m)` : le
 *   specificateur n'est plus un litteral, donc plus aucun controle de nom ne
 *   peut le lire. La forme entiere est refusee, pas son contenu ;
 * - `import 'node:crypto'` et `import c = require('node:crypto')` : des qu'une
 *   entree porte `allowImportNames`, `no-restricted-imports` cesse de parler sur
 *   les deux formes qui ne nomment aucun import — l'effet de bord et la forme
 *   `import =` de TypeScript. Elles sont muettes pour `crypto` alors qu'elles
 *   mordent pour `process` et `perf_hooks`, qui n'ont pas d'exception. La
 *   seconde est une fuite franche : elle lie le module entier, `randomUUID`
 *   compris. Les deux selecteurs ci-dessous ne visent donc que `crypto` : les
 *   ajouter aux trois modules rendrait deux messages pour une faute.
 * - `createRequire(import.meta.url)('process')` et toute autre route qui ecrit
 *   le specificateur ailleurs qu'en position d'import : le filet attrape les
 *   trois noms, prefixes ou nus, ou que la chaine se trouve — sauf en position de
 *   source d'import, deja jugee plus haut, pour qu'un import ne rende pas deux
 *   messages pour une faute.
 *
 * ### Le nom nu, et son prix paye expres
 *
 * Ce dernier filet a d'abord ete borne au prefixe, pour ne pas mordre sur le mot
 * employe comme donnee — `export const s = 'crypto'`. La borne se defendait,
 * mais elle laissait `createRequire(…)('process')` charger le module alors que
 * l'entete promettait « avec ou sans prefixe » : un garde-fou dont on surestime
 * la portee est pire qu'un garde-fou absent, donc c'est le trou qui est ferme.
 *
 * Le faux positif est assume (L8) et constate par une sonde. Il coute peu : il
 * est bruyant au lint, il se contourne en nommant la donnee autrement,
 * `src/jobs/` n'ecrit aujourd'hui aucun de ces trois mots, et le mot reste libre
 * partout ailleurs — ce fichier ne linte que ce glob.
 *
 * `createHash` reste admis, pour la meme raison que dans core : le hachage est
 * une fonction pure, et il sert au client_order_id deterministe.
 */
const CRYPTO = 'node:crypto expose randomUUID et randomBytes : seul createHash est deterministe.';
const SANS_NOM = [
  "l'exception createHash rend no-restricted-imports muet des qu'aucun nom n'est",
  'importe : cette forme charge node:crypto sans le dire.',
].join(' ');
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
      selector: "ImportDeclaration[specifiers.length=0][source.value=/^(node:)?crypto$/]",
      message: `import d'effet de bord : ${SANS_NOM}`,
    },
    {
      selector:
        "TSImportEqualsDeclaration > TSExternalModuleReference > Literal[value=/^(node:)?crypto$/]",
      message: `import = require : ${SANS_NOM} Cette forme-ci lie en plus le module entier, randomUUID compris.`,
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
 * Les onze formes qui font entrer un module, pour un specificateur donne.
 * `nom` est un export **refuse** du module vise : `env`, `randomUUID`,
 * `performance`. La forme `en type` est incluse a dessein — L9 dit qu'elle
 * tombe aussi, et la table le constate au lieu de le supposer.
 */
function formesDImport(spec: string, nom: string): Record<string, string> {
  return {
    nomme: `import { ${nom} } from '${spec}';\nexport const a = ${nom};`,
    renomme: `import { ${nom} as x } from '${spec}';\nexport const a = x;`,
    'par defaut': `import x from '${spec}';\nexport const a = x;`,
    namespace: `import * as x from '${spec}';\nexport const a = x;`,
    'effet de bord': `import '${spec}';\nexport const a = 1;`,
    'en type': `import type { X } from '${spec}';\nexport type Y = X;`,
    'reexport nomme': `export { ${nom} } from '${spec}';`,
    'reexport total': `export * from '${spec}';`,
    'reexport en namespace': `export * as x from '${spec}';`,
    'import egale require': `import x = require('${spec}');\nexport const a = x;`,
    dynamique: `export const a = await import('${spec}');`,
  };
}

/** Les six specificateurs refuses, chacun avec un de ses exports interdits. */
const SPECIFICATEURS_REFUSES: readonly (readonly [spec: string, exportRefuse: string])[] = [
  ['process', 'env'],
  ['node:process', 'env'],
  ['crypto', 'randomUUID'],
  ['node:crypto', 'randomUUID'],
  ['perf_hooks', 'performance'],
  ['node:perf_hooks', 'performance'],
];

/**
 * Le produit complet : six specificateurs par onze formes, soixante-six
 * cellules, un message attendu dans chacune. L'echantillon precedent en couvrait
 * vingt et manquait `crypto / effet de bord` et `crypto / import egale require`,
 * que rien ne laissait deduire des autres : c'est `allowImportNames` qui les
 * taisait, et seul `crypto` en porte. Un echantillon ne trouve pas ce genre de
 * creux ; un produit, si.
 */
const PRODUIT_COMPLET: Sondes = Object.fromEntries(
  SPECIFICATEURS_REFUSES.flatMap(([spec, nom]) =>
    Object.entries(formesDImport(spec, nom)).map(
      ([forme, code]) => [`${spec} / ${forme}`, [code, 1] as const] as const,
    ),
  ),
);

/**
 * Trois specificateurs qui ne sont plus litteraux, trois comptes voulus. Le
 * gabarit n'ecrit aucun litteral de chaine au sens de l'AST : seul le filet des
 * specificateurs calcules parle. Les deux autres ecrivent le nom en clair
 * quelque part, et le filet de chaines le lit aussi : deux defauts distincts,
 * donc deux messages. La derniere ligne vise un module quelconque : la forme est
 * refusee pour elle-meme, pas pour ce qu'elle charge.
 */
const SPECIFICATEURS_CALCULES: Sondes = {
  'dynamique en gabarit': ['export const p = await import(`node:process`);', 1],
  'dynamique concatene': ["export const p = await import('node:' + 'process');", 2],
  'dynamique par variable': ["const m = 'node:process';\nexport const p = await import(m);", 2],
  'dynamique vers un module quelconque': [
    "const m = '../partage/machin.js';\nexport const p = await import(m);",
    1,
  ],
};

const IMPORTS_PERMIS = permises({
  'createHash, parce que le hachage est pur':
    "import { createHash } from 'node:crypto';\nexport const a = createHash('sha256');",
  'createHash sans le prefixe node:, meme raison':
    "import { createHash } from 'crypto';\nexport const a = createHash('sha256');",
  'createHash renomme': "import { createHash as h } from 'node:crypto';\nexport const a = h('sha256');",
  'createHash reexporte': "export { createHash } from 'node:crypto';",
  'la porte de configuration':
    "import { loadConfig } from '../config/env.js';\nexport const c = loadConfig();",
  'un adapter en type': "import type { UbacDatabase } from '../adapters/db.js';\nexport type X = UbacDatabase;",
  'un import dynamique litteral vers un module quelconque':
    "export const a = await import('../partage/machin.js');",
});

/** L'entete d'un module qui se procure `require` : la route la plus courte. */
const EXIGER = [
  "import { createRequire } from 'node:module';",
  'const exiger = createRequire(import.meta.url);',
  '',
].join('\n');

/**
 * Le nom d'un module refuse, ecrit ailleurs qu'en position d'import. Les six
 * premieres lignes sont la mutation qui compte : rendre au selecteur sa borne
 * `^node:` fait passer les trois lignes nues a zero, ce qui est exactement le
 * trou qu'une revue a trouve, et la table nomme lesquelles. La table de
 * resolution dit que le filet ne connait pas `createRequire` et n'a pas a le
 * connaitre : il juge la chaine, pas l'appel. La derniere ligne est le prix de
 * cette portee, constate plutot que promis (L8).
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

describe('A8 a A12 — un module refuse n’entre par aucune forme d’import', () => {
  it('A8, A9, L9 : les soixante-six cellules du produit complet recoivent le verdict attendu', async () => {
    expect(Object.keys(PRODUIT_COMPLET)).toHaveLength(66);
    expect(await verdicts(MODULES, PRODUIT_COMPLET)).toEqual(attendus(PRODUIT_COMPLET));
  });

  it('A11 : le specificateur calcule est refuse en bloc, quel que soit le module vise', async () => {
    expect(await verdicts(MODULES, SPECIFICATEURS_CALCULES)).toEqual(
      attendus(SPECIFICATEURS_CALCULES),
    );
  });

  it('A10, L8 : le nom hors position d’import tombe, avec et sans prefixe, pour les trois modules', async () => {
    expect(await verdicts(MODULES, SPECIFICATEURS_HORS_IMPORT)).toEqual(
      attendus(SPECIFICATEURS_HORS_IMPORT),
    );
  });

  it('A9, A16 : ce qui est legitime passe — createHash, la porte de configuration, les types', async () => {
    expect(await verdicts(MODULES, IMPORTS_PERMIS)).toEqual(attendus(IMPORTS_PERMIS));
  });

  it('A12 : aucun module de jobs/ n’importe process, crypto ni perf_hooks', async () => {
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
 * etre tenue pour les jobs, et A1 le constate sur la configuration reelle.
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
 * donc inversee (A13) : **toute** mention du nom `process` comme valeur est
 * refusee, et quatre proprietes sont nommement exemptees (A14).
 *
 * Le selecteur ne parle que des positions ou `process` designe la globale. Un
 * champ appele `process` sur un autre objet n'est pas la globale et reste
 * permis, sans quoi la regle mordrait sur un mot francais courant en anglais :
 * les six positions de A15 sont sondees une a une.
 *
 * Les quatre proprietes admises le sont parce que `jobs/` est le point d'entree
 * executable, et `src/replay/report.ts` montre a quoi cela ressemble en phase 0.
 * Ce qui passe par cette exclusion n'est pas de la configuration ; le jour ou un
 * job lirait un reglage dans `process.argv`, c'est cette exclusion qu'il
 * faudrait resserrer, et elle est ecrite pour cela. Toute autre propriete —
 * `process.cwd()`, `process.uptime()` — tombe : une liste blanche s'ouvre
 * expres, un cas a la fois.
 *
 * `globalThis.process.env` et `global.process.env` echappent a ce gardien : leur
 * MemberExpression n'a pas `process` pour objet. Ils tombent sur celui de
 * l'horloge (A17), qui refuse les deux globales — dit noir sur blanc plutot que
 * de laisser croire a ce selecteur une portee qu'il n'a pas.
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
  'les quatre proprietes admises : jobs/ est le point d’entree':
    "export const run = () => {\n  process.exitCode = process.argv.length;\n  process.stdout.write('ok');\n  process.stderr.write('ko');\n};",
  'une methode nommee process sur un autre objet':
    'export const f = (q: { process(): void }) => q.process();',
  'une cle nommee process': 'export const o = { process: 1 };',
  'un champ et une methode de classe nommes process':
    'export class C {\n  process = 1;\n\n  lire(): number {\n    return this.process;\n  }\n}',
  'une methode de classe nommee process':
    'export class D {\n  process(): void {}\n}',
  'un champ de type nomme process':
    "export interface I {\n  process: number;\n}\nexport type T = I['process'];",
});

describe('A13 a A18 — la configuration d’un job entre par src/config/env.ts', () => {
  it('A13 : les dix chemins de lecture de l’environnement recoivent le verdict attendu', async () => {
    expect(await verdicts(CONFIGURATION, LECTURES_D_ENVIRONNEMENT)).toEqual(
      attendus(LECTURES_D_ENVIRONNEMENT),
    );
  });

  it('A14, A15, A16 : les quatre proprietes admises, la porte, et le nom employe comme cle', async () => {
    expect(await verdicts(CONFIGURATION, CONFIGURATION_PERMISE)).toEqual(
      attendus(CONFIGURATION_PERMISE),
    );
  });

  it('A17 : globalThis.process.env et global.process.env tombent sur le garde-fou de l’horloge', async () => {
    for (const code of [
      'export const a = globalThis.process.env.DATABASE_URL;',
      'export const a = global.process.env.DATABASE_URL;',
    ]) {
      expect(await messagesDe(CONFIGURATION, code)).toBe(0);
      expect(await messagesDe(HORLOGE, code)).toBe(1);
    }
  });

  it('A18 : aucun module de jobs/ ne lit l’environnement', async () => {
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
 * La regle ne connait pas `reconcile.ts` : elle mord partout, et c'est le test
 * de glob qui dit ou elle a le droit de parler. Le controle n'a donc qu'un seul
 * fichier a signaler aujourd'hui — `reconcile.ts` est le seul job livre — et
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

const APPELS_DE_SOLDES: Sondes = {
  "l'appel nomme": ['declare const ex: { balances(): void };\nexport const a = () => ex.balances();', 1],
  'un autre appel sur le meme objet': [
    'declare const ex: { ticker(): void };\nexport const a = () => ex.ticker();',
    0,
  ],
};

describe('A19 — seule la reconciliation lit les soldes de l’exchange', () => {
  it('A19 : la regle mord sur l’appel nomme et se tait sur un autre', async () => {
    expect(await verdicts(LECTURE_DES_SOLDES, APPELS_DE_SOLDES)).toEqual(
      attendus(APPELS_DE_SOLDES),
    );
  });

  it('A19 : reconcile.ts est le seul fichier de jobs/ ou la regle parle', async () => {
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
 * charge. Le run, lui, compose les adapters et les importera en valeur ; ce
 * controle dit que la **reconciliation** n'en a pas besoin, ce qui est ce qui la
 * rend testable contre des doubles.
 *
 * ### Six formes, et non une
 *
 * Ce gardien ne visait qu'`ImportDeclaration`, alors que l'entete affirmait que
 * seuls des types entrent. `await import('../adapters/db.js')` charge le module
 * autant qu'un `import`, et `export … from`, `export *`, `export * as` et
 * `import x = require(…)` aussi : cinq formes hors des limites declarees, dont
 * l'import dynamique, deja traite pour les modules refuses. Le meme traitement
 * s'applique donc ici, forme par forme.
 *
 * `importKind` et `exportKind` separent ici la valeur du type, donc `import
 * type` et `export type` passent — la ou les modules refuses tombent meme en
 * type (L9). Un specificateur de type ecrit **en ligne**,
 * `import { type X } from …`, porte `importKind: 'value'` sur la declaration et
 * tombe comme un import de valeur : faux positif assume (L8), qui se corrige en
 * ecrivant `import type`, deja la convention du depot.
 */
const ADAPTER_EN_VALEUR = "jobs/ n'importe des adapters que leurs types : cette forme en charge la valeur, donc ccxt et pg.";
const IMPORTS_DE_VALEUR = gardien({
  'no-restricted-syntax': [
    'error',
    {
      selector: "ImportDeclaration[importKind='value'][source.value=/adapters/]",
      message: ADAPTER_EN_VALEUR,
    },
    { selector: "ImportExpression[source.value=/adapters/]", message: ADAPTER_EN_VALEUR },
    {
      selector: "ExportNamedDeclaration[exportKind='value'][source.value=/adapters/]",
      message: ADAPTER_EN_VALEUR,
    },
    {
      selector: "ExportAllDeclaration[exportKind='value'][source.value=/adapters/]",
      message: ADAPTER_EN_VALEUR,
    },
    {
      selector: "TSExternalModuleReference > Literal[value=/adapters/]",
      message: ADAPTER_EN_VALEUR,
    },
  ],
});

const ADAPTERS_EN_VALEUR: Sondes = refusees({
  import: "import { openDatabase } from '../adapters/db.js';\nexport const x = openDatabase;",
  'effet de bord': "import '../adapters/db.js';\nexport const x = 1;",
  dynamique: "export const x = await import('../adapters/db.js');",
  'reexport nomme': "export { openDatabase } from '../adapters/db.js';",
  'reexport total': "export * from '../adapters/db.js';",
  'reexport en namespace': "export * as db from '../adapters/db.js';",
  'import egale require': "import db = require('../adapters/db.js');\nexport const x = db;",
  'specificateur de type en ligne, faux positif assume':
    "import { type UbacDatabase } from '../adapters/db.js';\nexport type X = UbacDatabase;",
});

const ADAPTERS_EN_TYPE = permises({
  'import type': "import type { UbacDatabase } from '../adapters/db.js';\nexport type X = UbacDatabase;",
  'export type': "export type { UbacDatabase } from '../adapters/db.js';",
  'un import de valeur hors des adapters':
    "import { decide } from '../core/decide.js';\nexport const x = decide;",
});

describe('A20, A21 — les adapters n’entrent dans la reconciliation que par leurs types', () => {
  it('A20, L8 : les huit formes qui font entrer la valeur recoivent le verdict attendu', async () => {
    expect(await verdicts(IMPORTS_DE_VALEUR, ADAPTERS_EN_VALEUR)).toEqual(
      attendus(ADAPTERS_EN_VALEUR),
    );
  });

  it('A21 : le type passe, et un import de valeur hors des adapters aussi', async () => {
    expect(await verdicts(IMPORTS_DE_VALEUR, ADAPTERS_EN_TYPE)).toEqual(attendus(ADAPTERS_EN_TYPE));
  });

  it('A20 : aucun module de jobs/ n’importe un adapter en valeur', async () => {
    expect(fautifs(await IMPORTS_DE_VALEUR.lintFiles([JOBS]))).toEqual([]);
  });
});

// --- A3, A4 : la portee du glob et l'impossibilite d'eteindre ---------------

/** Les cinq gardiens, dans l'ordre de l'entete : A3 parle d'eux tous. */
const LES_CINQ = [
  ['horloge', HORLOGE],
  ['modules', MODULES],
  ['configuration', CONFIGURATION],
  ['soldes', LECTURE_DES_SOLDES],
  ['adapters', IMPORTS_DE_VALEUR],
] as const;

describe('A3, A4 — la portee du glob, et un gardien qu’on n’eteint pas', () => {
  /*
   * Quatre des cinq gardiens concluent par « aucun fichier fautif ». Un glob qui
   * ne designerait plus rien — un repertoire renomme, un `**` perdu — rendrait
   * ces quatre verdicts verts sans avoir rien lu. Cette sonde separe les deux
   * cas : le glob lit au moins un fichier, il les lit tous les cinq de la meme
   * facon, et il ne lit que `src/jobs/`.
   */
  it('A3 : les cinq gardiens lisent le meme glob, non vide, et rien hors de src/jobs/', async () => {
    for (const [nom, eslint] of LES_CINQ) {
      const fichiers = lus(await eslint.lintFiles([JOBS]));
      expect(fichiers, nom).toContain(RECONCILE);
      expect(fichiers.filter((f) => !f.startsWith('src/jobs/')), nom).toEqual([]);
    }
  });

  /*
   * `noInlineConfig` fait rendre deux messages a chaque sonde : le commentaire
   * desarmant, signale comme sans effet, et la faute qu'il pretendait couvrir.
   * C'est la faute qui compte ; le compte a deux la prouve presente.
   */
  it('A4 : un eslint-disable ecrit dans le fichier surveille n’eteint aucun gardien', async () => {
    const desarmes: readonly (readonly [nom: string, eslint: ESLint, code: string])[] = [
      [
        'horloge',
        HORLOGE,
        '/* eslint-disable no-restricted-syntax */\nexport const a = Date.now();',
      ],
      [
        'modules',
        MODULES,
        "/* eslint-disable no-restricted-imports */\nimport p from 'node:process';\nexport const a = p;",
      ],
      [
        'configuration',
        CONFIGURATION,
        '// eslint-disable-next-line no-restricted-syntax\nexport const a = process.env.X;',
      ],
      [
        'soldes',
        LECTURE_DES_SOLDES,
        '/* eslint-disable */\ndeclare const ex: { balances(): void };\nexport const a = () => ex.balances();',
      ],
      [
        'adapters',
        IMPORTS_DE_VALEUR,
        "/* eslint-disable */\nimport { openDatabase } from '../adapters/db.js';\nexport const x = openDatabase;",
      ],
    ];
    for (const [nom, eslint, code] of desarmes) {
      expect(await messagesDe(eslint, code), nom).toBe(2);
    }
  });
});

// --- L1 a L7 : les limites declarees, constatees ----------------------------

/**
 * Chaque categorie declaree ouverte a sa sonde, et chaque sonde attend zero.
 * Le jour ou l'une de ces formes se ferme, son test devient rouge : c'est le
 * signal que l'entete doit etre resserree. L'inverse — une limite ecrite mais
 * jamais mesuree — est ce que les quatre revues ont reproche a ce fichier.
 */
describe('L1 a L7 — les limites declarees sont constatees', () => {
  it('L1 : l’evaluation echappe aux trois gardiens de noms', async () => {
    const evaluation = "export const a = eval('process.env.X');";
    const fabrique = "export const f = new Function('return process');";
    for (const eslint of [CONFIGURATION, MODULES, HORLOGE]) {
      expect(await messagesDe(eslint, evaluation)).toBe(0);
      expect(await messagesDe(eslint, fabrique)).toBe(0);
    }
  });

  it('L2 : la repartition sur un objet calcule echappe, y compris pour les soldes', async () => {
    const calcule = 'declare const o: Record<string, Record<string, () => unknown>>;\ndeclare const k: string;\nexport const a = () => o[k]!.now!();';
    expect(await messagesDe(HORLOGE, calcule)).toBe(0);
    expect(await messagesDe(HORLOGE, "export const a = Reflect.get(Date, 'now');")).toBe(0);
    expect(
      await messagesDe(
        LECTURE_DES_SOLDES,
        "declare const ex: Record<string, () => unknown>;\nexport const a = () => ex['balances']!();",
      ),
    ).toBe(0);
    expect(
      await messagesDe(
        LECTURE_DES_SOLDES,
        'declare const ex: { balances(): void };\nconst { balances } = ex;\nexport const a = () => balances();',
      ),
    ).toBe(0);
  });

  /*
   * La troisieme assertion dit ou s'arrete L3 : le nom, lui, est juge sans egard
   * a la provenance. `process` importe d'un module du depot est prononce trois
   * fois — specificateur importe, nom local, usage — donc trois messages.
   */
  it('L3 : le relais par un module du depot echappe, mais le nom repris est juge sans egard a la provenance', async () => {
    const relais = "import { seuil } from '../partage/machin.js';\nexport const b = seuil;";
    expect(await messagesDe(CONFIGURATION, relais)).toBe(0);

    const nomRepris =
      "import { process } from '../partage/machin.js';\nexport const c = process.env.X;";
    expect(await messagesDe(CONFIGURATION, nomRepris)).toBe(3);
  });

  it('L4 : une dependance tierce n’est jugee par aucun de ces gardiens', async () => {
    const dependance = "import ccxt from 'ccxt';\nexport const a = ccxt;";
    for (const [nom, eslint] of LES_CINQ) {
      expect(await messagesDe(eslint, dependance), nom).toBe(0);
    }
  });

  it('L5 : hors import, le filet lit un litteral et ne connait que les trois noms refuses', async () => {
    expect(await messagesDe(MODULES, `${EXIGER}export const p = exiger('proc' + 'ess');`)).toBe(0);
    expect(await messagesDe(MODULES, `${EXIGER}export const lire = (nom: string) => exiger(nom);`)).toBe(0);
    expect(
      await messagesDe(IMPORTS_DE_VALEUR, `${EXIGER}export const db = exiger('../adapters/db.js');`),
    ).toBe(0);
  });

  it('L6 : les autres builtins Node ne sont pas refuses', async () => {
    const builtins = permises({
      'node:fs': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;",
      'node:child_process': "import { execSync } from 'node:child_process';\nexport const a = execSync;",
      'node:os': "import { hostname } from 'node:os';\nexport const a = hostname;",
    });
    expect(await verdicts(MODULES, builtins)).toEqual(attendus(builtins));
  });

  /*
   * L7 se mesure par ce que le glob ne lit pas. `src/core/` contient des
   * fichiers, `HORLOGE` mord sur `Date.now()` — et pourtant aucun fichier de
   * core n'apparait dans un verdict : ce fichier ne juge que `src/jobs/`.
   */
  it('L7 : rien hors de src/jobs n’est lu, alors meme que les regles y mordraient', async () => {
    const dansJobs = lus(await HORLOGE.lintFiles([JOBS]));
    const dansCore = lus(await HORLOGE.lintFiles(['src/core/**/*.ts']));

    expect(dansCore.length).toBeGreaterThan(0);
    expect(dansJobs.filter((f) => dansCore.includes(f))).toEqual([]);
  });
});
