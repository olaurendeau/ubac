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

// --- l'alerte qui ne se laisse pas lire -------------------------------------

/**
 * Une alerte ordinaire, sauf que **lire** le champ nomme execute un getter qui
 * leve — avec le jeton dedans. C'est la meme classe que `piegeSur`, tournee vers
 * l'autre objet etranger du module : celui que l'appelant fournit.
 */
function alerteQuiLeveSur(champ: keyof Alert): Alert {
  const piege: Record<string, unknown> = { ...alerte() };
  Object.defineProperty(piege, champ, {
    configurable: true,
    get(): never {
      throw new Error(`Bearer ${JETON}`);
    },
  });
  return piege as unknown as Alert;
}

/**
 * Le piege que l'encodage de la cle rouvrirait a lui seul : la valeur se lit
 * sans lever, mais c'est `champ.length` qui leve ensuite. Un bornage pose
 * uniquement autour de la lecture, sans controle de type, passerait ici.
 */
function texteDontLaLongueurLeve(): unknown {
  const objet = {
    toString(): string {
      return `Bearer ${JETON}`;
    },
  };
  Object.defineProperty(objet, 'length', {
    configurable: true,
    get(): never {
      throw new Error(`Bearer ${JETON}`);
    },
  });
  return objet;
}

/**
 * Un objet dont **seule** la chaine de prototypes leve. Il se distingue de
 * `proxyDePrototype` : ses lectures reussissent et rendent `undefined`. Il
 * montre que ce module ne parcourt jamais le prototype d'une alerte — pas
 * d'`instanceof`, pas de `Object.getPrototypeOf` — et que le repli vient alors
 * du bornage, pas du filet.
 */
function proxyDePrototypeSeul(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf(): never {
        throw new Error(`Bearer ${JETON}`);
      },
    },
  );
}

/** Une alerte valide, sauf un champ remplace par ce qu'on veut. */
function alerteAvec(champ: string, valeur: unknown): Alert {
  return { ...alerte(), [champ]: valeur } as unknown as Alert;
}

/**
 * Douze variantes ou **lire** l'alerte leve, ou bien ou il n'y a pas d'objet a
 * lire. Une par champ que le module lit, plus les trois pieges generiques et les
 * quatre valeurs qui ne sont pas des objets.
 */
const ALERTES_QUI_LEVENT: readonly (readonly [string, () => Alert])[] = [
  ['un getter event qui leve', () => alerteQuiLeveSur('event')],
  ['un getter priority qui leve', () => alerteQuiLeveSur('priority')],
  ['un getter runDate qui leve', () => alerteQuiLeveSur('runDate')],
  ['un getter title qui leve', () => alerteQuiLeveSur('title')],
  ['un getter body qui leve', () => alerteQuiLeveSur('body')],
  ['un objet dont toute lecture leve', () => proxyQuiLeve() as Alert],
  ['un objet dont la chaine de prototypes leve', () => proxyDePrototype() as Alert],
  ['un objet dont seule la chaine de prototypes leve', () => proxyDePrototypeSeul() as Alert],
  ['une chaine a la place d’un objet', () => `Bearer ${JETON}` as unknown as Alert],
  ['un nombre a la place d’un objet', () => 42 as unknown as Alert],
  ['null a la place d’un objet', () => null as unknown as Alert],
  ['undefined a la place d’un objet', () => undefined as unknown as Alert],
];

/**
 * Sept variantes ou la lecture reussit mais rend autre chose que ce qu'`Alert`
 * declare. Les types sont effaces a l'execution : une valeur etrangere qui ne
 * leve pas est aussi une valeur etrangere, et elle partirait sur le reseau ou
 * dans un journal si seul l'acte de lire etait protege.
 */
const ALERTES_HORS_FORME: readonly (readonly [string, () => Alert])[] = [
  ['un evenement inconnu', () => alerteAvec('event', `EVENT ${JETON}`)],
  ['un evenement qui n’est pas une chaine', () => alerteAvec('event', 7)],
  ['une priorite inconnue', () => alerteAvec('priority', `PRIO ${JETON}`)],
  ['une priorite qui n’est pas une chaine', () => alerteAvec('priority', 5)],
  ['un jour de run qui n’est pas une chaine', () => alerteAvec('runDate', null)],
  ['un titre dont la longueur leve', () => alerteAvec('title', texteDontLaLongueurLeve())],
  ['un corps qui n’est pas une chaine', () => alerteAvec('body', 12)],
];

