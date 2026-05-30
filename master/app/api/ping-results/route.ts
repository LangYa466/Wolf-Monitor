import { NextResponse } from "next/server";
import { latestPingResults, listPingTasks } from "@/lib/monitoring";

// Dashboard latency feed: tasks + latest result per (task, node).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
