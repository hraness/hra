import { afterEach, describe, expect, test } from "bun:test";
import { pinnedCodexRequests } from "../src/codex";
import {
  CHUNKED_SENTINEL,
  FIXTURE_IDS,
  INITIALIZE_RESULT,
  MALFORMED_OUTPUT_LINE,
  STREAM_NOTIFICATIONS,
  USER_INPUT_REQUEST,
  type FakeScenario,
} from "./fixtures/scenario-contract.ts";

const FAKE_SERVER_PATH = new URL("./fake-app-server.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 3_000;

const subprocesses = new Set<ReturnType<typeof Bun.spawn>>();

type ByteReader = Readonly<{
  read(): Promise<
    | Readonly<{ done: false; value: Uint8Array }>
    | Readonly<{ done: true; value: Uint8Array | undefined }>
  >;
}>;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), TEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

class LineReader {
  readonly #reader: ByteReader;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;
  #chunkCount = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  get chunkCount(): number {
    return this.#chunkCount;
  }

  resetChunkCount(): void {
    this.#chunkCount = 0;
  }

  async nextLine(): Promise<string | null> {
    while (true) {
      const newlineIndex = this.#buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(newlineIndex + 1);
        return line;
      }

      if (this.#done) {
        if (this.#buffer.length === 0) {
          return null;
        }
        const finalLine = this.#buffer;
        this.#buffer = "";
        return finalLine;
      }

      const result = await this.#reader.read();
      if (result.done) {
        this.#done = true;
        this.#buffer += this.#decoder.decode();
      } else {
        this.#chunkCount += 1;
        this.#buffer += this.#decoder.decode(result.value, { stream: true });
      }
    }
  }
}

function spawnFake(scenario: FakeScenario, arguments_: readonly string[] = []) {
  const subprocess = Bun.spawn(
    [process.execPath, FAKE_SERVER_PATH, "--scenario", scenario, ...arguments_],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  subprocesses.add(subprocess);
  const lines = new LineReader(subprocess.stdout);

  return {
    lines,
    subprocess,
    async send(message: unknown): Promise<void> {
      await subprocess.stdin.write(`${JSON.stringify(message)}\n`);
      await subprocess.stdin.flush();
    },
  };
}

async function nextLine(harness: ReturnType<typeof spawnFake>): Promise<string | null> {
  return await withTimeout(harness.lines.nextLine(), "fake app-server output");
}

async function nextMessage(
  harness: ReturnType<typeof spawnFake>,
): Promise<Record<string, unknown>> {
  const line = await nextLine(harness);
  if (line === null) {
    throw new Error("fake app-server stdout closed before the next message");
  }
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fake app-server emitted a non-object message");
  }
  return value as Record<string, unknown>;
}

async function initialize(harness: ReturnType<typeof spawnFake>): Promise<void> {
  await harness.send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "oprte-fake-test", title: "OPRTE fake test", version: "1" },
      capabilities: null,
    },
  });
  expect(await nextMessage(harness)).toEqual({ id: 1, result: INITIALIZE_RESULT });
}

async function closeCleanly(harness: ReturnType<typeof spawnFake>): Promise<void> {
  await harness.subprocess.stdin.end();
  expect(await withTimeout(harness.subprocess.exited, "fake app-server exit")).toBe(0);
  expect(await new Response(harness.subprocess.stderr).text()).toBe("");
}

afterEach(async () => {
  const exits: Promise<number>[] = [];
  for (const subprocess of subprocesses) {
    subprocess.kill();
    exits.push(subprocess.exited);
  }
  await Promise.all(exits);
  subprocesses.clear();
});

