import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { cashBand, DEFAULT_REBALANCE_PARAMS } from '../core/strategy/rebalance.js';
import type { RebalanceMode, RebalanceParams } from '../core/strategy/rebalance.js';
import {
  COOLDOWN_DAYS,
  MAX_EXPOSURE_PCT,
  MIN_CASH_PCT,
  MIN_LEG_USDC,
  PRICE_SANITY_PCT,
  REBALANCE_TOO_LARGE_PCT,
  RECONCILIATION_DRIFT_PCT,
} from '../core/risk.js';
import type { StrategyName, Weight, Weights } from '../core/types.js';

/**
 * Chargement et validation de la configuration au demarrage. Ce module lit
 * l'environnement et rien d'autre : aucun reseau, aucun fichier, aucune horloge.
 *
 * Deux principes le gouvernent.
 *
 * **Un secret absent ou mal forme arrete le programme.** Jamais de valeur par
 * defaut, jamais de repli sur une chaine vide : une cle Coinbase vide ne
 * produirait pas une erreur au demarrage mais un 401 au milieu d'un run, ou
 * pire, un run qui semble marcher parce que l'adapter avale l'erreur. Le message
 * nomme la variable et **ne cite jamais sa valeur** : `DATABASE_URL` porte un mot
 * de passe, et un message d'erreur finit dans un journal.
 *
 * **Aucun flottant ne rentre.** Les parametres de marche sortent de Zod en
 * `Decimal`, jamais en `number`. C'est la frontiere ou le flottant se
 * reintroduit le plus facilement : `z.coerce.number()` sur `"0.30"` est la
 * facon la plus courte d'ecrire ce que tout le noyau evite depuis la phase 0.
 * Les seuls `number` de ce module sont des comptes de jours, qui sont des
 * entiers de calendrier et pas des grandeurs de marche — le noyau les tient
 * deja en `number`.
 */

// --- Erreur -----------------------------------------------------------------

/**
 * Toutes les variables fautives d'un coup, pas seulement la premiere. Corriger
 * une configuration six variables a la fois, un redemarrage par variable, est
 * exactement le genre de friction qui pousse a mettre un defaut « en attendant ».
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`configuration invalide :\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// --- Formes exposees --------------------------------------------------------

/**
 * Les six variables secretes du §10 de la spec, sous les noms exacts que
 * Scaleway leur donne. Aucune n'a de defaut.
 */
export interface Secrets {
  readonly databaseUrl: string;
  readonly coinbaseApiKey: string;
  readonly coinbaseApiSecret: string;
  readonly brevoApiKey: string;
  readonly ntfyToken: string;
  readonly healthcheckUrl: string;
}

/**
 * Copie en lecture des seuils qu'applique `core/risk.ts`. Ce ne sont pas des
 * parametres : ce sont les valeurs du noyau, exposees pour etre journalisees et
 * affichees dans le rapport quotidien.
 *
 * Elles ne se configurent pas, et c'est le point. `risk.ts` les tient en
 * constantes de module, couvertes a 100 % par la phase 0 ; les rendre reglables
 * par l'environnement donnerait a la couche risque le mode de contournement
 * qu'`AGENTS.md` lui interdit — il suffirait d'une variable Scaleway pour
 * ramener `MIN_CASH` a 5 % sans qu'aucun test n'echoue.
 */
export interface RiskLimits {
  readonly maxExposurePerAsset: Decimal;
  readonly minCashPct: Decimal;
  readonly maxRebalanceMagnitudePct: Decimal;
  readonly minLegUsdc: Decimal;
  readonly cooldownDays: number;
  readonly priceSanityPct: Decimal;
  readonly reconciliationDriftPct: Decimal;
}

export interface UbacConfig {
  readonly secrets: Secrets;
  /** Passe tel quel a `decide()` : c'est le type du noyau, pas une copie. */
  readonly rebalance: RebalanceParams;
  readonly shadowStrategies: readonly StrategyName[];
  readonly risk: RiskLimits;
}

