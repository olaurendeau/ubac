import { ccxtTransport, openCoinbase, openCoinbaseExecution } from '../adapters/coinbase.js';
import { openDatabase } from '../adapters/db.js';
import { openHealthcheck } from '../adapters/healthcheck.js';
import { openHttp } from '../adapters/http.js';
import type { Effets } from '../adapters/inertes.js';
import { portsInertes } from '../adapters/inertes.js';
import { openMailer } from '../adapters/mailer.js';
import { openMarketData } from '../adapters/market.js';
import { openNotifier } from '../adapters/notifier.js';
import { loadConfig } from '../config/env.js';
import type { IsoDate } from '../core/types.js';
import type { RunClock } from './daily.js';
import { reported, runDaily } from './daily.js';

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
 * **Il est aussi le seul lieu du mode.** `--dry-run` est lu ici, une fois, et
 * ne voyage pas : il choisit quels ports sont composes, et aucun module en aval
 * n'en recoit la valeur (E15, E17). A25 de `test/jobs/purete.test.ts` refuse
 * que le mode soit nomme ailleurs dans `src/`.
 *
 * `docs/run-quotidien.md` donne les commandes, les codes de sortie et les
 * limites ; son §8, le `DRY_RUN`.
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
  'usage : tsx src/jobs/daily-main.ts --run-date=YYYY-MM-DD --git-sha=<sha> [--at=<instant ISO>] [--dry-run]',
  '  --run-date  jour UTC du run. Aucun defaut : le job n’a pas d’horloge.',
  '  --git-sha   code qui tourne, journalise dans decisions.git_sha.',
  '  --at        instant de decisions.created_at ; par defaut 00:00:00Z du jour de run.',
  '  --dry-run   lit tout, n’ecrit rien en base et n’envoie rien : ports inertes.',
].join('\n');

/** Le drapeau du mode, sans valeur : `--dry-run=false` n'existe pas, il est refuse. */
const DRY_RUN = '--dry-run';

/** Les trois options a valeur. Tout autre argument est refuse, voir `readArguments`. */
const OPTIONS = ['run-date', 'git-sha', 'at'] as const;

/**
 * La premiere ligne du journal, dans les deux modes : un `DRY_RUN` perdu en
 * chemin est un run reel, et c'est ici qu'on le voit.
 */
const LIGNE_DRY_RUN =
  'mode DRY_RUN : lectures reelles ; decisions, photo, alertes, rapport, ping et ordres retenus par des ports inertes.';
const LIGNE_NORMALE =
  'mode normal : ecritures et envois reels ; ordres places sur Coinbase, en limit post-only.';

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
  readonly dryRun: boolean;
}

function readArguments(args: readonly string[]): Arguments {
  /*
   * **Un argument inconnu arrete tout**, et c'est le drapeau qui l'exige : une
   * faute de frappe — `--dryrun`, `--dry-run=true` — ignoree en silence ferait
   * un run reel de ce qui devait etre un essai a blanc. Seul le nom est cite,
   * jamais la valeur : ce qui suit un `=` n'a rien a faire sur stderr.
   */
  const inconnus = args.filter(
    (arg) => arg !== DRY_RUN && !OPTIONS.some((nom) => arg.startsWith(`--${nom}=`)),
  );
  if (inconnus.length > 0) {
    const noms = inconnus.map((arg) => arg.split('=')[0]).join(' ');
    throw new Error(`argument inconnu : ${noms}\n${USAGE}`);
  }
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
  return { runDate, gitSha, instant, dryRun: args.includes(DRY_RUN) };
}

