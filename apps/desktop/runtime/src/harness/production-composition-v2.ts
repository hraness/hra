import { z } from "@hra-internal/schema";
import type { AccountRuntimeDynamicToolCapabilityResolver } from
  "../accounts/runtime-router";
import {
  createPinnedCodexDynamicToolCapabilityResolver,
  type CodexExpiredServerRequestFault,
  type CodexFactConsumer,
  type PinnedCodexDynamicToolRequest,
  type PinnedCodexDynamicToolCapabilityResolverOptions,
} from "../codex";
import type {
  SessionTurnLifecycle,
} from "../sessions/session-service";
import type { ChatHarnessRootPort } from "../chat/types";
import type { RuntimeHarnessDomainCommand } from "../../../contracts/runtime";
import type {
  HarnessDynamicToolResponseSettlement,
} from "./dynamic-tool-service-v2";
import type {
  HarnessProductionLifecycleBootReportV2,
  HarnessProductionLifecyclePreProviderStopReportV2,
  HarnessProductionLifecycleShutdownReportV2,
} from "./production-lifecycle-kernel-v2";
import type { HarnessRendererResult } from "./renderer-service-v2";
import type { HarnessRootChatAdmissionResultV2 } from
  "./root-chat-admission-v2";

type MaybePromise<T> = T | Promise<T>;
const preProviderStopTimeoutSchema = z.number().int().min(1).max(60_000);

export interface HarnessProductionRendererCommandsV2 {
  execute(command: RuntimeHarnessDomainCommand): Promise<HarnessRendererResult>;
  refresh(): Promise<void>;
}

export type HarnessProductionRootChatPortV2 = ChatHarnessRootPort;

/** The complete, already-constructed v2 graph. No member is optional. */
export interface HarnessProductionCompositionV2Parts {
  readonly settings: Readonly<{
    read(): MaybePromise<Readonly<{ recursiveSessionsEnabled: boolean }>>;
  }>;
  readonly renderer: HarnessProductionRendererCommandsV2;
  readonly dynamicTools: Readonly<{
    handle(
      request: PinnedCodexDynamicToolRequest,
    ): Promise<HarnessDynamicToolResponseSettlement>;
    expire(
      accountProfileId: string,
      fault: CodexExpiredServerRequestFault,
    ): number;
    settled(): Promise<unknown>;
  }>;
  readonly chat: Readonly<{
    closeAdmission(): void;
    settled(): Promise<void>;
  }>;
  readonly roots: Readonly<{
    observe(event: SessionTurnLifecycle): Promise<unknown>;
    settleBeforeProvider(input: Readonly<{
      turnId: string;
      paneId: string;
      failure: "provider_start_ambiguous" | "provider_unavailable";
      settledAt?: string;
    }>): Promise<unknown>;
    settled(): Promise<void>;
  }>;
  readonly rootAdmission: Readonly<{
    admit(input: unknown): Promise<HarnessRootChatAdmissionResultV2>;
  }>;
  readonly providerCapabilities: Readonly<{
    settingsChanged(enabled: boolean): Promise<void>;
    observe(event: SessionTurnLifecycle): void;
    close(): void;
    settled(): Promise<void>;
  }>;
  readonly liveness: Readonly<{
    observe(event: SessionTurnLifecycle): void;
    settled(): Promise<void>;
  }>;
  /** Exact token-usage consumer installed as CodexFactRouter's third branch. */
  readonly harnessFactConsumer: CodexFactConsumer;
  readonly lifecycle: Readonly<{
    initialize(): Promise<HarnessProductionLifecycleBootReportV2>;
    closeAdmissions(): void;
    preProviderStop(): Promise<HarnessProductionLifecyclePreProviderStopReportV2>;
    providerSourcesStopped(): void;
    shutdown(): Promise<HarnessProductionLifecycleShutdownReportV2>;
  }>;
}

export class HarnessProductionCompositionV2Error extends Error {
  readonly code:
    | "account_mismatch"
    | "already_bound"
    | "invalid_state"
    | "not_ready";

  constructor(
    code: HarnessProductionCompositionV2Error["code"],
    cause?: unknown,
  ) {
    super({
      account_mismatch: "The dynamic-tool request belongs to another account.",
      already_bound: "The production harness composition is already bound.",
      invalid_state: "The production harness composition is not bound.",
      not_ready: "The production harness composition is not accepting work.",
    }[code], cause === undefined ? undefined : { cause });
    this.name = "HarnessProductionCompositionV2Error";
    this.code = code;
  }
}

type BindingState =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{ kind: "bound"; parts: HarnessProductionCompositionV2Parts }>;

