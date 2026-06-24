// Client-IP extraction. CDN / reverse-proxy headers are only trusted when
// TRUST_PROXY explicitly opts in — otherwise an unauthenticated caller can
// spoof cf-connecting-ip / x-forwarded-for to bypass IP-keyed rate limits
// (see lib/auth.ts isRateLimited). Set TRUST_PROXY to a comma-separated list
// of "cloudflare", "nginx" (x-real-ip + x-forwarded-for), or "all". Default
// is "none" — header values are ignored and clientIp() returns null, forcing
// callers into a coarse fallback bucket rather than an attacker-chosen key.
//
// IP normalization + private/loopback classification are delegated to ipaddr.js
// via lib/ipcheck so the regex tables don't drift from the SSRF guard's.

import requestIp from "request-ip";
import { isPrivateIp, normalizeIp } from "./ipcheck";

function trustList(): Set<string> {
  const raw = (process.env.TRUST_PROXY || "none").toLowerCase();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Build the subset of headers the trust list allows, then defer to request-ip
// for the actual extraction (handles XFF chains, multi-value lists, v6-mapped
// addresses uniformly).
export function clientIp(headers: Headers): string | null {
  const trust = trustList();
  if (trust.has("none") && trust.size === 1) return null;
  const all = trust.has("all");
  const allowed = new Set<string>();
  if (all || trust.has("cloudflare")) {
    allowed.add("cf-connecting-ip");
    allowed.add("true-client-ip");
  }
  if (all || trust.has("nginx")) {
    allowed.add("x-real-ip");
    allowed.add("x-forwarded-for");
  }
  const adapted: Record<string, string> = {};
  for (const name of allowed) {
    const v = headers.get(name);
    if (v) adapted[name] = v;
  }
  const ip = requestIp.getClientIp({ headers: adapted } as Parameters<typeof requestIp.getClientIp>[0]);
  if (!ip) return null;
  const norm = normalizeIp(ip);
  return norm || null;
}

// isPrivate reports loopback / RFC1918 / link-local / CGNAT addresses we
// shouldn't geo-lookup. Backed by ipaddr.js.
export function isPrivate(ip: string): boolean {
  return isPrivateIp(ip);
}
