import { notFound } from "next/navigation";
import { snapshotSession } from "@/lib/server/sessions";
import { ChatPanel } from "@/components/chat/chat-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ChatSessionPage({ params }: Props) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) notFound();
  return <ChatPanel session={snap.summary} />;
}
