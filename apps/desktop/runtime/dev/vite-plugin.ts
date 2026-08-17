import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import type { HmrContext, ModuleNode, Plugin } from "vite";

import {
  HRA_DEV_BUN_EXECUTABLE_ENV,
  type DevSessionId,
} from "../dev-protocol.ts";
import {
  classifyDevChange,
  HRA_GATEWAY_TRANSITIVE_WORKSPACE_ROOTS,
  parseRepositoryRelativePath,
  type DevChangeClassification,
  type RepositoryRelativePath,
} from "./change-classifier.ts";
import { createGatewayCandidateBuilder } from "./gateway-builder.ts";
import {
  DevGatewayCoordinator,
  type DevStatusMutationOutcome,
  type GatewayCandidateBuilder,
} from "./gateway-coordinator.ts";
import {
  devErrorEnvelope,
  HRA_DEV_ACK_PATH,
  HRA_DEV_ACK_SCHEMA,
  HRA_DEV_APPLY_PATH,
  HRA_DEV_APPLY_SCHEMA,
  HRA_DEV_CANCEL_PATH,
  HRA_DEV_CANCEL_SCHEMA,
  HRA_DEV_FRONTEND_ORIGIN,
  HRA_DEV_STATUS_EVENT,
  HRA_DEV_STATUS_PATH,
  MAX_DEV_MUTATION_BODY_BYTES,
  parseDevMutationEnvelope,
  type DevMutationSchema,
  type DevStatusAuthority,
  type DevStatusEnvelope,
} from "./status-protocol.ts";

export interface HraMalleableDevPluginOptions {
  readonly authority: DevStatusAuthority;
  readonly buildCandidate?: GatewayCandidateBuilder;
  readonly debounceMs?: number;
  readonly desktopRoot: string;
  readonly reconcileIntervalMs?: number;
  readonly repositoryRoot: string;
  readonly sessionId: DevSessionId;
}

export interface DevPluginHttpResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

type DevMutationAction = "acknowledge" | "cancel" | "reserve";

interface DevMutationRoute {
  readonly action: DevMutationAction;
  readonly schema: DevMutationSchema;
}

interface DevMutationHttpInput {
  readonly authority: DevStatusAuthority;
  readonly beforeReserve?: () => void;
  readonly body: string;
  readonly contentType: string | undefined;
  readonly method: string | undefined;
  readonly origin: string | undefined;
  readonly sessionId: DevSessionId;
  readonly url: string | undefined;
}

const MUTATION_ROUTES: Readonly<Record<string, DevMutationRoute>> = Object.freeze({
  [HRA_DEV_APPLY_PATH]: Object.freeze({ action: "reserve", schema: HRA_DEV_APPLY_SCHEMA }),
  [HRA_DEV_ACK_PATH]: Object.freeze({ action: "acknowledge", schema: HRA_DEV_ACK_SCHEMA }),
  [HRA_DEV_CANCEL_PATH]: Object.freeze({ action: "cancel", schema: HRA_DEV_CANCEL_SCHEMA }),
});

const JSON_RESPONSE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
});

interface DevColdFenceGlobal {
  __hraDevColdFencesV1?: Map<string, "native" | "launcher">;
}

function coldFenceRegistry(): Map<string, "native" | "launcher"> {
  const state = globalThis as typeof globalThis & DevColdFenceGlobal;
  state.__hraDevColdFencesV1 ??= new Map();
  return state.__hraDevColdFencesV1;
}

class DevRequestBodyTooLargeError extends Error {}

