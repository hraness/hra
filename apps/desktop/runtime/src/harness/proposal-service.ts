import { createHash } from "node:crypto";
import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import type { RlmV2JsonValue } from "./rlm-v2";

export const HARNESS_PROPOSAL_BODY_MAX_UTF8_BYTES = 256 * 1024;
export const HARNESS_PROPOSAL_LIST_LIMIT = 32;
export const HARNESS_PROPOSAL_ADMISSION_LIMIT = 32;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const proposalIdSchema = z.string()
  .min(19)
  .max(96)
  .regex(/^hproposal_[A-Za-z0-9_-]+$/u);
const valueIdSchema = z.string()
  .min(16)
  .max(96)
  .regex(/^ctxval_[A-Za-z0-9_-]+$/u);
const operationIdSchema = z.string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]+$/u);
const timestampSchema = z.string().datetime({ offset: true });
const titleSchema = z.string().min(1).max(160).refine(
  (title) => title === title.trim() && !title.includes("\0"),
  "proposal title must be trimmed and NUL-free",
);

const proposalRecordSchema = z.object({
  id: proposalIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema,
  operationId: operationIdSchema,
  title: titleSchema,
  bodyValueId: valueIdSchema,
  bodyDigest: digestSchema,
  state: z.enum(["prepared", "active", "recoveryRequired"]),
  recoveryReason: z.string().min(1).max(96).nullable(),
  revision: z.number().int().positive().safe(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  activatedAt: timestampSchema.nullable(),
}).strict().superRefine((proposal, context) => {
  if ((proposal.state === "active") !== (proposal.activatedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "only active proposals have an activation timestamp",
      path: ["activatedAt"],
    });
  }
  if ((proposal.state === "recoveryRequired") !==
      (proposal.recoveryReason !== null)) {
    context.addIssue({
      code: "custom",
      message: "only recovery-required proposals have a recovery reason",
      path: ["recoveryReason"],
    });
  }
});

const proposeInputSchema = z.object({
  receiptId: operationIdSchema,
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  turnId: actorTurnIdSchema,
  title: titleSchema,
  body: z.unknown(),
  contextQuotaBytes: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024),
}).strict();

const listInputSchema = z.object({
  afterProposalId: proposalIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(HARNESS_PROPOSAL_LIST_LIMIT),
}).strict();

export type HarnessProposalRecord = z.infer<typeof proposalRecordSchema>;
export type HarnessProposeInput = z.infer<typeof proposeInputSchema>;

export interface HarnessProposalAuthorityPort {
  refinementMode(): Promise<"off" | "suggest">;
  prepare(input: Readonly<{
    id: string;
    epochId: string;
    actorId: string;
    sourceTurnId: string;
    operationId: string;
    title: string;
    bodyValueId: string;
    bodyDigest: string;
  }>): Promise<unknown>;
  activate(input: Readonly<{
    id: string;
    expectedRevision: number;
  }>): Promise<unknown>;
  read(id: string): Promise<unknown>;
  list(input: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): Promise<unknown>;
}

export interface HarnessProposalRecoveryAuthorityPort {
  listPrepared(input: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): Promise<unknown>;
  inspectPreparedBody(id: string): Promise<"missing" | "exact" | "conflict">;
  activateRecovered(input: Readonly<{
    id: string;
    expectedRevision: number;
  }>): Promise<unknown>;
  markRecoveryRequired(input: Readonly<{
    id: string;
    expectedRevision: number;
    reason:
      | "body_missing"
      | "body_conflict"
      | "body_content_mismatch"
      | "capacity_exhausted";
  }>): Promise<unknown>;
}

export interface HarnessProposalValuePort {
  put(input: Readonly<{
    operationId: string;
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string;
    valueId: string;
    kind: "json";
    purpose: "proposal";
    plaintext: string;
    quotaLimitBytes: number;
  }>): Promise<unknown>;
  get(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string;
    valueId: string;
  }>): Promise<Readonly<{ plaintext: string }>>;
}

export interface HarnessProposalSummary {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
}

export class HarnessProposalServiceError extends Error {
  readonly code:
    | "capacity_exhausted"
    | "disabled"
    | "identity_conflict"
    | "invalid_body"
    | "not_found"
    | "recovery_required";

