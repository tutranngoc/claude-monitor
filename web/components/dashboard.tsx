"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useDaemon, type ConnectionStatus } from "@/hooks/use-daemon";
import { swapTo, type AccountState, type Window } from "@/lib/daemon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function Dashboard() {
  const { snapshot, swapEvents, errors, status } = useDaemon();
  const [pending, startTransition] = useTransition();
  const [busyIdent, setBusyIdent] = useState<string | null>(null);
  const [swapErr, setSwapErr] = useState<string | null>(null);

  const onSwap = (ident: string) => {
    setBusyIdent(ident);
    setSwapErr(null);
    startTransition(async () => {
      try {
        await swapTo(ident);
      } catch (e) {
        setSwapErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyIdent(null);
      }
    });
  };

  const accounts = snapshot?.accounts ?? [];

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">claude-monitor</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} account{accounts.length === 1 ? "" : "s"}
            <span className="mx-2">·</span>
            <Link href="/chat" className="hover:underline">
              Chat sessions →
            </Link>
          </p>
        </div>
        <ConnectionPill status={status} fetchedAt={snapshot?.fetched_at} />
      </header>

      {swapErr && (
        <Alert variant="destructive">
          <AlertTitle>Swap failed</AlertTitle>
          <AlertDescription>{swapErr}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>5h util</TableHead>
              <TableHead>Weekly util</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {status === "connecting"
                    ? "Connecting to daemon…"
                    : status === "error"
                      ? "Daemon unreachable. Is `claude-monitor --serve 127.0.0.1:8788` running?"
                      : "No accounts yet."}
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((a) => (
                <TableRow key={a.config_dir} className={a.active ? "bg-muted/40" : undefined}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell className="text-muted-foreground">{a.email ?? "—"}</TableCell>
                  <TableCell><UtilCell w={a.five_hour} /></TableCell>
                  <TableCell><UtilCell w={a.weekly} /></TableCell>
                  <TableCell><StatusBadge a={a} /></TableCell>
                  <TableCell className="text-right">
                    {!a.active && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending && busyIdent === a.name}
                        onClick={() => onSwap(a.name)}
                      >
                        {pending && busyIdent === a.name ? "Swapping…" : "Swap to"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {(swapEvents.length > 0 || errors.length > 0) && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Recent activity</h2>
          <ul className="space-y-1 text-sm">
            {swapEvents.map((e, i) => (
              <li key={`s${i}`} className="text-muted-foreground">
                <span className="font-mono text-xs">swap</span>{" "}
                {e.from_name} ({pct(e.from_util)}) → {e.to_name} ({pct(e.to_util)}){" "}
                · <span className="italic">{e.reason}</span>
              </li>
            ))}
            {errors.map((e, i) => (
              <li key={`e${i}`} className="text-destructive">
                <span className="font-mono text-xs">error</span> {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function UtilCell({ w }: { w?: Window }) {
  if (!w) return <span className="text-muted-foreground">—</span>;
  const pctVal = Math.round(w.utilization);
  return (
    <div className="flex items-center gap-2 min-w-32">
      <Progress value={Math.min(pctVal, 100)} className="flex-1" />
      <span className="tabular-nums text-xs w-9 text-right">{pctVal}%</span>
    </div>
  );
}

function StatusBadge({ a }: { a: AccountState }) {
  if (a.error) return <Badge variant="destructive">{a.error}</Badge>;
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
    status === "open" ? "bg-green-500" : status === "connecting" ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={`inline-block size-2 rounded-full ${dot}`} aria-hidden />
      <span className="capitalize">{status}</span>
      {fetchedAt && (
        <span className="text-xs">· last tick {new Date(fetchedAt).toLocaleTimeString()}</span>
      )}
    </div>
  );
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}
