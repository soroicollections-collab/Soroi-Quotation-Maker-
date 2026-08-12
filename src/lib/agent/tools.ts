import * as fs from "node:fs";
import * as path from "node:path";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { prisma } from "@/lib/db";
import { computeQuote } from "@/lib/calculator/quote";
import type { StayLineItemInput } from "@/lib/calculator/types";

// rates-extracted/ lives inside webapp/ (moved here from the parent project root so it
// ships with the Vercel deployment - a sibling directory outside the project root
// wouldn't be reachable by the deployed function). Read-only from the agent's
// perspective - it never writes here (rate updates go through the Phase 1
// upload/extract/publish pipeline, which writes to Postgres, not these files).
const RATES_EXTRACTED_DIR = path.resolve(process.cwd(), "rates-extracted");

// Files already covered by the normalized Postgres schema (see migrate-rates.ts) -
// the agent should use lookup_soroi_rate_card_options / calculate_quote for these,
// not read them as raw JSON. Kept as a prefix/exact-match list so list_non_soroi_rate_files
// doesn't surface duplicates of data already available through the tested calculator path.
const DB_COVERED_PREFIXES = [
  "cheetah-tented-camp-",
  "lions-bluff-lodge-",
  "leopards-lair-cottages-",
  "mara-bush-camp-",
  "private-wing-",
  "luxury-migration-camp-",
  "larsens-camp-",
  "samburu-lodge-",
  "amboseli-",
  "blue-diani-",
  "tortilis-camp-amboseli-",
  "solio-lodge-",
  "nairobi-hotels-",
  "sunworld-transport-",
  "flights-amboseli-mara-nanyuki-",
];

function isDbCovered(filename: string): boolean {
  return DB_COVERED_PREFIXES.some((p) => filename.startsWith(p));
}

// ---------------------------------------------------------------------------
// Tool-call recording. The Anthropic Tool Runner executes each tool's `run`
// internally and constructs the follow-up tool_result message itself, without
// exposing that message back to the caller. To persist a replayable transcript
// (Conversation/ConversationMessage - the audit trail standing in for a human
// reviewer, per the build plan) the route handler needs the raw {name, input,
// output} of every call. Every tool below reports through this recorder instead
// of returning its result directly, so the route handler can reconstruct the
// exact tool_result blocks that must accompany each tool_use block on replay.
// ---------------------------------------------------------------------------

export type ToolCallRecorder = (name: string, input: unknown, output: string) => void;

function recordingRun<TInput, TOutput extends string>(
  name: string,
  onCall: ToolCallRecorder,
  fn: (input: TInput) => Promise<TOutput>
) {
  return async (input: TInput) => {
    const output = await fn(input);
    onCall(name, input, output);
    return output;
  };
}

// ---------------------------------------------------------------------------
// list_soroi_properties
// ---------------------------------------------------------------------------

function makeListSoroiPropertiesTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "list_soroi_properties",
    description:
      "List all 10 Soroi Collection properties with their slug, display name, and region. " +
      "Call this first when the itinerary involves a Soroi property and you don't already know its exact slug.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: recordingRun("list_soroi_properties", onCall, async () => {
      const properties = await prisma.property.findMany({
        where: { category: "soroi-lodge" },
        select: { slug: true, displayName: true, region: true },
        orderBy: { region: "asc" },
      });
      return JSON.stringify(properties);
    }),
  });
}

// ---------------------------------------------------------------------------
// get_soroi_rate_card_options
// ---------------------------------------------------------------------------

function makeGetSoroiRateCardOptionsTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "get_soroi_rate_card_options",
    description:
      "For a given Soroi property + tier + residency, returns what's actually available in the rate card: " +
      "the validity window, whether it's an unconfirmed stand-in year, the property's own mandatory-fee shape, " +
      "and the exact room category / meal plan / occupancy-mode values you must pass to calculate_quote. " +
      "Call this BEFORE calculate_quote for any Soroi property - never guess a room category or meal plan name.",
    inputSchema: {
      type: "object",
      properties: {
        propertySlug: { type: "string", description: "Exact slug from list_soroi_properties, e.g. 'soroi-cheetah-tented-camp'." },
        tier: {
          type: "string",
          description:
            "Exact tier label as stored, e.g. 'Rack Rate', 'STO 30%', 'STO 40%'. Must be confirmed with the requester first - never default or guess.",
        },
        residency: { type: "string", enum: ["Non-Resident", "Resident"] },
      },
      required: ["propertySlug", "tier", "residency"],
      additionalProperties: false,
    },
    run: recordingRun("get_soroi_rate_card_options", onCall, async ({ propertySlug, tier, residency }) => {
      const property = await prisma.property.findUnique({ where: { slug: propertySlug } });
      if (!property) {
        return JSON.stringify({ error: `No property found for slug "${propertySlug}". Call list_soroi_properties to see valid slugs.` });
      }

      const rateCard = await prisma.rateCard.findFirst({
        where: { propertyId: property.id, tier, residency, status: "published" },
        include: { figures: { where: { category: "accommodation" } } },
      });

      if (!rateCard) {
        const availableTiers = await prisma.rateCard.findMany({
          where: { propertyId: property.id, status: "published" },
          select: { tier: true, residency: true },
          distinct: ["tier", "residency"],
        });
        return JSON.stringify({
          error: `No published rate card for ${propertySlug} / ${tier} / ${residency}.`,
          availableTiersForThisProperty: availableTiers,
        });
      }

      // Parse room category / meal plan / occupancy-mode combinations directly out of the
      // figure paths that were actually migrated, rather than guessing at a shared shape.
      const combos = new Set<string>();
      let hasPerVilla = false;
      let hasSingle = false;
      for (const f of rateCard.figures) {
        const parts = f.path.split(".");
        // Multi-category shape: "<roomCategory>.<mealPlan>.<occupancy>[.rack|.net]"
        // Simple shape: "<mealPlan>.<occupancy>[.rack|.net]"
        combos.add(f.path);
        if (f.occupancy === "single" || f.path.includes(".single")) hasSingle = true;
        if (f.path.includes("familyUnit") === false && parts.length <= 2 && f.occupancy == null) hasPerVilla = true;
      }

      return JSON.stringify({
        propertySlug,
        displayName: property.displayName,
        tier: rateCard.tier,
        residency: rateCard.residency,
        validityStart: rateCard.validityStart.toISOString().slice(0, 10),
        validityEnd: rateCard.validityEnd.toISOString().slice(0, 10),
        standInForYear: rateCard.standInForYear,
        standInConfirmed: rateCard.standInConfirmed,
        standInReason: rateCard.standInReason,
        mandatoryFeeShape: rateCard.mandatoryFeeShape,
        occupancyModesSeen: { sharing: true, single: hasSingle, perVilla: hasPerVilla },
        accommodationFigurePaths: Array.from(combos).sort(),
        note: "accommodationFigurePaths shows exactly what's priced. Pass the roomCategory (the first path segment, if the paths are multi-part) and mealPlan (fullBoard/groundPackage/halfBoard) that match what the requester wants - do not invent a category that isn't listed here.",
      });
    }),
  });
}

// ---------------------------------------------------------------------------
// calculate_quote
// ---------------------------------------------------------------------------

const payBreakdownSchema = {
  type: "object",
  properties: {
    adults: { type: "integer", minimum: 0 },
    children: { type: "integer", minimum: 0, description: "Age 5-11" },
    youngAdults: { type: "integer", minimum: 0, description: "Age 12-17" },
    under4: { type: "integer", minimum: 0, description: "Age 0-4, free of accommodation charge" },
  },
  required: ["adults", "children", "youngAdults", "under4"],
  additionalProperties: false,
} as const;

function makeCalculateQuoteTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "calculate_quote",
    description:
      "Deterministically computes prices for one or more property stays, using the published rate cards in the database. " +
      "This is the ONLY way pricing numbers should be produced - never do arithmetic yourself. Returns per-night breakdowns, " +
      "subtotals, applied discounts, and an explicit flags[] array for anything estimated, unverified, or needing confirmation. " +
      "Every flag returned MUST be surfaced to the requester in chat, grouped by severity - never silently dropped and never " +
      "baked into the final document without being mentioned first.",
    inputSchema: {
      type: "object",
      properties: {
        stays: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              propertySlug: { type: "string" },
              tier: { type: "string" },
              residency: { type: "string", enum: ["Non-Resident", "Resident"] },
              checkIn: { type: "string", description: "ISO date, e.g. 2027-07-14" },
              checkOut: { type: "string", description: "ISO date, exclusive - the night of checkOut itself is not charged" },
              roomCategory: { type: "string", description: "Omit for single-category properties. Must match a value seen in get_soroi_rate_card_options." },
              mealPlan: { type: "string", description: "e.g. fullBoard, groundPackage, halfBoard - must match get_soroi_rate_card_options." },
              occupancyMode: { type: "string", enum: ["sharing", "single", "perVilla"] },
              pax: payBreakdownSchema,
            },
            required: ["propertySlug", "tier", "residency", "checkIn", "checkOut", "mealPlan", "occupancyMode", "pax"],
            additionalProperties: false,
          },
        },
      },
      required: ["stays"],
      additionalProperties: false,
    },
    run: recordingRun("calculate_quote", onCall, async ({ stays }) => {
      const inputs: StayLineItemInput[] = stays.map((s) => ({
        propertySlug: s.propertySlug,
        tier: s.tier,
        residency: s.residency,
        checkIn: new Date(s.checkIn),
        checkOut: new Date(s.checkOut),
        roomCategory: s.roomCategory,
        mealPlan: s.mealPlan,
        occupancyMode: s.occupancyMode as "sharing" | "single" | "perVilla",
        pax: s.pax,
      }));
      const result = await computeQuote(inputs);
      return JSON.stringify(result);
    }),
  });
}

// ---------------------------------------------------------------------------
// list_flexible_variable_options
// ---------------------------------------------------------------------------

function makeListFlexibleVariableOptionsTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "list_flexible_variable_options",
    description:
      "Returns the known priced options for a flexible variable that must never be assumed or defaulted - " +
      "present these to the requester and let them choose, per CLAUDE.md's standing rule. " +
      "Currently supports 'tier' and 'nairobi_hotel'. Call this whenever the requester hasn't specified one of these.",
    inputSchema: {
      type: "object",
      properties: {
        variable: { type: "string", enum: ["tier", "nairobi_hotel"] },
      },
      required: ["variable"],
      additionalProperties: false,
    },
    run: recordingRun("list_flexible_variable_options", onCall, async ({ variable }) => {
      if (variable === "tier") {
        return JSON.stringify({
          knownTiers: [
            "Rack Rate (Non-Resident)",
            "Resident Rate (East Africa)",
            "STO 15%", "STO 20%", "STO 25%", "STO 30%", "STO 35%", "STO 40%",
            "Brass", "Bronze", "Silver", "Gold", "Preferred", "Super Preferred", "Platinum",
          ],
          note: "STO's exact relationship to the Brass-Platinum named tiers is UNCONFIRMED - never assume 'STO 20%' equals any specific named tier. Only Rack Rate, STO 30%, and STO 40% currently have verified figures in the database for most Soroi properties (a few also have STO 30%). If a requested tier has no published rate card, get_soroi_rate_card_options will report that explicitly - surface it rather than substituting a different tier's numbers.",
        });
      }
      // nairobi_hotel
      const hotels = await prisma.property.findMany({
        where: { category: "nairobi-hotel" },
        include: { rateCards: { include: { figures: true } } },
      });
      const options = hotels.map((h) => ({
        slug: h.slug,
        displayName: h.displayName,
        totalPerNight: h.rateCards[0]?.figures[0]?.amount?.toString(),
        unit: h.rateCards[0]?.figures[0]?.unit,
        note: h.rateCards[0]?.figures[0]?.confidenceNote ?? undefined,
      }));
      return JSON.stringify({
        knownOptions: options,
        note: "Nairobi/stopover hotel is confirmed as 'never fixed' - always present these options and let the requester choose, never default to one. More candidates exist unverified and would need fresh extraction - say so if the requester asks for a hotel not in this list.",
      });
    }),
  });
}

// ---------------------------------------------------------------------------
// present_choices
// ---------------------------------------------------------------------------

