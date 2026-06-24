import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  deleteSession,
  deleteSessionsForUser,
  readSessionCookie,
  sessionUser,
} from "@/lib/auth";
import { isSecureRequest } from "@/lib/authutil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = readSessionCookie((n) => req.cookies.get(n));
  const secure = isSecureRequest(req);
  const clearOpts = {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  };
  // Clear both variants — the browser may have either the __Host- or legacy
  // name depending on the scheme when the cookie was issued.
  const clearBoth = (res: NextResponse) => {
    res.cookies.set(SESSION_COOKIE_SECURE, "", { ...clearOpts, secure: true });
    res.cookies.set(SESSION_COOKIE, "", clearOpts);
  };
  // ?all=1 → revoke every session for this user (logout everywhere). Without
  // the flag we only drop the cookie's own row so other devices keep working.
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (token) {
    try {
      if (all) {
        const user = await sessionUser(token);
        if (user) await deleteSessionsForUser(user.id);
        else await deleteSession(token);
      } else {
        await deleteSession(token);
      }
    } catch (err) {
      console.error("logout: deleteSession failed", {
        err,
        tokenPrefix: token.slice(0, 8),
        all,
      });
      const res = NextResponse.json(
        { ok: false, error: "logout_partial" },
        { status: 500 },
      );
      clearBoth(res);
      return res;
    }
  }
  const res = NextResponse.json({ ok: true });
  clearBoth(res);
  return res;
}
