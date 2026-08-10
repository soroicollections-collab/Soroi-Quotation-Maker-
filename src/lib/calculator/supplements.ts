import { PaxBreakdown } from "./types";

/**
 * Christmas/New Year supplement: $40/adult, $20/child per night (CLAUDE.md
 * portfolio-wide terms). The festive window itself isn't documented as a
 * separately-dated rule - every property's Peak season definition includes
 * a "20 Dec - 3 Jan"-shaped sub-range, so that's used here as the festive
 * window. Single-supplement is NOT computed here: the "single" occupancy
 * rate is already its own directly-priced figure (confirmed against source
 * data - e.g. Mara's Green Season single/perPerson ratio is exactly 1.25,
 * matching the documented 25%-not-50% Green Season Mara exception already
 * baked into the stored figure), so no separate supplement calculation
 * is needed or should be layered on top.
 */
export function isFestiveNight(date: Date): boolean {
  const month = date.getUTCMonth(); // 0-indexed
  const day = date.getUTCDate();
  return (month === 11 && day >= 20) || (month === 0 && day <= 3);
}

export function christmasSupplementForNight(pax: PaxBreakdown): { total: number; flags: string[] } {
  const flags: string[] = [];
  const adultCount = pax.adults + pax.youngAdults;
  if (pax.youngAdults > 0) {
    flags.push(
      "Christmas/New Year supplement applied at the adult rate to Young Adults (12-17) - inferred for consistency with the mandatory-fee treatment, not separately stated in the source."
    );
  }
  const total = adultCount * 40 + pax.children * 20;
  return { total, flags };
}
