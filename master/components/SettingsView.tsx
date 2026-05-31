"use client";

import { useCallback, useEffect, useState } from "react";
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
import { GripVertical, Trash2, RotateCw, Check, Minus, AlertTriangle } from "lucide-react";

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
  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState<NodeView[]>([]);

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

  if (!ready) {
    return <p className="py-20 text-center text-muted-foreground">{t("loading")}</p>;
  }

  const nodeIds = nodes.map((n) => n.id);

  return (
    <div className="space-y-5">
      <header className="mb-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("setTitle")} <span className="font-normal text-muted-foreground">/ {t("setSub")}</span>
        </h1>
      </header>

      <ServersSection nodes={nodes} />
      <NotificationSettings />
      <AlertRules nodeIds={nodeIds} />
      <OfflineSettings nodes={nodes} />
      <PingTasks nodeIds={nodeIds} />
    </div>
  );
}

// ── Servers: token, ipinfo, drag reorder ────────────────────────────────────

function ServersSection({ nodes }: { nodes: NodeView[] }) {
  const { t } = useI18n();
  const [nodeToken, setNodeToken] = useState("");
  const [ipinfoToken, setIpinfoToken] = useState("");
  const [publicDashboard, setPublicDashboard] = useState(false);
  const [order, setOrder] = useState<NodeView[]>(nodes);
  const [dragId, setDragId] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [cipherKey, setCipherKey] = useState("");
  const [cipherTweak, setCipherTweak] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => setOrder(nodes), [nodes]);
  useEffect(() => {
    setNames(Object.fromEntries(nodes.map((n) => [n.id, n.name ?? ""])));
  }, [nodes]);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setNodeToken(d.nodeToken ?? "");
        setIpinfoToken(d.ipinfoToken ?? "");
        setPublicDashboard(d.publicDashboard === true);
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
  async function rotate() {
    const res = await api("/api/settings", "POST", { rotateNodeToken: true });
    if (res.ok) {
      const d = await res.json();
      setNodeToken(d.nodeToken);
      setMsg(t("msgTokenRotated"));
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
  const tok = nodeToken || "TOKEN";

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

        <Field label={t("nodeTokenLabel")}>
          <div className="flex gap-2">
            <Input readOnly value={nodeToken} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" size="sm" onClick={rotate} className="[&_svg]:size-3.5">
              <RotateCw /> {t("rotate")}
            </Button>
          </div>
        </Field>
        <div className="space-y-2 rounded-md bg-muted/60 p-3 text-xs">
          <div className="text-muted-foreground">{t("installLinux")}</div>
          <code className="block break-all text-primary">
            {`wget -qO- https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh | sudo bash -s -- -e ${base} -t ${tok} -T http`}
          </code>
          <div className="text-muted-foreground">{t("installWin")}</div>
          <code className="block break-all text-primary">
            {`powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr 'https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.ps1' -UseBasicParsing -OutFile 'install.ps1'; & '.\\install.ps1' '-e' '${base}' '-t' '${tok}' '-T' 'http'"`}
          </code>
          <div className="text-muted-foreground">{t("installWs")}</div>
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
              <div
                key={n.id}
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
                <span className={`ml-1 h-2 w-2 shrink-0 rounded-full ${n.online ? "bg-success" : "bg-destructive"}`} />
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

function AlertRules({ nodeIds }: { nodeIds: string[] }) {
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
    const res = await api("/api/alerts", "POST", { ...form, targets: parseList(form.targets as unknown as string) });
    if (res.ok) {
      setForm(blankRule());
      setMsg("");
      load();
    } else setMsg(t("msgFailed"));
  }
  async function remove(id: string) {
    if ((await api(`/api/alerts/${id}`, "DELETE")).ok) load();
  }

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
                <TableCell className="max-w-[160px] truncate text-muted-foreground">{r.targets.length ? r.targets.join(", ") : t("all")}</TableCell>
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
          <Input className="w-56" placeholder={t("phServersBlank")} value={(form.targets as unknown as string) ?? ""} onChange={(e) => setForm({ ...form, targets: e.target.value as unknown as string[] })} />
          <Button onClick={submit}>{t("add")}</Button>
        </div>
        {nodeIds.length > 0 && <p className="text-xs text-muted-foreground">{t("known")}{nodeIds.join(", ")}</p>}
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
            {rows.map((s) => <OfflineRow key={s.nodeId} setting={s} onSave={save} />)}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">{t("noServersYet")}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OfflineRow({ setting, onSave }: { setting: OfflineSetting; onSave: (id: string, enabled: boolean, grace: number) => void }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [grace, setGrace] = useState(setting.graceSeconds);
  return (
    <TableRow>
      <TableCell className="font-medium">{setting.nodeId}</TableCell>
      <TableCell><Switch checked={enabled} onCheckedChange={setEnabled} /></TableCell>
      <TableCell><Input className="w-24" type="number" value={grace} onChange={(e) => setGrace(Number(e.target.value))} /></TableCell>
      <TableCell>{setting.offline ? <Badge variant="destructive">{t("stOffline")}</Badge> : <Badge variant="success">{t("stOnline")}</Badge>}</TableCell>
      <TableCell><Button variant="outline" size="sm" onClick={() => onSave(setting.nodeId, enabled, grace)}>{t("save")}</Button></TableCell>
    </TableRow>
  );
}

// ── Ping / latency tasks ────────────────────────────────────────────────────

function PingTasks({ nodeIds }: { nodeIds: string[] }) {
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

  async function submit() {
    const res = await api("/api/ping-tasks", "POST", { ...form, nodeIds: parseList(form.nodeIds as unknown as string) });
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
                <TableCell className="max-w-[140px] truncate text-muted-foreground">{task.nodeIds.length ? task.nodeIds.join(", ") : t("all")}</TableCell>
                <TableCell><OnOff on={task.enabled} /></TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive [&_svg]:size-4" onClick={() => remove(task.id)}><Trash2 /></Button>
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
          <Input className="w-56" placeholder={t("phServersBlank")} value={(form.nodeIds as unknown as string) ?? ""} onChange={(e) => setForm({ ...form, nodeIds: e.target.value as unknown as string[] })} />
          <Button onClick={submit}>{t("add")}</Button>
        </div>
        {nodeIds.length > 0 && <p className="text-xs text-muted-foreground">{t("known")}{nodeIds.join(", ")}</p>}
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
  return { type: "tcp", intervalSeconds: 60, enabled: true };
}
function defaultOffline(nodeId: string): OfflineSetting {
  return { nodeId, enabled: true, graceSeconds: 180, lastNotified: null, offline: false };
}
function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}
