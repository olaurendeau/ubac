import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { clientOrderId } from '../../src/core/order-id.js';
import { MIN_LEG_USDC } from '../../src/core/risk.js';
import type { MidPrices } from '../../src/core/risk.js';
import type { IsoDate, Price } from '../../src/core/types.js';
import type {
  IntentionDeCession,
  IntentionDeDeclencheur,
  PlanDeSortie,
  SortieInput,
} from '../../src/jobs/liquidate.js';
import {
  DECALAGE_DE_JAMBE,
  ETAPES,
  MARGE_LIMITE_PCT,
  SortieError,
  planifierSortie,
} from '../../src/jobs/liquidate.js';
import type { ReconciledBalances } from '../../src/jobs/reconcile.js';
import { reconcile } from '../../src/jobs/reconcile.js';
import type { Scenario } from './doubles.js';
import { harnais, ordreOuvert, photo, qty, solde } from './doubles.js';

/**
 * Le deroule de la spec §14, eprouve **contre les doubles** de la
 * reconciliation : aucun reseau, aucune cle, aucune base. Les soldes ne sont
 * jamais fabriques a la main — ils sortent de `reconcile()`, seul module qui
 * sache marquer un `ReconciledBalances`. C'est la meme garantie que pour le run
 * quotidien : on ne liquide pas sur un etat qu'on s'est compose soi-meme.
 *
 * Ce fichier eprouve ce que le plan **dit**. Ce qu'il ne peut pas faire —
 * s'appliquer — est l'objet de `liquidate-verrou.test.ts`.
 */

const RUN_DATE: IsoDate = '2026-09-12';

const prix = (v: string): Price => new Decimal(v) as Price;

const BTC = prix('60000');
const ETH = prix('3000');
const MIDS: MidPrices = { BTC, ETH };

/** Un portefeuille ordinaire : 30 000 de BTC, 30 000 d'ETH, 40 000 de cash. */
const PORTEFEUILLE: Scenario = {
  balances: [solde('BTC', '0.5'), solde('ETH', '10'), solde('USDC', '40000')],
};

async function soldesDe(scenario: Scenario): Promise<ReconciledBalances> {
  const resultat = await reconcile(harnais(scenario).input);
  if (resultat.status !== 'RECONCILED') {
    throw new Error(`le scenario de test ne reconcilie pas : ${resultat.reason}`);
  }
  return resultat.balances;
}

async function entree(
  scenario: Scenario = PORTEFEUILLE,
  overrides: Partial<Omit<SortieInput, 'soldes'>> = {},
): Promise<SortieInput> {
  return {
    runDate: RUN_DATE,
    soldes: await soldesDe(scenario),
    ouverts: scenario.open ?? [],
    mids: MIDS,
    ...overrides,
  };
}

async function plan(
  scenario: Scenario = PORTEFEUILLE,
  overrides: Partial<Omit<SortieInput, 'soldes'>> = {},
): Promise<PlanDeSortie> {
  return planifierSortie(await entree(scenario, overrides));
}

function cessionsDe(p: PlanDeSortie): readonly IntentionDeCession[] {
  return p.intentions.filter((i): i is IntentionDeCession => i.etape === 'CESSION');
}

// --- Le deroule -------------------------------------------------------------

describe('§14 — le deroule, dans l’ordre de la spec', () => {
  it('les trois etapes applicables se suivent, et la quatrieme est le rapport', async () => {
    const p = await plan({ ...PORTEFEUILLE, open: [ordreOuvert()] });

    expect(p.intentions.map((i) => i.etape)).toEqual([
      'ANNULATION',
      'CESSION',
      'CESSION',
      'DECLENCHEUR',
    ]);
    /*
     * Le tableau `ETAPES` recopie le §14 ; on le confronte au plan plutot que de
     * reecrire la liste ici. Les trois premieres sont des intentions, la
     * quatrieme est le rapport — un compte cite, assert sur ce qu'il decrit.
     */
    expect([...new Set(p.intentions.map((i) => i.etape))]).toEqual(ETAPES.slice(0, 3));
    expect(ETAPES[3]).toBe('RAPPORT');
    expect(p.rapport.statut).toBe('PROJETE');
  });

  it('deux calculs sur la meme entree rendent le meme plan', async () => {
    const e = await entree({ ...PORTEFEUILLE, open: [ordreOuvert()] });
    expect(planifierSortie(e)).toEqual(planifierSortie(e));
  });
});

// --- Etape 1 : annulation de tous les ordres ouverts ------------------------

