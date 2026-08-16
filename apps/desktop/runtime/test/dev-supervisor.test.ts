import { describe, expect, test } from "bun:test";

import {
  advanceDevLaunch,
  devCleanupOrder,
  devSessionIdFromBytes,
  gatewayExecutableNameForNativeMode,
  maySpawnDevApp,
  nativeDevFrontendEnvironment,
  HRA_DEV_FRONTEND_URL,
  HRA_DEV_READY_SCHEMA,
  parseDevReadinessJson,
  parseDevReadinessResponse,
  scrubRetiredSelfEditEnvironment,
} from "../dev-protocol";
import {
  attemptDevAppSpawn,
  assertFixedDevPortAvailable,
  listenerAllowsViteStart,
  readinessRetryDelay,
  waitForDevReadiness,
} from "../dev-supervisor";

const sessionId = devSessionIdFromBytes(new Uint8Array(32).fill(0x2a));
const otherSessionId = devSessionIdFromBytes(new Uint8Array(32).fill(0x2b));

async function failureOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to fail.");
}

function readyBody(id = sessionId): string {
  return JSON.stringify({ schema: HRA_DEV_READY_SCHEMA, sessionId: id });
}

function readyResponse(body = readyBody()) {
  return {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body,
  } as const;
}

describe("HRA development readiness", () => {
  test("accepts only the exact schema and launch nonce", () => {
    expect(parseDevReadinessJson(readyBody(), sessionId)).toEqual({
      schema: HRA_DEV_READY_SCHEMA,
      sessionId,
    });
    expect(() => parseDevReadinessJson(readyBody(otherSessionId), sessionId)).toThrow(
      "different launch session",
    );
    expect(() => parseDevReadinessJson(
      JSON.stringify({ schema: "hra-vite-dev/v2", sessionId }),
      sessionId,
    )).toThrow("unsupported schema");
  });

  test("rejects malformed, widened, and weakly typed payloads", () => {
    for (const body of [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ schema: HRA_DEV_READY_SCHEMA }),
      JSON.stringify({ schema: HRA_DEV_READY_SCHEMA, sessionId, extra: true }),
      JSON.stringify({ schema: HRA_DEV_READY_SCHEMA, sessionId: sessionId.toUpperCase() }),
    ]) {
      expect(() => parseDevReadinessJson(body, sessionId)).toThrow();
    }
  });

  test("requires the endpoint's complete no-store response contract", () => {
    expect(parseDevReadinessResponse(readyResponse(), sessionId).sessionId).toBe(sessionId);
    expect(() => parseDevReadinessResponse(
      { ...readyResponse(), headers: { ...readyResponse().headers, "cache-control": "max-age=60" } },
      sessionId,
    )).toThrow("disable caching");
    expect(() => parseDevReadinessResponse(
      { ...readyResponse(), status: 404 },
      sessionId,
    )).toThrow("HTTP 404");
  });

  test("times out deterministically while no listener is reachable", async () => {
    let clock = 0;
    let probes = 0;
    const failure = await failureOf(waitForDevReadiness({
      expectedSessionId: sessionId,
      timeoutMs: 250,
      intervalMs: 100,
      now: () => clock,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      probe: () => {
        probes += 1;
        return Promise.resolve({ kind: "unreachable" });
      },
    }));
    expect(failure.message).toContain("timed out after 250ms");
    expect(clock).toBe(250);
    expect(probes).toBe(4);
    expect(readinessRetryDelay(250, 250, 100)).toBeNull();
  });

  test("fails immediately when a startup-race listener returns the wrong nonce", async () => {
    let slept = false;
    const failure = await failureOf(waitForDevReadiness({
      expectedSessionId: sessionId,
      probe: () => Promise.resolve({
        kind: "response",
        response: readyResponse(readyBody(otherSessionId)),
      }),
      sleep: () => {
        slept = true;
        return Promise.resolve();
      },
    }));
    expect(failure.message).toContain("different launch session");
    expect(slept).toBeFalse();
  });
});

