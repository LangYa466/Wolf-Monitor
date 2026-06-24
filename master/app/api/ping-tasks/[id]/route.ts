import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { deletePingTask } from "@/lib/monitoring";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await deletePingTask(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("deletePingTask failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
