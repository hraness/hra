import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalSha256,
  createKnowledgeGraphRecordV1,
} from "@hraness/oh";
import { createOhSqliteStoreAuthorityV1 } from "@hraness/oh/sqlite";
import { OH_CANONICAL_STORE_PROFILE_V1 } from "@hraness/oh/store";

import type {
  HraMemoryRememberInput,
} from "../domain/host-tools";
import { FactsMemoryControlStore } from "../storage/facts-memory-control";
import { LocalFactsMemoryBroker } from "../storage/local-facts-memory-broker";
import { OhSqliteFactsMemoryEngine } from "../storage/oh-facts-memory-engine";
import {
  initializeStatePaths,
  resolveStatePaths,
  type StatePaths,
} from "../storage/paths";
import { StateStore, type ProjectRecord, type SessionRecord } from "../storage/state-store";
import {
  HraFactsMemoryLifecycle,
  type HraFactsMemoryLifecyclePort,
} from "./facts-memory-lifecycle";
import {
  HraMemoryRefusalError,
  HraOhMemoryCoordinator,
} from "./memory-coordinator";

type Clock = {
  monotonic: number;
  wall: number;
};

type Runtime = Readonly<{
  control: FactsMemoryControlStore;
  coordinator: HraOhMemoryCoordinator;
  engine: OhSqliteFactsMemoryEngine;
  lifecycle: HraFactsMemoryLifecycle;
  store: StateStore;
}>;

const roots: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    await runtime.coordinator.close().catch(() => undefined);
    try {
      runtime.control.close();
    } catch {
      // A restart test may already have closed this exact handle.
    }
    try {
      runtime.store.close();
    } catch {
      // A restart test may already have closed this exact handle.
    }
  }
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

class FailPostCommitSettlementOnce implements HraFactsMemoryLifecyclePort {
  #failEnsureAfterResume = false;
  #failResume = true;

  constructor(readonly delegate: HraFactsMemoryLifecyclePort) {}

  cleanupSession(
    input: Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0],
  ) {
    return this.delegate.cleanupSession(input);
  }

  ensureSession(
    input: Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0],
  ) {
    if (this.#failEnsureAfterResume) {
      this.#failEnsureAfterResume = false;
      return Promise.reject(new Error("CONTROLLED_RESTART_BOUNDARY"));
    }
    return this.delegate.ensureSession(input);
  }

  forkSession(
    input: Parameters<HraFactsMemoryLifecyclePort["forkSession"]>[0],
  ) {
    return this.delegate.forkSession(input);
  }

  readSession(
    sessionId: Parameters<HraFactsMemoryLifecyclePort["readSession"]>[0],
  ) {
    return this.delegate.readSession(sessionId);
  }

  resumeSession(
    input: Parameters<HraFactsMemoryLifecyclePort["resumeSession"]>[0],
  ) {
    if (this.#failResume) {
      this.#failResume = false;
      this.#failEnsureAfterResume = true;
      return Promise.reject(new Error("CONTROLLED_POST_COMMIT_SETTLEMENT_FAILURE"));
    }
    return this.delegate.resumeSession(input);
  }

  sweepExpired(
    ...input: Parameters<HraFactsMemoryLifecyclePort["sweepExpired"]>
  ) {
    return this.delegate.sweepExpired(...input);
  }
}

class GateFirstEnsure implements HraFactsMemoryLifecyclePort {
  readonly entered: Promise<void>;
  #enter!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;
  #waiting = true;

  constructor(readonly delegate: HraFactsMemoryLifecyclePort) {
    this.entered = new Promise((resolve) => { this.#enter = resolve; });
    this.#released = new Promise((resolve) => { this.#release = resolve; });
  }

  release(): void {
    this.#release();
  }

  cleanupSession(
    input: Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0],
  ) {
    return this.delegate.cleanupSession(input);
  }

  async ensureSession(
    input: Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0],
  ) {
    if (this.#waiting) {
      this.#waiting = false;
      this.#enter();
      await this.#released;
    }
    return await this.delegate.ensureSession(input);
  }

  forkSession(
    input: Parameters<HraFactsMemoryLifecyclePort["forkSession"]>[0],
  ) {
    return this.delegate.forkSession(input);
  }

  readSession(
    sessionId: Parameters<HraFactsMemoryLifecyclePort["readSession"]>[0],
  ) {
    return this.delegate.readSession(sessionId);
  }

