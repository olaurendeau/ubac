import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ConvoyeurRoute } from '../../src/convoyeur/coinbase.js';
import {
  lireArguments,
  lireCle,
  mesurer,
  MesureRefusee,
  procheDuRun,
  type Arguments,
  type Cle,
  type Commande,
  type RouteMesure,
} from '../../scripts/mesures-convoyeur.js';

/**
 * Aucun reseau, aucune cle reelle : les deux transports sont simules et
 * journalisent ce qu'on leur demande. La preuve porte sur les **ecritures** —
 * `move_funds`, l'envoi et le retrait v2 — les lectures de soldes les encadrent.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRIMARY = '00000000-0000-4000-8000-0000000000a1';
const UBAC_AGENT = '00000000-0000-4000-8000-0000000000a2';
const MIDI_A_PARIS = new Date('2026-10-20T10:00:00Z');

/** Une cle piegee : chaque fragment ne doit jamais sortir. */
const PEM_LIGNE = 'MHcCAQEEIPiegePiegePiegePiegePiegePiegePiegeAoGCCqGSM49';
const CLE: Cle = {
  apiKey: 'organizations/org-piege-0123456789/apiKeys/cle-piege-abcdefghij',
  apiSecret: `-----BEGIN EC PRIVATE KEY-----\n${PEM_LIGNE}\n-----END EC PRIVATE KEY-----\n`,
};
const JETON = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJwaWVnZSJ9.c2lnbmF0dXJl';

const ECRITURES = new Set(['move_funds', 'envoi_v2', 'retrait_v2']);

function args(commande: Commande, plus: Partial<Arguments> = {}): Arguments {
  return { commande, cle: '/hors/depot.json', primary: PRIMARY, ubacAgent: UBAC_AGENT, ...plus };
}

function compte(currency: string, value: string): Record<string, unknown> {
  return {
    uuid: `compte-${currency}`,
    currency,
    available_balance: { value },
    hold: { value: '0' },
    retail_portfolio_id: PRIMARY,
  };
}

interface Scenario {
  readonly usdc?: string;
  readonly eur?: string;
  readonly confirmation?: (commande: Commande) => string;
  readonly ecriture?: () => unknown;
  readonly instant?: Date;
}

function simuler(scenario: Scenario = {}) {
  const routes: (ConvoyeurRoute | RouteMesure)[] = [];
  const sortie: string[] = [];
  const questions: string[] = [];
  const ecrire = (route: ConvoyeurRoute | RouteMesure): unknown => {
    routes.push(route);
    return (scenario.ecriture ?? (() => ({ source_portfolio_uuid: PRIMARY, target_portfolio_uuid: UBAC_AGENT })))();
  };
  const outils = {
    transport: {
      async call(route: ConvoyeurRoute): Promise<unknown> {
        if (route.kind === 'move_funds') return ecrire(route);
        routes.push(route);
        if (route.kind === 'key_permissions') {
          return { can_view: true, can_trade: true, can_transfer: true, portfolio_uuid: PRIMARY, portfolio_type: 'DEFAULT' };
        }
        if (route.kind === 'accounts') {
          return { accounts: [compte('EUR', scenario.eur ?? '5'), compte('USDC', scenario.usdc ?? '3')], has_next: false };
        }
        throw new Error(`route ${route.kind} inattendue`);
      },
      async close() {},
    },
    mesures: {
      async call(route: RouteMesure): Promise<unknown> {
        if (route.kind === 'moyens_de_paiement') {
          routes.push(route);
          return { payment_methods: [{ id: 'moyen-1', type: 'SEPA', currency: 'EUR', allow_withdraw: true, name: 'Banque' }] };
        }
        return ecrire(route);
      },
      async close() {},
    },
    demander: async (question: string) => {
      questions.push(question);
      return '';
    },
    ecrire: (ligne: string) => sortie.push(ligne),
    maintenant: () => scenario.instant ?? MIDI_A_PARIS,
    idem: () => 'idem-fixe',
    http: { dernier: 200 as number | undefined },
  };
  const lancer = (a: Arguments) =>
    mesurer(a, CLE, {
      ...outils,
      demander: async (question) => {
        questions.push(question);
        return scenario.confirmation?.(a.commande) ?? a.commande;
      },
    });
  return {
    lancer,
    routes,
    sortie,
    questions,
    ecritures: () => routes.filter((r) => ECRITURES.has(r.kind)),
  };
}

const MESURES = [
  args('mc1'),
  args('mc2-crypto', { adresse: '0xadresseDeLOperateur', reseau: 'base' }),
  args('mc2-eur', { moyen: 'moyen-1' }),
  args('mc3'),
];

