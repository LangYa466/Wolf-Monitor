# Wolf-Monitor · master

SSR dashboard + ingestion API for the [`wolf-node`](../node) probes. Built with
**Next.js (App Router)**, stores data in **remote PostgreSQL**, and accepts node
reports over **WebSocket** (self-host) or **HTTP** (Vercel / serverless).

## Architecture

```
                 ┌──────────────────────── master ────────────────────────┐
  wolf-node ──ws─┤ server.js  ──► /api/report ──┐                          │
  wolf-node ─http┤ /api/report ─────────────────┼─► lib/db.ts ─► PostgreSQL│
                 │                               │        ▲                 │
   browser ◄─SSR─┤ app/page.tsx ─────────────────┘        │                 │
   browser ─poll─┤ /api/nodes  ───────────────────────────┘                 │
                 └─────────────────────────────────────────────────────────┘
```

- **Node → master**: `ws` nodes connect to `/api/ws/node` (handled by
  `server.js`); `http` nodes POST to `/api/report`. Both authenticate with the
  **node token** (generated at setup, shown on the Settings page) and end up in
  the same `saveReport()` path.
- **Master → browser**: the page is server-rendered from the DB on first paint,
  then the client polls `/api/nodes` every 3s. Polling works on every host
  (Vercel included); the websocket is only for the node side.

## Configuration — one env var

The **only** required environment variable is `DATABASE_URL`. Everything else —
the admin account, node token, ipinfo token, and notification channels — is
configured from the dashboard and stored in PostgreSQL.

On first visit the app redirects to **`/setup`** to create the admin account
(email + password; the form follows Google standards so the browser/password
manager offers to generate & save a strong password). After that, **`/login`**
guards the Settings page. Login is rate-limited (per-IP and per-email, DB-backed
so it holds across serverless instances). The dashboard and `/latency` pages
are public status views.

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
npm install

# (a) plain Next.js — nodes must use transport: http
npm run dev                 # http://localhost:3000

# (b) custom server with the node WebSocket endpoint
npm run dev:ws              # http://localhost:8080  + ws /api/ws/node
```

Open the app, complete `/setup` to create the admin account, then copy the
**node token** from Settings → Servers and point a node at the master:

```sh
# websocket (needs dev:ws / start:ws)
../node/wolf-node -e ws://localhost:8080 -t "<NODE_TOKEN>"

# http (works against npm run dev too)
../node/wolf-node -e http://localhost:3000 -t "<NODE_TOKEN>" -transport http
```

## Deploy to Vercel

Vercel runs serverless functions and **cannot hold a websocket**, so on Vercel
nodes must use `transport: http` → `/api/report`. Everything else is unchanged.

1. Push this `master/` directory to a Git repo and import it on Vercel (root
   directory = `master`).
2. Set the one env var in the Vercel dashboard:
   - `DATABASE_URL` — your remote Postgres URL (use the **pooled** connection
     string from Neon/Supabase for serverless).
3. Deploy, open `https://<app>.vercel.app`, and complete `/setup`.
4. Copy the node token from Settings → Servers and run nodes with:
   ```sh
   wolf-node -e https://<app>.vercel.app -t <NODE_TOKEN> -transport http
   ```

Works the same behind Cloudflare or any CDN — point the CDN at the Vercel app
and use the CDN hostname as the node endpoint.

## Self-host (with node WebSocket)

```sh
npm run build
DATABASE_URL=postgres://... PORT=8080 npm run start:ws
```

`server.js` serves both the dashboard and the `/api/ws/node` websocket on the
same port.

## Monitoring & notifications

Configured from the **Settings** page (`/settings`) and evaluated by
`/api/cron/check` (Vercel Cron on Vercel, the `server.js` loop when self-hosted).

- **负载通知 / Load alerts** — fire when a metric (CPU / RAM / DISK) stays at or
  above a threshold for at least a *time-ratio* of the samples within a trailing
  *window* (e.g. CPU ≥ 80% for 80% of the last 15 min). Per-server or all servers.
- **离线通知 / Offline alerts** — per-server, with a grace period (e.g. 180s).
  Notifies when a node stops reporting and again when it recovers.
- **延迟监测 / Latency monitors** — selected nodes probe a target over **TCP** or
  **ICMP** every N seconds; results are charted under `/latency`. Nodes pull
  their assignments from `/api/tasks` and POST samples to `/api/ping`.

Notifications fire on state transitions (and re-notify a sustained issue every
30 min). Configure them from **Settings → 通知 / Notifications** (stored in the
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

> **Cron frequency on Vercel:** `vercel.json` schedules `/api/cron/check` every
> minute. Frequent crons need a Vercel **Pro** plan; on Hobby, point an external
> uptime pinger at `/api/cron/check` (send `Authorization: Bearer <CRON_SECRET>`)
> instead.

The Settings APIs are guarded by the **admin session** (login cookie) — no
token header needed.

## Environment variables

Only `DATABASE_URL` is required; the rest are rarely-needed optionals.

| Var | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | **yes** | remote PostgreSQL connection string |
| `CRON_SECRET` | no | if set, `/api/cron/check` requires `Authorization: Bearer <secret>` (Vercel Cron sends it automatically) |
| `NOTIFY_TELEGRAM_TOKEN` / `NOTIFY_TELEGRAM_CHAT` / `NOTIFY_WEBHOOK_URL` | no | notification fallback when not configured in Settings |
| `PG_POOL_MAX` | no | max pool connections (default 4) |
| `PGSSL` | no | set to `disable` to turn off SSL |
| `EVAL_INTERVAL_MS` | no | self-host eval loop interval (default 30000) |
| `PORT` / `HOST` | no | only used by `server.js` (self-host), default 8080 / 0.0.0.0 |

Configured in the dashboard (DB-backed) instead of env: **admin account**,
**node token**, **ipinfo token**, **notification channels**.
