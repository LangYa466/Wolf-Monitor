package pinger

import (
	"context"
	"log"
	"net/http"
	"os"
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

// pickBootstrapProxy probes whether the paths install.sh will hit are
// reachable from this host. If not (mainland-CN networks routinely block
// them), returns ghfast.top so the self-updater can wrap both the bootstrap
// fetch and the binary+SHA256SUMS downloads through the mirror. Returns ""
// when direct GitHub works — no mirror means install.sh keeps its clean
// trust anchor (checksum manifest fetched via github.com), which is the
// strong default.
//
// We probe github.com/releases (redirects to objects.githubusercontent.com,
// the CDN that actually serves binaries) rather than raw.githubusercontent
// alone — v1.6.3 shipped with raw-only probing and misfired on Tencent
// Cloud boxes where raw was cached-through but github.com/releases hung,
// leaving install.sh to time out on binary download.
func pickBootstrapProxy() string {
	probes := []string{
		"https://github.com/LangYa466/Wolf-Monitor/releases/latest/download/SHA256SUMS",
		"https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh",
	}
	client := &http.Client{Timeout: 4 * time.Second}
	// If ANY probe fails or times out, route through the mirror — one broken
	// CDN is enough to make install.sh fail, and the mirror covers both.
	for _, u := range probes {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
		if err != nil {
			cancel()
			continue
		}
		resp, err := client.Do(req)
		cancel()
		if err != nil {
			return ghfastProxy
		}
		resp.Body.Close()
		if resp.StatusCode >= 500 {
			return ghfastProxy
		}
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
	//
	// We write the script to a file rather than passing it via `bash -c "..."`
	// through systemd-run. systemd's ExecStart parser eagerly expands
	// `${VAR}` specifiers on every argv element, so a `-c` argument
	// containing `${PROXY%/}` / `${ARGS[@]}` becomes empty strings before
	// bash ever sees the script (v1.6.2 / v1.6.3 shipped with this bug and
	// self-update silently failed for weeks — see `wolf-node-update.service`
	// journal: "Invalid environment variable name evaluates to an empty
	// string: ARGS[@], PROXY%/"). A file path has no `${…}` so it survives
	// intact.
	const script = `#!/bin/bash
set -e
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
fi
`
	// Write to /opt/wolf, NOT /tmp. wolf-node's systemd unit sets
	// PrivateTmp=true, giving it a per-service /tmp that the newly-spawned
	// wolf-node-update transient service can't see. install.sh grants
	// ReadWritePaths=/opt/wolf, so the updater helper is guaranteed
	// writable AND visible across services.
	scriptPath := "/opt/wolf/self-update.sh"
	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		return err
	}

	scriptArgs := []string{scriptPath, master, token, version, transport, intervalStr, proxy}
	// Try systemd-run first (always present on a systemd host). Falls back
	// to plain setsid for non-systemd setups even though install.sh wouldn't
	// work there — at least the helper survives the wolf-node SIGTERM.
	if path, err := exec.LookPath("systemd-run"); err == nil {
		full := append([]string{
			"--collect", "--no-block",
			"--unit", "wolf-node-update",
			"--description", "wolf-node self-update",
		}, scriptArgs...)
		cmd := exec.Command(path, full...)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()
		return cmd.Run()
	}
	if path, err := exec.LookPath("setsid"); err == nil {
		cmd := exec.Command(path, append([]string{"bash"}, scriptArgs...)...)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()
		return cmd.Start()
	}
	cmd := exec.Command("bash", scriptArgs...)
	cmd.Stdout = log.Writer()
	cmd.Stderr = log.Writer()
	return cmd.Run()
}
