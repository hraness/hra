import type {
  CodexFact,
  CodexThreadSnapshot,
  CodexStreamPosition,
} from "../codex";
import { SESSION_RETENTION_POLICY } from "./retention-policy";

export const SESSION_HYDRATION_POLICY = Object.freeze({
  maxMetadataThreadsPerAccount: SESSION_RETENTION_POLICY.maxMetadataThreadsPerAccount,
  maxMetadataPagesPerQuery: 8,
  maxCwdFiltersPerRequest: 64,
  maxHistoryThreadsPerAccount: SESSION_RETENTION_POLICY.maxHistoryThreadsPerAccount,
  maxConcurrentHistoryReads: 4,
  maxFactsPerAccount: 2_048,
  maxFactBytesPerAccount: 2 * 1_024 * 1_024,
  maxFactsGlobal: 8_192,
  maxFactBytesGlobal: 8 * 1_024 * 1_024,
  attemptDeadlineMs: 15_000,
  maxSemanticHistoryBytes: 6 * 1_024 * 1_024,
  maxDisplayItemsPerThread: SESSION_RETENTION_POLICY.maxDisplayItemsPerThread,
  maxDisplayBytesPerThread: SESSION_RETENTION_POLICY.maxDisplayBytesPerThread,
  maxDisplayBytesTotal: SESSION_RETENTION_POLICY.maxDisplayBytesTotal,
  retryBackoffMs: Object.freeze([250, 500, 1_000, 2_000, 5_000]),
});

/**
 * The 0.144.6 protocol exposes response ordering but no documented snapshot
 * coverage watermark. Active read snapshots therefore remain conservative.
 */
export const CODEX_0_144_6_THREAD_READ_COVERAGE = "unproven" as const;

export type ThreadReadCoverage = "proven" | "unproven";

export type HydrationAppendResult =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "deadline_exceeded" }>
  | Readonly<{ kind: "generation_mismatch" }>
  | Readonly<{ kind: "overflow"; limit: "bytes" | "count" }>;

export interface HydrationBufferUsage {
  readonly bytes: number;
  readonly facts: number;
}

export class SessionHydrationInvariantError extends Error {
  constructor() {
    super("Hydration input crossed an account, generation, or budget boundary.");
    this.name = "SessionHydrationInvariantError";
  }
}

interface HydrationBufferPoolEntry extends HydrationBufferUsage {
  readonly accountProfileId: string;
  readonly owner: object;
}

/** Coordinates the global hydration budget across account-scoped buffers. */
export class SessionHydrationBufferPool {
  readonly #entries = new Map<string, HydrationBufferPoolEntry>();

  reserve(
    accountProfileId: string,
    owner: object,
    next: HydrationBufferUsage,
  ): "accepted" | "bytes" | "count" | "occupied" {
    const current = this.#entries.get(accountProfileId);
    if (current !== undefined && current.owner !== owner) return "occupied";
    let totalBytes = next.bytes;
    let totalFacts = next.facts;
    for (const [key, usage] of this.#entries) {
      if (key === accountProfileId) continue;
      totalBytes += usage.bytes;
      totalFacts += usage.facts;
    }
    if (totalFacts > SESSION_HYDRATION_POLICY.maxFactsGlobal) return "count";
    if (totalBytes > SESSION_HYDRATION_POLICY.maxFactBytesGlobal) return "bytes";
    this.#entries.set(accountProfileId, { accountProfileId, owner, ...next });
    return "accepted";
  }

  release(accountProfileId: string, owner: object): void {
    if (this.#entries.get(accountProfileId)?.owner === owner) {
      this.#entries.delete(accountProfileId);
    }
  }

  usage(): HydrationBufferUsage {
    let bytes = 0;
    let facts = 0;
    for (const usage of this.#entries.values()) {
      bytes += usage.bytes;
      facts += usage.facts;
    }
    return { bytes, facts };
  }
}

/**
 * Buffers one account generation while non-mutating reads establish a safe
 * snapshot boundary. It never accepts a foreign account or generation.
 */
export class SessionHydrationBuffer {
  readonly #accountProfileId: string;
  readonly #deadlineAt: number;
  readonly #generation: number;
  readonly #pool: SessionHydrationBufferPool;
  readonly #poolOwner = Object.freeze({});
  readonly #facts: CodexFact[] = [];
  #bytes = 0;
  #closed = false;

