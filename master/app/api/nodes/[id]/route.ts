import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { deleteNode, setNodeName } from "@/lib/db";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/nodes/:id — rename a node (admin only). `id` is the internal
// hostname id. Body: { name: string }.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const body = await req.json();
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    await setNodeName(decodeURIComponent(id), body.name.slice(0, 64));
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("rename failed:", err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}

// DELETE /api/nodes/:id — remove a node and cascade-clean every row that
// references it (history, alerts state, offline settings, ping results,
// per-node admission token, and the id's presence in alert_rules.targets /
// ping_tasks.node_ids). Admin only.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    await deleteNode(decodeURIComponent(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("delete node failed:", err);
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
