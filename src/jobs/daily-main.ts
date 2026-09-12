import { ccxtTransport, openCoinbase } from '../adapters/coinbase.js';
import { openDatabase } from '../adapters/db.js';
import { openMarketData } from '../adapters/market.js';
import { loadConfig } from '../config/env.js';
import type { IsoDate } from '../core/types.js';
import type { RunClock } from './daily.js';
import { runDaily } from './daily.js';

/**
 * Le point d'entree du run quotidien : **la composition, et rien d'autre.**
 *
 * C'est le seul fichier de `src/jobs/` qui importe un adapter en valeur, donc le
 * seul qui charge `ccxt` et `pg`. `src/jobs/daily.ts` n'en connait que les
 * types, ce qui est ce qui rend le run testable contre des doubles, sans reseau
 * ni cle ni base ; `test/jobs/purete.test.ts` tient les deux moities de cette
 * phrase — A20 nomme ce fichier comme le seul lieu de composition, et A22 refuse
 * que quoi que ce soit l'importe, dans `src/` comme dans `test/`.
 *
 * Ce second controle n'est pas une precaution de style. Ce module **appelle
 * `main` a l'evaluation** : un `import` depuis une suite de tests ne chargerait
 * pas seulement `ccxt` et `pg`, il lancerait le run.
 *
 * **Il n'a pas d'horloge non plus.** La date de run, l'instant journalise et le
 * SHA arrivent par la ligne de commande. C'est volontaire : un run lance a
 * 23 h 59 UTC et son rejeu a 00 h 01 porteraient sinon deux `run_date`, et
 * l'index unique de `decisions` ne protegerait plus de rien. Le script
 * `npm run daily` de `package.json` fabrique les deux dates a partir d'un
 * **seul** appel a `date -u`, une ligne de shell visible ; un rejeu les repasse
 * a la main.
 *
 * `docs/run-quotidien.md` donne les commandes, les codes de sortie et les
 * limites.
 */

/**
 * La **forme** d'une date de run, et rien de plus. Le calendrier est juge par
 * `runDaily`, dont `dayStart` fait l'aller-retour ISO complet et refuse donc
 * `2026-02-30`, que Node reporterait en silence au 2 mars. Recopier cet
 * aller-retour ici donnerait deux sources pour la meme regle ; ce motif ne sert
 * qu'a rendre `--run-date=hier` lisible comme une erreur d'usage plutot que
 * comme une date illisible. Le refus du calendrier tombe de toute facon **avant
 * la premiere ecriture** : `runDaily` decale la date a l'etape 3 et n'ecrit qu'a
 * l'etape 5.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = [
  'usage : tsx src/jobs/daily-main.ts --run-date=YYYY-MM-DD --git-sha=<sha> [--at=<instant ISO>]',
  '  --run-date  jour UTC du run. Aucun defaut : le job n’a pas d’horloge.',
  '  --git-sha   code qui tourne, journalise dans decisions.git_sha.',
  '  --at        instant de decisions.created_at ; par defaut 00:00:00Z du jour de run.',
].join('\n');

/**
 * La derniere occurrence gagne : `npm run daily` pose ses defauts, et
 * `npm run daily -- --run-date=2026-09-01` les remplace sans que l'ordre des
 * arguments ait a etre devine — npm ajoute les arguments de l'operateur **apres**
 * ceux du script.
 *
 * Une valeur vide vaut absente. C'est le cas d'un `--git-sha=$GIT_SHA` dont la
 * variable n'est pas posee : mieux vaut le message d'usage qu'une chaine vide
 * journalisee dans `decisions.git_sha`.
 */
function option(args: readonly string[], nom: string): string | undefined {
  const prefixe = `--${nom}=`;
  let valeur: string | undefined;
  for (const arg of args) {
    if (arg.startsWith(prefixe)) valeur = arg.slice(prefixe.length);
  }
  return valeur === undefined || valeur.length === 0 ? undefined : valeur;
}

interface Arguments {
  readonly runDate: IsoDate;
  readonly gitSha: string;
  readonly instant: Date;
}

function readArguments(args: readonly string[]): Arguments {
  const runDate = option(args, 'run-date');
  const gitSha = option(args, 'git-sha');
  const at = option(args, 'at');

  if (runDate === undefined || !ISO_DATE.test(runDate)) {
    throw new Error(`--run-date manquant ou mal forme.\n${USAGE}`);
  }
  if (gitSha === undefined) {
    /*
     * Pas de valeur de repli. Un `unknown` journalise dans `decisions.git_sha`
     * couterait exactement ce que la colonne existe pour eviter : savoir quel
     * code a pris une decision douteuse.
     */
    throw new Error(`--git-sha manquant.\n${USAGE}`);
  }
  /*
   * `--at` n'est pas contraint au jour de run : un rejeu du 2026-09-01 lance
   * aujourd'hui porte legitimement un `created_at` d'aujourd'hui. C'est
   * `run_date` qui est la cle, et elle est passee a part.
   */
  const instant = new Date(at ?? `${runDate}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`--at illisible : "${String(at)}".\n${USAGE}`);
  }
  return { runDate, gitSha, instant };
}

function texte(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Zero si le run a conclu, un sinon — abandon de reconciliation compris. Un
 * abandon n'est pas une anomalie du programme, mais ce n'est pas un succes : le
 * declencheur exterieur doit le voir rouge.
 */
async function main(argv: readonly string[]): Promise<number> {
  const { runDate, gitSha, instant } = readArguments(argv);
  const config = loadConfig();
  const clock: RunClock = { today: () => runDate, instant: () => instant };

  /*
   * Un seul transport pour les deux lectures Coinbase : la cle signe les routes
   * privees, les bougies sont publiques, et c'est le meme client HTTP. Le
   * fermer une fois ferme les deux.
   */
  const transport = ccxtTransport(config.secrets);
  const exchange = openCoinbase(transport);
  const market = openMarketData(transport);
  const db = openDatabase(config.secrets);

  try {
    const result = await runDaily({
      ports: { exchange, market, db },
      clock,
      config,
      gitSha,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    return result.status === 'COMPLETED' ? 0 : 1;
  } finally {
    /*
     * Les deux fermetures, chacune dans son propre essai. Un `await db.close()`
     * qui leve laisserait le transport ccxt ouvert et le processus suspendu sur
     * sa socket. Un echec de fermeture est journalise et ne change pas le code
     * de sortie : le run a deja conclu, et ce qu'il avait a ecrire est ecrit.
     */
    for (const [nom, fermer] of [
      ['base', (): Promise<void> => db.close()],
      ['coinbase', (): Promise<void> => exchange.close()],
    ] as const) {
      try {
        await fermer();
      } catch (error) {
        process.stderr.write(`fermeture ${nom} : ${texte(error)}\n`);
      }
    }
  }
}

/*
 * Rien n'est exporte : ce module est un point d'entree, pas une bibliotheque.
 *
 * `process.exitCode` et non `process.exit()` : le second coupe le processus
 * avant que les ecritures en attente sur stdout ne partent, ce qui perd la
 * derniere ligne du journal exactement quand elle est la plus utile.
 */
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${texte(error)}\n`);
    process.exitCode = 1;
  },
);
