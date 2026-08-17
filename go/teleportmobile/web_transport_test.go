package teleportmobile

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
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
			"type":             "bearer",
			"token":            "new-token",
			"expires_in":       300,
			"sessionExpiresIn": int((12 * time.Hour) / time.Second),
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
	if time.Until(snapshot.ExpiresAt) < 11*time.Hour {
		t.Fatalf("renewed session expiry = %v, want the cluster's 12-hour lifetime", snapshot.ExpiresAt)
	}
}

func TestActiveTerminalRenewsAndPublishesRotatedCredentials(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/webapi/sessions/web/renew", func(response http.ResponseWriter, request *http.Request) {
		http.SetCookie(response, &http.Cookie{
			Name: sessionCookieName, Value: "background-cookie", Path: "/", Secure: true,
		})
		writeTestJSON(t, response, map[string]any{
			"type":             "bearer",
			"token":            "background-token",
			"expires_in":       300,
			"sessionExpiresIn": int((12 * time.Hour) / time.Second),
		})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()

	transport := newTestWebTransport(t, server.URL)
	transport.session.tokenExpiresAt = time.Now().Add(renewBeforeExpiry + 10*time.Millisecond)
	events := make(chan map[string]any, 1)
	transport.emit = func(event map[string]any) {
		events <- event
	}
	terminal := &webTerminal{
		done:      make(chan struct{}),
		profileID: "profile-one",
		session:   transport.session,
	}
	go transport.keepTerminalSessionFresh(terminal)
	defer close(terminal.done)

	select {
	case event := <-events:
		if event["type"] != "session" || event["profileId"] != "profile-one" {
			t.Fatalf("renewal event = %#v", event)
		}
		snapshotJSON, ok := event["snapshot"].(string)
		if !ok {
			t.Fatalf("renewal snapshot = %#v", event["snapshot"])
		}
		var snapshot persistedWebSession
		if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Token != "background-token" || snapshot.SessionCookie != "background-cookie" {
			t.Fatalf("background credentials were not published: %#v", snapshot)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("active terminal did not renew its Teleport web session")
	}
}

func TestFreshSessionKeepsLoginAfterTransientRenewalFailure(t *testing.T) {
	renewAvailable := false
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/webapi/sessions/web/renew", func(response http.ResponseWriter, request *http.Request) {
		if !renewAvailable {
			http.Error(response, "proxy temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		writeTestJSON(t, response, map[string]any{
			"type":             "bearer",
			"token":            "renewed-token",
			"expires_in":       300,
			"sessionExpiresIn": int((12 * time.Hour) / time.Second),
		})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()

	transport := newTestWebTransport(t, server.URL)
	if _, err := transport.freshSession(); err == nil || !strings.Contains(err.Error(), "temporarily unavailable") {
		t.Fatalf("freshSession() error = %v, want transient proxy failure", err)
	}
	if transport.session == nil {
		t.Fatal("transient renewal failure discarded the saved login")
	}

	renewAvailable = true
	session, err := transport.freshSession()
	if err != nil {
		t.Fatalf("freshSession() after recovery error = %v", err)
	}
	if session.token != "renewed-token" {
		t.Fatalf("renewed token = %q, want renewed-token", session.token)
	}
}

func TestFreshSessionReportsRejectedRenewalAsExpired(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Error(response, "access denied", http.StatusForbidden)
	}))
	defer server.Close()

	transport := newTestWebTransport(t, server.URL)
	_, err := transport.freshSession()
	if err == nil || err.Error() != "the Teleport login has expired; authenticate again" {
		t.Fatalf("freshSession() error = %v, want explicit expired-login error", err)
	}
}

