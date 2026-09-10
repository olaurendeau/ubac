import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { MIN_LEG_USDC, validate } from '../../src/core/risk.js';
import type { RiskContext } from '../../src/core/risk.js';
import type {
  Intent,
  IntentLeg,
  Price,
  Rejection,
  Side,
  UsdcAmount,
  Weight,
  Weights,
} from '../../src/core/types.js';

const usdc = (v: string): UsdcAmount => new Decimal(v) as UsdcAmount;
const price = (v: string): Price => new Decimal(v) as Price;
const weight = (v: string): Weight => new Decimal(v) as Weight;

const WEIGHTS: Weights = { BTC: weight('0.4'), ETH: weight('0.3'), USDC: weight('0.3') };

/**
 * Fabrique injectee a la place de `core/order-id.ts`, qui n'existe pas a cette
 * etape. Elle recopie les quatre composantes en clair : les tests peuvent ainsi
 * verifier *ce qui* est passe a la fabrique, ce qu'un hachage rendrait opaque.
 */
const context: RiskContext = {
  makeClientOrderId: ({ runDate, asset, side, legIndex }) =>
    `${runDate}|${asset}|${side}|${legIndex}`,
};

function leg(overrides: Partial<IntentLeg> = {}): IntentLeg {
  return {
    asset: 'BTC',
    quote: 'USDC',
    side: 'BUY' as Side,
    amount: usdc('1500'),
    limitPrice: price('60000'),
    ...overrides,
  };
}

function intent(legs: readonly IntentLeg[]): Intent {
  return {
    runDate: '2026-08-31',
    strategy: 'rebalance',
    trigger: 'CASH_BAND',
    reason: 'poids USDC a 0.2399, sous la bande basse 0.24',
    weightsBefore: WEIGHTS,
    weightsTarget: WEIGHTS,
    legs,
  };
}

/** Deplie le verdict cote accepte, en echouant si le run a ete rejete. */
function accepted(intentUnderTest: Intent) {
  const verdict = validate(intentUnderTest, context);
  if (verdict.status !== 'ACCEPTED') {
    throw new Error(`run rejete : ${verdict.rejections.map((r) => r.code).join(', ')}`);
  }
  return verdict;
}

function rejections(intentUnderTest: Intent): readonly Rejection[] {
  const verdict = validate(intentUnderTest, context);
  if (verdict.status !== 'REJECTED') {
    throw new Error('run accepte alors qu\'un motif bloquant etait attendu');
  }
  return verdict.rejections;
}

describe('validate : structure du verdict', () => {
  it('accepte une intention vide sans produire d\'ordre', () => {
    const verdict = accepted(intent([]));

    expect(verdict.orders).toEqual([]);
    expect(verdict.ignored).toEqual([]);
  });

  it('convertit une jambe en ordre en divisant le montant par le prix limite', () => {
    const [order] = accepted(intent([leg({ amount: usdc('1500'), limitPrice: price('60000') })]))
      .orders;

    expect(order).toBeDefined();
    // 1500 USDC / 60000 USDC par BTC = 0.025 BTC, et non 1500 BTC.
    expect(order?.quantity.toString()).toBe('0.025');
    expect(order?.asset).toBe('BTC');
    expect(order?.quote).toBe('USDC');
    expect(order?.side).toBe('BUY');
    expect(order?.limitPrice.toString()).toBe('60000');
  });

  it('identifie chaque ordre par (run_date, asset, side, leg_index)', () => {
    const verdict = accepted(
      intent([leg({ asset: 'BTC', side: 'SELL' }), leg({ asset: 'ETH', side: 'BUY' })]),
    );

    expect(verdict.orders.map((o) => o.clientOrderId)).toEqual([
      '2026-08-31|BTC|SELL|0',
      '2026-08-31|ETH|BUY|1',
    ]);
  });

  it('conserve l\'ordre des jambes', () => {
    const verdict = accepted(
      intent([leg({ asset: 'ETH' }), leg({ asset: 'BTC' }), leg({ asset: 'ETH' })]),
    );

    expect(verdict.orders.map((o) => o.asset)).toEqual(['ETH', 'BTC', 'ETH']);
  });
});

