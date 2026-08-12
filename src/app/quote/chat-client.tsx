"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type QuoteReady = {
  quoteId: string;
  grandTotal: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type PendingChoices = {
  question: string;
  options: string[];
};

const SUGGESTIONS = [
  "Soroi Cheetah Tented Camp, 2 nights, 2 adults, Rack Rate, Non-Resident, check-in 2027-07-14, Ground Package, sharing.",
  "Soroi Larsens Camp, 3 nights, 2 adults and 1 child aged 8, STO 30%, Non-Resident, check-in 2027-08-20, Luxury Tents, Full Board, sharing.",
];

// Parses a text/event-stream body incrementally. Each event is "event: <name>\ndata: <json>\n\n".
async function readSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventName = "message";
      let dataLine = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7);
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      if (dataLine) {
        try {
          onEvent(eventName, JSON.parse(dataLine));
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gold-deep [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gold-deep [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gold-deep" />
    </span>
  );
}

/** Persistent, not tied to any one chat bubble - shows for a freshly-finalized quote
 * just as well as one reopened from the sidebar days later. Re-rendering the PDF is
 * always a live fetch to the download route (see api/quotes/[quoteId]/download), so
 * there's nothing stale to worry about here even though nothing is cached client-side. */
function QuoteDownloadBar({ quote }: { quote: QuoteReady }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gold bg-earth px-4 py-3 shadow-sm md:px-5 md:py-3.5">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold">Quote Ready</div>
        <div className="mt-0.5 font-heading text-base text-white">{quote.quoteId}</div>
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wide text-tan">Total</div>
        <div className="font-heading text-lg text-white">{quote.grandTotal}</div>
      </div>
      <div className="flex gap-2">
        <a
          href={`/api/quotes/${quote.quoteId}/download?type=agent`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-gold-deep px-4 py-2 text-center text-xs font-semibold uppercase tracking-wide text-white transition hover:brightness-105"
        >
          Agent PDF
        </a>
        <a
          href={`/api/quotes/${quote.quoteId}/download?type=client`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-white/40 px-4 py-2 text-center text-xs font-semibold uppercase tracking-wide text-white transition hover:bg-white/10"
        >
          Client PDF
        </a>
      </div>
    </div>
  );
}

/** Clickable "quick reply" buttons for a multiple-choice question the agent just asked
 * (see the present_choices tool). Clicking one sends its exact label as the next message,
 * identical to the requester having typed it themselves - the agent can't tell the
 * difference, so there's no separate answer-handling path to keep in sync. */
function ChoiceButtons({ choices, disabled, onPick }: { choices: PendingChoices; disabled: boolean; onPick: (option: string) => void }) {
  return (
    <div className="ml-9 flex max-w-[85%] flex-col gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-grey">{choices.question}</div>
      <div className="flex flex-wrap gap-2">
        {choices.options.map((option) => (
          <button
            key={option}
            disabled={disabled}
            onClick={() => onPick(option)}
            className="rounded-full border border-gold bg-tan-light px-3.5 py-1.5 text-xs font-medium text-earth transition hover:bg-gold hover:text-white disabled:opacity-40"
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex items-start gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " +
          (isUser ? "bg-earth text-white" : "border border-gold bg-tan-light text-gold-deep")
        }
      >
        {isUser ? (
          "You"
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- see app-header.tsx
          <img src="/soroi-logo.png" alt="" className="h-3.5 w-auto opacity-80" />
        )}
      </div>
      <div className={`flex max-w-[85%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed " +
            (isUser ? "rounded-tr-sm bg-earth text-white" : "rounded-tl-sm bg-tan-light text-earth")
          }
        >
          {message.text ? (
            <div className={"prose-chat " + (isUser ? "prose-chat-user" : "")}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
            </div>
          ) : (
            <TypingIndicator />
          )}
        </div>
      </div>
    </div>
  );
}

export function QuoteChat({
  conversationId: initialConversationId,
  initialMessages,
  initialQuote,
}: {
  conversationId?: string;
  initialMessages?: ChatMessage[];
  initialQuote?: QuoteReady | null;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [finalizedQuote, setFinalizedQuote] = useState<QuoteReady | null>(initialQuote ?? null);
  const [pendingChoices, setPendingChoices] = useState<PendingChoices | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const conversationIdRef = useRef<string | undefined>(initialConversationId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    // Whether answered by clicking a button or typing free text, the question's been
    // answered - clear it so stale buttons can't be clicked again after the fact.
    setPendingChoices(null);

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", text: "" }]);

    try {
      const res = await fetch("/api/quote/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationIdRef.current, message: text }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

      await readSSE(res.body, (event, data) => {
        if (event === "conversation") {
          const id = (data as { conversationId: string }).conversationId;
          const isNewConversation = !conversationIdRef.current;
          conversationIdRef.current = id;
          if (isNewConversation) {
            // URL bar sync only - a raw history API call, not Next's router, so it can't
            // trigger a re-render/remount of this component mid-stream (see the note on
            // router.refresh() below for why that distinction matters here).
            window.history.replaceState(null, "", `/quote/${id}`);
          }
        } else if (event === "text") {
          const delta = (data as { delta: string }).delta;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m))
          );
        } else if (event === "quote_ready") {
          const quote = data as QuoteReady;
          setFinalizedQuote(quote);
        } else if (event === "choices") {
          setPendingChoices(data as PendingChoices);
        } else if (event === "error") {
          const msg = (data as { message: string }).message;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + `\n\nSomething went wrong: ${msg}` } : m))
          );
        }
      });
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: m.text + `\n\nConnection error: ${err instanceof Error ? err.message : String(err)}` }
            : m
        )
      );
    } finally {
      setSending(false);
      // Sync the sidebar (new conversation title, quote-finalized dot) now that the
      // exchange has fully settled. Calling this mid-stream instead (as an earlier
      // version of this code did) re-fetches this route's server data while the SSE
      // read loop above is still running - React re-renders this component from that
      // fresh server payload, which at that point still only reflects the just-sent
      // user message, silently discarding the in-progress assistant bubble and any
      // further "text"/"quote_ready" events, since they were meant for a state setter
      // that's no longer attached to what's on screen. Refreshing only after the loop
      // finishes avoids stepping on the stream while it's live.
      router.refresh();
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto rounded-2xl border border-line bg-white p-3 shadow-sm md:p-5">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-6 px-4 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- see app-header.tsx */}
            <img src="/soroi-logo.png" alt="" className="h-11 w-auto opacity-90" />
            <div>
              <h2 className="font-heading text-lg text-earth">Describe the trip</h2>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-grey">
                Property, nights, guests, and tier &mdash; I&rsquo;ll ask if anything&rsquo;s missing, then hand you a
                draft PDF.
              </p>
            </div>
            <div className="flex w-full max-w-md flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-lg border border-line bg-tan-light px-4 py-2.5 text-left text-xs text-earth transition hover:border-gold"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {pendingChoices && <ChoiceButtons choices={pendingChoices} disabled={sending} onPick={(option) => send(option)} />}
      </div>
      {finalizedQuote && <QuoteDownloadBar quote={finalizedQuote} />}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe the itinerary..."
          className="flex-1 rounded-xl border border-line bg-white px-4 py-3 text-sm shadow-sm focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-xl bg-gold-deep px-4 py-3 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-40 md:px-6"
        >
          Send
        </button>
      </form>
    </div>
  );
}
