import "server-only";

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { mergePhaseBranches } from "@/lib/server/git";
import {
  isIntegrationReviewInFlight,
  persistRunning as persistIntegrationReviewRunning,
  resolveIntegrationHead,
  runIntegrationReview,
} from "@/lib/server/integration-review";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import type {
  PhaseMergeResult,
  PhaseSession,
  PlanRecord,
} from "@/lib/plan-types";

const exec = promisify(execFile);

// Same charset gate as the merge route — git's own ref validation
// catches the rest, but pre-screening keeps shell metacharacters out.
const BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export type LifecycleErrorCode =
  | "not_found"
  | "not_approved"
  | "no_worktrees"
  | "no_phase_sessions"
  | "ineligible_phases"
  | "merge_pending"
  | "merge_not_done"
  | "missing_merge_branch"
  | "missing_merge_base"
  | "review_in_flight"
  | "validation"
  | "forbidden_branch"
  | "scope_violations"
  | "git_failed";

// Branches the orchestrator must never fold phase work into directly.
// Phases are merged into a fresh integration branch the leader will
// then push and open a PR from — that PR is the only path into a
// protected trunk.
const FORBIDDEN_INTEGRATION_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "trunk",
]);

export interface LifecycleError {
  code: LifecycleErrorCode;
  message: string;
  // For ineligible_phases: which slugs are missing commit_status.
  details?: Record<string, unknown>;
}

// runMergeForPlan executes the same merge sequence the
// /api/plans/[id]/merge route uses. Lifted out so the leader MCP tool
// can drive merges from inside an agent without us duplicating the
// gating + persistence logic.
//
// `acknowledgeScopeViolations` lists phase slugs whose post-commit
// scope_violations the caller has reviewed and is choosing to merge
// anyway. Phases with scope_violations.length > 0 NOT in this list
// abort the merge with `code: "scope_violations"` so the leader (or
// the user driving via /merge) is forced to surface the drift before
// it lands in the integration branch. Empty/undefined = no
// acknowledgments; phases with no violations don't need entries here.
export async function runMergeForPlan(args: {
  planId: string;
  integrationBranch: string;
  acknowledgeScopeViolations?: string[];
}): Promise<
  | { ok: true; plan: PlanRecord; merge: Awaited<ReturnType<typeof mergePhaseBranches>> }
  | { ok: false; error: LifecycleError }
> {
  const integrationBranch = args.integrationBranch.trim();
  if (!integrationBranch || !BRANCH_RE.test(integrationBranch)) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "integration_branch must match [a-zA-Z0-9._-/]+",
      },
    };
  }
  if (FORBIDDEN_INTEGRATION_BRANCHES.has(integrationBranch.toLowerCase())) {
    return {
      ok: false,
      error: {
        code: "forbidden_branch",
        message: `integration_branch "${integrationBranch}" is protected — pick a feature branch (e.g. integration/<plan-slug>) and open a PR from it instead`,
      },
    };
  }

  const plan = await findPlanById(args.planId);
  if (!plan) {
    return {
      ok: false,
      error: { code: "not_found", message: `plan ${args.planId} not found` },
    };
  }
  if (plan.status !== "approved") {
    return {
      ok: false,
      error: { code: "not_approved", message: "plan is not approved yet" },
    };
  }
  if (!plan.worktrees || plan.worktrees.length === 0) {
    return {
      ok: false,
      error: { code: "no_worktrees", message: "plan has no worktrees recorded" },
    };
  }

  const sessionsBySlug = new Map<string, PhaseSession>(
    (plan.phase_sessions ?? []).map((p) => [p.phase_slug, p]),
  );
  const ineligible: string[] = [];
  for (const phase of plan.phases) {
    const status = sessionsBySlug.get(phase.slug)?.commit_status;
    if (status !== "clean" && status !== "committed") {
      ineligible.push(phase.slug);
    }
  }
  if (ineligible.length > 0) {
    return {
      ok: false,
      error: {
        code: "ineligible_phases",
        message: `not all phases committed: ${ineligible.join(", ")}`,
        details: { ineligible },
      },
    };
  }

  // Scope-violation gate. Phases that wrote files outside their
  // declared `phase.scope.files` glob set `scope_violations` at
  // /complete time. We block the merge until the caller explicitly
  // acknowledges each offending phase via `acknowledgeScopeViolations`
  // — that way the leader can't merge a wave of phases without
  // surfacing scope creep first. Phases with no declared scope or
  // empty violations are unaffected.
  const acknowledged = new Set(args.acknowledgeScopeViolations ?? []);
  const unacknowledged: Array<{ phase_slug: string; files: string[] }> = [];
  for (const link of plan.phase_sessions ?? []) {
    if (!link.scope_violations || link.scope_violations.length === 0) continue;
    if (acknowledged.has(link.phase_slug)) continue;
    unacknowledged.push({
      phase_slug: link.phase_slug,
      files: link.scope_violations,
    });
  }
  if (unacknowledged.length > 0) {
    return {
      ok: false,
      error: {
        code: "scope_violations",
        message: `${unacknowledged.length} phase(s) have unacknowledged scope_violations: ${unacknowledged.map((u) => u.phase_slug).join(", ")}. Inspect the diffs (e.g. mcp__leader__read_phase_diff), then re-run merge with these slugs in acknowledge_scope_violations to proceed.`,
        details: { unacknowledged },
      },
    };
  }

  const phaseBranches = plan.worktrees.map((wt) => ({
    phase_slug: wt.phase_slug,
    branch: wt.branch,
  }));
  const result = await mergePhaseBranches({
    repoPath: plan.cwd,
    integrationBranch,
    phases: phaseBranches,
  });

  const mergedAt = new Date().toISOString();
  const updated = await updatePlan(plan.cwd, plan.id, (p) => {
    p.merge_branch = integrationBranch;
    p.merge_results = result.results.map(
      (r): PhaseMergeResult => ({
        phase_slug: r.phase_slug,
        branch: r.branch,
        status: r.status,
        sha: r.sha,
        error: r.error,
      }),
    );
    p.merge_base_sha = result.base_sha;
    p.merge_head_sha = result.head_sha;
    p.merged_at = mergedAt;
    delete p.integration_review_status;
    delete p.integration_review_started_at;
    delete p.integration_review_completed_at;
    delete p.integration_review_summary;
    delete p.integration_review_findings;
    delete p.integration_review_error;
    delete p.integration_review_base;
    delete p.integration_review_head;
    delete p.integration_review_branch;
    if (result.error) p.merge_error = result.error;
    else delete p.merge_error;
    if (result.status === "ok" && result.results.length > 0) {
      p.merge_status = "merged";
    } else if (result.status === "failed" && result.results.length === 0) {
      p.merge_status = "failed";
    } else {
      p.merge_status = "pending";
    }
  });

  return { ok: true, plan: updated, merge: result };
}

