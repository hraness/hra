import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  appDevRevision,
  assertDevCacheCapacity,
  collectDevProcessGroup,
  createDevRequestHandler,
  DevBuildCoordinator,
  DevCapacityError,
  DevDependencyError,
  DevStaleBuildError,
  DevTransientBuildError,
  DevUncollectedProcessError,
  HRA_DEV_CACHE_LIMITS,
  parseDevSecurityHeaders,
  prepareDevCache,
  prepareLockedDevCache,
  publishDevCandidate,
  releaseCollectedDevOwner,
  runOwnedDevProcess,
  snapshotDevInputs,
  type DevBuildCandidate,
  type DevInputSnapshot,
  type DevPublishedRevision,
  type DevStatus,
} from "./dev-app.ts";
import {
  acquireAppPublicationLock, APP_PROCESS_CUSTODY_FILE, appSha256, createAppSourceMarkerEvidence, readAppInventory,
  type AppArtifact, type AppSourceEnvironmentSnapshot, type AppSourceMarkerEvidence,
} from "./build-app.ts";
import { APP_SOURCE_MARKER_PATH } from "./app-source-marker.ts";

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function safeDevCollectionFailureDiagnostic(error: unknown): string {
  const outer = error !== null && typeof error === "object" ? error : undefined;
  const message = outer !== undefined && "message" in outer ? outer.message : undefined;
  const cause = outer !== undefined && "cause" in outer ? outer.cause : undefined;
  const inner = cause !== null && typeof cause === "object" ? cause : undefined;
  const name = inner !== undefined && "name" in inner ? inner.name : undefined;
  const code = inner !== undefined && "code" in inner ? inner.code : undefined;
  return JSON.stringify({
    ...(error instanceof DevUncollectedProcessError && error.collection !== undefined
      ? { collection: error.collection } : {}),
    code: typeof code === "string" && [
      "ESRCH", "EPERM", "EACCES", "EINVAL", "ENOSYS", "ERR_ASSERTION",
      "ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE",
    ].includes(code) ? code : "unclassified",
    name: typeof name === "string" && [
      "Error", "SystemError", "AssertionError", "TypeError", "RangeError",
    ].includes(name) ? name : "unclassified",
    stage: message === "Development child collection is unproved; retain both publication owners"
      ? "process-group-collection"
      : message === "Development child handle collection is unproved; retain both publication owners"
        ? "direct-child-handle-collection"
        : "unclassified",
  });
}

function preserveDevFixture(root: string): void {
  const index = temporaryRoots.indexOf(root);
  if (index >= 0) temporaryRoots.splice(index, 1);
}

function assertDevFixtureAbsent(pid: number | undefined, descendants: readonly number[] = []): void {
  assert.ok(pid !== undefined && Number.isSafeInteger(pid) && pid > 1, "Owned fixture PID was not recorded");
  assert.ok(descendants.every((value) => Number.isSafeInteger(value) && value > 1), "Owned descendant PID was not recorded");
  for (const target of [pid, -pid, ...descendants]) {
    let absent = false;
    try { process.kill(target, 0); }
    catch (error) {
      assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH", "Fixture absence requires exact ESRCH");
      absent = true;
    }
    assert.equal(absent, true, "Owned fixture process or group remains present");
  }
}

function artifact(path: string, contents: string): AppArtifact {
  return { bytes: Buffer.byteLength(contents), path, sha256: appSha256(contents) };
}

function inputArtifact(path: string, contents: string) {
  return {
    ...artifact(path, contents),
    identitySha256: appSha256(`identity:${path}:${contents}`),
  };
}

const rootPackageBytes = Buffer.from('{"name":"@hraness/hra","version":"0.6.1"}\n');

function markerEvidence(
  environment: Readonly<Record<string, string | undefined>> = {},
): AppSourceMarkerEvidence {
  return createAppSourceMarkerEvidence(rootPackageBytes, environment);
}

function snapshot(
  source: string,
  dependency = "dependency-a",
  sourceMarker: AppSourceMarkerEvidence = markerEvidence(),
): DevInputSnapshot {
  const dependencyArtifact = inputArtifact("dependency/package.json", dependency);
  const sourceArtifact = inputArtifact("source/app.tsx", source);
  return {
    dependencies: [dependencyArtifact],
    dependencyEpoch: appSha256(JSON.stringify([dependencyArtifact])),
    sourceEpoch: appSha256(JSON.stringify({ files: [sourceArtifact], sourceMarker })),
    sourceMarker,
    sources: [sourceArtifact],
  };
}

function published(label: string): DevPublishedRevision {
  const revision = appSha256(`revision:${label}`);
  return { artifacts: [], directory: `/fixture/${revision}`, revision, sourceMarker: markerEvidence() };
}