  constructor(code: HarnessProposalServiceError["code"]) {
    super({
      capacity_exhausted: "The harness proposal admission limit is exhausted.",
      disabled: "Harness proposal suggestions are disabled.",
      identity_conflict: "The immutable harness proposal identity conflicts.",
      invalid_body: "The harness proposal body is invalid or too large.",
      not_found: "The harness proposal is unavailable.",
      recovery_required: "The harness proposal requires recovery.",
    }[code]);
    this.name = "HarnessProposalServiceError";
    this.code = code;
  }
}

/**
 * Suggest-only continual layer. It records immutable local proposals and has
 * deliberately no decision, evaluation, activation, rollback, or delete API.
 */
export class HarnessProposalService {
  readonly #authority: HarnessProposalAuthorityPort;
  readonly #values: HarnessProposalValuePort;

  constructor(input: Readonly<{
    authority: HarnessProposalAuthorityPort;
    values: HarnessProposalValuePort;
  }>) {
    this.#authority = input.authority;
    this.#values = input.values;
  }

  async propose(inputValue: unknown): Promise<HarnessProposalSummary> {
    await this.#assertSuggestEnabled();
    const parsed = proposeInputSchema.safeParse(inputValue);
    if (!parsed.success || !isJsonValue(parsed.data.body)) {
      throw new HarnessProposalServiceError("invalid_body");
    }
    const input = parsed.data as Omit<HarnessProposeInput, "body"> & {
      body: RlmV2JsonValue;
    };
    const plaintext = canonicalJson(input.body);
    if (Buffer.byteLength(plaintext, "utf8") > HARNESS_PROPOSAL_BODY_MAX_UTF8_BYTES) {
      throw new HarnessProposalServiceError("invalid_body");
    }
    const bodyDigest = digest("body", plaintext);
    const id = proposalId(input.receiptId);
    const bodyValueId = proposalValueId(input.receiptId);
    const bodyOperationId = proposalBodyOperationId(input.receiptId);
    let proposal: HarnessProposalRecord;
    try {
      proposal = parseRecord(await this.#authority.prepare({
        id,
        epochId: input.epochId,
        actorId: input.actorId,
        sourceTurnId: input.turnId,
        operationId: input.receiptId,
        title: input.title,
        bodyValueId,
        bodyDigest,
      }));
    } catch (error: unknown) {
      rethrowAuthority(error);
    }
    assertIdentity(proposal, {
      id,
      epochId: input.epochId,
      actorId: input.actorId,
      sourceTurnId: input.turnId,
      operationId: input.receiptId,
      title: input.title,
      bodyValueId,
      bodyDigest,
    });
    if (proposal.state === "recoveryRequired") {
      throw new HarnessProposalServiceError("recovery_required");
    }
    await this.#assertSuggestEnabled();
    if (proposal.state === "active") return summary(proposal);

    await this.#values.put({
      operationId: bodyOperationId,
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: input.turnId,
      valueId: bodyValueId,
      kind: "json",
      purpose: "proposal",
      plaintext,
      quotaLimitBytes: input.contextQuotaBytes,
    });
    await this.#assertSuggestEnabled();
    let active: HarnessProposalRecord;
    try {
      active = parseRecord(await this.#authority.activate({
        id,
        expectedRevision: proposal.revision,
      }));
    } catch (error: unknown) {
      rethrowAuthority(error);
    }
    assertIdentity(active, proposal);
    if (
      active.state === "recoveryRequired" &&
      active.recoveryReason === "capacity_exhausted"
    ) {
      throw new HarnessProposalServiceError("capacity_exhausted");
    }
    if (active.state !== "active") {
      throw new HarnessProposalServiceError("identity_conflict");
    }
    return summary(active);
  }

  async #assertSuggestEnabled(): Promise<void> {
    if (await this.#authority.refinementMode() !== "suggest") {
      throw new HarnessProposalServiceError("disabled");
    }
  }

  async list(inputValue: unknown): Promise<readonly HarnessProposalSummary[]> {
    const input = listInputSchema.parse(inputValue);
    const rows = await this.#authority.list(input);
    if (!Array.isArray(rows) || rows.length > input.limit) {
      throw new HarnessProposalServiceError("identity_conflict");
    }
    const proposals = rows.map(parseRecord);
    let previous = input.afterProposalId;
    for (const proposal of proposals) {
      if (
        proposal.state !== "active" ||
        (previous !== null && proposal.id <= previous)
      ) throw new HarnessProposalServiceError("identity_conflict");
      previous = proposal.id;
    }
    return Object.freeze(proposals.map(summary));
  }

  async get(inputValue: unknown): Promise<Readonly<{
    summary: HarnessProposalSummary;
    body: RlmV2JsonValue;
  }>> {
    const id = proposalIdSchema.parse(inputValue);
    const source = await this.#authority.read(id);
    if (source === null) throw new HarnessProposalServiceError("not_found");
    const proposal = parseRecord(source);
    if (proposal.id !== id || proposal.state !== "active") {
      throw new HarnessProposalServiceError(
        proposal.state === "recoveryRequired" ? "recovery_required" : "not_found",
      );
    }
    const value = await this.#values.get({
      epochId: proposal.epochId,
      ownerActorId: proposal.actorId,
      sourceTurnId: proposal.sourceTurnId,
      valueId: proposal.bodyValueId,
    });
    if (digest("body", value.plaintext) !== proposal.bodyDigest) {
      throw new HarnessProposalServiceError("recovery_required");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.plaintext) as unknown;
    } catch {
      throw new HarnessProposalServiceError("recovery_required");
    }
    if (!isJsonValue(parsed) || canonicalJson(parsed) !== value.plaintext) {
      throw new HarnessProposalServiceError("recovery_required");
    }
    return Object.freeze({ summary: summary(proposal), body: parsed });
  }
}

