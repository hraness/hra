import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalSha256 } from "@hraness/oh";
import {
  createOhMemoryPageRecordV1,
  createOhMemoryPageValueV1,
} from "@hraness/oh/memory";
import { createOhSqliteStoreAuthorityV1 } from "@hraness/oh/sqlite";
import { OH_CANONICAL_STORE_PROFILE_V1 } from "@hraness/oh/store";

import { ProjectMemorySerialExecutor } from "../daemon/project-memory-serial.ts";
import {
  createPortableProjectMemoryCanonicalIdentity,
  PROJECT_MEMORY_EMPTY_HEAD,
} from "../domain/project-memory.ts";
import { memoryPagePhysicalKey } from "../domain/memory-page.ts";
import { OhSqliteFactsMemoryEngine, digestOhHead } from "../storage/oh-facts-memory-engine.ts";
import {
  ensurePrivateDirectory,
  initializeStatePaths,
  resolveStatePaths,
} from "../storage/paths.ts";
import { StateStore } from "../storage/state-store.ts";
import { OompaMemorySummarySource } from "./memory-summary-source.ts";
import { memorySummaryFitsEncryptedEnvelope } from "./payloads.ts";

const roots: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) store.close();
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

const page = (key: string, body: string, updatedAt: string) =>
  createOhMemoryPageRecordV1({
    dependencies: [],
    key: memoryPagePhysicalKey(key),
    value: createOhMemoryPageValueV1({
      body,
      createdAt: updatedAt,
      format: "oh.memory-page.v1",
      language: "en",
      provenance: {
        actorId: "hra.memory.host",
        attestationSha256: canonicalSha256({ key, v: 1 }),
        attestedAt: updatedAt,
        kind: "host-attested",
        v: 1,
      },
      sources: [],
      summary: `Summary ${key}`,
      title: `Title ${key}`,
      updatedAt,
      v: 1,
    }),
  });

