import { readFileSync } from 'node:fs';

import { Decimal } from 'decimal.js';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SnapshotRecord } from '../../src/adapters/db.js';
import { openDatabase } from '../../src/adapters/db.js';
import type { DailyCandle } from '../../src/adapters/market.js';
import type {
  ConvoyeurBase,
  ConvoyeurBaseReelle,
  EtapeAEcrire,
  LigneJournal,
} from '../../src/convoyeur/base.js';
import {
  cleApport,
  ConvoyeurBaseError,
  dernierDepuisLignes,
  ligneApport,
  ligneJournal,
  openConvoyeurBase,
} from '../../src/convoyeur/base.js';
import { clientOrderIdConvoyage } from '../../src/convoyeur/regles.js';
import type { Achat, EurAmount, UsdcAmount } from '../../src/convoyeur/types.js';
import { REBALANCE_CONFIGS } from '../../src/core/config.js';
import type { Holdings, PricedAsset } from '../../src/core/portfolio.js';
import { decide } from '../../src/core/strategy/rebalance.js';
import type {
  CashFlow,
  IsoDate,
  Price,
  Quantity,
  UsdcAmount as UbacUsdc,
  Weight,
} from '../../src/core/types.js';
import { expectedCalendar } from '../../src/fixture/normalise.js';
import { PORTFOLIO_KEYS, prepareSnapshot } from '../../src/jobs/snapshot.js';
import { doubleBase } from './doubles.js';

/**
 * La base du convoyeur (Y4a) : CV11 (moitie ecriture), CV12, CV14. Le contrat
 * du port est eprouve deux fois, sur le double du passage et sur Postgres
 * **sous le role du convoyeur** ; CV12 et CV14 relisent la ligne ecrite par les
 * lectures d'Ubac et la passent a `prepareSnapshot` et `decide`, ce qui est
 * permis a `test/` et interdit a `src/convoyeur/` (piege 2).
 */

const URL_DE_TEST = process.env['UBAC_TEST_DATABASE_URL'];
const ROLE = 'ubac_convoyeur';

const eur = (v: string): EurAmount => new Decimal(v) as EurAmount;
const usdc = (v: string): UsdcAmount => new Decimal(v) as UsdcAmount;

const JOUR = '2026-10-27';
const DEMANDE = new Date('2026-10-27T17:00:02.000Z');
/** L'instant du transfert, entre la photo du 27 a 07:00 et le run du 28 a 07:00. */
const TRANSFERT = new Date('2026-10-27T17:00:05.000Z');

/** Des grandeurs decimalement sensibles : 0,1 + 0,2 n'y vaut 0,3 qu'en `Decimal`. */
const ACHAT: Achat = {
  orderId: 'ordre-exchange-fabrique-1',
  filledSize: usdc('107.300001'),
  filledValue: eur('99.7'),
  totalFees: eur('0.3'),
};

const etape = (e: EtapeAEcrire['etape'], jour: IsoDate = JOUR): EtapeAEcrire => {
  switch (e) {
    case 'ACHETE':
      return { etape: e, convoyage: jour, le: DEMANDE, achat: ACHAT };
    case 'TRANSFERT_DEMANDE':
      return { etape: e, convoyage: jour, le: DEMANDE, montant: ACHAT.filledSize };
    case 'TRANSFERE':
      return { etape: e, convoyage: jour, le: TRANSFERT };
    case 'EN_PANNE':
      return { etape: e, convoyage: jour, le: TRANSFERT, motif: 'USDC etranger' };
    case 'ACHAT_DEMANDE':
    case 'ENREGISTRE':
      return { etape: e, convoyage: jour, le: DEMANDE };
  }
};

const APPORT = { convoyage: JOUR, achat: ACHAT, transfereLe: TRANSFERT };

// --- Les lignes, sans base ----------------------------------------------------

