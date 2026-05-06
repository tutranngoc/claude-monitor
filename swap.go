package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// plainKeychainSvc is the OAuth slot that a `claude` invocation reads
// when no CLAUDE_CONFIG_DIR is set. Auto-swap rewrites this single slot
// to rotate accounts; tabs invoked with an explicit CLAUDE_CONFIG_DIR
// bypass it and are intentionally left alone.
const plainKeychainSvc = "Claude Code-credentials"

// SwapEvent records a single swap action so the TUI can flash a banner
// and the user can see what just happened. Populated only for the row
// the swap was executed on (target row).
type SwapEvent struct {
	FromName string
	ToName   string
	FromUtil float64
	ToUtil   float64
	Reason   string
}

func (e *SwapEvent) String() string {
	return fmt.Sprintf("swap %s (%.0f%%) → %s (%.0f%%) — %s",
		e.FromName, e.FromUtil, e.ToName, e.ToUtil, e.Reason)
}

// detectActiveDir figures out which discovered account currently owns
// the plain keychain slot. We compare refreshTokens because:
//
//   - access_tokens rotate on every refresh, so the plain slot's access
//     token will diverge from a hashed entry's even when both represent
//     the same account.
//   - refresh_tokens are stable across access-token refreshes, so they
//     act as a reliable account identity.
//
// When the plain slot doesn't match any discovered account's hashed
// entry, the assumption is that the user has never run a swap — the
// plain slot still holds the default ~/.claude creds, so we fall back
// to the discovered account whose configDir == defaultClaudeDir().
//
// Returns "" when no plausible match exists (e.g. no plain slot).
func detectActiveDir(rows []AccountUsage) string {
	plain, err := LoadCredentialsByService(plainKeychainSvc)
	if err != nil || plain == nil || plain.RefreshToken == "" {
		return defaultClaudeDir()
	}
	for _, r := range rows {
		if r.refreshToken != "" && r.refreshToken == plain.RefreshToken {
			return r.ConfigDir
		}
	}
	return defaultClaudeDir()
}

// decideSwap picks the swap target for the given snapshot, or returns
// nil when no swap should happen. Logic:
//
//  1. Threshold cascade. For each tier t in ascending order:
//     - if active.util < t and there is no eligible candidate at the
//       lower tiers, stop — let the active account keep burning.
//     - if active.util >= t and there is at least one candidate
//       below t, pick the best per cfg.PickOrder and return it.
//     - if active.util >= t but no candidate < t, escalate to the
//       next tier.
//
//  2. Reset rebalance. If RebalanceOnReset is on and any non-active
//     account just transitioned from positive util to ~0 since the last
//     refresh, swap to that fresh account regardless of the threshold.
//     This keeps load spread across accounts as their windows reset.
//     Suppressed while the active account matches manualPickDir — once
//     the user has manually pinned an account, only the threshold
//     cascade is allowed to move off it.
//
// prevUtil maps configDir → previous-tick util, used only for the reset
// detection. Pass nil on the first refresh.
//
// manualPickDir is the configDir of the user's most recent manual pick
// (empty when none). manualPickUtil is the 5h utilization of that
// account at the moment the user pinned it. While the active account
// matches manualPickDir, two relaxations apply:
//
//   - rebalance-on-reset is suppressed entirely.
//   - threshold cascade skips any tier <= manualPickUtil — i.e. the
//     pin "consumes" thresholds the picked account had already
//     crossed at pin time, so a deliberate pick at 52% with thresholds
//     [50, 80, 100] sticks until 80 (not 50, which would fire on the
//     very next tick).
func decideSwap(rows []AccountUsage, activeDir string, prevUtil map[string]float64, manualPickDir string, manualPickUtil float64, cfg Config) (*AccountUsage, string) {
	var active *AccountUsage
	candidates := make([]*AccountUsage, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		if r.ConfigDir == activeDir {
			active = r
			continue
		}
		if r.Err != nil || r.Usage == nil || r.refreshToken == "" {
			continue
		}
		candidates = append(candidates, r)
	}
	if active == nil || active.Err != nil || active.Usage == nil {
		return nil, ""
	}
	if len(candidates) == 0 {
		return nil, ""
	}

	stickyManual := manualPickDir != "" && active.ConfigDir == manualPickDir
	if cfg.RebalanceOnReset && len(prevUtil) > 0 && !stickyManual {
		for _, c := range candidates {
			cur := fiveHourUtil(c.Usage)
			prev, hadPrev := prevUtil[c.ConfigDir]
			if hadPrev && prev >= 5 && cur < 1 {
				return c, fmt.Sprintf("%s window reset", c.Name)
			}
		}
	}

	activeUtil := fiveHourUtil(active.Usage)
	for _, t := range cfg.SwapThresholds {
		// While the user's manual pin is still in effect, skip any
		// threshold the picked account had already exceeded at pin
		// time. Without this, picking a 52% account with thresholds
		// [50, 80, 100] would auto-revert on the very next tick (52
		// >= 50, candidate < 50 found, swap fires).
		if stickyManual && t <= manualPickUtil {
			continue
		}
		if activeUtil < t {
			return nil, ""
		}
		eligible := candidates[:0:0]
		for _, c := range candidates {
			if fiveHourUtil(c.Usage) < t {
				eligible = append(eligible, c)
			}
		}
		if len(eligible) == 0 {
			continue
		}
		target := pickTarget(eligible, cfg.PickOrder)
		if target == nil {
			continue
		}
		reason := fmt.Sprintf("active hit %.0f%%", activeUtil)
		return target, reason
	}
	return nil, ""
}

