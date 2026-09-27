import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { RECONCILIATION_DRIFT_PCT } from '../../src/core/risk.js';
import type { Price } from '../../src/core/types.js';
import { reconcile, RESYNC_MARKER } from '../../src/jobs/reconcile.js';
import type { ReconcileResult, Resynchronization } from '../../src/jobs/reconcile.js';
import { harnais, MAINTENANT, ordreEnAttente, ordreOuvert, photo, qty, solde, statutConnu } from './doubles.js';

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

/**
 * Les lignes qui ont fait se rendre le cache. Le resultat porte toujours des
 * soldes — il n'y a plus de branche d'abandon a ecarter — donc le seul
 * narrowing utile est celui-ci.
 */
function resynchronise(result: ReconcileResult): Extract<Resynchronization, { status: 'RESYNCHRONIZED' }> {
  if (result.resync.status !== 'RESYNCHRONIZED') {
    throw new Error('resynchronisation attendue, la reconciliation a trouve les deux etats d’accord');
  }
  return result.resync;
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
    const result = await lance({ balances: [solde('BTC', '0.4', '0.1'), solde('USDC', '10000')] });
    expect(result.balances.holdings.BTC.toString()).toBe('0.5');
    expect(result.balances.holdings.ETH.toString()).toBe('0');
    expect(result.balances.holdings.USDC.toString()).toBe('10000');
  });

  it('somme deux comptes de la meme devise au lieu d’en retenir un', async () => {
    const result = await lance({ balances: [solde('BTC', '0.3'), solde('BTC', '0.7')] });
    expect(result.balances.holdings.BTC.toString()).toBe('1');
  });
});

