package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"claude-monitor/internal/config"
)

// LANStatus mirrors web.Status but lives in the server package so we
// don't pull internal/web into clients that just want to consume the
// API shape. Keep field names + JSON tags in lock-step with web.Status
// — TS types in web/lib/daemon.ts pin to these.
type LANStatus struct {
	Enabled bool   `json:"enabled"`
	Host    string `json:"host"`
	LANIP   string `json:"lan_ip,omitempty"`
	Port    int    `json:"port"`
	Token   string `json:"token,omitempty"`
	URL     string `json:"url,omitempty"`
	LANURL  string `json:"lan_url,omitempty"`
	Pending bool   `json:"pending,omitempty"`
}

// LANController is the contract the orchestrator implements so the
// daemon can flip the Next.js child between loopback and LAN bind
// without importing internal/web (avoiding a cycle: web depends on
// nothing daemon-shaped, and the daemon stays free of subprocess
// management code).
//
// All methods may be called concurrently. Enable returns the new
// status once the new Next.js child is live; Disable likewise. Status
// is a cheap snapshot, never blocks.
type LANController interface {
	Status() LANStatus
	Enable(ctx context.Context, token string) (LANStatus, error)
	Disable(ctx context.Context) (LANStatus, error)
	// WriteQR renders the current LAN URL as a QR (format implementation-
	// defined; today: SVG) so the daemon doesn't need to import a QR
	// library directly. Returns an error if LAN is disabled.
	WriteQR(w io.Writer) error
}

// SetLANController wires a controller into the server after construction.
// Optional — daemon-only mode (`--serve`) leaves it nil and the
// /api/lan/* endpoints reply 501.
func (s *Server) SetLANController(c LANController) {
	s.mu.Lock()
	s.lanCtrl = c
	s.mu.Unlock()
}

func (s *Server) handleLANStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.lanCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "LAN toggle requires the web orchestrator (not available in --serve mode)",
		})
		return
	}
	writeJSON(w, http.StatusOK, ctrl.Status())
}

func (s *Server) handleLANEnable(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.lanCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "LAN toggle requires the web orchestrator (not available in --serve mode)",
		})
		return
	}
	var body struct {
		Token string `json:"token,omitempty"`
	}
	// Empty body is valid (auto-generate). Decode errors only fail when
	// content was sent but malformed.
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	// Hard cap so a stuck Next.js startup doesn't pin the request
	// indefinitely. Next.js cold-start on a stock M1 is ~700ms; 15s
	// covers a slow disk + pnpm-hoisted load.
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	status, err := ctrl.Enable(ctx, body.Token)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Persist so the next boot keeps LAN on with the same token —
	// existing QR codes / bookmarks survive a process restart.
	s.persistLANState(true, status.Token)
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleLANDisable(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.lanCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "LAN toggle requires the web orchestrator (not available in --serve mode)",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	status, err := ctrl.Disable(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Disable clears the persisted token: next enable rotates it.
	// Trades a tiny bit of UX (re-share the new QR) for a reduced
	// blast radius if the user disables because they suspect leakage.
	s.persistLANState(false, "")
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleLANQR(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.lanCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		http.Error(w, "LAN toggle requires the web orchestrator", http.StatusNotImplemented)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	// Cache-bust on every render: token rotation between disable→enable
	// would otherwise serve a stale QR pointing at a dead URL.
	w.Header().Set("Cache-Control", "no-store")
	if err := ctrl.WriteQR(w); err != nil {
		// If LAN is off, return 409 — the UI should show "enable LAN
		// first" rather than a broken image.
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
}

// persistLANState writes the LAN toggle to ~/.claude-monitor/config.json.
// Errors get logged at warn — the toggle still took effect for this
// session, the user can re-enable on next launch if persistence fails.
func (s *Server) persistLANState(enabled bool, token string) {
	s.mu.Lock()
	s.cfg.LANEnabled = enabled
	s.cfg.LANToken = token
	cfg := s.cfg
	s.mu.Unlock()
	if err := config.Save(cfg); err != nil {
		s.logger.Warn("persist LAN state failed", "error", err)
	}
}
