import { z } from "zod";

import { redactAbsolutePaths } from "../cloud/contracts";
import type { CommandResponse, LocalCommand } from "../domain/contracts";
import {
  sessionEventPageSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventPage,
} from "../domain/session-events";
import { sessionIdSchema } from "../domain/values";
import { StreamingSensitiveRedactor } from "../streaming-sensitive-text";
import { terminalSafe } from "./render";

export { StreamingSensitiveRedactor };

const liveRedactorStreamLimit = 32;
const liveTrustedItemLimit = 128;

const livePageLimit = 100;
const liveInteractionPageLimit = 100;
const liveInteractionPageCeiling = 128;
const liveInteractionItemCeiling = 10_000;
const liveWaitMs = 1_000;
const liveEmptyPageDelayMs = 25;
const liveCoalesceMs = 35;
const liveDeltaMaximumCharacters = 8 * 1_024;
const liveDiagnosticMaximumCharacters = 2_048;
const liveRetryLimit = 5;

const interactionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
]);

const pendingInteractionSchema = z.object({
  id: z.string().uuid(),
  kind: interactionKindSchema,
  state: z.enum(["pending", "response_prepared", "response_written"]),
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: z.object({
    summary: z.string().max(2_048),
  }).passthrough(),
}).passthrough();

const shellLiveStatusSchema = z.object({
  session: z.object({ id: sessionIdSchema }).passthrough(),
  eventStream: z.object({
    cursor: z.string().min(1).max(2_048),
  }).passthrough(),
  pendingInteractions: z.array(pendingInteractionSchema).max(100),
  pendingInteractionsNextCursor: z.string().min(1).max(2_048).nullable(),
}).passthrough();

const shellLiveInteractionPageSchema = z.object({
  sessionId: sessionIdSchema,
  interactions: z.array(pendingInteractionSchema).max(liveInteractionPageLimit),
  nextCursor: z.string().min(1).max(2_048).nullable(),
}).strict();

type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

type PendingDelta = Readonly<{
  itemId: string;
  kind: "assistant" | "reasoning";
  summaryPart: number | null;
  text: string;
  truncated: boolean;
  turnId: string;
}>;

type ActiveDeltaStream = Readonly<{
  itemId: string;
  kind: PendingDelta["kind"];
  redactor: StreamingSensitiveRedactor;
  summaryPart: number | null;
  turnId: string;
}>;

type RaceResult<T> =
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ error: unknown; kind: "error" }>
  | Readonly<{ kind: "value"; value: T }>;

export type ShellLiveDaemonCaller = (
  command: LocalCommand,
  signal?: AbortSignal,
) => Promise<CommandResponse>;

export type ShellLiveObserverInput = Readonly<{
  callDaemon: ShellLiveDaemonCaller;
  write: (value: string) => void;
  coalesceMs?: number;
  emptyPageDelayMs?: number;
  retryLimit?: number;
  startDelayMs?: number;
  waitMs?: number;
}>;

export type ShellLiveSelection = Readonly<{
  session: string;
  statusData: unknown;
}>;

const boundedCharacters = (
  value: string,
  maximum: number,
): Readonly<{ text: string; truncated: boolean }> => {
  const scalars = Array.from(value);
  if (scalars.length <= maximum) return { text: value, truncated: false };
  return {
    text: `${scalars.slice(0, Math.max(0, maximum - 14)).join("")} [truncated]`,
    truncated: true,
  };
};

const sanitizeNonSecretLiveText = (value: string, preserveLineFeeds: boolean): string =>
  terminalSafe(redactAbsolutePaths(value), preserveLineFeeds);

const sanitizeCompleteLiveText = (value: string, preserveLineFeeds: boolean): string => {
  const redactor = new StreamingSensitiveRedactor();
  return sanitizeNonSecretLiveText(redactor.push(value, true), preserveLineFeeds);
};

const deltaItemKey = (turnId: string, itemId: string): string =>
  JSON.stringify([turnId, itemId]);

const safeLiveText = (
  value: string,
  maximum = liveDiagnosticMaximumCharacters,
  preserveLineFeeds = false,
): string => {
  const sanitized = sanitizeCompleteLiveText(value, preserveLineFeeds);
  return boundedCharacters(sanitized, maximum).text;
};