describe('§7 etape 4 — le seuil de 1 %, des deux cotes', () => {
  /*
   * Le seuil est strict, comme dans `core/risk.ts` : `drift > 1 %` resynchronise,
   * `drift = 1 %` passe. Les deux cas ci-dessous sont a un centieme de point
   * l'un de l'autre et tombent de part et d'autre de la comparaison. Inverser
   * le sens de la comparaison, ou la passer de stricte a large, casse l'un des
   * deux — aucune implementation ne peut satisfaire les deux sans le bon signe.
   *
   * **Le seuil n'a pas bouge en Q10 ; sa consequence, si.** Ces sondes-la sont
   * donc les memes qu'avant, lues sur `resync` au lieu de `status`.
   */
  it('accepte une divergence de 1 % pile sans resynchroniser', async () => {
    const result = await lance({
      balances: [solde('USDC', '99')],
      snapshot: photo({ USDC: qty('100') }),
    });
    expect(result.resync.status).toBe('NOT_NEEDED');
  });

  it('resynchronise a 1,01 %', async () => {
    const result = await lance({
      balances: [solde('USDC', '98.99')],
      snapshot: photo({ USDC: qty('100') }),
    });
    const resync = resynchronise(result);
    expect(resync.divergences).toHaveLength(1);
    const [ecart] = resync.divergences;
    expect(ecart?.asset).toBe('USDC');
    expect(ecart?.onExchange.toString()).toBe('98.99');
    expect(ecart?.internal.toString()).toBe('100');
    expect(ecart?.drift.toString()).toBe('0.0101');
    expect(resync.reason).toContain('98.99');
    expect(resync.reason).toContain('1.0100 %');
    expect(resync.reason.startsWith(RESYNC_MARKER)).toBe(true);
  });

  /**
   * **L'impasse que le lot ferme.** Avant Q10 ce cas rendait `ABORTED` sans
   * aucun solde : le run s'arretait, ne posait pas de photo, et le run suivant
   * relisait la meme photo perimee. Desormais les soldes rendus sont ceux de
   * l'exchange — c'est le cache qui se rend, pas le run.
   */
  it('rend quand meme les soldes de l’exchange, qui font foi', async () => {
    const result = await lance({
      balances: [solde('USDC', '50')],
      snapshot: photo({ USDC: qty('100') }),
    });
    expect(resynchronise(result).divergences.map((d) => d.asset)).toEqual(['USDC']);
    expect(result.balances.holdings.USDC.toString()).toBe('50');
    expect(result.balances.comparedTo).toBe('INTERNAL_SNAPSHOT');
  });

  it('resynchronise sur une divergence compensee, que la valeur totale ne voit pas', async () => {
    /*
     * **Le test qui separe « ligne a ligne » de « valeur totale ».** Les deux
     * etats valent exactement la meme chose : 1,02 BTC a 60 000 plus 19,6 ETH a
     * 3 000 font 130 000, comme 1 BTC plus 20 ETH. Une implementation qui
     * comparerait la valeur totale trouverait 0 % d'ecart et laisserait passer.
     * Ligne a ligne, BTC derive de 1,96 % et ETH de 2 % : le cache se rend.
     */
    const btc = new Decimal('60000') as Price;
    const eth = new Decimal('3000') as Price;
    const valeur = (q: string, prix: Price, autre: string, prixAutre: Price): Decimal =>
      new Decimal(q).mul(prix).add(new Decimal(autre).mul(prixAutre)).add(10000);
    expect(valeur('1.02', btc, '19.6', eth).toString()).toBe(
      valeur('1', btc, '20', eth).toString(),
    );

    const resync = resynchronise(
      await lance({
        balances: [solde('BTC', '1.02'), solde('ETH', '19.6'), solde('USDC', '10000')],
        snapshot: CACHE_NOMINAL,
      }),
    );
    expect(resync.divergences.map((d) => d.asset)).toEqual(['BTC', 'ETH']);
  });

  it('resynchronise sur une ligne que le cache porte et que l’exchange ne porte plus', async () => {
    // L'union des deux cotes : sans elle, une position disparue passe inapercue.
    const resync = resynchronise(
      await lance({
        balances: [solde('BTC', '1'), solde('USDC', '10000')],
        snapshot: CACHE_NOMINAL,
      }),
    );
    expect(resync.divergences.map((d) => d.asset)).toEqual(['ETH']);
    expect(resync.divergences[0]?.drift.toString()).toBe('1');
  });

  it('resynchronise sur une ligne apparue sur l’exchange et absente du cache', async () => {
    const resync = resynchronise(
      await lance({
        balances: [...SOLDES_NOMINAUX, solde('SOL', '3')],
        snapshot: CACHE_NOMINAL,
      }),
    );
    expect(resync.divergences.map((d) => d.asset)).toEqual(['SOL']);
  });

  it('ne voit pas de divergence sur une ligne a zero des deux cotes', async () => {
    // Le portefeuille reel porte un compte EUR a zero : capture en fixture Q3.
    const result = await lance({ balances: [...SOLDES_NOMINAUX, solde('EUR', '0')], snapshot: CACHE_NOMINAL });
    expect(result.observations.untrackedBalances).toEqual([]);
    expect(result.balances.comparedTo).toBe('INTERNAL_SNAPSHOT');
    expect(result.resync.status).toBe('NOT_NEEDED');
  });

  it('signale une devise hors liste blanche reellement detenue', async () => {
    const result = await lance({ balances: [...SOLDES_NOMINAUX, solde('SOL', '3')], snapshot: undefined });
    expect(result.observations.untrackedBalances.map((l) => l.currency)).toEqual(['SOL']);
  });

  it('le seuil applique est celui du noyau, pas une copie locale', () => {
    expect(RECONCILIATION_DRIFT_PCT.toString()).toBe('0.01');
  });
});

describe('premier run — il n’y a pas encore de cache a confronter', () => {
  it('reconcilie sans snapshot et le dit', async () => {
    const result = await lance({ balances: SOLDES_NOMINAUX, snapshot: undefined });
    /*
     * Une absence de cache n'est pas une divergence nulle. Le resultat distingue
     * les deux : le rapport du run doit pouvoir dire qu'aucune comparaison n'a
     * eu lieu, plutot que d'afficher une reconciliation qui n'a rien reconcilie.
     */
    expect(result.balances.comparedTo).toBe('NO_INTERNAL_STATE');
    expect(result.balances.holdings.ETH.toString()).toBe('20');
    /*
     * Et `NOT_NEEDED` n'est pas la meme chose : rien n'a diverge parce que rien
     * n'a ete compare. C'est `comparedTo` qui porte l'absence de cache ; les deux
     * champs repondent a deux questions, et les confondre ferait passer un
     * premier run pour un jour ou l'etat s'est resynchronise.
     */
    expect(result.resync.status).toBe('NOT_NEEDED');
  });
});

