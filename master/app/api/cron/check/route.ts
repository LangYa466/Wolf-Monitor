import { NextRequest, NextResponse } from "next/server";
import { cronValid, pruneAuthAttempts } from "@/lib/auth";
import { evaluate } from "@/lib/monitoring";
import { pruneHistory } from "@/lib/db";

// Evaluation tick: checks load-alert rules and offline status, dispatches
// notifications on state transitions. Triggered by the self-host server loop
// or any external pinger.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function run() {
  const summary = await evaluate();
  // Opportunistic retention cleanup.
  await pruneHistory();
  await pruneAuthAttempts();
  return summary;
}

export async function GET(req: NextRequest) {
  if (!cronValid(req.headers.get("authorization")))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await run()) });
  } catch (err) {
    console.error("cron evaluate failed:", err);
    return NextResponse.json({ error: "evaluate error" }, { status: 500 });
  }
}

// Allow POST too (some external cron services only POST).
export const POST = GET;
