export function bytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function bps(n: number): string {
  return `${bytes(n)}/s`;
}

// ibytes formats a byte count with IEC binary units (KiB/MiB/GiB/TiB), the
// convention Komari uses for memory/disk/cumulative traffic — e.g. "1.89 GiB".
export function ibytes(n: number, digits = 2): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

// speed formats a per-second byte rate compactly: "1.57K/s", "31.60K/s",
// "4.00M/s" (1024-based, single-letter unit, no trailing B — matches Komari).
export function speed(n: number, digits = 2): string {
  if (!n || n < 0) return "0/s";
  const units = ["", "K", "M", "G", "T"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)}${units[i]}/s`;
}

export function pct(n: number): string {
  return `${(n ?? 0).toFixed(1)}%`;
}

export function uptime(seconds: number): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// uptimeCJK renders a duration the way Komari's detail header does: "42天7小時".
export function uptimeCJK(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天${h}小時`;
  if (h > 0) return `${h}小時${m}分`;
  return `${m}分`;
}

// datetime formats a unix-millis timestamp as "YYYY-MM-DD HH:MM:SS" in local
// time, matching the 啟動時間 / 最後上報時間 fields on the detail page.
export function datetime(ms: number): string {
  if (!ms || ms < 0) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// flagUrl returns a flagcdn.com flag image URL for an ISO 3166-1 alpha-2 code.
export function flagUrl(cc: string): string {
  return `https://flagcdn.com/24x18/${cc.toLowerCase()}.png`;
}

// osBadge returns a short, human-readable platform label (no emoji).
export function osBadge(os: string): string {
  const o = (os || "").toLowerCase();
  if (o.includes("windows")) return "Windows";
  if (o.includes("darwin") || o.includes("mac")) return "macOS";
  if (o.includes("linux")) return "Linux";
  return os || "?";
}
