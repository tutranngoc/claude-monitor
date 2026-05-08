"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { SessionsList } from "./sessions-list";
import { AccountChip } from "./account-chip";

// Fixed-width left rail. Layout grid in WorkspaceShell, not here, so the
// sidebar is just stacked content.
export function AppSidebar() {
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center px-3 py-3">
        <Link
          href="/"
          aria-label="claude monitor — home"
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo />
        </Link>
      </div>

      <div className="px-3 pb-2">
        <Link
          href="/"
          className={cn(
            buttonVariants({ variant: "outline" }),
            "w-full justify-start gap-2",
            isHome && "bg-sidebar-accent",
          )}
        >
          <Plus className="size-4" />
          New chat
        </Link>
      </div>

      <div className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Sessions
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <SessionsList />
      </div>

      <div className="border-t p-2">
        <AccountChip />
      </div>
    </aside>
  );
}
