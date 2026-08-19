#!/usr/bin/env bun

import {
  CHUNKED_SENTINEL,
  FAKE_SCENARIOS,
  FIXTURE_IDS,
  INITIALIZE_RESULT,
  MALFORMED_OUTPUT_LINE,
  STREAM_NOTIFICATIONS,
  USER_INPUT_REQUEST,
  type FakeScenario,
} from "./fixtures/scenario-contract.ts";

type RequestId = string | number;

type Options = Readonly<{
  chunkDelayMs: number;
  chunkPattern: readonly number[];
  delayMs: number;
  exitCode: number;
  scenario: FakeScenario;
}>;

type PendingServerRequest = Readonly<{
  id: RequestId;
  triggerId: RequestId;
}>;

const DEFAULT_OPTIONS: Options = {
  chunkDelayMs: 2,
  chunkPattern: [1, 2, 3, 5],
  delayMs: 50,
  exitCode: 86,
  scenario: "initialize",
};

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

function isScenario(value: string): value is FakeScenario {
  return FAKE_SCENARIOS.some((scenario) => scenario === value);
}

function parseBoundedInteger(
  value: string,
  option: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseChunkPattern(value: string): readonly number[] {
  const chunks = value
    .split(",")
    .map((chunk) => parseBoundedInteger(chunk, "--chunk-pattern", 1, 65_536));
  if (chunks.length === 0) {
    throw new Error("--chunk-pattern requires at least one positive byte count");
  }
  return chunks;
}

function parseOptions(arguments_: readonly string[]): Options {
  let options = DEFAULT_OPTIONS;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--scenario") {
      const value = optionValue(arguments_, index, argument);
      if (!isScenario(value)) {
        throw new Error(`unknown scenario: ${value}`);
      }
      options = { ...options, scenario: value };
      index += 1;
      continue;
    }

    if (argument === "--delay-ms") {
      const value = optionValue(arguments_, index, argument);
      options = {
        ...options,
        delayMs: parseBoundedInteger(value, argument, 0, 60_000),
      };
      index += 1;
      continue;
    }

    if (argument === "--chunk-delay-ms") {
      const value = optionValue(arguments_, index, argument);
      options = {
        ...options,
        chunkDelayMs: parseBoundedInteger(value, argument, 0, 1_000),
      };
      index += 1;
      continue;
    }

    if (argument === "--chunk-pattern") {
      const value = optionValue(arguments_, index, argument);
      options = { ...options, chunkPattern: parseChunkPattern(value) };
      index += 1;
      continue;
    }

    if (argument === "--exit-code") {
      const value = optionValue(arguments_, index, argument);
      options = {
        ...options,
        exitCode: parseBoundedInteger(value, argument, 1, 255),
      };
      index += 1;
      continue;
    }

    throw new Error(`unknown option: ${argument}`);
  }

  return options;
}

async function writeRaw(value: string | Uint8Array): Promise<void> {
  await Bun.write(Bun.stdout, value);
}

async function writeMessage(message: unknown): Promise<void> {
  await writeRaw(`${JSON.stringify(message)}\n`);
}

async function writeChunkedMessage(message: unknown, options: Options): Promise<void> {
  const bytes = textEncoder.encode(`${JSON.stringify(message)}\n`);
  let offset = 0;
  let patternIndex = 0;

  while (offset < bytes.byteLength) {
    const requestedLength = options.chunkPattern[patternIndex % options.chunkPattern.length];
    if (requestedLength === undefined) {
      throw new Error("chunk pattern unexpectedly became empty");
    }
    const end = Math.min(offset + requestedLength, bytes.byteLength);
    await writeRaw(bytes.subarray(offset, end));
    offset = end;
    patternIndex += 1;
    if (offset < bytes.byteLength && options.chunkDelayMs > 0) {
      await Bun.sleep(options.chunkDelayMs);
    }
  }
}

async function writeResponse(id: RequestId, result: unknown): Promise<void> {
  await writeMessage({ id, result });
}

async function writeError(id: RequestId | null, code: number, message: string): Promise<void> {
  await writeMessage({ id, error: { code, message } });
}

function triggerResult(scenario: FakeScenario, extra: Record<string, unknown> = {}) {
  return { scenario, accepted: true, ...extra };
}

class FakeAppServer {
  readonly #options: Options;
  #initialized = false;
  #pendingServerRequest: PendingServerRequest | undefined;

