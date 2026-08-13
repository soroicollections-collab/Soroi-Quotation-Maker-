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
    // Historically every Soroi 2027 card was flagged as an unconfirmed 2026 stand-in,
    // since no real 2026 data existed. As of the 13 Aug 2026 portal batch, 2026 has its
    // own independently-extracted rate cards, so 2027 cards no longer stand in for
    // anything - the migration no longer sets standInForYear on them, and no flag
    // should be raised for a straightforward 2027-date-against-2027-card lookup.
    expect(flag).toBeUndefined();
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
    // STO 15% is real and extracted (13 Aug 2026 batch) - use a tier that
    // genuinely doesn't exist anywhere in the data to keep testing the same thing.
    const { rateCard, flag } = await resolveRateCard({
      propertySlug: "soroi-cheetah-tented-camp",
      tier: "STO 45%",
      residency: "Non-Resident",
      date: new Date("2027-06-01"),
    });
    expect(rateCard).toBeNull();
    expect(flag).toBeDefined();
  });
});
