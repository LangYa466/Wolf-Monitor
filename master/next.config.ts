import { dirname } from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defense-in-depth response headers. CSP allowlists the exact third-party
// origins used in app/layout.tsx (font-logos + Google Fonts). 'unsafe-inline'
// for script/style is required by Next's hydration + Tailwind inline styles;
// tighten via nonces later if/when feasible.
// Cloudflare auto-injects Browser Insights (beacon.min.js) when the site is
// proxied behind CF. Allow its script + beacon-submit origin so CSP doesn't
// block it, which also avoids the hydration mismatch CF causes when the
// blocked-script <script> stub stays in the served HTML.
// Cloudflare Turnstile loads its api.js from challenges.cloudflare.com and
// renders the challenge inside an iframe from the same origin.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fastly.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com https://fastly.jsdelivr.net",
  "img-src 'self' data: https://flagcdn.com",
  "connect-src 'self' https://cloudflareinsights.com https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pg` and `ws` are server-only native-ish deps; keep them external so Next
  // doesn't try to bundle them into serverless/edge function output.
  serverExternalPackages: ["pg", "ws"],
  // This app is the workspace root (the repo also contains node/), so pin the
  // file-tracing root to this dir — avoids Next inferring the wrong root.
  outputFileTracingRoot: __dirname,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
