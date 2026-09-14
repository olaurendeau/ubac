import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HttpFailure, HttpOutcome, HttpRequest, HttpSend } from '../../src/adapters/http.js';
import { motifDe, openHttp } from '../../src/adapters/http.js';
import type { Alert, AlertPriority } from '../../src/adapters/notifier.js';
import { ALERT_EVENTS, alertKey, openNotifier } from '../../src/adapters/notifier.js';

/**
 * Le transport HTTP et la publication ntfy. **Aucun reseau** : `fetch` est
 * remplace par un double dans les sondes de `http.ts`, et `openNotifier` recoit
 * un transport de test dans les autres. Verifie sous `--network none`.
 *
 * Les affirmations eprouvees ici sont celles des en-tetes des deux modules ;
 * chaque variante annoncee porte sa sonde.
 */

const SECRETS = {
  ntfyUrl: 'https://ntfy.test',
  ntfyTopic: 'ubac-alertes',
  ntfyToken: 'jeton-de-test',
};

const alerte = (overrides: Partial<Alert> = {}): Alert => ({
  event: 'DRAWDOWN',
  priority: 'URGENT',
  runDate: '2026-09-12',
  title: 'Ubac 2026-09-12 — drawdown',
  body: 'drawdown a -27,00 %',
  ...overrides,
});

// --- la fuite de jeton ------------------------------------------------------

/**
 * Le secret que les sondes de fuite font circuler. Une seule chaine, cherchee
 * partout : si elle ressort ou que ce soit, c'est un jeton a revoquer.
 */
const JETON = 'tk_JETON_QUI_NE_DOIT_PAS_SORTIR';

/**
 * Serialise **tout** ce qu'une valeur porte, y compris ce que `JSON.stringify`
 * laisse tomber : le message, le nom et la pile d'une erreur sont des proprietes
 * non enumerables, et la `cause` se cache d'un niveau. Chercher le jeton dans un
 * JSON aurait donne une sonde qui passe au vert sans rien garantir.
 */
function serialiser(valeur: unknown, profondeur = 0): string {
  if (profondeur > 6) return '';
  if (valeur instanceof Error) {
    const champs = [valeur.name, valeur.message, valeur.stack ?? ''];
    return `${champs.join(' ')} ${serialiser(valeur.cause, profondeur + 1)}`;
  }
  if (typeof valeur === 'object' && valeur !== null) {
    return Object.entries(valeur)
      .map(([cle, item]) => `${cle} ${serialiser(item, profondeur + 1)}`)
      .join(' ');
  }
  return String(valeur);
}

/** Le jeton n'apparait nulle part, a aucune profondeur, dans aucun champ. */
function aucuneTrace(valeur: unknown): void {
  expect(serialiser(valeur)).not.toContain(JETON);
}

/**
 * Cinq facons dont un jeton voyage reellement dans ce qu'un transport leve. Le
 * `name` compte autant que le `message` : c'est une propriete ordinaire, qu'un
 * appelant pose comme il veut, et l'ancienne version de ces deux modules la
 * recopiait telle quelle.
 */
const SEMEURS_DE_JETON: readonly (readonly [string, () => unknown])[] = [
  ['le message d’une erreur', () => new Error(`POST refuse, Bearer ${JETON}`)],
  [
    'le nom d’une erreur',
    () => Object.assign(new TypeError('echec'), { name: `TypeError ${JETON}` }),
  ],
  ['la cause d’une erreur', () => new TypeError('echec', { cause: new Error(JETON) })],
  ['une chaine jetee telle quelle', () => `Bearer ${JETON}`],
  ['un objet jete qui n’est pas une erreur', () => ({ authorization: `Bearer ${JETON}` })],
];

/**
 * Quatre facons dont un jeton arrive par le **retour** d'un transport, et non
 * par ce qu'il leve. La derniere est l'ancienne forme de ce contrat : un
 * `reason` en clair, exactement ce que `openNotifier` retransmettait.
 */
