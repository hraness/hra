import { z } from "@hra-internal/schema";

import {
  epochMsSchema,
  importedRunSummaryIdSchema,
  positiveGenerationSchema,
  promotionBatchIdSchema,
  promotionIdSchema,
  repositoryIdSchema,
  taskKeySchema,
  taskPublicIdSchema,
  workspaceEventSequenceSchema,
  workspacePublicIdSchema,
} from "./identifiers";
import {
  MAX_BLOCKING_DEPENDENTS,
  MAX_DIRECT_BLOCKERS,
  MAX_PARENT_DEPTH,
} from "./graph-laws";
import {
  MAX_TASK_LABELS,
  repositoryNameSchema,
  repositoryProviderSchema,
  reviewReasonSchema,
  submissionSummarySchema,
  taskCommentBodySchema,
  taskDescriptionSchema,
  taskLabelSchema,
  taskPrioritySchema,
  taskReferenceViewSchema,
  taskTitleSchema,
  taskTypeSchema,
  workspaceNameSchema,
  workspaceSlugSchema,
} from "./task";

export const sha256DigestSchema = z.string().regex(/^sha256_[a-f0-9]{64}$/u);
export const MAX_PROMOTION_BATCH_ORDINAL = 1_000_000;
export const MAX_PROMOTION_BATCH_RECEIPTS = 250_000;
export const MAX_PROMOTION_SNAPSHOT_ENTITIES = 500_000;

// These strings domain-separate durable hashes and signed receipts. They are
// historical wire bytes, not active product branding, and must never change.
const STABLE_PROMOTION_HASH_DOMAINS = {
  abortReceiptV2: "hraness-kitchen:promotion-abort-receipt:v2\n",
  activationReceiptV2: "hraness-kitchen:promotion-activation-receipt:v2\n",
  batchV1: "hraness-kitchen:promotion-batch:v1\n",
  batchV2: "hraness-kitchen:promotion-batch:v2\n",
  familyEntityV1: "hraness-kitchen:promotion-family-entity:v1\n",
  familyV1: "hraness-kitchen:promotion-family:v1\n",
  manifestV2: "hraness-kitchen:promotion-manifest:v2\n",
  snapshotV1: "hraness-kitchen:promotion-snapshot:v1\n",
} as const;

const suspiciousCredentialValue =
  /(?:^|\b)(?:basic|bearer)\s+|(?:^|[^a-z0-9])(?:AIza[0-9A-Za-z_-]{20,}|ghp_|github_pat_|glpat-|sk_(?:live|test)_|xox[baprs]-|AKIA[0-9A-Z]{12,}|ya29\.)|(?:[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/iu;
const MAX_PROMOTION_URL_DECODE_PASSES = 8;

function credentialLikeUrlKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return [
    "apiKey",
    "authorization",
    "bearer",
    "credential",
    "jwt",
    "password",
    "passwd",
    "secret",
    "signature",
  ].some((candidate) => normalized.includes(candidate.toLowerCase())) ||
    /^(?:auth|code|key|pat|pwd|session|sig|ticket|token)$/u.test(normalized) ||
    /(?:access|api|auth|bearer|id|oauth|private|refresh|security|session)token$/u.test(
      normalized,
    ) ||
    /(?:access|api|auth|oauth|private|secret|security|session|signing)key$/u.test(
      normalized,
    );
}

function credentialLikeUrlComponent(key: string, value: string): boolean {
  return urlKeyContainsCredential(key) ||
    urlComponentContainsCredential(value);
}

function urlComponentContainsCredential(value: string): boolean {
  let candidate = value;
  for (let attempt = 0; attempt < MAX_PROMOTION_URL_DECODE_PASSES; attempt += 1) {
    if (suspiciousCredentialValue.test(candidate)) return true;
    if (!candidate.includes("%")) return false;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return candidate.includes("%") || suspiciousCredentialValue.test(candidate);
}

function urlKeyContainsCredential(value: string): boolean {
  let candidate = value;
  for (let attempt = 0; attempt < MAX_PROMOTION_URL_DECODE_PASSES; attempt += 1) {
    if (credentialLikeUrlKey(candidate)) return true;
    if (!candidate.includes("%")) return false;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return candidate.includes("%") || credentialLikeUrlKey(candidate);
}

/** Promotion URLs are durable cloud records, not temporary credential carriers. */
export const promotionCredentialFreeHttpsUrlSchema = z.string().max(2_048)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "promotion URL must be absolute" });
      return;
    }
    if (url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "promotion URL must use HTTPS" });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({ code: "custom", message: "promotion URL must not contain credentials" });
    }
    if (
      url.hostname
        .split(".")
        .some((label) => urlComponentContainsCredential(label))
    ) {
      context.addIssue({
        code: "custom",
        message: "promotion URL hostname contains credential-like material",
      });
    }
    if (urlComponentContainsCredential(url.pathname)) {
      context.addIssue({
        code: "custom",
        message: "promotion URL path contains credential-like material",
      });
    }
    const rawQuery = url.search.slice(1);
    if (
      rawQuery.length > 0 &&
      urlComponentContainsCredential(rawQuery)
    ) {
      context.addIssue({
        code: "custom",
        message: "promotion URL query is malformed, over-encoded, or credential-like",
      });
    }
    for (const [key, item] of url.searchParams) {
      if (credentialLikeUrlComponent(key, item)) {
        context.addIssue({
          code: "custom",
          message: "promotion URL query contains credential-like material",
        });
        break;
      }
    }
    const fragment = url.hash.slice(1);
    if (fragment.length === 0) return;
    if (urlComponentContainsCredential(fragment)) {
      context.addIssue({
        code: "custom",
        message: "promotion URL fragment contains credential-like material",
      });
      return;
    }
    const fragmentParameters = new URLSearchParams(
      fragment.startsWith("?") ? fragment.slice(1) : fragment,
    );
    for (const [key, item] of fragmentParameters) {
      if (credentialLikeUrlComponent(key, item)) {
        context.addIssue({
          code: "custom",
          message: "promotion URL fragment contains credential-like material",
        });
        return;
      }
    }
    if (urlKeyContainsCredential(fragment)) {
      context.addIssue({
        code: "custom",
        message: "promotion URL fragment contains a credential-like key",
      });
    }
  });

export const importedLocalProvenanceSchema = z.object({
  kind: z.literal("imported_local"),
  sourceWorkspaceId: workspacePublicIdSchema,
  sourceTaskId: taskPublicIdSchema,
  importedAt: epochMsSchema,
}).strict();
export type ImportedLocalProvenance = z.infer<typeof importedLocalProvenanceSchema>;

export const sanitizedImportedEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{7,64}$/iu),
    url: promotionCredentialFreeHttpsUrlSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("pull_request"),
    url: promotionCredentialFreeHttpsUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    name: z.string().min(1).max(160),
    url: promotionCredentialFreeHttpsUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal("url"),
    label: z.string().min(1).max(160),
    url: promotionCredentialFreeHttpsUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal("note"),
    text: z.string().min(1).max(4_096),
  }).strict(),
]);
export type SanitizedImportedEvidence = z.infer<typeof sanitizedImportedEvidenceSchema>;

export const importedRunSummarySchema = z.object({
  id: importedRunSummaryIdSchema,
  provenance: importedLocalProvenanceSchema,
  sourceRunId: z.string().min(12).max(128).regex(/^run_[a-z0-9_-]+$/u),
  taskId: taskPublicIdSchema,
  terminalPhase: z.enum(["submitted", "failed", "cancelled"]),
  summary: submissionSummarySchema,
  evidence: z.array(sanitizedImportedEvidenceSchema).max(50),
  startedAt: epochMsSchema.optional(),
  finishedAt: epochMsSchema,
  retryable: z.literal(false),
  resumable: z.literal(false),
  reviewable: z.literal(false),
}).strict().superRefine((summary, context) => {
  if (summary.startedAt !== undefined && summary.finishedAt < summary.startedAt) {
    context.addIssue({
      code: "custom",
      message: "imported run finish must not precede its start",
      path: ["finishedAt"],
    });
  }
});
export type ImportedRunSummary = z.infer<typeof importedRunSummarySchema>;

export const promotionEntityFamilyValues = [
  "workspace_metadata",
  "executors",
  "repositories",
  "tasks",
  "task_bodies",
  "task_repository_links",
  "parent_edges",
  "dependencies",
  "labels",
  "comments",
  "references",
  "submissions",
  "reviews",
  "terminal_states",
  "imported_run_summaries",
] as const;
export const promotionEntityFamilySchema = z.enum(promotionEntityFamilyValues);

const promotionTaskReferenceViewSchema = taskReferenceViewSchema.superRefine(
  (reference, context) => {
    if ("url" in reference && reference.url !== undefined) {
      const parsed = promotionCredentialFreeHttpsUrlSchema.safeParse(reference.url);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          message: "promotion task reference URL contains credential-like material",
          path: ["url"],
        });
      }
    }
  },
);

function lengthFramedRelationKey(namespace: string, values: readonly string[]): string {
  return `${namespace}|${values.map((value) =>
    `${new TextEncoder().encode(value).length}:${value}`).join("|")}`;
}

export function taskRepositoryRelationKey(taskId: string, repositoryId: string): string {
  return lengthFramedRelationKey("task_repository", [
    taskPublicIdSchema.parse(taskId),
    repositoryIdSchema.parse(repositoryId),
  ]);
}

export function parentRelationKey(taskId: string, parentTaskId: string): string {
  return lengthFramedRelationKey("parent", [
    taskPublicIdSchema.parse(taskId),
    taskPublicIdSchema.parse(parentTaskId),
  ]);
}

export function dependencyRelationKey(blockerTaskId: string, blockedTaskId: string): string {
  return lengthFramedRelationKey("dependency", [
    taskPublicIdSchema.parse(blockerTaskId),
    taskPublicIdSchema.parse(blockedTaskId),
  ]);
}

export function taskLabelRelationKey(taskId: string, label: string): string {
  return lengthFramedRelationKey("task_label", [
    taskPublicIdSchema.parse(taskId),
    taskLabelSchema.parse(label),
  ]);
}

const promotionReviewBase = {
  family: z.literal("reviews"),
  taskId: taskPublicIdSchema,
  submissionId: z.string().regex(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/u),
  reviewerProvenance: z.enum(["local_owner", "local_agent", "system"]),
  reviewedAt: epochMsSchema,
} as const;

