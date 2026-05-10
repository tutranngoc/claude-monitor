import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { PermissionMode } from "@/lib/chat-types";

import type { StoredSession } from "./session-store";
import { persistStoredSession } from "./session-store";

// Claude Code CLI's transcript layout:
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// The encoded cwd is the absolute path with `/` → `-`. The CLI also
// stores some directories without trailing pieces, so we just glob
// every project dir for the matching session-id file.
const CLI_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export class CliSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`No CLI session jsonl found for id ${id} under ${CLI_PROJECTS_DIR}`);
    this.name = "CliSessionNotFoundError";
  }
}

export interface ImportedCliSession {
  id: string;
  cwd: string;
  history: SDKMessage[];
  permission_mode: PermissionMode;
  model?: string;
  created_at: string;
}

// Find the jsonl file for a given session id. Scans every project dir
// once — O(n_projects) which is bounded by however many cwds the user
// has run claude in (typically a few dozen). Returns null when nothing
// matches; caller raises CliSessionNotFoundError.
//
// We deliberately don't try to decode the directory name into a cwd:
// Claude Code's encoding maps `/` → `-`, but the original cwd may also
// contain `-` (e.g. `claude-monitor`), so the encoding is lossy. The
// real cwd lives on every event line as a `cwd` field; parseCliSession
// reads it from there.
export async function findCliSessionFile(
  id: string,
): Promise<{ filePath: string } | null> {
  let dirs: string[];
  try {
    dirs = await fs.readdir(CLI_PROJECTS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const dir of dirs) {
    const filePath = path.join(CLI_PROJECTS_DIR, dir, `${id}.jsonl`);
    try {
      await fs.access(filePath);
      return { filePath };
    } catch {
      // ENOENT etc. — keep scanning.
    }
  }
  return null;
}

// One CLI jsonl event. Only the fields we read are typed; CLI ships
// many more we ignore (parentUuid, isMeta, gitBranch, version, ...).
interface CliEvent {
  type: string;
  uuid?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  permissionMode?: PermissionMode;
  cwd?: string;
  message?: { role?: string; model?: string; content?: unknown };
}

// Parse the jsonl file and build an ImportedCliSession. We:
//   - keep only `user` and `assistant` events (the SDK history shape)
//   - drop `isMeta` user lines (those are command caveats / stdouts the
//     CLI injects around slash-commands; replaying them would just
//     confuse the resumed run)
//   - drop sidechain assistants (Task sub-agents lived in their own
//     context window; we'd need parent_tool_use_id wiring to render
//     them, which the CLI doesn't expose verbatim — leaving them out
//     keeps the main timeline clean)
//   - track the latest permission-mode event so the imported session
//     boots into the same mode the CLI was in
//   - take the assistant model from the most recent assistant.message.model
export async function parseCliSession(
  filePath: string,
  id: string,
): Promise<{
  cwd: string | null;
  history: SDKMessage[];
  permission_mode: PermissionMode;
  model?: string;
  created_at: string;
}> {
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const history: SDKMessage[] = [];
  let permission_mode: PermissionMode = "default";
  let model: string | undefined;
  let cwd: string | null = null;

  for (const line of lines) {
    let ev: CliEvent;
    try {
      ev = JSON.parse(line) as CliEvent;
    } catch {
      // Skip malformed lines rather than failing the whole import.
      continue;
    }

    // First non-empty cwd wins. Every CLI event line carries the cwd
    // verbatim, so we get the real path back without trying to reverse
    // the lossy `/` → `-` directory encoding.
    if (!cwd && typeof ev.cwd === "string" && ev.cwd.startsWith("/")) {
      cwd = ev.cwd;
    }

    if (ev.type === "permission-mode" && ev.permissionMode) {
      permission_mode = ev.permissionMode;
      continue;
    }

    if (ev.type === "user" || ev.type === "assistant") {
      if (ev.isSidechain) continue;
      if (ev.type === "user" && ev.isMeta) continue;
      if (!ev.uuid || !ev.message) continue;
      if (ev.type === "assistant" && typeof ev.message.model === "string") {
        model = ev.message.model;
      }
      // Cast: SDKMessage is a discriminated union from the SDK; we can't
      // re-derive its template-literal uuid type at runtime, so we
      // assemble the wire shape and let the SDK consume it on resume.
      history.push({
        type: ev.type,
        uuid: ev.uuid,
        session_id: ev.sessionId ?? id,
        message: ev.message,
        parent_tool_use_id: null,
      } as unknown as SDKMessage);
    }
  }

  // mtime is the closest stand-in for "session created" we have without
  // re-walking the file for the first user line's timestamp. Good enough
  // for sidebar ordering — the user can sort by recency either way.
  const stat = await fs.stat(filePath);
  return {
    cwd,
    history,
    permission_mode,
    model,
    created_at: stat.mtime.toISOString(),
  };
}

// Top-level import. Builds a StoredSession that mirrors the CLI's
// transcript snapshot, persists it to ~/.claude-monitor/sessions/, and
// returns the StoredSession so the caller can register it with the live
// sessions registry. Resume itself happens lazily — when the user opens
// the chat tab, sessions.ts promotes it via SDK `resume: <id>`, and the
// SDK reads the same jsonl back from ~/.claude/projects/.
export async function importCliSession(opts: {
  id: string;
  configDir: string;
  accountName?: string;
}): Promise<StoredSession> {
  const found = await findCliSessionFile(opts.id);
  if (!found) throw new CliSessionNotFoundError(opts.id);
  const parsed = await parseCliSession(found.filePath, opts.id);
  if (!parsed.cwd) {
    // Every CLI line carries a cwd field; if the whole file has none
    // we'd be guessing the worktree, which the SDK needs to spawn the
    // resumed process. Fail loudly rather than picking a wrong default.
    throw new Error(
      `CLI session ${opts.id} has no cwd in any event line — cannot resume`,
    );
  }
  const stored: StoredSession = {
    version: 1,
    id: opts.id,
    cwd: parsed.cwd,
    config_dir: opts.configDir,
    account_name: opts.accountName,
    created_at: parsed.created_at,
    model: parsed.model,
    permission_mode: parsed.permission_mode,
    history: parsed.history,
  };
  await persistStoredSession(stored);
  return stored;
}
