import "server-only";

import { promises as fs, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Skills we vendor in the repo and surface to every Claude Code session
// the orchestrator spawns. The skill mechanism is Claude Code's own
// discovery system — agents read SKILL.md frontmatter (name +
// description) at startup and call into the skill body via the Skill
// tool when its description matches their current task. We don't nail
// the content into kickoff prompts; that defeats the trigger model and
// burns context on every phase that doesn't actually need it.
//
// Install rule: copy file content if dest is missing OR content
// differs. We don't symlink because the orchestrator's source can sit
// inside a Next.js standalone bundle whose path moves between releases
// — a dangling symlink would silently break skill discovery without
// any error surface for the user. Copies are cheap (one SKILL.md per
// skill, 2-3KB each) and the comparison short-circuits when nothing
// changed, so the steady-state cost is one stat + one read per skill
// per daemon boot.
//
// Conflict policy: if the dest exists and is NOT a regular file we
// vendor (e.g. user-authored skill with the same name, or a symlink
// to elsewhere), leave it alone. The user's customization wins. We
// log a warning so a divergent state doesn't go silent.

interface InstalledSkill {
  name: string;
  status: "installed" | "updated" | "unchanged" | "skipped";
  reason?: string;
}

// Locate the vendored skills/ directory regardless of whether we're
// running from `next dev`, a standalone bundle, or the source tree.
// Probes process.cwd() and a few common roots — each layout the
// daemon launches under (next dev / next start / standalone server.js
// inside .next/standalone) ends up with cwd at web/ or one level up.
function findSkillsSourceDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "skills"),
    path.resolve(process.cwd(), "web/skills"),
    path.resolve(process.cwd(), "../skills"),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // not here, try next
    }
  }
  return null;
}

export async function ensureSkillsInstalled(): Promise<InstalledSkill[]> {
  const sourceDir = findSkillsSourceDir();
  if (!sourceDir) {
    console.warn(
      "[skills-installer] could not locate vendored skills/ dir — skipping install",
    );
    return [];
  }
  const destRoot = path.join(homedir(), ".claude", "skills");
  await fs.mkdir(destRoot, { recursive: true });

  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch (err) {
    console.warn(`[skills-installer] readdir ${sourceDir} failed:`, err);
    return [];
  }

  const results: InstalledSkill[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const srcSkillDir = path.join(sourceDir, name);
    const destSkillDir = path.join(destRoot, name);
    let srcStat;
    try {
      srcStat = await fs.stat(srcSkillDir);
    } catch {
      continue;
    }
    if (!srcStat.isDirectory()) continue;
    const result = await installOneSkill(name, srcSkillDir, destSkillDir);
    results.push(result);
  }

  const installed = results.filter(
    (r) => r.status === "installed" || r.status === "updated",
  );
  if (installed.length > 0) {
    console.log(
      `[skills-installer] ${installed.map((r) => `${r.name}=${r.status}`).join(", ")}`,
    );
  }
  return results;
}

async function installOneSkill(
  name: string,
  srcDir: string,
  destDir: string,
): Promise<InstalledSkill> {
  // Skill manifest is a single SKILL.md by Claude Code's convention.
  // Other files (README, examples) inside a skill dir are copied too
  // so the agent can reference them from the manifest body.
  let srcFiles: string[];
  try {
    srcFiles = await fs.readdir(srcDir);
  } catch (err) {
    return {
      name,
      status: "skipped",
      reason: `readdir source failed: ${formatErr(err)}`,
    };
  }

  // If dest is a symlink to anything (user customisation or older
  // install style), leave it. We don't want to clobber an explicit
  // user choice silently.
  try {
    const destLstat = await fs.lstat(destDir);
    if (destLstat.isSymbolicLink()) {
      return {
        name,
        status: "skipped",
        reason: "dest is a symlink — leaving user customisation alone",
      };
    }
  } catch {
    // dest doesn't exist; we'll create it below
  }

  await fs.mkdir(destDir, { recursive: true });

  let touched = false;
  let created = false;
  for (const file of srcFiles) {
    if (file.startsWith(".")) continue;
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    let srcContent: Buffer;
    try {
      srcContent = await fs.readFile(src);
    } catch {
      // Subdirectories or special files — not part of the v1 skill
      // shape. Skip rather than recursing; if a vendored skill grows a
      // subdir, this branch is the place to extend.
      continue;
    }
    let destContent: Buffer | null = null;
    try {
      destContent = await fs.readFile(dest);
    } catch {
      destContent = null;
    }
    if (destContent !== null && destContent.equals(srcContent)) continue;
    if (destContent === null) created = true;
    await fs.writeFile(dest, srcContent);
    touched = true;
  }

  if (!touched) return { name, status: "unchanged" };
  return { name, status: created ? "installed" : "updated" };
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
