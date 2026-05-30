import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/db";
import { defaultNotifyConfig } from "@/lib/notify";
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
    await setSetting("notify", config);
    return NextResponse.json({ config });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
