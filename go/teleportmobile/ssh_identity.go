package teleportmobile

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/crypto/ssh"
)

const forwardingCertificateTTL = 12 * time.Hour

type forwardAuthorizationRequest struct {
	Password  string `json:"password"`
	Method    string `json:"method"`
	ProfileID string `json:"profileId"`
}

type pendingForwardAuthorization struct {
	request           forwardAuthorizationRequest
	password          string
	username          string
	cluster           string
	privateKey        []byte
	publicKey         []byte
	client            *http.Client
	baseURL           string
	insecure          bool
	sshProxyAddress   string
	tlsRoutingEnabled bool
	browser           *browserMFACallback
}

type persistedSSHIdentity struct {
	PrivateKey        []byte    `json:"privateKey"`
	Certificate       []byte    `json:"certificate"`
	HostCAs           [][]byte  `json:"hostCAs"`
	Username          string    `json:"username"`
	Cluster           string    `json:"cluster"`
	ValidUntil        time.Time `json:"validUntil"`
	ProxyAddress      string    `json:"proxyAddress"`
	SSHProxyAddress   string    `json:"sshProxyAddress"`
	TLSRoutingEnabled bool      `json:"tlsRoutingEnabled"`
	Insecure          bool      `json:"insecure"`
}

type sshLoginResponse struct {
	Cert        []byte            `json:"cert"`
	HostSigners []sshTrustedCerts `json:"host_signers"`
}

type sshTrustedCerts struct {
	DomainName   string   `json:"domain_name"`
	CheckingKeys [][]byte `json:"checking_keys"`
}

func (w *webTransport) beginForwardAuthorization(requestJSON string) (string, error) {
	var request forwardAuthorizationRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return "", fmt.Errorf("decode port forwarding authorization: %w", err)
	}
	if request.Password == "" {
		return "", errors.New("enter your Teleport password to authorize port forwarding")
	}
	if request.Method != "totp" && request.Method != "passkey" {
		return "", errors.New("second factor must be passkey or totp")
	}

	session, err := w.freshSession()
	if err != nil {
		return "", err
	}
	var ping proxyPing
	if err := doJSON(context.Background(), session.client, session.baseURL, http.MethodGet, "/webapi/ping", nil, "", "", &ping); err != nil {
		return "", fmt.Errorf("read Teleport proxy settings: %w", err)
	}
	w.mu.Lock()
	if w.session == session {
		session.sshProxyAddress = resolveSSHProxyAddress(session.baseURL, ping)
		session.tlsRoutingEnabled = ping.Proxy.TLSRoutingEnabled
	}
	w.mu.Unlock()
	privateKey, publicKey, err := newSSHKeyPair(ping.FIPS)
	if err != nil {
		return "", err
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

	beginRequest := map[string]string{
		"user": session.username,
		"pass": request.Password,
	}
	if browser != nil {
		beginRequest["browser_mfa_tsh_redirect_url"] = browser.callbackURL()
	}
	var challenge mfaChallenge
	if err := doJSON(context.Background(), session.client, session.baseURL, http.MethodPost, "/v1/webapi/mfa/login/begin", beginRequest, "", "", &challenge); err != nil {
		return "", fmt.Errorf("begin port forwarding authorization: %w", err)
	}
	if request.Method == "totp" && !challenge.TOTPChallenge {
		return "", errors.New("this Teleport user does not have a TOTP challenge available")
	}
	if request.Method == "passkey" && (challenge.BrowserChallenge == nil || challenge.BrowserChallenge.RequestID == "") {
		return "", errors.New("this Teleport proxy does not offer Browser MFA for SSH certificates; use TOTP for port forwarding")
	}

	challengeID, err := randomID("forward-auth")
	if err != nil {
		return "", err
	}
	pending := &pendingForwardAuthorization{
		password:          request.Password,
		username:          session.username,
		cluster:           session.cluster,
		privateKey:        privateKey,
		publicKey:         publicKey,
		client:            session.client,
		baseURL:           session.baseURL.String(),
		insecure:          session.insecure,
		sshProxyAddress:   session.sshProxyAddress,
		tlsRoutingEnabled: session.tlsRoutingEnabled,
		browser:           browser,
	}
	request.Password = ""
	pending.request = request
	w.mu.Lock()
	w.forwardPending[challengeID] = pending
	w.mu.Unlock()

	if request.Method == "totp" {
		return marshal(map[string]any{"kind": "totp", "challengeId": challengeID, "digits": 6})
	}
	browserURL := *session.baseURL
	browserURL.Path = "/web/mfa/browser/" + challenge.BrowserChallenge.RequestID
	browserURL.RawQuery = ""
	browserURL.Fragment = ""
	keepBrowser = true
	return marshal(map[string]any{
		"kind": "passkey", "challengeId": challengeID, "browserUrl": browserURL.String(),
	})
}

