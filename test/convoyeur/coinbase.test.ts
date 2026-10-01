import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ccxt from 'ccxt';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  ccxtConvoyeurTransport,
  CONVOYEUR_METHODS,
  CONVOYEUR_ROUTES,
  ConvoyeurFrontierError,
  marketBuyBody,
  openConvoyeurCoinbase,
} from '../../src/convoyeur/coinbase.js';
import type { ConvoyeurCoinbase, ConvoyeurRoute, MarketBuyBody } from '../../src/convoyeur/coinbase.js';

/**
 * Aucun reseau, aucune cle. Toutes les reponses sont **fabriquees** (T2) : la
 * cle du convoyeur n'existe pas encore. Chaque fichier de `fixtures/` le declare
 * par `_fabrique`, exige au chargement, et se remplace par une capture apres le
 * premier convoyage reel (OP6).
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function fabriquee(nom: string): Promise<Record<string, unknown>> {
  const lue = JSON.parse(await readFile(resolve(FIXTURES, `${nom}.json`), 'utf8')) as Record<string, unknown>;
  if (!String(lue['_fabrique']).startsWith('FABRIQUEE, PAS CAPTUREE')) throw new Error(`${nom} non declaree.`);
  // Le marqueur n'est pas un champ de l'API : `key_permissions` refuserait un champ inconnu.
  const { _fabrique, ...reponse } = lue;
  return reponse;
}

const PRIMARY = '00000000-0000-4000-8000-0000000000a1';
const UBAC_AGENT = '00000000-0000-4000-8000-0000000000a2';
const ORDRE = '00000000-0000-4000-8000-0000000000b1';
const CLIENT = 'convoyeur-2026-11-27';
const SECRET = Buffer.alloc(64, 7).toString('base64');
const USDC = new Decimal('115.387204');

const CLE = await fabriquee('key-permissions');
const COMPTES = await fabriquee('accounts');
const CREE = await fabriquee('create-order');
const REMPLI = await fabriquee('order-filled');
const TRANSFERE = await fabriquee('move-funds');
const RESUME = await fabriquee('transaction-summary');

function ordre(overrides: Record<string, unknown>): Record<string, unknown> {
  const [brut] = REMPLI['orders'] as Record<string, unknown>[];
  return { ...REMPLI, orders: [{ ...brut, ...overrides }] };
}

function compte(currency: string, portefeuille = PRIMARY, value: unknown = '1'): Record<string, unknown> {
  return { currency, available_balance: { value }, hold: { value: '0' }, retail_portfolio_id: portefeuille };
}

type Reponses = Partial<Record<ConvoyeurRoute['kind'], unknown>>;

/** Journalise les routes demandees : la preuve de ce que le module appelle. */
function ouvrir(reponses: Reponses = {}, journal: string[] = []) {
  const routes: ConvoyeurRoute[] = [];
  const files = new Map<string, unknown[]>();
  for (const [kind, valeur] of Object.entries({ key_permissions: CLE, ...reponses })) {
    files.set(kind, Array.isArray(valeur) ? [...(valeur as unknown[])] : [valeur]);
  }
  const convoyeur = openConvoyeurCoinbase(
    {
      async call(route) {
        routes.push(route);
        const file = files.get(route.kind) ?? [];
        if (file.length === 0) throw new Error(`aucune reponse pour ${route.kind}`);
        return file.length === 1 ? file[0] : file.shift();
      },
      async close() {},
    },
    { primaryUuid: PRIMARY, destinationUuid: UBAC_AGENT, log: (ligne) => journal.push(ligne) },
  );
  return { convoyeur, routes, kinds: () => routes.map((route) => route.kind) };
}

type MemeEnsemble<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const routesEnumerees: MemeEnsemble<ConvoyeurRoute['kind'], (typeof CONVOYEUR_ROUTES)[number]> = true;
const methodesEnumerees: MemeEnsemble<keyof ConvoyeurCoinbase, (typeof CONVOYEUR_METHODS)[number]> = true;