describe('§7 etape 2 — les ordres PENDING selon leur statut reel', () => {
  it('rend une liste vide quand la table est vide, ce qui est le cas de la phase 1', async () => {
    const result = await lance({ balances: SOLDES_NOMINAUX });
    expect(result.orders).toEqual([]);
    expect(result.observations.unknownOpenOrders).toEqual([]);
  });

  it('laisse PENDING un ordre encore ouvert et sans execution', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ clientOrderId: 'coid-a' })],
      open: [ordreOuvert({ clientOrderId: 'coid-a', filled: qty('0') })],
    });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.status).toEqual({ kind: 'PENDING', exchangeId: 'exch-1' });
    expect(result.orders[0]?.order.clientOrderId).toBe('coid-a');
    expect(result.orders[0]?.transition).toMatchObject({ status: 'PENDING', settledAt: null });
  });

  it('passe en PARTIAL un ordre ouvert deja partiellement execute, avec la quantite', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ clientOrderId: 'coid-b', requestedQty: qty('0.5') })],
      open: [ordreOuvert({ clientOrderId: 'coid-b', filled: qty('0.2') })],
    });
    const statut = result.orders[0]?.status;
    expect(statut?.kind).toBe('PARTIAL');
    expect(statut?.kind === 'PARTIAL' ? statut.filled.toString() : undefined).toBe('0.2');
    // Encore ouvert : la ligne gagne sa quantite executee, pas d'instant de denouement.
    expect(result.orders[0]?.transition).toMatchObject({ status: 'PARTIAL', settledAt: null });
    expect(result.orders[0]?.transition?.filledQty.toString()).toBe('0.2');
  });

  it('declare INDETERMINABLE un ordre que l’exchange ne connait pas, sans le deviner ni rien ecrire', async () => {
    /*
     * Absent des ordres ouverts, et inconnu de la lecture d'un ordre donne : un
     * ordre jamais accepte, qu'E23 rend possible. Classer par defaut un ordre
     * execute en annule est pire que ne pas le classer : le statut rendu est
     * l'aveu, et l'aveu n'ecrit rien.
     */
    const result = await lance({ pending: [ordreEnAttente({ clientOrderId: 'coid-c' })], open: [] });
    const statut = result.orders[0]?.status;
    expect(statut?.kind).toBe('INDETERMINABLE');
    expect(statut?.kind === 'INDETERMINABLE' ? statut.reason : '').toContain('coid-c');
    expect(['PENDING', 'PARTIAL', 'SETTLED']).not.toContain(statut?.kind);
    expect(result.orders[0]?.transition).toBeNull();
  });

  it('apparie chaque ordre par son client_order_id et pas par sa position', async () => {
    // Deux ordres, rendus dans l'ordre inverse par l'exchange : un appariement
    // par index rendrait deux statuts justes en apparence et croises en fait.
    const result = await lance({
      pending: [
        ordreEnAttente({ clientOrderId: 'coid-1', exchangeId: null }),
        ordreEnAttente({ clientOrderId: 'coid-2', exchangeId: null }),
      ],
      open: [
        ordreOuvert({ clientOrderId: 'coid-2', exchangeId: 'exch-2', filled: qty('0.3') }),
        ordreOuvert({ clientOrderId: 'coid-1', exchangeId: 'exch-1', filled: qty('0') }),
      ],
    });
    expect(result.orders.map((o) => [o.order.clientOrderId, o.status.kind])).toEqual([
      ['coid-1', 'PENDING'],
      ['coid-2', 'PARTIAL'],
    ]);
  });

  it('signale un ordre ouvert qu’aucune ligne PENDING ne reclame', async () => {
    const result = await lance({ pending: [], open: [ordreOuvert({ clientOrderId: 'inconnu' })] });
    expect(result.observations.unknownOpenOrders.map((o) => o.clientOrderId)).toEqual(['inconnu']);
  });

  it('n’ecrit rien : les doubles n’exposent aucune ecriture', async () => {
    /*
     * La reconciliation **rend** les transitions, elle ne les persiste pas :
     * c'est `daily.ts` qui ecrit, et le contrat le dit en type — les dependances
     * sont des `Pick` de lecture seule.
     */
    const banc = harnais({ pending: [ordreEnAttente()], open: [] });
    await reconcile(banc.input);
    expect(Object.keys(banc.input.db)).toEqual(['pendingOrders', 'latestSnapshot']);
    expect(Object.keys(banc.input.exchange)).toEqual(['balances', 'openOrders', 'orderStatus']);
  });
});

