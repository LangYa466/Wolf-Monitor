//go:build !windows

package collector

// rootPath returns the filesystem root on Unix-like systems.
func rootPath() string {
	return "/"
}