/**
 * Bind-once production seam for the v2 graph.
 *
 * Main constructs this first and passes `dynamicToolCapabilityResolver` to the
 * AccountRuntimeRouter before an account can launch. It then constructs the
 * complete provider-dependent graph and binds it atomically. Stable callback
 * objects may be handed to SessionService and ChatService before that bind;
 * every invocation fails closed until the complete graph exists.
 */
export class HarnessProductionCompositionV2 {
  readonly dynamicToolCapabilityResolver:
    AccountRuntimeDynamicToolCapabilityResolver;
  readonly rendererCommands: HarnessProductionRendererCommandsV2;
  readonly rootChat: HarnessProductionRootChatPortV2;
  #state: BindingState = Object.freeze({ kind: "unbound" });
  #rendererAndRootAdmissionReady = false;
  #providerCapabilityBootConverged = false;
  #providerCapabilityTail: Promise<void> = Promise.resolve();
  #activeWork = 0;
  #admissionsClosed = false;
  #providerSourcesStopped = false;
  #providerStopPermitted = false;
  #initialization: Promise<HarnessProductionLifecycleBootReportV2> | null =
    null;
  #initializationFailed = false;
  #preProviderStop:
    Promise<HarnessProductionLifecyclePreProviderStopReportV2> | null = null;
  #shutdown: Promise<HarnessProductionLifecycleShutdownReportV2> | null = null;
  readonly #preProviderStopTimeoutMs: number;

  get harnessFactConsumer(): CodexFactConsumer | null {
    return this.#state.kind === "bound"
      ? this.#state.parts.harnessFactConsumer
      : null;
  }

  hasUnsettledWork(): boolean {
    return this.#activeWork > 0;
  }

