import {
  operationIdSchema,
  taskPublicIdSchema,
  taskWorkspaceClientMutationIntentKindValues,
} from "@hraness/agent-tasks-domain";
import { uuidV7Schema } from "@hraness/agent-tasks-protocol";
import {
  type Infer,
  v,
} from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
  env,
} from "./_generated/server";
import {
  domainFailure,
  randomRequestId,
} from "./domain";
import { authorizeWorkspaceHuman } from "./humanAuthorization";
import {
  OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN,
  hostedMutationPrepareProof,
  opaqueHostedMutationFingerprintCandidates,
  parseHostedMutationFingerprintKeyring,
  verifyHostedMutationPrepareProof,
  type HostedMutationFingerprintKeyring,
  type HostedMutationFingerprintScope,
  type OpaqueHostedMutationFingerprint,
} from "./hostedMutationFingerprint";
import {
  LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD,
  LEGACY_HOSTED_MUTATION_OPERATION_ID_INDEX,
  hraOperationIdFromLegacyHostedMutationRecord,
  legacyHostedMutationOperationIdFields,
} from "./hostedMutationPersistence";
import { domainErrorValidator } from "./model";
import { consumeAuthorizedHumanRateLimit } from "./rateLimits";

// This source ID participates in persisted fingerprints and receipt replay.
// Preserve its pre-cutover bytes while exposing it through the HRA API.
export const HOSTED_TASK_MUTATION_SOURCE_ID =
  "oprte.web.task-workspace.v1";
const CLIENT_FINGERPRINT_PATTERN = /^sha256_[A-Za-z0-9_-]{43}$/u;
const FINGERPRINT_KEY_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MAX_OPEN_ATTEMPTS_PER_SCOPE = 256;
const MAX_LIST_PAGE_SIZE = 50;
const ORDER_TIME_WIDTH = 16;
const SETTLED_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const QUARANTINED_TOMBSTONE_RETENTION_MS =
  365 * 24 * 60 * 60 * 1_000;
const OPEN_ATTEMPT_RECOVERY_RETENTION_MS =
  30 * 24 * 60 * 60 * 1_000;
const SETTLED_TOMBSTONE_SWEEP_BATCH_SIZE = 64;

const operationValues = new Set<string>(
  taskWorkspaceClientMutationIntentKindValues,
);
const commandKindValues = new Set<string>([
  ...taskWorkspaceClientMutationIntentKindValues,
  "task.create_and_run",
]);
const targetTaskAttemptOperations = new Set<string>([
  "task.update",
  "task.cancel",
  "task.reopen",
  "task.assign",
  "task.defer",
  "task.parent_set",
  "task.parent_clear",
  "task.label_add",
  "task.label_remove",
  "task.comment_add",
  "task.reference_add",
  "task.reference_remove",
  "dependency.add",
  "dependency.remove",
  "review.accept",
  "review.reject",
  "dispatch.retry",
  "dispatch.resolve_ambiguity",
]);

const receiptOperationsByAttemptOperation = Object.freeze({
  "task.create": ["tasks.create", "tasks.create_and_dispatch"],
  "task.update": ["tasks.update"],
  "task.cancel": ["tasks.cancel"],
  "task.reopen": ["tasks.reopen"],
  "task.assign": ["tasks.assign"],
  "task.defer": ["tasks.defer"],
  "task.parent_set": ["tasks.parent.set"],
  "task.parent_clear": ["tasks.parent.clear"],
  "task.label_add": ["tasks.labels.add"],
  "task.label_remove": ["tasks.labels.remove"],
  "task.comment_add": ["tasks.comments.add"],
  "task.reference_add": ["tasks.references.add"],
  "task.reference_remove": ["tasks.references.remove"],
  "dependency.add": ["tasks.dependencies.add"],
  "dependency.remove": ["tasks.dependencies.remove"],
  "review.accept": ["tasks.accept"],
  "review.reject": ["tasks.reject"],
  "dispatch.stop": ["runs.stop"],
  "dispatch.retry": ["runs.retry"],
  "dispatch.resolve_ambiguity": ["runs.abandon_ambiguous"],
  "interaction.respond": ["dispatch.interaction.respond"],
} as const satisfies Readonly<
  Record<
    (typeof taskWorkspaceClientMutationIntentKindValues)[number],
    readonly string[]
  >
>);

type ReceiptOperation =
  (typeof receiptOperationsByAttemptOperation)[
    keyof typeof receiptOperationsByAttemptOperation
  ][number];

const recoveryValidator = v.object({
  idempotencyKey: v.string(),
  hraOperationId: v.string(),
  suppliedTaskId: v.string(),
  targetTaskId: v.optional(v.string()),
});

const confirmedOutcomeValidator = v.object({
  status: v.literal("confirmed"),
  attemptId: v.string(),
  value: v.object({
    kind: v.literal("committed"),
    commandKind: v.string(),
  }),
});

const rejectedOutcomeValidator = v.object({
  status: v.literal("rejected"),
  attemptId: v.string(),
  error: v.object({
    code: v.string(),
    message: v.string(),
    retryable: v.boolean(),
  }),
});

const cancelledOutcomeValidator = v.object({
  status: v.literal("cancelled"),
  attemptId: v.string(),
  reason: v.union(
    v.literal("caller"),
    v.literal("client-closing"),
    v.literal("superseded"),
  ),
});

const attemptBaseValidator = {
  attemptId: v.string(),
  fingerprint: v.string(),
  fingerprintKeyVersion: v.string(),
  operation: v.string(),
  sourceId: v.string(),
  preparedAtMs: v.number(),
  workspaceId: v.string(),
  recovery: recoveryValidator,
} as const;

const preparedRecordValidator = v.object({
  ...attemptBaseValidator,
  state: v.literal("prepared"),
  revision: v.number(),
});

const effectStartedRecordValidator = v.object({
  ...attemptBaseValidator,
  state: v.literal("effect-started"),
  revision: v.number(),
  effectStartedAtMs: v.number(),
});

const settledRecordValidator = v.object({
  ...attemptBaseValidator,
  state: v.literal("settled"),
  revision: v.number(),
  effectStartedAtMs: v.union(v.null(), v.number()),
  settledAtMs: v.number(),
  outcome: v.union(
    confirmedOutcomeValidator,
    rejectedOutcomeValidator,
    cancelledOutcomeValidator,
  ),
});

const attemptRecordValidator = v.union(
  preparedRecordValidator,
  effectStartedRecordValidator,
  settledRecordValidator,
);

const failureValidator = v.object({
  ok: v.literal(false),
  error: domainErrorValidator,
});

const prepareResultValidator = v.union(
  failureValidator,
  v.object({
    ok: v.literal(true),
    data: v.union(
      v.object({
        status: v.literal("created"),
        record: preparedRecordValidator,
      }),
      v.object({
        status: v.literal("existing"),
        record: attemptRecordValidator,
      }),
      v.object({
        status: v.literal("collision"),
        current: attemptRecordValidator,
      }),
      v.object({
        status: v.literal("capacity"),
      }),
    ),
    requestId: v.string(),
  }),
);

const transitionResultValidator = v.union(
  failureValidator,
  v.object({
    ok: v.literal(true),
    data: v.union(
      v.object({
        status: v.literal("applied"),
        record: attemptRecordValidator,
      }),
      v.object({
        status: v.literal("conflict"),
        current: attemptRecordValidator,
      }),
      v.object({ status: v.literal("missing") }),
      v.object({
        status: v.literal("invalid-transition"),
        current: attemptRecordValidator,
      }),
    ),
    requestId: v.string(),
  }),
);

const getResultValidator = v.union(
  failureValidator,
  v.object({
    ok: v.literal(true),
    data: v.union(v.null(), attemptRecordValidator),
    requestId: v.string(),
  }),
);

