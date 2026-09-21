import { describe, expect, it } from 'vitest';

import { SHARPE_WINDOW } from '../../src/core/benchmark.js';
import type { RejectionCode, Trigger } from '../../src/core/types.js';
import type { LexiqueContexte } from '../../src/report/lexique.js';
import { lexique } from '../../src/report/lexique.js';

/**
 * Le vocabulaire du rapport, pris seul. **Aucun reseau, aucune cle, aucune
 * base** : ce fichier n'importe que du code pur.
 *
 * Ce qu'il etablit ici, et que le rendu ne peut pas etablir : les deux
 * vocabulaires fermes du noyau sont **exhaustifs**, y compris pour les valeurs
 * qu'aucun rapport n'imprime aujourd'hui ; les entrees conditionnelles suivent
 * le contexte et rien d'autre ; et le texte entier est sans accent, y compris
 * celui des neuf codes de refus, qui n'arrivent pas en phase 1 et ne seraient
 * donc jamais relus par le rendu.
 *
 * Ce qu'il n'etablit pas, et qui vit dans `daily-report.test.ts` : qu'aucune
 * entree n'est morte (R3). Cela demande le corps du rapport.
 */

const VIDE: LexiqueContexte = {
  triggers: [],
  rejets: [],
  suspendu: false,
  metriquesIndisponibles: false,
};

const termes = (contexte: Partial<LexiqueContexte> = {}): readonly string[] =>
  lexique({ ...VIDE, ...contexte }).map((entree) => entree.terme);

/**
 * Les trois triggers et les neuf codes de refus, recopies. La completude est
 * verifiee a la compilation par `Exhaustif` — meme motif que
 * `test/jobs/alerts.test.ts` : un dixieme code ajoute au noyau sans etre repris
 * ici ne compile plus, plutot que de passer huit sondes sur neuf.
 *
 * C'est le pendant a l'execution de R4 : le typage de `Record<Trigger, string>`
 * refuse deja une glose manquante a la declaration, cette liste verifie que la
 * **selection** rend bien une entree pour chaque valeur.
 */
const TRIGGERS = ['NONE', 'CASH_BAND', 'RATIO_BAND'] as const satisfies readonly Trigger[];

const REJETS = [
  'ASSET_NOT_ALLOWED',
  'QUOTE_NOT_ALLOWED',
  'MAX_EXPOSURE',
  'MIN_CASH',
  'REBALANCE_TOO_LARGE',
  'LEG_TOO_SMALL',
  'COOLDOWN',
  'PRICE_SANITY',
  'RECONCILIATION_DRIFT',
] as const satisfies readonly RejectionCode[];

type ExhaustifTrigger<T> = [Exclude<Trigger, T>] extends [never] ? true : never;
type ExhaustifRejet<T> = [Exclude<RejectionCode, T>] extends [never] ? true : never;
const TOUS_LES_TRIGGERS: ExhaustifTrigger<(typeof TRIGGERS)[number]> = true;
const TOUS_LES_REJETS: ExhaustifRejet<(typeof REJETS)[number]> = true;

describe('R2 — chaque entree porte un terme et une definition', () => {
  const complet = lexique({
    triggers: TRIGGERS,
    rejets: REJETS,
    suspendu: true,
    metriquesIndisponibles: true,
  });

  it('aucune entree vide, aucun terme sans definition, aucun doublon', () => {
    for (const { terme, definition } of complet) {
      expect(terme.trim()).toBe(terme);
      expect(terme.length).toBeGreaterThan(0);
      /* Une phrase, et une phrase finie : une glose tronquee vaudrait une glose absente. */
      expect(definition.length).toBeGreaterThan(20);
      expect(definition.endsWith('.')).toBe(true);
    }
    expect(new Set(complet.map((entree) => entree.terme)).size).toBe(complet.length);
  });

  /**
   * Le corps du rapport est sans accent, et le lexique en fait partie. C'est la
   * contrainte la plus facile a violer de ce lot : on ecrit vingt definitions en
   * francais d'une traite, et « pondere » passe. La sonde couvre le lexique
   * **complet**, codes de refus compris, que le rendu n'imprime jamais en phase 1.
   */
  it('le texte entier est sans accent, entrees conditionnelles comprises', () => {
    /* NFD decompose « e » accentue en « e » suivi d'une diacritique combinante ; ae et oe lies ne se decomposent pas. */
    const accentue = /[̀-ͯ]|[æœÆŒ]/;
    for (const { terme, definition } of complet) {
      expect(`${terme} ${definition}`.normalize('NFD')).not.toMatch(accentue);
    }
    /* La sonde sait voir un accent : sans ce controle, une regex fausse rendrait le test vert pour toujours. */
    expect('pondere'.replace('e', 'é').normalize('NFD')).toMatch(accentue);
  });
});

