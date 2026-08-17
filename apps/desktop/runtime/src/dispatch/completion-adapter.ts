import {
  taskKeySchema,
  uuidV7Schema,
  type IdempotencyKey,
  type SubmitTaskRequest,
  type TaskKey,
} from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";

import type { SessionTurnLifecycle } from "../sessions/session-service";
import type { DispatchBinding } from "../state/dispatch-store";
import type { DispatchCloudFailure, DispatchCloudResult } from "./cloud-client";
import type {
  DispatchFenceGuard,
  DispatchPublicationBarrier,
} from "./coordinator";
import type { DispatchStage, PublicRunEventKind } from "./model";

const SUBMISSION_SUMMARY = "Completed by Codex in HRA and ready for human review.";
const SUBMISSION_NOTE = "The managed Codex turn completed successfully.";

export interface DispatchCompletionStore {
  readByTurn(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
    readonly turnId: string;
  }): DispatchBinding | null;
  readTurnStartingByThread(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
  }): DispatchBinding | null;
  transition(input: {
    readonly runId: string;
    readonly to: DispatchStage;
    readonly failureCode?: string;
  }): DispatchBinding;
  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
  }): { readonly sequence: number };
  hasOpenToolActivity(runId: string): boolean;
  toolActivityEventCount(runId: string): number;
}

export interface DispatchSubmissionPort {
  submitTask(
    taskKey: TaskKey,
    request: SubmitTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<DispatchCloudResult<unknown>>;
}

export type DispatchCompletionDiagnosticCode =
  | "submission_unavailable"
  | "submission_rejected";

export interface DispatchCompletionDiagnostic {
  readonly code: DispatchCompletionDiagnosticCode;
  readonly runId: string;
}

/**
 * Converts owned Codex terminal lifecycle notifications into durable dispatch
 * terminals. It submits only fixed semantic evidence; transcript text, command
 * output, provider IDs, and local paths never cross this boundary.
 */
export class DispatchCompletionAdapter {
  readonly #cloud: DispatchSubmissionPort;
  readonly #fence: DispatchFenceGuard;
  readonly #publication: DispatchPublicationBarrier;
  readonly #store: DispatchCompletionStore;
  readonly #onDiagnostic: (diagnostic: DispatchCompletionDiagnostic) => void;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, SessionTurnLifecycle>();

  constructor(options: {
    readonly cloud: DispatchSubmissionPort;
    readonly fence: DispatchFenceGuard;
    readonly publication: DispatchPublicationBarrier;
    readonly store: DispatchCompletionStore;
    readonly onDiagnostic?: (diagnostic: DispatchCompletionDiagnostic) => void;
  }) {
    this.#cloud = options.cloud;
    this.#fence = options.fence;
    this.#publication = options.publication;
    this.#store = options.store;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  observe(event: SessionTurnLifecycle): void {
    if (event.status === "inProgress") return;
    const key = lifecycleKey(event);
    this.#pending.set(key, event);
    this.#start(key, event);
  }

  retryPending(): void {
    for (const [key, event] of this.#pending) this.#start(key, event);
  }

  hasUnsettledWork(): boolean {
    return this.#inFlight.size > 0;
  }

  #start(key: string, event: SessionTurnLifecycle): void {
    if (this.#inFlight.has(key)) return;
    const task = this.reconcile(event).then((settled) => {
      if (settled) this.#pending.delete(key);
    }).finally(() => {
      if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, task);
    void task.catch(() => undefined);
  }

  async reconcile(event: SessionTurnLifecycle): Promise<boolean> {
    if (event.status === "inProgress") return true;
    const binding = this.#store.readByTurn(event);
    if (binding === null) {
      // SessionService can synchronously emit a terminal notification while
      // turn/start is resolving, before the coordinator can persist turnId.
      // Retain only an exact dispatch-owned turn_starting lifecycle; unrelated
      // account activity is discarded immediately.
      return this.#store.readTurnStartingByThread(event) === null;
    }
    if (isTerminal(binding.stage)) {
      return binding.lastEventSequence < 1 || await this.#publication.acknowledgeThrough(
        binding.runId,
        binding.lastEventSequence,
      );
    }
    if (binding.stage !== "running" && binding.stage !== "waiting") return true;
    if (!(await this.#hasFence(binding))) {
      await this.#terminal(binding, "lease_lost", "run.lease_lost", 8);
      return true;
    }
    // A terminal provider lifecycle ends anonymous tool timing even when the
    // following task submission must be retried or rejected as changed input.
    // The durable close also orders ahead of an immediately resolved submit.
    this.#closeOpenToolActivity(binding.runId);

    switch (event.status) {
      case "failed":
        return await this.#terminal(binding, "failed", "run.failed", 9, "codex_turn_failed");
      case "interrupted":
        return await this.#terminal(binding, "cancelled", "run.cancelled", 7);
      case "completed":
        return await this.#submit(binding);
    }
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  async #submit(binding: DispatchBinding): Promise<boolean> {
    const taskKey = taskKeySchema.safeParse(binding.taskKey);
    if (!taskKey.success) {
      return await this.#terminal(binding, "failed", "run.failed", 9, "missing_task_key");
    }
    const request = {
      fence: binding.claimFence,
      expectedReviewRevision: binding.inputReviewRevision,
      dispatch: {
        runId: binding.runId,
        runnerId: binding.runtimePublicId,
        bootId: binding.runtimeBootId,
        claimId: binding.claimId,
        claimFence: binding.claimFence,
      },
      summary: SUBMISSION_SUMMARY,
      evidence: [{ kind: "note", text: SUBMISSION_NOTE }],
    } as const satisfies SubmitTaskRequest;
    const result = await this.#cloud.submitTask(
      taskKey.data,
      request,
      deterministicSubmissionIdempotencyKey(binding),
    );
    // A previously queued activity callback can clear its fence while the
    // cloud request is in flight. Re-close at the outcome boundary so every
    // completed-turn disposition observes a balanced durable tool stream.
    this.#closeOpenToolActivity(binding.runId);
    if (result.ok) {
      return await this.#terminal(binding, "completed", "run.submitted", 6);
    }
    if (isFenceFailure(result.error)) {
      await this.#terminal(binding, "lease_lost", "run.lease_lost", 8);
      return true;
    }
    if (isInputChangedFailure(result.error)) {
      this.#onDiagnostic({ code: "submission_rejected", runId: binding.runId });
      return await this.#waitForChangedInput(binding);
    }
    if (isRetryableFailure(result.error)) {
      this.#onDiagnostic({ code: "submission_unavailable", runId: binding.runId });
      return false;
    }
    this.#onDiagnostic({ code: "submission_rejected", runId: binding.runId });
    return await this.#terminal(
      binding,
      "failed",
      "run.failed",
      9,
      result.error.kind === "remote"
        ? `submission_${result.error.code.toLowerCase()}`
        : "submission_rejected",
    );
  }

