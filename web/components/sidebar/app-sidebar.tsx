"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { History, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { SessionsProvider } from "@/lib/sessions-context";
import { useSidebar } from "@/lib/sidebar-context";
import { SessionsList } from "./sessions-list";
import { AccountChip } from "./account-chip";
import { AttentionIndicator } from "./attention-indicator";
import { RestoreSessionDialog } from "./restore-session-dialog";

// AppSidebar: 18rem (288px) rail. Desktop pins it inline as a flex
// child. Mobile turns it into a fixed-position drawer that slides in
// from the left over the chat panel — controlled by SidebarContext.
export function AppSidebar() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const { open, setOpen } = useSidebar();
  const [restoreOpen, setRestoreOpen] = useState(false);

  return (
    <SessionsProvider>
      {/* Background-only effects: title prefix + favicon badge for
          sessions that need user input. Renders nothing — placement
          inside SessionsProvider is what matters. */}
      <AttentionIndicator />
      <aside
        // Three layout modes, picked by Tailwind responsive prefixes:
        //   - desktop (md+): static flex child, always visible
        //   - mobile open: fixed drawer at left, full height, slid in
        //   - mobile closed: fixed drawer translated -100% off-screen
        // The `max-md:-translate-x-full` is keyed on a media query
        // (not React state), so the closed-on-mobile style applies on
        // the very first paint — no SSR/hydration flash where the
        // drawer briefly covers the chat panel + composer (which had
        // been swallowing taps because `isMobile` started false).
        className={cn(
          "z-40 flex h-full w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground",
          "fixed inset-y-0 left-0 transition-transform duration-200 ease-out",
          "md:static md:translate-x-0 md:shadow-none",
          open ? "translate-x-0 shadow-2xl" : "max-md:-translate-x-full",
        )}
      >
        <div
          className="flex items-center justify-between gap-2 px-3 py-3"
          // Match the chat-panel header's safe-area dance so the
          // logo + close button clear the iOS notch on standalone
          // launches. No-op on browsers / Android (env returns 0).
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <Link
            href="/"
            aria-label="claude monitor — home"
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {/* Close button: only useful while the drawer is open on
                mobile; on desktop the rail is always pinned. */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              aria-label="Close sidebar"
              className="md:hidden"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex gap-1.5 px-3 pb-2">
          <Link
            href="/"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "flex-1 justify-start gap-2",
              isHome && "bg-sidebar-accent",
            )}
          >
            <Plus className="size-4" />
            New chat
          </Link>
          <Button
            variant="outline"
            size="icon"
            aria-label="Restore CLI session by ID"
            title="Restore a Claude Code CLI session by its ID"
            onClick={() => setRestoreOpen(true)}
          >
            <History className="size-4" />
          </Button>
        </div>
        <RestoreSessionDialog
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
        />

        <div className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Sessions
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <SessionsList />
        </div>

        <div
          className="border-t p-2"
          // Reserve space for the iOS home-indicator so the AccountChip
          // doesn't get clipped under the gesture bar when the drawer
          // is the full mobile viewport.
          style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          <AccountChip />
        </div>
      </aside>
    </SessionsProvider>
  );
}
