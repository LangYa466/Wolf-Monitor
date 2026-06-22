import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  createUserExclusive,
  ensureNodeToken,
} from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { isSecureRequest, validateCredentials } from "@/lib/authutil";

// First-run setup: creates the first admin account. Refuses once one exists.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const { email, password } = await req.json();
    const invalid = validateCredentials(email, password);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    // Atomic check-and-insert: only one concurrent setup can win the advisory
    // lock + zero-user check; the rest get 403.
    const user = await createUserExclusive(email, password);
    if (!user) {
      return NextResponse.json({ error: "setup already completed" }, { status: 403 });
    }
    await ensureNodeToken();
    const { token, expires } = await createSession(user.id);

    const res = NextResponse.json({ ok: true, email: user.email });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: "lax",
      path: "/",
      expires,
    });
    return res;
  } catch (err) {
    console.error("setup failed:", err);
    return NextResponse.json({ error: "setup failed" }, { status: 500 });
  }
}
