import "server-only";

import { assignPhaseAccounts, type PhaseAssignment } from "@/lib/daemon";

// pickSwapAccount asks the daemon for a phase assignment that is NOT
// any of the accounts this phase has already burned through. The daemon
// ranks by 5h utilization (ascending), so the first candidate is the
// freshest account in the pool.
//
// Returns null when the daemon couldn't find an eligible account —
// typically because every active account is in the exclude set (we've
// tried them all on this phase). Caller should then leave the phase
// errored rather than churn.
//
// Note on the daemon round-robin: assignPhaseAccounts will round-robin
// when `count` exceeds the eligible pool. We always pass count=1 with
// a tight exclude list, so any account it returns is honored — but we
// still defensively check it isn't in `exclude` (defense in depth
// against a daemon-side bug).
export async function pickSwapAccount(args: {
  exclude: string[];
}): Promise<PhaseAssignment | null> {
  const exclude = Array.from(new Set(args.exclude.filter(Boolean)));
  let resp;
  try {
    resp = await assignPhaseAccounts({ count: 1, exclude });
  } catch (err) {
    console.warn("[account-swap] assignPhaseAccounts failed:", err);
    return null;
  }
  const pick = resp.assignments[0];
  if (!pick) return null;
  if (exclude.includes(pick.account_name)) {
    console.warn(
      `[account-swap] daemon returned excluded account ${pick.account_name} — refusing to swap`,
    );
    return null;
  }
  return pick;
}
