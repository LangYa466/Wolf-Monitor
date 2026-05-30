import { Pool } from "pg";
import type { HostInfo, Metrics, NodeView, Report } from "./types";

// A node is considered offline if no report arrived within this window.
export const OFFLINE_AFTER_MS = 15_000;

// Cache the pool on globalThis so Next.js hot-reload and serverless warm
// invocations reuse a single pool instead of leaking connections.
const globalForDb = globalThis as unknown as {
  __llPool?: Pool;
  __llSchema?: Promise<void>;
};

export function getPool(): Pool {
  if (!globalForDb.__llPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForDb.__llPool = new Pool({
      connectionString,
      // Keep it small: serverless functions are short-lived and remote
      // Postgres (Neon/Supabase) pools should not be exhausted.
      max: Number(process.env.PG_POOL_MAX ?? 4),
      ssl: sslOption(connectionString),
    });
  }
  return globalForDb.__llPool;
}

// Enable SSL for managed Postgres unless explicitly disabled. `?sslmode=disable`
// in the URL or PGSSL=disable turns it off (e.g. local dev).
function sslOption(connectionString: string) {
  if (
    process.env.PGSSL === "disable" ||
    /sslmode=disable/.test(connectionString)
  ) {
    return undefined;
  }
  return { rejectUnauthorized: false };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  host         JSONB NOT NULL,
  metrics      JSONB NOT NULL,
  last_seen    BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metrics_history (
  id        BIGSERIAL PRIMARY KEY,
  node_id   TEXT NOT NULL,
  ts        BIGINT NOT NULL,
  cpu       DOUBLE PRECISION NOT NULL,
  mem_pct   DOUBLE PRECISION NOT NULL,
  disk_pct  DOUBLE PRECISION NOT NULL,
  net_up    BIGINT NOT NULL,
  net_down  BIGINT NOT NULL,
  disk_r    BIGINT NOT NULL,
  disk_w    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS metrics_history_node_ts
  ON metrics_history (node_id, ts DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  metric         TEXT NOT NULL,
  threshold      DOUBLE PRECISION NOT NULL,
  ratio          DOUBLE PRECISION NOT NULL,
  window_minutes INTEGER NOT NULL,
  targets        JSONB NOT NULL DEFAULT '[]',
  enabled        BOOLEAN NOT NULL DEFAULT TRUE
);

-- Per (rule, node) firing state so we notify only on edges, not every tick.
CREATE TABLE IF NOT EXISTS alert_state (
  rule_id       TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  firing        BOOLEAN NOT NULL DEFAULT FALSE,
  last_notified BIGINT,
  PRIMARY KEY (rule_id, node_id)
);

CREATE TABLE IF NOT EXISTS offline_settings (
  node_id       TEXT PRIMARY KEY,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  grace_seconds INTEGER NOT NULL DEFAULT 180,
  last_notified BIGINT,
  offline       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ping_tasks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  target           TEXT NOT NULL,
  type             TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  node_ids         JSONB NOT NULL DEFAULT '[]',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS ping_results (
  id         BIGSERIAL PRIMARY KEY,
  task_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  ts         BIGINT NOT NULL,
  latency_ms DOUBLE PRECISION NOT NULL,
  success    BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS ping_results_task_node_ts
  ON ping_results (task_id, node_id, ts DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Admin accounts (created via the first-run /setup page).
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- Login rate-limiting ledger (per IP / per email).
CREATE TABLE IF NOT EXISTS auth_attempts (
  id      BIGSERIAL PRIMARY KEY,
  scope   TEXT NOT NULL,
  ts      BIGINT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS auth_attempts_scope_ts ON auth_attempts (scope, ts DESC);

-- Columns added to nodes after the initial release.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 1000000;
`;

// Generic key/value settings (notification config, etc.).
export async function getSetting<T>(key: string): Promise<T | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ value: T }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key]
  );
  return rows.length ? rows[0].value : null;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

// ensureSchema runs the idempotent DDL exactly once per process.
export function ensureSchema(): Promise<void> {
  if (!globalForDb.__llSchema) {
    globalForDb.__llSchema = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        // Reset so a later request can retry (e.g. transient DB outage).
        globalForDb.__llSchema = undefined;
        throw err;
      });
  }
  return globalForDb.__llSchema;
}

// saveReport upserts the node's latest state and appends a history row.
// `ip`/`country` are resolved by the caller (it has the request headers); when
// omitted the existing values are preserved (COALESCE). New nodes get a
// sort_order placing them at the end.
export async function saveReport(
  report: Report,
  opts: { ip?: string | null; country?: string | null } = {}
): Promise<NodeView> {
  await ensureSchema();
  const pool = getPool();
  const id = report.host.hostname || "unknown";
  const now = Date.now();
  const m = report.metrics;
  const ip = opts.ip ?? null;
  const country = opts.country ?? null;

  const { rows } = await pool.query<{ sort_order: number; country: string | null; ip: string | null }>(
    `INSERT INTO nodes (id, host, metrics, last_seen, updated_at, ip, country, sort_order)
     VALUES ($1, $2, $3, $4, now(), $5, $6,
             COALESCE((SELECT MAX(sort_order) + 1 FROM nodes), 0))
     ON CONFLICT (id) DO UPDATE
       SET host = EXCLUDED.host,
           metrics = EXCLUDED.metrics,
           last_seen = EXCLUDED.last_seen,
           updated_at = now(),
           ip = COALESCE($5, nodes.ip),
           country = COALESCE($6, nodes.country)
     RETURNING sort_order, country, ip`,
    [id, JSON.stringify(report.host), JSON.stringify(m), now, ip, country]
  );

  await pool.query(
    `INSERT INTO metrics_history
       (node_id, ts, cpu, mem_pct, disk_pct, net_up, net_down, disk_r, disk_w)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      now,
      m.cpuUsage,
      m.memPercent,
      m.diskPercent,
      m.netUpSpeed,
      m.netDownSpeed,
      m.diskReadSpeed,
      m.diskWriteSpeed,
    ]
  );

  return {
    id,
    host: report.host,
    metrics: m,
    lastSeen: now,
    online: true,
    ip: rows[0]?.ip ?? ip,
    country: rows[0]?.country ?? country,
    sortOrder: rows[0]?.sort_order ?? 0,
  };
}

export async function listNodes(): Promise<NodeView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: string;
    host: HostInfo;
    metrics: Metrics;
    last_seen: string;
    ip: string | null;
    country: string | null;
    sort_order: number;
  }>(
    `SELECT id, host, metrics, last_seen, ip, country, sort_order
       FROM nodes ORDER BY sort_order ASC, id ASC`
  );

  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    metrics: r.metrics,
    lastSeen: Number(r.last_seen),
    online: now - Number(r.last_seen) < OFFLINE_AFTER_MS,
    ip: r.ip,
    country: r.country ? r.country.toLowerCase() : null,
    sortOrder: r.sort_order,
  }));
}