describe('E37 et E38 — l’issue d’un ordre denoue est lue, et rendue a ecrire', () => {
  const DENOUE = { pending: [ordreEnAttente()], open: [] } as const;

  /*
   * **La sonde d'E37.** Avant S8, cet ordre — absent des ordres ouverts, et que
   * l'exchange connait execute — sortait `INDETERMINABLE`. Il sort avec son
   * issue, et les cinq colonnes du §4 a reporter.
   */
  it('un ordre execute que l’exchange connait sort FILLED, avec ses cinq colonnes', async () => {
    const result = await lance({ ...DENOUE, statuts: { 'exch-1': statutConnu() } });
    const [ligne] = result.orders;

    expect(ligne?.status).toEqual({ kind: 'SETTLED', outcome: 'FILLED', filled: qty('0.5') });
    expect(ligne?.transition?.status).toBe('FILLED');
    expect(ligne?.transition?.filledQty.toFixed()).toBe('0.5');
    expect(ligne?.transition?.filledPrice?.toFixed()).toBe('60000.12345678');
    expect(ligne?.transition?.fees.toFixed()).toBe('75.00015432');
    expect(ligne?.transition?.settledAt).toEqual(MAINTENANT);
    expect(ligne?.transition?.exchangeId).toBe('exch-1');
  });

  it('un ordre partiellement execute puis annule garde sa quantite executee', async () => {
    const lu = statutConnu({ kind: 'CANCELLED', filled: qty('0.2') });
    const [ligne] = (await lance({ ...DENOUE, statuts: { 'exch-1': lu } })).orders;

    expect(ligne?.status).toEqual({ kind: 'SETTLED', outcome: 'CANCELLED', filled: qty('0.2') });
    expect(ligne?.transition?.status).toBe('CANCELLED');
    expect(ligne?.transition?.filledQty.toFixed()).toBe('0.2');
  });

  it.each([
    ['EXPIRED', 'CANCELLED'],
    ['FAILED', 'REJECTED'],
  ] as const)('l’issue %s s’ecrit %s, une des cinq valeurs du §4', async (kind, ecrit) => {
    const lu = statutConnu({ kind, filled: qty('0'), averageFilledPrice: null });
    const [ligne] = (await lance({ ...DENOUE, statuts: { 'exch-1': lu } })).orders;

    expect(ligne?.status).toMatchObject({ kind: 'SETTLED', outcome: kind });
    expect(ligne?.transition).toMatchObject({ status: ecrit, filledPrice: null, settledAt: MAINTENANT });
  });

  /*
   * L'horloge est un parametre (E35) : deux instants de run donnent deux
   * instants de denouement, et aucun autre temps n'entre. Une horloge lue au
   * fond du module passerait le lint — `src/jobs/` est hors de son glob — et
   * casserait cette sonde ; A7 de `purete.test.ts` refuse la lecture elle-meme.
   */
  it('date le denouement a l’instant injecte, et a aucun autre', async () => {
    const plusTard = new Date('2026-09-14T05:03:00.000Z');
    const [ligne] = (await lance({ ...DENOUE, statuts: { 'exch-1': statutConnu() }, now: plusTard })).orders;
    expect(ligne?.transition?.settledAt).toEqual(plusTard);
  });

  it('lit par l’identifiant des ordres ouverts une ligne dont le placement n’a pas ete ecrit', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ exchangeId: null })],
      open: [ordreOuvert({ exchangeId: 'exch-9' })],
    });
    expect(result.orders[0]?.status).toEqual({ kind: 'PENDING', exchangeId: 'exch-9' });
    // L'identifiant voyage avec la transition : la ligne le gagne, et le lendemain se lit.
    expect(result.orders[0]?.transition?.exchangeId).toBe('exch-9');
  });

  it('ne consulte pas l’exchange pour une ligne sans identifiant et absente des ordres ouverts', async () => {
    const banc = harnais({ pending: [ordreEnAttente({ exchangeId: null })], open: [] });
    const result = await reconcile(banc.input);
    expect(result.orders[0]?.status.kind).toBe('INDETERMINABLE');
    expect(result.orders[0]?.transition).toBeNull();
    expect(banc.appels).not.toContain('orderStatus');
  });

  /*
   * **Un INDETERMINABLE n'ecrit rien**, donc n'ecrase rien : c'est la moitie
   * « affinement » de la persistance, cote calcul. La base tient l'autre moitie.
   */
  it('une lecture en echec rend INDETERMINABLE, sans transition ni exception', async () => {
    const result = await lance({ ...DENOUE, statuts: { 'exch-1': new Error('reseau coupe') } });
    const statut = result.orders[0]?.status;
    expect(statut?.kind === 'INDETERMINABLE' ? statut.reason : '').toContain('reseau coupe');
    expect(result.orders[0]?.transition).toBeNull();
  });

  it('une lecture en echec sur un ordre encore ouvert garde la vue des ordres ouverts, sans rien ecrire', async () => {
    const result = await lance({
      pending: [ordreEnAttente()],
      open: [ordreOuvert({ filled: qty('0.1') })],
      statuts: { 'exch-1': new Error('reseau coupe') },
    });
    expect(result.orders[0]?.status).toEqual({ kind: 'PARTIAL', exchangeId: 'exch-1', filled: qty('0.1') });
    expect(result.orders[0]?.transition).toBeNull();
  });

  it('refuse d’appliquer le statut d’un autre ordre', async () => {
    const autre = statutConnu({ clientOrderId: 'coid-etranger' });
    const result = await lance({ ...DENOUE, statuts: { 'exch-1': autre } });
    const statut = result.orders[0]?.status;
    expect(statut?.kind === 'INDETERMINABLE' ? statut.reason : '').toContain('coid-etranger');
    expect(result.orders[0]?.transition).toBeNull();
  });
});

