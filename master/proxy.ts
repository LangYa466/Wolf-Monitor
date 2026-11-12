import { NextRequest, NextResponse } from "next/server";

// CSRF defense for admin mutators: state-changing requests under /api/*
// (POST/PATCH/PUT/DELETE) must originate same-origin. Node-facing and auth
// bootstrap routes are exempt — they're invoked by the Go agent or pre-login
// browser, not the authenticated admin session.
//
// The matcher is deliberately narrow (see the export at the bottom): only the
// routes this file actually guards. Node ingestion (/api/report, /api/ping,
// /api/tasks, /api/cron) is the highest-frequency traffic the master sees and
// is exempt below anyway, so running the edge middleware sandbox for it bought
// nothing. It is also the traffic that correlates with the master's slow heap
// growth (a per-invocation array of edge-sandbox module functions), so keeping
// those requests out of the sandbox is both free and the mitigation.

const NODE_PATHS = ["/api/report", "/api/ping", "/api/tasks", "/api/cron"];
const AUTH_OPEN = ["/api/auth/login", "/api/auth/setup"];
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Authenticated read-side guard: /api/nodes returns dashboard data. If the
  // caller has a session cookie, refuse cross-site fetches so a malicious page
  // can't read the admin's nodes via the browser's ambient credentials.
  const hasSession =
    !!req.cookies.get("__Host-wolf_session") || !!req.cookies.get("wolf_session");
  if (hasSession && (pathname === "/api/nodes" || pathname.startsWith("/api/nodes/"))) {
    const sfs = req.headers.get("sec-fetch-site");
    if (sfs && !["same-origin", "same-site", "none"].includes(sfs)) {
      return NextResponse.json({ error: "cross-site request rejected" }, { status: 403 });
    }
  }

  if (!MUTATING.has(req.method)) return NextResponse.next();
  if (NODE_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  if (AUTH_OPEN.includes(pathname)) return NextResponse.next();

  // Sec-Fetch-Site is set by all modern browsers and cannot be forged from JS.
  // "none" = user-initiated address bar; "same-origin"/"same-site" are first-party.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && !["same-origin", "same-site", "none"].includes(sfs)) {
    return NextResponse.json({ error: "cross-site request rejected" }, { status: 403 });
  }
  // Fall back to Origin/Host comparison for clients that don't send Sec-Fetch-Site.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "origin mismatch" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad origin" }, { status: 403 });
    }
  }
  return NextResponse.next();
}

// Every route below is either a mutating admin endpoint (CSRF guard) or
// /api/nodes* (cross-site read guard). Anything not listed never needs
// middleware; adding a new mutating admin route means adding it here.
export const config = {
  matcher: [
    "/api/nodes/:path*",
    "/api/alerts/:path*",
    "/api/offline",
    "/api/ping-tasks/:path*",
    "/api/settings",
    "/api/notify-config",
    "/api/notify-test",
    "/api/http-checks/:path*",
    "/api/auth/logout",
  ],
};
