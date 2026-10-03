import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { ConvoyeurBase } from '../../src/convoyeur/base.js';
import type { ConfigPassage, PortsPassage } from '../../src/convoyeur/passage.js';
import { PAUSE_MS, TENTATIVES, passage } from '../../src/convoyeur/passage.js';
import { clientOrderIdConvoyage, notification } from '../../src/convoyeur/regles.js';
import type { CompteRendu } from '../../src/convoyeur/regles.js';
import type { DoubleBase, DoubleCoinbase } from './doubles.js';
import { PRIMARY, RECU, UBAC_AGENT, doubleBase, doubleCoinbase } from './doubles.js';

/**
 * Le passage (Y4b) de bout en bout sur doubles : CV5, CV6 (rejeu), CV7, CV8,
 * CV9, CV10, CV11, CV13. Une panne est une frontiere qui leve au-dela de ses
 * tentatives : le passage s'arrete la, et le suivant reprend d'apres le
 * journal et les soldes, comme apres un conteneur tue.
 */

const CONFIG: ConfigPassage = {
  primaryUuid: PRIMARY,
  destinationUuid: UBAC_AGENT,
  tentatives: TENTATIVES,
  pauseMs: PAUSE_MS,
};

/** 19:00 a Paris en hiver ; le run d'Ubac est a 07:00, soit 06:00 UTC. */
const soir = (jour: string): Date => new Date(`${jour}T18:00:00.000Z`);
const run = (jour: string): Date => new Date(`${jour}T06:00:00.000Z`);

interface Banc {
  readonly ports: PortsPassage;
  readonly logs: string[];
  readonly pauses: number[];
}

/** L'horloge des etapes avance d'une seconde par lecture, depuis l'instant du passage. */
function banc(coinbase: DoubleCoinbase, base: ConvoyeurBase, instant: Date): Banc {
  const logs: string[] = [];
  const pauses: number[] = [];
  let t = instant.getTime();
  const ports: PortsPassage = {
    coinbase,
    base,
    horloge: () => new Date((t += 1_000)),
    pause: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    log: (ligne) => logs.push(ligne),
  };
  return { ports, logs, pauses };
}

async function passer(coinbase: DoubleCoinbase, base: ConvoyeurBase, jour: string) {
  const b = banc(coinbase, base, soir(jour));
  const compteRendu = await passage(b.ports, CONFIG, soir(jour));
  return { compteRendu, ...b };
}

/** La base, dont une ecriture leve `fois` fois : une etape nommee, ou l'apport. */
function fragile(base: DoubleBase, quoi: string, fois: number): ConvoyeurBase {
  let reste = fois;
  const tomber = (cible: string): void => {
    if (cible === quoi && reste > 0) {
      reste -= 1;
      throw new Error(`base : ${cible} en panne`);
    }
  };
  return {
    dernierConvoyage: () => base.dernierConvoyage(),
    ecrireEtape: async (etape) => {
      tomber(etape.etape);
      return base.ecrireEtape(etape);
    },
    ecrireApport: async (apport) => {
      tomber('APPORT');
      return base.ecrireApport(apport);
    },
  };
}

const etapes = (base: DoubleBase): readonly string[] => base.journal.map((l) => l.step);
const urgent = (cr: CompteRendu | undefined): boolean =>
  cr !== undefined && notification(cr).priorite === 'URGENT';
const instantDe = (base: DoubleBase, etape: string): Date | undefined =>
  base.journal.find((l) => l.step === etape)?.occurredAt;