describe('une mesure, une requete', () => {
  it.each(MESURES)('$commande confirmee envoie exactement une ecriture', async (a) => {
    const s = simuler();
    await s.lancer(a);
    expect(s.ecritures()).toHaveLength(1);
    expect(s.questions).toHaveLength(1);
  });

  it.each(MESURES)('$commande refusee par l exchange ne rejoue pas', async (a) => {
    const s = simuler({
      ecriture: () => {
        throw new Error('PERMISSION_DENIED');
      },
    });
    await s.lancer(a);
    expect(s.ecritures()).toHaveLength(1);
    expect(s.sortie.join('\n')).toContain('REFUSE : Error PERMISSION_DENIED');
  });

  it.each(MESURES)('$commande sans la confirmation exacte n envoie rien', async (a) => {
    for (const reponse of ['', 'oui', 'MC1', `${a.commande}x`]) {
      const s = simuler({ confirmation: () => reponse });
      await s.lancer(a);
      expect(s.ecritures()).toHaveLength(0);
      expect(s.sortie.at(-1)).toBe('Abandon : aucune requete envoyee.');
    }
  });

  it('moyens ne lit que les moyens de paiement, sans question', async () => {
    const s = simuler();
    await s.lancer(args('moyens'));
    expect(s.ecritures()).toHaveLength(0);
    expect(s.questions).toHaveLength(0);
    expect(s.sortie).toContain('moyen-1 SEPA EUR retrait=true Banque');
  });
});

describe('ce que chaque mesure demande', () => {
  it('mc1 tire d ubac-agent vers Primary, par le transport', async () => {
    const s = simuler();
    await s.lancer(args('mc1'));
    expect(s.ecritures()).toEqual([
      {
        kind: 'move_funds',
        body: {
          funds: { value: '1', currency: 'USDC' },
          source_portfolio_uuid: UBAC_AGENT,
          target_portfolio_uuid: PRIMARY,
        },
      },
    ]);
  });

  it('mc3 passe par le moveFunds du convoyeur, de Primary vers ubac-agent', async () => {
    const s = simuler();
    await s.lancer(args('mc3'));
    const [route] = s.ecritures();
    expect(route).toMatchObject({
      kind: 'move_funds',
      body: { source_portfolio_uuid: PRIMARY, target_portfolio_uuid: UBAC_AGENT, funds: { value: '1' } },
    });
  });

  it('mc2 vise les comptes de Primary, 1 USDC ou 1 EUR, vers l operateur', async () => {
    const crypto = simuler();
    await crypto.lancer(MESURES[1] as Arguments);
    expect(crypto.ecritures()).toEqual([
      {
        kind: 'envoi_v2',
        accountId: 'compte-USDC',
        body: { type: 'send', to: '0xadresseDeLOperateur', amount: '1', currency: 'USDC', network: 'base', idem: 'idem-fixe' },
      },
    ]);
    const eur = simuler();
    await eur.lancer(MESURES[2] as Arguments);
    expect(eur.ecritures()).toEqual([
      { kind: 'retrait_v2', accountId: 'compte-EUR', body: { amount: '1', currency: 'EUR', payment_method: 'moyen-1' } },
    ]);
  });

  it('les soldes avant et apres, le code et l instant sortent', async () => {
    const s = simuler();
    await s.lancer(args('mc3'));
    const texte = s.sortie.join('\n');
    expect(texte).toContain('avant  : Primary EUR 5 (gele 0), USDC 3 (gele 0)');
    expect(texte).toContain('apres  : Primary EUR 5');
    expect(texte).toContain('instant 2026-10-20T10:00:00.000Z, code HTTP inconnu');
  });
});

describe('aucune mesure sans preuve possible', () => {
  it.each([
    [args('mc3'), { usdc: '0.99' }],
    [MESURES[1] as Arguments, { usdc: '0' }],
    [MESURES[2] as Arguments, { eur: '0.5' }],
  ])('%# : une source qui ne porte pas le montant ne part pas, sans question', async (a, soldes) => {
    const s = simuler(soldes);
    await expect(s.lancer(a)).rejects.toThrow(/un refus pour solde ne prouverait rien/);
    expect(s.ecritures()).toHaveLength(0);
    expect(s.questions).toHaveLength(0);
  });

  it.each([
    ['2026-10-24T04:31:00Z', true], // 06:31, heure d'ete
    ['2026-10-24T05:29:00Z', true], // 07:29
    ['2026-10-24T04:30:00Z', false], // 06:30 : la marge est stricte
    ['2026-10-24T05:30:00Z', false], // 07:30
    ['2026-11-15T05:45:00Z', true], // 06:45, heure d'hiver
    ['2026-11-15T04:45:00Z', false], // 05:45
  ])('%s proche du run d Ubac : %s', (iso, proche) => {
    expect(procheDuRun(new Date(iso))).toBe(proche);
  });

  it('pres de 07:00, rien ne part, pas meme une lecture', async () => {
    const s = simuler({ instant: new Date('2026-11-15T05:50:00Z') });
    await expect(s.lancer(args('mc1'))).rejects.toThrow(MesureRefusee);
    expect(s.routes).toHaveLength(0);
  });
});

