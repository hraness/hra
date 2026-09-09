import { Effect, Exit } from "effect";

import type { PreparedAttachment } from "../domain/attachments.ts";
import { ClaudeDeltaAssembler, type ClaudeFact } from "./assembler.ts";
import type { ClaudeInteractionDecision, ClaudeStreamClientOptions, ClaudeStreamInitialization } from "./session-model.ts";
import { ClaudeError } from "./errors.ts";
import { ClaudeJsonLineDecoder } from "./jsonl.ts";
import {
  claudeControlResponse, claudeControlResponseLine, claudeInterruptLine,
  claudeRequestDigest, claudeResponseDigest, claudeUserLine, parseClaudeStreamLine,
  type ClaudeCanUseTool, type ClaudeControlResponse,
} from "./protocol.ts";
import { ClaudeConnectionEffects } from "./session-effects.ts";
import { failureReason, taskFailure } from "./session-model.ts";
import {
  attempt, ClaudeConnectionWork, consumeNative, initializationObservation,
  nativeCall, nativeRequestId, nativeMicrotask, observeWithin, processExitObservation, type ClaudeOwnedTask, type ClaudeProgram, type ClaudeCompletion,
} from "./session-platform.ts";

type PendingInteraction = Readonly<{
  requestId: string;
  request: ClaudeCanUseTool;
  requestDigest: string;
}>;

type PendingTurnStart = {
  readonly turnId: string;
  readonly facts: Array<Readonly<{ fact: ClaudeFact; bytes: number }>>;
  bytes: number;
  draining: ClaudeOwnedTask<void> | null;
};

const boundedShutdownDuration = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new ClaudeError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
};

/** The domain state is one connection's exact identity and buffered history.
 * Effects own ordering, native waits, shared drains and retryable cleanup. */
export class ClaudeClientProgram {
  readonly #options: ClaudeStreamClientOptions;
  readonly #owner: ClaudeConnectionEffects;
  readonly #onFactProgram: ((fact: ClaudeFact) => ClaudeProgram<void>) | undefined;
  readonly #assembler: ClaudeDeltaAssembler;
  readonly #decoder: ClaudeJsonLineDecoder;
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #encoder = new TextEncoder();
  readonly #initialization: ClaudeCompletion<ClaudeStreamInitialization>;
  readonly #exit: Promise<number>;
  readonly #shutdownTermGraceMs: number;
  readonly #shutdownSettlementMs: number;
  #initializationSettled = false;
  #initializationValue: ClaudeStreamInitialization | undefined;
  #exitResolved = false;
  #activated = false;
  #readTask: ClaudeOwnedTask<void> | undefined;
  #stderrTask: ClaudeOwnedTask<void> | undefined;
  #exitWatchTask: ClaudeOwnedTask<void> | undefined;
  #closeTask: ClaudeOwnedTask<void> | null = null;
  #closeFactsTask: ClaudeOwnedTask<void> | null = null;
  #writeJoin: ClaudeOwnedTask<void> | null = null;
  #state: "open" | "closing" | "closed" | "failed" = "open";
  #disconnectEmitted = false;
  #pendingTurnStart: PendingTurnStart | null = null;

  constructor(options: ClaudeStreamClientOptions, owner: ClaudeConnectionEffects, onFactProgram?: (fact: ClaudeFact) => ClaudeProgram<void>) {
    if (!options.configDir.startsWith("/")) {
      throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
    }
    this.#options = options;
    this.#owner = owner;
    this.#initialization = owner.initializationCompletion<ClaudeStreamInitialization>();
    this.#onFactProgram = onFactProgram;
    this.#assembler = new ClaudeDeltaAssembler(options.now === undefined ? {} : { now: options.now });
    this.#shutdownTermGraceMs = boundedShutdownDuration(options.shutdownTermGraceMs ?? 250, "Claude TERM grace");
    this.#shutdownSettlementMs = boundedShutdownDuration(options.shutdownSettlementMs ?? 1_000, "Claude shutdown settlement");
    this.#decoder = new ClaudeJsonLineDecoder(options.maxJsonLineBytes === undefined ? {} : { maxLineBytes: options.maxJsonLineBytes });
    // This synchronous accessor remains inside manager raw-process custody.
    // Its exact native Promise, rather than a fiber's completion, proves exit.
    this.#exit = processExitObservation(options.process, () => { this.#exitResolved = true; });
  }

