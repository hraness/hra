import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKnowledgeGraphRecordV1 } from "@hraness/oh";
import { createOhSqliteStoreAuthorityV1 } from "@hraness/oh/sqlite";
import { OH_WORKING_STORE_PROFILE_V1 } from "@hraness/oh/store";

import {
  createFactsMemoryBinding,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
} from "../domain/facts-memory";
import { LocalFactsMemoryBroker } from "./local-facts-memory-broker";
import { OhSqliteFactsMemoryEngine } from "./oh-facts-memory-engine";
import { ensurePrivateDirectory } from "./paths";

const ownerId = `acct_${"a".repeat(32)}`;
const otherOwnerId = `acct_${"b".repeat(32)}`;
const parentSessionId = `sess_${"1".repeat(32)}`;
const childSessionId = `sess_${"2".repeat(32)}`;
const metadataName = ".hra-oh-adapter-v1.json";
const pendingMetadataName = ".hra-oh-adapter-v1.pending";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

const fixture = async (now: () => number = () => 100) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-oh-engine-")));
  roots.push(root);
  await chmod(root, 0o700);
  const engine = new OhSqliteFactsMemoryEngine({ now });
  const broker = new LocalFactsMemoryBroker({ engine, now, root });
  return { broker, engine, root };
};

const openOhAuthority = (binding: FactsMemoryBinding, directory: string) =>
  createOhSqliteStoreAuthorityV1({
    path: join(directory, "oh.sqlite"),
    profile: OH_WORKING_STORE_PROFILE_V1,
    realmId: `hra:${binding.bindingDigest}`,
    spaceId: `hra:${binding.sessionId}`,
  });

const inspectionHead = async (
  broker: LocalFactsMemoryBroker,
  binding: FactsMemoryBinding,
) => {
  const inspected = await broker.inspect(binding);
  if (inspected.status !== "present") throw new Error("Expected an active Oh store.");
  return inspected.inspection.head;
};

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

