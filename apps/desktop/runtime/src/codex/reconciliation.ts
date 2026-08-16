import { createHash } from "node:crypto";

import type {
  PinnedCodexHistoryThreadItem,
  PinnedCodexThread,
  PinnedCodexThreadItemsList,
  PinnedCodexThreadItemsListInput,
  PinnedCodexThreadList,
  PinnedCodexThreadListInput,
  PinnedCodexThreadTurnsList,
  PinnedCodexThreadTurnsListInput,
  PinnedCodexTurn,
} from "./pinned-codecs";

const THREAD_PAGE_SIZE = 256;
const TURN_PAGE_SIZE = 128;
const ITEM_PAGE_SIZE = 256;
const MAX_RECONCILIATION_PAGES = 4_096;
const MAX_RECONCILIATION_THREADS = 65_536;
const MAX_RECONCILIATION_TURNS = 10_000;
const MAX_RECONCILIATION_ITEMS = 100_000;

export interface PinnedCodexReconciliationReader {
  readonly threadList: (
    input: PinnedCodexThreadListInput,
  ) => Promise<PinnedCodexThreadList>;
  readonly threadTurnsList: (
    input: PinnedCodexThreadTurnsListInput,
  ) => Promise<PinnedCodexThreadTurnsList>;
  readonly threadItemsList: (
    input: PinnedCodexThreadItemsListInput,
  ) => Promise<PinnedCodexThreadItemsList>;
}

export interface PinnedCodexMutationFence {
  readonly previousGenerationTerminated: boolean;
  readonly exclusiveMutationLease: boolean;
  readonly externalDeletionExcluded: boolean;
}

export interface PinnedCodexThreadStartIdentity {
  readonly threadSource: string;
  readonly cwd: string;
  readonly ephemeral: boolean;
  readonly historyMode: "legacy" | "paginated";
}

export interface PinnedCodexThreadStartScan {
  readonly complete: boolean;
  readonly active: readonly PinnedCodexThread[];
  readonly archived: readonly PinnedCodexThread[];
}

export type PinnedCodexMutationReconciliation =
  | Readonly<{ kind: "applied"; threadId: string; turnId?: string }>
  | Readonly<{ kind: "not_applied" }>
  | Readonly<{
      kind: "pending";
      reason: "incomplete_scan" | "unstable_scan" | "generation_not_fenced" | "turn_active";
    }>
  | Readonly<{
      kind: "ambiguous";
      reason:
        | "duplicate_identity"
        | "identity_mismatch"
        | "duplicate_turn"
        | "duplicate_item"
        | "duplicate_client_message_id"
        | "missing_turn";
    }>;

export interface PinnedCodexTurnScanEntry {
  readonly turn: PinnedCodexTurn;
  readonly items: readonly PinnedCodexHistoryThreadItem[];
}

export interface PinnedCodexTurnScan {
  readonly complete: boolean;
  readonly threadId: string;
  readonly turns: readonly PinnedCodexTurnScanEntry[];
}

export type PinnedCodexInterruptReconciliation =
  | Readonly<{
      kind: "pending";
      reason: "incomplete_scan" | "unstable_scan" | "turn_in_progress";
    }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{
      kind: "ambiguous";
      reason: "duplicate_turn" | "missing_turn";
    }>;

/**
 * Exhaust every active and archived thread page. Repeated cursors and bounded
 * resource exhaustion fail closed as an incomplete scan; transport and codec
 * faults continue to reject to the caller.
 */
export async function scanPinnedCodexThreadStarts(
  reader: Pick<PinnedCodexReconciliationReader, "threadList">,
): Promise<PinnedCodexThreadStartScan> {
  const budget: PageBudget = { remainingPages: MAX_RECONCILIATION_PAGES };
  const active = await collectPages(
    (cursor) => reader.threadList({
      cursor,
      limit: THREAD_PAGE_SIZE,
      sortKey: "created_at",
      sortDirection: "asc",
      archived: false,
    }),
    budget,
    MAX_RECONCILIATION_THREADS,
  );
  if (!active.complete) {
    return { complete: false, active: active.data, archived: [] };
  }
  const archived = await collectPages(
    (cursor) => reader.threadList({
      cursor,
      limit: THREAD_PAGE_SIZE,
      sortKey: "created_at",
      sortDirection: "asc",
      archived: true,
    }),
    budget,
    MAX_RECONCILIATION_THREADS - active.data.length,
  );
  return {
    complete: archived.complete,
    active: active.data,
    archived: archived.data,
  };
}

/**
 * Exhaust every turn page and then every item page for each returned turn.
 * The explicit item pass prevents a summary/not-loaded turn projection from
 * hiding the client message identity used to reconcile `turn/start`.
 */