const RETOURS_EMPOISONNES: readonly (readonly [string, HttpOutcome])[] = [
  [
    'un statut HTTP qui n’en est pas un',
    { status: 'FAILED', failure: { kind: 'REFUS', httpStatus: JETON } as unknown as HttpFailure },
  ],
  [
    'un delai qui n’en est pas un',
    { status: 'FAILED', failure: { kind: 'DELAI', timeoutMs: JETON } as unknown as HttpFailure },
  ],
  [
    'une variante inventee',
    { status: 'FAILED', failure: { kind: JETON } as unknown as HttpFailure },
  ],
  [
    'un motif en clair, forme d’avant ce contrat',
    { status: 'FAILED', reason: `Bearer ${JETON}` } as unknown as HttpOutcome,
  ],
];

// --- la lecture qui leve ----------------------------------------------------

/**
 * Une erreur ordinaire, sauf que **lire** la propriete nommee execute un getter
 * qui leve — avec le jeton dedans. C'est la forme que le bornage de la sortie ne
 * voyait pas : elle ne fait pas fuir une valeur, elle fait fuir l'acte de lire.
 */
function piegeSur(propriete: string): unknown {
  const piege = new Error('echec');
  Object.defineProperty(piege, propriete, {
    configurable: true,
    get(): never {
      throw new Error(`Bearer ${JETON}`);
    },
  });
  return piege;
}

/** Un objet dont l'acces a **n'importe quelle** propriete leve. */
function proxyQuiLeve(): unknown {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error(`Bearer ${JETON}`);
      },
    },
  );
}

/**
 * Le seul piege qui atteint `instanceof` : il ne lit aucune propriete, mais il
 * parcourt la chaine de prototypes, et un `Proxy` peut la faire lever.
 */
function proxyDePrototype(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf(): never {
        throw new Error(`Bearer ${JETON}`);
      },
      get(): never {
        throw new Error(`Bearer ${JETON}`);
      },
    },
  );
}

/**
 * Une reponse dont la lecture de la propriete nommee leve. `ok` decide du refus,
 * `status` est ce qu'on en garde : une sonde par branche.
 */
function reponsePiegee(propriete: 'ok' | 'status'): unknown {
  const reponse: Record<string, unknown> = { ok: propriete === 'status', status: 200 };
  Object.defineProperty(reponse, propriete, {
    configurable: true,
    get(): never {
      throw new Error(`Bearer ${JETON}`);
    },
  });
  return reponse;
}

/**
 * Sept facons de faire lever la **lecture** elle-meme. Une sonde par propriete
 * qu'un classement naif lit — `name`, `message`, `cause`, `stack`, `toString` —
 * plus les deux pieges generiques : un objet dont toute lecture leve, et un
 * objet dont la chaine de prototypes leve.
 */
const LECTURES_PIEGEES: readonly (readonly [string, () => unknown])[] = [
  ['un getter name qui leve', () => piegeSur('name')],
  ['un getter message qui leve', () => piegeSur('message')],
  ['un getter cause qui leve', () => piegeSur('cause')],
  ['un getter stack qui leve', () => piegeSur('stack')],
  ['un getter toString qui leve', () => piegeSur('toString')],
  ['un objet dont toute lecture leve', () => proxyQuiLeve()],
  ['un objet dont la chaine de prototypes leve', () => proxyDePrototype()],
];

/** Un transport qui enregistre ce qu'on lui donne et rend ce qu'on lui dit. */
function transport(outcome: HttpOutcome = { status: 'OK', httpStatus: 200 }): {
  send: HttpSend;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  return {
    requests,
    send: (request) => {
      requests.push(request);
      return Promise.resolve(outcome);
    },
  };
}

// --- http.ts ----------------------------------------------------------------

