import { prisma } from "@/lib/db";

/**
 * Finds the published rate card covering a given date, for a property + tier + residency.
 * Never assumes one card covers a whole stay - callers resolve per night and sum, so a
 * trip spanning a validity boundary (e.g. a year change) prices each night correctly.
 */
export async function resolveRateCard(params: {
  propertySlug: string;
  tier: string;
  residency: string;
  date: Date;
}) {
  const property = await prisma.property.findUnique({ where: { slug: params.propertySlug } });
  if (!property) return { rateCard: null, flag: `No property found for slug "${params.propertySlug}".` };

  const rateCard = await prisma.rateCard.findFirst({
    where: {
      propertyId: property.id,
      tier: params.tier,
      residency: params.residency,
      status: "published",
      validityStart: { lte: params.date },
      validityEnd: { gte: params.date },
    },
    include: { seasons: true },
  });

  if (!rateCard) {
    return {
      rateCard: null,
      flag: `No published rate card covers ${params.date.toISOString().slice(0, 10)} for ${params.propertySlug} / ${params.tier} / ${params.residency}.`,
    };
  }

  let flag: string | undefined;
  if (rateCard.standInForYear && !rateCard.standInConfirmed) {
    flag = `Rate card is an unconfirmed stand-in for ${rateCard.standInForYear}: ${rateCard.standInReason ?? ""}`;
  }

  return { rateCard, flag };
}

/** Given a resolved rate card's seasons, find which named season covers a date. */
export function seasonForDate(
  seasons: { seasonName: string; dateRangeStart: Date; dateRangeEnd: Date }[],
  date: Date
): { seasonName: string | null; flag?: string } {
  const match = seasons.find((s) => date >= s.dateRangeStart && date <= s.dateRangeEnd);
  if (!match) {
    return {
      seasonName: null,
      flag: `No season definition covers ${date.toISOString().slice(0, 10)} - falling back to no seasonal figure lookup.`,
    };
  }
  return { seasonName: match.seasonName };
}
