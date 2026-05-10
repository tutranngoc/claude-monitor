import { NextResponse } from "next/server";
import { findPlanById, updatePlan } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  body?: string;
}

// 8KB cap mirrors the leader MCP tool's SHARED_BRIEF_BYTE_CAP. Brief is
// spliced into every phase's kickoff prompt so a 50KB primer would
// multiply across phases and crowd out the actual phase brief.
const MAX_BYTES = 8 * 1024;

// POST /api/plans/<plan-id>/shared-brief
//
// UI-driven counterpart to the leader's mcp__leader__record_shared_context
// tool. Same write semantics: replaces the brief wholesale, empty body
// clears it, byte-cap is the only validation. Stamps shared_brief_updated_at
// on every non-clear write so the panel can show "updated 3 min ago".
//
// Phases already running do NOT see edits; only phases spawned after the
// write pick up the new content. The panel surfaces this caveat to the
// user since the cost of misunderstanding is silent (a phase ignores the
// brief because it spawned before the user wrote it).
export async function POST(req: Request, { params }: Ctx) {
  const { id: planId } = await params;
  if (!planId) {
    return NextResponse.json({ error: "plan id is required" }, { status: 400 });
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

  if (typeof body.body !== "string") {
    return NextResponse.json(
      { error: "body must be a string" },
      { status: 400 },
    );
  }
  if (body.body.length > MAX_BYTES) {
    return NextResponse.json(
      { error: `body must be at most ${MAX_BYTES} bytes` },
      { status: 413 },
    );
  }

  const plan = await findPlanById(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }

  const trimmed = body.body.trim();
  const updated = await updatePlan(plan.cwd, plan.id, (p) => {
    if (trimmed.length === 0) {
      delete p.shared_brief;
      delete p.shared_brief_updated_at;
    } else {
      p.shared_brief = trimmed;
      p.shared_brief_updated_at = new Date().toISOString();
    }
  });

  return NextResponse.json({ plan: updated });
}