/** Les dix-neuf reunies : la lecture leve, ou ce qu'elle rend est hors forme. */
const ALERTES_ILLISIBLES: readonly (readonly [string, () => Alert])[] = [
  ...ALERTES_QUI_LEVENT,
  ...ALERTES_HORS_FORME,
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

  /*
   * La limite declaree en tete de `http.ts` : ce module croit `fetch` et
   * `AbortSignal.timeout` sur parole. Elle ne l'autorise pas a rejeter pour
   * autant. La sonde remplace la globale par un signal dont la lecture
   * d'`aborted` leve : la classification perd le delai — elle n'a plus de quoi
   * le voir — mais `send` rend un sort, et rien du piege n'en ressort. La sonde
   * n'est pas une preuve contre un runtime compromis ; elle montre le seul
   * morceau de cette classe qui coutait trois lignes a fermer.
   */
  it('ne rejette pas quand la lecture de notre propre signal leve', async () => {
    vi.stubGlobal('AbortSignal', {
      timeout: (): unknown => ({
        get aborted(): boolean {
          throw new Error(`Bearer ${JETON}`);
        },
      }),
    });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    const outcome = await openHttp(20)(REQUETE);
    expect(outcome).toEqual({ status: 'FAILED', failure: { kind: 'RESEAU' } });
    aucuneTrace(outcome);
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
   * Le canal non authentifie, variante par variante. `null` est ce que
   * `loadConfig` rend sur la sentinelle `NTFY_CANAL_OUVERT`, et rien d'autre du
   * depot ne sait le produire.
   *
   * L'affirmation n'est pas « l'en-tete est vide » mais **« la cle n'existe
   * pas »**, et l'egalite stricte du jeu d'en-tetes est ce qui la tient : un
   * `Authorization: ''` ou un `Bearer null` passeraient un `not.toContain`, et
   * ntfy les lirait comme une authentification ratee — un 401 quotidien qu'on
   * confondrait avec un jeton revoque.
   */
  it('n’envoie aucun en-tete Authorization quand le canal est declare ouvert', async () => {
    const { send, requests } = transport();

    await openNotifier({ ...SECRETS, ntfyToken: null }, send).notify(alerte());

    expect(requests[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(Object.keys(requests[0]?.headers ?? {})).not.toContain('Authorization');
  });

  it('envoie exactement les deux en-tetes attendus quand un jeton est pose', async () => {
    const { send, requests } = transport();

    await openNotifier(SECRETS, send).notify(alerte());

    expect(requests[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jeton-de-test',
    });
  });

  /*
   * Seuls les en-tetes changent. L'URL, le topic, le titre, le corps, la
   * priorite et la cle sont les memes des deux cotes : un canal ouvert publie la
   * meme alerte, pas une alerte degradee.
   */
  it('publie le meme corps avec et sans jeton', async () => {
    const avec = transport();
    const sans = transport();

    await openNotifier(SECRETS, avec.send).notify(alerte());
    await openNotifier({ ...SECRETS, ntfyToken: null }, sans.send).notify(alerte());

    expect(sans.requests[0]?.body).toBe(avec.requests[0]?.body);
    expect(sans.requests[0]?.url).toBe(avec.requests[0]?.url);
  });

  /*
   * Le sort rendu ne trahit pas le mode : `SENT` et sa cle des deux cotes. Un
   * appelant qui distinguerait les deux finirait par traiter le canal ouvert
   * comme un echec.
   */
  it('rend le meme sort sans jeton qu’avec', async () => {
    const { send } = transport();

    await expect(openNotifier({ ...SECRETS, ntfyToken: null }, send).notify(alerte())).resolves.toEqual(
      { status: 'SENT', event: 'DRAWDOWN', key: alertKey(alerte()) },
    );
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

// --- l'alerte illisible : la meme classe, par la porte de l'appelant --------

/**
 * Le bloquant de la troisieme revue. Les deux premieres avaient ferme la fuite
 * du cote du transport — ce qu'il leve, ce qu'il rend. L'`Alert` restait lue
 * normalement, hors du filet, sur la foi d'un `src/jobs/alerts.ts` qui n'existe
 * pas : une garantie declaree sur un fichier absent n'en est pas une, et l'API
 * exportee accepte de toute facon l'alerte de n'importe quel appelant.
 *
 * Dix-neuf variantes, une par forme. Aucune ne fait rejeter, aucune ne publie,
 * et rien de l'objet recu ne ressort — ni dans le motif, ni dans la cle, ni par
 * une exception qui aurait emporte sa trace.
 */
describe('openNotifier — une alerte qu’on ne peut pas lire ne fait rien sortir', () => {
  /*
   * L'egalite porte sur le sort **entier** : plus fort que « le jeton n'y est
   * pas », elle interdit tout champ qui porterait quoi que ce soit de l'objet
   * recu. `reason` est une constante du module, et il n'y a pas d'`event` —
   * il n'y en a pas eu a lire.
   */
  it.each(ALERTES_ILLISIBLES)('ne rejette pas et rend UNREADABLE sur %s', async (_forme, faire) => {
    const { send, requests } = transport();

    const sort = await openNotifier(SECRETS, send).notify(faire());

    expect(sort).toEqual({ status: 'UNREADABLE', reason: 'alerte illisible' });
    aucuneTrace(sort);
    /* Ce qu'on ne sait pas lire ne part pas : le transport n'est pas appele. */
    expect(requests).toEqual([]);
  });

  /*
   * `alertKey` est exportee, donc elle recoit elle aussi l'alerte de n'importe
   * qui, et elle la lit hors de `notify`. Elle passe par la meme lecture isolee
   * et rend une constante qu'aucun digest ne peut produire — `illisible` n'est
   * pas de l'hexadecimal.
   */
  it.each(ALERTES_ILLISIBLES)('rend une cle constante sur %s, sans lever', (_forme, faire) => {
    const cle = alertKey(faire());

    expect(cle).toBe('cle-illisible');
    expect(cle).not.toMatch(/^cle-[0-9a-f]{12}$/);
    aucuneTrace(cle);
  });

  /*
   * La contrepartie du sort sans evenement, enoncee comme une sonde : deux
   * alertes illisibles ne se distinguent pas l'une de l'autre. C'est le prix
   * declare dans l'en-tete du module, et il est prefere a l'autre — recopier
   * l'evenement de l'appelant aurait fait ressortir l'objet qu'on refuse de
   * lire.
   */
  it('ne distingue pas deux alertes illisibles l’une de l’autre', async () => {
    const { send } = transport();
    const notifier = openNotifier(SECRETS, send);

    const premier = await notifier.notify(alerteQuiLeveSur('title'));
    const second = await notifier.notify(alerteAvec('event', `EVENT ${JETON}`));

    expect(second).toEqual(premier);
  });

  /*
   * Le jeton de configuration non plus ne sort pas par ce chemin. Il est lu a la
   * construction, bien avant l'alerte, et le sort rendu ne le touche pas.
   */
  it('ne rend pas le jeton de configuration sur une alerte illisible', async () => {
    const { send, requests } = transport();

    const sort = await openNotifier({ ...SECRETS, ntfyToken: JETON }, send).notify(
      alerteQuiLeveSur('body'),
    );

    expect(sort).toEqual({ status: 'UNREADABLE', reason: 'alerte illisible' });
    aucuneTrace(sort);
    expect(requests).toEqual([]);
  });

  /*
   * L'autre moitie de la frontiere : une alerte conforme passe entiere. Sans
   * cette sonde, un bornage qui rejetterait tout serait vert partout au-dessus.
   * Les sept evenements et les deux priorites sont eprouves ailleurs ; ici on
   * constate que rien n'est perdu au passage par la copie.
   */
  it('laisse passer une alerte conforme sans rien en changer', async () => {
    const { send, requests } = transport();

    const sort = await openNotifier(SECRETS, send).notify(alerte());

    expect(sort).toEqual({ status: 'SENT', event: 'DRAWDOWN', key: alertKey(alerte()) });
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      topic: 'ubac-alertes',
      title: 'Ubac 2026-09-12 — drawdown',
      message: 'drawdown a -27,00 %',
      priority: 5,
      tags: ['DRAWDOWN', alertKey(alerte())],
    });
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
    expect(sort).toEqual({ status: 'SENT', event: 'DRAWDOWN', key: alertKey(alerte()) });
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
    expect(second).toEqual(premier);
    expect(second).toEqual({ status: 'SENT', event: 'DRAWDOWN', key: alertKey(alerte()) });
  });
});
