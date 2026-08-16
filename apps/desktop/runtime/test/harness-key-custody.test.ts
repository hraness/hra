import { describe, expect, test } from "bun:test";

import {
  HarnessInstallKeyCustody,
  HarnessKeyCustodyError,
  HRA_HARNESS_KEYCHAIN_NAME,
  HRA_HARNESS_KEYCHAIN_SERVICE,
  deriveHarnessContextDigestKey,
  deriveHarnessContextScopeKey,
  deriveHarnessContextValueKey,
  deriveHarnessRootKey,
  harnessInstallKeyDescriptor,
  type HarnessSecretDescriptor,
  type HarnessSecretStore,
} from "../src/harness/key-custody";

function descriptorKey(value: HarnessSecretDescriptor): string {
  return `${value.service}\u0000${value.name}`;
}

class MemorySecrets implements HarnessSecretStore {
  readonly values = new Map<string, string>();
  getCount = 0;
  setCount = 0;
  deleteCount = 0;

  get(input: HarnessSecretDescriptor): Promise<string | null> {
    this.getCount += 1;
    return Promise.resolve(this.values.get(descriptorKey(input)) ?? null);
  }

  set(input: HarnessSecretDescriptor & { readonly value: string }): Promise<void> {
    this.setCount += 1;
    this.values.set(descriptorKey(input), input.value);
    return Promise.resolve();
  }

  delete(input: HarnessSecretDescriptor): Promise<boolean> {
    this.deleteCount += 1;
    return Promise.resolve(this.values.delete(descriptorKey(input)));
  }
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let settle: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred was resolved before initialization");
  };
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle(value) };
}

class GatedSetSecrets extends MemorySecrets {
  readonly setStarted = deferred<void>();
  readonly releaseSet = deferred<void>();

  override async set(
    input: HarnessSecretDescriptor & { readonly value: string },
  ): Promise<void> {
    this.setCount += 1;
    this.setStarted.resolve(undefined);
    await this.releaseSet.promise;
    this.values.set(descriptorKey(input), input.value);
  }
}

function deterministicMaster(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index + 1);
}

