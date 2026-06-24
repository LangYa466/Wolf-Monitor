// IP classification — single source of truth, backed by ipaddr.js.
// Used by lib/notify.ts (SSRF guard), lib/net.ts (geo skip), and anywhere else
// we need "is this address public-routable / non-private / safe to egress to".

import ipaddr, { type IPv4, type IPv6 } from "ipaddr.js";

// Categories ipaddr.js returns. "unicast" is public; everything else is unsafe
// for egress (loopback, private, linkLocal, multicast, reserved, ...).
type Range = string;

// Strip a v6-mapped v4 prefix and brackets so callers can feed raw header values.
export function normalizeIp(raw: string): string {
  let v = raw.trim().replace(/^\[|\]$/g, "");
  if (!v) return "";
  // ipaddr.js parses "::ffff:1.2.3.4" but it stays classified as ipv6 — collapse
  // to v4 so the v4 range table (CGNAT, RFC1918, link-local) is consulted.
  if (/^::ffff:/i.test(v)) {
    const tail = v.slice(7);
    if (ipaddr.IPv4.isValid(tail)) return tail;
  }
  return v;
}

// True iff the IP literal is a public-routable unicast address.
// Private / loopback / link-local / multicast / reserved / CGNAT all return false.
export function isPublicIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ipaddr.isValid(ip)) return false;
  const addr = ipaddr.parse(ip);
  const range: Range = addr.range();
  return range === "unicast";
}

// True iff the IP literal is private / loopback / link-local / CGNAT / etc.
// (i.e. NOT public). Invalid input returns true — fail-closed for the geo skip.
export function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ipaddr.isValid(ip)) return true;
  return ipaddr.parse(ip).range() !== "unicast";
}

// True iff `host` is an IP literal (v4 or v6).
export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(normalizeIp(host));
}

// Parse helpers re-exported so callers don't import ipaddr.js directly.
export function parseIp(raw: string): IPv4 | IPv6 | null {
  const ip = normalizeIp(raw);
  if (!ipaddr.isValid(ip)) return null;
  return ipaddr.parse(ip);
}
