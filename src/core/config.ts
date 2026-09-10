import type { RebalanceParams } from './strategy/rebalance.js';
import { DEFAULT_REBALANCE_PARAMS } from './strategy/rebalance.js';
import type { StrategyName } from './types.js';

/**
 * Les configurations nommees de la phase 0, la ou le rejeu va les chercher.
 *
 * Le fichier ne calcule rien : il fige quelles options sont armees sur quelle
 * configuration. C'est un choix de cadrage, pas un detail d'implementation, et
 * le laisser eparpille dans les appelants reviendrait a laisser chacun decider
 * si le declencheur B est actif ce jour-la.
 */

/** Les deux configurations qui passent par `strategy/rebalance.ts`. */
export type RebalanceStrategyName = Extract<StrategyName, 'rebalance' | 'rebalance_ab'>;

/**
 * Une seule ligne separe les deux configurations, et c'est exactement celle que
 * C13 mesure : `ratioBandEnabled`.
 *
 * `rebalance` est la configuration de production. Le drapeau y est ecrit `false`
 * en toutes lettres plutot que laisse au defaut de `DEFAULT_REBALANCE_PARAMS` :
 * ce n'est pas une redondance, c'est le seul endroit ou un relecteur peut
 * constater d'un coup d'oeil que la production n'arbitre pas BTC contre ETH.
 * Le cadrage a sorti B de la production faute de P&L attribuable a 1 a 3
 * evenements par an ; un defaut qui bascule sans que ce fichier change l'y
 * ferait rentrer par omission.
 *
 * `rebalance_ab` est la meme strategie, en shadow, B arme. Elle porte son propre
 * `strategy` : le rejeu compte les declenchements par ce nom et deux
 * configurations qui le partageraient seraient additionnees dans le rapport.
 */
export const REBALANCE_CONFIGS: Readonly<Record<RebalanceStrategyName, RebalanceParams>> = {
  rebalance: {
    ...DEFAULT_REBALANCE_PARAMS,
    strategy: 'rebalance',
    ratioBandEnabled: false,
  },
  rebalance_ab: {
    ...DEFAULT_REBALANCE_PARAMS,
    strategy: 'rebalance_ab',
    ratioBandEnabled: true,
  },
};
