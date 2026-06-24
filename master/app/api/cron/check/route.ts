import { NextRequest, NextResponse } from "next/server";
import { cronValid, pruneAuthAttempts } from "@/lib/auth";
import { evaluate } from "@/lib/monitoring";
import { pruneHistory } from "@/lib/db";
import { logError } from "@/lib/log";

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

async function handle(req: NextRequest) {
  // Defeat <img>/<script>-style cross-site CSRF triggers even if CRON_SECRET
  // is unset. Real cron callers (curl, Vercel Cron, our self-host loop) don't
  // send Sec-Fetch-Site; browsers attach "cross-site" automatically.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none")
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!cronValid(req.headers.get("authorization")))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await run()) });
  } catch (err) {
    logError("cron evaluate failed:", err);
    return NextResponse.json({ error: "evaluate error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

// Allow POST too (some external cron services only POST).
export async function POST(req: NextRequest) {
  return handle(req);
}