func (w *webTransport) finishForwardTOTP(challengeID, code string) (string, error) {
	if len(code) != 6 {
		return "", errors.New("enter the six-digit authenticator code")
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return "", errors.New("the authenticator code can contain only digits")
		}
	}
	pending, err := w.pendingForwardAuthorization(challengeID, "totp")
	if err != nil {
		return "", err
	}
	return w.finishForwardAuthorization(challengeID, pending, code, nil)
}

func (w *webTransport) finishForwardPasskey(challengeID, credentialJSON string) (string, error) {
	pending, err := w.pendingForwardAuthorization(challengeID, "passkey")
	if err != nil {
		return "", err
	}
	if credentialJSON == "" {
		if pending.browser == nil {
			return "", errors.New("the Browser MFA callback is unavailable; start authorization again")
		}
		select {
		case result := <-pending.browser.result:
			if result.err != nil {
				w.forgetForwardAuthorization(challengeID)
				return "", result.err
			}
			credentialJSON = result.credentialJSON
		case <-time.After(browserMFATimeout):
			w.forgetForwardAuthorization(challengeID)
			return "", errors.New("timed out waiting for Browser MFA; start authorization again")
		}
	}
	var credential map[string]any
	if err := json.Unmarshal([]byte(credentialJSON), &credential); err != nil || len(credential) == 0 {
		return "", errors.New("a browser passkey assertion is required")
	}
	if extensions, ok := credential["clientExtensionResults"]; ok {
		if _, exists := credential["extensions"]; !exists {
			credential["extensions"] = extensions
		}
		delete(credential, "clientExtensionResults")
	}
	return w.finishForwardAuthorization(challengeID, pending, "", credential)
}

func (w *webTransport) finishForwardAuthorization(challengeID string, pending *pendingForwardAuthorization, code string, credential map[string]any) (string, error) {
	baseURL, err := normalizeProxyURL(pending.baseURL)
	if err != nil {
		return "", err
	}
	request := map[string]any{
		"user":           pending.username,
		"password":       pending.password,
		"pub_key":        pending.publicKey,
		"ttl":            int64(forwardingCertificateTTL),
		"RouteToCluster": pending.cluster,
	}
	if code != "" {
		request["totp_code"] = code
	}
	if credential != nil {
		request["webauthn_challenge_response"] = credential
	}
	var response sshLoginResponse
	if err := doJSON(context.Background(), pending.client, baseURL, http.MethodPost, "/v1/webapi/mfa/login/finish", request, "", "", &response); err != nil {
		return "", fmt.Errorf("authorize port forwarding: %w", err)
	}
	identity, err := identityFromSSHLoginResponse(pending, response)
	if err != nil {
		return "", err
	}

	w.mu.Lock()
	session := w.session
	if session == nil || session.username != pending.username || session.cluster != pending.cluster || session.baseURL.String() != pending.baseURL {
		w.mu.Unlock()
		return "", errors.New("the active Teleport profile changed during port forwarding authorization")
	}
	session.sshIdentity = identity
	delete(w.forwardPending, challengeID)
	pending.password = ""
	pending.request.Password = ""
	w.mu.Unlock()
	if pending.browser != nil {
		pending.browser.close()
	}

	snapshot, err := persistedSessionJSON(session)
	if err == nil && pending.request.ProfileID != "" {
		w.sendEvent(map[string]any{
			"type": "session", "profileId": pending.request.ProfileID,
			"snapshot": snapshot, "profile": profileForWebSession(session),
		})
	}
	return marshal(forwardAuthorizationStatus(identity))
}

func (w *webTransport) forwardAuthorizationStatus() (string, error) {
	w.mu.Lock()
	session := w.session
	w.mu.Unlock()
	if session == nil {
		return "", errors.New("authenticate before requesting port forwarding")
	}
	return marshal(forwardAuthorizationStatus(session.sshIdentity))
}

