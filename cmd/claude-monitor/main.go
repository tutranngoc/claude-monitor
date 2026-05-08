package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/config"
	"claude-monitor/internal/keychain"
	"claude-monitor/internal/server"
	"claude-monitor/internal/swap"
	"claude-monitor/internal/tui"
	"claude-monitor/internal/update"
	webx "claude-monitor/internal/web"
)

var (
	flagRoot = flag.String("root", "",
		"Account search path. Empty = auto-discover ~/.claude* in $HOME. "+
			"Otherwise a comma-separated list of paths; each path can be a single "+
			"Claude config dir or a parent directory containing several.")
	flagVersion = flag.Bool("version", false, "Print version and exit")
	flagUpgrade = flag.Bool("upgrade", false, "Download and install the latest release, then exit")
	flagSwapTo  = flag.String("swap-to", "",
		"Rewrite the default keychain slot to the given account (by name, email, or config dir) and exit. "+
			"Lets a `/switch-account` slash command flip the running `claude` tab to a different account.")
	flagListAccounts = flag.Bool("list-accounts", false,
		"Print discovered accounts (name, email, 5h utilization, active marker) and exit.")
	flagKeychainSetup = flag.Bool("keychain-setup", false,
		"Re-register claude-monitor with the macOS keychain so account swaps don't prompt for "+
			"a password every time. Asks for your macOS user password once (not stored). "+
			"No-op on Linux/Windows.")
	flagServe = flag.String("serve", "",
		"Daemon-only mode: bind an HTTP+SSE API at the given address (e.g. 127.0.0.1:8788) "+
			"for an external UI to consume, no web subprocess, no TUI.")
	flagTui = flag.Bool("tui", false,
		"Run the legacy terminal dashboard instead of the web orchestrator.")
	flagDaemonAddr = flag.String("daemon-addr", "127.0.0.1:8788",
		"Bind address for the daemon HTTP+SSE API used by the web orchestrator.")
	flagWebPort = flag.Int("web-port", 3737,
		"Port the spawned Next.js web orchestrator binds to (127.0.0.1).")
	flagWebDir = flag.String("web-dir", "",
		"Path to the web/ directory. Empty = auto-discover relative to the binary.")
	flagNoOpen = flag.Bool("no-open", false,
		"Don't open the web orchestrator URL in the default browser on startup.")
	flagNoWeb = flag.Bool("no-web", false,
		"Run only the daemon (skip spawning the Next.js web orchestrator). "+
			"Equivalent to --serve $daemon-addr but keeps the convenient defaults.")
)

// version is wired by ldflags via the Makefile.
var version = "dev"

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr,
			"claude-monitor — orchestrate multiple Claude Code OAuth accounts.\n\n"+
				"Default mode boots an in-process daemon (--daemon-addr) and spawns the\n"+
				"Next.js web orchestrator (--web-port), then opens it in your browser.\n"+
				"Pass --tui for the legacy terminal dashboard, --serve for daemon-only.\n\n"+
				"Usage:\n  %s [flags]\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if *flagVersion {
		fmt.Println(version)
		return
	}

	if *flagUpgrade {
		if err := runUpgrade(); err != nil {
			die("upgrade failed: %v", err)
		}
		return
	}

	if *flagListAccounts {
		if err := swap.ListAccounts(*flagRoot); err != nil {
			die("%v", err)
		}
		return
	}

	if *flagSwapTo != "" {
		if err := swap.To(*flagRoot, *flagSwapTo); err != nil {
			die("%v", err)
		}
		return
	}

	cfg, _ := config.Load() // missing/corrupt → defaults; not fatal

	if *flagServe != "" {
		if err := runServe(*flagServe, *flagRoot, cfg); err != nil {
			die("daemon: %v", err)
		}
		return
	}

	if *flagKeychainSetup {
		if err := keychain.RunSetup(discoverConfigDirs(*flagRoot)); err != nil {
			die("%v", err)
		}
		cfg.KeychainSetupDone = true
		_ = config.Save(cfg)
		return
	}

	// Clean up <exe>.old / <exe>.new from prior upgrades — Windows
	// can't remove them while the running process holds them.
	update.CleanupStaleArtifacts()

	// One-shot keychain registration on the first launch so future
	// swaps don't pop a password prompt every time. RunSetup is a
	// no-op on Linux/Windows (no partition list to update) and
	// short-circuits on darwin if stdin isn't a TTY or there are no
	// accounts yet. We always set the flag afterwards, even on
	// skip/failure, so the user isn't re-prompted on every launch —
	// they can rerun the bootstrap explicitly via --keychain-setup.
	if !cfg.KeychainSetupDone {
		_ = keychain.RunSetup(discoverConfigDirs(*flagRoot))
		cfg.KeychainSetupDone = true
		_ = config.Save(cfg)
	}

	if *flagTui {
		runTui(cfg)
		return
	}

	if err := runWebOrchestrator(*flagDaemonAddr, *flagWebPort, *flagWebDir, !*flagNoOpen, !*flagNoWeb, *flagRoot, cfg); err != nil {
		die("orchestrator: %v", err)
	}
}

// discoverConfigDirs is a thin caller-side helper around
// account.ResolveDirs so keychain.RunSetup stays a leaf (no account
// import). Returns nil when discovery fails, matching the behavior
// keychain.RunSetup expects (treats empty as "skip silently").
func discoverConfigDirs(rootSpec string) []string {
	accts, err := account.ResolveDirs(rootSpec)
	if err != nil || len(accts) == 0 {
		return nil
	}
	dirs := make([]string, len(accts))
	for i, a := range accts {
		dirs[i] = a.ConfigDir
	}
	return dirs
}

