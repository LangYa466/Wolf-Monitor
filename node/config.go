package main

import (
	"encoding/json"
	"flag"
	"os"
	"strconv"
	"strings"
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
	Insecure bool `json:"insecure"`
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
	insecure := flag.Bool("insecure", cfg.Insecure, "skip TLS verification")
	flag.Parse()

	cfg.Master = master
	cfg.Token = token
	cfg.Transport = *transport
	cfg.Interval = *interval
	cfg.Insecure = *insecure

	if cfg.Interval < 1 {
		cfg.Interval = 1
	}
	cfg.Transport = strings.ToLower(strings.TrimSpace(cfg.Transport))
	return cfg
}
