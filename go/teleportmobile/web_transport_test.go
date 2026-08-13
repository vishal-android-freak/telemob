package teleportmobile

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTerminalEnvelopeRoundTrip(t *testing.T) {
	want := terminalEnvelope{Version: "1", Type: "r", Payload: "λ shell output\r\n"}
	got, err := decodeEnvelope(encodeEnvelope(want))
	if err != nil {
		t.Fatalf("decodeEnvelope() error = %v", err)
	}
	if got != want {
		t.Fatalf("decodeEnvelope() = %#v, want %#v", got, want)
	}
}

func TestWebTransportVerifiesTLSByDefault(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{"cluster_name": "example.test"})
	}))
	defer server.Close()

	transport := newWebTransport(false)
	_, err := transport.beginLogin(`{"proxyAddress":"` + server.URL + `","username":"alice","password":"secret","method":"totp"}`)
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("beginLogin() error = %v, want certificate verification failure", err)
	}
}

func TestExportSessionRenewsAndPersistsRotatedCredentials(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/webapi/sessions/web/renew", func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer old-token" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if cookie, err := request.Cookie(sessionCookieName); err != nil || cookie.Value != "old-cookie" {
			t.Errorf("renewal request missing saved session cookie")
		}
		http.SetCookie(response, &http.Cookie{Name: sessionCookieName, Value: "new-cookie", Path: "/", Secure: true})
		writeTestJSON(t, response, map[string]any{
			"type":           "bearer",
			"token":          "new-token",
			"expires_in":     300,
			"sessionExpires": time.Now().Add(time.Hour).UTC(),
		})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()

	baseURL, err := normalizeProxyURL(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := newWebHTTPClient(true)
	if err != nil {
		t.Fatal(err)
	}
	client.Jar.SetCookies(baseURL, []*http.Cookie{{
		Name: sessionCookieName, Value: "old-cookie", Path: "/", Secure: true,
	}})
	transport := newWebTransport(false)
	transport.session = &webSession{
		client:         client,
		baseURL:        baseURL,
		insecure:       true,
		token:          "old-token",
		tokenExpiresAt: time.Now().Add(time.Minute),
		expiresAt:      time.Now().Add(time.Hour),
		username:       "alice",
		cluster:        "example.test",
	}

	snapshotJSON, err := transport.exportSession()
	if err != nil {
		t.Fatalf("exportSession() error = %v", err)
	}
	var snapshot persistedWebSession
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Token != "new-token" || snapshot.SessionCookie != "new-cookie" {
		t.Fatalf("renewed credentials were not persisted: %#v", snapshot)
	}
}

func TestWebTransportTOTPListsNodesAndStreamsTerminal(t *testing.T) {
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/webapi/ping", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{
			"cluster_name": "example.test",
			"auth":         map[string]any{"type": "local", "second_factor": "otp"},
		})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/begin", func(response http.ResponseWriter, request *http.Request) {
		var body map[string]string
		readTestJSON(t, request, &body)
		if body["user"] != "alice" || body["pass"] != "secret" {
			t.Errorf("unexpected login request: %#v", body)
		}
		writeTestJSON(t, response, map[string]any{"totp_challenge": true})
	})
	mux.HandleFunc("/v1/webapi/sessions/web", func(response http.ResponseWriter, request *http.Request) {
		csrfCookie, err := request.Cookie(csrfCookieName)
		if err != nil || csrfCookie.Value == "" || request.Header.Get(csrfHeaderName) != csrfCookie.Value {
			t.Errorf("missing matching CSRF cookie and header")
		}
		var body map[string]string
		readTestJSON(t, request, &body)
		if body["second_factor_token"] != "123456" {
			t.Errorf("unexpected TOTP token: %q", body["second_factor_token"])
		}
		http.SetCookie(response, &http.Cookie{Name: sessionCookieName, Value: "session-cookie", Path: "/", Secure: true})
		writeTestJSON(t, response, map[string]any{
			"type":           "bearer",
			"token":          "bearer-token",
			"expires_in":     300,
			"sessionExpires": time.Now().Add(time.Hour).UTC(),
		})
	})
	mux.HandleFunc("/v1/webapi/sites/example.test/nodes", func(response http.ResponseWriter, request *http.Request) {
		assertTestSession(t, request)
		writeTestJSON(t, response, map[string]any{"items": []map[string]any{
			{
				"id": "node-1", "siteId": "example.test", "hostname": "atlas", "addr": "10.0.0.1:3022", "tunnel": true,
				"tags": []map[string]string{{"name": "env", "value": "dev"}}, "sshLogins": []string{"ubuntu"},
			},
			{
				"id": "node-2", "siteId": "example.test", "hostname": "no-login", "tunnel": true, "sshLogins": nil,
			},
		}})
	})
	mux.HandleFunc("/v1/webapi/sites/example.test/connect/ws", func(response http.ResponseWriter, request *http.Request) {
		if cookie, err := request.Cookie(sessionCookieName); err != nil || cookie.Value != "session-cookie" {
			t.Errorf("terminal request missing session cookie")
		}
		connection, err := upgrader.Upgrade(response, request, nil)
		if err != nil {
			t.Errorf("upgrade terminal websocket: %v", err)
			return
		}
		defer connection.Close()
		var auth map[string]string
		if err := connection.ReadJSON(&auth); err != nil {
			t.Errorf("read terminal auth: %v", err)
			return
		}
		if auth["token"] != "bearer-token" {
			t.Errorf("terminal token = %q", auth["token"])
		}
		if err := connection.WriteJSON(map[string]string{"type": "create_session_response", "status": "ok"}); err != nil {
			t.Errorf("write terminal auth response: %v", err)
			return
		}
		messageType, raw, err := connection.ReadMessage()
		if err != nil {
			t.Errorf("read terminal input: %v", err)
			return
		}
		if messageType != websocket.BinaryMessage {
			t.Errorf("terminal message type = %d", messageType)
			return
		}
		envelope, err := decodeEnvelope(raw)
		if err != nil || envelope.Type != "r" || envelope.Payload != "hostname\r" {
			t.Errorf("terminal envelope = %#v, err = %v", envelope, err)
			return
		}
		_ = connection.WriteMessage(websocket.BinaryMessage, encodeEnvelope(terminalEnvelope{Version: "1", Type: "r", Payload: "atlas\r\n"}))
	})

	server := httptest.NewTLSServer(mux)
	defer server.Close()
	transport := newWebTransport(false)
	events := make(chan map[string]any, 4)
	transport.emit = func(event map[string]any) { events <- event }

	challengeJSON, err := transport.beginLogin(`{"proxyAddress":"` + server.URL + `","username":"alice","password":"secret","method":"totp","insecure":true}`)
	if err != nil {
		t.Fatalf("beginLogin() error = %v", err)
	}
	var challenge struct {
		Kind        string `json:"kind"`
		ChallengeID string `json:"challengeId"`
	}
	if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
		t.Fatal(err)
	}
	if challenge.Kind != "totp" || challenge.ChallengeID == "" {
		t.Fatalf("unexpected challenge: %s", challengeJSON)
	}
	if _, err := transport.finishTOTP(challenge.ChallengeID, "123456"); err != nil {
		t.Fatalf("finishTOTP() error = %v", err)
	}
	snapshotJSON, err := transport.exportSession()
	if err != nil {
		t.Fatalf("exportSession() error = %v", err)
	}
	restored := newWebTransport(false)
	restored.emit = transport.emit
	if _, err := restored.restoreSession(snapshotJSON); err != nil {
		t.Fatalf("restoreSession() error = %v", err)
	}
	transport = restored

	serversJSON, err := transport.listServers()
	if err != nil {
		t.Fatalf("listServers() error = %v", err)
	}
	if !strings.Contains(serversJSON, `"hostname":"atlas"`) || !strings.Contains(serversJSON, `"address":"tunnel"`) {
		t.Fatalf("unexpected servers: %s", serversJSON)
	}
	if !strings.Contains(serversJSON, `"hostname":"no-login"`) || !strings.Contains(serversJSON, `"logins":[]`) {
		t.Fatalf("null SSH logins were not normalized: %s", serversJSON)
	}

	sessionJSON, err := transport.openSession(`{"serverId":"node-1","hostname":"atlas","login":"ubuntu","columns":80,"rows":24}`)
	if err != nil {
		t.Fatalf("openSession() error = %v", err)
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(sessionJSON), &session); err != nil {
		t.Fatal(err)
	}
	if err := transport.writeSession(session.ID, "hostname\r"); err != nil {
		t.Fatalf("writeSession() error = %v", err)
	}
	select {
	case event := <-events:
		if event["type"] != "data" || event["sessionId"] != session.ID || event["data"] != "atlas\r\n" {
			t.Fatalf("unexpected terminal event: %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for terminal output")
	}
	transport.closeSession(session.ID)
}

