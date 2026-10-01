import tseslint from 'typescript-eslint';

/**
 * `src/core/**` est pur : zero IO, horloge injectee.
 * Les regles ci-dessous sont volontairement restreintes a ce glob. Les appliquer
 * au depot entier casserait les tests et le harnais de rejeu, qui manipulent
 * legitimement des dates et lisent des fichiers.
 */
const CORE = ['src/core/**/*.ts'];

/**
 * Liste blanche des specificateurs de module autorises dans core. Tout le reste
 * est refuse, y compris les builtins Node : c'est ce qui ferme la porte aux
 * modules d'IO, plutot qu'une liste noire forcement incomplete.
 *
 * `node:crypto` est admis parce que le hachage est une fonction pure. Il sert au
 * client_order_id deterministe. Le module exporte aussi randomUUID et
 * randomBytes : il est reduit au seul createHash par no-restricted-imports.
 */
const CORE_BARE_IMPORT_ALLOWLIST = String.raw`^(?!\.)(?!decimal\.js$)(?!node:crypto$)`;

/**
 * Les trois formes qui portent un specificateur de module. Ne couvrir
 * qu'ImportDeclaration laisse passer `export * from 'node:fs'`, qui fait entrer
 * le module exactement de la meme facon.
 */
const MODULE_SOURCE_NODES = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'];

/**
 * Globales joignables sans aucun import : une liste blanche d'imports ne les
 * voit pas. `fetch()` ouvre le reseau, `crypto.randomUUID()` casse le
 * determinisme, `globalThis` rouvre l'acces a tout ce que cette liste ferme,
 * et aucun des trois ne s'importe. Sans cette regle, le garde-fou d'imports
 * donne une fausse assurance.
 */
const CORE_FORBIDDEN_GLOBALS = [
  { name: 'fetch', message: 'core est sans IO : aucun appel reseau, il vit dans adapters/.' },
  { name: 'XMLHttpRequest', message: 'core est sans IO : aucun appel reseau.' },
  { name: 'WebSocket', message: 'core est sans IO : aucun appel reseau.' },
  {
    name: 'process',
    message: 'core est pur : ni env, ni argv, ni stdout. La configuration est un parametre.',
  },
  {
    name: 'crypto',
    message: 'core est deterministe : la globale crypto expose randomUUID et randomBytes.',
  },
  {
    name: 'performance',
    message: "core n'a pas d'horloge propre : performance.now() est interdit, injecte l'horloge.",
  },
  {
    name: 'globalThis',
    message: "core est pur : globalThis rouvre l'acces a tout ce que ces regles ferment.",
  },
  { name: 'console', message: 'core est sans IO : le resultat sort par la valeur de retour.' },
  {
    name: 'setTimeout',
    message: 'core est pur et synchrone : aucun minuteur, le temps est un parametre.',
  },
  { name: 'setInterval', message: 'core est pur et synchrone : aucun minuteur.' },
  { name: 'setImmediate', message: 'core est pur et synchrone : aucun minuteur.' },
  { name: 'require', message: "core est en ESM : require() contourne la liste blanche d'imports." },
];

// --- Frontieres de la phase 1 -----------------------------------------------

/**
 * Les deux couches qui touchent l'exterieur. Elles n'ont plus de regle propre :
 * seulement `noInlineConfig`, dans le dernier bloc de ce fichier.
 */
const ADAPTERS_AND_JOBS = ['src/adapters/**/*.ts', 'src/jobs/**/*.ts'];

/*
 * La regle de noms d'ecriture d'ordre de la phase 1 (C32 converti) est retiree
 * au lot S4 de la phase 3, decision B4, avec ses fixtures et son bloc de test.
 * Une regle qui interdit de **nommer** un placement ne cohabite pas avec une
 * phase dont l'objet est d'en placer — et son selecteur, ancre sur onze verbes,
 * n'aurait pas attrape l'appel ccxt reel, `v3PrivatePostBrokerageOrders`.
 *
 * Ce qui la remplace est une enumeration positive, hors de ce fichier : les
 * routes d'ecriture et les methodes du port, enumerees par
 * `test/adapters/coinbase.test.ts` (E10), et leur appel reserve a
 * `src/jobs/execute.ts` par A23 de `test/jobs/purete.test.ts` (E11).
 * `docs/phase-1-frontieres.md` §1 dit ce que le depot perd ce jour-la.
 */

