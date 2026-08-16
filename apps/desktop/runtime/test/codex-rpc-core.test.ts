import { describe, expect, test } from "bun:test";
import {
  CodexJsonlWriter,
  MAX_CODEX_REQUEST_ID_CHARACTERS,
  CodexRemoteResponseError,
  CodexRequestExpiredError,
  classifyCodex01446RemoteError,
  classifyCodexEnvelope,
  classifyCodexJsonLine,
  supportedCodexNotificationMethods,
  supportedCodexServerRequestMethods,
  type CodexExpiredServerRequestFault,
  type CodexJsonlSink,
  type CodexProtocolDiagnostic,
} from "../src/codex";
import {
  CodexRpcCore,
  MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION,
  MAX_CODEX_SERVER_REQUEST_IDS_PER_GENERATION,
  type CodexRpcCallbacks,
  type CodexServerRequest,
} from "../src/codex/rpc-core";

const decoder = new TextDecoder();

class MemorySink implements CodexJsonlSink {
  readonly writes: string[] = [];

  write(bytes: Uint8Array): number {
    this.writes.push(decoder.decode(bytes));
    return bytes.byteLength;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWritten(sink: MemorySink, index: number): Record<string, unknown> {
  const line = sink.writes[index];
  if (line === undefined) throw new Error(`missing write ${index}`);
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new Error("writer emitted a non-object envelope");
  }
  return value;
}

function createCore(
  generation: number,
  writer: CodexJsonlWriter,
  callbacks: CodexRpcCallbacks = {},
): CodexRpcCore {
  return new CodexRpcCore(generation, writer, callbacks, {
    classifyRemoteError: classifyCodex01446RemoteError,
    notificationMethods: supportedCodexNotificationMethods,
    serverRequestMethods: supportedCodexServerRequestMethods,
  });
}

async function writtenRequest(
  core: CodexRpcCore,
  sink: MemorySink,
  intent: "read" | "ambiguousMutation" = "read",
): Promise<{ readonly id: string; readonly response: Promise<unknown> }> {
  const response = core.request("thread/read", { threadId: "fixture" }, { intent });
  await Bun.sleep(0);
  const message = parseWritten(sink, sink.writes.length - 1);
  if (typeof message.id !== "string") throw new Error("request id was not a string");
  return { id: message.id, response };
}

describe("Codex envelope classification", () => {
  test("classifies strict request, notification, success, and error envelopes", () => {
    expect(classifyCodexEnvelope({ id: 1, method: "thread/read", params: {} })).toEqual({
      ok: true,
      envelope: { type: "request", id: 1, method: "thread/read", params: {} },
    });
    expect(classifyCodexEnvelope({ jsonrpc: "2.0", method: "turn/started" })).toEqual({
      ok: true,
      envelope: { type: "notification", method: "turn/started", params: undefined },
    });
    expect(classifyCodexEnvelope({ id: "a", result: null })).toEqual({
      ok: true,
      envelope: { type: "success", id: "a", result: null },
    });
    expect(classifyCodexEnvelope({ id: "a", error: { code: -1 } })).toEqual({
      ok: true,
      envelope: { type: "error", id: "a", error: { code: -1 } },
    });
  });

  test("rejects malformed, ambiguous, and invalid-version envelopes", () => {
    expect(classifyCodexJsonLine("{broken")).toEqual({ ok: false, reason: "malformed_json" });
    expect(classifyCodexEnvelope({ jsonrpc: "1.0", method: "event" })).toEqual({
      ok: false,
      reason: "invalid_jsonrpc_version",
    });
    expect(classifyCodexEnvelope({ id: 1, method: "event", result: true })).toEqual({
      ok: false,
      reason: "ambiguous_envelope",
    });
    expect(classifyCodexEnvelope({ id: 1, result: true, error: {} })).toEqual({
      ok: false,
      reason: "missing_response_payload",
    });
    expect(classifyCodexEnvelope({ id: null, result: true })).toEqual({
      ok: false,
      reason: "invalid_request_id",
    });
    expect(classifyCodexEnvelope({ id: 1.5, result: true })).toEqual({
      ok: false,
      reason: "invalid_request_id",
    });
    expect(classifyCodexEnvelope({ id: Number.MAX_SAFE_INTEGER + 1, result: true })).toEqual({
      ok: false,
      reason: "invalid_request_id",
    });
    const oversizedId = "x".repeat(MAX_CODEX_REQUEST_ID_CHARACTERS + 1);
    expect(classifyCodexEnvelope({
      id: oversizedId,
      method: "item/tool/requestUserInput",
      params: {},
    })).toEqual({ ok: false, reason: "invalid_request_id" });
    expect(classifyCodexEnvelope({ id: oversizedId, result: null })).toEqual({
      ok: false,
      reason: "invalid_request_id",
    });
  });

  test("preserves unsafe integer payload tokens without admitting them as request ids", () => {
    expect(classifyCodexJsonLine(
      '{"id":"count","result":{"tokens":9007199254740993}}',
    )).toEqual({
      ok: true,
      envelope: {
        type: "success",
        id: "count",
        result: { tokens: 9_007_199_254_740_993n },
      },
    });
    expect(classifyCodexJsonLine('{"id":9007199254740993,"result":null}')).toEqual({
      ok: false,
      reason: "invalid_request_id",
    });
  });
});

describe("CodexJsonlWriter", () => {
  test("serializes writes even when an earlier sink write is blocked", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const sink: CodexJsonlSink = {
      async write(bytes) {
        calls.push(decoder.decode(bytes));
        if (calls.length === 1) await firstGate;
        return bytes.byteLength;
      },
    };
    const writer = new CodexJsonlWriter(sink);
    const first = writer.write({ sequence: 1 });
    const second = writer.write({ sequence: 2 });
    await Bun.sleep(0);
    expect(calls).toEqual(['{"sequence":1}\n']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(['{"sequence":1}\n', '{"sequence":2}\n']);
  });
});

describe("CodexRpcCore", () => {
  test("uses the canonical HRA request identifier prefix", async () => {
    const sink = new MemorySink();
    const core = createCore(17, new CodexJsonlWriter(sink));
    const { id, response } = await writtenRequest(core, sink);

    expect(id).toBe("hra-17-1");
    await core.receiveValue(17, { id, result: { accepted: true } });
    expect(await response).toEqual({ accepted: true });
  });

  test("classifies bounded invalid-token responses without retaining provider detail", async () => {
    const authenticationMessage = [
      "failed to fetch codex rate limits: GET request failed: 401 Unauthorized;",
      'body={"error":{"message":"PRIVATE DETAIL","code":"token_invalidated"}}',
    ].join(" ");
    const cases = [
      { code: -32_603, message: authenticationMessage, expectedKind: "authentication_invalid" },
      { code: -1, message: authenticationMessage, expectedKind: "other" },
      { code: -32_603, message: "401 Unauthorized without a provider error code", expectedKind: "other" },
      { code: -32_603, message: "token_invalidated without an HTTP status", expectedKind: "other" },
      {
        code: -32_603,
        message: `${authenticationMessage}${"x".repeat(16_385)}`,
        expectedKind: "other",
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const sink = new MemorySink();
      const core = createCore(20 + index, new CodexJsonlWriter(sink));
      const { id, response } = await writtenRequest(core, sink);
      const settled = Promise.allSettled([response]);
      await core.receiveValue(20 + index, {
        id,
        error: { code: fixture.code, message: fixture.message, data: { secret: "DO_NOT_RETAIN" } },
      });
      const [result] = await settled;
      if (result === undefined || result.status !== "rejected") {
        throw new Error("remote error response unexpectedly resolved");
      }
      expect(result.reason).toBeInstanceOf(CodexRemoteResponseError);
      expect(result.reason).toMatchObject({ code: fixture.code, kind: fixture.expectedKind });
      expect(JSON.stringify(result.reason)).not.toContain("PRIVATE DETAIL");
      expect(JSON.stringify(result.reason)).not.toContain("DO_NOT_RETAIN");
    }
  });

  test("correlates only the matching generation and diagnoses duplicate responses", async () => {
    const sink = new MemorySink();
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const core = createCore(7, new CodexJsonlWriter(sink), {
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    const { id, response } = await writtenRequest(core, sink);
    let settled = false;
    void response.then(() => {
      settled = true;
    });

    await core.receiveValue(6, { id, result: { stale: true } });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect(diagnostics[0]).toEqual({
      type: "stale_generation",
      generation: 7,
      observedGeneration: 6,
    });

    await core.receiveValue(7, { id, result: { accepted: true } });
    expect(await response).toEqual({ accepted: true });
    await core.receiveValue(7, { id, result: { duplicate: true } });
    expect(diagnostics[1]).toEqual({
      type: "duplicate_response",
      generation: 7,
      requestIdType: "string",
    });
  });

  test("dispatches supported notifications and server requests", async () => {
    const sink = new MemorySink();
    const notifications: unknown[] = [];
    const requests: CodexServerRequest[] = [];
    const core = createCore(3, new CodexJsonlWriter(sink), {
      onNotification: (notification) => {
        notifications.push(notification);
      },
      onServerRequest: (request) => {
        requests.push(request);
      },
    });

    await core.receiveValue(3, { method: "turn/started", params: { turn: "fixture" } });
    await core.receiveValue(3, {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "fixture" },
    });
    expect(notifications).toEqual([
      {
        generation: 3,
        method: "turn/started",
        params: { turn: "fixture" },
        streamPosition: 1,
      },
    ]);
    const request = requests[0];
    if (request === undefined) throw new Error("supported server request was not dispatched");
    expect(request.requestInstanceId).toBe(1);
    expect(request.streamPosition).toBe(2);
    expect(await core.respond(request, {
      type: "result",
      result: { decision: "decline" },
    })).toBe(3);
    expect(parseWritten(sink, 0)).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
    const [duplicateResponse] = await Promise.allSettled([
      core.respond(request, { type: "result", result: {} }),
    ]);
    if (duplicateResponse === undefined || duplicateResponse.status !== "rejected") {
      throw new Error("duplicate server response did not reject");
    }
    expect(duplicateResponse.reason).toBeInstanceOf(Error);
    if (!(duplicateResponse.reason instanceof Error)) throw duplicateResponse.reason;
    expect(duplicateResponse.reason.message).toContain("no longer active");
  });

  test("redacts unknown notifications and expires unknown server requests after method-not-found", async () => {
    const sink = new MemorySink();
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(4, new CodexJsonlWriter(sink), {
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      onServerRequestExpired: (fault) => {
        faults.push(fault);
      },
    });

    await core.receiveValue(4, {
      method: "future/notification\nmethod",
      params: { secret: "DO_NOT_LEAK" },
    });
    await core.receiveValue(4, {
      id: "unknown-authority",
      method: "future/serverRequest",
      params: { secret: "DO_NOT_LEAK" },
    });

    expect(diagnostics).toEqual([
      {
        type: "unknown_notification",
        generation: 4,
        method: "future/notification?method",
      },
    ]);
    expect(parseWritten(sink, 0)).toEqual({
      id: "unknown-authority",
      error: { code: -32_601, message: "Method not found" },
    });
    expect(faults).toEqual([
      {
        type: "server_request_expired",
        generation: 4,
        method: "future/serverRequest",
        requestId: "unknown-authority",
        reason: "unsupported_method",
      },
    ]);
    expect(JSON.stringify({ diagnostics, faults })).not.toContain("DO_NOT_LEAK");
  });

  test("expires the exact in-memory callback when Codex resolves it elsewhere", async () => {
    const sink = new MemorySink();
    const requests: CodexServerRequest[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(5, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { requests.push(request); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });
    await core.receiveValue(5, {
      id: "input-resolved-elsewhere",
      method: "item/tool/requestUserInput",
      params: { secret: "not projected" },
    });
    expect(await core.resolveServerRequest("input-resolved-elsewhere")).toBeTrue();
    expect(faults).toEqual([{
      type: "server_request_expired",
      generation: 5,
      method: "item/tool/requestUserInput",
      requestId: "input-resolved-elsewhere",
      reason: "resolved_elsewhere",
    }]);
    const request = requests[0];
    if (request === undefined) throw new Error("Expected active server request");
    expect(core.respond(request, { type: "result", result: {} })).rejects.toThrow(
      "no longer active",
    );
  });

  test("terminally rejects a provider id reused after settlement", async () => {
    const sink = new MemorySink();
    const requests: CodexServerRequest[] = [];
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(6, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { requests.push(request); },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });
    const fixture = {
      id: "reused-provider-id",
      method: "item/tool/requestUserInput",
      params: { fixture: true },
    } as const;

    await core.receiveValue(6, fixture);
    const first = requests[0];
    if (first === undefined) throw new Error("first server request was not dispatched");
    await core.respond(first, { type: "result", result: {} });
    await core.receiveValue(6, fixture);
    expect(first.requestInstanceId).toBe(1);
    expect(requests).toHaveLength(1);
    expect(parseWritten(sink, 1)).toEqual({
      id: "reused-provider-id",
      error: {
        code: -32_600,
        message: "Codex reused a server-request identifier",
      },
    });
    expect(diagnostics).toEqual([{
      type: "invalid_inbound_payload",
      generation: 6,
      source: "server_request",
      method: "item/tool/requestUserInput",
    }]);
    expect(faults).toEqual([{
      type: "server_request_expired",
      generation: 6,
      method: "item/tool/requestUserInput",
      requestId: "reused-provider-id",
      reason: "duplicate_id",
    }]);
    expect(core.request("thread/read", {}, { intent: "read" })).rejects.toThrow(
      "generation has ended",
    );
  });

  test("bounds one-shot provider ids across a whole generation", async () => {
    const sink = new MemorySink();
    const requests: CodexServerRequest[] = [];
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(13, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { requests.push(request); },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });

    for (let index = 0; index < MAX_CODEX_SERVER_REQUEST_IDS_PER_GENERATION; index += 1) {
      await core.receiveValue(13, {
        id: `bounded-${String(index)}`,
        method: "item/tool/requestUserInput",
        params: {},
      });
      const request = requests[index];
      if (request === undefined) throw new Error("bounded request was not dispatched");
      await core.respond(request, { type: "result", result: {} });
    }
    await core.receiveValue(13, {
      id: "generation-overflow",
      method: "item/tool/requestUserInput",
      params: {},
    });

    expect(requests).toHaveLength(MAX_CODEX_SERVER_REQUEST_IDS_PER_GENERATION);
    expect(parseWritten(sink, MAX_CODEX_SERVER_REQUEST_IDS_PER_GENERATION)).toEqual({
      id: "generation-overflow",
      error: {
        code: -32_600,
        message: "Codex exceeded the server-request generation limit",
      },
    });
    expect(diagnostics.at(-1)).toEqual({
      type: "invalid_inbound_payload",
      generation: 13,
      source: "server_request",
      method: "item/tool/requestUserInput",
    });
    expect(faults.at(-1)).toEqual({
      type: "server_request_expired",
      generation: 13,
      method: "item/tool/requestUserInput",
      requestId: "generation-overflow",
      reason: "capacity_exceeded",
    });
  });

  test("rejects overflow without granting authority and admits after cleanup", async () => {
    const sink = new MemorySink();
    const requests: CodexServerRequest[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(8, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { requests.push(request); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });

    for (let index = 0; index < MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION; index += 1) {
      await core.receiveValue(8, {
        id: `active-${String(index)}`,
        method: "item/tool/requestUserInput",
        params: {},
      });
    }
    expect(requests).toHaveLength(MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION);
    expect(requests.map(({ requestInstanceId }) => requestInstanceId)).toEqual(
      Array.from(
        { length: MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION },
        (_, index) => index + 1,
      ),
    );

    await core.receiveValue(8, {
      id: "overflow",
      method: "item/tool/requestUserInput",
      params: { secret: "DO_NOT_ROUTE" },
    });
    expect(requests).toHaveLength(MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION);
    expect(parseWritten(sink, 0)).toEqual({
      id: "overflow",
      error: { code: -32_000, message: "Server request capacity exceeded" },
    });
    expect(faults).toEqual([{
      type: "server_request_expired",
      generation: 8,
      method: "item/tool/requestUserInput",
      requestId: "overflow",
      reason: "capacity_exceeded",
    }]);
    expect(JSON.stringify({ faults, writes: sink.writes })).not.toContain("DO_NOT_ROUTE");

    const completed = requests[0];
    if (completed === undefined) throw new Error("active request was missing");
    await core.respond(completed, { type: "result", result: {} });
    await core.receiveValue(8, {
      id: "after-cleanup",
      method: "item/tool/requestUserInput",
      params: {},
    });
    expect(requests.at(-1)?.requestInstanceId).toBe(
      MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION + 1,
    );
    await core.expire("stopped");
    expect(faults.filter(({ reason }) => reason === "generation_ended")).toHaveLength(
      MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION,
    );
  });

  test("terminally cleans active authorities when an overflow response cannot be written", async () => {
    let failWrites = false;
    const sink: CodexJsonlSink = {
      write(bytes) {
        return failWrites
          ? Promise.reject(new Error("fixture sink failure"))
          : bytes.byteLength;
      },
    };
    const requests: CodexServerRequest[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(10, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { requests.push(request); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });
    for (let index = 0; index < MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION; index += 1) {
      await core.receiveValue(10, {
        id: `active-${String(index)}`,
        method: "item/tool/requestUserInput",
        params: {},
      });
    }

    failWrites = true;
    const [overflowResult] = await Promise.allSettled([
      core.receiveValue(10, {
        id: "overflow-write-failure",
        method: "item/tool/requestUserInput",
        params: {},
      }),
    ]);
    if (overflowResult === undefined || overflowResult.status !== "rejected") {
      throw new Error("capacity response write failure did not reject");
    }
    expect(overflowResult.reason).toBeInstanceOf(Error);
    if (!(overflowResult.reason instanceof Error)) throw overflowResult.reason;
    expect(overflowResult.reason.message).toContain("capacity response could not be written");
    expect(faults.filter(({ reason }) => reason === "generation_ended")).toHaveLength(
      MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION,
    );
    const previouslyActive = requests[0];
    if (previouslyActive === undefined) throw new Error("active request was missing");
    const [staleResponse] = await Promise.allSettled([
      core.respond(previouslyActive, { type: "result", result: {} }),
    ]);
    if (staleResponse === undefined || staleResponse.status !== "rejected") {
      throw new Error("expired server request unexpectedly responded");
    }
    expect(staleResponse.reason).toBeInstanceOf(Error);
    if (!(staleResponse.reason instanceof Error)) throw staleResponse.reason;
    expect(staleResponse.reason.message).toContain("generation has ended");
  });

  test("counts blocked response settlements against the per-generation admission cap", async () => {
    let releaseFirstWrite: () => void = () => undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writes: string[] = [];
    const sink: CodexJsonlSink = {
      async write(bytes) {
        writes.push(decoder.decode(bytes));
        if (writes.length === 1) await firstWriteGate;
        return bytes.byteLength;
      },
    };
    const requests: CodexServerRequest[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(12, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { requests.push(request); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });
    for (let index = 0; index < MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION; index += 1) {
      await core.receiveValue(12, {
        id: `active-${String(index)}`,
        method: "item/tool/requestUserInput",
        params: {},
      });
    }
    const settlingRequest = requests[0];
    if (settlingRequest === undefined) throw new Error("settling request was missing");
    const settlement = core.respond(settlingRequest, { type: "result", result: {} });
    await Bun.sleep(0);
    const overflow = core.receiveValue(12, {
      id: "blocked-settlement-overflow",
      method: "item/tool/requestUserInput",
      params: {},
    });
    await Bun.sleep(0);
    expect(requests).toHaveLength(MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION);

    releaseFirstWrite();
    await Promise.all([settlement, overflow]);
    const parsedWrites = writes.map((line): unknown => {
      const value: unknown = JSON.parse(line);
      return value;
    });
    expect(parsedWrites).toEqual([
      { id: "active-0", result: {} },
      {
        id: "blocked-settlement-overflow",
        error: { code: -32_000, message: "Server request capacity exceeded" },
      },
    ]);
    expect(faults.at(-1)?.reason).toBe("capacity_exceeded");
    await core.expire("stopped");
  });

  test("does not confirm a response whose authority expires while its write is blocked", async () => {
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writes: string[] = [];
    const requests: CodexServerRequest[] = [];
    const faults: CodexExpiredServerRequestFault[] = [];
    const core = createCore(14, new CodexJsonlWriter({
      async write(bytes) {
        writes.push(decoder.decode(bytes));
        await writeGate;
        return bytes.byteLength;
      },
    }), {
      onServerRequest: (request) => { requests.push(request); },
      onServerRequestExpired: (fault) => { faults.push(fault); },
    });
    await core.receiveValue(14, {
      id: "blocked-response",
      method: "item/tool/requestUserInput",
      params: {},
    });
    const request = requests[0];
    if (request === undefined) throw new Error("blocked request was not dispatched");
    const response = core.respond(request, { type: "result", result: {} });
    await Bun.sleep(0);
    await core.expire("restart_requested");
    releaseWrite();

    expect(response).rejects.toThrow("expired while its response was settling");
    expect(writes).toEqual(['{"id":"blocked-response","result":{}}\n']);
    expect(faults).toEqual([{
      type: "server_request_expired",
      generation: 14,
      method: "item/tool/requestUserInput",
      requestId: "blocked-response",
      reason: "generation_ended",
    }]);
  });

  test("expires ambiguous mutations without writing an automatic replay", async () => {
    const sink = new MemorySink();
    const core = createCore(9, new CodexJsonlWriter(sink));
    const { response } = await writtenRequest(core, sink, "ambiguousMutation");
    const settled = Promise.allSettled([response]);

    await core.expire("process_exited");
    const [result] = await settled;
    if (result === undefined || result.status !== "rejected") {
      throw new Error("expired mutation did not reject");
    }
    expect(result.reason).toBeInstanceOf(CodexRequestExpiredError);
    if (!(result.reason instanceof CodexRequestExpiredError)) throw result.reason;
    expect(result.reason).toMatchObject({
      generation: 9,
      intent: "ambiguousMutation",
      reason: "process_exited",
      automaticReplay: false,
    });
    expect(sink.writes).toHaveLength(1);
  });

  test("reports a request timeout before rejection without replaying its mutation", async () => {
    const sink = new MemorySink();
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const order: string[] = [];
    const core = createCore(10, new CodexJsonlWriter(sink), {
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
        order.push("diagnostic");
      },
    });
    const response = core.request(
      "thread/start",
      { secret: "DO_NOT_LEAK" },
      { intent: "ambiguousMutation", timeoutMs: 1 },
    ).catch((error: unknown) => {
      order.push("rejected");
      throw error;
    });

    const [result] = await Promise.allSettled([response]);
    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") throw new Error("timed-out mutation resolved");
    expect(result.reason).toMatchObject({
      automaticReplay: false,
      generation: 10,
      intent: "ambiguousMutation",
      reason: "timeout",
    });
    expect(diagnostics).toEqual([{
      type: "request_timeout",
      generation: 10,
      intent: "ambiguousMutation",
      method: "thread/start",
    }]);
    expect(order).toEqual(["diagnostic", "rejected"]);
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).not.toContain("automaticReplay");
  });

  test("a writer fault terminally expires every request in the generation", async () => {
    let writeAttempts = 0;
    const writer = new CodexJsonlWriter({
      write() {
        writeAttempts += 1;
        return Promise.reject(new Error("fixture sink failure with DO_NOT_LEAK"));
      },
    });
    const core = createCore(11, writer);
    const settled = Promise.allSettled([
      core.request("thread/read", {}, { intent: "read" }),
      core.request("thread/start", { secret: "DO_NOT_LEAK" }, { intent: "ambiguousMutation" }),
    ]);

    const results = await settled;
    expect(writeAttempts).toBe(1);
    for (const result of results) {
      if (result.status !== "rejected") throw new Error("writer-fault request resolved");
      expect(result.reason).toBeInstanceOf(CodexRequestExpiredError);
      if (!(result.reason instanceof CodexRequestExpiredError)) throw result.reason;
      expect(result.reason.automaticReplay).toBeFalse();
      expect(result.reason.message).not.toContain("DO_NOT_LEAK");
    }
    const [future] = await Promise.allSettled([
      core.request("thread/read", {}, { intent: "read" }),
    ]);
    expect(future?.status).toBe("rejected");
  });
});
