// Manager owns the Next.js subprocess and its bind options across
// runtime reconfigures. The daemon's HTTP handlers don't talk to
// `*exec.Cmd` directly — they call Manager.Reconfigure(), which:
//
//  1. Marks the new options as "desired",
//  2. Sends SIGINT to the current child (so Next.js can flush logs),
//  3. Lets the spawn loop notice the exit, respawn with the new opts.
//
// The web subprocess restart blip is unavoidable: Next.js binds its
// HTTP listener at startup (HOSTNAME env). Switching from 127.0.0.1 to
// 0.0.0.0 requires a fresh listener, and there's no API to rebind in
// place. ~1-3s on warm-cache `next start` is the typical price.
//
// Defense-in-depth note:
//   The daemon stays bound to 127.0.0.1 across all transitions. Only the
//   Next.js child opens up to the LAN. Any LAN-reachable endpoint
//   therefore routes through web/proxy.ts and its token cookie check.

package web

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

// Status is the wire shape returned by the daemon's GET /api/lan/status.
// Token is included so the web UI can render the QR + copy-to-clipboard
// without a separate fetch — same-origin browser already authenticated.
//
// "Enabled" historically meant "LAN bind on (host = 0.0.0.0)". We now
// also surface AuthEnabled as a separate signal because Public exposure
// via Cloudflare Tunnel needs the auth gate ON even when the bind
// stays loopback.
type Status struct {
	Enabled     bool   `json:"enabled"`               // host = 0.0.0.0 (LAN exposure)
	AuthEnabled bool   `json:"auth_enabled,omitempty"` // proxy.ts gate is on
	Host        string `json:"host"`
	LANIP       string `json:"lan_ip,omitempty"`
	Port        int    `json:"port"`
	Token       string `json:"token,omitempty"`
	URL         string `json:"url,omitempty"`         // loopback URL, always set
	LANURL      string `json:"lan_url,omitempty"`     // LAN URL with ?token=, when LAN enabled
	AllowIPs    string `json:"allow_ips,omitempty"`   // current MONITOR_ALLOW_IPS forwarded to proxy.ts
	Pending     bool   `json:"pending,omitempty"`     // a reconfigure is in flight
}

// ManagerOptions covers the orchestrator-side knobs that don't belong
// in web.Options (which is shared with one-shot Launch callers like the
// initial smoke-test path). Splitting keeps the core launcher Options
// minimal — no banner writer, no first-launch browser flag — and lets
// the lifecycle manager grow its own surface.
type ManagerOptions struct {
	BannerOut   io.Writer // where the LAN banner / QR get printed; nil → os.Stderr
	OpenBrowser bool      // open the loopback URL in the user's browser on first spawn
}

// Manager runs the spawn/respawn loop in a single goroutine. All
// callers (daemon handlers, signal handler) communicate with it via
// channels; no shared mutable state is read outside the manager loop
// except `state` which uses sync.RWMutex for read-only snapshots.
type Manager struct {
	// launchOpts holds the immutable inputs forwarded to every Launch
	// call. Hostname/AuthToken come from the Manager's mutable state
	// (see applyDesired) and are merged in at spawn time, so the
	// fields here are always defaulted/zero.
	launchOpts Options
	mgrOpts    ManagerOptions

	// stateMu guards the public-facing snapshot (Status()). Updated
	// only from the manager loop; readers (daemon handlers) take RLock.
	stateMu sync.RWMutex
	state   Status

	// reconfigCh carries new desired options. The loop drains it,
	// updates state, signals the running child to exit, then respawns.
	// Buffered=1 because back-to-back enable/disable from a flaky
	// network shouldn't queue indefinitely; the latest wins.
	reconfigCh chan reconfigRequest

	// pendingDone collects done-channels from in-flight Reconfigure
	// callers. The spawn loop closes them after the next successful
	// child start so the HTTP handler returns Status with fresh URLs.
	pendingMu   sync.Mutex
	pendingDone []chan struct{}
}

type reconfigRequest struct {
	host     string
	token    string
	allowIPs string
	// done is closed by the loop once the new child has reached a
	// "looks alive" state (process started + brief settle delay). The
	// HTTP handler waits on this so it can return current Status to
	// the UI without an obvious "still old" race window.
	done chan struct{}
}

