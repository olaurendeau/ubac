/**
 * Les mesures MC1 a MC3 (spec convoyeur, CV20 a CV22) : une commande de poste,
 * lancee **par l'operateur**, jamais par un agent ni par la chaine. Mode
 * d'emploi et rapport attendu : docs/convoyeur-mesures.md.
 *
 * Hors de `src/`, donc hors de toute image (`tsconfig.build.json` ne compile
 * que `src/`) et hors du champ de CV4, qui ne vise que `src/convoyeur/`. C'est
 * la seule place du depot ou la v2 d'envoi et de retrait est ecrite : MC2 doit
 * la tenter pour constater qu'elle est refusee. Tout le reste passe par
 * l'adapter du convoyeur tel quel — sa cle verifiee, ses soldes, son
 * `moveFunds` pour MC3 — et MC1 par son transport, puisque le port refuse
 * avant tout appel la source que MC1 doit justement essayer (CV2).
 *
 * Quatre proprietes, tenues par test/scripts/mesures-convoyeur.test.ts :
 * 1. une mesure envoie **une** requete d'ecriture, jamais deux, jamais un rejeu ;
 * 2. aucune sans la confirmation tapee par l'operateur ;
 * 3. aucune si la source lisible ne porte pas le montant : un refus pour solde
 *    insuffisant ne prouverait rien (plan, Y10, piege 2) ;
 * 4. la sortie ne porte ni la cle, ni un jeton, ni un en-tete.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import ccxt from 'ccxt';
import { Decimal } from 'decimal.js';

import {
  ccxtConvoyeurTransport,
  openConvoyeurCoinbase,
  type ConvoyeurCoinbase,
  type ConvoyeurTransport,
} from '../src/convoyeur/coinbase.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const COMMANDES = ['mc1', 'mc2-crypto', 'mc2-eur', 'mc3', 'moyens'] as const;
export type Commande = (typeof COMMANDES)[number];

/** Le minimum qui prouve : 1 USDC, ou 1 EUR pour le retrait. */
const MONTANT = '1';

export class MesureRefusee extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MesureRefusee';
  }
}

// --- Les routes que l'adapter du convoyeur n'a pas, et ne doit pas avoir ------

export type RouteMesure =
  | {
      readonly kind: 'envoi_v2';
      readonly accountId: string;
      readonly body: {
        readonly type: 'send';
        readonly to: string;
        readonly amount: typeof MONTANT;
        readonly currency: 'USDC';
        readonly network?: string;
        readonly idem: string;
      };
    }
  | {
      readonly kind: 'retrait_v2';
      readonly accountId: string;
      readonly body: { readonly amount: typeof MONTANT; readonly currency: 'EUR'; readonly payment_method: string };
    }
  | { readonly kind: 'moyens_de_paiement' };

export interface TransportMesures {
  call(route: RouteMesure): Promise<unknown>;
  close(): Promise<void>;
}

function ccxtTransportMesures(cle: Cle): TransportMesures {
  const exchange = new ccxt.coinbase({ apiKey: cle.apiKey, secret: cle.apiSecret });
  return {
    async call(route) {
      switch (route.kind) {
        case 'envoi_v2':
          return exchange.v2PrivatePostAccountsAccountIdTransactions({ account_id: route.accountId, ...route.body });
        case 'retrait_v2':
          return exchange.v2PrivatePostAccountsAccountIdWithdrawals({ account_id: route.accountId, ...route.body });
        case 'moyens_de_paiement':
          return exchange.v3PrivateGetBrokeragePaymentMethods();
      }
    },
    close: () => exchange.close(),
  };
}

/**
 * ccxt ne garde pas le code HTTP ; `handleErrors` le recoit pour chaque
 * reponse, succes compris. Observation seule : l'appel d'origine suit, inchange,
 * et c'est lui qui leve. Pose une fois, sur le seul processus de la mesure.
 */
function observerCodeHttp(http: { dernier: number | undefined }): void {
  const proto = ccxt.coinbase.prototype as unknown as {
    handleErrors: (this: unknown, code: number, ...reste: unknown[]) => unknown;
  };
  const origine = proto.handleErrors;
  proto.handleErrors = function (this: unknown, code: number, ...reste: unknown[]) {
    http.dernier = code;
    return origine.call(this, code, ...reste);
  };
}

// --- Arguments, cle, horaire --------------------------------------------------

