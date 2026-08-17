import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type ConfigEnv, type Plugin } from "vite";

import { hraDevEntryPlugin } from "./dev/vite-plugin.ts";
import { hraMalleableDevPlugin } from "../runtime/dev/vite-plugin.ts";

import {
  devSessionIdFromBytes,
  isCanonicalDevSessionId,
  HRA_DEV_READY_PATH,
  HRA_DEV_READY_SCHEMA,
  HRA_DEV_SESSION_ENV,
  type DevSessionId,
} from "../runtime/dev-protocol.ts";

const BASE_CONNECT_SOURCE = "connect-src 'self'";
const DEVELOPMENT_CONNECT_SOURCE =
  `${BASE_CONNECT_SOURCE} http://127.0.0.1:5173 ws://127.0.0.1:5173`;
export const HRA_DESKTOP_PUBLIC_DIRECTORY = false;

const FORBIDDEN_PRODUCTION_MODULES = Object.freeze([
  Object.freeze({
    label: "Hugeicons JavaScript",
    matches: (moduleId: string) => moduleId.includes("@hugeicons"),
  }),
  Object.freeze({
    label: "design-kit React JavaScript",
    matches: (moduleId: string) => (
      moduleId.includes("@hra-internal/design-kit/react")
      || moduleId.replaceAll("\\", "/").includes("/design-kit/src/react/")
    ),
  }),
]);

export interface ProductionModuleBoundaryViolation {
  readonly moduleId: string;
  readonly rule: string;
}

export function productionModuleBoundaryViolations(
  moduleIds: readonly string[],
): readonly ProductionModuleBoundaryViolation[] {
  return moduleIds.flatMap((moduleId) => FORBIDDEN_PRODUCTION_MODULES
    .filter((rule) => rule.matches(moduleId))
    .map((rule) => ({ moduleId, rule: rule.label })))
    .sort((left, right) => (
      left.moduleId.localeCompare(right.moduleId) || left.rule.localeCompare(right.rule)
    ));
}

export function assertHraProductionModuleIds(moduleIds: readonly string[]): void {
  if (moduleIds.length === 0) {
    throw new Error("HRA production module boundary did not inspect a compiled chunk.");
  }
  const violations = productionModuleBoundaryViolations(moduleIds);
  if (violations.length === 0) return;
  throw new Error([
    "HRA production renderer contains forbidden module IDs:",
    ...violations.map((violation) => `${violation.rule}: ${violation.moduleId}`),
  ].join("\n"));
}

export function hraProductionModuleBoundaryPlugin(): Plugin {
  return {
    name: "hra-production-module-boundary",
    apply: "build",
    generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle).flatMap((output) => (
        output.type === "chunk" ? Object.keys(output.modules) : []
      ));
      assertHraProductionModuleIds(moduleIds);
    },
  };
}

export function desktopConnectSourceDirective(
  command: ConfigEnv["command"],
): string {
  return command === "serve"
    ? DEVELOPMENT_CONNECT_SOURCE
    : BASE_CONNECT_SOURCE;
}

export function rewriteDesktopRendererCsp(
  html: string,
  command: ConfigEnv["command"],
): string {
  const first = html.indexOf(BASE_CONNECT_SOURCE);
  if (
    first === -1 ||
    html.indexOf(BASE_CONNECT_SOURCE, first + BASE_CONNECT_SOURCE.length) !== -1
  ) {
    throw new Error("Desktop HTML must contain exactly one renderer connect-src directive.");
  }
  return html.replace(
    BASE_CONNECT_SOURCE,
    desktopConnectSourceDirective(command),
  );
}

export interface DevReadinessPluginResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

export function devSessionIdForVite(
  environment: Readonly<Record<string, string | undefined>>,
  random: (size: number) => Uint8Array = randomBytes,
): DevSessionId {
  const sessionId = environment[HRA_DEV_SESSION_ENV];
  if (sessionId === undefined) {
    // `bun run dev:frontend` remains an ergonomic UI-only server. Its private
    // nonce cannot authenticate a native launch, which supplies its own exact
    // value and refuses any listener that predates that launch.
    return devSessionIdFromBytes(random(32));
  }
  if (!isCanonicalDevSessionId(sessionId)) {
    throw new Error(
      `${HRA_DEV_SESSION_ENV} must be a canonical 32-byte lowercase hexadecimal launch nonce.`,
    );
  }
  return sessionId;
}

export function devReadinessResponseForRequest(
  method: string | undefined,
  url: string | undefined,
  sessionId: DevSessionId,
): DevReadinessPluginResponse | undefined {
  if (url !== HRA_DEV_READY_PATH) return undefined;
  const commonHeaders = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } as const;
  if (method !== "GET") {
    return {
      statusCode: 405,
      headers: { ...commonHeaders, Allow: "GET", "Content-Length": "0" },
      body: "",
    };
  }
  const body = JSON.stringify({
    schema: HRA_DEV_READY_SCHEMA,
    sessionId,
  });
  return {
    statusCode: 200,
    headers: {
      ...commonHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  };
}

type DevReadinessNext = (error?: unknown) => void;

export function createDevReadinessMiddleware(
  sessionId: DevSessionId,
): (
  request: IncomingMessage,
  response: ServerResponse,
  next: DevReadinessNext,
) => void {
  return (request, response, next) => {
    const result = devReadinessResponseForRequest(
      request.method,
      request.url,
      sessionId,
    );
    if (result === undefined) {
      next();
      return;
    }
    response.statusCode = result.statusCode;
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.end(result.body);
  };
}

export function hraDevReadinessPlugin(sessionId: DevSessionId): Plugin {
  return {
    name: "hra-dev-readiness",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(createDevReadinessMiddleware(sessionId));
    },
  };
}

export default defineConfig(({ command }) => {
  const developmentSessionId = command === "serve"
    ? devSessionIdForVite(process.env)
    : undefined;
  const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

  return {
    root: "frontend",
    base: "./",
    publicDir: HRA_DESKTOP_PUBLIC_DIRECTORY,
    plugins: [
      {
        name: "hra-desktop-renderer-csp",
        enforce: "pre",
        transformIndexHtml: (html) => rewriteDesktopRendererCsp(html, command),
      },
      ...(command === "serve" && developmentSessionId !== undefined
        ? [
          hraDevEntryPlugin(),
          hraDevReadinessPlugin(developmentSessionId),
          hraMalleableDevPlugin({
            authority: process.env[HRA_DEV_SESSION_ENV] === undefined ? "uiOnly" : "launcher",
            desktopRoot,
            repositoryRoot,
            sessionId: developmentSessionId,
          }),
        ]
        : []),
      hraProductionModuleBoundaryPlugin(),
      react(),
    ],
    build: {
      emptyOutDir: true,
      outDir: "dist",
    },
    server: {
      cors: false,
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
  };
});