function candidateFor(input: DevInputSnapshot, label: string): DevBuildCandidate {
  return {
    artifacts: [],
    dependencyEpoch: input.dependencyEpoch,
    publicDirectory: `/fixture/public/${label}`,
    revision: appSha256(`candidate:${label}`),
    run: `build-${label}`,
    sourceMarker: input.sourceMarker,
    sourceEpoch: input.sourceEpoch,
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("compiled development input epochs", () => {
  test("separates source changes from restart-only dependency changes", async () => {
    const root = await temporaryRoot("hra-dev-input-");
    await mkdir(join(root, "src"), { mode: 0o700 });
    await writeFile(join(root, "package.json"), rootPackageBytes, { mode: 0o600 });
    await writeFile(join(root, "dependency.json"), "dependency-a\n", { mode: 0o600 });
    await writeFile(join(root, "src", "app.tsx"), "export const app = 'a';\n", { mode: 0o600 });
    let environment: AppSourceEnvironmentSnapshot = {
      HRA_RELEASE_COMMIT: null,
      VERCEL: null,
      VERCEL_GIT_COMMIT_SHA: null,
    };
    const spec = {
      dependencyFiles: [
        { absolutePath: join(root, "dependency.json"), logicalPath: "dependency/tool.json" },
        { absolutePath: join(root, "package.json"), logicalPath: "repository/package.json" },
      ],
      sourceEnvironment: () => environment,
      sourceFiles: [],
      sourceRoots: [{ absolutePath: join(root, "src"), logicalPrefix: "source/src" }],
    };
    const first = await snapshotDevInputs(spec);
    await writeFile(join(root, "src", "app.tsx"), "export const app = 'b';\n");
    const sourceChanged = await snapshotDevInputs(spec);
    expect(sourceChanged.sourceEpoch).not.toBe(first.sourceEpoch);
    expect(sourceChanged.dependencyEpoch).toBe(first.dependencyEpoch);
    await writeFile(join(root, "dependency.json"), "dependency-b\n");
    const dependencyChanged = await snapshotDevInputs(spec);
    expect(dependencyChanged.dependencyEpoch).not.toBe(first.dependencyEpoch);
    expect(dependencyChanged.sourceEpoch).toBe(sourceChanged.sourceEpoch);
    environment = { HRA_RELEASE_COMMIT: "a".repeat(40), VERCEL: null, VERCEL_GIT_COMMIT_SHA: null };
    const markerChanged = await snapshotDevInputs(spec);
    expect(markerChanged.dependencyEpoch).toBe(dependencyChanged.dependencyEpoch);
    expect(markerChanged.sourceEpoch).not.toBe(dependencyChanged.sourceEpoch);
    expect(markerChanged.sourceMarker.marker.source.commit).toBe("a".repeat(40));
  });

  test("rejects descriptor drift and linked source files", async () => {
    const root = await temporaryRoot("hra-dev-input-negative-");
    await mkdir(join(root, "src"), { mode: 0o700 });
    await writeFile(join(root, "package.json"), rootPackageBytes, { mode: 0o600 });
    await writeFile(join(root, "dependency.json"), "dependency\n", { mode: 0o600 });
    await writeFile(join(root, "src", "app.tsx"), "source\n", { mode: 0o600 });
    await expect(snapshotDevInputs({
      dependencyFiles: [{
        absolutePath: join(root, "dependency.json"),
        bytes: 1,
        logicalPath: "dependency/tool.json",
        sha256: "0".repeat(64),
      }, { absolutePath: join(root, "package.json"), logicalPath: "repository/package.json" }],
      sourceEnvironment: () => ({ HRA_RELEASE_COMMIT: null, VERCEL: null, VERCEL_GIT_COMMIT_SHA: null }),
      sourceFiles: [],
      sourceRoots: [{ absolutePath: join(root, "src"), logicalPrefix: "source/src" }],
    })).rejects.toThrow(/Dependency artifact changed/u);
    await link(join(root, "src", "app.tsx"), join(root, "src", "alias.tsx"));
    await expect(snapshotDevInputs({
      dependencyFiles: [
        { absolutePath: join(root, "dependency.json"), logicalPath: "dependency/tool.json" },
        { absolutePath: join(root, "package.json"), logicalPath: "repository/package.json" },
      ],
      sourceEnvironment: () => ({ HRA_RELEASE_COMMIT: null, VERCEL: null, VERCEL_GIT_COMMIT_SHA: null }),
      sourceFiles: [],
      sourceRoots: [{ absolutePath: join(root, "src"), logicalPrefix: "source/src" }],
    })).rejects.toThrow(/hardlinked/u);
  });
});

describe("serial development rebuild coordinator", () => {
  for (const terminal of ["restart", "close"] as const) {
    for (const boundary of ["build", "snapshot", "publish", "resnapshot"] as const) {
      for (const outcome of ["same", "changed", "dependency", "error", "dependency-error"] as const) {
        test(`terminal fence ${terminal} during ${boundary} ${outcome}`, async () => {
          const input = snapshot("initial");
          const changed = snapshot("changed");
          const dependency = snapshot("changed", "dependency-b");
          const prior = published("prior");
          const entered = deferred<undefined>();
          const gate = deferred<undefined>();
          const statuses: DevStatus[] = [];
          let builds = 0;
          let publications = 0;
          let scans = 0;
          let activeSignal: AbortSignal | undefined;
          const pause = async (): Promise<void> => {
            entered.resolve(undefined);
            await gate.promise;
            if (outcome === "error") throw new Error("fixture census failure");
            if (outcome === "dependency-error") throw new DevDependencyError("fixture dependency failure");
          };
          const coordinator = new DevBuildCoordinator({
            build: async (value, signal) => {
              builds += 1;
              activeSignal = signal;
              if (boundary === "build") await pause();
              return candidateFor(value, "candidate");
            },
            currentSnapshot: async () => {
              scans += 1;
              if (boundary === "snapshot" || (boundary === "resnapshot" && scans === 2)) {
                await pause();
                if (outcome === "changed") return changed;
                if (outcome === "dependency") return dependency;
              }
              return input;
            },
            onStatus: (status) => statuses.push(status),
            publish: async (_candidate, _snapshot, signal) => {
              publications += 1;
              expect(signal).toBe(activeSignal!);
              if (boundary === "resnapshot") throw new DevStaleBuildError();
              if (boundary === "publish") await pause();
              return published("forbidden");
            },
          }, prior);
          coordinator.notify(input);
          await entered.promise;
          let closing: Promise<void> | undefined;
          if (terminal === "restart") coordinator.requireRestart("fixture-restart");
          else closing = coordinator.close();
          expect(activeSignal?.aborted).toBe(true);
          const terminalStatuses = statuses.length;
          let closed = false;
          void closing?.then(() => { closed = true; });
          await Promise.resolve();
          expect(closed).toBe(false);
          gate.resolve(undefined);
          await coordinator.waitForIdle();
          if (closing !== undefined) await closing;
          expect(coordinator.latest).toBe(prior);
          expect(builds).toBe(1);
          expect(publications).toBe(boundary === "publish" || boundary === "resnapshot" ? 1 : 0);
          expect(statuses.slice(terminalStatuses)).toEqual(terminal === "restart" ? [] : [{ diagnostic: null, latest: prior.revision, phase: "stopped" }]);
          expect(coordinator.status).toEqual({
            diagnostic: terminal === "restart" ? "fixture-restart" : null,
            latest: prior.revision,
            phase: terminal === "restart" ? "restart-required" : "stopped",
          });
          coordinator.notify(changed);
          await coordinator.waitForIdle();
          expect(builds).toBe(1);
          await coordinator.close();
        });
      }
    }
  }

  test("concurrent and reentrant close callers share the complete drain", async () => {
    const gate = deferred<undefined>();
    const entered = deferred<undefined>();
    let reentrant: Promise<void> | undefined;
    const coordinator = new DevBuildCoordinator({
      build: async (input, signal) => {
        signal.addEventListener("abort", () => { reentrant = coordinator.close(); }, { once: true });
        entered.resolve(undefined);
        await gate.promise;
        return candidateFor(input, "closed");
      },
      currentSnapshot: async () => snapshot("input"),
      publish: async () => published("forbidden"),
    });
    coordinator.notify(snapshot("input"));
    await entered.promise;
    const first = coordinator.close();
    const second = coordinator.close();
    expect(first).toBe(second);
    expect(first).toBe(reentrant!);
    let completed = 0;
    void first.then(() => { completed += 1; });
    void second.then(() => { completed += 1; });
    await Promise.resolve();
    expect(completed).toBe(0);
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(completed).toBe(2);
    expect(coordinator.status.phase).toBe("stopped");
  });

  for (const terminal of ["running", "restart", "close"] as const) {
    test(`retains process custody uncertainty after ${terminal}`, async () => {
      const gate = deferred<undefined>();
      const entered = deferred<undefined>();
      const prior = published("prior");
      const coordinator = new DevBuildCoordinator({
        build: async () => {
          entered.resolve(undefined);
          await gate.promise;
          throw new DevUncollectedProcessError("fixture collection unknown");
        },
        currentSnapshot: async () => snapshot("input"),
        publish: async () => published("forbidden"),
      }, prior);
      coordinator.notify(snapshot("input"));
      await entered.promise;
      if (terminal === "restart") coordinator.requireRestart("original-fence");
      const closing = terminal === "close" ? coordinator.close() : undefined;
      gate.resolve(undefined);
      await coordinator.waitForIdle();
      await closing;
      expect(coordinator.processCollectionUnproved).toBe(true);
      expect(coordinator.latest).toBe(prior);
      expect(coordinator.status.phase).toBe(terminal === "close" ? "stopped" : "restart-required");
      if (terminal === "restart") expect(coordinator.status.diagnostic).toBe("original-fence");
      await coordinator.close();
      expect(coordinator.processCollectionUnproved).toBe(true);
    });
  }

  test("coalesces changes and never rebuilds a polled active epoch", async () => {
    const first = snapshot("first");
    const middle = snapshot("middle");
    const latest = snapshot("latest");
    let current = first;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
    const builds: string[] = [];
    const publications: string[] = [];
    const coordinator = new DevBuildCoordinator({
      build: async (input) => {
        builds.push(input.sourceEpoch);
        if (builds.length === 1) await firstGate;
        return candidateFor(input, String(builds.length));
      },
      currentSnapshot: async () => current,
      publish: async (_candidate, input) => {
        publications.push(input.sourceEpoch);
        return published(String(publications.length));
      },
    });
    coordinator.notify(first);
    coordinator.notify(first);
    current = middle;
    coordinator.notify(middle);
    current = latest;
    coordinator.notify(latest);
    releaseFirst?.();
    await coordinator.waitForIdle();
    expect(builds).toEqual([first.sourceEpoch, latest.sourceEpoch]);
    expect(publications).toEqual([latest.sourceEpoch]);
    expect(coordinator.status).toMatchObject({ diagnostic: null, phase: "ready" });
    await coordinator.close();
  });

  test("retains a recovered revision across a red build and resumes only after a change", async () => {
    const prior = published("prior");
    const bad = snapshot("bad");
    const good = snapshot("good");
    let current = bad;
    let attempts = 0;
    const coordinator = new DevBuildCoordinator({
      build: async (input) => {
        attempts += 1;
        if (input.sourceEpoch === bad.sourceEpoch) throw new Error("fixture red");
        return candidateFor(input, "green");
      },
      currentSnapshot: async () => current,
      publish: async () => published("next"),
    }, prior);
    expect(coordinator.status).toEqual({ diagnostic: null, latest: prior.revision, phase: "ready" });
    coordinator.notify(bad);
    await coordinator.waitForIdle();
    expect(coordinator.status).toEqual({ diagnostic: "build-failed", latest: prior.revision, phase: "degraded" });
    coordinator.notify(bad);
    await coordinator.waitForIdle();
    expect(attempts).toBe(1);
    current = good;
    coordinator.notify(good);
    await coordinator.waitForIdle();
    expect(attempts).toBe(2);
    expect(coordinator.status).toMatchObject({ diagnostic: null, phase: "ready" });
    await coordinator.close();
  });

  test("recovers a transient census failure without rebuilding a known-good epoch", async () => {
    const input = snapshot("stable");
    let builds = 0;
    const coordinator = new DevBuildCoordinator({
      build: async (value) => {
        builds += 1;
        return candidateFor(value, "stable");
      },
      currentSnapshot: async () => input,
      publish: async () => published("stable"),
    });
    coordinator.notify(input);
    await coordinator.waitForIdle();
    coordinator.reportScanFailure();
    expect(coordinator.status.phase).toBe("degraded");
    coordinator.notify(input);
    expect(coordinator.status).toMatchObject({ diagnostic: null, phase: "ready" });
    expect(builds).toBe(1);
    await coordinator.close();
  });

  test("contains a failed stale resnapshot and accepts the next coherent epoch", async () => {
    const stale = snapshot("stale");
    const recovered = snapshot("recovered");
    let currentCalls = 0;
    let failResnapshot = true;
    let current = stale;
    let builds = 0;
    const coordinator = new DevBuildCoordinator({
      build: async (input) => {
        builds += 1;
        return candidateFor(input, String(builds));
      },
      currentSnapshot: async () => {
        currentCalls += 1;
        if (failResnapshot && currentCalls > 1) throw new Error("fixture census race");
        return current;
      },
      publish: async () => {
        if (failResnapshot) throw new DevStaleBuildError();
        return published("recovered");
      },
    });
    coordinator.notify(stale);
    await coordinator.waitForIdle();
    expect(coordinator.status).toEqual({ diagnostic: "source-census-failed", latest: null, phase: "degraded" });
    failResnapshot = false;
    current = recovered;
    coordinator.notify(recovered);
    await coordinator.waitForIdle();
    expect(coordinator.status.phase).toBe("ready");
    expect(builds).toBe(2);
    await coordinator.close();
  });

  test("fences dependency drift, retained-cache exhaustion, and transient lock contention", async () => {
    const initial = snapshot("source", "dependency-a");
    const changedDependency = snapshot("changed", "dependency-b");
    let abortObserved = false;
    const restart = new DevBuildCoordinator({
      build: async (input, signal) => {
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true }));
        return candidateFor(input, "unreachable");
      },
      currentSnapshot: async () => initial,
      publish: async () => published("unreachable"),
    });
    restart.notify(initial);
    restart.notify(changedDependency);
    await restart.waitForIdle();
    expect(abortObserved).toBe(true);
    expect(restart.status).toEqual({ diagnostic: "dependency-epoch-changed", latest: null, phase: "restart-required" });

    const capacity = new DevBuildCoordinator({
      build: async () => { throw new DevCapacityError("full"); },
      currentSnapshot: async () => initial,
      publish: async () => published("unreachable"),
    });
    capacity.notify(initial);
    await capacity.waitForIdle();
    expect(capacity.status).toEqual({ diagnostic: "retained-cache-capacity", latest: null, phase: "capacity-blocked" });
    capacity.notify(changedDependency);
    expect(capacity.status.phase).toBe("restart-required");

    let attempts = 0;
    const transient = new DevBuildCoordinator({
      build: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new DevTransientBuildError("busy");
        return candidateFor(input, "retry");
      },
      currentSnapshot: async () => initial,
      publish: async () => published("retry"),
    });
    transient.notify(initial);
    await transient.waitForIdle();
    expect(transient.status.diagnostic).toBe("publication-lane-busy");
    transient.notify(initial);
    await transient.waitForIdle();
    expect(attempts).toBe(2);
    expect(transient.status.phase).toBe("ready");
    await Promise.all([restart.close(), capacity.close(), transient.close()]);
  });
});

