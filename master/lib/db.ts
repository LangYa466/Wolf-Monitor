import { Pool } from "pg";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import type { HostInfo, Metrics, NodeView, Report } from "./types";
import { decodeNodeId, encodeNodeId } from "./opaqueid";

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
  id               TEXT PRIMARY KEY,
  host             JSONB NOT NULL,
  metrics          JSONB NOT NULL,
  last_seen        BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_history_ts  BIGINT NOT NULL DEFAULT 0
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

-- Plain-ts index makes the retention prune (WHERE ts < cutoff) cheap once
-- the table grows.
CREATE INDEX IF NOT EXISTS ping_results_ts ON ping_results (ts);

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
-- Admin-pinned country override. When TRUE, /api/report keeps the existing
-- country value instead of overwriting it from ipinfo. Lets operators force a
-- flag for nodes behind CGNAT / overlay networks where the WAN egress IP
-- doesn't match the box's actual location.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS country_manual BOOLEAN NOT NULL DEFAULT FALSE;

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

-- Per-node history-write throttle. Added after initial release; defaults to 0.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_history_ts BIGINT NOT NULL DEFAULT 0;

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

-- Pin an unbound token to the first hostname that claimed it, so a
-- leaked/shared legacy token can't be replayed under a different hostname.
ALTER TABLE node_tokens ADD COLUMN IF NOT EXISTS claimed_node_id TEXT;

-- Per-row sha256 of the plaintext token. All admission/authorization lookups
-- query by token_hash instead of the plaintext token column so the equality
-- check on the hot path is over a fixed-width digest (no length-oracle /
-- partial-match surface area). New rows write only the hash + an encrypted
-- envelope of the plaintext (see token_enc below); legacy rows that still
-- have the plaintext in the token column are lazily migrated on first read.
ALTER TABLE node_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;
UPDATE node_tokens
   SET token_hash = encode(digest(token, 'sha256'), 'hex')
 WHERE token_hash IS NULL
   AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto');
-- pgcrypto may not be installed; new inserts always populate token_hash from
-- the application layer, and the auth-layer lazy migration backfills any
-- pre-pgcrypto rows on first authorize.
CREATE UNIQUE INDEX IF NOT EXISTS node_tokens_hash ON node_tokens (token_hash);

-- AES-256-GCM envelope of the plaintext admission token, wrapped under the
-- same KEK as app_settings (see encryptEnvelope above). Lets us drop the
-- plaintext token column without losing the install-snippet UX — operators
-- can still pull the token out of the admin UI, but a DB dump alone no
-- longer reveals it. Plaintext column is kept nullable for legacy rows
-- pending lazy migration; new inserts set token=NULL.
ALTER TABLE node_tokens ADD COLUMN IF NOT EXISTS token_enc JSONB;
-- The original table had token TEXT PRIMARY KEY. We need to insert NULL
-- into the token column for new rows, so swap the PK to token_hash (the
-- unique index above already covers the equality lookup) and drop NOT NULL.
DO $$
BEGIN
  ALTER TABLE node_tokens DROP CONSTRAINT IF EXISTS node_tokens_pkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE node_tokens ALTER COLUMN token DROP NOT NULL;

-- For future session listing/revoke UI.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at BIGINT;

-- Append-only audit trail for admin/security-relevant actions.
CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  ts      BIGINT NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  details JSONB
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts DESC);

-- Backfill an FK from ping_results.task_id to ping_tasks.id without validating
-- pre-existing rows (NOT VALID skips the scan). Wrapped to swallow the
-- duplicate_object error so subsequent ensureSchema() runs are idempotent.
DO $$
BEGIN
  ALTER TABLE ping_results
    ADD CONSTRAINT ping_results_task_fk
    FOREIGN KEY (task_id) REFERENCES ping_tasks(id) ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

