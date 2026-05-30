package reporter

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/LangYa466/Wolf-Monitor/node/collector"
)

// HTTPReporter POSTs each report to the master's /api/report endpoint. This is
// the transport to use against serverless masters (Vercel) which cannot hold a
// persistent websocket.
type HTTPReporter struct {
	url    string
	token  string
	client *http.Client
}

func NewHTTP(base, token string, insecure bool) *HTTPReporter {
	endpoint := strings.TrimRight(base, "/")
	// Normalise ws(s) bases to http(s) so either form can be pasted.
	endpoint = strings.Replace(endpoint, "wss://", "https://", 1)
	endpoint = strings.Replace(endpoint, "ws://", "http://", 1)
	endpoint += "/api/report"

	tr := &http.Transport{}
	if insecure {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &HTTPReporter{
		url:    endpoint,
		token:  token,
		client: &http.Client{Timeout: 15 * time.Second, Transport: tr},
	}
}

func (h *HTTPReporter) Send(r collector.Report) error {
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, h.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("master returned %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

func (h *HTTPReporter) Close() error { return nil }
