import { NextResponse } from "next/server";
import { snapshotSession, stopSession } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json(snap);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await stopSession(id);
  return NextResponse.json({ ok: true });
}
