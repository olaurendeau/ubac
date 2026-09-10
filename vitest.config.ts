import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /*
     * `default` est le reporter habituel, inchange. `budget-reporter` s'ajoute
     * a cote : il ne dit rien tant qu'aucun test ne consomme la moitie de son
     * propre delai, et fait echouer le run au-dela de 80 %. Il remplace la
     * decouverte au cas par cas des tests devenus lents sous couverture — voir
     * l'en-tete du fichier. Le testTimeout global reste a 5 s (defaut vitest) :
     * les deux blocs qui rejouent la fixture portent leur delai eux-memes.
     */
    reporters: ['default', './test/budget-reporter.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      thresholds: {
        'src/core/risk.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
