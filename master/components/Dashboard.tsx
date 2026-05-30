"use client";

import { useEffect, useMemo, useState } from "react";
import type { NodeView } from "@/lib/types";
import { ago, bps, bytes, flagUrl, osBadge, pct, uptime } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;
const SORT_KEY = "wolf_sort";

type SortMode = "custom" | "name" | "cpu" | "mem" | "country" | "status";

export default function Dashboard({
  initial,
  dbError,
  isPublic = false,
}: {
  initial: NodeView[];
  dbError: string | null;
  isPublic?: boolean;
}) {
  const [nodes, setNodes] = useState<NodeView[]>(initial);
  const [error, setError] = useState<string | null>(dbError);
  const [sort, setSort] = useState<SortMode>("custom");
  const [, force] = useState(0);

  useEffect(() => {
    setSort((localStorage.getItem(SORT_KEY) as SortMode) || "custom");
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/nodes", { cache: "no-store" });
        // Public access was revoked (e.g. admin turned it off) → go sign in.
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
      }
    }
    const pollTimer = setInterval(poll, POLL_MS);
    const tickTimer = setInterval(() => alive && force((n) => n + 1), 1000);
    poll();
    return () => {
      alive = false;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
    };
  }, []);

  function changeSort(v: SortMode) {
    setSort(v);
    localStorage.setItem(SORT_KEY, v);
  }

  const sorted = useMemo(() => sortNodes(nodes, sort), [nodes, sort]);
  const online = nodes.filter((n) => n.online).length;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          Servers <span className="font-normal text-muted-foreground">/ live</span>
          {isPublic && (
            <Badge variant="muted" className="font-normal" title="访客视图 · 已隐藏 IP 等敏感信息">
              public view · IP hidden
            </Badge>
          )}
        </h1>
        <div className="flex items-center gap-4 text-sm text-muted-foreground tnum">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-[pulse_1.6s_ease-in-out_infinite] rounded-full bg-success" />
            live
          </span>
          <span>
            <b className="text-foreground">{online}</b> online
          </span>
          <span>
            <b className="text-foreground">{nodes.length}</b> total
          </span>
          <Select
            aria-label="sort"
            className="h-8 w-32"
            value={sort}
            onChange={(e) => changeSort(e.target.value as SortMode)}
          >
            <option value="custom">Sort: Custom</option>
            <option value="name">Sort: Name</option>
            <option value="cpu">Sort: CPU</option>
            <option value="mem">Sort: Memory</option>
            <option value="country">Sort: Country</option>
            <option value="status">Sort: Status</option>
          </Select>
        </div>
      </header>

      {error && (
        <Card className="mb-4 border-destructive/60">
          <CardContent className="p-4 text-sm text-destructive">⚠️ {error}</CardContent>
        </Card>
      )}

      {nodes.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">
          <p className="mb-2">No nodes reporting yet.</p>
          <p className="text-sm">
            Start a node pointing at this master:
            <br />
            <code className="mt-2 inline-block rounded bg-muted px-2 py-1 text-primary">
              ./wolf-node -e {hostHint()} -t YOUR_TOKEN
            </code>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
          {sorted.map((n) => (
            <NodeCard key={n.id} node={n} />
          ))}
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-muted-foreground">
        Wolf-Monitor · polling every {POLL_MS / 1000}s
      </footer>
    </div>
  );
}

function sortNodes(nodes: NodeView[], mode: SortMode): NodeView[] {
  const arr = [...nodes];
  switch (mode) {
    case "name":
      return arr.sort((a, b) => a.host.hostname.localeCompare(b.host.hostname));
    case "cpu":
      return arr.sort((a, b) => b.metrics.cpuUsage - a.metrics.cpuUsage);
    case "mem":
      return arr.sort((a, b) => b.metrics.memPercent - a.metrics.memPercent);
    case "country":
      return arr.sort((a, b) => (a.country ?? "zz").localeCompare(b.country ?? "zz"));
    case "status":
      return arr.sort((a, b) => Number(b.online) - Number(a.online));
    default:
      return arr.sort((a, b) => a.sortOrder - b.sortOrder);
  }
}

function hostHint(): string {
  if (typeof window === "undefined") return "wss://your-master";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

function barColor(p: number): string {
  if (p >= 90) return "bg-destructive";
  if (p >= 70) return "bg-warning";
  return "bg-primary";
}

function Metric({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex justify-between text-[12.5px] tnum">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold">{value}</span>
      </div>
      <Progress value={percent} indicatorClassName={barColor(percent)} />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 tnum">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-semibold">{v}</span>
    </div>
  );
}

function NodeCard({ node }: { node: NodeView }) {
  const { host, metrics: m } = node;
  return (
    <Card className="transition-colors hover:border-muted-foreground/30">
      <CardContent className="p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                node.online
                  ? "bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.15)]"
                  : "bg-destructive shadow-[0_0_0_3px_hsl(var(--destructive)/0.12)]",
              )}
            />
            {node.country && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={flagUrl(node.country)}
                alt={node.country}
                title={node.country.toUpperCase()}
                width={20}
                height={15}
                className="shrink-0 rounded-[2px]"
              />
            )}
            <span className="truncate" title={host.hostname}>
              {host.hostname}
            </span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {node.online ? uptime(m.uptime) : ago(node.lastSeen)}
          </span>
        </div>

        <div className="mb-3.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{osBadge(host.os)}</span>
          <span className="opacity-40">·</span>
          <span>{host.arch}</span>
          <span className="opacity-40">·</span>
          <span title={host.cpuModel}>{host.cpuCores} cores</span>
          {node.country && (
            <>
              <span className="opacity-40">·</span>
              <span className="uppercase">{node.country}</span>
            </>
          )}
        </div>

        <Metric label="CPU" value={pct(m.cpuUsage)} percent={m.cpuUsage} />
        <Metric
          label="Memory"
          value={`${bytes(m.memUsed)} / ${bytes(host.memTotal)}`}
          percent={m.memPercent}
        />
        <Metric
          label="Disk"
          value={`${bytes(m.diskUsed)} / ${bytes(host.diskTotal)}`}
          percent={m.diskPercent}
        />

        <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3.5 text-[12.5px]">
          <Stat k="↑ net" v={bps(m.netUpSpeed)} />
          <Stat k="↓ net" v={bps(m.netDownSpeed)} />
          <Stat k="disk R" v={bps(m.diskReadSpeed)} />
          <Stat k="disk W" v={bps(m.diskWriteSpeed)} />
          <Stat k="load" v={m.load1.toFixed(2)} />
          <Stat k="TCP / proc" v={`${m.tcpConns} / ${m.procs}`} />
        </div>
      </CardContent>
    </Card>
  );
}
