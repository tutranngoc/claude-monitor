"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

interface Props {
  language?: string;
  // Raw source string for the copy button. The pre/code content is
  // already syntax-highlighted into ReactNode by rehype-highlight; we
  // just need the original text to put on the clipboard.
  source: string;
  children: ReactNode;
}

export function CodeBlock({ language, source, children }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context, etc.) — silent failure
      // is fine; the source is selectable in the pre.
    }
  };

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-md border bg-[#0d1117] text-[13px]">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[11px] text-white/60">
        <span>{language ?? "text"}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="size-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono leading-relaxed">
        {children}
      </pre>
    </div>
  );
}
