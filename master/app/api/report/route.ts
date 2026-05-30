import { NextRequest, NextResponse } from "next/server";
import { getNodeNet, saveReport } from "@/lib/db";
import { nodeTokenValid, tokenFromHeader } from "@/lib/auth";
import { clientIp } from "@/lib/net";
import { resolveCountry, shouldResolve } from "@/lib/geo";
import type { Report } from "@/lib/types";

// HTTP ingestion endpoint used by nodes running with `transport: http`
// (the Vercel-friendly path). Force the Node.js runtime since `pg` needs it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Report;
  try {
    body = (await req.json()) as Report;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const headerToken = tokenFromHeader(req.headers.get("authorization"));
  const token = headerToken ?? body?.token ?? null;
  if (!(await nodeTokenValid(token))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!body?.host?.hostname || !body?.metrics) {
    return NextResponse.json({ error: "malformed report" }, { status: 400 });
  }

  try {
    // CDN-aware client IP; resolve country once per node (or when IP changes).
    const ip = clientIp(req.headers);
    const existing = await getNodeNet(body.host.hostname);
    let country: string | null | undefined;
    if (shouldResolve(ip, existing?.ip ?? null, existing?.country ?? null)) {
      country = await resolveCountry(ip);
    }
    const node = await saveReport(body, { ip, country });
    return NextResponse.json({ ok: true, id: node.id });
  } catch (err) {
    console.error("saveReport failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
