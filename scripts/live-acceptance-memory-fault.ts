import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CanonicalMemoryTransportError,
  type CanonicalMemoryPullRequest,
  type CanonicalMemoryTransport,
} from "../src/cloud/canonical-memory-transport";
import {
  parseCanonicalMemoryWriteResult,
  type CanonicalMemoryOperation,
  type CanonicalMemoryPushRequest,
  type CanonicalMemoryWriteResult,
} from "../src/cloud/memory-sync-contracts";
import { parseCanonicalMemoryHostedSpaceId } from "../src/domain/canonical-memory-sync";
import {
  projectMemoryHeadRefSchema,
  type ProjectMemoryHeadRef,
} from "../src/storage/state-store";
import { HRA_VERSION } from "../src/version";
import {
  liveAcceptanceCandidateSchema,
  type LiveAcceptanceCandidate,
} from "./live-acceptance-installation";
import { canonicalDigest } from "./release-evidence";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const nominatedCandidateHeadSchema = projectMemoryHeadRefSchema.refine(
  (head) => head.sequence > 0 && head.operationSha256 !== null,
  "The nominated acceptance candidate must be a non-empty memory head.",
);

const remoteObservationSchema = z.object({
  genesisToken: digestSchema,
  head: projectMemoryHeadRefSchema,
  headToken: digestSchema,
  keyVersion: safePositiveIntegerSchema,
  revision: safePositiveIntegerSchema,
}).strict();

export const liveAcceptanceMemoryFaultArmSchema = z.object({
  candidateHead: nominatedCandidateHeadSchema,
  hostedSpaceId: z.string().refine((value) => parseCanonicalMemoryHostedSpaceId(value) !== null),
  remote: remoteObservationSchema,
}).strict().superRefine((value, context) => {
  if (value.candidateHead.sequence !== value.remote.head.sequence + 1) {
    context.addIssue({
      code: "custom",
      message: "The nominated candidate must be the exact remote successor.",
      path: ["candidateHead", "sequence"],
    });
  }
});

export type LiveAcceptanceMemoryFaultArm = z.infer<
  typeof liveAcceptanceMemoryFaultArmSchema
>;

export const liveAcceptanceMemoryFaultFinalizeSchema = z.object({
  candidateBindingDigest: digestSchema,
  laterTerminalSequence: safePositiveIntegerSchema,
}).strict();

export type LiveAcceptanceMemoryFaultFinalize = z.infer<
  typeof liveAcceptanceMemoryFaultFinalizeSchema
>;

const generationStopReasonSchema = z.enum([
  "parent_closed",
  "restart",
  "stop",
  "suspend",
]);

export type LiveAcceptanceMemoryFaultGenerationStopReason = z.infer<
  typeof generationStopReasonSchema
>;

const liveAcceptanceMemoryFaultProofSchema = z.object({
  candidateBindingDigest: digestSchema,
  candidateHead: nominatedCandidateHeadSchema,
  droppedGeneration: safePositiveIntegerSchema,
  hostedSpaceIdSha256: digestSchema,
  pushDispatchCount: z.literal(1),
  sameGenerationRefusalCount: safeNonNegativeIntegerSchema,
  sequence: safePositiveIntegerSchema,
  structuredRequestSha256: digestSchema,
  wireOperationSha256: digestSchema,
}).strict();

const liveAcceptanceMemoryFaultHistoricalProofSchema = z.object({
  afterSequence: safeNonNegativeIntegerSchema,
  firstOperationSha256: digestSchema,
  generation: safePositiveIntegerSchema,
  terminalSequence: safePositiveIntegerSchema,
}).strict();

const faultFailureCodeSchema = z.enum([
  "candidate_invalid",
  "generation_invalid",
  "historical_pull_invalid",
  "push_invalid",
  "response_invalid",
  "state_invalid",
]);

const faultPhaseSchema = z.enum([
  "armed",
  "closed",
  "dropped_blocking",
  "dropping",
  "failed",
  "finalized",
  "historical_proved",
  "idle",
  "proving_historical",
  "suspended",
  "unavailable",
  "waiting_historical",
]);

const phasesRequiringProof = new Set<FaultPhase>([
  "dropped_blocking",
  "finalized",
  "historical_proved",
  "proving_historical",
  "suspended",
  "waiting_historical",
]);