// ── app_settings envelope encryption ───────────────────────────────────────
//
// Several settings rows hold long-lived credentials (Telegram bot token,
// ipinfo token, the legacy shared nodeToken, opaque-id Feistel key/tweak,
// webhook URLs). A DB dump alone used to reveal them all in plaintext.
//
// We now wrap values for SENSITIVE_KEYS with AES-256-GCM under a key derived
// from WOLF_SECRET_KEY (falling back to DATABASE_URL so existing single-env
// deployments keep working — operators are encouraged to set WOLF_SECRET_KEY
// explicitly). The wrapping is transparent to callers: getSetting returns the
// plaintext, setSetting accepts the plaintext. Existing un-encrypted rows are
// still readable (lazy upgrade — next write encrypts them).
const SENSITIVE_KEYS = new Set<string>([
  "nodeToken",
  "ipinfoToken",
  "notify",
  "idCipherKey",
  "idCipherTweak",
]);

interface EncryptedEnvelope {
  _wenc: "v1";
  iv: string;
  ct: string;
  tag: string;
}

function isEncryptedEnvelope(v: unknown): v is EncryptedEnvelope {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o._wenc === "v1" &&
    typeof o.iv === "string" &&
    typeof o.ct === "string" &&
    typeof o.tag === "string"
  );
}

let CACHED_KEK: Buffer | null = null;
function getKek(): Buffer {
  if (CACHED_KEK) return CACHED_KEK;
  const material =
    process.env.WOLF_SECRET_KEY || process.env.DATABASE_URL || "";
  if (!material) {
    throw new Error(
      "WOLF_SECRET_KEY (or DATABASE_URL) required to derive app_settings KEK",
    );
  }
  // scryptSync is one-shot at boot; salt is a fixed app-scoped string so the
  // same material always derives the same key — required for envelope
  // round-tripping across restarts.
  CACHED_KEK = scryptSync(material, "wolf-app-settings-v1", 32);
  return CACHED_KEK;
}

export function encryptSecretAtRest(plain: string): EncryptedEnvelope {
  return encryptEnvelope(plain);
}

export function decryptSecretAtRest(env: unknown): string | null {
  if (!isEncryptedEnvelope(env)) return null;
  try {
    return decryptEnvelope(env);
  } catch (err) {
    console.error(
      `decryptSecretAtRest: ${(err as Error).message}`,
    );
    return null;
  }
}

