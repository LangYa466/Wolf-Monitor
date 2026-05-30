import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  findUser,
  isRateLimited,
  recordAttempt,
  verifyPassword,
} from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { clientIp } from "@/lib/net";
import { isSecureRequest } from "@/lib/authutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const { email, password } = await req.json();
    const ip = clientIp(req.headers) ?? "unknown";

    if (typeof email !== "string" || typeof password !== "string") {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }

    if (await isRateLimited(ip, email)) {
      return NextResponse.json(
        { error: "too many attempts, try again later" },
        { status: 429 }
      );
    }

    const user = await findUser(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    await recordAttempt(ip, email, ok);

    if (!ok || !user) {
      return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
    }

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
    console.error("login failed:", err);
    return NextResponse.json({ error: "login failed" }, { status: 500 });
  }
}