describe('Y4b — un convoyage complet', () => {
  it('CV5 : sous 100 EUR, une ligne de journal, aucun compte rendu, aucune ecriture', async () => {
    const coinbase = doubleCoinbase('99.99');
    const base = doubleBase();
    const { compteRendu, logs } = await passer(coinbase, base, '2026-11-27');
    expect(compteRendu).toBeUndefined();
    expect(logs.filter((l) => l.startsWith('rien a faire'))).toEqual([
      expect.stringContaining('99.99 EUR disponibles'),
    ]);
    expect(base.journal).toEqual([]);
    expect(coinbase.appels).toEqual(['keyPermissions', 'balances']);
  });

  it('CV8, CV11 : cinq etapes, un ordre, filled_size transfere, une ligne a l’instant de la demande', async () => {
    const coinbase = doubleCoinbase('130');
    const base = doubleBase();
    const vus: string[] = [];
    // DC6 : l'etape d'annonce est dans le journal quand l'appel part.
    coinbase.espion = (m) => vus.push(`${m}@${base.journal.at(-1)?.step ?? '-'}`);
    const { compteRendu } = await passer(coinbase, base, '2026-11-27');

    expect(etapes(base)).toEqual(['ACHAT_DEMANDE', 'ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE', 'ENREGISTRE']);
    expect(vus).toContain('marketBuy@ACHAT_DEMANDE');
    expect(vus).toContain('moveFunds@TRANSFERT_DEMANDE');
    expect(coinbase.ordresCrees).toEqual([clientOrderIdConvoyage('2026-11-27')]);
    expect(coinbase.transferts.map((d) => d.toFixed())).toEqual([RECU.toFixed()]);
    expect(coinbase.usdcUbac.toFixed()).toBe('99.400001');
    expect(base.apports).toHaveLength(1);
    expect(base.apports[0]?.amountUsdc.toFixed()).toBe('99.400001');
    expect(base.apports[0]?.occurredAt).toEqual(instantDe(base, 'TRANSFERT_DEMANDE'));
    expect(compteRendu).toMatchObject({ nature: 'CONVOYAGE', etape: 'ENREGISTRE', motif: undefined });
    expect(compteRendu?.eurLaisse?.toFixed()).toBe('30');
    expect(urgent(compteRendu)).toBe(false);
  });

  it('CV7 : 250 EUR donnent 100, 100, puis rien avec 50 signales ; un second lancement ne rachete pas', async () => {
    const coinbase = doubleCoinbase('250');
    const base = doubleBase();
    expect((await passer(coinbase, base, '2026-11-27')).compteRendu?.etape).toBe('ENREGISTRE');
    const relance = await passer(coinbase, base, '2026-11-27');
    expect(relance.compteRendu).toBeUndefined();
    expect(relance.logs.join('\n')).toContain('deja enregistre');
    expect((await passer(coinbase, base, '2026-11-28')).compteRendu?.etape).toBe('ENREGISTRE');
    const dernier = await passer(coinbase, base, '2026-11-29');
    expect(dernier.compteRendu).toBeUndefined();
    expect(dernier.logs.join('\n')).toContain('50 EUR disponibles');
    expect(coinbase.ordresCrees).toHaveLength(2);
    expect(base.apports).toHaveLength(2);
  });

  it('CV1 : une cle refusee arrete avant tout solde, sans EUR a dire', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.cle = { ...coinbase.cle, canTransfer: false };
    const { compteRendu } = await passer(coinbase, doubleBase(), '2026-11-27');
    expect(compteRendu).toMatchObject({ nature: 'REFUS', etape: undefined, eurLaisse: undefined });
    expect(coinbase.appels).toEqual(['keyPermissions']);
    expect(notification(compteRendu as CompteRendu).corps).toContain('EUR laisse dans Primary : non lu');
  });
});

