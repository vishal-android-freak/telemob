package teleportmobile

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	requestTimeout       = 20 * time.Second
	websocketAuthTimeout = 20 * time.Second
	browserMFATimeout    = 5 * time.Minute
	maxResponseBytes     = 8 << 20
	sessionCookieName    = "__Host-session"
	csrfCookieName       = "__Host-grv_csrf"
	csrfHeaderName       = "X-CSRF-Token"
	renewBeforeExpiry    = 3 * time.Minute
	terminalRenewRetry   = 30 * time.Second
	terminalProfileRetry = 15 * time.Second
)

type webTransport struct {
	mu      sync.Mutex
	renewMu sync.Mutex

	insecure       bool
	pending        map[string]*pendingWebLogin
	forwardPending map[string]*pendingForwardAuthorization
	session        *webSession
	terminals      map[string]*webTerminal
	forwarder      *forwardManager
	emit           func(map[string]any)
}

type pendingWebLogin struct {
	request   loginRequest
	client    *http.Client
	baseURL   *url.URL
	ping      proxyPing
	challenge mfaChallenge
	browser   *browserMFACallback
}

type browserMFACallback struct {
	server    *http.Server
	listener  net.Listener
	key       []byte
	result    chan browserMFAResult
	closeOnce sync.Once
}

type browserMFAResult struct {
	credentialJSON string
	err            error
}

type webSession struct {
	client            *http.Client
	baseURL           *url.URL
	insecure          bool
	token             string
	tokenExpiresAt    time.Time
	expiresAt         time.Time
	username          string
	cluster           string
	sshIdentity       *persistedSSHIdentity
	sshProxyAddress   string
	tlsRoutingEnabled bool
}

type webTerminal struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	closed    sync.Once
	pong      chan struct{}
	done      chan struct{}
	profileID string
	session   *webSession
}

type persistedWebSession struct {
	Version           int                   `json:"version"`
	ProxyAddress      string                `json:"proxyAddress"`
	SessionCookie     string                `json:"sessionCookie"`
	Token             string                `json:"token"`
	TokenExpiresAt    time.Time             `json:"tokenExpiresAt"`
	ExpiresAt         time.Time             `json:"expiresAt"`
	Username          string                `json:"username"`
	Cluster           string                `json:"cluster"`
	Insecure          bool                  `json:"insecure"`
	SSHIdentity       *persistedSSHIdentity `json:"sshIdentity,omitempty"`
	SSHProxyAddress   string                `json:"sshProxyAddress,omitempty"`
	TLSRoutingEnabled bool                  `json:"tlsRoutingEnabled,omitempty"`
}

type proxyPing struct {
	ClusterName   string `json:"cluster_name"`
	ServerVersion string `json:"server_version"`
	FIPS          bool   `json:"fips"`
	Auth          struct {
		Type              string `json:"type"`
		SecondFactor      string `json:"second_factor"`
		PreferredLocalMFA string `json:"preferred_local_mfa"`
		AllowPasswordless bool   `json:"allow_passwordless"`
		Webauthn          *struct {
			RPID string `json:"rp_id"`
		} `json:"webauthn"`
	} `json:"auth"`
	Proxy struct {
		TLSRoutingEnabled bool `json:"tls_routing_enabled"`
		SSH               struct {
			ListenAddr    string `json:"listen_addr"`
			WebListenAddr string `json:"web_listen_addr"`
			PublicAddr    string `json:"public_addr"`
			SSHPublicAddr string `json:"ssh_public_addr"`
		} `json:"ssh"`
	} `json:"proxy"`
}

type mfaChallenge struct {
	WebauthnChallenge json.RawMessage `json:"webauthn_challenge"`
	TOTPChallenge     bool            `json:"totp_challenge"`
	BrowserChallenge  *struct {
		RequestID string `json:"requestId"`
	} `json:"browser_challenge"`
}

type webSessionResponse struct {
	TokenType              string    `json:"type"`
	Token                  string    `json:"token"`
	TokenExpiresIn         int       `json:"expires_in"`
	SessionExpiresIn       int       `json:"sessionExpiresIn"`
	SessionExpires         time.Time `json:"sessionExpires"`
	SessionInactiveTimeout int       `json:"sessionInactiveTimeout"`
}

type nodeListResponse struct {
	Items []uiServer `json:"items"`
}

type uiServer struct {
	ID       string    `json:"id"`
	SiteID   string    `json:"siteId"`
	Hostname string    `json:"hostname"`
	Addr     string    `json:"addr"`
	Tunnel   bool      `json:"tunnel"`
	Tags     []uiLabel `json:"tags"`
	Logins   []string  `json:"sshLogins"`
}

type uiLabel struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type terminalEnvelope struct {
	Version string
	Type    string
	Payload string
}

func newWebTransport(insecure bool) *webTransport {
	w := &webTransport{
		insecure:       insecure,
		pending:        make(map[string]*pendingWebLogin),
		forwardPending: make(map[string]*pendingForwardAuthorization),
		terminals:      make(map[string]*webTerminal),
	}
	w.forwarder = newForwardManager(teleportForwardDialer{}, w.sendEvent)
	return w
}

