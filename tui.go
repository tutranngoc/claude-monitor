package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ----------------------------------------------------------------------
// Messages
// ----------------------------------------------------------------------

// tickMsg fires every config.IntervalSeconds and triggers a refresh.
type tickMsg time.Time

// secondTickMsg fires once per second to drive live countdowns
// ("refreshed 12s ago", "rate limited (retry in 4m23s)") that aren't
// tied to the slower refresh cadence.
type secondTickMsg struct{}

// refreshMsg carries the result of a FetchAll call back into the model.
// The version field matches the inflight counter at the time the
// refresh was launched so that stale results from a superseded refresh
// can be dropped silently.
type refreshMsg struct {
	rows      []AccountUsage
	activeDir string
	swap      *SwapEvent
	swapErr   error
	err       error
	at        time.Time
	version   uint64
}

// flashClearMsg clears a transient status banner (used for "config saved",
// "kick toggled", etc).
type flashClearMsg struct{}

// updateCheckMsg carries the result of the background GitHub-Releases
// check that fires once on Init. info==nil means "no update available
// or the check failed silently"; either way the banner stays hidden.
type updateCheckMsg struct {
	info *UpdateInfo
}

// upgradeDoneMsg is the result of a [u]-triggered self-replace.
type upgradeDoneMsg struct {
	tag string
	err error
}

// upgradeQuitMsg fires a few seconds after a successful upgrade so the
// user has time to read "✓ upgraded" before the TUI tears down.
type upgradeQuitMsg struct{}

// manualSwapDoneMsg is the result of a [m]-triggered keychain rewrite.
// targetDir identifies the account the user picked; targetUtil is the
// 5h utilization of that account at the moment of pin (used by
// decideSwap to decide which threshold tiers to skip while the pin is
// in effect). err is non-nil when the keychain write failed (in which
// case the active account is unchanged and a flash banner reports the
// error).
type manualSwapDoneMsg struct {
	targetDir  string
	targetTag  string
	fromTag    string
	targetUtil float64
	err        error
}

// ----------------------------------------------------------------------
// Model
// ----------------------------------------------------------------------

type model struct {
	cfg  Config
	root string

	rows        []AccountUsage
	activeDir   string
	lastSwap    *SwapEvent
	swapErr     error
	prevUtil    map[string]float64
	err         error
	lastRefresh time.Time
	refreshing  bool

	// backoff[configDir] is the earliest moment at which we'll call the
	// API for that account again. Populated when an account hits HTTP
	// 429 and cleared once the window expires (lazily, on next refresh)
	// or when the user presses 'R' to force a retry.
	backoff map[string]time.Time

	// inflight is incremented every time we issue a refreshCmd and
	// compared against the version embedded in the resulting refreshMsg
	// — a stale result from a previous tick is discarded if a newer
	// refresh has been started in the meantime.
	inflight uint64

	flash       string
	flashExpiry time.Time

	// Update state. updateInfo is populated asynchronously on Init by
	// CheckForUpdate; nil means no banner. upgrading is true while a
	// [u]-triggered self-replace is downloading. UpgradeRestart is read
	// by main() after Run() returns: true means "we successfully
	// replaced the binary, please re-exec yourself so the user lands
	// in the new version's TUI without typing the command again".
	updateInfo     *UpdateInfo
	upgrading      bool
	UpgradeRestart bool

	width    int
	height   int
	showHelp bool

	editing bool
	editor  editorState

	// Manual-swap picker state. When picking is true, [m] is open and
	// pickCursor is the index into m.rows of the highlighted row;
	// arrow keys move it, Enter executes the swap. manualPickDir is
	// the configDir of the user's most recent manual pick — while
	// it equals the active dir, auto-swap's rebalance-on-reset is
	// suppressed (the threshold cascade still applies, so the pick
	// sticks until the next tier is hit).
	picking        bool
	pickCursor     int
	manualPickDir  string
	// manualPickUtil is the 5h util of the picked account at the
	// moment of pin. decideSwap uses it to skip threshold tiers the
	// user already saw at pin time — so a deliberate pick at 52%
	// with thresholds [50, 80, 100] sticks until 80, not 50.
	manualPickUtil float64
	manualSwapping bool
}

