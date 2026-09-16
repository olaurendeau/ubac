import type { Secrets } from '../config/env.js';
import type { DailyReportMail } from '../report/daily-report.js';
import { REPORT_TAG } from '../report/daily-report.js';
import type { HttpFailure, HttpSend } from './http.js';
import { motifDe } from './http.js';

/**
 * L'envoi du rapport quotidien du §9, par l'**API HTTP** de Brevo.
 *
 * Ce module ne rend rien et ne decide rien : `src/report/daily-report.ts` rend
 * le courrier, `src/jobs/daily.ts` decide qu'il part, et il ne reste ici qu'un
 * POST. `docs/rapport-quotidien.md` porte le propos d'ensemble.
 *
 * Cinq choix sont poses ici, et chacun a son motif.
 *
 * 1. **L'API HTTP, pas SMTP.** Le job tourne en serverless (§10) : une session
 *    SMTP ouvre une connexion longue, negocie STARTTLS et attend des reponses
 *    ligne a ligne, sur un port que la plupart des plateformes ferment en
 *    sortie. Un POST qui rend 201 ou ne rend rien se termine dans le budget du
 *    job et se raconte dans un journal. Aucune bibliotheque SMTP n'entre donc
 *    dans ce depot.
 * 2. **Le transport est `src/adapters/http.ts`, pas un second client.** Le
 *    bornage des erreurs, le delai et la garantie « ne rejette jamais » y vivent
 *    deja, relus. En ecrire un second ici aurait double la surface ou une cle
 *    peut fuir, et c'est celui qui n'a pas ete relu qui fuit. La contrepartie
 *    est declaree : `HttpOutcome` ne rend pas le corps de la reponse, donc le
 *    `messageId` que Brevo renvoie avec son 201 n'est **pas** lisible d'ici. Le
 *    statut suffit a dire « parti » ou « pas parti » ; retracer un courrier
 *    precis se fait dans la console Brevo, avec le tag ci-dessous.
 * 3. **`sendReport` ne rejette jamais.** Le rapport part **apres** que le run a
 *    tout ecrit : ni un refus de Brevo, ni une panne reseau, ni un courrier
 *    piege ne doivent faire tomber un job qui a deja fait son travail. La
 *    garantie vit ici, en un seul endroit, plutot qu'a chaque site d'appel.
 * 4. **La cle n'existe que dans l'entete `api-key`.** Elle n'entre dans aucun
 *    corps, aucun motif, aucun journal. Ce module ne fabrique **aucune** chaine
 *    d'echec : le motif rendu vient de `motifDe`, qui ne connait qu'un
 *    vocabulaire ferme de quatre variantes, et le filet du point 3 rend une
 *    constante. Rien de ce qu'un transport ecrit ne traverse `sendReport` — pas
 *    meme pour etre classe, puisque l'erreur attrapee n'est pas lue du tout.
 * 5. **Le tag du §9 est impose ici, pas recopie.** `REPORT_TAG` est importe du
 *    rendu : un second litteral aurait pu diverger. Mais le tag n'est pas
 *    seulement retransmis — il est **ajoute** a ce qui arrive, parce que le §9
 *    dit « sur chaque envoi » et que le seul endroit qui sache ce qu'est un
 *    envoi est celui-ci. Un rendu qui oublierait le tag part quand meme tague.
 *
 * **Ce qui reste hors du filet** : les trois secrets, lus **une fois, a la
 * construction** par `openMailer`. Cette lecture-la a le droit de lever, et
 * c'est voulu — une configuration invalide doit echouer au cablage, pas au
 * premier rapport, quand la journee est finie. `loadConfig` construit lui-meme
 * l'objet `Secrets` a partir de valeurs deja validees ; passe la construction,
 * `sendReport` ne travaille plus que sur des chaines de notre cote.
 *
 * **Ce que ce module ne garantit pas** : la reception. Un 201 dit que Brevo a
 * accepte le courrier, pas qu'il est arrive — SPF et DKIM sur le domaine
 * d'envoi decident du reste, et ce sont deux enregistrements DNS, pas du code
 * (`docs/rapport-quotidien.md` §1).
 */

/**
 * La route de l'API transactionnelle. Figee ici : ce n'est pas une variable
 * d'environnement, parce qu'un point de publication configurable serait un
 * moyen d'envoyer la cle ailleurs sans toucher au depot.
 */
export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/**
 * Deux sorts, et aucun texte libre. `httpStatus` est le nombre borne que rend
 * `http.ts` ; `reason` ne peut venir que de `motifDe` ou de la constante du
 * filet.
 */
export type MailOutcome =
  | { readonly status: 'SENT'; readonly httpStatus: number }
  | { readonly status: 'FAILED'; readonly reason: string };

