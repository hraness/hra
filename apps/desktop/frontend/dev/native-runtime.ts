import {
  parseRuntimeTransportLifecycle,
  runtimeTransportLifecycleEventName,
  type RuntimeSnapshot,
} from "../../contracts/runtime";
import {
  createRuntimeBridge,
  type RuntimeTransport,
} from "../src/runtime-bridge";

import {
  DEVELOPMENT_RELOAD_COMMAND,
  DevelopmentReloadAcceptedUnconfirmedError,
  DevelopmentReloadOutcomeUnconfirmedError,
  developmentReloadRequestJson,
  parseDevelopmentReloadResponse,
  type DevelopmentReloadResponse,
} from "./protocol";

const DEFAULT_READY_TIMEOUT_MILLISECONDS = 60_000;

interface ReadyGenerationObserver {
  readonly waitFor: (generation: number, timeoutMilliseconds?: number) => Promise<void>;
  readonly dispose: () => void;
}

export function createReadyGenerationObserver(
  transport: Pick<RuntimeTransport, "on">,
): ReadyGenerationObserver {
  const ready = new Set<number>();
  const waiters = new Map<number, Set<() => void>>();
  let disposed = false;
  let malformed = false;
  const unsubscribe = transport.on(runtimeTransportLifecycleEventName, (detail) => {
    let lifecycle;
    try {
      lifecycle = parseRuntimeTransportLifecycle(detail);
    } catch {
      malformed = true;
      for (const listeners of waiters.values()) {
        for (const listener of listeners) listener();
      }
      waiters.clear();
      return;
    }
    if (lifecycle.state !== "ready") return;
    ready.add(lifecycle.generation);
    const listeners = waiters.get(lifecycle.generation);
    if (listeners === undefined) return;
    waiters.delete(lifecycle.generation);
    for (const listener of listeners) listener();
  });

  return {
    async waitFor(generation, timeoutMilliseconds = DEFAULT_READY_TIMEOUT_MILLISECONDS) {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("The expected development runtime generation is invalid.");
      }
      if (
        !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds < 1 ||
        timeoutMilliseconds > DEFAULT_READY_TIMEOUT_MILLISECONDS
      ) throw new Error("The development runtime readiness deadline is invalid.");
      if (disposed || malformed) {
        throw new Error("Development runtime readiness is unavailable.");
      }
      if (ready.has(generation)) return;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const listeners = waiters.get(generation) ?? new Set<() => void>();
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          listeners.delete(settle);
          if (listeners.size === 0) waiters.delete(generation);
          if (malformed || disposed) {
            reject(new Error("Development runtime readiness is unavailable."));
            return;
          }
          resolve();
        };
        listeners.add(settle);
        waiters.set(generation, listeners);
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          listeners.delete(settle);
          if (listeners.size === 0) waiters.delete(generation);
          reject(new Error("The staged runtime did not become ready in time."));
        }, timeoutMilliseconds);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const listeners of waiters.values()) {
        for (const listener of listeners) listener();
      }
      waiters.clear();
    },
  };
}

export async function takeAuthoritativeRuntimeSnapshot(
  transport: RuntimeTransport,
): Promise<RuntimeSnapshot> {
  return await createRuntimeBridge(transport).snapshot();
}

export async function reloadAndConfirmDevelopmentCandidate(
  transport: RuntimeTransport,
  candidateId: string,
  readyTimeoutMilliseconds = DEFAULT_READY_TIMEOUT_MILLISECONDS,
): Promise<DevelopmentReloadResponse> {
  const observer = createReadyGenerationObserver(transport);
  try {
    let response: DevelopmentReloadResponse;
    try {
      response = parseDevelopmentReloadResponse(await transport.invoke(
        DEVELOPMENT_RELOAD_COMMAND,
        developmentReloadRequestJson(candidateId),
      ));
    } catch (cause: unknown) {
      // Once the exact candidate is reserved, a lost or malformed Native
      // response cannot prove whether Native committed the generation switch.
      throw new DevelopmentReloadOutcomeUnconfirmedError(cause);
    }
    if (response.status !== "accepted") {
      return response;
    }
    try {
      if (response.candidateId !== candidateId) {
        throw new Error("Native accepted a different development candidate.");
      }
      await observer.waitFor(response.nextGeneration, readyTimeoutMilliseconds);
      // A ready lifecycle is necessary but the parsed snapshot is the final
      // renderer authority before the coordinator may forget this candidate.
      await takeAuthoritativeRuntimeSnapshot(transport);
      return response;
    } catch (cause: unknown) {
      throw new DevelopmentReloadAcceptedUnconfirmedError(response, cause);
    }
  } finally {
    observer.dispose();
  }
}
