import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { uploadAndExtract } from "./actions";

// Extracting a full rate document with Claude Opus 5 can take well over a minute for a
// long PDF - the uploadAndExtract server action below inherits this page's duration.
export const maxDuration = 120;

export default async function RatesAdminPage() {
  const session = await auth();
  if (session?.user?.role !== "RATE_MANAGER") {
    return <main className="p-8">Not authorized.</main>;
  }

  const extractionRuns = await prisma.extractionRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { sourceDocument: true },
  });

  const rateCardCount = await prisma.rateCard.count({ where: { status: "published" } });
  const propertyCount = await prisma.property.count();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Rate management</h1>
        <p className="text-sm text-gray-500">
          {propertyCount} properties, {rateCardCount} published rate cards. Upload a rate PDF below to extract new
          figures - nothing goes live until you review and publish it.
        </p>
      </div>

      <form action={uploadAndExtract} className="flex flex-col gap-3 rounded border p-5">
        <label className="text-sm font-medium">Upload a rate document (PDF)</label>
        <input type="file" name="file" accept="application/pdf" required className="text-sm" />
        <button type="submit" className="self-start rounded bg-black px-4 py-2 text-sm text-white">
          Upload &amp; extract
        </button>
        <p className="text-xs text-gray-500">
          This sends the document to Claude for extraction (usually 30-90 seconds for a typical rate sheet) and takes
          you straight to the review page when it's done.
        </p>
      </form>

      <section>
        <h2 className="mb-3 text-lg font-medium">Recent extractions</h2>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-gray-500">
              <th className="py-2">Document</th>
              <th className="py-2">Uploaded</th>
              <th className="py-2">Status</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {extractionRuns.map((run) => (
              <tr key={run.id} className="border-b">
                <td className="py-2">{run.sourceDocument.filename}</td>
                <td className="py-2">{run.createdAt.toLocaleString()}</td>
                <td className="py-2">{run.status}</td>
                <td className="py-2">
                  <Link href={`/admin/rates/review/${run.id}`} className="underline">
                    {run.status === "pending_review" ? "Review" : "View"}
                  </Link>
                </td>
              </tr>
            ))}
            {extractionRuns.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-gray-400">
                  No extractions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