  #hasFence(binding: DispatchBinding): Promise<boolean> {
    return this.#fence.assertCurrent({
      claimFence: binding.claimFence,
      claimId: binding.claimId,
      runId: binding.runId,
      runtimeBootId: binding.runtimeBootId,
      runtimePublicId: binding.runtimePublicId,
    });
  }

  async #waitForChangedInput(binding: DispatchBinding): Promise<boolean> {
    if (binding.stage !== "waiting") {
      this.#store.transition({
        runId: binding.runId,
        to: "waiting",
        failureCode: "input_changed",
      });
    }
    const event = this.#store.appendPublicEvent({
      runId: binding.runId,
      eventId: `${binding.runId}:input_changed`,
      kind: "codex.waiting_for_input",
    });
    return await this.#publication.acknowledgeThrough(binding.runId, event.sequence);
  }

  async #terminal(
    binding: DispatchBinding,
    stage: "completed" | "failed" | "cancelled" | "lease_lost",
    kind: "run.submitted" | "run.failed" | "run.cancelled" | "run.lease_lost",
    ordinal: 6 | 7 | 8 | 9,
    failureCode?: string,
  ): Promise<boolean> {
    this.#closeOpenToolActivity(binding.runId);
    this.#store.transition({
      runId: binding.runId,
      to: stage,
      ...(failureCode === undefined ? {} : { failureCode }),
    });
    const event = this.#store.appendPublicEvent({
      runId: binding.runId,
      eventId: `${binding.runId}:${String(ordinal)}`,
      kind,
    });
    return await this.#publication.acknowledgeThrough(
      binding.runId,
      event.sequence,
    );
  }

  /**
   * Terminal publication is the final durable ordering barrier for the turn.
   * SessionService emits a synthetic tool completion before its lifecycle, but
   * the two projection callbacks are intentionally asynchronous and may race.
   * Closing from durable state makes the public stream valid regardless of
   * callback timing; a later provider completion is suppressed as an orphan.
   */
  #closeOpenToolActivity(runId: string): void {
    if (!this.#store.hasOpenToolActivity(runId)) return;
    const activityEventCount = this.#store.toolActivityEventCount(runId);
    this.#store.appendPublicEvent({
      runId,
      // Key the synthetic close to the currently open span. A retryable cloud
      // submission can overlap a previously queued activity callback; if that
      // callback opens another span, its later close must not replay the first
      // span's immutable event ID.
      eventId: `${runId}:terminal_tool_activity_completed:${String(activityEventCount)}`,
      kind: "codex.tool_activity.completed",
    });
    if (this.#store.hasOpenToolActivity(runId)) {
      throw new Error("Terminal dispatch could not close durable tool activity");
    }
  }
}

export function deterministicSubmissionIdempotencyKey(
  binding: Pick<DispatchBinding, "createdAt" | "runId">,
): IdempotencyKey {
  const timestamp = Date.parse(binding.createdAt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new TypeError("dispatch creation timestamp cannot form a UUIDv7 idempotency key");
  }
  const bytes = new Uint8Array(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  const entropy = createHash("sha256")
    .update(`kitchen-task-submission-v1:${binding.runId}`)
    .digest();
  bytes[6] = 0x70 | ((entropy[0] ?? 0) & 0x0f);
  bytes[7] = entropy[1] ?? 0;
  bytes[8] = 0x80 | ((entropy[2] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index += 1) {
    bytes[index] = entropy[index - 6] ?? 0;
  }
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return uuidV7Schema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function lifecycleKey(event: SessionTurnLifecycle): string {
  return `${event.accountProfileId}\u0000${event.threadId}\u0000${event.turnId}`;
}

function isTerminal(stage: DispatchStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "cancelled" || stage === "lease_lost";
}

function isFenceFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "remote" && (
    failure.code === "CLAIM_STALE" ||
    failure.code === "CLAIM_NOT_OWNED" ||
    failure.code === "LEASE_NOT_RENEWABLE"
  );
}

function isInputChangedFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "remote" && (
    failure.code === "TASK_STATE_CONFLICT" || failure.code === "TASK_BLOCKED"
  );
}

function isRetryableFailure(failure: DispatchCloudFailure): boolean {
  return failure.kind === "aborted" ||
    failure.kind === "network" ||
    failure.kind === "timeout" ||
    failure.kind === "invalid_response" ||
    (failure.kind === "remote" && (
      failure.code === "RATE_LIMITED" ||
      failure.code === "SERVICE_UNAVAILABLE" ||
      failure.code === "INTERNAL_ERROR"
    ));
}
