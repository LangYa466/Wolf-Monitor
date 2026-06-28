import { NextRequest, NextResponse } from "next/server";
import { nodeForToken, tokenFromHeader } from "@/lib/auth";
import { pingTasksForNode } from "@/lib/monitoring";
import { getSetting } from "@/lib/db";
import { logError } from "@/lib/log";

// Nodes poll this to learn which latency probes they should run. Identity
// is derived from the token (which carries a server-assigned slug for new
// nodes, or the bound hostname for legacy nodes). The ?host= query param
// is accepted for back-compat but ignored — what the agent self-reports
// has never been trusted for identity and now isn't consulted at all.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Token only from the Authorization header — never the query string (URLs end
  // up in access/proxy logs).
  const token = tokenFromHeader(req.headers.get("authorization"));
  const nodeId = await nodeForToken(token);
  if (!nodeId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const [tasks, desiredAgentVersion] = await Promise.all([
      pingTasksForNode(nodeId),
      getSetting<string>("desiredAgentVersion").catch(() => null),
    ]);
    // Echo nodeId so future agent builds can learn their server-assigned
    // identity without an extra round trip. Existing agents ignore the
    // field.
    const body: {
      tasks: typeof tasks;
      desiredAgentVersion?: string;
      nodeId: string;
    } = { tasks, nodeId };
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
