import type {
  RuntimeDispatchResponse,
  RuntimeEvent,
  RuntimeProjectAddResult,
  RuntimeSnapshot,
  RuntimeTaskDispatchResponse,
  RuntimeTaskInvalidation,
  RuntimeTransportRetryResponse,
  RuntimeTransportLifecycle,
} from "../../../contracts/runtime";
import { runtimeEventDeliveryClass } from "../../../contracts/runtime-delivery";
import {
  RuntimeBridgeProtocolError,
  RuntimeBridgeTransportTimeoutError,
  type RuntimeBridge,
  type RuntimeBridgeBoundary,
  type RendererRuntimeDomainCommand,
  type RendererTaskDomainCommand,
} from "../runtime-bridge";
import { applyRuntimeEvent, type RuntimeProjectionResult } from "./projection";

export type RuntimeShellFailure =
  | {
      readonly kind: "malformedTransportValue";
      readonly boundary: RuntimeBridgeBoundary;
      readonly message: string;
    }
  | {
      readonly kind: "persistentSequenceGap";
      readonly expectedSequence: number;
      readonly receivedSequence: number;
      readonly message: string;
    }
  | {
      readonly kind: "persistentSnapshotInvalidation";
      readonly sequence: number;
      readonly reason: Extract<
        RuntimeEvent["event"],
        { readonly type: "snapshot.invalidated" }
      >["reason"];
      readonly message: string;
    }
  | {
      readonly kind: "persistentProjectionInconsistency";
      readonly sequence: number;
      readonly eventType: RuntimeEvent["event"]["type"];
      readonly message: string;
    }
  | {
      readonly kind: "transport";
      readonly message: string;
      readonly canRetry?: boolean;
      readonly generation?: number;
    };

export type RuntimeShellState =
  | { readonly state: "connecting" }
  | { readonly state: "ready"; readonly snapshot: RuntimeSnapshot }
  | {
      readonly state: "reconnecting";
      readonly snapshot: RuntimeSnapshot | null;
      readonly gap: {
        readonly expectedSequence: number;
        readonly receivedSequence: number;
      } | null;
    }
  | {
      readonly state: "failed";
      readonly snapshot: RuntimeSnapshot | null;
      readonly failure: RuntimeShellFailure;
    };

export interface RuntimeShell {
  /** React external-store snapshot reader. Safe to pass without binding. */
  readonly getSnapshot: () => RuntimeShellState;
  /** Imperative compatibility reader for non-React consumers. */
  getState(): RuntimeShellState;
  /** React external-store subscription. Safe to pass without binding. */
  readonly subscribe: (listener: () => void) => () => void;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  dispatch(command: RendererRuntimeDomainCommand): Promise<RuntimeDispatchResponse>;
  dispatchTask(command: RendererTaskDomainCommand): Promise<RuntimeTaskDispatchResponse>;
  addProject(): Promise<RuntimeProjectAddResult>;
  retryTransport(): Promise<RuntimeTransportRetryResponse>;
  subscribeTaskInvalidations(
    listener: (invalidation: RuntimeTaskInvalidation) => void,
  ): () => void;
  dispose(): void;
}

export interface RuntimeShellOptions {
  readonly maxSnapshotAttempts?: number;
  readonly maxBufferedEvents?: number;
}

type ShellMode = "buffering" | "disposed" | "live" | "paused";
type RuntimeResnapshotResult = Extract<
  RuntimeProjectionResult,
  { readonly kind: "gap" | "invalidated" }
>;
type RuntimeProjectionInconsistency = Readonly<{
  readonly kind: "inconsistent";
  readonly sequence: number;
  readonly eventType: RuntimeEvent["event"]["type"];
}>;
type RuntimeResnapshotCause = RuntimeResnapshotResult | RuntimeProjectionInconsistency;

function projectionInconsistency(
  event: RuntimeEvent,
  reason: unknown,
): RuntimeProjectionInconsistency | null {
  return reason instanceof RangeError
    ? {
        kind: "inconsistent",
        sequence: event.sequence,
        eventType: event.event.type,
      }
    : null;
}

function failureFrom(reason: unknown): RuntimeShellFailure {
  if (reason instanceof RuntimeBridgeProtocolError) {
    return {
      kind: "malformedTransportValue",
      boundary: reason.boundary,
      message: reason.message,
    };
  }
  return {
    kind: "transport",
    message: reason instanceof Error ? reason.message : "The native runtime transport failed.",
  };
}

function failureRequiresShellRecovery(reason: unknown): boolean {
  return reason instanceof RuntimeBridgeProtocolError ||
    reason instanceof RuntimeBridgeTransportTimeoutError;
}

