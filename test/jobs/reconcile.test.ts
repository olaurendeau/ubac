import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { RECONCILIATION_DRIFT_PCT } from '../../src/core/risk.js';
import type { Price } from '../../src/core/types.js';
import { reconcile } from '../../src/jobs/reconcile.js';
import type { ReconcileResult } from '../../src/jobs/reconcile.js';
import { harnais, ordreEnAttente, ordreOuvert, photo, qty, solde } from './doubles.js';

/**
 * La reconciliation de la spec §7. Aucun de ces tests ne touche le reseau, la
 * base ni une cle : tout passe par les doubles de `./doubles.ts`.
 *
 * Les valeurs sont choisies pour **distinguer** l'implementation attendue d'une
 * implementation fausse plausible, pas seulement pour passer : un seuil est
 * teste de ses deux cotes, et la divergence compensee ci-dessous echoue sur
 * toute implementation qui comparerait la valeur totale.
 */

async function lance(scenario: Parameters<typeof harnais>[0]): Promise<ReconcileResult> {
  return reconcile(harnais(scenario).input);
}

function reconcilie(result: ReconcileResult): Extract<ReconcileResult, { status: 'RECONCILED' }> {
  if (result.status !== 'RECONCILED') {
    throw new Error(`reconciliation attendue, recu ABORTED : ${result.reason}`);
  }
  return result;
}

function abandonne(result: ReconcileResult): Extract<ReconcileResult, { status: 'ABORTED' }> {
  if (result.status !== 'ABORTED') {
    throw new Error('abandon attendu, la reconciliation a accepte les soldes');
  }
  return result;
}

const SOLDES_NOMINAUX = [solde('BTC', '1'), solde('ETH', '20'), solde('USDC', '10000')];
const CACHE_NOMINAL = photo({ BTC: qty('1'), ETH: qty('20'), USDC: qty('10000') });

describe('§7 etape 1 — lire avant de comparer', () => {
  it('lit l’exchange et la base avant de rendre le moindre solde', async () => {
    const banc = harnais({ balances: SOLDES_NOMINAUX, snapshot: CACHE_NOMINAL });
    await reconcile(banc.input);
    /*
     * L'ordre est celui du §7 : les soldes reels et les ordres ouverts d'abord,
     * l'etat interne ensuite. Un run qui deciderait avant de reconcilier lirait
     * un etat perime ; ici c'est la reconciliation elle-meme qui ne peut pas
     * comparer avant d'avoir lu.
     */
    expect(banc.appels).toEqual(['balances', 'openOrders', 'pendingOrders', 'latestSnapshot']);
  });

  it('rend les soldes reels, gele compris', async () => {
    // 0.4 disponible + 0.1 gele par un ordre ouvert : les 0.5 sont detenus.
    const result = reconcilie(
      await lance({ balances: [solde('BTC', '0.4', '0.1'), solde('USDC', '10000')] }),
    );
    expect(result.balances.holdings.BTC.toString()).toBe('0.5');
    expect(result.balances.holdings.ETH.toString()).toBe('0');
    expect(result.balances.holdings.USDC.toString()).toBe('10000');
  });

  it('somme deux comptes de la meme devise au lieu d’en retenir un', async () => {
    const result = reconcilie(await lance({ balances: [solde('BTC', '0.3'), solde('BTC', '0.7')] }));
    expect(result.balances.holdings.BTC.toString()).toBe('1');
  });
});