export interface Arguments {
  readonly commande: Commande;
  readonly cle: string;
  readonly primary: string;
  readonly ubacAgent: string;
  readonly adresse?: string;
  readonly reseau?: string;
  readonly moyen?: string;
}

const OPTIONS = new Map<string, keyof Omit<Arguments, 'commande'>>([
  ['--cle', 'cle'],
  ['--primary', 'primary'],
  ['--ubac-agent', 'ubacAgent'],
  ['--adresse', 'adresse'],
  ['--reseau', 'reseau'],
  ['--moyen', 'moyen'],
]);

export function lireArguments(argv: readonly string[]): Arguments {
  const [commande, ...reste] = argv;
  if (!COMMANDES.some((c) => c === commande)) {
    throw new MesureRefusee(`commande ${String(commande)} inconnue, attendu : ${COMMANDES.join(', ')}.`);
  }
  const lus: Partial<Record<keyof Omit<Arguments, 'commande'>, string>> = {};
  for (let i = 0; i < reste.length; i += 2) {
    const nom = OPTIONS.get(reste[i] ?? '');
    const valeur = reste[i + 1];
    if (nom === undefined || valeur === undefined || valeur.startsWith('--')) {
      throw new MesureRefusee(`option ${String(reste[i])} inconnue ou sans valeur.`);
    }
    lus[nom] = valeur;
  }
  const { cle, primary, ubacAgent } = lus;
  if (cle === undefined || primary === undefined || ubacAgent === undefined) {
    throw new MesureRefusee('--cle, --primary et --ubac-agent sont exiges.');
  }
  if (commande === 'mc2-crypto' && lus.adresse === undefined) throw new MesureRefusee('mc2-crypto exige --adresse.');
  if (commande === 'mc2-eur' && lus.moyen === undefined) throw new MesureRefusee('mc2-eur exige --moyen (voir « moyens »).');
  return { ...lus, commande: commande as Commande, cle, primary, ubacAgent };
}

export interface Cle {
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * Le fichier JSON telecharge de la console CDP, `name` (ECDSA) ou `id`
 * (Ed25519), et `privateKey`. Un chemin dans le depot est refuse : une cle
 * qui y passe une fois finit dans un commit. Aucun message ne cite le contenu,
 * pas meme celui de `JSON.parse`, qui en recopie un extrait.
 */
export async function lireCle(chemin: string, racine: string = ROOT): Promise<Cle> {
  const absolu = resolve(chemin);
  const depuisRacine = relative(racine, absolu);
  if (!depuisRacine.startsWith('..') && !isAbsolute(depuisRacine)) {
    throw new MesureRefusee(`la cle ${chemin} est dans le depot : la ranger hors depot.`);
  }
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(absolu, 'utf8'));
  } catch {
    throw new MesureRefusee(`fichier de cle ${chemin} illisible ou pas en JSON.`);
  }
  const record = (typeof brut === 'object' && brut !== null ? brut : {}) as Record<string, unknown>;
  const apiKey = record['name'] ?? record['id'];
  const apiSecret = record['privateKey'];
  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string' || apiKey === '' || apiSecret === '') {
    throw new MesureRefusee(`fichier de cle ${chemin} : { "name" ou "id", "privateKey" } attendu.`);
  }
  return { apiKey, apiSecret };
}

/** Le run d'Ubac, 07:00 Europe/Paris (docs/deploiement.md), et la marge refusee autour. */
const RUN_UBAC = 7 * 60;
const MARGE = 30;

export function procheDuRun(instant: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const valeur = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Math.abs(valeur('hour') * 60 + valeur('minute') - RUN_UBAC) < MARGE;
}

