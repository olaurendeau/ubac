import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterEach, describe, expect, it } from 'vitest';

import type { MidPrices } from '../../src/core/risk.js';
import type { Price } from '../../src/core/types.js';
import type { IntentionDeCession, SortieInput, SortieVerrouillee } from '../../src/jobs/liquidate.js';
import * as liquidate from '../../src/jobs/liquidate.js';
import { reconcile } from '../../src/jobs/reconcile.js';
import type { Scenario } from './doubles.js';
import { harnais, ordreOuvert, solde } from './doubles.js';

/**
 * Le verrou de la sortie propre. Ce fichier n'eprouve pas ce que le plan dit —
 * c'est `liquidate.test.ts` — mais ce que le module **ne peut pas faire**.
 *
 * Chaque affirmation porte un numero, et chaque numero est cite par le test qui
 * le met a l'epreuve. Un numero sans test est un defaut de ce fichier.
 *
 * ## Ce qui est tenu
 *
 * - **V1** — `appliquerSortie` rend toujours `VERROUILLE`. Sonde : une matrice
 *   d'entrees, du portefeuille vide a celui charge d'ordres ouverts.
 * - **V2** — **aucun argument** ne leve le refus. La fonction n'a qu'un
 *   parametre ; les arguments surnumeraires — drapeau, objet d'options, chaine
 *   d'armement — sont sondes un a un, passes par une reference deliberement
 *   detypee.
 * - **V3** — **aucune variable d'environnement** ne le leve. Huit noms
 *   plausibles, chacun avec sa sonde. Le module n'en lit d'ailleurs aucune :
 *   `test/jobs/purete.test.ts` (A18) l'interdit a tout `src/jobs/`.
 * - **V4** — **aucune forme d'appel** ne le leve : appel direct, `call`, `apply`,
 *   `Reflect.apply`, methode d'un objet, fonction detachee de son module.
 * - **V5** — le refus n'est pas un habillage : le plan qu'il porte est
 *   exactement celui de `planifierSortie`, et rien d'autre n'est rendu.
 * - **V6** — le module est **synchrone**. Ni `async`, ni `await`, ni `Promise`,
 *   ni import dynamique. Sept formes, une sonde chacune, puis le fichier livre.
 *   Une fonction qui ne sait pas attendre ne sait pas parler a un exchange.
 * - **V7** — ses imports sont ceux-ci et pas d'autres : huit declarations, toutes
 *   dans une liste blanche, et les deux modules a effet — l'adapter Coinbase et
 *   `reconcile.ts` — n'entrent qu'en **type**, donc effaces a la compilation.
 *   `validate` n'entre pas non plus, nomme ou renomme : la couche risque n'est
 *   pas appelee ici, et c'est une decision, pas un oubli.
 * - **V8** — la surface publique est exactement celle-ci. Neuf noms, enumeres.
 *   Un export de plus est un test rouge, ce qui est le point : on n'ajoute pas
 *   discretement une porte.
 * - **V9** — aucune des chaines habituelles de contournement n'apparait dans le
 *   source.
 * - **V10** — quatre affirmations de **type** tiennent a la compilation, donc a
 *   chaque `tsc` : la contrepartie d'une cession ne peut pas etre EUR, une
 *   cession ne peut pas ne pas etre post-only, `SortieVerrouillee` n'a pas
 *   d'autre statut, et `SortieInput` ne porte aucun champ appelable. Trois
 *   `@ts-expect-error` et une affectation : chacune echoue si le type s'elargit.
 * - **V11** — le fichier livre est **dans le perimetre** des garde-fous du depot,
 *   et la configuration reelle ne signale rien dessus. Sans la premiere moitie,
 *   la seconde serait vraie par vacuite.
 *
 * ## Ce que ce fichier ne prouve pas
 *
 * - **W1 — V9 est un garde-fou grossier**, exactement du meme statut que le
 *   test de contrat de `src/core/risk.ts` : une recherche de chaines se
 *   contourne en nommant la porte autrement. Ce qui tient vraiment est V8, qui
 *   enumere la surface, et V6 avec V7, qui enumerent les moyens.
 * - **W2 — V6 et V7 sont des controles de noms sur l'arbre syntaxique.** Un
 *   effet passe par un module de `core/` qui, lui, ferait l'appel, leur
 *   echapperait ; c'est la meme limite que celle de `docs/phase-1-frontieres.md`,
 *   et `eslint.config.js` garde `src/core/**` contre exactement cela.
 * - **W3 — rien ici ne prouve l'absence d'execution.** La garantie structurelle
 *   reste celle du §7 : une cle scopee sur un portefeuille dedie, sans
 *   permission de sortie, et en phase 1 sans permission de trade.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIQUIDATE = 'src/jobs/liquidate.ts';
const SOURCE = readFileSync(resolve(ROOT, LIQUIDATE), 'utf8');

const prix = (v: string): Price => new Decimal(v) as Price;
const MIDS: MidPrices = { BTC: prix('60000'), ETH: prix('3000') };

async function entree(scenario: Scenario): Promise<SortieInput> {
  const resultat = await reconcile(harnais(scenario).input);
  if (resultat.status !== 'RECONCILED') throw new Error('scenario non reconciliable');
  return {
    runDate: '2026-09-12',
    soldes: resultat.balances,
    ouverts: scenario.open ?? [],
    mids: MIDS,
  };
}

/** Les entrees de V1 : du portefeuille vide a celui qu'on voudrait vraiment sortir. */
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'portefeuille vide': {},
  'cash seul': { balances: [solde('USDC', '40000')] },
  'positions sans ordre ouvert': { balances: [solde('BTC', '0.5'), solde('ETH', '10')] },
  'positions et ordres ouverts': {
    balances: [solde('BTC', '0.5'), solde('ETH', '10'), solde('USDC', '40000')],
    open: [ordreOuvert(), ordreOuvert({ exchangeId: 'z' })],
  },
  'residus seuls': { balances: [solde('BTC', '0.0001')] },
};

