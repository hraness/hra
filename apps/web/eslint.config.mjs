import nextConfig from "@hra-internal/eslint-config/next";

const config = [
  ...nextConfig,
  { ignores: [".next/**", "convex/_generated/**", "dist-direct/**"] },
];

export default config;
