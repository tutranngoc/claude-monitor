import { NextResponse } from "next/server";

import { CliSessionNotFoundError, importCliSession } from "@/lib/server/cli-import";
import { listSessions, registerImportedSession } from "@/lib/server/sessions";

// SDK + filesystem access — Node runtime, never the edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  session_id?: string;
  config_dir?: string;
  account_name?: string;
}

// POST /api/sessions/import — find the Claude Code CLI session whose
// jsonl lives at ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl,
// mirror it into ~/.claude-monitor/sessions/<id>.json, and slot it into
// the interrupted-shadow map. The user opens the tab; SDK `resume`
// hydrates the actual conversation state on first interaction.
//
// Body:
//   { session_id, config_dir, account_name? }
// Returns the SessionSummary for the imported session, same shape as
// POST /api/chat.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const id = body.session_id?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "session_id is required" },
      { status: 400 },
    );
  }
  // UUID sanity check — Claude Code session ids are RFC 4122 UUIDs.
  // Reject early so we don't traverse the projects dir for "../../etc/passwd".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json(
      { error: "session_id must be a UUID" },
      { status: 400 },
    );
  }
  if (!body.config_dir) {
    return NextResponse.json(
      { error: "config_dir is required" },
      { status: 400 },
    );
  }

  // If the user already has the session in claude-monitor, treat the
  // import as a no-op and return what we have. Avoids duplicate entries
  // when someone clicks the dialog twice.
  const existing = listSessions().find((s) => s.id === id);
  if (existing) return NextResponse.json(existing, { status: 200 });

  let stored;
  try {
    stored = await importCliSession({
      id,
      configDir: body.config_dir,
      accountName: body.account_name,
    });
  } catch (err) {
    if (err instanceof CliSessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const ok = registerImportedSession(stored);
  if (!ok) {
    // Race: someone registered the same id between the listSessions
    // check and registerImportedSession. Fall through to listSessions
    // for the canonical summary.
    const after = listSessions().find((s) => s.id === id);
    if (after) return NextResponse.json(after, { status: 200 });
    return NextResponse.json(
      { error: "session registration race" },
      { status: 500 },
    );
  }

  const summary = listSessions().find((s) => s.id === id);
  return NextResponse.json(summary, { status: 201 });
}
