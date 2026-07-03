package pinger

import (
	"context"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ghfastProxy is the mirror the auto-fallback wraps GitHub URLs through when
// direct GitHub is unreachable. Kept in sync with the CN_DEFAULT_PROXY
// constant in master/components/SettingsView.tsx.
const ghfastProxy = "https://ghfast.top"

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

	// If direct GitHub is unreachable (mainland China networks routinely block
	// raw.githubusercontent.com AND github.com/releases), wrap the bootstrap
	// URL and pass -p to install.sh so its own binary+SHA256SUMS downloads go
	// through the same mirror. Probe is best-effort with a tight timeout so
	// the update path stays snappy on nodes that CAN reach GitHub.
	proxy := pickBootstrapProxy()
	if proxy != "" {
		log.Printf("[update] direct GitHub unreachable — routing self-update through %s", proxy)
	}

	log.Printf("[update] master wants %s, have %s — running install.sh", tag, r.ownVersion)
	if err := runInstallScript(r.masterArg, r.token, tag, r.transport, r.interval, proxy); err != nil {
		// install.sh exits non-zero on download/checksum/systemd failure. We
		// fall through and keep running the old binary; the next refresh
		// after `updateCooldown` will retry.
		log.Printf("[update] failed: %v — staying on %s", err, r.ownVersion)
	}
	// If install.sh succeeded it restarted the systemd unit which killed
	// this process. If we're still here, the install failed — keep serving.
}

// pickBootstrapProxy probes whether raw.githubusercontent.com is reachable
// from this host. If not (mainland-CN networks routinely block it), returns
// ghfast.top so the self-updater can wrap both the bootstrap fetch and the
// binary+SHA256SUMS downloads through the mirror. Returns "" when direct
// GitHub works — no mirror means install.sh keeps its clean trust anchor
// (checksum manifest fetched via github.com), which is the strong default.
func pickBootstrapProxy() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead,
		"https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh", nil)
	if err != nil {
		return ""
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ghfastProxy
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return ghfastProxy
	}
	return ""
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
func runInstallScript(master, token, version, transport string, interval int, proxy string) error {
	if transport == "" {
		transport = "ws"
	}
	if interval <= 0 {
		interval = 3
	}
	intervalStr := strconv.Itoa(interval)
	// The script accepts up to 6 positional args; $6 is the optional GitHub
	// proxy. When set, both the bootstrap fetch of install.sh AND install.sh's
	// own binary/SHA256SUMS downloads go through it (install.sh receives -p).
	// When empty, neither is proxied — same behaviour as before.
	const script = `set -e
raw="https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh"
PROXY="$6"
if [ -n "$PROXY" ]; then
  url="${PROXY%/}/$raw"
else
  url="$raw"
fi
ARGS=(-e "$1" -t "$2" -V "$3" -T "$4" -i "$5")
if [ -n "$PROXY" ]; then
  ARGS+=(-p "$PROXY")
fi
if command -v curl >/dev/null 2>&1; then
  bash <(curl -fsSL --max-time 60 "$url") "${ARGS[@]}"
else
  bash <(wget -qO- --timeout=60 "$url") "${ARGS[@]}"
fi`
	// Try systemd-run first (always present on a systemd host). Falls back
	// to plain setsid for non-systemd setups even though install.sh wouldn't
	// work there — at least the helper survives the wolf-node SIGTERM.
	args := []string{"-c", script, "wolf-update", master, token, version, transport, intervalStr, proxy}
	if path, err := exec.LookPath("systemd-run"); err == nil {
		full := append([]string{
			"--collect", "--no-block",
			"--unit", "wolf-node-update",
			"--description", "wolf-node self-update",
			"bash",
		}, args...)
		cmd := exec.Command(path, full...)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()
		return cmd.Run()
	}
	if path, err := exec.LookPath("setsid"); err == nil {
		cmd := exec.Command(path, append([]string{"bash"}, args...)...)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()
		return cmd.Start()
	}
	cmd := exec.Command("bash", args...)
	cmd.Stdout = log.Writer()
	cmd.Stderr = log.Writer()
	return cmd.Run()
}
