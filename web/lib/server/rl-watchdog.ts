import "server-only";

import { pickSwapAccount } from "@/lib/server/account-swap";
import { listAllPlans, updatePlan } from "@/lib/server/plans";
import { restartPhaseSession } from "@/lib/server/plan-scheduler";
import { snapshotSession } from "@/lib/server/sessions";
import type { RateLimitInfo } from "@/lib/chat-types";

// rl-watchdog auto-restarts phase sessions that hit a rate-limit ceiling
// hard enough to drop out of the SDK's internal retry loop. Without
// this, an errored phase sits idle until the human notices and clicks
// the manual restart button — which defeats the unattended-overnight
// scheduling the orchestrator is built for.
//
// The SDK retries up to CLAUDE_CODE_MAX_RETRIES (default 10) on every
// rate_limit_event. If those retries exhaust we surface SessionStatus
// "errored" with the last RateLimitInfo still pinned to the session.
// Once `resetsAt` falls into the past we know a fresh attempt has
// budget again — we restart the phase using the same code path the
// manual button uses.
//
// Two restart strategies, picked per tick:
//   - SAME-ACCOUNT restart: bucket has reopened (`resetsAt` in the
//     past + grace window). Cheapest path — same creds, same context.
//   - SWAP-ACCOUNT restart: bucket still closed AND `resetsAt` is far
//     enough in the future that waiting wastes scheduler capacity.
//     We ask the daemon for a fresh account (excluding ones this phase
//     has already burned through) and restart with that override.
//
// Cooldown: skip phases whose `spawned_at` is within the last
// COOLDOWN_MS. spawnPhaseSession bumps spawned_at on each restart, so
// this naturally throttles loops where a freshly-spawned session
// immediately re-errors (e.g. account is wedged in a different way and
// the RL info we trust is stale).

const TICK_MS = 60_000;
const COOLDOWN_MS = 90_000;
// resetsAt has second precision and clocks drift; wait a small grace
// window past the reset before assuming the bucket is open. Anthropic's
// own dashboards do something similar.
const RESET_GRACE_MS = 15_000;
// rate_limited (not errored) sessions usually clear themselves via the
// SDK's internal retry. Only nudge them if they've been past resetsAt
// for a while, suggesting the retry never landed (network drop, binary
// wedged, …).
const STUCK_RATE_LIMITED_MS = 5 * 60_000;
// Threshold at which we'd rather migrate the phase to a different
// account than wait for the current one's bucket to reopen. Picked
// to match the user's "30 minutes" guideline: shorter waits stay on
// the original account so the phase keeps its session-local context
// once retries land.
const SWAP_HORIZON_MS = 30 * 60_000;
// Number of consecutive ticks where shouldSwap=true but pickSwapAccount
// returned null before we mark the phase `exhausted`. 3 ticks = 3
// minutes of "no eligible account anywhere". Picks up genuine pool
// exhaustion without flagging transient daemon hiccups.
export const EXHAUSTION_TICK_THRESHOLD = 3;

const WATCHDOG_KEY = Symbol.for("claude-monitor.web.rl-watchdog");
type WatchdogGlobal = typeof globalThis & {
  [WATCHDOG_KEY]?: ReturnType<typeof setInterval>;
};
const g = globalThis as WatchdogGlobal;

export function startRlResetWatchdog(): void {
  if (g[WATCHDOG_KEY]) return; // already armed (HMR / repeated import)
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Don't keep the Node process alive just for the watchdog — when
  // every other handle is closed we want a clean exit.
  if (typeof timer.unref === "function") timer.unref();
  g[WATCHDOG_KEY] = timer;
}

export function stopRlResetWatchdog(): void {
  const timer = g[WATCHDOG_KEY];
  if (!timer) return;
  clearInterval(timer);
  delete g[WATCHDOG_KEY];
}

