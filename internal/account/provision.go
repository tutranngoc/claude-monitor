package account

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// nameRE constrains short names to the characters that can appear in a
// filesystem path without surprises (no spaces, no separators, no shell
// glob meta). The form rejects anything else with a friendly error
// before we touch the filesystem.
var nameRE = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// ValidateName checks that a user-typed short name will produce a sane
// config dir. The form calls this on every keystroke so validation
// errors render live; Provision calls it again as a defensive check.
func ValidateName(name string) error {
	if name == "" {
		return fmt.Errorf("name is required")
	}
	if len(name) > 50 {
		return fmt.Errorf("name too long (max 50)")
	}
	if !nameRE.MatchString(name) {
		return fmt.Errorf("only letters, digits, '.', '-', '_'")
	}
	if name == "." || name == ".." {
		return fmt.Errorf("reserved name")
	}
	return nil
}

// ConfigDirForName resolves a short name into the absolute config dir
// the [a] flow will create. Mirrors the auto-discovery convention of
// ~/.claude-<name> so the new account shows up on the next refresh
// tick without needing --root reconfiguration.
func ConfigDirForName(name string) (string, error) {
	if err := ValidateName(name); err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	return filepath.Join(home, ".claude-"+name), nil
}

// Provision prepares a fresh config dir for an upcoming `claude auth
// login` invocation. Two things happen, in order:
//
//  1. Resolve ~/.claude-<name> and refuse if anything already exists at
//     that path — overwriting an existing account dir is destructive
//     and the user should pick a different name (or use [L] to relogin
//     on the existing one).
//
//  2. mkdir the dir + an empty projects/ subdir. The subdir is what
//     looksLikeClaudeDir keys off, so even if the user cancels in the
//     browser flow, the next auto-discovery tick still surfaces the
//     account as a row (rendered "not authenticated" until [L] retry).
//
// We deliberately do NOT write a .claude.json with the user-provided
// email here: the OAuth flow may complete with a different identity,
// and claude itself writes the real oauthAccount block on success. A
// fake stub would mislabel the row until the next refresh.
func Provision(name string) (string, error) {
	dir, err := ConfigDirForName(name)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(dir); err == nil {
		return "", fmt.Errorf("already exists: %s", dir)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("stat %s: %w", dir, err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "projects"), 0o700); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return dir, nil
}
