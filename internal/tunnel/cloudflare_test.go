package tunnel

import (
	"strings"
	"testing"
)

// TestURLRegex pins the parser to actual log-line shapes cloudflared
// has emitted in the wild. If cloudflared changes its banner again
// (it has, more than once), this test fails first and we update the
// regex without playing whack-a-mole in production.
func TestURLRegex(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "boxed banner",
			in:   "2024-01-01T12:00:00Z INF |  https://thirsty-window-0123.trycloudflare.com  |",
			want: "https://thirsty-window-0123.trycloudflare.com",
		},
		{
			name: "json log line",
			in:   `{"level":"info","time":"2024","message":"... https://shy-river-9999.trycloudflare.com ..."}`,
			want: "https://shy-river-9999.trycloudflare.com",
		},
		{
			name: "subdomain with multiple hyphens",
			in:   "  Visit https://red-chef-storm-42.trycloudflare.com to view your tunnel",
			want: "https://red-chef-storm-42.trycloudflare.com",
		},
		{
			name: "no match — wrong domain",
			in:   "https://example.com/something/trycloudflare",
			want: "",
		},
		{
			name: "no match — bare hostname",
			in:   "trycloudflare.com is the parent",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ""
			if m := urlRe.FindString(tc.in); m != "" {
				got = m
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// TestScanCapturesFirstURL emulates cloudflared printing the URL once
// in stderr; we then verify Tunnel.Status surfaces it. Doesn't spawn
// a real subprocess — drives scan() directly with a piped reader.
func TestScanCapturesFirstURL(t *testing.T) {
	tu := New("cloudflared")
	tu.running = true // pretend Start succeeded so URL writes aren't skipped
	r := strings.NewReader(
		"some startup noise\n" +
			"2024-01-01T12:00:00Z INF |  https://shy-river-9999.trycloudflare.com  |\n" +
			"and a second URL https://other-name-1234.trycloudflare.com that should be ignored\n",
	)
	tu.scan(r, nil)
	if got := tu.Status().URL; got != "https://shy-river-9999.trycloudflare.com" {
		t.Fatalf("got %q, want first match", got)
	}
}
