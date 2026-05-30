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

// osBadge returns a short emoji + label for the platform.
export function osBadge(os: string): string {
  const o = (os || "").toLowerCase();
  if (o.includes("windows")) return "🪟 Windows";
  if (o.includes("darwin") || o.includes("mac")) return "🍎 macOS";
  if (o.includes("linux")) return "🐧 Linux";
  return os || "?";
}
