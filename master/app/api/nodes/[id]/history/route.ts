import { NextRequest, NextResponse } from "next/server";
import { getHistory } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const limit = Math.min(
    Number(req.nextUrl.searchParams.get("limit") ?? 120) || 120,
    600
  );
  try {
    const points = await getHistory(id, limit);
    return NextResponse.json(
      { points },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("getHistory failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
