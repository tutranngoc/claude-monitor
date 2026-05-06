package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
)

// runeKey synthesizes a printable-character keystroke. Bubble Tea
// dispatches printable input via msg.Type=KeyRunes + msg.Runes; the
// helper just keeps the call sites readable.
func runeKey(r rune) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}}
}

func TestHandleAddKeyTypingPopulatesNameAndPreviewsValidation(t *testing.T) {
	m := model{addingAccount: true}
	for _, r := range []rune{'a', '/', 'b'} {
		next, _, consumed := m.handleAddKey(runeKey(r))
		if !consumed {
			t.Fatalf("rune %q should be consumed", r)
		}
		m = next
	}
	if m.addState.nameBuf != "a/b" {
		t.Errorf("nameBuf = %q, want %q", m.addState.nameBuf, "a/b")
	}
	if m.addState.nameErr == "" {
		t.Errorf("expected validation error after typing slash, got empty")
	}
}

func TestHandleAddKeyTabAdvancesToEmail(t *testing.T) {
	m := model{addingAccount: true}
	next, _, _ := m.handleAddKey(tea.KeyMsg{Type: tea.KeyTab})
	if next.addState.cursor != addFieldEmail {
		t.Errorf("after tab cursor = %v, want %v", next.addState.cursor, addFieldEmail)
	}
	next, _, _ = next.handleAddKey(runeKey('x'))
	if next.addState.emailBuf != "x" {
		t.Errorf("emailBuf = %q, want %q", next.addState.emailBuf, "x")
	}
	if next.addState.nameBuf != "" {
		t.Errorf("nameBuf leaked: %q", next.addState.nameBuf)
	}
}

func TestHandleAddKeyEscClosesForm(t *testing.T) {
	m := model{addingAccount: true, addState: addState{nameBuf: "foo"}}
	next, _, consumed := m.handleAddKey(tea.KeyMsg{Type: tea.KeyEsc})
	if !consumed {
		t.Fatalf("esc must be consumed")
	}
	if next.addingAccount {
		t.Errorf("addingAccount should be cleared")
	}
	if next.addState.nameBuf != "" {
		t.Errorf("addState should be reset, got nameBuf=%q", next.addState.nameBuf)
	}
}

func TestSubmitInvalidNameSurfacesError(t *testing.T) {
	m := model{addingAccount: true}
	m.addState.nameBuf = ""
	next, cmd, _ := m.submitAddAccount()
	if cmd != nil {
		t.Errorf("expected no cmd on invalid submit, got %v", cmd)
	}
	if !next.addingAccount {
		t.Errorf("form should stay open on validation failure")
	}
	if !strings.Contains(next.addState.nameErr, "required") {
		t.Errorf("expected 'required' error, got %q", next.addState.nameErr)
	}
}

func TestHandleKeyAOpensAddFormWhenIdle(t *testing.T) {
	m := model{}
	next, _ := m.handleKey(runeKey('a'))
	mm := next.(model)
	if !mm.addingAccount {
		t.Errorf("[a] should open add form when idle")
	}
}

func TestHandleKeyARefusedDuringOtherOverlays(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*model)
	}{
		{"editing", func(m *model) { m.editing = true }},
		{"picking", func(m *model) { m.picking = true }},
		{"manualSwapping", func(m *model) { m.manualSwapping = true }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			m := model{}
			tt.mut(&m)
			next, _ := m.handleKey(runeKey('a'))
			mm := next.(model)
			if mm.addingAccount {
				t.Errorf("[a] should be blocked while %s", tt.name)
			}
		})
	}
}

func TestHandleKeyLOpensReloginPicker(t *testing.T) {
	m := model{rows: []account.Row{{Name: "foo", ConfigDir: "/tmp/foo"}}}
	next, _ := m.handleKey(runeKey('L'))
	mm := next.(model)
	if !mm.picking {
		t.Errorf("[L] should open picker")
	}
	if mm.pickerMode != pickerRelogin {
		t.Errorf("[L] should set pickerMode=relogin, got %v", mm.pickerMode)
	}
}

func TestHandleKeyMOpensSwapPicker(t *testing.T) {
	m := model{rows: []account.Row{{Name: "foo", ConfigDir: "/tmp/foo"}}}
	next, _ := m.handleKey(runeKey('m'))
	mm := next.(model)
	if !mm.picking {
		t.Errorf("[m] should open picker")
	}
	if mm.pickerMode != pickerSwap {
		t.Errorf("[m] should set pickerMode=swap, got %v", mm.pickerMode)
	}
}
