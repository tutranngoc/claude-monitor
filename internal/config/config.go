package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

// Config is persisted to ~/.claude-monitor/config.json so that toggles set
// in the TUI (auto-kick, auto-swap, swap thresholds, …) survive restarts.
//
// Refresh interval is hardcoded to 60s and color rendering is always on
// — both used to be user-configurable but the toggles weren't earning
// their keep, so the surface area shrank to the things the user
// actually wants to tweak (the auto-swap behavior).
type Config struct {
	AutoKick bool `json:"autoKick"`

	// Auto-swap rotates the OAuth token in the default keychain slot
	// ("Claude Code-credentials") among the discovered accounts so a
	// running plain `claude` tab transparently picks up a fresh quota
	// when the active account is near its 5h limit.
	AutoSwap bool `json:"autoSwap"`

	// SwapThresholds is an ascending cascade of 5h utilization tiers.
	// Default [90, 99, 100]: try to swap when the active account hits
	// 90% to a candidate below 90; if no candidate exists, wait until
	// 99% and retry against candidates < 99; finally 100% / < 100.
	SwapThresholds []float64 `json:"swapThresholds"`

	// PickOrder controls how a swap target is chosen among eligible
	// candidates. "lowest" prefers the freshest account (default,
	// spreads load); "highest" drains accounts one at a time.
	PickOrder string `json:"pickOrder"`

	// RebalanceOnReset, when true, swaps to any non-active account
	// whose 5h window just reset (util went from positive to ~0
	// between refreshes). Independent of the threshold cascade —
	// fires even when active is well below 90%.
	RebalanceOnReset bool `json:"rebalanceOnReset"`

	// KeychainSetupDone is set after the macOS one-shot bootstrap
	// (keychain.RunSetup) has registered the `security` CLI in each
	// Claude Code keychain entry's partition list. Until it's true
	// we prompt the user once on launch to enter their macOS
	// password so future swaps stay silent. Always true on
	// non-darwin platforms (no partition list there).
	KeychainSetupDone bool `json:"keychainSetupDone"`

	// LANEnabled, when true, makes the orchestrator boot the Next.js
	// subprocess bound to 0.0.0.0 + a token gate so a phone on the
	// same Wi-Fi can scan the printed QR and connect. Toggled from
	// the web UI (POST /api/lan/{enable,disable}) — recycles the
	// Next.js child to take effect, ~2s blip.
	LANEnabled bool `json:"lanEnabled,omitempty"`

	// LANToken is the bearer token enforced by web/proxy.ts. Persisted
	// across restarts so re-enabling LAN reuses the same token (so
	// existing QR codes / bookmarked URLs keep working). Cleared by
	// daemon endpoint POST /api/lan/disable when the user wants a
	// fresh secret.
	LANToken string `json:"lanToken,omitempty"`

	// PublicEnabled, when true, makes the orchestrator spawn a
	// `cloudflared tunnel --url ...` subprocess pointing at the
	// loopback Next.js so a public HTTPS URL exposes the UI without
	// port-forwarding. Auth still rides on LANToken (no separate
	// public token); IP allowlist via AllowIPs is the second factor.
	PublicEnabled bool `json:"publicEnabled,omitempty"`

	// AllowIPs is a comma-separated list of IPs / CIDR ranges that
	// proxy.ts permits when set (empty = token-only, no IP gate).
	// Checked against the client's `CF-Connecting-IP` header for
	// public-tunnel traffic, falling back to direct remote IP for
	// LAN traffic. Useful as a second factor for public exposure:
	// even if your QR/token leaks, the attacker also needs to be on
	// an allowlisted IP.
	AllowIPs string `json:"allowIPs,omitempty"`

	// CfTunnelName + CfHostname switch the public tunnel from
	// quick-tunnel mode (`*.trycloudflare.com`) to a pre-created
	// named tunnel. Required because Cloudflare deliberately buffers
	// SSE GET responses on quick tunnels (cloudflared#1449), which
	// breaks our /api/events stream and leaves the UI showing zero
	// accounts. Both empty = quick tunnel; both set = named tunnel.
	// The user must run `cloudflared tunnel login` + `tunnel create
	// <name>` + `tunnel route dns <name> <host>` once before turning
	// public on with these set.
	CfTunnelName string `json:"cfTunnelName,omitempty"`
	CfHostname   string `json:"cfHostname,omitempty"`
}

const (
	PickOrderLowest  = "lowest"
	PickOrderHighest = "highest"
)

// RefreshIntervalSeconds is the fixed cadence at which the dashboard
// re-fetches /api/oauth/usage. Hardcoded because the API is undocumented
// and 60s was the safe lower bound we settled on against rate-limiting.
const RefreshIntervalSeconds = 60

func defaults() Config {
	return Config{
		AutoKick:         false,
		AutoSwap:         false,
		SwapThresholds:   []float64{90, 99, 100},
		PickOrder:        PickOrderLowest,
		RebalanceOnReset: true,
	}
}

func path() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude-monitor", "config.json"), nil
}

// Load returns the persisted Config, or defaults when the file is
// missing/unreadable/corrupt. The error is informational — callers
// typically ignore it because every field has a sensible default.
func Load() (Config, error) {
	cfg := defaults()
	p, err := path()
	if err != nil {
		return cfg, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return cfg, err
	}
	// Decode on top of defaults so that newly-added fields keep sensible
	// values when reading an old file.
	if err := json.Unmarshal(b, &cfg); err != nil {
		return defaults(), err
	}
	cfg.SwapThresholds = SanitizeThresholds(cfg.SwapThresholds)
	cfg.PickOrder = sanitizePickOrder(cfg.PickOrder)
	return cfg, nil
}

// SanitizeThresholds clamps each value to [0, 100], drops duplicates and
// sorts ascending. An empty list falls back to the default cascade so the
// swap logic always has at least one tier to evaluate.
//
// Exported because the TUI editor parses user input then re-uses this
// to normalize before persisting.
func SanitizeThresholds(in []float64) []float64 {
	if len(in) == 0 {
		return []float64{90, 99, 100}
	}
	seen := map[float64]struct{}{}
	out := make([]float64, 0, len(in))
	for _, v := range in {
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	sort.Float64s(out)
	return out
}

func sanitizePickOrder(s string) string {
	switch s {
	case PickOrderLowest, PickOrderHighest:
		return s
	default:
		return PickOrderLowest
	}
}

// Save persists cfg as pretty-printed JSON. Creates the parent directory
// if missing.
func Save(cfg Config) error {
	p, err := path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}