export const promotionReviewEntitySchema = z.discriminatedUnion("decision", [
  z.object({
    ...promotionReviewBase,
    decision: z.literal("accepted"),
  }).strict(),
  z.object({
    ...promotionReviewBase,
    decision: z.literal("rejected"),
    reason: reviewReasonSchema,
  }).strict(),
  z.object({
    ...promotionReviewBase,
    decision: z.literal("cancelled"),
    reason: reviewReasonSchema,
  }).strict(),
]);

const promotionTerminalStateBase = {
  family: z.literal("terminal_states"),
  taskId: taskPublicIdSchema,
  terminalAt: epochMsSchema,
} as const;

export const promotionTerminalStateEntitySchema = z.discriminatedUnion("status", [
  z.object({
    ...promotionTerminalStateBase,
    status: z.literal("done"),
    acceptedSubmissionId: z.string().regex(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/u),
  }).strict(),
  z.object({
    ...promotionTerminalStateBase,
    status: z.literal("cancelled"),
  }).strict(),
]);

export const promotionEntitySchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("workspace_metadata"),
    workspaceId: workspacePublicIdSchema,
    name: workspaceNameSchema,
    slug: workspaceSlugSchema,
    keyPrefix: z.string().min(2).max(8).regex(/^[A-Z][A-Z0-9]{1,7}$/u),
  }).strict(),
  z.object({
    family: z.literal("executors"),
    workspaceId: workspacePublicIdSchema,
    executor: z.literal("local_codex"),
    enabled: z.literal(true),
  }).strict(),
  z.object({
    family: z.literal("repositories"),
    id: repositoryIdSchema,
    name: repositoryNameSchema,
    provider: repositoryProviderSchema,
    url: promotionCredentialFreeHttpsUrlSchema,
  }).strict(),
  z.object({
    family: z.literal("tasks"),
    id: taskPublicIdSchema,
    key: taskKeySchema,
    title: taskTitleSchema,
    type: taskTypeSchema,
    priority: taskPrioritySchema,
    status: z.enum(["open", "in_review", "done", "cancelled"]),
    availableAt: epochMsSchema,
    revision: positiveGenerationSchema,
    reviewRevision: positiveGenerationSchema,
    assignee: z.object({ kind: z.literal("builtin_executor") }).strict().optional(),
  }).strict(),
  z.object({
    family: z.literal("task_bodies"),
    taskId: taskPublicIdSchema,
    description: taskDescriptionSchema,
  }).strict(),
  z.object({
    family: z.literal("task_repository_links"),
    relationKey: z.string().min(1).max(512),
    taskId: taskPublicIdSchema,
    repositoryId: repositoryIdSchema,
  }).strict().refine(
    (relation) => relation.relationKey ===
      taskRepositoryRelationKey(relation.taskId, relation.repositoryId),
    "task-repository relation key does not match its tuple",
  ),
  z.object({
    family: z.literal("parent_edges"),
    relationKey: z.string().min(1).max(512),
    taskId: taskPublicIdSchema,
    parentTaskId: taskPublicIdSchema,
  }).strict().superRefine((relation, context) => {
    if (relation.taskId === relation.parentTaskId) {
      context.addIssue({ code: "custom", message: "a promotion parent edge cannot self-reference" });
    }
    if (relation.relationKey !== parentRelationKey(relation.taskId, relation.parentTaskId)) {
      context.addIssue({
        code: "custom",
        message: "parent relation key does not match its directed tuple",
        path: ["relationKey"],
      });
    }
  }),
  z.object({
    family: z.literal("dependencies"),
    relationKey: z.string().min(1).max(512),
    blockerTaskId: taskPublicIdSchema,
    blockedTaskId: taskPublicIdSchema,
  }).strict().superRefine((dependency, context) => {
    if (dependency.blockerTaskId === dependency.blockedTaskId) {
      context.addIssue({ code: "custom", message: "a promotion dependency cannot self-reference" });
    }
    if (
      dependency.relationKey !==
        dependencyRelationKey(dependency.blockerTaskId, dependency.blockedTaskId)
    ) {
      context.addIssue({
        code: "custom",
        message: "dependency relation key does not match its directed tuple",
        path: ["relationKey"],
      });
    }
  }),
  z.object({
    family: z.literal("labels"),
    relationKey: z.string().min(1).max(512),
    taskId: taskPublicIdSchema,
    label: taskLabelSchema,
  }).strict().refine(
    (relation) => relation.relationKey === taskLabelRelationKey(relation.taskId, relation.label),
    "task-label relation key does not match its tuple",
  ),
  z.object({
    family: z.literal("comments"),
    id: z.string().regex(/^cmt_[0-9A-HJKMNP-TV-Z]{26}$/u),
    taskId: taskPublicIdSchema,
    body: taskCommentBodySchema,
    authorProvenance: z.enum(["local_owner", "local_agent", "system"]),
    createdAt: epochMsSchema,
  }).strict(),
  z.object({
    family: z.literal("references"),
    taskId: taskPublicIdSchema,
    reference: promotionTaskReferenceViewSchema,
  }).strict(),
  z.object({
    family: z.literal("submissions"),
    taskId: taskPublicIdSchema,
    submissionId: z.string().regex(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/u),
    reviewRevision: positiveGenerationSchema,
    status: z.enum(["pending", "accepted", "rejected", "cancelled"]),
    summary: submissionSummarySchema,
    evidence: z.array(sanitizedImportedEvidenceSchema).max(50),
  }).strict(),
  promotionReviewEntitySchema,
  promotionTerminalStateEntitySchema,
  z.object({
    family: z.literal("imported_run_summaries"),
    summary: importedRunSummarySchema,
  }).strict(),
]);
export type PromotionEntity = z.infer<typeof promotionEntitySchema>;

/** Stable upsert identity for every promotion row, including canonical relation rows. */
export function promotionEntityIdentity(entity: PromotionEntity): string {
  switch (entity.family) {
    case "workspace_metadata":
      return entity.workspaceId;
    case "executors":
      return `${entity.workspaceId}:local_codex`;
    case "repositories":
    case "tasks":
    case "comments":
      return entity.id;
    case "task_bodies":
    case "terminal_states":
      return entity.taskId;
    case "task_repository_links":
    case "parent_edges":
    case "dependencies":
    case "labels":
      return entity.relationKey;
    case "references":
      return entity.reference.id;
    case "submissions":
      return entity.submissionId;
    case "reviews":
      return `${entity.submissionId}:review`;
    case "imported_run_summaries":
      return entity.summary.id;
  }
}

export function canonicalPromotionJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("promotion value is not JSON");
    return encoded;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("promotion number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalPromotionJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("promotion value is not JSON");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== null && prototype !== Object.prototype) {
    throw new TypeError("promotion value must be a plain JSON object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const properties = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPromotionJson(record[key])}`);
  return `{${properties.join(",")}}`;
}

const SHA_256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA_256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function promotionSha256Digest(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const paddedView = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  paddedView.setUint32(
    paddedLength - 8,
    Math.floor(bitLength / 0x1_0000_0000),
    false,
  );
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = Uint32Array.from(SHA_256_INITIAL);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = paddedView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15] ?? 0;
      const previous2 = schedule[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] = (
        (schedule[index - 16] ?? 0) +
        sigma0 +
        (schedule[index - 7] ?? 0) +
        sigma1
      ) >>> 0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const upperE = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (
        h +
        upperE +
        choice +
        (SHA_256_ROUND[index] ?? 0) +
        (schedule[index] ?? 0)
      ) >>> 0;
      const upperA = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperA + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  return `sha256_${Array.from(state, (word) =>
    word.toString(16).padStart(8, "0")).join("")}`;
}

type PromotionBatchDigestInput = Readonly<{
  promotionId: string;
  batchId: string;
  family: (typeof promotionEntityFamilyValues)[number];
  ordinal: number;
  items: readonly PromotionEntity[];
}>;

/** Exact v1 preimage shared by local producers and cloud batch verifiers. */
export function promotionBatchDigestPreimage(batch: PromotionBatchDigestInput): string {
  return `${STABLE_PROMOTION_HASH_DOMAINS.batchV1}${canonicalPromotionJson({
    batchId: batch.batchId,
    family: batch.family,
    items: batch.items,
    ordinal: batch.ordinal,
    promotionId: batch.promotionId,
  })}`;
}

export function promotionBatchRequestDigest(batch: PromotionBatchDigestInput): string {
  return promotionSha256Digest(promotionBatchDigestPreimage(batch));
}

const entityCountSchema = z.number()
  .int()
  .nonnegative()
  .max(MAX_PROMOTION_SNAPSHOT_ENTITIES)
  .safe();
export const promotionEntityCountsSchema = z.object({
  workspace_metadata: entityCountSchema,
  executors: entityCountSchema,
  repositories: entityCountSchema,
  tasks: entityCountSchema,
  task_bodies: entityCountSchema,
  task_repository_links: entityCountSchema,
  parent_edges: entityCountSchema,
  dependencies: entityCountSchema,
  labels: entityCountSchema,
  comments: entityCountSchema,
  references: entityCountSchema,
  submissions: entityCountSchema,
  reviews: entityCountSchema,
  terminal_states: entityCountSchema,
  imported_run_summaries: entityCountSchema,
}).strict();

export const promotionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  promotionId: promotionIdSchema,
  sourceWorkspaceId: workspacePublicIdSchema,
  sourceWorkspaceRevision: positiveGenerationSchema,
  sourceEventSequence: workspaceEventSequenceSchema,
  createdAt: epochMsSchema,
  rootDigest: sha256DigestSchema,
  counts: promotionEntityCountsSchema,
  repositoryIds: z.array(repositoryIdSchema).max(128),
  taskIds: z.array(taskPublicIdSchema).max(100_000),
  terminalLocalWork: z.object({
    queuedIntents: z.literal(0),
    activeClaims: z.literal(0),
    nonterminalRuns: z.literal(0),
    openInteractions: z.literal(0),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.repositoryIds).size !== manifest.repositoryIds.length) {
    context.addIssue({
      code: "custom",
      message: "promotion repository IDs must be unique",
      path: ["repositoryIds"],
    });
  }
  if (new Set(manifest.taskIds).size !== manifest.taskIds.length) {
    context.addIssue({
      code: "custom",
      message: "promotion task IDs must be unique",
      path: ["taskIds"],
    });
  }
  if (manifest.counts.workspace_metadata !== 1) {
    context.addIssue({
      code: "custom",
      message: "promotion must contain exactly one workspace metadata record",
      path: ["counts", "workspace_metadata"],
    });
  }
  if (manifest.counts.executors !== 1) {
    context.addIssue({
      code: "custom",
      message: "promotion must contain exactly one built-in executor",
      path: ["counts", "executors"],
    });
  }
  if (manifest.counts.repositories !== manifest.repositoryIds.length) {
    context.addIssue({
      code: "custom",
      message: "promotion repository count must match the manifest IDs",
      path: ["counts", "repositories"],
    });
  }
  if (manifest.counts.tasks !== manifest.taskIds.length) {
    context.addIssue({
      code: "custom",
      message: "promotion task count must match the manifest IDs",
      path: ["counts", "tasks"],
    });
  }
  if (manifest.counts.task_bodies !== manifest.counts.tasks) {
    context.addIssue({
      code: "custom",
      message: "promotion must contain exactly one body for every task",
      path: ["counts", "task_bodies"],
    });
  }
  const totalEntities = promotionEntityFamilyValues.reduce(
    (total, family) => total + manifest.counts[family],
    0,
  );
  if (totalEntities > MAX_PROMOTION_SNAPSHOT_ENTITIES) {
    context.addIssue({
      code: "custom",
      message: "promotion manifest entity total exceeds the snapshot limit",
      path: ["counts"],
    });
  }
});
export type PromotionManifest = z.infer<typeof promotionManifestSchema>;