func pickTarget(eligible []*AccountUsage, order string) *AccountUsage {
	if len(eligible) == 0 {
		return nil
	}
	sorted := append([]*AccountUsage(nil), eligible...)
	sort.SliceStable(sorted, func(i, j int) bool {
		ui := fiveHourUtil(sorted[i].Usage)
		uj := fiveHourUtil(sorted[j].Usage)
		if order == PickOrderHighest {
			return ui > uj
		}
		return ui < uj
	})
	return sorted[0]
}

// executeSwap rewrites the plain keychain slot to point at targetDir's
// account. Two writes happen, in this order:
//
//  1. Park: if the plain slot currently represents a discovered account
//     other than targetDir, mirror its creds into that account's hashed
//     entry. This is what keeps the dashboard's per-account usage view
//     accurate after a swap — without parking, the next refresh would
//     read the plain slot back through the default-dir candidate list
//     and report the *target* account's usage under the *active*
//     account's row.
//
//     Skipped when the plain slot is already in sync with the source
//     account's hashed entry (refreshTokens match), so the parking
//     write only happens on the actual rotation event.
//
//  2. Promote: copy targetDir's hashed entry into the plain slot. The
//     next API call from any default-flow `claude` tab picks up the
//     new bearer token without restarting the process.
func executeSwap(rows []AccountUsage, activeDir, targetDir string) error {
	if activeDir == targetDir {
		return nil
	}
	target := findRow(rows, targetDir)
	if target == nil {
		return fmt.Errorf("target %s not in current snapshot", targetDir)
	}
	targetCreds, err := LoadCredentialsByService(keychainServiceFor(targetDir))
	if err != nil {
		return fmt.Errorf("read target creds: %w", err)
	}

	if active := findRow(rows, activeDir); active != nil && active.refreshToken != "" {
		plain, _ := LoadCredentialsByService(plainKeychainSvc)
		if plain != nil && plain.RefreshToken == active.refreshToken {
			parkSvc := keychainServiceFor(activeDir)
			if existing, _ := LoadCredentialsByService(parkSvc); existing == nil || existing.RefreshToken != plain.RefreshToken {
				if err := WriteKeychainEntry(parkSvc, plain); err != nil {
					return fmt.Errorf("park active creds: %w", err)
				}
			}
		}
	}

	if err := WriteKeychainEntry(plainKeychainSvc, targetCreds); err != nil {
		return fmt.Errorf("promote target into plain slot: %w", err)
	}

	// Sync $HOME/.claude.json's `oauthAccount` block so the `claude`
	// CLI (no CLAUDE_CONFIG_DIR) shows the now-active target's email
	// and displayName instead of the previous account's. Best-effort:
	// the keychain rotation above is the load-bearing change, so a
	// failure here (file missing, JSON corrupt, EPERM) only leaves
	// the banner stale — it doesn't break the swap itself.
	syncHomeOAuthAccount(activeDir, targetDir)

	return nil
}