export interface Mailer {
  /** Rend le sort du courrier. **Ne rejette jamais.** */
  sendReport(mail: DailyReportMail): Promise<MailOutcome>;
}

type BrevoSecrets = Pick<Secrets, 'brevoApiKey' | 'brevoSender' | 'brevoRecipient'>;

/**
 * Le motif du filet du point 3. Une **constante**, comme celle de
 * `notifier.ts` : l'objet attrape n'est pas lu, pas meme pour etre classe, donc
 * il n'y a rien d'autre a dire. Limite declaree, la meme que chez le voisin :
 * un transport casse ne se distingue pas d'un autre dans ce motif.
 */
const MOTIF_FILET = 'envoi en echec';

/**
 * §9 : « Tag `daily-report` sur chaque envoi ». Le tag arrive en tete, et ce qui
 * l'accompagnait suit sans doublon. Les tags de Brevo servent a filtrer la
 * console et les journaux d'evenements : un doublon y compterait deux fois le
 * meme courrier.
 *
 * `filter` sur des chaines ne peut ni lever ni rendre autre chose qu'une
 * chaine ; ce qui n'en est pas une est ecarte plutot que serialise, un tag
 * n'ayant aucune raison d'etre autre chose.
 */
function tagsDe(recus: readonly string[]): readonly string[] {
  return [REPORT_TAG, ...recus.filter((tag) => typeof tag === 'string' && tag !== REPORT_TAG)];
}

/**
 * Le corps que l'API attend : `sender`, `to`, `subject`, `htmlContent`, `tags`.
 * Cette forme exacte a ete eprouvee en reel contre le compte de l'operateur —
 * 201 rendu, evenement `delivered` confirme — avant d'etre ecrite ici.
 *
 * `to` est une liste d'un seul element : le rapport a un destinataire, et une
 * liste rendrait chaque destinataire visible des autres sans qu'aucun code ne
 * le dise. Le jour ou il y en aura plusieurs, ce sera une decision, pas une
 * consequence d'une virgule dans une variable.
 *
 * Aucune version `text/plain` : ecart declare dans `docs/rapport-quotidien.md`
 * §5. Une alternative texte aiderait la delivrabilite ; elle n'est pas livree.
 */
function corpsDe(
  mail: DailyReportMail,
  sender: string,
  recipient: string,
): string {
  return JSON.stringify({
    sender: { email: sender },
    to: [{ email: recipient }],
    subject: mail.subject,
    htmlContent: mail.html,
    tags: tagsDe(mail.tags),
  });
}

/**
 * Les trois secrets sont lus **ici**, une fois pour toutes, et pas a chaque
 * rapport. C'est la seule lecture du module qui ne soit pas sous filet, et c'est
 * assume — voir l'en-tete, « ce qui reste hors du filet ».
 */
export function openMailer(secrets: BrevoSecrets, send: HttpSend): Mailer {
  const apiKey = secrets.brevoApiKey;
  const sender = secrets.brevoSender;
  const recipient = secrets.brevoRecipient;
  return {
    async sendReport(mail: DailyReportMail): Promise<MailOutcome> {
      try {
        const outcome = await send({
          url: BREVO_ENDPOINT,
          /*
           * `api-key` est le nom exact que Brevo attend, en minuscules. La cle
           * ne sort d'ici que par cette ligne.
           */
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'api-key': apiKey,
          },
          body: corpsDe(mail, sender, recipient),
        });
        if (outcome.status === 'OK') return { status: 'SENT', httpStatus: outcome.httpStatus };
        /*
         * `outcome.failure` est **classe**, jamais recopie : `motifDe` n'en lit
         * que la variante. Un transport qui rendrait un motif en clair — une
         * cle dans un `reason`, par exemple — le verrait ignore, et c'est le
         * but. Cette lecture-ci, comme celle de `status` juste au-dessus, est
         * dans le `try` : ce sont les deux seuls endroits ou ce module touche a
         * un objet rendu par le transport.
         */
        const failure: HttpFailure | undefined = outcome.failure;
        return { status: 'FAILED', reason: motifDe(failure) };
      } catch {
        /*
         * Le filet du point 3, et une **constante**. L'erreur attrapee n'est pas
         * lue du tout : ni son message, ni son nom, ni sa cause, ni sa pile. Pas
         * meme pour la classer — la lire suffirait a executer un getter, et un
         * getter qui leve en citant la cle ferait rejeter `sendReport` en
         * emportant cette cle. Le `try` couvre aussi la fabrication du corps :
         * `mail` vient de l'appelant, donc un getter pose sur `subject` ou
         * `html` y tombe au lieu de faire rejeter.
         */
        return { status: 'FAILED', reason: MOTIF_FILET };
      }
    },
  };
}
