import { z } from "@hra-internal/schema";

import {
  dispatchEventIdSchema,
  positiveGenerationSchema,
} from "./identifiers";

export const MAX_RUN_EVENT_BATCH = 25;
export const MAX_RUN_EVENTS = 100;
export const MAX_RUN_EVENTS_VIEW = MAX_RUN_EVENTS;
export const MAX_NONTERMINAL_RUN_EVENTS = 96;
export const MAX_RUN_DISPLAY_EVENTS = 64;
export const MAX_RUN_REASONING_SUMMARY_EVENTS = 40;
export const MAX_RUN_TOOL_ACTIVITY_EVENTS = 16;
export const MAX_RUN_DISPLAY_TEXT_UTF8_BYTES = 2_048;

export const publicRunStatusEventKindSchema = z.enum([
  "run.queued",
  "worktree.preparing",
  "worktree.ready",
  "codex.starting",
  "codex.running",
  "codex.planning",
  "codex.editing",
  "codex.testing",
  "codex.waiting_for_approval",
  "codex.waiting_for_input",
  "run.submitted",
  "run.failed",
  "run.cancelled",
  "run.lease_lost",
  "codex.tool_activity.started",
  "codex.tool_activity.completed",
]);
export const publicRunTextEventKindSchema = z.enum([
  "codex.reasoning_summary.delta",
  "codex.assistant_message.delta",
]);
export const publicRunEventKindSchema = z.enum([
  ...publicRunStatusEventKindSchema.options,
  ...publicRunTextEventKindSchema.options,
]);
export type PublicRunEventKind = z.infer<typeof publicRunEventKindSchema>;

function hasOnlyDisplayTextControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127)
    ) return false;
  }
  return true;
}

export const runDisplayTextSchema = z.string().min(1)
  .refine(hasOnlyDisplayTextControls, "display text contains a disallowed control character")
  .refine(
    (value) => new TextEncoder().encode(value).length <= MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
    `display text exceeds ${MAX_RUN_DISPLAY_TEXT_UTF8_BYTES} UTF-8 bytes`,
  );

const runEventIdentityShape = {
  id: dispatchEventIdSchema,
  sequence: positiveGenerationSchema,
} as const;

export const publicRunEventSchema = z.union([
  z.object({
    ...runEventIdentityShape,
    kind: publicRunStatusEventKindSchema,
  }).strict(),
  z.object({
    ...runEventIdentityShape,
    kind: publicRunTextEventKindSchema,
    displayText: runDisplayTextSchema,
  }).strict(),
]);
export type PublicRunEvent = z.infer<typeof publicRunEventSchema>;

export const runPhaseSchema = z.enum([
  "queued",
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "submitted",
  "failed",
  "cancel_requested",
  "cancelled",
  "ambiguous",
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const runEventViewSchema = z.union([
  z.object({
    ...runEventIdentityShape,
    kind: publicRunStatusEventKindSchema,
    observedAt: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    ...runEventIdentityShape,
    kind: publicRunTextEventKindSchema,
    displayText: runDisplayTextSchema,
    observedAt: z.number().int().nonnegative().safe(),
  }).strict(),
]);
export type RunEventView = z.infer<typeof runEventViewSchema>;

const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  "submitted",
  "failed",
  "cancelled",
  "ambiguous",
]);

export const FAIL_CLOSED_TASK_DISPATCH_PHASES = [
  "queued",
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "cancel_requested",
  "ambiguous",
] as const satisfies readonly RunPhase[];

export function isTerminalRunPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function taskDispatchBlocksTaskRelease(phase: RunPhase): boolean {
  return FAIL_CLOSED_TASK_DISPATCH_PHASES.some((blocked) => blocked === phase);
}

export const AMBIGUOUS_DISPATCH_RESOLUTION_REASONS = [
  "confirmed_cancelled",
  "declared_failed",
] as const;
export type AmbiguousDispatchResolutionReason =
  (typeof AMBIGUOUS_DISPATCH_RESOLUTION_REASONS)[number];

export type DispatchHumanResolutionInput = Readonly<{
  sourcePhase: RunPhase;
  sourceSubmissionRejected: boolean;
  taskRevision: number;
  expectedTaskRevision: number;
  taskStatus: "open" | "in_progress" | "in_review" | "done" | "cancelled";
  taskHasCurrentClaim: boolean;
  sourceFenceMatches: boolean;
  anotherDispatchBlocksTask: boolean;
  sourceAlreadyRetried: boolean;
}>;

