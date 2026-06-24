import { dirname } from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defense-in-depth response headers. CSP allowlists the exact third-party
// origins used in app/layout.tsx (font-logos + Google Fonts). 'unsafe-inline'
// for script/style is required by Next's hydration + Tailwind inline styles;
// tighten via nonces later if/when feasible.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fastly.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com https://fastly.jsdelivr.net",
  "img-src 'self' data: https://flagcdn.com",
  "connect-src 'self'",
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
