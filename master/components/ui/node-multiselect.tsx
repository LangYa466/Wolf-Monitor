"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronDown } from "lucide-react";
import { SegmentedControl } from "./segmented";
import { useI18n } from "@/lib/i18n";
import { flagUrl } from "@/lib/format";
import type { NodeView } from "@/lib/types";

type GroupBy = "region" | "status" | "none";

function displayName(n: NodeView): string {
  return n.name?.trim() || n.host.hostname;
}

// NodeMultiSelect — a popover to choose nodes for a latency task. Supports two
// modes (include allowlist / exclude blacklist) and a grouped, sorted list
// (by region or status). Built from the Card + Button vocabulary.
export function NodeMultiSelect({
  nodes,
  value,
  exclude,
  onChange,
  onExcludeChange,
  className,
}: {
  nodes: NodeView[];
  value: string[];
  exclude: boolean;
  onChange: (ids: string[]) => void;
  onExcludeChange: (b: boolean) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [groupBy, setGroupBy] = React.useState<GroupBy>("region");
  const ref = React.useRef<HTMLDivElement>(null);
  const selected = new Set(value);

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

  function toggle(id: string) {
    onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  }

  const groups = React.useMemo(() => buildGroups(nodes, groupBy, t), [nodes, groupBy, t]);

  const summary =
    value.length === 0
      ? t("selAll")
      : exclude
        ? t("selExclude", { n: value.length })
        : t("selCount", { n: value.length });

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-8 w-full items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary/60 [&_svg]:size-3.5"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown
          className={cn("ml-auto text-muted-foreground transition-transform duration-200", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1.5 w-72 origin-top-left rounded-md border border-border bg-popover p-2 shadow-lg">
          <SegmentedControl
            variant="card"
            className="w-full [&>button]:flex-1"
            value={exclude ? "exclude" : "include"}
            onChange={(v) => onExcludeChange(v === "exclude")}
            options={[
              { value: "include", label: t("modeInclude") },
              { value: "exclude", label: t("modeExclude") },
            ]}
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("groupBy")}</span>
            <SegmentedControl
              value={groupBy}
              onChange={(v) => setGroupBy(v)}
              options={[
                { value: "region", label: t("grpRegion") },
                { value: "status", label: t("grpStatus") },
                { value: "none", label: t("grpNone") },
              ]}
            />
          </div>

          <div className="mt-2 max-h-60 overflow-y-auto">
            {nodes.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">—</p>
            )}
            {groups.map((g) => (
              <div key={g.key} className="mb-1">
                {g.label && (
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    {g.label}
                  </div>
                )}
                {g.items.map((n) => {
                  const on = selected.has(n.id);
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => toggle(n.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-secondary/60"
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border [&_svg]:size-3",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                        )}
                      >
                        {on && <Check />}
                      </span>
                      {n.country && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={flagUrl(n.country)} alt={n.country} width={16} height={12} className="shrink-0 rounded-[1px]" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-left">{displayName(n)}</span>
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          n.online ? "bg-success" : "bg-destructive",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
            >
              {t("clearSel")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Group = { key: string; label: string; items: NodeView[] };

function buildGroups(
  nodes: NodeView[],
  groupBy: GroupBy,
  t: (k: string, vars?: Record<string, string | number>) => string,
): Group[] {
  const byName = (a: NodeView, b: NodeView) => displayName(a).localeCompare(displayName(b));
  if (groupBy === "none") {
    return [{ key: "all", label: "", items: [...nodes].sort(byName) }];
  }
  if (groupBy === "status") {
    const on = nodes.filter((n) => n.online).sort(byName);
    const off = nodes.filter((n) => !n.online).sort(byName);
    return [
      { key: "online", label: t("grpOnline"), items: on },
      { key: "offline", label: t("grpOffline"), items: off },
    ].filter((g) => g.items.length > 0);
  }
  // region
  const cn = nodes.filter((n) => n.country === "cn").sort(byName);
  const oversea = nodes.filter((n) => n.country && n.country !== "cn").sort(byName);
  const unknown = nodes.filter((n) => !n.country).sort(byName);
  return [
    { key: "cn", label: t("grpCN"), items: cn },
    { key: "oversea", label: t("grpOversea"), items: oversea },
    { key: "unknown", label: t("grpUnknown"), items: unknown },
  ].filter((g) => g.items.length > 0);
}
