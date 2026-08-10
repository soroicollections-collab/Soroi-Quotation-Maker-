import { resolveRateCard, seasonForDate } from "./resolveRateCard";
import { lookupAccommodationFigure } from "./accommodation";
import { computeAccommodationForPax } from "./ageBrackets";
import { computeMandatoryFeesForNight } from "./mandatoryFees";
import { circuitDiscountPct } from "./discounts";
import { isFestiveNight, christmasSupplementForNight } from "./supplements";
import { NightBreakdown, StayLineItemInput, StayResult, QuoteResult } from "./types";

function nightsBetween(checkIn: Date, checkOut: Date): Date[] {
  const nights: Date[] = [];
  const cursor = new Date(Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate()));
  const end = new Date(Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate()));
  while (cursor < end) {
    nights.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

/** Computes one property stay. Every number traces back to a stored RateFigure -
 * this function never invents or estimates a price itself. */
export async function computeStay(input: StayLineItemInput): Promise<StayResult> {
  const nightDates = nightsBetween(input.checkIn, input.checkOut);
  const nights: NightBreakdown[] = [];
  const stayFlags: string[] = [];

  for (const date of nightDates) {
    const flags: string[] = [];
    const { rateCard, flag: cardFlag } = await resolveRateCard({
      propertySlug: input.propertySlug,
      tier: input.tier,
      residency: input.residency,
      date,
    });
    if (cardFlag) flags.push(cardFlag);

    if (!rateCard) {
      nights.push({
        date,
        season: null,
        accommodation: { total: 0, perPersonBreakdown: [], unverified: true },
        mandatoryFees: { total: 0, lineItems: [] },
        christmasSupplement: 0,
        flags,
      });
      continue;
    }

    const { seasonName, flag: seasonFlag } = seasonForDate(rateCard.seasons, date);
    if (seasonFlag) flags.push(seasonFlag);

    const occupancy = input.occupancyMode === "single" ? "single" : input.occupancyMode === "perVilla" ? undefined : "perPerson";
    const { figure, flag: figFlag, flags: figFlags } = await lookupAccommodationFigure({
      rateCardId: rateCard.id,
      roomCategory: input.roomCategory,
      mealPlan: input.mealPlan,
      occupancy,
      season: seasonName,
      tier: input.tier,
    });
    if (figFlag) flags.push(figFlag);
    if (figFlags) flags.push(...figFlags);

    let accommodationTotal = 0;
    let perPersonBreakdown: { type: string; count: number; rate: number; subtotal: number }[] = [];
    if (figure) {
      const rate = Number(figure.amount);
      if (input.occupancyMode === "sharing") {
        const result = computeAccommodationForPax(rate, input.pax);
        accommodationTotal = result.total;
        perPersonBreakdown = result.breakdown;
      } else if (input.occupancyMode === "single") {
        accommodationTotal = rate * input.pax.adults;
        perPersonBreakdown = [{ type: "single", count: input.pax.adults, rate, subtotal: accommodationTotal }];
        if (input.pax.children + input.pax.youngAdults + input.pax.under4 > 0) {
          flags.push("Single occupancy booked alongside non-adult travelers - confirm this is intentional (singles are normally solo adults).");
        }
      } else {
        accommodationTotal = rate; // per-villa: flat per night, not multiplied by pax
        perPersonBreakdown = [{ type: "perVilla", count: 1, rate, subtotal: rate }];
      }
    }

    const feesResult = await computeMandatoryFeesForNight({
      rateCardId: rateCard.id,
      date,
      season: seasonName,
      pax: input.pax,
    });
    flags.push(...feesResult.flags);

    let christmasSupplement = 0;
    if (isFestiveNight(date)) {
      const supp = christmasSupplementForNight(input.pax);
      christmasSupplement = supp.total;
      flags.push(...supp.flags);
    }

    nights.push({
      date,
      season: seasonName,
      accommodation: { total: accommodationTotal, perPersonBreakdown, unverified: !figure },
      mandatoryFees: { total: feesResult.total, lineItems: feesResult.lineItems },
      christmasSupplement,
      flags,
    });
  }

  const accommodationSubtotal = nights.reduce((sum, n) => sum + n.accommodation.total, 0);
  const mandatoryFeesSubtotal = nights.reduce((sum, n) => sum + n.mandatoryFees.total, 0);
  const christmasSupplementSubtotal = nights.reduce((sum, n) => sum + n.christmasSupplement, 0);

  const festiveNightCount = nightDates.filter(isFestiveNight).length;
  const qualifyingNights = nightDates.length - festiveNightCount;
  const discountPct = circuitDiscountPct(qualifyingNights);
  const discountAmount = accommodationSubtotal * discountPct;
  if (discountPct > 0) {
    stayFlags.push(
      `Circuit/long-stay discount (${(discountPct * 100).toFixed(0)}%) applied to the accommodation subtotal only, not mandatory fees or the Christmas supplement - this split isn't explicitly stated in the source, it's the calculator's working assumption.`
    );
  }

  for (const n of nights) stayFlags.push(...n.flags);

  const total = accommodationSubtotal - discountAmount + mandatoryFeesSubtotal + christmasSupplementSubtotal;

  return {
    input,
    nights,
    accommodationSubtotal,
    mandatoryFeesSubtotal,
    christmasSupplementSubtotal,
    circuitDiscountPct: discountPct,
    circuitDiscountAmount: discountAmount,
    total,
    flags: stayFlags,
  };
}

export async function computeQuote(stays: StayLineItemInput[]): Promise<QuoteResult> {
  const results: StayResult[] = [];
  for (const stay of stays) results.push(await computeStay(stay));
  const grandTotal = results.reduce((sum, r) => sum + r.total, 0);
  const flags = results.flatMap((r) => r.flags);
  return { stays: results, grandTotal, flags };
}