describe("released Oh SQLite facts-memory adapter", () => {
  test("pins the immutable v0.2.0 release without installing optional semantic peers", async () => {
    const packageDocument = JSON.parse(
      await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(packageDocument.dependencies?.["@hraness/oh"])
      .toBe("github:hraness/oh#v0.2.0");
    const lockfile = await readFile(join(import.meta.dir, "..", "..", "bun.lock"), "utf8");
    expect(lockfile).toContain("@hraness/oh@github:hraness/oh#89fb133");
    await expect(lstat(join(import.meta.dir, "..", "..", "node_modules", "@suss", "datalog")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("creates, verifies, reopens, advances, and physically purges one working store", async () => {
    let now = 100;
    const { broker, root } = await fixture(() => now);
    const binding = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const created = await broker.create({ binding, operationKey: `create:${binding.sessionId}` });
    expect(created).toMatchObject({ createdAt: 100, head: { sequence: 0 } });
    const databasePath = join(root, binding.sessionId, "oh.sqlite");
    expect((await lstat(databasePath)).isFile()).toBe(true);
    expect((await lstat(databasePath)).mode & 0o077).toBe(0);
    expect((await lstat(join(root, binding.sessionId, metadataName))).mode & 0o077).toBe(0);

    await rename(
      join(root, binding.sessionId, metadataName),
      join(root, binding.sessionId, pendingMetadataName),
    );
    const restartedBroker = new LocalFactsMemoryBroker({
      engine: new OhSqliteFactsMemoryEngine({ now: () => 150 }),
      now: () => 150,
      root,
    });
    await expect(restartedBroker.inspect(binding)).resolves.toMatchObject({
      status: "present",
      inspection: { createdAt: 100, initialHead: created.head },
    });
    await expect(lstat(join(root, binding.sessionId, pendingMetadataName)))
      .rejects.toMatchObject({ code: "ENOENT" });

    await chmod(databasePath, 0o666);
    expect((await lstat(databasePath)).mode & 0o077).not.toBe(0);
    await expect(broker.inspect(binding)).resolves.toMatchObject({ status: "present" });
    expect((await lstat(databasePath)).mode & 0o077).toBe(0);

    now = 200;
    expect(await broker.create({ binding, operationKey: `create:${binding.sessionId}` })).toEqual(created);
    const authority = openOhAuthority(binding, join(root, binding.sessionId));
    const record = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "assertion:session-fact",
      kind: "assertion",
      v: 1,
      value: { predicate: "session.remembers", subject: "agent" },
    });
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await authority.store.head(),
      operationId: "host.test.remember",
    });
    await authority.store.close();

    const inspected = await broker.inspect(binding);
    expect(inspected).toMatchObject({
      status: "present",
      inspection: {
        createdAt: 100,
        initialHead: { sequence: 0 },
        head: { sequence: 1 },
      },
    });
    await expect(broker.inspect(createFactsMemoryBinding({
      ownerId: otherOwnerId,
      sessionId: binding.sessionId,
    }))).rejects.toThrow();

    await broker.purge({
      binding,
      expectedHandleHash: created.handleHash,
      operationKey: `cleanup:${binding.sessionId}:archive`,
    });
    await expect(lstat(join(root, binding.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("repairs a crash-partial pending sidecar without accepting a path alias", async () => {
    const { broker, engine, root } = await fixture();
    const binding = createFactsMemoryBinding({
      ownerId,
      sessionId: `sess_${"3".repeat(32)}`,
    });
    const directory = join(root, binding.sessionId);
    await ensurePrivateDirectory(directory);
    await writeFile(join(directory, pendingMetadataName), "{", { encoding: "utf8", mode: 0o600 });
    await expect(broker.create({
      binding,
      operationKey: `create:${binding.sessionId}`,
    })).resolves.toMatchObject({ bindingDigest: binding.bindingDigest, head: { sequence: 0 } });
    expect((await lstat(join(directory, metadataName))).mode & 0o077).toBe(0);
    await expect(lstat(join(directory, pendingMetadataName)))
      .rejects.toMatchObject({ code: "ENOENT" });

    await expect(engine.inspect({
      binding,
      directory: `${directory}/../${binding.sessionId}`,
    })).rejects.toThrow("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");
  });

  test("forks one exact parent snapshot without copying working operation authority", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    const source = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:source",
      kind: "entity",
      v: 1,
      value: { name: "Source" },
    });
    const dependent = createKnowledgeGraphRecordV1({
      dependencies: [source.key],
      key: "assertion:dependent",
      kind: "assertion",
      v: 1,
      value: { claim: "bounded" },
    });
    const parentOperation = await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [
        { kind: "put", record: dependent, v: 1 },
        { kind: "put", record: source, v: 1 },
      ],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.parent",
    });
    await parentAuthority.store.close();
    const parentHead = await inspectionHead(broker, parent);
    const checkpoint: FactsMemoryCheckpoint = { ...parent, head: parentHead };

    const forked = await broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: checkpoint,
    });
    expect(forked.head.sequence).toBe(1);
    const childAuthority = openOhAuthority(child, join(root, child.sessionId));
    const childSnapshot = await childAuthority.store.snapshot({ maximumRecords: 8_192 });
    const childChanges = await childAuthority.store.changesSince({
      operationSha256: null,
      sequence: 0,
    });
    expect(childSnapshot.records.map((record) => [record.key, record.recordSha256])).toEqual([
      [dependent.key, dependent.recordSha256],
      [source.key, source.recordSha256],
    ]);
    expect(childChanges.operations).toHaveLength(1);
    expect(childChanges.operations[0]).toMatchObject({
      actorId: "hra.memory.host",
      parentOperationSha256: null,
      sequence: 1,
    });
    expect(childChanges.operations[0]?.operationId).toMatch(/^hra\.fork\./u);
    expect(childChanges.operations[0]?.operationId).not.toBe(parentOperation.operationId);
    expect(childChanges.operations[0]?.operationSha256).not.toBe(parentOperation.operationSha256);
    expect((await childAuthority.store.verify()).operations).toBe(1);
    expect(childAuthority.store.binding.profile).toEqual(OH_WORKING_STORE_PROFILE_V1);
    await childAuthority.store.close();

    const advancedParent = openOhAuthority(parent, join(root, parent.sessionId));
    await advancedParent.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:later",
        kind: "entity",
        v: 1,
        value: { name: "Later" },
      }), v: 1 }],
      expectedHead: await advancedParent.store.head(),
      operationId: "host.test.later",
    });
    await advancedParent.store.close();
    await expect(engine.fork({
      binding: child,
      directory: join(root, child.sessionId),
      operationKey: `fork:${child.sessionId}`,
      parent: checkpoint,
      parentDirectory: join(root, parent.sessionId),
    })).resolves.toEqual(forked);
  });

  test("reconciles a fork commit that completed before adapter metadata publication", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const record = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:reconcile",
      kind: "entity",
      v: 1,
      value: { name: "Reconcile" },
    });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.reconcile.parent",
    });
    await parentAuthority.store.close();
    const checkpoint: FactsMemoryCheckpoint = {
      ...parent,
      head: await inspectionHead(broker, parent),
    };
    const childDirectory = join(root, child.sessionId);
    await ensurePrivateDirectory(childDirectory);
    const operationKey = `fork:${child.sessionId}`;
    const childAuthority = openOhAuthority(child, childDirectory);
    await childAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await childAuthority.store.head(),
      operationId: `hra.fork.${digestParts("hra-oh-fork-operation-v1", [operationKey])}`,
    });
    await childAuthority.store.close();
    await expect(engine.inspect({ binding: child, directory: childDirectory }))
      .resolves.toEqual({ status: "missing" });

    const receipt = await engine.fork({
      binding: child,
      directory: childDirectory,
      operationKey,
      parent: checkpoint,
      parentDirectory: join(root, parent.sessionId),
    });
    expect(receipt.head.sequence).toBe(1);
    const reopened = openOhAuthority(child, childDirectory);
    expect((await reopened.store.verify()).operations).toBe(1);
    await reopened.store.close();
  });

  test("rejects metadata tampering, path aliases, and an inexact parent checkpoint", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const parentHead = await inspectionHead(broker, parent);
    await expect(broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: { ...parentHead, digest: "f".repeat(64) } },
    })).rejects.toThrow("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");

    const outside = await realpath(await mkdtemp(join(tmpdir(), "hra-oh-engine-outside-")));
    roots.push(outside);
    await symlink(join(root, parent.sessionId), join(outside, "aliased"));
    await expect(engine.inspect({
      binding: parent,
      directory: join(outside, "aliased"),
    })).rejects.toThrow("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");

    const path = join(root, parent.sessionId, metadataName);
    const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    metadata.receiptDigest = "e".repeat(64);
    await writeFile(path, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
    await expect(broker.inspect(parent)).rejects.toThrow("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
  });

  test("fails closed above the released memory lane bound and has no Suss runtime", async () => {
    const { broker, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const authority = openOhAuthority(parent, join(root, parent.sessionId));
    const records = Array.from({ length: 8_193 }, (_, index) => createKnowledgeGraphRecordV1({
      dependencies: [],
      key: `entity:bounded-${String(index).padStart(4, "0")}`,
      kind: "entity",
      v: 1,
      value: { index },
    }));
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: records.slice(0, 8_192).map((record) => ({ kind: "put" as const, record, v: 1 as const })),
      expectedHead: await authority.store.head(),
      operationId: "host.test.bound.one",
    });
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: records[8_192]!, v: 1 }],
      expectedHead: await authority.store.head(),
      operationId: "host.test.bound.two",
    });
    await authority.store.close();
    await expect(broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: await inspectionHead(broker, parent) },
    })).rejects.toThrow();
    await expect(broker.inspect(child)).resolves.toEqual({ status: "missing" });

    const source = await readFile(join(import.meta.dir, "oh-facts-memory-engine.ts"), "utf8");
    expect(source).not.toMatch(/projection-suss|@suss\/datalog/u);
  }, 30_000);
});
