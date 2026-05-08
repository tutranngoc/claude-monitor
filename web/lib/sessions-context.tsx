"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import type { SessionSummary } from "@/lib/chat-types";

interface SessionsContextValue {
  sessions: SessionSummary[];
  loaded: boolean;
  refresh: () => void;
}

const SessionsContext = createContext<SessionsContextValue | null>(null);

// SessionsProvider centralises the /api/chat polling so the sidebar's
// running-tasks panel and the full sessions list share one fetch instead
// of each opening their own. Refetches when the pathname changes (a new
// chat just landed) and when useChatSession dispatches the
// cm:session-subagents window event (subagent state moved).
export function SessionsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Coalesce rapid-fire fetches: every assistant turn during a subagent's
  // run flips the fingerprint, but we only need ~250ms granularity.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/chat", { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[] };
      setSessions(data.sessions);
    } catch {
      // Aborted or transient. Next refresh recovers.
    }
  }, []);

  // Initial + route-change refresh.
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    void (async () => {
      await fetchOnce(ctrl.signal);
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [pathname, fetchOnce]);

  // Subagent-update event from useChatSession. Debounced so a burst of
  // tool_use deltas doesn't slam the API.
  useEffect(() => {
    const onUpdate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchOnce();
      }, 250);
    };
    window.addEventListener("cm:session-subagents", onUpdate);
    return () => {
      window.removeEventListener("cm:session-subagents", onUpdate);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchOnce]);

  // Also poll on a slow timer so a session whose status flipped from
  // thinking->idle while we were on a different chat shows up without
  // forcing the user to navigate. 5s is fast enough to feel responsive
  // and slow enough to not thrash the daemon.
  useEffect(() => {
    const id = setInterval(() => void fetchOnce(), 5000);
    return () => clearInterval(id);
  }, [fetchOnce]);

  const refresh = useCallback(() => void fetchOnce(), [fetchOnce]);

  return (
    <SessionsContext.Provider value={{ sessions, loaded, refresh }}>
      {children}
    </SessionsContext.Provider>
  );
}

export function useSessions(): SessionsContextValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used within SessionsProvider");
  return ctx;
}

// stopSession asks the API to terminate a session. Returns true on
// success so the caller can update local state optimistically.
export async function stopSessionRemote(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/chat/${sessionId}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}
