import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CodexJsonlWriter,
  PinnedCodexProtocol,
  codexNotificationDispositions,
  codexServerRequestDispositions,
  supportedCodexNotificationMethods,
  supportedCodexServerRequestMethods,
  type CodexJsonlSink,
  type CodexNotification,
  type CodexProtocolDiagnostic,
  type CodexServerRequest,
} from "../src/codex";
import {
  pinnedApplyPatchApprovalFixture,
  pinnedCommandApprovalFixture,
  pinnedExecCommandApprovalFixture,
  pinnedFileChangeApprovalFixture,
  pinnedMcpElicitationFixture,
  pinnedPermissionsApprovalFixture,
  pinnedRateLimitSnapshotFixture,
  pinnedThreadFixture,
  pinnedTurnFixture,
  pinnedUserInputRequestFixture,
} from "./codex-pinned-fixtures";

const decoder = new TextDecoder();

class MemorySink implements CodexJsonlSink {
  readonly writes: string[] = [];

  write(bytes: Uint8Array): number {
    this.writes.push(decoder.decode(bytes));
    return bytes.byteLength;
  }
}

function parseWrites(sink: MemorySink): readonly Record<string, unknown>[] {
  return sink.writes.map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("written envelope is not an object");
    }
    return value as Record<string, unknown>;
  });
}

function generatedMethods(file: "ServerNotification.ts" | "ServerRequest.ts"): string[] {
  const source = readFileSync(resolve(
    import.meta.dir,
    `../../contracts/generated/codex/0.144.6/typescript/${file}`,
  ), "utf8");
  return [...source.matchAll(/\{ "method": "([^"]+)"/gu)].map((match) => {
    const method = match[1];
    if (method === undefined) throw new Error("generated method capture was missing");
    return method;
  });
}

describe("pinned generated inbound parity", () => {
  test("matches every generated notification exactly once", () => {
    const generated = generatedMethods("ServerNotification.ts");
    expect(generated).toHaveLength(69);
    expect(new Set(generated).size).toBe(generated.length);
    expect(Object.keys(codexNotificationDispositions).toSorted()).toEqual(
      generated.toSorted(),
    );
    expect(new Set(supportedCodexNotificationMethods).size).toBe(69);
    expect([...supportedCodexNotificationMethods].map(String).toSorted()).toEqual(
      generated.toSorted(),
    );
  });

  test("matches every generated server request exactly once", () => {
    const generated = generatedMethods("ServerRequest.ts");
    expect(generated).toHaveLength(11);
    expect(new Set(generated).size).toBe(generated.length);
    expect(Object.keys(codexServerRequestDispositions).toSorted()).toEqual(
      generated.toSorted(),
    );
    expect(new Set(supportedCodexServerRequestMethods).size).toBe(7);
    expect(Object.entries(codexServerRequestDispositions)
      .filter(([, disposition]) => disposition === "rejected")
      .map(([method]) => method)
      .toSorted()).toEqual([
        "account/chatgptAuthTokens/refresh",
        "attestation/generate",
        "currentTime/read",
        "item/tool/call",
      ]);
  });
});

const notificationFixtures = [
  {
    method: "account/login/completed",
    params: { loginId: "login-1", success: true, error: "PRIVATE LOGIN ERROR" },
  },
  {
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "plus" },
  },
  {
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: pinnedRateLimitSnapshotFixture.primary } },
  },
  { method: "thread/started", params: { thread: pinnedThreadFixture } },
  {
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  },
  { method: "thread/archived", params: { threadId: "thread-1" } },
  { method: "thread/deleted", params: { threadId: "thread-1" } },
  { method: "thread/unarchived", params: { threadId: "thread-1" } },
  { method: "thread/closed", params: { threadId: "thread-1" } },
  { method: "thread/name/updated", params: { threadId: "thread-1" } },
  { method: "turn/started", params: { threadId: "thread-1", turn: pinnedTurnFixture } },
  { method: "turn/completed", params: { threadId: "thread-1", turn: pinnedTurnFixture } },
  {
    method: "turn/plan/updated",
    params: { threadId: "thread-1", turnId: "turn-1", explanation: null, plan: [] },
  },
  {
    method: "item/fileChange/patchUpdated",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", changes: [] },
  },
  {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "fileChange", id: "item-1", changes: [], status: "inProgress" },
      startedAtMs: 1_700_000_000_000,
    },
  },
  {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-1",
        text: "Done",
        phase: "final_answer",
        memoryCitation: null,
      },
      completedAtMs: 1_700_000_000_001,
    },
  },
  {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "a" },
  },
  {
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "b" },
  },
  {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "summary",
      summaryIndex: 0,
    },
  },
  {
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "PRIVATE REASONING",
      contentIndex: 0,
    },
  },
  {
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "request-1" },
  },
] as const;

