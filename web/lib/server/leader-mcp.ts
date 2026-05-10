import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PhaseNote, PhaseSession, PlanRecord } from "@/lib/plan-types";
import type { SessionSummary } from "@/lib/chat-types";
import { classifyContextZone } from "@/lib/context-thresholds";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import {
  archivePlan,
  cleanupPlanWorktrees,
  runIntegrationReviewForPlan,
  runMergeForPlan,
} from "@/lib/server/plan-lifecycle";

const exec = promisify(execFile);

// MCP server name. Owner sessions see the tools as
//   mcp__leader__read_plan_state           (read)
//   mcp__leader__list_phase_notes          (read)
//   mcp__leader__read_phase_diff           (read)
//   mcp__leader__record_shared_context     (write: plan.shared_brief)
//   mcp__leader__merge_plan                (write: git + plan.merge_*)
//   mcp__leader__run_integration_review    (write: spawns reviewer agent)
//   mcp__leader__cleanup_worktrees         (DESTRUCTIVE: rm -rf + branch -D)
//   mcp__leader__archive_plan              (write: plan.archived_at)
// All except cleanup_worktrees are auto-allowed in canUseTool — the data
// is plan-scoped and the owner is the human-trusted session anyway.
// cleanup_worktrees gates through the user dialog because it deletes
// directories and branches; the leader proposes, the human confirms.
//
// "Leader" because the owner session that submit_plan'd is now the
// natural place to ask cross-phase questions: "what's blocking phase
// X?", "did B's API rename land?", "show me what auth/ touched today
// across phases". Phase agents have peer-broadcast notes; this is the
// other half — the planner can read every phase's progress without
// leaving its session.
export const LEADER_MCP_SERVER_NAME = "leader";
export const READ_PLAN_STATE_TOOL_NAME = "read_plan_state";
export const LEADER_LIST_NOTES_TOOL_NAME = "list_phase_notes";
export const READ_PHASE_DIFF_TOOL_NAME = "read_phase_diff";
export const RECORD_SHARED_CONTEXT_TOOL_NAME = "record_shared_context";
export const MERGE_PLAN_TOOL_NAME = "merge_plan";
export const RUN_INTEGRATION_REVIEW_TOOL_NAME = "run_integration_review";
export const CLEANUP_WORKTREES_TOOL_NAME = "cleanup_worktrees";
export const ARCHIVE_PLAN_TOOL_NAME = "archive_plan";
export const READ_PLAN_STATE_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${READ_PLAN_STATE_TOOL_NAME}`;
export const LEADER_LIST_NOTES_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${LEADER_LIST_NOTES_TOOL_NAME}`;
export const READ_PHASE_DIFF_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${READ_PHASE_DIFF_TOOL_NAME}`;
export const RECORD_SHARED_CONTEXT_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${RECORD_SHARED_CONTEXT_TOOL_NAME}`;
export const MERGE_PLAN_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${MERGE_PLAN_TOOL_NAME}`;
export const RUN_INTEGRATION_REVIEW_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${RUN_INTEGRATION_REVIEW_TOOL_NAME}`;
export const CLEANUP_WORKTREES_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${CLEANUP_WORKTREES_TOOL_NAME}`;
export const ARCHIVE_PLAN_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${ARCHIVE_PLAN_TOOL_NAME}`;

// Cap on shared_brief body. The brief is spliced into every phase's
// kickoff prompt, so a 50KB primer would multiply across phases. 8KB is
// roughly two screens of dense markdown — enough for architecture
// pointers, contracts, and gotchas, not enough to attempt a full
// CLAUDE.md replacement (that's what the user's CLAUDE.md is for).
const SHARED_BRIEF_BYTE_CAP = 8 * 1024;

export interface LeaderMcpContext {
  // Owner session id. Used purely for diagnostics today; reserved so
  // future tools can scope by ownership without the caller threading it.
  sessionId: string;
  // Resolves the plan_id when the caller omits it. Pulled from the
  // session's latestPlan at call time so the tool follows whatever
  // submit_plan most recently wrote — owners often run with one plan in
  // flight, and forcing them to thread plan_id through every tool call
  // would just be ceremony.
  resolveCurrentPlanId: () => string | undefined;
  // Snapshots a phase session's live status (thinking/idle/errored/
  // rate_limited/...). Wired to sessions.snapshotSession at call site
  // so we don't take a circular import on this module.
  snapshotPhaseSession: (sessionId: string) => SessionSummary | undefined;
}

