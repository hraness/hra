import { isAbsolute } from "node:path";

import type {
  CodexFact,
  CodexStreamPosition,
  PinnedCodexResponseAtPosition,
  PinnedCodexThread,
  PinnedCodexThreadList,
  PinnedCodexThreadListInput,
  PinnedCodexThreadReadInput,
  PinnedCodexThreadResponse,
} from "../codex";
import {
  createCodexFactsAtPosition,
  projectCodexThreadResponseFacts,
  projectCodexThreadSnapshot,
} from "../codex";
import {
  CODEX_0_144_6_THREAD_READ_COVERAGE,
  SESSION_HYDRATION_POLICY,
  SessionHydrationBuffer,
  SessionHydrationBufferPool,
  decideHydrationRead,
  hydrationRetryDelay,
  type HydrationReadDecision,
} from "./hydration";
import {
  windowSessionThreadDisplay,
  type SessionHydrationTargetPlan,
} from "./hydration-targets";

export interface SessionHydrationThreadListRequest {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly input: PinnedCodexThreadListInput;
}

export interface SessionHydrationThreadReadRequest {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly input: PinnedCodexThreadReadInput;
}

/**
 * A generation-fenced, read-only subset of the account runtime. The adapter
 * must route both operations to the exact requested generation.
 */
