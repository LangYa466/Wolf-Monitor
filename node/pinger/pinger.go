package pinger

import (
	"net"
	"os"
	"runtime"
	"strings"
	"time"

	probing "github.com/prometheus-community/pro-bing"
)

// Task mirrors the master's PingTask (subset the node needs).
type Task struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Target          string `json:"target"`
	Type            string `json:"type"` // tcp | icmp
	IntervalSeconds int    `json:"intervalSeconds"`
}

// Result is one latency sample reported back to the master.
type Result struct {
	TaskID    string  `json:"taskId"`
	NodeID    string  `json:"nodeId"`
	TS        int64   `json:"ts"`
	LatencyMs float64 `json:"latencyMs"`
	Success   bool    `json:"success"`
}

const probeTimeout = 4 * time.Second

// Probe runs a single measurement for the task and returns latency + success.
func Probe(t Task) (float64, bool) {
	switch strings.ToLower(t.Type) {
	case "icmp":
		return probeICMP(t.Target)
	default:
		return probeTCP(t.Target)
	}
}

// probeTCP measures connect time to host:port. A bare host defaults to :80.
func probeTCP(target string) (float64, bool) {
	addr := target
	if _, _, err := net.SplitHostPort(target); err != nil {
		addr = net.JoinHostPort(target, "80")
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, probeTimeout)
	if err != nil {
		return -1, false
	}
	_ = conn.Close()
	return msSince(start), true
}

// probeICMP sends one echo request. On Windows ICMP requires privileged
// (raw socket) mode; on Linux it uses unprivileged UDP ping when the kernel
// allows it (net.ipv4.ping_group_range), else run the node as root.
func probeICMP(target string) (float64, bool) {
	p, err := probing.NewPinger(target)
	if err != nil {
		return -1, false
	}
	p.Count = 1
	p.Timeout = probeTimeout
	if runtime.GOOS == "windows" || envPrivileged() {
		p.SetPrivileged(true)
	}
	if err := p.Run(); err != nil {
		return -1, false
	}
	st := p.Statistics()
	if st.PacketsRecv == 0 {
		return -1, false
	}
	return float64(st.AvgRtt.Microseconds()) / 1000.0, true
}

func envPrivileged() bool {
	v := os.Getenv("WOLF_ICMP_PRIVILEGED")
	return v == "1" || strings.EqualFold(v, "true")
}

func msSince(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000.0
}

func (t Task) Interval() time.Duration {
	if t.IntervalSeconds < 5 {
		return 5 * time.Second
	}
	return time.Duration(t.IntervalSeconds) * time.Second
}
