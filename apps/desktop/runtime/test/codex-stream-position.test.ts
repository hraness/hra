import { describe, expect, test } from "bun:test";

import {
  CodexJsonlWriter,
  classifyCodex01446RemoteError,
  supportedCodexNotificationMethods,
  supportedCodexServerRequestMethods,
  type CodexJsonlSink,
  type CodexProtocolDiagnostic,
} from "../src/codex";
import {
  CodexRpcCore,
  MAX_CODEX_STREAM_POSITION,
  nextCodexStreamPosition,
  type CodexNotification,
  type CodexServerRequest,
} from "../src/codex/rpc-core";

class MemorySink implements CodexJsonlSink {
  readonly writes: Uint8Array[] = [];

  write(bytes: Uint8Array): number {
    this.writes.push(bytes.slice());
    return bytes.byteLength;
  }
}

function createCore(
  generation: number,
  callbacks: ConstructorParameters<typeof CodexRpcCore>[2] = {},
): Readonly<{ core: CodexRpcCore; sink: MemorySink }> {
  const sink = new MemorySink();
  const core = new CodexRpcCore(
    generation,
    new CodexJsonlWriter(sink),
    callbacks,
    {
      classifyRemoteError: classifyCodex01446RemoteError,
      notificationMethods: supportedCodexNotificationMethods,
      serverRequestMethods: supportedCodexServerRequestMethods,
    },
  );
  return { core, sink };
}

function requestId(sink: MemorySink): string {
  const bytes = sink.writes[0];
  if (bytes === undefined) throw new Error("request write was missing");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("id" in parsed) ||
    typeof parsed.id !== "string"
  ) {
    throw new Error("request identifier was missing");
  }
  return parsed.id;
}

describe("Codex stream positions", () => {
  test("positions notifications, server requests, and responses in envelope order", async () => {
    const notifications: CodexNotification[] = [];
    const serverRequests: CodexServerRequest[] = [];
    const { core, sink } = createCore(17, {
      onNotification(notification) {
        notifications.push(notification);
      },
      onServerRequest(request) {
        serverRequests.push(request);
      },
    });

    const response = core.requestWithResponsePosition(
      "thread/read",
      { threadId: "thread-1", includeTurns: true },
      { intent: "read" },
    );
    await Bun.sleep(0);
    const id = requestId(sink);

    await core.receiveValue(17, {
      method: "thread/status/changed",
      params: { threadId: "thread-1" },
    });
    await core.receiveValue(17, {
      id: "provider-request-1",
      method: "item/tool/requestUserInput",
      params: {},
    });
    await core.receiveValue(17, { id, result: { thread: "snapshot" } });

    expect(notifications).toEqual([{
      generation: 17,
      method: "thread/status/changed",
      params: { threadId: "thread-1" },
      streamPosition: 1,
    }]);
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0]).toMatchObject({
      generation: 17,
      id: "provider-request-1",
      requestInstanceId: 1,
      streamPosition: 2,
    });
    expect(await response).toEqual({
      generation: 17,
      result: { thread: "snapshot" },
      streamPosition: 3,
    });
  });

  test("does not position stale-generation envelopes", async () => {
    const notifications: CodexNotification[] = [];
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const { core } = createCore(23, {
      onNotification(notification) {
        notifications.push(notification);
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });

    await core.receiveValue(22, { method: "thread/closed", params: {
      threadId: "stale-thread",
    } });
    await core.receiveValue(23, { method: "thread/closed", params: {
      threadId: "current-thread",
    } });

    expect(notifications).toEqual([{
      generation: 23,
      method: "thread/closed",
      params: { threadId: "current-thread" },
      streamPosition: 1,
    }]);
    expect(diagnostics).toEqual([{
      type: "stale_generation",
      generation: 23,
      observedGeneration: 22,
    }]);
  });

  test("rejects a malformed envelope before dispatch and ends the generation", async () => {
    const notifications: CodexNotification[] = [];
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const { core } = createCore(29, {
      onNotification(notification) {
        notifications.push(notification);
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });

    await core.receiveValue(29, { id: null, result: { secret: "DO_NOT_ROUTE" } });

    expect(notifications).toHaveLength(0);
    expect(diagnostics).toEqual([{
      type: "invalid_envelope",
      generation: 29,
      reason: "invalid_request_id",
    }]);
    expect(core.request("thread/read", {}, { intent: "read" })).rejects.toThrow(
      "generation has ended",
    );
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_ROUTE");
  });

  test("keeps every assigned position inside the safe integer bound", () => {
    expect(nextCodexStreamPosition(0)).toBe(1);
    expect(nextCodexStreamPosition(MAX_CODEX_STREAM_POSITION - 1)).toBe(
      MAX_CODEX_STREAM_POSITION,
    );
    expect(nextCodexStreamPosition(MAX_CODEX_STREAM_POSITION)).toBeNull();
    expect(() => nextCodexStreamPosition(-1)).toThrow("non-negative safe integer");
    expect(() => nextCodexStreamPosition(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "non-negative safe integer",
    );
  });
});
