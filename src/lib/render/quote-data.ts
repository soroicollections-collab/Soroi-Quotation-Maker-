import { prisma } from "@/lib/db";
import type { QuoteResult, StayResult } from "@/lib/calculator/types";

export type ItineraryDayInput = {
  dayLabel: string; // e.g. "01" or "02-03"
  destination: string;
  details: string;
  overnightPropertySlug?: string; // omit for a departure day with no overnight
  overnightPropertyName?: string;
  mealPlanLabel?: string;
};

export type TransferInput = { description: string; amount: number };

export type FinalizeQuoteContentInput = {
  guestsSummary: string;
  travelDatesLabel: string;
  durationLabel: string;
  itineraryDays: ItineraryDayInput[];
  transfers?: TransferInput[];
  inclusions?: string[];
  exclusions?: string[];
  notes?: string[];
  specialRequests?: string[];
};

export type PropertyLineItemRow = { description: string; pax: string; nights: number; ratePerPersonPerNight: string; subtotal: string };
export type PropertyFeeRow = { description: string; amount: string };

export type PropertySectionData = {
  title: string;
  displayName: string;
  tier: string;
  residency: string;
  nights: number;
  lineItems: PropertyLineItemRow[];
  accommodationSubtotal: string;
  mandatoryFees: PropertyFeeRow[];
  mandatoryFeesSubtotal: string;
  circuitDiscountLabel: string | null;
  propertyTotal: string;
};

export type QuoteDocumentData = {
  quoteId: string;
  preparerName: string;
  dateIssuedLabel: string;
  guestsSummary: string;
  rateBasisLabel: string;
  durationLabel: string;
  travelDatesLabel: string;
  routeTitle: string;
  itineraryDays: (ItineraryDayInput & { overnightLogoDataUri: string | null; overnightWebsiteUrl: string | null })[];
  propertySections: PropertySectionData[];
  hasTransfers: boolean;
  transfers: { description: string; amount: string }[];
  summaryRows: { description: string; amount: string }[];
  grandTotal: string;
  inclusions: string[];
  exclusions: string[];
  notes: string[];
  specialRequests: string[];
};

const DEFAULT_INCLUSIONS = [
  "Accommodation as per itinerary, on the meal basis stated",
  "Park, conservancy and reserve fees as itemized",
  "Game drives and safari activities as per itinerary",
];

const DEFAULT_EXCLUSIONS = [
  "International flights, visas and travel insurance",
  "Alcoholic and premium beverages unless stated otherwise",
  "Laundry, gratuities and items of a personal nature",
  "Optional activities not listed in the itinerary",
];

const DEFAULT_NOTES = [
  "Rates are subject to availability at the time of booking.",
  "A deposit is required to confirm and hold this quotation.",
  "This quotation is valid for 14 days from the date of issue.",
];

// Always appended, never overridable by a custom notes[] the agent supplies - unlike the
// default notes above (which exist only as a convenience and can be swapped out), this is
// a liability-relevant statement that must never silently disappear just because a quote
// happened to pass a custom notes list.
const BOOKING_DISCLAIMER = "This quotation is an estimate only. It does not constitute a confirmed booking or reservation.";

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mealPlanLabel(mealPlan: string): string {
  const labels: Record<string, string> = {
    fullBoard: "Full Board",
    groundPackage: "Ground Package",
    halfBoard: "Half Board",
  };
  return labels[mealPlan] ?? mealPlan;
}

function paxLabel(pax: StayResult["input"]["pax"]): string {
  const parts: string[] = [];
  if (pax.adults) parts.push(`${pax.adults} Adult${pax.adults > 1 ? "s" : ""}`);
  if (pax.children) parts.push(`${pax.children} Child${pax.children > 1 ? "ren" : ""}`);
  if (pax.youngAdults) parts.push(`${pax.youngAdults} Young Adult${pax.youngAdults > 1 ? "s" : ""}`);
  if (pax.under4) parts.push(`${pax.under4} Under 4`);
  return parts.join(" + ") || "-";
}

