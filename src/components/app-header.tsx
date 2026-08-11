import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export async function AppHeader() {
  const session = await auth();

  const logoutForm = (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
    >
      <button type="submit" className="text-grey hover:text-earth" aria-label="Log out">
        Log out
      </button>
    </form>
  );

  return (
    <header className="relative border-b border-line bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 md:px-6">
        <Link href="/" className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image's built-in optimizer 400s on this file under Next 16/Turbopack; a plain img avoids it for this small, already-optimized logo */}
          <img src="/soroi-logo.png" alt="Soroi Collection" className="h-8 w-auto" />
          <div className="leading-tight">
            <div className="font-heading text-sm tracking-[0.15em] text-earth">SOROI COLLECTION</div>
            <div className="text-[9px] font-medium tracking-[0.2em] text-gold-deep">QUOTATION MAKER</div>
          </div>
        </Link>

        {session?.user && (
          <>
            {/* Desktop: full nav row. Hidden below md, where it's replaced by the
                <details> disclosure below - kept as a Server Component (no client JS)
                since <details>/<summary> handles the open/close state natively. */}
            <nav className="hidden items-center gap-5 text-sm md:flex">
              <Link href="/quote" className="text-earth hover:text-gold-deep">
                Quotes
              </Link>
              {session.user.role === "RATE_MANAGER" && (
                <>
                  <Link href="/admin/rates" className="text-earth hover:text-gold-deep">
                    Rates
                  </Link>
                  <Link href="/admin/users" className="text-earth hover:text-gold-deep">
                    Team
                  </Link>
                </>
              )}
              <div className="mx-1 h-5 w-px bg-line" />
              <span className="text-grey">{session.user.name}</span>
              {logoutForm}
            </nav>

            <details className="md:hidden [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-lg border border-line text-earth">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
                <span className="sr-only">Menu</span>
              </summary>
              <nav className="absolute right-4 top-14 z-50 flex w-48 flex-col gap-1 rounded-xl border border-line bg-white p-2 text-sm shadow-lg">
                <Link href="/quote" className="rounded-lg px-3 py-2 text-earth hover:bg-tan-light">
                  Quotes
                </Link>
                {session.user.role === "RATE_MANAGER" && (
                  <>
                    <Link href="/admin/rates" className="rounded-lg px-3 py-2 text-earth hover:bg-tan-light">
                      Rates
                    </Link>
                    <Link href="/admin/users" className="rounded-lg px-3 py-2 text-earth hover:bg-tan-light">
                      Team
                    </Link>
                  </>
                )}
                <div className="my-1 h-px bg-line" />
                <span className="px-3 py-1 text-xs text-grey">{session.user.name}</span>
                <div className="px-3 py-1">{logoutForm}</div>
              </nav>
            </details>
          </>
        )}
      </div>
    </header>
  );
}
