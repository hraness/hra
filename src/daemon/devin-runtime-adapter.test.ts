import { describe, expect, test } from "bun:test";

import type { AnyMessage } from "@agentclientprotocol/sdk";

import {
  DEVIN_MODEL,
  DEVIN_PIN,
  type DevinAcpProcess,
  type DevinDirectories,
  type PinnedDevinRuntime,
} from "../devin/index.ts";
import type { CodexFact } from "../codex/protocol.ts";
import { PresetProviderMismatchError } from "../domain/presets.ts";
import { effectiveDevinRuntimeProfileSchema } from "../domain/runtime-profile.ts";
import {
  PinnedDevinRuntimeManager,
  type DevinProcessFactory,
} from "./devin-runtime-adapter.ts";
import type { DevinRuntimePort, ProfileAuthority } from "./ports.ts";

type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PROJECT_ROOT = "/var/hra/projects/demo";
const NOW = 1_700_000_000_000;
const ASTRA_REQUIREMENT = {
  effort: "provider-default",
  model: DEVIN_MODEL,
} as const;

const authority: ProfileAuthority = {
  codexHome: "/var/hra/profiles/acct/codex",
  desktopUserData: "/var/hra/profiles/acct/desktop",
  generation: 3,
  id: "acct_00000000000000000000000000000000",
  provider: "devin",
  providerAccountId: "dact_00000000000000000000000000000000",
  bindingGeneration: 7,
};

const directories: DevinDirectories = {
  cacheHome: "/var/hra/profiles/acct/devin-cache",
  configHome: "/var/hra/profiles/acct/devin-config",
  dataHome: "/var/hra/profiles/acct/devin-data",
  home: "/var/hra/profiles/acct/devin-home",
  stateHome: "/var/hra/profiles/acct/devin-state",
};

const runtime: PinnedDevinRuntime = {
  argv: ["/usr/local/bin/devin", "acp", "--model", DEVIN_MODEL],
  executablePath: "/usr/local/bin/devin",
  model: DEVIN_MODEL,
  version: DEVIN_PIN,
};

const method = (message: JsonRecord): string | undefined =>
  typeof message.method === "string" ? message.method : undefined;

const requestId = (message: JsonRecord): string | number => {
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    throw new Error("test expected a request id");
  }
  return message.id;
};

class FakeDevinProcess implements DevinAcpProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() { /* No diagnostics. */ },
  };
  readonly exited: Promise<number>;
  readonly received: JsonRecord[] = [];
  readonly sessionId: string;
  beforeNewResponse: (() => void) | undefined;
  beforeInitializeResponse: (() => void) | undefined;
  beforeTerminate: (() => void) | undefined;
  promptRequestId: string | number | undefined;
  shutdownBlocked = false;
  terminateCalls = 0;
  finished = false;
  terminated = false;
  forceTerminated = false;
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExit!: (code: number) => void;

  constructor(sessionId = "devin-session-1") {
    this.sessionId = sessionId;
    this.stdout = new ReadableStream({
      start: (controller) => { this.#stdout = controller; },
    });
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.stdin = new WritableStream({
      write: async (chunk) => {
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line.trim().length === 0) continue;
          const value = JSON.parse(line) as unknown;
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("test client wrote a non-object frame");
          }
          const message = value as JsonRecord;
          this.received.push(message);
          await this.#onMessage(message);
        }
      },
      close: () => { if (!this.shutdownBlocked) this.finish(0); },
      abort: () => { if (!this.shutdownBlocked) this.finish(1); },
    });
  }

  async #onMessage(message: JsonRecord): Promise<void> {
    switch (method(message)) {
      case "initialize":
        this.beforeInitializeResponse?.();
        this.send({
          jsonrpc: "2.0",
          method: "_cognition.ai/mcp/serversChanged",
          params: {},
        });
        this.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
        });
        break;
      case "session/new":
        this.beforeNewResponse?.();
        this.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: { sessionId: this.sessionId },
        });
        break;
      case "session/load":
        this.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.sessionId,
            update: {
              content: { text: "replayed answer", type: "text" },
              messageId: "replayed-message",
              sessionUpdate: "agent_message_chunk",
            },
          },
        });
        this.send({ jsonrpc: "2.0", id: requestId(message), result: {} });
        break;
      case "session/prompt":
        this.promptRequestId = requestId(message);
        break;
      case "session/cancel":
        if (this.promptRequestId !== undefined) this.completePrompt("cancelled");
        break;
      case undefined:
      default:
        break;
    }
  }

  send(message: AnyMessage): void {
    this.#stdout.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
  }

  sendUpdate(update: JsonRecord): void {
    this.sendSessionUpdate(this.sessionId, update);
  }

  sendSessionUpdate(sessionId: string, update: JsonRecord): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  sendPermission(
    id: string | number = 77,
    options: readonly JsonRecord[] = [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_once", name: "Reject", optionId: "reject-once" },
    ],
    toolCallId = "tool-1",
  ): void {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        options,
        sessionId: this.sessionId,
        toolCall: {
          kind: "execute",
          status: "pending",
          title: "Run the focused tests",
          toolCallId,
        },
      },
    });
  }

  completePrompt(stopReason: "end_turn" | "cancelled"): void {
    const id = this.promptRequestId;
    if (id === undefined) throw new Error("no prompt is pending");
    this.promptRequestId = undefined;
    this.send({ jsonrpc: "2.0", id, result: { stopReason } });
  }

  finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.#stdout.close();
    this.#resolveExit(code);
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.beforeTerminate?.();
    this.terminated = true;
    if (!this.shutdownBlocked) this.finish(143);
  }

  forceTerminate(): void {
    this.forceTerminated = true;
    if (!this.shutdownBlocked) this.finish(137);
  }
}

const signal = (): AbortSignal => new AbortController().signal;

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 1); });
};

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let index = 0; index < 100; index += 1) {
    if (await condition()) return;
    await settle();
  }
  throw new Error("condition did not settle");
};

const harness = (options: {
  onFact?: (fact: CodexFact) => void | Promise<void>;
  isCurrent?: (authority: ProfileAuthority) => boolean;
  projectRootFor?: ConstructorParameters<typeof PinnedDevinRuntimeManager>[0]["projectRootFor"];
  processFactory?: DevinProcessFactory;
  readAuthStatus?: ConstructorParameters<typeof PinnedDevinRuntimeManager>[0]["readAuthStatus"];
  closeDeadlineMs?: number;
} = {}) => {
  const facts: CodexFact[] = [];
  const factAuthorities: ProfileAuthority[] = [];
  const processes: FakeDevinProcess[] = [];
  const launches: Parameters<DevinProcessFactory>[0][] = [];
  const manager = new PinnedDevinRuntimeManager({
    directoriesFor: () => directories,
    isCurrent: options.isCurrent ?? (() => true),
    now: () => NOW,
    observer: { fact: async (observedAuthority, fact) => {
      facts.push(fact);
      factAuthorities.push(observedAuthority);
      await options.onFact?.(fact);
    } },
    processFactory: options.processFactory ?? ((input) => {
      launches.push(input);
      const process = new FakeDevinProcess();
      processes.push(process);
      return process;
    }),
    ...(options.projectRootFor === undefined ? {} : { projectRootFor: options.projectRootFor }),
    ...(options.readAuthStatus === undefined ? {} : { readAuthStatus: options.readAuthStatus }),
    ...(options.closeDeadlineMs === undefined ? {} : {
      clientShutdownGraceMs: options.closeDeadlineMs,
      clientShutdownForceJoinMs: options.closeDeadlineMs,
      directJoinGraceMs: options.closeDeadlineMs,
      directForceJoinMs: options.closeDeadlineMs,
    }),
    resolveRuntime: async () => runtime,
  });
  return { facts, factAuthorities, launches, manager, processes };
};

