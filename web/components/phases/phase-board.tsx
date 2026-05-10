"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommit,
  BookText,
  GitMerge,
  KanbanSquare,
  Loader2,
  Megaphone,
  MessageSquareText,
  Network,
  Pause,
  Play,
  RotateCw,
  ScanLine,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  Phase,
  PhaseMergeResult,
  PhaseNote,
  PhasePending,
  PhaseSession,
  PlanIntegrationReviewStatus,
  PlanMergeStatus,
  PlanRecord,
  ReviewFinding,
  ReviewSeverity,
} from "@/lib/plan-types";
import {
  DEFAULT_MAX_CONCURRENT,
  MAX_MAX_CONCURRENT,
} from "@/lib/plan-types";
import type {
  ContextUsageBreakdown,
  RateLimitInfo,
  SessionStatus,
  SessionSummary,
} from "@/lib/chat-types";
import {
  actionHintForMaxTokens,
  classifyContextZone,
} from "@/lib/context-thresholds";
import { Badge } from "@/components/ui/badge";
import { DagView } from "./dag-view";

type Column = "todo" | "running" | "awaiting" | "done";
type BoardView = "kanban" | "dag";

// LocalStorage key for the per-plan view preference. Per-plan rather
// than global because plans differ — a 3-phase plan with no deps
// reads fine in kanban; a 12-phase plan with a layered DAG is the
// reason the dag view exists in the first place.
function viewStorageKey(planId: string): string {
  return `cm:phase-board:view:${planId}`;
}

// Same-tab notifier for the view-preference store. The browser only
// fires `storage` events on OTHER tabs by default; to make
// useSyncExternalStore re-read in the current tab after we write, we
// pump a dispatcher of our own that subscribers attach to.
const VIEW_PREF_EVENT = "cm:phase-board:view-changed";
const viewPrefBus =
  typeof window !== "undefined" ? new EventTarget() : undefined;

function readBoardView(planId: string): BoardView {
  try {
    const v = window.localStorage.getItem(viewStorageKey(planId));
    if (v === "dag" || v === "kanban") return v;
  } catch {
    // private mode / quota — ignore
  }
  return "kanban";
}

function writeBoardView(planId: string, view: BoardView): void {
  try {
    window.localStorage.setItem(viewStorageKey(planId), view);
  } catch {
    // ignore — preference just won't persist
  }
  viewPrefBus?.dispatchEvent(new CustomEvent(VIEW_PREF_EVENT));
}

