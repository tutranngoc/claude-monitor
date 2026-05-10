import { NextResponse } from "next/server";
import { findPlanById, updatePlan, writePlan } from "@/lib/server/plans";
import { spawnReadyPending } from "@/lib/server/plan-scheduler";
import { MAX_MAX_CONCURRENT } from "@/lib/plan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  max_concurrent?: number | null;
  paused?: boolean;
}

// POST /api/plans/<plan-id>/settings
//
// Partial update for plan-level worker-pool controls. Either field
// (`max_concurrent`, `paused`) is optional; only the keys present in
// the request body are written. Pass `max_concurrent: null` to clear
// (revert to DEFAULT_MAX_CONCURRENT). Returns the updated plan plus
// the list of slugs the cap-bump or unpause just released.
//
// Side effect on unpause / cap-bump: re-runs `spawnReadyPending` so
// queued pending phases drain immediately. Without this the user would
// stare at a paused-then-unpaused plan thinking nothing happened until
// the next /complete fires the cascade.
export async function POST(req: Request, { params }: Ctx) {
  const { id: planId } = await params;
  if (!planId) {
    return NextResponse.json({ error: "plan id is required" }, { status: 400 });
  }

  let body: Body = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as Body;
    }
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Validate before touching disk so we never half-write.
  if ("max_concurrent" in body && body.max_concurrent !== null) {
    const n = body.max_concurrent;
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_MAX_CONCURRENT
    ) {
      return NextResponse.json(
        {
          error: `max_concurrent must be an integer between 1 and ${MAX_MAX_CONCURRENT}, or null to clear`,
        },
        { status: 400 },
      );
    }
  }
  if ("paused" in body && typeof body.paused !== "boolean") {
    return NextResponse.json(
      { error: "paused must be a boolean" },
      { status: 400 },
    );
  }

  const plan = await findPlanById(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }

  // Detect transitions that should trigger an immediate drain of the
  // pending queue. Both raising the cap and unpausing free slots that
  // ready phases were sitting in queue waiting for.
  const wasPaused = !!plan.paused;
  const prevCap = plan.max_concurrent;

  const updated = await updatePlan(plan.cwd, plan.id, (p) => {
    if ("max_concurrent" in body) {
      if (body.max_concurrent === null) {
        delete p.max_concurrent;
      } else {
        p.max_concurrent = body.max_concurrent;
      }
    }
    if ("paused" in body) {
      if (body.paused) {
        p.paused = true;
      } else {
        delete p.paused;
      }
    }
  });

  const justUnpaused = wasPaused && !updated.paused;
  const capRose =
    !updated.paused &&
    "max_concurrent" in body &&
    (updated.max_concurrent ?? 0) > (prevCap ?? 0);

  let spawnedDependents: string[] = [];
  if (justUnpaused || capRose) {
    spawnedDependents = spawnReadyPending(updated);
    if (spawnedDependents.length > 0) {
      // spawnReadyPending mutated `updated` in place; persist the new
      // pending_phases / phase_sessions split.
      await writePlan(updated);
    }
  }

  return NextResponse.json({
    plan: updated,
    spawned_dependents: spawnedDependents,
  });
}
