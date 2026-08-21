import type {
  GenericDataModel,
  GenericDatabaseReader,
  GenericDatabaseWriter,
} from "convex/server";
import { v, type Value } from "convex/values";

import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { receiptOperationsForAttempt } from "./hostedMutationReceiptPolicy";

type PlainDocument = Readonly<Record<string, unknown>>;
type CutoverUser = {
  publicId: string;
  name: string;
  image?: string;
  email?: string;
  emailVerificationTime?: number;
  phone?: string;
  phoneVerificationTime?: number;
  isAnonymous?: boolean;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
};
type CutoverOrganization = {
  publicId: string;
  name: string;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
};
type CutoverMembership = {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  role: "owner" | "admin" | "member";
  status: "active" | "inactive" | "pending" | "removed";
  createdAt: number;
  updatedAt: number;
};
type CutoverPromotionSession = Readonly<Record<string, Value>> & {
  startedByUserPublicId: string;
};

function document(value: unknown): PlainDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Identity cutover encountered a malformed document.");
  }
  return value as PlainDocument;
}

function requiredString(row: PlainDocument, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Identity cutover requires ${key}.`);
  }
  return value;
}

function requiredNumber(row: PlainDocument, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Identity cutover requires ${key}.`);
  }
  return value;
}

function requiredStringArray(row: PlainDocument, key: string): readonly string[] {
  const value = row[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Identity cutover requires ${key}.`);
  }
  return value as readonly string[];
}

function optionalString(row: PlainDocument, key: string) {
  const value = row[key];
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`Identity cutover rejected ${key}.`);
  return { [key]: value };
}

function optionalNumber(row: PlainDocument, key: string) {
  const value = row[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Identity cutover rejected ${key}.`);
  }
  return { [key]: value };
}

function optionalBoolean(row: PlainDocument, key: string) {
  const value = row[key];
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error(`Identity cutover rejected ${key}.`);
  return { [key]: value };
}

