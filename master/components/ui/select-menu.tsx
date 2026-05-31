"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Check } from "lucide-react";

// A custom select built from the Card + Button vocabulary: a button-styled
// trigger and a card-styled popover menu that scales/fades in. Replaces the
// unstyled native <select>.

export type SelectOption<T extends string> = { value: T; label: React.ReactNode };

export function SelectMenu<T extends string>({
  value,
  onChange,
  options,
  leading,
  ariaLabel,
  align = "end",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  leading?: React.ReactNode; // optional icon shown in the trigger
  ariaLabel?: string;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  // Enable the open/close transition only after the first paint, so the closed
  // menu doesn't animate (flash) when the component (re)mounts on navigation.
  const [animate, setAnimate] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:size-3.5",
        )}
      >
        {leading}
        <span className="truncate">{current?.label}</span>
        <ChevronDown
          className={cn("text-muted-foreground transition-transform duration-200", open && "rotate-180")}
        />
      </button>

      <div
        role="listbox"
        className={cn(
          "absolute z-50 mt-1.5 min-w-full overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg",
          animate && "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
          open
            ? "pointer-events-auto scale-100 opacity-100"
            : "pointer-events-none scale-95 opacity-0",
        )}
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-4 whitespace-nowrap rounded px-2.5 py-1.5 text-sm transition-colors [&_svg]:size-3.5",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <span>{o.label}</span>
              {active && <Check />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
