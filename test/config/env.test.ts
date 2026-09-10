import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/env.js';
import type { Env } from '../../src/config/env.js';
import { MIN_CASH_PCT } from '../../src/core/risk.js';
import { DEFAULT_REBALANCE_PARAMS } from '../../src/core/strategy/rebalance.js';

/**
 * Aucune de ces valeurs n'est un secret : ce sont des chaines de forme correcte
 * et de contenu inexistant. Le depot n'en contient pas d'autres.
 */
const SECRETS: Env = {
  DATABASE_URL: 'postgresql://utilisateur:motdepasse@hote.test/ubac',
  COINBASE_API_KEY: 'cle-de-test',
  COINBASE_API_SECRET: 'secret-de-test',
  BREVO_API_KEY: 'brevo-de-test',
  NTFY_TOKEN: 'ntfy-de-test',
  HEALTHCHECK_URL: 'https://hc.test/ping/0000',
};

const SECRET_NAMES = Object.keys(SECRETS);

function env(overrides: Env = {}): Env {
  return { ...SECRETS, ...overrides };
}

/** Le message porte le detail ; les tests lisent `issues`, pas la mise en forme. */
function issuesOf(build: () => unknown): readonly string[] {
  try {
    build();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('configuration acceptee alors qu’un echec etait attendu');
}

describe('un environnement complet donne les defauts du noyau', () => {
  it('reprend les parametres de DEFAULT_REBALANCE_PARAMS', () => {
    const config = loadConfig(env());
    expect(config.rebalance).toEqual({
      ...DEFAULT_REBALANCE_PARAMS,
      strategy: 'rebalance',
    });
    expect(config.shadowStrategies).toEqual(['ladder', 'dca']);
  });

  it('expose les secrets sous leur nom de spec', () => {
    const config = loadConfig(env());
    expect(config.secrets).toEqual({
      databaseUrl: SECRETS['DATABASE_URL'],
      coinbaseApiKey: SECRETS['COINBASE_API_KEY'],
      coinbaseApiSecret: SECRETS['COINBASE_API_SECRET'],
      brevoApiKey: SECRETS['BREVO_API_KEY'],
      ntfyToken: SECRETS['NTFY_TOKEN'],
      healthcheckUrl: SECRETS['HEALTHCHECK_URL'],
    });
  });
});

describe('un secret absent ou mal forme arrete le demarrage', () => {
  it.each(SECRET_NAMES)('refuse un environnement sans %s, en nommant la variable', (nom) => {
    const incomplet = { ...SECRETS, [nom]: undefined };
    const issues = issuesOf(() => loadConfig(incomplet));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(nom);
    // Le nom une seule fois : Zod prefixe par le chemin, les messages nomment
    // deja leur variable, et les deux cumules donnent « X : X : ... ».
    expect(issues[0]?.split(nom)).toHaveLength(2);
  });

  it.each(SECRET_NAMES)('refuse %s vide plutot que de le laisser passer', (nom) => {
    const issues = issuesOf(() => loadConfig({ ...SECRETS, [nom]: '   ' }));
    // Une URL vide echoue deux fois : vide, puis protocole introuvable. Ce qui
    // compte est qu'aucun message ne parle d'autre chose que de la variable.
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue).toContain(nom);
  });

  // Corriger six variables a six redemarrages est ce qui pousse a poser un
  // defaut « en attendant ». Elles sortent donc toutes du meme appel.
  it('remonte les six variables manquantes en une fois', () => {
    const issues = issuesOf(() => loadConfig({}));
    expect(issues).toHaveLength(SECRET_NAMES.length);
    for (const nom of SECRET_NAMES) {
      expect(issues.join('\n')).toContain(nom);
    }
  });

  it('refuse une DATABASE_URL qui n’est pas du postgres', () => {
    const issues = issuesOf(() => loadConfig(env({ DATABASE_URL: 'mysql://h.test/ubac' })));
    expect(issues).toEqual([expect.stringContaining('DATABASE_URL')]);
  });

  it('refuse un HEALTHCHECK_URL en clair', () => {
    const issues = issuesOf(() => loadConfig(env({ HEALTHCHECK_URL: 'http://hc.test/ping' })));
    expect(issues).toEqual([expect.stringContaining('HEALTHCHECK_URL')]);
  });

  /*
   * Un message d'erreur finit dans un journal, et DATABASE_URL porte un mot de
   * passe. Le message nomme la variable ; il ne recopie jamais sa valeur.
   */
  it('ne recopie jamais la valeur d’un secret dans le message', () => {
    const issues = issuesOf(() =>
      loadConfig(env({ DATABASE_URL: 'mysql://utilisateur:tres-secret@hote.test/ubac' })),
    );
    expect(issues.join('\n')).not.toContain('tres-secret');
  });
});

