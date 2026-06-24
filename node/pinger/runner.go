package pinger

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Cap on tasks accepted per refresh. A misbehaving or compromised master
// otherwise turns the fleet into a port scanner.
const maxTasksPerRefresh = 256

// allowPrivateTargets returns true when the operator opts in to monitoring
// RFC1918 / loopback / link-local targets (intranet deployments).
func allowPrivateTargets() bool {
	v := os.Getenv("WOLF_PING_ALLOW_PRIVATE")
	return v == "1" || strings.EqualFold(v, "true")
}

// parseTargetAllowlist reads WOLF_PING_TARGET_ALLOWLIST: comma-separated list
// of hostnames, IPs, or CIDR ranges. When set, validateTask only accepts
// targets that match an entry. This limits blast radius if the master is
// compromised or MITM'd and tries to push arbitrary probe targets.
func parseTargetAllowlist() ([]string, []*net.IPNet) {
	raw := strings.TrimSpace(os.Getenv("WOLF_PING_TARGET_ALLOWLIST"))
	if raw == "" {
		return nil, nil
	}
	var hosts []string
	var nets []*net.IPNet
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(item); err == nil {
			nets = append(nets, n)
			continue
		}
		hosts = append(hosts, strings.ToLower(item))
	}
	return hosts, nets
}

// targetAllowed reports whether host (a literal IP or hostname) is permitted
// by the operator-configured allowlist. Called only when the allowlist is set.
func targetAllowed(host string, hosts []string, nets []*net.IPNet) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	for _, allowed := range hosts {
		if h == allowed {
			return true
		}
	}
	if len(nets) == 0 {
		return false
	}
	check := func(ip net.IP) bool {
		for _, n := range nets {
			if n.Contains(ip) {
				return true
			}
		}
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return check(ip)
	}
	addrs, err := net.LookupIP(host)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, ip := range addrs {
		if !check(ip) {
			return false
		}
	}
	return true
}

// validateTask drops malformed or dangerous tasks before they reach Probe.
// Rejects unknown types, unparseable targets, and (by default) loopback,
// link-local (covers cloud metadata 169.254.169.254), and private ranges.
func validateTask(t Task) bool {
	typ := strings.ToLower(t.Type)
	if typ != "tcp" && typ != "icmp" {
		return false
	}
	if t.Target == "" || t.ID == "" {
		return false
	}
	host := t.Target
	if h, _, err := net.SplitHostPort(t.Target); err == nil {
		host = h
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return false
	}
	// Operator-configured allowlist takes precedence: when set, only listed
	// hosts/IPs/CIDRs are probed regardless of what the master sends.
	if hosts, nets := parseTargetAllowlist(); len(hosts) > 0 || len(nets) > 0 {
		return targetAllowed(host, hosts, nets)
	}
	if allowPrivateTargets() {
		return true
	}
	// Literal IP: check directly. Hostname: resolve and check all answers.
	check := func(ip net.IP) bool {
		if ip == nil {
			return false
		}
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() || ip.IsUnspecified() {
			return false
		}
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return check(ip)
	}
	addrs, err := net.LookupIP(host)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, ip := range addrs {
		if !check(ip) {
			return false
		}
	}
	return true
}

// Runner polls the master for latency tasks assigned to this node, runs each on
// its own schedule, and reports results back in batches. It reuses the node's
// http transport so it works against both ws and http masters.
type Runner struct {
	base       string // http(s) base, e.g. https://master
	token      string
	hostname   string
	masterArg  string // original master URL (for install.sh -e)
	ownVersion string // build version (for "do I need to update?" check)
	client     *http.Client

	tasks  map[string]Task
	nextAt map[string]time.Time
	buf    []Result

	// Cooldown for self-update so a wedged install.sh / target-version typo
	// can't pin the runner in a reinstall loop. Updated by maybeSelfUpdate.
	lastUpdateAttempt time.Time
}

func NewRunner(master, token, hostname string, insecure bool) *Runner {
	return NewRunnerWithVersion(master, token, hostname, insecure, "")
}

// NewRunnerWithVersion is the same as NewRunner but threads the build
// version through so refresh() can compare against the master's directive.
// Kept as a separate entry point so existing callers don't break.
func NewRunnerWithVersion(master, token, hostname string, insecure bool, ownVersion string) *Runner {
	base := strings.TrimRight(master, "/")
	base = strings.Replace(base, "wss://", "https://", 1)
	base = strings.Replace(base, "ws://", "http://", 1)

	tr := &http.Transport{}
	if insecure {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &Runner{
		base:       base,
		token:      token,
		hostname:   hostname,
		masterArg:  master,
		ownVersion: ownVersion,
		client:     &http.Client{Timeout: 15 * time.Second, Transport: tr},
		tasks:      map[string]Task{},
		nextAt:     map[string]time.Time{},
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
		Tasks                []Task `json:"tasks"`
		DesiredAgentVersion  string `json:"desiredAgentVersion"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		log.Printf("[ping] refresh: decode: %v", err)
		return
	}

	// If the master has set a target version that differs from our own,
	// hand off to the updater (which runs install.sh + execs the new binary
	// via systemd). updater enforces a cooldown so a stuck-bad-version
	// directive can't pin us in a reinstall loop.
	if payload.DesiredAgentVersion != "" {
		r.maybeSelfUpdate(payload.DesiredAgentVersion)
	}

	if len(payload.Tasks) > maxTasksPerRefresh {
		log.Printf("[ping] refresh: master returned %d tasks, capping at %d", len(payload.Tasks), maxTasksPerRefresh)
		payload.Tasks = payload.Tasks[:maxTasksPerRefresh]
	}

	seen := map[string]bool{}
	for _, t := range payload.Tasks {
		if !validateTask(t) {
			log.Printf("[ping] refresh: drop task %q target=%q type=%q", t.ID, t.Target, t.Type)
			continue
		}
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
