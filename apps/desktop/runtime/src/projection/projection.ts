import { isDeepStrictEqual } from "node:util";

import {
  chatAttachmentPaneProjectionSchema,
  chatMessageQueueProjectionSchema,
  chatPaneIdSchema,
  chatPaneProjectionSchema,
  chatPaneHarnessProjectionSchema,
  chatSnapshotSchema,
  harnessSnapshotSchema,
  runtimeDomainEventSchema,
  runtimeProtocolVersion,
  runtimeSnapshotSchema,
  type RuntimeEvent,
  type ChatAttachmentPaneProjection,
  type ChatMessageQueueProjection,
  type ChatPaneProjection,
  type ChatPaneHarnessProjection,
  type HarnessSnapshot,
  type RuntimeSnapshot,
  type RuntimeSnapshotResponse,
} from "../../../contracts/runtime";
import { runtimeEventDeliveryClass } from "../../../contracts/runtime-delivery";
import { nextRuntimeProjectionSequence } from "../../../contracts/runtime-projection";
import {
  type ProjectionEvent,
  reduceProjectionEvent,
  replayRuntimeEvent,
} from "./reducer";

/** Pinned Native SDK 0.5.3 `max_window_event_detail_bytes`. */
const runtimeWindowEventByteLimit = 8 * 1024;
/** Leave one KiB for transport evolution while remaining below Native's hard limit. */
export const runtimeEventByteCeiling = runtimeWindowEventByteLimit - 1024;
export const unsupportedServerRequestError = {
  code: -32601,
  message: "Unsupported app-server request",
} as const;

export interface RuntimeProjectionOptions {
  readonly maxQueuedEvents?: number;
  readonly maxQueuedBytes?: number;
  readonly maxEventBytes?: number;
  readonly onEventsAvailable?: () => void;
}

export interface AtomicSnapshotCapture {
  readonly response: RuntimeSnapshotResponse;
  /** Release only after the snapshot response has been handed to transport. */
  release(): void;
}

export class ProjectionBackpressureError extends Error {
  readonly capacity: number;
  readonly queued: number;
  readonly required: number;
  readonly byteCapacity: number;
  readonly queuedBytes: number;
  readonly requiredBytes: number;

  constructor(
    capacity: number,
    queued: number,
    required: number,
    byteCapacity: number,
    queuedBytes: number,
    requiredBytes: number,
  ) {
    super(
      `Runtime projection needs ${required} slot(s) and ${requiredBytes} byte(s) ` +
        `with ${queued}/${capacity} slots and ${queuedBytes}/${byteCapacity} bytes occupied`,
    );
    this.name = "ProjectionBackpressureError";
    this.capacity = capacity;
    this.queued = queued;
    this.required = required;
    this.byteCapacity = byteCapacity;
    this.queuedBytes = queuedBytes;
    this.requiredBytes = requiredBytes;
  }
}

export class ProjectionPayloadLimitError extends Error {
  readonly limit: number;
  readonly required: number;

  constructor(limit: number, required: number) {
    super(`Runtime event needs ${required} bytes within a ${limit}-byte event limit`);
    this.name = "ProjectionPayloadLimitError";
    this.limit = limit;
    this.required = required;
  }
}

interface QueuedEvent {
  readonly envelope: RuntimeEvent;
  readonly byteLength: number;
}

interface CapacityWait {
  readonly promise: Promise<number>;
  readonly resolve: (generation: number) => void;
}

export class RuntimeProjection {
  readonly #maxQueuedEvents: number;
  readonly #maxQueuedBytes: number;
  readonly #maxEventBytes: number;
  readonly #onEventsAvailable: () => void;
  #snapshot: RuntimeSnapshot;
  #events: QueuedEvent[] = [];
  #queuedBytes = 0;
  #captureToken: symbol | null = null;
  #bootstrapChatInstalled = false;
  #capacityGeneration = 0;
  #capacityWait: CapacityWait | null = null;

