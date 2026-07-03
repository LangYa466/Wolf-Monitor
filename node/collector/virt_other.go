//go:build !linux

package collector

// Non-Linux platforms just pass gopsutil's result through — the DMI-based
// fallback is Linux-only (sysfs paths).
func detectVirtLinux(gotSystem, gotRole string) (string, string) {
	return gotSystem, gotRole
}
