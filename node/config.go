package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Version is the build version reported by -version. Override at link time with
// -ldflags "-X main.Version=...". Kept in sync with the master's package.json.
var Version = "1.5.7"

// Interval bounds. Floor prevents a busy-loop hammer on the master; ceiling
// prevents a misconfigured node from going silent for hours.
const (
	minInterval = 1
	maxInterval = 3600
)

// Config controls how the node connects to the master and how often it samples.
// Resolution order (later wins): defaults -> config.json -> env vars -> flags.
type Config struct {
	// Master is the base URL of the master, e.g. "ws://1.2.3.4:8080" for the
	// websocket transport, or "https://master.example.com" for http transport.
	Master string `json:"master"`
	// Token authenticates this node with the master.
	Token string `json:"token"`
	// Transport is "ws" (default) or "http". Use "http" when the master sits
	// behind a proxy that cannot carry a persistent websocket.
	Transport string `json:"transport"`
	// Interval is the sampling/report interval in seconds.
	Interval int `json:"interval"`
	// Insecure skips TLS verification (self-signed master certs).
	// Prefer MasterCA / MasterCAPEM over this — Insecure exposes the bearer
	// token to any on-path MITM.
	Insecure bool `json:"insecure"`
	// MasterCA is a path to a PEM file containing the master's CA / self-signed
	// cert. When set, TLS verification uses this pool instead of system roots
	// and Insecure is ignored.
	MasterCA string `json:"master_ca"`
	// MasterCAPEM is an inline PEM blob (useful for systemd EnvironmentFile or
	// the install one-liner). Takes precedence over MasterCA when both set.
	MasterCAPEM string `json:"master_ca_pem"`
}

func defaultConfig() Config {
	return Config{
		Master:    "ws://127.0.0.1:8080",
		Token:     "",
		Transport: "ws",
		Interval:  3,
		Insecure:  false,
	}
}

func LoadConfig() Config {
	cfg := defaultConfig()

	// 1) config file
	path := os.Getenv("WOLF_CONFIG")
	if path == "" {
		path = "config.json"
	}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}

	// 2) environment
	if v := os.Getenv("WOLF_MASTER"); v != "" {
		cfg.Master = v
	}
	if v := os.Getenv("WOLF_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("WOLF_TRANSPORT"); v != "" {
		cfg.Transport = v
	}
	if v := os.Getenv("WOLF_INTERVAL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Interval = n
		}
	}
	if v := os.Getenv("WOLF_INSECURE"); v != "" {
		cfg.Insecure = v == "1" || strings.EqualFold(v, "true")
	}
	if v := os.Getenv("WOLF_MASTER_CA"); v != "" {
		cfg.MasterCA = v
	}
	if v := os.Getenv("WOLF_MASTER_CA_PEM"); v != "" {
		cfg.MasterCAPEM = v
	}

	// 3) flags (highest priority). `-e`/`-t` are Komari-compatible aliases for
	// `-master`/`-token` so the same one-click install command shape works.
	master := cfg.Master
	token := cfg.Token
	flag.StringVar(&master, "master", cfg.Master, "master base URL (ws://host:port or https://host)")
	flag.StringVar(&master, "e", cfg.Master, "alias for -master (endpoint)")
	flag.StringVar(&token, "token", cfg.Token, "auth token")
	flag.StringVar(&token, "t", cfg.Token, "alias for -token")
	transport := flag.String("transport", cfg.Transport, "transport: ws or http")
	interval := flag.Int("interval", cfg.Interval, "report interval in seconds")
	insecure := flag.Bool("insecure", cfg.Insecure, "skip TLS verification (NOT RECOMMENDED — use -master-ca to pin a private CA)")
	masterCA := flag.String("master-ca", cfg.MasterCA, "path to PEM with master CA / self-signed cert (preferred over -insecure)")
	showVersion := flag.Bool("version", false, "print build version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(Version)
		os.Exit(0)
	}

	cfg.Master = master
	cfg.Token = token
	cfg.Transport = *transport
	cfg.Interval = *interval
	cfg.Insecure = *insecure
	cfg.MasterCA = *masterCA

	if cfg.Interval < minInterval {
		cfg.Interval = minInterval
	}
	if cfg.Interval > maxInterval {
		cfg.Interval = maxInterval
	}
	cfg.Transport = strings.ToLower(strings.TrimSpace(cfg.Transport))
	return cfg
}
