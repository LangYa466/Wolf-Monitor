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

// bitsRate formats a byte-rate as a bits-per-second figure (decimal SI units),
// the convention Grafana's "Network Bandwidth Usage" panel uses: "0 b/s",
// "20 Mb/s", "1.5 Gb/s".
export function bitsRate(bytesPerSec: number, digits = 0): string {
  const bps = (bytesPerSec || 0) * 8;
  if (bps <= 0) return "0 b/s";
  const units = ["b", "Kb", "Mb", "Gb", "Tb"];
  let v = bps;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const d = i === 0 ? 0 : v >= 100 ? 0 : digits;
  return `${v.toFixed(d)} ${units[i]}/s`;
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

// osDistro resolves the concrete distribution (Ubuntu / Debian / …) from the
// node's reported `platform`, falling back to the generic OS. `logo` is a
// font-logos CSS class (https://github.com/Lukas-W/font-logos) rendered as an
// icon-font glyph — it covers Linux distros plus Windows/macOS (Tux as the
// generic Linux fallback).
export function osDistro(
  platform: string,
  os: string,
): { name: string; logo: string } {
  const p = (platform || "").toLowerCase();
  const o = (os || "").toLowerCase();
  const table: [RegExp, string, string][] = [
    [/ubuntu/, "Ubuntu", "fl-ubuntu"],
    [/debian/, "Debian", "fl-debian"],
    [/cent\s?os/, "CentOS", "fl-centos"],
    [/fedora/, "Fedora", "fl-fedora"],
    [/red\s?hat|rhel/, "RHEL", "fl-redhat"],
    [/rocky/, "Rocky Linux", "fl-rocky-linux"],
    [/alma/, "AlmaLinux", "fl-almalinux"],
    [/arch/, "Arch Linux", "fl-archlinux"],
    [/manjaro/, "Manjaro", "fl-manjaro"],
    [/alpine/, "Alpine", "fl-alpine"],
    [/(open)?suse/, "openSUSE", "fl-opensuse"],
    [/mint/, "Linux Mint", "fl-linuxmint"],
    [/gentoo/, "Gentoo", "fl-gentoo"],
    [/raspbian|raspberry/, "Raspberry Pi OS", "fl-raspberry-pi"],
  ];
  for (const [re, name, logo] of table) if (re.test(p)) return { name, logo };
  if (o.includes("windows") || p.includes("windows")) return { name: "Windows", logo: "fl-windows" };
  if (o.includes("darwin") || o.includes("mac") || p.includes("darwin"))
    return { name: "macOS", logo: "fl-apple" };
  if (o.includes("linux")) return { name: "Linux", logo: "fl-tux" };
  return { name: platform || os || "Unknown", logo: "fl-tux" };
}
