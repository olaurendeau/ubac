/**
 * Le transport HTTP des canaux de surveillance : ntfy aujourd'hui, le
 * healthcheck au lot suivant. Un POST, un corps, des entetes, et **aucune
 * exception**.
 *
 * Trois proprietes gouvernent ce fichier.
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
 *    formes qu'on lui a apprises, et il suffit d'une forme non prevue. Voir
 *    `docs/alertes.md` §4.
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
 * Rend le motif lisible d'un echec. **Le seul fabricant de chaines d'echec.**
 * Il n'accepte que les quatre variantes connues ; l'absence de variante et une
 * variante inventee rendent toutes deux le repli, parce qu'un appelant ne
 * choisit pas le texte que nous ecrivons.
 *
 * Le parametre admet `undefined` a dessein : les types ne survivent pas a
 * l'execution, et un transport tiers peut rendre un `FAILED` sans `failure`.
 */
export function motifDe(failure: HttpFailure | undefined): string {
  if (failure?.kind === 'REFUS') return `refus du serveur, HTTP ${entier(failure.httpStatus)}`;
  if (failure?.kind === 'DELAI') return `delai de ${entier(failure.timeoutMs)} ms depasse`;
  if (failure?.kind === 'RESEAU') return 'echec reseau';
  return MOTIF_INCONNU;
}

/**
 * Classer n'est pas recopier. `name` est **compare** a un litteral, jamais
 * repris dans ce qui sort : c'est une propriete ordinaire, que n'importe quel
 * appelant peut poser, et la recopier reviendrait a lui laisser ecrire notre
 * motif. Le `message`, la `cause` et la pile ne sont pas lus du tout.
 *
 * `AbortError` n'a pas de variante : ce module n'avorte que par
 * `AbortSignal.timeout`, qui leve un `TimeoutError`. En ajouter une aurait fait
 * une promesse qu'aucune sonde ne pouvait tenir ; il tombe donc en `INCONNU`.
 */
function echecDe(error: unknown, timeoutMs: number): HttpFailure {
  if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'DELAI', timeoutMs };
  if (error instanceof TypeError) return { kind: 'RESEAU' };
  return { kind: 'INCONNU' };
}

/**
 * `AbortSignal.timeout` plutot qu'un minuteur maison : c'est le seul moyen de
 * couper une requete qui ne repond pas, et le `TimeoutError` qu'il leve se
 * distingue d'une panne reseau dans la variante rendue.
 */
export function openHttp(timeoutMs: number = HTTP_TIMEOUT_MS): HttpSend {
  return async (request: HttpRequest): Promise<HttpOutcome> => {
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { ...request.headers },
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { status: 'FAILED', failure: { kind: 'REFUS', httpStatus: response.status } };
      }
      return { status: 'OK', httpStatus: response.status };
    } catch (error) {
      return { status: 'FAILED', failure: echecDe(error, timeoutMs) };
    }
  };
}
