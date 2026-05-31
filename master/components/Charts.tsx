"use client";

import * as React from "react";
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