describe('aucun flottant ne rentre', () => {
  /*
   * `z.coerce.number()` sur cette chaine rendrait 0.12345678901234568 : le
   * chiffre de fin change, et rien ne le signale. C'est la frontiere ou la
   * regle non negociable d'AGENTS.md se perd le plus facilement.
   */
  it('conserve une precision qu’un double ne peut pas porter', () => {
    const raw = '0.12345678901234567891';
    const config = loadConfig(env({ UBAC_CASH_BAND_RELATIVE: raw }));
    expect(config.rebalance.cashBandRelative.toString()).toBe(raw);
    expect(config.rebalance.cashBandRelative).toBeInstanceOf(Decimal);
    expect(Number(raw).toString()).not.toBe(raw);
  });

  // decimal.js accepte l'hexadecimal, l'infini et NaN. Un poids NaN traverse
  // toutes les comparaisons de seuil sans jamais les declencher.
  it.each(['0x10', 'NaN', 'Infinity', '-Infinity', '1e-2', '0,20', '', ' 0.20'])(
    'refuse %s comme decimal',
    (raw) => {
      const issues = issuesOf(() => loadConfig(env({ UBAC_CASH_BAND_RELATIVE: raw })));
      expect(issues).toEqual([expect.stringContaining('UBAC_CASH_BAND_RELATIVE')]);
    },
  );

  it.each(['7.5', '-1', 'sept'])('refuse %s comme nombre de jours', (raw) => {
    const issues = issuesOf(() => loadConfig(env({ UBAC_RATIO_COOLDOWN_DAYS: raw })));
    expect(issues).toEqual([expect.stringContaining('UBAC_RATIO_COOLDOWN_DAYS')]);
  });

  it('accepte un nombre de jours entier, zero compris', () => {
    expect(loadConfig(env({ UBAC_RATIO_COOLDOWN_DAYS: '14' })).rebalance.ratioCooldownDays).toBe(14);
    expect(loadConfig(env({ UBAC_RATIO_COOLDOWN_DAYS: '0' })).rebalance.ratioCooldownDays).toBe(0);
  });

  it.each(['1', 'oui', 'TRUE', ''])('refuse %s comme booleen', (raw) => {
    const issues = issuesOf(() => loadConfig(env({ UBAC_RATIO_BAND_ENABLED: raw })));
    expect(issues).toEqual([expect.stringContaining('UBAC_RATIO_BAND_ENABLED')]);
  });

  it('arme le declencheur B quand la variable vaut true', () => {
    const config = loadConfig(env({ UBAC_RATIO_BAND_ENABLED: 'true' }));
    expect(config.rebalance.ratioBandEnabled).toBe(true);
  });
});

describe('les seuils de risque ne se configurent pas', () => {
  /*
   * D1, tranchee : MIN_CASH vaut 22 % en phase 1. La valeur est ecrite ici en
   * toutes lettres, et non lue depuis risk.ts, pour qu'un changement de seuil
   * fasse echouer ce test au lieu de le suivre en silence.
   */
  it('expose le MIN_CASH de 22 % que risk.ts applique', () => {
    const config = loadConfig(env());
    expect(config.risk.minCashPct.toString()).toBe('0.22');
    expect(config.risk.minCashPct.eq(MIN_CASH_PCT)).toBe(true);
  });

  it.each(['UBAC_RISK_MIN_CASH_PCT', 'UBAC_RISK_COOLDOWN_DAYS'])(
    'refuse de demarrer si %s est pose',
    (nom) => {
      const issues = issuesOf(() => loadConfig(env({ [nom]: '0.15' })));
      expect(issues).toEqual([expect.stringContaining(nom)]);
    },
  );
});

