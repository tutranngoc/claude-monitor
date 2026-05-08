package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"claude-monitor/internal/account"
)

// handleAccountLogin spawns Terminal.app with `claude auth login` scoped
// to the given account's CLAUDE_CONFIG_DIR. The OAuth flow is interactive
// (the binary prints a URL and waits for paste-back), so we need a real
// pty — the daemon process has no tty of its own. macOS-only for now.
func (s *Server) handleAccountLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Ident string `json:"ident"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	if body.Ident == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ident is required"})
		return
	}
	s.mu.RLock()
	snap := s.snap
	s.mu.RUnlock()
	if snap == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no snapshot yet"})
		return
	}
	var configDir string
	for _, a := range snap.Accounts {
		if a.Name == body.Ident || a.ConfigDir == body.Ident {
			configDir = a.ConfigDir
			break
		}
	}
	if configDir == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "account not found: " + body.Ident})
		return
	}
	if err := launchLoginTerminal(configDir, ""); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config_dir": configDir})
}

// handleAccountAdd provisions ~/.claude-<name> then launches the same
// terminal-based login flow. The next ticker refresh picks up the new
// dir via auto-discovery; we also kick a refresh so the row appears
// immediately for the UI.
func (s *Server) handleAccountAdd(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Email string `json:"email,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	if err := account.ValidateName(body.Name); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	dir, err := account.Provision(body.Name)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if err := launchLoginTerminal(dir, body.Email); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.refreshOnce(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config_dir": dir, "name": body.Name})
}

// launchLoginTerminal writes a one-shot shell script that runs
// `claude auth login` with CLAUDE_CONFIG_DIR set, then opens it in
// Terminal.app. The script self-deletes via `rm -f -- "$0"` once
// claude exits, keeping /tmp clean.
func launchLoginTerminal(configDir, email string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("login flow currently macOS-only (GOOS=%s)", runtime.GOOS)
	}
	f, err := os.CreateTemp("", "claude-monitor-login-*.sh")
	if err != nil {
		return fmt.Errorf("create script: %w", err)
	}
	args := "auth login"
	if email != "" {
		args += " --email " + shellQuote(email)
	}
	script := fmt.Sprintf(
		"#!/bin/bash\nset +e\nCLAUDE_CONFIG_DIR=%s claude %s\nstatus=$?\nrm -f -- \"$0\"\nexit $status\n",
		shellQuote(configDir),
		args,
	)
	if _, err := f.WriteString(script); err != nil {
		f.Close()
		return fmt.Errorf("write script: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close script: %w", err)
	}
	if err := os.Chmod(f.Name(), 0o700); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}
	// `open -a Terminal <script>` respects user's default Terminal
	// (Terminal.app or whatever they've assigned). Start (not Run)
	// so the daemon doesn't block waiting for the user to finish.
	cmd := exec.Command("open", "-a", "Terminal", f.Name())
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open Terminal: %w", err)
	}
	return nil
}

// shellQuote single-quotes a string for safe inclusion in a bash
// command. Embedded single quotes are escaped via the standard
// '\'' trick so paths with apostrophes still work.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