async function tick(): Promise<void> {
  let plans;
  try {
    plans = await listAllPlans();
  } catch (err) {
    console.warn("[rl-watchdog] listAllPlans failed:", err);
    return;
  }
  const now = Date.now();
  for (const plan of plans) {
    if (plan.status !== "approved") continue;
    const phaseBySlug = new Map(plan.phases.map((p) => [p.slug, p]));
    for (const link of plan.phase_sessions ?? []) {
      try {
        if (
          link.commit_status === "clean" ||
          link.commit_status === "committed"
        ) {
          continue;
        }
        const spawnedAt = Date.parse(link.spawned_at);
        if (Number.isFinite(spawnedAt) && now - spawnedAt < COOLDOWN_MS) {
          continue;
        }
        const phase = phaseBySlug.get(link.phase_slug);
        if (!phase) continue;
        const worktree = plan.worktrees?.find(
          (w) => w.phase_slug === link.phase_slug,
        );
        if (!worktree) continue;

        const snap = snapshotSession(link.session_id);
        if (!snap) continue;

        // Swap path runs first: if waiting on the current account would
        // cost too much scheduler time, try migrating before falling
        // back to the same-account restart policy. Successful restarts
        // (swap or same-account) auto-clear `exhausted_*` because
        // restartPhaseSession replaces the phase_sessions entry wholesale
        // with a fresh record — no explicit clear needed here.
        if (
          shouldSwap(snap.summary.status, snap.summary.rate_limit, now)
        ) {
          const burnt = new Set<string>(link.account_attempts ?? []);
          if (link.account_name) burnt.add(link.account_name);
          const next = await pickSwapAccount({ exclude: Array.from(burnt) });
          if (next) {
            console.log(
              `[rl-watchdog] swapping phase ${plan.id}/${link.phase_slug}: ${link.account_name ?? "(none)"} → ${next.account_name} (resetsAt=${snap.summary.rate_limit?.resetsAt})`,
            );
            await restartPhaseSession({
              plan,
              phase,
              link,
              worktree,
              accountOverride: {
                configDir: next.config_dir,
                accountName: next.account_name,
              },
            });
            continue;
          }
          // No eligible account — bump the exhaustion counter. Once it
          // crosses EXHAUSTION_TICK_THRESHOLD we stamp `exhausted_at`
          // so the UI banners. We still fall through to same-account
          // restart in case the bucket has actually reopened in the
          // meantime; if that also says "wait", we wait.
          console.warn(
            `[rl-watchdog] no swap candidate for ${plan.id}/${link.phase_slug} (burnt=${Array.from(burnt).join(",") || "(none)"})`,
          );
          await bumpExhaustion(plan.id, plan.cwd, link.phase_slug);
        }

        if (!shouldRestart(snap.summary.status, snap.summary.rate_limit, now)) {
          // Phase is in a holding state (rate_limited but bucket not
          // open, or errored but resetsAt unknown). If it actually
          // recovered organically (status no longer rate_limited /
          // errored) and we still have stale exhausted_* fields from a
          // previous spell, clear them so the banner disappears without
          // requiring a restart.
          if (
            snap.summary.status !== "rate_limited" &&
            snap.summary.status !== "errored" &&
            ((link.exhausted_attempts ?? 0) > 0 || link.exhausted_at)
          ) {
            await clearExhaustion(plan.id, plan.cwd, link.phase_slug);
          }
          continue;
        }

        console.log(
          `[rl-watchdog] restarting phase ${plan.id}/${link.phase_slug} (status=${snap.summary.status}, resetsAt=${snap.summary.rate_limit?.resetsAt})`,
        );
        await restartPhaseSession({ plan, phase, link, worktree });
      } catch (err) {
        // One bad entry shouldn't kill the sweep.
        console.warn(
          `[rl-watchdog] sweep failed for ${plan.id}/${link.phase_slug}:`,
          err,
        );
      }
    }
  }
}

// bumpExhaustion is fire-and-forget per tick: increments the phase's
// `exhausted_attempts` counter and stamps `exhausted_at` once it
// crosses the threshold. The plan record is the source of truth for
// the UI banner; persisting here means the banner appears within one
// poll cycle of the third null swap.
async function bumpExhaustion(
  planId: string,
  cwd: string,
  phaseSlug: string,
): Promise<void> {
  try {
    await updatePlan(cwd, planId, (p) => {
      const link = p.phase_sessions?.find((s) => s.phase_slug === phaseSlug);
      if (!link) return;
      link.exhausted_attempts = (link.exhausted_attempts ?? 0) + 1;
      if (
        link.exhausted_attempts >= EXHAUSTION_TICK_THRESHOLD &&
        !link.exhausted_at
      ) {
        link.exhausted_at = new Date().toISOString();
      }
    });
  } catch (err) {
    console.warn(
      `[rl-watchdog] persist exhaustion bump for ${planId}/${phaseSlug} failed:`,
      err,
    );
  }
}

// clearExhaustion resets both the counter and the timestamp once the
// phase finds breathing room — successful swap or same-account restart.
// No-op when neither field is set (cheapest path for healthy phases).
async function clearExhaustion(
  planId: string,
  cwd: string,
  phaseSlug: string,
): Promise<void> {
  try {
    await updatePlan(cwd, planId, (p) => {
      const link = p.phase_sessions?.find((s) => s.phase_slug === phaseSlug);
      if (!link) return;
      if (
        (link.exhausted_attempts ?? 0) === 0 &&
        !link.exhausted_at
      ) {
        return;
      }
      delete link.exhausted_attempts;
      delete link.exhausted_at;
    });
  } catch (err) {
    console.warn(
      `[rl-watchdog] persist exhaustion clear for ${planId}/${phaseSlug} failed:`,
      err,
    );
  }
}

// shouldRestart encodes the same-account restart policy. Exported only
// for unit-style tests (none yet) — runtime callers go through tick().
export function shouldRestart(
  status: string,
  rl: RateLimitInfo | undefined,
  now: number,
): boolean {
  if (!rl?.resetsAt) return false;
  const resetMs = rl.resetsAt * 1000;
  if (status === "errored") {
    // SDK gave up — restart as soon as the bucket has plausibly opened.
    return now >= resetMs + RESET_GRACE_MS;
  }
  if (status === "rate_limited") {
    // SDK is supposedly retrying internally. Only intervene if the
    // window has been open long enough that a healthy retry should
    // already have moved us out of this state.
    return now >= resetMs + STUCK_RATE_LIMITED_MS;
  }
  return false;
}

// shouldSwap encodes the migrate-to-another-account policy. Fires when
// a rate_limit_event has pinned `resetsAt` more than SWAP_HORIZON_MS
// into the future — by that point waiting would idle the phase past
// the user's tolerance for unattended scheduling. Status must be one
// the SDK considers blocking (rate_limited / errored); a healthy phase
// shouldn't be migrated just because it has stale RL info.
export function shouldSwap(
  status: string,
  rl: RateLimitInfo | undefined,
  now: number,
): boolean {
  if (!rl?.resetsAt) return false;
  if (status !== "rate_limited" && status !== "errored") return false;
  const resetMs = rl.resetsAt * 1000;
  return resetMs - now > SWAP_HORIZON_MS;
}