describe('les lignes du journal', () => {
  it('portent l’identifiant de l’ordre et le jour, et les grandeurs de leur seule etape', () => {
    expect(ligneJournal(etape('ACHAT_DEMANDE'))).toEqual({
      convoyage: clientOrderIdConvoyage(JOUR),
      day: JOUR,
      step: 'ACHAT_DEMANDE',
      occurredAt: DEMANDE,
      amountUsdc: null,
      debitedEur: null,
      feesEur: null,
      exchangeOrderId: null,
      reason: null,
    });
    const achete = ligneJournal(etape('ACHETE'));
    expect([achete.amountUsdc?.toFixed(), achete.debitedEur?.toFixed(), achete.feesEur?.toFixed()]).toEqual([
      '107.300001',
      '100',
      '0.3',
    ]);
    expect(achete.exchangeOrderId).toBe(ACHAT.orderId);
    expect(ligneJournal(etape('TRANSFERT_DEMANDE')).amountUsdc?.toFixed()).toBe('107.300001');
    expect(ligneJournal(etape('EN_PANNE')).reason).toBe('USDC etranger');
  });

  it.each([
    ['ACHAT_DEMANDE', { etape: 'ACHAT_DEMANDE', convoyage: JOUR }],
    ['ACHETE', { etape: 'ACHETE', convoyage: JOUR, achat: ACHAT }],
    ['TRANSFERT_DEMANDE', { etape: 'TRANSFERT_DEMANDE', convoyage: JOUR, achat: ACHAT, demandeLe: DEMANDE }],
    ['TRANSFERE', { etape: 'TRANSFERE', convoyage: JOUR, achat: ACHAT, transfereLe: TRANSFERT }],
    ['ENREGISTRE', { etape: 'ENREGISTRE', convoyage: JOUR }],
    ['EN_PANNE', { etape: 'EN_PANNE', convoyage: JOUR, motif: 'USDC etranger' }],
  ] as const)('se relisent en derniere etape %s, l’achat reconstitue au centime pres', (jusqua, attendu) => {
    const ordre = ['ACHAT_DEMANDE', 'ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE', 'ENREGISTRE'] as const;
    const ecrites =
      jusqua === 'EN_PANNE'
        ? [...ordre.slice(0, 2), 'EN_PANNE' as const]
        : ordre.slice(0, ordre.indexOf(jusqua) + 1);
    /*
     * L'ordre des lignes rendues par la base n'est pas garanti : triees par nom,
     * la derniere etape n'est ni la premiere ni la derniere ligne.
     */
    const lignes = ecrites.map((e) => ligneJournal(etape(e))).sort((a, b) => a.step.localeCompare(b.step));
    const lu = dernierDepuisLignes(lignes);
    expect(lu).toEqual(attendu);
    if (lu !== undefined && 'achat' in lu) expect(lu.achat.filledValue.toFixed()).toBe('99.7');
  });

  /*
   * Y4b : la cloture d'une panne par l'operateur (`docs/convoyeur.md` §8) est
   * une ligne `ENREGISTRE` ajoutee apres `EN_PANNE`. Elle l'emporte, a toute
   * etape ; sans elle, `EN_PANNE` l'emporte sur toute etape du passage.
   */
  it('EN_PANNE l’emporte sur les etapes du passage, ENREGISTRE sur EN_PANNE', () => {
    const ordre = ['ACHAT_DEMANDE', 'ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE'] as const;
    for (const jusqua of ordre) {
      const lignes = [...ordre.slice(0, ordre.indexOf(jusqua) + 1), 'EN_PANNE' as const].map((e) =>
        ligneJournal(etape(e)),
      );
      expect(dernierDepuisLignes(lignes)?.etape, jusqua).toBe('EN_PANNE');
      const close = { ...ligneJournal(etape('ENREGISTRE')), reason: 'clos par l’operateur' };
      expect(dernierDepuisLignes([close, ...lignes]), jusqua).toEqual({ etape: 'ENREGISTRE', convoyage: JOUR });
    }
  });

  it('un journal vide ne rend aucun convoyage', () => {
    expect(dernierDepuisLignes([])).toBeUndefined();
  });

  it('refuse deux convoyages melés, ou un identifiant qui ne derive pas du jour', () => {
    const a = ligneJournal(etape('ACHAT_DEMANDE'));
    const b = ligneJournal(etape('ACHAT_DEMANDE', '2026-10-28'));
    expect(() => dernierDepuisLignes([a, b])).toThrow(ConvoyeurBaseError);
    expect(() => dernierDepuisLignes([{ ...a, convoyage: 'autre' }])).toThrow(ConvoyeurBaseError);
  });

  it.each(['amountUsdc', 'debitedEur', 'feesEur', 'exchangeOrderId'] as const)(
    'refuse un ACHETE sans %s plutot que d’inventer un achat',
    (champ) => {
      const lignes: LigneJournal[] = [{ ...ligneJournal(etape('ACHETE')), [champ]: null }];
      expect(() => dernierDepuisLignes(lignes)).toThrow(ConvoyeurBaseError);
    },
  );

  it('refuse un TRANSFERE sans ACHETE, et un EN_PANNE sans motif', () => {
    expect(() => dernierDepuisLignes([ligneJournal(etape('TRANSFERE'))])).toThrow(ConvoyeurBaseError);
    expect(() => dernierDepuisLignes([{ ...ligneJournal(etape('EN_PANNE')), reason: null }])).toThrow(
      ConvoyeurBaseError,
    );
  });
});