// syncHomeOAuthAccount keeps $HOME/.claude.json's `oauthAccount` field
// pointing at whichever account currently owns the plain keychain
// slot. Without it, `claude` (no CLAUDE_CONFIG_DIR) keeps showing the
// previously logged-in email even after a rotation — tokens flip but
// the displayed identity lags until the next `/login`.
//
// Two writes happen, in order:
//
//  1. Backup. If we're leaving the default ~/.claude account and no
//     ~/.claude/.claude.json exists yet, snapshot the home file's
//     oauthAccount to that in-dir path so a later swap *back* to
//     default has a place to read default's identity from (the home
//     file will have been overwritten by step 2 below). When an
//     in-dir .claude.json already exists, we leave it untouched on
//     the assumption it's Claude Code's own (some setups keep the
//     default config in-dir) and rely on it as the restore source —
//     overwriting it with our minimal one-field JSON would
//     obliterate numStartups/projects/etc.
//
//  2. Patch. Read the target's oauthAccount block from its canonical
//     .claude.json (in-dir for non-default accounts; for the default,
//     the in-dir backup created above, with $HOME/.claude.json as a
//     last-ditch fallback) and write it into $HOME/.claude.json's
//     oauthAccount field. Every other top-level field is preserved.
//
// Best-effort throughout: any failure is swallowed. Surfacing errors
// here would push noisy banner text in front of the user for a purely
// cosmetic concern (the keychain rotation already succeeded).
func syncHomeOAuthAccount(activeDir, targetDir string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	homePath := filepath.Join(home, ".claude.json")
	defaultDir := defaultClaudeDir()

	if activeDir == defaultDir && targetDir != defaultDir {
		backup := filepath.Join(defaultDir, ".claude.json")
		// Defensive: if ~/.claude/.claude.json already exists, assume
		// Claude Code authored it with the full default-account
		// config (some setups keep it in-dir rather than at $HOME)
		// and leave it alone. Its oauthAccount is already default's,
		// so readOAuthAccountBlock(defaultDir) — which prefers in-dir
		// — will recover the right block on a future restore without
		// our backup. Writing our minimal one-field JSON over a real
		// config file would obliterate numStartups/projects/etc.
		if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
			if block, err := readOAuthAccountBlockFromFile(homePath); err == nil && block != nil {
				_ = writeMinimalClaudeJSON(backup, block)
			}
		}
	}

	block, err := readOAuthAccountBlock(targetDir)
	if err != nil || block == nil {
		return
	}
	_ = patchOAuthAccountInFile(homePath, block)
}

func findRow(rows []AccountUsage, configDir string) *AccountUsage {
	for i := range rows {
		if rows[i].ConfigDir == configDir {
			return &rows[i]
		}
	}
	return nil
}

// findRowByIdent matches an account by name, email, or absolute config
// dir — in that order, exact match only. Returns nil when no row
// matches. Used by the CLI swap entry point so the slash command can
// hand us whichever identifier is most convenient (name is the
// shortest, email is the most stable).
func findRowByIdent(rows []AccountUsage, ident string) *AccountUsage {
	ident = strings.TrimSpace(ident)
	if ident == "" {
		return nil
	}
	for i := range rows {
		if rows[i].Name == ident {
			return &rows[i]
		}
	}
	for i := range rows {
		if rows[i].Email != "" && rows[i].Email == ident {
			return &rows[i]
		}
	}
	for i := range rows {
		if rows[i].ConfigDir == ident {
			return &rows[i]
		}
	}
	return nil
}

