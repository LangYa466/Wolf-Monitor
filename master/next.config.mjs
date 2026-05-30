import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` and `ws` are server-only native-ish deps; keep them external so Next
  // doesn't try to bundle them into serverless/edge function output.
  serverExternalPackages: ["pg", "ws"],
  // This app is the workspace root (the repo also contains node/), so pin the
  // file-tracing root to this dir — avoids Next inferring the wrong root.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
