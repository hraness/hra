import type { LocalCommand } from "../domain/contracts";
import {
  WORK_EVENT_STREAM_LINE_MAX_BYTES,
  workEventPageSchema,
  type WorkEventPage,
} from "../domain/work";
import { safeJson, type Output } from "./render";

export type WorkEventPageFetcher = (
  command: Extract<LocalCommand, { kind: "work.events" }>,
  signal: AbortSignal,
) => Promise<unknown>;

export type WorkEventFollowResult = Readonly<{
  events: number;
  lastCursor: string | null;
  pages: number;
}>;

type WorkEventJsonlOutput = Pick<Output, "writeStdout" | "writeStdoutAsync">;

const defaultRetryLimit = 8;
const maximumRetryLimit = 31;
const nonAbortedSignal = new AbortController().signal;

const writeJsonlLine = async (
  output: WorkEventJsonlOutput,
  value: string,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Work event output was aborted.", "AbortError");
  }
  if (output.writeStdoutAsync !== undefined) {
    await output.writeStdoutAsync(value, signal);
    return;
  }
  output.writeStdout(value);
};

const boundedStreamLine = (value: unknown): string => {
  const line = `${safeJson(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > WORK_EVENT_STREAM_LINE_MAX_BYTES) {
    throw new Error("WORK_EVENT_STREAM_LINE_CAPACITY_EXCEEDED");
  }
  return line;
};

const validatedPageLines = (page: WorkEventPage): readonly string[] => {
  const lines: string[] = [];
  if (page.gap !== null) {
    lines.push(boundedStreamLine({
      version: 1,
      kind: "gap",
      workId: page.workId,
      streamEpoch: page.streamEpoch,
      requestedCursor: page.requestedCursor,
      retentionFloorCursor: page.retentionFloorCursor,
      observedThroughCursor: page.observedThroughCursor,
      gap: page.gap,
    }));
  }
  for (const event of page.events) {
    lines.push(boundedStreamLine({
      version: 1,
      kind: "event",
      workId: page.workId,
      event,
    }));
  }
  lines.push(boundedStreamLine({
    version: 1,
    kind: "checkpoint",
    workId: page.workId,
    streamEpoch: page.streamEpoch,
    nextCursor: page.nextCursor,
    retentionFloorCursor: page.retentionFloorCursor,
    observedThroughCursor: page.observedThroughCursor,
    eventCount: page.events.length,
  }));
  return lines;
};

const writeValidatedWorkEventPageJsonl = async (
  page: WorkEventPage,
  output: WorkEventJsonlOutput,
  signal: AbortSignal,
): Promise<void> => {
  const lines = validatedPageLines(page);
  for (const line of lines) await writeJsonlLine(output, line, signal);
};

const nextExpectedSequence = (
  priorExpectedSequence: number | null,
  page: WorkEventPage,
): number | null => {
  let expectedSequence = priorExpectedSequence;
  if (page.gap !== null) {
    if (
      expectedSequence !== null
      && page.gap.retainedFromSequence < expectedSequence
    ) {
      throw new Error("WORK_EVENT_FOLLOW_GAP_MOVED_BACKWARD");
    }
    expectedSequence = page.gap.retainedFromSequence;
  }
  for (const event of page.events) {
    if (expectedSequence !== null && event.sequence !== expectedSequence) {
      throw new Error("WORK_EVENT_FOLLOW_SEQUENCE_MISMATCH");
    }
    expectedSequence = event.sequence + 1;
  }
  return expectedSequence;
};

export const writeWorkEventPageJsonl = async (
  rawPage: unknown,
  output: WorkEventJsonlOutput,
  signal: AbortSignal = nonAbortedSignal,
): Promise<void> => {
  const page = workEventPageSchema.parse(rawPage);
  await writeValidatedWorkEventPageJsonl(page, output, signal);
};

export const followWorkEvents = async (input: Readonly<{
  command: Extract<LocalCommand, { kind: "work.events" }>;
  fetchPage: WorkEventPageFetcher;
  maxConsecutiveRetries?: number;
  maxPages?: number;
  output: WorkEventJsonlOutput;
  retryFetchError?: (
    error: unknown,
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  signal: AbortSignal;
  yieldAfterEmptyPage?: () => Promise<void>;
}>): Promise<WorkEventFollowResult> => {
  if (input.command.waitMs <= 0) throw new Error("WORK_EVENT_FOLLOW_REQUIRES_WAIT");

  const maxPages = input.maxPages ?? Number.POSITIVE_INFINITY;
  if (!(maxPages === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxPages) && maxPages > 0))) {
    throw new Error("WORK_EVENT_FOLLOW_PAGE_BOUND_INVALID");
  }

  const maxConsecutiveRetries = input.maxConsecutiveRetries
    ?? (input.retryFetchError === undefined ? 0 : defaultRetryLimit);
  if (
    !Number.isSafeInteger(maxConsecutiveRetries)
    || maxConsecutiveRetries < 0
    || maxConsecutiveRetries > maximumRetryLimit
  ) {
    throw new Error("WORK_EVENT_FOLLOW_RETRY_BOUND_INVALID");
  }

  const yieldAfterEmptyPage = input.yieldAfterEmptyPage
    ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
  let cursor = input.command.cursor ?? null;
  let pages = 0;
  let events = 0;
  let resolvedWorkId: typeof input.command.work | null = null;
  let streamEpoch: string | null = null;
  let expectedSequence: number | null = null;
  let consecutiveFailures = 0;

  while (!input.signal.aborted && pages < maxPages) {
    let rawPage: unknown;
    try {
      rawPage = await input.fetchPage({
        ...input.command,
        work: resolvedWorkId ?? input.command.work,
        ...(cursor === null ? { cursor: undefined } : { cursor }),
      }, input.signal);
    } catch (error: unknown) {
      if (input.signal.reason !== undefined) break;
      consecutiveFailures += 1;
      if (
        input.retryFetchError !== undefined
        && consecutiveFailures <= maxConsecutiveRetries
        && await input.retryFetchError(error, consecutiveFailures, input.signal)
      ) {
        continue;
      }
      throw error;
    }
    if (input.signal.reason !== undefined) break;
    consecutiveFailures = 0;

    const page = workEventPageSchema.parse(rawPage);
    if (resolvedWorkId === null) {
      if (page.workId !== input.command.work) {
        throw new Error("WORK_EVENT_FOLLOW_REQUEST_WORK_MISMATCH");
      }
      resolvedWorkId = page.workId;
    } else if (page.workId !== resolvedWorkId) {
      throw new Error("WORK_EVENT_FOLLOW_WORK_CHANGED");
    }
    if (streamEpoch === null) streamEpoch = page.streamEpoch;
    else if (page.streamEpoch !== streamEpoch) {
      throw new Error("WORK_EVENT_FOLLOW_STREAM_EPOCH_CHANGED");
    }
    if (page.requestedCursor !== cursor) {
      throw new Error("WORK_EVENT_FOLLOW_CURSOR_MISMATCH");
    }
    if ((page.events.length > 0 || page.gap !== null) && page.nextCursor === cursor) {
      throw new Error("WORK_EVENT_FOLLOW_DID_NOT_ADVANCE");
    }
    const followingExpectedSequence = nextExpectedSequence(expectedSequence, page);
    const didAdvance = page.nextCursor !== cursor;
    const unchangedEmptyPage = !didAdvance && page.events.length === 0 && page.gap === null;

    if (!unchangedEmptyPage) {
      await writeValidatedWorkEventPageJsonl(page, input.output, input.signal);
    }
    expectedSequence = followingExpectedSequence;
    pages += 1;
    events += page.events.length;
    cursor = page.nextCursor;
    if (unchangedEmptyPage) {
      await yieldAfterEmptyPage();
    }
  }

  return { events, lastCursor: cursor, pages };
};