function subscribeBoardView(notify: () => void): () => void {
  if (typeof window === "undefined" || !viewPrefBus) return () => {};
  const onCustom = () => notify();
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith("cm:phase-board:view:")) notify();
  };
  viewPrefBus.addEventListener(VIEW_PREF_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    viewPrefBus.removeEventListener(VIEW_PREF_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

interface PhaseRow {
  phase: Phase;
  link?: PhaseSession;
  session?: SessionSummary;
  // depends_on slugs that haven't reached commit_status ∈
  // {clean, committed} yet. Empty = phase is unblocked. Populated for
  // EVERY row (not just pending ones) so the depends_on chips can
  // colour-code satisfied vs unsatisfied edges.
  blockedDeps: string[];
  // True if the phase is in plan.pending_phases — i.e. approved but
  // not yet spawned because of unsatisfied deps. Mutually exclusive
  // with `link` in well-formed plans (the scheduler moves a phase
  // from pending → phase_sessions atomically).
  isPending: boolean;
}

const COLUMNS: { id: Column; label: string; tint: string }[] = [
  { id: "todo", label: "To start", tint: "border-muted-foreground/30" },
  { id: "running", label: "Running", tint: "border-amber-500/60" },
  { id: "awaiting", label: "Awaiting input", tint: "border-blue-500/60" },
  { id: "done", label: "Done / closed", tint: "border-emerald-500/60" },
];

// Stable DOM id for a phase row — used by NotesPanel to scroll into view
// when the user clicks a note's phase_slug. Kanban renders rows inside
// columns, DAG renders nodes; only the kanban path uses this anchor for
// now (the row card is the layout the user instinctively wants to jump
// to from a note). Slug is plan-unique by construction (validated at
// submit_plan time), so the id is unambiguous within the board.
function phaseRowDomId(slug: string): string {
  return `cm-phase-row-${slug}`;
}

// revealPhaseRow scrolls the row into view and pulses a violet ring for
// ~1.2s so the user's eye lands on it after a click. Briefly toggles
// data-phase-flash via attribute so the styling is colocated on the
// card instead of fighting React state. No-op if the row isn't in the
// DOM (e.g. user is on the dag view — fall back to scrolling the
// kanban tab into existence is out of scope for this slice).
function revealPhaseRow(slug: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.getElementById(phaseRowDomId(slug));
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.dataset.phaseFlash = "true";
  window.setTimeout(() => {
    delete el.dataset.phaseFlash;
  }, 1200);
  return true;
}

function bucketFor(status: SessionStatus | undefined): Column {
  if (!status) return "todo";
  if (status === "starting") return "todo";
  if (status === "thinking") return "running";
  if (status === "awaiting_permission" || status === "rate_limited") {
    // rate_limited groups under "awaiting" so the user notices at a
    // glance that this phase is paused (even though the SDK is auto-
    // retrying internally — the user-facing fact is "no progress").
    return "awaiting";
  }
  return "done"; // idle | closed | errored | interrupted — colored at row level
}

export function PhaseBoard({ plan: initialPlan }: { plan: PlanRecord }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // The page-level server component hydrates `initialPlan` once; the
  // commit/complete action mutates `phase_sessions[].commit_*` on the
  // server and returns the updated record. Mirror it locally so the
  // badge updates without a route nav. Plan id/cwd are immutable
  // post-approval; `phases` was too until the DAG view added drag-to-
  // edit deps — we now mirror that list as well so the new edges
  // appear immediately after a PATCH.
  const [phases, setPhases] = useState<Phase[]>(initialPlan.phases);
  const [phaseSessions, setPhaseSessions] = useState<PhaseSession[]>(
    initialPlan.phase_sessions ?? [],
  );
  // Pending phases — approved but not yet spawned because their
  // depends_on graph isn't settled. /complete returns an updated
  // plan whose pending_phases shrink as dependents are released.
  const [pendingPhases, setPendingPhases] = useState<PhasePending[]>(
    initialPlan.pending_phases ?? [],
  );
  const [pendingCompleteSlug, setPendingCompleteSlug] = useState<string | null>(
    null,
  );
  // Per-row pending state for the review kickoff click. Distinct from
  // pendingCompleteSlug because the buttons sit on the same row and we
  // don't want a spinner on one to imply both are in flight.
  const [pendingReviewSlug, setPendingReviewSlug] = useState<string | null>(
    null,
  );
  // Per-row pending state for the restart click. Same pattern as the
  // complete/review buttons: spinner only on the row whose POST is in
  // flight, so a slow restart on phase A doesn't gray out phase B's
  // affordances.
  const [pendingRestartSlug, setPendingRestartSlug] = useState<string | null>(
    null,
  );
  // Mirror the plan's merge fields locally so the panel updates without
  // a route nav after POST /merge returns. Default the input to the
  // last-used integration branch (or "main" on first run).
  const [mergeStatus, setMergeStatus] = useState<PlanMergeStatus | undefined>(
    initialPlan.merge_status,
  );
  const [mergeResults, setMergeResults] = useState<PhaseMergeResult[]>(
    initialPlan.merge_results ?? [],
  );
  const [mergeHeadSha, setMergeHeadSha] = useState<string | undefined>(
    initialPlan.merge_head_sha,
  );
  const [mergedAt, setMergedAt] = useState<string | undefined>(
    initialPlan.merged_at,
  );
  const [mergeError, setMergeError] = useState<string | undefined>(
    initialPlan.merge_error,
  );
  const [mergeBranch, setMergeBranch] = useState<string>(
    initialPlan.merge_branch ?? "main",
  );
  const [merging, setMerging] = useState(false);
  // Mirror plan.integration_review_* locally so the panel updates
  // without a route nav after POST /integration-review returns. The
  // poll below replaces phaseSessions AND splices these in too.
  const [integrationReview, setIntegrationReview] = useState<
    IntegrationReviewSnapshot
  >(snapshotIntegrationReview(initialPlan));
  const [integrationReviewPending, setIntegrationReviewPending] =
    useState(false);
  // Default-open the integration review panel when fresh findings or
  // an error land. Otherwise collapsed so the user can scan the plan
  // strip without a wall of text.
  const [integrationReviewOpen, setIntegrationReviewOpen] = useState<boolean>(
    () =>
      initialPlan.integration_review_status === "complete" &&
      ((initialPlan.integration_review_findings?.length ?? 0) > 0 ||
        !!initialPlan.integration_review_summary),
  );
  // Phase notes — sibling broadcasts written via the phase_notes MCP
  // tool. Append-only on the agent side; the plan-record poll below
  // refreshes the local mirror as new notes land. Default panel state
  // is open when the plan ships with un-dismissed notes (resumed view);
  // a plan whose every note is already acked stays collapsed so the
  // active feed doesn't reopen what the human has already triaged.
  const [phaseNotes, setPhaseNotes] = useState<PhaseNote[]>(
    initialPlan.notes ?? [],
  );
  const [notesOpen, setNotesOpen] = useState<boolean>(
    (initialPlan.notes ?? []).some((n) => !n.dismissed_at),
  );
  // Plan-level shared brief — sibling UI to the leader's
  // mcp__leader__record_shared_context tool. Both write to
  // plan.shared_brief on disk; the poll below mirrors back so an edit
  // through MCP shows up in the panel within ~3s, and vice versa.
  const [sharedBrief, setSharedBrief] = useState<string>(
    initialPlan.shared_brief ?? "",
  );
  const [sharedBriefUpdatedAt, setSharedBriefUpdatedAt] = useState<
    string | undefined
  >(initialPlan.shared_brief_updated_at);
  const [sharedBriefSaving, setSharedBriefSaving] = useState(false);
  const [sharedBriefError, setSharedBriefError] = useState<string | undefined>(
    undefined,
  );
  // Ref tracks the in-flight save so the polling refetchPlan callback
  // can skip mirroring during a write — closure-captured `sharedBriefSaving`
  // would be stale across the polling tick. Updated synchronously alongside
  // the state setter.
  const sharedBriefSavingRef = useRef(false);
  // Default-collapsed when no brief yet; default-open when one already
  // exists so resumed plans surface their context anchors immediately.
  const [sharedBriefOpen, setSharedBriefOpen] = useState<boolean>(
    !!initialPlan.shared_brief,
  );
  // Worker-pool controls. `maxConcurrent` mirrors plan.max_concurrent
  // (undefined → DEFAULT_MAX_CONCURRENT); `paused` mirrors plan.paused.
  // The PoolControls header strip writes to /settings; the cascade in
  // the /complete route reads these to decide whether to spawn next
  // phases. The poll mirrors back so MCP-driven edits (none today, but
  // possible) or other-tab edits propagate.
  const [maxConcurrent, setMaxConcurrent] = useState<number>(
    initialPlan.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
  );
  const [paused, setPaused] = useState<boolean>(!!initialPlan.paused);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | undefined>(
    undefined,
  );
  // Same pattern as sharedBriefSavingRef — refetchPlan is closed over
  // its initial state, so we use a ref to skip mirroring while a save
  // is in flight (otherwise the cap input flickers back to the
  // pre-save value mid-write).
  const settingsSavingRef = useRef(false);
  // Dismiss a note (or restore a dismissed one). Optimistic — the local
  // mirror flips immediately; a failed POST rolls back the timestamp.
  // The poll below would eventually overwrite either way, but rolling
  // back ourselves prevents a stale "I dismissed this" affordance from
  // lingering for ~3s when the server rejected the change.
  const planIdForFetch = initialPlan.id;
  const handleDismissNote = useCallback(
    async (noteId: string, dismiss: boolean) => {
      const stamp = dismiss ? new Date().toISOString() : undefined;
      let before: PhaseNote[] = [];
      setPhaseNotes((prev) => {
        before = prev;
        return prev.map((n) => {
          if (n.id !== noteId) return n;
          if (stamp) return { ...n, dismissed_at: stamp };
          const next: PhaseNote = { ...n };
          delete next.dismissed_at;
          return next;
        });
      });
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(planIdForFetch)}/notes/${encodeURIComponent(noteId)}/dismiss`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dismissed: dismiss }),
          },
        );
        if (!res.ok) {
          setPhaseNotes(before);
          return;
        }
        const data = (await res.json()) as { plan: PlanRecord };
        if (data.plan?.notes) {
          setPhaseNotes(data.plan.notes);
        }
      } catch {
        setPhaseNotes(before);
      }
    },
    [planIdForFetch],
  );
  // Save the shared brief. Optimistic on the server-confirmed timestamp:
  // we keep the user's textarea contents authoritative until the POST
  // resolves, then stamp updated_at from the response. Unlike
  // handleDismissNote we don't need a rollback path — the textarea
  // already shows what the user typed, and on failure we surface an
  // inline error rather than reverting their input.
  const handleSaveSharedBrief = useCallback(
    async (body: string) => {
      sharedBriefSavingRef.current = true;
      setSharedBriefSaving(true);
      setSharedBriefError(undefined);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(planIdForFetch)}/shared-brief`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setSharedBriefError(data.error ?? `save failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as { plan: PlanRecord };
        // Mirror back from server so updated_at reflects the canonical
        // timestamp; sharedBrief content is the same string we just sent
        // (trim happens server-side, so it may be slightly different).
        setSharedBrief(data.plan.shared_brief ?? "");
        setSharedBriefUpdatedAt(data.plan.shared_brief_updated_at);
      } catch (err) {
        setSharedBriefError(
          err instanceof Error ? err.message : "save failed",
        );
      } finally {
        sharedBriefSavingRef.current = false;
        setSharedBriefSaving(false);
      }
    },
    [planIdForFetch],
  );
  // Worker-pool settings save. Patches `max_concurrent` and/or `paused`
  // on the plan via /settings. Server returns the updated plan plus the
  // list of slugs the cap-bump or unpause just released — we mirror
  // pending_phases / phase_sessions back from the response so the
  // cascade-released phases show up immediately rather than waiting
  // ~3s for the next poll.
  const handleSetSettings = useCallback(
    async (patch: { maxConcurrent?: number | null; paused?: boolean }) => {
      settingsSavingRef.current = true;
      setSettingsSaving(true);
      setSettingsError(undefined);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(planIdForFetch)}/settings`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...("maxConcurrent" in patch
                ? { max_concurrent: patch.maxConcurrent }
                : {}),
              ...("paused" in patch ? { paused: patch.paused } : {}),
            }),
          },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setSettingsError(data.error ?? `save failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as { plan: PlanRecord };
        setMaxConcurrent(
          data.plan.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
        );
        setPaused(!!data.plan.paused);
        setPendingPhases(data.plan.pending_phases ?? []);
        setPhaseSessions(data.plan.phase_sessions ?? []);
      } catch (err) {
        setSettingsError(
          err instanceof Error ? err.message : "save failed",
        );
      } finally {
        settingsSavingRef.current = false;
        setSettingsSaving(false);
      }
    },
    [planIdForFetch],
  );
  // The "active" feed is what the user actually scans; dismissed notes
  // collapse out unless the panel reveals them via "show dismissed".
  // Pre-compute once so both the header counter and the panel agree on
  // what counts as live.
  const activeNotesCount = useMemo(
    () => phaseNotes.filter((n) => !n.dismissed_at).length,
    [phaseNotes],
  );
  // View toggle: kanban (default — same swimlanes as before) or dag
  // (depends_on rendered as a left-to-right node graph). Preference
  // is remembered per-plan in localStorage so a user who reasons in
  // graph form for one plan doesn't have to re-toggle every visit.
  //
  // Backed by useSyncExternalStore against localStorage so the view is
  // hydration-safe (server snapshot returns "kanban", client snapshot
  // reads the saved value) and stays in sync across tabs.
  const initialPlanId = initialPlan.id;
  const view = useSyncExternalStore<BoardView>(
    subscribeBoardView,
    () => readBoardView(initialPlanId),
    () => "kanban",
  );
  const handleSetView = useCallback(
    (next: BoardView) => writeBoardView(initialPlanId, next),
    [initialPlanId],
  );

  // Poll /api/chat for live status. 1500ms is fast enough that a
  // running phase flips columns within a couple of frames after its
  // SDK message lands, slow enough that we don't drown the API.
  // Pause when the tab isn't visible to avoid background churn.
  const refetch = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/chat", { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[] };
      setSessions(data.sessions);
    } catch {
      // Aborted or transient — wait for the next tick.
    }
  }, []);

  // Refetch the canonical plan record. Used when a review is in flight
  // — the agent persists findings to disk asynchronously, so the only
  // way the UI sees them land is by re-reading. Cheaper than threading
  // an SSE channel for what is effectively a single-bit transition.
  const refetchPlan = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}`,
          { signal },
        );
        if (!res.ok) return;
        const next = (await res.json()) as PlanRecord;
        setPhaseSessions(next.phase_sessions ?? []);
        // Splice integration review fields too — they share the
        // poll's lifecycle (background agent writes to disk, UI reads
        // back).
        setIntegrationReview(snapshotIntegrationReview(next));
        // Notes also land async (any phase agent can append at any
        // time). Mirror them so the panel updates without a route nav.
        setPhaseNotes(next.notes ?? []);
        // Pending phases shrink as dependents spawn — keep mirror
        // current so blocked/cleared transitions surface promptly.
        setPendingPhases(next.pending_phases ?? []);
        // Phases.depends_on now mutates via /deps PATCH. The poll is
        // also where another tab's edit becomes visible to this one.
        setPhases(next.phases);
        // Shared brief mirrors what the leader's MCP tool wrote — the
        // panel stays read-aligned with disk even when an MCP edit
        // happened from a leader chat the user isn't currently looking at.
        // Skip the mirror while a save is in flight: the optimistic
        // local value is already what the user wants, and overwriting
        // with the pre-save server state mid-write would flicker the
        // textarea contents back. The post-save handler re-syncs.
        if (!sharedBriefSavingRef.current) {
          setSharedBrief(next.shared_brief ?? "");
          setSharedBriefUpdatedAt(next.shared_brief_updated_at);
        }
        if (!settingsSavingRef.current) {
          setMaxConcurrent(next.max_concurrent ?? DEFAULT_MAX_CONCURRENT);
          setPaused(!!next.paused);
        }
      } catch {
        // ignore; tick again
      }
    },
    [initialPlanId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") {
          void (async () => {
            await refetch();
          })();
        }
      }, 1500);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void (async () => {
          await refetch();
        })();
        start();
      } else {
        stop();
      }
    };
    void (async () => {
      await refetch(ctrl.signal);
    })();
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      ctrl.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refetch]);

  // Plan-record poll. Gated on either an in-flight review OR any
  // phase still actively executing — phase agents can append notes at
  // any time during their run via the phase_notes MCP tool, and the
  // only way the UI sees them land is by re-reading plan.json. Stops
  // once every phase has settled (idle/closed/errored) AND no review
  // is running, so an inert PhaseBoard doesn't pay the cost.
  const anyReviewRunning = useMemo(
    () =>
      phaseSessions.some((p) => p.review_status === "running") ||
      integrationReview.status === "running",
    [phaseSessions, integrationReview.status],
  );
  const anyPhaseActive = useMemo(() => {
    for (const s of sessions) {
      if (s.plan_id !== initialPlanId || !s.phase_slug) continue;
      const st = s.status;
      if (
        st === "starting" ||
        st === "thinking" ||
        st === "awaiting_permission" ||
        st === "rate_limited"
      ) {
        return true;
      }
    }
    return false;
  }, [sessions, initialPlanId]);
  const planPollActive = anyReviewRunning || anyPhaseActive;
  useEffect(() => {
    if (!planPollActive) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void (async () => {
          await refetchPlan();
        })();
      }
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(tick, 3000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
        start();
      } else {
        stop();
      }
    };
    void (async () => {
      await refetchPlan(ctrl.signal);
    })();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ctrl.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [planPollActive, refetchPlan]);

  const phaseRows = useMemo<PhaseRow[]>(() => {
    const sessionByPhaseSlug = new Map<string, SessionSummary>();
    for (const s of sessions) {
      if (s.plan_id === initialPlanId && s.phase_slug) {
        sessionByPhaseSlug.set(s.phase_slug, s);
      }
    }
    const linkByPhase = new Map<string, PhaseSession>(
      phaseSessions.map((p) => [p.phase_slug, p]),
    );
    const pendingSlugs = new Set(pendingPhases.map((p) => p.phase_slug));
    // Map dep slug → its commit_status (or undefined). Used to
    // partition each phase's depends_on into satisfied vs blocking.
    // Mirrors plan-scheduler.depsBlocking but on the client.
    const commitByDep = new Map<string, PhaseSession["commit_status"]>();
    for (const s of phaseSessions) {
      commitByDep.set(s.phase_slug, s.commit_status);
    }
    return phases.map((phase) => {
      const blockedDeps: string[] = [];
      for (const dep of phase.depends_on ?? []) {
        const status = commitByDep.get(dep);
        if (status !== "clean" && status !== "committed") {
          blockedDeps.push(dep);
        }
      }
      return {
        phase,
        link: linkByPhase.get(phase.slug),
        session: sessionByPhaseSlug.get(phase.slug),
        blockedDeps,
        isPending: pendingSlugs.has(phase.slug),
      };
    });
  }, [phaseSessions, pendingPhases, phases, sessions, initialPlanId]);

  // Fire the commit action and merge the server's updated PhaseSession
  // back into local state. We don't refetch the whole plan — the route
  // already returns the canonical phase_session, and replacing in place
  // keeps the row's transition animations smooth.
  const handleComplete = useCallback(
    async (slug: string) => {
      setPendingCompleteSlug(slug);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}/phases/${encodeURIComponent(slug)}/complete`,
          { method: "POST" },
        );
        if (!res.ok) {
          const detail = await res.text();
          console.error(
            `[phase-board] complete ${slug} failed:`,
            res.status,
            detail,
          );
          return;
        }
        const data = (await res.json()) as {
          plan: PlanRecord;
          phase_session?: PhaseSession;
          spawned_dependents?: string[];
        };
        setPhaseSessions(data.plan.phase_sessions ?? []);
        // Cascade may have released dependents — mirror the new
        // pending list so blocked phases that just spawned drop their
        // "blocked by" badges and pick up real session state from the
        // /api/chat poll on its next tick.
        setPendingPhases(data.plan.pending_phases ?? []);
      } catch (err) {
        console.error(`[phase-board] complete ${slug} threw:`, err);
      } finally {
        setPendingCompleteSlug(null);
      }
    },
    [initialPlanId],
  );

  // Kick a per-phase code review. Server runs the agent in the
  // background and writes findings to disk; the plan-record poll above
  // surfaces them as they land. POST returns 202 with the running
  // record so the badge flips immediately.
  const handleReview = useCallback(
    async (slug: string) => {
      setPendingReviewSlug(slug);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}/phases/${encodeURIComponent(slug)}/review`,
          { method: "POST" },
        );
        if (!res.ok && res.status !== 202) {
          const detail = await res.text();
          console.error(
            `[phase-board] review ${slug} failed:`,
            res.status,
            detail,
          );
          return;
        }
        const data = (await res.json()) as { plan: PlanRecord };
        setPhaseSessions(data.plan.phase_sessions ?? []);
      } catch (err) {
        console.error(`[phase-board] review ${slug} threw:`, err);
      } finally {
        setPendingReviewSlug(null);
      }
    },
    [initialPlanId],
  );

  // Restart a phase: tears down the old chat session, spawns a fresh
  // one in the same worktree with the same kickoff prompt. Server gates
  // by commit_status (refuses already-committed phases). On success the
  // session_id changes — the /api/chat poll picks up the new row on its
  // next tick, so we just splice the new phase_sessions slice locally.
  const handleRestart = useCallback(
    async (slug: string) => {
      if (pendingRestartSlug) return;
      // Confirm before stopping a live session — restart is destructive
      // for any in-flight model output. Errored/closed sessions don't
      // really have anything to lose, but a single confirm path is
      // simpler than branching on status.
      const ok = window.confirm(
        `Restart phase "${slug}"? The current chat session will be stopped and a fresh one will be spawned in the same worktree with the original kickoff prompt.`,
      );
      if (!ok) return;
      setPendingRestartSlug(slug);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}/phases/${encodeURIComponent(slug)}/restart`,
          { method: "POST" },
        );
        if (!res.ok) {
          const detail = await res.text();
          console.error(
            `[phase-board] restart ${slug} failed:`,
            res.status,
            detail,
          );
          return;
        }
        const data = (await res.json()) as { plan: PlanRecord };
        setPhaseSessions(data.plan.phase_sessions ?? []);
      } catch (err) {
        console.error(`[phase-board] restart ${slug} threw:`, err);
      } finally {
        setPendingRestartSlug(null);
      }
    },
    [initialPlanId, pendingRestartSlug],
  );

  // Plan-level merge — kicks the integration branch checkout +
  // `git merge --no-ff` per phase branch. Server returns the canonical
  // updated plan; we splice the merge fields into local state without
  // touching phaseSessions (the route doesn't mutate them).
  const handleMerge = useCallback(async () => {
    setMerging(true);
    setMergeError(undefined);
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(initialPlanId)}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ integration_branch: mergeBranch }),
        },
      );
      if (!res.ok) {
        let detail = await res.text();
        try {
          // Server returns {error, ineligible?} for gating failures.
          const parsed = JSON.parse(detail) as {
            error?: string;
            ineligible?: string[];
          };
          if (parsed.error) {
            detail = parsed.ineligible?.length
              ? `${parsed.error}: ${parsed.ineligible.join(", ")}`
              : parsed.error;
          }
        } catch {
          // not json — surface raw body
        }
        setMergeError(detail);
        return;
      }
      const data = (await res.json()) as { plan: PlanRecord };
      setMergeStatus(data.plan.merge_status);
      setMergeResults(data.plan.merge_results ?? []);
      setMergeHeadSha(data.plan.merge_head_sha);
      setMergedAt(data.plan.merged_at);
      setMergeError(data.plan.merge_error);
      if (data.plan.merge_branch) setMergeBranch(data.plan.merge_branch);
      // Server clears integration review on re-merge — mirror that
      // here so the panel doesn't keep showing stale findings against
      // the old diff range.
      setIntegrationReview(snapshotIntegrationReview(data.plan));
      setIntegrationReviewOpen(false);
    } catch (err) {
      console.error(`[phase-board] merge threw:`, err);
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }, [initialPlanId, mergeBranch]);

  // Plan-level integration review. Like /complete and /review, the
  // server runs the agent in the background and persists findings to
  // disk; the plan-record poll surfaces them as they land. POST
  // returns 202 with the running record so the badge flips
  // immediately. We open the findings panel by default for fresh
  // results so the user doesn't miss them — they can collapse it
  // again with the chevron.
  const handleIntegrationReview = useCallback(async () => {
    setIntegrationReviewPending(true);
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(initialPlanId)}/integration-review`,
        { method: "POST" },
      );
      if (!res.ok && res.status !== 202) {
        const detail = await res.text();
        console.error(
          `[phase-board] integration-review failed:`,
          res.status,
          detail,
        );
        return;
      }
      const data = (await res.json()) as { plan: PlanRecord };
      setIntegrationReview(snapshotIntegrationReview(data.plan));
      setIntegrationReviewOpen(true);
    } catch (err) {
      console.error(`[phase-board] integration-review threw:`, err);
    } finally {
      setIntegrationReviewPending(false);
    }
  }, [initialPlanId]);

  // Drag-to-edit deps in the DAG view. PATCH the new depends_on list
  // for `slug` and splice the server's canonical plan back into local
  // state so the graph re-lays out instantly. Errors flow through
  // depsError so DagView can surface them inline; cleared on the next
  // successful edit or by the user.
  const [depsError, setDepsError] = useState<string | null>(null);
  const setPhaseDeps = useCallback(
    async (slug: string, nextDeps: string[]) => {
      setDepsError(null);
      const res = await fetch(
        `/api/plans/${encodeURIComponent(initialPlanId)}/phases/${encodeURIComponent(slug)}/deps`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depends_on: nextDeps }),
        },
      );
      if (!res.ok) {
        let msg = `failed (${res.status})`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch {
          // body wasn't JSON — keep the status fallback
        }
        setDepsError(msg);
        throw new Error(msg);
      }
      const data = (await res.json()) as { plan: PlanRecord };
      setPhases(data.plan.phases);
      setPhaseSessions(data.plan.phase_sessions ?? []);
      setPendingPhases(data.plan.pending_phases ?? []);
    },
    [initialPlanId],
  );

  const buckets = useMemo(() => {
    const map: Record<Column, PhaseRow[]> = {
      todo: [],
      running: [],
      awaiting: [],
      done: [],
    };
    for (const row of phaseRows) {
      const col = row.session ? bucketFor(row.session.status) : "todo";
      map[col].push(row);
    }
    return map;
  }, [phaseRows]);

  // Merge gate — all phases must have a non-failed commit_status. We
  // mirror the server's check so the button can disable itself with a
  // clear hint instead of letting the user click into a 409. Counts
  // power the inline summary too.
  const mergeGate = useMemo(() => {
    const linkBySlug = new Map<string, PhaseSession>(
      phaseSessions.map((p) => [p.phase_slug, p]),
    );
    let ready = 0;
    const pending: string[] = [];
    for (const phase of phases) {
      const link = linkBySlug.get(phase.slug);
      const status = link?.commit_status;
      if (status === "clean" || status === "committed") {
        ready++;
      } else {
        pending.push(phase.slug);
      }
    }
    return {
      ready,
      total: phases.length,
      pending,
      eligible: pending.length === 0 && phases.length > 0,
    };
  }, [phaseSessions, phases]);

  const counters = useMemo(() => {
    const total = phaseRows.length;
    const running = buckets.running.length;
    const awaiting = buckets.awaiting.length;
    const done = phaseRows.filter(
      (r) => r.session?.status === "closed" || r.session?.status === "idle",
    ).length;
    const errored = phaseRows.filter(
      (r) => r.session?.status === "errored",
    ).length;
    const rateLimited = phaseRows.filter(
      (r) => r.session?.status === "rate_limited",
    ).length;
    return { total, running, awaiting, done, errored, rateLimited };
  }, [buckets, phaseRows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold">{initialPlan.title}</h1>
            <PlanStatusBadge status={initialPlan.status} />
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            plan {initialPlan.id.slice(0, 8)} · {phases.length} phase
            {phases.length === 1 ? "" : "s"} ·{" "}
            <span className="select-all">{initialPlan.cwd}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <ViewToggle value={view} onChange={handleSetView} />
          <PoolControls
            maxConcurrent={maxConcurrent}
            paused={paused}
            running={counters.running}
            queued={pendingPhases.length}
            saving={settingsSaving}
            error={settingsError}
            onSet={handleSetSettings}
          />
          <Counter label="running" value={counters.running} tone="amber" />
          <Counter label="awaiting" value={counters.awaiting} tone="blue" />
          <Counter label="done" value={counters.done} tone="emerald" />
          {counters.rateLimited > 0 && (
            <Counter
              label="rate-limited"
              value={counters.rateLimited}
              tone="rose"
            />
          )}
          {counters.errored > 0 && (
            <Counter label="errored" value={counters.errored} tone="rose" />
          )}
          {activeNotesCount > 0 && (
            <Counter label="notes" value={activeNotesCount} tone="violet" />
          )}
        </div>
      </header>

      <MergePanel
        gate={mergeGate}
        status={mergeStatus}
        results={mergeResults}
        headSha={mergeHeadSha}
        mergedAt={mergedAt}
        error={mergeError}
        branch={mergeBranch}
        onBranchChange={setMergeBranch}
        onMerge={handleMerge}
        merging={merging}
        integrationReview={integrationReview}
        integrationReviewOpen={integrationReviewOpen}
        onToggleIntegrationReview={() =>
          setIntegrationReviewOpen((v) => !v)
        }
        onIntegrationReview={handleIntegrationReview}
        integrationReviewPending={integrationReviewPending}
      />

      <SharedBriefPanel
        body={sharedBrief}
        updatedAt={sharedBriefUpdatedAt}
        open={sharedBriefOpen}
        onToggle={() => setSharedBriefOpen((v) => !v)}
        onSave={handleSaveSharedBrief}
        saving={sharedBriefSaving}
        error={sharedBriefError}
      />

      <NotesPanel
        notes={phaseNotes}
        open={notesOpen}
        onToggle={() => setNotesOpen((v) => !v)}
        onDismiss={handleDismissNote}
        onJumpToPhase={(slug) => {
          // Scroll-to-row only works in the kanban layout — DAG nodes
          // live in their own absolute-positioned canvas. Flip the view
          // first if needed; the next render plants the row in the DOM
          // and the rAF gives revealPhaseRow a target to find.
          if (view !== "kanban") writeBoardView(initialPlanId, "kanban");
          requestAnimationFrame(() => {
            revealPhaseRow(slug);
          });
        }}
      />

      {view === "kanban" ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto p-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <ColumnView
              key={col.id}
              label={col.label}
              tint={col.tint}
              rows={buckets[col.id]}
              onComplete={handleComplete}
              pendingCompleteSlug={pendingCompleteSlug}
              onReview={handleReview}
              pendingReviewSlug={pendingReviewSlug}
              onRestart={handleRestart}
              pendingRestartSlug={pendingRestartSlug}
            />
          ))}
        </div>
      ) : (
        <DagView
          rows={phaseRows}
          editor={{
            setDeps: setPhaseDeps,
            error: depsError,
            onClearError: () => setDepsError(null),
          }}
        />
      )}
    </div>
  );
}

