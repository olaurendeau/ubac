import type { HttpSend } from '../adapters/http.js';
import { motifDe } from '../adapters/http.js';
import type { CompteRendu, Notification } from './regles.js';
import { notification } from './regles.js';
import type { Priorite } from './types.js';

/**
 * Le canal ntfy du convoyeur (lot Y5, CV17) : celui d'Ubac sous les variables
 * `CONVOYEUR_NTFY_*`, sur `HttpSend`, et aucun email. Comme `openNotifier` :
 * JSON, un envoi par appel, **jamais de rejet**, le jeton dans l'en-tete
 * `Authorization` seul, aucun motif recopie d'un transport.
 */

export interface CanalNtfy {
  readonly ntfyUrl: string;
  readonly ntfyTopic: string;
  /** `null` : canal ouvert, aucun en-tete `Authorization`. */
  readonly ntfyToken: string | null;
}

export type Envoi = { readonly statut: 'ENVOYE' } | { readonly statut: 'ECHEC'; readonly motif: string };

export type Envoyer = (notification: Notification) => Promise<Envoi>;

/** L'echelle ntfy : 5 = max, 4 = high, comme Ubac. */
const PRIORITE_NTFY: Readonly<Record<Priorite, number>> = { URGENT: 5, HIGH: 4 };

export function openNtfy(canal: CanalNtfy, send: HttpSend): Envoyer {
  const url = new URL(canal.ntfyUrl).toString();
  const headers: Readonly<Record<string, string>> =
    canal.ntfyToken === null
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${canal.ntfyToken}` };
  return async (n) => {
    try {
      const issue = await send({
        url,
        headers,
        body: JSON.stringify({
          topic: canal.ntfyTopic,
          title: n.titre,
          message: n.corps,
          priority: PRIORITE_NTFY[n.priorite],
          tags: ['convoyeur'],
        }),
      });
      return issue.status === 'OK' ? { statut: 'ENVOYE' } : { statut: 'ECHEC', motif: motifDe(issue.failure) };
    } catch {
      // L'erreur n'est pas lue : elle pourrait citer l'URL ou le jeton.
      return { statut: 'ECHEC', motif: 'transport en echec' };
    }
  };
}

/**
 * La fin d'un passage : notifier ce qu'il a fait (CV17), et rien s'il n'a rien
 * fait — `undefined`, pas de convoyage. `marque` suit « convoyeur » dans le
 * titre ; le point d'entree la choisit (DP4 = 1, DP5 = 2).
 *
 * Rend le code de sortie : 0 si rien n'etait a dire, ou si un convoyage complet
 * est parti ; 1 pour un compte rendu `URGENT` ou une notification perdue, que
 * le job doit montrer rouge.
 */
export async function rendreCompte(
  compteRendu: CompteRendu | undefined,
  marque: string | undefined,
  envoyer: Envoyer,
  log: (ligne: string) => void,
): Promise<number> {
  if (compteRendu === undefined) {
    log('aucune notification : passage sans convoyage');
    return 0;
  }
  const n = notification(compteRendu, marque);
  const envoi = await envoyer(n);
  log(
    `notification ${n.priorite} « ${n.titre} » : ${envoi.statut === 'ENVOYE' ? 'envoyee' : `en echec, ${envoi.motif}`}`,
  );
  return envoi.statut === 'ENVOYE' && n.priorite === 'HIGH' ? 0 : 1;
}
