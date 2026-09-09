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
);
