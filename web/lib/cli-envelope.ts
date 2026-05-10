// Synthetic user messages emitted by the Claude Code CLI wrap their
// payload in XML-style envelopes that aren't user-typed prose:
//   <command-name>/clear</command-name>
//   <command-message>clear</command-message>
//   <command-args></command-args>
//   <local-command-stdout>...</local-command-stdout>
//   <local-command-stderr>...</local-command-stderr>
// Rendering them verbatim or treating them as queued user input both
// look broken, so the chat surfaces strip / collapse them via this
// helper.

const ENVELOPE_PATTERNS: RegExp[] = [
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
];

export function stripCliEnvelopes(s: string): string {
  let out = s;
  for (const re of ENVELOPE_PATTERNS) out = out.replace(re, "");
  return out.trim();
}

export type CliEnvelope =
  | { kind: "prose"; text: string }
  | { kind: "notice"; label: string }
  | { kind: "silent" };

// parseCliEnvelope categorises a raw string user-message body:
//   prose  — has user-typed text (envelope tags already stripped)
//   notice — pure envelope; show as an inline italic notice
//   silent — pure envelope with no inner text worth showing
export function parseCliEnvelope(s: string): CliEnvelope {
  const stripped = stripCliEnvelopes(s);
  if (stripped) return { kind: "prose", text: stripped };
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(s);
  if (cmd && cmd[1].trim()) return { kind: "notice", label: cmd[1].trim() };
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(s);
  if (stdout && stdout[1].trim()) return { kind: "notice", label: stdout[1].trim() };
  const stderr = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/.exec(s);
  if (stderr && stderr[1].trim()) return { kind: "notice", label: stderr[1].trim() };
  return { kind: "silent" };
}
