import { z } from "@hra-internal/schema";

import { AccountServiceError } from "../accounts/account-service";
import {
  SessionHarnessActorRecoveryErrorV2,
  SessionServiceError,
  type SessionHarnessActorRecoveryFailureV2,
  type SessionHarnessModelCatalog,
  type SessionHarnessActorThreadResumeRequest,
  type SessionHarnessActorThreadResumeResult,
} from "../sessions/session-service";
import {
  actorSessionBindingRecordV2Schema,
  actorSessionQuarantineReasonV2Schema,
  actorSessionRecoveryProofV2Schema,
  HarnessSQLiteAuthorityV2Error,
  type ActorSessionBindingRecordV2,
  type ActorSessionRecoveryProofV2,
} from "./sqlite-authority-v2";

const RECOVERY_PAGE_SIZE = 64;
const MAX_RECOVERY_PAGES = 128;
const DEFAULT_RECOVERY_CONCURRENCY = 8;
const DEFAULT_RECOVERY_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_RECOVERY_RETRY_MILLISECONDS = 5_000;
const MAX_RECOVERY_CONCURRENCY = 32;

type RecoveryDisposition =
  | "recovered"
  | "quarantined"
  | "deferred_account"
  | "deferred_binding"
  | "terminal";

interface RecoveryAccountGroup {
  readonly accountProfileId: string;
  readonly bindings: readonly ActorSessionBindingRecordV2[];
}

export interface HarnessActorSessionRecoveryTimerV2 {
  cancel(): void;
}

export interface HarnessActorSessionRecoverySchedulerV2 {
  monotonicNow(): number;
  schedule(
    callback: () => void,
    delayMilliseconds: number,
  ): HarnessActorSessionRecoveryTimerV2;
}

export interface HarnessActorSessionRecoveryAuthorityPortV2 {
  readActorSessionBinding(
    incarnationId: string,
  ): ActorSessionBindingRecordV2 | null;
  listRecoverableActorSessions(input: Readonly<{
    afterIncarnationId?: string | null;
    limit: number;
  }>): readonly ActorSessionBindingRecordV2[];
  advanceActorSessionBinding(input: Readonly<{
    incarnationId: string;
    expectedRevision: number;
    expectedLiveGeneration: number;
    liveCapabilityEvidence: Readonly<{
      evidenceDigest: string;
      supportsFast: boolean;
    }>;
    recoveryProof: ActorSessionRecoveryProofV2;
    now?: string;
  }>): ActorSessionBindingRecordV2;
  quarantineActorSessionBinding(input: Readonly<{
    incarnationId: string;
    expectedRevision: number;
    reason: z.infer<typeof actorSessionQuarantineReasonV2Schema>;
    now?: string;
  }>): ActorSessionBindingRecordV2;
}

/** Starts or reuses exactly one account runtime and returns its durable generation. */
export interface HarnessActorSessionAccountRuntimePortV2 {
  ensureExactActorAccountRuntime(input: Readonly<{
    accountProfileId: string;
    admissionGeneration: number;
    previousLiveGeneration: number;
  }>): Promise<Readonly<{ generation: number }>>;
}

export interface HarnessActorSessionGatewayPortV2 {
  readHarnessModelCatalog(
    accountProfileId: string,
    expectedGeneration: number,
  ): Promise<SessionHarnessModelCatalog>;
  resumeHarnessActorThread(
    request: SessionHarnessActorThreadResumeRequest,
  ): Promise<SessionHarnessActorThreadResumeResult>;
}

/** Distinct boot phase: chat bootstrap -> actor sessions -> actors -> liveness. */
export interface HarnessActorSessionRecoveryLifecyclePortV2 {
  recoverActorSessions(): Promise<HarnessActorSessionRecoveryReportV2>;
  close(): Promise<void>;
}

/** Exact in-memory admission fence rebuilt from durable bindings on each boot. */
export interface HarnessActorSessionReadinessPortV2 {
  isActorSessionReady(incarnationId: string): boolean;
}

export interface HarnessActorSessionRecoveryReportV2 {
  readonly recoveredIncarnationIds: readonly string[];
  readonly quarantinedIncarnationIds: readonly string[];
  readonly deferredIncarnationIds: readonly string[];
}