export const liveAcceptanceMemoryFaultStatusSchema = z.object({
  currentGeneration: safePositiveIntegerSchema.nullable(),
  failureCode: faultFailureCodeSchema.optional(),
  historical: liveAcceptanceMemoryFaultHistoricalProofSchema.optional(),
  phase: faultPhaseSchema,
  proof: liveAcceptanceMemoryFaultProofSchema.optional(),
}).strict().superRefine((value, context) => {
  const issue = (message: string, path: (string | number)[]): void => {
    context.addIssue({ code: "custom", message, path });
  };
  if ((value.phase === "failed") !== (value.failureCode !== undefined)) {
    issue("Failure evidence must be present exactly in the failed phase.", ["failureCode"]);
  }
  if (
    value.phase !== "failed"
    && phasesRequiringProof.has(value.phase) !== (value.proof !== undefined)
  ) {
    issue("Drop proof is inconsistent with the fault phase.", ["proof"]);
  }
  if (
    value.phase !== "failed"
    && (value.historical !== undefined)
      !== (value.phase === "historical_proved" || value.phase === "finalized")
  ) {
    issue("Historical proof is inconsistent with the fault phase.", ["historical"]);
  }
  if (value.historical !== undefined && value.proof === undefined) {
    issue("Historical proof requires its exact drop proof.", ["historical"]);
  }
  if (value.phase === "closed") {
    if (value.currentGeneration !== null) {
      issue("A closed fault controller cannot retain a generation.", ["currentGeneration"]);
    }
    if (value.proof !== undefined || value.historical !== undefined) {
      issue("A closed fault controller cannot re-release evidence.", ["proof"]);
    }
  }
  if (value.phase === "suspended" && value.currentGeneration !== null) {
    issue("A suspended fault controller cannot retain a generation.", ["currentGeneration"]);
  }
  if (
    [
      "armed",
      "dropped_blocking",
      "dropping",
      "historical_proved",
      "proving_historical",
      "waiting_historical",
    ].includes(value.phase)
    && value.currentGeneration === null
  ) {
    issue("An active fault phase requires an exact daemon generation.", ["currentGeneration"]);
  }
  if (value.proof !== undefined) {
    if (value.proof.candidateHead.sequence !== value.proof.sequence) {
      issue("The drop must be the nominated candidate sequence.", ["proof", "sequence"]);
    }
    if (
      value.currentGeneration !== null
      && value.phase === "dropped_blocking"
      && value.currentGeneration !== value.proof.droppedGeneration
    ) {
      issue("The blocking generation must be the drop generation.", ["currentGeneration"]);
    }
  }
  if (value.proof !== undefined && value.historical !== undefined) {
    if (value.historical.afterSequence !== value.proof.sequence - 1) {
      issue("Historical recovery must start immediately before the dropped operation.", ["historical", "afterSequence"]);
    }
    if (value.historical.firstOperationSha256 !== value.proof.wireOperationSha256) {
      issue("Historical recovery must return the exact dropped wire operation first.", ["historical", "firstOperationSha256"]);
    }
    if (value.historical.generation <= value.proof.droppedGeneration) {
      issue("Historical recovery must occur in a later daemon generation.", ["historical", "generation"]);
    }
    if (value.historical.terminalSequence <= value.proof.sequence) {
      issue("Historical recovery requires a later remote terminal.", ["historical", "terminalSequence"]);
    }
  }
});

export type LiveAcceptanceMemoryFaultStatus = z.infer<
  typeof liveAcceptanceMemoryFaultStatusSchema
>;

type FaultPhase = z.infer<typeof faultPhaseSchema>;
type FaultFailureCode = z.infer<typeof faultFailureCodeSchema>;

export class LiveAcceptanceMemoryFaultError extends Error {
  constructor(readonly code: FaultFailureCode) {
    super(code);
    this.name = "LiveAcceptanceMemoryFaultError";
  }
}

type ArmBinding = Readonly<{
  candidateBindingDigest: string;
  candidateHead: ProjectMemoryHeadRef;
  expectedGenesisTokenSha256: string;
  expectedHeadTokenSha256: string;
  expectedKeyVersion: number;
  expectedRemoteSequence: number;
  expectedRevision: number;
  hostedSpaceIdSha256: string;
}>;

