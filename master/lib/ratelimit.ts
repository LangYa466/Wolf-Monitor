// Tiny in-memory token-bucket rate limiter keyed by an arbitrary string
// (typically `ip:<addr>`). Per-process state — fine for a single-instance
// master, coarse but useful behind multi-instance deployments. Set
// WOLF_DISABLE_INGEST_RATELIMIT=1 to bypass entirely.
//
// Bucket storage is backed by lru-cache so eviction and TTL are handled by a
// battle-tested wheel instead of a hand-rolled sweep.

import { LRUCache } from "lru-cache";

interface Bucket {
  tokens: number;
  ts: number;
}

const MAX_ENTRIES = 100_000;
// Idle bucket expiry — anything not touched for 10 minutes is dropped well
// before the LRU sweeps it on size pressure.
const IDLE_TTL_MS = 10 * 60_000;

const buckets = new LRUCache<string, Bucket>({
  max: MAX_ENTRIES,
  ttl: IDLE_TTL_MS,
  updateAgeOnGet: true,
});

export function takeToken(
  key: string,
  capacity: number,
  refillPerSec: number,
): boolean {
  if (process.env.WOLF_DISABLE_INGEST_RATELIMIT === "1") return true;
  if (capacity <= 0 || refillPerSec <= 0) return true;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, ts: now };
  } else {
    const elapsed = Math.max(0, (now - b.ts) / 1000);
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.ts = now;
  }
  let ok: boolean;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    ok = true;
  } else {
    ok = false;
  }
  buckets.set(key, b);
  return ok;
}

// Suggest a Retry-After seconds value for a bucket that just rejected.
export function retryAfterSec(refillPerSec: number): number {
  if (refillPerSec <= 0) return 1;
  return Math.max(1, Math.ceil(1 / refillPerSec));
}

// Test-only: wipe internal state between cases.
export function _resetRateLimit(): void {
  buckets.clear();
}