// Cap on diff body. The SDK ships every tool result through the model
// context; a 5MB diff would torch the budget. 32KB covers most slice-
// sized phase diffs and gives the model a useful preview; for bigger
// changes the leader can call read_phase_diff with stat-only or ask
// the human to bring up the kanban view.
const DIFF_BYTE_CAP = 32 * 1024;

export function createLeaderMcpServer(ctx: LeaderMcpContext) {
  // resolvePlan — small helper used by all three tools to load the
  // plan record. Centralises the "explicit id wins, else fall back to
  // latestPlan" rule and the on-disk reload via findPlanById so the
  // leader always sees the current state, not a stale in-memory copy.
  async function resolvePlan(
    explicit: string | undefined,
  ): Promise<{ plan: PlanRecord } | { error: string }> {
    const planId = explicit ?? ctx.resolveCurrentPlanId();
    if (!planId) {
      return {
        error:
          "No plan_id provided and the owner session has not submitted a plan yet. Call submit_plan first or pass plan_id.",
      };
    }
    const plan = await findPlanById(planId);
    if (!plan) {
      return { error: `Plan ${planId} not found on disk.` };
    }
    return { plan };
  }

  const readPlanState = tool(
    READ_PLAN_STATE_TOOL_NAME,
    "Snapshot the full state of a plan: per-phase status (live SDK status + commit/scope/review badges), pending phases waiting on deps, merge state, integration-review findings, and notes counts. Use this when the user asks about progress, blockers, or wants a cross-phase summary. Read-only — does not affect any session or worktree.",
    {
      plan_id: z
        .string()
        .optional()
        .describe(
          "Plan id to snapshot. Defaults to the current owner session's latest submitted plan when omitted.",
        ),
    },
    async ({ plan_id }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const text = formatPlanState(r.plan, ctx.snapshotPhaseSession);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const listNotes = tool(
    LEADER_LIST_NOTES_TOOL_NAME,
    "List every phase note broadcast on a plan. Notes are siblings' inter-phase broadcasts (API renames, schema changes, contracts established). As the leader you read these to spot cross-phase coordination issues — e.g. phase A renamed something B and C still rely on. Filter by tag and dismissal state.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner session's latest plan."),
      tag: z
        .string()
        .optional()
        .describe(
          "Optional tag filter (case-insensitive). Common tags: 'api-change', 'schema', 'lib-swap', 'contract', 'gotcha'.",
        ),
      include_dismissed: z
        .boolean()
        .optional()
        .describe(
          "When true, include notes the human dismissed in the orchestrator UI. Default false — dismissed notes are usually already addressed.",
        ),
    },
    async ({ plan_id, tag, include_dismissed }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const text = formatNotes(r.plan, {
        tag: tag?.toLowerCase(),
        includeDismissed: !!include_dismissed,
      });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const readDiff = tool(
    READ_PHASE_DIFF_TOOL_NAME,
    "Show what a phase changed against an integration base. Returns `git diff --stat` plus a truncated unified diff (capped at 32KB) so the leader can spot conflicts and contract changes without leaving its session. Use this after a phase commits to see *what* the badge represents — diff against the merge_branch, fall back to 'main'.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner session's latest plan."),
      phase_slug: z
        .string()
        .min(1)
        .describe("Slug of the phase whose worktree to diff."),
      base: z
        .string()
        .optional()
        .describe(
          "Branch or ref to diff against. Defaults to plan.merge_branch ?? 'main'. Use 'HEAD~1' for the last commit only.",
        ),
      stat_only: z
        .boolean()
        .optional()
        .describe(
          "When true, return only the file/line summary (--stat) and skip the patch body. Use for very large diffs.",
        ),
    },
    async ({ plan_id, phase_slug, base, stat_only }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const worktree = r.plan.worktrees?.find(
        (w) => w.phase_slug === phase_slug,
      );
      if (!worktree) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Phase ${phase_slug} has no worktree on plan ${r.plan.id}.`,
            },
          ],
        };
      }
      const baseRef = base ?? r.plan.merge_branch ?? "main";
      const diffText = await readPhaseDiff(
        worktree.path,
        baseRef,
        !!stat_only,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# Phase \`${phase_slug}\` diff against \`${baseRef}\``,
              `Worktree: \`${worktree.path}\` · branch \`${worktree.branch}\``,
              "",
              diffText,
            ].join("\n"),
          },
        ],
      };
    },
  );

  const recordSharedContext = tool(
    RECORD_SHARED_CONTEXT_TOOL_NAME,
    "Write the plan-level shared brief. Every phase's kickoff prompt splices this in under 'Shared context', so use it for plan-specific anchors that would otherwise be retyped per phase: file paths, established conventions, contract shapes between phases, gotchas you have already discovered. This OVERWRITES any prior brief — read the current one via read_plan_state first if you mean to extend rather than replace. Phases already running do NOT see edits; only phases spawned after this call pick up the new brief. Cap: 8KB. Pass `body: \"\"` to clear.",
    {
      plan_id: z
        .string()
        .optional()
        .describe(
          "Plan id to write the brief on. Defaults to the owner session's latest submitted plan.",
        ),
      body: z
        .string()
        .max(SHARED_BRIEF_BYTE_CAP, {
          message: `body must be at most ${SHARED_BRIEF_BYTE_CAP} bytes`,
        })
        .describe(
          "Markdown body. Stays in plan.shared_brief on disk. Empty string clears the brief.",
        ),
    },
    async ({ plan_id, body }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const trimmed = body.trim();
      const updated = await updatePlan(r.plan.cwd, r.plan.id, (p) => {
        if (trimmed.length === 0) {
          delete p.shared_brief;
          delete p.shared_brief_updated_at;
        } else {
          p.shared_brief = trimmed;
          p.shared_brief_updated_at = new Date().toISOString();
        }
      });
      const sizeMsg =
        trimmed.length === 0
          ? "Cleared shared brief."
          : `Recorded shared brief — ${trimmed.length} bytes. Phases spawned after this point will splice it into their kickoff prompt.`;
      const stillPending = (updated.pending_phases?.length ?? 0) > 0;
      const reminder = stillPending
        ? ` ${updated.pending_phases?.length} phase(s) are still pending and will pick up the new brief on spawn.`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: sizeMsg + reminder,
          },
        ],
      };
    },
  );

  const mergePlan = tool(
    MERGE_PLAN_TOOL_NAME,
    "Fold every phase's wo/<plan>/<slug> branch into an integration branch (default 'main'). Mirrors the UI's Merge button. Gating: plan must be approved AND every phase must have commit_status ∈ {clean, committed} (failed commits abort with the offending slugs). Writes plan.merge_status / merge_results / merge_head_sha. Idempotent on a fully-merged plan: each phase reports 'skipped' and merge_status stays 'merged'. Re-running clears any prior integration_review_* fields since the diff range changed.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id to merge. Defaults to the owner's current plan."),
      integration_branch: z
        .string()
        .optional()
        .describe(
          "Branch to merge phases into. Defaults to 'main'. Must match [a-zA-Z0-9._-/]+.",
        ),
    },
    async ({ plan_id, integration_branch }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const out = await runMergeForPlan({
        planId: r.plan.id,
        integrationBranch: integration_branch ?? "main",
      });
      if (!out.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: out.error.message }],
        };
      }
      const merged = out.merge.results.filter((x) => x.status === "merged");
      const skipped = out.merge.results.filter((x) => x.status === "skipped");
      const failed = out.merge.results.filter((x) => x.status === "failed");
      const lines = [
        `# Merge → ${out.plan.merge_branch} (${out.plan.merge_status})`,
        `merged: ${merged.length}, skipped: ${skipped.length}, failed: ${failed.length}`,
        out.plan.merge_head_sha
          ? `head: ${out.plan.merge_head_sha.slice(0, 7)}`
          : "",
        "",
        ...out.merge.results.map((x) => {
          const sha = x.sha ? ` ${x.sha.slice(0, 7)}` : "";
          const err = x.error ? ` — ${x.error}` : "";
          return `- \`${x.phase_slug}\` → ${x.status}${sha}${err}`;
        }),
      ].filter(Boolean);
      if (out.merge.error) lines.push("", `merge error: ${out.merge.error}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  const runIntegrationReviewTool = tool(
    RUN_INTEGRATION_REVIEW_TOOL_NAME,
    "Spawn a one-shot reviewer that diffs the integration branch against the pre-merge sha and writes findings into plan.integration_review_*. Background — returns immediately with status='running'; poll read_plan_state for completion. Gating: plan must be merged (merge_status === 'merged') with merge_branch + merge_base_sha recorded. If a review is already in flight this call is a no-op (no duplicate spawn).",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner's current plan."),
    },
    async ({ plan_id }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const out = await runIntegrationReviewForPlan({ planId: r.plan.id });
      if (!out.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: out.error.message }],
        };
      }
      if (out.alreadyRunning) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Integration review already running. Poll read_plan_state for completion.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Integration review started against ${out.plan.merge_branch} (head ${out.plan.merge_head_sha?.slice(0, 7) ?? "?"}). Poll read_plan_state to see findings.`,
          },
        ],
      };
    },
  );

  const cleanupWorktrees = tool(
    CLEANUP_WORKTREES_TOOL_NAME,
    "Tear down phase worktrees and delete the wo/<plan>/<slug> branches. DESTRUCTIVE — gated through the user permission dialog before running. Use only after the integration branch is pushed (or otherwise preserved) since this removes the per-phase commit history from local refs. Plan record stays on disk for inspectability. Gating: plan.merge_status must be 'merged' (refusing to cleanup half-merged work). Idempotent — already-removed worktrees report 'missing'.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner's current plan."),
    },
    async ({ plan_id }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const out = await cleanupPlanWorktrees({ planId: r.plan.id });
      if (!out.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: out.error.message }],
        };
      }
      const lines = [
        `# Cleanup — ${out.outcomes.length} worktree(s)`,
        `cleaned_at: ${out.plan.worktrees_cleaned_at}`,
        "",
        ...out.outcomes.map((o) => {
          const wt =
            typeof o.worktree_removed === "object"
              ? `error: ${o.worktree_removed.error}`
              : o.worktree_removed;
          const br =
            typeof o.branch_deleted === "object"
              ? `error: ${o.branch_deleted.error}`
              : o.branch_deleted;
          return `- \`${o.phase_slug}\` worktree=${wt}, branch=${br}`;
        }),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  const archivePlanTool = tool(
    ARCHIVE_PLAN_TOOL_NAME,
    "Mark the plan as archived (or un-archive). Sets plan.archived_at to the current timestamp — UI sidebar/list filters can hide archived plans without losing the on-disk record. Reversible via archive=false.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner's current plan."),
      archive: z
        .boolean()
        .optional()
        .describe(
          "When true (default), set archived_at. When false, clear it (un-archive).",
        ),
    },
    async ({ plan_id, archive }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const out = await archivePlan({
        planId: r.plan.id,
        archive: archive !== false,
      });
      if (!out.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: out.error.message }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: out.plan.archived_at
              ? `Archived plan at ${out.plan.archived_at}.`
              : "Un-archived plan.",
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: LEADER_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [
      readPlanState,
      listNotes,
      readDiff,
      recordSharedContext,
      mergePlan,
      runIntegrationReviewTool,
      cleanupWorktrees,
      archivePlanTool,
    ],
  });
}

