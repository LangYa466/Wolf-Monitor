// Authentication & authorization.
//
// Admin access uses email/password accounts (created at /setup) with
// session-cookie auth. Node ingestion uses a shared token stored in the DB
// (app_settings "nodeToken"), generated at setup. The ONLY required env var is
// DATABASE_URL — everything here is DB-backed.

import { createHash, randomBytes, scrypt, timingSafeEqual as nodeTSE } from "crypto";
import { promisify } from "util";
import { LRUCache } from "lru-cache";
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  getPool,
  getSetting,
  setSetting,
} from "./db";

// Hash a session token before persisting / looking up. The plaintext lives
// only in the user's cookie; a DB dump alone can no longer impersonate users.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Per-node admission tokens share the same hashing primitive. All authz
// lookups in node_tokens query by `token_hash` so the equality is over a
// fixed-width digest. The plaintext now lives only inside an AES-256-GCM
// envelope in `token_enc` (wrapped under the same KEK as app_settings) so
// a DB dump alone can't recover the admission token; the legacy plaintext
// `token` column is kept nullable for unmigrated rows and emptied on the
// first read that successfully encrypts it into `token_enc`.
function hashNodeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Persist (or return) the encrypted envelope as a JSONB-shaped value. We
// hand `pg` a JS object here; the driver serializes it to JSON for the
// jsonb column. Returning null lets callers decide whether to fall back
// to the legacy plaintext column.
function encNodeToken(token: string): object {
  return encryptSecretAtRest(token) as unknown as object;
}

// Resolve a row's plaintext token: prefer the encrypted envelope, fall
// back to the legacy plaintext column. If we read plaintext from `token`
// but `token_enc` is empty, opportunistically lazy-migrate the row so the
// plaintext column can be cleared once every row is encrypted.
async function resolveRowToken(row: {
  token: string | null;
  token_enc: unknown;
  token_hash: string | null;
}): Promise<string | null> {
  const fromEnc = row.token_enc ? decryptSecretAtRest(row.token_enc) : null;
  if (fromEnc) return fromEnc;
  if (row.token) {
    // Lazy migration: encrypt the legacy plaintext, persist the envelope,
    // then null the plaintext column. Best-effort — a failure here just
    // leaves the row in legacy shape, it does not break the read.
    try {
      const digest = row.token_hash ?? hashNodeToken(row.token);
      await getPool().query(
        `UPDATE node_tokens
            SET token_enc = $1::jsonb,
                token_hash = COALESCE(token_hash, $2),
                token = NULL
          WHERE token_hash = $2 OR (token_hash IS NULL AND token = $3)`,
        [JSON.stringify(encNodeToken(row.token)), digest, row.token],
      );
    } catch (err) {
      console.error(
        "[auth] lazy token-encrypt migration failed:",
        (err as Error).message,
      );
    }
    return row.token;
  }
  return null;
}

// promisify loses the overload that accepts ScryptOptions; re-declare so we
// can pass {N,r,p,maxmem} explicitly without an `any` cast.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

// Legacy / fallback cookie name (HTTP-only deployments — e.g. WOLF_INSECURE_COOKIE=1
// behind a trusted-network proxy). Over HTTPS we prefer the __Host- prefixed
// variant, which the browser only accepts with Secure + Path=/ + no Domain —
// blocking sibling-subdomain cookie injection / fixation.
export const SESSION_COOKIE = "wolf_session";
export const SESSION_COOKIE_SECURE = "__Host-wolf_session";

// sessionCookieName picks the cookie name that matches the Secure flag we'll
// set. Must agree across set/clear/read or the browser will silently reject
// the cookie (e.g. setting __Host-* without Secure is a no-op).
export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

