import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { deleteNode, setNodeCountry, setNodeName } from "@/lib/db";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/nodes/:id — admin-only mutations on a node. `id` is the internal
// hostname id. Body fields (all optional, at least one required):
//   - name: string — display alias (empty string clears it)
//   - country: string | null — ISO 3166-1 alpha-2 flag override.
//       "" / null clears the override and lets ipinfo resolve it again.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const body = await req.json();
    const decoded = decodeURIComponent(id);
    let touched = false;
    if (typeof body.name === "string") {
      await setNodeName(decoded, body.name.slice(0, 64));
      touched = true;
    }
    if ("country" in body) {
      const raw = body.country;
      if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
        await setNodeCountry(decoded, null);
        touched = true;
      } else if (typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw.trim())) {
        await setNodeCountry(decoded, raw.trim());
        touched = true;
      } else {
        return NextResponse.json(
          { error: "country must be a 2-letter ISO code or empty" },
          { status: 400 },
        );
      }
    }
    if (!touched) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("node PATCH failed:", err);
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