func initialModel(root string, cfg Config) model {
	// Start at inflight=1, refreshing=true so the first frame already
	// shows "loading…" while Init's refreshCmd runs.
	return model{
		root:       root,
		cfg:        cfg,
		showHelp:   true,
		inflight:   1,
		refreshing: true,
		backoff:    map[string]time.Time{},
		prevUtil:   map[string]float64{},
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		m.refreshCmd(m.inflight),
		tickCmd(RefreshIntervalSeconds),
		secondTickCmd(),
		updateCheckCmd(version),
	)
}

func updateCheckCmd(currentVersion string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		info, _ := CheckForUpdate(ctx, currentVersion)
		return updateCheckMsg{info: info}
	}
}

func upgradeCmd(info *UpdateInfo) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		err := PerformUpgrade(ctx, info)
		return upgradeDoneMsg{tag: info.LatestTag, err: err}
	}
}

// ----------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------

func (m *model) refreshCmd(version uint64) tea.Cmd {
	root := m.root
	cfg := m.cfg
	manualPick := m.manualPickDir
	manualPickUtil := m.manualPickUtil
	// Snapshot the backoff map and prev-util map so the goroutine has a
	// stable view, even if the user presses 'R' (which mutates
	// m.backoff) or another tick fires while in flight.
	skipUntil := make(map[string]time.Time, len(m.backoff))
	for k, v := range m.backoff {
		skipUntil[k] = v
	}
	prev := make(map[string]float64, len(m.prevUtil))
	for k, v := range m.prevUtil {
		prev[k] = v
	}
	return func() tea.Msg {
		// Auto-swap involves keychain writes (~hundreds of ms each), so
		// give a more generous deadline when swapping is enabled.
		deadline := 30 * time.Second
		if cfg.AutoSwap {
			deadline = 60 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		defer cancel()
		res, err := FetchAll(ctx, root, cfg, skipUntil, prev, manualPick, manualPickUtil)
		msg := refreshMsg{err: err, at: time.Now(), version: version}
		if res != nil {
			msg.rows = res.Rows
			msg.activeDir = res.ActiveDir
			msg.swap = res.Swap
			msg.swapErr = res.SwapErr
		}
		return msg
	}
}

// manualSwapCmd runs executeSwap off the UI goroutine. We snapshot the
// rows + activeDir so the keychain writes don't race with concurrent
// refreshes mutating m.rows.
func (m *model) manualSwapCmd(target AccountUsage) tea.Cmd {
	rows := append([]AccountUsage(nil), m.rows...)
	activeDir := m.activeDir
	fromTag := "?"
	if active := findRow(rows, activeDir); active != nil {
		fromTag = accountLabel(*active)
	}
	targetTag := accountLabel(target)
	targetUtil := fiveHourUtil(target.Usage)
	return func() tea.Msg {
		err := executeSwap(rows, activeDir, target.ConfigDir)
		return manualSwapDoneMsg{
			targetDir:  target.ConfigDir,
			targetTag:  targetTag,
			fromTag:    fromTag,
			targetUtil: targetUtil,
			err:        err,
		}
	}
}

func tickCmd(secs int) tea.Cmd {
	return tea.Tick(time.Duration(secs)*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func secondTickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg {
		return secondTickMsg{}
	})
}

func flashClearCmd(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(time.Time) tea.Msg { return flashClearMsg{} })
}

