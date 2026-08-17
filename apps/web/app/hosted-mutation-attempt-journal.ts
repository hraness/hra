import {
  createAttemptId,
  createMutationFingerprint,
  type DispatchOutcome,
  type MutationAttemptDefinition,
  type MutationAttemptCursor,
  type MutationAttemptDraft,
  type MutationAttemptJournal,
  type MutationAttemptRecord,
  type OpenMutationAttempt,
  type PrepareMutationAttemptResult,
  type TransitionMutationAttemptResult,
} from "@hra-internal/codex-app-sdk";
import {
  operationIdSchema,
  taskPublicIdSchema,
  taskWorkspaceClientIntentSchema,
  taskWorkspaceClientMutationIntentKindValues,
  taskWorkspaceMutationSemanticKey,
  taskWorkspaceMutationResultSchema,
  workspacePublicIdSchema,
  type TaskWorkspaceClientIntent,
} from "@hraness/agent-tasks-domain";
import { uuidV7Schema } from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import type { ConvexReactClient } from "convex/react";

import { api } from "../convex/_generated/api";

// This source ID participates in persisted fingerprints and receipt replay.
// Preserve its pre-cutover bytes while exposing it through the HRA API.
export const HOSTED_TASK_MUTATION_SOURCE_ID =
  "oprte.web.task-workspace.v1";
const CONVEX_ATTEMPT_PAGE_LIMIT = 50;
const MAX_JOURNAL_PAGE_LIMIT = 1_000;
const MAX_RESOLVED_FINGERPRINTS = 512;

const operationSchema = z.enum(taskWorkspaceClientMutationIntentKindValues);
const commandKindSchema =
  taskWorkspaceMutationResultSchema.shape.commandKind;
const sourceIdSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/u);
const clientFingerprintSchema = z.string()
  .regex(/^sha256_[A-Za-z0-9_-]{43}$/u);
const opaqueFingerprintSchema = z.string()
  .regex(/^hmac_sha256_[A-Za-z0-9_-]{43}$/u);
const fingerprintKeyVersionSchema = z.string().min(1).max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const recoverySchema = z.object({
  idempotencyKey: uuidV7Schema,
  hraOperationId: operationIdSchema,
  suppliedTaskId: taskPublicIdSchema,
  targetTaskId: taskPublicIdSchema.optional(),
}).strict();

const baseRecordSchema = z.object({
  attemptId: operationIdSchema,
  fingerprint: opaqueFingerprintSchema,
  fingerprintKeyVersion: fingerprintKeyVersionSchema,
  operation: operationSchema,
  sourceId: sourceIdSchema,
  preparedAtMs: z.number().int().nonnegative().safe(),
  workspaceId: workspacePublicIdSchema,
  recovery: recoverySchema,
}).strict();

const confirmedOutcomeSchema = z.object({
  status: z.literal("confirmed"),
  attemptId: operationIdSchema,
  value: z.object({
    kind: z.literal("committed"),
    commandKind: commandKindSchema,
  }).strict(),
}).strict();

const rejectedOutcomeSchema = z.object({
  status: z.literal("rejected"),
  attemptId: operationIdSchema,
  error: z.object({
    code: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u),
    message: z.string().min(1).max(256),
    retryable: z.boolean(),
  }).strict(),
}).strict();

const cancelledOutcomeSchema = z.object({
  status: z.literal("cancelled"),
  attemptId: operationIdSchema,
  reason: z.enum(["caller", "client-closing", "superseded"]),
}).strict();

const preparedRecordSchema = baseRecordSchema.extend({
  state: z.literal("prepared"),
  revision: z.number().int().positive().safe(),
}).strict();

const effectStartedRecordSchema = baseRecordSchema.extend({
  state: z.literal("effect-started"),
  revision: z.number().int().positive().safe(),
  effectStartedAtMs: z.number().int().nonnegative().safe(),
}).strict();

const settledRecordSchema = baseRecordSchema.extend({
  state: z.literal("settled"),
  revision: z.number().int().positive().safe(),
  effectStartedAtMs: z.number().int().nonnegative().safe().nullable(),
  settledAtMs: z.number().int().nonnegative().safe(),
  outcome: z.union([
    confirmedOutcomeSchema,
    rejectedOutcomeSchema,
    cancelledOutcomeSchema,
  ]),
}).strict();

