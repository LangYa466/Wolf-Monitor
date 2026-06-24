import type { NextRequest } from "next/server";
import isEmail from "validator/lib/isEmail";

// Shared helpers for the auth routes. Email validation delegated to validator's
// isEmail (RFC 5321/5322 conformant — handles quoted local-parts, IDN, length
// limits) instead of a hand-rolled regex.

// validateCredentials returns an error message, or null when valid.
export function validateCredentials(email: unknown, password: unknown): string | null {
  if (typeof email !== "string" || !isEmail(email)) return "invalid email";
  if (typeof password !== "string" || password.length < 8)
    return "password must be at least 8 characters";
  if (password.length > 200) return "password too long";
  return null;
}

// isSecureRequest decides the Secure cookie flag. In production we default to
// true (HTTPS expected via the TLS-terminating proxy) so a missing or spoofed
// X-Forwarded-Proto cannot downgrade the cookie. Operators running production
// over plain http on a trusted network must opt in via WOLF_INSECURE_COOKIE=1.
export function isSecureRequest(req: NextRequest): boolean {
  if (process.env.WOLF_INSECURE_COOKIE === "1") return false;
  if (process.env.NODE_ENV === "production") return true;
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return req.nextUrl.protocol === "https:";
}
