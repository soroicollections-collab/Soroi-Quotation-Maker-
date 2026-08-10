import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { circuitDiscountPct } from "./discounts";

describe("circuitDiscountPct", () => {
  it("gives 0% below 6 nights", () => {
    expect(circuitDiscountPct(5)).toBe(0);
  });
  it("gives 12% at 6+ nights", () => {
    expect(circuitDiscountPct(6)).toBe(0.12);
    expect(circuitDiscountPct(8)).toBe(0.12);
  });
  it("gives 15% at 9+ nights", () => {
    expect(circuitDiscountPct(9)).toBe(0.15);
    expect(circuitDiscountPct(11)).toBe(0.15);
  });
  it("gives 20% at 12+ nights", () => {
    expect(circuitDiscountPct(12)).toBe(0.2);
    expect(circuitDiscountPct(30)).toBe(0.2);
  });
});

describe("STO 30% = Rack x 0.70 exactly (the one mechanically-verified relationship on record)", () => {
  it("holds for every Larsens Camp Luxury Tents figure", async () => {
    const rackFigures = await prisma.rateFigure.findMany({
      where: {
        rateCard: { property: { slug: "soroi-larsens-camp" }, tier: "STO 30%" },
        category: "accommodation",
        path: { endsWith: ".rack" },
      },
    });
    expect(rackFigures.length).toBeGreaterThan(0);

    for (const rackFig of rackFigures) {
      const netPath = rackFig.path.replace(/\.rack$/, ".net");
      const netFig = await prisma.rateFigure.findFirst({
        where: { rateCardId: rackFig.rateCardId, path: netPath, season: rackFig.season, occupancy: rackFig.occupancy },
      });
      expect(netFig, `missing .net counterpart for ${rackFig.path} (${rackFig.season})`).not.toBeNull();
      // rack * 7 / 10 instead of rack * 0.7 - the latter hits IEEE754 imprecision
      // (e.g. 535 * 0.7 = 374.49999999999994 in JS) that rounds the wrong way
      // right at the .5 boundary the source data actually relies on.
      const expectedNet = Math.round((Number(rackFig.amount) * 7) / 10);
      expect(Number(netFig!.amount)).toBe(expectedNet);
    }
  });
});
