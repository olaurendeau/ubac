import { Decimal } from 'decimal.js';

import { describe, expect, it } from 'vitest';

import { baseInerte, coinbaseInerte, ORDRE_NON_PLACE } from '../../src/convoyeur/inertes.js';
import type { ConfigPassage, PortsPassage } from '../../src/convoyeur/passage.js';
import { passage } from '../../src/convoyeur/passage.js';
import { clientOrderIdConvoyage, notification } from '../../src/convoyeur/regles.js';
import type { DoubleBase, DoubleCoinbase } from './doubles.js';
import { PRIMARY, UBAC_AGENT, doubleBase, doubleCoinbase } from './doubles.js';

/**
 * CV16 : les ports inertes du `DRY_RUN` (Y5), composes par `main.ts` comme
 * ici. Les doubles sont les ports reels : en `DRY_RUN`, ils ne recoivent que
 * des lectures, et le journal dit l'ordre et le transfert qui auraient eu lieu.
 */

const CONFIG: ConfigPassage = { primaryUuid: PRIMARY, destinationUuid: UBAC_AGENT, tentatives: 2, pauseMs: 0 };
const SOIR = new Date('2026-10-27T18:00:00.000Z');

async function passerInerte(coinbase: DoubleCoinbase, base: DoubleBase) {
  const logs: string[] = [];
  const log = (ligne: string): void => {
    logs.push(ligne);
  };
  const ports: PortsPassage = {
    coinbase: coinbaseInerte(coinbase, log),
    base: baseInerte(base, log),
    horloge: () => SOIR,
    pause: () => Promise.resolve(),
    log,
  };
  return { compteRendu: await passage(ports, CONFIG, SOIR), logs };
}

describe('CV16 — le DRY_RUN lit, calcule, journalise, et n’ecrit rien', () => {
  it('va au bout d’un convoyage sans ordre, sans move_funds, sans ligne en base', async () => {
    const coinbase = doubleCoinbase('250');
    const base = doubleBase();
    const { compteRendu, logs } = await passerInerte(coinbase, base);

    expect(new Set(coinbase.appels)).toEqual(new Set(['keyPermissions', 'balances']));
    expect(coinbase.ordresCrees).toEqual([]);
    expect(coinbase.transferts).toEqual([]);
    expect(coinbase.eur.toFixed()).toBe('250');
    expect(base.journal).toEqual([]);
    expect(base.apports).toEqual([]);

    const cid = clientOrderIdConvoyage('2026-10-27');
    expect(logs).toContain(
      `coinbase inerte : ordre retenu, non place — BUY USDC-EUR au marche de 100 EUR, client_order_id=${cid}`,
    );
    expect(logs).toContain(`coinbase inerte : move_funds retenu, non appele — 100 USDC de ${PRIMARY} vers ${UBAC_AGENT}`);
    for (const etape of ['ACHAT_DEMANDE', 'ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE', 'ENREGISTRE']) {
      expect(logs).toContain(`base inerte : etape ${etape} du convoyage 2026-10-27 non ecrite`);
    }
    expect(logs).toContain('base inerte : apport de 100 USDC du convoyage 2026-10-27 non ecrit dans cash_flows');
    expect(logs.some((l) => l.includes('RECORDED'))).toBe(false);

    expect(compteRendu).toMatchObject({ nature: 'CONVOYAGE', etape: 'ENREGISTRE', motif: undefined });
    expect(compteRendu?.eurLaisse?.toFixed()).toBe('150');
    expect(notification(compteRendu!, 'DRY_RUN').titre).toBe('convoyeur DRY_RUN — convoyage');
    expect(notification(compteRendu!, 'DRY_RUN').priorite).toBe('HIGH');
  });

  it('sous le seuil, ne retient rien et ne rend aucun compte', async () => {
    const coinbase = doubleCoinbase('99.99');
    const { compteRendu, logs } = await passerInerte(coinbase, doubleBase());
    expect(compteRendu).toBeUndefined();
    expect(logs.filter((l) => l.includes('inerte'))).toEqual([]);
  });

  it('relit pour de vrai un ordre que l’exchange connait', async () => {
    const coinbase = doubleCoinbase('250');
    const inerte = coinbaseInerte(coinbase, () => undefined);
    expect(await inerte.order('ex-inconnu')).toMatchObject({ kind: 'INDETERMINABLE' });
    expect(coinbase.appels).toEqual(['order']);
    const { exchangeId } = await inerte.marketBuy('cid');
    expect(exchangeId).toBe(`${ORDRE_NON_PLACE}cid`);
    // Rejoue sous le meme identifiant : un seul achat retenu, comme S5.
    await inerte.marketBuy('cid');
    expect((await inerte.balances()).eur.available.toFixed()).toBe('150');
  });
});

// Le mode reel est sonde par `passage.test.ts` (« CV1 : une cle refusee arrete avant tout solde »).
describe('CV1 clos — en DRY_RUN aussi, une cle refusee arrete avant toute lecture de solde', () => {
  it('refuse can_transfer false sans lire les soldes', async () => {
    const coinbase = doubleCoinbase('250');
    coinbase.cle = { ...coinbase.cle, canTransfer: false };
    const { compteRendu } = await passerInerte(coinbase, doubleBase());
    expect(compteRendu?.nature).toBe('REFUS');
    expect(coinbase.appels).toEqual(['keyPermissions']);
  });
});

describe('DC10 — en DRY_RUN, la poussiere du 2026-10-03 n’arrete pas le convoyage dit', () => {
  it('convoie 100 USDC fictifs, laisse la poussiere, et la dit', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.usdcPrimary = new Decimal('0.0000008962268961');
    const { compteRendu, logs } = await passerInerte(coinbase, doubleBase());
    expect(compteRendu).toMatchObject({ nature: 'CONVOYAGE', etape: 'ENREGISTRE' });
    expect(logs).toContain(`coinbase inerte : move_funds retenu, non appele — 100 USDC de ${PRIMARY} vers ${UBAC_AGENT}`);
    expect(notification(compteRendu!, 'DRY_RUN').corps).toContain('poussiere ignoree dans Primary : 0.0000008962268961 USDC');
    expect(coinbase.transferts).toEqual([]);
  });
});
