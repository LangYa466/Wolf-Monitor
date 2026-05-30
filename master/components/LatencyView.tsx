"use client";

import { useEffect, useMemo, useState } from "react";
import type { PingResult, PingTask } from "@/lib/types";
import { ago } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;

export default function LatencyView() {
  const [tasks, setTasks] = useState<PingTask[]>([]);
  const [results, setResults] = useState<PingResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/ping-results", { cache: "no-store" });
        if (res.status === 401) {
          location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (alive) {
          setTasks(data.tasks);
          setResults(data.results);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "fetch failed");
      }
    }
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const byTask = useMemo(() => {
    const m = new Map<string, PingResult[]>();
    for (const r of results) {
      const arr = m.get(r.taskId) ?? [];
      arr.push(r);
      m.set(r.taskId, arr);
    }
    return m;
  }, [results]);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          Latency <span className="font-normal text-muted-foreground">/ 延迟监测</span>
        </h1>
        <div className="text-sm text-muted-foreground">
          <b className="text-foreground">{tasks.length}</b> monitors
        </div>
      </header>

      {error && (
        <Card className="mb-4 border-destructive/60">
          <CardContent className="p-4 text-sm text-destructive">⚠️ {error}</CardContent>
        </Card>
      )}

      {tasks.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">
          <p className="mb-2">No latency monitors yet.</p>
          <p className="text-sm">
            Add one under{" "}
            <a className="text-primary underline-offset-4 hover:underline" href="/settings">
              Settings → Latency monitors
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
          {tasks.map((t) => {
            const rows = (byTask.get(t.id) ?? []).sort((a, b) =>
              a.nodeId.localeCompare(b.nodeId),
            );
            return (
              <Card key={t.id}>
                <CardContent className="p-4">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 font-semibold">
                      <span
                        className={cn(
                          "h-2.5 w-2.5 shrink-0 rounded-full",
                          t.enabled ? "bg-success" : "bg-destructive",
                        )}
                      />
                      <span className="truncate" title={t.target}>
                        {t.name}
                      </span>
                    </div>
                    <Badge variant="muted">
                      {t.type.toUpperCase()} · {t.intervalSeconds}s
                    </Badge>
                  </div>
                  <div className="mb-3 text-xs text-muted-foreground">{t.target}</div>

                  {rows.length === 0 ? (
                    <div className="text-sm text-muted-foreground">waiting for samples…</div>
                  ) : (
                    <table className="w-full text-sm">
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.nodeId} className="border-b border-border last:border-0">
                            <td className="py-1 text-muted-foreground">{r.nodeId}</td>
                            <td className="py-1 text-right font-semibold tnum">
                              {r.success ? (
                                <span className={latColor(r.latencyMs)}>
                                  {r.latencyMs.toFixed(1)} ms
                                </span>
                              ) : (
                                <span className="text-destructive">timeout</span>
                              )}
                            </td>
                            <td className="w-16 py-1 text-right text-[11px] text-muted-foreground">
                              {ago(r.ts)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function latColor(ms: number): string {
  if (ms >= 250) return "text-destructive";
  if (ms >= 120) return "text-warning";
  return "text-success";
}