async function buildPropertySection(stay: StayResult, displayNamesBySlug: Map<string, string>): Promise<PropertySectionData> {
  const displayName = displayNamesBySlug.get(stay.input.propertySlug) ?? stay.input.propertySlug;
  const nights = stay.nights.length;

  // Group per-person-breakdown line items by (type, rate) across all nights of the stay,
  // since the source rate can vary by season within one stay - never collapse to a single
  // blended rate that wasn't actually charged.
  type Key = string;
  const grouped = new Map<Key, { type: string; rate: number; nights: number; subtotal: number }>();
  for (const night of stay.nights) {
    for (const bd of night.accommodation.perPersonBreakdown) {
      const key = `${bd.type}@${bd.rate}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.nights += 1;
        existing.subtotal += bd.subtotal;
      } else {
        grouped.set(key, { type: bd.type, rate: bd.rate, nights: 1, subtotal: bd.subtotal });
      }
    }
  }
  const lineItems: PropertyLineItemRow[] = Array.from(grouped.values()).map((g) => ({
    description: `${mealPlanLabel(stay.input.mealPlan)} (${g.type})`,
    pax: paxLabel(stay.input.pax),
    nights: g.nights,
    ratePerPersonPerNight: `$${money(g.rate)}`,
    subtotal: `$${money(g.subtotal)}`,
  }));

  // Same grouping approach for mandatory fees - group by (path, occupancy) across nights.
  const feeGroups = new Map<string, { description: string; amount: number }>();
  for (const night of stay.nights) {
    for (const item of night.mandatoryFees.lineItems) {
      const key = `${item.path}@${item.occupancy ?? ""}`;
      const label = item.occupancy ? `${item.path} (${item.occupancy})` : item.path;
      const existing = feeGroups.get(key);
      if (existing) existing.amount += item.subtotal;
      else feeGroups.set(key, { description: label, amount: item.subtotal });
    }
  }
  const mandatoryFees: PropertyFeeRow[] = Array.from(feeGroups.values()).map((f) => ({
    description: f.description,
    amount: `$${money(f.amount)}`,
  }));

  return {
    title: `${displayName} — ${nights} Night${nights > 1 ? "s" : ""}`,
    displayName,
    tier: stay.input.tier,
    residency: stay.input.residency,
    nights,
    lineItems,
    accommodationSubtotal: `$${money(stay.accommodationSubtotal - stay.circuitDiscountAmount)}`,
    mandatoryFees,
    mandatoryFeesSubtotal: `$${money(stay.mandatoryFeesSubtotal)}`,
    circuitDiscountLabel:
      stay.circuitDiscountPct > 0
        ? `Circuit/long-stay discount (${(stay.circuitDiscountPct * 100).toFixed(0)}%): -$${money(stay.circuitDiscountAmount)}`
        : null,
    propertyTotal: `$${money(stay.total)}`,
  };
}

export async function buildQuoteDocumentData(params: {
  quoteId: string;
  preparerName: string;
  routeTitle: string;
  quoteResult: QuoteResult;
  content: FinalizeQuoteContentInput;
}): Promise<QuoteDocumentData> {
  const { quoteId, preparerName, routeTitle, quoteResult, content } = params;

  const slugs = Array.from(new Set(quoteResult.stays.map((s) => s.input.propertySlug)));
  const properties = await prisma.property.findMany({ where: { slug: { in: slugs } } });
  const displayNamesBySlug = new Map(properties.map((p) => [p.slug, p.displayName]));

  const propertySections = await Promise.all(
    quoteResult.stays.map((s) => buildPropertySection(s, displayNamesBySlug))
  );

  const { propertyLogoDataUri, propertyWebsiteUrl } = await import("./images");
  const itineraryDays = content.itineraryDays.map((d) => ({
    ...d,
    overnightLogoDataUri: d.overnightPropertySlug ? propertyLogoDataUri(d.overnightPropertySlug) : null,
    overnightWebsiteUrl: d.overnightPropertySlug ? propertyWebsiteUrl(d.overnightPropertySlug) : null,
  }));

  const transfersTotal = (content.transfers ?? []).reduce((sum, t) => sum + t.amount, 0);
  const propertyTotalSum = quoteResult.stays.reduce((sum, s) => sum + s.total, 0);
  const grandTotal = propertyTotalSum + transfersTotal;

  // Itemized rather than one blended figure per property - CLAUDE.md's default inclusions
  // text says "Park, conservancy and reserve fees as itemized", so the summary needs to
  // actually show that split, not just claim it. Each property's rows sum exactly to its
  // stay.total (accommodation net of circuit discount + fees + festive supplement, matching
  // the formula in calculator/quote.ts) so nothing is silently dropped from the total.
  const summaryRows = quoteResult.stays
    .flatMap((s) => {
      const displayName = displayNamesBySlug.get(s.input.propertySlug) ?? s.input.propertySlug;
      const nightsLabel = `${s.nights.length} night${s.nights.length > 1 ? "s" : ""}`;
      const rows = [
        {
          description: `${displayName} — Accommodation (${nightsLabel})`,
          amount: `$${money(s.accommodationSubtotal - s.circuitDiscountAmount)}`,
        },
      ];
      if (s.mandatoryFeesSubtotal > 0) {
        rows.push({ description: `${displayName} — Park & Conservancy Fees`, amount: `$${money(s.mandatoryFeesSubtotal)}` });
      }
      if (s.christmasSupplementSubtotal > 0) {
        rows.push({ description: `${displayName} — Festive Season Supplement`, amount: `$${money(s.christmasSupplementSubtotal)}` });
      }
      return rows;
    })
    .concat((content.transfers ?? []).map((t) => ({ description: t.description, amount: `$${money(t.amount)}` })));

  const tiers = Array.from(new Set(quoteResult.stays.map((s) => `${s.input.tier} (${s.input.residency})`)));

  return {
    quoteId,
    preparerName,
    dateIssuedLabel: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    guestsSummary: content.guestsSummary,
    rateBasisLabel: tiers.join(" / "),
    durationLabel: content.durationLabel,
    travelDatesLabel: content.travelDatesLabel,
    routeTitle,
    itineraryDays,
    propertySections,
    hasTransfers: propertySections.length > 1,
    transfers: (content.transfers ?? []).map((t) => ({ description: t.description, amount: `$${money(t.amount)}` })),
    summaryRows,
    grandTotal: `$${money(grandTotal)}`,
    inclusions: content.inclusions ?? DEFAULT_INCLUSIONS,
    exclusions: content.exclusions ?? DEFAULT_EXCLUSIONS,
    notes: [...(content.notes ?? DEFAULT_NOTES), BOOKING_DISCLAIMER],
    specialRequests: content.specialRequests ?? [],
  };
}
