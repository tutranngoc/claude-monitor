import "server-only";

import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AsyncQueue } from "./async-queue";
import { findClaudeBinary } from "./claude-binary";
import { findPlanById, updatePlan } from "./plans";
import {
  createReviewMcpServer,
  REVIEW_MCP_SERVER_NAME,
  SUBMIT_REVIEW_FQN,
  type ReviewSubmission,
} from "./review-mcp";
import type {
  Phase,
  PhaseSession,
  PlanRecord,
  ReviewFinding,
} from "@/lib/plan-types";

const exec = promisify(execFile);

// Track in-flight reviews so a double-clicked button doesn't spawn two
// agents reading the same diff. Key: `${planId}:${phaseSlug}`. Value:
// AbortController used to bound the run by timeout (and could be wired
// to a cancel button later).
const IN_FLIGHT_KEY = Symbol.for("claude-monitor.web.review-in-flight");
type InFlightGlobal = typeof globalThis & {
  [IN_FLIGHT_KEY]?: Map<string, AbortController>;
};
const ig = globalThis as InFlightGlobal;
const inFlight: Map<string, AbortController> = (ig[IN_FLIGHT_KEY] ??= new Map());

function inFlightKey(planId: string, slug: string): string {
  return `${planId}:${slug}`;
}

export function isReviewInFlight(planId: string, slug: string): boolean {
  return inFlight.has(inFlightKey(planId, slug));
}

// Bound a review run. Real diffs typically finish in 30s-3min; 10 min
// is a safety net for outlier cases (huge diff, model retrying through
// rate limits). After timeout we abort the SDK Query and mark failed.
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

// Read-only git subcommands the reviewing agent is allowed to run via
// Bash. Anything else gets denied so the agent can't accidentally
// mutate the worktree (no `git checkout`, no `git reset`, no scripts
// that happen to start with "git").
const GIT_READONLY_PREFIXES = [
  "git diff",
  "git log",
  "git show",
  "git status",
  "git rev-parse",
  "git rev-list",
  "git branch",
  "git ls-files",
  "git blame",
  "git cat-file",
];

function isReadonlyGit(cmd: string): boolean {
  const trimmed = cmd.trim();
  for (const prefix of GIT_READONLY_PREFIXES) {
    if (trimmed === prefix) return true;
    if (trimmed.startsWith(prefix + " ")) return true;
  }
  return false;
}

interface RunPhaseReviewOpts {
  planId: string;
  phaseSlug: string;
  // Forwarded to query() — keep the review on the same OAuth account
  // that ran the phase so quota accounting stays consistent. Caller
  // (the route) is responsible for resolving the right config_dir
  // from the plan's PhaseSession.
  configDir: string;
  worktreePath: string;
  // Diff base. Typically `plan.merge_branch ?? "main"` — same default
  // the scope check uses. Stored on the review record so the user can
  // re-run the same comparison later.
  baseBranch: string;
  // Inherited owner-session model/effort. Reviews are read-heavy and
  // benefit from a strong model — caller can override but defaults
  // upstream pick a sensible value.
  model?: string;
  effort?: EffortLevel;
  // Phase metadata for the kickoff prompt. Lets the reviewing agent
  // anchor its commentary to "what was this phase trying to do" rather
  // than reasoning purely from the diff.
  phase: Phase;
  // Resolved at queue time so the kickoff prompt can name the actual
  // base sha (vs just the branch name). Falls back to baseBranch text
  // when merge-base resolution fails.
  baseSha?: string;
  // Resolved HEAD at queue time. Recorded on the review record as
  // review_base so the user can replay the same diff later.
  headSha?: string;
}

