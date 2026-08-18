export const MAX_RENDERED_PROVIDER_SUBAGENTS = 8;
export const MAX_TRACKED_PROVIDER_SUBAGENTS_PER_TURN = 128;
export const MAX_PROVIDER_SUBAGENT_TURN_SCOPES = 64;
export const MAX_PROVIDER_SUBAGENT_EVENTS_PER_TURN = 4_096;

export interface ProviderSubagentTurnScope {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly turnId: string;
}

export interface ProviderSubagentObservation extends ProviderSubagentTurnScope {
  /** Gateway-private provider identity. */
  readonly agentId: string;
  readonly factIndex: number;
  readonly status: "running" | "starting" | "terminal";
  readonly streamPosition: number;
}

export interface ProviderSubagentProjectionRow {
  readonly id: string;
  readonly label: string;
  readonly status: "running" | "starting";
}

export interface ProviderSubagentProjection {
  readonly agents: readonly ProviderSubagentProjectionRow[];
  readonly overflowCount: number;
}

interface TrackedAgent {
  readonly label: string;
  readonly opaqueId: string;
  readonly ordinal: number;
  status: ProviderSubagentObservation["status"];
}

interface TurnState {
  readonly agents: Map<string, TrackedAgent>;
  readonly eventDigests: Map<string, string>;
  readonly scope: ProviderSubagentTurnScope;
  eventCount: number;
  lastFactIndex: number;
  lastStreamPosition: number;
  nextOrdinal: number;
}

const EMPTY_PROJECTION: ProviderSubagentProjection = Object.freeze({
  agents: Object.freeze([]),
  overflowCount: 0,
});

/**
 * Converts provider-private collaboration identities into a bounded,
 * read-only semantic list. Prompts, messages, paths, models, effort, and raw
 * thread identities have no output field and cannot cross this boundary.
 * Opaque IDs are generation-local by design: generation replacement clears
 * every row before a replacement process can publish a new snapshot.
 */
export class ProviderSubagentProjectionTracker {
  readonly #generationByAccount = new Map<string, number>();
  readonly #turns = new Map<string, TurnState>();
  #nextOpaqueId = 1;

  beginTurn(scope: ProviderSubagentTurnScope): void {
    validateScope(scope);
    if (!this.#admitGeneration(scope.accountProfileId, scope.generation)) return;
    for (const [key, turn] of this.#turns) {
      if (
        turn.scope.accountProfileId === scope.accountProfileId &&
        turn.scope.generation === scope.generation &&
        turn.scope.threadId === scope.threadId &&
        turn.scope.turnId !== scope.turnId
      ) this.#turns.delete(key);
    }
    this.#turn(scope);
  }

  observe(input: ProviderSubagentObservation): boolean {
    validateObservation(input);
    if (!this.#admitGeneration(input.accountProfileId, input.generation)) return false;
    const turn = this.#turn(input);
    const eventKey = `${input.streamPosition}:${input.factIndex}`;
    const eventDigest = digestObservation(input);
    const priorDigest = turn.eventDigests.get(eventKey);
    if (priorDigest !== undefined) {
      if (priorDigest !== eventDigest) throw new ProviderSubagentInvariantError();
      return false;
    }
    if (
      input.streamPosition < turn.lastStreamPosition ||
      (
        input.streamPosition === turn.lastStreamPosition &&
        input.factIndex < turn.lastFactIndex
      )
    ) throw new ProviderSubagentInvariantError();
    if (turn.eventCount >= MAX_PROVIDER_SUBAGENT_EVENTS_PER_TURN) {
      throw new ProviderSubagentCapacityError();
    }
    turn.eventDigests.set(eventKey, eventDigest);
    turn.eventCount += 1;
    turn.lastStreamPosition = input.streamPosition;
    turn.lastFactIndex = input.factIndex;

    const current = turn.agents.get(input.agentId);
    if (current === undefined) {
      if (turn.agents.size >= MAX_TRACKED_PROVIDER_SUBAGENTS_PER_TURN) {
        throw new ProviderSubagentCapacityError();
      }
      const ordinal = turn.nextOrdinal;
      turn.nextOrdinal += 1;
      turn.agents.set(input.agentId, {
        label: `Agent ${ordinal}`,
        opaqueId: this.#opaqueId(),
        ordinal,
        status: input.status,
      });
      return true;
    }
    const nextStatus = normalizedStatus(current.status, input.status);
    if (nextStatus === current.status) return false;
    current.status = nextStatus;
    return true;
  }

  snapshot(scope: ProviderSubagentTurnScope): ProviderSubagentProjection {
    validateScope(scope);
    const turn = this.#turns.get(turnKey(scope));
    if (turn === undefined) return EMPTY_PROJECTION;
    const active = [...turn.agents.values()]
      .filter((agent) => agent.status !== "terminal")
      .sort((left, right) => left.ordinal - right.ordinal);
    const agents = active.slice(0, MAX_RENDERED_PROVIDER_SUBAGENTS).map((agent) =>
      Object.freeze({
        id: agent.opaqueId,
        label: agent.label,
        status: agent.status as "running" | "starting",
      })
    );
    return Object.freeze({
      agents: Object.freeze(agents),
      overflowCount: active.length - agents.length,
    });
  }

  completeTurn(scope: ProviderSubagentTurnScope): boolean {
    validateScope(scope);
    return this.#turns.delete(turnKey(scope));
  }

  advanceGeneration(accountProfileId: string, generation: number): void {
    validateGeneration(accountProfileId, generation);
    this.#admitGeneration(accountProfileId, generation);
  }

  purgeAccount(accountProfileId: string): void {
    this.#generationByAccount.delete(accountProfileId);
    for (const [key, turn] of this.#turns) {
      if (turn.scope.accountProfileId === accountProfileId) this.#turns.delete(key);
    }
  }

  get trackedTurnCount(): number {
    return this.#turns.size;
  }

  #turn(scope: ProviderSubagentTurnScope): TurnState {
    const key = turnKey(scope);
    const current = this.#turns.get(key);
    if (current !== undefined) return current;
    if (this.#turns.size >= MAX_PROVIDER_SUBAGENT_TURN_SCOPES) {
      throw new ProviderSubagentCapacityError();
    }
    const created: TurnState = {
      agents: new Map(),
      eventCount: 0,
      eventDigests: new Map(),
      lastFactIndex: -1,
      lastStreamPosition: -1,
      nextOrdinal: 1,
      scope: Object.freeze({ ...scope }),
    };
    this.#turns.set(key, created);
    return created;
  }

  #admitGeneration(accountProfileId: string, generation: number): boolean {
    validateGeneration(accountProfileId, generation);
    const current = this.#generationByAccount.get(accountProfileId);
    if (current !== undefined && generation < current) return false;
    if (current === generation) return true;
    this.#generationByAccount.set(accountProfileId, generation);
    for (const [key, turn] of this.#turns) {
      if (turn.scope.accountProfileId === accountProfileId) this.#turns.delete(key);
    }
    return true;
  }