// runIntegrationReviewForPlan starts the cumulative-diff reviewer
// without waiting for it to finish. Returns the updated plan record
// (status flipped to "running") plus a flag if a prior review was
// still in flight (we no-op rather than spawning a duplicate).
export async function runIntegrationReviewForPlan(args: {
  planId: string;
}): Promise<
  | { ok: true; plan: PlanRecord; alreadyRunning?: boolean }
  | { ok: false; error: LifecycleError }
> {
  const plan = await findPlanById(args.planId);
  if (!plan) {
    return {
      ok: false,
      error: { code: "not_found", message: `plan ${args.planId} not found` },
    };
  }
  if (plan.status !== "approved") {
    return { ok: false, error: { code: "not_approved", message: "plan is not approved yet" } };
  }
  if (plan.merge_status !== "merged") {
    return {
      ok: false,
      error: {
        code: "merge_not_done",
        message: "integration review requires a fully-merged plan",
      },
    };
  }
  if (!plan.merge_branch) {
    return {
      ok: false,
      error: { code: "missing_merge_branch", message: "plan has no merge_branch recorded" },
    };
  }
  if (!plan.merge_base_sha) {
    return {
      ok: false,
      error: {
        code: "missing_merge_base",
        message: "plan has no merge_base_sha — re-run /merge to capture diff range",
      },
    };
  }
  const phaseSession = plan.phase_sessions?.[0];
  if (!phaseSession) {
    return {
      ok: false,
      error: { code: "no_phase_sessions", message: "plan has no phase_sessions" },
    };
  }
  if (isIntegrationReviewInFlight(args.planId)) {
    return { ok: true, plan, alreadyRunning: true };
  }

  const startedAt = new Date().toISOString();
  const headSha =
    (await resolveIntegrationHead(plan.cwd, plan.merge_branch)) ??
    plan.merge_head_sha;
  const updated = await persistIntegrationReviewRunning({
    planId: args.planId,
    startedAt,
    baseSha: plan.merge_base_sha,
    headSha,
    integrationBranch: plan.merge_branch,
  });
  if (!updated) {
    return {
      ok: false,
      error: { code: "not_found", message: "plan disappeared between read and persist" },
    };
  }

  const inheritedModel = plan.phases.find((p) => p.model)?.model;
  const inheritedEffort = plan.phases.find((p) => p.effort)?.effort;
  void runIntegrationReview({
    planId: args.planId,
    repoPath: plan.cwd,
    configDir: phaseSession.config_dir,
    integrationBranch: plan.merge_branch,
    baseSha: plan.merge_base_sha,
    headSha,
    planTitle: plan.title,
    phases: plan.phases,
    model: inheritedModel,
    effort: inheritedEffort as EffortLevel | undefined,
  }).catch((err) => {
    console.error(
      `[plan-lifecycle] runIntegrationReview ${args.planId} crashed outside guarded path:`,
      err,
    );
  });

  return { ok: true, plan: updated };
}