// readSessionCookie returns whichever variant the browser sent. Used on the
// read path so an in-flight HTTP→HTTPS upgrade doesn't log existing users out.
export function readSessionCookie(
  get: (name: string) => { value: string } | undefined,
): string | undefined {
  return get(SESSION_COOKIE_SECURE)?.value ?? get(SESSION_COOKIE)?.value;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (absolute cap)
// Idle timeout: a session that hasn't been used in this long is treated as
// expired even if its absolute expires_at is still in the future. Bounds the
// blast radius of a stolen cookie from an account that's gone quiet.
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Sliding-window refresh: on access, if more than this has elapsed since the
// session was last touched, bump last_used_at and extend expires_at by another
// full TTL. The throttle (1h) keeps active users from writing on every request
// while still giving daily users a true rolling session instead of a fixed
// 30-day cliff.
const SESSION_REFRESH_MS = 60 * 60 * 1000;

// ── password hashing (scrypt) ───────────────────────────────────────────────
//
// Stored format (versioned):
//   scrypt$N=<n>,r=<r>,p=<p>$<salt-hex>$<hash-hex>
// Legacy format (pre-1.5.6, accepted on verify only):
//   scrypt$<salt-hex>$<hash-hex>   ← Node defaults (N=2^14, r=8, p=1)
//
// 2026 OWASP baseline for scrypt is N=2^17, r=8, p=1. maxmem is bumped to
// ~128 MiB so Node doesn't refuse the larger N (default maxmem is 32 MiB,
// which caps useful N around 2^15). Old hashes keep verifying with the
// legacy params; they'll be silently upgraded the next time the user logs
// in (see verifyUserPassword → password rewrite hook in the route).
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const SCRYPT_OPTS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS)) as Buffer;
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

// Parse "N=..,r=..,p=.." into scrypt options. Returns null on malformed input.
function parseScryptParams(
  s: string,
): { N: number; r: number; p: number; maxmem: number } | null {
  const out: Record<string, number> = {};
  for (const kv of s.split(",")) {
    const eq = kv.indexOf("=");
    if (eq < 0) return null;
    const k = kv.slice(0, eq);
    const v = Number(kv.slice(eq + 1));
    if (!Number.isFinite(v) || v <= 0) return null;
    out[k] = v;
  }
  if (!out.N || !out.r || !out.p) return null;
  // Bound maxmem so a hostile stored value can't be used to OOM the process.
  // 256 MiB ceiling covers any sane N up to 2^18 at r=8.
  return { N: out.N, r: out.r, p: out.p, maxmem: 256 * 1024 * 1024 };
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return false;
  let salt: Buffer;
  let expected: Buffer;
  let opts: { N: number; r: number; p: number; maxmem: number } | undefined;
  if (parts.length === 4 && parts[1].startsWith("N=")) {
    // Versioned format with embedded params.
    const parsed = parseScryptParams(parts[1]);
    if (!parsed) return false;
    opts = parsed;
    salt = Buffer.from(parts[2], "hex");
    expected = Buffer.from(parts[3], "hex");
  } else if (parts.length === 3) {
    // Legacy format — Node scrypt defaults (N=2^14, r=8, p=1).
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
    opts = undefined;
  } else {
    return false;
  }
  const derived = (opts
    ? await scryptAsync(password, salt, expected.length, opts)
    : await scryptAsync(password, salt, expected.length)) as Buffer;
  return expected.length === derived.length && nodeTSE(expected, derived);
}

// Returns true if a stored hash was produced with parameters weaker than the
// current SCRYPT_OPTS. Login routes can use this to opportunistically rehash
// the password (with the freshly-supplied plaintext) and persist the upgrade.
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return false;
  if (parts.length === 3) return true; // legacy → upgrade
  if (parts.length === 4 && parts[1].startsWith("N=")) {
    const parsed = parseScryptParams(parts[1]);
    if (!parsed) return false;
    return parsed.N < SCRYPT_N || parsed.r < SCRYPT_R || parsed.p < SCRYPT_P;
  }
  return false;
}

// Dummy hash computed once at module load so unknown-email logins do the same
// scrypt work as known-email logins — closes the CWE-208 timing oracle.
let DUMMY_HASH: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!DUMMY_HASH) DUMMY_HASH = hashPassword(randomBytes(32).toString("hex"));
  return DUMMY_HASH;
}

// Constant-work verify: always runs scrypt regardless of whether the user
// exists, eliminating the response-time oracle.
export async function verifyUserPassword(
  user: { passwordHash: string } | null,
  password: string,
): Promise<boolean> {
  const hash = user?.passwordHash ?? (await getDummyHash());
  const ok = await verifyPassword(password, hash);
  return ok && user !== null;
}

// ── users ───────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  email: string;
}

