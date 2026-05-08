"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AskUserQuestionAnswers,
  AskUserQuestionEntry,
  AskUserQuestionOption,
  AskUserQuestionRequest,
} from "@/lib/chat-types";

interface Props {
  request: AskUserQuestionRequest;
  onSubmit: (answers: AskUserQuestionAnswers) => Promise<void>;
  onCancel: () => Promise<void>;
}

// Selection state per question. Single-select stores the picked option's
// raw label string (must match exactly so the SDK can echo it back as the
// tool result). Multi-select stores a Set of labels; we comma-join on
// submit to match the SDK's documented format.
type Selection = string | Set<string> | undefined;

export function AskQuestionCard({ request, onSubmit, onCancel }: Props) {
  const [picks, setPicks] = useState<Record<number, Selection>>({});
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);

  const total = request.questions.length;
  const answered = useMemo(() => countAnswered(picks, total), [picks, total]);

  const togglePick = (qIdx: number, q: AskUserQuestionEntry, label: string) => {
    setPicks((prev) => {
      const current = prev[qIdx];
      if (q.multiSelect) {
        const next = new Set(current instanceof Set ? current : []);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return { ...prev, [qIdx]: next };
      }
      // Click-to-toggle on single-select: clicking the picked option
      // again clears it (otherwise the user can never unpick a wrong
      // answer without picking another).
      return {
        ...prev,
        [qIdx]: current === label ? undefined : label,
      };
    });
  };

  const handleSubmit = async () => {
    setBusy("submit");
    try {
      const answers: AskUserQuestionAnswers = {};
      for (let i = 0; i < request.questions.length; i++) {
        const q = request.questions[i];
        const pick = picks[i];
        if (pick === undefined) continue;
        if (pick instanceof Set) {
          if (pick.size === 0) continue;
          // Multi-select wire format is comma-joined labels.
          answers[q.question] = Array.from(pick).join(", ");
        } else if (typeof pick === "string") {
          answers[q.question] = pick;
        }
      }
      await onSubmit(answers);
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    setBusy("cancel");
    try {
      await onCancel();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Agent đang hỏi anh</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {answered}/{total} answered
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Chọn từng câu rồi bấm Trả lời. Có thể bỏ qua câu không muốn trả lời.
      </p>

      <div className="space-y-4">
        {request.questions.map((q, i) => (
          <QuestionSection
            key={i}
            index={i}
            total={total}
            question={q}
            selection={picks[i]}
            onPick={(label) => togglePick(i, q, label)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={handleCancel}
        >
          {busy === "cancel" ? "Đang hủy…" : "Hủy"}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null || answered === 0}
          onClick={handleSubmit}
        >
          {busy === "submit" ? "Đang gửi…" : "Trả lời"}
        </Button>
      </div>
    </div>
  );
}

interface SectionProps {
  index: number;
  total: number;
  question: AskUserQuestionEntry;
  selection: Selection;
  onPick: (label: string) => void;
}

function QuestionSection({
  index,
  total,
  question,
  selection,
  onPick,
}: SectionProps) {
  return (
    <section className="rounded-md border bg-background p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        {question.header && (
          <Badge variant="secondary" className="font-mono text-[10px]">
            {question.header}
          </Badge>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">
          Câu {index + 1}/{total}
        </span>
        {question.multiSelect && (
          <Badge variant="outline" className="font-mono text-[10px]">
            chọn nhiều
          </Badge>
        )}
      </div>
      <p className="mb-2 text-sm font-medium leading-snug">
        {question.question}
      </p>
      <div className="space-y-1.5">
        {question.options.map((opt, j) => {
          const checked = isPicked(selection, opt.label);
          return (
            <OptionRow
              key={j}
              option={opt}
              multiSelect={!!question.multiSelect}
              checked={checked}
              onClick={() => onPick(opt.label)}
            />
          );
        })}
      </div>
    </section>
  );
}

interface OptionRowProps {
  option: AskUserQuestionOption;
  multiSelect: boolean;
  checked: boolean;
  onClick: () => void;
}

function OptionRow({ option, multiSelect, checked, onClick }: OptionRowProps) {
  const { displayLabel, recommended } = parseLabel(option.label);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border bg-background p-2.5 text-left transition",
        "hover:border-foreground/30 hover:bg-muted/40",
        checked && "border-primary bg-primary/5 ring-1 ring-primary",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
          multiSelect ? "rounded-sm" : "rounded-full",
          checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
      >
        {checked &&
          (multiSelect ? (
            <CheckIcon className="h-3 w-3 text-primary-foreground" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
          ))}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium leading-snug">
            {displayLabel}
          </span>
          {recommended && (
            <Badge className="text-[10px]" variant="default">
              Recommended
            </Badge>
          )}
        </span>
        {option.description && (
          <span className="block text-xs text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </button>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

// Recommended labels arrive as "Live link — instances mirror gốc (Recommended)".
// We strip the suffix for display and surface a Badge instead, but keep
// the original string when shipping the answer back to the SDK so it can
// match the option exactly.
function parseLabel(label: string): { displayLabel: string; recommended: boolean } {
  const m = /\s*\(Recommended\)\s*$/i.exec(label);
  if (!m) return { displayLabel: label, recommended: false };
  return {
    displayLabel: label.slice(0, m.index).trimEnd(),
    recommended: true,
  };
}

function isPicked(selection: Selection, label: string): boolean {
  if (selection === undefined) return false;
  if (selection instanceof Set) return selection.has(label);
  return selection === label;
}

function countAnswered(picks: Record<number, Selection>, total: number): number {
  let n = 0;
  for (let i = 0; i < total; i++) {
    const v = picks[i];
    if (v === undefined) continue;
    if (v instanceof Set) {
      if (v.size > 0) n++;
    } else if (typeof v === "string" && v.length > 0) {
      n++;
    }
  }
  return n;
}
