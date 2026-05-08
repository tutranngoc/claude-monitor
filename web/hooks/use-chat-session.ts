"use client";

import { useEffect, useReducer, useRef } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  PermissionDecision,
  PermissionRequest,
  SessionStatus,
} from "@/lib/chat-types";

export type ConnectionState = "connecting" | "open" | "closed";

interface State {
  history: SDKMessage[];
  status: SessionStatus;
  pendingPermission: PermissionRequest | null;
  errors: string[];
  connection: ConnectionState;
}

type Action =
  | { kind: "message"; msg: SDKMessage }
  | { kind: "status"; status: SessionStatus }
  | { kind: "permission_request"; req: PermissionRequest }
  | { kind: "permission_resolved" }
  | { kind: "chat_error"; message: string }
  | { kind: "connection"; state: ConnectionState };

const ERROR_CAP = 10;

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "message":
      return { ...state, history: [...state.history, action.msg] };
    case "status":
      return { ...state, status: action.status };
    case "permission_request":
      return { ...state, pendingPermission: action.req };
    case "permission_resolved":
      return { ...state, pendingPermission: null };
    case "chat_error":
      return { ...state, errors: [action.message, ...state.errors].slice(0, ERROR_CAP) };
    case "connection":
      return { ...state, connection: action.state };
  }
}

const initial: State = {
  history: [],
  status: "starting",
  pendingPermission: null,
  errors: [],
  connection: "connecting",
};

export interface UseChatSession extends State {
  send: (text: string) => Promise<void>;
  decide: (decision: PermissionDecision) => Promise<void>;
  stop: () => Promise<void>;
}

// useChatSession owns the EventSource subscription for one chat session
// plus the POST helpers for sending input, resolving permission prompts,
// and stopping the session. The subscription replays full history on
// connect so a tab refresh doesn't lose context.
export function useChatSession(sessionId: string): UseChatSession {
  const [state, dispatch] = useReducer(reducer, initial);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/chat/${sessionId}/events`);
    sourceRef.current = es;

    es.addEventListener("open", () => dispatch({ kind: "connection", state: "open" }));

    es.addEventListener("message", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as SDKMessage;
      dispatch({ kind: "message", msg: data });
    });
    es.addEventListener("status", (e) => {
      const { status } = JSON.parse((e as MessageEvent).data) as { status: SessionStatus };
      dispatch({ kind: "status", status });
    });
    es.addEventListener("permission_request", (e) => {
      const req = JSON.parse((e as MessageEvent).data) as PermissionRequest;
      dispatch({ kind: "permission_request", req });
    });
    es.addEventListener("permission_resolved", () => {
      dispatch({ kind: "permission_resolved" });
    });
    es.addEventListener("closed", () => {
      dispatch({ kind: "connection", state: "closed" });
      es.close();
    });

    // EventSource fires its own 'error' event on connection issues with
    // no .data; server-emitted error envelopes have a string .data. The
    // type discriminates the two without needing a separate listener.
    es.addEventListener("error", (e) => {
      const me = e as MessageEvent;
      if (typeof me.data === "string") {
        try {
          const { message } = JSON.parse(me.data) as { message: string };
          dispatch({ kind: "chat_error", message });
        } catch {
          // Malformed payload — drop.
        }
      }
    });

    return () => {
      es.close();
      sourceRef.current = null;
    };
  }, [sessionId]);

  const send = async (text: string) => {
    const res = await fetch(`/api/chat/${sessionId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `send failed: ${body}` });
    }
  };

  const decide = async (decision: PermissionDecision) => {
    const req = state.pendingPermission;
    if (!req) return;
    const res = await fetch(`/api/chat/${sessionId}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission_id: req.id, decision }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `decide failed: ${body}` });
    }
  };

  const stop = async () => {
    await fetch(`/api/chat/${sessionId}`, { method: "DELETE" });
  };

  return { ...state, send, decide, stop };
}
