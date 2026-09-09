import tseslint from 'typescript-eslint';

/**
 * `src/core/**` est pur : zero IO, horloge injectee.
 * Les regles ci-dessous sont volontairement restreintes a ce glob. Les appliquer
 * au depot entier casserait les tests et le harnais de rejeu, qui manipulent
 * legitimement des dates et lisent des fichiers.
 */
const CORE = ['src/core/**/*.ts'];

/**
 * Liste blanche des imports nus autorises dans core. Tout le reste est refuse,
 * y compris les builtins Node : c'est ce qui garantit "zero IO" plutot qu'une
 * liste noire de modules d'IO, forcement incomplete.
 *
 * `node:crypto` est admis parce que le hachage est une fonction pure. Il sert au
 * client_order_id deterministe.
 */
const CORE_BARE_IMPORT_ALLOWLIST = String.raw`^(?!\.)(?!decimal\.js$)(?!node:crypto$)`;

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
          patterns: [
            {
              regex: '(^|/)(adapters|jobs)(/|$)',
              message:
                'core ne connait que des interfaces : aucun import depuis adapters/ ou jobs/.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportDeclaration[source.value=/${CORE_BARE_IMPORT_ALLOWLIST}/]`,
          message:
            'core est sans IO : seuls decimal.js, node:crypto et les imports relatifs sont autorises.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "core n'a pas d'horloge propre : Date.now() est interdit, injecte l'horloge.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "core n'a pas d'horloge propre : new Date() sans argument est interdit.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'core est deterministe : Math.random() est interdit.',
        },
      ],
    },
  },
);
