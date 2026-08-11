import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { toDisplayMessages } from "@/lib/agent/conversation-display";
import { QuoteChat } from "../chat-client";
import type { QuoteDocumentData } from "@/lib/render/quote-data";

export default async function ExistingQuotePage({ params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { conversationId } = await params;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      quote: true,
    },
  });

  // Not found, or belongs to someone else - land back on a fresh quote rather than 404,
  // since a stale/foreign link in the URL bar shouldn't dead-end the tool.
  if (!conversation || conversation.userId !== session.user.id) {
    redirect("/quote");
  }

  const initialMessages = toDisplayMessages(conversation.messages);
  const initialQuote = conversation.quote
    ? {
        quoteId: conversation.quote.quoteId,
        grandTotal: (conversation.quote.documentData as unknown as QuoteDocumentData | null)?.grandTotal ?? "-",
      }
    : null;

  return <QuoteChat conversationId={conversation.id} initialMessages={initialMessages} initialQuote={initialQuote} />;
}
