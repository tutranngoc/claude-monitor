"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase, PhaseSession } from "@/lib/plan-types";
import type { SessionStatus, SessionSummary } from "@/lib/chat-types";
import { Badge } from "@/components/ui/badge";
import { computeDagLayout, type DagNode } from "./dag-layout";

// PhaseRow mirrors the shape PhaseBoard already builds for its kanban
// columns. Duplicated locally because the canonical type is internal
// to phase-board.tsx and exporting it would re-trigger the file's
// monolith problem. The shape is small enough that drift risk is
// tolerable.
export interface DagPhaseRow {
  phase: Phase;
  link?: PhaseSession;
  session?: SessionSummary;
  blockedDeps: string[];
  isPending: boolean;
}

// onDepsChange persists a new depends_on list for `slug` (replacing,
// not patching). Returns a Promise so the view can show a saving state
// and surface server-side errors. Implemented in PhaseBoard against
// PATCH /api/plans/<id>/phases/<slug>/deps.
export interface DagDepsEditor {
  setDeps: (slug: string, deps: string[]) => Promise<void>;
  // Per-mutation error from the server. Cleared by the view when the
  // user starts a new drag or clicks dismiss.
  error?: string | null;
  onClearError?: () => void;
}

// DagView positions phases by dependency depth (left-to-right) and
// draws bezier edges from each phase to its dependents. Click a node
// to open its agent. Drag from a node's right-side handle onto another
// node to add an edge; click the × on an existing edge to remove it
// — both flows go through `editor.setDeps` which PATCHes the plan.
//
// Edge color reflects the source phase's session status so the user
// can trace blockers visually — a rose-tinted edge means the upstream
// phase is rate-limited / errored, an amber one means it's still
// thinking, etc.
export function DagView({
  rows,
  editor,
}: {
  rows: DagPhaseRow[];
  editor?: DagDepsEditor;
}) {
  const phases = useMemo(() => rows.map((r) => r.phase), [rows]);
  const layout = useMemo(() => computeDagLayout(phases), [phases]);
  const rowBySlug = useMemo(
    () => new Map(rows.map((r) => [r.phase.slug, r])),
    [rows],
  );
  const nodeBySlug = useMemo(
    () => new Map(layout.nodes.map((n) => [n.slug, n])),
    [layout.nodes],
  );

  // Card geometry: nodes consume ~88% of cell width and ~78% of cell
  // height, leaving gutter for edges and labels.
  const cardW = layout.cellW * 0.88;
  const cardH = layout.cellH * 0.78;

  const canvasRef = useRef<HTMLDivElement>(null);
  // While dragging, `dragFrom` is the source slug and `dragMouse` is
  // the current cursor position in canvas-local coordinates. The drag
  // captures pointer via setPointerCapture on the source handle, so
  // pointermove fires even when the cursor leaves the source card.
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [dragMouse, setDragMouse] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Slug of the card the user is hovering. Used to fade in × badges on
  // edges connected to that card so the affordance only appears when
  // the user is positioned to act on it.
  const [hovered, setHovered] = useState<string | null>(null);
  const [savingDeps, setSavingDeps] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const editingEnabled = !!editor?.setDeps;
  const visibleError = editor?.error ?? localError;
  const dismissError = useCallback(() => {
    setLocalError(null);
    editor?.onClearError?.();
  }, [editor]);

  // Cycle/self-loop pre-check, mirrors the server's rule. Lets the UI
  // refuse a drop at the boundary before any network round-trip.
  const wouldCycle = useCallback(
    (fromSlug: string, toSlug: string): boolean => {
      if (fromSlug === toSlug) return true;
      // Adding edge fromSlug → toSlug creates a cycle iff there's
      // already a path toSlug → fromSlug. Walk forward from toSlug
      // through existing edges (dep → phase).
      const adj = new Map<string, string[]>();
      for (const p of phases) {
        for (const dep of p.depends_on ?? []) {
          if (!adj.has(dep)) adj.set(dep, []);
          adj.get(dep)!.push(p.slug);
        }
      }
      const stack = [toSlug];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur === fromSlug) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of adj.get(cur) ?? []) stack.push(next);
      }
      return false;
    },
    [phases],
  );

  const beginDrag = useCallback(
    (e: React.PointerEvent<Element>, slug: string) => {
      if (!editingEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left + canvasRef.current!.scrollLeft : 0;
      const y = rect ? e.clientY - rect.top + canvasRef.current!.scrollTop : 0;
      setDragFrom(slug);
      setDragMouse({ x, y });
      setDragOver(null);
      dismissError();
    },
    [editingEnabled, dismissError],
  );

  const updateDragPos = useCallback(
    (clientX: number, clientY: number) => {
      const el = canvasRef.current;
      const rect = el?.getBoundingClientRect();
      if (!rect || !el) return;
      const x = clientX - rect.left + el.scrollLeft;
      const y = clientY - rect.top + el.scrollTop;
      setDragMouse({ x, y });
      // Hit-test against node rects in canvas coords.
      let hit: string | null = null;
      for (const n of layout.nodes) {
        if (
          x >= n.x &&
          x <= n.x + cardW &&
          y >= n.y &&
          y <= n.y + cardH
        ) {
          hit = n.slug;
          break;
        }
      }
      setDragOver(hit);
    },
    [layout.nodes, cardW, cardH],
  );

  const handleDragMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragFrom == null) return;
      updateDragPos(e.clientX, e.clientY);
    },
    [dragFrom, updateDragPos],
  );

  const finishDrag = useCallback(
    async (cancel: boolean) => {
      const from = dragFrom;
      const to = dragOver;
      setDragFrom(null);
      setDragMouse(null);
      setDragOver(null);
      if (cancel || !from || !to || from === to) return;
      const targetRow = rowBySlug.get(to);
      if (!targetRow) return;
      const existingDeps = targetRow.phase.depends_on ?? [];
      if (existingDeps.includes(from)) return; // already connected
      if (wouldCycle(from, to)) {
        setLocalError(
          `cannot add ${from} → ${to}: would create a cycle in depends_on`,
        );
        return;
      }
      setSavingDeps(to);
      try {
        await editor!.setDeps(to, [...existingDeps, from]);
      } catch {
        // Editor surfaces the server message via `editor.error`; nothing
        // for us to do here besides clearing the saving state below.
      } finally {
        setSavingDeps(null);
      }
    },
    [dragFrom, dragOver, rowBySlug, wouldCycle, editor],
  );

  const handleDragUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>) => {
      void finishDrag(false);
    },
    [finishDrag],
  );

  const handleDeleteEdge = useCallback(
    async (fromSlug: string, toSlug: string) => {
      if (!editor?.setDeps) return;
      const targetRow = rowBySlug.get(toSlug);
      if (!targetRow) return;
      const next = (targetRow.phase.depends_on ?? []).filter(
        (d) => d !== fromSlug,
      );
      setSavingDeps(toSlug);
      dismissError();
      try {
        await editor.setDeps(toSlug, next);
      } catch {
        // surfaced via editor.error
      } finally {
        setSavingDeps(null);
      }
    },
    [editor, rowBySlug, dismissError],
  );

  // Esc cancels an in-flight drag. Keyboard listener only mounts while
  // a drag is active so we don't leave stray handlers behind.
  useEffect(() => {
    if (dragFrom == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDragFrom(null);
        setDragMouse(null);
        setDragOver(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragFrom]);

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        no phases
      </div>
    );
  }

  // Compute drag-ghost endpoints and cycle hint up here so JSX stays flat.
  const dragSourceNode = dragFrom ? nodeBySlug.get(dragFrom) : undefined;
  const dragInvalid =
    !!dragFrom && !!dragOver && wouldCycle(dragFrom, dragOver);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {layout.hasCycle && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3.5" aria-hidden />
          <span>
            Cycle detected in <code className="font-mono">depends_on</code> —
            cycle members rendered at depth 0. Fix the plan to remove the loop.
          </span>
        </div>
      )}
      {visibleError && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="size-3.5" aria-hidden />
          <span className="flex-1">{visibleError}</span>
          <button
            type="button"
            className="rounded px-1 hover:bg-destructive/20"
            onClick={dismissError}
            aria-label="dismiss error"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      )}
      <div
        ref={canvasRef}
        className={cn(
          "min-h-0 flex-1 overflow-auto p-4",
          dragFrom && "select-none",
        )}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragUp}
        onPointerCancel={() => void finishDrag(true)}
      >
        <div
          className="relative"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            aria-hidden
          >
            <defs>
              <marker
                id="dag-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 0 L 10 5 L 0 10 z"
                  className="fill-muted-foreground/60"
                />
              </marker>
              <marker
                id="dag-arrow-ghost"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary/70" />
              </marker>
              <marker
                id="dag-arrow-invalid"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 0 L 10 5 L 0 10 z"
                  className="fill-destructive/80"
                />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const from = nodeBySlug.get(e.from);
              const to = nodeBySlug.get(e.to);
              if (!from || !to) return null;
              const fromX = from.x + cardW;
              const fromY = from.y + cardH / 2;
              const toX = to.x;
              const toY = to.y + cardH / 2;
              const dx = Math.max(40, (toX - fromX) / 2);
              const path = `M ${fromX} ${fromY} C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;
              const fromRow = rowBySlug.get(e.from);
              const fromStatus = fromRow?.session?.status;
              const fromCommit = fromRow?.link?.commit_status;
              const satisfied =
                fromCommit === "clean" || fromCommit === "committed";
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={path}
                  fill="none"
                  strokeWidth={1.5}
                  className={
                    satisfied
                      ? "stroke-emerald-500/60"
                      : edgeColor(fromStatus)
                  }
                  strokeDasharray={satisfied ? undefined : "4 3"}
                  markerEnd="url(#dag-arrow)"
                />
              );
            })}
            {dragSourceNode && dragMouse && (
              <path
                d={`M ${dragSourceNode.x + cardW} ${dragSourceNode.y + cardH / 2} L ${dragMouse.x} ${dragMouse.y}`}
                fill="none"
                strokeWidth={2}
                strokeDasharray="5 4"
                className={cn(
                  dragInvalid ? "stroke-destructive/80" : "stroke-primary/70",
                )}
                markerEnd={
                  dragInvalid
                    ? "url(#dag-arrow-invalid)"
                    : "url(#dag-arrow-ghost)"
                }
              />
            )}
          </svg>

          {layout.nodes.map((n) => {
            const row = rowBySlug.get(n.slug);
            if (!row) return null;
            const isDragOver = dragOver === n.slug && dragFrom !== n.slug;
            const wouldBeCycle =
              isDragOver && dragFrom != null && wouldCycle(dragFrom, n.slug);
            return (
              <DagNodeCard
                key={n.slug}
                node={n}
                row={row}
                width={cardW}
                height={cardH}
                onHoverChange={(slug, h) =>
                  setHovered((prev) => (h ? slug : prev === slug ? null : prev))
                }
                isDragSource={dragFrom === n.slug}
                isDragTarget={isDragOver && !wouldBeCycle}
                isDragInvalid={!!wouldBeCycle}
                isSaving={savingDeps === n.slug}
              />
            );
          })}

          {editingEnabled &&
            layout.nodes.map((n) => (
              <button
                key={`handle-${n.slug}`}
                type="button"
                className={cn(
                  "absolute z-10 flex h-6 w-3 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground active:cursor-grabbing",
                  dragFrom === n.slug && "bg-primary text-primary-foreground",
                )}
                style={{
                  left: n.x + cardW - 6,
                  top: n.y + cardH / 2,
                }}
                onPointerDown={(e) => beginDrag(e, n.slug)}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                title={`drag to add a phase that depends on ${n.slug}`}
                aria-label={`add dependency from ${n.slug}`}
              >
                <span
                  className="block size-1 rounded-full bg-current"
                  aria-hidden
                />
              </button>
            ))}

          {/* Edge delete badges: rendered as DOM buttons over the SVG so
              clicks land cleanly without fighting pointer-events on the
              SVG. Visible when either endpoint is hovered (or always if
              the user is currently saving the edge in question). */}
          {editingEnabled &&
            layout.edges.map((e) => {
              const from = nodeBySlug.get(e.from);
              const to = nodeBySlug.get(e.to);
              if (!from || !to) return null;
              const visible =
                hovered === e.from ||
                hovered === e.to ||
                savingDeps === e.to;
              const fromX = from.x + cardW;
              const fromY = from.y + cardH / 2;
              const toX = to.x;
              const toY = to.y + cardH / 2;
              // Approximate bezier midpoint by averaging the four
              // control points (start, c1, c2, end). Good enough for an
              // affordance — we don't need t=0.5 precision.
              const dx = Math.max(40, (toX - fromX) / 2);
              const mx = (fromX + (fromX + dx) + (toX - dx) + toX) / 4;
              const my = (fromY + fromY + toY + toY) / 4;
              return (
                <button
                  key={`x-${e.from}->${e.to}`}
                  type="button"
                  onClick={() => void handleDeleteEdge(e.from, e.to)}
                  className={cn(
                    "absolute z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-opacity hover:bg-destructive hover:text-destructive-foreground",
                    visible ? "opacity-100" : "pointer-events-none opacity-0",
                  )}
                  style={{ left: mx, top: my }}
                  title={`remove ${e.from} → ${e.to}`}
                  aria-label={`remove dependency ${e.from} → ${e.to}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              );
            })}
        </div>
      </div>
      {editingEnabled && (
        <div className="border-t bg-muted/30 px-4 py-1.5 text-[10px] text-muted-foreground">
          Drag from a phase's right-edge handle onto another phase to add a
          dependency. Hover a connected node and click × to remove an edge.
        </div>
      )}
    </div>
  );
}

