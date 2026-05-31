import { NextRequest, NextResponse } from "next/server";
import { getHistory, isPublicDashboard } from "@/lib/db";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Same gating as /api/nodes: signed-in admins always; guests only when the
  // dashboard is public. History is non-sensitive (no IP), so guests may read it.
  const user = await currentUser();
  if (!user && !(await isPublicDashboard())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Number(sp.get("limit") ?? 240) || 240, 2000);
  const windowMs = Math.max(Number(sp.get("window") ?? 0) || 0, 0);
  const sinceMs = windowMs > 0 ? Date.now() - windowMs : undefined;

  try {
    const points = await getHistory(id, limit, sinceMs);
    return NextResponse.json(
      { points },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("getHistory failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
