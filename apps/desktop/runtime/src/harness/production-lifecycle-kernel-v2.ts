import { z } from "@hra-internal/schema";

const timeoutSchema = z.number().int().min(1).max(60_000);
const runIdSchema = z.string().min(1).max(96);
const quiesceReportSchema = z.object({
  requestedRunIds: z.array(runIdSchema).max(4_096),
  settledRunIds: z.array(runIdSchema).max(4_096),
  timedOutRunIds: z.array(runIdSchema).max(4_096),
}).strict().superRefine((report, context) => {
  for (const [field, values] of Object.entries(report)) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "RLM quiesce run identities must be unique",
        path: [field],
      });
    }
  }
  const requested = new Set(report.requestedRunIds);
  const settled = new Set(report.settledRunIds);
  const timedOut = new Set(report.timedOutRunIds);
  for (const runId of report.requestedRunIds) {
    if (settled.has(runId) === timedOut.has(runId)) {
      context.addIssue({
        code: "custom",
        message: "every requested RLM run must settle or time out exactly once",
        path: ["requestedRunIds"],
      });
    }
  }
  for (const runId of [...settled, ...timedOut]) {
    if (!requested.has(runId)) {
      context.addIssue({
        code: "custom",
        message: "RLM quiesce outcomes must belong to requested runs",
        path: ["requestedRunIds"],
      });
    }
  }
});

const actorSessionRecoveryReportSchema = z.object({
  recoveredIncarnationIds: z.array(z.string().min(1).max(96)).max(8_192),
  quarantinedIncarnationIds: z.array(z.string().min(1).max(96)).max(8_192),
  deferredIncarnationIds: z.array(z.string().min(1).max(96)).max(8_192),
}).strict();

type MaybePromise<T> = T | Promise<T>;

export interface HarnessContextRecoveryLifecyclePortV2 {
  recover(): MaybePromise<unknown>;
}

export interface HarnessChatRecoveryLifecyclePortV2 {
  recoverInterruptedAfterRootRecovery(): MaybePromise<unknown>;
  activateLiveness(): MaybePromise<unknown>;
}

export interface HarnessProposalRecoveryLifecyclePortV2 {
  recover(): MaybePromise<unknown>;
}

export interface HarnessPersistentActorLifecyclePortV2 {
  /** Materialize/reconcile thread admissions only; never start an actor turn. */
  reconcileSessionAdmissions(): MaybePromise<unknown>;
  reconcile(): MaybePromise<unknown>;
}

interface HarnessActorSessionRecoveryReportPortV2 {
  readonly recoveredIncarnationIds: readonly string[];
  readonly quarantinedIncarnationIds: readonly string[];
  readonly deferredIncarnationIds: readonly string[];
}

export interface HarnessActorSessionRecoveryLifecyclePortV2 {
  recoverActorSessions(): MaybePromise<HarnessActorSessionRecoveryReportPortV2>;
  close(): Promise<void>;
}

export interface HarnessProgramAdmissionLifecyclePortV2 {
  recover(): MaybePromise<unknown>;
}

export interface HarnessRlmLifecyclePortV2 {
  reconcileOnBoot(): MaybePromise<unknown>;
  quiesce(timeoutMs: number): Promise<unknown>;
}

/**
 * `included` is the exact contract implemented by the actor projection
 * reconciler: `reconcileAll` refreshes the renderer after every witness is
 * durable. `excluded` is available only for an adapter whose reconciliation
 * deliberately omits refresh, in which case this kernel initializes it once.
 */
export type HarnessActorProjectionLifecyclePortV2 = Readonly<{
  rendererRefresh: "included" | "excluded";
  reconcileAll(): MaybePromise<unknown>;
  settled(): Promise<void>;
}>;

export interface HarnessRendererLifecyclePortV2 {
  initialize(): Promise<void>;
  settled(): Promise<void>;
}

/**
 * `closeAdmission` synchronously closes new work while response-channel
 * routing remains live long enough to settle every provider callback.
 */
export interface HarnessDynamicToolLifecyclePortV2 {
  openAdmissionAfterRecovery(): void;
  closeAdmission(): void;
  settled(): Promise<unknown>;
}

export interface HarnessPersistentActorLivenessLifecyclePortV2 {
  close(): Promise<void>;
}

