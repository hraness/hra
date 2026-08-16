import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
export const hraSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=()",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
] as const;
export const hraPrivateNoStoreHeaders = [
  {
    key: "Cache-Control",
    value: "private, no-store, max-age=0, must-revalidate",
  },
] as const;
const nextConfig: NextConfig = {
  async headers() {
    return [
      { headers: [...hraSecurityHeaders], source: "/(.*)" },
      {
        headers: [...hraPrivateNoStoreHeaders],
        source: "/api/suite-auth/:path*",
      },
      {
        headers: [...hraPrivateNoStoreHeaders],
        source: "/auth/:path*",
      },
    ];
  },
  images: {
    unoptimized: true,
  },
  outputFileTracingRoot: repositoryRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@hraness/agent-tasks-protocol",
    "@hraness/agent-tasks-ui",
    "@hra-internal/brand-ui",
    "@hra-internal/design-kit",
    "@hra-internal/schema",
  ],
  turbopack: {
    root: repositoryRoot,
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
