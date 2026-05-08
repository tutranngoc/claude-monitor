"use client";

import { type ReactNode } from "react";
import { DaemonProvider } from "@/lib/daemon-context";
import { AppSidebar } from "@/components/sidebar/app-sidebar";

// WorkspaceShell is the persistent sidebar+main layout. It wraps every
// rendered page (root layout puts it around `children`), so navigating
// between /, /chat/[id] etc. preserves the sidebar without remounting it.
export function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <DaemonProvider>
      <div className="flex h-dvh min-h-0 w-full">
        <AppSidebar />
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </DaemonProvider>
  );
}
