// Command wolf-node is the monitoring probe (探针). It samples CPU,
// memory, disk usage + IO, and network on Windows and Linux, then reports to a
// master over websocket (default) or http.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/LangYa466/Wolf-Monitor/node/collector"
	"github.com/LangYa466/Wolf-Monitor/node/pinger"
	"github.com/LangYa466/Wolf-Monitor/node/reporter"
)

func main() {
	cfg := LoadConfig()
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[node] ")

	log.Printf("starting: master=%s transport=%s interval=%ds insecure=%t", cfg.Master, cfg.Transport, cfg.Interval, cfg.Insecure)
	if cfg.Insecure {
		log.Printf("WARNING: TLS verification DISABLED for %s — token + metrics are exposed to any on-path attacker", cfg.Master)
	}

	var rep reporter.Reporter
	switch cfg.Transport {
	case "http":
		rep = reporter.NewHTTP(cfg.Master, cfg.Token, cfg.Insecure)
	case "ws", "":
		rep = reporter.NewWS(cfg.Master, cfg.Token, cfg.Insecure)
	default:
		log.Fatalf("unknown transport %q (want ws or http)", cfg.Transport)
	}
	defer rep.Close()

	col := collector.New()
	col.SetAgentVersion(Version)
	hostInfo := col.Host()
	log.Printf("host: %s (%s/%s) cores=%d mem=%dMB",
		hostInfo.Hostname, hostInfo.OS, hostInfo.KernelArch, hostInfo.CPUCores, hostInfo.MemTotal/1024/1024)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Latency-monitoring runner: pulls assigned tcp/icmp probes from the master
	// and reports results over http. Also threads the build version through
	// so the runner can see `desiredAgentVersion` in /api/tasks responses and
	// self-update via install.sh when the admin sets a new target.
	go pinger.NewRunnerWithVersion(cfg.Master, cfg.Token, hostInfo.Hostname, cfg.Insecure, Version).Run(ctx)

	// Prime the collector so the first reported sample carries real IO/net rates.
	col.Collect(ctx)

	ticker := time.NewTicker(time.Duration(cfg.Interval) * time.Second)
	defer ticker.Stop()

	var failures int
	for {
		select {
		case <-ctx.Done():
			log.Println("shutting down")
			return
		case <-ticker.C:
			report := collector.Report{
				Token:    cfg.Token,
				Host:     col.Host(),
				Metrics:  col.Collect(ctx),
				ClientTS: time.Now().UnixMilli(),
			}
			if err := rep.Send(report); err != nil {
				failures++
				backoff := time.Duration(min(failures, 10)) * time.Second
				log.Printf("report failed (%d): %v — retrying in %s", failures, err, backoff)
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
				}
				continue
			}
			if failures > 0 {
				log.Printf("reconnected after %d failure(s)", failures)
				failures = 0
			}
		}
	}
}