export async function userCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users`
  );
  return Number(rows[0].n);
}

export async function createUser(email: string, password: string): Promise<User> {
  const hash = await hashPassword(password);
  const { rows } = await getPool().query<{ id: number; email: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
    [email.toLowerCase().trim(), hash]
  );
  return { id: Number(rows[0].id), email: rows[0].email };
}

// First-run setup helper. Uses pg_advisory_xact_lock so two concurrent /setup
// requests can't both pass the "no users yet" check and create two admins
// (TOCTOU). Returns null if a user already exists.
const SETUP_LOCK_KEY = 0x77_6f_6c_66; // 'wolf'
export async function createUserExclusive(
  email: string,
  password: string,
): Promise<User | null> {
  const hash = await hashPassword(password);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [SETUP_LOCK_KEY]);
    const { rows: existing } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM users`,
    );
    if (Number(existing[0].n) > 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows } = await client.query<{ id: number; email: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
      [email.toLowerCase().trim(), hash],
    );
    await client.query("COMMIT");
    return { id: Number(rows[0].id), email: rows[0].email };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function findUser(
  email: string
): Promise<{ id: number; email: string; passwordHash: string } | null> {
  const { rows } = await getPool().query<{
    id: number;
    email: string;
    password_hash: string;
  }>(`SELECT id, email, password_hash FROM users WHERE email = $1`, [
    email.toLowerCase().trim(),
  ]);
  if (rows.length === 0) return null;
  return { id: Number(rows[0].id), email: rows[0].email, passwordHash: rows[0].password_hash };
}

// ── sessions ─────────────────────────────────────────────────────────────────

export async function createSession(userId: number): Promise<{ token: string; expires: Date }> {
  // Plaintext goes to the user's cookie; only the SHA-256 digest is persisted.
  // A leaked DB therefore can't be replayed without the original cookie value.
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  await getPool().query(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
    [hashToken(token), userId, now, expires]
  );
  return { token, expires: new Date(expires) };
}

export async function sessionUser(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const digest = hashToken(token);
  const { rows } = await getPool().query<{
    id: number;
    email: string;
    expires_at: string;
    last_used_at: string | null;
  }>(
    `SELECT u.id, u.email, s.expires_at, s.last_used_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [digest]
  );
  if (rows.length === 0) return null;
  const now = Date.now();
  if (Number(rows[0].expires_at) < now) {
    await deleteSession(token);
    return null;
  }
  // Idle bound: if the session hasn't been touched in SESSION_IDLE_MS, treat
  // it as expired and revoke even though absolute expires_at is still future.
  // last_used_at is NULL for sessions created before this column was added;
  // fall back to the creation-time anchor by accepting NULL as "fresh".
  const lastUsedRaw = rows[0].last_used_at;
  if (lastUsedRaw !== null && now - Number(lastUsedRaw) > SESSION_IDLE_MS) {
    await deleteSession(token);
    return null;
  }
  // Rolling refresh: throttle DB writes to once per SESSION_REFRESH_MS. We
  // re-anchor expires_at to now+TTL so an actively-used session never hits
  // the 30-day cliff, while idle sessions still expire on schedule.
  const lastUsed = rows[0].last_used_at === null ? 0 : Number(rows[0].last_used_at);
  if (now - lastUsed >= SESSION_REFRESH_MS) {
    // Best-effort: if this UPDATE races / fails, the read above is still valid.
    getPool()
      .query(
        `UPDATE sessions SET last_used_at = $1, expires_at = $2 WHERE token = $3`,
        [now, now + SESSION_TTL_MS, digest],
      )
      .catch(() => {});
  }
  return { id: Number(rows[0].id), email: rows[0].email };
}

export async function deleteSession(token: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE token = $1`, [hashToken(token)]);
}

// Revoke every session belonging to a user — used by "logout everywhere" and
// by privilege/credential changes so a leaked cookie can be invalidated even
// without the original plaintext token.
export async function deleteSessionsForUser(userId: number): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

