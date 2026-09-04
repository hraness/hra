/*
 * Tracks each session's turn text and emits `session_state` events.
 *
 * The tracker observes every session event the daemon persists. It
 * accumulates assistant text per active turn (bounded), classifies when the
 * turn completes or when an interaction changes, and hands back a
 * `session_state` body for the daemon to append. It never classifies its own
 * output and it keeps at most one accumulator per session.
 */

import {
  classifySessionState,
  SESSION_STATE_MAX_TEXT_CHARACTERS,
  type PendingInteractionKind,
  type SessionStateClassification,
} from "../domain/session-state";
import type { SessionEventBody } from "../domain/session-events";

export type SessionStateSnapshot = Readonly<{
  state: SessionStateClassification["state"];
  attention: boolean;
  reason: string;
  verbatimRequired: boolean;
  verbatimLiteral: string | undefined;
  lastActivityAt: number;
  revision: number;
}>;

export type SessionStateContext = Readonly<{
  pendingInteraction?: Readonly<{
    kind: PendingInteractionKind;
    requiresUserInteraction?: boolean;
  }>;
  autorespondWillAct?: boolean;
}>;

type TurnAccumulator = {
  turnId: string;
  text: string;
  truncated: boolean;
};

type SessionTracking = {
  active: TurnAccumulator | null;
  lastFinalText: string;
  lastTurnStatus: "completed" | "interrupted" | "failed";
  openSubagents: number;
  revision: number;
  snapshot: SessionStateSnapshot | null;
};

const REASON_MAX_CHARACTERS = 256;

export class SessionStateTracker {
  readonly #sessions = new Map<string, SessionTracking>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  snapshot(sessionId: string): SessionStateSnapshot | null {
    return this.#sessions.get(sessionId)?.snapshot ?? null;
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /*
   * Seed a session's revision counter from durable state after a restart so
   * emitted revisions stay monotonic across daemon lifetimes.
   */
  seed(sessionId: string, snapshot: SessionStateSnapshot): void {
    const tracking = this.#tracking(sessionId);
    tracking.revision = Math.max(tracking.revision, snapshot.revision);
    tracking.snapshot = snapshot;
  }

  /*
   * Observe one persisted event. Returns a `session_state` body when the
   * classification should be (re)emitted, otherwise null.
   */
  observe(
    sessionId: string,
    body: SessionEventBody,
    context: SessionStateContext = {},
  ): Extract<SessionEventBody, { type: "session_state" }> | null {
    const tracking = this.#tracking(sessionId);
    switch (body.type) {
      case "turn_started": {
        tracking.active = { turnId: body.turnId, text: "", truncated: false };
        return this.#emit(sessionId, tracking, this.#working("turn active"));
      }
      case "assistant_delta": {
        if (tracking.active === null) {
          tracking.active = { turnId: body.turnId, text: "", truncated: false };
        }
        const active = tracking.active;
        if (active.turnId !== body.turnId) return null;
        if (active.text.length < SESSION_STATE_MAX_TEXT_CHARACTERS) {
          active.text += body.text;
          if (active.text.length > SESSION_STATE_MAX_TEXT_CHARACTERS) {
            active.text = active.text.slice(-SESSION_STATE_MAX_TEXT_CHARACTERS);
            active.truncated = true;
          }
        }
        return null;
      }
      case "turn_completed": {
        const active = tracking.active;
        tracking.lastFinalText = active !== null && active.turnId === body.turnId ? active.text : "";
        tracking.lastTurnStatus = body.status;
        tracking.active = null;
        return this.#emit(sessionId, tracking, this.#classify(tracking, context));
      }
      case "interaction_requested":
      case "interaction_state": {
        if (tracking.active !== null && context.pendingInteraction === undefined) return null;
        return this.#emit(sessionId, tracking, this.#classify(tracking, context));
      }
      case "session_status": {
        if (body.status === "terminal" || body.status === "system_error") {
          tracking.active = null;
          tracking.lastTurnStatus = body.status === "terminal" ? tracking.lastTurnStatus : "failed";
          return this.#emit(sessionId, tracking, this.#classify(tracking, context));
        }
        return null;
      }
      case "connection":
      case "gap":
      case "item_started":
      case "item_completed":
      case "reasoning_summary_delta":
      case "tool_progress":
      case "file_change":
      case "plan_updated":
      case "diff_updated":
      case "token_usage":
      case "session_state":
      case "warning":
      case "error":
      case "protocol_incompatible":
        return null;
    }
  }

  setOpenSubagents(sessionId: string, count: number): void {
    this.#tracking(sessionId).openSubagents = Math.max(0, Math.floor(count));
  }

  #tracking(sessionId: string): SessionTracking {
    let tracking = this.#sessions.get(sessionId);
    if (tracking === undefined) {
      tracking = {
        active: null,
        lastFinalText: "",
        lastTurnStatus: "completed",
        openSubagents: 0,
        revision: 0,
        snapshot: null,
      };
      this.#sessions.set(sessionId, tracking);
    }
    return tracking;
  }

  #working(reason: string): SessionStateClassification {
    return {
      state: "working",
      attention: false,
      reason,
      verbatimRequired: false,
      matchedRule: "progress_cue",
    };
  }

  #classify(tracking: SessionTracking, context: SessionStateContext): SessionStateClassification {
    return classifySessionState({
      finalAssistantText: tracking.lastFinalText,
      providerTurnStatus: tracking.lastTurnStatus,
      ...(context.pendingInteraction === undefined ? {} : { pendingInteraction: context.pendingInteraction }),
      openSubagents: tracking.openSubagents,
      ...(context.autorespondWillAct === undefined ? {} : { autorespondWillAct: context.autorespondWillAct }),
    });
  }

  #emit(
    sessionId: string,
    tracking: SessionTracking,
    classification: SessionStateClassification,
  ): Extract<SessionEventBody, { type: "session_state" }> | null {
    const previous = tracking.snapshot;
    if (
      previous !== null
      && previous.state === classification.state
      && previous.attention === classification.attention
      && previous.verbatimRequired === classification.verbatimRequired
      && previous.reason === classification.reason.slice(0, REASON_MAX_CHARACTERS)
    ) {
      return null;
    }
    tracking.revision += 1;
    const snapshot: SessionStateSnapshot = {
      state: classification.state,
      attention: classification.attention,
      reason: classification.reason.slice(0, REASON_MAX_CHARACTERS),
      verbatimRequired: classification.verbatimRequired,
      verbatimLiteral: classification.verbatimLiteral,
      lastActivityAt: this.#now(),
      revision: tracking.revision,
    };
    tracking.snapshot = snapshot;
    void sessionId;
    return {
      type: "session_state",
      state: snapshot.state,
      attention: snapshot.attention,
      reason: snapshot.reason,
      verbatimRequired: snapshot.verbatimRequired,
      lastActivityAt: snapshot.lastActivityAt,
      revision: snapshot.revision,
    };
  }
}
