"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NodeView } from "@/lib/types";
import type { HistoryPoint } from "@/lib/db";
import {
  datetime,
  flagUrl,
  ibytes,
  osBadge,
  pct,
  speed,
  uptime,
  uptimeCJK,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { MetricChart } from "@/components/Charts";
import { useI18n } from "@/lib/i18n";
import { ChevronLeft, ArrowUp, ArrowDown, LayoutDashboard, Radar, AlertTriangle } from "lucide-react";

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
        const found = (data.nodes as NodeView[]).find((n) => n.id === id) ?? null;
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

  const loadHistory = useCallback(async () => {
    const r = RANGES.find((x) => x.key === range)!;
    const qs =
      r.windowMs > 0 ? `?window=${r.windowMs}&limit=2000` : `?limit=120`;
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(id)}/history${qs}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setPoints(data.points ?? []);
    } catch {
      /* keep previous */
    }
  }, [id, range]);

  // Refetch on range change; for RealTime keep polling live.
  useEffect(() => {
    loadHistory();
    if (range !== "realtime") return;
    const t = setInterval(loadHistory, POLL_MS);
    return () => clearInterval(t);
  }, [loadHistory, range]);

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
  const netMax = niceMax(Math.max(m.netUpSpeed, m.netDownSpeed, ...netUp, ...netDown, 1));
  const tcpMax = niceMax(Math.max(m.tcpConns, ...tcp, 1));

  const cpuChart = (
    <MetricChart
      id="c-cpu"
      title="CPU"
      legend={<span>{pct(m.cpuUsage)}</span>}
      series={[{ data: cpu, color: C.blue }]}
      max={100}
      yLabels={["100%", "50%", "0%"]}
      xLeft={xLabel}
    />
  );
  const procChart = (
    <MetricChart
      id="c-proc"
      title={t("chProcesses")}
      legend={<span className="text-foreground">{m.procs}</span>}
      series={[{ data: procs, color: C.maroon, area: true }]}
      max={procsMax}
      yLabels={[String(procsMax), String(Math.round(procsMax / 2)), "0"]}
      xLeft={xLabel}
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
      series={[{ data: disk, color: C.green, area: true }]}
      max={100}
      yLabels={["100%", "50%", "0%"]}
      xLeft={xLabel}
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
        { data: mem, color: C.purple, area: true },
        { data: swap, color: C.cyan },
      ]}
      max={100}
      yLabels={["100%", "50%", "0%"]}
      xLeft={xLabel}
    />
  );
  const netChart = (
    <MetricChart
      id="c-net"
      title={t("chUpDown")}
      legend={
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-0.5 text-primary">
            <ArrowUp className="size-3" />
            {speed(m.netUpSpeed)}
          </span>
          <span className="inline-flex items-center gap-0.5 text-success">
            <ArrowDown className="size-3" />
            {speed(m.netDownSpeed)}
          </span>
        </span>
      }
      series={[
        { data: netUp, color: C.blue },
        { data: netDown, color: C.green },
      ]}
      max={netMax}
      yLabels={[speed(netMax), speed(netMax / 2), "0"]}
      xLeft={xLabel}
    />
  );
  const tcpChart = (
    <MetricChart
      id="c-tcp"
      title={t("chTcp")}
      legend={<span className="text-foreground">{m.tcpConns}</span>}
      series={[{ data: tcp, color: C.cyan, area: true }]}
      max={tcpMax}
      yLabels={[String(tcpMax), String(Math.round(tcpMax / 2)), "0"]}
      xLeft={xLabel}
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
            <span className="truncate">{host.hostname}</span>
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
              {node.country ? node.country.toUpperCase() : "—"}
            </Field>

            <Field label={t("system")} className="col-span-2 sm:col-span-2 lg:col-span-3">
              {osBadge(host.os)}
              {host.platformVersion ? ` ${host.platformVersion}` : ""}
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

      {/* tabs */}
      <div className="mb-4 flex justify-center">
        <div className="inline-flex rounded-md border border-border p-0.5">
          <TabBtn active={tab === "detail"} onClick={() => setTab("detail")}>
            {t("tabDetail")}
          </TabBtn>
          <TabBtn active={tab === "network"} onClick={() => setTab("network")}>
            {t("tabNetwork")}
          </TabBtn>
        </div>
      </div>

      {/* time range */}
      <div className="mb-5 flex flex-wrap justify-center gap-1">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              range === r.key
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      {points.length === 0 && (
        <p className="mb-4 text-center text-sm text-muted-foreground">
          {t("noHistory")}
          {range === "realtime" ? t("collecting") : ""}
        </p>
      )}

      {/* charts */}
      {tab === "detail" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {cpuChart}
          {procChart}
          {diskChart}
          {memChart}
          {netChart}
          {tcpChart}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {netChart}
          {tcpChart}
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-muted-foreground">
        Wolf-Monitor · {t("updatedEvery", { n: POLL_MS / 1000 })}
      </footer>
    </div>
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

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded px-4 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
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
