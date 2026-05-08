"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useDaemon } from "@/hooks/use-daemon";
import type { ConnectionStatus } from "@/hooks/use-daemon";
import type { DaemonError, Snapshot, SwapEvent } from "@/lib/daemon";

interface DaemonContextValue {
  snapshot: Snapshot | null;
  swapEvents: SwapEvent[];
  errors: DaemonError[];
  status: ConnectionStatus;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

// One EventSource per browser tab. Without a context, every consumer
// (sidebar chip, accounts dialog, new-chat button) would call useDaemon()
// and open a separate stream — same payload, multiplied browser load.
export function DaemonProvider({ children }: { children: ReactNode }) {
  const value = useDaemon();
  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemonContext(): DaemonContextValue {
  const ctx = useContext(DaemonContext);
  if (!ctx) {
    throw new Error("useDaemonContext must be used within <DaemonProvider>");
  }
  return ctx;
}
