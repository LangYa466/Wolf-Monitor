package collector

// Report is the full metrics payload a node sends to the master.
// JSON tags are the wire contract shared with the master (TypeScript).
type Report struct {
	Token    string   `json:"token"`
	Host     HostInfo `json:"host"`
	Metrics  Metrics  `json:"metrics"`
	ClientTS int64    `json:"clientTs"` // unix millis on the node when sampled
}

// HostInfo is mostly static information about the machine. It changes rarely
// so the master can treat it as upsert-on-every-report.
type HostInfo struct {
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`       // linux / windows
	Platform     string `json:"platform"` // ubuntu / "Microsoft Windows 11" ...
	PlatformVer  string `json:"platformVersion"`
	KernelArch   string `json:"arch"` // amd64 / arm64
	CPUModel     string `json:"cpuModel"`
	CPUCores     int    `json:"cpuCores"`
	MemTotal     uint64 `json:"memTotal"`
	SwapTotal    uint64 `json:"swapTotal"`
	DiskTotal    uint64 `json:"diskTotal"`
	BootTime     uint64 `json:"bootTime"` // unix seconds
}

// Metrics is the live, fast-changing sample.
type Metrics struct {
	Uptime uint64 `json:"uptime"` // seconds

	CPUUsage float64 `json:"cpuUsage"` // 0..100 overall

	MemUsed    uint64  `json:"memUsed"`
	MemPercent float64 `json:"memPercent"`
	SwapUsed   uint64  `json:"swapUsed"`

	DiskUsed    uint64  `json:"diskUsed"`
	DiskPercent float64 `json:"diskPercent"`

	// Disk IO — cumulative counters and per-second rates.
	DiskReadBytes  uint64 `json:"diskReadBytes"`
	DiskWriteBytes uint64 `json:"diskWriteBytes"`
	DiskReadSpeed  uint64 `json:"diskReadSpeed"`  // bytes/s
	DiskWriteSpeed uint64 `json:"diskWriteSpeed"` // bytes/s

	// Network — cumulative counters and per-second rates.
	NetSent     uint64 `json:"netSent"`
	NetRecv     uint64 `json:"netRecv"`
	NetUpSpeed  uint64 `json:"netUpSpeed"`   // bytes/s
	NetDownSpeed uint64 `json:"netDownSpeed"` // bytes/s

	// Load averages (0 on Windows).
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`

	TCPConns int `json:"tcpConns"`
	Procs    int `json:"procs"`
}
