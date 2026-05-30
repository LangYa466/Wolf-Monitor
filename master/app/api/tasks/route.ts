import { NextRequest, NextResponse } from "next/server";
import { nodeTokenValid, tokenFromHeader } from "@/lib/auth";
import { pingTasksForNode } from "@/lib/monitoring";

// Nodes poll this to learn which latency probes they should run. Authenticated
// with the shared NODE_TOKEN; the node identifies itself via ?host=<hostname>.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Token only from the Authorization header — never the query string (URLs end
  // up in access/proxy logs).
  const token = tokenFromHeader(req.headers.get("authorization"));
  if (!(await nodeTokenValid(token)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const host = req.nextUrl.searchParams.get("host") ?? "";
  if (!host) return NextResponse.json({ tasks: [] });

  try {
    const tasks = await pingTasksForNode(host);
    return NextResponse.json(
      { tasks },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
