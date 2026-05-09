"use client";

import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/lib/sidebar-context";
import { cn } from "@/lib/utils";

// SidebarTrigger is a small hamburger button that toggles the mobile
// drawer. Hidden on md+ where the rail is permanently pinned. Pages
// that have their own top-left affordance (chat panel header, home
// view) drop this in so users on phones can always reach the sidebar.
export function SidebarTrigger({ className }: { className?: string }) {
  const { open, toggle } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      onClick={toggle}
      aria-label={open ? "Close sidebar" : "Open sidebar"}
      aria-expanded={open}
      className={cn("md:hidden", className)}
    >
      <Menu className="size-5" />
    </Button>
  );
}
