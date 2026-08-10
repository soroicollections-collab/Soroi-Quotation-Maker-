import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { ExtractionOutput } from "@/lib/rates/extraction";
import { publishRateCard } from "./actions";
import { rejectExtractionRun } from "../../actions";

export default async function ReviewExtractionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (session?.user?.role !== "RATE_MANAGER") {
    return <main className="p-8">Not authorized.</main>;
  }

  const extractionRun = await prisma.extractionRun.findUnique({
    where: { id },
    include: { sourceDocument: true },
  });
  if (!extractionRun) return <main className="p-8">Extraction run not found.</main>;

  const properties = await prisma.property.findMany({ orderBy: [{ category: "asc" }, { displayName: "asc" }] });
  const output = extractionRun.proposedFigures as unknown as ExtractionOutput;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-gray-500">
          Source: {extractionRun.sourceDocument.filename} · Status: <strong>{extractionRun.status}</strong>
        </p>
        <p className="mt-1 text-xs text-amber-700">
          Nothing here is live yet. Each rate card below publishes independently - review and correct the figures JSON
          before publishing, especially any figure marked <code>verified: false</code>.
        </p>
      </div>

      {extractionRun.status !== "pending_review" && (
        <p className="rounded border border-gray-300 bg-gray-50 p-3 text-sm">
          This extraction run is already <strong>{extractionRun.status}</strong> - shown read-only below.
        </p>
      )}

      {output.rateCards.length === 0 && (
        <p className="text-sm text-red-600">The extraction found no rate cards in this document.</p>
      )}

      {output.rateCards.map((card, i) => (
        <section key={i} className="flex flex-col gap-4 rounded border p-5">
          <div>
            <h2 className="text-lg font-medium">{card.extractedPropertyName || `Rate card ${i + 1}`}</h2>
            {card.extractionNotes.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-700">
                {card.extractionNotes.map((n, ni) => (
                  <li key={ni}>{n}</li>
                ))}
              </ul>
            )}
          </div>

          <form action={publishRateCard} className="flex flex-col gap-4">
            <input type="hidden" name="extractionRunId" value={extractionRun.id} />

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Property</label>
              <select name="propertyId" defaultValue="" className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"}>
                <option value="">— Create new property (fill in fields below) —</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.slug}) — {p.category}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                AI-suggested slug: <code>{card.suggestedPropertySlug}</code> — confirm this matches an existing property above, or use it as a starting point below if this is genuinely new.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 rounded border border-dashed p-3 text-sm">
              <div className="col-span-2 text-xs font-medium uppercase tracking-wide text-gray-500">New property (only used if no property selected above)</div>
              <input name="newPropertySlug" defaultValue={card.suggestedPropertySlug} placeholder="slug" className="rounded border px-2 py-1" disabled={extractionRun.status !== "pending_review"} />
              <input name="newPropertyDisplayName" defaultValue={card.extractedPropertyName} placeholder="Display name" className="rounded border px-2 py-1" disabled={extractionRun.status !== "pending_review"} />
              <input name="newPropertyRegion" defaultValue={card.suggestedRegion} placeholder="Region" className="rounded border px-2 py-1" disabled={extractionRun.status !== "pending_review"} />
              <select name="newPropertyCategory" defaultValue={card.suggestedCategory} className="rounded border px-2 py-1" disabled={extractionRun.status !== "pending_review"}>
                <option value="soroi-lodge">soroi-lodge</option>
                <option value="non-soroi-lodge">non-soroi-lodge</option>
                <option value="nairobi-hotel">nairobi-hotel</option>
                <option value="transport">transport</option>
                <option value="flight">flight</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Tier</label>
                <input name="tier" defaultValue={card.tier} required className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"} />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Residency</label>
                <input name="residency" defaultValue={card.residency} required className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"} />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Validity start</label>
                <input type="date" name="validityStart" defaultValue={card.validityStart} required className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"} />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Validity end</label>
                <input type="date" name="validityEnd" defaultValue={card.validityEnd} required className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"} />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Mandatory fee shape (this property's own, in plain English)</label>
              <textarea name="mandatoryFeeShapeDescription" defaultValue={card.mandatoryFeeShapeDescription} rows={2} className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"} />
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
                Figures ({card.figures.length}) — edit this JSON directly to fix a value, remove a bad row, or add a missing one
              </label>
              <textarea
                name="figuresJson"
                defaultValue={JSON.stringify(card.figures, null, 2)}
                rows={14}
                className="mt-1 w-full rounded border px-3 py-2 font-mono text-xs"
                disabled={extractionRun.status !== "pending_review"}
              />
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Seasons ({card.seasons.length})</label>
              <textarea
                name="seasonsJson"
                defaultValue={JSON.stringify(card.seasons, null, 2)}
                rows={6}
                className="mt-1 w-full rounded border px-3 py-2 font-mono text-xs"
                disabled={extractionRun.status !== "pending_review"}
              />
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
                Supersede reason (only needed if a published card already covers this property/tier/residency/window)
              </label>
              <input name="supersedeReason" placeholder="e.g. Corrected Conservation Levy per 5 Aug 2026 review" className="mt-1 w-full rounded border px-3 py-2 text-sm" disabled={extractionRun.status !== "pending_review"} />
            </div>

            {extractionRun.status === "pending_review" && (
              <button type="submit" className="self-start rounded bg-black px-4 py-2 text-sm text-white">
                Publish this rate card
              </button>
            )}
          </form>
        </section>
      ))}

      {extractionRun.status === "pending_review" && (
        <form action={rejectExtractionRun.bind(null, extractionRun.id)}>
          <button type="submit" className="rounded border border-red-300 px-4 py-2 text-sm text-red-700">
            Reject this entire extraction (nothing published)
          </button>
        </form>
      )}
    </main>
  );
}
