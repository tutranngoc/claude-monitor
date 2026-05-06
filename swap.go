package main

import (
	"fmt"
	"sort"
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
//
// prevUtil maps configDir → previous-tick util, used only for the reset
// detection. Pass nil on the first refresh.
func decideSwap(rows []AccountUsage, activeDir string, prevUtil map[string]float64, cfg Config) (*AccountUsage, string) {
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

	if cfg.RebalanceOnReset && len(prevUtil) > 0 {
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
	return nil
}

func findRow(rows []AccountUsage, configDir string) *AccountUsage {
	for i := range rows {
		if rows[i].ConfigDir == configDir {
			return &rows[i]
		}
	}
	return nil
}