describe('openHttp — le transport ne rejette jamais, et ne cite jamais l’URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const REQUETE: HttpRequest = {
    url: 'https://ntfy.test/topic-prive',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  };

  it('rend OK avec le statut sur une reponse 2xx', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('ok', { status: 200 })));

    await expect(openHttp()(REQUETE)).resolves.toEqual({ status: 'OK', httpStatus: 200 });
  });

  /*
   * `fetch` rend une reponse pour un 401 comme pour un 200 : ne pas lire `ok`
   * donnerait un canal d'alerte qui se croit vivant avec un jeton revoque.
   * Trois statuts, un par famille de refus qu'un serveur ntfy peut opposer.
   */
  it.each([401, 403, 500])('traite le statut %i en echec, en le citant', async (status) => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('non', { status })));

    const outcome = await openHttp()(REQUETE);
    expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'REFUS', httpStatus: status } });
    expect(motifDe({ kind: 'REFUS', httpStatus: status })).toContain(`HTTP ${String(status)}`);
  });

  it('traite une panne reseau en echec', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    const outcome = await openHttp()(REQUETE);
    expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'RESEAU' } });
  });

  /*
   * Le delai se distingue d'une panne reseau, et le signal est reel : le double
   * de `fetch` attend l'avortement que `AbortSignal.timeout` declenche, au lieu
   * de simuler un `TimeoutError` que le module n'aurait jamais vu passer.
   */
  it('coupe une requete qui ne repond pas, et le dit comme un delai', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason as Error);
          });
        }),
    );

    const outcome = await openHttp(20)(REQUETE);
    expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'DELAI', timeoutMs: 20 } });
    expect(motifDe({ kind: 'DELAI', timeoutMs: 20 })).toBe('delai de 20 ms depasse');
  });

  /*
   * L'URL d'un topic ntfy est un secret de fait, et le jeton en est un tout
   * court. Ni l'un ni l'autre n'est lu de l'erreur attrapee : cinq formes, une
   * par endroit ou un secret voyage reellement — le message, le nom de classe,
   * la cause, la pile, et la chose jetee qui n'est pas une erreur. Un module qui
   * recopierait l'un de ces champs echouerait ici.
   */
  it.each(SEMEURS_DE_JETON)('n’ecrit rien de ce que porte %s', async (_forme, jete) => {
    vi.stubGlobal('fetch', () => Promise.reject(jete()));

    const outcome = await openHttp()(REQUETE);
    expect(outcome.status).toBe('FAILED');
    aucuneTrace(outcome);
    if (outcome.status === 'FAILED') aucuneTrace(motifDe(outcome.failure));
  });

  /* `fetch` ne leve que des erreurs, mais rien ne l'oblige : le repli tient. */
  it('rend la variante inconnue quand ce qui est jete n’est pas une erreur', async () => {
    vi.stubGlobal('fetch', () => Promise.reject('panne'));

    await expect(openHttp()(REQUETE)).resolves.toEqual({
      status: 'FAILED',
      failure: { kind: 'INCONNU' },
    });
  });

  /*
   * Le bloquant de la deuxieme revue. Lire une propriete **execute son getter**,
   * et le bornage de la sortie ne protegeait que ce qui sort : un `name` qui
   * leve en citant le jeton faisait rejeter `openHttp` en emportant ce jeton,
   * qu'une trace ou une serialisation divulguait ensuite. L'egalite porte sur la
   * variante entiere, pas seulement sur l'absence du jeton : elle interdit que
   * la lecture ait seulement eu lieu.
   */
  it.each(LECTURES_PIEGEES)('ne rejette pas et classe en inconnu sur %s', async (_forme, piege) => {
    vi.stubGlobal('fetch', () => Promise.reject(piege()));

    const outcome = await openHttp()(REQUETE);
    expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'INCONNU' } });
    aucuneTrace(outcome);
    if (outcome.status === 'FAILED') aucuneTrace(motifDe(outcome.failure));
  });

  /*
   * Le delai ne se deduit plus de ce que le transport a bien voulu poser sur ce
   * qu'il jette, mais de **notre** signal. La sonde le montre en avortant pour de
   * vrai tout en jetant un objet illisible : la variante reste `DELAI`.
   */
  it('classe le delai sans rien lire de ce qui est jete', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(proxyQuiLeve());
          });
        }),
    );

    const outcome = await openHttp(20)(REQUETE);
    expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'DELAI', timeoutMs: 20 } });
  });

  /*
   * `fetch` est une globale, et une globale se remplace : ce qui revient n'est
   * pas force d'etre une `Response`. Une propriete par branche du code — `ok`
   * decide du refus, `status` est ce qu'on en garde.
   */
  it.each(['ok', 'status'] as const)(
    'ne propage pas un getter %s qui leve sur la reponse',
    async (propriete) => {
      vi.stubGlobal('fetch', () => Promise.resolve(reponsePiegee(propriete)));

      const outcome = await openHttp()(REQUETE);
      expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'INCONNU' } });
      aucuneTrace(outcome);
    },
  );

  /*
   * Le statut est borne **des son entree** dans la variante, et pas seulement
   * a l'ecriture du motif : `HttpFailure.httpStatus` se declare `number`, donc
   * un appelant qui serialise le sort sans passer par `motifDe` ne doit rien
   * trouver d'etranger a y lire.
   */
  it('borne un statut qui n’est pas un entier avant de le porter', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: `Bearer ${JETON}` }));

    const outcome = await openHttp()(REQUETE);
    expect(outcome).toEqual({
      status: 'FAILED',
      failure: { kind: 'REFUS', httpStatus: Number.NaN },
    });
    aucuneTrace(outcome);
    if (outcome.status === 'FAILED') {
      expect(motifDe(outcome.failure)).toBe('refus du serveur, HTTP ?');
    }
  });

  it('envoie bien un POST avec le corps et les entetes recus', async () => {
    const appels: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      appels.push({ url, init });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    await openHttp()(REQUETE);
    expect(appels).toHaveLength(1);
    expect(appels[0]?.url).toBe(REQUETE.url);
    expect(appels[0]?.init.method).toBe('POST');
    expect(appels[0]?.init.body).toBe('{}');
    expect(appels[0]?.init.headers).toEqual(REQUETE.headers);
  });
});