export interface HarnessActorSessionRecoveryV2Options {
  readonly accounts: HarnessActorSessionAccountRuntimePortV2;
  readonly authority: HarnessActorSessionRecoveryAuthorityPortV2;
  readonly sessions: HarnessActorSessionGatewayPortV2;
  readonly now?: () => Date;
  readonly concurrency?: number;
  readonly recoveryTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly scheduler?: HarnessActorSessionRecoverySchedulerV2;
  readonly onIncarnationReady?: (incarnationId: string) => void;
  readonly onFatalFailure?: (error: Error) => void;
}

export class HarnessActorSessionRecoveryV2Error extends Error {
  readonly code: "capacity_exceeded" | "conflict" | "unavailable";

  constructor(
    code: HarnessActorSessionRecoveryV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessActorSessionRecoveryV2Error";
    this.code = code;
  }
}

/**
 * Restores only generation-local routing. It never launches a turn, starts a
 * timer, opens renderer admission, or reconciles actor effects. A durable
 * binding advances only after SessionService has installed both registries.
 */
export class HarnessActorSessionRecoveryV2
  implements
    HarnessActorSessionRecoveryLifecyclePortV2,
    HarnessActorSessionReadinessPortV2 {
  readonly #accounts: HarnessActorSessionAccountRuntimePortV2;
  readonly #authority: HarnessActorSessionRecoveryAuthorityPortV2;
  readonly #sessions: HarnessActorSessionGatewayPortV2;
  readonly #now: () => Date;
  readonly #concurrency: number;
  readonly #recoveryTimeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #scheduler: HarnessActorSessionRecoverySchedulerV2;
  readonly #onIncarnationReady: (incarnationId: string) => void;
  readonly #onFatalFailure: (error: Error) => void;
  readonly #deferred = new Map<string, ActorSessionBindingRecordV2>();
  readonly #detachedIncarnationIds = new Set<string>();
  readonly #inFlight = new Map<string, Promise<RecoveryDisposition>>();
  readonly #unreadyIncarnationIds = new Set<string>();
  readonly #retryCursorAfterIncarnationByAccount = new Map<string, string>();
  #retryTimer: HarnessActorSessionRecoveryTimerV2 | null = null;
  #retryPass: Promise<void> | null = null;
  #retryCursorAfterAccountProfileId: string | null = null;
  #closePromise: Promise<void> | null = null;
  #fatalFailure: Error | null = null;
  #fatalFailurePublished = false;
  #closed = false;

  constructor(options: HarnessActorSessionRecoveryV2Options) {
    this.#accounts = options.accounts;
    this.#authority = options.authority;
    this.#sessions = options.sessions;
    this.#now = options.now ?? (() => new Date());
    this.#concurrency = boundedInteger(
      options.concurrency ?? DEFAULT_RECOVERY_CONCURRENCY,
      1,
      MAX_RECOVERY_CONCURRENCY,
      "concurrency",
    );
    this.#recoveryTimeoutMs = boundedInteger(
      options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MILLISECONDS,
      1,
      60_000,
      "recoveryTimeoutMs",
    );
    this.#retryDelayMs = boundedInteger(
      options.retryDelayMs ?? DEFAULT_RECOVERY_RETRY_MILLISECONDS,
      1,
      60_000,
      "retryDelayMs",
    );
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#onIncarnationReady = options.onIncarnationReady ?? (() => undefined);
    this.#onFatalFailure = options.onFatalFailure ?? (() => undefined);
  }

  isActorSessionReady(incarnationId: string): boolean {
    return !this.#unreadyIncarnationIds.has(incarnationId);
  }

  async recoverActorSessions(): Promise<HarnessActorSessionRecoveryReportV2> {
    if (this.#fatalFailure !== null) throw this.#fatalFailure;
    if (this.#closed) {
      throw new HarnessActorSessionRecoveryV2Error(
        "unavailable",
        "Actor-session recovery is closed.",
      );
    }
    const bindings: ActorSessionBindingRecordV2[] = [];
    let afterIncarnationId: string | null = null;
    for (let page = 0; page < MAX_RECOVERY_PAGES; page += 1) {
      const pageBindings: ActorSessionBindingRecordV2[] =
        this.#authority.listRecoverableActorSessions({
        afterIncarnationId,
        limit: RECOVERY_PAGE_SIZE,
      }).map((binding) => actorSessionBindingRecordV2Schema.parse(binding));
      if (pageBindings.length === 0) return await this.#recoverBatch(bindings);
      bindings.push(...pageBindings);
      afterIncarnationId = pageBindings.at(-1)!.incarnationId;
      if (pageBindings.length < RECOVERY_PAGE_SIZE) {
        return await this.#recoverBatch(bindings);
      }
    }
    throw new HarnessActorSessionRecoveryV2Error(
      "capacity_exceeded",
      "Actor-session recovery exceeded its durable page bound.",
    );
  }

  /** Stops detached retry admission before the control-plane database closes. */
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
    this.#deferred.clear();
    const operations = [...this.#inFlight.values()];
    if (this.#retryPass !== null) operations.push(this.#retryPass.then(() => "terminal"));
    this.#closePromise = Promise.all(operations).then(() => {
      if (this.#fatalFailure !== null) throw this.#fatalFailure;
    });
    return this.#closePromise;
  }

  async #recoverBatch(
    bindings: readonly ActorSessionBindingRecordV2[],
    publishFatalFailures = false,
  ): Promise<HarnessActorSessionRecoveryReportV2> {
    const recoveredIncarnationIds: string[] = [];
    const quarantinedIncarnationIds: string[] = [];
    const deferredIncarnationIds: string[] = [];
    for (const binding of bindings) {
      this.#unreadyIncarnationIds.add(binding.incarnationId);
    }
    if (bindings.length === 0) {
      return recoveryReport(
        recoveredIncarnationIds,
        quarantinedIncarnationIds,
        deferredIncarnationIds,
      );
    }

    // One account is one serial lane. Distinct account lanes recover in
    // parallel, so a wedged subscription cannot monopolize every worker.
    const groups = new Map<string, ActorSessionBindingRecordV2[]>();
    for (const binding of bindings) {
      const group = groups.get(binding.accountProfileId) ?? [];
      group.push(binding);
      groups.set(binding.accountProfileId, group);
    }
    const sortedAccountGroups = [...groups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([accountProfileId, group]) => Object.freeze({
        accountProfileId,
        bindings: rotateAfterIncarnation(
          group.toSorted((left, right) =>
            left.incarnationId.localeCompare(right.incarnationId)),
          this.#retryCursorAfterIncarnationByAccount.get(accountProfileId) ??
            null,
        ),
      }));
    const accountGroups = rotateAfterAccount(
      sortedAccountGroups,
      this.#retryCursorAfterAccountProfileId,
    );
    const passDeadline = this.#monotonicNow() + this.#recoveryTimeoutMs;
    const accountSliceMilliseconds = Math.max(1, Math.floor(
      this.#recoveryTimeoutMs /
        Math.max(1, Math.ceil(accountGroups.length / this.#concurrency)),
    ));
    let nextGroup = 0;
    const worker = async (): Promise<void> => {
      while (!this.#closed) {
        const groupIndex = nextGroup;
        const group = accountGroups[groupIndex];
        if (group === undefined) return;
        nextGroup += 1;
        const accountDeadline = Math.min(
          passDeadline,
          this.#monotonicNow() + accountSliceMilliseconds,
        );
        for (let index = 0; index < group.bindings.length; index += 1) {
          if (this.#closed) return;
          const binding = group.bindings[index]!;
          const remaining = Math.max(
            0,
            accountDeadline - this.#monotonicNow(),
          );
          if (remaining === 0) {
            for (const deferred of group.bindings.slice(index)) {
              this.#recordDeferredIfCurrent(deferred);
              deferredIncarnationIds.push(deferred.incarnationId);
            }
            return;
          }
          this.#retryCursorAfterIncarnationByAccount.set(
            group.accountProfileId,
            binding.incarnationId,
          );
          const disposition = await within(
            this.#attempt(binding, publishFatalFailures),
            remaining,
            () => this.#detachedIncarnationIds.add(binding.incarnationId),
          );
          if (disposition === "timed_out") {
            this.#recordDeferredIfCurrent(binding);
            deferredIncarnationIds.push(binding.incarnationId);
            for (const deferred of group.bindings.slice(index + 1)) {
              this.#recordDeferredIfCurrent(deferred);
              deferredIncarnationIds.push(deferred.incarnationId);
            }
            // The exact promise remains tracked and may complete later. Do not
            // let one detached call launch further account work in this pass.
            return;
          }
          if (disposition === "recovered") {
            recoveredIncarnationIds.push(binding.incarnationId);
          } else if (disposition === "quarantined") {
            quarantinedIncarnationIds.push(binding.incarnationId);
          } else if (
            disposition === "deferred_account" ||
            disposition === "deferred_binding"
          ) {
            deferredIncarnationIds.push(binding.incarnationId);
            if (disposition === "deferred_account") {
              for (const deferred of group.bindings.slice(index + 1)) {
                this.#recordDeferredIfCurrent(deferred);
                deferredIncarnationIds.push(deferred.incarnationId);
              }
              break;
            }
          }
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.#concurrency, accountGroups.length) },
      () => worker(),
    ));
    if (nextGroup > 0) {
      this.#retryCursorAfterAccountProfileId =
        accountGroups[nextGroup - 1]!.accountProfileId;
    }
    for (const group of accountGroups.slice(nextGroup)) {
      for (const binding of group.bindings) {
        this.#recordDeferredIfCurrent(binding);
        deferredIncarnationIds.push(binding.incarnationId);
      }
    }
    this.#armRetry();
    return recoveryReport(
      recoveredIncarnationIds,
      quarantinedIncarnationIds,
      deferredIncarnationIds,
    );
  }

  #attempt(
    binding: ActorSessionBindingRecordV2,
    publishFatalFailure: boolean,
  ): Promise<RecoveryDisposition> {
    if (this.#closed) return Promise.resolve("terminal");
    const current = this.#readCurrentBinding(binding);
    if (current === null) {
      const wasDeferred = this.#deferred.delete(binding.incarnationId);
      this.#markIncarnationReady(binding.incarnationId, wasDeferred);
      this.#disarmRetryIfIdle();
      return Promise.resolve("terminal");
    }
    const existing = this.#inFlight.get(binding.incarnationId);
    if (existing !== undefined) return existing;
    const operation = this.#recoverOne(current);
    this.#inFlight.set(binding.incarnationId, operation);
    void operation.then((disposition) => {
      if (this.#inFlight.get(binding.incarnationId) === operation) {
        this.#inFlight.delete(binding.incarnationId);
      }
      if (this.#closed) return;
      const wasDetached = this.#detachedIncarnationIds.has(
        binding.incarnationId,
      );
      if (
        disposition === "deferred_account" ||
        disposition === "deferred_binding"
      ) {
        try {
          this.#recordDeferredIfCurrent(current);
        } catch (cause: unknown) {
          this.#recordFatalFailure(
            cause,
            publishFatalFailure || wasDetached,
          );
          return;
        }
      } else {
        const wasDeferred = this.#deferred.delete(binding.incarnationId);
        this.#markIncarnationReady(binding.incarnationId, wasDeferred);
        this.#disarmRetryIfIdle();
      }
      this.#detachedIncarnationIds.delete(binding.incarnationId);
      this.#armRetry();
    }, (cause: unknown) => {
      if (this.#inFlight.get(binding.incarnationId) === operation) {
        this.#inFlight.delete(binding.incarnationId);
      }
      this.#deferred.delete(binding.incarnationId);
      this.#recordFatalFailure(
        cause,
        publishFatalFailure ||
          this.#detachedIncarnationIds.has(binding.incarnationId),
      );
    });
    return operation;
  }

  #recordDeferredIfCurrent(binding: ActorSessionBindingRecordV2): void {
    if (this.#closed) return;
    const durable = this.#readCurrentBinding(binding);
    if (durable === null) {
      const wasDeferred = this.#deferred.delete(binding.incarnationId);
      this.#markIncarnationReady(binding.incarnationId, wasDeferred);
      this.#disarmRetryIfIdle();
      return;
    }
    this.#deferred.set(binding.incarnationId, durable);
  }

  #markIncarnationReady(incarnationId: string, wakeLiveness: boolean): void {
    if (this.#closed) return;
    if (!this.#unreadyIncarnationIds.delete(incarnationId)) return;
    if (wakeLiveness) this.#onIncarnationReady(incarnationId);
  }

  #disarmRetryIfIdle(): void {
    if (this.#deferred.size !== 0 || this.#retryPass !== null) return;
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
  }

  #readCurrentBinding(
    binding: ActorSessionBindingRecordV2,
  ): ActorSessionBindingRecordV2 | null {
    const currentValue = this.#authority.readActorSessionBinding(
      binding.incarnationId,
    );
    if (currentValue === null) return null;
    const current = actorSessionBindingRecordV2Schema.parse(currentValue);
    if (current.state !== "bound" || current.revision !== binding.revision) {
      return null;
    }
    if (!sameRecoveryBindingLineage(current, binding)) {
      throw new HarnessActorSessionRecoveryV2Error(
        "conflict",
        "Actor-session recovery binding identity changed without a revision.",
      );
    }
    return current;
  }

  #armRetry(): void {
    if (
      this.#closed || this.#fatalFailure !== null ||
      this.#retryTimer !== null || this.#retryPass !== null ||
      this.#deferred.size === 0
    ) return;
    this.#retryTimer = this.#scheduler.schedule(() => {
      this.#retryTimer = null;
      if (this.#closed || this.#deferred.size === 0) return;
      const bindings = [...this.#deferred.values()];
      const pass = this.#recoverBatch(bindings, true).then(() => undefined);
      this.#retryPass = pass;
      void pass.catch((cause: unknown) => {
        this.#recordFatalFailure(cause, true);
      }).finally(() => {
        if (this.#retryPass === pass) this.#retryPass = null;
        this.#armRetry();
      });
    }, this.#retryDelayMs);
  }

  #monotonicNow(): number {
    const observed = this.#scheduler.monotonicNow();
    if (!Number.isFinite(observed) || observed < 0) {
      throw new RangeError(
        "Actor-session recovery clock must be finite and nonnegative.",
      );
    }
    return observed;
  }

  #recordFatalFailure(cause: unknown, publish: boolean): void {
    this.#fatalFailure ??= normalizeFailure(cause);
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
    if (!publish || this.#fatalFailurePublished) return;
    this.#fatalFailurePublished = true;
    try {
      this.#onFatalFailure(this.#fatalFailure);
    } catch {
      // The sticky original failure remains authoritative. A recovery sink is
      // only a process-level escape hatch and cannot replace durable evidence.
    }
  }

  async #recoverOne(
    binding: ActorSessionBindingRecordV2,
  ): Promise<RecoveryDisposition> {
    if (this.#closed) return "terminal";
    let runtime: Readonly<{ generation: number }>;
    try {
      runtime = await this.#accounts.ensureExactActorAccountRuntime({
        accountProfileId: binding.accountProfileId,
        admissionGeneration: binding.admissionGeneration,
        previousLiveGeneration: binding.liveGeneration,
      });
    } catch (cause: unknown) {
      const disposition = classifyAccountFailure(cause);
      if (disposition === "quarantine") {
        return this.#quarantine(binding, "recovery_protocol_error");
      }
      if (disposition === "defer") return "deferred_account";
      throw cause;
    }
    if (this.#closed) return "terminal";
    const generation = z.number().int().positive().safe().parse(
      runtime.generation,
    );
    if (generation < binding.liveGeneration) {
      return this.#quarantine(binding, "generation_regression");
    }
    if (this.#closed) return "terminal";

    let catalog: SessionHarnessModelCatalog;
    try {
      catalog = await this.#sessions.readHarnessModelCatalog(
        binding.accountProfileId,
        generation,
      );
    } catch (cause: unknown) {
      if (cause instanceof SessionServiceError && !cause.retryable) {
        return this.#quarantine(binding, "recovery_protocol_error");
      }
      if (cause instanceof SessionServiceError && cause.retryable) {
        return "deferred_binding";
      }
      throw cause;
    }
    if (this.#closed) return "terminal";
    const capability = exactRecoveredCapability(binding, catalog, generation);
    if (capability === null) {
      return this.#quarantine(binding, "recovery_protocol_error");
    }
    const legacyCapabilityBootstrap =
      binding.capabilityEvidenceDigest === null &&
      binding.supportsFast === null &&
      binding.liveCapabilityEvidenceDigest === null &&
      binding.liveSupportsFast === null &&
      binding.revision === 1 && binding.recoveredAt === null;
    if (
      generation === binding.liveGeneration &&
      (capability.evidenceDigest !== binding.liveCapabilityEvidenceDigest ||
        capability.supportsFast !== binding.liveSupportsFast) &&
      !legacyCapabilityBootstrap
    ) {
      return this.#quarantine(binding, "recovery_protocol_error");
    }

    let resumed: SessionHarnessActorThreadResumeResult;
    try {
      resumed = await this.#sessions.resumeHarnessActorThread({
        accountProfileId: binding.accountProfileId,
        actorId: binding.actorId,
        admissionGeneration: binding.admissionGeneration,
        expectedGeneration: generation,
        model: binding.modelId,
        previousRecoveryProofDigest:
          binding.recoveryProof.recoveryProofDigest,
        providerThreadId: binding.providerThreadId,
        reasoningEffort: binding.reasoningEffort,
        threadSource: binding.threadSource,
        title: binding.actorTitle,
        workspaceMode: binding.workspaceMode,
        workspacePath: binding.workspacePath,
      });
    } catch (cause: unknown) {
      if (cause instanceof SessionHarnessActorRecoveryErrorV2) {
        return this.#quarantine(binding, quarantineReason(cause.recoveryFailure));
      }
      if (cause instanceof SessionServiceError && !cause.retryable) {
        return this.#quarantine(binding, "recovery_protocol_error");
      }
      if (cause instanceof SessionServiceError && cause.retryable) {
        return "deferred_binding";
      }
      throw cause;
    }
    if (this.#closed) return "terminal";
    const proof = actorSessionRecoveryProofV2Schema.parse(resumed.recoveryProof);
    if (
      resumed.admissionGeneration !== binding.admissionGeneration ||
      resumed.generation !== generation ||
      resumed.providerThreadId !== binding.providerThreadId ||
      resumed.observedProfile.modelId !== binding.modelId ||
      resumed.observedProfile.reasoningEffort !== binding.reasoningEffort ||
      proof.observationGeneration !== generation ||
      proof.priorRecoveryProofDigest !==
        binding.recoveryProof.recoveryProofDigest ||
      proof.recoveryProofDigest ===
        binding.recoveryProof.recoveryProofDigest
    ) {
      return this.#quarantine(binding, "recovery_protocol_error");
    }
    if (this.#closed) return "terminal";
    if (this.#readCurrentBinding(binding) === null) return "terminal";
    try {
      this.#authority.advanceActorSessionBinding({
        incarnationId: binding.incarnationId,
        expectedRevision: binding.revision,
        expectedLiveGeneration: binding.liveGeneration,
        liveCapabilityEvidence: capability,
        recoveryProof: proof,
        now: this.#now().toISOString(),
      });
    } catch (cause: unknown) {
      if (!(cause instanceof HarnessSQLiteAuthorityV2Error)) throw cause;
      if (
        cause.code === "conflict" &&
        cause.message ===
          "actor session recovery generation is not the durable account generation"
      ) {
        return this.#readCurrentBinding(binding) === null
          ? "terminal"
          : "deferred_account";
      }
      if (cause.code === "revision_conflict" || cause.code === "not_found") {
        if (this.#readCurrentBinding(binding) === null) return "terminal";
      }
      throw cause;
    }
    return "recovered";
  }

  #quarantine(
    binding: ActorSessionBindingRecordV2,
    reason: z.infer<typeof actorSessionQuarantineReasonV2Schema>,
  ): "quarantined" | "terminal" {
    if (this.#closed) return "terminal";
    if (this.#readCurrentBinding(binding) === null) return "terminal";
    this.#authority.quarantineActorSessionBinding({
      incarnationId: binding.incarnationId,
      expectedRevision: binding.revision,
      reason,
      now: this.#now().toISOString(),
    });
    return "quarantined";
  }
}

