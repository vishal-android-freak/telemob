package teleportmobile

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

type recordingSink struct {
	events []string
	data   [][]byte
}

func (s *recordingSink) OnTerminalData(_ string, _ int64, data []byte) {
	s.data = append(s.data, append([]byte(nil), data...))
}

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
	if got := string(bytes.Join(sink.data, nil)); !strings.Contains(got, "ubuntu") {
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
	terminalData := string(bytes.Join(sink.data, nil))
	if !strings.Contains(terminalData, "ubuntu") || strings.Contains(terminalData, "development driver: w") {
		t.Fatalf("reviewer terminal did not accumulate direct input: %s", terminalData)
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
	if len(snapshot.Chunks) != 1 || snapshot.Chunks[0].Sequence != 2 ||
		!bytes.Equal(snapshot.Chunks[0].Data, []byte("two")) {
		t.Fatalf("unexpected replay chunks: %#v", snapshot.Chunks)
	}
}

func TestTerminalDataBypassesJSONWithoutChangingBytes(t *testing.T) {
	core := NewDevelopmentCore()
	sink := &recordingSink{}
	core.SetEventSink(sink)
	core.prepareSessionOutput("session-test")
	want := []byte{'a', 0xff, 0x00, 0x1b, 'b'}
	core.emit(map[string]any{
		"type": "data", "sessionId": "session-test", "data": string(want),
	})

	if len(sink.data) != 1 || !bytes.Equal(sink.data[0], want) {
		t.Fatalf("terminal bytes changed: got %v want %v", sink.data, want)
	}
	if len(sink.events) != 1 || strings.Contains(sink.events[0], "Yf8") {
		t.Fatalf("terminal payload leaked back through metadata JSON: %q", sink.events)
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

func TestActiveTerminalOutputRecordsAreNeverEvicted(t *testing.T) {
	core := NewDevelopmentCore()
	core.prepareSessionOutput("session-oldest")
	core.emit(map[string]any{
		"type": "data", "sessionId": "session-oldest", "data": "one",
	})

	for index := 0; index < maxClosedSessionOutputRecords+4; index++ {
		core.prepareSessionOutput(fmt.Sprintf("session-%d", index))
	}
	core.emit(map[string]any{
		"type": "data", "sessionId": "session-oldest", "data": "two",
	})

	snapshotJSON, err := core.SessionOutputJSON("session-oldest", 0)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		LatestSequence int64                `json:"latestSequence"`
		Chunks         []sessionOutputChunk `json:"chunks"`
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.LatestSequence != 2 || len(snapshot.Chunks) != 2 {
		t.Fatalf("active terminal output was evicted: %#v", snapshot)
	}
}

func TestClosedTerminalOutputRecordsAreBounded(t *testing.T) {
	core := NewDevelopmentCore()
	for index := 0; index < maxClosedSessionOutputRecords+4; index++ {
		sessionID := fmt.Sprintf("closed-%d", index)
		core.prepareSessionOutput(sessionID)
		core.emit(map[string]any{
			"type": "closed", "sessionId": sessionID, "reason": "done",
		})
	}

	core.mu.Lock()
	defer core.mu.Unlock()
	if len(core.outputs) != maxClosedSessionOutputRecords {
		t.Fatalf("kept %d closed output records, want %d", len(core.outputs), maxClosedSessionOutputRecords)
	}
}

func TestClosedTerminalOutputRecordsArePrunedByCloseOrder(t *testing.T) {
	core := NewDevelopmentCore()
	oldSessionID := "long-running"
	core.prepareSessionOutput(oldSessionID)
	core.emit(map[string]any{
		"type": "data", "sessionId": oldSessionID, "data": "important final screen",
	})

	for index := 0; index < maxClosedSessionOutputRecords; index++ {
		sessionID := fmt.Sprintf("short-%d", index)
		core.prepareSessionOutput(sessionID)
		core.emit(map[string]any{
			"type": "closed", "sessionId": sessionID, "reason": "done",
		})
	}
	core.emit(map[string]any{
		"type": "closed", "sessionId": oldSessionID, "reason": "done",
	})

	if _, err := core.SessionOutputJSON(oldSessionID, 0); err != nil {
		t.Fatalf("most recently closed session was pruned: %v", err)
	}
	if _, err := core.SessionOutputJSON("short-0", 0); err == nil {
		t.Fatal("oldest closed session was retained after the replay limit")
	}
}

func TestCloseAllSessionsKeepsAuthenticatedProfile(t *testing.T) {
	core := NewDevelopmentCore()
	core.profile = &authenticatedProfile{Username: "operator"}
	for index := 0; index < 3; index++ {
		sessionID := fmt.Sprintf("session-%d", index)
		core.sessions[sessionID] = sessionTarget{Hostname: "node"}
		core.inputs[sessionID] = "pending"
		core.prepareSessionOutput(sessionID)
	}

	core.CloseAllSessions()

	core.mu.Lock()
	defer core.mu.Unlock()
	if len(core.sessions) != 0 || len(core.inputs) != 0 {
		t.Fatalf("terminal state survived teardown: sessions=%d inputs=%d", len(core.sessions), len(core.inputs))
	}
	if core.profile == nil || core.profile.Username != "operator" {
		t.Fatal("closing transports invalidated the authenticated profile")
	}
}
