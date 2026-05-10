// Shared metadata + cycle helpers for PermissionMode. Mirrors the
// canonical Claude Code CLI definitions (see leaked source
// src/utils/permissions/PermissionMode.ts and getNextPermissionMode.ts)
// so the web orchestrator's banner / picker / Shift+Tab cycle behave
// the same way users already expect from the terminal client.

import type { PermissionMode } from "./chat-types";

// Symbols match the CLI exactly: ⏸ for plan, ⏵⏵ for accept-edits and
// bypass. dontAsk + auto reuse ⏵⏵ since they're functionally
// auto-permissive too. Default carries no symbol.
const SYMBOL: Record<PermissionMode, string> = {
  default: "",
  plan: "⏸",
  acceptEdits: "⏵⏵",
  bypassPermissions: "⏵⏵",
  dontAsk: "⏵⏵",
  auto: "⏵⏵",
};

// Title mirrors the CLI's "permissionModeTitle" output — the banner
// uses the lowercased form ("plan mode on", "accept edits on") so
// these stay in Title Case for the picker.
const TITLE: Record<PermissionMode, string> = {
  default: "Default",
  plan: "Plan mode",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
  auto: "Auto mode",
};

// Tone drives the banner background + border. info = blue (plan,
// research-only); warn = amber (accept edits, file mutations land
// without a prompt but bash still asks); danger = red (bypass /
// auto, the full Yolo).
export type ModeTone = "neutral" | "info" | "warn" | "danger";

const TONE: Record<PermissionMode, ModeTone> = {
  default: "neutral",
  plan: "info",
  acceptEdits: "warn",
  bypassPermissions: "danger",
  dontAsk: "danger",
  auto: "danger",
};

export function permissionModeSymbol(mode: PermissionMode): string {
  return SYMBOL[mode] ?? "";
}

export function permissionModeTitle(mode: PermissionMode): string {
  return TITLE[mode] ?? TITLE.default;
}

export function permissionModeTone(mode: PermissionMode): ModeTone {
  return TONE[mode] ?? "neutral";
}

export function isDefaultPermissionMode(mode: PermissionMode): boolean {
  return mode === "default";
}

// Shift+Tab cycle order. Matches Claude Code's external (non-ant)
// cycle: default → acceptEdits → plan → bypassPermissions → default.
// dontAsk and auto are internal-only and not part of the user-facing
// cycle, so they reset to default if somehow reached.
const CYCLE: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const idx = CYCLE.indexOf(mode);
  if (idx === -1) return "default";
  return CYCLE[(idx + 1) % CYCLE.length];
}