export async function scanPinnedCodexTurns(
  reader: Pick<
    PinnedCodexReconciliationReader,
    "threadTurnsList" | "threadItemsList"
  >,
  threadId: string,
): Promise<PinnedCodexTurnScan> {
  const budget: PageBudget = { remainingPages: MAX_RECONCILIATION_PAGES };
  const turns = await collectPages(
    (cursor) => reader.threadTurnsList({
      threadId,
      cursor,
      limit: TURN_PAGE_SIZE,
      sortDirection: "asc",
      itemsView: "notLoaded",
    }),
    budget,
    MAX_RECONCILIATION_TURNS,
  );
  if (!turns.complete) {
    return {
      complete: false,
      threadId,
      turns: turns.data.map((turn) => ({ turn, items: [] })),
    };
  }

  const duplicateTurnIds = hasDuplicateIds(turns.data);
  if (duplicateTurnIds) {
    return {
      complete: true,
      threadId,
      turns: turns.data.map((turn) => ({ turn, items: [] })),
    };
  }

  const entries: PinnedCodexTurnScanEntry[] = [];
  let remainingItems = MAX_RECONCILIATION_ITEMS;
  for (const turn of turns.data) {
    const items = await collectPages(
      (cursor) => reader.threadItemsList({
        threadId,
        turnId: turn.id,
        cursor,
        limit: ITEM_PAGE_SIZE,
        sortDirection: "asc",
      }),
      budget,
      remainingItems,
    );
    entries.push({ turn, items: items.data });
    remainingItems -= items.data.length;
    if (!items.complete) {
      return { complete: false, threadId, turns: entries };
    }
  }
  return { complete: true, threadId, turns: entries };
}

/**
 * Compare the exact ordered evidence returned by two exhaustive scans. Object
 * key order is normalized, while turn and item array order remains evidence.
 */
export function pinnedCodexTurnScansHaveExactEvidence(
  first: PinnedCodexTurnScan,
  second: PinnedCodexTurnScan,
): boolean {
  return exactTurnScanEvidence(first) === exactTurnScanEvidence(second);
}

/** Content-free digest of one exact ordered exhaustive scan. */
export function pinnedCodexTurnScanEvidenceDigest(
  scan: PinnedCodexTurnScan,
): string {
  return createHash("sha256").update(exactTurnScanEvidence(scan)).digest("hex");
}

/**
 * Classify two complete active+archived scans after a lost `thread/start`
 * response. A missing identity is safe to retry only after the old generation
 * is gone and the caller proves exclusive mutation and deletion authority.
 */
export function reconcilePinnedCodexThreadStart(
  identity: PinnedCodexThreadStartIdentity,
  first: PinnedCodexThreadStartScan,
  second: PinnedCodexThreadStartScan,
  fence: PinnedCodexMutationFence,
): PinnedCodexMutationReconciliation {
  if (!first.complete || !second.complete) {
    return { kind: "pending", reason: "incomplete_scan" };
  }
  if (canonicalThreadScan(first) !== canonicalThreadScan(second)) {
    return { kind: "pending", reason: "unstable_scan" };
  }
  const matches = [...first.active, ...first.archived]
    .filter((thread) => thread.threadSource === identity.threadSource);
  if (matches.length > 1 || new Set(matches.map(({ id }) => id)).size !== matches.length) {
    return { kind: "ambiguous", reason: "duplicate_identity" };
  }
  const match = matches[0];
  if (match !== undefined) {
    if (
      match.cwd !== identity.cwd ||
      match.ephemeral !== identity.ephemeral ||
      match.historyMode !== identity.historyMode
    ) {
      return { kind: "ambiguous", reason: "identity_mismatch" };
    }
    return { kind: "applied", threadId: match.id };
  }
  return hasMutationFence(fence)
    ? { kind: "not_applied" }
    : { kind: "pending", reason: "generation_not_fenced" };
}

/** Classify two exhaustive turn+item scans after a lost `turn/start`. */
export function reconcilePinnedCodexTurnStart(
  clientUserMessageId: string,
  first: PinnedCodexTurnScan,
  second: PinnedCodexTurnScan,
  fence: PinnedCodexMutationFence,
): PinnedCodexMutationReconciliation {
  const validation = validateStableTurnScans(first, second);
  if (validation !== null) return validation;
  const matches = first.turns.flatMap(({ turn, items }) =>
    items.flatMap((item) =>
      item.type === "userMessage" && item.clientId === clientUserMessageId
        ? [turn]
        : []
    )
  );
  if (matches.length > 1) {
    return { kind: "ambiguous", reason: "duplicate_client_message_id" };
  }
  const match = matches[0];
  if (match !== undefined) {
    return { kind: "applied", threadId: first.threadId, turnId: match.id };
  }
  if (first.turns.some(({ turn }) => turn.status === "inProgress")) {
    return { kind: "pending", reason: "turn_active" };
  }
  return hasMutationFence(fence)
    ? { kind: "not_applied" }
    : { kind: "pending", reason: "generation_not_fenced" };
}

