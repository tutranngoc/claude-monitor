"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DEFAULT_MODEL_ID,
  EFFORT_LABELS,
  MODELS,
  modelById,
  type ModelInfo,
} from "@/lib/models";
import type { Effort } from "@/lib/chat-types";

interface Props {
  modelId: string;
  effort: Effort;
  onModelChange: (id: string) => void;
  onEffortChange: (e: Effort) => void;
}

// ModelEffortPicker mirrors Claude Code CLI's combined picker: one chip
// summarizes "<model> · <effort>", and the popover lists both sections
// stacked with a separator. Effort options are filtered by the selected
// model's `supportedEffortLevels` (xhigh = Opus only, max = Opus only).
export function ModelEffortPicker({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const current = modelById(modelId);
  const supportedEfforts = current?.supportedEffortLevels ?? [
    "low",
    "medium",
    "high",
  ];

  const alternatives = MODELS.filter((m) => m.id !== modelId);

  const pickModel = (id: string) => {
    onModelChange(id);
    // Drop unsupported effort to a sensible fallback when the new
    // model can't run the current effort (e.g. switching Opus → Haiku
    // collapses xhigh/max).
    const next = modelById(id);
    if (next && !next.supportedEffortLevels.includes(effort)) {
      onEffortChange(next.supportedEffortLevels.at(-1) ?? "high");
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs font-medium hover:bg-muted"
          />
        }
      >
        <span className="font-medium">{current?.label ?? modelId}</span>
        {current?.badge && (
          <span className="text-muted-foreground">{current.badge}</span>
        )}
        <span className="text-muted-foreground">·</span>
        <span>{EFFORT_LABELS[effort]}</span>
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end" side="top">
        <div className="px-3 pt-3 pb-1.5">
          <div className="text-xs text-muted-foreground">Models</div>
        </div>
        <ul className="px-1.5 pb-1.5">
          {current && (
            <ModelRow
              model={current}
              selected
              isDefault={current.id === DEFAULT_MODEL_ID}
              onPick={pickModel}
            />
          )}
        </ul>
        <div className="mx-3 border-t" />
        <ul className="px-1.5 pt-1.5 pb-1.5">
          {alternatives.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              selected={false}
              isDefault={m.id === DEFAULT_MODEL_ID}
              onPick={pickModel}
            />
          ))}
        </ul>
        <div className="mx-3 border-t" />
        <div className="px-3 pt-3 pb-1.5">
          <div className="text-xs text-muted-foreground">Effort</div>
        </div>
        <ul className="px-1.5 pb-2">
          {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => {
            const enabled = supportedEfforts.includes(e);
            const selected = e === effort;
            return (
              <li key={e}>
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => {
                    onEffortChange(e);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <span className="flex-1">{EFFORT_LABELS[e]}</span>
                  {selected && <Check className="size-3.5 shrink-0" />}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  model,
  selected,
  isDefault,
  onPick,
}: {
  model: ModelInfo;
  selected: boolean;
  isDefault: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(model.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
      >
        <span className="text-sm font-medium">{model.label}</span>
        {model.badge && (
          <span className="text-xs text-muted-foreground">{model.badge}</span>
        )}
        {isDefault && (
          <span className="text-xs text-muted-foreground">Default</span>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {model.contextWindow >= 1_000_000
            ? "1M"
            : `${Math.round(model.contextWindow / 1000)}K`}
        </span>
        {selected && <Check className="size-3.5 shrink-0" />}
      </button>
    </li>
  );
}
