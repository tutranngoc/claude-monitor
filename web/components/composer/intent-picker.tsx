"use client";

import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

// MultiPhaseToggle is a single-purpose pill in the composer toolbar:
// when on, the next message gets a directive prefix telling the leader
// to decompose the task via mcp__plans__submit_plan instead of editing
// files directly. When off (default), nothing changes — the leader
// behaves as a normal single-session Claude Code agent.
//
// State lives at the Composer level. After each submit it resets to
// off — the override is intended as a one-shot for the kickoff
// message, not a sticky setting; follow-up messages on the same task
// inherit the flow that's already running.
//
// We deliberately do NOT add a "single-session" or "auto" pill. Single
// is the default and any further triage UX is left to the existing
// ModePicker (Plan mode covers the CLI plan-first flow).

interface Props {
  active: boolean;
  onChange: (next: boolean) => void;
}

export function MultiPhaseToggle({ active, onChange }: Props) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={
        active
          ? "Multi-phase split is on — next message will ask the leader to call submit_plan"
          : "Multi-phase split is off — leader handles the task in this chat"
      }
      title={
        active
          ? "Next message will ask the leader to split into parallel phases via submit_plan. Resets after sending."
          : "Click to ask the leader to decompose the next task into parallel phases instead of editing files directly here."
      }
      onClick={() => onChange(!active)}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        active
          ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/15"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
      )}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span>{active ? "Multi-phase ✓" : "Multi-phase"}</span>
    </button>
  );
}

// hintForMultiPhase returns the prefix block to splice ahead of the
// user's text on submit when the toggle is active. Wrapped in an
// XML-ish marker so the leader can recognize it as a directive
// separately from the user's natural language.
export function hintForMultiPhase(): string {
  return [
    "<orchestrator-intent>multi-phase</orchestrator-intent>",
    "Decompose the request below into parallel phases and call mcp__plans__submit_plan with the proposed phases. Do not edit files directly from this chat — phase work happens in per-phase worktrees driven by spawned agents.",
  ].join("\n");
}
