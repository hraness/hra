import type {
  HRAProjectionCursor,
  PortableInvalidation,
} from "@hraness/agent-tasks-protocol";

import {
  type CloudWorkspaceClient,
  type HRACloudSessionResult,
  type HRAInvalidationPage,
} from "./http-client";
import { abortableSleep } from "./abortable-sleep";

const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAXIMUM_BACKOFF_MS = 10_000;

export interface CloudInvalidationDelivery {
  readonly accountGeneration: number;
  readonly workspaceId: string;
  readonly previousProjectionHead: number;
  readonly projectionHead: number;
  readonly invalidations: readonly PortableInvalidation[];
  /** Persist `projectionHead` only after the final immutable cursor page. */
  readonly pageComplete: boolean;
}

export type CloudInvalidationStopReason =
  | "authentication_failed"
  | "cancelled"
  | "generation_changed";

export interface CloudInvalidationCoordinatorOptions {
  readonly client: Pick<CloudWorkspaceClient, "pollInvalidations">;
  readonly isAccountGenerationCurrent: (generation: number) => boolean;
  readonly onDelivery: (delivery: CloudInvalidationDelivery) => void;
  readonly onFatalFailure?: (error: Error) => void;
  readonly onStopped?: (reason: CloudInvalidationStopReason) => void;
  readonly sleep?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
}

export interface StartCloudInvalidationsInput {
  readonly accountGeneration: number;
  readonly afterProjectionHead: number;
  readonly workspaceId: string;
}

function positiveDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`${name} must be an integer from 1 to 60000 milliseconds`);
  }
  return value;
}

function terminalAuthenticationFailure(
  result: HRACloudSessionResult<unknown>,
): boolean {
  if (result.ok) return false;
  if (result.kind === "session") {
    return result.error.code === "SIGNED_OUT" ||
      result.error.code === "AUTHENTICATION_FAILED" ||
      result.error.code === "AUTH_REFRESH_INDETERMINATE";
  }
  return result.error.code === "AUTHENTICATION_FAILED";
}

/**
 * Runs one invalidation stream at a time. Delivery is deliberately synchronous:
 * the generation check and the caller's reducer application share one JS turn,
 * so a stale loop cannot publish after account/workspace replacement.
 */
export class CloudInvalidationCoordinator {
  readonly #client: Pick<CloudWorkspaceClient, "pollInvalidations">;
  readonly #initialBackoffMs: number;
  readonly #isAccountGenerationCurrent: (generation: number) => boolean;
  readonly #maximumBackoffMs: number;
  readonly #onDelivery: (delivery: CloudInvalidationDelivery) => void;
  readonly #onFatalFailure: (error: Error) => void;
  readonly #onStopped: (reason: CloudInvalidationStopReason) => void;
  readonly #sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  #controller: AbortController | null = null;
  #generation = 0;
  #loop: Promise<void> | null = null;