const resolveFingerprintResultValidator = v.union(
  failureValidator,
  v.object({
    ok: v.literal(true),
    data: v.object({
      fingerprint: v.string(),
      fingerprintKeyVersion: v.string(),
      prepareProof: v.string(),
    }),
    requestId: v.string(),
  }),
);

const cursorValidator = v.object({
  preparedAtMs: v.number(),
  attemptId: v.string(),
});

const listResultValidator = v.union(
  failureValidator,
  v.object({
    ok: v.literal(true),
    data: v.object({
      attempts: v.array(v.union(
        preparedRecordValidator,
        effectStartedRecordValidator,
      )),
      nextCursor: v.union(v.null(), cursorValidator),
      hasMore: v.boolean(),
    }),
    requestId: v.string(),
  }),
);

const reconcileResultValidator = v.union(
  failureValidator,
  v.object({
    ok: v.literal(true),
    data: v.object({
      blocked: v.number(),
      hasMore: v.boolean(),
      nextCursor: v.union(v.null(), cursorValidator),
      pendingReceipts: v.number(),
      reconciled: v.number(),
    }),
    requestId: v.string(),
  }),
);

const settlementInputValidator = v.union(
  v.object({
    kind: v.literal("confirmed"),
    commandKind: v.string(),
  }),
  v.object({
    kind: v.literal("rejected"),
    code: v.string(),
    retryable: v.boolean(),
  }),
  v.object({
    kind: v.literal("cancelled"),
    reason: v.union(
      v.literal("caller"),
      v.literal("client-closing"),
      v.literal("superseded"),
    ),
  }),
);

type ReadCtx = QueryCtx | MutationCtx;
type AttemptDoc = Doc<"hostedMutationAttempts">;
type OpenAttemptDoc = Extract<
  AttemptDoc,
  { state: "effect-started" | "prepared" }
>;
type AttemptRecordValue = Infer<typeof attemptRecordValidator>;
type OpenAttemptRecordValue =
  | Infer<typeof preparedRecordValidator>
  | Infer<typeof effectStartedRecordValidator>;
type PreparedRecordValue = Infer<typeof preparedRecordValidator>;
type SettlementInput =
  | Readonly<{ kind: "confirmed"; commandKind: string }>
  | Readonly<{ kind: "rejected"; code: string; retryable: boolean }>
  | Readonly<{
      kind: "cancelled";
      reason: "caller" | "client-closing" | "superseded";
    }>;

type PersistedSettlement =
  | SettlementInput
  | Readonly<{
      kind: "quarantined";
      reason: "expired-unack" | "invalid-receipt";
    }>;

type AuthorizedScope = Readonly<{
  organizationId: Doc<"organizations">["_id"];
  principalId: Doc<"users">["_id"];
  workspaceId: Doc<"workspaces">["_id"];
  workspacePublicId: string;
}>;

export type HostedMutationReceiptBinding = Readonly<{
  attemptDocumentId: Id<"hostedMutationAttempts">;
  fingerprint: string;
  fingerprintKeyVersion: string;
  operation: string;
  hraOperationId: string;
  receiptId?: Id<"humanCommandReceipts">;
  sourceId: string;
  suppliedTaskId: string;
  targetTaskId?: string;
}>;

export async function resolveHostedMutationReceiptBinding(
  ctx: MutationCtx,
  args: Readonly<{
    idempotencyKey: string;
    operation: string;
    hraOperationId: string;
    organizationId: Doc<"organizations">["_id"];
    principalId: Doc<"users">["_id"];
    suppliedTaskId?: string;
    targetRunId?: string;
    targetTaskKey?: string;
    workspaceId: Doc<"workspaces">["_id"];
    workspacePublicId: string;
  }>,
  deriveClientFingerprint: (
    binding: HostedMutationReceiptBinding,
  ) => Promise<string> | string,
): Promise<HostedMutationReceiptBinding | null> {
  if (
    !validOperation(args.operation) ||
    !uuidV7Schema.safeParse(args.idempotencyKey).success ||
    !operationIdSchema.safeParse(args.hraOperationId).success
  ) {
    return null;
  }
  const scope = {
    organizationId: args.organizationId,
    principalId: args.principalId,
    workspaceId: args.workspaceId,
    workspacePublicId: args.workspacePublicId,
  };
  const record = await attemptById(ctx, scope, args.hraOperationId);
  if (
    record === null ||
    record === "corrupt" ||
    record.state !== "effect-started" ||
    !record.open ||
    record.sourceId !== HOSTED_TASK_MUTATION_SOURCE_ID ||
    record.operation !== args.operation ||
    record.idempotencyKey !== args.idempotencyKey ||
    !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(record.fingerprint)
  ) {
    return null;
  }
  const expectsTarget = targetTaskAttemptOperations.has(record.operation);
  if (
    (args.targetTaskKey !== undefined && args.targetRunId !== undefined) ||
    expectsTarget !== (
      args.targetTaskKey !== undefined || args.targetRunId !== undefined
    ) ||
    expectsTarget !== (record.targetTaskId !== undefined)
  ) {
    return null;
  }
  if (args.targetTaskKey !== undefined) {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_public_id", (index) =>
        index
          .eq("workspaceId", scope.workspaceId)
          .eq("publicId", record.targetTaskId ?? ""),
      )
      .unique();
    if (
      task === null ||
      task.organizationId !== scope.organizationId ||
      task.workspaceId !== scope.workspaceId ||
      task.publicId !== record.targetTaskId ||
      task.key !== args.targetTaskKey
    ) {
      return null;
    }
  }
  if (args.targetRunId !== undefined) {
    const dispatch = await ctx.db
      .query("taskDispatches")
      .withIndex("by_public_id", (index) =>
        index.eq("publicId", args.targetRunId ?? ""),
      )
      .unique();
    const task = dispatch === null ? null : await ctx.db.get(dispatch.taskId);
    if (
      dispatch === null ||
      task === null ||
      dispatch.organizationId !== scope.organizationId ||
      dispatch.workspaceId !== scope.workspaceId ||
      task.organizationId !== scope.organizationId ||
      task.workspaceId !== scope.workspaceId ||
      task.publicId !== record.targetTaskId
    ) {
      return null;
    }
  }
  if (
    record.operation === "task.create" &&
    args.suppliedTaskId !== record.suppliedTaskId
  ) {
    return null;
  }
  const binding: HostedMutationReceiptBinding = {
    attemptDocumentId: record._id,
    fingerprint: record.fingerprint,
    fingerprintKeyVersion: record.fingerprintKeyVersion,
    operation: record.operation,
    hraOperationId: hraOperationIdFromLegacyHostedMutationRecord(record),
    ...(record.receiptId === undefined ? {} : { receiptId: record.receiptId }),
    sourceId: record.sourceId,
    suppliedTaskId: record.suppliedTaskId,
    ...(record.targetTaskId === undefined
      ? {}
      : { targetTaskId: record.targetTaskId }),
  };
  let clientFingerprint: string;
  try {
    clientFingerprint = await deriveClientFingerprint(binding);
  } catch {
    return null;
  }
  if (!validClientFingerprint(clientFingerprint)) return null;
  const keyring = parseHostedMutationFingerprintKeyring(env);
  if (keyring === null) return null;
  const candidates = await scopedFingerprintCandidates(
    keyring,
    scope,
    record.sourceId,
    clientFingerprint,
  );
  if (
    candidates === null ||
    !candidates.some((candidate) =>
      candidate.fingerprint === record.fingerprint &&
      candidate.fingerprintKeyVersion === record.fingerprintKeyVersion
    )
  ) {
    return null;
  }
  return binding;
}