describe('Y4b — reprendre sans jamais deux achats ni deux transferts (CV6, CV9)', () => {
  it('CV6 : un accuse d’achat perdu se retente sous le meme client_order_id, un seul ordre', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.pannes.marketBuy = { fois: 1, apres: true };
    const base = doubleBase();
    expect((await passer(coinbase, base, '2026-11-27')).compteRendu?.etape).toBe('ENREGISTRE');
    expect(coinbase.appels.filter((m) => m === 'marketBuy')).toHaveLength(2);
    expect(coinbase.ordresCrees).toHaveLength(1);
  });

  it('CV9 : arrete a ACHAT_DEMANDE, le passage suivant relit l’ordre sans racheter ni commencer', async () => {
    const coinbase = doubleCoinbase('250');
    coinbase.pannes.marketBuy = { fois: TENTATIVES, apres: true };
    const base = doubleBase();
    const premier = await passer(coinbase, base, '2026-11-27');
    expect(premier.compteRendu).toMatchObject({ nature: 'PANNE', convoyage: '2026-11-27', etape: 'ACHAT_DEMANDE' });
    expect(urgent(premier.compteRendu)).toBe(true);

    const second = await passer(coinbase, base, '2026-11-28');
    expect(second.compteRendu).toMatchObject({ nature: 'REPRISE', convoyage: '2026-11-27', etape: 'ENREGISTRE' });
    expect(coinbase.ordresCrees).toEqual([clientOrderIdConvoyage('2026-11-27')]);
    // Finir, ou commencer : 150 EUR restent, et le 28 n'ouvre rien.
    expect(base.journal.every((l) => l.day === '2026-11-27')).toBe(true);
    expect(second.compteRendu?.eurLaisse?.toFixed()).toBe('150');
  });

  it('CV9 : arrete apres l’achat, le passage suivant transfere sans racheter', async () => {
    const coinbase = doubleCoinbase('250');
    const journal = doubleBase();
    const premier = await passer(coinbase, fragile(journal, 'TRANSFERT_DEMANDE', TENTATIVES), '2026-11-27');
    expect(premier.compteRendu?.etape).toBe('ACHETE');
    expect(coinbase.appels).not.toContain('moveFunds');

    const second = await passer(coinbase, journal, '2026-11-28');
    expect(second.compteRendu).toMatchObject({ nature: 'REPRISE', etape: 'ENREGISTRE' });
    expect(coinbase.ordresCrees).toHaveLength(1);
    expect(coinbase.transferts).toHaveLength(1);
  });

  it('CV9 : un move_funds fait mais non acquitte n’est pas rappele, le solde le constate', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.pannes.moveFunds = { fois: 1, apres: true };
    const base = doubleBase();
    expect((await passer(coinbase, base, '2026-11-27')).compteRendu?.etape).toBe('ENREGISTRE');
    expect(coinbase.appels.filter((m) => m === 'moveFunds')).toHaveLength(1);
    expect(base.apports[0]?.occurredAt).toEqual(instantDe(base, 'TRANSFERT_DEMANDE'));
  });

  it('un solde illisible apres move_funds ne vaut pas transfert : ni TRANSFERE, ni ligne', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.pannes.moveFunds = { fois: 1 };
    coinbase.espion = (m) => {
      if (m === 'moveFunds') coinbase.pannes.balances = { fois: TENTATIVES };
    };
    const base = doubleBase();
    const { compteRendu } = await passer(coinbase, base, '2026-11-27');
    expect(compteRendu?.etape).toBe('TRANSFERT_DEMANDE');
    expect(etapes(base)).not.toContain('TRANSFERE');
    expect(base.apports).toEqual([]);
  });

  it('CV9 : arrete apres le transfert, aucun second move_funds ; l’instant est celui de la demande', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.pannes.moveFunds = { fois: 1, apres: true };
    const journal = doubleBase();
    const premier = await passer(coinbase, fragile(journal, 'TRANSFERE', TENTATIVES), '2026-11-27');
    expect(premier.compteRendu?.etape).toBe('TRANSFERT_DEMANDE');
    expect(notification(premier.compteRendu as CompteRendu).corps).toContain('transfert non constate');

    const second = await passer(coinbase, journal, '2026-11-28');
    expect(second.compteRendu?.etape).toBe('ENREGISTRE');
    expect(coinbase.appels.filter((m) => m === 'moveFunds')).toHaveLength(1);
    expect(journal.apports[0]?.occurredAt).toEqual(instantDe(journal, 'TRANSFERT_DEMANDE'));
  });

  it('CV11 : arrete entre transfert et ecriture, la ligne s’ecrit au passage suivant, une seule', async () => {
    const coinbase = doubleCoinbase('100');
    const journal = doubleBase();
    const premier = await passer(coinbase, fragile(journal, 'APPORT', TENTATIVES), '2026-11-27');
    expect(premier.compteRendu?.etape).toBe('TRANSFERE');
    expect(notification(premier.compteRendu as CompteRendu).corps).toContain('ligne cash_flows absente');

    await passer(coinbase, journal, '2026-11-28');
    await passer(coinbase, journal, '2026-11-29');
    expect(coinbase.transferts).toHaveLength(1);
    expect(journal.apports).toHaveLength(1);
    expect(journal.apports[0]?.occurredAt).toEqual(instantDe(journal, 'TRANSFERE'));
  });

  /*
   * Point laisse ouvert par Y2. Le `move_funds` du 27 n'a pas eu lieu ; le 28,
   * l'USDC est toujours dans Primary et le passage le transfere. L'apport doit
   * tomber dans la fenetre ou l'USDC arrive, ]run du 28, run du 29] : l'instant
   * de la demande du 27, anterieur au run du 28, l'en ferait sortir pour
   * toujours (K3).
   */
  it('un transfert refait le lendemain prend l’instant de sa propre demande, dans la bonne fenetre', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.pannes.moveFunds = { fois: 1 };
    const journal = doubleBase();
    const premier = await passer(coinbase, journal, '2026-11-27');
    expect(premier.compteRendu?.etape).toBe('TRANSFERT_DEMANDE');
    expect(coinbase.appels.filter((m) => m === 'moveFunds')).toHaveLength(1);
    expect(coinbase.usdcUbac.isZero()).toBe(true);

    const second = await passer(coinbase, journal, '2026-11-28');
    expect(second.compteRendu?.etape).toBe('ENREGISTRE');
    expect(coinbase.transferts).toHaveLength(1);
    const ecrit = journal.apports[0]?.occurredAt ?? new Date(0);
    expect(ecrit > run('2026-11-28') && ecrit <= run('2026-11-29')).toBe(true);
    expect(ecrit).toEqual(instantDe(journal, 'TRANSFERE'));
    expect(ecrit).not.toEqual(instantDe(journal, 'TRANSFERT_DEMANDE'));
  });
});

