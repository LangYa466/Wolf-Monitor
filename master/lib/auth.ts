// Authentication & authorization.
//
// Admin access uses email/password accounts (created at /setup) with
// session-cookie auth. Node ingestion uses a shared token stored in the DB
// (app_settings "nodeToken"), generated at setup. The ONLY required env var is
// DATABASE_URL — everything here is DB-backed.

import { randomBytes, scrypt, timingSafeEqual as nodeTSE } from "crypto";
import { promisify } from "util";
import { getPool, getSetting, setSetting } from "./db";

const scryptAsync = promisify(scrypt);

export const SESSION_COOKIE = "wolf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── password hashing (scrypt) ───────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return expected.length === derived.length && nodeTSE(expected, derived);
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
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  await getPool().query(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
    [token, userId, now, expires]
  );
  return { token, expires: new Date(expires) };
}

export async function sessionUser(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const { rows } = await getPool().query<{ id: number; email: string; expires_at: string }>(
    `SELECT u.id, u.email, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  if (rows.length === 0) return null;
  if (Number(rows[0].expires_at) < Date.now()) {
    await deleteSession(token);
    return null;
  }
  return { id: Number(rows[0].id), email: rows[0].email };
}

export async function deleteSession(token: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

// ── node ingestion token (DB-backed) ────────────────────────────────────────

export async function getNodeToken(): Promise<string | null> {
  return getSetting<string>("nodeToken");
}

export async function ensureNodeToken(): Promise<string> {
  const existing = await getNodeToken();
  if (existing) return existing;
  const token = randomBytes(18).toString("base64url");
  await setSetting("nodeToken", token);
  return token;
}

export async function nodeTokenValid(provided: string | null | undefined): Promise<boolean> {
  const expected = await getNodeToken();
  if (!expected) return false; // not configured yet → reject until setup
  if (!provided) return false;
  return safeEqualStr(provided, expected);
}

export function tokenFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : header.trim();
}

// Cron guard stays optional via env CRON_SECRET (not required).
export function cronValid(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret === "") return true;
  const provided = tokenFromHeader(authHeader);
  return provided ? safeEqualStr(provided, secret) : false;
}

// ── login rate limiting (DB-backed, works across serverless instances) ──────

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 12;

export async function isRateLimited(ip: string, email: string): Promise<boolean> {
  const since = Date.now() - WINDOW_MS;
  const { rows } = await getPool().query<{ scope: string; n: string }>(
    `SELECT scope, COUNT(*) AS n FROM auth_attempts
      WHERE success = FALSE AND ts >= $1 AND scope = ANY($2)
      GROUP BY scope`,
    [since, [`ip:${ip}`, `email:${email.toLowerCase().trim()}`]]
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
  const e = email.toLowerCase().trim();
  await getPool().query(
    `INSERT INTO auth_attempts (scope, ts, success) VALUES ($1,$3,$4),($2,$3,$4)`,
    [`ip:${ip}`, `email:${e}`, ts, success]
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
