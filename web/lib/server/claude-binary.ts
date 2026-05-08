import "server-only";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Resolves the absolute path to the `claude` Code CLI executable. The SDK
// normally locates a native binary embedded as an optional dep
// (@anthropic-ai/claude-agent-sdk-darwin-arm64 etc.). When the install
// happened with --omit=optional those binaries are missing and the SDK
// throws "Native CLI binary for darwin-arm64 not found" at first use.
//
// Rather than asking the user to reinstall, we hand the SDK an explicit
// path to whatever `claude` is on PATH (or in known install locations).
// This also covers users who manage Claude Code via Homebrew or the
// official installer at ~/.local/share/claude/.
//
// Cached at module load: we never expect the binary to move between
// session creations within a single process lifetime, and the lookup
// itself does a synchronous spawn + a few existsSync checks, which we
// don't want to repeat per request.

let cached: string | null | undefined;

function tryWhich(): string | null {
  // execFileSync of `which` works on macOS + Linux; on Windows we fall
  // back to scanning PATH manually below. Wrapping in try/catch so a
  // missing `which` doesn't take the whole resolver down.
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [
      "claude",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    // `where` on Windows can return multiple lines; take the first.
    const first = out.split(/\r?\n/, 1)[0]!.trim();
    return existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function tryKnownLocations(): string | null {
  const home = os.homedir();
  const candidates = [
    // Official installer drops a versioned binary plus a stable symlink:
    //   ~/.local/bin/claude -> ~/.local/share/claude/versions/<ver>
    path.join(home, ".local/bin/claude"),
    path.join(home, ".local/share/claude/current"),
    // Homebrew on Apple Silicon / Intel.
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    // Linux distro packages.
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function findClaudeBinary(): string | null {
  if (cached !== undefined) return cached;
  // Explicit env override wins so users with an unusual install can
  // pin the path without touching code.
  const envPath = process.env.CLAUDE_CODE_PATH;
  if (envPath && existsSync(envPath)) {
    cached = envPath;
    return cached;
  }
  cached = tryWhich() ?? tryKnownLocations();
  return cached;
}