class DefaultRuntimeShell implements RuntimeShell {
  readonly #bridge: RuntimeBridge;
  readonly #maxSnapshotAttempts: number;
  readonly #maxBufferedEvents: number;
  readonly #listeners = new Set<() => void>();
  readonly #taskInvalidationListeners = new Set<
    (invalidation: RuntimeTaskInvalidation) => void
  >();
  #state: RuntimeShellState = { state: "connecting" };
  #snapshot: RuntimeSnapshot | null = null;
  #mode: ShellMode = "paused";
  #buffer: RuntimeEvent[] = [];
  #unsubscribeBridge: (() => void) | null = null;
  #hydration: Promise<void> | null = null;
  #hydrationToken = 0;
  #publishedTaskInvalidationSequence = 0;
  #transportGeneration = 0;
  #transportPhase: RuntimeTransportLifecycle["state"] | null = null;

  constructor(bridge: RuntimeBridge, options: RuntimeShellOptions) {
    this.#bridge = bridge;
    this.#maxSnapshotAttempts = options.maxSnapshotAttempts ?? 3;
    this.#maxBufferedEvents = options.maxBufferedEvents ?? 1_024;
    if (!Number.isSafeInteger(this.#maxSnapshotAttempts) || this.#maxSnapshotAttempts < 1) {
      throw new Error("maxSnapshotAttempts must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.#maxBufferedEvents) || this.#maxBufferedEvents < 1) {
      throw new Error("maxBufferedEvents must be a positive safe integer.");
    }
  }

  readonly getSnapshot = (): RuntimeShellState => {
    return this.#state;
  };

  getState(): RuntimeShellState {
    return this.getSnapshot();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#mode === "disposed") return () => undefined;
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  };

  connect(): Promise<void> {
    this.#assertActive();
    if (this.#state.state === "ready") return Promise.resolve();
    if (this.#hydration !== null) return this.#hydration;
    this.#retainProtectedBufferedEvents();
    this.#mode = "buffering";
    try {
      this.#ensureSubscription();
    } catch (reason: unknown) {
      this.#fail(reason);
      return Promise.resolve();
    }
    this.#setState({ state: "connecting" });
    return this.#startHydration();
  }

  reconnect(): Promise<void> {
    this.#assertActive();
    if (
      this.#state.state === "failed" &&
      this.#state.failure.kind === "transport" &&
      this.#state.failure.canRetry !== false
    ) {
      return this.retryTransport().then(() => undefined);
    }
    if (this.#hydration !== null) return this.#hydration;
    this.#retainProtectedBufferedEvents();
    this.#mode = "buffering";
    try {
      this.#ensureSubscription();
    } catch (reason: unknown) {
      this.#fail(reason);
      return Promise.resolve();
    }
    this.#setState({ state: "reconnecting", snapshot: this.#snapshot, gap: null });
    return this.#startHydration();
  }

  async dispatch(command: RendererRuntimeDomainCommand): Promise<RuntimeDispatchResponse> {
    this.#assertActive();
    try {
      return await this.#bridge.dispatch(command);
    } catch (reason: unknown) {
      // Safe Native pre-admission failures (for example a saturated bounded
      // mutation queue) belong to this one operation. Lifecycle events own
      // process-wide transport state; only malformed/ambiguous generation
      // boundaries should pause every pane here.
      if (failureRequiresShellRecovery(reason)) this.#fail(reason);
      throw reason;
    }
  }

  async dispatchTask(command: RendererTaskDomainCommand): Promise<RuntimeTaskDispatchResponse> {
    this.#assertActive();
    try {
      return await this.#bridge.dispatchTask(command);
    } catch (reason: unknown) {
      if (failureRequiresShellRecovery(reason)) this.#fail(reason);
      throw reason;
    }
  }

  async addProject(): Promise<RuntimeProjectAddResult> {
    this.#assertActive();
    try {
      return await this.#bridge.addProject();
    } catch (reason: unknown) {
      if (failureRequiresShellRecovery(reason)) this.#fail(reason);
      throw reason;
    }
  }

  async retryTransport(): Promise<RuntimeTransportRetryResponse> {
    this.#assertActive();
    let response: RuntimeTransportRetryResponse;
    try {
      response = await this.#bridge.retryTransport();
    } catch (reason: unknown) {
      this.#fail(reason);
      throw reason;
    }
    switch (response.status) {
      case "accepted":
        this.#mode = "buffering";
        this.#setState({
          state: "reconnecting",
          snapshot: this.#snapshot,
          gap: null,
        });
        return response;
      case "alreadyReady":
        await this.#restartHydrationForCurrentGeneration(false);
        return response;
      case "unavailable":
        this.#setFailed({
          kind: "transport",
          message: "The local runtime cannot be restarted while the app is shutting down.",
          canRetry: false,
          generation: this.#transportGeneration,
        });
        return response;
    }
  }

  subscribeTaskInvalidations(
    listener: (invalidation: RuntimeTaskInvalidation) => void,
  ): () => void {
    this.#assertActive();
    this.#taskInvalidationListeners.add(listener);
    return () => this.#taskInvalidationListeners.delete(listener);
  }

  dispose(): void {
    if (this.#mode === "disposed") return;
    this.#hydrationToken += 1;
    this.#mode = "disposed";
    this.#buffer = [];
    this.#unsubscribeBridge?.();
    this.#unsubscribeBridge = null;
    this.#listeners.clear();
    this.#taskInvalidationListeners.clear();
  }

  #assertActive(): void {
    if (this.#mode === "disposed") throw new Error("The runtime shell has been disposed.");
  }

  #ensureSubscription(): void {
    if (this.#unsubscribeBridge !== null) return;
    this.#unsubscribeBridge = this.#bridge.subscribe({
      onEvent: (event) => this.#receiveEvent(event),
      onTransportLifecycle: (lifecycle) => this.#receiveTransportLifecycle(lifecycle),
      onMalformedValue: (error) => this.#fail(error),
    });
  }

