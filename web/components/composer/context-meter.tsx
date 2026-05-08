"use client";

import type { SessionUsage } from "@/lib/chat-types";

interface Props {
  usage?: SessionUsage;
  contextWindow: number;
}

// ContextMeter renders a small ring + percentage. Approximates context
// usage as input_tokens / contextWindow — input_tokens already includes
// the running history the SDK ships each turn, so it's the closest proxy
// for "how full is the conversation".
export function ContextMeter({ usage, contextWindow }: Props) {
  const used = usage?.input_tokens ?? 0;
  const pct = contextWindow > 0 ? Math.min(100, (used / contextWindow) * 100) : 0;
  const display = pct >= 1 ? `${Math.round(pct)}%` : "<1%";
  const r = 7;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const stroke =
    pct >= 90
      ? "stroke-destructive"
      : pct >= 70
        ? "stroke-amber-500"
        : "stroke-primary";

  return (
    <span
      title={`${used.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}
      className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" className="-mr-0.5">
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          className="stroke-muted"
          strokeWidth="2"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          className={stroke}
          strokeWidth="2"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span>{display}</span>
    </span>
  );
}
