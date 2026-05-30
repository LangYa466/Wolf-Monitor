import { NextResponse } from "next/server";
import { userCount } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { currentUser } from "@/lib/session";

// Tells the client whether setup is needed and whether the visitor is signed in.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    const [count, user] = await Promise.all([userCount(), currentUser()]);
    return NextResponse.json({
      setupDone: count > 0,
      authenticated: Boolean(user),
      email: user?.email ?? null,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}