const indentedLiveText = (value: string): string =>
  value.split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

const interactionLabel = (kind: PendingInteraction["kind"]): string => {
  switch (kind) {
    case "command_approval": return "command approval";
    case "file_change_approval": return "file change approval";
    case "permission_approval": return "permission approval";
    case "user_input": return "user input";
    case "mcp_elicitation": return "MCP form input";
  }
};

const renderPendingInteraction = (interaction: PendingInteraction): string => {
  const detail = [
    `  revision ${String(interaction.revision)}${interaction.blocking ? ", blocking" : ""}`,
    `  ${safeLiveText(interaction.display.summary)}`,
  ];
  if (interaction.state === "pending") {
    return [
      `Interaction required: ${interactionLabel(interaction.kind)} ${interaction.id}`,
      ...detail,
      "  Use /interactions to inspect it.",
    ].join("\n");
  }
  return [
    `Interaction in progress: ${interactionLabel(interaction.kind)} ${interaction.id}`,
    ...detail,
    interaction.state === "response_prepared"
      ? "  A response is prepared. Do not resubmit it."
      : "  The response was sent and is awaiting provider acknowledgement. Do not resubmit it.",
  ].join("\n");
};

const interactionFromEvent = (
  body: Extract<SessionEventBody, { type: "interaction_requested" }>,
): PendingInteraction => ({
  id: body.interactionId,
  kind: body.interactionKind,
  state: "pending",
  revision: body.revision,
  blocking: body.blocking,
  display: { summary: body.summary },
});

const renderNonDeltaEvent = (event: SessionEvent): string | null => {
  const body = event.body;
  switch (body.type) {
    case "assistant_delta":
    case "reasoning_summary_delta": return null;
    case "connection": return body.state === "disconnected"
      ? `Live connection: disconnected${body.reason === undefined ? "" : ` (${safeLiveText(body.reason)})`}`
      : null;
    case "gap": return `Live event gap: ${safeLiveText(body.reason)}.`;
    case "session_status": return `Session: ${safeLiveText(body.status)}.`;
    case "turn_started": return "Turn started.";
    case "turn_completed": return `Turn ${safeLiveText(body.status)}${body.errorCode === undefined ? "." : ` (${safeLiveText(body.errorCode)}).`}`;
    case "item_started": return `Item started: ${safeLiveText(body.itemKind)}.`;
    case "item_completed": return `Item completed: ${safeLiveText(body.itemKind)}${body.status === undefined ? "." : ` (${safeLiveText(body.status)}).`}`;
    case "tool_progress": return `Tool: ${safeLiveText(body.toolKind)}${body.status === undefined ? "." : `, ${safeLiveText(body.status)}.`}`;
    case "file_change": return `Files: ${safeLiveText(body.status)}, ${String(body.paths.length)} visible change${body.paths.length === 1 ? "" : "s"}${body.omittedPaths === 0 ? "." : `, ${String(body.omittedPaths)} omitted.`}`;
    case "plan_updated": return `Plan updated: ${String(body.steps.length)} step${body.steps.length === 1 ? "" : "s"}.`;
    case "diff_updated": return `Diff updated: ${String(body.changedFiles)} file${body.changedFiles === 1 ? "" : "s"}.`;
    case "token_usage": return null;
    case "interaction_requested": return renderPendingInteraction(interactionFromEvent(body));
    case "interaction_state": return `Interaction ${body.interactionId}: ${safeLiveText(body.state)}, revision ${String(body.revision)}.`;
    case "warning": return `Warning ${safeLiveText(body.code)}: ${safeLiveText(body.message)}`;
    case "error": return `Error ${safeLiveText(body.code)}${body.terminal ? " (terminal)" : ""}: ${safeLiveText(body.message)}`;
    case "protocol_incompatible": return `Protocol notice: unsupported ${safeLiveText(body.method)}.`;
  }
};

const waitFor = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
};

const raceWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<RaceResult<T>> => {
  if (signal.aborted) return { kind: "aborted" };
  return await new Promise<RaceResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: RaceResult<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => finish({ kind: "aborted" });
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ error, kind: "error" }),
    );
  });
};

