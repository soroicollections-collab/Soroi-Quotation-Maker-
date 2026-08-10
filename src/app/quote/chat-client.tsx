"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type QuoteReady = {
  quoteId: string;
  grandTotal: string;
  calculatorFlags?: string[];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  quoteReady?: QuoteReady;
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

function QuoteReadyCard({ quote }: { quote: QuoteReady }) {
  const flags = quote.calculatorFlags?.filter(Boolean) ?? [];
  return (
    <div className="mt-3 max-w-[85%] overflow-hidden rounded-xl border border-gold shadow-sm">
      <div className="flex items-center justify-between gap-4 bg-earth px-5 py-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold">Draft quote ready</div>
          <div className="mt-1 font-heading text-lg text-white">{quote.quoteId}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-tan">Total</div>
          <div className="font-heading text-xl text-white">{quote.grandTotal}</div>
        </div>
      </div>
      <div className="flex gap-2 bg-tan-light p-3">
        <a
          href={`/api/quotes/${quote.quoteId}/download?type=agent`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 rounded-lg bg-gold-deep py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-white transition hover:brightness-105"
        >
          Agent PDF
        </a>
        <a
          href={`/api/quotes/${quote.quoteId}/download?type=client`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 rounded-lg border border-earth py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-earth transition hover:bg-white"
        >
          Client PDF
        </a>
      </div>
      {flags.length > 0 && (
        <div className="border-t border-line bg-white px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-grey">Flagged for review</div>
          <ul className="mt-1.5 space-y-1">
            {flags.map((f, i) => (
              <li key={i} className="text-xs leading-relaxed text-grey">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
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
        {message.quoteReady && <QuoteReadyCard quote={message.quoteReady} />}
      </div>
    </div>
  );
}

export function QuoteChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", text: "" }]);

    try {
      const res = await fetch("/api/quote/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationId.current, message: text }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

      await readSSE(res.body, (event, data) => {
        if (event === "conversation") {
          conversationId.current = (data as { conversationId: string }).conversationId;
        } else if (event === "text") {
          const delta = (data as { delta: string }).delta;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m))
          );
        } else if (event === "quote_ready") {
          const quote = data as QuoteReady;
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, quoteReady: quote } : m)));
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
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto rounded-2xl border border-line bg-white p-5 shadow-sm">
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
      </div>
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
          className="rounded-xl bg-gold-deep px-6 py-3 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