// Revoke every session belonging to a user EXCEPT the one tied to `keepToken`.
// Used on login to rotate stale sessions while keeping the freshly issued one.
export async function deleteOtherSessionsForUser(
  userId: number,
  keepToken: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM sessions WHERE user_id = $1 AND token <> $2`,
    [userId, hashToken(keepToken)],
  );
}

// ── node ingestion tokens (DB-backed) ───────────────────────────────────────
//
// Token model:
//  • Each node has its OWN token (the "key" embedded in its install command).
//  • An unbound token (node_id IS NULL) is generated in advance for a new
//    server and binds to the reporting hostname on first /api/report.
//  • Legacy `app_settings.nodeToken` is a shared admission token kept as a
//    fallback for migration so existing nodes don't drop off mid-rollout.
//    Remove it from app_settings once every node is reinstalled.

export async function getLegacyNodeToken(): Promise<string | null> {
  return getSetting<string>("nodeToken");
}

export async function ensureNodeToken(): Promise<string> {
  const existing = await getLegacyNodeToken();
  if (existing) return existing;
  const token = randomBytes(18).toString("base64url");
  await setSetting("nodeToken", token);
  return token;
}

// Generate a token already bound to a node, or return the existing one. Used
// by the admin UI to surface a copy-paste install command for known nodes.
export async function ensureTokenForNode(hostname: string): Promise<string> {
  const pool = getPool();
  const existing = await pool.query<{
    token: string | null;
    token_enc: unknown;
    token_hash: string | null;
  }>(
    `SELECT token, token_enc, token_hash FROM node_tokens
       WHERE node_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [hostname],
  );
  if (existing.rows.length) {
    const resolved = await resolveRowToken(existing.rows[0]);
    if (resolved) return resolved;
    // Row exists but neither column held a recoverable plaintext (envelope
    // failed to decrypt — e.g. KEK rotation). Fall through and mint a new
    // token; the stale row will be overwritten on next rotate.
  }
  const token = randomBytes(18).toString("base64url");
  await pool.query(
    `INSERT INTO node_tokens (token, token_enc, token_hash, node_id, created_at)
       VALUES (NULL, $1::jsonb, $2, $3, $4)`,
    [JSON.stringify(encNodeToken(token)), hashNodeToken(token), hostname, Date.now()],
  );
  return token;
}

// Drop and regenerate the token for a node — the admin must reinstall the
// service on that host afterwards for it to keep reporting. Notifies any
// registered eviction listener (see onTokenRevoked) so the WS server can drop
// its 60s authz cache and force-close any live socket still holding the token.
export async function rotateTokenForNode(hostname: string): Promise<string> {
  const { rows } = await getPool().query<{
    token: string | null;
    token_enc: unknown;
    token_hash: string | null;
  }>(
    `SELECT token, token_enc, token_hash FROM node_tokens WHERE node_id = $1`,
    [hostname],
  );
  await getPool().query(`DELETE FROM node_tokens WHERE node_id = $1`, [hostname]);
  for (const r of rows) {
    const plain = await resolveRowToken(r);
    if (plain) notifyTokenRevoked(plain);
  }
  return ensureTokenForNode(hostname);
}

