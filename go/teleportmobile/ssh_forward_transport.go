package teleportmobile

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const (
	teleportProxySSHALPN          = "teleport-proxy-ssh"
	teleportConnectionUpgradePath = "/webapi/connectionupgrade"
	teleportConnectionUpgradeALPN = "alpn-ping"
)

type teleportForwardDialer struct{}

type teleportNodeClient struct {
	*ssh.Client
	proxy     *ssh.Client
	session   *ssh.Session
	closeOnce sync.Once
}

func newTeleportProxyTLSConnection(connection net.Conn, serverName string, insecure bool) *tls.Conn {
	return tls.Client(connection, &tls.Config{
		MinVersion:         tls.VersionTLS12,
		ServerName:         serverName,
		NextProtos:         []string{teleportProxySSHALPN},
		InsecureSkipVerify: insecure, // #nosec G402 -- explicit user opt-in matching tsh --insecure.
	})
}

func dialTeleportProxyTransport(
	ctx context.Context,
	dialer *net.Dialer,
	proxyAddress string,
	serverName string,
	insecure bool,
) (net.Conn, error) {
	raw, err := dialer.DialContext(ctx, "tcp", proxyAddress)
	if err != nil {
		return nil, fmt.Errorf("dial Teleport proxy: %w", err)
	}
	tlsConnection := newTeleportProxyTLSConnection(raw, serverName, insecure)
	handshakeErr := tlsConnection.HandshakeContext(ctx)
	if handshakeErr != nil && !strings.Contains(handshakeErr.Error(), "no application protocol") {
		_ = raw.Close()
		return nil, fmt.Errorf("negotiate Teleport SSH proxy: %w", handshakeErr)
	}
	negotiated := ""
	if handshakeErr == nil {
		negotiated = tlsConnection.ConnectionState().NegotiatedProtocol
		if negotiated == teleportProxySSHALPN {
			return tlsConnection, nil
		}
	}
	_ = tlsConnection.Close()
	if negotiated != "" {
		return nil, fmt.Errorf("Teleport proxy selected unexpected ALPN protocol %q", negotiated)
	}

	// Layer 7 load balancers and reverse proxies commonly terminate the outer
	// TLS connection and strip Teleport's custom ALPN value. tsh handles this by
	// opening a standard WebSocket and performing the ALPN TLS handshake inside
	// that tunnel. Keep the same behavior here so port forwards work through the
	// same proxy topologies as tsh.
	upgradeURL := url.URL{
		Scheme: "wss",
		Host:   proxyAddress,
		Path:   teleportConnectionUpgradePath,
	}
	websocketDialer := websocket.Dialer{
		HandshakeTimeout: requestTimeout,
		NetDialContext:   dialer.DialContext,
		Subprotocols:     []string{teleportConnectionUpgradeALPN},
		TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			ServerName:         serverName,
			InsecureSkipVerify: insecure, // #nosec G402 -- explicit user opt-in matching tsh --insecure.
		},
	}
	websocketConnection, response, err := websocketDialer.DialContext(ctx, upgradeURL.String(), nil)
	if err != nil {
		if response != nil {
			if response.Body != nil {
				_ = response.Body.Close()
			}
			return nil, fmt.Errorf("upgrade Teleport proxy connection (HTTP %d): %w", response.StatusCode, err)
		}
		return nil, fmt.Errorf("upgrade Teleport proxy connection: %w", err)
	}
	if selected := websocketConnection.Subprotocol(); selected != teleportConnectionUpgradeALPN {
		_ = websocketConnection.Close()
		return nil, fmt.Errorf("Teleport proxy selected unexpected connection-upgrade protocol %q", selected)
	}

	stream := newWebsocketStreamConn(websocketConnection)
	innerTLS := newTeleportProxyTLSConnection(stream, serverName, true)
	if err := innerTLS.HandshakeContext(ctx); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("negotiate Teleport SSH proxy through connection upgrade: %w", err)
	}
	// Teleport routes this connection from the ALPN values in ClientHello before
	// terminating TLS. The selected SSH handler may use a TLS config without
	// NextProtos, so ConnectionState.NegotiatedProtocol can legitimately be
	// empty even though the connection was routed to the SSH proxy. tsh likewise
	// proceeds without requiring an echoed protocol after connection upgrade.
	return innerTLS, nil
}

