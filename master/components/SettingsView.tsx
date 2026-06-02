"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  AlertMetric,
  AlertRule,
  NodeView,
  NotifyConfig,
  OfflineSetting,
  PingTask,
  PingType,
} from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectMenu } from "@/components/ui/select-menu";
import { SegmentedControl } from "@/components/ui/segmented";
import { NodeMultiSelect } from "@/components/ui/node-multiselect";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { flagUrl } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { GripVertical, Trash2, RotateCw, Check, Minus, AlertTriangle, Terminal, Pencil } from "lucide-react";

// Install commands for a node (identical for every server — the node reports
// its own hostname; reinstalling just re-runs the same token-based command).
// Used both for the general snippet and the per-server "view install script".
// When `proxy` is set, prepends it to the install-script URL too (so the
// script itself downloads through the mirror, not just the wolf-node binary
// that the script later fetches via `-p`).
function InstallSnippet({
  base,
  tok,
  hostname,
  proxy,
}: {
  base: string;
  tok: string;
  hostname?: string;
  proxy?: string;
}) {
  const { t } = useI18n();
  const p = (proxy ?? "").trim().replace(/\/+$/, "");
  const shUrl = `https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh`;
  const ps1Url = `https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.ps1`;
  const shFull = p ? `${p}/${shUrl}` : shUrl;
  const ps1Full = p ? `${p}/${ps1Url}` : ps1Url;
  const shProxyArg = p ? ` -p ${p}` : "";
  const ps1ProxyArg = p ? ` '-p' '${p}'` : "";
  return (
    <div className="space-y-2 rounded-md bg-muted/60 p-3 text-xs">
      {hostname && (
        <div className="font-medium text-foreground">
          {t("viewInstall")} · <span className="font-mono">{hostname}</span>
        </div>
      )}
      <div className="text-muted-foreground">{t("installLinux")}</div>
      <code className="block break-all text-primary">
        {`wget -qO- ${shFull} | sudo bash -s -- -e ${base} -t ${tok} -T http${shProxyArg}`}
      </code>
      <div className="text-muted-foreground">{t("installWin")}</div>
      <code className="block break-all text-primary">
        {`powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr '${ps1Full}' -UseBasicParsing -OutFile 'install.ps1'; & '.\\install.ps1' '-e' '${base}' '-t' '${tok}' '-T' 'http'${ps1ProxyArg}"`}
      </code>
      <div className="text-muted-foreground">{t("installWs")}</div>
    </div>
  );
}

// Renders a node's on/off state as an icon (no emoji).
function OnOff({ on }: { on: boolean }) {
  return on ? (
    <Check className="size-4 text-success" aria-label="on" />
  ) : (
    <Minus className="size-4 text-muted-foreground" aria-label="off" />
  );
}

// Authenticated mutation helper: on 401 bounce to /login.
async function api(url: string, method: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) location.href = "/login";
  return res;
}

