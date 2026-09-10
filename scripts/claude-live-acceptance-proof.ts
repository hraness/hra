import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  ClaudeHostToolPublicResult,
  ClaudeHostToolResponseWritten,
} from "../src/claude/index";
import { digestClaudeHostToolInvocation } from "../src/claude/index";
import type { OompaHostToolCall } from "../src/codex/protocol";
import type { LiveAcceptanceClaudeProofPort } from "../src/cli";
import type { ProfileAuthority } from "../src/daemon/ports";
import { parseOompaHostToolRequest, type OompaMemoryRememberInput } from "../src/domain/host-tools";
import { claudeProviderAccountAuthoritySchema } from "../src/domain/provider-accounts";
import { profileIdSchema, sessionIdSchema, type ProfileId, type SessionId } from "../src/domain/values";
import { OOMPA_VERSION } from "../src/version";
import {
  liveAcceptanceCandidateSchema,
  type LiveAcceptanceCandidate,
} from "./live-acceptance-installation";
import { canonicalDigest } from "./release-evidence";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveIntegerSchema = z.number().int().positive().safe();
const providerIdentifierSchema = z.string().min(1).max(512)
  .refine((value) => !/\p{Cc}|\p{Cs}/u.test(value));

const rememberResultSchema = z.object({
  version: z.literal(1),
  ok: z.literal(true),
  replay: z.literal(false),
  idempotencyRetainedUntil: z.string().datetime({ offset: true }),
  submission: z.object({
    id: z.string().regex(/^memsub_[0-9a-f]{32}$/u),
    kind: z.literal("remember"),
    state: z.literal("applied"),
  }).strict(),
  workingHead: z.object({
    digest: digestSchema,
    operationSha256: digestSchema,
    sequence: positiveIntegerSchema,
  }).strict(),
  page: z.object({
    key: z.string().min(1).max(504),
    operationSha256: digestSchema,
    recordSha256: digestSchema,
  }).strict(),
  receiptSha256: digestSchema,
}).strict();

export type ClaudeLiveAcceptanceRememberResult = z.infer<typeof rememberResultSchema>;

const freshSessionScopeSchema = z.object({
  daemonGeneration: positiveIntegerSchema,
  memory: z.unknown(),
  profileGeneration: positiveIntegerSchema,
  profileId: profileIdSchema,
  providerThreadId: providerIdentifierSchema,
  sendIdempotencyKey: z.string().uuid(),
  sessionId: sessionIdSchema,
}).strict();

export type ClaudeLiveAcceptanceFreshSessionScope = Readonly<{
  daemonGeneration: number;
  memory: OompaMemoryRememberInput;
  profileGeneration: number;
  profileId: ProfileId;
  providerThreadId: string;
  sendIdempotencyKey: string;
  sessionId: SessionId;
}>;

export type ClaudeLiveAcceptanceSendCorroboration = Readonly<{
  daemonGeneration: number;
  idempotencyKey: string;
  sessionId: SessionId;
  turnId: string;
}>;

type ClaudeLiveAcceptancePrivateReceiptBase = Readonly<{
  bindingId: string;
  callId: string;
  candidate: LiveAcceptanceCandidate;
  candidateBindingDigest: string;
  connectionId: string;
  daemonGeneration: number;
  memory: OompaMemoryRememberInput;
  profileGeneration: number;
  profileId: ProfileId;
  providerThreadId: string;
  requestDigest: string;
  result: ClaudeLiveAcceptanceRememberResult;
  runId: string;
  sendIdempotencyKey: string;
  sessionId: SessionId;
  turnId: string;
}>;

export type ClaudeLiveAcceptanceProvisionalPrivateReceipt =
  ClaudeLiveAcceptancePrivateReceiptBase & Readonly<{ lifecycleInvalidated: false }>;

export type ClaudeLiveAcceptancePrivateReceipt =
  ClaudeLiveAcceptancePrivateReceiptBase & Readonly<{ lifecycleInvalidated: true }>;

export type ClaudeLiveAcceptanceProofFailureCode =
  | "call_extra"
  | "call_mismatch"
  | "candidate_invalid"
  | "dispatch_failed"
  | "generation_invalid"
  | "lifecycle_closed"
  | "proof_incomplete"
  | "response_invalid"
  | "response_written_extra"
  | "response_written_mismatch"
  | "session_scope_invalid"
  | "turn_corroboration_invalid";

