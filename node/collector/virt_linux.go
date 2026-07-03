//go:build linux

package collector

import (
	"os"
	"strings"
)

// detectVirtLinux runs after gopsutil's own detection. gopsutil misses modern
// cloud VMs (AWS Nitro, GCE, generic KVM guests without the QEMU CPU string,
// Hyper-V without hv_util in /proc/modules) because it only inspects /proc.
// systemd-detect-virt catches these via DMI + hypervisor CPUID; we reproduce
// the DMI half here so the field is populated on every mainstream distro
// without shelling out. If gopsutil already returned something, we trust it.
//
// Returns (system, role) — same shape as gopsutil. Empty system means "bare
// metal" (no hypervisor cues found anywhere).
func detectVirtLinux(gotSystem, gotRole string) (string, string) {
	if gotSystem != "" {
		return gotSystem, gotRole
	}

	vendor := strings.ToLower(readTrim("/sys/class/dmi/id/sys_vendor"))
	product := strings.ToLower(readTrim("/sys/class/dmi/id/product_name"))

	switch {
	case strings.Contains(vendor, "amazon") || strings.Contains(product, "amazon"):
		return "amazon-nitro", "guest"
	case strings.Contains(vendor, "google"):
		return "google-cloud", "guest"
	case strings.Contains(vendor, "digitalocean"):
		return "kvm", "guest"
	case strings.Contains(vendor, "microsoft"):
		return "hyperv", "guest"
	case strings.Contains(vendor, "vmware") || strings.Contains(product, "vmware"):
		return "vmware", "guest"
	case strings.Contains(vendor, "innotek") || strings.Contains(product, "virtualbox"):
		return "virtualbox", "guest"
	case strings.Contains(vendor, "qemu") || strings.Contains(product, "qemu") ||
		strings.Contains(product, "kvm") || strings.Contains(product, "standard pc"):
		return "kvm", "guest"
	case strings.Contains(vendor, "xen") || strings.Contains(product, "hvm domu") ||
		strings.Contains(product, "xen"):
		return "xen", "guest"
	case strings.Contains(vendor, "parallels"):
		return "parallels", "guest"
	}

	// Fallback: the CPUID hypervisor bit is set inside every mainstream
	// virtual CPU. If it's on but DMI didn't identify the vendor (custom
	// clouds, nested VMs, sanitised firmware), report a generic "vm" so the
	// UI still reflects "not bare metal" instead of misleading the operator.
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		if strings.Contains(string(b), " hypervisor") ||
			strings.Contains(string(b), "\thypervisor") {
			return "vm", "guest"
		}
	}

	// Container hints — cheap to check, valuable when the box is actually
	// LXC/Docker rather than a hypervisor guest.
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker", "guest"
	}
	if b, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		s := string(b)
		switch {
		case strings.Contains(s, "docker"):
			return "docker", "guest"
		case strings.Contains(s, "lxc"):
			return "lxc", "guest"
		}
	}

	return "", ""
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
