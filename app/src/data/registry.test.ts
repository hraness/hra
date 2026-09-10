import { describe, expect, test } from "bun:test";

import {
  encryptBytes,
  parseDeviceRegistryPayload,
  profileBindingRegistryDigest,
  randomKeyBytes,
  type DeviceRegistryPayload,
  type EncryptedEnvelope,
  type ProfileBindingPayload,
} from "../oompa/cloud";
import { createCancellation } from "../lib/cancellation";
import {
  decryptRegistryProjection,
  memorySummaryAad,
  notificationEmailAad,
  notificationHoursAad,
  parseRegistryRow,
  parseRegistryRows,
  profileBindingAad,
  registryAad,
  registryProjectionCacheKey,
  registryProjectionFromCache,
  type RegistryRow,
} from "./registry";

const devicePublicId = "device_registry_test";
const userPublicId = "user_registry_test";

function registryPayload(): DeviceRegistryPayload {
  const parsed = parseDeviceRegistryPayload({
    accounts: [],
    daemonVersion: "0.5.0",
    defaultApprovalMode: "manual",
    defaultPreset: "ultra",
    heartbeatAt: 1_760_000_000_000,
    machineLabel: "Studio",
    projects: [],
    proseAutorespondConfigured: false,
    scheduledTasks: [],
    showThinkingDefault: false,
    version: 1,
  });
  if (parsed === null) throw new Error("invalid registry fixture");
  return parsed;
}

