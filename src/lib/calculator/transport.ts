import { prisma } from "@/lib/db";

/**
 * Sunworld transport is priced per-vehicle-per-day, not per person and not as
 * a point-to-point fare (~200km/day included). Long routes (e.g. Cheetah-
 * Nairobi-Mara) likely exceed that allowance with no excess-km rate stated
 * anywhere in the source - CLAUDE.md is explicit that any total using this
 * figure is a floor estimate only, so this always returns that flag.
 *
 * The peak window (1 Jul-30 Sep & 20 Dec-2 Jan) is transport-specific and
 * distinct from any given lodge's own season calendar, so it's hardcoded
 * here from the source document rather than looked up via RateCardSeason
 * (which models per-property lodge seasons, not this global transport calendar).
 */
function isTransportPeak(date: Date): boolean {
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const inJulSep = month >= 6 && month <= 8;
  const inFestive = (month === 11 && day >= 20) || (month === 0 && day <= 2);
  return inJulSep || inFestive;
}

export async function computeTransportForDay(date: Date) {
  const property = await prisma.property.findUnique({ where: { slug: "sunworld-transport" } });
  if (!property) return { amount: 0, flags: ["Sunworld transport rate data not found."] };

  const rateCard = await prisma.rateCard.findFirst({ where: { propertyId: property.id, status: "published" } });
  if (!rateCard) return { amount: 0, flags: ["No published Sunworld transport rate card found."] };

  const season = isTransportPeak(date) ? "peak" : "restOfYear";
  const figure = await prisma.rateFigure.findFirst({
    where: { rateCardId: rateCard.id, category: "vehicle_rate", path: "dailyRate", season },
  });
  if (!figure) return { amount: 0, flags: [`No Sunworld day rate found for season "${season}".`] };

  return {
    amount: Number(figure.amount),
    flags: [
      "Sunworld's day rate covers ~200km; long camp-to-camp routes likely exceed this with no excess-km rate stated anywhere in the source. Treat this total as a floor estimate only and confirm the real total with Sunworld operations before finalizing.",
    ],
  };
}
