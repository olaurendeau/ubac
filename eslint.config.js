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
 * Les couches que la phase 1 fait entrer. Elles n'existent pas encore : le glob
 * est vide tant qu'aucun adapter ni job n'est livre, exactement comme
 * `src/core/**` l'etait avant E3.
 */
const ADAPTERS_AND_JOBS = ['src/adapters/**/*.ts', 'src/jobs/**/*.ts'];

/**
 * La phase 1 est en observation : aucun ordre ne part, jamais. Le garde-fou C32
 * de la phase 0 le tenait en interdisant `src/adapters/` et `src/jobs/` tout
 * court ; ces repertoires arrivent, donc la garantie doit se deplacer de
 * l'arborescence vers les **appels**.
 *
 * Ce qui suit est un controle de **noms**, et rien d'autre. Il attrape tout ce
 * qui s'ecrit `createOrder`, `place_order`, `cancelAllOrders`, `withdraw`,
 * `transferFunds` et leurs variantes ccxt, en camelCase comme en snake_case,
 * quelle que soit la position syntaxique : appel, declaration, propriete lue,
 * cle d'objet, specificateur d'import, chaine de caracteres. D'ou des selecteurs
 * poses sur `Identifier` et `Literal` plutot que sur `CallExpression` seul —
 * `const f = client.createOrder;` puis `f()` contourne un selecteur d'appel.
 *
 * Ce qu'il n'attrape pas est ecrit noir sur blanc dans
 * `docs/phase-1-frontieres.md` : une repartition dynamique
 * (`client[methode]()` ou `methode` vient de la configuration), un client HTTP
 * generique (`http.post('/orders', …)`), la reflexion. Le garde-fou reduit la
 * surface d'erreur ; il ne demontre pas l'absence d'execution. La seule garantie
 * structurelle est une cle d'API sans permission de trade.
 */
const ORDER_WRITE_VERBS = [
  'create',
  'place',
  'submit',
  'send',
  'post',
  'edit',
  'amend',
  'modify',
  'replace',
  'cancel',
  'close',
];

/**
 * `[A-Za-z_]*` couvre les deux conventions d'un coup : `createLimitBuyOrder`
 * comme `create_limit_buy_order`. Pas de drapeau `i` — esquery ne garantit pas
 * de les accepter, et les casses reellement possibles sur un identifiant sont
 * enumerables.
 *
 * `withdraw` et `transfer` sont pris n'importe ou dans le nom, pas seulement en
 * tete : la spec §7 exige « jamais de permission de retrait », donc un module de
 * la phase 1 n'a aucune raison de prononcer le mot, meme en lecture.
 */
const ORDER_WRITE_NAME = String.raw`^(?:(?:${ORDER_WRITE_VERBS.join('|')})[A-Za-z_]*[Oo]rders?|[A-Za-z_]*(?:[Ww]ithdraw|[Tt]ransfer)[A-Za-z_]*)$`;

const ORDER_WRITE_SELECTORS = [
  `Identifier[name=/${ORDER_WRITE_NAME}/]`,
  `PrivateIdentifier[name=/${ORDER_WRITE_NAME}/]`,
  // `client['createOrder']()` et la cle de chaine d'une table de repartition.
  `Literal[value=/${ORDER_WRITE_NAME}/]`,
  `TemplateElement[value.raw=/${ORDER_WRITE_NAME}/]`,
];

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
    files: CORE,
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
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [JOBS_IMPORT_PATTERN] }],
    },
  },

  {
    files: ADAPTERS_AND_JOBS,
    /*
     * Sans ceci, `// eslint-disable-next-line no-restricted-syntax` au-dessus de
     * l'appel suffit a desarmer le garde-fou en une ligne, dans le fichier meme
     * qu'il surveille. Un garde-fou qu'on eteint depuis l'interieur n'en est pas
     * un.
     */
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: ORDER_WRITE_SELECTORS.join(', '),
          message:
            "la phase 1 est en observation : aucun chemin d'execution ne place, n'annule ni ne retire. Ce nom denote une ecriture sur l'exchange.",
        },
      ],
    },
  },
);
