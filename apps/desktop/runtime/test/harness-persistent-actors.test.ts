import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  actorEpochSchema,
  actorSchema,
  isTerminalActorAttemptState,
  isTerminalActorTurnState,
  type Actor,
  type ActorEpoch,
} from "../src/harness/actor-domain";
import { HARNESS_MAX_DURABLE_DESCENDANTS } from "../src/harness/domain";
import type { CodexFact } from "../src/codex/facts";
import {
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
} from "../src/codex/dynamic-tool";
import type { ActorTokenUsageIdentityPortV2 } from
  "../src/harness/actor-token-usage-identity-v2";
import type { ActorTokenUsageIdentityInput } from
  "../src/harness/actor-token-usage-identity-v2";
import {
  HarnessActorSessionRecoveryV2,
  type HarnessActorSessionReadinessPortV2,
} from "../src/harness/actor-session-recovery-v2";
import {
  PersistentActorCoordinator,
  PersistentActorError,
  PersistentActorTokenUsageFactConsumer,
  persistentActorTerminalObservationSchema,
  type PersistentActorAccountCandidate,
  type PersistentActorAuthorityPort,
  type PersistentActorClockPort,
  type PersistentActorEffectProof,
  type PersistentActorInterruptRequest,
  type PersistentActorLivenessPortV2,
  type PersistentActorProviderPort,
  type PersistentActorQuotaContinuationCaptureRequest,
  type PersistentActorTerminalObservation,
  type PersistentActorThreadOutcome,
  type PersistentActorThreadRequest,
  type PersistentActorTurnObservationRequest,
  type PersistentActorTurnOutcome,
  type PersistentActorTurnRequest,
} from "../src/harness/persistent-actors";
import {
  HarnessSQLiteAuthorityV2,
  type ActorSessionRecoveryProofV2,
} from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const epochId = "hepoch_persistent0001";
const rootActorId = "hactor_persistentroot01";
const projectId = "project-persistent-actors";
const sourceSha = "a".repeat(40);
const toolsetDigest = HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256;
const MIB = 1024 * 1024;

test("pins predecessor digest domains for durable actor recovery and effects", async () => {
  const source = await Bun.file(
    new URL("../src/harness/persistent-actors.ts", import.meta.url),
  ).text();
  expect(source).toContain('"oprte.recovery-required.v1"');
  expect(source).toContain('"oprte.actor.effect.v2"');
});

function createMigratedDatabaseFixture(): Uint8Array {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    return database.serialize();
  } finally {
    database.close();
  }
}

const migratedDatabaseFixture = createMigratedDatabaseFixture();

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return Object.freeze({ promise, resolve, reject });
}

function boundedTestClock(): PersistentActorClockPort {
  let current = Date.parse(at);
  return Object.freeze({
    now: () => new Date(current),
    sleep: (milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason instanceof Error
            ? signal.reason
            : new Error("test clock aborted", { cause: signal.reason }));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason instanceof Error
            ? signal.reason
            : new Error("test clock aborted", { cause: signal?.reason }));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          current += milliseconds;
          resolve();
        }, milliseconds);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  });
}

const tokenUsageIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
  digest: (input: ActorTokenUsageIdentityInput) => Promise.resolve(createHmac(
    "sha256",
    "oprte-persistent-actor-test-token-usage-key",
  ).update(JSON.stringify(input)).digest("hex")),
});

function proof(
  marker: string,
  input: Readonly<{
    definitive?: boolean;
    phase?: PersistentActorEffectProof["phase"];
  }> = {},
): PersistentActorEffectProof {
  return {
    digest: marker.repeat(64),
    observedAt: at,
    definitive: input.definitive ?? true,
    phase: input.phase ?? "postDispatch",
  };
}

function digestFixture(value: unknown, domain: string): string {
  return createHmac(
    "sha256",
    `oprte-persistent-actor-test-${domain}`,
  ).update(JSON.stringify(value)).digest("hex");
}

function sessionRecoveryProof(input: Readonly<{
  generation: number;
  identity: string;
  priorRecoveryProofDigest?: string | null;
}>): ActorSessionRecoveryProofV2 {
  return Object.freeze({
    recoveryProofDigest: digestFixture(
      [input.generation, input.identity, input.priorRecoveryProofDigest ?? null],
      "session-recovery-proof",
    ),
    priorRecoveryProofDigest: input.priorRecoveryProofDigest ?? null,
    observationGeneration: input.generation,
    historyEvidenceDigest: digestFixture(
      [input.generation, input.identity],
      "session-history-evidence",
    ),
    firstObservationPosition: input.generation * 10,
    secondObservationPosition: input.generation * 10 + 1,
    historyTurnCount: 0,
    historyItemCount: 0,
  });
}

function appliedThreadOutcome(
  request: PersistentActorThreadRequest,
  providerThreadId =
    `provider-thread-${request.accountProfileId}-${request.actorId}`,
  live: Readonly<{
    observationGeneration?: number;
    evidenceDigest?: string;
    supportsFast?: boolean;
  }> = {},
): Extract<PersistentActorThreadOutcome, Readonly<{ kind: "applied" }>> {
  const observationGeneration = live.observationGeneration ??
    request.processGeneration;
  return Object.freeze({
    kind: "applied",
    providerThreadId,
    observedProfile: Object.freeze({
      modelId: request.modelId,
      reasoningEffort: request.reasoningEffort,
    }),
    liveCapabilityEvidence: Object.freeze({
      observationGeneration,
      evidenceDigest: request.policyVersion === 0
        ? null
        : live.evidenceDigest ?? request.capabilityEvidenceDigest,
      supportsFast: request.policyVersion === 0
        ? null
        : live.supportsFast ?? request.supportsFast,
    }),
    sessionRecoveryProof: sessionRecoveryProof({
      generation: observationGeneration,
      identity: [
        request.accountProfileId,
        request.actorId,
        providerThreadId,
        request.threadSource,
      ].join("\0"),
    }),
    proof: proof("1"),
  });
}

function budget() {
  return {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 64 * MIB,
    deadline,
    laneAuthority: "readOnlySnapshot" as const,
  };
}

type AccountCandidateFixtureInput = Readonly<{
  accountProfileId: PersistentActorAccountCandidate["accountProfileId"];
  processGeneration: PersistentActorAccountCandidate["processGeneration"];
}> & Partial<Omit<
  PersistentActorAccountCandidate,
  "accountProfileId" | "processGeneration" | "routingPriority"
>> & Readonly<{
  routingPriority?: Partial<PersistentActorAccountCandidate["routingPriority"]>;
}>;

function accountCandidate(
  input: AccountCandidateFixtureInput,
  index: number,
): PersistentActorAccountCandidate {
  const selectedProfile = input.selectedProfile ?? "solUltra";
  const modelId = input.modelId ?? (
    selectedProfile === "lunaMax" ? "gpt-5.6-luna" : "gpt-5.6-sol"
  );
  const reasoningEffort = input.reasoningEffort ?? (
    selectedProfile === "solUltra" ? "ultra" : "max"
  );
  const profileFallbackReason = input.profileFallbackReason ?? null;
  const remainingPercent = input.remainingPercent ?? 100;
  const capabilityEvidenceDigest = input.capabilityEvidenceDigest ??
    digestFixture(input.accountProfileId, "account-capability");
  const routingPriority = {
    profileFallbackRank: input.routingPriority?.profileFallbackRank ??
      (profileFallbackReason === null ? 0 : 1),
    budgetRank: input.routingPriority?.budgetRank ??
      (remainingPercent === null ? 2 : 0),
    remainingHeadroomRank: input.routingPriority?.remainingHeadroomRank ??
      (remainingPercent === null ? 101 : 100 - remainingPercent),
    rendezvousScore: input.routingPriority?.rendezvousScore ??
      `${(0xffff_ffff - index).toString(16).padStart(16, "0")}${"0".repeat(48)}`,
    selected: input.routingPriority?.selected ?? index === 0,
  };
  const candidate: PersistentActorAccountCandidate = {
    accountProfileId: input.accountProfileId,
    activeTurnCount: input.activeTurnCount ?? 0,
    capabilityEvidenceDigest,
    modelId,
    processGeneration: input.processGeneration,
    profileFallbackReason,
    remainingPercent,
    selectedProfile,
    supportsFast: input.supportsFast ?? false,
    reasoningEffort,
    routingPriority,
  };
  // Keep the identity of hand-authored account fixtures. A few failover tests
  // advance a configured process generation after admission to prove that
  // visitation is subscription-scoped rather than generation-scoped.
  Object.assign(input as unknown as Record<string, unknown>, candidate);
  return input as unknown as PersistentActorAccountCandidate;
}

function epochAndRoot(): Readonly<{ epoch: ActorEpoch; rootActor: Actor }> {
  const actorBudget = budget();
  return {
    epoch: actorEpochSchema.parse({
      id: epochId,
      projectId,
      sourceSha,
      rootActorId,
      budget: actorBudget,
      tokenReserved: 0,
      byteReserved: 0,
      nextRootCompletionSequence: 1,
      state: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      stoppedAt: null,
    }),
    rootActor: actorSchema.parse({
      id: rootActorId,
      epochId,
      parentActorId: null,
      depth: 0,
      title: "Persistent root",
      state: "active",
      budget: actorBudget,
      tokenReserved: 0,
      byteReserved: 0,
      nextTurnOrdinal: 1,
      nextResultOrdinal: 1,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      stoppedAt: null,
    }),
  };
}

class FakeProvider implements PersistentActorProviderPort {
  readonly #database: Database;
  readonly continuationCaptures: PersistentActorQuotaContinuationCaptureRequest[] = [];
  readonly threadStarts: PersistentActorThreadRequest[] = [];
  readonly threadReconciliations: PersistentActorThreadRequest[] = [];
  readonly turnStarts: PersistentActorTurnRequest[] = [];
  readonly turnReconciliations: PersistentActorTurnRequest[] = [];
  readonly fastCapacityReconciliations: PersistentActorTurnRequest[] = [];
  readonly observations: PersistentActorTurnObservationRequest[] = [];
  readonly interrupts: PersistentActorInterruptRequest[] = [];
  readonly interruptReconciliations: PersistentActorInterruptRequest[] = [];
  readonly threadOutcomes = new Map<string, PersistentActorThreadOutcome>();
  readonly turnOutcomes = new Map<string, PersistentActorTurnOutcome>();
  readonly reconcileTurnOutcomes = new Map<string, PersistentActorTurnOutcome>();
  readonly fastCapacityOutcomes = new Map<string, unknown>();
  readonly observationOutcomes = new Map<string, unknown>();
  interruptOutcome: unknown = {
    kind: "applied",
    providerTurnId: "provider-turn-default",
    proof: proof("9"),
  };
  throwNextThreadStart = false;
  throwNextTurnStart = false;
  throwNextInterrupt = false;
  beforeTurnStartResponse: ((
    request: PersistentActorTurnRequest,
    outcome: PersistentActorTurnOutcome,
  ) => Promise<void>) | null = null;
  continuationCaptureOutcome: unknown = null;

  constructor(database: Database) {
    this.#database = database;
  }

  captureQuotaContinuation(
    request: PersistentActorQuotaContinuationCaptureRequest,
  ): Promise<unknown> {
    this.continuationCaptures.push(request);
    if (this.continuationCaptureOutcome !== null) {
      return Promise.resolve(this.continuationCaptureOutcome);
    }
    const suffix = createHmac(
      "sha256",
      "oprte-persistent-actor-test-continuation-capsule",
    ).update(JSON.stringify(request)).digest("hex").slice(0, 48);
    const valueId = `ctxval_${suffix}`;
    insertContextValue(this.#database, {
      actorId: request.actorId,
      turnId: request.actorTurnId,
      valueId,
      purpose: "completedPrefix",
    });
    return Promise.resolve({
      kind: "captured",
      handle: {
        version: 2,
        epochId: request.epochId,
        actorId: request.actorId,
        actorTurnId: request.actorTurnId,
        sourceAttemptId: request.sourceAttemptId,
        valueId,
      },
      proof: proof("c", { phase: "observation" }),
    });
  }

  startThread(request: PersistentActorThreadRequest): Promise<unknown> {
    this.threadStarts.push(request);
    if (this.throwNextThreadStart) {
      this.throwNextThreadStart = false;
      return Promise.reject(new Error("lost response"));
    }
    return Promise.resolve(
      this.threadOutcomes.get(request.accountProfileId) ??
        appliedThreadOutcome(request),
    );
  }

  reconcileThread(request: PersistentActorThreadRequest): Promise<unknown> {
    this.threadReconciliations.push(request);
    return Promise.resolve(this.threadOutcomes.get(request.accountProfileId) ?? {
      kind: "pending",
      proof: proof("2", { definitive: false, phase: "observation" }),
    });
  }

  async startTurn(request: PersistentActorTurnRequest): Promise<unknown> {
    this.turnStarts.push(request);
    const outcome = this.turnOutcomes.get(request.accountProfileId) ?? {
      kind: "applied" as const,
      providerTurnId:
        `provider-turn-${request.accountProfileId}-${this.turnStarts.length}`,
      proof: proof("3"),
    };
    await this.beforeTurnStartResponse?.(request, outcome);
    if (this.throwNextTurnStart) {
      this.throwNextTurnStart = false;
      throw new Error("lost response");
    }
    return outcome;
  }

  reconcileTurn(request: PersistentActorTurnRequest): Promise<unknown> {
    this.turnReconciliations.push(request);
    return Promise.resolve(this.reconcileTurnOutcomes.get(request.accountProfileId) ??
      this.turnOutcomes.get(request.accountProfileId) ?? {
        kind: "pending",
        proof: proof("4", { definitive: false, phase: "observation" }),
      });
  }

  reconcileQuarantinedFastCapacity(
    request: PersistentActorTurnRequest,
  ): Promise<unknown> {
    this.fastCapacityReconciliations.push(request);
    return Promise.resolve(
      this.fastCapacityOutcomes.get(request.fastReservationId ?? "") ?? {
        kind: "held",
        reason: "successorGenerationUnavailable",
        successorGeneration: request.processGeneration,
        proof: proof("d", { definitive: false, phase: "observation" }),
      },
    );
  }

  observeTurn(request: PersistentActorTurnObservationRequest): Promise<unknown> {
    this.observations.push(request);
    return Promise.resolve(this.observationOutcomes.get(request.turnId) ?? {
      kind: "pending",
      proof: proof("5", { definitive: false, phase: "observation" }),
    });
  }

  interruptTurn(request: PersistentActorInterruptRequest): Promise<unknown> {
    this.interrupts.push(request);
    if (this.throwNextInterrupt) {
      this.throwNextInterrupt = false;
      return Promise.reject(new Error("lost response"));
    }
    return Promise.resolve({
      ...(this.interruptOutcome as object),
      ...(typeof this.interruptOutcome === "object" && this.interruptOutcome !== null &&
          "kind" in this.interruptOutcome && this.interruptOutcome.kind === "applied"
        ? { providerTurnId: request.providerTurnId }
        : {}),
    });
  }

  reconcileInterrupt(request: PersistentActorInterruptRequest): Promise<unknown> {
    this.interruptReconciliations.push(request);
    return Promise.resolve({
      ...(this.interruptOutcome as object),
      ...(typeof this.interruptOutcome === "object" && this.interruptOutcome !== null &&
          "kind" in this.interruptOutcome && this.interruptOutcome.kind === "applied"
        ? { providerTurnId: request.providerTurnId }
        : {}),
    });
  }
}

interface Fixture {
  readonly database: Database;
  readonly authority: HarnessSQLiteAuthorityV2;
  readonly provider: FakeProvider;
  readonly accounts: PersistentActorAccountCandidate[];
  readonly coordinator: PersistentActorCoordinator;
  readonly restart: () => PersistentActorCoordinator;
  readonly controls: {
    now: string;
    prepareInputFailure: Error | null;
    workspaceFailure: Error | null;
    workspaceBarrier: (() => Promise<void>) | null;
    accountEligibilityCalls: number;
    accountEligibilityBarrier: ((call: number) => Promise<void>) | null;
    crashBeforeAccountLease: boolean;
    crashAfterAuthorityStep:
      | "quotaSettlement"
      | "turnReconciling"
      | "sourceClosed"
      | "preEffectQuotaAttempt"
      | "rerouteBound"
      | null;
    legacyFastContainmentPrefix:
      | "attempt"
      | "turn"
      | "incarnation"
      | "stopRequested"
      | null;
    afterAttemptClaim: ((claim: Readonly<{
      attemptId: string;
      incarnationId: string;
    }>) => void) | null;
    invalidSessionIncarnationId: string | null;
    readonly workspaceAcquisitions: string[];
    readonly accountCandidates: PersistentActorAccountCandidate[];
    readonly temporarilyUnavailableAccountProfileIds: string[];
  };
}

function fixture(
  accountInput: number | readonly AccountCandidateFixtureInput[] = 2,
  liveness?: PersistentActorLivenessPortV2,
  sessionReadiness?: HarnessActorSessionReadinessPortV2,
  clock?: PersistentActorClockPort,
): Fixture {
  const database = Database.deserialize(
    migratedDatabaseFixture.slice(),
    { strict: true },
  );
  database.exec("PRAGMA foreign_keys = ON");
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/oprte-persistent', '/tmp/oprte-persistent/.git',
      'Persistent actors', ?2, ?2)
  `).run(projectId, at);
  const accounts = typeof accountInput === "number"
    ? Array.from({ length: accountInput }, (_, index) => accountCandidate({
        accountProfileId: `acct_persistent_${String(index + 1).padStart(4, "0")}`,
        processGeneration: 1,
      }, index))
    : accountInput.map((account, index) => accountCandidate(account, index));
  for (const account of accounts) {
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, ?1, 'signed_in', ?2, 0, ?3, ?3)
    `).run(account.accountProfileId, account.processGeneration, at);
  }
  const authority = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(at),
    tokenUsageIdentities,
  });
  authority.createActorEpoch(epochAndRoot());
  const provider = new FakeProvider(database);
  const controls: Fixture["controls"] = {
    now: at,
    prepareInputFailure: null,
    workspaceFailure: null,
    workspaceBarrier: null,
    accountEligibilityCalls: 0,
    accountEligibilityBarrier: null,
    crashBeforeAccountLease: false,
    crashAfterAuthorityStep: null,
    legacyFastContainmentPrefix: null,
    afterAttemptClaim: null,
    invalidSessionIncarnationId: null,
    workspaceAcquisitions: [],
    accountCandidates: [...accounts],
    temporarilyUnavailableAccountProfileIds: [],
  };
  let crashAttemptRead: Error | null = null;
  const maybeCrash = (
    step: Exclude<Fixture["controls"]["crashAfterAuthorityStep"], null>,
  ): void => {
    if (controls.crashAfterAuthorityStep !== step) return;
    controls.crashAfterAuthorityStep = null;
    throw new Error(`injected crash after ${step}`);
  };
  const authorityPort = new Proxy(authority, {
    get(target, property) {
      if (property === "readActorSessionBinding") {
        return (incarnationId: string) =>
          controls.invalidSessionIncarnationId === incarnationId
            ? null
            : target.readActorSessionBinding(incarnationId);
      }
      if (property === "readActorAttempt") {
        return (attemptId: string) => {
          if (crashAttemptRead !== null) {
            const failure = crashAttemptRead;
            crashAttemptRead = null;
            throw failure;
          }
          return target.readActorAttempt(attemptId);
        };
      }
      if (property === "claimActorAttempt") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "claimActorAttempt"
        ]>[0]) => {
          const claimed = target.claimActorAttempt(input);
          controls.afterAttemptClaim?.({
            attemptId: claimed.attempt.id,
            incarnationId: claimed.incarnation.id,
          });
          return claimed;
        };
      }
      if (property === "bindActorAttemptProviderTurn") {
        return async (input: Parameters<PersistentActorAuthorityPort[
          "bindActorAttemptProviderTurn"
        ]>[0]) => {
          const bound = await target.bindActorAttemptProviderTurn(input);
          maybeCrash("rerouteBound");
          return bound;
        };
      }
      if (property === "createActorIncarnationWithAccountLease") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "createActorIncarnationWithAccountLease"
        ]>[0]) => {
          if (controls.crashBeforeAccountLease) {
            controls.crashBeforeAccountLease = false;
            throw new Error("injected crash before atomic account lease");
          }
          return target.createActorIncarnationWithAccountLease(input);
        };
      }
      if (property === "containAmbiguousActorTurn") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "containAmbiguousActorTurn"
        ]>[0]) => {
          const prefix = controls.legacyFastContainmentPrefix;
          if (prefix === null) {
            return target.containAmbiguousActorTurn(input);
          }
          controls.legacyFastContainmentPrefix = null;
          const now = input.now ?? controls.now;
          let attempt = target.readActorAttempt(input.attemptId);
          if (attempt === null) throw new Error("legacy Fast attempt is missing");
          if (!isTerminalActorAttemptState(attempt.state)) {
            attempt = target.transitionActorAttempt({
              attemptId: attempt.id,
              expectedState: attempt.state,
              nextState: "ambiguous",
              now,
            });
          }
          if (prefix === "attempt") {
            throw new Error("injected crash after legacy Fast attempt fence");
          }
          let turn = target.readActorTurn(attempt.turnId);
          if (turn === null) throw new Error("legacy Fast turn is missing");
          if (!isTerminalActorTurnState(turn.state)) {
            turn = target.transitionActorTurn({
              turnId: turn.id,
              expectedRevision: turn.revision,
              nextState: "ambiguous",
              outcomeCode:
                `ambiguous_${(input.evidenceDigest ?? "0".repeat(64)).slice(0, 16)}`,
              now,
            });
          }
          if (prefix === "turn") {
            throw new Error("injected crash after legacy Fast turn fence");
          }
          const incarnation = target.readActorIncarnation(
            attempt.incarnationId,
          );
          if (incarnation === null) {
            throw new Error("legacy Fast incarnation is missing");
          }
          if (
            incarnation.state === "starting" || incarnation.state === "idle" ||
            incarnation.state === "running"
          ) {
            target.transitionActorIncarnation({
              incarnationId: incarnation.id,
              expectedState: incarnation.state,
              nextState: "quarantined",
              providerThreadId: incarnation.providerThreadId,
              now,
            });
          }
          if (prefix === "incarnation") {
            throw new Error(
              "injected crash after legacy Fast incarnation fence",
            );
          }
          const actor = target.readActor(turn.actorId);
          if (actor === null) throw new Error("legacy Fast actor is missing");
          if (actor.state === "active") {
            target.requestActorStop({
              actorId: actor.id,
              expectedRevision: actor.revision,
              now,
            });
          }
          throw new Error("injected crash after legacy Fast stop request");
        };
      }
      if (property === "settleActorQuotaRejection") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "settleActorQuotaRejection"
        ]>[0]) => {
          const settled = target.settleActorQuotaRejection(input);
          maybeCrash("quotaSettlement");
          return settled;
        };
      }
      if (property === "transitionActorTurn") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "transitionActorTurn"
        ]>[0]) => {
          const transitioned = target.transitionActorTurn(input);
          if (input.nextState === "reconciling") maybeCrash("turnReconciling");
          return transitioned;
        };
      }
      if (property === "transitionActorAttempt") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "transitionActorAttempt"
        ]>[0]) => {
          const transitioned = target.transitionActorAttempt(input);
          if (
            input.nextState === "quotaRejected" &&
            controls.crashAfterAuthorityStep === "preEffectQuotaAttempt"
          ) {
            controls.crashAfterAuthorityStep = null;
            crashAttemptRead = new Error(
              "injected crash after preEffectQuotaAttempt",
            );
            throw crashAttemptRead;
          }
          return transitioned;
        };
      }
      if (property === "transitionActorIncarnation") {
        return (input: Parameters<PersistentActorAuthorityPort[
          "transitionActorIncarnation"
        ]>[0]) => {
          const transitioned = target.transitionActorIncarnation(input);
          if (input.nextState === "closed") maybeCrash("sourceClosed");
          return transitioned;
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function"
        ? (...args: readonly unknown[]): unknown =>
          Reflect.apply(member, target, args) as unknown
        : member;
    },
  }) as PersistentActorAuthorityPort;
  const createCoordinator = () => new PersistentActorCoordinator({
    authority: authorityPort,
    provider,
    accounts: {
      listEligibleAccounts: async () => {
        controls.accountEligibilityCalls += 1;
        await controls.accountEligibilityBarrier?.(
          controls.accountEligibilityCalls,
        );
        return {
          kind: "resolved" as const,
          candidates: [...controls.accountCandidates],
          temporarilyUnavailableAccountProfileIds: [
            ...controls.temporarilyUnavailableAccountProfileIds,
          ],
          unsupportedAccountProfileIds: [],
        };
      },
    },
    workspaces: {
      acquire: async ({ epoch, actor }) => {
        controls.workspaceAcquisitions.push(actor.id);
        await controls.workspaceBarrier?.();
        if (controls.workspaceFailure !== null) {
          throw controls.workspaceFailure;
        }
        const laneId = actor.budget.laneAuthority === "readOnlySnapshot"
          ? "lane_persistent_snapshot"
          : `lane_${actor.id.slice(7)}`;
        database.query(`
          INSERT OR IGNORE INTO workspace_leases (
            lane_id, project_id, canonical_checkout_path, mode, status,
            base_sha, branch_name, retention, dirty_hint,
            created_at, updated_at, quarantine_reason, quarantined_at
          ) VALUES (
            ?1, ?2, ?3, 'harness_read_only_snapshot', 'ready', ?4,
            NULL, 'preserve', 0, ?5, ?5, NULL, NULL
          )
        `).run(
          laneId,
          epoch.projectId,
          actor.budget.laneAuthority === "readOnlySnapshot"
            ? "/tmp/oprte-persistent/snapshot"
            : `/tmp/oprte-persistent/${actor.id}`,
          epoch.sourceSha,
          at,
        );
        return { laneId, authority: actor.budget.laneAuthority };
      },
    },
    values: {
      prepareActorInput: ({ targetActorId, sourceValueId }) => {
        if (controls.prepareInputFailure !== null) {
          return Promise.reject(controls.prepareInputFailure);
        }
        const target = authority.readActor(targetActorId);
        if (target === null) {
          return Promise.reject(new Error("target actor is unavailable"));
        }
        insertContextValue(database, {
          actorId: targetActorId,
          epochId: target.epochId,
          turnId: null,
          valueId: sourceValueId,
          purpose: "actorTask",
        });
        return Promise.resolve({ valueId: sourceValueId });
      },
      assertResultAvailable: ({ actorId, turnId, valueId }) => {
        insertContextValue(database, {
          actorId,
          turnId,
          valueId,
          purpose: "agentResult",
        });
        return Promise.resolve();
      },
    },
    toolsetDigest,
    liveness: liveness ?? {
      ensureCurrent: () => Promise.resolve(),
    },
    ...(sessionReadiness === undefined ? {} : { sessionReadiness }),
    clock: clock ?? {
      now: () => new Date(controls.now),
      sleep: () => Promise.resolve(),
    },
  });
  const coordinator = createCoordinator();
  return {
    database,
    authority,
    provider,
    accounts,
    coordinator,
    restart: createCoordinator,
    controls,
  };
}

