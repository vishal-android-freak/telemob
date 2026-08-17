package teleportmobile

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type directTCPIPRequest struct {
	RemoteHost string
	RemotePort uint32
	OriginHost string
	OriginPort uint32
}

type subsystemRequest struct {
	Subsystem string
}

func TestTeleportForwardDialerEndToEnd(t *testing.T) {
	testTeleportForwardDialerEndToEnd(t, false)
}

func TestTeleportForwardDialerTLSRoutingEndToEnd(t *testing.T) {
	testTeleportForwardDialerEndToEnd(t, true)
}

func testTeleportForwardDialerEndToEnd(t *testing.T, tlsRouting bool) {
	t.Helper()
	caSigner := testSSHSigner(t)
	proxyHostSigner := testHostCertificateSigner(t, caSigner, "proxy.example.com")
	nodeHostSigner := testHostCertificateSigner(t, caSigner, "node", "node-id")
	identity := testForwardIdentity(t, caSigner)

	destination := startEOFResponseServer(t)
	node := startForwardNodeServer(t, nodeHostSigner)
	expectedSubsystem := "proxy:node-id:0@default@root"
	var proxy string
	if tlsRouting {
		proxy = startTLSForwardProxyServer(t, proxyHostSigner, node, expectedSubsystem)
		identity.TLSRoutingEnabled = true
		identity.Insecure = true
	} else {
		proxy = startForwardProxyServer(t, proxyHostSigner, node, expectedSubsystem)
	}
	identity.SSHProxyAddress = proxy

	manager := newForwardManager(teleportForwardDialer{}, func(map[string]any) {})
	remoteHost, remotePortText, err := net.SplitHostPort(destination)
	if err != nil {
		t.Fatal(err)
	}
	remotePort, err := strconv.Atoi(remotePortText)
	if err != nil {
		t.Fatal(err)
	}
	request := localForwardRequest{
		Name: "integration", ProfileID: "profile-1", ServerID: "node-id",
		Hostname: "node", Login: "ubuntu", ClusterName: "root",
		RemoteHost: remoteHost, RemotePort: remotePort,
	}
	forward, err := manager.start(identity, request)
	if err != nil {
		t.Fatalf("start real SSH forward: %v", err)
	}
	t.Cleanup(func() { manager.stop(forward.ID, "test cleanup") })
	secondForward, err := manager.start(identity, request)
	if err != nil {
		t.Fatalf("start second real SSH forward: %v", err)
	}
	t.Cleanup(func() { manager.stop(secondForward.ID, "test cleanup") })
	if forward.LocalPort == secondForward.LocalPort {
		t.Fatalf("automatic local ports must be unique, both used %d", forward.LocalPort)
	}
	if forwards := manager.list(); len(forwards) != 2 {
		t.Fatalf("active forwards = %d, want 2", len(forwards))
	}

	var wait sync.WaitGroup
	errors := make(chan error, 2)
	for index, test := range []struct {
		forward localForwardSnapshot
		payload string
	}{
		{forward: forward, payload: "first concurrent request"},
		{forward: secondForward, payload: "second concurrent request"},
	} {
		wait.Add(1)
		go func(index int, test struct {
			forward localForwardSnapshot
			payload string
		}) {
			defer wait.Done()
			if err := testForwardRoundTrip(test.forward, test.payload); err != nil {
				errors <- fmt.Errorf("client %d: %w", index+1, err)
			}
		}(index, test)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}

func testForwardRoundTrip(forward localForwardSnapshot, payload string) error {
	connection, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort(forward.LocalHost, strconv.Itoa(forward.LocalPort)),
		2*time.Second,
	)
	if err != nil {
		return fmt.Errorf("connect local listener: %w", err)
	}
	defer connection.Close()
	if _, err := connection.Write([]byte(payload)); err != nil {
		return fmt.Errorf("write forwarded request: %w", err)
	}
	tcpConnection, ok := connection.(*net.TCPConn)
	if !ok {
		return fmt.Errorf("local connection has type %T", connection)
	}
	if err := tcpConnection.CloseWrite(); err != nil {
		return fmt.Errorf("half-close forwarded request: %w", err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	response, err := io.ReadAll(connection)
	if err != nil {
		return fmt.Errorf("read forwarded response: %w", err)
	}
	if got, want := string(response), "reply:"+payload; got != want {
		return fmt.Errorf("forwarded response = %q, want %q", got, want)
	}
	return nil
}

func testForwardIdentity(t *testing.T, caSigner ssh.Signer) *persistedSSHIdentity {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privateSigner, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	now := uint64(time.Now().Unix())
	certificate := &ssh.Certificate{
		Key:             privateSigner.PublicKey(),
		CertType:        ssh.UserCert,
		KeyId:           "telemob-test",
		ValidPrincipals: []string{"ubuntu"},
		ValidAfter:      now - 1,
		ValidBefore:     now + 300,
		Permissions: ssh.Permissions{Extensions: map[string]string{
			"permit-port-forwarding": "",
		}},
	}
	if err := certificate.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatal(err)
	}
	encodedPrivate, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return &persistedSSHIdentity{
		PrivateKey:   pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedPrivate}),
		Certificate:  ssh.MarshalAuthorizedKey(certificate),
		HostCAs:      [][]byte{ssh.MarshalAuthorizedKey(caSigner.PublicKey())},
		Username:     "teleport-user",
		Cluster:      "root",
		ValidUntil:   time.Now().Add(5 * time.Minute),
		ProxyAddress: "https://proxy.example.com",
	}
}

func testSSHSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func testHostCertificateSigner(t *testing.T, caSigner ssh.Signer, principals ...string) ssh.Signer {
	t.Helper()
	hostSigner := testSSHSigner(t)
	now := uint64(time.Now().Unix())
	certificate := &ssh.Certificate{
		Key:             hostSigner.PublicKey(),
		CertType:        ssh.HostCert,
		KeyId:           principals[0],
		ValidPrincipals: principals,
		ValidAfter:      now - 1,
		ValidBefore:     now + 300,
	}
	if err := certificate.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatal(err)
	}
	certificateSigner, err := ssh.NewCertSigner(certificate, hostSigner)
	if err != nil {
		t.Fatal(err)
	}
	return certificateSigner
}

func testSSHServerConfig(hostSigner ssh.Signer) *ssh.ServerConfig {
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	config.AddHostKey(hostSigner)
	return config
}

func startForwardProxyServer(t *testing.T, hostSigner ssh.Signer, nodeAddress, expectedSubsystem string) string {
	t.Helper()
	listener := testTCPListener(t)
	t.Cleanup(func() { _ = listener.Close() })
	serveForwardProxy(listener, testSSHServerConfig(hostSigner), nodeAddress, expectedSubsystem)
	return listener.Addr().String()
}

func startTLSForwardProxyServer(t *testing.T, hostSigner ssh.Signer, nodeAddress, expectedSubsystem string) string {
	t.Helper()
	listener := testTCPListener(t)
	certificate := testTLSCertificate(t)
	tlsListener := tls.NewListener(listener, &tls.Config{
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{teleportProxySSHALPN},
		Certificates: []tls.Certificate{certificate},
	})
	t.Cleanup(func() { _ = tlsListener.Close() })
	serveForwardProxy(tlsListener, testSSHServerConfig(hostSigner), nodeAddress, expectedSubsystem)
	return listener.Addr().String()
}

func serveForwardProxy(listener net.Listener, config *ssh.ServerConfig, nodeAddress, expectedSubsystem string) {
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go handleForwardProxyConnection(connection, config, nodeAddress, expectedSubsystem)
		}
	}()
}

func testTLSCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		DNSNames:     []string{"proxy.example.com"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(5 * time.Minute),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	encoded, err := x509.CreateCertificate(rand.Reader, template, template, privateKey.Public(), privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{encoded}, PrivateKey: privateKey}
}

func handleForwardProxyConnection(connection net.Conn, config *ssh.ServerConfig, nodeAddress, expectedSubsystem string) {
	server, channels, requests, err := ssh.NewServerConn(connection, config)
	if err != nil {
		_ = connection.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	go func() {
		defer server.Close()
		for incoming := range channels {
			if incoming.ChannelType() != "session" {
				_ = incoming.Reject(ssh.UnknownChannelType, "session channel required")
				continue
			}
			channel, channelRequests, err := incoming.Accept()
			if err != nil {
				continue
			}
			go func() {
				defer channel.Close()
				for request := range channelRequests {
					if request.Type != "subsystem" {
						_ = request.Reply(false, nil)
						continue
					}
					var message subsystemRequest
					if err := ssh.Unmarshal(request.Payload, &message); err != nil || message.Subsystem != expectedSubsystem {
						_ = request.Reply(false, nil)
						continue
					}
					node, err := net.DialTimeout("tcp", nodeAddress, 2*time.Second)
					if err != nil {
						_ = request.Reply(false, nil)
						return
					}
					_ = request.Reply(true, nil)
					pipeConnections(channel, node)
					return
				}
			}()
		}
	}()
}

func startForwardNodeServer(t *testing.T, hostSigner ssh.Signer) string {
	t.Helper()
	listener := testTCPListener(t)
	t.Cleanup(func() { _ = listener.Close() })
	config := testSSHServerConfig(hostSigner)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go handleForwardNodeConnection(connection, config)
		}
	}()
	return listener.Addr().String()
}

func handleForwardNodeConnection(connection net.Conn, config *ssh.ServerConfig) {
	server, channels, requests, err := ssh.NewServerConn(connection, config)
	if err != nil {
		_ = connection.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	go func() {
		defer server.Close()
		for incoming := range channels {
			if incoming.ChannelType() != "direct-tcpip" {
				_ = incoming.Reject(ssh.UnknownChannelType, "direct-tcpip required")
				continue
			}
			var message directTCPIPRequest
			if err := ssh.Unmarshal(incoming.ExtraData(), &message); err != nil {
				_ = incoming.Reject(ssh.ConnectionFailed, "invalid direct-tcpip request")
				continue
			}
			destination, err := net.DialTimeout(
				"tcp",
				net.JoinHostPort(message.RemoteHost, strconv.Itoa(int(message.RemotePort))),
				2*time.Second,
			)
			if err != nil {
				_ = incoming.Reject(ssh.ConnectionFailed, err.Error())
				continue
			}
			channel, channelRequests, err := incoming.Accept()
			if err != nil {
				_ = destination.Close()
				continue
			}
			go ssh.DiscardRequests(channelRequests)
			go pipeConnections(channel, destination)
		}
	}()
}

func startEOFResponseServer(t *testing.T) string {
	t.Helper()
	listener := testTCPListener(t)
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				request, err := io.ReadAll(connection)
				if err == nil {
					_, _ = fmt.Fprintf(connection, "reply:%s", request)
				}
			}()
		}
	}()
	return listener.Addr().String()
}

func testTCPListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return listener
}

func pipeConnections(left, right io.ReadWriteCloser) {
	defer left.Close()
	defer right.Close()
	var wait sync.WaitGroup
	wait.Add(2)
	copyDirection := func(destination, source io.ReadWriteCloser) {
		defer wait.Done()
		_, _ = io.Copy(destination, source)
		if halfCloser, ok := destination.(interface{ CloseWrite() error }); ok {
			_ = halfCloser.CloseWrite()
		}
	}
	go copyDirection(left, right)
	go copyDirection(right, left)
	wait.Wait()
}
