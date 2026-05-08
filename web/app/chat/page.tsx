import Link from "next/link";
import { listSessions } from "@/lib/server/sessions";
import { NewSessionButton } from "@/components/chat/new-session-button";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function ChatListPage() {
  const sessions = listSessions();

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Chat sessions</h1>
          <p className="text-sm text-muted-foreground">
            <Link href="/" className="hover:underline">
              ← Dashboard
            </Link>
          </p>
        </div>
        <NewSessionButton />
      </header>

      {sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          No sessions yet. Click <span className="font-medium">New session</span> to start one.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link
                href={`/chat/${s.id}`}
                className="flex items-center justify-between gap-4 p-3 hover:bg-muted/40"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{s.id.slice(0, 8)}</span>
                    <Badge
                      variant={
                        s.status === "errored"
                          ? "destructive"
                          : s.status === "closed"
                            ? "outline"
                            : s.status === "awaiting_permission"
                              ? "secondary"
                              : "default"
                      }
                    >
                      {s.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {s.cwd}
                    {s.account_name && <> · {s.account_name}</>}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.history_length} msg
                  <span className="mx-1">·</span>
                  {new Date(s.created_at).toLocaleTimeString()}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
