import { z } from "zod";

import { reviewedRuntimeProfileV1Schema } from "../domain/runtime-profile";

import { mutationEffectEvidence49Schema, queueEffectEvidence49Schema } from "./effect-evidence-codecs";

// These are source-dialect readers, not writer or provider-effect admission.
// Canonical 40: 6f056dcafd6435cd11ae504c75e9b1f869955ca7
// Canonical 41: 576ccd76a6742cd62759ab6176a6a41844846daa
// Canonical 43: eaf0448e19383ac899c30d0a9cd70bbea71ff8b3
// Canonical Sol 43–46: 97cebc44ecd2d27b8c0b6399b0814b1993d94fc1
// through 0aa3fd563e369f75875136ca1f550016e70035e8 (a distinct source branch).
// Canonical 49: 7ab347813f8d7e4f31e9584752c801dd1ca0cda0
// Private 48: 3f6ac733dc17b3eec881ad98f2d65faadbcbaf37
// Reuse only frozen 49 members and V1 leaves. Preserve archived field order,
// absent optionals and baseline values because their parsed JSON is hashed.
const runtimeProfileCanonicalSchema = reviewedRuntimeProfileV1Schema.refine(
  (value) => !("nativeFallback" in value),
  "This historical runtime format does not include native fallback.",
);
const runtimeProfilePrivate48Schema = reviewedRuntimeProfileV1Schema.refine(
  (value) => !("configHome" in value),
  "This historical runtime format requires Claude's isolated config directory.",
);

const [
  send49Schema,
  steer49Schema,
  stop49Schema,
  rename49Schema,
  start49Schema,
  switch49Schema,
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
] = mutationEffectEvidence49Schema.options;

const sendCanonicalSchema = send49Schema.extend({
  runtimeProfile: runtimeProfileCanonicalSchema.optional(),
});
const startCanonicalSchema = start49Schema.extend({
  runtimeProfile: runtimeProfileCanonicalSchema.optional(),
});
const switchCanonicalSchema = switch49Schema.extend({
  runtimeProfile: runtimeProfileCanonicalSchema,
});

export const mutationEvidenceCanonical40Schema = z.discriminatedUnion("kind", [
  sendCanonicalSchema,
  steer49Schema,
  stop49Schema,
  rename49Schema,
  startCanonicalSchema,
  switchCanonicalSchema,
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
]);

// The unit precedes baseline in both archived declarations. Appending it with
// extend() would accept the same fields but change the canonical digest input.
const providerTimestampUnitCanonical41Schema = z.literal("unix_milliseconds_v1").optional();
const stopCanonical41Schema = z.object({
  kind: stop49Schema.shape.kind,
  providerThreadId: stop49Schema.shape.providerThreadId,
  providerTimestampUnit: providerTimestampUnitCanonical41Schema,
  baseline: stop49Schema.shape.baseline,
  activeTurnId: stop49Schema.shape.activeTurnId,
}).strict();
const renameCanonical41Schema = z.object({
  kind: rename49Schema.shape.kind,
  providerThreadId: rename49Schema.shape.providerThreadId,
  providerTimestampUnit: providerTimestampUnitCanonical41Schema,
  baseline: rename49Schema.shape.baseline,
  requestedName: rename49Schema.shape.requestedName,
}).strict();

export const mutationEvidenceCanonical41Schema = z.discriminatedUnion("kind", [
  sendCanonicalSchema,
  steer49Schema,
  stopCanonical41Schema,
  renameCanonical41Schema,
  startCanonicalSchema,
  switchCanonicalSchema,
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
]);