  constructor(initialSnapshot: RuntimeSnapshot, options: RuntimeProjectionOptions = {}) {
    this.#maxQueuedEvents = options.maxQueuedEvents ?? 512;
    this.#maxEventBytes = options.maxEventBytes ?? runtimeEventByteCeiling;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? this.#maxQueuedEvents * this.#maxEventBytes;
    if (!Number.isSafeInteger(this.#maxQueuedEvents) || this.#maxQueuedEvents < 1) {
      throw new RangeError("maxQueuedEvents must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.#maxEventBytes) ||
      this.#maxEventBytes < 1 ||
      this.#maxEventBytes > runtimeEventByteCeiling
    ) {
      throw new RangeError(`maxEventBytes must be between 1 and ${runtimeEventByteCeiling}`);
    }
    if (!Number.isSafeInteger(this.#maxQueuedBytes) || this.#maxQueuedBytes < 1) {
      throw new RangeError("maxQueuedBytes must be a positive safe integer");
    }
    this.#onEventsAvailable = options.onEventsAvailable ?? (() => undefined);
    this.#snapshot = runtimeSnapshotSchema.parse(initialSnapshot);
  }

  get queuedEventCount(): number {
    return this.#events.length;
  }

  get queuedByteCount(): number {
    return this.#queuedBytes;
  }

  get lastSequence(): number {
    return this.#snapshot.lastSequence;
  }

  /**
   * Monotonic clock for actual queue-capacity changes. Coordinators sample it
   * before a commit attempt so a drain racing waiter registration cannot be
   * missed.
   */
  get capacityGeneration(): number {
    return this.#capacityGeneration;
  }

  /**
   * Returns a detached read model without compacting, resequencing, or
   * draining renderer delivery. Local observation consumers must never gain
   * snapshot-transfer authority merely to inspect current semantic state.
   */
  observeSnapshot(): RuntimeSnapshot {
    return structuredClone(this.#snapshot);
  }

  /**
   * Wait for a drain or snapshot compaction to free queue capacity. The
   * projection owns no pending event data and all observers of one generation
   * share a single bounded promise.
   */
  waitForCapacityChange(observedGeneration: number): Promise<number> {
    if (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0) {
      return Promise.reject(new RangeError(
        "observed capacity generation must be a nonnegative safe integer",
      ));
    }
    if (this.#capacityGeneration !== observedGeneration) {
      return Promise.resolve(this.#capacityGeneration);
    }
    if (this.#capacityWait === null) {
      let resolve!: (generation: number) => void;
      const promise = new Promise<number>((resolvePromise) => {
        resolve = resolvePromise;
      });
      this.#capacityWait = { promise, resolve };
    }
    return this.#capacityWait.promise;
  }

  /**
   * Install durable chat panes before the gateway initialization barrier is
   * released. Persisted pane clocks are independent of the fresh transport
   * sequence, so boot restoration belongs in the first atomic snapshot rather
   * than pretending each pane is a revision-one live upsert.
   */
  installBootstrapChatState(
    panes: readonly ChatPaneProjection[],
  ): "installed" {
    if (this.#captureToken !== null) {
      throw new Error("Cannot install bootstrap chat state during snapshot capture");
    }
    if (
      this.#bootstrapChatInstalled ||
      this.#snapshot.chat.revision !== 1 ||
      this.#snapshot.chat.panes.length !== 0
    ) {
      throw new Error("Bootstrap chat state was already installed");
    }
    const chat = chatSnapshotSchema.parse({ revision: 1, panes });
    this.#snapshot = runtimeSnapshotSchema.parse({ ...this.#snapshot, chat });
    this.#bootstrapChatInstalled = true;
    return "installed";
  }

  /**
   * Install one complete renderer-safe harness view. Global proposals and
   * pane descendants are validated as a single snapshot before the renderer
   * is told to rehydrate, so an event can never expose half of an attachment.
   */
  installHarnessState(input: Readonly<{
    harness: HarnessSnapshot | null;
    panes: readonly Readonly<{
      paneId: string;
      harness: ChatPaneHarnessProjection | null;
    }>[];
  }>): void {
    if (this.#captureToken !== null) {
      throw new Error("Cannot install harness state during snapshot capture");
    }
    const harness = harnessSnapshotSchema.nullable().parse(
      structuredClone(input.harness),
    );
    const byPaneId = new Map<string, ChatPaneHarnessProjection | null>();
    for (const pane of input.panes) {
      if (byPaneId.has(pane.paneId)) {
        throw new RangeError(`Duplicate harness pane ${pane.paneId}`);
      }
      byPaneId.set(
        pane.paneId,
        chatPaneHarnessProjectionSchema.nullable().parse(
          structuredClone(pane.harness),
        ),
      );
    }
    for (const paneId of byPaneId.keys()) {
      if (!this.#snapshot.chat.panes.some(({ id }) => id === paneId)) {
        throw new RangeError(`Cannot decorate unknown chat pane ${paneId}`);
      }
    }
    assertHarnessAttachmentsExist(byPaneId, this.#snapshot.chat.panes);
    // The common reconciliation case should not reparse or copy bounded chat
    // transcript tails. Validate only the incoming harness boundary first,
    // then preserve the exact current snapshot reference when it is equal.
    if (harnessInputEqualsCurrent(harness, byPaneId, this.#snapshot)) return;
    const chat = chatSnapshotSchema.parse({
      ...this.#snapshot.chat,
      panes: this.#snapshot.chat.panes.map((pane) => ({
        ...pane,
        harness: byPaneId.get(pane.id) ?? null,
      })),
    });
    const installedSnapshot = runtimeSnapshotSchema.parse({
      ...this.#snapshot,
      chat,
      harness,
    });
    const prepared = this.#prepareCommit(
      { type: "snapshot.invalidated", reason: "harnessChanged" },
      installedSnapshot,
      this.#events.length,
      this.#queuedBytes,
    );
    this.#snapshot = prepared.snapshot;
    this.#events.push(prepared.queuedEvent);
    this.#queuedBytes = prepared.queuedBytes;
    if (this.#captureToken === null) this.#onEventsAvailable();
  }

  /**
   * Installs complete private-local queue text before publishing only its tiny
   * independent revision marker. The marker deliberately cannot reconstruct
   * message text, so every renderer that observes it must rehydrate.
   */
  installChatMessageQueueState(input: Readonly<{
    paneId: string;
    queue: ChatMessageQueueProjection;
    attachments: ChatAttachmentPaneProjection;
  }>): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const queue = chatMessageQueueProjectionSchema.parse(
      structuredClone(input.queue),
    );
    const attachments = chatAttachmentPaneProjectionSchema.parse(
      structuredClone(input.attachments),
    );
    const index = this.#snapshot.chat.panes.findIndex(({ id }) => id === paneId);
    if (index < 0) {
      throw new RangeError(`Cannot install a queue for unknown chat pane ${paneId}`);
    }
    const current = this.#snapshot.chat.panes[index]!;
    if (queue.revision < current.messageQueue.revision) {
      throw new RangeError(`Chat message queue ${paneId} regressed`);
    }
    if (queue.revision === current.messageQueue.revision) {
      if (
        !isDeepStrictEqual(queue, current.messageQueue) ||
        !isDeepStrictEqual(attachments, current.attachments)
      ) {
        throw new RangeError(
          `Chat message queue or attachment custody ${paneId} changed without advancing its revision`,
        );
      }
      return;
    }
    const pane = chatPaneProjectionSchema.parse({
      ...current,
      messageQueue: queue,
      attachments,
    });
    const panes = [...this.#snapshot.chat.panes];
    panes[index] = pane;
    const chat = chatSnapshotSchema.parse({
      revision: incrementProjectionRevision(
        this.#snapshot.chat.revision,
        "chat projection revision",
      ),
      panes,
    });
    const installedSnapshot = runtimeSnapshotSchema.parse({
      ...this.#snapshot,
      chat,
    });
    const prepared = this.#prepareCommit(
      { type: "chat.messageQueue.changed", paneId, revision: queue.revision },
      installedSnapshot,
      this.#events.length,
      this.#queuedBytes,
    );
    this.#snapshot = prepared.snapshot;
    this.#events.push(prepared.queuedEvent);
    this.#queuedBytes = prepared.queuedBytes;
    if (this.#captureToken === null) this.#onEventsAvailable();
  }

  /** Install path-free attachment metadata before asking renderers to rehydrate. */
  installChatAttachmentState(input: Readonly<{
    paneId: string;
    attachments: ChatAttachmentPaneProjection;
  }>): void {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const attachments = chatAttachmentPaneProjectionSchema.parse(
      structuredClone(input.attachments),
    );
    const index = this.#snapshot.chat.panes.findIndex(({ id }) => id === paneId);
    if (index < 0) {
      throw new RangeError(`Cannot install attachments for unknown chat pane ${paneId}`);
    }
    const current = this.#snapshot.chat.panes[index]!;
    if (isDeepStrictEqual(attachments, current.attachments)) return;
    const panes = [...this.#snapshot.chat.panes];
    panes[index] = chatPaneProjectionSchema.parse({ ...current, attachments });
    const chat = chatSnapshotSchema.parse({
      revision: incrementProjectionRevision(
        this.#snapshot.chat.revision,
        "chat projection revision",
      ),
      panes,
    });
    const installedSnapshot = runtimeSnapshotSchema.parse({
      ...this.#snapshot,
      chat,
    });
    const prepared = this.#prepareCommit(
      { type: "snapshot.invalidated", reason: "chatAttachmentsChanged" },
      installedSnapshot,
      this.#events.length,
      this.#queuedBytes,
    );
    this.#snapshot = prepared.snapshot;
    this.#events.push(prepared.queuedEvent);
    this.#queuedBytes = prepared.queuedBytes;
    if (this.#captureToken === null) this.#onEventsAvailable();
  }

  publish(event: ProjectionEvent): void {
    const validated = validateProjectionEvent(event);
    this.#commit(validated);
  }

  /**
   * Atomically install authoritative state that is too large for Native event
   * delivery, then queue only a bounded snapshot invalidation. The renderer
   * recovers the installed state through its next atomic snapshot.
   */
  installRecoverableState(event: ProjectionEvent): void {
    const validated = runtimeDomainEventSchema.parse(event);
    if (runtimeEventDeliveryClass(validated) !== "state-recoverable") {
      throw new TypeError(
        `Cannot install transient runtime event ${validated.type} without exact delivery`,
      );
    }
    const installedSnapshot = runtimeSnapshotSchema.parse(
      reduceProjectionEvent(this.#snapshot, validated),
    );
    const prepared = this.#prepareCommit(
      { type: "snapshot.invalidated", reason: "projectionOverflow" },
      installedSnapshot,
      this.#events.length,
      this.#queuedBytes,
    );
    this.#snapshot = prepared.snapshot;
    this.#events.push(prepared.queuedEvent);
    this.#queuedBytes = prepared.queuedBytes;
    if (this.#captureToken === null) this.#onEventsAvailable();
  }

  beginSnapshot(): AtomicSnapshotCapture {
    if (this.#captureToken !== null) throw new Error("A runtime snapshot capture is already active");
    const token = Symbol("runtime-snapshot-capture");
    this.#captureToken = token;
    try {
      const protectedEvents = this.#events.flatMap(({ envelope }) => (
        runtimeEventDeliveryClass(envelope.event) === "transient-exact"
          ? [envelope.event]
          : []
      ));
      const response: RuntimeSnapshotResponse = {
        version: runtimeProtocolVersion,
        snapshot: structuredClone(this.#snapshot),
      };
      const resequencedEvents: QueuedEvent[] = [];
      let resequencedSnapshot = this.#snapshot;
      let resequencedBytes = 0;
      for (const protectedEvent of protectedEvents) {
        const prepared = this.#prepareCommit(
          protectedEvent,
          resequencedSnapshot,
          resequencedEvents.length,
          resequencedBytes,
        );
        resequencedEvents.push(prepared.queuedEvent);
        resequencedSnapshot = prepared.snapshot;
        resequencedBytes = prepared.queuedBytes;
      }
      const capacityChanged = resequencedEvents.length < this.#events.length ||
        resequencedBytes < this.#queuedBytes;
      this.#events = resequencedEvents;
      this.#snapshot = resequencedSnapshot;
      this.#queuedBytes = resequencedBytes;
      if (capacityChanged) this.#notifyCapacityChanged();
      let released = false;
      return {
        response,
        release: () => {
          if (released) return;
          released = true;
          if (this.#captureToken === token) this.#captureToken = null;
          if (this.#events.length > 0) this.#onEventsAvailable();
        },
      };
    } catch (error: unknown) {
      this.#captureToken = null;
      throw error;
    }
  }

  drainEvents(limit = Number.MAX_SAFE_INTEGER): RuntimeEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("event drain limit must be a nonnegative safe integer");
    }
    if (this.#captureToken !== null || limit === 0) return [];
    const drained = this.#events.splice(0, limit);
    const envelopes: RuntimeEvent[] = [];
    for (const queued of drained) {
      this.#queuedBytes -= queued.byteLength;
      envelopes.push(queued.envelope);
    }
    if (drained.length > 0) this.#notifyCapacityChanged();
    return envelopes;
  }

  #notifyCapacityChanged(): void {
    this.#capacityGeneration += 1;
    const generation = this.#capacityGeneration;
    const waiter = this.#capacityWait;
    this.#capacityWait = null;
    waiter?.resolve(generation);
  }

  #commit(event: ProjectionEvent): void {
    const prepared = this.#prepareCommit(
      event,
      this.#snapshot,
      this.#events.length,
      this.#queuedBytes,
    );
    this.#snapshot = prepared.snapshot;
    this.#events.push(prepared.queuedEvent);
    this.#queuedBytes = prepared.queuedBytes;
    if (this.#captureToken === null) this.#onEventsAvailable();
  }

  #prepareCommit(
    event: ProjectionEvent,
    snapshot: RuntimeSnapshot,
    queuedEventCount: number,
    queuedBytes: number,
  ): Readonly<{
    queuedEvent: QueuedEvent;
    queuedBytes: number;
    snapshot: RuntimeSnapshot;
  }> {
    const sequence = nextRuntimeProjectionSequence(snapshot);
    const envelope: RuntimeEvent = { version: runtimeProtocolVersion, sequence, event };
    const byteLength = encodedBytes(envelope);
    if (byteLength > this.#maxEventBytes) {
      throw new ProjectionPayloadLimitError(this.#maxEventBytes, byteLength);
    }
    if (
      queuedEventCount + 1 > this.#maxQueuedEvents ||
      queuedBytes > this.#maxQueuedBytes - byteLength
    ) {
      throw new ProjectionBackpressureError(
        this.#maxQueuedEvents,
        queuedEventCount,
        1,
        this.#maxQueuedBytes,
        queuedBytes,
        byteLength,
      );
    }
    return {
      queuedEvent: { envelope, byteLength },
      queuedBytes: queuedBytes + byteLength,
      snapshot: replayRuntimeEvent(snapshot, envelope),
    };
  }
}

function harnessInputEqualsCurrent(
  harness: HarnessSnapshot | null,
  byPaneId: ReadonlyMap<string, ChatPaneHarnessProjection | null>,
  current: RuntimeSnapshot,
): boolean {
  return isDeepStrictEqual(harness, current.harness) &&
    current.chat.panes.every((pane) => isDeepStrictEqual(
      byPaneId.get(pane.id) ?? null,
      pane.harness,
    ));
}

function assertHarnessAttachmentsExist(
  byPaneId: ReadonlyMap<string, ChatPaneHarnessProjection | null>,
  panes: RuntimeSnapshot["chat"]["panes"],
): void {
  const paneIds = new Set(panes.map(({ id }) => id));
  for (const [paneId, harness] of byPaneId) {
    for (const child of harness?.descendants.children ?? []) {
      if (child.openedPaneId !== null && !paneIds.has(child.openedPaneId)) {
        throw new RangeError(
          `Harness pane ${paneId} references unknown pane ${child.openedPaneId}`,
        );
      }
    }
  }
}

function validateProjectionEvent(event: ProjectionEvent): ProjectionEvent {
  return runtimeDomainEventSchema.parse(event);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function incrementProjectionRevision(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) || value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(`${label} exhausted`);
  }
  return value + 1;
}
