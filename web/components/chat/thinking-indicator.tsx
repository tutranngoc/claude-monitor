"use client";

import { useEffect, useState } from "react";

// ThinkingIndicator fills the dead air between "user just sent" and the
// first streamed delta. Without it the UI looks frozen for the few
// seconds the API takes to start producing tokens, and users assume the
// app crashed. Three rotating verbs (Thinking / Working / Reasoning)
// also signal progress so the indicator doesn't go stale-feeling.
const VERBS = ["Thinking", "Working", "Reasoning"] as const;

export function ThinkingIndicator({
  variant = "default",
}: {
  // "default" matches the assistant message bubble; "compact" is sized
  // for inline footer usage (under the composer). Both look identical
  // visually, just slightly different padding.
  variant?: "default" | "compact";
}) {
  const [verbIdx, setVerbIdx] = useState(0);

  // Rotate the verb every 2.5s. Slow enough to read, fast enough to
  // signal continuous progress. Cleared on unmount so the timer doesn't
  // outlive the indicator.
  useEffect(() => {
    const id = setInterval(() => {
      setVerbIdx((i) => (i + 1) % VERBS.length);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  const verb = VERBS[verbIdx];

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        variant === "compact"
          ? "inline-flex items-center gap-2 text-xs text-muted-foreground"
          : "inline-flex items-center gap-2 rounded-md bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm"
      }
    >
      {/* Three pulsing dots in a row, each delayed so they appear to
          chase one another. Tailwind's animate-bounce is too tall for
          inline use; we use a custom keyframe via opacity instead. */}
      <span className="flex gap-1" aria-hidden>
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </span>
      <span className="tabular-nums">{verb}…</span>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block size-1.5 rounded-full bg-muted-foreground/70"
      style={{
        animation: "cm-thinking-pulse 1s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}
