"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/chat-types";

// Sidebar's session list. Refetches when the route changes so a freshly
// created chat appears the moment we navigate into it. Without a server-
// pushed list we accept the small delay; sessions don't move that often.
export function SessionsList() {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/chat", { signal: ctrl.signal });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { sessions: SessionSummary[] };
        if (!cancelled) setSessions(data.sessions);
      } catch {
        // Aborted or transient — let the next refresh recover.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [pathname]);

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

  return (
    <Link
      href={`/chat/${session.id}`}
      className={cn(
        "group/row flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60",
      )}
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
      className={cn("mt-1.5 inline-block size-1.5 shrink-0 rounded-full", color)}
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
