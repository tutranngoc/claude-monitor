"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

// SidebarContext drives the mobile drawer behavior. Desktop (>= md)
// always shows the rail; mobile starts collapsed and slides in on
// demand. The `open` boolean is only meaningful below `md` — desktop
// ignores it.
interface SidebarValue {
  open: boolean;
  isMobile: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarValue | null>(null);

const MOBILE_BREAKPOINT = "(max-width: 767.98px)";

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();

  // Track the breakpoint with matchMedia so the drawer auto-closes
  // when the user rotates / resizes past md and the rail becomes
  // permanently visible. Avoids leaving the backdrop stuck open.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(MOBILE_BREAKPOINT);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Auto-close on route change (mobile only). Desktop keeps the rail
  // pinned; toggling there would just be churn.
  useEffect(() => {
    if (isMobile) setOpen(false);
  }, [pathname, isMobile]);

  // Lock body scroll while the drawer is open on mobile so the page
  // behind doesn't bounce around when the user drags inside the
  // sidebar. Restored on close / unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (isMobile && open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isMobile, open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const value = useMemo<SidebarValue>(
    () => ({ open, isMobile, setOpen, toggle }),
    [open, isMobile, toggle],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    // Outside the provider we noop — safer than throwing on a stray
    // call, since the chat panel might render in storybook / tests
    // without the shell.
    return {
      open: false,
      isMobile: false,
      setOpen: () => {},
      toggle: () => {},
    };
  }
  return ctx;
}