// getNodeNet returns a node's stored ip/country (or null if unknown), so the
// caller can decide whether a geo lookup is needed.
export async function getNodeNet(
  id: string
): Promise<{ ip: string | null; country: string | null } | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ ip: string | null; country: string | null }>(
    `SELECT ip, country FROM nodes WHERE id = $1`,
    [id]
  );
  return rows.length ? { ip: rows[0].ip, country: rows[0].country } : null;
}

// setNodeOrder persists a manual drag-reorder: ids in their new display order.
export async function setNodeOrder(orderedIds: string[]): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE nodes SET sort_order = $1 WHERE id = $2`, [
        i,
        orderedIds[i],
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface HistoryPoint {
  ts: number;
  cpu: number;
  memPct: number;
  diskPct: number;
  netUp: number;
  netDown: number;
  diskR: number;
  diskW: number;
}

export async function getHistory(
  nodeId: string,
  limit = 120
): Promise<HistoryPoint[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT ts, cpu, mem_pct, disk_pct, net_up, net_down, disk_r, disk_w
       FROM metrics_history
      WHERE node_id = $1
      ORDER BY ts DESC
      LIMIT $2`,
    [nodeId, limit]
  );
  return rows
    .map((r) => ({
      ts: Number(r.ts),
      cpu: r.cpu,
      memPct: r.mem_pct,
      diskPct: r.disk_pct,
      netUp: Number(r.net_up),
      netDown: Number(r.net_down),
      diskR: Number(r.disk_r),
      diskW: Number(r.disk_w),
    }))
    .reverse(); // chronological for charting
}

// pruneHistory trims rows older than the retention window (best-effort).
export async function pruneHistory(retentionMs = 6 * 60 * 60 * 1000) {
  try {
    await getPool().query(`DELETE FROM metrics_history WHERE ts < $1`, [
      Date.now() - retentionMs,
    ]);
  } catch {
    /* best-effort */
  }
}