func (w *webTransport) beginLogin(requestJSON string) (string, error) {
	var request loginRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return "", fmt.Errorf("decode login request: %w", err)
	}
	request.ProxyAddress = strings.TrimSpace(request.ProxyAddress)
	request.Username = strings.TrimSpace(request.Username)
	if request.ProxyAddress == "" || request.Username == "" || request.Password == "" {
		return "", errors.New("proxy address, username, and password are required")
	}
	if request.Method != "passkey" && request.Method != "totp" {
		return "", errors.New("second factor must be passkey or totp")
	}

	baseURL, err := normalizeProxyURL(request.ProxyAddress)
	if err != nil {
		return "", err
	}
	insecure := w.insecure || request.Insecure
	client, err := newWebHTTPClient(insecure)
	if err != nil {
		return "", err
	}

	var ping proxyPing
	if err := doJSON(context.Background(), client, baseURL, http.MethodGet, "/webapi/ping", nil, "", "", &ping); err != nil {
		return "", fmt.Errorf("contact Teleport proxy: %w", err)
	}
	if ping.ClusterName == "" {
		return "", errors.New("the server did not identify itself as a Teleport proxy")
	}
	if ping.Auth.Type != "" && ping.Auth.Type != "local" {
		return "", fmt.Errorf("this first build supports local Teleport users; proxy authentication type is %q", ping.Auth.Type)
	}

	var browser *browserMFACallback
	if request.Method == "passkey" {
		browser, err = newBrowserMFACallback()
		if err != nil {
			return "", fmt.Errorf("start Browser MFA callback: %w", err)
		}
	}
	keepBrowser := false
	defer func() {
		if browser != nil && !keepBrowser {
			browser.close()
		}
	}()

	var challenge mfaChallenge
	beginRequest := map[string]string{
		"user": request.Username,
		"pass": request.Password,
	}
	if browser != nil {
		beginRequest["browser_mfa_tsh_redirect_url"] = browser.callbackURL()
	}
	if err := doJSON(context.Background(), client, baseURL, http.MethodPost, "/v1/webapi/mfa/login/begin", beginRequest, "", "", &challenge); err != nil {
		return "", fmt.Errorf("begin Teleport login: %w", err)
	}
	if request.Method == "totp" && !challenge.TOTPChallenge {
		return "", errors.New("this Teleport user does not have a TOTP challenge available")
	}
	if request.Method == "passkey" && (challenge.BrowserChallenge == nil || challenge.BrowserChallenge.RequestID == "") {
		return "", errors.New("this Teleport proxy does not offer Browser MFA; passkey login requires Teleport 18.8 or newer with CLI browser authentication enabled")
	}

	challengeID, err := randomID("challenge")
	if err != nil {
		return "", err
	}
	if request.Method == "passkey" {
		// Browser MFA no longer needs the password after the begin request.
		request.Password = ""
	}
	pending := &pendingWebLogin{
		request:   request,
		client:    client,
		baseURL:   baseURL,
		ping:      ping,
		challenge: challenge,
		browser:   browser,
	}
	w.mu.Lock()
	w.pending[challengeID] = pending
	w.mu.Unlock()

	if request.Method == "totp" {
		return marshal(map[string]any{
			"kind": "totp", "challengeId": challengeID, "digits": 6,
		})
	}

	browserURL := *baseURL
	browserURL.Path = "/web/mfa/browser/" + url.PathEscape(challenge.BrowserChallenge.RequestID)
	browserURL.RawQuery = ""
	browserURL.Fragment = ""
	keepBrowser = true
	return marshal(map[string]any{
		"kind":        "passkey",
		"challengeId": challengeID,
		"browserUrl":  browserURL.String(),
	})
}

func (w *webTransport) finishTOTP(challengeID, code string) (string, error) {
	if len(code) != 6 {
		return "", errors.New("enter the six-digit authenticator code")
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return "", errors.New("the authenticator code can contain only digits")
		}
	}
	pending, err := w.pendingLogin(challengeID, "totp")
	if err != nil {
		return "", err
	}

	csrfBytes := make([]byte, 32)
	if _, err := rand.Read(csrfBytes); err != nil {
		return "", fmt.Errorf("create CSRF token: %w", err)
	}
	csrfToken := hex.EncodeToString(csrfBytes)
	pending.client.Jar.SetCookies(pending.baseURL, []*http.Cookie{{
		Name: csrfCookieName, Value: csrfToken, Path: "/", Secure: true,
	}})

	var response webSessionResponse
	if err := doJSON(context.Background(), pending.client, pending.baseURL, http.MethodPost, "/v1/webapi/sessions/web", map[string]string{
		"user":                pending.request.Username,
		"pass":                pending.request.Password,
		"second_factor_token": code,
	}, "", csrfToken, &response); err != nil {
		return "", fmt.Errorf("complete TOTP login: %w", err)
	}
	return w.commitLogin(challengeID, pending, response)
}