const messageActorCanonical43Schema = z.enum([
  "human",
  "autorespond",
  "peer_session",
  "provider_switch",
]);
const hostCapabilitiesCanonical43Schema = z.object({
  preambleVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  preambleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  manifestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

// The capability document precedes targetPreset, while messageActor is last.
const {
  targetPreset,
  transcriptDigest,
  seedDigest,
  seedIncludedRecords,
  seedOmittedRecords,
  runtimeProfile,
  ...switchCanonicalPrefix
} = switchCanonicalSchema.shape;
const switchCanonical43Schema = z.object({
  ...switchCanonicalPrefix,
  targetHostCapabilities: hostCapabilitiesCanonical43Schema.optional(),
  targetPreset,
  transcriptDigest,
  seedDigest,
  seedIncludedRecords,
  seedOmittedRecords,
  runtimeProfile,
}).strict();

export const mutationEvidenceCanonical43Schema = z.discriminatedUnion("kind", [
  sendCanonicalSchema.extend({ messageActor: messageActorCanonical43Schema.optional() }),
  steer49Schema.extend({ messageActor: messageActorCanonical43Schema.optional() }),
  stopCanonical41Schema,
  renameCanonical41Schema,
  startCanonicalSchema,
  switchCanonical43Schema,
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
]);

// Canonical main later added explicit preset contracts and retention-gap
// provenance. Freeze that distinct dialect rather than broadening v43 or the
// numerically overlapping private combined49 contract. In both declarations
// each optional field occupies its original canonical digest position.
const canonical49PresetContractSchema = z.union([z.literal(1), z.literal(2)]);
const messageActorCanonical49Schema = z.enum([
  "human", "automation", "autorespond", "peer_session", "provider_switch",
]);
const startCanonical49Schema = z.object({
  kind: startCanonicalSchema.shape.kind,
  projectId: startCanonicalSchema.shape.projectId,
  clientMessageId: startCanonicalSchema.shape.clientMessageId,
  messageDigest: startCanonicalSchema.shape.messageDigest,
  presetContract: canonical49PresetContractSchema.optional(),
  runtimeProfile: startCanonicalSchema.shape.runtimeProfile,
  conversationAutomationCapability: startCanonicalSchema.shape.conversationAutomationCapability,
}).strict();
const switchCanonical49Schema = z.object({
  ...switchCanonicalPrefix,
  targetHostCapabilities: hostCapabilitiesCanonical43Schema.optional(),
  targetPreset,
  presetContract: canonical49PresetContractSchema.optional(),
  transcriptDigest,
  seedDigest,
  seedIncludedRecords,
  seedOmittedRecords,
  seedRetentionGapReason: z.enum([
    "provider_disconnect", "provider_restart", "stream_restored",
    "retention_count", "retention_age", "retention_bytes", "protocol_incompatible",
  ]).optional(),
  runtimeProfile,
}).strict();
export const mutationEvidenceCanonical49Schema = z.discriminatedUnion("kind", [
  sendCanonicalSchema.extend({ messageActor: messageActorCanonical49Schema.optional() }),
  steer49Schema.extend({ messageActor: messageActorCanonical49Schema.optional() }),
  stopCanonical41Schema,
  renameCanonical41Schema,
  startCanonical49Schema,
  switchCanonical49Schema,
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
]);

// Sol's canonical 43–46 branch already carried preset contracts and retention
// gaps, but not message actors or host capabilities. Its physical version does
// not identify the different canonical43 dialect above. Removing only this
// frozen canonical49 field preserves the independently archived key order.
export const mutationEvidenceCanonicalSol43Schema = z.discriminatedUnion("kind", [
  sendCanonicalSchema,
  steer49Schema,
  stopCanonical41Schema,
  renameCanonical41Schema,
  startCanonical49Schema,
  switchCanonical49Schema.omit({ targetHostCapabilities: true }),
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
]);

export const mutationEvidencePrivate48Schema = z.discriminatedUnion("kind", [
  send49Schema.extend({ runtimeProfile: runtimeProfilePrivate48Schema.optional() }),
  steer49Schema,
  stop49Schema,
  rename49Schema,
  start49Schema.extend({ runtimeProfile: runtimeProfilePrivate48Schema.optional() }),
  switch49Schema.omit({ targetProviderAccountKey: true }).extend({
    runtimeProfile: runtimeProfilePrivate48Schema,
  }),
  login49Schema,
  claudeLogin49Schema,
  devinLogin49Schema,
  logout49Schema,
  loginCancel49Schema,
]);

export const queueEvidenceCanonicalSchema = queueEffectEvidence49Schema.extend({
  runtimeProfile: runtimeProfileCanonicalSchema,
});
export const queueEvidencePrivate48Schema = queueEffectEvidence49Schema.extend({
  runtimeProfile: runtimeProfilePrivate48Schema,
});