function receiptOperationsForAttempt(operation: string): readonly string[] {
  return validOperation(operation)
    ? receiptOperationsByAttemptOperation[
        operation as keyof typeof receiptOperationsByAttemptOperation
      ]
    : [];
}

type ReceiptAttemptOperation =
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "resolved"; operation: string }>;

function attemptOperationForReceiptOperation(
  receiptOperation: string,
): ReceiptAttemptOperation {
  let resolved: string | null = null;
  for (
    const [attemptOperation, receiptOperations] of
      Object.entries(receiptOperationsByAttemptOperation)
  ) {
    if (!receiptOperations.some((operation) => operation === receiptOperation)) {
      continue;
    }
    if (resolved !== null && resolved !== attemptOperation) {
      return { kind: "ambiguous" };
    }
    resolved = attemptOperation;
  }
  return resolved === null
    ? { kind: "none" }
    : { kind: "resolved", operation: resolved };
}

function receiptMatchesAttempt(
  receipt: Doc<"humanCommandReceipts">,
  record: AttemptDoc,
  principal: Doc<"users">,
): boolean {
  return receipt.principalKind === "organization" &&
    receipt.principalId === principal.workosUserId &&
    receipt.organizationId === record.organizationId &&
    receipt.idempotencyKey === record.idempotencyKey &&
    receiptOperationsForAttempt(record.operation).includes(receipt.operation);
}

export type LegacyHostedMutationReceiptReference =
  | "absent"
  | "ambiguous"
  | "referenced";

/**
 * Protects receipts written before hosted attempts stored their receipt ID.
 * Identity, operation, and open-attempt cardinality must all resolve exactly;
 * callers retain the receipt for every ambiguous or corrupt legacy shape.
 */
export async function legacyHostedMutationReceiptReference(
  ctx: Pick<MutationCtx, "db">,
  receipt: Doc<"humanCommandReceipts">,
): Promise<LegacyHostedMutationReceiptReference> {
  if (receipt.principalKind !== "organization") return "absent";
  const organizationId = receipt.organizationId;
  if (organizationId === undefined) return "ambiguous";
  const mapped = attemptOperationForReceiptOperation(receipt.operation);
  if (mapped.kind !== "resolved") {
    return mapped.kind === "none" ? "absent" : "ambiguous";
  }
  const principals = await ctx.db
    .query("users")
    .withIndex("by_workos_user_id", (index) =>
      index.eq("workosUserId", receipt.principalId))
    .take(2);
  if (principals.length !== 1) return "ambiguous";
  const principal = principals[0];
  if (principal === undefined) return "ambiguous";
  const attempts = await ctx.db
    .query("hostedMutationAttempts")
    .withIndex(
      "by_principal_organization_operation_idempotency_open",
      (index) =>
        index
          .eq("principalId", principal._id)
          .eq("organizationId", organizationId)
          .eq("operation", mapped.operation)
          .eq("idempotencyKey", receipt.idempotencyKey)
          .eq("open", true),
    )
    .take(2);
  if (attempts.length === 0) return "absent";
  if (attempts.length !== 1) return "ambiguous";
  const attempt = attempts[0];
  return attempt !== undefined &&
      attempt.state === "effect-started" &&
      attempt.receiptId === undefined &&
      receiptMatchesAttempt(receipt, attempt, principal)
    ? "referenced"
    : "ambiguous";
}

function confirmedCommandKindForReceipt(
  record: AttemptDoc,
  receipt: Doc<"humanCommandReceipts">,
): string | null {
  if (!receiptOperationsForAttempt(record.operation).includes(
    receipt.operation as ReceiptOperation,
  )) {
    return null;
  }
  if (record.operation !== "task.create") return record.operation;
  if (receipt.operation === "tasks.create") return "task.create";
  if (receipt.operation === "tasks.create_and_dispatch") {
    return "task.create_and_run";
  }
  return null;
}

type AuthoritativeReceiptState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      commandKind: string;
      kind: "present";
      receiptId: Id<"humanCommandReceipts">;
    }>
  | Readonly<{ kind: "unlinked" }>
  | Readonly<{ kind: "corrupt" }>;

async function authoritativeReceiptState(
  ctx: ReadCtx,
  record: AttemptDoc,
): Promise<AuthoritativeReceiptState> {
  const principal = await ctx.db.get(record.principalId);
  if (
    principal === null ||
    principal._id !== record.principalId
  ) {
    return { kind: "corrupt" };
  }
  const linkedReceiptId =
    "receiptId" in record ? record.receiptId : undefined;
  if (linkedReceiptId !== undefined) {
    const receipt = await ctx.db.get(linkedReceiptId);
    if (
      receipt === null ||
      !receiptMatchesAttempt(receipt, record, principal)
    ) {
      return { kind: "corrupt" };
    }
    const commandKind = confirmedCommandKindForReceipt(record, receipt);
    return commandKind === null
      ? { kind: "corrupt" }
      : {
          commandKind,
          kind: "present",
          receiptId: receipt._id,
        };
  }
  const receiptPrincipalId = principal.workosUserId;
  if (receiptPrincipalId === undefined) return { kind: "corrupt" };
  for (const operation of receiptOperationsForAttempt(record.operation)) {
    const receipts = await ctx.db
      .query("humanCommandReceipts")
      .withIndex("by_principal_operation_key", (index) =>
        index
          .eq("principalKind", "organization")
          .eq("principalId", receiptPrincipalId)
          .eq("organizationId", record.organizationId)
          .eq("operation", operation)
          .eq("idempotencyKey", record.idempotencyKey),
      )
      .take(2);
    if (receipts.length > 1) return { kind: "corrupt" };
    if (receipts.length === 1) return { kind: "unlinked" };
  }
  return { kind: "absent" };
}

export async function linkHostedMutationReceipt(
  ctx: MutationCtx,
  binding: HostedMutationReceiptBinding,
  receiptId: Id<"humanCommandReceipts">,
): Promise<boolean> {
  const record = await ctx.db.get(binding.attemptDocumentId);
  if (
    record === null ||
    record.state !== "effect-started" ||
    !record.open ||
    hraOperationIdFromLegacyHostedMutationRecord(record) !==
      binding.hraOperationId ||
    record.operation !== binding.operation ||
    record.sourceId !== binding.sourceId ||
    record.fingerprint !== binding.fingerprint ||
    record.fingerprintKeyVersion !== binding.fingerprintKeyVersion ||
    (
      record.receiptId !== undefined &&
      record.receiptId !== receiptId
    )
  ) {
    return false;
  }
  const receipt = await ctx.db.get(receiptId);
  const principal = await ctx.db.get(record.principalId);
  if (
    receipt === null ||
    principal === null ||
    !receiptMatchesAttempt(receipt, record, principal)
  ) {
    return false;
  }
  const minimumReceiptExpiry =
    Date.now() +
    OPEN_ATTEMPT_RECOVERY_RETENTION_MS +
    SETTLED_TOMBSTONE_RETENTION_MS;
  if (receipt.expiresAt < minimumReceiptExpiry) {
    await ctx.db.patch(receipt._id, { expiresAt: minimumReceiptExpiry });
  }
  if (record.receiptId === undefined) {
    await ctx.db.patch(record._id, { receiptId });
  }
  return true;
}

async function scopedFingerprintCandidates(
  keyring: HostedMutationFingerprintKeyring,
  scope: AuthorizedScope,
  sourceId: string,
  clientFingerprint: string,
): Promise<readonly OpaqueHostedMutationFingerprint[] | null> {
  try {
    return await opaqueHostedMutationFingerprintCandidates(
      keyring,
      fingerprintScope(scope, sourceId),
      clientFingerprint,
    );
  } catch {
    return null;
  }
}

