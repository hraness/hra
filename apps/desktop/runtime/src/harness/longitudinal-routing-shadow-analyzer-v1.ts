import { z } from "@hra-internal/schema";

import { chatPaneIdSchema } from "../../../contracts/runtime";
import {
  longitudinalRoutingInspectionSchema,
  type LongitudinalRoutingInspectionV1,
} from "./longitudinal-routing-v1";

export const HRA_LONGITUDINAL_ROUTING_SHADOW_ANALYSIS_INTERVAL_MS = 5_000;
export const HRA_LONGITUDINAL_ROUTING_SHADOW_ANALYSIS_BACKOFF_MS = 1_000;
export const HRA_LONGITUDINAL_ROUTING_SHADOW_ANALYSIS_MAX_BACKOFF_MS = 60_000;

const durationSchema = z.number().int().min(1).max(60_000);
const observationRevisionSchema = z.number().int().nonnegative().safe();
const dirtyPaneHeadSchema = z.object({
  paneId: chatPaneIdSchema,
  observationRevision: observationRevisionSchema,
}).strict();
const dirtyPanePageSchema = z.array(dirtyPaneHeadSchema).max(1);

export interface LongitudinalRoutingDirtyPaneHeadV1 {
  readonly paneId: string;
  readonly observationRevision: number;
}

/** Content-free SQLite authority. Every operation is synchronous and bounded. */
export interface LongitudinalRoutingShadowAnalysisAuthorityPortV1 {
  listDirtyPaneHeads(input: Readonly<{
    limit: 1;
    afterPaneId?: string;
  }>): readonly LongitudinalRoutingDirtyPaneHeadV1[];
  inspectPane(paneId: string): LongitudinalRoutingInspectionV1;
  acknowledgeAnalyzedPane(input: Readonly<{
    paneId: string;
    expectedObservationRevision: number;
    inspection: LongitudinalRoutingInspectionV1;
  }>): boolean;
}

export interface LongitudinalRoutingShadowAnalysisIdleGateV1 {
  /** Foreground ownership is process-local, so the gate must be synchronous. */
  isIdle(): boolean;
}

export interface LongitudinalRoutingShadowAnalysisTimerV1 {
  cancel(): void;
}

export interface LongitudinalRoutingShadowAnalysisSchedulerV1 {
  schedule(
    callback: () => void,
    delayMilliseconds: number,
  ): LongitudinalRoutingShadowAnalysisTimerV1;
}

export interface HarnessLongitudinalRoutingShadowAnalyzerV1Options {
  readonly authority: LongitudinalRoutingShadowAnalysisAuthorityPortV1;
  readonly idle: LongitudinalRoutingShadowAnalysisIdleGateV1;
  readonly scheduler?: LongitudinalRoutingShadowAnalysisSchedulerV1;
  readonly analysisIntervalMs?: number;
  readonly retryBackoffMs?: number;
  readonly maximumRetryBackoffMs?: number;
  readonly onFault?: (error: Error) => void;
}

/**
 * Advances at most one content-free pane summary on each idle tick. This pump
 * has no model, provider, filesystem, Git, proposal, or policy-activation port.
 */
export class HarnessLongitudinalRoutingShadowAnalyzerV1 {
  readonly #authority: LongitudinalRoutingShadowAnalysisAuthorityPortV1;
  readonly #idle: LongitudinalRoutingShadowAnalysisIdleGateV1;
  readonly #scheduler: LongitudinalRoutingShadowAnalysisSchedulerV1;
  readonly #analysisIntervalMs: number;
  readonly #retryBackoffMs: number;
  readonly #maximumRetryBackoffMs: number;
  readonly #onFault: (error: Error) => void;
  #started = false;
  #closed = false;
  #timer: LongitudinalRoutingShadowAnalysisTimerV1 | null = null;
  #tickInProgress = false;
  #tickSettlement: Promise<void> | null = null;
  #resolveTickSettlement: (() => void) | null = null;
  #consecutiveFailures = 0;
  #lastAttemptedPaneId: string | null = null;

