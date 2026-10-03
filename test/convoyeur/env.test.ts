import { describe, expect, it } from 'vitest';

import { loadConfig, NTFY_CANAL_OUVERT } from '../../src/config/env.js';
import type { Env } from '../../src/config/env.js';
import { CANAL_OUVERT, ConvoyeurConfigError, lireConfig, VARIABLES_CONVOYEUR } from '../../src/convoyeur/env.js';

/**
 * Le chargeur du convoyeur (Y5) et CV3, moitie code : chaque chargeur ne lit
 * que ses noms. La seconde moitie de CV3, la cle du convoyeur posee dans Ubac,
 * est la sonde K1 existante — `test/adapters/coinbase.test.ts`, « refuse une
 * permission accordee au-dela de la lecture et du trade » : `permissionsFrom`
 * refuse `can_transfer: true`. Elle est citee ici, pas recopiee.
 *
 * Aucune valeur n'est un secret : des chaines de forme correcte, sans contenu.
 */

const CONVOYEUR: Env = {
  CONVOYEUR_DATABASE_URL: 'postgresql://ubac_convoyeur:motdepasse@hote.test/ubac',
  CONVOYEUR_COINBASE_API_KEY: 'cle-convoyeur-de-test',
  CONVOYEUR_COINBASE_API_SECRET: 'secret-convoyeur-de-test',
  CONVOYEUR_PRIMARY_UUID: '00000000-0000-4000-8000-00000000000a',
  CONVOYEUR_DESTINATION_UUID: '00000000-0000-4000-8000-00000000000b',
  CONVOYEUR_NTFY_URL: 'https://ntfy.test',
  CONVOYEUR_NTFY_TOPIC: 'ubac-de-test',
  CONVOYEUR_NTFY_TOKEN: 'ntfy-de-test',
};

/** Un environnement d'Ubac valide (`test/config/env.test.ts`). */
const UBAC: Env = {
  DATABASE_URL: 'postgresql://utilisateur:motdepasse@hote.test/ubac',
  COINBASE_API_KEY: 'cle-de-test',
  COINBASE_API_SECRET: 'secret-de-test',
  COINBASE_PORTFOLIO_UUID: '00000000-0000-4000-8000-000000000001',
  BREVO_API_KEY: 'brevo-de-test',
  BREVO_SENDER: 'ubac@exemple.test',
  BREVO_RECIPIENT: 'operateur@exemple.test',
  NTFY_URL: 'https://ntfy.test',
  NTFY_TOPIC: 'ubac-de-test',
  NTFY_TOKEN: 'ntfy-de-test',
  HEALTHCHECK_URL: 'https://hc.test/ping/0000',
};

function issues(env: Env): readonly string[] {
  try {
    lireConfig(env);
  } catch (erreur) {
    if (erreur instanceof ConvoyeurConfigError) return erreur.issues;
    throw erreur;
  }
  throw new Error('configuration acceptee alors qu’un refus etait attendu');
}

/** Les noms qu'un chargeur lit : un environnement qui note chaque lecture. */
function noms(charger: (env: Env) => unknown, env: Env): ReadonlySet<string> {
  const lus = new Set<string>();
  const espion = new Proxy(env, {
    get(cible, nom, recepteur) {
      if (typeof nom === 'string') lus.add(nom);
      return Reflect.get(cible, nom, recepteur) as unknown;
    },
  });
  charger(espion);
  return lus;
}

