import { NextRequest, NextResponse } from "next/server";
import { nodeTokenValid, tokenFromHeader } from "@/lib/auth";
import { savePingResults } from "@/lib/monitoring";
import type { PingResult } from "@/lib/types";

// Nodes POST latency results here (batch). Authenticated with NODE_TOKEN.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = tokenFromHeader(req.headers.get("authorization"));
  if (!(await nodeTokenValid(token)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { results?: PingResult[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const results = (body.results ?? []).filter(
    (r) => r && r.taskId && r.nodeId && typeof r.latencyMs === "number"
  );
  try {
    await savePingResults(results);
    return NextResponse.json({ ok: true, stored: results.length });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
