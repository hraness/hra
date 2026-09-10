import { describe, expect, spyOn, test } from "bun:test";
import {
  canonicalJson,
  canonicalSha256,
  createKnowledgeGraphRecordV1,
  createOhOperationV1,
  OH_CONTRACT_MANIFEST_V1,
} from "@hraness/oh";
import { emptyOhHeadV1, type OhHeadV1 } from "@hraness/oh/store";

import {
  CANONICAL_MEMORY_ADOPTION_PROOF_PURPOSE,
  CANONICAL_MEMORY_OPERATION_BUNDLE_PURPOSE,
  canonicalMemoryCiphertextLimits,
  canonicalMemoryPlaintextLimits,
  OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES,
} from "../domain/canonical-memory-sync";
import {
  canonicalMemoryBindingDigest,
  deriveCanonicalMemoryHostedSpaceId,
  decryptCanonicalMemoryAdoptionProof,
  decryptCanonicalMemoryDescriptor,
  decryptCanonicalMemoryOperation,
  decryptCanonicalMemoryTerminalHeadProof,
  deriveCanonicalMemoryGenesisToken,
  deriveCanonicalMemoryHeadToken,
  encryptCanonicalMemoryAdoptionProof,
  encryptCanonicalMemoryDescriptor,
  encryptCanonicalMemoryOperation,
  encryptCanonicalMemoryTerminalHeadProof,
  generateCanonicalMemorySpaceKey,
  parseCanonicalMemoryAdoptionProofV1,
  parseCanonicalMemoryDescriptorV1,
  parseCanonicalMemoryHostedSpaceId,
  parseCanonicalMemorySpaceKey,
  parsePortableCanonicalMemorySpaceId,
  unwrapCanonicalMemorySpaceKey,
  wrapCanonicalMemorySpaceKey,
  type CanonicalMemoryAdoptionProofV1,
  type CanonicalMemoryBinding,
  type CanonicalMemoryEncryptionKey,
} from "./canonical-memory-crypto";
import {
  encodeBase64Url,
  encryptBytes,
  GcmMessageBudget,
  hmacSha256Hex,
  sha256Hex,
} from "./crypto";
import { parseCanonicalMemoryOperation } from "./memory-sync-contracts";

const canonicalSpaceId = "oompa:project:space-0123456789abcdef0123456789abcdef";
const otherCanonicalSpaceId = "oompa:project:space-fedcba9876543210fedcba9876543210";
const hostedSpaceId = `memory_${"A".repeat(32)}`;
const otherHostedSpaceId = `memory_${"B".repeat(32)}`;
const keyVersion = 3;
const spaceKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const accountKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const wrongKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);

function encryptionKey(
  bytes: Uint8Array,
  version: number,
  usageScope: CanonicalMemoryEncryptionKey["usageScope"] = `space:${hostedSpaceId}`,
): CanonicalMemoryEncryptionKey {
  const owned = Uint8Array.from(bytes);
  const budget = new GcmMessageBudget();
  return Object.freeze({
    authenticate: async (purpose: string, value: string): Promise<string> =>
      await hmacSha256Hex(owned, purpose, value),
    dispose: (): void => {
      owned.fill(0);
    },
    encrypt: async (plaintext: Uint8Array, aad: Uint8Array) =>
      await encryptBytes(plaintext, owned, version, aad, budget),
    keyVersion: version,
    usageScope,
  });
}

type ZeroFill = Readonly<{
  before: Uint8Array;
  bytes: Uint8Array;
}>;

async function observeOwnedSecretZeroization<T>(
  operation: () => Promise<T>,
): Promise<Readonly<{ fills: readonly ZeroFill[]; result: T }>> {
  const originalValue: unknown = Reflect.get(Uint8Array.prototype, "fill");
  if (typeof originalValue !== "function") throw new Error("Uint8Array.fill is unavailable.");
  const original = originalValue as (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number,
  ) => Uint8Array;
  const fills: ZeroFill[] = [];
  const fill = spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number,
  ): Uint8Array {
    if (value === 0 && (start === undefined || start === 0) && end === undefined) {
      fills.push({ before: Uint8Array.from(this), bytes: this });
    }
    return original.call(this, value, start, end);
  });
  try {
    return { fills, result: await operation() };
  } finally {
    fill.mockRestore();
  }
}

function expectFullyZeroed(observation: ZeroFill): void {
  expect(observation.bytes).toEqual(new Uint8Array(observation.bytes.byteLength));
}

const authority: CanonicalMemoryBinding = {
  bindingDigest: canonicalMemoryBindingDigest(canonicalSpaceId),
  canonicalSpaceId,
  hostedSpaceId,
  keyVersion,
};

function flipCiphertext<T extends { ciphertext: string }>(envelope: T): T {
  return {
    ...envelope,
    ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
  };
}

function operationFixture(spaceId = canonicalSpaceId, largeValueCharacters = 0) {
  const record = createKnowledgeGraphRecordV1({
    dependencies: [],
    key: "entity:memory-sync",
    kind: "entity",
    v: 1,
    value: largeValueCharacters === 0
      ? { name: "portable fact" }
      : "x".repeat(largeValueCharacters),
  });
  const operation = createOhOperationV1({
    actorId: "agent.memory",
    changes: [{ kind: "put", record, v: 1 }],
    contractId: OH_CONTRACT_MANIFEST_V1.contractId,
    graphRevisionSha256: canonicalSha256({ record: record.recordSha256 }),
    instant: "2026-09-06T00:00:00.000Z",
    operationId: "op_memory_sync_1",
    parentOperationSha256: null,
    recordsSha256: canonicalSha256([record.recordSha256]),
    sequence: 1,
    spaceId,
    v: 1,
  });
  const head: OhHeadV1 = {
    generation: operation.sequence,
    graphRevisionSha256: operation.graphRevisionSha256,
    operationSha256: operation.operationSha256,
    recordsSha256: operation.recordsSha256,
    sequence: operation.sequence,
    v: 1,
  };
  return { head, operation };
}

