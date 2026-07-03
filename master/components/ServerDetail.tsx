"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NodeView } from "@/lib/types";
import type { HistoryPoint } from "@/lib/db";
import {
  byteRate,
  datetime,
  flagUrl,
  ibytes,
  osDistro,
  pct,
  uptime,
  uptimeCJK,
} from "@/lib/format";
import type { PingTask } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BandwidthChart, MetricChart } from "@/components/Charts";
import { useI18n } from "@/lib/i18n";
import { ChevronLeft, ArrowUp, ArrowDown, LayoutDashboard, Radar, AlertTriangle, Clock, Lock } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented";
import { SelectMenu } from "@/components/ui/select-menu";
import type { HostInfo } from "@/lib/types";

const POLL_MS = 3000;

// Chart palette — explicit hsl() literals so they resolve as SVG fill/stroke.
const C = {
  blue: "hsl(217 91% 60%)",
  green: "hsl(142 71% 45%)",
  purple: "hsl(265 85% 66%)",
  maroon: "hsl(350 65% 52%)",
  cyan: "hsl(190 85% 55%)",
};

type RangeKey = "realtime" | "4h" | "1d" | "7d" | "30d";
const RANGES: { key: RangeKey; label: string; windowMs: number; xLabel: string }[] = [
  { key: "realtime", label: "RealTime", windowMs: 0, xLabel: "" },
  { key: "4h", label: "4 Hours", windowMs: 4 * 3600_000, xLabel: "4h" },
  { key: "1d", label: "1 Day", windowMs: 24 * 3600_000, xLabel: "1d" },
  { key: "7d", label: "7 Day", windowMs: 7 * 24 * 3600_000, xLabel: "7d" },
  { key: "30d", label: "30 Day", windowMs: 30 * 24 * 3600_000, xLabel: "30d" },
];

// Guests are capped at 24h by /api/nodes/:id/history (GUEST_WINDOW_MS). Ranges
// beyond that would round-trip the request just to receive 1d back, so we lock
// them in the picker and surface "guest cannot view" instead of silently
// truncating the chart.
const GUEST_MAX_WINDOW_MS = 24 * 3600_000;

type Tab = "detail" | "network";

