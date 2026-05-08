// Static model registry. The Agent SDK accepts an arbitrary `model`
// string (it just forwards to the binary), so we list the ones the user's
// claude-monitor accounts can call. `[1m]` is the SDK's hint for the 1M
// context window variant — same model, different context cap.
//
// supportedEffortLevels comes from the SDK's docs:
//   xhigh — Opus 4.7 only
//   max   — Opus 4.6 / 4.7 only
import type { Effort } from "./chat-types";

export interface ModelInfo {
  id: string;
  label: string;
  badge?: string;
  contextWindow: number;
  supportedEffortLevels: Effort[];
}

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7",
    badge: "1M",
    contextWindow: 1_000_000,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6",
    badge: "1M",
    contextWindow: 1_000_000,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    badge: "Legacy",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

export const DEFAULT_MODEL_ID = "claude-opus-4-7[1m]";
export const DEFAULT_EFFORT: Effort = "high";

export function modelById(id?: string): ModelInfo | undefined {
  if (!id) return undefined;
  return MODELS.find((m) => m.id === id);
}

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
