import { describe, expect, test } from "bun:test";

import type { ClaudeFact } from "./assembler";
import { ClaudeStreamClient } from "./client";
import { ClaudeError } from "./errors";
import type { ClaudeProcess, ClaudeProcessIdentity } from "./process";

const CONFIG_DIR = "/var/hra/profiles/acct/claude";

/**
 * A deterministic in-memory stand-in for the pinned `claude` process. Every
 * test drives the exact captured stream-json shapes; nothing shells out, so
 * these tests run identically on a machine with no Claude Code installed.
 */
class FakeClaudeProcess implements ClaudeProcess {
  readonly identity: Promise<ClaudeProcessIdentity> = Promise.resolve(Object.freeze({
    pid: 8_123,
    pidDomain: "darwin",
    procStart: "Fri Sep  4 12:00:00 2026",
  }));
  readonly written: string[] = [];
  readonly signals: string[] = [];
  onWrite: (() => void) | undefined;
  writeSettlementGate: Promise<void> | undefined;
  terminated = false;
  readonly #ignoreTerm: boolean;
  readonly #ignoreKill: boolean;
  readonly #leaveStreamsOpenAfterKill: boolean;
  #resolveExit: ((code: number) => void) | undefined;
  #rejectExit: ((error: Error) => void) | undefined;
  #push: ((chunk: Uint8Array) => void) | undefined;
  #finish: (() => void) | undefined;
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { /* silent */ } };

  constructor(options: Readonly<{
    ignoreTerm?: boolean;
    ignoreKill?: boolean;
    leaveStreamsOpenAfterKill?: boolean;
  }> = {}) {
    this.#ignoreTerm = options.ignoreTerm ?? false;
    this.#ignoreKill = options.ignoreKill ?? false;
    this.#leaveStreamsOpenAfterKill = options.leaveStreamsOpenAfterKill ?? false;
    this.exited = new Promise((resolve, reject) => {
      this.#resolveExit = resolve;
      this.#rejectExit = reject;
    });
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | undefined;
    let done = false;
    this.#push = (chunk) => { queue.push(chunk); waiter?.(); waiter = undefined; };
    this.#finish = () => { done = true; waiter?.(); waiter = undefined; };
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = queue.shift();
          if (chunk !== undefined) { yield chunk; continue; }
          if (done) return;
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    };
  }

  emit(...lines: readonly unknown[]): void {
    const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
    this.#push?.(new TextEncoder().encode(text));
  }

  end(): void {
    this.#finish?.();
    this.#resolveExit?.(0);
  }

  failExitProof(): void {
    this.#rejectExit?.(new Error("exit proof unavailable"));
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(bytes));
    this.onWrite?.();
    const gate = this.writeSettlementGate;
    this.writeSettlementGate = undefined;
    if (gate !== undefined) await gate;
  }

  terminate(): void {
    this.terminated = true;
    this.signals.push("SIGTERM");
    if (!this.#ignoreTerm) this.end();
  }

  forceTerminate(): void {
    this.terminated = true;
    this.signals.push("SIGKILL");
    if (this.#ignoreKill) return;
    if (this.#leaveStreamsOpenAfterKill) this.#resolveExit?.(137);
    else this.end();
  }
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 1); });
};

const open = (): Readonly<{
  client: ClaudeStreamClient;
  facts: ClaudeFact[];
  process: FakeClaudeProcess;
}> => {
  const process = new FakeClaudeProcess();
  const facts: ClaudeFact[] = [];
  const client = new ClaudeStreamClient({
    configDir: CONFIG_DIR,
    onFact: (fact) => { facts.push(fact); },
    process,
  });
  return { client, facts, process };
};

const writtenLines = (process: FakeClaudeProcess): readonly unknown[] =>
  process.written.flatMap((chunk) =>
    chunk.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown));