function refus(resultat: SortieVerrouillee): void {
  expect(resultat.statut).toBe('VERROUILLE');
  expect(resultat.phase).toBe(liquidate.PHASE_COURANTE);
  expect(resultat.phaseRequise).toBe(liquidate.PHASE_D_APPLICATION);
  expect(liquidate.PHASE_COURANTE).toBeLessThan(liquidate.PHASE_D_APPLICATION);
}

// --- V1, V5 : le refus, quelle que soit l'entree -----------------------------

describe('V1, V5 — appliquerSortie refuse, toujours', () => {
  it.each(Object.keys(SCENARIOS))('V1 : %s', async (nom) => {
    const scenario = SCENARIOS[nom];
    expect(scenario).toBeDefined();
    refus(liquidate.appliquerSortie(await entree(scenario ?? {})));
  });

  it('V5 : le refus porte le plan de planifierSortie, et rien d’autre', async () => {
    const e = await entree(SCENARIOS['positions et ordres ouverts'] ?? {});
    const resultat = liquidate.appliquerSortie(e);

    expect(resultat.plan).toEqual(liquidate.planifierSortie(e));
    expect(Object.keys(resultat).sort()).toEqual([
      'motif',
      'phase',
      'phaseRequise',
      'plan',
      'statut',
    ]);
  });
});

// --- V2 : aucun argument ne leve le refus ------------------------------------

/**
 * La reference detypee est **le** point de ce bloc : en TypeScript, ces appels
 * ne compilent pas, donc un test type ne prouverait rien de plus que la
 * signature. C'est a l'execution que la question se pose — un parametre oublie,
 * un champ lu sur `arguments`, une option ignoree en silence.
 */
const detypee = liquidate.appliquerSortie as unknown as (...args: unknown[]) => SortieVerrouillee;

