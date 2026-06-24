import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  createSession,
  createUserExclusive,
  ensureNodeToken,
  isRateLimited,
  sessionCookieName,
} from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { clientIp } from "@/lib/net";
import { isSecureRequest, validateCredentials } from "@/lib/authutil";

// First-run setup: creates the first admin account. Refuses once one exists.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Strip CR/LF/NUL/control chars + cap length so a pg error echoing
// connection bytes (DSN, host:port) can't leak via container logs or
// forge log lines. Matches the safeErr pattern in app/api/report/route.ts.
function safeErr(e: unknown, max = 200): string {
  const msg = e instanceof Error ? `${e.name}` : "error";
  return msg.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, max);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();

    // Reject oversized bodies before buffering — bounds scrypt input and JSON parse.
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 4 * 1024) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }

    // Optional out-of-band setup token gate. When SETUP_TOKEN is set, callers
    // must present a matching x-setup-token header (compared in constant time).
    const expectedToken = process.env.SETUP_TOKEN;
    if (expectedToken && expectedToken.length > 0) {
      const provided = req.headers.get("x-setup-token") ?? "";
      if (!constantTimeEquals(provided, expectedToken)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    // Per-IP rate limit (reuse the login limiter, scoped by IP only).
    const ip = clientIp(req.headers) ?? "unknown";
    if (await isRateLimited(ip, `setup:${ip}`)) {
      return NextResponse.json(
        { error: "too many attempts, try again later" },
        { status: 429 }
      );
    }

    const { email, password } = await req.json();

    // Length caps before validateCredentials to bound work and prevent abuse.
    if (typeof email === "string" && email.length > 254) {
      return NextResponse.json({ error: "invalid email or password" }, { status: 400 });
    }
    if (typeof password === "string" && password.length > 256) {
      return NextResponse.json({ error: "invalid email or password" }, { status: 400 });
    }

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
    // See login route: __Host- prefix + SameSite=strict on HTTPS deployments.
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
    console.error("setup failed:", safeErr(err));
    return NextResponse.json({ error: "setup failed" }, { status: 500 });
  }
}
