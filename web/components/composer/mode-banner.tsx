"use client";

import { cn } from "@/lib/utils";
import type { PermissionMode } from "@/lib/chat-types";
import {
  isDefaultPermissionMode,
  permissionModeSymbol,
  permissionModeTitle,
  permissionModeTone,
  type ModeTone,
} from "@/lib/permission-mode";

interface Props {
  mode: PermissionMode;
}

// ModeBanner mirrors the Claude Code CLI's footer line that announces
// the active permission mode (e.g. "⏸ plan mode on (shift+tab to
// cycle)"). It renders just above the composer textarea and disappears
// when the user is in default mode — so the chrome stays out of the
// way until a non-default stance is engaged.
export function ModeBanner({ mode }: Props) {
  if (isDefaultPermissionMode(mode)) return null;
  const tone = permissionModeTone(mode);
  const symbol = permissionModeSymbol(mode);
  const title = permissionModeTitle(mode).toLowerCase();
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "mx-2 mt-2 flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11px] font-medium",
        toneClasses(tone),
      )}
    >
      <span aria-hidden className="font-mono">
        {symbol}
      </span>
      <span>{title} on</span>
      <span className="ml-auto opacity-70">
        <kbd className="rounded border border-current/30 px-1 py-px font-mono text-[10px]">
          shift+tab
        </kbd>{" "}
        to cycle
      </span>
    </div>
  );
}

function toneClasses(tone: ModeTone): string {
  switch (tone) {
    case "info":
      return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "warn":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "danger":
      return "border-destructive/45 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}