// formatPlanState renders a markdown digest of the plan record. Kept
// dense so the model gets one screenful of state per call; tables make
// per-phase scanning easy. Live SDK status is fused with on-disk plan
// fields so the snapshot matches what the user sees in PhaseBoard.
function formatPlanState(
  plan: PlanRecord,
  snapshotPhase: (sessionId: string) => SessionSummary | undefined,
): string {
  const linkBySlug = new Map<string, PhaseSession>(
    (plan.phase_sessions ?? []).map((p) => [p.phase_slug, p]),
  );
  const pendingSet = new Set(
    (plan.pending_phases ?? []).map((p) => p.phase_slug),
  );

  const lines: string[] = [
    `# Plan: ${plan.title}`,
    `id: \`${plan.id}\` · status: \`${plan.status}\` · cwd: \`${plan.cwd}\``,
    `phases: ${plan.phases.length} · sessions: ${plan.phase_sessions?.length ?? 0} · pending: ${plan.pending_phases?.length ?? 0}`,
    "",
    "## Phases",
    "",
    "| slug | title | run | ctx | commit | scope | review | depends_on |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const phase of plan.phases) {
    const link = linkBySlug.get(phase.slug);
    const live = link ? snapshotPhase(link.session_id) : undefined;
    const runStatus = pendingSet.has(phase.slug)
      ? "pending"
      : (live?.status ?? (link ? "unknown" : "—"));
    // Context window usage from the SDK's /context channel. Threshold
    // is model-aware (lib/context-thresholds.ts): 200k models flag at
    // ~50% used, 1M models at ~75%. ⚠ marks the act zone, ! the warn
    // band — the leader uses these to decide whether to nudge a phase
    // toward /compact or memory-update + restart.
    const usage = live?.context_usage;
    const ctxCell = (() => {
      if (!usage) return "—";
      const rounded = Math.round(usage.percentage);
      const zone = classifyContextZone(usage.percentage, usage.max_tokens);
      const flag = zone === "act" ? " ⚠" : zone === "warn" ? " !" : "";
      return `${rounded}%${flag}`;
    })();
    const commit = link?.commit_status
      ? link.commit_status === "committed"
        ? `committed ${link.commit_sha?.slice(0, 7) ?? ""}`
        : link.commit_status
      : "—";
    const scope =
      link?.scope_violations === undefined
        ? phase.scope?.files
          ? "declared"
          : "—"
        : link.scope_violations.length === 0
          ? "ok"
          : `${link.scope_violations.length} violations`;
    const review =
      link?.review_status === undefined
        ? "—"
        : link.review_status === "complete"
          ? `${link.review_findings?.length ?? 0} findings`
          : link.review_status;
    const deps =
      phase.depends_on && phase.depends_on.length > 0
        ? phase.depends_on.map((d) => `\`${d}\``).join(", ")
        : "—";
    lines.push(
      `| \`${phase.slug}\` | ${escapeCell(phase.title)} | ${runStatus} | ${ctxCell} | ${commit} | ${scope} | ${review} | ${deps} |`,
    );
  }

  if ((plan.pending_phases?.length ?? 0) > 0) {
    lines.push("", "## Pending phases (blocked on deps)");
    for (const p of plan.pending_phases ?? []) {
      lines.push(`- \`${p.phase_slug}\` (worktree \`${p.worktree_branch}\`)`);
    }
  }

  if (plan.merge_status) {
    lines.push(
      "",
      `## Merge state — ${plan.merge_status}`,
      `branch: \`${plan.merge_branch ?? "main"}\`${plan.merge_head_sha ? ` · head ${plan.merge_head_sha.slice(0, 7)}` : ""}`,
    );
    if (plan.merge_results && plan.merge_results.length > 0) {
      for (const r of plan.merge_results) {
        const sha = r.sha ? ` ${r.sha.slice(0, 7)}` : "";
        const err = r.error ? ` — ${r.error}` : "";
        lines.push(`- \`${r.phase_slug}\` → ${r.status}${sha}${err}`);
      }
    }
    if (plan.merge_error) {
      lines.push("", `Merge error: \`${plan.merge_error}\``);
    }
  }

  if (plan.integration_review_status) {
    lines.push(
      "",
      `## Integration review — ${plan.integration_review_status}`,
    );
    if (plan.integration_review_summary) {
      lines.push("", plan.integration_review_summary);
    }
    const findings = plan.integration_review_findings ?? [];
    if (findings.length > 0) {
      lines.push("", `${findings.length} finding(s):`);
      for (const f of findings) {
        const loc =
          f.file && f.line ? ` (${f.file}:${f.line})` : f.file ? ` (${f.file})` : "";
        lines.push(`- **${f.severity}** ${f.title}${loc}`);
      }
    }
  }

  if (plan.shared_brief && plan.shared_brief.length > 0) {
    const updated = plan.shared_brief_updated_at
      ? ` _(updated ${plan.shared_brief_updated_at})_`
      : "";
    lines.push("", `## Shared brief${updated}`, "", plan.shared_brief);
  } else {
    lines.push(
      "",
      "## Shared brief",
      "_(none — call `record_shared_context` to seed plan-level anchors that every phase splices into its kickoff prompt)_",
    );
  }

  const notes = plan.notes ?? [];
  const active = notes.filter((n) => !n.dismissed_at).length;
  lines.push(
    "",
    `## Notes — ${active} active / ${notes.length} total`,
    "Use `list_phase_notes` to read the bodies.",
  );

  return lines.join("\n");
}