  constructor(input: Readonly<{
    accountProfileId: string;
    generation: number;
    startedAt: number;
    pool: SessionHydrationBufferPool;
  }>) {
    this.#accountProfileId = input.accountProfileId;
    this.#generation = input.generation;
    this.#deadlineAt = input.startedAt + SESSION_HYDRATION_POLICY.attemptDeadlineMs;
    this.#pool = input.pool;
    if (
      this.#pool.reserve(
        this.#accountProfileId,
        this.#poolOwner,
        { bytes: 0, facts: 0 },
      ) !== "accepted"
    ) {
      throw new Error("An account can own only one hydration buffer");
    }
  }

  append(fact: CodexFact, now: number): HydrationAppendResult {
    if (this.#closed || now >= this.#deadlineAt) {
      this.close();
      return { kind: "deadline_exceeded" };
    }
    if (
      fact.accountProfileId !== this.#accountProfileId ||
      fact.generation !== this.#generation
    ) {
      return { kind: "generation_mismatch" };
    }
    const facts = this.#facts.length + 1;
    const bytes = this.#bytes + fact.encodedBytes;
    if (facts > SESSION_HYDRATION_POLICY.maxFactsPerAccount) {
      this.close();
      return { kind: "overflow", limit: "count" };
    }
    if (bytes > SESSION_HYDRATION_POLICY.maxFactBytesPerAccount) {
      this.close();
      return { kind: "overflow", limit: "bytes" };
    }
    const global = this.#pool.reserve(
      this.#accountProfileId,
      this.#poolOwner,
      { bytes, facts },
    );
    if (global !== "accepted") {
      this.close();
      return {
        kind: "overflow",
        limit: global === "count" ? "count" : "bytes",
      };
    }
    this.#facts.push(fact);
    this.#bytes = bytes;
    return { kind: "accepted" };
  }

  suffixAfter(responsePosition: CodexStreamPosition): readonly CodexFact[] {
    if (!Number.isSafeInteger(responsePosition) || responsePosition <= 0) {
      throw new SessionHydrationInvariantError();
    }
    return Object.freeze(this.#facts.filter(
      (fact) => fact.streamPosition > responsePosition,
    ));
  }

  usage(): HydrationBufferUsage {
    return { bytes: this.#bytes, facts: this.#facts.length };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pool.release(this.#accountProfileId, this.#poolOwner);
  }
}

export interface HydrationReadDecision {
  readonly facts: readonly CodexFact[];
  readonly state: "history_unavailable" | "ready" | "recovering";
}

/**
 * Chooses the only safe read installation for the observed coverage contract.
 * A complete quiescent snapshot is authoritative even when active coverage is
 * unproven; an active snapshot is not installed until coverage is proven.
 */
export function decideHydrationRead(input: Readonly<{
  accountProfileId: string;
  generation: number;
  responsePosition: CodexStreamPosition;
  snapshot: CodexThreadSnapshot;
  snapshotBytes: number;
  suffix: readonly CodexFact[];
  coverage: ThreadReadCoverage;
}>): HydrationReadDecision {
  assertHydrationReadInput(input);
  if (input.snapshotBytes > SESSION_HYDRATION_POLICY.maxSemanticHistoryBytes) {
    return {
      facts: Object.freeze([
        hydrationFact(input, "history_unavailable", 0),
      ]),
      state: "history_unavailable",
    };
  }
  const active = input.snapshot.status === "active" ||
    input.snapshot.turns?.some((turn) => turn.status === "active") === true;
  if (active && input.coverage === "unproven") {
    return {
      facts: Object.freeze([
        hydrationFact(input, "recovering", 0),
      ]),
      state: "recovering",
    };
  }
  const snapshotFact: CodexFact = {
    accountProfileId: input.accountProfileId,
    encodedBytes: input.snapshotBytes,
    factIndex: 0,
    generation: input.generation,
    origin: "snapshot",
    streamPosition: input.responsePosition,
    type: "thread.snapshot",
    thread: input.snapshot,
  };
  const suffix = input.suffix.filter(
    (fact) => fact.streamPosition > input.responsePosition,
  );
  return {
    facts: Object.freeze([
      snapshotFact,
      hydrationFact(input, "ready", 1),
      ...suffix,
    ]),
    state: "ready",
  };
}

function hydrationFact(
  input: Pick<Parameters<typeof decideHydrationRead>[0],
    "accountProfileId" | "generation" | "responsePosition" | "snapshot">,
  status: "history_unavailable" | "ready" | "recovering",
  factIndex: number,
): CodexFact {
  return {
    accountProfileId: input.accountProfileId,
    encodedBytes: 0,
    factIndex,
    generation: input.generation,
    origin: "reconciled",
    streamPosition: input.responsePosition,
    type: "hydration.changed",
    attempt: 0,
    status,
    threadId: input.snapshot.id,
  };
}

function assertHydrationReadInput(
  input: Parameters<typeof decideHydrationRead>[0],
): void {
  if (
    input.accountProfileId.length === 0 ||
    !Number.isSafeInteger(input.generation) || input.generation <= 0 ||
    !Number.isSafeInteger(input.responsePosition) || input.responsePosition <= 0 ||
    !Number.isSafeInteger(input.snapshotBytes) || input.snapshotBytes < 0 ||
    input.suffix.some((fact) =>
      fact.accountProfileId !== input.accountProfileId ||
      fact.generation !== input.generation ||
      fact.origin !== "live"
    )
  ) {
    throw new SessionHydrationInvariantError();
  }
}

export function hydrationRetryDelay(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("Hydration attempt must be a non-negative safe integer");
  }
  return SESSION_HYDRATION_POLICY.retryBackoffMs[attempt] ?? null;
}