/** Ce que `risk.ts` applique. Lu, jamais ecrit. */
const RISK_LIMITS: RiskLimits = {
  maxExposurePerAsset: MAX_EXPOSURE_PCT,
  minCashPct: MIN_CASH_PCT,
  maxRebalanceMagnitudePct: REBALANCE_TOO_LARGE_PCT,
  minLegUsdc: MIN_LEG_USDC,
  cooldownDays: COOLDOWN_DAYS,
  priceSanityPct: PRICE_SANITY_PCT,
  reconciliationDriftPct: RECONCILIATION_DRIFT_PCT,
};

// --- Briques de validation --------------------------------------------------

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Toute variable de ce prefixe est refusee, quelle que soit sa valeur. Une
 * variable inconnue serait sinon ignoree en silence : celui qui pose
 * `UBAC_RISK_MIN_CASH_PCT=0.15` en production croirait avoir change le seuil,
 * et le systeme continuerait a 22 % sans le dire. Echouer est la seule reponse
 * honnete — le seuil se change dans `risk.ts`, avec ses tests.
 */
const RISK_OVERRIDE_PREFIX = 'UBAC_RISK_';

/**
 * Decimal litteral, sans exposant ni notation hexadecimale. `decimal.js` accepte
 * `0x10`, `Infinity` et `NaN` : passer la chaine brute au constructeur sans ce
 * filtre ferait entrer un poids `NaN`, contre lequel `Decimal.gt` et
 * `Decimal.lt` repondent tous les deux false. Le seuil ne mordrait plus, sur un
 * chemin qu'aucune couverture ne signale puisque la comparaison est bien
 * executee. Meme piege que le total non fini de `portfolio.ts`, meme parade.
 */
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const INTEGER_TEXT = /^(?:0|[1-9]\d*)$/;

/**
 * Un secret : requis, non vide, et dont aucun message ne cite la valeur.
 * `z.string()` suffirait fonctionnellement, mais son message par defaut parle
 * de types et pas de la variable que l'operateur doit aller poser.
 */
function secret(name: string) {
  return z
    .string({ error: () => `${name} : variable requise, absente de l'environnement` })
    .refine((value) => value.trim().length > 0, {
      error: () => `${name} : variable requise, valeur vide`,
    });
}

/** URL dont le protocole est impose. La valeur n'est jamais recopiee. */
function secretUrl(name: string, protocols: readonly string[], forme: string) {
  return secret(name).refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { error: () => `${name} : ${forme} attendue (valeur masquee)` },
  );
}

/**
 * Parametre de marche optionnel. Le defaut vient du noyau, jamais d'un litteral
 * recopie ici : deux sources pour la meme valeur cible finissent par diverger.
 *
 * Contrairement aux secrets, le message cite la valeur recue — une bande de
 * cash n'est pas un secret, et « recu "0,20" » dit tout de suite que la virgule
 * decimale est le probleme.
 */
function decimalVar(name: string, fallback: Decimal) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): Decimal => {
      if (raw === undefined) return fallback;
      if (!DECIMAL_TEXT.test(raw)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} : nombre decimal attendu, sans exposant, recu "${raw}"`,
        });
        return z.NEVER;
      }
      return new Decimal(raw);
    });
}

/** Compte de jours : un entier de calendrier, donc un `number`, comme le noyau. */
function daysVar(name: string, fallback: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number => {
      if (raw === undefined) return fallback;
      if (!INTEGER_TEXT.test(raw)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} : entier de jours positif ou nul attendu, recu "${raw}"`,
        });
        return z.NEVER;
      }
      return Number(raw);
    });
}

/**
 * `true` ou `false`, rien d'autre. Accepter `1`, `oui` ou `on` reviendrait a
 * decider que `0` vaut faux mais que `non` vaut vrai, ce qui armerait le
 * declencheur B par accident de casse.
 */
function booleanVar(name: string, fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): boolean => {
      if (raw === undefined) return fallback;
      if (raw !== 'true' && raw !== 'false') {
        ctx.addIssue({
          code: 'custom',
          message: `${name} : "true" ou "false" attendu, recu "${raw}"`,
        });
        return z.NEVER;
      }
      return raw === 'true';
    });
}

