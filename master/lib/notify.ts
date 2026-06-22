// Notification fan-out with a configurable message template.
//
// Config is stored in the DB (app_settings key "notify", edited from Settings)
// and falls back to environment variables when not configured:
//   NOTIFY_TELEGRAM_TOKEN + NOTIFY_TELEGRAM_CHAT  -> Telegram
//   NOTIFY_WEBHOOK_URL                            -> generic JSON webhook
//
// The template understands these placeholders (Komari-compatible):
//   {{emoji}}  -> the level tag     {{event}}  -> event name
//   {{client}} -> server / node id  {{message}}-> details   {{time}} -> timestamp

import { lookup } from "dns/promises";
import { isIP } from "net";
import { getSetting } from "./db";
import type { NotifyConfig } from "./types";

// Outbound HTTP timeout for notification calls. Bounded so a slow/blackholed
// target can't pile up requests indefinitely.
const NOTIFY_FETCH_TIMEOUT_MS = 5000;

// Reject URLs that point at loopback / link-local / private / multicast / etc.
// IP literals or DNS names that resolve into them. Without this any admin (or
// hijacked admin account) can pivot the master into the internal network /
// cloud metadata service via the configurable webhook + Telegram endpoint.
function isPrivateV4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}
function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fec0:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isPrivateV4(v4);
  }
  return false;
}
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "https:") {
    throw new Error("notification URL must use https://");
  }
  const host = u.hostname;
  const literal = isIP(host);
  const addrs: Array<{ address: string; family: number }> = literal
    ? [{ address: host, family: literal }]
    : await lookup(host, { all: true });
  for (const a of addrs) {
    if (a.family === 4 && isPrivateV4(a.address)) {
      throw new Error("notification URL resolves to a private address");
    }
    if (a.family === 6 && isPrivateV6(a.address)) {
      throw new Error("notification URL resolves to a private address");
    }
  }
  return u;
}

export type NotifyLevel = "alert" | "recovery" | "offline" | "online";

// Plain-text level tags (no emoji) substituted into the {{emoji}} placeholder.
const LEVEL_EMOJI: Record<NotifyLevel, string> = {
  alert: "[ALERT]",
  recovery: "[RECOVERED]",
  offline: "[OFFLINE]",
  online: "[ONLINE]",
};

export const DEFAULT_TEMPLATE =
  "{{emoji}}\n" +
  "Event: {{event}}\n" +
  "Clients: {{client}}\n" +
  "Message: {{message}}\n" +
  "Time: {{time}}";

export function defaultNotifyConfig(): NotifyConfig {
  return {
    enabled: false,
    template: DEFAULT_TEMPLATE,
    telegram: {
      botToken: process.env.NOTIFY_TELEGRAM_TOKEN ?? "",
      chatId: process.env.NOTIFY_TELEGRAM_CHAT ?? "",
      messageThreadId: "",
      endpoint: "https://api.telegram.org/bot",
    },
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? "",
  };
}

// loadConfig merges stored config over defaults so new fields get sane values.
export async function loadConfig(): Promise<NotifyConfig> {
  const base = defaultNotifyConfig();
  const stored = await getSetting<Partial<NotifyConfig>>("notify").catch(() => null);
  if (!stored) {
    // No DB config: enable iff env channels are present.
    base.enabled = Boolean(
      (base.telegram.botToken && base.telegram.chatId) || base.webhookUrl
    );
    return base;
  }
  return {
    ...base,
    ...stored,
    telegram: { ...base.telegram, ...(stored.telegram ?? {}) },
  };
}

export function renderTemplate(
  template: string,
  vars: { emoji: string; event: string; client: string; message: string; time: string }
): string {
  // Single pass with a replacer function: values are NOT re-scanned (so a node
  // literally named "{{time}}" stays literal) and `$`-sequences in values are
  // not treated as replacement patterns.
  const allowed = new Set(["emoji", "event", "client", "message", "time"]);
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    allowed.has(key) ? (vars as Record<string, string>)[key] : match
  );
}

function nowString(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function sendTelegram(cfg: NotifyConfig, text: string): Promise<void> {
  const { botToken, chatId, messageThreadId, endpoint } = cfg.telegram;
  if (!botToken || !chatId) return;
  const base = (endpoint || "https://api.telegram.org/bot").replace(/\/+$/, "");
  const url = `${base}${botToken}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (messageThreadId) payload.message_thread_id = Number(messageThreadId);
  try {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) {
      console.error("telegram notify failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("telegram notify error:", err);
  }
}

async function sendWebhook(
  cfg: NotifyConfig,
  level: NotifyLevel,
  event: string,
  client: string,
  message: string,
  text: string
): Promise<void> {
  if (!cfg.webhookUrl) return;
  try {
    await assertPublicUrl(cfg.webhookUrl);
    const res = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, event, client, message, text, ts: Date.now() }),
      signal: AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) console.error("webhook notify failed:", res.status);
  } catch (err) {
    console.error("webhook notify error:", err);
  }
}

// notify renders the template and dispatches to every configured channel.
export async function notify(
  level: NotifyLevel,
  event: string,
  client: string,
  message: string
): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.enabled) return;
  const text = renderTemplate(cfg.template || DEFAULT_TEMPLATE, {
    emoji: LEVEL_EMOJI[level],
    event,
    client,
    message,
    time: nowString(),
  });
  await Promise.allSettled([
    sendTelegram(cfg, text),
    sendWebhook(cfg, level, event, client, message, text),
  ]);
}

// sendTest dispatches a test message using an explicit config (the unsaved form
// values), so users can verify settings before saving.
export async function sendTest(cfg: NotifyConfig): Promise<{ ok: boolean; error?: string }> {
  const text = renderTemplate(cfg.template || DEFAULT_TEMPLATE, {
    emoji: LEVEL_EMOJI.recovery,
    event: "Test",
    client: "wolf",
    message: "This is a test notification from wolf.",
    time: nowString(),
  });
  const results = await Promise.allSettled([
    sendTelegram(cfg, text),
    sendWebhook(cfg, "recovery", "Test", "wolf", "test", text),
  ]);
  const failed = results.find((r) => r.status === "rejected");
  if (failed && failed.status === "rejected") {
    return { ok: false, error: String(failed.reason) };
  }
  if (!cfg.telegram.botToken && !cfg.webhookUrl) {
    return { ok: false, error: "no channel configured" };
  }
  return { ok: true };
}
