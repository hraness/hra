import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "vite";

import { devSessionIdFromBytes } from "../dev-protocol";
import {
  classifyDevChange,
  HRA_GATEWAY_TRANSITIVE_WORKSPACE_ROOTS,
  parseAndClassifyDevChange,
  parseRepositoryRelativePath,
  type RepositoryRelativePath,
} from "../dev/change-classifier";
import { classifyDevPathLine } from "../dev/classify";
import { gatewayCandidatePath, stageGatewayCandidateFile } from "../dev/gateway-builder";
import {
  DevGatewayCoordinator,
  type StagedGatewayArtifact,
} from "../dev/gateway-coordinator";
import {
  captureDevWatchBaseline,
  devHotUpdateModules,
  devMutationResponseForInput,
  devStatusResponseForRequest,
  gatewayTransitiveWorkspaceWatchPaths,
  guardGatewayCandidateBuildWithReconciliation,
  hraMalleableDevPlugin,
  reconcileDevWatchBaseline,
  repositoryRelativePathForWatcher,
  shouldObserveDevWatchEvent,
} from "../dev/vite-plugin";
import {
  createInitialDevStatus,
  HRA_DEV_APPLY_PATH,
  HRA_DEV_APPLY_SCHEMA,
  HRA_DEV_FRONTEND_ORIGIN,
  HRA_DEV_STATUS_EVENT,
  HRA_DEV_STATUS_SCHEMA,
  parseDevCandidateId,
  parseDevStatusEnvelope,
} from "../dev/status-protocol";

const sessionId = devSessionIdFromBytes(new Uint8Array(32).fill(0x41));
const otherSessionId = devSessionIdFromBytes(new Uint8Array(32).fill(0x42));
const candidateA = parseDevCandidateId("a".repeat(64));
const candidateB = parseDevCandidateId("b".repeat(64));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

function sourcePath(value: string): RepositoryRelativePath {
  return parseRepositoryRelativePath(value);
}

function artifact(
  candidateId: typeof candidateA,
  promoted: string[],
  discarded: string[],
): StagedGatewayArtifact {
  return {
    candidateId,
    adopt: () => promoted.push(candidateId),
    discard: () => discarded.push(candidateId),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((finish) => {
      resolve = finish;
    }),
    resolve,
  };
}