// ----------------------------------------------------------------------
// Update
// ----------------------------------------------------------------------

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		if m.editing {
			if next, cmd, consumed := m.handleEditKey(msg); consumed {
				return next, cmd
			}
		}
		if m.picking {
			if next, cmd, consumed := m.handlePickKey(msg); consumed {
				return next, cmd
			}
		}
		return m.handleKey(msg)

	case tickMsg:
		// Schedule the next tick + kick a refresh if one isn't already in
		// flight. We always re-arm the tick so the cadence stays steady
		// even when the user has just done a manual refresh.
		cmds := []tea.Cmd{tickCmd(RefreshIntervalSeconds)}
		if !m.refreshing {
			m.refreshing = true
			m.inflight++
			cmds = append(cmds, m.refreshCmd(m.inflight))
		}
		return m, tea.Batch(cmds...)

	case refreshMsg:
		// Whichever in-flight goroutine produced this message is now
		// done, so clear the refreshing flag regardless of whether
		// we end up applying the data. Without this, a manual swap
		// that bumps m.inflight (without kicking a new refresh) can
		// strand the flag at true forever — the next tick sees
		// m.refreshing and skips firing, refreshes stop entirely.
		m.refreshing = false
		// Discard results from a refresh that has been superseded by a
		// newer one (e.g. user mashed `r` while a tick was already in
		// flight, or a manual swap invalidated this refresh's view of
		// activeDir).
		if msg.version != m.inflight {
			return m, nil
		}
		m.rows = msg.rows
		m.activeDir = msg.activeDir
		m.err = msg.err
		m.lastRefresh = msg.at
		var swapCmd tea.Cmd
		if msg.swap != nil {
			m.lastSwap = msg.swap
			m.flash = msg.swap.String()
			m.flashExpiry = time.Now().Add(5 * time.Second)
			swapCmd = flashClearCmd(5 * time.Second)
		} else if msg.swapErr != nil {
			m.swapErr = msg.swapErr
			m.flash = "swap failed: " + truncate(msg.swapErr.Error(), 80)
			m.flashExpiry = time.Now().Add(5 * time.Second)
			swapCmd = flashClearCmd(5 * time.Second)
		}
		// Update backoff state from the row results: 429 errors
		// arm/extend the window, while a successful row clears any
		// pre-existing backoff for that account (recovery path).
		// Also refresh prev-util so the next swap pass can detect
		// fresh window resets.
		next := make(map[string]float64, len(msg.rows))
		for _, r := range msg.rows {
			if r.ConfigDir == "" {
				continue
			}
			if rl, ok := r.Err.(*RateLimitError); ok {
				m.backoff[r.ConfigDir] = time.Now().Add(rl.RetryAfter)
				continue
			}
			if r.Err == nil && r.Usage != nil {
				delete(m.backoff, r.ConfigDir)
				next[r.ConfigDir] = fiveHourUtil(r.Usage)
			}
		}
		m.prevUtil = next
		// Auto-swap took over (or the active dir drifted out from
		// under us for any other reason) — the manual pin no longer
		// applies. Clearing here keeps the next decideSwap call
		// honest about whether rebalance-on-reset should fire.
		if m.manualPickDir != "" && m.activeDir != m.manualPickDir {
			m.manualPickDir = ""
			m.manualPickUtil = 0
		}
		// Keep the picker cursor in range when row count changes.
		if m.picking {
			m.clampPickCursor()
		}
		return m, swapCmd

	case manualSwapDoneMsg:
		m.manualSwapping = false
		if msg.err != nil {
			m.flash = "swap failed: " + truncate(msg.err.Error(), 80)
			m.flashExpiry = time.Now().Add(5 * time.Second)
			return m, flashClearCmd(5 * time.Second)
		}
		m.activeDir = msg.targetDir
		m.manualPickDir = msg.targetDir
		m.manualPickUtil = msg.targetUtil
		// Drop the cached prev-util — the rebalance-on-reset detector
		// would otherwise compare across the swap boundary and emit
		// spurious "window reset" decisions.
		m.prevUtil = map[string]float64{}
		// Bump inflight to invalidate any pre-swap refresh that's
		// still mid-flight (otherwise its stale activeDir overwrites
		// ours, the pin gets auto-cleared, and the swap appears to
		// "revert" within a few seconds). We deliberately do NOT
		// kick a fresh refresh here — firing /api/oauth/usage right
		// after a swap empirically piles onto the just-promoted
		// account's rate-limit budget (it's already the busy one,
		// being actively used by `claude`) and triggers a 429 burst.
		// The next 60s tick refreshes naturally; util numbers can be
		// stale for up to a tick, which is fine.
		m.inflight++
		m.flash = fmt.Sprintf("swapped: %s → %s", msg.fromTag, msg.targetTag)
		m.flashExpiry = time.Now().Add(3 * time.Second)
		return m, flashClearCmd(3 * time.Second)

	case flashClearMsg:
		if time.Now().After(m.flashExpiry) {
			m.flash = ""
		}
		return m, nil

	case secondTickMsg:
		// Re-arm; the tick exists purely to force a re-render so live
		// countdowns advance. View() recomputes everything from state.
		return m, secondTickCmd()

	case updateCheckMsg:
		m.updateInfo = msg.info
		return m, nil

	case upgradeDoneMsg:
		m.upgrading = false
		if msg.err != nil {
			m.flash = "upgrade failed: " + truncate(msg.err.Error(), 80)
			m.flashExpiry = time.Now().Add(5 * time.Second)
			return m, flashClearCmd(5 * time.Second)
		}
		// On Unix main() will syscall.Exec back into the new binary
		// after Quit tears down the alt-screen, so the user lands
		// straight back in the dashboard. The 1.2s flash is just long
		// enough for them to read the success line before the screen
		// flips to the new TUI.
		m.flash = fmt.Sprintf("✓ upgraded to %s — restarting…", msg.tag)
		m.flashExpiry = time.Now().Add(2 * time.Second)
		m.updateInfo = nil
		m.UpgradeRestart = true
		return m, tea.Tick(1200*time.Millisecond, func(time.Time) tea.Msg { return upgradeQuitMsg{} })

	case upgradeQuitMsg:
		return m, tea.Quit
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c", "esc":
		return m, tea.Quit

	case "r":
		// Always trigger a brand-new refresh and bump the inflight
		// counter so any in-flight refresh's result will be discarded
		// when it returns. This makes the keypress feel instant: the
		// screen flips to "refreshing…" on the very next frame, even
		// when a tick-driven refresh was already in progress.
		m.refreshing = true
		m.inflight++
		m.flash = "refresh!"
		m.flashExpiry = time.Now().Add(800 * time.Millisecond)
		return m, tea.Batch(
			m.refreshCmd(m.inflight),
			flashClearCmd(800*time.Millisecond),
		)

	case "k":
		m.cfg.AutoKick = !m.cfg.AutoKick
		m.persistAndFlash(fmt.Sprintf("auto-kick: %s", onOff(m.cfg.AutoKick)))
		return m, flashClearCmd(2 * time.Second)

	case "s":
		m.cfg.AutoSwap = !m.cfg.AutoSwap
		// When toggling swap on/off, drop the cached prev-util so the
		// reset-rebalance trigger doesn't fire spuriously on the next
		// refresh based on stale data from the previous mode. Also
		// drop any manual pin: with AutoSwap off the pin is moot, and
		// turning it back on should start with a clean slate.
		m.prevUtil = map[string]float64{}
		m.manualPickDir = ""
		m.manualPickUtil = 0
		m.persistAndFlash(fmt.Sprintf("auto-swap: %s", onOff(m.cfg.AutoSwap)))
		return m, flashClearCmd(2 * time.Second)

	case "e":
		m.editing = !m.editing
		if !m.editing {
			m.editor = editorState{}
		}
		return m, nil

	case "m":
		// Manual account picker. Disabled while another mid-flight
		// swap is in progress so we don't queue racing keychain
		// writes against each other.
		if m.manualSwapping || len(m.rows) == 0 {
			return m, nil
		}
		m.picking = true
		m.pickCursor = m.indexOfActive()
		m.clampPickCursor()
		return m, nil

	case "u":
		// Visible-only hotkey: ignore unless an update is genuinely
		// available and we're not already mid-upgrade. The help bar
		// only advertises [u] when m.updateInfo != nil.
		if m.updateInfo == nil || m.upgrading {
			return m, nil
		}
		m.upgrading = true
		m.flash = "downloading " + m.updateInfo.LatestTag + "…"
		m.flashExpiry = time.Now().Add(150 * time.Second)
		return m, upgradeCmd(m.updateInfo)

	case "?":
		m.showHelp = !m.showHelp
		return m, nil
	}
	return m, nil
}