func (w *webTransport) finishPasskey(challengeID, credentialJSON string) (string, error) {
	pending, err := w.pendingLogin(challengeID, "passkey")
	if err != nil {
		return "", err
	}
	committed := false
	defer func() {
		if !committed {
			w.forgetChallenge(challengeID)
		}
	}()
	if credentialJSON == "" {
		if pending.browser == nil {
			return "", errors.New("the Browser MFA callback is unavailable; start login again")
		}
		select {
		case result := <-pending.browser.result:
			if result.err != nil {
				w.forgetChallenge(challengeID)
				return "", result.err
			}
			credentialJSON = result.credentialJSON
		case <-time.After(browserMFATimeout):
			w.forgetChallenge(challengeID)
			return "", errors.New("timed out waiting for Browser MFA; start login again")
		}
	}
	var credential map[string]any
	if err := json.Unmarshal([]byte(credentialJSON), &credential); err != nil || len(credential) == 0 {
		return "", errors.New("a browser passkey assertion is required")
	}
	// Apple and Android expose the WebAuthn extension results under this name.
	// Teleport's assertion type expects the W3C JSON field `extensions`.
	if extensions, ok := credential["clientExtensionResults"]; ok {
		if _, exists := credential["extensions"]; !exists {
			credential["extensions"] = extensions
		}
		delete(credential, "clientExtensionResults")
	}

	var response webSessionResponse
	if err := doJSON(context.Background(), pending.client, pending.baseURL, http.MethodPost, "/v1/webapi/mfa/login/finishsession", map[string]any{
		"user":                      pending.request.Username,
		"webauthnAssertionResponse": credential,
	}, "", "", &response); err != nil {
		return "", fmt.Errorf("complete passkey login: %w", err)
	}
	profile, err := w.commitLogin(challengeID, pending, response)
	if err != nil {
		return "", err
	}
	committed = true
	return profile, nil
}

func (w *webTransport) commitLogin(challengeID string, pending *pendingWebLogin, response webSessionResponse) (string, error) {
	if response.Token == "" {
		return "", errors.New("Teleport returned an empty web session token")
	}
	if !hasCookie(pending.client.Jar.Cookies(pending.baseURL), sessionCookieName) {
		return "", errors.New("Teleport did not return a web session cookie")
	}
	now := time.Now()
	tokenExpiresAt := bearerTokenExpiry(now, response.TokenExpiresIn)
	expiresAt := response.SessionExpires
	if expiresAt.IsZero() && response.SessionExpiresIn > 0 {
		expiresAt = now.Add(time.Duration(response.SessionExpiresIn) * time.Second)
	}
	if expiresAt.IsZero() {
		expiresAt = tokenExpiresAt
	}
	session := &webSession{
		client:            pending.client,
		baseURL:           pending.baseURL,
		insecure:          w.insecure || pending.request.Insecure,
		token:             response.Token,
		tokenExpiresAt:    tokenExpiresAt,
		expiresAt:         expiresAt,
		username:          pending.request.Username,
		cluster:           pending.ping.ClusterName,
		sshProxyAddress:   resolveSSHProxyAddress(pending.baseURL, pending.ping),
		tlsRoutingEnabled: pending.ping.Proxy.TLSRoutingEnabled,
	}

	w.renewMu.Lock()
	w.mu.Lock()
	delete(w.pending, challengeID)
	pending.request.Password = ""
	w.session = session
	w.mu.Unlock()
	w.renewMu.Unlock()
	if pending.browser != nil {
		pending.browser.close()
	}

	profile := authenticatedProfile{
		ProxyAddress: pending.request.ProxyAddress,
		Username:     session.username,
		ClusterName:  session.cluster,
		ValidUntil:   session.expiresAt.UTC().Format(time.RFC3339),
	}
	return marshal(profile)
}

func (w *webTransport) listServers() (string, error) {
	session, err := w.freshSession()
	if err != nil {
		return "", err
	}
	endpoint := "/v1/webapi/sites/" + url.PathEscape(session.cluster) + "/nodes?limit=200"
	var response nodeListResponse
	if err := doJSON(context.Background(), session.client, session.baseURL, http.MethodGet, endpoint, nil, session.token, "", &response); err != nil {
		if hasHTTPStatus(err, http.StatusUnauthorized) {
			return "", errors.New("the Teleport login has expired; authenticate again")
		}
		return "", fmt.Errorf("list Teleport servers: %w", err)
	}
	servers := make([]map[string]any, 0, len(response.Items))
	for _, server := range response.Items {
		labels := make(map[string]string, len(server.Tags))
		for _, label := range server.Tags {
			labels[label.Name] = label.Value
		}
		logins := server.Logins
		if logins == nil {
			logins = []string{}
		}
		address := server.Addr
		if server.Tunnel || address == "" {
			address = "tunnel"
		}
		servers = append(servers, map[string]any{
			"id":       server.ID,
			"hostname": server.Hostname,
			"address":  address,
			"labels":   labels,
			"logins":   logins,
			"status":   "online",
		})
	}
	return marshal(servers)
}

func (w *webTransport) exportSession() (string, error) {
	session, err := w.freshSession()
	if err != nil {
		return "", err
	}
	return persistedSessionJSON(session)
}

