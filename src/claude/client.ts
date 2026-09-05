import { randomUUID } from "node:crypto";

import type { PreparedAttachment } from "../domain/attachments.ts";
import { ClaudeDeltaAssembler, type ClaudeFact } from "./assembler.ts";
import { ClaudeError } from "./errors.ts";
import { ClaudeJsonLineDecoder } from "./jsonl.ts";
import type { ClaudeProcess } from "./process.ts";
import {
  claudeControlResponse,
  claudeControlResponseLine,
  claudeInterruptLine,
  claudeRequestDigest,
  claudeResponseDigest,
  claudeUserLine,
  parseClaudeStreamLine,
  type ClaudeCanUseTool,
  type ClaudeControlResponse,
} from "./protocol.ts";

export type ClaudeInteractionDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "answer"; answers: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "deny"; message: string }>;

export interface ClaudeStreamClientOptions {
  readonly process: ClaudeProcess;
  /** Absolute isolated home the process was spawned with. Fences every write. */
  readonly configDir: string;
  readonly onFact: (fact: ClaudeFact) => void | Promise<void>;
  readonly onSafeDiagnostic?: (message: string) => void;
  readonly maxJsonLineBytes?: number;
  readonly shutdownTermGraceMs?: number;
  readonly shutdownSettlementMs?: number;
}

type PendingInteraction = {
  readonly requestId: string;
  readonly request: ClaudeCanUseTool;
  readonly requestDigest: string;
};

const STDERR_DIAGNOSTIC_BYTES = 4 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_FORCE_JOIN_DEADLINE_MS = 1_000;

const boundedShutdownDuration = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new ClaudeError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
};

