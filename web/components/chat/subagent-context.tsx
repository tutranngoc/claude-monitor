"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentSummary } from "@/lib/chat-types";

// SubagentContext threads the derived subagent grouping plus per-card
// expand/collapse state through the chat viewport so MessageBubble can
// swap a Task tool_use for a SubagentCard without drilling props from
// ChatPanel through every intermediate component.

interface SubagentContextValue {
  byTaskId: Map<string, SubagentSummary>;
  childrenByTaskId: Map<string, SDKMessage[]>;
  resultTaskIds: Set<string>;
  isExpanded: (taskId: string) => boolean;
  toggleExpanded: (taskId: string) => void;
  // setExpanded is called from outside the viewport (e.g. the sidebar
  // tree clicks) so the corresponding card opens when the user lands.
  setExpanded: (taskId: string, open: boolean) => void;
}

const Ctx = createContext<SubagentContextValue | null>(null);

export function SubagentProvider({
  byTaskId,
  childrenByTaskId,
  resultTaskIds,
  children,
}: {
  byTaskId: Map<string, SubagentSummary>;
  childrenByTaskId: Map<string, SDKMessage[]>;
  resultTaskIds: Set<string>;
  children: ReactNode;
}) {
  const [expanded, setExpandedState] = useState<Set<string>>(() => new Set());

  const isExpanded = useCallback((taskId: string) => expanded.has(taskId), [expanded]);

  const toggleExpanded = useCallback((taskId: string) => {
    setExpandedState((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const setExpanded = useCallback((taskId: string, open: boolean) => {
    setExpandedState((prev) => {
      const has = prev.has(taskId);
      if (open === has) return prev;
      const next = new Set(prev);
      if (open) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  // Hash-driven auto-expand: when the user navigates from the sidebar
  // tree the URL ends with #subagent-<task_id>. We expand the matching
  // card on mount, on hash change, and any time the byTaskId map gains
  // a new entry that matches the current hash (covers the case where
  // history catches up after the navigation lands).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#subagent-")) return;
      const taskId = hash.slice("#subagent-".length);
      if (taskId && byTaskId.has(taskId)) {
        setExpanded(taskId, true);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [byTaskId, setExpanded]);

  const value = useMemo<SubagentContextValue>(
    () => ({
      byTaskId,
      childrenByTaskId,
      resultTaskIds,
      isExpanded,
      toggleExpanded,
      setExpanded,
    }),
    [byTaskId, childrenByTaskId, resultTaskIds, isExpanded, toggleExpanded, setExpanded],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// useSubagents returns the live grouping if a SubagentProvider is on the
// tree, or null when there isn't one. Returning null lets MessageBubble
// fall back to its pre-Phase-2 behavior (rendering Task as a regular
// ToolUseLine) when used outside a chat viewport.
export function useSubagents(): SubagentContextValue | null {
  return useContext(Ctx);
}
