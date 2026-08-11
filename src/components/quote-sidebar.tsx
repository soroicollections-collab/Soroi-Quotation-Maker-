"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type SidebarConversation = {
  id: string;
  title: string;
  hasQuote: boolean;
  /** Lowercased blob of everything this conversation should be searchable by - see
   * lib/agent/conversation-display.ts's buildSearchText. */
  searchText: string;
};

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function QuoteSidebar({ conversations }: { conversations: SidebarConversation[] }) {
  const pathname = usePathname();
  const activeId = pathname?.startsWith("/quote/") ? pathname.slice("/quote/".length) : undefined;
  const [query, setQuery] = useState("");
  // Mobile-only off-canvas drawer state (Claude-app style) - the desktop layout below
  // md ignores this entirely and always shows the sidebar in place. Every link inside
  // the drawer closes it via its own onClick (passed as onNavigate to panelContent),
  // which covers every real navigation path in this component.
  const [mobileOpen, setMobileOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.searchText.includes(q));
  }, [conversations, query]);

  function panelContent(onNavigate?: () => void) {
    return (
      <>
        <Link
          href="/quote"
          onClick={onNavigate}
          className="flex items-center justify-center gap-2 rounded-xl border border-gold-deep bg-gold-deep px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-white shadow-sm transition hover:brightness-105"
        >
          + New Quote
        </Link>

        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-grey"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M18 10.5a7.5 7.5 0 11-15 0 7.5 7.5 0 0115 0z" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search quotes..."
            className="w-full rounded-xl border border-line bg-white py-2 pl-9 pr-3 text-xs shadow-sm focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-white p-2 shadow-sm">
          <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-grey">Quotes</div>
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-grey">
              Nothing yet - describe a trip to start your first quote.
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-grey">No quotes match &ldquo;{query}&rdquo;.</p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((c) => {
                const active = c.id === activeId;
                return (
                  <li key={c.id}>
                    <Link
                      href={`/quote/${c.id}`}
                      onClick={onNavigate}
                      className={
                        "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs leading-snug transition " +
                        (active ? "bg-tan-light text-earth" : "text-earth/80 hover:bg-tan-light/60")
                      }
                    >
                      <span className="line-clamp-2 flex-1">{c.title}</span>
                      {c.hasQuote && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold" title="Quote finalized" />}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {/* Mobile trigger - normal document flow, stacks above the chat panel since the
          quote layout switches to a column on small screens. Hidden entirely on md+. */}
      <button
        onClick={() => setMobileOpen(true)}
        className="flex items-center gap-2 self-start rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-semibold text-earth shadow-sm md:hidden"
      >
        <MenuIcon />
        Quotes
      </button>

      {/* Desktop: always-visible static sidebar. */}
      <aside className="hidden w-64 shrink-0 flex-col gap-3 md:flex">{panelContent()}</aside>

      {/* Mobile: full-screen off-canvas drawer, closes on backdrop tap, link click, or route change. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[85%] max-w-xs flex-col gap-3 bg-background p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="font-heading text-sm text-earth">Quotes</span>
              <button
                onClick={() => setMobileOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-earth hover:bg-tan-light"
              >
                ✕
              </button>
            </div>
            {panelContent(() => setMobileOpen(false))}
          </div>
        </div>
      )}
    </>
  );
}