describe('CV4 — la surface du transport, enumeree', () => {
  it('a six routes et sept methodes, ecrites ici en toutes lettres', () => {
    expect([...CONVOYEUR_ROUTES]).toEqual([
      'key_permissions',
      'accounts',
      'create_market_buy',
      'order',
      'move_funds',
      'transaction_summary',
    ]);
    expect([routesEnumerees, methodesEnumerees]).toEqual([true, true]);
    expect(Object.keys(ccxtConvoyeurTransport({ apiKey: PRIMARY, apiSecret: SECRET })).sort()).toEqual([
      'call',
      'close',
    ]);
    expect(Object.keys(ouvrir().convoyeur).sort()).toEqual(
      ['balances', 'close', 'feeTier', 'keyPermissions', 'marketBuy', 'moveFunds', 'order'],
    );
  });

  it('emet exactement les six routes sur un convoyage complet, la cle lue une fois', async () => {
    const { convoyeur, kinds } = ouvrir({
      accounts: COMPTES,
      create_market_buy: CREE,
      order: REMPLI,
      move_funds: TRANSFERE,
      transaction_summary: RESUME,
    });
    await convoyeur.balances();
    await convoyeur.marketBuy(CLIENT);
    await convoyeur.order(ORDRE);
    await convoyeur.moveFunds({ source: PRIMARY, destination: UBAC_AGENT, usdc: USDC });
    await convoyeur.feeTier();
    expect(kinds()).toEqual([...CONVOYEUR_ROUTES]);
  });

  it('appelle chaque route en v3, jamais en v2, corps en JSON', async () => {
    const corps = marketBuyBody(CLIENT);
    const transfert = {
      funds: { value: '1.5', currency: 'USDC' as const },
      source_portfolio_uuid: PRIMARY,
      target_portfolio_uuid: UBAC_AGENT,
    };
    const prototype = ccxt.coinbase.prototype as unknown as Record<string, unknown>;
    const original = prototype['fetch'];
    const vues: unknown[][] = [];
    prototype['fetch'] = (url: string, methode: string, _entetes: unknown, brut?: string) => {
      vues.push([url, methode, brut === undefined ? undefined : JSON.parse(brut)]);
      return Promise.resolve({});
    };
    try {
      const transport = ccxtConvoyeurTransport({ apiKey: PRIMARY, apiSecret: SECRET });
      await transport.call({ kind: 'key_permissions' });
      await transport.call({ kind: 'accounts', cursor: 'p2' });
      await transport.call({ kind: 'create_market_buy', body: corps });
      await transport.call({ kind: 'order', exchangeId: ORDRE });
      await transport.call({ kind: 'move_funds', body: transfert });
      await transport.call({ kind: 'transaction_summary' });
      await transport.close();
    } finally {
      prototype['fetch'] = original;
    }
    const v3 = 'https://api.coinbase.com/api/v3/brokerage';
    expect(vues).toEqual([
      [`${v3}/key_permissions`, 'GET', undefined],
      [`${v3}/accounts?limit=250&cursor=p2`, 'GET', undefined],
      [`${v3}/orders`, 'POST', corps],
      [`${v3}/orders/historical/batch?order_ids=${ORDRE}`, 'GET', undefined],
      [`${v3}/portfolios/move_funds`, 'POST', transfert],
      [`${v3}/transaction_summary?product_type=SPOT`, 'GET', undefined],
    ]);
  });
});

