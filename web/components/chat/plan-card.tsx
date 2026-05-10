"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  FlaskConical,
  LayoutGrid,
  MessageSquarePlus,
  ScanLine,
} from "lucide-react";
import type { Effort } from "@/lib/chat-types";
import type {
  Phase,
  PhaseOverride,
  PhaseOverrides,
  PhaseScope,
  PlanRecord,
} from "@/lib/plan-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

interface Props {
  plan: PlanRecord;
  onApprove: (planId: string, overrides?: PhaseOverrides) => Promise<void>;
  // onDiscuss sends a user message back into the same chat so the
  // owner can ask Claude to revise the plan before approval. Once
  // the model calls submit_plan again the latest-plan pointer flips
  // and this card unmounts in favour of the new one.
  onDiscuss?: (planId: string, feedback: string) => Promise<void>;
}

// Curated dropdown — surfaces the three current model tiers plus
// "(inherit)" which falls back to the owner session's selection. We
// intentionally do not enumerate every dated snapshot here: those are
// fine via per-session model picker, but for plan phases the user is
// almost always picking by capability tier (heavy / fast / cheap).
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "inherit" },
  { value: "claude-opus-4-7", label: "opus 4.7" },
  { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
];

const EFFORT_OPTIONS: { value: "" | Effort; label: string }[] = [
  { value: "", label: "inherit" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export function PlanCard({ plan, onApprove, onDiscuss }: Props) {
  const [busy, setBusy] = useState(false);
  // Discuss-flow state: open toggles the inline textarea, sending
  // tracks the in-flight POST so we can disable both action buttons
  // while the message is on the wire. We don't reset `sending` to
  // false on success — when Claude calls submit_plan again the
  // latest-plan pointer flips and the whole card unmounts, so the
  // local state is moot.
  const [discussOpen, setDiscussOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Local edits live in component state until the user clicks Approve;
  // we only persist on submit so abandoned edits don't pollute the
  // plan record on disk. Pre-seed from plan.phases so existing values
  // (set by the model at submit_plan time, or persisted from a prior
  // approve attempt) round-trip correctly.
  const [overrides, setOverrides] = useState<PhaseOverrides>(() => {
    const seed: PhaseOverrides = {};
    for (const p of plan.phases) {
      const o: PhaseOverride = {};
      if (p.model) o.model = p.model;
      if (p.effort) o.effort = p.effort;
      if (p.tdd_mode) o.tdd_mode = p.tdd_mode;
      if (p.scope?.files && p.scope.files.length > 0) {
        o.scope = { files: [...p.scope.files] };
      }
      if (Object.keys(o).length > 0) seed[p.slug] = o;
    }
    return seed;
  });

  const editable = plan.status !== "approved";
  const updateOverride = (slug: string, patch: PhaseOverride) => {
    setOverrides((prev) => {
      const merged: PhaseOverride = { ...(prev[slug] ?? {}), ...patch };
      // Strip empty values so the wire payload only carries real changes.
      if (merged.model === "" || merged.model == null) delete merged.model;
      if (merged.effort === undefined) delete merged.effort;
      if (merged.tdd_mode === false) delete merged.tdd_mode;
      // scope.files = [] means "user cleared all globs" — still a real
      // edit (server treats empty array as drop), so keep the empty
      // PhaseScope until merged is otherwise empty.
      if (merged.scope) {
        const files = merged.scope.files ?? [];
        if (files.length === 0) {
          delete merged.scope;
        } else {
          merged.scope = { files };
        }
      }
      const next = { ...prev };
      if (Object.keys(merged).length === 0) {
        delete next[slug];
      } else {
        next[slug] = merged;
      }
      return next;
    });
  };

  const dirtyCount = useMemo(() => Object.keys(overrides).length, [overrides]);

  const onClick = async () => {
    setBusy(true);
    try {
      await onApprove(plan.id, dirtyCount > 0 ? overrides : undefined);
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async () => {
    const trimmed = feedback.trim();
    if (!trimmed || !onDiscuss) return;
    setSending(true);
    try {
      await onDiscuss(plan.id, trimmed);
    } finally {
      // Don't reset on success — the card unmounts when submit_plan
      // re-fires. Resetting on error lets the user retry.
      setSending(false);
    }
  };

  const openDiscuss = () => {
    setDiscussOpen(true);
    // Focus the textarea on the next tick — the element doesn't
    // exist until React commits the open=true render.
    queueMicrotask(() => textareaRef.current?.focus());
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{plan.title}</h3>
            <PlanStatusBadge status={plan.status} />
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            plan {plan.id.slice(0, 8)} · {plan.phases.length} phase
            {plan.phases.length === 1 ? "" : "s"}
            {editable && dirtyCount > 0 && (
              <>
                <span className="mx-1">·</span>
                <span className="text-amber-700 dark:text-amber-400">
                  {dirtyCount} override{dirtyCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {plan.status === "approved" && (
            <Link
              href={`/plans/${plan.id}`}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <LayoutGrid className="size-3.5" aria-hidden />
              <span>Open board</span>
            </Link>
          )}
          {plan.status !== "approved" && (
            <>
              {onDiscuss && plan.status !== "failed" && !discussOpen && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openDiscuss}
                  disabled={busy || sending}
                  title="Send Claude a follow-up so it can revise this plan"
                >
                  <MessageSquarePlus className="mr-1 size-3.5" aria-hidden />
                  Discuss further
                </Button>
              )}
              <Button size="sm" onClick={onClick} disabled={busy || sending}>
                {busy
                  ? "Spawning phase agents…"
                  : plan.status === "failed"
                    ? "Retry"
                    : "Approve & spawn agents"}
              </Button>
            </>
          )}
        </div>
      </div>

      {discussOpen && onDiscuss && plan.status !== "approved" && (
        <div className="mt-3 rounded-md border bg-background p-3">
          <label className="block text-xs text-muted-foreground">
            What should change about this plan? Claude will read your
            note and call <span className="font-mono">submit_plan</span>{" "}
            again with a revision.
          </label>
          <textarea
            ref={textareaRef}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            // Cmd/Ctrl-Enter is the standard chat-app shortcut to send
            // — keeps the keyboard flow without forcing a mouse hop to
            // the Send button.
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void sendFeedback();
              }
            }}
            placeholder="e.g. split the auth phase into two — separate route handler from middleware refactor"
            rows={3}
            disabled={sending}
            className={cn(
              "mt-1.5 block w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm",
              "focus:outline-none focus:ring-1 focus:ring-ring",
            )}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDiscussOpen(false);
                setFeedback("");
              }}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void sendFeedback()}
              disabled={sending || feedback.trim().length === 0}
            >
              {sending ? "Sending…" : "Send to Claude"}
            </Button>
          </div>
        </div>
      )}

      <ol className="mt-3 space-y-2">
        {plan.phases.map((phase, i) => {
          const wt = plan.worktrees?.find((w) => w.phase_slug === phase.slug);
          const ps = plan.phase_sessions?.find((s) => s.phase_slug === phase.slug);
          const ov = overrides[phase.slug] ?? {};
          return (
            <li key={phase.slug} className="rounded-md border bg-background p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <span className="font-medium">{phase.title}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {phase.slug}
                </Badge>
                {phase.depends_on?.map((dep) => (
                  <Badge
                    key={dep}
                    variant="secondary"
                    className="font-mono text-[10px]"
                  >
                    ← {dep}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {phase.description}
              </p>

              <PhaseRuntimeRow
                phase={phase}
                override={ov}
                editable={editable}
                onChange={(patch) => updateOverride(phase.slug, patch)}
              />

              {wt && (
                <div className="mt-2 font-mono text-xs">
                  <span className="text-muted-foreground">worktree: </span>
                  <span>{wt.path}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span>{wt.branch}</span>
                </div>
              )}
              {ps && (
                <Link
                  href={`/chat/${ps.session_id}`}
                  className="mt-2 inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] hover:bg-muted"
                >
                  <span className="text-muted-foreground">agent:</span>
                  <span>{ps.session_id.slice(0, 8)}</span>
                  {ps.account_name && (
                    <span className="text-muted-foreground">
                      · {ps.account_name}
                    </span>
                  )}
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      {plan.status === "failed" && plan.error && (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Worktree creation failed</AlertTitle>
          <AlertDescription className="font-mono text-xs">
            {plan.error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// PhaseRuntimeRow surfaces the four per-phase runtime knobs (model,
// effort, TDD mode, file scope). Pre-approve it's editable; post-
// approve it renders as read-only badges so the user can see what
// was actually spawned. Scope is a textarea (one glob per line) —
// chip-input UX is heavier and globs aren't free-form values that
// benefit from validation-on-add anyway.
function PhaseRuntimeRow({
  phase,
  override,
  editable,
  onChange,
}: {
  phase: Phase;
  override: PhaseOverride;
  editable: boolean;
  onChange: (patch: PhaseOverride) => void;
}) {
  const effectiveModel = override.model ?? phase.model;
  const effectiveEffort = override.effort ?? phase.effort;
  const effectiveTdd = override.tdd_mode ?? phase.tdd_mode ?? false;
  const effectiveScope: PhaseScope | undefined = override.scope ?? phase.scope;
  const scopeFiles = effectiveScope?.files ?? [];

  if (!editable) {
    if (
      !effectiveModel &&
      !effectiveEffort &&
      !effectiveTdd &&
      scopeFiles.length === 0
    )
      return null;
    return (
      <div className="mt-2 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          {effectiveModel && (
            <Badge variant="outline">{labelFor(effectiveModel)}</Badge>
          )}
          {effectiveEffort && (
            <Badge variant="outline">effort: {effectiveEffort}</Badge>
          )}
          {effectiveTdd && (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            >
              <FlaskConical className="mr-1 size-3" aria-hidden />
              TDD
            </Badge>
          )}
          {scopeFiles.length > 0 && (
            <Badge variant="outline">
              <ScanLine className="mr-1 size-3" aria-hidden />
              scope: {scopeFiles.length}
            </Badge>
          )}
        </div>
        {scopeFiles.length > 0 && (
          <ul className="font-mono text-[10px] text-muted-foreground">
            {scopeFiles.map((g) => (
              <li key={g}>· {g}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">model:</span>
          <select
            value={override.model ?? ""}
            onChange={(e) => onChange({ model: e.target.value || undefined })}
            className={cn(
              "h-7 rounded-md border bg-background px-1.5 font-mono",
              "focus:outline-none focus:ring-1 focus:ring-ring",
            )}
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">effort:</span>
          <select
            value={override.effort ?? ""}
            onChange={(e) =>
              onChange({
                effort: e.target.value
                  ? (e.target.value as Effort)
                  : undefined,
              })
            }
            className={cn(
              "h-7 rounded-md border bg-background px-1.5 font-mono",
              "focus:outline-none focus:ring-1 focus:ring-ring",
            )}
          >
            {EFFORT_OPTIONS.map((opt) => (
              <option key={opt.value || "inherit"} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 font-mono",
            effectiveTdd
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "bg-muted/40 text-muted-foreground hover:bg-muted",
          )}
          title="When on, the kickoff prompt instructs the agent to write failing tests before implementing."
        >
          <input
            type="checkbox"
            checked={effectiveTdd}
            onChange={(e) => onChange({ tdd_mode: e.target.checked })}
            className="size-3"
          />
          <FlaskConical className="size-3" aria-hidden />
          <span>TDD-first</span>
        </label>
      </div>
      <div>
        <label className="block">
          <span className="flex items-center gap-1 text-muted-foreground">
            <ScanLine className="size-3" aria-hidden />
            file scope ({scopeFiles.length} glob
            {scopeFiles.length === 1 ? "" : "s"})
          </span>
          <textarea
            value={scopeFiles.join("\n")}
            placeholder="e.g. web/lib/auth/**&#10;web/app/api/auth/route.ts&#10;**/*.test.ts"
            spellCheck={false}
            onChange={(e) => {
              const lines = e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
              onChange({
                scope:
                  lines.length > 0
                    ? { files: Array.from(new Set(lines)) }
                    : undefined,
              });
            }}
            rows={Math.max(2, Math.min(6, scopeFiles.length + 1))}
            className={cn(
              "mt-1 block w-full rounded-md border bg-background px-2 py-1 font-mono text-[11px]",
              "focus:outline-none focus:ring-1 focus:ring-ring",
            )}
          />
        </label>
      </div>
    </div>
  );
}

function labelFor(model: string): string {
  const opt = MODEL_OPTIONS.find((m) => m.value === model);
  return opt ? opt.label : model;
}

function PlanStatusBadge({ status }: { status: PlanRecord["status"] }) {
  if (status === "approved") return <Badge>approved</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">awaiting approval</Badge>;
}