export default function ServerDetail({
  id,
  initial,
  dbError,
  isPublic = false,
}: {
  id: string;
  initial: NodeView | null;
  dbError: string | null;
  isPublic?: boolean;
}) {
  const { t, locale } = useI18n();
  const [node, setNode] = useState<NodeView | null>(initial);
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [range, setRange] = useState<RangeKey>("realtime");
  const [tab, setTab] = useState<Tab>("detail");
  // Start at 0 so SSR and first client render agree (datetime() formats in
  // local TZ — any non-zero seed renders different HH:MM:SS on the UTC server
  // vs the user's browser, tripping React #418 hydration mismatch).
  const [now, setNow] = useState<number>(0);
  const [error, setError] = useState<string | null>(dbError);
  const [loadingHist, setLoadingHist] = useState(true);

  // Live node state (header values) — poll the list and pick out this node.
  useEffect(() => {
    setNow(Date.now());
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/nodes", { cache: "no-store" });
        if (res.status === 401) {
          location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const found = (data.nodes as NodeView[]).find((n) => n.opaqueId === id) ?? null;
        if (alive) {
          if (found) setNode(found);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "fetch failed");
      }
    }
    const pollTimer = setInterval(poll, POLL_MS);
    const clockTimer = setInterval(() => alive && setNow(Date.now()), 1000);
    poll();
    return () => {
      alive = false;
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    };
  }, [id]);

  // History is keyed by the internal hostname id, not the opaque URL id.
  const histId = node?.id ?? initial?.id ?? null;
  const loadHistory = useCallback(async () => {
    if (!histId) return;
    const r = RANGES.find((x) => x.key === range)!;
    const qs =
      r.windowMs > 0 ? `?window=${r.windowMs}&limit=2000` : `?limit=120`;
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(histId)}/history${qs}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setPoints(data.points ?? []);
    } catch {
      /* keep previous */
    }
  }, [histId, range]);

  // Refetch on range change; for RealTime keep polling live. Show a loading
  // skeleton until the first fetch for the current range resolves. Skip when
  // histId is still unknown (initial SSR data missing) so we don't briefly
  // flash "no history" before /api/nodes resolves the node.
  useEffect(() => {
    if (!histId) {
      setLoadingHist(true);
      return;
    }
    setLoadingHist(true);
    setPoints([]);
    loadHistory().finally(() => setLoadingHist(false));
    if (range !== "realtime") return;
    const t = setInterval(loadHistory, POLL_MS);
    return () => clearInterval(t);
  }, [loadHistory, range, histId]);

  if (!node) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        {error ? (
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="size-4" /> {error}
          </span>
        ) : (
          <>{t("notFoundServer")}</>
        )}
        <div className="mt-4">
          <Link href="/" className="text-primary hover:underline">
            {t("backOverview")}
          </Link>
        </div>
      </div>
    );
  }

  const { host, metrics: m } = node;
  const xLabel = rangeXLabel(range, points);
  const swapPct = host.swapTotal > 0 ? (m.swapUsed / host.swapTotal) * 100 : 0;

  // Series derived from history.
  const ts = points.map((p) => p.ts);
  const procFmt = (v: number) => String(Math.round(v));
  const cpu = points.map((p) => p.cpu);
  const cpuTemp = points.map((p) => p.cpuTemp ?? 0);
  const hasTemp = (m.cpuTemp ?? 0) > 0 || cpuTemp.some((v) => v > 0);
  const procs = points.map((p) => p.procs);
  const disk = points.map((p) => p.diskPct);
  const mem = points.map((p) => p.memPct);
  const swap = points.map((p) =>
    host.swapTotal > 0 ? (p.swapUsed / host.swapTotal) * 100 : 0,
  );
  const netUp = points.map((p) => p.netUp);
  const netDown = points.map((p) => p.netDown);
  const tcp = points.map((p) => p.tcp);

  const procsMax = niceMax(Math.max(m.procs, ...procs, 1));
  const tcpMax = niceMax(Math.max(m.tcpConns, ...tcp, 1));
  const tempCurrent = m.cpuTemp ?? 0;
  const tempPeak = Math.max(tempCurrent, ...cpuTemp);
  const tempMax = niceMax(Math.max(tempPeak, 60));
  const tempFmt = (v: number) => `${v.toFixed(1)}°C`;

  const cpuChart = (
    <MetricChart
      id="c-cpu"
      title="CPU"
      legend={<span>{pct(m.cpuUsage)}</span>}
      series={[{ data: cpu, color: C.blue, name: "CPU", format: pct }]}
      max={100}
      yLabels={["100%", "50%", "0%"]}
      xLeft={xLabel}
      timestamps={ts}
    />
  );
  const procChart = (
    <MetricChart
      id="c-proc"
      title={t("chProcesses")}
      legend={<span className="text-foreground">{m.procs}</span>}
      series={[{ data: procs, color: C.maroon, area: true, name: t("chProcesses"), format: procFmt }]}
      max={procsMax}
      yLabels={[String(procsMax), String(Math.round(procsMax / 2)), "0"]}
      xLeft={xLabel}
      timestamps={ts}
    />
  );
  const diskChart = (
    <MetricChart
      id="c-disk"
      title={t("chDisk")}
      legend={
        <span>
          <span className="text-foreground">{pct(m.diskPercent)}</span>
          <br />
          {ibytes(m.diskUsed)} / {ibytes(host.diskTotal)}
        </span>
      }
      series={[{ data: disk, color: C.green, area: true, name: t("chDisk"), format: pct }]}
      max={100}
      yLabels={["100%", "50%", "0%"]}
      xLeft={xLabel}
      timestamps={ts}
    />
  );
  const memChart = (
    <MetricChart
      id="c-mem"
      title={t("chMemSwap")}
      legend={
        <span>
          <span className="text-foreground">
            {pct(m.memPercent)} / {pct(swapPct)}
          </span>
          <br />
          {ibytes(m.memUsed)} / {ibytes(host.memTotal)}
          <br />
          swap {ibytes(m.swapUsed)} / {ibytes(host.swapTotal)}
        </span>
      }
      series={[
        { data: mem, color: C.purple, area: true, name: t("memory"), format: pct },
        { data: swap, color: C.cyan, name: "Swap", format: pct },
      ]}
      max={100}
      yLabels={["100%", "50%", "0%"]}
      xLeft={xLabel}
      timestamps={ts}
    />
  );
  const tempChart = (
    <MetricChart
      id="c-temp"
      title={t("chCpuTemp")}
      legend={<span className="text-foreground">{tempFmt(tempCurrent)}</span>}
      series={[{ data: cpuTemp, color: C.maroon, area: true, name: t("chCpuTemp"), format: tempFmt }]}
      max={tempMax}
      yLabels={[tempFmt(tempMax), tempFmt(tempMax / 2), "0°C"]}
      xLeft={xLabel}
      timestamps={ts}
    />
  );
  const tcpChart = (
    <MetricChart
      id="c-tcp"
      title={t("chTcp")}
      legend={<span className="text-foreground">{m.tcpConns}</span>}
      series={[{ data: tcp, color: C.cyan, area: true, name: "TCP", format: procFmt }]}
      max={tcpMax}
      yLabels={[String(tcpMax), String(Math.round(tcpMax / 2)), "0"]}
      xLeft={xLabel}
      timestamps={ts}
    />
  );

  return (
    <div>
      {/* breadcrumb */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Link href="/" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <LayoutDashboard className="size-4" /> {t("overview")}
        </Link>
        <span className="text-muted-foreground tnum">
          {t("currentTime")} <span className="text-foreground">{now ? datetime(now).slice(11) : "—"}</span>
        </span>
      </div>

      {/* info header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="mb-4 flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Link
              href="/"
              aria-label={t("backOverview")}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-6" />
            </Link>
            {node.country && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={flagUrl(node.country)}
                alt={node.country}
                width={24}
                height={18}
                className="rounded-[2px]"
              />
            )}
            <span className="truncate" title={host.hostname}>
              {node.name?.trim() || host.hostname}
            </span>
          </h1>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <Field label={t("status")}>
              <span
                className={cn(
                  "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
                  node.online
                    ? "bg-success/15 text-success"
                    : "bg-destructive/15 text-destructive",
                )}
              >
                {node.online ? t("online") : t("offline")}
              </span>
            </Field>
            <Field label={t("uptimeLabel")}>
              {node.online ? (locale === "en" ? uptime(m.uptime) : uptimeCJK(m.uptime)) : "—"}
            </Field>
            <Field label={t("arch")}>{host.arch || "—"}</Field>
            <Field label={t("memory")}>{ibytes(host.memTotal)}</Field>
            <Field label={t("disk")}>{ibytes(host.diskTotal)}</Field>
            <Field label={t("region")}>
              {node.country ? (
                <span className="flex h-4 items-center pl-[2px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={node.country.toUpperCase()}
                    loading="lazy"
                    className="inline-block h-[1em] w-auto rounded-[1px] object-cover"
                    src={`https://flagcdn.com/${node.country}.svg`}
                  />
                </span>
              ) : (
                "—"
              )}
            </Field>

            <Field label={t("system")} className="col-span-2 sm:col-span-2 lg:col-span-3">
              <OsBadge host={host} />
            </Field>
            <Field label={t("cpu")} className="col-span-2 sm:col-span-1 lg:col-span-3">
              <span title={host.cpuModel}>
                {host.cpuModel || "—"} · {host.cpuCores} {t("cores")}
              </span>
            </Field>

            <Field label={t("load")}>
              {m.load1.toFixed(2)} / {m.load5.toFixed(2)} / {m.load15.toFixed(2)}
            </Field>
            <Field label={t("virt")}>{virtLabel(host, t("virtBareMetal"))}</Field>
            <Field label={t("totalUp")}>{ibytes(m.netSent)}</Field>
            <Field label={t("totalDown")}>{ibytes(m.netRecv)}</Field>
            <Field label={t("bootTime")} className="col-span-2 lg:col-span-1">
              <span suppressHydrationWarning>
                {host.bootTime ? datetime(host.bootTime * 1000) : "—"}
              </span>
            </Field>
            <Field label={t("lastReport")} className="col-span-2">
              <span suppressHydrationWarning>{datetime(node.lastSeen)}</span>
            </Field>
          </dl>
        </div>

        <div className="hidden h-24 w-24 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 sm:flex">
          <Radar className="size-12 text-primary" />
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {/* tabs (left) + time range (right) on one row */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          variant="card"
          value={tab}
          onChange={setTab}
          options={[
            { value: "detail", label: t("tabDetail") },
            { value: "network", label: t("tabNetwork") },
          ]}
        />
        <SelectMenu
          align="end"
          ariaLabel="time range"
          value={range}
          onChange={setRange}
          leading={<Clock className="text-muted-foreground" />}
          options={RANGES.map((r) => {
            const locked = isPublic && r.windowMs > GUEST_MAX_WINDOW_MS;
            return {
              value: r.key,
              label: locked ? (
                <span title={t("guestLocked")}>{r.label}</span>
              ) : (
                r.label
              ),
              disabled: locked,
              trailing: locked ? <Lock /> : undefined,
            };
          })}
        />
      </div>

      {/* charts — skeleton while the first fetch for this range is in flight */}
      {loadingHist && points.length === 0 ? (
        <div
          className={cn(
            "grid grid-cols-1 gap-3",
            tab === "detail" ? "md:grid-cols-2 lg:grid-cols-3" : "md:grid-cols-2",
          )}
        >
          {Array.from({ length: tab === "detail" ? 3 : 3 }).map((_, i) => (
            <ChartSkeleton key={i} />
          ))}
        </div>
      ) : points.length === 0 ? (
        <p className="mb-4 text-center text-sm text-muted-foreground">
          {t("noHistory")}
          {range === "realtime" ? t("collecting") : ""}
        </p>
      ) : tab === "detail" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {cpuChart}
          {diskChart}
          {memChart}
          {hasTemp && tempChart}
        </div>
      ) : (
        <div className="space-y-3">
          <BandwidthChart
            id="c-bw"
            title={t("chBandwidth")}
            legend={
              <span className="inline-flex items-center gap-3">
                <span className="inline-flex items-center gap-1" style={{ color: "hsl(190 95% 55%)" }}>
                  <ArrowUp className="size-3" />
                  {byteRate(m.netUpSpeed)}
                </span>
                <span className="inline-flex items-center gap-1" style={{ color: "hsl(28 95% 58%)" }}>
                  <ArrowDown className="size-3" />
                  {byteRate(m.netDownSpeed)}
                </span>
              </span>
            }
            up={netUp}
            down={netDown}
            timestamps={ts}
            fmt={byteRate}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {procChart}
            {tcpChart}
          </div>
          <NodeLatencyHistory nodeId={node.id} range={range} xLabel={xLabel} />
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-muted-foreground">
        <a
          href="https://github.com/LangYa466/Wolf-Monitor"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium transition-colors hover:text-foreground"
        >
          Wolf-Monitor
        </a>{" "}
        · {t("updatedEvery", { n: POLL_MS / 1000 })}
      </footer>
    </div>
  );
}

// Pulsing placeholder shown while a chart's history is still loading.
function ChartSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="h-4 w-16 animate-pulse rounded bg-muted" />
        <div className="h-3 w-12 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-[150px] animate-pulse rounded bg-muted/50" />
      <div className="mt-1 flex justify-between">
        <div className="h-2 w-6 animate-pulse rounded bg-muted" />
        <div className="h-2 w-6 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function latColor(ms: number): string {
  if (ms >= 250) return "text-destructive";
  if (ms >= 120) return "text-warning";
  return "text-success";
}

// NodeLatencyHistory plots each ping task this node participates in as its
// own time-series chart — mirrors the Network Bandwidth Usage panel: pulls
// raw `ping_results` rows for the active range, renders a small chart per
// task with the current latency in the legend and a timeout/success colour.
// Failed probes are dropped from the series so they don't draw a fake 0-line
// spike; the legend still shows "timeout" when the most recent sample failed.
function NodeLatencyHistory({
  nodeId,
  range,
  xLabel,
}: {
  nodeId: string;
  range: RangeKey;
  xLabel: string;
}) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<PingTask[]>([]);
  const [byTask, setByTask] = useState<Record<string, { ts: number; latencyMs: number; success: boolean }[]>>({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const r = RANGES.find((x) => x.key === range)!;
    const qs = r.windowMs > 0 ? `?window=${r.windowMs}&limit=2000` : `?limit=120`;
    try {
      const res = await fetch(
        `/api/nodes/${encodeURIComponent(nodeId)}/latency${qs}`,
        { cache: "no-store" },
      );
      if (res.status === 401) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const d = await res.json();
      setForbidden(false);
      setTasks(d.tasks ?? []);
      setByTask(d.byTask ?? {});
    } catch {
      /* keep previous */
    }
  }, [nodeId, range]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    if (range !== "realtime") return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, range]);

  // Guests hit /api/nodes/:id/latency (admin-only) with a 401 — just hide.
  if (forbidden) return null;

  const presentTasks = tasks
    .filter((tk) => (byTask[tk.id]?.length ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (loading && presentTasks.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    );
  }
  if (presentTasks.length === 0) return null;

  return (
    <div>
      <div className="mb-2 text-[15px] font-semibold tracking-tight">{t("ownLatency")}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {presentTasks.map((task) => {
          const pts = byTask[task.id] ?? [];
          const ok = pts.filter((p) => p.success);
          const values = ok.map((p) => p.latencyMs);
          const ts = ok.map((p) => p.ts);
          const last = pts[pts.length - 1];
          const peak = values.length ? Math.max(...values) : 1;
          const max = niceMax(Math.max(1, peak));
          const fmt = (v: number) => `${v.toFixed(1)} ms`;
          return (
            <MetricChart
              key={task.id}
              id={`lat-${task.id}`}
              title={
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  {task.name}
                  <span className="text-xs font-normal text-muted-foreground" title={task.target}>
                    {task.target}
                  </span>
                </span>
              }
              legend={
                last ? (
                  last.success ? (
                    <span className={latColor(last.latencyMs)}>{fmt(last.latencyMs)}</span>
                  ) : (
                    <span className="text-destructive">{t("timeout")}</span>
                  )
                ) : null
              }
              series={[
                {
                  data: values,
                  color: C.cyan,
                  area: true,
                  name: task.name,
                  format: fmt,
                },
              ]}
              max={max}
              yLabels={[fmt(max), fmt(max / 2), "0"]}
              xLeft={xLabel}
              timestamps={ts}
            />
          );
        })}
      </div>
    </div>
  );
}