/**
 * R4 — l'exhaustivite des deux vocabulaires fermes. Le typage la tient a la
 * declaration : `Record<Trigger, string>` refuse de compiler s'il manque une
 * glose, donc un code ajoute au noyau fait echouer `make typecheck` chez celui
 * qui l'ajoute. Ce qui se verifie ici est la moitie qui reste : que la selection
 * rende bien une entree pour chacune de ces valeurs.
 */
describe('R4 — les deux vocabulaires du noyau sont couverts en entier', () => {
  it('les listes recopiees sont completes', () => {
    expect(TOUS_LES_TRIGGERS).toBe(true);
    expect(TOUS_LES_REJETS).toBe(true);
    expect(TRIGGERS).toHaveLength(3);
    expect(REJETS).toHaveLength(9);
  });

  it.each(TRIGGERS)('le trigger %s est glose', (trigger) => {
    expect(termes({ triggers: [trigger] })).toContain(trigger);
  });

  it.each(REJETS)('le code de refus %s est glose', (code) => {
    expect(termes({ rejets: [code] })).toContain(code);
  });
});

describe('R5 — les entrees conditionnelles suivent ce que le rapport imprime', () => {
  it('le vocabulaire fixe est la tous les jours, contexte vide compris', () => {
    const fixes = termes();
    expect(fixes).toHaveLength(20);
    expect(fixes).toContain('P&L');
    expect(fixes).toContain('indice de croissance');
    /* Derive de la fenetre du noyau : la changer ne peut pas oublier le terme. */
    expect(fixes).toContain(`Sharpe ${String(SHARPE_WINDOW)} j`);
    /* Et rien de conditionnel : ni trigger, ni refus, ni suspension, ni convention de cle. */
    expect(fixes).not.toContain('NONE');
    expect(fixes).not.toContain('MIN_CASH');
    expect(fixes).not.toContain('suspension');
    expect(fixes).not.toContain('cle');
  });

  it('un rapport sans rejet ne glose aucun rejet, et un rejet ne glose que le sien', () => {
    expect(termes({ triggers: ['NONE'] }).filter((terme) => REJETS.includes(terme as RejectionCode))).toEqual([]);
    const un = termes({ triggers: ['NONE'], rejets: ['MIN_CASH'] });
    expect(un.filter((terme) => REJETS.includes(terme as RejectionCode))).toEqual(['MIN_CASH']);
  });

  it('deux strategies au meme trigger ne le glosent pas deux fois', () => {
    expect(termes({ triggers: ['NONE', 'NONE', 'CASH_BAND', 'NONE'] }).filter((t) => t === 'NONE')).toHaveLength(1);
  });

  it('la suspension et la convention de cle suivent leur encadre et leur tableau', () => {
    expect(termes({ suspendu: true })).toContain('suspension');
    expect(termes({ metriquesIndisponibles: true })).toContain('cle');
    expect(termes({ suspendu: true })).not.toContain('cle');
    expect(termes({ metriquesIndisponibles: true })).not.toContain('suspension');
  });

  /**
   * L'ordre est stable et ne depend pas de celui des valeurs rencontrees : un
   * lexique qui se reordonne d'un jour sur l'autre se relit comme un rapport
   * different, et deux rapports du meme jour ne se compareraient plus.
   */
  it('l’ordre ne depend pas de celui ou les valeurs arrivent', () => {
    const a = termes({ triggers: ['RATIO_BAND', 'CASH_BAND'], rejets: ['COOLDOWN', 'MIN_CASH'] });
    const b = termes({ triggers: ['CASH_BAND', 'RATIO_BAND'], rejets: ['MIN_CASH', 'COOLDOWN'] });
    expect(a).toEqual(b);
    expect(a.slice(-4)).toEqual(['CASH_BAND', 'RATIO_BAND', 'MIN_CASH', 'COOLDOWN']);
  });
});
