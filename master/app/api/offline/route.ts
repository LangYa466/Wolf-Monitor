import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { listOfflineSettings, upsertOfflineSetting } from "@/lib/monitoring";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ settings: await listOfflineSettings() });
  } catch (err) {
    logError("listOfflineSettings failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { nodeId, enabled, graceSeconds } = await req.json();
    if (!nodeId) return NextResponse.json({ error: "nodeId required" }, { status: 400 });
    await upsertOfflineSetting(nodeId, Boolean(enabled), Number(graceSeconds ?? 180));
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("upsertOfflineSetting failed:", err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
