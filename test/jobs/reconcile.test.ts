import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { RECONCILIATION_DRIFT_PCT } from '../../src/core/risk.js';
import type { Price, UsdcAmount } from '../../src/core/types.js';
import { reconcile, RESYNC_MARKER } from '../../src/jobs/reconcile.js';
import type { ReconcileResult, Resynchronization } from '../../src/jobs/reconcile.js';
import { fluxEnregistre, harnais, MAINTENANT, ordreEnAttente, ordreOuvert, photo, qty, solde, statutConnu } from './doubles.js';

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
     * comparer avant d'avoir lu. Les flux enregistres viennent apres la photo :
     * leur fenetre part de son horodatage (CV15).
     */
    expect(banc.appels).toEqual(['balances', 'openOrders', 'pendingOrders', 'latestSnapshot', 'recentCashFlows']);
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
    expect(Object.keys(banc.input.db)).toEqual(['pendingOrders', 'latestSnapshot', 'recentCashFlows']);
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

describe('D5 — les ordres ouverts d’un run anterieur sont rendus a annuler, quel que soit leur age', () => {
  const MINUTE = 60_000;
  /** Pose `minutes` avant l'instant du run, `MAINTENANT` (2026-09-11 07:00Z). */
  const poseIlYA = (minutes: number): Date => new Date(MAINTENANT.getTime() - minutes * MINUTE);
  const ouvert = (order: Partial<Parameters<typeof ordreEnAttente>[0]>) => ({
    pending: [ordreEnAttente(order)],
    open: [ordreOuvert()],
  });

  /*
   * **La sonde de K4.** L'ordre de la veille n'a que 23 h 55 : la regle des
   * 24 h le laissait ouvert, et l'etape 6 ne placait rien par-dessus. Son
   * `run_date` est anterieur : il s'annule.
   */
  it('un ordre de la veille age de 23 h 55 est rendu a annuler', async () => {
    const result = await lance(ouvert({ runDate: '2026-09-10', createdAt: poseIlYA(23 * 60 + 55) }));
    expect(result.cancellations).toEqual([{ clientOrderId: 'coid-1', exchangeId: 'exch-1', placedOn: '2026-09-10' }]);
  });

  it('un ordre de plusieurs jours est rendu a annuler aussi', async () => {
    const result = await lance(ouvert({ runDate: '2026-09-01', createdAt: poseIlYA(10 * 24 * 60) }));
    expect(result.cancellations.map((c) => c.placedOn)).toEqual(['2026-09-01']);
  });

  /* Le second run du jour (cas du 2026-09-28 13:44) n'annule pas l'ordre du premier. */
  it('un ordre du meme run_date n’est pas annule par un second run du jour', async () => {
    const result = await lance({
      ...ouvert({ runDate: '2026-09-11', createdAt: poseIlYA(60) }),
      now: new Date('2026-09-11T13:44:00.000Z'),
    });
    expect(result.cancellations).toEqual([]);
  });

  /*
   * La regle compare des jours, jamais des instants : un ordre pose une minute
   * avant minuit UTC la veille s'annule, un ordre du jour pose a minuit pile ne
   * s'annule pas, quel que soit l'ecart reel entre les deux.
   */
  it('compare le run_date de l’ordre au jour du run, pas l’age de l’ordre', async () => {
    const veille = await lance({
      ...ouvert({ runDate: '2026-09-10', createdAt: new Date('2026-09-10T23:59:00.000Z') }),
      now: new Date('2026-09-11T00:01:00.000Z'),
    });
    const duJour = await lance(ouvert({ runDate: '2026-09-11', createdAt: new Date('2026-09-11T00:00:00.000Z') }));
    expect(veille.cancellations).toHaveLength(1);
    expect(duJour.cancellations).toEqual([]);
  });

  /* Le `run_date` de la decision fait foi, meme quand `created_at` dirait un autre jour. */
  it('le run_date de la decision prime sur le jour de created_at', async () => {
    const result = await lance(ouvert({ runDate: '2026-09-11', createdAt: new Date('2026-09-10T23:00:00.000Z') }));
    expect(result.cancellations).toEqual([]);
  });

  it('le jour du run est injecte : le meme ordre, deux jours de run, deux reponses', async () => {
    const scenario = ouvert({ runDate: '2026-09-11', createdAt: poseIlYA(60) });
    expect((await lance(scenario)).cancellations).toEqual([]);
    expect((await lance({ ...scenario, runDate: '2026-09-12' })).cancellations).toHaveLength(1);
  });

  /*
   * Ajustement technique 1 du plan : une ligne sans decision rattachee prend
   * pour jour celui, en UTC, de son `created_at`. Jamais le `created_time` de
   * l'exchange, ici en desaccord d'un jour dans les deux sens.
   */
  it('sans decision, le jour est celui de created_at en UTC, jamais celui de l’exchange', async () => {
    const veille = await lance({
      pending: [ordreEnAttente({ runDate: null, createdAt: new Date('2026-09-10T23:59:59.999Z') })],
      open: [ordreOuvert({ createdAt: new Date('2026-09-11T06:00:00.000Z') })],
    });
    const duJour = await lance({
      pending: [ordreEnAttente({ runDate: null, createdAt: new Date('2026-09-11T00:00:00.000Z') })],
      open: [ordreOuvert({ createdAt: new Date('2026-09-09T06:00:00.000Z') })],
    });
    expect(veille.cancellations.map((c) => c.placedOn)).toEqual(['2026-09-10']);
    expect(duJour.cancellations).toEqual([]);
  });

  it('un ordre partiellement execute est « non execute » : il s’annule aussi', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ runDate: '2026-09-10' })],
      open: [ordreOuvert({ filled: qty('0.2') })],
    });
    expect(result.cancellations.map((c) => c.clientOrderId)).toEqual(['coid-1']);
  });

  it('un ordre denoue ou indeterminable ne s’annule pas, quel que soit son jour', async () => {
    const denoue = await lance({
      pending: [ordreEnAttente({ runDate: '2026-09-01' })],
      open: [],
      statuts: { 'exch-1': statutConnu() },
    });
    const inconnu = await lance({ pending: [ordreEnAttente({ runDate: '2026-09-01' })], open: [] });
    expect(denoue.cancellations).toEqual([]);
    expect(inconnu.cancellations).toEqual([]);
  });

  it('annule par l’identifiant des ordres ouverts une ligne dont le placement n’a pas ete ecrit', async () => {
    const result = await lance({
      pending: [ordreEnAttente({ exchangeId: null, runDate: '2026-09-10' })],
      open: [ordreOuvert({ exchangeId: 'exch-9' })],
    });
    expect(result.cancellations.map((c) => c.exchangeId)).toEqual(['exch-9']);
  });

  it('rend les annulations dans l’ordre de la base, sans celles du jour', async () => {
    const result = await lance({
      pending: [
        ordreEnAttente({ clientOrderId: 'a', exchangeId: 'ex-a', runDate: '2026-09-09' }),
        ordreEnAttente({ clientOrderId: 'b', exchangeId: 'ex-b', runDate: '2026-09-11' }),
        ordreEnAttente({ clientOrderId: 'c', exchangeId: 'ex-c', runDate: '2026-09-10' }),
      ],
      open: [
        ordreOuvert({ clientOrderId: 'a', exchangeId: 'ex-a' }),
        ordreOuvert({ clientOrderId: 'b', exchangeId: 'ex-b' }),
        ordreOuvert({ clientOrderId: 'c', exchangeId: 'ex-c' }),
      ],
    });
    expect(result.cancellations.map((c) => c.clientOrderId)).toEqual(['a', 'c']);
  });
});

