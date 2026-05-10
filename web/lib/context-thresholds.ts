// Context-window usage thresholds. The point at which an LLM session
// loses coherence is a function of the model's max context, NOT a single
// global cutoff:
//
//   - 200k-context models start degrading around 50% used.
//   - 1M-context models hold longer; act when remaining < 25% (~75%
//     used). On these the user usually wants to update memory and start
//     a fresh session rather than /compact in place.
//
// Both `ContextPctChip` (web/components/phases/phase-board.tsx) and the
// leader's `read_plan_state` digest (web/lib/server/leader-mcp.ts) read
// from this module so the kanban chip and the agent's table agree.

export type ContextZone = "ok" | "warn" | "act";

export interface ContextThresholds {
  // used % at which to start nudging the user (soft amber).
  warnPct: number;
  // used % at which the model is past its reliable reasoning window
  // and the user should act (compact or restart).
  actPct: number;
}

// Models with > 250k max_tokens are treated as the 1M tier. The SDK's
// ContextUsageBreakdown.max_tokens is the authoritative signal — no need
// to parse model id strings.
export function thresholdsForMaxTokens(maxTokens: number): ContextThresholds {
  if (maxTokens > 250_000) return { warnPct: 60, actPct: 75 };
  return { warnPct: 35, actPct: 50 };
}

export function classifyContextZone(
  usedPct: number,
  maxTokens: number,
): ContextZone {
  const t = thresholdsForMaxTokens(maxTokens);
  if (usedPct >= t.actPct) return "act";
  if (usedPct >= t.warnPct) return "warn";
  return "ok";
}

// One-line user-facing hint for what to do once the zone hits "act".
// 1M models get the "update memory + fresh session" branch because
// /compact alone often leaves load-bearing facts behind on long runs.
export function actionHintForMaxTokens(maxTokens: number): string {
  return maxTokens > 250_000
    ? "compact, or update memory and start fresh"
    : "consider /compact or restart";
}