function ColumnView({
  label,
  tint,
  rows,
  onComplete,
  pendingCompleteSlug,
  onReview,
  pendingReviewSlug,
  onRestart,
  pendingRestartSlug,
}: {
  label: string;
  tint: string;
  rows: PhaseRow[];
  onComplete: (slug: string) => void;
  pendingCompleteSlug: string | null;
  onReview: (slug: string) => void;
  pendingReviewSlug: string | null;
  onRestart: (slug: string) => void;
  pendingRestartSlug: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={cn(
          "mb-2 flex items-center gap-2 border-l-2 pl-2 text-xs font-medium uppercase tracking-wide text-muted-foreground",
          tint,
        )}
      >
        <span>{label}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground/70">
          {rows.length}
        </span>
      </div>
      <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto pb-4">
        {rows.length === 0 ? (
          <li className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            empty
          </li>
        ) : (
          rows.map((row) => (
            <li key={row.phase.slug}>
              <PhaseRowCard
                row={row}
                onComplete={onComplete}
                pending={pendingCompleteSlug === row.phase.slug}
                onReview={onReview}
                reviewPending={pendingReviewSlug === row.phase.slug}
                onRestart={onRestart}
                restartPending={pendingRestartSlug === row.phase.slug}
              />
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function PhaseRowCard({
  row,
  onComplete,
  pending,
  onReview,
  reviewPending,
  onRestart,
  restartPending,
}: {
  row: PhaseRow;
  onComplete: (slug: string) => void;
  pending: boolean;
  onReview: (slug: string) => void;
  reviewPending: boolean;
  onRestart: (slug: string) => void;
  restartPending: boolean;
}) {
  const { phase, link, session, blockedDeps, isPending } = row;
  const status = session?.status;
  const blockedSet = useMemo(() => new Set(blockedDeps), [blockedDeps]);
  // Show the commit affordance only once the agent has actually been
  // spawned (link exists) AND it isn't actively working: idle/closed/
  // errored mean the user can reasonably decide "this phase is done,
  // commit whatever's there." Hiding it during thinking/awaiting also
  // prevents racing the model's own commit attempt.
  const sessionIdleLike =
    !!session &&
    (session.status === "idle" ||
      session.status === "closed" ||
      session.status === "errored");
  const canComplete = !!link && sessionIdleLike && !link.commit_status;
  // Review eligibility: phase must be committed (clean or committed
  // status) and not currently under review. We allow re-running a
  // failed review, and re-running a complete one ("re-review") so the
  // user can iterate after pushing follow-up commits.
  const reviewState = link?.review_status;
  const canReview =
    !!link &&
    (link.commit_status === "clean" || link.commit_status === "committed") &&
    reviewState !== "running";
  // Restart eligibility: agent is spawned, the run has actually settled
  // or wedged (errored / closed / rate-limited), and we haven't already
  // committed something — restarting a committed phase would orphan
  // dependents that already advanced past it. The server enforces the
  // commit-status gate too; the UI hides the button for a quieter
  // affordance.
  const canRestart =
    !!link &&
    (status === "errored" ||
      status === "closed" ||
      status === "rate_limited") &&
    link.commit_status !== "clean" &&
    link.commit_status !== "committed";
  // Local expand toggle for the findings panel. Default: open when a
  // fresh review with findings has just landed; collapse otherwise so
  // long phase lists stay compact. The user can flip it manually via
  // the chevron on ReviewBadge.
  const [reviewOpen, setReviewOpen] = useState<boolean>(
    reviewState === "complete" && (link?.review_findings?.length ?? 0) > 0,
  );
  return (
    <div
      id={phaseRowDomId(phase.slug)}
      data-phase-slug={phase.slug}
      className={cn(
        "scroll-mt-24 rounded-md border bg-background p-3 shadow-sm transition-colors",
        "data-[phase-flash=true]:ring-2 data-[phase-flash=true]:ring-violet-500/60",
        status === "errored" && "border-destructive/40",
        status === "thinking" && "border-amber-500/50",
        status === "awaiting_permission" && "border-blue-500/50",
        status === "rate_limited" && "border-rose-500/50",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{phase.title}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {phase.slug}
            </Badge>
          </div>
          {phase.depends_on && phase.depends_on.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {phase.depends_on.map((dep) => {
                const blocking = blockedSet.has(dep);
                return (
                  <Badge
                    key={dep}
                    variant="secondary"
                    className={cn(
                      "font-mono text-[10px]",
                      blocking
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    )}
                    title={
                      blocking
                        ? `${dep} not yet committed — this phase is blocked on it`
                        : `${dep} committed — dep satisfied`
                    }
                  >
                    ← {dep}
                  </Badge>
                );
              })}
            </div>
          )}
          {isPending && (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
              <Clock className="size-3" aria-hidden />
              <span className="font-mono">
                blocked
                {blockedDeps.length > 0
                  ? ` on ${blockedDeps.join(", ")}`
                  : " — waiting to spawn"}
              </span>
            </div>
          )}
        </div>
        {status && <SessionStatusDot status={status} />}
      </div>

      <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
        {phase.description}
      </p>

      <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
        {link?.account_name && (
          <div>
            <span className="text-foreground/70">account:</span> {link.account_name}
          </div>
        )}
        {session && (
          <div>
            <span className="text-foreground/70">turns:</span>{" "}
            <span className="tabular-nums">{session.history_length}</span>
            {session.subagents && session.subagents.length > 0 && (
              <>
                <span className="mx-1">·</span>
                <span className="text-foreground/70">subagents:</span>{" "}
                <span className="tabular-nums">{session.subagents.length}</span>
              </>
            )}
            {session.context_usage && (
              <ContextPctChip usage={session.context_usage} />
            )}
          </div>
        )}
      </div>

      {session?.rate_limit && (
        <RateLimitBadge
          info={session.rate_limit}
          observedAt={session.rate_limit_observed_at}
          active={session.status === "rate_limited"}
        />
      )}

      {link ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href={`/chat/${link.session_id}`}
              className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-[11px] hover:bg-muted"
            >
              <span className="font-mono">open agent</span>
              <ArrowRight className="size-3" aria-hidden />
            </Link>
            {canRestart && (
              <button
                type="button"
                onClick={() => onRestart(phase.slug)}
                disabled={restartPending}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                  "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20",
                  "dark:text-amber-300",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
                title={
                  status === "errored"
                    ? "Stop the failed session and spawn a fresh one with the original kickoff prompt"
                    : status === "rate_limited"
                      ? "Stop the rate-limited session and spawn a fresh one — useful when the SDK's backoff is longer than the actual rate-limit window"
                      : "Stop the closed session and spawn a fresh one with the original kickoff prompt"
                }
              >
                {restartPending ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <RotateCw className="size-3" aria-hidden />
                )}
                <span className="font-mono">restart phase</span>
              </button>
            )}
            {canComplete && (
              <button
                type="button"
                onClick={() => onComplete(phase.slug)}
                disabled={pending}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                  "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20",
                  "dark:text-emerald-300",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {pending ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="size-3" aria-hidden />
                )}
                <span className="font-mono">commit & complete</span>
              </button>
            )}
            <CommitBadge link={link} onRetry={() => onComplete(phase.slug)} pending={pending} />
            <ScopeBadge link={link} />
            {canReview && (
              <button
                type="button"
                onClick={() => onReview(phase.slug)}
                disabled={reviewPending}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                  "border-violet-500/40 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20",
                  "dark:text-violet-300",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
                title={
                  reviewState === "complete"
                    ? "Run review again — useful after follow-up commits"
                    : reviewState === "failed"
                      ? "Retry review"
                      : "Spawn a read-only agent that reviews this phase's diff"
                }
              >
                {reviewPending ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <MessageSquareText className="size-3" aria-hidden />
                )}
                <span className="font-mono">
                  {reviewState === "complete"
                    ? "re-review"
                    : reviewState === "failed"
                      ? "retry review"
                      : "review"}
                </span>
              </button>
            )}
            <ReviewBadge
              link={link}
              open={reviewOpen}
              onToggle={() => setReviewOpen((v) => !v)}
            />
          </div>
          {reviewOpen &&
            (link.review_findings || link.review_summary || link.review_error) && (
              <ReviewPanel link={link} />
            )}
        </>
      ) : (
        <div className="mt-3 inline-flex items-center gap-1 text-[11px] italic text-muted-foreground">
          no agent spawned
        </div>
      )}
    </div>
  );
}

// RateLimitBadge renders the most recent rate_limit_event as a top-line
// notice on the row: rose-tinted while the SDK is still backing off
// (`active` mirrors the server's "rate_limited" status), muted gray
// once the reset has passed and a successful retry has flipped status
// back to thinking/idle. Tick state recomputes the countdown once per
// second only while it actually matters; we don't repaint after the
// limit clears.
function RateLimitBadge({
  info,
  observedAt,
  active,
}: {
  info: RateLimitInfo;
  observedAt?: string;
  active: boolean;
}) {
  // Hooks must run unconditionally — `info.status === "allowed"` short-
  // circuit lives below, after useState/useEffect so a status flip
  // doesn't change the call ordering.
  const resetMs = info.resetsAt ? info.resetsAt * 1000 : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!resetMs || !active) return;
    if (resetMs <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resetMs, active]);
  // Only render for non-"allowed" states. allowed_warning is a
  // courtesy heads-up worth showing; rejected is the actual block.
  // We render lapsed badges too so the user sees that the wait already
  // happened (helpful when reading a transcript hours later).
  if (info.status === "allowed") return null;
  const remainingMs = resetMs ? Math.max(0, resetMs - now) : null;
  const countdown =
    remainingMs !== null && remainingMs > 0 ? formatDuration(remainingMs) : null;
  const tone =
    active && info.status === "rejected"
      ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      : info.status === "allowed_warning"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-muted bg-muted/40 text-muted-foreground";
  const label =
    info.status === "rejected"
      ? active
        ? "rate limited"
        : "rate limit lapsed"
      : "rate limit warning";
  const tier =
    info.rate_limit_type === "five_hour"
      ? "5h"
      : info.rate_limit_type === "seven_day"
        ? "7d"
        : info.rate_limit_type === "seven_day_opus"
          ? "7d opus"
          : info.rate_limit_type === "seven_day_sonnet"
            ? "7d sonnet"
            : info.rate_limit_type === "overage"
              ? "overage"
              : null;
  const utilPct =
    typeof info.utilization === "number"
      ? Math.round(info.utilization * 100)
      : null;
  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]",
        tone,
      )}
      title={observedAt ? `observed ${observedAt}` : undefined}
    >
      <Clock className="size-3" aria-hidden />
      <span>{label}</span>
      {tier && <span className="opacity-70">· {tier}</span>}
      {utilPct !== null && <span className="opacity-70">· {utilPct}%</span>}
      {countdown && (
        <span className="font-semibold">· resets in {countdown}</span>
      )}
    </div>
  );
}