func persistedSessionJSON(session *webSession) (string, error) {
	cookie, err := findCookie(session.client.Jar.Cookies(session.baseURL), sessionCookieName)
	if err != nil {
		return "", err
	}
	return marshal(persistedWebSession{
		Version:           2,
		ProxyAddress:      session.baseURL.String(),
		SessionCookie:     cookie.Value,
		Token:             session.token,
		TokenExpiresAt:    session.tokenExpiresAt,
		ExpiresAt:         session.expiresAt,
		Username:          session.username,
		Cluster:           session.cluster,
		Insecure:          session.insecure,
		SSHIdentity:       session.sshIdentity,
		SSHProxyAddress:   session.sshProxyAddress,
		TLSRoutingEnabled: session.tlsRoutingEnabled,
	})
}

func (w *webTransport) restoreSession(snapshotJSON string) (string, error) {
	var snapshot persistedWebSession
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		return "", fmt.Errorf("decode saved Teleport login: %w", err)
	}
	if (snapshot.Version != 1 && snapshot.Version != 2) || snapshot.SessionCookie == "" || snapshot.Token == "" || snapshot.Username == "" || snapshot.Cluster == "" {
		return "", errors.New("the saved Teleport login is incomplete")
	}
	if snapshot.ExpiresAt.IsZero() || time.Now().After(snapshot.ExpiresAt) {
		return "", errors.New("the saved Teleport login has expired")
	}
	baseURL, err := normalizeProxyURL(snapshot.ProxyAddress)
	if err != nil {
		return "", fmt.Errorf("restore Teleport proxy: %w", err)
	}
	client, err := newWebHTTPClient(snapshot.Insecure)
	if err != nil {
		return "", err
	}
	client.Jar.SetCookies(baseURL, []*http.Cookie{{
		Name: sessionCookieName, Value: snapshot.SessionCookie, Path: "/", Secure: true, HttpOnly: true,
	}})
	session := &webSession{
		client:            client,
		baseURL:           baseURL,
		insecure:          snapshot.Insecure,
		token:             snapshot.Token,
		tokenExpiresAt:    snapshot.TokenExpiresAt,
		expiresAt:         snapshot.ExpiresAt,
		username:          snapshot.Username,
		cluster:           snapshot.Cluster,
		sshIdentity:       snapshot.SSHIdentity,
		sshProxyAddress:   snapshot.SSHProxyAddress,
		tlsRoutingEnabled: snapshot.TLSRoutingEnabled,
	}
	w.renewMu.Lock()
	defer w.renewMu.Unlock()
	w.mu.Lock()
	current := w.session
	if current != nil && sameSessionIdentity(current, session) &&
		time.Now().Before(current.expiresAt) &&
		!snapshot.TokenExpiresAt.After(current.tokenExpiresAt) {
		w.mu.Unlock()
		return marshal(profileForWebSession(current))
	}
	w.session = session
	w.mu.Unlock()
	return marshal(profileForWebSession(session))
}

func (w *webTransport) logout() {
	w.forwarder.stopAll("Signed out")
	w.renewMu.Lock()
	w.mu.Lock()
	w.session = nil
	for _, pending := range w.pending {
		pending.request.Password = ""
		if pending.browser != nil {
			pending.browser.close()
		}
	}
	for _, pending := range w.forwardPending {
		pending.password = ""
		pending.request.Password = ""
		if pending.browser != nil {
			pending.browser.close()
		}
	}
	w.pending = make(map[string]*pendingWebLogin)
	w.forwardPending = make(map[string]*pendingForwardAuthorization)
	terminals := w.terminals
	w.terminals = make(map[string]*webTerminal)
	w.mu.Unlock()
	w.renewMu.Unlock()
	for _, terminal := range terminals {
		_ = terminal.conn.Close()
	}
}

