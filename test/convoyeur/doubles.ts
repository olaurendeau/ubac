import { Decimal } from 'decimal.js';

import type { Quantity } from '../../src/core/types.js';
import type {
  Apport,
  ConvoyeurBase,
  Ecriture,
  EtapeAEcrire,
  LigneApport,
  LigneJournal,
} from '../../src/convoyeur/base.js';
import { dernierDepuisLignes, ligneApport, ligneJournal } from '../../src/convoyeur/base.js';
import type { ClePermissions, ConvoyeurCoinbase, OrdreConnu } from '../../src/convoyeur/coinbase.js';

/**
 * La base du convoyeur en memoire, pour le passage (Y4b). Elle passe par les
 * memes fonctions de ligne que la vraie, et tient les memes refus que ses
 * index : une etape par convoyage, un `ACHAT_DEMANDE` par jour, un apport par
 * clef naturelle. `test/convoyeur/base.test.ts` eprouve les deux par le meme
 * contrat.
 */
export interface DoubleBase extends ConvoyeurBase {
  readonly journal: readonly LigneJournal[];
  readonly apports: readonly LigneApport[];
}

export function doubleBase(): DoubleBase {
  const journal: LigneJournal[] = [];
  const apports: LigneApport[] = [];

  return {
    journal,
    apports,

    dernierConvoyage() {
      const jours = journal.map((l) => l.day).sort();
      const dernier = jours.at(-1);
      return Promise.resolve(dernierDepuisLignes(journal.filter((l) => l.day === dernier)));
    },

    ecrireEtape(etape: EtapeAEcrire): Promise<Ecriture> {
      const ligne = ligneJournal(etape);
      const deja = journal.some(
        (l) =>
          (l.convoyage === ligne.convoyage && l.step === ligne.step) ||
          (ligne.step === 'ACHAT_DEMANDE' && l.step === 'ACHAT_DEMANDE' && l.day === ligne.day),
      );
      if (deja) return Promise.resolve('ALREADY_RECORDED');
      journal.push(ligne);
      return Promise.resolve('RECORDED');
    },

    ecrireApport(apport: Apport): Promise<Ecriture> {
      const ligne = ligneApport(apport);
      if (apports.some((l) => l.naturalKey === ligne.naturalKey)) return Promise.resolve('ALREADY_RECORDED');
      apports.push(ligne);
      return Promise.resolve('RECORDED');
    },
  };
}

// --- L'exchange du passage ----------------------------------------------------

export type Methode = 'keyPermissions' | 'balances' | 'marketBuy' | 'order' | 'moveFunds';

/** Une panne de frontiere : `fois` appels levent, avant l'effet, ou apres (accuse perdu). */
export interface Panne {
  fois: number;
  readonly apres?: boolean;
}

/**
 * *Primary* et `ubac-agent` en memoire, au niveau du port `ConvoyeurCoinbase`.
 * L'ordre est idempotent par `client_order_id` (S5) ; `move_funds` ne l'est pas
 * (S7) et refuse un USDC absent, comme l'exchange (DC3). Chaque methode peut
 * lever, avant ou apres son effet.
 */
export interface DoubleCoinbase extends Pick<ConvoyeurCoinbase, Methode> {
  eur: Decimal;
  usdcPrimary: Decimal;
  usdcUbac: Decimal;
  cle: ClePermissions;
  /** Statut que l'ordre prend a sa creation, et que `order` rend. */
  statut: OrdreConnu['kind'];
  readonly pannes: Partial<Record<Methode, Panne>>;
  readonly appels: Methode[];
  readonly ordresCrees: string[];
  readonly transferts: Decimal[];
  /** Appele a l'entree de chaque methode, avant toute panne. */
  espion: (methode: Methode) => void;
}

export const PRIMARY = '6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';
export const UBAC_AGENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
/** L'USDC que 100 EUR achetent, frais de 0,6 EUR deduits de l'EUR (piege 4 d'Y2). */
export const RECU = new Decimal('99.400001');
export const FRAIS = new Decimal('0.6');

export function doubleCoinbase(eur: string): DoubleCoinbase {
  const ordres = new Map<string, string>();
  const q = (d: Decimal): Quantity => d as Quantity;

  const double: DoubleCoinbase = {
    eur: new Decimal(eur),
    usdcPrimary: new Decimal(0),
    usdcUbac: new Decimal(0),
    cle: {
      portfolioUuid: PRIMARY,
      portfolioType: 'DEFAULT',
      canView: true,
      canTrade: true,
      canTransfer: true,
    },
    statut: 'FILLED',
    pannes: {},
    appels: [],
    ordresCrees: [],
    transferts: [],
    espion: () => undefined,

    keyPermissions: () => frontiere('keyPermissions', () => double.cle),

    balances: () =>
      frontiere('balances', () => ({
        eur: { available: q(double.eur), hold: q(new Decimal(0)) },
        usdc: { available: q(double.usdcPrimary), hold: q(new Decimal(0)) },
      })),

    marketBuy: (clientOrderId) =>
      frontiere('marketBuy', () => {
        if (!ordres.has(clientOrderId)) {
          ordres.set(clientOrderId, `ex-${clientOrderId}`);
          double.ordresCrees.push(clientOrderId);
          if (double.statut === 'FILLED') {
            double.eur = double.eur.minus(100);
            double.usdcPrimary = double.usdcPrimary.plus(RECU);
          }
        }
        return { exchangeId: `ex-${clientOrderId}` };
      }),

    order: (exchangeId) =>
      frontiere('order', () => {
        const clientOrderId = [...ordres].find(([, id]) => id === exchangeId)?.[0];
        if (clientOrderId === undefined) return { kind: 'INDETERMINABLE' as const, reason: `${exchangeId} inconnu` };
        const rempli = double.statut === 'FILLED';
        return {
          kind: double.statut,
          exchangeId,
          clientOrderId,
          filledSize: q(rempli ? RECU : new Decimal(0)),
          filledValue: q(rempli ? new Decimal(100).minus(FRAIS) : new Decimal(0)),
          totalFees: q(rempli ? FRAIS : new Decimal(0)),
        };
      }),

    moveFunds: ({ source, destination, usdc }) =>
      frontiere('moveFunds', () => {
        if (source !== PRIMARY || destination !== UBAC_AGENT) throw new Error('move_funds : portefeuilles');
        if (double.usdcPrimary.lt(usdc)) throw new Error('move_funds : INSUFFICIENT_FUNDS');
        double.usdcPrimary = double.usdcPrimary.minus(usdc);
        double.usdcUbac = double.usdcUbac.plus(usdc);
        double.transferts.push(usdc);
        return { kind: 'DEMANDE' as const, usdc: q(usdc) };
      }),
  };

  async function frontiere<T>(methode: Methode, effet: () => T): Promise<T> {
    double.appels.push(methode);
    double.espion(methode);
    const panne = double.pannes[methode];
    const leve = panne !== undefined && panne.fois > 0;
    if (leve) panne.fois -= 1;
    if (leve && panne.apres !== true) throw new Error(`${methode} : panne avant l'effet`);
    const resultat = effet();
    if (leve) throw new Error(`${methode} : panne apres l'effet, accuse perdu`);
    return Promise.resolve(resultat);
  }

  return double;
}
