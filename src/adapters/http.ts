/**
 * Le transport HTTP des canaux de surveillance : ntfy aujourd'hui, le
 * healthcheck au lot suivant. Un POST, un corps, des entetes, et **aucune
 * exception**.
 *
 * Quatre proprietes gouvernent ce fichier.
 *
 * 1. **`send` ne rejette jamais.** Ni un refus du serveur, ni une panne reseau,
 *    ni un delai depasse ne sortent d'ici en exception. C'est ce qui permet a
 *    l'appelant d'ecrire « une alerte qui echoue ne fait pas echouer le run »
 *    sans entourer chaque appel d'un `try`. La garantie vit **ici**, en un seul
 *    endroit, plutot que d'etre repetee a chaque site d'appel — ou l'oubli d'un
 *    seul suffirait a faire tomber un run qui a deja fait son travail.
 * 2. **Un statut hors 2xx est un echec.** `fetch` rend une reponse pour un 401
 *    comme pour un 200 : ne pas lire `ok` donnerait un canal d'alerte qui se
 *    croit vivant avec un jeton revoque. C'est exactement la panne muette que
 *    la surveillance existe pour eviter.
 * 3. **Aucune prose ne traverse ce module.** Un echec sort en **variante**, pas
 *    en phrase : `HttpFailure` enumere ce qui a le droit d'etre dit, et
 *    `motifDe` est le seul fabricant de chaines d'echec. Une URL de topic ntfy
 *    est un secret de fait, un jeton en est un tout court, et l'un comme l'autre
 *    voyagent volontiers dans le `message`, le `name` ou la `cause` d'une erreur
 *    attrapee. C'est une **liste de ce qui peut sortir**, jamais une liste de ce
 *    qu'il faudrait masquer : un filtre par ressemblance ne connait que les
 *    formes qu'on lui a apprises, et il suffit d'une forme non prevue.
 * 4. **Rien d'un objet etranger n'est lu.** La propriete 3 borne ce qui **sort**
 *    et ne dit rien de l'**acte de lire**. Or lire une propriete execute un
 *    getter : un objet tiers dont le getter `name` leve — avec un jeton dans ce
 *    qu'il leve — faisait rejeter `send` en emportant ce jeton, qu'une trace ou
 *    une serialisation divulguait ensuite. Borner la sortie n'y pouvait rien,
 *    parce que la fuite passait a cote de la sortie. Aucune propriete de
 *    l'erreur attrapee n'est donc lue, et ce qui reste lu est isole ou borne —
 *    le detail est sous `echecDe` et sous `openHttp`. Voir `docs/alertes.md` §4.
 *
 * Ce module ne connait ni ntfy ni le healthcheck : il ne sait pas ce qu'il
 * transporte. C'est ce qui le rend eprouvable contre un `fetch` double, sans
 * reseau ni cle.
 */

/** Ce qu'un canal de surveillance envoie. Toujours un POST. */
export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Le vocabulaire ferme des echecs. Quatre variantes, et pour seules donnees des
 * nombres que ce module produit lui-meme. Aucun champ ne porte de texte libre :
 * c'est ce qui rend impossible, par construction et non par vigilance, qu'un
 * secret remonte d'un transport jusqu'a un journal.
 */
export type HttpFailure =
  | { readonly kind: 'REFUS'; readonly httpStatus: number }
  | { readonly kind: 'DELAI'; readonly timeoutMs: number }
  | { readonly kind: 'RESEAU' }
  | { readonly kind: 'INCONNU' };

export type HttpOutcome =
  | { readonly status: 'OK'; readonly httpStatus: number }
  | { readonly status: 'FAILED'; readonly failure: HttpFailure };

export type HttpSend = (request: HttpRequest) => Promise<HttpOutcome>;

/**
 * Cinq secondes. Le job Scaleway a cinq minutes en tout (§10) et l'alerte part
 * apres que tout est ecrit : elle n'a pas le droit de retenir le processus.
 */
export const HTTP_TIMEOUT_MS = 5_000;

/** Le repli de `motifDe`, pour toute forme qui n'est pas dans la liste. */
const MOTIF_INCONNU = 'echec de transport';

/**
 * Le seul nombre qui sorte d'ici, et il ne sort qu'entier. Les types sont
 * effaces a l'execution et `HttpSend` est une interface publique : ce qui se
 * presente comme un statut peut etre, chez un transport qui n'est pas le notre,
 * une chaine — donc un jeton.
 */
function entier(valeur: number): string {
  return Number.isInteger(valeur) ? String(valeur) : '?';
}

/**
 * Le statut, borne a un entier **des son entree** dans une variante. `fetch` est
 * une globale, et une globale se remplace : ce qui se presente comme une
 * `Response` peut rendre n'importe quoi en `status`. Sans ce bornage, la valeur
 * etrangere voyageait telle quelle dans `HttpFailure.httpStatus`, que le type
 * declare pourtant `number` — un appelant qui serialise le sort l'aurait
 * divulguee sans jamais passer par `motifDe`. Ce qui n'est pas un entier devient
 * `NaN` : la variante ne porte plus qu'un nombre, et `motifDe` le rend en `?`.
 */
