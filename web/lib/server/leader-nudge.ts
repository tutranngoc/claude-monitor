import "server-only";

import { findPlanById } from "@/lib/server/plans";
import { sendMessage, snapshotSession } from "@/lib/server/sessions";

// Wakes the owner/leader chat by enqueuing a user-message into its
// session input queue. Used when human-driven UI actions (clicking
// /complete, /merge, etc.) hit a milestone the leader should react to:
// the human is editing-by-hand instead of asking the leader, but the
// leader still wants the prompt so it can drive the next step (run
// integration review, decide on cleanup, archive, etc).
//
// Best-effort. Failure paths and what we do:
//   - Plan not found on disk          → no-op + log
//   - Owner session id missing        → no-op + log
//   - sendMessage throws              → swallow + log
//   - Owner session is closed/errored → swallow + log
// We never bubble the failure up to the route caller; nudge is a
// convenience, not a contract.
export async function nudgeLeader(args: {
  planId: string;
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
  if (!ownerId) {
    return { delivered: false, reason: "plan has no session_id" };
  }
  // snapshotSession resolves both live and disk-only sessions. An
  // interrupted (disk-only) session can still receive sendMessage
  // because getOrResume reanimates on demand. A truly closed session
  // (deleted from disk) returns undefined and we skip rather than
  // throw — the user closed it intentionally.
  const snap = snapshotSession(ownerId);
  if (!snap) {
    return { delivered: false, reason: "owner session not found" };
  }
  if (snap.summary.status === "closed" || snap.summary.status === "errored") {
    return {
      delivered: false,
      reason: `owner session is ${snap.summary.status}`,
    };
  }
  try {
    sendMessage(ownerId, args.message);
    return { delivered: true };
  } catch (err) {
    console.warn(
      `[leader-nudge] sendMessage to ${ownerId} for plan ${args.planId} failed:`,
      err,
    );
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Convenience: build a milestone-specific nudge message. Each one ends
// with a steer-the-leader hint so the agent doesn't have to figure out
// what action the milestone implies. Read-state-first phrasing keeps
// the leader from blindly merging if it has stale context.
export function buildAllCommittedNudge(planTitle: string): string {
  return [
    `Plan _"${planTitle}"_ — every phase has reached a terminal commit_status.`,
    "",
    "Decide whether to merge: call `mcp__leader__read_plan_state` to confirm scope/review state, then `mcp__leader__merge_plan` (default branch \"main\") if you're satisfied. If a phase is `failed` or has scope_violations you care about, surface the issue first instead of merging.",
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
    "Run `mcp__leader__run_integration_review` to read the cumulative diff and surface cross-phase issues. Once you've read the findings, you can `mcp__leader__cleanup_worktrees` and `mcp__leader__archive_plan` to close the plan out — but only after confirming the integration branch has been pushed (cleanup deletes local refs).",
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
