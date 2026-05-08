"use client";

import { useState } from "react";
import { ChevronUp } from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import { Progress } from "@/components/ui/progress";
import { AccountsDialog } from "@/components/accounts-dialog";

// AccountChip lives at the sidebar bottom. Shows the active account's
// initial + name + 5h util. Click → AccountsDialog for full management.
// When the daemon is offline or no account is active we still render a
// chip — the dialog explains the state.
export function AccountChip() {
  const { snapshot, status } = useDaemonContext();
  const [open, setOpen] = useState(false);

  const active = snapshot?.accounts.find((a) => a.active);
  const initial = (active?.name ?? "?").slice(0, 1).toUpperCase();
  const utilPct =
    active?.five_hour ? Math.round(active.five_hour.utilization) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
      >
        <div className="relative">
          <div className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
            {initial}
          </div>
          <span
            aria-hidden
            className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar ${
              status === "open"
                ? "bg-emerald-500"
                : status === "connecting"
                  ? "bg-amber-500"
                  : "bg-destructive"
            }`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {active?.name ?? "No active account"}
          </div>
          {utilPct !== null ? (
            <div className="flex items-center gap-1.5">
              <Progress value={Math.min(utilPct, 100)} className="h-1 flex-1" />
              <span className="tabular-nums text-[10px] text-muted-foreground">
                {utilPct}%
              </span>
            </div>
          ) : (
            <div className="truncate text-[11px] text-muted-foreground">
              {snapshot
                ? `${snapshot.accounts.length} account${snapshot.accounts.length === 1 ? "" : "s"}`
                : status === "error"
                  ? "Daemon offline"
                  : "Connecting…"}
            </div>
          )}
        </div>
        <ChevronUp className="size-4 shrink-0 opacity-60 transition-opacity group-hover:opacity-100" />
      </button>
      <AccountsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