class ShellLivePresenter {
  readonly #write: (value: string) => void;
  readonly #coalesceMs: number;
  readonly #deltaStreams = new Map<string, ActiveDeltaStream>();
  readonly #trustedDeltaItems = new Map<string, Readonly<{ itemId: string; turnId: string }>>();
  #deltaRedactionQuarantined = false;
  #unknownDeltaNoticeWritten = false;
  #pendingDelta: PendingDelta | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #lastRenderedEventIdentity: string | null = null;
  readonly #seenInteractionRevisions = new Map<string, number>();

  constructor(write: (value: string) => void, coalesceMs: number) {
    this.#write = write;
    this.#coalesceMs = coalesceMs;
  }

  showInitialInteractions(interactions: readonly PendingInteraction[]): void {
    for (const interaction of interactions) this.#showInteraction(interaction);
  }

  acceptPage(page: SessionEventPage): void {
    if (page.gap !== null) {
      this.#discardDeltaStreams(
        "Live delta tail omitted at the event gap because its redaction boundary was incomplete.",
      );
      this.#trustedDeltaItems.clear();
      this.#deltaRedactionQuarantined = false;
      this.#unknownDeltaNoticeWritten = false;
      this.#emit(`Live event gap: ${safeLiveText(page.gap.reason)}. Updates resume at the retained boundary.`);
    }
    for (const event of page.events) this.#acceptEvent(event);
  }

  close(): void {
    this.#discardDeltaStreams(
      "Trailing live delta text omitted because observation ended before its redaction boundary completed.",
    );
    this.#trustedDeltaItems.clear();
  }

  #acceptEvent(event: SessionEvent): void {
    const body = event.body;
    if (body.type === "item_started") {
      this.#observeItemStart(body.turnId, body.itemId);
    }
    if (body.type === "assistant_delta" || body.type === "reasoning_summary_delta") {
      if (this.#deltaRedactionQuarantined) return;
      if (!this.#trustedDeltaItems.has(deltaItemKey(body.turnId, body.itemId))) {
        if (!this.#unknownDeltaNoticeWritten) {
          this.#unknownDeltaNoticeWritten = true;
          this.#emit(
            "Live delta text omitted until HRA observes a trustworthy item-start boundary.",
          );
        }
        return;
      }
      const kind = body.type === "assistant_delta" ? "assistant" : "reasoning";
      const summaryPart = body.type === "reasoning_summary_delta"
        ? body.summaryPart ?? null
        : null;
      const key = JSON.stringify([body.turnId, body.itemId, kind, summaryPart]);
      let stream = this.#deltaStreams.get(key);
      if (stream === undefined) {
        if (this.#deltaStreams.size >= liveRedactorStreamLimit) {
          this.#quarantineDeltaRedaction();
          return;
        }
        stream = {
          itemId: body.itemId,
          kind,
          redactor: new StreamingSensitiveRedactor(),
          summaryPart,
          turnId: body.turnId,
        };
        this.#deltaStreams.set(key, stream);
      }
      const sanitized = sanitizeNonSecretLiveText(stream.redactor.push(body.text), true);
      this.#appendDelta(stream, sanitized);
      return;
    }

    if (body.type === "gap") {
      this.#discardDeltaStreams(
        "Live delta tail omitted at the event gap because its redaction boundary was incomplete.",
      );
      this.#trustedDeltaItems.clear();
      this.#deltaRedactionQuarantined = false;
      this.#unknownDeltaNoticeWritten = false;
    } else if (body.type === "item_completed") {
      this.#finalizeDeltaStreams((stream) =>
        stream.itemId === body.itemId && stream.turnId === body.turnId);
      this.#trustedDeltaItems.delete(deltaItemKey(body.turnId, body.itemId));
    } else if (body.type === "turn_completed") {
      this.#finalizeDeltaStreams((stream) => stream.turnId === body.turnId);
      for (const [key, item] of this.#trustedDeltaItems) {
        if (item.turnId === body.turnId) this.#trustedDeltaItems.delete(key);
      }
    } else {
      this.#flushDelta();
    }
    if (body.type === "interaction_requested") {
      this.#showInteraction(interactionFromEvent(body));
      return;
    }
    if (body.type === "interaction_state") {
      if (!this.#observeInteractionRevision(body.interactionId, body.revision)) return;
    }
    const rendered = renderNonDeltaEvent(event);
    if (rendered === null) return;
    const identity = `${event.streamEpoch}:${String(event.sequence)}`;
    if (identity === this.#lastRenderedEventIdentity) return;
    this.#lastRenderedEventIdentity = identity;
    this.#emit(rendered);
  }

  #showInteraction(interaction: PendingInteraction): void {
    if (!this.#observeInteractionRevision(interaction.id, interaction.revision)) return;
    this.#emit(renderPendingInteraction(interaction));
  }

  #observeInteractionRevision(id: string, revision: number): boolean {
    const observed = this.#seenInteractionRevisions.get(id);
    if (observed !== undefined && revision <= observed) return false;
    if (
      observed === undefined
      && this.#seenInteractionRevisions.size >= liveInteractionItemCeiling
    ) this.#seenInteractionRevisions.clear();
    this.#seenInteractionRevisions.set(id, revision);
    return true;
  }

  #scheduleDeltaFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushDelta();
    }, this.#coalesceMs);
    this.#flushTimer.unref();
  }

  #appendDelta(stream: ActiveDeltaStream, value: string): void {
    if (value.length === 0) return;
    const pending = this.#pendingDelta;
    if (pending !== null) {
      if (
        pending.kind !== stream.kind
        || pending.itemId !== stream.itemId
        || pending.summaryPart !== stream.summaryPart
        || pending.turnId !== stream.turnId
      ) {
        this.#flushDelta();
        this.#appendDelta(stream, value);
        return;
      }
      if (!pending.truncated) {
        const combined = boundedCharacters(pending.text + value, liveDeltaMaximumCharacters);
        this.#pendingDelta = { ...pending, ...combined };
      }
    } else {
      const bounded = boundedCharacters(value, liveDeltaMaximumCharacters);
      this.#pendingDelta = {
        itemId: stream.itemId,
        kind: stream.kind,
        summaryPart: stream.summaryPart,
        ...bounded,
        turnId: stream.turnId,
      };
    }
    this.#scheduleDeltaFlush();
  }

  #finalizeDeltaStreams(predicate: (stream: ActiveDeltaStream) => boolean): void {
    for (const [key, stream] of this.#deltaStreams) {
      if (!predicate(stream)) continue;
      this.#deltaStreams.delete(key);
      const tail = sanitizeNonSecretLiveText(stream.redactor.push("", true), true);
      if (tail.trim().length > 0) this.#appendDelta(stream, tail);
    }
    this.#flushDelta();
  }

  #quarantineDeltaRedaction(): void {
    this.#flushDelta();
    this.#deltaStreams.clear();
    this.#trustedDeltaItems.clear();
    this.#deltaRedactionQuarantined = true;
    this.#emit(
      "Live delta text paused because the bounded redaction state was exhausted. HRA will resume after a new item-start boundary or session reselection.",
    );
  }

  #observeItemStart(turnId: string, itemId: string): void {
    let discardedPriorState = false;
    for (const [key, stream] of this.#deltaStreams) {
      if (stream.turnId !== turnId || stream.itemId !== itemId) continue;
      this.#deltaStreams.delete(key);
      discardedPriorState = true;
    }
    if (discardedPriorState) {
      this.#flushDelta();
      this.#emit(
        "Live delta tail omitted because the provider repeated an item-start boundary.",
      );
    }
    if (this.#trustedDeltaItems.size >= liveTrustedItemLimit) this.#quarantineDeltaRedaction();
    this.#deltaRedactionQuarantined = false;
    this.#trustedDeltaItems.set(deltaItemKey(turnId, itemId), { itemId, turnId });
  }

  #discardDeltaStreams(notice: string): void {
    this.#flushDelta();
    if (this.#deltaStreams.size > 0) this.#emit(notice);
    this.#deltaStreams.clear();
  }

  #flushDelta(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const pending = this.#pendingDelta;
    this.#pendingDelta = null;
    if (pending === null) return;
    const label = pending.kind === "assistant" ? "Codex" : "Reasoning summary";
    this.#emit(`${label}\n${indentedLiveText(pending.text)}${pending.truncated ? "\n  [additional delta text omitted]" : ""}`);
  }

  #emit(value: string): void {
    this.#write(`\n${value}\n`);
  }
}

