"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDaemonContext } from "@/lib/daemon-context";
import { useSessions } from "@/lib/sessions-context";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RestoreSessionDialog imports a Claude Code CLI session into
// claude-monitor by id. The user pastes the session UUID, picks which
// OAuth account should drive the resumed run (usually the active one),
// and the server scans ~/.claude/projects/*/<id>.jsonl, mirrors it into
// ~/.claude-monitor/sessions/, and slots it into the interrupted-shadow
// map. The sidebar refreshes and the user is navigated into the chat.
export function RestoreSessionDialog({ open, onOpenChange }: Props) {
  const { snapshot } = useDaemonContext();
  const { refresh } = useSessions();
  const router = useRouter();

  const accounts = snapshot?.accounts ?? [];
  const active = accounts.find((a) => a.active);
  const [id, setId] = useState("");
  const [configDir, setConfigDir] = useState<string>(active?.config_dir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy default: when the active account flips after the dialog has
  // been mounted, push the new config_dir into the picker — but only
  // while the user hasn't manually picked one (string comparison
  // catches both "untouched" and "match the previous active").
  if (!configDir && active?.config_dir) {
    setConfigDir(active.config_dir);
  }

  const trimmed = id.trim();
  const idValid = UUID_RE.test(trimmed);
  const canSubmit = idValid && configDir && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: trimmed,
          config_dir: configDir,
          account_name: accounts.find((a) => a.config_dir === configDir)?.name,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg =
          (body && typeof body.error === "string" && body.error) ||
          `Import failed (${res.status})`;
        throw new Error(msg);
      }
      // Refresh the sidebar list so the new session appears, then
      // navigate. The chat panel itself fetches its own snapshot, so
      // it's fine if the sidebar refresh hasn't completed yet.
      refresh();
      router.push(`/chat/${trimmed}`);
      onOpenChange(false);
      setId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-4 p-4 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="pr-8">Restore CLI session</DialogTitle>
          <DialogDescription className="pr-8">
            Paste a Claude Code session ID and pick the account that should
            drive the resumed run. claude-monitor finds the transcript at{" "}
            <code className="font-mono text-[11px]">
              ~/.claude/projects/&lt;cwd&gt;/&lt;id&gt;.jsonl
            </code>
            , mirrors it locally, and resumes via the SDK.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium">Session ID</span>
            <input
              type="text"
              autoFocus
              value={id}
              onChange={(e) => setId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="03910876-c7e8-460f-a5b0-6ee647b3d48f"
              className={cn(
                "block w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                trimmed && !idValid
                  ? "border-destructive/60"
                  : "border-input",
              )}
            />
            {trimmed && !idValid && (
              <span className="block text-[11px] text-destructive">
                Must be a UUID (the filename of the .jsonl, without the
                extension).
              </span>
            )}
          </label>

          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium">Account</span>
            <select
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {accounts.length === 0 && <option value="">No accounts</option>}
              {accounts.map((a) => (
                <option key={a.config_dir} value={a.config_dir}>
                  {a.name}
                  {a.active ? " — active" : ""}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