export function dispatchRetryAllowed(input: DispatchHumanResolutionInput): boolean {
  const sourceIsRetryable =
    input.sourcePhase === "failed" ||
    input.sourcePhase === "cancelled" ||
    (
      input.sourcePhase === "submitted" &&
      input.sourceSubmissionRejected
    );
  return sourceIsRetryable &&
    input.taskRevision === input.expectedTaskRevision &&
    input.taskStatus === "open" &&
    !input.taskHasCurrentClaim &&
    input.sourceFenceMatches &&
    !input.anotherDispatchBlocksTask &&
    !input.sourceAlreadyRetried;
}

export function resolvedAmbiguousDispatchPhase(
  input: Omit<
    DispatchHumanResolutionInput,
    "sourceAlreadyRetried" | "sourceSubmissionRejected"
  >,
  reason: AmbiguousDispatchResolutionReason,
): "cancelled" | "failed" | null {
  if (
    input.sourcePhase !== "ambiguous" ||
    input.taskRevision !== input.expectedTaskRevision ||
    (
      input.taskStatus !== "in_progress"
      && input.taskStatus !== "cancelled"
    ) ||
    !input.taskHasCurrentClaim ||
    !input.sourceFenceMatches ||
    input.anotherDispatchBlocksTask
  ) return null;
  return reason === "confirmed_cancelled" ? "cancelled" : "failed";
}

/** Converts a bounded semantic event into its next public phase. */
export function nextRunPhase(
  phase: RunPhase,
  desiredState: "run" | "stop",
  kind: PublicRunEventKind,
): RunPhase | null {
  if (isTerminalRunPhase(phase) || phase === "queued") return null;
  switch (kind) {
    case "run.queued":
      return phase;
    case "worktree.preparing":
      return phase === "leased" || phase === "provisioning" ? "provisioning" : null;
    case "worktree.ready":
    case "codex.starting":
      return phase === "leased" || phase === "provisioning" || phase === "starting"
        ? "starting"
        : null;
    case "codex.running":
    case "codex.planning":
    case "codex.editing":
    case "codex.testing":
    case "codex.reasoning_summary.delta":
    case "codex.assistant_message.delta":
    case "codex.tool_activity.started":
    case "codex.tool_activity.completed":
      return phase === "leased" ||
          phase === "provisioning" ||
          phase === "starting" ||
          phase === "running" ||
          phase === "waiting"
        ? "running"
        : null;
    case "codex.waiting_for_approval":
    case "codex.waiting_for_input":
      return phase === "starting" || phase === "running" || phase === "waiting"
        ? "waiting"
        : null;
    case "run.submitted":
      return "submitted";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return desiredState === "stop" && phase === "cancel_requested" ? "cancelled" : null;
    case "run.lease_lost":
      return "ambiguous";
  }
}

export interface RunDisplayBudget {
  readonly displayEvents: number;
  readonly reasoningSummaryEvents: number;
  readonly toolActivityEvents: number;
}

export type RunDisplayBudgetCheck =
  | Readonly<{ kind: "accepted"; budget: RunDisplayBudget }>
  | Readonly<{ kind: "invalid_existing" }>
  | Readonly<{ kind: "invalid_event" }>
  | Readonly<{ kind: "limit_exceeded" }>;

interface SequencedRunEventKind {
  readonly sequence: number;
  readonly kind: PublicRunEventKind;
}

export function runDisplayBudgetAfterBatch(input: Readonly<{
  acceptedThroughSequence: number;
  existingEvents: readonly SequencedRunEventKind[];
  events: readonly SequencedRunEventKind[];
}>): RunDisplayBudgetCheck {
  if (
    !Number.isSafeInteger(input.acceptedThroughSequence) ||
    input.acceptedThroughSequence < 0 ||
    input.acceptedThroughSequence > MAX_RUN_EVENTS_VIEW ||
    input.existingEvents.length !== input.acceptedThroughSequence
  ) return { kind: "invalid_existing" };

  let budget: RunDisplayBudget = {
    displayEvents: 0,
    reasoningSummaryEvents: 0,
    toolActivityEvents: 0,
  };
  let toolActivityOpen = false;
  for (let index = 0; index < input.existingEvents.length; index += 1) {
    const event = input.existingEvents[index];
    if (event === undefined || event.sequence !== index + 1) {
      return { kind: "invalid_existing" };
    }
    const nextToolActivityOpen = toolActivityOpenAfter(toolActivityOpen, event);
    if (nextToolActivityOpen === null) return { kind: "invalid_existing" };
    toolActivityOpen = nextToolActivityOpen;
    const next = advanceRunDisplayBudget(budget, event.kind);
    if (next === null) return { kind: "invalid_existing" };
    budget = next;
  }
  for (const event of input.events) {
    if (event.sequence <= input.acceptedThroughSequence) continue;
    const nextToolActivityOpen = toolActivityOpenAfter(toolActivityOpen, event);
    if (nextToolActivityOpen === null) return { kind: "invalid_event" };
    toolActivityOpen = nextToolActivityOpen;
    const next = advanceRunDisplayBudget(budget, event.kind);
    if (next === null) return { kind: "limit_exceeded" };
    budget = next;
  }
  return { kind: "accepted", budget };
}

