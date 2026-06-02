import { Pool } from "pg";
import type { HostInfo, Metrics, NodeView, Report } from "./types";
import { encodeNodeId } from "./opaqueid";

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
      // Serverless reality: every concurrent function instance owns its own
      // pool. With max=4 and even modest fan-out we blow past the DB's
      // max_connections (Neon/Supabase free tiers cap at ~20–100). Default to
      // 1 connection per instance so total in-flight ≈ instance count; raise
      // PG_POOL_MAX only when running self-hosted with a fat DB.
      max: Number(process.env.PG_POOL_MAX ?? 1),
      // Close idle connections quickly so warm-but-unused instances don't sit
      // on a slot. Cap connect time so a saturated DB fails fast instead of
      // queueing the whole request behind a 30s default.
      idleTimeoutMillis: Number(process.env.PG_IDLE_MS ?? 10_000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_MS ?? 5_000),
      ssl: sslOption(connectionString),
    });
    // Surface pool-level errors instead of crashing the worker on a dropped
    // idle connection. `pg` re-emits the error on the pool itself when the
    // client errors outside of a query (e.g. server-side timeout).
    globalForDb.__llPool.on("error", (err) => {
      console.error("pg pool error:", err.message);
    });
  }
  return globalForDb.__llPool;
}

// Enable SSL for managed Postgres unless explicitly disabled. `?sslmode=disable`
// in the URL or PGSSL=disable turns it off (e.g. local dev). Otherwise the
// server certificate is VERIFIED by default — supply a CA via PG_CA_CERT (PEM
// or base64-PEM) for private CAs, or set PGSSL=no-verify as a last resort for
// providers that ship incomplete chains.
function sslOption(connectionString: string) {
  if (
    process.env.PGSSL === "disable" ||
    /sslmode=disable/.test(connectionString)
  ) {
    return undefined;
  }
  if (process.env.PGSSL === "no-verify") {
    return { rejectUnauthorized: false };
  }
  const caRaw = process.env.PG_CA_CERT;
  const ca = caRaw
    ? caRaw.includes("BEGIN CERTIFICATE")
      ? caRaw
      : Buffer.from(caRaw, "base64").toString("utf8")
    : undefined;
  return { rejectUnauthorized: true, ca };
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

-- Extra history series for the per-server detail charts (process count,
-- TCP connections, absolute memory/swap usage). Added after initial release.
ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS procs     BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS tcp       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS mem_used  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS swap_used BIGINT NOT NULL DEFAULT 0;

-- Stable auto-increment id (hidden behind an encrypted opaque id in URLs) and
-- an optional admin-set display name. Adding a serial column backfills existing
-- rows with sequence values automatically.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS seq  BIGSERIAL;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS name TEXT;

-- Latency task node selection mode: when true, node_ids is a blacklist
-- (all nodes probe the target except those listed) instead of an allowlist.
ALTER TABLE ping_tasks ADD COLUMN IF NOT EXISTS exclude BOOLEAN NOT NULL DEFAULT FALSE;

-- Same allowlist/blacklist switch on alert rules' targets column.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS exclude BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-node admission tokens. Each node has its own token (the "key" the install
-- script embeds). An unbound token (node_id IS NULL) is reserved for a future
-- node and binds to the hostname on its first /api/report. Once bound, only
-- that token authorizes reports for that node.
CREATE TABLE IF NOT EXISTS node_tokens (
  token      TEXT PRIMARY KEY,
  node_id    TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS node_tokens_node ON node_tokens (node_id);
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

// app_settings key: when true, unauthenticated visitors may view the live
// dashboard (with sensitive fields stripped — see publicNodes). Default false.
export const PUBLIC_DASHBOARD_KEY = "publicDashboard";

export async function isPublicDashboard(): Promise<boolean> {
  return (await getSetting<boolean>(PUBLIC_DASHBOARD_KEY)) === true;
}

// Strip sensitive fields from nodes before exposing them to guests. Currently
// that's the IP; the rest (hostname, OS, country, live metrics) is non-sensitive
// and is what makes the public "server live" view useful.
export function publicNodes(nodes: NodeView[]): NodeView[] {
  return nodes.map((n) => ({ ...n, ip: null }));
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

  const { rows } = await pool.query<{
    sort_order: number;
    country: string | null;
    ip: string | null;
    seq: string;
    name: string | null;
  }>(
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
     RETURNING sort_order, country, ip, seq, name`,
    [id, JSON.stringify(report.host), JSON.stringify(m), now, ip, country]
  );

  await pool.query(
    `INSERT INTO metrics_history
       (node_id, ts, cpu, mem_pct, disk_pct, net_up, net_down, disk_r, disk_w,
        procs, tcp, mem_used, swap_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      m.procs,
      m.tcpConns,
      m.memUsed,
      m.swapUsed,
    ]
  );

  return {
    id,
    opaqueId: await encodeNodeId(Number(rows[0]?.seq ?? 0)),
    name: rows[0]?.name ?? null,
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
    seq: string;
    name: string | null;
  }>(
    `SELECT id, host, metrics, last_seen, ip, country, sort_order, seq, name
       FROM nodes ORDER BY sort_order ASC, id ASC`
  );

  const now = Date.now();
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      opaqueId: await encodeNodeId(Number(r.seq ?? 0)),
      name: r.name ?? null,
      host: r.host,
      metrics: r.metrics,
      lastSeen: Number(r.last_seen),
      online: now - Number(r.last_seen) < OFFLINE_AFTER_MS,
      ip: r.ip,
      country: r.country ? r.country.toLowerCase() : null,
      sortOrder: r.sort_order,
    }))
  );
}