function fingerprintScope(
  scope: AuthorizedScope,
  sourceId: string,
): HostedMutationFingerprintScope {
  return {
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    workspaceId: scope.workspaceId,
    sourceId,
  };
}

function validSourceId(value: string): boolean {
  return value === HOSTED_TASK_MUTATION_SOURCE_ID;
}

function validClientFingerprint(value: string): boolean {
  return CLIENT_FINGERPRINT_PATTERN.test(value);
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function attemptOrderKey(preparedAt: number, attemptId: string): string {
  if (!validEpoch(preparedAt) || preparedAt.toString().length > ORDER_TIME_WIDTH) {
    throw new Error("Hosted mutation attempt time exceeded its order-key bound.");
  }
  return `${preparedAt.toString().padStart(ORDER_TIME_WIDTH, "0")}:${attemptId}`;
}

function validRecovery(input: {
  idempotencyKey: string;
  hraOperationId: string;
  suppliedTaskId: string;
  targetTaskId?: string;
}): boolean {
  return uuidV7Schema.safeParse(input.idempotencyKey).success &&
    operationIdSchema.safeParse(input.hraOperationId).success &&
    taskPublicIdSchema.safeParse(input.suppliedTaskId).success &&
    (
      input.targetTaskId === undefined ||
      taskPublicIdSchema.safeParse(input.targetTaskId).success
    );
}

function validOperation(operation: string): boolean {
  return operationValues.has(operation);
}

function validSettlement(settlement: SettlementInput): boolean {
  switch (settlement.kind) {
    case "confirmed":
      return commandKindValues.has(settlement.commandKind);
    case "rejected":
      return ERROR_CODE_PATTERN.test(settlement.code);
    case "cancelled":
      return true;
  }
}

function commandKindMatchesOperation(
  operation: string,
  commandKind: string,
): boolean {
  return commandKind === operation ||
    (
      operation === "task.create" &&
      commandKind === "task.create_and_run"
    );
}

function validSettlementForOperation(
  operation: string,
  settlement: SettlementInput,
): boolean {
  return validSettlement(settlement) &&
    (
      settlement.kind !== "confirmed" ||
      commandKindMatchesOperation(operation, settlement.commandKind)
    );
}

function sameOptionalString(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right;
}

function recordFromDoc(
  record: Extract<AttemptDoc, { state: "prepared" }>,
): PreparedRecordValue;
function recordFromDoc(record: OpenAttemptDoc): OpenAttemptRecordValue;
function recordFromDoc(record: AttemptDoc): AttemptRecordValue;
function recordFromDoc(record: AttemptDoc): AttemptRecordValue {
  const base = {
    attemptId: hraOperationIdFromLegacyHostedMutationRecord(record),
    fingerprint: record.fingerprint,
    operation: record.operation,
    sourceId: record.sourceId,
    preparedAtMs: record.preparedAt,
    fingerprintKeyVersion: record.fingerprintKeyVersion,
    workspaceId: record.workspacePublicId,
    recovery: {
      idempotencyKey: record.idempotencyKey,
      hraOperationId: hraOperationIdFromLegacyHostedMutationRecord(record),
      suppliedTaskId: record.suppliedTaskId,
      ...(record.targetTaskId === undefined
        ? {}
        : { targetTaskId: record.targetTaskId }),
    },
  };
  switch (record.state) {
    case "prepared":
      return { ...base, state: record.state, revision: record.revision };
    case "effect-started":
      return {
        ...base,
        state: record.state,
        revision: record.revision,
        effectStartedAtMs: record.effectStartedAt,
      };
    case "settled": {
      const settlement = record.settlement;
      const outcome = settlement.kind === "confirmed"
        ? {
            status: "confirmed" as const,
            attemptId: hraOperationIdFromLegacyHostedMutationRecord(record),
            value: {
              kind: "committed" as const,
              commandKind: settlement.commandKind,
            },
          }
        : settlement.kind === "rejected"
          ? {
              status: "rejected" as const,
              attemptId: hraOperationIdFromLegacyHostedMutationRecord(record),
              error: {
                code: settlement.code,
                message: "The hosted mutation was rejected.",
                retryable: settlement.retryable,
              },
            }
          : settlement.kind === "cancelled"
            ? {
              status: "cancelled" as const,
              attemptId: hraOperationIdFromLegacyHostedMutationRecord(record),
              reason: settlement.reason,
            }
            : {
                status: "rejected" as const,
                attemptId: hraOperationIdFromLegacyHostedMutationRecord(record),
                error: {
                  code: "MUTATION_OUTCOME_UNKNOWN",
                  message:
                    "The hosted mutation was quarantined without a definitive outcome.",
                  retryable: false,
                },
              };
      return {
        ...base,
        state: record.state,
        revision: record.revision,
        effectStartedAtMs: record.effectStartedAt ?? null,
        settledAtMs: record.settledAt,
        outcome,
      };
    }
  }
}

function recordMatchesScope(
  record: AttemptDoc,
  scope: AuthorizedScope,
): boolean {
  return record.organizationId === scope.organizationId &&
    record.workspaceId === scope.workspaceId &&
    record.workspacePublicId === scope.workspacePublicId &&
    record.principalId === scope.principalId;
}

async function authorizeScope(
  ctx: ReadCtx,
  workspacePublicId: string,
  requestId: string,
) {
  const authorized = await authorizeWorkspaceHuman(ctx, {
    workspacePublicId,
    requestId,
  });
  if (!authorized.ok) return authorized;
  return {
    ok: true as const,
    scope: {
      organizationId: authorized.authorization.organization._id,
      principalId: authorized.authorization.user._id,
      workspaceId: authorized.authorization.workspace._id,
      workspacePublicId: authorized.authorization.workspace.publicId,
    },
  };
}

async function attemptById(
  ctx: ReadCtx,
  scope: AuthorizedScope,
  attemptId: string,
): Promise<AttemptDoc | null | "corrupt"> {
  const rows = await ctx.db
    .query("hostedMutationAttempts")
    .withIndex(LEGACY_HOSTED_MUTATION_OPERATION_ID_INDEX, (index) =>
      index
        .eq("principalId", scope.principalId)
        .eq("workspaceId", scope.workspaceId)
        .eq(LEGACY_HOSTED_MUTATION_OPERATION_ID_FIELD, attemptId),
    )
    .take(2);
  if (rows.length > 1) return "corrupt";
  const row = rows[0] ?? null;
  return row === null || recordMatchesScope(row, scope) ? row : "corrupt";
}

async function idempotencyCollision(
  ctx: ReadCtx,
  scope: AuthorizedScope,
  idempotencyKey: string,
): Promise<AttemptDoc | null | "corrupt"> {
  const rows = await ctx.db
    .query("hostedMutationAttempts")
    .withIndex("by_principal_workspace_idempotency", (index) =>
      index
        .eq("principalId", scope.principalId)
        .eq("workspaceId", scope.workspaceId)
        .eq("idempotencyKey", idempotencyKey),
    )
    .take(2);
  if (rows.length > 1) return "corrupt";
  const row = rows[0] ?? null;
  return row === null || recordMatchesScope(row, scope) ? row : "corrupt";
}

async function openFingerprintAttempt(
  ctx: ReadCtx,
  scope: AuthorizedScope,
  sourceId: string,
  candidates: readonly OpaqueHostedMutationFingerprint[],
): Promise<OpenAttemptDoc | null | "corrupt"> {
  const pages = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    rows: await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_scope_fingerprint_open", (index) =>
        index
          .eq("principalId", scope.principalId)
          .eq("workspaceId", scope.workspaceId)
          .eq("sourceId", sourceId)
          .eq("fingerprint", candidate.fingerprint)
          .eq("open", true),
      )
      .take(2),
  })));
  if (pages.some(({ rows }) => rows.length > 1)) return "corrupt";
  const matches = pages.flatMap(({ candidate, rows }) =>
    rows.map((row) => ({ candidate, row }))
  );
  if (matches.length > 1) return "corrupt";
  const match = matches[0] ?? null;
  const row = match?.row ?? null;
  return row === null
      ? null
      : recordMatchesScope(row, scope) &&
          match !== null &&
          row.open
          && row.sourceId === sourceId
          && row.fingerprint === match.candidate.fingerprint
          && row.fingerprintKeyVersion ===
            match.candidate.fingerprintKeyVersion
          && OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(row.fingerprint)
        ? row
        : "corrupt";
}