  constructor(options: CloudInvalidationCoordinatorOptions) {
    this.#client = options.client;
    this.#initialBackoffMs = positiveDelay(
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      "initial invalidation backoff",
    );
    this.#maximumBackoffMs = positiveDelay(
      options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS,
      "maximum invalidation backoff",
    );
    if (this.#maximumBackoffMs < this.#initialBackoffMs) {
      throw new TypeError("maximum invalidation backoff cannot be smaller than initial backoff");
    }
    this.#isAccountGenerationCurrent =
      options.isAccountGenerationCurrent;
    this.#onDelivery = options.onDelivery;
    this.#onFatalFailure = options.onFatalFailure ?? (() => undefined);
    this.#onStopped = options.onStopped ?? (() => undefined);
    this.#sleep = options.sleep ?? abortableSleep;
  }

  start(input: StartCloudInvalidationsInput): void {
    if (
      !Number.isSafeInteger(input.accountGeneration) ||
      input.accountGeneration < 0 ||
      !Number.isSafeInteger(input.afterProjectionHead) ||
      input.afterProjectionHead < 0
    ) {
      throw new TypeError("invalidation generations must be nonnegative safe integers");
    }
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const generation = this.#generation + 1;
    this.#generation = generation;
    const loop = this.#supervise(generation, controller.signal, input);
    this.#loop = loop;
    void loop.then(() => {
      if (this.#loop === loop) this.#loop = null;
      if (this.#controller === controller) this.#controller = null;
    });
  }

  async stop(): Promise<void> {
    const loop = this.#loop;
    if (loop === null) return;
    this.closeAdmission();
    await loop;
  }

  /** Cancels only this read stream and prevents its current generation resuming. */
  closeAdmission(): void {
    this.#controller?.abort();
  }

  async #supervise(
    generation: number,
    signal: AbortSignal,
    input: StartCloudInvalidationsInput,
  ): Promise<void> {
    try {
      await this.#run(generation, signal, input);
    } catch (cause: unknown) {
      if (signal.aborted || generation !== this.#generation) return;
      try {
        if (!this.#isAccountGenerationCurrent(input.accountGeneration)) return;
      } catch {
        // Preserve the loop's original failure when the generation predicate
        // itself can no longer be evaluated safely.
      }
      const failure = cause instanceof Error
        ? cause
        : new Error("Cloud invalidation loop failed.", { cause });
      // This callback is deliberately synchronous: the active generation is
      // fenced before any later JS turn can reuse its dead coordinator. The
      // managed loop itself always resolves, even when the recovery sink fails.
      try {
        this.#onFatalFailure(failure);
      } catch {
        // The original failure remains the authoritative recovery evidence.
      }
    }
  }

  async #run(
    generation: number,
    signal: AbortSignal,
    input: StartCloudInvalidationsInput,
  ): Promise<void> {
    let afterProjectionHead = input.afterProjectionHead;
    let cursor: HRAProjectionCursor | undefined;
    const cursorTokens = new Set<string>();
    let backoffMs = this.#initialBackoffMs;
    while (!signal.aborted && generation === this.#generation) {
      if (!this.#isAccountGenerationCurrent(input.accountGeneration)) {
        this.#notifyStopped(generation, "generation_changed");
        return;
      }
      const result = await this.#client.pollInvalidations(input.workspaceId, {
        afterProjectionHead,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
        waitMs: 25_000,
        signal,
      });
      if (
        signal.aborted ||
        generation !== this.#generation
      ) {
        this.#notifyStopped(generation, "cancelled");
        return;
      }
      if (!this.#isAccountGenerationCurrent(input.accountGeneration)) {
        this.#notifyStopped(generation, "generation_changed");
        return;
      }
      if (!result.ok) {
        if (terminalAuthenticationFailure(result)) {
          this.#notifyStopped(generation, "authentication_failed");
          return;
        }
        await this.#sleep(backoffMs, signal);
        backoffMs = Math.min(this.#maximumBackoffMs, backoffMs * 2);
        continue;
      }

      const page: HRAInvalidationPage = result.data;
      if (page.projectionHead < afterProjectionHead) {
        await this.#sleep(backoffMs, signal);
        backoffMs = Math.min(this.#maximumBackoffMs, backoffMs * 2);
        continue;
      }
      // No await is allowed between this fence and the synchronous reducer.
      if (
        signal.aborted ||
        generation !== this.#generation ||
        !this.#isAccountGenerationCurrent(input.accountGeneration)
      ) {
        this.#notifyStopped(generation, "generation_changed");
        return;
      }
      if (
        page.invalidations.length > 0 ||
        page.projectionHead > afterProjectionHead
      ) {
        this.#onDelivery({
          accountGeneration: input.accountGeneration,
          workspaceId: input.workspaceId,
          previousProjectionHead: afterProjectionHead,
          projectionHead: page.projectionHead,
          invalidations: page.invalidations,
          pageComplete: !page.hasMore,
        });
      }
      backoffMs = this.#initialBackoffMs;
      if (page.hasMore) {
        if (page.cursor === null) {
          await this.#sleep(backoffMs, signal);
          continue;
        }
        if (cursorTokens.has(page.cursor.token)) {
          cursor = undefined;
          cursorTokens.clear();
          await this.#sleep(backoffMs, signal);
          continue;
        }
        cursorTokens.add(page.cursor.token);
        cursor = page.cursor;
        continue;
      }
      cursor = undefined;
      cursorTokens.clear();
      afterProjectionHead = page.projectionHead;
    }
    this.#notifyStopped(generation, "cancelled");
  }

  #notifyStopped(
    generation: number,
    reason: CloudInvalidationStopReason,
  ): void {
    if (generation === this.#generation) this.#onStopped(reason);
  }
}
