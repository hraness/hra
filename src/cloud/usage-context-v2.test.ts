import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import fc from "fast-check";

import { hmacSha256Hex } from "./crypto";
import {
  deriveUsageSourcePublicIdV2,
  parseUsageHeadContextV2,
  usageHeadAadV2,
  USAGE_CONTEXT_V2_MAX_ORIGIN_BYTES,
} from "./usage-context-v2";

// Synthetic identities and byte keys, not enrolled-device or provider proofs.
// Literal SHA-256 HMAC oracles were independently captured with Node createHmac
// over the existing primitive's purpose prefix and the explicit tuples below.
const codexDigest = "1f1fe58a9b08223f24d8970137020f47ecd965a42913295e604763c502e84a43";
const claudeDigest = "8a70a0ad77e4b9d79e92b9e20c834788c70255093c6768fcfa3bab7c146c83c5";
const codexTuple = '[2,"https://example.com","user_12345678","device_12345678","codex","acct_11111111111111111111111111111111",3]';
const claudeTuple = '[2,"https://example.com","user_12345678","device_12345678","claude","pact_22222222222222222222222222222222",3]';
const key = () => Uint8Array.from({ length: 32 }, (_, index) => index);
const source = () => ({
  apiOrigin: "https://example.com", userPublicId: "user_12345678",
  sourceDevicePublicId: "device_12345678", provider: "codex",
  localProviderAccountId: `acct_${"1".repeat(32)}`, keyVersion: 3,
});
const head = () => ({
  apiOrigin: "https://example.com", userPublicId: "user_12345678",
  sourceDevicePublicId: "device_12345678", provider: "codex",
  sourcePublicId: `usrc2_${codexDigest}`, sourceRevision: 7, keyVersion: 3,
});
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
const reverseKeys = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).reverse());
const expectRawEqual = (actual: unknown, expected: unknown): void => { expect(actual).toEqual(expected); };

async function expectInvalidSource(input: unknown, accountKey: Uint8Array = key()): Promise<void> {
  const error: unknown = await deriveUsageSourcePublicIdV2(accountKey, input).then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected source refusal");
  expect(error.message).toBe("Invalid usage source identity input.");
  expect(error.cause).toBeUndefined();
}

function expectInvalidHead(input: unknown): void {
  expect(parseUsageHeadContextV2(input)).toBeNull();
  let error: unknown;
  try { usageHeadAadV2(input); } catch (caught: unknown) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected context refusal");
  expect(error.message).toBe("Invalid usage head context.");
  expect(error.cause).toBeUndefined();
}