function enumVar<T extends string>(name: string, valeurs: readonly T[], fallback: T) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): T => {
      if (raw === undefined) return fallback;
      if (!valeurs.includes(raw as T)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} : ${valeurs.join(' | ')} attendu, recu "${raw}"`,
        });
        return z.NEVER;
      }
      return raw as T;
    });
}

// --- Politique d'apport -----------------------------------------------------

/**
 * Les trois politiques du §5.4. `manual` n'est pas implementable ici : elle
 * suppose une intervention humaine, la ou le noyau ne connait qu'un nombre de
 * jours de carence. La refuser explicitement vaut mieux que la faire glisser sur
 * `delay7d`, ce qui donnerait un systeme qui investit tout seul a un operateur
 * qui a demande a decider lui-meme.
 */
const NEW_CASH_POLICIES = ['immediate', 'delay7d', 'manual'] as const;

type NewCashPolicy = (typeof NEW_CASH_POLICIES)[number];

const FREEZE_DAYS: Readonly<Record<Exclude<NewCashPolicy, 'manual'>, number>> = {
  immediate: 0,
  delay7d: DEFAULT_REBALANCE_PARAMS.newCashFreezeDays,
};

// --- Schema -----------------------------------------------------------------

const SHADOW_STRATEGIES = ['ladder', 'dca', 'rebalance_ab'] as const satisfies readonly StrategyName[];

const REBALANCE_STRATEGIES = ['rebalance', 'rebalance_ab'] as const satisfies readonly StrategyName[];

const REBALANCE_MODES = ['target', 'band_edge'] as const satisfies readonly RebalanceMode[];

const schema = z.object({
  DATABASE_URL: secretUrl('DATABASE_URL', ['postgres:', 'postgresql:'], 'URL postgres://'),
  COINBASE_API_KEY: secret('COINBASE_API_KEY'),
  COINBASE_API_SECRET: secret('COINBASE_API_SECRET'),
  BREVO_API_KEY: secret('BREVO_API_KEY'),
  NTFY_TOKEN: secret('NTFY_TOKEN'),
  HEALTHCHECK_URL: secretUrl('HEALTHCHECK_URL', ['https:'], 'URL https://'),

  UBAC_STRATEGY: enumVar('UBAC_STRATEGY', REBALANCE_STRATEGIES, 'rebalance'),
  UBAC_TARGET_BTC: decimalVar('UBAC_TARGET_BTC', DEFAULT_REBALANCE_PARAMS.targets.BTC),
  UBAC_TARGET_ETH: decimalVar('UBAC_TARGET_ETH', DEFAULT_REBALANCE_PARAMS.targets.ETH),
  UBAC_TARGET_USDC: decimalVar('UBAC_TARGET_USDC', DEFAULT_REBALANCE_PARAMS.targets.USDC),
  UBAC_CASH_BAND_RELATIVE: decimalVar(
    'UBAC_CASH_BAND_RELATIVE',
    DEFAULT_REBALANCE_PARAMS.cashBandRelative,
  ),
  UBAC_REBALANCE_MODE: enumVar('UBAC_REBALANCE_MODE', REBALANCE_MODES, 'target'),
  UBAC_NEW_CASH_POLICY: enumVar('UBAC_NEW_CASH_POLICY', NEW_CASH_POLICIES, 'delay7d'),
  UBAC_RATIO_BAND_ENABLED: booleanVar(
    'UBAC_RATIO_BAND_ENABLED',
    DEFAULT_REBALANCE_PARAMS.ratioBandEnabled,
  ),
  UBAC_RATIO_BAND_RELATIVE: decimalVar(
    'UBAC_RATIO_BAND_RELATIVE',
    DEFAULT_REBALANCE_PARAMS.ratioBandRelative,
  ),
  UBAC_RATIO_COOLDOWN_DAYS: daysVar(
    'UBAC_RATIO_COOLDOWN_DAYS',
    DEFAULT_REBALANCE_PARAMS.ratioCooldownDays,
  ),
  UBAC_SHADOW_STRATEGIES: z.string().optional(),
});

type Parsed = z.infer<typeof schema>;

// --- Coherence metier -------------------------------------------------------

/** Tolerance de C4 : la somme des cibles vaut 1 a 1e-8 pres. */
const SUM_TOLERANCE = new Decimal('1e-8');

const ONE = new Decimal(1);

type Shadows =
  | { readonly ok: true; readonly value: readonly StrategyName[] }
  | { readonly ok: false; readonly issue: string };

function shadowStrategies(raw: string | undefined): Shadows {
  if (raw === undefined) return { ok: true, value: ['ladder', 'dca'] };
  const noms = raw
    .split(',')
    .map((nom) => nom.trim())
    .filter((nom) => nom.length > 0);
  const inconnus = noms.filter((nom) => !(SHADOW_STRATEGIES as readonly string[]).includes(nom));
  if (inconnus.length > 0) {
    return {
      ok: false,
      issue: `UBAC_SHADOW_STRATEGIES : strategie(s) inconnue(s) ${inconnus.join(', ')} ; attendu parmi ${SHADOW_STRATEGIES.join(', ')}`,
    };
  }
  return { ok: true, value: noms as readonly StrategyName[] };
}

/**
 * Les controles qui font se rencontrer les parametres de strategie et les seuils
 * de risque. Sans eux, une cible parfaitement valide prise isolement produit un
 * systeme qui se fait rejeter par `risk.ts` a chaque run, en silence, jusqu'a ce
 * qu'on lise le journal des rejets.
 */
function coherenceIssues(params: RebalanceParams): string[] {
  const issues: string[] = [];

  for (const [nom, cible] of [
    ['UBAC_TARGET_BTC', params.targets.BTC],
    ['UBAC_TARGET_ETH', params.targets.ETH],
    ['UBAC_TARGET_USDC', params.targets.USDC],
  ] as const) {
    if (!cible.isFinite() || cible.isNegative() || cible.gt(ONE)) {
      issues.push(`${nom} : poids attendu entre 0 et 1, recu ${cible.toString()}`);
    }
  }
  if (issues.length > 0) return issues;

  const somme = params.targets.BTC.add(params.targets.ETH).add(params.targets.USDC);
  if (somme.sub(ONE).abs().gt(SUM_TOLERANCE)) {
    issues.push(
      `UBAC_TARGET_BTC + UBAC_TARGET_ETH + UBAC_TARGET_USDC : somme ${somme.toString()}, attendue 1`,
    );
  }

  if (!params.cashBandRelative.isFinite() || params.cashBandRelative.isNegative()) {
    issues.push(
      `UBAC_CASH_BAND_RELATIVE : ecart relatif positif ou nul attendu, recu ${params.cashBandRelative.toString()}`,
    );
  }
  if (!params.ratioBandRelative.isFinite() || params.ratioBandRelative.isNegative()) {
    issues.push(
      `UBAC_RATIO_BAND_RELATIVE : ecart relatif positif ou nul attendu, recu ${params.ratioBandRelative.toString()}`,
    );
  }
  if (issues.length > 0) return issues;

  /*
   * `MAX_EXPOSURE` porte sur l'etat **projete**, donc sur la cible elle-meme des
   * que le reequilibrage aboutit. Une cible BTC a 60 % serait rejetee a chaque
   * run par la couche risque, sans jamais dire pourquoi ailleurs que dans le
   * journal des rejets.
   */
  for (const [nom, cible] of [
    ['UBAC_TARGET_BTC', params.targets.BTC],
    ['UBAC_TARGET_ETH', params.targets.ETH],
  ] as const) {
    if (cible.gt(RISK_LIMITS.maxExposurePerAsset)) {
      issues.push(
        `${nom} a ${cible.times(100).toString()} % : au-dela de MAX_EXPOSURE (${RISK_LIMITS.maxExposurePerAsset.times(100).toString()} %), tout reequilibrage complet serait rejete`,
      );
    }
  }

  /*
   * Symetriquement pour `MIN_CASH`, et c'est la que la divergence 22 % / 15 % se
   * voit. Le cash projete depend du mode : `target` repose la ligne sur la
   * cible, `band_edge` sur le bord franchi, qui est plus bas. C'est donc le bord
   * bas qu'il faut comparer au seuil quand ce mode est arme, pas la cible.
   */
  const bordBas = params.rebalanceMode === 'band_edge';
  const projete = bordBas ? cashBand(params).lower : params.targets.USDC;
  if (projete.lt(RISK_LIMITS.minCashPct)) {
    const origine = bordBas
      ? 'UBAC_TARGET_USDC + UBAC_CASH_BAND_RELATIVE'
      : 'UBAC_TARGET_USDC';
    issues.push(
      `${origine} : cash projete a ${projete.times(100).toString()} % en mode ${params.rebalanceMode}, sous MIN_CASH (${RISK_LIMITS.minCashPct.times(100).toString()} %) — tout reequilibrage serait rejete`,
    );
  }

  return issues;
}

// --- Chargement -------------------------------------------------------------

function riskOverrideIssues(env: Env): string[] {
  return Object.keys(env)
    .filter((nom) => nom.startsWith(RISK_OVERRIDE_PREFIX))
    .sort()
    .map(
      (nom) =>
        `${nom} : les seuils de risque ne sont pas configurables. Ils vivent dans src/core/risk.ts, couverts a 100 %, et n'ont pas de mode de contournement.`,
    );
}