  #receiveTransportLifecycle(lifecycle: RuntimeTransportLifecycle): void {
    if (this.#mode === "disposed") return;
    if (
      this.#transportPhase === "stopping" ||
      this.#transportPhase === "stopped"
    ) {
      if (
        lifecycle.generation === this.#transportGeneration &&
        lifecycle.state === "stopped" &&
        this.#transportPhase === "stopping"
      ) {
        this.#transportPhase = "stopped";
      }
      return;
    }
    if (lifecycle.generation < this.#transportGeneration) return;
    if (lifecycle.generation > this.#transportGeneration) {
      this.#crossTransportGeneration(lifecycle.generation);
    }
    switch (lifecycle.state) {
      case "starting": {
        if (this.#transportPhase !== null) return;
        this.#transportPhase = "starting";
        this.#pauseForTransportRecovery();
        return;
      }
      case "backingOff": {
        this.#transportPhase = "backingOff";
        this.#pauseForTransportRecovery();
        return;
      }
      case "ready": {
        if (
          this.#transportPhase !== null &&
          this.#transportPhase !== "starting"
        ) return;
        this.#transportPhase = "ready";
        void this.#restartHydrationForCurrentGeneration(true);
        return;
      }
      case "failed": {
        this.#transportPhase = "failed";
        this.#fenceHydrationAtTransportBoundary();
        this.#setFailed({
          kind: "transport",
          message: lifecycle.message,
          canRetry: lifecycle.canRetry,
          generation: lifecycle.generation,
        });
        return;
      }
      case "stopping":
      case "stopped": {
        this.#transportPhase = lifecycle.state;
        this.#fenceHydrationAtTransportBoundary();
        this.#setFailed({
          kind: "transport",
          message: "The local runtime has stopped.",
          canRetry: false,
          generation: lifecycle.generation,
        });
        return;
      }
    }
  }

  #crossTransportGeneration(generation: number): void {
    this.#fenceHydrationAtTransportBoundary();
    this.#transportGeneration = generation;
    this.#transportPhase = null;
  }

  #pauseForTransportRecovery(): void {
    this.#fenceHydrationAtTransportBoundary();
    this.#mode = "buffering";
    this.#setState({
      state: "reconnecting",
      snapshot: this.#snapshot,
      gap: null,
    });
  }

  #fenceHydrationAtTransportBoundary(): void {
    this.#hydrationToken += 1;
    this.#hydration = null;
    this.#acceptProtectedBufferedEvents();
    this.#buffer = [];
  }

  #restartHydrationForCurrentGeneration(
    resetSequenceAuthority: boolean,
  ): Promise<void> {
    this.#hydrationToken += 1;
    this.#hydration = null;
    if (resetSequenceAuthority) {
      this.#publishedTaskInvalidationSequence = 0;
    } else {
      this.#retainProtectedBufferedEvents();
    }
    this.#mode = "buffering";
    this.#setState({
      state: "reconnecting",
      snapshot: this.#snapshot,
      gap: null,
    });
    return this.#startHydration();
  }

  #receiveEvent(event: RuntimeEvent): void {
    if (this.#mode === "disposed") return;
    if (this.#mode === "buffering") {
      this.#appendBufferedEvent(event);
      return;
    }
    if (this.#mode === "paused") {
      if (runtimeEventDeliveryClass(event.event) === "transient-exact") {
        this.#appendBufferedEvent(event);
      }
      return;
    }
    if (this.#mode !== "live" || this.#snapshot === null) return;
    let result: RuntimeProjectionResult;
    try {
      result = applyRuntimeEvent(this.#snapshot, event);
    } catch (reason: unknown) {
      const inconsistency = projectionInconsistency(event, reason);
      if (inconsistency === null) {
        this.#fail(reason);
        return;
      }
      this.#buffer = [event];
      this.#mode = "buffering";
      this.#setReconnecting(inconsistency);
      void this.#startHydration();
      return;
    }
    switch (result.kind) {
      case "applied":
        this.#snapshot = result.snapshot;
        this.#setState({ state: "ready", snapshot: result.snapshot });
        if (event.event.type === "task.invalidated") {
          this.#publishTaskInvalidation({
            sequence: event.sequence,
            invalidation: event.event.invalidation,
          });
        }
        return;
      case "ignored":
        this.#publishCoveredTaskInvalidation(event);
        return;
      case "gap":
      case "invalidated":
        this.#buffer = [event];
        this.#mode = "buffering";
        this.#setReconnecting(result);
        void this.#startHydration();
        return;
      default:
        return this.#unreachableResult(result);
    }
  }

  #startHydration(): Promise<void> {
    if (this.#hydration !== null) return this.#hydration;
    const token = this.#hydrationToken + 1;
    this.#hydrationToken = token;
    const hydration = this.#hydrate(token)
      .catch((reason: unknown) => {
        if (token === this.#hydrationToken) this.#fail(reason);
      })
      .finally(() => {
        if (this.#hydration === hydration) this.#hydration = null;
      });
    this.#hydration = hydration;
    return hydration;
  }

  async #hydrate(token: number): Promise<void> {
    let resnapshot: RuntimeResnapshotCause | null = null;
    const deferredTaskInvalidations: Array<{
      readonly sequence: number;
      readonly invalidation: RuntimeTaskInvalidation;
    }> = [];
    for (let attempt = 0; attempt < this.#maxSnapshotAttempts; attempt += 1) {
      let snapshot = await this.#bridge.snapshot();
      if (token !== this.#hydrationToken || this.#mode === "disposed") return;

      const pending = this.#buffer;
      this.#buffer = [];
      resnapshot = null;
      const acceptedTaskInvalidations: Array<{
        readonly sequence: number;
        readonly invalidation: RuntimeTaskInvalidation;
      }> = [];
      for (let index = 0; index < pending.length; index += 1) {
        const event = pending[index];
        if (event === undefined) continue;
        let result: RuntimeProjectionResult;
        try {
          result = applyRuntimeEvent(snapshot, event);
        } catch (reason: unknown) {
          const inconsistency = projectionInconsistency(event, reason);
          if (inconsistency === null) throw reason;
          resnapshot = inconsistency;
          this.#replaceBufferedEvents([
            ...pending.slice(index),
            ...this.#buffer,
          ]);
          this.#setReconnecting(inconsistency);
          break;
        }
        if (result.kind === "gap" || result.kind === "invalidated") {
          resnapshot = result;
          this.#replaceBufferedEvents([
            ...pending.slice(index),
            ...this.#buffer,
          ]);
          this.#setReconnecting(result);
          break;
        }
        snapshot = result.snapshot;
        if (
          (result.kind === "applied" || result.kind === "ignored") &&
          event.event.type === "task.invalidated"
        ) {
          acceptedTaskInvalidations.push({
            sequence: event.sequence,
            invalidation: event.event.invalidation,
          });
        }
      }

      if (resnapshot === null) {
        this.#snapshot = snapshot;
        this.#mode = "live";
        this.#setState({ state: "ready", snapshot });
        const publishedSequences = new Set<number>();
        for (const taskInvalidation of [
          ...deferredTaskInvalidations,
          ...acceptedTaskInvalidations,
        ]) {
          if (publishedSequences.has(taskInvalidation.sequence)) continue;
          publishedSequences.add(taskInvalidation.sequence);
          this.#publishTaskInvalidation(taskInvalidation);
        }
        return;
      }

      deferredTaskInvalidations.push(...acceptedTaskInvalidations);
    }

    if (resnapshot !== null) {
      switch (resnapshot.kind) {
        case "gap":
          this.#setFailed({
            kind: "persistentSequenceGap",
            expectedSequence: resnapshot.expectedSequence,
            receivedSequence: resnapshot.receivedSequence,
            message: `Runtime events remained out of sequence after ${this.#maxSnapshotAttempts} snapshots.`,
          });
          return;
        case "invalidated":
          this.#setFailed({
            kind: "persistentSnapshotInvalidation",
            sequence: resnapshot.sequence,
            reason: resnapshot.reason,
            message: `The authoritative snapshot remained stale after ${this.#maxSnapshotAttempts} snapshots.`,
          });
          return;
        case "inconsistent":
          this.#setFailed({
            kind: "persistentProjectionInconsistency",
            sequence: resnapshot.sequence,
            eventType: resnapshot.eventType,
            message: `Runtime event ${resnapshot.sequence} (${resnapshot.eventType}) remained inconsistent with the authoritative projection after ${this.#maxSnapshotAttempts} snapshots.`,
          });
          return;
        default:
          return this.#unreachableResult(resnapshot);
      }
    }
  }

  #setReconnecting(result: RuntimeResnapshotCause): void {
    this.#setState({
      state: "reconnecting",
      snapshot: this.#snapshot,
      gap: result.kind === "gap"
        ? {
            expectedSequence: result.expectedSequence,
            receivedSequence: result.receivedSequence,
          }
        : null,
    });
  }

  #fail(reason: unknown): void {
    this.#setFailed(failureFrom(reason));
  }

  #setFailed(failure: RuntimeShellFailure): void {
    if (this.#mode === "disposed") return;
    this.#hydrationToken += 1;
    this.#mode = "paused";
    this.#retainProtectedBufferedEvents();
    this.#setState({ state: "failed", snapshot: this.#snapshot, failure });
  }

  #setState(state: RuntimeShellState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      if (!this.#listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // A subscriber cannot prevent later subscribers from observing committed state.
      }
    }
  }

  #publishCoveredTaskInvalidation(event: RuntimeEvent): void {
    if (
      runtimeEventDeliveryClass(event.event) !== "transient-exact" ||
      event.event.type !== "task.invalidated"
    ) {
      return;
    }
    this.#publishTaskInvalidation({
      sequence: event.sequence,
      invalidation: event.event.invalidation,
    });
  }

  #publishTaskInvalidation(delivery: Readonly<{
    sequence: number;
    invalidation: RuntimeTaskInvalidation;
  }>): void {
    if (delivery.sequence <= this.#publishedTaskInvalidationSequence) return;
    this.#publishedTaskInvalidationSequence = delivery.sequence;
    for (const listener of [...this.#taskInvalidationListeners]) {
      if (!this.#taskInvalidationListeners.has(listener)) continue;
      try {
        listener(delivery.invalidation);
      } catch {
        // Task consumers are isolated from shell sequencing and from one another.
      }
    }
  }

  #acceptProtectedBufferedEvents(): void {
    for (const event of this.#buffer) {
      if (runtimeEventDeliveryClass(event.event) !== "transient-exact") continue;
      if (event.event.type === "task.invalidated") {
        this.#publishTaskInvalidation({
          sequence: event.sequence,
          invalidation: event.event.invalidation,
        });
      }
      // Operation completions are accepted by crossing this explicit boundary;
      // their correlated response already carries the visible result.
    }
  }

  #retainProtectedBufferedEvents(): void {
    this.#buffer = this.#buffer.filter(
      (event) => runtimeEventDeliveryClass(event.event) === "transient-exact",
    );
  }

  #appendBufferedEvent(event: RuntimeEvent): void {
    this.#buffer.push(event);
    if (this.#buffer.length <= this.#maxBufferedEvents) return;
    this.#compactBufferedEvents();
  }

  #replaceBufferedEvents(events: RuntimeEvent[]): void {
    this.#buffer = events;
    if (this.#buffer.length <= this.#maxBufferedEvents) return;
    this.#compactBufferedEvents();
  }

  /**
   * Exact transient effects cross an explicit acceptance boundary before
   * compaction. Keeping the newest envelope then makes an older snapshot
   * either cover the discarded recoverable state or observe a sequence gap
   * and fetch a newer authoritative snapshot.
   */
  #compactBufferedEvents(): void {
    const newest = this.#buffer.at(-1);
    this.#acceptProtectedBufferedEvents();
    this.#buffer = newest === undefined ? [] : [newest];
  }

  #unreachableResult(result: never): never {
    throw new Error(`Unhandled projection result: ${JSON.stringify(result)}`);
  }
}

export function createRuntimeShell(
  bridge: RuntimeBridge,
  options: RuntimeShellOptions = {},
): RuntimeShell {
  return new DefaultRuntimeShell(bridge, options);
}
