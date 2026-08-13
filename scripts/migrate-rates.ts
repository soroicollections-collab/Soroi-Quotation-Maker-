/**
 * One-time migration: rates-extracted/*.json + rates/manifest.json -> normalized DB schema.
 *
 * Scope of this pass (Phase 0): accommodation figures + mandatory fees for every property,
 * plus non-lodge items (Nairobi hotels, Sunworld transport, flights). Portfolio-wide terms
 * (child %, young adult %, circuit discount ladder, Tour Leader rates, Christmas supplement)
 * are intentionally NOT migrated into RateFigure here - they're policy/formula, not
 * per-room-per-season rate data, and belong in the Phase 2 calculator as small structured
 * config (with property-specific overrides like Larsens' higher TL rate). Flagged as a
 * follow-up, not silently dropped.
 *
 * Every rates-extracted/*.json file has its own hand-written shape (confirmed by direct
 * inspection - see CLAUDE.md's "mandatory-fee structure varies by property" rule, which
 * applies just as much to the JSON shape itself). Rather than one generic recursive
 * flattener guessing at semantics, this script reads each file at runtime and applies a
 * small set of shared shape-walkers for the properties that DO share a shape, plus
 * explicit bespoke code for the ones that don't - mirroring the project's own
 * "never assume a shared shape, check each one" rule.
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";

const RATES_DIR = path.resolve(__dirname, "../rates-extracted");

function loadJson<T = any>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.join(RATES_DIR, filename), "utf-8"));
}

// ---------------------------------------------------------------------------
// Date range parsing: source strings look like "1 Jul – 31 Oct", "20 Dec – 3 Jan 2028",
// "Jul 1 - Oct 31", "Jan 1 - Jan 5". Ambiguous/unparseable ranges are skipped and logged,
// never silently guessed.
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const skippedRanges: string[] = [];

function parseOneDate(s: string): { day: number; month: number; year?: number } | null {
  s = s.trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?$/); // "1 Jul" / "20 Dec 2028"
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return { day: parseInt(m[1], 10), month, year: m[3] ? parseInt(m[3], 10) : undefined };
  }
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2})(?:\s+(\d{4}))?$/); // "Jul 1" / "Dec 20 2028"
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return { day: parseInt(m[2], 10), month, year: m[3] ? parseInt(m[3], 10) : undefined };
  }
  return null;
}

function parseDateRange(label: string, contextYear: number): { start: Date; end: Date } | null {
  const cleaned = label.replace(/–/g, "-").trim();
  const parts = cleaned.split("-").map((s) => s.trim());
  if (parts.length !== 2) {
    skippedRanges.push(label);
    return null;
  }
  const start = parseOneDate(parts[0]);
  const end = parseOneDate(parts[1]);
  if (!start || !end) {
    skippedRanges.push(label);
    return null;
  }
  const startYear = start.year ?? contextYear;
  let endYear = end.year ?? contextYear;
  if (!end.year && (end.month < start.month || (end.month === start.month && end.day < start.day))) {
    endYear = startYear + 1;
  }
  return {
    start: new Date(Date.UTC(startYear, start.month, start.day)),
    end: new Date(Date.UTC(endYear, end.month, end.day)),
  };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type FigureSeed = {
  category: string;
  path: string;
  season?: string;
  dateRangeStart?: Date;
  dateRangeEnd?: Date;
  occupancy?: string;
  amount: number;
  unit: string;
  currency?: string;
  verified: boolean;
  confidenceNote?: string;
  sourcePage?: number;
};

type SeasonSeed = { seasonName: string; rawLabel: string; start: Date; end: Date };

type RateCardSeed = {
  propertySlug: string;
  displayName: string;
  region: string;
  propertyCategory: string; // soroi-lodge | non-soroi-lodge | nairobi-hotel | transport | flight
  tier: string;
  residency: string;
  validityStart: Date;
  validityEnd: Date;
  standInForYear?: number;
  standInReason?: string;
  standInConfirmed?: boolean;
  mandatoryFeeShape?: string;
  sourceDocFile: string;
  extractedFile: string;
  figures: FigureSeed[];
  seasons: SeasonSeed[];
};

function seasonsFromBlock(
  seasonsBlock: Record<string, any>,
  contextYear: number
): SeasonSeed[] {
  const out: SeasonSeed[] = [];
  for (const [seasonName, def] of Object.entries(seasonsBlock)) {
    if (seasonName === "note" || !def || !Array.isArray((def as any).dateRanges)) continue;
    for (const rawLabel of (def as any).dateRanges as string[]) {
      const parsed = parseDateRange(rawLabel, contextYear);
      if (!parsed) continue;
      out.push({ seasonName, rawLabel, start: parsed.start, end: parsed.end });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generic accommodation walker - for the properties that share the
// "rates.<mealPlan>.<occupancy>.<season>[.rack/net]" or
// "accommodation.<roomCategory>.<mealPlan>.<occupancy>.<season>[.rack/net]" shape.
// ---------------------------------------------------------------------------

function isRackNetCell(v: any): v is { rack?: number; net?: number; nett?: number } {
  return v && typeof v === "object" && ("rack" in v || "net" in v || "nett" in v);
}

function emitSeasonMap(
  seasonMap: Record<string, any>,
  category: string,
  basePath: string,
  occupancy: string | undefined,
  unit: string,
  sourcePage: number | undefined
): FigureSeed[] {
  const out: FigureSeed[] = [];
  for (const [season, val] of Object.entries(seasonMap)) {
    if (val == null) continue;
    if (isRackNetCell(val)) {
      if (typeof val.rack === "number") {
        out.push({ category, path: `${basePath}.rack`, season, occupancy, amount: val.rack, unit, verified: true, sourcePage });
      }
      const netVal = typeof val.net === "number" ? val.net : val.nett;
      if (typeof netVal === "number") {
        out.push({ category, path: `${basePath}.net`, season, occupancy, amount: netVal, unit, verified: true, sourcePage });
      }
    } else if (typeof val === "number") {
      out.push({ category, path: basePath, season, occupancy, amount: val, unit, verified: true, sourcePage });
    }
  }
  return out;
}

/** Walks one mealPlan block (fullBoard/groundPackage/...). Handles the villa-style
 * flat season map (no occupancy wrapper) and the normal occupancy-wrapped map.
 * Explicitly unresolved figures (verified:false marker blocks with no real numbers,
 * e.g. Mara's Family Unit) are logged and skipped - never fabricated. */
function emitMealPlanBlock(
  mealPlanData: Record<string, any>,
  category: string,
  roomCatPath: string,
  mealPlanName: string,
  unit: string,
  sourcePage: number | undefined,
  gapLog: string[]
): FigureSeed[] {
  const out: FigureSeed[] = [];
  const base = roomCatPath ? `${roomCatPath}.${mealPlanName}` : mealPlanName;
  const entries = Object.entries(mealPlanData).filter(([k]) => k !== "unit");

  const looksFlatSeasonMap = entries.every(([, v]) => typeof v === "number" || isRackNetCell(v));
  if (looksFlatSeasonMap) {
    return emitSeasonMap(mealPlanData, category, base, undefined, unit, sourcePage);
  }

  for (const [occupancy, seasonMapOrMarker] of entries) {
    if (!seasonMapOrMarker || typeof seasonMapOrMarker !== "object") continue;
    const numericKeys = Object.entries(seasonMapOrMarker).filter(
      ([, v]) => typeof v === "number" || isRackNetCell(v)
    );
    if ((seasonMapOrMarker as any).verified === false && numericKeys.length === 0) {
      const reason = (seasonMapOrMarker as any).note || (seasonMapOrMarker as any).warning || "unresolved - no figure in source";
      gapLog.push(`${base}.${occupancy}: ${reason}`);
      continue;
    }
    out.push(...emitSeasonMap(Object.fromEntries(numericKeys), category, `${base}.${occupancy}`, occupancy, unit, sourcePage));
  }
  return out;
}

