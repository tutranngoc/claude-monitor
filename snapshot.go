package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// AccountUsage is one row of the dashboard.
type AccountUsage struct {
	Name      string
	ConfigDir string
	Email     string

	Usage *APIUsage // nil when fetch failed
	Err   error     // populated when Usage is nil

	// Auto-kick state. Populated only when AutoKick is on and the row was
	// eligible (5h window at 0% utilization at the moment of refresh).
	Kicked  bool
	KickErr error

	accessToken  string // retained for the auto-kick pass; not exported
	refreshToken string // used by swap module to identify which account currently owns the plain keychain slot
}

// FetchResult bundles the per-snapshot data the TUI needs from a single
// refresh: the rows, plus auto-swap outcome (which account is currently
// behind the plain `claude` slot, and whether a rotation just happened).
type FetchResult struct {
	Rows      []AccountUsage
	ActiveDir string
	Swap      *SwapEvent
	SwapErr   error
}

// FetchAll resolves accounts according to rootSpec, queries
// /api/oauth/usage for each in parallel, optionally kicks any account
// whose 5h window is at 0%, and (when cfg.AutoSwap is on) rotates the
// plain keychain slot to a fresher account. Returns the snapshot the
// TUI renders.
//
// skipUntil maps a config dir to a "do not call API before" timestamp;
// accounts in the backoff window get a synthetic row reflecting the
// remaining wait, so the UI keeps showing them but no request goes out.
//
// prevUtil carries the previous tick's 5h utilization per config dir,
// used by the swap module to detect window resets between refreshes.
// Pass nil on the very first refresh.
//
// manualPickDir is the configDir the user most recently pinned via the
// in-TUI [m] picker; while it matches the active account, auto-swap's
// rebalance-on-reset is suppressed and threshold tiers <= the pinned
// account's util at pin time (manualPickUtil) are skipped — so the
// pin sticks until the *next* tier above where the user picked. Pass
// "" / 0 when there is no active manual pick.
func FetchAll(ctx context.Context, rootSpec string, cfg Config, skipUntil map[string]time.Time, prevUtil map[string]float64, manualPickDir string, manualPickUtil float64) (*FetchResult, error) {
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

	now := time.Now()
	rows := make([]AccountUsage, len(accts))
	var wg sync.WaitGroup
	for i, a := range accts {
		i, a := i, a
		if t, ok := skipUntil[a.configDir]; ok && now.Before(t) {
			row := AccountUsage{
				Name:      a.name,
				ConfigDir: a.configDir,
				Email:     a.email,
				Err:       fmt.Errorf("rate limited (retry in %s)", time.Until(t).Round(time.Second)),
			}
			// Populate refreshToken from the per-dir hashed keychain
			// entry even though we're skipping the API call. Without
			// this, detectActiveDir can't match the plain slot's
			// RefreshToken against any row when the actually-active
			// account is the one in 429 backoff — and silently
			// reverts the ★ marker to defaultClaudeDir, making a
			// just-completed manual swap look like it "lost"
			// itself the moment Anthropic returns a 429.
			if creds, err := LoadCredentialsHashedFirst(a.configDir); err == nil {
				row.refreshToken = creds.RefreshToken
			}
			rows[i] = row
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows[i] = fetchOne(ctx, a, cfg.AutoSwap)
		}()
	}
	wg.Wait()

	if cfg.AutoKick {
		runAutoKick(ctx, rows)
	}

	result := &FetchResult{Rows: rows}
	result.ActiveDir = detectActiveDir(rows)
	if cfg.AutoSwap {
		if target, reason := decideSwap(rows, result.ActiveDir, prevUtil, manualPickDir, manualPickUtil, cfg); target != nil {
			active := findRow(rows, result.ActiveDir)
			ev := &SwapEvent{
				FromName: rowDisplayName(active),
				ToName:   target.Name,
				FromUtil: rowFiveHourUtil(active),
				ToUtil:   fiveHourUtil(target.Usage),
				Reason:   reason,
			}
			if err := executeSwap(rows, result.ActiveDir, target.ConfigDir); err != nil {
				result.SwapErr = err
			} else {
				result.Swap = ev
				result.ActiveDir = target.ConfigDir
			}
		}
	}
	return result, nil
}

func rowDisplayName(r *AccountUsage) string {
	if r == nil {
		return "?"
	}
	return r.Name
}

func rowFiveHourUtil(r *AccountUsage) float64 {
	if r == nil {
		return 0
	}
	return fiveHourUtil(r.Usage)
}

// runAutoKick fires a 1-token message at every account whose 5h window is
// currently at 0% utilization, in parallel. We do this after the fetch pass
// so we know the actual util value rather than trusting stale state.
func runAutoKick(ctx context.Context, rows []AccountUsage) {
	var wg sync.WaitGroup
	for i := range rows {
		r := &rows[i]
		if r.Err != nil || r.Usage == nil || r.accessToken == "" {
			continue
		}
		if fiveHourUtil(r.Usage) > 0 {
			continue
		}
		wg.Add(1)
		go func(r *AccountUsage) {
			defer wg.Done()
			kickCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := KickWindow(kickCtx, r.accessToken); err != nil {
				r.KickErr = err
				return
			}
			r.Kicked = true
		}(r)
	}
	wg.Wait()
}

