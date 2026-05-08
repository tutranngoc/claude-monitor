// Shared subagent derivation. Walks an SDKMessage history once and
// produces:
//   - byTaskId: per-subagent summary (subagent_type, status, tool_calls…)
//   - childrenByTaskId: nested SDKMessages grouped by parent_tool_use_id
//   - resultTaskIds: subagent ids that have already received their final
//     tool_result, so the chat panel can hide the redundant top-level
//     tool_result echo (the SubagentCard owns it).
//
// Used by both the server snapshot (`lib/server/sessions.ts`) and the
// client hook (`hooks/use-chat-session.ts`) so the two sides agree on
// what counts as a subagent.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentSummary } from "./chat-types";

// The dispatch tool's surface name has wobbled between releases —
// some SDK builds expose it as "Task", current ones (0.2.133) emit
// "Agent". Match both so we don't quietly stop grouping when the
// SDK is bumped. Verified empirically via [SDK] debug log against
// 0.2.133 — main agent emits `tool_use(Agent)` then children carry
// parent_tool_use_id pointing at that Agent block's id.
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
]);

export function isSubagentDispatchTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

export interface DerivedSubagents {
  byTaskId: Map<string, SubagentSummary>;
  list: SubagentSummary[];
  childrenByTaskId: Map<string, SDKMessage[]>;
  resultTaskIds: Set<string>;
}

const RESULT_PREVIEW_MAX = 200;

export function deriveSubagents(history: SDKMessage[]): DerivedSubagents {
  const byTaskId = new Map<string, SubagentSummary>();
  const childrenByTaskId = new Map<string, SDKMessage[]>();
  const resultTaskIds = new Set<string>();
  const order: string[] = [];

  for (const msg of history) {
    const parent = parentToolUseId(msg);

    // 1. Spawn: top-level assistant message with a subagent dispatch
    //    tool_use block. Nested subagents (a subagent that itself
    //    dispatches another subagent) are captured under the same map
    //    keyed by their own tool_use id — parent != null here means
    //    "dispatched from inside another subagent", but it's still a
    //    subagent we want to track. We don't filter by
    //    `parent === null` for spawns.
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type !== "tool_use") continue;
        if (!SUBAGENT_TOOL_NAMES.has(block.name)) continue;
        const id = block.id;
        if (!id || byTaskId.has(id)) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const subagent_type = stringOrUndefined(input.subagent_type);
        const description = stringOrUndefined(input.description);
        const summary: SubagentSummary = {
          task_id: id,
          subagent_type,
          description,
          status: "active",
          tool_calls: 0,
        };
        byTaskId.set(id, summary);
        order.push(id);
      }
    }

    // 2. Children: any message with parent_tool_use_id pointing to a
    //    known Task. Group by parent so the SubagentCard can replay
    //    the child timeline when expanded.
    if (parent && byTaskId.has(parent)) {
      const list = childrenByTaskId.get(parent) ?? [];
      list.push(msg);
      childrenByTaskId.set(parent, list);
      // Increment tool_calls for assistant turns made inside the
      // subagent. Includes nested Task spawns — each child Task is
      // itself a tool call from the parent's perspective, even though
      // it also gets its own SubagentCard via the spawn branch above.
      if (msg.type === "assistant") {
        const summary = byTaskId.get(parent)!;
        const newCalls = msg.message.content.reduce(
          (acc, b) => (b.type === "tool_use" ? acc + 1 : acc),
          0,
        );
        if (newCalls > 0) {
          byTaskId.set(parent, {
            ...summary,
            tool_calls: summary.tool_calls + newCalls,
          });
        }
      }
    }

    // 3. Completion: a tool_result block whose tool_use_id matches a
    //    known Task. The result rides back on a user message echoing
    //    tool_results to the dispatcher — that dispatcher may be the
    //    main agent (parent=null) OR a parent subagent (parent=<other
    //    task_id>). In either case we still want to flip status.
    if (msg.type === "user") {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
          if (!toolUseId || !byTaskId.has(toolUseId)) continue;
          resultTaskIds.add(toolUseId);
          const isError = Boolean((block as { is_error?: boolean }).is_error);
          const text = previewToolResultContent(
            (block as { content?: unknown }).content,
          );
          const summary = byTaskId.get(toolUseId)!;
          byTaskId.set(toolUseId, {
            ...summary,
            status: isError ? "errored" : "done",
            result_text: text ?? summary.result_text,
          });
        }
      }
    }
  }

  const list = order.map((id) => byTaskId.get(id)!);
  return { byTaskId, list, childrenByTaskId, resultTaskIds };
}

// Some SDK message shapes (notably stream_event partial deltas) don't
// carry parent_tool_use_id. Read defensively so derivation can also
// handle the partial-message shape on the client without exploding.
function parentToolUseId(msg: SDKMessage): string | null {
  const v = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function previewToolResultContent(content: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
        const text = (c as { text?: string }).text;
        if (typeof text === "string" && text.trim()) {
          raw = text;
          break;
        }
      }
    }
  }
  if (!raw) return undefined;
  const firstLine = raw.trim().split("\n", 1)[0] ?? "";
  if (!firstLine) return undefined;
  return firstLine.length > RESULT_PREVIEW_MAX
    ? firstLine.slice(0, RESULT_PREVIEW_MAX - 1) + "…"
    : firstLine;
}

// taskIdsForMessage returns the parent Task ids that should "own" a
// message. A message is owned by:
//   - its parent_tool_use_id chain (it's a child of those subagents)
//   - any Task tool_use_id appearing in its tool_result blocks (the
//     top-level echo back to the dispatcher — the SubagentCard for
//     that Task will fold the result in)
// The chat panel uses this to hide messages that the SubagentCard
// already owns from the main viewport.
export function taskIdsOwningMessage(
  msg: SDKMessage,
  knownTaskIds: Set<string>,
): string[] {
  const out: string[] = [];
  const parent = parentToolUseId(msg);
  if (parent && knownTaskIds.has(parent)) out.push(parent);
  if (msg.type === "user") {
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const id = (block as { tool_use_id?: string }).tool_use_id;
        if (id && knownTaskIds.has(id)) out.push(id);
      }
    }
  }
  return out;
}

// shouldHideFromMainTimeline decides whether a message renders inline
// in the chat viewport. True when:
//   1. parent_tool_use_id points at a known subagent (it's a child)
//   2. it's a top-level user message and ALL of its tool_result blocks
//      reference known Task ids (the SubagentCard will surface the
//      result inside its expanded view)
// User messages mixing Task tool_results with other tool_results —
// rare but possible if the model batches calls — stay visible so the
// non-Task results aren't lost.
export function shouldHideFromMainTimeline(
  msg: SDKMessage,
  derived: DerivedSubagents,
): boolean {
  const parent = parentToolUseId(msg);
  if (parent && derived.byTaskId.has(parent)) return true;

  if (msg.type === "user") {
    const content = msg.message.content;
    if (Array.isArray(content) && content.length > 0) {
      let sawToolResult = false;
      let allMatchTask = true;
      for (const block of content) {
        if (block.type !== "tool_result") {
          // A non-tool_result block (text, image) means the user message
          // also carries human content — keep it visible.
          allMatchTask = false;
          break;
        }
        sawToolResult = true;
        const id = (block as { tool_use_id?: string }).tool_use_id;
        if (!id || !derived.byTaskId.has(id)) {
          allMatchTask = false;
          break;
        }
      }
      if (sawToolResult && allMatchTask) return true;
    }
  }
  return false;
}