async function openAttemptCountAtCapacity(
  ctx: ReadCtx,
  scope: AuthorizedScope,
): Promise<boolean | "corrupt"> {
  let count = 0;
  let afterOrderKey: string | null = null;
  while (count < MAX_OPEN_ATTEMPTS_PER_SCOPE) {
    const limit = Math.min(
      MAX_LIST_PAGE_SIZE,
      MAX_OPEN_ATTEMPTS_PER_SCOPE - count,
    );
    const rows = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_principal_workspace_open_order", (index) => {
        const scoped = index
          .eq("principalId", scope.principalId)
          .eq("workspaceId", scope.workspaceId)
          .eq("open", true);
        return afterOrderKey === null
          ? scoped
          : scoped.gt("orderKey", afterOrderKey);
      })
      .order("asc")
      .take(limit);
    if (
      rows.some((row) =>
        !recordMatchesScope(row, scope) ||
        !row.open ||
        !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(row.fingerprint)
      )
    ) {
      return "corrupt";
    }
    count += rows.length;
    if (count >= MAX_OPEN_ATTEMPTS_PER_SCOPE) return true;
    if (rows.length < limit) return false;
    afterOrderKey = rows.at(-1)?.orderKey ?? null;
    if (afterOrderKey === null) return false;
  }
  return true;
}

async function unsupportedOpenLocusAttempt(
  ctx: ReadCtx,
  scope: AuthorizedScope,
  args: Readonly<{
    operation: string;
    supportedKeyVersions: ReadonlySet<string>;
    targetTaskId?: string;
  }>,
): Promise<OpenAttemptDoc | null | "corrupt"> {
  let afterOrderKey: string | null = null;
  for (
    let count = 0;
    count < MAX_OPEN_ATTEMPTS_PER_SCOPE;
    count += MAX_LIST_PAGE_SIZE
  ) {
    const rows = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_principal_workspace_open_order", (index) => {
        const scoped = index
          .eq("principalId", scope.principalId)
          .eq("workspaceId", scope.workspaceId)
          .eq("open", true);
        return afterOrderKey === null
          ? scoped
          : scoped.gt("orderKey", afterOrderKey);
      })
      .order("asc")
      .take(MAX_LIST_PAGE_SIZE);
    const openRows = rows.filter(
      (row): row is OpenAttemptDoc => row.open,
    );
    if (
      openRows.length !== rows.length ||
      openRows.some((row) =>
        !recordMatchesScope(row, scope) ||
        !validSourceId(row.sourceId) ||
        !validOperation(row.operation) ||
        !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(row.fingerprint)
      )
    ) {
      return "corrupt";
    }
    const collision = openRows.find((row) =>
      !args.supportedKeyVersions.has(row.fingerprintKeyVersion) &&
      row.operation === args.operation &&
      sameOptionalString(row.targetTaskId, args.targetTaskId)
    );
    if (collision !== undefined) return collision;
    if (rows.length < MAX_LIST_PAGE_SIZE) return null;
    afterOrderKey = rows.at(-1)?.orderKey ?? null;
    if (afterOrderKey === null) return null;
  }
  return null;
}

function invalidRequest(requestId: string) {
  return domainFailure("VALIDATION_ERROR", requestId);
}

async function consumeJournalRateLimit(
  ctx: MutationCtx,
  scope: AuthorizedScope,
  requestId: string,
) {
  const consumed = await consumeAuthorizedHumanRateLimit(ctx, {
    userId: scope.principalId,
    workspaceId: scope.workspaceId,
    routeClass: "human_mutation",
    requestId,
  });
  if (consumed.kind === "allowed") return null;
  return consumed.kind === "limited"
    ? domainFailure("RATE_LIMITED", requestId, {
        retryAfterMs: consumed.retryAfterMs,
      })
    : domainFailure("SERVICE_UNAVAILABLE", requestId);
}

