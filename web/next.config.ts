import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this, Next 16 dev refuses /_next/* requests originating from
  // a hostname that doesn't match its `Local:` print, breaking HMR when
  // you open the app via 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost", "0.0.0.0"],
  // /daemon/* is proxied via the App Router route at app/daemon/[...path]/
  // — a custom handler instead of `rewrites` because rewrites buffer SSE
  // bodies, breaking EventSource for the daemon's /api/events stream.
  //
  // Standalone output produces `.next/standalone/server.js` with only
  // the runtime deps copied in (no full node_modules). Lets the release
  // bundle ship as one ~50MB tarball instead of dragging the full
  // ~940MB pnpm store. The Go launcher (`internal/web/launcher.go`)
  // detects server.js and spawns `node server.js`; falls back to
  // `next start` for the legacy dev layout.
  output: "standalone",
  // @openai/codex-sdk would normally locate the codex binary via
  // createRequire(import.meta.url).resolve(`@openai/codex-${platform}-${arch}/package.json`),
  // a dynamic resolve Next's tracer can't follow. We bypass it
  // entirely by passing an `executablePath` to `new Codex()` in
  // codex-driver.ts (resolved from $CODEX_PATH or `which codex`).
  // That keeps the bundle lean — no ~30MB platform binary per
  // release — at the cost of requiring users to install codex
  // themselves (`npm i -g @openai/codex` or equivalent).
  //
  // serverExternalPackages keeps the SDK as a real CommonJS require
  // so its own internal createRequire(import.meta.url) calls (used
  // for things like config-file resolution) work against the real
  // .next/standalone/node_modules layout.
  serverExternalPackages: [
    "@openai/codex-sdk",
  ],
  // Vendored Claude Code skills (web/skills/*) ship with the daemon so
  // the skills-installer can mirror them into ~/.claude/skills/ on
  // first boot. Without this include the tracer drops the dir from
  // the standalone bundle and the installer silently no-ops in
  // production. Keyed off /api/** because that's the entry point the
  // launcher hits on cold start, which is when init runs.
  outputFileTracingIncludes: {
    "/api/**": [
      "./skills/**",
    ],
  },
};

export default nextConfig;