function scope(marker = "primary", sourceTurnId: string | null = null) {
  return {
    epochId: `hepoch_${marker}000000001`,
    ownerActorId: `hactor_${marker}000000001`,
    sourceTurnId,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the operation to reject");
}

describe("Context Heap Keychain custody", () => {
  test("keeps legacy root-thread keys deterministic and isolated from v2 context keys", () => {
    const master = deterministicMaster();
    const primary = deriveHarnessRootKey(master, "thread_rootkey0001");
    const replay = deriveHarnessRootKey(master, "thread_rootkey0001");
    const sibling = deriveHarnessRootKey(master, "thread_rootkey0002");
    const context = deriveHarnessContextScopeKey(master, scope("rootkey"));
    expect(primary).toEqual(replay);
    expect(primary).not.toEqual(sibling);
    expect(primary).not.toEqual(context);
    primary.fill(0);
    replay.fill(0);
    sibling.fill(0);
    context.fill(0);
  });

  test("derives keys from the complete durable actor context", () => {
    const master = deterministicMaster();
    const primary = deriveHarnessContextScopeKey(master, scope());
    const replay = deriveHarnessContextScopeKey(master, scope());
    const siblingActor = deriveHarnessContextScopeKey(master, {
      ...scope(),
      ownerActorId: "hactor_sibling000000001",
    });
    const siblingTurn = deriveHarnessContextScopeKey(master, {
      ...scope(),
      sourceTurnId: "hturn_primary000000001",
    });
    expect(primary).toEqual(replay);
    expect(primary).not.toEqual(siblingActor);
    expect(primary).not.toEqual(siblingTurn);
    primary.fill(0);
    replay.fill(0);
    siblingActor.fill(0);
    siblingTurn.fill(0);
  });

  test("derives a deterministic isolated key from the complete context-value identity", () => {
    const root = new Uint8Array(32).fill(0x31);
    const identity = {
      version: 2 as const,
      operationId: "contextop_keyderive01",
      ...scope("keyderive"),
      valueId: "ctxval_keyderive001",
      kind: "text" as const,
      purpose: "heap" as const,
      schemaVersion: 1 as const,
      nameDigest: null,
      utf8Bytes: 19,
      contentDigest: "a".repeat(64),
    };
    const first = deriveHarnessContextValueKey(root, identity);
    const replay = deriveHarnessContextValueKey(root, identity);
    expect(first).toEqual(replay);
    expect(first).toHaveLength(32);
    expect(root).toEqual(new Uint8Array(32).fill(0x31));
    for (const changed of [
      { ...identity, operationId: "contextop_keyderive02" },
      { ...identity, epochId: "hepoch_keyderive000000002" },
      { ...identity, ownerActorId: "hactor_keyderive000000002" },
      { ...identity, sourceTurnId: "hturn_keyderive000000001" },
      { ...identity, valueId: "ctxval_keyderive002" },
      { ...identity, kind: "selection" as const },
      { ...identity, purpose: "proposal" as const },
      { ...identity, nameDigest: "c".repeat(64) },
      { ...identity, utf8Bytes: 20 },
      { ...identity, contentDigest: "b".repeat(64) },
    ]) {
      const sibling = deriveHarnessContextValueKey(root, changed);
      expect(sibling).not.toEqual(first);
      sibling.fill(0);
    }
    first.fill(0);
    replay.fill(0);
    expect(() => deriveHarnessContextValueKey(root, {
      ...identity,
      unknownField: true,
    })).toThrow(expect.objectContaining({ code: "invalid_install_key" }));
    const completedPrefix = deriveHarnessContextValueKey(root, {
      ...identity,
      kind: "selection",
      purpose: "completedPrefix",
      utf8Bytes: 18 * 1024 * 1024,
    });
    expect(completedPrefix).toHaveLength(32);
    completedPrefix.fill(0);
    expect(() => deriveHarnessContextValueKey(root, {
      ...identity,
      utf8Bytes: 1024 * 1024 + 1,
    })).toThrow(expect.objectContaining({ code: "invalid_install_key" }));

    const digestKey = deriveHarnessContextDigestKey(root);
    const digestReplay = deriveHarnessContextDigestKey(root);
    expect(digestKey).toEqual(digestReplay);
    expect(digestKey).not.toEqual(first);
    digestKey.fill(0);
    digestReplay.fill(0);
  });

  test("creates one Keychain-only master and derives isolated stable context keys", async () => {
    const secrets = new MemorySecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    const captured: { value?: Uint8Array } = {};
    const first = await custody.withContextKey(scope("first"), (key) => {
      captured.value = key;
      return Buffer.from(key).toString("hex");
    });
    const replay = await custody.withContextKey(
      scope("first"),
      (key) => Buffer.from(key).toString("hex"),
    );
    const sibling = await custody.withContextKey(
      scope("second"),
      (key) => Buffer.from(key).toString("hex"),
    );

    expect(first).toBe(replay);
    expect(sibling).not.toBe(first);
    expect(captured.value).toBeDefined();
    expect(Array.from(captured.value ?? new Uint8Array())).toEqual(
      new Array<number>(32).fill(0),
    );
    expect(secrets.setCount).toBe(1);
    expect(secrets.values.size).toBe(1);
    expect([...secrets.values.keys()]).toEqual([
      `${HRA_HARNESS_KEYCHAIN_SERVICE}\u0000${HRA_HARNESS_KEYCHAIN_NAME}`,
    ]);
    expect(await custody.exists()).toBeTrue();
  });

  test("serializes concurrent first use and reads back Keychain authority", async () => {
    const secrets = new MemorySecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    const values = await Promise.all(Array.from({ length: 12 }, async () =>
      await custody.withContextKey(
        scope("concurrent"),
        (key) => Buffer.from(key).toString("hex"),
      )
    ));
    expect(new Set(values).size).toBe(1);
    expect(secrets.setCount).toBe(1);
  });

  test("fails closed for malformed custody instead of overwriting it", async () => {
    const secrets = new MemorySecrets();
    secrets.values.set(
      descriptorKey(harnessInstallKeyDescriptor),
      JSON.stringify({ version: 1, algorithm: "hkdf-sha256", key: "short" }),
    );
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    expect(await rejection(
      custody.withContextKey(scope("invalid"), () => undefined),
    )).toBeInstanceOf(HarnessKeyCustodyError);
    expect(secrets.setCount).toBe(0);
    expect(secrets.values.get(descriptorKey(harnessInstallKeyDescriptor)))
      .toContain("short");
  });

  test("deletes only the exact harness descriptor", async () => {
    const secrets = new MemorySecrets();
    secrets.values.set("unrelated\u0000secret", "preserve me");
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    await custody.withContextKey(scope("delete"), () => undefined);
    expect(await custody.delete()).toBeTrue();
    expect(await custody.delete()).toBeFalse();
    expect(secrets.deleteCount).toBe(1);
    expect(secrets.values).toEqual(new Map([["unrelated\u0000secret", "preserve me"]]));
  });

  test("fences an in-flight creator before deleting its late Keychain write", async () => {
    const secrets = new GatedSetSecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    let callbackCount = 0;
    const creating = custody.withContextKey(scope("deleteRace1"), () => {
      callbackCount += 1;
    });
    await secrets.setStarted.promise;

    const deleting = custody.delete();
    expect(await rejection(
      custody.withContextKey(scope("deleteRace2"), () => undefined),
    )).toMatchObject({ code: "custody_deleted" });
    secrets.releaseSet.resolve(undefined);

    expect(await rejection(creating)).toMatchObject({ code: "custody_deleted" });
    expect(await deleting).toBeTrue();
    expect(callbackCount).toBe(0);
    expect(secrets.setCount).toBe(1);
    expect(secrets.deleteCount).toBe(1);
    expect(secrets.values.has(descriptorKey(harnessInstallKeyDescriptor))).toBeFalse();
    expect(await rejection(
      custody.withContextKey(scope("deleteRace3"), () => undefined),
    )).toMatchObject({ code: "custody_deleted" });
    expect(secrets.setCount).toBe(1);
  });

  test("zeroes active borrowed keys and waits for borrowers before deletion returns", async () => {
    const secrets = new MemorySecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    let borrowed: Uint8Array | undefined;
    const borrower = custody.withContextKey(scope("deleteUse1"), async (key) => {
      borrowed = key;
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    expect(borrowed).toBeDefined();
    expect(new Set(borrowed).size).toBeGreaterThan(1);

    let deleteSettled = false;
    const deleting = custody.delete().then((value) => {
      deleteSettled = true;
      return value;
    });
    const concurrentDelete = custody.delete();
    expect(Array.from(borrowed ?? new Uint8Array())).toEqual(
      new Array<number>(32).fill(0),
    );
    await Promise.resolve();
    expect(deleteSettled).toBeFalse();
    expect(await rejection(
      custody.withContextKey(scope("deleteUse2"), () => undefined),
    )).toMatchObject({ code: "custody_deleted" });

    release.resolve(undefined);
    await borrower;
    expect(await deleting).toBeTrue();
    expect(await concurrentDelete).toBeTrue();
    expect(deleteSettled).toBeTrue();
    expect(await custody.exists()).toBeFalse();
    expect(secrets.deleteCount).toBe(1);
  });

  test("quiesces borrowers before an external authenticated deletion", async () => {
    const secrets = new MemorySecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    let borrowed: Uint8Array | undefined;
    const borrower = custody.withContextKey(scope("externalDel1"), async (key) => {
      borrowed = key;
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;

    let quiesced = false;
    const quiescing = custody.quiesceForExternalDeletion().then(() => {
      quiesced = true;
    });
    expect(Array.from(borrowed ?? new Uint8Array())).toEqual(
      new Array<number>(32).fill(0),
    );
    await Promise.resolve();
    expect(quiesced).toBeFalse();
    expect(secrets.deleteCount).toBe(0);
    expect(await rejection(
      custody.withContextKey(scope("externalDel2"), () => undefined),
    )).toMatchObject({ code: "custody_deleted" });

    release.resolve(undefined);
    await borrower;
    await quiescing;
    expect(quiesced).toBeTrue();
    expect(secrets.deleteCount).toBe(0);
    expect(await secrets.delete(harnessInstallKeyDescriptor)).toBeTrue();
    expect(await custody.exists()).toBeFalse();
  });

  test("rejects reentrant deletion instead of deadlocking its own borrower", async () => {
    const secrets = new MemorySecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets,
      randomMaster: deterministicMaster,
    });
    await custody.withContextKey(scope("deleteSelf"), async () => {
      expect(await rejection(custody.delete())).toMatchObject({
        code: "custody_delete_reentrant",
      });
    });
    expect(await custody.delete()).toBeTrue();
    expect(secrets.deleteCount).toBe(1);
  });

  test("rejects invalid context identities and invalid key generators", async () => {
    const custody = new HarnessInstallKeyCustody({
      secrets: new MemorySecrets(),
      randomMaster: () => new Uint8Array(31),
    });
    expect(await rejection(
      custody.withContextKey(scope("valid"), () => undefined),
    )).toMatchObject({ code: "key_generation_failed" });
    expect(await rejection(
      custody.withContextKey({ ...scope("bad"), epochId: "../root" }, () => undefined),
    )).toBeInstanceOf(Error);
  });
});