type PromotionSnapshotDigestInput = Readonly<{
  manifest: PromotionManifest;
  entities: readonly PromotionEntity[];
}>;

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Exact v1 root preimage; entity order and manifest ID-set order are canonicalized. */
export function promotionSnapshotDigestPreimage(
  snapshot: PromotionSnapshotDigestInput,
): string {
  const entities = [...snapshot.entities].sort((left, right) => {
    const familyOrder = promotionEntityFamilyValues.indexOf(left.family) -
      promotionEntityFamilyValues.indexOf(right.family);
    if (familyOrder !== 0) return familyOrder;
    const identityOrder = compareCanonicalText(
      promotionEntityIdentity(left),
      promotionEntityIdentity(right),
    );
    if (identityOrder !== 0) return identityOrder;
    return compareCanonicalText(
      canonicalPromotionJson(left),
      canonicalPromotionJson(right),
    );
  });
  const manifest = snapshot.manifest;
  return `${STABLE_PROMOTION_HASH_DOMAINS.snapshotV1}${canonicalPromotionJson({
    createdAt: manifest.createdAt,
    counts: manifest.counts,
    promotionId: manifest.promotionId,
    repositoryIds: [...manifest.repositoryIds].sort(compareCanonicalText),
    schemaVersion: manifest.schemaVersion,
    sourceEventSequence: manifest.sourceEventSequence,
    sourceWorkspaceId: manifest.sourceWorkspaceId,
    sourceWorkspaceRevision: manifest.sourceWorkspaceRevision,
    taskIds: [...manifest.taskIds].sort(compareCanonicalText),
    terminalLocalWork: manifest.terminalLocalWork,
    entities,
  })}`;
}

export function promotionSnapshotRootDigest(
  snapshot: PromotionSnapshotDigestInput,
): string {
  return promotionSha256Digest(promotionSnapshotDigestPreimage(snapshot));
}

export const promotionBatchFamilySchema = promotionEntityFamilySchema;

export const promotionBatchSchema = z.object({
  promotionId: promotionIdSchema,
  batchId: promotionBatchIdSchema,
  family: promotionBatchFamilySchema,
  ordinal: z.number().int().nonnegative().max(MAX_PROMOTION_BATCH_ORDINAL),
  items: z.array(promotionEntitySchema).min(1).max(500),
  requestDigest: sha256DigestSchema,
}).strict().superRefine((batch, context) => {
  batch.items.forEach((item, index) => {
    if (item.family !== batch.family) {
      context.addIssue({
        code: "custom",
        message: "promotion batch items must match the declared family",
        path: ["items", index, "family"],
      });
    }
  });
  const identities = batch.items.map((item) => promotionEntityIdentity(item));
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: "custom",
      message: "promotion batch entity identities must be unique",
      path: ["items"],
    });
  }
  const expectedDigest = promotionBatchRequestDigest(batch);
  if (batch.requestDigest !== expectedDigest) {
    context.addIssue({
      code: "custom",
      message: "promotion batch digest does not bind its canonical request content",
      path: ["requestDigest"],
    });
  }
});
export type PromotionBatch = z.infer<typeof promotionBatchSchema>;

export const promotionBatchReceiptSchema = z.object({
  promotionId: promotionIdSchema,
  batchId: promotionBatchIdSchema,
  family: promotionBatchFamilySchema,
  ordinal: z.number().int().nonnegative().max(MAX_PROMOTION_BATCH_ORDINAL),
  itemCount: z.number().int().positive().max(500),
  requestDigest: sha256DigestSchema,
  acceptedDigest: sha256DigestSchema,
  acceptedAt: epochMsSchema,
  cumulativeCounts: promotionEntityCountsSchema,
}).strict().refine(
  (receipt) => receipt.requestDigest === receipt.acceptedDigest,
  {
    message: "promotion receipt accepted digest must equal its request digest",
    path: ["acceptedDigest"],
  },
);
export type PromotionBatchReceipt = z.infer<typeof promotionBatchReceiptSchema>;

export const promotionBatchAcceptanceSchema = z.object({
  batch: promotionBatchSchema,
  receipt: promotionBatchReceiptSchema,
}).strict().superRefine(({ batch, receipt }, context) => {
  for (const field of [
    "promotionId",
    "batchId",
    "family",
    "ordinal",
    "requestDigest",
  ] as const) {
    if (batch[field] !== receipt[field]) {
      context.addIssue({
        code: "custom",
        message: `promotion batch receipt ${field} does not match its request`,
        path: ["receipt", field],
      });
    }
  }
  if (batch.items.length !== receipt.itemCount) {
    context.addIssue({
      code: "custom",
      message: "promotion batch receipt item count does not match its request",
      path: ["receipt", "itemCount"],
    });
  }
  if (batch.requestDigest !== receipt.acceptedDigest) {
    context.addIssue({
      code: "custom",
      message: "promotion batch accepted digest does not match its request",
      path: ["receipt", "acceptedDigest"],
    });
  }
});
export type PromotionBatchAcceptance = z.infer<
  typeof promotionBatchAcceptanceSchema
>;

export const promotionActivationReceiptSchema = z.object({
  promotionId: promotionIdSchema,
  sourceWorkspaceId: workspacePublicIdSchema,
  destinationWorkspaceId: workspacePublicIdSchema,
  acceptedManifestRoot: sha256DigestSchema,
  acceptedCounts: promotionEntityCountsSchema,
  activatedAt: epochMsSchema,
}).strict().refine(
  (receipt) => receipt.sourceWorkspaceId !== receipt.destinationWorkspaceId,
  "promotion destination must differ from the local source workspace",
);
export type PromotionActivationReceipt = z.infer<typeof promotionActivationReceiptSchema>;

const frozenPromotionBase = {
  promotionId: promotionIdSchema,
  manifest: promotionManifestSchema,
  localWritable: z.literal(false),
} as const;

export const workspacePromotionStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("local"), localWritable: z.literal(true) }).strict(),
  z.object({
    ...frozenPromotionBase,
    state: z.literal("promoting"),
    stagingWorkspaceId: workspacePublicIdSchema.optional(),
    acceptedBatchReceipts: z.array(promotionBatchReceiptSchema).max(
      MAX_PROMOTION_BATCH_RECEIPTS,
    ),
  }).strict(),
  z.object({
    ...frozenPromotionBase,
    state: z.literal("outcome_unknown"),
    stagingWorkspaceId: workspacePublicIdSchema,
  }).strict(),
  z.object({
    ...frozenPromotionBase,
    state: z.literal("promoted"),
    stagingWorkspaceId: workspacePublicIdSchema,
    activationReceipt: promotionActivationReceiptSchema,
  }).strict(),
  z.object({
    state: z.literal("aborted"),
    promotionId: promotionIdSchema,
    manifestRoot: sha256DigestSchema,
    preActivationAbortProvedAt: epochMsSchema,
    localWritable: z.literal(true),
  }).strict(),
]).superRefine((state, context) => {
  if (state.state === "local" || state.state === "aborted") return;
  if (state.promotionId !== state.manifest.promotionId) {
    context.addIssue({
      code: "custom",
      message: "promotion state and manifest IDs must match",
      path: ["manifest", "promotionId"],
    });
  }
  if (
    "stagingWorkspaceId" in state &&
    state.stagingWorkspaceId === state.manifest.sourceWorkspaceId
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion staging workspace must differ from its source",
      path: ["stagingWorkspaceId"],
    });
  }
  if (state.state === "promoting") {
    const batchIds = new Set<string>();
    const ordinals = new Map<string, Set<number>>();
    const acceptedCounts = Object.fromEntries(
      promotionEntityFamilyValues.map((family) => [family, 0]),
    ) as Record<(typeof promotionEntityFamilyValues)[number], number>;
    let previousAcceptedAt = -1;
    if (
      state.acceptedBatchReceipts.length > 0 &&
      state.stagingWorkspaceId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "accepted promotion receipts require a staging workspace",
        path: ["stagingWorkspaceId"],
      });
    }
    for (const [index, receipt] of state.acceptedBatchReceipts.entries()) {
      if (receipt.promotionId !== state.promotionId) {
        context.addIssue({
          code: "custom",
          message: "batch receipt belongs to another promotion session",
          path: ["acceptedBatchReceipts", index, "promotionId"],
        });
      }
      if (batchIds.has(receipt.batchId)) {
        context.addIssue({
          code: "custom",
          message: "promotion batch receipt IDs must be unique",
          path: ["acceptedBatchReceipts", index, "batchId"],
        });
      }
      batchIds.add(receipt.batchId);
      const familyOrdinals = ordinals.get(receipt.family) ?? new Set<number>();
      if (familyOrdinals.has(receipt.ordinal)) {
        context.addIssue({
          code: "custom",
          message: "promotion batch ordinals must be unique within a family",
          path: ["acceptedBatchReceipts", index, "ordinal"],
        });
      }
      familyOrdinals.add(receipt.ordinal);
      ordinals.set(receipt.family, familyOrdinals);
      if (receipt.acceptedAt < previousAcceptedAt) {
        context.addIssue({
          code: "custom",
          message: "promotion batch receipts must remain in acceptance order",
          path: ["acceptedBatchReceipts", index, "acceptedAt"],
        });
      }
      previousAcceptedAt = receipt.acceptedAt;
      acceptedCounts[receipt.family] += receipt.itemCount;
      for (const family of promotionEntityFamilyValues) {
        if (receipt.cumulativeCounts[family] !== acceptedCounts[family]) {
          context.addIssue({
            code: "custom",
            message: "batch receipt cumulative counts must equal the accepted receipt history",
            path: ["acceptedBatchReceipts", index, "cumulativeCounts", family],
          });
        }
        if (receipt.cumulativeCounts[family] > state.manifest.counts[family]) {
          context.addIssue({
            code: "custom",
            message: "batch receipt cumulative count exceeds the frozen manifest",
            path: ["acceptedBatchReceipts", index, "cumulativeCounts", family],
          });
        }
      }
    }
    for (const [family, values] of ordinals) {
      const ordered = [...values].sort((left, right) => left - right);
      ordered.forEach((ordinal, index) => {
        if (ordinal !== index) {
          context.addIssue({
            code: "custom",
            message: "promotion batch ordinals must be contiguous from zero",
            path: ["acceptedBatchReceipts"],
          });
        }
      });
      if (ordered.length > state.manifest.counts[
        family as keyof typeof state.manifest.counts
      ]) {
        context.addIssue({
          code: "custom",
          message: "promotion has more accepted batches than frozen entities",
          path: ["acceptedBatchReceipts"],
        });
      }
    }
  }
  if (state.state === "promoted") {
    const receipt = state.activationReceipt;
    if (
      receipt.promotionId !== state.promotionId ||
      receipt.sourceWorkspaceId !== state.manifest.sourceWorkspaceId ||
      receipt.destinationWorkspaceId !== state.stagingWorkspaceId ||
      receipt.acceptedManifestRoot !== state.manifest.rootDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "activation receipt does not match the frozen promotion manifest",
        path: ["activationReceipt"],
      });
    }
    for (const family of promotionEntityFamilyValues) {
      if (receipt.acceptedCounts[family] !== state.manifest.counts[family]) {
        context.addIssue({
          code: "custom",
          message: "activation receipt counts must equal the frozen manifest",
          path: ["activationReceipt", "acceptedCounts", family],
        });
      }
    }
  }
});
export type WorkspacePromotionState = z.infer<typeof workspacePromotionStateSchema>;

