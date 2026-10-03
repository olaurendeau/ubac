/**
 * Le chargeur de configuration du convoyeur (lot Y5) : **le seul lecteur de
 * l'environnement de l'arbre**, et seulement des huit
 * variables `CONVOYEUR_*` de `docs/convoyeur.md` §4. Aucune variable d'Ubac
 * n'est lue ici, et `src/config/env.ts` ne lit aucune de celles-ci (CV3) :
 * `test/convoyeur/env.test.ts` le constate sur les deux chargeurs.
 *
 * Les principes sont ceux de `loadConfig` d'Ubac, sans son code (le convoyeur
 * n'importe pas `config/`) : une variable absente ou mal formee arrete le
 * demarrage, toutes les fautives d'un coup, **nommees sans leur valeur**.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** Les huit noms, dans l'ordre de `docs/convoyeur.md` §4. */
export const VARIABLES_CONVOYEUR = [
  'CONVOYEUR_DATABASE_URL',
  'CONVOYEUR_COINBASE_API_KEY',
  'CONVOYEUR_COINBASE_API_SECRET',
  'CONVOYEUR_PRIMARY_UUID',
  'CONVOYEUR_DESTINATION_UUID',
  'CONVOYEUR_NTFY_URL',
  'CONVOYEUR_NTFY_TOPIC',
  'CONVOYEUR_NTFY_TOKEN',
] as const;

type Variable = (typeof VARIABLES_CONVOYEUR)[number];

/**
 * La declaration d'un canal ntfy sans jeton : la meme orthographe que
 * `NTFY_CANAL_OUVERT` d'Ubac (`docs/deploiement.md`), recopiee parce que le
 * convoyeur n'importe pas `config/` ; le test d'env compare les deux.
 */
export const CANAL_OUVERT = 'CANAL-PUBLIC-SANS-JETON';

export interface ConfigConvoyeur {
  readonly databaseUrl: string;
  readonly coinbaseApiKey: string;
  readonly coinbaseApiSecret: string;
  readonly primaryUuid: string;
  readonly destinationUuid: string;
  readonly ntfyUrl: string;
  readonly ntfyTopic: string;
  /** `null` : canal declare ouvert par `CANAL_OUVERT`, aucun en-tete `Authorization`. */
  readonly ntfyToken: string | null;
}

export class ConvoyeurConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`configuration du convoyeur invalide :\n- ${issues.join('\n- ')}`);
    this.name = 'ConvoyeurConfigError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

function protocole(valeur: string): string | undefined {
  try {
    return new URL(valeur).protocol;
  } catch {
    return undefined;
  }
}

/** La forme exigee de chaque variable : un motif de refus, ou `undefined`. */
const FORMES: Readonly<Record<Variable, (valeur: string) => string | undefined>> = {
  CONVOYEUR_DATABASE_URL: (v) =>
    ['postgres:', 'postgresql:'].includes(protocole(v) ?? '') ? undefined : 'URL postgres:// attendue',
  CONVOYEUR_COINBASE_API_KEY: () => undefined,
  CONVOYEUR_COINBASE_API_SECRET: () => undefined,
  CONVOYEUR_PRIMARY_UUID: (v) => (UUID.test(v) ? undefined : 'UUID en minuscules attendu'),
  CONVOYEUR_DESTINATION_UUID: (v) => (UUID.test(v) ? undefined : 'UUID en minuscules attendu'),
  CONVOYEUR_NTFY_URL: (v) => (protocole(v) === 'https:' ? undefined : 'URL https:// attendue'),
  CONVOYEUR_NTFY_TOPIC: (v) =>
    TOPIC.test(v) ? undefined : 'topic ntfy attendu : lettres, chiffres, tiret ou souligne, 64 au plus',
  // Une sentinelle mal ecrite serait sinon envoyee comme jeton porteur.
  CONVOYEUR_NTFY_TOKEN: (v) =>
    v !== CANAL_OUVERT && v.trim().toUpperCase() === CANAL_OUVERT
      ? `le canal ouvert s'ecrit exactement ${CANAL_OUVERT}`
      : undefined,
};

/**
 * `env` est un parametre pour les tests ; le defaut est la seule lecture de
 * `process.env` du convoyeur. Chaque nom n'est lu qu'une fois.
 */
export function lireConfig(env: Env = process.env): ConfigConvoyeur {
  const issues: string[] = [];
  const valeurs = {} as Record<Variable, string>;
  for (const nom of VARIABLES_CONVOYEUR) {
    const valeur = env[nom];
    if (valeur === undefined || valeur.trim().length === 0) {
      issues.push(`${nom} : variable requise, ${valeur === undefined ? 'absente' : 'vide'}`);
      continue;
    }
    const refus = FORMES[nom](valeur);
    if (refus !== undefined) issues.push(`${nom} : ${refus} (valeur masquee)`);
    valeurs[nom] = valeur;
  }
  if (issues.length === 0 && valeurs.CONVOYEUR_PRIMARY_UUID === valeurs.CONVOYEUR_DESTINATION_UUID) {
    issues.push('CONVOYEUR_DESTINATION_UUID : doit designer ubac-agent, pas Primary (valeur masquee)');
  }
  if (issues.length > 0) throw new ConvoyeurConfigError(issues);
  return {
    databaseUrl: valeurs.CONVOYEUR_DATABASE_URL,
    coinbaseApiKey: valeurs.CONVOYEUR_COINBASE_API_KEY,
    coinbaseApiSecret: valeurs.CONVOYEUR_COINBASE_API_SECRET,
    primaryUuid: valeurs.CONVOYEUR_PRIMARY_UUID,
    destinationUuid: valeurs.CONVOYEUR_DESTINATION_UUID,
    ntfyUrl: valeurs.CONVOYEUR_NTFY_URL,
    ntfyTopic: valeurs.CONVOYEUR_NTFY_TOPIC,
    ntfyToken: valeurs.CONVOYEUR_NTFY_TOKEN === CANAL_OUVERT ? null : valeurs.CONVOYEUR_NTFY_TOKEN,
  };
}