describe("development change classification", () => {
  test("rejects absolute, ambiguous, and traversal paths", () => {
    for (const value of [
      "",
      "/apps/desktop/runtime/src/main.ts",
      "../runtime/src/main.ts",
      "apps/../runtime/src/main.ts",
      "./apps/desktop/runtime/src/main.ts",
      "apps//desktop/runtime/src/main.ts",
      "apps\\desktop\\runtime\\src\\main.ts",
      "C:/apps/desktop/runtime/src/main.ts",
    ]) expect(() => parseRepositoryRelativePath(value)).toThrow();

    expect(String(repositoryRelativePathForWatcher(
      "/repo/apps/desktop/runtime/src/main.ts",
      "/repo",
    ))).toBe("apps/desktop/runtime/src/main.ts");
    expect(repositoryRelativePathForWatcher("/outside/main.ts", "/repo")).toBeUndefined();
  });

  test("keeps UI live, stages the active actor-instruction seam, and ignores docs and tests", () => {
    expect(parseAndClassifyDevChange("apps/desktop/frontend/src/App.tsx")).toEqual({
      kind: "frontendLive",
    });
    expect(parseAndClassifyDevChange("apps/desktop/frontend/src/index.css")).toEqual({
      kind: "frontendLive",
    });
    expect(parseAndClassifyDevChange("apps/desktop/frontend/dev/DevHud.tsx")).toEqual({
      kind: "frontendLive",
    });
    expect(parseAndClassifyDevChange(
      "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json",
    )).toEqual({ kind: "gatewayReload" });
    expect(parseAndClassifyDevChange(
      "apps/desktop/runtime/test/harness-key-custody.test.ts",
    )).toEqual({ kind: "ignored" });
    expect(parseAndClassifyDevChange("apps/desktop/README.md")).toEqual({ kind: "ignored" });
  });

  test("the allowlisted actor-instruction seam is present in the gateway build graph", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "hra-dev-gateway-graph-"));
    temporaryDirectories.push(outputRoot);
    const outputPath = join(outputRoot, "gateway.js");
    const child = Bun.spawn([
      process.execPath,
      "build",
      join(import.meta.dir, "../src/main.ts"),
      "--target=bun",
      "--sourcemap=none",
      "--outfile",
      outputPath,
    ], {
      cwd: join(import.meta.dir, "../.."),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const compiled = await readFile(outputPath, "utf8");
    expect(compiled).toContain("You are a persistent HRA recursive actor.");
    expect(compiled).toContain("bounded parallel actors for independent research");
  });

  test("keeps the active policy value and renderer out of Vite config dependencies", async () => {
    const config = await resolveConfig({
      configFile: join(import.meta.dir, "../../frontend/vite.config.ts"),
      mode: "development",
    }, "serve");
    const dependencies = config.configFileDependencies.map((path) => path.replaceAll("\\", "/"));
    expect(dependencies.some((path) => path.endsWith(
      "/apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json",
    ))).toBeFalse();
    expect(dependencies.some((path) => path.endsWith(
      "/apps/desktop/runtime/src/harness/actor-instruction-policy-v1.ts",
    ))).toBeFalse();
    expect(dependencies.some((path) => path.endsWith(
      "/apps/desktop/runtime/src/harness/actor-instruction-policy-schema-v1.ts",
    ))).toBeTrue();

    const policyPath = sourcePath(
      "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json",
    );
    const classification = classifyDevChange(policyPath);
    expect(classification).toEqual({ kind: "gatewayReload" });
    const discarded: string[] = [];
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      buildCandidate: () => Promise.resolve(artifact(candidateA, [], discarded)),
      debounceMs: 0,
      sessionId,
    });
    coordinator.observe(policyPath, classification);
    await coordinator.settle();
    expect(coordinator.status).toMatchObject({
      state: "staged",
      target: "gateway",
      candidateId: candidateA,
    });
    coordinator.dispose();
    expect(discarded).toEqual([candidateA]);
  });

  test("cold boundaries dominate the generic gateway rule", () => {
    for (const path of [
      "apps/desktop/contracts/runtime.ts",
      "apps/desktop/runtime/src/host-protocol.ts",
      "apps/desktop/runtime/src/development-reload.ts",
      "apps/desktop/runtime/src/runtime-paths.ts",
      "apps/desktop/runtime/src/accounts/protocol.ts",
      "apps/desktop/runtime/src/accounts/local-data-remover.ts",
      "apps/desktop/runtime/src/maintenance/local-data-removal.ts",
      "apps/desktop/runtime/src/package-smoke.ts",
      "apps/desktop/runtime/src/state/migrations.ts",
      "apps/desktop/runtime/src/state/session-sync-schema.ts",
      "apps/desktop/runtime/src/state/database.ts",
      "apps/desktop/runtime/src/harness/sqlite-authority-v2.ts",
      "apps/desktop/runtime/src/accounts/profile-store.ts",
      "apps/desktop/runtime/src/sessions/store.ts",
      "apps/desktop/runtime/src/harness/storage-layout.ts",
      "apps/desktop/runtime/src/security/environment.ts",
      "apps/desktop/runtime/src/cloud/keychain-custody.ts",
      "apps/desktop/runtime/src/cloud/session-sync-local-crypto.ts",
      "apps/desktop/runtime/src/cloud/interaction-sealer.ts",
      "apps/desktop/runtime/src/state/release-compatibility.ts",
      "apps/desktop/frontend/dev/apply.ts",
      "apps/desktop/frontend/dev/main.dev.tsx",
      "apps/desktop/frontend/dev/vite-plugin.ts",
      "apps/desktop/frontend/dev/protocol.ts",
      "apps/desktop/frontend/dev/native-runtime.ts",
      "apps/desktop/frontend/dev/root-lease.ts",
      "apps/desktop/frontend/dev/status-client.ts",
    ]) {
      expect(parseAndClassifyDevChange(path)).toEqual({
        kind: "restartRequired",
        target: "launcher",
      });
    }
    expect(parseAndClassifyDevChange("apps/desktop/src/runtime_host.zig")).toEqual({
      kind: "restartRequired",
      target: "native",
    });
    expect(parseAndClassifyDevChange("apps/desktop/package.json")).toEqual({
      kind: "restartRequired",
      target: "launcher",
    });
  });

  test("keeps durable boot and recovery cold while the fresh-thread instruction policy stays live", () => {
    for (const path of [
      "apps/desktop/runtime/src/chat/chat-service.ts",
      "apps/desktop/runtime/src/cloud/human-account-service.ts",
      "apps/desktop/runtime/src/cloud/invalidation-coordinator.ts",
      "apps/desktop/runtime/src/cloud/session-sync-coordinator.ts",
      "apps/desktop/runtime/src/harness/actor-domain.ts",
      "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.ts",
      "apps/desktop/runtime/src/harness/actor-result-transfer-v2.ts",
      "apps/desktop/runtime/src/harness/actor-projection-reconciler-v2.ts",
      "apps/desktop/runtime/src/harness/actor-session-recovery-v2.ts",
      "apps/desktop/runtime/src/harness/actor-workspace-runtime-v2.ts",
      "apps/desktop/runtime/src/harness/boot-aware-root-projection-v2.ts",
      "apps/desktop/runtime/src/harness/codex-persistent-actor-provider.ts",
      "apps/desktop/runtime/src/harness/completed-prefix-container-v2.ts",
      "apps/desktop/runtime/src/harness/context-operation-service-v2.ts",
      "apps/desktop/runtime/src/harness/context-recovery-v2.ts",
      "apps/desktop/runtime/src/harness/context-snapshot-authority-v2.ts",
      "apps/desktop/runtime/src/harness/domain.ts",
      "apps/desktop/runtime/src/harness/metaharness-policy-v1.ts",
      "apps/desktop/runtime/src/harness/optimizer-domain-v1.ts",
      "apps/desktop/runtime/src/harness/optimizer-evidence-v1.ts",
      "apps/desktop/runtime/src/harness/persistent-actor-liveness-binding-v2.ts",
      "apps/desktop/runtime/src/harness/persistent-actor-liveness-v2.ts",
      "apps/desktop/runtime/src/harness/persistent-actors.ts",
      "apps/desktop/runtime/src/harness/production-composition-v2.ts",
      "apps/desktop/runtime/src/harness/production-graph-v2.ts",
      "apps/desktop/runtime/src/harness/production-lifecycle-kernel-v2.ts",
      "apps/desktop/runtime/src/harness/production-adapters-v2.ts",
      "apps/desktop/runtime/src/harness/program-admission-intent-v2.ts",
      "apps/desktop/runtime/src/harness/program-admission-run-recovery-v2.ts",
      "apps/desktop/runtime/src/harness/proposal-service.ts",
      "apps/desktop/runtime/src/harness/provider-capability-reconciler-v2.ts",
      "apps/desktop/runtime/src/harness/renderer-authority-v2.ts",
      "apps/desktop/runtime/src/harness/renderer-service-v2.ts",
      "apps/desktop/runtime/src/harness/rlm-caller-authority-v2.ts",
      "apps/desktop/runtime/src/harness/rlm-operation-router-v2.ts",
      "apps/desktop/runtime/src/harness/rlm-run-authority-v2.ts",
      "apps/desktop/runtime/src/harness/rlm-runtime-v2.ts",
      "apps/desktop/runtime/src/harness/rlm-v2.ts",
      "apps/desktop/runtime/src/harness/root-actor-authority-v2.ts",
      "apps/desktop/runtime/src/harness/root-session-lifecycle-v2.ts",
      "apps/desktop/runtime/src/main.ts",
      "apps/desktop/runtime/src/promotion/coordinator.ts",
      "apps/desktop/runtime/src/tasks/reconciler.ts",
    ]) {
      expect(parseAndClassifyDevChange(path)).toEqual({
        kind: "restartRequired",
        target: "launcher",
      });
    }
    expect(parseAndClassifyDevChange(
      "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json",
    )).toEqual({ kind: "gatewayReload" });
  });

  test("keeps the provider boot stack and pre-snapshot projection cold", () => {
    for (const path of [
      "apps/desktop/runtime/src/accounts/account-service.ts",
      "apps/desktop/runtime/src/accounts/runtime-router.ts",
      "apps/desktop/runtime/src/sessions/session-service.ts",
      "apps/desktop/runtime/src/sessions/command-executor.ts",
      "apps/desktop/runtime/src/codex/reconciliation.ts",
      "apps/desktop/runtime/src/codex/dynamic-tool.ts",
      "apps/desktop/runtime/src/codex/app-server-process.ts",
      "apps/desktop/runtime/src/codex/pinned-protocol.ts",
      "apps/desktop/runtime/src/projection/projection.ts",
    ]) {
      expect(parseAndClassifyDevChange(path)).toEqual({
        kind: "restartRequired",
        target: "launcher",
      });
    }
  });

  test("defaults every other runtime module to a cold launcher restart", () => {
    for (const path of [
      "apps/desktop/runtime/src/app-server-process.ts",
      "apps/desktop/runtime/src/snapshot-transfer.ts",
      "apps/desktop/runtime/src/chat/projection.ts",
      "apps/desktop/runtime/src/cloud/config.ts",
      "apps/desktop/runtime/src/cloud/http-client.ts",
      "apps/desktop/runtime/src/dispatch/coordinator.ts",
      "apps/desktop/runtime/src/dispatch/session-launcher.ts",
      "apps/desktop/runtime/src/harness/context-value-ports-v2.ts",
      "apps/desktop/runtime/src/harness/dynamic-tool-service-v2.ts",
      "apps/desktop/runtime/src/harness/renderer-effects-v2.ts",
      "apps/desktop/runtime/src/harness/semantic-gate.ts",
      "apps/desktop/runtime/src/promotion/http-transport.ts",
      "apps/desktop/runtime/src/tasks/handler-adapter.ts",
      "apps/desktop/runtime/src/tasks/local-run-executor.ts",
      "apps/desktop/runtime/src/workspaces/workspace-broker.ts",
    ]) {
      expect(parseAndClassifyDevChange(path)).toEqual({
        kind: "restartRequired",
        target: "launcher",
      });
    }
  });

  test("watches every gateway transitive workspace source root as a cold boundary", () => {
    expect(HRA_GATEWAY_TRANSITIVE_WORKSPACE_ROOTS).toEqual([
      "packages/human-client",
      "packages/task-protocol",
      "packages/task-domain",
      "packages/internal/schema",
      "packages/internal/codex-app-sdk",
    ]);
    expect(gatewayTransitiveWorkspaceWatchPaths("/repo")).toEqual([
      "/repo/packages/human-client",
      "/repo/packages/task-protocol",
      "/repo/packages/task-domain",
      "/repo/packages/internal/schema",
      "/repo/packages/internal/codex-app-sdk",
    ]);
    for (const path of [
      "packages/human-client/src/human-auth.ts",
      "packages/task-protocol/src/dispatch-identifiers.ts",
      "packages/task-domain/src/client.ts",
      "packages/internal/schema/src/index.ts",
      "packages/internal/codex-app-sdk/src/client-host.ts",
      "packages/human-client/package.json",
      "packages/task-protocol/tsconfig.json",
    ]) {
      expect(parseAndClassifyDevChange(path)).toEqual({
        kind: "restartRequired",
        target: "launcher",
      });
    }
  });

  test("keeps unchanged initial adds in the watcher snapshot and observes later events", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hra-dev-watch-"));
    temporaryDirectories.push(repositoryRoot);
    const packageRoot = join(repositoryRoot, "packages", "human-client");
    const sourceRoot = join(packageRoot, "src");
    await mkdir(sourceRoot, { recursive: true });
    const existingSource = join(sourceRoot, "client.ts");
    const packageManifest = join(packageRoot, "package.json");
    await writeFile(existingSource, "export const client = true;\n");
    await writeFile(packageManifest, "{}\n");

    const baseline = captureDevWatchBaseline([packageRoot], repositoryRoot);
    const existingPath = sourcePath("packages/human-client/src/client.ts");
    const manifestPath = sourcePath("packages/human-client/package.json");
    const existingIdentity = baseline.get(existingPath);
    const manifestIdentity = baseline.get(manifestPath);
    expect(existingIdentity).toBeDefined();
    expect(manifestIdentity).toBeDefined();
    expect(shouldObserveDevWatchEvent(
      "add",
      existingSource,
      repositoryRoot,
      baseline,
    )).toBe(false);
    expect(shouldObserveDevWatchEvent(
      "add",
      packageManifest,
      repositoryRoot,
      baseline,
    )).toBe(false);
    expect(baseline.get(existingPath)).toBe(existingIdentity);
    expect(baseline.get(manifestPath)).toBe(manifestIdentity);

    const newSource = join(sourceRoot, "new-client.ts");
    await writeFile(newSource, "export const next = true;\n");
    expect(shouldObserveDevWatchEvent("add", newSource, repositoryRoot, baseline)).toBe(true);
    expect(baseline.has(sourcePath("packages/human-client/src/new-client.ts"))).toBeTrue();
    await writeFile(existingSource, "export const clientChanged = 'longer';\n");
    expect(shouldObserveDevWatchEvent("change", existingSource, repositoryRoot, baseline)).toBe(true);
    await unlink(existingSource);
    expect(shouldObserveDevWatchEvent("unlink", existingSource, repositoryRoot, baseline)).toBe(true);
    expect(baseline.has(existingPath)).toBeFalse();
  });

  test("reconciles additions, changes, and a vanished baseline file without events", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hra-dev-reconcile-"));
    temporaryDirectories.push(repositoryRoot);
    const packageRoot = join(repositoryRoot, "packages", "human-client");
    const sourceRoot = join(packageRoot, "src");
    await mkdir(sourceRoot, { recursive: true });
    const existingSource = join(sourceRoot, "client.ts");
    const deletedManifest = join(packageRoot, "package.json");
    await writeFile(existingSource, "export const client = true;\n");
    await writeFile(deletedManifest, "{}\n");

    const baseline = captureDevWatchBaseline([packageRoot], repositoryRoot);
    const addedSource = join(sourceRoot, "added.ts");
    await writeFile(existingSource, "export const clientChanged = 'longer';\n");
    await writeFile(addedSource, "export const added = true;\n");
    await unlink(deletedManifest);

    expect(reconcileDevWatchBaseline(
      [packageRoot],
      repositoryRoot,
      baseline,
    )).toEqual([
      sourcePath("packages/human-client/package.json"),
      sourcePath("packages/human-client/src/added.ts"),
      sourcePath("packages/human-client/src/client.ts"),
    ]);
    expect(baseline.has(sourcePath("packages/human-client/package.json"))).toBeFalse();
    expect(baseline.has(sourcePath("packages/human-client/src/added.ts"))).toBeTrue();
    expect(reconcileDevWatchBaseline([packageRoot], repositoryRoot, baseline)).toEqual([]);
  });

  test("suppresses the renderer half of a cold shared-contract update", () => {
    const contract = classifyDevChange(sourcePath("apps/desktop/contracts/runtime.ts"));
    const frontend = classifyDevChange(sourcePath("apps/desktop/frontend/src/App.tsx"));
    expect(devHotUpdateModules(contract, [])).toEqual([]);
    expect(devHotUpdateModules(frontend, [])).toBeUndefined();
  });

  test("prints the exact live/staged/restart heuristic without accepting absolute paths", () => {
    expect(classifyDevPathLine("apps/desktop/frontend/src/App.tsx")).toBe(
      "apps/desktop/frontend/src/App.tsx\tlive\tVite HMR",
    );
    expect(classifyDevPathLine(
      "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json",
    )).toBe(
      "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json\tstaged\tgateway apply",
    );
    expect(classifyDevPathLine("apps/desktop/src/main.zig")).toBe(
      "apps/desktop/src/main.zig\trestart\tnative host boundary",
    );
    expect(() => classifyDevPathLine("/private/source.ts")).toThrow();
  });
});

