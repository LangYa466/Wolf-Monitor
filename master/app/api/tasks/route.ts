import { NextRequest, NextResponse } from "next/server";
import { authorizeForHost, tokenFromHeader } from "@/lib/auth";
import { pingTasksForNode } from "@/lib/monitoring";
import { getSetting } from "@/lib/db";
import { logError } from "@/lib/log";

// Nodes poll this to learn which latency probes they should run. The token
// must be bound to the requesting host (?host=<hostname>) — per-node tokens
// don't accept cross-host requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Token only from the Authorization header — never the query string (URLs end
  // up in access/proxy logs).
  const token = tokenFromHeader(req.headers.get("authorization"));
  const host = req.nextUrl.searchParams.get("host") ?? "";
  if (!host) return NextResponse.json({ tasks: [] });
  if (!(await authorizeForHost(token, host)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [tasks, desiredAgentVersion] = await Promise.all([
      pingTasksForNode(host),
      getSetting<string>("desiredAgentVersion").catch(() => null),
    ]);
    // Only echo the version directive when admin has explicitly set one. An
    // empty/missing field tells the node binary "stay on whatever you've got".
    const body: { tasks: typeof tasks; desiredAgentVersion?: string } = { tasks };
    if (desiredAgentVersion && desiredAgentVersion.length > 0) {
      body.desiredAgentVersion = desiredAgentVersion;
    }
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    logError("pingTasksForNode failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