const ARGUMENTS_SURNUMERAIRES: Readonly<Record<string, readonly unknown[]>> = {
  'drapeau booleen': [true],
  'objet force': [{ force: true }],
  'objet bypass': [{ bypass: true, dryRun: false }],
  'chaine d’armement': ['ARM'],
  'phase demandee': [3],
  'fonction applicateur': [() => Promise.resolve()],
  'trois arguments a la fois': [true, { force: true }, 'ARM'],
};

describe('V2 — aucun argument supplementaire ne leve le refus', () => {
  it.each(Object.keys(ARGUMENTS_SURNUMERAIRES))('V2 : %s', async (nom) => {
    const e = await entree(SCENARIOS['positions et ordres ouverts'] ?? {});
    refus(detypee(e, ...(ARGUMENTS_SURNUMERAIRES[nom] ?? [])));
  });

  it('V2 : un champ ajoute a l’entree elle-meme ne leve rien non plus', async () => {
    const e = await entree(SCENARIOS['positions et ordres ouverts'] ?? {});
    refus(detypee({ ...e, force: true, dryRun: false, phase: 3, armed: true }));
  });
});

// --- V3 : aucune variable d'environnement ne leve le refus -------------------

const VARIABLES = [
  'UBAC_FORCE',
  'UBAC_LIQUIDATE',
  'UBAC_LIQUIDATE_ARM',
  'UBAC_PHASE',
  'UBAC_ALLOW_EXECUTION',
  'UBAC_BYPASS',
  'UBAC_DRY_RUN',
  'NODE_ENV',
] as const;

const AVANT = new Map(VARIABLES.map((nom) => [nom, process.env[nom]]));

afterEach(() => {
  for (const [nom, valeur] of AVANT) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
});

describe('V3 — aucune variable d’environnement ne leve le refus', () => {
  it.each(VARIABLES)('V3 : %s', async (nom) => {
    process.env[nom] = nom === 'UBAC_PHASE' ? '3' : '1';
    refus(liquidate.appliquerSortie(await entree(SCENARIOS['positions et ordres ouverts'] ?? {})));
  });

  it('V3 : les huit posees ensemble ne le levent pas davantage', async () => {
    for (const nom of VARIABLES) process.env[nom] = 'true';
    refus(liquidate.appliquerSortie(await entree(SCENARIOS['positions et ordres ouverts'] ?? {})));
  });
});

// --- V4 : aucune forme d'appel ne leve le refus ------------------------------

describe('V4 — aucune forme d’appel ne leve le refus', () => {
  it('V4 : direct, call, apply, Reflect.apply, methode, fonction detachee', async () => {
    const e = await entree(SCENARIOS['positions et ordres ouverts'] ?? {});
    const detachee = liquidate.appliquerSortie;
    const porteur = { appliquer: liquidate.appliquerSortie };

    refus(liquidate.appliquerSortie(e));
    refus(detachee(e));
    refus(porteur.appliquer(e));
    refus(detypee.call(null, e));
    refus(detypee.apply(null, [e]));
    refus(Reflect.apply(detypee, null, [e]));
  });
});

// --- V6, V7 : les moyens, mesures sur l'arbre syntaxique ---------------------

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
  return new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: [{ ...BASE, rules }] });
}

function fautifs(results: readonly ESLint.LintResult[]): string[] {
  return results.filter((r) => r.messages.length > 0).map((r) => relative(ROOT, r.filePath)).sort();
}

async function messagesDe(eslint: ESLint, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, 'src/jobs/sonde.ts') });
  return result?.messages.length ?? 0;
}

/** Pour chaque forme : le code a linter et le nombre exact de messages attendu. */
type Sondes = Readonly<Record<string, readonly [code: string, messages: number]>>;

async function verdicts(eslint: ESLint, sondes: Sondes): Promise<Record<string, number>> {
  const lues = await Promise.all(
    Object.entries(sondes).map(async ([nom, [code]]) => [nom, await messagesDe(eslint, code)] as const),
  );
  return Object.fromEntries(lues);
}