export class ClaudeLiveAcceptanceProofError extends Error {
  constructor(readonly code: ClaudeLiveAcceptanceProofFailureCode) {
    super(`claude_live_acceptance_proof_${code}`);
    this.name = "ClaudeLiveAcceptanceProofError";
  }
}

type Phase =
  | "idle"
  | "ready"
  | "dispatching"
  | "call_succeeded"
  | "response_written"
  | "closed"
  | "failed";

type CapturedCall = Readonly<{
  callId: string;
  connectionId: string;
  requestDigest: string;
  result: ClaudeLiveAcceptanceRememberResult;
  turnId: string;
}>;

const sha256 = (value: string): string => createHash("sha256")
  .update(value, "utf8")
  .digest("hex");

const freezeMemory = (input: OompaMemoryRememberInput): OompaMemoryRememberInput => Object.freeze({
  body: input.body,
  key: input.key,
  ...(input.language === undefined ? {} : { language: input.language }),
  summary: input.summary,
  title: input.title,
});

const freezeRememberResult = (
  input: ClaudeLiveAcceptanceRememberResult,
): ClaudeLiveAcceptanceRememberResult => Object.freeze({
  ...input,
  page: Object.freeze({ ...input.page }),
  submission: Object.freeze({ ...input.submission }),
  workingHead: Object.freeze({ ...input.workingHead }),
});

const parseRememberInput = (value: unknown): OompaMemoryRememberInput => {
  const request = parseOompaHostToolRequest("memory_remember", value);
  if (request.tool !== "memory_remember") throw new Error("unreachable");
  return freezeMemory(request.input);
};

const sendCorroborationSchema = z.object({
  daemonGeneration: positiveIntegerSchema,
  idempotencyKey: z.string().uuid(),
  sessionId: sessionIdSchema,
  turnId: providerIdentifierSchema,
}).strict();

const privateReceiptBaseSchema = z.object({
  bindingId: providerIdentifierSchema,
  callId: providerIdentifierSchema,
  candidate: liveAcceptanceCandidateSchema,
  candidateBindingDigest: digestSchema,
  connectionId: providerIdentifierSchema,
  daemonGeneration: positiveIntegerSchema,
  memory: z.unknown(),
  profileGeneration: positiveIntegerSchema,
  profileId: profileIdSchema,
  providerThreadId: providerIdentifierSchema,
  requestDigest: digestSchema,
  result: rememberResultSchema,
  runId: z.string().uuid(),
  sendIdempotencyKey: z.string().uuid(),
  sessionId: sessionIdSchema,
  turnId: providerIdentifierSchema,
}).strict();

export function parseClaudeLiveAcceptanceFreshSessionScope(
  value: unknown,
): ClaudeLiveAcceptanceFreshSessionScope {
  const parsed = freshSessionScopeSchema.parse(value);
  return {
    ...parsed,
    memory: parseRememberInput(parsed.memory),
  };
}

export function parseClaudeLiveAcceptanceSendCorroboration(
  value: unknown,
): ClaudeLiveAcceptanceSendCorroboration {
  return sendCorroborationSchema.parse(value);
}

const proofBindingDigest = (
  input: Omit<ClaudeLiveAcceptancePrivateReceiptBase, "candidateBindingDigest">,
): string => canonicalDigest({
  bindingIdSha256: sha256(input.bindingId),
  callIdSha256: sha256(input.callId),
  candidate: input.candidate,
  connectionIdSha256: sha256(input.connectionId),
  daemonGeneration: input.daemonGeneration,
  domain: "hra-live-acceptance-claude-memory-proof-v1",
  memorySha256: canonicalDigest(input.memory),
  profileGeneration: input.profileGeneration,
  profileIdSha256: sha256(input.profileId),
  providerThreadIdSha256: sha256(input.providerThreadId),
  requestDigest: input.requestDigest,
  resultSha256: canonicalDigest(input.result),
  runId: input.runId,
  sendIdempotencyKeySha256: sha256(input.sendIdempotencyKey),
  sessionIdSha256: sha256(input.sessionId),
  turnIdSha256: sha256(input.turnId),
});

