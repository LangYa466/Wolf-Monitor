import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { setNodeName } from "@/lib/db";

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
    console.error("rename failed:", err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
