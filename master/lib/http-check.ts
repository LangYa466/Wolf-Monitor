// Admin-configurable HTTP liveness checks. Piggybacks on evaluate() (~30s
// cadence); each target has its own intervalSec that gates the actual fetch.
// State transitions (up↔down) fan out through notify() — Telegram/webhook —
// reusing the operator's existing channel. First check after (re)config
// records baseline WITHOUT notify, so adding a target doesn't page anyone.
// Config + state live in one encrypted app_settings row ("httpChecks").

import { getSetting, setSetting } from "./db";
import { notify } from "./notify";

export interface HttpCheckTarget { url: string; intervalSec: number; name?: string }
interface HttpCheckState { status: "up" | "down" | "unknown"; lastCheckAt: number; lastCode?: number; lastError?: string }
interface HttpCheckConfig { targets: HttpCheckTarget[]; state: Record<string, HttpCheckState> }

const HTTP_CHECK_TIMEOUT_MS = 8_000;
const HTTP_CHECK_KEY = "httpChecks";

async function probe(url: string): Promise<{ ok: boolean; code?: number; error?: string }> {
  const f = (m: "HEAD" | "GET") => fetch(url, {
    method: m, signal: AbortSignal.timeout(HTTP_CHECK_TIMEOUT_MS), redirect: "follow",
    headers: { "user-agent": "wolf-monitor/http-check" },  // WAFs 403 unknown UAs
  });
  try {
    const r = await f("HEAD");
    // Many sites 403/405 HEAD — retry GET before crying wolf.
    if (r.status === 405 || r.status === 403) { const r2 = await f("GET"); return { ok: r2.ok, code: r2.status }; }
    return { ok: r.ok, code: r.status };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
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
    const p = await probe(t.url);
    const newStatus: HttpCheckState["status"] = p.ok ? "up" : "down";
    if (prev.status !== "unknown" && newStatus !== prev.status) {
      const label = t.name || t.url;
      if (newStatus === "down") {
        const detail = p.code ? `HTTP ${p.code} (non-2xx)` : `unreachable: ${p.error ?? "error"}`;
        await notify("alert", "HTTP check", label, detail).catch(() => {});
      } else {
        await notify("recovery", "HTTP check", label, `back to HTTP ${p.code} OK`).catch(() => {});
      }
    }
    state[t.url] = { status: newStatus, lastCheckAt: now, lastCode: p.code, lastError: p.error };
    dirty = true;
  }
  if (dirty) await setSetting(HTTP_CHECK_KEY, { targets: cfg.targets, state });
}
