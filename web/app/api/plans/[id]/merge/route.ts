import { NextResponse } from "next/server";
import {
  buildMergedNudge,
  nudgeLeader,
} from "@/lib/server/leader-nudge";
import { runMergeForPlan } from "@/lib/server/plan-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  integration_branch?: string;
  // Phase slugs whose scope_violations the caller has reviewed and is
  // choosing to merge anyway. Forwarded to runMergeForPlan as
  // acknowledgeScopeViolations. Per-slug — phases with violations not
  // in this list block the merge with `code: "scope_violations"`.
  acknowledge_scope_violations?: string[];
}

// POST /api/plans/<plan-id>/merge
//
// Thin wrapper around `runMergeForPlan` (web/lib/server/plan-lifecycle.ts)
// so the leader MCP tool `mcp__leader__merge_plan` and this route share
// one execution path. integration_branch is REQUIRED and must not be a
// protected trunk — the lifecycle layer rejects 'main'/'master'/etc.
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

  if (!body.integration_branch || body.integration_branch.trim().length === 0) {
    return NextResponse.json(
      { error: "integration_branch is required (no default — must be a feature branch, not a protected trunk)" },
      { status: 400 },
    );
  }

  // Validate ack list shape only — content is checked against the
  // plan inside runMergeForPlan. Reject obvious garbage early so we
  // don't quietly drop a malformed body.
  if (
    body.acknowledge_scope_violations !== undefined &&
    (!Array.isArray(body.acknowledge_scope_violations) ||
      body.acknowledge_scope_violations.some((s) => typeof s !== "string"))
  ) {
    return NextResponse.json(
      { error: "acknowledge_scope_violations must be an array of phase slug strings" },
      { status: 400 },
    );
  }

  const r = await runMergeForPlan({
    planId,
    integrationBranch: body.integration_branch,
    acknowledgeScopeViolations: body.acknowledge_scope_violations,
  });
  if (!r.ok) {
    const status =
      r.error.code === "not_found"
        ? 404
        : r.error.code === "validation" || r.error.code === "forbidden_branch"
          ? 400
          : 409;
    return NextResponse.json(
      { error: r.error.message, ...(r.error.details ?? {}) },
      { status },
    );
  }
  // Successful merge → ping the leader so it knows to run integration
  // review (or surface a merge_status === "pending" / "failed" report
  // for the user). Skip nudge on partial/failed runs to avoid pulling
  // the leader into a broken state without a clear next action.
  if (r.plan.merge_status === "merged" && r.plan.merge_branch) {
    // Awaited so plan.last_nudge is persisted before we respond — the
    // UI's first poll after merge will see the banner state if the
    // leader was unreachable.
    await nudgeLeader({
      planId: r.plan.id,
      milestone: "merged",
      message: buildMergedNudge({
        planTitle: r.plan.title,
        branch: r.plan.merge_branch,
        headSha: r.plan.merge_head_sha,
      }),
    });
  }

  return NextResponse.json({ plan: r.plan, merge: r.merge });
}
