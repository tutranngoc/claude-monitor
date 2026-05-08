"use client";

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SessionUsage } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

interface Props {
  usage?: SessionUsage;
  contextWindow: number;
}

// ContextMeter renders a small ring + percentage. Clicking opens a
// popover with a per-category breakdown (cached prefix, cache write,
// new input, last output, auto-compact buffer, free) so the user can
// see exactly what's filling the window.
export function ContextMeter({ usage, contextWindow }: Props) {
  const [open, setOpen] = useState(false);
  const used = totalContextTokens(usage);
  const pct = contextWindow > 0 ? Math.min(100, (used / contextWindow) * 100) : 0;
  const display = used === 0 ? "0%" : pct >= 1 ? `${Math.round(pct)}%` : "<1%";
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Context window ${display}, click for breakdown`}
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        }
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          className="-mr-0.5"
          aria-hidden
        >
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
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
        <ContextBreakdown usage={usage} contextWindow={contextWindow} />
      </PopoverContent>
    </Popover>
  );
}

interface CategoryBar {
  label: string;
  tokens: number;
  // Tailwind classes for the dot + the bar fill. Colors mirror the
  // /context slash-command output so the popover and the command card
  // tell the same story.
  dot: string;
  bar: string;
}

function ContextBreakdown({
  usage,
  contextWindow,
}: {
  usage?: SessionUsage;
  contextWindow: number;
}) {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const used = cacheRead + cacheCreate + input + output;
  // 5% reserve, matching the CLI's autocompact default.
  const autocompact = Math.round(contextWindow * 0.05);
  const free = Math.max(0, contextWindow - used - autocompact);
  const pctOf = (n: number) =>
    contextWindow > 0 ? (n / contextWindow) * 100 : 0;

  const categories: CategoryBar[] = [
    {
      label: "Cached prefix",
      tokens: cacheRead,
      dot: "bg-violet-500",
      bar: "bg-violet-500/70",
    },
    {
      label: "Cache write",
      tokens: cacheCreate,
      dot: "bg-pink-500",
      bar: "bg-pink-500/70",
    },
    {
      label: "Messages (this turn)",
      tokens: input,
      dot: "bg-emerald-500",
      bar: "bg-emerald-500/70",
    },
    {
      label: "Last assistant reply",
      tokens: output,
      dot: "bg-sky-500",
      bar: "bg-sky-500/70",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Context window</h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {fmt(used)} / {fmt(contextWindow)}
        </span>
      </div>

      {/* Stacked bar gives a visual sum of all categories — the user
          sees in one glance which slice is hogging the window. */}
      <StackedBar
        segments={[
          ...categories,
          {
            label: "Auto-compact buffer",
            tokens: autocompact,
            dot: "bg-muted-foreground/50",
            bar: "bg-muted-foreground/40",
          },
        ]}
        total={contextWindow}
      />

      <ul className="space-y-1.5 text-[12px]">
        {categories.map((c) => (
          <li key={c.label} className="flex items-baseline gap-2">
            <span
              className={cn("mt-1 inline-block size-2 shrink-0 rounded-sm", c.dot)}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {fmt(c.tokens)}
            </span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">
              {pctLabel(pctOf(c.tokens))}
            </span>
          </li>
        ))}
        <li className="flex items-baseline gap-2 border-t border-border pt-1.5">
          <span
            className="mt-1 inline-block size-2 shrink-0 rounded-sm bg-muted-foreground/40"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Auto-compact buffer
          </span>
          <span className="tabular-nums text-muted-foreground">
            {fmt(autocompact)}
          </span>
          <span className="w-10 text-right tabular-nums text-muted-foreground">
            {pctLabel(pctOf(autocompact))}
          </span>
        </li>
        <li className="flex items-baseline gap-2">
          <span
            className="mt-1 inline-block size-2 shrink-0 rounded-sm border border-dashed border-muted-foreground/40"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate font-medium">
            Free
          </span>
          <span className="tabular-nums">{fmt(free)}</span>
          <span className="w-10 text-right tabular-nums">
            {pctLabel(pctOf(free))}
          </span>
        </li>
      </ul>

      {!usage && (
        <p className="rounded-md border border-dashed border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
          No turn has completed yet. The breakdown populates after the first
          response.
        </p>
      )}
    </div>
  );
}

function StackedBar({
  segments,
  total,
}: {
  segments: CategoryBar[];
  total: number;
}) {
  // Each segment width is a percent of the window. Empty segments get
  // 0 width so they collapse — no zero-width artifacts thanks to flex.
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {segments.map((s) => {
        const w = total > 0 ? (s.tokens / total) * 100 : 0;
        if (w <= 0) return null;
        return (
          <span
            key={s.label}
            title={`${s.label}: ${fmt(s.tokens)}`}
            className={cn("h-full", s.bar)}
            style={{ width: `${w}%` }}
          />
        );
      })}
    </div>
  );
}

// totalContextTokens mirrors what /context shows in the chat — every
// category contributes to the budget the SDK tracks against the model
// window, so the meter must agree with the /context view to avoid
// confusing the user (40% in /context, "<1%" on the meter).
function totalContextTokens(u?: SessionUsage): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

function fmt(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function pctLabel(pct: number): string {
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}