// --- notifier.ts ------------------------------------------------------------

describe('openNotifier — la publication ntfy', () => {
  it('publie en JSON sur NTFY_URL, le topic dans le corps et non dans le chemin', async () => {
    const { send, requests } = transport();

    const outcome = await openNotifier(SECRETS, send).notify(alerte());

    expect(outcome).toEqual({ status: 'SENT', event: 'DRAWDOWN', key: alertKey(alerte()) });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://ntfy.test/');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      topic: 'ubac-alertes',
      title: 'Ubac 2026-09-12 — drawdown',
      message: 'drawdown a -27,00 %',
      priority: 5,
      tags: ['DRAWDOWN', alertKey(alerte())],
    });
  });

  /*
   * Un serveur monte derriere un prefixe de chemin doit continuer de marcher :
   * c'est ce qu'un `new URL('/', base)` aurait casse en silence, en publiant a
   * la racine du domaine.
   */
  it('preserve un prefixe de chemin dans NTFY_URL', async () => {
    const { send, requests } = transport();

    await openNotifier({ ...SECRETS, ntfyUrl: 'https://hote.test/ntfy' }, send).notify(alerte());

    expect(requests[0]?.url).toBe('https://hote.test/ntfy');
  });

  it('porte le jeton en Bearer, et nulle part ailleurs', async () => {
    const { send, requests } = transport();

    await openNotifier(SECRETS, send).notify(alerte());

    expect(requests[0]?.headers['Authorization']).toBe('Bearer jeton-de-test');
    expect(requests[0]?.headers['Content-Type']).toBe('application/json');
    expect(requests[0]?.body).not.toContain('jeton-de-test');
    expect(requests[0]?.url).not.toContain('jeton-de-test');
  });

  /*
   * Les deux niveaux, un par variante. `URGENT` est celui qui traverse le mode
   * « ne pas deranger » ; les confondre reviendrait a n'avoir qu'un niveau.
   */
  it.each([
    ['URGENT', 5],
    ['HIGH', 4],
  ] as const)('traduit la priorite %s en %i', async (priority: AlertPriority, attendue) => {
    const { send, requests } = transport();

    await openNotifier(SECRETS, send).notify(alerte({ priority }));

    expect((JSON.parse(requests[0]?.body ?? '{}') as { priority: number }).priority).toBe(attendue);
  });

  it('rend FAILED avec le motif de la variante rendue, sans lever', async () => {
    const { send } = transport({ status: 'FAILED', failure: { kind: 'REFUS', httpStatus: 401 } });

    await expect(openNotifier(SECRETS, send).notify(alerte())).resolves.toEqual({
      status: 'FAILED',
      event: 'DRAWDOWN',
      key: alertKey(alerte()),
      reason: 'refus du serveur, HTTP 401',
    });
  });

  /*
   * La garantie « ne rejette jamais » ne doit pas dependre du transport qu'on
   * passe : c'est elle qui autorise le run a appeler `notify` sans `try`, et
   * l'appelant ne choisit pas toujours le transport.
   */
  it.each(SEMEURS_DE_JETON)(
    'ne rejette pas et n’ecrit rien quand le transport leve %s',
    async (_forme, jete) => {
      const send: HttpSend = () => {
        throw jete();
      };

      /*
       * L'egalite porte sur une **constante** : plus fort que « le jeton n'y est
       * pas », elle interdit que quoi que ce soit de l'erreur attrapee entre
       * dans le motif, jeton ou non.
       */
      await expect(openNotifier(SECRETS, send).notify(alerte())).resolves.toEqual({
        status: 'FAILED',
        event: 'DRAWDOWN',
        key: alertKey(alerte()),
        reason: 'transport en echec',
      });
    },
  );

  /*
   * La meme classe, cote publication : ce n'est plus la valeur jetee qui piege,
   * c'est sa **lecture**. Le filet ne lit rien de ce qu'il attrape, donc il rend
   * la constante quelle que soit la forme du piege.
   */
  it.each(LECTURES_PIEGEES)(
    'ne rejette pas quand ce que leve le transport porte %s',
    async (_forme, piege) => {
      const send: HttpSend = () => {
        throw piege();
      };

      await expect(openNotifier(SECRETS, send).notify(alerte())).resolves.toEqual({
        status: 'FAILED',
        event: 'DRAWDOWN',
        key: alertKey(alerte()),
        reason: 'transport en echec',
      });
    },
  );

  /*
   * Et la meme classe encore, mais par le **retour** : lire `status` ou
   * `failure` sur le sort d'un transport injecte execute un getter. Une sonde
   * par lecture que fait `notify`.
   */
  it.each(['status', 'failure'] as const)(
    'ne rejette pas quand lire %s du retour leve',
    async (propriete) => {
      const outcome: Record<string, unknown> = { status: 'FAILED', failure: { kind: 'RESEAU' } };
      Object.defineProperty(outcome, propriete, {
        configurable: true,
        get(): never {
          throw new Error(`Bearer ${JETON}`);
        },
      });
      const send: HttpSend = () => Promise.resolve(outcome as unknown as HttpOutcome);

      const sort = await openNotifier(SECRETS, send).notify(alerte());

      expect(sort).toEqual({
        status: 'FAILED',
        event: 'DRAWDOWN',
        key: alertKey(alerte()),
        reason: 'transport en echec',
      });
    },
  );

  it('rend l’evenement de l’alerte, quel qu’il soit', async () => {
    const { send } = transport();
    const notifier = openNotifier(SECRETS, send);

    for (const event of ALERT_EVENTS) {
      const attendue = alerte({ event });
      await expect(notifier.notify(attendue)).resolves.toEqual({
        status: 'SENT',
        event,
        key: alertKey(attendue),
      });
    }
  });

  /*
   * Le compte cite par la documentation est asserte sur la table qu'il decrit :
   * sept evenements, sans doublon. Un huitieme ajoute sans mise a jour du
   * chiffre echoue ici.
   */
  it('declare sept evenements distincts', () => {
    expect(ALERT_EVENTS).toHaveLength(7);
    expect(new Set(ALERT_EVENTS).size).toBe(7);
  });
});

