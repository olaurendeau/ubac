import type { Secrets } from '../config/env.js';
import type { HttpFailure, HttpSend } from './http.js';
import { motifDe } from './http.js';

/**
 * La surveillance d'absence de la spec §9, en **pulse updown.io**.
 *
 * « La surveillance ne doit pas dependre du systeme surveille. » Tout le reste
 * de ce fichier decoule de cette phrase, y compris ce qu'il refuse de faire.
 *
 * Six choix sont poses ici, et chacun a son motif.
 *
 * 1. **Une seule URL, toujours un POST, et c'est le CORPS qui porte la
 *    difference.** updown.io conserve le corps d'un pulse et sait y chercher une
 *    chaine — le champ « contains » de l'interface, `string_match` de l'API.
 *    Chaine absente, ou corps absent : le check est **DOWN**, exactement comme
 *    un ping manquant. Il n'y a donc ni suffixe d'URL ni parametre de requete a
 *    inventer, et la contrainte de `http.ts` — POST uniquement — tombe d'elle-
 *    meme. La contrepartie est une **condition de reception cote operateur**,
 *    que ce module ne peut pas garantir : voir `RUN_MARKER` et
 *    `docs/healthcheck.md` §2.
 * 2. **`RUN_MARKER` est une constante exportee, jamais un litteral recopie.**
 *    Deux litteraux divergent, et c'est celui qui n'a pas de sonde qui gagne.
 *    Le marqueur est ce qui separe un run abouti de tout le reste : le dupliquer
 *    reviendrait a poser la frontiere a deux endroits.
 * 3. **Le marqueur ne figure dans un corps que si le run a abouti**, et ce n'est
 *    pas une convention de redaction : `corpsDe` le **verifie** sur le corps
 *    assemble et remplace celui qui le porterait a tort. Le motif est sous
 *    `CORPS_REFUSE`. Une cause d'abandon qui contiendrait la chaine par accident
 *    rendrait une panne invisible — c'est la seule facon de rater une panne
 *    *en pingant*, et elle merite mieux qu'une relecture attentive.
 * 4. **`ping` ne rejette jamais.** Ni un refus du serveur, ni une panne reseau,
 *    ni un `RunPulse` piege. C'est ce qui autorise le run a pinguer sans `try` :
 *    le job a deja ecrit tout ce qu'il avait a ecrire quand ce module est
 *    appele, et un echec de surveillance ne doit pas defaire un run reussi. La
 *    garantie vit **ici**, en un seul endroit, comme celle de `notifier.ts`.
 * 5. **`HEALTHCHECK_URL` ne sort d'ici nulle part.** Ni dans le corps, ni dans
 *    un motif, ni dans une exception. C'est un secret de fait : qui la connait
 *    peut envoyer de faux pings et **masquer un job mort** — la panne exacte que
 *    ce module existe pour rendre visible. Comme dans `notifier.ts`, la
 *    propriete ne tient pas a la vigilance : ce module ne fabrique **aucune**
 *    chaine d'echec, le motif rendu vient de `motifDe` et son vocabulaire ferme,
 *    et le filet du point 4 rend une constante.
 * 6. **Le corps sert au diagnostic, et rien d'autre.** updown.io le conserve et
 *    l'affiche lors d'une panne ; il porte donc le jour de run, le code qui
 *    tournait et des comptes. Il ne porte **aucun secret et aucune donnee de
 *    marche** : ni prix, ni quantite, ni valeur de portefeuille. Le corps part
 *    chez un tiers qui le stocke, et une panne se diagnostique tres bien sans
 *    savoir combien vaut le portefeuille. C'est aussi pourquoi la cause d'un
 *    abandon voyage en **code** et non en prose — voir `RunEnding`.
 *
 * **Ce qui reste hors du filet**, et c'est le meme point que `notifier.ts` : le
 * secret est lu **une fois, a la construction**, par `openHealthcheck`. Cette
 * lecture-la a le droit de lever, et c'est voulu — une URL invalide doit
 * echouer bruyamment au cablage, pas au premier ping, quand il est trop tard
 * pour le dire. `loadConfig` (`src/config/env.ts`) l'a de toute facon deja
 * validee en `https://`.
 *
 * Ce module ne decide **rien** de ce que le run a conclu. Quand pinguer, et sur
 * quel etat, appartient a `src/jobs/daily.ts` ; ici il n'y a qu'un transport et
 * une mise en forme.
 */