func newTestWebTransport(t *testing.T, serverURL string) *webTransport {
	t.Helper()
	baseURL, err := normalizeProxyURL(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := newWebHTTPClient(true)
	if err != nil {
		t.Fatal(err)
	}
	client.Jar.SetCookies(baseURL, []*http.Cookie{{
		Name: sessionCookieName, Value: "saved-cookie", Path: "/", Secure: true,
	}})
	transport := newWebTransport(false)
	transport.session = &webSession{
		client:         client,
		baseURL:        baseURL,
		insecure:       true,
		token:          "expiring-token",
		tokenExpiresAt: time.Now().Add(time.Minute),
		expiresAt:      time.Now().Add(12 * time.Hour),
		username:       "alice",
		cluster:        "example.test",
	}
	return transport
}

func TestRestoreSessionDoesNotDowngradeLiveCredentials(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()

	baseURL, err := normalizeProxyURL(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tests := []struct {
		name               string
		snapshotTokenUntil time.Time
		wantToken          string
		wantCookie         string
	}{
		{
			name:               "older snapshot is ignored",
			snapshotTokenUntil: now.Add(5 * time.Minute),
			wantToken:          "live-token",
			wantCookie:         "live-cookie",
		},
		{
			name:               "newer snapshot is restored",
			snapshotTokenUntil: now.Add(15 * time.Minute),
			wantToken:          "saved-token",
			wantCookie:         "saved-cookie",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, err := newWebHTTPClient(true)
			if err != nil {
				t.Fatal(err)
			}
			client.Jar.SetCookies(baseURL, []*http.Cookie{{
				Name: sessionCookieName, Value: "live-cookie", Path: "/", Secure: true,
			}})
			transport := newWebTransport(false)
			transport.session = &webSession{
				client:         client,
				baseURL:        baseURL,
				insecure:       true,
				token:          "live-token",
				tokenExpiresAt: now.Add(10 * time.Minute),
				expiresAt:      now.Add(12 * time.Hour),
				username:       "alice",
				cluster:        "example.test",
			}
			snapshotJSON, err := marshal(persistedWebSession{
				Version:        1,
				ProxyAddress:   baseURL.String(),
				SessionCookie:  "saved-cookie",
				Token:          "saved-token",
				TokenExpiresAt: test.snapshotTokenUntil,
				ExpiresAt:      now.Add(12 * time.Hour),
				Username:       "alice",
				Cluster:        "example.test",
				Insecure:       true,
			})
			if err != nil {
				t.Fatal(err)
			}

			if _, err := transport.restoreSession(snapshotJSON); err != nil {
				t.Fatalf("restoreSession() error = %v", err)
			}
			exportedJSON, err := transport.exportSession()
			if err != nil {
				t.Fatalf("exportSession() error = %v", err)
			}
			var exported persistedWebSession
			if err := json.Unmarshal([]byte(exportedJSON), &exported); err != nil {
				t.Fatal(err)
			}
			if exported.Token != test.wantToken || exported.SessionCookie != test.wantCookie {
				t.Fatalf("restored credentials = token %q, cookie %q; want token %q, cookie %q", exported.Token, exported.SessionCookie, test.wantToken, test.wantCookie)
			}
		})
	}
}

func TestRestoreDifferentProfileKeepsOpenTerminals(t *testing.T) {
	transport := newWebTransport(false)
	terminal := &webTerminal{}
	transport.terminals["session-one"] = terminal

	now := time.Now()
	snapshotJSON, err := marshal(persistedWebSession{
		Version:        1,
		ProxyAddress:   "https://second.example.test:443",
		SessionCookie:  "second-cookie",
		Token:          "second-token",
		TokenExpiresAt: now.Add(10 * time.Minute),
		ExpiresAt:      now.Add(12 * time.Hour),
		Username:       "bob",
		Cluster:        "second.example.test",
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := transport.restoreSession(snapshotJSON); err != nil {
		t.Fatalf("restoreSession() error = %v", err)
	}
	if transport.terminals["session-one"] != terminal {
		t.Fatal("restoring another profile removed the existing terminal")
	}
	if transport.session == nil || transport.session.username != "bob" {
		t.Fatal("the restored profile did not become the active authentication context")
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

func TestWebTransportBrowserMFAForwardsAssertion(t *testing.T) {
	mux := http.NewServeMux()
	var callbackURL string
	mux.HandleFunc("/webapi/ping", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{"cluster_name": "example.test", "auth": map[string]any{"type": "local", "second_factor": "webauthn"}})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/begin", func(response http.ResponseWriter, request *http.Request) {
		var body map[string]string
		readTestJSON(t, request, &body)
		callbackURL = body["browser_mfa_tsh_redirect_url"]
		if callbackURL == "" {
			t.Error("Browser MFA callback URL is missing")
		}
		writeTestJSON(t, response, map[string]any{
			"webauthn_challenge": map[string]any{"publicKey": map[string]any{
				"challenge": "base64url-challenge", "rpId": "example.test", "allowCredentials": []map[string]any{{"id": "credential-id", "type": "public-key"}},
			}},
			"browser_challenge": map[string]any{"requestId": "browser-request"},
		})
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
		BrowserURL  string `json:"browserUrl"`
	}
	if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(challenge.BrowserURL, "/web/mfa/browser/browser-request") {
		t.Fatalf("unexpected passkey challenge: %s", challengeJSON)
	}
	assertion := json.RawMessage(`{"id":"credential-id","rawId":"credential-id","type":"public-key","response":{"authenticatorData":"a","clientDataJSON":"b","signature":"c"},"extensions":{}}`)
	callback, err := url.Parse(callbackURL)
	if err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(callback.Query().Get("secret_key"))
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := json.Marshal(map[string]any{"browser_mfa_webauthn_response": assertion})
	if err != nil {
		t.Fatal(err)
	}
	sealed := sealBrowserMFAResponse(t, key, plaintext)
	query := callback.Query()
	query.Set("response", string(sealed))
	callback.RawQuery = query.Encode()
	callbackResponse, err := http.Get(callback.String())
	if err != nil {
		t.Fatalf("Browser MFA callback error = %v", err)
	}
	_ = callbackResponse.Body.Close()
	if _, err := transport.finishPasskey(challenge.ChallengeID, ""); err != nil {
		t.Fatalf("finishPasskey() error = %v", err)
	}
}

func TestWebTransportBrowserMFARequiresSupportedProxy(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/webapi/ping", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{
			"cluster_name":   "example.test",
			"server_version": "15.5.4",
			"auth":           map[string]any{"type": "local", "second_factor": "webauthn"},
		})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/begin", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{
			"webauthn_challenge": map[string]any{"publicKey": map[string]any{"challenge": "legacy-native-challenge"}},
		})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()

	transport := newWebTransport(false)
	_, err := transport.beginLogin(`{"proxyAddress":"` + server.URL + `","username":"alice","password":"secret","method":"passkey","insecure":true}`)
	if err == nil || !strings.Contains(err.Error(), "Teleport 18.8 or newer") {
		t.Fatalf("beginLogin() error = %v, want Browser MFA compatibility guidance", err)
	}
	if len(transport.pending) != 0 {
		t.Fatalf("unsupported Browser MFA left %d pending login(s)", len(transport.pending))
	}
}

