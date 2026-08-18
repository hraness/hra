const textEncoder = new TextEncoder();

export const MAX_REASONING_SUMMARY_PARTS = 64;
export const MAX_REASONING_SUMMARY_EVENTS_PER_ITEM = 4_096;
export const MAX_REASONING_SUMMARY_ACTIVE_ITEMS = 256;
export const MAX_REASONING_SUMMARY_DISPLAY_UTF8_BYTES = 64 * 1_024;

export interface ReasoningSummaryScope {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly itemId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface ReasoningSummaryCursor {
  readonly factIndex: number;
  readonly generation: number;
  readonly streamPosition: number;
}

export interface ReasoningSummaryDeltaObservation extends ReasoningSummaryScope {
  readonly cursor: ReasoningSummaryCursor;
  readonly delta: string;
  readonly summaryIndex: number;
  readonly truncated: boolean;
}

export interface ReasoningSummaryPartObservation extends ReasoningSummaryScope {
  readonly cursor: ReasoningSummaryCursor;
  readonly summaryIndex: number;
}

export interface ReasoningSummaryCompletionObservation extends ReasoningSummaryScope {
  readonly cursor: ReasoningSummaryCursor;
  readonly summaryParts: readonly string[];
  readonly truncated: boolean;
}

export type ReasoningSummaryTaintReason =
  | "capacityExceeded"
  | "completionConflict"
  | "cursorConflict"
  | "cursorRegression"
  | "lateActivity"
  | "nonSuffixGap"
  | "orderingConflict"
  | "partLimitExceeded"
  | "summaryConflict";

export type ReasoningSummaryCompletionReceipt =
  | Readonly<{
      completionDigest: string;
      completionFactIndex: number;
      completionStreamPosition: number;
      overflowed: boolean;
      reason: null;
      receiptId: string;
      repairedSuffix: boolean;
      state: "verified";
      summary: Readonly<{
        tail: string;
        totalUtf8Bytes: number;
        truncatedPrefix: boolean;
      }>;
      terminalVisible: true;
    }>
  | Readonly<{
      completionDigest: null;
      completionFactIndex: number;
      completionStreamPosition: number;
      overflowed: boolean;
      reason: ReasoningSummaryTaintReason;
      receiptId: string;
      repairedSuffix: false;
      state: "tainted";
      summary: null;
      terminalVisible: false;
    }>;

interface PartState {
  readonly cut: boolean;
  readonly sawDelta: boolean;
  readonly text: string;
}

interface ItemState {
  readonly eventDigests: Map<string, string>;
  readonly parts: Map<number, PartState>;
  readonly scope: ReasoningSummaryScope;
  completion: ReasoningSummaryCompletionReceipt | null;
  eventCount: number;
  highestObservedSummaryIndex: number;
  lastCursor: ReasoningSummaryCursor | null;
  overflowed: boolean;
  retainedUtf8Bytes: number;
  taintReason: ReasoningSummaryTaintReason | null;
}

/**
 * Retains only sanctioned reasoning-summary text. Raw reasoning content has no
 * input in this API. A terminal summary is visible only after an exact
 * item-completion receipt proves the observed stream is a prefix with, at
 * most, a missing suffix.
 */
export class ReasoningSummaryAccumulator {
  readonly #items = new Map<string, ItemState>();

  observePart(input: ReasoningSummaryPartObservation): boolean {
    const state = this.#state(input);
    if (!this.#admitEvent(state, input.cursor, eventDigest("part", input.summaryIndex))) {
      return false;
    }
    if (!validSummaryIndex(input.summaryIndex)) {
      this.#taint(state, "partLimitExceeded");
      return false;
    }
    this.#observeIndex(state, input.summaryIndex);
    if (!state.parts.has(input.summaryIndex)) {
      state.parts.set(input.summaryIndex, emptyPart());
    }
    return state.taintReason === null;
  }

