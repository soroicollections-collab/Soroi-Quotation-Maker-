import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { renderQuotePdfBuffer, slugify } from "@/lib/render/render-pdf";
import type { QuoteDocumentData } from "@/lib/render/quote-data";

// Chromium launch + a multi-page PDF render can take longer than the platform default -
// this needs the Node.js runtime (not Edge, which has no child-process/fs support that
// Playwright needs) and a longer function duration than Vercel's default.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { quoteId } = await params;
  const type = req.nextUrl.searchParams.get("type") === "client" ? "client" : "agent";

  const quote = await prisma.quote.findUnique({ where: { quoteId } });
  if (!quote) {
    return new Response("Quote not found", { status: 404 });
  }
  if (!quote.documentData) {
    return new Response("This quote has no saved document data to render from yet.", { status: 404 });
  }

  const documentData = quote.documentData as unknown as QuoteDocumentData;
  const pdfBuffer = await renderQuotePdfBuffer({ format: type, data: documentData });
  const filename = `${quoteId}_${slugify(documentData.routeTitle)}${type === "client" ? "-client" : ""}.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