describe('Y4b — arreter, et le dire (CV10, CV13)', () => {
  it('CV10 : un USDC etranger sans convoyage ouvert : aucun achat, aucun transfert, urgent', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.usdcPrimary = new Decimal('5');
    const base = doubleBase();
    const { compteRendu } = await passer(coinbase, base, '2026-11-27');
    expect(compteRendu).toMatchObject({ nature: 'REFUS', etape: undefined });
    expect(urgent(compteRendu)).toBe(true);
    expect(coinbase.appels).toEqual(['keyPermissions', 'balances']);
    expect(base.journal).toEqual([]);
  });

  it('CV10 : un USDC relu ni nul ni filled_size met en panne sans transfert ; la cloture rouvre', async () => {
    const coinbase = doubleCoinbase('300');
    const base = doubleBase();
    await passer(coinbase, fragile(base, 'TRANSFERT_DEMANDE', TENTATIVES), '2026-11-27');
    coinbase.usdcPrimary = coinbase.usdcPrimary.plus(1);
    const panne = await passer(coinbase, base, '2026-11-28');
    expect(panne.compteRendu).toMatchObject({ nature: 'PANNE', etape: 'EN_PANNE' });
    expect(urgent(panne.compteRendu)).toBe(true);
    expect(coinbase.appels).not.toContain('moveFunds');

    // Chaque passage redit la panne, et ne commence rien malgre 200 EUR.
    const lendemain = await passer(coinbase, base, '2026-11-29');
    expect(lendemain.compteRendu).toMatchObject({ nature: 'PANNE', etape: 'EN_PANNE' });
    expect(coinbase.ordresCrees).toHaveLength(1);

    // Le geste de l'operateur (docs/convoyeur.md §8) : l'USDC transfere a la
    // main avec sa ligne, puis `ENREGISTRE` sur le convoyage en panne.
    coinbase.usdcPrimary = new Decimal(0);
    await base.ecrireEtape({ etape: 'ENREGISTRE', convoyage: '2026-11-27', le: soir('2026-11-29') });
    const rouvert = await passer(coinbase, base, '2026-11-30');
    expect(rouvert.compteRendu).toMatchObject({ nature: 'CONVOYAGE', convoyage: '2026-11-30', etape: 'ENREGISTRE' });
  });

  it('un ordre jamais rempli : ACHAT_DEMANDE laissee, urgent, des pauses injectees et bornees', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.statut = 'OPEN';
    const base = doubleBase();
    const { compteRendu, pauses } = await passer(coinbase, base, '2026-11-27');
    expect(compteRendu).toMatchObject({ nature: 'PANNE', etape: 'ACHAT_DEMANDE' });
    expect(urgent(compteRendu)).toBe(true);
    expect(etapes(base)).toEqual(['ACHAT_DEMANDE']);
    expect(coinbase.appels.filter((m) => m === 'order')).toHaveLength(TENTATIVES);
    expect(pauses).toEqual(Array.from({ length: TENTATIVES - 1 }, () => PAUSE_MS));
    expect(coinbase.transferts).toEqual([]);
  });

  it('un ordre clos sans etre rempli : EN_PANNE, rien de transfere', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.statut = 'CANCELLED';
    const base = doubleBase();
    const { compteRendu } = await passer(coinbase, base, '2026-11-27');
    expect(compteRendu).toMatchObject({ nature: 'PANNE', etape: 'EN_PANNE' });
    expect(etapes(base)).toEqual(['ACHAT_DEMANDE', 'EN_PANNE']);
  });

  it('une etape d’annonce deja ecrite par un autre passage arrete sans appel', async () => {
    const coinbase = doubleCoinbase('100');
    const base = doubleBase();
    await base.ecrireEtape({ etape: 'ACHAT_DEMANDE', convoyage: '2026-11-27', le: soir('2026-11-27') });
    const perime: ConvoyeurBase = { ...base, dernierConvoyage: () => Promise.resolve(undefined) };
    const { compteRendu } = await passer(coinbase, perime, '2026-11-27');
    expect(compteRendu?.nature).toBe('PANNE');
    expect(compteRendu?.motif).toContain('deja ecrit par un autre passage');
    expect(coinbase.appels).not.toContain('marketBuy');
  });

  it('une lecture qui echoue au-dela de ses tentatives rend une panne, pas une exception', async () => {
    const coinbase = doubleCoinbase('100');
    coinbase.pannes.balances = { fois: TENTATIVES };
    const { compteRendu, pauses } = await passer(coinbase, doubleBase(), '2026-11-27');
    expect(compteRendu).toMatchObject({ nature: 'PANNE', etape: undefined });
    expect(compteRendu?.motif).toContain('balances : panne');
    expect(pauses).toHaveLength(TENTATIVES - 1);
  });
});