describe('§14.1 — tous les ordres ouverts sont retires', () => {
  it('ceux que la base ne reclame pas et ceux d’une autre contrepartie en sont', async () => {
    const p = await plan({
      ...PORTEFEUILLE,
      open: [
        ordreOuvert({ exchangeId: 'b', clientOrderId: 'connu' }),
        ordreOuvert({ exchangeId: 'c', clientOrderId: '', product: 'BTC-EUR' }),
        ordreOuvert({ exchangeId: 'a', clientOrderId: 'inconnu-de-la-base' }),
      ],
    });

    const retraits = p.intentions.filter((i) => i.etape === 'ANNULATION');
    expect(retraits).toHaveLength(3);
    // Trie par identifiant d'exchange : le plan ne depend pas de l'ordre de lecture.
    expect(retraits.map((i) => i.exchangeId)).toEqual(['a', 'b', 'c']);
    expect(p.rapport.ordresRetires).toBe(retraits.length);
  });

  it('deux ordres de meme identifiant restent tous les deux, dans leur ordre de lecture', async () => {
    // Improbable sur un exchange, mais le comparateur a ce cas et il est teste.
    const p = await plan({
      ...PORTEFEUILLE,
      open: [ordreOuvert({ clientOrderId: 'premier' }), ordreOuvert({ clientOrderId: 'second' })],
    });
    const retraits = p.intentions.filter((i) => i.etape === 'ANNULATION');
    expect(retraits.map((i) => i.clientOrderId)).toEqual(['premier', 'second']);
  });

  it('aucun ordre ouvert : l’etape est vide, le reste du deroule tient', async () => {
    const p = await plan();
    expect(p.intentions.filter((i) => i.etape === 'ANNULATION')).toEqual([]);
    expect(p.rapport.ordresRetires).toBe(0);
    expect(p.intentions.filter((i) => i.etape === 'DECLENCHEUR')).toHaveLength(1);
  });
});

// --- Etape 2 : liquidation vers USDC, limit post-only -----------------------

describe('§14.2, §11 — la contrepartie est USDC, jamais EUR', () => {
  it('les cessions cotent en USDC alors que l’entree porte de l’EUR', async () => {
    const p = await plan({
      balances: [solde('BTC', '0.5'), solde('ETH', '10'), solde('EUR', '1200')],
      open: [ordreOuvert({ product: 'ETH-EUR' })],
    });

    for (const cession of cessionsDe(p)) {
      expect(cession.ordre.quote).toBe('USDC');
      expect(cession.product.endsWith('-USDC')).toBe(true);
    }
    expect(cessionsDe(p).map((c) => c.product)).toEqual(['BTC-USDC', 'ETH-USDC']);
    /*
     * L'EUR de l'entree ne ressort ni en paire, ni en ligne de rapport : la
     * seule trace admise est l'ordre ouvert a retirer, dont le retrait n'est pas
     * une cession et n'est donc pas un fait generateur.
     */
    expect(JSON.stringify(p.rapport)).not.toContain('EUR');
    expect(JSON.stringify(cessionsDe(p))).not.toContain('EUR');
  });

  it('USDC n’est jamais cede : c’est la destination, pas une position', async () => {
    const p = await plan();
    expect(cessionsDe(p).map((c) => c.ordre.asset)).toEqual(['BTC', 'ETH']);
  });
});

describe('§14.2, §7 — limit post-only, mid + 0,1 %', () => {
  it('chaque cession est post-only et se pose strictement au-dessus du mid', async () => {
    const p = await plan();

    for (const cession of cessionsDe(p)) {
      expect(cession.postOnly).toBe(true);
      expect(cession.ordre.side).toBe('SELL');
      /*
       * Le signe de la marge est la moitie utile du post-only : une vente sous
       * le mid croiserait le carnet et l'exchange la refuserait.
       */
      expect(cession.ordre.limitPrice.gt(cession.mid)).toBe(true);
      expect(cession.ordre.limitPrice.toString()).toBe(
        cession.mid.mul(new Decimal(1).add(MARGE_LIMITE_PCT)).toString(),
      );
    }
    expect(cessionsDe(p).map((c) => c.ordre.limitPrice.toString())).toEqual(['60060', '3003']);
  });

  it('la quantite cedee est le solde total, gele compris', async () => {
    /*
     * L'etape 1 retire les ordres en vol : la part immobilisee redevient
     * disponible avant que l'etape 2 ne s'applique. Ceder le seul disponible
     * laisserait derriere elle exactement ce qu'un ordre ouvert tenait.
     */
    const p = await plan({
      balances: [solde('BTC', '0.2', '0.3'), solde('ETH', '0'), solde('USDC', '0')],
      open: [ordreOuvert()],
    });
    expect(cessionsDe(p).map((c) => c.ordre.quantity.toString())).toEqual(['0.5']);
  });
});