// formatDuration renders ms remaining as the most legible compact form:
// "12s", "4m 30s", "1h 12m". Keeps the badge narrow.
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rs = s % 60;
    return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

// CommitBadge surfaces the result of the most recent /complete call.
// `clean` is intentionally low-key (the model already committed and the
// safety net was a no-op); `committed` shows the short sha; `failed`
// gives the user a one-click retry plus the captured stderr in a
// title attribute for hover-reveal.
function CommitBadge({
  link,
  onRetry,
  pending,
}: {
  link: PhaseSession;
  onRetry: () => void;
  pending: boolean;
}) {
  if (!link.commit_status) return null;
  if (link.commit_status === "clean") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <ShieldCheck className="size-3" aria-hidden />
        no changes
      </span>
    );
  }
  if (link.commit_status === "committed") {
    const short = link.commit_sha?.slice(0, 7) ?? "?";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
        title={link.committed_at ? `committed ${link.committed_at}` : undefined}
      >
        <GitCommit className="size-3" aria-hidden />
        {short}
      </span>
    );
  }
  // failed
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={pending}
      title={link.commit_error}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
        "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <RotateCw className="size-3" aria-hidden />
      )}
      commit failed — retry
    </button>
  );
}

// ScopeBadge surfaces the post-commit scope check from /complete:
//   undefined          → no check ran (phase didn't declare scope, or
//                        check errored). Render nothing — silent.
//   []                 → checked, no violations. Show subtle green
//                        "in scope" affordance.
//   [...paths]         → out-of-scope files. Amber chip with count;
//                        hover lists the paths so the user can decide
//                        whether the creep is intentional.
function ScopeBadge({ link }: { link: PhaseSession }) {
  if (link.scope_violations === undefined) return null;
  if (link.scope_violations.length === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        title={
          link.scope_check_base
            ? `scope clean vs ${link.scope_check_base.slice(0, 7)}`
            : undefined
        }
      >
        <ScanLine className="size-3" aria-hidden />
        in scope
      </span>
    );
  }
  const list = link.scope_violations;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      title={list.join("\n")}
    >
      <AlertTriangle className="size-3" aria-hidden />
      {list.length} out of scope
    </span>
  );
}