describe('DC10 — une poussiere dans Primary (decision du 2026-10-03)', () => {
  /** Le solde du premier DRY_RUN reel, le 2026-10-03 a 21:54Z, avec 0.0077 EUR. */
  const CONSTATEE = '0.0000008962268961';

  const avecPoussiere = (eur: string, poussiere: string): DoubleCoinbase => {
    const coinbase = doubleCoinbase(eur);
    coinbase.usdcPrimary = new Decimal(poussiere);
    return coinbase;
  };

  it('le constat du 2026-10-03 : ni refus ni notification, une ligne de journal dit la poussiere', async () => {
    const coinbase = avecPoussiere('0.0077', CONSTATEE);
    const base = doubleBase();
    const { compteRendu, logs } = await passer(coinbase, base, '2026-10-03');
    expect(compteRendu).toBeUndefined();
    expect(logs).toContain(`poussiere ignoree dans Primary : ${CONSTATEE} USDC, sous le seuil de 1 USDC`);
    expect(coinbase.appels).toEqual(['keyPermissions', 'balances']);
    expect(base.journal).toEqual([]);
  });

  it.each(['0.0000009', '0.99'])(
    'avec %s USDC, convoie filled_size seul, laisse la poussiere, et la dit sans urgence',
    async (poussiere) => {
      const coinbase = avecPoussiere('230', poussiere);
      const base = doubleBase();
      const { compteRendu } = await passer(coinbase, base, '2026-11-27');
      expect(etapes(base)).toEqual(['ACHAT_DEMANDE', 'ACHETE', 'TRANSFERT_DEMANDE', 'TRANSFERE', 'ENREGISTRE']);
      expect(coinbase.transferts.map((d) => d.toFixed())).toEqual([RECU.toFixed()]);
      expect(coinbase.usdcPrimary.toFixed()).toBe(poussiere);
      expect(base.apports.map((l) => l.amountUsdc.toFixed())).toEqual([RECU.toFixed()]);
      expect(compteRendu?.poussiere?.toFixed()).toBe(poussiere);
      const note = notification(compteRendu as CompteRendu);
      expect(note.priorite).toBe('HIGH');
      expect(note.corps).toContain(`poussiere ignoree dans Primary : ${poussiere} USDC`);

      // Le lendemain, la poussiere restee n'arrete pas le convoyage suivant.
      expect((await passer(coinbase, base, '2026-11-28')).compteRendu?.etape).toBe('ENREGISTRE');
      expect(coinbase.ordresCrees).toHaveLength(2);
      expect(coinbase.transferts).toHaveLength(2);
      expect(coinbase.usdcPrimary.toFixed()).toBe(poussiere);
    },
  );

  it.each(['0.0000009', '0.99'])('avec %s USDC, arrete apres l’achat, le passage suivant transfere une fois', async (poussiere) => {
    const coinbase = avecPoussiere('250', poussiere);
    const journal = doubleBase();
    expect((await passer(coinbase, fragile(journal, 'TRANSFERT_DEMANDE', TENTATIVES), '2026-11-27')).compteRendu?.etape).toBe('ACHETE');
    const second = await passer(coinbase, journal, '2026-11-28');
    expect(second.compteRendu).toMatchObject({ nature: 'REPRISE', etape: 'ENREGISTRE' });
    expect(coinbase.ordresCrees).toHaveLength(1);
    expect(coinbase.transferts.map((d) => d.toFixed())).toEqual([RECU.toFixed()]);
  });

  it.each(['0.0000009', '0.99'])('avec %s USDC, un transfert fait puis une panne : constate, jamais refait', async (poussiere) => {
    const coinbase = avecPoussiere('100', poussiere);
    coinbase.pannes.moveFunds = { fois: 1, apres: true };
    const journal = doubleBase();
    expect((await passer(coinbase, fragile(journal, 'TRANSFERE', TENTATIVES), '2026-11-27')).compteRendu?.etape).toBe('TRANSFERT_DEMANDE');
    const second = await passer(coinbase, journal, '2026-11-28');
    expect(second.compteRendu?.etape).toBe('ENREGISTRE');
    expect(coinbase.appels.filter((m) => m === 'moveFunds')).toHaveLength(1);
    expect(journal.apports).toHaveLength(1);
    expect(journal.apports[0]?.occurredAt).toEqual(instantDe(journal, 'TRANSFERT_DEMANDE'));
  });

  /*
   * La relecture apres `move_funds` lit le solde comme la table : une premiere
   * lecture perdue laisse le solde d'avant, filled_size plus la poussiere. Une
   * egalite a filled_size le prendrait pour un changement et arreterait le
   * passage sans relire.
   */
  it('une relecture perdue apres move_funds se relit, sans second move_funds', async () => {
    const coinbase = avecPoussiere('100', '0.99');
    coinbase.espion = (m) => {
      if (m === 'moveFunds') coinbase.pannes.balances = { fois: 1 };
    };
    const base = doubleBase();
    const { compteRendu } = await passer(coinbase, base, '2026-11-27');
    expect(compteRendu?.etape).toBe('ENREGISTRE');
    expect(coinbase.appels.filter((m) => m === 'moveFunds')).toHaveLength(1);
    expect(base.apports).toHaveLength(1);
  });

  it('1 USDC dans Primary reste etranger : refus urgent, aucun achat', async () => {
    const coinbase = avecPoussiere('100', '1');
    const { compteRendu } = await passer(coinbase, doubleBase(), '2026-11-27');
    expect(compteRendu).toMatchObject({ nature: 'REFUS', poussiere: undefined });
    expect(urgent(compteRendu)).toBe(true);
    expect(coinbase.ordresCrees).toEqual([]);
  });
});
