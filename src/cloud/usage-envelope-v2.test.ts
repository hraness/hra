import { describe, expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import fc from "fast-check";

import type { EncryptedEnvelope } from "./contracts";
import {
  decodeBase64Url, decryptBytes, encodeBase64Url, gcmMessageBudgetKey,
  gcmMessageBudgetPerKey, KeyRotationRequiredError, processGcmMessageBudget,
} from "./crypto";
import { decryptUsageProjection, encryptUsageProjection } from "./payloads";
import { usageHeadAadV2 } from "./usage-context-v2";
import {
  decryptUsageHeadV2, encryptUsageHeadV2,
  USAGE_ENVELOPE_V2_CLAUDE_MAX_CIPHERTEXT_CHARACTERS,
  USAGE_ENVELOPE_V2_CODEX_MAX_CIPHERTEXT_CHARACTERS,
  USAGE_ENVELOPE_V2_MAX_CIPHERTEXT_CHARACTERS,
} from "./usage-envelope-v2";
import { parseUsageHeadV2, USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES, USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES } from "./usage-head-v2";

// Synthetic plaintext, keys and contexts only. Round trips prove encryption
// framing, not trusted context acquisition, current revision or publication.
type Provider = "codex" | "claude";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let keySequence = 0;
let nonceSequence = 0;
function key(): Uint8Array {
  const bytes = encoder.encode("synthetic usage envelope key0000");
  new DataView(bytes.buffer).setUint32(28, ++keySequence);
  return bytes;
}
const missing = (reason: string) => ({ state: "unavailable", reason });
const context = (provider: Provider = "codex") => ({
  apiOrigin: "https://example.com", userPublicId: "user_12345678", sourceDevicePublicId: "device_12345678",
  provider, sourcePublicId: `usrc2_${"a".repeat(64)}`, sourceRevision: 1, keyVersion: 1,
});
function head(provider: Provider = "codex") {
  const expected = context(provider);
  return {
    version: 2, userPublicId: expected.userPublicId, sourceDevicePublicId: expected.sourceDevicePublicId,
    provider, sourcePublicId: expected.sourcePublicId, sourceRevision: expected.sourceRevision, keyVersion: expected.keyVersion,
    codexAccountMatchPublicId: null,
    order: { state: "cached", orderRevision: 1, pointerRevision: 1, orderPosition: 1, accountCount: 1, active: true },
    components: { provider, quota: missing("not_observed"), accounting: missing(provider === "codex" ? "not_projected" : "not_observed"),
      readiness: { state: "cached", value: "signed_in", observedAt: null },
      automaticPolicy: { state: "configured", revision: 1, defaultEnabled: true, override: "inherit" } },
    display: { provider, reset: provider === "codex" ? { state: "cached",
      currentIdentity: { state: "known", policy: { state: "active" }, lastAttempt: null }, pending: { state: "none" } }
      : missing("provider_unsupported"), nextAction: missing("runtime_not_integrated") },
  };
}
function rawEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected); }
function reverseKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(reverseKeys);
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).reverse().map(([name, value]) => [name, reverseKeys(value)]));
  }
  return input;
}
function expectFrozen(input: unknown): void {
  if (input !== null && typeof input === "object") {
    expect(Object.isFrozen(input)).toBe(true);
    for (const value of Object.values(input)) expectFrozen(value);
  }
}
async function refusal(promise: Promise<unknown>, operation: "encryption" | "decryption"): Promise<void> {
  const error: unknown = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected a closed failure");
  expect(error.message).toBe(`Usage head ${operation} failed.`);
  expect(error.cause).toBeUndefined();
}
// Independently spell the agreed tuple, rather than deriving the expected AAD
// from the wrapper or its helper. Native URL canonicalization is intentional.
function expectedAad(expected: ReturnType<typeof context>): Uint8Array {
  return encoder.encode(JSON.stringify(["hra-control-plane-usage-head:v2", new URL(expected.apiOrigin).origin,
    expected.userPublicId, expected.sourceDevicePublicId, expected.provider, expected.sourcePublicId,
    expected.sourceRevision, expected.keyVersion]));
}
// Direct WebCrypto creates authenticated negative fixtures without the codec
// under test or any admission bypass. Deterministic nonces are unique within
// this test process and used only with synthetic keys; production stays random.
async function sealRaw(bytes: Uint8Array, accountKey: Uint8Array, expected: ReturnType<typeof context>, aad = expectedAad(expected)): Promise<EncryptedEnvelope> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(8, ++nonceSequence);
  const imported = await crypto.subtle.importKey("raw", Uint8Array.from(accountKey).buffer, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce.buffer,
    additionalData: Uint8Array.from(aad).buffer, tagLength: 128 }, imported, Uint8Array.from(bytes).buffer);
  return { algorithm: "A256GCM", ciphertext: encodeBase64Url(new Uint8Array(ciphertext)), keyVersion: expected.keyVersion, nonce: encodeBase64Url(nonce) };
}

