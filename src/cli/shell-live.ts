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
import { terminalSafe } from "./render";

const livePageLimit = 100;
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
  state: z.literal("pending"),
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
}).passthrough();

type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

type PendingDelta = Readonly<{
  itemId: string;
  kind: "assistant" | "reasoning";
  text: string;
  truncated: boolean;
  turnId: string;
}>;

type RaceResult<T> =
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ error: unknown; kind: "error" }>
  | Readonly<{ kind: "value"; value: T }>;

export type ShellLiveDaemonCaller = (command: LocalCommand) => Promise<CommandResponse>;

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

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
  /\b(?:sk|re)_[A-Za-z0-9_-]{8,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{4,}/giu,
];

const boundedCharacters = (value: string, maximum: number): string => {
  const scalars = Array.from(value);
  if (scalars.length <= maximum) return value;
  return `${scalars.slice(0, Math.max(0, maximum - 14)).join("")} [truncated]`;
};

const safeLiveText = (
  value: string,
  maximum = liveDiagnosticMaximumCharacters,
  preserveLineFeeds = false,
): string => {
  let redacted = boundedCharacters(value, maximum);
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, "[protected]");
  }
  return terminalSafe(redactAbsolutePaths(redacted), preserveLineFeeds);
};

const indentedLiveText = (value: string): string =>
  safeLiveText(value, liveDeltaMaximumCharacters, true)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

const interactionLabel = (kind: PendingInteraction["kind"]): string => {
  switch (kind) {
    case "command_approval": return "command approval";
    case "file_change_approval": return "file change approval";
    case "permission_approval": return "permission approval";
    case "user_input": return "user input";
    case "mcp_elicitation": return "plugin input";
  }
};

const renderPendingInteraction = (interaction: PendingInteraction): string => [
  `Interaction required: ${interactionLabel(interaction.kind)} ${interaction.id}`,
  `  revision ${String(interaction.revision)}${interaction.blocking ? ", blocking" : ""}`,
  `  ${safeLiveText(interaction.display.summary)}`,
  "  Use /interactions to inspect it.",
].join("\n");

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
  #pendingDelta: PendingDelta | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #lastStatusSignature: string | null = null;
  readonly #seenInteractionStates = new Set<string>();

  constructor(write: (value: string) => void, coalesceMs: number) {
    this.#write = write;
    this.#coalesceMs = coalesceMs;
  }

  showInitialInteractions(interactions: readonly PendingInteraction[]): void {
    for (const interaction of interactions) this.#showInteraction(interaction);
  }

  acceptPage(page: SessionEventPage): void {
    if (page.gap !== null) {
      this.#flushDelta();
      this.#emit(`Live event gap: ${safeLiveText(page.gap.reason)}. Updates resume at the retained boundary.`);
    }
    for (const event of page.events) this.#acceptEvent(event);
  }

  close(): void {
    this.#flushDelta();
  }

  #acceptEvent(event: SessionEvent): void {
    const body = event.body;
    if (body.type === "assistant_delta" || body.type === "reasoning_summary_delta") {
      const kind = body.type === "assistant_delta" ? "assistant" : "reasoning";
      const pending = this.#pendingDelta;
      if (
        pending !== null
        && pending.kind === kind
        && pending.itemId === body.itemId
        && pending.turnId === body.turnId
      ) {
        const combined = boundedCharacters(pending.text + body.text, liveDeltaMaximumCharacters);
        this.#pendingDelta = {
          ...pending,
          text: combined,
          truncated: pending.truncated || combined.length < pending.text.length + body.text.length,
        };
      } else {
        this.#flushDelta();
        this.#pendingDelta = {
          itemId: body.itemId,
          kind,
          text: boundedCharacters(body.text, liveDeltaMaximumCharacters),
          truncated: body.text.length > liveDeltaMaximumCharacters,
          turnId: body.turnId,
        };
      }
      this.#scheduleDeltaFlush();
      return;
    }

    this.#flushDelta();
    if (body.type === "interaction_requested") {
      this.#showInteraction(interactionFromEvent(body));
      return;
    }
    if (body.type === "interaction_state") {
      const signature = `${body.interactionId}:${String(body.revision)}:${body.state}`;
      if (this.#seenInteractionStates.has(signature)) return;
      this.#rememberInteractionState(signature);
    }
    const rendered = renderNonDeltaEvent(event);
    if (rendered === null) return;
    const signature = `${body.type}:${rendered}`;
    if (signature === this.#lastStatusSignature) return;
    this.#lastStatusSignature = signature;
    this.#emit(rendered);
  }

  #showInteraction(interaction: PendingInteraction): void {
    const signature = `${interaction.id}:${String(interaction.revision)}:pending`;
    if (this.#seenInteractionStates.has(signature)) return;
    this.#rememberInteractionState(signature);
    this.#emit(renderPendingInteraction(interaction));
  }

  #rememberInteractionState(signature: string): void {
    if (this.#seenInteractionStates.size >= 256) this.#seenInteractionStates.clear();
    this.#seenInteractionStates.add(signature);
  }

  #scheduleDeltaFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushDelta();
    }, this.#coalesceMs);
    this.#flushTimer.unref();
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
      this.#write("\nLive updates unavailable: session status did not include a matching resumable event cursor.\n");
      return;
    }
    const controller = new AbortController();
    const presenter = new ShellLivePresenter(this.#write, this.#coalesceMs);
    presenter.showInitialInteractions(parsed.data.pendingInteractions);
    this.#controller = controller;
    this.#task = this.#observe({
      controller,
      cursor: parsed.data.eventStream.cursor,
      presenter,
      session: selection.session,
    });
  }

  async stop(): Promise<void> {
    const controller = this.#controller;
    const task = this.#task;
    this.#controller = null;
    this.#task = null;
    controller?.abort(new Error("Shell live observation stopped."));
    if (task !== null) await task;
  }

  async #observe(input: Readonly<{
    controller: AbortController;
    cursor: string;
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
      while (!signal.aborted) {
        const command: Extract<LocalCommand, { kind: "session.events" }> = {
          kind: "session.events",
          session: input.session,
          cursor,
          limit: livePageLimit,
          waitMs: this.#waitMs,
        };
        const raced = await raceWithAbort(
          Promise.resolve().then(async () => await this.#callDaemon(command)),
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
}