func TestForwardAuthorizationIssuesAndPersistsSSHIdentity(t *testing.T) {
	caSigner := testSSHSigner(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/webapi/ping", func(response http.ResponseWriter, request *http.Request) {
		writeTestJSON(t, response, map[string]any{
			"cluster_name": "root",
			"fips":         false,
			"proxy": map[string]any{
				"tls_routing_enabled": false,
				"ssh":                 map[string]any{"ssh_public_addr": "proxy.example.test:3023"},
			},
		})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/begin", func(response http.ResponseWriter, request *http.Request) {
		var body map[string]string
		readTestJSON(t, request, &body)
		if body["user"] != "alice" || body["pass"] != "forward-secret" {
			t.Errorf("unexpected forwarding begin request: %#v", body)
		}
		if body["browser_mfa_tsh_redirect_url"] != "" {
			writeTestJSON(t, response, map[string]any{
				"browser_challenge": map[string]any{"requestId": "forward-browser-request"},
			})
			return
		}
		writeTestJSON(t, response, map[string]any{"totp_challenge": true})
	})
	mux.HandleFunc("/v1/webapi/mfa/login/finish", func(response http.ResponseWriter, request *http.Request) {
		var body struct {
			User      string         `json:"user"`
			Password  string         `json:"password"`
			PublicKey []byte         `json:"pub_key"`
			TTL       int64          `json:"ttl"`
			Cluster   string         `json:"RouteToCluster"`
			TOTP      string         `json:"totp_code"`
			WebAuthn  map[string]any `json:"webauthn_challenge_response"`
		}
		readTestJSON(t, request, &body)
		if body.User != "alice" || body.Password != "forward-secret" || body.Cluster != "root" {
			t.Errorf("unexpected forwarding finish identity: %#v", body)
		}
		if body.TTL != int64(forwardingCertificateTTL) {
			t.Errorf("forwarding certificate TTL = %d, want %d", body.TTL, int64(forwardingCertificateTTL))
		}
		if body.TOTP != "123456" && body.WebAuthn == nil {
			t.Errorf("forwarding finish omitted second factor: %#v", body)
		}
		if body.WebAuthn != nil {
			if body.WebAuthn["extensions"] == nil || body.WebAuthn["clientExtensionResults"] != nil {
				t.Errorf("unexpected Browser MFA assertion shape: %#v", body.WebAuthn)
			}
		}
		publicKey, _, _, _, err := ssh.ParseAuthorizedKey(body.PublicKey)
		if err != nil {
			t.Errorf("parse generated SSH public key: %v", err)
			http.Error(response, err.Error(), http.StatusBadRequest)
			return
		}
		now := uint64(time.Now().Unix())
		certificate := &ssh.Certificate{
			Key: publicKey, CertType: ssh.UserCert, KeyId: "alice",
			ValidPrincipals: []string{"ubuntu"}, ValidAfter: now - 1, ValidBefore: now + 300,
			Permissions: ssh.Permissions{Extensions: map[string]string{"permit-port-forwarding": ""}},
		}
		if err := certificate.SignCert(rand.Reader, caSigner); err != nil {
			t.Errorf("sign generated SSH certificate: %v", err)
			http.Error(response, err.Error(), http.StatusInternalServerError)
			return
		}
		writeTestJSON(t, response, map[string]any{
			"cert": ssh.MarshalAuthorizedKey(certificate),
			"host_signers": []map[string]any{{
				"domain_name":   "root",
				"checking_keys": [][]byte{ssh.MarshalAuthorizedKey(caSigner.PublicKey())},
			}},
		})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := server.Client()
	client.Jar, err = cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client.Jar.SetCookies(baseURL, []*http.Cookie{{
		Name: sessionCookieName, Value: "forward-session", Path: "/", Secure: true,
	}})

	for _, test := range []struct {
		name   string
		method string
	}{
		{name: "totp", method: "totp"},
		{name: "browser passkey", method: "passkey"},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := newWebTransport(false)
			transport.session = &webSession{
				client: client, baseURL: baseURL, insecure: true,
				token: "web-token", tokenExpiresAt: time.Now().Add(10 * time.Minute),
				expiresAt: time.Now().Add(time.Hour), username: "alice", cluster: "root",
			}
			challengeJSON, err := transport.beginForwardAuthorization(
				`{"password":"forward-secret","method":"` + test.method + `","profileId":"profile-1"}`,
			)
			if err != nil {
				t.Fatalf("begin forwarding authorization: %v", err)
			}
			var challenge struct {
				Kind        string `json:"kind"`
				ChallengeID string `json:"challengeId"`
				BrowserURL  string `json:"browserUrl"`
			}
			if err := json.Unmarshal([]byte(challengeJSON), &challenge); err != nil {
				t.Fatal(err)
			}
			if challenge.Kind != test.method || challenge.ChallengeID == "" {
				t.Fatalf("unexpected forwarding challenge: %s", challengeJSON)
			}
			if test.method == "totp" {
				_, err = transport.finishForwardTOTP(challenge.ChallengeID, "123456")
			} else {
				if !strings.HasSuffix(challenge.BrowserURL, "/web/mfa/browser/forward-browser-request") {
					t.Fatalf("unexpected forwarding Browser MFA URL: %q", challenge.BrowserURL)
				}
				_, err = transport.finishForwardPasskey(
					challenge.ChallengeID,
					`{"id":"credential","response":{"signature":"value"},"clientExtensionResults":{}}`,
				)
			}
			if err != nil {
				t.Fatalf("finish forwarding authorization: %v", err)
			}
			statusJSON, err := transport.forwardAuthorizationStatus()
			if err != nil || !strings.Contains(statusJSON, `"authorized":true`) {
				t.Fatalf("forwarding authorization status = %q, error = %v", statusJSON, err)
			}
			snapshot, err := transport.exportSession()
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(snapshot, "forward-secret") || strings.Contains(snapshot, "123456") || strings.Contains(snapshot, "signature") {
				t.Fatal("saved session snapshot contains forwarding credentials")
			}
			restored := newWebTransport(false)
			if _, err := restored.restoreSession(snapshot); err != nil {
				t.Fatalf("restore forwarding identity: %v", err)
			}
			restoredStatus, err := restored.forwardAuthorizationStatus()
			if err != nil || !strings.Contains(restoredStatus, `"authorized":true`) {
				t.Fatalf("restored forwarding authorization status = %q, error = %v", restoredStatus, err)
			}
			if restored.session.sshProxyAddress != "proxy.example.test:3023" {
				t.Fatalf("restored SSH proxy address = %q", restored.session.sshProxyAddress)
			}
		})
	}
}

func sealBrowserMFAResponse(t *testing.T, key, plaintext []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		t.Fatal(err)
	}
	sealed, err := json.Marshal(map[string]any{
		"ciphertext": aead.Seal(nil, nonce, plaintext, nil),
		"nonce":      nonce,
	})
	if err != nil {
		t.Fatal(err)
	}
	return sealed
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