  constructor(options: HarnessLongitudinalRoutingShadowAnalyzerV1Options) {
    this.#authority = options.authority;
    this.#idle = options.idle;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#analysisIntervalMs = durationSchema.parse(
      options.analysisIntervalMs ??
        HRA_LONGITUDINAL_ROUTING_SHADOW_ANALYSIS_INTERVAL_MS,
    );
    this.#retryBackoffMs = durationSchema.parse(
      options.retryBackoffMs ??
        HRA_LONGITUDINAL_ROUTING_SHADOW_ANALYSIS_BACKOFF_MS,
    );
    this.#maximumRetryBackoffMs = durationSchema.parse(
      options.maximumRetryBackoffMs ??
        HRA_LONGITUDINAL_ROUTING_SHADOW_ANALYSIS_MAX_BACKOFF_MS,
    );
    if (this.#retryBackoffMs > this.#maximumRetryBackoffMs) {
      throw new RangeError(
        "routing shadow-analysis retry backoff exceeds its maximum",
      );
    }
    this.#onFault = options.onFault ?? (() => undefined);
  }

  /** Starts the first timer only after the lifecycle kernel finishes recovery. */
  startAfterRecovery(): void {
    if (this.#closed) {
      throw new Error("routing shadow analysis is closed");
    }
    if (this.#started) return;
    this.#started = true;
    this.#arm(this.#analysisIntervalMs);
  }

  /** Synchronously prevents another timer callback from being admitted. */
  closeAdmission(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#timer?.cancel();
    this.#timer = null;
  }

  /** Joins the one already-admitted synchronous pass, if one exists. */
  settled(): Promise<void> {
    return this.#tickSettlement ?? Promise.resolve();
  }

  #arm(delayMilliseconds: number): void {
    if (this.#closed || this.#timer !== null) return;
    this.#timer = this.#scheduler.schedule(() => {
      this.#timer = null;
      this.#tick();
    }, delayMilliseconds);
  }

  #tick(): void {
    if (this.#closed || this.#tickInProgress) return;
    this.#tickInProgress = true;
    this.#tickSettlement = new Promise<void>((resolve) => {
      this.#resolveTickSettlement = resolve;
    });
    let nextDelay = this.#analysisIntervalMs;
    try {
      if (!this.#idle.isIdle()) {
        this.#consecutiveFailures = 0;
        return;
      }
      const dirty = dirtyPanePageSchema.parse(
        this.#authority.listDirtyPaneHeads({
          limit: 1,
          ...(this.#lastAttemptedPaneId === null
            ? {}
            : { afterPaneId: this.#lastAttemptedPaneId }),
        }),
      );
      const head = dirty[0];
      if (head === undefined) {
        this.#lastAttemptedPaneId = null;
        this.#consecutiveFailures = 0;
        return;
      }
      // Advance before inspection so one malformed pane cannot monopolize the
      // background worker. The authority wraps its keyset cursor exactly once.
      this.#lastAttemptedPaneId = head.paneId;
      const inspection = longitudinalRoutingInspectionSchema.parse(
        this.#authority.inspectPane(head.paneId),
      );
      z.boolean().parse(this.#authority.acknowledgeAnalyzedPane({
        paneId: head.paneId,
        expectedObservationRevision: head.observationRevision,
        inspection,
      }));
      // A false CAS result deliberately leaves the newer revision dirty.
      this.#consecutiveFailures = 0;
    } catch (cause: unknown) {
      this.#consecutiveFailures += 1;
      nextDelay = this.#backoffDelay();
      this.#publishFault(normalizeFailure(cause));
    } finally {
      this.#tickInProgress = false;
      const resolve = this.#resolveTickSettlement;
      this.#resolveTickSettlement = null;
      resolve?.();
      this.#tickSettlement = null;
      if (!this.#closed) this.#arm(nextDelay);
    }
  }

  #backoffDelay(): number {
    const exponent = Math.min(30, this.#consecutiveFailures - 1);
    return Math.min(
      this.#maximumRetryBackoffMs,
      this.#retryBackoffMs * 2 ** exponent,
    );
  }

  #publishFault(error: Error): void {
    try {
      this.#onFault(error);
    } catch {
      // Diagnostics cannot escape the unref'd background callback.
    }
  }
}

const systemScheduler: LongitudinalRoutingShadowAnalysisSchedulerV1 =
  Object.freeze({
    schedule: (callback: () => void, delayMilliseconds: number) => {
      const timer = setTimeout(callback, delayMilliseconds);
      timer.unref?.();
      return Object.freeze({ cancel: () => clearTimeout(timer) });
    },
  });

function normalizeFailure(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("routing shadow analysis failed with a non-Error value", {
      cause,
    });
}