  observeDelta(input: ReasoningSummaryDeltaObservation): boolean {
    const state = this.#state(input);
    const digest = eventDigest(
      "delta",
      input.summaryIndex,
      input.truncated ? "truncated" : "complete",
      input.delta,
    );
    if (!this.#admitEvent(state, input.cursor, digest)) return false;
    if (!validSummaryIndex(input.summaryIndex)) {
      this.#taint(state, "partLimitExceeded");
      return false;
    }
    this.#observeIndex(state, input.summaryIndex);
    const current = state.parts.get(input.summaryIndex) ?? emptyPart();
    const remaining = Math.max(
      0,
      MAX_REASONING_SUMMARY_DISPLAY_UTF8_BYTES - state.retainedUtf8Bytes,
    );
    const retained = current.cut ? "" : utf8Prefix(input.delta, remaining);
    const retainedBytes = utf8Bytes(retained);
    const cut = current.cut || input.truncated || retained !== input.delta;
    state.parts.set(input.summaryIndex, {
      cut,
      sawDelta: true,
      text: `${current.text}${retained}`,
    });
    state.retainedUtf8Bytes += retainedBytes;
    if (cut) state.overflowed = true;
    return state.taintReason === null;
  }

  complete(
    input: ReasoningSummaryCompletionObservation,
  ): ReasoningSummaryCompletionReceipt {
    const state = this.#state(input);
    const completionText = input.summaryParts.join("\n");
    const completionDigest = digestText(
      "hra-reasoning-summary-completion-v1",
      input.truncated ? "truncated" : "complete",
      completionText,
    );
    if (state.completion !== null) {
      if (
        state.completion.state === "verified" &&
        state.completion.completionDigest === completionDigest
      ) return state.completion;
      this.#taint(state, "completionConflict");
      state.completion = taintedReceipt(state, input.cursor);
      return state.completion;
    }
    const digest = eventDigest(
      "completion",
      input.truncated ? "truncated" : "complete",
      completionText,
    );
    this.#admitEvent(state, input.cursor, digest, true);
    if (input.summaryParts.length > MAX_REASONING_SUMMARY_PARTS) {
      this.#taint(state, "partLimitExceeded");
    }
    const reconciliation = this.#reconcile(state, input.summaryParts);
    if (reconciliation.reason !== null) this.#taint(state, reconciliation.reason);
    if (state.taintReason !== null) {
      state.completion = taintedReceipt(state, input.cursor);
      return state.completion;
    }

    const totalUtf8Bytes = utf8Bytes(completionText);
    const tail = utf8Tail(
      completionText,
      MAX_REASONING_SUMMARY_DISPLAY_UTF8_BYTES,
    );
    const receiptId = digestText(
      "hra-reasoning-summary-receipt-v1",
      scopeKey(input),
      completionDigest,
    ).slice(0, 58);
    state.completion = Object.freeze({
      state: "verified",
      receiptId: `reasoning_${receiptId}`,
      completionDigest,
      completionFactIndex: input.cursor.factIndex,
      completionStreamPosition: input.cursor.streamPosition,
      overflowed: state.overflowed || input.truncated || tail !== completionText,
      reason: null,
      repairedSuffix: reconciliation.repairedSuffix,
      summary: Object.freeze({
        tail,
        totalUtf8Bytes,
        truncatedPrefix: tail !== completionText,
      }),
      terminalVisible: true,
    });
    return state.completion;
  }

  receipt(scope: ReasoningSummaryScope): ReasoningSummaryCompletionReceipt | null {
    return this.#items.get(scopeKey(scope))?.completion ?? null;
  }

  clearTurn(input: Readonly<{
    accountProfileId: string;
    generation: number;
    threadId: string;
    turnId: string;
  }>): void {
    for (const [key, state] of this.#items) {
      if (
        state.scope.accountProfileId === input.accountProfileId &&
        state.scope.generation === input.generation &&
        state.scope.threadId === input.threadId &&
        state.scope.turnId === input.turnId
      ) this.#items.delete(key);
    }
  }

  advanceGeneration(accountProfileId: string, generation: number): void {
    for (const [key, state] of this.#items) {
      if (
        state.scope.accountProfileId === accountProfileId &&
        state.scope.generation !== generation
      ) this.#items.delete(key);
    }
  }

  purgeAccount(accountProfileId: string): void {
    for (const [key, state] of this.#items) {
      if (state.scope.accountProfileId === accountProfileId) this.#items.delete(key);
    }
  }

  get activeItemCount(): number {
    return this.#items.size;
  }

  #state(scope: ReasoningSummaryScope): ItemState {
    validateScope(scope);
    const key = scopeKey(scope);
    const current = this.#items.get(key);
    if (current !== undefined) return current;
    if (this.#items.size >= MAX_REASONING_SUMMARY_ACTIVE_ITEMS) {
      throw new ReasoningSummaryCapacityError();
    }
    const created: ItemState = {
      completion: null,
      eventCount: 0,
      eventDigests: new Map(),
      highestObservedSummaryIndex: -1,
      lastCursor: null,
      overflowed: false,
      parts: new Map(),
      retainedUtf8Bytes: 0,
      scope: Object.freeze({ ...scope }),
      taintReason: null,
    };
    this.#items.set(key, created);
    return created;
  }