/**
 * La chaine que le check updown.io doit chercher dans le corps. **Elle figure
 * dans le corps d'un run abouti, et nulle part ailleurs.**
 *
 * Elle est exportee pour deux raisons, et la seconde est la vraie. La premiere :
 * `daily.ts` n'a pas a la connaitre, mais les sondes, si. La seconde : c'est la
 * valeur que l'operateur recopie dans le champ « contains » de son check. Un
 * marqueur qui vivrait en litteral dans ce fichier et en capture d'ecran dans
 * une documentation serait deja deux valeurs.
 */
export const RUN_MARKER = 'RUN_CONCLU';

/** Les trois autres etats. Aucun ne contient `RUN_MARKER` — c'est tout l'objet. */
const ETAT_ABANDONNE = 'RUN_ABANDONNE';
const ETAT_NON_RENDU = 'RUN_NON_RENDU';
const ETAT_ILLISIBLE = 'RUN_ILLISIBLE';

/**
 * Le corps de repli quand un corps d'echec porterait le marqueur. Il ne le
 * porte pas lui-meme, et il ne le peut pas : c'est une constante de ce fichier.
 *
 * **Limite declaree** : le detail de l'abandon est perdu avec lui. C'est le bon
 * cote de l'echange — un `git_sha` illisible coute une investigation, un faux
 * `UP` coute la panne entiere.
 */
const CORPS_REFUSE = 'CORPS_REFUSE\ncorps ecarte : il portait le marqueur de succes.';

/** Le motif du filet de la propriete 4. Une constante, comme dans `notifier.ts`. */
const MOTIF_TRANSPORT = 'transport en echec';

/**
 * Comment le run s'est termine, en **vocabulaire ferme**. La cause d'un abandon
 * voyage en `step` et `code` — deux enumerations de notre fabrication — et non
 * en prose : le `reason` que porte `DailyAbort` cite des montants et des actifs,
 * et le corps d'un pulse part chez un tiers qui le conserve (propriete 6). Le
 * code **est** la cause ; le detail se lit dans le journal du job.
 *
 * `NON_RENDU` est la troisieme variante, et elle demande un mot : c'est un run
 * qui a **conclu** son travail mais dont le compte rendu n'est pas parti. Le
 * motif de ne pas la confondre avec `CONCLU` est dans `docs/healthcheck.md` §3.
 *
 * Elle porte **les deux canaux du compte rendu**, et pas un seul : une alerte
 * perdue et un rapport perdu font toutes deux un run non rendu, et l'operateur
 * qui lit le corps sur updown doit pouvoir dire laquelle des deux a eu lieu. Les
 * deux champs voyagent donc ensemble, et `alertsFailed` peut valoir zero pendant
 * que `reportFailed` vaut vrai — c'est meme le cas le plus probable, ntfy et
 * Brevo ne tombant pas ensemble.
 */
export type RunEnding =
  | { readonly kind: 'CONCLU'; readonly decisions: number; readonly alerts: number }
  | { readonly kind: 'ABANDONNE'; readonly step: string; readonly code: string }
  | {
      readonly kind: 'NON_RENDU';
      readonly alertsFailed: number;
      readonly reportFailed: boolean;
    };

