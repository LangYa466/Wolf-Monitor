import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/db";
import { assertPublicUrl, defaultNotifyConfig } from "@/lib/notify";
import type { NotifyConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    console.error(err);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as NotifyConfig;
    const base = defaultNotifyConfig();
    const config: NotifyConfig = {
      enabled: Boolean(body.enabled),
      template: typeof body.template === "string" && body.template.trim() ? body.template : base.template,
      webhookUrl: body.webhookUrl ?? "",
      telegram: {
        botToken: body.telegram?.botToken ?? "",
        chatId: body.telegram?.chatId ?? "",
        messageThreadId: body.telegram?.messageThreadId ?? "",
        endpoint: body.telegram?.endpoint?.trim() || base.telegram.endpoint,
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
    console.error(err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
