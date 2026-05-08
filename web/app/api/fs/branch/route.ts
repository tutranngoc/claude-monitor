import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

// Returns the current git branch for a working directory. The composer
// shows it next to the path so the user can confirm which branch their
// agent is about to start mutating.
//
// We shell out to `git` (already on PATH for any dev box) rather than
// parsing .git/HEAD ourselves: the SDK's child shells do the same and
// we want exact agreement (e.g. detached-HEAD edge cases).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("path");
  if (!cwd) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  // Best-effort: missing repos / bare folders return ok:true with branch
  // null so the UI just hides the chip rather than flashing an error.
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 1500 },
    );
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      // Detached HEAD: report the short SHA instead so the user still
      // sees something meaningful.
      try {
        const { stdout: sha } = await exec(
          "git",
          ["rev-parse", "--short", "HEAD"],
          { cwd, timeout: 1000 },
        );
        return NextResponse.json({
          ok: true,
          branch: null,
          detached: sha.trim() || null,
        });
      } catch {
        return NextResponse.json({ ok: true, branch: null });
      }
    }
    return NextResponse.json({ ok: true, branch });
  } catch (err) {
    // Not a git repo, git missing, or path doesn't exist. The caller
    // treats `branch: null` the same as "no chip", so keep the response
    // shape consistent.
    return NextResponse.json({
      ok: false,
      branch: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