async function encryptedJson(
  value: unknown,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<EncryptedEnvelope> {
  return await encryptBytes(
    new TextEncoder().encode(JSON.stringify(value)),
    key,
    1,
    aad,
  );
}

function parseRow(value: unknown): RegistryRow {
  const parsed = parseRegistryRow(value);
  if (parsed === null) throw new Error("invalid row fixture");
  return parsed;
}

describe("read-only exact default companion", () => {
  const authority = { devicePublicId, keyVersion: 1, userPublicId } as const;
  const wireRow = (row: RegistryRow) => ({
    devicePublicId: row.devicePublicId,
    envelope: row.envelope,
    keyVersion: row.keyVersion,
    profileBindingEnvelope: row.profileBindingEnvelope,
    revision: row.revision,
    updatedAt: row.updatedAt,
  });
  async function fixture(registry = registryPayload()) {
    const key = randomKeyBytes();
    const envelope = await encryptedJson(registry, key, registryAad(authority));
    const payload = {
      observedAt: registry.heartbeatAt,
      preset: "ultra",
      profileKey: "codex:gpt-5.6-sol:ultra",
      registryEnvelopeDigest: await profileBindingRegistryDigest(envelope),
      registryRevision: 1,
      version: 1,
    } satisfies ProfileBindingPayload;
    const profileBindingEnvelope = await encryptedJson(payload, key, profileBindingAad(authority));
    const row = parseRow({ devicePublicId, envelope, keyVersion: 1, profileBindingEnvelope, revision: 1, updatedAt: 1 });
    return { key, payload, registry, row };
  }

  test("distinguishes absent and malformed companions without dropping the registry", async () => {
    const { key, row } = await fixture();
    const legacy: Record<string, unknown> = wireRow(row);
    delete legacy.profileBindingEnvelope;
    const absent = parseRow(legacy);
    expect(absent.profileBindingEnvelopeStatus).toBe("absent");
    expect(await decryptRegistryProjection({ key, row: absent, userPublicId })).toMatchObject({
      profileBinding: null,
      profileBindingStatus: "unsupported",
      registry: registryPayload(),
    });
    for (const profileBindingEnvelope of [
      null,
      {},
      { ...row.profileBindingEnvelope, ciphertext: "not base64!" },
      { ...row.profileBindingEnvelope, ciphertext: "A".repeat(2_049) },
      { ...row.profileBindingEnvelope, keyVersion: 2 },
      { ...row.profileBindingEnvelope, extra: true },
    ]) {
      const invalid = parseRow({ ...wireRow(row), profileBindingEnvelope });
      expect(invalid.profileBindingEnvelopeStatus).toBe("invalid");
      expect(await decryptRegistryProjection({ key, row: invalid, userPublicId })).toMatchObject({
        profileBinding: null,
        profileBindingStatus: "unreadable",
        registry: registryPayload(),
      });
    }
    expect(parseRegistryRow({ ...wireRow(row), profileBindingEnvelope: undefined })).toBeNull();
  });

  for (const [preset, profileKey] of [
    ["low", "codex:gpt-5.6-luna:max"],
    ["high", "codex:gpt-5.6-sol:max"],
    ["ultra", "codex:gpt-5.6-sol:ultra"],
    ["high", "codex:gpt-6-astra:max"],
    ["ultra", "codex:gpt-6-astra:ultra"],
  ] as const) {
    test(`reads the publisher's ${profileKey} without rebinding ${preset}`, async () => {
      const { key, payload, registry, row } = await fixture({ ...registryPayload(), defaultPreset: preset });
      const observation = { ...payload, preset, profileKey };
      const profileBindingEnvelope = await encryptedJson(observation, key, profileBindingAad(authority));
      const projection = await decryptRegistryProjection({ key, row: parseRow({ ...wireRow(row), profileBindingEnvelope }), userPublicId });
      expect(projection.profileBinding).toEqual(observation);
      expect(projection.profileBindingStatus).toBe("available");
      expect(projection.registry).toEqual(registry);
      expect(projection.registry).not.toHaveProperty("profileKey");
    });
  }

  test("refuses incoherent payloads and every registry association mismatch", async () => {
    const { key, payload, row } = await fixture();
    for (const change of [
      { registryRevision: 2 },
      { observedAt: payload.observedAt + 1 },
      { registryEnvelopeDigest: "f".repeat(64) },
      { preset: "high", profileKey: "codex:gpt-5.6-sol:max" },
      { preset: "ultra", profileKey: "codex:gpt-6-astra:max" },
      { profileKey: "claude:claude-fable-5-1:max" },
      { profileKey: "codex:unknown:ultra" },
      { version: 2 },
      { observedAt: 0 },
      { selectable: true },
    ]) {
      const profileBindingEnvelope = await encryptedJson({ ...payload, ...change }, key, profileBindingAad(authority));
      const result = await decryptRegistryProjection({ key, row: parseRow({ ...wireRow(row), profileBindingEnvelope }), userPublicId });
      expect(result.profileBinding).toBeNull();
      expect(result.profileBindingStatus).toBe("unreadable");
      expect(result.registry).toEqual(registryPayload());
    }
  });

  test("refuses re-encrypted or replaced registry bytes even at the same revision", async () => {
    const { key, row } = await fixture();
    for (const registry of [
      registryPayload(),
      { ...registryPayload(), heartbeatAt: registryPayload().heartbeatAt + 1 },
      { ...registryPayload(), defaultPreset: "high" as const },
    ]) {
      const envelope = await encryptedJson(registry, key, registryAad(authority));
      const result = await decryptRegistryProjection({ key, row: parseRow({ ...wireRow(row), envelope }), userPublicId });
      expect(result).toMatchObject({ profileBinding: null, profileBindingStatus: "unreadable", registry });
    }
  });

  test("refuses tampering, wrong user, device, key, and AAD kind independently", async () => {
    const { key, payload, row } = await fixture();
    if (row.profileBindingEnvelope === null) throw new Error("missing companion fixture");
    const ciphertext = row.profileBindingEnvelope.ciphertext;
    const first = ciphertext[0] === "A" ? "B" : "A";
    const companions = [
      { ...row.profileBindingEnvelope, ciphertext: first + ciphertext.slice(1) },
      await encryptedJson(payload, key, profileBindingAad({ ...authority, userPublicId: "user_foreign" })),
      await encryptedJson(payload, key, profileBindingAad({ ...authority, devicePublicId: "device_foreign" })),
      await encryptedJson(payload, randomKeyBytes(), profileBindingAad(authority)),
      await encryptedJson(payload, key, registryAad(authority)),
      await encryptedJson(payload, key, notificationHoursAad(authority)),
    ];
    for (const profileBindingEnvelope of companions) {
      expect(await decryptRegistryProjection({ key, row: parseRow({ ...wireRow(row), profileBindingEnvelope }), userPublicId }))
        .toMatchObject({ profileBinding: null, profileBindingStatus: "unreadable", registry: registryPayload() });
    }
  });

  test("immediately invalidates cached display on exact row replacement or authority change", async () => {
    const { key, payload, row } = await fixture();
    const projection = await decryptRegistryProjection({ key, row, userPublicId });
    const cancellation = createCancellation();
    const cache = {
      key,
      keyBytes: new Uint8Array(key),
      live: cancellation.live,
      projections: new Map([[registryProjectionCacheKey(row), projection]]),
      userPublicId,
    };
    const read = (candidate: RegistryRow) => registryProjectionFromCache(cache, { key, row: candidate, userPublicId });
    expect(read(row)).toBe(projection);
    const replacement = await encryptedJson(payload, key, profileBindingAad(authority));
    const replacementRegistry = await encryptedJson(registryPayload(), key, registryAad(authority));
    const legacy: Record<string, unknown> = wireRow(row);
    delete legacy.profileBindingEnvelope;
    for (const candidate of [
      parseRow({ ...wireRow(row), profileBindingEnvelope: replacement }),
      parseRow({ ...wireRow(row), envelope: replacementRegistry }),
      parseRow(legacy),
      parseRow({ ...wireRow(row), profileBindingEnvelope: null }),
      parseRow({ ...wireRow(row), revision: 2 }),
      parseRow({ ...wireRow(row), devicePublicId: "device_foreign" }),
      parseRow({ ...wireRow(row), envelope: { ...row.envelope, keyVersion: 2 }, keyVersion: 2 }),
    ]) {
      expect(registryProjectionCacheKey(candidate)).not.toBe(registryProjectionCacheKey(row));
      expect(read(candidate)).toBeUndefined();
    }
    for (const current of [
      { key: null, userPublicId },
      { key, userPublicId: null },
      { key, userPublicId: "user_foreign" },
      { key: randomKeyBytes(), userPublicId },
      { key: new Uint8Array(key), userPublicId },
    ]) expect(registryProjectionFromCache(cache, { ...current, row })).toBeUndefined();
    expect(registryProjectionFromCache(null, { key, row, userPublicId })).toBeUndefined();
    expect(registryProjectionCacheKey(parseRow({ ...wireRow(row), envelope: {
      nonce: row.envelope.nonce,
      keyVersion: row.envelope.keyVersion,
      ciphertext: row.envelope.ciphertext,
      algorithm: row.envelope.algorithm,
    } }))).toBe(registryProjectionCacheKey(row));
    const firstByte = key[0];
    if (firstByte === undefined) throw new Error("invalid key fixture");
    key[0] = firstByte ^ 1;
    expect(read(row)).toBeUndefined();
    key[0] = firstByte;
    expect(read(row)).toBe(projection);
    cancellation.cancel();
    expect(read(row)).toBeUndefined();
    // Cleanup and custody can wipe both arrays in place; matching zeros must
    // not revive a cancelled read or expose its already-decrypted projection.
    cache.keyBytes.fill(0);
    key.fill(0);
    expect(read(row)).toBeUndefined();
  });
});

describe("notification policy registry compatibility", () => {
  test("keeps an old registry readable without claiming an exact default profile", () => {
    expect(parseRow({
      devicePublicId,
      envelope: {
        algorithm: "A256GCM",
        ciphertext: "A".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      },
      keyVersion: 1,
      revision: 1,
      updatedAt: 1,
    })).toMatchObject({
      profileBindingEnvelope: null,
      profileBindingEnvelopeStatus: "absent",
    });
  });

  test("distinguishes absent legacy fields from malformed and wrong-key envelopes", () => {
    const envelope = {
      algorithm: "A256GCM",
      ciphertext: "A".repeat(32),
      keyVersion: 1,
      nonce: "B".repeat(16),
    } as const;
    const base = {
      devicePublicId,
      envelope,
      keyVersion: 1,
      revision: 1,
      updatedAt: 1,
    };
    expect(parseRow(base).notificationEmailEnvelopeStatus).toBe("absent");
    expect(parseRow(base).notificationHoursEnvelopeStatus).toBe("absent");
    expect(parseRow(base).memorySummaryEnvelopeStatus).toBe("absent");
    expect(parseRow(base)).toMatchObject({
      memorySummaryRevision: null,
      memorySummaryUpdatedAt: null,
    });
    expect(parseRow(base).notificationPolicyRevisionStatus).toBe("absent");
    expect(parseRow({
      ...base,
      notificationEmailEnvelope: { ...envelope, ciphertext: "not base64!" },
    }).notificationEmailEnvelopeStatus).toBe("invalid");
    expect(parseRow({
      ...base,
      notificationEmailEnvelope: { ...envelope, keyVersion: 2 },
    }).notificationEmailEnvelopeStatus).toBe("invalid");
    expect(parseRow({
      ...base,
      notificationHoursEnvelope: { ...envelope, ciphertext: "not base64!" },
    }).notificationHoursEnvelopeStatus).toBe("invalid");
    expect(parseRow({
      ...base,
      notificationHoursEnvelope: { ...envelope, keyVersion: 2 },
    }).notificationHoursEnvelopeStatus).toBe("invalid");
    expect(parseRow({
      ...base,
      memorySummaryEnvelope: { ...envelope, ciphertext: "not base64!" },
      memorySummaryRevision: 1,
      memorySummaryUpdatedAt: 2,
    }).memorySummaryEnvelopeStatus).toBe("invalid");
    expect(parseRow({
      ...base,
      memorySummaryEnvelope: { ...envelope, keyVersion: 2 },
      memorySummaryRevision: 1,
      memorySummaryUpdatedAt: 2,
    }).memorySummaryEnvelopeStatus).toBe("invalid");
    expect(parseRow({ ...base, memorySummaryEnvelope: { ...envelope } }))
      .toMatchObject({ memorySummaryEnvelopeStatus: "invalid", memorySummaryRevision: null });
    expect(parseRow({ ...base, memorySummaryRevision: 1 }))
      .toMatchObject({ memorySummaryEnvelopeStatus: "invalid", memorySummaryRevision: null });
    expect(parseRow({ ...base, memorySummaryRevision: 1, memorySummaryUpdatedAt: 0 }))
      .toMatchObject({ memorySummaryEnvelopeStatus: "invalid", memorySummaryRevision: null });
    expect(parseRow({ ...base, memorySummaryRevision: 1, memorySummaryUpdatedAt: 2 }))
      .toMatchObject({
        memorySummaryEnvelopeStatus: "absent",
        memorySummaryRevision: 1,
        memorySummaryUpdatedAt: 2,
      });
    expect(parseRow({ ...base, notificationPolicyRevision: 2 }))
      .toMatchObject({ notificationPolicyRevision: 2, notificationPolicyRevisionStatus: "present" });
    expect(parseRow({ ...base, notificationPolicyRevision: 0 }))
      .toMatchObject({ notificationPolicyRevision: null, notificationPolicyRevisionStatus: "invalid" });
  });

  test("snapshots a foreign row once without invoking stateful accessors", () => {
    let getterCalls = 0;
    const row = {
      devicePublicId,
      envelope: {
        algorithm: "A256GCM",
        ciphertext: "A".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      },
      keyVersion: 1,
      revision: 1,
      updatedAt: 1,
    } as Record<string, unknown>;
    Object.defineProperty(row, "notificationPolicyRevision", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? 2 : 1;
      },
    });
    expect(parseRegistryRow(row)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("snapshots the foreign collection before reading an array index", () => {
    let getterCalls = 0;
    const rows: unknown[] = [];
    Object.defineProperty(rows, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("foreign array getter executed");
      },
    });

    expect(() => parseRegistryRows(rows)).not.toThrow();
    expect(parseRegistryRows(rows)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  test("decrypts a bound policy and isolates an undecryptable additive envelope", async () => {
    const key = randomKeyBytes();
    const authority = { devicePublicId, keyVersion: 1, userPublicId } as const;
    const envelope = await encryptedJson(registryPayload(), key, registryAad(authority));
    const hours = {
      endMinute: 1_320,
      revision: 2,
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    } as const;
    const notificationHoursEnvelope = await encryptedJson(
      hours,
      key,
      notificationHoursAad(authority),
    );
    const base = {
      devicePublicId,
      envelope,
      keyVersion: 1,
      notificationHoursEnvelope,
      revision: 1,
      updatedAt: 1,
    };
    expect(await decryptRegistryProjection({
      key,
      row: parseRow({
        devicePublicId,
        envelope,
        keyVersion: 1,
        revision: 1,
        updatedAt: 1,
      }),
      userPublicId,
    })).toMatchObject({
      attentionEmailEnabled: null,
      notificationHours: null,
      notificationHoursStatus: "unsupported",
      notificationPolicyFreshness: "unsupported",
      registry: { machineLabel: "Studio" },
    });
    expect(await decryptRegistryProjection({ key, row: parseRow(base), userPublicId }))
      .toMatchObject({ notificationHours: hours, notificationHoursStatus: "available" });

    const first = notificationHoursEnvelope.ciphertext[0] === "A" ? "B" : "A";
    const corrupted = {
      ...notificationHoursEnvelope,
      ciphertext: first + notificationHoursEnvelope.ciphertext.slice(1),
    };
    expect(await decryptRegistryProjection({
      key,
      row: parseRow({ ...base, notificationHoursEnvelope: corrupted }),
      userPublicId,
    })).toMatchObject({
      notificationHours: null,
      notificationHoursStatus: "unreadable",
      registry: { machineLabel: "Studio" },
    });
  });

  test("drops legacy Codex Desktop automation metadata before it reaches the app", async () => {
    const key = randomKeyBytes();
    const authority = { devicePublicId, keyVersion: 1, userPublicId } as const;
    const oompaTask = {
      cadence: "every 60 minutes",
      id: "stask_public_hra_task",
      kind: "hra_conversation",
      label: "Public Oompa task",
      nextRunAt: 1_760_000_060_000,
      sessionPublicId: "sess_public_hra_session",
    } as const;
    const privateAutomation = {
      cadence: "FREQ=WEEKLY;BYDAY=MO",
      id: "desktop-private-automation-id",
      kind: "codex_automation",
      label: "Desktop private automation label",
      nextRunAt: null,
      sessionPublicId: "sess_private_target_correlation",
    } as const;
    // Encrypt the legacy wire shape directly so this exercises an old daemon's
    // existing row rather than the current writer, which already strips it.
    const envelope = await encryptedJson({
      ...registryPayload(),
      scheduledTasks: [oompaTask, privateAutomation],
    }, key, registryAad(authority));
    const projection = await decryptRegistryProjection({
      key,
      row: parseRow({
        devicePublicId,
        envelope,
        keyVersion: 1,
        revision: 1,
        updatedAt: 1,
      }),
      userPublicId,
    });

    expect(projection.registry.scheduledTasks).toEqual([oompaTask]);
    const appProjection = JSON.stringify(projection);
    for (const privateValue of [
      privateAutomation.id,
      privateAutomation.label,
      privateAutomation.cadence,
      privateAutomation.sessionPublicId,
    ]) {
      expect(appProjection).not.toContain(privateValue);
    }
  });

  test("decrypts memory supervision independently and fails its corruption closed", async () => {
    const key = randomKeyBytes();
    const authority = { devicePublicId, keyVersion: 1, userPublicId } as const;
    const envelope = await encryptedJson(registryPayload(), key, registryAad(authority));
    const digest = (scalar: string) => scalar.repeat(64);
    const memorySummary = {
      coverage: { peerActions: "complete", peerPolicies: "complete", spaces: "complete" },
      observedAt: 1_760_000_000_000,
      peerActions: [],
      peerPolicies: [],
      spaces: [{
        bindingDigest: digest("a"),
        canonicalSpaceId: `oompa:project:space-${"b".repeat(32)}`,
        enrollment: "not_enrolled",
        head: { digest: digest("c"), operationSha256: null, sequence: 0 },
        lastExchangeAt: null,
        projectLabel: "Oompa",
        recentRecords: [],
        recordCount: 0,
        remoteHead: null,
        syncStatus: "local_only",
      }],
      version: 1,
    } as const;
    const memorySummaryEnvelope = await encryptedJson(
      memorySummary,
      key,
      memorySummaryAad(authority),
    );
    const row = parseRow({
      devicePublicId,
      envelope,
      keyVersion: 1,
      memorySummaryEnvelope,
      memorySummaryRevision: 1,
      memorySummaryUpdatedAt: 2,
      revision: 1,
      updatedAt: 1,
    });
    expect(await decryptRegistryProjection({
      key,
      memorySummaryReady: false,
      row,
      userPublicId,
    })).toMatchObject({
      memorySummary: null,
      memorySummaryStatus: "unsupported",
      registry: { machineLabel: "Studio" },
    });
    expect(await decryptRegistryProjection({ key, row, userPublicId })).toMatchObject({
      memorySummary: null,
      memorySummaryStatus: "unsupported",
    });
    expect(await decryptRegistryProjection({
      key,
      memorySummaryReady: true,
      row,
      userPublicId,
    })).toMatchObject({
      memorySummary,
      memorySummaryStatus: "available",
      registry: { machineLabel: "Studio" },
    });
    const first = memorySummaryEnvelope.ciphertext[0] === "A" ? "B" : "A";
    const corruptedRow = parseRow({
      devicePublicId,
      envelope,
      keyVersion: 1,
      memorySummaryEnvelope: {
        ...memorySummaryEnvelope,
        ciphertext: first + memorySummaryEnvelope.ciphertext.slice(1),
      },
      memorySummaryRevision: 2,
      memorySummaryUpdatedAt: 3,
      revision: 1,
      updatedAt: 1,
    });
    expect(await decryptRegistryProjection({
      key,
      memorySummaryReady: false,
      row: corruptedRow,
      userPublicId,
    })).toMatchObject({
      memorySummary: null,
      memorySummaryStatus: "unsupported",
    });
    expect(await decryptRegistryProjection({
      key,
      memorySummaryReady: true,
      row: corruptedRow,
      userPublicId,
    })).toMatchObject({
      memorySummary: null,
      memorySummaryStatus: "unreadable",
      registry: { machineLabel: "Studio" },
    });
    const replaced = parseRow({
      devicePublicId,
      envelope,
      keyVersion: 1,
      memorySummaryEnvelope,
      memorySummaryRevision: 2,
      memorySummaryUpdatedAt: 3,
      revision: 1,
      updatedAt: 1,
    });
    expect(registryProjectionCacheKey(replaced)).not.toBe(registryProjectionCacheKey(row));
  });

  test("shows email consent only when the composite revision is current", async () => {
    const key = randomKeyBytes();
    const authority = { devicePublicId, keyVersion: 1, userPublicId } as const;
    const envelope = await encryptedJson(
      registryPayload(),
      key,
      registryAad(authority),
    );
    const email = { enabled: true, revision: 2, version: 1 } as const;
    const notificationEmailEnvelope = await encryptedJson(
      email,
      key,
      notificationEmailAad(authority),
    );
    const hours = {
      endMinute: 1_320,
      revision: 2,
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    } as const;
    const notificationHoursEnvelope = await encryptedJson(
      hours,
      key,
      notificationHoursAad(authority),
    );
    const base = {
      devicePublicId,
      envelope,
      keyVersion: 1,
      notificationEmailEnvelope,
      notificationHoursEnvelope,
      revision: 1,
      updatedAt: 1,
    };
    expect(await decryptRegistryProjection({
      key,
      row: parseRow({ ...base, notificationPolicyRevision: 2 }),
      userPublicId,
    })).toMatchObject({
      attentionEmailEnabled: true,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 2,
    });
    for (const row of [
      parseRow(base),
      parseRow({ ...base, notificationPolicyRevision: 1 }),
    ]) {
      expect(await decryptRegistryProjection({ key, row, userPublicId })).toMatchObject({
        attentionEmailEnabled: null,
        notificationPolicyFreshness: "stale",
      });
    }
    const previousEmailEnvelope = await encryptedJson(
      { ...email, revision: 1 },
      key,
      notificationEmailAad(authority),
    );
    expect(await decryptRegistryProjection({
      key,
      row: parseRow({
        ...base,
        notificationEmailEnvelope: previousEmailEnvelope,
        notificationPolicyRevision: 2,
      }),
      userPublicId,
    })).toMatchObject({
      attentionEmailEnabled: null,
      notificationPolicyFreshness: "stale",
      notificationPolicyRevision: 2,
    });
    expect(await decryptRegistryProjection({
      key,
      row: parseRow({ ...base, notificationPolicyRevision: "2" }),
      userPublicId,
    })).toMatchObject({
      attentionEmailEnabled: null,
      notificationPolicyFreshness: "unreadable",
    });
    const first = notificationEmailEnvelope.ciphertext[0] === "A" ? "B" : "A";
    expect(await decryptRegistryProjection({
      key,
      row: parseRow({
        ...base,
        notificationEmailEnvelope: {
          ...notificationEmailEnvelope,
          ciphertext: first + notificationEmailEnvelope.ciphertext.slice(1),
        },
        notificationPolicyRevision: 2,
      }),
      userPublicId,
    })).toMatchObject({
      attentionEmailEnabled: null,
      notificationPolicyFreshness: "unreadable",
    });
  });
});