func (m *model) persistAndFlash(text string) {
	if err := SaveConfig(m.cfg); err != nil {
		m.flash = "save failed: " + err.Error()
	} else {
		m.flash = text
	}
	m.flashExpiry = time.Now().Add(2 * time.Second)
}

// handlePickKey is the inner mode active while the [m] manual-swap
// picker is open. Up/Down move the cursor, Enter executes the swap
// against the highlighted row, Esc/m close the picker. Returns
// consumed=true so dashboard hotkeys don't fire under the picker.
func (m model) handlePickKey(msg tea.KeyMsg) (model, tea.Cmd, bool) {
	switch msg.String() {
	case "esc", "m", "q":
		m.picking = false
		return m, nil, true
	case "up", "k":
		if len(m.rows) == 0 {
			return m, nil, true
		}
		m.pickCursor = (m.pickCursor - 1 + len(m.rows)) % len(m.rows)
		return m, nil, true
	case "down", "j", "tab":
		if len(m.rows) == 0 {
			return m, nil, true
		}
		m.pickCursor = (m.pickCursor + 1) % len(m.rows)
		return m, nil, true
	case "home", "g":
		m.pickCursor = 0
		return m, nil, true
	case "end", "G":
		if len(m.rows) > 0 {
			m.pickCursor = len(m.rows) - 1
		}
		return m, nil, true
	case "enter", " ":
		if m.pickCursor < 0 || m.pickCursor >= len(m.rows) {
			return m, nil, true
		}
		target := m.rows[m.pickCursor]
		// Don't gate on row.refreshToken here — a row may have an
		// empty refreshToken because the API call was skipped (rate-
		// limit backoff) or failed transiently, even though the
		// underlying keychain entry is fine. executeSwap reads the
		// target's creds fresh from the keychain at swap time and
		// will return a real error if they're genuinely missing.
		if target.ConfigDir == m.activeDir {
			// Picking the row that's already active is a no-op but
			// also the natural "set this as my pin" gesture — record
			// it so rebalance-on-reset is suppressed going forward.
			m.manualPickDir = target.ConfigDir
			m.manualPickUtil = fiveHourUtil(target.Usage)
			m.picking = false
			m.flash = "pinned: " + accountLabel(target)
			m.flashExpiry = time.Now().Add(2 * time.Second)
			return m, flashClearCmd(2 * time.Second), true
		}
		m.picking = false
		m.manualSwapping = true
		m.flash = "swapping → " + accountLabel(target) + "…"
		m.flashExpiry = time.Now().Add(10 * time.Second)
		return m, m.manualSwapCmd(target), true
	}
	// Number keys jump the cursor to that row index (1-based for
	// keyboard ergonomics; row 1 is the first account).
	if s := msg.String(); len(s) == 1 && s[0] >= '1' && s[0] <= '9' {
		idx := int(s[0]-'1')
		if idx < len(m.rows) {
			m.pickCursor = idx
		}
		return m, nil, true
	}
	return m, nil, true
}

