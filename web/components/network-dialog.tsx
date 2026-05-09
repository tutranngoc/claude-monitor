"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LANSection } from "@/components/lan-section";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// NetworkDialog hosts LAN + Public exposure controls in their own
// modal. Split out from AccountsDialog because the combined view was
// long enough to feel cramped on phone screens, and the two surfaces
// are conceptually separate (one is "which Claude account is paying",
// the other is "where is the UI reachable from").
export function NetworkDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Same dynamic-viewport sizing as AccountsDialog so the LAN
        // section's QR + named-tunnel form fit comfortably on phones.
        className="max-h-[calc(100dvh-1rem)] max-w-2xl gap-3 overflow-y-auto p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:gap-4 sm:p-4"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">Network access</DialogTitle>
          <DialogDescription className="pr-8">
            Expose this orchestrator beyond loopback — over your local Wi-Fi
            (LAN) or via a Cloudflare tunnel (public).
          </DialogDescription>
        </DialogHeader>
        <LANSection />
      </DialogContent>
    </Dialog>
  );
}
