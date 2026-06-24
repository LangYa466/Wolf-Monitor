import { NextRequest, NextResponse } from "next/server";
import { isPublicDashboard, listNodes, publicNodes } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { clientIp } from "@/lib/net";
import { retryAfterSec, takeToken } from "@/lib/ratelimit";
import { logError } from "@/lib/log";

// Polled by the dashboard for live updates.
// Signed-in admins get the full payload; if the public dashboard is enabled,
// guests get a sanitized payload (IP stripped); otherwise 401.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guest fan-out cap — shield the 1-connection pg pool from anonymous polling
// floods. Admins are exempt (their session already gates abuse).
const GUEST_RL_CAPACITY = 30;
const GUEST_RL_REFILL_PER_SEC = 0.5;

export async function GET(req: NextRequest) {
  try {
    const user = await currentUser();
    const isPublic = user ? false : await isPublicDashboard();
    if (!user && !isPublic) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!user) {
      const ip = clientIp(req.headers) ?? "unknown";
      if (!takeToken(`ip-guest:${ip}`, GUEST_RL_CAPACITY, GUEST_RL_REFILL_PER_SEC)) {
        const retry = retryAfterSec(GUEST_RL_REFILL_PER_SEC);
        return NextResponse.json(
          { error: "rate limited" },
          { status: 429, headers: { "Retry-After": String(retry) } },
        );
      }
    }
    const nodes = await listNodes();
    return NextResponse.json(
      {
        nodes: user ? nodes : publicNodes(nodes),
        serverTime: Date.now(),
        public: !user,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    logError("listNodes failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
