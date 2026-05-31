"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// A segmented control built in the same visual language as Card + Button:
// hairline border / card surface (variant "card"), or a bare pill row
// (variant "plain"). The active option is marked by a single highlight pill
// that slides between options — the "switch animation".

export type SegmentedOption<T extends string> = {
  value: T;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  ariaLabel?: string;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  variant = "plain",
  size = "md",
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  variant?: "plain" | "card";
  size?: "sm" | "md";
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const btnRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const [ind, setInd] = React.useState({ left: 0, width: 0, ready: false });

  const measure = React.useCallback(() => {
    const el = btnRefs.current[value];
    if (!el) return;
    setInd({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
  }, [value]);

  // Measure on value change, and re-measure when the row reflows (font swap,
  // resize) so the pill stays glued to the active option.
  React.useLayoutEffect(() => {
    measure();
  }, [measure, options.length]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measure]);

  const pad = variant === "card" ? (size === "sm" ? "p-0.5" : "p-1") : "";
  const inset = variant === "card" ? (size === "sm" ? 4 : 8) : 0;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative inline-flex items-center",
        variant === "card" && "rounded-md border border-border bg-card",
        pad,
        className,
      )}
    >
      {/* sliding highlight pill */}
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 -translate-y-1/2 rounded bg-secondary transition-[left,width,opacity] duration-300 ease-out motion-reduce:transition-none",
          ind.ready ? "opacity-100" : "opacity-0",
        )}
        style={{ left: ind.left, width: ind.width, height: `calc(100% - ${inset}px)` }}
      />
      {options.map((o) => {
        const active = o.value === value;
        const iconOnly = o.icon && o.label == null;
        return (
          <button
            key={o.value}
            ref={(el) => {
              btnRefs.current[o.value] = el;
            }}
            type="button"
            onClick={() => onChange(o.value)}
            aria-label={o.ariaLabel}
            aria-pressed={active}
            title={o.title}
            className={cn(
              "relative z-10 inline-flex items-center justify-center gap-1.5 rounded text-sm font-medium transition-colors duration-200 [&_svg]:size-4",
              iconOnly
                ? size === "sm"
                  ? "h-6 w-7"
                  : "h-7 w-8"
                : "px-3 py-1.5",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
