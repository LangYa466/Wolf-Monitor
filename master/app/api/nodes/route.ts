import { NextResponse } from "next/server";
import { isPublicDashboard, listNodes, publicNodes } from "@/lib/db";
import { currentUser } from "@/lib/session";

// Polled by the dashboard for live updates.
// Signed-in admins get the full payload; if the public dashboard is enabled,
// guests get a sanitized payload (IP stripped); otherwise 401.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await currentUser();
    const isPublic = user ? false : await isPublicDashboard();
    if (!user && !isPublic) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const nodes = await listNodes();
    return NextResponse.json(
      {
        nodes: user ? nodes : publicNodes(nodes),
        serverTime: Date.now(),
        public: !user,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("listNodes failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
