"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  source: string;
}

// Lazy-import mermaid to keep its ~500KB bundle out of first paint. The
// renderer mounts once per code block and replaces the placeholder div
// with the SVG. We never re-render in place — if `source` changes (rare,
// streaming edits) we force a fresh mount via a key in the parent.
export function MermaidBlock({ source }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // startOnLoad: false — we own the lifecycle; calling render()
        // directly avoids mermaid scanning the whole DOM each mount.
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict",
          fontFamily: "var(--font-sans)",
        });
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setSvg(svg);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        <div className="mb-1 font-medium">Mermaid render failed</div>
        <pre className="whitespace-pre-wrap">{error}</pre>
        <pre className="mt-2 whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] text-foreground">
          {source}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="overflow-auto rounded-md border bg-card p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
