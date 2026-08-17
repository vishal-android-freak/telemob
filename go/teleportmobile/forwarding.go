package teleportmobile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type localForwardRequest struct {
	Name        string `json:"name"`
	ProfileID   string `json:"profileId"`
	ServerID    string `json:"serverId"`
	Hostname    string `json:"hostname"`
	Login       string `json:"login"`
	ClusterName string `json:"clusterName"`
	RemoteHost  string `json:"remoteHost"`
	RemotePort  int    `json:"remotePort"`
	LocalPort   int    `json:"localPort"`
}

type localForwardSnapshot struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	ProfileID         string `json:"profileId"`
	ServerID          string `json:"serverId"`
	Hostname          string `json:"hostname"`
	Login             string `json:"login"`
	ClusterName       string `json:"clusterName"`
	RemoteHost        string `json:"remoteHost"`
	RemotePort        int    `json:"remotePort"`
	LocalHost         string `json:"localHost"`
	LocalPort         int    `json:"localPort"`
	State             string `json:"state"`
	ActiveConnections int    `json:"activeConnections"`
	StartedAt         string `json:"startedAt"`
	Error             string `json:"error,omitempty"`
}

type forwardNodeClient interface {
	Dial(network, address string) (net.Conn, error)
	SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error)
	Close() error
}

type forwardNodeDialer interface {
	DialNode(context.Context, *persistedSSHIdentity, localForwardRequest) (forwardNodeClient, error)
}

type runningForward struct {
	mu       sync.Mutex
	snapshot localForwardSnapshot
	listener net.Listener
	node     forwardNodeClient
	cancel   context.CancelFunc
	done     chan struct{}
	closed   sync.Once
}

type forwardManager struct {
	mu       sync.Mutex
	forwards map[string]*runningForward
	dialer   forwardNodeDialer
	emit     func(map[string]any)
}

func newForwardManager(dialer forwardNodeDialer, emit func(map[string]any)) *forwardManager {
	return &forwardManager{
		forwards: make(map[string]*runningForward),
		dialer:   dialer,
		emit:     emit,
	}
}

func (m *forwardManager) start(identity *persistedSSHIdentity, request localForwardRequest) (localForwardSnapshot, error) {
	if identity == nil || identity.ValidUntil.IsZero() || time.Now().After(identity.ValidUntil) {
		return localForwardSnapshot{}, errors.New("authorize port forwarding before starting a tunnel")
	}
	if request.ServerID == "" || request.Hostname == "" || request.Login == "" {
		return localForwardSnapshot{}, errors.New("node and SSH login are required")
	}
	request.RemoteHost = strings.TrimSpace(request.RemoteHost)
	if request.RemoteHost == "" {
		return localForwardSnapshot{}, errors.New("remote host is required")
	}
	if request.RemotePort < 1 || request.RemotePort > 65535 {
		return localForwardSnapshot{}, errors.New("remote port must be between 1 and 65535")
	}
	if request.LocalPort < 0 || request.LocalPort > 65535 {
		return localForwardSnapshot{}, errors.New("local port must be between 0 and 65535")
	}
	if request.ClusterName == "" {
		request.ClusterName = identity.Cluster
	}
	if strings.TrimSpace(request.Name) == "" {
		request.Name = fmt.Sprintf("%s:%d", request.RemoteHost, request.RemotePort)
	}

	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(request.LocalPort)))
	if err != nil {
		return localForwardSnapshot{}, fmt.Errorf("listen on local port: %w", err)
	}
	localPort := listener.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithCancel(context.Background())
	node, err := m.dialer.DialNode(ctx, identity, request)
	if err != nil {
		cancel()
		_ = listener.Close()
		return localForwardSnapshot{}, fmt.Errorf("connect forwarding node: %w", err)
	}
	id, err := randomID("forward")
	if err != nil {
		cancel()
		_ = listener.Close()
		_ = node.Close()
		return localForwardSnapshot{}, err
	}
	startedAt := time.Now().UTC().Format(time.RFC3339)
	forward := &runningForward{
		snapshot: localForwardSnapshot{
			ID: id, Name: request.Name, ProfileID: request.ProfileID,
			ServerID: request.ServerID, Hostname: request.Hostname, Login: request.Login,
			ClusterName: request.ClusterName, RemoteHost: request.RemoteHost,
			RemotePort: request.RemotePort, LocalHost: "127.0.0.1", LocalPort: localPort,
			State: "listening", StartedAt: startedAt,
		},
		listener: listener,
		node:     node,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	m.mu.Lock()
	m.forwards[id] = forward
	m.mu.Unlock()
	m.emitSnapshot(forward)
	go m.accept(ctx, forward)
	go m.keepAlive(ctx, forward)
	return forward.copySnapshot(), nil
}

