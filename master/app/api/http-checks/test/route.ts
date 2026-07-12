// Admin-only smoke test for the HTTP-check pipeline. Probes ONE url once and
// fans out a synthetic notification with the outcome — so operators can
// verify both the probe result AND the Telegram/webhook wiring without
// having to bring a real target down. Does NOT touch the persisted config or
// state map (dedup logic stays intact for real checks).
//
//   curl -X POST https://…/api/http-checks/test \
//     -b "session=…" -H "content-type: application/json" \
//     -d '{"url":"https://httpstat.us/502","name":"Fake 502"}'

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { notify } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 8_000;

async function probe(url: string) {
  const f = (m: "HEAD" | "GET") => fetch(url, {
    method: m, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow",
    headers: { "user-agent": "wolf-monitor/http-check" },
  });
  try {
    const r = await f("HEAD");
    if (r.status === 405 || r.status === 403) { const r2 = await f("GET"); return { ok: r2.ok, code: r2.status }; }
    return { ok: r.ok, code: r.status };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  let u: URL;
  try { u = new URL(String(body?.url ?? "")); } catch { return NextResponse.json({ error: "invalid url" }, { status: 400 }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return NextResponse.json({ error: "only http(s)" }, { status: 400 });
  const label = (typeof body?.name === "string" && body.name.trim()) || u.toString();
  const p = await probe(u.toString());
  const detail = p.ok
    ? `test OK — HTTP ${p.code}`
    : p.code
      ? `test FAIL — HTTP ${p.code} (non-2xx)`
      : `test FAIL — unreachable: ${p.error ?? "error"}`;
  // Always fire "alert" level so the operator sees the same channel that a
  // real down event would hit; body text says "test" so it's not confused
  // with a live incident.
  await notify("alert", "HTTP check TEST", label, detail).catch(() => {});
  return NextResponse.json({ ok: true, probe: p, notified: true });
}