// Reconfig is the desired-state knobs for a Manager.Reconfigure call.
// Decoupled from each other so an auth-on-but-loopback-bind state
// (Public-via-Cloudflare without LAN) is expressible.
type Reconfig struct {
	// LANBind: true → Next.js binds 0.0.0.0; false → 127.0.0.1.
	LANBind bool
	// RequireAuth: true → MONITOR_AUTH_TOKEN set in Next.js env so
	// proxy.ts gates every request. Auto-enabled by LANBind=true.
	RequireAuth bool
	// Token: secret to use when RequireAuth. Empty + RequireAuth →
	// generate a fresh one. Pass a persisted token (cfg.LANToken) to
	// keep prior QR codes valid across restarts.
	Token string
	// AllowIPs: comma-separated IPs / CIDRs forwarded to proxy.ts as
	// MONITOR_ALLOW_IPS. Empty = no IP gate (token alone). Useful as
	// defense-in-depth for public exposure.
	AllowIPs string
}

// NewManager constructs a Manager. Call SetInitial() to seed the LAN
// preference, then Run() in a goroutine. Status() is safe to call from
// any goroutine after construction.
//
// launchOpts.Hostname / launchOpts.AuthToken are ignored — those come
// from the manager's mutable state on each spawn. Pass Port, WebDir,
// and DaemonURL in launchOpts; everything else lives in mgrOpts.
func NewManager(launchOpts Options, mgrOpts ManagerOptions) *Manager {
	if mgrOpts.BannerOut == nil {
		mgrOpts.BannerOut = os.Stderr
	}
	return &Manager{
		launchOpts: launchOpts,
		mgrOpts:    mgrOpts,
		reconfigCh: make(chan reconfigRequest, 1),
	}
}

// Status returns a snapshot of the manager's view of the world. Cheap
// to call repeatedly; safe under reconfigure.
func (m *Manager) Status() Status {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.state
}

// Reconfigure queues a recycle of the Next.js child with the new
// desired state (LANBind / RequireAuth / Token / AllowIPs). Returns
// immediately with the planned Status (URL + LANURL already computed,
// Pending=true until the child is up).
//
// **Non-blocking by design.** The HTTP request that triggers a toggle
// rides through Next.js → daemon → Manager. If we waited for the new
// child to come up before returning, the kill of the *current* Next.js
// would tear down the in-flight response. The caller's UI must instead
// observe Pending → false via subsequent /status polls (or just
// time-based; ~150-300ms typical).
//
// Idempotent: a Reconfigure with no effective change still recycles
// the child, which is useful as a "reload env" hammer when AllowIPs
// changes mid-session.
func (m *Manager) Reconfigure(ctx context.Context, r Reconfig) (Status, error) {
	host := "127.0.0.1"
	if r.LANBind {
		host = "0.0.0.0"
		// LAN bind without a gate would expose the daemon to the LAN
		// without any auth — defensible for power users but a footgun.
		// Force-enable RequireAuth here so the state never drifts into
		// "open on LAN, no token".
		r.RequireAuth = true
	}
	token := ""
	if r.RequireAuth {
		token = r.Token
		if token == "" {
			t, err := GenerateToken()
			if err != nil {
				return Status{}, fmt.Errorf("generate token: %w", err)
			}
			token = t
		}
	}

	// Update the published state synchronously so the response we
	// return — and any /status race-poll just after — already shows
	// the new token + LAN URL with Pending=true.
	m.applyDesired(host, token, r.AllowIPs)

	req := reconfigRequest{host: host, token: token, allowIPs: r.AllowIPs, done: make(chan struct{})}
	select {
	case m.reconfigCh <- req:
	case <-ctx.Done():
		return m.Status(), ctx.Err()
	default:
		// Channel full = a reconfigure is in flight. Drain & replace
		// (latest-wins) so the user's most recent click takes effect.
		select {
		case <-m.reconfigCh:
		default:
		}
		m.reconfigCh <- req
	}

	return m.Status(), nil
}

