import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { CoinbaseFrontierError, openCoinbaseExecution } from '../../src/adapters/coinbase.js';
import type { CoinbaseWriteRoute } from '../../src/adapters/coinbase.js';
import type { DecisionToRecord, SnapshotToRecord, UbacDatabase } from '../../src/adapters/db.js';
import type { RunPulse } from '../../src/adapters/healthcheck.js';
import {
  AUCUN_ECHANGE_HTTP,
  baseSansEcriture,
  DECISION_NON_ECRITE,
  executionJournalisee,
  healthcheckInerte,
  mailerInerte,
  notifierInerte,
  ORDRE_NON_PLACE,
} from '../../src/adapters/inertes.js';
import { alertKey } from '../../src/adapters/notifier.js';
import type { Alert } from '../../src/adapters/notifier.js';
import type { Order, Price, Quantity } from '../../src/core/types.js';

/**
 * Les ports inertes, un par un. Le run complet en `DRY_RUN` — ce qu'aucun
 * d'eux n'ecrit ni n'envoie, compte par une sonde — est dans
 * `test/jobs/daily.test.ts` ; ici, ce que chacun **rend** : une reponse
 * nominale, jamais degradee, et une ligne qui dit ce qui a ete retenu.
 */

const ORDRE: Order = {
  clientOrderId: 'ubac-0123456789abcdef0123456789ab',
  asset: 'BTC',
  quote: 'USDC',
  side: 'SELL',
  quantity: new Decimal('0.14') as Quantity,
  limitPrice: new Decimal('50000.5') as Price,
};

/** Une base qui compte ses appels, et rend pour chaque lecture une valeur a elle. */
function baseComptee(): { readonly db: UbacDatabase; readonly appels: string[] } {
  const appels: string[] = [];
  const vu = <T>(nom: string, valeur: T): Promise<T> => {
    appels.push(nom);
    return Promise.resolve(valeur);
  };
  const db: UbacDatabase = {
    recordDecision: () => vu('recordDecision', { status: 'RECORDED', id: 'reelle' }),
    recordSnapshot: () => vu('recordSnapshot', undefined),
    latestSnapshot: () => vu('latestSnapshot', undefined),
    snapshotSeries: () => vu('snapshotSeries', []),
    recentCashFlows: () => vu('recentCashFlows', []),
    pendingOrders: () => vu('pendingOrders', []),
    close: () => vu('close', undefined),
  };
  return { db, appels };
}

describe('la base inerte : les lectures passent, les ecritures se retiennent', () => {
  /*
   * L'enumeration est le garde-fou : une operation ajoutee a `UbacDatabase` —
   * `recordOrder` en S7 — doit etre classee ici, lecture ou ecriture, et la
   * liste des ecritures retenues ne s'allonge pas sans que ce test le dise.
   */
  it('chaque methode est appelee : seules les deux ecritures n’atteignent pas la vraie base', async () => {
    const { db, appels } = baseComptee();
    const inerte = baseSansEcriture(db, () => undefined);
    const methodes = Object.keys(inerte).sort();

    for (const nom of methodes) {
      await (inerte[nom as keyof UbacDatabase] as (x?: unknown) => Promise<unknown>)({
        intent: { strategy: 'rebalance', runDate: '2026-09-12' },
        isShadow: false,
        runDate: '2026-09-12',
      });
    }

    expect(methodes).toEqual(Object.keys(db).sort());
    expect(methodes.filter((nom) => !appels.includes(nom))).toEqual(['recordDecision', 'recordSnapshot']);
  });

  it('rend RECORDED avec l’UUID nul, et dit ce qu’elle n’a pas ecrit', async () => {
    const lignes: string[] = [];
    const inerte = baseSansEcriture(baseComptee().db, (l) => lignes.push(l));

    const rendu = await inerte.recordDecision({
      intent: { strategy: 'rebalance_ab', runDate: '2026-09-12' },
      isShadow: true,
    } as DecisionToRecord);
    await inerte.recordSnapshot({ runDate: '2026-09-12' } as SnapshotToRecord);

    expect(rendu).toEqual({ status: 'RECORDED', id: DECISION_NON_ECRITE });
    expect(lignes).toEqual([
      'base inerte : decision rebalance_ab (shadow) du 2026-09-12 non ecrite',
      'base inerte : photo du 2026-09-12 non ecrite',
    ]);
  });
});