function jsonResponse(
  statusCode: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): DevPluginHttpResponse {
  const body = JSON.stringify(value);
  return {
    statusCode,
    headers: {
      ...JSON_RESPONSE_HEADERS,
      ...extraHeaders,
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  };
}

function statusResponse(
  statusCode: number,
  status: DevStatusEnvelope,
): DevPluginHttpResponse {
  return jsonResponse(statusCode, status);
}

function errorResponse(
  statusCode: number,
  code: Parameters<typeof devErrorEnvelope>[0],
  extraHeaders: Readonly<Record<string, string>> = {},
): DevPluginHttpResponse {
  return jsonResponse(statusCode, devErrorEnvelope(code), extraHeaders);
}

function mutationRoute(url: string | undefined): DevMutationRoute | undefined {
  return url === undefined ? undefined : MUTATION_ROUTES[url];
}

export function devStatusResponseForRequest(
  method: string | undefined,
  url: string | undefined,
  status: DevStatusEnvelope,
): DevPluginHttpResponse | undefined {
  if (url !== HRA_DEV_STATUS_PATH) return undefined;
  if (method !== "GET") {
    return errorResponse(405, "badRequest", { Allow: "GET" });
  }
  return statusResponse(200, status);
}

export function devMutationResponseForInput(
  input: DevMutationHttpInput,
  coordinator: Pick<
    DevGatewayCoordinator,
    "acknowledge" | "cancel" | "reserve"
  >,
): DevPluginHttpResponse | undefined {
  const route = mutationRoute(input.url);
  if (route === undefined) return undefined;
  if (input.method !== "POST") {
    return errorResponse(405, "badRequest", { Allow: "POST" });
  }
  if (input.authority !== "launcher") return errorResponse(403, "forbidden");
  if (input.origin !== HRA_DEV_FRONTEND_ORIGIN) return errorResponse(403, "forbidden");
  if (input.contentType !== "application/json") return errorResponse(415, "contentType");
  if (new TextEncoder().encode(input.body).byteLength > MAX_DEV_MUTATION_BODY_BYTES) {
    return errorResponse(413, "bodyTooLarge");
  }

  let value: unknown;
  try {
    value = JSON.parse(input.body) as unknown;
  } catch {
    return errorResponse(400, "badRequest");
  }
  let mutation;
  try {
    mutation = parseDevMutationEnvelope(value, route.schema);
  } catch {
    return errorResponse(400, "badRequest");
  }
  if (mutation.sessionId !== input.sessionId) return errorResponse(403, "forbidden");
  if (route.action === "reserve") input.beforeReserve?.();
  const outcome: DevStatusMutationOutcome = coordinator[route.action](mutation.candidateId);
  return statusResponse(outcome.kind === "ok" ? 200 : 409, outcome.status);
}

async function readBoundedRequestBody(request: IncomingMessage): Promise<string> {
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string"
    && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > MAX_DEV_MUTATION_BODY_BYTES
  ) {
    request.resume();
    throw new DevRequestBodyTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    length += bytes.byteLength;
    if (length > MAX_DEV_MUTATION_BODY_BYTES) {
      request.resume();
      throw new DevRequestBodyTooLargeError();
    }
    chunks.push(bytes);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function writeResponse(response: ServerResponse, result: DevPluginHttpResponse): void {
  for (const name of [
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Origin",
  ]) response.removeHeader(name);
  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers)) {
    response.setHeader(name, value);
  }
  response.end(result.body);
}

export function repositoryRelativePathForWatcher(
  filePath: string,
  repositoryRoot: string,
): RepositoryRelativePath | undefined {
  const root = resolve(repositoryRoot);
  const absolutePath = resolve(root, filePath);
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  if (relativePath.length === 0) return undefined;
  try {
    return parseRepositoryRelativePath(relativePath);
  } catch {
    return undefined;
  }
}

export function devHotUpdateModules(
  classification: DevChangeClassification,
  _modules: readonly ModuleNode[],
): ModuleNode[] | undefined {
  if (classification.kind === "restartRequired") return [];
  void _modules;
  return undefined;
}

export function gatewayTransitiveWorkspaceWatchPaths(
  repositoryRoot: string,
): readonly string[] {
  return HRA_GATEWAY_TRANSITIVE_WORKSPACE_ROOTS.map((root) => (
    resolve(repositoryRoot, root)
  ));
}

export type DevWatchBaseline = Map<RepositoryRelativePath, string>;

const DEFAULT_DEV_WATCH_RECONCILE_INTERVAL_MS = 1_000;

function fileIdentity(path: string): string | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) return undefined;
    return [
      metadata.dev,
      metadata.ino,
      metadata.mode,
      metadata.size,
      metadata.mtimeMs,
    ].join(":");
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return undefined;
    throw error;
  }
}

export function captureDevWatchBaseline(
  watchPaths: readonly string[],
  repositoryRoot: string,
): DevWatchBaseline {
  const baseline: DevWatchBaseline = new Map();
  const visit = (absolutePath: string): void => {
    const path = repositoryRelativePathForWatcher(absolutePath, repositoryRoot);
    if (path === undefined || classifyDevChange(path).kind === "ignored") return;
    const identity = fileIdentity(absolutePath);
    if (identity !== undefined) {
      baseline.set(path, identity);
      return;
    }
    let entries;
    try {
      const metadata = lstatSync(absolutePath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) return;
      throw error;
    }
    for (const entry of entries) visit(resolve(absolutePath, entry.name));
  };
  for (const watchPath of watchPaths) visit(watchPath);
  return baseline;
}