  constructor(
    capabilityOptions: PinnedCodexDynamicToolCapabilityResolverOptions = {},
    preProviderStopTimeoutMs = 5_000,
  ) {
    this.#preProviderStopTimeoutMs = preProviderStopTimeoutSchema.parse(
      preProviderStopTimeoutMs,
    );
    const resolveDynamicToolCapability =
      createPinnedCodexDynamicToolCapabilityResolver(capabilityOptions);
    this.dynamicToolCapabilityResolver = async (input) => {
      const state = this.#state;
      if (
        state.kind !== "bound" || this.#admissionsClosed ||
        this.#initializationFailed
      ) return null;
      // Account startup occurs before the recovery lifecycle. Advertise the
      // capability from the already-durable setting so every newly launched
      // process has the right immutable tool declaration from generation one.
      const settings = await state.parts.settings.read();
      if (
        settings.recursiveSessionsEnabled !== true ||
        this.#admissionsClosed || this.#initializationFailed
      ) return null;
      return await resolveDynamicToolCapability(input);
    };
    const rendererCommands: HarnessProductionRendererCommandsV2 = {
      execute: (command: RuntimeHarnessDomainCommand) =>
        this.#track(this.#executeRenderer(command)),
      refresh: () => {
        const parts = this.#parts();
        this.#assertRendererAndRootAdmissionReady();
        return this.#track(parts.renderer.refresh());
      },
    };
    this.rendererCommands = Object.freeze(rendererCommands);
    const rootChat: HarnessProductionRootChatPortV2 = {
      admit: (input: unknown) => this.#track(this.#admitRoot(input)),
      observe: (event: SessionTurnLifecycle) =>
        this.#track(Promise.resolve(this.#parts().roots.observe(event))),
      settleBeforeProvider: (input: Parameters<
        HarnessProductionRootChatPortV2["settleBeforeProvider"]
      >[0]) =>
        this.#track(Promise.resolve(
          this.#parts().roots.settleBeforeProvider(input),
        )),
    };
    this.rootChat = Object.freeze(rootChat);
  }

  bind(parts: HarnessProductionCompositionV2Parts): void {
    if (this.#state.kind !== "unbound") {
      throw new HarnessProductionCompositionV2Error("already_bound");
    }
    this.#state = Object.freeze({ kind: "bound", parts });
  }

  handleDynamicToolRequest(
    accountProfileId: string,
    request: PinnedCodexDynamicToolRequest,
  ): Promise<HarnessDynamicToolResponseSettlement> {
    if (request.accountProfileId !== accountProfileId) {
      return Promise.reject(new HarnessProductionCompositionV2Error(
        "account_mismatch",
      ));
    }
    const parts = this.#parts();
    // A provider request is also its one response channel. Once the complete
    // graph is bound, always route that channel through the dynamic-tool
    // service, including while settings converge and after admission closes.
    // The service owns the durable admission fence and emits a bounded
    // closed/unavailable response. Rejecting here would strand the provider
    // request without any response at all.
    return this.#track(parts.dynamicTools.handle(request));
  }

  expireDynamicToolRequest(
    accountProfileId: string,
    fault: CodexExpiredServerRequestFault,
  ): number {
    return this.#parts().dynamicTools.expire(accountProfileId, fault);
  }

  /** Safe to install as SessionService's synchronous nested-actor hint. */
  observeActorLifecycle(event: SessionTurnLifecycle): void {
    // Session lifecycle facts can arrive while the gateway is still binding
    // its provider-dependent graph. The durable actor authority is reconciled
    // at boot, so an early hint may be dropped; throwing here would unwind the
    // Session registry after it has already committed its own state.
    if (this.#state.kind === "unbound") return;
    // Pre-provider shutdown deliberately disarms the actor liveness producer.
    // Terminal SessionService routing stays open, so late provider facts must
    // pass this hint seam without touching the closed pump. Durable actor state
    // is recovered on the next boot.
    if (this.#admissionsClosed) return;
    const parts = this.#state.parts;
    parts.liveness.observe(event);
    parts.providerCapabilities.observe(event);
  }

  initialize(): Promise<HarnessProductionLifecycleBootReportV2> {
    if (this.#initialization !== null) return this.#initialization;
    const parts = this.#parts();
    this.#initialization = this.#initialize(parts);
    return this.#initialization;
  }

  /**
   * Phase one of process shutdown. Main calls this before it stops account
   * runtimes so already-admitted root turns can still consume their exact
   * terminal provider observations.
   */
  closeAdmissions(): void {
    if (this.#admissionsClosed) return;
    this.#admissionsClosed = true;
    this.#rendererAndRootAdmissionReady = false;
    const parts = this.#parts();
    const failures: unknown[] = [];
    try {
      parts.providerCapabilities.close();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      parts.chat.closeAdmission();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      parts.lifecycle.closeAdmissions();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      throw new HarnessProductionCompositionV2Error(
        "invalid_state",
        new AggregateError(failures),
      );
    }
  }

  /** Main must await this effect-producer barrier before account shutdown. */
  preProviderStop(): Promise<HarnessProductionLifecyclePreProviderStopReportV2> {
    if (this.#preProviderStop !== null) return this.#preProviderStop;
    if (this.#providerSourcesStopped || this.#shutdown !== null) {
      this.#preProviderStop = Promise.reject(
        new HarnessProductionCompositionV2Error("invalid_state"),
      );
      return this.#preProviderStop;
    }
    const parts = this.#parts();
    this.#preProviderStop = this.#prepareProviderStop(parts);
    return this.#preProviderStop;
  }

  /** Main calls this only after every account runtime has stopped emitting. */
  providerSourcesStopped(): void {
    if (!this.#providerStopPermitted) {
      throw new HarnessProductionCompositionV2Error("invalid_state");
    }
    if (this.#providerSourcesStopped) return;
    this.#parts().lifecycle.providerSourcesStopped();
    this.#providerSourcesStopped = true;
  }

  shutdown(): Promise<HarnessProductionLifecycleShutdownReportV2> {
    if (this.#shutdown !== null) return this.#shutdown;
    if (!this.#providerStopPermitted || !this.#providerSourcesStopped) {
      return Promise.reject(
        new HarnessProductionCompositionV2Error("invalid_state"),
      );
    }
    const parts = this.#parts();
    const lifecycle = invoke(() => parts.lifecycle.shutdown());
    const chatSettled = invoke(() => parts.chat.settled());
    const providerSettled = invoke(() => parts.providerCapabilities.settled());
    this.#shutdown = (async () => {
      await this.#providerCapabilityTail;
      await chatSettled;
      await providerSettled;
      return await lifecycle;
    })();
    return this.#shutdown;
  }

  async settled(): Promise<void> {
    const parts = this.#parts();
    await parts.dynamicTools.settled();
    await parts.roots.settled();
    await parts.liveness.settled();
    await this.#providerCapabilityTail;
    await parts.providerCapabilities.settled();
  }

  async #prepareProviderStop(
    parts: HarnessProductionCompositionV2Parts,
  ): Promise<HarnessProductionLifecyclePreProviderStopReportV2> {
    const failures: unknown[] = [];
    try {
      this.closeAdmissions();
    } catch (cause: unknown) {
      failures.push(cause);
    }

    const providerCapabilityTail = this.#providerCapabilityTail;
    const providerCapabilitiesSettled = invoke(
      () => parts.providerCapabilities.settled(),
    );
    const chatSettled = invoke(() => parts.chat.settled());
    let producerResults: readonly PromiseSettledResult<unknown>[] = [];
    try {
      producerResults = await bounded(
        Promise.allSettled([
          providerCapabilityTail,
          providerCapabilitiesSettled,
          chatSettled,
        ]),
        this.#preProviderStopTimeoutMs,
        "Production effect producers did not settle before provider shutdown.",
      );
    } catch (cause: unknown) {
      failures.push(cause);
    }
    for (const result of producerResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    const lifecycle = invoke(() => parts.lifecycle.preProviderStop());
    const lifecycleResult = await Promise.allSettled([lifecycle]);
    if (lifecycleResult[0]?.status === "rejected") {
      failures.push(lifecycleResult[0].reason);
    }
    if (failures.length > 0) {
      throw new HarnessProductionCompositionV2Error(
        "invalid_state",
        new AggregateError(failures),
      );
    }
    const report = await lifecycle;
    this.#providerStopPermitted = true;
    return report;
  }

  async #executeRenderer(
    command: RuntimeHarnessDomainCommand,
  ): Promise<HarnessRendererResult> {
    const parts = this.#parts();
    this.#assertRendererAndRootAdmissionReady();
    if (command.type !== "harness.settings.update") {
      if (!this.#providerCapabilityBootConverged) {
        throw new HarnessProductionCompositionV2Error("not_ready");
      }
      return await parts.renderer.execute(command);
    }
    return await this.#serializeProviderCapability(async () => {
      this.#providerCapabilityBootConverged = false;
      let result: HarnessRendererResult;
      try {
        result = await parts.renderer.execute(command);
      } catch (cause: unknown) {
        if (
          !this.#admissionsClosed && !this.#initializationFailed
        ) {
          this.#providerCapabilityBootConverged = true;
        }
        throw cause;
      }
      // The renderer authority returns only after the exact settings CAS is
      // durable. A rejected/stale CAS never reaches this provider effect.
      await parts.providerCapabilities.settingsChanged(
        command.recursiveSessionsEnabled,
      );
      this.#providerCapabilityBootConverged = true;
      return result;
    });
  }

  async #initialize(
    parts: HarnessProductionCompositionV2Parts,
  ): Promise<HarnessProductionLifecycleBootReportV2> {
    try {
      // Converge all already-running generations before actor or RLM recovery.
      // Renderer and root admission remain closed through the entire lifecycle.
      // Provider response channels continue routing independently; the stable
      // caller authority rejects any generation not backed by durable evidence.
      await this.#serializeProviderCapability(async () => {
        const settings = await parts.settings.read();
        await parts.providerCapabilities.settingsChanged(
          settings.recursiveSessionsEnabled,
        );
        this.#providerCapabilityBootConverged = true;
      });
      const report = await parts.lifecycle.initialize();
      if (this.#admissionsClosed) {
        throw new HarnessProductionCompositionV2Error("not_ready");
      }
      this.#rendererAndRootAdmissionReady = true;
      return report;
    } catch (cause: unknown) {
      this.#rendererAndRootAdmissionReady = false;
      this.#initializationFailed = true;
      throw cause;
    }
  }

  #serializeProviderCapability<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.#track(this.#providerCapabilityTail.then(operation));
    this.#providerCapabilityTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #track<Result>(operation: Promise<Result>): Promise<Result> {
    this.#activeWork += 1;
    return operation.finally(() => {
      this.#activeWork -= 1;
    });
  }

  async #admitRoot(
    input: unknown,
  ): Promise<HarnessRootChatAdmissionResultV2 | null> {
    const parts = this.#parts();
    if (
      !this.#rendererAndRootAdmissionReady ||
      !this.#providerCapabilityBootConverged
    ) return null;
    const settings = await parts.settings.read();
    if (
      settings.recursiveSessionsEnabled !== true ||
      !this.#rendererAndRootAdmissionReady || this.#admissionsClosed ||
      this.#initializationFailed
    ) {
      return null;
    }
    return await parts.rootAdmission.admit(input);
  }

  #parts(): HarnessProductionCompositionV2Parts {
    if (this.#state.kind !== "bound") {
      throw new HarnessProductionCompositionV2Error("invalid_state");
    }
    return this.#state.parts;
  }

  #assertRendererAndRootAdmissionReady(): void {
    if (
      !this.#rendererAndRootAdmissionReady || this.#admissionsClosed ||
      this.#initializationFailed
    ) {
      throw new HarnessProductionCompositionV2Error("not_ready");
    }
  }
}

export function createHarnessProductionCompositionV2(
  capabilityOptions: PinnedCodexDynamicToolCapabilityResolverOptions = {},
  preProviderStopTimeoutMs = 5_000,
): HarnessProductionCompositionV2 {
  return new HarnessProductionCompositionV2(
    capabilityOptions,
    preProviderStopTimeoutMs,
  );
}

function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (cause: unknown) {
    return Promise.reject(cause instanceof Error
      ? cause
      : new Error("Production composition port threw a non-Error value.", {
          cause,
        }));
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
