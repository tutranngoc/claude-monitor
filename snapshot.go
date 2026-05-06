package main

import (
	"context"
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
func FetchAll(ctx context.Context, rootSpec string, cfg Config, skipUntil map[string]time.Time, prevUtil map[string]float64) (*FetchResult, error) {
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
			rows[i] = AccountUsage{
				Name:      a.name,
				ConfigDir: a.configDir,
				Email:     a.email,
				Err:       fmt.Errorf("rate limited (retry in %s)", time.Until(t).Round(time.Second)),
			}
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
		if target, reason := decideSwap(rows, result.ActiveDir, prevUtil, cfg); target != nil {
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
	usage, err := FetchUsage(ctx, creds.AccessToken)
	if err != nil {
		row.Err = err
		return row
	}
	row.Usage = usage
	row.accessToken = creds.AccessToken
	row.refreshToken = creds.RefreshToken
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

// readAccountEmail extracts oauthAccount.emailAddress from .claude.json
// without unmarshalling the whole 24KB blob.
//
// Claude Code stores the config file in two different layouts:
//
//   - With CLAUDE_CONFIG_DIR set (e.g. ~/.claude-gem): the file lives
//     *inside* the config dir as <configDir>/.claude.json.
//   - With no env override (the default ~/.claude account): the file
//     lives in $HOME as ~/.claude.json — a sibling of the dir, not a
//     child. The ~/.claude dir itself only holds sessions/projects.
//
// We try the in-dir path first and fall back to the sibling layout so
// the default-account row gets a real email instead of just a folder
// name.
func readAccountEmail(configDir string) string {
	candidates := []string{filepath.Join(configDir, ".claude.json")}
	if configDir == defaultClaudeDir() {
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".claude.json"))
		}
	}
	for _, p := range candidates {
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
	const key = `"emailAddress":"`
	i := strings.Index(string(b), key)
	if i < 0 {
		return ""
	}
	rest := string(b)[i+len(key):]
	end := strings.Index(rest, `"`)
	if end < 0 {
		return ""
	}
	return rest[:end]
}
