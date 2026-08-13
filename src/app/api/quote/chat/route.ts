import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { allTools, type ToolCallRecorder } from "@/lib/agent/tools";
import { QUOTE_AGENT_SYSTEM_PROMPT } from "@/lib/agent/systemPrompt";

// A multi-turn tool-calling loop (several rate lookups + a calculation + finalize) can
// run well past the platform default. Node runtime, not Edge - Prisma and the render
// pipeline both need it.
export const runtime = "nodejs";
export const maxDuration = 120;

const client = new Anthropic();

function preparerInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3) || "XX";
}

// Anthropic.Beta.BetaMessageParam - kept loose here since content blocks vary by role.
type StoredMessage = { role: "user" | "assistant"; content: unknown };

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { conversationId: incomingConversationId, message } = (await req.json()) as {
    conversationId?: string;
    message: string;
  };

  if (!message || typeof message !== "string") {
    return new Response("message is required", { status: 400 });
  }

  const userId = session.user.id;
  const initials = preparerInitials(session.user.name ?? "Staff");

  let conversation = incomingConversationId
    ? await prisma.conversation.findUnique({
        where: { id: incomingConversationId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      })
    : null;

  if (!conversation || conversation.userId !== userId) {
    conversation = await prisma.conversation.create({
      data: { userId },
      include: { messages: true },
    });
  }

  const history: StoredMessage[] = conversation.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content as unknown,
  }));

  const userMessage: StoredMessage = { role: "user", content: message };
  await prisma.conversationMessage.create({
    data: { conversationId: conversation.id, role: "user", content: message },
  });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sseEvent(event, data)));

      send("conversation", { conversationId: conversation!.id });

      // The Tool Runner executes each tool's `run` internally and builds the follow-up
      // tool_result message itself, without exposing it back to us. To persist a fully
      // replayable transcript, every tool reports through this recorder (see
      // lib/agent/tools.ts), and we reconstruct the tool_result blocks ourselves below -
      // matched to the previous turn's tool_use ids, FIFO per tool name (safe because the
      // runner issues tool_use blocks and their `run` calls in the same order).
      let pendingCalls: { name: string; input: unknown; output: string }[] = [];
      const onCall: ToolCallRecorder = (name, input, output) => {
        pendingCalls.push({ name, input, output });
      };

      try {
        const runner = client.beta.messages.toolRunner({
          model: process.env.ANTHROPIC_MODEL_CHAT || "claude-sonnet-5",
          max_tokens: 8000,
          system: QUOTE_AGENT_SYSTEM_PROMPT,
          tools: allTools(userId, initials, session.user.name ?? "Staff", conversation!.id, onCall),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: [...history, userMessage] as any,
          stream: true,
        });

        let previousToolUseBlocks: { id: string; name: string }[] = [];

        for await (const messageStream of runner) {
          // pendingCalls now holds exactly the results for previousToolUseBlocks, since the
          // runner always executes a turn's tool calls before requesting the next turn.
          if (previousToolUseBlocks.length > 0) {
            const queueByName = new Map<string, { input: unknown; output: string }[]>();
            for (const c of pendingCalls) {
              if (!queueByName.has(c.name)) queueByName.set(c.name, []);
              queueByName.get(c.name)!.push({ input: c.input, output: c.output });
            }
            const toolResultBlocks = previousToolUseBlocks.map((tu) => {
              const match = queueByName.get(tu.name)?.shift();
              return { type: "tool_result", tool_use_id: tu.id, content: match?.output ?? "" };
            });
            await prisma.conversationMessage.create({
              data: {
                conversationId: conversation!.id,
                role: "user",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                content: toolResultBlocks as any,
              },
            });

            // Surface a structured "quote ready" event so the UI can render a real
            // download link instead of the staff member having to parse a file path out
            // of the assistant's prose. Tool-call internals otherwise stay off the wire -
            // this app should look like "describe itinerary -> get PDF," not a debug console.
            const finalizeCall = pendingCalls.find((c) => c.name === "finalize_quote");
            if (finalizeCall) {
              try {
                const parsed = JSON.parse(finalizeCall.output);
                if (parsed.quoteId && !parsed.error) {
                  send("quote_ready", parsed);
                }
              } catch {
                // malformed tool output - let the assistant's own text response cover it
              }
            }

            // Same idea as quote_ready above, but for present_choices: the useful data
            // ({question, options}) is the tool's *input*, not its output (which is just
            // an ack) - see tools.ts's comment on why this tool does no real work.
            const choicesCall = pendingCalls.find((c) => c.name === "present_choices");
            if (choicesCall) {
              const input = choicesCall.input as { question?: unknown; options?: unknown };
              if (typeof input.question === "string" && Array.isArray(input.options)) {
                send("choices", { question: input.question, options: input.options });
              }
            }
          }
          pendingCalls = [];

          for await (const event of messageStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              send("text", { delta: event.delta.text });
            }
          }
          const finalMessage = await messageStream.finalMessage();
          await prisma.conversationMessage.create({
            data: {
              conversationId: conversation!.id,
              role: "assistant",
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              content: finalMessage.content as any,
            },
          });

          previousToolUseBlocks = [];
          for (const block of finalMessage.content) {
            if (block.type === "tool_use") {
              previousToolUseBlocks.push({ id: block.id, name: block.name });
            }
          }
        }

        send("done", {});
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
