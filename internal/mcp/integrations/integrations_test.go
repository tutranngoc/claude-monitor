package integrations

import (
	"runtime"
	"strings"
	"testing"
)

func setupHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", dir)
	}
}

func TestValidate_NameRules(t *testing.T) {
	cases := []struct {
		name    string
		in      Integration
		wantErr bool
	}{
		{"empty name", Integration{Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, true},
		{"uppercase forbidden", Integration{Name: "Slack", Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, true},
		{"hyphen forbidden", Integration{Name: "team-slack", Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, true},
		{"leading digit forbidden", Integration{Name: "1slack", Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, true},
		{"underscore ok", Integration{Name: "team_slack", Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, false},
		{"trailing digits ok", Integration{Name: "slack1", Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, false},
		{"unknown service", Integration{Name: "ok", Service: "discord"}, true},
		{"too long", Integration{Name: strings.Repeat("a", MaxNameLen+1), Service: ServiceSlack, SlackToken: "xoxp-1234567890"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.in.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestValidate_SlackToken(t *testing.T) {
	t.Run("requires token", func(t *testing.T) {
		if err := (Integration{Name: "s", Service: ServiceSlack}).Validate(); err == nil {
			t.Fatalf("expected error for missing token")
		}
	})
	t.Run("rejects bad prefix", func(t *testing.T) {
		if err := (Integration{Name: "s", Service: ServiceSlack, SlackToken: "sk-1234567890"}).Validate(); err == nil {
			t.Fatalf("expected error for non-slack token")
		}
	})
	t.Run("accepts xoxp", func(t *testing.T) {
		if err := (Integration{Name: "s", Service: ServiceSlack, SlackToken: "xoxp-1234567890"}).Validate(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("accepts xoxb", func(t *testing.T) {
		if err := (Integration{Name: "s", Service: ServiceSlack, SlackToken: "xoxb-1234567890"}).Validate(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("rejects too short", func(t *testing.T) {
		if err := (Integration{Name: "s", Service: ServiceSlack, SlackToken: "xoxp-"}).Validate(); err == nil {
			t.Fatalf("expected error for short token")
		}
	})
}

func TestStanza_Slack_UserToken(t *testing.T) {
	in := Integration{Name: "team", Service: ServiceSlack, SlackToken: "xoxp-abc-def-ghi"}
	s := in.Stanza()
	if s == nil {
		t.Fatal("expected non-nil stanza")
	}
	if s["command"] != "npx" {
		t.Fatalf("command: %v", s["command"])
	}
	args, _ := s["args"].([]string)
	wantArgs := []string{"-y", "slack-mcp-server@latest", "--transport", "stdio"}
	if len(args) != len(wantArgs) {
		t.Fatalf("args length mismatch: got %v", args)
	}
	for i, a := range wantArgs {
		if args[i] != a {
			t.Fatalf("args[%d]=%q want %q", i, args[i], a)
		}
	}
	env, _ := s["env"].(map[string]string)
	if env["SLACK_MCP_XOXP_TOKEN"] != "xoxp-abc-def-ghi" {
		t.Fatalf("XOXP env not set: %#v", env)
	}
	if _, has := env["SLACK_MCP_XOXB_TOKEN"]; has {
		t.Fatalf("XOXB env should NOT be set for xoxp token: %#v", env)
	}
	if _, has := env["SLACK_MCP_ADD_MESSAGE_TOOL"]; has {
		t.Fatalf("add-message tool should be off by default: %#v", env)
	}
}

func TestStanza_Slack_BotToken(t *testing.T) {
	in := Integration{Name: "team", Service: ServiceSlack, SlackToken: "xoxb-abc-def"}
	s := in.Stanza()
	env, _ := s["env"].(map[string]string)
	if env["SLACK_MCP_XOXB_TOKEN"] != "xoxb-abc-def" {
		t.Fatalf("XOXB env not set: %#v", env)
	}
	if _, has := env["SLACK_MCP_XOXP_TOKEN"]; has {
		t.Fatalf("XOXP env should NOT be set for xoxb token")
	}
}

func TestStanza_Slack_AddMessageTool(t *testing.T) {
	in := Integration{
		Name:                "team",
		Service:             ServiceSlack,
		SlackToken:          "xoxp-abc-def",
		SlackAddMessageTool: true,
	}
	env, _ := in.Stanza()["env"].(map[string]string)
	if env["SLACK_MCP_ADD_MESSAGE_TOOL"] != "true" {
		t.Fatalf("add-message tool not enabled: %#v", env)
	}
}

func TestStanza_Slack_EmptyTokenYieldsNil(t *testing.T) {
	in := Integration{Name: "team", Service: ServiceSlack}
	if s := in.Stanza(); s != nil {
		t.Fatalf("expected nil stanza for empty token, got %#v", s)
	}
}

func TestValidate_ClickUp(t *testing.T) {
	t.Run("requires api key", func(t *testing.T) {
		if err := (Integration{Name: "cu", Service: ServiceClickUp, ClickUpTeamID: "12345"}).Validate(); err == nil {
			t.Fatalf("expected error for missing api key")
		}
	})
	t.Run("rejects bad prefix", func(t *testing.T) {
		if err := (Integration{Name: "cu", Service: ServiceClickUp, ClickUpAPIKey: "sk-abcdef1234", ClickUpTeamID: "12345"}).Validate(); err == nil {
			t.Fatalf("expected error for non-pk_ key")
		}
	})
	t.Run("accepts pk_ key", func(t *testing.T) {
		if err := (Integration{Name: "cu", Service: ServiceClickUp, ClickUpAPIKey: "pk_1234567890_ABCDEF", ClickUpTeamID: "12345"}).Validate(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("rejects too short key", func(t *testing.T) {
		if err := (Integration{Name: "cu", Service: ServiceClickUp, ClickUpAPIKey: "pk_", ClickUpTeamID: "12345"}).Validate(); err == nil {
			t.Fatalf("expected error for short key")
		}
	})
	t.Run("requires team id", func(t *testing.T) {
		if err := (Integration{Name: "cu", Service: ServiceClickUp, ClickUpAPIKey: "pk_1234567890_ABCDEF"}).Validate(); err == nil {
			t.Fatalf("expected error for missing team id")
		}
	})
	t.Run("rejects non-numeric team id", func(t *testing.T) {
		if err := (Integration{Name: "cu", Service: ServiceClickUp, ClickUpAPIKey: "pk_1234567890_ABCDEF", ClickUpTeamID: "abc123"}).Validate(); err == nil {
			t.Fatalf("expected error for non-numeric team id")
		}
	})
}

func TestStanza_ClickUp(t *testing.T) {
	in := Integration{
		Name:          "tasks",
		Service:       ServiceClickUp,
		ClickUpAPIKey: "pk_1234567890_ABCDEF",
		ClickUpTeamID: "987654321",
	}
	s := in.Stanza()
	if s == nil {
		t.Fatal("expected non-nil stanza")
	}
	if s["command"] != "npx" {
		t.Fatalf("command: %v", s["command"])
	}
	args, _ := s["args"].([]string)
	wantArgs := []string{"-y", "@taazkareem/clickup-mcp-server@latest"}
	if len(args) != len(wantArgs) {
		t.Fatalf("args length mismatch: got %v", args)
	}
	for i, a := range wantArgs {
		if args[i] != a {
			t.Fatalf("args[%d]=%q want %q", i, args[i], a)
		}
	}
	env, _ := s["env"].(map[string]string)
	if env["CLICKUP_API_KEY"] != "pk_1234567890_ABCDEF" {
		t.Fatalf("api key not set: %#v", env)
	}
	if env["CLICKUP_TEAM_ID"] != "987654321" {
		t.Fatalf("team id not set: %#v", env)
	}
}

func TestStanza_ClickUp_MissingFieldsYieldNil(t *testing.T) {
	if s := (Integration{Name: "tasks", Service: ServiceClickUp, ClickUpTeamID: "1"}).Stanza(); s != nil {
		t.Fatalf("expected nil stanza for missing key, got %#v", s)
	}
	if s := (Integration{Name: "tasks", Service: ServiceClickUp, ClickUpAPIKey: "pk_x"}).Stanza(); s != nil {
		t.Fatalf("expected nil stanza for missing team id, got %#v", s)
	}
}

func TestRedacted_ClickUp(t *testing.T) {
	in := Integration{
		Name:          "tasks",
		Service:       ServiceClickUp,
		ClickUpAPIKey: "pk_1234_secret_ABCDEF",
		ClickUpTeamID: "987654321",
	}
	r := in.Redacted()
	if r.ClickUpAPIKey == in.ClickUpAPIKey {
		t.Fatalf("api key should be redacted")
	}
	if !strings.Contains(r.ClickUpAPIKey, "***") {
		t.Fatalf("redaction should contain ***: %q", r.ClickUpAPIKey)
	}
	// Team ID is not secret — must round-trip in cleartext so the
	// edit form can prefill it without making the user re-enter.
	if r.ClickUpTeamID != in.ClickUpTeamID {
		t.Fatalf("team id should not be redacted: got %q want %q", r.ClickUpTeamID, in.ClickUpTeamID)
	}
}

func TestUpdate_PreservesClickUpKey(t *testing.T) {
	setupHome(t)
	saved, _, mErr := CreateAndApply("", Integration{
		Name:          "tasks",
		Service:       ServiceClickUp,
		ClickUpAPIKey: "pk_1234_secret",
		ClickUpTeamID: "111",
	})
	if mErr != nil {
		t.Fatalf("create: %v", mErr)
	}
	// Empty key in update body = "keep existing". Change only team
	// id; verify key persists.
	updated, _, mErr := UpdateAndApply("", saved.ID, Integration{
		Name:          "tasks",
		Service:       ServiceClickUp,
		ClickUpTeamID: "222",
	})
	if mErr != nil {
		t.Fatalf("update: %v", mErr)
	}
	if updated.ClickUpAPIKey != "pk_1234_secret" {
		t.Fatalf("api key not preserved: %q", updated.ClickUpAPIKey)
	}
	if updated.ClickUpTeamID != "222" {
		t.Fatalf("team id not updated: %q", updated.ClickUpTeamID)
	}
}

func TestRedacted_Slack(t *testing.T) {
	in := Integration{Name: "team", Service: ServiceSlack, SlackToken: "xoxp-1-2-secret"}
	r := in.Redacted()
	if r.SlackToken == in.SlackToken {
		t.Fatalf("token should be redacted")
	}
	if !strings.HasPrefix(r.SlackToken, "xoxp-") {
		t.Fatalf("redaction should keep prefix: %q", r.SlackToken)
	}
	if !strings.Contains(r.SlackToken, "***") {
		t.Fatalf("redaction should contain ***: %q", r.SlackToken)
	}
}

func TestCRUD_RoundTrip(t *testing.T) {
	setupHome(t)

	all, err := LoadAll()
	if err != nil || len(all) != 0 {
		t.Fatalf("expected empty start, got %v err=%v", all, err)
	}

	saved, applyErr, mErr := CreateAndApply("", Integration{
		Name:       "team",
		Service:    ServiceSlack,
		SlackToken: "xoxp-abc-def",
	})
	if mErr != nil {
		t.Fatalf("create: %v", mErr)
	}
	// applyErr is expected when there are no managed accounts to inject
	// into; we only care that the persisted record landed correctly.
	_ = applyErr
	if saved.ID == "" {
		t.Fatalf("expected ID populated")
	}

	all, _ = LoadAll()
	if len(all) != 1 || all[0].Name != "team" {
		t.Fatalf("LoadAll mismatch: %v", all)
	}

	// Duplicate name should fail.
	if _, _, mErr := CreateAndApply("", Integration{
		Name: "team", Service: ServiceSlack, SlackToken: "xoxp-x-y",
	}); mErr == nil {
		t.Fatalf("expected duplicate name error")
	}

	// Update preserves token when empty (sentinel).
	updated, _, mErr := UpdateAndApply("", saved.ID, Integration{
		Name:                "team",
		Service:             ServiceSlack,
		SlackAddMessageTool: true,
	})
	if mErr != nil {
		t.Fatalf("update: %v", mErr)
	}
	if updated.SlackToken != "xoxp-abc-def" {
		t.Fatalf("token not preserved: %q", updated.SlackToken)
	}
	if !updated.SlackAddMessageTool {
		t.Fatalf("toggle not applied")
	}

	// Delete.
	removed, ok, _, mErr := DeleteAndApply("", saved.ID)
	if mErr != nil || !ok {
		t.Fatalf("delete: ok=%v err=%v", ok, mErr)
	}
	if removed.Name != "team" {
		t.Fatalf("unexpected removed record: %v", removed)
	}
	all, _ = LoadAll()
	if len(all) != 0 {
		t.Fatalf("expected empty after delete, got %v", all)
	}
}