export interface HarnessProposalRecoveryReportV2 {
  readonly inspectedProposalIds: readonly string[];
  readonly activatedProposalIds: readonly string[];
  readonly recoveryRequiredProposalIds: readonly string[];
}

/** Bounded restart recovery for the proposal prepare/body/activate protocol. */
export class HarnessProposalRecoveryV2 {
  readonly #authority: HarnessProposalRecoveryAuthorityPort;
  readonly #values: HarnessProposalValuePort;
  readonly #pageLimit: number;
  readonly #maxRecords: number;

  constructor(input: Readonly<{
    authority: HarnessProposalRecoveryAuthorityPort;
    values: HarnessProposalValuePort;
    pageLimit?: number;
    maxRecords?: number;
  }>) {
    this.#authority = input.authority;
    this.#values = input.values;
    this.#pageLimit = z.number().int().min(1)
      .max(HARNESS_PROPOSAL_LIST_LIMIT).parse(input.pageLimit ?? 32);
    this.#maxRecords = z.number().int().min(1).max(100_000)
      .parse(input.maxRecords ?? 100_000);
  }

  async recover(): Promise<HarnessProposalRecoveryReportV2> {
    const inspected: string[] = [];
    const activated: string[] = [];
    const recoveryRequired: string[] = [];
    let afterProposalId: string | null = null;
    while (true) {
      const source = await this.#authority.listPrepared({
        afterProposalId,
        limit: this.#pageLimit,
      });
      if (!Array.isArray(source) || source.length > this.#pageLimit) {
        throw new HarnessProposalServiceError("identity_conflict");
      }
      const page = source.map(parseRecord);
      if (inspected.length + page.length > this.#maxRecords) {
        throw new HarnessProposalServiceError("identity_conflict");
      }
      let previous = afterProposalId;
      for (const proposal of page) {
        if (
          proposal.state !== "prepared" ||
          (previous !== null && proposal.id <= previous)
        ) throw new HarnessProposalServiceError("identity_conflict");
        previous = proposal.id;
        const recovered = await this.#recoverOne(proposal);
        inspected.push(proposal.id);
        if (recovered.state === "active") activated.push(proposal.id);
        else if (recovered.state === "recoveryRequired") {
          recoveryRequired.push(proposal.id);
        } else {
          throw new HarnessProposalServiceError("identity_conflict");
        }
      }
      if (page.length < this.#pageLimit) break;
      afterProposalId = page.at(-1)!.id;
    }
    return Object.freeze({
      inspectedProposalIds: Object.freeze(inspected),
      activatedProposalIds: Object.freeze(activated),
      recoveryRequiredProposalIds: Object.freeze(recoveryRequired),
    });
  }

  async #recoverOne(
    proposal: HarnessProposalRecord,
  ): Promise<HarnessProposalRecord> {
    const bodyState = await this.#authority.inspectPreparedBody(proposal.id);
    if (bodyState !== "exact") {
      return parseRecord(await this.#authority.markRecoveryRequired({
        id: proposal.id,
        expectedRevision: proposal.revision,
        reason: bodyState === "missing" ? "body_missing" : "body_conflict",
      }));
    }

    let plaintext: string;
    try {
      plaintext = (await this.#values.get({
        epochId: proposal.epochId,
        ownerActorId: proposal.actorId,
        sourceTurnId: proposal.sourceTurnId,
        valueId: proposal.bodyValueId,
      })).plaintext;
    } catch (error: unknown) {
      if (!isPermanentProposalBodyFailure(error)) throw error;
      return parseRecord(await this.#authority.markRecoveryRequired({
        id: proposal.id,
        expectedRevision: proposal.revision,
        reason: "body_conflict",
      }));
    }
    if (!isExactProposalBody(plaintext, proposal.bodyDigest)) {
      return parseRecord(await this.#authority.markRecoveryRequired({
        id: proposal.id,
        expectedRevision: proposal.revision,
        reason: "body_content_mismatch",
      }));
    }
    return parseRecord(await this.#authority.activateRecovered({
      id: proposal.id,
      expectedRevision: proposal.revision,
    }));
  }
}