function toolActivityOpenAfter(
  open: boolean,
  event: SequencedRunEventKind,
): boolean | null {
  if (event.kind === "codex.tool_activity.started") {
    return open || event.sequence >= MAX_NONTERMINAL_RUN_EVENTS ? null : true;
  }
  if (event.kind === "codex.tool_activity.completed") return open ? false : null;
  if (!open) return false;
  if (
    event.kind === "codex.reasoning_summary.delta" ||
    event.kind === "codex.assistant_message.delta" ||
    event.kind === "run.submitted" ||
    event.kind === "run.failed" ||
    event.kind === "run.cancelled" ||
    event.kind === "run.lease_lost" ||
    event.sequence >= MAX_NONTERMINAL_RUN_EVENTS
  ) return null;
  return true;
}

function advanceRunDisplayBudget(
  current: RunDisplayBudget,
  kind: PublicRunEventKind,
): RunDisplayBudget | null {
  const reasoningIncrement = kind === "codex.reasoning_summary.delta" ? 1 : 0;
  const toolIncrement = kind === "codex.tool_activity.started" ||
      kind === "codex.tool_activity.completed"
    ? 1
    : 0;
  const displayIncrement = reasoningIncrement > 0 ||
      kind === "codex.assistant_message.delta" ||
      toolIncrement > 0
    ? 1
    : 0;
  const next = {
    displayEvents: current.displayEvents + displayIncrement,
    reasoningSummaryEvents: current.reasoningSummaryEvents + reasoningIncrement,
    toolActivityEvents: current.toolActivityEvents + toolIncrement,
  };
  return next.displayEvents <= MAX_RUN_DISPLAY_EVENTS &&
      next.reasoningSummaryEvents <= MAX_RUN_REASONING_SUMMARY_EVENTS &&
      next.toolActivityEvents <= MAX_RUN_TOOL_ACTIVITY_EVENTS
    ? next
    : null;
}

export function storedRunEventPayloadMatches(
  stored: Readonly<{ readonly kind: string; readonly displayText?: string }>,
  incoming: PublicRunEvent,
): boolean {
  if (stored.kind !== incoming.kind) return false;
  if (
    incoming.kind === "codex.reasoning_summary.delta" ||
    incoming.kind === "codex.assistant_message.delta"
  ) return stored.displayText === incoming.displayText;
  return stored.displayText === undefined;
}

const TERMINAL_EVENT_KINDS: ReadonlySet<PublicRunEventKind> = new Set([
  "run.submitted",
  "run.failed",
  "run.cancelled",
  "run.lease_lost",
]);

export function runEventSequenceAllowed(
  sequence: number,
  kind: PublicRunEventKind,
): boolean {
  return Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    sequence <= (
      TERMINAL_EVENT_KINDS.has(kind)
        ? MAX_RUN_EVENTS_VIEW
        : MAX_NONTERMINAL_RUN_EVENTS
    );
}

export function dispatchSubmissionInputRevisionMatches(
  currentReviewRevision: number,
  inputReviewRevision: number,
): boolean {
  return Number.isSafeInteger(currentReviewRevision) &&
    Number.isSafeInteger(inputReviewRevision) &&
    currentReviewRevision > 0 &&
    currentReviewRevision === inputReviewRevision;
}

export function contiguousEventBatch(input: {
  readonly acceptedThroughSequence: number;
  readonly events: readonly Readonly<{ id: string; sequence: number; kind: string }>[];
}): boolean {
  if (input.events.length === 0 || input.events.length > MAX_RUN_EVENT_BATCH) return false;
  const ids = new Set<string>();
  for (let index = 0; index < input.events.length; index += 1) {
    const event = input.events[index];
    if (event === undefined || event.sequence < 1 || ids.has(event.id)) return false;
    ids.add(event.id);
    const previous = input.events[index - 1];
    if (previous !== undefined && event.sequence !== previous.sequence + 1) return false;
  }
  const first = input.events[0];
  return first !== undefined && first.sequence <= input.acceptedThroughSequence + 1;
}
