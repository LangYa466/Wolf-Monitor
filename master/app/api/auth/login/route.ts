import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  findUser,
  isRateLimited,
  recordAttempt,
  sessionCookieName,
  verifyUserPassword,
} from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { clientIp } from "@/lib/net";
import { isSecureRequest } from "@/lib/authutil";
import { verifyTurnstile } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Strip CR/LF/NUL/control chars + cap length so a pg error echoing
// connection bytes (DSN, host:port) can't leak via container logs or
// forge log lines. Matches the safeErr pattern in app/api/report/route.ts.
function safeErr(e: unknown, max = 200): string {
  const msg = e instanceof Error ? `${e.name}` : "error";
  return msg.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, max);
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    // Reject oversized bodies before buffering — bounds scrypt input and JSON parse.
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 4 * 1024) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    const { email, password, turnstileToken } = await req.json();
    const ip = clientIp(req.headers) ?? "unknown";

    if (typeof email !== "string" || typeof password !== "string") {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    // Length caps: same 401 as wrong-password to avoid leaking a new oracle.
    if (email.length > 254 || password.length > 256) {
      return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
    }

    // Turnstile before rate-limit + password so a failed captcha never spends
    // a rate slot or touches the user row (no oracle for account existence).
    // No-op when TURNSTILE_SECRET_KEY is unset.
    const captcha = await verifyTurnstile(turnstileToken, ip === "unknown" ? null : ip);
    if (!captcha.ok) {
      return NextResponse.json({ error: captcha.error ?? "captcha failed" }, { status: 400 });
    }

    if (await isRateLimited(ip, email)) {
      return NextResponse.json(
        { error: "too many attempts, try again later" },
        { status: 429 }
      );
    }

    const user = await findUser(email);
    const ok = await verifyUserPassword(user, password);
    await recordAttempt(ip, email, ok);

    if (!ok || !user) {
      return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
    }

    const { token, expires } = await createSession(user.id);
    const res = NextResponse.json({ ok: true, email: user.email });
    // Over HTTPS use the __Host- prefix (Secure + Path=/ + no Domain) so the
    // browser refuses sibling-subdomain cookie injection. SameSite=strict on
    // the session itself defeats top-level CSRF; pre-login nav can't yet carry
    // a session so there's no UX regression from "strict".
    const secure = isSecureRequest(req);
    res.cookies.set(sessionCookieName(secure), token, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      expires,
    });
    return res;
  } catch (err) {
    console.error("login failed:", safeErr(err));
    return NextResponse.json({ error: "login failed" }, { status: 500 });
  }
}