function toParams(parsed: Parsed): RebalanceParams {
  const targets: Weights = {
    BTC: parsed.UBAC_TARGET_BTC as Weight,
    ETH: parsed.UBAC_TARGET_ETH as Weight,
    USDC: parsed.UBAC_TARGET_USDC as Weight,
  };
  const politique = parsed.UBAC_NEW_CASH_POLICY;
  return {
    strategy: parsed.UBAC_STRATEGY,
    targets,
    cashBandRelative: parsed.UBAC_CASH_BAND_RELATIVE,
    rebalanceMode: parsed.UBAC_REBALANCE_MODE,
    newCashFreezeDays: politique === 'manual' ? 0 : FREEZE_DAYS[politique],
    ratioBandEnabled: parsed.UBAC_RATIO_BAND_ENABLED,
    ratioBandRelative: parsed.UBAC_RATIO_BAND_RELATIVE,
    ratioCooldownDays: parsed.UBAC_RATIO_COOLDOWN_DAYS,
  };
}

/**
 * Point d'entree unique. Leve `ConfigError` des qu'une variable manque ou est
 * mal formee : c'est le comportement voulu au demarrage d'un job, ou une
 * configuration a moitie valide vaut moins qu'un arret net.
 *
 * `env` est un parametre et pas une lecture directe de `process.env` : c'est ce
 * qui rend le module testable sans muter l'environnement du processus de test,
 * donc sans ordonner les tests entre eux. Le defaut est evalue a l'appel.
 */