describe('§7 — le client_order_id est derive, pas recalcule', () => {
  it('il vaut exactement ce que core/order-id.ts rend pour la jambe', async () => {
    const p = await plan();

    expect(cessionsDe(p).map((c) => c.ordre.clientOrderId)).toEqual([
      clientOrderId({ runDate: RUN_DATE, asset: 'BTC', side: 'SELL', legIndex: DECALAGE_DE_JAMBE }),
      clientOrderId({
        runDate: RUN_DATE,
        asset: 'ETH',
        side: 'SELL',
        legIndex: DECALAGE_DE_JAMBE + 1,
      }),
    ]);
    expect(p.rapport.cessions.map((l) => l.clientOrderId)).toEqual(
      cessionsDe(p).map((c) => c.ordre.clientOrderId),
    );
  });

  it('le decalage ecarte la sortie des jambes du run quotidien du meme jour', async () => {
    /*
     * Sans decalage, une sortie lancee le jour d'un reequilibrage vendrait BTC
     * sous le meme identifiant que la premiere jambe du run : l'exchange
     * avalerait la seconde au titre du doublon et le portefeuille resterait a
     * moitie liquide, sans erreur remontee.
     */
    const p = await plan();
    // Tout l'espace que le run quotidien peut atteindre, et pas un echantillon.
    const duRunQuotidien = new Set(
      Array.from({ length: DECALAGE_DE_JAMBE }, (_, legIndex) =>
        clientOrderId({ runDate: RUN_DATE, asset: 'BTC', side: 'SELL', legIndex }),
      ),
    );
    expect(duRunQuotidien.size).toBe(DECALAGE_DE_JAMBE);
    for (const cession of cessionsDe(p)) {
      expect(duRunQuotidien.has(cession.ordre.clientOrderId)).toBe(false);
    }
  });

  it('deux cessions du meme plan ne partagent pas d’identifiant', async () => {
    const p = await plan();
    const identifiants = cessionsDe(p).map((c) => c.ordre.clientOrderId);
    expect(new Set(identifiants).size).toBe(identifiants.length);
  });
});

describe('§14.2 — le plancher de MIN_LEG_USDC separe une cession d’un residu', () => {
  it('sous le plancher, la ligne devient un residu et n’est pas cedee', async () => {
    // 0.002 BTC a 60 000, soit 120 USDC : sous les 200 du noyau.
    const p = await plan({ balances: [solde('BTC', '0.002'), solde('ETH', '10')] });

    expect(cessionsDe(p).map((c) => c.ordre.asset)).toEqual(['ETH']);
    expect(p.rapport.residus.map((r) => r.asset)).toEqual(['BTC']);
    expect(p.rapport.residus[0]?.valeurUsdc.toString()).toBe('120');
    expect(p.rapport.residus[0]?.motif).toContain(MIN_LEG_USDC.toString());
  });

  it('au plancher pile, la ligne se cede : strict, comme risk.ts', async () => {
    /*
     * Un mid rond pour que la valeur tombe sur 200 sans arrondi : 2 x 100. La
     * borne est celle du noyau, et elle est stricte des deux cotes — 200 passe,
     * 199 non.
     */
    const centUsdc = { BTC: prix('100'), ETH };
    const auPlancher = await plan({ balances: [solde('BTC', '2')] }, { mids: centUsdc });
    expect(cessionsDe(auPlancher)[0]?.ordre.quantity.mul(100).toString()).toBe(
      MIN_LEG_USDC.toString(),
    );
    expect(auPlancher.rapport.residus).toEqual([]);

    const sousLePlancher = await plan({ balances: [solde('BTC', '1.99')] }, { mids: centUsdc });
    expect(cessionsDe(sousLePlancher)).toEqual([]);
    expect(sousLePlancher.rapport.residus.map((r) => r.asset)).toEqual(['BTC']);
  });

  it('une ligne a zero n’est ni une cession ni un residu', async () => {
    const p = await plan({ balances: [solde('BTC', '0'), solde('ETH', '10')] });
    expect(cessionsDe(p).map((c) => c.ordre.asset)).toEqual(['ETH']);
    expect(p.rapport.residus).toEqual([]);
  });

  it('un actif detenu sans prix de reference arrete le plan', async () => {
    await expect(plan(PORTEFEUILLE, { mids: { BTC } })).rejects.toBeInstanceOf(SortieError);
  });

  it('un actif a zero n’exige aucun prix de reference', async () => {
    const p = await plan({ balances: [solde('BTC', '0.5'), solde('ETH', '0')] }, { mids: { BTC } });
    expect(cessionsDe(p).map((c) => c.ordre.asset)).toEqual(['BTC']);
  });
});

// --- Etape 3 : desactivation du declencheur ---------------------------------