func (w *webTransport) openSession(targetJSON string) (string, error) {
	var target sessionTarget
	if err := json.Unmarshal([]byte(targetJSON), &target); err != nil {
		return "", fmt.Errorf("decode session target: %w", err)
	}
	if target.ServerID == "" || target.Hostname == "" || target.Login == "" {
		return "", errors.New("server, hostname, and login are required")
	}
	if target.Columns < 1 || target.Rows < 1 {
		return "", errors.New("terminal size must be positive")
	}
	session, err := w.freshSession()
	if err != nil {
		return "", err
	}

	params, err := json.Marshal(map[string]any{
		"server_id": target.ServerID,
		"login":     target.Login,
		"sid":       "",
		"term": map[string]int{
			"w": target.Columns,
			"h": target.Rows,
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode terminal request: %w", err)
	}
	wsURL := *session.baseURL
	wsURL.Scheme = "wss"
	wsURL.Path = "/v1/webapi/sites/" + url.PathEscape(session.cluster) + "/connect/ws"
	query := wsURL.Query()
	query.Set("params", string(params))
	wsURL.RawQuery = query.Encode()

	dialer := websocket.Dialer{
		HandshakeTimeout: websocketAuthTimeout,
		TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: session.insecure, // #nosec G402 -- explicit user opt-in matching tsh --insecure.
		},
	}
	header := http.Header{}
	if cookieHeader := formatCookies(session.client.Jar.Cookies(session.baseURL)); cookieHeader != "" {
		header.Set("Cookie", cookieHeader)
	}
	ctx, cancel := context.WithTimeout(context.Background(), websocketAuthTimeout)
	defer cancel()
	conn, response, err := dialer.DialContext(ctx, wsURL.String(), header)
	if err != nil {
		if response != nil {
			defer response.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(response.Body, 16<<10))
			return "", fmt.Errorf("open Teleport terminal: HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
		}
		return "", fmt.Errorf("open Teleport terminal: %w", err)
	}

	if err := conn.WriteJSON(map[string]string{"token": session.token}); err != nil {
		conn.Close()
		return "", fmt.Errorf("authenticate Teleport terminal: %w", err)
	}
	conn.SetReadDeadline(time.Now().Add(websocketAuthTimeout))
	_, authData, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return "", fmt.Errorf("read Teleport terminal authentication: %w", err)
	}
	var authResponse struct {
		Type    string `json:"type"`
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(authData, &authResponse); err != nil {
		conn.Close()
		return "", fmt.Errorf("decode Teleport terminal authentication: %w", err)
	}
	if authResponse.Type != "create_session_response" || authResponse.Status != "ok" {
		conn.Close()
		if authResponse.Message == "" {
			authResponse.Message = "Teleport rejected the terminal session"
		}
		return "", errors.New(authResponse.Message)
	}
	conn.SetReadDeadline(time.Time{})

	sessionID, err := randomID("session")
	if err != nil {
		conn.Close()
		return "", err
	}
	terminal := &webTerminal{
		conn:      conn,
		pong:      make(chan struct{}, 1),
		done:      make(chan struct{}),
		profileID: target.ProfileID,
		session:   session,
	}
	conn.SetPongHandler(func(string) error {
		select {
		case terminal.pong <- struct{}{}:
		default:
		}
		return nil
	})
	w.mu.Lock()
	w.terminals[sessionID] = terminal
	w.mu.Unlock()
	go w.readTerminal(sessionID, terminal)
	go w.keepTerminalSessionFresh(terminal)

	return marshal(map[string]any{"id": sessionID, "target": target})
}

func (w *webTransport) writeSession(sessionID, data string) error {
	terminal, err := w.terminal(sessionID)
	if err != nil {
		return err
	}
	return terminal.writeEnvelope("r", data)
}

func (w *webTransport) resizeSession(sessionID string, columns, rows int) error {
	if columns < 1 || rows < 1 {
		return errors.New("terminal size must be positive")
	}
	terminal, err := w.terminal(sessionID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"event":  "resize",
		"width":  columns,
		"height": rows,
		"size":   strconv.Itoa(columns) + ":" + strconv.Itoa(rows),
	})
	if err != nil {
		return err
	}
	return terminal.writeEnvelope("w", string(payload))
}

func (w *webTransport) pingSession(sessionID string) error {
	terminal, err := w.terminal(sessionID)
	if err != nil {
		return err
	}
	for {
		select {
		case <-terminal.pong:
		default:
			goto drained
		}
	}

drained:
	deadline := time.Now().Add(4 * time.Second)
	terminal.writeMu.Lock()
	err = terminal.conn.WriteControl(websocket.PingMessage, []byte("telemob"), deadline)
	terminal.writeMu.Unlock()
	if err != nil {
		return fmt.Errorf("ping terminal: %w", err)
	}
	select {
	case <-terminal.pong:
		return nil
	case <-time.After(time.Until(deadline)):
		return errors.New("terminal did not answer a liveness check")
	}
}

func (w *webTransport) closeSession(sessionID string) {
	w.mu.Lock()
	terminal, ok := w.terminals[sessionID]
	delete(w.terminals, sessionID)
	w.mu.Unlock()
	if !ok {
		return
	}
	terminal.closed.Do(func() {
		close(terminal.done)
		terminal.writeMu.Lock()
		_ = terminal.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "closed on device"), time.Now().Add(time.Second))
		terminal.writeMu.Unlock()
		_ = terminal.conn.Close()
		w.sendEvent(map[string]any{"type": "closed", "sessionId": sessionID, "reason": "Closed on device"})
	})
}

func (w *webTransport) readTerminal(sessionID string, terminal *webTerminal) {
	for {
		messageType, data, err := terminal.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				w.finishTerminal(sessionID, terminal, "Remote session closed", "")
			} else {
				w.finishTerminal(sessionID, terminal, "Terminal connection ended", err.Error())
			}
			return
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		envelope, err := decodeEnvelope(data)
		if err != nil {
			w.finishTerminal(sessionID, terminal, "Terminal protocol error", err.Error())
			return
		}
		switch envelope.Type {
		case "r":
			w.sendEvent(map[string]any{"type": "data", "sessionId": sessionID, "data": envelope.Payload})
		case "c":
			w.finishTerminal(sessionID, terminal, "Remote session closed", "")
			return
		case "e":
			w.finishTerminal(sessionID, terminal, "Terminal error", envelope.Payload)
			return
		case "n":
			w.finishTerminal(sessionID, terminal, "Additional verification required", "This server requires per-session passkey verification, which is not available in the first terminal build.")
			return
		}
	}
}

func (w *webTransport) finishTerminal(sessionID string, terminal *webTerminal, reason, errorMessage string) {
	terminal.closed.Do(func() {
		close(terminal.done)
		_ = terminal.conn.Close()
		w.mu.Lock()
		if current, ok := w.terminals[sessionID]; ok && current == terminal {
			delete(w.terminals, sessionID)
		}
		w.mu.Unlock()
		if errorMessage != "" {
			w.sendEvent(map[string]any{"type": "error", "sessionId": sessionID, "message": errorMessage})
		}
		w.sendEvent(map[string]any{"type": "closed", "sessionId": sessionID, "reason": reason})
	})
}