function spawnInput(
  suffix = "0000000000000001",
  byteBudget = 2 * MIB,
) {
  return {
    callerActorId: rootActorId,
    idempotencyKey: `spawn-${suffix}`,
    title: `Actor ${suffix}`,
    budget: {
      ...budget(),
      tokenBudget: 10_000,
      byteBudget,
    },
    inputValueId: `ctxval_input_${suffix}`,
    policyVersion: 1 as const,
    workClass: "largeChange" as const,
    acceleration: { mode: "standard" as const },
  };
}

function tokenUsageFact(input: Readonly<{
  accountProfileId: string;
  generation: number;
  providerThreadId: string;
  providerTurnId: string;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCachedInputTokens?: number;
  cumulativeReasoningOutputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  streamPosition?: number;
}>): Extract<CodexFact, Readonly<{ type: "turn.token_usage" }>> {
  return Object.freeze({
    type: "turn.token_usage",
    accountProfileId: input.accountProfileId,
    encodedBytes: 128,
    factIndex: 0,
    generation: input.generation,
    origin: "live",
    streamPosition: input.streamPosition ?? 1,
    threadId: input.providerThreadId,
    turnId: input.providerTurnId,
    cumulativeInputTokens: input.cumulativeInputTokens ?? input.inputTokens,
    cumulativeOutputTokens: input.cumulativeOutputTokens ?? input.outputTokens,
    cumulativeCachedInputTokens: input.cumulativeCachedInputTokens ?? 0,
    cumulativeReasoningOutputTokens:
      input.cumulativeReasoningOutputTokens ?? 0,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    reasoningOutputTokens: input.reasoningOutputTokens ?? 0,
  });
}

function modelRerouteFact(input: Readonly<{
  accountProfileId: string;
  generation: number;
  providerThreadId: string;
  providerTurnId: string;
  streamPosition?: number;
  fromModel?: string;
  toModel?: string;
}>): Extract<CodexFact, Readonly<{ type: "turn.model_rerouted" }>> {
  return Object.freeze({
    type: "turn.model_rerouted",
    accountProfileId: input.accountProfileId,
    encodedBytes: 256,
    factIndex: 0,
    generation: input.generation,
    origin: "live",
    streamPosition: input.streamPosition ?? 33,
    threadId: input.providerThreadId,
    turnId: input.providerTurnId,
    fromModel: input.fromModel ?? "gpt-5.6-sol",
    toModel: input.toModel ?? "safety-reroute-model",
    reason: "highRiskCyberActivity",
  });
}

function createDirectDescendant(
  value: Fixture,
  parent: Actor,
  index: number,
  state: "active" | "stopped",
  actorDeadline = parent.budget.deadline,
): Actor {
  const suffix = String(index).padStart(4, "0");
  let child = value.authority.createChildActor(actorSchema.parse({
    id: `hactor_descendant_${suffix}`,
    epochId: parent.epochId,
    parentActorId: parent.id,
    depth: parent.depth + 1,
    title: `Descendant ${suffix}`,
    state: "active",
    budget: {
      maxDepth: parent.budget.maxDepth,
      maxActiveDescendants: 1,
      maxDurableDescendants: 1,
      tokenBudget: 1,
      byteBudget: MIB,
      deadline: actorDeadline,
      laneAuthority: parent.budget.laneAuthority,
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  }), {
    policyVersion: 1,
    workClass: "largeChange",
  });
  if (state === "stopped") {
    child = value.authority.settleActorStop({
      actorId: child.id,
      expectedRevision: child.revision,
      nextState: "stopped",
      now: at,
    });
  }
  return child;
}

function deriveTestOpaqueId(
  prefix: string,
  namespace: string,
  parts: readonly (string | number)[],
): string {
  const hash = createHash("sha256").update(`oprte.${namespace}.v2\0`);
  for (const part of parts) hash.update(String(part)).update("\0");
  return `${prefix}_${hash.digest("base64url").slice(0, 48)}`;
}

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalTestJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`
  ).join(",")}}`;
}

function digestCanonicalTest(value: unknown): string {
  return createHash("sha256").update(canonicalTestJson(value)).digest("hex");
}

function seedLegacyActorStart(
  value: Fixture,
  suffix: string,
  state: "prepared" | "effectStarted",
): Readonly<{
  actor: Actor;
  incarnationId: string;
  operationId: string;
  request: PersistentActorThreadRequest;
}> {
  const root = value.authority.readActor(rootActorId);
  if (root === null) throw new Error("legacy fixture lost its root actor");
  const actor = value.authority.createChildActor(actorSchema.parse({
    id: deriveTestOpaqueId("hactor", "legacy-actor", [suffix]),
    epochId: root.epochId,
    parentActorId: root.id,
    depth: root.depth + 1,
    title: `Legacy actor ${suffix}`,
    state: "active",
    budget: {
      ...budget(),
      maxActiveDescendants: 1,
      maxDurableDescendants: 1,
      tokenBudget: 10_000,
      byteBudget: 2 * MIB,
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  }), {
    policyVersion: 0,
    workClass: "legacyUnclassified",
  });
  const account = value.accounts[0];
  if (account === undefined) throw new Error("legacy fixture requires an account");
  const operationId = deriveTestOpaqueId(
    "hoperation",
    "legacy-actor-start",
    [actor.id, suffix],
  );
  const incarnationId = deriveTestOpaqueId(
    "hincarnation",
    "incarnation",
    [operationId],
  );
  const request: PersistentActorThreadRequest = Object.freeze({
    actorId: actor.id,
    epochId: actor.epochId,
    policyVersion: 0,
    workClass: "legacyUnclassified",
    accountProfileId: account.accountProfileId,
    processGeneration: account.processGeneration,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    selectedProfile: "solUltra",
    profileFallbackReason: null,
    capabilityEvidenceDigest: null,
    supportsFast: false,
    clientRequestId: deriveTestOpaqueId(
      "client",
      "thread-request",
      [operationId],
    ),
    threadSource: `oprte:harness:v2:${actor.epochId}:${actor.id}:${incarnationId}`,
    toolsetDigest: HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
    workspaceLaneId: "lane_persistent_snapshot",
    effectKey: digestCanonicalTest([
      "oprte.actor.effect.v2",
      operationId,
      "thread/start",
    ]),
    continuation: null,
  });
  const operation = value.authority.prepareActorOperation({
    operationId,
    actorId: actor.id,
    turnId: null,
    kind: "actorStart",
    requestDigest: digestCanonicalTest(request),
    effectKey: request.effectKey,
    providerIdentityJson: canonicalTestJson({ version: 1, request }),
    createdAt: at,
  });
  if (state === "effectStarted") {
    value.authority.transitionActorOperation({
      operationId,
      expectedState: operation.state,
      nextState: "effectStarted",
      providerIdentityJson: operation.providerIdentityJson,
      now: at,
    });
  }
  value.authority.createActorIncarnation({
    incarnationId,
    actorId: actor.id,
    accountProfileId: account.accountProfileId,
    processGeneration: account.processGeneration,
    startOperationId: operationId,
    clientRequestId: request.clientRequestId,
    threadSource: request.threadSource,
    toolsetDigest: request.toolsetDigest,
    profile: {
      modelId: request.modelId,
      reasoningEffort: request.reasoningEffort,
      profileFallbackReason: null,
      capabilityEvidenceDigest: null,
      supportsFast: null,
    },
    createdAt: at,
  });
  return Object.freeze({ actor, incarnationId, operationId, request });
}

async function materializeLegacyIncarnation(
  value: Fixture,
  suffix: string,
): Promise<ReturnType<typeof seedLegacyActorStart>> {
  const seeded = seedLegacyActorStart(value, suffix, "effectStarted");
  value.database.query(`
    INSERT OR IGNORE INTO workspace_leases (
      lane_id, project_id, canonical_checkout_path, mode, status,
      base_sha, branch_name, retention, dirty_hint,
      created_at, updated_at, quarantine_reason, quarantined_at
    ) VALUES (
      ?1, ?2, '/tmp/oprte-persistent/snapshot',
      'harness_read_only_snapshot', 'ready', ?3,
      NULL, 'preserve', 0, ?4, ?4, NULL, NULL
    )
  `).run(
    seeded.request.workspaceLaneId,
    projectId,
    sourceSha,
    at,
  );
  value.authority.bindActorWorkspace({
    bindingId: deriveTestOpaqueId(
      "hbinding",
      "workspace-binding",
      [seeded.actor.id],
    ),
    actorId: seeded.actor.id,
    laneId: seeded.request.workspaceLaneId,
    authority: seeded.actor.budget.laneAuthority,
    createdAt: at,
  });
  value.provider.threadOutcomes.set(
    seeded.request.accountProfileId,
    appliedThreadOutcome(
      seeded.request,
      `provider-thread-legacy-${suffix}`,
    ),
  );
  await value.coordinator.reconcileSessionAdmissions();
  return seeded;
}

function seedLegacyTurn(
  value: Fixture,
  actor: Actor,
  suffix: string,
) {
  const idempotencyKey = `legacy-replay-${suffix}`;
  const inputValueId = `ctxval_legacy_${suffix}`;
  insertContextValue(value.database, {
    actorId: actor.id,
    turnId: null,
    valueId: inputValueId,
    purpose: "actorTask",
  });
  const turnId = deriveTestOpaqueId("hturn", "turn", [
    actor.epochId,
    actor.id,
    idempotencyKey,
  ]);
  const turn = value.authority.createActorTurn({
    turnId,
    epochId: actor.epochId,
    actorId: actor.id,
    idempotencyKey,
    inputValueId,
    acceleration: { mode: "standard" },
    createdAt: at,
  });
  return Object.freeze({ turn, idempotencyKey, inputValueId });
}

function seedLegacyEffectStartedTurn(
  value: Fixture,
  actor: Actor,
  incarnationId: string,
  suffix: string,
): Readonly<{
  turn: ReturnType<typeof seedLegacyTurn>["turn"];
  attemptId: string;
  operationId: string;
  request: PersistentActorTurnRequest;
}> {
  let { turn } = seedLegacyTurn(value, actor, suffix);
  turn = value.authority.transitionActorTurn({
    turnId: turn.id,
    expectedRevision: turn.revision,
    nextState: "starting",
    now: at,
  });
  const incarnation = value.authority.readActorIncarnation(incarnationId);
  const session = value.authority.readActorSessionBinding(incarnationId);
  if (
    incarnation?.providerThreadId === null ||
    incarnation?.providerThreadId === undefined ||
    session === null
  ) {
    throw new Error("legacy effect fixture lacks its materialized session");
  }
  const attemptId = deriveTestOpaqueId("hattempt", "attempt", [
    turn.id,
    incarnation.id,
  ]);
  const clientUserMessageId = deriveTestOpaqueId("message", "turn-message", [
    turn.id,
    incarnation.id,
  ]);
  value.authority.claimActorAttempt({
    attemptId,
    turnId: turn.id,
    incarnationId: incarnation.id,
    accountProfileId: incarnation.accountProfileId,
    processGeneration: incarnation.processGeneration,
    clientUserMessageId,
    dispatch: { capabilityEvidenceDigest: null },
    createdAt: at,
  });
  const operationId = deriveTestOpaqueId("hoperation", "turn-start", [
    turn.id,
    incarnation.id,
  ]);
  const request: PersistentActorTurnRequest = Object.freeze({
    actorId: actor.id,
    epochId: actor.epochId,
    turnId: turn.id,
    incarnationId: incarnation.id,
    accountProfileId: incarnation.accountProfileId,
    processGeneration: session.liveGeneration,
    observationGeneration: session.liveGeneration,
    providerThreadId: incarnation.providerThreadId,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    requestedAcceleration: { mode: "standard" as const },
    serviceTier: "standard",
    tierFallbackReason: null,
    capabilityEvidenceDigest: null,
    fastReservationId: null,
    toolsetDigest: HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
    clientUserMessageId,
    inputValueId: turn.inputValueId,
    effectKey: digestCanonicalTest([
      "oprte.actor.effect.v2",
      operationId,
      "turn/start",
    ]),
    continuation: null,
  });
  const operation = value.authority.prepareActorOperation({
    operationId,
    actorId: actor.id,
    turnId: turn.id,
    kind: "turnStart",
    requestDigest: digestCanonicalTest(request),
    effectKey: request.effectKey,
    providerIdentityJson: canonicalTestJson({ version: 1, request }),
    createdAt: at,
  });
  value.authority.transitionActorOperation({
    operationId,
    expectedState: operation.state,
    nextState: "effectStarted",
    providerIdentityJson: operation.providerIdentityJson,
    now: at,
  });
  return Object.freeze({ turn, attemptId, operationId, request });
}

function seedLegacyInterrupt(
  value: Fixture,
  turnId: string,
  attemptId: string,
  state: "prepared" | "effectStarted",
): Readonly<{
  operationId: string;
  request: PersistentActorInterruptRequest;
}> {
  const turn = value.authority.readActorTurn(turnId);
  const attempt = value.authority.readActorAttempt(attemptId);
  if (turn === null || attempt?.providerTurnId === null || attempt === null) {
    throw new Error("legacy interrupt fixture lacks its running provider turn");
  }
  const incarnation = value.authority.readActorIncarnation(attempt.incarnationId);
  const session = value.authority.readActorSessionBinding(attempt.incarnationId);
  if (
    incarnation?.providerThreadId === null ||
    incarnation?.providerThreadId === undefined ||
    session === null
  ) {
    throw new Error("legacy interrupt fixture lacks its provider session");
  }
  const operationId = deriveTestOpaqueId("hoperation", "turn-interrupt", [
    turn.id,
    incarnation.id,
  ]);
  const request: PersistentActorInterruptRequest = Object.freeze({
    actorId: turn.actorId,
    turnId: turn.id,
    incarnationId: incarnation.id,
    accountProfileId: attempt.accountProfileId,
    processGeneration: session.liveGeneration,
    observationGeneration: session.liveGeneration,
    providerThreadId: incarnation.providerThreadId,
    providerTurnId: attempt.providerTurnId,
    effectKey: digestCanonicalTest([
      "oprte.actor.effect.v2",
      operationId,
      "turn/interrupt",
    ]),
  });
  const operation = value.authority.prepareActorOperation({
    operationId,
    actorId: turn.actorId,
    turnId: turn.id,
    kind: "turnInterrupt",
    requestDigest: digestCanonicalTest(request),
    effectKey: request.effectKey,
    providerIdentityJson: canonicalTestJson({ version: 1, request }),
    createdAt: at,
  });
  if (state === "effectStarted") {
    value.authority.transitionActorOperation({
      operationId,
      expectedState: operation.state,
      nextState: "effectStarted",
      providerIdentityJson: operation.providerIdentityJson,
      now: at,
    });
  }
  return Object.freeze({ operationId, request });
}

function providerThreadIdForIncarnation(
  value: Fixture,
  incarnationId: string,
): string {
  const providerThreadId = value.authority.readActorIncarnation(incarnationId)
    ?.providerThreadId;
  if (providerThreadId === null || providerThreadId === undefined) {
    throw new Error("actor fixture lacks its exact provider thread identity");
  }
  return providerThreadId;
}

function terminalEvent(
  request: PersistentActorTurnRequest,
  terminal: PersistentActorTerminalObservation["terminal"],
  marker: string,
): PersistentActorTerminalObservation {
  return {
    accountProfileId: request.accountProfileId,
    processGeneration: request.processGeneration,
    providerThreadId: request.providerThreadId,
    providerTurnId: `provider-turn-${request.accountProfileId}-${marker}`,
    terminal,
    resultValueId: terminal === "completed" ? `ctxval_result_${marker}` : null,
    outcomeCode: terminal,
    quotaProof: null,
    inputTokens: 12,
    outputTokens: 34,
    proof: proof("8", { phase: "observation" }),
  };
}

async function recordExactTerminalUsage(
  value: Fixture,
  event: PersistentActorTerminalObservation,
): Promise<void> {
  if (event.inputTokens === null || event.outputTokens === null) {
    throw new Error("terminal fixture requires exact token usage");
  }
  const observation = value.authority.resolveActorAttemptObservation({
    accountProfileId: event.accountProfileId,
    observationGeneration: event.processGeneration,
    providerThreadId: event.providerThreadId,
    providerTurnId: event.providerTurnId,
  });
  if (observation === null) {
    throw new Error("terminal fixture lacks its exact actor attempt");
  }
  const attempt = observation.attempt;
  const incarnation = value.authority.readActorIncarnation(
    attempt.incarnationId,
  );
  if (incarnation?.providerThreadId === null ||
    incarnation?.providerThreadId === undefined) {
    throw new Error("terminal fixture lacks its exact provider thread");
  }
  const recorded = await value.authority.recordActorTurnUsage({
    accountProfileId: event.accountProfileId,
    processGeneration: event.processGeneration,
    providerThreadId: event.providerThreadId,
    providerTurnId: event.providerTurnId,
    streamPosition: (incarnation.tokenUsageLatestPosition ?? 0) + 1,
    cumulativeInputTokens:
      incarnation.tokenUsageCumulativeInputTokens + event.inputTokens,
    cumulativeOutputTokens:
      incarnation.tokenUsageCumulativeOutputTokens + event.outputTokens,
  });
  if (!recorded) throw new Error("terminal fixture usage was not admitted");
  expect(value.authority.readActorTurnUsage({
    accountProfileId: event.accountProfileId,
    processGeneration: attempt.processGeneration,
    providerTurnId: event.providerTurnId,
  })).toEqual({
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });
}

async function observeTerminalWithExactUsage(
  value: Fixture,
  event: PersistentActorTerminalObservation,
) {
  await recordExactTerminalUsage(value, event);
  return await value.coordinator.observeTerminal(event);
}

async function preparePostAdmissionQuota(
  value: Fixture,
  suffix: string,
): Promise<Readonly<{
  actorId: string;
  turnId: string;
  attemptId: string;
  incarnationId: string;
  event: PersistentActorTerminalObservation;
}>> {
  const spawned = await value.coordinator.spawn(spawnInput(suffix));
  const attempt = value.authority.listActorAttempts({
    turnId: spawned.turn.turn.id,
    limit: 16,
  })[0];
  if (attempt?.providerTurnId === null || attempt?.providerTurnId === undefined) {
    throw new Error("quota crash fixture lacks its provider turn identity");
  }
  const event: PersistentActorTerminalObservation = {
    accountProfileId: attempt.accountProfileId,
    processGeneration: attempt.processGeneration,
    providerThreadId: providerThreadIdForIncarnation(
      value,
      attempt.incarnationId,
    ),
    providerTurnId: attempt.providerTurnId,
    terminal: "failed",
    resultValueId: null,
    outcomeCode: "usage_limit_exceeded",
    quotaProof: "provider_usage_limit_exceeded",
    inputTokens: 23,
    outputTokens: 11,
    proof: proof("8", { phase: "observation" }),
  };
  await recordExactTerminalUsage(value, event);
  return Object.freeze({
    actorId: spawned.actor.id,
    turnId: spawned.turn.turn.id,
    attemptId: attempt.id,
    incarnationId: attempt.incarnationId,
    event,
  });
}

function insertContextValue(
  database: Database,
  input: Readonly<{
    actorId: string;
    epochId?: string;
    turnId: string | null;
    valueId: string;
    purpose: "actorTask" | "agentResult" | "completedPrefix";
  }>,
): void {
  database.query(`
    INSERT OR IGNORE INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, 1,
      ?8, 65536, 1, ?9, 1, 16777216, 'active', NULL,
      3, ?10, ?10, ?10, ?10
    )
  `).run(
    input.valueId,
    `contextop_${input.valueId}`,
    input.epochId ?? epochId,
    input.actorId,
    input.turnId,
    input.purpose === "agentResult"
      ? "agentResult"
      : input.purpose === "completedPrefix"
        ? "selection"
        : "text",
    input.purpose,
    "c".repeat(64),
    "d".repeat(64),
    at,
  );
  database.query(`
    INSERT OR IGNORE INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 1)
  `).run(input.valueId, "e".repeat(64));
}

function seedRootLiveTurnPrefix(
  value: Fixture,
  count: number,
  includeAttempts = false,
): void {
  const inputValueId = "ctxval_prefix_recovery_input";
  insertContextValue(value.database, {
    actorId: rootActorId,
    turnId: null,
    valueId: inputValueId,
    purpose: "actorTask",
  });
  const insertTurn = value.database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', 'run', 2,
      ?7, ?7, NULL, NULL)
  `);
  let insertAttempt: ReturnType<Database["query"]> | null = null;
  if (includeAttempts) {
    value.database.query(`
      INSERT INTO harness_actor_operations (
        operation_id, actor_id, turn_id, kind, request_digest, effect_key,
        state, provider_identity_json, created_at, updated_at, settled_at
      ) VALUES (
        'hoperation_prefix_root_start', ?1, NULL, 'actorStart', ?2, ?2,
        'succeeded', '{}', ?3, ?3, ?3
      )
    `).run(rootActorId, "1".repeat(64), at);
    value.database.query(`
      INSERT INTO harness_actor_incarnations (
        incarnation_id, actor_id, ordinal, account_profile_id,
        process_generation, start_operation_id, client_request_id,
        thread_source, provider_thread_id, toolset_digest, state,
        created_at, updated_at, closed_at,
        token_usage_latest_position,
        token_usage_cumulative_input_tokens,
        token_usage_cumulative_output_tokens,
        token_usage_observation_generation
      ) VALUES (
        'hincarnation_prefix_root', ?1, 1, ?2, 1,
        'hoperation_prefix_root_start', 'client_prefix_root_start',
        'thread-source-prefix-root', 'provider-thread-prefix-root', ?3,
        'running', ?4, ?4, NULL, NULL, 0, 0, 1
      )
    `).run(
      rootActorId,
      value.accounts[0]!.accountProfileId,
      toolsetDigest,
      at,
    );
    insertAttempt = value.database.query(`
      INSERT INTO harness_actor_turn_attempts (
        attempt_id, turn_id, incarnation_id, ordinal, account_profile_id,
        process_generation, client_user_message_id, provider_turn_id,
        state, quota_proof_digest, input_tokens, output_tokens,
        created_at, started_at, settled_at
      ) VALUES (
        ?1, ?2, 'hincarnation_prefix_root', 1, ?3, 1, ?4, NULL,
        'starting', NULL, NULL, NULL, ?5, NULL, NULL
      )
    `);
  }
  value.database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(8, "0");
      const turnId = `hturn_----------------${suffix}`;
      insertTurn.run(
        turnId,
        epochId,
        rootActorId,
        index + 1,
        `prefix-turn-idempotency-${suffix}`,
        inputValueId,
        at,
      );
      insertAttempt?.run(
        `hattempt_----------------${suffix}`,
        turnId,
        value.accounts[0]!.accountProfileId,
        `client-prefix-turn-${suffix}`,
        at,
      );
    }
  })();
}

function seedActorResultHistory(
  value: Fixture,
  actor: Actor,
  count: number,
): void {
  const inputValueId = "ctxval_result_history_input";
  insertContextValue(value.database, {
    actorId: actor.id,
    turnId: null,
    valueId: inputValueId,
    purpose: "actorTask",
  });
  const insertTurn = value.database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'cancelled', 'stop', 3,
      ?7, ?7, ?7, 'cancelled_before_effect')
  `);
  const insertResult = value.database.query(`
    INSERT INTO harness_actor_results (
      result_id, epoch_id, actor_id, turn_id, terminal_attempt_id,
      outcome, value_id, actor_result_ordinal, root_completion_sequence,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, NULL, 'cancelled', NULL, ?5, ?5, ?6)
  `);
  value.database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const ordinal = index + 1;
      const suffix = String(ordinal).padStart(8, "0");
      const turnId = `hturn_history_${suffix}`;
      insertTurn.run(
        turnId,
        epochId,
        actor.id,
        ordinal,
        `history-turn-idempotency-${suffix}`,
        inputValueId,
        at,
      );
      insertResult.run(
        `hresult_history_${suffix}`,
        epochId,
        actor.id,
        turnId,
        ordinal,
        at,
      );
    }
  })();
}

