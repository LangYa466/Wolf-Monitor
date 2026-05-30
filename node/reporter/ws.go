package reporter

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/LangYa466/Wolf-Monitor/node/collector"
)

// WSReporter pushes reports over a persistent websocket connection to the
// master's /api/ws/node endpoint. It lazily (re)connects on demand.
type WSReporter struct {
	base     string
	token    string
	insecure bool

	mu   sync.Mutex
	conn *websocket.Conn
}

func NewWS(base, token string, insecure bool) *WSReporter {
	return &WSReporter{base: base, token: token, insecure: insecure}
}

// endpoint converts the configured base URL into a ws/wss node endpoint.
// http(s) bases are normalised to ws(s) so users can paste either form.
func (w *WSReporter) endpoint() (string, error) {
	u, err := url.Parse(w.base)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// keep
	default:
		return "", fmt.Errorf("unsupported master scheme %q", u.Scheme)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/api/ws/node"
	}
	q := u.Query()
	q.Set("token", w.token)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (w *WSReporter) connect() error {
	ep, err := w.endpoint()
	if err != nil {
		return err
	}
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second
	if w.insecure {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	header := http.Header{}
	if w.token != "" {
		header.Set("Authorization", "Bearer "+w.token)
	}
	conn, _, err := dialer.Dial(ep, header)
	if err != nil {
		return err
	}
	conn.SetReadLimit(4 << 10)
	w.conn = conn
	return nil
}

func (w *WSReporter) Send(r collector.Report) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.conn == nil {
		if err := w.connect(); err != nil {
			return err
		}
	}
	_ = w.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := w.conn.WriteJSON(r); err != nil {
		// Drop the dead connection so the next Send reconnects.
		_ = w.conn.Close()
		w.conn = nil
		return err
	}
	return nil
}

func (w *WSReporter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.conn != nil {
		_ = w.conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		err := w.conn.Close()
		w.conn = nil
		return err
	}
	return nil
}
