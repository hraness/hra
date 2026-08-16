import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  parseRuntimeDispatchRequest,
  parseRuntimeSnapshotResponse,
  parseRuntimeTaskDispatchRequest,
  runtimeChatTurnPromptUtf8ByteLimit,
  runtimeDispatchCommand,
  runtimeNativeBridgeRequestUtf8ByteLimit,
  runtimeProtocolVersion,
} from "./runtime";

const safeSnapshot = {
  revision: 1,
  lastSequence: 0,
  runtime: { state: "ready", generation: 1 },
  runner: { state: "connected" },
  accounts: [],
  retainedAccountLocalData: [],
  humanAccount: { state: "signedOut", revision: 0 },
  chat: { revision: 1, panes: [] },
} as const;

test("gateway-private snapshot fields are rejected for every JSON value", () => {
  assertProperty(fc.property(
    fc.constantFrom(
      "usage",
      "models",
      "projects",
      "workspaceLanes",
      "threads",
      "items",
      "interactions",
      "compatibilityFaults",
      "paths",
      "commands",
      "output",
      "taskListPage",
      "taskDetail",
    ),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseRuntimeSnapshotResponse({
        version: runtimeProtocolVersion,
        snapshot: { ...safeSnapshot, [key]: value },
      })).toThrow();
    },
  ));
});

test("gateway-private command families are rejected for arbitrary renderer payloads", () => {
  assertProperty(fc.property(
    fc.constantFrom(
      "project.register",
      "project.inspect",
      "workspace.choosePath",
      "session.start",
      "thread.list",
      "thread.start",
      "thread.fork",
      "turn.start",
      "turn.steer",
      "prompt.submit",
      "interaction.answer",
      "run.internal",
      "task.internal",
    ),
    fc.dictionary(fc.string({ maxLength: 24 }), fc.jsonValue()),
    (type, payload) => {
      expect(() => parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_12345678",
        command: { ...payload, type },
      })).toThrow();
    },
  ));
});

test("chat commands reject every unknown renderer field and arbitrary model", () => {
  assertProperty(fc.property(
    fc.constantFrom("path", "threadId", "provider", "model", "usage", "approval"),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_propertychat01",
        command: {
          type: "chat.pane.create",
          paneId: "pane_property01",
          repositoryId: "repo_00000000000000000000000000",
          accountProfileId: null,
          reasoningEffort: "ultra",
          [key]: value,
        },
      })).toThrow();
    },
  ));
});

test("turn stop carries only pane revision and logical-turn authority", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc.constantFrom("path", "threadId", "provider", "providerTurnId", "model", "steer"),
    fc.jsonValue(),
    (expectedRevision, key, value) => {
      const command = {
        type: "chat.turn.stop",
        paneId: "pane_propertystop01",
        expectedRevision,
        turnId: "chatturn_propertystop01",
      } as const;
      expect(parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_propertystop01",
        command,
      }).command).toEqual(command);
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_propertystop02",
        command: { ...command, [key]: value },
      })).toThrow();
    },
  ));
});

test("turn Retry is prompt-free and binds distinct failed and fresh turn identities", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc.constantFrom(
      "prompt",
      "path",
      "threadId",
      "provider",
      "providerTurnId",
      "model",
      "history",
    ),
    fc.jsonValue(),
    (expectedRevision, key, value) => {
      const command = {
        type: "chat.turn.retry",
        paneId: "pane_propertyretry01",
        expectedRevision,
        priorFailedTurnId: "chatturn_propertyfailed01",
        turnId: "chatturn_propertyretry01",
      } as const;
      expect(parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_propertyretry01",
        command,
      }).command).toEqual(command);
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_propertyretry02",
        command: { ...command, [key]: value },
      })).toThrow();
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_propertyretry03",
        command: {
          ...command,
          turnId: command.priorFailedTurnId,
        },
      })).toThrow();
    },
  ));
});

test("every accepted prompt remains below the whole Native request ceiling", () => {
  const encodedOuterRequestBytes = (prompt: string): number => {
    const payload = parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_promptbound01",
      command: {
        type: "chat.turn.start",
        paneId: "pane_promptbound01",
        expectedRevision: 1,
        turnId: "chatturn_promptbound01",
        prompt,
      },
    });
    const outerRequest = `${JSON.stringify({
      id: "x".repeat(64),
      command: runtimeDispatchCommand,
      payload,
    })}\n`;
    return new TextEncoder().encode(outerRequest).byteLength;
  };

  expect(encodedOuterRequestBytes(
    "\u0001".repeat(runtimeChatTurnPromptUtf8ByteLimit),
  )).toBeLessThan(runtimeNativeBridgeRequestUtf8ByteLimit);

  assertProperty(fc.property(
    fc.constantFrom("\u0001", "\n", "\"", "\\", "a", "🙂"),
    fc.integer({ min: 1, max: runtimeChatTurnPromptUtf8ByteLimit }),
    (unit, requestedUtf8Bytes) => {
      const unitUtf8Bytes = new TextEncoder().encode(unit).byteLength;
      const unitCount = Math.floor(requestedUtf8Bytes / unitUtf8Bytes);
      const remainder = requestedUtf8Bytes - unitCount * unitUtf8Bytes;
      const prompt = `${unit.repeat(unitCount)}${"a".repeat(remainder)}`;
      expect(encodedOuterRequestBytes(prompt))
        .toBeLessThan(runtimeNativeBridgeRequestUtf8ByteLimit);
    },
  ));
});