func (w *webTransport) keepTerminalSessionFresh(terminal *webTerminal) {
	for {
		w.mu.Lock()
		current := w.session
		w.mu.Unlock()

		wait := terminalProfileRetry
		if current != nil && sameSessionIdentity(current, terminal.session) {
			wait = time.Until(current.tokenExpiresAt.Add(-renewBeforeExpiry))
			if wait < time.Second {
				wait = time.Second
			}
		}

		if !waitForTerminalRetry(terminal.done, wait) {
			return
		}

		w.mu.Lock()
		before := w.session
		w.mu.Unlock()
		if before == nil || !sameSessionIdentity(before, terminal.session) {
			continue
		}

		renewed, err := w.freshSession()
		if err != nil {
			if strings.Contains(err.Error(), "login has expired") {
				return
			}
			if !waitForTerminalRetry(terminal.done, terminalRenewRetry) {
				return
			}
			continue
		}
		if renewed == before || !sameSessionIdentity(renewed, terminal.session) {
			continue
		}
		snapshot, err := persistedSessionJSON(renewed)
		if err != nil {
			continue
		}
		w.sendEvent(map[string]any{
			"type":      "session",
			"profileId": terminal.profileID,
			"snapshot":  snapshot,
			"profile":   profileForWebSession(renewed),
		})
	}
}

func waitForTerminalRetry(done <-chan struct{}, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-done:
		return false
	case <-timer.C:
		return true
	}
}

func (w *webTransport) freshSession() (*webSession, error) {
	w.renewMu.Lock()
	defer w.renewMu.Unlock()

	w.mu.Lock()
	session := w.session
	w.mu.Unlock()
	if session == nil {
		return nil, errors.New("authenticate before requesting Teleport resources")
	}
	if !session.expiresAt.IsZero() && time.Now().After(session.expiresAt) {
		return nil, errors.New("the Teleport login has expired; authenticate again")
	}
	if time.Until(session.tokenExpiresAt) > renewBeforeExpiry {
		return session, nil
	}

	var response webSessionResponse
	if err := doJSON(context.Background(), session.client, session.baseURL, http.MethodPost, "/v1/webapi/sessions/web/renew", map[string]any{}, session.token, "", &response); err != nil {
		if hasHTTPStatus(err, http.StatusUnauthorized, http.StatusForbidden) {
			return nil, errors.New("the Teleport login has expired; authenticate again")
		}
		return nil, fmt.Errorf("renew Teleport login: %w", err)
	}
	if response.Token == "" {
		return nil, errors.New("Teleport returned an empty renewed session token")
	}
	now := time.Now()
	tokenExpiresAt := bearerTokenExpiry(now, response.TokenExpiresIn)
	expiresAt := response.SessionExpires
	if expiresAt.IsZero() && response.SessionExpiresIn > 0 {
		expiresAt = now.Add(time.Duration(response.SessionExpiresIn) * time.Second)
	}
	if expiresAt.IsZero() {
		expiresAt = session.expiresAt
	}
	renewed := &webSession{
		client:            session.client,
		baseURL:           session.baseURL,
		insecure:          session.insecure,
		token:             response.Token,
		tokenExpiresAt:    tokenExpiresAt,
		expiresAt:         expiresAt,
		username:          session.username,
		cluster:           session.cluster,
		sshIdentity:       session.sshIdentity,
		sshProxyAddress:   session.sshProxyAddress,
		tlsRoutingEnabled: session.tlsRoutingEnabled,
	}
	w.mu.Lock()
	if w.session == session {
		w.session = renewed
		session = renewed
	}
	w.mu.Unlock()
	return session, nil
}

func bearerTokenExpiry(now time.Time, expiresIn int) time.Time {
	if expiresIn <= 0 {
		return now.Add(5 * time.Minute)
	}
	return now.Add(time.Duration(expiresIn) * time.Second)
}

func sameSessionIdentity(left, right *webSession) bool {
	return left.baseURL.String() == right.baseURL.String() &&
		left.username == right.username &&
		left.cluster == right.cluster &&
		left.insecure == right.insecure
}

func profileForWebSession(session *webSession) authenticatedProfile {
	return authenticatedProfile{
		ProxyAddress: session.baseURL.String(),
		Username:     session.username,
		ClusterName:  session.cluster,
		ValidUntil:   session.expiresAt.UTC().Format(time.RFC3339),
	}
}

func resolveSSHProxyAddress(baseURL *url.URL, ping proxyPing) string {
	if ping.Proxy.TLSRoutingEnabled {
		if baseURL.Port() != "" {
			return baseURL.Host
		}
		return net.JoinHostPort(baseURL.Hostname(), "443")
	}
	if value := strings.TrimSpace(ping.Proxy.SSH.SSHPublicAddr); value != "" {
		return hostPortWithDefault(value, "3023")
	}
	host := baseURL.Hostname()
	if value := strings.TrimSpace(ping.Proxy.SSH.PublicAddr); value != "" {
		if parsedHost, _, err := net.SplitHostPort(value); err == nil {
			host = parsedHost
		} else if !strings.Contains(value, ":") {
			host = value
		}
	}
	port := "3023"
	if _, parsedPort, err := net.SplitHostPort(ping.Proxy.SSH.ListenAddr); err == nil && parsedPort != "" {
		port = parsedPort
	}
	return net.JoinHostPort(strings.Trim(host, "[]"), port)
}