export function loadConfig(env: Env = process.env): UbacConfig {
  const issues: string[] = [...riskOverrideIssues(env)];
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    /*
     * Le chemin de la variable est la cle de l'objet, donc le nom de la variable
     * d'environnement. C'est la raison pour laquelle le schema est indexe par
     * `DATABASE_URL` et non par `databaseUrl` : le message doit nommer ce que
     * l'operateur doit aller poser, pas le champ dans lequel il atterrit.
     *
     * Les messages ecrits ici nomment deja leur variable ; le prefixe n'est
     * qu'un filet pour un message par defaut de Zod, qui parlerait de types sans
     * dire de quelle variable. Le poser sans condition donnerait
     * « DATABASE_URL : DATABASE_URL : ... ».
     */
    for (const issue of parsed.error.issues) {
      const variable = issue.path.join('.');
      const deja = variable.length === 0 || issue.message.startsWith(`${variable} `);
      issues.push(deja ? issue.message : `${variable} : ${issue.message}`);
    }
    throw new ConfigError(issues);
  }

  if (parsed.data.UBAC_NEW_CASH_POLICY === 'manual') {
    issues.push(
      'UBAC_NEW_CASH_POLICY : la politique manual demande une decision humaine, que le noyau ne sait pas representer. Utiliser immediate ou delay7d.',
    );
  }

  const params = toParams(parsed.data);
  issues.push(...coherenceIssues(params));

  const shadows = shadowStrategies(parsed.data.UBAC_SHADOW_STRATEGIES);
  if (!shadows.ok) issues.push(shadows.issue);

  if (issues.length > 0 || !shadows.ok) {
    throw new ConfigError(issues);
  }

  return {
    secrets: {
      databaseUrl: parsed.data.DATABASE_URL,
      coinbaseApiKey: parsed.data.COINBASE_API_KEY,
      coinbaseApiSecret: parsed.data.COINBASE_API_SECRET,
      brevoApiKey: parsed.data.BREVO_API_KEY,
      ntfyToken: parsed.data.NTFY_TOKEN,
      healthcheckUrl: parsed.data.HEALTHCHECK_URL,
    },
    rebalance: params,
    shadowStrategies: shadows.value,
    risk: RISK_LIMITS,
  };
}