describe("fake app-server", () => {
  test("initializes with a stable Codex-compatible response", async () => {
    const harness = spawnFake("initialize");
    await initialize(harness);
    await closeCleanly(harness);
  });

  test("streams ordered lifecycle and UTF-8 delta notifications", async () => {
    const harness = spawnFake("stream");
    await initialize(harness);
    await harness.send({ id: 2, method: "fixture/run", params: {} });

    expect(await nextMessage(harness)).toEqual({
      id: 2,
      result: { scenario: "stream", accepted: true },
    });

    const notifications: Record<string, unknown>[] = [];
    for (let index = 0; index < STREAM_NOTIFICATIONS.length; index += 1) {
      notifications.push(await nextMessage(harness));
    }
    expect(notifications).toEqual([...STREAM_NOTIFICATIONS]);

    const deltas = notifications
      .filter((notification) => notification.method === "item/agentMessage/delta")
      .map((notification) => {
        const params = notification.params;
        return typeof params === "object" && params !== null && "delta" in params
          ? params.delta
          : "";
      });
    expect(deltas.join("")).toBe("Ready 🌿");
    await closeCleanly(harness);
  });

  test("accepts a server-request response and reports its resolution", async () => {
    const harness = spawnFake("server-request");
    await initialize(harness);
    await harness.send({ id: 2, method: "fixture/run", params: {} });

    expect(await nextMessage(harness)).toEqual({
      id: 2,
      result: { scenario: "server-request", accepted: true },
    });
    expect(await nextMessage(harness)).toEqual(USER_INPUT_REQUEST);

    await harness.send({
      id: FIXTURE_IDS.serverRequest,
      result: {
        answers: {
          [FIXTURE_IDS.question]: { answers: ["Continue"] },
        },
      },
    });

    expect(await nextMessage(harness)).toEqual({
      method: "serverRequest/resolved",
      params: {
        threadId: FIXTURE_IDS.thread,
        requestId: FIXTURE_IDS.serverRequest,
      },
    });
    expect(await nextMessage(harness)).toEqual({
      method: "fixture/serverResponseAccepted",
      params: {
        requestId: FIXTURE_IDS.serverRequest,
        triggerId: 2,
        responseKind: "result",
      },
    });
    await closeCleanly(harness);
  });

  test("replays the same pending request when a thread resumes", async () => {
    const harness = spawnFake("server-request");
    await initialize(harness);
    await harness.send({ id: 2, method: "fixture/run", params: {} });
    await nextMessage(harness);
    expect(await nextMessage(harness)).toEqual(USER_INPUT_REQUEST);

    await harness.send({
      id: 3,
      method: "thread/resume",
      params: {
        threadId: FIXTURE_IDS.thread,
        model: "gpt-5.6-sol",
        serviceTier: "fast",
        config: { model_reasoning_effort: "ultra" },
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
      },
    });
    const resumeResponse = await nextMessage(harness);
    expect(resumeResponse).toEqual({
      id: 3,
      result: {
        thread: {
          id: FIXTURE_IDS.thread,
          ephemeral: false,
          historyMode: "legacy",
          preview: "Fake app-server fixture",
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_000,
          status: { type: "idle", activeFlags: [] },
          cwd: "/tmp/hra-fake-app-server",
          threadSource: null,
          name: null,
          turns: [],
        },
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        serviceTier: "fast",
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: { type: "dangerFullAccess" },
      },
    });
    if (!("result" in resumeResponse)) throw new Error("thread resume result missing");
    expect(pinnedCodexRequests.threadResume.outputCodec.parse(
      resumeResponse.result,
    )).toMatchObject({
      thread: { id: FIXTURE_IDS.thread },
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: "fast",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(await nextMessage(harness)).toEqual(USER_INPUT_REQUEST);

    await harness.send({ id: FIXTURE_IDS.serverRequest, result: { answers: {} } });
    expect((await nextMessage(harness)).method).toBe("serverRequest/resolved");
    expect((await nextMessage(harness)).method).toBe("fixture/serverResponseAccepted");
    await closeCleanly(harness);
  });

  test("delays scenario output by the selected deterministic interval", async () => {
    const delayMs = 80;
    const harness = spawnFake("delay", ["--delay-ms", String(delayMs)]);
    await initialize(harness);

    const startedAt = performance.now();
    await harness.send({ id: 2, method: "fixture/run", params: {} });
    expect(await nextMessage(harness)).toEqual({
      id: 2,
      result: { scenario: "delay", accepted: true, delayMs },
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(delayMs - 20);
    await closeCleanly(harness);
  });

  test("emits malformed JSON and then a valid recovery message", async () => {
    const harness = spawnFake("malformed");
    await initialize(harness);
    await harness.send({ id: 2, method: "fixture/run", params: {} });

    expect(await nextLine(harness)).toBe(MALFORMED_OUTPUT_LINE);
    expect(await nextMessage(harness)).toEqual({
      id: 2,
      result: { scenario: "malformed", accepted: true, recovered: true },
    });
    await closeCleanly(harness);
  });

  test("splits a UTF-8 JSONL message across a selectable byte pattern", async () => {
    const harness = spawnFake("chunked", [
      "--chunk-pattern",
      "1,2,1,3",
      "--chunk-delay-ms",
      "2",
    ]);
    await initialize(harness);
    harness.lines.resetChunkCount();
    await harness.send({ id: "chunk-me", method: "fixture/run", params: {} });

    expect(await nextMessage(harness)).toEqual({
      id: "chunk-me",
      result: {
        scenario: "chunked",
        accepted: true,
        sentinel: CHUNKED_SENTINEL,
      },
    });
    expect(harness.lines.chunkCount).toBeGreaterThan(2);
    await closeCleanly(harness);
  });

  test("exits unexpectedly with the configured nonzero status", async () => {
    const harness = spawnFake("exit", ["--exit-code", "73"]);
    await initialize(harness);
    await harness.send({ id: 2, method: "fixture/run", params: {} });

    expect(await withTimeout(harness.subprocess.exited, "unexpected fake app-server exit")).toBe(73);
    expect(await nextLine(harness)).toBeNull();
    expect(await new Response(harness.subprocess.stderr).text()).toBe("");
  });
});