// ReviewBadge encodes the four review states the row can be in:
//   undefined (no review run)        → render nothing
//   "running"                        → spinner + "reviewing…"
//   "complete" with 0 findings       → emerald "✓ clean review"
//   "complete" with N findings       → severity-colored chip with
//                                       "<errors>e · <warnings>w · <info>i"
//   "failed"                         → rose "review failed" with title
// Click toggles the parent row's expanded findings panel.
function ReviewBadge({
  link,
  open,
  onToggle,
}: {
  link: PhaseSession;
  open: boolean;
  onToggle: () => void;
}) {
  const status = link.review_status;
  if (!status) return null;
  if (status === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        )}
        title={
          link.review_started_at
            ? `started ${link.review_started_at}`
            : undefined
        }
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        reviewing…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={link.review_error}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
      >
        <AlertTriangle className="size-3" aria-hidden />
        review failed
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  // complete
  const findings = link.review_findings ?? [];
  const counts = countBySeverity(findings);
  const totalIssues = counts.error + counts.warning + counts.info;
  if (totalIssues === 0) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={link.review_summary}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        <ShieldCheck className="size-3" aria-hidden />
        clean review
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  // Pick the worst-severity color so the badge reflects the headline at a glance.
  const tone =
    counts.error > 0
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : counts.warning > 0
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={link.review_summary}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
        tone,
      )}
    >
      <MessageSquareText className="size-3" aria-hidden />
      <span>
        {counts.error > 0 && <span>{counts.error}e</span>}
        {counts.warning > 0 && (
          <span>
            {counts.error > 0 ? " · " : ""}
            {counts.warning}w
          </span>
        )}
        {counts.info > 0 && (
          <span>
            {counts.error > 0 || counts.warning > 0 ? " · " : ""}
            {counts.info}i
          </span>
        )}
      </span>
      {open ? (
        <ChevronDown className="size-3" aria-hidden />
      ) : (
        <ChevronRight className="size-3" aria-hidden />
      )}
    </button>
  );
}

function countBySeverity(findings: ReviewFinding[]) {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "error") error++;
    else if (f.severity === "warning") warning++;
    else info++;
  }
  return { error, warning, info };
}

