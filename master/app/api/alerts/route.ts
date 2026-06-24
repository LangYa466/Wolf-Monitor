import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { listAlertRules, upsertAlertRule } from "@/lib/monitoring";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ rules: await listAlertRules() });
  } catch (err) {
    logError("listAlertRules failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const rule = await upsertAlertRule(await req.json());
    return NextResponse.json({ rule });
  } catch (err) {
    logError("upsertAlertRule failed:", err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
