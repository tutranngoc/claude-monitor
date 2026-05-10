import { NextResponse } from "next/server";
import { runMergeForPlan } from "@/lib/server/plan-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  integration_branch?: string;
}

// POST /api/plans/<plan-id>/merge
//
// Thin wrapper around `runMergeForPlan` (web/lib/server/plan-lifecycle.ts)
// so the leader MCP tool `mcp__leader__merge_plan` and this route share
// one execution path. Defaults integration branch to "main".
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

  const r = await runMergeForPlan({
    planId,
    integrationBranch: body.integration_branch ?? "main",
  });
  if (!r.ok) {
    const status =
      r.error.code === "not_found"
        ? 404
        : r.error.code === "validation"
          ? 400
          : 409;
    return NextResponse.json(
      { error: r.error.message, ...(r.error.details ?? {}) },
      { status },
    );
  }
  return NextResponse.json({ plan: r.plan, merge: r.merge });
}
