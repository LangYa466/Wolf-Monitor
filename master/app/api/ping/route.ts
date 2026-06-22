import { NextRequest, NextResponse } from "next/server";
import { nodeForToken, tokenFromHeader } from "@/lib/auth";
import { savePingResults } from "@/lib/monitoring";
import type { PingResult } from "@/lib/types";

// Nodes POST latency results here (batch). Token MUST be bound to a node — the
// bound hostname is enforced on every row so a compromised node can't forge
// results for any other node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = tokenFromHeader(req.headers.get("authorization"));
  const boundHost = await nodeForToken(token);
  if (!boundHost) {
    // Rejects: missing token, unknown token, unbound token, and the legacy
    // shared token (no node binding → can't trust the per-row nodeId).
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { results?: PingResult[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const results = (body.results ?? []).filter(
    (r) =>
      r &&
      r.taskId &&
      r.nodeId === boundHost &&
      typeof r.latencyMs === "number",
  );
  try {
    await savePingResults(results);
    return NextResponse.json({ ok: true, stored: results.length });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
