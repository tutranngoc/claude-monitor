import { NextResponse } from "next/server";
import {
  snapshotSession,
  stopSession,
  updateSessionOptions,
} from "@/lib/server/sessions";
import type { Effort, PermissionMode } from "@/lib/chat-types";

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

interface PatchBody {
  model?: string;
  effort?: Effort;
  permission_mode?: PermissionMode;
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as PatchBody;
  if (!body.model && !body.effort && !body.permission_mode) {
    return NextResponse.json(
      { error: "model, effort, or permission_mode required" },
      { status: 400 },
    );
  }
  try {
    const summary = await updateSessionOptions(id, {
      model: body.model,
      effort: body.effort,
      permissionMode: body.permission_mode,
    });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "session not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await stopSession(id);
  return NextResponse.json({ ok: true });
}
