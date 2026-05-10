import { NextResponse } from "next/server";
import { findPlanById } from "@/lib/server/plans";
import {
  isReviewInFlight,
  persistRunning,
  resolveBase,
  runPhaseReview,
} from "@/lib/server/review";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; slug: string }>;
}

// POST /api/plans/<plan-id>/phases/<phase-slug>/review
//
// Spawns a one-shot Claude session in the phase worktree that reads
// `<base>..HEAD` and reports findings via the submit_review MCP tool.
// Background job: this endpoint marks the review as running, returns
// the updated plan, and lets the agent finish asynchronously. The
// PhaseBoard polls /api/plans/<id> while review_status === "running"
// so the user sees results land without a manual refresh.
//
// Gating:
//   - plan.status === "approved"
//   - phase has a non-failed commit_status (clean | committed). We
//     refuse to review uncommitted work — the diff `<base>..HEAD` would
//     either be empty (clean) or partial (working tree edits the
//     reviewer can't see via git).
//   - no review currently in flight for this (plan, slug). Re-clicking
//     while one is running returns the same running record without
//     spawning a second agent.
export async function POST(_req: Request, { params }: Ctx) {
  const { id: planId, slug } = await params;
  if (!planId || !slug) {
    return NextResponse.json(
      { error: "plan id and phase slug are required" },
      { status: 400 },
    );
  }

  const plan = await findPlanById(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }
  if (plan.status !== "approved") {
    return NextResponse.json(
      { error: "plan is not approved yet" },
      { status: 409 },
    );
  }

  const phase = plan.phases.find((p) => p.slug === slug);
  if (!phase) {
    return NextResponse.json(
      { error: `phase '${slug}' not found in plan` },
      { status: 404 },
    );
  }
  const link = plan.phase_sessions?.find((p) => p.phase_slug === slug);
  if (!link) {
    return NextResponse.json(
      { error: `no phase session found for slug '${slug}'` },
      { status: 404 },
    );
  }
  const worktree = plan.worktrees?.find((w) => w.phase_slug === slug);
  if (!worktree) {
    return NextResponse.json(
      { error: `no worktree found for slug '${slug}'` },
      { status: 404 },
    );
  }
  // Mirror the merge gate's commit-status check. Reviewing an
  // uncommitted phase would either show no diff (clean tree) or a
  // misleading partial diff if the model already committed some work.
  const commitStatus = link.commit_status;
  if (commitStatus !== "clean" && commitStatus !== "committed") {
    return NextResponse.json(
      {
        error:
          "phase must be committed before review — click 'commit & complete' first",
      },
      { status: 409 },
    );
  }

  if (isReviewInFlight(planId, slug)) {
    // Already running — short-circuit to the current plan so the UI
    // doesn't double-spawn. Same shape as the success response.
    return NextResponse.json({ plan, already_running: true }, { status: 202 });
  }

  const startedAt = new Date().toISOString();
  const updated = await persistRunning({ planId, phaseSlug: slug, startedAt });
  if (!updated) {
    return NextResponse.json(
      { error: "plan disappeared between read and persist" },
      { status: 500 },
    );
  }

  // Resolve base + head sha so the kickoff prompt names a concrete ref
  // and the eventual review record stores an immutable head pointer.
  // Best-effort: failures fall back to the branch name in the prompt.
  const baseBranch = plan.merge_branch ?? "main";
  const { baseSha, headSha } = await resolveBase(worktree.path, baseBranch);

  // Fire-and-forget. The review writes to disk via persistComplete /
  // persistFailed in review.ts; the route doesn't await the agent.
  // unhandledRejection is defensively guarded inside runPhaseReview's
  // try/finally — anything that escapes is logged here.
  void runPhaseReview({
    planId,
    phaseSlug: slug,
    configDir: link.config_dir,
    worktreePath: worktree.path,
    baseBranch,
    baseSha,
    headSha,
    phase,
    // Inherit per-phase overrides if the user pinned them at approve
    // time. effort is union-typed in plan-types but the SDK wants
    // EffortLevel — they're structurally identical (low/medium/high/
    // xhigh/max) so the cast is safe.
    model: phase.model,
    effort: phase.effort as EffortLevel | undefined,
  }).catch((err) => {
    console.error(
      `[review] runPhaseReview ${planId}/${slug} crashed outside guarded path:`,
      err,
    );
  });

  return NextResponse.json({ plan: updated }, { status: 202 });
}