// Purely a UI signal - the chat route (api/quote/chat/route.ts) detects calls to this tool
// and forwards {question, options} to the browser as a "choices" SSE event, which renders
// them as clickable buttons under the assistant's message (see chat-client.tsx). Clicking
// one sends its exact label back as the requester's next message - no special handling
// needed on that end, it's indistinguishable from them having typed it. This tool's `run`
// does no real work; it exists so the option list reaches the frontend as structured data
// instead of the model's prose being parsed for it, which would be unreliable.
function makePresentChoicesTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "present_choices",
    description:
      "Shows the requester clickable buttons for a multiple-choice question, so they can tap an answer instead of " +
      "typing it. Use this for any genuinely enumerable choice - tier, Nairobi/stopover hotel, meal plan, room " +
      "category, occupancy mode, or similar - never for open-ended questions like dates, nights, or guest counts, " +
      "which the requester should just type normally. Call this right after the text response that explains the " +
      "question, using the exact same option labels - whichever one they click is sent back to you verbatim as " +
      "their next message, so word each option exactly as you'd want to receive it back.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Short label for what's being asked, e.g. 'Which tier applies?' - shown above the buttons." },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description: "Exact clickable option labels, e.g. ['Rack Rate (Non-Resident)', 'STO 30%', 'STO 40%'].",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    run: recordingRun("present_choices", onCall, async () => {
      return JSON.stringify({
        ok: true,
        note: "Options presented to the requester as clickable buttons - the buttons themselves already make it visually obvious you're waiting for an answer, so end your turn here rather than adding a closing sentence like 'I'll wait for your selection.' Do not assume which one they'll pick.",
      });
    }),
  });
}

// ---------------------------------------------------------------------------
// list_non_soroi_rate_files / read_non_soroi_rate_file
// ---------------------------------------------------------------------------

function makeListNonSoroiRateFilesTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "list_non_soroi_rate_files",
    description:
      "Searches filenames in the non-Soroi rates archive (~389 properties/operators: general Kenya accommodation, beach hotels, " +
      "flights, transport, park fees, excursions - Tortilis, Solio, Nairobi hotels, Sunworld transport, and the core flight routes " +
      "are NOT here, they're already in the database via calculate_quote). This data has NOT been normalized into the tested " +
      "calculator schema - you must read the file yourself with read_non_soroi_rate_file and reason over its own shape, checking " +
      "its own currency, meal-plan basis, and child-age policy rather than assuming Soroi's conventions apply.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive substring to match against filenames, e.g. 'kicheche' or 'diamonds'." },
      },
      required: ["search"],
      additionalProperties: false,
    },
    run: recordingRun("list_non_soroi_rate_files", onCall, async ({ search }) => {
      const all = fs.readdirSync(RATES_EXTRACTED_DIR).filter((f) => f.endsWith(".json"));
      const needle = search.toLowerCase();
      const matches = all.filter((f) => !isDbCovered(f) && f.toLowerCase().includes(needle));
      return JSON.stringify({
        matches,
        note: matches.length === 0
          ? "No filename match. Try a shorter or differently-spelled substring, or tell the requester this property isn't in the extracted archive and would need fresh extraction from the SharePoint source."
          : undefined,
      });
    }),
  });
}

function makeReadNonSoroiRateFileTool(onCall: ToolCallRecorder) {
  return betaTool({
    name: "read_non_soroi_rate_file",
    description:
      "Reads one file from the non-Soroi rates archive and returns its raw JSON content for you to reason over directly. " +
      "Check the file's own 'verified' flags per-figure (never blanket-trust a whole file), its own currency field (not everything " +
      "is USD), its own meal-plan basis, and its own child-age policy. If the file documents an unresolved conflict with another " +
      "source (see CLAUDE.md's list: KSLH, Kicheche Laikipia, Hodari Africa's Ewaso Camp, Ol Gaboli, Airvan, Solio's conservation " +
      "fee), do not quote from it - surface the conflict instead and say it needs reconciling with the operator.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Exact filename from list_non_soroi_rate_files, e.g. 'kicheche-laikipia-2026.json'." },
      },
      required: ["filename"],
      additionalProperties: false,
    },
    run: recordingRun("read_non_soroi_rate_file", onCall, async ({ filename }) => {
      const base = path.basename(filename);
      if (base !== filename || !base.endsWith(".json")) {
        return JSON.stringify({ error: "Invalid filename." });
      }
      const fullPath = path.join(RATES_EXTRACTED_DIR, base);
      if (!fs.existsSync(fullPath)) {
        return JSON.stringify({ error: `File "${base}" not found. Call list_non_soroi_rate_files to search again.` });
      }
      return fs.readFileSync(fullPath, "utf-8");
    }),
  });
}

// ---------------------------------------------------------------------------
// finalize_quote
// ---------------------------------------------------------------------------