function quarantineReason(
  failure: SessionHarnessActorRecoveryFailureV2,
): z.infer<typeof actorSessionQuarantineReasonV2Schema> {
  return actorSessionQuarantineReasonV2Schema.parse(failure);
}

function exactRecoveredCapability(
  binding: ActorSessionBindingRecordV2,
  catalogValue: SessionHarnessModelCatalog,
  generation: number,
): Readonly<{ evidenceDigest: string; supportsFast: boolean }> | null {
  const catalog = z.object({
    evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    generation: z.number().int().positive().safe(),
    models: z.array(z.object({
      modelId: z.string().min(1).max(128),
      reasoningEfforts: z.array(z.string().min(1).max(32)).max(16),
      serviceTiers: z.array(z.string().min(1).max(32)).max(16),
    }).strict()).max(2_048),
  }).strict().safeParse(catalogValue);
  if (!catalog.success || catalog.data.generation !== generation) return null;
  const candidates = catalog.data.models.filter(
    ({ modelId }) => modelId === binding.modelId,
  );
  if (
    candidates.length !== 1 ||
    !candidates[0]!.reasoningEfforts.includes(binding.reasoningEffort)
  ) return null;
  return Object.freeze({
    evidenceDigest: catalog.data.evidenceDigest,
    supportsFast: candidates[0]!.serviceTiers.includes("fast"),
  });
}

