import { createHash } from "node:crypto";

import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  checkMutationEvidenceEnvelope,
  checkQueueEvidenceEnvelope,
  decodeMutationEvidence,
  decodeQueueEvidence,
  EFFECT_EVIDENCE_JSON_MAX_BYTES,
  historicalEffectEvidenceFormatSchema,
} from "./effect-evidence-reader";

const formats = historicalEffectEvidenceFormatSchema.options;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const stopJson = '{"kind":"session.stop","providerThreadId":"historical-thread",'
  + '"baseline":{"providerUpdatedAt":1700000000,"status":"idle","activeTurnId":null},"activeTurnId":null}';
const markedStopJson = '{"kind":"session.stop","providerThreadId":"historical-thread",'
  + '"providerTimestampUnit":"unix_milliseconds_v1",'
  + '"baseline":{"providerUpdatedAt":1700000000,"status":"idle","activeTurnId":null},"activeTurnId":null}';
const actorJson = '{"kind":"session.steer","providerThreadId":"historical-thread",'
  + '"baseline":{"providerUpdatedAt":null,"status":"idle","activeTurnId":null},'
  + '"activeTurnId":null,"clientMessageId":"message","messageDigest":"' + "a".repeat(64)
  + '","messageActor":"peer_session"}';
const queueJson = JSON.stringify({
  kind: "queue.dispatch", queueId: "queue_" + "a".repeat(32), sessionId: "sess_" + "b".repeat(32),
  providerThreadId: "historical-thread", profileGeneration: 1,
  baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
  clientMessageId: "message", messageDigest: "c".repeat(64),
  runtimeProfile: {
    profileId: "acct_" + "d".repeat(32), processGeneration: 1, observedAt: 0,
    preset: "fable-max", model: "claude-fable-5-1", reasoningEffort: "max", claudeVersion: "2.1.260",
    permissionMode: "default", isolatedConfigDir: true, outputFormat: "stream-json", inputFormat: "stream-json",
  },
});

test("each explicitly selected historical format retains unmarked stop bytes without defaults", () => {
  for (const format of formats) {
    const result = decodeMutationEvidence({ format, json: stopJson });
    expect(result as unknown).toEqual({ kind: "parsed", format, value: JSON.parse(stopJson) as unknown, canonicalJson: stopJson });
    expect(checkMutationEvidenceEnvelope({
      format, json: stopJson, digest: hash(stopJson), evidenceKind: "session.stop", parentKind: "session.stop",
    }).kind).toBe("checked_envelope");
  }
});

test("a failed historical decoder never falls through to timestamp or actor acceptance", () => {
  for (const format of formats) {
    const timestamp = decodeMutationEvidence({ format, json: markedStopJson });
    const actor = decodeMutationEvidence({ format, json: actorJson });
    expect(timestamp.kind).toBe(format === "canonical41_v1" || format === "canonical43_v1" ? "parsed" : "opaque");
    expect(actor.kind).toBe(format === "canonical43_v1" ? "parsed" : "opaque");
    if (timestamp.kind === "parsed") expect(timestamp.canonicalJson).toBe(markedStopJson);
    if (actor.kind === "parsed") expect(actor.canonicalJson).toBe(actorJson);
  }
});

test("format provenance is mandatory, closed and never inferred from numeric version or fields", () => {
  for (const format of [undefined, null, 43, 49, "49", "canonical42_v1", "joined_v1", "latest", "__proto__", "constructor", {}, []]) {
    for (const json of [stopJson, markedStopJson, actorJson, queueJson]) {
      expect(decodeMutationEvidence({ format, json })).toEqual({ kind: "opaque", reason: "unsupported_format" });
      expect(decodeQueueEvidence({ format, json })).toEqual({ kind: "opaque", reason: "unsupported_format" });
    }
  }
});

test("foreign input returns bounded opaque reasons without raw payloads", () => {
  for (const format of formats) {
    for (const json of [undefined, null, 0, {}, [], "", "{", '{kind:"session.stop"}', '\uFEFF' + stopJson]) {
      expect(decodeMutationEvidence({ format, json })).toEqual({ kind: "opaque", reason: "invalid_json" });
    }
    for (const json of ["null", "[]", "0", '"private content"', "{}", '{"kind":"future","sensitive":"discard"}']) {
      expect(decodeMutationEvidence({ format, json })).toEqual({ kind: "opaque", reason: "invalid_shape" });
    }
  }
});

