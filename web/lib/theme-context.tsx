"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

// Three modes mirror what most apps converge on: explicit light, explicit
// dark, and "follow the OS". Persisted in localStorage under STORAGE_KEY
// so the inline init script in layout.tsx can read the same key without
// import cycles.
export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: ThemeMode;
  // The currently *applied* theme. `mode` of "system" resolves to either
  // light or dark depending on prefers-color-scheme. Components that just
  // need to know what's painting now should read `resolved` rather than
  // re-implementing the OS query themselves.
  resolved: "light" | "dark";
  setMode: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "cm:theme";
// Custom same-tab event: localStorage's native "storage" event only
// fires in OTHER tabs, so writes in the current tab need a manual
// dispatch to wake other subscribers.
const STORAGE_EVENT = "cm:theme-change";

// Server snapshot is intentionally "system" / false. The inline script
// in <head> paints the right .dark class before React hydrates, so the
// initial paint already matches user preference; React's first hydration
// pass uses these constants to align with the (light) server-rendered
// markup, then useSyncExternalStore swaps to client snapshots after
// hydration without firing a mismatch warning.
function readMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function subscribeMode(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_EVENT, callback);
  };
}

function readOsDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function subscribeOsDark(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Both reads route through useSyncExternalStore so server + first-
  // client hydration return the same values (the server snapshots),
  // then both swap to the real client values after hydration without
  // a hydration warning.
  const mode = useSyncExternalStore(
    subscribeMode,
    readMode,
    () => "system" as ThemeMode,
  );
  const osDark = useSyncExternalStore(
    subscribeOsDark,
    readOsDark,
    () => false,
  );
  const resolved: "light" | "dark" =
    mode === "system" ? (osDark ? "dark" : "light") : mode;

  // The inline init script already painted the right .dark class before
  // React hydrated. We skip the very first effect run so that "first
  // commit with server snapshot still in effect" doesn't toggle the
  // class off and back on (which would flash light → dark for users
  // who actually have dark mode persisted).
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setMode = useCallback((m: ThemeMode) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, m);
    // Wake same-tab subscribers — setItem doesn't fire "storage"
    // locally, only in other tabs.
    window.dispatchEvent(new Event(STORAGE_EVENT));
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

// Inline script string that runs before React hydrates. Reads the stored
// preference and toggles the .dark class on <html> synchronously, so the
// page never paints in the wrong theme during the SSR-to-hydration window.
export const THEME_INIT_SCRIPT = `
(function(){
  try {
    var stored = localStorage.getItem("${STORAGE_KEY}");
    var mode = (stored === "light" || stored === "dark" || stored === "system") ? stored : "system";
    var dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (_) {}
})();
`.trim();