// Server-assigned node id slug. Replaces the old "first-reported-hostname
// becomes the id" scheme: every new token is pre-bound to a fresh slug at
// creation time, so two machines that both call themselves "localhost"
// (default on many fresh VPS images) get distinct identities. Format is
// `node_<10 base32 chars>` — fits HOSTNAME_RE, urlsafe, ~50 bits of entropy
// which is plenty for an identifier (collisions are checked below).
function generateNodeIdSlug(): string {
  // Crockford base32 minus ambiguous chars, lowercased.
  const alphabet = "abcdefghjkmnpqrstvwxyz23456789";
  const bytes = randomBytes(10);
  let out = "node_";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function mintUniqueNodeIdSlug(): Promise<string> {
  const pool = getPool();
  // Collision probability is astronomically low, but loop a few times anyway
  // — any non-null hit means we don't want to overwrite an existing token's
  // identity. After 5 misses something's wrong with the RNG; surface it.
  for (let i = 0; i < 5; i++) {
    const slug = generateNodeIdSlug();
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM node_tokens WHERE node_id = $1
         UNION ALL
         SELECT 1 FROM nodes WHERE id = $1
       ) AS exists`,
      [slug],
    );
    if (!rows[0]?.exists) return slug;
  }
  throw new Error("failed to mint a unique node id slug");
}

// Create a pre-assigned token. The slug stored in node_id IS the node's
// identity from day one — the agent's self-reported hostname is irrelevant
// for routing. Saved to claimed_node_id too so the hostname-squat guard in
// authorizeReport doesn't trip on the (now ignored) hostname argument.
export async function createUnboundToken(): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  const slug = await mintUniqueNodeIdSlug();
  await getPool().query(
    `INSERT INTO node_tokens (token, token_enc, token_hash, node_id, claimed_node_id, created_at)
       VALUES (NULL, $1::jsonb, $2, $3, $3, $4)`,
    [JSON.stringify(encNodeToken(token)), hashNodeToken(token), slug, Date.now()],
  );
  return token;
}

export async function listNodeTokens(): Promise<
  Array<{ token: string; nodeId: string | null; createdAt: number }>
> {
  const { rows } = await getPool().query<{
    token: string | null;
    token_enc: unknown;
    token_hash: string | null;
    node_id: string | null;
    created_at: string;
  }>(
    `SELECT token, token_enc, token_hash, node_id, created_at
       FROM node_tokens ORDER BY created_at DESC`,
  );
  const out: Array<{ token: string; nodeId: string | null; createdAt: number }> = [];
  for (const r of rows) {
    const plain = await resolveRowToken(r);
    if (!plain) continue; // unrecoverable (KEK mismatch) — hide rather than expose junk
    out.push({
      token: plain,
      nodeId: r.node_id,
      createdAt: Number(r.created_at),
    });
  }
  return out;
}

export async function deleteNodeToken(token: string): Promise<void> {
  const digest = hashNodeToken(token);
  await getPool().query(
    `DELETE FROM node_tokens
      WHERE token_hash = $1 OR (token_hash IS NULL AND token = $2)`,
    [digest, token],
  );
  notifyTokenRevoked(token);
}

// ── token revocation broadcast ──────────────────────────────────────────────
//
// The WS upgrade path in server.ts caches a positive token check for 60s to
// absorb reconnect storms. Without a revocation signal, a deleted/rotated
// token would remain accepted for up to that TTL — and any already-connected
// socket would keep streaming until its next reconnect. Subscribers (the
// custom server) register here and synchronously evict their cache + close
// matching live sockets when a token is revoked.

type TokenRevokedListener = (token: string) => void;
const revokeListeners = new Set<TokenRevokedListener>();

export function onTokenRevoked(fn: TokenRevokedListener): () => void {
  revokeListeners.add(fn);
  return () => revokeListeners.delete(fn);
}

function notifyTokenRevoked(token: string): void {
  for (const fn of revokeListeners) {
    try {
      fn(token);
    } catch (err) {
      console.error("[auth] token-revoked listener failed:", (err as Error).message);
    }
  }
}

// authorizeReport: gate for POST /api/report. Looks up the provided token in
// node_tokens; binds an unbound row to `hostname` on first use. Falls back to
// the legacy shared token (so unmigrated nodes keep reporting). Returns true
// if the report should be accepted.
//
// Hostname-squat hardening (round 2): a parallel `claimed_node_id` column
// records the hostname that first claimed the token. Even if `node_id` is
// somehow rewritten later, `claimed_node_id` is the immutable anchor — a
// mismatched hostname is refused. The column may not exist on freshly-seeded
// DBs; in that case we fall back to legacy single-column behavior.
const LEGACY_BIND_TTL_MS = 10 * 60 * 1000;
const RECENT_LEGACY_BINDS = new LRUCache<string, string>({
  max: 4096,
  ttl: LEGACY_BIND_TTL_MS,
});
function recordLegacyBind(hostname: string, token: string): void {
  RECENT_LEGACY_BINDS.set(hostname, token);
}
function legacyBindRefuses(hostname: string, token: string): boolean {
  if (process.env.WOLF_STRICT_LEGACY_BIND !== "1") return false;
  const prev = RECENT_LEGACY_BINDS.get(hostname);
  if (!prev) return false;
  return prev !== token;
}

// authorizeReport returns the node id the report should be stored under
// (or null on failure). Three cases:
//   • Pre-assigned token (new path, post-v1.6.1): node_id is already a slug
//     minted at createUnboundToken time. The hostname arg is ignored —
//     identity is decoupled from what the agent self-reports.
//   • Legacy unbound token (node_id IS NULL): first /api/report binds the
//     row to the reported hostname, keeping the old "hostname == id"
//     behaviour for tokens minted before this change.
//   • Legacy hostname-bound token: bound !== hostname is rejected so a
//     compromised token can't be replayed under a different identity.
// The claimed_node_id squat guard still applies for legacy rows; new rows
// have claimed_node_id == node_id so the check is a no-op.
export async function authorizeReport(
  provided: string | null | undefined,
  hostname: string,
): Promise<string | null> {
  if (!provided) return null;
  const pool = getPool();
  const digest = hashNodeToken(provided);
  try {
    const { rows } = await pool.query<{
      node_id: string | null;
      claimed_node_id: string | null;
    }>(
      `SELECT node_id, claimed_node_id FROM node_tokens
        WHERE token_hash = $1 OR (token_hash IS NULL AND token = $2)`,
      [digest, provided],
    );
    if (rows.length) {
      const bound = rows[0].node_id;
      const claimed = rows[0].claimed_node_id;
      // Pre-assigned slug path: bound is set, claimed matches bound, hostname
      // is irrelevant. Skip the squat check (it would compare slug vs
      // hostname and always reject).
      if (bound !== null && claimed === bound) return bound;
      // Legacy hostname-bound: enforce the squat guard against the reported
      // hostname as before.
      if (claimed !== null && claimed !== hostname) return null;
      if (bound === null) {
        await pool.query(
          `UPDATE node_tokens
              SET node_id = $1,
                  claimed_node_id = COALESCE(claimed_node_id, $1),
                  token_hash = COALESCE(token_hash, $2)
            WHERE (token_hash = $2 OR (token_hash IS NULL AND token = $3))
              AND node_id IS NULL`,
          [hostname, digest, provided],
        );
        return hostname;
      }
      if (bound !== hostname) return null;
      if (claimed === null) {
        await pool.query(
          `UPDATE node_tokens SET claimed_node_id = $1
            WHERE (token_hash = $2 OR (token_hash IS NULL AND token = $3))
              AND claimed_node_id IS NULL`,
          [hostname, digest, provided],
        );
      }
      return bound;
    }
  } catch {
    // token_hash / claimed_node_id columns missing on an ancient DB — fall
    // back to the legacy single-column lookup.
    const { rows } = await pool.query<{ node_id: string | null }>(
      `SELECT node_id FROM node_tokens WHERE token = $1`,
      [provided],
    );
    if (rows.length) {
      const bound = rows[0].node_id;
      if (bound === null) {
        await pool.query(
          `UPDATE node_tokens SET node_id = $1 WHERE token = $2 AND node_id IS NULL`,
          [hostname, provided],
        );
        return hostname;
      }
      return bound === hostname ? bound : null;
    }
  }
  if (legacyBindRefuses(hostname, provided)) return null;
  const ok = await legacyTokenMatch(provided);
  if (ok) {
    recordLegacyBind(hostname, provided);
    return hostname;
  }
  return null;
}

// authorizeForHost: gate for endpoints that already know which node is calling
// (e.g. /api/tasks?host=...). Doesn't bind. An unbound token is rejected here
// — it has to bind via /api/report first.
export async function authorizeForHost(
  provided: string | null | undefined,
  hostname: string,
): Promise<boolean> {
  if (!provided) return false;
  const digest = hashNodeToken(provided);
  const { rows } = await getPool().query<{ node_id: string | null }>(
    `SELECT node_id FROM node_tokens
      WHERE token_hash = $1 OR (token_hash IS NULL AND token = $2)`,
    [digest, provided],
  );
  if (rows.length) return rows[0].node_id === hostname;
  return legacyTokenMatch(provided);
}

// nodeForToken: returns the hostname a per-node token is bound to, or null
// when the token is unbound, unknown, or the legacy shared token (which is
// not bound to any specific node). Callers like /api/ping use this to clamp
// inbound results to the caller's own nodeId, blocking cross-node spoofing.
export async function nodeForToken(
  provided: string | null | undefined,
): Promise<string | null> {
  if (!provided) return null;
  const digest = hashNodeToken(provided);
  const { rows } = await getPool().query<{ node_id: string | null }>(
    `SELECT node_id FROM node_tokens
      WHERE token_hash = $1 OR (token_hash IS NULL AND token = $2)`,
    [digest, provided],
  );
  if (rows.length && rows[0].node_id) return rows[0].node_id;
  return null;
}

// authorizeAnyNode: gate for endpoints that don't pin a specific host (e.g.
// /api/ping where each batch carries its own nodeId per row). Accepts any
// bound or legacy token; rejects unbound (which has no node yet).
export async function authorizeAnyNode(
  provided: string | null | undefined,
): Promise<boolean> {
  if (!provided) return false;
  const digest = hashNodeToken(provided);
  const { rows } = await getPool().query<{ node_id: string | null }>(
    `SELECT node_id FROM node_tokens
      WHERE token_hash = $1 OR (token_hash IS NULL AND token = $2)`,
    [digest, provided],
  );
  if (rows.length) return rows[0].node_id !== null;
  return legacyTokenMatch(provided);
}

async function legacyTokenMatch(provided: string): Promise<boolean> {
  const expected = await getLegacyNodeToken();
  if (!expected) return false;
  return safeEqualStr(provided, expected);
}

// Back-compat: keep the old `nodeTokenValid` symbol as a hostname-agnostic
// validator (legacy-only) so any incidental imports still type-check. Prefer
// authorizeReport/authorizeForHost/authorizeAnyNode in new code.
export async function nodeTokenValid(provided: string | null | undefined): Promise<boolean> {
  if (!provided) return false;
  return authorizeAnyNode(provided);
}

export function tokenFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : header.trim();
}

// Cron guard. Fails closed: if neither CRON_SECRET nor a runtime-provisioned
// secret (set via setRuntimeCronSecret from the self-host server boot) is
// configured, /api/cron/check rejects all callers. This keeps the heavy
// evaluate() + prune DELETEs behind a credential by default.
let RUNTIME_CRON_SECRET = "";
export function setRuntimeCronSecret(s: string): void {
  RUNTIME_CRON_SECRET = s || "";
}
export function cronValid(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET || RUNTIME_CRON_SECRET || "";
  if (secret === "") return false;
  const provided = tokenFromHeader(authHeader);
  return provided ? safeEqualStr(provided, secret) : false;
}

// ── login rate limiting (DB-backed, works across serverless instances) ──────

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 12;

// Rate-limit scopes are persisted to `auth_attempts`. The email scope is
// hashed (sha256) before storage so a DB leak does not expose the list of
// emails an attacker probed during a brute-force run. The IP scope is left
// plaintext — it is already retained elsewhere (access logs) and operators
// need it to investigate abuse.
function emailScope(email: string): string {
  const e = email.toLowerCase().trim();
  return `email:${createHash("sha256").update(e).digest("hex")}`;
}

export async function isRateLimited(ip: string, email: string): Promise<boolean> {
  const since = Date.now() - WINDOW_MS;
  const { rows } = await getPool().query<{ scope: string; n: string }>(
    `SELECT scope, COUNT(*) AS n FROM auth_attempts
      WHERE success = FALSE AND ts >= $1 AND scope = ANY($2)
      GROUP BY scope`,
    [since, [`ip:${ip}`, emailScope(email)]]
  );
  for (const r of rows) {
    const n = Number(r.n);
    if (r.scope.startsWith("ip:") && n >= MAX_PER_IP) return true;
    if (r.scope.startsWith("email:") && n >= MAX_PER_EMAIL) return true;
  }
  return false;
}

export async function recordAttempt(ip: string, email: string, success: boolean): Promise<void> {
  const ts = Date.now();
  await getPool().query(
    `INSERT INTO auth_attempts (scope, ts, success) VALUES ($1,$3,$4),($2,$3,$4)`,
    [`ip:${ip}`, emailScope(email), ts, success]
  );
}

export async function pruneAuthAttempts(): Promise<void> {
  try {
    await getPool().query(`DELETE FROM auth_attempts WHERE ts < $1`, [
      Date.now() - WINDOW_MS,
    ]);
    await getPool().query(`DELETE FROM sessions WHERE expires_at < $1`, [Date.now()]);
  } catch {
    /* best-effort */
  }
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return nodeTSE(ab, bb);
}