describe('§14.3 — le declencheur quotidien est desarme', () => {
  it('l’intention est presente, nomme le cron du §8, et vient apres les cessions', async () => {
    const p = await plan({ ...PORTEFEUILLE, open: [ordreOuvert()] });
    const desarmements = p.intentions.filter(
      (i): i is IntentionDeDeclencheur => i.etape === 'DECLENCHEUR',
    );

    expect(desarmements).toHaveLength(1);
    expect(desarmements[0]?.cron).toBe('0 7 * * *');
    expect(p.intentions[p.intentions.length - 1]?.etape).toBe('DECLENCHEUR');
  });

  it('il est desarme meme quand il n’y a rien a ceder', async () => {
    const p = await plan({ balances: [solde('USDC', '40000')] });
    expect(p.intentions.map((i) => i.etape)).toEqual(['DECLENCHEUR']);
  });
});

// --- Etape 4 : le rapport final ---------------------------------------------

describe('§14.4 — le rapport recapitule les cessions', () => {
  it('les montants sont ceux du plan, et le total en decoule', async () => {
    const p = await plan({ ...PORTEFEUILLE, open: [ordreOuvert(), ordreOuvert({ exchangeId: 'z' })] });
    const rapport = p.rapport;

    expect(rapport.runDate).toBe(RUN_DATE);
    expect(rapport.ordresRetires).toBe(2);
    expect(rapport.cessions.map((l) => l.asset)).toEqual(['BTC', 'ETH']);
    // 0.5 x 60 060 + 10 x 3 003.
    expect(rapport.produitTotalUsdc.toString()).toBe('60060');
    expect(rapport.usdcInitial.toString()).toBe('40000');
    expect(rapport.usdcProjete.toString()).toBe('100060');
    expect(
      rapport.cessions
        .reduce((total, l) => total.add(l.produitUsdc), new Decimal(0))
        .toString(),
    ).toBe(rapport.produitTotalUsdc.toString());
  });

  it('le produit est celui du prix limite, pas du mid : il est attendu, pas encaisse', async () => {
    const p = await plan({ balances: [solde('BTC', '1')] });
    expect(p.rapport.cessions[0]?.produitUsdc.toString()).toBe('60060');
    expect(p.rapport.statut).toBe('PROJETE');
  });
});

// --- Les soldes viennent de la reconciliation -------------------------------

describe('la sortie part d’un etat reconcilie', () => {
  it('une reconciliation confrontee au cache donne le meme plan', async () => {
    const p = await plan({
      ...PORTEFEUILLE,
      snapshot: photo({ BTC: qty('0.5'), ETH: qty('10'), USDC: qty('40000') }),
    });
    expect(p.rapport.usdcProjete.toString()).toBe('100060');
  });

  it('une reconciliation abandonnee ne rend aucun solde a liquider', async () => {
    const resultat = await reconcile(
      harnais({
        balances: [solde('BTC', '1')],
        snapshot: photo({ BTC: qty('0.5') }),
      }).input,
    );
    expect(resultat.status).toBe('ABORTED');
    // Aucun `balances` sur cette branche : `SortieInput.soldes` n'a rien a recevoir.
    expect('balances' in resultat).toBe(false);
  });
});

// --- Entrees fautives -------------------------------------------------------

describe('les entrees qu’aucun plan ne peut interpreter sont refusees', () => {
  it.each([
    ['date inexistante', '2026-02-30'],
    ['mois hors calendrier', '2026-13-01'],
    ['format non canonique', '2026-9-12'],
    ['chaine vide', ''],
  ])('runDate : %s', async (_nom, runDate) => {
    await expect(plan(PORTEFEUILLE, { runDate })).rejects.toBeInstanceOf(SortieError);
  });

  it.each([
    ['mid nul', '0'],
    ['mid negatif', '-1'],
    ['mid non fini', 'NaN'],
  ])('prix de reference : %s', async (_nom, valeur) => {
    await expect(
      plan(PORTEFEUILLE, { mids: { BTC: prix(valeur), ETH } }),
    ).rejects.toBeInstanceOf(SortieError);
  });

  it.each([
    ['solde non fini', 'NaN'],
    ['solde negatif', '-0.5'],
  ])('solde cessible : %s', async (_nom, valeur) => {
    /*
     * `NaN` est le pire des deux : `Decimal.lt` et `Decimal.gt` repondent tous
     * les deux false dessus, donc ni le plancher ni le zero ne mordent, et la
     * cession sortirait avec une quantite indefinie sans qu'aucune ligne ne soit
     * sautee. Meme piege que le total non fini de `portfolio.ts`.
     */
    await expect(plan({ balances: [solde('BTC', valeur)] })).rejects.toBeInstanceOf(SortieError);
  });

  it.each([
    ['cash non fini', 'NaN'],
    ['cash negatif', '-1'],
  ])('solde USDC : %s', async (_nom, valeur) => {
    await expect(
      plan({ balances: [solde('BTC', '0.5'), solde('USDC', valeur)] }),
    ).rejects.toBeInstanceOf(SortieError);
  });
});
