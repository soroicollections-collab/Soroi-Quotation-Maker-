import { prisma } from "@/lib/db";
import { PaxBreakdown } from "./types";

/**
 * Mandatory fee shape varies by property (CLAUDE.md: 3-part flat, 2-part
 * season+date-window, 1-part flat, %-surcharge, or none) - never assume a
 * common shape. Rather than hardcoding a shape per property, this reads
 * whatever mandatory_fee figures actually exist on the rate card and applies
 * each one according to its OWN season/dateRange/occupancy metadata, which
 * generalizes correctly across every shape seen so far without a property
 * name ever appearing in this file.
 */
export async function computeMandatoryFeesForNight(params: {
  rateCardId: string;
  date: Date;
  season: string | null;
  pax: PaxBreakdown;
}) {
  const fees = await prisma.rateFigure.findMany({
    where: { rateCardId: params.rateCardId, category: "mandatory_fee" },
  });
  if (fees.length === 0) return { total: 0, lineItems: [] as LineItem[], flags: [] as string[] };

  const flags: string[] = [];
  const applicable = fees.filter((f) => {
    if (f.dateRangeStart && f.dateRangeEnd) return params.date >= f.dateRangeStart && params.date <= f.dateRangeEnd;
    if (f.season) return f.season === params.season;
    return true; // flat fee, no season/date dependency
  });

  const surcharge = applicable.find((f) => f.path.endsWith(".surchargePct"));
  const baseFees = applicable.filter((f) => !f.path.endsWith(".surchargePct"));

  const lineItems: LineItem[] = [];
  let total = 0;

  for (const fee of baseFees) {
    const count = occupancyCount(fee.occupancy, params.pax, fee.path, flags);
    if (count === 0) continue;
    const amount = Number(fee.amount);
    const subtotal = amount * count;
    total += subtotal;
    lineItems.push({ path: fee.path, occupancy: fee.occupancy ?? undefined, amount, count, subtotal });
    if (!fee.verified) flags.push(`${fee.path}: unverified - ${fee.confidenceNote ?? "no confidence note"}`);
    else if (fee.confidenceNote) flags.push(`${fee.path}: ${fee.confidenceNote}`);
  }

  if (surcharge) {
    const pct = Number(surcharge.amount) / 100;
    const surchargeAmount = total * pct;
    total += surchargeAmount;
    lineItems.push({ path: surcharge.path, amount: Number(surcharge.amount), count: 1, subtotal: surchargeAmount });
    if (surcharge.confidenceNote) flags.push(`${surcharge.path}: ${surcharge.confidenceNote}`);
  }

  return { total, lineItems, flags };
}

type LineItem = { path: string; occupancy?: string; amount: number; count: number; subtotal: number };

function occupancyCount(
  occupancy: string | null,
  pax: PaxBreakdown,
  path: string,
  flags: string[]
): number {
  if (occupancy === "adult") {
    if (pax.youngAdults > 0) {
      flags.push(
        `${path}: Young Adults (12-17) charged at the adult mandatory-fee rate - CLAUDE.md documents this as an inference (no source explicitly addresses the 12-17 bracket for mandatory fees), not a stated rule.`
      );
    }
    return pax.adults + pax.youngAdults;
  }
  if (occupancy === "child") return pax.children;
  if (occupancy && occupancy.startsWith("child_")) {
    flags.push(`${path}: this property's child bracket ("${occupancy}") differs from Soroi's standard 5-11 bracket - verify which of your travelers actually falls in it before trusting this line.`);
    return pax.children + pax.youngAdults;
  }
  if (!occupancy) {
    // Flat "per person per night" fee with no adult/child split in the source at all.
    flags.push(`${path}: fee has no adult/child split in the source ("per person per night") - applied to all pax excluding under-4s as an inference consistent with the portfolio's general free-under-4 policy.`);
    return pax.adults + pax.children + pax.youngAdults;
  }
  return 0;
}
