import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HttpFailure, HttpOutcome, HttpRequest, HttpSend } from '../../src/adapters/http.js';
import { openHttp } from '../../src/adapters/http.js';
import { BREVO_ENDPOINT, openMailer } from '../../src/adapters/mailer.js';
import type { DailyReportMail } from '../../src/report/daily-report.js';
import { REPORT_TAG } from '../../src/report/daily-report.js';

/**
 * L'envoi du rapport quotidien par l'API HTTP Brevo. **Aucun reseau, aucune
 * cle** : `openMailer` recoit un transport de test, et les deux sondes qui
 * montent le vrai `openHttp` remplacent `fetch` par un double. Verifie sous
 * `--network none`.
 *
 * Les affirmations eprouvees ici sont les cinq de l'en-tete de `mailer.ts`,
 * chacune avec sa sonde. La forme du corps — `sender`, `to`, `subject`,
 * `htmlContent`, `tags` — est celle qui a ete eprouvee en reel contre le compte
 * de l'operateur avant d'etre ecrite ; c'est pourquoi elle est relue ici champ
 * par champ et non par un `toMatchObject` indulgent.
 */

const SECRETS = {
  brevoApiKey: 'cle-de-test',
  brevoSender: 'ubac@exemple.test',
  brevoRecipient: 'operateur@exemple.test',
};

const courrier = (overrides: Partial<DailyReportMail> = {}): DailyReportMail => ({
  subject: 'Ubac 2026-09-12 — 100000.00 USDC — aucun declenchement',
  html: '<div>rapport</div>',
  tags: [REPORT_TAG],
  ...overrides,
});

/** Le corps JSON que `mailer.ts` publie. Relu tel quel, sans indulgence. */
interface BrevoPayload {
  readonly sender: { readonly email: string };
  readonly to: readonly { readonly email: string }[];
  readonly subject: string;
  readonly htmlContent: string;
  readonly tags: readonly string[];
}

interface Publication {
  readonly request: HttpRequest;
  readonly payload: BrevoPayload;
}

/** Un transport double qui retient ce qu'on lui a demande d'envoyer. */
function transport(
  outcome: HttpOutcome = { status: 'OK', httpStatus: 201 },
): { readonly send: HttpSend; readonly envois: Publication[] } {
  const envois: Publication[] = [];
  return {
    envois,
    send: (request: HttpRequest) => {
      envois.push({ request, payload: JSON.parse(request.body) as BrevoPayload });
      return Promise.resolve(outcome);
    },
  };
}

// --- la fuite de cle --------------------------------------------------------

/**
 * La cle que les sondes de fuite font circuler. Une seule chaine, cherchee
 * partout : si elle ressort ou que ce soit, c'est une cle a revoquer.
 */
const CLE = 'xkeysib_CLE_QUI_NE_DOIT_PAS_SORTIR';

/**
 * Serialise **tout** ce qu'une valeur porte, y compris ce que `JSON.stringify`
 * laisse tomber : le message, le nom et la pile d'une erreur sont des proprietes
 * non enumerables, et la `cause` se cache d'un niveau. Meme fonction que dans
 * `test/adapters/notifier.test.ts`, meme motif.
 */
function serialiser(valeur: unknown, profondeur = 0): string {
  if (profondeur > 6) return '';
  if (valeur instanceof Error) {
    const champs = [valeur.name, valeur.message, valeur.stack ?? ''];
    return `${champs.join(' ')} ${serialiser(valeur.cause, profondeur + 1)}`;
  }
  if (typeof valeur === 'object' && valeur !== null) {
    return Object.entries(valeur)
      .map(([nom, item]) => `${nom} ${serialiser(item, profondeur + 1)}`)
      .join(' ');
  }
  return String(valeur);
}

const aucuneTrace = (valeur: unknown): void => {
  expect(serialiser(valeur)).not.toContain(CLE);
};

// --- 1. la route et le corps ------------------------------------------------

describe('l’envoi porte la forme que Brevo a acceptee en reel', () => {
  it('poste sur /v3/smtp/email, et nulle part ailleurs', async () => {
    const double = transport();
    await openMailer(SECRETS, double.send).sendReport(courrier());

    expect(double.envois).toHaveLength(1);
    expect(double.envois[0]?.request.url).toBe(BREVO_ENDPOINT);
    expect(BREVO_ENDPOINT).toBe('https://api.brevo.com/v3/smtp/email');
  });

  /*
   * Un `toEqual` sur l'objet entier, et non cinq lectures de champ : il dit la
   * meme chose **et** qu'aucun champ ne s'ajoute, un champ inconnu faisant
   * refuser la requete entiere chez Brevo. Trois proprietes en tombent du meme
   * coup, et chacune est une decision :
   *
   * - **un destinataire**, dans une liste d'un element — plusieurs seront une
   *   decision, pas une virgule dans une variable, que `env.ts` refuse deja ;
   * - **aucune version texte** : ecart declare dans `docs/rapport-quotidien.md`
   *   §5, qui ne peut donc pas se lever sans que la documentation suive ;
   * - **le tag du §9**, repris ci-dessous sur ses trois cas.
   */
  it('porte sender, to, subject, htmlContent et tags, et rien d’autre', async () => {
    const double = transport();
    const mail = courrier();
    await openMailer(SECRETS, double.send).sendReport(mail);

    expect(double.envois[0]?.payload).toEqual({
      sender: { email: SECRETS.brevoSender },
      to: [{ email: SECRETS.brevoRecipient }],
      subject: mail.subject,
      htmlContent: mail.html,
      tags: [REPORT_TAG],
    });
  });
});

