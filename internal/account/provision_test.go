package account

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr string // empty = no error, otherwise substring of the error
	}{
		{"ok plain", "foo", ""},
		{"ok hyphens", "acc-be-1", ""},
		{"ok underscores", "acc_be_1", ""},
		{"ok dots", "acc.work", ""},
		{"ok mixed", "Acc-1.2_x", ""},
		{"empty", "", "required"},
		{"slash", "foo/bar", "only letters"},
		{"backslash", `foo\bar`, "only letters"},
		{"space", "foo bar", "only letters"},
		{"colon", "foo:bar", "only letters"},
		{"double dot", "..", "reserved"},
		{"single dot", ".", "reserved"},
		{"too long", strings.Repeat("a", 51), "too long"},
		{"unicode", "café", "only letters"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateName(tt.input)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("ValidateName(%q) = %v, want nil", tt.input, err)
				}
				return
			}
			if err == nil {
				t.Errorf("ValidateName(%q) = nil, want error containing %q", tt.input, tt.wantErr)
				return
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("ValidateName(%q) = %v, want error containing %q", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestConfigDirForName(t *testing.T) {
	dir, err := ConfigDirForName("foo")
	if err != nil {
		t.Fatalf("ConfigDirForName: %v", err)
	}
	home, _ := os.UserHomeDir()
	want := filepath.Join(home, ".claude-foo")
	if dir != want {
		t.Errorf("got %q, want %q", dir, want)
	}

	if _, err := ConfigDirForName(""); err == nil {
		t.Errorf("expected error on empty name")
	}
}

func TestProvision(t *testing.T) {
	// Redirect HOME so we don't pollute the real one.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir, err := Provision("test-acct")
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if dir != filepath.Join(tmp, ".claude-test-acct") {
		t.Errorf("unexpected dir: %s", dir)
	}
	// Must be discoverable: projects/ subdir is enough for looksLikeClaudeDir.
	if _, err := os.Stat(filepath.Join(dir, "projects")); err != nil {
		t.Errorf("projects/ marker missing: %v", err)
	}
	if !looksLikeClaudeDir(dir) {
		t.Errorf("provisioned dir should pass looksLikeClaudeDir")
	}

	// Re-provision with the same name must refuse.
	if _, err := Provision("test-acct"); err == nil {
		t.Errorf("expected error on duplicate provision")
	}

	// Different name → different dir, no collision.
	dir2, err := Provision("other-acct")
	if err != nil {
		t.Fatalf("Provision other: %v", err)
	}
	if dir2 == dir {
		t.Errorf("two names produced the same dir")
	}
}
