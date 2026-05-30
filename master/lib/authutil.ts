import type { NextRequest } from "next/server";

// Shared, dependency-free helpers for the auth routes.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// validateCredentials returns an error message, or null when valid.
export function validateCredentials(email: unknown, password: unknown): string | null {
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return "invalid email";
  if (typeof password !== "string" || password.length < 8)
    return "password must be at least 8 characters";
  if (password.length > 200) return "password too long";
  return null;
}

// isSecureRequest decides the Secure cookie flag, honouring the CDN/proxy
// X-Forwarded-Proto header (the connection to the origin may be plain http).
export function isSecureRequest(req: NextRequest): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return req.nextUrl.protocol === "https:";
}
