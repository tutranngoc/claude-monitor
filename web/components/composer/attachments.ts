"use client";

import type { Attachment } from "@/lib/chat-types";

// Soft cap on text-file content — we inline the file as part of the user
// turn, and the model's context already pays for the history. Anything
// above this is likely a binary disguised as text.
const TEXT_FILE_BYTES_LIMIT = 200_000;
// Image files larger than this would balloon the request body when
// base64-encoded; reject early so the user retries with a smaller asset.
const IMAGE_BYTES_LIMIT = 5_000_000;

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "go", "py", "rs", "rb", "php", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "cs", "scala", "lua", "sh", "bash", "zsh", "fish",
  "md", "mdx", "txt", "rst", "tex",
  "json", "yaml", "yml", "toml", "ini", "env", "conf", "cfg",
  "sql", "graphql", "proto",
  "html", "css", "scss", "sass", "vue", "svelte", "astro",
  "xml", "csv", "tsv",
]);

const TEXT_LANGUAGE: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
  go: "go", py: "python", rs: "rust", rb: "ruby", php: "php",
  java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cs: "csharp", scala: "scala", lua: "lua",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  md: "markdown", mdx: "markdown",
  json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", env: "ini",
  sql: "sql", graphql: "graphql", proto: "proto",
  html: "html", css: "css", scss: "scss", sass: "scss",
  vue: "vue", svelte: "svelte", astro: "astro",
  xml: "xml",
};

export type AttachResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: string; filename: string };

export async function fileToAttachment(file: File): Promise<AttachResult> {
  if (file.type.startsWith("image/")) {
    if (file.size > IMAGE_BYTES_LIMIT) {
      return {
        ok: false,
        reason: `image too large (${formatBytes(file.size)} > ${formatBytes(IMAGE_BYTES_LIMIT)})`,
        filename: file.name,
      };
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      ok: true,
      attachment: { type: "image", data_url: dataUrl, filename: file.name },
    };
  }

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const looksTexty =
    file.type.startsWith("text/") ||
    TEXT_EXTENSIONS.has(ext) ||
    file.type === "application/json" ||
    file.type === "application/xml";

  if (!looksTexty) {
    return {
      ok: false,
      reason: "unsupported file type — only images and text files",
      filename: file.name,
    };
  }
  if (file.size > TEXT_FILE_BYTES_LIMIT) {
    return {
      ok: false,
      reason: `text file too large (${formatBytes(file.size)} > ${formatBytes(TEXT_FILE_BYTES_LIMIT)})`,
      filename: file.name,
    };
  }
  const content = await file.text();
  return {
    ok: true,
    attachment: {
      type: "text_file",
      filename: file.name,
      content,
      language: TEXT_LANGUAGE[ext],
    },
  };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