const parsePrivateReceiptBase = (value: unknown): ClaudeLiveAcceptancePrivateReceiptBase => {
  // The caller has already applied a strict lifecycle-specific schema. This
  // second projection intentionally ignores that one known discriminator.
  const parsed = privateReceiptBaseSchema.strip().parse(value);
  const receipt = {
    ...parsed,
    candidate: Object.freeze({ ...parsed.candidate }),
    memory: parseRememberInput(parsed.memory),
    result: freezeRememberResult(parsed.result),
  };
  if (
    receipt.candidate.packageVersion !== OOMPA_VERSION
    || proofBindingDigest(receipt) !== receipt.candidateBindingDigest
    || digestClaudeHostToolInvocation(receipt.callId, {
      input: receipt.memory,
      tool: "memory_remember",
    }) !== receipt.requestDigest
    || receipt.result.page.key !== receipt.memory.key
    || receipt.result.page.operationSha256 !== receipt.result.workingHead.operationSha256
  ) throw new ClaudeLiveAcceptanceProofError("candidate_invalid");
  return receipt;
};

export function parseClaudeLiveAcceptanceProvisionalPrivateReceipt(
  value: unknown,
): ClaudeLiveAcceptanceProvisionalPrivateReceipt {
  const parsed = z.object({
    ...privateReceiptBaseSchema.shape,
    lifecycleInvalidated: z.literal(false),
  }).strict().parse(value);
  return Object.freeze({ ...parsePrivateReceiptBase(parsed), lifecycleInvalidated: false });
}

export function parseClaudeLiveAcceptancePrivateReceipt(
  value: unknown,
): ClaudeLiveAcceptancePrivateReceipt {
  const parsed = z.object({
    ...privateReceiptBaseSchema.shape,
    lifecycleInvalidated: z.literal(true),
  }).strict().parse(value);
  return Object.freeze({ ...parsePrivateReceiptBase(parsed), lifecycleInvalidated: true });
}

/**
 * One-process, one-generation acceptance custody for a single managed-Claude
 * `memory_remember` callback. Raw authority and memory values never leave the
 * explicitly named private receipt method.
 */
export class ClaudeLiveAcceptanceProofCollector implements LiveAcceptanceClaudeProofPort {
  readonly #candidate: LiveAcceptanceCandidate;
  readonly #runId: string;
  #call: CapturedCall | null = null;
  #corroboratedTurnId: string | null = null;
  #daemonGeneration: number | null = null;
  #failure: ClaudeLiveAcceptanceProofError | null = null;
  #finalReceipt: ClaudeLiveAcceptancePrivateReceipt | null = null;
  #phase: Phase = "idle";
  #receipt: ClaudeLiveAcceptancePrivateReceiptBase | null = null;
  #scope: ClaudeLiveAcceptanceFreshSessionScope | null = null;

  constructor(input: Readonly<{
    candidate: LiveAcceptanceCandidate;
    runId: string;
  }>) {
    const candidate = liveAcceptanceCandidateSchema.safeParse(input.candidate);
    const runId = z.string().uuid().safeParse(input.runId);
    if (!candidate.success || candidate.data.packageVersion !== OOMPA_VERSION || !runId.success) {
      throw new ClaudeLiveAcceptanceProofError("candidate_invalid");
    }
    this.#candidate = Object.freeze({ ...candidate.data });
    this.#runId = runId.data;
  }

  beginDaemonGeneration(generation: number): void {
    this.#requireOpen();
    if (
      this.#daemonGeneration !== null
      || !positiveIntegerSchema.safeParse(generation).success
    ) this.#fail("generation_invalid");
    this.#daemonGeneration = generation;
  }

  armFreshSession(input: ClaudeLiveAcceptanceFreshSessionScope): void {
    this.#requireOpen();
    if (this.#phase !== "idle" || this.#scope !== null) this.#fail("session_scope_invalid");
    let parsed: ClaudeLiveAcceptanceFreshSessionScope;
    try {
      parsed = parseClaudeLiveAcceptanceFreshSessionScope(input);
    } catch {
      this.#fail("session_scope_invalid");
    }
    if (parsed.daemonGeneration !== this.#daemonGeneration) this.#fail("session_scope_invalid");
    this.#scope = Object.freeze({
      ...parsed,
      memory: freezeMemory(parsed.memory),
    });
    this.#phase = "ready";
  }

