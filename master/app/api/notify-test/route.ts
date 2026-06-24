import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { defaultNotifyConfig, loadConfig, sendTest } from "@/lib/notify";
import { getPool } from "@/lib/db";
import type { NotifyConfig } from "@/lib/types";

// Sends a test notification. Uses the posted (unsaved) config when provided, so
// users can verify before saving; otherwise falls back to the stored config.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap outbound test sends per admin so a compromised session can't iterate
// /api/notify-test as an SSRF scan / reflected-flood primitive. Reuses the
// auth_attempts ledger (DB-backed, survives across serverless instances).
const TEST_WINDOW_MS = 60 * 60 * 1000;
const TEST_MAX_PER_USER = 10;

async function notifyTestRateLimited(userId: number): Promise<boolean> {
  const since = Date.now() - TEST_WINDOW_MS;
  const scope = `notify-test:${userId}`;
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM auth_attempts WHERE scope = $1 AND ts >= $2`,
    [scope, since]
  );
  return Number(rows[0]?.n ?? 0) >= TEST_MAX_PER_USER;
}

async function recordNotifyTest(userId: number): Promise<void> {
  await getPool().query(
    `INSERT INTO auth_attempts (scope, ts, success) VALUES ($1, $2, TRUE)`,
    [`notify-test:${userId}`, Date.now()]
  );
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (await notifyTestRateLimited(user.id))
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  try {
    let cfg: NotifyConfig;
    const body = await req.json().catch(() => null);
    if (body && body.telegram) {
      const base = defaultNotifyConfig();
      cfg = { ...base, ...body, telegram: { ...base.telegram, ...body.telegram } };
    } else {
      cfg = await loadConfig();
    }
    await recordNotifyTest(user.id);
    const result = await sendTest(cfg);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error("notify-test failed:", name);
    return NextResponse.json({ ok: false, error: "test failed" }, { status: 500 });
  }
}