describe('CV1, moitie adapter — la cle se lit, puis se verifie avant toute action', () => {
  it('lit la cle sans verdict et la journalise', async () => {
    const journal: string[] = [];
    const { convoyeur } = ouvrir({ key_permissions: { ...CLE, portfolio_type: 'CONSUMER' } }, journal);
    expect(await convoyeur.keyPermissions()).toEqual({
      portfolioUuid: PRIMARY,
      portfolioType: 'CONSUMER',
      canView: true,
      canTrade: true,
      canTransfer: true,
    });
    expect(journal).toEqual([
      `cle convoyeur — portefeuille=${PRIMARY} type=CONSUMER can_view=true can_trade=true can_transfer=true`,
    ]);
  });

  it.each([
    ['un autre portefeuille, a un caractere pres', { portfolio_uuid: PRIMARY.replace(/1$/, '2') }, /Primary attendu/],
    ['un portfolio_type autre que DEFAULT', { portfolio_type: 'CONSUMER' }, /portfolio_type CONSUMER/],
    ['can_transfer a false', { can_transfer: false }, /can_transfer false/],
    ['can_trade a false', { can_trade: false }, /can_trade false/],
    ['can_view a false', { can_view: false }, /can_view false/],
  ])('refuse %s, et n’appelle rien d’autre', async (_cas, surcharge, motif) => {
    const { convoyeur, kinds } = ouvrir({ key_permissions: { ...CLE, ...surcharge }, accounts: COMPTES });
    await expect(convoyeur.balances()).rejects.toThrow(motif);
    await expect(convoyeur.marketBuy(CLIENT)).rejects.toThrow(motif);
    await expect(convoyeur.order(ORDRE)).rejects.toThrow(motif);
    await expect(convoyeur.feeTier()).rejects.toThrow(motif);
    expect(kinds()).toEqual(['key_permissions']);
  });

  it.each([
    ['can_transfer absent', { can_transfer: undefined }],
    ['can_transfer en chaine "true"', { can_transfer: 'true' }],
    ['portfolio_type absent', { portfolio_type: undefined }],
    ['une permission inconnue accordee', { can_withdraw: true }],
  ])('refuse une reponse ou %s', async (_cas, surcharge) => {
    const { convoyeur } = ouvrir({ key_permissions: JSON.parse(JSON.stringify({ ...CLE, ...surcharge })) });
    await expect(convoyeur.keyPermissions()).rejects.toThrow(ConvoyeurFrontierError);
  });

  it.each([
    ['Primary en majuscules', { primaryUuid: PRIMARY.toUpperCase() }],
    ['une destination vide', { destinationUuid: '' }],
    ['une destination egale a Primary', { destinationUuid: PRIMARY }],
  ])('ne se construit pas avec %s', (_cas, surcharge) => {
    const transport = { call: () => Promise.resolve({}), close: () => Promise.resolve() };
    const attendu = { primaryUuid: PRIMARY, destinationUuid: UBAC_AGENT, log: () => undefined, ...surcharge };
    expect(() => openConvoyeurCoinbase(transport, attendu)).toThrow(ConvoyeurFrontierError);
  });
});

describe('soldes de Primary', () => {
  it('lit available et hold en Decimal ; un compte absent vaut zero', async () => {
    const { eur, usdc } = await ouvrir({ accounts: COMPTES }).convoyeur.balances();
    expect([eur.available, eur.hold, usdc.available].map((d) => d.toFixed())).toEqual(['250.07', '0.1', '0.2']);
    const sansUsdc = ouvrir({ accounts: { accounts: [compte('BTC')], has_next: false } });
    expect((await sansUsdc.convoyeur.balances()).usdc.available.isZero()).toBe(true);
  });

  it('suit la pagination', async () => {
    const { convoyeur, routes } = ouvrir({
      accounts: [
        { accounts: [compte('EUR', PRIMARY, '100')], has_next: true, cursor: 'p2' },
        { accounts: [compte('USDC', PRIMARY, '3')], has_next: false, cursor: '' },
      ],
    });
    expect((await convoyeur.balances()).usdc.available.toFixed()).toBe('3');
    expect(routes.slice(1)).toEqual([{ kind: 'accounts' }, { kind: 'accounts', cursor: 'p2' }]);
  });

  it.each([
    ['un compte d’un autre portefeuille', [compte('EUR'), compte('BTC', UBAC_AGENT)], /rattache au portefeuille/],
    ['deux comptes EUR', [compte('EUR'), compte('EUR')], /2 comptes EUR/],
    ['un solde en number', [compte('EUR', PRIMARY, 100)], /chaine attendue/],
  ])('refuse %s, sans filtrer', async (_cas, accounts, motif) => {
    await expect(ouvrir({ accounts: { accounts, has_next: false } }).convoyeur.balances()).rejects.toThrow(motif);
  });
});