// Run is the spawn loop. Exits when ctx is cancelled. The first spawn
// uses the host/token already populated via SetInitial — call it
// before Run to honor the persisted LAN preference at boot.
func (m *Manager) Run(ctx context.Context) error {
	// Handle the first launch the same way we handle reconfigures, so
	// there's only one spawn path.
	for {
		s := m.Status()
		host := s.Host
		if host == "" {
			host = "127.0.0.1"
		}

		childCtx, childCancel := context.WithCancel(ctx)
		opts := m.launchOpts
		opts.Hostname = host
		opts.AuthToken = s.Token
		opts.AllowIPs = s.AllowIPs
		cmd, displayURL, err := Launch(childCtx, opts)
		if err != nil {
			childCancel()
			return fmt.Errorf("launch web: %w", err)
		}

		// Wait for the child to actually accept TCP connections before
		// claiming the reconfigure is done. cmd.Start() returns the
		// moment the process forks; Next.js needs another ~100ms to
		// bind. If the UI polls /status while we're still pre-listen,
		// it'll see Pending=false but the very next page load will get
		// connection refused. Probing the loopback addr avoids both
		// races without coupling to specific HTTP responses (proxy.ts
		// might 401 a freshly-loaded gate, which is "alive enough" but
		// doesn't look like a 200 to a naive health probe).
		probeHost := host
		if probeHost == "0.0.0.0" || probeHost == "::" || probeHost == "" {
			probeHost = "127.0.0.1"
		}
		_ = waitForListen(ctx, probeHost, m.launchOpts.Port, 5*time.Second)

		m.publishURLs(displayURL)
		// Banner emitted on every spawn so toggling LAN gives the user
		// a fresh QR in the terminal too — matches what the web UI
		// shows and gives the user a copy/paste fallback.
		printLANBanner(m.mgrOpts.BannerOut, m.Status())
		// Browser open is one-shot — only on the very first spawn so
		// later reconfigures don't pop a new tab on every toggle.
		if m.mgrOpts.OpenBrowser {
			m.mgrOpts.OpenBrowser = false
			go func(url string) {
				select {
				case <-time.After(1500 * time.Millisecond):
					_ = OpenBrowser(url)
				case <-ctx.Done():
				}
			}(displayURL)
		}

		// Mark any in-flight reconfigure as "done" — the new child has
		// bound its listener and is ready for traffic.
		m.notifyReconfigDone()

		exit := waitForExit(cmd)

		select {
		case <-ctx.Done():
			gracefulStop(cmd, exit, 5*time.Second)
			childCancel()
			return nil

		case req := <-m.reconfigCh:
			// New desired state. Update internal state, kill child, loop.
			m.applyDesired(req.host, req.token, req.allowIPs)
			// Brief grace period: the toggle request that landed us
			// here was routed through Next.js → daemon → Manager. The
			// daemon already returned 200, but Next.js's response to
			// the client may still be in-flight. Killing the child now
			// would TCP-RST the response and the UI would see a fetch
			// error. 250ms is empirically enough for a same-host
			// loopback flush; cheap insurance against a confusing UX.
			select {
			case <-time.After(250 * time.Millisecond):
			case <-ctx.Done():
				gracefulStop(cmd, exit, 3*time.Second)
				childCancel()
				return nil
			}
			gracefulStop(cmd, exit, 3*time.Second)
			childCancel()
			// Defer notifying req.done until the next spawn finishes,
			// so the caller sees the new Status with updated URLs.
			m.queueReconfigDone(req.done)

		case err := <-exit:
			// Child died on its own (crash, port collision, etc.).
			childCancel()
			return fmt.Errorf("web exited unexpectedly: %w", err)
		}
	}
}

// InitialState bundles boot-time state for SetInitial. Pass values
// recovered from config.Config + flag overrides; the orchestrator is
// the source of truth, the Manager just records what it's told.
type InitialState struct {
	LANBind  bool
	AuthOn   bool   // implied true when LANBind; Public-only sets this without LAN
	Token    string // empty + AuthOn → auto-generate
	AllowIPs string
	LANIP    string // empty → auto-discover via LocalIP()
}

// SetInitial seeds the Status before Run() so the first spawn picks
// up the persisted LAN/Public preference. Call once during boot.
//
// Mirrors Reconfigure's "LAN forces Auth on" rule so a config.json
// with LANEnabled=true + LANToken="" still boots into a usable state
// (we'll generate a fresh token on the fly).
func (m *Manager) SetInitial(s InitialState) {
	host := "127.0.0.1"
	if s.LANBind {
		host = "0.0.0.0"
		s.AuthOn = true
	}
	token := ""
	if s.AuthOn {
		token = s.Token
		if token == "" {
			// Best-effort: a failure here just leaves the token empty;
			// the user can re-toggle from the UI to retry. Failing to
			// gen random bytes at boot is exotic enough not to bail.
			if t, err := GenerateToken(); err == nil {
				token = t
			}
		}
	}
	lanIP := s.LANIP
	if s.LANBind && lanIP == "" {
		lanIP = LocalIP()
	} else if !s.LANBind {
		lanIP = ""
	}
	m.stateMu.Lock()
	m.state.Enabled = s.LANBind
	m.state.AuthEnabled = token != ""
	m.state.Host = host
	m.state.Token = token
	m.state.LANIP = lanIP
	m.state.AllowIPs = s.AllowIPs
	m.state.Port = m.launchOpts.Port
	m.stateMu.Unlock()
}

