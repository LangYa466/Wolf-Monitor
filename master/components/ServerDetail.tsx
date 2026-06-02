"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NodeView } from "@/lib/types";
import type { HistoryPoint } from "@/lib/db";
import {
  ago,
  byteRate,
  datetime,
  flagUrl,
  ibytes,
  osDistro,
  pct,
  uptime,
  uptimeCJK,
} from "@/lib/format";
import type { PingResult, PingTask } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BandwidthChart, MetricChart } from "@/components/Charts";
import { useI18n } from "@/lib/i18n";
import { ChevronLeft, ArrowUp, ArrowDown, LayoutDashboard, Radar, AlertTriangle, Clock } from "lucide-react";
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
  const [now, setNow] = useState<number>(initial?.lastSeen ?? 0);
  const [error, setError] = useState<string | null>(dbError);
  const [ping, setPing] = useState<{ tasks: PingTask[]; results: PingResult[] }>({
    tasks: [],
    results: [],
  });
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
  // skeleton until the first fetch for the current range resolves.
  useEffect(() => {
    setLoadingHist(true);
    setPoints([]);
    loadHistory().finally(() => setLoadingHist(false));
    if (range !== "realtime") return;
    const t = setInterval(loadHistory, POLL_MS);
    return () => clearInterval(t);
  }, [loadHistory, range]);

  // Latency feed for the Network tab (admin-only endpoint; guests get 401 and
  // simply see no latency). Filtered to this node below.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/ping-results", { cache: "no-store" });
        if (!res.ok) {
          if (alive) setPing({ tasks: [], results: [] });
          return;
        }
        const d = await res.json();
        if (alive) setPing({ tasks: d.tasks ?? [], results: d.results ?? [] });
      } catch {
        /* keep previous */
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

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
            <Field label={t("totalUp")}>{ibytes(m.netSent)}</Field>
            <Field label={t("totalDown")}>{ibytes(m.netRecv)}</Field>
            <Field label={t("bootTime")} className="col-span-2 lg:col-span-1">
              {host.bootTime ? datetime(host.bootTime * 1000) : "—"}
            </Field>
            <Field label={t("lastReport")} className="col-span-2">
              {datetime(node.lastSeen)}
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
          options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
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
          <NodeLatency nodeId={node.id} ping={ping} />
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

// NodeLatency lists this server's own latency probes (filtered to its node id)
// inside the Network tab. Hidden entirely when there's nothing to show (e.g. a
// guest, who can't read the admin-only latency feed).
function NodeLatency({
  nodeId,
  ping,
}: {
  nodeId: string;
  ping: { tasks: PingTask[]; results: PingResult[] };
}) {
  const { t } = useI18n();
  const rows = ping.results
    .filter((r) => r.nodeId === nodeId)
    .map((r) => ({ r, task: ping.tasks.find((x) => x.id === r.taskId) }))
    .filter((x): x is { r: PingResult; task: PingTask } => Boolean(x.task))
    .sort((a, b) => a.task.name.localeCompare(b.task.name));

  if (rows.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 text-[15px] font-semibold tracking-tight">{t("ownLatency")}</div>
      <div className="divide-y divide-border">
        {rows.map(({ r, task }) => (
          <div key={task.id} className="flex items-center gap-3 py-2 text-sm">
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                task.enabled ? "bg-success" : "bg-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate font-medium" title={task.target}>
              {task.name}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{task.target}</span>
            </span>
            <span className="shrink-0 font-semibold tnum">
              {r.success ? (
                <span className={latColor(r.latencyMs)}>{r.latencyMs.toFixed(1)} ms</span>
              ) : (
                <span className="text-destructive">{t("timeout")}</span>
              )}
            </span>
            <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground tnum">
              {ago(r.ts)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
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
  if (range !== "realtime") {
    return RANGES.find((r) => r.key === range)!.xLabel;
  }
  if (points.length < 2) return "";
  const mins = Math.round((points[points.length - 1].ts - points[0].ts) / 60000);
  return mins > 0 ? `${mins}m` : "";
}