export class ShellLiveObserver {
  readonly #callDaemon: ShellLiveDaemonCaller;
  readonly #write: (value: string) => void;
  readonly #coalesceMs: number;
  readonly #emptyPageDelayMs: number;
  readonly #retryLimit: number;
  readonly #startDelayMs: number;
  readonly #waitMs: number;
  #controller: AbortController | null = null;
  #task: Promise<void> | null = null;

  constructor(input: ShellLiveObserverInput) {
    this.#callDaemon = input.callDaemon;
    this.#write = input.write;
    this.#coalesceMs = input.coalesceMs ?? liveCoalesceMs;
    this.#emptyPageDelayMs = input.emptyPageDelayMs ?? liveEmptyPageDelayMs;
    this.#retryLimit = input.retryLimit ?? liveRetryLimit;
    this.#startDelayMs = input.startDelayMs ?? 0;
    this.#waitMs = input.waitMs ?? liveWaitMs;
  }

  async select(selection: ShellLiveSelection): Promise<void> {
    await this.stop();
    const parsed = shellLiveStatusSchema.safeParse(selection.statusData);
    if (!parsed.success || parsed.data.session.id !== selection.session) {
      this.#safeWrite("\nLive updates unavailable: session status did not include a matching resumable event cursor.\n");
      return;
    }
    const controller = new AbortController();
    let displayFailed = false;
    const write = (value: string): void => {
      if (displayFailed) return;
      if (!this.#safeWrite(value)) {
        displayFailed = true;
        controller.abort(new Error("Shell live display is unavailable."));
      }
    };
    const presenter = new ShellLivePresenter(write, this.#coalesceMs);
    const initialInteractionIds = new Set<string>();
    for (const interaction of parsed.data.pendingInteractions) {
      if (initialInteractionIds.has(interaction.id)) {
        this.#safeWrite("\nLive updates unavailable: session status repeated a pending interaction.\n");
        return;
      }
      initialInteractionIds.add(interaction.id);
    }
    presenter.showInitialInteractions(parsed.data.pendingInteractions);
    this.#controller = controller;
    this.#task = this.#observe({
      controller,
      cursor: parsed.data.eventStream.cursor,
      initialInteractionIds,
      interactionCursor: parsed.data.pendingInteractionsNextCursor,
      presenter,
      session: parsed.data.session.id,
    }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const controller = this.#controller;
    const task = this.#task;
    this.#controller = null;
    this.#task = null;
    controller?.abort(new Error("Shell live observation stopped."));
    if (task !== null) {
      try {
        await task;
      } catch {
        // Live display is advisory and must never poison the foreground shell.
      }
    }
  }