export interface HarnessKeyCustodyLifecyclePortV2 {
  quiesceForExternalDeletion(): Promise<void>;
}

/** Root admission and provider terminal observation close in separate phases. */
export interface HarnessRootSessionLifecyclePortV2 {
  reconcileOnBoot(): Promise<unknown>;
  closeAdmission(): void;
  closeObservation(): void;
  settled(): Promise<void>;
}

export type HarnessProductionLifecycleKernelV2State =
  | "created"
  | "initializing"
  | "ready"
  | "initializationFailed"
  | "shuttingDown"
  | "stopped"
  | "shutdownFailed";

export interface HarnessProductionLifecycleBootReportV2 {
  readonly rendererInitialized: boolean;
  readonly rendererRefreshedByProjection: boolean;
}

export interface HarnessProductionLifecycleShutdownReportV2 {
  readonly databaseClosePermitted: true;
  readonly timedOutRunIds: readonly [];
}

export interface HarnessProductionLifecyclePreProviderStopReportV2 {
  readonly providerStopPermitted: true;
  readonly timedOutRunIds: readonly [];
}

export class HarnessProductionLifecycleKernelV2Error extends Error {
  readonly code:
    | "initialization_cancelled"
    | "initialization_failed"
    | "invalid_state"
    | "rlm_quiesce_timeout"
    | "shutdown_failed";
  readonly timedOutRunIds: readonly string[];

  constructor(
    code: HarnessProductionLifecycleKernelV2Error["code"],
    options: Readonly<{
      cause?: unknown;
      timedOutRunIds?: readonly string[];
    }> = {},
  ) {
    super(messageFor(code), options.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "HarnessProductionLifecycleKernelV2Error";
    this.code = code;
    this.timedOutRunIds = Object.freeze([...(options.timedOutRunIds ?? [])]);
  }
}

export interface HarnessProductionLifecycleKernelV2Options {
  readonly contexts: HarnessContextRecoveryLifecyclePortV2;
  readonly proposals: HarnessProposalRecoveryLifecyclePortV2;
  readonly chat: HarnessChatRecoveryLifecyclePortV2;
  readonly actorSessions: HarnessActorSessionRecoveryLifecyclePortV2;
  readonly actors: HarnessPersistentActorLifecyclePortV2;
  readonly programAdmissions: HarnessProgramAdmissionLifecyclePortV2;
  readonly rlm: HarnessRlmLifecyclePortV2;
  readonly projections: HarnessActorProjectionLifecyclePortV2;
  readonly renderer: HarnessRendererLifecyclePortV2;
  readonly dynamicTools: HarnessDynamicToolLifecyclePortV2;
  readonly rootSessions: HarnessRootSessionLifecyclePortV2;
  readonly liveness: HarnessPersistentActorLivenessLifecyclePortV2;
  readonly keyCustody: HarnessKeyCustodyLifecyclePortV2;
  readonly rlmQuiesceTimeoutMs?: number;
}

/** Owns the complete ordering barrier before SQLite may be closed. */
export class HarnessProductionLifecycleKernelV2 {
  readonly #contexts: HarnessContextRecoveryLifecyclePortV2;
  readonly #proposals: HarnessProposalRecoveryLifecyclePortV2;
  readonly #chat: HarnessChatRecoveryLifecyclePortV2;
  readonly #actorSessions: HarnessActorSessionRecoveryLifecyclePortV2;
  readonly #actors: HarnessPersistentActorLifecyclePortV2;
  readonly #programAdmissions: HarnessProgramAdmissionLifecyclePortV2;
  readonly #rlm: HarnessRlmLifecyclePortV2;
  readonly #projections: HarnessActorProjectionLifecyclePortV2;
  readonly #renderer: HarnessRendererLifecyclePortV2;
  readonly #dynamicTools: HarnessDynamicToolLifecyclePortV2;
  readonly #rootSessions: HarnessRootSessionLifecyclePortV2;
  readonly #liveness: HarnessPersistentActorLivenessLifecyclePortV2;
  readonly #keyCustody: HarnessKeyCustodyLifecyclePortV2;
  readonly #rlmQuiesceTimeoutMs: number;
  #state: HarnessProductionLifecycleKernelV2State = "created";
  #initialization: Promise<HarnessProductionLifecycleBootReportV2> | null = null;
  #preProviderStop:
    Promise<HarnessProductionLifecyclePreProviderStopReportV2> | null = null;
  #shutdown: Promise<HarnessProductionLifecycleShutdownReportV2> | null = null;
  readonly #admissionCloseFailures: unknown[] = [];
  readonly #terminalCloseFailures: unknown[] = [];
  #admissionsClosed = false;
  #terminalSourcesClosed = false;
  #providerSourcesStopped = false;
  #providerStopPermitted = false;
  #livenessDrain: Promise<void> | null = null;
  #shutdownRequested = false;
  #databaseClosePermitted = false;