// --- motifDe : la liste de ce qui peut sortir -------------------------------

describe('motifDe — quatre variantes, et un repli pour tout le reste', () => {
  /*
   * Une sonde par variante annoncee. Le motif est cite en entier, parce que
   * c'est exactement cette chaine qui finira dans un journal.
   */
  it.each([
    [{ kind: 'REFUS', httpStatus: 401 }, 'refus du serveur, HTTP 401'],
    [{ kind: 'DELAI', timeoutMs: 5000 }, 'delai de 5000 ms depasse'],
    [{ kind: 'RESEAU' }, 'echec reseau'],
    [{ kind: 'INCONNU' }, 'echec de transport'],
  ] as const)('rend « %o » en « %s »', (failure: HttpFailure, attendu) => {
    expect(motifDe(failure)).toBe(attendu);
  });

  /*
   * Le coeur de la garantie : ce n'est pas une liste de ce qu'il faut masquer,
   * c'est une liste de ce qui peut sortir. Une forme non prevue — et un jeton en
   * est toujours une — ne rend donc rien d'elle-meme.
   */
  it.each([
    ['une variante absente', undefined],
    ['une variante inventee', { kind: JETON }],
    ['un statut qui est une chaine', { kind: 'REFUS', httpStatus: JETON }],
    ['un delai qui est une chaine', { kind: 'DELAI', timeoutMs: JETON }],
    ['un statut qui n’est pas entier', { kind: 'REFUS', httpStatus: 4.5 }],
  ])('ne recopie rien de %s', (_forme, failure) => {
    const motif = motifDe(failure as HttpFailure | undefined);
    aucuneTrace(motif);
    /*
     * Plus fort que « le jeton n'y est pas » : le motif est l'un des trois que
     * ce module sait ecrire quand la donnee est hors norme. Rien de la valeur
     * recue ne s'y est glisse, pas meme un fragment.
     */
    expect([
      'echec de transport',
      'refus du serveur, HTTP ?',
      'delai de ? ms depasse',
    ]).toContain(motif);
  });

  /*
   * `motifDe` est exporte, et la variante qu'on lui donne n'est pas forcement de
   * notre fabrication : lire `kind` execute un getter. Une sonde par propriete
   * que la fonction lit, plus le piege generique.
   */
  it.each([
    ['un getter kind qui leve', 'kind', { httpStatus: 401 }],
    ['un getter httpStatus qui leve', 'httpStatus', { kind: 'REFUS' }],
    ['un getter timeoutMs qui leve', 'timeoutMs', { kind: 'DELAI' }],
  ])('rend le repli sur %s', (_forme, propriete, base) => {
    const failure: Record<string, unknown> = { ...base };
    Object.defineProperty(failure, propriete, {
      configurable: true,
      get(): never {
        throw new Error(`Bearer ${JETON}`);
      },
    });

    expect(motifDe(failure as unknown as HttpFailure)).toBe('echec de transport');
  });

  it('rend le repli quand toute lecture de la variante leve', () => {
    expect(motifDe(proxyQuiLeve() as HttpFailure)).toBe('echec de transport');
  });
});