// runPhaseReview spawns a one-shot SDK query in the phase worktree,
// asks it to review `<base>..HEAD`, and persists the agent's findings
// onto plan.phase_sessions[i].review_*. Fire-and-forget from the
// route's perspective — returns immediately and runs to completion in
// the background, with disk writes handling persistence so the UI can
// poll /api/plans/<id> for updates.
//
// Failure modes:
//   - spawn throws         → review_status: "failed", review_error set
//   - timeout fires        → SDK aborted, review_status: "failed"
//   - iterator exhausts
//     without submit_review → review_status: "failed", "agent did not
//                              submit a review"
//   - submit_review fires  → review_status: "complete", findings persisted
export async function runPhaseReview(opts: RunPhaseReviewOpts): Promise<void> {
  const key = inFlightKey(opts.planId, opts.phaseSlug);
  if (inFlight.has(key)) {
    // Caller should have checked isReviewInFlight first; defensive
    // re-check guards against a race between two POSTs.
    return;
  }
  const abortController = new AbortController();
  inFlight.set(key, abortController);

  let submitted: ReviewSubmission | null = null;
  let errorMessage: string | undefined;
  const startedAt = new Date().toISOString();

  try {
    // Build the kickoff prompt up-front so the AsyncQueue can be
    // pre-loaded with a single user message and immediately closed —
    // we don't accept follow-up turns from the user, this is a
    // one-shot batch.
    const baseRef = opts.baseSha ?? opts.baseBranch;
    const kickoff = buildReviewPrompt({
      phase: opts.phase,
      baseRef,
      baseBranch: opts.baseBranch,
    });
    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const userMsg: SDKUserMessage = {
      type: "user",
      uuid: randomUUID() as SDKUserMessage["uuid"],
      session_id: randomUUID() as SDKUserMessage["session_id"],
      message: { role: "user", content: kickoff },
      parent_tool_use_id: null,
    };
    inputQueue.push(userMsg);
    inputQueue.end();

    const reviewMcp = createReviewMcpServer({
      onReviewSubmitted: (submission) => {
        // First call wins. The agent occasionally double-fires when it
        // retries — we surface the first one to the UI and ignore the
        // rest so finding lists don't churn.
        if (submitted) return;
        submitted = submission;
        // Persist eagerly so the UI's poll picks it up before the
        // iterator drains.
        void persistComplete({
          planId: opts.planId,
          phaseSlug: opts.phaseSlug,
          submission,
          startedAt,
          headSha: opts.headSha,
        });
      },
    });

    const claudeBin = findClaudeBinary();

    // Permission policy for the reviewer:
    //   submit_review → auto-allow (no UI to dialog through anyway).
    //   Read/Glob/Grep → auto-allow (read-only, scoped to cwd).
    //   Bash → allow only the read-only git subcommand prefixes above.
    //          Everything else (npm/pnpm/sed/find/curl/...) is denied
    //          so the review session can't mutate the worktree even
    //          if the model gets creative.
    //   Edit/Write/NotebookEdit/Agent → denied via no allowedTools
    //          path (we set canUseTool to deny by default).
    const canUseTool: CanUseTool = (toolName, input) => {
      if (toolName === SUBMIT_REVIEW_FQN) {
        return Promise.resolve<PermissionResult>({
          behavior: "allow",
          updatedInput: input,
        });
      }
      if (
        toolName === "Read" ||
        toolName === "Glob" ||
        toolName === "Grep"
      ) {
        return Promise.resolve<PermissionResult>({
          behavior: "allow",
          updatedInput: input,
        });
      }
      if (toolName === "Bash") {
        const cmd = (input as { command?: string }).command;
        if (typeof cmd === "string" && isReadonlyGit(cmd)) {
          return Promise.resolve<PermissionResult>({
            behavior: "allow",
            updatedInput: input,
          });
        }
        return Promise.resolve<PermissionResult>({
          behavior: "deny",
          message:
            "review agent may only run read-only git subcommands (diff/log/show/status/...).",
        });
      }
      return Promise.resolve<PermissionResult>({
        behavior: "deny",
        message: `tool '${toolName}' is not available during code review`,
      });
    };

    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, REVIEW_TIMEOUT_MS);

    let q: ReturnType<typeof query>;
    try {
      q = query({
        prompt: inputQueue,
        options: {
          cwd: opts.worktreePath,
          env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
          ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
          // We control allow/deny entirely via canUseTool; default mode
          // means the SDK consults canUseTool for every tool. The
          // reviewer must NEVER auto-accept edits, so don't hand it
          // acceptEdits or bypassPermissions modes.
          permissionMode: "default",
          canUseTool,
          mcpServers: { [REVIEW_MCP_SERVER_NAME]: reviewMcp },
          abortController,
          // Fresh session id per review — these reviews are not
          // surfaced in the chat sidebar (we don't register them in
          // the sessions module-scoped Map), so collisions don't
          // matter, but a unique id keeps the SDK's on-disk transcript
          // distinguishable.
          sessionId: randomUUID(),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }

    try {
      // Drain the iterator without inspecting messages — submit_review
      // fires its callback inline when the agent invokes it, and we
      // treat the iterator drain as "agent finished its turn(s)". A
      // successful call before the iterator ends → review is complete;
      // a clean drain without a call → mark failed below.
      for await (const _ of q) {
        void _;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!submitted) {
      const aborted = abortController.signal.aborted;
      errorMessage = aborted
        ? "review timed out before the agent submitted findings"
        : "agent finished its turn without calling submit_review";
    }
  } catch (err) {
    errorMessage =
      err instanceof Error ? err.message : String(err ?? "unknown error");
  } finally {
    inFlight.delete(key);
  }

  if (!submitted && errorMessage) {
    await persistFailed({
      planId: opts.planId,
      phaseSlug: opts.phaseSlug,
      error: errorMessage,
      startedAt,
      headSha: opts.headSha,
    });
  }
}

// resolveBase + resolveHead front-load the merge-base + HEAD lookups
// so the kickoff prompt can name a concrete sha and the review record
// can store an immutable reference. Both are best-effort: a missing
// merge-base falls back to the branch name; a missing HEAD just leaves
// review_base undefined.
export async function resolveBase(
  worktreePath: string,
  baseBranch: string,
): Promise<{ baseSha?: string; headSha?: string }> {
  let baseSha: string | undefined;
  let headSha: string | undefined;
  try {
    const { stdout } = await exec("git", [
      "-C",
      worktreePath,
      "merge-base",
      "HEAD",
      baseBranch,
    ]);
    const v = stdout.trim();
    if (v.length > 0) baseSha = v;
  } catch {
    // unrelated histories or missing branch — skip; reviewer will read
    // whatever it can via `git log`.
  }
  try {
    const { stdout } = await exec("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
    const v = stdout.trim();
    if (v.length > 0) headSha = v;
  } catch {
    // ignore
  }
  return { baseSha, headSha };
}

interface PersistCompleteOpts {
  planId: string;
  phaseSlug: string;
  submission: ReviewSubmission;
  startedAt: string;
  headSha?: string;
}

async function persistComplete(opts: PersistCompleteOpts): Promise<void> {
  const plan = await findPlanById(opts.planId);
  if (!plan) return;
  await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    if (!p.phase_sessions) return;
    const idx = p.phase_sessions.findIndex(
      (e: PhaseSession) => e.phase_slug === opts.phaseSlug,
    );
    if (idx < 0) return;
    const next: PhaseSession = { ...p.phase_sessions[idx] };
    next.review_status = "complete";
    next.review_started_at = opts.startedAt;
    next.review_completed_at = new Date().toISOString();
    next.review_summary = opts.submission.summary;
    next.review_findings = opts.submission.findings;
    if (opts.headSha) next.review_base = opts.headSha;
    delete next.review_error;
    p.phase_sessions[idx] = next;
  });
}

interface PersistFailedOpts {
  planId: string;
  phaseSlug: string;
  error: string;
  startedAt: string;
  headSha?: string;
}

async function persistFailed(opts: PersistFailedOpts): Promise<void> {
  const plan = await findPlanById(opts.planId);
  if (!plan) return;
  await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    if (!p.phase_sessions) return;
    const idx = p.phase_sessions.findIndex(
      (e: PhaseSession) => e.phase_slug === opts.phaseSlug,
    );
    if (idx < 0) return;
    const next: PhaseSession = { ...p.phase_sessions[idx] };
    next.review_status = "failed";
    next.review_started_at = opts.startedAt;
    next.review_completed_at = new Date().toISOString();
    next.review_error = opts.error;
    if (opts.headSha) next.review_base = opts.headSha;
    p.phase_sessions[idx] = next;
  });
}