// ReviewPanel renders the agent's summary + per-finding bullets when
// the user expands the badge. Findings are sorted error → warning →
// info so the most actionable items rise to the top regardless of the
// order the agent submitted them in.
function ReviewPanel({ link }: { link: PhaseSession }) {
  const sorted = useMemo(() => {
    const findings = link.review_findings ?? [];
    const order: Record<ReviewSeverity, number> = {
      error: 0,
      warning: 1,
      info: 2,
    };
    return [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  }, [link.review_findings]);
  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-3 text-[11px]">
      {link.review_error ? (
        <div className="flex items-start gap-2 text-destructive">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="font-mono whitespace-pre-wrap">{link.review_error}</span>
        </div>
      ) : null}
      {link.review_summary && (
        <p className="whitespace-pre-wrap text-foreground/80">
          {link.review_summary}
        </p>
      )}
      {sorted.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {sorted.map((f, i) => (
            <li
              key={`${f.severity}-${i}-${f.title}`}
              className="rounded-md border bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityChip severity={f.severity} />
                {f.category && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {f.category}
                  </Badge>
                )}
                <span className="font-medium">{f.title}</span>
                {f.file && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {f.file}
                    {typeof f.line === "number" ? `:${f.line}` : ""}
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-foreground/80">
                {f.description}
              </p>
            </li>
          ))}
        </ul>
      )}
      {link.review_completed_at && (
        <div className="mt-2 font-mono text-[10px] text-muted-foreground">
          reviewed {link.review_completed_at}
          {link.review_base ? ` · base ${link.review_base.slice(0, 7)}` : ""}
        </div>
      )}
    </div>
  );
}

function SeverityChip({ severity }: { severity: ReviewSeverity }) {
  const cls =
    severity === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : severity === "warning"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1 py-0 font-mono text-[10px] uppercase tracking-wide",
        cls,
      )}
    >
      {severity}
    </span>
  );
}

function SessionStatusDot({ status }: { status: SessionStatus }) {
  const color =
    status === "errored"
      ? "bg-destructive"
      : status === "thinking"
        ? "bg-amber-500 animate-pulse"
        : status === "awaiting_permission"
          ? "bg-blue-500"
          : status === "rate_limited"
            ? "bg-rose-500 animate-pulse"
            : status === "closed"
              ? "bg-muted-foreground/40"
              : status === "idle"
                ? "bg-emerald-500"
                : "bg-muted-foreground/60";
  return (
    <span
      title={status.replace("_", " ")}
      className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", color)}
    />
  );
}

// ContextPctChip surfaces the SDK's reported context-window usage so
// the user can spot a phase that's about to push into degraded-output
// territory. Threshold is model-aware (see lib/context-thresholds.ts):
// 200k models act at 50% used; 1M models hold longer and act at ~75%.
function ContextPctChip({ usage }: { usage: ContextUsageBreakdown }) {
  const rounded = Math.round(usage.percentage);
  const zone = classifyContextZone(usage.percentage, usage.max_tokens);
  const tone =
    zone === "act"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : zone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-muted-foreground/30 bg-muted/40 text-muted-foreground";
  const hint = zone === "act" ? ` — ${actionHintForMaxTokens(usage.max_tokens)}` : "";
  return (
    <>
      <span className="mx-1">·</span>
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded border px-1 py-px tabular-nums",
          tone,
        )}
        title={`context window: ${rounded}% of ${usage.max_tokens.toLocaleString()}${hint}`}
      >
        ctx {rounded}%
      </span>
    </>
  );
}

function PlanStatusBadge({ status }: { status: PlanRecord["status"] }) {
  if (status === "approved") return <Badge>approved</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">awaiting approval</Badge>;
}

// MergePanel renders the plan-level merge affordance below the header.
// Three states drive the layout:
//   1. not-yet-eligible (some phases missing commit_status) → muted
//      hint + disabled button so the user can see what's left.
//   2. eligible, no merge yet → highlighted row with input + Merge
//      button.
//   3. post-merge → result chips per phase + retry button when status
//      is "pending" or "failed".
// We always render the strip when the plan has phases; collapsing the
// row when not eligible would make the affordance harder to discover.
function MergePanel({
  gate,
  status,
  results,
  headSha,
  mergedAt,
  error,
  branch,
  onBranchChange,
  onMerge,
  merging,
  integrationReview,
  integrationReviewOpen,
  onToggleIntegrationReview,
  onIntegrationReview,
  integrationReviewPending,
}: {
  gate: { ready: number; total: number; pending: string[]; eligible: boolean };
  status: PlanMergeStatus | undefined;
  results: PhaseMergeResult[];
  headSha: string | undefined;
  mergedAt: string | undefined;
  error: string | undefined;
  branch: string;
  onBranchChange: (b: string) => void;
  onMerge: () => void;
  merging: boolean;
  integrationReview: IntegrationReviewSnapshot;
  integrationReviewOpen: boolean;
  onToggleIntegrationReview: () => void;
  onIntegrationReview: () => void;
  integrationReviewPending: boolean;
}) {
  if (gate.total === 0) return null;

  const merged = results.filter((r) => r.status === "merged").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const buttonLabel =
    status === "merged"
      ? "Re-merge"
      : status === "pending" || status === "failed"
        ? "Retry merge"
        : "Merge into";

  return (
    <section
      className={cn(
        "flex flex-col gap-2 border-b px-6 py-3 text-xs",
        gate.eligible && status !== "merged" && "bg-emerald-500/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitMerge
          className={cn(
            "size-4 shrink-0",
            gate.eligible ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Plan merge</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {gate.ready}/{gate.total} phases committed
            </span>
            {status && <MergeStatusBadge status={status} />}
          </div>
          {!gate.eligible && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              waiting on{" "}
              <span className="font-mono">
                {gate.pending.slice(0, 4).join(", ")}
                {gate.pending.length > 4 ? `, +${gate.pending.length - 4} more` : ""}
              </span>{" "}
              — click <span className="font-mono">commit &amp; complete</span> on
              each phase first.
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">
            {buttonLabel}
          </span>
          <input
            type="text"
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
            disabled={merging}
            spellCheck={false}
            placeholder="main"
            className={cn(
              "h-7 w-32 rounded-md border bg-background px-2 font-mono text-[11px]",
              "focus:outline-none focus:ring-1 focus:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <button
            type="button"
            onClick={onMerge}
            disabled={!gate.eligible || merging || branch.trim().length === 0}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
              "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20",
              "dark:text-emerald-300",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-500/10",
            )}
          >
            {merging ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <GitMerge className="size-3" aria-hidden />
            )}
            <span className="font-mono">merge</span>
          </button>
        </div>
      </div>

      {(results.length > 0 || error) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {merged > 0 && (
            <MergeSummaryChip tone="emerald" label={`${merged} merged`} />
          )}
          {skipped > 0 && (
            <MergeSummaryChip tone="muted" label={`${skipped} skipped`} />
          )}
          {failed > 0 && (
            <MergeSummaryChip tone="rose" label={`${failed} failed`} />
          )}
          {headSha && (
            <span
              className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              title={mergedAt ? `merged ${mergedAt}` : undefined}
            >
              <GitCommit className="size-3" aria-hidden />
              {headSha.slice(0, 7)}
            </span>
          )}
          {results.map((r) => (
            <MergeResultChip key={r.phase_slug} result={r} />
          ))}
          {error && (
            <span
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-mono text-[11px] text-destructive"
              title={error}
            >
              <XCircle className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{error}</span>
            </span>
          )}
        </div>
      )}

      {status === "merged" && (
        <IntegrationReviewRow
          snapshot={integrationReview}
          open={integrationReviewOpen}
          onToggle={onToggleIntegrationReview}
          onRun={onIntegrationReview}
          pending={integrationReviewPending}
        />
      )}
    </section>
  );
}

// IntegrationReviewSnapshot collapses the integration_review_* fields
// from PlanRecord into a single object so prop-drilling stays tidy.
// We mirror the wire shape one-for-one — no derived fields here, just
// a structural slice so MergePanel can read it without depending on
// the full PlanRecord shape.
interface IntegrationReviewSnapshot {
  status: PlanIntegrationReviewStatus | undefined;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  findings?: ReviewFinding[];
  error?: string;
  base?: string;
  head?: string;
  branch?: string;
}

function snapshotIntegrationReview(plan: PlanRecord): IntegrationReviewSnapshot {
  return {
    status: plan.integration_review_status,
    startedAt: plan.integration_review_started_at,
    completedAt: plan.integration_review_completed_at,
    summary: plan.integration_review_summary,
    findings: plan.integration_review_findings,
    error: plan.integration_review_error,
    base: plan.integration_review_base,
    head: plan.integration_review_head,
    branch: plan.integration_review_branch,
  };
}

// IntegrationReviewRow is the second strip inside MergePanel — only
// renders once the merge has fully landed (status === "merged"). It
// mirrors the per-phase ReviewBadge + ReviewPanel pair: a button to
// kick the agent, a badge that flips through running/clean/findings/
// failed states, and an expandable panel below for the agent's
// summary + findings list.
function IntegrationReviewRow({
  snapshot,
  open,
  onToggle,
  onRun,
  pending,
}: {
  snapshot: IntegrationReviewSnapshot;
  open: boolean;
  onToggle: () => void;
  onRun: () => void;
  pending: boolean;
}) {
  const status = snapshot.status;
  const running = status === "running";
  const buttonLabel =
    status === "complete"
      ? "Re-review"
      : status === "failed"
        ? "Retry review"
        : "Run integration review";
  const canRun = !running && !pending;
  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareText
          className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Integration review</span>
            <span className="text-[11px] text-muted-foreground">
              cross-phase coherence on the merged branch
            </span>
            <IntegrationReviewBadge
              snapshot={snapshot}
              open={open}
              onToggle={onToggle}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            title={
              status === "complete"
                ? "Re-run the integration reviewer — useful after follow-up commits on the integration branch"
                : status === "failed"
                  ? "Retry — the previous run errored or didn't submit findings"
                  : "Spawn a read-only agent that reviews the cumulative diff"
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
              "border-violet-500/40 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20",
              "dark:text-violet-300",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {pending || running ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <MessageSquareText className="size-3" aria-hidden />
            )}
            <span className="font-mono">{buttonLabel}</span>
          </button>
        </div>
      </div>
      {open &&
        (status === "complete" || status === "failed") &&
        (snapshot.summary || snapshot.error || (snapshot.findings?.length ?? 0) > 0) && (
          <IntegrationReviewPanel snapshot={snapshot} />
        )}
    </div>
  );
}

function IntegrationReviewBadge({
  snapshot,
  open,
  onToggle,
}: {
  snapshot: IntegrationReviewSnapshot;
  open: boolean;
  onToggle: () => void;
}) {
  const status = snapshot.status;
  if (!status) return null;
  if (status === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
          "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        )}
        title={
          snapshot.startedAt ? `started ${snapshot.startedAt}` : undefined
        }
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        reviewing…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={snapshot.error}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
          "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
      >
        <AlertTriangle className="size-3" aria-hidden />
        review failed
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  // complete
  const findings = snapshot.findings ?? [];
  const counts = countBySeverity(findings);
  const totalIssues = counts.error + counts.warning + counts.info;
  if (totalIssues === 0) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={snapshot.summary}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        <ShieldCheck className="size-3" aria-hidden />
        clean integration
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  const tone =
    counts.error > 0
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : counts.warning > 0
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={snapshot.summary}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        tone,
      )}
    >
      <MessageSquareText className="size-3" aria-hidden />
      <span>
        {counts.error > 0 && <span>{counts.error}e</span>}
        {counts.warning > 0 && (
          <span>
            {counts.error > 0 ? " · " : ""}
            {counts.warning}w
          </span>
        )}
        {counts.info > 0 && (
          <span>
            {counts.error > 0 || counts.warning > 0 ? " · " : ""}
            {counts.info}i
          </span>
        )}
      </span>
      {open ? (
        <ChevronDown className="size-3" aria-hidden />
      ) : (
        <ChevronRight className="size-3" aria-hidden />
      )}
    </button>
  );
}

