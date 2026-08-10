/**
 * Circuit/long-stay discount ladder (CLAUDE.md portfolio-wide terms):
 * 6+ nights = 12%, 9+ nights = 15%, 12+ nights = 20% off. Excludes festive
 * periods - callers must exclude festive nights from `qualifyingNights` themselves.
 * Applied to the accommodation subtotal only, not mandatory fees - this is an
 * assumption (the source doesn't explicitly say fees are excluded), flagged
 * by the caller when the discount is non-zero.
 */
export function circuitDiscountPct(qualifyingNights: number): number {
  if (qualifyingNights >= 12) return 0.2;
  if (qualifyingNights >= 9) return 0.15;
  if (qualifyingNights >= 6) return 0.12;
  return 0;
}