// cleanupPlanWorktrees deletes worktree directories AND the
// `wo/<plan>/<slug>` phase branches. Destructive: there is no
// soft-delete here, so callers (the MCP tool, eventually a UI button)
// MUST gate it behind the user's explicit consent. The plan record
// itself stays on disk so the cumulative state (commits, reviews,
// notes) remains inspectable post-tear-down.
//
// We tolerate per-worktree failures — one missing branch should NOT
// abort the rest. Returns the per-worktree outcome so callers can
// surface a granular report.
export interface CleanupOutcome {
  phase_slug: string;
  worktree_path: string;
  branch: string;
  worktree_removed: "removed" | "missing" | { error: string };
  branch_deleted: "deleted" | "missing" | { error: string };
}

export async function cleanupPlanWorktrees(args: {
  planId: string;
}): Promise<
  | { ok: true; plan: PlanRecord; outcomes: CleanupOutcome[] }
  | { ok: false; error: LifecycleError }
> {
  const plan = await findPlanById(args.planId);
  if (!plan) {
    return {
      ok: false,
      error: { code: "not_found", message: `plan ${args.planId} not found` },
    };
  }
  if (plan.merge_status !== "merged") {
    return {
      ok: false,
      error: {
        code: "merge_not_done",
        message:
          "refusing to cleanup before merge_status === 'merged' — phase work would be lost",
      },
    };
  }

  const outcomes: CleanupOutcome[] = [];
  for (const wt of plan.worktrees ?? []) {
    const outcome: CleanupOutcome = {
      phase_slug: wt.phase_slug,
      worktree_path: wt.path,
      branch: wt.branch,
      worktree_removed: "missing",
      branch_deleted: "missing",
    };

    // Step 1: prune worktree registration via `git worktree remove --force`
    // on the parent repo so git's metadata doesn't accumulate stale entries.
    // If the directory is already gone we still try git's prune to clean
    // metadata; either way fall through to rm-rf for the directory.
    try {
      await exec("git", ["-C", plan.cwd, "worktree", "remove", "--force", wt.path]);
      outcome.worktree_removed = "removed";
    } catch (err) {
      // Worktree might not be registered (manual rm earlier) — fall back to
      // a direct rm-rf. Only mark error if the directory still exists after.
      try {
        await fs.rm(wt.path, { recursive: true, force: true });
        outcome.worktree_removed = "removed";
      } catch (rmErr) {
        outcome.worktree_removed = {
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
        };
      }
      void err; // first error is best-effort; the rm result is authoritative.
    }

    // Step 2: delete the phase branch on the parent repo. -D is force-delete
    // (the branch is merged into integration but git is conservative —
    // -d would warn about not being on the integration branch).
    try {
      await exec("git", ["-C", plan.cwd, "branch", "-D", wt.branch]);
      outcome.branch_deleted = "deleted";
    } catch (err) {
      const stderr = (err as Error & { stderr?: string }).stderr ?? "";
      if (stderr.includes("not found")) {
        outcome.branch_deleted = "missing";
      } else {
        outcome.branch_deleted = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    outcomes.push(outcome);
  }

  // Worktrees + branches are torn down but plan.json stays so the
  // record (commit shas, review findings, notes) survives. Stamp
  // worktrees_cleaned_at so subsequent attempts can no-op gracefully.
  const updated = await updatePlan(plan.cwd, plan.id, (p) => {
    p.worktrees_cleaned_at = new Date().toISOString();
  });

  return { ok: true, plan: updated, outcomes };
}

// archivePlan flips a UI-side flag so the sidebar/plan list can hide
// finished plans. Reversible — pass `archive: false` to clear. No
// side effects on disk beyond a single timestamp on plan.json.
export async function archivePlan(args: {
  planId: string;
  archive: boolean;
}): Promise<
  | { ok: true; plan: PlanRecord }
  | { ok: false; error: LifecycleError }
> {
  const plan = await findPlanById(args.planId);
  if (!plan) {
    return {
      ok: false,
      error: { code: "not_found", message: `plan ${args.planId} not found` },
    };
  }
  const stamp = args.archive ? new Date().toISOString() : undefined;
  const updated = await updatePlan(plan.cwd, plan.id, (p) => {
    if (stamp) p.archived_at = stamp;
    else delete p.archived_at;
  });
  return { ok: true, plan: updated };
}