function nextQuoteSequence(preparerInitials: string, date: Date) {
  const dateOnly = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return prisma.$queryRaw<{ nextSeq: number }[]>`
    INSERT INTO "QuoteSequence" ("preparerInitials", "date", "nextSeq")
    VALUES (${preparerInitials}, ${dateOnly}, 2)
    ON CONFLICT ("preparerInitials", "date")
    DO UPDATE SET "nextSeq" = "QuoteSequence"."nextSeq" + 1
    RETURNING "nextSeq" - 1 AS "nextSeq"
  `;
}

const itineraryDaySchema = {
  type: "object",
  properties: {
    dayLabel: { type: "string", description: "e.g. '01' or '02-03'." },
    destination: { type: "string" },
    details: { type: "string" },
    overnightPropertySlug: { type: "string", description: "Omit for a departure day with no overnight stay." },
    overnightPropertyName: { type: "string" },
    mealPlanLabel: { type: "string", description: "e.g. 'Full Board', 'Bed & Breakfast'." },
  },
  required: ["dayLabel", "destination", "details"],
  additionalProperties: false,
} as const;

function makeFinalizeQuoteTool(userId: string, preparerInitials: string, conversationId: string, onCall: ToolCallRecorder) {
  return betaTool({
    name: "finalize_quote",
    description:
      "Allocates a Quote ID, re-runs the same stays through the deterministic calculator (so the finalized numbers can never " +
      "drift from what calculate_quote already showed the requester), and saves everything needed to generate BOTH the " +
      "agent-facing and client-facing PDFs - never ask the requester which format they want, both are always made available. " +
      "HARD REQUIREMENT (enforced by this tool, not just instructions): confirmedFlexibleVariables.tier must be set to whatever " +
      "tier the requester actually confirmed - this call fails otherwise. Only call this once the requester has confirmed every " +
      "flexible variable that applies (tier always; Nairobi hotel if one is included) and you've already surfaced every " +
      "[Inference]/[Speculation]/[Unverified] item from calculate_quote in the chat. The output is always a DRAFT.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: "Short human-readable itinerary description, e.g. 'Cheetah Tented Camp -> Nairobi -> Mara Bush Camp'." },
        stays: {
          type: "array",
          minItems: 1,
          description: "Identical shape to calculate_quote's 'stays' input - re-priced here from scratch as the source of truth for the generated document.",
          items: {
            type: "object",
            properties: {
              propertySlug: { type: "string" },
              tier: { type: "string" },
              residency: { type: "string", enum: ["Non-Resident", "Resident"] },
              checkIn: { type: "string" },
              checkOut: { type: "string" },
              roomCategory: { type: "string" },
              mealPlan: { type: "string" },
              occupancyMode: { type: "string", enum: ["sharing", "single", "perVilla"] },
              pax: payBreakdownSchema,
            },
            required: ["propertySlug", "tier", "residency", "checkIn", "checkOut", "mealPlan", "occupancyMode", "pax"],
            additionalProperties: false,
          },
        },
        guestsSummary: { type: "string", description: "e.g. '2 Adults + 1 Child'." },
        travelDatesLabel: { type: "string", description: "e.g. '14-16 July 2027'." },
        durationLabel: { type: "string", description: "e.g. '2 Days / 2 Nights'." },
        itineraryDays: { type: "array", minItems: 1, items: itineraryDaySchema },
        transfers: {
          type: "array",
          description: "Multi-leg routes only - omit entirely for a single-property stay.",
          items: {
            type: "object",
            properties: { description: { type: "string" }, amount: { type: "number" } },
            required: ["description", "amount"],
            additionalProperties: false,
          },
        },
        inclusions: { type: "array", items: { type: "string" }, description: "Omit to use the standard portfolio-wide defaults." },
        exclusions: { type: "array", items: { type: "string" }, description: "Omit to use the standard portfolio-wide defaults." },
        notes: { type: "array", items: { type: "string" }, description: "Omit to use the standard validity/deposit notes." },
        specialRequests: {
          type: "array",
          items: { type: "string" },
          description:
            "Anything specific to this trip worth flagging to both sides, distinct from the standard validity/deposit notes - " +
            "a client's special request (dietary need, celebration, honeymoon), or something Soroi/Sunworld wants to suggest " +
            "back to the client (e.g. a sundowner, a spa treatment, an early check-in). Ask the requester if there's anything " +
            "like this before finalizing - omit entirely if there's genuinely nothing beyond the standard itinerary.",
        },
        confirmedFlexibleVariables: {
          type: "object",
          properties: {
            tier: { type: "string" },
            nairobiHotel: { type: "string" },
          },
          required: ["tier"],
          additionalProperties: true,
        },
        assumptionsSurfaced: {
          type: "array",
          items: { type: "string" },
          description: "Every [Inference]/[Speculation]/[Unverified] item you already told the requester about, for the audit record. Empty array if none applied.",
        },
      },
      required: [
        "route", "stays", "guestsSummary", "travelDatesLabel", "durationLabel",
        "itineraryDays", "confirmedFlexibleVariables", "assumptionsSurfaced",
      ],
      additionalProperties: false,
    },
    run: recordingRun("finalize_quote", onCall, async (input) => {
      if (!input.confirmedFlexibleVariables.tier || input.confirmedFlexibleVariables.tier.trim() === "") {
        return JSON.stringify({
          error: "confirmedFlexibleVariables.tier is required and cannot be empty. Ask the requester which tier applies before finalizing.",
        });
      }

      const now = new Date();
      const rows = await nextQuoteSequence(preparerInitials, now);
      const seq = rows[0].nextSeq;
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
      const quoteId = `SQ-${preparerInitials}-${dateStr}-${String(seq).padStart(3, "0")}`;

      const quote = await prisma.quote.create({
        data: { quoteId, preparerId: userId, route: input.route, status: "draft" },
      });

      // Links this conversation to its (latest) quote, so the sidebar can show a title
      // and the chat page can offer PDF downloads when this conversation is reopened -
      // see the Conversation.quoteId field. A conversation that finalizes more than once
      // (e.g. a revision) just points at whichever quote was finalized most recently.
      await prisma.conversation.update({ where: { id: conversationId }, data: { quoteId: quote.id } });

      const [{ computeQuote: computeQuoteFn }, { buildQuoteDocumentData }] = await Promise.all([
        import("@/lib/calculator/quote"),
        import("@/lib/render/quote-data"),
      ]);

      const stayInputs = input.stays.map((s) => ({
        propertySlug: s.propertySlug,
        tier: s.tier,
        residency: s.residency,
        checkIn: new Date(s.checkIn),
        checkOut: new Date(s.checkOut),
        roomCategory: s.roomCategory,
        mealPlan: s.mealPlan,
        occupancyMode: s.occupancyMode as "sharing" | "single" | "perVilla",
        pax: s.pax,
      }));
      const quoteResult = await computeQuoteFn(stayInputs);

      // Save the structured data needed to render the PDF, not the PDF itself - the
      // download route renders on demand from this and streams the result straight to
      // the browser. Nothing is written to disk here, which is what makes this safe to
      // run on a stateless serverless host.
      const documentData = await buildQuoteDocumentData({
        quoteId,
        preparerName: preparerInitials,
        routeTitle: input.route,
        quoteResult,
        content: {
          guestsSummary: input.guestsSummary,
          travelDatesLabel: input.travelDatesLabel,
          durationLabel: input.durationLabel,
          itineraryDays: input.itineraryDays,
          transfers: input.transfers,
          inclusions: input.inclusions,
          exclusions: input.exclusions,
          notes: input.notes,
          specialRequests: input.specialRequests,
        },
      });

      await prisma.quote.update({
        where: { id: quote.id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { documentData: documentData as any },
      });

      return JSON.stringify({
        quoteId,
        status: "draft",
        grandTotal: documentData.grandTotal,
        calculatorFlags: quoteResult.flags,
        confirmedFlexibleVariables: input.confirmedFlexibleVariables,
        assumptionsSurfaced: input.assumptionsSurfaced,
        note: "Quote saved as a DRAFT. Download links are generated on demand from this data - it must never be presented to a client as final. Report calculatorFlags to the requester if any are non-empty, even at this stage.",
      });
    }),
  });
}

export function allTools(userId: string, preparerInitials: string, conversationId: string, onCall: ToolCallRecorder) {
  return [
    makeListSoroiPropertiesTool(onCall),
    makeGetSoroiRateCardOptionsTool(onCall),
    makeCalculateQuoteTool(onCall),
    makeListFlexibleVariableOptionsTool(onCall),
    makePresentChoicesTool(onCall),
    makeListNonSoroiRateFilesTool(onCall),
    makeReadNonSoroiRateFileTool(onCall),
    makeFinalizeQuoteTool(userId, preparerInitials, conversationId, onCall),
  ];
}
