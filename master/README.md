# Wolf-Monitor · master

SSR dashboard + ingestion API for the [`wolf-node`](../node) probes. Built with
**Next.js (App Router)**, stores data in **remote PostgreSQL**, and accepts node
reports over **WebSocket** (recommended) or **HTTP** (fallback for proxies that
can't carry WebSockets).

## Architecture

```
                 ┌──────────────────────── master ────────────────────────┐
  wolf-node ──ws─┤ server.ts  ──► /api/report ──┐                          │
  wolf-node ─http┤ /api/report ─────────────────┼─► lib/db.ts ─► PostgreSQL│
                 │                               │        ▲                 │
   browser ◄─SSR─┤ app/page.tsx ─────────────────┘        │                 │
   browser ─poll─┤ /api/nodes  ───────────────────────────┘                 │
                 └─────────────────────────────────────────────────────────┘
```

- **Node → master**: `ws` nodes connect to `/api/ws/node` (handled by
  `server.ts`); `http` nodes POST to `/api/report`. Both authenticate with the
  **node token** (generated at setup, shown on the Settings page) and end up in
  the same `saveReport()` path.
- **Master → browser**: the page is server-rendered from the DB on first paint,
  then the client polls `/api/nodes` every 3s. The websocket is only for the
  node side.

## Configuration — one env var

The **only** required environment variable is `DATABASE_URL`. Everything else —
the admin account, node token, ipinfo token, and notification channels — is
configured from the dashboard and stored in PostgreSQL.

On first visit the app redirects to **`/setup`** to create the admin account
(email + password; the form follows Google standards so the browser/password
manager offers to generate & save a strong password). After that, **`/login`**
guards the Settings page. Login is rate-limited (per-IP and per-email, DB-backed
so the counter survives restarts). The dashboard and `/latency` pages are public
status views.

## Country, sorting, CDN

- **Country flags** — the master resolves each node's public IP to a country via
  [ipinfo.io](https://ipinfo.io) (optional token in Settings) and renders the
  flag from [flagcdn.com](https://flagcdn.com). Behind Cloudflare/other CDNs the
  real client IP is read from `cf-connecting-ip` / `x-forwarded-for`, so country
  resolution and login rate-limiting stay accurate.
- **Custom sorting** — viewers can sort the dashboard (custom / name / CPU /
  memory / country / status); admins drag-to-reorder under Settings → Servers
  (persisted as each node's `sort_order`).

## Database

Any reachable PostgreSQL works — Neon, Supabase, RDS, or self-hosted. Schema is
created automatically on first request (`CREATE TABLE IF NOT EXISTS`):

- `nodes` — one row per host: `host`/`metrics` JSON, `last_seen`, `ip`,
  `country`, `sort_order`.
- `metrics_history` — append-only time series (cpu, mem, disk, net, disk IO).
- `users` / `sessions` — admin accounts and login sessions.
- `app_settings` — node token, ipinfo token, notification config.
- `alert_rules` / `offline_settings` / `ping_tasks` / `ping_results` — monitoring.

## Local development

```sh
cp .env.example .env        # set DATABASE_URL only
pnpm install

# (a) plain Next.js — nodes must use transport: http
pnpm dev                 # http://localhost:3000

# (b) custom server with the node WebSocket endpoint
pnpm dev:ws              # http://localhost:8080  + ws /api/ws/node
```

Open the app, complete `/setup` to create the admin account, then copy the
**node token** from Settings → Servers and point a node at the master:

```sh
# websocket (needs dev:ws / start:ws)
../node/wolf-node -e ws://localhost:8080 -t "<NODE_TOKEN>"

# http (works against pnpm dev too)
../node/wolf-node -e http://localhost:3000 -t "<NODE_TOKEN>" -transport http
```

## Self-host (with node WebSocket)

```sh
pnpm build
DATABASE_URL=postgres://... PORT=8080 pnpm start:ws
```

`server.ts` serves both the dashboard and the `/api/ws/node` websocket on the
same port.

## Monitoring & notifications

Configured from the **Settings** page (`/settings`). Evaluation is **self-driven**:
every node report triggers a throttled evaluation (~once/min, claimed atomically),
and the self-host `server.ts` also runs a 30s loop. **No external cron is
required** — alerts work as long as a node is reporting.

- **Load alerts** — fire when a metric (CPU / RAM / DISK) stays at or
  above a threshold for at least a *time-ratio* of the samples within a trailing
  *window* (e.g. CPU ≥ 80% for 80% of the last 15 min). Per-server or all servers.
- **Offline alerts** — per-server, with a grace period (e.g. 180s).
  Notifies when a node stops reporting and again when it recovers.
- **Latency monitors** — selected nodes probe a target over **TCP** or
  **ICMP** every N seconds; results are charted under `/latency`. Nodes pull
  their assignments from `/api/tasks` and POST samples to `/api/ping`.

Notifications fire on state transitions (and re-notify a sustained issue every
30 min). Configure them from **Settings → Notifications** (stored in the
DB) or via environment variables as a fallback:

- **Enable toggle** + a **message template** with placeholders `{{emoji}}`,
  `{{event}}`, `{{client}}`, `{{message}}`, `{{time}}` (Komari-compatible).
- **Telegram**: bot token, chat id, optional `message_thread_id` (supergroup
  topics), and a custom API endpoint (default `https://api.telegram.org/bot`).
- **Webhook**: a URL that receives `{ level, event, client, message, text, ts }`.
- **Send test** button (`POST /api/notify-test`) to verify before saving.

| Channel | DB (Settings) | Env fallback |
|---------|---------------|--------------|
| Telegram | token / chat / thread / endpoint | `NOTIFY_TELEGRAM_TOKEN` + `NOTIFY_TELEGRAM_CHAT` |
| Webhook | webhook URL | `NOTIFY_WEBHOOK_URL` |

> **Edge case:** if *every* node stops reporting (or a single-node deployment
> whose only node dies), there's no report to drive evaluation, so that last
> offline isn't detected. Cover it — only if you need it — with an external ping
> every few minutes to `/api/cron/check` (send `Authorization: Bearer <CRON_SECRET>`
> if set). Most multi-node setups don't need this.

The Settings APIs are guarded by the **admin session** (login cookie) — no
token header needed.

## Environment variables

Only `DATABASE_URL` is required; the rest are rarely-needed optionals.

| Var | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | **yes** | remote PostgreSQL connection string |
| `CRON_SECRET` | no | optional: secures `/api/cron/check` for the all-nodes-down edge case (send via `Authorization: Bearer <secret>`) |
| `NOTIFY_TELEGRAM_TOKEN` / `NOTIFY_TELEGRAM_CHAT` / `NOTIFY_WEBHOOK_URL` | no | notification fallback when not configured in Settings |
| `PG_POOL_MAX` | no | max pool connections (default 4) |
| `PGSSL` | no | set to `disable` to turn off SSL |
| `EVAL_INTERVAL_MS` | no | self-host eval loop interval (default 30000) |
| `PORT` / `HOST` | no | only used by `server.ts` (self-host), default 8080 / 0.0.0.0 |

Configured in the dashboard (DB-backed) instead of env: **admin account**,
**node token**, **ipinfo token**, **notification channels**.

## Operations & key rotation

Runbook for the secrets and data Wolf-Monitor stores. Report security issues
per [`SECURITY.md`](../SECURITY.md).

### Rotate the node token

1. Settings → Servers → **Regenerate node token**. The old token stops
   authenticating new connections immediately.
2. Update every node's `-t` flag (or `WOLF_NODE_TOKEN` env) and restart it.
   Existing WebSocket sessions are dropped on the next reconnect.

### Rotate `CRON_SECRET`

Only relevant if you've wired an external pinger to `/api/cron/check`.
Change the env var on the master, redeploy, then update the caller's
`Authorization: Bearer <secret>` header. There's no DB state to migrate.

### Rotate the database password / `DATABASE_URL`

1. Issue new credentials on the Postgres side (or rotate the role's password).
2. Update `DATABASE_URL` in the master's environment and redeploy. The pool
   reconnects with the new URL on the next request.
3. Revoke the old credentials once you've confirmed the new ones work.

### Invalidate all admin sessions

Sessions are rows in the `sessions` table (the cookie holds a hash, not the
raw token), so a SQL delete kills every active login:

```sql
DELETE FROM sessions;
```

Force this after a suspected admin-password compromise, after rotating the
admin password from Settings → Account, or before handing the deployment to
a new operator.

### Backup & restore (PostgreSQL)

Use `pg_dump` against `DATABASE_URL`:

```sh
pg_dump "$DATABASE_URL" --format=custom --file=wolf-monitor-$(date +%F-%H%M).dump
```

Restore into a fresh database:

```sh
pg_restore --clean --if-exists --dbname="$DATABASE_URL" wolf-monitor-YYYY-MM-DD-HHMM.dump
```

Take a backup **before** every deploy that includes a schema change, and
keep at least 7 days of dumps off-host. Managed Postgres (Neon, Supabase,
RDS) usually provides point-in-time recovery — enable it.

### Verify install-script & binary integrity

Releases publish SHA-256 sums for the `wolf-node` binaries alongside the
GitHub release. Verify before running:

```sh
sha256sum -c wolf-node_linux_amd64.sha256
```

`install.ps1` pins the SHA-256 of the binary it downloads and aborts on
mismatch; `install.sh` does the same via `sha256sum -c`. Always fetch the
installer over HTTPS from the official repository.