function optionalStringValue(row: PlainDocument, key: string): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Identity cutover rejected ${key}.`);
  return value;
}

/** Stable, non-secret representation used to bind exact receipt rewrites. */
export function cutoverRequestDigestToken(value: unknown): string {
  if (typeof value === "string") return `string:${value}`;
  if (value instanceof ArrayBuffer) {
    return `bytes:${Array.from(new Uint8Array(value), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")}`;
  }
  if (ArrayBuffer.isView(value)) {
    return `bytes:${Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  throw new Error("Identity cutover rejected requestDigest.");
}

function canonicalCutoverValue(value: unknown): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return { bytes: cutoverRequestDigestToken(value).slice("bytes:".length) };
  }
  if (Array.isArray(value)) return value.map(canonicalCutoverValue);
  const row = document(value);
  return Object.fromEntries(
    Object.keys(row).sort().flatMap((key) => {
      const field = row[key];
      return field === undefined ? [] : [[key, canonicalCutoverValue(field)]];
    }),
  );
}

async function stableDocumentDigest(
  value: unknown,
  omittedKeys: readonly string[],
): Promise<string> {
  const row: Record<string, unknown> = { ...document(value) };
  delete row._id;
  delete row._creationTime;
  for (const key of omittedKeys) delete row[key];
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonicalCutoverValue(row)),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Produces the final Convex Auth user value for an exact in-place `db.replace`.
 * Callers retain the source document ID and must use that same ID for replace.
 */
export function normalizeCutoverUser(value: unknown): CutoverUser {
  const row = document(value);
  const status = row.status;
  if (status !== "active" && status !== "disabled") {
    throw new Error("Identity cutover rejected an unknown user status.");
  }
  const normalized: CutoverUser = {
    publicId: requiredString(row, "publicId"),
    name: requiredString(row, "name"),
    ...optionalString(row, "image"),
    ...optionalString(row, "email"),
    ...optionalNumber(row, "emailVerificationTime"),
    ...optionalString(row, "phone"),
    ...optionalNumber(row, "phoneVerificationTime"),
    ...optionalBoolean(row, "isAnonymous"),
    status,
    createdAt: requiredNumber(row, "createdAt"),
    updatedAt: requiredNumber(row, "updatedAt"),
  };
  return normalized;
}

/** Provider provisioning failures become disabled tenants for fail-closed cutover. */
export function normalizeCutoverOrganization(value: unknown): CutoverOrganization {
  const row = document(value);
  const previousStatus = row.status;
  if (
    previousStatus !== "active" && previousStatus !== "disabled" &&
    previousStatus !== "provisioning" && previousStatus !== "failed"
  ) throw new Error("Identity cutover rejected an unknown organization status.");
  return {
    publicId: requiredString(row, "publicId"),
    name: requiredString(row, "name"),
    status: previousStatus === "active" ? "active" : "disabled",
    createdAt: requiredNumber(row, "createdAt"),
    updatedAt: requiredNumber(row, "updatedAt"),
  };
}

export function normalizeCutoverMembership(value: unknown): CutoverMembership {
  const row = document(value);
  const role = row.role;
  const status = row.status;
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new Error("Identity cutover rejected an unknown organization role.");
  }
  if (
    status !== "active" && status !== "inactive" &&
    status !== "pending" && status !== "removed"
  ) throw new Error("Identity cutover rejected an unknown membership status.");
  return {
    organizationId: requiredString(row, "organizationId") as Id<"organizations">,
    userId: requiredString(row, "userId") as Id<"users">,
    role,
    status,
    createdAt: requiredNumber(row, "createdAt"),
    updatedAt: requiredNumber(row, "updatedAt"),
  };
}

/**
 * Rewrites only the provider-named promotion actor subject. All session IDs,
 * authority references, manifests, progress, and recovery fields remain exact.
 */
export function normalizeCutoverPromotionSession(
  value: unknown,
  startedByUserPublicId: string,
): CutoverPromotionSession {
  if (startedByUserPublicId.length === 0) {
    throw new Error("Identity cutover requires startedByUserPublicId.");
  }
  const row = document(value);
  const normalized: Record<string, unknown> = { ...row };
  delete normalized._id;
  delete normalized._creationTime;
  delete normalized.startedByWorkosUserId;
  normalized.startedByUserPublicId = startedByUserPublicId;
  return normalized as unknown as CutoverPromotionSession;
}

export const predecessorOnlyIdentityTables = [
  "workosMembershipRetirements",
  "identityWebhookReceipts",
  "identityReconciliationState",
  "identityReconciliationQuarantines",
  "accountProvisioningOperations",
] as const;

const predecessorTableValidator = v.union(
  v.literal("workosMembershipRetirements"),
  v.literal("identityWebhookReceipts"),
  v.literal("identityReconciliationState"),
  v.literal("identityReconciliationQuarantines"),
  v.literal("accountProvisioningOperations"),
);

const authorityTableValidator = v.union(
  v.literal("users"),
  v.literal("organizations"),
  v.literal("organizationMemberships"),
  v.literal("workspaces"),
  v.literal("workspaceMemberships"),
  v.literal("promotionSessions"),
  v.literal("suiteIdentityAliases"),
  v.literal("suiteEntitlementProjections"),
  v.literal("humanCommandReceipts"),
  v.literal("hostedMutationAttempts"),
  v.literal("syncVaults"),
  v.literal("syncSessionEntries"),
  v.literal("syncScheduledChats"),
  v.literal("syncScheduledChatWakes"),
  v.literal("syncScheduledChatRuns"),
);

type AuthorityTable =
  | "users"
  | "organizations"
  | "organizationMemberships"
  | "workspaces"
  | "workspaceMemberships"
  | "promotionSessions"
  | "suiteIdentityAliases"
  | "suiteEntitlementProjections"
  | "humanCommandReceipts"
  | "hostedMutationAttempts"
  | "syncVaults"
  | "syncSessionEntries"
  | "syncScheduledChats"
  | "syncScheduledChatWakes"
  | "syncScheduledChatRuns";

type AttemptReceiptResolution =
  | Readonly<{ kind: "absent"; user?: PlainDocument }>
  | Readonly<{ kind: "ambiguous"; user?: PlainDocument }>
  | Readonly<{
      kind: "exact";
      receipt: PlainDocument;
      user: PlainDocument;
    }>;

type RuntimeDatabaseReader = QueryCtx["db"];

/**
 * Resolves the pre-link crash window without guessing. Both the preserved
 * public subject and the predecessor subject are searched so this produces
 * the same effective binding on either side of the exact receipt rewrite.
 */
async function exactUnlinkedReceiptForAttempt(
  db: RuntimeDatabaseReader,
  attempt: PlainDocument,
): Promise<AttemptReceiptResolution> {
  const principalId = db.normalizeId(
    "users",
    requiredString(attempt, "principalId"),
  );
  const user = principalId === null ? null : await db.get(principalId);
  if (user === null) return { kind: "absent" };
  const userRow = document(user);
  const organizationId = db.normalizeId(
    "organizations",
    requiredString(attempt, "organizationId"),
  );
  if (organizationId === null) return { kind: "ambiguous", user: userRow };
  const subjects = new Set([
    requiredString(userRow, "publicId"),
    optionalStringValue(userRow, "workosUserId"),
  ].filter((value): value is string => value !== undefined));
  const operations = receiptOperationsForAttempt(
    requiredString(attempt, "operation"),
  );
  if (operations.length === 0) return { kind: "ambiguous", user: userRow };
  const matches = new Map<string, PlainDocument>();
  for (const subject of subjects) {
    for (const operation of operations) {
      const candidates = await db.query("humanCommandReceipts")
        .withIndex("by_principal_operation_key", (index) =>
          index
            .eq("principalKind", "organization")
            .eq("principalId", subject)
            .eq("organizationId", organizationId)
            .eq("operation", operation)
            .eq("idempotencyKey", requiredString(attempt, "idempotencyKey")))
        .take(2) as readonly PlainDocument[];
      if (candidates.length > 1) return { kind: "ambiguous", user: userRow };
      for (const candidate of candidates) {
        matches.set(requiredString(document(candidate), "_id"), document(candidate));
      }
    }
  }
  if (matches.size === 0) return { kind: "absent", user: userRow };
  if (matches.size !== 1) return { kind: "ambiguous", user: userRow };
  return { kind: "exact", receipt: [...matches.values()][0]!, user: userRow };
}

async function authorityProjection(
  db: GenericDatabaseReader<GenericDataModel>,
  table: AuthorityTable,
  value: unknown,
): Promise<string> {
  const row = document(value);
  const id = requiredString(row, "_id");
  if (table === "users" || table === "organizations") {
    return JSON.stringify({ id, publicId: requiredString(row, "publicId") });
  }
  if (table === "organizationMemberships") {
    return JSON.stringify({
      id,
      organizationId: requiredString(row, "organizationId"),
      userId: requiredString(row, "userId"),
      role: requiredString(row, "role"),
      status: requiredString(row, "status"),
    });
  }
  if (table === "workspaces") {
    return JSON.stringify({
      id,
      organizationId: requiredString(row, "organizationId"),
      publicId: requiredString(row, "publicId"),
      status: requiredString(row, "status"),
    });
  }
  if (table === "workspaceMemberships") {
    return JSON.stringify({
      id,
      organizationId: requiredString(row, "organizationId"),
      workspaceId: requiredString(row, "workspaceId"),
      userId: requiredString(row, "userId"),
      roles: requiredStringArray(row, "roles"),
      status: requiredString(row, "status"),
    });
  }
  if (table === "promotionSessions") {
    return JSON.stringify({
      id,
      publicId: requiredString(row, "publicId"),
      organizationId: requiredString(row, "organizationId"),
      organizationPublicId: requiredString(row, "organizationPublicId"),
      startedByUserId: requiredString(row, "startedByUserId"),
      authorizationMembershipId: requiredString(row, "authorizationMembershipId"),
      sourceWorkspacePublicId: requiredString(row, "sourceWorkspacePublicId"),
      stagingWorkspaceId: requiredString(row, "stagingWorkspaceId"),
      stagingWorkspacePublicId: requiredString(row, "stagingWorkspacePublicId"),
      manifestRoot: requiredString(row, "manifestRoot"),
      startIdempotencyKey: requiredString(row, "startIdempotencyKey"),
      startRequestDigest: requiredString(row, "startRequestDigest"),
      state: requiredString(row, "state"),
      decisionSequence: requiredNumber(row, "decisionSequence"),
      documentDigest: await stableDocumentDigest(row, [
        "startedByWorkosUserId",
        "startedByUserPublicId",
      ]),
    });
  }
  if (table === "suiteIdentityAliases") {
    return JSON.stringify({
      id,
      environment: requiredString(row, "environment"),
      state: requiredString(row, "state"),
      suiteAccountId: requiredString(row, "suiteAccountId"),
      userId: requiredString(row, "userId"),
      documentDigest: await stableDocumentDigest(row, ["localSubject"]),
    });
  }
  if (table === "suiteEntitlementProjections") {
    return JSON.stringify({
      id,
      catalogRevision: requiredString(row, "catalogRevision"),
      expiresAt: requiredNumber(row, "expiresAt"),
      features: requiredStringArray(row, "features"),
      projectionRevision: requiredNumber(row, "projectionRevision"),
      receiptDigest: requiredString(row, "receiptDigest"),
      suiteAccountId: requiredString(row, "suiteAccountId"),
      userId: requiredString(row, "userId"),
      documentDigest: await stableDocumentDigest(row, ["localSubject"]),
    });
  }
  if (table === "humanCommandReceipts") {
    return JSON.stringify({
      id,
      principalKind: requiredString(row, "principalKind"),
      ...optionalString(row, "organizationId"),
      operation: requiredString(row, "operation"),
      idempotencyKey: requiredString(row, "idempotencyKey"),
      requestDigest: cutoverRequestDigestToken(row.requestDigest),
      requestId: requiredString(row, "requestId"),
      createdAt: requiredNumber(row, "createdAt"),
      expiresAt: requiredNumber(row, "expiresAt"),
      documentDigest: await stableDocumentDigest(row, ["principalId"]),
    });
  }
  if (table === "hostedMutationAttempts") {
    const storedReceiptId = optionalStringValue(row, "receiptId");
    const effectiveReceipt = storedReceiptId !== undefined ||
        row.state !== "effect-started" || row.open !== true
      ? null
        : await exactUnlinkedReceiptForAttempt(
          db as unknown as RuntimeDatabaseReader,
          row,
        );
    const effectiveReceiptId = storedReceiptId ??
      (effectiveReceipt?.kind === "exact"
        ? requiredString(effectiveReceipt.receipt, "_id")
        : undefined);
    return JSON.stringify({
      id,
      organizationId: requiredString(row, "organizationId"),
      workspaceId: requiredString(row, "workspaceId"),
      workspacePublicId: requiredString(row, "workspacePublicId"),
      principalId: requiredString(row, "principalId"),
      sourceId: requiredString(row, "sourceId"),
      operation: requiredString(row, "operation"),
      fingerprint: requiredString(row, "fingerprint"),
      fingerprintKeyVersion: requiredString(row, "fingerprintKeyVersion"),
      idempotencyKey: requiredString(row, "idempotencyKey"),
      state: requiredString(row, "state"),
      ...(effectiveReceiptId === undefined ? {} : { receiptId: effectiveReceiptId }),
      documentDigest: await stableDocumentDigest(row, ["receiptId"]),
    });
  }
  if (table === "syncVaults") {
    return JSON.stringify({
      id,
      organizationId: requiredString(row, "organizationId"),
      ownerUserId: requiredString(row, "ownerUserId"),
      vaultId: requiredString(row, "vaultId"),
      vaultGeneration: requiredString(row, "vaultGeneration"),
      status: requiredString(row, "status"),
    });
  }
  if (table === "syncSessionEntries") {
    return JSON.stringify({
      id,
      vaultId: requiredString(row, "vaultId"),
      sessionId: requiredString(row, "sessionId"),
      originDeviceId: requiredString(row, "originDeviceId"),
    });
  }
  if (table === "syncScheduledChats") {
    return JSON.stringify({
      id,
      vaultId: requiredString(row, "vaultId"),
      sessionEntryId: requiredString(row, "sessionEntryId"),
      originDeviceId: requiredString(row, "originDeviceId"),
      generation: requiredString(row, "generation"),
      state: requiredString(row, "state"),
    });
  }
  if (table === "syncScheduledChatWakes") {
    return JSON.stringify({
      id,
      scheduleId: requiredString(row, "scheduleId"),
      vaultId: requiredString(row, "vaultId"),
      sessionEntryId: requiredString(row, "sessionEntryId"),
      originDeviceId: requiredString(row, "originDeviceId"),
      generation: requiredString(row, "generation"),
      state: requiredString(row, "state"),
    });
  }
  return JSON.stringify({
    id,
    scheduleId: requiredString(row, "scheduleId"),
    vaultId: requiredString(row, "vaultId"),
    sessionEntryId: requiredString(row, "sessionEntryId"),
    originDeviceId: requiredString(row, "originDeviceId"),
    generation: requiredString(row, "generation"),
    state: requiredString(row, "state"),
  });
}

/**
 * Safe, content-blind manifest used before and after cutover. Comparing the
 * complete paginated output proves exact identity, workspace, promotion,
 * suite, receipt-recovery, vault, and schedule authority bindings survived
 * in-place normalization. Subject fields migrated separately are verified by
 * `subjectMismatchPage` and intentionally omitted from these stable bindings.
 */
export const authorityPage = internalQuery({
  args: { table: authorityTableValidator, cursor: v.optional(v.string()) },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    bindings: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const table = args.table as AuthorityTable;
    const db = ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
    const page = await db.query(table).paginate({
      cursor: args.cursor ?? null,
      numItems: 64,
    });
    return {
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      bindings: await Promise.all(
        page.page.map((row) => authorityProjection(db, table, row)),
      ),
    };
  },
});

const LEGACY_KEYS = {
  users: ["workosUserId"],
  organizations: [
    "workosOrganizationId",
    "workosExternalId",
    "failureCode",
    "workosUpdatedAt",
    "workosObservedAt",
    "workosHardDeletedAt",
    "workosQuarantinedAt",
  ],
  organizationMemberships: [
    "workosMembershipId",
    "workosRoleSlugs",
    "workosUpdatedAt",
    "workosObservedAt",
    "workosHardDeletedAt",
    "workosHardDeletedMembershipId",
    "workosQuarantinedAt",
  ],
  promotionSessions: ["startedByWorkosUserId"],
} as const;

/** Returns only exact legacy-shaped identity rows; an empty final scan is required. */
export const legacyShapePage = internalQuery({
  args: {
    table: v.union(
      v.literal("users"),
      v.literal("organizations"),
      v.literal("organizationMemberships"),
      v.literal("promotionSessions"),
    ),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    documentIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const db = ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
    const page = await db.query(args.table).paginate({
      cursor: args.cursor ?? null,
      numItems: 64,
    });
    const documentIds = page.page.flatMap((value) => {
      const row = document(value);
      const hasLegacyKey = LEGACY_KEYS[args.table].some((key) => key in row);
      const invalidOrganizationStatus = args.table === "organizations" &&
        row.status !== "active" && row.status !== "disabled";
      const invalidPromotionActor = args.table === "promotionSessions" &&
        (typeof row.startedByUserPublicId !== "string" ||
          row.startedByUserPublicId.length === 0);
      return hasLegacyKey || invalidOrganizationStatus || invalidPromotionActor
        ? [requiredString(row, "_id")]
        : [];
    });
    return {
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      documentIds,
    };
  },
});

const subjectMigrationTableValidator = v.union(
  v.literal("suiteIdentityAliases"),
  v.literal("suiteEntitlementProjections"),
  v.literal("suiteIdentityLinkChallenges"),
  v.literal("humanCommandReceipts"),
  v.literal("hostedMutationAttempts"),
);

type SubjectMigrationTable =
  | "suiteIdentityAliases"
  | "suiteEntitlementProjections"
  | "suiteIdentityLinkChallenges"
  | "humanCommandReceipts"
  | "hostedMutationAttempts";

const subjectMismatchValidator = v.object({
  table: subjectMigrationTableValidator,
  documentId: v.string(),
  currentSubject: v.string(),
  userId: v.optional(v.string()),
  expectedSubject: v.optional(v.string()),
  receiptId: v.optional(v.string()),
  reason: v.union(
    v.literal("subject_changed"),
    v.literal("missing_user"),
    v.literal("unmapped_subject"),
    v.literal("missing_receipt"),
    v.literal("recovery_binding_changed"),
    v.literal("unlinked_receipt"),
    v.literal("subject_collision"),
  ),
});

async function userRowsBySubject(
  db: GenericDatabaseReader<GenericDataModel>,
  indexName: "by_public_id" | "by_workos_user_id",
  fieldName: "publicId" | "workosUserId",
  subject: string,
): Promise<readonly PlainDocument[]> {
  return await db.query("users")
    .withIndex(indexName, (index) => index.eq(fieldName, subject))
    .take(2) as readonly PlainDocument[];
}

async function subjectNamespaceRows(
  db: GenericDatabaseReader<GenericDataModel>,
  subject: string,
): Promise<Readonly<{
  current: readonly PlainDocument[];
  predecessor: readonly PlainDocument[];
}>> {
  const [current, predecessor] = await Promise.all([
    userRowsBySubject(db, "by_public_id", "publicId", subject),
    userRowsBySubject(db, "by_workos_user_id", "workosUserId", subject),
  ]);
  return { current, predecessor };
}

async function subjectNamespaceCollidesWithUser(
  db: GenericDatabaseReader<GenericDataModel>,
  subject: string,
  expectedUserId: string,
): Promise<boolean> {
  const rows = await subjectNamespaceRows(db, subject);
  return rows.current.length > 1 || rows.predecessor.length > 1 ||
    [...rows.current, ...rows.predecessor].some((value) =>
      requiredString(document(value), "_id") !== expectedUserId);
}

/**
 * Returns every suite or retained receipt subject that is not the referenced
 * Convex user's public ID. Expired receipts retained for an open hosted
 * recovery attempt remain authoritative and are included. Pending suite link
 * proofs are invalidated rather than rewritten; consumed proofs remain history.
 */
export const subjectMismatchPage = internalQuery({
  args: {
    table: subjectMigrationTableValidator,
    cursor: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    mismatches: v.array(subjectMismatchValidator),
  }),
  handler: async (ctx, args) => {
    const table = args.table as SubjectMigrationTable;
    const db = ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
    const page = await db.query(table).paginate({
      cursor: args.cursor ?? null,
      numItems: 64,
    });
    const mismatches: Array<{
      table: SubjectMigrationTable;
      documentId: string;
      currentSubject: string;
      userId?: string;
      expectedSubject?: string;
      receiptId?: string;
      reason: "subject_changed" | "missing_user" | "unmapped_subject" |
        "missing_receipt" | "recovery_binding_changed" | "unlinked_receipt" |
        "subject_collision";
    }> = [];
    if (!Number.isSafeInteger(args.now) || args.now < 0) {
      throw new Error("Identity cutover inventory time is invalid.");
    }
    for (const value of page.page) {
      const row = document(value);
      if (
        table === "suiteIdentityLinkChallenges" && row.state !== "pending"
      ) continue;
      const documentId = requiredString(row, "_id");
      if (table === "hostedMutationAttempts") {
        const storedReceiptId = optionalStringValue(row, "receiptId");
        if (
          storedReceiptId === undefined &&
          (row.state !== "effect-started" || row.open !== true)
        ) continue;
        const userId = requiredString(row, "principalId");
        const normalizedUserId = db.normalizeId("users", userId);
        const user = normalizedUserId === null ? null : await db.get(normalizedUserId);
        if (user === null) {
          mismatches.push({
            table,
            documentId,
            currentSubject: "(missing-user)",
            userId,
            reason: "missing_user",
          });
          continue;
        }
        const expectedSubject = requiredString(document(user), "publicId");
        let receiptId = storedReceiptId;
        let receipt: PlainDocument | null = null;
        if (receiptId === undefined) {
          const resolved = await exactUnlinkedReceiptForAttempt(
            db as unknown as RuntimeDatabaseReader,
            row,
          );
          if (resolved.kind !== "exact") {
            mismatches.push({
              table,
              documentId,
              currentSubject: "(unlinked)",
              userId,
              expectedSubject,
              reason: resolved.kind === "absent"
                ? "missing_receipt"
                : "recovery_binding_changed",
            });
            continue;
          }
          receipt = resolved.receipt;
          receiptId = requiredString(receipt, "_id");
        }
        const normalizedReceiptId = db.normalizeId(
          "humanCommandReceipts",
          receiptId,
        );
        if (receipt === null && normalizedReceiptId !== null) {
          const loadedReceipt = await db.get(normalizedReceiptId);
          receipt = loadedReceipt === null ? null : document(loadedReceipt);
        }
        if (receipt === null) {
          mismatches.push({
            table,
            documentId,
            currentSubject: "(missing-receipt)",
            userId,
            expectedSubject,
            receiptId,
            reason: "missing_receipt",
          });
          continue;
        }
        const receiptRow = document(receipt);
        const currentSubject = requiredString(receiptRow, "principalId");
        if (await subjectNamespaceCollidesWithUser(db, currentSubject, userId)) {
          mismatches.push({
            table,
            documentId,
            currentSubject,
            userId,
            expectedSubject,
            receiptId,
            reason: "subject_collision",
          });
          continue;
        }
        const bindingChanged = receiptRow.principalKind !== "organization" ||
          receiptRow.organizationId !== row.organizationId ||
          receiptRow.idempotencyKey !== row.idempotencyKey ||
          !receiptOperationsForAttempt(requiredString(row, "operation"))
            .includes(requiredString(receiptRow, "operation"));
        const receiptLinks = await db.query("hostedMutationAttempts")
          .withIndex("by_receipt", (index) => index.eq("receiptId", receiptId))
          .take(2) as readonly PlainDocument[];
        const linkChanged = optionalStringValue(row, "receiptId") !== undefined &&
          (receiptLinks.length !== 1 ||
            requiredString(document(receiptLinks[0]), "_id") !== documentId);
        const unlinked = optionalStringValue(row, "receiptId") === undefined;
        if (
          currentSubject !== expectedSubject || bindingChanged || linkChanged || unlinked
        ) {
          mismatches.push({
            table,
            documentId,
            currentSubject,
            userId,
            expectedSubject,
            receiptId,
            reason: bindingChanged || linkChanged
              ? "recovery_binding_changed"
              : unlinked ? "unlinked_receipt" : "subject_changed",
          });
        }
        continue;
      }
      const currentSubject = table === "humanCommandReceipts"
        ? requiredString(row, "principalId")
        : requiredString(row, "localSubject");
      if (table !== "humanCommandReceipts") {
        const userId = requiredString(row, "userId");
        const normalizedUserId = db.normalizeId("users", userId);
        const user = normalizedUserId === null ? null : await db.get(normalizedUserId);
        if (user === null) {
          mismatches.push({
            table,
            documentId,
            currentSubject,
            userId,
            reason: "missing_user",
          });
          continue;
        }
        const expectedSubject = requiredString(document(user), "publicId");
        if (currentSubject !== expectedSubject) {
          mismatches.push({
            table,
            documentId,
            currentSubject,
            userId,
            expectedSubject,
            reason: "subject_changed",
          });
        }
        continue;
      }
      const { current: currentUsers, predecessor: predecessorUsers } =
        await subjectNamespaceRows(db, currentSubject);
      if (currentUsers.length > 1 || predecessorUsers.length > 1) {
        mismatches.push({
          table,
          documentId,
          currentSubject,
          reason: "subject_collision",
        });
        continue;
      }
      if (currentUsers.length === 1 && predecessorUsers.length === 1) {
        const currentUser = document(currentUsers[0]);
        const predecessorUser = document(predecessorUsers[0]);
        if (
          requiredString(currentUser, "_id") ===
            requiredString(predecessorUser, "_id")
        ) continue;
        mismatches.push({
          table,
          documentId,
          currentSubject,
          userId: requiredString(predecessorUser, "_id"),
          expectedSubject: requiredString(predecessorUser, "publicId"),
          reason: "subject_collision",
        });
        continue;
      }
      if (currentUsers.length === 1 && predecessorUsers.length === 0) continue;
      if (predecessorUsers.length !== 1) {
        mismatches.push({
          table,
          documentId,
          currentSubject,
          reason: "unmapped_subject",
        });
        continue;
      }
      const predecessorUser = document(predecessorUsers[0]);
      mismatches.push({
        table,
        documentId,
        currentSubject,
        userId: requiredString(predecessorUser, "_id"),
        expectedSubject: requiredString(predecessorUser, "publicId"),
        reason: "subject_changed",
      });
    }
    return {
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      mismatches,
    };
  },
});

/** Read-only inventory used to bind every purge to an exported exact row. */
export const listPredecessorRows = internalQuery({
  args: { table: predecessorTableValidator, cursor: v.optional(v.string()) },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    rows: v.array(v.object({ documentId: v.string(), creationTime: v.number() })),
  }),
  handler: async (ctx, args) => {
    const db = ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
    const page = await db.query(args.table).paginate({
      cursor: args.cursor ?? null,
      numItems: 64,
    });
    return {
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      rows: page.page.map((value) => {
        const row = document(value);
        return {
          documentId: requiredString(row, "_id"),
          creationTime: requiredNumber(row, "_creationTime"),
        };
      }),
    };
  },
});

function requireExactCutoverEnabled(): void {
  if (process.env.HRA_IDENTITY_CUTOVER_ENABLED !== "replace-exact-rows") {
    throw new Error("Identity cutover writes are disabled.");
  }
}

function requireExactPurgeEnabled(): void {
  if (process.env.HRA_IDENTITY_CUTOVER_ENABLED !== "purge-exported-predecessor-rows") {
    throw new Error("Identity cutover purge is disabled.");
  }
}

/**
 * These mutations intentionally accept one exact document and its stable
 * authority identifiers. They are internal-only, disabled by default, and do
 * not scan or recreate rows. A reviewed operator driver must call them only
 * after a recoverable deployment export has completed.
 */
export const replaceExactUser = internalMutation({
  args: { userId: v.id("users"), expectedPublicId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const current = await ctx.db.get(args.userId);
    if (current === null || current.publicId !== args.expectedPublicId) {
      throw new Error("Identity cutover user binding changed.");
    }
    await ctx.db.replace(args.userId, normalizeCutoverUser(current));
    return null;
  },
});

export const replaceExactOrganization = internalMutation({
  args: { organizationId: v.id("organizations"), expectedPublicId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const current = await ctx.db.get(args.organizationId);
    if (current === null || current.publicId !== args.expectedPublicId) {
      throw new Error("Identity cutover organization binding changed.");
    }
    await ctx.db.replace(args.organizationId, normalizeCutoverOrganization(current));
    return null;
  },
});

export const replaceExactMembership = internalMutation({
  args: {
    membershipId: v.id("organizationMemberships"),
    expectedOrganizationId: v.id("organizations"),
    expectedUserId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const current = await ctx.db.get(args.membershipId);
    if (
      current === null || current.organizationId !== args.expectedOrganizationId ||
      current.userId !== args.expectedUserId
    ) throw new Error("Identity cutover membership binding changed.");
    await ctx.db.replace(args.membershipId, normalizeCutoverMembership(current));
    return null;
  },
});

export const replaceExactPromotionSessionActor = internalMutation({
  args: {
    promotionSessionId: v.id("promotionSessions"),
    expectedPublicId: v.string(),
    expectedOrganizationId: v.id("organizations"),
    expectedStartedByUserId: v.id("users"),
    expectedOldSubject: v.string(),
    expectedNewSubject: v.string(),
    expectedAuthorizationMembershipId: v.id("organizationMemberships"),
    expectedStagingWorkspaceId: v.id("workspaces"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const current = await ctx.db.get(args.promotionSessionId);
    const user = await ctx.db.get(args.expectedStartedByUserId);
    if (current === null || user === null) {
      throw new Error("Identity cutover promotion actor binding changed.");
    }
    const row = document(current);
    const userRow = document(user);
    const existingNewSubject = optionalStringValue(row, "startedByUserPublicId");
    if (
      requiredString(row, "publicId") !== args.expectedPublicId ||
      requiredString(row, "organizationId") !== args.expectedOrganizationId ||
      requiredString(row, "startedByUserId") !== args.expectedStartedByUserId ||
      requiredString(row, "startedByWorkosUserId") !== args.expectedOldSubject ||
      (existingNewSubject !== undefined &&
        existingNewSubject !== args.expectedNewSubject) ||
      requiredString(row, "authorizationMembershipId") !==
        args.expectedAuthorizationMembershipId ||
      requiredString(row, "stagingWorkspaceId") !==
        args.expectedStagingWorkspaceId ||
      requiredString(userRow, "publicId") !== args.expectedNewSubject ||
      requiredString(userRow, "workosUserId") !== args.expectedOldSubject
    ) throw new Error("Identity cutover promotion actor binding changed.");
    const db = ctx.db as unknown as GenericDatabaseWriter<GenericDataModel>;
    await db.replace(
      args.promotionSessionId,
      normalizeCutoverPromotionSession(current, args.expectedNewSubject),
    );
    return null;
  },
});

export const replaceExactSuiteIdentityAliasSubject = internalMutation({
  args: {
    aliasId: v.id("suiteIdentityAliases"),
    expectedUserId: v.id("users"),
    expectedOldSubject: v.string(),
    expectedNewSubject: v.string(),
    expectedSuiteAccountId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const [current, user, collisions] = await Promise.all([
      ctx.db.get(args.aliasId),
      ctx.db.get(args.expectedUserId),
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_local_subject", (index) =>
          index.eq("localSubject", args.expectedNewSubject))
        .take(2),
    ]);
    if (
      current === null || user === null || current.userId !== args.expectedUserId ||
      current.localSubject !== args.expectedOldSubject ||
      current.suiteAccountId !== args.expectedSuiteAccountId ||
      user.publicId !== args.expectedNewSubject ||
      collisions.some((candidate) => candidate._id !== args.aliasId)
    ) throw new Error("Identity cutover suite alias binding changed or collided.");
    await ctx.db.patch(args.aliasId, { localSubject: args.expectedNewSubject });
    return null;
  },
});

export const replaceExactSuiteEntitlementSubject = internalMutation({
  args: {
    projectionId: v.id("suiteEntitlementProjections"),
    expectedUserId: v.id("users"),
    expectedOldSubject: v.string(),
    expectedNewSubject: v.string(),
    expectedSuiteAccountId: v.string(),
    expectedReceiptDigest: v.string(),
    expectedProjectionRevision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const [current, user, collisions] = await Promise.all([
      ctx.db.get(args.projectionId),
      ctx.db.get(args.expectedUserId),
      ctx.db.query("suiteEntitlementProjections")
        .withIndex("by_local_subject", (index) =>
          index.eq("localSubject", args.expectedNewSubject))
        .take(2),
    ]);
    if (
      current === null || user === null || current.userId !== args.expectedUserId ||
      current.localSubject !== args.expectedOldSubject ||
      current.suiteAccountId !== args.expectedSuiteAccountId ||
      current.receiptDigest !== args.expectedReceiptDigest ||
      current.projectionRevision !== args.expectedProjectionRevision ||
      user.publicId !== args.expectedNewSubject ||
      collisions.some((candidate) => candidate._id !== args.projectionId)
    ) throw new Error("Identity cutover suite entitlement binding changed or collided.");
    await ctx.db.patch(args.projectionId, { localSubject: args.expectedNewSubject });
    return null;
  },
});

export const purgeExactPendingSuiteIdentityChallenge = internalMutation({
  args: {
    challengeDocumentId: v.id("suiteIdentityLinkChallenges"),
    expectedChallengeId: v.string(),
    expectedUserId: v.id("users"),
    expectedOldSubject: v.string(),
    expectedCreatedAt: v.number(),
    expectedExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const current = await ctx.db.get(args.challengeDocumentId);
    if (
      current === null || current.state !== "pending" ||
      current.challengeId !== args.expectedChallengeId ||
      current.userId !== args.expectedUserId ||
      current.localSubject !== args.expectedOldSubject ||
      current.createdAt !== args.expectedCreatedAt ||
      current.expiresAt !== args.expectedExpiresAt
    ) throw new Error("Identity cutover suite challenge binding changed.");
    await ctx.db.delete(args.challengeDocumentId);
    return null;
  },
});

/**
 * Closes the retained legacy crash window in one transaction. The receipt is
 * rebound to the preserved public subject and the open effect-started attempt
 * receives that exact receipt ID. Full document digests omit only those two
 * fields, so any unrelated concurrent change fails closed.
 */
export const linkExactHostedMutationReceipt = internalMutation({
  args: {
    attemptId: v.id("hostedMutationAttempts"),
    receiptId: v.id("humanCommandReceipts"),
    expectedUserId: v.id("users"),
    expectedOldPrincipalId: v.string(),
    expectedNewPrincipalId: v.string(),
    expectedOrganizationId: v.id("organizations"),
    expectedWorkspaceId: v.id("workspaces"),
    expectedWorkspacePublicId: v.string(),
    expectedSourceId: v.string(),
    expectedAttemptOperation: v.string(),
    expectedFingerprint: v.string(),
    expectedFingerprintKeyVersion: v.string(),
    expectedIdempotencyKey: v.string(),
    expectedReceiptOperation: v.string(),
    expectedRequestDigest: v.string(),
    expectedRequestId: v.string(),
    expectedReceiptExpiresAt: v.number(),
    expectedAttemptDocumentDigest: v.string(),
    expectedReceiptDocumentDigest: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const [attempt, receipt, user] = await Promise.all([
      ctx.db.get(args.attemptId),
      ctx.db.get(args.receiptId),
      ctx.db.get(args.expectedUserId),
    ]);
    if (attempt === null || receipt === null || user === null) {
      throw new Error("Identity cutover hosted receipt binding changed.");
    }
    const userRow = document(user);
    const oldSubjectIsExact = args.expectedOldPrincipalId ===
        args.expectedNewPrincipalId ||
      optionalStringValue(userRow, "workosUserId") ===
        args.expectedOldPrincipalId;
    const subjectCollision = await subjectNamespaceCollidesWithUser(
      ctx.db as unknown as GenericDatabaseReader<GenericDataModel>,
      args.expectedOldPrincipalId,
      args.expectedUserId,
    );
    if (
      attempt.state !== "effect-started" || attempt.open !== true ||
      attempt.revision !== 2 || attempt.receiptId !== undefined ||
      attempt.principalId !== args.expectedUserId ||
      attempt.organizationId !== args.expectedOrganizationId ||
      attempt.workspaceId !== args.expectedWorkspaceId ||
      attempt.workspacePublicId !== args.expectedWorkspacePublicId ||
      attempt.sourceId !== args.expectedSourceId ||
      attempt.operation !== args.expectedAttemptOperation ||
      attempt.fingerprint !== args.expectedFingerprint ||
      attempt.fingerprintKeyVersion !== args.expectedFingerprintKeyVersion ||
      attempt.idempotencyKey !== args.expectedIdempotencyKey ||
      user.publicId !== args.expectedNewPrincipalId || !oldSubjectIsExact ||
      subjectCollision ||
      receipt.principalKind !== "organization" ||
      receipt.principalId !== args.expectedOldPrincipalId ||
      receipt.organizationId !== args.expectedOrganizationId ||
      receipt.operation !== args.expectedReceiptOperation ||
      receipt.idempotencyKey !== args.expectedIdempotencyKey ||
      cutoverRequestDigestToken(receipt.requestDigest) !==
        args.expectedRequestDigest ||
      receipt.requestId !== args.expectedRequestId ||
      receipt.expiresAt !== args.expectedReceiptExpiresAt ||
      !receiptOperationsForAttempt(attempt.operation).includes(receipt.operation) ||
      await stableDocumentDigest(attempt, ["receiptId"]) !==
        args.expectedAttemptDocumentDigest ||
      await stableDocumentDigest(receipt, ["principalId"]) !==
        args.expectedReceiptDocumentDigest
    ) throw new Error("Identity cutover hosted receipt binding changed.");

    const resolved = await exactUnlinkedReceiptForAttempt(
      ctx.db as unknown as RuntimeDatabaseReader,
      document(attempt),
    );
    if (
      resolved.kind !== "exact" ||
      requiredString(resolved.receipt, "_id") !== args.receiptId
    ) throw new Error("Identity cutover hosted receipt recovery is ambiguous.");
    const [collisions, existingLinks] = await Promise.all([
      ctx.db.query("humanCommandReceipts")
        .withIndex("by_principal_operation_key", (index) =>
          index
            .eq("principalKind", "organization")
            .eq("principalId", args.expectedNewPrincipalId)
            .eq("organizationId", args.expectedOrganizationId)
            .eq("operation", args.expectedReceiptOperation)
            .eq("idempotencyKey", args.expectedIdempotencyKey))
        .take(2),
      ctx.db.query("hostedMutationAttempts")
        .withIndex("by_receipt", (index) => index.eq("receiptId", args.receiptId))
        .take(2),
    ]);
    if (collisions.some((candidate) => candidate._id !== args.receiptId)) {
      throw new Error("Identity cutover hosted receipt principal collided.");
    }
    if (existingLinks.length !== 0) {
      throw new Error("Identity cutover hosted receipt was already linked.");
    }
    await ctx.db.patch(args.receiptId, {
      principalId: args.expectedNewPrincipalId,
    });
    await ctx.db.patch(args.attemptId, { receiptId: args.receiptId });
    return null;
  },
});

export const replaceExactHumanReceiptPrincipal = internalMutation({
  args: {
    receiptId: v.id("humanCommandReceipts"),
    expectedUserId: v.id("users"),
    expectedOldPrincipalId: v.string(),
    expectedNewPrincipalId: v.string(),
    expectedPrincipalKind: v.union(v.literal("account"), v.literal("organization")),
    expectedOrganizationId: v.optional(v.id("organizations")),
    expectedOperation: v.string(),
    expectedIdempotencyKey: v.string(),
    expectedRequestDigest: v.string(),
    expectedRequestId: v.string(),
    expectedExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactCutoverEnabled();
    const current = await ctx.db.get(args.receiptId);
    const user = await ctx.db.get(args.expectedUserId);
    const subjectCollision = await subjectNamespaceCollidesWithUser(
      ctx.db as unknown as GenericDatabaseReader<GenericDataModel>,
      args.expectedOldPrincipalId,
      args.expectedUserId,
    );
    if (
      current === null || user === null ||
      current.principalId !== args.expectedOldPrincipalId ||
      current.principalKind !== args.expectedPrincipalKind ||
      current.organizationId !== args.expectedOrganizationId ||
      current.operation !== args.expectedOperation ||
      current.idempotencyKey !== args.expectedIdempotencyKey ||
      cutoverRequestDigestToken(current.requestDigest) !==
        args.expectedRequestDigest ||
      current.requestId !== args.expectedRequestId ||
      current.expiresAt !== args.expectedExpiresAt ||
      user.publicId !== args.expectedNewPrincipalId ||
      document(user).workosUserId !== args.expectedOldPrincipalId ||
      subjectCollision
    ) throw new Error("Identity cutover receipt binding changed.");
    const [collisions, linkedAttempts] = await Promise.all([
      ctx.db.query("humanCommandReceipts")
        .withIndex("by_principal_operation_key", (index) =>
          index
            .eq("principalKind", args.expectedPrincipalKind)
            .eq("principalId", args.expectedNewPrincipalId)
            .eq("organizationId", args.expectedOrganizationId)
            .eq("operation", args.expectedOperation)
            .eq("idempotencyKey", args.expectedIdempotencyKey))
        .take(2),
      ctx.db.query("hostedMutationAttempts")
        .withIndex("by_receipt", (index) => index.eq("receiptId", args.receiptId))
        .take(2),
    ]);
    if (collisions.some((candidate) => candidate._id !== args.receiptId)) {
      throw new Error("Identity cutover receipt principal collided.");
    }
    if (
      linkedAttempts.length > 1 || linkedAttempts.some((attempt) =>
        attempt.principalId !== args.expectedUserId ||
        attempt.organizationId !== args.expectedOrganizationId ||
        attempt.idempotencyKey !== args.expectedIdempotencyKey)
    ) throw new Error("Identity cutover hosted receipt recovery binding changed.");
    await ctx.db.patch(args.receiptId, {
      principalId: args.expectedNewPrincipalId,
    });
    return null;
  },
});

/**
 * Deletes one previously exported predecessor-only row. The exact table, ID,
 * and Convex creation time must still agree, so stale or broadened input fails
 * without changing data. This never accepts an identity, vault, or schedule
 * table.
 */
export const purgeExactPredecessorRow = internalMutation({
  args: {
    table: predecessorTableValidator,
    documentId: v.string(),
    expectedCreationTime: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireExactPurgeEnabled();
    const db = ctx.db as unknown as GenericDatabaseWriter<GenericDataModel>;
    const documentId = db.normalizeId(args.table, args.documentId);
    if (documentId === null) throw new Error("Identity cutover purge ID is invalid.");
    const current = await db.get(documentId);
    if (current === null || current._creationTime !== args.expectedCreationTime) {
      throw new Error("Identity cutover purge binding changed.");
    }
    await db.delete(documentId);
    return null;
  },
});