describe('§7 etape 4 — le seuil de 1 %, des deux cotes', () => {
  /*
   * Le seuil est strict, comme dans `core/risk.ts` : `drift > 1 %` abandonne,
   * `drift = 1 %` passe. Les deux cas ci-dessous sont a un centieme de point
   * l'un de l'autre et tombent de part et d'autre de la comparaison. Inverser
   * le sens de la comparaison, ou la passer de stricte a large, casse l'un des
   * deux — aucune implementation ne peut satisfaire les deux sans le bon signe.
   */
  it('accepte une divergence de 1 % pile', async () => {
    const result = await lance({
      balances: [solde('USDC', '99')],
      snapshot: photo({ USDC: qty('100') }),
    });
    expect(result.status).toBe('RECONCILED');
  });

  it('abandonne a 1,01 %', async () => {
    const result = abandonne(
      await lance({
        balances: [solde('USDC', '98.99')],
        snapshot: photo({ USDC: qty('100') }),
      }),
    );
    expect(result.code).toBe('RECONCILIATION_DRIFT');
    expect(result.divergences).toHaveLength(1);
    const [ecart] = result.divergences;
    expect(ecart?.asset).toBe('USDC');
    expect(ecart?.onExchange.toString()).toBe('98.99');
    expect(ecart?.internal.toString()).toBe('100');
    expect(ecart?.drift.toString()).toBe('0.0101');
    expect(result.reason).toContain('98.99');
    expect(result.reason).toContain('1.0100 %');
  });

  it('ne rend aucun solde quand il abandonne', async () => {
    const result = await lance({
      balances: [solde('USDC', '50')],
      snapshot: photo({ USDC: qty('100') }),
    });
    /*
     * L'abandon n'est pas un resultat degrade dont on pourrait tirer des soldes
     * « quand meme » : la branche ABORTED ne porte pas de `balances`, donc le
     * run ne peut pas decider dessus. Le type le dit ; ce test le constate a
     * l'execution, la ou une assertion `as` l'aurait contourne.
     */
    expect('balances' in result).toBe(false);
  });

  it('abandonne sur une divergence compensee, que la valeur totale ne voit pas', async () => {
    /*
     * **Le test qui separe « ligne a ligne » de « valeur totale ».** Les deux
     * etats valent exactement la meme chose : 1,02 BTC a 60 000 plus 19,6 ETH a
     * 3 000 font 130 000, comme 1 BTC plus 20 ETH. Une implementation qui
     * comparerait la valeur totale trouverait 0 % d'ecart et laisserait passer.
     * Ligne a ligne, BTC derive de 1,96 % et ETH de 2 % : le run est abandonne.
     */
    const btc = new Decimal('60000') as Price;
    const eth = new Decimal('3000') as Price;
    const valeur = (q: string, prix: Price, autre: string, prixAutre: Price): Decimal =>
      new Decimal(q).mul(prix).add(new Decimal(autre).mul(prixAutre)).add(10000);
    expect(valeur('1.02', btc, '19.6', eth).toString()).toBe(
      valeur('1', btc, '20', eth).toString(),
    );

    const result = abandonne(
      await lance({
        balances: [solde('BTC', '1.02'), solde('ETH', '19.6'), solde('USDC', '10000')],
        snapshot: CACHE_NOMINAL,
      }),
    );
    expect(result.divergences.map((d) => d.asset)).toEqual(['BTC', 'ETH']);
  });

  it('abandonne sur une ligne que le cache porte et que l’exchange ne porte plus', async () => {
    // L'union des deux cotes : sans elle, une position disparue passe inapercue.
    const result = abandonne(
      await lance({
        balances: [solde('BTC', '1'), solde('USDC', '10000')],
        snapshot: CACHE_NOMINAL,
      }),
    );
    expect(result.divergences.map((d) => d.asset)).toEqual(['ETH']);
    expect(result.divergences[0]?.drift.toString()).toBe('1');
  });

  it('abandonne sur une ligne apparue sur l’exchange et absente du cache', async () => {
    const result = abandonne(
      await lance({
        balances: [...SOLDES_NOMINAUX, solde('SOL', '3')],
        snapshot: CACHE_NOMINAL,
      }),
    );
    expect(result.divergences.map((d) => d.asset)).toEqual(['SOL']);
  });

  it('ne voit pas de divergence sur une ligne a zero des deux cotes', async () => {
    // Le portefeuille reel porte un compte EUR a zero : capture en fixture Q3.
    const result = reconcilie(
      await lance({ balances: [...SOLDES_NOMINAUX, solde('EUR', '0')], snapshot: CACHE_NOMINAL }),
    );
    expect(result.observations.untrackedBalances).toEqual([]);
    expect(result.balances.comparedTo).toBe('INTERNAL_SNAPSHOT');
  });

  it('signale une devise hors liste blanche reellement detenue', async () => {
    const result = reconcilie(
      await lance({ balances: [...SOLDES_NOMINAUX, solde('SOL', '3')], snapshot: undefined }),
    );
    expect(result.observations.untrackedBalances.map((l) => l.currency)).toEqual(['SOL']);
  });

  it('le seuil applique est celui du noyau, pas une copie locale', () => {
    expect(RECONCILIATION_DRIFT_PCT.toString()).toBe('0.01');
  });
});

describe('premier run — il n’y a pas encore de cache a confronter', () => {
  it('reconcilie sans snapshot et le dit', async () => {
    const result = reconcilie(await lance({ balances: SOLDES_NOMINAUX, snapshot: undefined }));
    /*
     * Une absence de cache n'est pas une divergence nulle. Le resultat distingue
     * les deux : le rapport du run doit pouvoir dire qu'aucune comparaison n'a
     * eu lieu, plutot que d'afficher une reconciliation qui n'a rien reconcilie.
     */
    expect(result.balances.comparedTo).toBe('NO_INTERNAL_STATE');
    expect(result.balances.holdings.ETH.toString()).toBe('20');
  });
});

