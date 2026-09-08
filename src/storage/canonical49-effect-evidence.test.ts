import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { z } from "zod";

import { mutationEvidenceCanonical49Schema } from "./historical-effect-evidence-codecs";
import { checkMutationEvidenceEnvelope, decodeMutationEvidence } from "./effect-evidence-reader";

// Pure parser oracles produced from exact archived source, not current codecs,
// databases or provider effects. TypeScript5.9.2 AST-extracted StateStore's
// sha256Schema, providerThreadIdSchema, providerLoginIdSchema,
// providerAccountAuthorityKeySchema, providerBaselineSchema,
// sessionProviderSwitchHostCapabilitiesSchema, mutationEffectEvidenceSchema,
// queueEffectEvidenceSchema, and session-events' actor/gap enums; emitted const
// initializers in that order (actor/gap first) and evaluated with archived domain
// leaves under Bun1.3.14/Zod4.4.3. Digests cover archived canonical output.
const oracle = {
  "source": "7ab347813f8d7e4f31e9584752c801dd1ca0cda0",
  "sourceHashes": {
    "src/storage/state-store.ts": "01edcbdc3f7e870f8252e07de1be90a2d3fe8f2e1b32a5b948c04fd64c774923",
    "src/domain/values.ts": "40cfad2fa531cdafa437dc028306d725eb7592d94c69caa6cffa4c86af05074d",
    "src/domain/presets.ts": "620e37daa36a82214bab84f9725e5d42bfad242eb16d0db2b07018af730fe9ee",
    "src/domain/runtime-profile.ts": "3c39335ac9b2754616f37b9bd47400a38d61163d21ab6727b2f2c4442adfcb06",
    "src/domain/session-events.ts": "21b200e9e9c7c90307e4d6d698f77b6b9221fb70e373e46c3f705d0774a674d2"
  },
  "declarationsSha256": "5109754cabaef234c37b1389e7019e4ab0d676f2853c8dd14f677359e60a38b4",
  "fixtures": [
    {
      "kind": "session.start",
      "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"presetContract\":1,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]},\"conversationAutomationCapability\":\"hra.automation_update.v1\"}",
      "sha256": "dbf580f3ed5b4b68d67a1f9137f4c238a76f4dff323017fb1470bae5d746d425"
    },
    {
      "kind": "session.switch",
      "json": "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":\"acct_11111111111111111111111111111111\",\"requestedPreset\":\"high\",\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetProviderAccountKey\":\"v1:codex:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetHostCapabilities\":{\"preambleVersion\":1,\"preambleDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"manifestVersion\":2,\"manifestDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"},\"targetPreset\":\"high\",\"presetContract\":1,\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":2,\"seedRetentionGapReason\":\"retention_count\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
      "sha256": "ff950ccf173b2a0aef789a11fd35738a2d1d226b7800cc824eeda246aedee23c"
    }
  ]
} as const;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

test("canonical49 preset and retention fields preserve archived byte order and digests", () => {
  for (const fixture of oracle.fixtures) {
    expect(hash(fixture.json)).toBe(fixture.sha256);
    const decoded = decodeMutationEvidence({ format: "canonical49_v1", json: fixture.json });
    expect(decoded.kind).toBe("parsed");
    if (decoded.kind !== "parsed") throw new Error("Missing canonical49 oracle.");
    expect(decoded.canonicalJson).toBe(fixture.json);
    expect(checkMutationEvidenceEnvelope({
      format: "canonical49_v1", json: fixture.json, digest: fixture.sha256,
      evidenceKind: fixture.kind, parentKind: fixture.kind,
    }).kind).toBe("checked_envelope");
    for (const format of ["canonical40_v1", "canonical41_v1", "canonical43_v1", "private_task48_v1", "combined49_v1"]) {
      expect(decodeMutationEvidence({ format, json: fixture.json })).toEqual({
        kind: "opaque", reason: "invalid_shape",
      });
    }
  }
});

test("canonical49 optional absence retains the original pre-contract digest format", () => {
  for (const fixture of oracle.fixtures) {
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(fixture.json) as unknown);
    delete input.presetContract;
    delete input.seedRetentionGapReason;
    const json = JSON.stringify(input);
    const old = decodeMutationEvidence({ format: "canonical43_v1", json });
    const current = decodeMutationEvidence({ format: "canonical49_v1", json });
    expect(old.kind).toBe("parsed");
    expect(current.kind).toBe("parsed");
    if (old.kind !== "parsed" || current.kind !== "parsed") throw new Error("Missing absent-optionals oracle.");
    expect(current.canonicalJson).toBe(old.canonicalJson);
    expect(current.canonicalJson).toBe(json);
    expect(hash(current.canonicalJson)).not.toBe(fixture.sha256);
  }
});

test("canonical49 refuses future contracts, future gaps and forged capabilities without fallback", () => {
  for (const fixture of oracle.fixtures) {
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(fixture.json) as unknown);
    for (const presetContract of [0, 3, "1", null, {}, []]) {
      expect(mutationEvidenceCanonical49Schema.safeParse({ ...input, presetContract }).success).toBe(false);
    }
    expect(mutationEvidenceCanonical49Schema.safeParse({ ...input, future: true }).success).toBe(false);
    if (fixture.kind !== "session.switch") continue;
    for (const seedRetentionGapReason of ["future", null, 0, {}, []]) {
      expect(mutationEvidenceCanonical49Schema.safeParse({ ...input, seedRetentionGapReason }).success).toBe(false);
    }
    const capabilities = z.record(z.string(), z.unknown()).parse(input.targetHostCapabilities);
    expect(mutationEvidenceCanonical49Schema.safeParse({
      ...input, targetHostCapabilities: { ...capabilities, allowUnreviewed: true },
    }).success).toBe(false);
  }
});

test("canonical49 key permutations retain the archived digest preimage", () => {
  for (const fixture of oracle.fixtures) {
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(fixture.json) as unknown);
    const keys = Object.keys(input);
    fc.assert(fc.property(fc.shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length }), (order) => {
      const permuted = Object.fromEntries(order.map((key) => [key, input[key]]));
      const parsed = mutationEvidenceCanonical49Schema.parse(permuted);
      expect(JSON.stringify(parsed)).toBe(fixture.json);
      expect(hash(JSON.stringify(parsed))).toBe(fixture.sha256);
    }), { seed: 54949, numRuns: 100 });
  }
});

test("canonical49 adds the archived automation actor without broadening canonical43", () => {
  // Exact 7ab session-events declaration includes automation between human and
  // autorespond. The earlier canonical43 declaration has only four actors.
  for (const kind of ["session.send", "session.steer"] as const) {
    const input = {
      kind, providerThreadId: "synthetic-thread",
      baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
      ...(kind === "session.steer" ? { activeTurnId: null } : {}),
      clientMessageId: "synthetic-message", messageDigest: "a".repeat(64),
      messageActor: "automation",
    };
    const json = JSON.stringify(input);
    const decoded = decodeMutationEvidence({ format: "canonical49_v1", json });
    expect(decoded.kind).toBe("parsed");
    if (decoded.kind !== "parsed") throw new Error("Missing canonical49 automation actor.");
    expect(decoded.canonicalJson).toBe(json);
    expect(decodeMutationEvidence({ format: "canonical43_v1", json })).toEqual({
      kind: "opaque", reason: "invalid_shape",
    });
  }
});
