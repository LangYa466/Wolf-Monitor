import { NextRequest, NextResponse, after } from "next/server";
import { getNodeNet, saveReport } from "@/lib/db";
import { authorizeReport, tokenFromHeader } from "@/lib/auth";
import { clientIp } from "@/lib/net";
import { resolveCountry, shouldResolve } from "@/lib/geo";
import { maybeEvaluate } from "@/lib/monitoring";
import { takeToken, retryAfterSec } from "@/lib/ratelimit";
import type { Report } from "@/lib/types";

const RL_CAPACITY = 60;
const RL_REFILL = 30;

// HTTP ingestion endpoint used by nodes running with `transport: http`
// (when the master sits behind a proxy that can't carry WebSockets).
// Force the Node.js runtime since `pg` needs it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap on POST body. Real reports are <2KB; reject anything that would
// let a node-token holder bloat the nodes.host jsonb column.
const MAX_BODY_BYTES = 32_000;

// Strip CR/LF/NUL/ANSI/control chars from values that flow into console.error,
// so a pg error message echoing node-controlled bytes can't forge log lines.
function safeErr(e: unknown, max = 500): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return msg.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, max);
}

function isStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isNonNegFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// Allowlist + bound the HostInfo shape so attacker-controlled keys / huge
// strings can't be persisted into the nodes.host jsonb column.
function sanitizeHost(h: any): Report["host"] | null {
  if (!h || typeof h !== "object") return null;
  if (!isStr(h.hostname, 253)) return null;
  const out: any = { hostname: h.hostname };
  const strFields: Array<[string, number]> = [
    ["os", 64], ["platform", 64], ["platformVersion", 64],
    ["arch", 32], ["cpuModel", 128], ["agentVersion", 64],
  ];
  for (const [k, max] of strFields) {
    if (h[k] === undefined || h[k] === null) continue;
    if (typeof h[k] !== "string" || h[k].length > max) return null;
    out[k] = h[k];
  }
  const numFields = [
    "cpuCores", "memTotal", "swapTotal", "diskTotal",
    "bootTime", "bootTimeMs", "uptimeSec",
  ];
  for (const k of numFields) {
    if (h[k] === undefined || h[k] === null) continue;
    if (!isNonNegFinite(h[k])) return null;
    out[k] = h[k];
  }
  return out;
}

// Validate + clamp metrics so a node can't poison alerts/charts with
// NaN/Infinity/negative/absurd values or push extra jsonb keys.
function sanitizeMetrics(m: any, host: any): Report["metrics"] | null {
  if (!m || typeof m !== "object") return null;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  const SAFE = Number.MAX_SAFE_INTEGER;
  const pctKeys = ["cpuUsage", "memPercent", "diskPercent"] as const;
  // Counters / gauges accepted with [0, SAFE] clamp. Includes cumulative
  // totals (uptime, netSent/Recv, diskUsed, diskReadBytes, diskWriteBytes)
  // and instantaneous values that were missing from the v1.5.6 allowlist —
  // their absence here was zeroing the dashboard's uptime/load/totals
  // columns even though the node binary reported them correctly.
  const cntKeys = [
    "netUpSpeed", "netDownSpeed", "diskReadSpeed", "diskWriteSpeed",
    "procs", "tcpConns", "memUsed", "swapUsed",
    "uptime", "netSent", "netRecv",
    "diskUsed", "diskReadBytes", "diskWriteBytes",
    "load1", "load5", "load15",
  ] as const;
  const out: any = {};
  for (const k of pctKeys) {
    if (!isNonNegFinite(m[k])) return null;
    out[k] = clamp(m[k], 0, 100);
  }
  for (const k of cntKeys) {
    if (m[k] === undefined || m[k] === null) { out[k] = 0; continue; }
    if (!isNonNegFinite(m[k])) return null;
    out[k] = clamp(m[k], 0, SAFE);
  }
  out.procs = Math.trunc(out.procs);
  out.tcpConns = Math.trunc(out.tcpConns);
  out.uptime = Math.trunc(out.uptime);
  if (isNonNegFinite(host?.memTotal)) out.memUsed = clamp(out.memUsed, 0, host.memTotal);
  if (isNonNegFinite(host?.swapTotal)) out.swapUsed = clamp(out.swapUsed, 0, host.swapTotal);
  if (isNonNegFinite(host?.diskTotal)) out.diskUsed = clamp(out.diskUsed, 0, host.diskTotal);
  return out;
}

export async function POST(req: NextRequest) {
  // Per-IP token bucket BEFORE auth so a token-guessing flood can't pin the DB.
  const rlIp = clientIp(req.headers) ?? "unknown";
  if (!takeToken(`ip:${rlIp}`, RL_CAPACITY, RL_REFILL)) {
    return NextResponse.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec(RL_REFILL)) } },
    );
  }

  // Reject oversized bodies up front. Require a Content-Length header so
  // chunked/streaming bodies can't bypass the cap.
  const lenHeader = req.headers.get("content-length");
  const len = lenHeader ? Number(lenHeader) : NaN;
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let body: Report;
  try {
    body = (await req.json()) as Report;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const headerToken = tokenFromHeader(req.headers.get("authorization"));
  const token = headerToken ?? body?.token ?? null;

  const host = sanitizeHost((body as any)?.host);
  const metrics = host ? sanitizeMetrics((body as any)?.metrics, host) : null;
  if (!host || !metrics) {
    return NextResponse.json({ error: "malformed report" }, { status: 400 });
  }
  body.host = host;
  body.metrics = metrics;
  // Authorization is hostname-bound: an unbound token binds on first call;
  // a token bound to a different host is rejected.
  if (!(await authorizeReport(token, body.host.hostname))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // CDN-aware client IP; resolve country once per node (or when IP changes).
    const ip = clientIp(req.headers);
    const existing = await getNodeNet(body.host.hostname);
    let country: string | null | undefined;
    // Admin-pinned country: never overwrite from ipinfo. saveReport's SQL also
    // guards this; we short-circuit here to avoid a wasted network round trip.
    if (
      !existing?.countryManual &&
      shouldResolve(ip, existing?.ip ?? null, existing?.country ?? null)
    ) {
      country = await resolveCountry(ip);
    }
    const node = await saveReport(body, { ip, country });
    // Drive alert/offline evaluation off node traffic (throttled), so alerts
    // work even when no external cron is configured. Runs after the response
    // via waitUntil, so it never delays the node.
    after(async () => {
      try {
        await maybeEvaluate();
      } catch (err) {
        console.error("maybeEvaluate failed:", safeErr(err));
      }
    });
    return NextResponse.json({ ok: true, id: node.id });
  } catch (err) {
    console.error("saveReport failed:", safeErr(err));
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
