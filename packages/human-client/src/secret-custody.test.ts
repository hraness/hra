import { describe, expect, test } from "bun:test";

import {
  GenerationalSecretCustody,
  SecretCustodyError,
  SecretStoreAccessDeniedError,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyMetadataStore,
  type SecretCustodyQuarantinePointer,
  type SecretStore,
} from "./secret-custody";

const descriptor: SecretCustodyDescriptor = {
  service: "com.example.hra.cloud-human.v1",
  name: "account:primary",
};

function secretKey(input: {
  readonly service: string;
  readonly name: string;
}): string {
  return `${input.service}:${input.name}`;
}

function memorySecrets(): SecretStore & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: (input) => Promise.resolve(values.get(secretKey(input)) ?? null),
    set: (input) => {
      values.set(secretKey(input), input.value);
      return Promise.resolve();
    },
    delete: (input) => Promise.resolve(values.delete(secretKey(input))),
  };
}

function memoryMetadata(initial: SecretCustodyJournal | null = null):
  SecretCustodyMetadataStore & {
    current: SecretCustodyJournal | null;
    readonly quarantined: SecretCustodyQuarantinePointer[];
  } {
  return {
    current: initial,
    quarantined: [],
    read() {
      return Promise.resolve(this.current);
    },
    compareAndSwap(input) {
      const currentRevision = this.current?.revision ?? null;
      if (currentRevision !== input.expectedRevision) {
        return Promise.resolve(false);
      }
      this.current = input.next;
      return Promise.resolve(true);
    },
    compareAndSwapWithQuarantine(input) {
      if (this.current?.revision !== input.expectedRevision) {
        return Promise.resolve(false);
      }
      this.current = input.next;
      this.quarantined.push(...input.quarantined);
      return Promise.resolve(true);
    },
    isQuarantinedSlot(input) {
      return Promise.resolve(
        this.quarantined.some(({ pointer }) => pointer.slot === input.slot),
      );
    },
  };
}

function slots(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("slot fixture exhausted");
    return value;
  };
}

type CrashPhase = "before" | "after";

interface CustodyCrashCase {
  readonly name: string;
  readonly metadataCall?: number;
  readonly secretOperation?: "set" | "delete";
  readonly secretCall?: number;
  readonly phase: CrashPhase;
}

function crashingMetadata(
  metadata: ReturnType<typeof memoryMetadata>,
  call: number,
  phase: CrashPhase,
): SecretCustodyMetadataStore {
  let calls = 0;
  return {
    read: async (input) => await metadata.read(input),
    compareAndSwapWithQuarantine: async (input) =>
      await metadata.compareAndSwapWithQuarantine(input),
    isQuarantinedSlot: async (input) =>
      await metadata.isQuarantinedSlot(input),
    compareAndSwap: async (input) => {
      calls += 1;
      if (calls === call && phase === "before") {
        throw new Error("injected crash before metadata CAS");
      }
      const swapped = await metadata.compareAndSwap(input);
      if (calls === call && phase === "after") {
        throw new Error("injected crash after metadata CAS");
      }
      return swapped;
    },
  };
}

function crashingSecrets(
  secrets: ReturnType<typeof memorySecrets>,
  operation: "set" | "delete",
  call: number,
  phase: CrashPhase,
): SecretStore {
  let calls = 0;
  const crash = async <Value>(
    selected: boolean,
    perform: () => Promise<Value>,
  ): Promise<Value> => {
    if (!selected) return await perform();
    calls += 1;
    if (calls === call && phase === "before") {
      throw new Error(`injected crash before Keychain ${operation}`);
    }
    const result = await perform();
    if (calls === call && phase === "after") {
      throw new Error(`injected crash after Keychain ${operation}`);
    }
    return result;
  };
  return {
    get: async (input) => await secrets.get(input),
    set: async (input) =>
      await crash(operation === "set", async () => {
        await secrets.set(input);
      }),
    delete: async (input) =>
      await crash(
        operation === "delete",
        async () => await secrets.delete(input),
      ),
  };
}

