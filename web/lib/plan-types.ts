// Plan workflow wire types — shared between server (submit_plan MCP tool,
// approve route, plan persistence) and client (PlanCard component, chat
// reducer). Plans live on disk under
// ~/.claude/projects/<encoded-cwd>/plans/<plan-id>.json mirroring Claude
// CLI's session storage convention.

import type { Effort } from "./chat-types";

export interface Phase {
  slug: string;
  title: string;
  description: string;
  depends_on?: string[];
  // Per-phase agent runtime overrides. When unset, the approve route
  // inherits the owner session's value — i.e. "spawn the same way the
  // user is currently configured." Override exists so the user can run
  // a heavy-thinking phase on Opus while a boilerplate phase stays on
  // Haiku, or escalate effort just for one tricky slice.
  //   model     SDK model id ("claude-opus-4-7", "claude-sonnet-4-6", ...)
  //   effort    extended-thinking budget (low | medium | high | xhigh | max)
  //   tdd_mode  when true, kickoff prompt instructs the agent to write
  //             failing tests first, surface them, then implement until
  //             they pass — a lightweight TDD discipline driven entirely
  //             by the prompt (no scheduler change).
  model?: string;
  effort?: Effort;
  tdd_mode?: boolean;
}

// PhaseOverride is the wire shape for per-phase edits the user makes in
// PlanCard before clicking Approve. Only fields the user actually
// changed are present; the approve route merges them into the plan
// record on disk before spawning so the persisted plan reflects what
// actually ran.
export interface PhaseOverride {
  model?: string;
  effort?: Effort;
  tdd_mode?: boolean;
}

export type PhaseOverrides = Record<string, PhaseOverride>;

export interface WorktreeInfo {
  phase_slug: string;
  path: string;
  branch: string;
}

// PhaseSession links a phase to the chat session that's executing it.
// One session per phase, spawned by the approve route after worktrees
// are created. Persisted on the plan so the UI can rebuild the link
// after a reload (chat sessions live in-memory; plans live on disk).
//
// Commit fields are populated when the user marks the phase complete
// via POST /api/plans/<id>/phases/<slug>/complete:
//   clean      → worktree had no uncommitted changes; we did nothing
//   committed  → ran `git add -A && git commit`; commit_sha is the new HEAD
//   failed     → tried to commit but git errored; commit_error has stderr
// Once any of these is set the row freezes its commit badge and won't
// re-attempt without explicit user action.
export type PhaseCommitStatus = "clean" | "committed" | "failed";

export interface PhaseSession {
  phase_slug: string;
  session_id: string;
  config_dir: string;
  account_name?: string;
  spawned_at: string;
  commit_status?: PhaseCommitStatus;
  commit_sha?: string;
  committed_at?: string;
  commit_error?: string;
}

export type PlanStatus = "submitted" | "approved" | "failed";

// PlanMergeStatus tracks the outcome of POST /api/plans/<id>/merge,
// which folds every wo/<plan>/<slug> phase branch into an integration
// branch (default main) on plan.cwd. Per-phase outcomes live on
// `merge_results` so the UI can show granularity (e.g. "3 merged, 1
// skipped, 1 failed"). Set on the plan in addition to PlanStatus —
// merge runs after `status === "approved"`, never replaces it.
//   pending  → at least one merge run was attempted but had failures;
//              the user can edit + retry without re-approving the plan
//   merged   → all phases reachable from integration HEAD
//   failed   → top-level abort (dirty tree, missing branch, etc.) with
//              no per-phase progress
export type PlanMergeStatus = "pending" | "merged" | "failed";

export interface PhaseMergeResult {
  phase_slug: string;
  branch: string;
  status: "merged" | "skipped" | "failed";
  sha?: string;
  error?: string;
}

export interface PlanRecord {
  id: string;
  session_id: string;
  cwd: string;
  title: string;
  phases: Phase[];
  status: PlanStatus;
  created_at: string;
  approved_at?: string;
  worktrees?: WorktreeInfo[];
  phase_sessions?: PhaseSession[];
  error?: string;
  merge_status?: PlanMergeStatus;
  merge_branch?: string;
  merge_results?: PhaseMergeResult[];
  merge_head_sha?: string;
  merged_at?: string;
  merge_error?: string;
}