describe("HRA development lifecycle", () => {
  test("keeps the Native-authority HMR workflow independent of production assets", async () => {
    const manifest = await Bun.file(
      new URL("../../package.json", import.meta.url),
    ).json() as { readonly scripts?: Readonly<Record<string, string>> };
    const rootManifest = await Bun.file(
      new URL("../../../../package.json", import.meta.url),
    ).json() as { readonly scripts?: Readonly<Record<string, string>> };
    const developmentBuild = manifest.scripts?.["build:runtime:dev"];
    const releaseBuild = manifest.scripts?.["build:runtime"];

    expect(developmentBuild).toContain("--sourcemap=inline");
    expect(developmentBuild).not.toContain("check:direct-boundary");
    expect(developmentBuild).not.toContain("build:frontend");
    expect(releaseBuild).toContain("--minify");
    expect(releaseBuild).toContain("check:direct-boundary");
    expect(manifest.scripts?.hra).toBe(
      "bun run build:runtime:dev && bun run runtime/run-native.ts dev",
    );
    expect(manifest.scripts?.operate).toBeUndefined();
    expect(rootManifest.scripts?.hra).toBe("bun run dev:desktop");
    expect(rootManifest.scripts?.operate).toBeUndefined();
    expect(rootManifest.scripts?.["web:hra"]).toBe("bun run dev:web");
  });

  test("scrubs retired self-edit markers from every development child", () => {
    expect(scrubRetiredSelfEditEnvironment({
      KEEP_ME: "yes",
      HRA_DEV_LOCAL_EXECUTION: "source-checkout",
      HRA_INTERNAL_DEV_SOURCE_ROOT: "/spoofed/root",
    })).toEqual({ KEEP_ME: "yes" });
  });

  test("refuses every reachable or indeterminate pre-existing listener", async () => {
    expect(listenerAllowsViteStart({ kind: "refused" })).toBeTrue();
    expect(listenerAllowsViteStart({ kind: "reachable" })).toBeFalse();
    expect(listenerAllowsViteStart({ kind: "indeterminate", detail: "timeout" })).toBeFalse();
    const failure = await failureOf(assertFixedDevPortAvailable(
      () => Promise.resolve({ kind: "reachable" }),
    ));
    expect(failure.message).toContain("never reuses an existing server");
  });

  test("gates app startup on listener preflight, Vite, build, and exact readiness", () => {
    let phase = advanceDevLaunch("checking-listener", "listener-clear");
    phase = advanceDevLaunch(phase, "vite-started");
    expect(() => advanceDevLaunch(phase, "readiness-matched")).toThrow("Invalid");
    phase = advanceDevLaunch(phase, "build-succeeded");
    phase = advanceDevLaunch(phase, "readiness-matched");
    expect(maySpawnDevApp(phase)).toBeTrue();
    phase = advanceDevLaunch(phase, "app-started");
    expect(phase).toBe("running");
  });

  test("late shutdown and Vite exit cannot cross the final app-spawn gate", () => {
    let spawns = 0;
    const spawn = (): string => {
      spawns += 1;
      return "app";
    };

    expect(attemptDevAppSpawn(
      { authorized: true, shutdownSignal: "SIGTERM" },
      spawn,
    )).toEqual({ kind: "shutdown", signal: "SIGTERM" });
    expect(attemptDevAppSpawn(
      { authorized: true, viteExitCode: 17 },
      spawn,
    )).toEqual({ code: 17, kind: "vite-exit" });
    expect(attemptDevAppSpawn({ authorized: false }, spawn)).toEqual({
      kind: "not-authorized",
    });
    expect(spawns).toBe(0);

    expect(attemptDevAppSpawn({ authorized: true }, spawn)).toEqual({
      kind: "spawned",
      value: "app",
    });
    expect(spawns).toBe(1);
  });

  test("refusal cannot advance and cleanup reverses process ownership", () => {
    const refused = advanceDevLaunch("checking-listener", "listener-reachable");
    expect(refused).toBe("refused");
    expect(() => advanceDevLaunch(refused, "vite-started")).toThrow("Invalid");
    expect(devCleanupOrder({ app: true, build: true, vite: true })).toEqual([
      "app",
      "build",
      "vite",
    ]);
    expect(devCleanupOrder({ app: false, build: false, vite: true })).toEqual(["vite"]);
  });

  test("keeps the source-mapped gateway out of bundled run and release paths", () => {
    expect(gatewayExecutableNameForNativeMode("dev")).toBe("oprte-gateway-dev");
    expect(gatewayExecutableNameForNativeMode("run")).toBe("oprte-gateway");
  });

  test("builds the native host's exact authenticated frontend envelope", () => {
    expect(nativeDevFrontendEnvironment(sessionId)).toEqual({
      NATIVE_SDK_FRONTEND_URL: HRA_DEV_FRONTEND_URL,
      NATIVE_SDK_HMR: "1",
      NATIVE_SDK_MODE: "dev",
      HRA_DEV_SESSION_ID: sessionId,
    });
  });

  test("retires the completed build process group before the app can run long enough for PID reuse", async () => {
    const source = await Bun.file(new URL("../run-native.ts", import.meta.url)).text();
    const retire = source.indexOf("await terminateOwnedProcessGroup(build);");
    const forget = source.indexOf("delete processes.build;", retire);
    const appSpawn = source.indexOf('spawnOwnedProcess("app"', forget);
    expect(retire).toBeGreaterThan(-1);
    expect(forget).toBeGreaterThan(retire);
    expect(appSpawn).toBeGreaterThan(forget);
  });
});