  #admitEvent(
    state: ItemState,
    cursor: ReasoningSummaryCursor,
    digest: string,
    completion = false,
  ): boolean {
    validateCursor(cursor, state.scope.generation);
    const key = cursorKey(cursor);
    const prior = state.eventDigests.get(key);
    if (prior !== undefined) {
      if (prior !== digest) this.#taint(state, "cursorConflict");
      return false;
    }
    if (state.completion !== null && !completion) {
      this.#taint(state, "lateActivity");
      return false;
    }
    if (state.lastCursor !== null && compareCursor(cursor, state.lastCursor) < 0) {
      this.#taint(state, "cursorRegression");
      return false;
    }
    if (state.eventCount >= MAX_REASONING_SUMMARY_EVENTS_PER_ITEM) {
      this.#taint(state, "capacityExceeded");
      return false;
    }
    state.eventDigests.set(key, digest);
    state.eventCount += 1;
    state.lastCursor = Object.freeze({ ...cursor });
    return true;
  }

  #observeIndex(state: ItemState, summaryIndex: number): void {
    if (summaryIndex < state.highestObservedSummaryIndex) {
      this.#taint(state, "orderingConflict");
    }
    state.highestObservedSummaryIndex = Math.max(
      state.highestObservedSummaryIndex,
      summaryIndex,
    );
  }

  #reconcile(
    state: ItemState,
    completeParts: readonly string[],
  ): Readonly<{
    reason: ReasoningSummaryTaintReason | null;
    repairedSuffix: boolean;
  }> {
    const contentIndices = [...state.parts.entries()]
      .filter(([, part]) => part.sawDelta)
      .map(([index]) => index)
      .sort((left, right) => left - right);
    if (contentIndices.length === 0) {
      return { reason: null, repairedSuffix: completeParts.join("").length > 0 };
    }
    const lastContentIndex = contentIndices.at(-1)!;
    if (lastContentIndex >= completeParts.length) {
      return { reason: "summaryConflict", repairedSuffix: false };
    }
    let repairedSuffix = completeParts.length > lastContentIndex + 1;
    for (let index = 0; index <= lastContentIndex; index += 1) {
      const observed = state.parts.get(index);
      const complete = completeParts[index] ?? "";
      if (observed === undefined || !observed.sawDelta) {
        if (complete.length > 0) {
          return { reason: "nonSuffixGap", repairedSuffix: false };
        }
        continue;
      }
      if (!complete.startsWith(observed.text)) {
        return { reason: "summaryConflict", repairedSuffix: false };
      }
      if (index < lastContentIndex && observed.text !== complete) {
        return { reason: "nonSuffixGap", repairedSuffix: false };
      }
      if (index === lastContentIndex && observed.text !== complete) {
        repairedSuffix = true;
      }
    }
    return { reason: null, repairedSuffix };
  }

  #taint(state: ItemState, reason: ReasoningSummaryTaintReason): void {
    if (state.taintReason === null) state.taintReason = reason;
    if (state.completion !== null && state.completion.state === "verified") {
      state.completion = taintedReceipt(state, {
        factIndex: state.completion.completionFactIndex,
        generation: state.scope.generation,
        streamPosition: state.completion.completionStreamPosition,
      });
    }
  }
}

