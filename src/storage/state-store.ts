import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { Database } from "bun:sqlite";
import { z } from "zod";

import {
  INTERACTION_MAX_PENDING_MS,
  interactionDisplaySchema,
  interactionIntendedTerminalStateSchema,
  interactionKindSchema,
  interactionRecordSchema,
  interactionStateSchema,
  providerInteractionAuthoritySchema,
  type InteractionDisplay,
  type InteractionIntendedTerminalState,
  type InteractionKind,
  type InteractionRecord,
  type ProviderInteractionAuthority,
} from "../domain/interactions";
import { presetSchema, type Preset } from "../domain/presets";
import {
  effectiveRuntimeProfileSchema,
  type EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import {
  storedAccountUsageSnapshotSchema,
} from "../domain/usage-metrics";
import {
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_PAGE_BYTES,
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_RETAIN_AGE_MS,
  SESSION_EVENT_RETAIN_BYTES,
  SESSION_EVENT_RETAIN_COUNT,
  sessionEventBodySchema,
  sessionEventGapReasonSchema,
  sessionEventSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventGapReason,
} from "../domain/session-events";
import {
  canTransitionQueue,
  mutationStateSchema,
  queueStateSchema,
  type MutationState,
  type QueueState,
} from "../domain/transitions";
import {
  attemptIdSchema,
  createAttemptId,
  createProfileId,
  createProjectId,
  createQueueId,
  createSessionId,
  labelSchema,
  noteSchema,
  profileIdSchema,
  projectIdSchema,
  queueIdSchema,
  selectByIdOrLabel,
  sessionIdSchema,
  titleSchema,
  unixMillisecondsSchema,
  type AttemptId,
  type ProfileId,
  type ProjectId,
  type QueueId,
  type SessionId,
} from "../domain/values";
import type { StatePaths } from "./paths";
import type {
  DesktopSwitchGeneration,
  DesktopSwitchJournalEntry,
  DesktopSwitchStage,
} from "../desktop/switch";
import type {
  DesktopRecoveryBinding,
  DesktopRecoveryResolution,
} from "../desktop/recovery";

const profileStateSchema = z.enum(["signed_out", "login_pending", "signed_in", "recovery_required", "removed"]);
const sessionStateSchema = z.enum(["starting", "active", "idle", "terminal", "recovery_required"]);
const runtimeProfileSourceKindSchema = z.enum(["session_start", "turn_start", "queue_start"]);

const profileRowSchema = z.object({
  id: profileIdSchema,
  label: labelSchema,
  state: profileStateSchema,
  process_generation: z.number().int().nonnegative(),
  provider_email: z.string().nullable(),
  provider_plan: z.string().nullable(),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const projectRowSchema = z.object({
  id: projectIdSchema,
  label: labelSchema,
  root_path: z.string().min(1),
  is_default: z.union([z.literal(0), z.literal(1)]),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const sessionRowSchema = z.object({
  id: sessionIdSchema,
  profile_id: profileIdSchema,
  project_id: projectIdSchema.nullable(),
  provider_thread_id: z.string().nullable(),
  title: z.string(),
  note: z.string(),
  preset: presetSchema,
  fast_enabled: z.union([z.literal(0), z.literal(1)]),
  state: sessionStateSchema,
  active_turn_id: z.string().nullable(),
  provider_updated_at: z.number().nonnegative().nullable(),
  revision: z.number().int().positive(),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const sessionRuntimeProfileRowSchema = z.object({
  session_id: sessionIdSchema,
  revision: z.number().int().positive(),
  source_kind: runtimeProfileSourceKindSchema,
  source_id: z.string().min(1).max(200),
  profile_id: profileIdSchema,
  process_generation: z.number().int().nonnegative(),
  observed_at: unixMillisecondsSchema,
  profile_json: z.string().min(2).max(262_144),
  recorded_at: unixMillisecondsSchema,
}).strict();

const sessionTurnRuntimeProfileRowSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: z.string().min(1).max(200),
  source_kind: runtimeProfileSourceKindSchema.exclude(["session_start"]),
  source_id: z.string().min(1).max(200),
  profile_id: profileIdSchema,
  process_generation: z.number().int().nonnegative(),
  observed_at: unixMillisecondsSchema,
  profile_json: z.string().min(2).max(262_144),
  profile_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  recorded_at: unixMillisecondsSchema,
}).strict();

export type ProfileRecord = {
  id: ProfileId;
  label: string;
  state: z.infer<typeof profileStateSchema>;
  processGeneration: number;
  providerEmail?: string;
  providerPlan?: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectRecord = {
  id: ProjectId;
  label: string;
  rootPath: string;
  default: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SessionRecord = {
  id: SessionId;
  profileId: ProfileId;
  projectId?: ProjectId;
  providerThreadId?: string;
  title: string;
  note: string;
  preset: Preset;
  fastEnabled: boolean;
  state: z.infer<typeof sessionStateSchema>;
  activeTurnId?: string;
  providerUpdatedAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionRuntimeProfileRecord = {
  sessionId: SessionId;
  revision: number;
  sourceKind: z.infer<typeof runtimeProfileSourceKindSchema>;
  sourceId: string;
  profile: EffectiveRuntimeProfile;
  recordedAt: number;
};

export type SessionEventStreamPosition = {
  streamEpoch: string;
  floorSequence: number;
  observedThroughSequence: number;
};

export type SessionEventList = SessionEventStreamPosition & {
  gapReason: SessionEventGapReason | null;
  events: readonly SessionEvent[];
};

export type SessionSnapshotWithEventPosition = SessionEventStreamPosition & {
  session: SessionRecord;
};

export type UsageSnapshotRecord = {
  sourceRevision: number;
  observedAt: number;
  payload: unknown;
};

export type UsagePollFailureRecord = {
  sourceRevision: number;
  observedAt: number;
  reasonCode: "account_usage_read_failed";
};

export type QueueRecord = {
  id: QueueId;
  sessionId: SessionId;
  message: string;
  state: QueueState;
  createdAt: number;
  updatedAt: number;
};

export type MutationAttemptRecord = {
  id: AttemptId;
  idempotencyKey: string;
  kind: string;
  authorityId: string;
  authorityGeneration: number;
  requestDigest: string;
  state: MutationState;
  result?: unknown;
  originalState?: Exclude<MutationState, "reconciled">;
  resolution?: MutationResolutionRecord;
  evidence?: MutationEffectEvidenceRecord;
  sessionStartId?: SessionId;
};

export type PendingLoginAuthority = {
  attemptId: AttemptId;
  idempotencyKey: string;
  profileId: ProfileId;
  processGeneration: number;
  loginId: string;
};

export type SessionProviderBaseline = {
  providerUpdatedAt: number | null;
  status: "active" | "idle" | "terminal";
  activeTurnId: string | null;
};

export type MutationEffectEvidence =
  | { kind: "session.send"; providerThreadId: string; baseline: SessionProviderBaseline; clientMessageId: string; messageDigest: string; runtimeProfile?: EffectiveRuntimeProfile }
  | { kind: "session.steer"; providerThreadId: string; baseline: SessionProviderBaseline; activeTurnId: string | null; clientMessageId: string; messageDigest: string }
  | { kind: "session.stop"; providerThreadId: string; baseline: SessionProviderBaseline; activeTurnId: string | null }
  | { kind: "session.rename"; providerThreadId: string; baseline: SessionProviderBaseline; requestedName: string }
  | { kind: "session.start"; projectId: ProjectId; clientMessageId: string | null; messageDigest: string | null; runtimeProfile?: EffectiveRuntimeProfile }
  | { kind: "account.login"; method: "browser" | "device_code" }
  | { kind: "account.logout"; baselineSignedIn: boolean };

export type MutationEffectEvidenceRecord = {
  attemptId: AttemptId;
  digest: string;
  evidence: MutationEffectEvidence;
  recordedAt: number;
};

export type MutationResolutionRecord = {
  kind: "proven_applied" | "provider_state_reconciled" | "abandoned";
  evidence: unknown;
  receipt?: unknown;
  createdAt: number;
};

export type QueueEffectEvidence = {
  kind: "queue.dispatch";
  queueId: QueueId;
  sessionId: SessionId;
  providerThreadId: string;
  profileGeneration: number;
  baseline: SessionProviderBaseline;
  clientMessageId: string;
  messageDigest: string;
  runtimeProfile: EffectiveRuntimeProfile;
};

export type QueueEffectEvidenceRecord = {
  queueId: QueueId;
  digest: string;
  evidence: QueueEffectEvidence;
  recordedAt: number;
  resolution?: { kind: "proven_applied" | "abandoned"; evidence: unknown; receipt?: unknown; createdAt: number };
};

const desktopSwitchPhaseSchema = z.enum([
  "prepared",
  "quit_started",
  "quit_confirmed",
  "launch_started",
  "verify_started",
  "applied",
  "failed",
  "ambiguous",
]);
const desktopSwitchStageSchema = z.enum([
  "prepared",
  "quit-requested",
  "source-quiesced",
  "launch-requested",
  "target-observed",
  "verified",
  "recovery-required",
]);
const desktopDiagnosticSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u);
const desktopAccountKeySchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.normalize("NFKC").toLocaleLowerCase("en-US"));
const positiveGenerationSchema = z.number().int().positive();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerThreadIdSchema = z.string().min(1).max(200);
const providerLoginIdSchema = z.string().min(1).max(512).refine(
  (value) => !/\p{Cc}/u.test(value),
  "Provider login ID contains control characters.",
);
const pendingLoginReceiptAuthoritySchema = z.object({
  status: z.literal("pending"),
  loginId: providerLoginIdSchema,
}).passthrough();
const providerBaselineSchema = z.object({
  providerUpdatedAt: z.number().nonnegative().nullable(),
  status: z.enum(["active", "idle", "terminal"]),
  activeTurnId: z.string().min(1).max(200).nullable(),
}).strict();
const mutationEffectEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session.send"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, clientMessageId: z.string().min(1).max(512), messageDigest: sha256Schema, runtimeProfile: effectiveRuntimeProfileSchema.optional() }).strict(),
  z.object({ kind: z.literal("session.steer"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, activeTurnId: z.string().min(1).max(200).nullable(), clientMessageId: z.string().min(1).max(512), messageDigest: sha256Schema }).strict(),
  z.object({ kind: z.literal("session.stop"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, activeTurnId: z.string().min(1).max(200).nullable() }).strict(),
  z.object({ kind: z.literal("session.rename"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, requestedName: titleSchema }).strict(),
  z.object({ kind: z.literal("session.start"), projectId: projectIdSchema, clientMessageId: z.string().min(1).max(512).nullable(), messageDigest: sha256Schema.nullable(), runtimeProfile: effectiveRuntimeProfileSchema.optional() }).strict(),
  z.object({ kind: z.literal("account.login"), method: z.enum(["browser", "device_code"]) }).strict(),
  z.object({ kind: z.literal("account.logout"), baselineSignedIn: z.boolean() }).strict(),
]);
const queueEffectEvidenceSchema = z.object({
  kind: z.literal("queue.dispatch"),
  queueId: queueIdSchema,
  sessionId: sessionIdSchema,
  providerThreadId: providerThreadIdSchema,
  profileGeneration: z.number().int().nonnegative(),
  baseline: providerBaselineSchema,
  clientMessageId: z.string().min(1).max(512),
  messageDigest: sha256Schema,
  runtimeProfile: effectiveRuntimeProfileSchema,
}).strict();
const mutationResolutionKindSchema = z.enum(["proven_applied", "provider_state_reconciled", "abandoned"]);
const desktopRecoveryResolutionSchema = z.enum(["resolved_applied", "resolved_not_applied"]);
const desktopSwitchBeginSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    requestedSource: z
      .object({
        profileId: profileIdSchema,
        processGeneration: positiveGenerationSchema,
      })
      .strict()
      .optional(),
    target: z
      .object({
        profileId: profileIdSchema,
        processGeneration: positiveGenerationSchema,
      })
      .strict(),
  })
  .strict();

type DesktopSwitchPlan =
  | {
      status: "ready";
      idempotencyKey: string;
      switchGeneration: number;
      sourceProfileId: ProfileId | null;
      sourceProcessGeneration: number | null;
      targetProfileId: ProfileId;
      targetProcessGeneration: number;
      journalStage: "new" | "prepared";
      expectedAccountKey: string;
    }
  | {
      status: "applied";
      idempotencyKey: string;
      switchGeneration: number;
      sourceProfileId: ProfileId | null;
      sourceProcessGeneration: number | null;
      targetProfileId: ProfileId;
      targetProcessGeneration: number;
      expectedAccountKey: string;
      activeAccount: { signedIn: true; email: string; plan?: string };
    }
  | {
      status: "recovery_required";
      idempotencyKey: string;
      switchGeneration: number;
      sourceProfileId: ProfileId | null;
      sourceProcessGeneration: number | null;
      targetProfileId: ProfileId;
      targetProcessGeneration: number;
      diagnostic: string;
    };

const currentSchemaVersion = 17;
const stateBusyTimeoutMs = 5_000;
const securityScrubBusyTimeoutMs = 250;

export const USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS = 24 * 60 * 60_000;
export const USAGE_CLOUD_UPLOAD_ANCHOR_COUNT = 128;
export const USAGE_LOCAL_RETAIN_AGE_MS = 24 * 60 * 60_000;
export const USAGE_LOCAL_RETAIN_SUCCESS_COUNT = 2_048;
export const USAGE_LOCAL_RETAIN_FAILURE_COUNT = 2_048;
export const USAGE_LOCAL_RETAIN_BYTES = 16 * 1_024 * 1_024;
export const USAGE_LOCAL_SNAPSHOT_MAX_BYTES = 262_144;

const schemaVersion1 = `
CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL CHECK(applied_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS daemon_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  boot_id TEXT,
  started_at INTEGER,
  stopped_at INTEGER
) STRICT;
INSERT OR IGNORE INTO daemon_state(singleton, generation) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY CHECK(id GLOB 'acct_[0-9a-f]*' AND length(id) = 37),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK(state IN ('signed_out','login_pending','signed_in','recovery_required','removed')),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  provider_email TEXT,
  provider_plan TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_label_active ON profiles(lower(label)) WHERE state != 'removed';
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY CHECK(id GLOB 'proj_[0-9a-f]*' AND length(id) = 37),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  root_path TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_default_project ON projects(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS projects_label_unique ON projects(lower(label));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY CHECK(id GLOB 'sess_[0-9a-f]*' AND length(id) = 37),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT REFERENCES projects(id),
  provider_thread_id TEXT,
  title TEXT NOT NULL CHECK(length(title) <= 320),
  note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB)) <= 16384),
  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
  fast_enabled INTEGER NOT NULL CHECK(fast_enabled IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('starting','active','idle','terminal','recovery_required')),
  active_turn_id TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(profile_id, provider_thread_id)
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_recent ON sessions(updated_at DESC, id);
CREATE TABLE IF NOT EXISTS queue_entries (
  id TEXT PRIMARY KEY CHECK(id GLOB 'queue_[0-9a-f]*' AND length(id) = 38),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK(length(CAST(message AS BLOB)) BETWEEN 1 AND 262144),
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','applied','failed','ambiguous','cancelled')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE INDEX IF NOT EXISTS queue_pending ON queue_entries(session_id, created_at, id) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS mutation_attempts (
  id TEXT PRIMARY KEY CHECK(id GLOB 'attempt_[0-9a-f]*' AND length(id) = 40),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
  authority_id TEXT NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 200),
  authority_generation INTEGER NOT NULL CHECK(authority_generation >= 0),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','applied','failed','ambiguous','cancelled')),
  result_json TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_snapshots (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= 262144),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  PRIMARY KEY(profile_id, source_revision)
) STRICT;
CREATE TABLE IF NOT EXISTS turn_summaries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  summary_json TEXT NOT NULL CHECK(length(CAST(summary_json AS BLOB)) <= 1048576),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(session_id, turn_id),
  UNIQUE(session_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS desktop_switches (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  source_profile_id TEXT REFERENCES profiles(id),
  target_profile_id TEXT NOT NULL REFERENCES profiles(id),
  source_generation INTEGER,
  target_generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','quit_started','quit_confirmed','launch_started','verify_started','applied','failed','ambiguous')),
  diagnostic_code TEXT,
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS mutation_transition_guard BEFORE UPDATE OF state ON mutation_attempts
WHEN NOT (
  (OLD.state = 'prepared' AND NEW.state IN ('effect_started','cancelled')) OR
  (OLD.state = 'effect_started' AND NEW.state IN ('applied','failed','ambiguous')) OR
  OLD.state = NEW.state
)
BEGIN SELECT RAISE(ABORT, 'illegal mutation transition'); END;
`;

const schemaVersion3 = `
CREATE TABLE IF NOT EXISTS desktop_switch_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  current_generation INTEGER NOT NULL CHECK(current_generation >= 0),
  current_attempt_id TEXT REFERENCES mutation_attempts(id),
  CHECK(
    (current_generation = 0 AND current_attempt_id IS NULL) OR
    (current_generation > 0 AND current_attempt_id IS NOT NULL)
  )
) STRICT;
INSERT OR IGNORE INTO desktop_switch_authority(singleton,current_generation,current_attempt_id)
VALUES (1,0,NULL);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_switch_generation_unique
  ON desktop_switches(switch_generation) WHERE switch_generation IS NOT NULL;
DROP TRIGGER IF EXISTS queue_transition_guard;
CREATE TRIGGER queue_transition_guard BEFORE UPDATE OF state ON queue_entries
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('dispatching','cancelled')) OR
  (OLD.state = 'dispatching' AND NEW.state IN ('applied','failed','ambiguous'))
)
BEGIN SELECT RAISE(ABORT, 'illegal queue transition'); END;
DROP TRIGGER IF EXISTS desktop_switch_transition_guard;
CREATE TRIGGER desktop_switch_transition_guard BEFORE UPDATE OF phase ON desktop_switches
WHEN NOT (
  (OLD.phase = 'prepared' AND NEW.phase IN ('prepared','quit_started','launch_started','ambiguous')) OR
  (OLD.phase = 'quit_started' AND NEW.phase IN ('quit_started','quit_confirmed','ambiguous')) OR
  (OLD.phase = 'quit_confirmed' AND NEW.phase IN ('quit_confirmed','launch_started','ambiguous')) OR
  (OLD.phase = 'launch_started' AND NEW.phase IN ('launch_started','verify_started','ambiguous')) OR
  (OLD.phase = 'verify_started' AND NEW.phase IN ('verify_started','applied','ambiguous')) OR
  OLD.phase = NEW.phase
)
BEGIN SELECT RAISE(ABORT, 'illegal desktop switch transition'); END;
`;

const schemaVersion4 = `
CREATE TABLE IF NOT EXISTS mutation_effect_evidence (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS session_start_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  session_id TEXT NOT NULL UNIQUE CHECK(session_id GLOB 'sess_[0-9a-f]*' AND length(session_id) = 37),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS mutation_resolutions (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('proven_applied','provider_state_reconciled','abandoned')),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 262144),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS mutation_effect_evidence_immutable_update
BEFORE UPDATE ON mutation_effect_evidence
BEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS mutation_effect_evidence_immutable_delete
BEFORE DELETE ON mutation_effect_evidence
BEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_start_attempts_immutable_update
BEFORE UPDATE ON session_start_attempts
BEGIN SELECT RAISE(ABORT, 'session start binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_start_attempts_immutable_delete
BEFORE DELETE ON session_start_attempts
BEGIN SELECT RAISE(ABORT, 'session start binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS mutation_resolutions_immutable_update
BEFORE UPDATE ON mutation_resolutions
BEGIN SELECT RAISE(ABORT, 'mutation resolution is immutable'); END;
CREATE TRIGGER IF NOT EXISTS mutation_resolutions_immutable_delete
BEFORE DELETE ON mutation_resolutions
BEGIN SELECT RAISE(ABORT, 'mutation resolution is immutable'); END;
`;

const schemaVersion5 = `
CREATE TABLE IF NOT EXISTS desktop_switch_resolutions (
  attempt_id TEXT PRIMARY KEY REFERENCES desktop_switches(attempt_id),
  switch_generation INTEGER NOT NULL CHECK(switch_generation > 0),
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('resolved_applied','resolved_not_applied')),
  diagnostic_code TEXT NOT NULL CHECK(diagnostic_code GLOB '[A-Z]*' AND length(diagnostic_code) BETWEEN 1 AND 80),
  observation_digest TEXT NOT NULL CHECK(length(observation_digest) = 64),
  receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 262144),
  resolved_at INTEGER NOT NULL CHECK(resolved_at >= 0)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS desktop_switch_resolution_generation_unique
  ON desktop_switch_resolutions(switch_generation);
CREATE TRIGGER IF NOT EXISTS desktop_switch_resolutions_immutable_update
BEFORE UPDATE ON desktop_switch_resolutions
BEGIN SELECT RAISE(ABORT, 'desktop switch resolution is immutable'); END;
CREATE TRIGGER IF NOT EXISTS desktop_switch_resolutions_immutable_delete
BEFORE DELETE ON desktop_switch_resolutions
BEGIN SELECT RAISE(ABORT, 'desktop switch resolution is immutable'); END;
DROP TRIGGER IF EXISTS desktop_switch_transition_guard;
CREATE TRIGGER desktop_switch_transition_guard BEFORE UPDATE OF phase ON desktop_switches
WHEN NOT (
  (OLD.phase = 'prepared' AND NEW.phase IN ('prepared','quit_started','launch_started','failed','ambiguous')) OR
  (OLD.phase = 'quit_started' AND NEW.phase IN ('quit_started','quit_confirmed','ambiguous')) OR
  (OLD.phase = 'quit_confirmed' AND NEW.phase IN ('quit_confirmed','launch_started','ambiguous')) OR
  (OLD.phase = 'launch_started' AND NEW.phase IN ('launch_started','verify_started','ambiguous')) OR
  (OLD.phase = 'verify_started' AND NEW.phase IN ('verify_started','applied','ambiguous')) OR
  OLD.phase = NEW.phase
)
BEGIN SELECT RAISE(ABORT, 'illegal desktop switch transition'); END;
`;

const schemaVersion6 = `
CREATE TABLE IF NOT EXISTS session_runtime_profiles (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('session_start','turn_start','queue_start')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(session_id, revision),
  UNIQUE(source_kind, source_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS session_runtime_profile_authority_guard
BEFORE INSERT ON session_runtime_profiles
WHEN NOT EXISTS(
  SELECT 1 FROM sessions s
  WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id
)
BEGIN SELECT RAISE(ABORT, 'runtime profile session authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_runtime_profiles_immutable_update
BEFORE UPDATE ON session_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_runtime_profiles_immutable_delete
BEFORE DELETE ON session_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END;
`;

const schemaVersion7 = `
CREATE TABLE IF NOT EXISTS queue_effect_evidence (
  queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS queue_effect_resolutions (
  queue_id TEXT PRIMARY KEY REFERENCES queue_effect_evidence(queue_id),
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('proven_applied','abandoned')),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 262144),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS queue_effect_evidence_immutable_update
BEFORE UPDATE ON queue_effect_evidence
BEGIN SELECT RAISE(ABORT, 'queue effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_effect_evidence_immutable_delete
BEFORE DELETE ON queue_effect_evidence
BEGIN SELECT RAISE(ABORT, 'queue effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_effect_resolutions_immutable_update
BEFORE UPDATE ON queue_effect_resolutions
BEGIN SELECT RAISE(ABORT, 'queue effect resolution is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_effect_resolutions_immutable_delete
BEFORE DELETE ON queue_effect_resolutions
BEGIN SELECT RAISE(ABORT, 'queue effect resolution is immutable'); END;
`;

const schemaVersion8 = `
CREATE TABLE IF NOT EXISTS session_turn_runtime_profiles (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 200),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('turn_start','queue_start')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),
  profile_digest TEXT NOT NULL CHECK(length(profile_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(session_id, turn_id),
  UNIQUE(source_kind, source_id),
  FOREIGN KEY(source_kind, source_id)
    REFERENCES session_runtime_profiles(source_kind, source_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS session_turn_runtime_profile_authority_guard
BEFORE INSERT ON session_turn_runtime_profiles
WHEN NOT EXISTS(
  SELECT 1 FROM session_runtime_profiles p
  WHERE p.session_id=NEW.session_id
    AND p.source_kind=NEW.source_kind
    AND p.source_id=NEW.source_id
    AND p.profile_id=NEW.profile_id
    AND p.process_generation=NEW.process_generation
    AND p.observed_at=NEW.observed_at
    AND p.profile_json=NEW.profile_json
)
BEGIN SELECT RAISE(ABORT, 'turn runtime profile source authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_turn_runtime_profiles_immutable_update
BEFORE UPDATE ON session_turn_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'turn runtime profile is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_turn_runtime_profiles_immutable_delete
BEFORE DELETE ON session_turn_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'turn runtime profile is immutable'); END;
`;

const schemaVersion9 = `
CREATE TABLE IF NOT EXISTS session_event_streams (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  stream_epoch TEXT NOT NULL CHECK(
    length(stream_epoch) = 36
    AND substr(stream_epoch,9,1) = '-'
    AND substr(stream_epoch,14,1) = '-'
    AND substr(stream_epoch,19,1) = '-'
    AND substr(stream_epoch,24,1) = '-'
  ),
  next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991),
  floor_sequence INTEGER NOT NULL CHECK(floor_sequence BETWEEN 1 AND next_sequence),
  observed_through_sequence INTEGER NOT NULL CHECK(
    observed_through_sequence BETWEEN 0 AND 9007199254740991
    AND observed_through_sequence = next_sequence - 1
  ),
  retained_count INTEGER NOT NULL CHECK(retained_count >= 0),
  retained_bytes INTEGER NOT NULL CHECK(retained_bytes >= 0),
  retention_gap_reason TEXT CHECK(retention_gap_reason IS NULL OR retention_gap_reason IN (
    'retention_count','retention_age','retention_bytes'
  )),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(session_id, stream_epoch)
) STRICT;
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  account_id TEXT NOT NULL REFERENCES profiles(id),
  provider_generation INTEGER NOT NULL CHECK(provider_generation >= 0),
  provider_connection_id TEXT CHECK(provider_connection_id IS NULL OR length(provider_connection_id) = 36),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  event_bytes INTEGER NOT NULL CHECK(
    event_bytes = length(CAST(event_json AS BLOB))
    AND event_bytes BETWEEN 2 AND ${SESSION_EVENT_MAX_BYTES}
  ),
  PRIMARY KEY(session_id, sequence),
  FOREIGN KEY(session_id, stream_epoch)
    REFERENCES session_event_streams(session_id, stream_epoch) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS session_events_age
  ON session_events(session_id, recorded_at, sequence);
CREATE TRIGGER IF NOT EXISTS session_events_immutable_update
BEFORE UPDATE ON session_events
BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_events_account_authority_guard
BEFORE INSERT ON session_events
WHEN NOT EXISTS(
  SELECT 1 FROM sessions s JOIN profiles p ON p.id=s.profile_id
  WHERE s.id=NEW.session_id
    AND s.profile_id=NEW.account_id
    AND p.process_generation=NEW.provider_generation
)
BEGIN SELECT RAISE(ABORT, 'session event account authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_events_accounting_insert
AFTER INSERT ON session_events
BEGIN
  UPDATE session_event_streams
  SET retained_count=retained_count+1,
      retained_bytes=retained_bytes+NEW.event_bytes
  WHERE session_id=NEW.session_id AND stream_epoch=NEW.stream_epoch;
END;
CREATE TRIGGER IF NOT EXISTS session_events_accounting_delete
AFTER DELETE ON session_events
BEGIN
  UPDATE session_event_streams
  SET retained_count=retained_count-1,
      retained_bytes=retained_bytes-OLD.event_bytes
  WHERE session_id=OLD.session_id AND stream_epoch=OLD.stream_epoch;
END;

CREATE TABLE IF NOT EXISTS provider_interactions (
  public_id TEXT PRIMARY KEY CHECK(length(public_id) = 36),
  session_id TEXT REFERENCES sessions(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  connection_id TEXT NOT NULL CHECK(length(connection_id) = 36),
  request_id_type TEXT NOT NULL CHECK(request_id_type IN ('number','string')),
  request_id_number INTEGER CHECK(request_id_number IS NULL OR request_id_number BETWEEN -9007199254740991 AND 9007199254740991),
  request_id_text TEXT CHECK(request_id_text IS NULL OR length(request_id_text) BETWEEN 1 AND 512),
  method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 512),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  thread_id TEXT CHECK(thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 512),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 512),
  item_id TEXT CHECK(item_id IS NULL OR length(item_id) BETWEEN 1 AND 512),
  approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK(kind IN (
    'command_approval','file_change_approval','permission_approval','user_input','mcp_elicitation'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'pending','response_prepared','response_written','resolved','declined','canceled','expired','resolution_unknown'
  )),
  revision INTEGER NOT NULL CHECK(revision > 0),
  blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
  display_json TEXT NOT NULL CHECK(json_valid(display_json) AND length(CAST(display_json AS BLOB)) BETWEEN 2 AND 65536),
  response_digest TEXT CHECK(response_digest IS NULL OR length(response_digest) = 64),
  response_expected_revision INTEGER CHECK(response_expected_revision IS NULL OR response_expected_revision > 0),
  requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= requested_at),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= requested_at),
  CHECK(
    (request_id_type='number' AND request_id_number IS NOT NULL AND request_id_text IS NULL)
    OR
    (request_id_type='string' AND request_id_number IS NULL AND request_id_text IS NOT NULL)
  ),
  CHECK(
    (state='pending' AND response_digest IS NULL AND response_expected_revision IS NULL)
    OR
    (state!='pending' AND (
      (response_digest IS NOT NULL AND response_expected_revision IS NOT NULL)
      OR state IN ('resolved','canceled','expired','resolution_unknown')
    ))
  ),
  CHECK(
    (state IN ('pending','response_prepared','response_written') AND terminal_at IS NULL)
    OR
    (state IN ('resolved','declined','canceled','expired','resolution_unknown') AND terminal_at IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS provider_interactions_numeric_request
  ON provider_interactions(profile_id,process_generation,connection_id,request_id_number)
  WHERE request_id_type='number';
CREATE UNIQUE INDEX IF NOT EXISTS provider_interactions_string_request
  ON provider_interactions(profile_id,process_generation,connection_id,request_id_text)
  WHERE request_id_type='string';
CREATE INDEX IF NOT EXISTS provider_interactions_pending
  ON provider_interactions(profile_id,process_generation,requested_at,public_id)
  WHERE state IN ('pending','response_prepared','response_written');
CREATE INDEX IF NOT EXISTS provider_interactions_session
  ON provider_interactions(session_id,requested_at DESC,public_id);
CREATE TRIGGER IF NOT EXISTS provider_interactions_authority_guard
BEFORE INSERT ON provider_interactions
WHEN NOT EXISTS(
  SELECT 1 FROM profiles p
  WHERE p.id=NEW.profile_id
    AND p.process_generation=NEW.process_generation
    AND p.state!='removed'
    AND (
      NEW.session_id IS NULL
      OR EXISTS(
        SELECT 1 FROM sessions s
        WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'provider interaction authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_authority_immutable
BEFORE UPDATE OF session_id,profile_id,process_generation,connection_id,
  request_id_type,request_id_number,request_id_text,method,request_digest,
  thread_id,turn_id,item_id,approval_id,kind,blocking,display_json,requested_at
ON provider_interactions
BEGIN SELECT RAISE(ABORT, 'provider interaction authority is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_current_generation_prepare
BEFORE UPDATE OF state ON provider_interactions
WHEN NEW.state='response_prepared' AND NOT EXISTS(
  SELECT 1 FROM profiles p
  WHERE p.id=OLD.profile_id
    AND p.process_generation=OLD.process_generation
    AND p.state!='removed'
)
BEGIN SELECT RAISE(ABORT, 'provider interaction generation is stale'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_transition_guard
BEFORE UPDATE OF state ON provider_interactions
WHEN NOT (
  NEW.revision=OLD.revision+1
  AND (
    (OLD.state='pending' AND NEW.state IN ('response_prepared','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_prepared' AND NEW.state IN ('response_written','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_written' AND NEW.state IN ('resolved','declined','canceled','resolution_unknown'))
  )
)
BEGIN SELECT RAISE(ABORT, 'illegal provider interaction transition'); END;

CREATE TABLE IF NOT EXISTS provider_interaction_transitions (
  public_id TEXT NOT NULL REFERENCES provider_interactions(public_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN (
    'pending','response_prepared','response_written','resolved','declined','canceled','expired','resolution_unknown'
  )),
  response_digest TEXT CHECK(response_digest IS NULL OR length(response_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(public_id, revision)
) STRICT;
CREATE TRIGGER IF NOT EXISTS provider_interaction_transitions_immutable_update
BEFORE UPDATE ON provider_interaction_transitions
BEGIN SELECT RAISE(ABORT, 'provider interaction transition is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_interaction_transitions_immutable_delete
BEFORE DELETE ON provider_interaction_transitions
BEGIN SELECT RAISE(ABORT, 'provider interaction transition is immutable'); END;

CREATE TABLE IF NOT EXISTS usage_revision_authority (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  next_revision INTEGER NOT NULL CHECK(next_revision BETWEEN 0 AND 9007199254740991)
) STRICT;
`;

const schemaVersion10 = `
CREATE TABLE IF NOT EXISTS usage_poll_failures (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('account_usage_read_failed')),
  PRIMARY KEY(profile_id, source_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS usage_poll_failures_recent
  ON usage_poll_failures(profile_id, observed_at DESC, source_revision DESC);
`;

const schemaVersion11 = `
CREATE TRIGGER IF NOT EXISTS provider_interactions_mcp_url_guard_insert
BEFORE INSERT ON provider_interactions
WHEN NEW.kind='mcp_elicitation' AND (
  json_extract(NEW.display_json,'$.mode')='url'
  OR COALESCE(json_type(NEW.display_json,'$.url'),'null')!='null'
)
BEGIN SELECT RAISE(ABORT, 'MCP URL interaction cannot enter durable state'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_mcp_url_guard_update
BEFORE UPDATE OF kind,display_json ON provider_interactions
WHEN NEW.kind='mcp_elicitation' AND (
  json_extract(NEW.display_json,'$.mode')='url'
  OR COALESCE(json_type(NEW.display_json,'$.url'),'null')!='null'
)
BEGIN SELECT RAISE(ABORT, 'MCP URL interaction cannot enter durable state'); END;
`;

const schemaVersion12 = `
CREATE TABLE IF NOT EXISTS usage_cloud_upload_anchors (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  received_at INTEGER NOT NULL CHECK(received_at >= 0),
  PRIMARY KEY(profile_id, source_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS usage_cloud_upload_anchors_recent
  ON usage_cloud_upload_anchors(profile_id, source_revision DESC);
`;

const schemaVersion13 = `
CREATE TABLE IF NOT EXISTS security_scrub_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  reason TEXT NOT NULL CHECK(reason='mcp_url_redaction'),
  required_at INTEGER NOT NULL CHECK(required_at >= 0)
) STRICT;
`;

const schemaVersion14 = `
CREATE TABLE IF NOT EXISTS queue_sequence_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991)
) STRICT;
INSERT INTO queue_sequence_authority(singleton,next_sequence)
SELECT 1,1 WHERE NOT EXISTS(SELECT 1 FROM queue_sequence_authority WHERE singleton=1);
CREATE UNIQUE INDEX IF NOT EXISTS queue_enqueue_sequence_unique
  ON queue_entries(enqueue_sequence);
CREATE INDEX IF NOT EXISTS queue_pending_sequence
  ON queue_entries(session_id,enqueue_sequence) WHERE state='pending';
CREATE TRIGGER IF NOT EXISTS queue_enqueue_sequence_required
BEFORE INSERT ON queue_entries
WHEN NEW.enqueue_sequence IS NULL
BEGIN SELECT RAISE(ABORT, 'queue enqueue sequence required'); END;
CREATE TRIGGER IF NOT EXISTS queue_enqueue_identity_insert_once
BEFORE INSERT ON queue_entries
WHEN EXISTS(
  SELECT 1 FROM queue_entries
  WHERE id=NEW.id OR enqueue_sequence=NEW.enqueue_sequence
)
BEGIN SELECT RAISE(ABORT, 'queue enqueue identity already exists'); END;
CREATE TRIGGER IF NOT EXISTS queue_enqueue_sequence_immutable
BEFORE UPDATE OF enqueue_sequence ON queue_entries
WHEN NEW.enqueue_sequence IS NOT OLD.enqueue_sequence
BEGIN SELECT RAISE(ABORT, 'queue enqueue sequence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_no_delete
BEFORE DELETE ON queue_sequence_authority
BEGIN SELECT RAISE(ABORT, 'queue sequence authority cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_insert_once
BEFORE INSERT ON queue_sequence_authority
WHEN EXISTS(SELECT 1 FROM queue_sequence_authority WHERE singleton=1)
BEGIN SELECT RAISE(ABORT, 'queue sequence authority already exists'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_singleton_immutable
BEFORE UPDATE OF singleton ON queue_sequence_authority
WHEN NEW.singleton IS NOT OLD.singleton
BEGIN SELECT RAISE(ABORT, 'queue sequence authority singleton is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_monotonic
BEFORE UPDATE OF next_sequence ON queue_sequence_authority
WHEN NEW.next_sequence<OLD.next_sequence
BEGIN SELECT RAISE(ABORT, 'queue sequence authority cannot regress'); END;
`;

const schemaVersion15 = `
CREATE TRIGGER IF NOT EXISTS provider_interactions_permission_value_guard_insert
BEFORE INSERT ON provider_interactions
WHEN NEW.kind='permission_approval' AND EXISTS(
  SELECT 1 FROM json_each(json_extract(NEW.display_json,'$.requested'))
  WHERE json_type(value,'$.value') IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'permission values cannot enter durable interaction display state'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_permission_value_guard_update
BEFORE UPDATE OF kind,display_json ON provider_interactions
WHEN NEW.kind='permission_approval' AND EXISTS(
  SELECT 1 FROM json_each(json_extract(NEW.display_json,'$.requested'))
  WHERE json_type(value,'$.value') IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'permission values cannot enter durable interaction display state'); END;
`;

const schemaVersion16 = `
CREATE INDEX IF NOT EXISTS provider_interactions_due
  ON provider_interactions(deadline_at,public_id)
  WHERE state='pending';
DROP TRIGGER IF EXISTS provider_interactions_authority_immutable;
CREATE TRIGGER provider_interactions_authority_immutable
BEFORE UPDATE OF session_id,profile_id,process_generation,connection_id,
  request_id_type,request_id_number,request_id_text,method,request_digest,
  thread_id,turn_id,item_id,approval_id,kind,blocking,display_json,requested_at,deadline_at
ON provider_interactions
BEGIN SELECT RAISE(ABORT, 'provider interaction authority is immutable'); END;
DROP TRIGGER IF EXISTS provider_interactions_transition_guard;
CREATE TRIGGER provider_interactions_transition_guard
BEFORE UPDATE OF state ON provider_interactions
WHEN NOT (
  NEW.revision=OLD.revision+1
  AND (
    (OLD.state='pending' AND NEW.state IN ('response_prepared','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_prepared' AND NEW.state IN ('response_written','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_written' AND NEW.state IN ('resolved','declined','canceled','expired','resolution_unknown'))
  )
)
BEGIN SELECT RAISE(ABORT, 'illegal provider interaction transition'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_intent_insert_guard
BEFORE INSERT ON provider_interactions
WHEN NEW.intended_terminal_state IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'pending provider interaction cannot have terminal intent'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_intent_immutable
BEFORE UPDATE OF intended_terminal_state ON provider_interactions
WHEN OLD.intended_terminal_state IS NOT NULL
  OR NEW.intended_terminal_state IS NULL
  OR OLD.state!='pending'
BEGIN SELECT RAISE(ABORT, 'provider interaction terminal intent is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_intent_state_guard
BEFORE UPDATE OF state,intended_terminal_state ON provider_interactions
WHEN
  (NEW.state IN ('response_prepared','response_written') AND NEW.intended_terminal_state IS NULL)
  OR (
    OLD.state='response_written'
    AND NEW.state IN ('resolved','declined','canceled','expired')
    AND NEW.state IS NOT OLD.intended_terminal_state
  )
BEGIN SELECT RAISE(ABORT, 'provider interaction terminal state contradicts prepared intent'); END;
`;

const schemaVersion17 = `
CREATE TABLE IF NOT EXISTS provider_login_authorities (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation > 0),
  login_id TEXT NOT NULL CHECK(length(login_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK(state IN ('active','settled')),
  settlement TEXT CHECK(settlement IS NULL OR settlement IN ('canceled','not_found','signed_in','provider_disconnected')),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= recorded_at),
  CHECK((state='active' AND settlement IS NULL) OR (state='settled' AND settlement IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS provider_login_authority_active_profile
  ON provider_login_authorities(profile_id) WHERE state='active';
CREATE TRIGGER IF NOT EXISTS provider_login_authority_identity_immutable
BEFORE UPDATE OF attempt_id,profile_id,login_id,recorded_at ON provider_login_authorities
BEGIN SELECT RAISE(ABORT, 'provider login identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_login_authority_generation_guard
BEFORE UPDATE OF process_generation ON provider_login_authorities
WHEN OLD.state!='active' OR NEW.state!='active' OR NEW.process_generation!=OLD.process_generation+1
BEGIN SELECT RAISE(ABORT, 'illegal provider login generation transition'); END;
CREATE TRIGGER IF NOT EXISTS provider_login_authority_state_guard
BEFORE UPDATE OF state,settlement ON provider_login_authorities
WHEN NOT (
  OLD.state='active' AND NEW.state='settled' AND OLD.settlement IS NULL AND NEW.settlement IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'illegal provider login settlement transition'); END;
CREATE TRIGGER IF NOT EXISTS provider_login_authority_immutable_delete
BEFORE DELETE ON provider_login_authorities
BEGIN SELECT RAISE(ABORT, 'provider login authority is append-only'); END;
`;

const userVersionSchema = z.object({ user_version: z.number().int().nonnegative() }).strict();

const securityScrubAuthorityRowSchema = z.object({
  reason: z.literal("mcp_url_redaction"),
  required_at: unixMillisecondsSchema,
}).strict();

const walCheckpointRowSchema = z.object({
  busy: z.number().int().min(0).max(1),
  log: z.number().int().nonnegative(),
  checkpointed: z.number().int().nonnegative(),
}).strict();

const journalModeRowSchema = z.object({ journal_mode: z.string() }).strict();

const requireWalMode = (database: Database, configure = false): void => {
  const row = journalModeRowSchema.parse(
    database.query(configure ? "PRAGMA journal_mode=WAL" : "PRAGMA journal_mode").get(),
  );
  if (row.journal_mode.toLowerCase() !== "wal") throw new Error("STATE_WAL_REQUIRED");
};

const readUserVersion = (database: Database): number =>
  userVersionSchema.parse(database.query("PRAGMA user_version").get()).user_version;

const hasPendingSecurityScrub = (database: Database): boolean => {
  const row = database.query(
    "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
  ).get();
  if (row === null) return false;
  securityScrubAuthorityRowSchema.parse(row);
  return true;
};

const requireSecurityScrub = (database: Database, requiredAt: number): void => {
  database.query(
    `INSERT OR IGNORE INTO security_scrub_authority(singleton,reason,required_at)
     VALUES (1,'mcp_url_redaction',?)`,
  ).run(unixMillisecondsSchema.parse(requiredAt));
};

const completePendingSecurityScrub = (database: Database): void => {
  if (!hasPendingSecurityScrub(database)) return;
  database.exec(`PRAGMA busy_timeout = ${securityScrubBusyTimeoutMs}`);
  try {
    const truncateWal = (): void => {
      requireWalMode(database);
      const checkpoint = walCheckpointRowSchema.parse(
        database.query("PRAGMA wal_checkpoint(TRUNCATE)").get(),
      );
      if (checkpoint.busy !== 0 || checkpoint.log !== 0 || checkpoint.checkpointed !== 0) {
        throw new Error("SQLite could not truncate every WAL frame.");
      }
    };

    // The first truncation makes the durable marker and latest logical rows the
    // sole main-file truth. VACUUM then rebuilds every page, including free
    // space left by an earlier secure_delete=OFF migration. The final truncation
    // removes pages emitted by the rebuild before the authority can be cleared.
    truncateWal();
    database.exec("VACUUM");
    truncateWal();
    database.transaction(() => {
      database.query("DELETE FROM security_scrub_authority WHERE singleton=1").run();
    }).immediate();
  } catch (cause) {
    throw new Error("STATE_SECURITY_SCRUB_REQUIRED", { cause });
  } finally {
    database.exec(`PRAGMA busy_timeout = ${stateBusyTimeoutMs}`);
  }
};

const hasTableColumn = (database: Database, table: string, column: string): boolean => {
  const columnSchema = z.object({ name: z.string() }).passthrough();
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Unsafe SQLite table identifier.");
  return database.query(`PRAGMA table_info(${table})`).all().some((row) => columnSchema.parse(row).name === column);
};

const ensureStableQueueSequence = (database: Database): void => {
  if (!hasTableColumn(database, "queue_entries", "enqueue_sequence")) {
    database.exec(
      "ALTER TABLE queue_entries ADD COLUMN enqueue_sequence INTEGER CHECK(enqueue_sequence IS NULL OR enqueue_sequence BETWEEN 1 AND 9007199254740990)",
    );
  }
  database.exec(`
    WITH ordered AS (
      SELECT rowid,ROW_NUMBER() OVER (ORDER BY rowid) AS enqueue_sequence
      FROM queue_entries
    )
    UPDATE queue_entries
    SET enqueue_sequence=(
      SELECT ordered.enqueue_sequence FROM ordered WHERE ordered.rowid=queue_entries.rowid
    )
    WHERE enqueue_sequence IS NULL;
  `);
  database.exec(schemaVersion14);
  const exhausted = database.query(
    "SELECT 1 FROM queue_entries WHERE enqueue_sequence>=9007199254740991 LIMIT 1",
  ).get();
  if (exhausted !== null) throw new Error("QUEUE_SEQUENCE_EXHAUSTED");
  database.query(
    `UPDATE queue_sequence_authority
     SET next_sequence=MAX(
       next_sequence,
       COALESCE((SELECT MAX(enqueue_sequence) FROM queue_entries),0)+1
     )
     WHERE singleton=1`,
  ).run();
};

const backfillExactTurnRuntimeProfiles = (database: Database, now: number): void => {
  const rows = [
    ...database.query(`SELECT p.*,CASE
        WHEN m.state='applied' THEN json_extract(m.result_json,'$.turnId')
        WHEN r.resolution_kind='proven_applied' THEN json_extract(r.receipt_json,'$.turnId')
        ELSE NULL END AS turn_id
      FROM session_runtime_profiles p
      JOIN mutation_attempts m ON m.id=p.source_id AND p.source_kind='turn_start'
      LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id`).all(),
    ...database.query(`SELECT p.*,CASE
        WHEN r.resolution_kind='proven_applied' THEN json_extract(r.receipt_json,'$.turnId')
        ELSE NULL END AS turn_id
      FROM session_runtime_profiles p
      JOIN queue_entries q ON q.id=p.source_id AND p.source_kind='queue_start'
      LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id`).all(),
  ];
  for (const row of rows) {
    const parsed = sessionRuntimeProfileRowSchema.extend({
      turn_id: z.string().min(1).max(200).nullable(),
    }).parse(row);
    if (parsed.turn_id === null || parsed.source_kind === "session_start") continue;
    const profile = effectiveRuntimeProfileSchema.parse(JSON.parse(parsed.profile_json) as unknown);
    if (
      profile.profileId !== parsed.profile_id
      || profile.processGeneration !== parsed.process_generation
      || profile.observedAt !== parsed.observed_at
    ) throw new Error("Stored runtime profile authority is incoherent.");
    database.query(
      `INSERT INTO session_turn_runtime_profiles(
         session_id,turn_id,source_kind,source_id,profile_id,process_generation,
         observed_at,profile_json,profile_digest,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      parsed.session_id,
      parsed.turn_id,
      parsed.source_kind,
      parsed.source_id,
      parsed.profile_id,
      parsed.process_generation,
      parsed.observed_at,
      parsed.profile_json,
      createHash("sha256").update(parsed.profile_json).digest("hex"),
      now,
    );
  }
};

const backfillSchemaVersion9 = (database: Database, now: number): void => {
  const sessions = database.query(
    "SELECT id FROM sessions WHERE NOT EXISTS(SELECT 1 FROM session_event_streams e WHERE e.session_id=sessions.id) ORDER BY id",
  ).all();
  for (const row of sessions) {
    const sessionId = z.object({ id: sessionIdSchema }).strict().parse(row).id;
    database.query(
      `INSERT OR IGNORE INTO session_event_streams(
         session_id,stream_epoch,next_sequence,floor_sequence,observed_through_sequence,
         retained_count,retained_bytes,retention_gap_reason,created_at,updated_at
       ) VALUES (?,?,1,1,0,0,0,NULL,?,?)`,
    ).run(sessionId, randomUUID(), now, now);
  }
  database.exec(`INSERT OR IGNORE INTO usage_revision_authority(profile_id,next_revision)
                 SELECT p.id,CASE
                   WHEN MAX(u.source_revision) IS NULL THEN 1
                   WHEN MAX(u.source_revision)>=9007199254740991 THEN 9007199254740991
                   ELSE MAX(u.source_revision)+1
                 END
                 FROM profiles p LEFT JOIN usage_snapshots u ON u.profile_id=p.id
                 GROUP BY p.id`);
};

const backfillSchemaVersion10 = (database: Database): void => {
  database.exec(`UPDATE usage_revision_authority
                 SET next_revision=MAX(
                   next_revision,
                   COALESCE((
                     SELECT CASE
                       WHEN MAX(f.source_revision)>=9007199254740991 THEN 9007199254740991
                       ELSE MAX(f.source_revision)+1
                     END
                     FROM usage_poll_failures f
                     WHERE f.profile_id=usage_revision_authority.profile_id
                   ),1)
                 )`);
};

const migratedMcpUrlDisplayJson = JSON.stringify(interactionDisplaySchema.parse({
  kind: "mcp_elicitation",
  summary: "Unsupported MCP browser handoff canceled during security migration",
  serverName: "redacted",
  mode: "form",
  url: null,
  mayContainSecrets: true,
}));

const legacyMcpUrlInteractionRowSchema = z.object({
  public_id: z.string().uuid(),
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  requested_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const redactLegacyMcpUrlInteractions = (database: Database, migratedAt: number): boolean => {
  const rows = database.query(
    `SELECT public_id,state,revision,requested_at,updated_at
     FROM provider_interactions
     WHERE kind='mcp_elicitation' AND (
       json_extract(display_json,'$.mode')='url'
       OR COALESCE(json_type(display_json,'$.url'),'null')!='null'
     )
     ORDER BY public_id`,
  ).all().map((row) => legacyMcpUrlInteractionRowSchema.parse(row));
  if (rows.length === 0) return false;

  database.exec("DROP TRIGGER IF EXISTS provider_interactions_authority_immutable");
  for (const row of rows) {
    const terminalAt = Math.max(migratedAt, row.requested_at, row.updated_at);
    if (row.state === "pending" || row.state === "response_prepared" || row.state === "response_written") {
      database.query(
        `UPDATE provider_interactions
         SET state='resolution_unknown',revision=revision+1,display_json=?,updated_at=?,terminal_at=?
         WHERE public_id=? AND revision=?`,
      ).run(migratedMcpUrlDisplayJson, terminalAt, terminalAt, row.public_id, row.revision);
      const migrated = legacyMcpUrlInteractionRowSchema.parse(database.query(
        `SELECT public_id,state,revision,requested_at,updated_at
         FROM provider_interactions WHERE public_id=?`,
      ).get(row.public_id));
      database.query(
        `INSERT INTO provider_interaction_transitions(
           public_id,revision,state,response_digest,recorded_at
         ) SELECT public_id,revision,state,response_digest,?
           FROM provider_interactions WHERE public_id=?`,
      ).run(migrated.updated_at, migrated.public_id);
    } else {
      database.query(
        "UPDATE provider_interactions SET display_json=? WHERE public_id=? AND revision=?",
      ).run(migratedMcpUrlDisplayJson, row.public_id, row.revision);
    }
  }
  database.exec(schemaVersion9);
  return true;
};

const legacyPermissionDisplaySchema = z.object({
  kind: z.literal("permission_approval"),
  summary: z.string().max(4_096),
  reason: z.string().max(4_096).nullable(),
  requested: z.array(z.object({
    name: z.string().min(1).max(256),
    value: z.unknown(),
  }).strict()).max(100),
  allowsSessionScope: z.boolean(),
}).strict();

const legacyPermissionInteractionRowSchema = z.object({
  public_id: z.string().uuid(),
  display_json: z.string(),
}).strict();

const redactLegacyPermissionValues = (database: Database): boolean => {
  const rows = database.query(
    `SELECT public_id,display_json
     FROM provider_interactions
     WHERE kind='permission_approval' AND EXISTS(
       SELECT 1 FROM json_each(json_extract(display_json,'$.requested'))
       WHERE json_type(value,'$.value') IS NOT NULL
     )
     ORDER BY public_id`,
  ).all().map((row) => legacyPermissionInteractionRowSchema.parse(row));
  if (rows.length === 0) return false;

  database.exec("DROP TRIGGER IF EXISTS provider_interactions_authority_immutable");
  for (const row of rows) {
    const legacy = legacyPermissionDisplaySchema.parse(JSON.parse(row.display_json));
    const display = interactionDisplaySchema.parse({
      ...legacy,
      requested: legacy.requested.map(({ name }) => ({ name })),
    });
    database.query(
      "UPDATE provider_interactions SET display_json=? WHERE public_id=?",
    ).run(JSON.stringify(display), row.public_id);
  }
  database.exec(schemaVersion9);
  return true;
};

const usageSnapshotReceivedAt = (snapshot: UsageSnapshotRecord): number => {
  const parsed = storedAccountUsageSnapshotSchema.safeParse(snapshot.payload);
  return parsed.success ? parsed.data.observation.receivedAt : snapshot.observedAt;
};

const recordUsageCloudUploadAnchor = (
  database: Database,
  profileId: ProfileId,
  sourceRevision: number,
  receivedAt: number,
): void => {
  const latest = database.query(
    `SELECT source_revision,received_at FROM usage_cloud_upload_anchors
     WHERE profile_id=? ORDER BY source_revision DESC LIMIT 1`,
  ).get(profileId) as { source_revision: number; received_at: number } | null;
  if (
    latest !== null
    && (
      sourceRevision <= latest.source_revision
      || receivedAt < latest.received_at + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS
    )
  ) return;
  database.query(
    `INSERT OR IGNORE INTO usage_cloud_upload_anchors(
       profile_id,source_revision,received_at
     ) VALUES (?,?,?)`,
  ).run(profileId, sourceRevision, receivedAt);
  database.query(
    `DELETE FROM usage_cloud_upload_anchors WHERE rowid IN (
       SELECT rowid FROM usage_cloud_upload_anchors WHERE profile_id=?
       ORDER BY source_revision DESC
       LIMIT -1 OFFSET ${USAGE_CLOUD_UPLOAD_ANCHOR_COUNT}
     )`,
  ).run(profileId);
};

const backfillUsageCloudUploadAnchors = (database: Database): void => {
  const profiles = database.query("SELECT id FROM profiles ORDER BY id").all();
  for (const row of profiles) {
    const profileId = z.object({ id: profileIdSchema }).strict().parse(row).id;
    const snapshots = database.query(
      `SELECT source_revision,observed_at,payload_json FROM usage_snapshots
       WHERE profile_id=? ORDER BY source_revision`,
    ).all(profileId);
    for (const snapshotRow of snapshots) {
      const parsed = z.object({
        source_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        payload_json: z.string(),
      }).strict().parse(snapshotRow);
      recordUsageCloudUploadAnchor(
        database,
        profileId,
        parsed.source_revision,
        usageSnapshotReceivedAt({
          observedAt: parsed.observed_at,
          payload: JSON.parse(parsed.payload_json) as unknown,
          sourceRevision: parsed.source_revision,
        }),
      );
    }
  }
};

const pruneProfileUsageHistory = (
  database: Database,
  profileId: ProfileId,
  now: number,
): void => {
  const cutoff = Math.max(0, now - USAGE_LOCAL_RETAIN_AGE_MS);
  database.query(
    `DELETE FROM usage_snapshots
     WHERE profile_id=?
       AND CASE
         WHEN json_type(payload_json,'$.observation.receivedAt')='integer'
           THEN json_extract(payload_json,'$.observation.receivedAt')
         ELSE observed_at
       END<?`,
  ).run(profileId, cutoff);
  database.query(
    "DELETE FROM usage_poll_failures WHERE profile_id=? AND observed_at<?",
  ).run(profileId, cutoff);
  database.query(
    `DELETE FROM usage_snapshots WHERE rowid IN (
       SELECT rowid FROM usage_snapshots WHERE profile_id=?
       ORDER BY CASE
         WHEN json_type(payload_json,'$.observation.receivedAt')='integer'
           THEN json_extract(payload_json,'$.observation.receivedAt')
         ELSE observed_at
       END DESC,source_revision DESC
       LIMIT -1 OFFSET ${USAGE_LOCAL_RETAIN_SUCCESS_COUNT}
     )`,
  ).run(profileId);
  database.query(
    `DELETE FROM usage_poll_failures WHERE rowid IN (
       SELECT rowid FROM usage_poll_failures WHERE profile_id=?
       ORDER BY observed_at DESC,source_revision DESC
       LIMIT -1 OFFSET ${USAGE_LOCAL_RETAIN_FAILURE_COUNT}
     )`,
  ).run(profileId);
  database.query(
    `DELETE FROM usage_snapshots WHERE rowid IN (
       SELECT rowid FROM (
         SELECT
           rowid,
           SUM(length(CAST(payload_json AS BLOB))) OVER (
             ORDER BY CASE
               WHEN json_type(payload_json,'$.observation.receivedAt')='integer'
                 THEN json_extract(payload_json,'$.observation.receivedAt')
               ELSE observed_at
             END DESC,source_revision DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS retained_bytes
         FROM usage_snapshots
         WHERE profile_id=?
       )
       WHERE retained_bytes>?
     )`,
  ).run(profileId, USAGE_LOCAL_RETAIN_BYTES);
};

const pruneAllUsageHistory = (database: Database, now: number): void => {
  const rows = database.query("SELECT id FROM profiles ORDER BY id").all();
  for (const row of rows) {
    const profileId = z.object({ id: profileIdSchema }).strict().parse(row).id;
    pruneProfileUsageHistory(database, profileId, now);
  }
};

const migrateWritableDatabase = (database: Database, now: () => number): void => {
  const initialVersion = readUserVersion(database);
  if (initialVersion > currentSchemaVersion) {
    throw new Error(`STATE_SCHEMA_NEWER:${initialVersion}:${currentSchemaVersion}`);
  }

  // Security migrations may replace secret-bearing legacy records. SQLite must
  // overwrite superseded cell content instead of leaving it in free pages.
  database.exec("PRAGMA secure_delete = ON");
  const securityScrubPending = database.transaction(() => {
    let redacted = false;
    let version = initialVersion;
    // v9-v12 databases may have committed URL-bearing MCP records or their
    // superseded bytes without retaining evidence that WAL truncation finished.
    // Materializing the v13 authority inside this transaction makes the byte
    // purge independently retryable from the interaction state transition.
    // v14 also forces previously stamped v13 databases through this authority
    // and installs stable queue ordering before the physical rebuild.
    database.exec(schemaVersion13);
    if (initialVersion >= 9 && initialVersion < 14) requireSecurityScrub(database, now());
    if (version < 1) {
      database.exec(schemaVersion1);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(1, now());
      database.exec("PRAGMA user_version = 1");
      version = 1;
    }

    // A few pre-release v1 fixtures contained only the then-reachable subset
    // of the schema. Reapplying the canonical CREATE IF NOT EXISTS statements
    // materializes the omitted tables without rewriting existing objects.
    database.exec(schemaVersion1);

    if (version < 2) {
      // Early development builds accidentally stamped this column as schema v1.
      // Accept those databases without weakening the canonical append-only v1→v2 path.
      if (!hasTableColumn(database, "sessions", "provider_updated_at")) {
        database.exec("ALTER TABLE sessions ADD COLUMN provider_updated_at REAL CHECK(provider_updated_at IS NULL OR provider_updated_at >= 0)");
      }
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(2, now());
      database.exec("PRAGMA user_version = 2");
      version = 2;
    }

    if (version < 3) {
      const desktopColumns = [
        ["switch_generation", "INTEGER CHECK(switch_generation IS NULL OR switch_generation > 0)"],
        ["journal_prepared", "INTEGER NOT NULL DEFAULT 1 CHECK(journal_prepared IN (0,1))"],
        ["journal_digest", "TEXT CHECK(journal_digest IS NULL OR length(journal_digest) = 64)"],
        ["bundle_cd_hash", "TEXT"],
        ["source_pid", "INTEGER CHECK(source_pid IS NULL OR source_pid > 0)"],
        ["expected_account_key", "TEXT"],
        ["launched_pid", "INTEGER CHECK(launched_pid IS NULL OR launched_pid > 0)"],
      ] as const;
      for (const [name, declaration] of desktopColumns) {
        if (!hasTableColumn(database, "desktop_switches", name)) {
          database.exec(`ALTER TABLE desktop_switches ADD COLUMN ${name} ${declaration}`);
        }
      }
      database.exec(schemaVersion3);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(3, now());
      database.exec("PRAGMA user_version = 3");
      version = 3;
    }

    if (version < 4) {
      database.exec(schemaVersion4);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(4, now());
      database.exec("PRAGMA user_version = 4");
      version = 4;
    }

    if (version < 5) {
      const desktopRecoveryColumns = [
        ["ambiguous_from_phase", "TEXT CHECK(ambiguous_from_phase IS NULL OR ambiguous_from_phase IN ('prepared','quit_started','quit_confirmed','launch_started','verify_started'))"],
        ["recovery_deadline_at", "INTEGER CHECK(recovery_deadline_at IS NULL OR recovery_deadline_at >= 0)"],
      ] as const;
      for (const [name, declaration] of desktopRecoveryColumns) {
        if (!hasTableColumn(database, "desktop_switches", name)) {
          database.exec(`ALTER TABLE desktop_switches ADD COLUMN ${name} ${declaration}`);
        }
      }
      if (!hasTableColumn(database, "desktop_switch_authority", "released_generation")) {
        database.exec("ALTER TABLE desktop_switch_authority ADD COLUMN released_generation INTEGER NOT NULL DEFAULT 0 CHECK(released_generation >= 0 AND released_generation <= current_generation)");
      }
      database.exec(schemaVersion5);
      database.exec("UPDATE desktop_switches SET recovery_deadline_at=updated_at+30000 WHERE journal_prepared=1 AND recovery_deadline_at IS NULL");
      database.exec(`UPDATE desktop_switch_authority
                     SET released_generation=current_generation
                     WHERE current_attempt_id IS NOT NULL
                       AND EXISTS(
                         SELECT 1 FROM mutation_attempts m
                         JOIN desktop_switches d ON d.attempt_id=m.id
                         WHERE m.id=desktop_switch_authority.current_attempt_id
                           AND ((m.state='applied' AND d.phase='applied') OR m.state='cancelled' OR (m.state='failed' AND d.phase='failed'))
                       )`);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(5, now());
      database.exec("PRAGMA user_version = 5");
      version = 5;
    }

    if (version < 6) {
      database.exec(schemaVersion6);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(6, now());
      database.exec("PRAGMA user_version = 6");
      version = 6;
    }

    if (version < 7) {
      database.exec(schemaVersion7);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(7, now());
      database.exec("PRAGMA user_version = 7");
      version = 7;
    }

    if (version < 8) {
      database.exec(schemaVersion8);
      const migratedAt = now();
      backfillExactTurnRuntimeProfiles(database, migratedAt);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(8, migratedAt);
      database.exec("PRAGMA user_version = 8");
      version = 8;
    }

    if (version < 9) {
      database.exec(schemaVersion9);
      const migratedAt = now();
      backfillSchemaVersion9(database, migratedAt);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(9, migratedAt);
      database.exec("PRAGMA user_version = 9");
      version = 9;
    }

    if (version < 10) {
      database.exec(schemaVersion10);
      backfillSchemaVersion10(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(10, now());
      database.exec("PRAGMA user_version = 10");
      version = 10;
    }

    if (version < 11) {
      const migratedAt = now();
      redacted = redactLegacyMcpUrlInteractions(database, migratedAt);
      database.exec(schemaVersion11);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(11, migratedAt);
      database.exec("PRAGMA user_version = 11");
      version = 11;
    }

    if (version < 12) {
      database.exec(schemaVersion12);
      backfillUsageCloudUploadAnchors(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(12, now());
      database.exec("PRAGMA user_version = 12");
      version = 12;
    }

    if (version < 13) {
      database.exec(schemaVersion13);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(13, now());
      database.exec("PRAGMA user_version = 13");
      version = 13;
    }

    if (version < 14) {
      ensureStableQueueSequence(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(14, now());
      database.exec("PRAGMA user_version = 14");
      version = 14;
    }

    if (version < 15) {
      redacted = redactLegacyPermissionValues(database) || redacted;
      if (redacted) requireSecurityScrub(database, now());
      database.exec(schemaVersion15);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(15, now());
      database.exec("PRAGMA user_version = 15");
      version = 15;
    }

    if (version < 16) {
      if (!hasTableColumn(database, "provider_interactions", "deadline_at")) {
        database.exec("ALTER TABLE provider_interactions ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 9007199254740991 CHECK(deadline_at>=requested_at AND deadline_at<=9007199254740991)");
      }
      if (!hasTableColumn(database, "provider_interactions", "intended_terminal_state")) {
        database.exec("ALTER TABLE provider_interactions ADD COLUMN intended_terminal_state TEXT CHECK(intended_terminal_state IS NULL OR intended_terminal_state IN ('resolved','declined','canceled','expired'))");
      }
      database.query(
        "UPDATE provider_interactions SET deadline_at=MIN(requested_at+?,9007199254740991) WHERE deadline_at=9007199254740991",
      ).run(INTERACTION_MAX_PENDING_MS);
      database.exec(
        "UPDATE provider_interactions SET intended_terminal_state=state WHERE intended_terminal_state IS NULL AND state IN ('resolved','declined','canceled','expired')",
      );
      database.exec(schemaVersion16);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(16, now());
      database.exec("PRAGMA user_version = 16");
      version = 16;
    }

    if (version < 17) {
      database.exec(schemaVersion17);
      const legacyLoginResolutionEvidence = JSON.stringify({
        source: "schema17",
        reason: "missing_provider_login_id",
      });
      database.query(`INSERT OR IGNORE INTO mutation_resolutions(
                        attempt_id,resolution_kind,evidence_json,receipt_json,created_at
                      )
                      SELECT m.id,'abandoned',?,NULL,?
                      FROM mutation_attempts m
                      JOIN profiles p ON p.id=m.authority_id
                      LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                      WHERE m.kind='account.login'
                        AND m.state='applied'
                        AND p.state='login_pending'
                        AND p.process_generation=m.authority_generation
                        AND r.attempt_id IS NULL
                        AND json_extract(
                          CASE WHEN json_valid(m.result_json) THEN m.result_json ELSE '{}' END,
                          '$.status'
                        )='pending'
                        AND json_extract(
                          CASE WHEN json_valid(m.result_json) THEN m.result_json ELSE '{}' END,
                          '$.loginId'
                        ) IS NULL`).run(
        legacyLoginResolutionEvidence,
        now(),
      );
      database.query(`UPDATE profiles
                      SET state='signed_out',provider_email=NULL,provider_plan=NULL,updated_at=MAX(updated_at,?)
                      WHERE state='login_pending'
                        AND EXISTS(
                          SELECT 1
                          FROM mutation_attempts m
                          JOIN mutation_resolutions r ON r.attempt_id=m.id
                          WHERE m.kind='account.login'
                            AND m.authority_id=profiles.id
                            AND m.authority_generation=profiles.process_generation
                            AND r.resolution_kind='abandoned'
                            AND r.evidence_json=?
                        )`).run(now(), legacyLoginResolutionEvidence);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(17, now());
      database.exec("PRAGMA user_version = 17");
      version = 17;
    }

    // Reapplying additive objects and idempotent authority backfills makes a
    // restart after any pre-release partial fixture safe without changing rows.
    database.exec(schemaVersion9);
    database.exec(schemaVersion10);
    backfillSchemaVersion9(database, now());
    backfillSchemaVersion10(database);
    redacted = redactLegacyMcpUrlInteractions(database, now()) || redacted;
    redacted = redactLegacyPermissionValues(database) || redacted;
    if (redacted) requireSecurityScrub(database, now());
    database.exec(schemaVersion11);
    database.exec(schemaVersion12);
    database.exec(schemaVersion13);
    ensureStableQueueSequence(database);
    database.exec(schemaVersion15);
    database.exec(schemaVersion16);
    database.exec(schemaVersion17);
    pruneAllUsageHistory(database, now());
    return hasPendingSecurityScrub(database);
  })();
  if (securityScrubPending) completePendingSecurityScrub(database);
};

const mapProfile = (row: unknown): ProfileRecord => {
  const parsed = profileRowSchema.parse(row);
  return {
    id: parsed.id,
    label: parsed.label,
    state: parsed.state,
    processGeneration: parsed.process_generation,
    ...(parsed.provider_email === null ? {} : { providerEmail: parsed.provider_email }),
    ...(parsed.provider_plan === null ? {} : { providerPlan: parsed.provider_plan }),
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
};

const mapProject = (row: unknown): ProjectRecord => {
  const parsed = projectRowSchema.parse(row);
  return { id: parsed.id, label: parsed.label, rootPath: parsed.root_path, default: parsed.is_default === 1, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
};

const mapSession = (row: unknown): SessionRecord => {
  const parsed = sessionRowSchema.parse(row);
  return {
    id: parsed.id,
    profileId: parsed.profile_id,
    ...(parsed.project_id === null ? {} : { projectId: parsed.project_id }),
    ...(parsed.provider_thread_id === null ? {} : { providerThreadId: parsed.provider_thread_id }),
    title: parsed.title,
    note: parsed.note,
    preset: parsed.preset,
    fastEnabled: parsed.fast_enabled === 1,
    state: parsed.state,
    ...(parsed.active_turn_id === null ? {} : { activeTurnId: parsed.active_turn_id }),
    ...(parsed.provider_updated_at === null ? {} : { providerUpdatedAt: parsed.provider_updated_at }),
    revision: parsed.revision,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
};

const sessionEventStreamRowSchema = z.object({
  stream_epoch: z.string().uuid(),
  floor_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observed_through_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retained_count: z.number().int().nonnegative(),
  retained_bytes: z.number().int().nonnegative(),
  retention_gap_reason: sessionEventGapReasonSchema.nullable(),
}).strict();

const mapSessionEventStreamPosition = (row: unknown): SessionEventStreamPosition => {
  const parsed = sessionEventStreamRowSchema.parse(row);
  return {
    streamEpoch: parsed.stream_epoch,
    floorSequence: parsed.floor_sequence,
    observedThroughSequence: parsed.observed_through_sequence,
  };
};

const interactionRowSchema = z.object({
  public_id: z.string().uuid(),
  session_id: sessionIdSchema.nullable(),
  profile_id: profileIdSchema,
  process_generation: z.number().int().nonnegative(),
  connection_id: z.string().uuid(),
  request_id_type: z.enum(["number", "string"]),
  request_id_number: z.number().int().safe().nullable(),
  request_id_text: z.string().min(1).max(512).nullable(),
  method: z.string().min(1).max(512),
  request_digest: sha256Schema,
  thread_id: z.string().min(1).max(512).nullable(),
  turn_id: z.string().min(1).max(512).nullable(),
  item_id: z.string().min(1).max(512).nullable(),
  approval_id: z.string().min(1).max(512).nullable(),
  kind: interactionKindSchema,
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.union([z.literal(0), z.literal(1)]),
  display_json: z.string().min(2).max(65_536),
  response_digest: sha256Schema.nullable(),
  response_expected_revision: z.number().int().positive().nullable(),
  intended_terminal_state: interactionIntendedTerminalStateSchema.nullable(),
  requested_at: unixMillisecondsSchema,
  deadline_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
  terminal_at: unixMillisecondsSchema.nullable(),
}).strict();

const mapInteraction = (row: unknown): InteractionRecord => {
  const parsed = interactionRowSchema.parse(row);
  const requestId = parsed.request_id_type === "number"
    ? { type: "number" as const, value: z.number().int().safe().parse(parsed.request_id_number) }
    : { type: "string" as const, value: z.string().min(1).max(512).parse(parsed.request_id_text) };
  const display = interactionDisplaySchema.parse(JSON.parse(parsed.display_json) as unknown);
  return interactionRecordSchema.parse({
    version: 1,
    publicId: parsed.public_id,
    sessionId: parsed.session_id,
    authority: {
      profileId: parsed.profile_id,
      processGeneration: parsed.process_generation,
      connectionId: parsed.connection_id,
      requestId,
      method: parsed.method,
      requestDigest: parsed.request_digest,
      threadId: parsed.thread_id,
      turnId: parsed.turn_id,
      itemId: parsed.item_id,
      approvalId: parsed.approval_id,
    },
    kind: parsed.kind,
    state: parsed.state,
    revision: parsed.revision,
    blocking: parsed.blocking === 1,
    display,
    responseDigest: parsed.response_digest,
    intendedTerminalState: parsed.intended_terminal_state,
    requestedAt: parsed.requested_at,
    deadlineAt: parsed.deadline_at,
    updatedAt: parsed.updated_at,
    terminalAt: parsed.terminal_at,
  });
};

const mapSessionRuntimeProfile = (row: unknown): SessionRuntimeProfileRecord => {
  const parsed = sessionRuntimeProfileRowSchema.parse(row);
  const profile = effectiveRuntimeProfileSchema.parse(JSON.parse(parsed.profile_json) as unknown);
  if (
    profile.profileId !== parsed.profile_id
    || profile.processGeneration !== parsed.process_generation
    || profile.observedAt !== parsed.observed_at
  ) throw new Error("Stored runtime profile authority is incoherent.");
  return {
    sessionId: parsed.session_id,
    revision: parsed.revision,
    sourceKind: parsed.source_kind,
    sourceId: parsed.source_id,
    profile,
    recordedAt: parsed.recorded_at,
  };
};

const mapSessionTurnRuntimeProfile = (row: unknown): Readonly<{
  profile: EffectiveRuntimeProfile;
  sessionId: SessionId;
  sourceId: string;
  sourceKind: "turn_start" | "queue_start";
  turnId: string;
}> => {
  const parsed = sessionTurnRuntimeProfileRowSchema.parse(row);
  const profile = effectiveRuntimeProfileSchema.parse(JSON.parse(parsed.profile_json) as unknown);
  if (
    profile.profileId !== parsed.profile_id
    || profile.processGeneration !== parsed.process_generation
    || profile.observedAt !== parsed.observed_at
    || digestJson(profile) !== parsed.profile_digest
  ) throw new Error("Stored turn runtime profile authority is incoherent.");
  return {
    profile,
    sessionId: parsed.session_id,
    sourceId: parsed.source_id,
    sourceKind: parsed.source_kind,
    turnId: parsed.turn_id,
  };
};

const desktopSwitchRowSchema = z
  .object({
    attempt_id: attemptIdSchema,
    idempotency_key: z.string().uuid(),
    mutation_state: mutationStateSchema,
    result_json: z.string().nullable(),
    source_profile_id: profileIdSchema.nullable(),
    target_profile_id: profileIdSchema,
    source_generation: positiveGenerationSchema.nullable(),
    target_generation: positiveGenerationSchema,
    phase: desktopSwitchPhaseSchema,
    diagnostic_code: desktopDiagnosticSchema.nullable(),
    switch_generation: positiveGenerationSchema,
    journal_prepared: z.union([z.literal(0), z.literal(1)]),
    journal_digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    bundle_cd_hash: z.string().regex(/^[a-f0-9]{40,128}$/u).nullable(),
    source_pid: z.number().int().positive().nullable(),
    expected_account_key: desktopAccountKeySchema,
    launched_pid: z.number().int().positive().nullable(),
    ambiguous_from_phase: z.enum(["prepared", "quit_started", "quit_confirmed", "launch_started", "verify_started"]).nullable(),
    recovery_deadline_at: unixMillisecondsSchema.nullable(),
    resolution_kind: desktopRecoveryResolutionSchema.nullable(),
    resolution_diagnostic_code: desktopDiagnosticSchema.nullable(),
    resolution_observation_digest: sha256Schema.nullable(),
    resolution_receipt_json: z.string().nullable(),
    resolution_resolved_at: unixMillisecondsSchema.nullable(),
  })
  .strict();

type DesktopSwitchRow = z.infer<typeof desktopSwitchRowSchema>;

const desktopRecoveryReceiptSchema = z
  .object({
    status: desktopRecoveryResolutionSchema,
    attemptId: attemptIdSchema,
    idempotencyKey: z.string().uuid(),
    switchGeneration: positiveGenerationSchema,
    sourceProfileId: profileIdSchema.nullable(),
    sourceProcessGeneration: positiveGenerationSchema.nullable(),
    targetProfileId: profileIdSchema,
    targetProcessGeneration: positiveGenerationSchema,
    diagnostic: desktopDiagnosticSchema,
    observationDigest: sha256Schema,
    resolvedAt: unixMillisecondsSchema,
    activeAccount: z
      .object({
        signedIn: z.boolean(),
        email: z.string().trim().email().max(320).optional(),
        plan: z.string().trim().min(1).max(160).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const desktopSwitchSelect = `SELECT d.attempt_id,m.idempotency_key,m.state AS mutation_state,m.result_json,
  d.source_profile_id,d.target_profile_id,d.source_generation,d.target_generation,d.phase,d.diagnostic_code,
  d.switch_generation,d.journal_prepared,d.journal_digest,d.bundle_cd_hash,d.source_pid,d.expected_account_key,
  d.launched_pid,d.ambiguous_from_phase,d.recovery_deadline_at,
  r.resolution_kind,r.diagnostic_code AS resolution_diagnostic_code,
  r.observation_digest AS resolution_observation_digest,r.receipt_json AS resolution_receipt_json,
  r.resolved_at AS resolution_resolved_at
  FROM desktop_switches d
  JOIN mutation_attempts m ON m.id=d.attempt_id
  LEFT JOIN desktop_switch_resolutions r ON r.attempt_id=d.attempt_id`;

const switchPhaseByStage: Readonly<Record<DesktopSwitchStage, z.infer<typeof desktopSwitchPhaseSchema>>> = {
  prepared: "prepared",
  "quit-requested": "quit_started",
  "source-quiesced": "quit_confirmed",
  "launch-requested": "launch_started",
  "target-observed": "verify_started",
  verified: "applied",
  "recovery-required": "ambiguous",
};

const effectAdjacentPhases = new Set<z.infer<typeof desktopSwitchPhaseSchema>>([
  "quit_started",
  "quit_confirmed",
  "launch_started",
  "verify_started",
]);
const desktopRecoverySettlementMs = 30_000;

const digestJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const parseOptionalPlan = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const parsed = z.string().trim().min(1).max(160).safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export class SelectionError extends Error {
  constructor(readonly code: "NOT_FOUND" | "AMBIGUOUS", readonly candidates: readonly { id: string; label: string }[] = []) {
    super(code === "NOT_FOUND" ? "No matching object was found." : "The selector matches more than one object.");
    this.name = "SelectionError";
  }
}

export class StateStore {
  readonly #database: Database;
  readonly #now: () => number;
  readonly #readonly: boolean;
  readonly paths: StatePaths;

  constructor(paths: StatePaths, options: { readonly?: boolean; now?: () => number } = {}) {
    this.paths = paths;
    this.#now = options.now ?? Date.now;
    this.#readonly = options.readonly === true;
    this.#database = new Database(paths.database, options.readonly ? { readonly: true } : { create: true, strict: true });
    try {
      this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${stateBusyTimeoutMs};`);
      if (!options.readonly) {
        requireWalMode(this.#database, true);
        this.#database.exec("PRAGMA synchronous = FULL;");
        migrateWritableDatabase(this.#database, this.#now);
      } else {
        const version = readUserVersion(this.#database);
        if (version > currentSchemaVersion) throw new Error(`STATE_SCHEMA_NEWER:${version}:${currentSchemaVersion}`);
        if (version < currentSchemaVersion) throw new Error(`STATE_SCHEMA_MIGRATION_REQUIRED:${version}:${currentSchemaVersion}`);
        if (hasPendingSecurityScrub(this.#database)) throw new Error("STATE_SECURITY_SCRUB_REQUIRED");
      }
    } catch (error) {
      this.#database.close(false);
      throw error;
    }
  }

  close(): void {
    this.#database.close(false);
  }

  createProfile(label: string): ProfileRecord {
    const id = createProfileId();
    const parsedLabel = labelSchema.parse(label);
    const now = this.#now();
    this.#database.query("INSERT INTO profiles(id,label,state,process_generation,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, parsedLabel, "signed_out", 0, now, now);
    return this.requireProfile(id);
  }

  listProfiles(options: { includeRemoved?: boolean } = {}): readonly ProfileRecord[] {
    const rows = options.includeRemoved
      ? this.#database.query("SELECT * FROM profiles ORDER BY lower(label), id").all()
      : this.#database.query("SELECT * FROM profiles WHERE state != 'removed' ORDER BY lower(label), id").all();
    return rows.map(mapProfile);
  }

  requireProfile(selector: string): ProfileRecord {
    const selected = selectByIdOrLabel(this.listProfiles(), selector);
    if (selected.kind === "found") return selected.value;
    throw new SelectionError(selected.kind === "missing" ? "NOT_FOUND" : "AMBIGUOUS", selected.kind === "ambiguous" ? selected.values : []);
  }

  requireProfileById(profileId: ProfileId, options: { includeRemoved?: boolean } = {}): ProfileRecord {
    const parsedId = profileIdSchema.parse(profileId);
    const row = options.includeRemoved
      ? this.#database.query("SELECT * FROM profiles WHERE id=?").get(parsedId)
      : this.#database.query("SELECT * FROM profiles WHERE id=? AND state!='removed'").get(parsedId);
    if (row === null) throw new SelectionError("NOT_FOUND");
    return mapProfile(row);
  }

  nextProfileGeneration(profileId: ProfileId): ProfileRecord {
    const now = this.#now();
    const update = this.#database.transaction(() => {
      const current = mapProfile(this.#database.query("SELECT * FROM profiles WHERE id = ? AND state != 'removed'").get(profileId));
      this.#database.query("UPDATE profiles SET process_generation = ?, updated_at = ? WHERE id = ? AND process_generation = ?").run(current.processGeneration + 1, now, profileId, current.processGeneration);
    });
    update.immediate();
    return this.requireProfile(profileId);
  }

  advanceProfileGeneration(profileId: ProfileId, expectedGeneration: number): ProfileRecord {
    const now = this.#now();
    const advance = this.#database.transaction(() => {
      const current = mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=? AND state!='removed'").get(profileId));
      if (current.processGeneration !== expectedGeneration) {
        throw new Error("Profile generation authority changed.");
      }
      const activeLogin = this.#database.query(`SELECT attempt_id,process_generation
                                                FROM provider_login_authorities
                                                WHERE profile_id=? AND state='active'`).all(profileId) as {
        attempt_id: string;
        process_generation: number;
      }[];
      if (activeLogin.length > 1) throw new Error("LOGIN_GENERATION_AUTHORITY_AMBIGUOUS");
      if (activeLogin.length === 1) {
        if (
          current.state !== "login_pending"
          || activeLogin[0]?.process_generation !== expectedGeneration
        ) throw new Error("LOGIN_GENERATION_AUTHORITY_MISMATCH");
        const rebound = this.#database.query(`UPDATE provider_login_authorities
                                              SET process_generation=?,updated_at=MAX(updated_at,?)
                                              WHERE attempt_id=? AND process_generation=? AND state='active'`).run(
          expectedGeneration + 1,
          now,
          activeLogin[0].attempt_id,
          expectedGeneration,
        );
        if (rebound.changes !== 1) throw new Error("LOGIN_GENERATION_AUTHORITY_CAS_CONFLICT");
      }
      const state = current.state === "login_pending" && activeLogin.length === 0
        ? "recovery_required"
        : current.state;
      const result = this.#database
        .query("UPDATE profiles SET process_generation = ?, state=?, updated_at = ? WHERE id = ? AND process_generation = ? AND state != 'removed'")
        .run(expectedGeneration + 1, state, now, profileId, expectedGeneration);
      if (result.changes !== 1) throw new Error("Profile generation authority changed.");
    });
    advance.immediate();
    return this.requireProfile(profileId);
  }

  setProfileState(profileId: ProfileId, expectedGeneration: number, state: z.infer<typeof profileStateSchema>, identity?: { email?: string; plan?: string }): boolean {
    const now = this.#now();
    const update = this.#database.transaction(() => {
      const result = this.#database.query(
        `UPDATE profiles
         SET state=?,provider_email=?,provider_plan=?,updated_at=?
         WHERE id=?
           AND process_generation=?
           AND state!='removed'
           AND (state!='recovery_required' OR ?='recovery_required')`,
      )
      .run(state, identity?.email ?? null, identity?.plan ?? null, now, profileId, expectedGeneration, state);
      if (result.changes === 1 && (state === "signed_in" || state === "signed_out")) {
        this.#database.query(`UPDATE provider_login_authorities
                              SET state='settled',settlement=?,updated_at=?
                              WHERE profile_id=? AND process_generation=? AND state='active'`).run(
          state === "signed_in" ? "signed_in" : "provider_disconnected",
          now,
          profileId,
          expectedGeneration,
        );
      }
      return result.changes === 1;
    });
    return update.immediate();
  }

  removeProfile(profileId: ProfileId): void {
    const active = this.#database.query("SELECT COUNT(*) AS count FROM sessions WHERE profile_id = ? AND state NOT IN ('terminal')").get(profileId) as { count: number } | null;
    if ((active?.count ?? 0) !== 0) throw new Error("Profile still owns active sessions.");
    const now = this.#now();
    const result = this.#database.query("UPDATE profiles SET state='removed', provider_email=NULL, provider_plan=NULL, updated_at=? WHERE id=? AND state!='removed'").run(now, profileId);
    if (result.changes !== 1) throw new SelectionError("NOT_FOUND");
  }

  async createProject(label: string, requestedRoot: string, makeDefault = false): Promise<ProjectRecord> {
    const requested = resolve(requestedRoot);
    const [metadata, canonical] = await Promise.all([lstat(requested), realpath(requested)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== requested) {
      throw new Error("Project root must be an existing canonical directory without symbolic links.");
    }
    const id = createProjectId();
    const parsedLabel = labelSchema.parse(label);
    const now = this.#now();
    const insert = this.#database.transaction(() => {
      if (makeDefault) this.#database.query("UPDATE projects SET is_default=0, updated_at=? WHERE is_default=1").run(now);
      this.#database.query("INSERT INTO projects(id,label,root_path,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, parsedLabel, canonical, makeDefault ? 1 : 0, now, now);
    });
    insert.immediate();
    return this.requireProject(id);
  }

  listProjects(): readonly ProjectRecord[] {
    return this.#database.query("SELECT * FROM projects ORDER BY is_default DESC, lower(label), id").all().map(mapProject);
  }

  requireProject(selector: string): ProjectRecord {
    const selected = selectByIdOrLabel(this.listProjects(), selector);
    if (selected.kind === "found") return selected.value;
    throw new SelectionError(selected.kind === "missing" ? "NOT_FOUND" : "AMBIGUOUS", selected.kind === "ambiguous" ? selected.values : []);
  }

  setDefaultProject(projectId: ProjectId): ProjectRecord {
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      this.#database.query("UPDATE projects SET is_default=0,updated_at=? WHERE is_default=1").run(now);
      const result = this.#database.query("UPDATE projects SET is_default=1,updated_at=? WHERE id=?").run(now, projectId);
      if (result.changes !== 1) throw new SelectionError("NOT_FOUND");
    });
    transaction.immediate();
    return this.requireProject(projectId);
  }

  removeProject(projectId: ProjectId): void {
    const result = this.#database.query("DELETE FROM projects WHERE id=? AND NOT EXISTS(SELECT 1 FROM sessions WHERE project_id=?)").run(projectId, projectId);
    if (result.changes !== 1) throw new Error("Project is missing or still used by a session.");
  }

  #insertSessionEventStream(sessionId: SessionId, now: number): void {
    this.#database.query(
      `INSERT OR IGNORE INTO session_event_streams(
         session_id,stream_epoch,next_sequence,floor_sequence,observed_through_sequence,
         retained_count,retained_bytes,retention_gap_reason,created_at,updated_at
       ) VALUES (?,?,1,1,0,0,0,NULL,?,?)`,
    ).run(sessionId, randomUUID(), now, now);
  }

  #ensureSessionEventStream(sessionId: SessionId): void {
    if (this.#database.query("SELECT 1 FROM session_event_streams WHERE session_id=?").get(sessionId) !== null) return;
    if (this.#readonly) throw new Error("SESSION_EVENT_STREAM_MISSING");
    const now = this.#now();
    this.#insertSessionEventStream(sessionId, now);
  }

  createSession(input: { profileId: ProfileId; projectId?: ProjectId; title?: string; preset: Preset; fastEnabled: boolean }): SessionRecord {
    const id = createSessionId();
    const now = this.#now();
    const title = input.title === undefined ? "Untitled session" : titleSchema.parse(input.title);
    const create = this.#database.transaction(() => {
      this.#database.query("INSERT INTO sessions(id,profile_id,project_id,title,preset,fast_enabled,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.profileId, input.projectId ?? null, title, presetSchema.parse(input.preset), input.fastEnabled ? 1 : 0, "starting", 1, now, now);
      this.#insertSessionEventStream(id, now);
    });
    create.immediate();
    return this.requireSession(id);
  }

  listSessions(limit = 50, profileId?: ProfileId): readonly SessionRecord[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = profileId === undefined
      ? this.#database.query("SELECT * FROM sessions ORDER BY updated_at DESC,id LIMIT ?").all(bounded)
      : this.#database.query("SELECT * FROM sessions WHERE profile_id=? ORDER BY updated_at DESC,id LIMIT ?").all(profileId, bounded);
    return rows.map(mapSession);
  }

  requireSession(selector: string): SessionRecord {
    if (sessionIdSchema.safeParse(selector).success) {
      const exact = this.#database.query("SELECT * FROM sessions WHERE id=?").get(selector);
      if (exact !== null) return mapSession(exact);
    }
    const rows = this.#database.query("SELECT * FROM sessions WHERE title = ? COLLATE NOCASE ORDER BY updated_at DESC,id LIMIT 101").all(selector).map(mapSession);
    if (rows.length === 1) {
      const only = rows[0];
      if (only === undefined) throw new Error("Session selection cardinality changed unexpectedly.");
      return only;
    }
    if (rows.length === 0) throw new SelectionError("NOT_FOUND");
    throw new SelectionError("AMBIGUOUS", rows.map((session) => ({ id: session.id, label: session.title })));
  }

  findSessionByProviderThread(profileId: ProfileId, providerThreadId: string): SessionRecord | null {
    const row = this.#database.query("SELECT * FROM sessions WHERE profile_id=? AND provider_thread_id=?").get(profileId, providerThreadId);
    return row === null ? null : mapSession(row);
  }

  recordSessionRuntimeProfile(input: {
    sessionId: SessionId;
    sourceKind: z.infer<typeof runtimeProfileSourceKindSchema>;
    sourceId: string;
    profile: EffectiveRuntimeProfile;
  }): SessionRuntimeProfileRecord {
    let record: SessionRuntimeProfileRecord | undefined;
    const transaction = this.#database.transaction(() => {
      record = this.#insertSessionRuntimeProfile(input, this.#now());
    });
    transaction.immediate();
    if (record === undefined) throw new Error("Effective runtime profile was not recorded.");
    return record;
  }

  #insertSessionRuntimeProfile(input: {
    sessionId: SessionId;
    sourceKind: z.infer<typeof runtimeProfileSourceKindSchema>;
    sourceId: string;
    profile: EffectiveRuntimeProfile;
  }, now: number): SessionRuntimeProfileRecord {
    const sourceKind = runtimeProfileSourceKindSchema.parse(input.sourceKind);
    const sourceId = z.string().min(1).max(200).parse(input.sourceId);
    const profile = effectiveRuntimeProfileSchema.parse(input.profile);
    const profileJson = JSON.stringify(profile);
    const existing = this.#database.query(
      "SELECT * FROM session_runtime_profiles WHERE source_kind=? AND source_id=?",
    ).get(sourceKind, sourceId);
    if (existing !== null) {
      const record = mapSessionRuntimeProfile(existing);
      if (record.sessionId !== input.sessionId || JSON.stringify(record.profile) !== profileJson) {
        throw new Error("Effective runtime profile source authority changed.");
      }
      return record;
    }
    const nextRow = z.object({ revision: z.number().int().nonnegative() }).strict().parse(
      this.#database.query(
        "SELECT COALESCE(MAX(revision),0) AS revision FROM session_runtime_profiles WHERE session_id=?",
      ).get(input.sessionId),
    );
    this.#database.query(
      `INSERT INTO session_runtime_profiles(
         session_id,revision,source_kind,source_id,profile_id,process_generation,
         observed_at,profile_json,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.sessionId,
      nextRow.revision + 1,
      sourceKind,
      sourceId,
      profile.profileId,
      profile.processGeneration,
      profile.observedAt,
      profileJson,
      now,
    );
    const inserted = this.#database.query(
      "SELECT * FROM session_runtime_profiles WHERE source_kind=? AND source_id=?",
    ).get(sourceKind, sourceId);
    if (inserted === null) throw new Error("Effective runtime profile was not recorded.");
    return mapSessionRuntimeProfile(inserted);
  }

  #bindSessionTurnRuntimeProfile(input: {
    sessionId: SessionId;
    sourceKind: "turn_start" | "queue_start";
    sourceId: string;
    turnId: string;
    profile: EffectiveRuntimeProfile;
  }, now: number): EffectiveRuntimeProfile {
    const turnId = z.string().min(1).max(200).parse(input.turnId);
    const profileRecord = this.#insertSessionRuntimeProfile(input, now);
    const profileJson = JSON.stringify(profileRecord.profile);
    const profileDigest = digestJson(profileRecord.profile);
    const existing = this.#database.query(
      "SELECT * FROM session_turn_runtime_profiles WHERE session_id=? AND turn_id=?",
    ).get(input.sessionId, turnId);
    if (existing !== null) {
      const bound = mapSessionTurnRuntimeProfile(existing);
      if (
        bound.sourceKind !== input.sourceKind
        || bound.sourceId !== input.sourceId
        || JSON.stringify(bound.profile) !== profileJson
      ) throw new Error("Completed turn runtime profile authority changed.");
      return bound.profile;
    }
    this.#database.query(
      `INSERT INTO session_turn_runtime_profiles(
         session_id,turn_id,source_kind,source_id,profile_id,process_generation,
         observed_at,profile_json,profile_digest,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.sessionId,
      turnId,
      input.sourceKind,
      input.sourceId,
      profileRecord.profile.profileId,
      profileRecord.profile.processGeneration,
      profileRecord.profile.observedAt,
      profileJson,
      profileDigest,
      now,
    );
    const inserted = this.#database.query(
      "SELECT * FROM session_turn_runtime_profiles WHERE session_id=? AND turn_id=?",
    ).get(input.sessionId, turnId);
    if (inserted === null) throw new Error("Completed turn runtime profile was not bound.");
    return mapSessionTurnRuntimeProfile(inserted).profile;
  }

  runtimeProfileForTurn(sessionId: SessionId, turnId: string): EffectiveRuntimeProfile | null {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedTurnId = z.string().min(1).max(200).parse(turnId);
    const row = this.#database.query(
      "SELECT * FROM session_turn_runtime_profiles WHERE session_id=? AND turn_id=?",
    ).get(parsedSessionId, parsedTurnId);
    return row === null ? null : mapSessionTurnRuntimeProfile(row).profile;
  }

  runtimeProfileSourceRequiresSettlement(sessionId: SessionId, sourceId: string): boolean {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedSourceId = z.string().min(1).max(200).parse(sourceId);
    const mutation = this.#database.query(`SELECT 1 FROM mutation_attempts m
      JOIN mutation_effect_evidence e ON e.attempt_id=m.id
      LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
      WHERE m.id=? AND m.authority_id=? AND m.kind='session.send'
        AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL
      LIMIT 1`).get(parsedSourceId, parsedSessionId);
    if (mutation !== null) return true;
    return this.#database.query(`SELECT 1 FROM queue_entries q
      JOIN queue_effect_evidence e ON e.queue_id=q.id
      LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
      WHERE q.id=? AND q.session_id=? AND q.state IN ('dispatching','ambiguous')
        AND r.queue_id IS NULL
      LIMIT 1`).get(parsedSourceId, parsedSessionId) !== null;
  }

  completeSessionStartEffect(input: {
    attemptId: AttemptId;
    sessionId: SessionId;
    expectedSessionRevision: number;
    providerThreadId: string;
    state: "active" | "idle" | "terminal";
    activeTurnId?: string;
    providerUpdatedAt?: number;
    runtimeProfile: EffectiveRuntimeProfile;
    receipt: unknown;
  }): void {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const profile = effectiveRuntimeProfileSchema.parse(input.runtimeProfile);
    const receiptJson = JSON.stringify(input.receipt);
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      const row = z.object({
        state: z.literal("effect_started"),
        session_id: sessionIdSchema,
        evidence_json: z.string(),
      }).strict().parse(this.#database.query(`SELECT m.state,s.session_id,e.evidence_json
                                              FROM mutation_attempts m
                                              JOIN session_start_attempts s ON s.attempt_id=m.id
                                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                                              WHERE m.id=? AND m.kind='session.start'`).get(attemptId));
      const evidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (
        row.session_id !== sessionId
        || evidence.kind !== "session.start"
        || evidence.runtimeProfile === undefined
        || JSON.stringify(evidence.runtimeProfile) !== JSON.stringify(profile)
      ) throw new Error("SESSION_START_EFFECT_EVIDENCE_MISMATCH");
      const bound = this.#database.query(`UPDATE sessions SET provider_thread_id=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                          WHERE id=? AND revision=? AND state='starting' AND provider_thread_id IS NULL`).run(
        providerThreadIdSchema.parse(input.providerThreadId),
        input.state,
        input.activeTurnId ?? null,
        input.providerUpdatedAt ?? null,
        now,
        sessionId,
        z.number().int().positive().parse(input.expectedSessionRevision),
      );
      if (bound.changes !== 1) throw new Error("SESSION_START_BINDING_CAS_CONFLICT");
      this.#insertSessionRuntimeProfile({ sessionId, sourceKind: "session_start", sourceId: attemptId, profile }, now);
      const applied = this.#database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'").run(receiptJson, now, attemptId);
      if (applied.changes !== 1) throw new Error("SESSION_START_RECEIPT_CAS_CONFLICT");
    });
    transaction.immediate();
  }

  completeSessionTurnEffect(input: {
    attemptId: AttemptId;
    sessionId: SessionId;
    expectedSessionRevision: number;
    applyResponseState: boolean;
    turnId: string;
    turnStatus: "completed" | "interrupted" | "failed" | "inProgress";
    runtimeProfile: EffectiveRuntimeProfile;
    receipt: unknown;
  }): void {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const profile = effectiveRuntimeProfileSchema.parse(input.runtimeProfile);
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      const row = z.object({ authority_id: sessionIdSchema, evidence_json: z.string() }).strict().parse(
        this.#database.query(`SELECT m.authority_id,e.evidence_json FROM mutation_attempts m
                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                              WHERE m.id=? AND m.kind='session.send' AND m.state='effect_started'`).get(attemptId),
      );
      const evidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (
        row.authority_id !== sessionId
        || evidence.kind !== "session.send"
        || evidence.runtimeProfile === undefined
        || JSON.stringify(evidence.runtimeProfile) !== JSON.stringify(profile)
      ) throw new Error("SESSION_TURN_EFFECT_EVIDENCE_MISMATCH");
      this.#bindSessionTurnRuntimeProfile({
        sessionId,
        sourceKind: "turn_start",
        sourceId: attemptId,
        turnId: input.turnId,
        profile,
      }, now);
      const nextState = input.turnStatus === "inProgress" ? "active" : "idle";
      if (input.applyResponseState) {
        const sessionChanged = this.#database.query(`UPDATE sessions SET state=?,active_turn_id=?,revision=revision+1,updated_at=?
                                                     WHERE id=? AND revision=? AND state NOT IN ('recovery_required','terminal')`).run(
          nextState,
          nextState === "active" ? z.string().min(1).max(200).parse(input.turnId) : null,
          now,
          sessionId,
          z.number().int().positive().parse(input.expectedSessionRevision),
        );
        if (sessionChanged.changes !== 1) throw new Error("SESSION_TURN_STATE_CAS_CONFLICT");
      }
      const applied = this.#database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'").run(JSON.stringify(input.receipt), now, attemptId);
      if (applied.changes !== 1) throw new Error("SESSION_TURN_RECEIPT_CAS_CONFLICT");
    });
    transaction.immediate();
  }

  latestSessionRuntimeProfile(sessionId: SessionId): SessionRuntimeProfileRecord | null {
    const row = this.#database.query(
      "SELECT * FROM session_runtime_profiles WHERE session_id=? ORDER BY revision DESC LIMIT 1",
    ).get(sessionId);
    return row === null ? null : mapSessionRuntimeProfile(row);
  }

  upsertProviderSession(input: { profileId: ProfileId; providerThreadId: string; projectId?: ProjectId; title: string; state: "active" | "idle" | "terminal"; activeTurnId?: string; providerUpdatedAt?: number }): SessionRecord {
    const current = this.findSessionByProviderThread(input.profileId, input.providerThreadId);
    const now = this.#now();
    if (current === null) {
      const id = createSessionId();
      const create = this.#database.transaction(() => {
        this.#database.query("INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,title,preset,fast_enabled,state,active_turn_id,provider_updated_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,'high',0,?,?,?,1,?,?)").run(id, input.profileId, input.projectId ?? null, input.providerThreadId, titleSchema.parse(input.title), input.state, input.activeTurnId ?? null, input.providerUpdatedAt ?? null, now, now);
        this.#insertSessionEventStream(id, now);
      });
      create.immediate();
      return this.requireSession(id);
    }
    if (current.state === "recovery_required") return current;
    if (input.providerUpdatedAt === undefined || input.providerUpdatedAt <= (current.providerUpdatedAt ?? -1)) return current;
    const result = this.#database.query("UPDATE sessions SET project_id=COALESCE(project_id,?),title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (provider_updated_at IS NULL OR provider_updated_at < ?)").run(input.projectId ?? null, titleSchema.parse(input.title), input.state, input.activeTurnId ?? null, input.providerUpdatedAt, now, current.id, current.revision, input.providerUpdatedAt);
    if (result.changes !== 1) throw new Error("Session changed while importing the provider projection.");
    return this.requireSession(current.id);
  }

  bindSession(input: { sessionId: SessionId; expectedRevision: number; providerThreadId: string; state: "active" | "idle"; activeTurnId?: string; providerUpdatedAt?: number }): SessionRecord {
    const now = this.#now();
    const result = this.#database.query("UPDATE sessions SET provider_thread_id=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='starting'").run(input.providerThreadId, input.state, input.activeTurnId ?? null, input.providerUpdatedAt ?? null, now, input.sessionId, input.expectedRevision);
    if (result.changes !== 1) throw new Error("Session authority changed before the provider binding committed.");
    return this.requireSession(input.sessionId);
  }

  deleteUnboundStartingSession(sessionId: SessionId, expectedRevision: number): boolean {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedRevision = z.number().int().positive().parse(expectedRevision);
    const remove = this.#database.transaction(() => {
      const deleted = this.#database
        .query(
          `DELETE FROM sessions
           WHERE id=?
             AND revision=?
             AND state='starting'
             AND provider_thread_id IS NULL
             AND active_turn_id IS NULL
             AND provider_updated_at IS NULL
             AND NOT EXISTS(SELECT 1 FROM queue_entries WHERE session_id=sessions.id)
             AND NOT EXISTS(SELECT 1 FROM turn_summaries WHERE session_id=sessions.id)
           RETURNING id`,
        )
        .get(parsedSessionId, parsedRevision);
      return deleted !== null;
    });
    return remove.immediate();
  }

  updateSessionMetadata(input: { sessionId: SessionId; expectedRevision: number; title?: string; note?: string; preset?: Preset; fastEnabled?: boolean; projectId?: ProjectId | null }): SessionRecord {
    const current = this.requireSession(input.sessionId);
    if (current.revision !== input.expectedRevision) throw new Error("Session metadata revision conflict.");
    const title = input.title === undefined ? current.title : titleSchema.parse(input.title);
    const note = input.note === undefined ? current.note : noteSchema.parse(input.note);
    const preset = input.preset === undefined ? current.preset : presetSchema.parse(input.preset);
    const fast = input.fastEnabled === undefined ? current.fastEnabled : input.fastEnabled;
    const project = input.projectId === undefined ? current.projectId ?? null : input.projectId;
    const now = this.#now();
    const result = this.#database.query("UPDATE sessions SET title=?,note=?,preset=?,fast_enabled=?,project_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(title, note, preset, fast ? 1 : 0, project, now, current.id, current.revision);
    if (result.changes !== 1) throw new Error("Session metadata revision conflict.");
    return this.requireSession(current.id);
  }

  setSessionTurnState(input: { sessionId: SessionId; expectedRevision: number; state: "active" | "idle" | "terminal" | "recovery_required"; activeTurnId?: string }): SessionRecord {
    const now = this.#now();
    const result = this.#database.query("UPDATE sessions SET state=?,active_turn_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(input.state, input.activeTurnId ?? null, now, input.sessionId, input.expectedRevision);
    if (result.changes !== 1) throw new Error("Session state revision conflict.");
    return this.requireSession(input.sessionId);
  }

  reconcileSessionFromProvider(input: { sessionId: SessionId; state?: "active" | "idle" | "terminal" | "recovery_required"; activeTurnId?: string | null; title?: string }): SessionRecord {
    const current = this.requireSession(input.sessionId);
    if (current.state === "recovery_required" || current.state === "terminal") return current;
    const state = input.state ?? current.state;
    const activeTurnId = input.activeTurnId === undefined ? current.activeTurnId ?? null : input.activeTurnId;
    const title = input.title === undefined ? current.title : titleSchema.parse(input.title);
    if (state === current.state && activeTurnId === (current.activeTurnId ?? null) && title === current.title) return current;
    const result = this.#database.query("UPDATE sessions SET state=?,active_turn_id=?,title=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(state, activeTurnId, title, this.#now(), current.id, current.revision);
    if (result.changes !== 1) return this.requireSession(current.id);
    return this.requireSession(current.id);
  }

  terminalizeSessionFromProviderDeletion(input: Readonly<{
    accountId: ProfileId;
    providerConnectionId: string | null;
    providerGeneration: number;
    sessionId: SessionId;
  }>): Readonly<{
    changed: boolean;
    event?: SessionEvent;
    interactions: readonly InteractionRecord[];
    session: SessionRecord;
  }> {
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const accountId = profileIdSchema.parse(input.accountId);
    const providerGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.providerGeneration);
    const providerConnectionId = z.string().uuid().nullable().parse(input.providerConnectionId);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const current = this.requireSession(parsedSessionId);
      let sessionChanged = false;
      let event: SessionEvent | undefined;
      if (current.state !== "terminal") {
        const changed = this.#database.query(
          `UPDATE sessions
           SET state='terminal',active_turn_id=NULL,revision=revision+1,updated_at=?
           WHERE id=? AND revision=? AND state!='terminal'`,
        ).run(now, current.id, current.revision);
        if (changed.changes !== 1) throw new Error("SESSION_PROVIDER_DELETION_CONFLICT");
        sessionChanged = true;
        event = this.appendSessionEvent({
          accountId,
          body: {
            activeTurnId: null,
            status: "terminal",
            type: "session_status",
          },
          providerConnectionId,
          providerGeneration,
          sessionId: current.id,
        });
      }
      this.#database.query(
        "UPDATE queue_entries SET state='cancelled',updated_at=? WHERE session_id=? AND state='pending'",
      ).run(now, current.id);
      this.#database.query(
        "UPDATE queue_entries SET state='ambiguous',updated_at=? WHERE session_id=? AND state='dispatching'",
      ).run(now, current.id);
      const providerDeletionEvidence = JSON.stringify({ source: "provider_thread_deleted" });
      this.#database.query(
        `INSERT OR IGNORE INTO queue_effect_resolutions(
           queue_id,resolution_kind,evidence_json,receipt_json,created_at
         )
         SELECT q.id,'abandoned',?,NULL,?
         FROM queue_entries q
         JOIN queue_effect_evidence e ON e.queue_id=q.id
         LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
         WHERE q.session_id=? AND q.state='ambiguous' AND r.queue_id IS NULL`,
      ).run(providerDeletionEvidence, now, current.id);
      this.#database.query(
        `UPDATE mutation_attempts
         SET state='cancelled',updated_at=?
         WHERE state='prepared'
           AND (
             authority_id=? OR id IN (
               SELECT attempt_id FROM session_start_attempts WHERE session_id=?
             )
           )`,
      ).run(now, current.id, current.id);
      this.#database.query(
        `INSERT OR IGNORE INTO mutation_resolutions(
           attempt_id,resolution_kind,evidence_json,receipt_json,created_at
         )
         SELECT m.id,'abandoned',?,NULL,?
         FROM mutation_attempts m
         LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
         LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
         WHERE (m.authority_id=? OR s.session_id=?)
           AND m.state IN ('effect_started','ambiguous')
           AND r.attempt_id IS NULL`,
      ).run(providerDeletionEvidence, now, current.id, current.id);
      const rows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE session_id=? AND state IN ('pending','response_prepared','response_written')
         ORDER BY requested_at,public_id`,
      ).all(current.id);
      const interactions: InteractionRecord[] = [];
      for (const value of rows) {
        const interaction = interactionRowSchema.parse(value);
        const state = interaction.state === "pending" ? "expired" : "resolution_unknown";
        const settled = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, interaction.public_id, interaction.revision, interaction.state);
        if (settled.changes !== 1) throw new Error("INTERACTION_PROVIDER_DELETION_CONFLICT");
        const terminal = this.#requireInteractionRow(interaction.public_id);
        this.#recordInteractionTransition(terminal, now);
        interactions.push(mapInteraction(terminal));
      }
      return {
        changed: sessionChanged,
        ...(event === undefined ? {} : { event }),
        interactions,
        session: this.requireSession(current.id),
      };
    });
    return terminalize.immediate();
  }

  quarantineSession(sessionId: SessionId): SessionRecord {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const now = this.#now();
    this.#database
      .query(
        `UPDATE sessions
         SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=?
         WHERE id=? AND state NOT IN ('recovery_required','terminal')`,
      )
      .run(now, parsedSessionId);
    return this.requireSession(parsedSessionId);
  }

  resolveSessionStatusRecovery(input:
    | {
      sessionId: SessionId;
      expectedRevision: number;
      resolution: "provider_state_reconciled";
      provider: {
        providerThreadId: string;
        title: string;
        status: "active" | "idle" | "terminal";
        activeTurnId?: string;
        providerUpdatedAt?: number;
      };
    }
    | {
      sessionId: SessionId;
      expectedRevision: number;
      resolution: "abandoned";
    }): SessionRecord {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const now = this.#now();
    const resolveRecovery = this.#database.transaction(() => {
      const session = mapSession(this.#database.query("SELECT * FROM sessions WHERE id=?").get(sessionId));
      if (session.state !== "recovery_required" || session.revision !== expectedRevision) {
        throw new Error("SESSION_STATUS_RECOVERY_CAS_CONFLICT");
      }
      const unsettledMutationCount = z.object({ count: z.number().int().nonnegative() }).strict().parse(
        this.#database.query(`SELECT COUNT(*) AS count
                              FROM mutation_attempts m
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                              WHERE (m.authority_id=? OR s.session_id=?)
                                AND m.state IN ('effect_started','ambiguous')
                                AND r.attempt_id IS NULL`).get(sessionId, sessionId),
      ).count;
      const unsettledQueueCount = z.object({ count: z.number().int().nonnegative() }).strict().parse(
        this.#database.query(`SELECT COUNT(*) AS count
                              FROM queue_entries q
                              LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
                              WHERE q.session_id=? AND q.state IN ('dispatching','ambiguous') AND r.queue_id IS NULL`).get(sessionId),
      ).count;
      if (unsettledMutationCount !== 0 || unsettledQueueCount !== 0) {
        throw new Error("SESSION_STATUS_RECOVERY_HAS_UNSETTLED_EFFECT");
      }
      if (input.resolution === "abandoned") {
        const changed = this.#database.query(`UPDATE sessions
                                              SET state='terminal',active_turn_id=NULL,revision=revision+1,updated_at=?
                                              WHERE id=? AND revision=? AND state='recovery_required'`).run(
          now,
          sessionId,
          expectedRevision,
        );
        if (changed.changes !== 1) throw new Error("SESSION_STATUS_RECOVERY_CAS_CONFLICT");
        this.#database.query("UPDATE queue_entries SET state='cancelled',updated_at=? WHERE session_id=? AND state='pending'").run(now, sessionId);
        return;
      }
      const providerThreadId = providerThreadIdSchema.parse(input.provider.providerThreadId);
      if (session.providerThreadId !== providerThreadId) throw new Error("SESSION_STATUS_RECOVERY_THREAD_MISMATCH");
      const status = sessionStateSchema.exclude(["starting", "recovery_required"]).parse(input.provider.status);
      if (status === "active" && input.provider.activeTurnId === undefined) {
        throw new Error("SESSION_STATUS_RECOVERY_ACTIVE_TURN_MISSING");
      }
      const activeTurnId = status === "active" && input.provider.activeTurnId !== undefined
        ? z.string().min(1).max(200).parse(input.provider.activeTurnId)
        : null;
      const observedProviderUpdatedAt = input.provider.providerUpdatedAt === undefined
        ? session.providerUpdatedAt ?? null
        : unixMillisecondsSchema.parse(input.provider.providerUpdatedAt);
      const providerUpdatedAt = session.providerUpdatedAt === undefined || observedProviderUpdatedAt === null
        ? observedProviderUpdatedAt
        : Math.max(session.providerUpdatedAt, observedProviderUpdatedAt);
      const changed = this.#database.query(`UPDATE sessions
                                            SET title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                            WHERE id=? AND revision=? AND state='recovery_required' AND provider_thread_id=?`).run(
        titleSchema.parse(input.provider.title),
        status,
        activeTurnId,
        providerUpdatedAt,
        now,
        sessionId,
        expectedRevision,
        providerThreadId,
      );
      if (changed.changes !== 1) throw new Error("SESSION_STATUS_RECOVERY_CAS_CONFLICT");
    });
    resolveRecovery.immediate();
    return this.requireSession(sessionId);
  }

  #enqueuePrepared(sessionId: SessionId, message: string): QueueRecord {
    const id = createQueueId();
    const now = this.#now();
    const sequenceRow = this.#database.query(
      `UPDATE queue_sequence_authority
       SET next_sequence=next_sequence+1
       WHERE singleton=1 AND next_sequence<9007199254740991
       RETURNING next_sequence-1 AS enqueue_sequence`,
    ).get();
    if (sequenceRow === null) throw new Error("QUEUE_SEQUENCE_EXHAUSTED");
    const enqueueSequence = z.object({
      enqueue_sequence: z.number().int().positive().safe(),
    }).strict().parse(sequenceRow).enqueue_sequence;
    this.#database.query("INSERT INTO queue_entries(id,session_id,message,state,enqueue_sequence,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, sessionId, message, "pending", enqueueSequence, now, now);
    return { id, sessionId, message, state: "pending", createdAt: now, updatedAt: now };
  }

  enqueue(sessionId: SessionId, message: string): QueueRecord {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedMessage = z.string().min(1).max(262_144).parse(message);
    let queued: QueueRecord | undefined;
    this.#database.transaction(() => {
      queued = this.#enqueuePrepared(parsedSessionId, parsedMessage);
    }).immediate();
    if (queued === undefined) throw new Error("Queue transaction lost its durable row.");
    return queued;
  }

  enqueueIdempotent(input: { sessionId: SessionId; profileGeneration: number; message: string; idempotencyKey?: string }): QueueRecord {
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const parsedMessage = z.string().min(1).max(262_144).parse(input.message);
    let queueId: QueueId | undefined;
    const enqueue = this.#database.transaction(() => {
      const attempt = this.prepareMutation({
        kind: "session.queue",
        authorityId: parsedSessionId,
        authorityGeneration: parsedGeneration,
        request: { message: parsedMessage },
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      if (attempt.replay) {
        if (attempt.state !== "applied" && attempt.state !== "reconciled") {
          throw new Error(`QUEUE_MUTATION_${attempt.state.toUpperCase()}`);
        }
        queueId = z.object({ queueId: queueIdSchema }).strict().parse(attempt.result).queueId;
        return;
      }
      const authority = z.object({ process_generation: z.number().int().nonnegative(), session_state: sessionStateSchema }).strict().parse(
        this.#database.query(`SELECT p.process_generation,s.state AS session_state FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?`).get(parsedSessionId),
      );
      if (authority.process_generation !== parsedGeneration || authority.session_state === "recovery_required" || authority.session_state === "terminal") {
        throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      }
      const queued = this.#enqueuePrepared(parsedSessionId, parsedMessage);
      queueId = queued.id;
      if (!this.transitionMutation(attempt.id, "prepared", "effect_started")) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      if (!this.transitionMutation(attempt.id, "effect_started", "applied", { queueId: queued.id })) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    enqueue.immediate();
    if (queueId === undefined) throw new Error("Queue transaction lost its durable receipt.");
    return this.requireQueue(queueId);
  }

  listQueue(sessionId: SessionId): readonly QueueRecord[] {
    const rows = this.#database.query("SELECT id,session_id,message,state,created_at,updated_at FROM queue_entries WHERE session_id=? ORDER BY enqueue_sequence").all(sessionId);
    return rows.map((row) => {
      const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema, message: z.string(), state: queueStateSchema, created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema }).strict().parse(row);
      return { id: parsed.id, sessionId: parsed.session_id, message: parsed.message, state: parsed.state, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
    });
  }

  requireQueue(id: QueueId): QueueRecord {
    const row = this.#database.query("SELECT id,session_id,message,state,created_at,updated_at FROM queue_entries WHERE id=?").get(id);
    if (row === null) throw new SelectionError("NOT_FOUND");
    const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema, message: z.string(), state: queueStateSchema, created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema }).strict().parse(row);
    return { id: parsed.id, sessionId: parsed.session_id, message: parsed.message, state: parsed.state, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
  }

  nextPendingQueue(sessionId: SessionId): QueueRecord | null {
    return this.listQueue(sessionId).find((entry) => entry.state === "pending") ?? null;
  }

  listRecoverableQueue(): readonly QueueRecord[] {
    const rows = this.#database
      .query("SELECT id,session_id,message,state,created_at,updated_at FROM queue_entries WHERE state IN ('pending','dispatching') ORDER BY enqueue_sequence")
      .all();
    return rows.map((row) => {
      const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema, message: z.string(), state: queueStateSchema, created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema }).strict().parse(row);
      return { id: parsed.id, sessionId: parsed.session_id, message: parsed.message, state: parsed.state, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
    });
  }

  transitionQueue(id: QueueId, from: QueueState, to: QueueState): boolean {
    const parsedFrom = queueStateSchema.parse(from);
    const parsedTo = queueStateSchema.parse(to);
    if (!canTransitionQueue(parsedFrom, parsedTo)) {
      throw new Error(`Illegal queue transition: ${parsedFrom} -> ${parsedTo}`);
    }
    const now = this.#now();
    const result = this.#database.query("UPDATE queue_entries SET state=?,updated_at=? WHERE id=? AND state=?").run(parsedTo, now, id, parsedFrom);
    return result.changes === 1;
  }

  beginQueueEffect(input: {
    queueId: QueueId;
    sessionId: SessionId;
    profileGeneration: number;
    evidence: QueueEffectEvidence;
  }): QueueEffectEvidenceRecord {
    const queueId = queueIdSchema.parse(input.queueId);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const generation = z.number().int().nonnegative().parse(input.profileGeneration);
    const evidence = queueEffectEvidenceSchema.parse(input.evidence);
    if (evidence.queueId !== queueId || evidence.sessionId !== sessionId || evidence.profileGeneration !== generation) {
      throw new Error("QUEUE_EFFECT_REQUEST_MISMATCH");
    }
    const canonical = JSON.stringify(evidence);
    const digest = digestJson(evidence);
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const authority = z.object({
        queue_state: z.literal("pending"),
        queue_session_id: sessionIdSchema,
        queue_message: z.string().min(1).max(262_144),
        profile_id: profileIdSchema,
        provider_thread_id: providerThreadIdSchema,
        session_state: z.literal("idle"),
        process_generation: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(`SELECT q.state AS queue_state,q.session_id AS queue_session_id,q.message AS queue_message,
                                                     s.profile_id,s.provider_thread_id,s.state AS session_state,p.process_generation
                                              FROM queue_entries q
                                              JOIN sessions s ON s.id=q.session_id
                                              JOIN profiles p ON p.id=s.profile_id
                                              WHERE q.id=?`).get(queueId));
      if (
        authority.queue_session_id !== sessionId
        || authority.provider_thread_id !== evidence.providerThreadId
        || authority.process_generation !== generation
        || createHash("sha256").update(authority.queue_message).digest("hex") !== evidence.messageDigest
        || evidence.runtimeProfile.profileId !== authority.profile_id
        || evidence.runtimeProfile.processGeneration !== generation
      ) throw new Error("QUEUE_EFFECT_AUTHORITY_CHANGED");
      this.#database.query("INSERT INTO queue_effect_evidence(queue_id,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?)").run(queueId, canonical, digest, now);
      const changed = this.#database.query("UPDATE queue_entries SET state='dispatching',updated_at=? WHERE id=? AND state='pending'").run(now, queueId);
      if (changed.changes !== 1) throw new Error("QUEUE_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return { queueId, digest, evidence, recordedAt: now };
  }

  readQueueEffect(queueId: QueueId): QueueEffectEvidenceRecord | null {
    const parsedQueueId = queueIdSchema.parse(queueId);
    const row = this.#database.query(`SELECT e.evidence_json,e.evidence_digest,e.recorded_at,
                                             r.resolution_kind,r.evidence_json AS resolution_evidence_json,
                                             r.receipt_json,r.created_at AS resolution_created_at
                                      FROM queue_effect_evidence e
                                      LEFT JOIN queue_effect_resolutions r ON r.queue_id=e.queue_id
                                      WHERE e.queue_id=?`).get(parsedQueueId) as {
      evidence_json: string;
      evidence_digest: string;
      recorded_at: number;
      resolution_kind: "proven_applied" | "abandoned" | null;
      resolution_evidence_json: string | null;
      receipt_json: string | null;
      resolution_created_at: number | null;
    } | null;
    if (row === null) return null;
    const evidence = queueEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
    const digest = sha256Schema.parse(row.evidence_digest);
    if (evidence.queueId !== parsedQueueId || digestJson(evidence) !== digest) throw new Error("QUEUE_EFFECT_EVIDENCE_MISMATCH");
    return {
      queueId: parsedQueueId,
      digest,
      evidence,
      recordedAt: unixMillisecondsSchema.parse(row.recorded_at),
      ...(row.resolution_kind === null ? {} : {
        resolution: {
          kind: row.resolution_kind,
          evidence: JSON.parse(z.string().parse(row.resolution_evidence_json)) as unknown,
          ...(row.receipt_json === null ? {} : { receipt: JSON.parse(row.receipt_json) as unknown }),
          createdAt: unixMillisecondsSchema.parse(row.resolution_created_at),
        },
      }),
    };
  }

  listUnsettledQueueEffects(sessionId: SessionId): readonly QueueEffectEvidenceRecord[] {
    const rows = this.#database.query(`SELECT q.id FROM queue_entries q
                                       JOIN queue_effect_evidence e ON e.queue_id=q.id
                                       LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
                                       WHERE q.session_id=? AND q.state IN ('dispatching','ambiguous') AND r.queue_id IS NULL
                                       ORDER BY q.enqueue_sequence`).all(sessionId);
    return rows.map((row) => {
      const id = z.object({ id: queueIdSchema }).strict().parse(row).id;
      const record = this.readQueueEffect(id);
      if (record === null) throw new Error("Queue effect disappeared during unsettled read.");
      return record;
    });
  }

  recoverDispatchingQueueEffects(): { recovered: readonly QueueId[]; unresolved: readonly QueueId[] } {
    const recovered: QueueId[] = [];
    const unresolved: QueueId[] = [];
    const recover = this.#database.transaction(() => {
      const rows = this.#database.query("SELECT id,session_id FROM queue_entries WHERE state='dispatching' ORDER BY enqueue_sequence").all();
      for (const row of rows) {
        const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema }).strict().parse(row);
        const record = this.readQueueEffect(parsed.id);
        if (record === null || record.evidence.sessionId !== parsed.session_id) {
          unresolved.push(parsed.id);
          continue;
        }
        const binding = z.object({ provider_thread_id: providerThreadIdSchema.nullable(), process_generation: z.number().int().nonnegative() }).strict().parse(
          this.#database.query(`SELECT s.provider_thread_id,p.process_generation FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?`).get(parsed.session_id),
        );
        if (binding.provider_thread_id !== record.evidence.providerThreadId || binding.process_generation !== record.evidence.profileGeneration) {
          unresolved.push(parsed.id);
          continue;
        }
        const now = this.#now();
        const queueChanged = this.#database.query("UPDATE queue_entries SET state='ambiguous',updated_at=? WHERE id=? AND state='dispatching'").run(now, parsed.id);
        if (queueChanged.changes !== 1) throw new Error("QUEUE_RECOVERY_CAS_CONFLICT");
        this.#database.query(`UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=?
                              WHERE id=? AND state NOT IN ('recovery_required','terminal')`).run(now, parsed.session_id);
        recovered.push(parsed.id);
      }
    });
    recover.immediate();
    return { recovered, unresolved };
  }

  completeQueueEffect(input: {
    queueId: QueueId;
    expectedEvidenceDigest: string;
    expectedSessionRevision: number;
    applyResponseState: boolean;
    turnId: string;
    turnStatus: "completed" | "interrupted" | "failed" | "inProgress";
    runtimeProfile: EffectiveRuntimeProfile;
    receipt: unknown;
  }): void {
    const queueId = queueIdSchema.parse(input.queueId);
    const evidenceDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const profile = effectiveRuntimeProfileSchema.parse(input.runtimeProfile);
    const now = this.#now();
    const complete = this.#database.transaction(() => {
      const row = z.object({ session_id: sessionIdSchema, state: z.literal("dispatching"), evidence_json: z.string(), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT q.session_id,q.state,e.evidence_json,e.evidence_digest
                              FROM queue_entries q JOIN queue_effect_evidence e ON e.queue_id=q.id WHERE q.id=?`).get(queueId),
      );
      const evidence = queueEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (row.evidence_digest !== evidenceDigest || digestJson(evidence) !== evidenceDigest || JSON.stringify(evidence.runtimeProfile) !== JSON.stringify(profile)) {
        throw new Error("QUEUE_EFFECT_EVIDENCE_MISMATCH");
      }
      this.#bindSessionTurnRuntimeProfile({
        sessionId: row.session_id,
        sourceKind: "queue_start",
        sourceId: queueId,
        turnId: input.turnId,
        profile,
      }, now);
      const queueChanged = this.#database.query("UPDATE queue_entries SET state='applied',updated_at=? WHERE id=? AND state='dispatching'").run(now, queueId);
      if (queueChanged.changes !== 1) throw new Error("QUEUE_EFFECT_CAS_CONFLICT");
      const nextState = input.turnStatus === "inProgress" ? "active" : "idle";
      if (input.applyResponseState) {
        const sessionChanged = this.#database.query(`UPDATE sessions SET state=?,active_turn_id=?,revision=revision+1,updated_at=?
                                                     WHERE id=? AND revision=? AND state NOT IN ('recovery_required','terminal')`).run(
          nextState,
          nextState === "active" ? z.string().min(1).max(200).parse(input.turnId) : null,
          now,
          row.session_id,
          z.number().int().positive().parse(input.expectedSessionRevision),
        );
        if (sessionChanged.changes !== 1) throw new Error("QUEUE_EFFECT_SESSION_CAS_CONFLICT");
      }
    });
    complete.immediate();
  }

  failQueueEffect(queueId: QueueId): boolean {
    return this.transitionQueue(queueId, "dispatching", "failed");
  }

  markQueueEffectAmbiguous(queueId: QueueId, expectedEvidenceDigest: string): SessionRecord {
    const parsedQueueId = queueIdSchema.parse(queueId);
    const digest = sha256Schema.parse(expectedEvidenceDigest);
    let sessionId: SessionId | undefined;
    const mark = this.#database.transaction(() => {
      const row = z.object({ session_id: sessionIdSchema, state: z.literal("dispatching"), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT q.session_id,q.state,e.evidence_digest FROM queue_entries q
                              JOIN queue_effect_evidence e ON e.queue_id=q.id WHERE q.id=?`).get(parsedQueueId),
      );
      if (row.evidence_digest !== digest) throw new Error("QUEUE_EFFECT_EVIDENCE_MISMATCH");
      sessionId = row.session_id;
      const now = this.#now();
      const changed = this.#database.query("UPDATE queue_entries SET state='ambiguous',updated_at=? WHERE id=? AND state='dispatching'").run(now, parsedQueueId);
      if (changed.changes !== 1) throw new Error("QUEUE_EFFECT_CAS_CONFLICT");
      this.#database.query(`UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=?
                            WHERE id=? AND state NOT IN ('recovery_required','terminal')`).run(now, row.session_id);
    });
    mark.immediate();
    if (sessionId === undefined) throw new Error("Queue ambiguity lost its session authority.");
    return this.requireSession(sessionId);
  }

  resolveQueueEffect(input: {
    queueId: QueueId;
    expectedEvidenceDigest: string;
    resolution: "proven_applied" | "abandoned";
    resolutionEvidence: unknown;
    receipt?: unknown;
    provider: { providerThreadId: string; title: string; status: "active" | "idle" | "terminal"; activeTurnId?: string; providerUpdatedAt?: number };
  }): SessionRecord {
    const queueId = queueIdSchema.parse(input.queueId);
    const expectedDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const now = this.#now();
    let sessionId: SessionId | undefined;
    const resolve = this.#database.transaction(() => {
      const row = z.object({ session_id: sessionIdSchema, state: z.literal("ambiguous"), evidence_json: z.string(), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT q.session_id,q.state,e.evidence_json,e.evidence_digest
                              FROM queue_entries q JOIN queue_effect_evidence e ON e.queue_id=q.id
                              LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
                              WHERE q.id=? AND r.queue_id IS NULL`).get(queueId),
      );
      const evidence = queueEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (row.evidence_digest !== expectedDigest || digestJson(evidence) !== expectedDigest) throw new Error("QUEUE_RECOVERY_EVIDENCE_MISMATCH");
      sessionId = row.session_id;
      const session = mapSession(this.#database.query("SELECT * FROM sessions WHERE id=?").get(row.session_id));
      if (session.providerThreadId !== input.provider.providerThreadId || evidence.providerThreadId !== input.provider.providerThreadId) {
        throw new Error("QUEUE_RECOVERY_THREAD_MISMATCH");
      }
      const changed = this.#database.query(`UPDATE sessions SET title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                            WHERE id=? AND revision=? AND state='recovery_required'`).run(
        titleSchema.parse(input.provider.title),
        input.provider.status,
        input.provider.activeTurnId ?? null,
        input.provider.providerUpdatedAt ?? session.providerUpdatedAt ?? null,
        now,
        row.session_id,
        session.revision,
      );
      if (changed.changes !== 1) throw new Error("QUEUE_RECOVERY_SESSION_CAS_CONFLICT");
      if (input.resolution === "proven_applied") {
        const recoveredTurn = z.object({ turnId: z.string().min(1).max(200) }).passthrough().parse(input.receipt);
        this.#bindSessionTurnRuntimeProfile({
          sessionId: row.session_id,
          sourceKind: "queue_start",
          sourceId: queueId,
          turnId: recoveredTurn.turnId,
          profile: evidence.runtimeProfile,
        }, now);
      }
      this.#database.query("INSERT INTO queue_effect_resolutions(queue_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(
        queueId,
        input.resolution,
        JSON.stringify(input.resolutionEvidence),
        input.receipt === undefined ? null : JSON.stringify(input.receipt),
        now,
      );
    });
    resolve.immediate();
    if (sessionId === undefined) throw new Error("Queue recovery lost its session authority.");
    return this.requireSession(sessionId);
  }

  readMutation(idempotencyKey: string): MutationAttemptRecord | null {
    const row = this.#database
      .query(`SELECT m.id,m.idempotency_key,m.kind,m.authority_id,m.authority_generation,m.request_digest,m.state,m.result_json,
                     e.evidence_json,e.evidence_digest,e.recorded_at,
                     r.resolution_kind,r.evidence_json AS resolution_evidence_json,r.receipt_json,r.created_at AS resolution_created_at,
                     s.session_id AS session_start_id
              FROM mutation_attempts m
              LEFT JOIN mutation_effect_evidence e ON e.attempt_id=m.id
              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
              WHERE m.idempotency_key=?`)
      .get(idempotencyKey) as {
        id: AttemptId;
        idempotency_key: string;
        kind: string;
        authority_id: string;
        authority_generation: number;
        request_digest: string;
        state: Exclude<MutationState, "reconciled">;
        result_json: string | null;
        evidence_json: string | null;
        evidence_digest: string | null;
        recorded_at: number | null;
        resolution_kind: MutationResolutionRecord["kind"] | null;
        resolution_evidence_json: string | null;
        receipt_json: string | null;
        resolution_created_at: number | null;
        session_start_id: SessionId | null;
      } | null;
    if (row === null) return null;
    const originalState = mutationStateSchema.exclude(["reconciled"]).parse(row.state);
    let evidence: MutationEffectEvidenceRecord | undefined;
    if (row.evidence_json !== null) {
      const parsedEvidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown) as MutationEffectEvidence;
      const parsedDigest = sha256Schema.parse(row.evidence_digest);
      if (digestJson(parsedEvidence) !== parsedDigest) throw new Error("MUTATION_EFFECT_EVIDENCE_DIGEST_MISMATCH");
      evidence = {
        attemptId: attemptIdSchema.parse(row.id),
        digest: parsedDigest,
        evidence: parsedEvidence,
        recordedAt: unixMillisecondsSchema.parse(row.recorded_at),
      };
    }
    const resolution = row.resolution_kind === null
      ? undefined
      : {
          kind: mutationResolutionKindSchema.parse(row.resolution_kind),
          evidence: JSON.parse(z.string().parse(row.resolution_evidence_json)) as unknown,
          ...(row.receipt_json === null ? {} : { receipt: JSON.parse(row.receipt_json) as unknown }),
          createdAt: unixMillisecondsSchema.parse(row.resolution_created_at),
        } satisfies MutationResolutionRecord;
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      authorityId: row.authority_id,
      authorityGeneration: row.authority_generation,
      requestDigest: row.request_digest,
      state: resolution === undefined ? originalState : "reconciled",
      ...(resolution === undefined
        ? row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }
        : resolution.receipt === undefined ? {} : { result: resolution.receipt }),
      ...(resolution === undefined ? {} : { originalState, resolution }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(row.session_start_id === null ? {} : { sessionStartId: sessionIdSchema.parse(row.session_start_id) }),
    };
  }

  readPendingLoginAuthority(profileId: ProfileId, processGeneration: number): PendingLoginAuthority | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(processGeneration);
    const rows = this.#database.query(`SELECT a.attempt_id,m.idempotency_key,a.login_id
                                       FROM provider_login_authorities a
                                       JOIN mutation_attempts m ON m.id=a.attempt_id
                                       WHERE a.profile_id=? AND a.process_generation=? AND a.state='active'
                                       ORDER BY a.recorded_at,a.attempt_id`).all(parsedProfileId, parsedGeneration) as {
      attempt_id: string;
      idempotency_key: string;
      login_id: string;
    }[];
    const pending = rows.map((row) => ({
        attemptId: attemptIdSchema.parse(row.attempt_id),
        idempotencyKey: z.string().uuid().parse(row.idempotency_key),
        profileId: parsedProfileId,
        processGeneration: parsedGeneration,
        loginId: providerLoginIdSchema.parse(row.login_id),
      } satisfies PendingLoginAuthority));
    if (pending.length > 1) throw new Error("LOGIN_CANCEL_AUTHORITY_AMBIGUOUS");
    return pending[0] ?? null;
  }

  completeAccountLoginMutation(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    processGeneration: number;
    receipt:
      | { status: "pending"; loginId: string }
      | { status: "signed_in"; account: { signedIn: true; email?: string | undefined; plan?: string | undefined } };
  }): ProfileRecord {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().positive().parse(input.processGeneration);
    const receipt = z.discriminatedUnion("status", [
      pendingLoginReceiptAuthoritySchema.strict(),
      z.object({
        status: z.literal("signed_in"),
        account: z.object({
          signedIn: z.literal(true),
          email: z.string().max(1_024).optional(),
          plan: z.string().max(128).optional(),
        }).strict(),
      }).strict(),
    ]).parse(input.receipt);
    const now = this.#now();
    const complete = this.#database.transaction(() => {
      const authority = z.object({
        kind: z.literal("account.login"),
        authority_id: profileIdSchema,
        authority_generation: z.number().int().positive(),
        mutation_state: z.literal("effect_started"),
        profile_generation: z.number().int().positive(),
        profile_state: z.literal("login_pending"),
        evidence_kind: z.literal("account.login"),
      }).strict().parse(this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state AS mutation_state,
                                                     p.process_generation AS profile_generation,p.state AS profile_state,
                                                     e.kind AS evidence_kind
                                              FROM mutation_attempts m
                                              JOIN profiles p ON p.id=m.authority_id
                                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                                              WHERE m.id=?`).get(attemptId));
      if (
        authority.authority_id !== profileId
        || authority.authority_generation !== processGeneration
        || authority.profile_generation !== processGeneration
      ) throw new Error("LOGIN_MUTATION_AUTHORITY_CHANGED");
      if (receipt.status === "pending") {
        this.#database.query(`INSERT INTO provider_login_authorities(
          attempt_id,profile_id,process_generation,login_id,state,recorded_at,updated_at
        ) VALUES (?,?,?,?,'active',?,?)`).run(
          attemptId,
          profileId,
          processGeneration,
          receipt.loginId,
          now,
          now,
        );
      } else {
        const profileChanged = this.#database.query(`UPDATE profiles
                                                     SET state='signed_in',provider_email=?,provider_plan=?,updated_at=?
                                                     WHERE id=? AND process_generation=? AND state='login_pending'`).run(
          receipt.account.email ?? null,
          receipt.account.plan ?? null,
          now,
          profileId,
          processGeneration,
        );
        if (profileChanged.changes !== 1) throw new Error("LOGIN_MUTATION_PROFILE_CAS_CONFLICT");
      }
      const changed = this.#database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'").run(
        JSON.stringify(receipt),
        now,
        attemptId,
      );
      if (changed.changes !== 1) throw new Error("LOGIN_MUTATION_CAS_CONFLICT");
    });
    complete.immediate();
    return this.requireProfileById(profileId);
  }

  settlePendingLogin(input: {
    profileId: ProfileId;
    processGeneration: number;
    loginId: string;
    providerStatus: "canceled" | "not_found";
    provider: { signedIn: boolean; email?: string; plan?: string };
  }): ProfileRecord {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative().parse(input.processGeneration);
    const loginId = providerLoginIdSchema.parse(input.loginId);
    const providerStatus = z.enum(["canceled", "not_found"]).parse(input.providerStatus);
    const provider = z.object({
      signedIn: z.boolean(),
      email: z.string().max(1_024).optional(),
      plan: z.string().max(128).optional(),
    }).strict().parse(input.provider);
    const settle = this.#database.transaction(() => {
      const current = mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=?").get(profileId));
      if (current.processGeneration !== processGeneration) {
        throw new Error("LOGIN_CANCEL_GENERATION_MISMATCH");
      }
      if (current.state === "signed_in" || current.state === "signed_out") return current;
      if (current.state !== "login_pending") throw new Error("LOGIN_CANCEL_PROFILE_STATE_MISMATCH");
      const authority = this.readPendingLoginAuthority(profileId, processGeneration);
      if (authority === null || authority.loginId !== loginId) {
        throw new Error("LOGIN_CANCEL_AUTHORITY_MISMATCH");
      }
      const now = this.#now();
      const changed = this.#database.query(`UPDATE profiles
                                            SET state=?,provider_email=?,provider_plan=?,updated_at=?
                                            WHERE id=? AND process_generation=? AND state='login_pending'`).run(
        provider.signedIn ? "signed_in" : "signed_out",
        provider.signedIn ? provider.email ?? null : null,
        provider.signedIn ? provider.plan ?? null : null,
        now,
        profileId,
        processGeneration,
      );
      if (changed.changes !== 1) throw new Error("LOGIN_CANCEL_PROFILE_CAS_CONFLICT");
      const authorityChanged = this.#database.query(`UPDATE provider_login_authorities
                                                     SET state='settled',settlement=?,updated_at=?
                                                     WHERE attempt_id=? AND profile_id=? AND process_generation=? AND login_id=? AND state='active'`).run(
        provider.signedIn ? "signed_in" : providerStatus,
        now,
        authority.attemptId,
        profileId,
        processGeneration,
        loginId,
      );
      if (authorityChanged.changes !== 1) throw new Error("LOGIN_CANCEL_AUTHORITY_CAS_CONFLICT");
      return mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=?").get(profileId));
    });
    return settle.immediate();
  }

  prepareMutation(input: { kind: string; authorityId: string; authorityGeneration: number; request: unknown; idempotencyKey?: string | undefined }): { id: AttemptId; state: MutationState; replay: boolean; result?: unknown } {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const canonical = JSON.stringify({ kind: input.kind, authorityId: input.authorityId, authorityGeneration: input.authorityGeneration, request: input.request });
    const digest = createHash("sha256").update(canonical).digest("hex");
    const existing = this.readMutation(idempotencyKey);
    if (existing !== null) {
      if (
        existing.kind !== input.kind
        || existing.authorityId !== input.authorityId
        || existing.authorityGeneration !== input.authorityGeneration
        || existing.requestDigest !== digest
      ) throw new Error("IDEMPOTENCY_CONFLICT");
      return { id: existing.id, state: existing.state, replay: true, ...(existing.result === undefined ? {} : { result: existing.result }) };
    }
    const unsettled = this.#database
      .query(`SELECT m.id FROM mutation_attempts m
              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
              LEFT JOIN desktop_switch_resolutions dr ON dr.attempt_id=m.id
              WHERE m.authority_id=? AND m.authority_generation=?
                AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL AND dr.attempt_id IS NULL
              LIMIT 1`)
      .get(input.authorityId, input.authorityGeneration);
    if (unsettled !== null) throw new Error("UNSETTLED_MUTATION_AUTHORITY");
    const id = createAttemptId();
    const now = this.#now();
    this.#database.query("INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, idempotencyKey, input.kind, input.authorityId, input.authorityGeneration, digest, "prepared", now, now);
    return { id, state: "prepared", replay: false };
  }

  transitionMutation(id: AttemptId, from: MutationState, to: MutationState, result?: unknown): boolean {
    if (from === "reconciled" || to === "reconciled") {
      throw new Error("Reconciliation is append-only and cannot rewrite a mutation attempt.");
    }
    const now = this.#now();
    const resultJson = result === undefined ? null : JSON.stringify(result);
    const update = this.#database.query("UPDATE mutation_attempts SET state=?,result_json=?,updated_at=? WHERE id=? AND state=?").run(to, resultJson, now, id, from);
    return update.changes === 1;
  }

  beginSessionMutationEffect(input: {
    attemptId: AttemptId;
    sessionId: SessionId;
    profileGeneration: number;
    evidence: Extract<MutationEffectEvidence, { kind: "session.send" | "session.steer" | "session.stop" | "session.rename" }>;
  }): MutationEffectEvidenceRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const evidence = mutationEffectEvidenceSchema.parse(input.evidence) as typeof input.evidence;
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const authority = z.object({
        kind: z.string(),
        authority_id: sessionIdSchema,
        authority_generation: z.number().int().nonnegative(),
        state: z.literal("prepared"),
        profile_id: profileIdSchema,
        provider_thread_id: providerThreadIdSchema,
        process_generation: z.number().int().nonnegative(),
        session_state: sessionStateSchema,
      }).strict().parse(this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,
                                                      s.profile_id,s.provider_thread_id,p.process_generation,s.state AS session_state
                                               FROM mutation_attempts m
                                               JOIN sessions s ON s.id=m.authority_id
                                               JOIN profiles p ON p.id=s.profile_id
                                               WHERE m.id=?`).get(parsedAttemptId));
      if (
        authority.kind !== evidence.kind
        || authority.authority_id !== parsedSessionId
        || authority.authority_generation !== parsedGeneration
        || authority.process_generation !== parsedGeneration
        || authority.provider_thread_id !== evidence.providerThreadId
        || (evidence.kind === "session.send" && evidence.runtimeProfile !== undefined && (
          evidence.runtimeProfile.profileId !== authority.profile_id
          || evidence.runtimeProfile.processGeneration !== parsedGeneration
        ))
        || authority.session_state === "recovery_required"
        || authority.session_state === "terminal"
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return { attemptId: parsedAttemptId, digest, evidence, recordedAt: now };
  }

  beginSessionStartEffect(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    profileGeneration: number;
    projectId: ProjectId;
    preset: Preset;
    fastEnabled: boolean;
    evidence: Extract<MutationEffectEvidence, { kind: "session.start" }>;
  }): SessionRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedProfileId = profileIdSchema.parse(input.profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const parsedProjectId = projectIdSchema.parse(input.projectId);
    const parsedPreset = presetSchema.parse(input.preset);
    const evidence = mutationEffectEvidenceSchema.parse(input.evidence) as typeof input.evidence;
    if (evidence.projectId !== parsedProjectId) throw new Error("MUTATION_EFFECT_REQUEST_MISMATCH");
    if (evidence.runtimeProfile !== undefined && (
      evidence.runtimeProfile.profileId !== parsedProfileId
      || evidence.runtimeProfile.processGeneration !== parsedGeneration
      || evidence.runtimeProfile.preset !== parsedPreset
      || evidence.runtimeProfile.fast !== input.fastEnabled
    )) throw new Error("MUTATION_EFFECT_RUNTIME_PROFILE_MISMATCH");
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const sessionId = createSessionId();
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const authority = z.object({ kind: z.literal("session.start"), authority_id: profileIdSchema, authority_generation: z.number().int().nonnegative(), state: z.literal("prepared"), process_generation: z.number().int().nonnegative(), profile_state: profileStateSchema }).strict().parse(
        this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,p.process_generation,p.state AS profile_state
                              FROM mutation_attempts m JOIN profiles p ON p.id=m.authority_id WHERE m.id=?`).get(parsedAttemptId),
      );
      if (
        authority.authority_id !== parsedProfileId
        || authority.authority_generation !== parsedGeneration
        || authority.process_generation !== parsedGeneration
        || authority.profile_state !== "signed_in"
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      this.#database.query("INSERT INTO sessions(id,profile_id,project_id,title,preset,fast_enabled,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(sessionId, parsedProfileId, parsedProjectId, "Untitled session", parsedPreset, input.fastEnabled ? 1 : 0, "starting", 1, now, now);
      this.#insertSessionEventStream(sessionId, now);
      this.#database.query("INSERT INTO session_start_attempts(attempt_id,session_id,created_at) VALUES (?,?,?)").run(parsedAttemptId, sessionId, now);
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return this.requireSession(sessionId);
  }

  beginAccountMutationEffect(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    profileGeneration: number;
    evidence: Extract<MutationEffectEvidence, { kind: "account.login" | "account.logout" }>;
  }): ProfileRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedProfileId = profileIdSchema.parse(input.profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const evidence = mutationEffectEvidenceSchema.parse(input.evidence) as typeof input.evidence;
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const row = z.object({ kind: z.string(), authority_id: profileIdSchema, authority_generation: z.number().int().nonnegative(), state: z.literal("prepared"), process_generation: z.number().int().nonnegative(), profile_state: profileStateSchema }).strict().parse(
        this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,p.process_generation,p.state AS profile_state
                              FROM mutation_attempts m JOIN profiles p ON p.id=m.authority_id WHERE m.id=?`).get(parsedAttemptId),
      );
      const expectedCurrentGeneration = evidence.kind === "account.login" ? parsedGeneration - 1 : parsedGeneration;
      if (
        row.kind !== evidence.kind
        || row.authority_id !== parsedProfileId
        || row.authority_generation !== parsedGeneration
        || row.process_generation !== expectedCurrentGeneration
        || row.profile_state === "removed"
        || row.profile_state === "recovery_required"
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      if (evidence.kind === "account.login") {
        const advanced = this.#database.query("UPDATE profiles SET process_generation=?,state='login_pending',provider_email=NULL,provider_plan=NULL,updated_at=? WHERE id=? AND process_generation=?").run(parsedGeneration, now, parsedProfileId, expectedCurrentGeneration);
        if (advanced.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      }
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return this.requireProfile(parsedProfileId);
  }

  listUnsettledMutations(input: { authorityId?: string; sessionId?: SessionId } = {}): readonly MutationAttemptRecord[] {
    const rows = input.sessionId === undefined
      ? input.authorityId === undefined
        ? this.#database.query(`SELECT m.idempotency_key FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id WHERE m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL ORDER BY m.created_at,m.id`).all()
        : this.#database.query(`SELECT m.idempotency_key FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id WHERE m.authority_id=? AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL ORDER BY m.created_at,m.id`).all(input.authorityId)
      : this.#database.query(`SELECT m.idempotency_key FROM mutation_attempts m
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                              WHERE (m.authority_id=? OR s.session_id=?)
                                AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL
                              ORDER BY m.created_at,m.id`).all(input.sessionId, input.sessionId);
    return rows.map((row) => {
      const key = z.object({ idempotency_key: z.string().uuid() }).strict().parse(row).idempotency_key;
      const attempt = this.readMutation(key);
      if (attempt === null) throw new Error("Mutation disappeared during unsettled read.");
      return attempt;
    });
  }

  resolveSessionMutation(input: {
    attemptId: AttemptId;
    expectedOriginalState: "effect_started" | "ambiguous";
    expectedEvidenceDigest: string;
    resolution: MutationResolutionRecord["kind"];
    resolutionEvidence: unknown;
    receipt?: unknown;
    provider?: { providerThreadId: string; title: string; status: "active" | "idle" | "terminal"; activeTurnId?: string; providerUpdatedAt?: number };
  }): SessionRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const expectedDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const resolution = mutationResolutionKindSchema.parse(input.resolution);
    const resolutionJson = JSON.stringify(input.resolutionEvidence);
    const receiptJson = input.receipt === undefined ? null : JSON.stringify(input.receipt);
    const now = this.#now();
    let resolvedSessionId: SessionId | undefined;
    const resolveAttempt = this.#database.transaction(() => {
      const row = z.object({
        authority_id: z.string(),
        kind: z.string(),
        state: z.enum(["effect_started", "ambiguous"]),
        evidence_digest: sha256Schema,
        evidence_json: z.string(),
        session_start_id: sessionIdSchema.nullable(),
      }).strict().parse(this.#database.query(`SELECT m.authority_id,m.kind,m.state,e.evidence_digest,e.evidence_json,s.session_id AS session_start_id
                                              FROM mutation_attempts m
                                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                                              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                                              WHERE m.id=? AND r.attempt_id IS NULL`).get(parsedAttemptId));
      if (row.state !== input.expectedOriginalState || row.evidence_digest !== expectedDigest) {
        throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
      }
      const effectEvidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown) as MutationEffectEvidence;
      if (effectEvidence.kind !== row.kind || digestJson(effectEvidence) !== row.evidence_digest) {
        throw new Error("MUTATION_RECOVERY_EVIDENCE_MISMATCH");
      }
      const sessionId = row.session_start_id ?? sessionIdSchema.parse(row.authority_id);
      resolvedSessionId = sessionId;
      const session = mapSession(this.#database.query("SELECT * FROM sessions WHERE id=?").get(sessionId));
      if (input.provider !== undefined) {
        if (session.providerThreadId === undefined || session.providerThreadId !== input.provider.providerThreadId) {
          throw new Error("MUTATION_RECOVERY_THREAD_MISMATCH");
        }
        const changed = this.#database.query(`UPDATE sessions SET title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                              WHERE id=? AND revision=? AND state='recovery_required'`).run(
          titleSchema.parse(input.provider.title),
          input.provider.status,
          input.provider.activeTurnId ?? null,
          input.provider.providerUpdatedAt ?? session.providerUpdatedAt ?? null,
          now,
          session.id,
          session.revision,
        );
        if (changed.changes !== 1) throw new Error("MUTATION_RECOVERY_SESSION_CAS_CONFLICT");
      } else {
        if (row.kind !== "session.start" || session.providerThreadId !== undefined || resolution !== "abandoned") {
          throw new Error("MUTATION_RECOVERY_PROVIDER_PROJECTION_REQUIRED");
        }
        const changed = this.#database.query("UPDATE sessions SET state='terminal',active_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='recovery_required'").run(now, session.id, session.revision);
        if (changed.changes !== 1) throw new Error("MUTATION_RECOVERY_SESSION_CAS_CONFLICT");
      }
      if (resolution === "proven_applied" && (effectEvidence.kind === "session.start" || effectEvidence.kind === "session.send")) {
        if (effectEvidence.runtimeProfile === undefined) throw new Error("MUTATION_RECOVERY_RUNTIME_PROFILE_MISSING");
        if (effectEvidence.kind === "session.start") {
          this.#insertSessionRuntimeProfile({
            sessionId,
            sourceKind: "session_start",
            sourceId: parsedAttemptId,
            profile: effectEvidence.runtimeProfile,
          }, now);
        } else {
          const recoveredTurn = z.object({ turnId: z.string().min(1).max(200) }).passthrough().parse(input.receipt);
          this.#bindSessionTurnRuntimeProfile({
            sessionId,
            sourceKind: "turn_start",
            sourceId: parsedAttemptId,
            turnId: recoveredTurn.turnId,
            profile: effectEvidence.runtimeProfile,
          }, now);
        }
      }
      const inserted = this.#database.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, resolution, resolutionJson, receiptJson, now);
      if (inserted.changes !== 1) throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
    });
    resolveAttempt.immediate();
    if (resolvedSessionId === undefined) throw new Error("Mutation recovery lost its session binding.");
    return this.requireSession(resolvedSessionId);
  }

  resolveAccountMutation(input: {
    attemptId: AttemptId;
    expectedOriginalState: "effect_started" | "ambiguous";
    expectedEvidenceDigest: string;
    resolution: "proven_applied" | "provider_state_reconciled";
    resolutionEvidence: unknown;
    receipt?: unknown;
    provider: { signedIn: boolean; email?: string; plan?: string };
  }): ProfileRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const expectedDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const resolution = mutationResolutionKindSchema.parse(input.resolution);
    const now = this.#now();
    let profileId: ProfileId | undefined;
    const resolveAttempt = this.#database.transaction(() => {
      const row = z.object({ authority_id: profileIdSchema, authority_generation: z.number().int().nonnegative(), state: z.enum(["effect_started", "ambiguous"]), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT m.authority_id,m.authority_generation,m.state,e.evidence_digest
                              FROM mutation_attempts m JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              WHERE m.id=? AND r.attempt_id IS NULL`).get(parsedAttemptId),
      );
      if (row.state !== input.expectedOriginalState || row.evidence_digest !== expectedDigest) throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
      profileId = row.authority_id;
      const changed = this.#database.query(`UPDATE profiles SET state=?,provider_email=?,provider_plan=?,updated_at=?
                                            WHERE id=? AND process_generation=? AND state='recovery_required'`).run(
        input.provider.signedIn ? "signed_in" : "signed_out",
        input.provider.email ?? null,
        input.provider.plan ?? null,
        now,
        row.authority_id,
        row.authority_generation,
      );
      if (changed.changes !== 1) throw new Error("MUTATION_RECOVERY_PROFILE_CAS_CONFLICT");
      this.#database.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(
        parsedAttemptId,
        resolution,
        JSON.stringify(input.resolutionEvidence),
        input.receipt === undefined ? null : JSON.stringify(input.receipt),
        now,
      );
    });
    resolveAttempt.immediate();
    if (profileId === undefined) throw new Error("Mutation recovery lost its profile binding.");
    return this.requireProfile(profileId);
  }

  recoverEffectStartedMutations(): {
    recovered: readonly AttemptId[];
    unresolved: readonly { id: AttemptId; kind: string; authorityId: string }[];
  } {
    const recover = this.#database.transaction(() => {
      const rows = this.#database
        .query(`SELECT m.id,m.kind,m.authority_id,m.authority_generation,e.kind AS evidence_kind,e.evidence_json,e.evidence_digest,s.session_id AS session_start_id
                FROM mutation_attempts m
                LEFT JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                WHERE m.state='effect_started' AND r.attempt_id IS NULL
                ORDER BY m.created_at,m.id`)
        .all() as { id: string; kind: string; authority_id: string; authority_generation: number; evidence_kind: string | null; evidence_json: string | null; evidence_digest: string | null; session_start_id: string | null }[];
      const recovered: AttemptId[] = [];
      const unresolved: { id: AttemptId; kind: string; authorityId: string }[] = [];
      for (const raw of rows) {
        const id = attemptIdSchema.parse(raw.id);
        const authorityGeneration = z.number().int().nonnegative().parse(raw.authority_generation);
        const authorityId = z.string().min(1).max(200).parse(raw.authority_id);
        const kind = z.string().min(1).max(80).parse(raw.kind);
        let effectEvidence: MutationEffectEvidence | undefined;
        if (kind !== "desktop.switch") {
          try {
            if (raw.evidence_kind !== kind || raw.evidence_json === null) throw new Error("missing effect evidence");
            effectEvidence = mutationEffectEvidenceSchema.parse(JSON.parse(raw.evidence_json) as unknown) as MutationEffectEvidence;
            if (effectEvidence.kind !== kind || digestJson(effectEvidence) !== sha256Schema.parse(raw.evidence_digest)) throw new Error("effect evidence mismatch");
          } catch {
            unresolved.push({ id, kind, authorityId });
            continue;
          }
        }
        let authorityResolved = false;
        if (["session.send", "session.steer", "session.stop", "session.rename"].includes(kind)) {
          const parsedSession = sessionIdSchema.safeParse(authorityId);
          if (parsedSession.success) {
            const session = this.#database.query("SELECT state FROM sessions WHERE id=?").get(parsedSession.data) as { state: string } | null;
            if (session !== null) {
              if (effectEvidence === undefined || !("providerThreadId" in effectEvidence)) {
                unresolved.push({ id, kind, authorityId });
                continue;
              }
              const binding = this.#database.query("SELECT provider_thread_id FROM sessions WHERE id=?").get(parsedSession.data) as { provider_thread_id: string | null } | null;
              if (binding?.provider_thread_id !== effectEvidence.providerThreadId) {
                unresolved.push({ id, kind, authorityId });
                continue;
              }
              if (session.state !== "terminal" && session.state !== "recovery_required") {
                this.#database
                  .query("UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=?")
                  .run(this.#now(), parsedSession.data);
              }
              authorityResolved = true;
            }
          }
        } else if (["account.login", "account.logout"].includes(kind)) {
          const parsedProfile = profileIdSchema.safeParse(authorityId);
          if (parsedProfile.success) {
            const profile = this.#database
              .query("SELECT state,process_generation FROM profiles WHERE id=?")
              .get(parsedProfile.data) as { state: string; process_generation: number } | null;
            if (profile !== null && profile.process_generation === authorityGeneration) {
              if (profile.state !== "removed" && profile.state !== "recovery_required") {
                this.#database
                  .query("UPDATE profiles SET state='recovery_required',updated_at=? WHERE id=? AND process_generation=?")
                  .run(this.#now(), parsedProfile.data, authorityGeneration);
              }
              authorityResolved = true;
            }
          }
        } else if (kind === "session.start") {
          const parsedProfile = profileIdSchema.safeParse(authorityId);
          const parsedSession = sessionIdSchema.safeParse(raw.session_start_id);
          if (parsedProfile.success && parsedSession.success) {
            const binding = this.#database.query("SELECT profile_id,state FROM sessions WHERE id=?").get(parsedSession.data) as { profile_id: string; state: string } | null;
            const profile = this.#database.query("SELECT process_generation FROM profiles WHERE id=?").get(parsedProfile.data) as { process_generation: number } | null;
            if (binding?.profile_id === parsedProfile.data && profile?.process_generation === authorityGeneration) {
              if (binding.state !== "terminal" && binding.state !== "recovery_required") {
                this.#database.query("UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=?").run(this.#now(), parsedSession.data);
              }
              authorityResolved = true;
            }
          }
        } else if (kind === "desktop.switch") {
          const desktop = this.#database.query("SELECT 1 AS present FROM desktop_switches WHERE attempt_id=?").get(id);
          if (desktop !== null) {
            this.#markDesktopRecovery(this.#readDesktopSwitchByAttempt(id), "EFFECT_ADJACENT_RESTART");
            authorityResolved = true;
          }
        }
        if (!authorityResolved) {
          unresolved.push({ id, kind, authorityId });
          continue;
        }
        if (kind !== "desktop.switch" && !this.transitionMutation(id, "effect_started", "ambiguous", { code: "DAEMON_RESTART" })) {
          throw new Error("Mutation changed during restart recovery.");
        }
        recovered.push(id);
      }
      return { recovered, unresolved };
    });
    return recover.immediate();
  }

  readDesktopSwitchReplay(input: {
    readonly idempotencyKey: string;
    readonly requestedSource?: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
    readonly target: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
  }): DesktopSwitchPlan | null {
    const parsed = desktopSwitchBeginSchema.parse(input);
    const existing = this.#database
      .query("SELECT kind FROM mutation_attempts WHERE idempotency_key=?")
      .get(parsed.idempotencyKey) as { kind: string } | null;
    if (existing === null) return null;
    if (existing.kind !== "desktop.switch") throw new Error("IDEMPOTENCY_CONFLICT");
    const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
    if (
      row.source_profile_id !== (parsed.requestedSource?.profileId ?? null) ||
      row.source_generation !== (parsed.requestedSource?.processGeneration ?? null) ||
      row.target_profile_id !== parsed.target.profileId ||
      row.target_generation !== parsed.target.processGeneration
    ) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
    return this.#desktopSwitchPlan(row.attempt_id);
  }

  async beginDesktopSwitch(input: {
    readonly idempotencyKey: string;
    readonly requestedSource?: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
    readonly target: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
  }): Promise<DesktopSwitchPlan> {
    const parsed = desktopSwitchBeginSchema.parse(input);
    const request = {
      sourceProfileId: parsed.requestedSource?.profileId ?? null,
      sourceProcessGeneration: parsed.requestedSource?.processGeneration ?? null,
      targetProfileId: parsed.target.profileId,
      targetProcessGeneration: parsed.target.processGeneration,
    } as const;

    const begin = this.#database.transaction((): DesktopSwitchPlan => {
      const attempt = this.prepareMutation({
        kind: "desktop.switch",
        authorityId: "desktop",
        authorityGeneration: parsed.target.processGeneration,
        request,
        idempotencyKey: parsed.idempotencyKey,
      });
      if (attempt.replay) return this.#desktopSwitchPlan(attempt.id);

      const target = this.#requireCurrentDesktopProfile(
        parsed.target.profileId,
        parsed.target.processGeneration,
      );
      if (target.state !== "signed_in" || target.providerEmail === undefined) {
        throw new Error("DESKTOP_TARGET_ACCOUNT_UNVERIFIED");
      }
      const expectedAccountKey = desktopAccountKeySchema.parse(target.providerEmail);
      if (parsed.requestedSource !== undefined) {
        this.#requireCurrentDesktopProfile(
          parsed.requestedSource.profileId,
          parsed.requestedSource.processGeneration,
        );
      }

      const authority = z
        .object({
          current_generation: z.number().int().nonnegative(),
          current_attempt_id: z.string().nullable(),
          released_generation: z.number().int().nonnegative(),
        })
        .strict()
        .parse(
          this.#database
            .query("SELECT current_generation,current_attempt_id,released_generation FROM desktop_switch_authority WHERE singleton=1")
            .get(),
        );
      if (
        authority.current_attempt_id !== null &&
        authority.released_generation !== authority.current_generation
      ) {
        throw new Error("DESKTOP_EFFECTS_UNSETTLED");
      }
      const switchGeneration = authority.current_generation + 1;
      if (!Number.isSafeInteger(switchGeneration)) throw new Error("DESKTOP_SWITCH_GENERATION_EXHAUSTED");
      const now = this.#now();
      this.#database
        .query(
          "INSERT INTO desktop_switches(attempt_id,source_profile_id,target_profile_id,source_generation,target_generation,phase,updated_at,switch_generation,journal_prepared,expected_account_key) VALUES (?,?,?,?,?,'prepared',?,?,0,?)",
        )
        .run(
          attempt.id,
          request.sourceProfileId,
          request.targetProfileId,
          request.sourceProcessGeneration,
          request.targetProcessGeneration,
          now,
          switchGeneration,
          expectedAccountKey,
        );
      const advanced = this.#database
        .query(
          "UPDATE desktop_switch_authority SET current_generation=?,current_attempt_id=? WHERE singleton=1 AND current_generation=? AND current_attempt_id IS ? AND released_generation=?",
        )
        .run(
          switchGeneration,
          attempt.id,
          authority.current_generation,
          authority.current_attempt_id,
          authority.released_generation,
        );
      if (advanced.changes !== 1) throw new Error("DESKTOP_SWITCH_GENERATION_CONFLICT");
      return {
        status: "ready",
        idempotencyKey: parsed.idempotencyKey,
        switchGeneration,
        sourceProfileId: request.sourceProfileId,
        sourceProcessGeneration: request.sourceProcessGeneration,
        targetProfileId: request.targetProfileId,
        targetProcessGeneration: request.targetProcessGeneration,
        journalStage: "new",
        expectedAccountKey,
      };
    });
    return begin.immediate();
  }

  async prepareDesktopSwitchJournal(entry: DesktopSwitchJournalEntry): Promise<void> {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
        bundleCdHash: z.string().regex(/^[a-f0-9]{40,128}$/u),
        sourcePid: z.number().int().positive().nullable(),
        targetPaths: z
          .object({
            profileRoot: z.string().min(1).max(4096),
            codexHome: z.string().min(1).max(4096),
            desktopUserData: z.string().min(1).max(4096),
          })
          .strict(),
        expectedAccountKey: desktopAccountKeySchema,
      })
      .strict()
      .parse(entry);
    if ((parsed.sourceProfileId === null) !== (parsed.sourceProcessGeneration === null)) {
      throw new Error("DESKTOP_SOURCE_AUTHORITY_INCOMPLETE");
    }
    const journalDigest = digestJson(parsed);
    const prepare = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
      this.#assertDesktopBinding(row, parsed);
      if (!this.#isDesktopSwitchCurrentParsed(parsed)) throw new Error("DESKTOP_SWITCH_GENERATION_STALE");
      if (row.phase !== "prepared" || row.mutation_state !== "prepared") {
        throw new Error("DESKTOP_SWITCH_NOT_PREPARABLE");
      }
      if (row.journal_prepared === 1) {
        if (
          row.journal_digest !== journalDigest ||
          row.bundle_cd_hash !== parsed.bundleCdHash ||
          row.source_pid !== parsed.sourcePid
        ) {
          throw new Error("DESKTOP_JOURNAL_BINDING_CONFLICT");
        }
        return;
      }
      const now = this.#now();
      const recoveryDeadlineAt = now + desktopRecoverySettlementMs;
      if (!Number.isSafeInteger(recoveryDeadlineAt)) {
        throw new Error("DESKTOP_RECOVERY_DEADLINE_EXHAUSTED");
      }
      const updated = this.#database
        .query(
          "UPDATE desktop_switches SET journal_prepared=1,journal_digest=?,bundle_cd_hash=?,source_pid=?,recovery_deadline_at=?,updated_at=? WHERE attempt_id=? AND phase='prepared' AND journal_prepared=0",
        )
        .run(journalDigest, parsed.bundleCdHash, parsed.sourcePid, recoveryDeadlineAt, now, row.attempt_id);
      if (updated.changes !== 1) throw new Error("DESKTOP_JOURNAL_PREPARE_CONFLICT");
    });
    prepare.immediate();
  }

  async advanceDesktopSwitchJournal(input: {
    readonly idempotencyKey: string;
    readonly switchGeneration: number;
    readonly stage: DesktopSwitchStage;
    readonly launchedPid?: number;
    readonly diagnostic?: string;
  }): Promise<void> {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        stage: desktopSwitchStageSchema,
        launchedPid: z.number().int().positive().optional(),
        diagnostic: desktopDiagnosticSchema.optional(),
      })
      .strict()
      .parse(input);
    const advance = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
      if (row.switch_generation !== parsed.switchGeneration) {
        throw new Error("DESKTOP_SWITCH_GENERATION_CONFLICT");
      }
      if (parsed.stage === "recovery-required") {
        this.#markDesktopRecovery(
          row,
          parsed.diagnostic ?? "DESKTOP_SWITCH_RECOVERY_REQUIRED",
        );
        return;
      }
      if (!this.#isDesktopSwitchCurrentRow(row)) throw new Error("DESKTOP_SWITCH_GENERATION_STALE");
      if (row.journal_prepared !== 1) throw new Error("DESKTOP_JOURNAL_NOT_PREPARED");
      const nextPhase = switchPhaseByStage[parsed.stage];
      if (row.phase === nextPhase) {
        if (
          parsed.launchedPid !== undefined &&
          row.launched_pid !== null &&
          row.launched_pid !== parsed.launchedPid
        ) {
          throw new Error("DESKTOP_LAUNCHED_PID_CONFLICT");
        }
        return;
      }
      if (parsed.stage === "prepared") throw new Error("DESKTOP_SWITCH_STAGE_CONFLICT");
      if (
        (parsed.stage === "target-observed" || parsed.stage === "verified") &&
        parsed.launchedPid === undefined
      ) {
        throw new Error("DESKTOP_LAUNCHED_PID_REQUIRED");
      }
      if (
        parsed.stage === "verified" &&
        row.launched_pid !== null &&
        row.launched_pid !== parsed.launchedPid
      ) {
        throw new Error("DESKTOP_LAUNCHED_PID_CONFLICT");
      }

      if (
        (parsed.stage === "quit-requested" || parsed.stage === "launch-requested") &&
        row.mutation_state === "prepared"
      ) {
        if (!this.transitionMutation(row.attempt_id, "prepared", "effect_started")) {
          throw new Error("DESKTOP_MUTATION_START_CONFLICT");
        }
      }
      const now = this.#now();
      const phaseUpdate = this.#database
        .query(
          "UPDATE desktop_switches SET phase=?,launched_pid=COALESCE(?,launched_pid),updated_at=? WHERE attempt_id=? AND phase=?",
        )
        .run(nextPhase, parsed.launchedPid ?? null, now, row.attempt_id, row.phase);
      if (phaseUpdate.changes !== 1) throw new Error("DESKTOP_SWITCH_STAGE_CONFLICT");

      if (parsed.stage === "verified") {
        const target = this.#requireCurrentDesktopProfile(
          row.target_profile_id,
          row.target_generation,
        );
        if (target.state !== "signed_in" || target.providerEmail === undefined) {
          throw new Error("DESKTOP_TARGET_ACCOUNT_UNVERIFIED");
        }
        const email = desktopAccountKeySchema.parse(target.providerEmail);
        if (email !== row.expected_account_key) throw new Error("DESKTOP_TARGET_ACCOUNT_CHANGED");
        const plan = parseOptionalPlan(target.providerPlan);
        const activeAccount = {
          signedIn: true as const,
          email,
          ...(plan === undefined ? {} : { plan }),
        };
        if (
          !this.transitionMutation(
            row.attempt_id,
            "effect_started",
            "applied",
            { activeAccount },
          )
        ) {
          throw new Error("DESKTOP_MUTATION_APPLY_CONFLICT");
        }
        const released = this.#database
          .query("UPDATE desktop_switch_authority SET released_generation=? WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<?")
          .run(row.switch_generation, row.switch_generation, row.attempt_id, row.switch_generation);
        if (released.changes !== 1) throw new Error("DESKTOP_SWITCH_RELEASE_CONFLICT");
      }
    });
    advance.immediate();
  }

  async assertDesktopEffectsSettled(generation: DesktopSwitchGeneration): Promise<void> {
    const parsed = this.#parseDesktopGeneration(generation);
    if (!this.#isDesktopSwitchCurrentParsed(parsed)) {
      throw new Error("DESKTOP_SWITCH_GENERATION_STALE");
    }
    const row = this.#readDesktopSwitchByGeneration(parsed.switchGeneration);
    if (
      row.phase !== "prepared" ||
      row.mutation_state !== "prepared" ||
      row.journal_prepared !== 1
    ) {
      throw new Error("DESKTOP_EFFECTS_UNSETTLED");
    }
    const unresolved = z
      .object({ count: z.number().int().nonnegative() })
      .strict()
      .parse(
        this.#database
          .query(
            "SELECT COUNT(*) AS count FROM desktop_switches d LEFT JOIN desktop_switch_resolutions r ON r.attempt_id=d.attempt_id WHERE (d.switch_generation IS NULL OR d.switch_generation < ?) AND d.phase != 'applied' AND d.phase != 'failed' AND r.attempt_id IS NULL",
          )
          .get(parsed.switchGeneration),
      ).count;
    if (unresolved !== 0) throw new Error("DESKTOP_EFFECTS_UNSETTLED");
  }

  isDesktopSwitchCurrent(generation: DesktopSwitchGeneration): boolean {
    const parsed = this.#parseDesktopGenerationSafe(generation);
    return parsed === null ? false : this.#isDesktopSwitchCurrentParsed(parsed);
  }

  settlePreparedDesktopSwitch(input: DesktopSwitchGeneration & {
    readonly idempotencyKey: string;
    readonly diagnostic: string;
  }): boolean {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
        diagnostic: desktopDiagnosticSchema,
      })
      .strict()
      .parse(input);
    const settle = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
      this.#assertDesktopBinding(row, parsed);
      if (
        !this.#isDesktopSwitchCurrentRow(row) ||
        row.phase !== "prepared" ||
        row.mutation_state !== "prepared" ||
        row.resolution_kind !== null
      ) {
        return false;
      }
      const now = this.#now();
      const failed = this.#database
        .query("UPDATE desktop_switches SET phase='failed',diagnostic_code=?,updated_at=? WHERE attempt_id=? AND phase='prepared'")
        .run(parsed.diagnostic, now, row.attempt_id);
      if (failed.changes !== 1) throw new Error("DESKTOP_PRE_EFFECT_SETTLEMENT_CONFLICT");
      if (!this.transitionMutation(row.attempt_id, "prepared", "cancelled")) {
        throw new Error("DESKTOP_PRE_EFFECT_SETTLEMENT_CONFLICT");
      }
      const released = this.#database
        .query("UPDATE desktop_switch_authority SET released_generation=? WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<?")
        .run(row.switch_generation, row.switch_generation, row.attempt_id, row.switch_generation);
      if (released.changes !== 1) throw new Error("DESKTOP_PRE_EFFECT_SETTLEMENT_CONFLICT");
      return true;
    });
    return settle.immediate();
  }

  quarantineDesktopSwitchTargetByGeneration(input: DesktopSwitchGeneration & {
    readonly idempotencyKey: string;
  }): boolean {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
      })
      .strict()
      .parse(input);
    const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
    this.#assertDesktopBinding(row, parsed);
    return this.#quarantineDesktopTarget(row);
  }

  quarantineDesktopSwitchTarget(input: DesktopRecoveryBinding): boolean {
    const parsed = this.#parseDesktopRecoveryBinding(input);
    const row = this.#readDesktopSwitchByAttempt(parsed.attemptId);
    this.#assertDesktopRecoveryBinding(row, parsed);
    return this.#quarantineDesktopTarget(row);
  }

  readCurrentDesktopSwitchRecovery(): unknown {
    const authority = z
      .object({
        current_generation: z.number().int().nonnegative(),
        current_attempt_id: attemptIdSchema.nullable(),
        released_generation: z.number().int().nonnegative(),
      })
      .strict()
      .parse(
        this.#database
          .query("SELECT current_generation,current_attempt_id,released_generation FROM desktop_switch_authority WHERE singleton=1")
          .get(),
      );
    if (authority.current_attempt_id === null || authority.current_generation === 0) {
      return { status: "none" };
    }
    const row = this.#readDesktopSwitchByAttempt(authority.current_attempt_id);
    if (row.switch_generation !== authority.current_generation) {
      throw new Error("DESKTOP_SWITCH_AUTHORITY_CORRUPT");
    }
    if (row.resolution_kind !== null) {
      if (row.resolution_receipt_json === null) throw new Error("DESKTOP_RECOVERY_RECEIPT_MISSING");
      return desktopRecoveryReceiptSchema.parse(JSON.parse(row.resolution_receipt_json) as unknown);
    }
    if (authority.released_generation === authority.current_generation) {
      return { status: "none" };
    }
    if (row.phase !== "ambiguous") {
      return {
        status: "in_progress",
        idempotencyKey: row.idempotency_key,
        switchGeneration: row.switch_generation,
        targetProfileId: row.target_profile_id,
        phase: row.phase,
      };
    }
    if (
      row.bundle_cd_hash === null ||
      row.recovery_deadline_at === null ||
      row.journal_prepared !== 1
    ) {
      throw new Error("DESKTOP_RECOVERY_EVIDENCE_INCOMPLETE");
    }
    return {
      status: "recovery_required",
      attemptId: row.attempt_id,
      idempotencyKey: row.idempotency_key,
      switchGeneration: row.switch_generation,
      sourceProfileId: row.source_profile_id,
      sourceProcessGeneration: row.source_generation,
      targetProfileId: row.target_profile_id,
      targetProcessGeneration: row.target_generation,
      originalPhase: row.ambiguous_from_phase ?? "prepared",
      diagnostic: row.diagnostic_code ?? "DESKTOP_SWITCH_RECOVERY_REQUIRED",
      recoveryDeadlineAt: row.recovery_deadline_at,
      bundleCdHash: row.bundle_cd_hash,
      sourcePid: row.source_pid,
      launchedPid: row.launched_pid,
      expectedAccountKey: row.expected_account_key,
    };
  }

  resolveDesktopSwitchRecovery(input: DesktopRecoveryBinding & {
    readonly resolution: DesktopRecoveryResolution;
    readonly diagnostic: string;
    readonly observationDigest: string;
    readonly activeAccount?: { signedIn: boolean; email?: string; plan?: string };
  }): unknown {
    const binding = this.#parseDesktopRecoveryBinding(input);
    const parsed = z
      .object({
        resolution: desktopRecoveryResolutionSchema,
        diagnostic: desktopDiagnosticSchema,
        observationDigest: sha256Schema,
        activeAccount: z
          .object({
            signedIn: z.boolean(),
            email: z.string().trim().email().max(320).optional(),
            plan: z.string().trim().min(1).max(160).optional(),
          })
          .strict()
          .optional(),
      })
      .passthrough()
      .parse(input);
    const resolveRecovery = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByAttempt(binding.attemptId);
      this.#assertDesktopRecoveryBinding(row, binding);
      const authority = z
        .object({
          current_generation: z.number().int().nonnegative(),
          current_attempt_id: attemptIdSchema.nullable(),
          released_generation: z.number().int().nonnegative(),
        })
        .strict()
        .parse(
          this.#database
            .query("SELECT current_generation,current_attempt_id,released_generation FROM desktop_switch_authority WHERE singleton=1")
            .get(),
        );
      if (
        authority.current_generation !== row.switch_generation ||
        authority.current_attempt_id !== row.attempt_id
      ) {
        throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      }
      if (row.resolution_kind !== null) {
        if (
          row.resolution_kind !== parsed.resolution ||
          row.resolution_diagnostic_code !== parsed.diagnostic ||
          row.resolution_observation_digest !== parsed.observationDigest ||
          row.resolution_receipt_json === null
        ) {
          throw new Error("DESKTOP_RECOVERY_REPLAY_CONFLICT");
        }
        const existing = desktopRecoveryReceiptSchema.parse(
          JSON.parse(row.resolution_receipt_json) as unknown,
        );
        const expectedAccount = this.#desktopRecoveryAccount(
          parsed.resolution,
          parsed.activeAccount,
          row.expected_account_key,
        );
        if (JSON.stringify(existing.activeAccount ?? null) !== JSON.stringify(expectedAccount ?? null)) {
          throw new Error("DESKTOP_RECOVERY_REPLAY_CONFLICT");
        }
        return existing;
      }
      if (
        authority.released_generation >= authority.current_generation ||
        row.phase !== "ambiguous" ||
        row.mutation_state !== "ambiguous"
      ) {
        throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      }
      if (
        parsed.resolution === "resolved_not_applied" &&
        (row.recovery_deadline_at === null || this.#now() < row.recovery_deadline_at)
      ) {
        throw new Error("DESKTOP_RECOVERY_DEADLINE_PENDING");
      }
      const activeAccount = this.#desktopRecoveryAccount(
        parsed.resolution,
        parsed.activeAccount,
        row.expected_account_key,
      );
      const resolvedAt = this.#now();
      if (activeAccount !== undefined) {
        const reconciledProfile = this.#database
          .query("UPDATE profiles SET state='signed_in',provider_email=?,provider_plan=?,updated_at=? WHERE id=? AND process_generation=? AND state!='removed'")
          .run(activeAccount.email, activeAccount.plan ?? null, resolvedAt, row.target_profile_id, row.target_generation);
        if (reconciledProfile.changes !== 1) throw new Error("DESKTOP_RECOVERY_PROFILE_CAS_CONFLICT");
      }
      const receipt = desktopRecoveryReceiptSchema.parse({
        status: parsed.resolution,
        attemptId: row.attempt_id,
        idempotencyKey: row.idempotency_key,
        switchGeneration: row.switch_generation,
        sourceProfileId: row.source_profile_id,
        sourceProcessGeneration: row.source_generation,
        targetProfileId: row.target_profile_id,
        targetProcessGeneration: row.target_generation,
        diagnostic: parsed.diagnostic,
        observationDigest: parsed.observationDigest,
        resolvedAt,
        ...(activeAccount === undefined ? {} : { activeAccount }),
      });
      const inserted = this.#database
        .query("INSERT INTO desktop_switch_resolutions(attempt_id,switch_generation,resolution_kind,diagnostic_code,observation_digest,receipt_json,resolved_at) VALUES (?,?,?,?,?,?,?)")
        .run(row.attempt_id, row.switch_generation, parsed.resolution, parsed.diagnostic, parsed.observationDigest, JSON.stringify(receipt), resolvedAt);
      if (inserted.changes !== 1) throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      const released = this.#database
        .query("UPDATE desktop_switch_authority SET released_generation=? WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<?")
        .run(row.switch_generation, row.switch_generation, row.attempt_id, row.switch_generation);
      if (released.changes !== 1) throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      return receipt;
    });
    return resolveRecovery.immediate();
  }

  #parseDesktopRecoveryBinding(input: DesktopRecoveryBinding): DesktopRecoveryBinding {
    return z
      .object({
        attemptId: attemptIdSchema,
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
      })
      .strict()
      .parse({
        attemptId: input.attemptId,
        idempotencyKey: input.idempotencyKey,
        switchGeneration: input.switchGeneration,
        sourceProfileId: input.sourceProfileId,
        sourceProcessGeneration: input.sourceProcessGeneration,
        targetProfileId: input.targetProfileId,
        targetProcessGeneration: input.targetProcessGeneration,
      });
  }

  #assertDesktopRecoveryBinding(row: DesktopSwitchRow, binding: DesktopRecoveryBinding): void {
    if (
      row.attempt_id !== binding.attemptId ||
      row.idempotency_key !== binding.idempotencyKey ||
      row.switch_generation !== binding.switchGeneration ||
      row.source_profile_id !== binding.sourceProfileId ||
      row.source_generation !== binding.sourceProcessGeneration ||
      row.target_profile_id !== binding.targetProfileId ||
      row.target_generation !== binding.targetProcessGeneration
    ) {
      throw new Error("DESKTOP_RECOVERY_BINDING_CONFLICT");
    }
  }

  #quarantineDesktopTarget(row: DesktopSwitchRow): boolean {
    const quarantine = this.#database.transaction(() => {
      const current = this.#readDesktopSwitchByAttempt(row.attempt_id);
      if (
        !this.#isDesktopSwitchCurrentRow(current) ||
        current.resolution_kind !== null ||
        current.target_profile_id !== row.target_profile_id ||
        current.target_generation !== row.target_generation
      ) {
        return false;
      }
      const profile = this.#database
        .query("SELECT state FROM profiles WHERE id=? AND process_generation=?")
        .get(current.target_profile_id, current.target_generation) as { state: string } | null;
      if (profile === null || profile.state === "removed") return false;
      if (profile.state === "recovery_required") return true;
      const updated = this.#database
        .query("UPDATE profiles SET state='recovery_required',updated_at=? WHERE id=? AND process_generation=? AND state!='removed'")
        .run(this.#now(), current.target_profile_id, current.target_generation);
      return updated.changes === 1;
    });
    return quarantine.immediate();
  }

  #desktopRecoveryAccount(
    resolution: DesktopRecoveryResolution,
    account: { signedIn: boolean; email?: string | undefined; plan?: string | undefined } | undefined,
    expectedAccountKey: string,
  ): { signedIn: true; email: string; plan?: string } | undefined {
    if (resolution === "resolved_not_applied") {
      if (account !== undefined) throw new Error("DESKTOP_RECOVERY_ACCOUNT_UNEXPECTED");
      return undefined;
    }
    if (!account?.signedIn || account.email === undefined) {
      throw new Error("DESKTOP_RECOVERY_ACCOUNT_REQUIRED");
    }
    const email = desktopAccountKeySchema.parse(account.email);
    if (email !== expectedAccountKey) throw new Error("DESKTOP_RECOVERY_ACCOUNT_MISMATCH");
    const plan = parseOptionalPlan(account.plan);
    return { signedIn: true, email, ...(plan === undefined ? {} : { plan }) };
  }

  #desktopSwitchPlan(attemptId: AttemptId): DesktopSwitchPlan {
    const row = this.#readDesktopSwitchByAttempt(attemptId);
    const base = {
      idempotencyKey: row.idempotency_key,
      switchGeneration: row.switch_generation,
      sourceProfileId: row.source_profile_id,
      sourceProcessGeneration: row.source_generation,
      targetProfileId: row.target_profile_id,
      targetProcessGeneration: row.target_generation,
    } as const;
    if (row.resolution_kind !== null) {
      let recoveryReceipt: z.infer<typeof desktopRecoveryReceiptSchema> | null = null;
      try {
        const parsedReceipt = desktopRecoveryReceiptSchema.safeParse(
          row.resolution_receipt_json === null
            ? null
            : (JSON.parse(row.resolution_receipt_json) as unknown),
        );
        if (parsedReceipt.success) recoveryReceipt = parsedReceipt.data;
      } catch {
        recoveryReceipt = null;
      }
      if (
        recoveryReceipt === null ||
        recoveryReceipt.status !== row.resolution_kind ||
        recoveryReceipt.attemptId !== row.attempt_id ||
        recoveryReceipt.idempotencyKey !== row.idempotency_key ||
        recoveryReceipt.switchGeneration !== row.switch_generation ||
        recoveryReceipt.sourceProfileId !== row.source_profile_id ||
        recoveryReceipt.sourceProcessGeneration !== row.source_generation ||
        recoveryReceipt.targetProfileId !== row.target_profile_id ||
        recoveryReceipt.targetProcessGeneration !== row.target_generation ||
        recoveryReceipt.diagnostic !== row.resolution_diagnostic_code ||
        recoveryReceipt.observationDigest !== row.resolution_observation_digest ||
        recoveryReceipt.resolvedAt !== row.resolution_resolved_at
      ) {
        return { status: "recovery_required", ...base, diagnostic: "RECOVERY_RECEIPT_INVALID" };
      }
      if (recoveryReceipt.status === "resolved_not_applied") {
        return { status: "recovery_required", ...base, diagnostic: "SWITCH_RESOLVED_NOT_APPLIED" };
      }
      const active = recoveryReceipt.activeAccount;
      if (
        active === undefined ||
        !active.signedIn ||
        active.email === undefined ||
        desktopAccountKeySchema.parse(active.email) !== row.expected_account_key
      ) {
        return { status: "recovery_required", ...base, diagnostic: "RECOVERY_RECEIPT_INVALID" };
      }
      return {
        status: "applied",
        ...base,
        expectedAccountKey: row.expected_account_key,
        activeAccount: {
          signedIn: true,
          email: active.email,
          ...(active.plan === undefined ? {} : { plan: active.plan }),
        },
      };
    }
    if (row.phase === "applied" && row.mutation_state === "applied") {
      const receiptSchema = z
        .object({
          activeAccount: z
            .object({
              signedIn: z.literal(true),
              email: desktopAccountKeySchema,
              plan: z.string().min(1).max(160).optional(),
            })
            .strict(),
        })
        .strict();
      let receipt: z.infer<typeof receiptSchema> | null = null;
      try {
        const parsedReceipt = receiptSchema.safeParse(
          row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
        );
        if (parsedReceipt.success) receipt = parsedReceipt.data;
      } catch {
        receipt = null;
      }
      if (receipt === null) {
        return {
          status: "recovery_required",
          ...base,
          diagnostic: "APPLIED_RECEIPT_INVALID",
        };
      }
      return {
        status: "applied",
        ...base,
        expectedAccountKey: row.expected_account_key,
        activeAccount: {
          signedIn: true,
          email: receipt.activeAccount.email,
          ...(receipt.activeAccount.plan === undefined
            ? {}
            : { plan: receipt.activeAccount.plan }),
        },
      };
    }
    if (row.phase === "prepared" && row.mutation_state === "prepared") {
      if (!this.#isDesktopSwitchCurrentRow(row)) {
        return { status: "recovery_required", ...base, diagnostic: "SWITCH_GENERATION_STALE" };
      }
      return {
        status: "ready",
        ...base,
        journalStage: row.journal_prepared === 1 ? "prepared" : "new",
        expectedAccountKey: row.expected_account_key,
      };
    }
    if (effectAdjacentPhases.has(row.phase)) {
      this.#markDesktopRecovery(row, "EFFECT_ADJACENT_RESTART");
      return {
        status: "recovery_required",
        ...base,
        diagnostic: "EFFECT_ADJACENT_RESTART",
      };
    }
    if (
      row.phase === "ambiguous" &&
      (row.mutation_state === "prepared" || row.mutation_state === "effect_started")
    ) {
      this.#markDesktopRecovery(
        row,
        row.diagnostic_code ?? "DESKTOP_SWITCH_STATE_INCONSISTENT",
      );
    }
    return {
      status: "recovery_required",
      ...base,
      diagnostic:
        row.diagnostic_code === null
          ? "DESKTOP_SWITCH_STATE_INCONSISTENT"
          : desktopDiagnosticSchema.parse(row.diagnostic_code),
    };
  }

  #markDesktopRecovery(row: DesktopSwitchRow, diagnostic: string): void {
    const parsedDiagnostic = desktopDiagnosticSchema.parse(diagnostic);
    if (row.phase === "applied" || row.mutation_state === "applied") {
      throw new Error("DESKTOP_APPLIED_SWITCH_IMMUTABLE");
    }
    if (row.phase !== "ambiguous") {
      const ambiguousFromPhase = z
        .enum(["prepared", "quit_started", "quit_confirmed", "launch_started", "verify_started"])
        .parse(row.phase);
      const updated = this.#database
        .query(
          "UPDATE desktop_switches SET phase='ambiguous',ambiguous_from_phase=COALESCE(ambiguous_from_phase,?),diagnostic_code=?,updated_at=? WHERE attempt_id=? AND phase=?",
        )
        .run(ambiguousFromPhase, parsedDiagnostic, this.#now(), row.attempt_id, row.phase);
      if (updated.changes !== 1) throw new Error("DESKTOP_RECOVERY_MARK_CONFLICT");
    }
    if (row.mutation_state === "prepared") {
      if (!this.transitionMutation(row.attempt_id, "prepared", "effect_started")) {
        throw new Error("DESKTOP_MUTATION_START_CONFLICT");
      }
      if (!this.transitionMutation(row.attempt_id, "effect_started", "ambiguous")) {
        throw new Error("DESKTOP_MUTATION_RECOVERY_CONFLICT");
      }
    } else if (row.mutation_state === "effect_started") {
      if (!this.transitionMutation(row.attempt_id, "effect_started", "ambiguous")) {
        throw new Error("DESKTOP_MUTATION_RECOVERY_CONFLICT");
      }
    }
  }

  #readDesktopSwitchByKey(idempotencyKey: string): DesktopSwitchRow {
    const row = this.#database
      .query(`${desktopSwitchSelect} WHERE m.idempotency_key=?`)
      .get(idempotencyKey);
    if (row === null) throw new Error("DESKTOP_SWITCH_NOT_FOUND");
    return desktopSwitchRowSchema.parse(row);
  }

  #readDesktopSwitchByAttempt(attemptId: AttemptId): DesktopSwitchRow {
    const row = this.#database
      .query(`${desktopSwitchSelect} WHERE d.attempt_id=?`)
      .get(attemptId);
    if (row === null) throw new Error("DESKTOP_SWITCH_NOT_FOUND");
    return desktopSwitchRowSchema.parse(row);
  }

  #readDesktopSwitchByGeneration(switchGeneration: number): DesktopSwitchRow {
    const row = this.#database
      .query(`${desktopSwitchSelect} WHERE d.switch_generation=?`)
      .get(switchGeneration);
    if (row === null) throw new Error("DESKTOP_SWITCH_NOT_FOUND");
    return desktopSwitchRowSchema.parse(row);
  }

  #assertDesktopBinding(
    row: DesktopSwitchRow,
    binding: DesktopSwitchGeneration,
  ): void {
    if (
      row.switch_generation !== binding.switchGeneration ||
      row.source_profile_id !== binding.sourceProfileId ||
      row.source_generation !== binding.sourceProcessGeneration ||
      row.target_profile_id !== binding.targetProfileId ||
      row.target_generation !== binding.targetProcessGeneration
    ) {
      throw new Error("DESKTOP_SWITCH_BINDING_CONFLICT");
    }
  }

  #parseDesktopGeneration(generation: DesktopSwitchGeneration): DesktopSwitchGeneration {
    const parsed = z
      .object({
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
      })
      .parse(generation);
    if ((parsed.sourceProfileId === null) !== (parsed.sourceProcessGeneration === null)) {
      throw new Error("DESKTOP_SOURCE_AUTHORITY_INCOMPLETE");
    }
    return parsed;
  }

  #parseDesktopGenerationSafe(generation: DesktopSwitchGeneration): DesktopSwitchGeneration | null {
    try {
      return this.#parseDesktopGeneration(generation);
    } catch {
      return null;
    }
  }

  #isDesktopSwitchCurrentParsed(generation: DesktopSwitchGeneration): boolean {
    try {
      const row = this.#readDesktopSwitchByGeneration(generation.switchGeneration);
      this.#assertDesktopBinding(row, generation);
      return this.#isDesktopSwitchCurrentRow(row);
    } catch {
      return false;
    }
  }

  #isDesktopSwitchCurrentRow(row: DesktopSwitchRow): boolean {
    const authority = this.#database
      .query(
        "SELECT 1 AS current FROM desktop_switch_authority WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<current_generation",
      )
      .get(row.switch_generation, row.attempt_id);
    if (authority === null) return false;
    const target = this.#database
      .query(
        "SELECT 1 AS current FROM profiles WHERE id=? AND process_generation=? AND state!='removed'",
      )
      .get(row.target_profile_id, row.target_generation);
    if (target === null) return false;
    if (row.source_profile_id === null) return row.source_generation === null;
    return (
      row.source_generation !== null &&
      this.#database
        .query(
          "SELECT 1 AS current FROM profiles WHERE id=? AND process_generation=? AND state!='removed'",
        )
        .get(row.source_profile_id, row.source_generation) !== null
    );
  }

  #requireCurrentDesktopProfile(profileId: ProfileId, generation: number): ProfileRecord {
    const row = this.#database
      .query(
        "SELECT * FROM profiles WHERE id=? AND process_generation=? AND state!='removed'",
      )
      .get(profileId, generation);
    if (row === null) throw new Error("DESKTOP_PROFILE_GENERATION_STALE");
    return mapProfile(row);
  }

  #readSessionEventStream(sessionId: SessionId): z.infer<typeof sessionEventStreamRowSchema> {
    const row = this.#database.query(
      `SELECT stream_epoch,floor_sequence,observed_through_sequence,
              retained_count,retained_bytes,retention_gap_reason
       FROM session_event_streams WHERE session_id=?`,
    ).get(sessionId);
    if (row === null) throw new Error("SESSION_EVENT_STREAM_MISSING");
    return sessionEventStreamRowSchema.parse(row);
  }

  #deleteSessionEventPrefix(
    sessionId: SessionId,
    throughSequence: number,
    reason: Extract<SessionEventGapReason, "retention_count" | "retention_age" | "retention_bytes">,
    now: number,
  ): void {
    const deleted = this.#database.query(
      "DELETE FROM session_events WHERE session_id=? AND sequence<=?",
    ).run(sessionId, throughSequence);
    if (deleted.changes === 0) return;
    const boundary = z.object({
      floor_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(this.#database.query(
      `SELECT COALESCE(
         (SELECT MIN(sequence) FROM session_events WHERE session_id=?),
         (SELECT next_sequence FROM session_event_streams WHERE session_id=?)
       ) AS floor_sequence`,
    ).get(sessionId, sessionId));
    const updated = this.#database.query(
      `UPDATE session_event_streams
       SET floor_sequence=?,retention_gap_reason=?,updated_at=MAX(updated_at,?)
       WHERE session_id=? AND floor_sequence<=?`,
    ).run(boundary.floor_sequence, reason, now, sessionId, boundary.floor_sequence);
    if (updated.changes !== 1) throw new Error("SESSION_EVENT_RETENTION_AUTHORITY_CHANGED");
  }

  #applySessionEventRetention(sessionId: SessionId, now: number): void {
    let stream = this.#readSessionEventStream(sessionId);
    if (stream.retained_count > SESSION_EVENT_RETAIN_COUNT) {
      const firstKept = z.object({
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT sequence FROM session_events
         WHERE session_id=? ORDER BY sequence DESC
         LIMIT 1 OFFSET ?`,
      ).get(sessionId, SESSION_EVENT_RETAIN_COUNT - 1));
      this.#deleteSessionEventPrefix(sessionId, firstKept.sequence - 1, "retention_count", now);
      stream = this.#readSessionEventStream(sessionId);
    }

    const ageCutoff = Math.max(0, now - SESSION_EVENT_RETAIN_AGE_MS);
    const ageBoundary = z.object({
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    }).strict().parse(this.#database.query(
      `SELECT MAX(sequence) AS sequence FROM session_events
       WHERE session_id=? AND recorded_at<?`,
    ).get(sessionId, ageCutoff));
    if (ageBoundary.sequence !== null) {
      this.#deleteSessionEventPrefix(sessionId, ageBoundary.sequence, "retention_age", now);
      stream = this.#readSessionEventStream(sessionId);
    }

    if (stream.retained_bytes > SESSION_EVENT_RETAIN_BYTES) {
      const firstKept = z.object({
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT MIN(sequence) AS sequence FROM (
           SELECT sequence,SUM(event_bytes) OVER (
             ORDER BY sequence DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_bytes
           FROM session_events WHERE session_id=?
         ) WHERE cumulative_bytes<=?`,
      ).get(sessionId, SESSION_EVENT_RETAIN_BYTES));
      this.#deleteSessionEventPrefix(sessionId, firstKept.sequence - 1, "retention_bytes", now);
    }
  }

  eventStreamPosition(sessionId: SessionId): SessionEventStreamPosition {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const read = this.#database.transaction(() => {
      if (this.#database.query("SELECT 1 FROM sessions WHERE id=?").get(parsedSessionId) === null) {
        throw new SelectionError("NOT_FOUND");
      }
      this.#ensureSessionEventStream(parsedSessionId);
      return mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId));
    });
    return this.#readonly ? read() : read.immediate();
  }

  readSessionSnapshotWithEventPosition(sessionId: SessionId): SessionSnapshotWithEventPosition {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const read = this.#database.transaction(() => {
      const sessionRow = this.#database.query("SELECT * FROM sessions WHERE id=?").get(parsedSessionId);
      if (sessionRow === null) throw new SelectionError("NOT_FOUND");
      this.#ensureSessionEventStream(parsedSessionId);
      return {
        session: mapSession(sessionRow),
        ...mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId)),
      };
    });
    return this.#readonly ? read() : read.immediate();
  }

  appendSessionEvent(input: {
    sessionId: SessionId;
    accountId: ProfileId;
    providerGeneration: number;
    providerConnectionId: string | null;
    body: SessionEventBody;
  }): SessionEvent {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const accountId = profileIdSchema.parse(input.accountId);
    const providerGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.providerGeneration);
    const providerConnectionId = z.string().uuid().nullable().parse(input.providerConnectionId);
    const body = sessionEventBodySchema.parse(input.body);
    const recordedAt = unixMillisecondsSchema.parse(this.#now());
    let event: SessionEvent | undefined;
    const append = this.#database.transaction(() => {
      const authority = z.object({
        profile_id: profileIdSchema,
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT s.profile_id,p.process_generation
         FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?`,
      ).get(sessionId));
      if (authority.profile_id !== accountId || authority.process_generation !== providerGeneration) {
        throw new Error("SESSION_EVENT_AUTHORITY_CHANGED");
      }
      this.#ensureSessionEventStream(sessionId);
      const stream = z.object({
        stream_epoch: z.string().uuid(),
        next_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        "SELECT stream_epoch,next_sequence FROM session_event_streams WHERE session_id=?",
      ).get(sessionId));
      if (stream.next_sequence >= Number.MAX_SAFE_INTEGER) throw new Error("SESSION_EVENT_SEQUENCE_EXHAUSTED");
      event = sessionEventSchema.parse({
        version: 1,
        sessionId,
        streamEpoch: stream.stream_epoch,
        sequence: stream.next_sequence,
        recordedAt,
        accountId,
        providerGeneration,
        providerConnectionId,
        body,
      });
      const eventJson = JSON.stringify(event);
      const eventBytes = new TextEncoder().encode(eventJson).byteLength;
      if (eventBytes > SESSION_EVENT_MAX_BYTES) throw new Error("SESSION_EVENT_EXCEEDS_BOUND");
      this.#database.query(
        `INSERT INTO session_events(
           session_id,stream_epoch,sequence,recorded_at,account_id,provider_generation,
           provider_connection_id,event_json,event_bytes
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        sessionId,
        stream.stream_epoch,
        stream.next_sequence,
        recordedAt,
        accountId,
        providerGeneration,
        providerConnectionId,
        eventJson,
        eventBytes,
      );
      const advanced = this.#database.query(
        `UPDATE session_event_streams
         SET next_sequence=?,observed_through_sequence=?,updated_at=MAX(updated_at,?)
         WHERE session_id=? AND stream_epoch=? AND next_sequence=?`,
      ).run(
        stream.next_sequence + 1,
        stream.next_sequence,
        recordedAt,
        sessionId,
        stream.stream_epoch,
        stream.next_sequence,
      );
      if (advanced.changes !== 1) throw new Error("SESSION_EVENT_SEQUENCE_AUTHORITY_CHANGED");
      this.#applySessionEventRetention(sessionId, recordedAt);
    });
    append.immediate();
    if (event === undefined) throw new Error("Session event append lost its durable result.");
    return event;
  }

  maintainSessionEventRetention(sessionId: SessionId, now = this.#now()): SessionEventStreamPosition {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedNow = unixMillisecondsSchema.parse(now);
    const maintain = this.#database.transaction(() => {
      this.#ensureSessionEventStream(parsedSessionId);
      this.#applySessionEventRetention(parsedSessionId, parsedNow);
      return mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId));
    });
    return maintain.immediate();
  }

  listSessionEvents(input: {
    sessionId: SessionId;
    afterSequence: number | null;
    limit?: number;
    now?: number;
  }): SessionEventList {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const afterSequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().parse(input.afterSequence);
    const limit = z.number().int().min(1).max(SESSION_EVENT_PAGE_LIMIT).parse(input.limit ?? SESSION_EVENT_PAGE_LIMIT);
    const maintenanceNow = input.now === undefined ? undefined : unixMillisecondsSchema.parse(input.now);
    const read = this.#database.transaction(() => {
      this.#ensureSessionEventStream(sessionId);
      if (maintenanceNow !== undefined && !this.#readonly) {
        this.#applySessionEventRetention(sessionId, maintenanceNow);
      }
      const stream = this.#readSessionEventStream(sessionId);
      if (afterSequence !== null && afterSequence > stream.observed_through_sequence) {
        throw new Error("SESSION_EVENT_CURSOR_AHEAD");
      }
      const fellBehind = afterSequence !== null && afterSequence < stream.floor_sequence - 1;
      const startSequence = Math.max(afterSequence ?? stream.floor_sequence - 1, stream.floor_sequence - 1);
      const rows = this.#database.query(
        `SELECT event_json,event_bytes FROM session_events
         WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
      ).all(sessionId, startSequence, limit);
      const events: SessionEvent[] = [];
      let pageBytes = 0;
      for (const row of rows) {
        const parsed = z.object({
          event_json: z.string(),
          event_bytes: z.number().int().positive().max(SESSION_EVENT_MAX_BYTES),
        }).strict().parse(row);
        if (events.length > 0 && pageBytes + parsed.event_bytes > SESSION_EVENT_PAGE_BYTES) break;
        const next = sessionEventSchema.parse(JSON.parse(parsed.event_json) as unknown);
        if (next.sessionId !== sessionId || next.streamEpoch !== stream.stream_epoch) {
          throw new Error("SESSION_EVENT_STORED_AUTHORITY_MISMATCH");
        }
        events.push(next);
        pageBytes += parsed.event_bytes;
      }
      return {
        ...mapSessionEventStreamPosition(stream),
        gapReason: fellBehind ? stream.retention_gap_reason ?? "stream_restored" : null,
        events,
      };
    });
    return maintenanceNow !== undefined && !this.#readonly ? read.immediate() : read();
  }

  #requireInteractionRow(publicId: string): z.infer<typeof interactionRowSchema> {
    const row = this.#database.query("SELECT * FROM provider_interactions WHERE public_id=?").get(publicId);
    if (row === null) throw new SelectionError("NOT_FOUND");
    return interactionRowSchema.parse(row);
  }

  #recordInteractionTransition(row: z.infer<typeof interactionRowSchema>, now: number): void {
    this.#database.query(
      `INSERT INTO provider_interaction_transitions(
         public_id,revision,state,response_digest,recorded_at
       ) VALUES (?,?,?,?,?)`,
    ).run(row.public_id, row.revision, row.state, row.response_digest, now);
  }

  admitInteraction(input: {
    publicId: string;
    sessionId: SessionId | null;
    authority: ProviderInteractionAuthority;
    kind: InteractionKind;
    blocking: boolean;
    display: InteractionDisplay;
    timeoutMs?: number;
    requestedAt?: number;
    deadlineAt?: number;
  }): { record: InteractionRecord; replayed: boolean } {
    const publicId = z.string().uuid().parse(input.publicId);
    const sessionId = sessionIdSchema.nullable().parse(input.sessionId);
    const authority = providerInteractionAuthoritySchema.parse(input.authority);
    const kind = interactionKindSchema.parse(input.kind);
    const blocking = z.boolean().parse(input.blocking);
    const display = interactionDisplaySchema.parse(input.display);
    const timeoutMs = z.number().int().min(0).max(INTERACTION_MAX_PENDING_MS)
      .parse(input.timeoutMs ?? INTERACTION_MAX_PENDING_MS);
    if (display.kind !== kind) throw new Error("INTERACTION_DISPLAY_KIND_MISMATCH");
    const displayJson = JSON.stringify(display);
    if (new TextEncoder().encode(displayJson).byteLength > 65_536) {
      throw new Error("INTERACTION_DISPLAY_EXCEEDS_BOUND");
    }
    const now = unixMillisecondsSchema.parse(this.#now());
    const requestedAt = unixMillisecondsSchema.parse(input.requestedAt ?? now);
    const deadlineAt = unixMillisecondsSchema.parse(input.deadlineAt
      ?? Math.min(Number.MAX_SAFE_INTEGER, requestedAt + timeoutMs));
    if (requestedAt > now || deadlineAt < requestedAt) {
      throw new Error("INTERACTION_DEADLINE_AUTHORITY_INVALID");
    }
    let result: { record: InteractionRecord; replayed: boolean } | undefined;
    const admit = this.#database.transaction(() => {
      const profile = z.object({
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: profileStateSchema,
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state FROM profiles WHERE id=?",
      ).get(authority.profileId));
      if (profile.process_generation !== authority.processGeneration || profile.state === "removed") {
        throw new Error("INTERACTION_AUTHORITY_CHANGED");
      }
      if (sessionId !== null) {
        const owner = z.object({ profile_id: profileIdSchema }).strict().parse(
          this.#database.query("SELECT profile_id FROM sessions WHERE id=?").get(sessionId),
        );
        if (owner.profile_id !== authority.profileId) throw new Error("INTERACTION_SESSION_AUTHORITY_MISMATCH");
      }
      const existingByRequest = authority.requestId.type === "number"
        ? this.#database.query(
          `SELECT * FROM provider_interactions
           WHERE profile_id=? AND process_generation=? AND connection_id=?
             AND request_id_type='number' AND request_id_number=?`,
        ).get(authority.profileId, authority.processGeneration, authority.connectionId, authority.requestId.value)
        : this.#database.query(
          `SELECT * FROM provider_interactions
           WHERE profile_id=? AND process_generation=? AND connection_id=?
             AND request_id_type='string' AND request_id_text=?`,
        ).get(authority.profileId, authority.processGeneration, authority.connectionId, authority.requestId.value);
      if (existingByRequest !== null) {
        const existing = mapInteraction(existingByRequest);
        if (
          existing.sessionId !== sessionId
          || JSON.stringify(existing.authority) !== JSON.stringify(authority)
          || existing.kind !== kind
          || existing.blocking !== blocking
          || (input.requestedAt !== undefined && existing.requestedAt !== requestedAt)
          || (input.deadlineAt !== undefined && existing.deadlineAt !== deadlineAt)
        ) throw new Error("INTERACTION_REQUEST_REPLAY_CONFLICT");
        result = { record: existing, replayed: true };
        return;
      }
      if (this.#database.query("SELECT 1 FROM provider_interactions WHERE public_id=?").get(publicId) !== null) {
        throw new Error("INTERACTION_PUBLIC_ID_CONFLICT");
      }
      this.#database.query(
        `INSERT INTO provider_interactions(
           public_id,session_id,profile_id,process_generation,connection_id,
           request_id_type,request_id_number,request_id_text,method,request_digest,
           thread_id,turn_id,item_id,approval_id,kind,state,revision,blocking,
           display_json,response_digest,response_expected_revision,intended_terminal_state,
           requested_at,deadline_at,updated_at,terminal_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,?,NULL,NULL,NULL,?,?,?,NULL)`,
      ).run(
        publicId,
        sessionId,
        authority.profileId,
        authority.processGeneration,
        authority.connectionId,
        authority.requestId.type,
        authority.requestId.type === "number" ? authority.requestId.value : null,
        authority.requestId.type === "string" ? authority.requestId.value : null,
        authority.method,
        authority.requestDigest,
        authority.threadId,
        authority.turnId,
        authority.itemId,
        authority.approvalId,
        kind,
        blocking ? 1 : 0,
        displayJson,
        requestedAt,
        deadlineAt,
        now,
      );
      const inserted = this.#requireInteractionRow(publicId);
      this.#recordInteractionTransition(inserted, now);
      result = { record: mapInteraction(inserted), replayed: false };
    });
    admit.immediate();
    if (result === undefined) throw new Error("Interaction admission lost its durable result.");
    return result;
  }

  requireInteraction(publicId: string): InteractionRecord {
    return mapInteraction(this.#requireInteractionRow(z.string().uuid().parse(publicId)));
  }

  findInteractionByAuthority(authorityInput: ProviderInteractionAuthority): InteractionRecord | null {
    const authority = providerInteractionAuthoritySchema.parse(authorityInput);
    const row = authority.requestId.type === "number"
      ? this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=? AND connection_id=?
           AND request_id_type='number' AND request_id_number=?`,
      ).get(
        authority.profileId,
        authority.processGeneration,
        authority.connectionId,
        authority.requestId.value,
      )
      : this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=? AND connection_id=?
           AND request_id_type='string' AND request_id_text=?`,
      ).get(
        authority.profileId,
        authority.processGeneration,
        authority.connectionId,
        authority.requestId.value,
      );
    if (row === null) return null;
    const interaction = mapInteraction(row);
    if (JSON.stringify(interaction.authority) !== JSON.stringify(authority)) {
      throw new Error("INTERACTION_AUTHORITY_MISMATCH");
    }
    return interaction;
  }

  listInteractions(input: {
    sessionId?: SessionId;
    pendingOnly?: boolean;
    limit?: number;
  } = {}): readonly InteractionRecord[] {
    const sessionId = input.sessionId === undefined ? undefined : sessionIdSchema.parse(input.sessionId);
    const pendingOnly = input.pendingOnly ?? false;
    const limit = z.number().int().min(1).max(200).parse(input.limit ?? 100);
    const predicates = [
      ...(sessionId === undefined ? [] : ["session_id=?"]),
      ...(pendingOnly ? ["state IN ('pending','response_prepared','response_written')"] : []),
    ];
    const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
    const parameters: Array<string | number> = [
      ...(sessionId === undefined ? [] : [sessionId]),
      limit,
    ];
    return this.#database.query(
      `SELECT * FROM provider_interactions${where} ORDER BY requested_at DESC,public_id LIMIT ?`,
    ).all(...parameters).map(mapInteraction);
  }

  listDueInteractions(input: { now?: number; limit?: number } = {}): readonly InteractionRecord[] {
    const now = unixMillisecondsSchema.parse(input.now ?? this.#now());
    const limit = z.number().int().min(1).max(128).parse(input.limit ?? 32);
    return this.#database.query(
      `SELECT * FROM provider_interactions
       WHERE state='pending' AND deadline_at<=?
       ORDER BY deadline_at,public_id LIMIT ?`,
    ).all(now, limit).map(mapInteraction);
  }

  nextInteractionDeadlineAt(): number | null {
    const row = z.object({ deadline_at: unixMillisecondsSchema }).strict().nullable().parse(
      this.#database.query(
        `SELECT deadline_at FROM provider_interactions
         WHERE state='pending' ORDER BY deadline_at,public_id LIMIT 1`,
      ).get(),
    );
    return row?.deadline_at ?? null;
  }

  prepareInteractionResponse(input: {
    id: string;
    expectedRevision: number;
    responseDigest: string;
    intendedTerminalState?: InteractionIntendedTerminalState;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const responseDigest = sha256Schema.parse(input.responseDigest);
    const intendedTerminalState = interactionIntendedTerminalStateSchema
      .parse(input.intendedTerminalState ?? "resolved");
    const now = unixMillisecondsSchema.parse(this.#now());
    const prepare = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      const currentGeneration = z.object({
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: profileStateSchema,
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state FROM profiles WHERE id=?",
      ).get(current.profile_id));
      if (
        currentGeneration.process_generation !== current.process_generation
        || currentGeneration.state === "removed"
      ) throw new Error("INTERACTION_AUTHORITY_CHANGED");
      if (current.state !== "pending") {
        if (
          current.response_expected_revision === expectedRevision
          && current.response_digest === responseDigest
          && current.intended_terminal_state === intendedTerminalState
        ) return mapInteraction(current);
        if (current.response_expected_revision === expectedRevision) {
          throw new Error("INTERACTION_RESPONSE_CONFLICT");
        }
        throw new Error("INTERACTION_REVISION_CONFLICT");
      }
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state='response_prepared',revision=revision+1,response_digest=?,
             response_expected_revision=?,intended_terminal_state=?,updated_at=MAX(updated_at,?)
         WHERE public_id=? AND revision=? AND state='pending' AND response_digest IS NULL`,
      ).run(responseDigest, expectedRevision, intendedTerminalState, now, id, expectedRevision);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const prepared = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(prepared, now);
      return mapInteraction(prepared);
    });
    return prepare.immediate();
  }

  markInteractionResponseWritten(input: {
    id: string;
    expectedRevision: number;
    responseDigest: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const responseDigest = sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const mark = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      if (current.response_digest !== responseDigest) throw new Error("INTERACTION_RESPONSE_CONFLICT");
      if (
        current.state === "response_written"
        && current.revision === expectedRevision + 1
      ) return mapInteraction(current);
      if (current.state !== "response_prepared" || current.revision !== expectedRevision) {
        if (
          current.terminal_at !== null
          && current.response_expected_revision !== null
          && expectedRevision === current.response_expected_revision + 1
        ) return mapInteraction(current);
        throw new Error("INTERACTION_REVISION_CONFLICT");
      }
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state='response_written',revision=revision+1,updated_at=MAX(updated_at,?)
         WHERE public_id=? AND revision=? AND state='response_prepared' AND response_digest=?`,
      ).run(now, id, expectedRevision, responseDigest);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const written = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(written, now);
      return mapInteraction(written);
    });
    return mark.immediate();
  }

  settleInteraction(input: {
    id: string;
    expectedRevision: number;
    state: InteractionIntendedTerminalState;
    authority: ProviderInteractionAuthority;
    responseDigest?: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const state = interactionIntendedTerminalStateSchema.parse(input.state);
    const authority = providerInteractionAuthoritySchema.parse(input.authority);
    const responseDigest = input.responseDigest === undefined ? undefined : sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const settle = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      const stored = mapInteraction(current);
      if (JSON.stringify(stored.authority) !== JSON.stringify(authority)) {
        throw new Error("INTERACTION_AUTHORITY_MISMATCH");
      }
      const generation = z.object({
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: profileStateSchema,
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state FROM profiles WHERE id=?",
      ).get(current.profile_id));
      if (generation.process_generation !== current.process_generation || generation.state === "removed") {
        throw new Error("INTERACTION_AUTHORITY_CHANGED");
      }
      if (responseDigest !== undefined && current.response_digest !== responseDigest) {
        throw new Error("INTERACTION_RESPONSE_CONFLICT");
      }
      if (
        current.intended_terminal_state !== null
        && current.intended_terminal_state !== state
      ) throw new Error("INTERACTION_TERMINAL_INTENT_CONFLICT");
      if (current.state === state && current.revision === expectedRevision + 1) return mapInteraction(current);
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      if (!["pending", "response_prepared", "response_written"].includes(current.state)) {
        throw new Error("INTERACTION_STATE_CONFLICT");
      }
      if (state === "declined" && current.response_digest === null) {
        throw new Error("INTERACTION_RESPONSE_NOT_PREPARED");
      }
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
         WHERE public_id=? AND revision=? AND state IN ('pending','response_prepared','response_written')`,
      ).run(state, now, now, id, expectedRevision);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const terminal = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(terminal, now);
      return mapInteraction(terminal);
    });
    return settle.immediate();
  }

  expireInteraction(input: { id: string; expectedRevision: number }): InteractionRecord {
    return this.#terminalizeInteraction({ ...input, state: "expired" });
  }

  markInteractionResolutionUnknown(input: {
    id: string;
    expectedRevision: number;
    responseDigest?: string;
  }): InteractionRecord {
    return this.#terminalizeInteraction({ ...input, state: "resolution_unknown" });
  }

  #terminalizeInteraction(input: {
    id: string;
    expectedRevision: number;
    state: "expired" | "resolution_unknown";
    responseDigest?: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const responseDigest = input.responseDigest === undefined ? undefined : sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      if (responseDigest !== undefined && current.response_digest !== responseDigest) {
        throw new Error("INTERACTION_RESPONSE_CONFLICT");
      }
      if (current.state === input.state && current.revision === expectedRevision + 1) return mapInteraction(current);
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      if (!["pending", "response_prepared", "response_written"].includes(current.state)) {
        throw new Error("INTERACTION_STATE_CONFLICT");
      }
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
         WHERE public_id=? AND revision=? AND state IN ('pending','response_prepared','response_written')`,
      ).run(input.state, now, now, id, expectedRevision);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const terminal = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(terminal, now);
      return mapInteraction(terminal);
    });
    return terminalize.immediate();
  }

  markGenerationInteractionsUnknown(input: {
    profileId: ProfileId;
    processGeneration: number;
    connectionId?: string;
  }): readonly InteractionRecord[] {
    return this.#terminalizeGenerationInteractions(input, true);
  }

  expireGenerationInteractions(input: {
    profileId: ProfileId;
    processGeneration: number;
    connectionId?: string;
  }): readonly InteractionRecord[] {
    return this.#terminalizeGenerationInteractions(input, false);
  }

  expireTurnInteractions(input: {
    sessionId: SessionId;
    profileId: ProfileId;
    processGeneration: number;
    turnId: string;
  }): readonly InteractionRecord[] {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.processGeneration);
    const turnId = z.string().min(1).max(512).parse(input.turnId);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const rows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE session_id=? AND profile_id=? AND process_generation=? AND turn_id=?
           AND state IN ('pending','response_prepared','response_written')
         ORDER BY requested_at,public_id`,
      ).all(sessionId, profileId, processGeneration, turnId);
      const records: InteractionRecord[] = [];
      for (const value of rows) {
        const current = interactionRowSchema.parse(value);
        const state = current.state === "pending" ? "expired" : "resolution_unknown";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, current.public_id, current.revision, current.state);
        if (changed.changes !== 1) throw new Error("INTERACTION_TURN_RECOVERY_CONFLICT");
        const terminal = this.#requireInteractionRow(current.public_id);
        this.#recordInteractionTransition(terminal, now);
        records.push(mapInteraction(terminal));
      }
      return records;
    });
    return terminalize.immediate();
  }

  #terminalizeGenerationInteractions(
    input: { profileId: ProfileId; processGeneration: number; connectionId?: string },
    allUnknown: boolean,
  ): readonly InteractionRecord[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.processGeneration);
    const connectionId = input.connectionId === undefined ? undefined : z.string().uuid().parse(input.connectionId);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const rows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=?
           ${connectionId === undefined ? "" : "AND connection_id=?"}
           AND state IN ('pending','response_prepared','response_written')
         ORDER BY requested_at,public_id`,
      ).all(...(connectionId === undefined
        ? [profileId, processGeneration]
        : [profileId, processGeneration, connectionId]));
      const records: InteractionRecord[] = [];
      for (const value of rows) {
        const current = interactionRowSchema.parse(value);
        const state = allUnknown || current.state !== "pending" ? "resolution_unknown" : "expired";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, current.public_id, current.revision, current.state);
        if (changed.changes !== 1) throw new Error("INTERACTION_GENERATION_RECOVERY_CONFLICT");
        const terminal = this.#requireInteractionRow(current.public_id);
        this.#recordInteractionTransition(terminal, now);
        records.push(mapInteraction(terminal));
      }
      return records;
    });
    return terminalize.immediate();
  }

  recordUsage(profileId: ProfileId, sourceRevision: number, observedAt: number, payload: unknown): void {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(sourceRevision);
    const parsedObservedAt = unixMillisecondsSchema.parse(observedAt);
    const json = JSON.stringify(payload);
    if (new TextEncoder().encode(json).byteLength > USAGE_LOCAL_SNAPSHOT_MAX_BYTES) {
      throw new Error("Usage snapshot exceeds the local bound.");
    }
    const digest = createHash("sha256").update(json).digest("hex");
    const record = this.#database.transaction(() => {
      const existing = this.#database.query("SELECT digest FROM usage_snapshots WHERE profile_id=? AND source_revision=?").get(parsedProfileId, parsedRevision) as { digest: string } | null;
      if (existing !== null && existing.digest !== digest) throw new Error("Usage source revision conflict.");
      const failed = this.#database.query(
        "SELECT 1 FROM usage_poll_failures WHERE profile_id=? AND source_revision=?",
      ).get(parsedProfileId, parsedRevision);
      if (failed !== null) throw new Error("Usage source revision is already a failed observation.");
      this.#database.query("INSERT OR IGNORE INTO usage_snapshots(profile_id,source_revision,observed_at,payload_json,digest) VALUES (?,?,?,?,?)").run(parsedProfileId, parsedRevision, parsedObservedAt, json, digest);
      this.#database.query(
        `INSERT INTO usage_revision_authority(profile_id,next_revision) VALUES (?,?)
         ON CONFLICT(profile_id) DO UPDATE SET next_revision=MAX(next_revision,excluded.next_revision)`,
      ).run(parsedProfileId, Math.min(Number.MAX_SAFE_INTEGER, parsedRevision + 1));
      recordUsageCloudUploadAnchor(
        this.#database,
        parsedProfileId,
        parsedRevision,
        usageSnapshotReceivedAt({
          observedAt: parsedObservedAt,
          payload,
          sourceRevision: parsedRevision,
        }),
      );
      pruneProfileUsageHistory(this.#database, parsedProfileId, this.#now());
    });
    record.immediate();
  }

  recordUsagePollFailure(
    profileId: ProfileId,
    sourceRevision: number,
    observedAt: number,
    reasonCode: UsagePollFailureRecord["reasonCode"] = "account_usage_read_failed",
  ): void {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(sourceRevision);
    const parsedObservedAt = unixMillisecondsSchema.parse(observedAt);
    const parsedReason = z.literal("account_usage_read_failed").parse(reasonCode);
    const record = this.#database.transaction(() => {
      const observed = this.#database.query(
        "SELECT 1 FROM usage_snapshots WHERE profile_id=? AND source_revision=?",
      ).get(parsedProfileId, parsedRevision);
      if (observed !== null) throw new Error("Usage source revision is already a successful observation.");
      const existing = this.#database.query(
        `SELECT observed_at,reason_code FROM usage_poll_failures
         WHERE profile_id=? AND source_revision=?`,
      ).get(parsedProfileId, parsedRevision) as { observed_at: number; reason_code: string } | null;
      if (
        existing !== null
        && (existing.observed_at !== parsedObservedAt || existing.reason_code !== parsedReason)
      ) throw new Error("Usage failure source revision conflict.");
      this.#database.query(
        `INSERT OR IGNORE INTO usage_poll_failures(
           profile_id,source_revision,observed_at,reason_code
         ) VALUES (?,?,?,?)`,
      ).run(parsedProfileId, parsedRevision, parsedObservedAt, parsedReason);
      this.#database.query(
        `INSERT INTO usage_revision_authority(profile_id,next_revision) VALUES (?,?)
         ON CONFLICT(profile_id) DO UPDATE SET next_revision=MAX(next_revision,excluded.next_revision)`,
      ).run(parsedProfileId, Math.min(Number.MAX_SAFE_INTEGER, parsedRevision + 1));
      pruneProfileUsageHistory(this.#database, parsedProfileId, this.#now());
    });
    record.immediate();
  }

  allocateNextUsageRevision(profileId: ProfileId): number {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const allocate = this.#database.transaction(() => {
      const exists = this.#database.query("SELECT 1 FROM profiles WHERE id=?").get(parsedProfileId);
      if (exists === null) throw new SelectionError("NOT_FOUND");
      this.#database.query(
        `INSERT OR IGNORE INTO usage_revision_authority(profile_id,next_revision)
         SELECT ?,CASE
           WHEN MAX(source_revision) IS NULL THEN 1
           WHEN MAX(source_revision)>=9007199254740991 THEN 9007199254740991
           ELSE MAX(source_revision)+1
         END FROM (
           SELECT source_revision FROM usage_snapshots WHERE profile_id=?
           UNION ALL
           SELECT source_revision FROM usage_poll_failures WHERE profile_id=?
         )`,
      ).run(parsedProfileId, parsedProfileId, parsedProfileId);
      const current = z.object({
        next_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        "SELECT next_revision FROM usage_revision_authority WHERE profile_id=?",
      ).get(parsedProfileId));
      if (current.next_revision >= Number.MAX_SAFE_INTEGER) throw new Error("USAGE_REVISION_EXHAUSTED");
      const advanced = this.#database.query(
        `UPDATE usage_revision_authority SET next_revision=?
         WHERE profile_id=? AND next_revision=?`,
      ).run(current.next_revision + 1, parsedProfileId, current.next_revision);
      if (advanced.changes !== 1) throw new Error("USAGE_REVISION_AUTHORITY_CHANGED");
      return current.next_revision;
    });
    return allocate.immediate();
  }

  usageRange(input: {
    profileId: ProfileId;
    fromObservedAt?: number;
    throughObservedAt?: number;
    limit?: number;
  }): readonly UsageSnapshotRecord[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const fromObservedAt = input.fromObservedAt === undefined ? undefined : unixMillisecondsSchema.parse(input.fromObservedAt);
    const throughObservedAt = input.throughObservedAt === undefined ? undefined : unixMillisecondsSchema.parse(input.throughObservedAt);
    if (fromObservedAt !== undefined && throughObservedAt !== undefined && fromObservedAt > throughObservedAt) {
      throw new Error("USAGE_RANGE_INVALID");
    }
    const limit = z.number().int().min(1).max(10_000).parse(input.limit ?? 1_000);
    const predicates = ["profile_id=?"];
    const parameters: Array<string | number> = [profileId];
    if (fromObservedAt !== undefined) {
      predicates.push("observed_at>=?");
      parameters.push(fromObservedAt);
    }
    if (throughObservedAt !== undefined) {
      predicates.push("observed_at<=?");
      parameters.push(throughObservedAt);
    }
    parameters.push(limit);
    const rows = this.#database.query(
      `SELECT source_revision,observed_at,payload_json FROM usage_snapshots
       WHERE ${predicates.join(" AND ")}
       ORDER BY observed_at,source_revision LIMIT ?`,
    ).all(...parameters);
    return rows.map((row) => {
      const parsed = z.object({
        source_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        payload_json: z.string(),
      }).strict().parse(row);
      return {
        sourceRevision: parsed.source_revision,
        observedAt: parsed.observed_at,
        payload: JSON.parse(parsed.payload_json) as unknown,
      };
    });
  }

  usageAfterRevision(input: {
    profileId: ProfileId;
    afterSourceRevision: number;
    limit: number;
  }): readonly UsageSnapshotRecord[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const afterSourceRevision = z.number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(input.afterSourceRevision);
    const limit = z.number().int().min(1).max(10_000).parse(input.limit);
    const rows = this.#database.query(
      `SELECT u.source_revision,u.observed_at,u.payload_json
       FROM usage_cloud_upload_anchors a
       JOIN usage_snapshots u
         ON u.profile_id=a.profile_id AND u.source_revision=a.source_revision
       WHERE a.profile_id=? AND a.source_revision>?
       ORDER BY a.source_revision LIMIT ?`,
    ).all(profileId, afterSourceRevision, limit);
    const mapRow = (row: unknown): UsageSnapshotRecord => {
      const parsed = z.object({
        source_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        payload_json: z.string(),
      }).strict().parse(row);
      return {
        sourceRevision: parsed.source_revision,
        observedAt: parsed.observed_at,
        payload: JSON.parse(parsed.payload_json) as unknown,
      };
    };
    return rows.map(mapRow);
  }

  latestUsage(profileId: ProfileId): UsageSnapshotRecord | null {
    const row = this.#database.query("SELECT source_revision,observed_at,payload_json FROM usage_snapshots WHERE profile_id=? ORDER BY observed_at DESC,source_revision DESC LIMIT 1").get(profileId) as { source_revision: number; observed_at: number; payload_json: string } | null;
    return row === null ? null : { sourceRevision: row.source_revision, observedAt: row.observed_at, payload: JSON.parse(row.payload_json) as unknown };
  }

  latestUsagePollFailure(profileId: ProfileId): UsagePollFailureRecord | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const row = this.#database.query(
      `SELECT source_revision,observed_at,reason_code FROM usage_poll_failures
       WHERE profile_id=? ORDER BY observed_at DESC,source_revision DESC LIMIT 1`,
    ).get(parsedProfileId) as {
      source_revision: number;
      observed_at: number;
      reason_code: UsagePollFailureRecord["reasonCode"];
    } | null;
    return row === null ? null : {
      observedAt: row.observed_at,
      reasonCode: row.reason_code,
      sourceRevision: row.source_revision,
    };
  }

  nextDaemonGeneration(bootId: string): number {
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      const current = this.#database.query("SELECT generation FROM daemon_state WHERE singleton=1").get() as { generation: number };
      const interactions = this.#database.query(
        `SELECT i.* FROM provider_interactions i
         JOIN profiles p ON p.id=i.profile_id AND p.process_generation=i.process_generation
         WHERE i.state IN ('pending','response_prepared','response_written')
         ORDER BY i.requested_at,i.public_id`,
      ).all();
      for (const value of interactions) {
        const interaction = interactionRowSchema.parse(value);
        const state = interaction.state === "pending" ? "expired" : "resolution_unknown";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, interaction.public_id, interaction.revision, interaction.state);
        if (changed.changes !== 1) throw new Error("INTERACTION_DAEMON_RESTART_CONFLICT");
        this.#recordInteractionTransition(this.#requireInteractionRow(interaction.public_id), now);
      }
      const invalidLoginAuthority = this.#database.query(`SELECT a.attempt_id
                                                          FROM provider_login_authorities a
                                                          LEFT JOIN profiles p ON p.id=a.profile_id
                                                          WHERE a.state='active'
                                                            AND (p.id IS NULL OR p.state!='login_pending' OR p.process_generation!=a.process_generation)
                                                          LIMIT 1`).get();
      if (invalidLoginAuthority !== null) {
        throw new Error("LOGIN_RESTART_AUTHORITY_MISMATCH");
      }
      this.#database.query(`UPDATE provider_login_authorities
                            SET process_generation=process_generation+1,updated_at=MAX(updated_at,?)
                            WHERE state='active'`).run(now);
      this.#database.query(
        `UPDATE profiles
         SET process_generation=process_generation+1,updated_at=MAX(updated_at,?)
         WHERE state!='removed' AND process_generation>0`,
      ).run(now);
      this.#database.query("UPDATE daemon_state SET generation=?,boot_id=?,started_at=?,stopped_at=NULL WHERE singleton=1 AND generation=?").run(current.generation + 1, bootId, now, current.generation);
      return current.generation + 1;
    });
    const generation = transaction.immediate();
    this.#recordDaemonRestartGaps();
    return generation;
  }

  #recordDaemonRestartGaps(): void {
    const sessions = this.#database.query(
      `SELECT s.id,p.id AS profile_id,p.process_generation
       FROM sessions s JOIN profiles p ON p.id=s.profile_id
       WHERE s.provider_thread_id IS NOT NULL AND s.state!='terminal'
       ORDER BY s.id`,
    ).all().map((row) => z.object({
      id: sessionIdSchema,
      profile_id: profileIdSchema,
      process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(row));
    for (const session of sessions) {
      const position = this.eventStreamPosition(session.id);
      this.appendSessionEvent({
        sessionId: session.id,
        accountId: session.profile_id,
        providerGeneration: session.process_generation,
        providerConnectionId: null,
        body: {
          type: "gap",
          reason: "provider_restart",
          fromSequence: position.observedThroughSequence + 1,
          throughSequence: position.observedThroughSequence + 1,
        },
      });
    }
  }

  markDaemonStopped(generation: number, bootId: string): boolean {
    const result = this.#database.query("UPDATE daemon_state SET stopped_at=? WHERE singleton=1 AND generation=? AND boot_id=?").run(this.#now(), generation, bootId);
    return result.changes === 1;
  }
}
