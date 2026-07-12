// Optional Cloudflare Turnstile verification for the login endpoint.
//
// Activated only when TURNSTILE_SECRET_KEY is set — otherwise verify() is a
// no-op and callers behave exactly as before. The public site key is exposed
// to the browser as NEXT_PUBLIC_TURNSTILE_SITE_KEY (baked at build time by
// Next.js); the widget on the login page renders iff that is present.

const VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

export function turnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(
  token: unknown,
  ip: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true };
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return { ok: false, error: "captcha required" };
  }
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: "captcha verification failed" };
    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    return data.success === true
      ? { ok: true }
      : { ok: false, error: "captcha rejected" };
  } catch {
    return { ok: false, error: "captcha verification failed" };
  }
}
