"use client";

import { type ReactNode } from "react";
import { DaemonProvider } from "@/lib/daemon-context";
import { SidebarProvider, useSidebar } from "@/lib/sidebar-context";
import { AppSidebar } from "@/components/sidebar/app-sidebar";

// WorkspaceShell is the persistent sidebar+main layout. It wraps every
// rendered page (root layout puts it around `children`), so navigating
// between /, /chat/[id] etc. preserves the sidebar without remounting it.
//
// Desktop: side-by-side rail + main. Mobile: rail becomes a slide-in
// drawer driven by SidebarContext (open=false hides off-screen).
// Backdrop and outside-click handling live here so the sidebar
// component itself stays focused on its own content.
export function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <DaemonProvider>
      <SidebarProvider>
        <ShellLayout>{children}</ShellLayout>
      </SidebarProvider>
    </DaemonProvider>
  );
}

function ShellLayout({ children }: { children: ReactNode }) {
  const { open, setOpen } = useSidebar();
  return (
    // h-dvh tracks the dynamic viewport (iOS Safari shrinks/grows the
    // chrome) so the layout never gets clipped by the address bar
    // sliding back in. min-h-0 cascades through so internal scrollers
    // can flex shrink instead of pushing the body off-screen.
    <div className="relative flex h-dvh min-h-0 w-full">
      <AppSidebar />
      {/* Backdrop — painted only when the drawer is open AND the
          viewport is below md. The `md:hidden` keeps it off desktop
          even on the brief moment after a user resizes from mobile to
          desktop with the drawer open (SidebarProvider doesn't auto-
          close in that case to keep the user's intent). */}
      {open && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] md:hidden"
        />
      )}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
