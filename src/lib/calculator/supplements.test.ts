import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { isFestiveNight, christmasSupplementForNight } from "./supplements";
import { resolveRateCard, seasonForDate } from "./resolveRateCard";
import { lookupAccommodationFigure } from "./accommodation";

describe("isFestiveNight", () => {
  it("is true for 20 Dec - 31 Dec and 1-3 Jan", () => {
    expect(isFestiveNight(new Date("2027-12-20"))).toBe(true);
    expect(isFestiveNight(new Date("2027-12-31"))).toBe(true);
    expect(isFestiveNight(new Date("2028-01-01"))).toBe(true);
    expect(isFestiveNight(new Date("2028-01-03"))).toBe(true);
  });
  it("is false outside that window", () => {
    expect(isFestiveNight(new Date("2027-12-19"))).toBe(false);
    expect(isFestiveNight(new Date("2028-01-04"))).toBe(false);
    expect(isFestiveNight(new Date("2027-07-15"))).toBe(false);
  });
});

describe("christmasSupplementForNight", () => {
  it("charges $40/adult, $20/child", () => {
    const result = christmasSupplementForNight({ adults: 2, children: 1, youngAdults: 0, under4: 0 });
    expect(result.total).toBe(2 * 40 + 1 * 20);
  });
});

describe("Green Season Mara single supplement (25%, not 50%) - already baked into the stored figure", () => {
  it("Mara Bush Camp's extendedGreen single rate is exactly 1.25x the perPerson rate", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-mara-bush-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-04-01"),
    });
    const { seasonName } = seasonForDate(rateCard!.seasons, new Date("2027-04-01"));
    expect(seasonName).toBe("extendedGreen");

    const perPerson = await lookupAccommodationFigure({
      rateCardId: rateCard!.id, mealPlan: "fullBoard", occupancy: "perPerson", season: seasonName, tier: "Rack Rate",
    });
    const single = await lookupAccommodationFigure({
      rateCardId: rateCard!.id, mealPlan: "fullBoard", occupancy: "single", season: seasonName, tier: "Rack Rate",
    });

    const ratio = Number(single.figure!.amount) / Number(perPerson.figure!.amount);
    expect(ratio).toBeCloseTo(1.25, 5);
  });

  it("Mara Bush Camp's peak single rate is the normal ~1.5x (50% supplement), not 1.25x", async () => {
    const { rateCard } = await resolveRateCard({
      propertySlug: "soroi-mara-bush-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-08-01"),
    });
    const perPerson = await lookupAccommodationFigure({
      rateCardId: rateCard!.id, mealPlan: "fullBoard", occupancy: "perPerson", season: "peak", tier: "Rack Rate",
    });
    const single = await lookupAccommodationFigure({
      rateCardId: rateCard!.id, mealPlan: "fullBoard", occupancy: "single", season: "peak", tier: "Rack Rate",
    });
    const ratio = Number(single.figure!.amount) / Number(perPerson.figure!.amount);
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(1.6);
  });
});

describe("data sanity", () => {
  it("has at least one published rate card in the dev DB (migration must have run)", async () => {
    const count = await prisma.rateCard.count({ where: { status: "published" } });
    expect(count).toBeGreaterThan(0);
  });
});
