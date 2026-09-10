import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { Holdings, Prices } from '../../src/core/portfolio.js';
import { validate } from '../../src/core/risk.js';
import type { RiskContext } from '../../src/core/risk.js';
import type {
  Intent,
  IntentLeg,
  Price,
  Quantity,
  RejectionCode,
  Side,
  UsdcAmount,
  Weight,
  Weights,
} from '../../src/core/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RISK_SRC = resolve(ROOT, 'src/core/risk.ts');

const usdc = (v: string): UsdcAmount => new Decimal(v) as UsdcAmount;
const qty = (v: string): Quantity => new Decimal(v) as Quantity;
const price = (v: string): Price => new Decimal(v) as Price;
const weight = (v: string): Weight => new Decimal(v) as Weight;

const BTC = price('60000');
const ETH = price('3000');
const PRICES: Prices = { BTC, ETH };
const WEIGHTS: Weights = { BTC: weight('0.4'), ETH: weight('0.3'), USDC: weight('0.3') };

const HOLDINGS: Holdings = {
  BTC: qty(new Decimal('40000').div('60000').toString()),
  ETH: qty(new Decimal('30000').div('3000').toString()),
  USDC: qty('30000'),
};

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    makeClientOrderId: ({ runDate, asset, side, legIndex }) =>
      `${runDate}|${asset}|${side}|${legIndex}`,
    mids: { BTC, ETH },
    lastCompleteRebalanceOn: null,
    balances: [],
    holdings: HOLDINGS,
    prices: PRICES,
    ...overrides,
  };
}

function leg(overrides: Partial<IntentLeg> = {}): IntentLeg {
  const asset = overrides.asset ?? 'BTC';
  return {
    quote: 'USDC',
    side: 'BUY' as Side,
    amount: usdc('1500'),
    ...overrides,
    asset,
    limitPrice: overrides.limitPrice ?? (asset === 'ETH' ? ETH : BTC),
  };
}

function intent(legs: readonly IntentLeg[]): Intent {
  return {
    runDate: '2026-08-31',
    strategy: 'rebalance',
    trigger: 'CASH_BAND',
    reason: 'contrat C15',
    weightsBefore: WEIGHTS,
    weightsTarget: WEIGHTS,
    legs,
  };
}

function codeOf(i: Intent, ctx: RiskContext = context()): RejectionCode {
  const verdict = validate(i, ctx);
  if (verdict.status !== 'REJECTED' || verdict.rejections[0] === undefined) {
    throw new Error('rejet attendu');
  }
  return verdict.rejections[0].code;
}

describe('C15 : les 9 codes de rejet sont atteints', () => {
  it('atteint chaque RejectionCode au moins une fois', () => {
    const reached = new Set<RejectionCode>([
      codeOf(intent([leg({ asset: 'SOL' })])),
      codeOf(intent([leg({ quote: 'EUR' })])),
      codeOf(
        intent([leg({ amount: usdc('10000') })]),
        context({
          holdings: {
            BTC: qty(new Decimal('45000').div('60000').toString()),
            ETH: qty(new Decimal('15000').div('3000').toString()),
            USDC: qty('40000'),
          },
        }),
      ),
      codeOf(intent([leg({ amount: usdc('9000') })])),
      codeOf(
        intent([
          leg({ asset: 'BTC', side: 'SELL', amount: usdc('13000') }),
          leg({ asset: 'ETH', side: 'BUY', amount: usdc('13000') }),
        ]),
      ),
      (() => {
        const verdict = validate(intent([leg({ amount: usdc('12') })]), context());
        if (verdict.status !== 'ACCEPTED' || verdict.ignored[0] === undefined) {
          throw new Error('LEG_TOO_SMALL attendu dans ignored');
        }
        return verdict.ignored[0].code;
      })(),
      codeOf(intent([leg()]), context({ lastCompleteRebalanceOn: '2026-08-30' })),
      codeOf(intent([leg({ limitPrice: price('90000') })])),
      codeOf(
        intent([leg()]),
        context({
          balances: [{ asset: 'BTC', onExchange: qty('1'), internal: qty('0.5') }],
        }),
      ),
    ]);

    expect(reached).toEqual(
      new Set([
        'ASSET_NOT_ALLOWED',
        'QUOTE_NOT_ALLOWED',
        'MAX_EXPOSURE',
        'MIN_CASH',
        'REBALANCE_TOO_LARGE',
        'LEG_TOO_SMALL',
        'COOLDOWN',
        'PRICE_SANITY',
        'RECONCILIATION_DRIFT',
      ]),
    );
  });
});

describe('C22 : absence de contournement (garde-fou grossier)', () => {
  it('le source de risk.ts ne contient pas dryRun, force, bypass, skipValidation', () => {
    const source = readFileSync(RISK_SRC, 'utf8');
    for (const needle of ['dryRun', 'force', 'bypass', 'skipValidation'] as const) {
      expect(source.includes(needle), `chaine interdite presente : ${needle}`).toBe(false);
    }
  });
});