export const prepare = mutation({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    operation: v.string(),
    fingerprint: v.string(),
    fingerprintKeyVersion: v.string(),
    prepareProof: v.string(),
    idempotencyKey: v.string(),
    hraOperationId: v.string(),
    suppliedTaskId: v.string(),
    targetTaskId: v.optional(v.string()),
  },
  returns: prepareResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validSourceId(args.sourceId) ||
      !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(args.fingerprint) ||
      !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(args.prepareProof) ||
      !validOperation(args.operation) ||
      !validRecovery(args)
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const { scope } = authorized;
    const rateLimit = await consumeJournalRateLimit(ctx, scope, requestId);
    if (rateLimit !== null) return rateLimit;
    const keyring = parseHostedMutationFingerprintKeyring(env);
    if (keyring === null) {
      return domainFailure("SERVICE_UNAVAILABLE", requestId);
    }
    const fingerprintKey =
      keyring.current.version === args.fingerprintKeyVersion
        ? keyring.current
        : keyring.previous?.version === args.fingerprintKeyVersion
          ? keyring.previous
          : null;
    let validPrepareProof = false;
    if (fingerprintKey !== null) {
      try {
        validPrepareProof = await verifyHostedMutationPrepareProof(
          fingerprintKey,
          fingerprintScope(scope, args.sourceId),
          args.fingerprint,
          args.prepareProof,
        );
      } catch {
        validPrepareProof = false;
      }
    }
    if (
      fingerprintKey === null ||
      !validPrepareProof
    ) {
      return invalidRequest(requestId);
    }
    const suppliedFingerprint = {
      fingerprint: args.fingerprint,
      fingerprintKeyVersion: args.fingerprintKeyVersion,
    };

    const matching = await openFingerprintAttempt(
      ctx,
      scope,
      args.sourceId,
      [suppliedFingerprint],
    );
    if (matching === "corrupt") {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    if (matching !== null) {
      const semanticMatch = matching.operation === args.operation &&
        sameOptionalString(matching.targetTaskId, args.targetTaskId) &&
        matching.fingerprint === suppliedFingerprint.fingerprint &&
        matching.fingerprintKeyVersion ===
          suppliedFingerprint.fingerprintKeyVersion;
      return {
        ok: true as const,
        data: semanticMatch
          ? { status: "existing" as const, record: recordFromDoc(matching) }
          : { status: "collision" as const, current: recordFromDoc(matching) },
        requestId,
      };
    }

    const [byAttempt, byIdempotency] = await Promise.all([
      attemptById(ctx, scope, args.hraOperationId),
      idempotencyCollision(ctx, scope, args.idempotencyKey),
    ]);
    if (byAttempt === "corrupt" || byIdempotency === "corrupt") {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    const collision = byAttempt ?? byIdempotency;
    if (collision !== null) {
      return {
        ok: true as const,
        data: {
          status: "collision" as const,
          current: recordFromDoc(collision),
        },
        requestId,
      };
    }
    const atCapacity = await openAttemptCountAtCapacity(
      ctx,
      scope,
    );
    if (atCapacity === "corrupt") {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    if (atCapacity) {
      return {
        ok: true as const,
        data: { status: "capacity" as const },
        requestId,
      };
    }

    const supportedKeyVersions = new Set([
      keyring.current.version,
      ...(keyring.previous === null ? [] : [keyring.previous.version]),
    ]);
    const unsupportedLocus = await unsupportedOpenLocusAttempt(ctx, scope, {
      operation: args.operation,
      supportedKeyVersions,
      ...(args.targetTaskId === undefined
        ? {}
        : { targetTaskId: args.targetTaskId }),
    });
    if (unsupportedLocus === "corrupt") {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    if (unsupportedLocus !== null) {
      return {
        ok: true as const,
        data: {
          status: "collision" as const,
          current: recordFromDoc(unsupportedLocus),
        },
        requestId,
      };
    }

    if (fingerprintKey.version !== keyring.current.version) {
      return invalidRequest(requestId);
    }
    const preparedAt = Date.now();
    const id = await ctx.db.insert("hostedMutationAttempts", {
      ...scope,
      sourceId: args.sourceId,
      operation: args.operation,
      fingerprint: suppliedFingerprint.fingerprint,
      fingerprintKeyVersion: suppliedFingerprint.fingerprintKeyVersion,
      idempotencyKey: args.idempotencyKey,
      ...legacyHostedMutationOperationIdFields(args.hraOperationId),
      suppliedTaskId: args.suppliedTaskId,
      ...(args.targetTaskId === undefined
        ? {}
        : { targetTaskId: args.targetTaskId }),
      state: "prepared",
      open: true,
      revision: 1,
      preparedAt,
      orderKey: attemptOrderKey(preparedAt, args.hraOperationId),
    });
    const record = await ctx.db.get(id);
    if (record === null || record.state !== "prepared") {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    return {
      ok: true as const,
      data: { status: "created" as const, record: recordFromDoc(record) },
      requestId,
    };
  },
});

export const resolveFingerprint = mutation({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    clientFingerprint: v.string(),
  },
  returns: resolveFingerprintResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validSourceId(args.sourceId) ||
      !validClientFingerprint(args.clientFingerprint)
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const rateLimit = await consumeJournalRateLimit(
      ctx,
      authorized.scope,
      requestId,
    );
    if (rateLimit !== null) return rateLimit;
    const keyring = parseHostedMutationFingerprintKeyring(env);
    if (keyring === null) {
      return domainFailure("SERVICE_UNAVAILABLE", requestId);
    }
    const candidates = await scopedFingerprintCandidates(
      keyring,
      authorized.scope,
      args.sourceId,
      args.clientFingerprint,
    );
    if (candidates === null) {
      return domainFailure("SERVICE_UNAVAILABLE", requestId);
    }
    const record = await openFingerprintAttempt(
      ctx,
      authorized.scope,
      args.sourceId,
      candidates,
    );
    if (record === "corrupt") {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    const resolved = record === null
      ? candidates[0]
      : {
          fingerprint: record.fingerprint,
          fingerprintKeyVersion: record.fingerprintKeyVersion,
        };
    if (resolved === undefined) {
      return domainFailure("SERVICE_UNAVAILABLE", requestId);
    }
    const fingerprintKey =
      keyring.current.version === resolved.fingerprintKeyVersion
        ? keyring.current
        : keyring.previous?.version === resolved.fingerprintKeyVersion
          ? keyring.previous
          : null;
    if (fingerprintKey === null) {
      return domainFailure("SERVICE_UNAVAILABLE", requestId);
    }
    let prepareProof: string;
    try {
      prepareProof = await hostedMutationPrepareProof(
        fingerprintKey,
        fingerprintScope(authorized.scope, args.sourceId),
        resolved.fingerprint,
      );
    } catch {
      return domainFailure("SERVICE_UNAVAILABLE", requestId);
    }
    return {
      ok: true as const,
      data: { ...resolved, prepareProof },
      requestId,
    };
  },
});

export const markEffectStarted = mutation({
  args: {
    workspaceId: v.string(),
    attemptId: v.string(),
    expectedRevision: v.number(),
    sourceId: v.string(),
  },
  returns: transitionResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validSourceId(args.sourceId) ||
      !operationIdSchema.safeParse(args.attemptId).success ||
      !validRevision(args.expectedRevision)
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const rateLimit = await consumeJournalRateLimit(
      ctx,
      authorized.scope,
      requestId,
    );
    if (rateLimit !== null) return rateLimit;
    const record = await attemptById(ctx, authorized.scope, args.attemptId);
    if (record === "corrupt") return domainFailure("INTERNAL_ERROR", requestId);
    if (record === null || record.sourceId !== args.sourceId) {
      return {
        ok: true as const,
        data: { status: "missing" as const },
        requestId,
      };
    }
    if (record.state !== "prepared") {
      return {
        ok: true as const,
        data: {
          status: record.revision === args.expectedRevision
            ? "invalid-transition" as const
            : "conflict" as const,
          current: recordFromDoc(record),
        },
        requestId,
      };
    }
    if (record.revision !== args.expectedRevision) {
      return {
        ok: true as const,
        data: {
          status: "conflict" as const,
          current: recordFromDoc(record),
        },
        requestId,
      };
    }
    const effectStartedAt = Date.now();
    await ctx.db.replace(record._id, {
      organizationId: record.organizationId,
      workspaceId: record.workspaceId,
      workspacePublicId: record.workspacePublicId,
      principalId: record.principalId,
      sourceId: record.sourceId,
      operation: record.operation,
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      idempotencyKey: record.idempotencyKey,
      ...legacyHostedMutationOperationIdFields(
        hraOperationIdFromLegacyHostedMutationRecord(record),
      ),
      suppliedTaskId: record.suppliedTaskId,
      ...(record.targetTaskId === undefined
        ? {}
        : { targetTaskId: record.targetTaskId }),
      state: "effect-started",
      open: true,
      revision: 2,
      preparedAt: record.preparedAt,
      orderKey: record.orderKey,
      effectStartedAt,
    });
    const updated = await ctx.db.get(record._id);
    if (updated === null) return domainFailure("INTERNAL_ERROR", requestId);
    return {
      ok: true as const,
      data: { status: "applied" as const, record: recordFromDoc(updated) },
      requestId,
    };
  },
});

async function replaceWithSettlement(
  ctx: MutationCtx,
  record: OpenAttemptDoc,
  settlement: PersistedSettlement,
  settledAt: number,
  receiptId?: Id<"humanCommandReceipts">,
): Promise<AttemptDoc | null> {
  if (
    settlement.kind === "confirmed" &&
    (
      record.state !== "effect-started" ||
      receiptId === undefined
    )
  ) {
    throw new Error(
      "Confirmed hosted mutation settlement requires a linked receipt.",
    );
  }
  const retireAt = settledAt + (
    settlement.kind === "quarantined"
      ? QUARANTINED_TOMBSTONE_RETENTION_MS
      : SETTLED_TOMBSTONE_RETENTION_MS
  );
  const retainedReceiptId = receiptId ??
    (record.state === "effect-started" ? record.receiptId : undefined);
  if (retainedReceiptId !== undefined) {
    const receipt = await ctx.db.get(retainedReceiptId);
    if (receipt !== null && receipt.expiresAt < retireAt) {
      await ctx.db.patch(receipt._id, { expiresAt: retireAt });
    }
  }
  await ctx.db.replace(record._id, {
    organizationId: record.organizationId,
    workspaceId: record.workspaceId,
    workspacePublicId: record.workspacePublicId,
    principalId: record.principalId,
    sourceId: record.sourceId,
    operation: record.operation,
    fingerprint: record.fingerprint,
    fingerprintKeyVersion: record.fingerprintKeyVersion,
    idempotencyKey: record.idempotencyKey,
    ...legacyHostedMutationOperationIdFields(
      hraOperationIdFromLegacyHostedMutationRecord(record),
    ),
    suppliedTaskId: record.suppliedTaskId,
    ...(record.targetTaskId === undefined
      ? {}
      : { targetTaskId: record.targetTaskId }),
    state: "settled",
    open: false,
    revision: record.state === "prepared" ? 2 : 3,
    preparedAt: record.preparedAt,
    orderKey: record.orderKey,
    ...(record.state === "effect-started"
      ? {
          effectStartedAt: record.effectStartedAt,
          ...(receiptId === undefined
            ? record.receiptId === undefined
              ? {}
              : { receiptId: record.receiptId }
            : { receiptId }),
        }
      : {}),
    settledAt,
    retireAt,
    settlement,
  });
  return await ctx.db.get(record._id);
}

export const settle = mutation({
  args: {
    workspaceId: v.string(),
    attemptId: v.string(),
    expectedRevision: v.number(),
    operation: v.string(),
    sourceId: v.string(),
    settlement: settlementInputValidator,
  },
  returns: transitionResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validSourceId(args.sourceId) ||
      !operationIdSchema.safeParse(args.attemptId).success ||
      !validRevision(args.expectedRevision) ||
      !validOperation(args.operation) ||
      !validSettlementForOperation(args.operation, args.settlement)
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const rateLimit = await consumeJournalRateLimit(
      ctx,
      authorized.scope,
      requestId,
    );
    if (rateLimit !== null) return rateLimit;
    const record = await attemptById(ctx, authorized.scope, args.attemptId);
    if (record === "corrupt") return domainFailure("INTERNAL_ERROR", requestId);
    if (record === null || record.sourceId !== args.sourceId) {
      return {
        ok: true as const,
        data: { status: "missing" as const },
        requestId,
      };
    }
    if (record.revision !== args.expectedRevision) {
      return {
        ok: true as const,
        data: {
          status: "conflict" as const,
          current: recordFromDoc(record),
        },
        requestId,
      };
    }
    if (record.operation !== args.operation) {
      return {
        ok: true as const,
        data: {
          status: "invalid-transition" as const,
          current: recordFromDoc(record),
        },
        requestId,
      };
    }
    if (
      record.state === "settled" ||
      (
        record.state === "prepared" &&
        args.settlement.kind === "confirmed"
      )
    ) {
      return {
        ok: true as const,
        data: {
          status: "invalid-transition" as const,
          current: recordFromDoc(record),
        },
        requestId,
      };
    }
    let settlement: PersistedSettlement = args.settlement;
    let receiptId: Id<"humanCommandReceipts"> | undefined;
    if (record.state === "effect-started") {
      const receipt = await authoritativeReceiptState(ctx, record);
      if (receipt.kind === "corrupt" || receipt.kind === "unlinked") {
        return domainFailure("INTERNAL_ERROR", requestId);
      }
      const permitted =
        receipt.kind === "present"
          ? args.settlement.kind === "confirmed" &&
            args.settlement.commandKind === receipt.commandKind
          : args.settlement.kind !== "confirmed";
      if (!permitted) {
        return {
          ok: true as const,
          data: {
            status: "invalid-transition" as const,
            current: recordFromDoc(record),
          },
          requestId,
        };
      }
      if (receipt.kind === "present") {
        receiptId = receipt.receiptId;
        settlement = {
          kind: "confirmed",
          commandKind: receipt.commandKind,
        };
      }
    }
    const settledAt = Date.now();
    const updated = await replaceWithSettlement(
      ctx,
      record,
      settlement,
      settledAt,
      receiptId,
    );
    if (updated === null) return domainFailure("INTERNAL_ERROR", requestId);
    return {
      ok: true as const,
      data: { status: "applied" as const, record: recordFromDoc(updated) },
      requestId,
    };
  },
});

