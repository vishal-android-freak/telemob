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

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const teleportProxySSHALPN = "teleport-proxy-ssh"

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
	raw, err := dialer.DialContext(ctx, "tcp", proxyAddress)
	if err != nil {
		return nil, fmt.Errorf("dial Teleport proxy: %w", err)
	}
	proxyTransport := raw
	if identity.TLSRoutingEnabled {
		tlsConnection := newTeleportProxyTLSConnection(raw, proxyURL.Hostname(), identity.Insecure)
		if err := tlsConnection.HandshakeContext(ctx); err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("negotiate Teleport SSH proxy: %w", err)
		}
		if negotiated := tlsConnection.ConnectionState().NegotiatedProtocol; negotiated != teleportProxySSHALPN {
			_ = tlsConnection.Close()
			return nil, fmt.Errorf("Teleport proxy selected unexpected ALPN protocol %q", negotiated)
		}
		proxyTransport = tlsConnection
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
