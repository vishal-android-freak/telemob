// Package teleportmobile is the platform-neutral state and transport boundary
// exported to iOS and Android with gomobile bind.
package teleportmobile

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// EventSink is implemented by the Swift and Kotlin bridges. Keeping a single
// JSON event callback makes the generated gomobile API stable as event types
// evolve.
type EventSink interface {
	OnTerminalEvent(eventJSON string)
}

type Core struct {
	mu          sync.Mutex
	sink        EventSink
	web         *webTransport
	development bool
	challenges  map[string]loginRequest
	profile     *authenticatedProfile
	sessions    map[string]sessionTarget
	outputs     map[string]*sessionOutputRecord
	outputOrder []string
}

const (
	maxSessionOutputBytes   = 1 << 20
	maxSessionOutputRecords = 8
)

type sessionOutputChunk struct {
	Sequence int64  `json:"sequence"`
	Data     string `json:"data"`
}

type sessionOutputRecord struct {
	Open             bool
	LatestSequence   int64
	DiscardedThrough int64
	Bytes            int
	Chunks           []sessionOutputChunk
	Reason           string
	Error            string
}

type loginRequest struct {
	ProxyAddress string `json:"proxyAddress"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	Method       string `json:"method"`
	Insecure     bool   `json:"insecure"`
}

type authenticatedProfile struct {
	ProxyAddress string `json:"proxyAddress"`
	Username     string `json:"username"`
	ClusterName  string `json:"clusterName"`
	ValidUntil   string `json:"validUntil"`
}

type sessionTarget struct {
	ServerID string `json:"serverId"`
	Hostname string `json:"hostname"`
	Login    string `json:"login"`
	Columns  int    `json:"columns"`
	Rows     int    `json:"rows"`
}

func NewCore() *Core {
	c := &Core{
		web:        newWebTransport(false),
		challenges: make(map[string]loginRequest),
		sessions:   make(map[string]sessionTarget),
		outputs:    make(map[string]*sessionOutputRecord),
	}
	c.web.emit = c.emit
	return c
}

// NewDevelopmentCore returns the deterministic transport used by unit tests
// and the Expo UI preview. Production native builds use NewCore.
func NewDevelopmentCore() *Core {
	return &Core{
		development: true,
		challenges:  make(map[string]loginRequest),
		sessions:    make(map[string]sessionTarget),
		outputs:     make(map[string]*sessionOutputRecord),
	}
}

func (c *Core) SetEventSink(sink EventSink) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sink = sink
}

func (c *Core) CapabilitiesJSON() string {
	if c.development {
		return `{"nativeCoreLinked":true,"passkey":true,"totp":true,"developmentDriver":true}`
	}
	return `{"nativeCoreLinked":true,"passkey":true,"totp":true,"developmentDriver":false}`
}

func (c *Core) ExportSessionJSON() (string, error) {
	if !c.development {
		return c.web.exportSession()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.profile == nil {
		return "", errors.New("there is no Teleport login to save")
	}
	return marshal(map[string]any{"version": 1, "development": true, "profile": c.profile})
}

func (c *Core) RestoreSessionJSON(snapshotJSON string) (string, error) {
	if !c.development {
		return c.web.restoreSession(snapshotJSON)
	}
	var snapshot struct {
		Version     int                   `json:"version"`
		Development bool                  `json:"development"`
		Profile     *authenticatedProfile `json:"profile"`
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		return "", fmt.Errorf("decode saved development login: %w", err)
	}
	if snapshot.Version != 1 || !snapshot.Development || snapshot.Profile == nil {
		return "", errors.New("the saved development login is invalid")
	}
	if expires, err := time.Parse(time.RFC3339, snapshot.Profile.ValidUntil); err != nil || time.Now().After(expires) {
		return "", errors.New("the saved development login has expired")
	}
	c.mu.Lock()
	c.profile = snapshot.Profile
	c.mu.Unlock()
	return marshal(snapshot.Profile)
}

func (c *Core) Logout() {
	if !c.development {
		c.web.logout()
		c.mu.Lock()
		c.outputs = make(map[string]*sessionOutputRecord)
		c.outputOrder = nil
		c.mu.Unlock()
		return
	}
	c.mu.Lock()
	c.profile = nil
	c.challenges = make(map[string]loginRequest)
	c.sessions = make(map[string]sessionTarget)
	c.outputs = make(map[string]*sessionOutputRecord)
	c.outputOrder = nil
	c.mu.Unlock()
}

// BeginLoginJSON creates the same challenge contract that the real Teleport
// adapter will populate from the proxy's SSH login challenge.
func (c *Core) BeginLoginJSON(requestJSON string) (string, error) {
	if !c.development {
		return c.web.beginLogin(requestJSON)
	}
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

	id, err := randomID("challenge")
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.challenges[id] = request
	c.mu.Unlock()

	if request.Method == "totp" {
		return marshal(map[string]any{
			"kind": "totp", "challengeId": id, "digits": 6,
		})
	}
	return marshal(map[string]any{
		"kind":        "passkey",
		"challengeId": id,
		"browserUrl":  "https://" + strings.TrimSuffix(request.ProxyAddress, "/") + "/web/mfa/browser/development-request",
	})
}

func (c *Core) FinishTOTP(challengeID, code string) (string, error) {
	if !c.development {
		return c.web.finishTOTP(challengeID, code)
	}
	if len(code) != 6 {
		return "", errors.New("enter the six-digit authenticator code")
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return "", errors.New("the authenticator code can contain only digits")
		}
	}
	return c.finishLogin(challengeID, "totp")
}

// FinishPasskey waits for the encrypted assertion returned to the local
// callback by Teleport's Browser MFA page.
func (c *Core) FinishPasskey(challengeID, credentialJSON string) (string, error) {
	if !c.development {
		return c.web.finishPasskey(challengeID, credentialJSON)
	}
	return c.finishLogin(challengeID, "passkey")
}

func (c *Core) ListServersJSON() (string, error) {
	if !c.development {
		return c.web.listServers()
	}
	if err := c.requireProfile(); err != nil {
		return "", err
	}
	return marshal([]map[string]any{
		{
			"id": "srv-atlas", "hostname": "atlas-build-01", "address": "tunnel",
			"labels": map[string]string{"env": "dev", "region": "blr", "role": "builder"},
			"logins": []string{"ubuntu", "root"}, "status": "online",
		},
		{
			"id": "srv-kepler", "hostname": "kepler-api-02", "address": "tunnel",
			"labels": map[string]string{"env": "test", "region": "bom", "role": "api"},
			"logins": []string{"ubuntu", "deploy"}, "status": "online",
		},
	})
}

func (c *Core) OpenSessionJSON(targetJSON string) (string, error) {
	if !c.development {
		result, err := c.web.openSession(targetJSON)
		if err != nil {
			return "", err
		}
		var session struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(result), &session); err != nil {
			return "", fmt.Errorf("decode opened session: %w", err)
		}
		c.prepareSessionOutput(session.ID)
		return result, nil
	}
	if err := c.requireProfile(); err != nil {
		return "", err
	}
	var target sessionTarget
	if err := json.Unmarshal([]byte(targetJSON), &target); err != nil {
		return "", fmt.Errorf("decode session target: %w", err)
	}
	if target.ServerID == "" || target.Hostname == "" || target.Login == "" {
		return "", errors.New("server, hostname, and login are required")
	}
	id, err := randomID("session")
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.sessions[id] = target
	c.mu.Unlock()
	c.prepareSessionOutput(id)

	result, err := marshal(map[string]any{"id": id, "target": target})
	if err != nil {
		return "", err
	}
	c.emit(map[string]any{
		"type": "data", "sessionId": id,
		"data": fmt.Sprintf("Connected through Teleport\r\n%s@%s:~$ ", target.Login, target.Hostname),
	})
	return result, nil
}

func (c *Core) WriteSession(sessionID, data string) error {
	if !c.development {
		return c.web.writeSession(sessionID, data)
	}
	c.mu.Lock()
	target, ok := c.sessions[sessionID]
	c.mu.Unlock()
	if !ok {
		return errors.New("session is not open")
	}
	command := strings.TrimSpace(data)
	response := "development driver: " + command
	switch command {
	case "hostname":
		response = target.Hostname
	case "whoami":
		response = target.Login
	case "pwd":
		response = "/home/" + target.Login
	case "":
		response = ""
	}
	c.emit(map[string]any{
		"type": "data", "sessionId": sessionID,
		"data": normalizeTerminalNewlines(data) + response + "\r\n$ ",
	})
	return nil
}

func normalizeTerminalNewlines(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.ReplaceAll(value, "\n", "\r\n")
}

func (c *Core) ResizeSession(sessionID string, columns, rows int) error {
	if !c.development {
		return c.web.resizeSession(sessionID, columns, rows)
	}
	if columns < 1 || rows < 1 {
		return errors.New("terminal size must be positive")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	target, ok := c.sessions[sessionID]
	if !ok {
		return errors.New("session is not open")
	}
	target.Columns, target.Rows = columns, rows
	c.sessions[sessionID] = target
	return nil
}

// PingSession confirms that the native transport still has a responsive
// WebSocket. A successful write alone cannot prove that a connection survived
// a network or app-state transition.
func (c *Core) PingSession(sessionID string) error {
	if !c.development {
		return c.web.pingSession(sessionID)
	}
	c.mu.Lock()
	_, ok := c.sessions[sessionID]
	c.mu.Unlock()
	if !ok {
		return errors.New("session is not open")
	}
	return nil
}

// SessionOutputJSON returns native-buffered chunks newer than afterSequence.
// The buffer remains available after a remote close so React can render the
// final output and close reason when it becomes active again.
func (c *Core) SessionOutputJSON(sessionID string, afterSequence int64) (string, error) {
	c.mu.Lock()
	record := c.outputs[sessionID]
	if record == nil {
		c.mu.Unlock()
		return "", errors.New("terminal output is not available")
	}
	chunks := make([]sessionOutputChunk, 0, len(record.Chunks))
	for _, chunk := range record.Chunks {
		if chunk.Sequence > afterSequence {
			chunks = append(chunks, chunk)
		}
	}
	result := map[string]any{
		"sessionId":      sessionID,
		"open":           record.Open,
		"latestSequence": record.LatestSequence,
		"truncated":      afterSequence < record.DiscardedThrough,
		"chunks":         chunks,
	}
	if record.Reason != "" {
		result["reason"] = record.Reason
	}
	if record.Error != "" {
		result["error"] = record.Error
	}
	c.mu.Unlock()
	return marshal(result)
}

func (c *Core) CloseSession(sessionID string) {
	if !c.development {
		c.web.closeSession(sessionID)
		return
	}
	c.mu.Lock()
	delete(c.sessions, sessionID)
	c.mu.Unlock()
	c.emit(map[string]any{"type": "closed", "sessionId": sessionID, "reason": "Closed on device"})
}

func (c *Core) finishLogin(challengeID, method string) (string, error) {
	c.mu.Lock()
	request, ok := c.challenges[challengeID]
	if ok && request.Method == method {
		delete(c.challenges, challengeID)
	}
	c.mu.Unlock()
	if !ok || request.Method != method {
		return "", errors.New("the authentication challenge is missing or expired")
	}
	host := request.ProxyAddress
	if parsedHost, _, err := net.SplitHostPort(request.ProxyAddress); err == nil {
		host = parsedHost
	}
	profile := authenticatedProfile{
		ProxyAddress: request.ProxyAddress,
		Username:     request.Username,
		ClusterName:  strings.Trim(host, "[]"),
		ValidUntil:   time.Now().Add(12 * time.Hour).UTC().Format(time.RFC3339),
	}
	c.mu.Lock()
	c.profile = &profile
	c.mu.Unlock()
	return marshal(profile)
}

func (c *Core) requireProfile() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.profile == nil {
		return errors.New("authenticate before requesting Teleport resources")
	}
	return nil
}

func (c *Core) emit(event map[string]any) {
	c.mu.Lock()
	sessionID, _ := event["sessionId"].(string)
	eventType, _ := event["type"].(string)
	if sessionID != "" {
		record := c.ensureSessionOutputLocked(sessionID)
		switch eventType {
		case "data":
			if data, ok := event["data"].(string); ok {
				record.LatestSequence++
				event["sequence"] = record.LatestSequence
				if len(data) > maxSessionOutputBytes {
					data = data[len(data)-maxSessionOutputBytes:]
					record.DiscardedThrough = record.LatestSequence
				}
				record.Chunks = append(record.Chunks, sessionOutputChunk{
					Sequence: record.LatestSequence,
					Data:     data,
				})
				record.Bytes += len(data)
				for record.Bytes > maxSessionOutputBytes && len(record.Chunks) > 0 {
					discarded := record.Chunks[0]
					record.Chunks = record.Chunks[1:]
					record.Bytes -= len(discarded.Data)
					record.DiscardedThrough = discarded.Sequence
				}
			}
		case "error":
			record.Error, _ = event["message"].(string)
		case "closed":
			record.Open = false
			record.Reason, _ = event["reason"].(string)
		}
	}
	sink := c.sink
	c.mu.Unlock()
	encoded, err := marshal(event)
	if err != nil {
		return
	}
	if sink != nil {
		sink.OnTerminalEvent(encoded)
	}
}

func (c *Core) prepareSessionOutput(sessionID string) {
	c.mu.Lock()
	if c.outputs[sessionID] == nil {
		c.ensureSessionOutputLocked(sessionID)
	}
	c.mu.Unlock()
}

func (c *Core) ensureSessionOutputLocked(sessionID string) *sessionOutputRecord {
	if record := c.outputs[sessionID]; record != nil {
		return record
	}
	record := &sessionOutputRecord{Open: true}
	c.outputs[sessionID] = record
	c.outputOrder = append(c.outputOrder, sessionID)
	for len(c.outputOrder) > maxSessionOutputRecords {
		oldest := c.outputOrder[0]
		c.outputOrder = c.outputOrder[1:]
		delete(c.outputs, oldest)
	}
	return record
}

func randomID(prefix string) (string, error) {
	value := make([]byte, 18)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("create %s id: %w", prefix, err)
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(value), nil
}

func marshal(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
