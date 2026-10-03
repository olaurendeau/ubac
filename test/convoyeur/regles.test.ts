import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { ESLint } from 'eslint';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { UsdcAmount as UsdcUbac } from '../../src/core/types.js';
import {
  MONTANT_CONVOYE,
  SEUIL_POUSSIERE_USDC,
  clientOrderIdConvoyage,
  constater,
  deciderPassage,
  etatAuRun,
  eurEngage,
  jourDuPassage,
  lignePoussiere,
  montantATransferer,
  notification,
  reprendre,
  transfertAdmis,
  verifierCle,
  type CompteRendu,
  type Decision,
  type EntreePassage,
  type Suite,
} from '../../src/convoyeur/regles.js';
import {
  ETAPES,
  type Achat,
  type DernierConvoyage,
  type Etape,
  type EurAmount,
  type UsdcAmount,
} from '../../src/convoyeur/types.js';

/**
 * Lot Y2 du plan `ubac-convoyeur` : les regles, sans IO. Chaque critere CV que
 * le lot couvre « sur les regles » a ses sondes ici ; le branchement (Y4b, Y5)
 * les clot.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const eur = (texte: string): EurAmount => new Decimal(texte) as EurAmount;
const usdc = (texte: string): UsdcAmount => new Decimal(texte) as UsdcAmount;

const PRIMARY = '6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';
const UBAC_AGENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PORTEFEUILLES = { primaryUuid: PRIMARY, destinationUuid: UBAC_AGENT };

const ACHAT: Achat = {
  orderId: 'ordre-exchange-1',
  filledSize: usdc('99.402985'),
  filledValue: eur('99.40'),
  totalFees: eur('0.60'),
};

const DEMANDE_LE = new Date('2026-10-27T17:00:03.000Z');

const entree = (change: Partial<EntreePassage>): EntreePassage => ({
  jour: '2026-10-27', dernier: undefined, eurDisponible: eur('0'), usdcRelu: usdc('0'), ...change,
});

/** Le journal arrete a `etape`, avec ce que cette etape a constate. */
function arreteA(etape: Etape, convoyage: string, achat: Achat = ACHAT): DernierConvoyage {
  switch (etape) {
    case 'ACHAT_DEMANDE':
    case 'ENREGISTRE':
      return { etape, convoyage };
    case 'ACHETE':
      return { etape, convoyage, achat };
    case 'TRANSFERT_DEMANDE':
      return { etape, convoyage, achat, demandeLe: DEMANDE_LE };
    case 'TRANSFERE':
      return { etape, convoyage, achat, transfereLe: DEMANDE_LE };
    case 'EN_PANNE':
      return { etape, convoyage, motif: 'sonde' };
  }
}

function suiteDe(decision: Decision): Suite {
  if (decision.action !== 'REPRENDRE') throw new Error(`attendu REPRENDRE, recu ${decision.action}`);
  return decision.suite;
}

// --- CV1 ----------------------------------------------------------------------

describe('CV1 — la cle du convoyeur', () => {
  const CLE = { can_view: true, can_trade: true, can_transfer: true, portfolio_uuid: PRIMARY, portfolio_type: 'DEFAULT' };

  it('admet la cle de Primary, DEFAULT, qui voit, echange et transfere', () => {
    expect(verifierCle(CLE, PRIMARY)).toEqual({ admis: true });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['un autre portefeuille', { portfolio_uuid: UBAC_AGENT }, /scopee sur .*9a8b7c6d.*Primary attend 6f1c2b0e/],
    ['Primary altere au dernier caractere', { portfolio_uuid: `${PRIMARY.slice(0, -1)}c` }, /scopee/],
    ['un portefeuille absent', { portfolio_uuid: undefined }, /scopee/],
    ['un type CONSUMER', { portfolio_type: 'CONSUMER' }, /portfolio_type vaut "CONSUMER"/],
    ['un type absent', { portfolio_type: undefined }, /portfolio_type/],
    ['can_transfer a "true"', { can_transfer: 'true' }, /can_transfer vaut "true"/],
    ['can_transfer a false', { can_transfer: false }, /can_transfer vaut false/],
    ['can_transfer a 1', { can_transfer: 1 }, /can_transfer vaut 1/],
    ['can_trade a false', { can_trade: false }, /can_trade vaut false/],
    ['can_view a "true"', { can_view: 'true' }, /can_view vaut "true"/],
  ])('refuse %s', (_cas, change, motif) => {
    const verdict = verifierCle({ ...CLE, ...change }, PRIMARY);
    expect(verdict.admis).toBe(false);
    if (!verdict.admis) expect(verdict.motif).toMatch(motif);
  });

  it('refuse une cle dont can_transfer est absent, et le dit', () => {
    const { can_transfer: _retire, ...sansTransfert } = CLE;
    expect(verifierCle(sansTransfert, PRIMARY)).toMatchObject({ motif: expect.stringMatching(/can_transfer vaut absent/) as unknown });
  });
});

