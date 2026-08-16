import {
  MAX_RUN_INTERACTION_VIEWS,
  type RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";

import { MAX_HUMAN_INPUT_PREVIEW_BYTES } from "./model";

export type HumanInputKind = "approval" | "user_input";

export type HumanInputSummary = Readonly<{
  pendingCount: number;
  oldestRequestedAt: number;
  expiresAt: number;
  kind: HumanInputKind;
  preview: string;
}>;

export type HumanInputProjection = Readonly<
  HumanInputSummary & { latestExpiresAt: number }
>;

export type PendingHumanInput = Readonly<{
  publicId: string;
  request: RunInteractionRequest;
}>;

export type StoredHumanInputProjection = Readonly<{
  hasPendingHumanInput?: true | undefined;
  pendingHumanInputCount?: number | undefined;
  oldestPendingHumanInputAt?: number | undefined;
  oldestPendingHumanInputExpiresAt?: number | undefined;
  latestPendingHumanInputExpiresAt?: number | undefined;
  pendingHumanInputKind?: HumanInputKind | undefined;
  pendingHumanInputPreview?: string | undefined;
}>;

const APPROVAL_PREVIEW = "Allow this task to change files?";
const EMPTY_QUESTION_PREVIEW = "This task needs your input.";
const LINE_BREAK_PATTERN = /[\n\r\v\f\u0085\u2028\u2029]/u;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Normalizes arbitrary provider prose into a one-line, byte-bounded label. */
export function boundedHumanInputPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || EMPTY_QUESTION_PREVIEW;
  if (utf8Length(normalized) <= MAX_HUMAN_INPUT_PREVIEW_BYTES) return normalized;
  let result = "";
  let byteLength = 0;
  for (const codePoint of normalized) {
    const nextLength = utf8Length(codePoint);
    if (byteLength + nextLength > MAX_HUMAN_INPUT_PREVIEW_BYTES) break;
    result += codePoint;
    byteLength += nextLength;
  }
  return result.trimEnd() || EMPTY_QUESTION_PREVIEW;
}

function summaryForInteraction(interaction: PendingHumanInput): Omit<HumanInputSummary, "pendingCount"> {
  const { request } = interaction;
  if (request.kind === "file_change_approval") {
    return {
      oldestRequestedAt: request.createdAt,
      expiresAt: request.expiresAt,
      kind: "approval",
      preview: APPROVAL_PREVIEW,
    };
  }
  const firstQuestion = request.questions[0];
  if (firstQuestion === undefined) {
    throw new TypeError("A validated user-input interaction must contain a question.");
  }
  return {
    oldestRequestedAt: request.createdAt,
    expiresAt: request.expiresAt,
    kind: "user_input",
    preview: boundedHumanInputPreview(firstQuestion.prompt),
  };
}

/**
 * Derives the exact task-level pending-input projection. Oldest request wins;
 * public ID is the deterministic tie-breaker for equal provider timestamps.
 */
export function deriveHumanInputSummary(
  interactions: readonly PendingHumanInput[],
): HumanInputSummary | null {
  if (interactions.length === 0) return null;
  const oldest = [...interactions].sort((left, right) =>
    left.request.createdAt - right.request.createdAt ||
    left.publicId.localeCompare(right.publicId))[0];
  if (oldest === undefined) throw new TypeError("Pending input projection lost its oldest row.");
  return { ...summaryForInteraction(oldest), pendingCount: interactions.length };
}

/** Captures the exact durable summary plus the last expiry among all pending rows. */
export function deriveHumanInputProjection(
  interactions: readonly PendingHumanInput[],
): HumanInputProjection | null {
  const summary = deriveHumanInputSummary(interactions);
  if (summary === null) return null;
  return {
    ...summary,
    latestExpiresAt: Math.max(...interactions.map(({ request }) => request.expiresAt)),
  };
}