  constructor(options: Options) {
    this.#options = options;
  }

  async receive(value: unknown): Promise<void> {
    if (!isRecord(value)) {
      await writeError(null, -32_600, "expected a JSON object");
      return;
    }

    const method = value.method;
    const id = value.id;

    if (typeof method !== "string") {
      await this.#receiveResponse(value);
      return;
    }

    if (!isRequestId(id)) {
      return;
    }

    if (method === "initialize") {
      this.#initialized = true;
      await writeResponse(id, INITIALIZE_RESULT);
      return;
    }

    if (!this.#initialized) {
      await writeError(id, -32_000, "initialize must complete before other requests");
      return;
    }

    if (method === "thread/resume" && this.#pendingServerRequest !== undefined) {
      const params = isRecord(value.params) ? value.params : {};
      const config = isRecord(params.config) ? params.config : {};
      const threadId = typeof params.threadId === "string"
        ? params.threadId
        : FIXTURE_IDS.thread;
      const model = typeof params.model === "string" ? params.model : "gpt-5.6-sol";
      const reasoningEffort = typeof config.model_reasoning_effort === "string"
        ? config.model_reasoning_effort
        : "max";
      const serviceTier = typeof params.serviceTier === "string" ? params.serviceTier : null;
      await writeResponse(id, {
        thread: {
          id: threadId,
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
        model,
        reasoningEffort,
        serviceTier,
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: { type: "dangerFullAccess" },
      });
      await writeMessage(USER_INPUT_REQUEST);
      return;
    }

    if (method !== "fixture/run") {
      await writeError(id, -32_601, `unsupported fake method: ${method}`);
      return;
    }

    await this.#runScenario(id);
  }

  async #receiveResponse(value: Readonly<Record<string, unknown>>): Promise<void> {
    const pending = this.#pendingServerRequest;
    if (pending === undefined || value.id !== pending.id) {
      return;
    }

    if (!("result" in value) && !("error" in value)) {
      return;
    }

    this.#pendingServerRequest = undefined;
    await writeMessage({
      method: "serverRequest/resolved",
      params: {
        threadId: FIXTURE_IDS.thread,
        requestId: pending.id,
      },
    });
    await writeMessage({
      method: "fixture/serverResponseAccepted",
      params: {
        requestId: pending.id,
        triggerId: pending.triggerId,
        responseKind: "result" in value ? "result" : "error",
      },
    });
  }

  async #runScenario(id: RequestId): Promise<void> {
    switch (this.#options.scenario) {
      case "initialize": {
        await writeResponse(id, triggerResult("initialize"));
        return;
      }
      case "stream": {
        await writeResponse(id, triggerResult("stream"));
        for (const notification of STREAM_NOTIFICATIONS) {
          await writeMessage(notification);
        }
        return;
      }
      case "server-request": {
        await writeResponse(id, triggerResult("server-request"));
        this.#pendingServerRequest = {
          id: USER_INPUT_REQUEST.id,
          triggerId: id,
        };
        await writeMessage(USER_INPUT_REQUEST);
        return;
      }
      case "delay": {
        await Bun.sleep(this.#options.delayMs);
        await writeResponse(
          id,
          triggerResult("delay", { delayMs: this.#options.delayMs }),
        );
        return;
      }
      case "malformed": {
        await writeRaw(`${MALFORMED_OUTPUT_LINE}\n`);
        await writeResponse(id, triggerResult("malformed", { recovered: true }));
        return;
      }
      case "chunked": {
        await writeChunkedMessage(
          {
            id,
            result: triggerResult("chunked", { sentinel: CHUNKED_SENTINEL }),
          },
          this.#options,
        );
        return;
      }
      case "exit": {
        process.exit(this.#options.exitCode);
      }
    }
  }
}

async function runInputLoop(server: FakeAppServer): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        await receiveLine(server, line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    await receiveLine(server, buffer.replace(/\r$/, ""));
  }
}

async function receiveLine(server: FakeAppServer, line: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown parse failure";
    await writeError(null, -32_700, `invalid JSON: ${message}`);
    return;
  }

  await server.receive(value);
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(Bun.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    await Bun.write(Bun.stderr, `${message}\n`);
    process.exitCode = 64;
    return;
  }

  await runInputLoop(new FakeAppServer(options));
}

await main();
