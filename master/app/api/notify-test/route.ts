import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { defaultNotifyConfig, loadConfig, sendTest } from "@/lib/notify";
import type { NotifyConfig } from "@/lib/types";

// Sends a test notification. Uses the posted (unsaved) config when provided, so
// users can verify before saving; otherwise falls back to the stored config.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    let cfg: NotifyConfig;
    const body = await req.json().catch(() => null);
    if (body && body.telegram) {
      const base = defaultNotifyConfig();
      cfg = { ...base, ...body, telegram: { ...base.telegram, ...body.telegram } };
    } else {
      cfg = await loadConfig();
    }
    const result = await sendTest(cfg);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: "test failed" }, { status: 500 });
  }
}
