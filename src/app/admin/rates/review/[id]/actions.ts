"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { ProposedFigure, ProposedSeason } from "@/lib/rates/extraction";

async function requireRateManager() {
  const session = await auth();
  if (session?.user?.role !== "RATE_MANAGER") {
    throw new Error("Not authorized.");
  }
  return session.user;
}

function str(formData: FormData, key: string): string {
  return (formData.get(key) as string | null)?.trim() ?? "";
}

export async function publishRateCard(formData: FormData) {
  const user = await requireRateManager();

  const extractionRunId = str(formData, "extractionRunId");
  const tier = str(formData, "tier");
  const residency = str(formData, "residency");
  const validityStartStr = str(formData, "validityStart");
  const validityEndStr = str(formData, "validityEnd");
  const mandatoryFeeShape = str(formData, "mandatoryFeeShapeDescription");
  const supersedeReason = str(formData, "supersedeReason");
  const figuresJson = str(formData, "figuresJson");
  const seasonsJson = str(formData, "seasonsJson");

  if (!tier || !residency || !validityStartStr || !validityEndStr) {
    throw new Error("Tier, residency, and both validity dates are required before publishing.");
  }

  let figures: ProposedFigure[];
  let seasons: ProposedSeason[];
  try {
    figures = JSON.parse(figuresJson);
    seasons = JSON.parse(seasonsJson);
  } catch {
    throw new Error("Figures or seasons JSON is malformed - fix the syntax and try again. Nothing was published.");
  }
  if (!Array.isArray(figures) || figures.length === 0) {
    throw new Error("At least one figure is required.");
  }
  for (const f of figures) {
    if (typeof f.amount !== "number" || !f.path || !f.unit || typeof f.verified !== "boolean") {
      throw new Error(`Malformed figure: ${JSON.stringify(f)} - each figure needs path, amount (number), unit, and verified (boolean).`);
    }
  }

  const extractionRun = await prisma.extractionRun.findUnique({ where: { id: extractionRunId } });
  if (!extractionRun) throw new Error("Extraction run not found.");

  // Resolve the property - an existing one selected from the dropdown, or a new one
  // created from the fields below it. Never auto-bind to a guessed slug silently.
  const existingPropertyId = str(formData, "propertyId");
  let propertyId: string;
  if (existingPropertyId) {
    const property = await prisma.property.findUnique({ where: { id: existingPropertyId } });
    if (!property) throw new Error("Selected property not found.");
    propertyId = property.id;
  } else {
    const newSlug = str(formData, "newPropertySlug");
    const newDisplayName = str(formData, "newPropertyDisplayName");
    const newRegion = str(formData, "newPropertyRegion");
    const newCategory = str(formData, "newPropertyCategory");
    if (!newSlug || !newDisplayName || !newRegion || !newCategory) {
      throw new Error("Select an existing property, or fill in all four new-property fields (slug, display name, region, category).");
    }
    const clash = await prisma.property.findUnique({ where: { slug: newSlug } });
    if (clash) {
      throw new Error(`Slug "${newSlug}" already exists (${clash.displayName}) - select it from the dropdown instead of creating a duplicate.`);
    }
    const property = await prisma.property.create({
      data: { slug: newSlug, displayName: newDisplayName, region: newRegion, category: newCategory },
    });
    propertyId = property.id;
  }

  const validityStart = new Date(validityStartStr);
  const validityEnd = new Date(validityEndStr);

  const overlapping = await prisma.rateCard.findFirst({
    where: {
      propertyId,
      tier,
      residency,
      status: "published",
      validityStart: { lte: validityEnd },
      validityEnd: { gte: validityStart },
    },
  });

  if (overlapping && !supersedeReason) {
    throw new Error(
      `A published rate card already exists for this property/tier/residency covering an overlapping window (card ${overlapping.id}, ` +
      `${overlapping.validityStart.toISOString().slice(0, 10)} to ${overlapping.validityEnd.toISOString().slice(0, 10)}). ` +
      `Enter a supersede reason to confirm you want to replace it - nothing was published.`
    );
  }

  const newCardId = await prisma.$transaction(async (tx) => {
    const newCard = await tx.rateCard.create({
      data: {
        propertyId,
        tier,
        residency,
        validityStart,
        validityEnd,
        mandatoryFeeShape: mandatoryFeeShape || null,
        sourceDocumentId: extractionRun.sourceDocumentId,
        status: "published",
        publishedById: user.id!,
        publishedAt: new Date(),
        supersedesId: overlapping ? overlapping.id : undefined,
        supersedeReason: overlapping ? supersedeReason : undefined,
        figures: {
          create: figures.map((f) => ({
            category: f.category,
            path: f.path,
            season: f.season || null,
            occupancy: f.occupancy || null,
            amount: f.amount,
            unit: f.unit,
            currency: f.currency || "USD",
            verified: f.verified,
            confidenceNote: f.confidenceNote || null,
            sourcePage: f.sourcePage ?? null,
          })),
        },
        seasons: {
          create: (seasons || []).map((s) => ({
            seasonName: s.seasonName,
            dateRangeStart: new Date(s.startDate),
            dateRangeEnd: new Date(s.endDate),
            rawLabel: s.rawLabel,
          })),
        },
        events: {
          create: [
            { eventType: "created", note: `Published from extraction run ${extractionRun.id}` },
            { eventType: "published", note: overlapping ? `Supersedes ${overlapping.id}: ${supersedeReason}` : "First publish for this property/tier/residency window." },
          ],
        },
      },
    });

    if (overlapping) {
      await tx.rateCard.update({
        where: { id: overlapping.id },
        data: { status: "superseded" },
      });
      await tx.rateCardEvent.create({
        data: { rateCardId: overlapping.id, eventType: "superseded", note: `Superseded by ${newCard.id}: ${supersedeReason}` },
      });
    }

    return newCard.id;
  });

  await prisma.extractionRun.update({
    where: { id: extractionRunId },
    data: { status: "approved", reviewedById: user.id!, reviewedAt: new Date() },
  });

  redirect(`/admin/rates?published=${newCardId}`);
}