func (m *model) clampPickCursor() {
	if len(m.rows) == 0 {
		m.pickCursor = 0
		return
	}
	if m.pickCursor < 0 {
		m.pickCursor = 0
	}
	if m.pickCursor >= len(m.rows) {
		m.pickCursor = len(m.rows) - 1
	}
}

func (m model) indexOfActive() int {
	for i, r := range m.rows {
		if r.ConfigDir == m.activeDir {
			return i
		}
	}
	return 0
}

// ----------------------------------------------------------------------
// View
// ----------------------------------------------------------------------

func (m model) View() string {
	var b strings.Builder
	st := newStyles(true)

	b.WriteString(m.header(st))
	b.WriteString("\n")
	b.WriteString(m.table(st))
	b.WriteString(m.peakLine(st))
	switch {
	case m.editing:
		b.WriteString("\n")
		b.WriteString(m.editorView(st))
	case m.picking, m.showHelp:
		// Picker mode forces the help bar on so the picker controls
		// are always visible regardless of the [?] toggle.
		b.WriteString("\n")
		b.WriteString(m.helpBar(st))
	}
	return b.String()
}

func (m model) header(st styles) string {
	title := st.title.Render("claude-monitor")
	now := time.Now()

	var status string
	switch {
	case m.refreshing && m.lastRefresh.IsZero():
		status = st.dim.Render("loading…")
	case m.refreshing:
		status = st.accent.Render("refreshing…")
	case m.err != nil:
		status = st.errText.Render("error: " + m.err.Error())
	default:
		ago := now.Sub(m.lastRefresh).Truncate(time.Second)
		next := time.Duration(RefreshIntervalSeconds)*time.Second - ago
		if next < 0 {
			next = 0
		}
		status = st.dim.Render(fmt.Sprintf(
			"refreshed %s ago   next in %s   accounts: %d",
			ago, next.Truncate(time.Second), len(m.rows),
		))
	}

	flash := ""
	if m.flash != "" && time.Now().Before(m.flashExpiry) {
		flash = "   " + st.flash.Render(m.flash)
	}

	// Update banner sits between header and flash so it stays visible
	// even when transient flashes come and go.
	upd := ""
	switch {
	case m.upgrading:
		upd = "   " + st.accent.Render("upgrading…")
	case m.updateInfo != nil:
		upd = "   " + st.warn.Render(fmt.Sprintf("⬆ %s available — press [u]", m.updateInfo.LatestTag))
	}

	return st.headerBar.Render(title+"   "+status) + upd + flash
}