  get configDir(): string { return this.#options.configDir; }
  get providerSessionId(): string | null { return this.#assembler.providerSessionId; }
  get activeTurnId(): string | null { return this.#assembler.activeTurnId; }
  get state(): "open" | "closing" | "closed" | "failed" { return this.#state; }

  /** Borrowed construction is inert; the manager composes this on its interpreter. */
  activate(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      if (this.#activated) return;
      this.#activated = true;
      yield* this.#owner.fork("control", this.#initialization.program);
      this.#readTask = yield* this.#owner.fork("stdout", this.#readStdout());
      this.#stderrTask = yield* this.#owner.fork("stderr", this.#drainStderr());
      this.#exitWatchTask = yield* this.#owner.fork("exit-watch", this.#watchProcessExit());
    });
  }

  /** Returns the exact native observation without awaiting or interpreting it. */
  initializationObservation(input: Readonly<{ signal: AbortSignal; timeoutMs: number }>): ClaudeProgram<Promise<ClaudeStreamInitialization>> {
    return attempt(() => initializationObservation(this.#initialization.promise, input));
  }

  waitForInitialization(input: Readonly<{ signal: AbortSignal; timeoutMs: number }>): ClaudeProgram<ClaudeStreamInitialization> {
    return Effect.gen(this, function* () {
      const observation = yield* this.initializationObservation(input);
      return yield* nativeCall(() => observation);
    });
  }

  startTurn(input: Readonly<{ turnId: string; message: string; attachments?: readonly PreparedAttachment[] }>): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      yield* attempt(() => this.#assertOpen());
      if (this.#pendingTurnStart !== null) return yield* Effect.fail(taskFailure(new ClaudeError("INVALID_INPUT", "A Claude turn start is still settling")));
      const line = yield* attempt(() => claudeUserLine(input.message, input.attachments ?? []));
      yield* attempt(() => this.#assembler.beginTurn(input.turnId));
      const pending: PendingTurnStart = { turnId: input.turnId, facts: [], bytes: 0, draining: null };
      this.#pendingTurnStart = pending;
      const written = yield* Effect.exit(Effect.zipRight(this.#write(line), attempt(() => this.#assertOpen())));
      if (Exit.isFailure(written)) {
        const drained = yield* Effect.exit(this.#drainPendingTurnStart(pending, false));
        // R4: a throwing diagnostic wins, and skips abandonTurn below.
        if (Exit.isFailure(drained)) yield* this.#diagnostic("HRA fact delivery failed after Claude turn admission failed");
        yield* attempt(() => this.#assembler.abandonTurn("the Claude turn write failed"));
        return yield* Effect.failCause(written.cause);
      }
      yield* this.#drainPendingTurnStart(pending, true);
    });
  }

  steer(message: string, attachments: readonly PreparedAttachment[] = []): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      yield* attempt(() => this.#assertOpen());
      if (this.#assembler.activeTurnId === null) return yield* Effect.fail(taskFailure(new ClaudeError("INVALID_INPUT", "No Claude turn is in flight to steer")));
      yield* this.#write(yield* attempt(() => claudeUserLine(message, attachments)));
    });
  }

  interrupt(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      yield* attempt(() => this.#assertOpen());
      if (this.#assembler.activeTurnId === null) return;
      yield* attempt(() => this.#assembler.markInterrupted());
      yield* this.#write(claudeInterruptLine(yield* nativeRequestId()));
    });
  }

  pendingInteraction(requestId: string): PendingInteraction | undefined { return this.#pending.get(requestId); }

  validateInteractionResolution(requestId: string, decision: ClaudeInteractionDecision): Readonly<{ response: ClaudeControlResponse; responseDigest: string }> {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending");
    const response = claudeControlResponse(pending.request, decision);
    return { response, responseDigest: claudeResponseDigest(response) };
  }

  resolveInteraction(requestId: string, decision: ClaudeInteractionDecision): ClaudeProgram<Readonly<{ responseDigest: string }>> {
    return Effect.gen(this, function* () {
      yield* attempt(() => this.#assertOpen());
      const validated = yield* attempt(() => this.validateInteractionResolution(requestId, decision));
      yield* this.#write(yield* attempt(() => claudeControlResponseLine(requestId, validated.response)));
      this.#pending.delete(requestId);
      return { responseDigest: validated.responseDigest };
    });
  }

  close(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      if (this.#owner.callbackActive()) {
        return yield* Effect.fail(taskFailure(new ClaudeError("INVALID_INPUT", "Claude fact callbacks cannot join their own client cleanup.")));
      }
      if (this.#closeTask !== null) return yield* this.#closeTask.program;
      if (this.#state === "closed") return;
      // Admission is fenced in the caller's immediate fiber before a fork or wait.
      this.#state = "closing";
      this.#failInitialization(new ClaudeError("PROCESS_EXITED", "The Claude runtime closed before initialization."));
      const completion = yield* this.#owner.reserve<void>("control");
      this.#closeTask = completion.task;
      const result = yield* Effect.exit(Effect.gen(this, function* () {
        // TERM is part of synchronous close admission. In particular, an exit
        // already resolved natively but not yet observed must not skip this call.
        const waitForTerm = !this.#exitResolved;
        if (waitForTerm) {
          const terminated = yield* Effect.exit(attempt(() => this.#options.process.terminate()));
          if (Exit.isFailure(terminated)) yield* this.#diagnostic("claude TERM failed; forcing process termination");
        }
        const task = yield* this.#owner.fork("control", this.#closeResources(waitForTerm));
        yield* task.program;
      }));
      if (Exit.isFailure(result)) {
        completion.reject(failureReason(result.cause));
        if (this.#closeTask === completion.task) this.#closeTask = null;
        return yield* Effect.failCause(result.cause);
      }
      completion.succeed(undefined);
    });
  }

  #closeResources(waitForTerm: boolean): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      yield* this.activate();
      const readTask = this.#readTask;
      const stderrTask = this.#stderrTask;
      const watcherTask = this.#exitWatchTask;
      if (readTask === undefined || stderrTask === undefined || watcherTask === undefined) {
        return yield* Effect.die(new Error("Claude stream owners were not activated"));
      }
      if (waitForTerm) yield* observeWithin(this.#exit, this.#shutdownTermGraceMs, true);
      if (!this.#exitResolved) {
        const forced = yield* Effect.exit(attempt(() => this.#options.process.forceTerminate()));
        if (Exit.isFailure(forced)) yield* this.#diagnostic("claude force termination failed");
      }
      const observations = [
        observeWithin(this.#exit, this.#shutdownSettlementMs, true),
        observeWithin(readTask.promise, this.#shutdownSettlementMs),
        observeWithin(stderrTask.promise, this.#shutdownSettlementMs),
        observeWithin(watcherTask.promise, this.#shutdownSettlementMs),
      ];
      const [exitSettled, stdoutSettled, stderrSettled, watcherSettled] = yield* Effect.all(observations, { concurrency: "unbounded" });
      if (!exitSettled) return yield* Effect.fail(taskFailure(new ClaudeError("TIMEOUT", "Claude session process could not be joined after forced termination.")));
      if (!stdoutSettled || !stderrSettled || !watcherSettled) {
        return yield* Effect.fail(taskFailure(new ClaudeError("TIMEOUT", "Claude session output could not be drained after forced termination.")));
      }
      // A completed child or EOF is not proof that a started stdin write settled.
      // Keep one exact barrier across bounded retries; no admission can reopen it.
      this.#writeJoin ??= yield* this.#owner.fork("control", this.#owner.join("writes"));
      this.#closeFactsTask ??= yield* this.#owner.fork("facts", Effect.zipRight(nativeMicrotask(), this.#closeFacts()));
      const [writesSettled, factsSettled] = yield* Effect.all([
        observeWithin(this.#writeJoin.promise, this.#shutdownSettlementMs),
        observeWithin(this.#closeFactsTask.promise, this.#shutdownSettlementMs),
      ], { concurrency: "unbounded" });
      if (!writesSettled) {
        return yield* Effect.fail(taskFailure(new ClaudeError("TIMEOUT", "Claude session writes could not be joined after forced termination.")));
      }
      if (!factsSettled) {
        return yield* Effect.fail(taskFailure(new ClaudeError("TIMEOUT", "Claude session terminal facts could not be drained after forced termination.")));
      }
      const facts = yield* Effect.exit(this.#closeFactsTask.program);
      this.#pending.clear();
      this.#state = "closed";
      if (Exit.isFailure(facts)) return yield* Effect.failCause(facts.cause);
    });
  }

  #closeFacts(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      let first: Exit.Failure<unknown, import("./session-model.ts").ClaudeTaskFailure> | undefined;
      if (this.#pendingTurnStart !== null) {
        const drained = yield* Effect.exit(this.#drainPendingTurnStart(this.#pendingTurnStart, false));
        if (Exit.isFailure(drained)) first = drained;
      }
      for (const fact of this.#assembler.abandonTurn("the Claude runtime was closed")) {
        const delivered = yield* Effect.exit(this.#emitFact(fact));
        if (Exit.isFailure(delivered)) first ??= delivered;
      }
      if (first !== undefined) return yield* Effect.failCause(first.cause);
    });
  }

  #assertOpen(): void {
    if (this.#state !== "open") throw new ClaudeError("PROCESS_EXITED", "The Claude runtime connection is closed");
  }

  #write(line: string): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      const bytes = this.#encoder.encode(line);
      const work = yield* ClaudeConnectionWork;
      const task = yield* this.#owner.fork("writes", work.writeOrder.withPermits(1)(
        Effect.gen(this, function* () {
          // Each admitted frame is deferred, including the first native write.
          yield* nativeMicrotask();
          yield* attempt(() => this.#assertOpen());
          yield* nativeCall(() => this.#options.process.write(bytes));
        }),
      ));
      yield* task.program;
    });
  }

  #diagnostic(message: string): ClaudeProgram<void> {
    return attempt(() => { this.#options.onSafeDiagnostic?.(message); });
  }

  #deliverFact(fact: ClaudeFact): ClaudeProgram<void> {
    const onFactProgram = this.#onFactProgram;
    return onFactProgram === undefined
      ? this.#owner.callback(() => this.#options.onFact(fact))
      : Effect.suspend(() => onFactProgram(fact));
  }

  #emitFact(fact: ClaudeFact): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      const pending = this.#pendingTurnStart;
      if (pending !== null && fact.type !== "rateLimitObserved"
        && (("turnId" in fact && fact.turnId === pending.turnId) || fact.type === "interactionCanceled")) {
        const bytes = this.#encoder.encode(JSON.stringify(fact)).byteLength;
        if (pending.facts.length >= 256 || pending.bytes + bytes > 1024 * 1024) {
          yield* this.#diagnostic("Claude pending turn facts exceeded their bounded capacity");
          return yield* Effect.fail(taskFailure(new ClaudeError("PROTOCOL_LIMIT", "Claude pending turn facts exceeded their bounded capacity")));
        }
        pending.facts.push({ fact, bytes });
        pending.bytes += bytes;
        return;
      }
      yield* this.#deliverFact(fact);
    });
  }

  #drainPendingTurnStart(pending: PendingTurnStart, accepted: boolean): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      if (pending.draining !== null) return yield* pending.draining.program;
      if (this.#pendingTurnStart !== pending) return;
      const drain = Effect.gen(this, function* () {
        yield* nativeMicrotask();
        let first: Exit.Failure<unknown, import("./session-model.ts").ClaudeTaskFailure> | undefined;
        if (accepted) {
          const delivered = yield* Effect.exit(this.#deliverFact({ type: "turnStarted", turnId: pending.turnId }));
          if (Exit.isFailure(delivered)) first = delivered;
        }
        for (;;) {
          const item = pending.facts.shift();
          if (item === undefined) break;
          pending.bytes -= item.bytes;
          const delivered = yield* Effect.exit(this.#deliverFact(item.fact));
          if (Exit.isFailure(delivered)) first ??= delivered;
        }
        if (this.#pendingTurnStart === pending) this.#pendingTurnStart = null;
        if (first !== undefined) return yield* Effect.failCause(first.cause);
      });
      pending.draining = yield* this.#owner.fork("facts", drain);
      yield* pending.draining.program;
    });
  }

  #readStdout(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      let reason: "eof" | "protocol_fault" = "eof";
      const read = yield* Effect.exit(Effect.gen(this, function* () {
        yield* consumeNative(this.#options.process.stdout, chunk => Effect.gen(this, function* () {
          for (const value of yield* attempt(() => this.#decoder.push(chunk))) yield* this.#dispatch(value);
        }));
        for (const value of yield* attempt(() => this.#decoder.finish())) yield* this.#dispatch(value);
      }));
      if (Exit.isFailure(read)) {
        reason = "protocol_fault";
        const error = failureReason(read.cause);
        this.#failInitialization(error instanceof ClaudeError ? error : new ClaudeError("PROTOCOL_ERROR", "Claude initialization could not be parsed."));
        yield* this.#diagnostic(error instanceof ClaudeError ? `claude stream fault: ${error.code}` : "claude stream fault: unknown");
      }
      yield* this.#handleUnexpectedDisconnect(reason);
    });
  }

  #watchProcessExit(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      const exit = yield* Effect.exit(nativeCall(() => this.#exit));
      if (Exit.isFailure(exit)) yield* this.#fenceAmbiguousProcessExit();
      else yield* this.#handleUnexpectedDisconnect("process_exit");
    });
  }

  #fenceAmbiguousProcessExit(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      if (this.#state !== "open") return;
      this.#state = "failed";
      this.#pending.clear();
      this.#failInitialization(new ClaudeError("PROCESS_EXITED", "Claude process settlement became indeterminate."));
      yield* this.#diagnostic("Claude process exit settlement was indeterminate");
      const forced = yield* Effect.exit(attempt(() => this.#options.process.forceTerminate()));
      if (Exit.isFailure(forced)) yield* this.#diagnostic("Claude force termination failed after indeterminate exit");
      for (const fact of this.#assembler.abandonTurn("the Claude runtime became indeterminate")) {
        const delivered = yield* Effect.exit(this.#emitFact(fact));
        if (Exit.isFailure(delivered)) yield* this.#diagnostic("HRA fact delivery failed during Claude disconnection");
      }
    });
  }

  #handleUnexpectedDisconnect(reason: "eof" | "process_exit" | "protocol_fault"): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      if (this.#state !== "open" || this.#disconnectEmitted) return;
      this.#state = "failed";
      this.#pending.clear();
      this.#failInitialization(new ClaudeError("PROCESS_EXITED", "The Claude runtime ended before admission completed."));
      for (const fact of this.#assembler.abandonTurn("the Claude runtime disconnected")) {
        const delivered = yield* Effect.exit(this.#emitFact(fact));
        if (Exit.isFailure(delivered)) yield* this.#diagnostic("HRA fact delivery failed during Claude disconnection");
      }
      if (reason !== "process_exit") {
        const forced = yield* Effect.exit(attempt(() => this.#options.process.forceTerminate()));
        if (Exit.isFailure(forced)) yield* this.#diagnostic("Claude force termination failed after stream loss");
        if (!(yield* observeWithin(this.#exit, this.#shutdownSettlementMs, true))) {
          yield* this.#diagnostic("Claude process exit did not settle after stream loss");
          return;
        }
      }
      if (this.#pendingTurnStart !== null) {
        const drained = yield* Effect.exit(this.#drainPendingTurnStart(this.#pendingTurnStart, false));
        if (Exit.isFailure(drained)) yield* this.#diagnostic("HRA fact delivery failed during Claude disconnection");
      }
      this.#disconnectEmitted = true;
      yield* this.#deliverFact({ type: "providerDisconnected", reason });
    });
  }

  #dispatch(value: unknown): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      const event = yield* attempt(() => parseClaudeStreamLine(value));
      for (const fact of yield* attempt(() => this.#assembler.apply(event))) {
        if (fact.type === "interactionRequested") this.#pending.set(fact.requestId, {
          request: fact.request, requestDigest: claudeRequestDigest(fact.requestId, fact.request), requestId: fact.requestId,
        });
        if (fact.type === "interactionCanceled") this.#pending.delete(fact.requestId);
        yield* this.#emitFact(fact);
        if (fact.type === "sessionBootstrapped") yield* attempt(() => this.#settleInitialization({
          claudeVersion: fact.claudeVersion, model: fact.model,
          permissionMode: fact.permissionMode, providerSessionId: fact.providerSessionId,
        }));
      }
    });
  }

  #settleInitialization(value: ClaudeStreamInitialization): void {
    if (this.#initializationValue !== undefined) {
      if (value.providerSessionId !== this.#initializationValue.providerSessionId
        || value.claudeVersion !== this.#initializationValue.claudeVersion
        || value.model !== this.#initializationValue.model
        || value.permissionMode !== this.#initializationValue.permissionMode) {
        throw new ClaudeError("PROTOCOL_ERROR", "Claude published conflicting initialization identities on one stream.");
      }
      return;
    }
    if (this.#initializationSettled) return;
    this.#initializationSettled = true;
    this.#initializationValue = value;
    this.#initialization.succeed(value);
  }

  #failInitialization(reason: unknown): void {
    if (this.#initializationSettled) return;
    this.#initializationSettled = true;
    this.#initialization.reject(reason);
  }

  #drainStderr(): ClaudeProgram<void> {
    return Effect.gen(this, function* () {
      let observed = 0;
      let truncated = false;
      yield* Effect.exit(consumeNative(this.#options.process.stderr, chunk => attempt(() => {
        const retained = Math.min(chunk.byteLength, 4096 - observed);
        observed += retained;
        if (retained < chunk.byteLength) truncated = true;
      })));
      if (observed > 0) yield* this.#diagnostic(`claude stderr bytes: ${String(observed)}${truncated ? "+" : ""}`);
    });
  }
}
