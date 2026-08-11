import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { QuoteChat } from "./chat-client";

export default async function QuotePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return <QuoteChat />;
}