  resumeSession(
    input: Parameters<HraFactsMemoryLifecyclePort["resumeSession"]>[0],
  ) {
    return this.delegate.resumeSession(input);
  }

  sweepExpired(
    ...input: Parameters<HraFactsMemoryLifecyclePort["sweepExpired"]>
  ) {
    return this.delegate.sweepExpired(...input);
  }
}

class FailArmedEnsureOnce implements HraFactsMemoryLifecyclePort {
  #armed = false;

  constructor(readonly delegate: HraFactsMemoryLifecyclePort) {}

  arm(): void {
    this.#armed = true;
  }

  cleanupSession(
    input: Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0],
  ) {
    return this.delegate.cleanupSession(input);
  }

  ensureSession(
    input: Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0],
  ) {
    if (this.#armed) {
      this.#armed = false;
      return Promise.reject(new Error("CONTROLLED_SHARE_RECOVERY_BOUNDARY"));
    }
    return this.delegate.ensureSession(input);
  }

  forkSession(
    input: Parameters<HraFactsMemoryLifecyclePort["forkSession"]>[0],
  ) {
    return this.delegate.forkSession(input);
  }

  readSession(
    sessionId: Parameters<HraFactsMemoryLifecyclePort["readSession"]>[0],
  ) {
    return this.delegate.readSession(sessionId);
  }

  resumeSession(
    input: Parameters<HraFactsMemoryLifecyclePort["resumeSession"]>[0],
  ) {
    return this.delegate.resumeSession(input);
  }

  sweepExpired(
    ...input: Parameters<HraFactsMemoryLifecyclePort["sweepExpired"]>
  ) {
    return this.delegate.sweepExpired(...input);
  }
}

const makeRuntime = (
  paths: StatePaths,
  clock: Clock,
  wrapLifecycle?: (
    lifecycle: HraFactsMemoryLifecycle,
  ) => HraFactsMemoryLifecyclePort,
): Runtime => {
  const now = () => clock.wall++;
  const store = new StateStore(paths, { now });
  const control = new FactsMemoryControlStore(paths.factsMemoryControl, { now });
  const engine = new OhSqliteFactsMemoryEngine({ forkAttestations: store, now });
  const broker = new LocalFactsMemoryBroker({
    engine,
    now,
    root: paths.factsMemorySessions,
  });
  const lifecycle = new HraFactsMemoryLifecycle({
    attestations: store,
    broker,
    control,
  });
  const coordinator = new HraOhMemoryCoordinator({
    continuationKey: new Uint8Array(32).fill(17),
    engine,
    factsMemory: wrapLifecycle?.(lifecycle) ?? lifecycle,
    monotonicNow: () => clock.monotonic,
    now,
    paths,
    store,
  });
  const runtime = { control, coordinator, engine, lifecycle, store };
  runtimes.push(runtime);
  return runtime;
};

const failNextAdoptedShareSettlement = (
  runtime: Runtime,
  recoveryBoundary: FailArmedEnsureOnce,
): void => {
  const originalSettle = runtime.store.settleMemorySubmission.bind(runtime.store);
  let failShareSettlement = true;
  Object.defineProperty(runtime.store, "settleMemorySubmission", {
    configurable: true,
    value: (settlement: Parameters<StateStore["settleMemorySubmission"]>[0]) => {
      if (
        failShareSettlement
        && settlement.state === "applied"
        && settlement.outcomeCode === "share_adopted"
      ) {
        failShareSettlement = false;
        recoveryBoundary.arm();
        throw new Error("CONTROLLED_POST_ADOPTION_SETTLEMENT_FAILURE");
      }
      return originalSettle(settlement);
    },
  });
};

const createFixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-memory-coordinator-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock: Clock = {
    monotonic: 25_000,
    wall: Date.parse("2026-09-04T12:00:00.000Z"),
  };
  const runtime = makeRuntime(paths, clock);
  const profile = runtime.store.createProfile("Memory owner");
  const generation = runtime.store.nextProfileGeneration(profile.id);
  expect(runtime.store.setProfileState(
    generation.id,
    generation.processGeneration,
    "signed_in",
    { email: "memory-owner@example.com", plan: "Plus" },
  )).toBe(true);
  const firstRoot = join(home, "first-project");
  const secondRoot = join(home, "second-project");
  await Promise.all([
    mkdir(firstRoot, { recursive: true }),
    mkdir(secondRoot, { recursive: true }),
  ]);
  const firstProject = await runtime.store.createProject("First project", firstRoot, true);
  const secondProject = await runtime.store.createProject("Second project", secondRoot);
  const session = (project: ProjectRecord, title: string): SessionRecord =>
    runtime.store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      projectId: project.id,
      title,
    });
  return {
    clock,
    firstProject,
    paths,
    profile,
    runtime,
    secondProject,
    session,
  };
};

