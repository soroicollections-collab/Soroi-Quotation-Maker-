import { prisma } from "@/lib/db";

/**
 * Looks up one accommodation RateFigure. Rack-only cards store a plain path
 * (e.g. "fullBoard.perPerson"); STO/contract-tier cards store both a ".rack"
 * and a ".net" figure per cell - the ".net" one is what the tour operator
 * actually pays, so any tier other than "Rack Rate" resolves to ".net".
 */
export async function lookupAccommodationFigure(params: {
  rateCardId: string;
  roomCategory?: string;
  mealPlan: string;
  occupancy?: string;
  season: string | null;
  tier: string;
}) {
  const base = [params.roomCategory, params.mealPlan, params.occupancy].filter(Boolean).join(".");
  const path = params.tier === "Rack Rate" ? base : `${base}.net`;

  const figure = await prisma.rateFigure.findFirst({
    where: {
      rateCardId: params.rateCardId,
      category: "accommodation",
      path,
      season: params.season,
    },
  });

  if (!figure) {
    return {
      figure: null,
      flag: `No accommodation figure found for path "${path}" / season "${params.season}". This room category / meal plan / season combination may not exist for this property.`,
    };
  }

  const flags: string[] = [];
  if (!figure.verified) {
    flags.push(`${path} (${params.season}) is unverified: ${figure.confidenceNote ?? "no confidence note on file"}.`);
  } else if (figure.confidenceNote) {
    flags.push(`${path} (${params.season}): ${figure.confidenceNote}`);
  }

  return { figure, flags };
}
