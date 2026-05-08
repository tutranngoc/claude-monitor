"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Plus } from "lucide-react";
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
  onSwap,
  onRelogin,
}: {
  account: AccountState;
  busy: boolean;
  busyKind?: "swap" | "relogin";
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
        <UtilBlock label="5h" w={account.five_hour} />
        <UtilBlock label="weekly" w={account.weekly} />
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

function UtilBlock({ label, w }: { label: string; w?: Window }) {
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
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{v}%</span>
      </div>
      <Progress value={Math.min(v, 100)} className="h-1.5" />
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
}: {
  status: ConnectionStatus;
  fetchedAt?: string;
}) {
  const dot =
    status === "open"
      ? "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500"
        : "bg-destructive";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={`inline-block size-1.5 rounded-full ${dot}`}
        aria-hidden
      />
      <span className="capitalize">{status}</span>
      {fetchedAt && (
        <span className="tabular-nums">
          · {new Date(fetchedAt).toLocaleTimeString()}
        </span>
      )}
    </span>
  );
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}
