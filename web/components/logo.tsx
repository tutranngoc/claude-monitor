"use client";

import { cn } from "@/lib/utils";

// Brand orange. Picked to match the reference mock (a coral-shifted
// terracotta that reads as Claude-ish without being the literal API
// orange). Caller can override via the `accent` prop.
export const LOGO_ACCENT = "#E97451";

// 12 spokes around the burst, pre-computed at fixed 3-decimal precision
// to avoid SSR/CSR hydration drift. Each tuple is [innerX, innerY,
// outerX, outerY] for one ray; inner radius = 2, outer = 13.
const SPOKES: ReadonlyArray<readonly [number, number, number, number]> = [
  [2, 0, 13, 0],
  [1.732, 1, 11.258, 6.5],
  [1, 1.732, 6.5, 11.258],
  [0, 2, 0, 13],
  [-1, 1.732, -6.5, 11.258],
  [-1.732, 1, -11.258, 6.5],
  [-2, 0, -13, 0],
  [-1.732, -1, -11.258, -6.5],
  [-1, -1.732, -6.5, -11.258],
  [0, -2, 0, -13],
  [1, -1.732, 6.5, -11.258],
  [1.732, -1, 11.258, -6.5],
];

interface MarkProps {
  size?: number;
  // Override for the asterisk burst color. Frame + person inherit
  // currentColor so they pick up text color (sidebar foreground in
  // light mode, near-white in dark).
  accent?: string;
  className?: string;
}

// LogoMark renders just the iconograph — the rounded square frame with
// a Claude-style asterisk and a person-silhouette tucked into the
// bottom-right corner where the frame "opens up". Use this when text
// would crowd the surface (favicon, small chips, app icon).
export function LogoMark({
  size = 32,
  accent = LOGO_ACCENT,
  className,
}: MarkProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn(className)}
      role="img"
      aria-label="claude monitor"
    >
      {/* Frame: open rounded square. The ends near the bottom-right are
          where the person silhouette nestles in, so the corner reads as
          "monitor showing a person at the desk". */}
      <path
        d="M 56 80 L 25 80 Q 18 80 18 73 L 18 25 Q 18 18 25 18 L 75 18 Q 82 18 82 25 L 82 50"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />

      {/* Person silhouette — head circle + shoulder bow drops below the
          gap. Drawn AFTER the frame so the curve sits cleanly on top. */}
      <circle
        cx="71"
        cy="60"
        r="5"
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
      />
      <path
        d="M 60 80 C 60 68, 82 68, 82 80"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />

      {/* Claude burst — 12 evenly spaced spokes radiating from a small
          inner ring so the rays don't all kiss in the middle. The
          asymmetric placement (upper-left of center) sells the "monitor
          screen with content on it" rather than a perfectly centered
          medallion.

          Coordinates are pre-rounded to 3 decimals so SSR and CSR
          serialize the same string — Math.cos/sin can drift by a ULP
          between Node and V8, which trips React's hydration check. */}
      <g
        transform="translate(40 42)"
        stroke={accent}
        strokeWidth="3"
        strokeLinecap="round"
      >
        {SPOKES.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
    </svg>
  );
}

interface LogoProps {
  className?: string;
  // Render compact (mark only) on tight rails. Default lockup is mark +
  // wordmark. Useful for the sidebar collapsed state if/when we ship it.
  compact?: boolean;
  accent?: string;
}

// Logo is the full lockup: mark + "claude monitor" wordmark. The "claude"
// half stays foreground-colored so it adapts to light/dark, while
// "monitor" picks up the brand accent.
export function Logo({
  className,
  compact = false,
  accent = LOGO_ACCENT,
}: LogoProps) {
  if (compact) {
    return <LogoMark size={28} accent={accent} className={className} />;
  }
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={26} accent={accent} />
      <span className="text-base font-semibold tracking-tight leading-none">
        <span>claude</span>
        <span style={{ color: accent }}> monitor</span>
      </span>
    </span>
  );
}