export function shouldObserveDevWatchEvent(
  event: string,
  filePath: string,
  repositoryRoot: string,
  snapshot: DevWatchBaseline,
): boolean {
  if (event !== "add" && event !== "change" && event !== "unlink") return false;
  const path = repositoryRelativePathForWatcher(filePath, repositoryRoot);
  if (path === undefined) return false;
  if (classifyDevChange(path).kind === "ignored") return false;
  const priorIdentity = snapshot.get(path);
  if (event === "unlink") {
    snapshot.delete(path);
    return true;
  }

  const currentIdentity = fileIdentity(filePath);
  if (currentIdentity === undefined) {
    snapshot.delete(path);
    return true;
  }
  snapshot.set(path, currentIdentity);
  return event !== "add"
    || priorIdentity === undefined
    || priorIdentity !== currentIdentity;
}

/**
 * Re-captures every owned watch root so a coalesced or lost filesystem event
 * cannot hide an addition, content change, or deletion. The supplied snapshot
 * remains the current complete identity set after every reconciliation.
 */
export function reconcileDevWatchBaseline(
  watchPaths: readonly string[],
  repositoryRoot: string,
  snapshot: DevWatchBaseline,
): readonly RepositoryRelativePath[] {
  const current = captureDevWatchBaseline(watchPaths, repositoryRoot);
  const changed = new Set<RepositoryRelativePath>();
  for (const [path, identity] of current) {
    if (snapshot.get(path) !== identity) changed.add(path);
  }
  for (const path of snapshot.keys()) {
    if (!current.has(path)) changed.add(path);
  }

  snapshot.clear();
  for (const [path, identity] of current) snapshot.set(path, identity);
  return [...changed].sort((left, right) => left.localeCompare(right));
}

export function guardGatewayCandidateBuildWithReconciliation(
  buildCandidate: GatewayCandidateBuilder,
  reconcile: () => void,
): GatewayCandidateBuilder {
  return async (sourceRevision) => {
    const artifact = await buildCandidate(sourceRevision);
    try {
      reconcile();
      return artifact;
    } catch (error) {
      artifact.discard();
      throw error;
    }
  };
}

function extraWatchPaths(options: HraMalleableDevPluginOptions): readonly string[] {
  return [
    resolve(options.desktopRoot, "runtime"),
    resolve(options.desktopRoot, "contracts"),
    resolve(options.desktopRoot, "src"),
    resolve(options.desktopRoot, "app.zon"),
    resolve(options.desktopRoot, "build.zig"),
    resolve(options.desktopRoot, "build.zig.zon"),
    resolve(options.desktopRoot, "package.json"),
    resolve(options.desktopRoot, "tsconfig.json"),
    resolve(options.repositoryRoot, "bun.lock"),
    resolve(options.repositoryRoot, "bunfig.toml"),
    resolve(options.repositoryRoot, "package.json"),
    resolve(options.repositoryRoot, "turbo.json"),
    ...gatewayTransitiveWorkspaceWatchPaths(options.repositoryRoot),
  ];
}

