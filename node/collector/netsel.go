package collector

import (
	"os"
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/v4/net"
)

// virtualNamePrefixes (lower-case) name interfaces that never carry the host's
// own external traffic: loopback, container/VM bridges and veth ends, tunnels
// and overlay devices. Used where sysfs can't tell us (non-Linux, or a Linux
// container whose only NIC is itself a veth).
var virtualNamePrefixes = []string{
	"lo", "docker", "veth", "br-", "virbr", "vnet", "tun", "tap", "tailscale",
	"wg", "zt", "cni", "flannel", "cali", "kube", "cilium", "lxc", "lxd",
	"podman", "vmnet", "vboxnet", "utun", "awdl", "llw", "bridge", "gif", "stf",
	"loopback", "vethernet", "isatap", "teredo",
}

func hasVirtualName(name string) bool {
	n := strings.ToLower(name)
	for _, p := range virtualNamePrefixes {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

// sysfsVirtual reports whether Linux considers the interface virtual (its
// device lives under /sys/devices/virtual, e.g. lo, docker0, veth*, br-*, tun
// devices with any custom name like "Mihomo"). known=false when sysfs has no
// answer for it.
func sysfsVirtual(name string) (virtual, known bool) {
	if runtime.GOOS != "linux" || name == "" || strings.ContainsRune(name, '/') {
		return false, false
	}
	target, err := os.Readlink("/sys/class/net/" + name)
	if err != nil {
		return false, false
	}
	return strings.Contains(target, "/devices/virtual/"), true
}

// pickNICs chooses which interfaces make up "this machine's network traffic".
// Summing every interface (what pernic=false does) counts one packet once per
// veth end, bridge, tunnel and physical NIC, and counts container-to-container
// traffic that never leaves the box; with Docker that inflated totals by
// 10-100x. Preference order:
//
//  1. Interfaces Linux reports as non-virtual (real NICs; bridges, bonds, VLANs
//     and tunnels ride on these, so nothing is lost).
//  2. If there are none (e.g. inside an LXC container whose NIC is a veth):
//     everything not matching a virtual name prefix.
//  3. If that is empty too: everything, rather than reporting zero.
func pickNICs(names []string, virtualFn func(string) (virtual, known bool)) []string {
	var phys, named []string
	for _, n := range names {
		if v, known := virtualFn(n); known && !v {
			phys = append(phys, n)
		}
		if !hasVirtualName(n) {
			named = append(named, n)
		}
	}
	switch {
	case len(phys) > 0:
		return phys
	case len(named) > 0:
		return named
	default:
		return names
	}
}

// netTotals returns cumulative bytes sent/received over the selected
// interfaces. ok=false when counters are unavailable.
func netTotals() (sent, recv uint64, ok bool) {
	stats, err := net.IOCounters(true)
	if err != nil || len(stats) == 0 {
		return 0, 0, false
	}
	names := make([]string, len(stats))
	for i, s := range stats {
		names[i] = s.Name
	}
	use := make(map[string]struct{}, len(stats))
	for _, n := range pickNICs(names, sysfsVirtual) {
		use[n] = struct{}{}
	}
	for _, s := range stats {
		if _, picked := use[s.Name]; picked {
			sent += s.BytesSent
			recv += s.BytesRecv
		}
	}
	return sent, recv, true
}