// --- CV2 ----------------------------------------------------------------------

describe('CV2 — source et destination a egalite exacte', () => {
  it('admet Primary vers ubac-agent', () => {
    expect(transfertAdmis({ source: PRIMARY, destination: UBAC_AGENT }, PORTEFEUILLES)).toEqual({ admis: true });
  });

  const alterer = (uuid: string, i: number): string =>
    `${uuid.slice(0, i)}${uuid[i] === '0' ? '1' : '0'}${uuid.slice(i + 1)}`;

  // Premier, milieu, dernier caractere : une comparaison en prefixe ou en suffixe rougit.
  it.each([
    ['alteree au premier caractere', alterer(UBAC_AGENT, 0)],
    ['alteree au milieu', alterer(UBAC_AGENT, 18)],
    ['alteree au dernier caractere', alterer(UBAC_AGENT, 35)],
    ['tronquee', UBAC_AGENT.slice(0, -1)],
    ['prolongee', `${UBAC_AGENT}0`],
    ['en majuscules', UBAC_AGENT.toUpperCase()],
    ['avec un espace', `${UBAC_AGENT} `],
    ['egale a la source', PRIMARY],
  ])('refuse une destination %s', (_cas, destination) => {
    const verdict = transfertAdmis({ source: PRIMARY, destination }, PORTEFEUILLES);
    expect(verdict).toMatchObject({ admis: false, motif: expect.stringMatching(/destination/) as unknown });
  });

  it('refuse une source autre que Primary, meme vers la bonne destination', () => {
    const verdict = transfertAdmis({ source: alterer(PRIMARY, 35), destination: UBAC_AGENT }, PORTEFEUILLES);
    expect(verdict).toMatchObject({ admis: false, motif: expect.stringMatching(/source/) as unknown });
  });
});

// --- CV6 ----------------------------------------------------------------------