// snapshotAccountsLite resolves accounts and loads their per-dir
// keychain creds, without making any network calls. Used by the CLI
// helpers (--list-accounts, --swap-to) that don't need live
// /api/oauth/usage data — only the credentials needed to identify the
// active account and to write the plain slot.
//
// Rows that fail to load creds are still returned (with refreshToken
// empty) so listing shows them as "not authenticated" rather than
// silently dropping them.
func snapshotAccountsLite(rootSpec string) ([]AccountUsage, error) {
	accts, err := ResolveAccountDirs(rootSpec)
	if err != nil {
		return nil, err
	}
	if len(accts) == 0 {
		if rootSpec == "" {
			return nil, fmt.Errorf("no Claude config dirs found in $HOME (looked for ~/.claude*)")
		}
		return nil, fmt.Errorf("no accounts found under %s", rootSpec)
	}
	rows := make([]AccountUsage, len(accts))
	for i, a := range accts {
		rows[i] = AccountUsage{Name: a.name, ConfigDir: a.configDir, Email: a.email}
		// Hashed-first because after a swap the plain entry no longer
		// represents the default account; only the hashed entries are
		// reliable per-account identities.
		if creds, err := LoadCredentialsHashedFirst(a.configDir); err == nil {
			rows[i].refreshToken = creds.RefreshToken
		}
	}
	return rows, nil
}

// SwapTo is the non-TUI entry point that a slash command (or any
// shell caller) hits via `claude-monitor --swap-to <ident>`. It writes
// the plain keychain slot to point at the named account so the next
// API call from any default-flow `claude` tab transparently picks up
// the new bearer token.
//
// ident may be the account's short name ("acc-be-1"), its email, or
// its absolute config dir.
func SwapTo(rootSpec, ident string) error {
	rows, err := snapshotAccountsLite(rootSpec)
	if err != nil {
		return err
	}
	target := findRowByIdent(rows, ident)
	if target == nil {
		return fmt.Errorf("account %q not found (try --list-accounts)", ident)
	}
	if target.refreshToken == "" {
		return fmt.Errorf("account %q has no stored credentials (run `claude` once for that account)", ident)
	}
	activeDir := detectActiveDir(rows)
	if activeDir == target.ConfigDir {
		fmt.Printf("already active: %s\n", displayIdent(target))
		return nil
	}
	fromName := "?"
	if active := findRow(rows, activeDir); active != nil {
		fromName = displayIdent(active)
	}
	if err := executeSwap(rows, activeDir, target.ConfigDir); err != nil {
		return err
	}
	fmt.Printf("swapped: %s → %s\n", fromName, displayIdent(target))
	return nil
}

// ListAccounts prints a table of discovered accounts with live 5h
// utilization (so a slash command can show the user which account is
// least loaded). The active account is marked with a trailing "(active)".
//
// Network errors per row render inline as the row's status, mirroring
// the TUI behavior; an account that hasn't been authenticated yet
// shows "not authenticated" instead of a percentage.
func ListAccounts(rootSpec string) error {
	cfg, _ := LoadConfig()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := FetchAll(ctx, rootSpec, cfg, nil, nil, "", 0)
	if err != nil {
		return err
	}
	maxName, maxEmail := len("NAME"), len("EMAIL")
	for _, r := range res.Rows {
		if n := len(r.Name); n > maxName {
			maxName = n
		}
		if n := len(r.Email); n > maxEmail {
			maxEmail = n
		}
	}
	fmt.Printf("%-*s  %-*s  %6s  %s\n",
		maxName, "NAME", maxEmail, "EMAIL", "5H", "STATUS")
	for _, r := range res.Rows {
		util := "—"
		status := ""
		switch {
		case r.refreshToken == "" && r.Err == nil:
			status = "not authenticated"
		case r.Err != nil:
			status = truncate(r.Err.Error(), 60)
		case r.Usage != nil:
			util = fmt.Sprintf("%3.0f%%", fiveHourUtil(r.Usage))
		}
		if r.ConfigDir == res.ActiveDir {
			if status != "" {
				status = "active — " + status
			} else {
				status = "active"
			}
		}
		fmt.Printf("%-*s  %-*s  %6s  %s\n",
			maxName, r.Name, maxEmail, r.Email, util, status)
	}
	return nil
}

func displayIdent(r *AccountUsage) string {
	if r == nil {
		return "?"
	}
	if r.Email != "" {
		return fmt.Sprintf("%s (%s)", r.Name, r.Email)
	}
	return r.Name
}