describe('§2 bis — nos propres executions ne sont pas un mouvement hors du systeme', () => {
  /*
   * La photo d'un jour est calculee avant que l'etape 6 ne place quoi que ce
   * soit : elle ne contient jamais les executions des ordres qu'elle precede.
   * Le lendemain, la reconciliation compare donc les soldes reels a la photo
   * **plus** ce que nos ordres ont execute depuis.
   */
  const prix = (valeur: string): Price => new Decimal(valeur) as Price;
  const usdc = (valeur: string): UsdcAmount => new Decimal(valeur) as UsdcAmount;

  it('le cas reel du 2026-10-02 : deux achats executes ne resynchronisent plus', async () => {
    const achatBtc = ordreEnAttente({ clientOrderId: 'btc', exchangeId: 'x-btc', asset: 'BTC', requestedQty: qty('0.00466624') });
    const achatEth = ordreEnAttente({ clientOrderId: 'eth', exchangeId: 'x-eth', asset: 'ETH', requestedQty: qty('0.10004603') });
    const scenario = {
      balances: [solde('BTC', '0.03310391'), solde('ETH', '0.77294351'), solde('USDC', '2073.541091011459')],
      snapshot: photo({ BTC: qty('0.02843767'), ETH: qty('0.67289748'), USDC: qty('2732.9359764608') }),
      pending: [achatBtc, achatEth],
    };
    const statuts = {
      'x-btc': statutConnu({ exchangeId: 'x-btc', clientOrderId: 'btc', filled: qty('0.00466624'), averageFilledPrice: prix('84500'), fees: usdc('1.18') }),
      'x-eth': statutConnu({ exchangeId: 'x-eth', clientOrderId: 'eth', filled: qty('0.10004603'), averageFilledPrice: prix('2630'), fees: usdc('0.79') }),
    };

    expect((await lance({ ...scenario, statuts })).resync.status).toBe('NOT_NEEDED');

    // Le meme jour sans issue lisible : l'ecart reste visible, il ne se devine pas.
    const aveugle = resynchronise(await lance(scenario));
    expect(aveugle.divergences.map((d) => d.asset)).toEqual(['BTC', 'ETH', 'USDC']);
  });

  it('un partiel sur deux runs ne compte que la part executee depuis la photo', async () => {
    // La photo d'hier portait deja 0.2 BTC executes a 60 000, frais 12 compris.
    const partiel = ordreEnAttente({ filledQty: qty('0.2'), filledPrice: prix('60000'), fees: usdc('12') });
    const scenario = {
      balances: [solde('BTC', '1.5'), solde('USDC', '1982')],
      snapshot: photo({ BTC: qty('1.2'), USDC: qty('20000') }),
      statuts: { 'exch-1': statutConnu({ filled: qty('0.5'), averageFilledPrice: prix('60000'), fees: usdc('30') }) },
    };

    // 1.2 + 0.3 BTC ; 20 000 - 0.3 x 60 000 - 18 de frais nouveaux = 1 982 USDC.
    expect((await lance({ ...scenario, pending: [partiel] })).resync.status).toBe('NOT_NEEDED');

    // Compter les 0.5 entiers attendrait 1.7 BTC : 11,8 % d'ecart.
    const recompte = ordreEnAttente();
    expect(resynchronise(await lance({ ...scenario, pending: [recompte] })).divergences.map((d) => d.asset)).toEqual([
      'BTC',
      'USDC',
    ]);
  });

  it('une vente retire l’actif et credite l’USDC, frais deduits', async () => {
    const vente = ordreEnAttente({ side: 'SELL', asset: 'ETH' });
    const result = await lance({
      balances: [solde('ETH', '15'), solde('USDC', '24985')],
      snapshot: photo({ ETH: qty('20'), USDC: qty('10000') }),
      pending: [vente],
      statuts: { 'exch-1': statutConnu({ filled: qty('5'), averageFilledPrice: prix('3000'), fees: usdc('15') }) },
    });
    expect(result.resync.status).toBe('NOT_NEEDED');
  });

  it('un vrai mouvement exterieur, en plus de nos executions, resynchronise encore', async () => {
    const achat = ordreEnAttente();
    const resync = resynchronise(
      await lance({
        // Nos 0.5 BTC a 60 000 expliquent 1.5 BTC et 69 970 USDC  ; 5 000 USDC sont partis ailleurs.
        balances: [solde('BTC', '1.5'), solde('USDC', '64970')],
        snapshot: photo({ BTC: qty('1'), USDC: qty('100000') }),
        pending: [achat],
        statuts: { 'exch-1': statutConnu({ filled: qty('0.5'), averageFilledPrice: prix('60000'), fees: usdc('30') }) },
      }),
    );
    expect(resync.divergences.map((d) => d.asset)).toEqual(['USDC']);
    expect(resync.divergences[0]?.internal.toString()).toBe('69970');
    expect(resync.reason).toContain('photo precedente et executions de nos ordres');
  });
});

