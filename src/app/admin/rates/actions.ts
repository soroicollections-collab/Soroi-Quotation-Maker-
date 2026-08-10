"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { extractRatesFromDocument } from "@/lib/rates/extraction";

async function requireRateManager() {
  const session = await auth();
  if (session?.user?.role !== "RATE_MANAGER") {
    throw new Error("Not authorized.");
  }
  return session.user;
}

export async function uploadAndExtract(formData: FormData) {
  const user = await requireRateManager();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    throw new Error("Choose a PDF file to upload.");
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only PDF files are supported right now.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // The raw upload is processed in-memory only and never written to disk - same
  // no-server-storage model as quote PDFs (see render-pdf.ts). The durable record is
  // the ExtractionRun/RateCard/RateFigure rows this produces, not the original file.
  const sourceDocument = await prisma.sourceDocument.create({
    data: {
      filename: file.name,
      storageKey: `not-persisted:${file.name}`,
      uploadedById: user.id!,
    },
  });

  const proposedFigures = await extractRatesFromDocument(bytes);

  const extractionRun = await prisma.extractionRun.create({
    data: {
      sourceDocumentId: sourceDocument.id,
      status: "pending_review",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proposedFigures: proposedFigures as any,
    },
  });

  redirect(`/admin/rates/review/${extractionRun.id}`);
}

export async function rejectExtractionRun(extractionRunId: string) {
  const user = await requireRateManager();
  await prisma.extractionRun.update({
    where: { id: extractionRunId },
    data: { status: "rejected", reviewedById: user.id!, reviewedAt: new Date() },
  });
  redirect("/admin/rates");
}
