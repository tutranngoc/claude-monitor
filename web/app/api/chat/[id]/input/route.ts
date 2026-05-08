import { NextResponse } from "next/server";
import { sendMessage } from "@/lib/server/sessions";
import type { Attachment, SendInputRequest } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: Partial<SendInputRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as Attachment[])
    : undefined;
  if (!text && !attachments?.length) {
    return NextResponse.json(
      { error: "text or attachments required" },
      { status: 400 },
    );
  }
  try {
    sendMessage(id, text, attachments);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