function encryptEnvelope(plain: string): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKek(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _wenc: "v1",
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptEnvelope(env: EncryptedEnvelope): string {
  const iv = Buffer.from(env.iv, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKek(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString("utf8");
}

// Generic key/value settings (notification config, etc.).
export async function getSetting<T>(key: string): Promise<T | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key]
  );
  if (!rows.length) return null;
  const raw = rows[0].value;
  if (isEncryptedEnvelope(raw)) {
    try {
      return JSON.parse(decryptEnvelope(raw)) as T;
    } catch (err) {
      // Wrong KEK / tampered envelope — surface as missing rather than crash
      // the caller. Operators see the log; users get a clean re-setup path.
      console.error(
        `app_settings: failed to decrypt key=${key}: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return raw as T;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await ensureSchema();
  const payload = SENSITIVE_KEYS.has(key)
    ? JSON.stringify(encryptEnvelope(JSON.stringify(value)))
    : JSON.stringify(value);
  await getPool().query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, payload]
  );
}

// app_settings key: when true, unauthenticated visitors may view the live
// dashboard (with sensitive fields stripped — see publicNodes). Default false.
export const PUBLIC_DASHBOARD_KEY = "publicDashboard";

export async function isPublicDashboard(): Promise<boolean> {
  return (await getSetting<boolean>(PUBLIC_DASHBOARD_KEY)) === true;
}

// Public dashboard exposure: hide IP, latency (admin-only on the route side),
// and the host's machine name (some operators run probes with hostnames that
// leak project/customer identifiers). All other host facts (CPU model,
// memory/disk totals, uptime, boot time) and live metrics pass through.
export function publicNodes(nodes: NodeView[]): NodeView[] {
  return nodes.map(
    (n) =>
      ({
        id: n.opaqueId, // url identity stays opaque
        opaqueId: n.opaqueId,
        name: n.name, // admin-set display name (intentional)
        host: { ...n.host, hostname: "" },
        metrics: n.metrics,
        lastSeen: n.lastSeen,
        online: n.online,
        ip: null,
        country: n.country,
        sortOrder: n.sortOrder,
      }) as NodeView,
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

// Size caps for adversarial node payloads. Anything bigger gets rejected
// before it can bloat the row, the PK B-tree, or /api/nodes egress.
const MAX_HOST_BYTES = 4096;
const MAX_METRICS_BYTES = 4096;
// RFC 1123-ish hostname (underscore tolerated for Windows). Used as nodes.id
// PRIMARY KEY and FK across history/state tables — bound it tightly.
const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,253}$/;
// Minimum gap between metrics_history rows per node. Caps a hostile node
// looping POSTs at 1 history row / 5s regardless of report cadence.
const HISTORY_MIN_INTERVAL_MS = 5_000;

function sanitizeHost(h: HostInfo): HostInfo {
  const s = (v: unknown, max: number) => String(v ?? "").slice(0, max);
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    hostname: s(h?.hostname, 253),
    os: s(h?.os, 64),
    platform: s(h?.platform, 64),
    platformVersion: s(h?.platformVersion, 64),
    arch: s(h?.arch, 32),
    cpuModel: s(h?.cpuModel, 128),
    cpuCores: n(h?.cpuCores),
    memTotal: n(h?.memTotal),
    swapTotal: n(h?.swapTotal),
    diskTotal: n(h?.diskTotal),
    bootTime: n(h?.bootTime),
    // Persisted so the Settings page can show per-node version drift; old
    // binaries that don't report it land here as empty string and the UI
    // renders "—".
    agentVersion: s(h?.agentVersion, 64),
  };
}

function sanitizeMetrics(m: Metrics): Metrics {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    uptime: n(m?.uptime),
    cpuUsage: n(m?.cpuUsage),
    memUsed: n(m?.memUsed),
    memPercent: n(m?.memPercent),
    swapUsed: n(m?.swapUsed),
    diskUsed: n(m?.diskUsed),
    diskPercent: n(m?.diskPercent),
    diskReadBytes: n(m?.diskReadBytes),
    diskWriteBytes: n(m?.diskWriteBytes),
    diskReadSpeed: n(m?.diskReadSpeed),
    diskWriteSpeed: n(m?.diskWriteSpeed),
    netSent: n(m?.netSent),
    netRecv: n(m?.netRecv),
    netUpSpeed: n(m?.netUpSpeed),
    netDownSpeed: n(m?.netDownSpeed),
    load1: n(m?.load1),
    load5: n(m?.load5),
    load15: n(m?.load15),
    tcpConns: n(m?.tcpConns),
    procs: n(m?.procs),
  };
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
  const safeHost = sanitizeHost(report.host);
  const safeMetrics = sanitizeMetrics(report.metrics);
  // hostname is the PK and FK target — reject anything outside a strict
  // charset (no control chars, no whitespace, no oversized strings).
  if (!HOSTNAME_RE.test(safeHost.hostname)) {
    throw new Error("invalid hostname");
  }
  const hostJson = JSON.stringify(safeHost);
  const metricsJson = JSON.stringify(safeMetrics);
  if (hostJson.length > MAX_HOST_BYTES || metricsJson.length > MAX_METRICS_BYTES) {
    throw new Error("report payload too large");
  }
  const id = safeHost.hostname;
  const now = Date.now();
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
           country = CASE WHEN nodes.country_manual THEN nodes.country
                          ELSE COALESCE($6, nodes.country) END
     RETURNING sort_order, country, ip, seq, name`,
    [id, hostJson, metricsJson, now, ip, country]
  );

  // Throttle metrics_history writes per node: at most 1 row / HISTORY_MIN_INTERVAL_MS.
  // The UPDATE acts as an atomic claim — only the caller that wins it inserts.
  const claim = await pool.query(
    `UPDATE nodes SET last_history_ts = $2
       WHERE id = $1 AND $2 - last_history_ts >= $3`,
    [id, now, HISTORY_MIN_INTERVAL_MS],
  );
  if (claim.rowCount === 1) {
    await pool.query(
      `INSERT INTO metrics_history
         (node_id, ts, cpu, mem_pct, disk_pct, net_up, net_down, disk_r, disk_w,
          procs, tcp, mem_used, swap_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        now,
        safeMetrics.cpuUsage,
        safeMetrics.memPercent,
        safeMetrics.diskPercent,
        safeMetrics.netUpSpeed,
        safeMetrics.netDownSpeed,
        safeMetrics.diskReadSpeed,
        safeMetrics.diskWriteSpeed,
        safeMetrics.procs,
        safeMetrics.tcpConns,
        safeMetrics.memUsed,
        safeMetrics.swapUsed,
      ]
    );
  }

  return {
    id,
    opaqueId: await encodeNodeId(Number(rows[0]?.seq ?? 0)),
    name: rows[0]?.name ?? null,
    host: safeHost,
    metrics: safeMetrics,
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
// caller can decide whether a geo lookup is needed. `countryManual` lets the
// caller skip the lookup entirely when an admin has pinned the flag.
export async function getNodeNet(
  id: string
): Promise<{ ip: string | null; country: string | null; countryManual: boolean } | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    ip: string | null;
    country: string | null;
    country_manual: boolean;
  }>(
    `SELECT ip, country, country_manual FROM nodes WHERE id = $1`,
    [id]
  );
  return rows.length
    ? { ip: rows[0].ip, country: rows[0].country, countryManual: rows[0].country_manual }
    : null;
}

// setNodeCountry pins (or clears) a node's country flag. Passing null clears
// the override and lets the next report re-resolve via ipinfo.
export async function setNodeCountry(
  id: string,
  code: string | null
): Promise<void> {
  await ensureSchema();
  if (code === null) {
    await getPool().query(
      `UPDATE nodes SET country = NULL, country_manual = FALSE WHERE id = $1`,
      [id],
    );
    return;
  }
  await getPool().query(
    `UPDATE nodes SET country = $1, country_manual = TRUE WHERE id = $2`,
    [code.toUpperCase(), id],
  );
}

// Hard cap on reorder payload — protects the single pooled DB connection
// against a buggy/malicious client posting a multi-MB id array.
const MAX_ORDER_IDS = 1000;

// setNodeOrder persists a manual drag-reorder: ids in their new display order.
// Collapses N updates into a single statement via unnest(), so an oversized
// (or just plain large) admin payload can't monopolize the pool.
export async function setNodeOrder(orderedIds: string[]): Promise<void> {
  await ensureSchema();
  if (orderedIds.length === 0) return;
  if (orderedIds.length > MAX_ORDER_IDS) {
    throw new Error("order list too large");
  }
  const idxs = orderedIds.map((_, i) => i);
  await getPool().query(
    `UPDATE nodes AS n
        SET sort_order = v.idx
       FROM unnest($1::text[], $2::int[]) AS v(id, idx)
      WHERE n.id = v.id`,
    [orderedIds, idxs],
  );
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

// Public callers (guests on a public dashboard) receive the opaque (encrypted)
// id rather than the internal hostname, so the history route can't query
// `metrics_history WHERE node_id = $1` directly. Decode opaque → hostname
// first so the same callsite works for admins (passing hostname) and guests
// (passing opaque) without leaking the hostname back through the API.
export async function resolveInternalNodeId(idOrOpaque: string): Promise<string | null> {
  await ensureSchema();
  // Opaque ids are decimal-only (Feistel over base-10); a hostname always
  // contains a non-digit. This avoids a needless DB round-trip on the common
  // admin path.
  if (!/^\d{1,10}$/.test(idOrOpaque)) return idOrOpaque;
  const seq = await decodeNodeId(idOrOpaque);
  if (seq == null) return null;
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM nodes WHERE seq = $1 LIMIT 1`,
    [seq],
  );
  return rows[0]?.id ?? null;
}

export async function getHistory(
  idOrOpaque: string,
  limit = 120,
  sinceMs?: number
): Promise<HistoryPoint[]> {
  await ensureSchema();
  const nodeId = await resolveInternalNodeId(idOrOpaque);
  if (!nodeId) return [];

  // Sample rows land in metrics_history every HISTORY_MIN_INTERVAL_MS (5s).
  // Over a 7-day window that's up to 120k rows, and a naive `ORDER BY ts DESC
  // LIMIT $limit` would silently truncate to the most recent ~3 hours, so the
  // 7d/30d picks would draw a few hours of data under a "7d" axis label. When
  // the caller passes a sinceMs we bucket-AVG by `(now-sinceMs)/limit` ms so
  // each chart pixel corresponds to a real time slice instead of a head-truncated
  // tail. For realtime (no sinceMs) we keep the raw LIMIT path — the chart wants
  // the last N samples verbatim.
  const noWindow = !sinceMs || sinceMs <= 0;
  if (noWindow) {
    const { rows } = await getPool().query(
      `SELECT ts, cpu, mem_pct, disk_pct, net_up, net_down, disk_r, disk_w,
              procs, tcp, mem_used, swap_used
         FROM metrics_history
        WHERE node_id = $1
        ORDER BY ts DESC
        LIMIT $2`,
      [nodeId, limit],
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
      .reverse();
  }

  // Bucket size in ms; never smaller than the per-row write interval so we
  // don't ask Postgres to GROUP BY a column with one row per bucket.
  const windowMs = Math.max(1, Date.now() - sinceMs);
  const bucketMs = Math.max(HISTORY_MIN_INTERVAL_MS, Math.ceil(windowMs / Math.max(1, limit)));

  const { rows } = await getPool().query(
    `SELECT (ts / $3)::bigint * $3 AS bucket_ts,
            AVG(cpu)::float8       AS cpu,
            AVG(mem_pct)::float8   AS mem_pct,
            AVG(disk_pct)::float8  AS disk_pct,
            AVG(net_up)::float8    AS net_up,
            AVG(net_down)::float8  AS net_down,
            AVG(disk_r)::float8    AS disk_r,
            AVG(disk_w)::float8    AS disk_w,
            AVG(procs)::float8     AS procs,
            AVG(tcp)::float8       AS tcp,
            AVG(mem_used)::float8  AS mem_used,
            AVG(swap_used)::float8 AS swap_used
       FROM metrics_history
      WHERE node_id = $1 AND ts >= $2
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
      LIMIT $4`,
    [nodeId, sinceMs, bucketMs, limit],
  );
  return rows.map((r) => ({
    ts: Number(r.bucket_ts),
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
  }));
}

// pruneHistory trims rows older than the retention window (best-effort).
// Covers both metrics_history and ping_results — the latter is otherwise
// never pruned and grows linearly with task_count × node_count × tick_rate.
export async function pruneHistory(retentionMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - retentionMs;
  const pool = getPool();
  try {
    await pool.query(`DELETE FROM metrics_history WHERE ts < $1`, [cutoff]);
  } catch {
    /* best-effort */
  }
  try {
    await pool.query(`DELETE FROM ping_results WHERE ts < $1`, [cutoff]);
  } catch {
    /* best-effort */
  }
}

// writeAudit appends an audit_log row. Best-effort: never throws — auditing
// must not break the request that triggered it.
export async function writeAudit(
  action: string,
  opts: { actor?: string; target?: string; details?: unknown } = {},
): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO audit_log (ts, actor, action, target, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        Date.now(),
        opts.actor ?? null,
        action,
        opts.target ?? null,
        opts.details === undefined ? null : JSON.stringify(opts.details),
      ],
    );
  } catch {
    /* best-effort */
  }
}
