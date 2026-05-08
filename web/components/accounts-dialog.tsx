"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertCircle, Plus, RefreshCw, Timer } from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import {
  addAccount,
  reloginAccount,
  swapTo,
  type AccountState,
  type Window,
} from "@/lib/daemon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ConnectionStatus } from "@/hooks/use-daemon";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "busy"; ident: string; what: "swap" | "relogin" };

// AccountsDialog is the rebuild of the previous full-page Dashboard.
// Each account renders as a card so name/status/swap-button stay on one
// line and the two util bars (5h, weekly) get full row width below — the
// earlier 3-column row collided once status badges grew (long error text
// like "refresh rate limited (retry in 1m49s)" overlapped util columns).
export function AccountsDialog({ open, onOpenChange }: Props) {
  const { snapshot, swapEvents, errors, status } = useDaemonContext();
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Tick every second so countdown labels ("resets in 1h 30m") stay live
  // while the dialog is open. The daemon snapshot itself only refreshes
  // every ~5s; this hook is what makes the seconds visibly tick down.
  const now = useNowTick(open ? 1000 : null);

  const onSwap = (ident: string) => {
    setAction({ kind: "busy", ident, what: "swap" });
    setActionErr(null);
    startTransition(async () => {
      try {
        await swapTo(ident);
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAction({ kind: "idle" });
      }
    });
  };

  const onRelogin = (ident: string) => {
    setAction({ kind: "busy", ident, what: "relogin" });
    setActionErr(null);
    startTransition(async () => {
      try {
        await reloginAccount(ident);
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAction({ kind: "idle" });
      }
    });
  };

  const accounts = snapshot?.accounts ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl shadow-2xl sm:max-w-3xl">
        <DialogHeader>
          {/* pr-8 keeps the dialog's absolute close-X (top-right) from
              overlapping the description. We split title + description
              vertically rather than flexing them into the close zone. */}
          <DialogTitle className="pr-8">Accounts</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8">
            <span>
              {accounts.length} account{accounts.length === 1 ? "" : "s"} ·
              managed by claude-monitor
            </span>
            <ConnectionPill
              status={status}
              fetchedAt={snapshot?.fetched_at}
              now={now}
            />
          </DialogDescription>
        </DialogHeader>

        {actionErr && (
          <Alert variant="destructive">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{actionErr}</AlertDescription>
          </Alert>
        )}

        {adding ? (
          <AddAccountForm
            onClose={() => setAdding(false)}
            onError={(msg) => setActionErr(msg)}
          />
        ) : (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
            >
              <Plus className="mr-1 size-3.5" />
              Add account
            </Button>
          </div>
        )}

        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {accounts.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              {status === "connecting"
                ? "Connecting to daemon…"
                : status === "error"
                  ? "Daemon unreachable. Run `claude-monitor --serve 127.0.0.1:8788`."
                  : "No accounts yet."}
            </div>
          ) : (
            accounts.map((a) => {
              const busy =
                pending &&
                action.kind === "busy" &&
                action.ident === a.name;
              return (
                <AccountCard
                  key={a.config_dir}
                  account={a}
                  busy={busy}
                  busyKind={busy ? action.what : undefined}
                  now={now}
                  onSwap={() => onSwap(a.name)}
                  onRelogin={() => onRelogin(a.name)}
                />
              );
            })
          )}
        </div>

        {(swapEvents.length > 0 || errors.length > 0) && (
          <section className="space-y-1.5">
            <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              Recent activity
            </h3>
            <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
              {swapEvents.map((e, i) => (
                <li key={`s${i}`} className="text-muted-foreground">
                  <span className="font-mono text-[10px]">swap</span>{" "}
                  {e.from_name} ({pct(e.from_util)}) → {e.to_name} (
                  {pct(e.to_util)}) ·{" "}
                  <span className="italic">{e.reason}</span>
                </li>
              ))}
              {errors.map((e, i) => (
                <li key={`e${i}`} className="text-destructive">
                  <span className="font-mono text-[10px]">error</span>{" "}
                  {e.message}
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountCard({
  account,
  busy,
  busyKind,
  now,
  onSwap,
  onRelogin,
}: {
  account: AccountState;
  busy: boolean;
  busyKind?: "swap" | "relogin";
  now: number;
  onSwap: () => void;
  onRelogin: () => void;
}) {
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        account.active ? "border-primary/30 bg-primary/[0.03]" : "bg-card"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
          {account.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{account.name}</span>
            {!account.error && <ShortStatus a={account} />}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {account.email ?? "—"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onRelogin}
            title="Reopen `claude auth login` for this account in Terminal"
          >
            {busy && busyKind === "relogin" ? "Opening…" : "Relogin"}
          </Button>
          {!account.active && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onSwap}
            >
              {busy && busyKind === "swap" ? "Swapping…" : "Swap to"}
            </Button>
          )}
        </div>
      </div>
      {/* Long error strings ("refresh rate limited (retry in 2m29s)")
          get their own row so they don't wrap mid-card and push the
          action buttons into a weird offset. */}
      {account.error && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          title={account.error}
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{account.error}</span>
        </div>
      )}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <UtilBlock label="5h session" w={account.five_hour} now={now} />
        <UtilBlock label="weekly" w={account.weekly} now={now} />
      </div>
    </div>
  );
}

function AddAccountForm({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await addAccount({ name: name.trim(), email: email.trim() || undefined });
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        New account
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="short name (a-Z, 0-9, .-_)"
          className="rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email (optional)"
          className="rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Provisions ~/.claude-{name || "<name>"} and opens Terminal for `claude
          auth login`.
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
          >
            {submitting ? "Opening…" : "Create & login"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function UtilBlock({
  label,
  w,
  now,
}: {
  label: string;
  w?: Window;
  now: number;
}) {
  if (!w) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{label}</span>
          <span>—</span>
        </div>
        <Progress value={0} className="h-1.5" />
      </div>
    );
  }
  const v = Math.round(w.utilization);
  const reset = formatResetCountdown(w.resets_at, now);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{v}%</span>
      </div>
      <Progress value={Math.min(v, 100)} className="h-1.5" />
      {/* Reset hint sits right under the bar so the eye reads:
          label · % → progress → "resets in 1h 30m". Title attr keeps the
          full ISO timestamp accessible on hover for power users. */}
      {reset && (
        <div
          className="flex items-center gap-1 text-[10px] text-muted-foreground/90"
          title={w.resets_at ?? undefined}
        >
          <Timer className="size-3" aria-hidden />
          <span className="tabular-nums">{reset}</span>
        </div>
      )}
    </div>
  );
}

// ShortStatus only renders the inline-safe states (active / kicked /
// idle). The error case is handled separately as a full-width strip
// below the row, since long messages used to wrap and break layout.
function ShortStatus({ a }: { a: AccountState }) {
  if (a.kicked) return <Badge variant="outline">kicked</Badge>;
  if (a.active) return <Badge>active</Badge>;
  return <Badge variant="secondary">idle</Badge>;
}

function ConnectionPill({
  status,
  fetchedAt,
  now,
}: {
  status: ConnectionStatus;
  fetchedAt?: string;
  now: number;
}) {
  const dot =
    status === "open"
      ? "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500"
        : "bg-destructive";
  const age = fetchedAt ? formatAge(fetchedAt, now) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={`inline-block size-1.5 rounded-full ${dot}`}
        aria-hidden
      />
      <span className="capitalize">{status}</span>
      {fetchedAt && (
        <span
          className="inline-flex items-center gap-1 tabular-nums"
          title={`Snapshot fetched at ${new Date(fetchedAt).toLocaleString()}`}
        >
          <RefreshCw className="size-3" aria-hidden />
          <span>refreshed {age}</span>
        </span>
      )}
    </span>
  );
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

// formatResetCountdown turns an OAuth-quota reset timestamp into a
// human-readable countdown. Negative deltas (already passed) read as
// "resets now" so the user sees that the daemon hasn't ticked yet —
// distinct from the missing-data case (handled by the empty UtilBlock).
function formatResetCountdown(
  iso: string | null | undefined,
  now: number,
): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const ms = target - now;
  if (ms <= 0) return "resets now";

  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const days = Math.floor(hours / 24);

  // > 1 day: "resets in 2d 3h" — minutes drop because second-level
  // updates aren't useful at this scale. < 1h: "resets in 4m 30s" so the
  // user sees seconds count down on the most-imminent window.
  if (days >= 1) {
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours >= 1) {
    return `resets in ${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  if (minutes >= 1) {
    return `resets in ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `resets in ${seconds}s`;
}

// formatAge renders how long ago the daemon snapshot arrived. Stays
// terse so the connection pill doesn't grow past one line: "2s ago",
// "5m ago", "1h ago".
function formatAge(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// useNowTick re-renders on a fixed interval so countdown displays show
// live seconds. Pass null to pause the timer (we do this when the
// dialog is closed so a hidden modal doesn't churn React work).
function useNowTick(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    // No initial setNow: the interval fires within intervalMs (1s in
    // practice) and the staleness on first paint is sub-second, which
    // is below any user-perceptible threshold for countdown labels.
    // Avoiding the synchronous setNow keeps us clean of the
    // set-state-in-effect lint.
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