function formatNotes(
  plan: PlanRecord,
  opts: { tag?: string; includeDismissed: boolean },
): string {
  const all = plan.notes ?? [];
  let filtered: PhaseNote[] = opts.includeDismissed
    ? all
    : all.filter((n) => !n.dismissed_at);
  if (opts.tag) {
    filtered = filtered.filter((n) =>
      (n.tags ?? []).some((t) => t.toLowerCase() === opts.tag),
    );
  }
  if (filtered.length === 0) {
    return opts.tag
      ? `_(no notes match tag '${opts.tag}'${opts.includeDismissed ? "" : " — try include_dismissed=true"})_`
      : `_(no ${opts.includeDismissed ? "" : "active "}notes on this plan)_`;
  }
  const sorted = [...filtered].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  const lines: string[] = [
    `## Phase notes — ${sorted.length} (latest first)`,
    "",
  ];
  for (const note of sorted) {
    const tags =
      note.tags && note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : "";
    const dismissed = note.dismissed_at ? " · dismissed" : "";
    lines.push(
      `### ${note.created_at} — \`${note.phase_slug}\`${tags}${dismissed}`,
    );
    lines.push(note.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function readPhaseDiff(
  worktreePath: string,
  baseRef: string,
  statOnly: boolean,
): Promise<string> {
  // Resolve the merge-base so the diff shows only what the phase
  // contributed, not unrelated commits on baseRef. If baseRef doesn't
  // exist locally (e.g. user typed a branch they didn't fetch), the
  // merge-base call surfaces the error and we bail.
  let base: string;
  try {
    const r = await exec("git", [
      "-C",
      worktreePath,
      "merge-base",
      "HEAD",
      baseRef,
    ]);
    base = r.stdout.trim();
  } catch (err) {
    return formatDiffError(`merge-base failed against ${baseRef}`, err);
  }
  if (base.length === 0) {
    return `_(no merge-base between HEAD and ${baseRef} — unrelated histories)_`;
  }

  let stat: string;
  try {
    const r = await exec("git", [
      "-C",
      worktreePath,
      "diff",
      "--stat",
      `${base}..HEAD`,
    ]);
    stat = r.stdout.trim();
  } catch (err) {
    return formatDiffError("git diff --stat", err);
  }
  if (stat.length === 0) {
    return "_(empty diff — phase has not committed any changes against the base)_";
  }

  if (statOnly) {
    return ["```", stat, "```"].join("\n");
  }

  let patch: string;
  try {
    const r = await exec(
      "git",
      ["-C", worktreePath, "diff", `${base}..HEAD`],
      // 8MB head-room — the slice we surface is capped at 32KB but git
      // emits the full diff before we truncate.
      { maxBuffer: 8 * 1024 * 1024 },
    );
    patch = r.stdout;
  } catch (err) {
    return formatDiffError("git diff (full)", err);
  }

  const truncated =
    patch.length > DIFF_BYTE_CAP
      ? patch.slice(0, DIFF_BYTE_CAP) +
        `\n…(truncated; original ${patch.length} bytes — call again with stat_only=true for the summary)`
      : patch;

  return ["```", stat, "```", "", "```diff", truncated, "```"].join("\n");
}

function formatDiffError(label: string, err: unknown): string {
  const stderr = (err as Error & { stderr?: string }).stderr;
  const msg =
    stderr && stderr.trim().length > 0
      ? stderr.trim()
      : err instanceof Error
        ? err.message
        : String(err);
  return `_${label} errored: ${msg}_`;
}

function escapeCell(s: string): string {
  // Pipe is the column separator in markdown tables; escape any literal
  // pipes in titles. Newlines also break the row, so collapse.
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}
