/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` and `ws` are server-only native-ish deps; keep them external so Next
  // doesn't try to bundle them into serverless/edge function output.
  serverExternalPackages: ["pg", "ws"],
};

export default nextConfig;
