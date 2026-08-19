import {
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
} from "@hraness/agent-tasks-protocol";

import type { CodexServerRequest } from "../codex";

export const MAX_SESSION_DISPLAY_DELTA_UTF8_BYTES =
  MAX_RUN_DISPLAY_EVENTS * MAX_RUN_DISPLAY_TEXT_UTF8_BYTES;

export function isBoundedSessionDisplayText(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_DISPLAY_DELTA_UTF8_BYTES &&
    new TextEncoder().encode(value).byteLength <= MAX_SESSION_DISPLAY_DELTA_UTF8_BYTES;
}

export type SessionTurnActivityKind =
  | "running"
  | "planning"
  | "editing"
  | "testing"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "reasoning_summary_delta"
  | "assistant_message_delta"
  | "tool_activity_started"
  | "tool_activity_completed";

interface ParsedSessionTurnActivityBase {
  readonly threadId: string;
  readonly turnId: string;
}

export type ParsedSessionTurnActivity =
  | (ParsedSessionTurnActivityBase & Readonly<{
      kind: Exclude<SessionTurnActivityKind,
        | "reasoning_summary_delta"
        | "assistant_message_delta"
        | "tool_activity_started"
        | "tool_activity_completed">;
    }>)
  | (ParsedSessionTurnActivityBase & Readonly<{
      kind: "reasoning_summary_delta";
      displayText: string;
      providerItemId: string;
      summaryIndex: number;
    }>)
  | (ParsedSessionTurnActivityBase & Readonly<{
      kind: "assistant_message_delta";
      displayText: string;
      providerItemId: string;
    }>)
  | (ParsedSessionTurnActivityBase & Readonly<{
      kind: "tool_activity_started" | "tool_activity_completed";
      providerItemId: string;
    }>);

type SessionTurnStatusActivityKind = Exclude<SessionTurnActivityKind,
  | "reasoning_summary_delta"
  | "assistant_message_delta"
  | "tool_activity_started"
  | "tool_activity_completed">;

/**
 * v2 interaction requests identify the exact turn. Legacy approval callbacks
 * expose only a conversation ID, so they intentionally do not produce cloud
 * activity rather than guessing which turn owns them.
 */
export function projectSessionServerRequestActivity(
  request: CodexServerRequest,
): ParsedSessionTurnActivity | null {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
      return activityFromReference(request.params, "waiting_for_approval");
    case "item/tool/requestUserInput":
      return activityFromReference(request.params, "waiting_for_input");
    case "mcpServer/elicitation/request":
      return request.params.turnId === null
        ? null
        : activityFromReference({
            threadId: request.params.threadId,
            turnId: request.params.turnId,
          }, "waiting_for_input");
    case "applyPatchApproval":
    case "execCommandApproval":
      return null;
  }
}

function activityFromReference(
  value: Readonly<{ readonly threadId: string; readonly turnId: string }>,
  kind: SessionTurnStatusActivityKind,
): ParsedSessionTurnActivity {
  return {
    kind,
    threadId: value.threadId,
    turnId: value.turnId,
  };
}
