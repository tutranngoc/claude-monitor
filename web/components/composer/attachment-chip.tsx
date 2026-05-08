"use client";

import { FileText, ImageIcon, X } from "lucide-react";
import type { Attachment } from "@/lib/chat-types";

interface Props {
  attachment: Attachment;
  onRemove: () => void;
}

// AttachmentChip renders the preview row above the textarea. Image
// attachments show as a thumbnail with the X overlapping the corner
// (matches the spec screenshot); text files render as a small card with
// filename + line count + remove.
export function AttachmentChip({ attachment, onRemove }: Props) {
  if (attachment.type === "image") {
    return (
      <div className="group/att relative h-20 w-20 shrink-0 overflow-hidden rounded-md border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.data_url}
          alt={attachment.filename ?? "image"}
          className="h-full w-full object-cover"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove attachment"
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow ring-2 ring-background hover:bg-foreground/80"
        >
          <X className="size-3" />
        </button>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/60 to-transparent px-1 py-0.5 text-[10px] text-white">
          <ImageIcon className="size-2.5" />
          <span className="truncate">{attachment.filename ?? "image"}</span>
        </div>
      </div>
    );
  }

  // text_file
  const lines = attachment.content.split("\n").length;
  return (
    <div className="group/att relative flex min-w-0 max-w-xs items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{attachment.filename}</div>
        <div className="text-[10px] text-muted-foreground">
          {lines} line{lines === 1 ? "" : "s"}
          {attachment.language && ` · ${attachment.language}`}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove attachment"
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow ring-2 ring-background hover:bg-foreground/80"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
