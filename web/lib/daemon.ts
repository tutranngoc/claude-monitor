// Types mirror the Go shapes in claude-monitor/internal/server. When the
// daemon evolves its wire format, update both sides together — the daemon
// is the source of truth and there's no codegen step.

export interface Window {
  utilization: number;
  resets_at: string | null;
}

export interface AccountState {
  name: string;
  config_dir: string;
  email?: string;
  account_uuid?: string;
  active: boolean;
  five_hour?: Window;
  weekly?: Window;
  weekly_sonnet?: Window;
  weekly_opus?: Window;
  kicked?: boolean;
  kick_error?: string;
  error?: string;
}

export interface Snapshot {
  accounts: AccountState[];
  active_dir: string;
  fetched_at: string;
}

export interface SwapEvent {
  from_name: string;
  to_name: string;
  from_util: number;
  to_util: number;
  reason: string;
}

export interface DaemonError {
  message: string;
}

// Discriminated union matching server.envelope { type, data }.
export type DaemonEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "swap"; data: SwapEvent }
  | { type: "error"; data: DaemonError };

// NEXT_PUBLIC_ env vars are inlined at build time. Override in
// web/.env.local for non-default daemon addresses.
export const DAEMON_URL =
  process.env.NEXT_PUBLIC_DAEMON_URL ?? "http://127.0.0.1:8788";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchHealth(signal?: AbortSignal): Promise<{
  status: string;
  uptime_seconds: number;
}> {
  const res = await fetch(`${DAEMON_URL}/api/health`, { signal });
  return jsonOrThrow(res);
}

export async function fetchAccounts(signal?: AbortSignal): Promise<Snapshot> {
  const res = await fetch(`${DAEMON_URL}/api/accounts`, { signal });
  return jsonOrThrow(res);
}

export async function swapTo(
  ident: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; active_dir: string }> {
  const res = await fetch(`${DAEMON_URL}/api/swap-to`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ident }),
    signal,
  });
  return jsonOrThrow(res);
}
