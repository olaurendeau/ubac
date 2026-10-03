import type { Decimal } from 'decimal.js';

import type { ConvoyeurBase, EtapeAEcrire } from './base.js';
import type { ClePermissions, ConvoyeurCoinbase } from './coinbase.js';
import type { CompteRendu, ConvoyageOuvert } from './regles.js';
import { constater, deciderPassage, jourDuPassage, lignePoussiere, reprendre, verifierCle } from './regles.js';
import type { Achat, Convoyage, Etape, EurAmount, UsdcAmount } from './types.js';

/**
 * Le passage du convoyeur (lot Y4b du plan `ubac-convoyeur`) : lire la cle,
 * le journal, les soldes ; reprendre le convoyage ouvert ou en commencer un ;
 * acheter, transferer, enregistrer. Les regles decident (Y2), ce module agit.
 *
 * Quatre proprietes :
 *
 * 1. **L'etape s'ecrit avant l'appel qu'elle annonce** (DC6) : `ACHAT_DEMANDE`
 *    avant l'ordre, `TRANSFERT_DEMANDE` avant `move_funds`. Une etape
 *    d'annonce que la base dit deja ecrite arrete le passage : un autre l'a
 *    ouverte, et l'index du journal tient lieu de verrou.
 * 2. **Entre deux etapes, la table de reprise** (`reprendre`) relit ce que
 *    l'exchange dit, au debut d'un passage comme apres chaque etape. Commencer,
 *    c'est ecrire `ACHAT_DEMANDE`, puis suivre la table.
 * 3. **`move_funds` part au plus une fois par passage** (S7 : ni identifiant,
 *    ni idempotence). Apres l'appel, leve ou non, le passage relit le solde et
 *    ne rappelle jamais. Une lecture et l'achat (idempotent par
 *    `client_order_id`, S5) se retentent en nombre borne.
 * 4. **Aucune horloge** : le jour vient de `instant`, chaque etape prend le sien
 *    a `horloge`, et la pause entre deux tentatives est injectee.
 *
 * Une erreur qui survit a ses tentatives arrete le passage sur l'etape ecrite,
 * qui reste reprenable (relance avant 07:00, `docs/convoyeur.md` §8). Seul ce
 * que la table dit incoherent, ou un ordre clos sans etre rempli, ecrit
 * `EN_PANNE`, qui attend le geste de l'operateur.
 */

export interface PortsPassage {
  readonly coinbase: Pick<ConvoyeurCoinbase, 'keyPermissions' | 'balances' | 'marketBuy' | 'order' | 'moveFunds'>;
  readonly base: ConvoyeurBase;
  /** L'instant de chaque etape ecrite (piege 1 d'Y4b) ; jamais `Date.now()`. */
  readonly horloge: () => Date;
  readonly pause: (ms: number) => Promise<void>;
  readonly log: (ligne: string) => void;
}

export interface ConfigPassage {
  readonly primaryUuid: string;
  readonly destinationUuid: string;
  /** Essais d'une lecture, de l'achat, ou relectures d'un ordre et d'un solde. */
  readonly tentatives: number;
  readonly pauseMs: number;
}

/**
 * Piege 3 d'Y4b : le delai du job borne la somme des tentatives. Une serie
 * fait au plus `TENTATIVES` appels et `TENTATIVES - 1` pauses. Au pire, six
 * series a l'exchange (cle, soldes, achat, ordre, soldes apres achat, soldes
 * apres transfert) plus un `move_funds`, soit 25 appels au delai ccxt de 10 s,
 * et sept a la base : 13 x 3 x 3 s = 117 s de pauses, environ 6 min en tout.
 * La definition Scaleway (OP4) porte un delai de 10 min et aucune tentative
 * (`docs/convoyeur.md` §8).
 */
export const TENTATIVES = 4;
export const PAUSE_MS = 3_000;

const ORDRE_CLOS = new Set(['CANCELLED', 'EXPIRED', 'FAILED']);

