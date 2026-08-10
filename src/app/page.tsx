import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.25em] text-gold-deep">Welcome back, {session?.user?.name?.split(" ")[0]}</p>
        <h1 className="mt-3 font-heading text-3xl text-earth">What would you like to do?</h1>
      </div>

      <div className="grid w-full max-w-xl gap-4 sm:grid-cols-2">
        <Link
          href="/quote"
          className="group flex flex-col items-start gap-2 rounded-xl border border-line bg-white p-6 text-left shadow-sm transition hover:border-gold hover:shadow-md"
        >
          <span className="font-heading text-lg text-earth">Generate a quote</span>
          <span className="text-sm text-grey">Describe an itinerary in plain English and get a draft PDF back.</span>
          <span className="mt-2 text-sm font-medium text-gold-deep group-hover:underline">Start &rarr;</span>
        </Link>

        {session?.user?.role === "RATE_MANAGER" && (
          <>
            <Link
              href="/admin/rates"
              className="group flex flex-col items-start gap-2 rounded-xl border border-line bg-white p-6 text-left shadow-sm transition hover:border-gold hover:shadow-md"
            >
              <span className="font-heading text-lg text-earth">Rate updates</span>
              <span className="text-sm text-grey">Upload a rate PDF, review what was extracted, publish it.</span>
              <span className="mt-2 text-sm font-medium text-gold-deep group-hover:underline">Manage &rarr;</span>
            </Link>
            <Link
              href="/admin/users"
              className="group flex flex-col items-start gap-2 rounded-xl border border-line bg-white p-6 text-left shadow-sm transition hover:border-gold hover:shadow-md"
            >
              <span className="font-heading text-lg text-earth">Team &amp; roles</span>
              <span className="text-sm text-grey">Add accounts and manage who can publish rate updates.</span>
              <span className="mt-2 text-sm font-medium text-gold-deep group-hover:underline">Manage &rarr;</span>
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
