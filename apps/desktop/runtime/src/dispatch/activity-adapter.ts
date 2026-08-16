import {
  MAX_NONTERMINAL_RUN_EVENTS,
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_TOOL_ACTIVITY_EVENTS,
} from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";

import type { SessionTurnActivity } from "../sessions/session-service";
import type {
  DispatchBinding,
  PendingDispatchEvent,
} from "../state/dispatch-store";
import type { DispatchFenceGuard } from "./coordinator";
import {
  canTransitionDispatch,
  type DispatchStage,
  type PublicRunEventKind,
  type PublicRunStatusEventKind,
  type PublicRunTextEventKind,
} from "./model";

export interface DispatchActivityStore {
  read(runId: string): DispatchBinding | null;
  readByTurn(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
    readonly turnId: string;
  }): DispatchBinding | null;
  latestPublicEvent(runId: string): PendingDispatchEvent | null;
  displayEventCount(runId: string): number;
  toolActivityEventCount(runId: string): number;
  hasOpenToolActivity(runId: string): boolean;
  materializeDisplayDraft(runId: string): PendingDispatchEvent | null;
  transition(input: {
    readonly runId: string;
    readonly to: DispatchStage;
  }): DispatchBinding;
  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunStatusEventKind;
  }): PendingDispatchEvent;
  appendDisplayDelta(input: {
    readonly runId: string;
    readonly kind: PublicRunTextEventKind;
    readonly displayText: string;
  }): number;
}

/**
 * Projects allowlisted Codex activity into the durable semantic outbox. The
 * adapter receives only owned control-plane IDs and a closed activity kind;
 * raw app-server parameters can never reach the store or cloud client.
 */