const invalidNotificationFixtures = [
  { method: "account/login/completed", params: { loginId: "login-1", success: "yes", error: null } },
  { method: "account/updated", params: { authMode: "future", planType: null } },
  { method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 101 } } } },
  { method: "thread/started", params: { thread: { ...pinnedThreadFixture, cwd: "relative" } } },
  { method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "future" } } },
  { method: "thread/archived", params: { threadId: "" } },
  { method: "thread/deleted", params: { threadId: "" } },
  { method: "thread/unarchived", params: { threadId: "" } },
  { method: "thread/closed", params: { threadId: "", extra: true } },
  { method: "thread/name/updated", params: { threadId: "thread-1", threadName: null } },
  { method: "turn/started", params: { threadId: "thread-1", turn: { ...pinnedTurnFixture, startedAt: -1 } } },
  { method: "turn/completed", params: { threadId: "", turn: pinnedTurnFixture } },
  { method: "turn/plan/updated", params: { threadId: "", turnId: "turn-1" } },
  { method: "item/fileChange/patchUpdated", params: { threadId: "thread-1", turnId: "" } },
  { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "future", id: "item-1" } } },
  { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "" } } },
  { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "", delta: "a" } },
  { method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId: "", itemId: "item-1", delta: "a" } },
  { method: "item/reasoning/summaryTextDelta", params: { threadId: "", turnId: "turn-1", itemId: "item-1", delta: "a" } },
  { method: "item/reasoning/textDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "secret", contentIndex: -1 } },
  { method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: null } },
] as const;

describe("pinned Codex notifications", () => {
  test("parses every routed/control/discarded shape once and strips ignored data", async () => {
    const sink = new MemorySink();
    const observed: CodexNotification[] = [];
    const protocol = new PinnedCodexProtocol(11, new CodexJsonlWriter(sink), {
      onNotification: (notification) => { observed.push(notification); },
    });
    for (const fixture of notificationFixtures) {
      await protocol.receiveValue(11, fixture);
    }
    await protocol.receiveValue(11, {
      method: "error",
      params: { secret: "IGNORED PRIVATE PROVIDER ERROR" },
    });

    expect(observed).toHaveLength(notificationFixtures.length + 1);
    expect(observed.map(({ streamPosition }) => streamPosition)).toEqual(
      Array.from({ length: notificationFixtures.length + 1 }, (_, index) => index + 1),
    );
    expect(observed.find(({ method }) => method === "item/reasoning/textDelta")?.params)
      .toBeUndefined();
    expect(observed.find(({ method }) => method === "error")?.params).toBeUndefined();
    expect(JSON.stringify(observed)).not.toContain("PRIVATE");
  });

  test("rejects every malformed routed/control/discarded shape terminally", async () => {
    for (const [index, fixture] of invalidNotificationFixtures.entries()) {
      const diagnostics: CodexProtocolDiagnostic[] = [];
      const observed: CodexNotification[] = [];
      const protocol = new PinnedCodexProtocol(
        100 + index,
        new CodexJsonlWriter(new MemorySink()),
        {
          onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
          onNotification: (notification) => { observed.push(notification); },
        },
      );
      await protocol.receiveValue(100 + index, fixture);
      expect(observed).toHaveLength(0);
      expect(diagnostics).toEqual([{
        type: "invalid_inbound_payload",
        generation: 100 + index,
        source: "notification",
        method: fixture.method,
      }]);
      expect(protocol.request("accountRead", { refreshToken: false })).rejects.toThrow(
        "generation has ended",
      );
    }
  });
});

const serverRequestFixtures = [
  { method: "item/commandExecution/requestApproval", params: pinnedCommandApprovalFixture },
  { method: "item/fileChange/requestApproval", params: pinnedFileChangeApprovalFixture },
  { method: "item/tool/requestUserInput", params: pinnedUserInputRequestFixture },
  { method: "mcpServer/elicitation/request", params: pinnedMcpElicitationFixture },
  { method: "item/permissions/requestApproval", params: pinnedPermissionsApprovalFixture },
  { method: "applyPatchApproval", params: pinnedApplyPatchApprovalFixture },
  { method: "execCommandApproval", params: pinnedExecCommandApprovalFixture },
] as const;

