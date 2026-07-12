// Admin-only CRUD for HTTP liveness targets. Not surfaced from the dashboard —
// call /api/http-checks directly. See lib/http-check.ts for the evaluator.

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/db";
import type { HttpCheckTarget } from "@/lib/http-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Stored { targets: HttpCheckTarget[]; state?: Record<string, unknown> }

export async function GET() {
  if (!(await currentUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getSetting<Stored>("httpChecks").catch(() => null);
  return NextResponse.json({ targets: cfg?.targets ?? [], state: cfg?.state ?? {} });
}

export async function POST(req: NextRequest) {
  if (!(await currentUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const raw = Array.isArray(body?.targets) ? body.targets : null;
  if (!raw) return NextResponse.json({ error: "targets array required" }, { status: 400 });
  if (raw.length > 32) return NextResponse.json({ error: "too many targets (max 32)" }, { status: 400 });
  const targets: HttpCheckTarget[] = [];
  for (const t of raw) {
    let u: URL;
    try { u = new URL(String(t?.url ?? "")); } catch { return NextResponse.json({ error: `invalid url: ${t?.url}` }, { status: 400 }); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return NextResponse.json({ error: `only http(s): ${u.protocol}` }, { status: 400 });
    const iv = Math.max(30, Math.min(86_400, Math.round(Number(t?.intervalSec) || 300)));
    const name = typeof t?.name === "string" && t.name.trim() && t.name.length <= 80 ? t.name.trim() : undefined;
    targets.push({ url: u.toString(), intervalSec: iv, name });
  }
  // Preserve state for surviving URLs; drop entries for removed ones so a
  // re-added URL starts fresh instead of inheriting ancient status.
  const cur = await getSetting<Stored>("httpChecks").catch(() => null);
  const kept: Record<string, unknown> = {};
  const set = new Set(targets.map((t) => t.url));
  for (const [k, v] of Object.entries(cur?.state ?? {})) if (set.has(k)) kept[k] = v;
  await setSetting("httpChecks", { targets, state: kept });
  return NextResponse.json({ ok: true, targets });
}
