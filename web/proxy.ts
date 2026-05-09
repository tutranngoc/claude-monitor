import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// LAN-exposure auth gate. The Go orchestrator passes MONITOR_AUTH_TOKEN
// when --web-host is non-loopback (or via --lan); empty/unset means
// "loopback only, no gate needed". When set, we require either:
//
//   - a `cm_token` cookie matching the env value, OR
//   - a `?token=<value>` query param on first touch — which we exchange
//     for the cookie + a redirect that strips the token from the URL so
//     it doesn't end up in browser history / referrer logs.
//
// **Public exposure** (Cloudflare Tunnel): same cookie gate, plus an
// optional MONITOR_ALLOW_IPS env that gates by client IP. Cloudflared
// forwards the original client IP via the `CF-Connecting-IP` header,
// which we trust because the request reached us through the tunnel
// (cloudflared → loopback → Next.js); a LAN attacker can't spoof it
// because the loopback bind doesn't accept their packets in the first
// place.
//
// Daemon proxy traffic (/daemon/*) and chat APIs (/api/*) gate behind
// the same cookie. Static Next assets (_next/*) bypass the check so the
// 401 page itself can load CSS/JS.
//
// File renamed from middleware.ts → proxy.ts in Next.js 16. See
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
// before tweaking — the convention drifted from older Next versions.

const COOKIE_NAME = "cm_token";
// Path-based bypass list for assets that need to render the 401 page
// itself. Keep tight: anything API-shaped must stay gated.
const PUBLIC_PATH_PREFIXES = ["/_next/", "/favicon", "/icon", "/auth/login"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

// Constant-time-ish compare via Buffer.equals. Lengths must match
// up-front; mismatched lengths short-circuit before the byte compare,
// which is fine — token length is fixed once generated, so a length
// mismatch already implies an attacker isn't even close.
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // crypto.timingSafeEqual would be slightly stricter but requires the
  // node:crypto import — Buffer.equals is good enough at this threat
  // level (LAN, single bearer token, no replay defense needed).
  return aBuf.equals(bBuf);
}

