import { describe, it, expect } from "vitest";
import { resolveRateCard } from "./resolveRateCard";

describe("resolveRateCard", () => {
  it("finds the published Cheetah Rack Rate card for a date inside its validity window", async () => {
    const { rateCard, flag } = await resolveRateCard({
      propertySlug: "soroi-cheetah-tented-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2027-06-01"),
    });
    expect(rateCard).not.toBeNull();
    // Every Soroi 2027 card is an unconfirmed 2026 stand-in - resolveRateCard must
    // surface that, never silently treat it as fully confirmed.
    expect(flag).toContain("unconfirmed stand-in");
  });

  it("returns null with an explicit flag for a date outside any published card's validity window", async () => {
    const { rateCard, flag } = await resolveRateCard({
      propertySlug: "soroi-cheetah-tented-camp",
      tier: "Rack Rate",
      residency: "Non-Resident",
      date: new Date("2020-01-01"),
    });
    expect(rateCard).toBeNull();
    expect(flag).toContain("No published rate card covers");
  });

  it("never invents a rate card for an unknown tier - e.g. a tier nobody has extracted yet", async () => {
    const { rateCard, flag } = await resolveRateCard({
      propertySlug: "soroi-cheetah-tented-camp",
      tier: "STO 15%",
      residency: "Non-Resident",
      date: new Date("2027-06-01"),
    });
    expect(rateCard).toBeNull();
    expect(flag).toBeDefined();
  });
});