function attendus(sondes: Sondes): Record<string, number> {
  return Object.fromEntries(Object.entries(sondes).map(([nom, [, n]]) => [nom, n]));
}

const ASYNCHRONE = 'ce module est synchrone : ce qui sait attendre sait parler a un exchange.';
const SYNCHRONE = gardien({
  'no-restricted-syntax': [
    'error',
    { selector: 'AwaitExpression', message: ASYNCHRONE },
    { selector: 'FunctionDeclaration[async=true]', message: ASYNCHRONE },
    { selector: 'FunctionExpression[async=true]', message: ASYNCHRONE },
    { selector: 'ArrowFunctionExpression[async=true]', message: ASYNCHRONE },
    { selector: "Identifier[name='Promise']", message: ASYNCHRONE },
    { selector: 'ImportExpression', message: ASYNCHRONE },
  ],
});

const FORMES_ASYNCHRONES: Sondes = {
  'fonction async declaree': ['export async function f() { return 1; }', 1],
  'expression de fonction async': ['export const f = async function () { return 1; };', 1],
  'fleche async': ['export const f = async () => 1;', 1],
  await: ['export const f = async () => await Promise.resolve(1);', 3],
  'promesse construite': ['export const f = () => new Promise(() => undefined);', 1],
  'type de retour promis': ['export function f(): Promise<number> { return Promise.resolve(1); }', 2],
  'import dynamique': ["export const f = () => import('../adapters/db.js');", 1],
  'une fonction synchrone ne dit rien': ['export function f(): number { return 1; }', 0],
};

describe('V6 — le module est synchrone', () => {
  it('V6 : les sept formes asynchrones recoivent le verdict attendu', async () => {
    expect(await verdicts(SYNCHRONE, FORMES_ASYNCHRONES)).toEqual(attendus(FORMES_ASYNCHRONES));
  });

  it('V6 : le fichier livre n’en porte aucune', async () => {
    const resultats = await SYNCHRONE.lintFiles([LIQUIDATE]);
    // Le fichier a bien ete lu : sans cela, « aucun fautif » serait vrai par vacuite.
    expect(resultats.map((r) => relative(ROOT, r.filePath))).toEqual([LIQUIDATE]);
    expect(fautifs(resultats)).toEqual([]);
  });
});

const HORS_LISTE = "cet import n'est pas dans la liste blanche de liquidate.ts.";
const EN_VALEUR = 'ce module ne doit entrer que par ses types : en valeur, il porte un effet.';
/**
 * Les barres obliques sont echappees : esquery lit une expression reguliere
 * jusqu'a la premiere `/` non echappee, et s'arreterait au milieu du chemin.
 */
const LISTE_BLANCHE = String.raw`^(decimal\.js|\.\.\/core\/(order-id|portfolio|risk|types)\.js|\.\.\/adapters\/coinbase\.js|\.\/reconcile\.js)$`;

const RISQUE =
  "la couche risque n'est pas appelee ici : ses seuils gouvernent un reequilibrage, pas un arret.";

const IMPORTS = gardien({
  'no-restricted-syntax': [
    'error',
    { selector: `ImportDeclaration[source.value!=/${LISTE_BLANCHE}/]`, message: HORS_LISTE },
    {
      selector: "ImportDeclaration[importKind='value'][source.value=/(adapters|reconcile)/]",
      message: EN_VALEUR,
    },
    { selector: 'ImportExpression, TSImportEqualsDeclaration', message: HORS_LISTE },
    /*
     * `core/risk.ts` est dans la liste blanche — le module y prend `QUOTE` et
     * `MIN_LEG_USDC` — donc rien n'empecherait d'en prendre aussi `validate`.
     * L'affirmation « la validation de risque n'est pas appelee » serait alors
     * du commentaire. Le specificateur est juge sur le nom **importe**, donc le
     * renommage tombe avec lui.
     */
    { selector: "ImportSpecifier[imported.name='validate']", message: RISQUE },
  ],
});