func TestWebTransportPasskeyForwardsAssertion(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/webapi/ping", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{"cluster_name": "example.test", "auth": map[string]any{"type": "local", "second_factor": "webauthn"}})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/begin", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{"webauthn_challenge": map[string]any{"publicKey": map[string]any{
			"challenge": "base64url-challenge", "rpId": "example.test", "allowCredentials": []map[string]any{{"id": "credential-id", "type": "public-key"}},
		}}})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/finishsession", func(response http.ResponseWriter, request *http.Request) {
		var body map[string]any
		readTestJSON(t, request, &body)
		assertion, ok := body["webauthnAssertionResponse"].(map[string]any)
		if !ok || assertion["extensions"] == nil || assertion["clientExtensionResults"] != nil {
			t.Errorf("unexpected passkey assertion: %#v", body)
		}
		http.SetCookie(response, &http.Cookie{Name: sessionCookieName, Value: "passkey-session", Path: "/", Secure: true})
		writeTestJSON(t, response, map[string]any{"type": "bearer", "token": "passkey-token", "expires_in": 300, "sessionExpires": time.Now().Add(time.Hour).UTC()})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()

	transport := newWebTransport(false)
	challengeJSON, err := transport.beginLogin(`{"proxyAddress":"` + server.URL + `","username":"alice","password":"secret","method":"passkey","insecure":true}`)
	if err != nil {
		t.Fatalf("beginLogin() error = %v", err)
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
		RPID        string `json:"rpId"`
		RequestJSON string `json:"requestJson"`
	}
	if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
		t.Fatal(err)
	}
	if challenge.RPID != "example.test" || !strings.Contains(challenge.RequestJSON, "base64url-challenge") {
		t.Fatalf("unexpected passkey challenge: %s", challengeJSON)
	}
	assertion := `{"id":"credential-id","rawId":"credential-id","type":"public-key","response":{"authenticatorData":"a","clientDataJSON":"b","signature":"c"},"clientExtensionResults":{}}`
	if _, err := transport.finishPasskey(challenge.ChallengeID, assertion); err != nil {
		t.Fatalf("finishPasskey() error = %v", err)
	}
}

func assertTestSession(t *testing.T, request *http.Request) {
	t.Helper()
	if request.Header.Get("Authorization") != "Bearer bearer-token" {
		t.Errorf("authorization = %q", request.Header.Get("Authorization"))
	}
	if cookie, err := request.Cookie(sessionCookieName); err != nil || cookie.Value != "session-cookie" {
		t.Errorf("missing session cookie")
	}
}

func readTestJSON(t *testing.T, request *http.Request, target any) {
	t.Helper()
	defer request.Body.Close()
	if err := json.NewDecoder(request.Body).Decode(target); err != nil {
		t.Errorf("decode request: %v", err)
	}
}

func writeTestJSON(t *testing.T, response http.ResponseWriter, value any) {
	t.Helper()
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}