const recordSchema = z.discriminatedUnion("state", [
  preparedRecordSchema,
  effectStartedRecordSchema,
  settledRecordSchema,
]);

const openRecordSchema = z.discriminatedUnion("state", [
  preparedRecordSchema,
  effectStartedRecordSchema,
]);

const domainFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string(),
    requestId: z.string().min(1).max(128),
    details: z.unknown(),
  }).strict(),
}).strict();

const prepareResponseSchema = z.union([
  domainFailureSchema,
  z.object({
    ok: z.literal(true),
    data: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("created"),
        record: preparedRecordSchema,
      }).strict(),
      z.object({
        status: z.literal("existing"),
        record: recordSchema,
      }).strict(),
      z.object({
        status: z.literal("collision"),
        current: recordSchema,
      }).strict(),
      z.object({ status: z.literal("capacity") }).strict(),
    ]),
    requestId: z.string().min(1).max(128),
  }).strict(),
]);

const transitionResponseSchema = z.union([
  domainFailureSchema,
  z.object({
    ok: z.literal(true),
    data: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("applied"),
        record: recordSchema,
      }).strict(),
      z.object({
        status: z.literal("conflict"),
        current: recordSchema,
      }).strict(),
      z.object({ status: z.literal("missing") }).strict(),
      z.object({
        status: z.literal("invalid-transition"),
        current: recordSchema,
      }).strict(),
    ]),
    requestId: z.string().min(1).max(128),
  }).strict(),
]);

const getResponseSchema = z.union([
  domainFailureSchema,
  z.object({
    ok: z.literal(true),
    data: recordSchema.nullable(),
    requestId: z.string().min(1).max(128),
  }).strict(),
]);

const resolveFingerprintResponseSchema = z.union([
  domainFailureSchema,
  z.object({
    ok: z.literal(true),
    data: z.object({
      fingerprint: opaqueFingerprintSchema,
      fingerprintKeyVersion: fingerprintKeyVersionSchema,
      prepareProof: opaqueFingerprintSchema,
    }).strict(),
    requestId: z.string().min(1).max(128),
  }).strict(),
]);

const cursorSchema = z.object({
  preparedAtMs: z.number().int().nonnegative().safe(),
  attemptId: operationIdSchema,
}).strict();

const listResponseSchema = z.union([
  domainFailureSchema,
  z.object({
    ok: z.literal(true),
    data: z.object({
      attempts: z.array(openRecordSchema).max(CONVEX_ATTEMPT_PAGE_LIMIT),
      nextCursor: cursorSchema.nullable(),
      hasMore: z.boolean(),
    }).strict(),
    requestId: z.string().min(1).max(128),
  }).strict(),
]);

const reconcileResponseSchema = z.union([
  domainFailureSchema,
  z.object({
    ok: z.literal(true),
    data: z.object({
      blocked: z.number().int().nonnegative().safe(),
      hasMore: z.boolean(),
      nextCursor: cursorSchema.nullable(),
      pendingReceipts: z.number().int().nonnegative().safe(),
      reconciled: z.number().int().nonnegative().safe(),
    }).strict(),
    requestId: z.string().min(1).max(128),
  }).strict(),
]);

type MutationIntent = Exclude<
  TaskWorkspaceClientIntent,
  Readonly<{ kind: "page.load_more" | "task.select" | "view.select" }>
>;

export type HostedMutationRecovery = z.infer<typeof recoverySchema>;
export type HostedMutationResolution = Readonly<{
  kind: "committed";
  commandKind: z.infer<typeof commandKindSchema>;
}>;
export type HostedMutationAttemptDefinition = MutationAttemptDefinition<
  MutationIntent["kind"],
  HostedMutationRecovery,
  HostedMutationResolution
>;
export type HostedMutationAttemptRecord = MutationAttemptRecord<
  HostedMutationAttemptDefinition
>;
type HostedMutationFingerprint = MutationAttemptDraft<
  HostedMutationAttemptDefinition
>["fingerprint"];
export type HostedMutationFingerprintResolver = (
  clientFingerprint: HostedMutationFingerprint,
) => Promise<HostedMutationFingerprint>;
export type HostedMutationDrainResult = Readonly<{
  blocked: number;
  pendingReceipts: number;
  reconciled: number;
}>;
export type HostedMutationAttemptJournal = MutationAttemptJournal<
  HostedMutationAttemptDefinition
