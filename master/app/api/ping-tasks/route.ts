import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { listPingTasks, upsertPingTask } from "@/lib/monitoring";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ tasks: await listPingTasks() });
  } catch (err) {
    logError("listPingTasks failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const task = await upsertPingTask(await req.json());
    return NextResponse.json({ task });
  } catch (err) {
    logError("upsertPingTask failed:", err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