describe('le chargeur du convoyeur', () => {
  it('rend les huit variables, et le canal ouvert en null', () => {
    expect(lireConfig(CONVOYEUR)).toEqual({
      databaseUrl: CONVOYEUR['CONVOYEUR_DATABASE_URL'],
      coinbaseApiKey: CONVOYEUR['CONVOYEUR_COINBASE_API_KEY'],
      coinbaseApiSecret: CONVOYEUR['CONVOYEUR_COINBASE_API_SECRET'],
      primaryUuid: CONVOYEUR['CONVOYEUR_PRIMARY_UUID'],
      destinationUuid: CONVOYEUR['CONVOYEUR_DESTINATION_UUID'],
      ntfyUrl: CONVOYEUR['CONVOYEUR_NTFY_URL'],
      ntfyTopic: CONVOYEUR['CONVOYEUR_NTFY_TOPIC'],
      ntfyToken: CONVOYEUR['CONVOYEUR_NTFY_TOKEN'],
    });
    expect(lireConfig({ ...CONVOYEUR, CONVOYEUR_NTFY_TOKEN: CANAL_OUVERT }).ntfyToken).toBeNull();
    // La meme sentinelle que celle d'Ubac : un canal se declare de la meme facon.
    expect(CANAL_OUVERT).toBe(NTFY_CANAL_OUVERT);
  });

  it('nomme toutes les variables absentes ou vides d’un coup', () => {
    expect(issues({})).toEqual(VARIABLES_CONVOYEUR.map((nom) => `${nom} : variable requise, absente`));
    expect(issues({ ...CONVOYEUR, CONVOYEUR_COINBASE_API_KEY: '  ' })).toEqual([
      'CONVOYEUR_COINBASE_API_KEY : variable requise, vide',
    ]);
  });

  it.each([
    ['CONVOYEUR_DATABASE_URL', 'mysql://u:motdepasse@hote.test/ubac'],
    ['CONVOYEUR_DATABASE_URL', 'pas-une-url-motdepasse'],
    ['CONVOYEUR_PRIMARY_UUID', '00000000-0000-4000-8000-00000000000A'],
    ['CONVOYEUR_DESTINATION_UUID', 'ubac-agent'],
    ['CONVOYEUR_NTFY_URL', 'http://ntfy.test'],
    ['CONVOYEUR_NTFY_TOPIC', 'topic/autre'],
    ['CONVOYEUR_NTFY_TOKEN', ' canal-public-sans-jeton'],
  ])('refuse %s mal formee sans citer sa valeur (%s)', (nom, valeur) => {
    const [motif, ...autres] = issues({ ...CONVOYEUR, [nom]: valeur });
    expect(autres).toEqual([]);
    expect(motif).toMatch(new RegExp(`^${nom} : .*\\(valeur masquee\\)$`));
    expect(motif).not.toContain(valeur.trim());
  });

  it('refuse Primary pour destination', () => {
    const primary = CONVOYEUR['CONVOYEUR_PRIMARY_UUID'];
    expect(issues({ ...CONVOYEUR, CONVOYEUR_DESTINATION_UUID: primary })).toEqual([
      'CONVOYEUR_DESTINATION_UUID : doit designer ubac-agent, pas Primary (valeur masquee)',
    ]);
  });
});

describe('CV3 — chaque chargeur ne lit que ses noms', () => {
  it('le convoyeur lit ses huit variables, et aucune autre', () => {
    expect([...noms(lireConfig, { ...UBAC, ...CONVOYEUR })].sort()).toEqual([...VARIABLES_CONVOYEUR].sort());
  });

  it('Ubac ne lit aucune variable du convoyeur, et les deux listes sont disjointes', () => {
    const ubac = noms(loadConfig, { ...UBAC, ...CONVOYEUR });
    expect(ubac).toContain('DATABASE_URL');
    expect(VARIABLES_CONVOYEUR.filter((nom) => ubac.has(nom))).toEqual([]);
    expect(VARIABLES_CONVOYEUR.every((nom) => nom.startsWith('CONVOYEUR_'))).toBe(true);
  });

  it('les secrets d’Ubac ne configurent pas le convoyeur, ni l’inverse', () => {
    expect(issues(UBAC)).toHaveLength(VARIABLES_CONVOYEUR.length);
    expect(() => loadConfig(CONVOYEUR)).toThrow(/DATABASE_URL : variable requise/);
  });
});
