import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { latencyHistoryForNode, listPingTasks } from "@/lib/monitoring";

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
  const windowMs = Math.max(Number(sp.get("window") ?? 0) || 0, 0);
  const sinceMs = windowMs > 0 ? Date.now() - windowMs : undefined;

  try {
    const [byTask, tasks] = await Promise.all([
      latencyHistoryForNode(decodeURIComponent(id), sinceMs, limit),
      listPingTasks(),
    ]);
    return NextResponse.json(
      { tasks, byTask },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("latencyHistoryForNode failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