export function proposalId(receiptIdValue: unknown): string {
  const receiptId = operationIdSchema.parse(receiptIdValue);
  return proposalIdSchema.parse(`hproposal_${digest("proposal", receiptId).slice(0, 48)}`);
}

export function proposalValueId(receiptIdValue: unknown): string {
  const receiptId = operationIdSchema.parse(receiptIdValue);
  return valueIdSchema.parse(`ctxval_${digest("proposal-value", receiptId).slice(0, 48)}`);
}

export function proposalBodyOperationId(receiptIdValue: unknown): string {
  const receiptId = operationIdSchema.parse(receiptIdValue);
  return operationIdSchema.parse(`proposalbody_${digest("proposal-body", receiptId)}`);
}

function parseRecord(value: unknown): HarnessProposalRecord {
  return proposalRecordSchema.parse(value);
}

function summary(proposal: HarnessProposalRecord): HarnessProposalSummary {
  return Object.freeze({
    id: proposal.id,
    revision: proposal.revision,
    title: proposal.title,
  });
}

function assertIdentity(
  observed: HarnessProposalRecord,
  expected: Readonly<{
    id: string;
    epochId: string;
    actorId: string;
    sourceTurnId: string;
    operationId: string;
    title: string;
    bodyValueId: string;
    bodyDigest: string;
  }>,
): void {
  if (
    observed.id !== expected.id || observed.epochId !== expected.epochId ||
    observed.actorId !== expected.actorId ||
    observed.sourceTurnId !== expected.sourceTurnId ||
    observed.operationId !== expected.operationId ||
    observed.title !== expected.title ||
    observed.bodyValueId !== expected.bodyValueId ||
    observed.bodyDigest !== expected.bodyDigest
  ) throw new HarnessProposalServiceError("identity_conflict");
}

function rethrowAuthority(error: unknown): never {
  if (
    typeof error === "object" && error !== null &&
    "code" in error &&
    (error.code === "disabled" || error.code === "capacity_exhausted")
  ) throw new HarnessProposalServiceError(error.code);
  throw error;
}

function digest(domain: string, value: string): string {
  return createHash("sha256")
    .update(`oprte.harness.${domain}.v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function canonicalJson(value: RlmV2JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, RlmV2JsonValue>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isJsonValue(value: unknown, depth = 0): value is RlmV2JsonValue {
  if (depth > 16) return false;
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isSafeInteger(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 32 && value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length <= 32 && keys.every((key) =>
    key !== "__proto__" && key !== "constructor" && key !== "prototype" &&
    isJsonValue(record[key], depth + 1)
  );
}

function isExactProposalBody(plaintext: string, expectedDigest: string): boolean {
  if (Buffer.byteLength(plaintext, "utf8") > HARNESS_PROPOSAL_BODY_MAX_UTF8_BYTES) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    return false;
  }
  return isJsonValue(parsed) && canonicalJson(parsed) === plaintext &&
    digest("body", plaintext) === expectedDigest;
}

function isPermanentProposalBodyFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "content_mismatch" || error.code === "invalid_metadata" ||
    error.code === "recovery_required" || error.code === "value_missing";
}