// IntegrationReviewPanel renders summary + sorted findings, mirroring
// ReviewPanel's layout. We also surface the diff range (base..head)
// in the footer because, unlike per-phase reviews, the user can't
// derive it from "the worktree this card refers to" — it's the
// cumulative range across all phases.
function IntegrationReviewPanel({
  snapshot,
}: {
  snapshot: IntegrationReviewSnapshot;
}) {
  const findings = snapshot.findings ?? [];
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-[11px]">
      {snapshot.error ? (
        <div className="flex items-start gap-2 text-destructive">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="font-mono whitespace-pre-wrap">{snapshot.error}</span>
        </div>
      ) : null}
      {snapshot.summary && (
        <p className="whitespace-pre-wrap text-foreground/80">
          {snapshot.summary}
        </p>
      )}
      {sorted.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {sorted.map((f, i) => (
            <li
              key={`${f.severity}-${i}-${f.title}`}
              className="rounded-md border bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityChip severity={f.severity} />
                {f.category && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {f.category}
                  </Badge>
                )}
                <span className="font-medium">{f.title}</span>
                {f.file && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {f.file}
                    {typeof f.line === "number" ? `:${f.line}` : ""}
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-foreground/80">
                {f.description}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(snapshot.completedAt || snapshot.base || snapshot.head) && (
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
          {snapshot.completedAt && (
            <span>reviewed {snapshot.completedAt}</span>
          )}
          {snapshot.base && snapshot.head && (
            <span>
              · diff {snapshot.base.slice(0, 7)}..{snapshot.head.slice(0, 7)}
            </span>
          )}
          {snapshot.branch && <span>· branch {snapshot.branch}</span>}
        </div>
      )}
    </div>
  );
}

function severityRank(s: ReviewSeverity): number {
  if (s === "error") return 0;
  if (s === "warning") return 1;
  return 2;
}

function MergeStatusBadge({ status }: { status: PlanMergeStatus }) {
  if (status === "merged") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        merged
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        partial
      </Badge>
    );
  }
  return <Badge variant="destructive">failed</Badge>;
}

function MergeSummaryChip({
  tone,
  label,
}: {
  tone: "emerald" | "muted" | "rose";
  label: string;
}) {
  const cls =
    tone === "emerald"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "rose"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border bg-muted/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function MergeResultChip({ result }: { result: PhaseMergeResult }) {
  const cls =
    result.status === "merged"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : result.status === "skipped"
        ? "border bg-muted/40 text-muted-foreground"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  const detail =
    result.status === "merged" && result.sha
      ? result.sha.slice(0, 7)
      : result.status === "skipped"
        ? "already merged"
        : "failed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        cls,
      )}
      title={result.error ? result.error : `${result.branch}`}
    >
      <span>{result.phase_slug}</span>
      <span className="opacity-70">· {detail}</span>
    </span>
  );
}

