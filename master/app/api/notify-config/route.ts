import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/db";
import { assertPublicUrl, defaultNotifyConfig } from "@/lib/notify";
import type { NotifyConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Strip CR/LF/NUL/control chars + cap length so a pg error echoing
// connection bytes (DSN, host:port) can't leak via container logs or
// forge log lines. Matches the safeErr pattern in app/api/report/route.ts.
function safeErr(e: unknown, max = 200): string {
  const msg = e instanceof Error ? `${e.name}` : "error";
  return msg.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, max);
}

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const stored = await getSetting<Partial<NotifyConfig>>("notify");
    const base = defaultNotifyConfig();
    const config: NotifyConfig = stored
      ? { ...base, ...stored, telegram: { ...base.telegram, ...(stored.telegram ?? {}) } }
      : base;
    return NextResponse.json({ config });
  } catch (err) {
    console.error("notify-config GET failed:", safeErr(err));
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as NotifyConfig;
    const base = defaultNotifyConfig();
    // Bound string sizes to keep app_settings row small and reject junk types.
    const str = (v: unknown, max: number, field: string): string => {
      if (v === undefined || v === null) return "";
      if (typeof v !== "string") throw new Error(`${field} must be a string`);
      if (v.length > max) throw new Error(`${field} too long`);
      return v;
    };
    const url = (v: unknown, field: string): string => {
      const s = str(v, 2048, field).trim();
      if (!s) return "";
      let u: URL;
      try { u = new URL(s); } catch { throw new Error(`${field} not a valid URL`); }
      if (u.protocol !== "http:" && u.protocol !== "https:")
        throw new Error(`${field} must be http(s)`);
      return s;
    };
    const template = str(body.template, 8192, "template");
    const webhookUrl = url(body.webhookUrl, "webhookUrl");
    const endpointRaw = url(body.telegram?.endpoint, "telegram.endpoint");
    const config: NotifyConfig = {
      enabled: Boolean(body.enabled),
      template: template.trim() ? template : base.template,
      webhookUrl,
      telegram: {
        botToken: str(body.telegram?.botToken, 4096, "telegram.botToken"),
        chatId: str(body.telegram?.chatId, 256, "telegram.chatId"),
        messageThreadId: str(body.telegram?.messageThreadId, 64, "telegram.messageThreadId"),
        endpoint: endpointRaw || base.telegram.endpoint,
      },
    };
    // Write-time SSRF guard: reject private/loopback/non-https targets up front
    // so a bad URL never reaches app_settings (defends DNS rebind too via
    // send-time re-check). Empty webhookUrl is allowed (= disabled).
    if (config.webhookUrl) {
      try {
        await assertPublicUrl(config.webhookUrl);
      } catch (e) {
        return NextResponse.json(
          { error: `webhookUrl rejected: ${(e as Error).message}` },
          { status: 400 },
        );
      }
    }
    if (config.telegram.endpoint) {
      // Telegram endpoint is the base URL; assertPublicUrl needs a parseable
      // URL, so build a representative full URL for the check.
      const probe = config.telegram.endpoint.replace(/\/+$/, "") + "X/sendMessage";
      try {
        await assertPublicUrl(probe);
      } catch (e) {
        return NextResponse.json(
          { error: `telegram endpoint rejected: ${(e as Error).message}` },
          { status: 400 },
        );
      }
    }
    await setSetting("notify", config);
    return NextResponse.json({ config });
  } catch (err) {
    console.error("notify-config POST failed:", safeErr(err));
    const msg = err instanceof Error ? err.message : "bad request";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