func hostPortWithDefault(address, defaultPort string) string {
	if host, port, err := net.SplitHostPort(address); err == nil && port != "" {
		return net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	return net.JoinHostPort(strings.Trim(address, "[]"), defaultPort)
}

func (w *webTransport) pendingLogin(challengeID, method string) (*pendingWebLogin, error) {
	w.mu.Lock()
	pending := w.pending[challengeID]
	w.mu.Unlock()
	if pending == nil || pending.request.Method != method {
		return nil, errors.New("the authentication challenge is missing or expired")
	}
	return pending, nil
}

func (w *webTransport) forgetChallenge(challengeID string) {
	w.mu.Lock()
	pending := w.pending[challengeID]
	delete(w.pending, challengeID)
	w.mu.Unlock()
	if pending == nil {
		return
	}
	pending.request.Password = ""
	if pending.browser != nil {
		pending.browser.close()
	}
}

func newBrowserMFACallback() (*browserMFACallback, error) {
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate callback secret: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	callback := &browserMFACallback{
		listener: listener,
		key:      key,
		result:   make(chan browserMFAResult, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", callback.handle)
	callback.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: requestTimeout,
		WriteTimeout:      requestTimeout,
		IdleTimeout:       requestTimeout,
	}
	go func() {
		if err := callback.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			callback.deliver(browserMFAResult{err: fmt.Errorf("Browser MFA callback failed: %w", err)})
		}
	}()
	return callback, nil
}

func (b *browserMFACallback) callbackURL() string {
	return (&url.URL{
		Scheme:   "http",
		Host:     b.listener.Addr().String(),
		Path:     "/callback",
		RawQuery: url.Values{"secret_key": {hex.EncodeToString(b.key)}}.Encode(),
	}).String()
}

func (b *browserMFACallback) handle(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Access-Control-Allow-Origin", "*")
	response.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusOK)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if err := request.ParseForm(); err != nil {
		b.fail(response, fmt.Errorf("read Browser MFA callback: %w", err))
		return
	}
	if callbackError := request.Form.Get("err"); callbackError != "" {
		b.fail(response, fmt.Errorf("Browser MFA failed: %s", callbackError))
		return
	}
	plaintext, err := openBrowserMFAResponse(b.key, []byte(request.Form.Get("response")))
	if err != nil {
		b.fail(response, fmt.Errorf("decrypt Browser MFA response: %w", err))
		return
	}
	var loginResponse struct {
		WebauthnResponse json.RawMessage `json:"browser_mfa_webauthn_response"`
	}
	if err := json.Unmarshal(plaintext, &loginResponse); err != nil || len(loginResponse.WebauthnResponse) == 0 || bytes.Equal(loginResponse.WebauthnResponse, []byte("null")) {
		b.fail(response, errors.New("Teleport returned an invalid Browser MFA response"))
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(response, "<!doctype html><meta name=viewport content='width=device-width'><title>Telemob</title><body style='font-family:system-ui;padding:32px;background:#08111f;color:#eaf2ff'><h1>Authentication complete</h1><p>You can return to Telemob.</p></body>")
	b.deliver(browserMFAResult{credentialJSON: string(loginResponse.WebauthnResponse)})
}

func (b *browserMFACallback) fail(response http.ResponseWriter, err error) {
	http.Error(response, "Browser MFA failed. Return to Telemob and try again.", http.StatusBadRequest)
	b.deliver(browserMFAResult{err: err})
}

func (b *browserMFACallback) deliver(result browserMFAResult) {
	select {
	case b.result <- result:
	default:
	}
}

func (b *browserMFACallback) close() {
	b.closeOnce.Do(func() {
		_ = b.server.Close()
	})
}

func openBrowserMFAResponse(key, encrypted []byte) ([]byte, error) {
	var sealed struct {
		Ciphertext []byte `json:"ciphertext"`
		Nonce      []byte `json:"nonce"`
	}
	if err := json.Unmarshal(encrypted, &sealed); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed.Nonce) != aead.NonceSize() {
		return nil, errors.New("invalid Browser MFA nonce")
	}
	return aead.Open(nil, sealed.Nonce, sealed.Ciphertext, nil)
}

func (w *webTransport) terminal(sessionID string) (*webTerminal, error) {
	w.mu.Lock()
	terminal := w.terminals[sessionID]
	w.mu.Unlock()
	if terminal == nil {
		return nil, errors.New("session is not open")
	}
	return terminal, nil
}

func (w *webTransport) sendEvent(event map[string]any) {
	if w.emit != nil {
		w.emit(event)
	}
}