func (m model) table(st styles) string {
	if m.err != nil && len(m.rows) == 0 {
		return st.errText.Render("⚠ "+m.err.Error()) + "\n"
	}
	if len(m.rows) == 0 {
		return st.dim.Render("no accounts yet — fetching…\n")
	}

	bw := 25 // bar width
	header := []string{"ACCOUNT", "5H", "RESETS", "WEEKLY", "RESETS", "SONNET WK", "OPUS WK"}
	widths := []int{22, 8 + bw + 1, 10, 8 + bw + 1, 10, 9, 9}

	var b strings.Builder
	b.WriteString(writeCols(header, widths, &st.colHeader))
	b.WriteString(st.divider.Render(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")

	now := time.Now()
	for i, r := range m.rows {
		// Live-countdown override: even if the row carries an old
		// "rate limited" error string, prefer the deadline from the
		// backoff map so the seconds tick down on screen.
		if until, ok := m.backoff[r.ConfigDir]; ok && now.Before(until) {
			remaining := until.Sub(now).Round(time.Second)
			label := m.decorateLabel(st, i, r, accountLabel(r))
			msg := fmt.Sprintf("rate limited (retry in %s)", remaining)
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + st.warn.Render(msg)
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		if r.Err != nil {
			label := m.decorateLabel(st, i, r, accountLabel(r))
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + st.errText.Render(truncate(r.Err.Error(), m.width-widths[0]-4))
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		u := r.Usage
		cells := []string{
			st.account.Render(m.decorateLabel(st, i, r, accountLabel(r))),
			renderBarPct(st, fiveHourUtil(u), bw),
			renderResetsAt(st, getResets(u.FiveHour), now),
			renderBarPct(st, getUtil(u.SevenDay), bw),
			renderResetsAt(st, getResets(u.SevenDay), now),
			renderPctOnly(st, u.SevenDaySonnet),
			renderPctOnly(st, u.SevenDayOpus),
		}
		row := writeCols(cells, widths, nil)
		// trim trailing newline from writeCols so we can append the kick suffix
		row = strings.TrimRight(row, "\n")
		if r.Kicked {
			row += "  " + st.kicked.Render("[kicked]")
		} else if r.KickErr != nil {
			row += "  " + st.errText.Render("[kick failed: "+truncate(r.KickErr.Error(), 60)+"]")
		}
		b.WriteString(row)
		b.WriteString("\n")
	}
	b.WriteString(st.divider.Render(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")
	return b.String()
}

func (m model) peakLine(st styles) string {
	var peak5h, peakWk float64
	have := 0
	for _, r := range m.rows {
		if r.Err != nil || r.Usage == nil {
			continue
		}
		have++
		if u := fiveHourUtil(r.Usage); u > peak5h {
			peak5h = u
		}
		if u := getUtil(r.Usage.SevenDay); u > peakWk {
			peakWk = u
		}
	}
	if have == 0 {
		return ""
	}
	return st.peak.Render(fmt.Sprintf(
		"PEAK across %d account(s):  5h %s   weekly %s",
		have, fmtPct(peak5h), fmtPct(peakWk),
	)) + "\n"
}

func (m model) helpBar(st styles) string {
	if m.picking {
		hint := fmt.Sprintf("%s pick   %s confirm   %s cancel",
			st.key.Render("↑/↓"), st.key.Render("[enter]"), st.key.Render("[esc]"))
		if m.pickCursor >= 0 && m.pickCursor < len(m.rows) {
			label := accountLabel(m.rows[m.pickCursor])
			hint = st.accent.Render("▶ "+label) + "   " + hint
		}
		return st.helpBar.Render(hint)
	}
	parts := []string{
		fmt.Sprintf("%s auto-kick: %s", st.key.Render("[k]"), boolBadge(st, m.cfg.AutoKick)),
		fmt.Sprintf("%s auto-swap: %s", st.key.Render("[s]"), boolBadge(st, m.cfg.AutoSwap)),
		st.key.Render("[m]") + " switch",
		st.key.Render("[e]") + " edit",
		st.key.Render("[r]") + " refresh",
		st.key.Render("[?]") + " toggle help",
		st.key.Render("[q]") + " quit",
	}
	// [u] is intentionally hidden when no update is advertised; surface
	// it (prepended so it leads the row) only when CheckForUpdate
	// returned a non-nil UpdateInfo.
	if m.updateInfo != nil && !m.upgrading {
		parts = append([]string{
			fmt.Sprintf("%s upgrade %s", st.key.Render("[u]"), m.updateInfo.LatestTag),
		}, parts...)
	}
	// Pin indicator: when a manual pick is in effect, surface its
	// label so the user remembers why their high-util account isn't
	// being auto-rebalanced away.
	if m.manualPickDir != "" {
		if r := findRow(m.rows, m.manualPickDir); r != nil {
			parts = append(parts, st.accent.Render("📌 pin: "+accountLabel(*r)))
		}
	}
	return st.helpBar.Render(strings.Join(parts, "   "))
}

// ----------------------------------------------------------------------
// Cell rendering
// ----------------------------------------------------------------------

func renderBarPct(st styles, pct float64, width int) string {
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	filled := int(pct / 100 * float64(width))
	if filled > width {
		filled = width
	}
	bar := strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
	var colored string
	switch {
	case pct >= 90:
		colored = st.barRed.Render(bar)
	case pct >= 70:
		colored = st.barYellow.Render(bar)
	case pct >= 1:
		colored = st.barGreen.Render(bar)
	default:
		colored = st.dim.Render(bar)
	}
	return fmt.Sprintf("%s %s", fmtPct(pct), colored)
}

func renderResetsAt(st styles, t *time.Time, now time.Time) string {
	if t == nil {
		return st.dim.Render("—")
	}
	d := t.Sub(now)
	if d < 0 {
		return st.dim.Render("now")
	}
	switch {
	case d < time.Hour:
		return st.warn.Render(fmt.Sprintf("in %dm", int(d.Minutes())))
	case d < 24*time.Hour:
		return fmt.Sprintf("in %dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		days := int(d.Hours()) / 24
		hrs := int(d.Hours()) % 24
		return fmt.Sprintf("in %dd%dh", days, hrs)
	}
}

func renderPctOnly(st styles, w *Window) string {
	if w == nil {
		return st.dim.Render("—")
	}
	if w.Utilization == 0 {
		return st.dim.Render(fmtPct(0))
	}
	s := fmtPct(w.Utilization)
	switch {
	case w.Utilization >= 90:
		return st.barRed.Render(s)
	case w.Utilization >= 70:
		return st.barYellow.Render(s)
	default:
		return st.barGreen.Render(s)
	}
}

func writeCols(cells []string, widths []int, headerStyle *lipgloss.Style) string {
	var b strings.Builder
	for i, cell := range cells {
		if i > 0 {
			b.WriteString("  ")
		}
		val := cell
		if headerStyle != nil {
			val = headerStyle.Render(cell)
		}
		b.WriteString(padRight(val, widths[i]))
	}
	b.WriteString("\n")
	return b.String()
}

func sumWidths(w []int) int {
	s := 0
	for _, x := range w {
		s += x
	}
	return s
}

func accountLabel(r AccountUsage) string {
	if r.Email != "" {
		return r.Email
	}
	return r.Name
}

// decorateLabel prefixes a marker to the label of whichever row is
// noteworthy: ▶ for the [m] picker cursor, ★ for the row that owns
// the plain keychain slot. When the active row is also a manual pin,
// ★ is rendered in the accent color instead of the kicked color so
// the user can see at a glance that auto-rebalance is suppressed.
func (m model) decorateLabel(st styles, idx int, r AccountUsage, label string) string {
	if m.picking && idx == m.pickCursor {
		return st.accent.Render("▶ ") + label
	}
	if r.ConfigDir != "" && r.ConfigDir == m.activeDir {
		marker := st.kicked.Render("★ ")
		if r.ConfigDir == m.manualPickDir {
			marker = st.accent.Render("★ ")
		}
		return marker + label
	}
	return "  " + label
}

func getUtil(w *Window) float64 {
	if w == nil {
		return 0
	}
	return w.Utilization
}

func getResets(w *Window) *time.Time {
	if w == nil {
		return nil
	}
	return w.ResetsAt
}

func fmtPct(p float64) string {
	return fmt.Sprintf("%3.0f%%", p)
}

func onOff(b bool) string {
	if b {
		return "ON"
	}
	return "OFF"
}

func boolBadge(st styles, b bool) string {
	if b {
		return st.on.Render("ON")
	}
	return st.off.Render("OFF")
}

// ----------------------------------------------------------------------
// Styles
// ----------------------------------------------------------------------

type styles struct {
	title     lipgloss.Style
	headerBar lipgloss.Style
	colHeader lipgloss.Style
	account   lipgloss.Style
	divider   lipgloss.Style
	dim       lipgloss.Style
	accent    lipgloss.Style
	errText   lipgloss.Style
	warn      lipgloss.Style
	flash     lipgloss.Style
	barGreen  lipgloss.Style
	barYellow lipgloss.Style
	barRed    lipgloss.Style
	kicked    lipgloss.Style
	peak      lipgloss.Style
	helpBar   lipgloss.Style
	key       lipgloss.Style
	value     lipgloss.Style
	on        lipgloss.Style
	off       lipgloss.Style
}

// newStyles builds a palette that respects the user's color toggle. When
// color is off, every style is reset to the no-op default, which lipgloss
// renders as plain text.
func newStyles(color bool) styles {
	var s styles
	s.title = lipgloss.NewStyle().Bold(true)
	s.headerBar = lipgloss.NewStyle().Padding(0, 1)
	s.colHeader = lipgloss.NewStyle().Bold(true)
	s.account = lipgloss.NewStyle().Bold(true)
	s.divider = lipgloss.NewStyle()
	s.dim = lipgloss.NewStyle()
	s.accent = lipgloss.NewStyle()
	s.errText = lipgloss.NewStyle()
	s.warn = lipgloss.NewStyle()
	s.flash = lipgloss.NewStyle()
	s.barGreen = lipgloss.NewStyle()
	s.barYellow = lipgloss.NewStyle()
	s.barRed = lipgloss.NewStyle()
	s.kicked = lipgloss.NewStyle()
	s.peak = lipgloss.NewStyle().Bold(true)
	s.helpBar = lipgloss.NewStyle().Padding(0, 1)
	s.key = lipgloss.NewStyle().Bold(true)
	s.value = lipgloss.NewStyle()
	s.on = lipgloss.NewStyle()
	s.off = lipgloss.NewStyle()

	if !color {
		return s
	}

	// Adaptive colors so we don't blow out either light or dark themes.
	c := func(dark, light string) lipgloss.AdaptiveColor {
		return lipgloss.AdaptiveColor{Dark: dark, Light: light}
	}

	s.title = s.title.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.headerBar = s.headerBar.
		Foreground(c("#FAFAFA", "#1F1F1F")).
		Background(c("#5A4FCF", "#E0DCFF"))
	s.colHeader = s.colHeader.Foreground(c("#A6ADC8", "#4C566A"))
	s.account = s.account.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.divider = s.divider.Foreground(c("#3B3F45", "#D8DEE9"))
	s.dim = s.dim.Foreground(c("#7A828F", "#9097A1"))
	s.accent = s.accent.Foreground(c("#7AA2F7", "#3B6EE0"))
	s.errText = s.errText.Foreground(c("#F38BA8", "#B33A55"))
	s.warn = s.warn.Foreground(c("#F9E2AF", "#B58900"))
	s.flash = s.flash.Foreground(c("#1F1F1F", "#FAFAFA")).
		Background(c("#A6E3A1", "#3FA776")).Padding(0, 1).Bold(true)
	s.barGreen = s.barGreen.Foreground(c("#A6E3A1", "#3FA776"))
	s.barYellow = s.barYellow.Foreground(c("#F9E2AF", "#B58900"))
	s.barRed = s.barRed.Foreground(c("#F38BA8", "#B33A55"))
	s.kicked = s.kicked.Foreground(c("#A6E3A1", "#3FA776")).Bold(true)
	s.peak = s.peak.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.helpBar = s.helpBar.
		Foreground(c("#A6ADC8", "#4C566A")).
		Background(c("#1F2335", "#EDEEF2"))
	s.key = s.key.Foreground(c("#7AA2F7", "#3B6EE0")).Bold(true)
	s.value = s.value.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.on = s.on.Foreground(c("#A6E3A1", "#3FA776")).Bold(true)
	s.off = s.off.Foreground(c("#7A828F", "#9097A1"))
	return s
}
