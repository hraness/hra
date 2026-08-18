import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

import {
  withProductionDeliveryProof,
  type ProductionDeliveryProofEnvironment,
} from "@hraness/vercel-delivery";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const hraIconDataModule = fileURLToPath(new URL("./app/hra-icon-data.ts", import.meta.url));
const hraIconRuntimeModule = fileURLToPath(new URL("./app/hra-icon-runtime.tsx", import.meta.url));

export interface HraWebpackConfig {
  plugins?: unknown[];
  resolve: {
    alias?: Readonly<Record<string, unknown>>;
  };
}

interface WebpackModuleLike {
  readonly identifier?: () => string;
  readonly resource?: string;
}

interface WebpackCompilationLike {
  readonly errors: Error[];
  readonly hooks: {
    readonly finishModules: {
      tap(name: string, callback: (modules: Iterable<WebpackModuleLike>) => void): void;
    };
  };
}

interface WebpackCompilerLike {
  readonly hooks: {
    readonly compilation: {
      tap(name: string, callback: (compilation: WebpackCompilationLike) => void): void;
    };
  };
}

export function isForbiddenHraIconModuleIdentifier(identifier: string): boolean {
  const normalized = identifier.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/@hugeicons/") || normalized.includes("/@hugeicons+");
}

export class HraProductionIconModuleBoundaryPlugin {
  apply(compiler: unknown): void {
    const webpackCompiler = compiler as WebpackCompilerLike;
    webpackCompiler.hooks.compilation.tap(
      "HraProductionIconModuleBoundary",
      (compilation) => {
        compilation.hooks.finishModules.tap(
          "HraProductionIconModuleBoundary",
          (modules) => {
            const violations = new Set<string>();
            for (const candidateModule of modules) {
              const identifiers = [candidateModule.identifier?.(), candidateModule.resource]
                .filter((value): value is string => typeof value === "string");
              for (const identifier of identifiers) {
                if (isForbiddenHraIconModuleIdentifier(identifier)) violations.add(identifier);
              }
            }
            if (violations.size > 0) {
              compilation.errors.push(new Error([
                "HRA web production resolved forbidden icon modules:",
                ...[...violations].sort().map((identifier) => `- ${identifier}`),
              ].join("\n")));
            }
          },
        );
      },
    );
  }
}

export function withHraProductionIconBoundary<T extends HraWebpackConfig>(config: T): T {
  const plugins = config.plugins ?? [];
  plugins.push(new HraProductionIconModuleBoundaryPlugin());
  config.plugins = plugins;
  config.resolve.alias = {
    ...config.resolve.alias,
    "@hugeicons/core-free-icons": hraIconDataModule,
    "@hugeicons/react": hraIconRuntimeModule,
  };
  return config;
}
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
export const hraVercelProjectName = "hra";

export function createHraNextConfig(
  environment: ProductionDeliveryProofEnvironment = process.env,
): NextConfig {
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
      withHraProductionIconBoundary(config);
      config.resolve.extensionAlias = {
        ...config.resolve.extensionAlias,
        ".js": [".ts", ".tsx", ".js"],
      };
      return config;
    },
  };

  return withProductionDeliveryProof(nextConfig, {
    environment,
    projectName: hraVercelProjectName,
  });
}

export default createHraNextConfig();