/** Ce que le run raconte a sa surveillance. Le jour, le code qui tournait, la fin. */
export interface RunPulse {
  readonly runDate: string;
  /** `decisions.git_sha` : on doit pouvoir dire quel code a produit cette fin-la. */
  readonly gitSha: string;
  readonly ending: RunEnding;
}

/**
 * Le sort du ping.
 *
 * `marked` dit ce que le corps **disait**, pas ce que le service en a lu : un
 * ping en echec n'a rien dit du tout, et il porte quand meme le `marked` du
 * corps qu'il transportait. La distinction compte pour le journal — « le run a
 * abouti mais la surveillance ne l'a pas su » et « le run a abandonne » ne sont
 * pas le meme incident.
 */
export type PingOutcome =
  | { readonly status: 'PINGED'; readonly marked: boolean }
  | { readonly status: 'FAILED'; readonly marked: boolean; readonly reason: string };

export interface Healthcheck {
  /** Rend le sort du ping. **Ne rejette jamais.** */
  ping(pulse: RunPulse): Promise<PingOutcome>;
}

type HealthcheckSecrets = Pick<Secrets, 'healthcheckUrl'>;

// --- Bornage des champs -----------------------------------------------------

/** De quoi tenir un `git_sha` de 40 caracteres, et rien de plus. */
const CHAMP_MAX = 64;

const HORS_CHAMP = /[^A-Za-z0-9_-]/g;

/**
 * Un champ du corps, borne a ce qui a le droit d'y entrer. Meme raison que
 * l'`entier` de `http.ts` : les types sont effaces a l'execution et `ping` est
 * une interface publique, donc ce qui se presente comme un `git_sha` peut etre
 * n'importe quoi — une prose de 4 Kio, un objet, un secret.
 *
 * C'est une **liste de ce qui peut sortir**, jamais une liste de ce qu'il
 * faudrait masquer. Les quatre formes que le corps porte reellement — jour ISO,
 * empreinte git, nom d'etape, code de rejet — tiennent toutes dans cet alphabet.
 */
function motDe(valeur: unknown): string {
  if (typeof valeur !== 'string') return '?';
  const borne = valeur.replace(HORS_CHAMP, '').slice(0, CHAMP_MAX);
  return borne.length === 0 ? '?' : borne;
}

/** Le pendant de `motDe` pour les comptes. Meme motif, meme repli. */
function entierDe(valeur: unknown): string {
  return typeof valeur === 'number' && Number.isInteger(valeur) ? String(valeur) : '?';
}

/**
 * Le pendant de `motDe` pour un oui-non. Meme motif, meme repli : un booleen
 * annonce reste un `unknown` a l'execution, et un `String(valeur)` naif ferait
 * sortir n'importe quoi — une chaine venue d'ailleurs, un secret compris — dans
 * un corps qui part chez un tiers.
 */
function ouiNonDe(valeur: unknown): string {
  if (valeur === true) return 'oui';
  return valeur === false ? 'non' : '?';
}

// --- Le corps ---------------------------------------------------------------

interface Corps {
  readonly body: string;
  readonly marked: boolean;
}

/**
 * Le corps du pulse, et **le seul endroit qui decide si le marqueur y figure**.
 *
 * Les deux moities de la propriete 3 sont ici, et elles ne se recouvrent pas.
 * La premiere est positive : un run abouti porte le marqueur en tete, depuis une
 * constante, donc il ne peut pas manquer. La seconde est negative, et c'est elle
 * qui merite le controle explicite — le corps d'un echec est assemble a partir
 * de champs dont l'un, `gitSha`, vient de la **ligne de commande**. Un
 * `--git-sha=RUN_CONCLU` suffirait sinon a faire lire un abandon comme un
 * succes, et la panne deviendrait invisible exactement le jour ou elle compte.
 *
 * Le controle porte sur le corps **assemble**, pas champ par champ : il ne
 * depend donc pas de l'exhaustivite de la liste des champs d'aujourd'hui, ni de
 * celle de demain. Ce n'est pas un filtre par ressemblance — le seul motif qu'il
 * connait est une constante de ce fichier, comparee a l'identique.
 *
 * La quatrieme branche — une fin dont le `kind` n'est aucun des trois — n'est
 * pas defensive pour rien : `ping` est une interface publique et les types sont
 * effaces. Elle rend un corps **sans marqueur**, donc un `DOWN` : face a une fin
 * qu'on ne sait pas lire, la surveillance doit sonner, pas se taire.
 */
