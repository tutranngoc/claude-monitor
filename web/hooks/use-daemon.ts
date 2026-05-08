"use client";

import { useEffect, useReducer, useRef } from "react";
import {
  DAEMON_URL,
  type DaemonError,
  type Snapshot,
  type SwapEvent,
} from "@/lib/daemon";

export type ConnectionStatus = "connecting" | "open" | "error";

interface DaemonState {
  snapshot: Snapshot | null;
  swapEvents: SwapEvent[];
  errors: DaemonError[];
  status: ConnectionStatus;
}

type Action =
  | { kind: "status"; status: ConnectionStatus }
  | { kind: "snapshot"; snapshot: Snapshot }
  | { kind: "swap"; event: SwapEvent }
  | { kind: "error"; error: DaemonError };

// Cap event history so a long-running tab doesn't grow unbounded; UI
// only shows the most recent few anyway.
const MAX_EVENTS = 20;

function reducer(state: DaemonState, action: Action): DaemonState {
  switch (action.kind) {
    case "status":
      return { ...state, status: action.status };
    case "snapshot":
      return { ...state, snapshot: action.snapshot, status: "open" };
    case "swap":
      return {
        ...state,
        swapEvents: [action.event, ...state.swapEvents].slice(0, MAX_EVENTS),
      };
    case "error":
      return {
        ...state,
        errors: [action.error, ...state.errors].slice(0, MAX_EVENTS),
      };
  }
}

const initialState: DaemonState = {
  snapshot: null,
  swapEvents: [],
  errors: [],
  status: "connecting",
};

// useDaemon subscribes to the daemon's /api/events SSE stream. The first
// event after connect is always a `snapshot` (server sends it on connect),
// then ticks/swaps stream as they happen. EventSource handles reconnection
// automatically, so we just track the connection status.
export function useDaemon() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = `${DAEMON_URL}/api/events`;
    const es = new EventSource(url);
    sourceRef.current = es;

    es.addEventListener("open", () => dispatch({ kind: "status", status: "open" }));
    es.addEventListener("error", () => dispatch({ kind: "status", status: "error" }));

    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as Snapshot;
      dispatch({ kind: "snapshot", snapshot: data });
    });
    es.addEventListener("swap", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as SwapEvent;
      dispatch({ kind: "swap", event: data });
    });
    es.addEventListener("error", (e) => {
      // Two error sources end up here: real connection errors (no .data)
      // and server-sent `event: error` envelopes. Discriminate by data
      // presence — connection errors already updated status above.
      const me = e as MessageEvent;
      if (typeof me.data !== "string") return;
      try {
        const data = JSON.parse(me.data) as DaemonError;
        dispatch({ kind: "error", error: data });
      } catch {
        // Malformed payload — ignore rather than crash the stream.
      }
    });

    return () => {
      es.close();
      sourceRef.current = null;
    };
  }, []);

  return state;
}
