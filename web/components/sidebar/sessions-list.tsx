"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionSummary, SubagentSummary } from "@/lib/chat-types";

// Sidebar's session list. Refetches when the route changes so a freshly
// created chat appears the moment we navigate into it. Also listens
// for `cm:session-subagents` window events fired by useChatSession so
// the subagent tree stays live as the active chat dispatches subagents.
export function SessionsList() {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Coalesce rapid-fire fetches — every assistant turn during a
  // subagent's run flips the fingerprint, but the sidebar only needs
  // one refresh per ~250ms to feel live.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/chat", { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[] };
      setSessions(data.sessions);
    } catch {
      // Aborted or transient — let the next refresh recover.
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    void (async () => {
      await refetch(ctrl.signal);
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [pathname, refetch]);

  useEffect(() => {
    const onUpdate = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refetch();
      }, 250);
    };
    window.addEventListener("cm:session-subagents", onUpdate);
    return () => {
      window.removeEventListener("cm:session-subagents", onUpdate);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refetch]);

  // Pull the active session id out of /chat/[id]. Avoids carrying the
  // pathname through every row.
  const activeId = pathname?.startsWith("/chat/")
    ? pathname.slice("/chat/".length).split("/")[0]
    : undefined;

  if (!loaded) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-xs text-muted-foreground">
        No sessions yet.
      </div>
    );
  }

  return (
    <ul className="space-y-0.5 px-1">
      {sessions.map((s) => (
        <li key={s.id}>
          <SessionRow session={s} active={s.id === activeId} />
        </li>
      ))}
    </ul>
  );
}

function SessionRow({
  session,
  active,
}: {
  session: SessionSummary;
  active: boolean;
}) {
  const title = session.title ?? "New chat";
  const subtitle = subtitleFor(session);
  const subagents = session.subagents ?? [];
  // Collapse subagent tree by default — most rows have at most a few
  // subagents and clutter compounds across many sessions. Active row
  // starts expanded so the user landing in /chat/[id] sees the tree
  // they presumably came to dig into.
  const [open, setOpen] = useState(active);

  return (
    <div className="group/row">
      <div
        className={cn(
          "relative flex items-start rounded-md transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60",
        )}
      >
        <Link
          href={`/chat/${session.id}`}
          className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-sm"
        >
          <MessageSquare className="mt-0.5 size-3.5 shrink-0 opacity-70" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate">{title}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </div>
          </div>
          <StatusDot status={session.status} />
        </Link>
        {subagents.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={
              open
                ? `Hide ${subagents.length} subagents`
                : `Show ${subagents.length} subagents`
            }
            className="flex shrink-0 items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>{subagents.length}</span>
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                open ? "rotate-0" : "-rotate-90",
              )}
              aria-hidden
            />
          </button>
        )}
      </div>

      {subagents.length > 0 && open && (
        <ul className="mt-0.5 ml-4 space-y-0.5 border-l border-border/60 pl-2">
          {subagents.map((sub) => (
            <li key={sub.task_id}>
              <SubagentRow sessionId={session.id} subagent={sub} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentRow({
  sessionId,
  subagent,
}: {
  sessionId: string;
  subagent: SubagentSummary;
}) {
  const heading = subagent.subagent_type ?? "subagent";
  const description = subagent.description?.trim();
  return (
    <Link
      href={`/chat/${sessionId}#subagent-${subagent.task_id}`}
      className="flex items-start gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
    >
      <SubagentDot status={subagent.status} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-mono">{heading}</div>
        {description && (
          <div className="truncate text-[10.5px] text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <span className="shrink-0 self-center font-mono text-[10px] text-muted-foreground">
        {subagent.tool_calls}
      </span>
    </Link>
  );
}

function SubagentDot({ status }: { status: SubagentSummary["status"] }) {
  const color =
    status === "errored"
      ? "bg-destructive"
      : status === "active"
        ? "bg-amber-500 animate-pulse"
        : "bg-emerald-500";
  return (
    <span
      title={status}
      className={cn("mt-1.5 inline-block size-1.5 shrink-0 rounded-full", color)}
    />
  );
}

function subtitleFor(s: SessionSummary): string {
  const when = relativeTime(s.created_at);
  if (s.account_name) return `${when} · ${s.account_name}`;
  return when;
}

function StatusDot({ status }: { status: SessionSummary["status"] }) {
  const color =
    status === "errored"
      ? "bg-destructive"
      : status === "thinking"
        ? "bg-amber-500"
        : status === "awaiting_permission"
          ? "bg-blue-500"
          : status === "closed"
            ? "bg-muted-foreground/40"
            : "bg-emerald-500";
  return (
    <span
      title={status.replace("_", " ")}
      className={cn("mt-2 mr-2 inline-block size-1.5 shrink-0 rounded-full", color)}
    />
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
