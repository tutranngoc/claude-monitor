import { NextResponse } from "next/server";
import { findPlanById, updatePlan } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; noteId: string }>;
}

interface Body {
  dismissed?: boolean;
}

// POST /api/plans/<plan-id>/notes/<note-id>/dismiss
//
// Toggles the human-side ack on a phase note. `{dismissed: true}` stamps
// `dismissed_at` with the current ISO timestamp; `{dismissed: false}`
// clears it (restore). Idempotent — repeating the same value is a noop.
//
// Notes are otherwise append-only from agents (submit_phase_note MCP
// tool); this route is the only mutator of an existing note and is
// reachable only from the orchestrator UI. Returns the updated plan so
// the client can mirror state without a separate GET.
export async function POST(req: Request, { params }: Ctx) {
  const { id: planId, noteId } = await params;
  if (!planId || !noteId) {
    return NextResponse.json(
      { error: "plan id and note id are required" },
      { status: 400 },
    );
  }

  let body: Body = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as Body;
    }
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.dismissed !== "boolean") {
    return NextResponse.json(
      { error: "dismissed must be a boolean" },
      { status: 400 },
    );
  }

  const plan = await findPlanById(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }
  const exists = (plan.notes ?? []).some((n) => n.id === noteId);
  if (!exists) {
    return NextResponse.json({ error: "note not found" }, { status: 404 });
  }

  const stamp = body.dismissed ? new Date().toISOString() : undefined;
  const updated = await updatePlan(plan.cwd, plan.id, (p) => {
    if (!p.notes) return;
    const i = p.notes.findIndex((n) => n.id === noteId);
    if (i < 0) return;
    if (stamp) {
      p.notes[i].dismissed_at = stamp;
    } else {
      delete p.notes[i].dismissed_at;
    }
  });

  return NextResponse.json({ plan: updated });
}