function corpsDe(pulse: RunPulse): Corps {
  const entete = [`run_date=${motDe(pulse.runDate)}`, `git_sha=${motDe(pulse.gitSha)}`];
  const ending: RunEnding | undefined = pulse.ending;

  if (ending?.kind === 'CONCLU') {
    const lignes = [
      RUN_MARKER,
      ...entete,
      `decisions=${entierDe(ending.decisions)}`,
      `alertes=${entierDe(ending.alerts)}`,
    ];
    return { body: lignes.join('\n'), marked: true };
  }

  let lignes: readonly string[];
  if (ending?.kind === 'ABANDONNE') {
    lignes = [ETAT_ABANDONNE, ...entete, `etape=${motDe(ending.step)}`, `code=${motDe(ending.code)}`];
  } else if (ending?.kind === 'NON_RENDU') {
    lignes = [
      ETAT_NON_RENDU,
      ...entete,
      `alertes_non_parties=${entierDe(ending.alertsFailed)}`,
      `rapport_non_parti=${ouiNonDe(ending.reportFailed)}`,
    ];
  } else {
    lignes = [ETAT_ILLISIBLE, ...entete];
  }

  const body = lignes.join('\n');
  return { body: body.includes(RUN_MARKER) ? CORPS_REFUSE : body, marked: false };
}

/**
 * Le pulse updown.io.
 *
 * L'URL est `HEALTHCHECK_URL` **telle quelle**, normalisee par `URL`, et rien ne
 * lui est concatene : c'est une URL de pulse complete, pas une racine de
 * service. Elle est lue ici, une fois pour toutes ; passe cette ligne, `ping` ne
 * travaille plus que sur une chaine de notre cote.
 *
 * Le corps part en `text/plain` : updown.io le conserve et l'affiche tel quel
 * pour l'investigation, et quatre lignes `cle=valeur` se lisent mieux qu'un JSON
 * replie dans une colonne d'interface.
 *
 * Le `try` couvre **tout** le corps, `corpsDe` compris. `pulse` vient de
 * l'appelant, donc chacune de ses proprietes peut etre un getter, et un getter
 * s'execute : sans ce filet, un getter qui leve en citant un secret ferait
 * rejeter `ping` en emportant ce secret — et ferait tomber un run qui a deja
 * tout ecrit. L'objet attrape n'est pas lu du tout, pas meme pour le classer :
 * le motif rendu est une constante.
 */
export function openHealthcheck(secrets: HealthcheckSecrets, send: HttpSend): Healthcheck {
  const url = new URL(secrets.healthcheckUrl).toString();
  return {
    async ping(pulse: RunPulse): Promise<PingOutcome> {
      let marked = false;
      try {
        const corps = corpsDe(pulse);
        marked = corps.marked;
        const outcome = await send({
          url,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: corps.body,
        });
        if (outcome.status === 'OK') return { status: 'PINGED', marked };
        /*
         * La variante est **classee**, jamais recopiee : `motifDe` n'en lit que
         * le `kind`. Un transport qui rendrait un motif en clair — et l'URL du
         * pulse avec — le verrait ignore, et c'est le but.
         */
        const failure: HttpFailure | undefined = outcome.failure;
        return { status: 'FAILED', marked, reason: motifDe(failure) };
      } catch {
        return { status: 'FAILED', marked, reason: MOTIF_TRANSPORT };
      }
    },
  };
}
