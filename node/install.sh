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
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi
if [ -n "$PROXY" ]; then
  URL="${PROXY%/}/${URL}"
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
# Download to a temp file then move into place, so a failed/partial download
# never clobbers a working binary.
TMP="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP" || err "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$URL" || err "download failed"
else
  err "need curl or wget"
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
