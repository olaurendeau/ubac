import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { HttpRequest, HttpSend } from '../../src/adapters/http.js';
import type { Envoi, Envoyer } from '../../src/convoyeur/ntfy.js';
import { openNtfy, rendreCompte } from '../../src/convoyeur/ntfy.js';
import type { CompteRendu, Notification } from '../../src/convoyeur/regles.js';
import type { Achat, EurAmount, UsdcAmount } from '../../src/convoyeur/types.js';

/** CV17 : ce que le convoyeur pousse sur ntfy, et quand il se tait (Y5). */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CANAL = { ntfyUrl: 'https://ntfy.test', ntfyTopic: 'ubac-de-test', ntfyToken: 'jeton-de-test' };

const ACHAT: Achat = {
  orderId: 'ex-1',
  filledSize: new Decimal('99.4') as UsdcAmount,
  filledValue: new Decimal('99.4') as EurAmount,
  totalFees: new Decimal('0.6') as EurAmount,
};
const eur = (v: string): EurAmount => new Decimal(v) as EurAmount;

const COMPTES: Readonly<Record<string, CompteRendu>> = {
  convoyage: { nature: 'CONVOYAGE', convoyage: '2026-11-27', etape: 'ENREGISTRE', achat: ACHAT, eurLaisse: eur('20'), motif: undefined, poussiere: undefined },
  refus: { nature: 'REFUS', convoyage: undefined, etape: undefined, achat: undefined, eurLaisse: eur('120'), motif: 'USDC etranger', poussiere: undefined },
  reprise: { nature: 'REPRISE', convoyage: '2026-11-27', etape: 'ENREGISTRE', achat: ACHAT, eurLaisse: eur('0'), motif: undefined, poussiere: undefined },
  panne: { nature: 'PANNE', convoyage: '2026-11-27', etape: 'ACHETE', achat: ACHAT, eurLaisse: eur('0'), motif: 'soldes', poussiere: undefined },
};

function envoyeur(envoi: Envoi = { statut: 'ENVOYE' }): { envoyer: Envoyer; envoyees: Notification[] } {
  const envoyees: Notification[] = [];
  return {
    envoyees,
    envoyer: (n) => {
      envoyees.push(n);
      return Promise.resolve(envoi);
    },
  };
}

describe('CV17 — un passage qui fait quelque chose notifie, les autres se taisent', () => {
  it('un passage sans convoyage n’envoie rien', async () => {
    const { envoyer, envoyees } = envoyeur();
    const logs: string[] = [];
    expect(await rendreCompte(undefined, 'DRY_RUN', envoyer, (l) => logs.push(l))).toBe(0);
    expect(envoyees).toEqual([]);
    expect(logs).toEqual(['aucune notification : passage sans convoyage']);
  });

  it.each(Object.keys(COMPTES))('%s : une notification, EUR, USDC, frais, etape et EUR laisse', async (nom) => {
    for (const [marque, prefixe] of [
      ['DRY_RUN', 'convoyeur DRY_RUN — '],
      [undefined, 'convoyeur — '],
    ] as const) {
      const { envoyer, envoyees } = envoyeur();
      await rendreCompte(COMPTES[nom], marque, envoyer, () => undefined);
      expect(envoyees).toHaveLength(1);
      const [n] = envoyees;
      expect(n?.titre).toBe(`${prefixe}${nom}`);
      for (const ligne of ['EUR debite : ', 'USDC recu : ', 'frais : ', 'etape atteinte : ', 'EUR laisse dans Primary : ']) {
        expect(n?.corps).toContain(ligne);
      }
    }
  });

  it('sort en 0 sur un convoyage complet parti, en 1 sur un compte urgent ou perdu', async () => {
    const codes = await Promise.all(
      Object.values(COMPTES).map((c) => rendreCompte(c, undefined, envoyeur().envoyer, () => undefined)),
    );
    expect(codes).toEqual([0, 1, 0, 1]);
    const perdu = envoyeur({ statut: 'ECHEC', motif: 'delai' });
    const logs: string[] = [];
    expect(await rendreCompte(COMPTES['convoyage'], undefined, perdu.envoyer, (l) => logs.push(l))).toBe(1);
    expect(logs).toEqual(['notification HIGH « convoyeur — convoyage » : en echec, delai']);
  });

  it('aucun module d’email dans le convoyeur', async () => {
    const dossier = resolve(ROOT, 'src/convoyeur');
    const fichiers = (await readdir(dossier)).filter((f) => f.endsWith('.ts'));
    expect(fichiers).toContain('main.ts');
    for (const fichier of fichiers) {
      const source = await readFile(resolve(dossier, fichier), 'utf8');
      expect(source.match(/from '[^']*(mailer|brevo)[^']*'/gi) ?? [], fichier).toEqual([]);
    }
  });
});

describe('le canal ntfy', () => {
  function transport(rendu: Awaited<ReturnType<HttpSend>> | Error): { send: HttpSend; requetes: HttpRequest[] } {
    const requetes: HttpRequest[] = [];
    return {
      requetes,
      send: (r) => {
        requetes.push(r);
        return rendu instanceof Error ? Promise.reject(rendu) : Promise.resolve(rendu);
      },
    };
  }
  const N: Notification = { titre: 'convoyeur DRY_RUN — convoyage', corps: 'EUR debite : 100 EUR', priorite: 'HIGH' };

  it('publie en JSON sur la racine, avec le jeton en en-tete', async () => {
    const { send, requetes } = transport({ status: 'OK', httpStatus: 200 });
    expect(await openNtfy(CANAL, send)(N)).toEqual({ statut: 'ENVOYE' });
    expect(requetes).toEqual([
      {
        url: 'https://ntfy.test/',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jeton-de-test' },
        body: JSON.stringify({ topic: 'ubac-de-test', title: N.titre, message: N.corps, priority: 4, tags: ['convoyeur'] }),
      },
    ]);
  });

  it('n’envoie aucun en-tete d’autorisation sur un canal ouvert, et URGENT vaut 5', async () => {
    const { send, requetes } = transport({ status: 'OK', httpStatus: 200 });
    await openNtfy({ ...CANAL, ntfyToken: null }, send)({ ...N, priorite: 'URGENT' });
    expect(requetes[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(requetes[0]?.body ?? '{}')).toMatchObject({ priority: 5 });
  });

  it('ne rejette jamais, et ne recopie rien du transport', async () => {
    const refus = transport({ status: 'FAILED', failure: { kind: 'REFUS', httpStatus: 401 } });
    const leve = transport(new Error('jeton-de-test refuse par https://ntfy.test'));
    const [a, b] = [await openNtfy(CANAL, refus.send)(N), await openNtfy(CANAL, leve.send)(N)];
    expect(a.statut).toBe('ECHEC');
    expect(b).toEqual({ statut: 'ECHEC', motif: 'transport en echec' });
    expect(JSON.stringify([a, b])).not.toContain('jeton-de-test');
  });
});
