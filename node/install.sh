#!/usr/bin/env bash
# wolf-node one-click installer (Linux / macOS).
#
#   wget -qO- https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh \
#     | sudo bash -s -- -e https://lg.langya.io -t YOUR_TOKEN
#
# Optional GitHub proxy (for mainland China etc.):
#     ... | sudo bash -s -- -e https://lg.langya.io -t YOUR_TOKEN -p https://ghfast.top
#
set -euo pipefail

REPO="${WOLF_REPO:-LangYa466/Wolf-Monitor}"
ENDPOINT=""
TOKEN=""
PROXY=""
TRANSPORT="ws"
INTERVAL="3"
VERSION="latest"
INSTALL_DIR="/opt/wolf"
BIN="$INSTALL_DIR/wolf-node"
SERVICE="wolf-node"

err() { echo "[wolf] error: $*" >&2; exit 1; }
info() { echo "[wolf] $*"; }

# ── parse args (Komari-compatible: -e endpoint, -t token) ───────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    -e|--endpoint) ENDPOINT="$2"; shift 2;;
    -t|--token)    TOKEN="$2"; shift 2;;
    -p|--proxy)    PROXY="$2"; shift 2;;
    -T|--transport) TRANSPORT="$2"; shift 2;;
    -i|--interval) INTERVAL="$2"; shift 2;;
    -V|--version)  VERSION="$2"; shift 2;;
    --insecure)    INSECURE="1"; shift;;
    --no-verify-checksum) NO_VERIFY_CHECKSUM="1"; shift;;
    *) err "unknown argument: $1";;
  esac
done

[ -n "$ENDPOINT" ] || err "missing -e <endpoint>"
[ -n "$TOKEN" ] || err "missing -t <token>"

# ── detect platform ─────────────────────────────────────────────────────────
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux) OS="linux";;
  darwin) OS="darwin";;
  *) err "unsupported OS: $OS";;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64";;
  aarch64|arm64) ARCH="arm64";;
  *) err "unsupported arch: $ARCH";;
esac
ASSET="wolf-node_${OS}_${ARCH}"

# ── build download URL (+ optional proxy) ───────────────────────────────────
if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi
URL="${BASE_URL}/${ASSET}"
SUM_URL_DIRECT="${BASE_URL}/SHA256SUMS"   # always via github.com — the trust anchor
SUM_URL_PROXIED="${SUM_URL_DIRECT}"        # fallback when github.com is unreachable
if [ -n "$PROXY" ]; then
  URL="${PROXY%/}/${URL}"
  SUM_URL_PROXIED="${PROXY%/}/${SUM_URL_DIRECT}"
fi

info "platform: ${OS}/${ARCH}"
info "download:  ${URL}"

# Stop any running instance first — a running executable is busy (ETXTBSY), so
# overwriting it on re-install would fail with "Failure writing output".
if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE" 2>/dev/null || true
elif [ "$OS" = "darwin" ]; then
  launchctl unload "/Library/LaunchDaemons/io.wolf.node.plist" 2>/dev/null || true
fi

mkdir -p "$INSTALL_DIR"

fetch() {
  # $1 url, $2 out
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    err "need curl or wget"
  fi
}

# Download to a temp file then move into place, so a failed/partial download
# never clobbers a working binary.
TMP="$(mktemp)"
fetch "$URL" "$TMP" || err "download failed"

# ── verify SHA256 against the release manifest ──────────────────────────────
# We always try github.com directly first so a malicious proxy can't swap both
# the binary AND its checksum. If github.com is unreachable (e.g. mainland CN
# without a proxy able to reach it), fall back to the proxied manifest with a
# loud warning. `--no-verify-checksum` is an explicit opt-out for emergencies.
if [ "${NO_VERIFY_CHECKSUM:-0}" = "1" ]; then
  info "WARNING: --no-verify-checksum used — skipping integrity check"
else
  SUMS="$(mktemp)"
  if ! fetch "$SUM_URL_DIRECT" "$SUMS" 2>/dev/null; then
    if [ -n "$PROXY" ] && fetch "$SUM_URL_PROXIED" "$SUMS" 2>/dev/null; then
      info "WARNING: SHA256SUMS fetched via proxy — checksum is only as trustworthy as the proxy"
    else
      rm -f "$SUMS" "$TMP"
      err "failed to fetch SHA256SUMS from ${SUM_URL_DIRECT} (rerun with --no-verify-checksum to skip — NOT recommended)"
    fi
  fi
  EXPECTED="$(grep -E "[[:space:]]${ASSET}\$" "$SUMS" | awk '{print $1}')"
  if [ -z "$EXPECTED" ]; then
    rm -f "$SUMS" "$TMP"
    err "no SHA256 entry for ${ASSET} in manifest"
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TMP" | awk '{print $1}')"
  else
    rm -f "$SUMS" "$TMP"
    err "need sha256sum or shasum to verify download integrity"
  fi
  rm -f "$SUMS"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    rm -f "$TMP"
    err "checksum mismatch! expected=$EXPECTED actual=$ACTUAL — refusing to install"
  fi
  info "checksum OK (sha256=${ACTUAL})"
fi

chmod +x "$TMP"
mv -f "$TMP" "$BIN"

ARGS="-e ${ENDPOINT} -t ${TOKEN} -transport ${TRANSPORT} -interval ${INTERVAL}"
[ "${INSECURE:-0}" = "1" ] && ARGS="$ARGS -insecure"

# ── install as a service ────────────────────────────────────────────────────
if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=wolf node (探针)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${BIN} ${ARGS}
Restart=always
RestartSec=5
User=root
# Defense-in-depth: agent samples host metrics as root for /proc visibility
# across all users (gopsutil needs this for per-process stats and disk I/O on
# some filesystems). It does not need write access outside ${INSTALL_DIR},
# kernel tunables, the ability to load modules, raw sockets, or most syscalls.
# These flags blunt blast radius if the binary is ever compromised
# (supply-chain, dep CVE, etc.) without breaking metric collection.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
# Drop every capability — agent only needs to read /proc + open outbound
# sockets, neither of which require any cap when running as root.
CapabilityBoundingSet=
AmbientCapabilities=
# Only allow IPv4/IPv6/UNIX sockets — block AF_PACKET, AF_NETLINK rawsend, etc.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
# Allow the standard syscall set a Go HTTP/WS client needs; deny @debug,
# @mount, @reboot, @swap, @raw-io, ptrace, etc.
SystemCallFilter=@system-service
SystemCallFilter=~@debug @mount @reboot @swap @raw-io @privileged @resources
ReadWritePaths=${INSTALL_DIR}
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  # `enable` registers the unit for boot autostart; `restart` starts it now.
  systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE}"
  info "installed '${SERVICE}' — started now AND enabled on boot [OK]"
  info "logs: journalctl -u ${SERVICE} -f"
elif [ "$OS" = "darwin" ]; then
  PLIST="/Library/LaunchDaemons/io.wolf.node.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.wolf.node</string>
  <key>ProgramArguments</key><array>
    <string>${BIN}</string>
    $(for a in $ARGS; do echo "<string>$a</string>"; done)
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  # RunAtLoad in the plist makes launchd start it at every boot.
  info "installed launchd daemon 'io.wolf.node' — runs now AND on boot [OK]"
else
  info "no service manager found — run manually:"
  info "  ${BIN} ${ARGS}"
fi

info "done."