function statutBorne(valeur: unknown): number {
  return typeof valeur === 'number' && Number.isInteger(valeur) ? valeur : Number.NaN;
}

/**
 * Rend le motif lisible d'un echec. **Le seul fabricant de chaines d'echec.**
 * Il n'accepte que les quatre variantes connues ; l'absence de variante et une
 * variante inventee rendent toutes deux le repli, parce qu'un appelant ne
 * choisit pas le texte que nous ecrivons.
 *
 * Le parametre admet `undefined` a dessein : les types ne survivent pas a
 * l'execution, et un transport tiers peut rendre un `FAILED` sans `failure`.
 *
 * La lecture de la variante est **isolee** : cette fonction est exportee et la
 * variante qu'on lui donne n'est pas forcement de notre fabrication. Un getter
 * `kind` ou `httpStatus` qui leve echoue donc en silence vers le repli, au lieu
 * de propager chez l'appelant ce que ce getter a jete.
 */
export function motifDe(failure: HttpFailure | undefined): string {
  try {
    if (failure?.kind === 'REFUS') return `refus du serveur, HTTP ${entier(failure.httpStatus)}`;
    if (failure?.kind === 'DELAI') return `delai de ${entier(failure.timeoutMs)} ms depasse`;
    if (failure?.kind === 'RESEAU') return 'echec reseau';
    return MOTIF_INCONNU;
  } catch {
    return MOTIF_INCONNU;
  }
}

/**
 * Le seul contact avec l'objet attrape, et il ne le **lit** pas : `instanceof`
 * interroge la chaine de prototypes, pas une propriete, donc aucun getter ne
 * s'execute. Un `Proxy` dont le piege `getPrototypeOf` leve reste la seule facon
 * d'en faire echouer le parcours ; le `try` le ramene a `false`, et rien de
 * l'objet ne sort ni ne propage.
 */
function estReseau(error: unknown): boolean {
  try {
    return error instanceof TypeError;
  } catch {
    return false;
  }
}

/**
 * Classer sans lire. Une propriete se lit par un **getter**, et un getter
 * s'execute : un objet tiers dont le getter `name` leve, en citant un jeton,
 * faisait rejeter `send` en emportant ce jeton. Aucune propriete de l'erreur
 * attrapee n'est donc lue — ni `name`, ni `message`, ni `cause`, ni `stack`, ni
 * `toString`, ni aucune autre. Ce qu'on ne lit pas ne peut pas lever.
 *
 * Le delai ne se deduit plus de l'erreur mais de **notre** signal : c'est ce
 * module qui a arme `AbortSignal.timeout`, et `aborted` est un booleen porte par
 * un objet qu'il a fabrique. La classification cesse ainsi de dependre de ce
 * qu'un tiers a bien voulu poser sur ce qu'il jette.
 *
 * **Limite declaree** : une panne reseau qui survient dans la meme milliseconde
 * que l'expiration du delai est classee en `DELAI`. Les deux se sont produites ;
 * le signal tranche pour celle qu'il connait.
 *
 * `AbortError` n'a pas de variante : ce module n'avorte que par le delai
 * ci-dessus. En ajouter une aurait fait une promesse qu'aucune sonde ne pouvait
 * tenir ; il tombe donc en `INCONNU`.
 */
function echecDe(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): HttpFailure {
  if (signal?.aborted === true) return { kind: 'DELAI', timeoutMs };
  if (estReseau(error)) return { kind: 'RESEAU' };
  return { kind: 'INCONNU' };
}

/**
 * `AbortSignal.timeout` plutot qu'un minuteur maison : c'est le seul moyen de
 * couper une requete qui ne repond pas, et il ne retient pas la boucle
 * d'evenements d'un job qui a cinq minutes.
 *
 * Le `try` couvre **tout** le corps, y compris l'armement du signal et la
 * lecture de ce que rend `fetch`. C'est voulu : `request` vient de l'appelant et
 * la reponse vient d'une globale, donc l'un comme l'autre peuvent porter un
 * getter qui leve. Aucune de ces lectures ne peut ni propager — le `catch` rend
 * une variante — ni faire sortir quoi que ce soit, puisque ce qui a ete jete est
 * classe sans etre lu et que `status` est borne a un entier.
 */
export function openHttp(timeoutMs: number = HTTP_TIMEOUT_MS): HttpSend {
  return async (request: HttpRequest): Promise<HttpOutcome> => {
    /*
     * Declare hors du `try` parce que c'est **lui** qui dit si le delai a
     * expire, a la place du `name` de l'erreur attrapee. Il reste `undefined` si
     * son armement echoue, et l'echec tombe alors en `INCONNU` plutot que de
     * sortir en exception.
     */
    let signal: AbortSignal | undefined;
    try {
      signal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { ...request.headers },
        body: request.body,
        signal,
      });
      if (!response.ok) {
        const httpStatus = statutBorne(response.status);
        return { status: 'FAILED', failure: { kind: 'REFUS', httpStatus } };
      }
      return { status: 'OK', httpStatus: statutBorne(response.status) };
    } catch (error) {
      return { status: 'FAILED', failure: echecDe(error, signal, timeoutMs) };
    }
  };
}
