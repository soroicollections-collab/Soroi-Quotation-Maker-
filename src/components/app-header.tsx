import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export async function AppHeader() {
  const session = await auth();

  return (
    <header className="border-b border-line bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image's built-in optimizer 400s on this file under Next 16/Turbopack; a plain img avoids it for this small, already-optimized logo */}
          <img src="/soroi-logo.png" alt="Soroi Collection" className="h-8 w-auto" />
          <div className="leading-tight">
            <div className="font-heading text-sm tracking-[0.15em] text-earth">SOROI COLLECTION</div>
            <div className="text-[9px] font-medium tracking-[0.2em] text-gold-deep">QUOTATION MAKER</div>
          </div>
        </Link>

        {session?.user && (
          <nav className="flex items-center gap-5 text-sm">
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
          </nav>
        )}
      </div>
    </header>
  );
}