export class DispatchActivityAdapter {
  readonly #fence: DispatchFenceGuard;
  readonly #store: DispatchActivityStore;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: {
    readonly fence: DispatchFenceGuard;
    readonly store: DispatchActivityStore;
  }) {
    this.#fence = options.fence;
    this.#store = options.store;
  }

  observe(activity: SessionTurnActivity): Promise<void> {
    const key = activityKey(activity);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => await this.#reconcile(activity))
      .finally(() => {
        if (this.#tails.get(key) === task) this.#tails.delete(key);
      });
    this.#tails.set(key, task);
    return task;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#tails.values()]);
  }

  async #reconcile(activity: SessionTurnActivity): Promise<void> {
    let binding = this.#store.readByTurn(activity);
    if (binding === null || !isActivityStage(binding.stage)) return;
    if (!(await this.#hasFence(binding))) return;

    // Re-read after the asynchronous fence check. From this point through the
    // outbox append all mutations are synchronous, so completion cannot race a
    // semantic event onto a terminal binding in the same event-loop turn.
    binding = this.#store.readByTurn(activity);
    if (binding === null || !isActivityStage(binding.stage)) return;

    const latest = this.#store.latestPublicEvent(binding.runId);
    if (binding.lastEventSequence >= MAX_NONTERMINAL_RUN_EVENTS) return;

    if (
      activity.kind === "reasoning_summary_delta" ||
      activity.kind === "assistant_message_delta"
    ) {
      if (binding.stage === "waiting" && canTransitionDispatch(binding.stage, "running")) {
        binding = this.#store.transition({ runId: binding.runId, to: "running" });
      }
      if (
        this.#store.hasOpenToolActivity(binding.runId) &&
        this.#store.displayEventCount(binding.runId) < MAX_RUN_DISPLAY_EVENTS
      ) {
        this.#appendStatus(binding.runId, "codex.tool_activity.completed");
      }
      this.#store.appendDisplayDelta({
        runId: binding.runId,
        kind: activity.kind === "reasoning_summary_delta"
          ? "codex.reasoning_summary.delta"
          : "codex.assistant_message.delta",
        displayText: activity.displayText,
      });
      return;
    }

    const kind = publicKind(activity.kind);
    if (latest?.kind === kind) return;
    const toolActivityOpen = this.#store.hasOpenToolActivity(binding.runId);
    if (kind === "codex.tool_activity.started" && toolActivityOpen) return;
    if (kind === "codex.tool_activity.completed" && !toolActivityOpen) return;
    if (
      toolActivityOpen &&
      kind !== "codex.tool_activity.completed" &&
      binding.lastEventSequence >= MAX_NONTERMINAL_RUN_EVENTS - 1
    ) return;
    if (kind === "codex.tool_activity.started") {
      this.#store.materializeDisplayDraft(binding.runId);
      binding = this.#store.read(binding.runId) ?? binding;
    }
    const displayEventCount = this.#store.displayEventCount(binding.runId);
    const toolActivityEventCount = this.#store.toolActivityEventCount(binding.runId);
    if (
      kind === "codex.tool_activity.started" &&
      (
        displayEventCount > MAX_RUN_DISPLAY_EVENTS - 2 ||
        toolActivityEventCount > MAX_RUN_TOOL_ACTIVITY_EVENTS - 2 ||
        binding.lastEventSequence > MAX_NONTERMINAL_RUN_EVENTS - 2
      )
    ) return;
    if (
      kind === "codex.tool_activity.completed" &&
      (
        displayEventCount >= MAX_RUN_DISPLAY_EVENTS ||
        toolActivityEventCount >= MAX_RUN_TOOL_ACTIVITY_EVENTS
      )
    ) return;

    const desiredStage = desiredStageFor(kind);
    if (binding.stage !== desiredStage) {
      if (!canTransitionDispatch(binding.stage, desiredStage)) return;
      binding = this.#store.transition({ runId: binding.runId, to: desiredStage });
    }
    this.#appendStatus(binding.runId, kind);
  }

  #appendStatus(runId: string, kind: PublicRunStatusEventKind): void {
    this.#store.materializeDisplayDraft(runId);
    const binding = this.#store.read(runId);
    if (binding === null || binding.lastEventSequence >= MAX_NONTERMINAL_RUN_EVENTS) return;
    const nextSequence = binding.lastEventSequence + 1;
    this.#store.appendPublicEvent({
      runId,
      eventId: dispatchActivityEventId(runId, nextSequence, kind),
      kind,
    });
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
}

export function dispatchActivityEventId(
  runId: string,
  sequence: number,
  kind: PublicRunEventKind,
): string {
  const digest = createHash("sha256")
    .update(`kitchen-local-activity-v1:${runId}:${String(sequence)}:${kind}`)
    .digest("hex");
  return `activity_${digest.slice(0, 48)}`;
}

function activityKey(activity: SessionTurnActivity): string {
  return `${activity.accountProfileId}\u0000${activity.threadId}\u0000${activity.turnId}`;
}

function publicKind(
  kind: Exclude<SessionTurnActivity["kind"], "reasoning_summary_delta" | "assistant_message_delta">,
): PublicRunStatusEventKind {
  switch (kind) {
    case "running":
      return "codex.running";
    case "planning":
      return "codex.planning";
    case "editing":
      return "codex.editing";
    case "testing":
      return "codex.testing";
    case "waiting_for_approval":
      return "codex.waiting_for_approval";
    case "waiting_for_input":
      return "codex.waiting_for_input";
    case "tool_activity_started":
      return "codex.tool_activity.started";
    case "tool_activity_completed":
      return "codex.tool_activity.completed";
  }
}

function desiredStageFor(
  kind: PublicRunStatusEventKind,
): Extract<DispatchStage, "running" | "waiting"> {
  return kind === "codex.waiting_for_approval" || kind === "codex.waiting_for_input"
    ? "waiting"
    : "running";
}

function isActivityStage(
  stage: DispatchStage,
): stage is Extract<DispatchStage, "running" | "waiting"> {
  return stage === "running" || stage === "waiting";
}