describe('le port journalisant : ce qui serait parti, et rien d’autre (E14)', () => {
  /*
   * Le journal est confronte au corps que l'executeur **reel** enverrait pour le
   * meme ordre, capture sur un transport double : les six champs sont les siens,
   * pas une reconstitution.
   */
  it('journalise les six champs du corps que l’executeur reel enverrait', async () => {
    const ecrit: CoinbaseWriteRoute[] = [];
    const reel = await openCoinbaseExecution(
      {
        write: (route) => {
          ecrit.push(route);
          return Promise.resolve({ success: true, success_response: { order_id: 'x', client_order_id: ORDRE.clientOrderId } });
        },
      },
      { keyPermissions: () => Promise.resolve({ canView: true, canTrade: true, portfolioUuid: 'p' }) },
    );
    await reel.placeOrder(ORDRE);
    const route = ecrit[0];
    if (route?.kind !== 'create_order') throw new Error('aucun placement capture');
    const { client_order_id, product_id, side, order_configuration } = route.body;
    const { base_size, limit_price, post_only } = order_configuration.limit_limit_gtc;

    const lignes: string[] = [];
    const place = await executionJournalisee((l) => lignes.push(l)).placeOrder(ORDRE);

    expect(lignes).toEqual([
      `ordre non place (port journalisant) : client_order_id=${client_order_id} paire=${product_id} cote=${side} quantite=${base_size} prix_limite=${limit_price} post_only=${String(post_only)}`,
    ]);
    expect(lignes[0]).toContain('paire=BTC-USDC cote=SELL quantite=0.14 prix_limite=50000.5 post_only=true');
    expect(place).toEqual({ exchangeId: `${ORDRE_NON_PLACE}${ORDRE.clientOrderId}`, clientOrderId: ORDRE.clientOrderId });
  });

  it('refuse l’ordre que l’executeur reel refuserait de formuler', async () => {
    const nul = { ...ORDRE, quantity: new Decimal('0') as Quantity };

    await expect(executionJournalisee(() => undefined).placeOrder(nul)).rejects.toThrow(CoinbaseFrontierError);
  });

  it('annule ordre par ordre, et une liste vide ne journalise rien', async () => {
    const lignes: string[] = [];
    const port = executionJournalisee((l) => lignes.push(l));

    expect(await port.cancelOrders([])).toEqual([]);
    expect(lignes).toEqual([]);
    expect(await port.cancelOrders(['a', 'b'])).toEqual([
      { kind: 'CANCELLED', exchangeId: 'a' },
      { kind: 'CANCELLED', exchangeId: 'b' },
    ]);
    expect(lignes).toHaveLength(2);
  });
});

describe('les trois envois du §9, retenus avec une reponse nominale (D10)', () => {
  it('ntfy, Brevo et le ping rendent SENT, SENT et PINGED, chacun avec sa ligne', async () => {
    const lignes: string[] = [];
    const log = (l: string): number => lignes.push(l);
    const alerte: Alert = {
      event: 'RECONCILIATION_DRIFT',
      priority: 'URGENT',
      runDate: '2026-09-12',
      title: 'ecart de reconciliation',
      body: 'corps',
    };
    const pulse = (kind: 'CONCLU' | 'ABANDONNE'): RunPulse =>
      kind === 'CONCLU'
        ? { runDate: '2026-09-12', gitSha: 'sha', ending: { kind, decisions: 4, alerts: 1 } }
        : { runDate: '2026-09-12', gitSha: 'sha', ending: { kind, step: 'VALUATION', code: 'X' } };

    expect(await notifierInerte(log).notify(alerte)).toEqual({
      status: 'SENT',
      event: 'RECONCILIATION_DRIFT',
      key: alertKey(alerte),
    });
    expect(await mailerInerte(log).sendReport({ subject: 'ubac 2026-09-12', html: '', tags: [] })).toEqual({
      status: 'SENT',
      httpStatus: AUCUN_ECHANGE_HTTP,
    });
    expect(await healthcheckInerte(log).ping(pulse('CONCLU'))).toEqual({ status: 'PINGED', marked: true });
    expect(await healthcheckInerte(log).ping(pulse('ABANDONNE'))).toEqual({ status: 'PINGED', marked: false });
    expect(lignes).toEqual([
      'ntfy inerte : alerte RECONCILIATION_DRIFT retenue, non envoyee — ecart de reconciliation',
      'brevo inerte : rapport retenu, non envoye — ubac 2026-09-12',
      'healthcheck inerte : ping retenu, non envoye (CONCLU)',
      'healthcheck inerte : ping retenu, non envoye (ABANDONNE)',
    ]);
  });
});
