import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type ConfigEnv, type Plugin } from "vite";

import {
  devSessionIdFromBytes,
  isCanonicalDevSessionId,
  HRA_DEV_READY_PATH,
  HRA_DEV_READY_SCHEMA,
  HRA_DEV_SESSION_ENV,
  type DevSessionId,
} from "../runtime/dev-protocol";

const BASE_CONNECT_SOURCE = "connect-src 'self'";
const DEVELOPMENT_CONNECT_SOURCE =
  `${BASE_CONNECT_SOURCE} http://127.0.0.1:5173 ws://127.0.0.1:5173`;
export const HRA_DESKTOP_PUBLIC_DIRECTORY = false;

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

export default defineConfig(({ command }) => ({
  root: "frontend",
  base: "./",
  publicDir: HRA_DESKTOP_PUBLIC_DIRECTORY,
  plugins: [
    {
      name: "hra-desktop-renderer-csp",
      enforce: "pre",
      transformIndexHtml: (html) => rewriteDesktopRendererCsp(html, command),
    },
    ...(command === "serve"
      ? [hraDevReadinessPlugin(devSessionIdForVite(process.env))]
      : []),
    react(),
  ],
  build: {
    emptyOutDir: true,
    outDir: "dist",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
}));