  constructor(options: HarnessProductionLifecycleKernelV2Options) {
    this.#contexts = options.contexts;
    this.#proposals = options.proposals;
    this.#chat = options.chat;
    this.#actorSessions = options.actorSessions;
    this.#actors = options.actors;
    this.#programAdmissions = options.programAdmissions;
    this.#rlm = options.rlm;
    this.#projections = options.projections;
    this.#renderer = options.renderer;
    this.#dynamicTools = options.dynamicTools;
    this.#rootSessions = options.rootSessions;
    this.#liveness = options.liveness;
    this.#keyCustody = options.keyCustody;
    this.#rlmQuiesceTimeoutMs = timeoutSchema.parse(
      options.rlmQuiesceTimeoutMs ?? 5_000,
    );
  }

  get state(): HarnessProductionLifecycleKernelV2State {
    return this.#state;
  }

  get databaseClosePermitted(): boolean {
    return this.#databaseClosePermitted;
  }

  initialize(): Promise<HarnessProductionLifecycleBootReportV2> {
    if (this.#initialization !== null) return this.#initialization;
    if (
      this.#state !== "created" || this.#shutdownRequested ||
      this.#admissionsClosed
    ) {
      this.#initialization = Promise.reject(
        new HarnessProductionLifecycleKernelV2Error("invalid_state"),
      );
      return this.#initialization;
    }
    this.#state = "initializing";
    this.#initialization = this.#boot();
    return this.#initialization;
  }