  #opaqueId(): string {
    if (this.#nextOpaqueId >= Number.MAX_SAFE_INTEGER) {
      throw new ProviderSubagentCapacityError();
    }
    const id = `provideragent_${this.#nextOpaqueId.toString(36).padStart(10, "0")}`;
    this.#nextOpaqueId += 1;
    return id;
  }
}

export class ProviderSubagentInvariantError extends Error {
  constructor() {
    super("Provider-subagent observations violate their positioned identity.");
    this.name = "ProviderSubagentInvariantError";
  }
}

export class ProviderSubagentCapacityError extends Error {
  constructor() {
    super("Provider-subagent projection capacity is exhausted.");
    this.name = "ProviderSubagentCapacityError";
  }
}

function normalizedStatus(
  current: ProviderSubagentObservation["status"],
  observed: ProviderSubagentObservation["status"],
): ProviderSubagentObservation["status"] {
  if (observed === "terminal") return "terminal";
  if (current === "terminal") return "terminal";
  if (current === "running" && observed === "starting") return "running";
  return observed;
}

function validateObservation(input: ProviderSubagentObservation): void {
  validateScope(input);
  if (
    input.agentId.length === 0 ||
    !Number.isSafeInteger(input.streamPosition) ||
    input.streamPosition < 0 ||
    !Number.isSafeInteger(input.factIndex) ||
    input.factIndex < 0
  ) throw new TypeError("The provider-subagent observation is invalid.");
}

function validateScope(scope: ProviderSubagentTurnScope): void {
  validateGeneration(scope.accountProfileId, scope.generation);
  if (scope.threadId.length === 0 || scope.turnId.length === 0) {
    throw new TypeError("The provider-subagent turn scope is invalid.");
  }
}

function validateGeneration(accountProfileId: string, generation: number): void {
  if (
    accountProfileId.length === 0 ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) throw new TypeError("The provider-subagent generation is invalid.");
}

function turnKey(scope: ProviderSubagentTurnScope): string {
  return [
    scope.accountProfileId,
    String(scope.generation),
    scope.threadId,
    scope.turnId,
  ].map((value) => `${value.length}:${value}`).join("");
}

function digestObservation(input: ProviderSubagentObservation): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update([
    "hra-provider-subagent-observation-v1",
    input.accountProfileId,
    String(input.generation),
    input.threadId,
    input.turnId,
    input.agentId,
    input.status,
    String(input.streamPosition),
    String(input.factIndex),
  ].map((value) => `${value.length}:${value}`).join(""));
  return hasher.digest("hex");
}
