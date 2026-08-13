import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { computeMandatoryFeesForNight } from "./mandatoryFees";
import { resolveRateCard, seasonForDate } from "./resolveRateCard";

describe("mandatoryFees - Cheetah's corrected Conservation Levy", () => {
  it("charges $20/person conservation levy, not the old wrong $10 - reproduces the exact $60 gap from the Corrections Log", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-cheetah-tented-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-08-15"),
    });
    expect(rateCard).not.toBeNull();

    const result = await computeMandatoryFeesForNight({
      rateCardId: rateCard!.id,
      date: new Date("2027-08-15"),
      season: "peak",
      pax: { adults: 2, children: 1, youngAdults: 0, under4: 0 },
    });

    const conservationLevy = result.lineItems.find((li) => li.path === "conservationLevy");
    expect(conservationLevy?.amount).toBe(20);
    expect(conservationLevy?.subtotal).toBe(60); // 3 pax x $20

    // Per-night total: communityBedLevy (10x3=30) + conservationLevy (20x3=60) + lumoConservationFee (37x2 + 19x1 = 93)
    expect(result.total).toBe(183);
    // With the old wrong $10 figure this would have been 153 (conservationLevy=30) -
    // a $30/night gap, i.e. $60 over the 2-night quote the Corrections Log documents.
    expect(result.total - 153).toBe(30);
  });
});

describe("mandatoryFees - Mara Bush Camp's date-window Park Fee", () => {
  it("uses the Jan-Jun figure ($100/$50), not a season-based figure", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-mara-bush-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-03-15"),
    });
    const { seasonName } = seasonForDate(rateCard!.seasons, new Date("2027-03-15"));
    expect(seasonName).toBe("extendedGreen");

    const result = await computeMandatoryFeesForNight({
      rateCardId: rateCard!.id,
      date: new Date("2027-03-15"),
      season: seasonName,
      pax: { adults: 2, children: 0, youngAdults: 0, under4: 0 },
    });

    const parkFee = result.lineItems.find((li) => li.path === "parkFee" && li.occupancy === "adult");
    expect(parkFee?.amount).toBe(100);
  });

  it("uses the Jul-Dec figure ($200/$50) for a date in extendedGreen season - proving the split is by calendar date, not season", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-mara-bush-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-10-15"),
    });
    const { seasonName } = seasonForDate(rateCard!.seasons, new Date("2027-10-15"));
    expect(seasonName).toBe("extendedGreen"); // same season as the Jan-Jun test above

    const result = await computeMandatoryFeesForNight({
      rateCardId: rateCard!.id,
      date: new Date("2027-10-15"),
      season: seasonName,
      pax: { adults: 2, children: 0, youngAdults: 0, under4: 0 },
    });

    const parkFee = result.lineItems.find((li) => li.path === "parkFee" && li.occupancy === "adult");
    expect(parkFee?.amount).toBe(200); // different from the Mar-15 case despite identical season name
  });

  it("uses the seasonal (not date-window) Community Levy figures correctly for Peak vs Shoulder", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-mara-bush-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-08-01"),
    });
    const result = await computeMandatoryFeesForNight({
      rateCardId: rateCard!.id,
      date: new Date("2027-08-01"),
      season: "peak",
      pax: { adults: 1, children: 1, youngAdults: 0, under4: 0 },
    });
    const communityLevyAdult = result.lineItems.find((li) => li.path === "communityLevy" && li.occupancy === "adult");
    const communityLevyChild = result.lineItems.find((li) => li.path === "communityLevy" && li.occupancy === "child");
    expect(communityLevyAdult?.amount).toBe(80);
    expect(communityLevyChild?.amount).toBe(40);
  });
});

describe("mandatoryFees - no fabricated figures for known gaps", () => {
  it("Mara Bush Camp's Family Unit figure is now confirmed and present (resolved 13 Aug 2026)", async () => {
    // Previously disputed/unverified (never found in the source PDF at the time) - now
    // independently confirmed via two separate documents in the 13 Aug 2026 portal
    // batch (the STO 10% doc and the standalone Rack doc), both giving the same figures
    // ($2,048 FB / $2,748 Ground Package at Peak) directly on Mara's own page. This test
    // now guards the opposite regression: that the figure doesn't silently disappear again.
    const figureCount = await prisma.rateFigure.count({
      where: {
        rateCard: { property: { slug: "soroi-mara-bush-camp" }, tier: "Rack Rate" },
        path: { contains: "familyUnit" },
      },
    });
    expect(figureCount).toBeGreaterThan(0);
  });
});

describe("mandatoryFees - Young Adult bracket is flagged, not silently assumed", () => {
  it("flags when a Young Adult is charged the adult mandatory-fee rate", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-larsens-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-08-01"),
    });
    const result = await computeMandatoryFeesForNight({
      rateCardId: rateCard!.id,
      date: new Date("2027-08-01"),
      season: "peak",
      pax: { adults: 1, children: 0, youngAdults: 1, under4: 0 },
    });
    expect(result.flags.some((f) => f.includes("Young Adults"))).toBe(true);
  });
});
