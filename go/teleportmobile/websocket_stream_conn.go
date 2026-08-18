package teleportmobile

import (
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// websocketStreamConn presents binary WebSocket messages as one continuous
// byte stream. Teleport uses this stream as the carrier for a nested TLS
// connection when a layer 7 proxy cannot preserve custom ALPN values.
type websocketStreamConn struct {
	connection *websocket.Conn
	readMu     sync.Mutex
	writeMu    sync.Mutex
	reader     io.Reader
	closeOnce  sync.Once
	closeErr   error
}

func newWebsocketStreamConn(connection *websocket.Conn) net.Conn {
	return &websocketStreamConn{connection: connection}
}

func (c *websocketStreamConn) Read(buffer []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	for {
		if c.reader == nil {
			messageType, reader, err := c.connection.NextReader()
			if err != nil {
				return 0, err
			}
			if messageType != websocket.BinaryMessage {
				return 0, errors.New("Teleport connection upgrade returned a non-binary WebSocket message")
			}
			c.reader = reader
		}
		read, err := c.reader.Read(buffer)
		if errors.Is(err, io.EOF) {
			c.reader = nil
			if read > 0 {
				return read, nil
			}
			continue
		}
		return read, err
	}
}

func (c *websocketStreamConn) Write(buffer []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	writer, err := c.connection.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return 0, err
	}
	written, writeErr := writer.Write(buffer)
	closeErr := writer.Close()
	return written, errors.Join(writeErr, closeErr)
}

func (c *websocketStreamConn) Close() error {
	c.closeOnce.Do(func() {
		c.closeErr = c.connection.Close()
	})
	return c.closeErr
}

func (c *websocketStreamConn) LocalAddr() net.Addr  { return c.connection.LocalAddr() }
func (c *websocketStreamConn) RemoteAddr() net.Addr { return c.connection.RemoteAddr() }

func (c *websocketStreamConn) SetDeadline(deadline time.Time) error {
	return errors.Join(c.SetReadDeadline(deadline), c.SetWriteDeadline(deadline))
}

func (c *websocketStreamConn) SetReadDeadline(deadline time.Time) error {
	return c.connection.SetReadDeadline(deadline)
}

func (c *websocketStreamConn) SetWriteDeadline(deadline time.Time) error {
	return c.connection.SetWriteDeadline(deadline)
}
