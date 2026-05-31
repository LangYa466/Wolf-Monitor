"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// A single plotted series. `area` fills the region under the line with a
// vertical gradient of `color`; otherwise it's a plain stroked line.
export type Series = {
  data: number[];
  color: string; // CSS color (hsl(var(--x)) or hex)
  area?: boolean;
};

// Low-level responsive SVG plot. Uses a fixed 0..100 coordinate box stretched
// to the container with preserveAspectRatio="none"; strokes keep their pixel
// width via vector-effect so lines stay crisp at any width. Renders 0/50/100%
// horizontal gridlines.
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

  // Build an SVG path for a series' data over the coordinate box.
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
            <linearGradient
              key={i}
              id={`${gradientId}-${i}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
            </linearGradient>
          ) : null,
        )}
      </defs>

      {/* gridlines at 0% / 50% / 100% */}
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
            {s.area && (
              <path d={areaPath(pts)} fill={`url(#${gradientId}-${i})`} stroke="none" />
            )}
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// A chart card for the per-server detail grid: a title, one or more legend
// values top-right, the plot with left-edge y-axis labels, and 3m/0s x labels.
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
}) {
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

      <div className="relative">
        {/* y-axis labels overlaid on the left edge */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex flex-col justify-between py-0 text-[10px] text-muted-foreground tnum">
          <span>{yLabels[0]}</span>
          <span>{yLabels[1]}</span>
          <span>{yLabels[2]}</span>
        </div>
        <Plot series={series} max={max} gradientId={id} />
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tnum">
        <span>{xLeft}</span>
        <span>{xRight}</span>
      </div>
    </div>
  );
}