/** Derives only questions whose strict provider deadline has not elapsed. */
export function deriveActionableHumanInputSummary(
  interactions: readonly PendingHumanInput[],
  now: number,
): HumanInputSummary | null {
  return deriveHumanInputSummary(
    interactions.filter(({ request }) => request.expiresAt > now),
  );
}

/** Exact comparison used before trusting a denormalized task projection. */
export function humanInputProjectionsMatch(
  left: HumanInputProjection | null,
  right: HumanInputProjection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.pendingCount === right.pendingCount &&
    left.oldestRequestedAt === right.oldestRequestedAt &&
    left.expiresAt === right.expiresAt &&
    left.latestExpiresAt === right.latestExpiresAt &&
    left.kind === right.kind &&
    left.preview === right.preview;
}

/** Omits rows that aged out of the live phase after a cursor snapshot. */
export function humanInputProjectionIsDisplayableAt(
  projection: HumanInputProjection | null,
  snapshotAt: number,
  now: number,
): boolean {
  return projection === null ||
    projection.latestExpiresAt <= snapshotAt ||
    projection.latestExpiresAt > now;
}

/** Converts the public summary to a patch; null removes every optional field. */
export function storedHumanInputProjection(
  summary: HumanInputProjection | null,
): StoredHumanInputProjection {
  if (summary === null) {
    return {
      hasPendingHumanInput: undefined,
      pendingHumanInputCount: undefined,
      oldestPendingHumanInputAt: undefined,
      oldestPendingHumanInputExpiresAt: undefined,
      latestPendingHumanInputExpiresAt: undefined,
      pendingHumanInputKind: undefined,
      pendingHumanInputPreview: undefined,
    };
  }
  return {
    hasPendingHumanInput: true,
    pendingHumanInputCount: summary.pendingCount,
    oldestPendingHumanInputAt: summary.oldestRequestedAt,
    oldestPendingHumanInputExpiresAt: summary.expiresAt,
    latestPendingHumanInputExpiresAt: summary.latestExpiresAt,
    pendingHumanInputKind: summary.kind,
    pendingHumanInputPreview: summary.preview,
  };
}

/** Parses the optional storage fields as one all-or-nothing projection. */
export function humanInputProjectionFromTask(
  task: StoredHumanInputProjection,
): HumanInputProjection | null | undefined {
  const pendingCount = task.pendingHumanInputCount;
  const oldestRequestedAt = task.oldestPendingHumanInputAt;
  const expiresAt = task.oldestPendingHumanInputExpiresAt;
  const latestExpiresAt = task.latestPendingHumanInputExpiresAt;
  const kind = task.pendingHumanInputKind;
  const preview = task.pendingHumanInputPreview;
  const values = [
    pendingCount,
    oldestRequestedAt,
    expiresAt,
    latestExpiresAt,
    kind,
    preview,
  ];
  if (task.hasPendingHumanInput === undefined && values.every((value) => value === undefined)) {
    return null;
  }
  if (
    task.hasPendingHumanInput !== true ||
    typeof pendingCount !== "number" ||
    !Number.isSafeInteger(pendingCount) ||
    pendingCount < 1 ||
    pendingCount > MAX_RUN_INTERACTION_VIEWS ||
    typeof oldestRequestedAt !== "number" ||
    !Number.isSafeInteger(oldestRequestedAt) ||
    oldestRequestedAt < 0 ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= oldestRequestedAt ||
    typeof latestExpiresAt !== "number" ||
    !Number.isSafeInteger(latestExpiresAt) ||
    latestExpiresAt < expiresAt ||
    (kind !== "approval" && kind !== "user_input") ||
    typeof preview !== "string" ||
    preview.length === 0 ||
    LINE_BREAK_PATTERN.test(preview) ||
    utf8Length(preview) > MAX_HUMAN_INPUT_PREVIEW_BYTES
  ) {
    return undefined;
  }
  return {
    pendingCount,
    oldestRequestedAt,
    expiresAt,
    latestExpiresAt,
    kind,
    preview,
  };
}
