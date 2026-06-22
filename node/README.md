# wolf-node (probe)

Cross-platform monitoring agent written in Go. Samples the host and reports to a
[`master`](../master) over **websocket** (default) or **http** (fallback for
masters sitting behind a proxy that can't carry WebSockets). Inspired by
[komari-monitor-rs](https://github.com/GenshinMinecraft/komari-monitor-rs).

## Collected metrics

| Group   | Fields |
|---------|--------|
| CPU     | overall usage %, model, core count |
| Memory  | total / used / used %, swap total / used |
| Disk    | root usage total / used / used %, **IO read & write** bytes + per-second speed |
| Network | total sent / recv bytes, up / down speed |
| System  | uptime, load average (Linux), TCP connection count, process count |

Per-second rates (disk IO, network) are derived on the node from the delta
between two cumulative samples.

## One-click install

Installs a prebuilt binary as a system service. `-e` is the master endpoint,
`-t` the node token (Komari-compatible flags).

**Linux / macOS**

```sh
wget -qO- https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh \
  | sudo bash -s -- -e https://lg.langya.io -t YOUR_TOKEN
```

**Windows** (elevated PowerShell)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; iwr 'https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.ps1' -UseBasicParsing -OutFile 'install.ps1'; & '.\install.ps1' '-e' 'https://lg.langya.io' '-t' 'YOUR_TOKEN'"
```

**Optional GitHub proxy** (faster downloads in some regions) — append
`-p https://ghfast.top` (Linux) or `'-Proxy' 'https://ghfast.top'` (Windows).

Other flags: `-T http` (transport, use when the master can't proxy WebSockets), `-i 5` (interval),
`-V v1.0.0` (pin a release). Binaries come from the repo's GitHub Releases
(built by `.github/workflows/release.yml`).

## Build

```sh
# native
go build -o wolf-node .

# Linux amd64
GOOS=linux   GOARCH=amd64 go build -o wolf-node       .
# Linux arm64
GOOS=linux   GOARCH=arm64 go build -o wolf-node-arm64 .
# Windows amd64
GOOS=windows GOARCH=amd64 go build -o wolf-node.exe   .
```

No CGO required — the binaries are static and self-contained.

## Configure

Resolution order (later overrides earlier): defaults → `config.json` → env vars → flags.

```sh
# flags
./wolf-node -master wss://master.example.com -token SECRET -interval 3

# env
WOLF_MASTER=wss://master.example.com WOLF_TOKEN=SECRET ./wolf-node

# file (copy config.example.json -> config.json)
./wolf-node                # reads ./config.json
WOLF_CONFIG=/etc/wolf.json ./wolf-node
```

| Key | Flag | Env | Default | Notes |
|-----|------|-----|---------|-------|
| master | `-master` | `WOLF_MASTER` | `ws://127.0.0.1:8080` | `ws://`, `wss://`, `http://`, or `https://` — auto-normalised per transport |
| token | `-token` | `WOLF_TOKEN` | _(empty)_ | shared secret, must match master's `NODE_TOKEN` |
| transport | `-transport` | `WOLF_TRANSPORT` | `ws` | `ws` or `http`. Use `http` when the master sits behind a proxy that can't carry WebSockets. |
| interval | `-interval` | `WOLF_INTERVAL` | `3` | seconds between reports |
| insecure | `-insecure` | `WOLF_INSECURE` | `false` | skip TLS verification |

## Latency monitoring

The node also pulls **TCP/ICMP latency probes** assigned to it from the master
(`GET /api/tasks`) and reports samples back (`POST /api/ping`) — both over HTTP,
regardless of the metrics transport. No extra config needed; assign monitors to
this host from the master's **Settings** page.

- **TCP** probes measure connect time to `host:port` (bare host → `:80`).
- **ICMP** probes send one echo. On **Windows** this needs privileged raw
  sockets (run elevated). On **Linux**, unprivileged ping works if
  `net.ipv4.ping_group_range` permits it, otherwise run as root or set
  `WOLF_ICMP_PRIVILEGED=1` and grant the binary `CAP_NET_RAW`.

## Transport choice

- **ws** — the node holds a persistent websocket to `/api/ws/node`. Use this
  with a self-hosted master (`pnpm start:ws`). Lowest latency, auto-reconnect.
- **http** — the node POSTs each sample to `/api/report`. Use this when the
  master is behind a proxy / CDN tier that can't carry a persistent WebSocket.

## Run as a service (Linux, systemd)

```ini
# /etc/systemd/system/wolf-node.service
[Unit]
Description=wolf node
After=network-online.target

[Service]
ExecStart=/opt/wolf/wolf-node -master wss://master.example.com -token SECRET
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now wolf-node
```

On Windows, run with [NSSM](https://nssm.cc/) or Task Scheduler, or just launch
`wolf-node.exe -master ... -token ...`.
