import type { CodexThreadSnapshot } from "../codex";
import { SESSION_HYDRATION_POLICY } from "./hydration";

export interface SessionHydrationThreadMetadata {
  readonly cwd?: string;
  readonly executionActive: boolean;
  readonly id: string;
  readonly updatedAt: string;
}

export interface SessionHydrationTargetPlan {
  /** Exact filters, already chunked to the pinned request bound. */
  readonly cwdFilterBatches: readonly (readonly string[])[];
  /** Threads retained as metadata-only bindings. */
  readonly metadataThreadIds: readonly string[];
  /** Selected and execution-active threads eligible for a full read. */
  readonly historyThreadIds: readonly string[];
}

/**
 * Selects a bounded, deterministic hydration working set. The selected thread
 * wins, then execution-active threads, then newest metadata.
 */
export function planSessionHydrationTargets(input: Readonly<{
  cwds: readonly string[];
  selectedThreadId: string | null;
  threads: readonly SessionHydrationThreadMetadata[];
}>): SessionHydrationTargetPlan {
  const byId = new Map<string, SessionHydrationThreadMetadata>();
  for (const thread of input.threads) {
    const current = byId.get(thread.id);
    if (
      current === undefined ||
      thread.updatedAt > current.updatedAt ||
      (thread.updatedAt === current.updatedAt && thread.executionActive)
    ) {
      byId.set(thread.id, thread);
    }
  }
  const sorted = [...byId.values()].toSorted(compareHydrationMetadata);
  const selected = input.selectedThreadId === null
    ? null
    : byId.get(input.selectedThreadId) ?? null;
  const metadata = uniqueThreads([
    ...(selected === null ? [] : [selected]),
    ...sorted.filter(({ executionActive }) => executionActive),
    ...sorted,
  ]).slice(0, SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount);
  const retained = new Set(metadata.map(({ id }) => id));
  const history = uniqueThreads([
    ...(selected !== null && retained.has(selected.id) ? [selected] : []),
    ...sorted.filter(({ executionActive, id }) => executionActive && retained.has(id)),
  ]).slice(0, SESSION_HYDRATION_POLICY.maxHistoryThreadsPerAccount);

  const cwds = [...new Set([
    ...metadata.flatMap(({ cwd }) => cwd === undefined ? [] : [cwd]),
    ...[...input.cwds].toSorted(),
  ])].slice(0, SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount);
  const cwdFilterBatches: string[][] = [];
  for (
    let offset = 0;
    offset < cwds.length;
    offset += SESSION_HYDRATION_POLICY.maxCwdFiltersPerRequest
  ) {
    cwdFilterBatches.push(cwds.slice(
      offset,
      offset + SESSION_HYDRATION_POLICY.maxCwdFiltersPerRequest,
    ));
  }
  return Object.freeze({
    cwdFilterBatches: Object.freeze(
      cwdFilterBatches.map((batch) => Object.freeze(batch)),
    ),
    historyThreadIds: Object.freeze(history.map(({ id }) => id)),
    metadataThreadIds: Object.freeze(metadata.map(({ id }) => id)),
  });
}

export interface SessionDisplayWindow {
  readonly bytes: number;
  readonly items: number;
  readonly snapshot: CodexThreadSnapshot;
  readonly truncated: boolean;
}

/** Keeps the newest complete items without mutating partial turn views. */
export function windowSessionThreadDisplay(
  snapshot: CodexThreadSnapshot,
): SessionDisplayWindow {
  if (snapshot.turns === null) {
    return { bytes: 0, items: 0, snapshot, truncated: false };
  }
  let bytes = 0;
  let items = 0;
  let truncated = false;
  const selectedByTurn = new Map<string, Set<string>>();
  for (const turn of [...snapshot.turns].reverse()) {
    if (turn.items === null) continue;
    const selected = new Set<string>();
    for (const item of [...turn.items].reverse()) {
      const itemBytes = encodedBytes(item);
      if (
        items >= SESSION_HYDRATION_POLICY.maxDisplayItemsPerThread ||
        bytes + itemBytes > SESSION_HYDRATION_POLICY.maxDisplayBytesPerThread
      ) {
        truncated = true;
        continue;
      }
      selected.add(item.id);
      items += 1;
      bytes += itemBytes;
    }
    selectedByTurn.set(turn.id, selected);
  }
  if (!truncated) return { bytes, items, snapshot, truncated: false };
  const turns = snapshot.turns.map((turn) => {
    if (turn.items === null) return turn;
    const selected = selectedByTurn.get(turn.id) ?? new Set<string>();
    return {
      ...turn,
      items: Object.freeze(turn.items.filter((item) => selected.has(item.id))),
    };
  });
  return {
    bytes,
    items,
    snapshot: { ...snapshot, turns: Object.freeze(turns) },
    truncated: true,
  };
}

function compareHydrationMetadata(
  left: SessionHydrationThreadMetadata,
  right: SessionHydrationThreadMetadata,
): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function uniqueThreads(
  values: readonly SessionHydrationThreadMetadata[],
): SessionHydrationThreadMetadata[] {
  const seen = new Set<string>();
  return values.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Session display item is not JSON-encodable");
  return new TextEncoder().encode(encoded).byteLength;
}