describe("usage envelope v2 encrypted boundary", () => {
  test("both providers encrypt only canonical parsed plaintext with exact independent AAD and frozen results", async () => {
    for (const provider of ["codex", "claude"] as const) {
      const accountKey = key();
      const input = head(provider);
      const expected = context(provider);
      const candidate = reverseKeys(input);
      const encrypted = await encryptUsageHeadV2(candidate, accountKey, reverseKeys(expected));
      expect(Object.keys(encrypted)).toEqual(["algorithm", "ciphertext", "keyVersion", "nonce"]);
      expect(Object.isFrozen(encrypted)).toBe(true);
      expect(Object.isFrozen(candidate)).toBe(false);
      expect(decodeBase64Url(encrypted.nonce)).toHaveLength(12);
      expect(encodeBase64Url(decodeBase64Url(encrypted.ciphertext))).toBe(encrypted.ciphertext);
      expect(usageHeadAadV2(expected)).toEqual(expectedAad(expected));
      const plaintext = await decryptBytes(encrypted, accountKey, expectedAad(expected));
      expect(decoder.decode(plaintext)).toBe(JSON.stringify(input));
      const mutableEnvelope = { ...encrypted };
      const decoded = await decryptUsageHeadV2(mutableEnvelope, accountKey, expected);
      rawEqual(decoded, input);
      expectFrozen(decoded);
      expect(Object.isFrozen(mutableEnvelope)).toBe(false);
      expect(decoded).not.toBe(input);
      expect(decoded.components).not.toBe(input.components);
      rawEqual(await decryptUsageHeadV2(encrypted, accountKey, { ...expected, apiOrigin: "HTTPS://EXAMPLE.COM:443/" }), input);
    }
  });

  test("authenticates every AAD field independently of plaintext context validation", async () => {
    const accountKey = key();
    const original = context();
    const encrypted = await encryptUsageHeadV2(head(), accountKey, original);
    const contexts = [
      { ...original, apiOrigin: "https://other.example.com" }, { ...original, userPublicId: "user_changed" },
      { ...original, sourceDevicePublicId: "device_changed" }, { ...context("claude") },
      { ...original, sourcePublicId: `usrc2_${"b".repeat(64)}` }, { ...original, sourceRevision: 2 }, { ...original, keyVersion: 2 },
    ];
    for (const expected of contexts) {
      await refusal(decryptUsageHeadV2(encrypted, accountKey, expected), "decryption");
      const matchingHead = { ...head(expected.provider), userPublicId: expected.userPublicId,
        sourceDevicePublicId: expected.sourceDevicePublicId, sourcePublicId: expected.sourcePublicId,
        sourceRevision: expected.sourceRevision, keyVersion: expected.keyVersion };
      expect(parseUsageHeadV2(matchingHead, expected)).not.toBeNull();
      // The body and envelope header match the new context. Only old AAD is
      // wrong, so refusal cannot be attributed to a plaintext field mismatch.
      const wrongAad = await sealRaw(encoder.encode(JSON.stringify(matchingHead)), accountKey, expected, expectedAad(original));
      await refusal(decryptUsageHeadV2(wrongAad, accountKey, expected), "decryption");
    }
    await refusal(decryptUsageHeadV2(encrypted, key(), original), "decryption");
    const altered = decodeBase64Url(encrypted.ciphertext); altered[0] = (altered[0] ?? 0) ^ 1;
    await refusal(decryptUsageHeadV2({ ...encrypted, ciphertext: encodeBase64Url(altered) }, accountKey, original), "decryption");
    const nonce = decodeBase64Url(encrypted.nonce); nonce[0] = (nonce[0] ?? 0) ^ 1;
    await refusal(decryptUsageHeadV2({ ...encrypted, nonce: encodeBase64Url(nonce) }, accountKey, original), "decryption");
  });

  test("authenticated plaintext must be UTF-8, JSON and an exact matching V2 head, never a V1 fallback", async () => {
    const accountKey = key();
    const expected = context();
    const badBodies = [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xed, 0xa0, 0x80]),
      new Uint8Array([0xe2, 0x82]), encoder.encode("not JSON"), encoder.encode("{"), encoder.encode("null"),
      encoder.encode(JSON.stringify({ state: "unavailable" })),
      encoder.encode(JSON.stringify({ ...head(), sourceRevision: 2 })),
      encoder.encode(JSON.stringify({ ...head(), private: "unpublished" })),
      encoder.encode(JSON.stringify({ ...head(), components: { ...head().components, provider: "claude" } })),
    ];
    for (const bytes of badBodies) {
      const envelope = await sealRaw(bytes, accountKey, expected);
      expect(await decryptBytes(envelope, accountKey, expectedAad(expected))).toEqual(bytes);
      await refusal(decryptUsageHeadV2(envelope, accountKey, expected), "decryption");
    }
    const v1Authority = { kind: "usage" as const, entityPublicId: "account_12345678", keyVersion: 1, userPublicId: expected.userPublicId };
    const v1 = await encryptUsageProjection({ state: "unavailable" }, accountKey, v1Authority);
    expect(await decryptUsageProjection(v1, accountKey, v1Authority)).toEqual({ state: "unavailable" });
    await refusal(decryptUsageHeadV2(v1, accountKey, expected), "decryption");
  });

  test("fatal UTF-8 rejects authenticated bytes that permissive decoding would turn into an accepted head", async () => {
    const accountKey = key(); const expected = context();
    const prefix = encoder.encode('{"version":"');
    const suffix = encoder.encode(`",${JSON.stringify(head()).slice(1)}`);
    // JSON.parse intentionally keeps the final version:2. The earlier string
    // is discarded in both controls; this tests UTF-8, not duplicate-key policy.
    const malformed = new Uint8Array([...prefix, 0xff, ...suffix]);
    const control = new Uint8Array([...prefix, ...encoder.encode("valid é"), ...suffix]);
    const permissive = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(malformed)) as unknown;
    rawEqual(parseUsageHeadV2(permissive, expected), head());
    const controlEnvelope = await sealRaw(control, accountKey, expected);
    expect(await decryptBytes(controlEnvelope, accountKey, expectedAad(expected))).toEqual(control);
    rawEqual(await decryptUsageHeadV2(controlEnvelope, accountKey, expected), head());
    const malformedEnvelope = await sealRaw(malformed, accountKey, expected);
    expect(await decryptBytes(malformedEnvelope, accountKey, expectedAad(expected))).toEqual(malformed);
    await refusal(decryptUsageHeadV2(malformedEnvelope, accountKey, expected), "decryption");
  });

  test("requires exact envelope fields, matching versions and fixed nonce/tag sizes", async () => {
    const accountKey = key(); const expected = context();
    const envelope = await encryptUsageHeadV2(head(), accountKey, expected);
    for (const field of Object.keys(envelope)) {
      await refusal(decryptUsageHeadV2(Object.fromEntries(Object.entries(envelope).filter(([name]) => name !== field)), accountKey, expected), "decryption");
    }
    for (const input of [{ ...envelope, extra: true }, { ...envelope, extra: undefined }, { ...envelope, algorithm: "AES-GCM" },
      ...[0, -1, 1.5, 2, Number.MAX_SAFE_INTEGER + 1, "1", null].map((keyVersion) => ({ ...envelope, keyVersion })),
      ...[11, 13].map((length) => ({ ...envelope, nonce: encodeBase64Url(new Uint8Array(length)) })),
      { ...envelope, ciphertext: encodeBase64Url(new Uint8Array(15)) },
      { ...envelope, ciphertext: "A".repeat(25) }, { ...envelope, nonce: "A".repeat(17) },
      { ...envelope, nonce: `${envelope.nonce}=` }, { ...envelope, ciphertext: `${envelope.ciphertext}=` },
    ]) await refusal(decryptUsageHeadV2(input, accountKey, expected), "decryption");
    const empty = await sealRaw(new Uint8Array(0), accountKey, expected);
    expect(decodeBase64Url(empty.ciphertext)).toHaveLength(16);
    await refusal(decryptUsageHeadV2(empty, accountKey, expected), "decryption");
  });

  test("refuses alternate base64url pad bits even when decoded ciphertext and authentication are unchanged", async () => {
    const accountKey = key(); const expected = context();
    const plain = JSON.stringify(head());
    for (const remainder of [1, 2]) {
      const padding = (3 - ((encoder.encode(plain).byteLength + 16) % 3) + remainder) % 3;
      const bytes = encoder.encode(plain + " ".repeat(padding));
      const envelope = await sealRaw(bytes, accountKey, expected);
      expect(decodeBase64Url(envelope.ciphertext).byteLength % 3).toBe(remainder);
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = envelope.ciphertext.at(-1) as string;
      const alternate = envelope.ciphertext.slice(0, -1) + alphabet.charAt(alphabet.indexOf(last) | 1);
      expect(alternate).not.toBe(envelope.ciphertext);
      expect(decodeBase64Url(alternate)).toEqual(decodeBase64Url(envelope.ciphertext));
      expect(encodeBase64Url(decodeBase64Url(alternate))).toBe(envelope.ciphertext);
      expect(await decryptBytes({ ...envelope, ciphertext: alternate }, accountKey, expectedAad(expected))).toEqual(bytes);
      rawEqual(await decryptUsageHeadV2(envelope, accountKey, expected), head());
      await refusal(decryptUsageHeadV2({ ...envelope, ciphertext: alternate }, accountKey, expected), "decryption");
    }
  });

  test("enforces exact provider raw-plaintext and ciphertext boundaries without claiming an over-bound guard ran after decryption", async () => {
    expect(USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES).toBe(69_961);
    expect(USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES).toBe(19_477);
    expect(USAGE_ENVELOPE_V2_CODEX_MAX_CIPHERTEXT_CHARACTERS).toBe(93_303);
    expect(USAGE_ENVELOPE_V2_CLAUDE_MAX_CIPHERTEXT_CHARACTERS).toBe(25_991);
    expect(USAGE_ENVELOPE_V2_MAX_CIPHERTEXT_CHARACTERS).toBe(93_303);
    for (const provider of ["codex", "claude"] as const) {
      const expected = context(provider); const accountKey = key();
      const maximum = provider === "codex" ? 69_961 : 19_477;
      const ciphertextMaximum = provider === "codex" ? 93_303 : 25_991;
      expect(Math.ceil(4 * (maximum + 16) / 3)).toBe(ciphertextMaximum);
      const json = JSON.stringify(head(provider));
      for (const length of [maximum - 1, maximum, maximum + 1]) {
        const bytes = encoder.encode(json + " ".repeat(length - encoder.encode(json).byteLength));
        expect(bytes.byteLength).toBe(length);
        const envelope = await sealRaw(bytes, accountKey, expected);
        expect(await decryptBytes(envelope, accountKey, expectedAad(expected))).toEqual(bytes);
        if (length <= maximum) {
          expect(envelope.ciphertext.length).toBeLessThanOrEqual(ciphertextMaximum);
          rawEqual(await decryptUsageHeadV2(envelope, accountKey, expected), head(provider));
        } else {
          // For both chosen P values, P+1 necessarily exceeds the textual
          // ciphertext cap too. Refusal does not isolate the post-AES guard.
          expect(envelope.ciphertext.length).toBe(ciphertextMaximum + 1);
          await refusal(decryptUsageHeadV2(envelope, accountKey, expected), "decryption");
        }
      }
    }
  });

  test("copies keys before context traps and snapshots context before head/envelope inspection", async () => {
    const originalKey = key(); const mutableKey = originalKey.slice();
    const expected = new Proxy(context(), { ownKeys(target) { mutableKey.fill(255); return Reflect.ownKeys(target); } });
    const encrypted = await encryptUsageHeadV2(head(), mutableKey, expected);
    rawEqual(await decryptUsageHeadV2(encrypted, originalKey, context()), head());
    const decryptKey = originalKey.slice();
    const decryptContext = new Proxy(context(), { ownKeys(target) { decryptKey.fill(255); return Reflect.ownKeys(target); } });
    rawEqual(await decryptUsageHeadV2(encrypted, decryptKey, decryptContext), head());

    let payloadReads = 0;
    const unreadHead = new Proxy(head(), { ownKeys(target) { payloadReads += 1; return Reflect.ownKeys(target); } });
    const unreadEnvelope = new Proxy(encrypted, { ownKeys(target) { payloadReads += 1; return Reflect.ownKeys(target); } });
    await refusal(encryptUsageHeadV2(unreadHead, originalKey, {}), "encryption");
    await refusal(decryptUsageHeadV2(unreadEnvelope, originalKey, {}), "decryption");
    expect(payloadReads).toBe(0);

    const retainedContext = context();
    const mutatingHead = new Proxy(head(), { ownKeys(target) { retainedContext.sourceRevision = 2; return Reflect.ownKeys(target); } });
    const retained = await encryptUsageHeadV2(mutatingHead, originalKey, retainedContext);
    rawEqual(await decryptUsageHeadV2(retained, originalKey, context()), head());
    const retainedDecryptContext = context();
    const mutatingEnvelope = new Proxy({ ...retained }, { ownKeys(target) { retainedDecryptContext.sourceRevision = 2; return Reflect.ownKeys(target); } });
    rawEqual(await decryptUsageHeadV2(mutatingEnvelope, originalKey, retainedDecryptContext), head());

    const laterHead = head(); const beforeHead = new Proxy({ ...context(), sourceRevision: 2 }, {
      ownKeys(target) { laterHead.sourceRevision = 2; return Reflect.ownKeys(target); },
    });
    const later = await encryptUsageHeadV2(laterHead, originalKey, beforeHead);
    expect((await decryptUsageHeadV2(later, originalKey, { ...context(), sourceRevision: 2 })).sourceRevision).toBe(2);
  });

  test("retains owned keys, head, envelope and AAD across both asynchronous boundaries", async () => {
    const originalKey = key(); const mutableKey = originalKey.slice();
    const input = head(); const expected = context();
    const pending = encryptUsageHeadV2(input, mutableKey, expected);
    mutableKey.fill(0); input.sourceRevision = 99; input.components.readiness.value = "signed_out";
    expected.apiOrigin = "https://changed.example.com"; expected.sourceRevision = 99;
    const envelope = await pending;
    rawEqual(await decryptUsageHeadV2(envelope, originalKey, context()), head());
    const envelopeInput = { ...envelope }; const decryptKey = originalKey.slice(); const decryptContext = context();
    const decrypting = decryptUsageHeadV2(envelopeInput, decryptKey, decryptContext);
    envelopeInput.ciphertext = "invalid"; envelopeInput.nonce = "invalid"; decryptKey.fill(0); decryptContext.keyVersion = 9;
    rawEqual(await decrypting, head());
    expect(Object.isFrozen(input)).toBe(false); expect(Object.isFrozen(envelopeInput)).toBe(false);
  });

  test("accepts exact offset views, Buffers, genuine cross-realm keys and subclasses without invoking key hooks", async () => {
    const originalKey = key();
    const backing = new Uint8Array(80).fill(255); backing.set(originalKey, 17);
    let hooks = 0;
    class HostileKey extends Uint8Array {}
    Object.defineProperty(HostileKey, Symbol.species, { get() { hooks += 1; throw new Error("private species"); } });
    const hostile = new HostileKey(originalKey);
    for (const property of ["buffer", "byteLength", "byteOffset", "length", "constructor", "set", Symbol.iterator, Symbol.toStringTag]) {
      Object.defineProperty(hostile, property, { get() { hooks += 1; throw new Error("private key getter"); } });
    }
    const crossRealm: unknown = runInNewContext("Uint8Array.from(bytes)", { bytes: Array.from(originalKey) }, { timeout: 1_000 });
    expect(crossRealm).not.toBeInstanceOf(Uint8Array);
    for (const accountKey of [backing.subarray(17, 49), Buffer.from(originalKey), hostile, crossRealm as Uint8Array]) {
      const encrypted = await encryptUsageHeadV2(head(), accountKey, context());
      rawEqual(await decryptUsageHeadV2(encrypted, originalKey, context()), head());
      rawEqual(await decryptUsageHeadV2(encrypted, accountKey, context()), head());
    }
    expect(hooks).toBe(0);
  });

  test("rejects shared, detached, proxy, wrong-kind and wrong-length keys before reading context", async () => {
    const originalKey = key(); const envelope = await encryptUsageHeadV2(head(), originalKey, context());
    const detached = key(); structuredClone(detached.buffer, { transfer: [detached.buffer] });
    let hooks = 0; let contextReads = 0;
    const proxy = new Proxy(originalKey, { get() { hooks += 1; throw new Error("private proxy"); } });
    const expected = new Proxy(context(), { ownKeys(target) { contextReads += 1; return Reflect.ownKeys(target); } });
    for (const value of [new Uint8Array(31), new Uint8Array(33), new Uint16Array(16), new Int8Array(32),
      new DataView(new ArrayBuffer(32)), new ArrayBuffer(32), new Uint8Array(new SharedArrayBuffer(32)), detached, proxy, {}, null]) {
      await refusal(encryptUsageHeadV2(head(), value as Uint8Array, expected), "encryption");
      await refusal(decryptUsageHeadV2(envelope, value as Uint8Array, expected), "decryption");
    }
    expect(hooks).toBe(0); expect(contextReads).toBe(0);
  });

  test("invalid foreign input is inert, closed and getter-free for encryption and decryption", async () => {
    const accountKey = key(); const budgetKey = await gcmMessageBudgetKey(accountKey, 1);
    const before = processGcmMessageBudget.observe(budgetKey);
    let getters = 0;
    const accessor = head(); Object.defineProperty(accessor, "components", { enumerable: true, get() { getters += 1; throw new Error("private head"); } });
    const contextAccessor = context(); Object.defineProperty(contextAccessor, "sourceRevision", { enumerable: true, get() { getters += 1; throw new Error("private context"); } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const sparse: unknown[] = []; sparse.length = 1;
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const input of [undefined, null, true, "private", 1n, Symbol("private"), () => 1, [], sparse, new Date(), new Map(),
      accessor, cycle, revoked.proxy, { ...head(), private: "hidden" },
      new Proxy({}, { ownKeys() { throw new Error("private trap"); } }),
      { toJSON() { getters += 1; throw new Error("private coercion"); } },
    ]) {
      await refusal(encryptUsageHeadV2(input, accountKey, context()), "encryption");
      await refusal(decryptUsageHeadV2(input, accountKey, context()), "decryption");
    }
    await refusal(encryptUsageHeadV2(head(), accountKey, contextAccessor), "encryption");
    await refusal(decryptUsageHeadV2({}, accountKey, contextAccessor), "decryption");
    expect(getters).toBe(0);
    expect(processGcmMessageBudget.observe(budgetKey)).toBe(before);
  });

  test("V1 and every V2 source share the real process key-version budget and preserve its actual rotation error", async () => {
    const accountKey = key(); const expected = context();
    const budgetKey = await gcmMessageBudgetKey(accountKey, 1);
    expect(processGcmMessageBudget.restore(budgetKey, gcmMessageBudgetPerKey - 2)).toBe(gcmMessageBudgetPerKey - 2);
    await refusal(encryptUsageHeadV2({ ...head(), private: true }, accountKey, expected), "encryption");
    expect(processGcmMessageBudget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey - 2);
    await encryptUsageProjection({ state: "unavailable" }, accountKey, {
      entityPublicId: "account_12345678", keyVersion: 1, kind: "usage", userPublicId: expected.userPublicId,
    });
    expect(processGcmMessageBudget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey - 1);
    const last = await encryptUsageHeadV2(head(), accountKey, expected);
    expect(processGcmMessageBudget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey);
    rawEqual(await decryptUsageHeadV2(last, accountKey, expected), head());
    expect(processGcmMessageBudget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey);
    let actualBudgetError: unknown;
    const realConsume = processGcmMessageBudget.consume.bind(processGcmMessageBudget);
    const observed = spyOn(processGcmMessageBudget, "consume").mockImplementation((input) => {
      try { return realConsume(input); } catch (error: unknown) { actualBudgetError = error; throw error; }
    });
    try {
      for (const changed of [expected, { ...expected, apiOrigin: "https://other.example.com" },
        { ...expected, sourcePublicId: `usrc2_${"b".repeat(64)}` }, context("claude")]) {
        const input = { ...head(changed.provider), sourcePublicId: changed.sourcePublicId };
        const error: unknown = await encryptUsageHeadV2(input, accountKey, changed).then(() => null, (cause: unknown) => cause);
        expect(error).toBe(actualBudgetError);
        expect(error).toBeInstanceOf(KeyRotationRequiredError);
        expect(error).toMatchObject({ code: "KEY_ROTATION_REQUIRED", keyVersion: 1 });
        expect(processGcmMessageBudget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey);
      }
    } finally { observed.mockRestore(); }
  });

  test("seeded round trips retain canonical owned inputs across immediate caller mutation", async () => {
    const arbitrary = fc.record({ provider: fc.constantFrom<Provider>("codex", "claude"),
      revision: fc.integer({ min: 1, max: 1_000_000 }), keyVersion: fc.integer({ min: 1, max: 1_000_000 }),
      suffix: fc.nat(1_000_000), enabled: fc.boolean() });
    await fc.assert(fc.asyncProperty(arbitrary, async (generated) => {
      const expected = { ...context(generated.provider), sourceRevision: generated.revision, keyVersion: generated.keyVersion,
        userPublicId: `user_${generated.suffix.toString().padStart(8, "0")}` };
      const input = { ...head(generated.provider), sourceRevision: expected.sourceRevision, keyVersion: expected.keyVersion, userPublicId: expected.userPublicId };
      input.components.automaticPolicy.defaultEnabled = generated.enabled;
      const accountKey = key(); const mutableKey = accountKey.slice();
      const candidate = reverseKeys(input) as Record<string, unknown>; const mutableContext = { ...expected };
      const encrypting = encryptUsageHeadV2(candidate, mutableKey, mutableContext);
      mutableKey.fill(0); candidate.sourceRevision = 0; mutableContext.sourceRevision = 0;
      const encrypted = await encrypting;
      const ownedPlain = await decryptBytes(encrypted, accountKey, expectedAad(expected));
      expect(decoder.decode(ownedPlain)).toBe(JSON.stringify(input));
      const envelope = { ...encrypted }; const decodingKey = accountKey.slice(); const decodeContext = { ...expected };
      const decrypting = decryptUsageHeadV2(envelope, decodingKey, decodeContext);
      envelope.ciphertext = "invalid"; decodingKey.fill(0); decodeContext.apiOrigin = "https://changed.example.com";
      const parsed = await decrypting;
      rawEqual(parsed, input); expectFrozen(parsed);
      expect(Object.isFrozen(candidate)).toBe(false); expect(Object.isFrozen(envelope)).toBe(false);
    }), { numRuns: 100, seed: 68_401 });
  });

  test("seeded foreign values preserve total closed async boundaries without assuming arbitrary JSON is invalid", async () => {
    const foreign = fc.oneof(fc.jsonValue({ maxDepth: 3 }), fc.constant(undefined), fc.constant(NaN), fc.bigInt());
    const accountKey = key();
    await fc.assert(fc.asyncProperty(foreign, async (input) => {
      const accepted = parseUsageHeadV2(input, context());
      if (accepted === null) await refusal(encryptUsageHeadV2(input, accountKey, context()), "encryption");
      else rawEqual(await decryptUsageHeadV2(await encryptUsageHeadV2(input, accountKey, context()), accountKey, context()), accepted);
      const result: unknown = await decryptUsageHeadV2(input, accountKey, context()).then((value) => value, (error: unknown) => error);
      if (result instanceof Error) {
        expect(result.message).toBe("Usage head decryption failed."); expect(result.cause).toBeUndefined();
      } else { expect(parseUsageHeadV2(result, context())).not.toBeNull(); expectFrozen(result); }
    }), { numRuns: 100, seed: 68_402 });
  });

  test("bundles the encryption graph for browsers in memory without native custody or execution code", async () => {
    const build = await Bun.build({ entrypoints: [`${import.meta.dir}/usage-envelope-v2.ts`], target: "browser" });
    expect(build.success).toBe(true); expect(build.logs).toEqual([]); expect(build.outputs).toHaveLength(1);
    const output = await build.outputs[0]?.text();
    expect(output).toContain("encryptUsageHeadV2"); expect(output).toContain("decryptUsageHeadV2");
    expect(output).not.toMatch(/(?:node:|bun:sqlite|StateStore|randomUUID|createHash)/u);
  });
});
