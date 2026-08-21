import { describe, expect, test } from "bun:test";

import {
  advanceDevLaunch,
  devCleanupOrder,
  devSessionIdFromBytes,
  gatewayExecutableNameForNativeMode,
  maySpawnDevApp,
  nativeDevFrontendEnvironment,
  HRA_DEV_FRONTEND_URL,
  HRA_NATIVE_APPLICATION_EXECUTABLE,
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
import { nativeSourceHelperEnvironment } from "../run-native";

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
    const releaseBuilder = await Bun.file(
      new URL("../build-release-gateway.ts", import.meta.url),
    ).text();

    expect(developmentBuild).toContain("--sourcemap=inline");
    expect(developmentBuild).not.toContain("check:direct-boundary");
    expect(developmentBuild).not.toContain("build:frontend");
    expect(releaseBuild).toContain("build-release-gateway.ts");
    expect(releaseBuild).toContain("check:direct-boundary");
    expect(releaseBuilder).toContain("verifyBunCompiler");
    expect(releaseBuilder).toContain('"--minify"');
    expect(releaseBuilder).toContain('"--sourcemap=none"');
    expect(manifest.scripts?.hra).toBe("bun run runtime/run-native.ts dev");
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

  test("gates both builds and app startup on exact Vite watcher readiness", () => {
    let phase = advanceDevLaunch("checking-listener", "listener-clear");
    phase = advanceDevLaunch(phase, "vite-started");
    expect(() => advanceDevLaunch(phase, "gateway-build-succeeded")).toThrow("Invalid");
    phase = advanceDevLaunch(phase, "readiness-matched");
    expect(maySpawnDevApp(phase)).toBeFalse();
    phase = advanceDevLaunch(phase, "gateway-build-succeeded");
    phase = advanceDevLaunch(phase, "native-build-succeeded");
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
    expect(HRA_NATIVE_APPLICATION_EXECUTABLE).toBe("hra");
  });

  test("builds the native host's exact authenticated frontend envelope", () => {
    expect(nativeDevFrontendEnvironment(sessionId)).toEqual({
      NATIVE_SDK_FRONTEND_URL: HRA_DEV_FRONTEND_URL,
      NATIVE_SDK_HMR: "1",
      NATIVE_SDK_MODE: "dev",
      HRA_DEV_SESSION_ID: sessionId,
    });
  });

  test("binds source launches to the freshly built native helpers", () => {
    expect(nativeSourceHelperEnvironment("/private/tmp/hra/apps/desktop")).toEqual({
      HRA_DATA_REMOVER_PATH:
        "/private/tmp/hra/apps/desktop/zig-out/bin/oprte-data-remover",
      HRA_GIT_EXECUTOR_PATH:
        "/private/tmp/hra/apps/desktop/zig-out/bin/oprte-git-executor",
      HRA_IMAGE_NORMALIZER_PATH:
        "/private/tmp/hra/apps/desktop/zig-out/bin/hra-image-normalizer",
    });
  });

  test("does not authorize the raw Debug host to launch the Keychain custodian", async () => {
    const environment = nativeSourceHelperEnvironment(
      "/private/tmp/hra/apps/desktop",
    ) as Record<string, string>;
    expect(environment.HRA_KEYCHAIN_CUSTODIAN_PATH).toBeUndefined();
    const source = await Bun.file(new URL("../run-native.ts", import.meta.url)).text();
    expect(source).toContain(
      "Keychain-backed cloud features require the signed app and are disabled in raw Debug",
    );
    expect(source).toContain("delete environment.HRA_KEYCHAIN_CUSTODIAN_PATH");
    expect(source).toContain("delete environment.OPRTE_KEYCHAIN_CUSTODIAN_PATH");
    expect(source).toContain("delete environment.KITCHEN_KEYCHAIN_CUSTODIAN_PATH");
  });

  test("retires the completed build process group before the app can run long enough for PID reuse", async () => {
    const source = await Bun.file(new URL("../run-native.ts", import.meta.url)).text();
    const retire = source.indexOf("await terminateOwnedProcessGroup(nativeBuild);");
    const forget = source.indexOf("delete processes.build;", retire);
    const appSpawn = source.indexOf('spawnOwnedProcess("app"', forget);
    expect(retire).toBeGreaterThan(-1);
    expect(forget).toBeGreaterThan(retire);
    expect(appSpawn).toBeGreaterThan(forget);
  });

  test("proves the Vite watcher boundary before compiling either development binary", async () => {
    const source = await Bun.file(new URL("../run-native.ts", import.meta.url)).text();
    const viteSpawn = source.indexOf('[process.execPath, "run", "dev:frontend"]');
    const readiness = source.indexOf("await Promise.race([", viteSpawn);
    const readinessTransition = source.indexOf(
      'advanceDevLaunch(phase, "readiness-matched")',
      readiness,
    );
    const gatewayBuild = source.indexOf(
      '[process.execPath, "run", "build:runtime:dev"]',
      readinessTransition,
    );
    const nativeBuild = source.indexOf('console.log("[hra dev] compiling the Debug Zig host")');
    expect(viteSpawn).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(viteSpawn);
    expect(readinessTransition).toBeGreaterThan(readiness);
    expect(gatewayBuild).toBeGreaterThan(readinessTransition);
    expect(nativeBuild).toBeGreaterThan(gatewayBuild);
  });
});
