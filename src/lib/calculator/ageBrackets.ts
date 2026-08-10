import { PaxBreakdown } from "./types";

/**
 * Portfolio-wide terms (CLAUDE.md): child 5-11 = 50% of adult sharing rate,
 * under 4 = free (sharing), young adult 12-17 sharing = 75% of adult rate.
 * Applies to a per-person "sharing" occupancy rate - NOT the single rate,
 * which is already its own directly-priced figure.
 */
export function computeAccommodationForPax(
  perPersonRate: number,
  pax: PaxBreakdown
): { total: number; breakdown: { type: string; count: number; rate: number; subtotal: number }[] } {
  const breakdown: { type: string; count: number; rate: number; subtotal: number }[] = [];
  let total = 0;

  if (pax.adults > 0) {
    const subtotal = perPersonRate * pax.adults;
    breakdown.push({ type: "adult", count: pax.adults, rate: perPersonRate, subtotal });
    total += subtotal;
  }
  if (pax.youngAdults > 0) {
    const rate = perPersonRate * 0.75;
    const subtotal = rate * pax.youngAdults;
    breakdown.push({ type: "youngAdult", count: pax.youngAdults, rate, subtotal });
    total += subtotal;
  }
  if (pax.children > 0) {
    const rate = perPersonRate * 0.5;
    const subtotal = rate * pax.children;
    breakdown.push({ type: "child", count: pax.children, rate, subtotal });
    total += subtotal;
  }
  if (pax.under4 > 0) {
    breakdown.push({ type: "under4", count: pax.under4, rate: 0, subtotal: 0 });
  }

  return { total, breakdown };
}
