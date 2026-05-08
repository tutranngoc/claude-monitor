"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { CodeBlock } from "./code-block";
import { MermaidBlock } from "./mermaid-block";

interface Props {
  source: string;
}

// Markdown is the renderer used by AssistantBubble for any text block.
// It supports GFM (tables, task lists, strikethrough), code blocks with
// syntax highlighting via highlight.js, and ```mermaid fences via the
// MermaidBlock component (lazy-loaded).
export function Markdown({ source }: Props) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Pulled out so the components object is not reallocated on every render.
const components: Components = {
  pre({ node, children }) {
    // react-markdown renders fenced code as <pre><code class="language-x">...</code></pre>.
    // We dig into the AST to read the language class + the raw source text,
    // then replace the whole pre with either CodeBlock or MermaidBlock.
    const codeNode = node?.children?.[0];
    if (
      !codeNode ||
      codeNode.type !== "element" ||
      codeNode.tagName !== "code"
    ) {
      return <pre>{children}</pre>;
    }
    const classes = (codeNode.properties?.className ?? []) as string[];
    const langClass = classes.find((c) => c.startsWith("language-"));
    const language = langClass ? langClass.slice("language-".length) : undefined;
    const source = extractText(codeNode);

    if (language === "mermaid") {
      return <MermaidBlock source={source.trim()} />;
    }

    // children is the highlighted JSX rehype-highlight produced (a <code>
    // element with span children). Hand it to CodeBlock unchanged so we
    // keep token colors.
    return (
      <CodeBlock language={language} source={source}>
        {children}
      </CodeBlock>
    );
  },
  code({ className, children, ...props }) {
    // react-markdown calls this for both inline `code` and the inner
    // <code> of a fenced ```block```. After rehype-highlight runs on the
    // fenced one, className becomes "hljs language-x" - earlier we only
    // checked for `language-` prefix, missed the rehype-prefixed string,
    // and applied inline `bg-muted` to the <code>. Since <code> is inline,
    // its background paints under each text run separately - that's why
    // multi-line code blocks rendered with a light strip per line.
    //
    // Inline code never has a className from react-markdown, so the
    // presence of any className signals a fenced block: pass it through.
    if (className) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        {...props}
      >
        {children}
      </code>
    );
  },
  // Tables: the heavy styling lives in globals.css under `.prose-chat
  // table` so the rules can use CSS variables for theme-aware colors.
  // Here we only wire the wrapper (overflow + border + rounded corners
  // for narrow viewports) and pass children through to a real
  // <table>/<thead>/<tbody>/<tr>/<th>/<td> tree. Returning a wrapping div
  // also keeps wide tables from blowing the bubble out horizontally.
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead>{children}</thead>;
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  tr({ children }) {
    return <tr>{children}</tr>;
  },
  th({ children, style }) {
    // GFM emits text-align via inline `style` for `:---:` etc. We forward
    // it so column alignment hints from the source render correctly.
    return <th style={style}>{children}</th>;
  },
  td({ children, style }) {
    return <td style={style}>{children}</td>;
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {children}
      </a>
    );
  },
};

// extractText walks an HAST element tree and concatenates raw text. Used
// to recover the un-highlighted source for the clipboard / mermaid input.
type HastNode = {
  type: string;
  value?: string;
  children?: HastNode[];
};

function extractText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(extractText).join("");
}
