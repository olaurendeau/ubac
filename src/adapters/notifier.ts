import { createHash } from 'node:crypto';

import type { Secrets } from '../config/env.js';
import type { IsoDate } from '../core/types.js';
import type { HttpFailure, HttpSend } from './http.js';
import { motifDe } from './http.js';

/**
 * Les alertes de la spec §9, en push immediat sur ntfy auto-heberge.
 *
 * « Le mail est un mauvais canal d'alerte : un drawdown le dimanche ne doit pas
 * attendre le lundi. » Ce module est donc le canal court ; le rapport quotidien
 * Brevo est un autre lot et un autre propos.
 *
 * Six choix sont poses ici, et chacun a son motif.
 *
 * 1. **Publication en JSON, pas en entetes.** ntfy accepte les deux : un POST
 *    sur `/<topic>` avec titre et priorite en entetes HTTP, ou un POST sur la
 *    racine avec un corps JSON qui les porte. C'est le second qui est retenu,
 *    parce qu'un entete HTTP n'est pas sur de transporter de l'UTF-8 : un titre
 *    accentue partirait mutile ou ferait echouer la requete, et une alerte
 *    illisible vaut a peine mieux qu'une alerte absente.
 * 2. **`notify` ne rejette jamais**, meme si le transport qu'on lui donne leve,
 *    et meme si l'`Alert` qu'on lui donne est un piege. `openHttp` garantit deja
 *    de ne pas rejeter, mais la garantie que ce module publie ne doit dependre
 *    ni du transport ni de l'appelant : c'est elle qui autorise le run a appeler
 *    `notify` sans `try`, et le run ne choisit pas toujours les deux.
 * 3. **Une alerte, un appel.** Aucun lot, aucune file, aucune reprise. Une
 *    reprise supposerait de retenir le processus, et le job a cinq minutes ;
 *    l'echec est donc rendu a l'appelant, qui decide ce qu'il en fait.
 * 4. **Le jeton ne sort d'ici que dans l'entete `Authorization`.** Il n'entre
 *    dans aucun message, aucun motif, aucun corps. Ce module ne fabrique ni ne
 *    recopie **aucune** chaine d'echec : le motif rendu vient de `motifDe`, qui
 *    ne connait qu'un vocabulaire ferme, et le filet du point 2 rend une
 *    constante. Rien de ce qu'un transport ecrit ne traverse `notify`.
 * 5. **Lire un objet qu'on n'a pas fabrique est aussi une prise de risque.**
 *    Borner ce qui sort ne dit rien de l'**acte de lire** : `outcome.status`
 *    comme `alert.title` peut etre un getter, et un getter s'execute. Ce module
 *    ne lit donc rien de l'exterieur hors d'un filet, et ce sont les deux memes
 *    filets pour les deux sortes d'objets etrangers : le sort rendu par le
 *    transport est lu dans le `try` du point 2, l'`Alert` recue est lue une
 *    seule fois par `lireAlerte`, qui isole la lecture et borne chaque champ.
 *    Une alerte qui ne se laisse pas lire ne fait rien rejeter, ne part pas, et
 *    rend `UNREADABLE` — rien de ce que l'appelant a pose ne sort, ni dans le
 *    motif, ni dans la cle, ni par une exception qui emporterait sa trace.
 * 6. **Chaque message porte une cle deterministe.** Elle ne dedoublonne rien —
 *    voir l'ecart declare sous `alertKey` — mais elle rend un doublon
 *    reconnaissable, par un humain comme par un traitement ulterieur.
 *
 * **Ce qui reste hors du filet, et ce qui l'assure.** Un seul point : les
 * secrets, lus **une fois, a la construction** par `openNotifier`. Cette
 * lecture-la a le droit de lever, et c'est voulu — une configuration invalide
 * doit echouer bruyamment au cablage, pas a la premiere alerte, quand il est
 * trop tard pour le dire. Ce qui l'assure n'est pas une promesse faite a un
 * appelant : `loadConfig` (`src/config/env.ts`, present aujourd'hui) construit
 * lui-meme l'objet `Secrets`, champ par champ, a partir de valeurs deja
 * validees. Passe la construction, `notify` n'en lit plus rien : l'URL, le topic
 * et le jeton sont deja des chaines de notre cote.
 *
 * Ce module ne decide **rien** de ce qui merite une alerte. Quels evenements
 * meritent un push et comment ils se redigent appartiennent a la couche des
 * jobs, et arrivent a un lot suivant ; ici il n'y a qu'un transport.
 */

/**
 * Les sept evenements qui declenchent un push. Six viennent du §9 ; le septieme
 * est declare dans `docs/alertes.md` avec son motif.
 *
 * La liste est la **source** du type, pas l'inverse : `AlertEvent` en derive,
 * donc toute table indexee par l'evenement est exhaustive a la compilation, et
 * un evenement ajoute sans priorite ne compile pas.
 */
