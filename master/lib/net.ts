// Client-IP extraction that trusts CDN / reverse-proxy headers. Works behind
// Cloudflare, nginx, etc. Order reflects specificity.

export function clientIp(headers: Headers): string | null {
  const candidates = [
    headers.get("cf-connecting-ip"), // Cloudflare
    headers.get("true-client-ip"), // Cloudflare Enterprise / Akamai
    headers.get("x-real-ip"), // nginx
    firstForwarded(headers.get("x-forwarded-for")), // standard proxy chain
  ];
  for (const c of candidates) {
    const ip = normalize(c);
    if (ip) return ip;
  }
  return null;
}

function firstForwarded(value: string | null): string | null {
  if (!value) return null;
  // XFF is "client, proxy1, proxy2" — the left-most is the origin client.
  return value.split(",")[0]?.trim() || null;
}

function normalize(ip: string | null): string | null {
  if (!ip) return null;
  let v = ip.trim();
  if (!v) return null;
  // Strip IPv6-mapped IPv4 prefix and brackets.
  if (v.startsWith("::ffff:")) v = v.slice(7);
  v = v.replace(/^\[|\]$/g, "");
  return v;
}

// isPrivate reports loopback / RFC1918 / link-local addresses we shouldn't geo-lookup.
export function isPrivate(ip: string): boolean {
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith("169.254.")) return true; // link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA
  if (ip.startsWith("fe80")) return true; // link-local v6
  return false;
}
