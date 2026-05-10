import { NextResponse } from "next/server";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import { spawnReadyPending } from "@/lib/server/plan-scheduler";
import type { Phase, PlanRecord } from "@/lib/plan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; slug: string }>;
}

interface Body {
  depends_on?: unknown;
}

// PATCH /api/plans/<plan-id>/phases/<phase-slug>/deps
//
// Replaces a phase's `depends_on` list. Used by the DAG view's drag-to-
// edit affordance — the user adds/removes edges in the graph and we
// persist the new adjacency to plan.json.
//
// Validation mirrors what submit_plan does at approval time: every dep
// must reference an existing phase slug, no self-edges, and the
// resulting graph must be acyclic. Cycle check uses a 3-color DFS
// against the proposed graph (i.e. the plan as it would look if we
// applied the change), so we don't need to roll the change back on
// rejection — we just refuse to write.
//
// Side effect: after a successful edit we run spawnReadyPending so
// pending phases whose blocking deps were just removed get released
// immediately. This is the same hook /complete uses on the cascade
// path; reusing it keeps the spawn logic in one place.
//
// Idempotent — sending the same depends_on list is a no-op.
export async function PATCH(req: Request, { params }: Ctx) {
  const { id: planId, slug } = await params;
  if (!planId || !slug) {
    return NextResponse.json(
      { error: "plan id and phase slug are required" },
      { status: 400 },
    );
  }

  let body: Body = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) body = JSON.parse(text) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(body.depends_on)) {
    return NextResponse.json(
      { error: "depends_on must be an array of phase slugs" },
      { status: 400 },
    );
  }
  for (const dep of body.depends_on) {
    if (typeof dep !== "string" || dep.length === 0) {
      return NextResponse.json(
        { error: "depends_on entries must be non-empty strings" },
        { status: 400 },
      );
    }
  }
  // De-dup preserving order so the persisted list is canonical.
  const seen = new Set<string>();
  const nextDeps: string[] = [];
  for (const dep of body.depends_on as string[]) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    nextDeps.push(dep);
  }

  const plan = await findPlanById(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }
  if (plan.status !== "approved") {
    return NextResponse.json(
      { error: "plan is not approved yet" },
      { status: 409 },
    );
  }

  const phase = plan.phases.find((p) => p.slug === slug);
  if (!phase) {
    return NextResponse.json(
      { error: `phase ${slug} not found in plan` },
      { status: 404 },
    );
  }
  if (nextDeps.includes(slug)) {
    return NextResponse.json(
      { error: "a phase cannot depend on itself" },
      { status: 400 },
    );
  }
  const validSlugs = new Set(plan.phases.map((p) => p.slug));
  for (const dep of nextDeps) {
    if (!validSlugs.has(dep)) {
      return NextResponse.json(
        { error: `unknown phase slug in depends_on: ${dep}` },
        { status: 400 },
      );
    }
  }

  if (wouldCycle(plan.phases, slug, nextDeps)) {
    return NextResponse.json(
      { error: "cycle would be introduced — refusing edit" },
      { status: 409 },
    );
  }

  let newlySpawned: string[] = [];
  const updated = await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    const idx = p.phases.findIndex((ph) => ph.slug === slug);
    if (idx < 0) return;
    const next: Phase = { ...p.phases[idx] };
    if (nextDeps.length === 0) {
      delete next.depends_on;
    } else {
      next.depends_on = nextDeps;
    }
    p.phases[idx] = next;
    // Releases any phase whose blockers were just removed. The cascade
    // is single-wave by design (matches /complete) — newly-spawned
    // phases this pass have no commit_status, so they can't unblock
    // anything else until /complete fires on them.
    newlySpawned = spawnReadyPending(p);
  });

  return NextResponse.json({
    plan: updated,
    spawned_dependents: newlySpawned,
  });
}

// wouldCycle returns true if changing `targetSlug.depends_on` to
// `proposedDeps` would introduce a cycle in the plan's dependency
// graph. 3-color DFS over edges (dep → phase) — a back edge to a node
// in the current path means cycle.
function wouldCycle(
  phases: readonly Phase[],
  targetSlug: string,
  proposedDeps: readonly string[],
): boolean {
  const adj = new Map<string, string[]>();
  for (const p of phases) {
    const deps = p.slug === targetSlug ? proposedDeps : (p.depends_on ?? []);
    // Edge points dep → p (dep must complete before p), so the cycle
    // search runs along the same direction as scheduling.
    for (const dep of deps) {
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(p.slug);
    }
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const p of phases) color.set(p.slug, WHITE);
  const stack: { slug: string; childIdx: number }[] = [];
  for (const p of phases) {
    if (color.get(p.slug) !== WHITE) continue;
    color.set(p.slug, GRAY);
    stack.push({ slug: p.slug, childIdx: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const children = adj.get(top.slug) ?? [];
      if (top.childIdx >= children.length) {
        color.set(top.slug, BLACK);
        stack.pop();
        continue;
      }
      const child = children[top.childIdx++];
      const c = color.get(child);
      if (c === GRAY) return true;
      if (c === WHITE) {
        color.set(child, GRAY);
        stack.push({ slug: child, childIdx: 0 });
      }
    }
  }
  return false;
}