// --- 2. le tag du §9 --------------------------------------------------------

describe('§9 — le tag daily-report est sur chaque envoi', () => {
  it('le porte quand le rendu le donne, sans le doubler', async () => {
    const double = transport();
    await openMailer(SECRETS, double.send).sendReport(courrier({ tags: [REPORT_TAG] }));

    expect(double.envois[0]?.payload.tags).toEqual([REPORT_TAG]);
  });

  /*
   * Le §9 dit « sur chaque envoi », et le seul endroit qui sache ce qu'est un
   * envoi est celui-ci. Un rendu qui oublierait le tag part quand meme tague :
   * c'est la difference entre retransmettre et garantir.
   */
  it('l’impose quand le rendu ne le donne pas', async () => {
    const double = transport();
    await openMailer(SECRETS, double.send).sendReport(courrier({ tags: [] }));

    expect(double.envois[0]?.payload.tags).toEqual([REPORT_TAG]);
  });

  it('le met en tete et garde ce qui l’accompagnait', async () => {
    const double = transport();
    await openMailer(SECRETS, double.send).sendReport(courrier({ tags: ['rejeu', REPORT_TAG] }));

    expect(double.envois[0]?.payload.tags).toEqual([REPORT_TAG, 'rejeu']);
  });

  /*
   * Le litteral n'est pas recopie ici : `REPORT_TAG` est importe du rendu, et
   * c'est cette sonde qui dit ce que la constante vaut vraiment. Deux litteraux
   * auraient diverge sans que rien ne rougisse.
   */
  it('vaut bien « daily-report »', () => {
    expect(REPORT_TAG).toBe('daily-report');
  });
});

// --- 3. les deux sorts ------------------------------------------------------

describe('le sort du courrier', () => {
  it('rend SENT avec le statut sur un 201', async () => {
    const double = transport({ status: 'OK', httpStatus: 201 });
    const sort = await openMailer(SECRETS, double.send).sendReport(courrier());

    expect(sort).toEqual({ status: 'SENT', httpStatus: 201 });
  });

  /*
   * Les quatre variantes d'echec de `http.ts`, chacune avec le motif que
   * `motifDe` en fait. Aucun texte n'est fabrique ici : c'est ce qui rend
   * impossible qu'une cle remonte d'un transport jusqu'a un journal.
   */
  it.each([
    [{ kind: 'REFUS', httpStatus: 401 } as HttpFailure, 'refus du serveur, HTTP 401'],
    [{ kind: 'DELAI', timeoutMs: 5000 } as HttpFailure, 'delai de 5000 ms depasse'],
    [{ kind: 'RESEAU' } as HttpFailure, 'echec reseau'],
    [{ kind: 'INCONNU' } as HttpFailure, 'echec de transport'],
  ])('rend FAILED et le motif borne de %o', async (failure, motif) => {
    const double = transport({ status: 'FAILED', failure });
    const sort = await openMailer(SECRETS, double.send).sendReport(courrier());

    expect(sort).toEqual({ status: 'FAILED', reason: motif });
  });
});

// --- 4. sendReport ne rejette jamais ---------------------------------------