export const ALERT_EVENTS = [
  'REBALANCE_EXECUTED',
  'DRAWDOWN',
  'REBALANCE_TOO_LARGE',
  'RECONCILIATION_DRIFT',
  'RISK_REJECTED',
  'RUN_ABORTED',
  'JOB_FAILED',
] as const;

export type AlertEvent = (typeof ALERT_EVENTS)[number];

/**
 * Deux niveaux, pas cinq. `URGENT` est celui qui traverse le mode « ne pas
 * deranger » d'Android : il est reserve a ce qui ne peut pas attendre le
 * lendemain matin. Tout mettre en urgent reviendrait a n'avoir qu'un niveau, et
 * l'operateur apprendrait a les ignorer tous.
 */
export type AlertPriority = 'URGENT' | 'HIGH';

/** L'echelle ntfy : 5 = max, 4 = high. */
const NTFY_PRIORITY: Readonly<Record<AlertPriority, number>> = { URGENT: 5, HIGH: 4 };

export interface Alert {
  readonly event: AlertEvent;
  readonly priority: AlertPriority;
  /** Le jour du run qui emet l'alerte. Premiere composante de la cle. */
  readonly runDate: IsoDate;
  /** Une ligne, lisible sur l'ecran verrouille d'un telephone. */
  readonly title: string;
  readonly body: string;
}

// --- lire l'alerte : le seul contact avec l'objet de l'appelant --------------

/**
 * L'`Alert` **recopiee** dans un objet de notre fabrication, apres une lecture
 * unique et bornee. Tout ce qui suit dans ce module travaille sur cette copie et
 * ne retouche plus jamais l'objet recu : une propriete deja lue est une valeur,
 * et une valeur ne leve pas.
 *
 * Le type n'est pas exporte a dessein. Il ne decrit pas un contrat d'appel, il
 * decrit ce que ce module accepte de croire de ce qu'on lui a donne.
 */