// applyDesired updates the published state with the new desired bind.
// Called twice per reconfigure: once synchronously from Reconfigure
// (so the immediate /status reply already shows the new URL +
// Pending=true), and again from the manager loop after the new child
// binds (where it then calls publishURLs to also stamp the loopback
// URL and clear Pending).
func (m *Manager) applyDesired(host, token, allowIPs string) {
	enabled := host != "127.0.0.1"
	lanIP := ""
	lanURL := ""
	if enabled {
		lanIP = LocalIP()
		if lanIP != "" {
			lanURL = fmt.Sprintf("http://%s:%d/", lanIP, m.launchOpts.Port)
			if token != "" {
				lanURL += "?token=" + token
			}
		}
	}
	m.stateMu.Lock()
	m.state.Host = host
	m.state.Token = token
	m.state.Enabled = enabled
	m.state.AuthEnabled = token != ""
	m.state.LANIP = lanIP
	m.state.LANURL = lanURL
	m.state.AllowIPs = allowIPs
	m.state.Pending = true
	m.stateMu.Unlock()
}

// publishURLs computes URL/LANURL after a successful spawn so the UI's
// next /status poll shows a fully-formed link without a separate
// recompute.
func (m *Manager) publishURLs(loopbackURL string) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	m.state.URL = loopbackURL
	m.state.Port = m.launchOpts.Port
	m.state.Pending = false
	if m.state.Enabled && m.state.LANIP != "" {
		u := fmt.Sprintf("http://%s:%d/", m.state.LANIP, m.launchOpts.Port)
		if m.state.Token != "" {
			u += "?token=" + m.state.Token
		}
		m.state.LANURL = u
	} else {
		m.state.LANURL = ""
	}
}

// queueReconfigDone parks a Reconfigure caller's done channel until
// the next successful spawn — at which point notifyReconfigDone closes
// every parked channel so callers wake with fresh URLs.
func (m *Manager) queueReconfigDone(done chan struct{}) {
	m.pendingMu.Lock()
	m.pendingDone = append(m.pendingDone, done)
	m.pendingMu.Unlock()
}

func (m *Manager) notifyReconfigDone() {
	m.pendingMu.Lock()
	for _, ch := range m.pendingDone {
		close(ch)
	}
	m.pendingDone = nil
	m.pendingMu.Unlock()
}

// waitForExit returns a channel that fires once with cmd's exit status.
func waitForExit(cmd *exec.Cmd) chan error {
	ch := make(chan error, 1)
	go func() { ch <- cmd.Wait() }()
	return ch
}

// waitForListen polls (host, port) until a TCP connection succeeds or
// the timeout elapses. Returns nil on success, ctx.Err() / a timeout
// error otherwise. 50ms tick is fine — Next.js binds its socket as one
// of the first things it does, so the first 1-2 ticks usually win.
//
// We don't surface the error: a missed probe just means the UI sees
// Pending=false slightly early, which is the same behavior as before
// this probe existed — net-net it's still an improvement.
func waitForListen(ctx context.Context, host string, port int, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		select {
		case <-deadline.Done():
			return deadline.Err()
		case <-tick.C:
		}
	}
}

// gracefulStop signals SIGINT, then escalates to Kill after timeout.
// Shared between the ctx-cancel and reconfigure paths.
func gracefulStop(cmd *exec.Cmd, exit <-chan error, timeout time.Duration) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	select {
	case <-exit:
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-exit
	}
}

// printLANBanner writes the LAN URL + scannable QR to w when enabled.
// Loopback-only state is silent so the loopback path stays uncluttered.
//
// Lives here (not main.go) because the manager is the source of truth
// for the URL after each spawn, and we want banner reprints on
// reconfigure to use the latest values.
func printLANBanner(w io.Writer, s Status) {
	if !s.Enabled {
		return
	}
	if s.LANIP == "" {
		fmt.Fprintln(w, "lan    → (no non-loopback IPv4 found; check your network)")
		return
	}
	fmt.Fprintf(w, "lan    → %s\n", s.LANURL)
	if s.Token != "" {
		fmt.Fprintf(w, "         token: %s\n", s.Token)
	}
	fmt.Fprintln(w, "         scan from your phone:")
	PrintQR(w, s.LANURL)
}