describe("immutable development routing", () => {
  async function writeRevisionTree(directory: string, label: string): Promise<Readonly<{
    artifacts: readonly AppArtifact[];
    sourceMarker: AppSourceMarkerEvidence;
  }>> {
    const sourceMarker = markerEvidence();
    await mkdir(join(directory, "graphs", "client", "assets"), { mode: 0o700, recursive: true });
    await mkdir(join(directory, ".well-known"), { mode: 0o700 });
    const files = new Map([
      [APP_SOURCE_MARKER_PATH, `${JSON.stringify(sourceMarker.marker, null, 2)}\n`],
      ["graphs/client/assets/foundation.css", `@layer base{:root{--label:${label}}}\n`],
      ["graphs/client/assets/main.js", `globalThis.__label=${JSON.stringify(label)};\n`],
      ["index.html", '<!doctype html><link rel="stylesheet" href="./graphs/client/assets/foundation.css"><link rel="stylesheet" href="./stylex.css"><script type="module" src="./graphs/client/assets/main.js"></script>\n'],
      ["stylex.css", `@layer components.hra-app.priority1{.x{color:${label}}}\n`],
    ]);
    for (const [path, contents] of files) await writeFile(join(directory, ...path.split("/")), contents, { mode: 0o600 });
    return { artifacts: await readAppInventory(directory), sourceMarker };
  }

  async function revisionFixture(label: string): Promise<DevPublishedRevision> {
    const directory = await temporaryRoot(`hra-dev-revision-${label}-`);
    const { artifacts, sourceMarker } = await writeRevisionTree(directory, label);
    return { artifacts, directory, revision: appDevRevision(artifacts, sourceMarker), sourceMarker };
  }

  for (const boundary of ["before-start", "snapshot-1", "snapshot-2", "snapshot-3", "snapshot-4", "durable-commit", "live-commit"] as const) {
    test(`publication cancellation preserves prior revision at ${boundary}`, async () => {
      const root = await temporaryRoot("hra-dev-cancel-publication-");
      const cache = await prepareDevCache(root);
      const input = snapshot("publication");
      const lock = acquireAppPublicationLock(cache.root);
      const makeCandidate = async (label: string): Promise<DevBuildCandidate> => {
        const run = `build-${label}`;
        const publicDirectory = join(cache.runsDirectory, run, "public");
        await mkdir(publicDirectory, { mode: 0o700, recursive: true });
        const { artifacts, sourceMarker } = await writeRevisionTree(publicDirectory, label);
        return {
          artifacts, dependencyEpoch: input.dependencyEpoch, publicDirectory,
          revision: appDevRevision(artifacts, sourceMarker), run,
          sourceEpoch: input.sourceEpoch, sourceMarker,
        };
      };
      try {
        const priorCandidate = await makeCandidate("prior");
        const prior = await publishDevCandidate({
          cache, candidate: priorCandidate, currentSnapshot: async () => input,
          lock, signal: new AbortController().signal, snapshot: input,
        });
        const candidate = await makeCandidate("next");
        const controller = new AbortController();
        const entered = deferred<undefined>();
        const gate = deferred<undefined>();
        let scans = 0;
        let finalStageChecks = 0;
        const finalReceipt = join(cache.receiptsDirectory, `000000000002-${candidate.revision}.json`);
        const stagedReceipt = join(cache.runsDirectory, candidate.run, "dev-publication.json");
        if (boundary === "before-start") controller.abort();
        const publication = publishDevCandidate({
          cache, candidate,
          currentSnapshot: async () => {
            scans += 1;
            if (boundary === `snapshot-${String(scans)}`) {
              entered.resolve(undefined);
              await gate.promise;
            }
            return input;
          },
          lock: {
            assertHeld: () => {
              lock.assertHeld();
              // After the fourth snapshot, the next held check follows the
              // receipt fsync immediately before its append-only rename.
              if (scans === 4 && existsSync(stagedReceipt)) finalStageChecks += 1;
              if ((boundary === "durable-commit" && finalStageChecks === 2)
                || (boundary === "live-commit" && existsSync(finalReceipt))) controller.abort();
            },
            release: () => lock.release(),
          },
          signal: controller.signal, snapshot: input,
        });
        // Observe settlement without entering Bun's promise matcher while the
        // publication is intentionally parked behind our own deferred gate.
        const outcome = publication.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        if (boundary.startsWith("snapshot-")) {
          const first = await Promise.race([
            entered.promise.then(() => ({ kind: "entered" as const })),
            outcome,
          ]);
          expect(first.kind).toBe("entered");
          controller.abort();
          gate.resolve(undefined);
        }
        const result = await outcome;
        expect(result.kind).toBe("rejected");
        if (result.kind !== "rejected") throw new Error("Cancelled publication resolved");
        expect(String(result.error)).toMatch(/abort/iu);
        expect(cache.latest).toBe(prior);
        expect(cache.revisions.size).toBe(1);
        expect(cache.revisions.get(prior.revision)).toBe(prior);
        expect(await readAppInventory(prior.directory)).toEqual(prior.artifacts);
        expect(cache.nextSequence).toBe(boundary === "live-commit" ? 3 : 2);
        expect(await readdir(cache.receiptsDirectory)).toHaveLength(boundary === "live-commit" ? 2 : 1);
        // A receipt already durably committed remains valid historical state;
        // cancellation does not delete it or reuse its sequence number.
        const recovered = await prepareDevCache(root);
        expect(recovered.revisions.has(prior.revision)).toBe(true);
        expect(recovered.latest?.revision).toBe(boundary === "live-commit" ? candidate.revision : prior.revision);
      } finally {
        lock.release();
      }
    });
  }

  test("returns initial 503, redirects manual refresh, and retains old lazy assets", async () => {
    const old = await revisionFixture("old");
    const latest = await revisionFixture("latest");
    const revisions = new Map([[old.revision, old], [latest.revision, latest]]);
    let status: DevStatus = { diagnostic: null, latest: null, phase: "starting" };
    const handler = createDevRequestHandler({
      getStatus: () => status,
      revisions,
      securityHeaders: [["Content-Security-Policy", "default-src 'none'"], ["X-Frame-Options", "DENY"]],
    });
    const initial = await handler(new Request("http://127.0.0.1:5183/?view=tasks#session"));
    expect(initial.status).toBe(503);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(initial.headers.get("content-security-policy")).toBe("default-src 'none'");
    const initialMarker = await handler(new Request(`http://127.0.0.1:5183/${APP_SOURCE_MARKER_PATH}`));
    expect(initialMarker.status).toBe(503);
    expect(initialMarker.headers.get("content-type")).toBe("application/json; charset=utf-8");

    status = { diagnostic: null, latest: latest.revision, phase: "ready" };
    const root = await handler(new Request("http://127.0.0.1:5183/?view=tasks#session"));
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toBe(`/_hra_dev/${latest.revision}/?view=tasks`);
    expect(root.headers.get("location")).not.toContain("#");
    const oldRefresh = await handler(new Request(`http://127.0.0.1:5183/_hra_dev/${old.revision}/?view=tasks`));
    expect(oldRefresh.headers.get("location")).toBe(`/_hra_dev/${latest.revision}/?view=tasks`);

    const oldAsset = await handler(new Request(`http://127.0.0.1:5183/_hra_dev/${old.revision}/graphs/client/assets/main.js`));
    expect(oldAsset.status).toBe(200);
    expect(oldAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await oldAsset.text()).toContain("old");
    const shell = await handler(new Request(`http://127.0.0.1:5183/_hra_dev/${latest.revision}/`));
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    const head = await handler(new Request(`http://127.0.0.1:5183/_hra_dev/${latest.revision}/stylex.css`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const markerUrl of [
      `http://127.0.0.1:5183/${APP_SOURCE_MARKER_PATH}`,
      `http://127.0.0.1:5183/_hra_dev/${latest.revision}/${APP_SOURCE_MARKER_PATH}`,
    ]) {
      const marker = await handler(new Request(markerUrl));
      expect(marker.status).toBe(200);
      expect(marker.headers.get("cache-control")).toBe("no-store");
      expect(marker.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(JSON.parse(await marker.text())).toEqual(latest.sourceMarker.marker);
      const markerHead = await handler(new Request(markerUrl, { method: "HEAD" }));
      expect(markerHead.status).toBe(200);
      expect(await markerHead.text()).toBe("");
    }
    expect((await handler(new Request("http://127.0.0.1:5183/.well-known/other.json"))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1:5183/", { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request("http://attacker.invalid:5183/"))).status).toBe(421);
    expect((await handler(new Request(`http://127.0.0.1:5183/_hra_dev/${latest.revision}/../secret`))).status).toBe(404);
  });

  test("fails a drifted immutable artifact closed", async () => {
    const revision = await revisionFixture("stable");
    const handler = createDevRequestHandler({
      getStatus: () => ({ diagnostic: null, latest: revision.revision, phase: "ready" }),
      revisions: new Map([[revision.revision, revision]]),
      securityHeaders: [],
    });
    await writeFile(join(revision.directory, "stylex.css"), "changed\n");
    const response = await handler(new Request(`http://127.0.0.1:5183/_hra_dev/${revision.revision}/stylex.css`));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const markerRevision = await revisionFixture("marker-stable");
    const markerHandler = createDevRequestHandler({
      getStatus: () => ({ diagnostic: null, latest: markerRevision.revision, phase: "ready" }),
      revisions: new Map([[markerRevision.revision, markerRevision]]),
      securityHeaders: [],
    });
    await writeFile(join(markerRevision.directory, APP_SOURCE_MARKER_PATH), "{}\n");
    const markerResponse = await markerHandler(new Request(`http://127.0.0.1:5183/${APP_SOURCE_MARKER_PATH}`));
    expect(markerResponse.status).toBe(500);
    expect(markerResponse.headers.get("cache-control")).toBe("no-store");
  });

  test("publishes one append-only receipt and recovers its latest immutable revision", async () => {
    const root = await temporaryRoot("hra-dev-publication-");
    const cache = await prepareDevCache(root);
    const run = "build-fixture";
    const runDirectory = join(cache.runsDirectory, run);
    const publicDirectory = join(runDirectory, "public");
    await mkdir(publicDirectory, { mode: 0o700, recursive: true });
    const { artifacts, sourceMarker } = await writeRevisionTree(publicDirectory, "published");
    const input = snapshot("published");
    const revision = appDevRevision(artifacts, sourceMarker);
    const candidate: DevBuildCandidate = {
      artifacts,
      dependencyEpoch: input.dependencyEpoch,
      publicDirectory,
      revision,
      run,
      sourceMarker,
      sourceEpoch: input.sourceEpoch,
    };
    const lock = acquireAppPublicationLock(cache.root);
    try {
      const result = await publishDevCandidate({
        cache,
        candidate,
        currentSnapshot: async () => input,
        lock,
        signal: new AbortController().signal,
        snapshot: input,
      });
      expect(result.revision).toBe(revision);
      expect(cache.latest?.revision).toBe(revision);
      expect(cache.nextSequence).toBe(2);
    } finally {
      lock.release();
    }
    const recovered = await prepareDevCache(root);
    expect(recovered.nextSequence).toBe(2);
    expect(recovered.latest?.revision).toBe(revision);
    expect(recovered.revisions.get(revision)?.artifacts).toEqual(artifacts);

    const staleRun = "build-stale";
    const staleDirectory = join(recovered.runsDirectory, staleRun, "public");
    await mkdir(staleDirectory, { mode: 0o700, recursive: true });
    const { artifacts: staleArtifacts, sourceMarker: staleSourceMarker } = await writeRevisionTree(staleDirectory, "stale");
    const staleCandidate: DevBuildCandidate = {
      artifacts: staleArtifacts,
      dependencyEpoch: input.dependencyEpoch,
      publicDirectory: staleDirectory,
      revision: appDevRevision(staleArtifacts, staleSourceMarker),
      run: staleRun,
      sourceMarker: staleSourceMarker,
      sourceEpoch: input.sourceEpoch,
    };
    const staleLock = acquireAppPublicationLock(recovered.root);
    try {
      await expect(publishDevCandidate({
        cache: recovered,
        candidate: staleCandidate,
        currentSnapshot: async () => snapshot("changed"),
        lock: staleLock,
        signal: new AbortController().signal,
        snapshot: input,
      })).rejects.toThrow(/inputs changed/u);
    } finally {
      staleLock.release();
    }
    expect(await readAppInventory(staleDirectory)).toEqual(staleArtifacts);
    expect((await prepareDevCache(root)).nextSequence).toBe(2);
  });

  test("refuses a source-marker epoch change at the final receipt join", async () => {
    const root = await temporaryRoot("hra-dev-marker-stale-");
    const cache = await prepareDevCache(root);
    const run = "build-marker-stale";
    const publicDirectory = join(cache.runsDirectory, run, "public");
    await mkdir(publicDirectory, { mode: 0o700, recursive: true });
    const { artifacts, sourceMarker } = await writeRevisionTree(publicDirectory, "marker-stale");
    const input = snapshot("marker-stable");
    const changed = snapshot(
      "marker-stable",
      "dependency-a",
      markerEvidence({ HRA_RELEASE_COMMIT: "a".repeat(40) }),
    );
    const candidate: DevBuildCandidate = {
      artifacts,
      dependencyEpoch: input.dependencyEpoch,
      publicDirectory,
      revision: appDevRevision(artifacts, sourceMarker),
      run,
      sourceMarker,
      sourceEpoch: input.sourceEpoch,
    };
    let snapshots = 0;
    const lock = acquireAppPublicationLock(cache.root);
    try {
      await expect(publishDevCandidate({
        cache,
        candidate,
        currentSnapshot: async () => ++snapshots < 4 ? input : changed,
        lock,
        signal: new AbortController().signal,
        snapshot: input,
      })).rejects.toThrow(/inputs changed/u);
    } finally {
      lock.release();
    }
    expect(snapshots).toBe(4);
    expect(await readdir(cache.receiptsDirectory)).toEqual([]);
    const recovered = await prepareDevCache(root);
    expect(recovered.latest).toBeUndefined();
    expect(recovered.nextSequence).toBe(1);
  });
});

describe("pure development process collection", () => {
  test("both publication owners stay held on uncertain collection", () => {
    const released: string[] = [];
    const buildOwner = { assertHeld: () => {}, release: () => { released.push("build"); } };
    const devOwner = { assertHeld: () => {}, release: () => { released.push("dev"); } };
    releaseCollectedDevOwner(buildOwner, true);
    releaseCollectedDevOwner(devOwner, true);
    expect(released).toEqual([]);
    releaseCollectedDevOwner(buildOwner, false);
    releaseCollectedDevOwner(devOwner, false);
    expect(released).toEqual(["build", "dev"]);
  });

  test("requires positive absence and does not signal an already absent group", async () => {
    let signals = 0;
    let waits = 0;
    expect(await collectDevProcessGroup({
      probe: () => false,
      signal: () => { signals += 1; return "sent"; },
      wait: async () => { waits += 1; },
    })).toBe(false);
    expect(signals).toBe(0);
    expect(waits).toBe(0);
  });

  test("collects a positively observed group within the bounded TERM window", async () => {
    let present = true;
    const signals: string[] = [];
    let waits = 0;
    expect(await collectDevProcessGroup({
      probe: () => present,
      signal: (signal, beforeSyscall) => { beforeSyscall(); signals.push(signal); return "sent"; },
      wait: async () => { waits += 1; present = false; },
    })).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    expect(waits).toBe(1);
  });

  for (const failure of ["initial-probe", "term-preprobe", "term", "later-probe", "wait", "kill-preprobe", "kill", "survivor"] as const) {
    test(`retains custody on ${failure} uncertainty without speculative retries`, async () => {
      const uncertain = Object.assign(new Error("fixture probe or signal denied"), { code: "EPERM" });
      const signals: string[] = [];
      let probes = 0;
      let waits = 0;
      const outcome = await collectDevProcessGroup({
        probe: () => {
          probes += 1;
          if (failure === "initial-probe" || (failure === "later-probe" && probes > 1)) throw uncertain;
          return true;
        },
        signal: (signal, beforeSyscall) => {
          if ((failure === "term-preprobe" && signal === "SIGTERM") || (failure === "kill-preprobe" && signal === "SIGKILL")) throw uncertain;
          beforeSyscall();
          signals.push(signal);
          if ((failure === "term" && signal === "SIGTERM") || (failure === "kill" && signal === "SIGKILL")) throw uncertain;
          return "sent";
        },
        wait: async () => {
          waits += 1;
          if (failure === "wait") throw uncertain;
        },
      }).then(() => undefined, (error: unknown) => error);
      expect(outcome).toBeInstanceOf(DevUncollectedProcessError);
      assert.ok(outcome instanceof DevUncollectedProcessError);
      if (failure === "survivor") expect(outcome.cause).toBeInstanceOf(Error);
      else expect(outcome.cause).toBe(uncertain);
      const expectedPhase = ({
        "initial-probe": "initial-probe", "term-preprobe": "term-preprobe", term: "term-syscall",
        "later-probe": "post-term-probe", wait: "post-term-wait", "kill-preprobe": "kill-preprobe",
        kill: "kill-syscall", survivor: "final-absence",
      } as const)[failure];
      expect(outcome.collection?.phase).toBe(expectedPhase);
      expect(outcome.collection?.termSent).toBe(!["initial-probe", "term-preprobe", "term"].includes(failure));
      expect(outcome.collection?.killSent).toBe(failure === "survivor");
      expect(outcome.collection?.attempt).toBe(0);
      expect(outcome.collection?.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
      expect(outcome.collection?.elapsedMilliseconds).toBeLessThanOrEqual(120_000);
      expect(outcome.collection?.elapsedCapped).toBe(false);
      expect(Object.isFrozen(outcome.collection)).toBe(true);
      expect(signals).toEqual(failure === "initial-probe" || failure === "term-preprobe" ? [] : failure === "kill" || failure === "survivor" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
      expect(waits).toBe(failure === "survivor" ? 160 : failure === "kill" || failure === "kill-preprobe" ? 80 : failure === "wait" ? 1 : 0);
      expect(probes).toBeLessThanOrEqual(164);
    });
  }

  test("does not report a successful TERM when its syscall observed ESRCH", async () => {
    const denied = Object.assign(new Error("later probe denied"), { code: "EPERM" });
    let probes = 0;
    const outcome = await collectDevProcessGroup({
      probe: () => { if (++probes > 1) throw denied; return true; },
      signal: (_signal, beforeSyscall) => { beforeSyscall(); return "absent"; },
      wait: async () => { assert.fail("Permission failure must not wait"); },
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(outcome instanceof DevUncollectedProcessError);
    expect(outcome.cause).toBe(denied);
    expect(outcome.collection?.phase).toBe("post-term-probe");
    expect(outcome.collection?.termSent).toBe(false);
    const diagnostic = safeDevCollectionFailureDiagnostic(outcome);
    expect(diagnostic).toContain('"phase":"post-term-probe"');
    expect(diagnostic).toContain('"code":"EPERM"');
    expect(diagnostic).not.toContain("later probe denied");
  });

  for (const fixture of [
    { failureAt: 4, phase: "post-term-probe", attempt: 2, waits: 2, killSent: false },
    { failureAt: 82, phase: "pre-kill-probe", attempt: 0, waits: 80, killSent: false },
    { failureAt: 83, phase: "post-kill-probe", attempt: 0, waits: 80, killSent: true },
    { failureAt: 163, phase: "final-probe", attempt: 0, waits: 160, killSent: true },
  ] as const) {
    test(`freezes the exact ${fixture.phase} attempt without retrying a denied probe`, async () => {
      const denied = Object.assign(new Error("fixture permission denied"), { code: "EPERM" });
      let probes = 0;
      let waits = 0;
      const outcome = await collectDevProcessGroup({
        probe: () => { if (++probes === fixture.failureAt) throw denied; return true; },
        signal: (_signal, beforeSyscall) => { beforeSyscall(); return "sent"; },
        wait: async () => { waits += 1; },
      }).then(() => undefined, (error: unknown) => error);
      assert.ok(outcome instanceof DevUncollectedProcessError);
      expect(outcome.cause).toBe(denied);
      expect(outcome.collection?.phase).toBe(fixture.phase);
      expect(outcome.collection?.attempt).toBe(fixture.attempt);
      expect(outcome.collection?.termSent).toBe(true);
      expect(outcome.collection?.killSent).toBe(fixture.killSent);
      expect(probes).toBe(fixture.failureAt);
      expect(waits).toBe(fixture.waits);
    });
  }
});

describe("cache, security, and owned process boundaries", () => {
  for (const outcome of ["success", "cancelled", "uncertain"] as const) {
    test(`owner exit preserves correct publication admission after ${outcome} collection`, async () => {
      const root = await temporaryRoot(`hra-dev-durable-${outcome}-`);
      const buildModule = new URL("./build-app.ts", import.meta.url).href;
      const devModule = new URL("./dev-app.ts", import.meta.url).href;
      const childIdentity = join(root, "child-pid.json");
      const childReady = join(root, "child-ready");
      const resultPath = join(root, "owner-result.json");
      // The test helper has no application state and self-expires if the test
      // runner dies. The owner additionally records its exact PID before yield.
      const childCode = `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(childReady)}, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
        setTimeout(() => {}, ${outcome === "success" ? 150 : 12_000});
      `;
      const ownerCode = `
        import assert from "node:assert/strict";
        import { existsSync, writeFileSync } from "node:fs";
        import { readFile } from "node:fs/promises";
        const build = await import(${JSON.stringify(buildModule)});
        const dev = await import(${JSON.stringify(devModule)});
        const { cache, lock: devLock } = await dev.prepareLockedDevCache(${JSON.stringify(root)});
        const control = ${JSON.stringify(join(root, "tmp", "build-app"))};
        const buildLock = build.acquireAppPublicationLock(control);
        const custody = build.beginAppProcessCustody([
          { controlDirectory: control, lock: buildLock },
          { controlDirectory: cache.root, lock: devLock },
        ], "build-subprocess");
        const controller = new AbortController();
        let pid;
        const execution = dev.runOwnedDevProcess({
          command: [process.execPath, "-e", ${JSON.stringify(childCode)}],
          custody, cwd: ${JSON.stringify(root)}, deadlineMilliseconds: 10000,
          onSpawn: (value) => {
            pid = value;
            writeFileSync(${JSON.stringify(childIdentity)}, JSON.stringify({ pid }), { flag: "wx", mode: 0o600 });
          },
          signal: controller.signal,
        }).then(() => ({ passed: true }), (error) => ({ passed: false, error }));
        for (let attempt = 0; attempt < 300 && !existsSync(${JSON.stringify(childReady)}); attempt += 1) await Bun.sleep(10);
        assert.equal(existsSync(${JSON.stringify(childReady)}), true, "Owned helper did not become ready");
        const originalKill = process.kill;
        if (${JSON.stringify(outcome)} === "uncertain") {
          process.kill = (target, signal) => {
            if (target === -pid) throw Object.assign(new Error("Fixture group observation denied"), { code: "EPERM" });
            return originalKill.call(process, target, signal);
          };
        }
        if (${JSON.stringify(outcome)} !== "success") controller.abort();
        const result = await execution;
        process.kill = originalKill;
        const unproved = !result.passed && result.error instanceof dev.DevUncollectedProcessError;
        assert.equal(unproved, ${JSON.stringify(outcome === "uncertain")});
        assert.equal(result.passed, ${JSON.stringify(outcome === "success")});
        const markers = [control, cache.root].map((directory) => directory + "/" + build.APP_PROCESS_CUSTODY_FILE);
        assert.deepEqual(markers.map((path) => existsSync(path)), [unproved, unproved]);
        dev.releaseCollectedDevOwner(buildLock, unproved);
        dev.releaseCollectedDevOwner(devLock, unproved);
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          pid, unproved, records: unproved ? await Promise.all(markers.map((path) => readFile(path, "utf8"))) : [],
        }), { flag: "wx", mode: 0o600 });
        // Exit closes kernel flocks even on the deliberately retained-owner path.
        process.exit(0);
      `;
      const owner = Bun.spawn([process.execPath, "-e", ownerCode], { stderr: "inherit", stdout: "inherit" });
      let ownerExited = false;
      let childPid: number | undefined;
      const probe = (pid: number): boolean => {
        try { process.kill(-pid, 0); return true; }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
          throw error;
        }
      };
      // Await this same collection path on success and failure. Keeping its
      // throws outside the finally body preserves cleanup-error precedence.
      const cleanup = async (): Promise<void> => {
        if (!ownerExited) { owner.kill("SIGKILL"); await owner.exited; }
        try {
          if (childPid === undefined) {
            const identityPath = existsSync(childIdentity) ? childIdentity : existsSync(childReady) ? childReady : undefined;
            if (identityPath === undefined) throw new Error("The test helper's spawn state is unknown; preserve its fixture");
            const record: unknown = JSON.parse(await readFile(identityPath, "utf8"));
            if (typeof record !== "object" || record === null || !("pid" in record)
              || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 1) {
              throw new Error("The test helper's exact identity is unavailable; preserve its fixture");
            }
            childPid = record.pid;
          }
          const pid = childPid;
          await collectDevProcessGroup({
            probe: () => probe(pid),
            signal: (signal, beforeSyscall) => {
              beforeSyscall();
              try { process.kill(-pid, signal); return "sent"; }
              catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
                return "absent";
              }
            },
            wait: () => Bun.sleep(25),
          });
          expect(probe(pid)).toBe(false);
        } catch (error) {
          const index = temporaryRoots.indexOf(root);
          if (index >= 0) temporaryRoots.splice(index, 1);
          throw error;
        }
      };
      try {
        const ownerExit = await owner.exited;
        ownerExited = true;
        expect(ownerExit).toBe(0);
        const result: unknown = JSON.parse(await readFile(resultPath, "utf8"));
        // Bun's asymmetric toMatchObject mutates received fields into matchers.
        // Keep the exact primitive identity and retained bytes for later proofs.
        expect(typeof result === "object" && result !== null && !Array.isArray(result)).toBe(true);
        const resultRecord = result as { pid: number; unproved: boolean; records: string[] };
        expect(Object.keys(resultRecord).sort()).toEqual(["pid", "records", "unproved"]);
        expect(resultRecord.unproved).toBe(outcome === "uncertain");
        expect(Array.isArray(resultRecord.records)).toBe(true);
        expect(resultRecord.records.every((record) => typeof record === "string")).toBe(true);
        expect(resultRecord.records).toHaveLength(outcome === "uncertain" ? 2 : 0);
        expect(Number.isSafeInteger(resultRecord.pid) && resultRecord.pid > 1).toBe(true);
        childPid = resultRecord.pid;
        for (const identityPath of [childIdentity, childReady]) {
          const identity: unknown = JSON.parse(await readFile(identityPath, "utf8"));
          expect(identity).toEqual({ pid: childPid });
        }
        expect(probe(childPid)).toBe(outcome === "uncertain");
        const contenderCode = `
          import assert from "node:assert/strict";
          const build = await import(${JSON.stringify(buildModule)});
          const dev = await import(${JSON.stringify(devModule)});
          const results = [];
          for (const acquire of [
            () => build.acquireAppPublicationLock(${JSON.stringify(join(root, "tmp", "build-app"))}),
            async () => (await dev.prepareLockedDevCache(${JSON.stringify(root)})).lock,
          ]) {
            try { const lock = await acquire(); lock.release(); results.push("admitted"); }
            catch (error) { assert.ok(error instanceof build.AppProcessCustodyError); results.push("retained"); }
          }
          assert.deepEqual(results, ${JSON.stringify(outcome === "uncertain" ? ["retained", "retained"] : ["admitted", "admitted"])});
        `;
        const contender = Bun.spawn([process.execPath, "-e", contenderCode], { stderr: "inherit", stdout: "inherit" });
        expect(await contender.exited).toBe(0);
        if (outcome === "uncertain") {
          expect(probe(childPid)).toBe(true);
          const records = await Promise.all([
            join(root, "tmp", "build-app", APP_PROCESS_CUSTODY_FILE),
            join(root, "tmp", "build-app", "dev", APP_PROCESS_CUSTODY_FILE),
          ].map((path) => readFile(path, "utf8")));
          expect(records).toEqual(resultRecord.records);
          expect(records[0]).toBe(records[1]!);
        }
      } finally {
        await cleanup();
      }
    }, 25_000);
  }

  test("loads only bounded known cache state and preserves unknown entries", async () => {
    const root = await temporaryRoot("hra-dev-cache-");
    const cache = await prepareDevCache(root);
    expect(cache.nextSequence).toBe(1);
    expect(cache.revisions.size).toBe(0);
    await writeFile(join(cache.root, "unknown.txt"), "preserve me\n", { mode: 0o600 });
    await expect(prepareDevCache(root)).rejects.toThrow(/Unknown development cache state/u);
    expect(await Bun.file(join(cache.root, "unknown.txt")).text()).toBe("preserve me\n");
  });

  test("acquires the dev owner before inspecting retained publication state", async () => {
    const root = await temporaryRoot("hra-dev-lock-before-recovery-");
    const cache = await prepareDevCache(root);
    const first = acquireAppPublicationLock(cache.root);
    try {
      await writeFile(join(cache.root, "transient-owner-state"), "preserve\n", { mode: 0o600 });
      await expect(prepareLockedDevCache(root)).rejects.toThrow(/Another app publication owns/u);
      expect(await Bun.file(join(cache.root, "transient-owner-state")).text()).toBe("preserve\n");
    } finally {
      first.release();
    }
  });

  test("reserves capacity before a build can allocate", () => {
    expect(() => assertDevCacheCapacity({ bytes: 0, directories: 1, files: 0, revisions: 0, runs: 0 })).not.toThrow();
    expect(() => assertDevCacheCapacity({
      bytes: HRA_DEV_CACHE_LIMITS.bytes - HRA_DEV_CACHE_LIMITS.reserveBytes + 1,
      directories: 1,
      files: 0,
      revisions: 0,
      runs: 0,
    })).toThrow(/retained compiled-development cache/u);
    expect(() => assertDevCacheCapacity({ bytes: 0, directories: 1, files: 0, revisions: HRA_DEV_CACHE_LIMITS.revisions, runs: 0 })).toThrow();
  });

  test("binds development headers to the production policy", async () => {
    const configuration = JSON.parse(await Bun.file(new URL("../app/vercel.json", import.meta.url)).text()) as unknown;
    const headers = parseDevSecurityHeaders(configuration);
    expect(headers).toContainEqual(["Content-Security-Policy", expect.stringContaining("style-src 'self'")]);
    const changed = structuredClone(configuration) as { headers: { headers: { key: string; value: string }[]; source: string }[] };
    const global = changed.headers.find(({ source }) => source === "/(.*)");
    expect(global).toBeDefined();
    const policy = global?.headers.find(({ key }) => key === "Content-Security-Policy");
    if (policy !== undefined) policy.value += " 'unsafe-inline'";
    expect(() => parseDevSecurityHeaders(changed)).toThrow(/equal the production security policy/u);
    const duplicated = structuredClone(configuration) as { headers: { headers: { key: string; value: string }[]; source: string }[] };
    const globalEntry = duplicated.headers.find(({ source }) => source === "/(.*)");
    if (globalEntry !== undefined) duplicated.headers.push(structuredClone(globalEntry));
    expect(() => parseDevSecurityHeaders(duplicated)).toThrow(/one global rule/u);
  });

  for (const cancellation of ["without waiting for readiness (20 ms)", "after parent and grandchild readiness"] as const) {
    test(`terminates and reaps its exact child when a build is aborted ${cancellation}`, async () => {
      const root = await temporaryRoot("hra-dev-child-");
      const controller = new AbortController();
      const parentReady = join(root, "parent-ready.json");
      const grandchildReady = join(root, "grandchild-ready.json");
      // Both helpers self-expire even if collection becomes unprovable. The
      // readiness arm uses exact records, not the arbitrary cancellation delay.
      const grandchildCode = `
        import { linkSync, writeFileSync } from "node:fs";
        setTimeout(() => {}, 12000);
        writeFileSync(${JSON.stringify(`${grandchildReady}.pending`)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid }), { flag: "wx", mode: 0o600 });
        linkSync(${JSON.stringify(`${grandchildReady}.pending`)}, ${JSON.stringify(grandchildReady)});
      `;
      const parentCode = `
        import { linkSync, writeFileSync } from "node:fs";
        setTimeout(() => {}, 12000);
        const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchildCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        writeFileSync(${JSON.stringify(`${parentReady}.pending`)}, JSON.stringify({ pid: process.pid, childPid: child.pid }), { flag: "wx", mode: 0o600 });
        linkSync(${JSON.stringify(`${parentReady}.pending`)}, ${JSON.stringify(parentReady)});
      `;
      let pid: number | undefined;
      let grandchildPid: number | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      let collectionProved = false;
      const running = runOwnedDevProcess({
        command: [process.execPath, "-e", parentCode],
        cwd: root,
        deadlineMilliseconds: 5_000,
        onSpawn: (childPid) => {
          pid = childPid;
          if (cancellation === "without waiting for readiness (20 ms)") abortTimer = setTimeout(() => controller.abort(), 20);
        },
        signal: controller.signal,
      }).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ error, kind: "rejected" as const }),
      );
      try {
        if (cancellation === "after parent and grandchild readiness") {
          for (let attempt = 0; attempt < 300 && !(existsSync(parentReady) && existsSync(grandchildReady)); attempt += 1) await Bun.sleep(10);
          const parent: unknown = JSON.parse(await readFile(parentReady, "utf8"));
          const grandchild: unknown = JSON.parse(await readFile(grandchildReady, "utf8"));
          assert.ok(typeof parent === "object" && parent !== null && "childPid" in parent);
          assert.ok(typeof parent.childPid === "number" && Number.isSafeInteger(parent.childPid) && parent.childPid > 1);
          expect<unknown>(parent).toEqual({ childPid: parent.childPid, pid });
          expect(grandchild).toEqual({ parentPid: pid, pid: parent.childPid });
          grandchildPid = parent.childPid;
          controller.abort();
        }
        const outcome = await running;
        expect(() => {
          if (outcome.kind === "rejected") throw outcome.error;
        }, `Owned cancellation: ${safeDevCollectionFailureDiagnostic(outcome.kind === "rejected" ? outcome.error : undefined)}`)
          .toThrow(/aborted/u);
        assertDevFixtureAbsent(pid, grandchildPid === undefined ? [] : [grandchildPid]);
        collectionProved = true;
      } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
        controller.abort();
        // Join the same owner, never dispatch a second cleanup signal. Failed
        // assertions or uncertain collection leave the finite fixture intact.
        await running;
        if (!collectionProved) preserveDevFixture(root);
      }
    }, 15_000); // Covers the unchanged 5 s execution and bounded collection windows.
  }

  test("reaps the owned process group when spawn bookkeeping rejects", async () => {
    const root = await temporaryRoot("hra-dev-child-bookkeeping-");
    const controller = new AbortController();
    let pid: number | undefined;
    let collectionProved = false;
    const running = runOwnedDevProcess({
      command: [process.execPath, "-e", "setTimeout(()=>{},12000)"],
      cwd: root,
      deadlineMilliseconds: 5_000,
      onSpawn: (childPid) => {
        pid = childPid;
        throw new Error("fixture bookkeeping failure");
      },
      signal: controller.signal,
    }).then(() => ({ kind: "resolved" as const }), (error: unknown) => ({ error, kind: "rejected" as const }));
    try {
      const outcome = await running;
      expect(() => { if (outcome.kind === "rejected") throw outcome.error; },
        `Owned bookkeeping cleanup: ${safeDevCollectionFailureDiagnostic(outcome.kind === "rejected" ? outcome.error : undefined)}`)
        .toThrow(/bookkeeping failure/u);
      assertDevFixtureAbsent(pid);
      collectionProved = true;
    } finally {
      controller.abort();
      await running;
      if (!collectionProved) preserveDevFixture(root);
    }
  }, 15_000);
});