const FORMES_D_IMPORT: Sondes = {
  'module hors liste': ["import { readFileSync } from 'node:fs';\nexport const f = readFileSync;", 1],
  'autre module de core hors liste': [
    "import { valuate } from '../core/benchmark.js';\nexport const f = valuate;",
    1,
  ],
  'adapter en valeur': [
    "import { openCoinbase } from '../adapters/coinbase.js';\nexport const f = openCoinbase;",
    1,
  ],
  'reconcile en valeur': ["import { reconcile } from './reconcile.js';\nexport const f = reconcile;", 1],
  'import egale require': ["import fs = require('node:fs');\nexport const f = fs;", 1],
  'import dynamique': ["export const f = () => import('./reconcile.js');", 1],
  'adapter en type': [
    "import type { OpenOrder } from '../adapters/coinbase.js';\nexport type X = OpenOrder;",
    0,
  ],
  'core en valeur': ["import { QUOTE } from '../core/risk.js';\nexport const f = QUOTE;", 0],
  'la validation de risque': [
    "import { validate } from '../core/risk.js';\nexport const f = validate;",
    1,
  ],
  'la validation de risque, renommee': [
    "import { validate as v } from '../core/risk.js';\nexport const f = v;",
    1,
  ],
};

/** Les huit declarations d'import du fichier. Un import de plus est un test rouge. */
const IMPORTS_ATTENDUS = 8;
const COMPTEUR = gardien({
  'no-restricted-syntax': ['error', { selector: 'ImportDeclaration', message: 'compte' }],
});

describe('V7 — les imports du module sont enumeres', () => {
  it('V7 : les dix formes recoivent le verdict attendu', async () => {
    expect(Object.keys(FORMES_D_IMPORT)).toHaveLength(10);
    expect(await verdicts(IMPORTS, FORMES_D_IMPORT)).toEqual(attendus(FORMES_D_IMPORT));
  });

  it('V7 : le fichier livre n’importe rien hors de la liste, ni en valeur, ni la validation', async () => {
    expect(fautifs(await IMPORTS.lintFiles([LIQUIDATE]))).toEqual([]);
  });

  it('V7 : il en compte exactement huit', async () => {
    const [resultat] = await COMPTEUR.lintFiles([LIQUIDATE]);
    expect(resultat?.messages).toHaveLength(IMPORTS_ATTENDUS);
  });
});

// --- V8, V9 : la surface publique --------------------------------------------

const AIGUILLES = ['dryRun', 'force', 'bypass', 'skip', 'override', 'unlock'] as const;

describe('V8, V9 — la surface publique n’a pas de porte', () => {
  it('V8 : les exports sont exactement ceux-ci', () => {
    expect(Object.keys(liquidate).sort()).toEqual([
      'CRON_QUOTIDIEN',
      'DECALAGE_DE_JAMBE',
      'ETAPES',
      'MARGE_LIMITE_PCT',
      'PHASE_COURANTE',
      'PHASE_D_APPLICATION',
      'SortieError',
      'appliquerSortie',
      'planifierSortie',
    ]);
  });

  it('V8 : le seul point d’entree prend un parametre et rend un refus', () => {
    expect(liquidate.appliquerSortie).toHaveLength(1);
  });

  /**
   * W1 : garde-fou grossier, du meme statut que C22 sur `src/core/risk.ts`. Il
   * porte sur le source entier — donc sur les champs de type, que `Object.keys`
   * ne voit pas — et se contourne en nommant la porte autrement. Ce qui tient
   * est V8, V6 et V7.
   */
  it('V9 : aucune chaine de contournement dans le source', () => {
    for (const aiguille of AIGUILLES) {
      expect(SOURCE.toLowerCase().includes(aiguille.toLowerCase()), aiguille).toBe(false);
    }
  });
});