const startSession = async (
  manager: PinnedDevinRuntimeManager,
  sessionAuthority: ProfileAuthority = authority,
): Promise<string> => {
  const review = await manager.reviewSessionStart({
    authority: sessionAuthority,
    fast: false,
    preset: "astra",
    requirement: ASTRA_REQUIREMENT,
    projectRoot: PROJECT_ROOT,
    signal: signal(),
  });
  const started = await manager.startSession({
    authority: sessionAuthority,
    projectRoot: PROJECT_ROOT,
    review,
    signal: signal(),
  });
  return started.providerThreadId;
};

const startTurn = async (
  manager: PinnedDevinRuntimeManager,
  providerThreadId: string,
  message = "do the work",
  sessionAuthority: ProfileAuthority = authority,
): Promise<string> => {
  const review = await manager.reviewTurnStart({
    authority: sessionAuthority,
    fast: false,
    preset: "astra",
    requirement: ASTRA_REQUIREMENT,
    projectRoot: PROJECT_ROOT,
    providerThreadId,
    signal: signal(),
  });
  const result = await manager.startTurn({
    authority: sessionAuthority,
    clientMessageId: "client-message-1",
    message,
    projectRoot: PROJECT_ROOT,
    providerThreadId,
    review,
    signal: signal(),
  });
  return result.turnId;
};

const closeCustody = (manager: DevinRuntimePort) => {
  if (manager.closeCustody === undefined) throw new Error("expected explicit Devin close custody");
  return manager.closeCustody;
};

