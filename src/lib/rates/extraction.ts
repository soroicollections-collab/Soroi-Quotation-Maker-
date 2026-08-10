import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// A normalized shape that maps directly onto RateCard/RateFigure/RateCardSeason, not a
// reproduction of whatever bespoke layout the source document happens to use - per
// CLAUDE.md, every rate document has its own shape, so extraction's job is to flatten
// into the schema that actually matters rather than mirror the PDF's own structure.
export type ProposedFigure = {
  category: string; // accommodation | mandatory_fee | portfolio_term
  path: string; // e.g. "luxuryTents.fullBoard.single"
  season?: string;
  occupancy?: string;
  amount: number;
  unit: string;
  currency: string;
  verified: boolean;
  confidenceNote?: string;
  sourcePage?: number;
};

export type ProposedSeason = { seasonName: string; rawLabel: string; startDate: string; endDate: string };

export type ProposedRateCard = {
  extractedPropertyName: string;
  suggestedPropertySlug: string;
  suggestedRegion: string;
  suggestedCategory: string; // soroi-lodge | non-soroi-lodge | nairobi-hotel | transport | flight
  tier: string;
  residency: string;
  validityStart: string; // ISO date - empty string if genuinely not stated in the source
  validityEnd: string;
  mandatoryFeeShapeDescription: string;
  figures: ProposedFigure[];
  seasons: ProposedSeason[];
  extractionNotes: string[];
};

export type ExtractionOutput = { rateCards: ProposedRateCard[] };

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    rateCards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          extractedPropertyName: { type: "string", description: "Exactly as printed in the source document, no normalization." },
          suggestedPropertySlug: { type: "string", description: "Best-guess kebab-case slug, e.g. 'soroi-cheetah-tented-camp'. The Rate Manager confirms or overrides this - never trust it blindly." },
          suggestedRegion: { type: "string" },
          suggestedCategory: { type: "string", enum: ["soroi-lodge", "non-soroi-lodge", "nairobi-hotel", "transport", "flight"] },
          tier: { type: "string" },
          residency: { type: "string" },
          validityStart: { type: "string", description: "ISO date (YYYY-MM-DD), or empty string if not stated anywhere in the document." },
          validityEnd: { type: "string" },
          mandatoryFeeShapeDescription: { type: "string", description: "Describe THIS property's own mandatory-fee structure in plain English. Never assume it matches any other property." },
          figures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["accommodation", "mandatory_fee", "portfolio_term"] },
                path: { type: "string" },
                season: { type: "string" },
                occupancy: { type: "string" },
                amount: { type: "number" },
                unit: { type: "string" },
                currency: { type: "string" },
                verified: { type: "boolean", description: "True only if this figure is directly traceable to a specific page/row in the source and confidently belongs to THIS property, not a neighboring one." },
                confidenceNote: { type: "string", description: "Required whenever verified is false - explain what's uncertain." },
                sourcePage: { type: "number" },
              },
              required: ["category", "path", "amount", "unit", "currency", "verified"],
              additionalProperties: false,
            },
          },
          seasons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                seasonName: { type: "string" },
                rawLabel: { type: "string" },
                startDate: { type: "string" },
                endDate: { type: "string" },
              },
              required: ["seasonName", "rawLabel", "startDate", "endDate"],
              additionalProperties: false,
            },
          },
          extractionNotes: {
            type: "array",
            items: { type: "string" },
            description: "Any caveats: adjacent-property cross-checks performed, ambiguous figures, misfiled content, anything CLAUDE.md would want flagged.",
          },
        },
        required: [
          "extractedPropertyName", "suggestedPropertySlug", "suggestedRegion", "suggestedCategory",
          "tier", "residency", "validityStart", "validityEnd", "mandatoryFeeShapeDescription",
          "figures", "seasons", "extractionNotes",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["rateCards"],
  additionalProperties: false,
} as const;

const EXTRACTION_SYSTEM_PROMPT = `You are extracting structured rate data from a Sunworld Safaris / Soroi Collection rate document, for the Soroi Quotation Maker's rate database.

Rules (from CLAUDE.md, the project's rulebook):
1. A single document can cover MULTIPLE properties (e.g. a multi-lodge contract PDF). Produce one entry in rateCards[] per property found.
2. **Adjacent-property misattribution is a real, documented failure mode.** When properties sit on consecutive pages with similarly-structured tables, a figure can get attributed to the wrong neighbor. Before marking any figure verified:true, confirm the property name appears directly on the same page/section as that figure - do not assume table order matches a table of contents.
3. **Never assume a shared mandatory-fee shape across properties.** Describe each property's own fee structure in mandatoryFeeShapeDescription based only on what that property's own page states.
4. **verified must be true only for figures you can directly trace to a specific row/cell in the source, confidently attributed to the right property.** If a figure is ambiguous, estimated, or you're not fully sure it belongs to this property, set verified:false and explain why in confidenceNote. Never fabricate a figure that doesn't appear in the source, even to fill a gap you'd expect to exist.
5. If the document is image-only/scanned and no text is extractable, or a page is illegible, say so explicitly in extractionNotes rather than guessing at numbers.
6. suggestedPropertySlug is a best-effort guess only - the Rate Manager will confirm or correct it against the actual Property table, so don't worry about perfect slug formatting.
7. Flatten whatever the document's own layout is into the normalized category/path/season/occupancy/amount shape - do not try to preserve the source's own JSON-like structure.`;

export async function extractRatesFromDocument(pdfBytes: Buffer): Promise<ExtractionOutput> {
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL_EXTRACTION || "claude-opus-5",
    max_tokens: 16000,
    system: EXTRACTION_SYSTEM_PROMPT,
    output_config: { effort: "high", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") },
          },
          { type: "text", text: "Extract every rate card and figure from this document per the rules above." },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Extraction returned no text content.");
  }
  return JSON.parse(textBlock.text) as ExtractionOutput;
}