/** Ce que le passage sait de lui-meme, pour le compte rendu d'une erreur. */
interface Suivi {
  nature: 'CONVOYAGE' | 'REPRISE';
  convoyage: Convoyage | undefined;
  etape: Etape | undefined;
  achat: Achat | undefined;
  eurLaisse: EurAmount | undefined;
  poussiere: UsdcAmount | undefined;
}

class Arret extends Error {
  constructor(readonly motif: string) {
    super(motif);
    this.name = 'Arret';
  }
}

/** La cle telle que `verifierCle` (Y2) la lit, au nom de l'API. */
function enReponse(cle: ClePermissions): Readonly<Record<string, unknown>> {
  return {
    portfolio_uuid: cle.portfolioUuid,
    portfolio_type: cle.portfolioType,
    can_view: cle.canView,
    can_trade: cle.canTrade,
    can_transfer: cle.canTransfer,
  };
}

/** La requalification ecrite des `Quantity` de l'adapter : l'EUR et l'USDC de *Primary*. */
const enEur = (q: Decimal): EurAmount => q as EurAmount;
const enUsdc = (q: Decimal): UsdcAmount => q as UsdcAmount;

function message(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : String(erreur);
}

/**
 * Un passage. Rend le compte rendu a notifier (CV17), ou `undefined` quand il
 * n'a rien fait (CV5, convoyage du jour deja enregistre) : une ligne de
 * journal, aucune notification.
 */