// --- la fuite de jeton, de bout en bout -------------------------------------

describe('openNotifier — rien de ce qu’ecrit un transport ne ressort', () => {
  /*
   * Le bloquant de la revue : `openNotifier` retransmettait tel quel le motif
   * du transport. Quatre retours empoisonnes, dont l'ancienne forme du contrat,
   * et le jeton n'est nulle part — ni dans le motif, ni ailleurs dans le sort
   * rendu.
   */
  it.each(RETOURS_EMPOISONNES)('ignore %s', async (_forme, outcome) => {
    const { send } = transport(outcome);

    const sort = await openNotifier(SECRETS, send).notify(alerte());

    expect(sort.status).toBe('FAILED');
    aucuneTrace(sort);
  });

  /* Le jeton de configuration lui-meme ne sort que dans `Authorization`. */
  it('ne rend jamais le jeton de configuration dans le sort d’une alerte', async () => {
    const { send } = transport({ status: 'FAILED', failure: { kind: 'REFUS', httpStatus: 401 } });
    const secrets = { ...SECRETS, ntfyToken: JETON };

    const sort = await openNotifier(secrets, send).notify(alerte());

    aucuneTrace(sort);
  });

  /*
   * Un titre et un corps sont ecrits par l'appelant : si l'un d'eux portait un
   * secret, il partirait dans le message — c'est voulu et c'est son propos. La
   * sonde constate l'autre moitie : rien de l'alerte ne remonte dans le motif,
   * qui est la chaine destinee aux journaux.
   */
  it('ne recopie pas le contenu de l’alerte dans le motif d’echec', async () => {
    const { send } = transport({ status: 'FAILED', failure: { kind: 'RESEAU' } });

    const sort = await openNotifier(SECRETS, send).notify(
      alerte({ title: `titre ${JETON}`, body: `corps ${JETON}` }),
    );

    expect(sort.status).toBe('FAILED');
    if (sort.status === 'FAILED') aucuneTrace(sort.reason);
  });
});