func (teleportForwardDialer) DialNode(ctx context.Context, identity *persistedSSHIdentity, request localForwardRequest) (forwardNodeClient, error) {
	if identity == nil || time.Now().After(identity.ValidUntil) {
		return nil, errors.New("the port forwarding SSH certificate has expired")
	}
	signer, privateKey, certificate, err := signerForIdentity(identity)
	if err != nil {
		return nil, err
	}
	proxyURL, err := url.Parse(identity.ProxyAddress)
	if err != nil || proxyURL.Hostname() == "" {
		return nil, errors.New("the saved Teleport proxy address is invalid")
	}
	proxyAddress := identity.SSHProxyAddress
	if proxyAddress == "" {
		proxyAddress = proxyURL.Host
		if proxyURL.Port() == "" {
			proxyAddress = net.JoinHostPort(proxyURL.Hostname(), "443")
		}
	}
	proxyHostKeyCallback, err := teleportHostKeyCallback(identity.HostCAs, proxyURL.Hostname())
	if err != nil {
		return nil, err
	}
	nodeHostKeyCallback, err := teleportHostKeyCallback(identity.HostCAs, request.Hostname, request.ServerID)
	if err != nil {
		return nil, err
	}
	sshConfig := &ssh.ClientConfig{
		User:            request.Login,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: proxyHostKeyCallback,
		Timeout:         requestTimeout,
	}

	dialer := net.Dialer{Timeout: requestTimeout, KeepAlive: 30 * time.Second}
	var proxyTransport net.Conn
	if identity.TLSRoutingEnabled {
		proxyTransport, err = dialTeleportProxyTransport(ctx, &dialer, proxyAddress, proxyURL.Hostname(), identity.Insecure)
	} else {
		proxyTransport, err = dialer.DialContext(ctx, "tcp", proxyAddress)
		if err != nil {
			err = fmt.Errorf("dial Teleport proxy: %w", err)
		}
	}
	if err != nil {
		return nil, err
	}
	proxyConnection, proxyChannels, proxyRequests, err := ssh.NewClientConn(proxyTransport, proxyAddress, sshConfig)
	if err != nil {
		_ = proxyTransport.Close()
		return nil, fmt.Errorf("authenticate to Teleport proxy: %w", err)
	}
	proxyClient := ssh.NewClient(proxyConnection, proxyChannels, proxyRequests)

	proxySession, err := proxyClient.NewSession()
	if err != nil {
		_ = proxyClient.Close()
		return nil, fmt.Errorf("open Teleport proxy session: %w", err)
	}
	stdin, err := proxySession.StdinPipe()
	if err != nil {
		_ = proxySession.Close()
		_ = proxyClient.Close()
		return nil, fmt.Errorf("open proxy input: %w", err)
	}
	stdout, err := proxySession.StdoutPipe()
	if err != nil {
		_ = proxySession.Close()
		_ = proxyClient.Close()
		return nil, fmt.Errorf("open proxy output: %w", err)
	}
	stderr, err := proxySession.StderrPipe()
	if err != nil {
		_ = proxySession.Close()
		_ = proxyClient.Close()
		return nil, fmt.Errorf("open proxy error stream: %w", err)
	}

	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: privateKey, Certificate: certificate}); err == nil {
		if err := agent.ForwardToAgent(proxyClient, keyring); err == nil {
			// Required when the cluster records sessions at the proxy. Older node
			// recording clusters can reject this request, so it is intentionally
			// best effort.
			_ = agent.RequestAgentForwarding(proxySession)
		}
	}

	nodeAddress := request.ServerID + ":0"
	parts := []string{nodeAddress, "default"}
	if request.ClusterName != "" {
		parts = append(parts, request.ClusterName)
	}
	subsystem := "proxy:" + strings.Join(parts, "@")
	if err := requestSSHSubsystem(ctx, proxySession, subsystem); err != nil {
		message, _ := io.ReadAll(io.LimitReader(stderr, 16<<10))
		_ = proxySession.Close()
		_ = proxyClient.Close()
		if text := strings.TrimSpace(string(message)); text != "" {
			return nil, fmt.Errorf("open Teleport node tunnel: %w: %s", err, text)
		}
		return nil, fmt.Errorf("open Teleport node tunnel: %w", err)
	}

	pipe := &sshSessionConn{
		Reader: stdout,
		Writer: stdin,
		closer: proxySession,
		local:  proxyTransport.LocalAddr(),
		remote: tunnelAddress(nodeAddress),
	}
	nodeConfig := &ssh.ClientConfig{
		User:            request.Login,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: nodeHostKeyCallback,
		Timeout:         requestTimeout,
	}
	nodeConnection, nodeChannels, nodeRequests, err := ssh.NewClientConn(pipe, nodeAddress, nodeConfig)
	if err != nil {
		_ = pipe.Close()
		_ = proxyClient.Close()
		return nil, fmt.Errorf("authenticate to Teleport node: %w", err)
	}
	return &teleportNodeClient{
		Client:  ssh.NewClient(nodeConnection, nodeChannels, nodeRequests),
		proxy:   proxyClient,
		session: proxySession,
	}, nil
}