// SharedBriefPanel surfaces the plan-level shared brief. Mirror of the
// leader's mcp__leader__record_shared_context tool — both edit the same
// plan.shared_brief on disk. Frozen-at-spawn semantics matter: phases
// already running do NOT pick up edits, only phases spawned after the
// save. The panel surfaces this in a small caveat below the textarea
// so the user isn't surprised when a running phase ignores fresh content.
//
// Collapsed by default for empty plans; auto-open when a brief already
// exists so resumed plans surface their context anchors immediately.
const SHARED_BRIEF_BYTE_CAP = 8 * 1024;
function SharedBriefPanel({
  body,
  updatedAt,
  open,
  onToggle,
  onSave,
  saving,
  error,
}: {
  body: string;
  updatedAt?: string;
  open: boolean;
  onToggle: () => void;
  onSave: (body: string) => Promise<void> | void;
  saving: boolean;
  error?: string;
}) {
  // Local draft. Decoupled from the persisted body so the user can edit
  // without every keystroke racing the poll. Sync down whenever the
  // committed body changes (server wrote, MCP tool wrote, plan reload).
  const [draft, setDraft] = useState(body);
  // Track the last value we synced from props so we can distinguish
  // "props updated because the user just saved" (don't overwrite local
  // draft if equal) vs "props updated by external write" (overwrite).
  const lastSyncedRef = useRef(body);
  useEffect(() => {
    if (body !== lastSyncedRef.current) {
      lastSyncedRef.current = body;
      setDraft(body);
    }
  }, [body]);
  const dirty = draft !== body;
  const overCap = draft.length > SHARED_BRIEF_BYTE_CAP;
  const handleSave = async () => {
    if (saving || overCap) return;
    await onSave(draft);
  };
  const handleClear = async () => {
    if (saving) return;
    setDraft("");
    await onSave("");
  };
  return (
    <div className="border-b bg-sky-500/5 px-6 py-2 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <BookText className="size-3.5 text-sky-500" aria-hidden />
        <span className="font-medium uppercase tracking-wide">
          Shared brief
        </span>
        {body.length > 0 ? (
          <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-sky-600 dark:text-sky-300">
            {body.length}b
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase text-muted-foreground/70">
            empty
          </span>
        )}
        {!open && body.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-foreground/70">
            {body.replace(/\s+/g, " ").slice(0, 140)}
          </span>
        )}
        {open ? (
          <ChevronDown className="ml-auto size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="ml-auto size-3.5" aria-hidden />
        )}
      </button>
      {open && (
        <div className="mt-2 pb-1">
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            Plan-level anchors every <em>future</em> phase splices into its
            kickoff prompt. Use it for file paths, conventions, contracts,
            and gotchas you have already discovered. Phases already running
            will not pick up edits — only phases spawned after Save.
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder="e.g. Auth lives in web/lib/auth/. SDK rate-limit info uses Unix-seconds. The merge branch is integration/<plan-short>."
            className={cn(
              "block w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed shadow-sm focus:outline-none focus:ring-2",
              overCap
                ? "border-destructive/60 focus:ring-destructive/40"
                : "border-sky-500/30 focus:ring-sky-500/40",
            )}
            rows={Math.min(20, Math.max(6, draft.split("\n").length + 1))}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span
              className={cn(
                "tabular-nums",
                overCap && "text-destructive",
                !overCap &&
                  draft.length > SHARED_BRIEF_BYTE_CAP * 0.8 &&
                  "text-amber-600 dark:text-amber-400",
              )}
            >
              {draft.length} / {SHARED_BRIEF_BYTE_CAP} bytes
            </span>
            {updatedAt && (
              <span className="opacity-70">· last saved {updatedAt}</span>
            )}
            {dirty && !saving && (
              <span className="text-amber-600 dark:text-amber-400">
                · unsaved changes
              </span>
            )}
            {error && (
              <span className="text-destructive">· {error}</span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {body.length > 0 && (
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                  title="Clear the shared brief — running phases keep what they were spawned with"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || overCap || !dirty}
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50",
                  "border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300",
                )}
                title={
                  overCap
                    ? "Body exceeds 8 KB cap"
                    : !dirty
                      ? "No changes to save"
                      : "Save — affects future phase spawns only"
                }
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    saving
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// NotesPanel surfaces the phase_notes broadcast log. Phases write via
// the submit_phase_note MCP tool; the plan-record poll above picks them
// up. Collapsible because the list grows over the plan's lifetime —
// users glance at recent activity, occasionally expand for the full
// history. Latest-first ordering matches list_phase_notes.
//
// Filtering: clickable tag chips scope the visible notes to the
// intersection of selected tags (an OR within a single tag, AND when
// multiple are picked is too aggressive given how few notes a plan
// usually carries — pick OR instead, which behaves like "show me any
// note tagged x or y"). Dismissed notes hide by default; a small toggle
// reveals them dimmed with a Restore action so the user can undo.
function NotesPanel({
  notes,
  open,
  onToggle,
  onDismiss,
  onJumpToPhase,
}: {
  notes: PhaseNote[];
  open: boolean;
  onToggle: () => void;
  onDismiss: (noteId: string, dismiss: boolean) => void | Promise<void>;
  onJumpToPhase: (slug: string) => void;
}) {
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const sorted = useMemo(() => {
    return [...notes].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
  }, [notes]);
  // Distinct tag set across all (non-dismissed) notes, with a count per
  // tag so the user can spot the busy themes at a glance. Dismissed
  // notes contribute their tags only when "show dismissed" is on —
  // otherwise filtering by a tag that exists ONLY on dismissed notes
  // would yield a confusingly empty list.
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of sorted) {
      if (!showDismissed && n.dismissed_at) continue;
      for (const t of n.tags ?? []) {
        m.set(t, (m.get(t) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [sorted, showDismissed]);
  const dismissedCount = useMemo(
    () => sorted.filter((n) => n.dismissed_at).length,
    [sorted],
  );
  const visible = useMemo(() => {
    return sorted.filter((n) => {
      if (n.dismissed_at && !showDismissed) return false;
      if (activeTags.size === 0) return true;
      const tags = n.tags ?? [];
      return tags.some((t) => activeTags.has(t));
    });
  }, [sorted, activeTags, showDismissed]);
  const activeFeed = useMemo(
    () => sorted.filter((n) => !n.dismissed_at),
    [sorted],
  );
  if (notes.length === 0) {
    // Suppress entirely when empty so the board doesn't gain a hollow
    // strip pre-broadcast. The header chip drives discoverability once
    // the first note lands.
    return null;
  }
  const latest = activeFeed[0] ?? sorted[0];
  const toggleTag = (t: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  return (
    <div className="border-b bg-violet-500/5 px-6 py-2 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <Megaphone className="size-3.5 text-violet-500" aria-hidden />
        <span className="font-medium uppercase tracking-wide">
          Phase notes
        </span>
        <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-violet-600 dark:text-violet-300">
          {activeFeed.length}
          {dismissedCount > 0 && (
            <span className="opacity-60"> / {sorted.length}</span>
          )}
        </span>
        {!open && latest && (
          <span className="min-w-0 flex-1 truncate text-foreground/70">
            <span className="font-mono text-[11px]">{latest.phase_slug}</span>
            <span className="opacity-70"> — {latest.body}</span>
          </span>
        )}
        {open ? (
          <ChevronDown className="ml-auto size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
      </button>
      {open && (
        <div className="mt-2 pb-1">
          {(tagCounts.length > 0 || dismissedCount > 0) && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {tagCounts.map(([t, count]) => {
                const on = activeTags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTag(t)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors",
                      on
                        ? "border-violet-500/60 bg-violet-500/20 text-violet-700 dark:text-violet-200"
                        : "border-violet-500/20 bg-violet-500/5 text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={on}
                    title={on ? `Stop filtering by ${t}` : `Filter by ${t}`}
                  >
                    <span>{t}</span>
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
              {activeTags.size > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTags(new Set())}
                  className="rounded-full border border-transparent px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  clear filter
                </button>
              )}
              {dismissedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowDismissed((v) => !v)}
                  className={cn(
                    "ml-auto rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors",
                    showDismissed
                      ? "border-violet-500/60 bg-violet-500/20 text-violet-700 dark:text-violet-200"
                      : "border-dashed border-violet-500/30 text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={showDismissed}
                >
                  {showDismissed
                    ? `hide dismissed (${dismissedCount})`
                    : `show dismissed (${dismissedCount})`}
                </button>
              )}
            </div>
          )}
          {visible.length === 0 ? (
            <p className="px-1 py-2 text-muted-foreground">
              {activeTags.size > 0
                ? "No notes match the selected tag(s)."
                : "All notes dismissed."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  onDismiss={() =>
                    onDismiss(note.id, !note.dismissed_at)
                  }
                  onJumpToPhase={() => onJumpToPhase(note.phase_slug)}
                  onToggleTag={toggleTag}
                  activeTags={activeTags}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// NoteRow factored out so the per-note dismiss/restore + tag filter
// chips read cleanly. Dismissed notes get muted styling + a Restore
// action; active notes get a Dismiss action.
function NoteRow({
  note,
  onDismiss,
  onJumpToPhase,
  onToggleTag,
  activeTags,
}: {
  note: PhaseNote;
  onDismiss: () => void;
  onJumpToPhase: () => void;
  onToggleTag: (t: string) => void;
  activeTags: Set<string>;
}) {
  const dismissed = !!note.dismissed_at;
  return (
    <li
      className={cn(
        "rounded-md border border-violet-500/20 bg-background px-3 py-2 transition-opacity",
        dismissed && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={onJumpToPhase}
          className="rounded font-mono text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
          title={`Jump to ${note.phase_slug} on the board`}
        >
          {note.phase_slug}
        </button>
        <span className="opacity-70">{formatNoteTime(note.created_at)}</span>
        {note.tags?.map((t) => {
          const on = activeTags.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onToggleTag(t)}
              className={cn(
                "rounded-full px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                on
                  ? "bg-violet-500/25 text-violet-700 dark:text-violet-200"
                  : "bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 dark:text-violet-300",
              )}
              aria-pressed={on}
              title={on ? `Stop filtering by ${t}` : `Filter by ${t}`}
            >
              {t}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-foreground"
          title={dismissed ? "Restore this note" : "Mark this note as handled"}
        >
          {dismissed ? (
            <>
              <RotateCw className="size-3" aria-hidden />
              <span>restore</span>
            </>
          ) : (
            <>
              <XCircle className="size-3" aria-hidden />
              <span>dismiss</span>
            </>
          )}
        </button>
      </div>
      <p
        className={cn(
          "mt-1 whitespace-pre-wrap text-sm",
          dismissed ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {note.body}
      </p>
    </li>
  );
}

function formatNoteTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(t).toLocaleString();
}

// PoolControls bundles the worker-pool affordances into one compact
// header strip: pause toggle, max-concurrent input, and a `running/cap`
// readout with a queued-count pill when phases are throttled. The cap
// input commits on blur or Enter so a user typing "12" doesn't fire
// three POSTs as they pass 1 → 12. Paused state turns the running
// readout amber so the user spots a stalled cascade at a glance.
function PoolControls({
  maxConcurrent,
  paused,
  running,
  queued,
  saving,
  error,
  onSet,
}: {
  maxConcurrent: number;
  paused: boolean;
  running: number;
  queued: number;
  saving: boolean;
  error?: string;
  onSet: (patch: {
    maxConcurrent?: number | null;
    paused?: boolean;
  }) => void | Promise<void>;
}) {
  // Uncontrolled input — keyed on `maxConcurrent` so a server-side
  // change (poll, MCP edit, other tab) re-mounts the input with the
  // fresh value. Avoids the setState-in-effect pattern React 19 lint
  // forbids while still tracking persisted value out of band. We read
  // .value at commit time rather than mirroring every keystroke.
  const inputRef = useRef<HTMLInputElement>(null);
  const commitCap = () => {
    const raw = inputRef.current?.value ?? "";
    const n = parseInt(raw, 10);
    if (
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_MAX_CONCURRENT
    ) {
      // Revert visually; the inline error would lag behind blur.
      if (inputRef.current) inputRef.current.value = String(maxConcurrent);
      return;
    }
    if (n === maxConcurrent) return;
    void onSet({ maxConcurrent: n });
  };
  const overCap = running > maxConcurrent;
  const stalled = paused || (queued > 0 && running >= maxConcurrent);
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px]"
      title={
        paused
          ? "Paused — no new phases will spawn even when deps clear"
          : `Worker pool: ${running} running, ${queued} queued, cap ${maxConcurrent}`
      }
    >
      <button
        type="button"
        onClick={() => void onSet({ paused: !paused })}
        disabled={saving}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors disabled:opacity-50",
          paused
            ? "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        aria-pressed={paused}
        title={paused ? "Resume cascade" : "Pause cascade (running phases keep going)"}
      >
        {paused ? (
          <Play className="size-3" aria-hidden />
        ) : (
          <Pause className="size-3" aria-hidden />
        )}
        <span>{paused ? "paused" : "pause"}</span>
      </button>
      <span
        className={cn(
          "tabular-nums",
          stalled
            ? "text-amber-600 dark:text-amber-300"
            : "text-muted-foreground",
          overCap && "text-destructive",
        )}
      >
        {running}/
      </span>
      <input
        ref={inputRef}
        key={maxConcurrent}
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_MAX_CONCURRENT}
        defaultValue={maxConcurrent}
        onBlur={commitCap}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            (e.target as HTMLInputElement).value = String(maxConcurrent);
            (e.target as HTMLInputElement).blur();
          }
        }}
        disabled={saving}
        className="w-10 rounded border bg-background px-1 py-0.5 text-center tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
        title="Max concurrent phases. Enter to commit."
      />
      {queued > 0 && (
        <span
          className="rounded-full bg-amber-500/15 px-1.5 py-0 text-[10px] tabular-nums text-amber-700 dark:text-amber-300"
          title={`${queued} pending phases (deps-blocked or throttled)`}
        >
          q{queued}
        </span>
      )}
      {error && (
        <span className="text-destructive" title={error}>
          !
        </span>
      )}
    </div>
  );
}

// ViewToggle is a 2-button segmented control for kanban / dag. Sits in
// the header so the user can flip without scrolling. Active button
// gets the primary background; the inactive one stays muted so the
// current state is unambiguous at a glance.
function ViewToggle({
  value,
  onChange,
}: {
  value: BoardView;
  onChange: (next: BoardView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Board view"
      className="inline-flex items-center rounded-md border bg-muted/30 p-0.5 font-mono"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === "kanban"}
        onClick={() => onChange("kanban")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          value === "kanban"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Kanban swimlanes by status"
      >
        <KanbanSquare className="size-3" aria-hidden />
        <span>kanban</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === "dag"}
        onClick={() => onChange("dag")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          value === "dag"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Dependency graph by depends_on"
      >
        <Network className="size-3" aria-hidden />
        <span>dag</span>
      </button>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "amber" | "blue" | "emerald" | "rose" | "violet";
}) {
  const dot =
    tone === "amber"
      ? "bg-amber-500"
      : tone === "blue"
        ? "bg-blue-500"
        : tone === "emerald"
          ? "bg-emerald-500"
          : tone === "violet"
            ? "bg-violet-500"
            : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      <span className="tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