/**
 * Reconciles journal rows without recovering their intentionally absent raw
 * intent. Prepared rows cannot have entered a command. Effect-started rows are
 * cancelled only when this transaction proves receipt absence. Exact linked
 * receipts remain open for semantic endpoint replay followed by model
 * acknowledgement; malformed or unlinked evidence remains blocked.
 */
export const reconcileOpenPage = mutation({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    after: v.union(v.null(), cursorValidator),
    limit: v.number(),
  },
  returns: reconcileResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validSourceId(args.sourceId) ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > MAX_LIST_PAGE_SIZE ||
      (
        args.after !== null &&
        (
          !validEpoch(args.after.preparedAtMs) ||
          !operationIdSchema.safeParse(args.after.attemptId).success
        )
      )
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const rateLimit = await consumeJournalRateLimit(
      ctx,
      authorized.scope,
      requestId,
    );
    if (rateLimit !== null) return rateLimit;
    const afterKey = args.after === null
      ? null
      : attemptOrderKey(args.after.preparedAtMs, args.after.attemptId);
    const rows = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_scope_open_order", (index) => {
        const scoped = index
          .eq("principalId", authorized.scope.principalId)
          .eq("workspaceId", authorized.scope.workspaceId)
          .eq("sourceId", args.sourceId)
          .eq("open", true);
        return afterKey === null
          ? scoped
          : scoped.gt("orderKey", afterKey);
      })
      .order("asc")
      .take(args.limit);
    const openRows = rows.filter(
      (row): row is OpenAttemptDoc => row.open,
    );
    if (
      openRows.length !== rows.length ||
      openRows.some((row) =>
        !recordMatchesScope(row, authorized.scope) ||
        row.sourceId !== args.sourceId
      )
    ) {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    let blocked = 0;
    let reconciled = 0;
    let pendingReceipts = 0;
    const now = Date.now();
    for (const record of openRows) {
      if (record.state === "prepared") {
        await replaceWithSettlement(ctx, record, {
          kind: "cancelled",
          reason: "superseded",
        }, now);
        reconciled += 1;
        continue;
      }
      const receipt = await authoritativeReceiptState(ctx, record);
      if (receipt.kind === "present") {
        pendingReceipts += 1;
      } else if (receipt.kind === "absent") {
        await replaceWithSettlement(ctx, record, {
          kind: "cancelled",
          reason: "superseded",
        }, now);
        reconciled += 1;
      } else {
        blocked += 1;
      }
    }
    const last = rows.at(-1);
    const later = last === undefined
      ? null
      : await ctx.db
          .query("hostedMutationAttempts")
          .withIndex("by_scope_open_order", (index) =>
            index
              .eq("principalId", authorized.scope.principalId)
              .eq("workspaceId", authorized.scope.workspaceId)
              .eq("sourceId", args.sourceId)
              .eq("open", true)
              .gt("orderKey", last.orderKey),
          )
          .first();
    const hasMore = later !== null;
    return {
      ok: true as const,
      data: {
        blocked,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? {
              preparedAtMs: last.preparedAt,
              attemptId: hraOperationIdFromLegacyHostedMutationRecord(last),
            }
          : null,
        pendingReceipts,
        reconciled,
      },
      requestId,
    };
  },
});

export const get = query({
  args: {
    workspaceId: v.string(),
    attemptId: v.string(),
    sourceId: v.string(),
  },
  returns: getResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !operationIdSchema.safeParse(args.attemptId).success ||
      !validSourceId(args.sourceId)
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const record = await attemptById(ctx, authorized.scope, args.attemptId);
    if (record === "corrupt") return domainFailure("INTERNAL_ERROR", requestId);
    return {
      ok: true as const,
      data: record === null || record.sourceId !== args.sourceId
        ? null
        : recordFromDoc(record),
      requestId,
    };
  },
});