/** Chaque ligne sort par ici. Les fragments courts ne se masquent pas : ils masqueraient tout. */
export function masquer(texte: string, cle: Cle): string {
  const fragments = [cle.apiKey, cle.apiSecret, ...cle.apiKey.split('/'), ...cle.apiSecret.split(/\\n|\s+/)]
    .filter((f) => f.length >= 12 && !f.startsWith('-----'))
    .sort((a, b) => b.length - a.length);
  let sortie = texte;
  for (const fragment of fragments) sortie = sortie.split(fragment).join('[masque]');
  return sortie
    .replace(/Bearer\s+\S+/gi, 'Bearer [masque]')
    .replace(/eyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[jeton masque]');
}

// --- La mesure ----------------------------------------------------------------

export interface Outils {
  readonly transport: ConvoyeurTransport;
  readonly mesures: TransportMesures;
  readonly demander: (question: string) => Promise<string>;
  readonly ecrire: (ligne: string) => void;
  readonly maintenant: () => Date;
  readonly idem: () => string;
  readonly http: { dernier: number | undefined };
}

type Soldes = Awaited<ReturnType<ConvoyeurCoinbase['balances']>>;

const texteSoldes = (s: Soldes): string =>
  `Primary EUR ${s.eur.available.toFixed()} (gele ${s.eur.hold.toFixed()}), USDC ${s.usdc.available.toFixed()} (gele ${s.usdc.hold.toFixed()})`;

/** L'identifiant v2 d'un compte de Primary est son `uuid` v3 (ccxt `withdraw` fait de meme). */
async function compteDePrimary(transport: ConvoyeurTransport, primary: string, devise: string): Promise<string> {
  const reponse = (await transport.call({ kind: 'accounts' })) as { accounts?: unknown };
  const comptes = Array.isArray(reponse.accounts) ? (reponse.accounts as Record<string, unknown>[]) : [];
  const trouve = comptes.find((c) => c['currency'] === devise && c['retail_portfolio_id'] === primary);
  if (typeof trouve?.['uuid'] !== 'string') throw new MesureRefusee(`aucun compte ${devise} dans Primary.`);
  return trouve['uuid'];
}

interface Plan {
  readonly annonce: readonly string[];
  readonly source?: { readonly devise: 'EUR' | 'USDC'; readonly disponible: Decimal };
  readonly ecrire: () => Promise<unknown>;
}

async function planDe(args: Arguments, avant: Soldes, port: ConvoyeurCoinbase, outils: Outils): Promise<Plan> {
  const { primary, ubacAgent } = args;
  switch (args.commande) {
    case 'mc1':
      return {
        annonce: [
          `MC1 : move_funds ${MONTANT} USDC de ubac-agent ${ubacAgent} vers Primary ${primary}. Attendu : REFUS (CV20).`,
          "La cle ne lit pas ubac-agent : verifier dans l'application qu'il porte au moins 1 USDC disponible.",
        ],
        // Le transport, pas le port : le port refuse cette source avant tout appel (CV2).
        ecrire: () =>
          outils.transport.call({
            kind: 'move_funds',
            body: {
              funds: { value: MONTANT, currency: 'USDC' },
              source_portfolio_uuid: ubacAgent,
              target_portfolio_uuid: primary,
            },
          }),
      };
    case 'mc2-crypto': {
      const accountId = await compteDePrimary(outils.transport, primary, 'USDC');
      const { adresse = '', reseau } = args;
      return {
        annonce: [
          `MC2 : envoi v2 de ${MONTANT} USDC depuis Primary vers ${adresse}${reseau === undefined ? '' : ` (${reseau})`}.`,
          'Attendu : REFUS par la liste blanche vide (CV21). Cette adresse doit etre la votre.',
        ],
        source: { devise: 'USDC', disponible: avant.usdc.available },
        ecrire: () =>
          outils.mesures.call({
            kind: 'envoi_v2',
            accountId,
            body: {
              type: 'send',
              to: adresse,
              amount: MONTANT,
              currency: 'USDC',
              ...(reseau === undefined ? {} : { network: reseau }),
              idem: outils.idem(),
            },
          }),
      };
    }
    case 'mc2-eur': {
      const accountId = await compteDePrimary(outils.transport, primary, 'EUR');
      const moyen = args.moyen ?? '';
      return {
        annonce: [
          `MC2 : retrait v2 de ${MONTANT} EUR depuis Primary vers le moyen ${moyen}.`,
          'Resultat note, quel qu il soit (CV21). Ce compte bancaire doit etre le votre.',
        ],
        source: { devise: 'EUR', disponible: avant.eur.available },
        ecrire: () =>
          outils.mesures.call({
            kind: 'retrait_v2',
            accountId,
            body: { amount: MONTANT, currency: 'EUR', payment_method: moyen },
          }),
      };
    }
    case 'mc3':
      return {
        annonce: [`MC3 : move_funds ${MONTANT} USDC de Primary vers ubac-agent ${ubacAgent}. Attendu : ACCEPTE (CV22).`],
        source: { devise: 'USDC', disponible: avant.usdc.available },
        // Le chemin reel du convoyeur, controles de CV2 compris.
        ecrire: () => port.moveFunds({ source: primary, destination: ubacAgent, usdc: new Decimal(MONTANT) }),
      };
    case 'moyens':
      throw new MesureRefusee('moyens ne fait aucune ecriture.');
  }
}

async function listerMoyens(outils: Outils, ecrire: (ligne: string) => void): Promise<void> {
  const reponse = (await outils.mesures.call({ kind: 'moyens_de_paiement' })) as { payment_methods?: unknown };
  const moyens = Array.isArray(reponse.payment_methods) ? (reponse.payment_methods as Record<string, unknown>[]) : [];
  for (const m of moyens) {
    ecrire(`${String(m['id'])} ${String(m['type'])} ${String(m['currency'])} retrait=${String(m['allow_withdraw'])} ${String(m['name'])}`);
  }
  ecrire(`${String(moyens.length)} moyen(s). Aucune ecriture.`);
}

export async function mesurer(args: Arguments, cle: Cle, outils: Outils): Promise<void> {
  const ecrire = (ligne: string): void => outils.ecrire(masquer(ligne, cle));
  if (procheDuRun(outils.maintenant())) {
    throw new MesureRefusee("a moins de 30 min du run d'Ubac (07:00 Europe/Paris) : relancer plus loin de 07:00.");
  }
  const port = openConvoyeurCoinbase(outils.transport, {
    primaryUuid: args.primary,
    destinationUuid: args.ubacAgent,
    log: ecrire,
  });
  try {
    // Lit la cle et la refuse si elle n'est pas celle du convoyeur (CV1), avant tout.
    const avant = await port.balances();
    ecrire(`avant  : ${texteSoldes(avant)}`);
    if (args.commande === 'moyens') return await listerMoyens(outils, ecrire);

    const plan = await planDe(args, avant, port, outils);
    plan.annonce.forEach(ecrire);
    if (plan.source !== undefined && plan.source.disponible.lt(MONTANT)) {
      throw new MesureRefusee(
        `Primary porte ${plan.source.disponible.toFixed()} ${plan.source.devise} disponible, ${MONTANT} exige : un refus pour solde ne prouverait rien.`,
      );
    }
    const reponse = await outils.demander(`Taper « ${args.commande} » pour envoyer la requete, autre chose pour abandonner : `);
    if (reponse.trim() !== args.commande) {
      ecrire('Abandon : aucune requete envoyee.');
      return;
    }

    // Une requete, et une seule : ni rejeu, ni boucle sur l'echec.
    const instant = outils.maintenant().toISOString();
    outils.http.dernier = undefined;
    let resultat: string;
    try {
      resultat = `ACCEPTE : ${JSON.stringify(await plan.ecrire())}`;
    } catch (erreur) {
      resultat = erreur instanceof Error ? `REFUSE : ${erreur.name} ${erreur.message}` : `REFUSE : ${String(erreur)}`;
    }
    ecrire(`instant ${instant}, code HTTP ${String(outils.http.dernier ?? 'inconnu')}`);
    ecrire(resultat);

    const apres = await port.balances();
    ecrire(`apres  : ${texteSoldes(apres)}`);
    ecrire(
      `ecart  : EUR ${apres.eur.available.minus(avant.eur.available).toFixed()}, USDC ${apres.usdc.available.minus(avant.usdc.available).toFixed()}`,
    );
    ecrire('A rapporter dans Orca : code, message et soldes ci-dessus. Suite : docs/convoyeur-mesures.md.');
  } finally {
    await outils.transport.close();
    await outils.mesures.close();
  }
}

// --- Le poste -----------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  let cle: Cle | undefined;
  try {
    const args = lireArguments(argv);
    cle = await lireCle(args.cle);
    const http = { dernier: undefined as number | undefined };
    observerCodeHttp(http);
    await mesurer(args, cle, {
      transport: ccxtConvoyeurTransport(cle),
      mesures: ccxtTransportMesures(cle),
      demander: async (question) => {
        const lecteur = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await lecteur.question(question);
        } finally {
          lecteur.close();
        }
      },
      ecrire: (ligne) => console.log(ligne),
      maintenant: () => new Date(),
      idem: randomUUID,
      http,
    });
    return 0;
  } catch (erreur) {
    const message = erreur instanceof Error ? `${erreur.name} : ${erreur.message}` : String(erreur);
    console.error(cle === undefined ? message : masquer(message, cle));
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
