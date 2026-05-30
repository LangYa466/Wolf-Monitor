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
import { Select } from "@/components/ui/select";
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
    return <p className="py-20 text-center text-muted-foreground">Loading…</p>;
  }

  const nodeIds = nodes.map((n) => n.id);

  return (
    <div className="space-y-5">
      <header className="mb-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Settings <span className="font-normal text-muted-foreground">/ 通知与监测</span>
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
  const [nodeToken, setNodeToken] = useState("");
  const [ipinfoToken, setIpinfoToken] = useState("");
  const [order, setOrder] = useState<NodeView[]>(nodes);
  const [dragId, setDragId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => setOrder(nodes), [nodes]);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setNodeToken(d.nodeToken ?? "");
        setIpinfoToken(d.ipinfoToken ?? "");
      })
      .catch(() => {});
  }, []);

  async function saveIpinfo() {
    const res = await api("/api/settings", "POST", { ipinfoToken });
    setMsg(res.ok ? "Saved." : "Failed.");
  }
  async function rotate() {
    const res = await api("/api/settings", "POST", { rotateNodeToken: true });
    if (res.ok) {
      const d = await res.json();
      setNodeToken(d.nodeToken);
      setMsg("Token rotated — update your nodes.");
    }
  }
  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = order.map((n) => n.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    setDragId(null);
    api("/api/nodes/order", "POST", { order: next.map((n) => n.id) });
  }

  const origin = typeof window !== "undefined" ? window.location.host : "your-master";
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";

  return (
    <Card>
      <CardHeader>
        <CardTitle>服务器 · Servers</CardTitle>
        <CardDescription>Node install token, geo lookup, and drag-to-reorder.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Node token (use in install -t)">
          <div className="flex gap-2">
            <Input readOnly value={nodeToken} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" size="sm" onClick={rotate}>Rotate</Button>
          </div>
        </Field>
        <div className="rounded-md bg-muted/60 p-3 text-xs">
          <div className="mb-1 text-muted-foreground">One-click install (Linux):</div>
          <code className="block break-all text-primary">
            wget -qO- https://raw.githubusercontent.com/LangYa466/Wolf-Monitor/main/node/install.sh | sudo bash -s -- -e {proto === "wss" ? "https" : "http"}://{origin} -t {nodeToken || "TOKEN"}
          </code>
        </div>

        <Field label="ipinfo.io token (optional — higher geo lookup limits)">
          <div className="flex gap-2">
            <Input value={ipinfoToken} onChange={(e) => setIpinfoToken(e.target.value)} placeholder="ipinfo token" />
            <Button variant="outline" size="sm" onClick={saveIpinfo}>Save</Button>
          </div>
        </Field>

        <div>
          <Label>自定义排序 · Drag to reorder</Label>
          <div className="mt-2 space-y-1.5">
            {order.length === 0 && <p className="text-sm text-muted-foreground">no servers yet</p>}
            {order.map((n) => (
              <div
                key={n.id}
                draggable
                onDragStart={() => setDragId(n.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(n.id)}
                className="flex cursor-grab items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm active:cursor-grabbing"
              >
                <span className="text-muted-foreground">⠿</span>
                {n.country && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={flagUrl(n.country)} alt={n.country} width={18} height={13} className="rounded-[2px]" />
                )}
                <span className="font-medium">{n.host.hostname}</span>
                <span className={`ml-auto h-2 w-2 rounded-full ${n.online ? "bg-primary" : "bg-destructive"}`} />
              </div>
            ))}
          </div>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

// ── Notifications ───────────────────────────────────────────────────────────

function NotificationSettings() {
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
          <CardTitle>通知 · Notifications</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const tg = cfg.telegram;
  const setTg = (patch: Partial<typeof tg>) => setCfg({ ...cfg, telegram: { ...tg, ...patch } });

  async function save() {
    const res = await api("/api/notify-config", "POST", cfg);
    setMsg(res.ok ? "Saved." : "Failed.");
    if (res.ok) load();
  }
  async function test() {
    setTesting(true);
    setMsg("Sending test…");
    try {
      const res = await api("/api/notify-test", "POST", cfg);
      const d = await res.json().catch(() => ({}));
      setMsg(res.ok ? "Test sent ✅" : `Test failed: ${d.error ?? res.status}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知 · Notifications</CardTitle>
        <CardDescription>
          Template placeholders: <Ph>emoji</Ph> <Ph>event</Ph> <Ph>client</Ph> <Ph>message</Ph> <Ph>time</Ph>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />
          开启通知 · Enable notifications
        </label>

        <Field label="消息通知模板 · Message template">
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
        <Field label="请求端点 · API endpoint *">
          <Input value={tg.endpoint} onChange={(e) => setTg({ endpoint: e.target.value })} placeholder="https://api.telegram.org/bot" />
        </Field>

        <h3 className="border-t border-border pt-4 text-sm font-medium">Webhook</h3>
        <Field label="Webhook URL">
          <Input value={cfg.webhookUrl} onChange={(e) => setCfg({ ...cfg, webhookUrl: e.target.value })} placeholder="https://example.com/hook (optional)" />
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button onClick={save}>Save</Button>
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>发送测试消息 · Send test</Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Load alert rules ────────────────────────────────────────────────────────

function AlertRules({ nodeIds }: { nodeIds: string[] }) {
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
    } else setMsg("Failed.");
  }
  async function remove(id: string) {
    if ((await api(`/api/alerts/${id}`, "DELETE")).ok) load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>负载通知 · Load alerts</CardTitle>
        <CardDescription>Fire when a metric stays ≥ threshold for at least the time-ratio over the window.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Metric</TableHead><TableHead>Threshold</TableHead>
              <TableHead>Ratio</TableHead><TableHead>Window</TableHead><TableHead>Servers</TableHead>
              <TableHead>On</TableHead><TableHead />
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
                <TableCell className="max-w-[160px] truncate text-muted-foreground">{r.targets.length ? r.targets.join(", ") : "all"}</TableCell>
                <TableCell>{r.enabled ? "✅" : "—"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => remove(r.id)}>✕</Button>
                </TableCell>
              </TableRow>
            ))}
            {rules.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-muted-foreground">no rules</TableCell></TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-36" placeholder="name" value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select className="w-24" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value as AlertMetric })}>
            <option value="cpu">CPU</option><option value="ram">RAM</option><option value="disk">DISK</option>
          </Select>
          <Input className="w-20" type="number" placeholder="80" value={form.threshold ?? ""} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} />
          <Input className="w-20" type="number" step="0.05" placeholder="0.8" value={form.ratio ?? ""} onChange={(e) => setForm({ ...form, ratio: Number(e.target.value) })} />
          <Input className="w-20" type="number" placeholder="15" value={form.windowMinutes ?? ""} onChange={(e) => setForm({ ...form, windowMinutes: Number(e.target.value) })} />
          <Input className="w-56" placeholder="servers (blank = all)" value={(form.targets as unknown as string) ?? ""} onChange={(e) => setForm({ ...form, targets: e.target.value as unknown as string[] })} />
          <Button onClick={submit}>Add</Button>
        </div>
        {nodeIds.length > 0 && <p className="text-xs text-muted-foreground">known: {nodeIds.join(", ")}</p>}
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}

// ── Offline settings ────────────────────────────────────────────────────────

function OfflineSettings({ nodes }: { nodes: NodeView[] }) {
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
        <CardTitle>离线通知 · Offline alerts</CardTitle>
        <CardDescription>Notify when a server stops reporting beyond its grace period.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Server</TableHead><TableHead>Enabled</TableHead><TableHead>Grace (s)</TableHead><TableHead>Status</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => <OfflineRow key={s.nodeId} setting={s} onSave={save} />)}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">no servers yet</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OfflineRow({ setting, onSave }: { setting: OfflineSetting; onSave: (id: string, enabled: boolean, grace: number) => void }) {
  const [enabled, setEnabled] = useState(setting.enabled);
  const [grace, setGrace] = useState(setting.graceSeconds);
  return (
    <TableRow>
      <TableCell className="font-medium">{setting.nodeId}</TableCell>
      <TableCell><Switch checked={enabled} onCheckedChange={setEnabled} /></TableCell>
      <TableCell><Input className="w-24" type="number" value={grace} onChange={(e) => setGrace(Number(e.target.value))} /></TableCell>
      <TableCell>{setting.offline ? <Badge variant="destructive">offline</Badge> : <Badge variant="default">online</Badge>}</TableCell>
      <TableCell><Button variant="outline" size="sm" onClick={() => onSave(setting.nodeId, enabled, grace)}>Save</Button></TableCell>
    </TableRow>
  );
}

// ── Ping / latency tasks ────────────────────────────────────────────────────

function PingTasks({ nodeIds }: { nodeIds: string[] }) {
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
    } else setMsg("Failed.");
  }
  async function remove(id: string) {
    if ((await api(`/api/ping-tasks/${id}`, "DELETE")).ok) load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>延迟监测 · Latency monitors</CardTitle>
        <CardDescription>Selected servers probe the target on the given interval.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Target</TableHead><TableHead>Type</TableHead>
              <TableHead>Interval</TableHead><TableHead>Servers</TableHead><TableHead>On</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="max-w-[160px] truncate text-muted-foreground">{t.target}</TableCell>
                <TableCell>{t.type.toUpperCase()}</TableCell>
                <TableCell>{t.intervalSeconds}s</TableCell>
                <TableCell className="max-w-[140px] truncate text-muted-foreground">{t.nodeIds.length ? t.nodeIds.join(", ") : "all"}</TableCell>
                <TableCell>{t.enabled ? "✅" : "—"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => remove(t.id)}>✕</Button>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-muted-foreground">no monitors</TableCell></TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-36" placeholder="name" value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input className="w-52" placeholder="target (ip / host[:port])" value={form.target ?? ""} onChange={(e) => setForm({ ...form, target: e.target.value })} />
          <Select className="w-24" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as PingType })}>
            <option value="tcp">TCP</option><option value="icmp">ICMP</option>
          </Select>
          <Input className="w-20" type="number" placeholder="60" value={form.intervalSeconds ?? ""} onChange={(e) => setForm({ ...form, intervalSeconds: Number(e.target.value) })} />
          <Input className="w-56" placeholder="servers (blank = all)" value={(form.nodeIds as unknown as string) ?? ""} onChange={(e) => setForm({ ...form, nodeIds: e.target.value as unknown as string[] })} />
          <Button onClick={submit}>Add</Button>
        </div>
        {nodeIds.length > 0 && <p className="text-xs text-muted-foreground">known: {nodeIds.join(", ")}</p>}
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