describe('CV15 — une divergence entierement expliquee par les flux enregistres', () => {
  /*
   * La photo d'hier a 07:00 porte 10 000 USDC. Le convoyeur a transfere 700 USDC
   * a 18:00 et ecrit sa ligne : 7 % de la ligne USDC, la sonde de la spec.
   * **La resynchronisation ne change pas** — elle tombe le meme jour, avec le
   * meme marqueur et les memes chiffres ; seule sa qualification est nouvelle.
   */
  const HIER = photo({ BTC: qty('1'), USDC: qty('10000') });
  const APPORT = fluxEnregistre('2026-09-10T18:00:00.000Z', '700');
  const APPORTE = [solde('BTC', '1'), solde('USDC', '10700')];

  it('la sonde de CV15 : un apport de 7 % enregistre par le convoyeur explique la ligne USDC', async () => {
    const resync = resynchronise(await lance({ balances: APPORTE, snapshot: HIER, flows: [APPORT] }));

    // La meme divergence qu'avant CV15 : le cache n'inclut pas les flux.
    expect(resync.divergences.map((d) => [d.asset, d.internal.toString(), d.explainedByFlows])).toEqual([
      ['USDC', '10000', true],
    ]);
    expect(resync.explainedByFlows).toBe(true);
    expect(resync.recordedFlows.toString()).toBe('700');
    expect(resync.reason.startsWith(RESYNC_MARKER)).toBe(true);
    expect(resync.reason).toContain('explique par 700 USDC de flux enregistres depuis la photo');
  });

  it('sans la ligne du convoyeur, le meme ecart n’est pas explique', async () => {
    const resync = resynchronise(await lance({ balances: APPORTE, snapshot: HIER }));
    expect(resync.explainedByFlows).toBe(false);
    expect(resync.recordedFlows.toString()).toBe('0');
    expect(resync.reason).not.toContain('flux enregistres');
  });

  it('un apport a moitie enregistre n’explique pas : l’ecart restant depasse 1 %', async () => {
    const moitie = fluxEnregistre('2026-09-10T18:00:00.000Z', '350');
    const resync = resynchronise(await lance({ balances: APPORTE, snapshot: HIER, flows: [moitie] }));

    expect(resync.divergences[0]?.explainedByFlows).toBe(false);
    expect(resync.explainedByFlows).toBe(false);
    expect(resync.reason).toContain("que 350 USDC de flux enregistres depuis la photo n'expliquent pas");
  });

  /*
   * DP1 = 1 : « ne diverge plus au sens de Q10 », meme formule et meme seuil
   * strict. Les deux cas sont de part et d'autre de 1 % ; un ecart residuel nul
   * exige au centime (DP1 = 2) rougirait le premier.
   */
  it('le seuil reste celui de Q10 : 1 % residuel explique, au-dela non', async () => {
    // 10 700 contre 10 000 + 593 = 10 593 : 1 % pile de 10 700.
    const auSeuil = resynchronise(
      await lance({ balances: APPORTE, snapshot: HIER, flows: [fluxEnregistre('2026-09-10T18:00:00.000Z', '593')] }),
    );
    expect(auSeuil.explainedByFlows).toBe(true);

    const auDela = resynchronise(
      await lance({ balances: APPORTE, snapshot: HIER, flows: [fluxEnregistre('2026-09-10T18:00:00.000Z', '592.99')] }),
    );
    expect(auDela.explainedByFlows).toBe(false);
  });

  /* La sonde mixte : un apport ne tait pas un BTC disparu le meme jour. */
  it('USDC explique et BTC non : la resynchronisation n’est pas expliquee', async () => {
    const resync = resynchronise(
      await lance({ balances: [solde('BTC', '0.9'), solde('USDC', '10700')], snapshot: HIER, flows: [APPORT] }),
    );

    expect(resync.divergences.map((d) => [d.asset, d.explainedByFlows])).toEqual([
      ['BTC', false],
      ['USDC', true],
    ]);
    expect(resync.explainedByFlows).toBe(false);
  });

  it('une ligne BTC n’est jamais expliquee, meme par un flux du meme montant', async () => {
    const resync = resynchronise(
      await lance({
        balances: [solde('BTC', '1.07'), solde('USDC', '10000')],
        snapshot: HIER,
        flows: [fluxEnregistre('2026-09-10T18:00:00.000Z', '0.07')],
      }),
    );
    expect(resync.divergences.map((d) => [d.asset, d.explainedByFlows])).toEqual([['BTC', false]]);
    expect(resync.explainedByFlows).toBe(false);
  });

  /*
   * La fenetre est `]photo, run]`, celle du chainage. La requete rend la borne
   * basse incluse ; c'est le predicat partage qui l'exclut : un flux a l'instant
   * de la photo est deja dans ses soldes.
   */
  it('un flux a l’instant de la photo, ou d’avant, n’explique rien', async () => {
    for (const instant of ['2026-09-10T07:00:00.000Z', '2026-09-09T18:00:00.000Z']) {
      const resync = resynchronise(
        await lance({ balances: APPORTE, snapshot: HIER, flows: [fluxEnregistre(instant, '700')] }),
      );
      expect(resync.explainedByFlows, instant).toBe(false);
      expect(resync.recordedFlows.toString(), instant).toBe('0');
    }
  });

  it('un flux posterieur a l’instant du run n’explique rien : les soldes lus ne le portent pas', async () => {
    const resync = resynchronise(
      await lance({ balances: APPORTE, snapshot: HIER, flows: [fluxEnregistre('2026-09-11T07:00:00.001Z', '700')] }),
    );
    expect(resync.explainedByFlows).toBe(false);

    const aLInstant = resynchronise(
      await lance({ balances: APPORTE, snapshot: HIER, flows: [fluxEnregistre(MAINTENANT.toISOString(), '700')] }),
    );
    expect(aLInstant.explainedByFlows).toBe(true);
  });

  /*
   * **Aucun double comptage.** Un flux deja dans la photo mais date apres elle
   * ne cree pas de divergence : la comparaison ignore les flux, ils ne font que
   * qualifier un ecart deja constate.
   */
  it('un flux sans ecart ne resynchronise pas : les flux ne changent jamais le verdict', async () => {
    const result = await lance({ balances: [solde('BTC', '1'), solde('USDC', '10000')], snapshot: HIER, flows: [APPORT] });
    expect(result.resync.status).toBe('NOT_NEEDED');
  });

  /*
   * Le lendemain d'une execution **et** d'un apport (§2 bis, #93) : nos
   * executions et les flux s'ajoutent a la meme base, sans recouvrement — l'un
   * echange une ligne contre une autre, l'autre entre de l'exterieur.
   */
  it('un apport le lendemain d’une execution : la divergence restante est expliquee', async () => {
    const achat = ordreEnAttente();
    const scenario = {
      // 0.5 BTC achetes a 60 000, 30 de frais : 10 000 - 30 030 + 30 700 d'apport = 10 670.
      balances: [solde('BTC', '1.5'), solde('USDC', '10670')],
      snapshot: photo({ BTC: qty('1'), USDC: qty('40000') }),
      pending: [achat],
      statuts: { 'exch-1': statutConnu({ filled: qty('0.5'), averageFilledPrice: new Decimal('60000') as Price, fees: new Decimal('30') as UsdcAmount }) },
    };
    const resync = resynchronise(await lance({ ...scenario, flows: [fluxEnregistre('2026-09-10T18:00:00.000Z', '700')] }));

    expect(resync.divergences.map((d) => [d.asset, d.internal.toString(), d.explainedByFlows])).toEqual([
      ['USDC', '9970', true],
    ]);
    expect(resync.explainedByFlows).toBe(true);
  });

  it('rend les flux lus pour le chainage, et n’en lit aucun sans photo', async () => {
    const avant = fluxEnregistre('2026-09-10T07:00:00.000Z', '1');
    const banc = harnais({ balances: APPORTE, snapshot: HIER, flows: [avant, APPORT] });
    const result = await reconcile(banc.input);
    // Tels que la requete les rend, borne incluse : le chainage applique le meme predicat.
    expect(result.flows).toEqual([avant, APPORT]);

    const premier = harnais({ balances: APPORTE, flows: [APPORT] });
    expect((await reconcile(premier.input)).flows).toEqual([]);
    expect(premier.appels).not.toContain('recentCashFlows');
  });
});