// --- la cle deterministe ----------------------------------------------------

describe('alertKey — la cle qui rend un doublon reconnaissable', () => {
  it('est stable pour un meme couple (jour, evenement) et un meme contenu', () => {
    expect(alertKey(alerte())).toBe(alertKey(alerte()));
    expect(alertKey(alerte())).toMatch(/^cle-[0-9a-f]{12}$/);
  });

  /*
   * Une sonde par composante : la cle doit diverger des que l'une d'elles bouge,
   * sinon deux alertes distinctes se liraient comme un doublon.
   */
  it.each([
    ['le jour du run', { runDate: '2026-09-13' }],
    ['l’evenement', { event: 'RUN_ABORTED' }],
    ['le titre', { title: 'un autre titre' }],
    ['le corps', { body: 'un autre corps' }],
  ] as const)('diverge quand %s change', (_composante, modification) => {
    expect(alertKey(alerte(modification))).not.toBe(alertKey(alerte()));
  });

  /*
   * L'encodage est prefixe par longueur, pas joint par un separateur : deux
   * decoupages differents des memes caracteres donnent deux cles. Un `join('|')`
   * aurait confondu ces deux alertes.
   */
  it('ne confond pas deux decoupages des memes caracteres', () => {
    const gauche = alerte({ title: 'ab', body: 'c drawdown' });
    const droite = alerte({ title: 'abc', body: ' drawdown' });

    expect(alertKey(gauche)).not.toBe(alertKey(droite));
  });

  /*
   * La cle est figee, pas seulement reproductible dans un processus. Un
   * changement d'encodage entre deux deploiements rendrait un rejeu
   * meconnaissable sans qu'aucune sonde de la forme « deux appels donnent la
   * meme chose » ne bronche : la faire bouger devient un acte conscient.
   */
  it('vaut une valeur figee, pour que l’encodage ne derive pas en silence', () => {
    expect(alertKey(alerte())).toBe('cle-45bf56566460');
  });

  /* Elle voyage la ou ntfy l'affiche, et elle est rendue a l'appelant. */
  it('voyage dans les tags du message et dans le sort rendu', async () => {
    const { send, requests } = transport();

    const sort = await openNotifier(SECRETS, send).notify(alerte());

    const corps = JSON.parse(requests[0]?.body ?? '{}') as { tags: string[] };
    expect(corps.tags).toEqual(['DRAWDOWN', alertKey(alerte())]);
    expect(sort.key).toBe(alertKey(alerte()));
  });

  /*
   * L'ecart assume, enonce comme une sonde : un rejeu du meme jour **renvoie**
   * l'alerte. Rien ne la retient, et c'est le prix declare dans
   * `docs/alertes.md`. Ce qui change, c'est que les deux envois portent la meme
   * cle et se lisent donc comme un doublon.
   */
  it('n’empeche pas un second envoi le meme jour, mais le rend reconnaissable', async () => {
    const { send, requests } = transport();
    const notifier = openNotifier(SECRETS, send);

    const premier = await notifier.notify(alerte());
    const second = await notifier.notify(alerte());

    expect(requests).toHaveLength(2);
    expect(second.key).toBe(premier.key);
  });
});