describe("CV6 — le client_order_id d'un convoyage", () => {
  /**
   * Valeurs calculees hors du module (sha256 de l'encodage prefixe par
   * longueur, domaine `ubac.convoyeur.client-order-id.v1`). Si ce test casse,
   * l'encodage a change et un convoyage ouvert avant le deploiement perd sa
   * protection contre le second achat : une decision, pas une valeur a
   * reactualiser.
   */
  it.each([
    ['2026-10-27', 'convoyeur-aeef09f0d7e3d51610dfa088'],
    ['2026-11-27', 'convoyeur-088903dcae6a3fbcc7c4c362'],
    ['2026-12-31', 'convoyeur-19943007abe1ac070e57d5a6'],
  ])('fige la valeur du %s', (jour, attendu) => {
    expect(clientOrderIdConvoyage(jour)).toBe(attendu);
  });

  it("stable pour un jour, distinct d'un jour a l'autre, de forme constante sous 36 caracteres", () => {
    expect(clientOrderIdConvoyage('2026-10-27')).toBe(clientOrderIdConvoyage('2026-10-27'));
    const jours = ['2026-10-27', '2026-10-28', '2027-10-27'];
    expect(new Set(jours.map(clientOrderIdConvoyage)).size).toBe(3);
    expect(clientOrderIdConvoyage('2026-10-27')).toMatch(/^convoyeur-[0-9a-f]{24}$/);
  });

  it.each(['2026-02-30', '2026-9-1', '2026-10-27T00:00:00Z', '', ' 2026-10-27'])("refuse %j, qui n'est pas un jour", (jour) => {
    expect(() => clientOrderIdConvoyage(jour)).toThrow(RangeError);
  });

  it('le convoyage est le jour UTC du passage', () => {
    expect(jourDuPassage(new Date('2026-10-27T17:00:00.000Z'))).toBe('2026-10-27');
    expect(jourDuPassage(new Date('2026-10-27T23:59:59.999Z'))).toBe('2026-10-27');
    expect(jourDuPassage(new Date('2026-10-28T00:00:00.000Z'))).toBe('2026-10-28');
    expect(() => jourDuPassage(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("un rejeu du jour relit l'ordre sous l'identifiant de l'achat", () => {
    const achat = deciderPassage(entree({ eurDisponible: eur('100') }));
    const rejeu = suiteDe(deciderPassage(entree({ dernier: { etape: 'ACHAT_DEMANDE', convoyage: '2026-10-27' } })));
    expect(achat).toMatchObject({ action: 'COMMENCER', clientOrderId: 'convoyeur-aeef09f0d7e3d51610dfa088' });
    expect(rejeu).toEqual({ faire: 'RELIRE_ORDRE', clientOrderId: 'convoyeur-aeef09f0d7e3d51610dfa088' });
  });
});

// --- CV5, CV7 -----------------------------------------------------------------

describe('CV5 — sous 100 EUR, rien', () => {
  it('99,99 EUR ne font rien, et le motif le chiffre', () => {
    const decision = deciderPassage(entree({ eurDisponible: eur('99.99') }));
    expect(decision).toMatchObject({ action: 'RIEN', motif: expect.stringMatching(/99\.99 EUR/) as unknown });
    expect(eurEngage(decision).isZero()).toBe(true);
  });

  it('100 EUR pile convoient : le seuil est inclusif (Q6)', () => {
    expect(deciderPassage(entree({ eurDisponible: eur('100') })).action).toBe('COMMENCER');
    expect(deciderPassage(entree({ eurDisponible: eur('100.00') })).action).toBe('COMMENCER');
  });

  it.each(['0', '-5'])('%s EUR ne font rien', (texte) => {
    expect(deciderPassage(entree({ eurDisponible: eur(texte) })).action).toBe('RIEN');
  });

  it.each(['NaN', 'Infinity'])('un EUR a %s est refuse comme illisible, pas convoye', (texte) => {
    const decision = deciderPassage(entree({ eurDisponible: eur(texte) }));
    expect(decision).toMatchObject({ action: 'REFUSER', motif: expect.stringMatching(/illisible/) as unknown });
  });
});

/** Un solde EUR quelconque, au centime ou au-dela, de 0 a 10^12. */
const soldeEur = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.integer({ min: 0, max: 8 }))
  .map(([mantisse, echelle]) => eur(new Decimal(mantisse.toString()).div(10 ** echelle).toFixed()));

const soldeUsdc = fc.oneof(
  fc.constant(usdc('0')),
  fc.constant(ACHAT.filledSize),
  fc.bigInt({ min: 0n, max: 10n ** 12n }).map((n) => usdc(new Decimal(n.toString()).div(1e6).toFixed())),
);

const jour = fc.constantFrom('2026-10-26', '2026-10-27', '2026-10-28');

const dernierConvoyage: fc.Arbitrary<DernierConvoyage | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.tuple(fc.constantFrom(...ETAPES), jour).map(([etape, convoyage]) => arreteA(etape, convoyage)),
);

describe('CV7 — un passage engage 0 ou exactement 100 EUR', () => {
  it('pour tout solde EUR, tout USDC relu et tout etat du journal', () => {
    fc.assert(
      fc.property(soldeEur, soldeUsdc, dernierConvoyage, (eurDisponible, usdcRelu, dernier) => {
        const decision = deciderPassage(entree({ eurDisponible, usdcRelu, dernier }));
        const engage = eurEngage(decision);
        expect(engage.isZero() || engage.toFixed() === '100').toBe(true);
        if (decision.action === 'COMMENCER') {
          expect(decision.quoteSize.toFixed()).toBe('100');
          expect(decision.eurLaisse.plus(decision.quoteSize).eq(eurDisponible)).toBe(true);
          expect(decision.eurLaisse.gte(0)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('un convoyage ouvert se finit sans rien commencer, meme avec 500 EUR (point 3)', () => {
    fc.assert(
      fc.property(dernierConvoyage, soldeUsdc, (dernier, usdcRelu) => {
        fc.pre(dernier !== undefined && dernier.etape !== 'ENREGISTRE');
        const decision = deciderPassage(entree({ dernier, usdcRelu, eurDisponible: eur('500') }));
        expect(decision.action).toBe('REPRENDRE');
        expect(eurEngage(decision).isZero()).toBe(true);
      }),
    );
  });

  it('250 EUR en trois passages : 100, 100, puis rien, avec 50 EUR signales', () => {
    let solde = eur('250');
    let dernier: DernierConvoyage | undefined;
    const engages: string[] = [];
    const notes: string[] = [];
    for (const jourDuPassage of ['2026-10-27', '2026-10-28', '2026-10-29']) {
      const decision = deciderPassage(entree({ jour: jourDuPassage, dernier, eurDisponible: solde }));
      engages.push(eurEngage(decision).toFixed());
      if (decision.action === 'COMMENCER') {
        solde = decision.eurLaisse;
        dernier = { etape: 'ENREGISTRE', convoyage: decision.convoyage };
        const { convoyage, eurLaisse } = decision;
        const compteRendu: CompteRendu = { nature: 'CONVOYAGE', convoyage, etape: 'ENREGISTRE', achat: ACHAT, eurLaisse, motif: undefined, poussiere: undefined };
        notes.push(notification(compteRendu).corps);
      }
    }
    expect(engages).toEqual(['100', '100', '0']);
    expect(solde.toFixed()).toBe('50');
    expect(notes[1]).toMatch(/EUR laisse dans Primary : 50 EUR/);
  });

  it('un second passage le meme jour ne rachete pas (DC8)', () => {
    const dernier: DernierConvoyage = { etape: 'ENREGISTRE', convoyage: '2026-10-27' };
    expect(deciderPassage(entree({ dernier, eurDisponible: eur('150') })).action).toBe('RIEN');
    const lendemain = entree({ jour: '2026-10-28', dernier, eurDisponible: eur('150') });
    expect(deciderPassage(lendemain).action).toBe('COMMENCER');
  });
});

// --- CV8, CV9, CV10 : la table de reprise -------------------------------------

describe('CV8 — le montant transfere est filled_size, en Decimal', () => {
  const acheteLe: DernierConvoyage = { etape: 'ACHETE', convoyage: '2026-10-27', achat: ACHAT };

  it('transfere exactement filled_size', () => {
    const suite = reprendre(acheteLe, usdc('99.402985'));
    expect(suite).toMatchObject({ faire: 'TRANSFERER' });
    if (suite.faire === 'TRANSFERER') {
      expect(suite.montant).toBeInstanceOf(Decimal);
      expect(suite.montant.toFixed()).toBe('99.402985');
    }
    expect(montantATransferer(ACHAT)).toBe(ACHAT.filledSize);
  });

  /*
   * Le montant vient de l'ordre, jamais du solde : a egalite de valeur, les
   * deux se confondent, d'ou la sonde par provenance. Elle rougit si le montant
   * est pris au solde relu, meme quand les deux valent autant.
   */
  it("un zero de queue ne change pas la grandeur, et le montant reste celui de l'ordre", () => {
    const suite = reprendre(acheteLe, usdc('99.4029850'));
    expect(suite).toMatchObject({ faire: 'TRANSFERER' });
    if (suite.faire === 'TRANSFERER') expect(suite.montant).toBe(ACHAT.filledSize);
  });

  /*
   * Au-dessus de `filled_size`, un reste sous 1 USDC est une poussiere (DC10,
   * sondes plus bas) ; en dessous, aucun reste n'explique le manque.
   */
  it.each(['99.402984', '99.4029849999999999', '99.40', '100.402985'])(
    'un USDC relu a %s, sous filled_size ou au-dela de la poussiere, est une anomalie, pas un arrondi',
    (relu) => {
      expect(reprendre(acheteLe, usdc(relu)).faire).toBe('PANNE');
    },
  );
});

describe('CV9, CV10 — chaque ligne de la table de reprise', () => {
  const convoyage = '2026-10-26';
  const cas: [string, Etape, string, Suite['faire']][] = [
    ['ACHAT_DEMANDE, USDC quelconque', 'ACHAT_DEMANDE', '42', 'RELIRE_ORDRE'],
    ['ACHETE, USDC = filled_size', 'ACHETE', '99.402985', 'TRANSFERER'],
    ['TRANSFERT_DEMANDE, USDC = filled_size', 'TRANSFERT_DEMANDE', '99.402985', 'TRANSFERER'],
    ['TRANSFERT_DEMANDE, USDC 0', 'TRANSFERT_DEMANDE', '0', 'NOTER_TRANSFERE'],
    ['ACHETE, USDC 0', 'ACHETE', '0', 'PANNE'],
    ['ACHETE, USDC autre', 'ACHETE', '199.402985', 'PANNE'],
    ['TRANSFERT_DEMANDE, USDC autre', 'TRANSFERT_DEMANDE', '50', 'PANNE'],
    ['TRANSFERE, USDC quelconque', 'TRANSFERE', '7', 'ENREGISTRER'],
    ['EN_PANNE', 'EN_PANNE', '0', 'PANNE'],
  ];

  it.each(cas)('%s', (_ligne, etape, relu, attendu) => {
    const decision = deciderPassage(entree({ dernier: arreteA(etape, convoyage), usdcRelu: usdc(relu), eurDisponible: eur('300') }));
    expect(decision).toMatchObject({ action: 'REPRENDRE', convoyage });
    expect(suiteDe(decision).faire).toBe(attendu);
  });

  it("interrompu apres l'achat : transfere filled_size sans racheter (CV9)", () => {
    const decision = deciderPassage(entree({ dernier: arreteA('ACHETE', convoyage), usdcRelu: usdc('99.402985'), eurDisponible: eur('100') }));
    expect(eurEngage(decision).isZero()).toBe(true);
    expect(suiteDe(decision)).toEqual({ faire: 'TRANSFERER', montant: ACHAT.filledSize, achat: ACHAT, poussiere: usdc('0') });
  });

  it("interrompu apres le transfert : ne transfere pas une seconde fois, garde l'instant de la demande", () => {
    const suite = suiteDe(deciderPassage(entree({ dernier: arreteA('TRANSFERT_DEMANDE', convoyage), usdcRelu: usdc('0') })));
    expect(suite).toEqual({ faire: 'NOTER_TRANSFERE', transfereLe: DEMANDE_LE, achat: ACHAT, poussiere: usdc('0') });
  });

  it('un achat sans USDC (filled_size nul) est une panne, ni un transfert ni un transfert fait', () => {
    const achatVide: Achat = { ...ACHAT, filledSize: usdc('0') };
    for (const etape of ['ACHETE', 'TRANSFERT_DEMANDE'] as const) {
      expect(suiteDe(deciderPassage(entree({ dernier: arreteA(etape, convoyage, achatVide) }))).faire).toBe('PANNE');
    }
  });

  it("un USDC illisible n'est jamais transfere", () => {
    expect(suiteDe(deciderPassage(entree({ dernier: arreteA('ACHETE', convoyage), usdcRelu: usdc('NaN') }))).faire).toBe('PANNE');
  });

  it.each<[string, DernierConvoyage | undefined]>([
    ['journal vide', undefined],
    ['dernier convoyage enregistre', { etape: 'ENREGISTRE', convoyage: '2026-10-20' }],
  ])('CV10 : USDC dans Primary sans convoyage ouvert (%s) — refus, aucun achat', (_cas, dernier) => {
    for (const relu of ['1', '1.01', '99.402985', '-1', '-0.0000009', 'NaN', 'Infinity']) {
      const decision = deciderPassage(entree({ dernier, usdcRelu: usdc(relu), eurDisponible: eur('500') }));
      expect(decision).toMatchObject({ action: 'REFUSER', motif: expect.stringMatching(/etranger/) as unknown });
      expect(eurEngage(decision).isZero()).toBe(true);
    }
  });
});

// --- DC10 : la poussiere de Primary (decision du 2026-10-03) ----------------

describe('DC10 — un USDC de Primary sous 1 USDC est une poussiere, pas un etranger', () => {
  /** Le solde du premier DRY_RUN reel, le 2026-10-03 a 21:54Z. */
  const CONSTATEE = '0.0000008962268961';

  it('le seuil est une constante Decimal de 1 USDC', () => {
    expect(SEUIL_POUSSIERE_USDC).toBeInstanceOf(Decimal);
    expect(SEUIL_POUSSIERE_USDC.toFixed()).toBe('1');
  });

  it.each(['0', '0.0000009', CONSTATEE, '0.99', '0.9999999999999999999999'])(
    'sans convoyage ouvert, %s USDC n’arrete rien : 100 EUR convoient, et la poussiere est dite',
    (relu) => {
      const decision = deciderPassage(entree({ usdcRelu: usdc(relu), eurDisponible: eur('100') }));
      expect(decision).toMatchObject({ action: 'COMMENCER', quoteSize: MONTANT_CONVOYE });
      if (decision.action === 'COMMENCER') expect(decision.poussiere.toFixed()).toBe(new Decimal(relu).toFixed());
      expect(eurEngage(decision).toFixed()).toBe('100');
    },
  );

  it('le constat du 2026-10-03 : 0.0077 EUR et une poussiere ne font rien, sans refus', () => {
    const decision = deciderPassage(entree({ usdcRelu: usdc(CONSTATEE), eurDisponible: eur('0.0077') }));
    expect(decision).toMatchObject({ action: 'RIEN', motif: expect.stringMatching(/0\.0077 EUR/) as unknown });
    if (decision.action === 'RIEN') expect(decision.poussiere.toFixed()).toBe(CONSTATEE);
  });

  it.each(['1', '1.00', '1.01', '1.0000000000000000001'])(
    'a partir de 1 USDC inclus (%s), le refus est inchange : etranger, aucun achat',
    (relu) => {
      const decision = deciderPassage(entree({ usdcRelu: usdc(relu), eurDisponible: eur('500') }));
      expect(decision).toEqual({
        action: 'REFUSER',
        motif: `${new Decimal(relu).toFixed()} USDC dans Primary sans convoyage ouvert : USDC etranger, aucun achat.`,
      });
    },
  );

  describe.each(['0.0000009', '0.99'])('reprise avec une poussiere de %s USDC', (texte) => {
    const poussiere = usdc(texte);
    const plus = usdc(ACHAT.filledSize.plus(poussiere).toFixed());
    const convoyage = '2026-10-26';

    it.each(['ACHETE', 'TRANSFERT_DEMANDE'] as const)(
      '%s, filled_size plus la poussiere : transfere filled_size, pas le solde',
      (etape) => {
        const suite = suiteDe(deciderPassage(entree({ dernier: arreteA(etape, convoyage), usdcRelu: plus })));
        expect(suite).toMatchObject({ faire: 'TRANSFERER' });
        if (suite.faire === 'TRANSFERER') {
          expect(suite.montant).toBe(ACHAT.filledSize);
          expect(suite.poussiere.toFixed()).toBe(texte);
        }
      },
    );

    it('TRANSFERT_DEMANDE, la poussiere seule : le transfert est fait, a l’instant de la demande', () => {
      const suite = suiteDe(deciderPassage(entree({ dernier: arreteA('TRANSFERT_DEMANDE', convoyage), usdcRelu: poussiere })));
      expect(suite).toEqual({ faire: 'NOTER_TRANSFERE', transfereLe: DEMANDE_LE, achat: ACHAT, poussiere });
    });

    it('ACHETE, la poussiere seule : parti sans demande, panne', () => {
      expect(suiteDe(deciderPassage(entree({ dernier: arreteA('ACHETE', convoyage), usdcRelu: poussiere }))).faire).toBe('PANNE');
    });

    it.each(['ACHETE', 'TRANSFERT_DEMANDE'] as const)('%s, filled_size plus la poussiere plus 1 : panne', (etape) => {
      const relu = usdc(plus.plus(1).toFixed());
      expect(suiteDe(deciderPassage(entree({ dernier: arreteA(etape, convoyage), usdcRelu: relu }))).faire).toBe('PANNE');
    });
  });

  it('un filled_size sous le seuil est une panne ; a 1 USDC pile, la table tient', () => {
    const demi: Achat = { ...ACHAT, filledSize: usdc('0.5') };
    const un: Achat = { ...ACHAT, filledSize: usdc('1') };
    for (const relu of ['0', '0.5', '0.7']) {
      expect(reprendre({ etape: 'TRANSFERT_DEMANDE', convoyage: '2026-10-26', achat: demi, demandeLe: DEMANDE_LE }, usdc(relu)).faire).toBe('PANNE');
    }
    const ouvert = { etape: 'TRANSFERT_DEMANDE', convoyage: '2026-10-26', achat: un, demandeLe: DEMANDE_LE } as const;
    expect(reprendre(ouvert, usdc('1')).faire).toBe('TRANSFERER');
    expect(reprendre(ouvert, usdc('1.99')).faire).toBe('TRANSFERER');
    expect(reprendre(ouvert, usdc('0.99')).faire).toBe('NOTER_TRANSFERE');
    expect(reprendre(ouvert, usdc('2')).faire).toBe('PANNE');
  });

  /** Une poussiere : de 0 a 1 USDC exclu, au plus au 10^-18. */
  const poussiere = fc
    .bigInt({ min: 0n, max: 10n ** 18n - 1n })
    .map((n) => usdc(new Decimal(n.toString()).div('1e18').toFixed()));
  /** Un filled_size d'au moins 1 USDC, au 10^-6. */
  const rempli = fc.bigInt({ min: 10n ** 6n, max: 10n ** 12n }).map((n) => usdc(new Decimal(n.toString()).div(1e6).toFixed()));

  /** Le solde construit sans arrondi : `plus` arrondit a 20 chiffres significatifs, le solde lu non. */
  const Exact = Decimal.clone({ precision: 100 });
  const somme = (...termes: Decimal[]): UsdcAmount =>
    usdc(termes.reduce((total, terme) => total.plus(terme.toFixed()), new Exact(0)).toFixed());

  it('pour toute poussiere et tout filled_size : present, parti, ou incoherent, jamais deux a la fois', () => {
    fc.assert(
      fc.property(poussiere, rempli, (p, montant) => {
        expect(constater(somme(montant, p), montant)).toEqual({ usdc: 'PRESENT', poussiere: p });
        expect(constater(p, montant)).toEqual({ usdc: 'PARTI', poussiere: p });
        expect(constater(somme(montant, p, new Decimal(1)), montant).usdc).toBe('INCOHERENT');
      }),
      { numRuns: 500 },
    );
  });

  it('pour tout USDC relu, la table ne transfere que filled_size, et seulement s’il est la (aucun double transfert)', () => {
    fc.assert(
      fc.property(soldeUsdc, fc.constantFrom('ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE'), (relu, etape) => {
        const suite = reprendre(arreteA(etape, '2026-10-26') as Parameters<typeof reprendre>[0], relu);
        if (suite.faire === 'TRANSFERER') {
          expect(suite.montant).toBe(ACHAT.filledSize);
          expect(relu.gte(ACHAT.filledSize) && relu.lt(ACHAT.filledSize.plus(1))).toBe(true);
        }
        if (suite.faire === 'NOTER_TRANSFERE') expect(relu.lt(1)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('la ligne d’information dit le montant, et rien pour zero ou absent', () => {
    expect(lignePoussiere(usdc(CONSTATEE))).toBe(
      `poussiere ignoree dans Primary : ${CONSTATEE} USDC, sous le seuil de 1 USDC`,
    );
    expect(lignePoussiere(usdc('0'))).toBeUndefined();
    expect(lignePoussiere(undefined)).toBeUndefined();
  });
});

// --- CV13, CV17 ---------------------------------------------------------------

describe('CV13 — ce qui manque, et ce que lira le run de 07:00', () => {
  it('seul ENREGISTRE ne manque de rien', () => {
    for (const etape of ETAPES) {
      const { manque, runLira } = etatAuRun(etape);
      expect(manque === undefined).toBe(etape === 'ENREGISTRE');
      expect(runLira.length).toBeGreaterThan(0);
    }
  });

  it("TRANSFERE dit la ligne absente, et l'USDC lu comme une performance", () => {
    expect(etatAuRun('TRANSFERE')).toEqual({
      manque: 'ligne cash_flows absente',
      runLira: expect.stringMatching(/performance/) as unknown,
    });
  });
});

describe('CV17 — le texte des notifications', () => {
  const convoyage: CompteRendu = { nature: 'CONVOYAGE', convoyage: '2026-11-27', etape: 'ENREGISTRE', achat: ACHAT, eurLaisse: eur('50'), motif: undefined, poussiere: undefined };

  it('un convoyage complet dit EUR debite, USDC recu, frais, etape et EUR laisse', () => {
    const { titre, corps, priorite } = notification(convoyage);
    expect(titre).toBe('convoyeur — convoyage');
    expect(priorite).toBe('HIGH');
    expect(corps.split('\n')).toEqual([
      'convoyage : 2026-11-27',
      'EUR debite : 100 EUR',
      'USDC recu : 99.402985 USDC',
      'frais : 0.6 EUR',
      'etape atteinte : ENREGISTRE',
      'EUR laisse dans Primary : 50 EUR',
      "le run de 07:00 lira : l'USDC et sa ligne cash_flows : l'apport est compte.",
    ]);
  });

  it('une poussiere ignoree est une ligne d’information, montant compris, sans urgence (DC10)', () => {
    const avec = notification({ ...convoyage, poussiere: usdc('0.0000009') });
    expect(avec.priorite).toBe('HIGH');
    expect(avec.corps.split('\n')).toContain('poussiere ignoree dans Primary : 0.0000009 USDC, sous le seuil de 1 USDC');
    expect(avec.corps.split('\n')).toHaveLength(notification(convoyage).corps.split('\n').length + 1);
    expect(notification({ ...convoyage, poussiere: usdc('0') }).corps).toBe(notification(convoyage).corps);
  });

  it('la marque du mode suit le prefixe, et le corps ne change pas (DP4)', () => {
    const marquee = notification(convoyage, 'DRY_RUN');
    expect(marquee.titre).toBe('convoyeur DRY_RUN — convoyage');
    expect(marquee.corps).toBe(notification(convoyage).corps);
  });

  it.each<[CompteRendu['nature'], CompteRendu['etape']]>([
    ['CONVOYAGE', 'ACHAT_DEMANDE'],
    ['CONVOYAGE', 'TRANSFERE'],
    ['REPRISE', 'TRANSFERT_DEMANDE'],
    ['PANNE', 'EN_PANNE'],
    ['REFUS', undefined],
    ['REFUS', 'ENREGISTRE'],
  ])('%s arrete a %s est urgent (CV13)', (nature, etape) => {
    const note = notification({ ...convoyage, nature, etape });
    expect(note.priorite).toBe('URGENT');
    if (etape !== undefined && etape !== 'ENREGISTRE') expect(note.corps).toMatch(/^manque : /m);
  });

  it('un refus avant tout achat dit « aucun » et son motif, sans notation exponentielle', () => {
    const motif = '0.00000001 USDC dans Primary sans convoyage ouvert';
    const { corps } = notification({ ...convoyage, nature: 'REFUS', convoyage: undefined, etape: undefined, achat: undefined, eurLaisse: eur('0.00000001'), motif });
    expect(corps.split('\n')).toEqual([
      'EUR debite : aucun',
      'USDC recu : aucun',
      'frais : aucun',
      'etape atteinte : aucune',
      'EUR laisse dans Primary : 0.00000001 EUR',
      `motif : ${motif}`,
    ]);
  });
});

// --- Purete et grandeurs ------------------------------------------------------

describe('Y2, piege 3 — les regles tiennent les regles du noyau', () => {
  /*
   * Y3 etend le glob du noyau a `src/convoyeur/regles.ts`. D'ici la, la sonde
   * lint le fichier reel sous un chemin virtuel de `src/core/` : aucune IO,
   * aucune horloge, aucun module hors de decimal.js et de createHash.
   */
  it('regles.ts et types.ts passent les regles de purete de core', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    for (const fichier of ['regles.ts', 'types.ts']) {
      const code = await readFile(resolve(ROOT, 'src/convoyeur', fichier), 'utf8');
      const [resultat] = await eslint.lintText(code, {
        filePath: resolve(ROOT, 'src/core/convoyeur-sonde', fichier),
      });
      expect(resultat?.messages).toEqual([]);
    }
  });

  it("les montants du convoyeur ne se confondent ni entre eux ni avec ceux d'Ubac", () => {
    const unEur = eur('1');
    // @ts-expect-error un EUR n'est pas un USDC
    const depuisEur: UsdcAmount = unEur;
    const unUsdcUbac = new Decimal('1') as UsdcUbac;
    // @ts-expect-error l'USDC d'Ubac n'est pas celui du convoyeur
    const depuisUbac: UsdcAmount = unUsdcUbac;
    // @ts-expect-error et reciproquement
    const versUbac: UsdcUbac = usdc('1');
    expect([depuisEur, depuisUbac, versUbac]).toHaveLength(3);
    expect(MONTANT_CONVOYE.toFixed()).toBe('100');
  });
});