function classifyAccountFailure(
  cause: unknown,
): "defer" | "quarantine" | "unclassified" {
  if (!(cause instanceof AccountServiceError)) return "unclassified";
  if (!cause.retryable && cause.code === "not_found") return "quarantine";
  if (
    cause.retryable ||
    (cause.code === "capability_unavailable" && cause.action === "signIn")
  ) return "defer";
  return "unclassified";
}

function sameRecoveryBindingLineage(
  left: ActorSessionBindingRecordV2,
  right: ActorSessionBindingRecordV2,
): boolean {
  return left.incarnationId === right.incarnationId &&
    left.actorId === right.actorId &&
    left.workspaceBindingId === right.workspaceBindingId &&
    left.workspaceLaneId === right.workspaceLaneId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceMode === right.workspaceMode &&
    left.accountProfileId === right.accountProfileId &&
    left.admissionGeneration === right.admissionGeneration &&
    left.liveGeneration === right.liveGeneration &&
    left.liveCapabilityEvidenceDigest ===
      right.liveCapabilityEvidenceDigest &&
    left.liveSupportsFast === right.liveSupportsFast &&
    left.providerThreadId === right.providerThreadId &&
    left.threadSource === right.threadSource &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort &&
    left.capabilityEvidenceDigest === right.capabilityEvidenceDigest &&
    left.supportsFast === right.supportsFast &&
    left.recoveryProof.recoveryProofDigest ===
      right.recoveryProof.recoveryProofDigest &&
    left.recoveryProof.priorRecoveryProofDigest ===
      right.recoveryProof.priorRecoveryProofDigest &&
    left.recoveryProof.observationGeneration ===
      right.recoveryProof.observationGeneration &&
    left.recoveryProof.historyEvidenceDigest ===
      right.recoveryProof.historyEvidenceDigest &&
    left.recoveryProof.firstObservationPosition ===
      right.recoveryProof.firstObservationPosition &&
    left.recoveryProof.secondObservationPosition ===
      right.recoveryProof.secondObservationPosition &&
    left.recoveryProof.historyTurnCount ===
      right.recoveryProof.historyTurnCount &&
    left.recoveryProof.historyItemCount ===
      right.recoveryProof.historyItemCount &&
    left.createdAt === right.createdAt;
}