interface AlerteLue {
  readonly event: AlertEvent;
  readonly priority: AlertPriority;
  readonly runDate: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Les deux vocabulaires fermes, derives de leurs tables plutot que recopies :
 * un evenement ou une priorite ajoute les rejoint sans qu'on y pense, et une
 * liste qui prend du retard sur sa table est exactement le genre de garde-fou
 * qui rassure sans rien tenir.
 */
const EVENEMENTS: ReadonlySet<string> = new Set(ALERT_EVENTS);
const PRIORITES: ReadonlySet<string> = new Set(Object.keys(NTFY_PRIORITY));

/**
 * Les types sont effaces a l'execution et `notify` est une interface publique :
 * ce qui se presente comme un `AlertEvent` peut etre n'importe quoi, y compris
 * un jeton. Le bornage porte donc sur la **valeur**, pas sur sa declaration.
 */
function estEvenement(valeur: unknown): valeur is AlertEvent {
  return typeof valeur === 'string' && EVENEMENTS.has(valeur);
}

function estPriorite(valeur: unknown): valeur is AlertPriority {
  return typeof valeur === 'string' && PRIORITES.has(valeur);
}

/**
 * Une chaine, et rien d'autre. `null` n'a pas de `.length`, un objet peut en
 * avoir une qui leve : sans ce controle, l'encodage de la cle rouvrait par
 * `champ.length` la porte que la lecture isolee vient de fermer.
 */
function estTexte(valeur: unknown): valeur is string {
  return typeof valeur === 'string';
}

/**
 * **Le seul endroit de ce module qui touche a l'`Alert` recue**, et il ne la
 * touche qu'une fois.
 *
 * Une propriete se lit par un getter, et un getter s'execute : un appelant qui
 * pose sur `title` un getter qui leve en citant un secret faisait rejeter
 * `notify` en emportant ce secret, qu'une trace d'exception divulguait plus
 * haut. Le `try` rend cette classe inoffensive — ce qui leve devient
 * `undefined`, jamais une exception qui remonte, et rien de ce qui a ete jete
 * n'est lu.
 *
 * Le bornage qui suit la lecture ferme l'autre moitie : une valeur lue sans
 * lever peut quand meme etre etrangere. Tout ce qui n'est pas exactement ce que
 * `Alert` declare rend `undefined` — l'alerte est **illisible**, et une alerte
 * illisible ne se publie pas. C'est une frontiere nette, et elle est
 * volontairement sans nuance : il n'y a pas de demi-alerte qu'on enverrait
 * quand meme en devinant le reste.
 */
function lireAlerte(alert: Alert): AlerteLue | undefined {
  try {
    const { event, priority, runDate, title, body } = alert;
    if (!estEvenement(event) || !estPriorite(priority)) return undefined;
    if (!estTexte(runDate) || !estTexte(title) || !estTexte(body)) return undefined;
    return { event, priority, runDate, title, body };
  } catch {
    return undefined;
  }
}

/**
 * Trois sorts, et le troisieme est la contrepartie assumee du point 5.
 *
 * `UNREADABLE` ne porte **pas** d'evenement, parce qu'il n'y en a pas eu a lire :
 * en porter un demanderait soit d'inventer une valeur, soit de recopier celle de
 * l'appelant — c'est-a-dire de faire ressortir l'objet meme qu'on a refuse de
 * lire. Un sort qui ne dit pas de quelle alerte il parle est moins bon qu'un
 * sort qui le dit ; il vaut mieux que les deux autres options.
 */
export type AlertOutcome =
  | { readonly status: 'SENT'; readonly event: AlertEvent; readonly key: string }
  | {
      readonly status: 'FAILED';
      readonly event: AlertEvent;
      readonly key: string;
      readonly reason: string;
    }
  | { readonly status: 'UNREADABLE'; readonly reason: string };

export interface Notifier {
  /** Rend le sort de l'alerte. **Ne rejette jamais.** */
  notify(alert: Alert): Promise<AlertOutcome>;
}

type NtfySecrets = Pick<Secrets, 'ntfyUrl' | 'ntfyTopic' | 'ntfyToken'>;

/**
 * Separation de domaine et suffixe de version, comme `clientOrderId` : la cle
 * ne porte pas que ses composantes, elle porte aussi ce a quoi elle sert, et un
 * changement d'encodage se declare au lieu de passer pour un detail.
 */
const KEY_DOMAIN = 'ubac.alert-key.v1';
const KEY_PREFIX = 'cle-';

/** 12 hexadecimaux, 48 bits. Quelques alertes par jour, lisibles d'un coup d'oeil. */
const KEY_HEX_LENGTH = 12;

/**
 * La cle d'une alerte qu'on n'a pas pu lire. Elle ne peut pas se calculer — il
 * n'y a rien a hacher — et elle ne se devine pas : elle se **dit**. Aucun digest
 * ne peut la produire, l'alphabet hexadecimal n'ayant pas ces lettres, donc elle
 * ne se confond avec aucune cle reelle.
 */
const KEY_ILLISIBLE = `${KEY_PREFIX}illisible`;

/** Le motif de `UNREADABLE`. Une constante, comme celle du filet du point 2. */
const MOTIF_ILLISIBLE = 'alerte illisible';

/**
 * L'encodage, sur une alerte **deja lue**. Il n'y a plus ici que des chaines :
 * `champ.length` ne peut ni lever ni rendre autre chose qu'un nombre.
 *
 * Prefixe par longueur plutot que joint par un separateur : la collision entre
 * deux alertes distinctes devient impossible par construction, au lieu de
 * reposer sur l'absence du separateur dans un titre libre.
 *
 * Le parametre s'appelle `lue` et non `alert` : dans ce fichier, `alert` designe
 * l'objet de l'appelant, et il n'y en a qu'un seul qui le lise.
 */
function cleDe(lue: AlerteLue): string {
  const canonical = [KEY_DOMAIN, lue.runDate, lue.event, lue.title, lue.body]
    .map((champ) => `${String(champ.length)}:${champ}`)
    .join('');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${KEY_PREFIX}${digest.slice(0, KEY_HEX_LENGTH)}`;
}

/**
 * La cle deterministe d'une alerte : `sha256(domaine | run_date | evenement |
 * titre | corps)`, tronquee. Meme alerte le meme jour, meme cle ; une
 * composante qui bouge, cle differente.
 *
 * Cette fonction est **exportee**, donc l'alerte qu'on lui donne n'est pas
 * forcement de notre fabrication : elle passe par `lireAlerte` comme `notify`,
 * et rend `cle-illisible` plutot que de propager ce qu'un getter aurait jete.
 * Un appelant qui compte sur la cle pour identifier une alerte apprend ainsi
 * qu'il n'y avait pas d'alerte a identifier, au lieu de recevoir une exception
 * qui porterait son propre objet.
 *
 * **Ecart assume avec la regle d'idempotence d'`AGENTS.md`.** Ce POST n'est pas
 * idempotent et ntfy ne dedoublonne pas : un rejeu du meme jour renvoie les
 * memes alertes. La cle ne l'empeche pas, elle rend le doublon
 * **reconnaissable** — dans les `tags` du message pour un humain, dans
 * l'`AlertOutcome` pour un journal. Le cout est benin pour une notification et
 * ne le serait pas pour un ordre : l'ecart vaut ici et nulle part ailleurs. Son
 * motif complet et ce qui le leverait sont dans `docs/alertes.md` §5.
 */
export function alertKey(alert: Alert): string {
  const lue = lireAlerte(alert);
  return lue === undefined ? KEY_ILLISIBLE : cleDe(lue);
}

/**
 * L'URL de publication est `NTFY_URL` telle quelle, normalisee par `URL`. Elle
 * n'est pas recomposee a partir de ses morceaux et le topic ne lui est pas
 * concatene : le topic voyage dans le corps JSON. Un serveur monte derriere un
 * prefixe de chemin continue donc de fonctionner, ce qu'un `new URL('/', base)`
 * aurait casse en silence.
 *
 * Les trois secrets sont lus **ici**, une fois pour toutes, et pas a chaque
 * alerte : passe cette ligne, `notify` ne travaille plus que sur des chaines de
 * notre cote. C'est la seule lecture du module qui ne soit pas sous filet, et
 * c'est assume — voir l'en-tete, « ce qui reste hors du filet ».
 */
export function openNotifier(secrets: NtfySecrets, send: HttpSend): Notifier {
  const url = new URL(secrets.ntfyUrl).toString();
  const topic = secrets.ntfyTopic;
  /*
   * **Le canal non authentifie n'envoie pas d'en-tete vide : il n'envoie pas
   * d'en-tete.** `Authorization: Bearer ` serait pire que rien — ntfy y lirait
   * une tentative d'authentification ratee et repondrait 401, la ou l'absence
   * d'en-tete est une publication anonyme parfaitement legitime sur un topic
   * public. La difference entre les deux est un jeton revoque et un canal
   * ouvert, qui ne se corrigent pas de la meme facon.
   *
   * Le `null` vient de `loadConfig`, qui l'a obtenu de la sentinelle
   * `NTFY_CANAL_OUVERT` et d'elle seule. Ce module ne compare aucune chaine :
   * le type lui interdit de concatener ce qu'il n'a pas.
   */
  const headers: Readonly<Record<string, string>> =
    secrets.ntfyToken === null
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.ntfyToken}` };
  return {
    async notify(alert: Alert): Promise<AlertOutcome> {
      /*
       * Avant tout le reste, et **une seule fois**. Ce qui suit ne touche plus a
       * l'objet de l'appelant : ni la cle, ni le corps publie, ni aucun des
       * trois sorts rendus plus bas ne le relit. Une alerte illisible s'arrete
       * ici — elle ne part pas sur le reseau, parce qu'on n'a rien de sur a y
       * mettre.
       */
      const lue = lireAlerte(alert);
      if (lue === undefined) return { status: 'UNREADABLE', reason: MOTIF_ILLISIBLE };

      const key = cleDe(lue);
      try {
        const outcome = await send({
          url,
          headers,
          body: JSON.stringify({
            topic,
            title: lue.title,
            message: lue.body,
            priority: NTFY_PRIORITY[lue.priority],
            tags: [lue.event, key],
          }),
        });
        if (outcome.status === 'OK') return { status: 'SENT', event: lue.event, key };
        /*
         * `outcome.failure` est **classe**, jamais recopie : `motifDe` n'en lit
         * que la variante. Un transport qui rendrait un motif en clair — le
         * `reason` d'une version anterieure de ce contrat, par exemple — le
         * verrait ignore, et c'est le but.
         *
         * Cette lecture-ci, comme celle de `status` juste au-dessus, est dans le
         * `try` : ce sont les deux seuls endroits ou ce module touche a un objet
         * rendu par le transport, et un getter qui leve y tombe dans le filet du
         * `catch` au lieu de faire rejeter `notify`.
         */
        const failure: HttpFailure | undefined = outcome.failure;
        return { status: 'FAILED', event: lue.event, key, reason: motifDe(failure) };
      } catch {
        /*
         * Le filet de la propriete 2, et une **constante**. L'erreur attrapee
         * n'est pas lue du tout : ni son message, ni son nom, ni sa cause, ni sa
         * pile. Pas meme pour la classer — la lire suffirait a executer un
         * getter, et un getter qui leve en citant le jeton ferait rejeter
         * `notify` en emportant ce jeton. Un transport tiers qui leve en citant
         * l'URL du topic ou le jeton ne nous fait donc rien ecrire, qu'il leve
         * la valeur ou qu'il leve a la lecture. Limite declaree : la contrepartie
         * est qu'un transport casse ne se distingue pas d'un autre dans le motif.
         *
         * `lue` est une copie, lue avant le `try` et bornee : la relire ici ne
         * peut rien declencher.
         */
        return { status: 'FAILED', event: lue.event, key, reason: 'transport en echec' };
      }
    },
  };
}
