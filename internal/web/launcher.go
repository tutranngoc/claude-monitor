// Package web spawns the Next.js orchestrator as a subprocess of
// claude-monitor. The web build lives at <repo>/web/ alongside the
// daemon binary; we locate it relative to the running executable so
// `claude-monitor` works equally well from `./bin/` and from a copy
// installed under `~/bin/` (assuming the install kept the layout).
package web

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
)

// Options configure the spawned Next.js server. Hostname/Port match the
// flags Next's `next start` understands; DaemonURL is forwarded as
// DAEMON_INTERNAL_URL so the App Router proxy at /daemon/[...path]/
// can reach the in-process Go daemon.
type Options struct {
	Port      int
	Hostname  string
	DaemonURL string
	WebDir    string // optional override; empty = auto-discover.
}

// FindWebDir locates the web/ directory by walking up from the current
// binary path. Tries the dev layout (<repo>/bin/<exe> + <repo>/web)
// first, then a "share" install layout, then the current working
// directory as last resort.
func FindWebDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	binDir := filepath.Dir(exe)

	candidates := []string{
		// Repo: <repo>/bin/claude-monitor → <repo>/web
		filepath.Join(binDir, "..", "web"),
		// Install with sibling web/ directory: <prefix>/bin/claude-monitor → <prefix>/web
		filepath.Join(binDir, "web"),
		// Install under share: <prefix>/bin/claude-monitor → <prefix>/share/claude-monitor/web
		filepath.Join(binDir, "..", "share", "claude-monitor", "web"),
		// Last resort: the cwd has a web/ subdir.
		"web",
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		// We require both `.next/` (build output) and the next binary
		// shipped with node_modules. Either missing → not a usable build.
		if _, err := os.Stat(filepath.Join(abs, ".next")); err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(abs, "node_modules", "next", "dist", "bin", "next")); err != nil {
			continue
		}
		return abs, nil
	}
	return "", errors.New("web build not found; run `make build-web` first")
}

// Launch spawns `node node_modules/next/dist/bin/next start ...` from
// the resolved web directory. The caller owns the returned *exec.Cmd
// and is responsible for cmd.Wait()/cmd.Process.Kill(). Stdout/Stderr
// inherit from the parent so the user sees Next's startup banner.
func Launch(ctx context.Context, opts Options) (*exec.Cmd, string, error) {
	dir := opts.WebDir
	if dir == "" {
		var err error
		dir, err = FindWebDir()
		if err != nil {
			return nil, "", err
		}
	}
	if opts.Hostname == "" {
		opts.Hostname = "127.0.0.1"
	}
	if opts.Port == 0 {
		opts.Port = 3737
	}
	nextBin := filepath.Join(dir, "node_modules", "next", "dist", "bin", "next")
	if _, err := os.Stat(nextBin); err != nil {
		return nil, "", fmt.Errorf("next CLI not found at %s: %w", nextBin, err)
	}
	cmd := exec.CommandContext(ctx, "node", nextBin, "start",
		"-p", strconv.Itoa(opts.Port),
		"-H", opts.Hostname,
	)
	cmd.Dir = dir
	env := os.Environ()
	if opts.DaemonURL != "" {
		env = append(env, "DAEMON_INTERNAL_URL="+opts.DaemonURL)
	}
	// Pass PORT/HOSTNAME too so any code that reads them (e.g. Next's
	// internal logging) agrees with the CLI flags.
	env = append(env,
		"PORT="+strconv.Itoa(opts.Port),
		"HOSTNAME="+opts.Hostname,
		// Quiet Next's per-request log spam — daemon logs are enough.
		"NODE_ENV=production",
	)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("spawn next: %w", err)
	}
	url := fmt.Sprintf("http://%s:%d/", opts.Hostname, opts.Port)
	return cmd, url, nil
}

// OpenBrowser asks the OS to open a URL in the user's default browser.
// Errors are non-fatal (terminal-only environments, headless boxes); the
// caller should print the URL alongside so the user can click manually.
func OpenBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
	return cmd.Start()
}
