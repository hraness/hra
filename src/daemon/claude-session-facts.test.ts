import { describe, expect, test } from "bun:test";

import type { ProviderInteractionAuthority } from "../domain/interactions";
import type { ProviderAccountAuthority } from "../domain/provider-accounts";
import {
  ClaudeSessionFactTranslator,
  type ClaudeSessionFact,
} from "./claude-session-facts";

const profileId = "acct_00000000000000000000000000000000" as const;
const firstAuthority = {
  bindingGeneration: 3,
  processGeneration: 7,
  profileId,
  provider: "claude",
  providerAccountId: "pact_00000000000000000000000000000001",
} as const satisfies ProviderAccountAuthority;
const replacementAuthority = {
  ...firstAuthority,
  bindingGeneration: 4,
  providerAccountId: "pact_00000000000000000000000000000002",
} as const satisfies ProviderAccountAuthority;
const providerThreadId = "same-thread";
const connectionId = "65000000-0000-4000-8000-000000000001";

const interactionAuthority = (
  authority: ProviderAccountAuthority,
  requestId: string,
): ProviderInteractionAuthority => ({
  approvalId: "same-item",
  bindingGeneration: authority.bindingGeneration,
  connectionId,
  itemId: "same-item",
  method: "claude/control_request/can_use_tool",
  processGeneration: authority.processGeneration,
  profileId: authority.profileId,
  provider: authority.provider,
  providerAccountId: authority.providerAccountId,
  requestDigest: "a".repeat(64),
  requestId: { type: "string", value: requestId },
  threadId: providerThreadId,
  turnId: "same-turn",
});

const translator = (): ClaudeSessionFactTranslator =>
  new ClaudeSessionFactTranslator({
    authorityFor: (authority, _threadId, requestId) =>
      interactionAuthority(authority, requestId),
    now: () => 1,
  });

const assistantDelta = (): ClaudeSessionFact => ({
  connectionId,
  itemId: "same-item",
  providerThreadId,
  text: "safe",
  turnId: "same-turn",
  type: "assistantDelta",
});

const interactionRequested = (requestId: string): ClaudeSessionFact => ({
  blocking: true,
  connectionId,
  display: {
    availableDecisions: ["once", "decline"],
    commandClass: "shell",
    kind: "command_approval",
    reason: null,
    summary: "Run a command",
    workingDirectory: null,
  },
  itemId: "same-item",
  kind: "command_approval",
  providerThreadId,
  request: {
    blockedPath: null,
    decisionReasonType: null,
    description: null,
    displayName: "Shell",
    input: { command: "true" },
    permissionSuggestionCount: 0,
    questions: null,
    requiresUserInteraction: false,
    subtype: "can_use_tool",
    toolName: "Shell",
    toolUseId: "same-item",
  },
  requestId,
  turnId: "same-turn",
  type: "interactionRequested",
});

describe("ClaudeSessionFactTranslator provider authority", () => {
  test("keeps same-thread item lifecycle state isolated across replacement authorities", () => {
    const value = translator();

    expect(value.translate(firstAuthority, assistantDelta()).map((fact) => fact.type))
      .toEqual(["itemStarted", "assistantDelta"]);
    expect(value.translate(replacementAuthority, assistantDelta()).map((fact) => fact.type))
      .toEqual(["itemStarted", "assistantDelta"]);

    value.forgetSession(firstAuthority, providerThreadId);
    expect(value.translate(firstAuthority, assistantDelta()).map((fact) => fact.type))
      .toEqual(["itemStarted", "assistantDelta"]);
    expect(value.translate(replacementAuthority, assistantDelta()).map((fact) => fact.type))
      .toEqual(["assistantDelta"]);
  });

  test("does not consume a same-thread request remembered by another authority", () => {
    const value = translator();
    const requestId = "same-request";
    value.translate(firstAuthority, interactionRequested(requestId));
    value.translate(replacementAuthority, interactionRequested(requestId));

    const canceled = (authority: ProviderAccountAuthority) => value.translate(authority, {
      connectionId,
      providerThreadId,
      requestId,
      type: "interactionCanceled",
    });
    expect(canceled(firstAuthority)[0]).toMatchObject({
      provider: interactionAuthority(firstAuthority, requestId),
      type: "interactionResolved",
    });
    expect(canceled(replacementAuthority)[0]).toMatchObject({
      provider: interactionAuthority(replacementAuthority, requestId),
      type: "interactionResolved",
    });
  });
});