describe('ASSET_NOT_ALLOWED', () => {
  it('rejette un actif hors liste blanche', () => {
    const codes = rejections(intent([leg({ asset: 'SOL' })]));

    expect(codes).toEqual([
      expect.objectContaining({ code: 'ASSET_NOT_ALLOWED', legIndex: 0 }),
    ]);
  });

  it('rejette une jambe libellee sur la devise de cotation elle-meme', () => {
    // USDC est la quote, pas une ligne negociable : USDC-USDC est un ordre sur
    // soi-meme, et il doit se voir plutot que de produire un ordre nul.
    const codes = rejections(intent([leg({ asset: 'USDC' })]));

    expect(codes[0]?.code).toBe('ASSET_NOT_ALLOWED');
  });

  it('rejette le run entier des qu\'une seule jambe est fautive', () => {
    const verdict = validate(intent([leg({ asset: 'BTC' }), leg({ asset: 'SOL' })]), context);

    // Pas d'execution partielle : les jambes d'un reequilibrage ne sont pas
    // independantes, en passer la moitie laisse un etat que personne n'a decide.
    expect(verdict.status).toBe('REJECTED');
  });
});

describe('QUOTE_NOT_ALLOWED (C18)', () => {
  it('rejette une paire cotee en EUR', () => {
    const codes = rejections(intent([leg({ asset: 'BTC', quote: 'EUR' })]));

    expect(codes).toEqual([
      expect.objectContaining({ code: 'QUOTE_NOT_ALLOWED', legIndex: 0 }),
    ]);
    expect(codes[0]?.reason).toContain('BTC-EUR');
  });

  it('rejette toute quote qui n\'est pas USDC, stablecoin compris', () => {
    for (const quote of ['EUR', 'USD', 'USDT', 'BTC', 'usdc']) {
      expect(rejections(intent([leg({ quote })]))[0]?.code).toBe('QUOTE_NOT_ALLOWED');
    }
  });

  it('prime sur le filtre de taille : une petite jambe en EUR est rejetee, pas ignoree', () => {
    // Une jambe de 12 USDC cotee en EUR est le symptome d'un bug en amont.
    // L'ecarter en silence parce qu'elle est petite reviendrait a l'effacer.
    const codes = rejections(intent([leg({ quote: 'EUR', amount: usdc('12') })]));

    expect(codes[0]?.code).toBe('QUOTE_NOT_ALLOWED');
  });
});

describe('LEG_TOO_SMALL (C19)', () => {
  it('ignore la jambe sous 200 USDC sans rejeter le run ; les autres passent', () => {
    const verdict = accepted(
      intent([
        leg({ asset: 'BTC', amount: usdc('1500') }),
        leg({ asset: 'ETH', amount: usdc('12') }),
        leg({ asset: 'BTC', amount: usdc('900'), side: 'SELL' }),
      ]),
    );

    expect(verdict.orders).toHaveLength(2);
    expect(verdict.orders.map((o) => o.clientOrderId)).toEqual([
      '2026-08-31|BTC|BUY|0',
      '2026-08-31|BTC|SELL|2',
    ]);
    expect(verdict.ignored).toEqual([
      expect.objectContaining({ code: 'LEG_TOO_SMALL', legIndex: 1 }),
    ]);
  });

  it('ecarte une jambe strictement sous le seuil', () => {
    const verdict = accepted(intent([leg({ amount: usdc('199.99') })]));

    expect(verdict.orders).toHaveLength(0);
    expect(verdict.ignored[0]?.code).toBe('LEG_TOO_SMALL');
  });

  it('laisse passer une jambe exactement au seuil', () => {
    // Le seuil est strict : 200 passe. Un `lte` a la place du `lt` se verrait ici.
    const verdict = accepted(intent([leg({ amount: MIN_LEG_USDC as UsdcAmount })]));

    expect(verdict.orders).toHaveLength(1);
    expect(verdict.ignored).toEqual([]);
  });

  it('n\'apparait jamais dans les rejets bloquants', () => {
    // C19 distingue "ignoree" de "rejetee". Un run qui ne contient qu'une
    // jambe residuelle reste accepte, avec zero ordre.
    const verdict = validate(intent([leg({ amount: usdc('12') })]), context);

    expect(verdict.status).toBe('ACCEPTED');
  });
});

describe('C22 : aucun contournement dans la surface publique', () => {
  it('validate() n\'accepte que l\'intention et le contexte', () => {
    // Un troisieme parametre serait la porte d'entree naturelle d'un drapeau
    // de passage en cavalier. Grossier comme garde-fou, mais il coute une ligne.
    expect(validate).toHaveLength(2);
  });
});
