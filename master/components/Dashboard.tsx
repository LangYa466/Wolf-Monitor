"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NodeView } from "@/lib/types";
import { datetime, flagUrl, ibytes, pct, speed, uptime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { LayoutGrid, List, ArrowUp, ArrowDown, ArrowUpDown, LayoutDashboard, Radar, AlertTriangle } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented";
import { SelectMenu } from "@/components/ui/select-menu";

const POLL_MS = 3000;
const SORT_KEY = "wolf_sort";
const SORT_DIR_KEY = "wolf_sort_dir";
const VIEW_KEY = "wolf_view";
const REGION_KEY = "wolf_region";
const STATUS_KEY = "wolf_status";

type SortMode =
  | "custom"
  | "name"
  | "cpu"
  | "mem"
  | "country"
  | "status"
  | "netUp"
  | "netDown"
  | "netSent"
  | "netRecv";
type ViewMode = "grid" | "list";
type SortDir = "desc" | "asc";
type Region = "all" | "cn" | "oversea";
type StatusFilter = "all" | "online" | "offline";

export default function Dashboard({
  initial,
  dbError,
  isPublic = false,
}: {
  initial: NodeView[];
  dbError: string | null;
  isPublic?: boolean;
}) {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<NodeView[]>(initial);
  const [error, setError] = useState<string | null>(dbError);
  // Hide the error banner until the first client poll has settled — a
  // transient SSR-side DB hiccup (cold-start, brief pool exhaustion) shouldn't
  // flash red while the first /api/nodes request is still in flight.
  const [polled, setPolled] = useState(false);
  const [sort, setSort] = useState<SortMode>("custom");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [view, setView] = useState<ViewMode>("grid");
  const [region, setRegion] = useState<Region>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  // Start at 0 (renders "—") so SSR and first client render agree on the
  // clock display. datetime() uses local timezone (getHours/etc) so any non-
  // zero seed would diverge between UTC server and the user's browser TZ,
  // tripping React #418 hydration mismatch.
  const [now, setNow] = useState<number>(0);

  // Live updates + 1s clock tick.
  useEffect(() => {
    setSort((localStorage.getItem(SORT_KEY) as SortMode) || "custom");
    setSortDir((localStorage.getItem(SORT_DIR_KEY) as SortDir) || "desc");
    setView((localStorage.getItem(VIEW_KEY) as ViewMode) || "grid");
    setRegion((localStorage.getItem(REGION_KEY) as Region) || "all");
    setStatus((localStorage.getItem(STATUS_KEY) as StatusFilter) || "all");
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
        if (alive) {
          setNodes(data.nodes);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (alive) setPolled(true);
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
  }, []);

  function persist<T extends string>(setter: (v: T) => void, key: string, v: T) {
    setter(v);
    localStorage.setItem(key, v);
  }

  const online = nodes.filter((n) => n.online).length;
  const offline = nodes.length - online;

  // Aggregate traffic for the avatar card.
  const totals = useMemo(() => {
    let up = 0,
      down = 0,
      upSpeed = 0,
      downSpeed = 0;
    for (const n of nodes) {
      up += n.metrics.netSent || 0;
      down += n.metrics.netRecv || 0;
      if (n.online) {
        upSpeed += n.metrics.netUpSpeed || 0;
        downSpeed += n.metrics.netDownSpeed || 0;
      }
    }
    return { up, down, upSpeed, downSpeed };
  }, [nodes]);

  const filtered = useMemo(() => {
    let arr = nodes;
    if (region === "cn") arr = arr.filter((n) => n.country === "cn");
    else if (region === "oversea") arr = arr.filter((n) => n.country && n.country !== "cn");
    if (status === "online") arr = arr.filter((n) => n.online);
    else if (status === "offline") arr = arr.filter((n) => !n.online);
    return sortNodes(arr, sort, sortDir);
  }, [nodes, sort, sortDir, region, status]);

  return (
    <div>
      {/* ── Header: 概览 + live clock, avatar / traffic card ───────────────── */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <LayoutDashboard className="size-6 text-primary" /> {t("overview")}
            {isPublic && (
              <span
                className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground"
                title={t("publicTitle")}
              >
                {t("publicBadge")}
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground tnum">
            {t("currentTime")} <span className="text-foreground">{now ? clock(now) : "—"}</span>
          </p>
        </div>

        <div className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 sm:w-auto sm:justify-start">
          <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs tnum">
            <Traffic dir="up" label={t("totalUp")} value={ibytes(totals.up)} />
            <Traffic dir="down" label={t("totalDown")} value={ibytes(totals.down)} />
            <Traffic dir="up" label={t("upRate")} value={speed(totals.upSpeed)} live />
            <Traffic dir="down" label={t("downRate")} value={speed(totals.downSpeed)} live />
          </div>
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/30 to-primary/5">
            <Radar className="size-6 text-primary" />
          </div>
        </div>
      </div>

      {/* ── Summary cards (also act as a status filter) ────────────────────── */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          label={t("totalServers")}
          value={nodes.length}
          dot="bg-primary"
          active={status === "all"}
          onClick={() => persist(setStatus, STATUS_KEY, "all")}
        />
        <SummaryCard
          label={t("onlineServers")}
          value={online}
          dot="bg-success"
          active={status === "online"}
          onClick={() => persist(setStatus, STATUS_KEY, "online")}
        />
        <SummaryCard
          label={t("offlineServers")}
          value={offline}
          dot={offline ? "bg-destructive" : "bg-muted-foreground"}
          active={status === "offline"}
          onClick={() => persist(setStatus, STATUS_KEY, "offline")}
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SegmentedControl
          variant="card"
          size="sm"
          value={view}
          onChange={(v) => persist(setView, VIEW_KEY, v)}
          options={[
            { value: "grid", icon: <LayoutGrid />, title: t("viewGrid"), ariaLabel: t("viewGrid") },
            { value: "list", icon: <List />, title: t("viewList"), ariaLabel: t("viewList") },
          ]}
        />

        <SegmentedControl
          value={region}
          onChange={(v) => persist(setRegion, REGION_KEY, v)}
          options={[
            { value: "all", label: t("regAll") },
            { value: "cn", label: t("regCN") },
            { value: "oversea", label: t("regOversea") },
          ]}
        />

        <div className="flex-1" />

        <SelectMenu
          ariaLabel={t("sort")}
          value={sort}
          onChange={(v) => persist(setSort, SORT_KEY, v)}
          leading={<ArrowUpDown className="text-muted-foreground" />}
          options={[
            { value: "custom", label: t("sortDefault") },
            { value: "name", label: t("sortName") },
            { value: "cpu", label: t("sortCpu") },
            { value: "mem", label: t("sortMem") },
            { value: "country", label: t("sortCountry") },
            { value: "status", label: t("sortStatus") },
            { value: "netUp", label: t("sortNetUp") },
            { value: "netDown", label: t("sortNetDown") },
            { value: "netSent", label: t("sortNetSent") },
            { value: "netRecv", label: t("sortNetRecv") },
          ]}
        />
        <button
          type="button"
          aria-label={sortDir === "desc" ? t("sortDirDesc") : t("sortDirAsc")}
          title={sortDir === "desc" ? t("sortDirDesc") : t("sortDirAsc")}
          onClick={() =>
            persist(setSortDir, SORT_DIR_KEY, sortDir === "desc" ? "asc" : "desc")
          }
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
        >
          {sortDir === "desc" ? <ArrowDown className="size-4" /> : <ArrowUp className="size-4" />}
        </button>
      </div>

      {error && polled && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">
          {nodes.length === 0 ? (
            <>
              <p className="mb-2">{t("noNodes")}</p>
              <p className="text-sm">
                {t("startNodeHint")}
                <br />
                <code className="mt-2 inline-block rounded bg-muted px-2 py-1 text-primary">
                  ./wolf-node -e {hostHint()} -t YOUR_TOKEN
                </code>
              </p>
            </>
          ) : (
            <p>{t("noNodesInCategory")}</p>
          )}
        </div>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {filtered.map((n) => (
            <ServerRow key={n.id} node={n} />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {filtered.map((n, i) => (
            <ServerListRow key={n.id} node={n} first={i === 0} />
          ))}
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

// ── pieces ─────────────────────────────────────────────────────────────────

function clock(ms: number): string {
  return datetime(ms).slice(11); // HH:MM:SS
}

function Traffic({
  dir,
  label,
  value,
  live = false,
}: {
  dir: "up" | "down";
  label: string;
  value: string;
  live?: boolean;
}) {
  const Arrow = dir === "up" ? ArrowUp : ArrowDown;
  return (
    <div className="flex items-center gap-1.5">
      <Arrow className={cn("size-3", dir === "up" ? "text-primary" : "text-success")} />
      <span className="text-muted-foreground">{label}</span>
      {/* Fixed-width right-aligned value keeps the two-column layout from
          shifting as totals tick up. */}
      <span
        className={cn(
          "ml-auto min-w-[84px] text-right font-semibold tabular-nums",
          live && "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  dot,
  active,
  onClick,
}: {
  label: string;
  value: number;
  dot: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-between rounded-md border bg-card px-4 py-3.5 text-left transition-colors",
        active
          ? "border-primary/70 ring-1 ring-primary/40"
          : "border-border hover:border-muted-foreground/40",
      )}
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className={cn("h-2 w-2 rounded-full", dot)} />
        {label}
      </span>
      <span className={cn("text-2xl font-bold tnum", active && "text-primary")}>{value}</span>
    </button>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "h-2.5 w-2.5 shrink-0 rounded-full",
        online
          ? "bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.15)]"
          : "bg-destructive shadow-[0_0_0_3px_hsl(var(--destructive)/0.12)]",
      )}
    />
  );
}

function Flag({ cc }: { cc: string | null }) {
  if (!cc) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={flagUrl(cc)}
      alt={cc}
      title={cc.toUpperCase()}
      width={20}
      height={15}
      className="shrink-0 rounded-[2px]"
    />
  );
}

function pctColor(p: number): string {
  if (p >= 90) return "text-destructive";
  if (p >= 70) return "text-warning";
  return "text-foreground";
}

// Compact metric cell: tiny label above a value.
// Each metric Cell is a fixed-width column (~68px) so labels and values line
// up across every row regardless of value length ("4.0%" vs "100.0%",
// "1.57K/s" vs "195.60K/s"). Without the fixed width grids/flex auto-size to
// content and the columns jitter row-by-row.
function Cell({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="w-[68px] shrink-0 text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("truncate text-[13px] font-semibold tabular-nums", className)}>{value}</div>
    </div>
  );
}

// One combined up/down cell — frees the row width that the separate UP and
// DOWN cells were eating so the server name has room to breathe.
function NetCell({ up, down }: { up: number; down: number }) {
  const { t } = useI18n();
  return (
    <div className="w-[88px] shrink-0 text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("mNet")}</div>
      <div className="flex flex-col items-center gap-0 text-[11px] font-semibold leading-tight tabular-nums">
        <span className="inline-flex items-center gap-0.5">
          <ArrowUp className="size-2.5 text-primary" /> {speed(up)}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <ArrowDown className="size-2.5 text-success" /> {speed(down)}
        </span>
      </div>
    </div>
  );
}

// Cumulative bytes since the agent started — list view only. Grid cards omit
// it to keep the card from getting wider; users who want to rank by it sort
// the dashboard via the Total sort modes.
function TotalCell({ sent, recv }: { sent: number; recv: number }) {
  const { t } = useI18n();
  return (
    <div className="w-[88px] shrink-0 text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("mTotal")}</div>
      <div className="flex flex-col items-center gap-0 text-[11px] font-semibold leading-tight tabular-nums">
        <span className="inline-flex items-center gap-0.5">
          <ArrowUp className="size-2.5 text-primary" /> {ibytes(sent, 1)}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <ArrowDown className="size-2.5 text-success" /> {ibytes(recv, 1)}
        </span>
      </div>
    </div>
  );
}

// Grid-view card: one server as a horizontal row of identity + 5 metric cells.
function ServerRow({ node }: { node: NodeView }) {
  const { t } = useI18n();
  const { host, metrics: m } = node;
  return (
    <Link
      href={`/server/${encodeURIComponent(node.opaqueId)}`}
      className="flex flex-col gap-2.5 rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-muted-foreground/40 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 items-center gap-3 sm:flex-1">
        <StatusDot online={node.online} />
        <Flag cc={node.country} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold" title={host.hostname}>
            {node.name?.trim() || host.hostname}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {node.online ? uptime(m.uptime) : t("offline")} · {host.arch}
          </div>
        </div>
      </div>
      <div className="flex gap-x-2 sm:shrink-0 sm:gap-x-4">
        <Cell label={t("mCpu")} value={pct(m.cpuUsage)} className={pctColor(m.cpuUsage)} />
        <Cell label={t("mMem")} value={pct(m.memPercent)} className={pctColor(m.memPercent)} />
        <Cell label={t("mStorage")} value={pct(m.diskPercent)} className={pctColor(m.diskPercent)} />
        <NetCell up={m.netUpSpeed} down={m.netDownSpeed} />
      </div>
    </Link>
  );
}

// List-view row: denser single-line layout for many servers.
function ServerListRow({ node, first }: { node: NodeView; first: boolean }) {
  const { t } = useI18n();
  const { host, metrics: m } = node;
  return (
    <Link
      href={`/server/${encodeURIComponent(node.opaqueId)}`}
      className={cn(
        "flex flex-col gap-2.5 bg-card px-4 py-2.5 transition-colors hover:bg-secondary/40 sm:flex-row sm:items-center sm:gap-3",
        !first && "border-t border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-3 sm:w-56 sm:shrink-0">
        <StatusDot online={node.online} />
        <Flag cc={node.country} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium" title={host.hostname}>
            {node.name?.trim() || host.hostname}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {node.online ? uptime(m.uptime) : t("offline")} · {host.arch}
          </div>
        </div>
      </div>
      <div className="flex gap-x-2 sm:flex-1 sm:justify-end sm:gap-x-6">
        <Cell label={t("mCpu")} value={pct(m.cpuUsage)} className={pctColor(m.cpuUsage)} />
        <Cell label={t("mMem")} value={pct(m.memPercent)} className={pctColor(m.memPercent)} />
        <Cell label={t("mStorage")} value={pct(m.diskPercent)} className={pctColor(m.diskPercent)} />
        <NetCell up={m.netUpSpeed} down={m.netDownSpeed} />
        <TotalCell sent={m.netSent} recv={m.netRecv} />
      </div>
    </Link>
  );
}

function sortNodes(nodes: NodeView[], mode: SortMode, dir: SortDir = "desc"): NodeView[] {
  // Build comparators in their natural orientation (alphabetical / online-first
  // / largest-first for metrics, custom sortOrder ascending) and let the dir
  // flag invert them. desc on a metric = biggest first; asc = smallest first.
  const arr = [...nodes];
  let cmp: (a: NodeView, b: NodeView) => number;
  switch (mode) {
    case "name":
      cmp = (a, b) => a.host.hostname.localeCompare(b.host.hostname);
      break;
    case "cpu":
      cmp = (a, b) => b.metrics.cpuUsage - a.metrics.cpuUsage;
      break;
    case "mem":
      cmp = (a, b) => b.metrics.memPercent - a.metrics.memPercent;
      break;
    case "country":
      cmp = (a, b) => (a.country ?? "zz").localeCompare(b.country ?? "zz");
      break;
    case "status":
      cmp = (a, b) => Number(b.online) - Number(a.online);
      break;
    case "netUp":
      cmp = (a, b) => b.metrics.netUpSpeed - a.metrics.netUpSpeed;
      break;
    case "netDown":
      cmp = (a, b) => b.metrics.netDownSpeed - a.metrics.netDownSpeed;
      break;
    case "netSent":
      cmp = (a, b) => b.metrics.netSent - a.metrics.netSent;
      break;
    case "netRecv":
      cmp = (a, b) => b.metrics.netRecv - a.metrics.netRecv;
      break;
    default:
      cmp = (a, b) => a.sortOrder - b.sortOrder;
  }
  const sign = dir === "asc" ? -1 : 1;
  return arr.sort((a, b) => sign * cmp(a, b));
}

function hostHint(): string {
  if (typeof window === "undefined") return "wss://your-master";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}