/**
 * `jobs/` est le point d'entree executable : le runtime l'appelle, le code ne
 * l'importe pas. Un adapter qui importe un job inverse la composition et rend
 * un chemin d'execution atteignable depuis une couche qui n'est censee que lire.
 */
const JOBS_IMPORT_PATTERN = {
  regex: '(^|/)jobs(/|$)',
  message:
    "jobs/ est le point d'entree executable : il compose les autres couches, aucune ne l'importe.",
};

// --- Le convoyeur (lot Y3 de ubac-convoyeur) ---------------------------------

/**
 * Un second arbre, pas un module d'Ubac (plan, point 1) : rien d'autre dans
 * `src/` ne l'importe ; lui n'importe d'`adapters/` que `schema.ts` et
 * `http.ts`, et de `core/` que des types. Ses fichiers purs prennent les regles
 * du noyau (Y2, piege 3) ; seul le transport tient une instance ccxt.
 * `test/convoyeur/frontiere.test.ts` tient chaque regle par sa fixture.
 */
const CONVOYEUR = ['src/convoyeur/**/*.ts'];
const CONVOYEUR_PUR = ['src/convoyeur/regles.ts', 'src/convoyeur/types.ts'];
const CONVOYEUR_TRANSPORT = ['src/convoyeur/coinbase.ts'];

const CONVOYEUR_IMPORT_PATTERN = {
  regex: '(^|/)convoyeur(/|$)',
  message:
    "le convoyeur est un agent distinct : aucune couche d'Ubac ne l'importe (ubac-convoyeur, point 1).",
};

/**
 * La variante `@typescript-eslint` : son `allowTypeImports` admet `import type`
 * depuis `core/`, et son nom n'ecrase pas les `no-restricted-imports` que les
 * blocs d'Ubac posent deja (le dernier bloc gagne, regle par regle).
 */
function convoyeurImports(modulesNus) {
  const nus = modulesNus.map((nom) => `(?!${nom.replace(/[.]/g, '\\.')}$)`).join('');
  return [
    'error',
    {
      patterns: [
        {
          regex: String.raw`^(\.\./)+(?!(adapters/(schema|http)|core/[\w/-]+)\.js$)`,
          message:
            "le convoyeur n'importe d'Ubac que adapters/schema.js, adapters/http.js et des types de core/.",
        },
        {
          regex: String.raw`^(\.\./)+core/`,
          allowTypeImports: true,
          message: 'le convoyeur ne prend de core/ que des types : import type.',
        },
        {
          regex: `^(?!\\.)${nus}`,
          message: `module hors liste pour ce fichier du convoyeur (admis : ${modulesNus.join(', ')}).`,
        },
      ],
    },
  ];
}

/**
 * CV4 : ni route v2 (envoi, retrait), ni `request` / `fetch` / `fetch2` de ccxt,
 * qui signent n'importe quel chemin, ni ses sorties unifiees `withdraw` et
 * `transfer`. Les litteraux attrapent `x['v2…']` et les chemins `/v2/`.
 */
const CONVOYEUR_SYNTAX = [
  {
    selector: [
      'MemberExpression[property.name=/^(v2|request$|fetch$|fetch2$|withdraw$|transfer$)/]',
      'MemberExpression[property.value=/^(v2|request$|fetch$|fetch2$|withdraw$|transfer$)/]',
      'Property[key.name=/^v2/]',
    ].join(', '),
    message: 'CV4 : ni membre v2, ni requete generique, ni sortie unifiee de ccxt dans le convoyeur.',
  },
  {
    selector: 'Literal[value=/^v2|\\x2Fv2\\x2F/], TemplateElement[value.raw=/^v2|\\x2Fv2\\x2F/]',
    message: "CV4 : aucune route de l'API v2 dans le convoyeur, meme en chaine.",
  },
  {
    selector: 'ImportExpression',
    message: "le convoyeur n'importe pas dynamiquement : la liste des modules s'esquiverait.",
  },
];