function expectOnlyCommittedSlot(
  metadata: ReturnType<typeof memoryMetadata>,
  secrets: ReturnType<typeof memorySecrets>,
  generation: number,
): void {
  expect(metadata.current?.pending).toBeUndefined();
  expect(metadata.current?.deleting).toBeUndefined();
  expect(metadata.current?.committed?.generation).toBe(generation);
  const slot = metadata.current?.committed?.slot;
  if (slot === undefined) throw new Error("committed slot was missing");
  expect([...secrets.values.keys()]).toEqual([
    `${descriptor.service}:${descriptor.name}:slot:${slot}`,
  ]);
}

describe("generational secret custody", () => {
  test("unknown Keychain failures never authorize legacy quarantine", () => {
    const slot = "legacycommitted01";
    const initial: SecretCustodyJournal = {
      version: 1,
      revision: 4,
      latestGeneration: 1,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 1, slot },
    };
    const metadata = memoryMetadata(initial);
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      nextSlot: slots("unusedslot000000"),
      secrets: {
        get: () => Promise.reject(new Error("temporarily locked")),
        set: () => Promise.reject(new Error("must not write")),
        delete: () => Promise.reject(new Error("must not delete")),
      },
    });

    for (const operation of [
      () => custody.inspectLegacyIdentityReconnect(),
      () => custody.inspectPointerAnomalies(),
      () => custody.quarantineLegacyIdentityPointers(),
    ]) {
      expect(operation()).rejects.toMatchObject({
        reason: "custody_unavailable",
      });
    }
    expect(metadata.current).toEqual(initial);
    expect(metadata.quarantined).toEqual([]);
  });

  test("classifies missing and invalid pending or deleting roles without mutation", async () => {
    for (const role of ["pending", "deleting"] as const) {
      for (const access of ["missing", "invalid"] as const) {
        const committed = { generation: 2, slot: "valid_committed_02" };
        const anomalous = {
          generation: role === "pending" ? 3 : 1,
          slot: `${role}_${access}_pointer01`,
        };
        const metadata = memoryMetadata({
          version: 1,
          revision: 6,
          latestGeneration: role === "pending" ? 3 : 2,
          service: descriptor.service,
          name: descriptor.name,
          committed,
          ...(role === "pending"
            ? {
                pending: {
                  pointer: anomalous,
                  replacesGeneration: committed.generation,
                },
              }
            : { deleting: [anomalous] }),
        });
        const values = new Map<string, string>([[
          `${descriptor.service}:${descriptor.name}:slot:${committed.slot}`,
          JSON.stringify({
            version: 1,
            generation: committed.generation,
            value: "valid committed value",
          }),
        ]]);
        if (access === "invalid") {
          values.set(
            `${descriptor.service}:${descriptor.name}:slot:${anomalous.slot}`,
            "{invalid-envelope",
          );
        }
        let deleteAttempts = 0;
        const custody = new GenerationalSecretCustody({
          descriptor,
          metadata,
          nextSlot: slots("unused_anomaly_001"),
          secrets: {
            get: (input) =>
              Promise.resolve(values.get(secretKey(input)) ?? null),
            set: () => Promise.reject(new Error("must not write")),
            delete: () => {
              deleteAttempts += 1;
              return Promise.reject(new Error("must not delete"));
            },
          },
        });

        expect(await custody.inspectLegacyIdentityReconnect()).toEqual({
          state: "not_required",
        });
        expect(await custody.inspectPointerAnomalies()).toEqual({
          state: "required",
          anomalousPointerCount: 1,
        });
        expect(metadata.quarantined).toHaveLength(0);
        expect(await custody.preservePointerAnomalies()).toEqual({
          state: "quarantined",
          quarantinedPointerCount: 1,
        });
        expect(metadata.current?.committed).toEqual(committed);
        expect(metadata.current?.pending).toBeUndefined();
        expect(metadata.current?.deleting).toBeUndefined();
        expect(metadata.quarantined.map(({ reason }) => reason)).toEqual([
          access === "missing"
            ? "missing_pointer_abandoned"
            : "invalid_pointer_preserved",
        ]);
        expect(deleteAttempts).toBe(0);
      }
    }
  });

  test("refuses to quarantine a committed slot that changed after inspection", async () => {
    const slot = "observedinvalid01";
    const metadata = memoryMetadata({
      version: 1,
      revision: 3,
      latestGeneration: 1,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 1, slot },
    });
    const secrets = memorySecrets();
    const key = `${descriptor.service}:${descriptor.name}:slot:${slot}`;
    secrets.values.set(key, "malformed envelope");
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      secrets,
      nextSlot: slots("unusedslot000000"),
    });
    const inspected = await custody.inspectCommittedForRecovery();
    if (inspected.state !== "invalid") {
      throw new Error("invalid committed fixture was not classified");
    }
    secrets.values.set(key, JSON.stringify({
      version: 1,
      generation: 1,
      value: "replacement-valid-value",
    }));

    expect(custody.preserveCommittedForRecovery(
      inspected,
      "invalid_pointer_preserved",
    )).rejects.toMatchObject({ reason: "concurrent_update" });
    expect(metadata.current?.committed).toEqual({ generation: 1, slot });
    expect(metadata.quarantined).toEqual([]);
  });

  test("atomically preserves the exact live scope-selection inventory without deleting Keychain bytes", async () => {
    const committed = { generation: 1, slot: "scopecommitted01" };
    const pending = { generation: 2, slot: "scopepending00001" };
    const metadata = memoryMetadata({
      version: 1,
      revision: 5,
      latestGeneration: 2,
      service: descriptor.service,
      name: descriptor.name,
      committed,
      pending: { pointer: pending, replacesGeneration: committed.generation },
    });
    const secrets = memorySecrets();
    for (const [pointer, value] of [
      [committed, "committed credential"],
      [pending, "pending credential"],
    ] as const) {
      secrets.values.set(
        `${descriptor.service}:${descriptor.name}:slot:${pointer.slot}`,
        JSON.stringify({ version: 1, generation: pointer.generation, value }),
      );
    }
    const originalKeychain = new Map(secrets.values);
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      secrets,
      nextSlot: slots("unusedscopevalue1"),
    });

    const inspected = await custody.inspectLiveValues();
    expect(await custody.preserveLiveValuesForRecovery(inspected)).toEqual({
      state: "quarantined",
      quarantinedPointerCount: 2,
    });
    expect(metadata.current).toEqual({
      version: 1,
      revision: 6,
      latestGeneration: 2,
      service: descriptor.service,
      name: descriptor.name,
    });
    expect(metadata.quarantined).toEqual([
      {
        kind: "committed",
        pointer: committed,
        sourceRevision: 5,
        reason: "invalid_pointer_preserved",
      },
      {
        kind: "pending",
        pointer: pending,
        sourceRevision: 5,
        reason: "invalid_pointer_preserved",
      },
    ]);
    expect(secrets.values).toEqual(originalKeychain);
    expect(await custody.read()).toBeNull();
  });

  test("refuses to preserve a live inventory whose journal or Keychain value changed", async () => {
    for (const changed of ["journal", "keychain"] as const) {
      const pointer = { generation: 3, slot: `stalelive${changed.padEnd(8, "0")}` };
      const metadata = memoryMetadata({
        version: 1,
        revision: 7,
        latestGeneration: pointer.generation,
        service: descriptor.service,
        name: descriptor.name,
        committed: pointer,
      });
      const secrets = memorySecrets();
      const key = `${descriptor.service}:${descriptor.name}:slot:${pointer.slot}`;
      secrets.values.set(key, JSON.stringify({
        version: 1,
        generation: pointer.generation,
        value: "inspected credential",
      }));
      const custody = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("unusedstalevalue"),
      });
      const inspected = await custody.inspectLiveValues();
      if (changed === "journal" && metadata.current !== null) {
        metadata.current = { ...metadata.current, revision: 8 };
      } else {
        secrets.values.set(key, JSON.stringify({
          version: 1,
          generation: pointer.generation,
          value: "changed credential",
        }));
      }

      expect(custody.preserveLiveValuesForRecovery(inspected)).rejects.toMatchObject({
        reason: "concurrent_update",
      });
      expect(metadata.current?.committed).toEqual(pointer);
      expect(metadata.quarantined).toEqual([]);
    }
  });

  for (const pendingCase of ["missing", "invalid", "valid"] as const) {
    test(`repairs a denied predecessor with a ${pendingCase} dependent pending slot`, async () => {
      const committedSlot = "legacycommitted01";
      const pendingSlot = `pending${pendingCase.padEnd(10, "0")}`;
      const initial: SecretCustodyJournal = {
        version: 1,
        revision: 7,
        latestGeneration: 2,
        service: descriptor.service,
        name: descriptor.name,
        committed: { generation: 1, slot: committedSlot },
        pending: {
          pointer: { generation: 2, slot: pendingSlot },
          replacesGeneration: 1,
        },
      };
      const metadata = memoryMetadata(initial);
      const values = new Map<string, string>();
      if (pendingCase !== "missing") {
        values.set(
          `${descriptor.service}:${descriptor.name}:slot:${pendingSlot}`,
          pendingCase === "valid"
            ? JSON.stringify({
                version: 1,
                generation: 2,
                value: "fresh-valid-credential",
              })
            : "malformed pending envelope",
        );
      }
      let deletes = 0;
      const secrets: SecretStore = {
        get: (input) => {
          if (input.name.endsWith(committedSlot)) {
            return Promise.reject(new SecretStoreAccessDeniedError());
          }
          return Promise.resolve(values.get(secretKey(input)) ?? null);
        },
        set: () => Promise.reject(new Error("must not write")),
        delete: () => {
          deletes += 1;
          return Promise.reject(new Error("must not delete"));
        },
      };
      const custody = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("unusedslot000000"),
      });

      expect(await custody.inspectLegacyIdentityReconnect()).toEqual({
        state: "required",
        inaccessiblePointerCount: 1,
      });
      expect(await custody.quarantineLegacyIdentityPointers()).toEqual({
        state: "quarantined",
        quarantinedPointerCount: pendingCase === "valid" ? 1 : 2,
      });
      expect(metadata.current?.latestGeneration).toBe(2);
      expect(metadata.current?.pending).toBeUndefined();
      expect(metadata.current?.deleting).toBeUndefined();
      expect(metadata.current?.committed).toEqual(
        pendingCase === "valid"
          ? { generation: 2, slot: pendingSlot }
          : undefined,
      );
      expect(metadata.quarantined.map(({ reason }) => reason)).toEqual(
        pendingCase === "valid"
          ? ["legacy_identity_access_denied"]
          : [
              "legacy_identity_access_denied",
              pendingCase === "missing"
                ? "missing_pointer_abandoned"
                : "invalid_pointer_preserved",
            ],
      );
      expect(deletes).toBe(0);

      const restarted = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("freshaftermigrate"),
      });
      expect(await restarted.inspectLegacyIdentityReconnect()).toEqual({
        state: "not_required",
      });
      expect(await restarted.read()).toEqual(
        pendingCase === "valid"
          ? { generation: 2, value: "fresh-valid-credential" }
          : null,
      );
    });
  }

  test("rotates through opaque slots while metadata remains token-free", async () => {
    const secrets = memorySecrets();
    const metadata = memoryMetadata();
    const custody = new GenerationalSecretCustody({
      descriptor,
      secrets,
      metadata,
      nextSlot: slots(
        "aaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbb",
      ),
    });
    const first = "first-refresh-token-that-is-long-enough";
    const second = "second-refresh-token-that-is-long-enough";

    expect(await custody.write(first)).toEqual({
      generation: 0,
      slot: "aaaaaaaaaaaaaaaa",
    });
    expect(await custody.read()).toEqual({ generation: 0, value: first });
    expect(await custody.write(second)).toEqual({
      generation: 1,
      slot: "bbbbbbbbbbbbbbbb",
    });
    expect(await custody.read()).toEqual({ generation: 1, value: second });

    const metadataSource = JSON.stringify(metadata.current);
    expect(metadataSource).not.toContain(first);
    expect(metadataSource).not.toContain(second);
    expect(metadata.current).toMatchObject({
      service: descriptor.service,
      name: descriptor.name,
      latestGeneration: 1,
      committed: { generation: 1, slot: "bbbbbbbbbbbbbbbb" },
    });
    expect(secrets.values.size).toBe(1);
  });

  test("rejects a stale keychain generation without returning its value", async () => {
    const staleSecret = "stale-refresh-token-that-must-not-escape";
    const slot = "stalegeneration1";
    const metadata = memoryMetadata({
      version: 1,
      revision: 4,
      latestGeneration: 2,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 2, slot },
    });
    const secrets = memorySecrets();
    secrets.values.set(
      `${descriptor.service}:${descriptor.name}:slot:${slot}`,
      JSON.stringify({ version: 1, generation: 1, value: staleSecret }),
    );
    const custody = new GenerationalSecretCustody({
      descriptor,
      secrets,
      metadata,
      nextSlot: slots("unusedslot000000"),
    });

    let caught: unknown;
    try {
      await custody.read();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SecretCustodyError);
    expect(caught).toMatchObject({ reason: "stale_generation" });
    expect(JSON.stringify(caught)).not.toContain(staleSecret);
  });

  test("retains a crash journal and abandons only with exclusive recovery proof", async () => {
    const metadata = memoryMetadata();
    const unavailableSecrets: SecretStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error("injected keychain failure")),
      delete: () => Promise.resolve(false),
    };
    const crashed = new GenerationalSecretCustody({
      descriptor,
      secrets: unavailableSecrets,
      metadata,
      nextSlot: slots("crashedslot00000"),
    });

    expect(
      crashed.write("refresh-token-that-never-reached-keychain"),
    ).rejects.toMatchObject({ reason: "custody_unavailable" });
    expect(metadata.current?.pending).toMatchObject({
      pointer: { generation: 0, slot: "crashedslot00000" },
      replacesGeneration: null,
    });

    const recovered = new GenerationalSecretCustody({
      descriptor,
      secrets: memorySecrets(),
      metadata,
      nextSlot: slots("nextslot00000000"),
    });
    expect(recovered.read()).rejects.toMatchObject({
      reason: "pending_secret_missing",
    });
    expect(
      await recovered.recover({ abandonMissingPending: true }),
    ).toEqual({ state: "abandoned_missing_pending" });
    expect(await recovered.read()).toBeNull();
  });

  test("strict recovery requires and revalidates the exact inspected candidate", async () => {
    const committedSlot = "strictcommitted01";
    const pendingSlot = "strictpending0001";
    const metadata = memoryMetadata({
      version: 1,
      revision: 4,
      latestGeneration: 1,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 0, slot: committedSlot },
      pending: {
        pointer: { generation: 1, slot: pendingSlot },
        replacesGeneration: 0,
      },
    });
    const secrets = memorySecrets();
    for (const [slot, generation, value] of [
      [committedSlot, 0, "credential-a"],
      [pendingSlot, 1, "credential-b"],
    ] as const) {
      secrets.values.set(
        `${descriptor.service}:${descriptor.name}:slot:${slot}`,
        JSON.stringify({ version: 1, generation, value }),
      );
    }
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      secrets,
      nextSlot: slots("strictunusedslot"),
      requireExplicitPendingRecovery: true,
    });

    expect(custody.read()).rejects.toMatchObject({
      reason: "pending_secret_missing",
    });
    const candidate = await custody.inspectRecoveryCandidate();
    if (candidate.state !== "valid") {
      throw new Error("strict recovery candidate was not readable");
    }

    metadata.current = {
      version: 1,
      revision: 5,
      latestGeneration: 1,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 1, slot: pendingSlot },
      deleting: [{ generation: 0, slot: committedSlot }],
    };
    expect(custody.recover({
      abandonMissingPending: false,
      candidate: candidate.token,
    })).rejects.toMatchObject({ reason: "concurrent_update" });
    expect(metadata.current.committed).toEqual({
      generation: 1,
      slot: pendingSlot,
    });
  });

  test("advances past an abandoned generation while preserving the prior credential", async () => {
    const metadata = memoryMetadata();
    const secrets = memorySecrets();
    const custody = new GenerationalSecretCustody({
      descriptor,
      secrets,
      metadata,
      nextSlot: slots("gaporiginalslot1"),
    });
    await custody.write("original-token-before-generation-gap");
    const missingWriteSecrets: SecretStore = {
      get: async (input) => await secrets.get(input),
      set: () => Promise.reject(new Error("injected pre-Keychain crash")),
      delete: async (input) => await secrets.delete(input),
    };
    const crashed = new GenerationalSecretCustody({
      descriptor,
      secrets: missingWriteSecrets,
      metadata,
      nextSlot: slots("gapmissingslot01"),
    });
    expect(crashed.write("token-lost-before-keychain")).rejects.toMatchObject({
      reason: "custody_unavailable",
    });

    const recovered = new GenerationalSecretCustody({
      descriptor,
      secrets,
      metadata,
      nextSlot: slots("gaprecoveredslot"),
    });
    expect(
      await recovered.recover({ abandonMissingPending: true }),
    ).toEqual({
      state: "abandoned_missing_pending",
      generation: 0,
    });
    expect(await recovered.read()).toEqual({
      generation: 0,
      value: "original-token-before-generation-gap",
    });
    expect(await recovered.write("token-after-generation-gap")).toMatchObject({
      generation: 2,
      slot: "gaprecoveredslot",
    });
    expectOnlyCommittedSlot(metadata, secrets, 2);
  });

  test("explicit recovery journal-deletes an invalid pending envelope", async () => {
    const pendingSlot = "invalidpendingslot";
    const metadata = memoryMetadata({
      version: 1,
      revision: 0,
      latestGeneration: 0,
      service: descriptor.service,
      name: descriptor.name,
      pending: {
        pointer: { generation: 0, slot: pendingSlot },
        replacesGeneration: null,
      },
    });
    const secrets = memorySecrets();
    secrets.values.set(
      `${descriptor.service}:${descriptor.name}:slot:${pendingSlot}`,
      JSON.stringify({
        version: 1,
        generation: 99,
        value: "wrong-generation-pending-secret",
      }),
    );
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      secrets,
      nextSlot: slots("postinvalidslot1"),
    });

    expect(
      custody.recover({ abandonMissingPending: false }),
    ).rejects.toMatchObject({ reason: "stale_generation" });
    expect(
      await custody.recover({ abandonMissingPending: true }),
    ).toEqual({ state: "abandoned_invalid_pending" });
    expect(metadata.current?.pending).toBeUndefined();
    expect(metadata.current?.deleting).toBeUndefined();
    expect(secrets.values.size).toBe(0);
    expect(await custody.write("credential-after-invalid-recovery"))
      .toMatchObject({ generation: 1 });
  });

  test("never reuses a generation after clear and rejects a stale replacement", async () => {
    const secrets = memorySecrets();
    const metadata = memoryMetadata();
    const firstWriter = new GenerationalSecretCustody({
      descriptor,
      secrets,
      metadata,
      nextSlot: slots(
        "firstaccountslot",
        "secondaccountslot",
      ),
    });
    const first = await firstWriter.write("first-account-refresh-token");
    await firstWriter.clear();
    const second = await firstWriter.write("second-account-refresh-token");

    expect(first.generation).toBe(0);
    expect(second.generation).toBe(1);
    expect(
      await firstWriter.compareAndSwap(
        first.generation,
        "stale-first-account-refresh-token",
      ),
    ).toBeNull();
    expect(await firstWriter.read()).toEqual({
      generation: 1,
      value: "second-account-refresh-token",
    });
    expect(await firstWriter.clearIfGeneration(first.generation)).toBeFalse();
  });

  test("exact-generation clear leaves a committed value and pending successor byte-identical", async () => {
    const committed = { generation: 7, slot: "clear_committed_07" };
    const pending = { generation: 8, slot: "clear_pending_08__" };
    const initial: SecretCustodyJournal = {
      version: 1,
      revision: 19,
      latestGeneration: pending.generation,
      service: descriptor.service,
      name: descriptor.name,
      committed,
      pending: {
        pointer: pending,
        replacesGeneration: committed.generation,
      },
    };
    const committedEnvelope = JSON.stringify({
      version: 1,
      generation: committed.generation,
      value: "committed-authentication-byte-evidence",
    });
    const pendingEnvelope = JSON.stringify({
      version: 1,
      generation: pending.generation,
      value: "pending-authentication-byte-evidence",
    });
    const metadata = memoryMetadata(initial);
    const secrets = memorySecrets();
    secrets.values.set(
      `${descriptor.service}:${descriptor.name}:slot:${committed.slot}`,
      committedEnvelope,
    );
    secrets.values.set(
      `${descriptor.service}:${descriptor.name}:slot:${pending.slot}`,
      pendingEnvelope,
    );
    const journalBefore = JSON.stringify(metadata.current);
    const secretsBefore = [...secrets.values.entries()];
    let journaled = false;
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      secrets,
      nextSlot: slots("unused_clear_slot"),
      requireExplicitPendingRecovery: true,
    });

    expect(await custody.clearIfGeneration(committed.generation, {
      onJournaled: () => {
        journaled = true;
        return Promise.resolve();
      },
    })).toBeFalse();
    expect(journaled).toBeFalse();
    expect(JSON.stringify(metadata.current)).toBe(journalBefore);
    expect([...secrets.values.entries()]).toEqual(secretsBefore);
  });

  test("all-value source-revision clear still retires committed and pending values", async () => {
    const committed = { generation: 3, slot: "source_committed3" };
    const pending = { generation: 4, slot: "source_pending_04" };
    const metadata = memoryMetadata({
      version: 1,
      revision: 8,
      latestGeneration: pending.generation,
      service: descriptor.service,
      name: descriptor.name,
      committed,
      pending: {
        pointer: pending,
        replacesGeneration: committed.generation,
      },
    });
    const secrets = memorySecrets();
    for (const pointer of [committed, pending]) {
      secrets.values.set(
        `${descriptor.service}:${descriptor.name}:slot:${pointer.slot}`,
        JSON.stringify({
          version: 1,
          generation: pointer.generation,
          value: `source-clear-${pointer.generation}`,
        }),
      );
    }
    const custody = new GenerationalSecretCustody({
      descriptor,
      metadata,
      secrets,
      nextSlot: slots("unused_source_slot"),
      requireExplicitPendingRecovery: true,
    });

    expect(await custody.clearIfSourceRevision(8)).toBeTrue();
    expect(metadata.current?.committed).toBeUndefined();
    expect(metadata.current?.pending).toBeUndefined();
    expect(secrets.values.size).toBe(0);
  });

  const rotationCrashCases: readonly (
    CustodyCrashCase & {
      readonly outcome: "old" | "abandoned" | "new";
    }
  )[] = [
    {
      name: "before pending journal CAS",
      metadataCall: 1,
      phase: "before",
      outcome: "old",
    },
    {
      name: "after pending journal CAS",
      metadataCall: 1,
      phase: "after",
      outcome: "abandoned",
    },
    {
      name: "before Keychain write",
      secretOperation: "set",
      secretCall: 1,
      phase: "before",
      outcome: "abandoned",
    },
    {
      name: "after Keychain write",
      secretOperation: "set",
      secretCall: 1,
      phase: "after",
      outcome: "new",
    },
    {
      name: "before commit journal CAS",
      metadataCall: 2,
      phase: "before",
      outcome: "new",
    },
    {
      name: "after commit journal CAS",
      metadataCall: 2,
      phase: "after",
      outcome: "new",
    },
    {
      name: "before retired Keychain deletion",
      secretOperation: "delete",
      secretCall: 1,
      phase: "before",
      outcome: "new",
    },
    {
      name: "after retired Keychain deletion",
      secretOperation: "delete",
      secretCall: 1,
      phase: "after",
      outcome: "new",
    },
    {
      name: "before deletion-retirement CAS",
      metadataCall: 3,
      phase: "before",
      outcome: "new",
    },
    {
      name: "after deletion-retirement CAS",
      metadataCall: 3,
      phase: "after",
      outcome: "new",
    },
  ];

  for (const crashCase of rotationCrashCases) {
    test(`recovers rotation with no orphan ${crashCase.name}`, async () => {
      const metadata = memoryMetadata();
      const secrets = memorySecrets();
      const original = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("originalslot0001"),
      });
      await original.write("original-refresh-token");

      const faulted = new GenerationalSecretCustody({
        descriptor,
        metadata: crashCase.metadataCall === undefined
          ? metadata
          : crashingMetadata(
              metadata,
              crashCase.metadataCall,
              crashCase.phase,
            ),
        secrets: crashCase.secretOperation === undefined
          ? secrets
          : crashingSecrets(
              secrets,
              crashCase.secretOperation,
              crashCase.secretCall ?? 1,
              crashCase.phase,
            ),
        nextSlot: slots("rotatedslot00001"),
      });
      expect(faulted.write("rotated-refresh-token")).rejects.toMatchObject({
        reason: "custody_unavailable",
      });

      if (
        crashCase.name === "before retired Keychain deletion"
      ) {
        expect(metadata.current?.deleting).toEqual([
          { generation: 0, slot: "originalslot0001" },
        ]);
      }

      const recovered = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("unusedrecoveryslot"),
      });
      if (crashCase.outcome === "abandoned") {
        expect(recovered.recover({ abandonMissingPending: false }))
          .rejects.toMatchObject({ reason: "pending_secret_missing" });
        expect(
          await recovered.recover({ abandonMissingPending: true }),
        ).toEqual({
          state: "abandoned_missing_pending",
          generation: 0,
        });
        expect(await recovered.read()).toEqual({
          generation: 0,
          value: "original-refresh-token",
        });
        expectOnlyCommittedSlot(metadata, secrets, 0);
        expect(metadata.current?.latestGeneration).toBe(1);
      } else {
        expect(
          await recovered.recover({ abandonMissingPending: false }),
        ).toEqual({
          state: "committed",
          generation: crashCase.outcome === "new" ? 1 : 0,
        });
        expect(await recovered.read()).toEqual({
          generation: crashCase.outcome === "new" ? 1 : 0,
          value: crashCase.outcome === "new"
            ? "rotated-refresh-token"
            : "original-refresh-token",
        });
        expectOnlyCommittedSlot(
          metadata,
          secrets,
          crashCase.outcome === "new" ? 1 : 0,
        );
      }
    });
  }

  const clearCrashCases: readonly (
    CustodyCrashCase & {
      readonly remainsCommitted: boolean;
    }
  )[] = [
    {
      name: "before clear journal CAS",
      metadataCall: 1,
      phase: "before",
      remainsCommitted: true,
    },
    {
      name: "after clear journal CAS",
      metadataCall: 1,
      phase: "after",
      remainsCommitted: false,
    },
    {
      name: "before clear Keychain deletion",
      secretOperation: "delete",
      secretCall: 1,
      phase: "before",
      remainsCommitted: false,
    },
    {
      name: "after clear Keychain deletion",
      secretOperation: "delete",
      secretCall: 1,
      phase: "after",
      remainsCommitted: false,
    },
    {
      name: "before clear deletion-retirement CAS",
      metadataCall: 2,
      phase: "before",
      remainsCommitted: false,
    },
    {
      name: "after clear deletion-retirement CAS",
      metadataCall: 2,
      phase: "after",
      remainsCommitted: false,
    },
  ];

  for (const crashCase of clearCrashCases) {
    test(`recovers clear with no orphan ${crashCase.name}`, async () => {
      const metadata = memoryMetadata();
      const secrets = memorySecrets();
      const original = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("clearoriginalslot"),
      });
      await original.write("clear-original-refresh-token");

      const faulted = new GenerationalSecretCustody({
        descriptor,
        metadata: crashCase.metadataCall === undefined
          ? metadata
          : crashingMetadata(
              metadata,
              crashCase.metadataCall,
              crashCase.phase,
            ),
        secrets: crashCase.secretOperation === undefined
          ? secrets
          : crashingSecrets(
              secrets,
              crashCase.secretOperation,
              crashCase.secretCall ?? 1,
              crashCase.phase,
            ),
        nextSlot: slots("unusedclearslot01"),
      });
      expect(faulted.clear()).rejects.toMatchObject({
        reason: "custody_unavailable",
      });

      const recovered = new GenerationalSecretCustody({
        descriptor,
        metadata,
        secrets,
        nextSlot: slots("unusedclearslot02"),
      });
      expect(
        await recovered.recover({ abandonMissingPending: false }),
      ).toEqual(
        crashCase.remainsCommitted
          ? { state: "committed", generation: 0 }
          : { state: "empty" },
      );
      expect(metadata.current?.pending).toBeUndefined();
      expect(metadata.current?.deleting).toBeUndefined();
      if (crashCase.remainsCommitted) {
        expectOnlyCommittedSlot(metadata, secrets, 0);
      } else {
        expect(metadata.current?.committed).toBeUndefined();
        expect(secrets.values.size).toBe(0);
      }
    });
  }
});