describe("usage v2 context and source identity", () => {
  test("pins independent literal HMAC and exact public AAD framing", async () => {
    expect(await hmacSha256Hex(key(), "usage-head-source", codexTuple)).toBe(codexDigest);
    expect(await hmacSha256Hex(key(), "usage-head-source", claudeTuple)).toBe(claudeDigest);
    expect(await deriveUsageSourcePublicIdV2(key(), source())).toBe(`usrc2_${codexDigest}`);
    expect(await deriveUsageSourcePublicIdV2(key(), {
      ...source(), provider: "claude", localProviderAccountId: `pact_${"2".repeat(32)}`,
    })).toBe(`usrc2_${claudeDigest}`);
    const expected = '["hra-control-plane-usage-head:v2","https://example.com","user_12345678","device_12345678","codex","usrc2_1f1fe58a9b08223f24d8970137020f47ecd965a42913295e604763c502e84a43",7,3]';
    expect(usageHeadAadV2(head())).toEqual(new TextEncoder().encode(expected));
    expect(new TextDecoder().decode(usageHeadAadV2(head()))).not.toContain(source().localProviderAccountId);
    expect(new TextDecoder().decode(usageHeadAadV2(head()))).not.toContain("localProviderAccountId");
    expect(await hmacSha256Hex(key(), "codex-account-match", codexTuple)).not.toBe(codexDigest);
    expect(await hmacSha256Hex(key(), "usage-head-source", claudeTuple)).not.toBe(codexDigest);
  });

  test("separates every private source field and every public AAD field", async () => {
    for (const change of [
      { apiOrigin: "https://other.example.com" }, { userPublicId: "user_87654321" },
      { sourceDevicePublicId: "device_87654321" }, { localProviderAccountId: `acct_${"2".repeat(32)}` },
      { provider: "claude", localProviderAccountId: `pact_${"1".repeat(32)}` }, { keyVersion: 4 },
    ]) expect(await deriveUsageSourcePublicIdV2(key(), { ...source(), ...change })).not.toBe(`usrc2_${codexDigest}`);
    const changedKey = key();
    changedKey[0] = 255;
    expect(await deriveUsageSourcePublicIdV2(changedKey, source())).not.toBe(`usrc2_${codexDigest}`);
    const originalAad = new TextDecoder().decode(usageHeadAadV2(head()));
    for (const change of [
      { apiOrigin: "https://other.example.com" }, { userPublicId: "user_87654321" },
      { sourceDevicePublicId: "device_87654321" }, { provider: "claude" },
      { sourcePublicId: `usrc2_${claudeDigest}` }, { sourceRevision: 8 }, { keyVersion: 4 },
    ]) expect(new TextDecoder().decode(usageHeadAadV2({ ...head(), ...change }))).not.toBe(originalAad);
  });

  test("canonicalizes equivalent HTTPS and existing normalized local HTTP origins", async () => {
    for (const apiOrigin of ["https://example.com", "HTTPS://EXAMPLE.COM:443/", " https://example.com/\n", "https:example.com", "https://example.com/?#"]) {
      expectRawEqual(parseUsageHeadContextV2({ ...head(), apiOrigin }), head());
      expect(usageHeadAadV2({ ...head(), apiOrigin })).toEqual(usageHeadAadV2(head()));
      expect(await deriveUsageSourcePublicIdV2(key(), { ...source(), apiOrigin })).toBe(`usrc2_${codexDigest}`);
    }
    for (const [apiOrigin, canonical] of [
      ["http://LOCALHOST:80/", "http://localhost"],
      ["http://127.1/", "http://127.0.0.1"],
      ["http://[0:0:0:0:0:0:0:1]/", "http://[::1]"],
      ["http://localhost:8080/", "http://localhost:8080"],
      ["https://é.example/", "https://xn--9ca.example"],
    ]) {
      expect(parseUsageHeadContextV2({ ...head(), apiOrigin })?.apiOrigin).toBe(canonical);
      expect(await deriveUsageSourcePublicIdV2(key(), { ...source(), apiOrigin }))
        .toBe(await deriveUsageSourcePublicIdV2(key(), { ...source(), apiOrigin: canonical }));
    }
    for (const apiOrigin of ["http://example.com", "http://localhost.example", "http://127.0.0.2", "http://[::2]",
      "ftp://example.com", "https://user:private@example.com", "https://example.com/path",
      "https://example.com/?query=private", "https://example.com/#private", "not-an-origin", null, 12]) {
      expectInvalidHead({ ...head(), apiOrigin });
      await expectInvalidSource({ ...source(), apiOrigin });
    }
  });

  test("proves pre and post normalization UTF-8 bounds with native URL behavior", async () => {
    expect(USAGE_CONTEXT_V2_MAX_ORIGIN_BYTES).toBe(4_096);
    const boundary = `https://${"a".repeat(4_088)}`;
    const over = `${boundary}a`;
    const contraction = `${boundary}/`;
    const expandsToBoundary = `https:${"a".repeat(4_088)}`;
    const expandsPastBoundary = `https:${"a".repeat(4_089)}`;
    const multibyteBoundary = `https://${"Ａ".repeat(1_359)}${"a".repeat(11)}`;
    const multibyteOver = `https://${"Ａ".repeat(1_360)}${"a".repeat(9)}`;
    for (const [input, raw, canonical, accepted] of [
      [boundary, 4_096, 4_096, true], [over, 4_097, 4_097, false],
      [contraction, 4_097, 4_096, false],
      [expandsToBoundary, 4_094, 4_096, true], [expandsPastBoundary, 4_095, 4_097, false],
      [multibyteBoundary, 4_096, 1_378, true], [multibyteOver, 4_097, 1_377, false],
      ["https://é.example", 18, 23, true],
    ] as const) {
      expect(utf8(input)).toBe(raw);
      expect(utf8(new URL(input).origin)).toBe(canonical);
      const candidate = { ...head(), apiOrigin: input };
      if (accepted) {
        expect(parseUsageHeadContextV2(candidate)?.apiOrigin).toBe(new URL(input).origin);
        expect(await deriveUsageSourcePublicIdV2(key(), { ...source(), apiOrigin: input })).toMatch(/^usrc2_[0-9a-f]{64}$/u);
      } else {
        expectInvalidHead(candidate);
        await expectInvalidSource({ ...source(), apiOrigin: input });
      }
    }
  });

  test("enforces exact public/private fields, provider grammars and safe positive counters", async () => {
    for (const name of ["apiOrigin", "userPublicId", "sourceDevicePublicId", "provider", "sourcePublicId", "sourceRevision", "keyVersion"]) {
      const missing = Object.fromEntries(Object.entries(head()).filter(([key]) => key !== name));
      expectInvalidHead(missing);
      expectInvalidHead({ ...head(), [name]: undefined });
    }
    for (const name of ["apiOrigin", "userPublicId", "sourceDevicePublicId", "provider", "localProviderAccountId", "keyVersion"]) {
      const missing = Object.fromEntries(Object.entries(source()).filter(([key]) => key !== name));
      await expectInvalidSource(missing);
      await expectInvalidSource({ ...source(), [name]: undefined });
    }
    for (const field of ["localProviderAccountId", "email", "accountKey", "sourceGeneration", "authority", "payload"]) {
      expectInvalidHead({ ...head(), [field]: "private" });
    }
    for (const field of ["sourcePublicId", "sourceRevision", "email", "label", "processGeneration", "active"]) {
      await expectInvalidSource({ ...source(), [field]: "private" });
    }
    for (const name of ["sourceRevision", "keyVersion"]) for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
      expectInvalidHead({ ...head(), [name]: value });
      if (name === "keyVersion") await expectInvalidSource({ ...source(), [name]: value });
    }
    expect(parseUsageHeadContextV2({ ...head(), sourceRevision: Number.MAX_SAFE_INTEGER, keyVersion: Number.MAX_SAFE_INTEGER })).not.toBeNull();
    expect(await deriveUsageSourcePublicIdV2(key(), { ...source(), keyVersion: Number.MAX_SAFE_INTEGER })).toMatch(/^usrc2_[0-9a-f]{64}$/u);
    for (const name of ["userPublicId", "sourceDevicePublicId"]) {
      for (const value of ["a".repeat(8), "a".repeat(96), "a_b-c123"]) {
        expect(parseUsageHeadContextV2({ ...head(), [name]: value })).not.toBeNull();
        expect(await deriveUsageSourcePublicIdV2(key(), { ...source(), [name]: value })).toMatch(/^usrc2_[0-9a-f]{64}$/u);
      }
      for (const value of ["a".repeat(7), "a".repeat(97), "with space", "contains/path", "é".repeat(8)]) {
        expectInvalidHead({ ...head(), [name]: value });
        await expectInvalidSource({ ...source(), [name]: value });
      }
    }
    for (const sourcePublicId of [`usrc2_${"a".repeat(63)}`, `usrc2_${"a".repeat(65)}`, `usrc2_${"A".repeat(64)}`, `codex_${"a".repeat(48)}`]) {
      expectInvalidHead({ ...head(), sourcePublicId });
    }
    for (const localProviderAccountId of [`acct_${"a".repeat(31)}`, `acct_${"a".repeat(33)}`, `acct_${"A".repeat(32)}`, `pact_${"1".repeat(32)}`, `dact_${"1".repeat(32)}`]) {
      await expectInvalidSource({ ...source(), localProviderAccountId });
    }
    await expectInvalidSource({ ...source(), provider: "claude" });
    expectInvalidHead({ ...head(), provider: "devin" });
    await expectInvalidSource({ ...source(), provider: "devin" });
  });

  test("detaches and freezes canonical contexts and allocates independent public AAD bytes", () => {
    const input = head();
    const candidate = reverseKeys(input);
    const parsed = parseUsageHeadContextV2(candidate);
    expectRawEqual(parsed, input);
    expect(parsed).not.toBe(candidate);
    expect(Object.isFrozen(candidate)).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.keys(parsed ?? {})).toEqual(Object.keys(input));
    const aad = usageHeadAadV2(input);
    const original = new TextDecoder().decode(aad);
    input.sourceRevision = 99;
    input.apiOrigin = "https://changed.example.com";
    candidate.sourceRevision = 98;
    candidate.apiOrigin = "https://candidate-changed.example.com";
    expect(parsed?.sourceRevision).toBe(7);
    expect(parsed?.apiOrigin).toBe("https://example.com");
    expect(new TextDecoder().decode(aad)).toBe(original);
    aad.fill(0);
    expect(new TextDecoder().decode(usageHeadAadV2(head()))).toBe(original);
  });

  test("rejects malformed foreign graphs and accessors without executing getters", async () => {
    let getters = 0;
    const withGetter = (value: Record<string, unknown>) => Object.defineProperty(value, "apiOrigin", {
      enumerable: true, get() { getters += 1; throw new Error("private getter"); },
    });
    const cycle: Record<string, unknown> = { ...head() }; cycle.apiOrigin = cycle;
    const aliased: Record<string, unknown> = { ...head() };
    const child = {}; aliased.userPublicId = child; aliased.sourceDevicePublicId = child;
    const sparse: unknown[] = []; sparse.length = 2;
    const hidden = Object.defineProperty(head(), "private", { enumerable: false, value: "private" });
    const symbols = { ...head(), [Symbol("private")]: "private" };
    const exotic: unknown = Object.setPrototypeOf(head(), { unexpected: true });
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("private trap"); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const input of [undefined, null, [], sparse, true, 1, 1n, Symbol("input"), () => 1,
      withGetter(head()), withGetter(source()), cycle, aliased, hidden, symbols, exotic, proxy, revoked.proxy]) {
      expect(() => parseUsageHeadContextV2(input)).not.toThrow();
      expectInvalidHead(input);
      await expectInvalidSource(input);
    }
    expect(getters).toBe(0);
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, head());
    expectRawEqual(parseUsageHeadContextV2(nullPrototype), head());
  });

  test("copies key bytes and context before asynchronous caller mutation", async () => {
    const mutableKey = key();
    const input = source();
    const result = deriveUsageSourcePublicIdV2(mutableKey, input);
    mutableKey.fill(255);
    input.apiOrigin = "https://changed.example.com";
    input.localProviderAccountId = `acct_${"2".repeat(32)}`;
    expect(await result).toBe(`usrc2_${codexDigest}`);

    const beforeContextKey = key();
    let traps = 0;
    const context = new Proxy(source(), {
      ownKeys(target) { traps += 1; beforeContextKey.fill(255); return Reflect.ownKeys(target); },
    });
    expect(await deriveUsageSourcePublicIdV2(beforeContextKey, context)).toBe(`usrc2_${codexDigest}`);
    expect(traps).toBeGreaterThan(0);
  });

  test("copies exact Uint8Array views and ignores shadowed getters, iterator and species", async () => {
    const backing = new Uint8Array(64).fill(255);
    backing.set(key(), 13);
    expect(await deriveUsageSourcePublicIdV2(backing.subarray(13, 45), source())).toBe(`usrc2_${codexDigest}`);
    expect(await deriveUsageSourcePublicIdV2(Buffer.from(key()), source())).toBe(`usrc2_${codexDigest}`);
    let hooks = 0;
    class HostileKey extends Uint8Array {}
    Object.defineProperty(HostileKey, Symbol.species, { get() { hooks += 1; throw new Error("species"); } });
    const hostile = new HostileKey(key());
    for (const property of ["buffer", "byteLength", "byteOffset", "length", "constructor", "set", Symbol.iterator, Symbol.toStringTag]) {
      Object.defineProperty(hostile, property, { get() { hooks += 1; throw new Error("private key hook"); } });
    }
    expect(await deriveUsageSourcePublicIdV2(hostile, source())).toBe(`usrc2_${codexDigest}`);
    expect(hooks).toBe(0);
  });

  test("accepts a genuine Uint8Array from another JavaScript realm", async () => {
    const foreignKey: unknown = runInNewContext(
      "Uint8Array.from({ length: 32 }, (_, index) => index)", {}, { timeout: 1_000 },
    );
    expect(foreignKey).not.toBeInstanceOf(Uint8Array);
    expect(await deriveUsageSourcePublicIdV2(foreignKey as Uint8Array, source())).toBe(`usrc2_${codexDigest}`);
  });

  test("rejects invalid typed keys using native brand and storage checks", async () => {
    const detached = key();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    let proxyReads = 0;
    const proxy = new Proxy(key(), { get() { proxyReads += 1; throw new Error("private key get"); } });
    for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint16Array(16), new Int8Array(32),
      new DataView(new ArrayBuffer(32)), new ArrayBuffer(32), new Uint8Array(new SharedArrayBuffer(32)),
      detached, proxy, {}, null]) {
      // Foreign direct JS callers are intentionally wider than the public TS API.
      await expectInvalidSource(source(), bad as Uint8Array);
    }
    expect(proxyReads).toBe(0);
  });

  test("seeded foreign contexts have total parsers and fixed sanitized refusals", async () => {
    const arbitrary = fc.oneof(fc.jsonValue({ maxDepth: 3 }), fc.constantFrom(undefined, NaN, Infinity, 1n, Symbol("foreign")));
    await fc.assert(fc.asyncProperty(arbitrary, async (input) => {
      expect(() => parseUsageHeadContextV2(input)).not.toThrow();
      const parsed = parseUsageHeadContextV2(input);
      if (parsed === null) expectInvalidHead(input);
      else {
        expect(parseUsageHeadContextV2(parsed)).toEqual(parsed);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(usageHeadAadV2(input)).toEqual(usageHeadAadV2(parsed));
      }
      const derived: unknown = await deriveUsageSourcePublicIdV2(key(), input)
        .then((value) => value, (error: unknown) => error);
      if (typeof derived === "string") expect(derived).toMatch(/^usrc2_[0-9a-f]{64}$/u);
      else {
        expect(derived).toBeInstanceOf(Error);
        if (!(derived instanceof Error)) throw new Error("Expected source refusal");
        expect(derived.message).toBe("Invalid usage source identity input.");
        expect(derived.cause).toBeUndefined();
      }
    }), { numRuns: 100, seed: 68_101 });
  });

  test("seeded valid contexts preserve canonical framing and keyed derivation under key order changes", async () => {
    const arbitrary = fc.record({
      provider: fc.constantFrom("codex", "claude"),
      suffix: fc.integer({ min: 0, max: 1_000_000 }),
      sourceRevision: fc.integer({ min: 1, max: 1_000_000 }),
      keyVersion: fc.integer({ min: 1, max: 1_000_000 }),
      apiOrigin: fc.constantFrom("HTTPS://EXAMPLE.COM:443/", "https://é.example", "http://LOCALHOST:80/"),
    });
    await fc.assert(fc.asyncProperty(arbitrary, async (generated) => {
      const privateContext = { ...source(), apiOrigin: generated.apiOrigin,
        provider: generated.provider, keyVersion: generated.keyVersion,
        localProviderAccountId: `${generated.provider === "codex" ? "acct" : "pact"}_${generated.suffix.toString(16).padStart(32, "0")}` };
      const sourceRevision = generated.sourceRevision;
      const sourcePublicId = await deriveUsageSourcePublicIdV2(key(), privateContext);
      expect(sourcePublicId).toMatch(/^usrc2_[0-9a-f]{64}$/u);
      expect(await deriveUsageSourcePublicIdV2(key(), reverseKeys(privateContext))).toBe(sourcePublicId);
      const input = { ...head(), apiOrigin: generated.apiOrigin, provider: generated.provider,
        sourcePublicId, sourceRevision, keyVersion: generated.keyVersion };
      const expected = { ...input, apiOrigin: new URL(input.apiOrigin).origin };
      const candidate = reverseKeys(input);
      const parsed = parseUsageHeadContextV2(candidate);
      expectRawEqual(parsed, expected);
      expectRawEqual(parseUsageHeadContextV2(parsed), expected);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(parsed).not.toBe(candidate);
      expect(Object.isFrozen(candidate)).toBe(false);
      const expectedAad = JSON.stringify(["hra-control-plane-usage-head:v2", expected.apiOrigin,
        expected.userPublicId, expected.sourceDevicePublicId, expected.provider, sourcePublicId, sourceRevision, expected.keyVersion]);
      expect(new TextDecoder().decode(usageHeadAadV2(input))).toBe(expectedAad);
      expect(usageHeadAadV2(reverseKeys(input))).toEqual(usageHeadAadV2(input));
      input.sourceRevision += 1;
      candidate.sourceRevision = sourceRevision + 2;
      candidate.apiOrigin = "https://candidate-changed.example.com";
      expect(parsed?.sourceRevision).toBe(sourceRevision);
      expect(parsed?.apiOrigin).toBe(expected.apiOrigin);
    }), { numRuns: 100, seed: 68_102 });
  });

  test("bundles the context helper for browsers in memory without native custody", async () => {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./usage-context-v2.ts", import.meta.url))], target: "browser",
    });
    expect(build.success).toBe(true);
    expect(build.logs).toEqual([]);
    expect(build.outputs).toHaveLength(1);
    const output = await build.outputs[0]?.text();
    expect(output).toContain("deriveUsageSourcePublicIdV2");
    expect(output).not.toMatch(/(?:node:|bun:sqlite|StateStore|createHash|randomUUID)/u);
  });
});