function edgeColor(status: SessionStatus | undefined): string {
  if (!status) return "stroke-muted-foreground/40";
  if (status === "errored") return "stroke-destructive/70";
  if (status === "thinking") return "stroke-amber-500/70";
  if (status === "awaiting_permission") return "stroke-blue-500/60";
  if (status === "rate_limited") return "stroke-rose-500/70";
  if (status === "idle") return "stroke-emerald-500/60";
  return "stroke-muted-foreground/40";
}

interface DagNodeCardProps {
  node: DagNode;
  row: DagPhaseRow;
  width: number;
  height: number;
  onHoverChange: (slug: string, hovered: boolean) => void;
  isDragSource: boolean;
  isDragTarget: boolean;
  isDragInvalid: boolean;
  isSaving: boolean;
}

function DagNodeCard({
  node,
  row,
  width,
  height,
  onHoverChange,
  isDragSource,
  isDragTarget,
  isDragInvalid,
  isSaving,
}: DagNodeCardProps) {
  const { phase, link, session, blockedDeps, isPending } = row;
  const status = session?.status;
  const className = cn(
    "absolute flex flex-col gap-1 rounded-md border bg-background p-2 shadow-sm transition-colors",
    link && "hover:bg-muted/50",
    statusBorder(status),
    isDragSource && "ring-2 ring-primary/60",
    isDragTarget && "ring-2 ring-primary/80 ring-offset-2 ring-offset-background",
    isDragInvalid &&
      "ring-2 ring-destructive/80 ring-offset-2 ring-offset-background",
    isSaving && "opacity-70",
  );
  const style = { left: node.x, top: node.y, width, height };
  const inner = (
    <>
      <div className="flex items-start gap-1.5">
        <DagStatusDot status={status} />
        <Badge variant="outline" className="font-mono text-[10px]">
          {phase.slug}
        </Badge>
        {link && (
          <ArrowRight
            className="ml-auto size-3 text-muted-foreground/70"
            aria-hidden
          />
        )}
      </div>
      <div className="line-clamp-2 text-xs font-medium leading-snug">
        {phase.title}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1 text-[10px] font-mono text-muted-foreground">
        {isPending && (
          <span
            className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-700 dark:text-amber-300"
            title={
              blockedDeps.length > 0
                ? `blocked on ${blockedDeps.join(", ")}`
                : "waiting to spawn"
            }
          >
            {blockedDeps.length > 0
              ? `blocked: ${blockedDeps.join(",")}`
              : "blocked"}
          </span>
        )}
        {link?.commit_status && (
          <span
            className={cn(
              "rounded px-1 py-0.5",
              link.commit_status === "failed"
                ? "bg-destructive/10 text-destructive"
                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
            title={`commit: ${link.commit_status}`}
          >
            {link.commit_status === "committed"
              ? link.commit_sha?.slice(0, 7) ?? "committed"
              : link.commit_status}
          </span>
        )}
        {link?.review_status === "running" && (
          <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-700 dark:text-violet-300">
            reviewing…
          </span>
        )}
        {link?.review_status === "complete" &&
          (link.review_findings?.length ?? 0) > 0 && (
            <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-700 dark:text-violet-300">
              {link.review_findings!.length} finding
              {link.review_findings!.length === 1 ? "" : "s"}
            </span>
          )}
        {(link?.scope_violations?.length ?? 0) > 0 && (
          <span
            className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-700 dark:text-amber-300"
            title={link!.scope_violations!.join("\n")}
          >
            {link!.scope_violations!.length} out of scope
          </span>
        )}
      </div>
    </>
  );
  if (link) {
    return (
      <Link
        href={`/chat/${link.session_id}`}
        className={className}
        style={style}
        onMouseEnter={() => onHoverChange(phase.slug, true)}
        onMouseLeave={() => onHoverChange(phase.slug, false)}
        onClick={(e) => {
          // Suppress navigation while a deps mutation for this card is
          // in flight — clicking through mid-save would re-render with
          // stale state on the next page.
          if (isSaving) e.preventDefault();
        }}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div
      className={className}
      style={style}
      onMouseEnter={() => onHoverChange(phase.slug, true)}
      onMouseLeave={() => onHoverChange(phase.slug, false)}
    >
      {inner}
    </div>
  );
}

function statusBorder(status: SessionStatus | undefined): string {
  if (status === "errored") return "border-destructive/40";
  if (status === "thinking") return "border-amber-500/50";
  if (status === "awaiting_permission") return "border-blue-500/50";
  if (status === "rate_limited") return "border-rose-500/50";
  return "";
}

function DagStatusDot({ status }: { status: SessionStatus | undefined }) {
  const color = !status
    ? "bg-muted-foreground/40"
    : status === "errored"
      ? "bg-destructive"
      : status === "thinking"
        ? "bg-amber-500 animate-pulse"
        : status === "awaiting_permission"
          ? "bg-blue-500"
          : status === "rate_limited"
            ? "bg-rose-500 animate-pulse"
            : status === "idle"
              ? "bg-emerald-500"
              : status === "closed"
                ? "bg-muted-foreground/40"
                : "bg-muted-foreground/60";
  return (
    <span
      className={cn("mt-0.5 inline-block size-2 shrink-0 rounded-full", color)}
      title={status ? status.replace("_", " ") : "not started"}
    />
  );
}