describe("Devin joined close custody", () => {
  test("freezes an exact live-writer snapshot without provider calls and proves only its joined close", async () => {
    const { manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      const observation = await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      const framesBefore = process.received.length;
      const custody = closeCustody(manager);
      const witnesses = custody.snapshot();
      expect(process.received).toHaveLength(framesBefore);
      expect(process.finished).toBe(false);
      expect(witnesses).toHaveLength(1);
      const witness = witnesses[0];
      if (witness === undefined) throw new Error("expected close witness");
      expect(witness).toMatchObject({
        authority, providerThreadId, connectionId: observation.connectionId, projectRoot: PROJECT_ROOT,
        effectiveRuntimeProfile: { preset: "astra", processGeneration: authority.generation },
      });
      expect(Object.isFrozen(witnesses)).toBe(true);
      expect(Object.isFrozen(witness)).toBe(true);
      expect(Object.isFrozen(witness.authority)).toBe(true);
      expect(Object.isFrozen(witness.effectiveRuntimeProfile)).toBe(true);
      expect(Reflect.set(witness, "connectionId", "changed")).toBe(false);
      expect(Reflect.set(witness.authority, "generation", 999)).toBe(false);
      expect(Reflect.set(witness.effectiveRuntimeProfile, "processGeneration", 999)).toBe(false);
      const proof = await custody.close(witnesses);
      expect(process.finished).toBe(true);
      expect(Object.isFrozen(proof)).toBe(true);
      expect(proof[0]).toBe(witness);
      await expect(custody.close(witnesses)).rejects.toMatchObject({ code: "PROCESS_EXITED" });
      expect(() => custody.snapshot()).toThrow("closed");
    } finally {
      await manager.close();
    }
  });

  test("an empty manager or an unactivated writer grants no close witness", async () => {
    const empty = harness();
    expect(closeCustody(empty.manager).snapshot()).toEqual([]);
    expect(await closeCustody(empty.manager).close([])).toEqual([]);
    expect(empty.processes).toHaveLength(0);
    const { manager, processes } = harness();
    try {
      await startSession(manager);
      expect(closeCustody(manager).snapshot()).toEqual([]);
      expect(await closeCustody(manager).close([])).toEqual([]);
      expect(processes[0]?.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test.each(["copied", "foreign", "duplicate"] as const)("rejects %s witnesses without sacrificing cleanup custody", async (kind) => {
    const { manager, processes } = harness();
    const foreign = harness();
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const witness = custody.snapshot()[0];
      if (witness === undefined) throw new Error("expected close witness");
      if (kind === "foreign") {
        const foreignId = await startSession(foreign.manager);
        await foreign.manager.observeSession({ authority, providerThreadId: foreignId, signal: signal() });
        await expect(closeCustody(foreign.manager).close([witness])).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
        expect(foreign.processes[0]?.finished).toBe(true);
        expect(processes[0]?.finished).toBe(false);
        expect(await custody.close([witness])).toEqual([witness]);
      } else {
        await expect(custody.close(kind === "copied" ? [{ ...witness }] : [witness, witness]))
          .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      }
      expect(processes[0]?.finished).toBe(true);
    } finally {
      await Promise.all([manager.close(), foreign.manager.close()]);
    }
  });

  test.each([false, true])("never recycles a closed writer proof (replacement: %s)", async (replace) => {
    const { manager, processes } = harness({ projectRootFor: () => PROJECT_ROOT });
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const original = custody.snapshot();
      await manager.endSession({ authority, providerThreadId, signal: signal() });
      if (replace) {
        await manager.observeSession({ authority, providerThreadId, signal: signal() });
        expect(custody.snapshot()[0]?.connectionId).not.toBe(original[0]?.connectionId);
      } else {
        expect(custody.snapshot()).toEqual([]);
      }
      await expect(custody.close(original)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(processes.every((process) => process.finished)).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test("a captured writer becoming active loses proof eligibility without losing cleanup custody", async () => {
    const { manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const original = custody.snapshot();
      await startTurn(manager, providerThreadId);
      expect(custody.snapshot()).toEqual([]);
      await expect(custody.close(original)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(processes[0]?.finished).toBe(true);
    } finally {
      await manager.close();
    }
    expect(processes[0]?.finished).toBe(true);
  });

  test("captures the selected array before awaiting and shares one concurrent ordinary close", async () => {
    const { manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const selected = [...custody.snapshot()];
      const original = selected[0];
      const pending = custody.close(selected);
      selected.length = 0;
      await manager.close();
      const proof = await pending;
      expect(proof).toHaveLength(1);
      expect(proof[0]).toBe(original);
      expect(processes[0]?.terminateCalls).toBe(1);
      await expect(custody.close(proof)).rejects.toMatchObject({ code: "PROCESS_EXITED" });
      expect(processes[0]?.terminateCalls).toBe(1);
    } finally {
      await manager.close();
    }
  });

  test.each(["before", "during"] as const)("refuses authority changed %s close while joining original custody", async (when) => {
    let current = true;
    const { manager, processes } = harness({ isCurrent: () => current });
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const captured = custody.snapshot();
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      if (when === "before") current = false;
      else process.beforeTerminate = () => { current = false; };
      await expect(custody.close(captured)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(process.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test("bounds supplied witness lists without skipping normal cleanup", async () => {
    const { manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const witness = custody.snapshot()[0];
      if (witness === undefined) throw new Error("expected close witness");
      await expect(custody.close(Array.from({ length: 1_025 }, () => witness)))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(processes[0]?.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test("close admission makes late permissions and an awaited turn start inert", async () => {
    const { manager, processes, facts } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      const review = await manager.reviewTurnStart({
        authority, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, providerThreadId, signal: signal(),
      });
      const custody = closeCustody(manager);
      const witnesses = custody.snapshot();
      // This request is waiting at activation, before it can create a turn or
      // write a native prompt. Closing must win that continuation's fence.
      const starting = manager.startTurn({
        authority, providerThreadId, projectRoot: PROJECT_ROOT, review,
        message: "must remain unsent", clientMessageId: "unsent-close", signal: signal(),
      });
      void starting.catch(() => undefined);
      process.beforeTerminate = () => process.sendPermission(901);
      const proof = await custody.close(witnesses);
      await expect(starting).rejects.toMatchObject({ code: "PROCESS_EXITED" });
      expect(proof).toEqual(witnesses);
      expect(process.received.some((frame) => method(frame) === "session/prompt")).toBe(false);
      expect(facts.some((fact) => fact.type === "interactionRequested" || fact.type === "turnStarted")).toBe(false);
      expect(process.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test("a permission admitted before closing invalidates the original idle witness", async () => {
    const { manager, processes, facts } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      const custody = closeCustody(manager);
      const witnesses = custody.snapshot();
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      process.sendPermission(902);
      await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
      expect(custody.snapshot()).toEqual([]);
      await expect(custody.close(witnesses)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(process.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test.each(["process_join", "output_drain"] as const)("grants no sibling proof after a partial %s failure", async (failure) => {
    const first = new FakeDevinProcess("devin-session-first");
    const second = new FakeDevinProcess("devin-session-second");
    let releaseOutput!: () => void;
    const output = new Promise<void>((resolve) => { releaseOutput = resolve; });
    const blockedOutput: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() { await output; yield new Uint8Array(); },
    };
    const secondProcess: DevinAcpProcess = {
      stdin: second.stdin, stdout: second.stdout,
      stderr: failure === "output_drain" ? blockedOutput : second.stderr,
      exited: second.exited,
      terminate: () => second.terminate(),
      forceTerminate: () => second.forceTerminate(),
    };
    const available: DevinAcpProcess[] = [first, secondProcess];
    const { manager } = harness({
      closeDeadlineMs: 1,
      processFactory: () => {
        const process = available.shift();
        if (process === undefined) throw new Error("unexpected Devin launch");
        return process;
      },
    });
    try {
      for (const process of [first, second]) {
        const providerThreadId = await startSession(manager);
        expect(providerThreadId).toBe(process.sessionId);
        await manager.observeSession({ authority, providerThreadId, signal: signal() });
      }
      const custody = closeCustody(manager);
      const witnesses = custody.snapshot();
      expect(witnesses).toHaveLength(2);
      second.shutdownBlocked = failure === "process_join";
      let granted = false;
      await expect(custody.close(witnesses).then(() => { granted = true; }))
        .rejects.toThrow("could not be joined during shutdown");
      expect(granted).toBe(false);
      expect(first.finished).toBe(true);
      expect(second.finished).toBe(failure === "output_drain");
      expect(() => custody.snapshot()).toThrow("closed");
    } finally {
      second.finish(0);
      releaseOutput();
      await manager.close().catch(() => undefined);
    }
  });
});

describe("pinned Devin runtime manager", () => {
  test.each([
    { ...authority, provider: "codex", providerAccountId: authority.id },
    { ...authority, provider: "claude", providerAccountId: "pact_00000000000000000000000000000000" },
    { ...authority, providerAccountId: "dact_NOT_AN_ACCOUNT" },
    { ...authority, bindingGeneration: 0 },
    { ...authority, bindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...authority, generation: 0 },
    { ...authority, generation: Number.MAX_SAFE_INTEGER + 1 },
  ] satisfies ProfileAuthority[])("rejects foreign or malformed Devin authority before review %#", async (invalid) => {
    const { manager, processes } = harness();
    try {
      await expect(manager.reviewSessionStart({
        authority: invalid, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: signal(),
      })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(processes).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });

  test.each(["new", "load"] as const)("fences authority after ACP initialization before %s dispatch", async (operation) => {
    let current = true;
    const process = new FakeDevinProcess();
    process.beforeInitializeResponse = () => { current = false; };
    const { manager } = harness({
      isCurrent: () => current,
      processFactory: () => process,
      projectRootFor: () => PROJECT_ROOT,
    });
    try {
      if (operation === "new") {
        await expect(startSession(manager)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      } else {
        await expect(manager.observeSession({
          authority, providerThreadId: process.sessionId, signal: signal(),
        })).rejects.toMatchObject({ reason: "resume_unavailable" });
      }
      expect(process.received.some((frame) => method(frame) === `session/${operation}`)).toBe(false);
      expect(process.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test.each(["retired", "canceled"] as const)("fences prompt after the turn-start observer is %s", async (boundary) => {
    let current = true;
    const controller = new AbortController();
    const cancellation = new Error("exact test cancellation");
    const { manager, processes } = harness({
      isCurrent: () => current,
      onFact: (fact) => {
        if (fact.type !== "turnStarted") return;
        if (boundary === "retired") current = false;
        else controller.abort(cancellation);
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      const review = await manager.reviewTurnStart({
        authority, providerThreadId, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: controller.signal,
      });
      const pending = manager.startTurn({
        authority, providerThreadId, review, message: "one request", clientMessageId: "one",
        projectRoot: PROJECT_ROOT, signal: controller.signal,
      });
      if (boundary === "retired") await expect(pending).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      else await expect(pending).rejects.toBe(cancellation);
      expect(processes[0]?.received.some((frame) => method(frame) === "session/prompt")).toBe(false);
    } finally {
      await manager.close();
    }
  });

  test("refuses a prompt when permission arrives while its turn-start observer awaits", async () => {
    const process = new FakeDevinProcess();
    let injected = false;
    const { manager, facts } = harness({
      processFactory: () => process,
      onFact: async (fact) => {
        if (fact.type !== "turnStarted" || injected) return;
        injected = true;
        process.sendPermission();
        await waitFor(() => facts.some((observed) => observed.type === "interactionRequested"));
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      await expect(startTurn(manager, providerThreadId)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(process.received.filter((frame) => method(frame) === "session/prompt" || frame.id === 77)).toHaveLength(0);
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
      const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
      expect(provider).toMatchObject({
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        profileId: authority.id,
        bindingGeneration: authority.bindingGeneration,
        processGeneration: authority.generation,
        threadId: providerThreadId,
      });
      expect(await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() }))
        .toMatchObject({ status: "idle", messages: [] });
      await manager.resolveInteraction({
        authority,
        deadlineAt: NOW + 1_000,
        kind: "permission_approval",
        provider,
        resolution: { decision: "once", kind: "approval_decision" },
        signal: signal(),
      });
      await startTurn(manager, providerThreadId);
      await waitFor(() => process.promptRequestId !== undefined);
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(1);
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test.each(["cancelled", "permission"] as const)("preserves provider updates when pre-dispatch admission is %s", async (boundary) => {
    const process = new FakeDevinProcess();
    const controller = new AbortController();
    const cancellation = new Error("cancel before native prompt");
    let injected = false;
    const { manager, facts } = harness({
      processFactory: () => process,
      onFact: async (fact) => {
        if (fact.type !== "turnStarted" || injected) return;
        injected = true;
        process.sendUpdate({
          content: { type: "text", text: "preserved update" },
          messageId: "late-update",
          sessionUpdate: "agent_message_chunk",
        });
        await waitFor(() => facts.some((observed) => observed.type === "assistantDelta"));
        if (boundary === "cancelled") controller.abort(cancellation);
        else {
          process.sendPermission();
          await waitFor(() => facts.some((observed) => observed.type === "interactionRequested"));
        }
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      const review = await manager.reviewTurnStart({
        authority, providerThreadId, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: controller.signal,
      });
      const attempt = manager.startTurn({
        authority, providerThreadId, review, message: "never sent ".repeat(2_000), clientMessageId: "unsent",
        projectRoot: PROJECT_ROOT, signal: controller.signal,
      });
      if (boundary === "cancelled") await expect(attempt).rejects.toBe(cancellation);
      else await expect(attempt).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const projection = await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() });
      expect(projection).toMatchObject({
        status: "idle", title: "Untitled session",
        omission: { omittedMessages: 0, truncatedMessages: 0 },
      });
      expect(projection.messages).toMatchObject([{ role: "assistant", text: "preserved update" }]);
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(0);
      process.sendUpdate({
        content: { type: "text", text: " plus more" },
        messageId: "late-update",
        sessionUpdate: "agent_message_chunk",
      });
      await waitFor(async () => (await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() }))
        .messages?.[0]?.text === "preserved update plus more");
      if (boundary === "permission") {
        await manager.resolveInteraction({
          authority, provider: manager.interactionAuthority(authority, providerThreadId, "n:77"),
          deadlineAt: NOW + 1_000, kind: "permission_approval",
          resolution: { decision: "once", kind: "approval_decision" }, signal: signal(),
        });
      }
      await startTurn(manager, providerThreadId, "later admitted request");
      const retried = await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() });
      expect(retried.messages).toMatchObject([
        { role: "assistant", text: "preserved update plus more" },
        { role: "user", text: "later admitted request" },
      ]);
      await waitFor(() => process.promptRequestId !== undefined);
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(1);
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test("does not evict bounded history for an unsent prompt across an observer await", async () => {
    const process = new FakeDevinProcess();
    const controller = new AbortController();
    const cancellation = new Error("cancel without provisional eviction");
    let inject = false;
    const { manager, facts } = harness({
      processFactory: () => process,
      onFact: async (fact) => {
        if (fact.type !== "turnStarted" || !inject) return;
        inject = false;
        process.sendUpdate({
          content: { type: "text", text: "new retained update" },
          messageId: "late-history-update", sessionUpdate: "agent_message_chunk",
        });
        await waitFor(() => facts.some((observed) => observed.type === "assistantDelta" && observed.text === "new retained update"));
        controller.abort(cancellation);
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      // Two completed turns fill the 256-message ring without exceeding the
      // separate per-turn 128-assembler or 256-open-item limits.
      for (let turn = 0; turn < 2; turn += 1) {
        const turnId = await startTurn(manager, providerThreadId, `earlier request ${turn}`);
        await waitFor(() => process.promptRequestId !== undefined);
        for (let index = 0; index < 127; index += 1) {
          process.sendUpdate({
            content: { type: "text", text: `history ${turn}:${index}` },
            messageId: `history-${turn}-${index}`, sessionUpdate: "agent_message_chunk",
          });
        }
        await waitFor(() => facts.filter((fact) => fact.type === "assistantDelta").length === (turn + 1) * 127);
        process.completePrompt("end_turn");
        await waitFor(() => facts.some((fact) => fact.type === "turnCompleted" && fact.turn.id === turnId));
      }
      const before = await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() });
      expect(before.messages).toHaveLength(256);
      expect(before.omission?.omittedMessages).toBe(0);
      const review = await manager.reviewTurnStart({
        authority, providerThreadId, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: controller.signal,
      });
      inject = true;
      await expect(manager.startTurn({
        authority, providerThreadId, review, message: "must never enter history", clientMessageId: "unsent",
        projectRoot: PROJECT_ROOT, signal: controller.signal,
      })).rejects.toBe(cancellation);
      const after = await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() });
      expect(after.messages).toHaveLength(256);
      expect(after.messages?.slice(0, -1)).toEqual(before.messages?.slice(1));
      expect(after.messages?.at(-1)).toMatchObject({ role: "assistant", text: "new retained update" });
      expect(after.omission?.omittedMessages).toBe(1);
      expect(after.title).toBe(before.title);
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(2);
      await startTurn(manager, providerThreadId, "one later retry");
      const retried = await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() });
      expect(retried.messages?.filter((message) => message.role === "user" && message.text === "one later retry"))
        .toHaveLength(1);
      expect(retried.messages?.some((message) => message.clientId === "unsent")).toBe(false);
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test("observes an exact initial-generation account without admitting a session effect", async () => {
    const initial = { ...authority, generation: 0 };
    let reads = 0;
    let current = true;
    const { manager, processes } = harness({
      isCurrent: () => current,
      readAuthStatus: async () => { reads += 1; return { signedIn: true }; },
    });
    try {
      expect(await manager.readAccount({ authority: initial, signal: signal() })).toEqual({ signedIn: true });
      expect(reads).toBe(1);
      await expect(startSession(manager, initial)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      current = false;
      await expect(manager.readAccount({ authority: initial, signal: signal() })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(reads).toBe(1);
      expect(processes).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });

  test.each(["retired", "canceled"] as const)("does not publish account readiness after its probe is %s", async (boundary) => {
    let current = true;
    const controller = new AbortController();
    const cancellation = new Error("status probe canceled");
    const { manager, processes } = harness({
      isCurrent: () => current,
      readAuthStatus: async () => {
        if (boundary === "retired") current = false;
        else controller.abort(cancellation);
        return { signedIn: true };
      },
    });
    try {
      const pending = manager.readAccount({ authority, signal: controller.signal });
      if (boundary === "retired") await expect(pending).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      else await expect(pending).rejects.toBe(cancellation);
      expect(processes).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });

  test("keeps Devin review and session custody independent of sibling provider generations", async () => {
    const generations = { codex: 91, claude: 27, devin: authority.generation };
    const { manager, factAuthorities } = harness({
      isCurrent: (candidate) => candidate.generation === generations[candidate.provider]
        && candidate.providerAccountId === authority.providerAccountId
        && candidate.bindingGeneration === authority.bindingGeneration,
    });
    try {
      const review = await manager.reviewSessionStart({
        authority, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: signal(),
      });
      generations.codex += 1;
      generations.claude += 1;
      const started = await manager.startSession({ authority, review, projectRoot: PROJECT_ROOT, signal: signal() });
      await startTurn(manager, started.providerThreadId);
      expect(generations.devin).toBe(authority.generation);
      expect(factAuthorities.every((captured) => captured.provider === "devin"
        && captured.generation === authority.generation
        && captured.bindingGeneration === authority.bindingGeneration)).toBe(true);
      expect("rebindProfileAuthority" in manager).toBe(false);
    } finally {
      await manager.close();
    }
  });

  test.each(["account", "binding", "process"] as const)("never substitutes a changed %s authority in reviews, sessions, interactions, or cleanup", async (field) => {
    const changed = {
      ...authority,
      ...(field === "account" ? { providerAccountId: "dact_11111111111111111111111111111111" } : {}),
      ...(field === "binding" ? { bindingGeneration: authority.bindingGeneration + 1 } : {}),
      ...(field === "process" ? { generation: authority.generation + 1 } : {}),
    };
    const { manager, processes } = harness();
    try {
      const review = await manager.reviewSessionStart({
        authority, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: signal(),
      });
      await expect(manager.startSession({
        authority: changed, projectRoot: PROJECT_ROOT, review, signal: signal(),
      })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(processes).toHaveLength(0);
      const providerThreadId = await startSession(manager);
      const turnId = await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      await waitFor(() => process.promptRequestId !== undefined);
      process.sendPermission();
      await waitFor(() => {
        try { return manager.interactionAuthority(authority, providerThreadId, "n:77").requestId.value === "n:77"; }
        catch { return false; }
      });
      const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
      const framesBefore = process.received.length;
      await expect(manager.readSession({ authority: changed, providerThreadId, detail: true, signal: signal() })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      await expect(manager.interrupt({ authority: changed, providerThreadId, activeTurnId: turnId, signal: signal() })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      await expect(manager.endSession({ authority: changed, providerThreadId, signal: signal() })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(() => manager.interactionAuthority(changed, providerThreadId, "n:77")).toThrow("another authority");
      const substituted = {
        ...provider,
        providerAccountId: changed.providerAccountId,
        bindingGeneration: changed.bindingGeneration,
        processGeneration: changed.generation,
      };
      await expect(manager.resolveInteraction({
        authority, provider: substituted, kind: "permission_approval",
        resolution: { kind: "approval_decision", decision: "once" }, deadlineAt: NOW + 1_000, signal: signal(),
      })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      await expect(manager.timeoutInteraction({ authority, provider: substituted, signal: signal() })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(process.received).toHaveLength(framesBefore);
      expect(manager.interactionAuthority(authority, providerThreadId, "n:77")).toEqual(provider);
      await manager.endSession({ authority, providerThreadId, signal: signal() });
      expect(process.finished).toBe(true);
      await expect(manager.endSession({ authority: changed, providerThreadId, signal: signal() })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
      await manager.endSession({ authority, providerThreadId, signal: signal() });
    } finally {
      await manager.close();
    }
  });

  test("freezes original review and callback custody even if the caller mutates its authority", async () => {
    const callerAuthority = { ...authority };
    const { manager, factAuthorities } = harness();
    try {
      const pending = manager.reviewSessionStart({
        authority: callerAuthority, fast: false, preset: "astra", requirement: ASTRA_REQUIREMENT,
        projectRoot: PROJECT_ROOT, signal: signal(),
      });
      callerAuthority.generation += 1;
      callerAuthority.bindingGeneration += 1;
      const review = await pending;
      expect(review.effectiveRuntimeProfile.processGeneration).toBe(authority.generation);
      expect(Reflect.set(review.effectiveRuntimeProfile, "processGeneration", 999)).toBe(false);
      const started = await manager.startSession({ authority, review, projectRoot: PROJECT_ROOT, signal: signal() });
      await startTurn(manager, started.providerThreadId, "still the original request", authority);
      expect(factAuthorities.length).toBeGreaterThan(0);
      expect(factAuthorities.every((captured) => JSON.stringify(captured) === JSON.stringify(authority))).toBe(true);
      expect(factAuthorities.every(Object.isFrozen)).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test("fences exact permission request identity and freezes the published authority", async () => {
    const { manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      await waitFor(() => process.promptRequestId !== undefined);
      process.sendPermission();
      await waitFor(() => {
        try { return manager.interactionAuthority(authority, providerThreadId, "n:77").requestId.value === "n:77"; }
        catch { return false; }
      });
      const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
      expect(Object.isFrozen(provider)).toBe(true);
      expect(Object.isFrozen(provider.requestId)).toBe(true);
      for (const changed of [
        { ...provider, provider: "claude" as const, providerAccountId: "pact_00000000000000000000000000000000" },
        { ...provider, turnId: "another-turn" },
        { ...provider, itemId: "another-item" },
        { ...provider, approvalId: "another-approval" },
      ]) {
        await expect(manager.validateInteractionResolution({
          authority, provider: changed, kind: "permission_approval",
          resolution: { kind: "approval_decision", decision: "once" }, signal: signal(),
        })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      }
      await manager.resolveInteraction({
        authority, provider, kind: "permission_approval", resolution: { kind: "approval_decision", decision: "once" },
        deadlineAt: NOW + 1_000, signal: signal(),
      });
      expect(process.received.filter((frame) => frame.id === 77)).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test("drops stale facts and delayed permission settlements while still joining original custody", async () => {
    let current = true;
    const { manager, processes, facts } = harness({ isCurrent: () => current });
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected Devin writer");
      await waitFor(() => process.promptRequestId !== undefined);
      process.sendPermission();
      await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
      const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
      await manager.resolveInteraction({
        authority, provider, kind: "permission_approval", resolution: { kind: "approval_decision", decision: "once" },
        deadlineAt: NOW + 1_000, signal: signal(),
      });
      current = false;
      const published = facts.length;
      process.sendUpdate({ content: { text: "stale answer", type: "text" }, sessionUpdate: "agent_message_chunk" });
      process.sendPermission(78);
      process.completePrompt("end_turn");
      await settle();
      await manager.close();
      expect(facts).toHaveLength(published);
      expect(process.finished).toBe(true);
      expect(() => manager.interactionAuthority(authority, providerThreadId, "n:78")).toThrow();
    } finally {
      await manager.close();
    }
  });

  test("does not coalesce a native session load across different account bindings", async () => {
    let releaseRoot!: () => void;
    const rootReady = new Promise<void>((resolve) => { releaseRoot = resolve; });
    let rootReads = 0;
    const { manager, processes } = harness({
      projectRootFor: async () => { rootReads += 1; await rootReady; return PROJECT_ROOT; },
    });
    const loading = manager.observeSession({ authority, providerThreadId: "devin-session-1", signal: signal() });
    void loading.catch(() => undefined);
    try {
      await expect(manager.observeSession({
        authority: { ...authority, bindingGeneration: authority.bindingGeneration + 1 },
        providerThreadId: "devin-session-1", signal: signal(),
      })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(rootReads).toBe(1);
      expect(processes).toHaveLength(0);
      releaseRoot();
      expect((await loading).resumed).toBe(true);
      expect(processes).toHaveLength(1);
    } finally {
      releaseRoot();
      await loading.catch(() => undefined);
      await manager.close();
    }
  });

  test("reviews the exact pin and Astra argv, then projects a bounded ACP turn", async () => {
    const { facts, launches, manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    expect(effectiveDevinRuntimeProfileSchema.parse(review.effectiveRuntimeProfile)).toEqual({
      devinVersion: DEVIN_PIN,
      isolatedHome: true,
      model: DEVIN_MODEL,
      observedAt: NOW,
      preset: "astra",
      processGeneration: authority.generation,
      profileId: authority.id,
      protocolVersion: 1,
      reasoningEffort: "provider-default",
    });
    const started = await manager.startSession({
      authority,
      projectRoot: PROJECT_ROOT,
      review,
      signal: signal(),
    });
    expect(started).toMatchObject({
      providerThreadId: "devin-session-1",
      projectRoot: PROJECT_ROOT,
      status: "idle",
    });
    expect(manager.pinnedVersion()).toBe(DEVIN_PIN);
    expect(launches[0]?.runtime.argv).toEqual([
      "/usr/local/bin/devin",
      "acp",
      "--model",
      "gpt-6-astra",
    ]);

    const turnId = await startTurn(manager, started.providerThreadId, "Run tests");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    expect(process.received.find((entry) => method(entry) === "session/prompt")).toMatchObject({
      params: {
        prompt: [{ text: "Run tests", type: "text" }],
        sessionId: "devin-session-1",
      },
    });

    process.sendUpdate({
      content: { text: "done", type: "text" },
      messageId: "message-1",
      sessionUpdate: "agent_message_chunk",
    });
    process.sendUpdate({
      cost: { amount: 0.01, currency: "USD" },
      sessionUpdate: "usage_update",
      size: 200_000,
      used: 53_000,
    });
    process.sendUpdate({
      entries: [{ content: "Run tests", priority: "high", status: "completed" }],
      sessionUpdate: "plan",
    });
    process.sendPermission();
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));

    const usage = facts.find((fact) => fact.type === "tokenUsageUpdated");
    expect(usage).toMatchObject({
      cachedInputTokens: null,
      inputTokens: null,
      modelContextWindow: 200_000,
      outputTokens: null,
      providerCost: { amount: 0.01, currency: "USD" },
      reasoningOutputTokens: null,
      totalTokens: 53_000,
      turnId,
    });
    // ACP's context occupancy is not an account allowance or reset window.
    expect(facts.some((fact) => fact.type === "rateLimitsUpdated")).toBe(false);

    const interaction = manager.interactionAuthority(authority, started.providerThreadId, "n:77");
    expect(facts.find((fact) => fact.type === "interactionRequested")).toMatchObject({
      display: { allowsSessionScope: false },
    });
    expect(interaction).toMatchObject({
      approvalId: "tool-1",
      method: "devin/session/request_permission",
      processGeneration: authority.generation,
      provider: authority.provider,
      providerAccountId: authority.providerAccountId,
      bindingGeneration: authority.bindingGeneration,
      profileId: authority.id,
      requestId: { type: "string", value: "n:77" },
      threadId: started.providerThreadId,
      turnId,
    });
    expect(await manager.inspectInteractionAuthority({
      authority,
      kind: "permission_approval",
      provider: interaction,
      signal: signal(),
    })).toEqual({
      environmentId: null,
      kind: "permission_approval",
      permissions: ["workspace:execute"],
      reason: "Run the focused tests",
      workingDirectory: PROJECT_ROOT,
    });
    const validated = await manager.validateInteractionResolution({
      authority,
      kind: "permission_approval",
      provider: interaction,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await manager.resolveInteraction({
      authority,
      deadlineAt: NOW + 1_000,
      kind: "permission_approval",
      provider: interaction,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    });
    expect(process.received.find((entry) => entry.id === 77)).toEqual({
      id: 77,
      jsonrpc: "2.0",
      result: { outcome: { optionId: "allow-once", outcome: "selected" } },
    });

    process.completePrompt("end_turn");
    await waitFor(async () => (await manager.readSession({
      authority,
      detail: false,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    })).status === "idle");
    const projection = await manager.readSession({
      authority,
      detail: true,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    expect(projection.messages).toEqual([
      { clientId: "client-message-1", role: "user", text: "Run tests", turnId },
      { role: "assistant", text: "done", turnId },
    ]);
    expect(projection.turnSummaries?.[0]).toMatchObject({ id: turnId, status: "completed" });
    await manager.close();
    expect(process.finished).toBe(true);
  });

  test("loads an existing native session through the injected exact project root", async () => {
    const { facts, manager, processes } = harness({
      projectRootFor: ({ providerThreadId }) =>
        providerThreadId === "devin-session-1" ? PROJECT_ROOT : undefined,
    });
    const observation = await manager.observeSession({
      authority,
      providerThreadId: "devin-session-1",
      signal: signal(),
    });
    expect(observation.resumed).toBe(true);
    expect(observation.projection.messages).toEqual([
      { role: "assistant", text: "replayed answer" },
    ]);
    // Replay builds the read projection but cannot duplicate historical live facts.
    expect(facts.some((fact) => fact.type === "assistantDelta")).toBe(false);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    expect(process.received.find((entry) => method(entry) === "session/load")).toMatchObject({
      params: {
        cwd: PROJECT_ROOT,
        mcpServers: [],
        sessionId: "devin-session-1",
      },
    });

    const turnId = await startTurn(manager, "devin-session-1", "continue");
    await waitFor(() => process.promptRequestId !== undefined);
    process.sendUpdate({
      kind: "execute",
      sessionUpdate: "tool_call",
      status: "pending",
      title: "Command still running",
      toolCallId: "tool-pending",
    });
    await waitFor(() => facts.some((fact) =>
      fact.type === "itemStarted" && fact.itemId === "devin-tool:tool-pending"));
    await manager.interrupt({
      activeTurnId: turnId,
      authority,
      providerThreadId: "devin-session-1",
      signal: signal(),
    });
    await waitFor(() => facts.some((fact) =>
      fact.type === "turnCompleted" && fact.turn.id === turnId));
    expect(facts.find((fact) =>
      fact.type === "turnCompleted" && fact.turn.id === turnId)).toMatchObject({
      turn: { status: "interrupted" },
    });
    expect(facts.find((fact) =>
      fact.type === "itemCompleted" && fact.itemId === "devin-tool:tool-pending"))
      .toMatchObject({ status: "interrupted" });
    await manager.close();
  });

  test("buffers new-session updates until the returned session id is bound", async () => {
    const created: FakeDevinProcess[] = [];
    const { manager } = harness({
      processFactory: () => {
        const process = new FakeDevinProcess();
        process.beforeNewResponse = () => {
          process.sendSessionUpdate(process.sessionId, {
            content: { text: "bound answer", type: "text" },
            messageId: "bound-message",
            sessionUpdate: "agent_message_chunk",
          });
        };
        created.push(process);
        return process;
      },
    });

    const providerThreadId = await startSession(manager);
    expect((await manager.readSession({
      authority,
      detail: true,
      providerThreadId,
      signal: signal(),
    })).messages).toEqual([{ role: "assistant", text: "bound answer" }]);
    await manager.close();
    expect(created[0]?.finished).toBe(true);
  });

  test("rejects permission requests before the native new-session response establishes their session", async () => {
    const process = new FakeDevinProcess();
    process.beforeNewResponse = () => { process.sendPermission(); };
    const { manager, facts } = harness({ processFactory: () => process });
    try {
      await expect(startSession(manager)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(0);
      expect(process.finished).toBe(true);
    } finally {
      await manager.close();
    }
  });

  test("surfaces pre-adoption permissions exactly once after the new thread is observed", async () => {
    const process = new FakeDevinProcess();
    const { manager, facts } = harness({ processFactory: () => process });
    try {
      const providerThreadId = await startSession(manager);
      process.sendPermission();
      await settle();
      await manager.readSession({ authority, providerThreadId, detail: true, signal: signal() });
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(0);
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      await manager.observeSession({ authority, providerThreadId, signal: signal() });
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toMatchObject([{
        provider: {
          provider: "devin", profileId: authority.id, providerAccountId: authority.providerAccountId,
          bindingGeneration: authority.bindingGeneration, processGeneration: authority.generation,
          threadId: providerThreadId, turnId: null, requestId: { type: "string", value: "n:77" },
        },
      }]);
      expect(process.received.filter((frame) => method(frame) === "session/prompt" || frame.id === 77)).toHaveLength(0);
      expect(manager.interactionAuthority(authority, providerThreadId, "n:77").providerAccountId).toBe(authority.providerAccountId);
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test("activates switch-target permissions before a seed turn and refuses its prompt until they settle", async () => {
    const process = new FakeDevinProcess();
    const { manager, facts } = harness({ processFactory: () => process });
    try {
      const providerThreadId = await startSession(manager);
      process.sendPermission();
      await settle();
      await expect(startTurn(manager, providerThreadId, "seed context")).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
      expect(facts.filter((fact) => fact.type === "turnStarted")).toHaveLength(0);
      expect(process.received.filter((frame) => method(frame) === "session/prompt" || frame.id === 77)).toHaveLength(0);
      const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
      expect(provider.turnId).toBeNull();
      await manager.resolveInteraction({
        authority,
        deadlineAt: NOW + 1_000,
        kind: "permission_approval",
        provider,
        resolution: { decision: "once", kind: "approval_decision" },
        signal: signal(),
      });
      await startTurn(manager, providerThreadId, "seed context");
      await waitFor(() => process.promptRequestId !== undefined);
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(1);
      expect(process.received.filter((frame) => frame.id === 77)).toHaveLength(1);
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test.each(["cancelled", "retired"] as const)("stops deferred permission activation when observation is %s", async (failure) => {
    const process = new FakeDevinProcess();
    const controller = new AbortController();
    const cancellation = new Error("observation cancelled");
    let current = true;
    const { manager, facts } = harness({
      processFactory: () => process,
      isCurrent: () => current,
      onFact: (fact) => {
        if (fact.type !== "interactionRequested") return;
        if (failure === "cancelled") controller.abort(cancellation);
        else current = false;
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      process.sendPermission(77);
      process.sendPermission(78, undefined, "tool-2");
      await settle();
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(0);
      const observation = manager.observeSession({ authority, providerThreadId, signal: controller.signal });
      if (failure === "cancelled") await expect(observation).rejects.toBe(cancellation);
      else await expect(observation).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
      expect(process.received.filter((frame) => method(frame) === "session/prompt" || frame.id === 77 || frame.id === 78)).toHaveLength(0);
      if (failure === "cancelled") {
        // Cancellation stops this observation, not the already adopted writer's
        // unrelated live facts or settlement of its published permission.
        process.send({ jsonrpc: "2.0", method: "_cognition.ai/after_cancel", params: {} });
        const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
        await manager.resolveInteraction({
          authority,
          deadlineAt: NOW + 1_000,
          kind: "permission_approval",
          provider,
          resolution: { decision: "once", kind: "approval_decision" },
          signal: signal(),
        });
        await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
        expect(facts.filter((fact) => fact.type === "interactionResolved")).toHaveLength(1);
        expect(facts.filter((fact) => fact.type === "protocolNotice" && fact.method === "_cognition.ai/after_cancel"))
          .toHaveLength(1);
        expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
        // A later, separately authorized observation drains only the unpublished
        // permission; the first callback and its immutable request are not replayed.
        await manager.observeSession({ authority, providerThreadId, signal: signal() });
        expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) => fact.provider.requestId.value))
          .toEqual(["n:77", "n:78"]);
      }
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test("coalesces permission activation and keeps new arrivals ordered while the first callback is pending", async () => {
    const process = new FakeDevinProcess();
    let releaseFirst!: () => void;
    const firstCallback = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { manager, facts } = harness({
      processFactory: () => process,
      onFact: async (fact) => {
        if (fact.type === "interactionRequested" && fact.provider.requestId.value === "n:77") await firstCallback;
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      process.sendPermission();
      await settle();
      const first = manager.observeSession({ authority, providerThreadId, signal: signal() });
      await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
      const second = manager.observeSession({ authority, providerThreadId, signal: signal() });
      process.sendPermission(78, undefined, "tool-2");
      await settle();
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(1);
      await expect(startTurn(manager, providerThreadId)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      releaseFirst();
      await Promise.all([first, second]);
      expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) => fact.provider.requestId.value))
        .toEqual(["n:77", "n:78"]);
      expect(process.received.filter((frame) => method(frame) === "session/prompt" || frame.id === 77 || frame.id === 78)).toHaveLength(0);
    } finally {
      releaseFirst();
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test("fails closed and joins the child when pre-adoption permissions exceed their bound", async () => {
    const process = new FakeDevinProcess();
    const { manager, facts } = harness({ processFactory: () => process });
    try {
      await startSession(manager);
      for (let index = 0; index < 17; index += 1) {
        process.sendPermission(77 + index, undefined, `tool-${index}`);
      }
      await waitFor(() => process.finished);
      expect(facts.filter((fact) => fact.type === "interactionRequested")).toHaveLength(0);
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(0);
      expect(process.terminated).toBe(true);
    } finally {
      await manager.close();
      expect(process.finished).toBe(true);
    }
  });

  test("admits a queued continuation as soon as turn completion is published", async () => {
    let continued = false;
    let continuationFailure: unknown;
    let finishContinuation!: () => void;
    const continuationFinished = new Promise<void>((resolve) => { finishContinuation = resolve; });
    const { manager, processes } = harness({
      onFact: async (fact) => {
        if (fact.type !== "turnCompleted" || continued) return;
        continued = true;
        try {
          await startTurn(manager, fact.threadId, "queued continuation");
        } catch (error: unknown) {
          continuationFailure = error;
        } finally {
          finishContinuation();
        }
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected one Devin process");
      await waitFor(() => process.promptRequestId !== undefined);
      process.completePrompt("end_turn");
      await continuationFinished;
      expect(continuationFailure).toBeUndefined();
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  test("omits supported ACP metadata and raw thoughts without declaring protocol incompatibility", async () => {
    const { facts, manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected one Devin process");
      await waitFor(() => process.promptRequestId !== undefined);
      process.sendUpdate({
        content: { text: "private provider reasoning", type: "text" },
        sessionUpdate: "agent_thought_chunk",
      });
      for (const update of [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echoed user prompt" } },
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { sessionUpdate: "current_mode_update", currentModeId: "default" },
        { sessionUpdate: "config_option_update", configOptions: [] },
        { sessionUpdate: "session_info_update", title: "Example" },
      ]) process.sendUpdate(update);
      process.sendUpdate({ sessionUpdate: "unexpected_extension_update" });
      process.sendUpdate({
        content: { text: "visible answer", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      await waitFor(() => facts.some((fact) => fact.type === "assistantDelta"));
      expect(facts.flatMap((fact) => fact.type === "protocolNotice"
        && fact.method.startsWith("session/update:") ? [fact.method] : []))
        .toEqual(["session/update:unexpected_extension_update"]);
      expect(JSON.stringify(facts)).not.toContain("private provider reasoning");
      expect((await manager.readSession({
        authority, detail: true, providerThreadId, signal: signal(),
      })).messages?.at(-1)).toMatchObject({ role: "assistant", text: "visible answer" });
    } finally {
      await manager.close();
    }
  });

  test("retains cumulative omitted bytes when more deltas follow a truncated assistant message", async () => {
    const { facts, manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected one Devin process");
      await waitFor(() => process.promptRequestId !== undefined);
      for (const text of ["a".repeat(17_000), "tail"]) {
        process.sendUpdate({
          content: { text, type: "text" },
          messageId: "long-message",
          sessionUpdate: "agent_message_chunk",
        });
      }
      await waitFor(() => facts.filter((fact) => fact.type === "assistantDelta").length === 2);
      const projection = await manager.readSession({
        authority, detail: true, providerThreadId, signal: signal(),
      });
      expect(projection.messages?.at(-1)?.omission).toEqual({
        omittedUtf8Bytes: 620,
        originalUtf8Bytes: 17_004,
        returnedUtf8Bytes: 16_384,
      });
      expect(projection.omission?.truncatedMessages).toBe(1);
    } finally {
      await manager.close();
    }
  });

  test("rejects a new-session update for an id other than the returned session", async () => {
    let process: FakeDevinProcess | undefined;
    const { manager } = harness({
      processFactory: () => {
        process = new FakeDevinProcess();
        process.beforeNewResponse = () => {
          process?.sendSessionUpdate("foreign-session", {
            content: { text: "foreign answer", type: "text" },
            messageId: "foreign-message",
            sessionUpdate: "agent_message_chunk",
          });
        };
        return process;
      },
    });

    await expect(startSession(manager)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(process?.finished).toBe(true);
    await manager.close();
  });

  test("fails closed when new-session facts exceed their pre-bind bound", async () => {
    let process: FakeDevinProcess | undefined;
    const { manager } = harness({
      processFactory: () => {
        process = new FakeDevinProcess();
        process.beforeNewResponse = () => {
          for (let index = 0; index < 129; index += 1) {
            process?.sendSessionUpdate("devin-session-1", {
              content: { text: "x", type: "text" },
              messageId: `prebind-${index}`,
              sessionUpdate: "agent_message_chunk",
            });
          }
        };
        return process;
      },
    });

    await expect(startSession(manager)).rejects.toThrow("fact consumer failed");
    expect(process?.terminated).toBe(true);
    expect(process?.finished).toBe(true);
    await manager.close();
  });

  test("retires a proven dead writer so observation can load and continue the session", async () => {
    const { facts, manager, processes } = harness({
      projectRootFor: ({ providerThreadId }) =>
        providerThreadId === "devin-session-1" ? PROJECT_ROOT : undefined,
    });
    const providerThreadId = await startSession(manager);
    await manager.observeSession({ authority, providerThreadId, signal: signal() });
    const first = processes[0];
    if (first === undefined) throw new Error("expected an initial Devin process");
    first.finish(17);
    await waitFor(() => facts.some((fact) => fact.type === "providerDisconnected"));

    const observation = await manager.observeSession({
      authority,
      providerThreadId,
      signal: signal(),
    });
    expect(observation.resumed).toBe(true);
    expect(processes).toHaveLength(2);
    const replacement = processes[1];
    if (replacement === undefined) throw new Error("expected a replacement Devin process");
    expect(replacement.received.some((entry) => method(entry) === "session/load")).toBe(true);

    const turnId = await startTurn(manager, providerThreadId, "continue after crash");
    await waitFor(() => replacement.promptRequestId !== undefined);
    await manager.interrupt({ activeTurnId: turnId, authority, providerThreadId, signal: signal() });
    await manager.close();
  });

  test("refuses ambiguous steering and a second concurrent prompt", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    const activeTurnId = await startTurn(manager, providerThreadId, "first");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    await expect(manager.steer({
      activeTurnId,
      authority,
      clientMessageId: "client-message-2",
      message: "change direction",
      providerThreadId,
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });

    const secondReview = await manager.reviewTurnStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      providerThreadId,
      signal: signal(),
    });
    await expect(manager.startTurn({
      authority,
      clientMessageId: "client-message-3",
      message: "second",
      projectRoot: PROJECT_ROOT,
      providerThreadId,
      review: secondReview,
      signal: signal(),
    })).rejects.toThrow("already has an active prompt");
    await manager.interrupt({ activeTurnId, authority, providerThreadId, signal: signal() });
    await manager.close();
  });

  test("fails a missing load root and fences a post-spawn authority change while joining the child", async () => {
    const withoutRoot = harness();
    await expect(withoutRoot.manager.observeSession({
      authority,
      providerThreadId: "unknown",
      signal: signal(),
    })).rejects.toMatchObject({ reason: "resume_unavailable" });
    expect(withoutRoot.processes).toEqual([]);
    await withoutRoot.manager.close();

    let current = true;
    let spawned: FakeDevinProcess | undefined;
    const fenced = harness({
      isCurrent: () => current,
      processFactory: () => {
        spawned = new FakeDevinProcess();
        spawned.beforeNewResponse = () => { current = false; };
        return spawned;
      },
    });
    const review = await fenced.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await expect(fenced.manager.startSession({
      authority,
      projectRoot: PROJECT_ROOT,
      review,
      signal: signal(),
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(spawned?.finished).toBe(true);
    await fenced.manager.close();
  });

  test("projects only Devin's signed-in boolean and refuses other-provider presets", async () => {
    const statusCalls: DevinDirectories[] = [];
    const { manager } = harness({
      readAuthStatus: async (input) => {
        statusCalls.push(input.directories);
        return { signedIn: true };
      },
    });
    expect(await manager.readAccount({ authority, signal: signal() })).toEqual({ signedIn: true });
    expect(statusCalls).toEqual([directories]);
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "ultra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toBeInstanceOf(PresetProviderMismatchError);
    await expect(manager.reviewSessionStart({
      authority,
      fast: true,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: { effort: "max", model: "gpt-5.6-sol" },
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await manager.close();
  });

  test("checks deadlines and never widens a bounded denial into persistent rejection", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    process.sendPermission();
    await settle();
    const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
    await expect(manager.resolveInteraction({
      authority,
      deadlineAt: NOW - 1,
      kind: "permission_approval",
      provider,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    expect(process.received.some((entry) => entry.id === 77)).toBe(false);
    const validated = await manager.validateInteractionTimeout({ authority, provider, signal: signal() });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await manager.timeoutInteraction({ authority, provider, signal: signal() });
    expect(process.received.find((entry) => entry.id === 77)).toEqual({
      id: 77,
      jsonrpc: "2.0",
      result: { outcome: { optionId: "reject-once", outcome: "selected" } },
    });

    const persistentOnly = [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
    ];
    process.sendPermission(78, persistentOnly);
    await waitFor(() => {
      try { return manager.interactionAuthority(authority, providerThreadId, "n:78").requestId.value === "n:78"; }
      catch { return false; }
    });
    const decline = manager.interactionAuthority(authority, providerThreadId, "n:78");
    await manager.resolveInteraction({
      authority,
      deadlineAt: NOW + 1_000,
      kind: "permission_approval",
      provider: decline,
      resolution: { decision: "decline", kind: "approval_decision" },
      signal: signal(),
    });
    expect(process.received.find((entry) => entry.id === 78)).toEqual({
      id: 78,
      jsonrpc: "2.0",
      result: { outcome: { outcome: "cancelled" } },
    });

    process.sendPermission(79, persistentOnly);
    await waitFor(() => {
      try { return manager.interactionAuthority(authority, providerThreadId, "n:79").requestId.value === "n:79"; }
      catch { return false; }
    });
    const timedOut = manager.interactionAuthority(authority, providerThreadId, "n:79");
    await manager.timeoutInteraction({ authority, provider: timedOut, signal: signal() });
    expect(process.received.find((entry) => entry.id === 79)).toEqual({
      id: 79,
      jsonrpc: "2.0",
      result: { outcome: { outcome: "cancelled" } },
    });
    await manager.close();
  });

  test("never maps HRA session scope to Devin's provider-persistent allow-always option", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    process.sendPermission();
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
    expect(facts.find((fact) => fact.type === "interactionRequested")).toMatchObject({
      display: { allowsSessionScope: false },
    });

    await expect(manager.validateInteractionResolution({
      authority,
      kind: "permission_approval",
      provider,
      resolution: { decision: "session", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(manager.validateInteractionResolution({
      authority,
      kind: "permission_approval",
      provider,
      resolution: {
        kind: "permission_grant",
        permissions: ["workspace:execute"],
        scope: "session",
      },
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(manager.resolveInteraction({
      authority,
      deadlineAt: NOW + 1_000,
      kind: "permission_approval",
      provider,
      resolution: { decision: "session", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(process.received.some((entry) => entry.id === 77)).toBe(false);
    await manager.interrupt({
      activeTurnId: (await manager.readSession({
        authority,
        detail: false,
        providerThreadId,
        signal: signal(),
      })).activeTurnId ?? "",
      authority,
      providerThreadId,
      signal: signal(),
    });
    await manager.close();
  });

  test("fails the provider connection when pending permissions exceed the adapter bound", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    for (let index = 0; index < 17; index += 1) {
      process.sendPermission(1_000 + index, undefined, `permission-tool-${index}`);
    }
    await waitFor(() => process.terminated);
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerError" && fact.message.includes("fact consumer failed")));
    expect(facts.find((fact) => fact.type === "providerError")).toMatchObject({ terminal: true });
    await manager.close();
  });

  test("fails the provider connection when open tool items exceed the adapter bound", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    for (let index = 0; index < 257; index += 1) {
      process.sendUpdate({
        kind: "execute",
        sessionUpdate: "tool_call",
        status: "pending",
        title: `tool ${index}`,
        toolCallId: `tool-${index}`,
      });
    }
    await waitFor(() => process.terminated);
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerError" && fact.message.includes("fact consumer failed")));
    expect(facts.find((fact) => fact.type === "providerError")).toMatchObject({ terminal: true });
    await manager.close();
  });

  test("fails the provider connection when assistant assemblers exceed the adapter bound", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    for (let index = 0; index < 129; index += 1) {
      process.sendUpdate({
        content: { text: "x", type: "text" },
        messageId: `assistant-${index}`,
        sessionUpdate: "agent_message_chunk",
      });
    }
    await waitFor(() => process.terminated);
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerError" && fact.message.includes("fact consumer failed")));
    expect(facts.find((fact) => fact.type === "providerError")).toMatchObject({ terminal: true });
    await manager.close();
  });
});