export const promotionSnapshotSchema = z.object({
  manifest: promotionManifestSchema,
  entities: z.array(promotionEntitySchema).max(MAX_PROMOTION_SNAPSHOT_ENTITIES),
}).strict().superRefine((snapshot, context) => {
  const expectedRootDigest = promotionSnapshotRootDigest(snapshot);
  if (snapshot.manifest.rootDigest !== expectedRootDigest) {
    context.addIssue({
      code: "custom",
      message: "promotion manifest root does not bind its canonical snapshot content",
      path: ["manifest", "rootDigest"],
    });
  }
  const counts = Object.fromEntries(
    promotionEntityFamilyValues.map((family) => [family, 0]),
  ) as Record<(typeof promotionEntityFamilyValues)[number], number>;
  const identities = new Set<string>();
  for (const [index, entity] of snapshot.entities.entries()) {
    counts[entity.family] += 1;
    const identity = `${entity.family}\u0000${promotionEntityIdentity(entity)}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "promotion snapshot entity identities must be unique within a family",
        path: ["entities", index],
      });
    }
    identities.add(identity);
    if (
      entity.family === "workspace_metadata" &&
      entity.workspaceId !== snapshot.manifest.sourceWorkspaceId
    ) {
      context.addIssue({
        code: "custom",
        message: "workspace metadata must describe the manifest source workspace",
        path: ["entities", index, "workspaceId"],
      });
    }
  }
  for (const family of promotionEntityFamilyValues) {
    if (counts[family] !== snapshot.manifest.counts[family]) {
      context.addIssue({
        code: "custom",
        message: "promotion snapshot count does not match its manifest",
        path: ["manifest", "counts", family],
      });
    }
  }

  const repositoryIds = snapshot.entities
    .filter((entity): entity is Extract<PromotionEntity, { family: "repositories" }> =>
      entity.family === "repositories")
    .map(({ id }) => id)
    .sort();
  const taskEntities = snapshot.entities
    .filter((entity): entity is Extract<PromotionEntity, { family: "tasks" }> =>
      entity.family === "tasks");
  const taskIds = taskEntities.map(({ id }) => id).sort();
  const taskById = new Map(taskEntities.map((task) => [task.id, task]));
  const repositoryIdSet = new Set(repositoryIds);
  const taskIdSet = new Set(taskIds);
  if (
    repositoryIds.join("\u0000") !== [...snapshot.manifest.repositoryIds].sort().join("\u0000")
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion repository IDs must exactly match snapshot entities",
      path: ["manifest", "repositoryIds"],
    });
  }
  if (taskIds.join("\u0000") !== [...snapshot.manifest.taskIds].sort().join("\u0000")) {
    context.addIssue({
      code: "custom",
      message: "promotion task IDs must exactly match snapshot entities",
      path: ["manifest", "taskIds"],
    });
  }
  const taskKeys = taskEntities.map(({ key }) => key);
  if (new Set(taskKeys).size !== taskKeys.length) {
    context.addIssue({
      code: "custom",
      message: "promotion task keys must be unique",
      path: ["entities"],
    });
  }
  const workspaceMetadata = snapshot.entities.find(
    (entity): entity is Extract<PromotionEntity, { family: "workspace_metadata" }> =>
      entity.family === "workspace_metadata",
  );
  if (
    workspaceMetadata !== undefined &&
    taskEntities.some(({ key }) => !key.startsWith(`${workspaceMetadata.keyPrefix}-`))
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion task keys must use the source workspace prefix",
      path: ["entities"],
    });
  }
  const taskBodyIds = new Set(
    snapshot.entities.flatMap((entity) =>
      entity.family === "task_bodies" ? [entity.taskId] : []),
  );
  for (const taskId of taskIds) {
    if (!taskBodyIds.has(taskId)) {
      context.addIssue({
        code: "custom",
        message: "every promoted task requires exactly one body",
        path: ["entities"],
      });
    }
  }

  const requireTask = (
    taskId: string,
    index: number,
    path: readonly (string | number)[],
  ): void => {
    if (!taskIdSet.has(taskId)) {
      context.addIssue({
        code: "custom",
        message: "promotion child entity references a task outside the manifest",
        path: ["entities", index, ...path],
      });
    }
  };
  const requireRepository = (
    repositoryId: string,
    index: number,
    path: readonly (string | number)[],
  ): void => {
    if (!repositoryIdSet.has(repositoryId)) {
      context.addIssue({
        code: "custom",
        message: "promotion child entity references a repository outside the manifest",
        path: ["entities", index, ...path],
      });
    }
  };
  const parentByTask = new Map<string, string>();
  const labelCountByTask = new Map<string, number>();
  const dependencyEdges: Array<readonly [blockerTaskId: string, blockedTaskId: string]> = [];
  for (const [index, entity] of snapshot.entities.entries()) {
    switch (entity.family) {
      case "workspace_metadata":
        break;
      case "executors":
        if (entity.workspaceId !== snapshot.manifest.sourceWorkspaceId) {
          context.addIssue({
            code: "custom",
            message: "promotion executor must belong to the manifest source workspace",
            path: ["entities", index, "workspaceId"],
          });
        }
        break;
      case "repositories":
      case "tasks":
        break;
      case "task_bodies":
      case "comments":
      case "submissions":
      case "reviews":
      case "terminal_states":
        requireTask(entity.taskId, index, ["taskId"]);
        break;
      case "labels":
        requireTask(entity.taskId, index, ["taskId"]);
        labelCountByTask.set(
          entity.taskId,
          (labelCountByTask.get(entity.taskId) ?? 0) + 1,
        );
        break;
      case "task_repository_links":
        requireTask(entity.taskId, index, ["taskId"]);
        requireRepository(entity.repositoryId, index, ["repositoryId"]);
        break;
      case "parent_edges":
        requireTask(entity.taskId, index, ["taskId"]);
        requireTask(entity.parentTaskId, index, ["parentTaskId"]);
        if (parentByTask.has(entity.taskId)) {
          context.addIssue({
            code: "custom",
            message: "a promoted task cannot have more than one parent",
            path: ["entities", index, "taskId"],
          });
        }
        parentByTask.set(entity.taskId, entity.parentTaskId);
        break;
      case "dependencies":
        requireTask(entity.blockerTaskId, index, ["blockerTaskId"]);
        requireTask(entity.blockedTaskId, index, ["blockedTaskId"]);
        dependencyEdges.push([entity.blockerTaskId, entity.blockedTaskId]);
        break;
      case "references":
        requireTask(entity.taskId, index, ["taskId"]);
        if (
          "repositoryId" in entity.reference &&
          entity.reference.repositoryId !== undefined
        ) {
          requireRepository(
            entity.reference.repositoryId,
            index,
            ["reference", "repositoryId"],
          );
        }
        break;
      case "imported_run_summaries":
        requireTask(entity.summary.taskId, index, ["summary", "taskId"]);
        requireTask(
          entity.summary.provenance.sourceTaskId,
          index,
          ["summary", "provenance", "sourceTaskId"],
        );
        if (
          entity.summary.provenance.sourceWorkspaceId !==
            snapshot.manifest.sourceWorkspaceId ||
          entity.summary.provenance.sourceTaskId !== entity.summary.taskId
        ) {
          context.addIssue({
            code: "custom",
            message: "imported run provenance must identify its manifest source task",
            path: ["entities", index, "summary", "provenance"],
          });
        }
        break;
    }
  }
  if ([...labelCountByTask.values()].some((count) => count > MAX_TASK_LABELS)) {
    context.addIssue({
      code: "custom",
      message: "promotion task labels exceed the portable per-task limit",
      path: ["entities"],
    });
  }
  const parentDepthByTask = new Map<string, number>();
  for (const taskId of parentByTask.keys()) {
    if (parentDepthByTask.has(taskId)) continue;
    const path: string[] = [];
    const pathPositions = new Map<string, number>();
    let current: string | undefined = taskId;
    let baseDepth = 0;
    let cycle = false;
    while (current !== undefined && parentByTask.has(current)) {
      const knownDepth = parentDepthByTask.get(current);
      if (knownDepth !== undefined) {
        baseDepth = knownDepth;
        break;
      }
      if (pathPositions.has(current)) {
        context.addIssue({
          code: "custom",
          message: "promotion parent graph cannot contain a cycle",
          path: ["entities"],
        });
        cycle = true;
        break;
      }
      pathPositions.set(current, path.length);
      path.push(current);
      current = parentByTask.get(current);
    }
    if (cycle) continue;
    for (const member of path.toReversed()) {
      baseDepth += 1;
      parentDepthByTask.set(member, baseDepth);
      if (baseDepth > MAX_PARENT_DEPTH) {
        context.addIssue({
          code: "custom",
          message: "promotion parent graph exceeds the portable depth limit",
          path: ["entities"],
        });
      }
    }
  }

  const dependentsByBlocker = new Map<string, string[]>();
  const blockerCountByTask = new Map<string, number>();
  for (const [blockerTaskId, blockedTaskId] of dependencyEdges) {
    const dependents = dependentsByBlocker.get(blockerTaskId) ?? [];
    dependents.push(blockedTaskId);
    dependentsByBlocker.set(blockerTaskId, dependents);
    blockerCountByTask.set(
      blockedTaskId,
      (blockerCountByTask.get(blockedTaskId) ?? 0) + 1,
    );
  }
  if (
    [...dependentsByBlocker.values()].some(
      (dependents) => dependents.length > MAX_BLOCKING_DEPENDENTS,
    ) ||
    [...blockerCountByTask.values()].some(
      (blockers) => blockers > MAX_DIRECT_BLOCKERS,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion dependency graph exceeds portable degree limits",
      path: ["entities"],
    });
  }
  const remainingBlockers = new Map(
    taskIds.map((taskId) => [taskId, blockerCountByTask.get(taskId) ?? 0]),
  );
  const ready = taskIds.filter((taskId) => remainingBlockers.get(taskId) === 0);
  let visitedTaskCount = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const blockerTaskId = ready[cursor];
    if (blockerTaskId === undefined) continue;
    visitedTaskCount += 1;
    for (const blockedTaskId of dependentsByBlocker.get(blockerTaskId) ?? []) {
      const remaining = (remainingBlockers.get(blockedTaskId) ?? 0) - 1;
      remainingBlockers.set(blockedTaskId, remaining);
      if (remaining === 0) ready.push(blockedTaskId);
    }
  }
  if (visitedTaskCount !== taskIds.length) {
    context.addIssue({
      code: "custom",
      message: "promotion dependency graph cannot contain a cycle",
      path: ["entities"],
    });
  }

  const submissions = snapshot.entities.filter(
    (entity): entity is Extract<PromotionEntity, { family: "submissions" }> =>
      entity.family === "submissions",
  );
  const reviews = snapshot.entities.filter(
    (entity): entity is Extract<PromotionEntity, { family: "reviews" }> =>
      entity.family === "reviews",
  );
  const submissionById = new Map(
    submissions.map((submission) => [submission.submissionId, submission]),
  );
  const reviewsBySubmission = new Map<string, typeof reviews>();
  for (const review of reviews) {
    const existing = reviewsBySubmission.get(review.submissionId) ?? [];
    reviewsBySubmission.set(review.submissionId, [...existing, review]);
  }
  for (const [index, submission] of submissions.entries()) {
    const matchingReviews = reviewsBySubmission.get(submission.submissionId) ?? [];
    const task = taskById.get(submission.taskId);
    if (
      task !== undefined &&
      submission.reviewRevision > task.reviewRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "a promotion submission cannot come from a future task review revision",
        path: ["entities", index, "reviewRevision"],
      });
    }
    if (submission.status === "pending" && matchingReviews.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "pending submissions cannot have a review row",
        path: ["entities", index],
      });
    }
    if (
      submission.status !== "pending" &&
      (
        matchingReviews.length !== 1 ||
        matchingReviews[0]?.decision !== submission.status
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "completed submissions require one matching review row",
        path: ["entities", index],
      });
    }
  }
  const submissionIds = new Set(submissions.map(({ submissionId }) => submissionId));
  for (const review of reviews) {
    if (!submissionIds.has(review.submissionId)) {
      context.addIssue({
        code: "custom",
        message: "a promotion review must reference an included submission",
        path: ["entities"],
      });
      continue;
    }
    const submission = submissionById.get(review.submissionId);
    if (submission !== undefined && submission.taskId !== review.taskId) {
      context.addIssue({
        code: "custom",
        message: "promotion review task must match its submission task",
        path: ["entities"],
      });
    }
  }
  const terminalStates = snapshot.entities.filter(
    (entity): entity is Extract<PromotionEntity, { family: "terminal_states" }> =>
      entity.family === "terminal_states",
  );
  const terminalStatesByTask = new Map<string, typeof terminalStates>();
  for (const terminalState of terminalStates) {
    const existing = terminalStatesByTask.get(terminalState.taskId) ?? [];
    terminalStatesByTask.set(terminalState.taskId, [...existing, terminalState]);
  }
  const pendingSubmissionCountByTask = new Map<string, number>();
  const pendingSubmissionByTask = new Map<string, (typeof submissions)[number]>();
  for (const submission of submissions) {
    if (submission.status === "pending") {
      pendingSubmissionCountByTask.set(
        submission.taskId,
        (pendingSubmissionCountByTask.get(submission.taskId) ?? 0) + 1,
      );
      pendingSubmissionByTask.set(submission.taskId, submission);
    }
  }
  for (const task of taskEntities) {
    const pending = pendingSubmissionCountByTask.get(task.id) ?? 0;
    if (
      (task.status === "in_review" && pending !== 1) ||
      (task.status !== "in_review" && pending !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "only in-review tasks carry exactly one pending submission",
        path: ["entities"],
      });
    }
    if (
      task.status === "in_review" &&
      pendingSubmissionByTask.get(task.id)?.reviewRevision !== task.reviewRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "the current pending submission must match the task review revision",
        path: ["entities"],
      });
    }
    const matchingTerminalStates = terminalStatesByTask.get(task.id) ?? [];
    const isTerminal = task.status === "done" || task.status === "cancelled";
    if (
      (isTerminal &&
        (
          matchingTerminalStates.length !== 1 ||
          matchingTerminalStates[0]?.status !== task.status
        )) ||
      (!isTerminal && matchingTerminalStates.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "promotion terminal state must exactly match the task lifecycle",
        path: ["entities"],
      });
    }
    const terminalState = matchingTerminalStates[0];
    if (task.status === "done" && terminalState?.status === "done") {
      const acceptedSubmission = submissionById.get(
        terminalState.acceptedSubmissionId,
      );
      if (acceptedSubmission === undefined) {
        context.addIssue({
          code: "custom",
          message: "a done terminal state must point to an included submission",
          path: ["entities"],
        });
      } else {
        if (acceptedSubmission.taskId !== task.id) {
          context.addIssue({
            code: "custom",
            message: "a done terminal state submission must belong to the same task",
            path: ["entities"],
          });
        }
        if (acceptedSubmission.status !== "accepted") {
          context.addIssue({
            code: "custom",
            message: "a done terminal state must point to an accepted submission",
            path: ["entities"],
          });
        }
        if (acceptedSubmission.reviewRevision !== task.reviewRevision) {
          context.addIssue({
            code: "custom",
            message: "a done terminal state must point to the current review revision",
            path: ["entities"],
          });
        }
        const acceptedReviews = (
          reviewsBySubmission.get(acceptedSubmission.submissionId) ?? []
        ).filter((review) => review.decision === "accepted");
        if (acceptedReviews.length !== 1) {
          context.addIssue({
            code: "custom",
            message: "a done terminal state must resolve one accepted review",
            path: ["entities"],
          });
        } else if (acceptedReviews[0]?.reviewedAt !== terminalState.terminalAt) {
          context.addIssue({
            code: "custom",
            message: "a done terminal state must match its accepted review time",
            path: ["entities"],
          });
        }
      }
    }
  }
});
export type PromotionSnapshot = z.infer<typeof promotionSnapshotSchema>;

export const PROMOTION_TRANSPORT_SCHEMA_VERSION = 2 as const;
export const MAX_PROMOTION_RECEIPT_PAGE_SIZE = 100;
export const MAX_PROMOTION_CURSOR_CHARACTERS = 8_192;

const promotionFamilyDigestShape = {
  workspace_metadata: sha256DigestSchema,
  executors: sha256DigestSchema,
  repositories: sha256DigestSchema,
  tasks: sha256DigestSchema,
  task_bodies: sha256DigestSchema,
  task_repository_links: sha256DigestSchema,
  parent_edges: sha256DigestSchema,
  dependencies: sha256DigestSchema,
  labels: sha256DigestSchema,
  comments: sha256DigestSchema,
  references: sha256DigestSchema,
  submissions: sha256DigestSchema,
  reviews: sha256DigestSchema,
  terminal_states: sha256DigestSchema,
  imported_run_summaries: sha256DigestSchema,
} as const;

export const promotionFamilyDigestMapSchema = z.object(
  promotionFamilyDigestShape,
).strict();
export type PromotionFamilyDigestMap = z.infer<
  typeof promotionFamilyDigestMapSchema
>;

export function promotionFamilyInitialDigest(
  family: (typeof promotionEntityFamilyValues)[number],
): string {
  const parsedFamily = promotionEntityFamilySchema.parse(family);
  return promotionSha256Digest(
    `${STABLE_PROMOTION_HASH_DOMAINS.familyV1}${canonicalPromotionJson({
      family: parsedFamily,
    })}`,
  );
}

export type PromotionFamilyDigestCheckpoint = Readonly<{
  count: number;
  digest: string;
  lastEntityIdentity: string | null;
}>;

/**
 * Advances one family digest without retaining prior rows. The fold is
 * independent of batch boundaries and requires strict canonical identity order.
 */
export function advancePromotionFamilyDigest(
  family: (typeof promotionEntityFamilyValues)[number],
  checkpoint: PromotionFamilyDigestCheckpoint,
  entities: readonly PromotionEntity[],
): PromotionFamilyDigestCheckpoint {
  const parsedFamily = promotionEntityFamilySchema.parse(family);
  const parsedCount = entityCountSchema.parse(checkpoint.count);
  let digest = sha256DigestSchema.parse(checkpoint.digest);
  let lastEntityIdentity = checkpoint.lastEntityIdentity;
  if (lastEntityIdentity !== null) {
    z.string().min(1).max(512).parse(lastEntityIdentity);
  }
  if (
    parsedCount === 0 &&
    (
      digest !== promotionFamilyInitialDigest(parsedFamily) ||
      lastEntityIdentity !== null
    )
  ) {
    throw new TypeError("empty promotion family checkpoint is not canonical");
  }
  if (parsedCount > 0 && lastEntityIdentity === null) {
    throw new TypeError("non-empty promotion family checkpoint requires its last identity");
  }
  if (parsedCount + entities.length > MAX_PROMOTION_SNAPSHOT_ENTITIES) {
    throw new TypeError("promotion family checkpoint exceeds the snapshot limit");
  }
  for (const [offset, input] of entities.entries()) {
    const entity = promotionEntitySchema.parse(input);
    if (entity.family !== parsedFamily) {
      throw new TypeError("promotion family digest received another entity family");
    }
    const identity = promotionEntityIdentity(entity);
    if (
      lastEntityIdentity !== null &&
      compareCanonicalText(lastEntityIdentity, identity) >= 0
    ) {
      throw new TypeError("promotion family entities must use strict identity order");
    }
    const index = parsedCount + offset;
    digest = promotionSha256Digest(
      `${STABLE_PROMOTION_HASH_DOMAINS.familyEntityV1}${canonicalPromotionJson({
        digest,
        entity,
        family: parsedFamily,
        identity,
        index,
      })}`,
    );
    lastEntityIdentity = identity;
  }
  return {
    count: parsedCount + entities.length,
    digest,
    lastEntityIdentity,
  };
}

export function promotionFamilyDigest(
  family: (typeof promotionEntityFamilyValues)[number],
  entities: readonly PromotionEntity[],
): string {
  return advancePromotionFamilyDigest(
    family,
    {
      count: 0,
      digest: promotionFamilyInitialDigest(family),
      lastEntityIdentity: null,
    },
    entities,
  ).digest;
}

export function promotionSnapshotFamilyDigests(
  entities: readonly PromotionEntity[],
): PromotionFamilyDigestMap {
  const parsedEntities = entities.map((entity) =>
    promotionEntitySchema.parse(entity));
  return promotionFamilyDigestMapSchema.parse(Object.fromEntries(
    promotionEntityFamilyValues.map((family) => {
      const familyEntities = parsedEntities
        .filter((entity) => entity.family === family)
        .sort((left, right) => compareCanonicalText(
          promotionEntityIdentity(left),
          promotionEntityIdentity(right),
        ));
      return [family, promotionFamilyDigest(family, familyEntities)];
    }),
  ));
}

const promotionTerminalLocalWorkSchema = z.object({
  queuedIntents: z.literal(0),
  activeClaims: z.literal(0),
  nonterminalRuns: z.literal(0),
  openInteractions: z.literal(0),
}).strict();

const promotionManifestV2Base = {
  schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
  promotionId: promotionIdSchema,
  sourceWorkspaceId: workspacePublicIdSchema,
  sourceWorkspaceRevision: positiveGenerationSchema,
  sourceEventSequence: workspaceEventSequenceSchema,
  createdAt: epochMsSchema,
  rootDigest: sha256DigestSchema,
  counts: promotionEntityCountsSchema,
  familyDigests: promotionFamilyDigestMapSchema,
  terminalLocalWork: promotionTerminalLocalWorkSchema,
} as const;

type PromotionManifestV2DigestInput = Readonly<{
  schemaVersion: typeof PROMOTION_TRANSPORT_SCHEMA_VERSION;
  promotionId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceRevision: number;
  sourceEventSequence: number;
  createdAt: number;
  counts: z.infer<typeof promotionEntityCountsSchema>;
  familyDigests: PromotionFamilyDigestMap;
  terminalLocalWork: z.infer<typeof promotionTerminalLocalWorkSchema>;
}>;

export function promotionManifestV2DigestPreimage(
  manifest: PromotionManifestV2DigestInput,
): string {
  return `${STABLE_PROMOTION_HASH_DOMAINS.manifestV2}${canonicalPromotionJson({
    counts: manifest.counts,
    createdAt: manifest.createdAt,
    familyDigests: manifest.familyDigests,
    promotionId: manifest.promotionId,
    schemaVersion: manifest.schemaVersion,
    sourceEventSequence: manifest.sourceEventSequence,
    sourceWorkspaceId: manifest.sourceWorkspaceId,
    sourceWorkspaceRevision: manifest.sourceWorkspaceRevision,
    terminalLocalWork: manifest.terminalLocalWork,
  })}`;
}

export function promotionManifestV2RootDigest(
  manifest: PromotionManifestV2DigestInput,
): string {
  return promotionSha256Digest(promotionManifestV2DigestPreimage(manifest));
}

/** Compact transport header; entity identities remain in bounded batch rows. */
export const promotionManifestV2Schema = z.object(
  promotionManifestV2Base,
).strict().superRefine((manifest, context) => {
  if (manifest.counts.workspace_metadata !== 1) {
    context.addIssue({
      code: "custom",
      message: "promotion must contain exactly one workspace metadata record",
      path: ["counts", "workspace_metadata"],
    });
  }
  if (manifest.counts.executors !== 1) {
    context.addIssue({
      code: "custom",
      message: "promotion must contain exactly one built-in executor",
      path: ["counts", "executors"],
    });
  }
  const totalEntities = promotionEntityFamilyValues.reduce(
    (total, family) => total + manifest.counts[family],
    0,
  );
  if (totalEntities > MAX_PROMOTION_SNAPSHOT_ENTITIES) {
    context.addIssue({
      code: "custom",
      message: "promotion manifest entity total exceeds the snapshot limit",
      path: ["counts"],
    });
  }
  for (const family of promotionEntityFamilyValues) {
    if (
      manifest.counts[family] === 0 &&
      manifest.familyDigests[family] !== promotionFamilyInitialDigest(family)
    ) {
      context.addIssue({
        code: "custom",
        message: "empty promotion families require the canonical initial digest",
        path: ["familyDigests", family],
      });
    }
  }
  if (manifest.rootDigest !== promotionManifestV2RootDigest(manifest)) {
    context.addIssue({
      code: "custom",
      message: "promotion manifest root does not bind its compact header",
      path: ["rootDigest"],
    });
  }
});
export type PromotionManifestV2 = z.infer<typeof promotionManifestV2Schema>;

const promotionBatchOrdinalSchema = z.number()
  .int()
  .nonnegative()
  .max(MAX_PROMOTION_BATCH_ORDINAL);
const promotionEntityIdentitySchema = z.string().min(1).max(512);

export const promotionBatchV2Schema = z.object({
  schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
  promotionId: promotionIdSchema,
  batchId: promotionBatchIdSchema,
  family: promotionEntityFamilySchema,
  ordinal: promotionBatchOrdinalSchema,
  previousFamilyCount: entityCountSchema,
  previousFamilyDigest: sha256DigestSchema,
  previousEntityIdentity: promotionEntityIdentitySchema.nullable(),
  items: z.array(promotionEntitySchema).min(1).max(500),
  requestDigest: sha256DigestSchema,
}).strict().superRefine((batch, context) => {
  let lastIdentity = batch.previousEntityIdentity;
  batch.items.forEach((item, index) => {
    if (item.family !== batch.family) {
      context.addIssue({
        code: "custom",
        message: "promotion batch items must match the declared family",
        path: ["items", index, "family"],
      });
    }
    const identity = promotionEntityIdentity(item);
    if (
      lastIdentity !== null &&
      compareCanonicalText(lastIdentity, identity) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "promotion batch identities must be in strict canonical order",
        path: ["items", index],
      });
    }
    lastIdentity = identity;
  });
  if (
    batch.previousFamilyCount === 0 &&
    (
      batch.previousFamilyDigest !== promotionFamilyInitialDigest(batch.family) ||
      batch.previousEntityIdentity !== null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "the first family batch requires an empty canonical checkpoint",
      path: ["previousFamilyDigest"],
    });
  }
  if (
    batch.previousFamilyCount > 0 &&
    batch.previousEntityIdentity === null
  ) {
    context.addIssue({
      code: "custom",
      message: "a resumed family batch requires its prior entity identity",
      path: ["previousEntityIdentity"],
    });
  }
  if (batch.requestDigest !== promotionBatchV2RequestDigest(batch)) {
    context.addIssue({
      code: "custom",
      message: "promotion batch digest does not bind its resumable request",
      path: ["requestDigest"],
    });
  }
});
export type PromotionBatchV2 = z.infer<typeof promotionBatchV2Schema>;

type PromotionBatchV2DigestInput = Omit<PromotionBatchV2, "requestDigest"> |
  PromotionBatchV2;

export function promotionBatchV2DigestPreimage(
  batch: PromotionBatchV2DigestInput,
): string {
  return `${STABLE_PROMOTION_HASH_DOMAINS.batchV2}${canonicalPromotionJson({
    batchId: batch.batchId,
    family: batch.family,
    items: batch.items,
    ordinal: batch.ordinal,
    previousEntityIdentity: batch.previousEntityIdentity,
    previousFamilyCount: batch.previousFamilyCount,
    previousFamilyDigest: batch.previousFamilyDigest,
    promotionId: batch.promotionId,
    schemaVersion: PROMOTION_TRANSPORT_SCHEMA_VERSION,
  })}`;
}

export function promotionBatchV2RequestDigest(
  batch: PromotionBatchV2DigestInput,
): string {
  return promotionSha256Digest(promotionBatchV2DigestPreimage(batch));
}

export const promotionBatchReceiptV2Schema = z.object({
  schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
  promotionId: promotionIdSchema,
  batchId: promotionBatchIdSchema,
  family: promotionEntityFamilySchema,
  ordinal: promotionBatchOrdinalSchema,
  itemCount: z.number().int().positive().max(500),
  requestDigest: sha256DigestSchema,
  acceptedRequestDigest: sha256DigestSchema,
  previousFamilyCount: entityCountSchema,
  previousFamilyDigest: sha256DigestSchema,
  cumulativeFamilyCount: entityCountSchema,
  cumulativeFamilyDigest: sha256DigestSchema,
  lastEntityIdentity: promotionEntityIdentitySchema,
  acceptedAt: epochMsSchema,
  cumulativeCounts: promotionEntityCountsSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.requestDigest !== receipt.acceptedRequestDigest) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt must prove the exact accepted request",
      path: ["acceptedRequestDigest"],
    });
  }
  if (
    receipt.cumulativeFamilyCount !==
      receipt.previousFamilyCount + receipt.itemCount
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt family count must advance by its item count",
      path: ["cumulativeFamilyCount"],
    });
  }
  if (
    receipt.cumulativeCounts[receipt.family] !== receipt.cumulativeFamilyCount
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt global and family counts must agree",
      path: ["cumulativeCounts", receipt.family],
    });
  }
});
export type PromotionBatchReceiptV2 = z.infer<
  typeof promotionBatchReceiptV2Schema
>;

export const promotionBatchAcceptanceV2Schema = z.object({
  batch: promotionBatchV2Schema,
  receipt: promotionBatchReceiptV2Schema,
}).strict().superRefine(({ batch, receipt }, context) => {
  for (const field of [
    "schemaVersion",
    "promotionId",
    "batchId",
    "family",
    "ordinal",
    "requestDigest",
    "previousFamilyCount",
    "previousFamilyDigest",
  ] as const) {
    if (batch[field] !== receipt[field]) {
      context.addIssue({
        code: "custom",
        message: `promotion receipt ${field} does not match its request`,
        path: ["receipt", field],
      });
    }
  }
  if (batch.items.length !== receipt.itemCount) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt item count does not match its request",
      path: ["receipt", "itemCount"],
    });
  }
  const advanced = advancePromotionFamilyDigest(
    batch.family,
    {
      count: batch.previousFamilyCount,
      digest: batch.previousFamilyDigest,
      lastEntityIdentity: batch.previousEntityIdentity,
    },
    batch.items,
  );
  if (
    receipt.cumulativeFamilyCount !== advanced.count ||
    receipt.cumulativeFamilyDigest !== advanced.digest ||
    receipt.lastEntityIdentity !== advanced.lastEntityIdentity
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt does not prove its cumulative family state",
      path: ["receipt", "cumulativeFamilyDigest"],
    });
  }
});
export type PromotionBatchAcceptanceV2 = z.infer<
  typeof promotionBatchAcceptanceV2Schema
>;

export type PromotionBatchReplayDisposition =
  | "accept"
  | "replay"
  | "conflict";

export function promotionBatchReplayDisposition(
  existing: PromotionBatchReceiptV2 | null,
  incoming: PromotionBatchV2,
): PromotionBatchReplayDisposition {
  if (existing === null) return "accept";
  return existing.promotionId === incoming.promotionId &&
      existing.batchId === incoming.batchId &&
      existing.family === incoming.family &&
      existing.ordinal === incoming.ordinal &&
      existing.requestDigest === incoming.requestDigest &&
      existing.previousFamilyCount === incoming.previousFamilyCount &&
      existing.previousFamilyDigest === incoming.previousFamilyDigest
    ? "replay"
    : "conflict";
}

export const promotionFamilyProgressSchema = z.object({
  family: promotionEntityFamilySchema,
  acceptedBatchCount: z.number()
    .int()
    .nonnegative()
    .max(MAX_PROMOTION_BATCH_ORDINAL + 1),
  acceptedEntityCount: entityCountSchema,
  cumulativeDigest: sha256DigestSchema,
  lastEntityIdentity: promotionEntityIdentitySchema.nullable(),
  complete: z.boolean(),
}).strict().superRefine((progress, context) => {
  if (
    progress.acceptedEntityCount === 0 &&
    (
      progress.acceptedBatchCount !== 0 ||
      progress.lastEntityIdentity !== null ||
      progress.cumulativeDigest !== promotionFamilyInitialDigest(progress.family)
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "empty promotion family progress must use its initial checkpoint",
    });
  }
  if (
    progress.acceptedEntityCount > 0 &&
    (
      progress.acceptedBatchCount === 0 ||
      progress.lastEntityIdentity === null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "non-empty promotion family progress requires batch and identity state",
    });
  }
});
export type PromotionFamilyProgress = z.infer<
  typeof promotionFamilyProgressSchema
>;

const promotionFamilyProgressMapShape = {
  workspace_metadata: promotionFamilyProgressSchema,
  executors: promotionFamilyProgressSchema,
  repositories: promotionFamilyProgressSchema,
  tasks: promotionFamilyProgressSchema,
  task_bodies: promotionFamilyProgressSchema,
  task_repository_links: promotionFamilyProgressSchema,
  parent_edges: promotionFamilyProgressSchema,
  dependencies: promotionFamilyProgressSchema,
  labels: promotionFamilyProgressSchema,
  comments: promotionFamilyProgressSchema,
  references: promotionFamilyProgressSchema,
  submissions: promotionFamilyProgressSchema,
  reviews: promotionFamilyProgressSchema,
  terminal_states: promotionFamilyProgressSchema,
  imported_run_summaries: promotionFamilyProgressSchema,
} as const;

export const promotionFamilyProgressMapSchema = z.object(
  promotionFamilyProgressMapShape,
).strict().superRefine((progress, context) => {
  for (const family of promotionEntityFamilyValues) {
    if (progress[family].family !== family) {
      context.addIssue({
        code: "custom",
        message: "promotion family progress key and value must agree",
        path: [family, "family"],
      });
    }
  }
});
export type PromotionFamilyProgressMap = z.infer<
  typeof promotionFamilyProgressMapSchema
>;

export function initialPromotionFamilyProgressMap(): PromotionFamilyProgressMap {
  return promotionFamilyProgressMapSchema.parse(Object.fromEntries(
    promotionEntityFamilyValues.map((family) => [
      family,
      {
        family,
        acceptedBatchCount: 0,
        acceptedEntityCount: 0,
        cumulativeDigest: promotionFamilyInitialDigest(family),
        lastEntityIdentity: null,
        complete: false,
      },
    ]),
  ));
}

export const promotionUploadProgressSchema = z.object({
  activeFamilyIndex: z.number()
    .int()
    .nonnegative()
    .max(promotionEntityFamilyValues.length),
  receiptCount: z.number()
    .int()
    .nonnegative()
    .max(MAX_PROMOTION_SNAPSHOT_ENTITIES),
  acceptedEntityCount: entityCountSchema,
  families: promotionFamilyProgressMapSchema,
}).strict().superRefine((progress, context) => {
  let acceptedEntityCount = 0;
  let receiptCount = 0;
  promotionEntityFamilyValues.forEach((family, index) => {
    const familyProgress = progress.families[family];
    acceptedEntityCount += familyProgress.acceptedEntityCount;
    receiptCount += familyProgress.acceptedBatchCount;
    if (index < progress.activeFamilyIndex && !familyProgress.complete) {
      context.addIssue({
        code: "custom",
        message: "every prior promotion family must be complete",
        path: ["families", family, "complete"],
      });
    }
    if (
      index > progress.activeFamilyIndex &&
      (
        familyProgress.complete ||
        familyProgress.acceptedBatchCount !== 0 ||
        familyProgress.acceptedEntityCount !== 0
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "later promotion families cannot advance early",
        path: ["families", family],
      });
    }
  });
  if (acceptedEntityCount !== progress.acceptedEntityCount) {
    context.addIssue({
      code: "custom",
      message: "promotion accepted entity total must equal family progress",
      path: ["acceptedEntityCount"],
    });
  }
  if (receiptCount !== progress.receiptCount) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt total must equal family progress",
      path: ["receiptCount"],
    });
  }
  if (
    progress.activeFamilyIndex === promotionEntityFamilyValues.length &&
    promotionEntityFamilyValues.some((family) => !progress.families[family].complete)
  ) {
    context.addIssue({
      code: "custom",
      message: "completed promotion upload requires every family",
      path: ["activeFamilyIndex"],
    });
  }
});
export type PromotionUploadProgress = z.infer<
  typeof promotionUploadProgressSchema
>;

export type PromotionBatchOrderDisposition =
  | "accept"
  | "family_out_of_order"
  | "ordinal_conflict"
  | "checkpoint_conflict"
  | "family_complete";

export function promotionBatchOrderDisposition(
  progress: PromotionUploadProgress,
  batch: PromotionBatchV2,
): PromotionBatchOrderDisposition {
  const parsedProgress = promotionUploadProgressSchema.parse(progress);
  const parsedBatch = promotionBatchV2Schema.parse(batch);
  const expectedFamily =
    promotionEntityFamilyValues[parsedProgress.activeFamilyIndex];
  if (expectedFamily !== parsedBatch.family) return "family_out_of_order";
  const family = parsedProgress.families[parsedBatch.family];
  if (family.complete) return "family_complete";
  if (parsedBatch.ordinal !== family.acceptedBatchCount) {
    return "ordinal_conflict";
  }
  if (
    parsedBatch.previousFamilyCount !== family.acceptedEntityCount ||
    parsedBatch.previousFamilyDigest !== family.cumulativeDigest ||
    parsedBatch.previousEntityIdentity !== family.lastEntityIdentity
  ) {
    return "checkpoint_conflict";
  }
  return "accept";
}

export const promotionReceiptAuditCursorSchema = z.string()
  .min(1)
  .max(MAX_PROMOTION_CURSOR_CHARACTERS)
  .regex(/^promotion_receipts_v1_[A-Za-z0-9_-]+$/u);

export const promotionBatchReceiptPageSchema = z.object({
  promotionId: promotionIdSchema,
  items: z.array(promotionBatchReceiptV2Schema)
    .max(MAX_PROMOTION_RECEIPT_PAGE_SIZE),
  cursor: promotionReceiptAuditCursorSchema.nullable(),
  hasMore: z.boolean(),
}).strict().superRefine((page, context) => {
  if (page.hasMore !== (page.cursor !== null)) {
    context.addIssue({
      code: "custom",
      message: "promotion receipt cursor exists exactly when another page exists",
      path: ["cursor"],
    });
  }
  const batchIds = new Set<string>();
  let previousAcceptedAt = -1;
  page.items.forEach((receipt, index) => {
    if (receipt.promotionId !== page.promotionId) {
      context.addIssue({
        code: "custom",
        message: "promotion receipt page cannot mix sessions",
        path: ["items", index, "promotionId"],
      });
    }
    if (receipt.acceptedAt < previousAcceptedAt) {
      context.addIssue({
        code: "custom",
        message: "promotion receipt page must retain acceptance order",
        path: ["items", index, "acceptedAt"],
      });
    }
    if (batchIds.has(receipt.batchId)) {
      context.addIssue({
        code: "custom",
        message: "promotion receipt page batch IDs must be unique",
        path: ["items", index, "batchId"],
      });
    }
    batchIds.add(receipt.batchId);
    previousAcceptedAt = receipt.acceptedAt;
  });
});
export type PromotionBatchReceiptPage = z.infer<
  typeof promotionBatchReceiptPageSchema
>;

const promotionServerReceiptIdSchema = z.string()
  .regex(/^promotion_receipt_[0-9A-HJKMNP-TV-Z]{26}$/u);
const promotionDecisionSequenceSchema = positiveGenerationSchema;

const activationReceiptV2DigestFields = {
  schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
  issuer: z.literal("convex_promotion_authority"),
  serverReceiptId: promotionServerReceiptIdSchema,
  promotionId: promotionIdSchema,
  sourceWorkspaceId: workspacePublicIdSchema,
  destinationWorkspaceId: workspacePublicIdSchema,
  acceptedManifestRoot: sha256DigestSchema,
  acceptedCounts: promotionEntityCountsSchema,
  acceptedFamilyDigests: promotionFamilyDigestMapSchema,
  decision: z.literal("activated"),
  decisionSequence: promotionDecisionSequenceSchema,
  activatedAt: epochMsSchema,
} as const;

export const promotionActivationReceiptV2DigestInputSchema = z.object(
  activationReceiptV2DigestFields,
).strict();
type PromotionActivationReceiptV2DigestInput = z.infer<
  typeof promotionActivationReceiptV2DigestInputSchema
>;

export function promotionActivationReceiptV2Digest(
  receipt: PromotionActivationReceiptV2DigestInput,
): string {
  return promotionSha256Digest(
    `${STABLE_PROMOTION_HASH_DOMAINS.activationReceiptV2}${canonicalPromotionJson({
      acceptedCounts: receipt.acceptedCounts,
      acceptedFamilyDigests: receipt.acceptedFamilyDigests,
      acceptedManifestRoot: receipt.acceptedManifestRoot,
      activatedAt: receipt.activatedAt,
      decision: receipt.decision,
      decisionSequence: receipt.decisionSequence,
      destinationWorkspaceId: receipt.destinationWorkspaceId,
      issuer: receipt.issuer,
      promotionId: receipt.promotionId,
      schemaVersion: receipt.schemaVersion,
      serverReceiptId: receipt.serverReceiptId,
      sourceWorkspaceId: receipt.sourceWorkspaceId,
    })}`,
  );
}

export const promotionActivationReceiptV2Schema = z.object({
  ...activationReceiptV2DigestFields,
  receiptDigest: sha256DigestSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.sourceWorkspaceId === receipt.destinationWorkspaceId) {
    context.addIssue({
      code: "custom",
      message: "promotion destination must differ from its source",
      path: ["destinationWorkspaceId"],
    });
  }
  if (receipt.receiptDigest !== promotionActivationReceiptV2Digest(receipt)) {
    context.addIssue({
      code: "custom",
      message: "activation receipt digest does not bind its server proof",
      path: ["receiptDigest"],
    });
  }
});
export type PromotionActivationReceiptV2 = z.infer<
  typeof promotionActivationReceiptV2Schema
>;

const abortReceiptV2DigestFields = {
  schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
  issuer: z.literal("convex_promotion_authority"),
  serverReceiptId: promotionServerReceiptIdSchema,
  promotionId: promotionIdSchema,
  sourceWorkspaceId: workspacePublicIdSchema,
  stagingWorkspaceId: workspacePublicIdSchema,
  manifestRoot: sha256DigestSchema,
  decision: z.literal("aborted_before_activation"),
  decisionSequence: promotionDecisionSequenceSchema,
  abortedAt: epochMsSchema,
} as const;

export const promotionAbortReceiptV2DigestInputSchema = z.object(
  abortReceiptV2DigestFields,
).strict();
type PromotionAbortReceiptV2DigestInput = z.infer<
  typeof promotionAbortReceiptV2DigestInputSchema
>;

export function promotionAbortReceiptV2Digest(
  receipt: PromotionAbortReceiptV2DigestInput,
): string {
  return promotionSha256Digest(
    `${STABLE_PROMOTION_HASH_DOMAINS.abortReceiptV2}${canonicalPromotionJson({
      abortedAt: receipt.abortedAt,
      decision: receipt.decision,
      decisionSequence: receipt.decisionSequence,
      issuer: receipt.issuer,
      manifestRoot: receipt.manifestRoot,
      promotionId: receipt.promotionId,
      schemaVersion: receipt.schemaVersion,
      serverReceiptId: receipt.serverReceiptId,
      sourceWorkspaceId: receipt.sourceWorkspaceId,
      stagingWorkspaceId: receipt.stagingWorkspaceId,
    })}`,
  );
}

export const promotionAbortReceiptV2Schema = z.object({
  ...abortReceiptV2DigestFields,
  receiptDigest: sha256DigestSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.sourceWorkspaceId === receipt.stagingWorkspaceId) {
    context.addIssue({
      code: "custom",
      message: "promotion staging workspace must differ from its source",
      path: ["stagingWorkspaceId"],
    });
  }
  if (receipt.receiptDigest !== promotionAbortReceiptV2Digest(receipt)) {
    context.addIssue({
      code: "custom",
      message: "abort receipt digest does not bind its server proof",
      path: ["receiptDigest"],
    });
  }
});
export type PromotionAbortReceiptV2 = z.infer<
  typeof promotionAbortReceiptV2Schema
>;

export const promotionDecisionProofV2Schema = z.discriminatedUnion("decision", [
  promotionActivationReceiptV2Schema,
  promotionAbortReceiptV2Schema,
]);
export type PromotionDecisionProofV2 = z.infer<
  typeof promotionDecisionProofV2Schema
>;

const promotionV2FrozenBase = {
  schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
  promotionId: promotionIdSchema,
  manifest: promotionManifestV2Schema,
  stagingWorkspaceId: workspacePublicIdSchema,
  localWritable: z.literal(false),
} as const;

export const promotionRejectionCodeValues = [
  "authorization_lost",
  "staged_entity_invalid",
  "family_digest_mismatch",
  "projection_incomplete",
  "projection_failed",
] as const;
export const promotionRejectionCodeSchema = z.enum(
  promotionRejectionCodeValues,
);
export type PromotionRejectionCode = z.infer<
  typeof promotionRejectionCodeSchema
>;

export const workspacePromotionStateV2Schema = z.discriminatedUnion("state", [
  z.object({
    ...promotionV2FrozenBase,
    state: z.enum([
      "receiving",
      "validating",
      "projecting",
      "ready",
      "outcome_unknown",
    ]),
    progress: promotionUploadProgressSchema,
  }).strict(),
  z.object({
    ...promotionV2FrozenBase,
    state: z.literal("rejected"),
    rejectionCode: promotionRejectionCodeSchema,
    progress: promotionUploadProgressSchema,
  }).strict(),
  z.object({
    ...promotionV2FrozenBase,
    state: z.literal("activated"),
    activationReceipt: promotionActivationReceiptV2Schema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(PROMOTION_TRANSPORT_SCHEMA_VERSION),
    state: z.literal("aborted"),
    promotionId: promotionIdSchema,
    sourceWorkspaceId: workspacePublicIdSchema,
    manifestRoot: sha256DigestSchema,
    stagingWorkspaceId: workspacePublicIdSchema,
    abortReceipt: promotionAbortReceiptV2Schema,
    localWritable: z.literal(true),
  }).strict(),
]).superRefine((state, context) => {
  if (state.state === "aborted") {
    if (
      state.abortReceipt.promotionId !== state.promotionId ||
      state.abortReceipt.sourceWorkspaceId !== state.sourceWorkspaceId ||
      state.abortReceipt.manifestRoot !== state.manifestRoot ||
      state.abortReceipt.stagingWorkspaceId !== state.stagingWorkspaceId
    ) {
      context.addIssue({
        code: "custom",
        message: "abort proof must identify the frozen promotion",
        path: ["abortReceipt"],
      });
    }
    return;
  }
  if (
    state.promotionId !== state.manifest.promotionId ||
    state.stagingWorkspaceId === state.manifest.sourceWorkspaceId
  ) {
    context.addIssue({
      code: "custom",
      message: "promotion state must identify one source and destination",
      path: ["stagingWorkspaceId"],
    });
  }
  if (state.state === "activated") {
    const receipt = state.activationReceipt;
    if (
      receipt.promotionId !== state.promotionId ||
      receipt.sourceWorkspaceId !== state.manifest.sourceWorkspaceId ||
      receipt.destinationWorkspaceId !== state.stagingWorkspaceId ||
      receipt.acceptedManifestRoot !== state.manifest.rootDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "activation proof must identify the frozen promotion",
        path: ["activationReceipt"],
      });
    }
    for (const family of promotionEntityFamilyValues) {
      if (
        receipt.acceptedCounts[family] !== state.manifest.counts[family] ||
        receipt.acceptedFamilyDigests[family] !==
          state.manifest.familyDigests[family]
      ) {
        context.addIssue({
          code: "custom",
          message: "activation proof must match every manifest family",
          path: ["activationReceipt", "acceptedFamilyDigests", family],
        });
      }
    }
    return;
  }
  for (const family of promotionEntityFamilyValues) {
    const familyProgress = state.progress.families[family];
    if (
      familyProgress.acceptedEntityCount > state.manifest.counts[family]
    ) {
      context.addIssue({
        code: "custom",
        message: "promotion progress exceeds the frozen manifest",
        path: ["progress", "families", family, "acceptedEntityCount"],
      });
    }
    if (
      familyProgress.complete &&
      (
        familyProgress.acceptedEntityCount !== state.manifest.counts[family] ||
        familyProgress.cumulativeDigest !== state.manifest.familyDigests[family]
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "completed family progress must match its frozen manifest",
        path: ["progress", "families", family],
      });
    }
  }
  if (
    state.state !== "receiving" &&
    state.progress.activeFamilyIndex !== promotionEntityFamilyValues.length
  ) {
    context.addIssue({
      code: "custom",
      message: "post-upload promotion phases require every family checkpoint",
      path: ["progress", "activeFamilyIndex"],
    });
  }
});
export type WorkspacePromotionStateV2 = z.infer<
  typeof workspacePromotionStateV2Schema
>;

export const promotionCleanupCursorSchema = z.string()
  .min(1)
  .max(MAX_PROMOTION_CURSOR_CHARACTERS)
  .regex(/^promotion_cleanup_v1_[A-Za-z0-9_-]+$/u);

export const promotionCleanupProgressSchema = z.object({
  promotionId: promotionIdSchema,
  scope: z.enum(["staging_rows", "all_promotion_owned_rows"]),
  state: z.enum(["pending", "running", "complete"]),
  deletedEntityCount: entityCountSchema,
  cursor: promotionCleanupCursorSchema.nullable(),
  decisionProofRetained: z.literal(true),
}).strict().superRefine((cleanup, context) => {
  if ((cleanup.state === "complete") !== (cleanup.cursor === null)) {
    context.addIssue({
      code: "custom",
      message: "only completed cleanup omits its next cursor",
      path: ["cursor"],
    });
  }
});
export type PromotionCleanupProgress = z.infer<
  typeof promotionCleanupProgressSchema
>;