  #safeWrite(value: string): boolean {
    try {
      this.#write(value);
      return true;
    } catch {
      return false;
    }
  }

  async #observe(input: Readonly<{
    controller: AbortController;
    cursor: string;
    initialInteractionIds: ReadonlySet<string>;
    interactionCursor: string | null;
    presenter: ShellLivePresenter;
    session: string;
  }>): Promise<void> {
    const signal = input.controller.signal;
    let cursor = input.cursor;
    let consecutiveFailures = 0;
    let failureNoticeWritten = false;
    let lastEvent: Readonly<{ sequence: number; streamEpoch: string }> | null = null;
    try {
      await waitFor(this.#startDelayMs, signal);
      const interactionsDrained = await this.#drainPendingInteractions({
        cursor: input.interactionCursor,
        initialInteractionIds: input.initialInteractionIds,
        presenter: input.presenter,
        session: input.session,
        signal,
      });
      if (!interactionsDrained) return;
      while (!signal.aborted) {
        const command: Extract<LocalCommand, { kind: "session.events" }> = {
          kind: "session.events",
          session: input.session,
          cursor,
          limit: livePageLimit,
          waitMs: this.#waitMs,
        };
        const raced = await raceWithAbort(
          Promise.resolve().then(async () => await this.#callDaemon(command, signal)),
          signal,
        );
        if (raced.kind === "aborted") break;
        if (raced.kind === "error" || !raced.value.ok) {
          consecutiveFailures += 1;
          if (!failureNoticeWritten) {
            this.#write("\nLive updates are temporarily unavailable; HRA is retrying in the background.\n");
            failureNoticeWritten = true;
          }
          if (consecutiveFailures >= this.#retryLimit) {
            this.#write("\nLive updates paused after repeated failures. Reselect the session to resume.\n");
            break;
          }
          await waitFor(Math.min(1_000, 25 * (2 ** (consecutiveFailures - 1))), signal);
          continue;
        }

        let page: SessionEventPage;
        try {
          page = sessionEventPageSchema.parse(raced.value.data);
          if (page.sessionId !== input.session) throw new Error("session changed");
          if (page.requestedCursor !== cursor) throw new Error("cursor mismatch");
          if ((page.events.length > 0 || page.gap !== null) && page.nextCursor === cursor) {
            throw new Error("cursor did not advance");
          }
          for (const event of page.events) {
            if (event.sessionId !== input.session) throw new Error("event session changed");
            if (lastEvent !== null) {
              if (event.streamEpoch === lastEvent.streamEpoch && event.sequence <= lastEvent.sequence) {
                throw new Error("event order changed");
              }
              if (event.streamEpoch !== lastEvent.streamEpoch && page.gap === null) {
                throw new Error("event stream changed without a gap");
              }
            }
            lastEvent = { sequence: event.sequence, streamEpoch: event.streamEpoch };
          }
        } catch {
          this.#write("\nLive updates paused because the daemon returned an invalid event page. Reselect the session to resume.\n");
          break;
        }

        consecutiveFailures = 0;
        failureNoticeWritten = false;
        input.presenter.acceptPage(page);
        const advanced = page.nextCursor !== cursor;
        cursor = page.nextCursor;
        if (!advanced && page.events.length === 0 && page.gap === null) {
          await waitFor(this.#emptyPageDelayMs, signal);
        }
      }
    } finally {
      input.presenter.close();
    }
  }

  async #drainPendingInteractions(input: Readonly<{
    cursor: string | null;
    initialInteractionIds: ReadonlySet<string>;
    presenter: ShellLivePresenter;
    session: string;
    signal: AbortSignal;
  }>): Promise<boolean> {
    let cursor = input.cursor;
    if (cursor === null) return true;
    const seen = new Set(input.initialInteractionIds);
    const seenCursors = new Set([cursor]);
    let pageCount = 0;
    let itemCount = seen.size;
    const fail = (): false => {
      this.#write(
        "\nLive updates paused because HRA could not safely enumerate every pending interaction. Reselect the session to resume.\n",
      );
      return false;
    };
    while (cursor !== null && !input.signal.aborted) {
      if (pageCount >= liveInteractionPageCeiling || itemCount >= liveInteractionItemCeiling) {
        return fail();
      }
      const command: Extract<LocalCommand, { kind: "session.interactions" }> = {
        kind: "session.interactions",
        session: input.session,
        pending: true,
        limit: liveInteractionPageLimit,
        cursor,
      };
      const raced = await raceWithAbort(
        Promise.resolve().then(async () => await this.#callDaemon(command, input.signal)),
        input.signal,
      );
      if (raced.kind === "aborted") return false;
      if (raced.kind === "error" || !raced.value.ok) return fail();
      const parsed = shellLiveInteractionPageSchema.safeParse(raced.value.data);
      if (
        !parsed.success
        || parsed.data.sessionId !== input.session
        || (parsed.data.nextCursor !== null && seenCursors.has(parsed.data.nextCursor))
        || (parsed.data.interactions.length === 0 && parsed.data.nextCursor !== null)
      ) return fail();
      for (const interaction of parsed.data.interactions) {
        if (seen.has(interaction.id)) return fail();
        seen.add(interaction.id);
      }
      itemCount += parsed.data.interactions.length;
      if (itemCount > liveInteractionItemCeiling) return fail();
      input.presenter.showInitialInteractions(parsed.data.interactions);
      pageCount += 1;
      cursor = parsed.data.nextCursor;
      if (cursor !== null) seenCursors.add(cursor);
    }
    return !input.signal.aborted;
  }
}
