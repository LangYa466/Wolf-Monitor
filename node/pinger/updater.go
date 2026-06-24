package pinger

import (
	"log"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// updateCooldown bounds how often a node will re-attempt a self-update. If
// install.sh fails (network blip, GitHub asset not ready, checksum mismatch)
// we'll retry on the next refresh after this much wall-clock has passed —
// never sooner. Without this a bad desiredAgentVersion would have the runner
// burning the binary every 30s.
const updateCooldown = 5 * time.Minute

// Only accept semver-shaped versions from the master. install.sh's -V flag
// becomes a shell argument; restricting to digits-and-dots + optional leading
// v removes any room for command injection from a compromised settings row.
var versionShape = regexp.MustCompile(`^v?\d{1,3}(\.\d{1,3}){2}$`)

// maybeSelfUpdate compares the master-requested version against our own
// build version. On mismatch (and outside the cooldown window) it execs
// install.sh, which stops the systemd service, swaps the binary, and
// restarts it — that restart kills the current process.
//
// Self-update is Linux-only for now; the install pipeline targets systemd.
// macOS/Windows nodes log the intent and stay put — operators reinstall
// those manually.
func (r *Runner) maybeSelfUpdate(desired string) {
	desired = strings.TrimSpace(desired)
	if desired == "" || r.ownVersion == "" {
		return
	}
	if !versionShape.MatchString(desired) {
		log.Printf("[update] master sent malformed version %q — ignoring", desired)
		return
	}
	// Compare loosely: strip leading "v" on both sides so "v1.5.7" == "1.5.7".
	have := strings.TrimPrefix(r.ownVersion, "v")
	want := strings.TrimPrefix(desired, "v")
	if have == want {
		return
	}
	if runtime.GOOS != "linux" {
		log.Printf("[update] master wants %s but self-update only supports linux (current %s)", desired, runtime.GOOS)
		return
	}
	if time.Since(r.lastUpdateAttempt) < updateCooldown {
		return
	}
	r.lastUpdateAttempt = time.Now()

	// GitHub release tags use the "v" prefix (release.yml triggers on
	// `tags: ["v*"]`). install.sh appends -V verbatim to releases/download/,
	// so normalise here regardless of which shape the master stored.
	tag := desired
	if !strings.HasPrefix(tag, "v") {
		tag = "v" + tag
	}

	log.Printf("[update] master wants %s, have %s — running install.sh", tag, r.ownVersion)
	if err := runInstallScript(r.masterArg, r.token, tag); err != nil {
		// install.sh exits non-zero on download/checksum/systemd failure. We
		// fall through and keep running the old binary; the next refresh
		// after `updateCooldown` will retry.
		log.Printf("[update] failed: %v — staying on %s", err, r.ownVersion)
	}
	// If install.sh succeeded it restarted the systemd unit which killed
	// this process. If we're still here, the install failed — keep serving.
}

// runInstallScript launches install.sh in a DETACHED systemd transient unit
// so that install.sh's first move — `systemctl stop wolf-node` — doesn't
// also kill the helper process itself (we'd be running inside the same
// cgroup otherwise, and the SIGTERM cascade leaves the binary unreplaced).
//
// `systemd-run --collect --no-block` spawns the helper as a fire-and-forget
// transient .service unit; --collect tells systemd to garbage-collect it
// after it exits so we don't leak units. The original wolf-node service is
// then stopped by install.sh, the binary swapped, and the service restarted
// — at which point this updater code is already gone (different process).
//
// Inputs flow through systemd-run's argv (-- ... ARG ARG) and bash's $1/$2/$3,
// so a token like `; rm -rf /` stays a literal positional arg the whole way.
func runInstallScript(master, token, version string) error {
	const script = `set -e
url="https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh"
if command -v curl >/dev/null 2>&1; then
  bash <(curl -fsSL --max-time 60 "$url") -e "$1" -t "$2" -V "$3"
else
  bash <(wget -qO- --timeout=60 "$url") -e "$1" -t "$2" -V "$3"
fi`
	// Try systemd-run first (always present on a systemd host). Falls back
	// to plain setsid for non-systemd setups even though install.sh wouldn't
	// work there — at least the helper survives the wolf-node SIGTERM.
	if path, err := exec.LookPath("systemd-run"); err == nil {
		cmd := exec.Command(path,
			"--collect", "--no-block",
			"--unit", "wolf-node-update",
			"--description", "wolf-node self-update",
			"bash", "-c", script, "wolf-update", master, token, version,
		)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()
		return cmd.Run()
	}
	if path, err := exec.LookPath("setsid"); err == nil {
		cmd := exec.Command(path, "bash", "-c", script, "wolf-update", master, token, version)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()
		return cmd.Start()
	}
	// Last resort — runs in our cgroup, may be killed mid-replace.
	cmd := exec.Command("bash", "-c", script, "wolf-update", master, token, version)
	cmd.Stdout = log.Writer()
	cmd.Stderr = log.Writer()
	return cmd.Run()
}
