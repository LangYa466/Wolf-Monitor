package collector

import (
	"context"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

// Collector keeps the previous IO/network counter snapshot so it can derive
// per-second rates between samples (gopsutil only exposes cumulative totals).
type Collector struct {
	lastSampleAt time.Time

	lastDiskRead  uint64
	lastDiskWrite uint64
	lastNetSent   uint64
	lastNetRecv   uint64

	cpuModel     string
	cpuCores     int
	agentVersion string
}

// SetAgentVersion stamps the binary's build version onto every Host() snapshot
// so the master can show fleet-wide version drift and decide whether to push
// a self-update directive.
func (c *Collector) SetAgentVersion(v string) { c.agentVersion = v }

func New() *Collector {
	c := &Collector{}
	if infos, err := cpu.Info(); err == nil && len(infos) > 0 {
		c.cpuModel = infos[0].ModelName
	}
	if n, err := cpu.Counts(true); err == nil {
		c.cpuCores = n
	}
	return c
}

// Host returns the slow-changing machine information.
func (c *Collector) Host() HostInfo {
	hi := HostInfo{
		OS:           "unknown",
		CPUModel:     c.cpuModel,
		CPUCores:     c.cpuCores,
		AgentVersion: c.agentVersion,
	}

	if info, err := host.Info(); err == nil {
		hi.Hostname = info.Hostname
		hi.OS = info.OS
		hi.Platform = info.Platform
		hi.PlatformVer = info.PlatformVersion
		hi.KernelArch = info.KernelArch
		hi.BootTime = info.BootTime
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		hi.MemTotal = vm.Total
	}
	if sm, err := mem.SwapMemory(); err == nil {
		hi.SwapTotal = sm.Total
	}
	if usage, err := disk.Usage(rootPath()); err == nil {
		hi.DiskTotal = usage.Total
	}
	return hi
}

// Collect takes one live sample. The first call after start produces zero
// rates (no previous snapshot); subsequent calls derive real rates.
func (c *Collector) Collect(ctx context.Context) Metrics {
	now := time.Now()
	var elapsed float64
	if !c.lastSampleAt.IsZero() {
		elapsed = now.Sub(c.lastSampleAt).Seconds()
	}

	var m Metrics

	if up, err := host.Uptime(); err == nil {
		m.Uptime = up
	}

	// CPU — short blocking sample gives an accurate instantaneous percent.
	if pcts, err := cpu.PercentWithContext(ctx, 300*time.Millisecond, false); err == nil && len(pcts) > 0 {
		m.CPUUsage = round2(pcts[0])
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		m.MemUsed = vm.Used
		m.MemPercent = round2(vm.UsedPercent)
	}
	if sm, err := mem.SwapMemory(); err == nil {
		m.SwapUsed = sm.Used
	}

	if usage, err := disk.Usage(rootPath()); err == nil {
		m.DiskUsed = usage.Used
		m.DiskPercent = round2(usage.UsedPercent)
	}

	// Disk IO — sum across physical devices.
	if counters, err := disk.IOCounters(); err == nil {
		var read, write uint64
		for _, v := range counters {
			read += v.ReadBytes
			write += v.WriteBytes
		}
		m.DiskReadBytes = read
		m.DiskWriteBytes = write
		if elapsed > 0 {
			m.DiskReadSpeed = perSec(read, c.lastDiskRead, elapsed)
			m.DiskWriteSpeed = perSec(write, c.lastDiskWrite, elapsed)
		}
		c.lastDiskRead = read
		c.lastDiskWrite = write
	}

	// Network — aggregate over all interfaces (pernic=false).
	if io, err := net.IOCounters(false); err == nil && len(io) > 0 {
		sent := io[0].BytesSent
		recv := io[0].BytesRecv
		m.NetSent = sent
		m.NetRecv = recv
		if elapsed > 0 {
			m.NetUpSpeed = perSec(sent, c.lastNetSent, elapsed)
			m.NetDownSpeed = perSec(recv, c.lastNetRecv, elapsed)
		}
		c.lastNetSent = sent
		c.lastNetRecv = recv
	}

	if avg, err := load.Avg(); err == nil {
		m.Load1 = round2(avg.Load1)
		m.Load5 = round2(avg.Load5)
		m.Load15 = round2(avg.Load15)
	}

	if conns, err := net.Connections("tcp"); err == nil {
		m.TCPConns = len(conns)
	}
	if procs, err := process.PidsWithContext(ctx); err == nil {
		m.Procs = len(procs)
	}

	c.lastSampleAt = now
	return m
}

// perSec converts two cumulative counters into a bytes/second rate, guarding
// against counter resets (e.g. interface restart) which would underflow.
func perSec(cur, prev uint64, elapsed float64) uint64 {
	if cur < prev || elapsed <= 0 {
		return 0
	}
	return uint64(float64(cur-prev) / elapsed)
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}
