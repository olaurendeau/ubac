/**
 * Garde-fou de marge : rend visible un test qui approche son propre delai, au
 * lieu d'attendre qu'il devienne intermittent.
 *
 * Pourquoi ce fichier existe. Deux fois de suite, `make coverage` est tombe sur
 * le meme motif : un test qui rejoue la fixture, lent sous instrumentation v8,
 * arrive au bord du testTimeout sans que personne le sache. La premiere fois
 * (report.test.ts, lot P7) il a franchi la limite et casse la porte. La seconde
 * (engine.test.ts) il tenait a 7 % pres — il passait, donc aucune alerte, mais
 * il echouait des que la machine etait chargee. Un echec intermittent sur la
 * porte qui fait respecter les 100 % de src/core/risk.ts est pire qu'un echec
 * franc : on prend l'habitude de relancer sans regarder.
 *
 * Ce que ce reporter mesure. Pour chaque test, la part de son propre delai
 * qu'il consomme. Le delai lu est le delai *effectif* (`options.timeout`) :
 * 5 000 ms par defaut, 30 000 ms dans un bloc qui a recu un delai cible. La
 * mesure est donc juste pour les deux regimes, sans liste de fichiers a tenir.
 *
 * Deux seuils, et deux comportements distincts, parce que le reporter ne doit
 * pas remplacer un flake de delai par un flake de marge :
 *
 * - AVERTISSEMENT a 50 % : il reste un facteur 2 avant l'echec. Le run reste
 *   vert ; le tableau s'affiche. C'est le signal que la premiere fois n'a pas eu.
 * - ECHEC a 80 % : il ne reste qu'un facteur 1,25. A ce stade le test n'est plus
 *   « bientot flaky », il l'est : autant le dire franchement, avec un message
 *   qui nomme la cause, plutot que de laisser sortir un timeout nu que la
 *   prochaine relecture classera en flake.
 *
 * Le cout de ce choix. L'echec a 80 % est lui-meme sensible a la charge : sur
 * une machine saturee un test sain peut y arriver. C'est accepte parce que le
 * facteur necessaire est grand — le pire test de la suite consomme 29 % de son
 * delai, il lui faudrait ralentir de 2,8x — et parce que l'evenement qu'on
 * declencherait alors est celui qu'on veut voir. Le reporter ne relache jamais
 * un echec : il ne fait que poser `exitCode`, jamais l'effacer.
 */
import type { Reporter, TestCase, TestModule } from 'vitest/node';

/** Part du delai consommee a partir de laquelle le tableau s'affiche. */
const WARN_RATIO = 0.5;
/** Part du delai consommee a partir de laquelle le run echoue. */
const FAIL_RATIO = 0.8;

interface Consumption {
  readonly module: string;
  readonly name: string;
  readonly duration: number;
  readonly timeout: number;
  readonly ratio: number;
}

export default class BudgetReporter implements Reporter {
  private readonly tight: Consumption[] = [];

  onTestCaseResult(testCase: TestCase): void {
    const duration = testCase.diagnostic()?.duration;
    const timeout = testCase.options.timeout;
    // Un test ignore n'a pas de duree ; un delai nul ou absent veut dire « pas
    // de limite », donc pas de marge a surveiller.
    if (duration === undefined || timeout === undefined || timeout <= 0) return;
    const ratio = duration / timeout;
    if (ratio < WARN_RATIO) return;
    this.tight.push({
      module: testCase.module.moduleId,
      name: testCase.fullName,
      duration,
      timeout,
      ratio,
    });
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (this.tight.length === 0) return;
    const root = testModules[0]?.project.config.root ?? '';
    const rows = [...this.tight].sort((a, b) => b.ratio - a.ratio);
    const failing = rows.filter((r) => r.ratio >= FAIL_RATIO);

    const lines = [
      '',
      `Marge de delai — ${rows.length} test(s) au-dela de ${WARN_RATIO * 100} % de leur propre delai :`,
      '',
    ];
    for (const r of rows) {
      const flag = r.ratio >= FAIL_RATIO ? 'ECHEC' : 'alerte';
      const file = r.module.startsWith(root) ? r.module.slice(root.length + 1) : r.module;
      lines.push(
        `  ${flag}  ${(r.ratio * 100).toFixed(0).padStart(3)} %  ` +
          `${Math.round(r.duration).toString().padStart(6)} ms / ${r.timeout} ms  ` +
          `${file} > ${r.name}`,
      );
    }
    lines.push('');
    if (failing.length > 0) {
      lines.push(
        `Au-dela de ${FAIL_RATIO * 100} % le test est deja intermittent. Rendre le test plus`,
        'rapide, ou poser un delai cible sur son bloc avec le commentaire qui dit pourquoi',
        '(voir test/replay/report.test.ts). Ne pas relever le testTimeout global : un test',
        'bloque ailleurs doit continuer d echouer en 5 s.',
        '',
      );
      // Le reporter pose l'echec, il ne l'efface jamais : un run deja rouge le reste.
      process.exitCode = 1;
    }
    console.error(lines.join('\n'));
  }
}
