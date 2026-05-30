// Country resolution via ipinfo.io. The optional API token is read from the DB
// settings (key "ipinfoToken") so no env var is needed. Results are cached in
// process memory keyed by IP to stay well under ipinfo's free rate limits.

import { getSetting } from "./db";
import { isPrivate } from "./net";

const cache = new Map<string, string | null>();

// resolveCountry returns an ISO 3166-1 alpha-2 code (e.g. "US") or null.
export async function resolveCountry(ip: string | null): Promise<string | null> {
  if (!ip || isPrivate(ip)) return null;
  if (cache.has(ip)) return cache.get(ip) ?? null;

  try {
    const token = await getSetting<string>("ipinfoToken").catch(() => null);
    const url =
      `https://ipinfo.io/${encodeURIComponent(ip)}/country` +
      (token ? `?token=${encodeURIComponent(token)}` : "");
    const res = await fetch(url, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      cache.set(ip, null);
      return null;
    }
    const code = (await res.text()).trim().toUpperCase();
    const valid = /^[A-Z]{2}$/.test(code) ? code : null;
    cache.set(ip, valid);
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