describe("hosted memory summary source", () => {
  test("projects exact Oh metadata with device-scoped peer refs and fails a drifting space closed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-memory-summary-")));
    roots.push(root);
    const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
    await initializeStatePaths(paths);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const now = 1_800_000_000_000;
    const observedAt = now - 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const project = await store.createProject("Oompa", projectRoot, true);
    const profile = store.createProfile("Personal");
    const session = store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      projectId: project.id,
      title: "Planner",
    });
    const policy = store.requirePeerSessionPolicy(session.id);
    store.setPeerSessionPolicy({
      expectedRevision: policy.revision,
      mode: "coordinate",
      sessionId: session.id,
    });

    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const reserved = store.reserveProjectMemoryAuthority({
      canonicalSpaceId: identity.canonicalSpaceId,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: 2,
      projectId: project.id,
    });
    const initialized = store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const directory = resolve(join(
      paths.projectMemory,
      canonicalSha256({ projectId: project.id, v: 1 }),
    ));
    await ensurePrivateDirectory(directory);
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(directory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    const firstRecord = page("release-policy", "private body", "2026-09-04T00:00:00.000Z");
    const futureRecord = page(
      "future-import",
      "private future body",
      new Date(now + 60_000).toISOString(),
    );
    await canonical.store.commit({
      actorId: "hra.memory.host",
      changes: [
        { kind: "put", record: firstRecord, v: 1 },
        { kind: "put", record: futureRecord, v: 1 },
      ],
      expectedHead: await canonical.store.head(),
      operationId: "oompa.memory.test.summary-first",
    });
    const firstHead = await canonical.store.head();
    await canonical.store.close();
    store.compareAndSwapProjectMemoryHead({
      expectedHead: initialized.head,
      expectedRevision: initialized.revision,
      nextHead: {
        headDigest: digestOhHead(firstHead),
        operationSha256: firstHead.operationSha256,
        sequence: firstHead.sequence,
      },
      projectId: project.id,
    });

    const engine = new OhSqliteFactsMemoryEngine({ forkAttestations: store });
    const options = {
      engine,
      now: () => observedAt,
      paths,
      projectSerial: new ProjectMemorySerialExecutor(),
      store,
    };
    const first = await new OompaMemorySummarySource({
      ...options,
      identityNamespace: "a".repeat(24),
    }).read({
      devicePublicId: "device_summary_a",
      signal: new AbortController().signal,
    });
    expect(first.observedAt).toBe(observedAt);
    expect(first.coverage).toEqual({
      peerActions: "complete",
      peerPolicies: "complete",
      spaces: "complete",
    });
    expect(first.spaces).toEqual([expect.objectContaining({
      canonicalSpaceId: identity.canonicalSpaceId,
      enrollment: "not_enrolled",
      head: expect.objectContaining({ sequence: 1 }),
      recentRecords: [
        {
          key: "future-import",
          kind: "memory_page",
          updatedAt: observedAt,
        },
        {
          key: "release-policy",
          kind: "memory_page",
          updatedAt: Date.parse("2026-09-04T00:00:00.000Z"),
        },
      ],
      recordCount: 2,
      syncStatus: "local_only",
    })]);
    expect(first.peerPolicies).toEqual([expect.objectContaining({
      mode: "coordinate",
      projectLabel: "Oompa",
      session: expect.objectContaining({ label: "Planner" }),
      updatedAt: observedAt,
    })]);
    const encoded = JSON.stringify(first);
    expect(encoded).not.toContain(project.id);
    expect(encoded).not.toContain(session.id);
    expect(encoded).not.toContain(projectRoot);
    expect(encoded).not.toContain("private body");

    const secondNamespace = await new OompaMemorySummarySource({
      ...options,
      identityNamespace: "b".repeat(24),
    }).read({
      devicePublicId: "device_summary_a",
      signal: new AbortController().signal,
    });
    expect(secondNamespace.peerPolicies[0]?.session.ref)
      .not.toBe(first.peerPolicies[0]?.session.ref);
    const secondDevice = await new OompaMemorySummarySource({
      ...options,
      identityNamespace: "a".repeat(24),
    }).read({
      devicePublicId: "device_summary_b",
      signal: new AbortController().signal,
    });
    expect(secondDevice.peerPolicies[0]?.session.ref)
      .not.toBe(first.peerPolicies[0]?.session.ref);

    const advanced = createOhSqliteStoreAuthorityV1({
      path: join(directory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    await advanced.store.commit({
      actorId: "hra.memory.host",
      changes: [{
        kind: "put",
        record: page("unsettled", "not published", "2026-09-05T00:00:00.000Z"),
        v: 1,
      }],
      expectedHead: await advanced.store.head(),
      operationId: "oompa.memory.test.summary-unsettled",
    });
    await advanced.store.close();
    const drifted = await new OompaMemorySummarySource({
      ...options,
      identityNamespace: "a".repeat(24),
    }).read({
      devicePublicId: "device_summary_a",
      signal: new AbortController().signal,
    });
    expect(drifted.spaces[0]).toMatchObject({
      enrollment: "unavailable",
      recentRecords: [],
      recordCount: null,
      syncStatus: "error",
    });
  });

  test("keeps the portable-space projection useful and deterministic at 100 then 101 spaces", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-memory-summary-spaces-")));
    roots.push(root);
    const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_800_000_000_000 });
    stores.push(store);
    const canonicalSpaceIds: string[] = [];
    const addProject = async (index: number) => {
      const projectRoot = join(root, `project-${index.toString().padStart(3, "0")}`);
      await mkdir(projectRoot);
      const project = await store.createProject(`Project ${index}`, projectRoot, index === 0);
      const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
      canonicalSpaceIds.push(identity.canonicalSpaceId);
      store.reserveProjectMemoryAuthority({
        canonicalSpaceId: identity.canonicalSpaceId,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        identityContract: 2,
        projectId: project.id,
      });
    };
    for (let index = 0; index < 100; index += 1) await addProject(index);
    const source = new OompaMemorySummarySource({
      engine: new OhSqliteFactsMemoryEngine({ forkAttestations: store }),
      identityNamespace: "e".repeat(24),
      now: () => 1_800_000_000_000,
      paths,
      projectSerial: new ProjectMemorySerialExecutor(),
      store,
    });
    const exact = await source.read({
      devicePublicId: "device_summary_spaces",
      signal: new AbortController().signal,
    });
    expect(exact.coverage.spaces).toBe("complete");
    expect(exact.spaces).toHaveLength(100);

    await addProject(100);
    const bounded = await source.read({
      devicePublicId: "device_summary_spaces",
      signal: new AbortController().signal,
    });
    expect(bounded.coverage.spaces).toBe("bounded");
    expect(bounded.spaces).toHaveLength(100);
    expect(bounded.spaces.map((space) => space.canonicalSpaceId))
      .toEqual([...canonicalSpaceIds].sort().slice(0, 100));
    expect((await source.read({
      devicePublicId: "device_summary_spaces",
      signal: new AbortController().signal,
    })).spaces).toEqual(bounded.spaces);
  }, 20_000);

  test("keeps the effective-policy projection useful and deterministic at 200 then 201 policies", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-memory-summary-policies-")));
    roots.push(root);
    const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
    await initializeStatePaths(paths);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = new StateStore(paths, { now: () => 1_800_000_000_000 });
    stores.push(store);
    const project = await store.createProject("Oompa", projectRoot, true);
    const profile = store.createProfile("Personal");
    const addSession = (index: number) => store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      projectId: project.id,
      title: `Session ${index.toString().padStart(3, "0")}`,
    });
    for (let index = 0; index < 200; index += 1) addSession(index);
    const source = new OompaMemorySummarySource({
      engine: new OhSqliteFactsMemoryEngine({ forkAttestations: store }),
      identityNamespace: "f".repeat(24),
      now: () => 1_800_000_000_000,
      paths,
      projectSerial: new ProjectMemorySerialExecutor(),
      store,
    });
    const exact = await source.read({
      devicePublicId: "device_summary_policies",
      signal: new AbortController().signal,
    });
    expect(exact.coverage.peerPolicies).toBe("complete");
    expect(exact.peerPolicies).toHaveLength(200);

    addSession(200);
    const bounded = await source.read({
      devicePublicId: "device_summary_policies",
      signal: new AbortController().signal,
    });
    expect(bounded.coverage.peerPolicies).toBe("bounded");
    expect(bounded.peerPolicies).toHaveLength(200);
    expect((await source.read({
      devicePublicId: "device_summary_policies",
      signal: new AbortController().signal,
    })).peerPolicies).toEqual(bounded.peerPolicies);
  }, 20_000);

  test("byte-bounds maximum-length policy labels without clearing the whole projection", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-memory-summary-wire-limit-")));
    roots.push(root);
    const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
    await initializeStatePaths(paths);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = new StateStore(paths, { now: () => 1_800_000_000_000 });
    stores.push(store);
    const project = await store.createProject("P".repeat(160), projectRoot, true);
    const profile = store.createProfile("Personal");
    for (let index = 0; index < 200; index += 1) {
      store.createSession({
        fastEnabled: false,
        preset: "high",
        profileId: profile.id,
        projectId: project.id,
        title: `${index.toString().padStart(3, "0")}${"S".repeat(197)}`,
      });
    }
    const source = new OompaMemorySummarySource({
      engine: new OhSqliteFactsMemoryEngine({ forkAttestations: store }),
      identityNamespace: "1".repeat(24),
      now: () => 1_800_000_000_000,
      paths,
      projectSerial: new ProjectMemorySerialExecutor(),
      store,
    });

    const first = await source.read({
      devicePublicId: "device_summary_wire_limit",
      signal: new AbortController().signal,
    });
    const second = await source.read({
      devicePublicId: "device_summary_wire_limit",
      signal: new AbortController().signal,
    });
    expect(memorySummaryFitsEncryptedEnvelope(first)).toBe(true);
    expect(first.coverage.peerPolicies).toBe("bounded");
    expect(first.peerPolicies.length).toBeGreaterThan(0);
    expect(first.peerPolicies.length).toBeLessThan(200);
    expect(second).toEqual(first);
  }, 20_000);
});
