"use client";

import { useState } from "react";
import { ChevronUp, Globe2, Users } from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import { Progress } from "@/components/ui/progress";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AccountsDialog } from "@/components/accounts-dialog";
import { NetworkDialog } from "@/components/network-dialog";
import { useSidebar } from "@/lib/sidebar-context";

// AccountChip lives at the sidebar bottom. Tapping pops a small menu
// with two entries: the Accounts modal (Claude OAuth identities,
// quotas, swaps) and the Network dialog (LAN + Cloudflare tunnel).
// Splitting the two halves keeps each modal short enough to read on a
// phone — the combined view was getting unwieldy.
export function AccountChip() {
  const { snapshot, status } = useDaemonContext();
  const [popOpen, setPopOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const { setOpen: setSidebarOpen, isMobile } = useSidebar();

  const active = snapshot?.accounts.find((a) => a.active);
  const initial = (active?.name ?? "?").slice(0, 1).toUpperCase();
  const utilPct =
    active?.five_hour ? Math.round(active.five_hour.utilization) : null;

  const openDialog = (which: "accounts" | "network") => {
    setPopOpen(false);
    if (which === "accounts") setAccountsOpen(true);
    else setNetworkOpen(true);
    // Mobile: dismiss the drawer when the user picks a setting so the
    // dialog isn't fighting the sidebar for screen space (the dialog
    // overlay would otherwise cover the still-open drawer).
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <>
      <Popover open={popOpen} onOpenChange={setPopOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Open settings"
              className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
            />
          }
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
        </PopoverTrigger>
        <PopoverContent
          // Anchor the menu directly above the chip so the eye lands
          // on it without traversing — and so the chevron's "up"
          // direction matches the popover's growth direction.
          side="top"
          align="start"
          className="w-[15rem] p-1"
        >
          <MenuItem
            icon={<Users className="size-4" aria-hidden />}
            label="Accounts"
            description={
              snapshot
                ? `${snapshot.accounts.length} account${snapshot.accounts.length === 1 ? "" : "s"} · swap, login, quotas`
                : "Manage Claude OAuth identities"
            }
            onClick={() => openDialog("accounts")}
          />
          <MenuItem
            icon={<Globe2 className="size-4" aria-hidden />}
            label="Network access"
            description="Expose to LAN or via Cloudflare tunnel"
            onClick={() => openDialog("network")}
          />
        </PopoverContent>
      </Popover>
      <AccountsDialog open={accountsOpen} onOpenChange={setAccountsOpen} />
      <NetworkDialog open={networkOpen} onOpenChange={setNetworkOpen} />
    </>
  );
}

function MenuItem({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
