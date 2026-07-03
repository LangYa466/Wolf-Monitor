import { NextRequest, NextResponse } from "next/server";
import { getHistory, isPublicDashboard } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { clientIp } from "@/lib/net";
import { retryAfterSec, takeToken } from "@/lib/ratelimit";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guest fan-out cap — mirror /api/nodes so anonymous callers can't pin the
// 1-connection pg pool with parallel history requests.
const GUEST_RL_CAPACITY = 30;
const GUEST_RL_REFILL_PER_SEC = 0.5;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Same gating as /api/nodes: signed-in admins always; guests only when the
  // dashboard is public. History is non-sensitive (no IP), so guests may read it.
  const user = await currentUser();
  if (!user && !(await isPublicDashboard())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!user) {
    // Guests must address nodes by their opaque (encrypted) id. Accepting the
    // raw hostname here would turn this endpoint into a hostname-existence
    // oracle: guess a hostname, get history back ⇒ it exists. Admins still
    // pass the hostname directly from the dashboard.
    if (!/^\d{1,10}$/.test(id)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const ip = clientIp(req.headers) ?? "unknown";
    if (!takeToken(`ip-guest:${ip}`, GUEST_RL_CAPACITY, GUEST_RL_REFILL_PER_SEC)) {
      const retry = retryAfterSec(GUEST_RL_REFILL_PER_SEC);
      return NextResponse.json(
        { error: "rate limited" },
        { status: 429, headers: { "Retry-After": String(retry) } },
      );
    }
  }

  const sp = req.nextUrl.searchParams;
  const isGuest = !user;
  const limit = Math.min(
    Number(sp.get("limit") ?? 240) || 240,
    isGuest ? 240 : 2000
  );
  // Clamp window to pruneHistory retention (30d) so guests/admins can't ask
  // the planner for nonsense values. Guests are additionally capped to 24h —
  // reject (not silently clamp) anything bigger so the front-end lock and the
  // back-end gate agree, and so a probe hitting the API directly with
  // ?window=7d doesn't quietly receive 1d back as if the request succeeded.
  const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const GUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
  const rawWindow = Math.max(Number(sp.get("window") ?? 0) || 0, 0);
  if (isGuest && rawWindow > GUEST_WINDOW_MS) {
    return NextResponse.json(
      { error: "guest window exceeds limit", maxWindowMs: GUEST_WINDOW_MS },
      { status: 403 },
    );
  }
  const windowMs = Math.min(
    rawWindow || (isGuest ? GUEST_WINDOW_MS : MAX_WINDOW_MS),
    isGuest ? GUEST_WINDOW_MS : MAX_WINDOW_MS,
  );
  const sinceMs = Date.now() - windowMs;

  try {
    const points = await getHistory(id, limit, sinceMs);
    // Same admin-only gate as ip / hostname in publicNodes: strip cpuTemp so
    // guests can't reconstruct the thermal timeline (leaks workload and
    // bare-metal-vs-cloud state).
    const safe = isGuest ? points.map((p) => ({ ...p, cpuTemp: 0 })) : points;
    return NextResponse.json(
      { points: safe },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    logError("getHistory failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