> & Readonly<{
  drainOpen?: () => Promise<HostedMutationDrainResult>;
  resolveFingerprint: HostedMutationFingerprintResolver;
}>;

export class HostedMutationJournalError extends Error {
  readonly code: string;
  readonly reference: string | undefined;

  constructor(code: string, reference?: string) {
    super(code);
    this.code = code;
    this.reference = reference;
  }
}

export function isOpaqueHostedMutationFingerprint(
  value: unknown,
): value is HostedMutationFingerprint {
  return opaqueFingerprintSchema.safeParse(value).success;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Mutation fingerprint numbers must be finite.");
      }
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalValue).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalValue(entry)}`
        )
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError("Mutation fingerprints require JSON-compatible values.");
  }
  throw new TypeError("Mutation fingerprints require JSON-compatible values.");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * Hashes one exact semantic mutation intent for a server-side HMAC lookup.
 * Top-level projection fences are deliberately excluded: a lost response may
 * advance the projection without changing the intended effect. This browser
 * digest is never itself durable.
 */
export async function hostedMutationFingerprint(input: Readonly<{
  intent: MutationIntent;
}>): Promise<ReturnType<typeof createMutationFingerprint>> {
  const parsed = taskWorkspaceClientIntentSchema.safeParse(input.intent);
  if (
    !parsed.success ||
    parsed.data.kind === "page.load_more" ||
    parsed.data.kind === "task.select" ||
    parsed.data.kind === "view.select"
  ) {
    throw new TypeError("Hosted mutation intent is invalid.");
  }
  const semanticIntent = taskWorkspaceMutationSemanticKey(parsed.data);
  const material = canonicalValue({
    intent: semanticIntent,
    version: 1,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return createMutationFingerprint(
    `sha256_${base64Url(new Uint8Array(digest))}`,
  );
}

function portableRecord(
  value: z.infer<typeof preparedRecordSchema>,
): Extract<HostedMutationAttemptRecord, { state: "prepared" }>;
function portableRecord(
  value: z.infer<typeof openRecordSchema>,
): OpenMutationAttempt<HostedMutationAttemptDefinition>;
function portableRecord(
  value: z.infer<typeof recordSchema>,
): HostedMutationAttemptRecord;
function portableRecord(
  value: z.infer<typeof recordSchema>,
): HostedMutationAttemptRecord {
  const base = {
    attemptId: createAttemptId(value.attemptId),
    fingerprint: createMutationFingerprint(value.fingerprint),
    operation: value.operation,
    sourceId: value.sourceId,
    preparedAtMs: value.preparedAtMs,
    recovery: Object.freeze({ ...value.recovery }),
  };
  switch (value.state) {
    case "prepared":
      return Object.freeze({
        ...base,
        state: value.state,
        revision: value.revision,
      });
    case "effect-started":
      return Object.freeze({
        ...base,
        state: value.state,
        revision: value.revision,
        effectStartedAtMs: value.effectStartedAtMs,
      });
    case "settled": {
      const outcome = value.outcome.status === "confirmed"
        ? Object.freeze({
            ...value.outcome,
            attemptId: createAttemptId(value.outcome.attemptId),
            value: Object.freeze({ ...value.outcome.value }),
          })
        : value.outcome.status === "rejected"
          ? Object.freeze({
              ...value.outcome,
              attemptId: createAttemptId(value.outcome.attemptId),
              error: Object.freeze({ ...value.outcome.error }),
            })
          : Object.freeze({
              ...value.outcome,
              attemptId: createAttemptId(value.outcome.attemptId),
            });
      return Object.freeze({
        ...base,
        state: value.state,
        revision: value.revision,
        effectStartedAtMs: value.effectStartedAtMs,
        settledAtMs: value.settledAtMs,
        outcome,
      });
    }
  }
}

function commandKindMatchesOperation(
  operation: z.infer<typeof operationSchema>,
  commandKind: z.infer<typeof commandKindSchema>,
): boolean {
  return commandKind === operation ||
    (
      operation === "task.create" &&
      commandKind === "task.create_and_run"
    );
}

function validRecordLaws(
  value: z.infer<typeof recordSchema>,
  expectedSourceId: string | null,
  expectedWorkspaceId: string,
): boolean {
  if (
    value.attemptId !== value.recovery.hraOperationId ||
    value.workspaceId !== expectedWorkspaceId ||
    (
      expectedSourceId !== null &&
      value.sourceId !== expectedSourceId
    )
  ) {
    return false;
  }
  switch (value.state) {
    case "prepared":
      return value.revision === 1;
    case "effect-started":
      return value.revision === 2 &&
        value.effectStartedAtMs >= value.preparedAtMs;
    case "settled": {
      if (
        value.outcome.attemptId !== value.attemptId ||
        value.settledAtMs < value.preparedAtMs ||
        (
          value.outcome.status === "confirmed" &&
          !commandKindMatchesOperation(
            value.operation,
            value.outcome.value.commandKind,
          )
        )
      ) {
        return false;
      }
      if (value.effectStartedAtMs === null) {
        return value.revision === 2 &&
          value.outcome.status !== "confirmed";
      }
      return value.revision === 3 &&
        value.effectStartedAtMs >= value.preparedAtMs &&
        value.settledAtMs >= value.effectStartedAtMs;
    }
  }
}

function portableRecordForScope(
  value: z.infer<typeof preparedRecordSchema>,
  expectedSourceId: string | null,
  expectedWorkspaceId: string,
): Extract<HostedMutationAttemptRecord, { state: "prepared" }>;
function portableRecordForScope(
  value: z.infer<typeof openRecordSchema>,
  expectedSourceId: string | null,
  expectedWorkspaceId: string,
): OpenMutationAttempt<HostedMutationAttemptDefinition>;
function portableRecordForScope(
  value: z.infer<typeof recordSchema>,
  expectedSourceId: string | null,
  expectedWorkspaceId: string,
): HostedMutationAttemptRecord;
function portableRecordForScope(
  value: z.infer<typeof recordSchema>,
  expectedSourceId: string | null,
  expectedWorkspaceId: string,
): HostedMutationAttemptRecord {
  if (!validRecordLaws(value, expectedSourceId, expectedWorkspaceId)) {
    throw new HostedMutationJournalError("INVALID_PROJECTION");
  }
  return portableRecord(value);
}

function sameOptionalString(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right;
}

function recordMatchesDraft(
  value: z.infer<typeof recordSchema>,
  draft: MutationAttemptDraft<HostedMutationAttemptDefinition>,
  status: "created" | "existing",
): boolean {
  if (
    value.sourceId !== draft.sourceId ||
    value.fingerprint !== draft.fingerprint ||
    value.operation !== draft.operation ||
    !sameOptionalString(
      value.recovery.targetTaskId,
      draft.recovery.targetTaskId,
    ) ||
    (status === "existing" && value.state === "settled")
  ) {
    return false;
  }
  return status === "existing" ||
    (
      value.attemptId === draft.attemptId &&
      value.recovery.idempotencyKey === draft.recovery.idempotencyKey &&
      value.recovery.hraOperationId ===
        draft.recovery.hraOperationId &&
      value.recovery.suppliedTaskId === draft.recovery.suppliedTaskId
    );
}

function compareCursor(
  left: z.infer<typeof cursorSchema>,
  right: z.infer<typeof cursorSchema>,
): number {
  if (left.preparedAtMs !== right.preparedAtMs) {
    return left.preparedAtMs < right.preparedAtMs ? -1 : 1;
  }
  return left.attemptId < right.attemptId
    ? -1
    : left.attemptId > right.attemptId
      ? 1
      : 0;
}

function cursorForRecord(
  value: z.infer<typeof openRecordSchema>,
): MutationAttemptCursor {
  return {
    preparedAtMs: value.preparedAtMs,
    attemptId: createAttemptId(value.attemptId),
  };
}

function unwrapResponse<Data>(
  value: unknown,
  schema: {
    safeParse(input: unknown):
      | Readonly<{ success: true; data: Data }>
      | Readonly<{ success: false }>;
  },
): Exclude<Data, { readonly ok: false }> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HostedMutationJournalError("INVALID_PROJECTION");
  const data = parsed.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "ok" in data &&
    data.ok === false &&
    "error" in data &&
    typeof data.error === "object" &&
    data.error !== null &&
    "code" in data.error &&
    typeof data.error.code === "string"
  ) {
    const reference = "requestId" in data.error &&
        typeof data.error.requestId === "string"
      ? data.error.requestId
      : undefined;
    throw new HostedMutationJournalError(data.error.code, reference);
  }
  return data as Exclude<Data, { readonly ok: false }>;
}

function validDraft(
  draft: MutationAttemptDraft<HostedMutationAttemptDefinition>,
  sourceId: string,
): boolean {
  const recovery = recoverySchema.safeParse(draft.recovery);
  return recovery.success &&
    draft.sourceId === sourceId &&
    draft.attemptId === recovery.data.hraOperationId &&
    opaqueFingerprintSchema.safeParse(draft.fingerprint).success &&
    operationSchema.safeParse(draft.operation).success &&
    Number.isSafeInteger(draft.preparedAtMs) &&
    draft.preparedAtMs >= 0;
}

function settlementInput(
  operation: z.infer<typeof operationSchema>,
  attemptId: string,
  outcome: DispatchOutcome<HostedMutationResolution>,
):
  | Readonly<{
      kind: "confirmed";
      commandKind: z.infer<typeof commandKindSchema>;
    }>
  | Readonly<{ kind: "rejected"; code: string; retryable: boolean }>
  | Readonly<{
      kind: "cancelled";
      reason: "caller" | "client-closing" | "superseded";
    }> {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    !("status" in outcome) ||
    !("attemptId" in outcome) ||
    !operationIdSchema.safeParse(outcome.attemptId).success
  ) {
    throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
  }
  if (outcome.attemptId !== attemptId) {
    throw new HostedMutationJournalError("IDEMPOTENCY_CONFLICT");
  }
  switch (outcome.status) {
    case "confirmed": {
      if (
        outcome.value.kind !== "committed" ||
        !commandKindSchema.safeParse(outcome.value.commandKind).success ||
        !commandKindMatchesOperation(operation, outcome.value.commandKind)
      ) {
        throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
      }
      return {
        kind: "confirmed" as const,
        commandKind: outcome.value.commandKind,
      };
    }
    case "rejected":
      if (
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(outcome.error.code) ||
        typeof outcome.error.retryable !== "boolean"
      ) {
        throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
      }
      return {
        kind: "rejected" as const,
        code: outcome.error.code,
        retryable: outcome.error.retryable,
      };
    case "cancelled":
      if (
        outcome.reason !== "caller" &&
        outcome.reason !== "client-closing" &&
        outcome.reason !== "superseded"
      ) {
        throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
      }
      return { kind: "cancelled" as const, reason: outcome.reason };
    case "ambiguous":
      throw new HostedMutationJournalError("MUTATION_OUTCOME_UNKNOWN");
  }
}

type PersistedSettlement = ReturnType<typeof settlementInput>;

function settledOutcomeMatches(
  value: z.infer<typeof settledRecordSchema>,
  settlement: PersistedSettlement,
): boolean {
  switch (settlement.kind) {
    case "confirmed":
      return value.outcome.status === "confirmed" &&
        value.outcome.value.commandKind === settlement.commandKind;
    case "rejected":
      return value.outcome.status === "rejected" &&
        value.outcome.error.code === settlement.code &&
        value.outcome.error.retryable === settlement.retryable;
    case "cancelled":
      return value.outcome.status === "cancelled" &&
        value.outcome.reason === settlement.reason;
  }
}

export function createConvexHostedMutationAttemptJournal(options: Readonly<{
  client: ConvexReactClient;
  sourceId?: string;
  workspaceId: string;
}>): HostedMutationAttemptJournal {
  const sourceId = options.sourceId ?? HOSTED_TASK_MUTATION_SOURCE_ID;
  if (sourceId !== HOSTED_TASK_MUTATION_SOURCE_ID) {
    throw new RangeError("Hosted mutation source ID is not canonical.");
  }
  const parsedWorkspaceId = workspacePublicIdSchema.safeParse(
    options.workspaceId,
  );
  if (!parsedWorkspaceId.success) {
    throw new RangeError("Hosted mutation workspace ID is invalid.");
  }
  const workspaceId = parsedWorkspaceId.data;
  const resolvedFingerprints = new Map<string, Readonly<{
    fingerprintKeyVersion: string;
    prepareProof: string;
  }>>();

  const resolveFingerprint: NonNullable<
    HostedMutationAttemptJournal["resolveFingerprint"]
  > = async (clientFingerprint) => {
    if (!clientFingerprintSchema.safeParse(clientFingerprint).success) {
      throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
    }
    const response = unwrapResponse(
      await options.client.mutation(
        api.hostedMutationAttempts.resolveFingerprint,
        {
          workspaceId,
          sourceId,
          clientFingerprint,
        },
      ),
      resolveFingerprintResponseSchema,
    );
    if (!response.ok) throw new HostedMutationJournalError("INTERNAL_ERROR");
    resolvedFingerprints.delete(response.data.fingerprint);
    resolvedFingerprints.set(response.data.fingerprint, {
      fingerprintKeyVersion: response.data.fingerprintKeyVersion,
      prepareProof: response.data.prepareProof,
    });
    while (resolvedFingerprints.size > MAX_RESOLVED_FINGERPRINTS) {
      const oldest = resolvedFingerprints.keys().next().value;
      if (oldest === undefined) break;
      resolvedFingerprints.delete(oldest);
    }
    return createMutationFingerprint(response.data.fingerprint);
  };

  const prepare = async (
    draft: MutationAttemptDraft<HostedMutationAttemptDefinition>,
  ): Promise<PrepareMutationAttemptResult<
    HostedMutationAttemptDefinition
  >> => {
    if (!validDraft(draft, sourceId)) {
      throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
    }
    const resolved = resolvedFingerprints.get(draft.fingerprint);
    if (resolved === undefined) {
      throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
    }
    const response = unwrapResponse(
      await options.client.mutation(api.hostedMutationAttempts.prepare, {
        workspaceId,
        sourceId,
        operation: draft.operation,
        fingerprint: draft.fingerprint,
        fingerprintKeyVersion: resolved.fingerprintKeyVersion,
        prepareProof: resolved.prepareProof,
        idempotencyKey: draft.recovery.idempotencyKey,
        hraOperationId: draft.recovery.hraOperationId,
        suppliedTaskId: draft.recovery.suppliedTaskId,
        ...(draft.recovery.targetTaskId === undefined
          ? {}
          : { targetTaskId: draft.recovery.targetTaskId }),
      }),
      prepareResponseSchema,
    );
    if (!response.ok) throw new HostedMutationJournalError("INTERNAL_ERROR");
    if (response.data.status === "capacity") {
      throw new HostedMutationJournalError(
        "MUTATION_ATTEMPT_CAPACITY",
        response.requestId,
      );
    }
    if (response.data.status === "collision") {
      if (
        response.data.current.attemptId !== draft.attemptId &&
        response.data.current.fingerprint !== draft.fingerprint &&
        response.data.current.recovery.idempotencyKey !==
          draft.recovery.idempotencyKey
      ) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      return Object.freeze({
        status: "collision" as const,
        current: portableRecordForScope(
          response.data.current,
          sourceId,
          workspaceId,
        ),
      });
    }
    if (response.data.status === "created") {
      if (!recordMatchesDraft(response.data.record, draft, "created")) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      return Object.freeze({
        status: "created" as const,
        record: portableRecordForScope(
          response.data.record,
          sourceId,
          workspaceId,
        ),
      });
    }
    if (!recordMatchesDraft(response.data.record, draft, "existing")) {
      throw new HostedMutationJournalError("INVALID_PROJECTION");
    }
    return Object.freeze({
      status: "existing" as const,
      record: portableRecordForScope(
        response.data.record,
        sourceId,
        workspaceId,
      ),
    });
  };

  const markEffectStarted = async (
    attemptId: Parameters<HostedMutationAttemptJournal["markEffectStarted"]>[0],
    expectedRevision: number,
    effectStartedAtMs: number,
  ): Promise<TransitionMutationAttemptResult<
    HostedMutationAttemptDefinition
  >> => {
    if (
      !operationIdSchema.safeParse(attemptId).success ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      !Number.isSafeInteger(effectStartedAtMs) ||
      effectStartedAtMs < 0
    ) {
      throw new RangeError("Hosted mutation effect time is invalid.");
    }
    const response = unwrapResponse(
      await options.client.mutation(
        api.hostedMutationAttempts.markEffectStarted,
        {
          workspaceId,
          sourceId,
          attemptId,
          expectedRevision,
        },
      ),
      transitionResponseSchema,
    );
    if (!response.ok) throw new HostedMutationJournalError("INTERNAL_ERROR");
    switch (response.data.status) {
      case "missing":
        return Object.freeze({ status: "missing" as const });
      case "applied":
        if (
          response.data.record.attemptId !== attemptId ||
          response.data.record.state !== "effect-started" ||
          response.data.record.revision !== expectedRevision + 1
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          status: "applied" as const,
          record: portableRecordForScope(
            response.data.record,
            sourceId,
            workspaceId,
          ),
        });
      case "conflict":
        if (
          response.data.current.attemptId !== attemptId ||
          response.data.current.revision === expectedRevision
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          status: response.data.status,
          current: portableRecordForScope(
            response.data.current,
            sourceId,
            workspaceId,
          ),
        });
      case "invalid-transition":
        if (
          response.data.current.attemptId !== attemptId ||
          response.data.current.revision !== expectedRevision ||
          response.data.current.state === "prepared"
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          status: response.data.status,
          current: portableRecordForScope(
            response.data.current,
            sourceId,
            workspaceId,
          ),
        });
    }
  };

  const settle: HostedMutationAttemptJournal["settle"] = async (
    settlement,
  ): Promise<TransitionMutationAttemptResult<
    HostedMutationAttemptDefinition
  >> => {
    if (
      !operationIdSchema.safeParse(settlement.attemptId).success ||
      !operationSchema.safeParse(settlement.operation).success ||
      !Number.isSafeInteger(settlement.expectedRevision) ||
      settlement.expectedRevision < 1 ||
      !Number.isSafeInteger(settlement.settledAtMs) ||
      settlement.settledAtMs < 0
    ) {
      throw new RangeError("Hosted mutation settlement time is invalid.");
    }
    const persistedSettlement = settlementInput(
      settlement.operation,
      settlement.attemptId,
      settlement.outcome,
    );
    const response = unwrapResponse(
      await options.client.mutation(api.hostedMutationAttempts.settle, {
        workspaceId,
        sourceId,
        operation: settlement.operation,
        attemptId: settlement.attemptId,
        expectedRevision: settlement.expectedRevision,
        settlement: persistedSettlement,
      }),
      transitionResponseSchema,
    );
    if (!response.ok) throw new HostedMutationJournalError("INTERNAL_ERROR");
    switch (response.data.status) {
      case "missing":
        return Object.freeze({ status: "missing" as const });
      case "applied":
        if (
          response.data.record.attemptId !== settlement.attemptId ||
          response.data.record.operation !== settlement.operation ||
          response.data.record.state !== "settled" ||
          response.data.record.revision !==
            settlement.expectedRevision + 1 ||
          !settledOutcomeMatches(
            response.data.record,
            persistedSettlement,
          )
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          status: "applied" as const,
          record: portableRecordForScope(
            response.data.record,
            sourceId,
            workspaceId,
          ),
        });
      case "conflict":
        if (
          response.data.current.attemptId !== settlement.attemptId ||
          response.data.current.operation !== settlement.operation ||
          response.data.current.revision === settlement.expectedRevision
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          status: response.data.status,
          current: portableRecordForScope(
            response.data.current,
            sourceId,
            workspaceId,
          ),
        });
      case "invalid-transition":
        if (
          response.data.current.attemptId !== settlement.attemptId ||
          response.data.current.operation !== settlement.operation ||
          response.data.current.revision !== settlement.expectedRevision
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          status: response.data.status,
          current: portableRecordForScope(
            response.data.current,
            sourceId,
            workspaceId,
          ),
        });
    }
  };

  const get = async (
    attemptId: Parameters<HostedMutationAttemptJournal["get"]>[0],
  ): Promise<HostedMutationAttemptRecord | null> => {
    if (!operationIdSchema.safeParse(attemptId).success) {
      throw new HostedMutationJournalError("INVALID_MUTATION_REQUEST");
    }
    const response = unwrapResponse(
      await options.client.query(api.hostedMutationAttempts.get, {
        workspaceId,
        sourceId,
        attemptId,
      }),
      getResponseSchema,
    );
    if (!response.ok) throw new HostedMutationJournalError("INTERNAL_ERROR");
    if (response.data === null) return null;
    if (response.data.attemptId !== attemptId) {
      throw new HostedMutationJournalError("INVALID_PROJECTION");
    }
    return portableRecordForScope(response.data, sourceId, workspaceId);
  };

  const listOpen: HostedMutationAttemptJournal["listOpen"] = async (
    request,
  ) => {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > MAX_JOURNAL_PAGE_LIMIT ||
      (
        request.sourceId !== null &&
        request.sourceId !== sourceId
      ) ||
      (
        request.after !== null &&
        !cursorSchema.safeParse(request.after).success
      )
    ) {
      throw new RangeError("Hosted mutation journal page request is invalid.");
    }
    const attempts: OpenMutationAttempt<HostedMutationAttemptDefinition>[] = [];
    let cursor: MutationAttemptCursor | null = request.after;
    let hasMore = false;
    while (attempts.length < request.limit) {
      const pageLimit = Math.min(
        CONVEX_ATTEMPT_PAGE_LIMIT,
        request.limit - attempts.length,
      );
      const response = unwrapResponse(
        await options.client.query(api.hostedMutationAttempts.listOpen, {
          workspaceId,
          sourceId: request.sourceId,
          after: cursor,
          limit: pageLimit,
        }),
        listResponseSchema,
      );
      if (!response.ok) throw new HostedMutationJournalError("INTERNAL_ERROR");
      if (response.data.attempts.length > pageLimit) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      const page: OpenMutationAttempt<HostedMutationAttemptDefinition>[] = [];
      let pageCursor = cursor;
      for (const record of response.data.attempts) {
        const recordCursor = cursorForRecord(record);
        if (
          pageCursor !== null &&
          compareCursor(pageCursor, recordCursor) >= 0
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        page.push(portableRecordForScope(
          record,
          request.sourceId,
          workspaceId,
        ));
        pageCursor = recordCursor;
      }
      const lastRecord = response.data.attempts.at(-1);
      if (response.data.hasMore) {
        if (
          lastRecord === undefined ||
          response.data.nextCursor === null ||
          compareCursor(
            response.data.nextCursor,
            cursorForRecord(lastRecord),
          ) !== 0
        ) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
      } else if (response.data.nextCursor !== null) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      attempts.push(...page);
      hasMore = response.data.hasMore;
      if (!hasMore) {
        cursor = null;
        break;
      }
      if (response.data.nextCursor === null) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      cursor = Object.freeze({
        preparedAtMs: response.data.nextCursor.preparedAtMs,
        attemptId: createAttemptId(response.data.nextCursor.attemptId),
      });
    }
    const last = attempts.at(-1);
    return Object.freeze({
      attempts: Object.freeze(attempts),
      nextCursor: hasMore && last !== undefined
        ? Object.freeze({
            preparedAtMs: last.preparedAtMs,
            attemptId: last.attemptId,
          })
        : null,
      hasMore,
    });
  };

  const drainOpen = async (): Promise<HostedMutationDrainResult> => {
    let blocked = 0;
    let pendingReceipts = 0;
    let reconciled = 0;
    let cursor: z.infer<typeof cursorSchema> | null = null;
    for (
      let scanned = 0;
      scanned <= MAX_JOURNAL_PAGE_LIMIT;
      scanned += CONVEX_ATTEMPT_PAGE_LIMIT
    ) {
      const response: Extract<
        z.infer<typeof reconcileResponseSchema>,
        Readonly<{ ok: true }>
      > = unwrapResponse(
        await options.client.mutation(
          api.hostedMutationAttempts.reconcileOpenPage,
          {
            workspaceId,
            sourceId,
            after: cursor,
            limit: CONVEX_ATTEMPT_PAGE_LIMIT,
          },
        ),
        reconcileResponseSchema,
      );
      blocked += response.data.blocked;
      pendingReceipts += response.data.pendingReceipts;
      reconciled += response.data.reconciled;
      if (!response.data.hasMore) {
        if (response.data.nextCursor !== null) {
          throw new HostedMutationJournalError("INVALID_PROJECTION");
        }
        return Object.freeze({
          blocked,
          pendingReceipts,
          reconciled,
        });
      }
      if (response.data.nextCursor === null) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      if (
        cursor !== null &&
        compareCursor(cursor, response.data.nextCursor) >= 0
      ) {
        throw new HostedMutationJournalError("INVALID_PROJECTION");
      }
      cursor = response.data.nextCursor;
    }
    throw new HostedMutationJournalError("MUTATION_ATTEMPT_CAPACITY");
  };

  return Object.freeze({
    drainOpen,
    get,
    listOpen,
    markEffectStarted,
    prepare,
    resolveFingerprint,
    settle,
  });
}
