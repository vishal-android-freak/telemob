package teleportmobile

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

type echoForwardDialer struct{}

func (echoForwardDialer) DialNode(context.Context, *persistedSSHIdentity, localForwardRequest) (forwardNodeClient, error) {
	return &echoForwardNode{}, nil
}

type echoForwardNode struct{}

func (*echoForwardNode) Dial(string, string) (net.Conn, error) {
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		_, _ = io.Copy(server, server)
	}()
	return client, nil
}

func (*echoForwardNode) SendRequest(string, bool, []byte) (bool, []byte, error) {
	return true, nil, nil
}

func (*echoForwardNode) Close() error { return nil }

func TestForwardManagerProxiesAndStops(t *testing.T) {
	manager := newForwardManager(echoForwardDialer{}, func(map[string]any) {})
	identity := &persistedSSHIdentity{ValidUntil: time.Now().Add(time.Hour), Cluster: "example"}
	snapshot, err := manager.start(identity, localForwardRequest{
		Name: "database", ServerID: "node-id", Hostname: "node",
		Login: "ubuntu", RemoteHost: "127.0.0.1", RemotePort: 5432,
	})
	if err != nil {
		t.Fatalf("start forward: %v", err)
	}
	if snapshot.LocalHost != "127.0.0.1" || snapshot.LocalPort == 0 || snapshot.State != "listening" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}

	connection, err := net.DialTimeout("tcp", net.JoinHostPort(snapshot.LocalHost, itoa(snapshot.LocalPort)), time.Second)
	if err != nil {
		t.Fatalf("connect local listener: %v", err)
	}
	defer connection.Close()
	if _, err := connection.Write([]byte("hello")); err != nil {
		t.Fatalf("write local listener: %v", err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	buffer := make([]byte, 5)
	if _, err := io.ReadFull(connection, buffer); err != nil {
		t.Fatalf("read forwarded response: %v", err)
	}
	if string(buffer) != "hello" {
		t.Fatalf("unexpected response %q", buffer)
	}

	manager.stop(snapshot.ID, "test")
	if forwards := manager.list(); len(forwards) != 0 {
		t.Fatalf("expected no forwards, got %#v", forwards)
	}
}

func TestForwardManagerRequiresAuthorization(t *testing.T) {
	manager := newForwardManager(echoForwardDialer{}, func(map[string]any) {})
	_, err := manager.start(nil, localForwardRequest{})
	if err == nil {
		t.Fatal("expected an authorization error")
	}
}

func itoa(value int) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	encoded := make([]byte, 0, 5)
	for value > 0 {
		encoded = append(encoded, digits[value%10])
		value /= 10
	}
	for left, right := 0, len(encoded)-1; left < right; left, right = left+1, right-1 {
		encoded[left], encoded[right] = encoded[right], encoded[left]
	}
	return string(encoded)
}
