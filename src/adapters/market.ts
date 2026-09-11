import type { UtcDay } from '../fixture/normalise.js';
import { expectedCalendar, normaliseSeries } from '../fixture/normalise.js';
import type { Price } from '../core/types.js';
import type { CoinbaseTransport } from './coinbase.js';
import {
  CoinbaseFrontierError,
  decimalFromApi,
  MAX_CANDLES_PER_CALL,
  QUOTE,
  requireUsdcQuote,
} from './coinbase.js';

/**
 * Les bougies journalieres, lues chez Coinbase.
 *
 * Ce module ne verifie **rien** de la serie lui-meme. Le trou, l'horodatage qui
 * ne tombe pas sur 00:00 UTC, le prix nul ou negatif, la bougie en double : tout
 * cela est traite par `src/fixture/normalise.ts`, ecrit en phase 0 et qui reste
 * le seul controle. Y ajouter une verification ici donnerait deux definitions de
 * « serie acceptable », qui divergeraient a la premiere correction.
 *
 * Le chemin est donc court et sans intelligence : construire le calendrier
 * attendu, demander la fenetre a l'API, passer les bougies **brutes** a
 * `normaliseSeries`, convertir ce qu'il rend. Les prix traversent en chaines de
 * bout en bout — c'est ce qui fait qu'aucun flottant n'apparait nulle part, y
 * compris a l'interieur du normaliseur, qui refuse deja un prix publie en
 * nombre JSON.
 *
 * Deux proprietes mesurees de l'API, le 2026-09-11 :
 *
 * - les bougies reviennent **du plus recent au plus ancien**. `normaliseSeries`
 *   les reordonne sur le calendrier, donc l'ordre d'arrivee n'a pas d'importance
 *   — mais s'y fier en aurait eu.
 * - **la bougie du jour en cours est partielle et bouge.** Deux appels a
 *   quelques minutes d'intervalle ont rendu 77180.42 puis 77215.57 en cloture du
 *   meme jour. Une fenetre qui inclut aujourd'hui donne donc une cloture qui
 *   n'en est pas une ; c'est a l'appelant de s'arreter au dernier jour clos.
 */

/**
 * Une bougie prete pour le noyau. `date` porte la marque `UtcDay` de la phase 0
 * plutot que `IsoDate` : elle sort du normaliseur, seul endroit du depot qui
 * sache poser cette marque, et la garder dit d'ou elle vient.
 */
export interface DailyCandle {
  readonly date: UtcDay;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
}

/** Fenetre demandee, bornes incluses, au format `YYYY-MM-DD`. */
export interface DailyWindow {
  readonly firstDay: string;
  readonly lastDay: string;
}

export interface MarketReader {
  /** La serie complete de l'actif sur la fenetre, ou un refus. Jamais de trou. */
  dailyCandles(asset: string, window: DailyWindow): Promise<readonly DailyCandle[]>;
}

/**
 * Le produit d'un actif, passe par le controle de paire de `coinbase.ts` :
 * `USDC-USDC` n'existe pas, et une contrepartie autre qu'USDC est refusee ici
 * comme elle l'est sur un ordre ouvert.
 */
function productOf(asset: string, contexte: string): string {
  if (asset === QUOTE) {
    throw new CoinbaseFrontierError(
      `${contexte} : ${QUOTE} est la contrepartie, pas une ligne negociable.`,
    );
  }
  const productId = `${asset}-${QUOTE}`;
  requireUsdcQuote(productId, contexte);
  return productId;
}

/** Les secondes UTC d'un jour deja valide par `expectedCalendar`. */
function startOf(day: UtcDay): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

export function openMarketData(transport: CoinbaseTransport): MarketReader {
  return {
    async dailyCandles(asset: string, window: DailyWindow): Promise<readonly DailyCandle[]> {
      const product = productOf(asset, `bougies ${asset}`);
      /*
       * Le calendrier avant l'appel : il valide les bornes, et c'est lui qui
       * dira ensuite quel jour manque. Un intervalle inverse ou une date
       * inexistante echoue ici, avant d'avoir touche le reseau.
       */
      const calendar = expectedCalendar(window.firstDay, window.lastDay);
      const premier = calendar[0];
      const dernier = calendar[calendar.length - 1];
      /*
       * Inatteignable : `expectedCalendar` leve sur des bornes inversees et rend
       * au moins un jour sinon. Le garde-fou existe parce que
       * `noUncheckedIndexedAccess` a raison de ne pas croire un index, et il ne
       * sera jamais couvert — c'est le seul endroit non couvert du module.
       */
      if (premier === undefined || dernier === undefined) {
        throw new CoinbaseFrontierError(`${product} : calendrier vide.`);
      }
      /*
       * L'API plafonne le nombre de bougies par appel. Au-dela, elle tronque la
       * fenetre : le normaliseur refuserait la serie pour jours manquants, ce
       * qui est correct mais raconte la mauvaise cause. Le dire ici est plus
       * honnete que de pagine en silence — les 200 jours de la spec §6 tiennent
       * largement dans un appel.
       */
      if (calendar.length > MAX_CANDLES_PER_CALL) {
        throw new CoinbaseFrontierError(
          `${product} : ${calendar.length} jours demandes, l'API en rend ${MAX_CANDLES_PER_CALL} au plus par appel. Decouper la fenetre.`,
        );
      }

      const reponse = await transport.read({
        kind: 'daily_candles',
        product,
        startSeconds: startOf(premier),
        /*
         * `end` est inclusif cote Coinbase : la bougie qui ouvre a `end` est
         * rendue. On vise donc l'ouverture du dernier jour, pas sa fin — viser
         * `+ SECONDS_PER_DAY` ferait rendre une bougie de plus, hors calendrier,
         * que `normaliseSeries` jetterait sans rien dire.
         */
        endSeconds: startOf(dernier),
      });
      if (typeof reponse !== 'object' || reponse === null || Array.isArray(reponse)) {
        throw new CoinbaseFrontierError(
          `${product} : objet attendu de l'API, recu ${JSON.stringify(reponse)}.`,
        );
      }
      const brutes = (reponse as Record<string, unknown>)['candles'];
      if (!Array.isArray(brutes)) {
        throw new CoinbaseFrontierError(
          `${product} : champ candles absent ou non listable (${typeof brutes}).`,
        );
      }

      // Le seul controle de serie du depot. Voir l'en-tete du module.
      return normaliseSeries(product, brutes, calendar).map((candle) => ({
        date: candle.date,
        // Les chaines d'origine, celles que la source a ecrites. Aucun flottant
        // n'a jamais existe sur ce chemin.
        open: decimalFromApi(candle.open, `${product} ${candle.date} open`) as Price,
        high: decimalFromApi(candle.high, `${product} ${candle.date} high`) as Price,
        low: decimalFromApi(candle.low, `${product} ${candle.date} low`) as Price,
        close: decimalFromApi(candle.close, `${product} ${candle.date} close`) as Price,
      }));
    },
  };
}
