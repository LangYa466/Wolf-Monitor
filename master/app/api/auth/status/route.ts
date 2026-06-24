import { NextResponse } from "next/server";
import { userCount } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { logError } from "@/lib/log";

// Tells the client whether setup is needed and whether the visitor is signed in.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Once setup is done it never reverts; memoize to avoid leaking a race-window
// signal to unauth pollers and to skip the DB lookup on the hot path.
let setupDoneMemo = false;

export async function GET() {
  try {
    await ensureSchema();
    const user = await currentUser();
    if (!setupDoneMemo) {
      const count = await userCount();
      if (count > 0) setupDoneMemo = true;
    }
    return NextResponse.json({
      setupDone: setupDoneMemo,
      authenticated: Boolean(user),
      email: user?.email ?? null,
    });
  } catch (err) {
    logError("auth/status failed:", err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
