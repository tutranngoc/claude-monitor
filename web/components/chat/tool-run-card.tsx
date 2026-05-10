"use client";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageBubble } from "./message-bubble";

interface Props {
  messages: SDKMessage[];
}

// ToolRunCard wraps a streak of tool-only assistant turns + their
// matching tool_result echoes in one collapsible. Default-collapsed —
// the user opted into "gom thành 1 block": they want the noise out of
// the way unless they specifically open it. Header shows op count and
// the first few distinct tool names so the streak is recognisable
// without expanding.
export function ToolRunCard({ messages }: Props) {
  const { totalCalls, toolNames } = summariseRun(messages);
  const visible = toolNames.slice(0, 4);
  const hiddenCount = toolNames.length - visible.length;
  return (
    <details className="group rounded-md border-l-2 border-l-emerald-500/40 bg-muted/15 px-2 py-1">
      <summary className="flex cursor-pointer select-none items-baseline gap-2 text-sm">
        <span className="text-emerald-500" aria-hidden>
          ●
        </span>
        <span className="font-medium">Tool run</span>
        <span className="font-mono text-xs text-muted-foreground">
          · {totalCalls} {totalCalls === 1 ? "op" : "ops"}
        </span>
        {visible.length > 0 && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            · {visible.join(", ")}
            {hiddenCount > 0 ? `, +${hiddenCount}` : ""}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70 group-open:hidden">
          click to expand
        </span>
      </summary>
      <div className="mt-1 space-y-1 border-t border-border/40 pt-1.5">
        {messages.map((m, i) => (
          <MessageBubble key={messageKey(m, i)} msg={m} />
        ))}
      </div>
    </details>
  );
}

function summariseRun(messages: SDKMessage[]): {
  totalCalls: number;
  toolNames: string[];
} {
  let totalCalls = 0;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const b of m.message.content) {
      if (b.type === "tool_use") {
        totalCalls++;
        if (!seen.has(b.name)) {
          seen.add(b.name);
          ordered.push(b.name);
        }
      }
    }
  }
  return { totalCalls, toolNames: ordered };
}

function messageKey(msg: SDKMessage, idx: number): string {
  const uuid = (msg as { uuid?: string }).uuid;
  return uuid ? `${msg.type}:${uuid}` : `${msg.type}:${idx}`;
}
