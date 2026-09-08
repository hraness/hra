import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { z } from "zod";

import { mutationEvidenceCanonicalSol43Schema } from "./historical-effect-evidence-codecs";
import { checkMutationEvidenceEnvelope, decodeMutationEvidence, decodeQueueEvidence } from "./effect-evidence-reader";

// Synthetic schema history, not captured provider effects or migration proof.
// Independently AST-extracted/evaluated 0aa3fd563e369f75875136ca1f550016e70035e8:
// StateStore mutation initializer SHA256:
// 8b9b16a9a625ee833693e4448a6efba0bd405dfeeb1521e058bbcc82240aac8e
// Whole archived files SHA256 (same-revision domain leaves, no StateStore import):
// state-store.ts 9c8b9214e230e851634b5dceb42bcb9c5d680671ce8c04b5ee216c608552a993
// values.ts e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
// presets.ts 620e37daa36a82214bab84f9725e5d42bfad242eb16d0db2b07018af730fe9ee
// runtime-profile.ts 3c39335ac9b2754616f37b9bd47400a38d61163d21ab6727b2f2c4442adfcb06
// session-events.ts 18d9f276cdad0c7730a642b8788d9d5217fb2c0f524d8ef0498ad02a51d4dcf2
// Captured declarations: sha256, thread/login/account-key, baseline, mutation,
// queue schemas and exact gap enum. Evaluated with archived values/presets/
// runtime-profile modules under Bun1.3.14/Zod4.4.3. Literal JSON fragments below
// retain archived output order; expected hashes never use the current parser.
const runtimeJson = '{"profileId":"acct_11111111111111111111111111111111","processGeneration":3,"observedAt":1700000000000,"preset":"high","model":"gpt-5.6-sol","reasoningEffort":"max","serviceTier":null,"fast":false,"approvalPolicy":"on-request","reviewMode":"auto_review","permissionProfile":":workspace","computerUse":true,"pluginCapability":true,"enabledApps":[]}';
const baselineJson = '{"providerUpdatedAt":1700000000,"status":"idle","activeTurnId":null}';
const messageSuffix = '"clientMessageId":"message","messageDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
const startPrefix = '{"kind":"session.start","projectId":"proj_22222222222222222222222222222222","clientMessageId":null,"messageDigest":null,';
const startSuffix = `"runtimeProfile":${runtimeJson},"conversationAutomationCapability":"hra.automation_update.v1"}`;
const switchPrefix = '{"kind":"session.switch","daemonGeneration":9,"requestedAccountId":"acct_11111111111111111111111111111111","requestedPreset":"high","sourceProfileId":"acct_00000000000000000000000000000000","sourceProcessGeneration":2,"sourceProvider":"codex","sourceProviderThreadId":"source-thread","sourcePreset":"high","targetProfileId":"acct_11111111111111111111111111111111","targetProcessGeneration":3,"targetProvider":"codex","targetProviderAccountKey":"v1:codex:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","targetPreset":"high",';
const switchMiddle = '"transcriptDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","seedDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","seedIncludedRecords":1,"seedOmittedRecords":2,';
const oracle = [
  ["session.start", startPrefix + '"presetContract":1,' + startSuffix, "dbf580f3ed5b4b68d67a1f9137f4c238a76f4dff323017fb1470bae5d746d425"],
  ["session.switch", switchPrefix + '"presetContract":1,' + switchMiddle + '"seedRetentionGapReason":"retention_count",' + `"runtimeProfile":${runtimeJson}}`, "8c3953bbfdb080a1b8f4e1ca84bcb80dea8cc40e6bacd40023f7385057eb34d9"],
  ["session.start", startPrefix + startSuffix, "6570563e70c64d5a4cf3d7349a3bb89193461ce1fd196591a427234a5542f11b"],
  ["session.switch", switchPrefix + switchMiddle + `"runtimeProfile":${runtimeJson}}`, "5c5849a524ca79273985af50ed35c6d3d8f0b2df1bf500def216f923fd2bc57f"],
  ["session.send", `{"kind":"session.send","providerThreadId":"thread","baseline":${baselineJson},${messageSuffix},"runtimeProfile":${runtimeJson}}`, "63fe08811a9f3df1862c447de82b94a82a620585f62ae6f1990c2dcdae442cce"],
  ["session.steer", `{"kind":"session.steer","providerThreadId":"thread","baseline":${baselineJson},"activeTurnId":null,${messageSuffix}}`, "3c82fa5aed0ad4922bfaff0bd505fb7a6dda6b962073e685f4e88293b074e66d"],
  ["session.stop", `{"kind":"session.stop","providerThreadId":"thread","providerTimestampUnit":"unix_milliseconds_v1","baseline":${baselineJson},"activeTurnId":null}`, "90d6c6c32729c9c2180cd76ed7dfd5173b4300484596b4d00055729704c04a1b"],
  ["session.rename", `{"kind":"session.rename","providerThreadId":"thread","providerTimestampUnit":"unix_milliseconds_v1","baseline":${baselineJson},"requestedName":"Renamed"}`, "ac635a82d4088b1aa4a541c4d5fc2e9d624718704c155999cae842a825d68c2a"],
  ["account.login", '{"kind":"account.login","method":"browser"}', "c20652370ba62e0abe84bed6d62178354ba704d8d9284e0b21ab357c81aa54c1"],
  ["account.claude-login", '{"kind":"account.claude-login","provider":"claude","baselineSignedIn":false}', "9800323eb0ebc24a963bf618ca360477c8190d459e64ffceb39f1a88f0d20edf"],
  ["account.devin-login", '{"kind":"account.devin-login","provider":"devin","baselineSignedIn":false}', "2476e8f4eb506499ef2768c2dab661198e6e2b63db62edaabd9da7ae01e93252"],
  ["account.logout", '{"kind":"account.logout","baselineSignedIn":true}', "fd57bf63698409131b0d21ec97b1cf96aa42728578a36e605e2f420ba79bde8c"],
  ["account.login-cancel", '{"kind":"account.login-cancel","loginId":"synthetic-login"}', "127a77bbab7af70167d1f8f6f2e8d8d38273f759d267811ccdeb9ab65c055dc1"],
  ["queue.dispatch", `{"kind":"queue.dispatch","queueId":"queue_33333333333333333333333333333333","sessionId":"sess_44444444444444444444444444444444","providerThreadId":"thread","profileGeneration":3,"baseline":${baselineJson},${messageSuffix},"runtimeProfile":${runtimeJson}}`, "d678a18142d19f9b37324dbd654b203b54782083250b5e68aead44abbf7a4fdd"],
] as const;
const format = "canonical_sol43_v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (json: string) => z.record(z.string(), z.unknown()).parse(JSON.parse(json) as unknown);
const decode = (kind: string, json: string) => kind === "queue.dispatch"
  ? decodeQueueEvidence({ format, json }) : decodeMutationEvidence({ format, json });
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  }
  return value;
}

