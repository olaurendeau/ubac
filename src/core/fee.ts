/**
 * Frais Coinbase appliques a une jambe de reequilibrage.
 * `notional` et le retour sont en USDC.
 */
export function feeUsdc(notional: number, bps: number): number {
  return (notional * bps) / 10_000;
}

/** Notionnel net de frais, en USDC. */
export function netNotional(notional: number, bps: number): number {
  return notional - feeUsdc(notional, bps);
}
