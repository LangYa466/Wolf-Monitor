import { NextRequest, NextResponse } from "next/server";
import { nodeForToken, tokenFromHeader } from "@/lib/auth";
import { savePingResults } from "@/lib/monitoring";
import { clientIp } from "@/lib/net";
import { takeToken, retryAfterSec } from "@/lib/ratelimit";
import { logError } from "@/lib/log";
import type { PingResult } from "@/lib/types";

const RL_CAPACITY = 30;
const RL_REFILL = 15;

// Nodes POST latency results here (batch). Token MUST be bound to a node — the
// bound hostname is enforced on every row so a compromised node can't forge
// results for any other node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rlIp = clientIp(req.headers) ?? "unknown";
  if (!takeToken(`ip:${rlIp}`, RL_CAPACITY, RL_REFILL)) {
    return NextResponse.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec(RL_REFILL)) } },
    );
  }

  const token = tokenFromHeader(req.headers.get("authorization"));
  const boundHost = await nodeForToken(token);
  if (!boundHost) {
    // Rejects: missing token, unknown token, unbound token, and the legacy
    // shared token (no node binding → can't trust the per-row nodeId).
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { results?: PingResult[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  // Bounds: latency in [-1, 60000] (-1 = unreachable sentinel; 60s caps absurd
  // values that would break chart y-axes). Reject NaN/Infinity via isFinite.
  // The agent's self-reported nodeId is overwritten with boundHost so a
  // pre-v1.6.1 agent (which sends its OS hostname) still has results stored
  // under the server-assigned slug. Cross-node spoofing is still blocked —
  // every row in a batch is clamped to the one identity the token authorizes.
  const results = (body.results ?? [])
    .filter(
      (r) =>
        r &&
        typeof r.taskId === "string" &&
        r.taskId.length > 0 &&
        r.taskId.length <= 128 &&
        typeof r.ts === "number" &&
        Number.isFinite(r.ts) &&
        r.ts > 0 &&
        typeof r.success === "boolean" &&
        typeof r.latencyMs === "number" &&
        Number.isFinite(r.latencyMs) &&
        r.latencyMs >= -1 &&
        r.latencyMs <= 60_000,
    )
    .map((r) => ({ ...r, nodeId: boundHost }));
  try {
    await savePingResults(results);
    return NextResponse.json({ ok: true, stored: results.length });
  } catch (err) {
    logError("savePingResults failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
