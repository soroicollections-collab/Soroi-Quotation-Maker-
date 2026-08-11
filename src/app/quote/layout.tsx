import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { conversationTitle, buildSearchText } from "@/lib/agent/conversation-display";
import { QuoteSidebar, type SidebarConversation } from "@/components/quote-sidebar";
import type { QuoteDocumentData } from "@/lib/render/quote-data";

export default async function QuoteLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const conversations = await prisma.conversation.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      quote: { select: { route: true, quoteId: true, documentData: true } },
      // Only "user" rows are ever real typed messages or tool_result echoes (see
      // toDisplayMessages) - assistant/tool content is excluded, it's irrelevant to search
      // and would bloat this payload for no benefit.
      messages: { where: { role: "user" }, orderBy: { createdAt: "asc" }, select: { content: true } },
    },
  });

  const sidebarItems: SidebarConversation[] = conversations.map((c) => {
    const documentData = c.quote?.documentData as unknown as QuoteDocumentData | null | undefined;
    return {
      id: c.id,
      title: conversationTitle(c.quote?.route, c.messages[0]?.content),
      hasQuote: !!c.quote,
      searchText: buildSearchText({
        quoteRoute: c.quote?.route,
        quoteId: c.quote?.quoteId,
        guestsSummary: documentData?.guestsSummary,
        travelDatesLabel: documentData?.travelDatesLabel,
        userMessageContents: c.messages.map((m) => m.content),
      }),
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-3 py-3 md:flex-row md:gap-6 md:px-6 md:py-6">
      <QuoteSidebar conversations={sidebarItems} />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