async function expectPersistentActorError(
  operation: Promise<unknown>,
  code: PersistentActorError["code"],
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PersistentActorError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected persistent actor error: ${code}`);
}

async function expectRejectedMessage(
  operation: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected rejected error");
    expect(error.message).toContain(expectedMessage);
    return;
  }
  throw new Error(`expected rejection containing: ${expectedMessage}`);
}

describe("PersistentActorCoordinator", () => {
  test("quota failover requires definitive terminal observation proof", () => {
    const event = {
      accountProfileId: "acct_terminal_proof",
      processGeneration: 1,
      providerThreadId: "provider-thread-terminal-proof",
      providerTurnId: "provider-turn-terminal-proof",
      terminal: "failed",
      resultValueId: null,
      outcomeCode: "usage_limit_exceeded",
      quotaProof: "provider_usage_limit_exceeded",
      inputTokens: 13,
      outputTokens: 8,
      proof: proof("d", { phase: "observation" }),
    } as const;

    expect(persistentActorTerminalObservationSchema.safeParse(event).success)
      .toBeTrue();
    expect(persistentActorTerminalObservationSchema.safeParse({
      ...event,
      proof: { ...event.proof, definitive: false },
    }).success).toBeFalse();
    for (const phase of ["preEffect", "postDispatch"] as const) {
      expect(persistentActorTerminalObservationSchema.safeParse({
        ...event,
        proof: { ...event.proof, phase },
      }).success).toBeFalse();
    }
  });

  test("fences a prepared predecessor actor start before any provider mutation", async () => {
    const value = fixture(1);
    try {
      const seeded = seedLegacyActorStart(
        value,
        "prepared-actor-start",
        "prepared",
      );
      seedLegacyTurn(value, seeded.actor, "prepared-actor-start");

      await expectPersistentActorError(
        value.coordinator.reconcile(),
        "ambiguous_effect",
      );

      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.threadReconciliations).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);
      expect(value.authority.readActorOperation(seeded.operationId)).toMatchObject({
        state: "recoveryRequired",
      });
      expect(value.authority.readActorIncarnation(seeded.incarnationId)).toMatchObject({
        state: "quarantined",
      });
      expect(value.authority.readActor(seeded.actor.id)).toMatchObject({
        state: "quarantined",
      });
    } finally {
      value.database.close();
    }
  });

  test("reconciles an already-started predecessor actor effect without restarting it", async () => {
    const value = fixture(1);
    try {
      const seeded = await materializeLegacyIncarnation(
        value,
        "started-actor-effect",
      );

      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.threadReconciliations).toEqual([seeded.request]);
      expect(value.authority.readActorOperation(seeded.operationId)).toMatchObject({
        state: "succeeded",
      });
      expect(value.authority.readActorIncarnation(seeded.incarnationId)).toMatchObject({
        state: "idle",
        toolsetDigest: HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
      });
    } finally {
      value.database.close();
    }
  });

  test("boots a recovered predecessor actor through session admission then catalog custody", async () => {
    const value = fixture(1);
    try {
      const seeded = await materializeLegacyIncarnation(
        value,
        "legacy-boot-catalog",
      );
      const admitted = value.authority.readActorSessionBinding(
        seeded.incarnationId,
      );
      if (admitted === null) throw new Error("legacy boot session was not bound");
      expect(admitted).toMatchObject({
        state: "bound",
        admissionGeneration: seeded.request.processGeneration,
        liveGeneration: seeded.request.processGeneration,
        capabilityEvidenceDigest: null,
        supportsFast: null,
        liveCapabilityEvidenceDigest: null,
        liveSupportsFast: null,
      });
      const nextProof = sessionRecoveryProof({
        generation: admitted.liveGeneration,
        identity: "legacy-boot-catalog",
        priorRecoveryProofDigest:
          admitted.recoveryProof.recoveryProofDigest,
      });
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({
            generation: admitted.liveGeneration,
          }),
        },
        authority: value.authority,
        sessions: {
          readHarnessModelCatalog: (_accountProfileId, generation) =>
            Promise.resolve({
              evidenceDigest: "c".repeat(64),
              generation,
              models: [{
                modelId: seeded.request.modelId,
                reasoningEfforts: [seeded.request.reasoningEffort],
                serviceTiers: ["standard", "fast"],
              }],
            }),
          resumeHarnessActorThread: () => Promise.resolve({
            admissionGeneration: admitted.admissionGeneration,
            generation: admitted.liveGeneration,
            observedProfile: {
              modelId: admitted.modelId,
              reasoningEffort: admitted.reasoningEffort,
            },
            providerThreadId: admitted.providerThreadId,
            threadId: "thread_owned_legacy_boot_catalog",
            projectId,
            streamPosition: 100,
            workspaceLaneId: admitted.workspaceLaneId,
            recoveryProof: nextProof,
          }),
        },
        now: () => new Date(at),
      });

      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [seeded.incarnationId],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [],
      });
      expect(value.authority.readActorSessionBinding(seeded.incarnationId))
        .toMatchObject({
          state: "bound",
          admissionGeneration: admitted.admissionGeneration,
          liveGeneration: admitted.liveGeneration,
          capabilityEvidenceDigest: null,
          supportsFast: null,
          liveCapabilityEvidenceDigest: "c".repeat(64),
          liveSupportsFast: true,
          revision: admitted.revision + 1,
        });
      expect(value.authority.readActorIncarnation(seeded.incarnationId))
        .toMatchObject({ state: "idle" });
      await recovery.close();
    } finally {
      value.database.close();
    }
  });

  test("rejects a new predecessor send before allocating value, turn, workspace, or attempt", async () => {
    const value = fixture(1);
    try {
      const seeded = await materializeLegacyIncarnation(
        value,
        "fresh-send-rejected",
      );
      const count = (table: string): number => {
        const row = value.database.query<{ count: number }, [string]>(`
          SELECT COUNT(*) AS count FROM ${table} WHERE actor_id = ?1
        `).get(seeded.actor.id);
        return row?.count ?? 0;
      };
      const contextCount = () => value.database.query<
        { count: number },
        [string]
      >(`
        SELECT COUNT(*) AS count FROM harness_context_values
        WHERE owner_actor_id = ?1
      `).get(seeded.actor.id)?.count ?? 0;
      const before = {
        turns: count("harness_actor_turns"),
        workspaces: count("harness_actor_workspace_bindings"),
        contexts: contextCount(),
        acquisitions: value.controls.workspaceAcquisitions.length,
      };

      await expectPersistentActorError(value.coordinator.send({
        callerActorId: rootActorId,
        actorId: seeded.actor.id,
        idempotencyKey: "legacy-fresh-send-rejected",
        inputValueId: "ctxval_legacy_fresh_send_rejected",
      }), "invalid_state");

      expect({
        turns: count("harness_actor_turns"),
        workspaces: count("harness_actor_workspace_bindings"),
        contexts: contextCount(),
        acquisitions: value.controls.workspaceAcquisitions.length,
      }).toEqual(before);
      expect(value.authority.listActorAttempts({
        turnId: deriveTestOpaqueId("hturn", "turn", [
          seeded.actor.epochId,
          seeded.actor.id,
          "legacy-fresh-send-rejected",
        ]),
        limit: 16,
      })).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("rejects bounded-leaf delegation before allocating any child effect", async () => {
    const value = fixture([{
      accountProfileId: "acct_bounded_leaf_0001",
      processGeneration: 1,
      modelId: "gpt-5.6-luna",
      reasoningEffort: "max",
      selectedProfile: "lunaMax",
    }]);
    try {
      const boundedLeaf = await value.coordinator.spawn({
        ...spawnInput("boundedleafparent01"),
        workClass: "boundedLeaf",
      });
      const tableCount = (table: string): number =>
        value.database.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM ${table}
        `).get()?.count ?? 0;
      const providerCounts = () => ({
        continuationCaptures: value.provider.continuationCaptures.length,
        threadStarts: value.provider.threadStarts.length,
        threadReconciliations: value.provider.threadReconciliations.length,
        turnStarts: value.provider.turnStarts.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        fastCapacityReconciliations:
          value.provider.fastCapacityReconciliations.length,
        observations: value.provider.observations.length,
        interrupts: value.provider.interrupts.length,
        interruptReconciliations:
          value.provider.interruptReconciliations.length,
      });
      const snapshot = () => ({
        actors: tableCount("harness_actors"),
        values: tableCount("harness_context_values"),
        turns: tableCount("harness_actor_turns"),
        workspaces: tableCount("harness_actor_workspace_bindings"),
        operations: tableCount("harness_actor_operations"),
        incarnations: tableCount("harness_actor_incarnations"),
        attempts: tableCount("harness_actor_turn_attempts"),
        accountLeases: tableCount("harness_actor_account_leases"),
        fastReservations: tableCount("harness_actor_fast_reservations"),
        directChildren: value.authority.listActorChildren({
          parentActorId: boundedLeaf.actor.id,
          limit: 16,
        }).length,
        workspaceAcquisitions: value.controls.workspaceAcquisitions.length,
        accountEligibilityCalls: value.controls.accountEligibilityCalls,
        provider: providerCounts(),
      });
      const before = snapshot();

      await expectPersistentActorError(value.coordinator.spawn({
        callerActorId: boundedLeaf.actor.id,
        idempotencyKey: "bounded-leaf-recursive-spawn-01", // gitleaks:allow - deterministic test vector
        title: "Forbidden recursive child",
        budget: {
          ...boundedLeaf.actor.budget,
          maxActiveDescendants: 1,
          maxDurableDescendants: 1,
          tokenBudget: 1_000,
          byteBudget: MIB,
        },
        inputValueId: "ctxval_bounded_leaf_recursive_01",
        policyVersion: 1,
        workClass: "standard",
        acceleration: { mode: "standard" },
      }), "unauthorized");

      expect(snapshot()).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  test("allows exact durable predecessor replay but fences its prepared turn effect", async () => {
    const value = fixture(1);
    try {
      const seeded = await materializeLegacyIncarnation(
        value,
        "durable-turn-replay",
      );
      const durable = seedLegacyTurn(
        value,
        seeded.actor,
        "durable-turn-replay",
      );

      const replay = await value.coordinator.send({
        callerActorId: rootActorId,
        actorId: seeded.actor.id,
        idempotencyKey: durable.idempotencyKey,
        inputValueId: durable.inputValueId,
      });

      expect(replay.turn).toMatchObject({
        id: durable.turn.id,
        state: "ambiguous",
      });
      expect(value.provider.turnStarts).toEqual([]);
      expect(value.provider.turnReconciliations).toEqual([]);
      const operation = value.authority.listRecoverableActorOperations({
        limit: 16,
      }).find(({ kind }) => kind === "turnStart");
      expect(operation).toMatchObject({ state: "recoveryRequired" });
      expect(value.authority.listActorAttempts({
        turnId: durable.turn.id,
        limit: 16,
      })).toMatchObject([{ state: "ambiguous" }]);
      expect(value.authority.readActor(seeded.actor.id)).toMatchObject({
        state: "quarantined",
      });
    } finally {
      value.database.close();
    }
  });

  test("reconciles started predecessor turns and fences prepared interrupts", async () => {
    const value = fixture(1);
    try {
      const seeded = await materializeLegacyIncarnation(
        value,
        "prepared-interrupt",
      );
      const started = seedLegacyEffectStartedTurn(
        value,
        seeded.actor,
        seeded.incarnationId,
        "prepared-interrupt",
      );
      value.provider.reconcileTurnOutcomes.set(
        started.request.accountProfileId,
        {
          kind: "applied",
          providerTurnId: "provider-turn-legacy-prepared-interrupt",
          proof: proof("7", { phase: "observation" }),
        },
      );

      await value.coordinator.reconcile();

      expect(value.provider.turnStarts).toEqual([]);
      expect(value.provider.turnReconciliations).toEqual([started.request]);
      const attempt = value.authority.readActorAttempt(started.attemptId);
      expect(attempt).toMatchObject({
        state: "running",
        providerTurnId: "provider-turn-legacy-prepared-interrupt",
      });
      const preparedInterrupt = seedLegacyInterrupt(
        value,
        started.turn.id,
        started.attemptId,
        "prepared",
      );

      await value.coordinator.cancel({
        callerActorId: rootActorId,
        turnId: started.turn.id,
      });

      expect(value.provider.interrupts).toEqual([]);
      expect(value.provider.interruptReconciliations).toEqual([]);
      expect(value.authority.readActorOperation(preparedInterrupt.operationId))
        .toMatchObject({ state: "recoveryRequired" });
      expect(value.authority.readActorAttempt(started.attemptId)).toMatchObject({
        state: "ambiguous",
      });
    } finally {
      value.database.close();
    }
  });

  test("reconciles an already-started predecessor interrupt without repeating it", async () => {
    const value = fixture(1);
    try {
      const seeded = await materializeLegacyIncarnation(
        value,
        "started-interrupt",
      );
      const started = seedLegacyEffectStartedTurn(
        value,
        seeded.actor,
        seeded.incarnationId,
        "started-interrupt",
      );
      value.provider.reconcileTurnOutcomes.set(
        started.request.accountProfileId,
        {
          kind: "applied",
          providerTurnId: "provider-turn-legacy-started-interrupt",
          proof: proof("7", { phase: "observation" }),
        },
      );
      await value.coordinator.reconcile();
      const interrupt = seedLegacyInterrupt(
        value,
        started.turn.id,
        started.attemptId,
        "effectStarted",
      );

      await value.coordinator.cancel({
        callerActorId: rootActorId,
        turnId: started.turn.id,
      });

      expect(value.provider.interrupts).toEqual([]);
      expect(value.provider.interruptReconciliations).toEqual([
        interrupt.request,
      ]);
      expect(value.authority.readActorOperation(interrupt.operationId)).toMatchObject({
        state: "succeeded",
      });
    } finally {
      value.database.close();
    }
  });

  test("persists deadline stop intent before any provider effect and releases a pristine spawn", async () => {
    const value = fixture();
    try {
      const input = spawnInput("deadline000000001");
      input.budget.deadline = "2029-12-31T23:59:59.999Z";
      await expectPersistentActorError(value.coordinator.spawn(input), "timeout");
      expect(value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      })).toEqual([]);
      expect(value.authority.readActor(rootActorId)).toMatchObject({
        state: "active",
        tokenReserved: 0,
        byteReserved: 0,
      });
      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("deadline sweep persists intent without duplicating the liveness-owned reconciliation pass", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("deadlinesweeponce01"),
      );
      value.controls.now = deadline;

      expect(await value.coordinator.sweepDeadlines()).toEqual({ expired: 1 });
      expect(value.authority.readActor(spawned.actor.id)).toMatchObject({
        state: "stopRequested",
      });
      expect(value.authority.readActorTurn(spawned.turn.turn.id)).toMatchObject({
        state: "running",
        desiredState: "stop",
      });
      expect(value.provider.interrupts).toHaveLength(0);

      await value.coordinator.reconcile();
      expect(value.provider.interrupts).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("deadline sweep rotates beyond 4,096 live turns without skipping the expired suffix", async () => {
    const value = fixture();
    try {
      seedRootLiveTurnPrefix(value, 4_096);
      const root = value.authority.readActor(rootActorId);
      if (root === null) throw new Error("fixture root actor is missing");
      const suffixActor = createDirectDescendant(
        value,
        root,
        9_998,
        "active",
        at,
      );
      insertContextValue(value.database, {
        actorId: suffixActor.id,
        turnId: null,
        valueId: "ctxval_deadline_suffix_input",
        purpose: "actorTask",
      });
      const suffixTurn = value.authority.createActorTurn({
        turnId: "hturn_zzzz_deadline_suffix",
        epochId,
        actorId: suffixActor.id,
        idempotencyKey: "deadline-suffix-idempotency",
        inputValueId: "ctxval_deadline_suffix_input",
        createdAt: at,
      });

      expect(await value.coordinator.sweepDeadlines({ limit: 4_096 }))
        .toEqual({ expired: 0 });
      expect(value.authority.readActorTurn(suffixTurn.id)?.desiredState)
        .toBe("run");
      expect(await value.coordinator.sweepDeadlines({ limit: 4_096 }))
        .toEqual({ expired: 1 });
      expect(value.authority.readActor(suffixActor.id)?.state)
        .toBe("stopRequested");
      expect(value.authority.readActorTurn(suffixTurn.id)?.desiredState)
        .toBe("stop");
    } finally {
      value.database.close();
    }
  }, 20_000);

  test("global reconciliation rotates past a 4,096-turn prefix and advances its healthy suffix", async () => {
    const value = fixture();
    try {
      seedRootLiveTurnPrefix(value, 4_096);
      const root = value.authority.readActor(rootActorId);
      if (root === null) throw new Error("fixture root actor is missing");
      const suffixActor = createDirectDescendant(value, root, 9_997, "active");
      insertContextValue(value.database, {
        actorId: suffixActor.id,
        turnId: null,
        valueId: "ctxval_reconcile_suffix_input",
        purpose: "actorTask",
      });
      const suffixTurn = value.authority.createActorTurn({
        turnId: "hturn_zzzz_reconcile_suffix",
        epochId,
        actorId: suffixActor.id,
        idempotencyKey: "reconcile-suffix-idempotency",
        inputValueId: "ctxval_reconcile_suffix_input",
        createdAt: at,
      });

      expect(await value.coordinator.reconcile({ limit: 4_096 }))
        .toMatchObject({ inspectedTurns: 4_096 });
      expect(value.provider.threadStarts).toHaveLength(0);
      expect(value.authority.readActorTurn(suffixTurn.id)?.state)
        .toBe("prepared");

      expect(await value.coordinator.reconcile({ limit: 4_096 }))
        .toMatchObject({ inspectedTurns: 4_096 });
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.readActorTurn(suffixTurn.id)?.state)
        .toBe("running");
    } finally {
      value.database.close();
    }
  }, 20_000);

  test("exact actor safety reads ignore 4,096 unrelated live turns and attempts", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("exact-suffix-safety"),
      );
      seedRootLiveTurnPrefix(value, 4_096, true);

      const status = await value.coordinator.status({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
      });
      expect(status.liveTurns.map(({ id }) => id))
        .toEqual([spawned.turn.turn.id]);

      const observationsBefore = value.provider.observations.length;
      await value.coordinator.reconcile({
        limit: 8,
        turnIds: [spawned.turn.turn.id],
      });
      expect(value.provider.observations.slice(observationsBefore))
        .toMatchObject([{ turnId: spawned.turn.turn.id }]);

      await expectPersistentActorError(value.coordinator.send({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
        idempotencyKey: "exact-suffix-new-turn",
        inputValueId: "ctxval_exact_suffix_new_input",
      }), "actor_busy");
      await expectPersistentActorError(value.coordinator.quiesceActorForStop({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
      }), "provider_pending");
      expect(value.authority.readActor(spawned.actor.id)?.state)
        .toBe("stopRequested");
      const retainedTurn = value.authority.readActorTurn(spawned.turn.turn.id);
      if (retainedTurn === null) throw new Error("suffix turn was lost");
      expect(["running", "reconciling"]).toContain(retainedTurn.state);
    } finally {
      value.database.close();
    }
  }, 20_000);

  test("actor-start fencing finds an exact suffix turn beyond the global prefix", async () => {
    const value = fixture();
    try {
      seedRootLiveTurnPrefix(value, 4_096);
      const root = value.authority.readActor(rootActorId);
      if (root === null) throw new Error("fixture root actor is missing");
      const suffixActor = createDirectDescendant(value, root, 9_996, "active");
      insertContextValue(value.database, {
        actorId: suffixActor.id,
        turnId: null,
        valueId: "ctxval_fence_suffix_input",
        purpose: "actorTask",
      });
      const suffixTurn = value.authority.createActorTurn({
        turnId: "hturn_zzzz_fence_suffix",
        epochId,
        actorId: suffixActor.id,
        idempotencyKey: "fence-suffix-idempotency",
        inputValueId: "ctxval_fence_suffix_input",
        createdAt: at,
      });
      const operation = value.authority.prepareActorOperation({
        operationId: "hoperation_zzzz_fence_suffix",
        actorId: suffixActor.id,
        turnId: null,
        kind: "actorStart",
        requestDigest: "2".repeat(64),
        effectKey: "3".repeat(64),
        providerIdentityJson: "{}",
        createdAt: at,
      });
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: at,
      });
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "ambiguous",
        now: at,
      });

      await value.coordinator.reconcile({
        limit: 8,
        actorIds: [suffixActor.id],
      });
      expect(value.authority.readActor(suffixActor.id)?.state)
        .toBe("quarantined");
      expect(value.authority.readActorTurn(suffixTurn.id)?.state)
        .toBe("cancelled");
    } finally {
      value.database.close();
    }
  }, 20_000);

  test("boot admission recovery fails closed rather than hiding an overflowing suffix", async () => {
    const value = fixture();
    try {
      const insert = value.database.query(`
        INSERT INTO harness_actor_operations (
          operation_id, actor_id, turn_id, kind, request_digest, effect_key,
          state, provider_identity_json, created_at, updated_at, settled_at
        ) VALUES (?1, ?2, NULL, 'actorStart', ?3, ?3,
          'prepared', '{}', ?4, ?4, NULL)
      `);
      value.database.transaction(() => {
        for (let index = 0; index < 4_097; index += 1) {
          insert.run(
            `hoperation_boot_prefix_${String(index).padStart(8, "0")}`,
            rootActorId,
            "4".repeat(64),
            at,
          );
        }
      })();

      await expectPersistentActorError(
        value.coordinator.reconcileSessionAdmissions({ limit: 4_096 }),
        "conflict",
      );
      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.threadReconciliations).toEqual([]);
    } finally {
      value.database.close();
    }
  }, 20_000);

  test("status reads the latest result beyond 4,096 completed turns", async () => {
    const value = fixture();
    try {
      const root = value.authority.readActor(rootActorId);
      if (root === null) throw new Error("fixture root actor is missing");
      const actor = createDirectDescendant(value, root, 9_995, "active");
      seedActorResultHistory(value, actor, 4_097);

      const status = await value.coordinator.status({
        callerActorId: rootActorId,
        actorId: actor.id,
      });
      expect(status.latestResult).toMatchObject({
        id: "hresult_history_00004097",
        actorResultOrdinal: 4_097,
        rootCompletionSequence: 4_097,
      });
    } finally {
      value.database.close();
    }
  }, 20_000);

  test("releases a pristine child when input preparation fails before workspace acquisition", async () => {
    const value = fixture();
    try {
      const failure = new Error("input unavailable");
      value.controls.prepareInputFailure = failure;

      let observed: unknown = null;
      try {
        await value.coordinator.spawn(spawnInput("inputfailure0001"));
      } catch (error: unknown) {
        observed = error;
      }

      expect(observed).toBe(failure);
      expect(value.controls.workspaceAcquisitions).toEqual([]);
      expect(value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      })).toEqual([]);
      expect(value.authority.readActor(rootActorId)).toMatchObject({
        tokenReserved: 0,
        byteReserved: 0,
      });
      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("persists an exact prepared turn before a recoverable workspace failure", async () => {
    const value = fixture();
    try {
      const input = spawnInput("workspacefailure1");
      const failure = new Error("workspace unavailable");
      value.controls.workspaceFailure = failure;

      let observed: unknown = null;
      try {
        await value.coordinator.spawn(input);
      } catch (error: unknown) {
        observed = error;
      }

      expect(observed).toBe(failure);
      const [child] = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      });
      if (child === undefined) throw new Error("prepared child was not retained");
      const [turn] = value.authority.listLiveActorTurns({ limit: 16 });
      expect(turn).toMatchObject({ actorId: child.id, state: "prepared" });
      expect(turn?.inputValueId).toStartWith("ctxval_");
      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);

      value.controls.workspaceFailure = null;
      const recovered = await value.coordinator.spawn(input);

      expect(recovered.actor.id).toBe(child.id);
      expect(recovered.turn.turn.state).toBe("running");
      expect(value.controls.workspaceAcquisitions).toEqual([child.id, child.id]);
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("rebinds a prepared start atomically when live account rank changes after a crash", async () => {
    const value = fixture([
      {
        accountProfileId: "acct_route_a",
        processGeneration: 1,
        routingPriority: {
          remainingHeadroomRank: 0,
          rendezvousScore: "f".repeat(64),
        },
      },
      {
        accountProfileId: "acct_route_b",
        processGeneration: 1,
        routingPriority: {
          remainingHeadroomRank: 1,
          rendezvousScore: "e".repeat(64),
        },
      },
    ]);
    try {
      const input = spawnInput("atomicroutecrash1");
      value.controls.crashBeforeAccountLease = true;
      const failure = await value.coordinator.spawn(input).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "injected crash before atomic account lease",
      );
      expect(value.authority.readActiveIncarnationForActor(
        value.authority.listActorChildren({
          parentActorId: rootActorId,
          limit: 2,
        })[0]!.id,
      )).toBeNull();

      value.controls.accountCandidates.reverse();
      const recovered = await value.coordinator.spawn(input);

      expect(recovered.turn.turn.state).toBe("running");
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.threadStarts[0]?.accountProfileId)
        .toBe("acct_route_a");
      expect(value.authority.readActiveIncarnationForActor(recovered.actor.id))
        .toMatchObject({ accountProfileId: "acct_route_a", state: "running" });
    } finally {
      value.database.close();
    }
  });

  test("never drives a root chat turn through the nested actor provider", async () => {
    const value = fixture();
    try {
      const valueId = "ctxval_root_chat_input";
      insertContextValue(value.database, {
        actorId: rootActorId,
        turnId: null,
        valueId,
        purpose: "actorTask",
      });
      const rootTurn = value.authority.createActorTurn({
        turnId: "hturn_root_chat_owned",
        epochId,
        actorId: rootActorId,
        idempotencyKey: "root-chat-owned-01",
        inputValueId: valueId,
        createdAt: at,
      });

      const recovery = await value.coordinator.reconcile();

      expect(recovery).toMatchObject({
        inspectedOperations: 0,
        inspectedAttempts: 0,
        inspectedTurns: 1,
        pending: 0,
        fenced: 0,
      });
      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);
      expect(value.authority.readActorTurn(rootTurn.id)).toEqual(rootTurn);
    } finally {
      value.database.close();
    }
  });

  test("session-admission recovery leaves a prepared actor start effect-free", async () => {
    const value = fixture();
    try {
      const root = value.authority.readActor(rootActorId);
      if (root === null) throw new Error("fixture root actor is missing");
      const child = createDirectDescendant(value, root, 99, "active");
      value.authority.prepareActorOperation({
        operationId: "hoperation_prepared_session_admission",
        actorId: child.id,
        turnId: null,
        kind: "actorStart",
        requestDigest: digestFixture(child.id, "prepared-request"),
        effectKey: digestFixture(child.id, "prepared-effect"),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
        createdAt: at,
      });

      const recovered = await value.coordinator.reconcileSessionAdmissions();

      expect(recovered).toEqual({
        inspectedOperations: 1,
        pending: 1,
        fenced: 0,
      });
      expect(value.provider.threadStarts).toEqual([]);
      expect(value.provider.threadReconciliations).toEqual([]);
      expect(value.provider.turnStarts).toEqual([]);
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);
      expect(value.authority.readActiveIncarnationForActor(child.id)).toBeNull();
    } finally {
      value.database.close();
    }
  });

  test("session-admission recovery reconciles an effect-started thread and binds it without starting a turn", async () => {
    const value = fixture();
    try {
      value.provider.throwNextThreadStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("sessionadmission01")),
        "provider_pending",
      );
      const request = value.provider.threadStarts[0];
      if (request === undefined) throw new Error("thread start request is missing");
      const outcome = appliedThreadOutcome(
        request,
        "provider-thread-session-admission-recovered",
      );
      value.provider.threadOutcomes.set(request.accountProfileId, outcome);

      const recovered = await value.coordinator.reconcileSessionAdmissions();

      expect(recovered).toEqual({
        inspectedOperations: 1,
        pending: 0,
        fenced: 0,
      });
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.threadReconciliations).toHaveLength(1);
      expect(value.provider.turnStarts).toEqual([]);
      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      })[0];
      if (child === undefined) throw new Error("recovered child actor is missing");
      const incarnation = value.authority.readActiveIncarnationForActor(child.id);
      expect(incarnation).toMatchObject({
        accountProfileId: request.accountProfileId,
        observedModel: request.modelId,
        observedProfileState: "exact",
        observedReasoningEffort: request.reasoningEffort,
        processGeneration: request.processGeneration,
        providerThreadId: outcome.providerThreadId,
        state: "idle",
      });
      expect(value.authority.readActorSessionBinding(incarnation!.id)).toMatchObject({
        admissionGeneration: request.processGeneration,
        liveGeneration: request.processGeneration,
        providerThreadId: outcome.providerThreadId,
        recoveryProof: outcome.sessionRecoveryProof,
        state: "bound",
      });
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toMatchObject([{
        actorId: child.id,
        state: "prepared",
      }]);
    } finally {
      value.database.close();
    }
  });

  test("materializes a lost actor start at N plus 1 without rewriting admission capabilities", async () => {
    const value = fixture();
    try {
      value.provider.throwNextThreadStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("sessionadmissionn1")),
        "provider_pending",
      );
      const request = value.provider.threadStarts[0];
      if (request === undefined) throw new Error("thread start request is missing");
      const successorGeneration = request.processGeneration + 1;
      const successorDigest = digestFixture(
        [request.accountProfileId, successorGeneration],
        "successor-capability",
      );
      value.database.query(`
        UPDATE account_profiles SET process_generation = ?2, updated_at = ?3
        WHERE profile_id = ?1
      `).run(
        request.accountProfileId,
        successorGeneration,
        "2030-01-01T00:00:03.000Z",
      );
      const outcome = appliedThreadOutcome(
        request,
        "provider-thread-session-admission-successor",
        {
          observationGeneration: successorGeneration,
          evidenceDigest: successorDigest,
          supportsFast: false,
        },
      );
      value.provider.threadOutcomes.set(request.accountProfileId, outcome);

      expect(await value.coordinator.reconcileSessionAdmissions()).toEqual({
        inspectedOperations: 1,
        pending: 0,
        fenced: 0,
      });
      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      })[0];
      if (child === undefined) throw new Error("recovered child actor is missing");
      const incarnation = value.authority.readActiveIncarnationForActor(child.id);
      expect(incarnation).toMatchObject({
        processGeneration: request.processGeneration,
        capabilityEvidenceDigest: request.capabilityEvidenceDigest,
        supportsFast: request.supportsFast,
        providerThreadId: outcome.providerThreadId,
        state: "idle",
      });
      const firstBinding = value.authority.readActorSessionBinding(incarnation!.id);
      expect(firstBinding).toMatchObject({
        admissionGeneration: request.processGeneration,
        liveGeneration: successorGeneration,
        capabilityEvidenceDigest: request.capabilityEvidenceDigest,
        supportsFast: request.supportsFast,
        liveCapabilityEvidenceDigest: successorDigest,
        liveSupportsFast: false,
        recoveryProof: outcome.sessionRecoveryProof,
        state: "bound",
      });

      expect(await value.coordinator.reconcileSessionAdmissions()).toEqual({
        inspectedOperations: 0,
        pending: 0,
        fenced: 0,
      });
      expect(value.authority.readActorSessionBinding(incarnation!.id))
        .toEqual(firstBinding);
      expect(value.provider.turnStarts).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("session-admission recovery re-observes a succeeded receipt before binding its live generation", async () => {
    const value = fixture();
    try {
      value.provider.throwNextThreadStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("sessionadmission02")),
        "provider_pending",
      );
      const request = value.provider.threadStarts[0];
      if (request === undefined) throw new Error("thread start request is missing");
      const operation = value.authority.listRecoverableActorOperations({
        limit: 16,
      }).find(({ kind }) => kind === "actorStart");
      if (operation?.providerIdentityJson === null || operation === undefined) {
        throw new Error("effect-started actor operation is missing");
      }
      const outcome = appliedThreadOutcome(
        request,
        "provider-thread-session-admission-receipt",
      );
      const envelope = JSON.parse(operation.providerIdentityJson) as Record<
        string,
        unknown
      >;
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: JSON.stringify({ ...envelope, outcome }),
        now: at,
      });
      value.provider.threadOutcomes.set(request.accountProfileId, outcome);

      const recovered = await value.coordinator.reconcileSessionAdmissions();

      expect(recovered).toEqual({
        inspectedOperations: 1,
        pending: 0,
        fenced: 0,
      });
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.threadReconciliations).toEqual([request]);
      expect(value.provider.turnStarts).toEqual([]);
      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      })[0];
      if (child === undefined) throw new Error("recovered child actor is missing");
      const incarnation = value.authority.readActiveIncarnationForActor(child.id);
      expect(incarnation).toMatchObject({
        processGeneration: request.processGeneration,
        providerThreadId: outcome.providerThreadId,
        state: "idle",
      });
      expect(value.authority.readActorSessionBinding(incarnation!.id)).toMatchObject({
        admissionGeneration: request.processGeneration,
        liveGeneration: request.processGeneration,
        recoveryProof: outcome.sessionRecoveryProof,
        state: "bound",
      });
    } finally {
      value.database.close();
    }
  });

  test("spawns one durable actor and replays without repeating provider effects", async () => {
    const value = fixture();
    try {
      const first = await value.coordinator.spawn(spawnInput());
      const replay = await value.coordinator.spawn(spawnInput());
      expect(replay.actor.id).toBe(first.actor.id);
      expect(replay.turn.turn.id).toBe(first.turn.turn.id);
      expect(first.turn.turn.state).toBe("running");
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.provider.threadReconciliations).toHaveLength(0);
      expect(value.provider.turnReconciliations).toHaveLength(0);
      expect(value.authority.readActor(first.actor.id)?.state).toBe("active");
      expect(value.provider.threadStarts[0]?.continuation).toBeNull();
      expect(value.provider.turnStarts[0]?.continuation).toBeNull();
      expect(value.authority.listActorAttempts({
        turnId: first.turn.turn.id,
        limit: 128,
      })).toMatchObject([{
        accountProfileId: value.accounts[0]!.accountProfileId,
        ordinal: 1,
        state: "running",
      }]);
    } finally {
      value.database.close();
    }
  });

  test("records exact positioned token usage through the fact-router consumer", async () => {
    const value = fixture();
    try {
      for (const account of value.accounts) {
        Object.assign(account, {
          modelId: "gpt-5.6-sol",
          reasoningEffort: "max",
          selectedProfile: "solMax",
        });
      }
      const spawned = await value.coordinator.spawn({
        ...spawnInput("tokenusage000001"),
        policyVersion: 1,
        workClass: "standard",
        acceleration: { mode: "standard" },
      });
      const [attempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (attempt?.providerTurnId === null || attempt?.providerTurnId === undefined) {
        throw new Error("spawned attempt lacks its provider turn identity");
      }
      const incarnation = value.authority.readActorIncarnation(attempt.incarnationId);
      if (incarnation?.providerThreadId === null ||
        incarnation?.providerThreadId === undefined) {
        throw new Error("spawned incarnation lacks its provider thread identity");
      }
      const consumer = new PersistentActorTokenUsageFactConsumer(
        value.authority,
        value.coordinator,
      );
      const exact = tokenUsageFact({
        accountProfileId: attempt.accountProfileId,
        generation: attempt.processGeneration,
        providerThreadId: incarnation.providerThreadId,
        providerTurnId: attempt.providerTurnId,
        cumulativeInputTokens: 144,
        cumulativeOutputTokens: 55,
        inputTokens: 21,
        outputTokens: 8,
      });

      await consumer.consumeCodexFacts([
        Object.freeze({
          ...exact,
          generation: exact.generation + 1,
          streamPosition: 2,
        }),
        exact,
        exact,
      ]);

      expect(value.authority.readActorTurnUsage({
        accountProfileId: attempt.accountProfileId,
        processGeneration: attempt.processGeneration,
        providerTurnId: attempt.providerTurnId,
      })).toEqual({
        inputTokens: 144,
        outputTokens: 55,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
      await consumer.consumeCodexFacts([Object.freeze({
        ...exact,
        inputTokens: 0,
        outputTokens: 0,
        streamPosition: 2,
      })]);
      expect(value.authority.readActorTurnUsage({
        accountProfileId: attempt.accountProfileId,
        processGeneration: attempt.processGeneration,
        providerTurnId: attempt.providerTurnId,
      })).toEqual({
        inputTokens: 144,
        outputTokens: 55,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
      await consumer.consumeCodexFacts([Object.freeze({
        ...exact,
        cumulativeOutputTokens: 56,
        outputTokens: 1,
        streamPosition: 3,
      })]);
      expect(value.authority.readActorTurnUsage({
        accountProfileId: attempt.accountProfileId,
        processGeneration: attempt.processGeneration,
        providerTurnId: attempt.providerTurnId,
      })).toEqual({
        inputTokens: 144,
        outputTokens: 56,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
      await consumer.consumeCodexFacts([Object.freeze({
        ...exact,
        streamPosition: 2,
      })]);
      expect(value.authority.readActorTurnUsage({
        accountProfileId: attempt.accountProfileId,
        processGeneration: attempt.processGeneration,
        providerTurnId: attempt.providerTurnId,
      })).toEqual({
        inputTokens: 144,
        outputTokens: 56,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
      await expectRejectedMessage(consumer.consumeCodexFacts([Object.freeze({
        ...exact,
        cumulativeOutputTokens: 57,
        streamPosition: 3,
      })]), "actor token evidence contradicted its verified session successor");
      await consumer.consumeCodexFacts([Object.freeze({
        ...exact,
        cumulativeInputTokens: 143,
        cumulativeOutputTokens: 56,
        streamPosition: 4,
      })]);
      expect(value.authority.readActorSessionBinding(incarnation.id)).toMatchObject({
        state: "quarantined",
        quarantineReason: "token_evidence_regression",
      });
      expect(value.authority.readActorTurnUsage({
        accountProfileId: attempt.accountProfileId,
        processGeneration: attempt.processGeneration,
        providerTurnId: attempt.providerTurnId,
      })).toEqual({
        inputTokens: 144,
        outputTokens: 56,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      });
    } finally {
      value.database.close();
    }
  });

  test("quarantines an actor when Codex reports a turn model reroute", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("modelreroute0001"));
      const [attempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (attempt?.providerTurnId === null || attempt?.providerTurnId === undefined) {
        throw new Error("spawned attempt lacks its provider turn identity");
      }
      const incarnation = value.authority.readActorIncarnation(attempt.incarnationId);
      if (incarnation?.providerThreadId === null ||
        incarnation?.providerThreadId === undefined) {
        throw new Error("spawned incarnation lacks its provider thread identity");
      }
      const consumer = new PersistentActorTokenUsageFactConsumer(
        value.authority,
        value.coordinator,
      );
      await consumer.consumeCodexFacts([{
        type: "turn.model_rerouted",
        accountProfileId: attempt.accountProfileId,
        encodedBytes: 256,
        factIndex: 0,
        generation: attempt.processGeneration,
        origin: "live",
        streamPosition: 33,
        threadId: incarnation.providerThreadId,
        turnId: attempt.providerTurnId,
        fromModel: incarnation.requestedModel,
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity",
      }]);
      expect(value.authority.readActorIncarnation(incarnation.id)).toMatchObject({
        observedModel: null,
        observedProfileState: "rerouted",
        state: "quarantined",
      });
      expect(value.authority.readActorAttempt(attempt.id)).toMatchObject({
        state: "ambiguous",
      });
      expect(value.authority.readActor(spawned.actor.id)).toMatchObject({
        state: "quarantined",
      });
    } finally {
      value.database.close();
    }
  });

  test("settles a late reroute from pre-contained lineage without provider replay or profile rewrite", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("rerouteprecontained1"),
      );
      const [attempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (attempt?.providerTurnId === null ||
        attempt?.providerTurnId === undefined) {
        throw new Error("pre-contained reroute attempt lacks provider identity");
      }
      const incarnation = value.authority.readActorIncarnation(
        attempt.incarnationId,
      );
      if (incarnation?.providerThreadId === null ||
        incarnation?.providerThreadId === undefined) {
        throw new Error("pre-contained reroute incarnation is missing");
      }
      const profileBefore = {
        observedModel: incarnation.observedModel,
        observedReasoningEffort: incarnation.observedReasoningEffort,
        observedProfileState: incarnation.observedProfileState,
        observedProfileAt: incarnation.observedProfileAt,
      };
      value.authority.containAmbiguousActorTurn({
        attemptId: attempt.id,
        evidenceDigest: "d".repeat(64),
        now: at,
      });
      const fact = modelRerouteFact({
        accountProfileId: attempt.accountProfileId,
        generation: attempt.processGeneration,
        providerThreadId: incarnation.providerThreadId,
        providerTurnId: attempt.providerTurnId,
        streamPosition: 35,
      });
      const [unsettled] = await value.authority.recordActorModelReroute({
        accountProfileId: fact.accountProfileId,
        observationGeneration: fact.generation,
        providerThreadId: fact.threadId,
        providerTurnId: fact.turnId,
        streamPosition: fact.streamPosition,
        fromModel: fact.fromModel,
        toModel: fact.toModel,
        reason: fact.reason,
        now: at,
      });
      expect(unsettled).toMatchObject({
        attemptId: attempt.id,
        state: "bound",
      });
      expect(value.authority.readActorIncarnation(incarnation.id))
        .toMatchObject({ ...profileBefore, state: "quarantined" });
      const providerCounts = {
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      };

      await value.restart().reconcile({ limit: 1 });

      expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
        .toMatchObject({ state: "settled", factDigest: unsettled?.factDigest });
      expect(value.authority.readActorIncarnation(incarnation.id))
        .toMatchObject({ ...profileBefore, state: "quarantined" });
      expect(value.authority.readActorAttempt(attempt.id))
        .toMatchObject({ state: "ambiguous", providerTurnId: fact.turnId });
      expect(value.authority.readActor(spawned.actor.id))
        .toMatchObject({ state: "quarantined" });
      expect(await value.restart().containActorModelReroute(fact)).toBe(true);
      expect({
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      }).toEqual(providerCounts);
    } finally {
      value.database.close();
    }
  });

  test("settles a delayed retired-session reroute after a clean stop without provider replay", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("reroutestoppedclean1"),
      );
      const [attempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (attempt?.providerTurnId === null ||
        attempt?.providerTurnId === undefined) {
        throw new Error("stopped reroute attempt lacks provider identity");
      }
      const liveIncarnation = value.authority.readActorIncarnation(
        attempt.incarnationId,
      );
      if (liveIncarnation?.providerThreadId === null ||
        liveIncarnation?.providerThreadId === undefined) {
        throw new Error("stopped reroute incarnation lacks provider identity");
      }
      const terminalAttempt = value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: attempt.state,
        nextState: "interrupted",
        now: at,
      });
      value.authority.settleActorResult({
        resultId: deriveTestOpaqueId("hresult", "result", [
          spawned.turn.turn.id,
        ]),
        turnId: spawned.turn.turn.id,
        terminalAttemptId: terminalAttempt.id,
        outcome: "cancelled",
        valueId: null,
        expectedTurnRevision: spawned.turn.turn.revision,
        outcomeCode: "clean_stop_before_delayed_reroute",
        createdAt: at,
      });
      value.authority.transitionActorIncarnation({
        incarnationId: liveIncarnation.id,
        expectedState: liveIncarnation.state,
        nextState: "closed",
        providerThreadId: liveIncarnation.providerThreadId,
        now: at,
      });
      let actor = value.authority.readActor(spawned.actor.id);
      if (actor === null) throw new Error("stopped reroute actor is missing");
      actor = value.authority.requestActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        now: at,
      });
      const stopped = value.authority.settleActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        nextState: "stopped",
        now: at,
      });
      const fact = modelRerouteFact({
        accountProfileId: terminalAttempt.accountProfileId,
        generation: terminalAttempt.processGeneration,
        providerThreadId: liveIncarnation.providerThreadId,
        providerTurnId: attempt.providerTurnId,
        streamPosition: 36,
      });
      const [record] = await value.authority.recordActorModelReroute({
        accountProfileId: fact.accountProfileId,
        observationGeneration: fact.generation,
        providerThreadId: fact.threadId,
        providerTurnId: fact.turnId,
        streamPosition: fact.streamPosition,
        fromModel: fact.fromModel,
        toModel: fact.toModel,
        reason: fact.reason,
        now: at,
      });
      if (record === undefined) throw new Error("stopped reroute was dropped");
      expect(record).toMatchObject({
        attemptId: terminalAttempt.id,
        state: "bound",
      });
      const turnBefore = value.authority.readActorTurn(spawned.turn.turn.id);
      const attemptBefore = value.authority.readActorAttempt(
        terminalAttempt.id,
      );
      const incarnationBefore = value.authority.readActorIncarnation(
        liveIncarnation.id,
      );
      const startOperationBefore = value.authority.readActorOperation(
        liveIncarnation.startOperationId,
      );
      const turnOperationId = deriveTestOpaqueId(
        "hoperation",
        "turn-start",
        [spawned.turn.turn.id, liveIncarnation.id],
      );
      const turnOperationBefore = value.authority.readActorOperation(
        turnOperationId,
      );
      const providerCounts = {
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        threadReconciliations: value.provider.threadReconciliations.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      };

      const restarted = value.restart();
      await restarted.reconcile({ limit: 1 });

      const settled = value.authority.readActorModelRerouteForAttempt(
        terminalAttempt.id,
      );
      expect(settled).toMatchObject({
        attemptId: terminalAttempt.id,
        factDigest: record.factDigest,
        state: "settled",
      });
      expect(value.authority.readActor(spawned.actor.id)).toEqual(stopped);
      expect(value.authority.readActorTurn(spawned.turn.turn.id))
        .toEqual(turnBefore);
      expect(value.authority.readActorAttempt(terminalAttempt.id))
        .toEqual(attemptBefore);
      expect(value.authority.readActorIncarnation(liveIncarnation.id))
        .toEqual(incarnationBefore);
      expect(value.authority.readActorOperation(liveIncarnation.startOperationId))
        .toEqual(startOperationBefore);
      expect(value.authority.readActorOperation(turnOperationId))
        .toEqual(turnOperationBefore);
      expect({
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        threadReconciliations: value.provider.threadReconciliations.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      }).toEqual(providerCounts);

      expect(await restarted.containActorModelReroute(fact)).toBe(true);
      await restarted.reconcile({ limit: 1 });
      expect(value.authority.readActorModelRerouteForAttempt(
        terminalAttempt.id,
      )).toEqual(settled);
      expect(value.authority.readActor(spawned.actor.id)).toEqual(stopped);
      expect(value.authority.readActorIncarnation(liveIncarnation.id))
        .toEqual(incarnationBefore);
      expect({
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        threadReconciliations: value.provider.threadReconciliations.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      }).toEqual(providerCounts);
    } finally {
      value.database.close();
    }
  });

  test("binds an early model reroute before running and contains exact duplicates once", async () => {
    const value = fixture();
    try {
      const consumer = new PersistentActorTokenUsageFactConsumer(
        value.authority,
        value.coordinator,
      );
      let earlyFact: Extract<CodexFact, { type: "turn.model_rerouted" }> | null =
        null;
      let earlyAttemptId: string | null = null;
      value.provider.beforeTurnStartResponse = async (request, outcome) => {
        if (outcome.kind !== "applied") {
          throw new Error("early reroute fixture requires an applied turn");
        }
        earlyFact = modelRerouteFact({
          accountProfileId: request.accountProfileId,
          generation: request.observationGeneration,
          providerThreadId: request.providerThreadId,
          providerTurnId: outcome.providerTurnId,
        });
        await consumer.consumeCodexFacts([earlyFact]);
        const [attempt] = value.authority.listUnsettledActorAttempts({
          limit: 16,
        });
        if (attempt === undefined) throw new Error("early attempt is missing");
        earlyAttemptId = attempt.id;
        expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
          .toMatchObject({ state: "pending", boundAt: null });
      };

      const spawned = await value.coordinator.spawn(
        spawnInput("earlyreroute000001"),
      );
      if (earlyFact === null || earlyAttemptId === null) {
        throw new Error("early reroute hook did not run");
      }
      const attempt = value.authority.readActorAttempt(earlyAttemptId);
      if (attempt === null) throw new Error("early attempt disappeared");
      const incarnation = value.authority.readActorIncarnation(
        attempt.incarnationId,
      );
      if (incarnation === null) throw new Error("early incarnation disappeared");
      expect(spawned.turn.turn.state).toBe("ambiguous");
      expect(attempt.state).toBe("ambiguous");
      expect(incarnation).toMatchObject({
        observedProfileState: "rerouted",
        state: "quarantined",
      });
      expect(value.authority.readActorSessionBinding(incarnation.id))
        .toMatchObject({ state: "quarantined" });
      expect(value.database.query(`
        SELECT state FROM harness_actor_account_leases
        WHERE incarnation_id = ?1
      `).get(incarnation.id)).toEqual({ state: "quarantined" });
      const settled = value.authority.readActorModelRerouteForAttempt(
        attempt.id,
      );
      expect(settled).toMatchObject({
        state: "settled",
        quarantineReason: null,
      });
      const actorBeforeDuplicate = value.authority.readActor(spawned.actor.id);
      const attemptBeforeDuplicate = value.authority.readActorAttempt(attempt.id);
      const incarnationBeforeDuplicate = value.authority.readActorIncarnation(
        incarnation.id,
      );
      await consumer.consumeCodexFacts([earlyFact]);
      expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
        .toEqual(settled);
      expect(value.authority.readActor(spawned.actor.id))
        .toEqual(actorBeforeDuplicate);
      expect(value.authority.readActorAttempt(attempt.id))
        .toEqual(attemptBeforeDuplicate);
      expect(value.authority.readActorIncarnation(incarnation.id))
        .toEqual(incarnationBeforeDuplicate);
      expect(await value.coordinator.containActorModelReroute(
        modelRerouteFact({
          accountProfileId: value.accounts[0]!.accountProfileId,
          generation: 1,
          providerThreadId: "ordinary-non-actor-thread",
          providerTurnId: "ordinary-non-actor-turn",
        }),
      )).toBe(false);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_model_reroute_inbox
      `).get()).toEqual({ count: 1 });
    } finally {
      value.database.close();
    }
  });

  test("recovers an early reroute crash before provider-turn bind without a fresh start", async () => {
    const value = fixture();
    try {
      const consumer = new PersistentActorTokenUsageFactConsumer(
        value.authority,
        value.coordinator,
      );
      let providerTurnId: string | null = null;
      value.provider.beforeTurnStartResponse = async (request, outcome) => {
        if (outcome.kind !== "applied") {
          throw new Error("early crash fixture requires an applied turn");
        }
        providerTurnId = outcome.providerTurnId;
        await consumer.consumeCodexFacts([modelRerouteFact({
          accountProfileId: request.accountProfileId,
          generation: request.observationGeneration,
          providerThreadId: request.providerThreadId,
          providerTurnId: outcome.providerTurnId,
          streamPosition: 41,
        })]);
      };
      value.provider.throwNextTurnStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("reroutecrashprebind")),
        "provider_pending",
      );
      const [attempt] = value.authority.listUnsettledActorAttempts({ limit: 16 });
      if (attempt === undefined || providerTurnId === null) {
        throw new Error("pre-bind crash lost its reroute fixture");
      }
      expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
        .toMatchObject({ state: "pending", boundAt: null });
      value.provider.beforeTurnStartResponse = null;
      value.provider.reconcileTurnOutcomes.set(attempt.accountProfileId, {
        kind: "applied",
        providerTurnId,
        proof: proof("e", { phase: "observation" }),
      });
      await value.restart().reconcile();
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.provider.turnReconciliations).toHaveLength(1);
      expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
        .toMatchObject({ state: "settled" });
      expect(value.authority.readActorAttempt(attempt.id))
        .toMatchObject({ state: "ambiguous", providerTurnId });
      expect(value.authority.readActor(
        value.authority.readActorTurn(attempt.turnId)!.actorId,
      )).toMatchObject({ state: "quarantined" });
    } finally {
      value.database.close();
    }
  });

  test("reconcile sweeps a crash after reroute bind before any provider replay", async () => {
    const value = fixture();
    try {
      const consumer = new PersistentActorTokenUsageFactConsumer(
        value.authority,
        value.coordinator,
      );
      value.provider.beforeTurnStartResponse = async (request, outcome) => {
        if (outcome.kind !== "applied") {
          throw new Error("bound crash fixture requires an applied turn");
        }
        await consumer.consumeCodexFacts([modelRerouteFact({
          accountProfileId: request.accountProfileId,
          generation: request.observationGeneration,
          providerThreadId: request.providerThreadId,
          providerTurnId: outcome.providerTurnId,
          streamPosition: 52,
        })]);
      };
      value.controls.crashAfterAuthorityStep = "rerouteBound";
      await expectRejectedMessage(
        value.coordinator.spawn(spawnInput("reroutecrashbound01")),
        "injected crash after rerouteBound",
      );
      const [attempt] = value.authority.listUnsettledActorAttempts({ limit: 16 });
      if (attempt === undefined) throw new Error("bound crash attempt is missing");
      expect(attempt).toMatchObject({
        state: "starting",
      });
      expect(attempt.providerTurnId).not.toBeNull();
      expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
        .toMatchObject({ state: "bound" });
      value.provider.beforeTurnStartResponse = null;
      await value.restart().reconcile({ limit: 1 });
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.provider.turnReconciliations).toHaveLength(0);
      expect(value.provider.observations).toHaveLength(0);
      expect(value.authority.readActorModelRerouteForAttempt(attempt.id))
        .toMatchObject({ state: "settled" });
      expect(value.authority.readActorAttempt(attempt.id))
        .toMatchObject({ state: "ambiguous" });
    } finally {
      value.database.close();
    }
  });

  test("fails over only after definitive pre-effect quota proof", async () => {
    const value = fixture();
    try {
      const firstAccount = value.accounts[0]!.accountProfileId;
      value.provider.turnOutcomes.set(firstAccount, {
        kind: "notApplied",
        reason: "quota",
        proof: proof("6", { phase: "preEffect" }),
      });
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000002"));
      expect(spawned.turn.turn.state).toBe("running");
      expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual(value.accounts.map(({ accountProfileId }) => accountProfileId));
      expect(value.provider.turnStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual(value.accounts.map(({ accountProfileId }) => accountProfileId));
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id))
        .toMatchObject({ accountProfileId: value.accounts[1]!.accountProfileId });
    } finally {
      value.database.close();
    }
  });

  test("recovers a crash after pre-effect quota settlement without repeating a provider effect", async () => {
    const value = fixture(2);
    try {
      const [sourceAccount, targetAccount] = value.accounts;
      value.provider.turnOutcomes.set(sourceAccount!.accountProfileId, {
        kind: "notApplied",
        reason: "quota",
        proof: proof("6", { phase: "preEffect" }),
      });
      value.controls.crashAfterAuthorityStep = "preEffectQuotaAttempt";

      await expectRejectedMessage(
        value.coordinator.spawn(spawnInput("preeffectquotacrash")),
        "injected crash after preEffectQuotaAttempt",
      );

      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 16,
      })[0];
      if (child === undefined) throw new Error("quota crash lost its durable child");
      const turn = value.authority.listLiveActorTurns({ limit: 16 })
        .find(({ actorId }) => actorId === child.id);
      if (turn === undefined) throw new Error("quota crash lost its durable turn");
      const sourceAttempt = value.authority.listActorAttempts({
        turnId: turn.id,
        limit: 16,
      })[0];
      expect(sourceAttempt).toMatchObject({
        accountProfileId: sourceAccount!.accountProfileId,
        state: "quotaRejected",
        providerTurnId: null,
      });
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);

      const restarted = value.restart();
      await restarted.reconcile();

      expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual([
          sourceAccount!.accountProfileId,
          targetAccount!.accountProfileId,
        ]);
      expect(value.provider.turnStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual([
          sourceAccount!.accountProfileId,
          targetAccount!.accountProfileId,
        ]);
      expect(value.provider.turnStarts[1]?.continuation).toBeNull();
      expect(value.authority.readActorTurn(turn.id)).toMatchObject({
        state: "running",
      });

      await restarted.reconcile();
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(2);
    } finally {
      value.database.close();
    }
  });

  test("waits for an unvisited subscription whose exact-generation capability is still converging", async () => {
    const value = fixture();
    try {
      const first = value.accounts[0]!;
      const second = value.accounts[1]!;
      value.controls.accountCandidates.splice(0, Infinity, first);
      value.controls.temporarilyUnavailableAccountProfileIds.push(
        second.accountProfileId,
      );
      value.provider.turnOutcomes.set(first.accountProfileId, {
        kind: "notApplied",
        reason: "quota",
        proof: proof("6", { phase: "preEffect" }),
      });

      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("temporaryaccount01")),
        "provider_pending",
      );
      expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual([first.accountProfileId]);
      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 51,
      })[0]!;
      const turn = value.authority.listLiveActorTurns({ limit: 16 })
        .find(({ actorId }) => actorId === child.id);
      expect(turn).toMatchObject({ state: "reconciling" });
      expect(value.authority.readActorResultForTurn(turn!.id)).toBeNull();

      value.controls.temporarilyUnavailableAccountProfileIds.length = 0;
      value.controls.accountCandidates.push(second);
      await value.coordinator.reconcile();
      expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual([first.accountProfileId, second.accountProfileId]);
      expect(value.authority.readActiveIncarnationForActor(child.id))
        .toMatchObject({ accountProfileId: second.accountProfileId });
    } finally {
      value.database.close();
    }
  });

  test("does not turn temporary capability absence into account exhaustion", async () => {
    const value = fixture(1);
    try {
      const [account] = value.accounts;
      value.controls.accountCandidates.length = 0;
      value.controls.temporarilyUnavailableAccountProfileIds.push(
        account!.accountProfileId,
      );

      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("temporaryaccount02")),
        "provider_pending",
      );
      expect(value.provider.threadStarts).toHaveLength(0);

      value.controls.temporarilyUnavailableAccountProfileIds.length = 0;
      value.controls.accountCandidates.push(account!);
      await value.coordinator.reconcile();
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("deferred account eligibility rechecks cancellation and deadline before actor start", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      const value = fixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      let spawning: Promise<unknown> | null = null;
      try {
        value.controls.accountEligibilityBarrier = async (call) => {
          if (call !== 1) return;
          entered.resolve();
          await release.promise;
        };
        spawning = value.coordinator.spawn(
          spawnInput(`eligibility${mode}01`),
        );
        await entered.promise;
        const child = value.authority.listActorChildren({
          parentActorId: rootActorId,
          limit: 16,
        })[0];
        const turn = value.authority.listLiveActorTurns({ limit: 16 })[0];
        if (child === undefined || turn === undefined) {
          throw new Error("deferred eligibility fixture is not durable");
        }
        if (mode === "cancel") {
          await value.coordinator.cancel({
            callerActorId: rootActorId,
            turnId: turn.id,
          });
        } else {
          value.controls.now = deadline;
        }
        release.resolve();
        await Promise.allSettled([spawning]);

        expect(value.provider.threadStarts).toEqual([]);
        expect(value.provider.turnStarts).toEqual([]);
        expect(value.authority.readActorResultForTurn(turn.id)).toMatchObject({
          outcome: "cancelled",
        });
        expect(value.authority.readActorTurn(turn.id)).toMatchObject({
          outcomeCode: mode === "cancel"
            ? "cancelled_before_effect"
            : "deadline_before_effect",
        });
        expect(value.authority.readActor(child.id)).toMatchObject({
          state: mode === "cancel" ? "active" : "stopRequested",
        });
      } finally {
        release.resolve();
        if (spawning !== null) await Promise.allSettled([spawning]);
        value.database.close();
      }
    }
  });

  test("stop and deadline between quota candidates never start candidate two", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      const value = fixture(2);
      const entered = deferred<void>();
      const release = deferred<void>();
      let spawning: Promise<unknown> | null = null;
      try {
        const first = value.accounts[0]!;
        value.provider.turnOutcomes.set(first.accountProfileId, {
          kind: "notApplied",
          reason: "quota",
          proof: proof("6", { phase: "preEffect" }),
        });
        value.controls.accountEligibilityBarrier = async (call) => {
          if (call !== 2) return;
          entered.resolve();
          await release.promise;
        };
        spawning = value.coordinator.spawn(
          spawnInput(`candidate${mode}02`),
        );
        await entered.promise;
        const turn = value.authority.listLiveActorTurns({ limit: 16 })[0];
        if (turn === undefined) throw new Error("quota candidate turn is missing");
        if (mode === "cancel") {
          await value.coordinator.cancel({
            callerActorId: rootActorId,
            turnId: turn.id,
          });
        } else {
          value.controls.now = deadline;
        }
        release.resolve();
        await Promise.allSettled([spawning]);

        expect(value.provider.threadStarts.map(({ accountProfileId }) =>
          accountProfileId)).toEqual([first.accountProfileId]);
        expect(value.provider.turnStarts.map(({ accountProfileId }) =>
          accountProfileId)).toEqual([first.accountProfileId]);
        expect(value.authority.readActorResultForTurn(turn.id)).toMatchObject({
          outcome: "quotaRejected",
        });
        expect(value.authority.readActorTurn(turn.id)).toMatchObject({
          outcomeCode: mode === "cancel"
            ? "actor_start_stopped_before_effect"
            : "deadline_before_actor_start",
        });
      } finally {
        release.resolve();
        if (spawning !== null) await Promise.allSettled([spawning]);
        value.database.close();
      }
    }
  });

  test("post-admission quota starts one fresh thread on the first unvisited subscription", async () => {
    const rankedAccounts = [
      { accountProfileId: "acct_quota_source", processGeneration: 7 },
      { accountProfileId: "acct_quota_target", processGeneration: 11 },
      { accountProfileId: "acct_quota_later", processGeneration: 13 },
    ] as const;
    const value = fixture(rankedAccounts);
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("postadmission0001"),
      );
      const [sourceAttempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (sourceAttempt?.providerTurnId === null ||
        sourceAttempt?.providerTurnId === undefined) {
        throw new Error("source attempt lacks its provider turn identity");
      }
      const sourceIncarnation = value.authority.readActorIncarnation(
        sourceAttempt.incarnationId,
      );
      if (sourceIncarnation?.providerThreadId === null ||
        sourceIncarnation?.providerThreadId === undefined) {
        throw new Error("source attempt lacks its provider thread identity");
      }
      const event: PersistentActorTerminalObservation = {
        accountProfileId: sourceAttempt.accountProfileId,
        processGeneration: sourceAttempt.processGeneration,
        providerThreadId: sourceIncarnation.providerThreadId,
        providerTurnId: sourceAttempt.providerTurnId,
        terminal: "failed",
        resultValueId: null,
        outcomeCode: "usage_limit_exceeded",
        quotaProof: "provider_usage_limit_exceeded",
        inputTokens: 144,
        outputTokens: 55,
        proof: proof("8", { phase: "observation" }),
      };
      await recordExactTerminalUsage(value, event);

      // A process restart may advance a configured subscription's generation.
      // Visitation is subscription-scoped, so the source account must remain
      // excluded even when the live account candidate now has a new generation.
      expect(Reflect.set(
        rankedAccounts[0],
        "processGeneration",
        rankedAccounts[0].processGeneration + 1,
      )).toBe(true);

      const continued = await value.coordinator.observeTerminal(event);

      expect(continued).toMatchObject({
        turn: { id: spawned.turn.turn.id, state: "running" },
        result: null,
      });
      const attempts = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        id: sourceAttempt.id,
        accountProfileId: rankedAccounts[0].accountProfileId,
        processGeneration: event.processGeneration,
        providerTurnId: event.providerTurnId,
        state: "quotaRejected",
        quotaProofDigest: event.proof.digest,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
      expect(attempts[1]).toMatchObject({
        accountProfileId: rankedAccounts[1].accountProfileId,
        processGeneration: rankedAccounts[1].processGeneration,
        state: "running",
      });
      expect(value.provider.threadStarts.map((request) => ({
        accountProfileId: request.accountProfileId,
        processGeneration: request.processGeneration,
      }))).toEqual([
        {
          accountProfileId: rankedAccounts[0].accountProfileId,
          processGeneration: event.processGeneration,
        },
        {
          accountProfileId: rankedAccounts[1].accountProfileId,
          processGeneration: rankedAccounts[1].processGeneration,
        },
      ]);
      expect(value.provider.turnStarts).toHaveLength(2);
      const continuationRequest = value.provider.turnStarts[1]!;
      expect(continuationRequest.continuation?.historyValueId)
        .toMatch(/^ctxval_[A-Za-z0-9_-]+$/u);
      expect(continuationRequest.continuation).toMatchObject({
        sourceAttemptId: sourceAttempt.id,
        sourceAccountProfileId: event.accountProfileId,
        sourceProcessGeneration: event.processGeneration,
        sourceProviderThreadId: sourceIncarnation.providerThreadId,
        sourceProviderTurnId: event.providerTurnId,
      });
      // The coordinator transfers only opaque value identity plus exact lineage.
      // The provider continuation branch injects verified history and owns the
      // literal `continue`; no original prompt text crosses this boundary again.
      expect("prompt" in continuationRequest).toBe(false);
      expect("message" in continuationRequest).toBe(false);
      expect("text" in continuationRequest).toBe(false);
      expect(value.authority.readActor(spawned.actor.id)).toMatchObject({
        state: "active",
      });
      expect(value.authority.remainingActorTokens(spawned.actor.id)).toBe(9_801);
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id))
        .toMatchObject({
          accountProfileId: rankedAccounts[1].accountProfileId,
          processGeneration: rankedAccounts[1].processGeneration,
          state: "running",
        });
    } finally {
      value.database.close();
    }
  });

  test("contains the current replacement for a retired quota-source reroute", async () => {
    const rankedAccounts = [
      { accountProfileId: "acct_reroute_quota_source", processGeneration: 7 },
      { accountProfileId: "acct_reroute_quota_target", processGeneration: 11 },
    ] as const;
    const value = fixture(rankedAccounts);
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("reroutequotasource1"),
      );
      const [initialSource] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (initialSource?.providerTurnId === null ||
        initialSource?.providerTurnId === undefined) {
        throw new Error("reroute quota source lacks provider turn identity");
      }
      const initialSourceIncarnation = value.authority.readActorIncarnation(
        initialSource.incarnationId,
      );
      if (initialSourceIncarnation?.providerThreadId === null ||
        initialSourceIncarnation?.providerThreadId === undefined) {
        throw new Error("reroute quota source lacks provider thread identity");
      }
      const event: PersistentActorTerminalObservation = {
        accountProfileId: initialSource.accountProfileId,
        processGeneration: initialSource.processGeneration,
        providerThreadId: initialSourceIncarnation.providerThreadId,
        providerTurnId: initialSource.providerTurnId,
        terminal: "failed",
        resultValueId: null,
        outcomeCode: "usage_limit_exceeded",
        quotaProof: "provider_usage_limit_exceeded",
        inputTokens: 233,
        outputTokens: 89,
        proof: proof("9", { phase: "observation" }),
      };
      await recordExactTerminalUsage(value, event);
      await value.coordinator.observeTerminal(event);
      const [sourceAttempt, replacementAttempt] =
        value.authority.listActorAttempts({
          turnId: spawned.turn.turn.id,
          limit: 16,
        });
      if (sourceAttempt === undefined || replacementAttempt === undefined) {
        throw new Error("reroute quota continuation is incomplete");
      }
      const sourceIncarnation = value.authority.readActorIncarnation(
        sourceAttempt.incarnationId,
      );
      const replacementIncarnation = value.authority.readActorIncarnation(
        replacementAttempt.incarnationId,
      );
      if (
        sourceIncarnation === null || replacementIncarnation === null ||
        sourceIncarnation.providerThreadId === null ||
        sourceAttempt.providerTurnId === null
      ) {
        throw new Error("reroute quota lineage is incomplete");
      }
      expect(sourceAttempt).toMatchObject({
        state: "quotaRejected",
        quotaProofDigest: event.proof.digest,
        providerTurnId: event.providerTurnId,
      });
      expect(sourceIncarnation.state).toBe("closed");
      expect(value.authority.readActorSessionBinding(sourceIncarnation.id))
        .toMatchObject({ state: "retired" });
      expect(replacementAttempt).toMatchObject({ state: "running" });
      expect(replacementIncarnation).toMatchObject({ state: "running" });
      const sourceProfileBefore = {
        observedModel: sourceIncarnation.observedModel,
        observedReasoningEffort: sourceIncarnation.observedReasoningEffort,
        observedProfileState: sourceIncarnation.observedProfileState,
        observedProfileAt: sourceIncarnation.observedProfileAt,
      };
      const replacementProfileBefore = {
        observedModel: replacementIncarnation.observedModel,
        observedReasoningEffort: replacementIncarnation.observedReasoningEffort,
        observedProfileState: replacementIncarnation.observedProfileState,
        observedProfileAt: replacementIncarnation.observedProfileAt,
      };
      const replacementRequest = value.provider.turnStarts.at(-1);
      if (replacementRequest === undefined) {
        throw new Error("reroute quota replacement request is missing");
      }
      const replacementOperationId = value.database.query<
        { operation_id: string },
        [string]
      >(`
        SELECT operation_id FROM harness_actor_operations
        WHERE effect_key = ?1
      `).get(replacementRequest.effectKey)?.operation_id;
      if (replacementOperationId === undefined) {
        throw new Error("reroute quota replacement operation is missing");
      }
      const replacementOperationBefore = value.authority.readActorOperation(
        replacementOperationId,
      );
      const providerCounts = {
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      };
      const fact = modelRerouteFact({
        accountProfileId: sourceAttempt.accountProfileId,
        generation: sourceAttempt.processGeneration,
        providerThreadId: sourceIncarnation.providerThreadId,
        providerTurnId: sourceAttempt.providerTurnId,
        streamPosition: 93,
      });

      expect(await value.coordinator.containActorModelReroute(fact)).toBe(true);

      expect(value.authority.readActorModelRerouteForAttempt(sourceAttempt.id))
        .toMatchObject({ state: "settled", attemptId: sourceAttempt.id });
      expect(value.authority.readActorAttempt(sourceAttempt.id))
        .toEqual(sourceAttempt);
      expect(value.authority.readActorIncarnation(sourceIncarnation.id))
        .toEqual(sourceIncarnation);
      expect(value.authority.readActorAttempt(replacementAttempt.id))
        .toMatchObject({
          state: "ambiguous",
          providerTurnId: replacementAttempt.providerTurnId,
        });
      expect(value.authority.readActorIncarnation(replacementIncarnation.id))
        .toMatchObject({
          ...replacementProfileBefore,
          state: "quarantined",
        });
      expect(value.authority.readActorSessionBinding(replacementIncarnation.id))
        .toMatchObject({ state: "quarantined" });
      expect(value.authority.readActorIncarnation(sourceIncarnation.id))
        .toMatchObject(sourceProfileBefore);
      expect(value.authority.readActorOperation(replacementOperationId))
        .toEqual(replacementOperationBefore);
      expect(value.authority.readActorTurn(spawned.turn.turn.id))
        .toMatchObject({ state: "ambiguous" });
      expect(value.authority.readActor(spawned.actor.id))
        .toMatchObject({ state: "quarantined" });

      expect(await value.restart().containActorModelReroute(fact)).toBe(true);
      await value.restart().reconcile();
      expect(value.authority.readActorAttempt(sourceAttempt.id))
        .toEqual(sourceAttempt);
      expect(value.authority.readActorIncarnation(sourceIncarnation.id))
        .toEqual(sourceIncarnation);
      expect(value.authority.readActorOperation(replacementOperationId))
        .toEqual(replacementOperationBefore);
      expect({
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
        turnReconciliations: value.provider.turnReconciliations.length,
        observations: value.provider.observations.length,
      }).toEqual(providerCounts);
    } finally {
      value.database.close();
    }
  });

  test("reconcile resumes post-admission quota failover after the source settlement", async () => {
    const value = fixture(2);
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("postadmission0002"),
      );
      const [sourceAttempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (sourceAttempt?.providerTurnId === null ||
        sourceAttempt?.providerTurnId === undefined) {
        throw new Error("source attempt lacks its provider turn identity");
      }
      const sourceIncarnation = value.authority.readActorIncarnation(
        sourceAttempt.incarnationId,
      );
      if (sourceIncarnation?.providerThreadId === null ||
        sourceIncarnation?.providerThreadId === undefined) {
        throw new Error("source attempt lacks its provider thread identity");
      }
      const event: PersistentActorTerminalObservation = {
        accountProfileId: sourceAttempt.accountProfileId,
        processGeneration: sourceAttempt.processGeneration,
        providerThreadId: sourceIncarnation.providerThreadId,
        providerTurnId: sourceAttempt.providerTurnId,
        terminal: "failed",
        resultValueId: null,
        outcomeCode: "usage_limit_exceeded",
        quotaProof: "provider_usage_limit_exceeded",
        inputTokens: 21,
        outputTokens: 8,
        proof: proof("8", { phase: "observation" }),
      };
      await recordExactTerminalUsage(value, event);
      const workspaceFailure = new Error("replacement workspace unavailable");
      value.controls.workspaceFailure = workspaceFailure;

      let observed: unknown = null;
      try {
        await value.coordinator.observeTerminal(event);
      } catch (error: unknown) {
        observed = error;
      }

      expect(observed).toBe(workspaceFailure);
      expect(value.authority.readActorAttempt(sourceAttempt.id)).toMatchObject({
        state: "quotaRejected",
        providerTurnId: event.providerTurnId,
        quotaProofDigest: event.proof.digest,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
      expect(value.authority.readActorTurn(spawned.turn.turn.id)).toMatchObject({
        state: "reconciling",
      });
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)).toBeNull();
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);

      value.controls.workspaceFailure = null;
      const recovery = await value.coordinator.reconcile();

      expect(recovery.inspectedTurns).toBe(1);
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(2);
      expect(value.provider.threadStarts[1]).toMatchObject({
        accountProfileId: value.accounts[1]!.accountProfileId,
      });
      expect(value.provider.turnStarts[1]?.continuation?.historyValueId)
        .toMatch(/^ctxval_[A-Za-z0-9_-]+$/u);
      expect(value.provider.turnStarts[1]?.continuation).toMatchObject({
        sourceAttemptId: sourceAttempt.id,
        sourceAccountProfileId: event.accountProfileId,
        sourceProcessGeneration: event.processGeneration,
        sourceProviderThreadId: sourceIncarnation.providerThreadId,
        sourceProviderTurnId: event.providerTurnId,
      });
      expect(value.authority.readActorTurn(spawned.turn.turn.id)).toMatchObject({
        state: "running",
      });

      await value.coordinator.reconcile();
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(2);
    } finally {
      value.database.close();
    }
  });

  test("every post-admission quota crash cut resumes one continuation without duplicate effects", async () => {
    const cuts = [
      "quotaSettlement",
      "turnReconciling",
      "sourceClosed",
      "beforeFailover",
    ] as const;
    for (const [index, cut] of cuts.entries()) {
      const value = fixture(2);
      try {
        const quota = await preparePostAdmissionQuota(
          value,
          `quotacrashcut${String(index).padStart(2, "0")}`,
        );
        const injected = new Error(`injected crash at ${cut}`);
        if (cut === "beforeFailover") {
          value.controls.workspaceFailure = injected;
        } else {
          value.controls.crashAfterAuthorityStep = cut;
        }

        let observed: unknown = null;
        try {
          await value.coordinator.observeTerminal(quota.event);
        } catch (error: unknown) {
          observed = error;
        }
        expect(observed).toBeInstanceOf(Error);
        expect(value.provider.threadStarts).toHaveLength(1);
        expect(value.provider.turnStarts).toHaveLength(1);

        value.controls.workspaceFailure = null;
        value.controls.crashAfterAuthorityStep = null;
        const restarted = value.restart();
        await restarted.reconcile();

        expect(value.authority.readActorAttempt(quota.attemptId)).toMatchObject({
          state: "quotaRejected",
          providerTurnId: quota.event.providerTurnId,
          quotaProofDigest: quota.event.proof.digest,
          inputTokens: quota.event.inputTokens,
          outputTokens: quota.event.outputTokens,
        });
        expect(value.authority.readActorTurn(quota.turnId)).toMatchObject({
          state: "running",
        });
        expect(value.provider.threadStarts).toHaveLength(2);
        expect(value.provider.turnStarts).toHaveLength(2);
        expect(value.provider.turnStarts.filter(
          ({ continuation }) => continuation !== null,
        )).toHaveLength(1);
        expect(value.provider.turnStarts[1]?.continuation).toMatchObject({
          sourceAttemptId: quota.attemptId,
          sourceProviderTurnId: quota.event.providerTurnId,
        });

        await restarted.reconcile();
        expect(value.provider.threadStarts).toHaveLength(2);
        expect(value.provider.turnStarts).toHaveLength(2);
        expect(value.provider.turnStarts.filter(
          ({ continuation }) => continuation !== null,
        )).toHaveLength(1);
      } finally {
        value.database.close();
      }
    }
  });

  test("restart terminalizes proven quota exhaustion but preserves temporary unavailability", async () => {
    const exhausted = fixture(1);
    try {
      const quota = await preparePostAdmissionQuota(
        exhausted,
        "quotarestartexhausted",
      );
      exhausted.controls.crashAfterAuthorityStep = "quotaSettlement";
      await expectRejectedMessage(
        exhausted.coordinator.observeTerminal(quota.event),
        "injected crash after quotaSettlement",
      );
      const restarted = exhausted.restart();
      await restarted.reconcile();
      expect(exhausted.authority.readActorTurn(quota.turnId)).toMatchObject({
        state: "quotaRejected",
        outcomeCode: "quota_exhausted",
      });
      expect(exhausted.authority.readActorResultForTurn(quota.turnId))
        .toMatchObject({
          terminalAttemptId: quota.attemptId,
          outcome: "quotaRejected",
        });
      expect(exhausted.provider.threadStarts).toHaveLength(1);
      expect(exhausted.provider.turnStarts).toHaveLength(1);
      await restarted.reconcile();
      expect(exhausted.provider.threadStarts).toHaveLength(1);
      expect(exhausted.provider.turnStarts).toHaveLength(1);
    } finally {
      exhausted.database.close();
    }

    const pending = fixture(2);
    try {
      const quota = await preparePostAdmissionQuota(
        pending,
        "quotarestartpending",
      );
      const [source, successor] = pending.accounts;
      pending.controls.accountCandidates.splice(0, Infinity, source!);
      pending.controls.temporarilyUnavailableAccountProfileIds.push(
        successor!.accountProfileId,
      );
      pending.controls.crashAfterAuthorityStep = "quotaSettlement";
      await expectRejectedMessage(
        pending.coordinator.observeTerminal(quota.event),
        "injected crash after quotaSettlement",
      );

      const restarted = pending.restart();
      const report = await restarted.reconcile();
      expect(report.pending).toBeGreaterThanOrEqual(1);
      expect(pending.authority.readActorTurn(quota.turnId)).toMatchObject({
        state: "reconciling",
      });
      expect(pending.authority.readActorResultForTurn(quota.turnId)).toBeNull();
      expect(pending.provider.threadStarts).toHaveLength(1);
      expect(pending.provider.turnStarts).toHaveLength(1);

      pending.controls.temporarilyUnavailableAccountProfileIds.length = 0;
      pending.controls.accountCandidates.push(successor!);
      await restarted.reconcile();
      expect(pending.provider.threadStarts).toHaveLength(2);
      expect(pending.provider.turnStarts).toHaveLength(2);
      expect(pending.provider.turnStarts[1]?.continuation).toMatchObject({
        sourceAttemptId: quota.attemptId,
      });
    } finally {
      pending.database.close();
    }
  });

  test("a quarantined quota source is contained before any target provider effect", async () => {
    const value = fixture(2);
    try {
      const quota = await preparePostAdmissionQuota(
        value,
        "quotaquarantinesource",
      );
      value.controls.crashAfterAuthorityStep = "quotaSettlement";
      await expectRejectedMessage(
        value.coordinator.observeTerminal(quota.event),
        "injected crash after quotaSettlement",
      );
      const session = value.authority.readActorSessionBinding(
        quota.incarnationId,
      );
      if (session === null) throw new Error("quota source session is missing");
      value.authority.quarantineActorSessionBinding({
        incarnationId: quota.incarnationId,
        expectedRevision: session.revision,
        reason: "provider_identity_mismatch",
        now: at,
      });

      await expectPersistentActorError(
        value.restart().reconcile(),
        "ambiguous_effect",
      );

      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.readActorTurn(quota.turnId)).toMatchObject({
        state: "quotaRejected",
        outcomeCode: "quota_continuation_source_invalid",
      });
      expect(value.authority.readActorResultForTurn(quota.turnId)).toMatchObject({
        terminalAttemptId: quota.attemptId,
        outcome: "quotaRejected",
      });
      expect(value.authority.readActor(quota.actorId)).toMatchObject({
        state: "quarantined",
      });
      expect(value.authority.readActorSessionBinding(quota.incarnationId))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "provider_identity_mismatch",
        });
    } finally {
      value.database.close();
    }
  });

  test("contains a continuation source invalidated after replacement claim without live target state", async () => {
    const value = fixture(2);
    try {
      const quota = await preparePostAdmissionQuota(
        value,
        "quotasourcerace001",
      );
      const replacementClaims: Readonly<{
        attemptId: string;
        incarnationId: string;
      }>[] = [];
      value.controls.afterAttemptClaim = (claim) => {
        value.controls.afterAttemptClaim = null;
        replacementClaims.push(claim);
        value.controls.invalidSessionIncarnationId = quota.incarnationId;
      };

      let containmentFailure: unknown = null;
      try {
        await value.coordinator.observeTerminal(quota.event);
      } catch (error: unknown) {
        containmentFailure = error;
      }

      const replacement = replacementClaims[0];
      if (replacement === undefined) {
        throw new Error("replacement attempt was not claimed before containment");
      }
      const replacementAttemptId = replacement.attemptId;
      const replacementIncarnationId = replacement.incarnationId;
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.readActorAttempt(replacementAttemptId)).toMatchObject({
        state: "interrupted",
        providerTurnId: null,
      });
      expect(value.authority.readActorIncarnation(replacementIncarnationId))
        .toMatchObject({ state: "quarantined" });
      expect(value.authority.readActorSessionBinding(replacementIncarnationId))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "recovery_protocol_error",
        });
      expect(value.authority.readActiveIncarnationForActor(quota.actorId)).toBeNull();
      expect(value.authority.listLiveActorAttempts({ limit: 16 })).toEqual([]);
      expect(value.authority.readActorTurn(quota.turnId)).toMatchObject({
        state: "quotaRejected",
        outcomeCode: "quota_continuation_source_invalid",
      });
      expect(value.authority.readActor(quota.actorId)).toMatchObject({
        state: "quarantined",
      });
      expect(containmentFailure).toBeInstanceOf(PersistentActorError);
      expect(containmentFailure).toMatchObject({ code: "ambiguous_effect" });

      const restarted = value.restart();
      await restarted.reconcile();
      await restarted.reconcile();
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.listLiveActorAttempts({ limit: 16 })).toEqual([]);
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("restart contains source invalidation after a pre-effect replacement claim crash", async () => {
    const value = fixture(2);
    try {
      const quota = await preparePostAdmissionQuota(
        value,
        "quotaclaimcrashrestart",
      );
      const replacementClaims: Readonly<{
        attemptId: string;
        incarnationId: string;
      }>[] = [];
      value.controls.afterAttemptClaim = (claim) => {
        value.controls.afterAttemptClaim = null;
        replacementClaims.push(claim);
        // Fail after the replacement claim has committed but before its turn
        // effect can start. This leaves the same durable cut as a process crash
        // without invalidating the still-valid quota source yet.
        value.controls.invalidSessionIncarnationId = claim.incarnationId;
      };

      await expectPersistentActorError(
        value.coordinator.observeTerminal(quota.event),
        "conflict",
      );
      const replacement = replacementClaims[0];
      if (replacement === undefined) {
        throw new Error("replacement attempt was not claimed before the crash cut");
      }
      const replacementAttemptId = replacement.attemptId;
      const replacementIncarnationId = replacement.incarnationId;
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.readActorAttempt(replacementAttemptId)).toMatchObject({
        state: "starting",
        providerTurnId: null,
      });
      expect(value.authority.readActorIncarnation(replacementIncarnationId))
        .toMatchObject({ state: "running" });
      expect(value.authority.readActorSessionBinding(replacementIncarnationId))
        .toMatchObject({ state: "bound" });

      // The source becomes untrustworthy while the process is down. Recovery
      // must contain the claimed replacement atomically before reconstructing
      // or dispatching its request.
      value.controls.invalidSessionIncarnationId = quota.incarnationId;
      const restarted = value.restart();
      await expectPersistentActorError(
        restarted.reconcile(),
        "ambiguous_effect",
      );

      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.readActorAttempt(replacementAttemptId)).toMatchObject({
        state: "interrupted",
        providerTurnId: null,
      });
      expect(value.authority.readActorIncarnation(replacementIncarnationId))
        .toMatchObject({ state: "quarantined" });
      expect(value.authority.readActorSessionBinding(replacementIncarnationId))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "recovery_protocol_error",
        });
      expect(value.authority.readActiveIncarnationForActor(quota.actorId)).toBeNull();
      expect(value.authority.listLiveActorAttempts({ limit: 16 })).toEqual([]);
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);
      expect(value.authority.readActorTurn(quota.turnId)).toMatchObject({
        state: "quotaRejected",
        outcomeCode: "quota_continuation_source_invalid",
      });
      expect(value.authority.readActor(quota.actorId)).toMatchObject({
        state: "quarantined",
      });

      value.controls.invalidSessionIncarnationId = null;
      await restarted.reconcile();
      await restarted.reconcile();
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.authority.listLiveActorAttempts({ limit: 16 })).toEqual([]);
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("restart fences source invalidation after the replacement provider effect", async () => {
    const value = fixture(2);
    try {
      const quota = await preparePostAdmissionQuota(
        value,
        "quotaappliedsourcelost",
      );
      await value.coordinator.observeTerminal(quota.event);
      const replacement = value.authority.listActorAttempts({
        turnId: quota.turnId,
        limit: 16,
      }).find((attempt) => attempt.id !== quota.attemptId);
      if (replacement?.providerTurnId === null ||
        replacement?.providerTurnId === undefined) {
        throw new Error("replacement provider effect was not durably applied");
      }
      const replacementIncarnation = value.authority.readActorIncarnation(
        replacement.incarnationId,
      );
      if (replacementIncarnation === null) {
        throw new Error("replacement incarnation is missing");
      }
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(2);
      expect(value.provider.observations).toHaveLength(0);

      // Once the replacement provider turn exists, loss of its quota source
      // can no longer be treated as an effect-free containment. Recovery must
      // make the possibly-running provider effect visible as ambiguous.
      value.controls.invalidSessionIncarnationId = quota.incarnationId;
      const restarted = value.restart();
      const report = await restarted.reconcile();

      expect(report.fenced).toBeGreaterThanOrEqual(1);
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(2);
      expect(value.provider.observations).toHaveLength(0);
      expect(value.authority.readActorAttempt(replacement.id)).toMatchObject({
        state: "ambiguous",
        providerTurnId: replacement.providerTurnId,
      });
      expect(value.authority.readActorTurn(quota.turnId)).toMatchObject({
        state: "ambiguous",
      });
      expect(value.authority.readActorIncarnation(replacement.incarnationId))
        .toMatchObject({ state: "quarantined" });
      expect(value.authority.readActorSessionBinding(replacement.incarnationId))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "recovery_protocol_error",
        });
      expect(value.authority.readActiveIncarnationForActor(quota.actorId)).toBeNull();
      expect(value.authority.readActor(quota.actorId)).toMatchObject({
        state: "quarantined",
      });
      expect(value.authority.listLiveActorAttempts({ limit: 16 })).toEqual([]);
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);

      value.controls.invalidSessionIncarnationId = null;
      await restarted.reconcile();
      expect(value.provider.threadStarts).toHaveLength(2);
      expect(value.provider.turnStarts).toHaveLength(2);
      expect(value.provider.observations).toHaveLength(0);
    } finally {
      value.database.close();
    }
  });

  test("post-admission quota exhaustion terminalizes only the logical turn", async () => {
    const value = fixture(1);
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("postadmission0003"),
      );
      const [sourceAttempt] = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      });
      if (sourceAttempt?.providerTurnId === null ||
        sourceAttempt?.providerTurnId === undefined) {
        throw new Error("source attempt lacks its provider turn identity");
      }
      const event: PersistentActorTerminalObservation = {
        accountProfileId: sourceAttempt.accountProfileId,
        processGeneration: sourceAttempt.processGeneration,
        providerThreadId: providerThreadIdForIncarnation(
          value,
          sourceAttempt.incarnationId,
        ),
        providerTurnId: sourceAttempt.providerTurnId,
        terminal: "failed",
        resultValueId: null,
        outcomeCode: "usage_limit_exceeded",
        quotaProof: "provider_usage_limit_exceeded",
        inputTokens: 34,
        outputTokens: 13,
        proof: proof("8", { phase: "observation" }),
      };

      const settled = await observeTerminalWithExactUsage(value, event);

      expect(settled.turn).toMatchObject({
        id: spawned.turn.turn.id,
        actorId: spawned.actor.id,
        state: "quotaRejected",
        outcomeCode: "quota_exhausted",
      });
      expect(settled.result).toMatchObject({
        terminalAttemptId: sourceAttempt.id,
        outcome: "quotaRejected",
      });
      expect(value.authority.readActorAttempt(sourceAttempt.id)).toMatchObject({
        state: "quotaRejected",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
      expect(value.authority.readActor(spawned.actor.id)).toMatchObject({
        state: "active",
      });
      expect(value.authority.remainingActorTokens(spawned.actor.id)).toBe(9_953);
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)).toBeNull();
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect((await value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 0,
      }))).toMatchObject({ state: "terminal" });
    } finally {
      value.database.close();
    }
  });

  test("preserves the account adapter's health and selection rank", async () => {
    const rankedAccounts = [
      { accountProfileId: "acct_selected_healthy_z", processGeneration: 7 },
      { accountProfileId: "acct_healthy_a", processGeneration: 5 },
      { accountProfileId: "acct_unknown", processGeneration: 3 },
      { accountProfileId: "acct_low", processGeneration: 2 },
    ] as const;
    const value = fixture(rankedAccounts);
    try {
      for (const account of rankedAccounts.slice(0, -1)) {
        value.provider.turnOutcomes.set(account.accountProfileId, {
          kind: "notApplied",
          reason: "quota",
          proof: proof("6", { phase: "preEffect" }),
        });
      }

      const spawned = await value.coordinator.spawn(spawnInput("0000000000000067"));

      expect(spawned.turn.turn.state).toBe("running");
      expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual(rankedAccounts.map(({ accountProfileId }) => accountProfileId));
      expect(value.provider.turnStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual(rankedAccounts.map(({ accountProfileId }) => accountProfileId));
    } finally {
      value.database.close();
    }
  });

  test("all-account quota exhaustion terminalizes only the turn", async () => {
    const value = fixture();
    try {
      for (const account of value.accounts) {
        value.provider.turnOutcomes.set(account.accountProfileId, {
          kind: "notApplied",
          reason: "quota",
          proof: proof("6", { phase: "preEffect" }),
        });
      }
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000016"));
      expect(spawned.turn.turn).toMatchObject({
        state: "quotaRejected",
        outcomeCode: "quota_exhausted",
      });
      expect(spawned.turn.result?.outcome).toBe("quotaRejected");
      expect(spawned.turn.result?.terminalAttemptId).toStartWith("hattempt_");
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("active");
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)).toBeNull();
      expect((await value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 0,
      })).state).toBe("terminal");
    } finally {
      value.database.close();
    }
  });

  test("all thread admissions rejecting quota settle an effect-free turn exactly once", async () => {
    const value = fixture(2);
    try {
      for (const account of value.accounts) {
        value.provider.threadOutcomes.set(account.accountProfileId, {
          kind: "notApplied",
          reason: "quota",
          proof: proof("7", { phase: "preEffect" }),
        });
      }

      const spawned = await value.coordinator.spawn(
        spawnInput("threadquotaexhaust1"),
      );

      expect(spawned.turn.turn).toMatchObject({
        state: "quotaRejected",
        outcomeCode: "quota_exhausted_before_actor_start",
      });
      expect(spawned.turn.result).toMatchObject({
        terminalAttemptId: null,
        outcome: "quotaRejected",
      });
      expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
        .toEqual(value.accounts.map(({ accountProfileId }) => accountProfileId));
      expect(value.provider.turnStarts).toEqual([]);
      expect(value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      })).toEqual([]);
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)).toBeNull();
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);

      const restarted = value.restart();
      await restarted.reconcile();
      await restarted.reconcile();
      expect(value.provider.threadStarts).toHaveLength(value.accounts.length);
      expect(value.provider.turnStarts).toEqual([]);
      expect(value.authority.listLiveActorTurns({ limit: 16 })).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("fences ambiguous quota claims instead of cycling accounts", async () => {
    const value = fixture();
    try {
      const firstAccount = value.accounts[0]!.accountProfileId;
      value.provider.turnOutcomes.set(firstAccount, {
        kind: "notApplied",
        reason: "quota",
        proof: proof("6", { definitive: false, phase: "postDispatch" }),
      });
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("0000000000000003")),
        "ambiguous_effect",
      );
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 51,
      })[0]!;
      expect(value.authority.readActor(child.id)?.state).toBe("quarantined");
      expect(value.authority.readActiveIncarnationForActor(child.id)).toBeNull();
    } finally {
      value.database.close();
    }
  });

  test("reconciles a lost turn response after restart without a second start", async () => {
    const value = fixture();
    try {
      value.provider.throwNextTurnStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("0000000000000004")),
        "provider_pending",
      );
      const started = value.provider.turnStarts[0]!;
      value.provider.reconcileTurnOutcomes.set(started.accountProfileId, {
        kind: "applied",
        providerTurnId: "provider-turn-reconciled",
        proof: proof("7", { phase: "observation" }),
      });
      const recovered = await value.coordinator.reconcile();
      expect(recovered.inspectedAttempts).toBe(1);
      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.provider.turnReconciliations).toHaveLength(1);
      const child = value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 51,
      })[0]!;
      expect((await value.coordinator.status({
        callerActorId: rootActorId,
        actorId: child.id,
      })).liveTurns[0]).toMatchObject({ state: "running" });
    } finally {
      value.database.close();
    }
  });

  test("a deferred incarnation cannot starve healthy lost-turn reconciliation", async () => {
    const unreadyIncarnationIds = new Set<string>();
    const value = fixture(2, undefined, {
      isActorSessionReady: (incarnationId) =>
        !unreadyIncarnationIds.has(incarnationId),
    });
    try {
      const [firstAccount, secondAccount] = value.accounts;
      if (firstAccount === undefined || secondAccount === undefined) {
        throw new Error("mixed readiness fixture requires two accounts");
      }
      value.controls.accountCandidates.splice(0, Infinity, firstAccount);
      value.provider.throwNextTurnStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("readinessdeferred01")),
        "provider_pending",
      );
      const firstAttempt = value.authority.listUnsettledActorAttempts({
        limit: 16,
      }).find(({ accountProfileId }) =>
        accountProfileId === firstAccount.accountProfileId);
      if (firstAttempt === undefined) throw new Error("first lost attempt missing");

      value.controls.accountCandidates.splice(0, Infinity, secondAccount);
      value.provider.throwNextTurnStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("readinesshealthy001")),
        "provider_pending",
      );
      const secondAttempt = value.authority.listUnsettledActorAttempts({
        limit: 16,
      }).find(({ accountProfileId }) =>
        accountProfileId === secondAccount.accountProfileId);
      if (secondAttempt === undefined) throw new Error("second lost attempt missing");
      unreadyIncarnationIds.add(firstAttempt.incarnationId);
      value.provider.reconcileTurnOutcomes.set(firstAccount.accountProfileId, {
        kind: "applied",
        providerTurnId: "provider-turn-readiness-deferred",
        proof: proof("6", { phase: "observation" }),
      });
      value.provider.reconcileTurnOutcomes.set(secondAccount.accountProfileId, {
        kind: "applied",
        providerTurnId: "provider-turn-readiness-healthy",
        proof: proof("7", { phase: "observation" }),
      });

      expect((await value.coordinator.reconcile()).inspectedAttempts).toBe(1);
      expect(value.provider.turnReconciliations.map(
        ({ accountProfileId }) => accountProfileId,
      )).toEqual([secondAccount.accountProfileId]);
      expect(value.authority.readActorAttempt(firstAttempt.id)).toMatchObject({
        state: "reconciling",
        providerTurnId: null,
      });
      expect(value.authority.readActorAttempt(secondAttempt.id)).toMatchObject({
        state: "running",
        providerTurnId: "provider-turn-readiness-healthy",
      });

      unreadyIncarnationIds.delete(firstAttempt.incarnationId);
      expect((await value.coordinator.reconcile({
        limit: 512,
        incarnationIds: [firstAttempt.incarnationId],
      })).inspectedAttempts).toBe(1);
      expect(value.provider.turnReconciliations.map(
        ({ accountProfileId }) => accountProfileId,
      )).toEqual([
        secondAccount.accountProfileId,
        firstAccount.accountProfileId,
      ]);
      expect(value.authority.readActorAttempt(firstAttempt.id)).toMatchObject({
        state: "running",
        providerTurnId: "provider-turn-readiness-deferred",
      });
      expect(value.provider.observations).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("reconciles an N effect through an N+1 session without rewriting its receipt", async () => {
    const value = fixture();
    try {
      value.provider.throwNextTurnStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("crossgenerationlostturn")),
        "provider_pending",
      );
      const admitted = value.provider.turnStarts[0];
      if (admitted === undefined) throw new Error("turn effect was not admitted");
      const attempt = value.authority.listUnsettledActorAttempts({ limit: 16 })[0];
      if (attempt === undefined) throw new Error("turn attempt is missing");
      const incarnation = value.authority.readActorIncarnation(attempt.incarnationId);
      if (incarnation === null) throw new Error("turn incarnation is missing");
      const session = value.authority.readActorSessionBinding(incarnation.id);
      if (session === null) throw new Error("actor session is missing");
      const recoveredGeneration = admitted.processGeneration + 1;
      value.database.query(`
        UPDATE account_profiles
        SET process_generation = ?2, updated_at = ?3
        WHERE profile_id = ?1
      `).run(admitted.accountProfileId, recoveredGeneration, at);
      value.authority.advanceActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: session.revision,
        expectedLiveGeneration: session.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: sessionRecoveryProof({
          generation: recoveredGeneration,
          identity: `${incarnation.id}\0lost-turn-recovery`,
          priorRecoveryProofDigest: session.recoveryProof.recoveryProofDigest,
        }),
        now: at,
      });
      value.provider.reconcileTurnOutcomes.set(admitted.accountProfileId, {
        kind: "applied",
        providerTurnId: "provider-turn-cross-generation-reconciled",
        proof: proof("7", { phase: "observation" }),
      });

      await value.coordinator.reconcile();

      expect(value.provider.turnStarts).toHaveLength(1);
      expect(value.provider.turnReconciliations).toHaveLength(1);
      expect(value.provider.turnReconciliations[0]).toMatchObject({
        processGeneration: admitted.processGeneration,
        observationGeneration: recoveredGeneration,
        effectKey: admitted.effectKey,
      });
      const operation = value.authority.listRecoverableActorOperations({
        limit: 16,
      }).find(({ kind }) => kind === "turnStart");
      expect(operation).toBeUndefined();
      const stored = value.database.query<{ provider_identity_json: string }, []>(`
        SELECT provider_identity_json
        FROM harness_actor_operations
        WHERE kind = 'turnStart'
        LIMIT 1
      `).get();
      const envelope = JSON.parse(stored?.provider_identity_json ?? "null") as {
        request?: { processGeneration?: unknown; observationGeneration?: unknown };
      };
      expect(envelope.request).toMatchObject({
        processGeneration: admitted.processGeneration,
        observationGeneration: admitted.processGeneration,
      });
    } finally {
      value.database.close();
    }
  });

  test("falls back atomically when one root requests Fast on a second account", async () => {
    const value = fixture([{
      accountProfileId: "acct_fast_root_collision_01",
      processGeneration: 1,
      supportsFast: true,
      selectedProfile: "solUltra",
    }, {
      accountProfileId: "acct_fast_root_collision_02",
      processGeneration: 1,
      supportsFast: true,
      selectedProfile: "solUltra",
    }]);
    try {
      const fastAcceleration = {
        mode: "fast" as const,
        criticalPath: true as const,
        bottleneck: "reasoning" as const,
      };
      await value.coordinator.spawn({
        ...spawnInput("fastrootcollision01"),
        acceleration: fastAcceleration,
      });
      expect(value.provider.turnStarts[0]).toMatchObject({
        accountProfileId: value.accounts[0]!.accountProfileId,
        requestedAcceleration: fastAcceleration,
        serviceTier: "fast",
        tierFallbackReason: null,
      });

      value.controls.accountCandidates.splice(
        0,
        value.controls.accountCandidates.length,
        value.accounts[1]!,
      );
      const secondInput = {
        ...spawnInput("fastrootcollision02"),
        acceleration: fastAcceleration,
      };
      const second = await value.coordinator.spawn(secondInput);
      expect(value.provider.turnStarts[1]).toMatchObject({
        accountProfileId: value.accounts[1]!.accountProfileId,
        requestedAcceleration: fastAcceleration,
        serviceTier: "standard",
        tierFallbackReason: "fastReservationUnavailable",
        fastReservationId: null,
      });
      expect(value.authority.listActorAttempts({
        turnId: second.turn.turn.id,
        limit: 16,
      })).toMatchObject([{
        requestedServiceTier: "fast",
        realizedServiceTier: "standard",
        tierFallbackReason: "fastReservationUnavailable",
        fastReservationId: null,
      }]);
      const reservationRows = () => value.database.query<
        {
          reservation_id: string;
          root_actor_id: string;
          account_profile_id: string;
          state: string;
        },
        []
      >(`
        SELECT reservation_id, root_actor_id, account_profile_id, state
        FROM harness_actor_fast_reservations ORDER BY reservation_id
      `).all();
      const oneReservation = reservationRows();
      expect(oneReservation).toHaveLength(1);
      expect(oneReservation[0]).toMatchObject({
        root_actor_id: rootActorId,
        account_profile_id: value.accounts[0]!.accountProfileId,
        state: "effectStarted",
      });
      const effectCounts = {
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
      };

      const replay = await value.coordinator.spawn(secondInput);
      expect(replay.actor.id).toBe(second.actor.id);
      expect(replay.turn.turn.id).toBe(second.turn.turn.id);
      expect({
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
      }).toEqual(effectCounts);
      expect(reservationRows()).toEqual(oneReservation);
    } finally {
      value.database.close();
    }
  });

  test("falls back atomically when a second root requests Fast on one account", async () => {
    const value = fixture([{
      accountProfileId: "acct_fast_account_collision",
      processGeneration: 1,
      supportsFast: true,
      selectedProfile: "solUltra",
    }]);
    try {
      const fastAcceleration = {
        mode: "fast" as const,
        criticalPath: true as const,
        bottleneck: "fileGeneration" as const,
      };
      await value.coordinator.spawn({
        ...spawnInput("fastaccountroot001"),
        acceleration: fastAcceleration,
      });
      expect(value.provider.turnStarts[0]).toMatchObject({
        accountProfileId: value.accounts[0]!.accountProfileId,
        requestedAcceleration: fastAcceleration,
        serviceTier: "fast",
        tierFallbackReason: null,
      });

      const secondEpochId = "hepoch_fastcollisionroot02";
      const secondRootActorId = "hactor_fastcollisionroot02";
      const secondBudget = budget();
      value.authority.createActorEpoch({
        epoch: actorEpochSchema.parse({
          id: secondEpochId,
          projectId,
          sourceSha,
          rootActorId: secondRootActorId,
          budget: secondBudget,
          tokenReserved: 0,
          byteReserved: 0,
          nextRootCompletionSequence: 1,
          state: "active",
          revision: 1,
          createdAt: at,
          updatedAt: at,
          stoppedAt: null,
        }),
        rootActor: actorSchema.parse({
          id: secondRootActorId,
          epochId: secondEpochId,
          parentActorId: null,
          depth: 0,
          title: "Second Fast collision root",
          state: "active",
          budget: secondBudget,
          tokenReserved: 0,
          byteReserved: 0,
          nextTurnOrdinal: 1,
          nextResultOrdinal: 1,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          stoppedAt: null,
        }),
        dispatchPolicy: { policyVersion: 1, workClass: "standard" },
      });
      const secondInput = {
        ...spawnInput("fastaccountroot002"),
        callerActorId: secondRootActorId,
        acceleration: fastAcceleration,
      };
      const second = await value.coordinator.spawn(secondInput);
      expect(value.provider.turnStarts[1]).toMatchObject({
        accountProfileId: value.accounts[0]!.accountProfileId,
        requestedAcceleration: fastAcceleration,
        serviceTier: "standard",
        tierFallbackReason: "fastReservationUnavailable",
        fastReservationId: null,
      });
      expect(value.authority.listActorAttempts({
        turnId: second.turn.turn.id,
        limit: 16,
      })).toMatchObject([{
        requestedServiceTier: "fast",
        realizedServiceTier: "standard",
        tierFallbackReason: "fastReservationUnavailable",
        fastReservationId: null,
      }]);
      const reservationRows = () => value.database.query<
        {
          reservation_id: string;
          root_actor_id: string;
          account_profile_id: string;
          state: string;
        },
        []
      >(`
        SELECT reservation_id, root_actor_id, account_profile_id, state
        FROM harness_actor_fast_reservations ORDER BY reservation_id
      `).all();
      const oneReservation = reservationRows();
      expect(oneReservation).toHaveLength(1);
      expect(oneReservation[0]).toMatchObject({
        root_actor_id: rootActorId,
        account_profile_id: value.accounts[0]!.accountProfileId,
        state: "effectStarted",
      });
      const effectCounts = {
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
      };

      const replay = await value.coordinator.spawn(secondInput);
      expect(replay.actor.id).toBe(second.actor.id);
      expect(replay.turn.turn.id).toBe(second.turn.turn.id);
      expect({
        threadStarts: value.provider.threadStarts.length,
        turnStarts: value.provider.turnStarts.length,
      }).toEqual(effectCounts);
      expect(reservationRows()).toEqual(oneReservation);
    } finally {
      value.database.close();
    }
  });

  test("settles only quarantined Fast capacity and admits the later Fast turn", async () => {
    const value = fixture([{
      accountProfileId: "acct_fast_capacity_0001",
      processGeneration: 7,
      supportsFast: true,
      selectedProfile: "solUltra",
    }]);
    try {
      const account = value.accounts[0]!;
      value.provider.turnOutcomes.set(account.accountProfileId, {
        kind: "ambiguous",
        proof: proof("a", { phase: "observation" }),
      });
      const firstInput = {
        ...spawnInput("fastcapacityfirst01"),
        acceleration: {
          mode: "fast" as const,
          criticalPath: true as const,
          bottleneck: "reasoning" as const,
        },
      };
      await expectPersistentActorError(
        value.coordinator.spawn(firstInput),
        "ambiguous_effect",
      );
      const first = value.authority.listQuarantinedActorFastReservations({
        limit: 1,
      })[0];
      if (first === undefined) throw new Error("first Fast hold is missing");
      const firstAttempt = value.authority.readActorAttempt(first.attemptId);
      if (firstAttempt === null) throw new Error("first Fast attempt is missing");
      const firstTurn = value.authority.readActorTurn(firstAttempt.turnId);
      const firstIncarnation = value.authority.readActorIncarnation(
        firstAttempt.incarnationId,
      );
      const firstActor = firstTurn === null
        ? null
        : value.authority.readActor(firstTurn.actorId);
      const firstOperationId = value.database.query<
        { operation_id: string },
        [string]
      >(`
        SELECT operation_id FROM harness_actor_operations
        WHERE turn_id = ?1 AND kind = 'turnStart'
      `).get(firstAttempt.turnId)?.operation_id;
      const firstOperation = firstOperationId === undefined
        ? null
        : value.authority.readActorOperation(firstOperationId);
      expect({
        reservation: first,
        attempt: firstAttempt,
        turn: firstTurn,
        incarnation: firstIncarnation,
        actor: firstActor,
      }).toMatchObject({
        reservation: {
          state: "quarantined",
          terminalReason: "ambiguousProviderEffect",
          processGeneration: 7,
        },
        attempt: { state: "ambiguous", realizedServiceTier: "fast" },
        turn: { state: "ambiguous" },
        incarnation: { state: "quarantined" },
        actor: { state: "quarantined" },
      });

      const releaseProof = proof("b", {
        definitive: true,
        phase: "observation",
      });
      value.provider.fastCapacityOutcomes.set(first.id, {
        kind: "releasable",
        successorGeneration: 8,
        proof: releaseProof,
      });
      await value.coordinator.reconcile({ limit: 1 });
      expect(value.provider.fastCapacityReconciliations).toHaveLength(1);
      expect(value.provider.fastCapacityReconciliations[0]).toMatchObject({
        processGeneration: 7,
        observationGeneration: 7,
        fastReservationId: first.id,
        serviceTier: "fast",
      });
      expect(value.authority.readActorFastReservationForAttempt(first.attemptId))
        .toMatchObject({
          state: "released",
          terminalReason: "generationFenced",
          fenceEvidenceDigest: releaseProof.digest,
          fencedGeneration: 8,
        });
      expect(value.authority.readActorAttempt(first.attemptId))
        .toEqual(firstAttempt);
      expect(value.authority.readActorTurn(firstAttempt.turnId))
        .toEqual(firstTurn);
      expect(value.authority.readActorIncarnation(firstAttempt.incarnationId))
        .toEqual(firstIncarnation);
      expect(value.authority.readActor(firstTurn!.actorId)).toEqual(firstActor);
      expect(firstOperationId).toBeDefined();
      expect(value.authority.readActorOperation(firstOperationId!))
        .toEqual(firstOperation);

      const secondInput = {
        ...spawnInput("fastcapacitysecond1"),
        acceleration: {
          mode: "fast" as const,
          criticalPath: true as const,
          bottleneck: "fileGeneration" as const,
        },
      };
      await expectPersistentActorError(
        value.coordinator.spawn(secondInput),
        "ambiguous_effect",
      );
      expect(value.provider.turnStarts.at(-1)).toMatchObject({
        requestedAcceleration: secondInput.acceleration,
        serviceTier: "fast",
        tierFallbackReason: null,
      });
      const second = value.authority.listQuarantinedActorFastReservations({
        limit: 1,
      })[0];
      if (second === undefined || second.id === first.id) {
        throw new Error("later Fast hold was not admitted");
      }
      const consumeProof = proof("c", {
        definitive: true,
        phase: "observation",
      });
      value.provider.fastCapacityOutcomes.set(second.id, {
        kind: "consumable",
        successorGeneration: 9,
        providerTurnId: "provider-turn-fast-capacity-terminal",
        terminal: "completed",
        proof: consumeProof,
      });
      expect(await value.coordinator.reconcileQuarantinedFastCapacity({
        limit: 1,
      })).toEqual({ inspected: 1, released: 0, consumed: 1, held: 0 });
      expect(value.authority.readActorFastReservationForAttempt(second.attemptId))
        .toMatchObject({
          state: "consumed",
          terminalReason: "providerTerminal",
          fenceEvidenceDigest: consumeProof.digest,
          fencedGeneration: 9,
        });
      const callsAfterSettlement = value.provider.fastCapacityReconciliations.length;
      expect(await value.coordinator.reconcileQuarantinedFastCapacity({
        limit: 1,
      })).toEqual({ inspected: 0, released: 0, consumed: 0, held: 0 });
      expect(value.provider.fastCapacityReconciliations)
        .toHaveLength(callsAfterSettlement);
    } finally {
      value.database.close();
    }
  });

  test("repairs every legacy Fast containment prefix without provider replay", async () => {
    const prefixes = [
      "attempt",
      "turn",
      "incarnation",
      "stopRequested",
    ] as const;
    for (const [index, prefix] of prefixes.entries()) {
      const value = fixture([{
        accountProfileId: `acct_fast_prefix_${String(index + 1).padStart(4, "0")}`,
        processGeneration: 7,
        supportsFast: true,
        selectedProfile: "solUltra",
      }]);
      try {
        const account = value.accounts[0]!;
        value.controls.legacyFastContainmentPrefix = prefix;
        value.provider.turnOutcomes.set(account.accountProfileId, {
          kind: "ambiguous",
          proof: proof(String(index + 1), { phase: "observation" }),
        });
        const liveChildIds: string[] = [];
        if (prefix === "stopRequested") {
          value.provider.beforeTurnStartResponse = (request) => {
            const parent = value.authority.readActor(request.actorId);
            if (parent === null) throw new Error("Fast prefix parent is missing");
            liveChildIds.push(
              createDirectDescendant(value, parent, 991, "active").id,
            );
            return Promise.resolve();
          };
        }
        await expectRejectedMessage(value.coordinator.spawn({
          ...spawnInput(`fastprefix${String(index + 1).padStart(8, "0")}`),
          acceleration: {
            mode: "fast",
            criticalPath: true,
            bottleneck: "reasoning",
          },
        }), "injected crash after legacy Fast");
        const reservation = value.authority
          .listQuarantinedActorFastReservations({ limit: 1 })[0];
        if (reservation === undefined) {
          throw new Error(`legacy ${prefix} prefix lost its Fast anchor`);
        }
        const attempt = value.authority.readActorAttempt(reservation.attemptId);
        if (attempt === null) throw new Error("Fast prefix attempt is missing");
        const operationId = value.database.query<
          { operation_id: string },
          [string]
        >(`
          SELECT operation_id FROM harness_actor_operations
          WHERE turn_id = ?1 AND kind = 'turnStart'
        `).get(attempt.turnId)?.operation_id;
        if (operationId === undefined) {
          throw new Error("Fast prefix operation is missing");
        }
        const operationBefore = value.authority.readActorOperation(operationId);
        value.provider.fastCapacityOutcomes.set(reservation.id, {
          kind: "releasable",
          successorGeneration: 8,
          proof: proof(String(index + 5), {
            definitive: true,
            phase: "observation",
          }),
        });

        expect(await value.restart().reconcileQuarantinedFastCapacity({
          limit: 1,
        })).toEqual({ inspected: 1, released: 1, consumed: 0, held: 0 });
        expect(value.authority.readActorFastReservationForAttempt(attempt.id))
          .toMatchObject({
            state: "released",
            terminalReason: "generationFenced",
            fencedGeneration: 8,
          });
        expect(value.authority.readActorAttempt(attempt.id))
          .toMatchObject({ state: "ambiguous" });
        const turn = value.authority.readActorTurn(attempt.turnId);
        const incarnation = value.authority.readActorIncarnation(
          attempt.incarnationId,
        );
        expect(turn).toMatchObject({ state: "ambiguous" });
        expect(incarnation).toMatchObject({ state: "quarantined" });
        expect(value.authority.readActorSessionBinding(attempt.incarnationId))
          .toMatchObject({ state: "quarantined", workspaceMode: "readOnly" });
        expect(value.authority.readActor(turn!.actorId))
          .toMatchObject({ state: "quarantined" });
        expect(value.authority.readActiveActorAccountLoad({
          accountProfileId: account.accountProfileId,
          processGeneration: 7,
        })).toBe(0);
        expect(value.database.query(`
          SELECT state FROM harness_actor_workspace_bindings
          WHERE actor_id = ?1 ORDER BY binding_id DESC LIMIT 1
        `).get(turn!.actorId)).toEqual({ state: "quarantined" });
        expect(value.database.query(`
          SELECT status, quarantine_reason FROM workspace_leases
          WHERE lane_id = 'lane_persistent_snapshot'
        `).get()).toEqual({ status: "ready", quarantine_reason: null });
        expect(value.authority.readActorOperation(operationId))
          .toEqual(operationBefore);
        expect(value.provider.turnStarts).toHaveLength(1);
        expect(value.provider.turnReconciliations).toHaveLength(0);
        expect(value.provider.observations).toHaveLength(0);
        expect(value.provider.fastCapacityReconciliations).toHaveLength(1);
        const liveChildId = liveChildIds[0];
        if (liveChildId !== undefined) {
          expect(value.authority.readActor(liveChildId))
            .toMatchObject({ state: "active" });
        }

        expect(await value.restart().reconcileQuarantinedFastCapacity({
          limit: 1,
        })).toEqual({ inspected: 0, released: 0, consumed: 0, held: 0 });
        expect(value.provider.fastCapacityReconciliations).toHaveLength(1);
      } finally {
        value.database.close();
      }
    }
  });

  test("holds quarantined Fast capacity on non-definitive evidence", async () => {
    const value = fixture([{
      accountProfileId: "acct_fast_capacity_held",
      processGeneration: 7,
      supportsFast: true,
      selectedProfile: "solUltra",
    }]);
    try {
      const account = value.accounts[0]!;
      value.provider.turnOutcomes.set(account.accountProfileId, {
        kind: "ambiguous",
        proof: proof("a", { phase: "observation" }),
      });
      await expectPersistentActorError(value.coordinator.spawn({
        ...spawnInput("fastcapacityheld001"),
        acceleration: {
          mode: "fast",
          criticalPath: true,
          bottleneck: "reasoning",
        },
      }), "ambiguous_effect");
      const reservation = value.authority.listQuarantinedActorFastReservations({
        limit: 1,
      })[0];
      if (reservation === undefined) throw new Error("held Fast slot is missing");

      expect(await value.coordinator.reconcileQuarantinedFastCapacity({
        limit: 1,
      })).toEqual({ inspected: 1, released: 0, consumed: 0, held: 1 });
      for (const reason of ["incompleteScan", "unstableScan"] as const) {
        value.provider.fastCapacityOutcomes.set(reservation.id, {
          kind: "held",
          reason,
          successorGeneration: 8,
          proof: proof(reason === "incompleteScan" ? "b" : "c", {
            definitive: false,
            phase: "observation",
          }),
        });
        expect(await value.coordinator.reconcileQuarantinedFastCapacity({
          limit: 1,
        })).toEqual({ inspected: 1, released: 0, consumed: 0, held: 1 });
        expect(value.authority.readActorFastReservationForAttempt(
          reservation.attemptId,
        )).toMatchObject({ state: "quarantined", fencedGeneration: null });
      }

      value.provider.fastCapacityOutcomes.set(reservation.id, {
        kind: "releasable",
        successorGeneration: 7,
        proof: proof("d", { definitive: true, phase: "observation" }),
      });
      await expectPersistentActorError(
        value.coordinator.reconcileQuarantinedFastCapacity({ limit: 1 }),
        "conflict",
      );
      expect(value.authority.readActorFastReservationForAttempt(
        reservation.attemptId,
      )).toMatchObject({ state: "quarantined", fencedGeneration: null });
    } finally {
      value.database.close();
    }
  });

  test("atomically rebinds a claimed pre-effect turn to successor catalog custody", async () => {
    const value = fixture();
    try {
      value.controls.afterAttemptClaim = ({ attemptId, incarnationId }) => {
        value.controls.afterAttemptClaim = null;
        const claimed = value.authority.readActorAttempt(attemptId);
        const session = value.authority.readActorSessionBinding(incarnationId);
        if (claimed === null || session === null) {
          throw new Error("claimed successor fixture lost durable lineage");
        }
        const successorGeneration = session.liveGeneration + 1;
        value.database.query(`
          UPDATE account_profiles
          SET process_generation = ?2, updated_at = ?3
          WHERE profile_id = ?1
        `).run(claimed.accountProfileId, successorGeneration, at);
        value.authority.advanceActorSessionBinding({
          incarnationId,
          expectedRevision: session.revision,
          expectedLiveGeneration: session.liveGeneration,
          liveCapabilityEvidence: {
            evidenceDigest: "e".repeat(64),
            supportsFast: true,
          },
          recoveryProof: sessionRecoveryProof({
            generation: successorGeneration,
            identity: `${incarnationId}\0pre-effect-successor`,
            priorRecoveryProofDigest:
              session.recoveryProof.recoveryProofDigest,
          }),
          now: at,
        });
      };

      const spawned = await value.coordinator.spawn(
        spawnInput("preeffectsuccessor"),
      );
      const providerRequest = value.provider.turnStarts[0];
      if (providerRequest === undefined) {
        throw new Error("successor provider request is missing");
      }
      const attempt = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      })[0];
      expect(attempt).toMatchObject({
        processGeneration: providerRequest.processGeneration - 1,
        effectGeneration: providerRequest.processGeneration,
        capabilityEvidenceDigest: "e".repeat(64),
      });
      expect(providerRequest).toMatchObject({
        processGeneration: attempt?.effectGeneration,
        observationGeneration: attempt?.effectGeneration,
        capabilityEvidenceDigest: "e".repeat(64),
      });
      const operationId = value.database.query<{ operation_id: string }, [string]>(`
        SELECT operation_id FROM harness_actor_operations
        WHERE turn_id = ?1 AND kind = 'turnStart'
      `).get(spawned.turn.turn.id)?.operation_id;
      const operation = operationId === undefined
        ? null
        : value.authority.readActorOperation(operationId);
      expect(operation).toMatchObject({ state: "succeeded" });
      const stored = JSON.parse(operation?.providerIdentityJson ?? "null") as {
        request?: { processGeneration?: unknown; capabilityEvidenceDigest?: unknown };
      };
      expect(stored.request).toMatchObject({
        processGeneration: attempt?.effectGeneration,
        capabilityEvidenceDigest: "e".repeat(64),
      });
    } finally {
      value.database.close();
    }
  });

  test("reconciles a lost thread response before starting its prepared turn", async () => {
    const value = fixture();
    try {
      value.provider.throwNextThreadStart = true;
      await expectPersistentActorError(
        value.coordinator.spawn(spawnInput("0000000000000010")),
        "provider_pending",
      );
      const request = value.provider.threadStarts[0]!;
      value.provider.threadOutcomes.set(
        request.accountProfileId,
        appliedThreadOutcome(request, "provider-thread-reconciled"),
      );
      const recovered = await value.coordinator.reconcile();
      expect(recovered.inspectedOperations).toBe(1);
      expect(recovered.inspectedTurns).toBe(1);
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.threadReconciliations).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("concurrent idempotent spawn admits one external start per effect", async () => {
    const value = fixture();
    try {
      const input = spawnInput("0000000000000011");
      const outcomes = await Promise.allSettled([
        value.coordinator.spawn(input),
        value.coordinator.spawn(input),
        value.coordinator.spawn(input),
      ]);
      expect(outcomes.some(({ status }) => status === "fulfilled")).toBe(true);
      const replay = await value.coordinator.spawn(input);
      expect(replay.turn.turn.state).toBe("running");
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("interrupt acknowledgement stays pending until terminal observation", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000005"));
      const request = value.provider.turnStarts[0]!;
      const cancelled = await value.coordinator.cancel({
        callerActorId: rootActorId,
        turnId: spawned.turn.turn.id,
      });
      expect(cancelled.turn).toMatchObject({ state: "reconciling", desiredState: "stop" });
      expect(cancelled.result).toBeNull();
      expect(value.provider.interrupts).toHaveLength(1);

      const event = terminalEvent(request, "interrupted", "0005");
      event.providerTurnId = value.provider.interrupts[0]!.providerTurnId;
      const settled = await observeTerminalWithExactUsage(value, event);
      expect(settled.turn.state).toBe("cancelled");
      expect(settled.result).toMatchObject({ outcome: "cancelled" });
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("active");
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)?.state)
        .toBe("idle");
    } finally {
      value.database.close();
    }
  });

  test("send starts a new logical turn on the same proven-idle incarnation", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000015"));
      const firstRequest = value.provider.turnStarts[0]!;
      const firstEvent = terminalEvent(firstRequest, "completed", "0015");
      firstEvent.providerTurnId = `provider-turn-${firstRequest.accountProfileId}-1`;
      await observeTerminalWithExactUsage(value, firstEvent);
      const incarnationBefore = value.authority.readActiveIncarnationForActor(
        spawned.actor.id,
      );
      const sent = await value.coordinator.send({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
        idempotencyKey: "send-persistent-00000015",
        inputValueId: "ctxval_input_send_0015",
      });
      expect(sent.turn).toMatchObject({ ordinal: 2, state: "running" });
      expect(value.provider.threadStarts).toHaveLength(1);
      expect(value.provider.turnStarts).toHaveLength(2);
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)?.id)
        .toBe(incarnationBefore?.id);
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("active");
    } finally {
      value.database.close();
    }
  });

  test("a prepared follow-up settles stop or deadline without starting a provider turn", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      const value = fixture(1);
      const entered = deferred<void>();
      const release = deferred<void>();
      let sending: Promise<unknown> | null = null;
      try {
        const spawned = await value.coordinator.spawn(
          spawnInput(`prepared${mode}01`),
        );
        const initialRequest = value.provider.turnStarts[0]!;
        const initialEvent = terminalEvent(
          initialRequest,
          "completed",
          `prepared-${mode}`,
        );
        initialEvent.providerTurnId = value.authority.listActorAttempts({
          turnId: spawned.turn.turn.id,
          limit: 16,
        })[0]!.providerTurnId!;
        await observeTerminalWithExactUsage(value, initialEvent);
        value.controls.workspaceBarrier = async () => {
          entered.resolve();
          await release.promise;
        };
        sending = value.coordinator.send({
          callerActorId: rootActorId,
          actorId: spawned.actor.id,
          idempotencyKey: `prepared-follow-up-${mode}`,
          inputValueId: `ctxval_prepared_follow_up_${mode}`,
        });
        await entered.promise;
        const prepared = value.authority.listLiveActorTurns({ limit: 16 })
          .find(({ actorId, state }) =>
            actorId === spawned.actor.id && state === "prepared"
          );
        if (prepared === undefined) throw new Error("prepared follow-up is missing");
        if (mode === "cancel") {
          await value.coordinator.cancel({
            callerActorId: rootActorId,
            turnId: prepared.id,
          });
        } else {
          value.controls.now = deadline;
        }
        release.resolve();
        await Promise.allSettled([sending]);

        expect(value.provider.threadStarts).toHaveLength(1);
        expect(value.provider.turnStarts).toHaveLength(1);
        expect(value.authority.listActorAttempts({
          turnId: prepared.id,
          limit: 16,
        })).toEqual([]);
        expect(value.authority.readActorResultForTurn(prepared.id)).toMatchObject({
          terminalAttemptId: null,
          outcome: "cancelled",
        });
        expect(value.authority.readActorTurn(prepared.id)).toMatchObject({
          outcomeCode: mode === "cancel"
            ? "cancelled_before_effect"
            : "deadline_before_effect",
        });
      } finally {
        release.resolve();
        if (sending !== null) await Promise.allSettled([sending]);
        value.database.close();
      }
    }
  });

  test("a recovered N+1 session uses its live generation while preserving admission N", async () => {
    const value = fixture(1);
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("recoveredsessionn1"),
      );
      const admissionRequest = value.provider.turnStarts[0];
      if (admissionRequest === undefined) {
        throw new Error("admission turn request is missing");
      }
      const admissionAttempt = value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      })[0];
      if (admissionAttempt?.providerTurnId === null ||
        admissionAttempt?.providerTurnId === undefined) {
        throw new Error("admission attempt lacks its provider turn");
      }
      const incarnation = value.authority.readActorIncarnation(
        admissionAttempt.incarnationId,
      );
      if (incarnation === null) throw new Error("admission incarnation is missing");
      const initialSession = value.authority.readActorSessionBinding(incarnation.id);
      if (initialSession === null) throw new Error("initial session binding is missing");
      const recoveredGeneration = initialSession.liveGeneration + 1;
      value.database.query(`
        UPDATE account_profiles
        SET process_generation = ?2, updated_at = ?3
        WHERE profile_id = ?1
      `).run(
        admissionAttempt.accountProfileId,
        recoveredGeneration,
        at,
      );
      value.authority.advanceActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: initialSession.revision,
        expectedLiveGeneration: initialSession.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: sessionRecoveryProof({
          generation: recoveredGeneration,
          identity: `${incarnation.id}\0recovered`,
          priorRecoveryProofDigest:
            initialSession.recoveryProof.recoveryProofDigest,
        }),
        now: at,
      });

      const admissionTerminal = terminalEvent(
        admissionRequest,
        "completed",
        "recovered-admission",
      );
      admissionTerminal.processGeneration = recoveredGeneration;
      admissionTerminal.providerTurnId = admissionAttempt.providerTurnId;
      await observeTerminalWithExactUsage(value, admissionTerminal);

      const next = await value.coordinator.send({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
        idempotencyKey: "send-recovered-session-n1",
        inputValueId: "ctxval_input_recovered_session_n1",
      });
      const recoveredTurnRequest = value.provider.turnStarts[1];
      if (recoveredTurnRequest === undefined) {
        throw new Error("recovered turn request is missing");
      }
      expect(recoveredTurnRequest).toMatchObject({
        processGeneration: recoveredGeneration,
        providerThreadId: incarnation.providerThreadId,
      });
      const recoveredAttempt = value.authority.listActorAttempts({
        turnId: next.turn.id,
        limit: 16,
      })[0];
      expect(recoveredAttempt).toMatchObject({
        accountProfileId: admissionAttempt.accountProfileId,
        processGeneration: admissionAttempt.processGeneration,
        effectGeneration: recoveredGeneration,
        capabilityEvidenceDigest: "c".repeat(64),
        state: "running",
      });

      await value.coordinator.cancel({
        callerActorId: rootActorId,
        turnId: next.turn.id,
      });
      const interrupt = value.provider.interrupts[0];
      if (interrupt === undefined) throw new Error("recovered interrupt is missing");
      expect(interrupt).toMatchObject({
        processGeneration: recoveredGeneration,
        providerThreadId: incarnation.providerThreadId,
      });
      await observeTerminalWithExactUsage(value, {
        accountProfileId: interrupt.accountProfileId,
        processGeneration: recoveredGeneration,
        providerThreadId: interrupt.providerThreadId,
        providerTurnId: interrupt.providerTurnId,
        terminal: "interrupted",
        resultValueId: null,
        outcomeCode: "stopped",
        quotaProof: null,
        inputTokens: 0,
        outputTokens: 0,
        proof: proof("8", { phase: "observation" }),
      });

      expect(value.authority.listActorAttempts({
        turnId: spawned.turn.turn.id,
        limit: 16,
      })[0]?.processGeneration).toBe(initialSession.admissionGeneration);
      expect(value.authority.listActorAttempts({
        turnId: next.turn.id,
        limit: 16,
      })[0]).toMatchObject({
        processGeneration: initialSession.admissionGeneration,
        effectGeneration: recoveredGeneration,
      });
      expect(value.authority.readActorSessionBinding(incarnation.id)).toMatchObject({
        admissionGeneration: initialSession.admissionGeneration,
        liveGeneration: recoveredGeneration,
        liveCapabilityEvidenceDigest: "c".repeat(64),
        liveSupportsFast: true,
        state: "bound",
      });
    } finally {
      value.database.close();
    }
  });

  test("quiescence survives crash-style retries and settlement stays explicit", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000017"));
      const target = {
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
      };
      await expectPersistentActorError(
        value.coordinator.quiesceActorForStop(target),
        "provider_pending",
      );
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("stopRequested");
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)?.state)
        .toBe("running");
      await expectPersistentActorError(
        value.coordinator.quiesceActorForStop(target),
        "provider_pending",
      );
      expect(value.provider.interrupts).toHaveLength(1);
      const interrupt = value.provider.interrupts[0]!;
      await observeTerminalWithExactUsage(value, {
        accountProfileId: interrupt.accountProfileId,
        processGeneration: interrupt.processGeneration,
        providerThreadId: interrupt.providerThreadId,
        providerTurnId: interrupt.providerTurnId,
        terminal: "interrupted",
        resultValueId: null,
        outcomeCode: "stopped",
        quotaProof: null,
        inputTokens: 0,
        outputTokens: 0,
        proof: proof("8", { phase: "observation" }),
      });
      const quiesced = await value.coordinator.quiesceActorForStop(target);
      expect(quiesced.state).toBe("stopRequested");
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)).toBeNull();
      const replay = await value.coordinator.quiesceActorForStop(target);
      expect(replay).toEqual(quiesced);
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("stopRequested");

      const stopped = await value.coordinator.stopActor(target);
      expect(stopped.state).toBe("stopped");
      expect(value.authority.readActiveIncarnationForActor(spawned.actor.id)).toBeNull();
      expect(await value.coordinator.stopActor(target)).toEqual(stopped);
    } finally {
      value.database.close();
    }
  });

  test("stop rejects a live descendant beyond the first actor page before persisting intent", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("0000000000000018", 50 * MIB),
      );
      for (let index = 0; index < 16; index += 1) {
        createDirectDescendant(value, spawned.actor, index, "stopped");
      }
      const live = createDirectDescendant(value, spawned.actor, 16, "active");
      await expectPersistentActorError(value.coordinator.stopActor({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
      }), "actor_busy");
      expect(value.authority.readActor(live.id)?.state).toBe("active");
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("active");
      expect(value.provider.interrupts).toHaveLength(0);
    } finally {
      value.database.close();
    }
  });

  test("restart reconciles a lost interrupt and never treats its acknowledgement as terminal", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000012"));
      value.provider.throwNextInterrupt = true;
      const pending = await value.coordinator.cancel({
        callerActorId: rootActorId,
        turnId: spawned.turn.turn.id,
      });
      expect(pending.turn.state).toBe("reconciling");
      expect(pending.result).toBeNull();
      const recovery = await value.coordinator.reconcile();
      expect(recovery.inspectedAttempts).toBe(1);
      expect(recovery.pending).toBe(1);
      expect(value.provider.interrupts).toHaveLength(1);
      expect(value.provider.interruptReconciliations).toHaveLength(1);
      expect((await value.coordinator.result({
        callerActorId: rootActorId,
        turnId: spawned.turn.turn.id,
      })).turn.state).toBe("reconciling");
    } finally {
      value.database.close();
    }
  });

  test("terminal observation repairs a crash between attempt and result settlement", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000013"));
      const attempt = value.authority.listUnsettledActorAttempts({ limit: 128 })[0]!;
      const providerTurnId = attempt.providerTurnId;
      if (providerTurnId === null) throw new Error("fixture attempt lacks provider turn");
      const terminal: PersistentActorTerminalObservation = {
        accountProfileId: attempt.accountProfileId,
        processGeneration: attempt.processGeneration,
        providerThreadId: providerThreadIdForIncarnation(
          value,
          attempt.incarnationId,
        ),
        providerTurnId,
        terminal: "failed",
        resultValueId: null,
        outcomeCode: "provider_failed",
        quotaProof: null,
        inputTokens: 2,
        outputTokens: 3,
        proof: proof("8", { phase: "observation" }),
      };
      await recordExactTerminalUsage(value, terminal);
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "running",
        nextState: "failed",
        providerTurnId,
        inputTokens: 2,
        outputTokens: 3,
        now: at,
      });
      value.provider.observationOutcomes.set(spawned.turn.turn.id, terminal);
      const recovery = await value.coordinator.reconcile();
      expect(recovery.inspectedTurns).toBe(1);
      const repaired = await value.coordinator.result({
        callerActorId: rootActorId,
        turnId: spawned.turn.turn.id,
      });
      expect(repaired.turn.state).toBe("failed");
      expect(repaired.result).toMatchObject({ outcome: "failed" });
      expect(value.authority.readActor(spawned.actor.id)?.state).toBe("active");
    } finally {
      value.database.close();
    }
  });

  test("wait cancellation is abortable without retaining waiter state", async () => {
    const value = fixture();
    try {
      const spawned = await value.coordinator.spawn(spawnInput("0000000000000014"));
      const controller = new AbortController();
      controller.abort(new Error("test abort"));
      await expectPersistentActorError(value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 100,
      }, controller.signal), "aborted");
    } finally {
      value.database.close();
    }
  });

  test("a zero-duration wait returns without entering unresolved liveness", async () => {
    let livenessCalls = 0;
    const convergence = deferred<void>();
    const value = fixture(2, {
      ensureCurrent: () => {
        livenessCalls += 1;
        return convergence.promise;
      },
    }, undefined, boundedTestClock());
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("waitzerobound01"),
      );
      expect(await value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 0,
      })).toEqual({
        state: "timeout",
        completed: null,
        pendingTurnIds: [spawned.turn.turn.id],
      });
      expect(livenessCalls).toBe(0);
      convergence.resolve();
    } finally {
      value.database.close();
    }
  });

  test("caller deadline bounds an unresolved shared liveness pass", async () => {
    let livenessCalls = 0;
    const convergence = deferred<void>();
    const value = fixture(2, {
      ensureCurrent: () => {
        livenessCalls += 1;
        return convergence.promise;
      },
    }, undefined, boundedTestClock());
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("waitdeadline001"),
      );
      const startedAt = performance.now();
      expect(await value.coordinator.waitAll({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 20,
      })).toEqual({
        state: "timeout",
        completed: [],
        pendingTurnIds: [spawned.turn.turn.id],
      });
      expect(performance.now() - startedAt).toBeLessThan(200);
      expect(livenessCalls).toBe(1);
      convergence.resolve();
      await convergence.promise;
    } finally {
      value.database.close();
    }
  });

  test("post-admission abort releases one waiter without cancelling shared liveness", async () => {
    let livenessCalls = 0;
    const convergence = deferred<void>();
    const value = fixture(2, {
      ensureCurrent: () => {
        livenessCalls += 1;
        return convergence.promise;
      },
    }, undefined, boundedTestClock());
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("waitabortbound1"),
      );
      const controller = new AbortController();
      const waiting = value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 1_000,
      }, controller.signal);
      await Promise.resolve();
      expect(livenessCalls).toBe(1);
      controller.abort(new Error("post-admission abort"));
      await expectPersistentActorError(waiting, "aborted");
      convergence.resolve();
      await convergence.promise;
      expect(livenessCalls).toBe(1);
    } finally {
      value.database.close();
    }
  });

  test("waitAny and waitAll use durable completion order while actors survive", async () => {
    const value = fixture();
    try {
      const first = await value.coordinator.spawn(spawnInput("0000000000000006"));
      const second = await value.coordinator.spawn(spawnInput("0000000000000007"));
      const firstRequest = value.provider.turnStarts[0]!;
      const secondRequest = value.provider.turnStarts[1]!;
      const secondEvent = terminalEvent(secondRequest, "completed", "0007");
      secondEvent.providerTurnId = `provider-turn-${secondRequest.accountProfileId}-2`;
      await observeTerminalWithExactUsage(value, secondEvent);
      const firstEvent = terminalEvent(firstRequest, "completed", "0006");
      firstEvent.providerTurnId = `provider-turn-${firstRequest.accountProfileId}-1`;
      await observeTerminalWithExactUsage(value, firstEvent);

      const any = await value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [first.turn.turn.id, second.turn.turn.id],
        timeoutMs: 0,
      });
      expect(any.completed?.turn.id).toBe(second.turn.turn.id);
      const all = await value.coordinator.waitAll({
        callerActorId: rootActorId,
        turnIds: [first.turn.turn.id, second.turn.turn.id],
        timeoutMs: 0,
      });
      expect(all.completed.map(({ turn }) => turn.id)).toEqual([
        second.turn.turn.id,
        first.turn.turn.id,
      ]);
      expect(value.authority.readActor(first.actor.id)?.state).toBe("active");
      expect(value.authority.readActor(second.actor.id)?.state).toBe("active");
    } finally {
      value.database.close();
    }
  });

  test("refreshes durable liveness before status, result, and every wait", async () => {
    let refreshes = 0;
    const liveness: PersistentActorLivenessPortV2 = {
      ensureCurrent: () => {
        refreshes += 1;
        return Promise.resolve();
      },
    };
    const value = fixture(2, liveness);
    try {
      const spawned = await value.coordinator.spawn(
        spawnInput("0000000000000017"),
      );
      await expectPersistentActorError(value.coordinator.status({
        callerActorId: spawned.actor.id,
        actorId: spawned.actor.id,
      }), "unauthorized");
      expect(refreshes).toBe(0);
      await value.coordinator.status({
        callerActorId: rootActorId,
        actorId: spawned.actor.id,
      });
      await value.coordinator.result({
        callerActorId: rootActorId,
        turnId: spawned.turn.turn.id,
      });
      await value.coordinator.waitAny({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 0,
      });
      await value.coordinator.waitAll({
        callerActorId: rootActorId,
        turnIds: [spawned.turn.turn.id],
        timeoutMs: 0,
      });
      expect(refreshes).toBe(2);
    } finally {
      value.database.close();
    }
  });

  test("rejects authority outside a caller's direct persistent children", async () => {
    const value = fixture();
    try {
      const first = await value.coordinator.spawn(spawnInput("0000000000000008"));
      const second = await value.coordinator.spawn(spawnInput("0000000000000009"));
      await expectPersistentActorError(value.coordinator.status({
        callerActorId: first.actor.id,
        actorId: second.actor.id,
      }), "unauthorized");
    } finally {
      value.database.close();
    }
  });

  test("quota-prefix failover and replay are deterministic for arbitrary eligible sets", async () => {
    await assertAsyncProperty(fc.asyncProperty(
      fc.integer({ min: 0, max: 4 }),
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 0, max: 4 }),
      fc.array(fc.constantFrom(..."0123456789abcdef"), {
        minLength: 16,
        maxLength: 24,
      }).map((characters) => characters.join("")),
      async (quotaPrefix, replayCount, rotation, suffix) => {
        const canonicalAccounts = Array.from({ length: 5 }, (_, index) => ({
          accountProfileId: `acct_property_${String(index + 1).padStart(4, "0")}`,
          processGeneration: index + 1,
        }));
        const rankedAccounts = [
          ...canonicalAccounts.slice(rotation),
          ...canonicalAccounts.slice(0, rotation),
        ];
        const value = fixture(rankedAccounts);
        try {
          for (const account of value.accounts.slice(0, quotaPrefix)) {
            value.provider.turnOutcomes.set(account.accountProfileId, {
              kind: "notApplied",
              reason: "quota",
              proof: proof("6", { phase: "preEffect" }),
            });
          }
          const input = spawnInput(suffix);
          const first = await value.coordinator.spawn(input);
          for (let index = 0; index < replayCount; index += 1) {
            const replay = await value.coordinator.spawn(input);
            expect(replay.actor.id).toBe(first.actor.id);
            expect(replay.turn.turn.id).toBe(first.turn.turn.id);
          }
          const expectedAccounts = value.accounts.slice(0, quotaPrefix + 1)
            .map(({ accountProfileId }) => accountProfileId);
          expect(value.provider.threadStarts.map(({ accountProfileId }) => accountProfileId))
            .toEqual(expectedAccounts);
          expect(value.provider.turnStarts.map(({ accountProfileId }) => accountProfileId))
            .toEqual(expectedAccounts);
          expect(value.authority.readActor(first.actor.id)?.state).toBe("active");
          expect(value.authority.readActiveIncarnationForActor(first.actor.id))
            .toMatchObject({ accountProfileId: expectedAccounts.at(-1) });
        } finally {
          value.database.close();
        }
      },
    ), { numRuns: 40 });
  }, 10_000);

  test("every live descendant position blocks stop across bounded pages and retries", async () => {
    await assertAsyncProperty(fc.asyncProperty(
      // The spawned actor already consumes one slot in the root epoch. The
      // direct descendants below may consume every remaining durable slot.
      fc.integer({ min: 0, max: HARNESS_MAX_DURABLE_DESCENDANTS - 2 }),
      fc.integer({ min: 1, max: 3 }),
      async (terminalPrefix, retries) => {
        const value = fixture();
        try {
          const suffix = `descendant-${String(terminalPrefix).padStart(4, "0")}`;
          const spawned = await value.coordinator.spawn(spawnInput(suffix, 50 * MIB));
          for (let index = 0; index < terminalPrefix; index += 1) {
            createDirectDescendant(value, spawned.actor, index, "stopped");
          }
          createDirectDescendant(value, spawned.actor, terminalPrefix, "active");
          for (let retry = 0; retry < retries; retry += 1) {
            await expectPersistentActorError(value.coordinator.quiesceActorForStop({
              callerActorId: rootActorId,
              actorId: spawned.actor.id,
            }), "actor_busy");
          }
          expect(value.authority.readActor(spawned.actor.id)?.state).toBe("active");
          expect(value.provider.interrupts).toHaveLength(0);
        } finally {
          value.database.close();
        }
      },
    ), { numRuns: 20 });
  }, 10_000);
});
