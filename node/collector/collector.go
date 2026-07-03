package collector

import (
	"context"
	"time"

	"strings"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/sensors"
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
		// host.Info already probes virtualization on Linux (systemd-detect-virt
		// / dmi vendor / cgroup markers). Empty string == bare metal; anything
		// else is a hypervisor name like "kvm", "vmware", "xen", "docker", "lxc".
		hi.Virtualization, hi.VirtRole = detectVirtLinux(info.VirtualizationSystem, info.VirtualizationRole)
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

	m.CPUTemp = readCPUTemp(ctx)

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

// readCPUTemp picks the best CPU-package temperature from the platform's
// available sensors and returns °C (0 when nothing usable is exposed — most
// cloud VMs, containers, or Windows without WMI perms). Preference order:
//
//  1. Intel coretemp / AMD k10temp package sensor.
//  2. Any Intel core sensor (max across cores as a proxy for package).
//  3. ARM cpu_thermal / SoC thermal zone.
//  4. Anything with "cpu" in the sensor key.
//  5. ACPI thermal zone (acpitz) as a last resort.
func readCPUTemp(ctx context.Context) float64 {
	temps, err := sensors.TemperaturesWithContext(ctx)
	if err != nil || len(temps) == 0 {
		return 0
	}
	var pkg, coreMax, cpuAny, socThermal, acpi float64
	for _, s := range temps {
		if s.Temperature <= 0 || s.Temperature > 200 {
			continue
		}
		key := strings.ToLower(s.SensorKey)
		switch {
		case strings.Contains(key, "package") && (strings.Contains(key, "coretemp") || strings.Contains(key, "k10temp")):
			if s.Temperature > pkg {
				pkg = s.Temperature
			}
		case strings.HasPrefix(key, "coretemp_core") || strings.Contains(key, "core "):
			if s.Temperature > coreMax {
				coreMax = s.Temperature
			}
		case strings.Contains(key, "cpu_thermal") || strings.Contains(key, "soc_thermal"):
			if s.Temperature > socThermal {
				socThermal = s.Temperature
			}
		case strings.Contains(key, "cpu"):
			if s.Temperature > cpuAny {
				cpuAny = s.Temperature
			}
		case strings.Contains(key, "acpitz") || strings.Contains(key, "thermal_zone"):
			if s.Temperature > acpi {
				acpi = s.Temperature
			}
		}
	}
	switch {
	case pkg > 0:
		return round2(pkg)
	case coreMax > 0:
		return round2(coreMax)
	case socThermal > 0:
		return round2(socThermal)
	case cpuAny > 0:
		return round2(cpuAny)
	case acpi > 0:
		return round2(acpi)
	}
	return 0
}
