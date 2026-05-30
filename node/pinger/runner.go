package pinger

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Runner polls the master for latency tasks assigned to this node, runs each on
// its own schedule, and reports results back in batches. It reuses the node's
// http transport so it works against both ws and http masters.
type Runner struct {
	base     string // http(s) base, e.g. https://master
	token    string
	hostname string
	client   *http.Client

	tasks  map[string]Task
	nextAt map[string]time.Time
	buf    []Result
}

func NewRunner(master, token, hostname string, insecure bool) *Runner {
	base := strings.TrimRight(master, "/")
	base = strings.Replace(base, "wss://", "https://", 1)
	base = strings.Replace(base, "ws://", "http://", 1)

	tr := &http.Transport{}
	if insecure {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &Runner{
		base:     base,
		token:    token,
		hostname: hostname,
		client:   &http.Client{Timeout: 15 * time.Second, Transport: tr},
		tasks:    map[string]Task{},
		nextAt:   map[string]time.Time{},
	}
}

// Run blocks until ctx is cancelled. It refreshes the task list every 30s,
// fires due probes each second, and flushes buffered results every 5s.
func (r *Runner) Run(ctx context.Context) {
	r.refresh(ctx)

	refreshTick := time.NewTicker(30 * time.Second)
	probeTick := time.NewTicker(time.Second)
	flushTick := time.NewTicker(5 * time.Second)
	defer refreshTick.Stop()
	defer probeTick.Stop()
	defer flushTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-refreshTick.C:
			r.refresh(ctx)
		case <-probeTick.C:
			r.runDue()
		case <-flushTick.C:
			r.flush(ctx)
		}
	}
}

func (r *Runner) runDue() {
	now := time.Now()
	for id, t := range r.tasks {
		if at, ok := r.nextAt[id]; ok && now.Before(at) {
			continue
		}
		r.nextAt[id] = now.Add(t.Interval())
		// Run synchronously: probes are bounded by probeTimeout, and runDue /
		// flush / refresh are all driven by the single Run loop, so the result
		// buffer needs no locking.
		lat, ok := Probe(t)
		r.buf = append(r.buf, Result{
			TaskID:    t.ID,
			NodeID:    r.hostname,
			TS:        now.UnixMilli(),
			LatencyMs: lat,
			Success:   ok,
		})
	}
}

func (r *Runner) refresh(ctx context.Context) {
	// Token travels only in the Authorization header, never the URL (query
	// strings leak into access/proxy logs).
	endpoint := r.base + "/api/tasks?host=" + url.QueryEscape(r.hostname)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		log.Printf("[ping] refresh: build request: %v", err)
		return
	}
	if r.token != "" {
		req.Header.Set("Authorization", "Bearer "+r.token)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		log.Printf("[ping] refresh: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("[ping] refresh: master returned %d", resp.StatusCode)
		return
	}
	var payload struct {
		Tasks []Task `json:"tasks"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		log.Printf("[ping] refresh: decode: %v", err)
		return
	}

	seen := map[string]bool{}
	for _, t := range payload.Tasks {
		seen[t.ID] = true
		r.tasks[t.ID] = t
	}
	// Drop tasks no longer assigned.
	for id := range r.tasks {
		if !seen[id] {
			delete(r.tasks, id)
			delete(r.nextAt, id)
		}
	}
}

func (r *Runner) flush(ctx context.Context) {
	if len(r.buf) == 0 {
		return
	}
	batch := r.buf
	r.buf = nil

	body, err := json.Marshal(map[string]any{"results": batch})
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.base+"/api/ping", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if r.token != "" {
		req.Header.Set("Authorization", "Bearer "+r.token)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		// Re-queue on failure so samples aren't lost.
		r.buf = append(batch, r.buf...)
		log.Printf("[ping] flush failed: %v", err)
		return
	}
	resp.Body.Close()
}
