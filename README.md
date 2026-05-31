# Wolf-Monitor

[![Release](https://img.shields.io/github/v/release/LangYa466/Wolf-Monitor?sort=semver)](https://github.com/LangYa466/Wolf-Monitor/releases)
[![Release build](https://github.com/LangYa466/Wolf-Monitor/actions/workflows/release.yml/badge.svg)](https://github.com/LangYa466/Wolf-Monitor/actions/workflows/release.yml)
[![License](https://img.shields.io/github/license/LangYa466/Wolf-Monitor)](LICENSE)
[![Stars](https://img.shields.io/github/stars/LangYa466/Wolf-Monitor?style=flat)](https://github.com/LangYa466/Wolf-Monitor/stargazers)
![Go](https://img.shields.io/badge/node-Go-00ADD8?logo=go&logoColor=white)
![Next.js](https://img.shields.io/badge/master-Next.js-000?logo=nextdotjs)

Lightweight self-hosted server monitoring (探针 / probe), inspired by
[komari-monitor-rs](https://github.com/GenshinMinecraft/komari-monitor-rs).

**[Full documentation → the Wiki](https://github.com/LangYa466/Wolf-Monitor/wiki)** ·
[Deploy](https://github.com/LangYa466/Wolf-Monitor/wiki/Deploy-Master) ·
[Install nodes](https://github.com/LangYa466/Wolf-Monitor/wiki/Install-Nodes) ·
[Configuration](https://github.com/LangYa466/Wolf-Monitor/wiki/Configuration) ·
[FAQ](https://github.com/LangYa466/Wolf-Monitor/wiki/FAQ) ·
[Troubleshooting](https://github.com/LangYa466/Wolf-Monitor/wiki/Caveats-and-Troubleshooting)

Two parts:

| Folder | What | Stack |
|--------|------|-------|
| [`node/`](node) | The probe agent that runs on each monitored machine. Samples **CPU, memory, disk usage + IO read/write, network**, and runs assigned **TCP/ICMP latency probes**. | Go · Windows + Linux |
| [`master/`](master) | SSR dashboard (country flags, custom sort, email/password login) + ingestion API, **load/offline/latency alerts** with Telegram & webhook notifications. One env var (`DATABASE_URL`); all else in DB. | Next.js · WebSocket / HTTP · Vercel + CDN |

## How it fits together

```
  ┌─────────────┐   ws / http   ┌──────────────┐   SQL    ┌────────────┐
  │  wolf-node  │ ────────────► │ wolf-master  │ ───────► │ PostgreSQL │
  │  (Go probe) │   metrics     │  (Next.js)   │  upsert  │  (remote)  │
  └─────────────┘               └──────┬───────┘          └────────────┘
   CPU · mem · disk                    │ SSR + poll
   disk IO · network                   ▼
                                    browser dashboard
```

- **Node** collects metrics every few seconds and reports them. It speaks
  **WebSocket** by default (lowest latency, self-host) or **HTTP** for serverless
  masters.
- **Master** authenticates each node with a shared **node token** (generated at
  setup), writes the latest state + a history row to **PostgreSQL**, and serves a
  live dashboard.

## Quick start

```sh
# 1. master — set DATABASE_URL + NODE_TOKEN, then run
cd master
cp .env.example .env
pnpm install
pnpm dev:ws            # http://localhost:8080 (+ node websocket)
# open http://localhost:8080 → complete /setup (email + password),
# then copy the node token from Settings → Servers

# 2. node — build and point it at the master with that token
cd ../node
go build -o wolf-node .
./wolf-node -e ws://localhost:8080 -t "<NODE_TOKEN>"
```

The machine running the node appears on the dashboard within a few seconds —
with its country flag.

## Deploy

- **Master on Vercel**: import `master/` as a Next.js project, set only
  `DATABASE_URL`, deploy, then complete `/setup`. Run nodes with
  `-transport http -e https://<app>.vercel.app -t <NODE_TOKEN>`. Works behind
  Cloudflare/any CDN.
- **Master self-hosted**: `pnpm start:ws` serves the dashboard and the node
  websocket on one port.
- **Node**: cross-compile for Linux/Windows (`GOOS=... go build`) and run as a
  systemd service / Windows service.

See [`node/README.md`](node/README.md) and [`master/README.md`](master/README.md)
for full details.

## Metrics collected

CPU usage · memory (used/total, swap) · disk usage (used/total) · **disk IO
read & write** (bytes + per-second) · network (sent/recv + up/down speed) ·
load average · uptime · TCP connections · process count.

## Alerting & monitoring

Configured from the dashboard **Settings** page, evaluated on a schedule
(driven by node reports + self-host loop), and delivered via Telegram and/or webhook:

- **负载通知 / Load alerts** — CPU/RAM/DISK ≥ threshold for a time-ratio over a
  window (e.g. CPU ≥ 80% for 80% of 15 min), per-server or all.
- **离线通知 / Offline alerts** — per-server, with a grace period; notifies on
  drop and on recovery.
- **延迟监测 / Latency monitors** — selected nodes probe a target over TCP/ICMP
  on an interval; results shown on the `/latency` page.

## Star History

<a href="https://star-history.com/#LangYa466/Wolf-Monitor&Date">
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=LangYa466/Wolf-Monitor&type=Date" width="600">
</a>

## License

[MIT](LICENSE) © LangYa466