const invalidServerRequestFixtures = [
  {
    method: "item/commandExecution/requestApproval",
    params: { ...pinnedCommandApprovalFixture, environmentId: undefined },
  },
  {
    method: "item/fileChange/requestApproval",
    params: { ...pinnedFileChangeApprovalFixture, grantRoot: "relative" },
  },
  {
    method: "item/tool/requestUserInput",
    params: { ...pinnedUserInputRequestFixture, questions: [] },
  },
  {
    method: "item/tool/requestUserInput",
    params: {
      ...pinnedUserInputRequestFixture,
      questions: [{ ...pinnedUserInputRequestFixture.questions[0], id: "__proto__" }],
    },
  },
  {
    method: "item/tool/requestUserInput",
    params: {
      ...pinnedUserInputRequestFixture,
      questions: [
        pinnedUserInputRequestFixture.questions[0],
        { ...pinnedUserInputRequestFixture.questions[0], header: "Duplicate" },
      ],
    },
  },
  {
    method: "mcpServer/elicitation/request",
    params: { ...pinnedMcpElicitationFixture, mode: "future" },
  },
  {
    method: "item/permissions/requestApproval",
    params: { ...pinnedPermissionsApprovalFixture, cwd: "relative" },
  },
  {
    method: "applyPatchApproval",
    params: { conversationId: "thread-1", callId: "call-1" },
  },
  {
    method: "execCommandApproval",
    params: { ...pinnedExecCommandApprovalFixture, command: [] },
  },
] as const;

describe("pinned Codex server requests", () => {
  test("validates and routes all seven supported shapes", async () => {
    const sink = new MemorySink();
    const observed: CodexServerRequest[] = [];
    const protocol = new PinnedCodexProtocol(21, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { observed.push(request); },
    });
    for (const [index, fixture] of serverRequestFixtures.entries()) {
      await protocol.receiveValue(21, { id: `request-${String(index)}`, ...fixture });
      const request = observed[index];
      if (request === undefined) throw new Error("routed request was missing");
      await protocol.respond(request, { type: "result", result: { decision: "decline" } });
    }

    expect(observed.map(({ method }) => method)).toEqual(
      serverRequestFixtures.map(({ method }) => method),
    );
    expect(observed.map(({ streamPosition }) => streamPosition)).toEqual(
      serverRequestFixtures.map((_, index) => index * 2 + 1),
    );
    expect(observed.find(({ method }) => method === "applyPatchApproval")?.params)
      .toBeUndefined();
    expect(observed.find(({ method }) => method === "execCommandApproval")?.params)
      .toBeUndefined();
    expect(parseWrites(sink)).toHaveLength(7);
  });

  test("returns invalid-params and terminally rejects every malformed routed shape", async () => {
    for (const [index, fixture] of invalidServerRequestFixtures.entries()) {
      const sink = new MemorySink();
      const diagnostics: CodexProtocolDiagnostic[] = [];
      const observed: CodexServerRequest[] = [];
      const protocol = new PinnedCodexProtocol(
        200 + index,
        new CodexJsonlWriter(sink),
        {
          onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
          onServerRequest: (request) => { observed.push(request); },
        },
      );
      await protocol.receiveValue(200 + index, {
        id: `invalid-${String(index)}`,
        ...fixture,
      });
      expect(observed).toHaveLength(0);
      expect(parseWrites(sink)[0]).toEqual({
        id: `invalid-${String(index)}`,
        error: { code: -32_602, message: "Invalid params" },
      });
      expect(diagnostics).toEqual([{
        type: "invalid_inbound_payload",
        generation: 200 + index,
        source: "server_request",
        method: fixture.method,
      }]);
    }
  });

  test("rejects every generated unsupported authority with method-not-found", async () => {
    const sink = new MemorySink();
    const observed: CodexServerRequest[] = [];
    const protocol = new PinnedCodexProtocol(31, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { observed.push(request); },
    });
    const methods = [
      "item/tool/call",
      "currentTime/read",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
    ] as const;
    for (const [index, method] of methods.entries()) {
      await protocol.receiveValue(31, {
        id: `unsupported-${String(index)}`,
        method,
        params: { secret: "DO_NOT_ROUTE" },
      });
    }
    expect(observed).toHaveLength(0);
    expect(parseWrites(sink)).toEqual(methods.map((_, index) => ({
      id: `unsupported-${String(index)}`,
      error: { code: -32_601, message: "Method not found" },
    })));
  });

  test("binds response authority to object identity and expires it on provider resolution", async () => {
    const observed: CodexServerRequest[] = [];
    const owned = new PinnedCodexProtocol(
      42,
      new CodexJsonlWriter(new MemorySink()),
      { onServerRequest: (request) => { observed.push(request); } },
    );
    await owned.receiveValue(42, {
      id: "owned-request",
      method: "item/tool/requestUserInput",
      params: pinnedUserInputRequestFixture,
    });
    const request = observed[0];
    if (request === undefined) throw new Error("owned server request was missing");
    const forged = { ...request };
    expect(owned.respond(forged, { type: "result", result: {} })).rejects.toThrow(
      "no longer active",
    );
    await owned.receiveValue(42, {
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "owned-request" },
    });
    expect(owned.respond(request, { type: "result", result: {} })).rejects.toThrow(
      "no longer active",
    );
  });
});
