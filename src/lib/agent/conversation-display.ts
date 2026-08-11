import type { ConversationMessage } from "@prisma/client";

export type DisplayMessage = { id: string; role: "user" | "assistant"; text: string };

/**
 * Reconstructs the chat bubbles a user actually saw from stored ConversationMessage rows.
 * Rows come in three shapes: a genuine user turn (content is a plain string), an assistant
 * turn (content is Anthropic's content-block array - text and/or tool_use blocks), and a
 * synthetic "user" turn carrying tool_result blocks back to the model (content is an array
 * of {type: "tool_result", ...} objects). Tool internals never reached the live chat UI
 * (the SSE route only ever sends "text" deltas), so tool_use/tool_result content is skipped
 * here too - a reopened conversation should look exactly like it did when it happened.
 */
export function toDisplayMessages(rows: Pick<ConversationMessage, "id" | "role" | "content">[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      if (typeof row.content === "string" && row.content.trim()) {
        out.push({ id: row.id, role: "user", text: row.content });
      }
      // else: an array of tool_result blocks - not a real user turn, skip.
      continue;
    }
    if (row.role === "assistant") {
      const blocks = Array.isArray(row.content) ? row.content : [];
      const text = blocks
        .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim()) out.push({ id: row.id, role: "assistant", text });
    }
  }
  return out;
}

/** Derives a sidebar-friendly title, matching how ChatGPT/Claude title a chat from its first message. */
export function conversationTitle(quoteRoute: string | null | undefined, firstUserMessageContent: unknown): string {
  if (quoteRoute && quoteRoute.trim()) return quoteRoute;
  if (typeof firstUserMessageContent === "string" && firstUserMessageContent.trim()) {
    const trimmed = firstUserMessageContent.trim();
    return trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
  }
  return "New quote";
}

/**
 * Builds one lowercased blob per conversation for client-side sidebar search - covers
 * property/route, quote ID, guest count, and travel dates, plus every real user message
 * (not just the first), so a property or date mentioned mid-conversation still matches.
 * There's no structured "client name" field anywhere in the data model yet (see
 * lib/render/quote-data.ts) - if staff typed a name into their itinerary description it's
 * caught here as plain text, but nothing guarantees one was ever typed.
 */
export function buildSearchText(params: {
  quoteRoute?: string | null;
  quoteId?: string | null;
  guestsSummary?: string | null;
  travelDatesLabel?: string | null;
  userMessageContents: unknown[];
}): string {
  const parts = [
    params.quoteRoute,
    params.quoteId,
    params.guestsSummary,
    params.travelDatesLabel,
    ...params.userMessageContents.filter((c): c is string => typeof c === "string"),
  ].filter((s): s is string => !!s && s.trim().length > 0);
  return parts.join(" • ").toLowerCase();
}
