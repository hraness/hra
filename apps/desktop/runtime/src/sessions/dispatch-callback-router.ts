import type { RunInteractionRequest } from "@hraness/agent-tasks-protocol";

import type {
  SessionInteractionExpired,
  SessionInteractionRequest,
  SessionTurnActivity,
  SessionTurnLifecycle,
} from "./session-service";

export interface SessionActivityObserver {
  observe(event: SessionTurnActivity): void | Promise<void>;
}

export interface SessionCompletionObserver {
  observe(event: SessionTurnLifecycle): void;
}

export interface SessionInteractionObserver {
  observeRequest(
    event: SessionInteractionRequest,
  ): RunInteractionRequest | null | Promise<RunInteractionRequest | null>;
  observeExpired(event: SessionInteractionExpired): void | Promise<void>;
}

interface DynamicDispatchCallbacks {
  readonly activity: () => SessionActivityObserver | null;
  readonly completion: () => SessionCompletionObserver | null;
  readonly interactions: () => SessionInteractionObserver | null;
}

/**
 * Routes SessionService callbacks to exact-ownership adapters. Local task
 * handling is independent of cloud pairing, and a locally owned interaction
 * wins before the cloud adapter sees the provider request.
 */
export class SessionDispatchCallbackRouter {
  readonly #cloud: DynamicDispatchCallbacks;
  readonly #local: DynamicDispatchCallbacks;

  constructor(options: {
    readonly cloud: DynamicDispatchCallbacks;
    readonly local: DynamicDispatchCallbacks;
  }) {
    this.#cloud = options.cloud;
    this.#local = options.local;
  }

  async observeActivity(event: SessionTurnActivity): Promise<void> {
    await Promise.all([
      this.#cloud.activity()?.observe(event),
      this.#local.activity()?.observe(event),
    ]);
  }

  observeLifecycle(event: SessionTurnLifecycle): void {
    this.#cloud.completion()?.observe(event);
    this.#local.completion()?.observe(event);
  }

  async observeInteractionRequest(
    event: SessionInteractionRequest,
  ): Promise<RunInteractionRequest | null> {
    const local = await this.#local.interactions()?.observeRequest(event) ?? null;
    if (local !== null) return local;
    return await this.#cloud.interactions()?.observeRequest(event) ?? null;
  }

  async observeInteractionExpired(
    event: SessionInteractionExpired,
  ): Promise<void> {
    await Promise.all([
      this.#local.interactions()?.observeExpired(event),
      this.#cloud.interactions()?.observeExpired(event),
    ]);
  }
}