test("input bound counts UTF-8 bytes, includes whitespace, and is checked before parsing", () => {
  const padded = stopJson + " ".repeat(EFFECT_EVIDENCE_JSON_MAX_BYTES - Buffer.byteLength(stopJson));
  expect(Buffer.byteLength(padded)).toBe(EFFECT_EVIDENCE_JSON_MAX_BYTES);
  expect(decodeMutationEvidence({ format: "combined49_v1", json: padded }).kind).toBe("parsed");
  for (const json of [padded + " ", " ".repeat(EFFECT_EVIDENCE_JSON_MAX_BYTES + 1), "é".repeat(EFFECT_EVIDENCE_JSON_MAX_BYTES / 2 + 1)]) {
    expect(decodeMutationEvidence({ format: "combined49_v1", json })).toEqual({ kind: "opaque", reason: "input_too_large" });
    expect(decodeQueueEvidence({ format: "combined49_v1", json })).toEqual({ kind: "opaque", reason: "input_too_large" });
  }
});

test("envelope digest checks historical canonical bytes, not arbitrary input layout", () => {
  const json = JSON.stringify(JSON.parse(stopJson) as unknown, null, 2);
  expect(hash(json)).not.toBe(hash(stopJson));
  const input = { format: "combined49_v1", json, evidenceKind: "session.stop", parentKind: "session.stop" };
  const result = checkMutationEvidenceEnvelope({ ...input, digest: hash(stopJson) });
  expect(result.kind).toBe("checked_envelope");
  if (result.kind !== "checked_envelope") throw new Error("Expected checked envelope.");
  expect(result.canonicalJson).toBe(stopJson);
  expect(checkMutationEvidenceEnvelope({ ...input, digest: hash(json) }))
    .toEqual({ kind: "opaque", reason: "digest_mismatch" });
  for (const digest of [null, undefined, "0".repeat(63), "A".repeat(64), 1, "digest"]) {
    expect(checkMutationEvidenceEnvelope({ ...input, digest })).toEqual({ kind: "opaque", reason: "invalid_digest" });
  }
});

test("both stored and parent kind must match the parsed kind before envelope acceptance", () => {
  const input = { format: "combined49_v1", json: stopJson, digest: hash(stopJson), evidenceKind: "session.stop", parentKind: "session.stop" };
  for (const kind of [null, undefined, "session.rename", "account.login", "queue.dispatch", 0]) {
    expect(checkMutationEvidenceEnvelope({ ...input, evidenceKind: kind })).toEqual({ kind: "opaque", reason: "kind_mismatch" });
    expect(checkMutationEvidenceEnvelope({ ...input, parentKind: kind })).toEqual({ kind: "opaque", reason: "kind_mismatch" });
  }
  expect(checkMutationEvidenceEnvelope({ ...input, json: markedStopJson, digest: hash(markedStopJson) }))
    .toEqual({ kind: "opaque", reason: "invalid_shape" });
});

test("duplicate-key interpretation is explicitly JavaScript canonical evidence, not raw SQL authority", () => {
  for (const [first, last] of [["peer_session", "human"], ["human", "peer_session"]]) {
    const json = actorJson.replace('"messageActor":"peer_session"', `"messageActor":"${first}"`).slice(0, -1)
      + `,"messageActor":"${last}"}`;
    const canonicalJson = actorJson.replace('"messageActor":"peer_session"', `"messageActor":"${last}"`);
    const input = { format: "canonical43_v1", json, evidenceKind: "session.steer", parentKind: "session.steer" };
    const result = checkMutationEvidenceEnvelope({ ...input, digest: hash(canonicalJson) });
    expect(result.kind).toBe("checked_envelope");
    if (result.kind !== "checked_envelope") throw new Error("Expected checked envelope.");
    expect(result.canonicalJson).toBe(canonicalJson);
    expect(result.value).toHaveProperty("messageActor", last);
    expect(checkMutationEvidenceEnvelope({ ...input, digest: hash(json) })).toEqual({ kind: "opaque", reason: "digest_mismatch" });
    expect(decodeMutationEvidence({ format: "combined49_v1", json })).toEqual({ kind: "opaque", reason: "invalid_shape" });
  }
  const nullLast = markedStopJson.slice(0, -1) + ',"providerTimestampUnit":null}';
  const markerLast = markedStopJson.replace('"providerTimestampUnit":"unix_milliseconds_v1"', '"providerTimestampUnit":null')
    .slice(0, -1) + ',"providerTimestampUnit":"unix_milliseconds_v1"}';
  for (const format of formats) {
    expect(decodeMutationEvidence({ format, json: nullLast })).toEqual({ kind: "opaque", reason: "invalid_shape" });
    const result = decodeMutationEvidence({ format, json: markerLast });
    if (format === "canonical41_v1" || format === "canonical43_v1") {
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") throw new Error("Expected last-key-wins timestamp interpretation.");
      expect(result.canonicalJson).toBe(markedStopJson);
    } else expect(result).toEqual({ kind: "opaque", reason: "invalid_shape" });
  }
});