func fiveHourUtil(u *APIUsage) float64 {
	if u == nil || u.FiveHour == nil {
		return 0
	}
	return u.FiveHour.Utilization
}

type discoveredAccount struct {
	name      string
	configDir string
	email     string
}

// ResolveAccountDirs interprets a --root spec into a deduped, sorted list
// of accounts.
//
//   - empty string    → auto-discover every ~/.claude* directory in $HOME
//     that looks like a Claude config dir, plus the
//     subdirectories of ~/.claude-account if present.
//   - comma-separated → each path may be a single Claude config dir
//     (treated as one account) or a parent dir whose
//     subdirectories are accounts.
//
// The function dedupes by canonical absolute path so that, e.g., a
// symlink farm under ~/.claude-account doesn't double-count its targets.
func ResolveAccountDirs(spec string) ([]discoveredAccount, error) {
	var paths []string
	if spec == "" {
		var err error
		paths, err = autoDiscoverPaths()
		if err != nil {
			return nil, err
		}
	} else {
		for _, p := range strings.Split(spec, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			paths = append(paths, expandHome(p))
		}
	}

	seen := map[string]struct{}{}
	var out []discoveredAccount
	for _, p := range paths {
		entries := expandRootPath(p)
		for _, dir := range entries {
			abs, err := filepath.Abs(dir)
			if err != nil {
				abs = dir
			}
			if resolved, err := filepath.EvalSymlinks(abs); err == nil {
				abs = resolved
			}
			if _, dup := seen[abs]; dup {
				continue
			}
			seen[abs] = struct{}{}
			out = append(out, discoveredAccount{
				name:      accountNameFor(abs),
				configDir: abs,
				email:     readAccountEmail(abs),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

// expandRootPath turns one user-supplied path into the list of actual
// account config dirs it represents. If the path itself is a Claude
// config dir, the path is returned as-is. Otherwise it is treated as a
// parent and its immediate subdirectories are scanned.
func expandRootPath(path string) []string {
	if !dirExists(path) {
		return nil
	}
	if looksLikeClaudeDir(path) {
		return []string{path}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub := filepath.Join(path, e.Name())
		if looksLikeClaudeDir(sub) {
			out = append(out, sub)
		}
	}
	return out
}

// autoDiscoverPaths returns every ~/.claude* entry in $HOME that's a
// directory. The caller decides whether each entry is a single account
// or a parent — autoDiscover doesn't second-guess that.
func autoDiscoverPaths() ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, ".claude") {
			continue
		}
		if !e.IsDir() {
			// Skip files like .claude.json / .claude.json.backup.
			continue
		}
		out = append(out, filepath.Join(home, name))
	}
	return out, nil
}

// accountNameFor derives the display name for an account from its path.
// Strip the leading dot so ".claude" reads as "claude" in the table.
func accountNameFor(absPath string) string {
	base := filepath.Base(absPath)
	return strings.TrimPrefix(base, ".")
}

func expandHome(p string) string {
	if !strings.HasPrefix(p, "~") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func fetchOne(ctx context.Context, a discoveredAccount, autoSwap bool) AccountUsage {
	row := AccountUsage{Name: a.name, ConfigDir: a.configDir, Email: a.email}
	// When auto-swap is on, prefer the per-dir hashed entry so the
	// dashboard still shows each account's real usage even after the
	// plain slot has been rotated to impersonate a different account.
	loader := LoadCredentials
	if autoSwap {
		loader = LoadCredentialsHashedFirst
	}
	creds, err := loader(a.configDir)
	if err != nil {
		row.Err = fmt.Errorf("no token (run `claude` once to login)")
		return row
	}
	if creds.Expired() {
		row.Err = fmt.Errorf("token expired (run `claude` once to refresh)")
		return row
	}
	// Populate refreshToken/accessToken before the network call so a
	// transient API failure (rate limit, 5xx) doesn't strand the row
	// without identity. detectActiveDir and the manual-swap picker
	// both compare against refreshToken — leaving it empty made the
	// ★ marker drift and blocked swaps to rate-limited rows even
	// though the underlying creds were perfectly fine.
	row.accessToken = creds.AccessToken
	row.refreshToken = creds.RefreshToken
	usage, err := FetchUsage(ctx, creds.AccessToken)
	if err != nil {
		row.Err = err
		return row
	}
	row.Usage = usage
	return row
}

// looksLikeClaudeDir is permissive on purpose: a freshly authenticated
// account may not have a projects/ subdir yet, but we still want it on the
// dashboard so the user can see the account exists.
func looksLikeClaudeDir(path string) bool {
	for _, marker := range []string{".claude.json", "projects", "sessions"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

// claudeJSONPaths returns the candidate .claude.json paths for an
// account's config dir, in priority order. Two cases matter:
//
//   - With CLAUDE_CONFIG_DIR set (e.g. ~/.claude-gem): the file lives
//     *inside* the config dir as <configDir>/.claude.json.
//   - With no env override (the default ~/.claude account): the file
//     lives in $HOME as ~/.claude.json — a sibling of the dir, not a
//     child. The ~/.claude dir itself only holds sessions/projects.
//
// In-dir is tried first so the default account's row keeps reading
// the right email after the home-side $HOME/.claude.json has been
// rewritten by an oauthAccount-sync swap (executeSwap stashes the
// pre-swap default identity into ~/.claude/.claude.json before
// overwriting the home file — see syncHomeOAuthAccount).
func claudeJSONPaths(configDir string) []string {
	paths := []string{filepath.Join(configDir, ".claude.json")}
	if configDir == defaultClaudeDir() {
		if home, err := os.UserHomeDir(); err == nil {
			paths = append(paths, filepath.Join(home, ".claude.json"))
		}
	}
	return paths
}

// readAccountEmail extracts oauthAccount.emailAddress from .claude.json
// without unmarshalling the whole 24KB blob.
func readAccountEmail(configDir string) string {
	for _, p := range claudeJSONPaths(configDir) {
		if email := emailFromClaudeJSON(p); email != "" {
			return email
		}
	}
	return ""
}

func emailFromClaudeJSON(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	// Locate `"emailAddress"`, then skip whitespace + `:` + whitespace
	// before the opening quote of the value. Claude Code's JSON
	// encoder writes the field with a space (`"emailAddress": "…"`)
	// while the older shape did not (`"emailAddress":"…"`); the
	// permissive walk handles both without paying for a full
	// json.Unmarshal of the 24KB blob.
	s := string(b)
	const key = `"emailAddress"`
	i := strings.Index(s, key)
	if i < 0 {
		return ""
	}
	j := i + len(key)
	for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
		j++
	}
	if j >= len(s) || s[j] != ':' {
		return ""
	}
	j++
	for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
		j++
	}
	if j >= len(s) || s[j] != '"' {
		return ""
	}
	j++
	end := strings.Index(s[j:], `"`)
	if end < 0 {
		return ""
	}
	return s[j : j+end]
}

// readOAuthAccountBlock returns the raw JSON of the `oauthAccount`
// field from the account's .claude.json (in-dir first, home fallback
// for the default account). Returns (nil, nil) when the file or field
// is missing — callers treat that as "no identity to copy" and skip
// the sync silently.
//
// Used at swap time to copy the target account's identity (email,
// displayName, accountUuid, organizationName, …) into the plain
// slot's $HOME/.claude.json so `claude` running without
// CLAUDE_CONFIG_DIR shows the right "logged in as <email>" banner
// after the keychain rotation.
func readOAuthAccountBlock(configDir string) (json.RawMessage, error) {
	for _, p := range claudeJSONPaths(configDir) {
		block, err := readOAuthAccountBlockFromFile(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if block != nil {
			return block, nil
		}
	}
	return nil, nil
}

func readOAuthAccountBlockFromFile(path string) (json.RawMessage, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(b, &data); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	block, ok := data["oauthAccount"]
	if !ok || len(block) == 0 || string(block) == "null" {
		return nil, nil
	}
	return block, nil
}

// patchOAuthAccountInFile rewrites the `oauthAccount` field in the
// given .claude.json with `block`, preserving every other top-level
// field. Atomic via write-temp-and-rename so a concurrent reader
// (Claude Code itself) never sees a half-written file.
//
// No-op when the destination doesn't exist — we don't conjure a
// .claude.json from scratch; that's Claude Code's responsibility on
// first login.
func patchOAuthAccountInFile(path string, block json.RawMessage) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(b, &data); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	data["oauthAccount"] = block
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	perm := os.FileMode(0o600)
	if info, statErr := os.Stat(path); statErr == nil {
		perm = info.Mode().Perm()
	}
	return writeFileAtomic(path, out, perm)
}

// writeMinimalClaudeJSON writes a one-field `.claude.json` containing
// only the oauthAccount block. Used to back up the default account's
// identity to ~/.claude/.claude.json before the first swap-away
// rewrites $HOME/.claude.json — without this stash, the original
// default identity would be lost and a future swap-back-to-default
// couldn't restore it.
//
// Idempotent: re-running with the same block produces an identical
// file (modulo Go's map-key ordering on remarshal), so we don't bother
// short-circuiting when the content already matches.
func writeMinimalClaudeJSON(path string, block json.RawMessage) error {
	payload := map[string]json.RawMessage{"oauthAccount": block}
	out, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	return writeFileAtomic(path, out, 0o600)
}

// writeFileAtomic writes data to a temp file in the same directory and
// renames it over `path`. Avoids partial-write corruption of
// .claude.json when Claude Code is concurrently reading or writing it.
// Permissions on the final file match `perm` (we set them on the temp
// file before the rename).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp.*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := f.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("write %s: %w", tmpName, err)
	}
	if err := f.Chmod(perm); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("chmod %s: %w", tmpName, err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("rename %s -> %s: %w", tmpName, path, err)
	}
	return nil
}