describe('CV6, moitie corps — le market BUY USDC-EUR de 100 EUR', () => {
  it('envoie exactement ce corps, le montant n’etant pas un parametre', async () => {
    const { convoyeur, routes } = ouvrir({ create_market_buy: CREE });
    expect(await convoyeur.marketBuy(CLIENT)).toEqual({ exchangeId: ORDRE });
    expect(routes[1]).toEqual({
      kind: 'create_market_buy',
      body: {
        client_order_id: CLIENT,
        product_id: 'USDC-EUR',
        side: 'BUY',
        order_configuration: { market_market_ioc: { quote_size: '100' } },
      },
    });
    // @ts-expect-error — un autre montant ne compile pas.
    const deuxCents: MarketBuyBody['order_configuration']['market_market_ioc'] = { quote_size: '200' };
    expect(deuxCents).toBeDefined();
  });

  it('lit un client_order_id rejoue (S5) comme l’ordre existant, pas comme un refus', async () => {
    const { convoyeur } = ouvrir({ create_market_buy: [CREE, CREE] });
    expect([await convoyeur.marketBuy(CLIENT), await convoyeur.marketBuy(CLIENT)]).toEqual([
      { exchangeId: ORDRE },
      { exchangeId: ORDRE },
    ]);
  });

  it('arrete sur un refus, sur une reponse pour un autre identifiant, et sur un identifiant vide', async () => {
    const refus = { success: false, error_response: { error: 'INSUFFICIENT_FUND' } };
    await expect(ouvrir({ create_market_buy: refus }).convoyeur.marketBuy(CLIENT)).rejects.toThrow(/INSUFFICIENT_FUND/);
    const autre = { ...CREE, success_response: { order_id: ORDRE, client_order_id: 'autre' } };
    await expect(ouvrir({ create_market_buy: autre }).convoyeur.marketBuy(CLIENT)).rejects.toThrow(/pour autre/);
    const { convoyeur, routes } = ouvrir({ create_market_buy: CREE });
    await expect(convoyeur.marketBuy('')).rejects.toThrow(ConvoyeurFrontierError);
    expect(routes).toEqual([]);
  });
});

describe('lecture de l’ordre du convoyeur (S6)', () => {
  it('rend l’USDC recu, l’EUR debite et les frais en Decimal exacts', async () => {
    const lu = await ouvrir({ order: REMPLI }).convoyeur.order(ORDRE);
    if (lu.kind !== 'FILLED') throw new Error(`FILLED attendu, recu ${lu.kind}`);
    expect([lu.filledSize, lu.filledValue, lu.totalFees].map((d) => d.toFixed())).toEqual(['115.387204', '99.4', '0.6']);
    expect([lu.filledValue.add(lu.totalFees).eq(100), lu.clientOrderId]).toEqual([true, CLIENT]);
  });

  it('dit INDETERMINABLE d’un ordre inconnu ou d’un statut non interprete', async () => {
    expect((await ouvrir({ order: { orders: [] } }).convoyeur.order(ORDRE)).kind).toBe('INDETERMINABLE');
    const inconnu = ordre({ status: 'UNKNOWN_ORDER_STATUS' });
    expect((await ouvrir({ order: inconnu }).convoyeur.order(ORDRE)).kind).toBe('INDETERMINABLE');
  });

  it.each([
    ['un autre produit', { product_id: 'ETH-USDC' }],
    ['une vente', { side: 'SELL' }],
    ['un autre montant', { order_configuration: { market_market_ioc: { quote_size: '200' } } }],
    ['un ordre limite', { order_configuration: { limit_limit_gtc: { base_size: '1', limit_price: '1' } } }],
    ['un autre identifiant', { order_id: 'autre' }],
  ])('refuse %s : ce n’est pas l’achat du convoyeur', async (_cas, surcharge) => {
    await expect(ouvrir({ order: ordre(surcharge) }).convoyeur.order(ORDRE)).rejects.toThrow(ConvoyeurFrontierError);
  });
});

