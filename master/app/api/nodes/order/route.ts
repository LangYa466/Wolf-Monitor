import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { setNodeOrder } from "@/lib/db";
import { logError } from "@/lib/log";

// Persists a manual drag-reorder of nodes. Admin only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { order } = await req.json();
    if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) {
      return NextResponse.json({ error: "order must be string[]" }, { status: 400 });
    }
    await setNodeOrder(order);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("setNodeOrder failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