export async function passage(
  ports: PortsPassage,
  config: ConfigPassage,
  instant: Date,
): Promise<CompteRendu | undefined> {
  const { coinbase, base, horloge, log } = ports;
  const jour = jourDuPassage(instant);
  const suivi: Suivi = {
    nature: 'CONVOYAGE',
    convoyage: undefined,
    etape: undefined,
    achat: undefined,
    eurLaisse: undefined,
    poussiere: undefined,
  };

  const compte = (nature: CompteRendu['nature'], motif: string | undefined): CompteRendu => ({
    nature,
    convoyage: suivi.convoyage,
    etape: suivi.etape,
    achat: suivi.achat,
    eurLaisse: suivi.eurLaisse,
    motif,
    poussiere: suivi.poussiere,
  });

  async function essayer<T>(quoi: string, appel: () => Promise<T>): Promise<T> {
    for (let essai = 1; ; essai += 1) {
      try {
        return await appel();
      } catch (erreur) {
        log(`${quoi} : essai ${String(essai)}/${String(config.tentatives)} en echec — ${message(erreur)}`);
        if (essai >= config.tentatives) throw erreur;
        await ports.pause(config.pauseMs);
      }
    }
  }

  /** Une relecture : un echec compte pour une lecture, sans relancer la serie. */
  async function relire<T>(quoi: string, appel: () => Promise<T>): Promise<T | undefined> {
    try {
      return await appel();
    } catch (erreur) {
      log(`${quoi} : relecture en echec — ${message(erreur)}`);
      return undefined;
    }
  }

  /** `available` seul (U3) ; l'EUR lu en dernier est celui que le compte rendu dit laisse. */
  async function soldes(): Promise<{ readonly eur: EurAmount; readonly usdc: UsdcAmount }> {
    const { eur, usdc } = await coinbase.balances();
    suivi.eurLaisse = enEur(eur.available);
    return { eur: enEur(eur.available), usdc: enUsdc(usdc.available) };
  }
  const lireSoldes = () => essayer('soldes', soldes);

  /**
   * Une etape d'annonce deja ecrite arrete : un autre passage l'a ecrite, ou
   * un premier essai a abouti sans accuse. Les deux se reprennent au passage
   * suivant, sans appel dans celui-ci.
   */
  async function ecrire(etape: EtapeAEcrire, annonce: boolean): Promise<void> {
    const issue = await essayer(`journal ${etape.etape}`, () => base.ecrireEtape(etape));
    if (annonce && issue === 'ALREADY_RECORDED') {
      throw new Arret(`${etape.etape} du convoyage ${etape.convoyage} deja ecrit par un autre passage : aucun appel.`);
    }
    suivi.etape = etape.etape;
    log(`etape ${etape.etape} — convoyage ${etape.convoyage} a ${etape.le.toISOString()}`);
  }

  /** Le `BUY` du convoyage, rendu une fois rempli ; `undefined` s'il ne l'est pas dans le delai. */
  async function acheter(convoyage: Convoyage, clientOrderId: string): Promise<Achat | undefined> {
    // S5 : recreer sous le meme identifiant rend l'ordre existant, jamais un second.
    const { exchangeId } = await essayer('achat', () => coinbase.marketBuy(clientOrderId));
    for (let lecture = 1; lecture <= config.tentatives; lecture += 1) {
      if (lecture > 1) await ports.pause(config.pauseMs);
      const ordre = await relire('ordre', () => coinbase.order(exchangeId));
      if (ordre === undefined) continue;
      if (ordre.kind === 'FILLED') {
        if (ordre.clientOrderId !== clientOrderId) {
          throw new Arret(`ordre ${exchangeId} rendu pour ${ordre.clientOrderId}, pas ${clientOrderId}.`);
        }
        return {
          orderId: ordre.exchangeId,
          filledSize: enUsdc(ordre.filledSize),
          filledValue: enEur(ordre.filledValue),
          totalFees: enEur(ordre.totalFees),
        };
      }
      if (ORDRE_CLOS.has(ordre.kind)) {
        const motif = `ordre ${exchangeId} ${ordre.kind} sans etre rempli`;
        await ecrire({ etape: 'EN_PANNE', convoyage, le: horloge(), motif }, false);
        throw new Arret(`ordre ${exchangeId} ${ordre.kind} sans etre rempli : rien ne reprend sans l'operateur.`);
      }
      log(`ordre ${exchangeId} : ${ordre.kind === 'INDETERMINABLE' ? ordre.reason : 'OPEN'}`);
    }
    return undefined;
  }

  /**
   * Le convoyage, de son etape ecrite jusqu'a `ENREGISTRE`, ou jusqu'a ce que
   * la table dise d'arreter. Quatre transitions au plus : ordre, transfert,
   * constat, enregistrement.
   */
  async function mener(ouvert: ConvoyageOuvert, usdcInitial: UsdcAmount): Promise<CompteRendu> {
    let etat = ouvert;
    let usdcRelu = usdcInitial;
    let transfertTente = false;
    const { convoyage } = ouvert;
    for (let pas = 0; pas < 5; pas += 1) {
      const suite = reprendre(etat, usdcRelu);
      switch (suite.faire) {
        case 'RELIRE_ORDRE': {
          const achat = await acheter(convoyage, suite.clientOrderId);
          if (achat === undefined) {
            throw new Arret(`ordre ${suite.clientOrderId} non rempli apres ${String(config.tentatives)} lectures.`);
          }
          suivi.achat = achat;
          await ecrire({ etape: 'ACHETE', convoyage, le: horloge(), achat }, false);
          etat = { etape: 'ACHETE', convoyage, achat };
          usdcRelu = (await lireSoldes()).usdc;
          break;
        }
        case 'TRANSFERER': {
          if (transfertTente) {
            throw new Arret(
              `transfert demande, ${suite.montant.toFixed()} USDC toujours dans Primary : non constate, move_funds ne repart pas dans ce passage.`,
            );
          }
          /*
           * L'instant retenu est celui de **cette** demande (DC5). Refait apres
           * un `TRANSFERT_DEMANDE` d'un passage anterieur sans effet, le
           * transfert a lieu maintenant : l'instant de la premiere demande,
           * anterieur au run d'Ubac intercale, ferait tomber l'apport hors de
           * la fenetre ou l'USDC arrive.
           */
          suivi.poussiere = suite.poussiere;
          const demandeLe = horloge();
          await ecrire(
            { etape: 'TRANSFERT_DEMANDE', convoyage, le: demandeLe, montant: suite.montant },
            etat.etape === 'ACHETE',
          );
          transfertTente = true;
          try {
            await coinbase.moveFunds({
              source: config.primaryUuid,
              destination: config.destinationUuid,
              usdc: suite.montant,
            });
          } catch (erreur) {
            log(`move_funds en echec, le solde dira s'il a eu lieu — ${message(erreur)}`);
          }
          etat = { etape: 'TRANSFERT_DEMANDE', convoyage, achat: suite.achat, demandeLe };
          /*
           * Sans relecture aboutie, l'USDC reste le solde d'avant : non constate,
           * et la table arrete. Le meme constat que la table (DC10) : avec une
           * poussiere, le solde d'avant n'est pas `filled_size`, et une egalite
           * le prendrait pour un transfert fait.
           */
          for (let lecture = 1; lecture <= config.tentatives; lecture += 1) {
            if (lecture > 1) await ports.pause(config.pauseMs);
            usdcRelu = (await relire('soldes', soldes))?.usdc ?? usdcRelu;
            if (constater(usdcRelu, suite.montant).usdc !== 'PRESENT') break;
          }
          break;
        }
        case 'NOTER_TRANSFERE':
          suivi.poussiere = suite.poussiere;
          await ecrire({ etape: 'TRANSFERE', convoyage, le: suite.transfereLe }, false);
          etat = { etape: 'TRANSFERE', convoyage, achat: suite.achat, transfereLe: suite.transfereLe };
          break;
        case 'ENREGISTRER': {
          const { achat, transfereLe } = suite;
          suivi.achat = achat;
          const issue = await essayer('cash_flows', () => base.ecrireApport({ convoyage, achat, transfereLe }));
          log(`apport ${achat.filledSize.toFixed()} USDC a ${transfereLe.toISOString()} : ${issue}`);
          await ecrire({ etape: 'ENREGISTRE', convoyage, le: horloge() }, false);
          return compte(suivi.nature, undefined);
        }
        case 'PANNE':
          if (etat.etape !== 'EN_PANNE') {
            await ecrire({ etape: 'EN_PANNE', convoyage, le: horloge(), motif: suite.motif }, false);
          }
          suivi.etape = 'EN_PANNE';
          return compte('PANNE', suite.motif);
      }
    }
    throw new Arret(`convoyage ${convoyage} : la table de reprise ne converge pas.`);
  }

  try {
    const cle = await essayer('cle', () => coinbase.keyPermissions());
    const verdict = verifierCle(enReponse(cle), config.primaryUuid);
    if (!verdict.admis) return compte('REFUS', verdict.motif);

    const dernier = await essayer('journal', () => base.dernierConvoyage());
    const { eur: eurDisponible, usdc: usdcRelu } = await lireSoldes();
    const decision = deciderPassage({ jour, dernier, eurDisponible, usdcRelu });
    switch (decision.action) {
      case 'RIEN': {
        log(`rien a faire : ${decision.motif}`);
        const information = lignePoussiere(decision.poussiere);
        if (information !== undefined) log(information);
        return undefined;
      }
      case 'REFUSER':
        return compte('REFUS', decision.motif);
      case 'COMMENCER':
        suivi.convoyage = decision.convoyage;
        suivi.poussiere = decision.poussiere;
        log(
          `convoyage ${decision.convoyage} : achat de ${decision.quoteSize.toFixed()} EUR, client_order_id=${decision.clientOrderId}, ${decision.eurLaisse.toFixed()} EUR laisses`,
        );
        await ecrire({ etape: 'ACHAT_DEMANDE', convoyage: decision.convoyage, le: horloge() }, true);
        return await mener({ etape: 'ACHAT_DEMANDE', convoyage: decision.convoyage }, usdcRelu);
      case 'REPRENDRE': {
        // `deciderPassage` ne reprend qu'un convoyage ouvert : `dernier` l'est.
        const ouvert = dernier as ConvoyageOuvert;
        suivi.nature = 'REPRISE';
        suivi.convoyage = ouvert.convoyage;
        suivi.etape = ouvert.etape;
        if ('achat' in ouvert) suivi.achat = ouvert.achat;
        log(`reprise du convoyage ${ouvert.convoyage} a ${ouvert.etape} : ${decision.suite.faire}`);
        return await mener(ouvert, usdcRelu);
      }
    }
  } catch (erreur) {
    const motif = erreur instanceof Arret ? erreur.motif : `erreur : ${message(erreur)}`;
    log(`passage arrete a ${suivi.etape ?? 'aucune etape'} — ${motif}`);
    return compte('PANNE', motif);
  }
}
