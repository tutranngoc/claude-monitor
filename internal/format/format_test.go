package format

import "testing"

func TestTruncate(t *testing.T) {
	tests := []struct {
		name string
		s    string
		max  int
		want string
	}{
		{"max zero returns empty", "hello", 0, ""},
		{"max negative returns empty", "hello", -3, ""},
		{"shorter than max returned as-is", "hi", 5, "hi"},
		{"equal to max returned as-is", "hello", 5, "hello"},
		{"longer than max gets ellipsis", "hello world", 5, "hell…"},
		{"max 1 returns just ellipsis", "abcdef", 1, "…"},
		{"max 2 keeps first byte plus ellipsis", "abcdef", 2, "a…"},
		{"empty string passes through", "", 5, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Truncate(tt.s, tt.max); got != tt.want {
				t.Errorf("Truncate(%q, %d) = %q, want %q", tt.s, tt.max, got, tt.want)
			}
		})
	}
}

// TestTruncateByteSemantics documents the current behavior: Truncate
// operates on bytes, not runes, despite the docstring saying "runes".
// Multi-byte UTF-8 input *can* be sliced mid-rune. This test pins the
// behavior so a future fix is intentional, not accidental.
func TestTruncateByteSemantics(t *testing.T) {
	// "héllo" — é is two bytes (0xc3 0xa9). Bytes: h, 0xc3, 0xa9, l, l, o (6 bytes).
	// max=4 keeps first 3 bytes (h, 0xc3, 0xa9) plus ellipsis → "hé…".
	got := Truncate("héllo", 4)
	want := "hé…"
	if got != want {
		t.Errorf("Truncate byte-mode: got %q, want %q", got, want)
	}
}