describe('la ligne de l’apport (DC4, DC5, DC7)', () => {
  it('porte l’USDC de l’ordre, l’instant du transfert, l’origine et la clef de l’ordre', () => {
    const ligne = ligneApport(APPORT);
    expect(ligne).toMatchObject({
      occurredAt: TRANSFERT,
      origin: 'CONVOYEUR',
      naturalKey: `CONVOYEUR:${clientOrderIdConvoyage(JOUR)}`,
    });
    expect(ligne.amountUsdc.toFixed()).toBe('107.300001');
    expect(cleApport(JOUR)).toBe(ligne.naturalKey);
  });

  it('note l’EUR debite, les frais et l’ordre, et rien d’autre', () => {
    expect(ligneApport(APPORT).note).toBe(
      'convoyeur 2026-10-27 : EUR debite 100, frais 0.3 EUR, ordre ordre-exchange-fabrique-1',
    );
  });

  it.each(['0', '-1', '1.123456789', 'NaN'])(
    'refuse un montant de %s USDC, que la colonne arrondirait ou fausserait',
    (v) => {
      const achat = { ...ACHAT, filledSize: usdc(v) };
      expect(() => ligneApport({ ...APPORT, achat })).toThrow(ConvoyeurBaseError);
    },
  );
});

describe('le role ne demande que ce que Q9 lui donne', () => {
  it('base.ts n’ecrit ni UPDATE, ni DELETE, ni RETURNING, ni requete brute', () => {
    const source = readFileSync(new URL('../../src/convoyeur/base.ts', import.meta.url), 'utf8');
    expect(source.match(/\.(update|delete|returning|execute|query)\(|sql`/g) ?? []).toEqual([]);
  });
});

// --- Le contrat, sur le double et sur Postgres ---------------------------------

/**
 * Ce que le passage (Y4b) attend de toute base du convoyeur. `compter` lit ce
 * qui a ete ecrit sans passer par le port, qui ne relit pas `cash_flows`.
 */
function contrat(ouvrir: () => { base: ConvoyeurBase; compter: () => Promise<{ journal: number; apports: number }> }) {
  let base: ConvoyeurBase;
  let compter: () => Promise<{ journal: number; apports: number }>;

  beforeEach(() => {
    ({ base, compter } = ouvrir());
  });

  it('rend le dernier convoyage, le plus recent des jours', async () => {
    expect(await base.dernierConvoyage()).toBeUndefined();
    for (const e of ['ACHAT_DEMANDE', 'ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE', 'ENREGISTRE'] as const) {
      expect(await base.ecrireEtape(etape(e))).toBe('RECORDED');
    }
    expect(await base.ecrireEtape(etape('ACHAT_DEMANDE', '2026-10-28'))).toBe('RECORDED');
    expect(await base.dernierConvoyage()).toEqual({ etape: 'ACHAT_DEMANDE', convoyage: '2026-10-28' });
  });

  it('une etape rejouee rend ALREADY_RECORDED et ne double pas la ligne', async () => {
    await base.ecrireEtape(etape('ACHAT_DEMANDE'));
    expect(await base.ecrireEtape(etape('ACHETE'))).toBe('RECORDED');
    expect(await base.ecrireEtape(etape('ACHETE'))).toBe('ALREADY_RECORDED');
    expect(await base.ecrireEtape(etape('ACHAT_DEMANDE'))).toBe('ALREADY_RECORDED');
    expect((await compter()).journal).toBe(2);
    expect(await base.dernierConvoyage()).toMatchObject({ etape: 'ACHETE', achat: ACHAT });
  });

  it('CV11 : l’apport rejoue rend ALREADY_RECORDED, une seule ligne reste', async () => {
    expect(await base.ecrireApport(APPORT)).toBe('RECORDED');
    expect(await base.ecrireApport({ ...APPORT, transfereLe: DEMANDE })).toBe('ALREADY_RECORDED');
    expect((await compter()).apports).toBe(1);
  });
}

describe('le contrat, sur le double du passage', () => {
  contrat(() => {
    const double = doubleBase();
    return {
      base: double,
      compter: () => Promise.resolve({ journal: double.journal.length, apports: double.apports.length }),
    };
  });
});

// --- Contre Postgres, sous le role du convoyeur ------------------------------

const SCRIPT = readFileSync(new URL('../../scripts/role-convoyeur.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((ligne) => !ligne.startsWith('\\'))
  .join('\n');

/** Le SQLSTATE d'une erreur, a travers l'emballage de drizzle. */
function codeSql(erreur: unknown): string | undefined {
  let courant = erreur;
  while (typeof courant === 'object' && courant !== null) {
    const c = courant as { code?: unknown; cause?: unknown };
    if (typeof c.code === 'string') return c.code;
    courant = c.cause;
  }
  return undefined;
}

/** La contrainte nommee par le 23505 que la promesse leve, a travers l'emballage de drizzle. */
async function contrainteLevee(promesse: Promise<unknown>): Promise<string> {
  let courant: unknown = await promesse.then(
    () => undefined,
    (e: unknown) => e,
  );
  while (typeof courant === 'object' && courant !== null) {
    const c = courant as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (c.code === '23505') return String(c.constraint);
    courant = c.cause;
  }
  return 'aucun 23505';
}

/** La chaine de test, ouverte sous le role : `ubac_dev` est superutilisateur, le role n'a pas de mot de passe. */
function sousLeRole(url: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c role=${ROLE}`);
  return u.toString();
}

describe.skipIf(URL_DE_TEST === undefined)('la base du convoyeur, contre Postgres, sous son role', () => {
  const url = URL_DE_TEST ?? '';
  let brut: pg.Client;
  let base: ConvoyeurBaseReelle;

  async function compter(): Promise<{ journal: number; apports: number }> {
    const r = await brut.query<{ journal: number; apports: number }>(
      `SELECT (SELECT count(*) FROM convoyeur_journal)::int AS journal,
              (SELECT count(*) FROM cash_flows)::int AS apports`,
    );
    const [ligne] = r.rows;
    if (ligne === undefined) throw new Error('compte introuvable');
    return ligne;
  }

  beforeAll(async () => {
    brut = new pg.Client({ connectionString: url });
    await brut.connect();
    await brut.query(SCRIPT);
    base = openConvoyeurBase({ databaseUrl: sousLeRole(url) });
  });

  afterAll(async () => {
    await base.close();
    await brut.end();
  });

  beforeEach(async () => {
    await brut.query('TRUNCATE cash_flows, convoyeur_journal');
  });

  afterEach(async () => {
    await brut.query('DROP INDEX IF EXISTS ubac_sonde_cash_flows, ubac_sonde_journal');
  });

  it('la connexion du port est bien celle du role : cash_flows lui est fermee en lecture', async () => {
    const commeLui = new pg.Client({ connectionString: sousLeRole(url) });
    await commeLui.connect();
    try {
      const qui = await commeLui.query<{ u: string }>('SELECT current_user AS u');
      expect(qui.rows[0]?.u).toBe(ROLE);
      await expect(commeLui.query('SELECT * FROM cash_flows')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await commeLui.end();
    }
  });

  /*
   * Le port lui-meme ecrit sous le role : un droit retire au role lui ferme
   * l'ecriture. Le script, rejoue, le rend.
   */
  it('le port ecrit sous le role : sans son INSERT, l’apport est refuse (42501)', async () => {
    await brut.query(`REVOKE INSERT ON cash_flows FROM ${ROLE}`);
    try {
      await expect(base.ecrireApport(APPORT)).rejects.toSatisfy((e) => codeSql(e) === '42501');
    } finally {
      await brut.query(SCRIPT);
    }
    expect(await base.ecrireApport(APPORT)).toBe('RECORDED');
  });

  describe('le contrat', () => {
    contrat(() => ({ base, compter }));
  });

  it('CV11 : une ligne CONVOYEUR, du montant de l’ordre, a l’instant du transfert', async () => {
    await base.ecrireApport(APPORT);
    await base.ecrireApport(APPORT);
    const r = await brut.query<{ occurred_at: Date; amount_usdc: string; origin: string; natural_key: string }>(
      'SELECT occurred_at, amount_usdc, origin, natural_key FROM cash_flows',
    );
    expect(r.rows).toEqual([
      {
        occurred_at: TRANSFERT,
        amount_usdc: '107.30000100',
        origin: 'CONVOYEUR',
        natural_key: cleApport(JOUR),
      },
    ]);
  });

  /*
   * La traduction est etroite : un 23505 sur un autre index que celui de la
   * clef (ou du journal) n'est pas un rejeu, il remonte. L'index sonde est pose
   * par le test, et retire apres lui.
   */
  it('un 23505 sur une autre contrainte remonte, pour l’apport comme pour l’etape', async () => {
    await brut.query(`INSERT INTO cash_flows (occurred_at, amount_usdc) VALUES ($1, '5')`, [TRANSFERT]);
    await brut.query('CREATE UNIQUE INDEX ubac_sonde_cash_flows ON cash_flows (occurred_at)');
    expect(await contrainteLevee(base.ecrireApport(APPORT))).toBe('ubac_sonde_cash_flows');

    await brut.query('CREATE UNIQUE INDEX ubac_sonde_journal ON convoyeur_journal (occurred_at)');
    await base.ecrireEtape(etape('ACHAT_DEMANDE'));
    expect(await contrainteLevee(base.ecrireEtape(etape('ACHETE')))).toBe('ubac_sonde_journal');
  });

  /*
   * Un second ACHAT_DEMANDE du meme jour bute sur les deux index, et Postgres
   * en nomme un. Pour isoler celui du jour, la ligne deja la porte un autre
   * identifiant : l'ecriture n'est pas une erreur, et la relecture refuse le
   * journal melé au lieu de le lire.
   */
  it('l’index du jour vaut deja ecrit ; un journal melé se refuse a la relecture', async () => {
    await brut.query(
      `INSERT INTO convoyeur_journal (convoyage, day, step, occurred_at) VALUES ('etranger', $1, 'ACHAT_DEMANDE', $2)`,
      [JOUR, DEMANDE],
    );
    expect(await base.ecrireEtape(etape('ACHAT_DEMANDE'))).toBe('ALREADY_RECORDED');
    await expect(base.dernierConvoyage()).rejects.toThrow(ConvoyeurBaseError);
  });

  describe('Ubac relit l’apport', () => {
    let ubac: ReturnType<typeof openDatabase>;

    beforeAll(() => {
      ubac = openDatabase({ databaseUrl: url });
    });

    afterAll(async () => {
      await ubac.close();
    });

    /*
     * CV12 : la photo du 27 a 07:00, le run du 28 a 07:00. La valeur du jour
     * contient l'apport ; l'indice ne monte pas, parce que `netFlow()` le
     * soustrait de la sous-periode. Sans la ligne, il monterait : la sonde est
     * sensible a ce qu'elle mesure.
     */
    it('CV12 : compte dans la sous-periode qui se ferme au run suivant, l’indice ne monte pas', async () => {
      await base.ecrireApport(APPORT);
      const veille = photo('2026-10-27');
      const flows = (await ubac.recentCashFlows(veille.createdAt)).map((f) => ({
        occurredAt: f.occurredAt,
        amount: f.amount,
      }));
      expect(flows.map((f) => [f.occurredAt, f.amount.toFixed()])).toEqual([[TRANSFERT, '107.300001']]);

      const total = new Decimal('100000').plus(ACHAT.filledSize) as UbacUsdc;
      const indice = (fl: typeof flows) =>
        prepareSnapshot({
          runDate: '2026-10-28',
          runInstant: new Date('2026-10-28T07:00:00.000Z'),
          holdings: AVOIRS,
          weights: POIDS,
          totalValue: total,
          history: PLAT,
          previous: veille,
          flows: fl,
        }).benchmarks[PORTFOLIO_KEYS.index]?.toFixed();
      expect(indice(flows)).toBe('1');
      expect(indice([])).not.toBe('1');
    });

    /* CV14 : la meme ligne gele A sept jours, J+0 a J+6 ; le run de J+7 tire. */
    it('CV14 : la ligne gele le declencheur A jusqu’a J+7 exclu', async () => {
      await base.ecrireApport(APPORT);
      const flux: readonly CashFlow[] = (await ubac.recentCashFlows(new Date('2026-10-20T00:00:00.000Z'))).map(
        (f) => ({ occurredOn: f.occurredOn, amount: f.amount }),
      );
      expect(flux.map((f) => f.occurredOn)).toEqual(['2026-10-27']);

      expect(declencheur('2026-11-02', flux)).toBe('NONE');
      expect(declencheur('2026-11-03', flux)).toBe('CASH_BAND');
      expect(declencheur('2026-11-02', [])).toBe('CASH_BAND');
    });
  });
});

// --- Le portefeuille des sondes CV12 et CV14 ------------------------------------

const prix = (v: string): Price => new Decimal(v) as Price;
const qte = (v: string): Quantity => new Decimal(v) as Quantity;
const poids = (v: string): Weight => new Decimal(v) as Weight;

const AVOIRS: Holdings = { BTC: qte('0.8'), ETH: qte('12'), USDC: qte('30000') };
const POIDS = { BTC: poids('0.4'), ETH: poids('0.3'), USDC: poids('0.3') };

const PLAT: Readonly<Record<PricedAsset, readonly DailyCandle[]>> = {
  BTC: expectedCalendar('2026-04-01', '2026-10-27').map((date) => ({
    date,
    open: prix('50000'),
    high: prix('50000'),
    low: prix('50000'),
    close: prix('50000'),
  })),
  ETH: expectedCalendar('2026-04-01', '2026-10-27').map((date) => ({
    date,
    open: prix('2500'),
    high: prix('2500'),
    low: prix('2500'),
    close: prix('2500'),
  })),
};

function photo(runDate: IsoDate): SnapshotRecord {
  return {
    runDate,
    totalValueUsdc: new Decimal('100000') as UbacUsdc,
    weights: POIDS,
    positions: AVOIRS,
    benchmarks: { [PORTFOLIO_KEYS.index]: new Decimal(1), [PORTFOLIO_KEYS.peak]: new Decimal(1) },
    createdAt: new Date(`${runDate}T07:00:00.000Z`),
  };
}

/**
 * Le declencheur de la configuration de production, sur un portefeuille dont
 * le cash pese 45 % (au-dessus de la bande : A veut investir l'apport) et dont
 * le ratio BTC/ETH est dans sa bande. Meme construction que
 * `test/core/cash-flow-delay.test.ts`.
 */
function declencheur(jour: IsoDate, cashFlows: readonly CashFlow[]): string {
  const total = new Decimal('100000');
  const crypto = total.mul('0.55');
  const ratio = new Decimal('1.3333333333');
  const decision = decide(
    {
      holdings: {
        BTC: crypto.mul(ratio).div(ratio.plus(1)).div('50000') as Quantity,
        ETH: crypto.div(ratio.plus(1)).div('2500') as Quantity,
        USDC: total.mul('0.45') as Quantity,
      },
      prices: { BTC: prix('50000'), ETH: prix('2500') },
      cashFlows,
      lastRatioRebalanceOn: null,
    },
    { today: () => jour },
    REBALANCE_CONFIGS.rebalance,
  );
  if (decision.status !== 'DECIDED') throw new Error(`attendu DECIDED, recu ${decision.status}`);
  return decision.intent.trigger;
}