export interface SessionHydrationRequestPort {
  threadList(
    request: SessionHydrationThreadListRequest,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexThreadList>>;
  threadRead(
    request: SessionHydrationThreadReadRequest,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexThreadResponse>>;
}

export interface SessionHydrationCoordinatorOptions {
  readonly getTargetPlan: (input: Readonly<{
    accountProfileId: string;
    generation: number;
  }>) => SessionHydrationTargetPlan | Promise<SessionHydrationTargetPlan>;
  /** Installs one immutable, globally ordered account-generation batch. */
  readonly install: (input: Readonly<{
    accountProfileId: string;
    facts: readonly CodexFact[];
    generation: number;
  }>) => void;
  readonly now?: () => number;
  readonly pool?: SessionHydrationBufferPool;
  readonly requests: SessionHydrationRequestPort;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type SessionHydrationRunResult =
  | Readonly<{
      attempts: number;
      facts: number;
      kind: "installed";
      recoveringThreadIds: readonly string[];
    }>
  | Readonly<{
      attempts: number;
      kind: "failed";
      reason: "deadline" | "install" | "protocol" | "read" | "buffer";
      /**
       * These threads remain behind `admitAfterHydration`. When this list is
       * empty, the caller must expose account-level recovery from this result;
       * the coordinator will not invent a provider stream position.
       */
      recoveringThreadIds: readonly string[];
    }>
  | Readonly<{ kind: "stale_generation" }>;

export class SessionHydrationCoordinatorInvariantError extends Error {
  constructor() {
    super("Session hydration crossed a target, response, or generation boundary.");
    this.name = "SessionHydrationCoordinatorInvariantError";
  }
}

interface HydrationAttempt {
  readonly buffer: SessionHydrationBuffer;
  readonly facts: CodexFact[];
  readonly startedAt: number;
  invalidated: boolean;
}

interface HydrationGeneration {
  readonly accountProfileId: string;
  readonly authoritativeThreadIds: Set<string>;
  readonly generation: number;
  readonly serial: number;
  attempt: HydrationAttempt | null;
  phase: "buffering" | "complete" | "failed" | "running";
  readonly recoveredThreadIds: Set<string>;
  recoveringThreadIds: Set<string>;
  run: Promise<SessionHydrationRunResult> | null;
}

interface PositionedMetadata {
  readonly archived: boolean;
  readonly position: CodexStreamPosition;
  readonly threads: readonly PinnedCodexThread[];
  readonly unresolvedThreadIds: readonly string[];
}

interface PositionedHistory {
  readonly position: CodexStreamPosition;
  readonly snapshot: ReturnType<typeof projectCodexThreadSnapshot>;
  readonly semanticBytes: number;
  readonly threadId: string;
}

interface HydrationAssembly {
  readonly facts: readonly CodexFact[];
  readonly recoveringThreadIds: readonly string[];
}

class HydrationAttemptRetryError extends Error {
  readonly reason: Extract<SessionHydrationRunResult, { kind: "failed" }>["reason"];

  constructor(reason: HydrationAttemptRetryError["reason"]) {
    super("The bounded hydration attempt must be retried.");
    this.name = "HydrationAttemptRetryError";
    this.reason = reason;
  }
}

class HydrationStaleGenerationError extends Error {}

class HydrationInstallError extends Error {}

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

/**
 * Owns restart hydration for account generations without owning process
 * supervision. All provider values have already crossed the pinned parser.
 */
export class SessionHydrationCoordinator {
  readonly #generations = new Map<string, HydrationGeneration>();
  readonly #getTargetPlan: SessionHydrationCoordinatorOptions["getTargetPlan"];
  readonly #install: SessionHydrationCoordinatorOptions["install"];
  readonly #now: () => number;
  readonly #pool: SessionHydrationBufferPool;
  readonly #requests: SessionHydrationRequestPort;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #generationSerial = 0;
  #stopped = false;

  constructor(options: SessionHydrationCoordinatorOptions) {
    this.#getTargetPlan = options.getTargetPlan;
    this.#install = options.install;
    this.#now = options.now ?? Date.now;
    this.#pool = options.pool ?? new SessionHydrationBufferPool();
    this.#requests = options.requests;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Opens the buffer before the generation can publish its first live fact. */
  startGeneration(input: Readonly<{
    accountProfileId: string;
    generation: number;
    startedAt?: number;
  }>): void {
    assertGenerationIdentity(input.accountProfileId, input.generation);
    if (this.#stopped) throw new SessionHydrationCoordinatorInvariantError();
    const current = this.#generations.get(input.accountProfileId);
    if (current?.generation === input.generation) return;
    if (current !== undefined) this.#end(current);
    const startedAt = input.startedAt ?? this.#now();
    assertNow(startedAt);
    const entry: HydrationGeneration = {
      accountProfileId: input.accountProfileId,
      authoritativeThreadIds: new Set(),
      generation: input.generation,
      serial: ++this.#generationSerial,
      attempt: null,
      phase: "buffering",
      recoveredThreadIds: new Set(),
      recoveringThreadIds: new Set(),
      run: null,
    };
    entry.attempt = this.#createAttempt(entry, startedAt);
    this.#generations.set(input.accountProfileId, entry);
  }

  /**
   * Returns true only when the live fact is retained by the current bounded
   * generation buffer. Stale generations never displace the current owner.
   */
  acceptLiveFact(fact: CodexFact): boolean {
    const entry = this.#generations.get(fact.accountProfileId);
    if (
      entry === undefined ||
      entry.generation !== fact.generation ||
      (entry.phase !== "buffering" && entry.phase !== "running") ||
      entry.attempt === null ||
      fact.origin !== "live"
    ) {
      return false;
    }
    const now = this.#now();
    assertNow(now);
    const result = entry.attempt.buffer.append(fact, now);
    if (result.kind === "accepted") {
      entry.attempt.facts.push(fact);
      return true;
    }
    if (result.kind === "generation_mismatch") return false;

    const failed = entry.attempt;
    failed.invalidated = true;
    failed.buffer.close();
    const replacement = this.#createAttempt(entry, now);
    entry.attempt = replacement;
    const replacementResult = replacement.buffer.append(fact, now);
    if (replacementResult.kind !== "accepted") {
      replacement.invalidated = true;
      replacement.buffer.close();
      entry.attempt = null;
      return false;
    }
    replacement.facts.push(fact);
    return true;
  }

  /**
   * Gates live facts that were not buffered. Call this only after
   * `acceptLiveFact` returns false. During an attempt it prevents a rejected
   * fact from advancing beyond the pending snapshot. After installation or
   * exhausted retries it suppresses partial history for recovering threads.
   */
  admitAfterHydration(fact: CodexFact): boolean {
    if (fact.origin !== "live") return false;
    const entry = this.#generations.get(fact.accountProfileId);
    if (entry === undefined) return true;
    if (entry.generation !== fact.generation) return false;
    if (entry.phase === "buffering" || entry.phase === "running") return false;

    const threadId = threadIdForFact(fact);
    if (threadId === null) return true;
    if (!entry.recoveringThreadIds.has(threadId)) {
      if (clearsRecoveringThread(fact)) {
        entry.authoritativeThreadIds.add(threadId);
        return true;
      }
      // A failed attempt cannot safely infer that untargeted history is
      // current. Structural facts remain admissible, but history waits for a
      // later authoritative generation recovery.
      return entry.phase !== "failed" ||
        entry.authoritativeThreadIds.has(threadId) ||
        isSafeRecoveryFact(fact);
    }
    if (clearsRecoveringThread(fact)) {
      entry.recoveringThreadIds.delete(threadId);
      entry.authoritativeThreadIds.add(threadId);
      if (fact.type !== "thread.deleted") entry.recoveredThreadIds.add(threadId);
      return true;
    }
    return isSafeRecoveryFact(fact);
  }

  /** Starts the bounded read attempt once the account runtime is running. */
  onRunning(
    accountProfileId: string,
    generation: number,
  ): Promise<SessionHydrationRunResult> {
    const entry = this.#generations.get(accountProfileId);
    if (
      this.#stopped ||
      entry === undefined ||
      entry.generation !== generation ||
      entry.phase === "failed"
    ) {
      return Promise.resolve({ kind: "stale_generation" });
    }
    if (entry.run !== null) return entry.run;
    entry.phase = "running";
    entry.run = this.#run(entry);
    return entry.run;
  }

  recoveringThreadIds(
    accountProfileId: string,
    generation: number,
  ): readonly string[] {
    const entry = this.#generations.get(accountProfileId);
    if (entry?.generation !== generation) return Object.freeze([]);
    return sortedIds(entry.recoveringThreadIds);
  }

  /** Drains threads that crossed an authoritative recovery boundary. */
  takeRecoveredThreadIds(
    accountProfileId: string,
    generation: number,
  ): readonly string[] {
    const entry = this.#generations.get(accountProfileId);
    if (entry?.generation !== generation) return Object.freeze([]);
    const recovered = sortedIds(entry.recoveredThreadIds);
    entry.recoveredThreadIds.clear();
    return recovered;
  }

  /** Ends only the exact generation; repeated and stale calls are harmless. */
  endGeneration(accountProfileId: string, generation: number): void {
    const entry = this.#generations.get(accountProfileId);
    if (entry?.generation !== generation) return;
    this.#end(entry);
  }

  /** Releases any generation retained for an authorized account removal. */
  purgeAccount(accountProfileId: string): void {
    const entry = this.#generations.get(accountProfileId);
    if (entry !== undefined) this.#end(entry);
  }

  /** Stops every owned buffer. It never stops or restarts an account process. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const entry of this.#generations.values()) this.#closeAttempt(entry);
    this.#generations.clear();
  }

  async #run(entry: HydrationGeneration): Promise<SessionHydrationRunResult> {
    let attemptNumber = 0;
    let lastReason: Extract<SessionHydrationRunResult, { kind: "failed" }>["reason"] =
      "read";
    while (true) {
      if (!this.#isCurrent(entry)) return { kind: "stale_generation" };
      if (entry.attempt === null) {
        entry.attempt = this.#createAttempt(entry, this.#now());
      }
      const attempt = entry.attempt;
      try {
        return await this.#executeAttempt(entry, attempt, attemptNumber);
      } catch (error) {
        if (error instanceof HydrationStaleGenerationError || !this.#isCurrent(entry)) {
          return { kind: "stale_generation" };
        }
        if (error instanceof SessionHydrationCoordinatorInvariantError) {
          return this.#fail(entry, attemptNumber + 1, "protocol");
        }
        if (error instanceof HydrationInstallError) {
          return this.#fail(entry, attemptNumber + 1, "install");
        }
        lastReason = error instanceof HydrationAttemptRetryError
          ? error.reason
          : "read";
        const delay = hydrationRetryDelay(attemptNumber);
        if (delay === null) return this.#fail(entry, attemptNumber + 1, lastReason);
        if (entry.attempt === attempt) this.#replaceAttempt(entry);
        await this.#sleep(delay);
        if (!this.#isCurrent(entry)) return { kind: "stale_generation" };
        attemptNumber += 1;
      }
    }
  }

  async #executeAttempt(
    entry: HydrationGeneration,
    attempt: HydrationAttempt,
    attemptNumber: number,
  ): Promise<SessionHydrationRunResult> {
    this.#assertAttempt(entry, attempt);
    const plan = boundedTargetPlan(await this.#getTargetPlan({
      accountProfileId: entry.accountProfileId,
      generation: entry.generation,
    }));
    this.#assertAttempt(entry, attempt);
    entry.recoveringThreadIds = new Set(plan.historyThreadIds);

    const metadata = await this.#readMetadata(entry, attempt, plan);
    const history = await this.#readHistory(entry, attempt, plan, metadata);
    this.#assertAttempt(entry, attempt);

    // Seal and install synchronously. Live facts arriving after this statement
    // bypass the coordinator and therefore follow the installed batch.
    attempt.buffer.close();
    entry.attempt = null;
    const assembly = assembleHydrationFacts({
      accountProfileId: entry.accountProfileId,
      attempt: attemptNumber,
      bufferedFacts: Object.freeze([...attempt.facts]),
      generation: entry.generation,
      history,
      metadata,
      plan,
    });
    entry.recoveringThreadIds = new Set(assembly.recoveringThreadIds);
    try {
      this.#install({
        accountProfileId: entry.accountProfileId,
        facts: assembly.facts,
        generation: entry.generation,
      });
    } catch {
      entry.phase = "failed";
      throw new HydrationInstallError();
    }
    entry.phase = "complete";
    return {
      attempts: attemptNumber + 1,
      facts: assembly.facts.length,
      kind: "installed",
      recoveringThreadIds: assembly.recoveringThreadIds,
    };
  }

  async #readMetadata(
    entry: HydrationGeneration,
    attempt: HydrationAttempt,
    plan: SessionHydrationTargetPlan,
  ): Promise<readonly PositionedMetadata[]> {
    if (plan.metadataThreadIds.length === 0) return Object.freeze([]);
    const wanted = new Set(plan.metadataThreadIds);
    const seen = new Set<string>();
    const output: PositionedMetadata[] = [];
    const readPages = async (
      cwdBatch: readonly string[],
      archived: boolean,
    ): Promise<void> => {
      const exactCwds = new Set(cwdBatch);
      let cursor: string | null = null;
      const cursors = new Set<string>();
      for (
        let page = 0;
        page < SESSION_HYDRATION_POLICY.maxMetadataPagesPerQuery;
        page += 1
      ) {
        this.#assertAttempt(entry, attempt);
        let response: PinnedCodexResponseAtPosition<PinnedCodexThreadList>;
        try {
          response = await this.#requests.threadList({
            accountProfileId: entry.accountProfileId,
            generation: entry.generation,
            input: {
              archived,
              cursor,
              cwd: [...cwdBatch],
              limit: SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount,
              sortDirection: "desc",
              sortKey: "updated_at",
              sourceKinds: ["appServer"],
            },
          });
        } catch {
          throw new HydrationAttemptRetryError("read");
        }
        this.#assertAttempt(entry, attempt);
        assertPositionedResponse(entry, response);
        if (
          response.output.data.length > SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount ||
          response.output.data.some((thread) => !exactCwds.has(thread.cwd))
        ) {
          throw new SessionHydrationCoordinatorInvariantError();
        }
        const pageIds = new Set<string>();
        const retained: PinnedCodexThread[] = [];
        for (const thread of response.output.data) {
          if (pageIds.has(thread.id)) throw new SessionHydrationCoordinatorInvariantError();
          pageIds.add(thread.id);
          if (!wanted.has(thread.id)) continue;
          seen.add(thread.id);
          retained.push(thread);
        }
        output.push({
          archived,
          position: response.streamPosition,
          threads: Object.freeze(retained),
          unresolvedThreadIds: Object.freeze([]),
        });
        cursor = response.output.nextCursor;
        if (cursor === null) return;
        if (cursors.has(cursor)) return;
        cursors.add(cursor);
      }
    };
    for (const cwdBatch of plan.cwdFilterBatches) {
      await readPages(cwdBatch, false);
    }
    if (seen.size < wanted.size) {
      for (const cwdBatch of plan.cwdFilterBatches) {
        await readPages(cwdBatch, true);
      }
    }
    const missing = [...wanted].filter((threadId) => !seen.has(threadId)).toSorted();
    if (missing.length > 0) {
      const last = output.at(-1);
      if (last === undefined) throw new SessionHydrationCoordinatorInvariantError();
      output[output.length - 1] = {
        ...last,
        unresolvedThreadIds: Object.freeze(missing),
      };
    }
    return Object.freeze(output);
  }

  async #readHistory(
    entry: HydrationGeneration,
    attempt: HydrationAttempt,
    plan: SessionHydrationTargetPlan,
    metadata: readonly PositionedMetadata[],
  ): Promise<readonly PositionedHistory[]> {
    if (plan.historyThreadIds.length === 0) return Object.freeze([]);
    const exactCwds = new Set(plan.cwdFilterBatches.flat());
    const metadataById = new Map<string, Readonly<{ archived: boolean; cwd: string }>>();
    for (const group of metadata) {
      for (const threadId of group.unresolvedThreadIds) metadataById.delete(threadId);
      for (const thread of group.threads) {
        metadataById.set(thread.id, { archived: group.archived, cwd: thread.cwd });
      }
    }
    const readableThreadIds = plan.historyThreadIds.filter((threadId) =>
      metadataById.get(threadId)?.archived === false
    );
    if (readableThreadIds.length === 0) return Object.freeze([]);
    const results: Array<PositionedHistory | undefined> = Array.from({
      length: readableThreadIds.length,
    });
    let nextIndex = 0;
    let firstError: unknown;
    const worker = async (): Promise<void> => {
      while (firstError === undefined) {
        const index = nextIndex;
        nextIndex += 1;
        const threadId = readableThreadIds[index];
        if (threadId === undefined) return;
        try {
          this.#assertAttempt(entry, attempt);
          const response = await this.#requests.threadRead({
            accountProfileId: entry.accountProfileId,
            generation: entry.generation,
            input: { includeTurns: true, threadId },
          });
          this.#assertAttempt(entry, attempt);
          assertPositionedResponse(entry, response);
          const raw = response.output.thread;
          const expectedCwd = metadataById.get(threadId)?.cwd;
          if (
            raw.id !== threadId ||
            !exactCwds.has(raw.cwd) ||
            (expectedCwd !== undefined && raw.cwd !== expectedCwd)
          ) {
            throw new SessionHydrationCoordinatorInvariantError();
          }
          const snapshot = projectCodexThreadSnapshot(raw, {
            archived: false,
            turns: "present",
          });
          results[index] = {
            position: response.streamPosition,
            semanticBytes: encodedBytes(snapshot),
            snapshot,
            threadId,
          };
        } catch (error) {
          firstError ??= error;
        }
      }
    };
    const concurrency = Math.min(
      SESSION_HYDRATION_POLICY.maxConcurrentHistoryReads,
      readableThreadIds.length,
    );
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (firstError !== undefined) {
      if (
        firstError instanceof SessionHydrationCoordinatorInvariantError ||
        firstError instanceof HydrationStaleGenerationError ||
        firstError instanceof HydrationAttemptRetryError
      ) {
        throw firstError;
      }
      throw new HydrationAttemptRetryError("read");
    }
    if (results.some((result) => result === undefined)) {
      throw new SessionHydrationCoordinatorInvariantError();
    }
    return Object.freeze(results as PositionedHistory[]);
  }

  #assertAttempt(entry: HydrationGeneration, attempt: HydrationAttempt): void {
    if (!this.#isCurrent(entry)) throw new HydrationStaleGenerationError();
    if (entry.attempt !== attempt || attempt.invalidated) {
      throw new HydrationAttemptRetryError("buffer");
    }
    const now = this.#now();
    assertNow(now);
    if (now >= attempt.startedAt + SESSION_HYDRATION_POLICY.attemptDeadlineMs) {
      attempt.invalidated = true;
      attempt.buffer.close();
      throw new HydrationAttemptRetryError("deadline");
    }
  }

  #createAttempt(entry: HydrationGeneration, startedAt: number): HydrationAttempt {
    assertNow(startedAt);
    return {
      buffer: new SessionHydrationBuffer({
        accountProfileId: entry.accountProfileId,
        generation: entry.generation,
        pool: this.#pool,
        startedAt,
      }),
      facts: [],
      invalidated: false,
      startedAt,
    };
  }

  #replaceAttempt(entry: HydrationGeneration): void {
    this.#closeAttempt(entry);
    entry.attempt = this.#createAttempt(entry, this.#now());
  }

  #closeAttempt(entry: HydrationGeneration): void {
    entry.attempt?.buffer.close();
    entry.attempt = null;
  }

  #fail(
    entry: HydrationGeneration,
    attempts: number,
    reason: Extract<SessionHydrationRunResult, { kind: "failed" }>["reason"],
  ): Extract<SessionHydrationRunResult, { kind: "failed" }> {
    this.#closeAttempt(entry);
    entry.phase = "failed";
    return {
      attempts,
      kind: "failed",
      reason,
      recoveringThreadIds: sortedIds(entry.recoveringThreadIds),
    };
  }

  #isCurrent(entry: HydrationGeneration): boolean {
    return !this.#stopped &&
      this.#generations.get(entry.accountProfileId) === entry &&
      this.#generations.get(entry.accountProfileId)?.serial === entry.serial;
  }

  #end(entry: HydrationGeneration): void {
    this.#closeAttempt(entry);
    if (this.#generations.get(entry.accountProfileId) === entry) {
      this.#generations.delete(entry.accountProfileId);
    }
  }
}

function assembleHydrationFacts(input: Readonly<{
  accountProfileId: string;
  attempt: number;
  bufferedFacts: readonly CodexFact[];
  generation: number;
  history: readonly PositionedHistory[];
  metadata: readonly PositionedMetadata[];
  plan: SessionHydrationTargetPlan;
}>): HydrationAssembly {
  const facts: CodexFact[] = [];
  const metadataCutoffByThread = new Map<string, CodexStreamPosition>();
  const recovering = new Set<string>();
  const bufferedDeletedThreadIds = new Set<string>();
  for (const fact of input.bufferedFacts) {
    if (fact.type === "thread.deleted") bufferedDeletedThreadIds.add(fact.threadId);
  }
  for (const group of input.metadata) {
    const context = {
      accountProfileId: input.accountProfileId,
      generation: input.generation,
      origin: "snapshot",
      streamPosition: group.position,
    } as const;
    const snapshots = projectCodexThreadResponseFacts(
      context,
      group.threads.map((thread) => ({
        archived: group.archived,
        thread,
        turns: "metadata_only" as const,
      })),
    );
    facts.push(...snapshots);
    for (const thread of group.threads) metadataCutoffByThread.set(thread.id, group.position);
    const unresolvedThreadIds = group.unresolvedThreadIds.filter((threadId) =>
      !bufferedDeletedThreadIds.has(threadId)
    );
    const unresolved = createCodexFactsAtPosition(
      context,
      unresolvedThreadIds.map((threadId) => ({
        type: "hydration.changed" as const,
        attempt: input.attempt,
        status: "recovering" as const,
        threadId,
      })),
      snapshots.length,
    );
    facts.push(...unresolved);
    for (const threadId of unresolvedThreadIds) {
      recovering.add(threadId);
      metadataCutoffByThread.set(threadId, group.position);
    }
  }

  const historyThreadIds = new Set(input.history.map(({ threadId }) => threadId));
  let displayBytes = 0;
  for (const history of input.history) {
    const window = windowSessionThreadDisplay(history.snapshot);
    const active = history.snapshot.status === "active" ||
      history.snapshot.turns?.some((turn) => turn.status === "active") === true;
    const exceedsTotal = !active &&
      displayBytes + window.bytes > SESSION_HYDRATION_POLICY.maxDisplayBytesTotal;
    if (!active && !exceedsTotal &&
      history.semanticBytes <= SESSION_HYDRATION_POLICY.maxSemanticHistoryBytes) {
      displayBytes += window.bytes;
    }
    const relevantSuffix = input.bufferedFacts.filter((fact) =>
      threadIdForFact(fact) === history.threadId &&
      fact.streamPosition > history.position
    );
    const decision = decideHydrationRead({
      accountProfileId: input.accountProfileId,
      coverage: CODEX_0_144_6_THREAD_READ_COVERAGE,
      generation: input.generation,
      responsePosition: history.position,
      snapshot: window.snapshot,
      snapshotBytes: exceedsTotal ||
          history.semanticBytes > SESSION_HYDRATION_POLICY.maxSemanticHistoryBytes
        ? SESSION_HYDRATION_POLICY.maxSemanticHistoryBytes + 1
        : encodedBytes(window.snapshot),
      suffix: relevantSuffix,
    });
    facts.push(...withHydrationAttempt(decision, input.attempt));
    if (decision.state === "recovering") recovering.add(history.threadId);
    if (decision.state !== "ready") {
      facts.push(...relevantSuffix.filter(isSafeRecoveryFact));
    }
  }

  for (const fact of input.bufferedFacts) {
    const threadId = threadIdForFact(fact);
    if (threadId === null) {
      facts.push(fact);
      continue;
    }
    if (historyThreadIds.has(threadId)) continue;
    const cutoff = metadataCutoffByThread.get(threadId);
    if (
      fact.type === "thread.deleted" ||
      (isSafeRecoveryFact(fact) &&
        (cutoff === undefined || fact.streamPosition > cutoff))
    ) {
      facts.push(fact);
    }
  }

  facts.sort(compareFacts);
  assertOrderedFactBatch(input.accountProfileId, input.generation, facts);
  return {
    facts: Object.freeze(facts),
    recoveringThreadIds: sortedIds(recovering),
  };
}

function withHydrationAttempt(
  decision: HydrationReadDecision,
  attempt: number,
): readonly CodexFact[] {
  return Object.freeze(decision.facts.map((fact) => {
    if (fact.type !== "hydration.changed" || fact.attempt === attempt) return fact;
    const changed = { ...fact, attempt };
    return Object.freeze({
      ...changed,
      encodedBytes: encodedBytes({
        accountProfileId: changed.accountProfileId,
        attempt: changed.attempt,
        factIndex: changed.factIndex,
        generation: changed.generation,
        origin: changed.origin,
        status: changed.status,
        streamPosition: changed.streamPosition,
        threadId: changed.threadId,
        type: changed.type,
      }),
    });
  }));
}

function boundedTargetPlan(plan: SessionHydrationTargetPlan): SessionHydrationTargetPlan {
  const metadata = checkedUniqueIds(
    plan.metadataThreadIds,
    SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount,
  );
  const history = checkedUniqueIds(
    plan.historyThreadIds,
    SESSION_HYDRATION_POLICY.maxHistoryThreadsPerAccount,
  );
  const metadataSet = new Set(metadata);
  if (history.some((threadId) => !metadataSet.has(threadId))) {
    throw new SessionHydrationCoordinatorInvariantError();
  }
  if (
    plan.cwdFilterBatches.length >
      Math.ceil(
        SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount /
          SESSION_HYDRATION_POLICY.maxCwdFiltersPerRequest,
      ) ||
    (metadata.length > 0 && plan.cwdFilterBatches.length === 0)
  ) {
    throw new SessionHydrationCoordinatorInvariantError();
  }
  const seenCwds = new Set<string>();
  const batches = plan.cwdFilterBatches.map((batch) => {
    if (
      batch.length === 0 ||
      batch.length > SESSION_HYDRATION_POLICY.maxCwdFiltersPerRequest
    ) {
      throw new SessionHydrationCoordinatorInvariantError();
    }
    const checked = batch.map((cwd) => {
      if (!isAbsolute(cwd) || seenCwds.has(cwd)) {
        throw new SessionHydrationCoordinatorInvariantError();
      }
      seenCwds.add(cwd);
      return cwd;
    });
    return Object.freeze(checked);
  });
  if (seenCwds.size > SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount) {
    throw new SessionHydrationCoordinatorInvariantError();
  }
  return Object.freeze({
    cwdFilterBatches: Object.freeze(batches),
    historyThreadIds: history,
    metadataThreadIds: metadata,
  });
}

function checkedUniqueIds(values: readonly string[], limit: number): readonly string[] {
  if (values.length > limit) throw new SessionHydrationCoordinatorInvariantError();
  const seen = new Set<string>();
  const checked = values.map((value) => {
    if (value.length === 0 || value.length > 1_024 || seen.has(value)) {
      throw new SessionHydrationCoordinatorInvariantError();
    }
    seen.add(value);
    return value;
  });
  return Object.freeze(checked);
}

function assertPositionedResponse(
  entry: Pick<HydrationGeneration, "generation">,
  response: Pick<PinnedCodexResponseAtPosition<unknown>, "generation" | "streamPosition">,
): void {
  if (
    response.generation !== entry.generation ||
    !Number.isSafeInteger(response.streamPosition) ||
    response.streamPosition <= 0
  ) {
    throw new SessionHydrationCoordinatorInvariantError();
  }
}

function threadIdForFact(fact: CodexFact): string | null {
  switch (fact.type) {
    case "thread.snapshot":
      return fact.thread.id;
    case "thread.archived":
    case "thread.deleted":
    case "thread.title_changed":
    case "thread.status_changed":
    case "turn.snapshot":
    case "turn.started":
    case "turn.activity":
    case "turn.completed":
    case "turn.token_usage":
    case "turn.model_rerouted":
    case "item.started":
    case "item.delta":
    case "item.completed":
    case "interaction.requested":
    case "server_request.resolved":
      return fact.threadId;
    case "operation.changed":
    case "hydration.changed":
      return fact.threadId;
    case "runtime.changed":
    case "account.changed":
    case "account.login_completed":
    case "account.profile_updated":
    case "account.rate_limits_updated":
    case "interaction.settled":
      return null;
  }
}

function isSafeRecoveryFact(fact: CodexFact): boolean {
  switch (fact.type) {
    case "thread.archived":
    case "thread.deleted":
    case "thread.title_changed":
    case "thread.status_changed":
    case "interaction.requested":
    case "interaction.settled":
    case "server_request.resolved":
    case "operation.changed":
    case "runtime.changed":
    case "account.changed":
    case "account.login_completed":
    case "account.profile_updated":
    case "account.rate_limits_updated":
    case "turn.model_rerouted":
      return true;
    case "thread.snapshot":
    case "turn.snapshot":
    case "turn.started":
    case "turn.activity":
    case "turn.completed":
    case "turn.token_usage":
    case "item.started":
    case "item.delta":
    case "item.completed":
    case "hydration.changed":
      return false;
  }
}

function clearsRecoveringThread(fact: CodexFact): boolean {
  switch (fact.type) {
    case "thread.deleted":
      return true;
    case "thread.archived":
    case "thread.status_changed":
    case "turn.completed":
    case "turn.token_usage":
    case "turn.model_rerouted":
      return false;
    case "thread.snapshot":
      return fact.thread.status !== "active" &&
        fact.thread.turns !== null &&
        fact.thread.turns.every((turn) =>
          turn.status !== "active" && turn.items !== null
        );
    case "turn.snapshot":
      return fact.turn.status !== "active" && fact.turn.items !== null;
    case "runtime.changed":
    case "account.changed":
    case "account.login_completed":
    case "account.profile_updated":
    case "account.rate_limits_updated":
    case "thread.title_changed":
    case "turn.started":
    case "turn.activity":
    case "item.started":
    case "item.delta":
    case "item.completed":
    case "interaction.requested":
    case "interaction.settled":
    case "server_request.resolved":
    case "operation.changed":
    case "hydration.changed":
      return false;
  }
}

function compareFacts(left: CodexFact, right: CodexFact): number {
  return left.streamPosition - right.streamPosition || left.factIndex - right.factIndex;
}

function assertOrderedFactBatch(
  accountProfileId: string,
  generation: number,
  facts: readonly CodexFact[],
): void {
  let previous: CodexFact | undefined;
  for (const fact of facts) {
    if (
      fact.accountProfileId !== accountProfileId ||
      fact.generation !== generation ||
      (previous !== undefined && compareFacts(previous, fact) >= 0)
    ) {
      throw new SessionHydrationCoordinatorInvariantError();
    }
    previous = fact;
  }
}

function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SessionHydrationCoordinatorInvariantError();
  return new TextEncoder().encode(encoded).byteLength;
}

function assertGenerationIdentity(accountProfileId: string, generation: number): void {
  if (
    accountProfileId.length === 0 ||
    accountProfileId.length > 1_024 ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    throw new SessionHydrationCoordinatorInvariantError();
  }
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new SessionHydrationCoordinatorInvariantError();
  }
}

function sortedIds(values: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...values].toSorted());
}