func (t *webTerminal) writeEnvelope(messageType, payload string) error {
	encoded := encodeEnvelope(terminalEnvelope{Version: "1", Type: messageType, Payload: payload})
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if err := t.conn.WriteMessage(websocket.BinaryMessage, encoded); err != nil {
		return fmt.Errorf("write terminal data: %w", err)
	}
	return nil
}

func normalizeProxyURL(address string) (*url.URL, error) {
	value := strings.TrimSpace(address)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("parse proxy address: %w", err)
	}
	if parsed.Scheme != "https" {
		return nil, errors.New("the Teleport proxy address must use HTTPS")
	}
	if parsed.Hostname() == "" {
		return nil, errors.New("enter a valid Teleport proxy address")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("enter the Teleport proxy host without a path, query, or credentials")
	}
	parsed.Path = ""
	return parsed, nil
}

func newWebHTTPClient(insecure bool) (*http.Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("create session cookie store: %w", err)
	}
	return &http.Client{
		Jar:     jar,
		Timeout: requestTimeout,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: insecure, // #nosec G402 -- explicit user opt-in matching tsh --insecure.
		}},
	}, nil
}

func doJSON(ctx context.Context, client *http.Client, baseURL *url.URL, method, endpoint string, body any, bearerToken, csrfToken string, out any) error {
	requestURL := *baseURL
	path, rawQuery, _ := strings.Cut(endpoint, "?")
	requestURL.Path = path
	requestURL.RawQuery = rawQuery
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), reader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		request.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	if csrfToken != "" {
		request.Header.Set(csrfHeaderName, csrfToken)
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeHTTPError(response.StatusCode, responseBody)
	}
	if out == nil || len(bytes.TrimSpace(responseBody)) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func decodeHTTPError(status int, body []byte) error {
	var response struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &response)
	message := response.Error.Message
	if message == "" {
		message = response.Message
	}
	if message == "" {
		message = strings.TrimSpace(string(body))
	}
	if message == "" {
		message = http.StatusText(status)
	}
	return &httpResponseError{status: status, message: message}
}

type httpResponseError struct {
	status  int
	message string
}

func (e *httpResponseError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.status, e.message)
}

func hasHTTPStatus(err error, statuses ...int) bool {
	var responseError *httpResponseError
	if !errors.As(err, &responseError) {
		return false
	}
	for _, status := range statuses {
		if responseError.status == status {
			return true
		}
	}
	return false
}

func hasCookie(cookies []*http.Cookie, name string) bool {
	for _, cookie := range cookies {
		if cookie.Name == name && cookie.Value != "" {
			return true
		}
	}
	return false
}

func findCookie(cookies []*http.Cookie, name string) (*http.Cookie, error) {
	for _, cookie := range cookies {
		if cookie.Name == name && cookie.Value != "" {
			return cookie, nil
		}
	}
	return nil, fmt.Errorf("Teleport session cookie %q is missing", name)
}

func formatCookies(cookies []*http.Cookie) string {
	values := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		values = append(values, cookie.Name+"="+cookie.Value)
	}
	return strings.Join(values, "; ")
}

func encodeEnvelope(envelope terminalEnvelope) []byte {
	encoded := make([]byte, 0, len(envelope.Payload)+12)
	encoded = appendProtoString(encoded, 1, envelope.Version)
	encoded = appendProtoString(encoded, 2, envelope.Type)
	encoded = appendProtoString(encoded, 3, envelope.Payload)
	return encoded
}

func appendProtoString(encoded []byte, fieldNumber byte, value string) []byte {
	encoded = append(encoded, fieldNumber<<3|2)
	encoded = appendVarint(encoded, uint64(len(value)))
	return append(encoded, value...)
}

func appendVarint(encoded []byte, value uint64) []byte {
	for value >= 0x80 {
		encoded = append(encoded, byte(value)|0x80)
		value >>= 7
	}
	return append(encoded, byte(value))
}

func decodeEnvelope(data []byte) (terminalEnvelope, error) {
	var envelope terminalEnvelope
	for len(data) > 0 {
		key, consumed, err := readVarint(data)
		if err != nil {
			return envelope, err
		}
		data = data[consumed:]
		if key&7 != 2 {
			return envelope, fmt.Errorf("unsupported protobuf wire type %d", key&7)
		}
		length, consumed, err := readVarint(data)
		if err != nil {
			return envelope, err
		}
		data = data[consumed:]
		if length > uint64(len(data)) {
			return envelope, errors.New("truncated terminal envelope")
		}
		value := string(data[:int(length)])
		data = data[int(length):]
		switch key >> 3 {
		case 1:
			envelope.Version = value
		case 2:
			envelope.Type = value
		case 3:
			envelope.Payload = value
		}
	}
	if envelope.Version != "1" {
		return envelope, fmt.Errorf("unsupported terminal protocol version %q", envelope.Version)
	}
	if envelope.Type == "" {
		return envelope, errors.New("terminal envelope is missing a message type")
	}
	return envelope, nil
}

func readVarint(data []byte) (uint64, int, error) {
	var value uint64
	for index, current := range data {
		if index == 10 {
			return 0, 0, errors.New("protobuf varint is too long")
		}
		value |= uint64(current&0x7f) << (7 * index)
		if current&0x80 == 0 {
			return value, index + 1, nil
		}
	}
	return 0, 0, errors.New("truncated protobuf varint")
}