test("historical normalization remains the digest preimage and precedes kind diagnostics", () => {
  const json = '{"requestedName":"  Renamed  ","kind":"session.rename","providerThreadId":"historical-thread",'
    + '"baseline":{"activeTurnId":null,"status":"idle","providerUpdatedAt":1700000000}}';
  const canonicalJson = '{"kind":"session.rename","providerThreadId":"historical-thread",'
    + '"baseline":{"providerUpdatedAt":1700000000,"status":"idle","activeTurnId":null},"requestedName":"Renamed"}';
  const input = { format: "combined49_v1", json, evidenceKind: "session.rename", parentKind: "session.rename" };
  const result = checkMutationEvidenceEnvelope({ ...input, digest: hash(canonicalJson) });
  expect(result.kind).toBe("checked_envelope");
  if (result.kind !== "checked_envelope") throw new Error("Expected historical normalized envelope.");
  expect(result.canonicalJson).toBe(canonicalJson);
  expect(checkMutationEvidenceEnvelope({ ...input, digest: hash(json), evidenceKind: "session.stop" }))
    .toEqual({ kind: "opaque", reason: "digest_mismatch" });
  expect(checkMutationEvidenceEnvelope({ ...input, digest: null, parentKind: "session.stop" }))
    .toEqual({ kind: "opaque", reason: "invalid_digest" });
});

test("queue formats share only their actual canonical runtime shape", () => {
  const withFallback = queueJson.replace('"inputFormat":"stream-json"}',
    '"inputFormat":"stream-json","nativeFallback":{"model":"claude-opus-5","reason":"live_acceptance_required","status":"unavailable"}}');
  for (const format of formats) {
    const input = {
      format, json: queueJson, digest: hash(queueJson),
      queueId: "queue_" + "a".repeat(32), sessionId: "sess_" + "b".repeat(32),
      providerThreadId: "historical-thread", profileGeneration: 1,
    };
    expect(checkQueueEvidenceEnvelope(input).kind).toBe("checked_envelope");
    expect(checkQueueEvidenceEnvelope({ ...input, digest: "0".repeat(64) })).toEqual({ kind: "opaque", reason: "digest_mismatch" });
    for (const field of ["queueId", "sessionId", "providerThreadId", "profileGeneration"] as const) {
      for (const value of [null, undefined, "foreign", 2, "1"]) {
        expect(checkQueueEvidenceEnvelope({ ...input, [field]: value }))
          .toEqual({ kind: "opaque", reason: "parent_mismatch" });
      }
    }
    const result = decodeQueueEvidence({ format, json: withFallback });
    expect(result.kind).toBe(format === "combined49_v1" || format === "private_task48_v1" ? "parsed" : "opaque");
  }
});

test("foreign JSON and format values cannot throw or manufacture an envelope", () => {
  const unsupportedFormat = fc.jsonValue().filter((value) => !historicalEffectEvidenceFormatSchema.safeParse(value).success);
  fc.assert(fc.property(unsupportedFormat, fc.jsonValue(), (format, value) => {
    const json = JSON.stringify(value);
    expect(decodeMutationEvidence({ format, json }).kind).toBe("opaque");
    expect(decodeQueueEvidence({ format, json }).kind).toBe("opaque");
    for (const selected of formats) {
      const result = checkMutationEvidenceEnvelope({
        format: selected, json, digest: null, evidenceKind: null, parentKind: null,
      });
      expect(result.kind).toBe("opaque");
      expect(Object.keys(result).sort()).toEqual(["kind", "reason"]);
    }
  }), { seed: 49043, numRuns: 120 });
});
