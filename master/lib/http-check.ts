// Admin-configurable HTTP liveness checks. Piggybacks on evaluate() (~30s
// cadence); each target has its own intervalSec that gates the actual fetch.
// State transitions (up↔down) fan out through notify() — Telegram/webhook —
// reusing the operator's existing channel. First check after (re)config
// records baseline WITHOUT notify, so adding a target doesn't page anyone.
// Config + state live in one encrypted app_settings row ("httpChecks").

import { getSetting, setSetting } from "./db";
import { notify } from "./notify";

export interface HttpCheckTarget {
  url: string; intervalSec: number; name?: string;
  // Consecutive down probes required before paging (default 2). Single slow/
  // timed-out responses no longer flap the state → fewer false alerts.
  failThreshold?: number;
  // Per-target request timeout (default 8s). Slow targets can raise this.
  timeoutMs?: number;
}
// `streakStatus`/`streakCount` track the run of identical raw probe outcomes so
// we only flip `status` (the confirmed/notified state) after N in a row.
interface HttpCheckState {
  status: "up" | "down" | "unknown"; lastCheckAt: number; lastCode?: number; lastError?: string;
  streakStatus?: "up" | "down"; streakCount?: number;
}
interface HttpCheckConfig { targets: HttpCheckTarget[]; state: Record<string, HttpCheckState> }

const HTTP_CHECK_TIMEOUT_MS = 8_000;
const HTTP_CHECK_FAIL_THRESHOLD = 2;
const HTTP_CHECK_KEY = "httpChecks";

async function probe(url: string, timeoutMs = HTTP_CHECK_TIMEOUT_MS): Promise<{ ok: boolean; code?: number; error?: string }> {
  const f = (m: "HEAD" | "GET") => fetch(url, {
    method: m, signal: AbortSignal.timeout(timeoutMs), redirect: "follow",
    headers: { "user-agent": "wolf-monitor/http-check" },  // WAFs 403 unknown UAs
  });
  const once = async (): Promise<{ ok: boolean; code?: number }> => {
    const r = await f("HEAD");
    // Many sites 403/405 HEAD — retry GET before crying wolf.
    if (r.status === 405 || r.status === 403) { const r2 = await f("GET"); return { ok: r2.ok, code: r2.status }; }
    return { ok: r.ok, code: r.status };
  };
  try {
    return await once();
  } catch {
    // Timeout / network blip — retry once before treating it as down. A single
    // slow round-trip shouldn't count as a failure.
    try { return await once(); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }
}

export async function evaluateHttpChecks(): Promise<void> {
  const cfg = (await getSetting<HttpCheckConfig>(HTTP_CHECK_KEY).catch(() => null))
    ?? { targets: [], state: {} };
  if (!cfg.targets?.length) return;
  const now = Date.now();
  const state: Record<string, HttpCheckState> = cfg.state ?? {};
  let dirty = false;
  for (const t of cfg.targets) {
    const prev = state[t.url] ?? { status: "unknown" as const, lastCheckAt: 0 };
    if (now - prev.lastCheckAt < t.intervalSec * 1000) continue;
    const p = await probe(t.url, t.timeoutMs);
    const raw: "up" | "down" = p.ok ? "up" : "down";

    // Extend the run of identical raw outcomes; a flip resets it to 1.
    const streakCount = prev.streakStatus === raw ? (prev.streakCount ?? 0) + 1 : 1;

    let status = prev.status;
    if (prev.status === "unknown") {
      // First observation after (re)config: record baseline, never page.
      status = raw;
    } else if (raw !== prev.status) {
      // Down needs `failThreshold` consecutive fails; recovery is immediate so
      // "back up" isn't delayed. Both directions only fire once, on the flip.
      const need = raw === "down" ? Math.max(1, Math.round(t.failThreshold ?? HTTP_CHECK_FAIL_THRESHOLD)) : 1;
      if (streakCount >= need) {
        status = raw;
        const label = t.name || t.url;
        if (raw === "down") {
          const detail = p.code ? `HTTP ${p.code} (non-2xx)` : `unreachable: ${p.error ?? "error"}`;
          await notify("alert", "HTTP check", label, detail).catch(() => {});
        } else {
          await notify("recovery", "HTTP check", label, `back to HTTP ${p.code} OK`).catch(() => {});
        }
      }
    }

    state[t.url] = { status, lastCheckAt: now, lastCode: p.code, lastError: p.error, streakStatus: raw, streakCount };
    dirty = true;
  }
  if (dirty) await setSetting(HTTP_CHECK_KEY, { targets: cfg.targets, state });
}