type DroppedProof = Readonly<{
  candidateBindingDigest: string;
  candidateHead: ProjectMemoryHeadRef;
  droppedGeneration: number;
  expectedGenesisTokenSha256: string;
  expectedKeyVersion: number;
  hostedSpaceIdSha256: string;
  priorTokenSha256: string;
  pushDispatchCount: 1;
  sequence: number;
  structuredRequestSha256: string;
  wireOperationSha256: string;
}>;

type HistoricalProof = z.infer<typeof liveAcceptanceMemoryFaultHistoricalProofSchema>;

type DeferredFailure = Readonly<{
  promise: Promise<never>;
  reject: (error: Error) => void;
}>;

const deferredFailure = (): DeferredFailure => {
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, reject: rejectPromise };
};

const sha256 = (value: string): string => createHash("sha256")
  .update(value, "utf8")
  .digest("hex");

const sameEnvelope = (
  left: CanonicalMemoryWriteResult["acceptedTerminalHeadProof"],
  right: CanonicalMemoryOperation["terminalHeadProof"],
): boolean => left.ciphertext === right.ciphertext
  && left.keyVersion === right.keyVersion
  && left.nonce === right.nonce;

const responseMatchesPush = (
  response: CanonicalMemoryWriteResult,
  request: CanonicalMemoryPushRequest,
): boolean => {
  const operation = request.operations[0];
  return response.acceptedHeadToken === operation.headToken
    && response.acceptedSequence === operation.sequence
    && sameEnvelope(response.acceptedTerminalHeadProof, operation.terminalHeadProof)
    && response.keyVersion === request.expectedKeyVersion
    && response.revision === request.expectedRevision
    && response.spaceId === request.spaceId;
};

const spaceMatches = (spaceId: string, expectedSha256: string): boolean =>
  sha256(spaceId) === expectedSha256;

export class LiveAcceptanceMemoryFaultController {
  readonly #candidate: LiveAcceptanceCandidate | null;
  readonly #deferredFailure = deferredFailure();
  readonly #device: "a" | "b";
  readonly #runId: string;
  #arm: ArmBinding | null = null;
  #closed = false;
  #currentGeneration: number | null = null;
  #dropped: DroppedProof | null = null;
  #failed: LiveAcceptanceMemoryFaultError | null = null;
  #generationCounter = 0;
  #historical: HistoricalProof | null = null;
  #phase: FaultPhase;
  #sameGenerationRefusalCount = 0;

  constructor(input: Readonly<{
    candidate?: LiveAcceptanceCandidate;
    cloudDeploymentUrl?: string;
    device: "a" | "b";
    runId: string;
  }>) {
    this.#device = input.device;
    this.#runId = z.string().uuid().parse(input.runId);
    const candidate = input.candidate === undefined
      ? null
      : liveAcceptanceCandidateSchema.parse(input.candidate);
    const cloudTargetDigest = input.cloudDeploymentUrl === undefined
      ? null
      : sha256(input.cloudDeploymentUrl);
    if (
      candidate !== null
      && (
        candidate.packageVersion !== HRA_VERSION
        || cloudTargetDigest === null
        || candidate.cloudTargetDigest !== cloudTargetDigest
      )
    ) {
      this.#candidate = null;
      this.#phase = "unavailable";
      this.#fail("candidate_invalid");
    }
    this.#candidate = candidate;
    this.#phase = input.device === "a" && candidate !== null ? "idle" : "unavailable";
  }

  get failure(): Promise<never> {
    return this.#deferredFailure.promise;
  }

