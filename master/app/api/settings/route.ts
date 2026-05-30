import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { ensureNodeToken } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/db";
import { randomBytes } from "crypto";

// General settings: the node ingestion token (to paste into install commands)
// and the optional ipinfo.io token. Admin only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const nodeToken = await ensureNodeToken();
    const ipinfoToken = (await getSetting<string>("ipinfoToken")) ?? "";
    return NextResponse.json({ nodeToken, ipinfoToken });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (typeof body.ipinfoToken === "string") {
      await setSetting("ipinfoToken", body.ipinfoToken.trim());
    }
    if (body.rotateNodeToken === true) {
      await setSetting("nodeToken", randomBytes(18).toString("base64url"));
    }
    const nodeToken = await ensureNodeToken();
    const ipinfoToken = (await getSetting<string>("ipinfoToken")) ?? "";
    return NextResponse.json({ nodeToken, ipinfoToken });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
