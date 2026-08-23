import type { LocalCommand } from "../domain/contracts";
import {
  sessionEventPageSchema,
  type SessionEventPage,
} from "../domain/session-events";
import { safeJson, type Output } from "./render";

export type SessionEventPageFetcher = (
  command: Extract<LocalCommand, { kind: "session.events" }>,
  signal: AbortSignal,
) => Promise<unknown>;

export type SessionEventFollowResult = Readonly<{
  events: number;
  lastCursor: string | null;
  pages: number;
}>;

type SessionEventJsonlOutput = Pick<Output, "writeStdout" | "writeStdoutAsync">;

const nonAbortedSignal = new AbortController().signal;

const writeJsonlLine = async (
  output: SessionEventJsonlOutput,
  value: string,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Session event output was aborted.", "AbortError");
  }
  if (output.writeStdoutAsync !== undefined) {
    await output.writeStdoutAsync(value, signal);
    return;
  }
  output.writeStdout(value);
};

export const writeSessionEventPageJsonl = async (
  page: SessionEventPage,
  output: SessionEventJsonlOutput,
  signal: AbortSignal = nonAbortedSignal,
): Promise<void> => {
  if (page.gap !== null) {
    await writeJsonlLine(output, `${safeJson({
      version: 1,
      kind: "gap",
      sessionId: page.sessionId,
      requestedCursor: page.requestedCursor,
      retentionFloorCursor: page.retentionFloorCursor,
      observedThroughCursor: page.observedThroughCursor,
      gap: page.gap,
    })}\n`, signal);
  }
  for (const event of page.events) {
    await writeJsonlLine(output, `${safeJson({
      version: 1,
      kind: "event",
      sessionId: page.sessionId,
      event,
    })}\n`, signal);
  }
  await writeJsonlLine(output, `${safeJson({
    version: 1,
    kind: "checkpoint",
    sessionId: page.sessionId,
    nextCursor: page.nextCursor,
    retentionFloorCursor: page.retentionFloorCursor,
    observedThroughCursor: page.observedThroughCursor,
    eventCount: page.events.length,
  })}\n`, signal);
};

export const followSessionEvents = async (input: Readonly<{
  command: Extract<LocalCommand, { kind: "session.events" }>;
  fetchPage: SessionEventPageFetcher;
  maxPages?: number;
  output: SessionEventJsonlOutput;
  retryFetchError?: (
    error: unknown,
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  signal: AbortSignal;
  yieldAfterEmptyPage?: () => Promise<void>;
}>): Promise<SessionEventFollowResult> => {
  if (input.command.waitMs <= 0) {
    throw new Error("SESSION_EVENT_FOLLOW_REQUIRES_WAIT");
  }
  const maxPages = input.maxPages ?? Number.POSITIVE_INFINITY;
  if (!(maxPages === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxPages) && maxPages > 0))) {
    throw new Error("SESSION_EVENT_FOLLOW_PAGE_BOUND_INVALID");
  }
  const yieldAfterEmptyPage = input.yieldAfterEmptyPage
    ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
  let cursor = input.command.cursor ?? null;
  let pages = 0;
  let events = 0;
  let sessionId: string | null = null;
  let lastEvent: Readonly<{ sequence: number; streamEpoch: string }> | null = null;
  let consecutiveFailures = 0;
  while (!input.signal.aborted && pages < maxPages) {
    let rawPage: unknown;
    try {
      rawPage = await input.fetchPage({
        ...input.command,
        ...(cursor === null ? { cursor: undefined } : { cursor }),
      }, input.signal);
    } catch (error: unknown) {
      if (input.signal.reason !== undefined) break;
      consecutiveFailures = Math.min(consecutiveFailures + 1, 31);
      if (await input.retryFetchError?.(error, consecutiveFailures, input.signal)) continue;
      throw error;
    }
    consecutiveFailures = 0;
    const page = sessionEventPageSchema.parse(rawPage);
    if (sessionId !== null && page.sessionId !== sessionId) {
      throw new Error("SESSION_EVENT_FOLLOW_SESSION_CHANGED");
    }
    sessionId = page.sessionId;
    if (page.requestedCursor !== cursor) throw new Error("SESSION_EVENT_FOLLOW_CURSOR_MISMATCH");
    if ((page.events.length > 0 || page.gap !== null) && page.nextCursor === cursor) {
      throw new Error("SESSION_EVENT_FOLLOW_DID_NOT_ADVANCE");
    }
    const pageStreamEpoch = page.events[0]?.streamEpoch;
    for (const event of page.events) {
      if (event.sessionId !== page.sessionId) throw new Error("SESSION_EVENT_FOLLOW_SESSION_MISMATCH");
      if (pageStreamEpoch !== undefined && event.streamEpoch !== pageStreamEpoch) {
        throw new Error("SESSION_EVENT_FOLLOW_PAGE_STREAM_MISMATCH");
      }
      if (lastEvent !== null) {
        if (event.streamEpoch === lastEvent.streamEpoch && event.sequence <= lastEvent.sequence) {
          throw new Error("SESSION_EVENT_FOLLOW_ORDER_MISMATCH");
        }
        if (event.streamEpoch !== lastEvent.streamEpoch && page.gap === null) {
          throw new Error("SESSION_EVENT_FOLLOW_STREAM_CHANGED_WITHOUT_GAP");
        }
      }
      lastEvent = { sequence: event.sequence, streamEpoch: event.streamEpoch };
    }
    await writeSessionEventPageJsonl(page, input.output, input.signal);
    pages += 1;
    events += page.events.length;
    const didAdvance = page.nextCursor !== cursor;
    cursor = page.nextCursor;
    if (!didAdvance && page.events.length === 0 && page.gap === null) {
      await yieldAfterEmptyPage();
    }
  }
  return { events, lastCursor: cursor, pages };
};