// Only these keys are genuine meal-plan blocks (occupancy x season nested maps).
// Anything else sitting alongside them (a flat one-off discount, a marker object
// for a figure that doesn't exist, etc.) must NOT be fed through the generic
// season-map walker - it either fabricates numbers (e.g. Mara's disputed
// familyUnit.asStatedInClaudeMd figures) or mislabels real ones with a fake
// "season" name (e.g. Private Wing's forestFacingTentDiscount). Handle every
// non-mealplan sibling key explicitly, one line per known case, and log
// (never silently drop) anything encountered that isn't recognized yet.
const KNOWN_MEAL_PLAN_KEYS = new Set(["fullBoard", "groundPackage", "halfBoard"]);

function handleKnownStraySiblingKey(
  key: string,
  block: any,
  unit: string,
  sourcePage: number | undefined,
  gapLog: string[]
): FigureSeed[] {
  if (block && typeof block === "object" && block.verified === false) {
    gapLog.push(`${key}: ${block.note || block.warning || "unresolved - no figure in source"} (not inserted, no fabricated figure)`);
    return [];
  }
  if (key === "forestFacingTentDiscount") {
    return [{ category: "accommodation", path: key, amount: block.amount, unit: block.unit, verified: true, sourcePage }];
  }
  if (key === "selfCatering") {
    if (typeof block.rate === "number") {
      // Rack-tier shape: single flat rate, no season split.
      return [{ category: "accommodation", path: key, amount: block.rate, unit: block.unit, verified: true, sourcePage }];
    }
    // STO-tier shape: per-season rack/net cells. Leopard's Lair's STO 40% cell here is the
    // documented Net=Rack*0.74 anomaly (every other line item is *0.60) - preserve the
    // source's own flag as a confidenceNote rather than "correcting" it. See CLAUDE.md Known Issues.
    const anomalyNote = block.discountRatioAnomaly?.flag ? block.discountRatioAnomaly.note : undefined;
    const out: FigureSeed[] = [];
    for (const [season, cell] of Object.entries(block)) {
      if (!isRackNetCell(cell)) continue;
      const c = cell as { rack?: number; net?: number };
      if (typeof c.rack === "number") out.push({ category: "accommodation", path: `${key}.rack`, season, amount: c.rack, unit: block.unit, verified: true, sourcePage });
      if (typeof c.net === "number") out.push({ category: "accommodation", path: `${key}.net`, season, amount: c.net, unit: block.unit, verified: true, sourcePage, confidenceNote: anomalyNote });
    }
    return out;
  }
  gapLog.push(`UNRECOGNIZED sibling key "${key}" (value: ${JSON.stringify(block)}) - not migrated, needs a bespoke handler added before this figure is available in the app.`);
  return [];
}

