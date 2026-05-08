"use client";

import { useState } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChevronDown, Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";

interface QueuedMessage {
  // SDK uuid when present; falls back to position-based id for synthetic
  // user messages we surface before the first turn completes.
  id: string;
  // First plain-text block from the user message, capped to one line.
  preview: string;
  // True for the oldest unprocessed message — the one the SDK is
  // currently chewing on. The others are strictly waiting in line.
  current: boolean;
}

// queuedMessages walks the transcript and pulls out user messages that
// haven't been answered yet. The SDK delimits each completed turn with
// a `result` SDKMessage, so anything between the last result and the
// end of history is in flight or queued.
//
// Tool-result user messages (sent by the SDK to relay tool output back
// to the model) are skipped — those aren't user-typed input and don't
// belong in the queue display.
export function computeQueuedMessages(
  history: SDKMessage[],
  thinking: boolean,
): QueuedMessage[] {
  let lastResultIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "result") {
      lastResultIdx = i;
      break;
    }
  }
  const out: QueuedMessage[] = [];
  for (let i = lastResultIdx + 1; i < history.length; i++) {
    const m = history[i];
    if (m.type !== "user") continue;
    const content = m.message.content;
    let preview = "";
    if (typeof content === "string") {
      preview = content;
    } else if (Array.isArray(content)) {
      // Skip pure tool_result messages: they have no text/image blocks
      // the user actually typed. A user message with attachments + text
      // surfaces the text portion as the preview.
      const text = content.find(
        (b): b is { type: "text"; text: string } =>
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      );
      if (!text) continue;
      preview = text.text;
    }
    const trimmed = preview.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    out.push({
      id: (m as { uuid?: string }).uuid ?? `pos-${i}`,
      preview: trimmed,
      // We mark only the oldest message as "current" — that's the one
      // being processed. If the session isn't actively thinking (e.g. an
      // error closed the turn), we don't claim any of them is in flight.
      current: thinking && out.length === 0,
    });
  }
  return out;
}

// QueueIndicator shows up in the composer footer when there's at least
// one user message that the SDK hasn't responded to yet. Click expands
// the previews so the user can see exactly what they queued.
export function QueueIndicator({
  queued,
}: {
  queued: QueuedMessage[];
}) {
  const [open, setOpen] = useState(false);
  if (queued.length === 0) return null;

  const pending = queued.filter((q) => !q.current).length;
  const inFlight = queued.find((q) => q.current);
  // Prefer "{n} queued" wording when there are messages waiting behind
  // the active one; "Sending…" when only the in-flight message exists.
  const summary =
    pending > 0
      ? `${pending} queued`
      : inFlight
        ? "Sending…"
        : `${queued.length} pending`;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-amber-500/[0.10]"
      >
        <Hourglass className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-amber-700 dark:text-amber-300">
          {summary}
        </span>
        {inFlight && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {inFlight.preview}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="space-y-1 border-t border-amber-500/30 px-3 py-2">
          {queued.map((q, i) => (
            <li
              key={q.id}
              className="flex items-baseline gap-2 text-[11.5px]"
            >
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 font-mono text-[10px]",
                  q.current
                    ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {q.current ? "now" : `#${i}`}
              </span>
              <span className="line-clamp-2 min-w-0 flex-1 break-words">
                {q.preview}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