function texte(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Zero si le run a conclu **et** qu'il a rendu compte — alertes parties, rapport
 * quotidien parti. Un sinon, abandon de reconciliation compris : ce n'est pas
 * une anomalie du programme, mais ce n'est pas un succes, et le declencheur
 * exterieur doit le voir rouge.
 *
 * **Le ping du healthcheck n'entre pas dans le code de sortie**, et c'est
 * decide : son absence est deja ce qui fait sonner la surveillance, alors qu'un
 * compte rendu qui n'est pas parti — alerte ou rapport — ne laisse rien derriere
 * lui. Voir `reported` et `docs/healthcheck.md` §4.
 *
 * La regle elle-meme est `reported` dans `daily.ts`, et non ici : rien ne peut
 * importer ce fichier (A22), donc une regle ecrite ici serait une regle sans
 * sonde. Le motif de la seconde moitie est dans son en-tete.
 */
async function main(argv: readonly string[]): Promise<number> {
  const { runDate, gitSha, instant, dryRun } = readArguments(argv);
  const config = loadConfig();
  const clock: RunClock = { today: () => runDate, instant: () => instant };
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  /*
   * Un seul transport pour les deux lectures Coinbase : la cle signe les routes
   * privees, les bougies sont publiques, et c'est le meme client HTTP. Le
   * fermer une fois ferme les deux.
   *
   * Le lecteur recoit le portefeuille **attendu** et le journal (E6, E8) : la
   * premiere lecture du run — `keyPermissions`, etape 1 — journalise les
   * permissions effectives, puis refuse une cle scopee ailleurs. Le controle
   * n'est pas anticipe ici par un appel avant `runDaily` : il leverait hors de
   * son `try`, et le refus partirait sans l'alerte qui le signale a
   * l'operateur. A l'etape 1, rien d'autre n'est encore lu, decide ni ecrit.
   */
  const transport = ccxtTransport(config.secrets);
  const exchange = openCoinbase(transport, {
    portfolioUuid: config.secrets.coinbasePortfolioUuid,
    log,
  });
  const market = openMarketData(transport);
  const db = openDatabase(config.secrets);
  /*
   * **Un seul transport pour les trois canaux du §9.** `openHttp` ne retient
   * rien — il ferme sa closure sur un delai, pas sur une connexion — donc en
   * fabriquer trois ne donnerait que trois exemplaires de la meme politique,
   * libres de diverger au premier reglage. Partager la closure ne couple rien :
   * chaque appel ouvre et referme sa propre requete, et un Brevo injoignable ne
   * change rien a ce que ntfy repond. Aucun des trois n'a quoi que ce soit a
   * fermer — un POST par message, aucune connexion retenue —, donc aucun
   * n'entre dans le `finally` ci-dessous.
   */
  const http = openHttp();
  /*
   * **Le port reel d'execution n'existe que dans les effets reels**, et n'est
   * ouvert qu'a l'etape 1 du run : c'est la qu'une cle sans `can_trade` le fait
   * lever (E7), dans le `try` de `runDaily`, donc avec son alerte. Le meme
   * lecteur, memoise, sert la cle aux deux : une seule lecture, une seule ligne
   * d'E8. En `DRY_RUN`, `portsInertes` le remplace sans jamais l'ouvrir : A24 de
   * `test/jobs/purete.test.ts` tient les deux moities.
   */
  const reels: Effets = {
    db,
    notifier: openNotifier(config.secrets, http),
    mailer: openMailer(config.secrets, http),
    healthcheck: openHealthcheck(config.secrets, http),
    execution: () => openCoinbaseExecution(transport, exchange),
  };
  /*
   * **La seule condition de mode du depot** (E15). Les ports inertes sont des
   * implementations des memes types : `runDaily` recoit un objet de la meme
   * forme dans les deux cas, et rien en aval ne peut les distinguer. La base
   * inerte garde les lectures de la vraie — un `DRY_RUN` doit rejouer la
   * journee, pas une journee vide.
   */
  const mode = dryRun
    ? { ligne: LIGNE_DRY_RUN, effets: portsInertes(reels, log) }
    : { ligne: LIGNE_NORMALE, effets: reels };
  log(mode.ligne);

  try {
    const result = await runDaily({
      ports: { exchange, market, ...mode.effets },
      clock,
      config,
      gitSha,
      log,
    });
    return reported(result) ? 0 : 1;
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