const CONVOYEUR_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'globalThis', 'require'].map(
  (name) => ({ name, message: 'le convoyeur ne parle au reseau que par son transport enumere.' }),
);

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
  },
  {
    // Les regles pures du convoyeur prennent celles du noyau telles quelles.
    files: [...CORE, ...CONVOYEUR_PUR],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:crypto',
              allowImportNames: ['createHash'],
              message: 'core est deterministe : de node:crypto, seul createHash est pur.',
            },
          ],
          patterns: [
            {
              regex: '(^|/)(adapters|jobs)(/|$)',
              message:
                'core ne connait que des interfaces : aucun import depuis adapters/ ou jobs/.',
            },
            CONVOYEUR_IMPORT_PATTERN,
          ],
        },
      ],
      'no-restricted-globals': ['error', ...CORE_FORBIDDEN_GLOBALS],
      'no-restricted-syntax': [
        'error',
        {
          selector: MODULE_SOURCE_NODES.map(
            (node) => `${node}[source.value=/${CORE_BARE_IMPORT_ALLOWLIST}/]`,
          ).join(', '),
          message:
            'core est sans IO : seuls decimal.js, node:crypto et les imports relatifs sont autorises.',
        },
        {
          selector: 'ImportExpression, TSImportEqualsDeclaration',
          message:
            "core est pur et synchrone : l'import dynamique contourne la liste blanche des modules.",
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "core n'a pas d'horloge propre : Date.now() est interdit, injecte l'horloge.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "core n'a pas d'horloge propre : new Date() sans argument est interdit.",
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'core est deterministe : Math.random() est interdit.',
        },
        {
          selector: "MemberExpression[computed=true][object.name=/^(Date|Math)$/]",
          message:
            "core est deterministe : l'acces calcule a Date ou Math contourne les regles ci-dessus.",
        },
      ],
    },
  },

  /*
   * Les blocs de la phase 1 viennent **apres** celui de core et l'excluent
   * explicitement. En configuration plate, deux blocs qui posent le meme nom de
   * regle ne fusionnent pas : le dernier gagne. Ecrire `src/**` sans exclure
   * core desarmerait donc `no-restricted-imports` sur core, sans qu'aucun test
   * de fixture ne le dise autrement que par son compte de messages.
   */
  {
    files: ['src/**/*.ts'],
    /*
     * core a ses propres restrictions ci-dessus, inchangees ; jobs/ s'importe
     * lui-meme ; replay/ et fixture/ sont le harnais hors ligne de la phase 0,
     * que la phase 1 ne touche pas et dont les fixtures de lint verrouillent
     * deja le comportement attendu. Tout le reste — adapters/, config/, et
     * n'importe quelle couche future — est couvert par defaut.
     */
    ignores: [
      'src/core/**/*.ts',
      'src/jobs/**/*.ts',
      'src/replay/**/*.ts',
      'src/fixture/**/*.ts',
      ...CONVOYEUR_PUR,
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [JOBS_IMPORT_PATTERN, CONVOYEUR_IMPORT_PATTERN] }],
    },
  },

  {
    files: ['src/jobs/**/*.ts', 'src/replay/**/*.ts', 'src/fixture/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [CONVOYEUR_IMPORT_PATTERN] }] },
  },

  {
    files: CONVOYEUR,
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-restricted-imports': convoyeurImports(['decimal.js']) },
    linterOptions: { noInlineConfig: true },
  },
  {
    files: CONVOYEUR_PUR,
    rules: { '@typescript-eslint/no-restricted-imports': convoyeurImports(['decimal.js', 'node:crypto']) },
  },
  {
    files: CONVOYEUR,
    ignores: CONVOYEUR_PUR,
    rules: {
      'no-restricted-syntax': ['error', ...CONVOYEUR_SYNTAX],
      'no-restricted-globals': ['error', ...CONVOYEUR_GLOBALS],
    },
  },
  {
    files: CONVOYEUR_TRANSPORT,
    rules: {
      '@typescript-eslint/no-restricted-imports': convoyeurImports(['decimal.js', 'ccxt']),
      'no-restricted-syntax': [
        'error',
        ...CONVOYEUR_SYNTAX,
        {
          selector: "MemberExpression[computed=true][property.type!='Literal']",
          message: "CV4 : aucun acces calcule dans le transport, l'instance ccxt s'y lirait par un nom construit.",
        },
      ],
    },
  },

  {
    files: ADAPTERS_AND_JOBS,
    /*
     * La regle de noms est partie (B4), ce bloc reste : sans lui,
     * `// eslint-disable-next-line` redeviendrait utilisable dans ces deux
     * repertoires pour **toutes** les regles, frontieres de couche comprises —
     * la regle « personne n'importe jobs/ » s'eteindrait depuis l'adapter
     * meme qu'elle surveille. Un garde-fou qu'on eteint depuis l'interieur n'en
     * est pas un. `test/structure.test.ts` le tient sur les deux globs.
     */
    linterOptions: { noInlineConfig: true },
  },
);
