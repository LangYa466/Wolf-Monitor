//go:build windows

package collector

import "os"

// rootPath returns the system drive on Windows (e.g. "C:\\"), falling back to C:.
func rootPath() string {
	if sd := os.Getenv("SystemDrive"); sd != "" {
		return sd + "\\"
	}
	return "C:\\"
}
