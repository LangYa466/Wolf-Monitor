package collector

import (
	"reflect"
	"testing"
)

func TestPickNICs(t *testing.T) {
	// sysfs verdicts as Linux would report them on a Docker + TUN host.
	sys := map[string]bool{ // true = virtual
		"lo": true, "docker0": true, "br-1a2b": true, "veth9f": true,
		"Mihomo": true, "tailscale0": true, "enp12s0": false,
	}
	known := func(n string) (bool, bool) { v, ok := sys[n]; return v, ok }
	unknown := func(string) (bool, bool) { return false, false }

	cases := []struct {
		name  string
		in    []string
		sysfs func(string) (bool, bool)
		want  []string
	}{
		{
			"docker host keeps only the real NIC, even with a custom-named TUN",
			[]string{"lo", "enp12s0", "docker0", "br-1a2b", "veth9f", "Mihomo", "tailscale0"},
			known, []string{"enp12s0"},
		},
		{
			"container whose only NIC is a veth falls back to names",
			[]string{"lo", "eth0"},
			func(n string) (bool, bool) { return true, true }, []string{"eth0"},
		},
		{
			"no sysfs (macOS/Windows) filters by name",
			[]string{"lo0", "en0", "utun3", "bridge0", "vEthernet (Default Switch)", "Wi-Fi"},
			unknown, []string{"en0", "Wi-Fi"},
		},
		{
			"nothing usable returns everything instead of zero",
			[]string{"lo", "docker0"},
			unknown, []string{"lo", "docker0"},
		},
	}
	for _, c := range cases {
		if got := pickNICs(c.in, c.sysfs); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
