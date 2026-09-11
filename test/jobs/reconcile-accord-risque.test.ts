import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import { validate } from '../../src/core/risk.js';
import type { Balance, RiskContext } from '../../src/core/risk.js';
import type { Intent, Price, UsdcAmount, Weight, Weights } from '../../src/core/types.js';
import { reconcile } from '../../src/jobs/reconcile.js';
import { harnais, photo, qty, solde } from './doubles.js';

/**
 * **Les deux definitions de « divergence de 1 % » doivent rendre le meme
 * verdict.**
 *
 * `src/core/risk.ts` porte la sienne depuis la phase 0 : `relativeDrift` sur
 * `RiskContext.balances`, seuil strict, ligne a ligne. Elle est couverte a
 * 100 % et la phase 1 n'a pas le droit d'y toucher — ni de l'importer, puisque
 * la fonction n'est pas exportee. `src/jobs/reconcile.ts` en recopie donc le
 * calcul, et une copie derive.
 *
 * Ce fichier est ce qui interdit la derive. Sur la meme table de cas, il exige
 * que le job abandonne exactement quand la couche risque emet
 * `RECONCILIATION_DRIFT`. Changer le seuil, le denominateur ou le sens de la
 * comparaison d'un seul cote fait echouer ce test — c'est le seul garde-fou qui
 * mord sur la copie plutot que sur l'original.
 */

const PRIX: Prices = {
  BTC: new Decimal('60000') as Price,
  ETH: new Decimal('3000') as Price,
};

const POIDS: Weights = {
  BTC: new Decimal('0.4') as Weight,
  ETH: new Decimal('0.4') as Weight,
  USDC: new Decimal('0.2') as Weight,
};

/** Intention vide : le §7 s'applique avant toute jambe, et une jambe brouillerait le verdict. */
const INTENTION: Intent = {
  runDate: '2026-09-11',
  strategy: 'rebalance',
  trigger: 'NONE',
  reason: 'aucune bande franchie',
  weightsBefore: POIDS,
  weightsTarget: POIDS,
  legs: [],
};

interface Cas {
  readonly nom: string;
  readonly exchange: readonly [string, string, string];
  readonly interne: readonly [string, string, string];
}

/**
 * Les trois nombres sont BTC, ETH, USDC. Les cas encadrent le seuil au
 * centieme de point pres, des deux cotes, sur chacune des trois lignes.
 */
const CAS: readonly Cas[] = [
  { nom: 'etats identiques', exchange: ['1', '20', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'BTC a 1 % pile', exchange: ['0.99', '20', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'BTC a 1,01 %', exchange: ['0.9899', '20', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'ETH a 1 % pile', exchange: ['1', '19.8', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'ETH a 1,01 %', exchange: ['1', '19.798', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'USDC a 1 % pile', exchange: ['1', '20', '9900'], interne: ['1', '20', '10000'] },
  { nom: 'USDC a 1,01 %', exchange: ['1', '20', '9899'], interne: ['1', '20', '10000'] },
  { nom: 'exchange au-dessus du cache', exchange: ['1.02', '20', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'divergence compensee', exchange: ['1.02', '19.6', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'ligne disparue', exchange: ['0', '20', '10000'], interne: ['1', '20', '10000'] },
  { nom: 'portefeuille vide des deux cotes', exchange: ['0', '0', '0'], interne: ['0', '0', '0'] },
];

function holdings([btc, eth, usdc]: readonly [string, string, string]): Holdings {
  return { BTC: qty(btc), ETH: qty(eth), USDC: qty(usdc) };
}

function balances(cas: Cas): readonly Balance[] {
  const reel = holdings(cas.exchange);
  const cache = holdings(cas.interne);
  return [
    { asset: 'BTC', onExchange: reel.BTC, internal: cache.BTC },
    { asset: 'ETH', onExchange: reel.ETH, internal: cache.ETH },
    {
      asset: 'USDC',
      onExchange: reel.USDC as Decimal as UsdcAmount,
      internal: cache.USDC as Decimal as UsdcAmount,
    },
  ];
}

/** Le noyau rejette-t-il pour divergence ? Les autres motifs ne concernent pas ce test. */
function noyauRejetteLaDivergence(cas: Cas): boolean {
  const context: RiskContext = {
    makeClientOrderId: () => 'inutilise-sans-jambe',
    mids: PRIX,
    lastCompleteRebalanceOn: null,
    balances: balances(cas),
    holdings: holdings(cas.exchange),
    prices: PRIX,
  };
  const verdict = validate(INTENTION, context);
  return (
    verdict.status === 'REJECTED' &&
    verdict.rejections.some((rejet) => rejet.code === 'RECONCILIATION_DRIFT')
  );
}

async function jobAbandonne(cas: Cas): Promise<boolean> {
  const [btc, eth, usdc] = cas.interne;
  const result = await reconcile(
    harnais({
      balances: [
        solde('BTC', cas.exchange[0]),
        solde('ETH', cas.exchange[1]),
        solde('USDC', cas.exchange[2]),
      ],
      snapshot: photo({ BTC: qty(btc), ETH: qty(eth), USDC: qty(usdc) }),
    }).input,
  );
  return result.status === 'ABORTED';
}

describe('le job et la couche risque appliquent le meme seuil', () => {
  it.each(CAS)('$nom', async (cas) => {
    const attendu = noyauRejetteLaDivergence(cas);
    expect(await jobAbandonne(cas)).toBe(attendu);
  });

  it('la table couvre bien les deux verdicts', () => {
    const verdicts = CAS.map(noyauRejetteLaDivergence);
    // Sans ce controle, une table entierement d'un cote rendrait l'accord trivial.
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});