describe('§7 point 3 — les ordres de plus de 24 h sont rendus a annuler (E35)', () => {
  const HEURE = 3_600_000;
  const posesIlYA = (heures: number, ms = 0): Date => new Date(MAINTENANT.getTime() - heures * HEURE - ms);
  const ouvertDepuis = (heures: number, ms = 0) => ({
    pending: [ordreEnAttente({ createdAt: posesIlYA(heures, ms) })],
    open: [ordreOuvert()],
  });

  it('un ordre ouvert de 25 h est rendu a annuler, un de 23 h ne l’est pas', async () => {
    expect((await lance(ouvertDepuis(25))).cancellations).toEqual([
      { clientOrderId: 'coid-1', exchangeId: 'exch-1', ageMs: 25 * HEURE },
    ]);
    expect((await lance(ouvertDepuis(23))).cancellations).toEqual([]);
  });

  it('strictement plus de 24 h : 24 h pile reste, une milliseconde de plus s’annule', async () => {
    expect((await lance(ouvertDepuis(24))).cancellations).toEqual([]);
    expect((await lance(ouvertDepuis(24, 1))).cancellations.map((c) => c.ageMs)).toEqual([24 * HEURE + 1]);
  });

  /*
   * L'age vient de `orders.created_at`, ecrit par le run avec son instant — pas
   * du `created_time` de l'exchange. Les deux sont ici en desaccord de sept
   * heures, dans les deux sens : seule la base decide.
   */
  it('compte l’age sur created_at de la base, jamais sur l’horodatage de l’exchange', async () => {
    const jeune = await lance({
      pending: [ordreEnAttente({ createdAt: posesIlYA(23) })],
      open: [ordreOuvert({ createdAt: posesIlYA(30) })],
    });
    const vieux = await lance({
      pending: [ordreEnAttente({ createdAt: posesIlYA(25) })],
      open: [ordreOuvert({ createdAt: posesIlYA(18) })],
    });
    expect(jeune.cancellations).toEqual([]);
    expect(vieux.cancellations).toHaveLength(1);
  });

  it('l’horloge est celle du run, injectee : le meme ordre, deux instants, deux reponses', async () => {
    const scenario = { pending: [ordreEnAttente({ createdAt: posesIlYA(20) })], open: [ordreOuvert()] };
    expect((await lance(scenario)).cancellations).toEqual([]);
    const plusTard = new Date(MAINTENANT.getTime() + 5 * HEURE);
    expect((await lance({ ...scenario, now: plusTard })).cancellations).toHaveLength(1);
  });

  it('un ordre partiellement execute est « non execute » : il s’annule aussi', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ createdAt: posesIlYA(25) })],
      open: [ordreOuvert({ filled: qty('0.2') })],
    });
    expect(result.cancellations.map((c) => c.clientOrderId)).toEqual(['coid-1']);
  });

  it('un ordre denoue ou indeterminable ne s’annule pas, quel que soit son age', async () => {
    const denoue = await lance({
      pending: [ordreEnAttente({ createdAt: posesIlYA(72) })],
      open: [],
      statuts: { 'exch-1': statutConnu() },
    });
    const inconnu = await lance({ pending: [ordreEnAttente({ createdAt: posesIlYA(72) })], open: [] });
    expect(denoue.cancellations).toEqual([]);
    expect(inconnu.cancellations).toEqual([]);
  });

  it('annule par l’identifiant des ordres ouverts une ligne dont le placement n’a pas ete ecrit', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ exchangeId: null, createdAt: posesIlYA(26) })],
      open: [ordreOuvert({ exchangeId: 'exch-9' })],
    });
    expect(result.cancellations.map((c) => c.exchangeId)).toEqual(['exch-9']);
  });
});
