import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { latencyHistoryForNode, pingTasksForNode } from "@/lib/monitoring";
import { logError } from "@/lib/log";

// Per-node latency time-series, grouped by task. Admin-only (mirrors
// /api/ping-results — exposes monitor targets / topology).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Number(sp.get("limit") ?? 240) || 240, 2000);
  // Clamp window to pruneHistory retention (30d) so admins can't ask the
  // planner for nonsense values like window=9999999999.
  const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const rawWindow = Math.max(Number(sp.get("window") ?? 0) || 0, 0);
  const windowMs = Math.min(rawWindow || MAX_WINDOW_MS, MAX_WINDOW_MS);
  const sinceMs = Date.now() - windowMs;

  try {
    const nodeId = decodeURIComponent(id);
    // Both filters must agree with what the node is CURRENTLY assigned to —
    // orphan rows from a previous assignment shouldn't surface here.
    const [byTask, tasks] = await Promise.all([
      latencyHistoryForNode(nodeId, sinceMs, limit),
      pingTasksForNode(nodeId),
    ]);
    return NextResponse.json(
      { tasks, byTask },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    logError("latencyHistoryForNode failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