function emitAccommodation(
  ratesOrAccommodation: Record<string, any>,
  multiCategory: boolean,
  sourcePage: number | undefined,
  gapLog: string[]
): FigureSeed[] {
  const out: FigureSeed[] = [];
  const category = "accommodation";

  if (!multiCategory) {
    const unit = ratesOrAccommodation.unit || "per person per night";
    for (const mealPlanName of Object.keys(ratesOrAccommodation)) {
      if (["currency", "unit", "roomCategory"].includes(mealPlanName)) continue;
      const block = ratesOrAccommodation[mealPlanName];
      if (!block || typeof block !== "object") continue;
      if (!KNOWN_MEAL_PLAN_KEYS.has(mealPlanName)) {
        out.push(...handleKnownStraySiblingKey(mealPlanName, block, unit, sourcePage, gapLog));
        continue;
      }
      out.push(...emitMealPlanBlock(block, category, "", mealPlanName, unit, sourcePage, gapLog));
    }
    return out;
  }

  for (const roomCat of Object.keys(ratesOrAccommodation)) {
    const roomCatData = ratesOrAccommodation[roomCat];
    if (!roomCatData || typeof roomCatData !== "object") continue;
    const unit = roomCatData.unit || "per person per night";
    for (const mealPlanName of Object.keys(roomCatData)) {
      if (["currency", "unit", "roomNote", "validity", "validityNote"].includes(mealPlanName)) continue;
      const block = roomCatData[mealPlanName];
      if (!block || typeof block !== "object") continue;
      if (!KNOWN_MEAL_PLAN_KEYS.has(mealPlanName)) {
        out.push(...handleKnownStraySiblingKey(mealPlanName, block, unit, sourcePage, gapLog));
        continue;
      }
      out.push(...emitMealPlanBlock(block, category, roomCat, mealPlanName, unit, sourcePage, gapLog));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mandatory fee shape builders - explicit per shape, per CLAUDE.md's
// "mandatory-fee structure varies by property, never assume a common shape" rule.
// ---------------------------------------------------------------------------

function feesLumo3Part(mf: any, sourcePage?: number): FigureSeed[] {
  const out: FigureSeed[] = [];
  out.push({
    category: "mandatory_fee", path: "communityBedLevy", amount: mf.communityBedLevy.amount,
    unit: mf.communityBedLevy.unit, verified: true, sourcePage,
  });
  out.push({
    category: "mandatory_fee", path: "conservationLevy", amount: mf.conservationLevy.amount,
    unit: mf.conservationLevy.unit, verified: true, sourcePage,
    confidenceNote: mf.conservationLevy.correctionNote,
  });
  out.push({
    category: "mandatory_fee", path: "lumoConservationFee", occupancy: "adult",
    amount: mf.lumoConservationFee.adult, unit: mf.lumoConservationFee.unit, verified: true, sourcePage,
  });
  out.push({
    category: "mandatory_fee", path: "lumoConservationFee", occupancy: "child",
    amount: mf.lumoConservationFee.child, unit: mf.lumoConservationFee.unit, verified: true, sourcePage,
  });
  return out;
}

function feesMaraStyle(mf: any, contextYear: number, sourcePage?: number): { figures: FigureSeed[] } {
  const figures: FigureSeed[] = [];
  for (const season of ["peak", "shoulder", "extendedGreen"]) {
    const block = mf.communityLevy[season];
    if (!block) continue;
    figures.push({ category: "mandatory_fee", path: "communityLevy", season, occupancy: "adult", amount: block.adult, unit: block.unit, verified: true, sourcePage });
    figures.push({ category: "mandatory_fee", path: "communityLevy", season, occupancy: "child", amount: block.child, unit: block.unit, verified: true, sourcePage });
  }
  const windows: Array<["janToJun" | "julToDec", string, string]> = [
    ["janToJun", `${contextYear}-01-01`, `${contextYear}-06-30`],
    ["julToDec", `${contextYear}-07-01`, `${contextYear}-12-31`],
  ];
  const ambiguityNote = "Wording says 'per adult per 12h' - genuinely unclear if that means one charge per calendar day. Current working assumption: one charge per night. Flag on any quote using this figure.";
  for (const [key, startStr, endStr] of windows) {
    const block = mf.parkFee[key];
    if (!block) continue;
    figures.push({
      category: "mandatory_fee", path: "parkFee", occupancy: "adult", amount: block.adult, unit: block.unit,
      dateRangeStart: new Date(startStr), dateRangeEnd: new Date(endStr), verified: true, sourcePage,
      confidenceNote: ambiguityNote,
    });
    figures.push({
      category: "mandatory_fee", path: "parkFee", occupancy: "child", amount: block.child, unit: block.unit,
      dateRangeStart: new Date(startStr), dateRangeEnd: new Date(endStr), verified: true, sourcePage,
      confidenceNote: ambiguityNote,
    });
  }
  return { figures };
}

function feesSamburu1Part(mf: any, sourcePage?: number): FigureSeed[] {
  const fee = mf.samburuReserveFee;
  return [
    { category: "mandatory_fee", path: "samburuReserveFee", occupancy: "adult", amount: fee.adult, unit: fee.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "samburuReserveFee", occupancy: "child", amount: fee.child, unit: fee.unit, verified: true, sourcePage },
  ];
}

// ---------------------------------------------------------------------------
// Per-file loaders - one per rates-extracted/*.json file. Each knows its own
// file's real shape (confirmed by direct read, not assumed).
// ---------------------------------------------------------------------------

const SOROI_2027_VALIDITY = { start: new Date("2027-01-04"), end: new Date("2028-01-03") };
const STAND_IN_2026 = {
  standInForYear: 2026,
  standInReason: "No 2026 non-resident file exists anywhere in the SharePoint archive for this tier - the 2027 figures are used as an unconfirmed 2026 stand-in.",
  standInConfirmed: false,
};

function loadSimpleSoroiRack(
  filename: string,
  slug: string,
  displayName: string,
  region: string,
  feeShape: string,
  feeBuilder: (mf: any, sourcePage?: number) => FigureSeed[] | { figures: FigureSeed[] },
): RateCardSeed {
  const data = loadJson(filename);
  const gapLog: string[] = [];
  const sourcePage = data.source.pdfPageIndex ?? data.source.pdfPageIndexes?.[0];
  const figures = emitAccommodation(data.rates, false, sourcePage, gapLog);
  const feeResult = feeBuilder(data.mandatoryFees, sourcePage);
  figures.push(...(Array.isArray(feeResult) ? feeResult : feeResult.figures));
  if (gapLog.length) console.warn(`[${slug}] accommodation gaps (not inserted, no fabricated figures):\n  - ${gapLog.join("\n  - ")}`);

  return {
    propertySlug: slug, displayName, region, propertyCategory: "soroi-lodge",
    tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end,
    ...STAND_IN_2026,
    mandatoryFeeShape: feeShape,
    sourceDocFile: data.source.file, extractedFile: filename,
    figures,
    seasons: seasonsFromBlock(data.seasons, 2027),
  };
}

function loadMultiCategorySoroiRack(
  filename: string,
  slug: string,
  displayName: string,
  region: string,
  feeShape: string,
  feeBuilder: (mf: any, sourcePage?: number) => FigureSeed[] | { figures: FigureSeed[] },
): RateCardSeed {
  const data = loadJson(filename);
  const gapLog: string[] = [];
  const sourcePage = data.source.pdfPageIndex ?? data.source.pdfPageIndexes?.[0];
  const figures = emitAccommodation(data.accommodation, true, sourcePage, gapLog);
  const feeResult = feeBuilder(data.mandatoryFees, sourcePage);
  figures.push(...(Array.isArray(feeResult) ? feeResult : feeResult.figures));
  if (gapLog.length) console.warn(`[${slug}] accommodation gaps (not inserted, no fabricated figures):\n  - ${gapLog.join("\n  - ")}`);

  return {
    propertySlug: slug, displayName, region, propertyCategory: "soroi-lodge",
    tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end,
    ...STAND_IN_2026,
    mandatoryFeeShape: feeShape,
    sourceDocFile: data.source.file, extractedFile: filename,
    figures,
    seasons: seasonsFromBlock(data.seasons, 2027),
  };
}

function loadCheetah(): RateCardSeed {
  return loadSimpleSoroiRack(
    "cheetah-tented-camp-rack-2027.json", "soroi-cheetah-tented-camp", "Soroi Cheetah Tented Camp", "Lumo/Tsavo",
    "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee), no season/date dependency",
    feesLumo3Part,
  );
}
function loadLionsBluff(): RateCardSeed {
  return loadSimpleSoroiRack(
    "lions-bluff-lodge-rack-2027.json", "soroi-lions-bluff-lodge", "Soroi Lions Bluff Lodge", "Lumo/Tsavo",
    "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee), no season/date dependency",
    feesLumo3Part,
  );
}
function loadLeopardsLair(): RateCardSeed {
  return loadSimpleSoroiRack(
    "leopards-lair-cottages-rack-2027.json", "soroi-leopards-lair", "Soroi Leopard's Lair (Leopards Lair Cottages)", "Lumo/Tsavo",
    "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee), no season/date dependency",
    feesLumo3Part,
  );
}
function loadMaraBushCampRack(): RateCardSeed {
  return loadSimpleSoroiRack(
    "mara-bush-camp-rack-2027.json", "soroi-mara-bush-camp", "Soroi Mara Bush Camp", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadPrivateWing(): RateCardSeed {
  return loadSimpleSoroiRack(
    "private-wing-rack-2027.json", "soroi-private-wing", "Soroi Private Wing", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadLuxuryMigrationCamp(): RateCardSeed {
  return loadSimpleSoroiRack(
    "luxury-migration-camp-rack-2027.json", "soroi-luxury-migration-camp", "Soroi Luxury Migration Camp", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadMaraBushCampSto30(): RateCardSeed {
  return loadSimpleSoroiRack(
    "mara-bush-camp-sto30-2027.json", "soroi-mara-bush-camp", "Soroi Mara Bush Camp", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadLarsensRack(): RateCardSeed {
  return loadMultiCategorySoroiRack(
    "larsens-camp-rack-2027.json", "soroi-larsens-camp", "Soroi Larsens Camp", "Samburu",
    "1-part flat Samburu Reserve fee", feesSamburu1Part,
  );
}
function loadLarsensSto30(): RateCardSeed {
  return loadMultiCategorySoroiRack(
    "larsens-camp-sto30-2027.json", "soroi-larsens-camp", "Soroi Larsens Camp", "Samburu",
    "1-part flat Samburu Reserve fee", feesSamburu1Part,
  );
}
function loadSamburuLodgeRack(): RateCardSeed {
  return loadMultiCategorySoroiRack(
    "samburu-lodge-rack-2027.json", "soroi-samburu-lodge", "Soroi Samburu Lodge", "Samburu",
    "1-part flat Samburu Reserve fee", feesSamburu1Part,
  );
}
function loadSamburuLodgeSto30(): RateCardSeed {
  const data = loadJson("samburu-lodge-sto30-2027.json");
  const gapLog: string[] = [];
  const sourcePage = data.source.pdfPageIndices?.[0];
  const figures = emitAccommodation(data.rates, true, sourcePage, gapLog);
  figures.push(...feesSamburu1Part(data.mandatoryFees, sourcePage));
  if (gapLog.length) console.warn(`[soroi-samburu-lodge STO30] gaps:\n  - ${gapLog.join("\n  - ")}`);
  return {
    propertySlug: "soroi-samburu-lodge", displayName: "Soroi Samburu Lodge", region: "Samburu",
    propertyCategory: "soroi-lodge", tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end, ...STAND_IN_2026,
    mandatoryFeeShape: "1-part flat Samburu Reserve fee",
    sourceDocFile: data.source.file, extractedFile: "samburu-lodge-sto30-2027.json",
    figures, seasons: seasonsFromBlock(data.seasons, 2027),
  };
}
function loadAmboseli(): RateCardSeed {
  const data = loadJson("amboseli-rack-2027.json");
  const gapLog: string[] = [];
  const sourcePage = data.source.pdfPageIndexes?.[0];
  const figures = emitAccommodation(data.accommodation, true, sourcePage, gapLog);
  const mf = data.mandatoryFees.amboseliNationalParkFee;
  figures.push(
    { category: "mandatory_fee", path: "amboseliNationalParkFee.nonResident", occupancy: "adult", amount: mf.nonResident.adult, unit: mf.nonResident.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalParkFee.nonResident", occupancy: "child", amount: mf.nonResident.child, unit: mf.nonResident.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalParkFee.surchargePct", amount: 8.5, unit: "%", verified: true, sourcePage, confidenceNote: "KWS surcharge applied on top of the base adult/child fee above." },
  );
  if (gapLog.length) console.warn(`[soroi-amboseli] gaps:\n  - ${gapLog.join("\n  - ")}`);
  return {
    propertySlug: "soroi-amboseli", displayName: "Soroi Amboseli", region: "Amboseli",
    propertyCategory: "soroi-lodge", tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end, ...STAND_IN_2026,
    mandatoryFeeShape: "% KWS surcharge (+8.5%) on top of a base per-adult/child Non-Resident park fee",
    sourceDocFile: data.source.file, extractedFile: "amboseli-rack-2027.json",
    figures, seasons: seasonsFromBlock(data.seasons, 2027),
  };
}

function loadBlueDiani(): RateCardSeed {
  const data = loadJson("blue-diani-rack-2027.json");
  const sourcePage = data.source.pdfPageIndex;
  const figures: FigureSeed[] = [];
  const inferenceNote = data.rates.columnOrderInference as string;
  for (const roomCat of ["gardenView", "oceanView", "juniorSuite", "executiveSuite"]) {
    const block = data.rates[roomCat];
    for (const occupancy of ["perPerson", "single"]) {
      const seasonMap = block[occupancy];
      for (const [season, amount] of Object.entries(seasonMap) as [string, number][]) {
        figures.push({
          category: "accommodation", path: `${roomCat}.halfBoard.${occupancy}`, season, occupancy, amount,
          unit: data.rates.unit, verified: false, sourcePage,
          confidenceNote: `Season column order (Peak/Shoulder/Green) is inferred, not visually confirmed. ${inferenceNote}`,
        });
      }
    }
  }
  // meal supplements (Full Board / All-Inclusive upgrades, not seasonal)
  const fb = data.mealSupplements.fullBoard;
  const ai = data.mealSupplements.allInclusive;
  figures.push(
    { category: "meal_supplement", path: "fullBoard", occupancy: "adult", amount: fb.amount, unit: fb.unit, verified: true, sourcePage },
    { category: "meal_supplement", path: "fullBoard", occupancy: "child", amount: fb.childAmount, unit: fb.unit, verified: true, sourcePage },
    { category: "meal_supplement", path: "allInclusive", occupancy: "adult", amount: ai.amount, unit: ai.unit, verified: true, sourcePage },
    { category: "meal_supplement", path: "allInclusive", occupancy: "child", amount: ai.childAmount, unit: ai.unit, verified: true, sourcePage },
  );
  console.warn("[soroi-blue-diani] No mandatory conservancy/park fee at this property (confirmed structural difference, not a gap).");
  return {
    propertySlug: "soroi-blue-diani", displayName: "Soroi Blue (Diani Beach)", region: "Diani Beach",
    propertyCategory: "soroi-lodge", tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end, ...STAND_IN_2026,
    mandatoryFeeShape: "none - no mandatory conservancy/park fee at this property",
    sourceDocFile: data.source.file, extractedFile: "blue-diani-rack-2027.json",
    figures, seasons: seasonsFromBlock(data.seasons, 2027),
  };
}

function loadTortilis(): RateCardSeed {
  const data = loadJson("tortilis-camp-amboseli-elewana-2026.json");
  const sourcePage = data.source.pdfPageIndex;
  const figures: FigureSeed[] = [];
  for (const mealPlanName of ["fullBoard", "gamePackage"]) {
    const block = data.rates[mealPlanName];
    for (const occupancy of Object.keys(block)) {
      for (const [season, cell] of Object.entries(block[occupancy]) as [string, { rack: number; nett: number }][]) {
        figures.push({ category: "accommodation", path: `${mealPlanName}.${occupancy}.rack`, season, occupancy, amount: cell.rack, unit: data.rates.unit, verified: true, sourcePage });
        figures.push({ category: "accommodation", path: `${mealPlanName}.${occupancy}.net`, season, occupancy, amount: cell.nett, unit: data.rates.unit, verified: true, sourcePage });
      }
    }
  }
  const mf = data.mandatoryFees;
  figures.push(
    { category: "mandatory_fee", path: "kitiruaConservancy", occupancy: "adult", amount: mf.kitiruaConservancy.adult, unit: mf.kitiruaConservancy.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "kitiruaConservancy", occupancy: "child_3to17", amount: mf.kitiruaConservancy.child3to17, unit: mf.kitiruaConservancy.unit, verified: true, sourcePage, confidenceNote: "Elewana's child bracket is 3-17, not Soroi's 5-11 - do not conflate when quoting alongside Soroi properties." },
    { category: "mandatory_fee", path: "amboseliNationalPark", occupancy: "adult", amount: mf.amboseliNationalPark.adult, unit: mf.amboseliNationalPark.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalPark", occupancy: "child_3to17", amount: mf.amboseliNationalPark.child3to17, unit: mf.amboseliNationalPark.unit, verified: true, sourcePage },
  );
  return {
    propertySlug: "tortilis-camp-amboseli", displayName: "Tortilis Camp Amboseli", region: "Amboseli",
    propertyCategory: "non-soroi-lodge", tier: data.tier, residency: "Not tier-split by residency",
    validityStart: new Date(data.source.validity.start), validityEnd: new Date(data.source.validity.end),
    mandatoryFeeShape: "2-part flat (Kitirua Conservancy + Amboseli National Park), child bracket 3-17 not 5-11",
    sourceDocFile: data.source.file, extractedFile: "tortilis-camp-amboseli-elewana-2026.json",
    figures, seasons: seasonsFromBlock(data.seasons, 2026),
  };
}

function loadSolio(): RateCardSeed {
  const data = loadJson("solio-lodge-safari-collection-2026.json");
  const sourcePage = data.source.pdfPageIndices?.[0];
  const figures: FigureSeed[] = [];

  for (const season of ["theSeason", "savingsSeason"]) {
    const fc = data.rates.familyCottage[season];
    figures.push(
      { category: "accommodation", path: "familyCottage.rack", season, amount: fc.rack, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.net", season, amount: fc.nett, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.thirdChild3to15.rack", season, occupancy: "child_3to15", amount: fc.thirdChild3to15.rack, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.thirdChild3to15.net", season, occupancy: "child_3to15", amount: fc.thirdChild3to15.nett, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.fourAdultsSharing.rack", season, amount: fc.fourAdultsSharing.rack, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.fourAdultsSharing.net", season, amount: fc.fourAdultsSharing.nett, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.adultExtraBed.rack", season, amount: fc.adultExtraBed.rack, unit: data.rates.unit, verified: true, sourcePage },
      { category: "accommodation", path: "familyCottage.adultExtraBed.net", season, amount: fc.adultExtraBed.nett, unit: data.rates.unit, verified: true, sourcePage },
    );
    const aor = data.rates.allOtherRooms[season];
    figures.push(
      { category: "accommodation", path: "allOtherRooms.perAdultSharing.rack", season, occupancy: "adult", amount: aor.perAdultSharing.rack, unit: "per person", verified: true, sourcePage },
      { category: "accommodation", path: "allOtherRooms.perAdultSharing.net", season, occupancy: "adult", amount: aor.perAdultSharing.nett, unit: "per person", verified: true, sourcePage },
      { category: "accommodation", path: "allOtherRooms.perChildRate.rack", season, occupancy: "child", amount: aor.perChildRate_sharingWith1Adult.rack, unit: "per person", verified: true, sourcePage, confidenceNote: "Applies when 2 children share a room, or a child shares with exactly 1 adult." },
      { category: "accommodation", path: "allOtherRooms.perChildRate.net", season, occupancy: "child", amount: aor.perChildRate_sharingWith1Adult.nett, unit: "per person", verified: true, sourcePage },
      { category: "accommodation", path: "allOtherRooms.perChildSharingExtraBed.rack", season, occupancy: "child_3to11_extrabed", amount: aor.perChildSharing_extraBed_age3to11.rack, unit: "per person", verified: true, sourcePage, confidenceNote: "Applies when a child aged 3-11 is the 3rd person in a room on an extra bed - this is the rate for a standard 2-adults-plus-1-child itinerary." },
      { category: "accommodation", path: "allOtherRooms.perChildSharingExtraBed.net", season, occupancy: "child_3to11_extrabed", amount: aor.perChildSharing_extraBed_age3to11.nett, unit: "per person", verified: true, sourcePage },
      { category: "accommodation", path: "allOtherRooms.singleRoom.rack", season, amount: aor.singleRoom.rack, unit: "per person", verified: true, sourcePage },
      { category: "accommodation", path: "allOtherRooms.singleRoom.net", season, amount: aor.singleRoom.nett, unit: "per person", verified: true, sourcePage },
    );
  }
  const mf = data.mandatoryFees;
  figures.push(
    { category: "mandatory_fee", path: "conservationFees", occupancy: "adult", amount: mf.conservationFees.adult, unit: mf.conservationFees.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "conservationFees", occupancy: "child_3to10", amount: mf.conservationFees.child3to10, unit: mf.conservationFees.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "professionalGuideRoom", amount: mf.professionalGuideRoom.amount, unit: mf.professionalGuideRoom.unit, verified: true, sourcePage },
  );
  return {
    propertySlug: "solio-lodge", displayName: "Solio Lodge", region: "Solio Ranch, Laikipia",
    propertyCategory: "non-soroi-lodge", tier: data.tier, residency: "Not tier-split by residency",
    validityStart: new Date(data.source.validity.start), validityEnd: new Date(data.source.validity.end),
    mandatoryFeeShape: "2-part flat (Conservation Fee + Professional Guide Room fee), fully inclusive rate basis",
    sourceDocFile: data.source.file, extractedFile: "solio-lodge-safari-collection-2026.json",
    figures, seasons: [],
  };
}

function loadNairobiHotels(): RateCardSeed[] {
  const data = loadJson("nairobi-hotels-2026.json");
  return data.priced.map((h: any): RateCardSeed => ({
    propertySlug: `nairobi-hotel-${h.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`,
    displayName: h.name, region: "Nairobi",
    propertyCategory: "nairobi-hotel", tier: "Standard", residency: "N/A",
    validityStart: new Date(`${data.year}-01-01`), validityEnd: new Date(`${data.year}-12-31`),
    mandatoryFeeShape: "none",
    sourceDocFile: "manual-downloads (Nairobi hotel rate sheets)", extractedFile: "nairobi-hotels-2026.json",
    figures: [{
      category: "hotel_rate", path: "totalPerNight", amount: h.totalPerNight,
      unit: `per night, ${data.occupancy}, ${data.boardBasis}`, verified: !h.flagged,
      confidenceNote: h.notes,
    }],
    seasons: [],
  }));
}

function loadSunworldTransport(): RateCardSeed {
  const data = loadJson("sunworld-transport-2026-2027.json");
  const figures: FigureSeed[] = [
    { category: "vehicle_rate", path: "dailyRate", season: "peak", amount: data.dailyRates.peak.amount, unit: data.pricingModel, verified: true, confidenceNote: data.pricingModelNote },
    { category: "vehicle_rate", path: "dailyRate", season: "restOfYear", amount: data.dailyRates.restOfYear.amount, unit: data.pricingModel, verified: true },
    { category: "supplement", path: "photographicOpenSided", amount: data.conversionSupplements.photographicOpenSided.amount, unit: data.conversionSupplements.photographicOpenSided.unit, verified: true },
    { category: "supplement", path: "wheelchairAccessible", amount: data.conversionSupplements.wheelchairAccessible.amount, unit: data.conversionSupplements.wheelchairAccessible.unit, verified: true },
  ];
  for (const [route, amount] of Object.entries(data.fixedNairobiLocalTransfers.routes) as [string, number][]) {
    figures.push({ category: "fixed_transfer", path: route, amount, unit: data.fixedNairobiLocalTransfers.unit, verified: true, confidenceNote: "Nairobi-local only - do not apply to camp-to-camp routing." });
  }
  figures.push({ category: "note", path: "excessKmGap", amount: 0, unit: "flag", verified: true, confidenceNote: data.openFlags[0] });
  return {
    propertySlug: "sunworld-transport", displayName: "Sunworld Safaris Transport", region: "Kenya-wide",
    propertyCategory: "transport", tier: "Contract", residency: "N/A",
    validityStart: new Date("2026-01-01"), validityEnd: new Date("2027-12-31"),
    mandatoryFeeShape: "none",
    sourceDocFile: data.sources.join(" ; "), extractedFile: "sunworld-transport-2026-2027.json",
    figures, seasons: [],
  };
}

function loadFlights(): RateCardSeed[] {
  const data = loadJson("flights-amboseli-mara-nanyuki-2026.json");
  const seeds: RateCardSeed[] = [];

  const airvanFigures: FigureSeed[] = [];
  for (const [route, fare] of Object.entries(data.airvan.routes) as [string, any][]) {
    airvanFigures.push(
      { category: "flight_route", path: route, occupancy: "adult", amount: fare.adult, unit: fare.unit, verified: true, confidenceNote: fare.note },
      { category: "flight_route", path: route, occupancy: "child", amount: fare.child, unit: fare.unit, verified: true },
    );
  }
  seeds.push({
    propertySlug: "flights-airvan", displayName: "Airvan (via Sunworld contract)", region: "Amboseli/Mara/Wilson",
    propertyCategory: "flight", tier: "Contract", residency: "N/A",
    validityStart: new Date("2026-01-01"), validityEnd: new Date("2027-12-31"),
    sourceDocFile: data.airvan.source.file, extractedFile: "flights-amboseli-mara-nanyuki-2026.json",
    figures: airvanFigures, seasons: [],
  });

  const slFigures: FigureSeed[] = [];
  const nn = data.safarilink.routes.nanyukiToMasaiMara;
  slFigures.push(
    { category: "flight_route", path: "nanyukiToMasaiMara", occupancy: "adult", amount: nn.nett + nn.tax, unit: `${nn.unit} (nett+tax)`, verified: true },
    { category: "flight_route", path: "nanyukiToMasaiMara", occupancy: "child", amount: Math.round((nn.nett * 0.75 + nn.tax) * 100) / 100, unit: `${nn.unit} (nett+tax)`, verified: false, confidenceNote: nn.note },
  );
  seeds.push({
    propertySlug: "flights-safarilink", displayName: "Safarilink (via Sunworld contract)", region: "Nanyuki/Mara",
    propertyCategory: "flight", tier: "Contract", residency: "N/A",
    validityStart: new Date(data.safarilink.source.validity.start), validityEnd: new Date(data.safarilink.source.validity.end),
    sourceDocFile: data.safarilink.source.file, extractedFile: "flights-amboseli-mara-nanyuki-2026.json",
    figures: slFigures, seasons: [],
  });

  return seeds;
}

// ---------------------------------------------------------------------------
// STO 40% loaders - added 6 Aug 2026, one file per Soroi property. Net=Rack*0.60
// confirmed on every cell checked except Leopard's Lair's Self Catering rate
// (handled above in handleKnownStraySiblingKey). Reuses the same shared helpers
// as the Rack loaders since every file's rates/accommodation/mandatoryFees shape
// was independently confirmed to match its Rack-tier counterpart.
// ---------------------------------------------------------------------------

function loadCheetahSto40(): RateCardSeed {
  return loadSimpleSoroiRack(
    "cheetah-tented-camp-sto40-2027.json", "soroi-cheetah-tented-camp", "Soroi Cheetah Tented Camp", "Lumo/Tsavo",
    "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee), no season/date dependency",
    feesLumo3Part,
  );
}
function loadLionsBluffSto40(): RateCardSeed {
  return loadSimpleSoroiRack(
    "lions-bluff-lodge-sto40-2027.json", "soroi-lions-bluff-lodge", "Soroi Lions Bluff Lodge", "Lumo/Tsavo",
    "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee), no season/date dependency",
    feesLumo3Part,
  );
}
function loadLeopardsLairSto40(): RateCardSeed {
  return loadSimpleSoroiRack(
    "leopards-lair-cottages-sto40-2027.json", "soroi-leopards-lair", "Soroi Leopard's Lair (Leopards Lair Cottages)", "Lumo/Tsavo",
    "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee), no season/date dependency",
    feesLumo3Part,
  );
}
function loadMaraBushCampSto40(): RateCardSeed {
  return loadSimpleSoroiRack(
    "mara-bush-camp-sto40-2027.json", "soroi-mara-bush-camp", "Soroi Mara Bush Camp", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadPrivateWingSto40(): RateCardSeed {
  return loadSimpleSoroiRack(
    "private-wing-sto40-2027.json", "soroi-private-wing", "Soroi Private Wing", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadLuxuryMigrationCampSto40(): RateCardSeed {
  return loadSimpleSoroiRack(
    "luxury-migration-camp-sto40-2027.json", "soroi-luxury-migration-camp", "Soroi Luxury Migration Camp", "Maasai Mara",
    "2-part: season-dependent Community Levy + date-window-dependent Park Fee (Jan-Jun vs Jul-Dec split)",
    (mf, p) => feesMaraStyle(mf, 2027, p),
  );
}
function loadLarsensSto40(): RateCardSeed {
  return loadMultiCategorySoroiRack(
    "larsens-camp-sto40-2027.json", "soroi-larsens-camp", "Soroi Larsens Camp", "Samburu",
    "1-part flat Samburu Reserve fee", feesSamburu1Part,
  );
}
function loadSamburuLodgeSto40(): RateCardSeed {
  return loadMultiCategorySoroiRack(
    "samburu-lodge-sto40-2027.json", "soroi-samburu-lodge", "Soroi Samburu Lodge", "Samburu",
    "1-part flat Samburu Reserve fee", feesSamburu1Part,
  );
}

function loadAmboseliSto40(): RateCardSeed {
  const data = loadJson("amboseli-sto40-2027.json");
  const gapLog: string[] = [];
  const sourcePage = data.source.pdfPageIndexes?.[0];
  const figures = emitAccommodation(data.accommodation, true, sourcePage, gapLog);
  // Star-Bed Suite has its own shorter validity window on this document, not yet
  // cross-checked against the Rack-tier source - preserve the flag on its own figures
  // rather than silently applying the property-wide window. See CLAUDE.md Known Issues.
  const validityFlag = data.accommodation.starBedSuite?.validityNote;
  if (validityFlag?.flag) {
    for (const f of figures) {
      if (f.path.startsWith("starBedSuite.")) f.confidenceNote = validityFlag.note;
    }
  }
  const mf = data.mandatoryFees.amboseliNationalParkFee;
  figures.push(
    { category: "mandatory_fee", path: "amboseliNationalParkFee.nonResident", occupancy: "adult", amount: mf.nonResident.adult, unit: mf.nonResident.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalParkFee.nonResident", occupancy: "child", amount: mf.nonResident.child, unit: mf.nonResident.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalParkFee.surchargePct", amount: 8.5, unit: "%", verified: true, sourcePage, confidenceNote: "KWS surcharge applied on top of the base adult/child fee above." },
  );
  if (gapLog.length) console.warn(`[soroi-amboseli STO40] gaps:\n  - ${gapLog.join("\n  - ")}`);
  return {
    propertySlug: "soroi-amboseli", displayName: "Soroi Amboseli", region: "Amboseli",
    propertyCategory: "soroi-lodge", tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end, ...STAND_IN_2026,
    mandatoryFeeShape: "% KWS surcharge (+8.5%) on top of a base per-adult/child Non-Resident park fee",
    sourceDocFile: data.source.file, extractedFile: "amboseli-sto40-2027.json",
    figures, seasons: seasonsFromBlock(data.seasons, 2027),
  };
}

function loadBlueDianiSto40(): RateCardSeed {
  const data = loadJson("blue-diani-sto40-2027.json");
  const sourcePage = data.source.pdfPageIndex;
  const figures: FigureSeed[] = [];
  // Unlike the Rack file (flat amount per season - it IS the rack figure), the STO 40%
  // file carries rack/net cells per season, matching the STO-tier pattern used elsewhere.
  for (const roomCat of ["gardenView", "oceanView", "juniorSuite", "executiveSuite"]) {
    const block = data.rates[roomCat];
    if (!block) continue;
    for (const occupancy of ["perPerson", "single"]) {
      const seasonMap = block[occupancy];
      for (const [season, cell] of Object.entries(seasonMap) as [string, { rack: number; net: number }][]) {
        figures.push({ category: "accommodation", path: `${roomCat}.halfBoard.${occupancy}.rack`, season, occupancy, amount: cell.rack, unit: data.rates.unit, verified: true, sourcePage });
        figures.push({ category: "accommodation", path: `${roomCat}.halfBoard.${occupancy}.net`, season, occupancy, amount: cell.net, unit: data.rates.unit, verified: true, sourcePage });
      }
    }
  }
  const fb = data.mealSupplements.fullBoard;
  const ai = data.mealSupplements.allInclusive;
  figures.push(
    { category: "meal_supplement", path: "fullBoard", occupancy: "adult", amount: fb.amount, unit: fb.unit, verified: true, sourcePage },
    { category: "meal_supplement", path: "fullBoard", occupancy: "child", amount: fb.childAmount, unit: fb.unit, verified: true, sourcePage },
    { category: "meal_supplement", path: "allInclusive", occupancy: "adult", amount: ai.amount, unit: ai.unit, verified: true, sourcePage },
    { category: "meal_supplement", path: "allInclusive", occupancy: "child", amount: ai.childAmount, unit: ai.unit, verified: true, sourcePage },
  );
  return {
    propertySlug: "soroi-blue-diani", displayName: "Soroi Blue (Diani Beach)", region: "Diani Beach",
    propertyCategory: "soroi-lodge", tier: data.tier, residency: data.residency,
    validityStart: SOROI_2027_VALIDITY.start, validityEnd: SOROI_2027_VALIDITY.end, ...STAND_IN_2026,
    mandatoryFeeShape: "none - no mandatory conservancy/park fee at this property",
    sourceDocFile: data.source.file, extractedFile: "blue-diani-sto40-2027.json",
    figures, seasons: seasonsFromBlock(data.seasons, 2027),
  };
}

// ---------------------------------------------------------------------------
// 13 Aug 2026 batch: full 2026 Rack+STO ladder (10/15/20/25/30/35/40) and a
// refreshed 2027 Rack+STO ladder (15/20/25/30/35/40), extracted from a fresh
// portal download confirmed by Yasin as source of truth. Every file in this
// batch uses ONE consistent top-level key ("rates"), unlike the older ad-hoc
// files above (some multi-category properties used "accommodation" instead) -
// so this batch gets its own clean generic loader rather than patching the
// bespoke functions above, which have several now-incompatible assumptions
// baked in (different key names, fields this batch's files don't carry).
// Mandatory fees don't vary by discount tier (confirmed identical across every
// tier checked during extraction) so each property's fee data is loaded once
// from its own Rack-tier file and reused for every STO tier of that property.
// ---------------------------------------------------------------------------

const SOROI_2026_VALIDITY = { start: new Date("2026-01-04"), end: new Date("2027-01-03") };

function feesAmboseliBatch(mf: any, sourcePage?: number): FigureSeed[] {
  const pf = mf.amboseliNationalParkFee;
  if (typeof pf === "string") {
    // 2026: "to be confirmed" - no real figure exists yet, don't fabricate one.
    return [];
  }
  return [
    { category: "mandatory_fee", path: "amboseliNationalParkFee.nonResident", occupancy: "adult", amount: pf.nonResident.adult, unit: pf.nonResident.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalParkFee.nonResident", occupancy: "child", amount: pf.nonResident.child, unit: pf.nonResident.unit, verified: true, sourcePage },
    { category: "mandatory_fee", path: "amboseliNationalParkFee.surchargePct", amount: pf.kwsSurchargePct, unit: "%", verified: true, sourcePage, confidenceNote: "KWS surcharge applied on top of the base adult/child fee above." },
  ];
}

function feesDianiBatch(): FigureSeed[] {
  return []; // No mandatory conservancy/park fee at this property - confirmed structurally different.
}

type BatchPropertyConfig = {
  slug: string;
  displayName: string;
  region: string;
  isMultiCategory: boolean;
  feeShape: string;
  feeBuilder: (mf: any, contextYear: number, sourcePage?: number) => FigureSeed[];
};

const BATCH_PROPERTIES: BatchPropertyConfig[] = [
  { slug: "soroi-mara-bush-camp", displayName: "Soroi Mara Bush Camp", region: "Maasai Mara", isMultiCategory: false, feeShape: "2-part: season-dependent Community Levy + date-window Park Fee", feeBuilder: (mf, y, p) => feesMaraStyle(mf, y, p).figures },
  { slug: "soroi-private-wing", displayName: "Soroi Private Wing", region: "Maasai Mara", isMultiCategory: false, feeShape: "2-part: season-dependent Community Levy + date-window Park Fee", feeBuilder: (mf, y, p) => feesMaraStyle(mf, y, p).figures },
  { slug: "soroi-luxury-migration-camp", displayName: "Soroi Luxury Migration Camp", region: "Maasai Mara", isMultiCategory: false, feeShape: "2-part: season-dependent Community Levy + date-window Park Fee", feeBuilder: (mf, y, p) => feesMaraStyle(mf, y, p).figures },
  { slug: "soroi-larsens-camp", displayName: "Soroi Larsens Camp", region: "Samburu", isMultiCategory: true, feeShape: "1-part flat Samburu Reserve fee", feeBuilder: (mf, _y, p) => feesSamburu1Part(mf, p) },
  { slug: "soroi-samburu-lodge", displayName: "Soroi Samburu Lodge", region: "Samburu", isMultiCategory: true, feeShape: "1-part flat Samburu Reserve fee", feeBuilder: (mf, _y, p) => feesSamburu1Part(mf, p) },
  { slug: "soroi-amboseli", displayName: "Soroi Amboseli", region: "Amboseli", isMultiCategory: true, feeShape: "% KWS surcharge (+8.5%) on top of a base per-adult/child Non-Resident park fee", feeBuilder: (mf, _y, p) => feesAmboseliBatch(mf, p) },
  { slug: "soroi-lions-bluff-lodge", displayName: "Soroi Lions Bluff Lodge", region: "Lumo/Tsavo", isMultiCategory: false, feeShape: "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee)", feeBuilder: (mf, _y, p) => feesLumo3Part(mf, p) },
  { slug: "soroi-leopards-lair", displayName: "Soroi Leopard's Lair (Leopards Lair Cottages)", region: "Lumo/Tsavo", isMultiCategory: false, feeShape: "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee)", feeBuilder: (mf, _y, p) => feesLumo3Part(mf, p) },
  { slug: "soroi-cheetah-tented-camp", displayName: "Soroi Cheetah Tented Camp", region: "Lumo/Tsavo", isMultiCategory: false, feeShape: "3-part flat (Community Bed Levy + Conservation Levy + LUMO Conservation Fee)", feeBuilder: (mf, _y, p) => feesLumo3Part(mf, p) },
  { slug: "soroi-blue-diani", displayName: "Soroi Blue (Diani Beach)", region: "Diani Beach", isMultiCategory: false, feeShape: "none - no mandatory conservancy/park fee at this property", feeBuilder: () => feesDianiBatch() },
];

const RATES_EXTRACTED_SLUG: Record<string, string> = {
  "soroi-mara-bush-camp": "mara-bush-camp", "soroi-private-wing": "private-wing",
  "soroi-luxury-migration-camp": "luxury-migration-camp", "soroi-larsens-camp": "larsens-camp",
  "soroi-samburu-lodge": "samburu-lodge", "soroi-amboseli": "amboseli",
  "soroi-lions-bluff-lodge": "lions-bluff-lodge", "soroi-leopards-lair": "leopards-lair-cottages",
  "soroi-cheetah-tented-camp": "cheetah-tented-camp", "soroi-blue-diani": "blue-diani",
};

function loadBatchTier(
  cfg: BatchPropertyConfig,
  filename: string,
  feeSourceFilename: string,
  validity: { start: Date; end: Date },
  contextYear: number,
): RateCardSeed {
  const data = loadJson(filename);
  const feeData = filename === feeSourceFilename ? data : loadJson(feeSourceFilename);
  const gapLog: string[] = [];
  const figures = emitAccommodation(data.rates, cfg.isMultiCategory, undefined, gapLog);
  figures.push(...cfg.feeBuilder(feeData.mandatoryFees, contextYear, undefined));
  if (gapLog.length) console.warn(`[${cfg.slug} / ${data.tier}] gaps (not inserted, no fabricated figures):\n  - ${gapLog.join("\n  - ")}`);
  return {
    propertySlug: cfg.slug, displayName: cfg.displayName, region: cfg.region, propertyCategory: "soroi-lodge",
    tier: data.tier, residency: data.residency,
    validityStart: validity.start, validityEnd: validity.end,
    mandatoryFeeShape: cfg.feeShape,
    sourceDocFile: data.source.file, extractedFile: filename,
    figures,
    seasons: seasonsFromBlock(data.seasons, contextYear),
  };
}

function loadBatch2026And2027(): RateCardSeed[] {
  const seeds: RateCardSeed[] = [];
  const tiers2026 = ["rack", "sto10", "sto15", "sto20", "sto25", "sto30", "sto35", "sto40"];
  const tiers2027 = ["rack", "sto15", "sto20", "sto25", "sto30", "sto35", "sto40"];
  for (const cfg of BATCH_PROPERTIES) {
    const slug = RATES_EXTRACTED_SLUG[cfg.slug];
    const rackFile2026 = `${slug}-rack-2026.json`;
    const rackFile2027 = `${slug}-rack-2027.json`;
    for (const tier of tiers2026) {
      seeds.push(loadBatchTier(cfg, `${slug}-${tier}-2026.json`, rackFile2026, SOROI_2026_VALIDITY, 2026));
    }
    for (const tier of tiers2027) {
      seeds.push(loadBatchTier(cfg, `${slug}-${tier}-2027.json`, rackFile2027, SOROI_2027_VALIDITY, 2027));
    }
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const yasin = await prisma.user.upsert({
    where: { email: "yasinmanjothi@gmail.com" },
    update: { role: "RATE_MANAGER" },
    create: {
      email: "yasinmanjothi@gmail.com",
      name: "Yasin Manjothi",
      role: "RATE_MANAGER",
      passwordHash: await bcrypt.hash("changeme-dev-only", 10),
    },
  });
  console.log(`Rate Manager user ready: ${yasin.email} (${yasin.id})`);

  // This script is meant to be re-run whenever rates-extracted/ changes - every row it
  // creates is fully reproducible from these source JSON files. IMPORTANT: it must only
  // ever touch the specific properties it manages, listed below - a blanket deleteMany()
  // on RateCard/SourceDocument would also destroy real Rate Manager data published
  // through the actual upload/extract/review/publish UI (Phase 1), which this script
  // knows nothing about and cannot regenerate. (This was previously a blanket delete;
  // fixed after it was caught about to wipe a real published rate card - see git history
  // if this comment predates one.)
  const MANAGED_PROPERTY_SLUGS = [
    "soroi-cheetah-tented-camp", "soroi-lions-bluff-lodge", "soroi-leopards-lair",
    "soroi-mara-bush-camp", "soroi-private-wing", "soroi-luxury-migration-camp",
    "soroi-larsens-camp", "soroi-samburu-lodge", "soroi-amboseli", "soroi-blue-diani",
    "tortilis-camp-amboseli", "solio-lodge",
    "nairobi-hotel-four-points-by-sheraton-nairobi-airport",
    "nairobi-hotel-crowne-plaza-nairobi-airport",
    "nairobi-hotel-fairview-hotel-nairobi-upper-hill",
    "sunworld-transport", "flights-airvan", "flights-safarilink",
  ];
  const managedCards = await prisma.rateCard.findMany({
    where: { property: { slug: { in: MANAGED_PROPERTY_SLUGS } } },
    select: { id: true, sourceDocumentId: true },
  });
  const managedCardIds = managedCards.map((c) => c.id);
  const managedSourceDocIds = [...new Set(managedCards.map((c) => c.sourceDocumentId))];

  // Delete children before parents to satisfy FK constraints (RateFigure/RateCardSeason
  // cascade with their RateCard, but RateCardEvent does not).
  await prisma.rateCardEvent.deleteMany({ where: { rateCardId: { in: managedCardIds } } });
  await prisma.rateCard.deleteMany({ where: { id: { in: managedCardIds } } });
  // Only delete SourceDocuments that have no remaining references at all (an ExtractionRun
  // could still point at one even after its RateCard is gone), never a document tied to a
  // real upload this script doesn't own.
  for (const docId of managedSourceDocIds) {
    const stillReferenced = await prisma.extractionRun.findFirst({ where: { sourceDocumentId: docId } });
    if (!stillReferenced) await prisma.sourceDocument.deleteMany({ where: { id: docId } });
  }
  console.log(`Cleared ${managedCardIds.length} managed RateCard(s) for a fresh reseed (left any other property's data untouched).`);

  const seeds: RateCardSeed[] = [
    // Full 2026 Rack+STO10-40 and refreshed 2027 Rack+STO15-40 for all 10 Soroi
    // properties (13 Aug 2026 portal batch) - supersedes every individual
    // Soroi-lodge loader call that used to be listed here (loadCheetah,
    // loadMaraBushCampRack, loadLarsensSto40, etc.) since this is a full
    // superset covering the same properties/tiers plus everything new.
    ...loadBatch2026And2027(),
    loadTortilis(),
    loadSolio(),
    ...loadNairobiHotels(),
    loadSunworldTransport(),
    ...loadFlights(),
  ];

  let cardCount = 0;
  let figureCount = 0;
  let seasonCount = 0;

  for (const seed of seeds) {
    const property = await prisma.property.upsert({
      where: { slug: seed.propertySlug },
      update: { displayName: seed.displayName, region: seed.region, category: seed.propertyCategory },
      create: { slug: seed.propertySlug, displayName: seed.displayName, region: seed.region, category: seed.propertyCategory },
    });

    const sourceDocument = await prisma.sourceDocument.create({
      data: {
        filename: seed.extractedFile,
        storageKey: `migration/${seed.extractedFile}`,
        uploadedById: yasin.id,
      },
    });

    const rateCard = await prisma.rateCard.create({
      data: {
        propertyId: property.id,
        tier: seed.tier,
        residency: seed.residency,
        validityStart: seed.validityStart,
        validityEnd: seed.validityEnd,
        standInForYear: seed.standInForYear,
        standInReason: seed.standInReason,
        standInConfirmed: seed.standInConfirmed ?? false,
        mandatoryFeeShape: seed.mandatoryFeeShape,
        sourceDocumentId: sourceDocument.id,
        status: "published",
        publishedById: yasin.id,
        publishedAt: new Date(),
        figures: { create: seed.figures },
        seasons: {
          create: seed.seasons.map((s) => ({
            seasonName: s.seasonName,
            dateRangeStart: s.start,
            dateRangeEnd: s.end,
            rawLabel: s.rawLabel,
          })),
        },
        events: {
          create: [
            { eventType: "created", note: `Migrated from ${seed.extractedFile}` },
            { eventType: "published", note: "Auto-published during Phase 0 migration - this data already went through manual review in Claude Code sessions." },
          ],
        },
      },
    });

    cardCount++;
    figureCount += seed.figures.length;
    seasonCount += seed.seasons.length;
    console.log(`Migrated ${seed.propertySlug} / ${seed.tier}: ${seed.figures.length} figures, ${seed.seasons.length} season ranges (card ${rateCard.id})`);
  }

  console.log(`\nDone. ${cardCount} rate cards, ${figureCount} figures, ${seasonCount} season ranges.`);
  if (skippedRanges.length) {
    console.warn(`\n${skippedRanges.length} date range strings failed to parse and were skipped (no season row created):`);
    for (const r of skippedRanges) console.warn(`  - "${r}"`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