export function proxy(request: NextRequest): NextResponse {
  const expected = process.env.MONITOR_AUTH_TOKEN ?? "";
  if (expected === "") {
    // Loopback bind / dev mode: no gate. Pass through.
    return NextResponse.next();
  }

  const { pathname, searchParams } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Loopback bypass. When the launcher bound Next.js to 127.0.0.1 only
  // (i.e. --public without --lan), the only paths into this process
  // are (a) the host's own browser hitting http://localhost:3737 and
  // (b) cloudflared forwarding tunnel traffic from the loopback. The
  // tunnel path always carries `cf-connecting-ip` set by Cloudflare's
  // edge (which the user can't forge — the edge overwrites it). Direct
  // host access carries `Host: localhost` (or 127.0.0.1) and no CF
  // header. That combo can't be reached by a LAN attacker because the
  // bind doesn't accept their packets in the first place. So skip the
  // gate for it — the host is already trusted (anyone with shell can
  // read MONITOR_AUTH_TOKEN anyway), and forcing them to paste a
  // ?token=… URL on every browser session is needless friction.
  //
  // We gate this on HOSTNAME being loopback because in --lan mode the
  // bind is 0.0.0.0 and a LAN attacker could spoof the Host header.
  const bind = process.env.HOSTNAME ?? "";
  if (bind === "127.0.0.1" || bind === "::1" || bind === "localhost") {
    if (!request.headers.get("cf-connecting-ip")) {
      const host = (request.headers.get("host") ?? "").toLowerCase();
      if (
        host.startsWith("localhost") ||
        host.startsWith("127.0.0.1") ||
        host.startsWith("[::1]")
      ) {
        return NextResponse.next();
      }
    }
  }

  // IP allowlist (Public-mode defense-in-depth). Checked before token
  // so a wrong-IP attacker can't blow through the rate-limit-free
  // cookie compare. CF-Connecting-IP is the original client IP per
  // Cloudflare; on direct LAN access the header is absent and we fall
  // back to x-forwarded-for / x-real-ip (Next dev / standalone set
  // these). Failing all of those, we accept — the token is still
  // required, so this just means "no allowlist enforcement when we
  // can't determine origin IP" rather than "deny by default".
  const allowList = process.env.MONITOR_ALLOW_IPS ?? "";
  if (allowList !== "") {
    const clientIP = pickClientIP(request);
    if (clientIP && !ipAllowed(clientIP, allowList)) {
      return NextResponse.json(
        { error: "ip not allowed", hint: "client IP isn't in the configured allowlist" },
        { status: 403 },
      );
    }
  }

  // First-touch link: ?token=… exchanges for a cookie + clean redirect.
  // We accept it on any path so deep-links from the QR (which always
  // points at "/") still work even if the user bookmarks a sub-route.
  const queryToken = searchParams.get("token");
  if (queryToken && tokensMatch(queryToken, expected)) {
    const cleanUrl = new URL(request.nextUrl);
    cleanUrl.searchParams.delete("token");
    const res = NextResponse.redirect(cleanUrl);
    // HttpOnly + SameSite=Lax: the token never reaches client JS, and
    // is sent on top-level navigations only (no cross-site SSE leaks).
    // Secure is intentionally OFF — LAN traffic is plain HTTP, and a
    // Secure cookie wouldn't ride those requests.
    res.cookies.set({
      name: COOKIE_NAME,
      value: expected,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // 30 days. Re-scan QR or re-paste URL to refresh.
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? "";
  if (cookie && tokensMatch(cookie, expected)) {
    return NextResponse.next();
  }

  // Mismatch / missing. JSON for API-shaped paths so the SPA's fetch()
  // sees a clean 401; HTML for top-level navigations so the user gets
  // a "paste your token" hint instead of a download prompt.
  const wantsJSON =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/daemon/") ||
    request.headers.get("accept")?.includes("application/json");

  if (wantsJSON) {
    return NextResponse.json(
      { error: "unauthorized", hint: "open the LAN URL printed by `claude-monitor --lan`" },
      { status: 401 },
    );
  }

  return new NextResponse(unauthorizedHTML(), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// pickClientIP extracts the originating client IP from request
// headers. Priority order is documented in the proxy.ts header
// comment; in practice Cloudflare's CF-Connecting-IP wins for public
// traffic and x-forwarded-for / x-real-ip cover the LAN-direct case.
function pickClientIP(req: NextRequest): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // x-forwarded-for can be a comma chain (proxies append). The
    // left-most entry is the original client. Strip whitespace.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return null;
}

// ipAllowed parses MONITOR_ALLOW_IPS and decides whether `ip` matches
// any entry. Supports plain IPv4/IPv6 addresses and CIDRs. Whitespace
// in the env is tolerated; empty entries are skipped. Errors silently
// (treats malformed entries as no-match) — daemon-side normalization
// already trims, so a malformed entry implies the user typed garbage,
// which we'd rather treat as "doesn't match" than "blocks the world".
function ipAllowed(ip: string, allowList: string): boolean {
  for (const raw of allowList.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes("/")) {
      if (ipInCIDR(ip, entry)) return true;
    } else if (entry === ip) {
      return true;
    }
  }
  return false;
}

// ipInCIDR is a small pure-JS subset of net.ParseCIDR for IPv4 only.
// IPv6 CIDR support would need a 128-bit BigInt mask; deferred until
// someone actually asks. IPv6 plain-IP equality still works above.
function ipInCIDR(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  if (!base || !prefixStr) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNum = ipv4ToNum(ip);
  const baseNum = ipv4ToNum(base);
  if (ipNum == null || baseNum == null) return false;
  // mask = 0xFFFFFFFF << (32-prefix). prefix=0 needs special-casing
  // because shifting by 32 in JS wraps to 0. >>> 0 forces unsigned.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function ipv4ToNum(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n;
}

// Tiny inline page so we don't have to add a /auth/login route just to
// explain "you need a token". Keeps proxy.ts self-contained and works
// even when the rest of the app fails to render.
//
// Includes a "Disable LAN" escape hatch that POSTs to the daemon's
// loopback endpoint directly (bypassing the Next.js proxy / cookie
// gate). Critical: the daemon binds 127.0.0.1 only, so this fetch
// succeeds *only* when the user is on the host machine. Phones / LAN
// devices get a network error and a clear hint to use `--lan-off`
// from a terminal instead.
function unauthorizedHTML(): string {
  // Daemon URL the host browser can reach. proxy.ts already has it
  // via DAEMON_INTERNAL_URL; we forward it as-is. JSON.stringify
  // double-quotes it so it's a safe string literal in JS.
  const daemonURL = process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:8788";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-monitor — unauthorized</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #fafafa; color: #222; padding: 2rem; max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
  code { background: #eee; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.85em; }
  p { color: #555; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 1.5rem 0; }
  .escape { font-size: 0.9em; }
  button {
    appearance: none; cursor: pointer;
    background: #fff; color: #222; border: 1px solid #ccc;
    padding: 0.45rem 0.9rem; border-radius: 6px;
    font: inherit; font-size: 0.9em;
  }
  button:hover { background: #f5f5f5; }
  button:disabled { opacity: 0.5; cursor: wait; }
  .ok { color: #16a34a; }
  .err { color: #dc2626; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #ddd; }
    code { background: #222; color: #eee; }
    p { color: #aaa; }
    hr { border-top-color: #333; }
    button { background: #1c1c1c; color: #ddd; border-color: #444; }
    button:hover { background: #262626; }
  }
</style>
<h1>claude-monitor — unauthorized</h1>
<p>This instance is exposed on the LAN and requires a bearer token.</p>
<p>Open the URL printed by <code>claude-monitor --lan</code> (it includes <code>?token=…</code>),
or scan the QR code in the launching terminal.</p>

<hr>
<div class="escape">
  <p><strong>Locked out?</strong> Disable LAN exposure to fall back to loopback access.</p>
  <p><button id="disable-btn" type="button">Disable LAN (host only)</button>
     <span id="disable-status"></span></p>
  <p>This button only works when you're on the machine running claude-monitor — the
     daemon stays on <code>127.0.0.1</code> and is unreachable from other devices on the LAN.
     If you're on a phone, run <code>claude-monitor --lan-off</code> from a terminal on the host.</p>
</div>
<script>
(function () {
  var btn = document.getElementById("disable-btn");
  var status = document.getElementById("disable-status");
  btn.addEventListener("click", async function () {
    btn.disabled = true;
    status.textContent = " disabling…";
    status.className = "";
    try {
      var res = await fetch(${JSON.stringify(daemonURL + "/api/lan/disable")}, {
        method: "POST",
        // No credentials/cookie — daemon binds loopback and trusts
        // any local connection. Bumping mode to "cors" so the browser
        // sends the preflight OPTIONS that Go's mux already handles.
        mode: "cors",
      });
      if (!res.ok) throw new Error("daemon returned " + res.status);
      status.textContent = " ✓ disabled, reloading…";
      status.className = "ok";
      // 800ms grace so the daemon's Next.js recycle settles before
      // the reload races against a half-bound listener.
      setTimeout(function () { location.href = "/"; }, 800);
    } catch (e) {
      status.textContent = " — failed: " + (e && e.message ? e.message : e) +
        ". Run claude-monitor --lan-off on the host instead.";
      status.className = "err";
      btn.disabled = false;
    }
  });
})();
</script>
`;
}

export const config = {
  // Skip middleware on Next-internal asset paths so the 401 page can
  // render its own CSS/script. Everything else — including server
  // actions and the daemon proxy — runs through proxy().
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};
