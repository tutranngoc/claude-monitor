"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDaemon } from "@/hooks/use-daemon";
import { Button } from "@/components/ui/button";
import type { SessionSummary } from "@/lib/chat-types";

// NewSessionButton creates a chat session targeting whichever account
// the daemon currently reports as active. cwd defaults server-side to
// the claude-monitor repo root (parent of web/). Worktree picker is M4.
export function NewSessionButton() {
  const { snapshot, status: daemonStatus } = useDaemon();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = snapshot?.accounts.find((a) => a.active);
  const disabled = busy || !active;

  const onClick = async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config_dir: active.config_dir,
          account_name: active.name,
        }),
      });
      if (!res.ok) {
        throw new Error(`${res.status}: ${await res.text()}`);
      }
      const summary = (await res.json()) as SessionSummary;
      router.push(`/chat/${summary.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={onClick} disabled={disabled}>
        {busy ? "Starting…" : "New session"}
      </Button>
      <div className="text-xs text-muted-foreground">
        {daemonStatus !== "open"
          ? "Waiting for daemon…"
          : active
            ? `→ ${active.name}`
            : "No active account"}
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
