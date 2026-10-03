import { openHttp } from '../adapters/http.js';
import { openConvoyeurBase } from './base.js';
import { ccxtConvoyeurTransport, openConvoyeurCoinbase } from './coinbase.js';
import { lireConfig } from './env.js';
import { baseInerte, coinbaseInerte } from './inertes.js';
import { openNtfy, rendreCompte } from './ntfy.js';
import type { PortsPassage } from './passage.js';
import { PAUSE_MS, TENTATIVES, passage } from './passage.js';

/**
 * Le point d'entree du convoyeur (lot Y5) : **la composition, et rien
 * d'autre** (`docs/convoyeur.md` §6).
 *
 * - **Le mode est lu ici, une fois, et ne voyage pas** (piege 1) : il choisit
 *   les ports et la marque du titre. A25 de `test/jobs/purete.test.ts` refuse
 *   qu'il soit nomme ailleurs dans `src/`, hors du point d'entree d'Ubac.
 * - **Le defaut est le `DRY_RUN`, a l'inverse d'Ubac** (piege 3, DP5 = 2) ; un
 *   argument inconnu (`--real`, `--reel=oui`) refuse le demarrage.
 * - **Le mode est la premiere ligne du journal** et suit « convoyeur » dans le
 *   titre de chaque notification (DP4 = 1).
 * - **Rien n'importe ce module** (piege 2) : il lance le passage a
 *   l'evaluation. `test/convoyeur/main.test.ts` le tient, et le lance en
 *   processus.
 *
 * Ni ccxt ni `pg` n'ouvrent rien a la construction : la premiere lecture est
 * `key_permissions` (CV1).
 */

const USAGE = [
  'usage : node dist/convoyeur/main.js --at=<instant ISO> --git-sha=<sha> [--reel]',
  '  --at       instant du passage ; son jour UTC identifie le convoyage.',
  '  --git-sha  code qui tourne, journalise.',
  '  --reel     ordre, move_funds et base reels. Sans lui : DRY_RUN, ports inertes.',
].join('\n');

const REEL = '--reel';
const OPTIONS = ['at', 'git-sha'] as const;

const MARQUE_DRY_RUN = 'DRY_RUN';
const LIGNE_DRY_RUN = 'mode=DRY_RUN : lectures reelles ; ordre, move_funds et base retenus par des ports inertes.';
const LIGNE_REEL = 'mode=REEL : ordre, move_funds et base reels.';

interface Arguments {
  readonly instant: Date;
  readonly gitSha: string;
  readonly reel: boolean;
}

/** Derniere occurrence gagnante ; une valeur vide vaut absente. */
function option(args: readonly string[], nom: string): string | undefined {
  const prefixe = `--${nom}=`;
  const valeur = args.filter((arg) => arg.startsWith(prefixe)).at(-1)?.slice(prefixe.length);
  return valeur === undefined || valeur.length === 0 ? undefined : valeur;
}

function lireArguments(args: readonly string[]): Arguments {
  // Seul le nom d'un argument inconnu est cite, jamais ce qui suit son `=`.
  const inconnus = args.filter((arg) => arg !== REEL && !OPTIONS.some((nom) => arg.startsWith(`--${nom}=`)));
  if (inconnus.length > 0) {
    throw new Error(`argument inconnu : ${inconnus.map((arg) => arg.split('=')[0]).join(' ')}\n${USAGE}`);
  }
  const at = option(args, 'at');
  const gitSha = option(args, 'git-sha');
  const instant = new Date(at ?? '');
  if (at === undefined || Number.isNaN(instant.getTime())) throw new Error(`--at manquant ou illisible.\n${USAGE}`);
  if (gitSha === undefined) throw new Error(`--git-sha manquant.\n${USAGE}`);
  return { instant, gitSha, reel: args.includes(REEL) };
}

function texte(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : String(erreur);
}

async function main(argv: readonly string[]): Promise<number> {
  const { instant, gitSha, reel } = lireArguments(argv);
  const log = (ligne: string): void => {
    process.stdout.write(`${ligne}\n`);
  };
  log(reel ? LIGNE_REEL : LIGNE_DRY_RUN);
  log(`passage du ${instant.toISOString()}, git_sha=${gitSha}`);

  const config = lireConfig();
  const transport = ccxtConvoyeurTransport({ apiKey: config.coinbaseApiKey, apiSecret: config.coinbaseApiSecret });
  const coinbase = openConvoyeurCoinbase(transport, {
    primaryUuid: config.primaryUuid,
    destinationUuid: config.destinationUuid,
    log,
  });
  const base = openConvoyeurBase(config);
  // La seule condition de mode du convoyeur : les memes types, d'autres ports.
  const mode = reel
    ? { marque: undefined, coinbase, base }
    : { marque: MARQUE_DRY_RUN, coinbase: coinbaseInerte(coinbase, log), base: baseInerte(base, log) };
  const ports: PortsPassage = {
    coinbase: mode.coinbase,
    base: mode.base,
    horloge: () => new Date(),
    pause: (ms) => new Promise((fin) => setTimeout(fin, ms)),
    log,
  };

  try {
    const compteRendu = await passage(
      ports,
      {
        primaryUuid: config.primaryUuid,
        destinationUuid: config.destinationUuid,
        tentatives: TENTATIVES,
        pauseMs: PAUSE_MS,
      },
      instant,
    );
    return await rendreCompte(compteRendu, mode.marque, openNtfy(config, openHttp()), log);
  } finally {
    for (const [nom, fermer] of [
      ['base', (): Promise<void> => base.close()],
      ['coinbase', (): Promise<void> => coinbase.close()],
    ] as const) {
      try {
        await fermer();
      } catch (erreur) {
        process.stderr.write(`fermeture ${nom} : ${texte(erreur)}\n`);
      }
    }
  }
}

// `process.exitCode` et non `process.exit()` : la derniere ligne du journal part.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (erreur: unknown) => {
    process.stderr.write(`${texte(erreur)}\n`);
    process.exitCode = 1;
  },
);