describe('§7 etape 2 — les ordres PENDING selon leur statut reel', () => {
  it('rend une liste vide quand la table est vide, ce qui est le cas de la phase 1', async () => {
    const result = reconcilie(await lance({ balances: SOLDES_NOMINAUX }));
    expect(result.orders).toEqual([]);
    expect(result.observations.unknownOpenOrders).toEqual([]);
  });

  it('laisse PENDING un ordre encore ouvert et sans execution', async () => {
    const result = reconcilie(
      await lance({
        pending: [ordreEnAttente({ clientOrderId: 'coid-a' })],
        open: [ordreOuvert({ clientOrderId: 'coid-a', filled: qty('0') })],
      }),
    );
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.status).toEqual({ kind: 'PENDING' });
    expect(result.orders[0]?.order.clientOrderId).toBe('coid-a');
  });

  it('passe en PARTIAL un ordre ouvert deja partiellement execute, avec la quantite', async () => {
    const result = reconcilie(
      await lance({
        pending: [ordreEnAttente({ clientOrderId: 'coid-b', requestedQty: qty('0.5') })],
        open: [ordreOuvert({ clientOrderId: 'coid-b', filled: qty('0.2') })],
      }),
    );
    const statut = result.orders[0]?.status;
    expect(statut?.kind).toBe('PARTIAL');
    expect(statut?.kind === 'PARTIAL' ? statut.filled.toString() : undefined).toBe('0.2');
  });

  it('declare INDETERMINABLE un ordre absent des ordres ouverts, sans le deviner', async () => {
    /*
     * Le lecteur de la phase 1 ne voit que les ordres ouverts. Un PENDING absent
     * s'est denoue — execute, annule ou rejete — et rien de ce qu'on lit ne dit
     * lequel. Classer par defaut un ordre execute en annule est pire que ne pas
     * le classer : le statut rendu est l'aveu, pas une valeur de repli.
     */
    const result = reconcilie(
      await lance({ pending: [ordreEnAttente({ clientOrderId: 'coid-c' })], open: [] }),
    );
    const statut = result.orders[0]?.status;
    expect(statut?.kind).toBe('INDETERMINABLE');
    expect(statut?.kind === 'INDETERMINABLE' ? statut.reason : '').toContain('coid-c');
    expect(['PENDING', 'PARTIAL', 'FILLED']).not.toContain(statut?.kind);
  });

  it('apparie chaque ordre par son client_order_id et pas par sa position', async () => {
    // Deux ordres, rendus dans l'ordre inverse par l'exchange : un appariement
    // par index rendrait deux statuts justes en apparence et croises en fait.
    const result = reconcilie(
      await lance({
        pending: [
          ordreEnAttente({ clientOrderId: 'coid-1' }),
          ordreEnAttente({ clientOrderId: 'coid-2' }),
        ],
        open: [
          ordreOuvert({ clientOrderId: 'coid-2', filled: qty('0.3') }),
          ordreOuvert({ clientOrderId: 'coid-1', filled: qty('0') }),
        ],
      }),
    );
    expect(result.orders.map((o) => [o.order.clientOrderId, o.status.kind])).toEqual([
      ['coid-1', 'PENDING'],
      ['coid-2', 'PARTIAL'],
    ]);
  });

  it('signale un ordre ouvert qu’aucune ligne PENDING ne reclame', async () => {
    const result = reconcilie(
      await lance({ pending: [], open: [ordreOuvert({ clientOrderId: 'inconnu' })] }),
    );
    expect(result.observations.unknownOpenOrders.map((o) => o.clientOrderId)).toEqual(['inconnu']);
  });

  it('n’ecrit rien : les doubles n’exposent aucune ecriture', async () => {
    /*
     * La reconciliation ne persiste pas les transitions qu'elle calcule. Ce
     * n'est pas un report d'ecriture : c'est une **lecture** qui manque a
     * l'adapter — determiner l'issue d'un ordre denoue demande son statut ou ses
     * executions. Voir docs/reconciliation.md. Le contrat le dit en type : les
     * deux dependances sont des `Pick` de lecture seule.
     */
    const banc = harnais({ pending: [ordreEnAttente()], open: [] });
    await reconcile(banc.input);
    expect(Object.keys(banc.input.db)).toEqual(['pendingOrders', 'latestSnapshot']);
    expect(Object.keys(banc.input.exchange)).toEqual(['balances', 'openOrders']);
  });
});
