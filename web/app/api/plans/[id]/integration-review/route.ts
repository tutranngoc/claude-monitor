import { NextResponse } from "next/server";
import { runIntegrationReviewForPlan } from "@/lib/server/plan-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/plans/<plan-id>/integration-review
//
// Thin wrapper around `runIntegrationReviewForPlan` so the leader MCP
// tool `mcp__leader__run_integration_review` and this route share one
// execution path. Background job — returns 202 with the plan record
// while the reviewer agent runs to completion.
export async function POST(_req: Request, { params }: Ctx) {
  const { id: planId } = await params;
  if (!planId) {
    return NextResponse.json({ error: "plan id is required" }, { status: 400 });
  }

  const r = await runIntegrationReviewForPlan({ planId });
  if (!r.ok) {
    const status = r.error.code === "not_found" ? 404 : 409;
    return NextResponse.json({ error: r.error.message }, { status });
  }
  if (r.alreadyRunning) {
    return NextResponse.json(
      { plan: r.plan, already_running: true },
      { status: 202 },
    );
  }
  return NextResponse.json({ plan: r.plan }, { status: 202 });
}
