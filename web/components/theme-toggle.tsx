"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "@/lib/theme-context";
import { cn } from "@/lib/utils";

// Compact 3-segment toggle: light / system / dark. Sized to slot inside
// the sidebar footer next to the AccountChip without dominating the row.
// Uses radiogroup semantics so screen readers announce the active mode.
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-background/60 p-0.5",
        className,
      )}
    >
      <Segment mode="light" current={mode} onClick={() => setMode("light")}>
        <Sun className="size-3.5" aria-hidden />
        <span className="sr-only">Light</span>
      </Segment>
      <Segment mode="system" current={mode} onClick={() => setMode("system")}>
        <Monitor className="size-3.5" aria-hidden />
        <span className="sr-only">System</span>
      </Segment>
      <Segment mode="dark" current={mode} onClick={() => setMode("dark")}>
        <Moon className="size-3.5" aria-hidden />
        <span className="sr-only">Dark</span>
      </Segment>
    </div>
  );
}

interface SegmentProps {
  mode: ThemeMode;
  current: ThemeMode;
  onClick: () => void;
  children: React.ReactNode;
}

function Segment({ mode, current, onClick, children }: SegmentProps) {
  const active = mode === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      title={mode === "system" ? "Match OS" : mode === "dark" ? "Dark" : "Light"}
      className={cn(
        "flex size-6 items-center justify-center rounded-sm transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