func (w *webTransport) startLocalForward(requestJSON string) (string, error) {
	var request localForwardRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return "", fmt.Errorf("decode local port forward: %w", err)
	}
	w.mu.Lock()
	session := w.session
	if session == nil {
		w.mu.Unlock()
		return "", errors.New("authenticate before starting port forwarding")
	}
	identity := session.sshIdentity
	w.mu.Unlock()
	snapshot, err := w.forwarder.start(identity, request)
	if err != nil {
		return "", err
	}
	return marshal(snapshot)
}

func (w *webTransport) listLocalForwards() (string, error) {
	return marshal(w.forwarder.list())
}

func (w *webTransport) stopLocalForward(id string) {
	w.forwarder.stop(id, "Stopped on device")
}

func (w *webTransport) stopAllLocalForwards() {
	w.forwarder.stopAll("Stopped on device")
}

func forwardAuthorizationStatus(identity *persistedSSHIdentity) map[string]any {
	if identity == nil || identity.ValidUntil.IsZero() || time.Now().After(identity.ValidUntil) {
		return map[string]any{"authorized": false}
	}
	return map[string]any{
		"authorized":  true,
		"validUntil":  identity.ValidUntil.UTC().Format(time.RFC3339),
		"username":    identity.Username,
		"clusterName": identity.Cluster,
	}
}

func (w *webTransport) pendingForwardAuthorization(challengeID, method string) (*pendingForwardAuthorization, error) {
	w.mu.Lock()
	pending := w.forwardPending[challengeID]
	w.mu.Unlock()
	if pending == nil || pending.request.Method != method {
		return nil, errors.New("the port forwarding authorization challenge is missing or expired")
	}
	return pending, nil
}

func (w *webTransport) forgetForwardAuthorization(challengeID string) {
	w.mu.Lock()
	pending := w.forwardPending[challengeID]
	delete(w.forwardPending, challengeID)
	w.mu.Unlock()
	if pending != nil {
		pending.password = ""
		pending.request.Password = ""
		if pending.browser != nil {
			pending.browser.close()
		}
	}
}

func newSSHKeyPair(fips bool) ([]byte, []byte, error) {
	var privateKey crypto.Signer
	var err error
	if fips {
		privateKey, err = rsa.GenerateKey(rand.Reader, 2048)
	} else {
		privateKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("generate SSH key: %w", err)
	}
	encodedPrivateKey, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, nil, fmt.Errorf("encode SSH key: %w", err)
	}
	publicKey, err := ssh.NewPublicKey(privateKey.Public())
	if err != nil {
		return nil, nil, fmt.Errorf("encode SSH public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedPrivateKey}), ssh.MarshalAuthorizedKey(publicKey), nil
}

func identityFromSSHLoginResponse(pending *pendingForwardAuthorization, response sshLoginResponse) (*persistedSSHIdentity, error) {
	if len(response.Cert) == 0 {
		return nil, errors.New("Teleport returned an empty SSH certificate")
	}
	parsed, _, _, _, err := ssh.ParseAuthorizedKey(response.Cert)
	if err != nil {
		return nil, fmt.Errorf("parse Teleport SSH certificate: %w", err)
	}
	certificate, ok := parsed.(*ssh.Certificate)
	if !ok || certificate.CertType != ssh.UserCert {
		return nil, errors.New("Teleport returned an invalid user SSH certificate")
	}
	hostCAs := make([][]byte, 0)
	for _, signer := range response.HostSigners {
		for _, key := range signer.CheckingKeys {
			if len(key) > 0 {
				hostCAs = append(hostCAs, append([]byte(nil), key...))
			}
		}
	}
	if len(hostCAs) == 0 {
		return nil, errors.New("Teleport returned no SSH host certificate authorities")
	}
	return &persistedSSHIdentity{
		PrivateKey:        append([]byte(nil), pending.privateKey...),
		Certificate:       append([]byte(nil), response.Cert...),
		HostCAs:           hostCAs,
		Username:          pending.username,
		Cluster:           pending.cluster,
		ValidUntil:        time.Unix(int64(certificate.ValidBefore), 0),
		ProxyAddress:      pending.baseURL,
		SSHProxyAddress:   pending.sshProxyAddress,
		TLSRoutingEnabled: pending.tlsRoutingEnabled,
		Insecure:          pending.insecure,
	}, nil
}
