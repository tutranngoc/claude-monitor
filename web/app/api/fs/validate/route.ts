import path from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { NextResponse } from "next/server";

// Browsers can't expose absolute paths from <input type="file"
// webkitdirectory> — they hand back relative names only — so the
// composer's "Select folder…" UX falls back to a text input that we
// validate here. Node fs gives us an authoritative answer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const raw = body.path?.trim();
  if (!raw) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  // Expand a leading `~` since users routinely paste paths from terminals.
  const expanded = raw.startsWith("~")
    ? path.join(homedir(), raw.slice(1))
    : raw;
  if (!path.isAbsolute(expanded)) {
    return NextResponse.json(
      { ok: false, error: "path must be absolute" },
      { status: 200 },
    );
  }
  try {
    const s = await stat(expanded);
    if (!s.isDirectory()) {
      return NextResponse.json({
        ok: false,
        error: "not a directory",
        resolved: expanded,
      });
    }
    return NextResponse.json({ ok: true, resolved: expanded });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      resolved: expanded,
    });
  }
}
