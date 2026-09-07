import { link, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  appDevRevision,
  assertDevCacheCapacity,
  createDevRequestHandler,
  DevBuildCoordinator,
  DevCapacityError,
  DevStaleBuildError,
  DevTransientBuildError,
  HRA_DEV_CACHE_LIMITS,
  parseDevSecurityHeaders,
  prepareDevCache,
  prepareLockedDevCache,
  publishDevCandidate,
  runOwnedDevProcess,
  snapshotDevInputs,
  type DevBuildCandidate,
  type DevInputSnapshot,
  type DevPublishedRevision,
  type DevStatus,
} from "./dev-app.ts";
import {
  acquireAppPublicationLock, appSha256, createAppSourceMarkerEvidence, readAppInventory,
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

describe("cache, security, and owned process boundaries", () => {
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

  test("terminates and reaps its exact child when a build is aborted", async () => {
    const root = await temporaryRoot("hra-dev-child-");
    const controller = new AbortController();
    let pid: number | undefined;
    const running = runOwnedDevProcess({
      command: [
        process.execPath,
        "-e",
        "Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});setInterval(()=>{},1000)",
      ],
      cwd: root,
      deadlineMilliseconds: 5_000,
      onSpawn: (childPid) => {
        pid = childPid;
        setTimeout(() => controller.abort(), 20);
      },
      signal: controller.signal,
    });
    await expect(running).rejects.toThrow(/aborted/u);
    expect(pid).toBeNumber();
    expect(() => process.kill(pid ?? -1, 0)).toThrow();
    expect(() => process.kill(-(pid ?? 1), 0)).toThrow();
  });

  test("reaps the owned process group when spawn bookkeeping rejects", async () => {
    const root = await temporaryRoot("hra-dev-child-bookkeeping-");
    const controller = new AbortController();
    let pid: number | undefined;
    await expect(runOwnedDevProcess({
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: root,
      deadlineMilliseconds: 5_000,
      onSpawn: (childPid) => {
        pid = childPid;
        throw new Error("fixture bookkeeping failure");
      },
      signal: controller.signal,
    })).rejects.toThrow(/bookkeeping failure/u);
    expect(pid).toBeNumber();
    expect(() => process.kill(-(pid ?? 1), 0)).toThrow();
  });
});
