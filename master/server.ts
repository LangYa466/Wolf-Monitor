// Custom Next.js server that adds a WebSocket endpoint for nodes running with
// `transport: ws`. Use this when self-hosting (`pnpm dev:ws` / `start:ws`).
//
// Deployments that can't proxy WebSockets (serverless platforms, certain
// reverse proxies) should run nodes with `transport: http` -> /api/report
// instead — the websocket path requires a process that can hold long-lived
// connections.

import { createServer, type IncomingMessage } from "http";
import type { Duplex } from "stream";
import { parse } from "url";
import { timingSafeEqual } from "crypto";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { Pool, type PoolConfig } from "pg";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "8080", 10);

const WS_PATH = "/api/ws/node";

// Hard caps so an unauth caller can't exhaust the master via raw WS upgrades.
const WS_MAX_PAYLOAD = parseInt(process.env.WOLF_WS_MAX_PAYLOAD || "65536", 10); // 64 KiB / frame
const WS_MAX_CONN_PER_IP = parseInt(process.env.WOLF_WS_MAX_PER_IP || "8", 10);
const WS_MAX_CONN_TOTAL = parseInt(process.env.WOLF_WS_MAX_TOTAL || "2000", 10);
const WS_HEARTBEAT_MS = parseInt(process.env.WOLF_WS_HEARTBEAT_MS || "30000", 10);
const WS_HANDSHAKE_RATE_PER_MIN = parseInt(process.env.WOLF_WS_HANDSHAKE_RPM || "120", 10);
// Optional Origin allowlist (comma-separated). When unset, browser-style Origin
// headers are rejected outright — node clients don't send Origin.
const WS_ALLOWED_ORIGINS = (process.env.WOLF_WS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Real client IP for the websocket connection (honours an upstream proxy/CDN
// in front of the self-host server), forwarded so the report route can geo-locate.
function connIp(request: IncomingMessage): string {
  const xff = request.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const cf = request.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  return request.socket?.remoteAddress || "";
}

// Live connection bookkeeping + per-IP handshake rate window.
const wsConnPerIp = new Map<string, number>();
let wsConnTotal = 0;
const wsHandshakeWindow = new Map<string, number[]>();
function handshakeAllowed(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const arr = (wsHandshakeWindow.get(ip) || []).filter((t) => t >= cutoff);
  if (arr.length >= WS_HANDSHAKE_RATE_PER_MIN) {
    wsHandshakeWindow.set(ip, arr);
    return false;
  }
  arr.push(now);
  wsHandshakeWindow.set(ip, arr);
  return true;
}
function denyUpgrade(socket: Duplex, code: number, reason: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {}
  socket.destroy();
}

// Standalone pool just for the WS upgrade token check. Tiny (max=1) — used
// only during handshakes, not in the request path. Same DATABASE_URL/SSL as
// lib/db.ts. We can't import the Next.js TS module from this entrypoint
// directly without dragging in a whole Next compile graph at boot.
let wsAuthPool: Pool | null = null;
function wsAuthPoolGet(): Pool | null {
  if (wsAuthPool) return wsAuthPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  let ssl: PoolConfig["ssl"];
  if (process.env.PGSSL === "disable" || /sslmode=disable/.test(connectionString)) {
    ssl = undefined;
  } else if (process.env.PGSSL === "no-verify") {
    ssl = { rejectUnauthorized: false };
  } else {
    const caRaw = process.env.PG_CA_CERT;
    const ca = caRaw
      ? caRaw.includes("BEGIN CERTIFICATE")
        ? caRaw
        : Buffer.from(caRaw, "base64").toString("utf8")
      : undefined;
    ssl = { rejectUnauthorized: true, ca };
  }
  wsAuthPool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl,
  });
  wsAuthPool.on("error", (err) => console.error("[ws-auth] pool error:", err.message));
  return wsAuthPool;
}

// Small TTL cache so a node reconnecting in a loop doesn't pound the DB.
const tokenCache = new Map<string, { ok: boolean; expires: number }>();
const TOKEN_CACHE_TTL_MS = 60_000;

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// DB-backed token check at upgrade. Accepts any token present in node_tokens
// (bound or unbound — a fresh node binds via /api/report's first frame) OR the
// legacy shared token. Returns false on any failure — never throws — so an
// upgrade attempt can never crash the server.
async function tokenAuthorizedAtUpgrade(token: string | null): Promise<boolean> {
  if (!token) return false;
  const cached = tokenCache.get(token);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.ok;
  const pool = wsAuthPoolGet();
  if (!pool) return false;
  let ok = false;
  try {
    const { rows } = await pool.query<{ "?column?": number }>(
      `SELECT 1 FROM node_tokens WHERE token = $1 LIMIT 1`,
      [token],
    );
    if (rows.length) {
      ok = true;
    } else {
      const { rows: legacy } = await pool.query<{ value: unknown }>(
        `SELECT value FROM app_settings WHERE key = 'nodeToken'`,
      );
      if (legacy.length) {
        // app_settings.value is JSONB; pg returns the parsed value.
        const expected = typeof legacy[0].value === "string" ? legacy[0].value : null;
        if (expected) ok = safeEqualStr(token, expected);
      }
    }
  } catch (err) {
    console.error("[ws-auth] db lookup failed:", (err as Error).message);
    ok = false;
  }
  tokenCache.set(token, { ok, expires: now + TOKEN_CACHE_TTL_MS });
  // Bound cache size so a flood of bad tokens can't grow the map unboundedly.
  if (tokenCache.size > 4096) {
    const cutoff = now;
    for (const [k, v] of tokenCache) if (v.expires <= cutoff) tokenCache.delete(k);
    if (tokenCache.size > 4096) tokenCache.clear();
  }
  return ok;
}