  corroborateAppliedSend(input: ClaudeLiveAcceptanceSendCorroboration): void {
    this.#requireOpen();
    const scope = this.#requireScope();
    const parsed = sendCorroborationSchema.safeParse(input);
    if (
      !parsed.success
      || this.#corroboratedTurnId !== null
      || parsed.data.daemonGeneration !== this.#daemonGeneration
      || parsed.data.daemonGeneration !== scope.daemonGeneration
      || parsed.data.idempotencyKey !== scope.sendIdempotencyKey
      || parsed.data.sessionId !== scope.sessionId
      || (this.#call !== null && parsed.data.turnId !== this.#call.turnId)
    ) this.#fail("turn_corroboration_invalid");
    this.#corroboratedTurnId = parsed.data.turnId;
  }

  async handleManagedHostToolCall(input: Readonly<{
    authority: ProfileAuthority;
    call: OompaHostToolCall;
    dispatch: () => Promise<ClaudeHostToolPublicResult>;
  }>): Promise<ClaudeHostToolPublicResult> {
    this.#requireOpen();
    if (this.#phase !== "ready" || this.#call !== null) {
      this.#fail(
        this.#phase === "dispatching"
          || this.#phase === "call_succeeded"
          || this.#phase === "response_written"
          ? "call_extra"
          : "call_mismatch",
      );
    }
    const scope = this.#requireScope();
    // Own the fields retained after dispatch. The V1 receipt remains unchanged;
    // full provider identity is an admission check, not a new receipt preimage.
    const call = { ...input.call, authority: { ...input.call.authority }, requestId: { ...input.call.requestId } };
    const authority = { ...input.authority };
    let memory: OompaMemoryRememberInput;
    try {
      memory = call.tool === "memory_remember" ? parseRememberInput(call.input) : this.#fail("call_mismatch");
    } catch (error: unknown) {
      if (error instanceof ClaudeLiveAcceptanceProofError) throw error;
      this.#fail("call_mismatch");
    }
    if (
      authority.id !== scope.profileId
      || authority.generation !== scope.profileGeneration
      || authority.provider !== "claude"
      || !claudeProviderAccountAuthoritySchema.safeParse(call.authority).success
      || call.authority.providerAccountId !== authority.providerAccountId
      || call.authority.bindingGeneration !== authority.bindingGeneration
      || call.authority.profileId !== scope.profileId
      || call.authority.processGeneration !== scope.profileGeneration
      || call.threadId !== scope.providerThreadId
      || (this.#corroboratedTurnId !== null && call.turnId !== this.#corroboratedTurnId)
      || call.requestId.type !== "string"
      || call.requestId.value !== call.callId
      || !providerIdentifierSchema.safeParse(call.callId).success
      || !providerIdentifierSchema.safeParse(call.connectionId).success
      || canonicalDigest(memory) !== canonicalDigest(scope.memory)
      || digestClaudeHostToolInvocation(call.callId, {
        input: memory,
        tool: "memory_remember",
      }) !== call.requestDigest
    ) this.#fail("call_mismatch");

    this.#phase = "dispatching";
    const generation = this.#daemonGeneration;
    let result: ClaudeHostToolPublicResult;
    try {
      result = await input.dispatch();
    } catch (error: unknown) {
      this.#recordFailure("dispatch_failed");
      throw error;
    }
    if (!this.#dispatchCompletionIsCurrent(generation, scope)) {
      throw this.#failure ?? this.#recordFailure("generation_invalid");
    }
    if (this.#corroboratedTurnId !== null && this.#corroboratedTurnId !== call.turnId) {
      this.#fail("turn_corroboration_invalid");
    }
    const parsedResult = rememberResultSchema.safeParse(result);
    if (
      !parsedResult.success
      || parsedResult.data.page.key !== scope.memory.key
      || parsedResult.data.page.operationSha256
        !== parsedResult.data.workingHead.operationSha256
    ) this.#fail("response_invalid");
    this.#call = Object.freeze({
      callId: call.callId,
      connectionId: call.connectionId,
      requestDigest: call.requestDigest,
      result: freezeRememberResult(parsedResult.data),
      turnId: call.turnId,
    });
    this.#phase = "call_succeeded";
    return result;
  }

  handleManagedHostToolResponseWritten(receipt: ClaudeHostToolResponseWritten): void {
    this.#requireOpen();
    if (this.#phase !== "call_succeeded" || this.#receipt !== null) {
      this.#fail(this.#phase === "response_written" ? "response_written_extra" : "response_written_mismatch");
    }
    const scope = this.#requireScope();
    const call = this.#call;
    if (call === null) this.#fail("response_written_mismatch");
    let memory: OompaMemoryRememberInput;
    try {
      memory = receipt.request.tool === "memory_remember"
        ? parseRememberInput(receipt.request.input)
        : this.#fail("response_written_mismatch");
    } catch (error: unknown) {
      if (error instanceof ClaudeLiveAcceptanceProofError) throw error;
      this.#fail("response_written_mismatch");
    }
    if (
      receipt.profileId !== scope.profileId
      || receipt.processGeneration !== scope.profileGeneration
      || receipt.providerThreadId !== scope.providerThreadId
      || receipt.callId !== call.callId
      || receipt.requestDigest !== call.requestDigest
      || !providerIdentifierSchema.safeParse(receipt.bindingId).success
      || canonicalDigest(memory) !== canonicalDigest(scope.memory)
      || digestClaudeHostToolInvocation(receipt.callId, {
        input: memory,
        tool: "memory_remember",
      }) !== receipt.requestDigest
    ) this.#fail("response_written_mismatch");
    const receiptWithoutDigest = {
      bindingId: receipt.bindingId,
      callId: call.callId,
      candidate: this.#candidate,
      connectionId: call.connectionId,
      daemonGeneration: scope.daemonGeneration,
      memory: scope.memory,
      profileGeneration: scope.profileGeneration,
      profileId: scope.profileId,
      providerThreadId: scope.providerThreadId,
      requestDigest: call.requestDigest,
      result: call.result,
      runId: this.#runId,
      sendIdempotencyKey: scope.sendIdempotencyKey,
      sessionId: scope.sessionId,
      turnId: call.turnId,
    } satisfies Omit<ClaudeLiveAcceptancePrivateReceiptBase, "candidateBindingDigest">;
    this.#receipt = Object.freeze({
      ...receiptWithoutDigest,
      candidateBindingDigest: proofBindingDigest(receiptWithoutDigest),
    });
    this.#phase = "response_written";
  }

  closeDaemonGeneration(generation: number | null): void {
    if (this.#phase === "closed") {
      if (generation !== this.#daemonGeneration) this.#fail("generation_invalid");
      return;
    }
    if (
      generation === null
      || generation !== this.#daemonGeneration
      || this.#phase !== "response_written"
      || this.#receipt === null
      || this.#corroboratedTurnId !== this.#receipt.turnId
    ) this.#recordFailure(generation === this.#daemonGeneration ? "proof_incomplete" : "generation_invalid");
    if (this.#failure === null && this.#receipt !== null) {
      this.#finalReceipt = Object.freeze({
        ...this.#receipt,
        lifecycleInvalidated: true,
      });
      this.#phase = "closed";
    } else {
      this.#phase = "failed";
    }
    if (this.#failure !== null) throw this.#failure;
  }

  readProvisionalPrivateReceipt(): ClaudeLiveAcceptanceProvisionalPrivateReceipt {
    if (
      this.#phase !== "response_written"
      || this.#failure !== null
      || this.#receipt === null
      || this.#corroboratedTurnId !== this.#receipt.turnId
    ) {
      throw this.#failure ?? new ClaudeLiveAcceptanceProofError("proof_incomplete");
    }
    return Object.freeze({ ...this.#receipt, lifecycleInvalidated: false });
  }

  readPrivateReceipt(): ClaudeLiveAcceptancePrivateReceipt {
    if (this.#phase !== "closed" || this.#failure !== null || this.#finalReceipt === null) {
      throw this.#failure ?? new ClaudeLiveAcceptanceProofError("proof_incomplete");
    }
    return this.#finalReceipt;
  }

  #requireOpen(): void {
    if (this.#phase === "closed") this.#fail("lifecycle_closed");
    if (this.#failure !== null) throw this.#failure;
  }

  #dispatchCompletionIsCurrent(
    generation: number | null,
    scope: ClaudeLiveAcceptanceFreshSessionScope,
  ): boolean {
    return this.#failure === null
      && this.#phase === "dispatching"
      && this.#daemonGeneration === generation
      && this.#scope === scope;
  }

  #requireScope(): ClaudeLiveAcceptanceFreshSessionScope {
    if (this.#scope === null) this.#fail("session_scope_invalid");
    return this.#scope;
  }

  #recordFailure(code: ClaudeLiveAcceptanceProofFailureCode): ClaudeLiveAcceptanceProofError {
    this.#failure ??= new ClaudeLiveAcceptanceProofError(code);
    this.#phase = "failed";
    return this.#failure;
  }

  #fail(code: ClaudeLiveAcceptanceProofFailureCode): never {
    throw this.#recordFailure(code);
  }
}
