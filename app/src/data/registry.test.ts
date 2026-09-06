import { describe, expect, test } from "bun:test";

import {
  encryptBytes,
  parseDeviceRegistryPayload,
  randomKeyBytes,
  type DeviceRegistryPayload,
  type EncryptedEnvelope,
} from "../hra/cloud";
import {
  decryptRegistryProjection,
  notificationEmailAad,
  notificationHoursAad,
  parseRegistryRow,
  parseRegistryRows,
  registryAad,
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

describe("notification policy registry compatibility", () => {
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
