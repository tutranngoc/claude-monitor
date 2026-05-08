"use client";

import { useState } from "react";
import { Check, ChevronDown, Lock, Pencil, Play, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import type { PermissionMode } from "@/lib/chat-types";

// Re-export so existing import paths (`from "./mode-picker"`) keep working
// without each composer site touching chat-types.
export type { PermissionMode };

export interface ModeMeta {
  id: PermissionMode;
  label: string;
  short: string; // What renders in the closed pill — must fit ~14 chars.
  // One-line summary used inside the popover.
  hint: string;
  icon: typeof Lock;
  // Tone tag drives the chip background when active. acceptEdits is
  // amber (caution); bypassPermissions is destructive (full yolo).
  tone: "neutral" | "info" | "warn" | "danger";
}

const MODES: ModeMeta[] = [
  {
    id: "default",
    label: "Ask each time",
    short: "Default",
    hint: "Prompt before every tool — safest, most interruptions.",
    icon: Lock,
    tone: "neutral",
  },
  {
    id: "plan",
    label: "Plan mode",
    short: "Plan",
    hint: "Read-only research. Claude proposes a plan instead of executing.",
    icon: Sparkles,
    tone: "info",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    short: "Edits ✓",
    hint: "Auto-allow file edits. Bash and other risky tools still ask.",
    icon: Pencil,
    tone: "warn",
  },
  {
    id: "bypassPermissions",
    label: "Auto / Yolo",
    short: "Auto",
    hint: "Skip every prompt. Use only for trusted, sandboxed work.",
    icon: Play,
    tone: "danger",
  },
];

interface Props {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
}

// ModePicker is the segmented control that lives in the composer
// toolbar. Closed = compact pill showing the active mode; open =
// popover with all four modes + descriptions.
export function ModePicker({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];
  const Icon = active.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Permission mode: ${active.label}`}
            title={active.hint}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
              toneClasses(active.tone),
            )}
          />
        }
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span>{active.short}</span>
        <ChevronDown className="size-3 opacity-70" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-1.5">
        <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
          Permission mode
        </div>
        <ul className="space-y-0.5">
          {MODES.map((m) => {
            const I = m.icon;
            const isActive = m.id === mode;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded",
                      tonePillClasses(m.tone),
                    )}
                  >
                    <I className="size-3" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                      {m.label}
                      {isActive && (
                        <Check className="size-3 text-primary" aria-hidden />
                      )}
                    </span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">
                      {m.hint}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function toneClasses(tone: ModeMeta["tone"]): string {
  switch (tone) {
    case "info":
      return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/15";
    case "warn":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15";
    case "danger":
      return "border-destructive/45 bg-destructive/10 text-destructive hover:bg-destructive/15";
    default:
      return "border-border bg-muted/40 text-foreground hover:bg-muted";
  }
}

function tonePillClasses(tone: ModeMeta["tone"]): string {
  switch (tone) {
    case "info":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
    case "warn":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "danger":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}