  shutdown(): Promise<HarnessProductionLifecycleShutdownReportV2> {
    if (this.#shutdown !== null) return this.#shutdown;
    if (!this.#providerStopPermitted || !this.#providerSourcesStopped) {
      return Promise.reject(
        new HarnessProductionLifecycleKernelV2Error("invalid_state"),
      );
    }
    this.#shutdownRequested = true;
    this.#state = "shuttingDown";
    this.#closeTerminalSources();
    this.#shutdown = this.#stop();
    return this.#shutdown;
  }

  /**
   * Records the external boundary that owns Codex process termination. The
   * kernel keeps terminal observation open until Main has stopped every account
   * runtime, then shutdown may close and drain those consumers.
   */
  providerSourcesStopped(): void {
    if (!this.#providerStopPermitted) {
      throw new HarnessProductionLifecycleKernelV2Error("invalid_state");
    }
    if (this.#providerSourcesStopped) return;
    this.#providerSourcesStopped = true;
  }

  /**
   * Stops every producer that can initiate a new Codex effect, but deliberately
   * leaves terminal provider observation and dynamic-tool response routing
   * open. Main must await this barrier before stopping account runtimes.
   */
  preProviderStop(): Promise<HarnessProductionLifecyclePreProviderStopReportV2> {
    if (this.#preProviderStop !== null) return this.#preProviderStop;
    if (this.#providerSourcesStopped || this.#shutdown !== null) {
      this.#preProviderStop = Promise.reject(
        new HarnessProductionLifecycleKernelV2Error("invalid_state"),
      );
      return this.#preProviderStop;
    }
    this.#shutdownRequested = true;
    this.#state = "shuttingDown";
    this.closeAdmissions();
    this.#preProviderStop = this.#prepareProviderStop();
    return this.#preProviderStop;
  }

  /**
   * Phase one of shutdown. Call this before stopping provider event sources;
   * already-admitted root turns may still consume their terminal facts.
   */
  closeAdmissions(): void {
    if (this.#admissionsClosed) return;
    this.#admissionsClosed = true;
    collectSynchronous(
      () => this.#rootSessions.closeAdmission(),
      this.#admissionCloseFailures,
    );
    collectSynchronous(
      () => this.#dynamicTools.closeAdmission(),
      this.#admissionCloseFailures,
    );
  }

  async #boot(): Promise<HarnessProductionLifecycleBootReportV2> {
    try {
      await this.#contexts.recover();
      this.#requireBootMayContinue();
      await this.#proposals.recover();
      this.#requireBootMayContinue();
      await this.#rootSessions.reconcileOnBoot();
      this.#requireBootMayContinue();
      await this.#chat.recoverInterruptedAfterRootRecovery();
      this.#requireBootMayContinue();
      await this.#actors.reconcileSessionAdmissions();
      this.#requireBootMayContinue();
      actorSessionRecoveryReportSchema.parse(
        await this.#actorSessions.recoverActorSessions(),
      );
      this.#requireBootMayContinue();
      // Coordinator readiness is exact per incarnation: this pass advances
      // every healthy lineage while deferred sessions stay provider-fenced.
      await this.#actors.reconcile();
      this.#requireBootMayContinue();
      await this.#chat.activateLiveness();
      this.#requireBootMayContinue();
      await this.#programAdmissions.recover();
      this.#requireBootMayContinue();
      await this.#rlm.reconcileOnBoot();
      this.#requireBootMayContinue();
      await this.#projections.reconcileAll();
      this.#requireBootMayContinue();
      const rendererInitialized = this.#projections.rendererRefresh === "excluded";
      if (rendererInitialized) await this.#renderer.initialize();
      this.#requireBootMayContinue();
      const report = Object.freeze({
        rendererInitialized,
        rendererRefreshedByProjection: !rendererInitialized,
      });
      this.#dynamicTools.openAdmissionAfterRecovery();
      this.#requireBootMayContinue();
      this.#state = "ready";
      return report;
    } catch (cause: unknown) {
      this.closeAdmissions();
      if (cause instanceof HarnessProductionLifecycleKernelV2Error &&
          cause.code === "initialization_cancelled") {
        throw cause;
      }
      if (!this.#shutdownRequested) this.#state = "initializationFailed";
      throw new HarnessProductionLifecycleKernelV2Error(
        "initialization_failed",
        { cause },
      );
    }
  }

  #requireBootMayContinue(): void {
    if (this.#shutdownRequested || this.#admissionsClosed) {
      throw new HarnessProductionLifecycleKernelV2Error(
        "initialization_cancelled",
      );
    }
  }

  #closeTerminalSources(): void {
    if (this.#terminalSourcesClosed) return;
    this.#terminalSourcesClosed = true;
    collectSynchronous(
      () => this.#rootSessions.closeObservation(),
      this.#terminalCloseFailures,
    );
  }

  async #prepareProviderStop(): Promise<
    HarnessProductionLifecyclePreProviderStopReportV2
  > {
    const failures: unknown[] = [...this.#admissionCloseFailures];
    const actorSessionDrain = bounded(
      invoke(() => this.#actorSessions.close()),
      this.#rlmQuiesceTimeoutMs,
      "Actor-session recovery did not settle before provider shutdown.",
    );
    void actorSessionDrain.catch(() => undefined);
    const initialization = this.#initialization;
    if (initialization !== null) {
      await collect(
        bounded(
          initialization.catch(() => undefined),
          this.#rlmQuiesceTimeoutMs,
          "Harness initialization did not yield to pre-provider shutdown.",
        ),
        failures,
      );
    }

    const rootAdmissionDrain = invoke(() => this.#rootSessions.settled());
    const dynamicAdmissionDrain = invoke(() => this.#dynamicTools.settled());
    await collect(actorSessionDrain, failures);
    await collect(
      bounded(
        rootAdmissionDrain,
        this.#rlmQuiesceTimeoutMs,
        "Root admission work did not settle before provider shutdown.",
      ),
      failures,
    );
    await collect(
      bounded(
        dynamicAdmissionDrain,
        this.#rlmQuiesceTimeoutMs,
        "Dynamic-tool admission work did not settle before provider shutdown.",
      ),
      failures,
    );

    this.#livenessDrain ??= invoke(() => this.#liveness.close());
    void this.#livenessDrain.catch(() => undefined);
    await collect(
      bounded(
        this.#livenessDrain,
        this.#rlmQuiesceTimeoutMs,
        "Persistent actor liveness did not settle before provider shutdown.",
      ),
      failures,
    );

    let timedOutRunIds: readonly string[] = [];
    try {
      const report = quiesceReportSchema.parse(await bounded(
        invoke(() => this.#rlm.quiesce(this.#rlmQuiesceTimeoutMs)),
        Math.min(120_000, this.#rlmQuiesceTimeoutMs * 2),
        "RLM quiescence did not return before provider shutdown.",
      ));
      timedOutRunIds = Object.freeze([...report.timedOutRunIds].toSorted());
      if (timedOutRunIds.length > 0) {
        failures.push(new HarnessProductionLifecycleKernelV2Error(
          "rlm_quiesce_timeout",
          { timedOutRunIds },
        ));
      }
    } catch (cause: unknown) {
      failures.push(cause);
    }

    if (failures.length > 0) {
      this.#state = "shutdownFailed";
      const timeout = failures.find(
        (failure) => failure instanceof HarnessProductionLifecycleKernelV2Error &&
          failure.code === "rlm_quiesce_timeout",
      );
      if (timeout instanceof HarnessProductionLifecycleKernelV2Error) throw timeout;
      throw new HarnessProductionLifecycleKernelV2Error(
        "shutdown_failed",
        { cause: new AggregateError(failures) },
      );
    }

    this.#providerStopPermitted = true;
    return Object.freeze({
      providerStopPermitted: true,
      timedOutRunIds: [] as const,
    });
  }

  async #stop(): Promise<HarnessProductionLifecycleShutdownReportV2> {
    const initialization = this.#initialization;
    if (initialization !== null) await initialization.catch(() => undefined);

    const failures: unknown[] = [...this.#terminalCloseFailures];
    const rootDrain = invoke(() => this.#rootSessions.settled());
    const dynamicDrain = invoke(() => this.#dynamicTools.settled());
    await collect(rootDrain, failures);
    await collect(dynamicDrain, failures);

    await collect(invoke(() => this.#projections.settled()), failures);
    await collect(invoke(() => this.#renderer.settled()), failures);
    await collect(
      invoke(() => this.#keyCustody.quiesceForExternalDeletion()),
      failures,
    );

    if (failures.length > 0) {
      this.#state = "shutdownFailed";
      const timeout = failures.find(
        (failure) => failure instanceof HarnessProductionLifecycleKernelV2Error &&
          failure.code === "rlm_quiesce_timeout",
      );
      if (timeout instanceof HarnessProductionLifecycleKernelV2Error) throw timeout;
      throw new HarnessProductionLifecycleKernelV2Error(
        "shutdown_failed",
        { cause: new AggregateError(failures) },
      );
    }

    this.#databaseClosePermitted = true;
    this.#state = "stopped";
    return Object.freeze({
      databaseClosePermitted: true,
      timedOutRunIds: [] as const,
    });
  }
}

function invoke<T>(operation: () => MaybePromise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (cause: unknown) {
    return Promise.reject(cause instanceof Error
      ? cause
      : new Error("Harness lifecycle port threw a non-Error value", { cause }));
  }
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function collectSynchronous(
  operation: () => void,
  failures: unknown[],
): void {
  try {
    operation();
  } catch (cause: unknown) {
    failures.push(cause instanceof Error
      ? cause
      : new Error("Harness lifecycle port threw a non-Error value", { cause }));
  }
}

async function collect(operation: Promise<unknown>, failures: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (cause: unknown) {
    failures.push(cause);
  }
}

function messageFor(code: HarnessProductionLifecycleKernelV2Error["code"]): string {
  switch (code) {
    case "initialization_cancelled":
      return "Harness initialization was cancelled by shutdown";
    case "initialization_failed":
      return "Harness initialization failed";
    case "invalid_state":
      return "Harness lifecycle transition is invalid";
    case "rlm_quiesce_timeout":
      return "RLM runs remained live after bounded quiescence";
    case "shutdown_failed":
      return "Harness shutdown failed before database close permission";
  }
}
