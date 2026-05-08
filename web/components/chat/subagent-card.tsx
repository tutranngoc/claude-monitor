"use client";

import { Bot, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import type { SubagentSummary } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { useSubagents } from "./subagent-context";

interface Props {
  summary: SubagentSummary;
  // Total count of child SDKMessages — the chevron label says
  // "Expand N events" so the user knows how dense the inner timeline
  // is before opening it. Card itself doesn't render children; the
  // parent passes them as React children for layout flexibility.
  childCount: number;
  // The expanded timeline. Slotted instead of rendered internally so
  // the card stays free of MessageBubble (avoids the import cycle).
  children?: ReactNode;
}

const STATUS_LABELS: Record<SubagentSummary["status"], string> = {
  active: "running",
  done: "done",
  errored: "errored",
};

const STATUS_DOT: Record<SubagentSummary["status"], string> = {
  active: "bg-amber-500 animate-pulse",
  done: "bg-emerald-500",
  errored: "bg-destructive",
};

export function SubagentCard({ summary, childCount, children }: Props) {
  const ctx = useSubagents();
  const expanded = ctx?.isExpanded(summary.task_id) ?? false;
  const onToggle = () => ctx?.toggleExpanded(summary.task_id);

  const heading = summary.subagent_type ?? "subagent";
  const description = summary.description?.trim();
  const result = summary.result_text?.trim();

  // Anchor target so the sidebar tree can scroll the card into view
  // when navigating from a different session — the row click does
  // setExpanded(true) + window.location.hash = `subagent-${id}`.
  const anchorId = `subagent-${summary.task_id}`;

  return (
    <section
      id={anchorId}
      className={cn(
        "rounded-md border border-border/70 bg-card text-sm shadow-sm",
        summary.status === "errored" && "border-destructive/60",
      )}
    >
      <header className="flex items-baseline gap-2 px-3 py-2">
        <Bot className="size-3.5 shrink-0 self-center text-muted-foreground" />
        <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          Task
        </span>
        <span className="truncate font-medium">{heading}</span>
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span
              aria-hidden
              className={cn("inline-block size-1.5 rounded-full", STATUS_DOT[summary.status])}
            />
            {STATUS_LABELS[summary.status]}
          </span>
          <span aria-hidden>·</span>
          <span>
            {summary.tool_calls} tool{summary.tool_calls === 1 ? "" : "s"}
          </span>
        </span>
      </header>

      {(description || result) && (
        <div className="space-y-1.5 px-3 pb-2 text-[13px] leading-relaxed">
          {description && (
            <p className="text-muted-foreground">
              <span className="text-foreground">{description}</span>
            </p>
          )}
          {result && (
            <p
              className={cn(
                "flex items-baseline gap-1.5 text-xs",
                summary.status === "errored" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              <span aria-hidden>⎿</span>
              <span className="truncate font-mono">{result}</span>
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`${anchorId}-timeline`}
        disabled={childCount === 0}
        className={cn(
          "flex w-full cursor-pointer select-none items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40",
          childCount === 0 && "cursor-default opacity-60 hover:bg-transparent",
        )}
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            expanded ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
        <span className="font-mono">
          {childCount === 0
            ? "no inner events yet"
            : expanded
              ? "Hide timeline"
              : `Show ${childCount} inner event${childCount === 1 ? "" : "s"}`}
        </span>
      </button>

      {expanded && childCount > 0 && (
        <div
          id={`${anchorId}-timeline`}
          className="space-y-2 border-t border-border/60 bg-muted/20 px-3 py-2"
        >
          {children}
        </div>
      )}
    </section>
  );
}