function operationAad(
  wire: Readonly<{
    genesisToken: string;
    headToken: string;
    priorToken: string;
    sequence: number;
  }>,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson({
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    genesisToken: wire.genesisToken,
    headToken: wire.headToken,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    priorToken: wire.priorToken,
    purpose: CANONICAL_MEMORY_OPERATION_BUNDLE_PURPOSE,
    sequence: wire.sequence,
    v: 1,
  }));
}

async function adoptionProofAad(
  wire: Readonly<{
    genesisToken: string;
    headToken: string;
    operation: Readonly<{
      algorithm: "A256GCM";
      ciphertext: string;
      keyVersion: number;
      nonce: string;
    }>;
    priorToken: string;
    sequence: number;
  }>,
  binding: CanonicalMemoryBinding = authority,
): Promise<Uint8Array> {
  return new TextEncoder().encode(canonicalJson({
    bindingDigest: binding.bindingDigest,
    canonicalSpaceId: binding.canonicalSpaceId,
    genesisToken: wire.genesisToken,
    headToken: wire.headToken,
    hostedSpaceId: binding.hostedSpaceId,
    keyVersion: binding.keyVersion,
    operationEnvelopeSha256: await sha256Hex(canonicalJson(wire.operation)),
    priorToken: wire.priorToken,
    purpose: CANONICAL_MEMORY_ADOPTION_PROOF_PURPOSE,
    sequence: wire.sequence,
    v: 1,
  }));
}

function adoptionProofFixture(
  operationSha256: string,
  overrides: Partial<CanonicalMemoryAdoptionProofV1> = {},
): CanonicalMemoryAdoptionProofV1 {
  return {
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId,
    contentDigest: canonicalSha256("portable content"),
    keyDigest: canonicalSha256("portable key"),
    operationSha256,
    recordSha256: canonicalSha256("portable record"),
    sequence: 1,
    sourceReceiptSha256: canonicalSha256("portable source receipt"),
    v: 1,
    ...overrides,
  };
}