describe('aucun secret dans la sortie', () => {
  it.each(MESURES)('$commande, refusee avec la cle et un jeton dans le message', async (a) => {
    const s = simuler({
      ecriture: () => {
        throw new Error(`refus ${CLE.apiKey} Authorization: Bearer ${JETON} ${JSON.stringify(CLE.apiSecret)}`);
      },
    });
    await s.lancer(a);
    const texte = s.sortie.join('\n');
    for (const fragment of [CLE.apiKey, 'org-piege-0123456789', 'cle-piege-abcdefghij', PEM_LIGNE, JETON]) {
      expect(texte).not.toContain(fragment);
    }
    expect(texte).toContain('REFUSE : Error refus [masque]');
  });

  it('une reponse acceptee qui rend la cle ne la montre pas', async () => {
    const s = simuler({ ecriture: () => ({ echo: CLE.apiKey, jeton: JETON }) });
    await s.lancer(MESURES[1] as Arguments);
    expect(s.sortie.join('\n')).not.toMatch(/piege|eyJ/);
  });
});

describe('la cle et les arguments', () => {
  it('une cle rangee dans le depot est refusee', async () => {
    await expect(lireCle(resolve(ROOT, 'cle.json'), ROOT)).rejects.toThrow(/dans le depot/);
  });

  it('les deux formes CDP se lisent, un fichier malforme ne se recite pas', async () => {
    const dossier = await mkdtemp(resolve(tmpdir(), 'mesures-'));
    const ecdsa = resolve(dossier, 'ecdsa.json');
    await writeFile(ecdsa, JSON.stringify({ name: CLE.apiKey, privateKey: CLE.apiSecret }));
    await expect(lireCle(ecdsa, ROOT)).resolves.toEqual(CLE);
    const ed = resolve(dossier, 'ed.json');
    await writeFile(ed, JSON.stringify({ id: 'cle-ed', privateKey: 'c2VjcmV0' }));
    await expect(lireCle(ed, ROOT)).resolves.toEqual({ apiKey: 'cle-ed', apiSecret: 'c2VjcmV0' });
    const casse = resolve(dossier, 'casse.json');
    await writeFile(casse, `${PEM_LIGNE} pas du json`);
    const refus = await lireCle(casse, ROOT).catch((e: unknown) => e);
    expect(refus).toBeInstanceOf(MesureRefusee);
    expect(String((refus as Error).message)).not.toContain('Piege');
  });

  it('chaque mesure exige ce qui la rend sure', () => {
    const base = ['--cle', '/k.json', '--primary', PRIMARY, '--ubac-agent', UBAC_AGENT];
    expect(lireArguments(['mc1', ...base])).toMatchObject({ commande: 'mc1', primary: PRIMARY });
    expect(() => lireArguments(['mc2-crypto', ...base])).toThrow(/--adresse/);
    expect(() => lireArguments(['mc2-eur', ...base])).toThrow(/--moyen/);
    expect(() => lireArguments(['mc4', ...base])).toThrow(/inconnue/);
    expect(() => lireArguments(['mc1', '--cle', '/k.json'])).toThrow(/exiges/);
    expect(() => lireArguments(['mc1', ...base, '--montant', '100'])).toThrow(/inconnue/);
  });
});

describe('hors de toute image', () => {
  it('seul src/ se compile pour l image, et rien ne copie le script', async () => {
    const build = await readFile(resolve(ROOT, 'tsconfig.build.json'), 'utf8');
    expect(build).toMatch(/"include":\s*\["src\/\*\*\/\*\.ts"\]/);
    const dockerfile = await readFile(resolve(ROOT, 'Dockerfile.prod'), 'utf8');
    expect(dockerfile).not.toContain('mesures-convoyeur');
    expect(dockerfile).not.toMatch(/^COPY\s+(--\S+\s+)*scripts\/?\s/m);
  });
});