export function hraMalleableDevPlugin(
  options: HraMalleableDevPluginOptions,
): Plugin {
  let coordinator: DevGatewayCoordinator | undefined;

  return {
    name: "hra-malleable-development",
    apply: "serve",
    handleHotUpdate(context: HmrContext) {
      const path = repositoryRelativePathForWatcher(context.file, options.repositoryRoot);
      if (path === undefined) return undefined;
      const classification = classifyDevChange(path);
      const modules = devHotUpdateModules(classification, context.modules);
      if (modules !== undefined) coordinator?.observe(path, classification);
      return modules;
    },
    configureServer(server) {
      let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
      const watchPaths = options.authority === "launcher"
        ? extraWatchPaths(options)
        : undefined;
      const baseline = watchPaths === undefined
        ? undefined
        : captureDevWatchBaseline(watchPaths, options.repositoryRoot);
      const fences = coldFenceRegistry();
      const initialColdFenceTarget = options.authority === "launcher"
        ? fences.get(options.sessionId)
        : undefined;
      const baseCandidateBuilder = options.buildCandidate ?? createGatewayCandidateBuilder({
        ...(process.env[HRA_DEV_BUN_EXECUTABLE_ENV] === undefined
          ? {}
          : { bunExecutable: process.env[HRA_DEV_BUN_EXECUTABLE_ENV] }),
        desktopRoot: options.desktopRoot,
      });
      const fenceReconciliationFailure = (error: unknown): void => {
        if (reconciliationTimer !== undefined) {
          clearInterval(reconciliationTimer);
          reconciliationTimer = undefined;
        }
        coordinator?.observe(
          parseRepositoryRelativePath("apps/desktop/package.json"),
          { kind: "restartRequired", target: "launcher" },
        );
        server.config.logger.error(
          `[hra dev] watcher reconciliation failed; restart this session: ${String(error)}`,
        );
      };
      const reconcileBeforeAuthorityBoundary = (): void => {
        if (watchPaths === undefined || baseline === undefined) {
          const error = new Error("HRA development watcher was not initialized.");
          fenceReconciliationFailure(error);
          throw error;
        }
        let changed: readonly RepositoryRelativePath[];
        try {
          changed = reconcileDevWatchBaseline(
            watchPaths,
            options.repositoryRoot,
            baseline,
          );
        } catch (error) {
          fenceReconciliationFailure(error);
          throw error;
        }
        for (const path of changed) coordinator?.observe(path, classifyDevChange(path));
      };
      coordinator = new DevGatewayCoordinator({
        authority: options.authority,
        buildCandidate: options.authority === "launcher"
          ? guardGatewayCandidateBuildWithReconciliation(
              baseCandidateBuilder,
              reconcileBeforeAuthorityBoundary,
            )
          : baseCandidateBuilder,
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
        ...(initialColdFenceTarget === undefined
          ? {}
          : { initialColdFenceTarget }),
        sessionId: options.sessionId,
        onColdFence: (target) => fences.set(options.sessionId, target),
        onStatus: (status) => {
          server.ws.send({ type: "custom", event: HRA_DEV_STATUS_EVENT, data: status });
        },
      });

      server.middlewares.use((request, response, next) => {
        const current = coordinator;
        if (current === undefined) {
          next();
          return;
        }
        const statusResult = devStatusResponseForRequest(
          request.method,
          request.url,
          current.status,
        );
        if (statusResult !== undefined) {
          writeResponse(response, statusResult);
          return;
        }
        if (mutationRoute(request.url) === undefined) {
          next();
          return;
        }
        if (request.method !== "POST") {
          writeResponse(response, errorResponse(405, "badRequest", { Allow: "POST" }));
          return;
        }
        if (options.authority !== "launcher") {
          writeResponse(response, errorResponse(403, "forbidden"));
          return;
        }
        if (headerValue(request.headers.origin) !== HRA_DEV_FRONTEND_ORIGIN) {
          writeResponse(response, errorResponse(403, "forbidden"));
          return;
        }
        if (headerValue(request.headers["content-type"]) !== "application/json") {
          writeResponse(response, errorResponse(415, "contentType"));
          return;
        }
        void (async () => {
          let body: string;
          try {
            body = await readBoundedRequestBody(request);
          } catch (error) {
            writeResponse(
              response,
              error instanceof DevRequestBodyTooLargeError
                ? errorResponse(413, "bodyTooLarge")
                : errorResponse(400, "badRequest"),
            );
            return;
          }
          const result = devMutationResponseForInput({
            authority: options.authority,
            body,
            contentType: headerValue(request.headers["content-type"]),
            method: request.method,
            origin: headerValue(request.headers.origin),
            sessionId: options.sessionId,
            url: request.url,
            beforeReserve: () => {
              try {
                reconcileBeforeAuthorityBoundary();
              } catch {
                // Reconciliation already installed a terminal launcher fence.
              }
            },
          }, current);
          if (result === undefined) {
            next();
            return;
          }
          writeResponse(response, result);
        })();
      });

      const cleanup = (): void => {
        if (reconciliationTimer !== undefined) {
          clearInterval(reconciliationTimer);
          reconciliationTimer = undefined;
        }
        coordinator?.dispose();
        coordinator = undefined;
      };
      server.watcher.once("close", cleanup);
      if (watchPaths === undefined || baseline === undefined) return;
      const observe = (event: string, filePath: string): void => {
        if (!shouldObserveDevWatchEvent(
          event,
          filePath,
          options.repositoryRoot,
          baseline,
        )) return;
        const path = repositoryRelativePathForWatcher(filePath, options.repositoryRoot);
        if (path === undefined) return;
        coordinator?.observe(path, classifyDevChange(path));
      };
      server.watcher.on("all", observe);
      server.watcher.add(watchPaths);
      const reconcileIntervalMs = options.reconcileIntervalMs
        ?? DEFAULT_DEV_WATCH_RECONCILE_INTERVAL_MS;
      if (!Number.isSafeInteger(reconcileIntervalMs) || reconcileIntervalMs <= 0) {
        throw new Error("HRA development watcher reconciliation requires a positive interval.");
      }
      reconciliationTimer = setInterval(() => {
        const current = coordinator;
        if (current === undefined) return;
        try {
          reconcileBeforeAuthorityBoundary();
        } catch {
          // Reconciliation already installed a terminal launcher fence.
          return;
        }
      }, reconcileIntervalMs);
      server.watcher.once("close", () => {
        server.watcher.off("all", observe);
      });
    },
  };
}
