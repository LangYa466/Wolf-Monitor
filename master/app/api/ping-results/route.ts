import { NextResponse } from "next/server";
import { latestPingResults, listPingTasks } from "@/lib/monitoring";
import { currentUser } from "@/lib/session";
import { logError } from "@/lib/log";

// Latency feed: tasks + latest result per (task, node). Admin-only — it exposes
// monitor targets / intervals / node assignments (infra topology).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const [tasks, results] = await Promise.all([
      listPingTasks(),
      latestPingResults(),
    ]);
    return NextResponse.json(
      { tasks, results },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    logError("latestPingResults failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