// virtLabel picks a human-friendly name for the hypervisor the agent detected.
// The agent forwards systemd-detect-virt's raw token (kvm/vmware/xen/…); we
// map the common ones to a nicer display and fall back to the uppercased
// token so novel hypervisors still show something readable. Empty string on
// bare metal — the caller substitutes the localized "Bare metal" label.
function virtLabel(host: HostInfo, bareMetalLabel: string): string {
  const v = host.virtualization?.trim().toLowerCase() ?? "";
  if (!v || v === "none") return bareMetalLabel;
  const pretty: Record<string, string> = {
    kvm: "KVM",
    qemu: "QEMU",
    vmware: "VMware",
    xen: "Xen",
    hyperv: "Hyper-V",
    "microsoft-hyperv": "Hyper-V",
    virtualbox: "VirtualBox",
    "oracle-virtualbox": "VirtualBox",
    docker: "Docker",
    lxc: "LXC",
    "lxc-libvirt": "LXC",
    openvz: "OpenVZ",
    "linux-vserver": "Linux-VServer",
    "amazon-nitro": "AWS Nitro",
    "google-cloud": "GCE",
  };
  return pretty[v] ?? v.toUpperCase();
}

// OsBadge shows the concrete distribution (Ubuntu / Debian / …) with its logo
// rendered from the font-logos icon font (covers Linux distros + Windows/macOS).
function OsBadge({ host }: { host: HostInfo }) {
  const { name, logo } = osDistro(host.platform, host.os);
  const ver = host.platformVersion ? ` ${host.platformVersion}` : "";
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn(logo, "shrink-0 text-[15px] leading-none")} aria-hidden />
      <span className="truncate">
        {name}
        {ver}
      </span>
    </span>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="mb-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tnum" title={typeof children === "string" ? children : undefined}>
        {children}
      </dd>
    </div>
  );
}

// niceMax rounds a value up to a clean axis bound (1/2/5 × 10ⁿ).
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * base;
}

function rangeXLabel(range: RangeKey, points: HistoryPoint[]): string {
  // Label the x-axis with the actual span of returned data, not the nominal
  // window. A node installed an hour ago has ~1h of history; if we still
  // claimed "7d" on its 7d-range chart, the dense cluster of points at the
  // right edge would read as a graphing bug. When data fills the window,
  // both numbers agree and the label matches the picker.
  if (points.length < 2) {
    return range === "realtime" ? "" : RANGES.find((r) => r.key === range)!.xLabel;
  }
  const spanMs = points[points.length - 1].ts - points[0].ts;
  return formatSpan(spanMs);
}

function formatSpan(ms: number): string {
  if (ms <= 0) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const mins = Math.round(ms / 60_000);
  return mins > 0 ? `${mins}m` : "";
}