function recoveryReport(
  recoveredIncarnationIds: readonly string[],
  quarantinedIncarnationIds: readonly string[],
  deferredIncarnationIds: readonly string[],
): HarnessActorSessionRecoveryReportV2 {
  return Object.freeze({
    recoveredIncarnationIds: Object.freeze([...new Set(recoveredIncarnationIds)].toSorted()),
    quarantinedIncarnationIds: Object.freeze([
      ...new Set(quarantinedIncarnationIds),
    ].toSorted()),
    deferredIncarnationIds: Object.freeze([
      ...new Set(deferredIncarnationIds),
    ].toSorted()),
  });
}

function rotateAfterAccount(
  groups: readonly RecoveryAccountGroup[],
  cursor: string | null,
): readonly RecoveryAccountGroup[] {
  if (cursor === null || groups.length < 2) return groups;
  const start = groups.findIndex(({ accountProfileId }) =>
    accountProfileId.localeCompare(cursor) > 0);
  if (start <= 0) return groups;
  return [...groups.slice(start), ...groups.slice(0, start)];
}

function rotateAfterIncarnation(
  bindings: readonly ActorSessionBindingRecordV2[],
  cursor: string | null,
): readonly ActorSessionBindingRecordV2[] {
  if (cursor === null || bindings.length < 2) return bindings;
  const start = bindings.findIndex(({ incarnationId }) =>
    incarnationId.localeCompare(cursor) > 0);
  if (start <= 0) return bindings;
  return [...bindings.slice(start), ...bindings.slice(0, start)];
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeFailure(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new HarnessActorSessionRecoveryV2Error(
        "conflict",
        "Actor-session recovery failed with a non-Error value.",
        cause,
      );
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T | "timed_out"> {
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve("timed_out");
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const systemScheduler: HarnessActorSessionRecoverySchedulerV2 = Object.freeze({
  monotonicNow: () => performance.now(),
  schedule: (callback: () => void, delayMilliseconds: number) => {
    const timer = setTimeout(callback, delayMilliseconds);
    timer.unref?.();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  },
});