func (c *teleportNodeClient) Close() error {
	var result error
	c.closeOnce.Do(func() {
		result = errors.Join(c.Client.Close(), c.session.Close(), c.proxy.Close())
	})
	return result
}

func signerForIdentity(identity *persistedSSHIdentity) (ssh.Signer, any, *ssh.Certificate, error) {
	block, _ := pem.Decode(identity.PrivateKey)
	if block == nil {
		return nil, nil, nil, errors.New("the saved SSH private key is invalid")
	}
	privateKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse saved SSH private key: %w", err)
	}
	privateSigner, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("load saved SSH private key: %w", err)
	}
	publicKey, _, _, _, err := ssh.ParseAuthorizedKey(identity.Certificate)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse saved SSH certificate: %w", err)
	}
	certificate, ok := publicKey.(*ssh.Certificate)
	if !ok {
		return nil, nil, nil, errors.New("the saved SSH certificate is invalid")
	}
	signer, err := ssh.NewCertSigner(certificate, privateSigner)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("combine SSH key and certificate: %w", err)
	}
	return signer, privateKey, certificate, nil
}

func teleportHostKeyCallback(encodedCAs [][]byte, principals ...string) (ssh.HostKeyCallback, error) {
	authorities := make([]ssh.PublicKey, 0, len(encodedCAs))
	for _, encoded := range encodedCAs {
		key, _, _, _, err := ssh.ParseAuthorizedKey(encoded)
		if err != nil {
			return nil, fmt.Errorf("parse Teleport host authority: %w", err)
		}
		authorities = append(authorities, key)
	}
	checker := ssh.CertChecker{IsHostAuthority: func(authority ssh.PublicKey, _ string) bool {
		for _, trusted := range authorities {
			if bytes.Equal(trusted.Marshal(), authority.Marshal()) {
				return true
			}
		}
		return false
	}}
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		certificate, ok := key.(*ssh.Certificate)
		if !ok || certificate.CertType != ssh.HostCert {
			return errors.New("Teleport endpoint did not present an SSH host certificate")
		}
		var lastError error
		for _, principal := range principals {
			if principal == "" {
				continue
			}
			if err := checker.CheckCert(principal, certificate); err == nil {
				return nil
			} else {
				lastError = err
			}
		}
		return fmt.Errorf("verify Teleport SSH host certificate: %w", lastError)
	}, nil
}

func requestSSHSubsystem(ctx context.Context, session *ssh.Session, name string) error {
	result := make(chan error, 1)
	go func() { result <- session.RequestSubsystem(name) }()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		_ = session.Close()
		return ctx.Err()
	}
}

type sshSessionConn struct {
	io.Reader
	io.Writer
	closer io.Closer
	local  net.Addr
	remote net.Addr
}

func (c *sshSessionConn) Close() error                     { return c.closer.Close() }
func (c *sshSessionConn) LocalAddr() net.Addr              { return c.local }
func (c *sshSessionConn) RemoteAddr() net.Addr             { return c.remote }
func (c *sshSessionConn) SetDeadline(time.Time) error      { return nil }
func (c *sshSessionConn) SetReadDeadline(time.Time) error  { return nil }
func (c *sshSessionConn) SetWriteDeadline(time.Time) error { return nil }

type tunnelAddress string

func (a tunnelAddress) Network() string { return "teleport" }
func (a tunnelAddress) String() string  { return string(a) }