export class ReasoningSummaryCapacityError extends Error {
  constructor() {
    super("Reasoning-summary accumulator capacity is exhausted.");
    this.name = "ReasoningSummaryCapacityError";
  }
}

function taintedReceipt(
  state: ItemState,
  cursor: ReasoningSummaryCursor,
): Extract<ReasoningSummaryCompletionReceipt, { state: "tainted" }> {
  const reason = state.taintReason ?? "summaryConflict";
  const receiptDigest = digestText(
    "hra-reasoning-summary-tainted-v1",
    scopeKey(state.scope),
    reason,
    String(cursor.streamPosition),
    String(cursor.factIndex),
  ).slice(0, 58);
  return Object.freeze({
    state: "tainted",
    receiptId: `reasoning_${receiptDigest}`,
    completionDigest: null,
    completionFactIndex: cursor.factIndex,
    completionStreamPosition: cursor.streamPosition,
    overflowed: state.overflowed,
    reason,
    repairedSuffix: false,
    summary: null,
    terminalVisible: false,
  });
}

function emptyPart(): PartState {
  return { cut: false, sawDelta: false, text: "" };
}

function validSummaryIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < MAX_REASONING_SUMMARY_PARTS;
}

function validateScope(scope: ReasoningSummaryScope): void {
  if (
    scope.accountProfileId.length === 0 ||
    scope.threadId.length === 0 ||
    scope.turnId.length === 0 ||
    scope.itemId.length === 0 ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  ) throw new TypeError("The reasoning-summary scope is invalid.");
}

function validateCursor(cursor: ReasoningSummaryCursor, generation: number): void {
  if (
    cursor.generation !== generation ||
    !Number.isSafeInteger(cursor.streamPosition) ||
    cursor.streamPosition < 0 ||
    !Number.isSafeInteger(cursor.factIndex) ||
    cursor.factIndex < 0
  ) throw new TypeError("The reasoning-summary cursor is invalid.");
}

function scopeKey(scope: ReasoningSummaryScope): string {
  return [
    scope.accountProfileId,
    String(scope.generation),
    scope.threadId,
    scope.turnId,
    scope.itemId,
  ].map((value) => `${utf8Bytes(value)}:${value}`).join("");
}

function cursorKey(cursor: ReasoningSummaryCursor): string {
  return `${cursor.generation}:${cursor.streamPosition}:${cursor.factIndex}`;
}

function compareCursor(left: ReasoningSummaryCursor, right: ReasoningSummaryCursor): number {
  return left.streamPosition - right.streamPosition || left.factIndex - right.factIndex;
}

function eventDigest(...values: readonly (number | string)[]): string {
  return digestText("hra-reasoning-summary-event-v1", ...values.map(String));
}

function digestText(namespace: string, ...values: readonly string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const value of [namespace, ...values]) {
    hasher.update(`${utf8Bytes(value)}:`);
    hasher.update(value);
  }
  return hasher.digest("hex");
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function utf8Tail(value: string, maxBytes: number): string {
  const characters = [...value];
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const next = utf8Bytes(characters[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return characters.slice(start).join("");
}