export default function SettingsView() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState<NodeView[]>([]);

  // Tab lives in the URL (?tab=alerts) so it's bookmarkable, refresh-stable,
  // and back/forward-aware. Falls back to localStorage (legacy storage) then
  // to "servers" on first visit.
  const urlTab = searchParams.get("tab") as SettingsTab | null;
  const tab: SettingsTab =
    urlTab && TABS.some((x) => x.value === urlTab)
      ? urlTab
      : (typeof window !== "undefined"
          ? (localStorage.getItem(TAB_KEY) as SettingsTab | null)
          : null) ?? "servers";

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => {
        if (!d.setupDone) location.href = "/setup";
        else if (!d.authenticated) location.href = "/login";
        else setReady(true);
      })
      .catch(() => setReady(true));
    fetch("/api/nodes")
      .then((r) => r.json())
      .then((d) => setNodes(d.nodes ?? []))
      .catch(() => {});
  }, []);

  // On first paint, if a legacy localStorage tab is present and no ?tab= is in
  // the URL, push it into the URL so the bar reflects state. Use replaceState
  // to avoid adding a back-button entry for the migration.
  useEffect(() => {
    if (!urlTab) {
      const stored =
        typeof window !== "undefined"
          ? (localStorage.getItem(TAB_KEY) as SettingsTab | null)
          : null;
      if (stored && TABS.some((x) => x.value === stored) && stored !== "servers") {
        router.replace(`${pathname}?tab=${stored}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeTab(v: SettingsTab) {
    localStorage.setItem(TAB_KEY, v);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", v);
    router.replace(`${pathname}?${params.toString()}`);
  }

  if (!ready) {
    return <p className="py-20 text-center text-muted-foreground">{t("loading")}</p>;
  }

  return (
    <div className="space-y-5">
      <header className="mb-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("setTitle")} <span className="font-normal text-muted-foreground">/ {t("setSub")}</span>
        </h1>
      </header>

      {/* section tabs — switch instead of scrolling through every card */}
      <div className="sticky top-16 z-30 -mx-4 border-b border-border bg-background/85 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        <SegmentedControl
          variant="card"
          value={tab}
          onChange={changeTab}
          className="max-w-full overflow-x-auto"
          options={TABS.map((x) => ({ value: x.value, label: t(x.key) }))}
        />
      </div>

      {/* section content (no transition — instant switch) */}
      <div key={tab}>
        {tab === "servers" && <ServersSection nodes={nodes} />}
        {tab === "notify" && <NotificationSettings />}
        {tab === "alerts" && <AlertRules nodes={nodes} />}
        {tab === "offline" && <OfflineSettings nodes={nodes} />}
        {tab === "ping" && <PingTasks nodes={nodes} />}
      </div>
    </div>
  );
}

type SettingsTab = "servers" | "notify" | "alerts" | "offline" | "ping";
const TAB_KEY = "wolf_settings_tab";
const TABS: { value: SettingsTab; key: string }[] = [
  { value: "servers", key: "secServers" },
  { value: "notify", key: "secNotify" },
  { value: "alerts", key: "secAlerts" },
  { value: "offline", key: "secOffline" },
  { value: "ping", key: "secPing" },
];

// ── Servers: token, ipinfo, drag reorder ────────────────────────────────────

function ServersSection({ nodes }: { nodes: NodeView[] }) {
  const { t } = useI18n();
  const [ipinfoToken, setIpinfoToken] = useState("");
  const [publicDashboard, setPublicDashboard] = useState(false);
  const [ghProxyEnabled, setGhProxyEnabled] = useState(false);
  const [ghProxyUrl, setGhProxyUrl] = useState("");
  const [nodeTokens, setNodeTokens] = useState<Record<string, string>>({});
  const [unboundTokens, setUnboundTokens] = useState<Array<{ token: string; createdAt: number }>>([]);
  const [order, setOrder] = useState<NodeView[]>(nodes);
  const [dragId, setDragId] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [cipherKey, setCipherKey] = useState("");
  const [cipherTweak, setCipherTweak] = useState("");
  const [openInstall, setOpenInstall] = useState<string | null>(null);
  const [showNewServer, setShowNewServer] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => setOrder(nodes), [nodes]);
  useEffect(() => {
    setNames(Object.fromEntries(nodes.map((n) => [n.id, n.name ?? ""])));
  }, [nodes]);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setIpinfoToken(d.ipinfoToken ?? "");
        setPublicDashboard(d.publicDashboard === true);
        setGhProxyEnabled(d.ghProxyEnabled === true);
        setGhProxyUrl(d.ghProxyUrl ?? "");
        setNodeTokens(d.nodeTokens ?? {});
        setUnboundTokens(d.unboundTokens ?? []);
        setCipherKey(d.idCipherKey ?? "");
        setCipherTweak(d.idCipherTweak ?? "");
      })
      .catch(() => {});
  }, []);

  async function saveName(id: string) {
    const res = await api(`/api/nodes/${encodeURIComponent(id)}`, "PATCH", {
      name: names[id] ?? "",
    });
    setMsg(res.ok ? t("msgSaved") : t("msgFailed"));
  }

  async function saveCipher(payload: { idCipherKey?: string; idCipherTweak?: string } | { rotateIdCipher: true }) {
    const res = await api("/api/settings", "POST", payload);
    if (res.ok) {
      const d = await res.json();
      setCipherKey(d.idCipherKey ?? "");
      setCipherTweak(d.idCipherTweak ?? "");
      setMsg(t("msgSaved"));
    } else {
      setMsg(t("msgFailed"));
    }
  }

  async function togglePublic(v: boolean) {
    setPublicDashboard(v); // optimistic
    const res = await api("/api/settings", "POST", { publicDashboard: v });
    if (res.ok) {
      setMsg(v ? t("msgPublicOn") : t("msgPublicOff"));
    } else {
      setPublicDashboard(!v); // roll back on failure
      setMsg(t("msgPublicFail"));
    }
  }

  async function saveIpinfo() {
    const res = await api("/api/settings", "POST", { ipinfoToken });
    setMsg(res.ok ? t("msgSaved") : t("msgFailed"));
  }
  async function toggleGhProxy(v: boolean) {
    setGhProxyEnabled(v); // optimistic
    const res = await api("/api/settings", "POST", { ghProxyEnabled: v });
    if (!res.ok) {
      setGhProxyEnabled(!v);
      setMsg(t("msgFailed"));
    }
  }
  async function saveGhProxyUrl() {
    const res = await api("/api/settings", "POST", { ghProxyUrl });
    setMsg(res.ok ? t("msgSaved") : t("msgFailed"));
  }
  async function rotateNodeToken(hostname: string) {
    const res = await api("/api/settings", "POST", {
      rotateNodeToken: { hostname },
    });
    if (res.ok) {
      const d = await res.json();
      setNodeTokens(d.nodeTokens ?? {});
      setMsg(t("msgTokenRotated"));
    }
  }
  async function createUnboundToken() {
    const res = await api("/api/settings", "POST", { createUnboundToken: true });
    if (res.ok) {
      const d = await res.json();
      setUnboundTokens(d.unboundTokens ?? []);
      setShowNewServer(true);
      setMsg(t("msgTokenCreated"));
    }
  }
  async function deleteToken(token: string) {
    const res = await api("/api/settings", "POST", { deleteToken: token });
    if (res.ok) {
      const d = await res.json();
      setUnboundTokens(d.unboundTokens ?? []);
    }
  }
  async function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const prev = order;
    const ids = order.map((n) => n.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next); // optimistic
    setDragId(null);
    const res = await api("/api/nodes/order", "POST", { order: next.map((n) => n.id) });
    if (res.ok) {
      setMsg(t("msgOrderSaved"));
    } else {
      setOrder(prev); // roll back on failure
      setMsg(t("msgOrderFail"));
    }
  }

  const origin = typeof window !== "undefined" ? window.location.host : "your-master";
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  // http(s) base for install commands. HTTP transport works on both Vercel
  // (serverless can't hold a WebSocket) and self-host, so it's the safe default.
  const base = `${proto === "wss" ? "https" : "http"}://${origin}`;
  // Active GitHub mirror — empty when off. Falls back to ghfast.top when
  // enabled with a blank URL (the most common preset for mainland users).
  const activeProxy = ghProxyEnabled ? (ghProxyUrl.trim() || "https://ghfast.top") : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("secServers")}</CardTitle>
        <CardDescription>{t("secServersDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/40 p-3">
          <div className="min-w-0">
            <Label className="text-sm text-foreground">{t("publicDash")}</Label>
            <p className="mt-1 text-xs text-muted-foreground">{t("publicDashDesc")}</p>
          </div>
          <Switch checked={publicDashboard} onCheckedChange={togglePublic} />
        </div>

        {/* Per-node tokens. Each existing server gets a unique token (see the
            collapsible install snippet on each row below). For a brand-new
            server, pre-create an unbound token and use it in the install
            command — it'll bind to that server's hostname on first report. */}
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label className="text-sm text-foreground">{t("newServerLabel")}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t("newServerDesc")}</p>
            </div>
            <Button variant="outline" size="sm" onClick={createUnboundToken}>
              {t("createToken")}
            </Button>
          </div>
          {unboundTokens.length > 0 && (
            <div className="space-y-2">
              {unboundTokens.map((u) => (
                <div key={u.token} className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">{u.token}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-xs"
                      onClick={() => deleteToken(u.token)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {showNewServer && (
                    <InstallSnippet base={base} tok={u.token} proxy={activeProxy} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label className="text-sm text-foreground">{t("ghProxy")}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{t("ghProxyDesc")}</p>
            </div>
            <Switch checked={ghProxyEnabled} onCheckedChange={toggleGhProxy} />
          </div>
          {ghProxyEnabled && (
            <div className="flex gap-2">
              <Input
                value={ghProxyUrl}
                onChange={(e) => setGhProxyUrl(e.target.value)}
                placeholder="https://ghfast.top"
                className="font-mono"
              />
              <Button variant="outline" size="sm" onClick={saveGhProxyUrl}>
                {t("save")}
              </Button>
            </div>
          )}
        </div>

        <Field label={t("ipinfoLabel")}>
          <div className="flex gap-2">
            <Input value={ipinfoToken} onChange={(e) => setIpinfoToken(e.target.value)} placeholder={t("ipinfoPh")} />
            <Button variant="outline" size="sm" onClick={saveIpinfo}>{t("save")}</Button>
          </div>
        </Field>

        <div>
          <Label>{t("customOrder")} · {t("nodeName")}</Label>
          <div className="mt-2 space-y-1.5">
            {order.length === 0 && <p className="text-sm text-muted-foreground">{t("noServersYet")}</p>}
            {order.map((n) => (
              <div key={n.id}>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(n.id)}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  {/* drag handle — only this part starts a drag, so the name input stays usable */}
                  <span
                    draggable
                    onDragStart={() => setDragId(n.id)}
                    className="cursor-grab p-1 text-muted-foreground active:cursor-grabbing"
                    title={n.host.hostname}
                  >
                    <GripVertical className="size-4" />
                  </span>
                  {n.country && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={flagUrl(n.country)} alt={n.country} width={18} height={13} className="shrink-0 rounded-[2px]" />
                  )}
                  <Input
                    value={names[n.id] ?? ""}
                    placeholder={n.host.hostname}
                    onChange={(e) => setNames((m) => ({ ...m, [n.id]: e.target.value }))}
                    onBlur={() => {
                      if ((names[n.id] ?? "") !== (n.name ?? "")) saveName(n.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-8"
                  />
                  <button
                    type="button"
                    onClick={() => setOpenInstall((cur) => (cur === n.id ? null : n.id))}
                    aria-label={t("viewInstall")}
                    title={t("viewInstall")}
                    aria-expanded={openInstall === n.id}
                    className={cn(
                      "inline-flex size-7 shrink-0 items-center justify-center rounded transition-colors [&_svg]:size-4",
                      openInstall === n.id
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    <Terminal />
                  </button>
                  <span className={`ml-1 h-2 w-2 shrink-0 rounded-full ${n.online ? "bg-success" : "bg-destructive"}`} />
                </div>
                {openInstall === n.id && (
                  <div className="mt-1.5 space-y-1.5">
                    <InstallSnippet
                      base={base}
                      tok={nodeTokens[n.host.hostname] ?? "TOKEN"}
                      hostname={n.host.hostname}
                      proxy={activeProxy}
                    />
                    <div className="flex items-center justify-end gap-2 text-xs">
                      <span className="mr-auto text-muted-foreground">{t("nodeTokenHint")}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="[&_svg]:size-3.5"
                        onClick={() => rotateNodeToken(n.host.hostname)}
                      >
                        <RotateCw /> {t("rotate")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Advanced: opaque server-link id cipher. */}
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
          <Label className="text-sm text-foreground">{t("secOpaque")}</Label>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {t("opaqueWarn")}
          </p>
          <Field label={t("opaqueKey")}>
            <Input
              value={cipherKey}
              onChange={(e) => setCipherKey(e.target.value)}
              onBlur={() => saveCipher({ idCipherKey: cipherKey })}
              className="font-mono"
              spellCheck={false}
            />
          </Field>
          <Field label={t("opaqueTweak")}>
            <div className="flex gap-2">
              <Input
                value={cipherTweak}
                onChange={(e) => setCipherTweak(e.target.value)}
                onBlur={() => saveCipher({ idCipherTweak: cipherTweak })}
                className="font-mono"
                spellCheck={false}
              />
              <Button variant="outline" size="sm" onClick={() => saveCipher({ rotateIdCipher: true })}>
                {t("regenerate")}
              </Button>
            </div>
          </Field>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

// ── Notifications ───────────────────────────────────────────────────────────

function NotificationSettings() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<NotifyConfig | null>(null);
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    fetch("/api/notify-config")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setCfg(d.config))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (!cfg) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("secNotify")}</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const tg = cfg.telegram;
  const setTg = (patch: Partial<typeof tg>) => setCfg({ ...cfg, telegram: { ...tg, ...patch } });

  async function save() {
    const res = await api("/api/notify-config", "POST", cfg);
    setMsg(res.ok ? t("msgSaved") : t("msgFailed"));
    if (res.ok) load();
  }
  async function test() {
    setTesting(true);
    setMsg(t("msgSendingTest"));
    try {
      const res = await api("/api/notify-test", "POST", cfg);
      const d = await res.json().catch(() => ({}));
      setMsg(res.ok ? t("msgTestSent") : `${t("msgTestFail")}${d.error ?? res.status}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("secNotify")}</CardTitle>
        <CardDescription>
          {t("notifyTplDesc")} <Ph>emoji</Ph> <Ph>event</Ph> <Ph>client</Ph> <Ph>message</Ph> <Ph>time</Ph>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />
          {t("enableNotify")}
        </label>

        <Field label={t("msgTemplate")}>
          <Textarea rows={6} className="font-mono text-[12.5px] leading-relaxed" value={cfg.template} onChange={(e) => setCfg({ ...cfg, template: e.target.value })} />
        </Field>

        <h3 className="border-t border-border pt-4 text-sm font-medium">Telegram</h3>
        <Field label="Bot Token *">
          <Input value={tg.botToken} onChange={(e) => setTg({ botToken: e.target.value })} placeholder="8998875014:AAF..." />
        </Field>
        <Field label="Chat ID *">
          <Input value={tg.chatId} onChange={(e) => setTg({ chatId: e.target.value })} placeholder="6782517202" />
        </Field>
        <Field label="message_thread_id">
          <Input value={tg.messageThreadId} onChange={(e) => setTg({ messageThreadId: e.target.value })} placeholder="Optional — supergroup topic id" />
        </Field>
        <Field label={t("apiEndpoint")}>
          <Input value={tg.endpoint} onChange={(e) => setTg({ endpoint: e.target.value })} placeholder="https://api.telegram.org/bot" />
        </Field>

        <h3 className="border-t border-border pt-4 text-sm font-medium">Webhook</h3>
        <Field label="Webhook URL">
          <Input value={cfg.webhookUrl} onChange={(e) => setCfg({ ...cfg, webhookUrl: e.target.value })} placeholder="https://example.com/hook (optional)" />
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button onClick={save}>{t("save")}</Button>
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>{t("sendTest")}</Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Load alert rules ────────────────────────────────────────────────────────

function AlertRules({ nodes }: { nodes: NodeView[] }) {
  const { t } = useI18n();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [form, setForm] = useState<Partial<AlertRule>>(blankRule());
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    fetch("/api/alerts")
      .then((r) => (r.ok ? r.json() : { rules: [] }))
      .then((d) => setRules(d.rules ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function submit() {
    const res = await api("/api/alerts", "POST", form);
    if (res.ok) {
      setForm(blankRule());
      setMsg("");
      load();
    } else setMsg(t("msgFailed"));
  }
  async function remove(id: string) {
    if ((await api(`/api/alerts/${id}`, "DELETE")).ok) load();
  }
  // Mirror PingTasks' label: "X selected" / "X excluded" / "All servers".
  const targetsLabel = (r: AlertRule): string => {
    if (!r.targets || r.targets.length === 0) return t("all");
    return r.exclude
      ? t("selExclude", { n: r.targets.length })
      : t("selCount", { n: r.targets.length });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("secAlerts")}</CardTitle>
        <CardDescription>{t("secAlertsDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("thName")}</TableHead><TableHead>{t("thMetric")}</TableHead><TableHead>{t("thThreshold")}</TableHead>
              <TableHead>{t("thRatio")}</TableHead><TableHead>{t("thWindow")}</TableHead><TableHead>{t("thServers")}</TableHead>
              <TableHead>{t("thOn")}</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>{r.metric.toUpperCase()}</TableCell>
                <TableCell>{r.threshold}%</TableCell>
                <TableCell>{(r.ratio * 100).toFixed(0)}%</TableCell>
                <TableCell>{r.windowMinutes}m</TableCell>
                <TableCell className="max-w-[160px] truncate text-muted-foreground" title={r.targets.join(", ")}>{targetsLabel(r)}</TableCell>
                <TableCell><OnOff on={r.enabled} /></TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive [&_svg]:size-4" onClick={() => remove(r.id)}><Trash2 /></Button>
                </TableCell>
              </TableRow>
            ))}
            {rules.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-muted-foreground">{t("noRules")}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-36" placeholder={t("phName")} value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <SelectMenu
            align="start"
            ariaLabel={t("thMetric")}
            value={(form.metric ?? "cpu") as AlertMetric}
            onChange={(v) => setForm({ ...form, metric: v })}
            options={[
              { value: "cpu", label: "CPU" },
              { value: "ram", label: "RAM" },
              { value: "disk", label: "DISK" },
            ]}
          />
          <Input className="w-20" type="number" placeholder="80" value={form.threshold ?? ""} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} />
          <Input className="w-20" type="number" step="0.05" placeholder="0.8" value={form.ratio ?? ""} onChange={(e) => setForm({ ...form, ratio: Number(e.target.value) })} />
          <Input className="w-20" type="number" placeholder="15" value={form.windowMinutes ?? ""} onChange={(e) => setForm({ ...form, windowMinutes: Number(e.target.value) })} />
          <NodeMultiSelect
            className="w-56"
            nodes={nodes}
            value={form.targets ?? []}
            exclude={form.exclude ?? false}
            onChange={(ids) => setForm({ ...form, targets: ids })}
            onExcludeChange={(b) => setForm({ ...form, exclude: b })}
          />
          <Button onClick={submit}>{t("add")}</Button>
        </div>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}

// ── Offline settings ────────────────────────────────────────────────────────

function OfflineSettings({ nodes }: { nodes: NodeView[] }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<OfflineSetting[]>([]);

  const load = useCallback(() => {
    fetch("/api/offline")
      .then((r) => (r.ok ? r.json() : { settings: [] }))
      .then((d) => setSettings(d.settings ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const byId = new Map(settings.map((s) => [s.nodeId, s]));
  const rows = nodes.map((n) => byId.get(n.id) ?? defaultOffline(n.id));
  const labelOf = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n?.name?.trim() || id;
  };

  async function save(nodeId: string, enabled: boolean, graceSeconds: number) {
    if ((await api("/api/offline", "POST", { nodeId, enabled, graceSeconds })).ok) load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("secOffline")}</CardTitle>
        <CardDescription>{t("secOfflineDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("thServer")}</TableHead><TableHead>{t("thEnabled")}</TableHead><TableHead>{t("thGrace")}</TableHead><TableHead>{t("thStatus")}</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => <OfflineRow key={s.nodeId} setting={s} label={labelOf(s.nodeId)} onSave={save} />)}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">{t("noServersYet")}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OfflineRow({ setting, label, onSave }: { setting: OfflineSetting; label: string; onSave: (id: string, enabled: boolean, grace: number) => void }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [grace, setGrace] = useState(setting.graceSeconds);
  return (
    <TableRow>
      <TableCell className="font-medium" title={setting.nodeId}>{label}</TableCell>
      <TableCell><Switch checked={enabled} onCheckedChange={setEnabled} /></TableCell>
      <TableCell><Input className="w-24" type="number" value={grace} onChange={(e) => setGrace(Number(e.target.value))} /></TableCell>
      <TableCell>{setting.offline ? <Badge variant="destructive">{t("stOffline")}</Badge> : <Badge variant="success">{t("stOnline")}</Badge>}</TableCell>
      <TableCell><Button variant="outline" size="sm" onClick={() => onSave(setting.nodeId, enabled, grace)}>{t("save")}</Button></TableCell>
    </TableRow>
  );
}

// ── Ping / latency tasks ────────────────────────────────────────────────────

function PingTasks({ nodes }: { nodes: NodeView[] }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<PingTask[]>([]);
  const [form, setForm] = useState<Partial<PingTask>>(blankTask());
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    fetch("/api/ping-tasks")
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((d) => setTasks(d.tasks ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name?.trim() || id;
  // Summarise a task's node selection for the table.
  function serversLabel(task: PingTask): string {
    if (!task.exclude && task.nodeIds.length === 0) return t("all");
    const names = task.nodeIds.map(nameOf).join(", ");
    return task.exclude ? `${t("modeExclude")}: ${names}` : names;
  }

  async function submit() {
    const res = await api("/api/ping-tasks", "POST", { ...form });
    if (res.ok) {
      setForm(blankTask());
      setMsg("");
      load();
    } else setMsg(t("msgFailed"));
  }
  async function remove(id: string) {
    if ((await api(`/api/ping-tasks/${id}`, "DELETE")).ok) load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("secPing")}</CardTitle>
        <CardDescription>{t("secPingDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("thName")}</TableHead><TableHead>{t("thTarget")}</TableHead><TableHead>{t("thType")}</TableHead>
              <TableHead>{t("thInterval")}</TableHead><TableHead>{t("thServers")}</TableHead><TableHead>{t("thOn")}</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow key={task.id}>
                <TableCell className="font-medium">{task.name}</TableCell>
                <TableCell className="max-w-[160px] truncate text-muted-foreground">{task.target}</TableCell>
                <TableCell>{task.type.toUpperCase()}</TableCell>
                <TableCell>{task.intervalSeconds}s</TableCell>
                <TableCell className="max-w-[160px] truncate text-muted-foreground" title={serversLabel(task)}>{serversLabel(task)}</TableCell>
                <TableCell><OnOff on={task.enabled} /></TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    <Button variant="ghost" size="sm" className="h-7 px-2 [&_svg]:size-4" aria-label={t("edit")} title={t("edit")} onClick={() => setForm({ ...task })}><Pencil /></Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive [&_svg]:size-4" aria-label={t("clearSel")} onClick={() => remove(task.id)}><Trash2 /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-muted-foreground">{t("noMonitors")}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-36" placeholder={t("phName")} value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input className="w-52" placeholder={t("phTarget")} value={form.target ?? ""} onChange={(e) => setForm({ ...form, target: e.target.value })} />
          <SelectMenu
            align="start"
            ariaLabel={t("thType")}
            value={(form.type ?? "tcp") as PingType}
            onChange={(v) => setForm({ ...form, type: v })}
            options={[
              { value: "tcp", label: "TCP" },
              { value: "icmp", label: "ICMP" },
            ]}
          />
          <Input className="w-20" type="number" placeholder="60" value={form.intervalSeconds ?? ""} onChange={(e) => setForm({ ...form, intervalSeconds: Number(e.target.value) })} />
          <NodeMultiSelect
            className="w-56"
            nodes={nodes}
            value={form.nodeIds ?? []}
            exclude={form.exclude ?? false}
            onChange={(ids) => setForm({ ...form, nodeIds: ids })}
            onExcludeChange={(b) => setForm({ ...form, exclude: b })}
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={form.enabled ?? true} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            {t("thOn")}
          </label>
          <Button onClick={submit}>{form.id ? t("save") : t("add")}</Button>
          {form.id && (
            <Button variant="outline" onClick={() => { setForm(blankTask()); setMsg(""); }}>
              {t("cancel")}
            </Button>
          )}
        </div>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex max-w-xl flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Ph({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-primary">{`{{${children}}}`}</code>;
}
function blankRule(): Partial<AlertRule> {
  return { metric: "cpu", threshold: 80, ratio: 0.8, windowMinutes: 15, enabled: true };
}
function blankTask(): Partial<PingTask> {
  return { type: "tcp", intervalSeconds: 60, nodeIds: [], exclude: false, enabled: true };
}
function defaultOffline(nodeId: string): OfflineSetting {
  return { nodeId, enabled: true, graceSeconds: 180, lastNotified: null, offline: false };
}