describe('CV2 — move_funds, de Primary vers ubac-agent et nulle part ailleurs', () => {
  it('demande le transfert et rend « demande », jamais « fait »', async () => {
    const { convoyeur, routes } = ouvrir({ move_funds: TRANSFERE });
    const issue = await convoyeur.moveFunds({ source: PRIMARY, destination: UBAC_AGENT, usdc: USDC });
    expect([issue.kind, issue.usdc.toFixed()]).toEqual(['DEMANDE', '115.387204']);
    expect(routes[1]).toEqual({
      kind: 'move_funds',
      body: {
        funds: { value: '115.387204', currency: 'USDC' },
        source_portfolio_uuid: PRIMARY,
        target_portfolio_uuid: UBAC_AGENT,
      },
    });
  });

  it.each([
    ['une destination alteree d’un caractere', { destination: UBAC_AGENT.replace(/2$/, '3') }, /destination/],
    ['une destination prefixe de la bonne', { destination: UBAC_AGENT.slice(0, -1) }, /destination/],
    ['une destination en majuscules', { destination: UBAC_AGENT.toUpperCase() }, /destination/],
    ['la destination prise pour source', { source: UBAC_AGENT }, /source/],
    ['une source alteree d’un caractere', { source: PRIMARY.replace(/1$/, '0') }, /source/],
    ['un montant nul', { usdc: new Decimal(0) }, /montant/],
    ['un montant negatif', { usdc: new Decimal('-1') }, /montant/],
  ])('refuse %s avant tout appel, cle comprise', async (_cas, surcharge, motif) => {
    const { convoyeur, routes } = ouvrir({ move_funds: TRANSFERE });
    await expect(
      convoyeur.moveFunds({ source: PRIMARY, destination: UBAC_AGENT, usdc: USDC, ...surcharge }),
    ).rejects.toThrow(motif);
    expect(routes).toEqual([]);
  });

  it('ne transfere pas avec une cle refusee, ni ne croit une reponse pour d’autres portefeuilles', async () => {
    const demande = { source: PRIMARY, destination: UBAC_AGENT, usdc: USDC };
    const refusee = ouvrir({ key_permissions: { ...CLE, can_transfer: false }, move_funds: TRANSFERE });
    await expect(refusee.convoyeur.moveFunds(demande)).rejects.toThrow(/can_transfer false/);
    expect(refusee.kinds()).toEqual(['key_permissions']);
    const ailleurs = ouvrir({ move_funds: { ...TRANSFERE, target_portfolio_uuid: PRIMARY } });
    await expect(ailleurs.convoyeur.moveFunds(demande)).rejects.toThrow(/pas les portefeuilles demandes/);
  });
});

describe('palier de frais (U2)', () => {
  it('lit les taux en Decimal, et refuse un taux en number', async () => {
    const palier = await ouvrir({ transaction_summary: RESUME }).convoyeur.feeTier();
    expect([palier.pricingTier, palier.makerFeeRate.toFixed(), palier.takerFeeRate.toFixed()]).toEqual([
      'Advanced 1',
      '0.004',
      '0.006',
    ]);
    const enNombre = { fee_tier: { pricing_tier: 'x', maker_fee_rate: 0.004, taker_fee_rate: '0.006' } };
    await expect(ouvrir({ transaction_summary: enNombre }).convoyeur.feeTier()).rejects.toThrow(/chaine attendue/);
  });
});
