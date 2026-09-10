import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { riskVerdictText } from '../../src/adapters/db.js';
import {
  cashFlows,
  DbFrontierError,
  decimalFromText,
  decisions,
  orders,
  snapshots,
  textFromDecimal,
} from '../../src/adapters/schema.js';
import type { RejectionCode, UsdcAmount } from '../../src/core/types.js';

/**
 * La frontiere numerique de la base, testee sans base : ces controles tournent
 * dans `make test` comme dans `make test-db`. C'est voulu — les tests qui ont
 * besoin de Postgres sont ignores par defaut, et la regle non negociable
 * d'`AGENTS.md` ne peut pas dependre d'une suite qu'on peut oublier de lancer.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('une grandeur ne rentre que par une chaine', () => {
  it('rend un Decimal exact sur une chaine que le flottant ne sait pas porter', () => {
    // 12345678901.12345678 vaut 12345678901.123457 en double. La comparaison
    // ci-dessous echoue des qu'un flottant s'est glisse dans le chemin.
    const valeur = decimalFromText('12345678901.12345678', 'test');
    expect(valeur.toFixed()).toBe('12345678901.12345678');
    expect(valeur.equals(new Decimal('12345678901.12345678'))).toBe(true);
  });

  it('refuse un number, y compris exact', () => {
    // Le cas qu'aucun typage n'attrape : un driver reconfigure, ou une colonne
    // relue par une autre requete, et la precision est deja perdue.
    expect(() => decimalFromText(0.3, 'snapshots.total_value_usdc')).toThrow(DbFrontierError);
    expect(() => decimalFromText(3, 'snapshots.total_value_usdc')).toThrow(/recu number/);
  });

  it.each(['NaN', 'Infinity', '-Infinity', '0x10', '1e-8', '', '0,30', ' 0.30'])(
    'refuse la chaine %o, que decimal.js accepterait',
    (brut) => {
      expect(() => decimalFromText(brut, 'weights.BTC')).toThrow(DbFrontierError);
    },
  );

  it.each([null, undefined, {}, ['0.30']])('refuse la valeur non textuelle %o', (brut) => {
    expect(() => decimalFromText(brut, 'weights.BTC')).toThrow(DbFrontierError);
  });
});

describe('une grandeur ne sort que par une chaine', () => {
  it('serialise sans exposant et sans perte, meme sous 1e-6', () => {
    // `toString()` rendrait "1e-8", que Postgres refuse sur un numeric.
    expect(textFromDecimal(new Decimal('0.00000001'), 'test')).toBe('0.00000001');
    expect(textFromDecimal(new Decimal('12345678901.12345678'), 'test')).toBe(
      '12345678901.12345678',
    );
    expect(textFromDecimal(new Decimal('-42'), 'test')).toBe('-42');
  });

  it('refuse une grandeur non finie, que Postgres stockerait volontiers', () => {
    // `numeric` accepte litteralement 'NaN'. Un poids NaN relu ne declenche
    // aucun seuil : ni `gt` ni `lt` ne repondent vrai dessus.
    expect(() => textFromDecimal(new Decimal(NaN), 'weights.BTC')).toThrow(DbFrontierError);
    expect(() => textFromDecimal(new Decimal(Infinity), 'weights.BTC')).toThrow(DbFrontierError);
  });

  it('fait l’aller-retour a l’identique', () => {
    for (const brut of ['0.00000001', '0.47', '123456.78901234', '-0.5', '0']) {
      expect(textFromDecimal(decimalFromText(brut, 'test'), 'test')).toBe(brut);
    }
  });
});

describe('le verdict de risque prend la forme de la colonne', () => {
  it('rend ACCEPTED tel quel', () => {
    expect(riskVerdictText({ status: 'ACCEPTED', orders: [], ignored: [] })).toBe('ACCEPTED');
  });

  it.each<RejectionCode>(['MIN_CASH', 'REBALANCE_TOO_LARGE', 'COOLDOWN'])(
    'rend REJECTED:%s',
    (code) => {
      const verdict = { status: 'REJECTED', rejections: [{ code, reason: 'motif' }] } as const;
      expect(riskVerdictText(verdict)).toBe(`REJECTED:${code}`);
    },
  );

  it('refuse un rejet sans motif plutot que d’ecrire REJECTED: tout court', () => {
    expect(() => riskVerdictText({ status: 'REJECTED', rejections: [] })).toThrow(DbFrontierError);
  });
});

/**
 * Controle de noms sur le code livre, du meme statut que le garde-fou C32 :
 * utile, tenu, et explicitement pas une demonstration. Il attrape la faute
 * qu'aucun type n'attrape — `Number(ligne.amount)`, `parseFloat`, le
 * `toNumber()` de decimal.js — parce que le typage laisse passer un `number` la
 * ou un `Decimal` etait attendu des qu'une conversion est ecrite a la main.
 *
 * Ce qu'il ne voit pas est ecrit noir sur blanc : une arithmetique flottante
 * indirecte, une bibliotheque tierce qui convertit pour nous. C'est le test
 * d'aller-retour contre la vraie base qui couvre ce terrain-la.
 */
describe('aucun chemin flottant dans les modules d’acces a la base', () => {
  const INTERDITS = [
    /\bparseFloat\b/,
    /\bparseInt\b/,
    /\bNumber\s*\(/,
    /\.toNumber\s*\(/,
    /\.valueOf\s*\(/,
    /\bz\.number\b/,
    /mode:\s*'number'/,
  ];

  /**
   * Les lignes de commentaire sont ecartees, sinon la documentation ne pourrait
   * pas nommer ce qu'elle interdit. Une ligne de code portant un commentaire en
   * fin reste analysee entierement.
   */
  const codeSeul = (source: string): string =>
    source
      .split('\n')
      .filter((ligne) => !/^\s*(\*|\/\/|\/\*)/.test(ligne))
      .join('\n');

  it.each(['src/adapters/db.ts', 'src/adapters/schema.ts'])('%s', async (chemin) => {
    const code = codeSeul(await readFile(resolve(ROOT, chemin), 'utf8'));
    const fautes = INTERDITS.filter((motif) => motif.test(code)).map(String);
    expect(fautes).toEqual([]);
  });
});

/**
 * Le type SQL est ecrit **avec l'espace**, `numeric(20, 8)`, parce que c'est
 * sous cette forme que `drizzle-kit` relit la colonne depuis la base. Ecrit
 * `numeric(20,8)`, le type declare et le type introspecte ne se ressemblent
 * plus : chaque `make db-push` re-emet un `ALTER COLUMN ... SET DATA TYPE` sur
 * les sept colonnes numeriques, verifie a la main sur la base locale. Sur une
 * base jetable c'est du bruit ; sur la base reelle c'est une reecriture de table
 * sous verrou exclusif a chaque migration.
 */
describe('le type SQL declare est celui que drizzle-kit relit', () => {
  it.each([
    [snapshots.totalValueUsdc, 'numeric(20, 8)'],
    [orders.requestedQty, 'numeric(20, 8)'],
    [cashFlows.amountUsdc, 'numeric(20, 8)'],
    [decisions.runDate, 'date'],
  ])('%s', (colonne, attendu) => {
    expect(colonne.getSQLType()).toBe(attendu);
  });
});

/** Le marquage tient a la compilation : ce test dit seulement qu'il compile. */
it('un montant relu se re-qualifie sans passer par un number', () => {
  const montant = decimalFromText('1234.56', 'cash_flows.amount_usdc') as UsdcAmount;
  expect(montant.toFixed()).toBe('1234.56');
});
