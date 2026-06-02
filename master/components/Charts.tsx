"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { datetime } from "@/lib/format";

// A single plotted series. `area` fills the region under the line with a
// vertical gradient of `color`; otherwise it's a plain stroked line. `name` and
// `format` drive the hover tooltip (what each series is called and how its
// value reads).
export type Series = {
  data: number[];
  color: string; // CSS color (hsl(var(--x)) or hex)
  area?: boolean;
  name?: string;
  format?: (v: number) => string;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Low-level responsive SVG plot. Uses a fixed 0..100 coordinate box stretched
// to the container with preserveAspectRatio="none"; strokes keep their pixel
// width via vector-effect so lines stay crisp at any width. Renders 0/50/100%
// horizontal gridlines. Hover markers (guide line, dots, tooltip) live in the
// HTML overlay above this SVG so they aren't distorted by the non-uniform scale.
function Plot({
  series,
  max,
  gradientId,
  height = 150,
}: {
  series: Series[];
  max: number;
  gradientId: string;
  height?: number;
}) {
  const W = 100;
  const H = 100;
  const safeMax = max > 0 ? max : 1;

  function pointsFor(data: number[]): { x: number; y: number }[] {
    const n = data.length;
    if (n === 0) return [];
    if (n === 1) {
      const y = H - (clamp(data[0], 0, safeMax) / safeMax) * H;
      return [
        { x: 0, y },
        { x: W, y },
      ];
    }
    return data.map((v, i) => ({
      x: (i / (n - 1)) * W,
      y: H - (clamp(v, 0, safeMax) / safeMax) * H,
    }));
  }

  function linePath(pts: { x: number; y: number }[]): string {
    if (!pts.length) return "";
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  }
  function areaPath(pts: { x: number; y: number }[]): string {
    if (!pts.length) return "";
    return (
      `M${pts[0].x},${H} ` +
      pts.map((p) => `L${p.x},${p.y}`).join(" ") +
      ` L${pts[pts.length - 1].x},${H} Z`
    );
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className="block"
    >
      <defs>
        {series.map((s, i) =>
          s.area ? (
            <linearGradient key={i} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
            </linearGradient>
          ) : null,
        )}
      </defs>

      {[0, 0.5, 1].map((g) => (
        <line
          key={g}
          x1="0"
          x2={W}
          y1={H - g * H}
          y2={H - g * H}
          stroke="hsl(var(--border))"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          strokeDasharray={g === 0 ? undefined : "3 3"}
          opacity={0.6}
        />
      ))}

      {series.map((s, i) => {
        const pts = pointsFor(s.data);
        return (
          <g key={i}>
            {s.area && <path d={areaPath(pts)} fill={`url(#${gradientId}-${i})`} stroke="none" />}
            <path
              d={linePath(pts)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}

// A chart card for the per-server detail grid: a title, one or more legend
// values top-right, the plot with left-edge y-axis labels, and x labels. Hover
// (or touch-drag) reveals a guide line, per-series dots and a tooltip with the
// exact values at the sampled timestamp.
export function MetricChart({
  title,
  legend,
  series,
  max,
  yLabels,
  xLeft = "3m",
  xRight = "0s",
  id,
  className,
  timestamps,
}: {
  title: React.ReactNode;
  legend?: React.ReactNode;
  series: Series[];
  max: number;
  yLabels: [string, string, string]; // top, mid, bottom
  xLeft?: string;
  xRight?: string;
  id: string;
  className?: string;
  timestamps?: number[];
}) {
  const plotRef = React.useRef<HTMLDivElement>(null);
  const [idx, setIdx] = React.useState<number | null>(null);
  const n = series[0]?.data.length ?? 0;
  const safeMax = max > 0 ? max : 1;

  const pick = React.useCallback(
    (clientX: number) => {
      const el = plotRef.current;
      if (!el || n === 0) return;
      const rect = el.getBoundingClientRect();
      const rel = clamp((clientX - rect.left) / rect.width, 0, 1);
      setIdx(Math.round(rel * (n - 1)));
    },
    [n],
  );

  const xPct = idx == null ? 0 : n > 1 ? (idx / (n - 1)) * 100 : 50;
  const tipPct = clamp(xPct, 14, 86);
  const showTip = idx != null && n > 0;

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="text-[15px] font-semibold tracking-tight">{title}</div>
        <div className="text-right text-xs text-muted-foreground tnum">{legend}</div>
      </div>

      <div
        ref={plotRef}
        className="relative cursor-crosshair touch-none"
        onMouseMove={(e) => pick(e.clientX)}
        onMouseLeave={() => setIdx(null)}
        onTouchStart={(e) => pick(e.touches[0].clientX)}
        onTouchMove={(e) => pick(e.touches[0].clientX)}
        onTouchEnd={() => setIdx(null)}
      >
        {/* y-axis labels overlaid on the left edge */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex flex-col justify-between text-[10px] text-muted-foreground tnum">
          <span>{yLabels[0]}</span>
          <span>{yLabels[1]}</span>
          <span>{yLabels[2]}</span>
        </div>

        <Plot series={series} max={max} gradientId={id} />

        {showTip && (
          <>
            {/* vertical guide */}
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-muted-foreground/50"
              style={{ left: `${xPct}%` }}
            />
            {/* per-series dots */}
            {series.map((s, i) => {
              const v = s.data[idx!] ?? 0;
              const yPct = (1 - clamp(v, 0, safeMax) / safeMax) * 100;
              return (
                <div
                  key={i}
                  className="pointer-events-none absolute z-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background"
                  style={{ left: `${xPct}%`, top: `${yPct}%`, background: s.color }}
                />
              );
            })}
            {/* tooltip */}
            <div
              className="pointer-events-none absolute top-1 z-20 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-lg"
              style={{ left: `${tipPct}%` }}
            >
              {timestamps && timestamps[idx!] != null && (
                <div className="mb-1 whitespace-nowrap text-[10px] text-muted-foreground tnum">
                  {datetime(timestamps[idx!]).slice(5)}
                </div>
              )}
              {series.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 whitespace-nowrap text-[11px] tnum"
                >
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  {s.name && <span className="text-muted-foreground">{s.name}</span>}
                  <span className="ml-auto font-semibold">
                    {(s.format ?? ((v: number) => String(v)))(s.data[idx!] ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tnum">
        <span>{xLeft}</span>
        <span>{xRight}</span>
      </div>
    </div>
  );
}

// BandwidthChart renders a Grafana-style "Network Bandwidth Usage" panel:
// upload bars rise from a centered zero baseline, download bars drop. Each
// half computes its own nice axis bound (so an asymmetric busy-download host
// reads cleanly), the zero line is the only solid gridline, others dashed,
// and the bottom axis carries ~8 evenly-spaced HH:MM ticks.
export function BandwidthChart({
  title,
  legend,
  up,
  down,
  timestamps,
  id: _id,
  className,
  fmt,
  height = 220,
}: {
  title: React.ReactNode;
  legend?: React.ReactNode;
  up: number[];
  down: number[];
  timestamps?: number[];
  id: string;
  className?: string;
  fmt: (v: number) => string;
  height?: number;
}) {
  const plotRef = React.useRef<HTMLDivElement>(null);
  const rafRef = React.useRef<number | null>(null);
  const pendingX = React.useRef<number | null>(null);
  const [idx, setIdx] = React.useState<number | null>(null);

  // Grafana defaults: cool color for transmitted (up), warm for received (down).
  const upColor = "hsl(190 95% 55%)"; // cyan
  const downColor = "hsl(28 95% 58%)"; // orange

  const W = 100;
  const H = 100;

  // Everything that depends only on the data (not on hover idx) — bar paths,
  // axis bounds, gridlines, time ticks — is computed once per data change.
  // Critical: 30d range can hand us 2000 samples; collapsing 4000 individual
  // <line> elements into two <path>s is what keeps hover from stuttering.
  const geom = React.useMemo(() => {
    const n = Math.max(up.length, down.length);
    let upPeak = 0;
    let downPeak = 0;
    for (let i = 0; i < up.length; i++) if (up[i] > upPeak) upPeak = up[i];
    for (let i = 0; i < down.length; i++) if (down[i] > downPeak) downPeak = down[i];
    const upMax = niceBound(Math.max(1, upPeak));
    const downMax = niceBound(Math.max(1, downPeak));
    const total = upMax + downMax;
    const mid = (upMax / total) * H;

    const xFor = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
    const yUp = (v: number) => mid - (clamp(v, 0, upMax) / upMax) * mid;
    const yDown = (v: number) => mid + (clamp(v, 0, downMax) / downMax) * (H - mid);

    // Each bar is a sub-path "M x mid V y" — one big path string per side, two
    // SVG nodes total, instead of one node per sample.
    let upPath = "";
    for (let i = 0; i < up.length; i++) {
      const v = up[i];
      if (v > 0) {
        const x = xFor(i).toFixed(3);
        const y = yUp(v).toFixed(3);
        upPath += `M${x} ${mid.toFixed(3)}V${y}`;
      }
    }
    let downPath = "";
    for (let i = 0; i < down.length; i++) {
      const v = down[i];
      if (v > 0) {
        const x = xFor(i).toFixed(3);
        const y = yDown(v).toFixed(3);
        downPath += `M${x} ${mid.toFixed(3)}V${y}`;
      }
    }

    const yStep = niceStep(total / 6);
    const yTicks: { val: number; y: number }[] = [{ val: 0, y: mid }];
    for (let v = yStep; v <= upMax + 0.0001; v += yStep) {
      yTicks.push({ val: v, y: yUp(v) });
    }
    for (let v = yStep; v <= downMax + 0.0001; v += yStep) {
      yTicks.push({ val: -v, y: yDown(v) });
    }

    const xTicks: { i: number; label: string }[] = [];
    if (timestamps && timestamps.length > 0 && n > 0) {
      const last = Math.min(n, timestamps.length);
      const count = Math.min(8, Math.max(2, last));
      for (let k = 0; k < count; k++) {
        const i = Math.round((k / (count - 1)) * (last - 1));
        const t = timestamps[i];
        if (t == null) continue;
        const d = new Date(t);
        const p = (x: number) => String(x).padStart(2, "0");
        xTicks.push({ i, label: `${p(d.getHours())}:${p(d.getMinutes())}` });
      }
    }

    return { n, upMax, downMax, mid, upPath, downPath, yTicks, xTicks, yUp, yDown };
  }, [up, down, timestamps]);

  const { n, mid, upPath, downPath, yTicks, xTicks, yUp, yDown } = geom;

  // Hover handler — coalesces successive mousemove samples onto the next
  // animation frame so we re-render at most ~60 Hz even under a fast drag.
  const pick = React.useCallback((clientX: number) => {
    pendingX.current = clientX;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const x = pendingX.current;
      pendingX.current = null;
      const el = plotRef.current;
      if (x == null || !el || n === 0) return;
      const rect = el.getBoundingClientRect();
      const rel = clamp((x - rect.left) / rect.width, 0, 1);
      setIdx(Math.round(rel * (n - 1)));
    });
  }, [n]);

  React.useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const xPct = idx == null ? 0 : n > 1 ? (idx / (n - 1)) * 100 : 50;
  const tipPct = clamp(xPct, 14, 86);
  const showTip = idx != null && n > 0;

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card/60 px-3 pb-2 pt-3 text-card-foreground",
        className,
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium tracking-tight text-muted-foreground">
          <span>{title}</span>
          <Info className="size-3 opacity-60" />
        </div>
        <div className="text-right text-[11px] text-muted-foreground tnum">{legend}</div>
      </div>

      <div className="flex">
        {/* y-axis label gutter — absolutely positioned ticks aligned to gridlines */}
        <div
          className="pointer-events-none relative w-12 shrink-0 text-[10px] text-muted-foreground tnum"
          style={{ height }}
        >
          {yTicks.map((tk, k) => (
            <span
              key={k}
              className="absolute right-1 -translate-y-1/2 whitespace-nowrap"
              style={{ top: `${tk.y}%` }}
            >
              {tk.val === 0 ? "0 B/s" : tk.val > 0 ? fmt(tk.val) : `-${fmt(-tk.val)}`}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative flex-1 cursor-crosshair touch-none"
          onMouseMove={(e) => pick(e.clientX)}
          onMouseLeave={() => setIdx(null)}
          onTouchStart={(e) => pick(e.touches[0].clientX)}
          onTouchMove={(e) => pick(e.touches[0].clientX)}
          onTouchEnd={() => setIdx(null)}
        >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          width="100%"
          height={height}
          className="block"
        >
          {/* gridlines at each y tick — zero solid, others dashed and faint */}
          {yTicks.map((tk, k) => {
            const isZero = tk.val === 0;
            return (
              <line
                key={k}
                x1="0"
                x2={W}
                y1={tk.y}
                y2={tk.y}
                stroke="hsl(var(--border))"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={isZero ? undefined : "2 4"}
                opacity={isZero ? 0.85 : 0.35}
              />
            );
          })}

          {/* All upload bars collapsed into one path — orders-of-magnitude
              cheaper to diff/render than per-sample <line> elements when the
              30-day range hands us thousands of points. */}
          {upPath && (
            <path
              d={upPath}
              fill="none"
              stroke={upColor}
              strokeWidth={0.9}
              strokeLinecap="butt"
              vectorEffect="non-scaling-stroke"
              opacity={0.95}
            />
          )}
          {downPath && (
            <path
              d={downPath}
              fill="none"
              stroke={downColor}
              strokeWidth={0.9}
              strokeLinecap="butt"
              vectorEffect="non-scaling-stroke"
              opacity={0.95}
            />
          )}
        </svg>

        {showTip && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-muted-foreground/40"
              style={{ left: `${xPct}%` }}
            />
            <div
              className="pointer-events-none absolute z-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background"
              style={{
                left: `${xPct}%`,
                top: `${yUp(up[idx!] ?? 0)}%`,
                background: upColor,
              }}
            />
            <div
              className="pointer-events-none absolute z-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background"
              style={{
                left: `${xPct}%`,
                top: `${yDown(down[idx!] ?? 0)}%`,
                background: downColor,
              }}
            />
            <div
              className="pointer-events-none absolute top-1 z-20 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-lg"
              style={{ left: `${tipPct}%` }}
            >
              {timestamps && timestamps[idx!] != null && (
                <div className="mb-1 whitespace-nowrap text-[10px] text-muted-foreground tnum">
                  {datetime(timestamps[idx!]).slice(5)}
                </div>
              )}
              <div className="flex items-center gap-2 whitespace-nowrap text-[11px] tnum">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: upColor }} />
                <span className="text-muted-foreground">Transmit</span>
                <span className="ml-auto font-semibold">{fmt(up[idx!] ?? 0)}</span>
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap text-[11px] tnum">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: downColor }} />
                <span className="text-muted-foreground">Receive</span>
                <span className="ml-auto font-semibold">{fmt(down[idx!] ?? 0)}</span>
              </div>
            </div>
          </>
        )}
        </div>
      </div>

      {xTicks.length > 0 ? (
        <div className="relative ml-12 mt-1 h-3 text-[10px] text-muted-foreground tnum">
          {xTicks.map((tk, k) => {
            const pos = n > 1 ? (tk.i / (n - 1)) * 100 : 50;
            return (
              <span
                key={k}
                className="absolute -translate-x-1/2 whitespace-nowrap"
                style={{ left: `${pos}%` }}
              >
                {tk.label}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="ml-12 mt-1 h-3" />
      )}
    </div>
  );
}

// niceBound picks a clean axis bound (1/2/5 × 10ⁿ) for an SI-like display.
function niceBound(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * base;
}

// niceStep picks a clean tick step (1/2/5 × 10ⁿ) sized roughly to a target.
function niceStep(target: number): number {
  if (target <= 0) return 1;
  const exp = Math.floor(Math.log10(target));
  const base = Math.pow(10, exp);
  const f = target / base;
  const nf = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nf * base;
}