/**
 * An interrupt acknowledgement never means cancellation completed. Only a
 * stable persisted terminal turn status resolves the interrupt outcome.
 */
export function reconcilePinnedCodexTurnInterrupt(
  turnId: string,
  first: PinnedCodexTurnScan,
  second: PinnedCodexTurnScan,
): PinnedCodexInterruptReconciliation {
  if (!first.complete || !second.complete) {
    return { kind: "pending", reason: "incomplete_scan" };
  }
  if (canonicalTurnScan(first) !== canonicalTurnScan(second)) {
    return { kind: "pending", reason: "unstable_scan" };
  }
  const matches = first.turns.filter(({ turn }) => turn.id === turnId);
  if (matches.length > 1) return { kind: "ambiguous", reason: "duplicate_turn" };
  const match = matches[0];
  if (match === undefined) return { kind: "ambiguous", reason: "missing_turn" };
  switch (match.turn.status) {
    case "inProgress":
      return { kind: "pending", reason: "turn_in_progress" };
    case "interrupted":
      return { kind: "cancelled" };
    case "completed":
      return { kind: "completed" };
    case "failed":
      return { kind: "failed" };
  }
}

function validateStableTurnScans(
  first: PinnedCodexTurnScan,
  second: PinnedCodexTurnScan,
): PinnedCodexMutationReconciliation | null {
  if (!first.complete || !second.complete) {
    return { kind: "pending", reason: "incomplete_scan" };
  }
  if (canonicalTurnScan(first) !== canonicalTurnScan(second)) {
    return { kind: "pending", reason: "unstable_scan" };
  }
  const turnIds = first.turns.map(({ turn }) => turn.id);
  if (new Set(turnIds).size !== turnIds.length) {
    return { kind: "ambiguous", reason: "duplicate_turn" };
  }
  const itemIds = first.turns.flatMap(({ items }) => items.map(({ id }) => id));
  if (new Set(itemIds).size !== itemIds.length) {
    return { kind: "ambiguous", reason: "duplicate_item" };
  }
  return null;
}

function hasMutationFence(fence: PinnedCodexMutationFence): boolean {
  return fence.previousGenerationTerminated &&
    fence.exclusiveMutationLease &&
    fence.externalDeletionExcluded;
}

function canonicalThreadScan(scan: PinnedCodexThreadStartScan): string {
  const entries = [
    ...scan.active.map((thread) => ({ archived: false, thread })),
    ...scan.archived.map((thread) => ({ archived: true, thread })),
  ].toSorted((left, right) => compareStrings(
    `${left.archived ? "1" : "0"}:${left.thread.id}`,
    `${right.archived ? "1" : "0"}:${right.thread.id}`,
  ));
  return JSON.stringify(canonicalJson(entries));
}

function canonicalTurnScan(scan: PinnedCodexTurnScan): string {
  const turns = scan.turns.map(({ turn, items }) => ({
    turn,
    items: [...items].toSorted((left, right) => compareStrings(left.id, right.id)),
  })).toSorted((left, right) => compareStrings(left.turn.id, right.turn.id));
  return JSON.stringify(canonicalJson({ threadId: scan.threadId, turns }));
}

function exactTurnScanEvidence(scan: PinnedCodexTurnScan): string {
  return JSON.stringify(canonicalJson({
    complete: scan.complete,
    threadId: scan.threadId,
    turns: scan.turns,
  }));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface PageBudget {
  remainingPages: number;
}

interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

interface PageCollection<T> {
  readonly complete: boolean;
  readonly data: readonly T[];
}

async function collectPages<T>(
  read: (cursor: string | null) => Promise<Page<T>>,
  budget: PageBudget,
  maxEntries: number,
): Promise<PageCollection<T>> {
  const data: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (budget.remainingPages > 0) {
    budget.remainingPages -= 1;
    const page = await read(cursor);
    if (data.length + page.data.length > maxEntries) {
      return { complete: false, data };
    }
    data.push(...page.data);
    const next = page.nextCursor;
    if (next === null) return { complete: true, data };
    if (seenCursors.has(next)) return { complete: false, data };
    seenCursors.add(next);
    cursor = next;
  }
  return { complete: false, data };
}

function hasDuplicateIds(values: readonly { readonly id: string }[]): boolean {
  return new Set(values.map(({ id }) => id)).size !== values.length;
}