describe("canonical memory client cryptography", () => {
  test("derives one opaque owner-scoped route independent of rotatable keys", async () => {
    const accountBindingDigest = canonicalSha256({
      deploymentUrl: "https://memory-owner.convex.cloud",
      userPublicId: "user_memory_owner",
      v: 1,
    });
    const identifier = await deriveCanonicalMemoryHostedSpaceId({
      accountBindingDigest,
      canonicalSpaceId,
    });
    expect(await deriveCanonicalMemoryHostedSpaceId({
      accountBindingDigest,
      canonicalSpaceId,
    })).toBe(identifier);
    expect(parseCanonicalMemoryHostedSpaceId(identifier)).toBe(identifier);
    expect(identifier).not.toContain("oompa:project:");
    expect(identifier).not.toContain(canonicalSpaceId.slice(-32));
    expect(await deriveCanonicalMemoryHostedSpaceId({
      accountBindingDigest: canonicalSha256({
        deploymentUrl: "https://other-deployment.convex.cloud",
        userPublicId: "user_memory_owner",
        v: 1,
      }),
      canonicalSpaceId,
    })).not.toBe(identifier);
    expect(await deriveCanonicalMemoryHostedSpaceId({
      accountBindingDigest,
      canonicalSpaceId: otherCanonicalSpaceId,
    })).not.toBe(identifier);
    await expect(deriveCanonicalMemoryHostedSpaceId({
      accountBindingDigest: "not-a-digest",
      canonicalSpaceId,
    })).rejects.toThrow("CANONICAL_MEMORY_ACCOUNT_BINDING_INVALID");
    expect(parseCanonicalMemoryHostedSpaceId(canonicalSpaceId)).toBeNull();
    expect(parseCanonicalMemoryHostedSpaceId("memory_short")).toBeNull();
    expect(parsePortableCanonicalMemorySpaceId(canonicalSpaceId)).toBe(canonicalSpaceId);
    expect(parsePortableCanonicalMemorySpaceId(hostedSpaceId)).toBeNull();

    const generated = generateCanonicalMemorySpaceKey();
    const parsed = parseCanonicalMemorySpaceKey(generated);
    expect(generated).toHaveLength(32);
    expect(parsed).toEqual(generated);
    expect(parsed).not.toBe(generated);
    expect(parseCanonicalMemorySpaceKey(new Uint8Array(31))).toBeNull();
    expect(parseCanonicalMemorySpaceKey(Buffer.alloc(32))).toBeNull();
    expect(parseCanonicalMemorySpaceKey(new Proxy(generated, {}))).toBeNull();
  });

  test("wraps the space key under the account key with route- and version-bound AAD", async () => {
    const wrapAuthority = {
      accountKeyVersion: 7,
      hostedSpaceId,
      spaceKeyVersion: keyVersion,
    };
    const wrapped = await wrapCanonicalMemorySpaceKey({
      authority: wrapAuthority,
      encryptionKey: encryptionKey(
        accountKey,
        wrapAuthority.accountKeyVersion,
        "account_data",
      ),
      spaceKey,
    });
    expect(wrapped.keyVersion).toBe(wrapAuthority.accountKeyVersion);
    expect(wrapped.ciphertext).not.toBe(encodeBase64Url(spaceKey));
    expect(wrapped.ciphertext.length)
      .toBeLessThanOrEqual(canonicalMemoryCiphertextLimits.terminalHeadProof);
    expect(await unwrapCanonicalMemorySpaceKey({
      accountKey,
      authority: wrapAuthority,
      envelope: wrapped,
    })).toEqual(spaceKey);
    await expect(unwrapCanonicalMemorySpaceKey({
      accountKey: wrongKey,
      authority: wrapAuthority,
      envelope: wrapped,
    })).rejects.toThrow();
    await expect(unwrapCanonicalMemorySpaceKey({
      accountKey,
      authority: { ...wrapAuthority, hostedSpaceId: otherHostedSpaceId },
      envelope: wrapped,
    })).rejects.toThrow();
    await expect(unwrapCanonicalMemorySpaceKey({
      accountKey,
      authority: { ...wrapAuthority, spaceKeyVersion: keyVersion + 1 },
      envelope: wrapped,
    })).rejects.toThrow();
    await expect(unwrapCanonicalMemorySpaceKey({
      accountKey,
      authority: wrapAuthority,
      envelope: flipCiphertext(wrapped),
    })).rejects.toThrow();
  });

  test("wipes owned key copies while preserving caller-owned account and space keys", async () => {
    const callerAccountKey = Uint8Array.from(accountKey);
    const callerSpaceKey = Uint8Array.from(spaceKey);
    const expectedAccountKey = Uint8Array.from(callerAccountKey);
    const expectedSpaceKey = Uint8Array.from(callerSpaceKey);
    const wrapAuthority = {
      accountKeyVersion: 7,
      hostedSpaceId,
      spaceKeyVersion: keyVersion,
    };
    const wrappedObservation = await observeOwnedSecretZeroization(async () =>
      await wrapCanonicalMemorySpaceKey({
        authority: wrapAuthority,
        encryptionKey: encryptionKey(
          callerAccountKey,
          wrapAuthority.accountKeyVersion,
          "account_data",
        ),
        spaceKey: callerSpaceKey,
      }));
    const wrappedSpaceKeyCopy = wrappedObservation.fills.find((fill) =>
      fill.bytes !== callerSpaceKey && fill.before.toString() === expectedSpaceKey.toString());
    expect(wrappedSpaceKeyCopy).toBeDefined();
    expectFullyZeroed(wrappedSpaceKeyCopy as ZeroFill);

    const unwrappedObservation = await observeOwnedSecretZeroization(async () =>
      await unwrapCanonicalMemorySpaceKey({
        accountKey: callerAccountKey,
        authority: wrapAuthority,
        envelope: wrappedObservation.result,
      }));
    expect(unwrappedObservation.result).toEqual(expectedSpaceKey);
    expect(unwrappedObservation.result).not.toBe(callerSpaceKey);
    const accountKeyCopy = unwrappedObservation.fills.find((fill) =>
      fill.bytes !== callerAccountKey && fill.before.toString() === expectedAccountKey.toString());
    const decryptedSpaceKey = unwrappedObservation.fills.find((fill) =>
      fill.bytes !== unwrappedObservation.result
      && fill.before.toString() === expectedSpaceKey.toString());
    expect(accountKeyCopy).toBeDefined();
    expect(decryptedSpaceKey).toBeDefined();
    expectFullyZeroed(accountKeyCopy as ZeroFill);
    expectFullyZeroed(decryptedSpaceKey as ZeroFill);

    const genesisObservation = await observeOwnedSecretZeroization(async () =>
      await deriveCanonicalMemoryGenesisToken({
        authority,
        head: emptyOhHeadV1(),
        spaceKey: callerSpaceKey,
      }));
    expect(genesisObservation.result).toMatch(/^[a-f0-9]{64}$/u);
    const genesisKeyCopy = genesisObservation.fills.find((fill) =>
      fill.bytes !== callerSpaceKey && fill.before.toString() === expectedSpaceKey.toString());
    expect(genesisKeyCopy).toBeDefined();
    expectFullyZeroed(genesisKeyCopy as ZeroFill);

    const rejectedUnwrap = await observeOwnedSecretZeroization(async () => {
      try {
        await unwrapCanonicalMemorySpaceKey({
          accountKey: callerAccountKey,
          authority: wrapAuthority,
          envelope: flipCiphertext(wrappedObservation.result),
        });
      } catch {
        return "rejected" as const;
      }
      return "accepted" as const;
    });
    expect(rejectedUnwrap.result).toBe("rejected");
    const rejectedAccountKeyCopy = rejectedUnwrap.fills.find((fill) =>
      fill.bytes !== callerAccountKey && fill.before.toString() === expectedAccountKey.toString());
    expect(rejectedAccountKeyCopy).toBeDefined();
    expectFullyZeroed(rejectedAccountKeyCopy as ZeroFill);

    const rejectedHead = await observeOwnedSecretZeroization(async () => {
      try {
        await deriveCanonicalMemoryHeadToken({
          authority,
          head: emptyOhHeadV1(),
          spaceKey: callerSpaceKey,
        });
      } catch {
        return "rejected" as const;
      }
      return "accepted" as const;
    });
    expect(rejectedHead.result).toBe("rejected");
    const rejectedHeadKeyCopy = rejectedHead.fills.find((fill) =>
      fill.bytes !== callerSpaceKey && fill.before.toString() === expectedSpaceKey.toString());
    expect(rejectedHeadKeyCopy).toBeDefined();
    expectFullyZeroed(rejectedHeadKeyCopy as ZeroFill);

    expect(callerAccountKey).toEqual(expectedAccountKey);
    expect(callerSpaceKey).toEqual(expectedSpaceKey);
  });

  test("encrypts only the portable descriptor and strictly verifies discovered or expected binding", async () => {
    const encrypted = await encryptCanonicalMemoryDescriptor({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
    });
    expect(encrypted.keyVersion).toBe(keyVersion);
    expect(encrypted.ciphertext.length)
      .toBeLessThanOrEqual(canonicalMemoryCiphertextLimits.terminalHeadProof);
    expect(JSON.stringify(encrypted)).not.toContain(canonicalSpaceId);
    expect(JSON.stringify(encrypted)).not.toContain(authority.bindingDigest);
    const descriptor = await decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: encrypted,
      spaceKey,
    });
    expect(descriptor).toEqual({
      bindingDigest: authority.bindingDigest,
      bindingPolicy: "one_project_one_space",
      canonicalSpaceId,
      identityContract: 2,
      v: 1,
    });
    expect(Object.keys(descriptor).sort()).toEqual([
      "bindingDigest",
      "bindingPolicy",
      "canonicalSpaceId",
      "identityContract",
      "v",
    ]);
    expect(await decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: encrypted,
      expectedBinding: {
        bindingDigest: authority.bindingDigest,
        canonicalSpaceId,
      },
      spaceKey,
    })).toEqual(descriptor);

    const otherBinding = {
      bindingDigest: canonicalMemoryBindingDigest(otherCanonicalSpaceId),
      canonicalSpaceId: otherCanonicalSpaceId,
    };
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: encrypted,
      expectedBinding: otherBinding,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId: otherHostedSpaceId, keyVersion },
      envelope: encrypted,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: encrypted,
      spaceKey: wrongKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: flipCiphertext(encrypted),
      spaceKey,
    })).rejects.toThrow();
  });

  test("wipes owned descriptor plaintext on success and post-decryption refusal", async () => {
    const callerSpaceKey = Uint8Array.from(spaceKey);
    const expectedSpaceKey = Uint8Array.from(callerSpaceKey);
    const encryptedObservation = await observeOwnedSecretZeroization(async () =>
      await encryptCanonicalMemoryDescriptor({
        authority,
        encryptionKey: encryptionKey(callerSpaceKey, keyVersion),
      }));
    const encryptedPlaintext = encryptedObservation.fills.find((fill) =>
      new TextDecoder().decode(fill.before).includes(canonicalSpaceId));
    expect(encryptedPlaintext).toBeDefined();
    expectFullyZeroed(encryptedPlaintext as ZeroFill);

    const decryptedObservation = await observeOwnedSecretZeroization(async () =>
      await decryptCanonicalMemoryDescriptor({
        authority: { hostedSpaceId, keyVersion },
        envelope: encryptedObservation.result,
        spaceKey: callerSpaceKey,
      }));
    expect(decryptedObservation.result.canonicalSpaceId).toBe(canonicalSpaceId);
    const decryptedPlaintext = decryptedObservation.fills.find((fill) =>
      new TextDecoder().decode(fill.before).includes(canonicalSpaceId));
    expect(decryptedPlaintext).toBeDefined();
    expectFullyZeroed(decryptedPlaintext as ZeroFill);

    const rejected = await observeOwnedSecretZeroization(async () => {
      try {
        await decryptCanonicalMemoryDescriptor({
          authority: { hostedSpaceId, keyVersion },
          envelope: encryptedObservation.result,
          expectedBinding: {
            bindingDigest: canonicalMemoryBindingDigest(otherCanonicalSpaceId),
            canonicalSpaceId: otherCanonicalSpaceId,
          },
          spaceKey: callerSpaceKey,
        });
      } catch {
        return "rejected" as const;
      }
      return "accepted" as const;
    });
    expect(rejected.result).toBe("rejected");
    const rejectedPlaintext = rejected.fills.find((fill) =>
      new TextDecoder().decode(fill.before).includes(canonicalSpaceId));
    expect(rejectedPlaintext).toBeDefined();
    expectFullyZeroed(rejectedPlaintext as ZeroFill);
    expect(callerSpaceKey).toEqual(expectedSpaceKey);
  });

  test("rejects envelope algorithm, nonce, version, purpose, and hostile-property confusion", async () => {
    const encrypted = await encryptCanonicalMemoryDescriptor({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
    });
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: { ...encrypted, algorithm: "A128GCM" },
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ENVELOPE_INVALID");
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: { ...encrypted, nonce: "A".repeat(15) },
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ENVELOPE_INVALID");
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: { ...encrypted, keyVersion: keyVersion + 1 },
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ENVELOPE_INVALID");
    await expect(encryptCanonicalMemoryDescriptor({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion + 1),
    })).rejects.toThrow("CANONICAL_MEMORY_ENCRYPTION_KEY_INVALID");
    await expect(encryptCanonicalMemoryDescriptor({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion, "account_data"),
    })).rejects.toThrow("CANONICAL_MEMORY_ENCRYPTION_KEY_INVALID");
    await expect(encryptCanonicalMemoryDescriptor({
      authority,
      encryptionKey: encryptionKey(
        spaceKey,
        keyVersion,
        `space:${otherHostedSpaceId}`,
      ),
    })).rejects.toThrow("CANONICAL_MEMORY_ENCRYPTION_KEY_INVALID");
    await expect(wrapCanonicalMemorySpaceKey({
      authority: {
        accountKeyVersion: keyVersion,
        hostedSpaceId,
        spaceKeyVersion: keyVersion,
      },
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      spaceKey: wrongKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ENCRYPTION_KEY_INVALID");

    const sameVersionWrapped = await wrapCanonicalMemorySpaceKey({
      authority: {
        accountKeyVersion: keyVersion,
        hostedSpaceId,
        spaceKeyVersion: keyVersion,
      },
      encryptionKey: encryptionKey(spaceKey, keyVersion, "account_data"),
      spaceKey: wrongKey,
    });
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: sameVersionWrapped,
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_DECRYPT_FAILED");

    let reads = 0;
    const accessorEnvelope = { ...encrypted } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, "ciphertext", {
      enumerable: true,
      get() {
        reads += 1;
        return encrypted.ciphertext;
      },
    });
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: accessorEnvelope,
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ENVELOPE_INVALID");
    expect(reads).toBe(0);
    await expect(decryptCanonicalMemoryDescriptor({
      authority: { hostedSpaceId, keyVersion },
      envelope: new Proxy(encrypted, {
        ownKeys() {
          throw new Error("must remain inert");
        },
      }),
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ENVELOPE_INVALID");
  });

  test("rejects malformed, widened, hostile, and non-portable descriptors", () => {
    const descriptor = {
      bindingDigest: authority.bindingDigest,
      bindingPolicy: "one_project_one_space" as const,
      canonicalSpaceId,
      identityContract: 2 as const,
      v: 1 as const,
    };
    expect(parseCanonicalMemoryDescriptorV1(descriptor)).toEqual(descriptor);
    expect(parseCanonicalMemoryDescriptorV1({ ...descriptor, localProjectId: "project_1" }))
      .toBeNull();
    expect(parseCanonicalMemoryDescriptorV1({ ...descriptor, identityContract: 1 })).toBeNull();
    expect(parseCanonicalMemoryDescriptorV1({
      ...descriptor,
      bindingDigest: "f".repeat(64),
    })).toBeNull();
    expect(parseCanonicalMemoryDescriptorV1({
      ...descriptor,
      canonicalSpaceId: `oompa:project:${"a".repeat(64)}`,
    })).toBeNull();

    let reads = 0;
    const accessor = { ...descriptor } as Record<string, unknown>;
    Object.defineProperty(accessor, "canonicalSpaceId", {
      enumerable: true,
      get() {
        reads += 1;
        return canonicalSpaceId;
      },
    });
    expect(parseCanonicalMemoryDescriptorV1(accessor)).toBeNull();
    expect(reads).toBe(0);
    expect(parseCanonicalMemoryDescriptorV1(new Proxy(descriptor, {
      ownKeys() {
        throw new Error("must remain inert");
      },
    }))).toBeNull();
  });

  test("keys genesis and advanced full Oh heads under distinct HMAC purposes", async () => {
    const genesis = emptyOhHeadV1();
    const { head } = operationFixture();
    const genesisToken = await deriveCanonicalMemoryGenesisToken({
      authority,
      head: genesis,
      spaceKey,
    });
    const headToken = await deriveCanonicalMemoryHeadToken({ authority, head, spaceKey });
    expect(genesisToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(headToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(genesisToken).not.toBe(headToken);
    expect(await deriveCanonicalMemoryHeadToken({ authority, head, spaceKey })).toBe(headToken);
    expect(await deriveCanonicalMemoryHeadToken({
      authority,
      head: { ...head, recordsSha256: canonicalSha256("other records") },
      spaceKey,
    })).not.toBe(headToken);
    expect(await deriveCanonicalMemoryHeadToken({
      authority: { ...authority, keyVersion: keyVersion + 1 },
      head,
      spaceKey,
    })).not.toBe(headToken);
    expect(await deriveCanonicalMemoryHeadToken({
      authority: { ...authority, hostedSpaceId: otherHostedSpaceId },
      head,
      spaceKey,
    })).not.toBe(headToken);
    expect(await deriveCanonicalMemoryHeadToken({
      authority: {
        ...authority,
        bindingDigest: canonicalMemoryBindingDigest(otherCanonicalSpaceId),
        canonicalSpaceId: otherCanonicalSpaceId,
      },
      head,
      spaceKey,
    })).not.toBe(headToken);
    await expect(deriveCanonicalMemoryGenesisToken({
      authority,
      head,
      spaceKey,
    })).rejects.toThrow();
    await expect(deriveCanonicalMemoryHeadToken({
      authority,
      head: genesis,
      spaceKey,
    })).rejects.toThrow();
    await expect(deriveCanonicalMemoryGenesisToken({
      authority,
      head: { ...genesis, generation: -0, sequence: -0 },
      spaceKey,
    })).rejects.toThrow();
  });

  test("encrypts a terminal proof bound to route, portable binding, exact head, token, and key version", async () => {
    const { head } = operationFixture();
    const headToken = await deriveCanonicalMemoryHeadToken({ authority, head, spaceKey });
    const encrypted = await encryptCanonicalMemoryTerminalHeadProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      head,
      headToken,
    });
    expect(encrypted.ciphertext.length)
      .toBeLessThanOrEqual(canonicalMemoryCiphertextLimits.terminalHeadProof);
    const proof = await decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: encrypted,
      expectedHead: head,
      expectedHeadToken: headToken,
      expectedSequence: head.sequence,
      spaceKey,
    });
    expect(proof).toMatchObject({
      bindingDigest: authority.bindingDigest,
      canonicalSpaceId,
      head,
      headToken,
      hostedSpaceId,
      keyVersion,
      sequence: 1,
      v: 1,
    });

    const changedHead = { ...head, recordsSha256: canonicalSha256("wrong terminal") };
    const changedToken = await deriveCanonicalMemoryHeadToken({
      authority,
      head: changedHead,
      spaceKey,
    });
    await expect(decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: encrypted,
      expectedHead: changedHead,
      expectedHeadToken: changedToken,
      expectedSequence: changedHead.sequence,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryTerminalHeadProof({
      authority: { ...authority, hostedSpaceId: otherHostedSpaceId },
      envelope: encrypted,
      expectedHead: head,
      expectedHeadToken: headToken,
      expectedSequence: head.sequence,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: flipCiphertext(encrypted),
      expectedHead: head,
      expectedHeadToken: headToken,
      expectedSequence: head.sequence,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: encrypted,
      expectedHead: head,
      expectedHeadToken: headToken,
      expectedSequence: head.sequence,
      spaceKey: wrongKey,
    })).rejects.toThrow();
  });

  test("learns strict genesis and remote-advanced heads without a raw-head bootstrap loop", async () => {
    const genesis = emptyOhHeadV1();
    const genesisToken = await deriveCanonicalMemoryGenesisToken({
      authority,
      head: genesis,
      spaceKey,
    });
    const genesisProof = await encryptCanonicalMemoryTerminalHeadProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      head: genesis,
      headToken: genesisToken,
    });
    const discoveredGenesis = await decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: genesisProof,
      expectedHeadToken: genesisToken,
      expectedSequence: 0,
      spaceKey,
    });
    expect(discoveredGenesis.head).toEqual(genesis);

    const { head } = operationFixture();
    const headToken = await deriveCanonicalMemoryHeadToken({ authority, head, spaceKey });
    const advancedProof = await encryptCanonicalMemoryTerminalHeadProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      head,
      headToken,
    });
    const discoveredAdvanced = await decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: advancedProof,
      expectedHeadToken: headToken,
      expectedSequence: head.sequence,
      spaceKey,
    });
    expect(discoveredAdvanced.head).toEqual(head);
    await expect(decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: advancedProof,
      expectedHeadToken: headToken,
      expectedSequence: -0,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: advancedProof,
      expectedHeadToken: headToken,
      expectedSequence: head.sequence + 1,
      spaceKey,
    })).rejects.toThrow();
  });

  test("round-trips exactly one canonical Oh sync bundle and rejects every mismatched boundary", async () => {
    const genesis = emptyOhHeadV1();
    const { head, operation } = operationFixture();
    const wire = await encryptCanonicalMemoryOperation({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      genesisHead: genesis,
      operation,
      priorHead: genesis,
    });
    expect(parseCanonicalMemoryOperation(wire)).toEqual(wire);
    expect(wire.operation.ciphertext.length)
      .toBeLessThanOrEqual(canonicalMemoryCiphertextLimits.operation);
    expect(wire.terminalHeadProof.ciphertext.length)
      .toBeLessThanOrEqual(canonicalMemoryCiphertextLimits.terminalHeadProof);
    const decrypted = await decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: wire,
      spaceKey,
    });
    expect(decrypted.operation).toEqual(operation);
    expect(decrypted.adoptionProof).toEqual({ status: "absent" });
    expect(decrypted.head).toEqual(head);
    expect(decrypted.bundle.operations).toEqual([operation]);
    expect(decrypted.bundle.spaceId).toBe(canonicalSpaceId);
    expect(new TextEncoder().encode(canonicalJson(decrypted.bundle)).byteLength)
      .toBeLessThanOrEqual(canonicalMemoryPlaintextLimits.operationBundle);

    await expect(decryptCanonicalMemoryOperation({
      authority: { ...authority, hostedSpaceId: otherHostedSpaceId },
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: wire,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryOperation({
      authority: {
        ...authority,
        bindingDigest: canonicalMemoryBindingDigest(otherCanonicalSpaceId),
        canonicalSpaceId: otherCanonicalSpaceId,
      },
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: wire,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: wire,
      spaceKey: wrongKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: { ...genesis, recordsSha256: canonicalSha256("wrong prior") },
      operation: wire,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: { ...wire, operation: flipCiphertext(wire.operation) },
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: { ...wire, terminalHeadProof: flipCiphertext(wire.terminalHeadProof) },
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: { ...wire, sequence: -0 },
      spaceKey,
    })).rejects.toThrow();
    await expect(encryptCanonicalMemoryOperation({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      genesisHead: genesis,
      operation: operationFixture(otherCanonicalSpaceId).operation,
      priorHead: genesis,
    })).rejects.toThrow();

    const malformedBundle = {
      ...decrypted.bundle,
      contractSha256: "f".repeat(64),
    };
    const malformedEnvelope = await encryptBytes(
      new TextEncoder().encode(canonicalJson(malformedBundle)),
      spaceKey,
      keyVersion,
      operationAad(wire),
    );
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: { ...wire, operation: malformedEnvelope },
      spaceKey,
    })).rejects.toThrow();

    const oversizedEnvelope = await encryptBytes(
      new Uint8Array(canonicalMemoryPlaintextLimits.operationBundle + 1),
      spaceKey,
      keyVersion,
      operationAad(wire),
    );
    await expect(decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: { ...wire, operation: oversizedEnvelope },
      spaceKey,
    })).rejects.toThrow();
  });

  test("wipes owned operation plaintext on success and a later proof failure", async () => {
    const callerSpaceKey = Uint8Array.from(spaceKey);
    const expectedSpaceKey = Uint8Array.from(callerSpaceKey);
    const genesis = emptyOhHeadV1();
    const { operation } = operationFixture();
    const encryptedObservation = await observeOwnedSecretZeroization(async () =>
      await encryptCanonicalMemoryOperation({
        authority,
        encryptionKey: encryptionKey(callerSpaceKey, keyVersion),
        genesisHead: genesis,
        operation,
        priorHead: genesis,
      }));
    const encryptedPlaintext = encryptedObservation.fills.find((fill) =>
      new TextDecoder().decode(fill.before).includes(operation.operationSha256));
    expect(encryptedPlaintext).toBeDefined();
    expectFullyZeroed(encryptedPlaintext as ZeroFill);

    const decryptedObservation = await observeOwnedSecretZeroization(async () =>
      await decryptCanonicalMemoryOperation({
        authority,
        expectedGenesisHead: genesis,
        expectedPriorHead: genesis,
        operation: encryptedObservation.result,
        spaceKey: callerSpaceKey,
      }));
    expect(decryptedObservation.result.operation).toEqual(operation);
    const decryptedPlaintext = decryptedObservation.fills.find((fill) =>
      new TextDecoder().decode(fill.before).includes(operation.operationSha256));
    expect(decryptedPlaintext).toBeDefined();
    expectFullyZeroed(decryptedPlaintext as ZeroFill);

    const rejectedObservation = await observeOwnedSecretZeroization(async () => {
      try {
        await decryptCanonicalMemoryOperation({
          authority,
          expectedGenesisHead: genesis,
          expectedPriorHead: genesis,
          operation: {
            ...encryptedObservation.result,
            terminalHeadProof: flipCiphertext(encryptedObservation.result.terminalHeadProof),
          },
          spaceKey: callerSpaceKey,
        });
      } catch {
        return "rejected" as const;
      }
      return "accepted" as const;
    });
    expect(rejectedObservation.result).toBe("rejected");
    const rejectedPlaintext = rejectedObservation.fills.find((fill) =>
      new TextDecoder().decode(fill.before).includes(operation.operationSha256));
    expect(rejectedPlaintext).toBeDefined();
    expectFullyZeroed(rejectedPlaintext as ZeroFill);
    expect(callerSpaceKey).toEqual(expectedSpaceKey);
  });

  test("round-trips a strict portable adoption proof and binds it to the encrypted operation route", async () => {
    const genesis = emptyOhHeadV1();
    const { operation } = operationFixture();
    const wire = await encryptCanonicalMemoryOperation({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      genesisHead: genesis,
      operation,
      priorHead: genesis,
    });
    const proof = adoptionProofFixture(operation.operationSha256);
    expect(parseCanonicalMemoryAdoptionProofV1(proof)).toEqual(proof);
    expect(parseCanonicalMemoryAdoptionProofV1({ ...proof, extra: true })).toBeNull();
    expect(parseCanonicalMemoryAdoptionProofV1({ ...proof, recordSha256: "invalid" }))
      .toBeNull();
    expect(parseCanonicalMemoryAdoptionProofV1({ ...proof, sequence: -0 })).toBeNull();

    const encrypted = await encryptCanonicalMemoryAdoptionProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      operation: wire,
      proof,
    });
    expect(encrypted.keyVersion).toBe(keyVersion);
    expect(encrypted.ciphertext.length)
      .toBeLessThanOrEqual(canonicalMemoryCiphertextLimits.adoptionProof);
    expect(JSON.stringify(encrypted)).not.toContain(proof.recordSha256);
    expect(await decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: encrypted,
      expectedOperationSha256: operation.operationSha256,
      operation: wire,
      spaceKey,
    })).toEqual(proof);

    const adoptedWire = { ...wire, adoptionProof: encrypted };
    expect(parseCanonicalMemoryOperation(adoptedWire)).toEqual(adoptedWire);
    expect((await decryptCanonicalMemoryOperation({
      authority,
      expectedGenesisHead: genesis,
      expectedPriorHead: genesis,
      operation: adoptedWire,
      spaceKey,
    })).adoptionProof).toEqual({ proof, status: "unverified" });

    await expect(decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: encrypted,
      expectedOperationSha256: operation.operationSha256,
      operation: wire,
      spaceKey: wrongKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: flipCiphertext(encrypted),
      expectedOperationSha256: operation.operationSha256,
      operation: wire,
      spaceKey,
    })).rejects.toThrow();
    await expect(decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: encrypted,
      expectedOperationSha256: canonicalSha256("different operation"),
      operation: wire,
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ADOPTION_PROOF_INVALID");

    const otherBinding: CanonicalMemoryBinding = {
      bindingDigest: canonicalMemoryBindingDigest(otherCanonicalSpaceId),
      canonicalSpaceId: otherCanonicalSpaceId,
      hostedSpaceId,
      keyVersion,
    };
    for (const transplanted of [
      { authority: { ...authority, hostedSpaceId: otherHostedSpaceId }, operation: wire },
      { authority: otherBinding, operation: wire },
      { authority: { ...authority, keyVersion: keyVersion + 1 }, operation: {
        ...wire,
        operation: { ...wire.operation, keyVersion: keyVersion + 1 },
      } },
      { authority, operation: { ...wire, genesisToken: canonicalSha256("other genesis") } },
      { authority, operation: { ...wire, priorToken: canonicalSha256("other prior") } },
      { authority, operation: { ...wire, headToken: canonicalSha256("other head") } },
      { authority, operation: { ...wire, sequence: wire.sequence + 1 } },
      { authority, operation: { ...wire, operation: flipCiphertext(wire.operation) } },
    ]) {
      await expect(decryptCanonicalMemoryAdoptionProof({
        authority: transplanted.authority,
        envelope: encrypted,
        expectedOperationSha256: operation.operationSha256,
        operation: transplanted.operation,
        spaceKey,
      })).rejects.toThrow();
    }

    await expect(encryptCanonicalMemoryAdoptionProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      operation: wire,
      proof: { ...proof, sequence: proof.sequence + 1 },
    })).rejects.toThrow("CANONICAL_MEMORY_ADOPTION_PROOF_MISMATCH");
    await expect(encryptCanonicalMemoryAdoptionProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      operation: wire,
      proof: adoptionProofFixture(operation.operationSha256, {
        bindingDigest: otherBinding.bindingDigest,
        canonicalSpaceId: otherCanonicalSpaceId,
      }),
    })).rejects.toThrow("CANONICAL_MEMORY_ADOPTION_PROOF_MISMATCH");

    const mismatchedPayload = { ...proof, sequence: proof.sequence + 1 };
    const mismatchEnvelope = await encryptBytes(
      new TextEncoder().encode(canonicalJson(mismatchedPayload)),
      spaceKey,
      keyVersion,
      await adoptionProofAad(wire),
    );
    await expect(decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: mismatchEnvelope,
      expectedOperationSha256: operation.operationSha256,
      operation: wire,
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ADOPTION_PROOF_INVALID");

    const strictnessEnvelope = await encryptBytes(
      new TextEncoder().encode(canonicalJson({ ...proof, extra: true })),
      spaceKey,
      keyVersion,
      await adoptionProofAad(wire),
    );
    await expect(decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: strictnessEnvelope,
      expectedOperationSha256: operation.operationSha256,
      operation: wire,
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_ADOPTION_PROOF_INVALID");

    const oversizedEnvelope = await encryptBytes(
      new Uint8Array(canonicalMemoryPlaintextLimits.adoptionProof + 1),
      spaceKey,
      keyVersion,
      await adoptionProofAad(wire),
    );
    await expect(decryptCanonicalMemoryAdoptionProof({
      authority,
      envelope: oversizedEnvelope,
      expectedOperationSha256: operation.operationSha256,
      operation: wire,
      spaceKey,
    })).rejects.toThrow("CANONICAL_MEMORY_PLAINTEXT_TOO_LARGE");
  });

  test("separates optional proof failures from an otherwise valid operation", async () => {
    const genesis = emptyOhHeadV1();
    const { head, operation } = operationFixture();
    const wire = await encryptCanonicalMemoryOperation({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      genesisHead: genesis,
      operation,
      priorHead: genesis,
    });
    const proof = adoptionProofFixture(operation.operationSha256);
    const encrypted = await encryptCanonicalMemoryAdoptionProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      operation: wire,
      proof,
    });
    const mismatchedEnvelope = await encryptCanonicalMemoryAdoptionProof({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      operation: wire,
      proof: {
        ...proof,
        operationSha256: canonicalSha256("another operation"),
      },
    });

    for (const adoptionProof of [flipCiphertext(encrypted), mismatchedEnvelope]) {
      const decrypted = await decryptCanonicalMemoryOperation({
        authority,
        expectedGenesisHead: genesis,
        expectedPriorHead: genesis,
        operation: { ...wire, adoptionProof },
        spaceKey,
      });
      expect(decrypted.adoptionProof).toEqual({ status: "invalid" });
      expect(decrypted.operation).toEqual(operation);
      expect(decrypted.head).toEqual(head);
      expect(decrypted.bundle.operations).toEqual([operation]);
    }

    for (const adoptionProof of [
      { ...encrypted, nonce: "malformed" },
      {
        ...encrypted,
        ciphertext: "A".repeat(canonicalMemoryCiphertextLimits.adoptionProof + 1),
      },
    ]) {
      await expect(decryptCanonicalMemoryOperation({
        authority,
        expectedGenesisHead: genesis,
        expectedPriorHead: genesis,
        operation: { ...wire, adoptionProof },
        spaceKey,
      })).rejects.toThrow("CANONICAL_MEMORY_WIRE_OPERATION_INVALID");
    }
  });

  test("refuses a valid Oh operation above Oompa's one-row encrypted ceiling", async () => {
    const oversized = operationFixture(
      canonicalSpaceId,
      OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES + 1_024,
    ).operation;
    expect(new TextEncoder().encode(canonicalJson(oversized)).byteLength)
      .toBeGreaterThan(OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES);
    await expect(encryptCanonicalMemoryOperation({
      authority,
      encryptionKey: encryptionKey(spaceKey, keyVersion),
      genesisHead: emptyOhHeadV1(),
      operation: oversized,
      priorHead: emptyOhHeadV1(),
    })).rejects.toThrow("CANONICAL_MEMORY_OPERATION_TOO_LARGE");
  });
});