// deleteNode removes a node and every row that references it across the
// monitoring schema — history, alert/offline state, ping results, node
// tokens — and prunes its id out of the JSONB target arrays on alert_rules
// and ping_tasks so deleted nodes can never reappear as a phantom target.
// Runs in a transaction so a partial failure doesn't leave dangling refs.
export async function deleteNode(id: string): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM metrics_history WHERE node_id = $1`, [id]);
    await client.query(`DELETE FROM alert_state WHERE node_id = $1`, [id]);
    await client.query(`DELETE FROM offline_settings WHERE node_id = $1`, [id]);
    await client.query(`DELETE FROM ping_results WHERE node_id = $1`, [id]);
    await client.query(`DELETE FROM node_tokens WHERE node_id = $1`, [id]);
    // Prune the id from JSONB target arrays. `jsonb - text` doesn't exist on
    // arrays, so use a subquery that rebuilds the array minus this id.
    await client.query(
      `UPDATE alert_rules
          SET targets = COALESCE(
            (SELECT jsonb_agg(elem)
               FROM jsonb_array_elements_text(targets) elem
              WHERE elem <> $1),
            '[]'::jsonb)
        WHERE targets ? $1`,
      [id],
    );
    await client.query(
      `UPDATE ping_tasks
          SET node_ids = COALESCE(
            (SELECT jsonb_agg(elem)
               FROM jsonb_array_elements_text(node_ids) elem
              WHERE elem <> $1),
            '[]'::jsonb)
        WHERE node_ids ? $1`,
      [id],
    );
    await client.query(`DELETE FROM nodes WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// setNodeName updates a node's display name (empty string clears it). Keyed by
// the internal hostname id.
export async function setNodeName(id: string, name: string): Promise<void> {
  await ensureSchema();
  const trimmed = name.trim();
  await getPool().query(`UPDATE nodes SET name = $1 WHERE id = $2`, [
    trimmed || null,
    id,
  ]);
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
  procs: number;
  tcp: number;
  memUsed: number;
  swapUsed: number;
}

export async function getHistory(
  nodeId: string,
  limit = 120,
  sinceMs?: number
): Promise<HistoryPoint[]> {
  await ensureSchema();
  const params: (string | number)[] = [nodeId];
  let where = `node_id = $1`;
  if (sinceMs && sinceMs > 0) {
    params.push(sinceMs);
    where += ` AND ts >= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT ts, cpu, mem_pct, disk_pct, net_up, net_down, disk_r, disk_w,
            procs, tcp, mem_used, swap_used
       FROM metrics_history
      WHERE ${where}
      ORDER BY ts DESC
      LIMIT $${params.length}`,
    params
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
      procs: Number(r.procs),
      tcp: Number(r.tcp),
      memUsed: Number(r.mem_used),
      swapUsed: Number(r.swap_used),
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