// runServe boots the daemon and blocks until SIGINT/SIGTERM. The
// keychain-setup bootstrap that gates TUI startup is intentionally
// skipped here — interactive password prompting doesn't fit a
// long-running headless daemon. Run `claude-monitor --keychain-setup`
// once before starting the daemon if swap prompts get noisy.
func runServe(addr, rootSpec string, cfg config.Config) error {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	srv := server.New(rootSpec, cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return srv.Start(ctx, addr)
}

// runTui is the legacy terminal dashboard, behind --tui. It does its
// own swap.FetchAll ticker (no daemon), so don't pair it with the
// default daemon+web mode — both would race on the keychain.
func runTui(cfg config.Config) {
	webURL := fmt.Sprintf("http://localhost:%d/", *flagWebPort)
	restart, err := tui.Run(*flagRoot, cfg, version, webURL)
	if err != nil {
		die("tui error: %v", err)
	}
	if restart {
		if err := update.RestartSelf(); err != nil {
			fmt.Fprintf(os.Stderr, "auto-restart failed: %v\nrun `claude-monitor` to use the new version.\n", err)
		}
	}
}

// runWebOrchestrator is the new default mode. It runs the Go daemon in
// a goroutine on the loopback addr, spawns the Next.js web server as a
// child process, optionally opens the user's browser, and blocks until
// either SIGINT/SIGTERM or one of the children dies. On signal, both
// children get a chance to exit gracefully (5s).
func runWebOrchestrator(daemonAddr string, webPort int, webDir string, openBrowser, withWeb bool, rootSpec string, cfg config.Config) error {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	srv := server.New(rootSpec, cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	daemonErr := make(chan error, 1)
	go func() { daemonErr <- srv.Start(ctx, daemonAddr) }()

	// Probe daemon health quickly — if it failed to bind (port taken),
	// surfacing the error here is much friendlier than letting the web
	// child come up first and then 502 every request.
	daemonURL := "http://" + daemonAddr
	if err := waitForHealth(ctx, daemonURL+"/api/health", 5*time.Second); err != nil {
		stop()
		<-daemonErr
		return fmt.Errorf("daemon failed to start at %s: %w", daemonAddr, err)
	}
	fmt.Fprintf(os.Stderr, "daemon → %s\n", daemonURL)

	if !withWeb {
		// --no-web: behave like --serve but keep the convenience defaults.
		fmt.Fprintf(os.Stderr, "(web orchestrator skipped — --no-web)\n")
		return <-daemonErr
	}

	cmd, webURL, err := webx.Launch(ctx, webx.Options{
		Port:      webPort,
		DaemonURL: daemonURL,
		WebDir:    webDir,
	})
	if err != nil {
		stop()
		<-daemonErr
		return fmt.Errorf("launch web: %w", err)
	}
	fmt.Fprintf(os.Stderr, "web    → %s\n", webURL)

	webExit := make(chan error, 1)
	go func() { webExit <- cmd.Wait() }()

	if openBrowser {
		// Wait for next.js to print "Ready" before launching the browser
		// so we don't race the bind. 1.5s is empirically enough on M1
		// for a warm-cache `next start`.
		go func() {
			select {
			case <-time.After(1500 * time.Millisecond):
				_ = webx.OpenBrowser(webURL)
			case <-ctx.Done():
			}
		}()
	}

	select {
	case <-ctx.Done():
		// Polite SIGINT to next, then escalate after 5s.
		if cmd.Process != nil {
			_ = cmd.Process.Signal(os.Interrupt)
		}
		select {
		case <-webExit:
		case <-time.After(5 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			<-webExit
		}
		return <-daemonErr
	case err := <-daemonErr:
		// Daemon died unexpectedly; pull web down too.
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-webExit
		return fmt.Errorf("daemon exited: %w", err)
	case err := <-webExit:
		// Web died (e.g. port collision or crash). Stop the daemon.
		stop()
		dErr := <-daemonErr
		if err != nil {
			return fmt.Errorf("web exited: %w", err)
		}
		return dErr
	}
}

// waitForHealth polls /api/health on the daemon URL until it answers
// 200 or the deadline elapses. The daemon's first refresh can take up
// to 30s on networks where /api/oauth/usage is slow, so we check the
// /health route specifically — it's served before the first refresh
// completes.
func waitForHealth(ctx context.Context, url string, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	client := &http.Client{Timeout: 500 * time.Millisecond}
	for {
		req, err := http.NewRequestWithContext(deadline, http.MethodGet, url, nil)
		if err == nil {
			res, err := client.Do(req)
			if err == nil {
				_ = res.Body.Close()
				if res.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
		select {
		case <-deadline.Done():
			if errors.Is(deadline.Err(), context.DeadlineExceeded) {
				return errors.New("timed out waiting for /api/health")
			}
			return deadline.Err()
		case <-tick.C:
		}
	}
}

func runUpgrade() error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	info, err := update.FetchLatest(ctx)
	if err != nil {
		return err
	}
	if !update.IsNewer(info.LatestTag, version) {
		fmt.Printf("already on latest (%s)\n", version)
		return nil
	}
	fmt.Printf("upgrading %s → %s\n", version, info.LatestTag)
	if err := update.Perform(ctx, info); err != nil {
		return err
	}
	fmt.Printf("✓ upgraded to %s\n", info.LatestTag)
	return nil
}

func die(format string, a ...any) {
	if !strings.HasSuffix(format, "\n") {
		format += "\n"
	}
	fmt.Fprintf(os.Stderr, format, a...)
	os.Exit(1)
}
