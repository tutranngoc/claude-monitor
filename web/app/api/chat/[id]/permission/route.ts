import { NextResponse } from "next/server";
import { resolvePermission } from "@/lib/server/sessions";
import type { PermissionDecision } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  permission_id: string;
  decision: PermissionDecision;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.permission_id || !body.decision?.behavior) {
    return NextResponse.json(
      { error: "permission_id and decision.behavior are required" },
      { status: 400 },
    );
  }
  try {
    resolvePermission(id, body.permission_id, body.decision);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