describe("bounded development status protocol", () => {
  test("makes UI-only authority structurally incapable of staging or applying", () => {
    expect(createInitialDevStatus(sessionId, "uiOnly")).toEqual({
      schema: HRA_DEV_STATUS_SCHEMA,
      sessionId,
      authority: "uiOnly",
      revision: 0,
      state: "current",
      target: "none",
      changeCount: 0,
      candidateId: null,
    });
    expect(() => parseDevStatusEnvelope({
      ...createInitialDevStatus(sessionId, "uiOnly"),
      state: "staged",
      target: "gateway",
      changeCount: 1,
      candidateId: candidateA,
    })).toThrow("cannot claim launcher authority");
  });

  test("serves no-store status and strictly authenticates mutations", () => {
    const status = parseDevStatusEnvelope({
      ...createInitialDevStatus(sessionId, "launcher"),
      revision: 1,
      state: "staged",
      target: "gateway",
      changeCount: 1,
      candidateId: candidateA,
    });
    const coordinator = {
      reserve: () => ({ kind: "ok", status }) as const,
      acknowledge: () => ({ kind: "conflict", status }) as const,
      cancel: () => ({ kind: "conflict", status }) as const,
    };
    const get = devStatusResponseForRequest("GET", "/__hra_dev_status", status);
    expect(get?.statusCode).toBe(200);
    expect(get?.headers["Cache-Control"]).toBe("no-store");
    expect(get?.headers["X-Content-Type-Options"]).toBe("nosniff");

    const body = JSON.stringify({
      schema: HRA_DEV_APPLY_SCHEMA,
      sessionId,
      candidateId: candidateA,
    });
    expect(devMutationResponseForInput({
      authority: "launcher",
      body,
      contentType: "application/json",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(200);
    expect(devMutationResponseForInput({
      authority: "uiOnly",
      body,
      contentType: "application/json",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(403);
    expect(devMutationResponseForInput({
      authority: "launcher",
      body,
      contentType: "application/json; charset=utf-8",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(415);
    expect(devMutationResponseForInput({
      authority: "launcher",
      body,
      contentType: "application/json",
      method: "POST",
      origin: "http://localhost:5173",
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(403);
    expect(devMutationResponseForInput({
      authority: "launcher",
      body: JSON.stringify({
        schema: HRA_DEV_APPLY_SCHEMA,
        sessionId,
        candidateId: candidateA,
        path: "/private/gateway",
      }),
      contentType: "application/json",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(400);
    expect(devMutationResponseForInput({
      authority: "launcher",
      body: JSON.stringify({
        schema: HRA_DEV_APPLY_SCHEMA,
        sessionId: otherSessionId,
        candidateId: candidateA,
      }),
      contentType: "application/json",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(403);
    expect(devMutationResponseForInput({
      authority: "launcher",
      body: "x".repeat(1_025),
      contentType: "application/json",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator)?.statusCode).toBe(413);
  });

  test("the malleability plugin is serve-only and uses one custom event", () => {
    const plugin = hraMalleableDevPlugin({
      authority: "uiOnly",
      buildCandidate: () => Promise.reject(new Error("must not build")),
      desktopRoot: "/repo/apps/desktop",
      repositoryRoot: "/repo",
      sessionId,
    });
    expect(plugin.apply).toBe("serve");
    expect(HRA_DEV_STATUS_EVENT).toBe("hra:dev-status");
  });
});

describe("gateway candidate coordination", () => {
  test("a cold edit during candidate compilation fences the post-build staging boundary", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hra-dev-build-race-"));
    temporaryDirectories.push(repositoryRoot);
    const packageRoot = join(repositoryRoot, "packages", "human-client");
    await mkdir(packageRoot, { recursive: true });
    const packageManifest = join(packageRoot, "package.json");
    await writeFile(packageManifest, "{}\n");
    const baseline = captureDevWatchBaseline([packageRoot], repositoryRoot);
    const candidate = deferred<StagedGatewayArtifact>();
    const promoted: string[] = [];
    const discarded: string[] = [];
    const guardedBuild = guardGatewayCandidateBuildWithReconciliation(
      () => candidate.promise,
      () => {
        for (const path of reconcileDevWatchBaseline(
          [packageRoot],
          repositoryRoot,
          baseline,
        )) coordinator.observe(path, classifyDevChange(path));
      },
    );
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      buildCandidate: guardedBuild,
      debounceMs: 0,
      sessionId,
    });
    coordinator.observe(
      sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"),
      { kind: "gatewayReload" },
    );
    const settling = coordinator.settle();
    await writeFile(packageManifest, '{"cold":true}\n');
    candidate.resolve(artifact(candidateA, promoted, discarded));
    await settling;

    expect(promoted).toEqual([]);
    expect(discarded).toEqual([candidateA]);
    expect(coordinator.status).toMatchObject({
      state: "restartRequired",
      target: "launcher",
      candidateId: null,
    });
  });

  test("a cold edit after staging is reconciled before reserve", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hra-dev-reserve-race-"));
    temporaryDirectories.push(repositoryRoot);
    const packageRoot = join(repositoryRoot, "packages", "human-client");
    await mkdir(packageRoot, { recursive: true });
    const packageManifest = join(packageRoot, "package.json");
    await writeFile(packageManifest, "{}\n");
    const baseline = captureDevWatchBaseline([packageRoot], repositoryRoot);
    const promoted: string[] = [];
    const discarded: string[] = [];
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      buildCandidate: () => Promise.resolve(artifact(candidateA, promoted, discarded)),
      debounceMs: 0,
      sessionId,
    });
    coordinator.observe(
      sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"),
      { kind: "gatewayReload" },
    );
    await coordinator.settle();
    expect(coordinator.status.state).toBe("staged");
    await writeFile(packageManifest, '{"cold":true}\n');

    const response = devMutationResponseForInput({
      authority: "launcher",
      beforeReserve: () => {
        for (const path of reconcileDevWatchBaseline(
          [packageRoot],
          repositoryRoot,
          baseline,
        )) coordinator.observe(path, classifyDevChange(path));
      },
      body: JSON.stringify({
        schema: HRA_DEV_APPLY_SCHEMA,
        sessionId,
        candidateId: candidateA,
      }),
      contentType: "application/json",
      method: "POST",
      origin: HRA_DEV_FRONTEND_ORIGIN,
      sessionId,
      url: HRA_DEV_APPLY_PATH,
    }, coordinator);

    expect(response?.statusCode).toBe(409);
    expect(promoted).toEqual([]);
    expect(discarded).toEqual([candidateA]);
    expect(coordinator.status).toMatchObject({
      state: "restartRequired",
      target: "launcher",
      candidateId: null,
    });
  });

  test("discards stale builds and stages only the latest candidate", async () => {
    const promoted: string[] = [];
    const discarded: string[] = [];
    const first = deferred<StagedGatewayArtifact>();
    const builds: number[] = [];
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: (revision) => {
        builds.push(revision);
        return builds.length === 1
          ? first.promise
          : Promise.resolve(artifact(candidateB, promoted, discarded));
      },
    });

    coordinator.observe(
      sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"),
      { kind: "gatewayReload" },
    );
    const settling = coordinator.settle();
    expect(builds).toEqual([1]);
    coordinator.observe(
      sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"),
      { kind: "gatewayReload" },
    );
    first.resolve(artifact(candidateA, promoted, discarded));
    await settling;

    expect(builds).toEqual([1, 2]);
    expect(discarded).toEqual([candidateA]);
    expect(promoted).toEqual([]);
    expect(coordinator.status).toMatchObject({
      state: "staged",
      candidateId: candidateB,
      changeCount: 1,
    });
  });

  test("keeps the stable gateway untouched on a failed newer build", async () => {
    const promoted: string[] = [];
    const discarded: string[] = [];
    let builds = 0;
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => {
        builds += 1;
        return builds === 1
          ? Promise.resolve(artifact(candidateA, promoted, discarded))
          : Promise.reject(new Error("compile failed"));
      },
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    await coordinator.settle();
    coordinator.observe(
      sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"),
      { kind: "gatewayReload" },
    );
    await coordinator.settle();

    expect(promoted).toEqual([]);
    expect(discarded).toEqual([candidateA]);
    expect(coordinator.status).toMatchObject({ state: "failed", candidateId: null });
  });

  test("reserves one stable candidate while later edits coalesce", async () => {
    const promoted: string[] = [];
    const discarded: string[] = [];
    const candidates = [candidateA, candidateB];
    let builds = 0;
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => Promise.resolve(
        artifact(candidates[builds++] ?? candidateB, promoted, discarded),
      ),
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    await coordinator.settle();
    expect(coordinator.reserve(candidateA).status.state).toBe("applying");
    coordinator.observe(
      sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"),
      { kind: "gatewayReload" },
    );
    await coordinator.settle();
    expect(builds).toBe(1);
    expect(promoted).toEqual([]);

    expect(coordinator.cancel(candidateA).kind).toBe("ok");
    await coordinator.settle();
    expect(builds).toBe(2);
    expect(promoted).toEqual([]);
    expect(coordinator.status).toMatchObject({ state: "staged", candidateId: candidateB });
    expect(coordinator.cancel(candidateA).kind).toBe("ok");
    expect(coordinator.reserve(candidateB).kind).toBe("ok");
    expect(coordinator.acknowledge(candidateB).kind).toBe("ok");
    expect(promoted).toEqual([candidateB]);
  });

  test("a cancelled candidate can be reserved and cancelled again", async () => {
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => Promise.resolve(artifact(candidateA, [], [])),
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    await coordinator.settle();
    expect(coordinator.reserve(candidateA).status.state).toBe("applying");
    expect(coordinator.cancel(candidateA).status.state).toBe("staged");
    expect(coordinator.reserve(candidateA).status.state).toBe("applying");
    expect(coordinator.cancel(candidateA).status.state).toBe("staged");
  });

  test("an adoption failure remains applying and never claims current", async () => {
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => Promise.resolve({
        candidateId: candidateA,
        adopt: () => {
          throw new Error("atomic adoption failed");
        },
        discard: () => undefined,
      }),
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    await coordinator.settle();
    expect(coordinator.reserve(candidateA).status.state).toBe("applying");
    const acknowledgement = coordinator.acknowledge(candidateA);
    expect(acknowledgement.kind).toBe("conflict");
    expect(acknowledgement.status).toMatchObject({
      state: "applying",
      candidateId: candidateA,
    });
  });

  test("disposing a staged coordinator removes only its unadopted sibling", async () => {
    const discarded: string[] = [];
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => Promise.resolve(artifact(candidateA, [], discarded)),
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    await coordinator.settle();
    coordinator.dispose();
    expect(discarded).toEqual([candidateA]);
  });

  test("a cold change waits for the reserved apply and then exposes only restart", async () => {
    const adopted: string[] = [];
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => Promise.resolve(artifact(candidateA, adopted, [])),
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    await coordinator.settle();
    expect(coordinator.reserve(candidateA).status.state).toBe("applying");
    coordinator.observe(sourcePath("apps/desktop/src/runtime_host.zig"), {
      kind: "restartRequired",
      target: "native",
    });
    expect(coordinator.status.state).toBe("applying");
    const acknowledgement = coordinator.acknowledge(candidateA);
    expect(adopted).toEqual([candidateA]);
    expect(acknowledgement.status).toMatchObject({
      state: "restartRequired",
      target: "native",
      candidateId: null,
    });
  });

  test("a cold change permanently fences all later gateway promotion", async () => {
    const promoted: string[] = [];
    const discarded: string[] = [];
    const inFlight = deferred<StagedGatewayArtifact>();
    let builds = 0;
    const coordinator = new DevGatewayCoordinator({
      authority: "launcher",
      debounceMs: 0,
      sessionId,
      buildCandidate: () => {
        builds += 1;
        return inFlight.promise;
      },
    });
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), { kind: "gatewayReload" });
    const settling = coordinator.settle();
    coordinator.observe(sourcePath("apps/desktop/src/runtime_host.zig"), {
      kind: "restartRequired",
      target: "native",
    });
    inFlight.resolve(artifact(candidateA, promoted, discarded));
    await settling;
    coordinator.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), {
      kind: "gatewayReload",
    });
    coordinator.observe(sourcePath("apps/desktop/package.json"), {
      kind: "restartRequired",
      target: "launcher",
    });
    await coordinator.settle();

    expect(builds).toBe(1);
    expect(promoted).toEqual([]);
    expect(discarded).toEqual([candidateA]);
    expect(coordinator.status).toMatchObject({
      state: "restartRequired",
      target: "launcher",
      candidateId: null,
    });
  });

  test("a cold fence survives a Vite server reconstruction in the same launcher session", async () => {
    let remembered: "native" | "launcher" | undefined;
    const first = new DevGatewayCoordinator({
      authority: "launcher",
      sessionId,
      buildCandidate: () => Promise.reject(new Error("must not build")),
      onColdFence: (target) => {
        remembered = target;
      },
    });
    first.observe(sourcePath("apps/desktop/frontend/dev/vite-plugin.ts"), {
      kind: "restartRequired",
      target: "launcher",
    });
    expect(remembered).toBe("launcher");

    let builds = 0;
    const reconstructed = new DevGatewayCoordinator({
      authority: "launcher",
      sessionId,
      ...(remembered === undefined ? {} : { initialColdFenceTarget: remembered }),
      buildCandidate: () => {
        builds += 1;
        return Promise.resolve(artifact(candidateA, [], []));
      },
    });
    reconstructed.observe(sourcePath("apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json"), {
      kind: "gatewayReload",
    });
    await reconstructed.settle();
    expect(builds).toBe(0);
    expect(reconstructed.status).toMatchObject({
      state: "restartRequired",
      target: "launcher",
    });
  });

  test("keeps content-addressed staged bytes away from the stable recovery path until ACK", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-dev-candidate-"));
    temporaryDirectories.push(directory);
    const candidatePath = join(directory, ".gateway.candidate");
    const stablePath = join(directory, "gateway");
    await writeFile(stablePath, "old stable gateway");
    await writeFile(candidatePath, "new staged gateway");

    const staged = await stageGatewayCandidateFile(candidatePath, stablePath);
    expect(String(staged.candidateId)).toBe(
      createHash("sha256").update("new staged gateway").digest("hex"),
    );
    expect(await readFile(stablePath, "utf8")).toBe("old stable gateway");
    expect(await readFile(gatewayCandidatePath(stablePath, staged.candidateId), "utf8")).toBe(
      "new staged gateway",
    );
    staged.adopt();
    expect(await readFile(stablePath, "utf8")).toBe("new staged gateway");
  });
});