// --- V10 : ce que la compilation tient ---------------------------------------

/** Un champ appelable deviendrait `never`, et l'affectation echouerait. */
type SansPort<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : T[K];
};

describe('V10 — quatre affirmations de type, tenues a chaque tsc', () => {
  it('V10 : trois elargissements de type ne compilent pas', () => {
    // §11 : la contrepartie d'une cession est le litteral USDC, jamais EUR.
    // @ts-expect-error
    const versEur: IntentionDeCession['ordre']['quote'] = 'EUR';
    // §7 : une cession qui ne serait pas post-only n'a pas de forme.
    // @ts-expect-error
    const sansPostOnly: IntentionDeCession['postOnly'] = false;
    // Le verrou : `SortieVerrouillee` n'est pas une union, aucun succes n'existe.
    // @ts-expect-error
    const autreStatut: SortieVerrouillee['statut'] = 'APPLIQUE';

    expect([versEur, sansPostOnly, autreStatut]).toHaveLength(3);
  });

  it('V10 : SortieInput ne porte aucun champ appelable', () => {
    /*
     * Le controle porte sur les champs de premier niveau. Un port enfoui dans un
     * objet lui echapperait ; V6 et V7 le rattrapent, puisqu'aucun module a effet
     * n'entre et qu'aucune fonction ne sait attendre.
     */
    const sansPort: SansPort<SortieInput> = {} as SortieInput;
    expect(sansPort).toBeDefined();
  });
});

// --- V11, W1, W2 : le perimetre, et ce qui lui echappe -----------------------

/** La configuration **reelle** du depot, pas une regle reecrite ici. */
const DEPOT = new ESLint({ cwd: ROOT });
const LU = gardien({ 'no-restricted-syntax': ['error', { selector: 'Program', message: 'lu' }] });

describe('V11 — le fichier livre est dans le perimetre des garde-fous du depot', () => {
  it('V11 : le glob de src/jobs/** le lit', async () => {
    const chemins = (await LU.lintFiles(['src/jobs/**/*.ts'])).map((r) =>
      relative(ROOT, r.filePath),
    );
    expect(chemins).toContain(LIQUIDATE);
  });

  it('V11 : la configuration du depot mord a cet emplacement, et se tait sur le fichier', async () => {
    /*
     * L'ordre des deux assertions est le point : sans la premiere, « aucun
     * message » ne distinguerait pas un fichier propre d'un fichier non couvert.
     */
    const [sonde] = await DEPOT.lintText(
      'declare const c: { cancelOrder(): void };\nexport const f = () => c.cancelOrder();',
      { filePath: resolve(ROOT, 'src/jobs/sonde.ts') },
    );
    expect(sonde?.messages.length ?? 0).toBeGreaterThan(0);

    const [livre] = await DEPOT.lintFiles([LIQUIDATE]);
    expect(livre?.messages).toEqual([]);
  });
});

describe('W1, W2 — les limites declarees sont constatees', () => {
  it('W1 : une porte nommee autrement echappe a la recherche de chaines', () => {
    const porte = 'export function ouvrirLaSortie(): boolean { return true; }';
    for (const aiguille of AIGUILLES) {
      expect(porte.toLowerCase().includes(aiguille.toLowerCase()), aiguille).toBe(false);
    }
  });

  it('W2 : un effet relaye par un module de core echappe aux deux gardiens', async () => {
    /*
     * `core/risk.ts` est dans la liste blanche. Un module de `core/` qui ferait
     * lui-meme l'appel se prendrait ici sous un nom quelconque, et les deux
     * gardiens se tairaient. C'est `eslint.config.js` qui garde `src/core/**`
     * contre cela, pas ce fichier.
     */
    const relais = "import { effetDeBord } from '../core/risk.js';\nexport const f = () => effetDeBord();";
    expect(await messagesDe(SYNCHRONE, relais)).toBe(0);
    expect(await messagesDe(IMPORTS, relais)).toBe(0);
  });
});
