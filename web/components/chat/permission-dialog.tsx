"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  PermissionDecision,
  PermissionRequest,
} from "@/lib/chat-types";

interface Props {
  request: PermissionRequest | null;
  onDecide: (decision: PermissionDecision) => Promise<void>;
}

export function PermissionDialog({ request, onDecide }: Props) {
  const [denyMessage, setDenyMessage] = useState("");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const open = request !== null;

  const onAllow = async () => {
    setBusy("allow");
    try {
      await onDecide({ behavior: "allow" });
    } finally {
      setBusy(null);
      setDenyMessage("");
    }
  };

  const onDeny = async () => {
    setBusy("deny");
    try {
      await onDecide({
        behavior: "deny",
        message: denyMessage.trim() || "denied by user",
      });
    } finally {
      setBusy(null);
      setDenyMessage("");
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Tool call: <span className="font-mono text-base">{request?.tool_name}</span>
          </DialogTitle>
          <DialogDescription>
            The agent wants to run a tool. Review the input and decide.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
          {request ? JSON.stringify(request.input, null, 2) : ""}
        </pre>
        <Textarea
          placeholder="Optional reason if denying"
          value={denyMessage}
          onChange={(e) => setDenyMessage(e.target.value)}
          rows={2}
        />
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={onDeny}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
          <Button disabled={busy !== null} onClick={onAllow}>
            {busy === "allow" ? "Allowing…" : "Allow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
