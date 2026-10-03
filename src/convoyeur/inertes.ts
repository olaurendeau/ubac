import { Decimal } from 'decimal.js';

import type { Quantity } from '../core/types.js';
import type { ConvoyeurBase } from './base.js';
import { PRODUIT } from './coinbase.js';
import type { PortsPassage } from './passage.js';
import { MONTANT_CONVOYE } from './regles.js';

/**
 * Les ports inertes du convoyeur (lot Y5, CV16), sur le motif de
 * `src/adapters/inertes.ts` d'Ubac : les memes types que les vrais, qui
 * journalisent ce qu'ils auraient fait. Aucun ne sait dans quel mode il tourne ;
 * seul `main.ts` les compose. **Lire reste reel** (cle, soldes, journal, ordre
 * connu de l'exchange) ; ni ordre, ni `move_funds`, ni ligne en base.
 *
 * Pour que le passage dise le transfert qu'il aurait fait, les soldes relus
 * portent l'effet de ce qui est retenu : un achat ote 100 EUR et ajoute 100 USDC
 * **fictifs**, a parite et sans frais (aucun prix n'est lu) ; un transfert les
 * ote. `docs/convoyeur.md` §6.
 */

type CoinbasePassage = PortsPassage['coinbase'];
type Journal = (ligne: string) => void;

/** Le prefixe de l'identifiant d'un ordre retenu, jamais place. */
export const ORDRE_NON_PLACE = 'non-place-';

export function coinbaseInerte(vrai: CoinbasePassage, log: Journal): CoinbasePassage {
  const retenus = new Map<string, string>();
  let eurRetenu = new Decimal(0);
  let usdcRetenu = new Decimal(0);
  const fictif = (): Quantity => MONTANT_CONVOYE as Decimal as Quantity;
  const zero = new Decimal(0) as Quantity;

  return {
    keyPermissions: () => vrai.keyPermissions(),

    async balances() {
      const { eur, usdc } = await vrai.balances();
      return {
        eur: { ...eur, available: eur.available.minus(eurRetenu) as Quantity },
        usdc: { ...usdc, available: usdc.available.plus(usdcRetenu) as Quantity },
      };
    },

    marketBuy(clientOrderId) {
      const exchangeId = `${ORDRE_NON_PLACE}${clientOrderId}`;
      if (!retenus.has(exchangeId)) {
        retenus.set(exchangeId, clientOrderId);
        eurRetenu = eurRetenu.plus(MONTANT_CONVOYE);
        usdcRetenu = usdcRetenu.plus(fictif());
        log(
          `coinbase inerte : ordre retenu, non place — BUY ${PRODUIT} au marche de ${MONTANT_CONVOYE.toFixed()} EUR, client_order_id=${clientOrderId}`,
        );
      }
      return Promise.resolve({ exchangeId });
    },

    order(exchangeId) {
      const clientOrderId = retenus.get(exchangeId);
      if (clientOrderId === undefined) return vrai.order(exchangeId);
      log(`coinbase inerte : ordre ${exchangeId} dit rempli de ${fictif().toFixed()} USDC fictifs, a parite et sans frais`);
      return Promise.resolve({
        kind: 'FILLED' as const,
        exchangeId,
        clientOrderId,
        filledSize: fictif(),
        filledValue: fictif(),
        totalFees: zero,
      });
    },

    moveFunds({ source, destination, usdc }) {
      usdcRetenu = usdcRetenu.minus(usdc);
      log(`coinbase inerte : move_funds retenu, non appele — ${usdc.toFixed()} USDC de ${source} vers ${destination}`);
      return Promise.resolve({ kind: 'DEMANDE' as const, usdc: usdc as Quantity });
    },
  };
}

/** Le journal et `cash_flows` sans leurs ecritures ; la lecture du journal reste reelle. */
export function baseInerte(vraie: ConvoyeurBase, log: Journal): ConvoyeurBase {
  return {
    dernierConvoyage: () => vraie.dernierConvoyage(),
    ecrireEtape(etape) {
      log(`base inerte : etape ${etape.etape} du convoyage ${etape.convoyage} non ecrite`);
      return Promise.resolve('RETENU');
    },
    ecrireApport({ convoyage, achat }) {
      log(`base inerte : apport de ${achat.filledSize.toFixed()} USDC du convoyage ${convoyage} non ecrit dans cash_flows`);
      return Promise.resolve('RETENU');
    },
  };
}