describe('sendReport ne rejette jamais', () => {
  /**
   * Cinq facons dont une cle voyage reellement dans ce qu'un transport leve. Le
   * `name` compte autant que le `message` : c'est une propriete ordinaire, qu'un
   * appelant pose comme il veut.
   */
  const SEMEURS: readonly (readonly [string, () => unknown])[] = [
    ['le message d’une erreur', () => new Error(`POST refuse, api-key ${CLE}`)],
    ['le nom d’une erreur', () => Object.assign(new TypeError('echec'), { name: CLE })],
    ['la cause d’une erreur', () => new TypeError('echec', { cause: new Error(CLE) })],
    ['une chaine jetee telle quelle', () => `api-key ${CLE}`],
    ['un objet jete qui n’est pas une erreur', () => ({ 'api-key': CLE })],
  ];

  it.each(SEMEURS)('rend un sort quand le transport leve %s', async (_nom, jete) => {
    const send: HttpSend = () => {
      throw jete();
    };
    const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, send).sendReport(courrier());

    expect(sort).toEqual({ status: 'FAILED', reason: 'envoi en echec' });
    aucuneTrace(sort);
  });

  it('rend un sort quand le transport rejette', async () => {
    const send: HttpSend = () => Promise.reject(new Error(CLE));
    const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, send).sendReport(courrier());

    expect(sort).toEqual({ status: 'FAILED', reason: 'envoi en echec' });
    aucuneTrace(sort);
  });

  /*
   * Le sort rendu par le transport n'est pas de notre fabrication : `status` et
   * `failure` sont des proprietes, et une propriete se lit par un getter qui
   * s'execute. Les deux lectures sont dans le `try`, donc un getter qui leve en
   * citant la cle n'en fait rien sortir.
   */
  it.each(['status', 'failure'])('rend un sort quand le transport piege %s', async (propriete) => {
    const piege = {} as HttpOutcome;
    Object.defineProperty(piege, propriete, {
      get: () => {
        throw new Error(CLE);
      },
    });
    const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, () =>
      Promise.resolve(piege),
    ).sendReport(courrier());

    expect(sort.status).toBe('FAILED');
    aucuneTrace(sort);
  });

  /*
   * Le courrier vient de l'appelant, pas du transport. Le `try` couvre aussi la
   * fabrication du corps, donc un getter pose sur `subject`, `html` ou `tags`
   * tombe dans le filet au lieu de faire rejeter — et rien n'est publie.
   */
  it.each(['subject', 'html', 'tags'])(
    'rend un sort quand le courrier piege %s, et ne publie rien',
    async (champ) => {
      const piege = { ...courrier() } as Record<string, unknown>;
      Object.defineProperty(piege, champ, {
        get: () => {
          throw new Error(CLE);
        },
      });
      const double = transport();
      const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, double.send).sendReport(
        piege as unknown as DailyReportMail,
      );

      expect(sort).toEqual({ status: 'FAILED', reason: 'envoi en echec' });
      expect(double.envois).toEqual([]);
      aucuneTrace(sort);
    },
  );

  /*
   * L'ancienne forme du contrat de transport : un motif en clair rendu dans le
   * sort. `motifDe` ne lit que la variante, donc il est ignore — et c'est le but.
   */
  it('ignore un motif en clair rendu par un transport tiers', async () => {
    const empoisonne = {
      status: 'FAILED',
      failure: { kind: 'REFUS', httpStatus: 401 },
      reason: `api-key ${CLE}`,
    } as unknown as HttpOutcome;
    const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, () =>
      Promise.resolve(empoisonne),
    ).sendReport(courrier());

    expect(sort).toEqual({ status: 'FAILED', reason: 'refus du serveur, HTTP 401' });
    aucuneTrace(sort);
  });
});

// --- 5. la cle ne sort que par l'entete ------------------------------------

describe('la cle ne sort que par l’entete api-key', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('la pose dans l’entete, et nulle part ailleurs', async () => {
    const double = transport();
    await openMailer({ ...SECRETS, brevoApiKey: CLE }, double.send).sendReport(courrier());

    const envoi = double.envois[0];
    expect(envoi?.request.headers['api-key']).toBe(CLE);
    expect(envoi?.request.url).not.toContain(CLE);
    expect(envoi?.request.body).not.toContain(CLE);
  });

  /*
   * Le vrai `openHttp`, monte sur un `fetch` double : ce que la sonde
   * precedente etablit sur le contrat, celle-ci l'etablit sur la requete
   * reellement formee. Aucun reseau — `fetch` est remplace, et c'est le seul
   * moyen de voir les entetes telles qu'elles partent.
   */
  it('l’entete arrive telle quelle jusqu’a fetch, sans reseau', async () => {
    const vues: { url: string; headers: Record<string, string>; body: string }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      vues.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return Promise.resolve(new Response('{"messageId":"<x@brevo>"}', { status: 201 }));
    });

    const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, openHttp()).sendReport(
      courrier(),
    );

    expect(sort).toEqual({ status: 'SENT', httpStatus: 201 });
    expect(vues).toHaveLength(1);
    expect(vues[0]?.url).toBe(BREVO_ENDPOINT);
    expect(vues[0]?.headers['api-key']).toBe(CLE);
    expect(vues[0]?.headers['Content-Type']).toBe('application/json');
    expect(vues[0]?.body).not.toContain(CLE);
  });

  /*
   * Un 401 sur la vraie chaine : `fetch` rend une reponse pour un refus comme
   * pour un succes, et ne pas lire `ok` donnerait un canal qui se croit vivant
   * avec une cle revoquee. C'est exactement la panne muette que ce lot existe
   * pour eviter.
   */
  it('un refus de Brevo n’est pas un succes', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('non', { status: 401 })));

    const sort = await openMailer({ ...SECRETS, brevoApiKey: CLE }, openHttp()).sendReport(
      courrier(),
    );

    expect(sort).toEqual({ status: 'FAILED', reason: 'refus du serveur, HTTP 401' });
    aucuneTrace(sort);
  });
});