interface NodeReport {
  token?: string;
  host?: { hostname?: string };
  metrics?: unknown;
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url || "/", true));
  });

  // Persist a report by forwarding to the existing /api/report route so all
  // storage + token validation logic lives in one place (lib/db.ts, lib/auth.ts).
  async function persist(report: NodeReport, ip: string): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${report.token || ""}`,
    };
    if (ip) headers["x-real-ip"] = ip;
    const res = await fetch(`http://127.0.0.1:${port}/api/report`, {
      method: "POST",
      headers,
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      throw new Error(`report route ${res.status}`);
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
  });

  // Per-connection: heartbeat + payload cap already set on the server. Each
  // frame's `token` is still authoritative — /api/report validates it against
  // node_tokens. The upgrade-time Bearer check just stops anonymous flooders.
  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const ip = connIp(request);
    wsConnTotal++;
    wsConnPerIp.set(ip, (wsConnPerIp.get(ip) || 0) + 1);

    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const hb = setInterval(() => {
      if (!alive) {
        try { ws.terminate(); } catch {}
        return;
      }
      alive = false;
      try { ws.ping(); } catch {}
    }, WS_HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(hb);
      wsConnTotal--;
      const n = (wsConnPerIp.get(ip) || 1) - 1;
      if (n <= 0) wsConnPerIp.delete(ip);
      else wsConnPerIp.set(ip, n);
    };

    ws.on("message", async (data) => {
      let report: NodeReport;
      try {
        report = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frames
      }
      if (!report?.host?.hostname || !report?.metrics) return;
      try {
        await persist(report, ip);
      } catch (err) {
        console.error("[ws] persist failed:", (err as Error).message);
      }
    });

    ws.on("close", cleanup);
    ws.on("error", () => {});
  });

  server.on("upgrade", async (request, socket, head) => {
    const { pathname } = parse(request.url || "/", true);
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const ip = connIp(request);

    if (wsConnTotal >= WS_MAX_CONN_TOTAL) {
      return denyUpgrade(socket, 503, "Service Unavailable");
    }
    if ((wsConnPerIp.get(ip) || 0) >= WS_MAX_CONN_PER_IP) {
      return denyUpgrade(socket, 429, "Too Many Connections");
    }
    if (!handshakeAllowed(ip)) {
      return denyUpgrade(socket, 429, "Too Many Requests");
    }

    // Reject browser-style Origin unless the operator allowlisted it.
    const origin = request.headers.origin;
    if (origin) {
      if (WS_ALLOWED_ORIGINS.length === 0 || !WS_ALLOWED_ORIGINS.includes(origin)) {
        return denyUpgrade(socket, 403, "Forbidden");
      }
    }

    // Real DB-backed token validation BEFORE handleUpgrade. Accept either
    // Authorization: Bearer <token> (preferred) or ?token=<token> for
    // backwards-compat with the existing node client (which sets both). The
    // result is cached for 60s to absorb reconnect storms without DoSing pg.
    const auth = request.headers.authorization || "";
    const m = /^Bearer\s+([A-Za-z0-9\-_.=]{8,256})$/.exec(auth.trim());
    let token: string | null = m ? m[1] : null;
    if (!token) {
      const q = parse(request.url || "/", true).query;
      const qt = q?.token;
      if (typeof qt === "string" && /^[A-Za-z0-9\-_.=]{8,256}$/.test(qt)) {
        token = qt;
      }
    }
    if (!token) {
      return denyUpgrade(socket, 401, "Unauthorized");
    }
    let authorized: boolean;
    try {
      authorized = await tokenAuthorizedAtUpgrade(token);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return denyUpgrade(socket, 401, "Unauthorized");
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Self-host evaluation loop: drive /api/cron/check so load + offline alerts
  // fire without an external scheduler.
  const EVAL_INTERVAL_MS = parseInt(process.env.EVAL_INTERVAL_MS || "30000", 10);
  const cronSecret = process.env.CRON_SECRET || "";
  if (!cronSecret) {
    console.warn(
      "[wolf] WARNING: CRON_SECRET not set — /api/cron/check is unauthenticated. " +
        "Set CRON_SECRET to require Authorization: Bearer <secret>.",
    );
  }
  async function tick(): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${port}/api/cron/check`, {
        headers: cronSecret ? { authorization: `Bearer ${cronSecret}` } : {},
      });
    } catch (err) {
      console.error("[eval] tick failed:", (err as Error).message);
    }
  }
  setInterval(tick, EVAL_INTERVAL_MS);

  server.listen(port, hostname, () => {
    console.log(`> Wolf-Monitor master ready on http://${hostname}:${port}`);
    console.log(`> node websocket endpoint: ws://${hostname}:${port}${WS_PATH}`);
    console.log(`> evaluation loop every ${EVAL_INTERVAL_MS / 1000}s`);
  });
});
