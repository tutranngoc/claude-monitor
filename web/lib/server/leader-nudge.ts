import "server-only";

import type { NudgeMilestone } from "@/lib/plan-types";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import { sendMessage, snapshotSession } from "@/lib/server/sessions";

// Wakes the owner/leader chat by enqueuing a user-message into its
// session input queue. Used when human-driven UI actions (clicking
// /complete, /merge, etc.) hit a milestone the leader should react to:
// the human is editing-by-hand instead of asking the leader, but the
// leader still wants the prompt so it can drive the next step (run
// integration review, decide on cleanup, archive, etc).
//
// Best-effort delivery, but the result is always persisted to
// `plan.last_nudge` so the UI can surface a banner when the leader is
// unreachable ("open a fresh chat and run mcp__leader__adopt_plan").
// Without that the plan silently stalls and the user has no signal.
//
// Failure paths and what we do:
//   - Plan not found on disk          → return false, no persist (nothing to write to)
//   - Owner session id missing        → persist + return false
//   - Owner session is closed/errored → persist + return false
//   - sendMessage throws              → persist + return false
export async function nudgeLeader(args: {
  planId: string;
  milestone: NudgeMilestone;
  message: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  const plan = await findPlanById(args.planId);
  if (!plan) {
    return { delivered: false, reason: "plan not found" };
  }
  // Reassignable: a fresh chat that adopted the plan via
  // mcp__leader__adopt_plan becomes the leader by setting
  // leader_session_id. Falls back to the original submit_plan owner
  // when no adoption happened.
  const ownerId = plan.leader_session_id ?? plan.session_id;
  let result: { delivered: boolean; reason?: string };
  if (!ownerId) {
    result = { delivered: false, reason: "plan has no session_id" };
  } else {
    // snapshotSession resolves both live and disk-only sessions. An
    // interrupted (disk-only) session can still receive sendMessage
    // because getOrResume reanimates on demand. A truly closed session
    // (deleted from disk) returns undefined and we skip rather than
    // throw — the user closed it intentionally.
    const snap = snapshotSession(ownerId);
    if (!snap) {
      result = { delivered: false, reason: "owner session not found" };
    } else if (
      snap.summary.status === "closed" ||
      snap.summary.status === "errored"
    ) {
      result = {
        delivered: false,
        reason: `owner session is ${snap.summary.status}`,
      };
    } else {
      try {
        sendMessage(ownerId, args.message);
        result = { delivered: true };
      } catch (err) {
        console.warn(
          `[leader-nudge] sendMessage to ${ownerId} for plan ${args.planId} failed:`,
          err,
        );
        result = {
          delivered: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  try {
    await updatePlan(plan.cwd, plan.id, (p) => {
      p.last_nudge = {
        milestone: args.milestone,
        delivered: result.delivered,
        reason: result.reason,
        at: new Date().toISOString(),
      };
    });
  } catch (err) {
    // Persistence is best-effort too: if the plan disappeared between
    // our read and write we don't escalate — the route caller still
    // gets the in-memory result.
    console.warn(
      `[leader-nudge] persist last_nudge for plan ${args.planId} failed:`,
      err,
    );
  }
  return result;
}

// Convenience: build a milestone-specific nudge message. Each one ends
// with a steer-the-leader hint so the agent doesn't have to figure out
// what action the milestone implies. Read-state-first phrasing keeps
// the leader from blindly merging if it has stale context.
export function buildAllCommittedNudge(planTitle: string): string {
  return [
    `Plan _"${planTitle}"_ — every phase has reached a terminal commit_status.`,
    "",
    "Decide whether to merge: call `mcp__leader__read_plan_state` to confirm scope/review state, then `mcp__leader__merge_plan` if you're satisfied. If a phase is `failed`, surface the issue first instead of merging.",
    "",
    "**Scope violations now block merge.** Any phase with `scope_violations.length > 0` must be inspected (e.g. `mcp__leader__read_phase_diff`) and explicitly acknowledged via `merge_plan(acknowledge_scope_violations: [<slug>, ...])` — per-slug, not blanket. Phases without violations don't need entries. Without acknowledgment the merge aborts with `code: \"scope_violations\"` and a list of offenders.",
    "",
    "**Never merge into `main` / `master`** — the server rejects protected trunks. Pick a fresh feature branch (e.g. `integration/<plan-slug>`) for `integration_branch`, then push it and open a PR with `gh pr create --base main --head <branch>` once the merge lands. The PR is the only path into trunk.",
  ].join("\n");
}

export function buildMergedNudge(args: {
  planTitle: string;
  branch: string;
  headSha?: string;
}): string {
  const head = args.headSha ? ` (head ${args.headSha.slice(0, 7)})` : "";
  return [
    `Plan _"${args.planTitle}"_ merged into \`${args.branch}\`${head}.`,
    "",
    `Next steps, in order:`,
    `1. \`git push -u origin ${args.branch}\` to publish the integration branch.`,
    `2. \`gh pr create --base main --head ${args.branch}\` (adjust base if the repo's trunk is named differently) — fill in title/body summarizing the merged phases.`,
    `3. \`mcp__leader__run_integration_review\` to surface cumulative cross-phase issues; paste relevant findings into the PR.`,
    `4. Once the PR is open and pushed, \`mcp__leader__cleanup_worktrees\` then \`mcp__leader__archive_plan\` to close the plan out.`,
    "",
    "Do not skip the PR step — merging this branch back into trunk happens via PR review, never via the orchestrator.",
  ].join("\n");
}

export function buildIntegrationReviewDoneNudge(args: {
  planTitle: string;
  findingCount: number;
  summary?: string;
}): string {
  return [
    `Integration review complete for plan _"${args.planTitle}"_ — ${args.findingCount} finding(s).`,
    args.summary ? `\nSummary: ${args.summary}` : "",
    "",
    "Read the full findings via `mcp__leader__read_plan_state`. If the plan looks safe to close out, run `mcp__leader__cleanup_worktrees` (after the integration branch is pushed somewhere durable) and `mcp__leader__archive_plan`.",
  ]
    .filter(Boolean)
    .join("\n");
}