  beginGeneration(): number {
    this.#requireOpen();
    this.#requireNotFailed();
    if (this.#currentGeneration !== null) return this.#fail("generation_invalid");
    this.#generationCounter += 1;
    this.#currentGeneration = this.#generationCounter;
    if (this.#phase === "suspended") this.#phase = "waiting_historical";
    return this.#generationCounter;
  }

  endGeneration(input: Readonly<{
    exitCode: number;
    generation: number;
    reason: LiveAcceptanceMemoryFaultGenerationStopReason;
  }>): void {
    const reason = generationStopReasonSchema.safeParse(input.reason);
    if (this.#closed) return;
    if (
      !reason.success
      || !Number.isSafeInteger(input.exitCode)
      || input.exitCode !== 0
      || this.#currentGeneration !== input.generation
    ) {
      this.#recordFailure("generation_invalid");
      return;
    }
    this.#currentGeneration = null;
    if (this.#failed !== null) return;
    if (this.#phase === "dropped_blocking") {
      if (reason.data === "suspend") {
        this.#phase = "suspended";
      } else {
        this.#recordFailure("generation_invalid");
      }
      return;
    }
    if (
      this.#phase === "armed"
      || this.#phase === "dropping"
      || this.#phase === "historical_proved"
      || this.#phase === "proving_historical"
      || this.#phase === "waiting_historical"
    ) {
      this.#recordFailure("generation_invalid");
    }
  }

  arm(input: LiveAcceptanceMemoryFaultArm): LiveAcceptanceMemoryFaultStatus {
    this.#requireOpen();
    this.#requireNotFailed();
    if (
      this.#phase !== "idle"
      || this.#candidate === null
      || this.#device !== "a"
      || this.#currentGeneration === null
    ) return this.#fail("state_invalid");
    const parsed = liveAcceptanceMemoryFaultArmSchema.parse(input);
    const hostedSpaceIdSha256 = sha256(parsed.hostedSpaceId);
    const expectedGenesisTokenSha256 = sha256(parsed.remote.genesisToken);
    const expectedHeadTokenSha256 = sha256(parsed.remote.headToken);
    const candidateBindingDigest = canonicalDigest({
      candidate: this.#candidate,
      candidateHead: parsed.candidateHead,
      device: this.#device,
      domain: "hra-live-acceptance-memory-response-drop-v1",
      expected: {
        genesisTokenSha256: expectedGenesisTokenSha256,
        head: parsed.remote.head,
        headTokenSha256: expectedHeadTokenSha256,
        keyVersion: parsed.remote.keyVersion,
        revision: parsed.remote.revision,
      },
      hostedSpaceIdSha256,
      runId: this.#runId,
    });
    this.#arm = {
      candidateBindingDigest,
      candidateHead: parsed.candidateHead,
      expectedGenesisTokenSha256,
      expectedHeadTokenSha256,
      expectedKeyVersion: parsed.remote.keyVersion,
      expectedRemoteSequence: parsed.remote.head.sequence,
      expectedRevision: parsed.remote.revision,
      hostedSpaceIdSha256,
    };
    this.#phase = "armed";
    return this.status();
  }

  finalize(input: LiveAcceptanceMemoryFaultFinalize): LiveAcceptanceMemoryFaultStatus {
    this.#requireOpen();
    this.#requireNotFailed();
    const parsed = liveAcceptanceMemoryFaultFinalizeSchema.parse(input);
    if (
      this.#phase !== "historical_proved"
      || this.#arm === null
      || this.#historical === null
      || parsed.candidateBindingDigest !== this.#arm.candidateBindingDigest
      || parsed.laterTerminalSequence !== this.#historical.terminalSequence
    ) return this.#fail("state_invalid");
    this.#phase = "finalized";
    return this.status();
  }

  decorate(generation: number, transport: CanonicalMemoryTransport): CanonicalMemoryTransport {
    this.#assertGeneration(generation);
    const call = async <T>(spaceId: string, operation: () => Promise<T>): Promise<T> => {
      this.#assertGeneration(generation);
      const arm = this.#arm;
      if (arm === null || !spaceMatches(spaceId, arm.hostedSpaceIdSha256)) {
        return await operation();
      }
      if (this.#blocksExactTarget()) this.#refuseTargetBeforeEffect();
      return await operation();
    };

    const decorated: CanonicalMemoryTransport = {
      create: async (request) => await call(request.spaceId, async () =>
        await transport.create(request)),
      get: async (request) => await call(request.spaceId, async () =>
        await transport.get(request)),
      head: async (request) => await call(request.spaceId, async () =>
        await transport.head(request)),
      list: async () => {
        this.#assertGeneration(generation);
        return await transport.list();
      },
      pull: async (request) => {
        this.#assertGeneration(generation);
        const arm = this.#arm;
        if (arm === null || !spaceMatches(request.spaceId, arm.hostedSpaceIdSha256)) {
          return await transport.pull(request);
        }
        if (this.#blocksExactTarget()) this.#refuseTargetBeforeEffect();
        if (this.#phase === "armed") return this.#fail("historical_pull_invalid");
        if (this.#phase !== "waiting_historical") return await transport.pull(request);
        return await this.#proveHistoricalPull(generation, request, transport);
      },
      push: async (request) => {
        this.#assertGeneration(generation);
        const arm = this.#arm;
        if (arm === null || !spaceMatches(request.spaceId, arm.hostedSpaceIdSha256)) {
          return await transport.push(request);
        }
        if (this.#blocksExactTarget()) this.#refuseTargetBeforeEffect();
        if (this.#phase === "armed") {
          return await this.#dropPush(generation, request, transport);
        }
        if (this.#phase === "waiting_historical" || this.#phase === "historical_proved") {
          return this.#fail("historical_pull_invalid");
        }
        return await transport.push(request);
      },
    };
    return Object.freeze(decorated);
  }

  status(): LiveAcceptanceMemoryFaultStatus {
    if (this.#closed) {
      return liveAcceptanceMemoryFaultStatusSchema.parse({
        currentGeneration: null,
        phase: "closed",
      });
    }
    return liveAcceptanceMemoryFaultStatusSchema.parse({
      currentGeneration: this.#currentGeneration,
      ...(this.#failed === null ? {} : { failureCode: this.#failed.code }),
      ...(this.#historical === null ? {} : { historical: this.#historical }),
      phase: this.#phase,
      ...(this.#dropped === null ? {} : {
        proof: {
          candidateBindingDigest: this.#dropped.candidateBindingDigest,
          candidateHead: this.#dropped.candidateHead,
          droppedGeneration: this.#dropped.droppedGeneration,
          hostedSpaceIdSha256: this.#dropped.hostedSpaceIdSha256,
          pushDispatchCount: this.#dropped.pushDispatchCount,
          sameGenerationRefusalCount: this.#sameGenerationRefusalCount,
          sequence: this.#dropped.sequence,
          structuredRequestSha256: this.#dropped.structuredRequestSha256,
          wireOperationSha256: this.#dropped.wireOperationSha256,
        },
      }),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#arm = null;
    this.#dropped = null;
    this.#historical = null;
    this.#currentGeneration = null;
    this.#phase = "closed";
    this.#sameGenerationRefusalCount = 0;
  }

  async #dropPush(
    generation: number,
    request: CanonicalMemoryPushRequest,
    transport: CanonicalMemoryTransport,
  ): Promise<CanonicalMemoryWriteResult> {
    const arm = this.#requireArm();
    const operation = request.operations[0];
    if (
      request.expectedKeyVersion !== arm.expectedKeyVersion
      || request.expectedRevision !== arm.expectedRevision
      || operation.sequence !== arm.candidateHead.sequence
      || operation.sequence !== arm.expectedRemoteSequence + 1
      || sha256(operation.priorToken) !== arm.expectedHeadTokenSha256
      || sha256(operation.genesisToken) !== arm.expectedGenesisTokenSha256
      || operation.operation.keyVersion !== arm.expectedKeyVersion
      || operation.adoptionProof === null
    ) return this.#fail("push_invalid");

    this.#phase = "dropping";
    let response: unknown;
    try {
      response = await transport.push(request);
    } catch (error: unknown) {
      if (this.#dropCompletionIsCurrent(generation, arm)) {
        this.#recordFailure("response_invalid");
      }
      throw error;
    }
    this.#assertDropCompletion(generation, arm);
    const parsedResponse = parseCanonicalMemoryWriteResult(response);
    if (
      parsedResponse === null
      || parsedResponse.replay
      || !responseMatchesPush(parsedResponse, request)
    ) {
      return this.#fail("response_invalid");
    }
    this.#dropped = {
      candidateBindingDigest: arm.candidateBindingDigest,
      candidateHead: arm.candidateHead,
      droppedGeneration: generation,
      expectedGenesisTokenSha256: arm.expectedGenesisTokenSha256,
      expectedKeyVersion: arm.expectedKeyVersion,
      hostedSpaceIdSha256: arm.hostedSpaceIdSha256,
      priorTokenSha256: sha256(operation.priorToken),
      pushDispatchCount: 1,
      sequence: operation.sequence,
      structuredRequestSha256: canonicalDigest(request),
      wireOperationSha256: canonicalDigest(operation),
    };
    this.#phase = "dropped_blocking";
    throw new CanonicalMemoryTransportError("transport", "indeterminate");
  }

  async #proveHistoricalPull(
    generation: number,
    request: CanonicalMemoryPullRequest,
    transport: CanonicalMemoryTransport,
  ): ReturnType<CanonicalMemoryTransport["pull"]> {
    const dropped = this.#requireDropped();
    if (
      request.afterSequence !== dropped.sequence - 1
      || sha256(request.afterHeadToken) !== dropped.priorTokenSha256
      || sha256(request.expectedGenesisToken) !== dropped.expectedGenesisTokenSha256
      || request.expectedKeyVersion !== dropped.expectedKeyVersion
      || request.terminalSequence <= dropped.sequence
    ) return this.#fail("historical_pull_invalid");
    this.#phase = "proving_historical";
    let response: Awaited<ReturnType<CanonicalMemoryTransport["pull"]>>;
    try {
      response = await transport.pull(request);
    } catch (error: unknown) {
      if (this.#historicalCompletionIsCurrent(generation, dropped)) {
        this.#recordFailure("response_invalid");
      }
      throw error;
    }
    this.#assertHistoricalCompletion(generation, dropped);
    const first = response.operations[0];
    if (
      response.operations.length !== 1
      || first === undefined
      || canonicalDigest(first) !== dropped.wireOperationSha256
      || first.sequence !== dropped.sequence
      || response.terminalSequence !== request.terminalSequence
      || response.terminalHeadToken !== request.terminalHeadToken
      || response.spaceId !== request.spaceId
    ) return this.#fail("historical_pull_invalid");
    this.#historical = {
      afterSequence: request.afterSequence,
      firstOperationSha256: canonicalDigest(first),
      generation,
      terminalSequence: request.terminalSequence,
    };
    this.#phase = "historical_proved";
    return response;
  }

  #assertDropCompletion(generation: number, arm: ArmBinding): void {
    this.#requireOpen();
    this.#requireNotFailed();
    if (!this.#dropCompletionIsCurrent(generation, arm)) {
      return this.#fail("generation_invalid");
    }
  }

  #assertGeneration(generation: number): void {
    this.#requireOpen();
    this.#requireNotFailed();
    if (this.#currentGeneration !== generation) return this.#fail("generation_invalid");
  }

  #assertHistoricalCompletion(generation: number, dropped: DroppedProof): void {
    this.#requireOpen();
    this.#requireNotFailed();
    if (!this.#historicalCompletionIsCurrent(generation, dropped)) {
      return this.#fail("generation_invalid");
    }
  }

  #blocksExactTarget(): boolean {
    return this.#phase === "dropping"
      || this.#phase === "dropped_blocking"
      || this.#phase === "proving_historical";
  }

  #dropCompletionIsCurrent(generation: number, arm: ArmBinding): boolean {
    return !this.#closed
      && this.#failed === null
      && this.#currentGeneration === generation
      && this.#phase === "dropping"
      && this.#arm === arm;
  }

  #historicalCompletionIsCurrent(generation: number, dropped: DroppedProof): boolean {
    return !this.#closed
      && this.#failed === null
      && this.#currentGeneration === generation
      && this.#phase === "proving_historical"
      && this.#dropped === dropped;
  }

  #recordFailure(code: FaultFailureCode): LiveAcceptanceMemoryFaultError | null {
    if (this.#closed || this.#failed !== null) return this.#failed;
    const error = new LiveAcceptanceMemoryFaultError(code);
    this.#failed = error;
    this.#phase = "failed";
    this.#deferredFailure.reject(error);
    return error;
  }

  #refuseTargetBeforeEffect(): never {
    if (this.#phase === "dropping" || this.#phase === "dropped_blocking") {
      this.#sameGenerationRefusalCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#sameGenerationRefusalCount + 1,
      );
    }
    throw new CanonicalMemoryTransportError("transport", "none");
  }

  #requireArm(): ArmBinding {
    if (this.#arm === null) return this.#fail("state_invalid");
    return this.#arm;
  }

  #requireDropped(): DroppedProof {
    if (this.#dropped === null) return this.#fail("state_invalid");
    return this.#dropped;
  }

  #requireNotFailed(): void {
    if (this.#failed !== null) throw this.#failed;
  }

  #requireOpen(): void {
    if (this.#closed) throw new LiveAcceptanceMemoryFaultError("state_invalid");
  }

  #fail(code: FaultFailureCode): never {
    this.#requireOpen();
    if (this.#failed !== null) throw this.#failed;
    const recorded = this.#recordFailure(code);
    if (recorded === null) throw new LiveAcceptanceMemoryFaultError(code);
    throw recorded;
  }
}