describe('les parametres metier sont confrontes aux seuils de risque', () => {
  // Le motif decimal accepte le signe : un poids negatif est syntaxiquement
  // valide et n'a aucun sens metier. Les deux controles sont distincts.
  it.each([
    ['UBAC_TARGET_BTC', '-0.1'],
    ['UBAC_TARGET_ETH', '2'],
  ])('refuse %s a %s : un poids vit entre 0 et 1', (nom, valeur) => {
    const issues = issuesOf(() => loadConfig(env({ [nom]: valeur })));
    expect(issues).toEqual([expect.stringContaining(nom)]);
  });

  it.each(['UBAC_CASH_BAND_RELATIVE', 'UBAC_RATIO_BAND_RELATIVE'])(
    'refuse un ecart relatif negatif sur %s',
    (nom) => {
      const issues = issuesOf(() => loadConfig(env({ [nom]: '-0.2' })));
      expect(issues).toEqual([expect.stringContaining(nom)]);
    },
  );

  it('refuse des cibles qui ne somment pas a 1', () => {
    const issues = issuesOf(() =>
      loadConfig(env({ UBAC_TARGET_BTC: '0.5', UBAC_TARGET_ETH: '0.3', UBAC_TARGET_USDC: '0.3' })),
    );
    expect(issues).toEqual([expect.stringContaining('somme')]);
  });

  it('accepte une somme a 1 a 1e-8 pres', () => {
    const config = loadConfig(
      env({
        UBAC_TARGET_BTC: '0.400000001',
        UBAC_TARGET_ETH: '0.3',
        UBAC_TARGET_USDC: '0.299999999',
      }),
    );
    expect(config.rebalance.targets.BTC.toString()).toBe('0.400000001');
  });

  // Une cible au-dela de MAX_EXPOSURE se fait rejeter par risk.ts a chaque run,
  // sans jamais dire pourquoi ailleurs que dans le journal des rejets.
  it('refuse une cible BTC au-dela de MAX_EXPOSURE', () => {
    const issues = issuesOf(() =>
      loadConfig(env({ UBAC_TARGET_BTC: '0.6', UBAC_TARGET_ETH: '0.1', UBAC_TARGET_USDC: '0.3' })),
    );
    expect(issues).toEqual([expect.stringContaining('MAX_EXPOSURE')]);
  });

  it('refuse une cible de cash sous MIN_CASH', () => {
    const issues = issuesOf(() =>
      loadConfig(env({ UBAC_TARGET_BTC: '0.45', UBAC_TARGET_ETH: '0.4', UBAC_TARGET_USDC: '0.15' })),
    );
    expect(issues).toEqual([expect.stringContaining('MIN_CASH')]);
  });

  /*
   * Le meme couple cible / bande est valide en mode `target` et invalide en mode
   * `band_edge` : le premier repose la ligne de cash sur 0.26, le second sur le
   * bord bas 0.26 x 0.8 = 0.208, sous les 22 % de MIN_CASH. Comparer la cible au
   * seuil sans regarder le mode laisserait passer le second.
   */
  const CIBLES_BASSES: Env = {
    UBAC_TARGET_BTC: '0.4',
    UBAC_TARGET_ETH: '0.34',
    UBAC_TARGET_USDC: '0.26',
    UBAC_CASH_BAND_RELATIVE: '0.20',
  };

  it('accepte ces cibles en mode target', () => {
    const config = loadConfig(env({ ...CIBLES_BASSES, UBAC_REBALANCE_MODE: 'target' }));
    expect(config.rebalance.rebalanceMode).toBe('target');
  });

  it('refuse les memes en mode band_edge, ou le bord bas passe sous MIN_CASH', () => {
    const issues = issuesOf(() =>
      loadConfig(env({ ...CIBLES_BASSES, UBAC_REBALANCE_MODE: 'band_edge' })),
    );
    expect(issues).toEqual([expect.stringContaining('MIN_CASH')]);
  });

  it('refuse un mode de reequilibrage inconnu', () => {
    const issues = issuesOf(() => loadConfig(env({ UBAC_REBALANCE_MODE: 'bord' })));
    expect(issues).toEqual([expect.stringContaining('UBAC_REBALANCE_MODE')]);
  });

  it('refuse une strategie de production inconnue', () => {
    const issues = issuesOf(() => loadConfig(env({ UBAC_STRATEGY: 'ladder' })));
    expect(issues).toEqual([expect.stringContaining('UBAC_STRATEGY')]);
  });
});

describe('politique d’apport', () => {
  it('traduit immediate en zero jour de carence', () => {
    const config = loadConfig(env({ UBAC_NEW_CASH_POLICY: 'immediate' }));
    expect(config.rebalance.newCashFreezeDays).toBe(0);
  });

  it('traduit delay7d en sept jours', () => {
    const config = loadConfig(env({ UBAC_NEW_CASH_POLICY: 'delay7d' }));
    expect(config.rebalance.newCashFreezeDays).toBe(7);
  });

  /*
   * `manual` figure au §5.4 mais suppose une intervention humaine, que le noyau
   * ne sait pas representer. La faire glisser sur `delay7d` donnerait un systeme
   * qui investit tout seul a un operateur qui a demande a decider lui-meme.
   */
  it('refuse manual plutot que de la ramener a une autre politique', () => {
    const issues = issuesOf(() => loadConfig(env({ UBAC_NEW_CASH_POLICY: 'manual' })));
    expect(issues).toEqual([expect.stringContaining('manual')]);
  });
});

describe('strategies shadow', () => {
  it('accepte une liste separee par des virgules', () => {
    const config = loadConfig(env({ UBAC_SHADOW_STRATEGIES: 'ladder, rebalance_ab' }));
    expect(config.shadowStrategies).toEqual(['ladder', 'rebalance_ab']);
  });

  it('accepte une liste vide', () => {
    const config = loadConfig(env({ UBAC_SHADOW_STRATEGIES: '' }));
    expect(config.shadowStrategies).toEqual([]);
  });

  it('refuse un nom inconnu', () => {
    const issues = issuesOf(() => loadConfig(env({ UBAC_SHADOW_STRATEGIES: 'ladder,martingale' })));
    expect(issues).toEqual([expect.stringContaining('martingale')]);
  });
});

describe('le module ne lit que ce qu’on lui donne', () => {
  /*
   * `loadConfig({})` echoue meme quand `process.env` contient une configuration
   * valide : l'environnement est un parametre. C'est ce qui rend ces tests
   * independants de leur ordre d'execution et du poste qui les lance.
   */
  it('ignore process.env quand un environnement lui est passe', () => {
    process.env['UBAC_TARGET_BTC'] = '0.99';
    try {
      expect(loadConfig(env()).rebalance.targets.BTC.toString()).toBe('0.4');
    } finally {
      delete process.env['UBAC_TARGET_BTC'];
    }
  });
});