// persistRunning records the "I started a review" state on disk so the
// route can return an updated plan with review_status: "running"
// before kicking off the (potentially long) agent run. Exported so the
// route can `await` it before responding.
export async function persistRunning(opts: {
  planId: string;
  phaseSlug: string;
  startedAt: string;
}): Promise<PlanRecord | null> {
  const plan = await findPlanById(opts.planId);
  if (!plan) return null;
  return updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    if (!p.phase_sessions) return;
    const idx = p.phase_sessions.findIndex(
      (e: PhaseSession) => e.phase_slug === opts.phaseSlug,
    );
    if (idx < 0) return;
    const next: PhaseSession = { ...p.phase_sessions[idx] };
    next.review_status = "running";
    next.review_started_at = opts.startedAt;
    // Stale fields from a previous run get cleared so the UI doesn't
    // mix old findings into the new run.
    delete next.review_completed_at;
    delete next.review_summary;
    delete next.review_findings;
    delete next.review_error;
    delete next.review_base;
    p.phase_sessions[idx] = next;
  });
}

interface BuildReviewPromptOpts {
  phase: Phase;
  baseRef: string;
  baseBranch: string;
}

function buildReviewPrompt(opts: BuildReviewPromptOpts): string {
  const { phase, baseRef, baseBranch } = opts;
  const lines: string[] = [];
  lines.push(
    `You are reviewing the diff for a single phase of a multi-phase plan.`,
  );
  lines.push(``);
  lines.push(`## Phase`);
  lines.push(`- slug: ${phase.slug}`);
  lines.push(`- title: ${phase.title}`);
  lines.push(``);
  lines.push(`### Description`);
  lines.push(phase.description);
  if (phase.scope?.files && phase.scope.files.length > 0) {
    lines.push(``);
    lines.push(`### Declared file scope`);
    for (const g of phase.scope.files) lines.push(`- \`${g}\``);
  }
  lines.push(``);
  lines.push(`## Your job`);
  lines.push(
    `Review the diff between \`${baseRef}\` (${baseBranch}) and HEAD in the current worktree. Report findings via the \`submit_review\` tool.`,
  );
  lines.push(``);
  lines.push(`## Steps`);
  lines.push(`1. Run \`git diff --stat ${baseRef}..HEAD\` to see the file list and size.`);
  lines.push(
    `2. Run \`git diff ${baseRef}..HEAD\` (or \`git diff ${baseRef}..HEAD -- <path>\` for very large diffs) to read the patch.`,
  );
  lines.push(
    `3. Use \`Read\` for surrounding context when a hunk's correctness depends on the rest of the file.`,
  );
  lines.push(
    `4. Identify bugs, security/safety issues, correctness problems, missing tests, perf concerns, maintainability nits. **Focus on the diff.** Don't comment on pre-existing code unrelated to this change.`,
  );
  lines.push(
    `5. Call \`submit_review\` exactly once with a 1-3 sentence \`summary\` and a list of \`findings\`. If the diff looks clean, pass an empty findings array and say so in the summary.`,
  );
  lines.push(``);
  lines.push(`## Severity`);
  lines.push(`- \`error\` — bug, security issue, breakage that should block the change`);
  lines.push(`- \`warning\` — correctness concern or non-trivial maintainability issue`);
  lines.push(`- \`info\` — nit, style note, or aside the author should know about`);
  lines.push(``);
  lines.push(`## Constraints`);
  lines.push(`- Do **not** modify files. \`Edit\`, \`Write\`, and \`NotebookEdit\` are unavailable.`);
  lines.push(`- Bash is restricted to read-only git subcommands.`);
  lines.push(`- Be specific. Cite \`file\` and \`line\` whenever the finding is local to a hunk.`);
  return lines.join("\n");
}

// Export for tests / introspection (not consumed by routes today).
export type { ReviewFinding };
