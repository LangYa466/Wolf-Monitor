import { NextResponse } from "next/server";
import { listNodes } from "@/lib/db";

// Polled by the dashboard for live updates (works on Vercel and self-host).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const nodes = await listNodes();
    return NextResponse.json(
      { nodes, serverTime: Date.now() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("listNodes failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