const resolvesWithin = async (promise: Promise<unknown>, milliseconds: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => false as const,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const settlesWithin = async (promise: Promise<unknown>, milliseconds: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => true as const,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Owns one pinned Claude Code process speaking stream-json in both
 * directions. It translates every stdout line through the bridge's parser and
 * delta assembler, and it is the only writer of the process's stdin.
 */
export class ClaudeStreamClient {
  readonly #process: ClaudeProcess;
  readonly #configDir: string;
  readonly #onFact: ClaudeStreamClientOptions["onFact"];
  readonly #onSafeDiagnostic: ((message: string) => void) | undefined;
  readonly #assembler = new ClaudeDeltaAssembler();
  readonly #decoder: ClaudeJsonLineDecoder;
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #encoder = new TextEncoder();
  readonly #readTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #exitTask: Promise<number>;
  readonly #shutdownTermGraceMs: number;
  readonly #shutdownSettlementMs: number;
  #exitResolved = false;
  #closeTask: Promise<void> | null = null;
  #state: "open" | "closing" | "closed" = "open";
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: ClaudeStreamClientOptions) {
    if (!options.configDir.startsWith("/")) {
      throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
    }
    this.#process = options.process;
    this.#configDir = options.configDir;
    this.#onFact = options.onFact;
    this.#onSafeDiagnostic = options.onSafeDiagnostic;
    this.#shutdownTermGraceMs = boundedShutdownDuration(
      options.shutdownTermGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
      "Claude TERM grace",
    );
    this.#shutdownSettlementMs = boundedShutdownDuration(
      options.shutdownSettlementMs ?? PROCESS_FORCE_JOIN_DEADLINE_MS,
      "Claude shutdown settlement",
    );
    this.#decoder = new ClaudeJsonLineDecoder(
      options.maxJsonLineBytes === undefined ? {} : { maxLineBytes: options.maxJsonLineBytes },
    );
    this.#exitTask = this.#process.exited.then((code) => {
      this.#exitResolved = true;
      return code;
    });
    void this.#exitTask.catch(() => undefined);
    this.#readTask = this.#readStdout();
    this.#stderrTask = this.#drainStderr();
  }

  get configDir(): string {
    return this.#configDir;
  }

  get providerSessionId(): string | null {
    return this.#assembler.providerSessionId;
  }

  get activeTurnId(): string | null {
    return this.#assembler.activeTurnId;
  }

  /** Starts a turn: HRA mints the turn id, then writes the turn's `user` line. */
  async startTurn(input: Readonly<{
    turnId: string;
    message: string;
    attachments?: readonly PreparedAttachment[];
  }>): Promise<void> {
    this.#assertOpen();
    const facts = this.#assembler.beginTurn(input.turnId);
    await this.#write(claudeUserLine(input.message, input.attachments ?? []));
    for (const fact of facts) await this.#onFact(fact);
  }

  /** Steering is the same wire shape: another `user` line while a turn runs. */
  async steer(
    message: string,
    attachments: readonly PreparedAttachment[] = [],
  ): Promise<void> {
    this.#assertOpen();
    if (this.#assembler.activeTurnId === null) {
      throw new ClaudeError("INVALID_INPUT", "No Claude turn is in flight to steer");
    }
    await this.#write(claudeUserLine(message, attachments));
  }

  /** Asks the runtime to stop the in-flight turn. Its `result` reads interrupted. */
  async interrupt(): Promise<void> {
    this.#assertOpen();
    if (this.#assembler.activeTurnId === null) return;
    this.#assembler.markInterrupted();
    await this.#write(claudeInterruptLine(randomUUID()));
  }

  pendingInteraction(requestId: string): PendingInteraction | undefined {
    return this.#pending.get(requestId);
  }

  /** Computes the exact bytes a decision would write, without writing them. */
  validateInteractionResolution(
    requestId: string,
    decision: ClaudeInteractionDecision,
  ): Readonly<{ response: ClaudeControlResponse; responseDigest: string }> {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending");
    }
    const response = claudeControlResponse(pending.request, decision);
    return { response, responseDigest: claudeResponseDigest(response) };
  }

  async resolveInteraction(
    requestId: string,
    decision: ClaudeInteractionDecision,
  ): Promise<Readonly<{ responseDigest: string }>> {
    this.#assertOpen();
    const validated = this.validateInteractionResolution(requestId, decision);
    await this.#write(claudeControlResponseLine(requestId, validated.response));
    this.#pending.delete(requestId);
    return { responseDigest: validated.responseDigest };
  }

  async close(): Promise<void> {
    if (this.#closeTask === null) this.#closeTask = this.#close();
    await this.#closeTask;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    if (!this.#exitResolved) {
      try {
        this.#process.terminate();
      } catch {
        this.#onSafeDiagnostic?.("claude TERM failed; forcing process termination");
      }
      await resolvesWithin(this.#exitTask, this.#shutdownTermGraceMs);
    }
    if (!this.#exitResolved) {
      try {
        this.#process.forceTerminate();
      } catch {
        this.#onSafeDiagnostic?.("claude force termination failed");
      }
    }
    const [exitSettled, stdoutSettled, stderrSettled] = await Promise.all([
      resolvesWithin(this.#exitTask, this.#shutdownSettlementMs),
      settlesWithin(this.#readTask, this.#shutdownSettlementMs),
      settlesWithin(this.#stderrTask, this.#shutdownSettlementMs),
    ]);
    if (!exitSettled) {
      throw new ClaudeError(
        "TIMEOUT",
        "Claude session process could not be joined after forced termination.",
      );
    }
    if (!stdoutSettled || !stderrSettled) {
      throw new ClaudeError(
        "TIMEOUT",
        "Claude session output could not be drained after forced termination.",
      );
    }
    try {
      for (const fact of this.#assembler.abandonTurn("the Claude runtime was closed")) {
        await this.#onFact(fact);
      }
    } finally {
      this.#pending.clear();
      this.#state = "closed";
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new ClaudeError("PROCESS_EXITED", "The Claude runtime connection is closed");
    }
  }

  #write(line: string): Promise<void> {
    const bytes = this.#encoder.encode(line);
    const chained = this.#writeChain.then(() => this.#process.write(bytes));
    this.#writeChain = chained.catch(() => undefined);
    return chained;
  }

  async #readStdout(): Promise<void> {
    try {
      for await (const chunk of this.#process.stdout) {
        for (const value of this.#decoder.push(chunk)) await this.#dispatch(value);
      }
      for (const value of this.#decoder.finish()) await this.#dispatch(value);
    } catch (error: unknown) {
      this.#onSafeDiagnostic?.(
        error instanceof ClaudeError
          ? `claude stream fault: ${error.code}`
          : "claude stream fault: unknown",
      );
    }
    if (this.#state === "open") {
      for (const fact of this.#assembler.abandonTurn("the Claude stream ended")) {
        await this.#onFact(fact);
      }
    }
  }

  async #dispatch(value: unknown): Promise<void> {
    const event = parseClaudeStreamLine(value);
    for (const fact of this.#assembler.apply(event)) {
      if (fact.type === "interactionRequested") {
        this.#pending.set(fact.requestId, {
          request: fact.request,
          requestDigest: claudeRequestDigest(fact.requestId, fact.request),
          requestId: fact.requestId,
        });
      }
      if (fact.type === "interactionCanceled") this.#pending.delete(fact.requestId);
      await this.#onFact(fact);
    }
  }

  async #drainStderr(): Promise<void> {
    let observed = 0;
    try {
      for await (const chunk of this.#process.stderr) {
        observed += chunk.byteLength;
        if (observed > STDERR_DIAGNOSTIC_BYTES) break;
      }
    } catch {
      // Diagnostics are advisory; provider stderr never becomes HRA data.
    }
    if (observed > 0) this.#onSafeDiagnostic?.(`claude stderr bytes: ${String(observed)}`);
  }
}
