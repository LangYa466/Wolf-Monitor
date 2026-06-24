// Country resolution via ipinfo.io. The optional API token is read from the DB
// settings (key "ipinfoToken") so no env var is needed. Results are cached in
// process memory keyed by IP to stay well under ipinfo's free rate limits.

import { LRUCache } from "lru-cache";
import { getSetting } from "./db";
import { isIpLiteral } from "./ipcheck";
import { isPrivate } from "./net";

// Bounded LRU so a pathological flood of distinct IPs can't grow the map.
// 24h TTL — country assignments rarely change and a stale "US" beats hitting
// the free-tier ipinfo limit.
// Boxed so lru-cache (which forbids null/undefined values) can hold "we tried
// and got no answer" entries alongside successful lookups.
const cache = new LRUCache<string, { country: string | null }>({
  max: 20_000,
  ttl: 24 * 60 * 60_000,
});

// resolveCountry returns an ISO 3166-1 alpha-2 code (e.g. "US") or null.
export async function resolveCountry(ip: string | null): Promise<string | null> {
  if (!ip || isPrivate(ip)) return null;
  // Reject malformed IPs early — clientIp() reads CDN headers that node tokens
  // can spoof; bad input would still hit ipinfo and pollute the cache.
  if (!isIpLiteral(ip)) return null;
  const hit = cache.get(ip);
  if (hit !== undefined) return hit.country;

  try {
    const token = await getSetting<string>("ipinfoToken").catch(() => null);
    const url = `https://ipinfo.io/${encodeURIComponent(ip)}/country`;
    const res = await fetch(url, {
      headers: {
        accept: "text/plain",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      cache.set(ip, { country: null });
      return null;
    }
    const code = (await res.text()).trim().toUpperCase();
    const valid = /^[A-Z]{2}$/.test(code) ? code : null;
    cache.set(ip, { country: valid });
    return valid;
  } catch {
    // Don't cache transient failures permanently — allow a later retry.
    return null;
  }
}

// shouldResolve decides whether a report needs a (re)lookup: only when the IP
// changed or we have no country yet. Keeps lookups to ~once per node.
export function shouldResolve(
  newIp: string | null,
  existingIp: string | null,
  existingCountry: string | null
): boolean {
  if (!newIp) return false;
  if (!existingCountry) return true;
  return newIp !== existingIp;
}
