"use client";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface Props {
  msg: SDKMessage;
}

// MessageBubble is a switch over the SDKMessage discriminated union.
// We only render the types that meaningfully advance the conversation;
// noise types (stream_event partial deltas, hook progress, status pings,
// etc.) are hidden but kept in history so a backend rewind would have
// the full transcript.
export function MessageBubble({ msg }: Props) {
  switch (msg.type) {
    case "system":
      return <SystemBubble msg={msg} />;
    case "assistant":
      return <AssistantBubble msg={msg} />;
    case "user":
      return <UserBubble msg={msg} />;
    case "result":
      return <ResultBubble msg={msg} />;
    default:
      return null;
  }
}

function SystemBubble({ msg }: { msg: Extract<SDKMessage, { type: "system" }> }) {
  if (msg.subtype !== "init") return null;
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">Session ready</div>
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
        <span>cwd</span>
        <span>{msg.cwd}</span>
        <span>model</span>
        <span>{msg.model}</span>
        <span>permission</span>
        <span>{msg.permissionMode}</span>
        <span>tools</span>
        <span>{msg.tools.length} available</span>
      </div>
    </div>
  );
}

function AssistantBubble({
  msg,
}: {
  msg: Extract<SDKMessage, { type: "assistant" }>;
}) {
  const content = msg.message.content;
  return (
    <div className="space-y-2">
      {content.map((block, i) => {
        if (block.type === "text") {
          return (
            <div key={i} className="whitespace-pre-wrap rounded-md bg-card p-3 shadow-sm border">
              {block.text}
            </div>
          );
        }
        if (block.type === "tool_use") {
          return (
            <details
              key={i}
              className="rounded-md border bg-muted/40 p-3 text-xs"
            >
              <summary className="cursor-pointer font-mono">
                <span className="font-medium">{block.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · id={block.id.slice(0, 8)}
                </span>
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-background p-2">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </details>
          );
        }
        if (block.type === "thinking") {
          return (
            <div
              key={i}
              className="rounded-md border border-dashed bg-muted/20 p-3 text-xs italic text-muted-foreground whitespace-pre-wrap"
            >
              {block.thinking}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function UserBubble({ msg }: { msg: Extract<SDKMessage, { type: "user" }> }) {
  const content = msg.message.content;
  if (typeof content === "string") {
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
        {content}
      </div>
    );
  }
  // Tool results echoed back as user messages — render as a result card.
  return (
    <div className="space-y-2">
      {content.map((block, i) => {
        if (block.type === "text") {
          return (
            <div
              key={i}
              className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {block.text}
            </div>
          );
        }
        if (block.type === "tool_result") {
          const out =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                    .join("\n")
                : "";
          return (
            <details
              key={i}
              className="rounded-md border bg-muted/40 p-3 text-xs"
              open={block.is_error}
            >
              <summary className="cursor-pointer font-mono">
                <span className={block.is_error ? "text-destructive" : ""}>
                  result · {block.tool_use_id?.slice(0, 8)}
                  {block.is_error ? " (error)" : ""}
                </span>
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background p-2">
                {out}
              </pre>
            </details>
          );
        }
        return null;
      })}
    </div>
  );
}

function ResultBubble({
  msg,
}: {
  msg: Extract<SDKMessage, { type: "result" }>;
}) {
  return (
    <div className="rounded-md border-l-4 border-l-muted-foreground bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-mono">turn end</span>
      <span> · {msg.num_turns} turns</span>
      <span> · {Math.round(msg.duration_ms)}ms</span>
      <span>
        {" "}
        · ${msg.total_cost_usd.toFixed(4)}
      </span>
      {msg.is_error && (
        <span className="ml-2 text-destructive">
          {msg.subtype.replace("error_", "error: ")}
        </span>
      )}
    </div>
  );
}