export const listOpen = query({
  args: {
    workspaceId: v.string(),
    sourceId: v.union(v.null(), v.string()),
    after: v.union(v.null(), cursorValidator),
    limit: v.number(),
  },
  returns: listResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      (
        args.sourceId !== null &&
        !validSourceId(args.sourceId)
      ) ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > MAX_LIST_PAGE_SIZE ||
      (
        args.after !== null &&
        (
          !validEpoch(args.after.preparedAtMs) ||
          !operationIdSchema.safeParse(args.after.attemptId).success
        )
      )
    ) {
      return invalidRequest(requestId);
    }
    const authorized = await authorizeScope(ctx, args.workspaceId, requestId);
    if (!authorized.ok) return authorized;
    const { scope } = authorized;
    const afterKey = args.after === null
      ? null
      : attemptOrderKey(args.after.preparedAtMs, args.after.attemptId);

    const rows = args.sourceId === null
      ? await ctx.db
          .query("hostedMutationAttempts")
          .withIndex("by_principal_workspace_open_order", (index) => {
            const scoped = index
              .eq("principalId", scope.principalId)
              .eq("workspaceId", scope.workspaceId)
              .eq("open", true);
            return afterKey === null
              ? scoped
              : scoped.gt("orderKey", afterKey);
          })
          .order("asc")
          .take(args.limit)
      : await ctx.db
          .query("hostedMutationAttempts")
          .withIndex("by_scope_open_order", (index) => {
            const scoped = index
              .eq("principalId", scope.principalId)
              .eq("workspaceId", scope.workspaceId)
              .eq("sourceId", args.sourceId ?? "")
              .eq("open", true);
            return afterKey === null
              ? scoped
              : scoped.gt("orderKey", afterKey);
          })
          .order("asc")
          .take(args.limit);
    const openRows = rows.filter(
      (row): row is OpenAttemptDoc => row.open,
    );
    if (
      openRows.length !== rows.length ||
      openRows.some((row) =>
        !recordMatchesScope(row, scope) ||
        (args.sourceId !== null && row.sourceId !== args.sourceId)
      )
    ) {
      return domainFailure("INTERNAL_ERROR", requestId);
    }
    const last = rows.at(-1);
    let hasMore = false;
    if (last !== undefined) {
      const later = args.sourceId === null
        ? await ctx.db
            .query("hostedMutationAttempts")
            .withIndex("by_principal_workspace_open_order", (index) =>
              index
                .eq("principalId", scope.principalId)
                .eq("workspaceId", scope.workspaceId)
                .eq("open", true)
                .gt("orderKey", last.orderKey),
            )
            .first()
        : await ctx.db
            .query("hostedMutationAttempts")
            .withIndex("by_scope_open_order", (index) =>
              index
                .eq("principalId", scope.principalId)
                .eq("workspaceId", scope.workspaceId)
                .eq("sourceId", args.sourceId ?? "")
                .eq("open", true)
                .gt("orderKey", last.orderKey),
            )
            .first();
      hasMore = later !== null;
    }
    const nextCursor = hasMore && last !== undefined
      ? {
          preparedAtMs: last.preparedAt,
          attemptId: hraOperationIdFromLegacyHostedMutationRecord(last),
        }
      : null;
    return {
      ok: true as const,
      data: {
        attempts: openRows.map((row) => recordFromDoc(row)),
        nextCursor,
        hasMore,
      },
      requestId,
    };
  },
});

const maintenanceResultValidator = v.object({
  processed: v.number(),
  scheduled: v.boolean(),
});

export const fingerprintKeyRetirementGate = internalQuery({
  args: { keyVersion: v.string() },
  returns: v.object({
    canRetire: v.boolean(),
    openAttemptsAtLeast: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!FINGERPRINT_KEY_VERSION_PATTERN.test(args.keyVersion)) {
      throw new Error("Hosted mutation fingerprint key version is invalid.");
    }
    const open = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_fingerprint_key_version_open", (index) =>
        index
          .eq("fingerprintKeyVersion", args.keyVersion)
          .eq("open", true),
      )
      .first();
    return {
      canRetire: open === null,
      openAttemptsAtLeast: open === null ? 0 : 1,
    };
  },
});

/**
 * A permanently abandoned open attempt cannot pin a rotation key forever.
 * After the recovery horizon, linked receipts become confirmed audit rows,
 * absent receipts become cancelled rows, and ambiguous legacy evidence is
 * explicitly quarantined rather than guessed.
 */
export const sweepStaleOpenAttempts = internalMutation({
  args: {},
  returns: maintenanceResultValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - OPEN_ATTEMPT_RECOVERY_RETENTION_MS;
    const rows = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_open_order", (index) => index.eq("open", true))
      .order("asc")
      .take(SETTLED_TOMBSTONE_SWEEP_BATCH_SIZE);
    const stale = rows.filter(
      (row): row is OpenAttemptDoc =>
        row.open && row.preparedAt <= cutoff,
    );
    for (const record of stale) {
      if (record.state === "prepared") {
        await replaceWithSettlement(ctx, record, {
          kind: "cancelled",
          reason: "superseded",
        }, now);
        continue;
      }
      const receipt = await authoritativeReceiptState(ctx, record);
      if (receipt.kind === "present") {
        await replaceWithSettlement(ctx, record, {
          kind: "confirmed",
          commandKind: receipt.commandKind,
        }, now, receipt.receiptId);
      } else if (receipt.kind === "absent") {
        await replaceWithSettlement(ctx, record, {
          kind: "cancelled",
          reason: "superseded",
        }, now);
      } else {
        await replaceWithSettlement(ctx, record, {
          kind: "quarantined",
          reason: receipt.kind === "unlinked"
            ? "expired-unack"
            : "invalid-receipt",
        }, now);
      }
    }
    const next = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_open_order", (index) => index.eq("open", true))
      .order("asc")
      .first();
    const scheduled = next !== null && next.preparedAt <= cutoff;
    if (scheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.hostedMutationAttempts.sweepStaleOpenAttempts,
        {},
      );
    }
    return { processed: stale.length, scheduled };
  },
});

export const sweepSettledTombstones = internalMutation({
  args: {},
  returns: maintenanceResultValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("hostedMutationAttempts")
      .withIndex("by_open_and_retire", (index) =>
        index
          .eq("open", false)
          .gte("retireAt", 0)
          .lte("retireAt", now),
      )
      .order("asc")
      .take(SETTLED_TOMBSTONE_SWEEP_BATCH_SIZE);
    let processed = 0;
    for (const record of rows) {
      if (
        record.state !== "settled" ||
        record.open ||
        record.retireAt === undefined ||
        record.retireAt > now
      ) {
        continue;
      }
      if (
        record.settlement.kind === "confirmed" &&
        record.receiptId !== undefined
      ) {
        const receipt = await authoritativeReceiptState(ctx, record);
        if (
          receipt.kind === "present" &&
          receipt.receiptId === record.receiptId
        ) {
          await ctx.db.delete(record.receiptId);
        }
      }
      await ctx.db.delete(record._id);
      processed += 1;
    }
    const scheduled =
      processed > 0 &&
      rows.length === SETTLED_TOMBSTONE_SWEEP_BATCH_SIZE;
    if (scheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.hostedMutationAttempts.sweepSettledTombstones,
        {},
      );
    }
    return { processed, scheduled };
  },
});

export const hostedMutationAttemptLimits = Object.freeze({
  listPageSize: MAX_LIST_PAGE_SIZE,
  openAttemptsPerPrincipalWorkspace: MAX_OPEN_ATTEMPTS_PER_SCOPE,
  openRecoveryRetentionMs: OPEN_ATTEMPT_RECOVERY_RETENTION_MS,
  quarantinedTombstoneRetentionMs: QUARANTINED_TOMBSTONE_RETENTION_MS,
  settledTombstoneRetentionMs: SETTLED_TOMBSTONE_RETENTION_MS,
});
