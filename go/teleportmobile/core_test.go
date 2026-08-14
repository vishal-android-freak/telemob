package teleportmobile

import (
	"encoding/json"
	"strings"
	"testing"
)

type recordingSink struct{ events []string }

func (s *recordingSink) OnTerminalEvent(eventJSON string) {
	s.events = append(s.events, eventJSON)
}

func TestTOTPLoginAndShellLifecycle(t *testing.T) {
	core := NewDevelopmentCore()
	sink := &recordingSink{}
	core.SetEventSink(sink)

	challengeJSON, err := core.BeginLoginJSON(`{
		"proxyAddress":"teleport.example.com:443",
		"username":"operator",
		"password":"secret",
		"method":"totp"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
	}
	if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
		t.Fatal(err)
	}
	if _, err := core.FinishTOTP(challenge.ChallengeID, "123456"); err != nil {
		t.Fatal(err)
	}

	sessionJSON, err := core.OpenSessionJSON(`{
		"serverId":"srv-atlas",
		"hostname":"atlas-build-01",
		"login":"ubuntu",
		"columns":80,
		"rows":24
	}`)
	if err != nil {
		t.Fatal(err)
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(sessionJSON), &session); err != nil {
		t.Fatal(err)
	}
	if err := core.WriteSession(session.ID, "whoami\n"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(sink.events, "\n"); !strings.Contains(got, "ubuntu") {
		t.Fatalf("expected terminal output, got %s", got)
	}
}

func TestProductionCoreReviewerLoginAndRestore(t *testing.T) {
	core := NewCore()
	sink := &recordingSink{}
	core.SetEventSink(sink)
	if strings.Contains(core.CapabilitiesJSON(), `"developmentDriver":true`) {
		t.Fatal("production core started in development mode")
	}

	challengeJSON, err := core.BeginLoginJSON(`{
		"proxyAddress":"demo.telemob.invalid",
		"username":"play-review",
		"password":"telemob-demo",
		"method":"totp"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
	}
	if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
		t.Fatal(err)
	}
	if _, err := core.FinishTOTP(challenge.ChallengeID, "654321"); err == nil {
		t.Fatal("reviewer login accepted an incorrect TOTP code")
	}
	if _, err := core.FinishTOTP(challenge.ChallengeID, "123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := core.ListServersJSON(); err != nil {
		t.Fatal(err)
	}
	sessionJSON, err := core.OpenSessionJSON(`{
		"serverId":"srv-atlas",
		"hostname":"atlas-build-01",
		"login":"ubuntu",
		"columns":80,
		"rows":24
	}`)
	if err != nil {
		t.Fatal(err)
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(sessionJSON), &session); err != nil {
		t.Fatal(err)
	}
	for _, character := range "whoami\r" {
		if err := core.WriteSession(session.ID, string(character)); err != nil {
			t.Fatal(err)
		}
	}
	events := strings.Join(sink.events, "\n")
	if !strings.Contains(events, "ubuntu") || strings.Contains(events, "development driver: w") {
		t.Fatalf("reviewer terminal did not accumulate direct input: %s", events)
	}

	snapshotJSON, err := core.ExportSessionJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(snapshotJSON, `"reviewer":true`) {
		t.Fatalf("reviewer session marker is missing: %s", snapshotJSON)
	}

	restored := NewCore()
	if _, err := restored.RestoreSessionJSON(snapshotJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := restored.ListServersJSON(); err != nil {
		t.Fatalf("restored reviewer session cannot list nodes: %v", err)
	}
}

func TestReviewerLoginRequiresExactCredentials(t *testing.T) {
	valid := loginRequest{
		ProxyAddress: reviewerProxyAddress,
		Username:     reviewerUsername,
		Password:     reviewerPassword,
		Method:       "totp",
	}
	if !isReviewerLogin(valid) {
		t.Fatal("documented reviewer credentials were not recognized")
	}

	tests := []struct {
		name   string
		mutate func(*loginRequest)
	}{
		{name: "proxy", mutate: func(value *loginRequest) { value.ProxyAddress += ".example" }},
		{name: "username", mutate: func(value *loginRequest) { value.Username += "x" }},
		{name: "password", mutate: func(value *loginRequest) { value.Password += "x" }},
		{name: "method", mutate: func(value *loginRequest) { value.Method = "passkey" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			test.mutate(&candidate)
			if isReviewerLogin(candidate) {
				t.Fatalf("reviewer login accepted mismatched %s", test.name)
			}
		})
	}
}

func TestPasskeyUsesBrowserMFA(t *testing.T) {
	core := NewDevelopmentCore()
	challengeJSON, err := core.BeginLoginJSON(`{
		"proxyAddress":"teleport.example.com:443",
		"username":"operator",
		"password":"secret",
		"method":"passkey"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
		BrowserURL  string `json:"browserUrl"`
	}
	if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(challenge.BrowserURL, "/web/mfa/browser/") {
		t.Fatalf("unexpected Browser MFA URL: %q", challenge.BrowserURL)
	}
	if _, err := core.FinishPasskey(challenge.ChallengeID, ""); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalOutputIsSequencedAndReplayable(t *testing.T) {
	core := NewDevelopmentCore()
	core.prepareSessionOutput("session-test")
	core.emit(map[string]any{"type": "data", "sessionId": "session-test", "data": "one"})
	core.emit(map[string]any{"type": "data", "sessionId": "session-test", "data": "two"})
	core.emit(map[string]any{"type": "closed", "sessionId": "session-test", "reason": "done"})

	snapshotJSON, err := core.SessionOutputJSON("session-test", 1)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Open           bool                 `json:"open"`
		LatestSequence int64                `json:"latestSequence"`
		Chunks         []sessionOutputChunk `json:"chunks"`
		Reason         string               `json:"reason"`
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Open || snapshot.LatestSequence != 2 || snapshot.Reason != "done" {
		t.Fatalf("unexpected output snapshot: %#v", snapshot)
	}
	if len(snapshot.Chunks) != 1 || snapshot.Chunks[0].Sequence != 2 || snapshot.Chunks[0].Data != "two" {
		t.Fatalf("unexpected replay chunks: %#v", snapshot.Chunks)
	}
}

func TestTerminalOutputBufferIsBounded(t *testing.T) {
	core := NewDevelopmentCore()
	core.prepareSessionOutput("session-test")
	core.emit(map[string]any{
		"type": "data", "sessionId": "session-test",
		"data": strings.Repeat("x", maxSessionOutputBytes+128),
	})

	snapshotJSON, err := core.SessionOutputJSON("session-test", -1)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Truncated bool                 `json:"truncated"`
		Chunks    []sessionOutputChunk `json:"chunks"`
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if !snapshot.Truncated || len(snapshot.Chunks) != 1 || len(snapshot.Chunks[0].Data) != maxSessionOutputBytes {
		t.Fatalf("output buffer was not bounded: truncated=%v chunks=%d", snapshot.Truncated, len(snapshot.Chunks))
	}
}