func (m *forwardManager) accept(ctx context.Context, forward *runningForward) {
	defer close(forward.done)
	for {
		connection, err := forward.listener.Accept()
		if err != nil {
			if ctx.Err() == nil {
				m.fail(forward, fmt.Errorf("accept local connection: %w", err))
			}
			return
		}
		go m.proxyConnection(ctx, forward, connection)
	}
}

func (m *forwardManager) proxyConnection(ctx context.Context, forward *runningForward, local net.Conn) {
	remoteAddress := net.JoinHostPort(forward.snapshot.RemoteHost, strconv.Itoa(forward.snapshot.RemotePort))
	remote, err := forward.node.Dial("tcp", remoteAddress)
	if err != nil {
		_ = local.Close()
		m.emitConnectionError(forward, err)
		return
	}
	forward.mu.Lock()
	forward.snapshot.ActiveConnections++
	forward.mu.Unlock()
	m.emitSnapshot(forward)

	done := make(chan struct{}, 2)
	copyOneWay := func(destination, source net.Conn) {
		_, _ = io.Copy(destination, source)
		if halfCloser, ok := destination.(interface{ CloseWrite() error }); ok {
			_ = halfCloser.CloseWrite()
		}
		done <- struct{}{}
	}
	go copyOneWay(remote, local)
	go copyOneWay(local, remote)
	for completed := 0; completed < 2; completed++ {
		select {
		case <-ctx.Done():
			completed = 2
		case <-done:
		}
	}
	_ = local.Close()
	_ = remote.Close()
	forward.mu.Lock()
	if forward.snapshot.ActiveConnections > 0 {
		forward.snapshot.ActiveConnections--
	}
	forward.mu.Unlock()
	m.emitSnapshot(forward)
}

func (m *forwardManager) keepAlive(ctx context.Context, forward *runningForward) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, _, err := forward.node.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				m.fail(forward, fmt.Errorf("SSH forwarding connection ended: %w", err))
				return
			}
		}
	}
}

func (m *forwardManager) stop(id, reason string) {
	m.mu.Lock()
	forward := m.forwards[id]
	delete(m.forwards, id)
	m.mu.Unlock()
	if forward == nil {
		return
	}
	forward.closed.Do(func() {
		forward.cancel()
		_ = forward.listener.Close()
		_ = forward.node.Close()
		forward.mu.Lock()
		forward.snapshot.State = "stopped"
		forward.snapshot.Error = ""
		forward.mu.Unlock()
		m.emit(map[string]any{"type": "forward", "forward": forward.copySnapshot(), "reason": reason})
	})
}

func (m *forwardManager) stopAll(reason string) {
	m.mu.Lock()
	ids := make([]string, 0, len(m.forwards))
	for id := range m.forwards {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.stop(id, reason)
	}
}

func (m *forwardManager) list() []localForwardSnapshot {
	m.mu.Lock()
	forwards := make([]*runningForward, 0, len(m.forwards))
	for _, forward := range m.forwards {
		forwards = append(forwards, forward)
	}
	m.mu.Unlock()
	result := make([]localForwardSnapshot, 0, len(forwards))
	for _, forward := range forwards {
		result = append(result, forward.copySnapshot())
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartedAt < result[j].StartedAt })
	return result
}

func (m *forwardManager) fail(forward *runningForward, err error) {
	forward.closed.Do(func() {
		forward.cancel()
		_ = forward.listener.Close()
		_ = forward.node.Close()
		forward.mu.Lock()
		forward.snapshot.State = "error"
		forward.snapshot.Error = err.Error()
		forward.mu.Unlock()
		m.mu.Lock()
		delete(m.forwards, forward.snapshot.ID)
		m.mu.Unlock()
		m.emit(map[string]any{"type": "forward", "forward": forward.copySnapshot()})
	})
}

func (m *forwardManager) emitConnectionError(forward *runningForward, err error) {
	snapshot := forward.copySnapshot()
	snapshot.Error = fmt.Sprintf("open %s:%d: %v", snapshot.RemoteHost, snapshot.RemotePort, err)
	m.emit(map[string]any{"type": "forward", "forward": snapshot})
}

func (m *forwardManager) emitSnapshot(forward *runningForward) {
	m.emit(map[string]any{"type": "forward", "forward": forward.copySnapshot()})
}

func (f *runningForward) copySnapshot() localForwardSnapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshot
}