describe("Claude stream client", () => {
  test("waits for one bounded, abortable initialization identity", async () => {
    const { client, process } = open();
    const initialization = client.waitForInitialization({
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    process.emit({
      claude_code_version: "2.1.260",
      model: "claude-fable-5-1",
      permissionMode: "default",
      session_id: "726b1b3d-ed97-4b55-9904-e58fa7d7eb45",
      subtype: "init",
      tools: [],
      type: "system",
    });
    await expect(initialization).resolves.toEqual({
      claudeVersion: "2.1.260",
      model: "claude-fable-5-1",
      permissionMode: "default",
      providerSessionId: "726b1b3d-ed97-4b55-9904-e58fa7d7eb45",
    });
    await client.close();
  });

  test("refuses a silent or aborted initialization wait", async () => {
    const silent = open();
    await expect(silent.client.waitForInitialization({
      signal: new AbortController().signal,
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    await silent.client.close();

    const aborted = open();
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await expect(aborted.client.waitForInitialization({
      signal: controller.signal,
      timeoutMs: 1_000,
    })).rejects.toThrow("caller stopped");
    await aborted.client.close();
  });

  test("drives one full turn: user line in, deltas and a result out", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "say ok", turnId: "turn-1" });
    expect(writtenLines(process)).toEqual([{
      message: { content: [{ text: "say ok", type: "text" }], role: "user" },
      type: "user",
    }]);

    process.emit(
      {
        claude_code_version: "2.1.260",
        cwd: "<redacted>",
        model: "claude-fable-5-1",
        permissionMode: "default",
        session_id: "sess",
        subtype: "init",
        tools: ["Bash"],
        type: "system",
      },
      {
        message: {
          content: [{ text: "ok", type: "text" }],
          id: "msg_1",
          model: "claude-fable-5-1",
          role: "assistant",
          type: "message",
        },
        parent_tool_use_id: null,
        session_id: "sess",
        type: "assistant",
      },
      {
        duration_ms: 2_259,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: "sess",
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: { input_tokens: 2, output_tokens: 4 },
      },
    );
    await settle();

    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "sessionBootstrapped",
      "assistantDelta",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
    ]);
    expect(client.activeTurnId).toBeNull();
    expect(client.providerSessionId).toBe("sess");
    await client.close();
  });

  test("steers mid-turn by writing another user line on the same stream", async () => {
    const { client, process } = open();
    await client.startTurn({ message: "count to 40", turnId: "turn-1" });
    await client.steer("stop counting now");
    expect(writtenLines(process)).toEqual([
      { message: { content: [{ text: "count to 40", type: "text" }], role: "user" }, type: "user" },
      { message: { content: [{ text: "stop counting now", type: "text" }], role: "user" }, type: "user" },
    ]);
    await client.close();
  });

  test("refuses to steer when no turn is in flight", async () => {
    const { client } = open();
    await expect(client.steer("hello")).rejects.toThrow(ClaudeError);
    await client.close();
  });

  test("interrupts an in-flight turn and marks its result interrupted", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "long job", turnId: "turn-1" });
    await client.interrupt();
    const interrupt = writtenLines(process).at(-1);
    expect(interrupt).toMatchObject({ request: { subtype: "interrupt" }, type: "control_request" });

    process.emit({
      duration_ms: 10,
      is_error: false,
      num_turns: 1,
      result: "stopped",
      session_id: "sess",
      stop_reason: "end_turn",
      terminal_reason: "completed",
      type: "result",
      usage: {},
    });
    await settle();
    expect(facts.find((fact) => fact.type === "turnCompleted"))
      .toMatchObject({ status: "interrupted" });
    await client.close();
  });

  test("brokers a Bash approval and answers with the request's own input", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "run it", turnId: "turn-1" });
    process.emit({
      request: {
        description: "Fetch HTTP status line from example.com",
        display_name: "Bash",
        input: { command: "curl -sI https://example.com | head -n 1" },
        permission_suggestions: [{
          behavior: "allow",
          destination: "localSettings",
          rules: [{ ruleContent: "curl -sI https://example.com", toolName: "Bash" }],
          type: "addRules",
        }],
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
      },
      request_id: "req-1",
      type: "control_request",
    });
    await settle();

    const requested = facts.find((fact) => fact.type === "interactionRequested");
    expect(requested).toMatchObject({ blocking: true, kind: "command_approval", requestId: "req-1" });
    expect(client.pendingInteraction("req-1")).toBeDefined();

    const validated = client.validateInteractionResolution("req-1", { kind: "allow" });
    const resolved = await client.resolveInteraction("req-1", { kind: "allow" });
    expect(resolved.responseDigest).toBe(validated.responseDigest);
    expect(writtenLines(process).at(-1)).toEqual({
      response: {
        request_id: "req-1",
        response: {
          behavior: "allow",
          toolUseID: "toolu_1",
          updatedInput: { command: "curl -sI https://example.com | head -n 1" },
        },
        subtype: "success",
      },
      type: "control_response",
    });
    // The response is written once; the request is no longer pending.
    expect(client.pendingInteraction("req-1")).toBeUndefined();
    await expect(client.resolveInteraction("req-1", { kind: "allow" })).rejects.toThrow(ClaudeError);
    await client.close();
  });

  test("answers a question through updatedInput.answers", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "ask me", turnId: "turn-1" });
    process.emit({
      request: {
        display_name: "AskUserQuestion",
        input: {
          questions: [{
            header: "Indent",
            multiSelect: false,
            options: [
              { description: "Indent with tab characters", label: "tabs" },
              { description: "Indent with space characters", label: "spaces" },
            ],
            question: "Tabs or spaces?",
          }],
        },
        requires_user_interaction: true,
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_q",
      },
      request_id: "req-q",
      type: "control_request",
    });
    await settle();
    expect(facts.find((fact) => fact.type === "interactionRequested")).toMatchObject({
      kind: "user_input",
    });
    await client.resolveInteraction("req-q", { answers: { q0: "spaces" }, kind: "answer" });
    expect(writtenLines(process).at(-1)).toMatchObject({
      response: {
        response: {
          behavior: "allow",
          updatedInput: { answers: { "Tabs or spaces?": "spaces" } },
        },
      },
    });
    await client.close();
  });

  test("drops a canceled control request instead of answering it", async () => {
    const { client, process } = open();
    await client.startTurn({ message: "run it", turnId: "turn-1" });
    process.emit(
      {
        request: {
          display_name: "Bash",
          input: { command: "true" },
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
        },
        request_id: "req-1",
        type: "control_request",
      },
      { request_id: "req-1", type: "control_cancel_request" },
    );
    await settle();
    expect(client.pendingInteraction("req-1")).toBeUndefined();
    await client.close();
  });

  test("ends an in-flight turn when the stream stops without a result", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "hello", turnId: "turn-1" });
    process.end();
    await settle();
    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "providerError",
      "turnCompleted",
      "providerDisconnected",
    ]);
    expect(facts.at(-2)).toMatchObject({ status: "failed" });
    await client.close();
  });

  test("requires an absolute reviewed config directory", () => {
    expect(() => new ClaudeStreamClient({
      configDir: "relative/home",
      onFact: () => undefined,
      process: new FakeClaudeProcess(),
    })).toThrow(ClaudeError);
  });

  test("refuses every write after close", async () => {
    const { client } = open();
    await client.close();
    await expect(client.startTurn({ message: "x", turnId: "t" })).rejects.toThrow(ClaudeError);
  });

  test("requires exact exit settlement after KILL and permits an exact close retry", async () => {
    const process = new FakeClaudeProcess({
      ignoreKill: true,
      ignoreTerm: true,
      leaveStreamsOpenAfterKill: true,
    });
    const diagnostics: string[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });
    await expect(Promise.all([client.close(), client.close()])).rejects.toMatchObject({
      code: "PROCESS_EXITED",
    });
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(diagnostics).toContain("Claude process exit did not settle after termination");

    process.end();
    await expect(client.close()).resolves.toBeUndefined();
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
  });

  test("fences writes when process exit settlement becomes indeterminate", async () => {
    const process = new FakeClaudeProcess();
    const diagnostics: string[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });
    process.failExitProof();
    await settle();

    await expect(client.startTurn({ message: "must not write", turnId: "turn-1" }))
      .rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(process.written).toHaveLength(0);
    expect(diagnostics).toContain("Claude process exit settlement was indeterminate");
    await expect(client.close()).rejects.toMatchObject({ code: "PROCESS_EXITED" });
  });

  test("refuses a queued frame when the process authority is fenced before its write begins", async () => {
    const process = new FakeClaudeProcess();
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve; });
    process.writeSettlementGate = firstWriteGate;
    process.onWrite = markFirstWriteStarted;

    const first = client.startTurn({ message: "first", turnId: "turn-1" });
    await firstWriteStarted;
    process.onWrite = undefined;
    const queued = client.steer("must stay fenced").then(
      () => null,
      (error: unknown) => error,
    );
    process.failExitProof();
    await settle();
    releaseFirstWrite();

    await expect(first).resolves.toBeUndefined();
    expect(await queued).toMatchObject({ code: "PROCESS_EXITED" });
    expect(writtenLines(process)).toEqual([
      {
        message: {
          content: [{ text: "first", type: "text" }],
          role: "user",
        },
        type: "user",
      },
    ]);
    await expect(client.close()).rejects.toMatchObject({ code: "PROCESS_EXITED" });
  });
});