test("Sol43 has all eleven archived mutation kinds and exact fourteen canonical preimages", () => {
  expect(mutationEvidenceCanonicalSol43Schema.options).toHaveLength(11);
  expect(new Set(oracle.filter(([kind]) => kind !== "queue.dispatch").map(([kind]) => kind)).size).toBe(11);
  for (const [kind, json, digest] of oracle) {
    expect(hash(json)).toBe(digest);
    for (const input of [json, JSON.stringify(reverseKeys(object(json)))]) {
      const result = decode(kind, input);
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") throw new Error("Expected the archived Sol43 shape.");
      expect(result.canonicalJson).toBe(json);
      expect(hash(result.canonicalJson)).toBe(digest);
    }
    if (kind !== "queue.dispatch") expect(checkMutationEvidenceEnvelope({
      format, json, digest, evidenceKind: kind, parentKind: kind,
    }).kind).toBe("checked_envelope");
  }
});

test("Sol43 accepts preset/gap fields but rejects later actor and host-capability authority", () => {
  for (const [kind, json] of oracle) {
    const input = object(json);
    if (kind === "queue.dispatch") continue;
    expect(mutationEvidenceCanonicalSol43Schema.safeParse({ ...input, future: true }).success).toBe(false);
    if (kind === "session.send" || kind === "session.steer") {
      for (const messageActor of [undefined, "human", "automation", "peer_session"]) {
        const result = mutationEvidenceCanonicalSol43Schema.safeParse({ ...input, messageActor });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues.map((issue) => issue.code)).toEqual(["unrecognized_keys"]);
      }
    }
    if (kind !== "session.start" && kind !== "session.switch") continue;
    for (const presetContract of [0, 3, "1", null]) {
      expect(mutationEvidenceCanonicalSol43Schema.safeParse({ ...input, presetContract }).success).toBe(false);
    }
    if (input.presetContract !== undefined) {
      for (const old of ["canonical40_v1", "canonical41_v1", "canonical43_v1", "private_task48_v1", "combined49_v1"]) {
        expect(decodeMutationEvidence({ format: old, json })).toEqual({ kind: "opaque", reason: "invalid_shape" });
      }
    }
    if (kind !== "session.switch") continue;
    for (const targetHostCapabilities of [undefined, { preambleVersion: 1, preambleDigest: "a".repeat(64), manifestVersion: 1, manifestDigest: "b".repeat(64) }]) {
      const result = mutationEvidenceCanonicalSol43Schema.safeParse({ ...input, targetHostCapabilities });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.code)).toEqual(["unrecognized_keys"]);
    }
    expect(mutationEvidenceCanonicalSol43Schema.safeParse({ ...input, seedRetentionGapReason: "future" }).success).toBe(false);
  }
});

