// LAN exposure helpers used when the orchestrator binds the Next.js
// server beyond loopback so a phone on the same Wi-Fi can hit it.
//
// Auth token:
//   The Go daemon stays on 127.0.0.1; only the Next.js server faces the
//   LAN, and its proxy.ts gates every request behind a shared bearer
//   token. GenerateToken returns a URL-safe random string we both bake
//   into the env Next.js sees (MONITOR_AUTH_TOKEN) and embed in the
//   ?token=... query of the printed LAN URL so a single click/scan
//   unlocks the cookie.
//
// Local IP:
//   LocalIP picks the first non-loopback IPv4 from net.InterfaceAddrs.
//   That's typically the Wi-Fi/Ethernet RFC1918 address — exactly what
//   you'd type on a phone — but on multi-homed machines it can pick the
//   "wrong" interface. The user can override the printed URL with
//   --lan-ip when that happens.

package web

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
)

// GenerateToken returns a URL-safe random token. 16 bytes = 128 bits of
// entropy; raw URL encoding strips padding so the result drops cleanly
// into a query string without %-escapes.
func GenerateToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// LocalIP returns the first non-loopback IPv4 found among the host's
// interface addresses. Returns "" when nothing usable is found (e.g.
// fully airgapped) so callers can fall back to "127.0.0.1" + a warning.
//
// Prefers IPv4 because phone browsers don't always handle bracketed
// IPv6 hosts cleanly, and the typical home LAN is IPv4 anyway.
func LocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() {
			continue
		}
		ip4 := ipnet.IP.To4()
		if ip4 == nil {
			continue
		}
		return ip4.String()
	}
	return ""
}

// IsLoopbackHost reports whether host (a bind address sans port) routes
// only to the local machine. Used by the launcher to decide whether the
// auth gate is mandatory: a loopback bind is reachable only by local
// processes, so the existing trust model already covers it.
//
// "0.0.0.0" / "::" / "" are treated as non-loopback because they
// explicitly mean "all interfaces".
func IsLoopbackHost(host string) bool {
	if host == "" || host == "0.0.0.0" || host == "::" {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	// Hostnames like "localhost" — let the resolver decide.
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return false
	}
	for _, ip := range ips {
		if !ip.IsLoopback() {
			return false
		}
	}
	return true
}