const operationInput = (index: number, label: string) => ({
  idempotencyKey: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  requestDigest: canonicalSha256({ index, label, v: 1 }),
});

const page = (overrides: Partial<HraMemoryRememberInput> = {}): HraMemoryRememberInput => ({
  body: "The project owner serializes canonical memory updates and fails closed on conflicts.",
  key: "architecture/canonical-owner",
  language: "en",
  summary: "Alpha durable canonical ownership",
  title: "Alpha memory authority",
  ...overrides,
});

const expectRefusal = async (
  operation: Promise<unknown>,
  code: HraMemoryRefusalError["code"],
) => {
  try {
    await operation;
    throw new Error("Expected memory operation to be refused.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HraMemoryRefusalError);
    expect((error as HraMemoryRefusalError).code).toBe(code);
  }
};

describe("HRA Oh memory coordinator integration", () => {
  test("remembers, queries, explains, shares by project, and never overwrites a conflict", async () => {
    const value = await createFixture();
    const author = value.session(value.firstProject, "Author");
    const peer = value.session(value.firstProject, "Project peer");
    const outsider = value.session(value.secondProject, "Other project");
    const memory = page();

    const remembered = await value.runtime.coordinator.remember({
      actorSessionId: author.id,
      ...operationInput(1, "remember-alpha"),
      value: memory,
    });
    expect(remembered).toMatchObject({
      ok: true,
      replay: false,
      submission: { kind: "remember", state: "applied" },
      page: { key: memory.key },
    });

    const listed = await value.runtime.coordinator.query({
      actorSessionId: author.id,
      value: { mode: "list" },
    }) as { queryId: string; rows: readonly Record<string, unknown>[] };
    expect(listed.rows).toEqual([
      expect.objectContaining({
        key: memory.key,
        lane: "working",
        provenance: expect.objectContaining({ verification: "local-ledger-verified" }),
      }),
    ]);
    await expect(value.runtime.coordinator.explain({
      actorSessionId: author.id,
      value: { queryId: listed.queryId, row: 0 },
    })).resolves.toMatchObject({
      ok: true,
      queryId: listed.queryId,
      row: 0,
      explanation: expect.objectContaining({ resultSha256: expect.any(String) }),
    });

    await expect(value.runtime.coordinator.query({
      actorSessionId: author.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      ok: true,
      mode: "get",
      rows: [expect.objectContaining({
        bodyChunk: memory.body,
        key: memory.key,
        lane: "working",
      })],
    });
    await expect(value.runtime.coordinator.query({
      actorSessionId: author.id,
      value: { mode: "search", text: "alpha durable" },
    })).resolves.toMatchObject({
      ok: true,
      matchedTokens: ["alpha", "durable"],
      rows: [expect.objectContaining({ key: memory.key, lane: "working" })],
    });

    const shared = await value.runtime.coordinator.share({
      actorSessionId: author.id,
      ...operationInput(2, "share-alpha"),
      value: { key: memory.key, reason: "Project-level architectural invariant" },
    }) as { share: { recordSha256: string } };
    expect(shared).toMatchObject({
      ok: true,
      replay: false,
      share: { key: memory.key, status: "adopted" },
      submission: { kind: "share", state: "applied" },
    });

    await expect(value.runtime.coordinator.query({
      actorSessionId: peer.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({
        bodyChunk: memory.body,
        key: memory.key,
        lane: "canonical",
      })],
    });
    await expect(value.runtime.coordinator.query({
      actorSessionId: outsider.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({ ok: true, rows: [] });

    const conflicting = page({
      body: "A peer proposed a different owner, which must not replace canonical memory implicitly.",
      summary: "Conflicting beta ownership",
      title: "Beta memory authority",
    });
    const peerRemembered = await value.runtime.coordinator.remember({
      actorSessionId: peer.id,
      ...operationInput(3, "remember-conflict"),
      value: conflicting,
    }) as { page: { recordSha256: string } };
    const conflict = await value.runtime.coordinator.share({
      actorSessionId: peer.id,
      ...operationInput(4, "share-conflict"),
      value: { key: conflicting.key, reason: "Attempted implicit replacement" },
    });
    expect(conflict).toMatchObject({
      code: "MEMORY_SHARE_CONFLICT",
      ok: false,
      conflict: {
        canonicalRecordSha256: shared.share.recordSha256,
        key: memory.key,
        nominatedRecordSha256: peerRemembered.page.recordSha256,
      },
      submission: { kind: "share", state: "failed" },
    });

    const freshPeer = value.session(value.firstProject, "Fresh project peer");
    await expect(value.runtime.coordinator.query({
      actorSessionId: freshPeer.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      rows: [expect.objectContaining({
        bodyChunk: memory.body,
        lane: "canonical",
        recordSha256: shared.share.recordSha256,
      })],
    });
  });

  test("recovers exactly after Oh committed remember but HRA settlement lost its response", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Crash recovery");

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    const failing = makeRuntime(
      value.paths,
      value.clock,
      (lifecycle) => new FailPostCommitSettlementOnce(lifecycle),
    );
    const input = {
      actorSessionId: actor.id,
      ...operationInput(10, "remember-crash-window"),
      value: page({ key: "recovery/exact-window", title: "Exact recovery window" }),
    } as const;

    await expect(failing.coordinator.remember(input))
      .rejects.toThrow("CONTROLLED_POST_COMMIT_SETTLEMENT_FAILURE");
    expect(failing.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ kind: "remember", state: "ambiguous" });

    await failing.coordinator.close();
    failing.control.close();
    failing.store.close();
    const restarted = makeRuntime(value.paths, value.clock);
    await restarted.coordinator.recover();
    expect(restarted.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ outcomeCode: "remember_committed", state: "applied" });
    await expect(restarted.coordinator.remember(input)).resolves.toMatchObject({
      ok: true,
      replay: true,
      submission: { kind: "remember", state: "applied" },
    });
    await expect(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { key: input.value.key, mode: "get" },
    })).resolves.toMatchObject({
      rows: [expect.objectContaining({
        bodyChunk: input.value.body,
        key: input.value.key,
        provenance: expect.objectContaining({ verification: "local-ledger-verified" }),
      })],
    });
  });

  test("recovers an exact canonical adoption without quarantining it as out-of-band", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Share crash recovery");
    const memory = page({
      key: "recovery/exact-share-window",
      title: "Exact share recovery window",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(11, "remember-before-share-crash"),
      value: memory,
    });

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    let recoveryBoundary: FailArmedEnsureOnce | undefined;
    const failing = makeRuntime(value.paths, value.clock, (lifecycle) => {
      recoveryBoundary = new FailArmedEnsureOnce(lifecycle);
      return recoveryBoundary;
    });
    if (recoveryBoundary === undefined) throw new Error("Expected a share recovery boundary.");
    failNextAdoptedShareSettlement(failing, recoveryBoundary);
    const input = {
      actorSessionId: actor.id,
      ...operationInput(12, "share-crash-window"),
      value: { key: memory.key, reason: "Exact post-adoption recovery proof" },
    } as const;

    await expect(failing.coordinator.share(input))
      .rejects.toThrow("CONTROLLED_POST_ADOPTION_SETTLEMENT_FAILURE");
    expect(failing.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ kind: "share", state: "ambiguous" });

    await failing.coordinator.close();
    failing.control.close();
    failing.store.close();
    const restarted = makeRuntime(value.paths, value.clock);
    await restarted.coordinator.recover();
    expect(restarted.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ outcomeCode: "share_adopted", state: "applied" });
    const recoveredAuthority = restarted.store.readProjectMemoryAuthority(value.firstProject.id);
    expect(recoveredAuthority).toMatchObject({ syncState: "local_only" });
    expect(recoveredAuthority?.diagnosticCode).toBeUndefined();
    await expect(restarted.coordinator.share(input)).resolves.toMatchObject({
      ok: true,
      replay: true,
      share: { key: memory.key, status: "adopted" },
      submission: { kind: "share", state: "applied" },
    });
    await expect(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({
        bodyChunk: memory.body,
        key: memory.key,
        lane: "canonical",
      })]),
    });
  });

  test("keeps a recovered adoption frozen when a later canonical operation is unexplained", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Share divergence recovery");
    const memory = page({
      key: "recovery/share-followed-by-divergence",
      title: "Share followed by divergence",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(13, "remember-before-share-divergence"),
      value: memory,
    });

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    let recoveryBoundary: FailArmedEnsureOnce | undefined;
    const failing = makeRuntime(value.paths, value.clock, (lifecycle) => {
      recoveryBoundary = new FailArmedEnsureOnce(lifecycle);
      return recoveryBoundary;
    });
    if (recoveryBoundary === undefined) throw new Error("Expected a share recovery boundary.");
    failNextAdoptedShareSettlement(failing, recoveryBoundary);
    const input = {
      actorSessionId: actor.id,
      ...operationInput(14, "share-before-divergence"),
      value: { key: memory.key, reason: "Prove recovery stays closed past the exact effect" },
    } as const;
    await expect(failing.coordinator.share(input))
      .rejects.toThrow("CONTROLLED_POST_ADOPTION_SETTLEMENT_FAILURE");

    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: `hra:project-memory:${projectDigest}`,
      spaceId: `hra:project:${projectDigest}`,
    });
    try {
      await canonical.store.commit({
        actorId: "test.out-of-band-after-adoption",
        changes: [{
          kind: "put",
          record: createKnowledgeGraphRecordV1({
            dependencies: [],
            key: "entity:post-adoption-divergence",
            kind: "entity",
            v: 1,
            value: { label: "Unexplained operation after the recoverable adoption" },
          }),
          v: 1,
        }],
        expectedHead: await canonical.store.head(),
        operationId: "test.post-adoption-canonical-divergence",
      });
    } finally {
      await canonical.store.close();
    }

    await failing.coordinator.close();
    failing.control.close();
    failing.store.close();
    const restarted = makeRuntime(value.paths, value.clock);
    await restarted.coordinator.recover();
    expect(restarted.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ outcomeCode: "share_adopted", state: "applied" });
    expect(restarted.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      syncState: "error",
    });
    await expectRefusal(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
  });

  test("refuses a materialized get continuation after its working head changes", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Continuation owner");
    const large = page({
      body: "a".repeat(13 * 1_024),
      key: "continuations/large-page",
      title: "Large continuation page",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(20, "remember-large"),
      value: large,
    });
    const first = await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { key: large.key, mode: "get" },
    }) as { continuation: string | null; rows: readonly unknown[] };
    expect(first.rows).toHaveLength(2);
    if (first.continuation === null) throw new Error("Expected a get continuation.");

    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(21, "remember-head-change"),
      value: page({ key: "continuations/head-change", title: "Head change" }),
    });
    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: {
        continuation: first.continuation,
        key: large.key,
        mode: "get",
      },
    }), "MEMORY_CONTINUATION_REFUSED");
  });

  test("durably freezes a project when its canonical Oh head advances out of band", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Canonical custody");
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });

    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: `hra:project-memory:${projectDigest}`,
      spaceId: `hra:project:${projectDigest}`,
    });
    try {
      await canonical.store.commit({
        actorId: "test.out-of-band-writer",
        changes: [{
          kind: "put",
          record: createKnowledgeGraphRecordV1({
            dependencies: [],
            key: "entity:out-of-band",
            kind: "entity",
            v: 1,
            value: { label: "Uncoordinated canonical mutation" },
          }),
          v: 1,
        }],
        expectedHead: await canonical.store.head(),
        operationId: "test.out-of-band-canonical-mutation",
      });
    } finally {
      await canonical.store.close();
    }

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      syncState: "error",
    });
    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
  });

  test("refuses a queued operation when the session changes projects before its tail starts", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Queued project change");

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    let gate: GateFirstEnsure | undefined;
    const restarted = makeRuntime(value.paths, value.clock, (lifecycle) => {
      gate = new GateFirstEnsure(lifecycle);
      return gate;
    });

    const first = restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });
    if (gate === undefined) throw new Error("Expected a lifecycle gate.");
    await gate.entered;
    const queuedRefusal = expectRefusal(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_RECOVERY_REQUIRED");

    const current = restarted.store.requireSession(actor.id);
    restarted.store.updateSessionMetadata({
      sessionId: current.id,
      expectedRevision: current.revision,
      projectId: value.secondProject.id,
    });
    gate.release();

    await expect(first).resolves.toMatchObject({ ok: true, mode: "list" });
    await queuedRefusal;
    expect(restarted.store.readProjectMemoryAuthority(value.secondProject.id)).toBeNull();
  });
});