test("Sol43 canonical queue and send runtimes do not borrow native-fallback history", () => {
  for (const [kind, json] of oracle) {
    if (kind !== "session.send" && kind !== "queue.dispatch") continue;
    for (const home of [{ isolatedConfigDir: true }, { configHome: "isolated" }, { configHome: "personal" }]) {
      const runtimeProfile = { profileId: "acct_" + "1".repeat(32), processGeneration: 3, observedAt: 0,
        preset: "fable-max", model: "claude-fable-5-1", reasoningEffort: "max", claudeVersion: "2.1.260",
        permissionMode: "default", ...home, outputFormat: "stream-json", inputFormat: "stream-json" };
      const input = { ...object(json), runtimeProfile };
      expect(decode(kind, JSON.stringify(input)).kind).toBe("parsed");
      const withFallback = JSON.stringify({ ...input, runtimeProfile: { ...runtimeProfile,
        nativeFallback: { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" } } });
      expect((kind === "queue.dispatch" ? decodeQueueEvidence : decodeMutationEvidence)({ format: "combined49_v1", json: withFallback }).kind).toBe("parsed");
      expect(decode(kind, withFallback))
        .toEqual({ kind: "opaque", reason: "invalid_shape" });
    }
  }
});

test("seeded Sol43 key-order and round-trip laws keep literal archived hashes", () => {
  for (const [kind, json, digest] of oracle) {
    const input = object(json);
    const keys = Object.keys(input);
    fc.assert(fc.property(fc.shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length }), (order) => {
      const candidate = Object.fromEntries(order.map((key) => [key, reverseKeys(input[key])]));
      const result = decode(kind, JSON.stringify(candidate));
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") throw new Error("Expected an accepted generated shape.");
      expect(result.canonicalJson).toBe(json);
      expect(hash(result.canonicalJson)).toBe(digest);
      expect(decode(kind, result.canonicalJson)).toEqual(result);
    }), { seed: 43_460, numRuns: 50 });
  }
});
