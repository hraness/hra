import {
  createDirectStore,
  createLogicalRuntime,
  renderUnknownReason,
  type DirectStore,
  type LogicalRuntime,
  type LogicalRuntimeSnapshot,
} from "@hraness/direct/core";
import {
  createDirectActivityScope,
  type DirectActivityLease,
  type DirectActivityScope,
  type DirectSessionContext,
} from "@hraness/direct/testing";
import {
  operationReceiptSchema,
  portableInvalidationSchema,
  syncDeviceIdSchema,
  taskDomain,
  type PortableInvalidation,
  type PortableTaskCommand,
} from "@hraness/agent-tasks-protocol";

import {
  parseRuntimeDispatchRequest,
  parseRuntimeProjectAddRequest,
  parseRuntimeSnapshotRequest,
  parseRuntimeTaskDispatchRequest,
  parseRuntimeTaskDispatchResponseForRequest,
  parseRuntimeTransportLifecycle,
  runtimeDispatchCommand,
  runtimeEventName,
  runtimeProjectAddCommand,
  runtimeProtocolVersion,
  runtimeSnapshotCommand,
  runtimeSnapshotResponseSchema,
  runtimeTransportLifecycleEventName,
  runtimeTransportHealthCommand,
  runtimeTransportRetryCommand,
  type AccountSummary,
  type ChatMessageQueueProjection,
  type ChatPaneProjection,
  type ChatQueuedMessageProjection,
  type ChatRootTurnRoutingProjection,
  type HarnessChildProjection,
  type HarnessSnapshot,
  type RetainedAccountLocalData,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
  type RuntimeEvent,
  type RuntimeHumanOrganization,
  type RuntimeHumanWorkspace,
  type RuntimeLocalPromotionProgress,
  type RuntimeProjectAddResult,
  type SessionSyncStatusProjection,
  type RuntimeSnapshot,
  type RuntimeSnapshotTransportResponse,
  type RuntimeTaskDispatchRequest,
  type RuntimeTaskDispatchResponse,
  type RuntimeTaskMutation,
  type RuntimeTaskMutationAttempt,
  type RuntimeTaskMutationReconciliation,
  type RuntimeTaskMutationResult,
  type RuntimeTransportLifecycle,
} from "../../contracts/runtime";
import { runtimeChatPaneStateChangedEvent } from "../../contracts/runtime-delivery";
import type { RuntimeTransport } from "../src/runtime-bridge";
import type { HRADirectRoute } from "./scenarios";
import {
  fixtureAccount,
  HRA_DIRECT_ACTIVE_DEADLINE,
  HRA_DIRECT_TIMESTAMP,
  parseHRADirectExpectedTaskCommand,
  parseHRADirectWorld,
  parseHRADirectTaskProjectionState,
  type HRADirectTaskProjectionState,
  type HRADirectWorld,
} from "./world";

const managedChatWorkspace = {
  mode: "managedWorktree",
  state: "ready",
  revision: 1,
  recoveryKind: null,
} as const;

function directRootTurnRouting(
  prompt: string,
  priorRouting: ChatRootTurnRoutingProjection | null,
): ChatRootTurnRoutingProjection {
  const normalized = prompt.trim().normalize("NFKC").toLowerCase();
  const continuation = /^(?:please\s+)?(?:continue(?:\s+(?:it|that|this))?|keep going|go ahead|proceed|do it|ship it|finish(?:\s+(?:it|that|this))?|apply(?:\s+(?:it|that|this))?|fix(?:\s+(?:it|that|this))?|same|yes|yep|ok(?:ay)?)[.!?…]*$/u
    .test(normalized);
  if (continuation && priorRouting !== null) {
    return {
      policyVersion: 1,
      classificationReason: "continuationInherited",
      workClass: priorRouting.workClass,
      requestedProfile: priorRouting.requestedProfile,
      selectedProfile: priorRouting.requestedProfile,
      profileFallbackReason: null,
      requestedServiceTier: priorRouting.requestedServiceTier,
      selectedServiceTier: priorRouting.requestedServiceTier,
      serviceTierFallbackReason: null,
    };
  }
  const wideResearch = /\b(?:research|survey|investigate)\b/u.test(normalized) &&
    /\b(?:across|ecosystem|landscape|literature|sources)\b/u.test(normalized);
  const largeChange = /\b(?:implement|refactor|rewrite|migrate|redesign)\b/u.test(normalized) &&
    /\b(?:across|architecture|codebase|feature|repository|system|throughout|whole)\b/u
      .test(normalized);
  const boundedLeaf = /\b(?:fix|rename|tweak|update)\b/u.test(normalized) &&
    /\b(?:button|copy|label|single file|string|text|tooltip|typo)\b/u.test(normalized);
  const classificationReason = continuation
    ? "continuationOrAmbiguous" as const
    : wideResearch
      ? "wideResearchCue" as const
      : largeChange
        ? "largeChangeCue" as const
        : boundedLeaf
          ? "boundedLeafCue" as const
          : "conservativeDefault" as const;
  const workClass = wideResearch
    ? "wideResearch" as const
    : largeChange
      ? "largeChange" as const
      : boundedLeaf
        ? "boundedLeaf" as const
        : "standard" as const;
  const requestedProfile = workClass === "boundedLeaf"
    ? "lunaMax" as const
    : workClass === "standard"
      ? "solMax" as const
      : "solUltra" as const;
  const requestedServiceTier = boundedLeaf || continuation
    ? "fast" as const
    : "standard" as const;
  return {
    policyVersion: 1,
    classificationReason,
    workClass,
    requestedProfile,
    selectedProfile: requestedProfile,
    profileFallbackReason: null,
    requestedServiceTier,
    selectedServiceTier: requestedServiceTier,
    serviceTierFallbackReason: null,
  };
}

interface InvocationRecord {
  readonly command: string;
  readonly payload: unknown;
}

const directSessionSyncDeviceId = syncDeviceIdSchema.parse(
  `syncdevice_${"d".repeat(32)}`,
);
const directSessionSyncRecoveryKit = `DIRECT-RECOVERY-KIT-${"R".repeat(64)}`;
const directSessionSyncRecoveryRevealId = `syncreveal_${"r".repeat(32)}`;

function recordedInvocationPayload(command: string, payload: unknown): unknown {
  if (
    command === runtimeDispatchCommand
    && typeof payload === "object"
    && payload !== null
    && "command" in payload
    && typeof payload.command === "object"
    && payload.command !== null
    && "type" in payload.command
    && payload.command.type === "sessionSync.recovery.import"
  ) {
    return structuredClone({
      ...payload,
      command: {
        ...payload.command,
        recoveryKit: "[redacted]",
      },
    });
  }
  return structuredClone(payload);
}

export interface HRADirectTransportSnapshot {
  readonly blockedNetworkRequests: number;
  readonly confirmedTransportGenerations: readonly number[];
  readonly cancelledScriptedEvents: number;
  readonly deliveredScriptedEvents: number;
  readonly disposed: boolean;
  readonly eventListeners: number;
  readonly eventScriptFailures: readonly string[];
  readonly invocations: readonly InvocationRecord[];
  readonly pendingSnapshotTransfers: number;
  readonly remainingScriptedEvents: number;
  readonly snapshotReads: number;
  readonly transportLifecycle: RuntimeTransportLifecycle;
}

export interface HRADirectTransportHarness {
  readonly transport: RuntimeTransport;
  readonly store: DirectStore<HRADirectWorld>;
  readonly logical: LogicalRuntime;
  readonly activity: DirectActivityScope;
  readonly dispose: () => void;
  readonly emitTaskStateInvalidation: (
    taskStateId: string,
    invalidation: PortableInvalidation,
  ) => void;
  readonly emitTransportLifecycle: (lifecycle: RuntimeTransportLifecycle) => void;
  readonly getSnapshot: () => HRADirectTransportSnapshot;
  readonly recordBlockedNetworkRequest: () => void;
}

interface SnapshotTransfer {
  readonly id: string;
  readonly chunks: readonly Uint8Array[];
  readonly snapshotRead: number;
}

interface MutationReplay {
  readonly commandFingerprint: string;
  readonly mutation: RuntimeTaskMutationResult;
}

interface DirectMutationAttempt {
  readonly fingerprint: string;
  readonly attempt: RuntimeTaskMutationAttempt;
  readonly boundCommandFingerprint?: string;
  readonly resolution?: RuntimeTaskMutationReconciliation["resolution"];
}

function required<T>(result: {
  readonly ok: true;
  readonly value: T;
} | {
  readonly ok: false;
  readonly error: { readonly message: string };
}): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Direct cannot fingerprint a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Direct cannot fingerprint a ${typeof value} value.`);
}

function semanticTaskCommandFingerprint(
  command: PortableTaskCommand | RuntimeTaskMutation,
): string {
  return canonicalJson(Object.fromEntries(
    Object.entries(command).filter(
      ([key]) => key !== "operationId" && key !== "authority",
    ),
  ));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function splitBytes(bytes: Uint8Array, chunkBytes: number): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkBytes)));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array([0x7b, 0x7d]));
  return chunks;
}

function transportLifecycleFromSnapshot(
  runtime: RuntimeSnapshot["runtime"],
): RuntimeTransportLifecycle {
  const generation = Math.max(1, runtime.generation);
  switch (runtime.state) {
    case "starting":
      return { version: 1, state: "starting", generation };
    case "ready":
      return { version: 1, state: "ready", generation };
    case "backingOff":
      return {
        version: 1,
        state: "backingOff",
        generation,
        attempt: runtime.attempt,
        retryAtUnixMilliseconds: Date.parse(runtime.retryAt),
      };
    case "failed":
      return {
        version: 1,
        state: "failed",
        generation,
        canRetry: runtime.canRestart,
        message: runtime.message,
      };
    case "stopped":
      return { version: 1, state: "stopped", generation };
  }
}

const hraDirectTransportDisposedError = new Error(
  "The HRA Direct transport has been disposed.",
);
hraDirectTransportDisposedError.name = "HRADirectTransportDisposedError";
Object.freeze(hraDirectTransportDisposedError);

type TrackedOutcome<Value> =
  | { readonly kind: "disposed" }
  | { readonly kind: "failed"; readonly reason: unknown }
  | { readonly kind: "value"; readonly value: Value };

class DeterministicRuntimeTransport {
  readonly #world: HRADirectWorld;
  readonly #logical: LogicalRuntime;
  readonly #activity: DirectActivityScope;
  readonly #activeLeases = new Set<DirectActivityLease>();
  readonly #eventAbort = new AbortController();
  readonly #listeners = new Set<(detail: unknown) => void>();
  readonly #transportLifecycleListeners = new Set<(detail: unknown) => void>();
  readonly #invocations: InvocationRecord[] = [];
  readonly #eventScriptFailures: string[] = [];
  readonly #transfers = new Map<string, SnapshotTransfer>();
  readonly #confirmedTransportGenerations = new Set<number>();
  readonly #disposal: Promise<void>;
  #resolveDisposal: () => void = () => undefined;
  #snapshot: RuntimeSnapshot;
  #ownedSnapshotOverride: RuntimeSnapshot | null = null;
  #taskState: HRADirectTaskProjectionState;
  readonly #consumedMutationTransitionIds = new Set<string>();
  readonly #promotions = new Map<string, RuntimeLocalPromotionProgress>();
  readonly #mutationReplays = new Map<string, MutationReplay>();
  readonly #mutationAttempts = new Map<string, DirectMutationAttempt>();
  readonly #mutationAttemptIdsByFingerprint = new Map<string, string>();
  #snapshotReads = 0;
  #nextTransfer = 1;
  #nextAccount = 1;
  #nextOrganization = 1;
  #nextSessionSyncScopeGeneration = 1;
  #activeRecoveryReveal: Readonly<{ readonly id: string; readonly revision: number }> | null = null;
  #humanOrganizations: RuntimeHumanOrganization[] = [{
    id: "organization-direct",
    name: "Direct HRA",
    role: "owner",
    status: "active",
    workosOrganizationId: "org_DIRECT",
  }];
  #humanWorkspaces: RuntimeHumanWorkspace[] = [{
    id: "workspace-direct",
    organizationId: "organization-direct",
    slug: "direct-hra",
    name: "Direct HRA",
    taskKeyPrefix: "DIR",
    roles: ["planner", "reviewer", "viewer"],
  }];
  #eventsStarted = false;
  #deliveredScriptedEvents = 0;
  #blockedNetworkRequests = 0;
  #disposed = false;
  #lifecycle = 1;
  #transportLifecycle: RuntimeTransportLifecycle = {
    version: 1,
    state: "ready",
    generation: 1,
  };

  constructor(
    world: HRADirectWorld,
    logical: LogicalRuntime,
    activity: DirectActivityScope,
  ) {
    this.#world = parseHRADirectWorld(world);
    this.#logical = logical;
    this.#activity = activity;
    this.#disposal = new Promise((resolve) => {
      this.#resolveDisposal = resolve;
    });
    const initial = this.#world.gateway.snapshots[0];
    if (initial === undefined) throw new Error("Direct requires one authoritative snapshot.");
    this.#snapshot = structuredClone(initial);
    if (initial.sessionSync.status.state === "active") {
      this.#nextSessionSyncScopeGeneration =
        initial.sessionSync.status.scopeGeneration + 1;
    }
    this.#transportLifecycle = transportLifecycleFromSnapshot(initial.runtime);
    const taskState = this.#world.task.states.find(
      ({ id }) => id === this.#world.task.initialStateId,
    );
    if (taskState === undefined) throw new Error("Direct requires an initial task state.");
    this.#taskState = parseHRADirectTaskProjectionState(taskState.projectionJson);
  }

  readonly transport: RuntimeTransport = {
    invoke: async (command, payload) => {
      this.#assertActive();
      return await this.#tracked("request", () => {
        this.#invocations.push({ command, payload: recordedInvocationPayload(command, payload) });
        if (command === runtimeSnapshotCommand) return this.#snapshotRequest(payload);
        if (command === runtimeDispatchCommand) return this.#dispatchRequest(payload);
        if (command === runtimeProjectAddCommand) return this.#projectAdd(payload);
        if (command === runtimeTransportHealthCommand) {
          return this.#confirmTransportHealth(payload);
        }
        if (command === runtimeTransportRetryCommand) {
          return this.#retryTransport();
        }
        throw new Error(`Direct received an unknown native command: ${command}`);
      });
    },
    on: (name, callback) => {
      this.#assertActive();
      if (name === runtimeTransportLifecycleEventName) {
        this.#transportLifecycleListeners.add(callback);
        return () => this.#transportLifecycleListeners.delete(callback);
      }
      if (name !== runtimeEventName) {
        throw new Error(`Direct received an unknown native event subscription: ${name}`);
      }
      this.#listeners.add(callback);
      return () => this.#listeners.delete(callback);
    },
  };

  getSnapshot(): HRADirectTransportSnapshot {
    const undelivered = this.#world.gateway.events.length - this.#deliveredScriptedEvents;
    return Object.freeze({
      blockedNetworkRequests: this.#blockedNetworkRequests,
      confirmedTransportGenerations: Object.freeze(
        [...this.#confirmedTransportGenerations].toSorted((left, right) => left - right),
      ),
      cancelledScriptedEvents: this.#disposed ? undelivered : 0,
      deliveredScriptedEvents: this.#deliveredScriptedEvents,
      disposed: this.#disposed,
      eventListeners: this.#listeners.size + this.#transportLifecycleListeners.size,
      eventScriptFailures: Object.freeze([...this.#eventScriptFailures]),
      invocations: Object.freeze(structuredClone(this.#invocations)),
      pendingSnapshotTransfers: this.#transfers.size,
      remainingScriptedEvents: this.#disposed ? 0 : undelivered,
      snapshotReads: this.#snapshotReads,
      transportLifecycle: structuredClone(this.#transportLifecycle),
    });
  }

  recordBlockedNetworkRequest(): void {
    if (!this.#disposed) this.#blockedNetworkRequests += 1;
  }

  emitTaskStateInvalidation(
    taskStateId: string,
    value: PortableInvalidation,
  ): void {
    this.#assertActive();
    const invalidation = portableInvalidationSchema.parse(value);
    const fixture = this.#world.task.states.find(({ id }) => id === taskStateId);
    if (fixture === undefined) {
      throw new Error(`Direct has no task projection state ${taskStateId}.`);
    }
    const nextTaskState = parseHRADirectTaskProjectionState(
      fixture.projectionJson,
    );
    this.#assertInvalidationState(nextTaskState, invalidation);
    this.#taskState = nextTaskState;
    this.#emitOwnedEvent({
      type: "task.invalidated",
      invalidation,
    }, this.#snapshot);
  }

  emitTransportLifecycle(value: RuntimeTransportLifecycle): void {
    this.#assertActive();
    const lifecycle = parseRuntimeTransportLifecycle(value);
    this.#transportLifecycle = lifecycle;
    for (const listener of this.#transportLifecycleListeners) {
      listener(structuredClone(lifecycle));
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle += 1;
    this.#listeners.clear();
    this.#transportLifecycleListeners.clear();
    this.#transfers.clear();
    this.#eventAbort.abort();
    this.#resolveDisposal();
    for (const lease of this.#activeLeases) {
      const released = lease.release();
      if (!released.ok) this.#eventScriptFailures.push(released.error.message);
    }
    this.#activeLeases.clear();
  }

  async #tracked<Value>(namespace: string, action: () => Value | Promise<Value>): Promise<Value> {
    this.#assertActive();
    const lifecycle = this.#lifecycle;
    const started = this.#activity.begin(namespace);
    if (!started.ok) throw new Error(started.error.message, { cause: started.error });
    const lease = started.value;
    this.#activeLeases.add(lease);
    if (!this.#isActive(lifecycle)) {
      this.#activeLeases.delete(lease);
      const released = lease.release();
      if (!released.ok) throw new Error(released.error.message, { cause: released.error });
      throw hraDirectTransportDisposedError;
    }

    let work: Promise<TrackedOutcome<Value>>;
    try {
      work = Promise.resolve(action()).then(
        (value): TrackedOutcome<Value> => ({ kind: "value", value }),
        (reason: unknown): TrackedOutcome<Value> => ({ kind: "failed", reason }),
      );
    } catch (reason) {
      work = Promise.resolve({ kind: "failed", reason });
    }

    const outcome = await Promise.race([
      work,
      this.#disposal.then((): TrackedOutcome<Value> => ({ kind: "disposed" })),
    ]);
    this.#activeLeases.delete(lease);
    const released = lease.release();
    if (!released.ok) throw new Error(released.error.message, { cause: released.error });
    if (outcome.kind === "disposed" || !this.#isActive(lifecycle)) {
      throw hraDirectTransportDisposedError;
    }
    if (outcome.kind === "failed") throw outcome.reason;
    return outcome.value;
  }

  #assertActive(): void {
    if (this.#disposed) throw hraDirectTransportDisposedError;
  }

  #isActive(lifecycle: number): boolean {
    return !this.#disposed && lifecycle === this.#lifecycle;
  }

  #retryTransport() {
    switch (this.#transportLifecycle.state) {
      case "ready":
        return { version: 1, status: "alreadyReady" } as const;
      case "starting":
      case "backingOff":
        return { version: 1, status: "accepted" } as const;
      case "failed":
        if (!this.#transportLifecycle.canRetry) {
          return { version: 1, status: "unavailable" } as const;
        }
        this.emitTransportLifecycle({
          version: 1,
          state: "backingOff",
          generation: this.#transportLifecycle.generation,
          attempt: 1,
          retryAtUnixMilliseconds: 1,
        });
        return { version: 1, status: "accepted" } as const;
      case "stopping":
      case "stopped":
        return { version: 1, status: "unavailable" } as const;
    }
  }

  #confirmTransportHealth(payload: unknown) {
    if (
      typeof payload !== "object"
      || payload === null
      || Array.isArray(payload)
      || Object.getPrototypeOf(payload) !== Object.prototype
      || Object.keys(payload).toSorted().join(",") !== "generation,version"
      || !("version" in payload)
      || payload.version !== 1
      || !("generation" in payload)
      || typeof payload.generation !== "number"
      || !Number.isSafeInteger(payload.generation)
      || payload.generation <= 0
    ) {
      throw new Error("Direct received an invalid transport health request.");
    }
    if (
      this.#transportLifecycle.state !== "ready"
      || payload.generation !== this.#transportLifecycle.generation
    ) {
      throw new Error("Direct transport generation is no longer current.");
    }
    this.#confirmedTransportGenerations.add(payload.generation);
    return {
      version: 1,
      generation: payload.generation,
      status: "accepted",
    } as const;
  }

  #assertInvalidationState(
    state: HRADirectTaskProjectionState,
    invalidation: PortableInvalidation,
  ): void {
    const workspace = state.workspaces.find(
      ({ id }) => id === invalidation.workspaceId,
    );
    if (workspace?.revision !== invalidation.projectionRevision) {
      throw new Error(
        "Direct task invalidation state must have the exact authoritative workspace revision.",
      );
    }
    const assertList = (views: readonly string[]) => {
      for (const view of views) {
        const pages = state.pages.filter(({ page, requestCursor }) =>
          page.workspaceId === invalidation.workspaceId &&
          page.view === view &&
          requestCursor === null
        );
        const page = pages[0]?.page;
        if (
          pages.length !== 1 ||
          page?.projectionRevision !== invalidation.projectionRevision
        ) {
          throw new Error(
            "Direct task invalidation state must have every exact affected list projection.",
          );
        }
        const count = workspace.counts[page.view];
        if (count.capped || count.value !== page.items.length) {
          throw new Error(
            "Direct task invalidation state must keep each affected summary count equal to its first page.",
          );
        }
        if (page.view === "assigned") {
          const context = state.contexts.find(
            (candidate) => candidate.workspaceId === invalidation.workspaceId,
          );
          const activeAgentId = context?.agents.find(
            ({ status }) => status === "active",
          )?.id;
          if (
            activeAgentId === undefined ||
            page.assignedAgentId !== activeAgentId
          ) {
            throw new Error(
              "Direct assigned invalidation state must correlate its first page to the active agent.",
            );
          }
        }
      }
    };
    const assertDetail = (taskId: string) => {
      const detail = state.details.find((candidate) =>
        candidate.workspaceId === invalidation.workspaceId &&
        candidate.task.id === taskId
      );
      if (detail?.projectionRevision !== invalidation.projectionRevision) {
        throw new Error(
          "Direct task invalidation state must have the exact affected detail projection.",
        );
      }
    };

    switch (invalidation.scope) {
      case "workspace":
        return;
      case "task_list":
        assertList([invalidation.view]);
        return;
      case "task_detail":
        assertDetail(invalidation.taskId);
        return;
      case "task_change":
        for (const affected of invalidation.affectedProjections) {
          switch (affected.projection) {
            case "workspace_summary":
              break;
            case "task_list":
              assertList(affected.views);
              break;
            case "task_detail":
              assertDetail(invalidation.taskId);
              break;
          }
        }
        return;
    }
  }

  #snapshotRequest(payload: unknown): RuntimeSnapshotTransportResponse {
    const request = parseRuntimeSnapshotRequest(payload);
    if ("transferId" in request) {
      const transfer = this.#transfers.get(request.transferId);
      if (transfer === undefined) throw new Error("The requested Direct snapshot transfer is not active.");
      const chunk = transfer.chunks[request.index];
      if (chunk === undefined) throw new Error("The requested Direct snapshot chunk does not exist.");
      const response = {
        version: runtimeProtocolVersion,
        transferId: transfer.id,
        index: request.index,
        count: transfer.chunks.length,
        base64: bytesToBase64(chunk),
      } as const;
      if (request.index + 1 === transfer.chunks.length) {
        this.#transfers.delete(transfer.id);
        this.#finishSnapshotRead(transfer.snapshotRead);
      }
      return response;
    }

    const snapshotRead = this.#snapshotReads;
    const index = Math.min(snapshotRead, this.#world.gateway.snapshots.length - 1);
    const snapshot = this.#ownedSnapshotOverride ?? this.#world.gateway.snapshots[index];
    if (snapshot === undefined) throw new Error("The requested Direct snapshot is unavailable.");
    this.#snapshotReads += 1;
    this.#snapshot = structuredClone(snapshot);

    if (this.#world.gateway.encoding.kind === "direct") {
      this.#finishSnapshotRead(snapshotRead);
      return runtimeSnapshotResponseSchema.parse({ version: runtimeProtocolVersion, snapshot });
    }

    const bytes = new TextEncoder().encode(JSON.stringify({
      version: runtimeProtocolVersion,
      snapshot,
    }));
    const chunks = splitBytes(bytes, this.#world.gateway.encoding.chunkBytes);
    const transferId = `snapshot_direct${String(this.#nextTransfer).padStart(8, "0")}`;
    this.#nextTransfer += 1;
    const transfer: SnapshotTransfer = { id: transferId, chunks, snapshotRead };
    this.#transfers.set(transferId, transfer);
    const first = chunks[0];
    if (first === undefined) throw new Error("Direct produced an empty snapshot transfer.");
    if (chunks.length === 1) {
      this.#transfers.delete(transferId);
      this.#finishSnapshotRead(snapshotRead);
    }
    return {
      version: runtimeProtocolVersion,
      transferId,
      index: 0,
      count: chunks.length,
      base64: bytesToBase64(first),
    };
  }

  #finishSnapshotRead(snapshotRead: number): void {
    if (snapshotRead !== 0 || this.#eventsStarted) return;
    this.#eventsStarted = true;
    const lifecycle = this.#lifecycle;
    void this.#tracked("event-script", async () => {
      for (const entry of this.#world.gateway.events) {
        if (!this.#isActive(lifecycle)) return;
        const waited = await this.#logical.wait(entry.delayMs, this.#eventAbort.signal);
        if (!this.#isActive(lifecycle)) return;
        if (!waited.ok) throw new Error(waited.error.message);
        if (!this.#isActive(lifecycle)) return;
        for (const listener of this.#listeners) listener(structuredClone(entry.event));
        if (!this.#isActive(lifecycle)) return;
        this.#deliveredScriptedEvents += 1;
      }
    }).catch((reason: unknown) => {
      if (reason === hraDirectTransportDisposedError) return;
      this.#eventScriptFailures.push(renderUnknownReason(
        reason,
        "Uninspectable HRA Direct event-script failure",
      ));
    });
  }

  #dispatchRequest(payload: unknown): RuntimeDispatchResponse | RuntimeTaskDispatchResponse {
    let taskRequest: RuntimeTaskDispatchRequest | undefined;
    try {
      taskRequest = parseRuntimeTaskDispatchRequest(payload);
    } catch {
      // Account and task requests share a native command. The account parser
      // remains authoritative for every payload that is not a task request.
    }
    if (taskRequest !== undefined) {
      return this.#dispatchTaskRequest(taskRequest);
    }
    const request = parseRuntimeDispatchRequest(payload);
    const command = request.command;
    switch (command.type) {
      case "chat.pane.create": {
        if (this.#snapshot.chat.panes.length >= 64) {
          return this.#chatFailure(
            request,
            "capacity_full",
            "Direct already contains the maximum of 64 panes.",
          );
        }
        if (this.#snapshot.chat.panes.some(({ id }) => id === command.paneId)) {
          return this.#chatFailure(
            request,
            "conflict",
            "Direct already contains this pane ID.",
          );
        }
        const repository = this.#snapshot.chat.panes.find(
          (pane) => pane.repository.id === command.repositoryId,
        )?.repository ?? (
          this.#world.task.projectAdd.status === "created" &&
              this.#world.task.projectAdd.repository.id === command.repositoryId
            ? this.#world.task.projectAdd.repository
            : null
        );
        if (repository === null) {
          return this.#chatFailure(
            request,
            "not_found",
            "Direct has no matching existing or project-add repository fixture.",
          );
        }
        const pane: ChatPaneProjection = {
          id: command.paneId,
          paletteIndex: Math.max(
            -1,
            ...this.#snapshot.chat.panes.map((candidate) => candidate.paletteIndex),
          ) + 1,
          revision: 1,
          title: repository.name,
          repository: { id: repository.id, name: repository.name },
          accountProfileId: null,
          interactionMode: "chat",
          state: "ready",
          activity: { ordinal: 0, kind: "idle" },
          workspace: managedChatWorkspace,
          turn: null,
          attention: null,
          recoverablePrompt: false,
          canStartFreshContext: false,
          messageQueue: {
            revision: 1,
            pauseReason: null,
            blockedMessage: null,
            messages: [],
          },
          attachments: { drafts: [], referenced: [] },
          harness: null,
        };
        this.#upsertChatPane(pane);
        return this.#success(request, {
          type: "chatPane",
          pane,
          disposition: "applied",
          appliedRevision: pane.revision,
        });
      }
      case "chat.pane.rename": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.revision !== command.expectedRevision) {
          return this.#staleRevision(request, pane.revision);
        }
        const updated: ChatPaneProjection = {
          ...pane,
          revision: pane.revision + 1,
          title: command.title,
        };
        this.#changeChatPaneState(updated);
        return this.#success(request, {
          type: "chatPane",
          pane: updated,
          disposition: "applied",
          appliedRevision: updated.revision,
        });
      }
      case "chat.pane.workspace.recover": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.revision !== command.expectedRevision) {
          return this.#staleRevision(request, pane.revision);
        }
        if (
          pane.interactionMode !== "chat" || pane.workspace === null ||
          (pane.state !== "ready" && pane.state !== "attention") ||
          (
            pane.workspace.state !== "waitingCapacity" &&
            pane.workspace.state !== "recoveryRequired"
          )
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cannot recover an active pane workspace.",
          );
        }
        const updated: ChatPaneProjection = {
          ...pane,
          revision: pane.revision + 1,
          workspace: {
            ...pane.workspace,
            state: "preparing",
            revision: pane.workspace.revision + 1,
            recoveryKind: null,
          },
        };
        this.#changeChatPaneState(updated);
        return this.#success(request, {
          type: "chatPane",
          pane: updated,
          disposition: "applied",
          appliedRevision: updated.revision,
        });
      }
      case "chat.pane.repository.select": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.revision !== command.expectedRevision) {
          return this.#staleRevision(request, pane.revision);
        }
        if (
          pane.turn !== null ||
          (pane.state !== "ready" && pane.state !== "attention")
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can change projects only before the first turn.",
          );
        }
        const repository = this.#world.task.projectAdd.status === "created" &&
            this.#world.task.projectAdd.repository.id === command.repositoryId
          ? this.#world.task.projectAdd.repository
          : null;
        if (repository === null) {
          return this.#chatFailure(
            request,
            "not_found",
            "Direct has no matching project-add repository fixture.",
          );
        }
        const updated: ChatPaneProjection = {
          ...pane,
          revision: pane.revision + 1,
          repository: { id: repository.id, name: repository.name },
        };
        this.#upsertChatPane(updated);
        return this.#success(request, {
          type: "chatPane",
          pane: updated,
          disposition: "applied",
          appliedRevision: updated.revision,
        });
      }
      case "chat.pane.remove": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.revision !== command.expectedRevision) {
          return this.#staleRevision(request, pane.revision);
        }
        if (
          pane.interactionMode !== "chat" ||
          (pane.state !== "ready" && pane.state !== "attention")
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cannot remove an active pane.",
          );
        }
        this.#removeChatPane(pane);
        return this.#success(request, { type: "chatPaneRemoved", paneId: pane.id });
      }
      case "chat.panes.reorder": {
        const currentPaneIds = this.#snapshot.chat.panes.map(({ id }) => id);
        const panesById = new Map(
          this.#snapshot.chat.panes.map((pane) => [pane.id, pane] as const),
        );
        if (
          command.expectedOrderedPaneIds.length !== currentPaneIds.length
          || command.expectedOrderedPaneIds.some(
            (paneId, index) => paneId !== currentPaneIds[index],
          )
        ) {
          return this.#chatFailure(
            request,
            "conflict",
            "Direct pane order changed before the requested order could be applied.",
          );
        }
        if (
          command.orderedPaneIds.length !== panesById.size
          || command.orderedPaneIds.some((paneId) => !panesById.has(paneId))
        ) {
          return this.#chatFailure(
            request,
            "conflict",
            "Direct pane order must exactly match the live pane set.",
          );
        }
        const panes = command.orderedPaneIds.map((paneId) => panesById.get(paneId)!);
        this.#emitOwnedEvent(
          { type: "chat.panes.reordered", orderedPaneIds: command.orderedPaneIds },
          {
            ...this.#snapshot,
            chat: { revision: this.#snapshot.chat.revision + 1, panes },
          },
        );
        return this.#accepted(request);
      }
      case "chat.message.enqueue": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.messageQueue.revision !== command.expectedQueueRevision) {
          return this.#staleRevision(request, pane.messageQueue.revision);
        }
        const active = pane.state === "starting" || pane.state === "streaming" ||
          pane.state === "continuing";
        if (
          command.delivery.kind === "steerHead" &&
          (
            !active || pane.turn?.id !== command.delivery.expectedTurnId ||
            pane.messageQueue.messages.length !== 0 ||
            pane.messageQueue.pauseReason !== null
          )
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can atomically steer only the exact active turn with an empty queue.",
          );
        }
        const nextOrdinal = (
          pane.messageQueue.messages.at(-1)?.ordinal ??
          pane.messageQueue.blockedMessage?.ordinal ??
          0
        ) + 1;
        const queuedMessage: ChatQueuedMessageProjection = {
          id: command.messageId,
          ordinal: nextOrdinal,
          revision: 1,
          text: command.content.text,
          attachmentRefs: [...command.content.attachmentRefs],
        };
        if (active || pane.messageQueue.pauseReason !== null) {
          const messageQueue = {
            ...pane.messageQueue,
            revision: pane.messageQueue.revision + 1,
            messages: command.delivery.kind === "queue"
              ? [...pane.messageQueue.messages, queuedMessage]
              : pane.messageQueue.messages,
          };
          this.#changeChatMessageQueue({ ...pane, messageQueue });
          return this.#success(request, {
            type: "chatMessageQueue",
            paneId: pane.id,
            queue: messageQueue,
            disposition: "applied",
            messageId: command.messageId,
          });
        }
        if (pane.state !== "ready" && pane.state !== "attention") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can enqueue only an active, ready, or attention chat pane.",
          );
        }
        const messageQueue = {
          revision: pane.messageQueue.revision + 1,
          pauseReason: null,
          blockedMessage: null,
          messages: [],
        };
        const updated = this.#completedQueuedMessagePane(
          pane,
          queuedMessage,
          messageQueue,
        );
        this.#changeChatMessageQueue(updated);
        return this.#success(request, {
          type: "chatMessageQueue",
          paneId: pane.id,
          queue: messageQueue,
          disposition: "applied",
          messageId: command.messageId,
        });
      }
      case "chat.message.edit": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.messageQueue.revision !== command.expectedQueueRevision) {
          return this.#staleRevision(request, pane.messageQueue.revision);
        }
        const messageIndex = pane.messageQueue.messages.findIndex(
          ({ id }) => id === command.messageId,
        );
        const message = pane.messageQueue.messages[messageIndex];
        if (message === undefined || message.revision !== command.expectedMessageRevision) {
          return this.#chatFailure(
            request,
            "conflict",
            "Direct queued message changed before it could be edited.",
          );
        }
        const messages = pane.messageQueue.messages.map((candidate, index) =>
          index === messageIndex
            ? { ...candidate, ...command.content, revision: candidate.revision + 1 }
            : candidate
        );
        const messageQueue = {
          ...pane.messageQueue,
          revision: pane.messageQueue.revision + 1,
          messages,
        };
        this.#changeChatMessageQueue({ ...pane, messageQueue });
        return this.#success(request, {
          type: "chatMessageQueue",
          paneId: pane.id,
          queue: messageQueue,
          disposition: "applied",
          messageId: command.messageId,
        });
      }
      case "chat.message.remove":
      case "chat.message.steerHead": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.messageQueue.revision !== command.expectedQueueRevision) {
          return this.#staleRevision(request, pane.messageQueue.revision);
        }
        const message = pane.messageQueue.messages[0];
        const targetIndex = command.type === "chat.message.steerHead"
          ? 0
          : pane.messageQueue.messages.findIndex(({ id }) => id === command.messageId);
        const target = pane.messageQueue.messages[targetIndex];
        if (
          target === undefined || target.id !== command.messageId ||
          target.revision !== command.expectedMessageRevision ||
          (
            command.type === "chat.message.steerHead" &&
            (
              message?.id !== target.id || pane.messageQueue.pauseReason !== null ||
              pane.turn?.id !== command.expectedTurnId ||
              (pane.state !== "starting" && pane.state !== "streaming" &&
                pane.state !== "continuing")
            )
          )
        ) {
          return this.#chatFailure(
            request,
            "conflict",
            "Direct queued message changed before it could be removed or steered.",
          );
        }
        const messageQueue = {
          ...pane.messageQueue,
          revision: pane.messageQueue.revision + 1,
          messages: pane.messageQueue.messages.filter((_, index) => index !== targetIndex),
        };
        this.#changeChatMessageQueue({ ...pane, messageQueue });
        return this.#success(request, {
          type: "chatMessageQueue",
          paneId: pane.id,
          queue: messageQueue,
          disposition: "applied",
          messageId: command.messageId,
        });
      }
      case "chat.messageQueue.resume": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.messageQueue.revision !== command.expectedQueueRevision) {
          return this.#staleRevision(request, pane.messageQueue.revision);
        }
        if (
          pane.messageQueue.pauseReason === null ||
          pane.messageQueue.pauseReason === "ambiguousEffect"
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cannot resume an unpaused or ambiguous message queue.",
          );
        }
        const messageQueue = {
          ...pane.messageQueue,
          revision: pane.messageQueue.revision + 1,
          pauseReason: null,
        };
        this.#changeChatMessageQueue({ ...pane, messageQueue });
        return this.#success(request, {
          type: "chatMessageQueue",
          paneId: pane.id,
          queue: messageQueue,
          disposition: "applied",
          messageId: null,
        });
      }
      case "chat.pane.startFreshContext": {
        const pane = this.#requireChatPane(command.paneId);
        if (
          pane.revision !== command.expectedRevision ||
          pane.messageQueue.revision !== command.expectedQueueRevision
        ) {
          return this.#staleRevision(
            request,
            Math.max(pane.revision, pane.messageQueue.revision),
          );
        }
        if (
          pane.state !== "attention" ||
          pane.attention?.code !== "runtime_unavailable" ||
          pane.attention.retryable ||
          pane.canStartFreshContext !== true ||
          pane.messageQueue.pauseReason === null ||
          pane.messageQueue.pauseReason === "ambiguousEffect"
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct has no quarantined provider context to start fresh from.",
          );
        }
        const messageQueue = {
          ...pane.messageQueue,
          revision: pane.messageQueue.revision + 1,
          pauseReason: null,
        };
        const updated: ChatPaneProjection = {
          ...pane,
          revision: pane.revision + 1,
          state: "ready",
          attention: null,
          recoverablePrompt: false,
          canStartFreshContext: false,
          messageQueue,
        };
        this.#changeChatMessageQueue(updated);
        return this.#success(request, {
          type: "chatMessageQueue",
          paneId: pane.id,
          queue: messageQueue,
          disposition: "applied",
          messageId: null,
        });
      }
      case "chat.message.discardAmbiguous": {
        const pane = this.#requireChatPane(command.paneId);
        if (pane.messageQueue.revision !== command.expectedQueueRevision) {
          return this.#staleRevision(request, pane.messageQueue.revision);
        }
        const blocked = pane.messageQueue.blockedMessage;
        if (
          pane.messageQueue.pauseReason !== "ambiguousEffect" ||
          blocked === null ||
          blocked.id !== command.messageId ||
          blocked.revision !== command.expectedMessageRevision
        ) {
          return this.#chatFailure(
            request,
            "conflict",
            "Direct unknown-delivery message changed before it could be discarded.",
          );
        }
        if (
          pane.state === "starting" || pane.state === "streaming" ||
          pane.state === "continuing"
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cannot discard an unknown-delivery message before its turn is contained.",
          );
        }
        let messageQueue: ChatMessageQueueProjection = {
          ...pane.messageQueue,
          revision: pane.messageQueue.revision + 1,
          pauseReason: null,
          blockedMessage: null,
        };
        const head = messageQueue.messages[0];
        const updated = head === undefined
          ? { ...pane, messageQueue }
          : this.#completedQueuedMessagePane(pane, head, {
              ...messageQueue,
              revision: messageQueue.revision + 1,
              messages: messageQueue.messages.slice(1),
            });
        messageQueue = updated.messageQueue;
        this.#changeChatMessageQueue(updated);
        return this.#success(request, {
          type: "chatMessageQueue",
          paneId: pane.id,
          queue: messageQueue,
          disposition: "applied",
          messageId: command.messageId,
        });
      }
      case "chat.attachment.begin":
      case "chat.attachment.append":
      case "chat.attachment.finalize":
      case "chat.attachment.cancel":
      case "chat.attachment.remove":
      case "chat.attachment.preview":
        return this.#chatFailure(
          request,
          "capability_unavailable",
          "Direct keeps attachment custody in its deterministic surface fixture.",
        );
      case "chat.turn.stop": {
        const pane = this.#requireChatPane(command.paneId);
        if (command.expectedRevision > pane.revision) {
          return this.#staleRevision(request, pane.revision);
        }
        if (
          pane.interactionMode === "chat" && pane.turn?.id === command.turnId &&
          command.expectedRevision < pane.revision &&
          (pane.state === "ready" || pane.state === "attention")
        ) {
          return this.#success(request, {
            type: "chatPane",
            pane,
            disposition: "applied",
            appliedRevision: pane.revision,
          });
        }
        if (
          pane.interactionMode !== "chat" ||
          pane.turn?.id !== command.turnId ||
          (pane.state !== "starting" && pane.state !== "streaming" &&
            pane.state !== "continuing")
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can stop only the exact active root chat turn.",
          );
        }
        const messageQueue = {
          ...pane.messageQueue,
          revision: pane.messageQueue.revision + 1,
          pauseReason: "stop" as const,
        };
        const stopped: ChatPaneProjection = {
          ...pane,
          revision: pane.revision + 1,
          state: "attention",
          messageQueue,
          turn: {
            ...pane.turn,
            status: "failed",
            completedAt: HRA_DIRECT_TIMESTAMP,
            tools: pane.turn.tools.map((tool) =>
              tool.status === "completed"
                ? tool
                : { ...tool, status: "completed" as const }),
          },
          attention: {
            code: "turn_failed",
            message: "You stopped this turn. You can send another message.",
            retryable: true,
          },
          recoverablePrompt: false,
        };
        this.#changeChatMessageQueue(stopped);
        return this.#success(request, {
          type: "chatPane",
          pane: stopped,
          disposition: "applied",
          appliedRevision: stopped.revision,
        });
      }
      case "harness.settings.update": {
        const harness = this.#requireHarness();
        if (
          harness.revision !== command.expectedHarnessRevision ||
          harness.settings.revision !== command.expectedRevision
        ) {
          return this.#staleRevision(request, harness.revision);
        }
        const settings = {
          revision: harness.settings.revision + 1,
          recursiveSessionsEnabled: command.recursiveSessionsEnabled,
          contextQuotaBytes: command.contextQuotaBytes,
          refinementMode: command.refinementMode,
        } as const;
        const updated: HarnessSnapshot = {
          ...harness,
          revision: harness.revision + 1,
          settings,
        };
        this.#setHarness(updated);
        return this.#success(request, {
          type: "harnessSettings",
          harnessRevision: updated.revision,
          settings,
        });
      }
      case "harness.child.open": {
        const parent = this.#requireChatPane(command.parentPaneId);
        const descendants = parent.harness?.descendants;
        const child = descendants?.children.find(({ id }) => id === command.childId);
        if (descendants === undefined || descendants === null || child === undefined) {
          return this.#chatFailure(request, "not_found", "Direct has no matching recursive session.");
        }
        if (
          parent.revision !== command.expectedParentRevision ||
          child.revision !== command.expectedChildRevision
        ) {
          return this.#staleRevision(request, parent.revision);
        }
        if (child.openedPaneId !== null) {
          return this.#chatFailure(request, "conflict", "This recursive session is already open.");
        }
        if (this.#snapshot.chat.panes.length >= 64) {
          return this.#chatFailure(request, "capacity_full", "Direct already contains 64 panes.");
        }
        const paneId = `pane_${child.id.slice("hactor_".length)}`;
        const pane: ChatPaneProjection = {
          id: paneId,
          paletteIndex: Math.max(
            -1,
            ...this.#snapshot.chat.panes.map((candidate) => candidate.paletteIndex),
          ) + 1,
          revision: 1,
          title: child.title,
          repository: parent.repository,
          accountProfileId: parent.accountProfileId,
          interactionMode: "harnessObserver",
          state: "ready",
          activity: { ordinal: 0, kind: "idle" },
          workspace: null,
          turn: null,
          attention: null,
          recoverablePrompt: false,
          canStartFreshContext: false,
          messageQueue: {
            revision: 1,
            pauseReason: null,
            blockedMessage: null,
            messages: [],
          },
          attachments: { drafts: [], referenced: [] },
          harness: null,
        };
        const openedChild: HarnessChildProjection = {
          ...child,
          revision: child.revision + 1,
          openedPaneId: pane.id,
          canOpen: false,
          canMessage: false,
        };
        const updatedParent: ChatPaneProjection = {
          ...parent,
          revision: parent.revision + 1,
          harness: {
            ...parent.harness!,
            revision: parent.harness!.revision + 1,
            descendants: {
              ...descendants,
              children: descendants.children.map((candidate) =>
                candidate.id === child.id ? openedChild : candidate
              ),
            },
          },
        };
        this.#setHarness(this.#requireHarness(), [
          ...this.#snapshot.chat.panes.map((candidate) =>
            candidate.id === parent.id ? updatedParent : candidate
          ),
          pane,
        ]);
        return this.#success(request, {
          type: "harnessChildOpened",
          parentPaneId: parent.id,
          parentRevision: updatedParent.revision,
          child: openedChild,
          pane,
        });
      }
      case "harness.child.stop": {
        const parent = this.#requireChatPane(command.parentPaneId);
        const descendants = parent.harness?.descendants;
        const child = descendants?.children.find(({ id }) => id === command.childId);
        if (descendants === undefined || descendants === null || child === undefined) {
          return this.#chatFailure(request, "not_found", "Direct has no matching recursive session.");
        }
        if (
          parent.revision !== command.expectedParentRevision ||
          child.revision !== command.expectedChildRevision
        ) {
          return this.#staleRevision(request, parent.revision);
        }
        if (!child.canStop) {
          return this.#chatFailure(request, "terminal", "This recursive session is already terminal.");
        }
        const stoppedChild: HarnessChildProjection = {
          ...child,
          revision: child.revision + 1,
          state: "stopped",
          canOpen: false,
          canMessage: false,
          canStop: false,
        };
        const updatedParent: ChatPaneProjection = {
          ...parent,
          revision: parent.revision + 1,
          harness: {
            ...parent.harness!,
            revision: parent.harness!.revision + 1,
            descendants: {
              ...descendants,
              children: descendants.children.map((candidate) =>
                candidate.id === child.id ? stoppedChild : candidate
              ),
            },
          },
        };
        this.#setHarness(
          this.#requireHarness(),
          this.#snapshot.chat.panes.map((candidate) =>
            candidate.id === parent.id ? updatedParent : candidate
          ),
        );
        return this.#success(request, {
          type: "harnessChild",
          parentPaneId: parent.id,
          parentRevision: updatedParent.revision,
          child: stoppedChild,
        });
      }
      case "account.create": {
        const account = fixtureAccount({
          id: `acct_fixture${String(this.#nextAccount).padStart(4, "0")}`,
          label: command.label,
          selected: this.#snapshot.accounts.length === 0,
        });
        this.#nextAccount += 1;
        this.#upsertAccount(account);
        return this.#success(request, { type: "account", account });
      }
      case "account.login.start": {
        const account = this.#requireAccount(command.accountProfileId);
        const updated = {
          ...account,
          revision: account.revision + 1,
          authState: "signingIn" as const,
          login: command.mode === "browser"
            ? { state: "waitingForBrowser" as const, startedAt: HRA_DIRECT_TIMESTAMP }
            : {
                state: "waitingForDeviceCode" as const,
                userCode: "FERN-MOSS",
                startedAt: HRA_DIRECT_TIMESTAMP,
              },
        };
        this.#upsertAccount(updated);
        return this.#accepted(request);
      }
      case "account.login.cancel": {
        const account = this.#requireAccount(command.accountProfileId);
        this.#upsertAccount({
          ...account,
          revision: account.revision + 1,
          authState: "signedOut",
          login: { state: "idle" },
        });
        return this.#accepted(request);
      }
      case "account.login.open":
      case "account.refresh":
        this.#requireAccount(command.accountProfileId);
        return this.#accepted(request);
      case "account.logout": {
        const account = this.#requireAccount(command.accountProfileId);
        const retained: RetainedAccountLocalData = {
          id: account.id,
          revision: account.revision + 1,
          label: account.label,
          removedAt: HRA_DIRECT_TIMESTAMP,
        };
        this.#removeAccount(account.id);
        this.#upsertRetainedData(retained);
        return this.#accepted(request);
      }
      case "runtime.restartAccount": {
        const account = this.#requireAccount(command.accountProfileId);
        this.#upsertAccount({
          ...account,
          revision: account.revision + 1,
          runtime: {
            state: "ready",
            generation: account.runtime.generation + 1,
          },
        });
        return this.#accepted(request);
      }
      case "account.select": {
        this.#requireAccount(command.accountProfileId);
        for (const account of this.#snapshot.accounts) {
          const selected = account.id === command.accountProfileId;
          if (account.selected !== selected) {
            this.#upsertAccount({ ...account, revision: account.revision + 1, selected });
          }
        }
        return this.#accepted(request);
      }
      case "account.remove.preview": {
        const account = this.#requireAccount(command.accountProfileId);
        const loginActive = account.login.state !== "idle";
        return this.#success(request, {
          type: "accountRemovalPreview",
          preview: {
            accountProfileId: account.id,
            accountRevision: account.revision,
            label: account.label,
            threadCount: 0,
            workspaceLaneCount: 0,
            loginActive,
            runtimeActive: account.runtime.state !== "stopped",
            localDataState: "present",
            blockers: loginActive ? ["loginActive"] : [],
            canRemove: !loginActive,
          },
        });
      }
      case "account.remove": {
        const account = this.#requireAccount(command.accountProfileId);
        if (account.revision !== command.expectedRevision) {
          return this.#staleRevision(request, account.revision);
        }
        const retained: RetainedAccountLocalData = {
          id: account.id,
          revision: account.revision + 1,
          label: account.label,
          removedAt: HRA_DIRECT_TIMESTAMP,
        };
        this.#removeAccount(account.id);
        this.#upsertRetainedData(retained);
        return this.#accepted(request);
      }
      case "account.localData.delete.preview": {
        const retained = this.#requireRetainedData(command.accountProfileId);
        return this.#success(request, {
          type: "accountLocalDataDeletionPreview",
          preview: {
            accountProfileId: retained.id,
            accountRevision: retained.revision,
            label: retained.label,
            removedAt: retained.removedAt,
            deletes: {
              credentials: true,
              sessionsAndHistory: true,
              configuration: true,
              logs: true,
            },
          },
        });
      }
      case "account.localData.delete": {
        const retained = this.#requireRetainedData(command.accountProfileId);
        if (retained.revision !== command.expectedRevision) {
          return this.#staleRevision(request, retained.revision);
        }
        this.#removeRetainedData(retained.id);
        return this.#accepted(request);
      }
      case "human.signIn.start":
        this.#setHumanAccount({
          state: "signingIn",
          revision: this.#snapshot.humanAccount.revision + 1,
          userCode: "FERN-MOSS",
          expiresAt: Date.parse(HRA_DIRECT_TIMESTAMP) + 15 * 60_000,
        });
        return this.#accepted(request);
      case "human.signIn.cancel":
      case "human.signOut":
        this.#setHumanAccount({
          state: "signedOut",
          revision: this.#snapshot.humanAccount.revision + 1,
        });
        return this.#accepted(request);
      case "human.credentials.retry": {
        const current = this.#snapshot.humanAccount;
        if (current.revision !== command.expectedRevision) {
          return this.#staleRevision(request, current.revision);
        }
        if (
          current.state !== "error" ||
          (
            current.code !== "CREDENTIAL_RECOVERY_REQUIRED" &&
            !current.retryable
          )
        ) {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cloud credential retry is not required.",
          );
        }
        this.#setHumanAccount({
          state: "recoveryRequired",
          revision: current.revision + 1,
          reason: "legacyCredentialAccessDenied",
        });
        return this.#accepted(request);
      }
      case "human.credentials.reconnect": {
        const current = this.#snapshot.humanAccount;
        if (current.revision !== command.expectedRevision) {
          return this.#staleRevision(request, current.revision);
        }
        if (current.state !== "recoveryRequired") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cloud credential recovery is not required.",
          );
        }
        this.#setHumanAccount({
          state: "signedOut",
          revision: current.revision + 1,
        });
        return this.#accepted(request);
      }
      case "human.organizations.list":
        return this.#success(request, {
          type: "humanOrganizations",
          organizations: this.#humanOrganizations.slice(0, command.limit),
          cursor: null,
        });
      case "human.organization.create": {
        const organization: RuntimeHumanOrganization = {
          id: `organization-direct-${this.#nextOrganization}`,
          name: command.name,
          role: "owner",
          status: "active",
          workosOrganizationId: `org_DIRECT${this.#nextOrganization}`,
        };
        this.#nextOrganization += 1;
        this.#humanOrganizations.push(organization);
        return this.#success(request, {
          type: "humanOrganization",
          organization,
        });
      }
      case "human.organization.select": {
        const organization = this.#humanOrganizations.find(
          ({ id }) => id === command.organizationId,
        );
        if (organization === undefined) {
          throw new Error(`Unknown fixture organization: ${command.organizationId}`);
        }
        this.#setHumanAccount({
          state: "signedIn",
          revision: this.#snapshot.humanAccount.revision + 1,
          profile: {
            user: {
              id: "user_DIRECT",
              email: "hra@example.test",
              name: "HRA Tester",
            },
            organization,
            workspace: null,
          },
        });
        return this.#accepted(request);
      }
      case "human.workspaces.list":
        return this.#success(request, {
          type: "humanWorkspaces",
          workspaces: this.#humanWorkspaces.slice(0, command.limit),
          cursor: null,
        });
      case "human.workspace.select": {
        const workspace = this.#humanWorkspaces.find(
          ({ id }) => id === command.workspaceId,
        );
        const current = this.#snapshot.humanAccount;
        if (
          workspace === undefined ||
          current.state !== "signedIn" ||
          current.profile.organization?.id !== workspace.organizationId
        ) {
          throw new Error(`Unknown fixture workspace: ${command.workspaceId}`);
        }
        this.#setHumanAccount({
          state: "signedIn",
          revision: current.revision + 1,
          profile: {
            ...current.profile,
            workspace,
          },
        });
        return this.#accepted(request);
      }
      case "sessionSync.enable": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "disabled") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can enable session sync only from its disabled state.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        this.#setSessionSyncStatus({
          state: "active",
          revision: status.revision + 1,
          scopeGeneration: this.#nextSessionSyncScopeGeneration,
          currentDeviceId: directSessionSyncDeviceId,
          deviceName: command.deviceName,
          health: "current",
          retryable: false,
          notice: null,
          recovery: "exportRequired",
          devices: [{
            id: directSessionSyncDeviceId,
            name: command.deviceName,
            status: "active",
            current: true,
            connection: "online",
          }],
          pendingEnrollments: [],
        });
        this.#nextSessionSyncScopeGeneration += 1;
        return this.#accepted(request);
      }
      case "sessionSync.disable": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state === "unavailable") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct cannot disable unavailable session sync.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        if (status.state === "active") {
          this.#nextSessionSyncScopeGeneration = Math.max(
            this.#nextSessionSyncScopeGeneration,
            status.scopeGeneration + 1,
          );
        }
        this.#setSessionSyncStatus({
          state: "disabled",
          revision: status.revision + 1,
          deviceName: status.deviceName,
        });
        this.#activeRecoveryReveal = null;
        return this.#accepted(request);
      }
      case "sessionSync.retry":
        return this.#accepted(request);
      case "sessionSync.enrollment.approve": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can approve enrollment only while session sync is active.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        const enrollment = status.pendingEnrollments.find(
          ({ requestId }) => requestId === command.requestId,
        );
        if (enrollment === undefined) {
          return this.#chatFailure(request, "not_found", "Direct has no pending enrollment.");
        }
        if (enrollment.pairingCode !== command.pairingCode) {
          return this.#chatFailure(
            request,
            "policy_denied",
            "The confirmed pairing code does not match the pending enrollment.",
          );
        }
        this.#setSessionSyncStatus({
          ...status,
          revision: status.revision + 1,
          devices: [...status.devices, {
            id: enrollment.deviceId,
            name: enrollment.name,
            status: "active",
            current: false,
            connection: "offline",
          }],
          pendingEnrollments: status.pendingEnrollments.filter(
            ({ requestId }) => requestId !== enrollment.requestId,
          ),
        });
        return this.#accepted(request);
      }
      case "sessionSync.device.revoke": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can revoke a device only while session sync is active.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        const device = status.devices.find(({ id }) => id === command.deviceId);
        if (device === undefined) {
          return this.#chatFailure(request, "not_found", "Direct has no matching sync device.");
        }
        if (device.current) {
          return this.#chatFailure(
            request,
            "policy_denied",
            "Direct cannot revoke the current device.",
          );
        }
        if (device.status === "revoked") {
          return this.#chatFailure(request, "conflict", "This sync device is already revoked.");
        }
        for (const session of this.#snapshot.sessionSync.remoteSessions.filter(
          ({ originDeviceId }) => originDeviceId === device.id,
        )) {
          this.#removeRemoteSession(session.sessionId);
        }
        this.#setSessionSyncStatus({
          ...status,
          revision: status.revision + 1,
          devices: status.devices.map((candidate) => candidate.id === device.id
            ? {
                ...candidate,
                status: "revoked" as const,
                connection: "offline" as const,
              }
            : candidate),
        });
        return this.#accepted(request);
      }
      case "sessionSync.recovery.reveal": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can reveal recovery material only while session sync is active.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        this.#activeRecoveryReveal = {
          id: directSessionSyncRecoveryRevealId,
          revision: status.revision,
        };
        return this.#success(request, {
          type: "sessionSyncRecoveryKit",
          revealId: directSessionSyncRecoveryRevealId,
          recoveryKit: directSessionSyncRecoveryKit,
          // Direct worlds must remain replayable after their authored clock.
          // The renderer compares this capability deadline with wall time.
          expiresAt: HRA_DIRECT_ACTIVE_DEADLINE,
        });
      }
      case "sessionSync.recovery.import": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can import recovery material only while session sync is active.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        this.#setSessionSyncStatus({
          ...status,
          revision: status.revision + 1,
          scopeGeneration: status.scopeGeneration + 1,
          recovery: "ready",
        });
        this.#nextSessionSyncScopeGeneration = Math.max(
          this.#nextSessionSyncScopeGeneration,
          status.scopeGeneration + 2,
        );
        this.#activeRecoveryReveal = null;
        return this.#accepted(request);
      }
      case "sessionSync.recoveryKitSavedOffline": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can acknowledge recovery material only while session sync is active.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        if (
          this.#activeRecoveryReveal?.id !== command.revealId
          || this.#activeRecoveryReveal.revision !== status.revision
        ) {
          return this.#chatFailure(
            request,
            "policy_denied",
            "The recovery reveal receipt is missing or expired.",
          );
        }
        this.#activeRecoveryReveal = null;
        this.#setSessionSyncStatus({
          ...status,
          revision: status.revision + 1,
          recovery: "ready",
        });
        return this.#accepted(request);
      }
      case "sessionSync.recovery.rotate": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can rotate recovery authority only while session sync is active.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        const scopeGeneration = status.scopeGeneration + 1;
        this.#activeRecoveryReveal = null;
        this.#nextSessionSyncScopeGeneration = Math.max(
          this.#nextSessionSyncScopeGeneration,
          scopeGeneration + 1,
        );
        this.#setSessionSyncStatus({
          ...status,
          revision: status.revision + 1,
          scopeGeneration,
          recovery: "exportRequired",
          notice: "Recovery authority rotated. Save the new recovery kit offline.",
        });
        return this.#accepted(request);
      }
      case "sessionSync.reset": {
        const status = this.#snapshot.sessionSync.status;
        if (status.state !== "active") {
          return this.#chatFailure(
            request,
            "invalid_state",
            "Direct can reset only an active encrypted session-sync vault.",
          );
        }
        if (status.revision !== command.expectedRevision) {
          return this.#staleRevision(request, status.revision);
        }
        this.#activeRecoveryReveal = null;
        this.#nextSessionSyncScopeGeneration = Math.max(
          this.#nextSessionSyncScopeGeneration,
          status.scopeGeneration + 1,
        );
        this.#setSessionSyncStatus({
          state: "disabled",
          revision: status.revision + 1,
          deviceName: status.deviceName,
        });
        return this.#accepted(request);
      }
      case "maintenance.localDataRemoval.preview":
        return this.#success(request, {
          type: "localDataRemovalPreview",
          preview: {
            previewId: "removal_direct0001",
            confirmationToken: "confirm_direct0001",
            expiresAt: "2099-01-01T00:05:00.000Z",
            removes: {
              controlPlaneItems: 1,
              hraCodexProfileDataItems: this.#snapshot.accounts.length,
              humanCredentialGenerations: 1,
              runnerPairingSecrets: 1,
              harnessContextHeapKeys: 1,
              sessionSyncKeyMaterials: 2,
              releaseUpdateArtifacts: 1,
              applicationStateItems: 1,
              managedWorktrees: 3,
              dirtyManagedWorktrees: 1,
            },
            preserves: {
              userRepositories: 2,
              externalCodexData: true,
              taskctlCredentials: true,
              credentialRecoveryEvidenceRecords: 0,
              unrelatedData: true,
            },
            dirtyWorktreeAcknowledgementRequired: true,
            blockers: [],
            canRemove: true,
          },
        });
      case "maintenance.localDataRemoval.remove":
        return this.#success(request, {
          type: "localDataRemovalScheduled",
          previewId: command.previewId,
          state: "scheduled",
          willQuitApplication: true,
        });
      default:
        return this.#unreachable(command);
    }
  }

  #dispatchTaskRequest(request: RuntimeTaskDispatchRequest): RuntimeTaskDispatchResponse {
    const command = request.command;
    switch (command.type) {
      case "task.workspaces.list":
        return this.#taskSuccess(request, {
          type: "taskWorkspaceSummaries",
          workspaces: this.#taskState.workspaces,
        });
      case "task.workspace.context": {
        const context = this.#taskState.contexts.find(
          (candidate) => candidate.workspaceId === command.workspaceId,
        );
        if (context === undefined) return this.#taskNotFound(request, "workspace context");
        return this.#taskSuccess(request, { type: "taskWorkspaceContext", context });
      }
      case "task.lookup": {
        const detail = this.#taskState.details.find((candidate) => (
          candidate.workspaceId === command.workspaceId && candidate.task.key === command.taskKey
        ));
        const listItem = this.#taskState.pages
          .filter(({ page }) => page.workspaceId === command.workspaceId)
          .flatMap(({ page }) => page.items)
          .find((candidate) => candidate.task.key === command.taskKey);
        const task = detail?.task ?? listItem?.task ?? null;
        return this.#taskSuccess(request, {
          type: "taskLookup",
          workspaceId: command.workspaceId,
          taskKey: command.taskKey,
          task: task === null ? null : {
            id: task.id,
            key: task.key,
            revision: task.revision,
            status: task.status,
            title: task.title,
            priority: task.priority,
          },
        });
      }
      case "task.repositories.list": {
        const page = this.#taskState.repositories.find(
          (candidate) => candidate.workspaceId === command.workspaceId,
        );
        if (page === undefined) return this.#taskNotFound(request, "repository list");
        return this.#taskSuccess(request, { type: "taskRepositoryList", page });
      }
      case "task.workspace.projection": {
        const workspace = this.#taskState.workspaces.find(
          (candidate) => candidate.id === command.workspaceId,
        );
        const context = this.#taskState.contexts.find(
          (candidate) => candidate.workspaceId === command.workspaceId,
        );
        const repositories = this.#taskState.repositories.find(
          (candidate) => candidate.workspaceId === command.workspaceId,
        );
        const page = this.#taskState.pages.find(({ page, requestCursor }) => (
          page.workspaceId === command.workspaceId &&
          page.view === command.view &&
          page.assignedAgentId === command.assignedAgentId &&
          requestCursor === null
        ))?.page;
        const detail = command.selectedTaskId === null
          ? null
          : this.#taskState.details.find((candidate) => (
              candidate.workspaceId === command.workspaceId &&
              candidate.task.id === command.selectedTaskId
            )) ?? null;
        if (
          workspace === undefined ||
          context === undefined ||
          repositories === undefined ||
          page === undefined ||
          (command.selectedTaskId !== null && detail === null)
        ) {
          return this.#taskNotFound(request, "atomic task workspace");
        }
        const projectionRevision = workspace.revision;
        if (
          page.projectionRevision !== projectionRevision ||
          context.projectionRevision !== projectionRevision ||
          repositories.projectionRevision !== projectionRevision ||
          (detail !== null &&
            detail.projectionRevision !== projectionRevision) ||
          (
            command.minimumRevision !== null &&
            projectionRevision < command.minimumRevision
          )
        ) {
          return this.#taskNotFound(request, "current atomic task workspace");
        }
        return this.#taskSuccess(request, {
          type: "taskWorkspaceProjection",
          consistency: "atomic",
          presentation: {
            agents: context.agents,
            capabilities: context.capabilities,
            counts: workspace.counts,
            now: context.runner.serverTime,
            runner: {
              presence: context.runner,
              repositories: repositories.repositories,
            },
            viewer: context.viewer,
            workspace: {
              id: workspace.id,
              keyPrefix: workspace.keyPrefix,
              name: workspace.name,
              slug: workspace.slug,
            },
          },
          projection: taskDomain.taskWorkspaceProjectionBundleSchema.parse({
            workspaceId: command.workspaceId,
            view: command.view,
            ...(command.assignedAgentId === undefined
              ? {}
              : { assignedAgentId: command.assignedAgentId }),
            selectedTaskId: command.selectedTaskId,
            projectionRevision,
            continuationRevision: projectionRevision,
            firstPage: {
              ...page,
              items: page.items.slice(0, command.limit),
            },
            detail,
          }),
        });
      }
      case "task.list": {
        const fixture = this.#taskState.pages.find(({ page, requestCursor }) => (
          page.workspaceId === command.workspaceId &&
          page.view === command.view &&
          requestCursor === command.cursor &&
          page.assignedAgentId === command.assignedAgentId
        ));
        if (fixture === undefined) return this.#taskNotFound(request, "task list page");
        return this.#taskSuccess(request, { type: "taskListPage", page: fixture.page });
      }
      case "task.detail": {
        const detail = this.#taskState.details.find((candidate) => (
          candidate.workspaceId === command.workspaceId && candidate.task.id === command.taskId
        ));
        if (detail === undefined) return this.#taskNotFound(request, "task detail");
        return this.#taskSuccess(request, { type: "taskDetail", detail });
      }
      case "task.mutation.attempt.prepare":
        return this.#prepareTaskMutationAttempt(request);
      case "task.mutation.attempt.start":
        return this.#startTaskMutationAttempt(request);
      case "task.mutation.attempt.list":
        return this.#listTaskMutationAttempts(request);
      case "task.mutation.attempt.inspect":
        return this.#inspectTaskMutationAttempt(request);
      case "task.mutation.attempt.reconcile":
        return this.#reconcileTaskMutationAttempt(request);
      case "task.mutate":
        return this.#dispatchTaskMutation(request);
      case "task.promotion.start": {
        const progress: RuntimeLocalPromotionProgress = {
          promotionId: "promotion_00000000000000000000000000",
          sourceWorkspaceId: command.workspaceId,
          destinationWorkspaceId: null,
          phase: "snapshot_frozen",
          frozenAt: Date.parse(HRA_DIRECT_TIMESTAMP),
          updatedAt: Date.parse(HRA_DIRECT_TIMESTAMP),
          preparedEntityCount: 12,
          acceptedEntityCount: 0,
          acceptedBatchCount: 0,
          nextAttemptAt: null,
          fault: null,
          canAbort: true,
          localWritable: false,
          recoveryCopyAvailable: false,
          runnerPairing: "not_applicable",
        };
        this.#promotions.set(command.workspaceId, progress);
        return this.#taskSuccess(request, {
          type: "taskPromotionProgress",
          progress,
        });
      }
      case "task.promotion.status":
        return this.#taskSuccess(request, {
          type: "taskPromotionProgress",
          progress: this.#promotions.get(command.workspaceId) ?? null,
        });
      case "task.promotion.abort": {
        const current = this.#promotions.get(command.workspaceId);
        if (
          current === undefined ||
          current.promotionId !== command.promotionId
        ) {
          return this.#taskNotFound(request, "promotion");
        }
        const progress: RuntimeLocalPromotionProgress = {
          ...current,
          phase: "aborted",
          updatedAt: current.updatedAt + 1,
          canAbort: false,
          localWritable: true,
        };
        this.#promotions.set(command.workspaceId, progress);
        return this.#taskSuccess(request, {
          type: "taskPromotionProgress",
          progress,
        });
      }
      case "task.promotion.recovery.open":
        return this.#taskSuccess(request, {
          type: "taskPromotionRecovery",
          recovery: null,
        });
      default:
        return this.#unreachable(command);
    }
  }

  #mutationFingerprintKey(workspaceId: string, fingerprint: string): string {
    return JSON.stringify([workspaceId, fingerprint]);
  }

  #prepareTaskMutationAttempt(
    request: RuntimeTaskDispatchRequest,
  ): RuntimeTaskDispatchResponse {
    if (request.command.type !== "task.mutation.attempt.prepare") {
      throw new Error("Direct task attempt preparer received another command.");
    }
    const command = request.command;
    const fingerprintKey = this.#mutationFingerprintKey(
      command.workspaceId,
      command.fingerprint,
    );
    const candidateCollision = this.#mutationAttempts.get(command.attemptId);
    if (candidateCollision !== undefined) {
      if (
        candidateCollision.fingerprint !== command.fingerprint ||
        candidateCollision.attempt.workspaceId !== command.workspaceId ||
        candidateCollision.attempt.commandKind !== command.commandKind
      ) {
        return this.#taskOperationConflict(request);
      }
      return this.#taskSuccess(request, {
        type: "taskMutationAttempt",
        attempt: candidateCollision.attempt,
      });
    }
    const existingId = this.#mutationAttemptIdsByFingerprint.get(fingerprintKey);
    if (existingId !== undefined) {
      const existing = this.#mutationAttempts.get(existingId);
      if (
        existing === undefined ||
        existing.attempt.state === "settled" ||
        existing.attempt.workspaceId !== command.workspaceId ||
        existing.attempt.commandKind !== command.commandKind
      ) {
        return this.#taskOperationConflict(request);
      }
      return this.#taskSuccess(request, {
        type: "taskMutationAttempt",
        attempt: existing.attempt,
      });
    }
    const attempt: RuntimeTaskMutationAttempt = {
      attemptId: command.attemptId,
      workspaceId: command.workspaceId,
      commandKind: command.commandKind,
      revision: 1,
      preparedAt: Date.parse(HRA_DIRECT_TIMESTAMP),
      state: "prepared",
    };
    this.#mutationAttempts.set(command.attemptId, {
      fingerprint: command.fingerprint,
      attempt,
    });
    this.#mutationAttemptIdsByFingerprint.set(
      fingerprintKey,
      command.attemptId,
    );
    return this.#taskSuccess(request, {
      type: "taskMutationAttempt",
      attempt,
    });
  }

  #startTaskMutationAttempt(
    request: RuntimeTaskDispatchRequest,
  ): RuntimeTaskDispatchResponse {
    if (request.command.type !== "task.mutation.attempt.start") {
      throw new Error("Direct task attempt starter received another command.");
    }
    const command = request.command;
    const current = this.#mutationAttempts.get(command.attemptId);
    if (
      current === undefined ||
      current.attempt.workspaceId !== command.workspaceId
    ) {
      return this.#taskNotFound(request, "task mutation attempt");
    }
    if (
      current.attempt.state !== "prepared" ||
      current.attempt.revision !== command.expectedRevision
    ) {
      return this.#taskStaleRevision(request, current.attempt.revision);
    }
    if (current.attempt.commandKind !== command.intent.kind) {
      return this.#taskOperationConflict(request);
    }
    const attempt: RuntimeTaskMutationAttempt = {
      ...current.attempt,
      state: "effect_started",
      revision: current.attempt.revision + 1,
      effectStartedAt: current.attempt.preparedAt + 1,
    };
    this.#mutationAttempts.set(command.attemptId, {
      ...current,
      attempt,
      boundCommandFingerprint: canonicalJson(command.intent),
    });
    return this.#taskSuccess(request, {
      type: "taskMutationAttempt",
      attempt,
    });
  }

  #listTaskMutationAttempts(
    request: RuntimeTaskDispatchRequest,
  ): RuntimeTaskDispatchResponse {
    if (request.command.type !== "task.mutation.attempt.list") {
      throw new Error("Direct task attempt lister received another command.");
    }
    const command = request.command;
    const attempts = [...this.#mutationAttempts.values()]
      .map(({ attempt }) => attempt)
      .filter((attempt) =>
        attempt.workspaceId === command.workspaceId &&
        attempt.state !== "settled"
      )
      .sort((left, right) =>
        left.preparedAt - right.preparedAt ||
        left.attemptId.localeCompare(right.attemptId)
      )
      .slice(0, command.limit);
    return this.#taskSuccess(request, {
      type: "taskMutationAttemptList",
      workspaceId: command.workspaceId,
      attempts,
    });
  }

  #settleTaskMutationAttempt(
    attemptId: string,
    resolution: RuntimeTaskMutationReconciliation["resolution"],
  ): void {
    const current = this.#mutationAttempts.get(attemptId);
    if (current === undefined || current.attempt.state === "settled") return;
    const effectStartedAt = current.attempt.state === "effect_started"
      ? current.attempt.effectStartedAt
      : null;
    if (resolution.outcome === "ambiguous") {
      throw new Error("Direct cannot synthesize a legacy mutation quarantine.");
    }
    const terminalOutcome = resolution.outcome;
    const attempt: RuntimeTaskMutationAttempt = {
      ...current.attempt,
      state: "settled",
      revision: current.attempt.revision + 1,
      effectStartedAt,
      settledAt: Math.max(
        current.attempt.preparedAt + 2,
        effectStartedAt === null ? 0 : effectStartedAt + 1,
      ),
      terminalOutcome,
    };
    this.#mutationAttempts.set(attemptId, {
      ...current,
      attempt,
      resolution,
    });
    this.#mutationAttemptIdsByFingerprint.delete(
      this.#mutationFingerprintKey(
        current.attempt.workspaceId,
        current.fingerprint,
      ),
    );
  }

  #reconcileTaskMutationAttempt(
    request: RuntimeTaskDispatchRequest,
  ): RuntimeTaskDispatchResponse {
    if (request.command.type !== "task.mutation.attempt.reconcile") {
      throw new Error("Direct task attempt reconciler received another command.");
    }
    const command = request.command;
    const current = this.#mutationAttempts.get(command.attemptId);
    if (
      current === undefined ||
      current.attempt.workspaceId !== command.workspaceId
    ) {
      return this.#taskNotFound(request, "task mutation attempt");
    }
    if (
      current.attempt.state !== "settled" &&
      current.attempt.revision !== command.expectedRevision
    ) {
      return this.#taskStaleRevision(request, current.attempt.revision);
    }
    let resolution = current.resolution;
    if (resolution === undefined) {
      const replay = this.#mutationReplays.get(command.attemptId);
      resolution = replay === undefined
        ? { outcome: "not_applied" }
        : { outcome: "committed", mutation: replay.mutation };
      this.#settleTaskMutationAttempt(command.attemptId, resolution);
    }
    return this.#taskSuccess(request, {
      type: "taskMutationReconciliation",
      reconciliation: {
        attemptId: command.attemptId,
        workspaceId: command.workspaceId,
        commandKind: current.attempt.commandKind,
        resolution,
      },
    });
  }

  #inspectTaskMutationAttempt(
    request: RuntimeTaskDispatchRequest,
  ): RuntimeTaskDispatchResponse {
    if (request.command.type !== "task.mutation.attempt.inspect") {
      throw new Error("Direct task attempt inspector received another command.");
    }
    const command = request.command;
    const current = this.#mutationAttempts.get(command.attemptId);
    if (
      current === undefined ||
      current.attempt.workspaceId !== command.workspaceId
    ) {
      return this.#taskNotFound(request, "task mutation attempt");
    }
    if (
      current.attempt.state !== "settled" &&
      current.attempt.revision !== command.expectedRevision
    ) {
      return this.#taskStaleRevision(request, current.attempt.revision);
    }
    const replay = this.#mutationReplays.get(command.attemptId);
    const resolution = current.resolution ??
      (
        replay === undefined
          ? { outcome: "not_applied" as const }
          : { outcome: "committed" as const, mutation: replay.mutation }
      );
    return this.#taskSuccess(request, {
      type: "taskMutationAttemptInspection",
      inspection: {
        attemptId: command.attemptId,
        workspaceId: command.workspaceId,
        commandKind: current.attempt.commandKind,
        resolution,
      },
    });
  }

  #projectAdd(payload: unknown): RuntimeProjectAddResult {
    parseRuntimeProjectAddRequest(payload);
    const result = structuredClone(this.#world.task.projectAdd);
    if (result.status === "created") {
      this.#emitOwnedEvent({
        type: "task.invalidated",
        invalidation: {
          workspaceId: result.workspace.id,
          projectionRevision: result.workspace.revision,
          scope: "workspace",
        },
      }, this.#snapshot);
    }
    return result;
  }

  #dispatchTaskMutation(request: RuntimeTaskDispatchRequest): RuntimeTaskDispatchResponse {
    if (request.command.type !== "task.mutate") {
      throw new Error("Direct task mutation dispatcher received a non-mutation request.");
    }
    const workspaceId = request.command.workspaceId;
    const intent = request.command.intent;
    const commandFingerprint = canonicalJson(intent);
    const attempt = this.#mutationAttempts.get(intent.operationId);
    if (
      attempt !== undefined &&
      (
        attempt.attempt.state !== "effect_started" ||
        attempt.boundCommandFingerprint !== commandFingerprint
      )
    ) {
      return this.#taskOperationConflict(request);
    }
    const replay = this.#mutationReplays.get(intent.operationId);
    if (replay !== undefined) {
      if (replay.commandFingerprint !== commandFingerprint) {
        return this.#taskOperationConflict(request);
      }
      return this.#taskSuccess(request, {
        type: "taskMutation",
        mutation: structuredClone(replay.mutation),
      });
    }
    const stateWorkspace = this.#taskState.workspaces.find(
      ({ id }) => id === workspaceId,
    );
    if (stateWorkspace === undefined) return this.#taskNotFound(request, "mutation workspace");
    if (intent.expectedWorkspaceRevision !== stateWorkspace.revision) {
      return this.#taskStaleRevision(request, stateWorkspace.revision);
    }

    const transition = this.#world.task.mutationTransitions.find((candidate) => {
      if (
        candidate.commandKind !== intent.kind ||
        this.#consumedMutationTransitionIds.has(candidate.id)
      ) {
        return false;
      }
      const expectedCommand = parseHRADirectExpectedTaskCommand(
        candidate.expectedCommandJson,
      );
      if (
        semanticTaskCommandFingerprint(expectedCommand) !==
        semanticTaskCommandFingerprint(intent)
      ) {
        return false;
      }
      const fixtureReceipt = operationReceiptSchema.parse(
        JSON.parse(candidate.receiptJson) as unknown,
      );
      if (fixtureReceipt.outcome !== "committed") return false;
      const mutation: RuntimeTaskMutationResult = {
        operationId: intent.operationId,
        workspaceId,
        commandKind: intent.kind,
        workspaceRevision: fixtureReceipt.workspaceRevision,
        projectionRevision: fixtureReceipt.workspaceRevision,
        result: fixtureReceipt.result,
      };
      try {
        parseRuntimeTaskDispatchResponseForRequest({
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: { type: "taskMutation", mutation },
        }, request);
        return true;
      } catch {
        return false;
      }
    });
    if (transition === undefined) return this.#taskNotImplemented(request, intent.kind);

    const receipt = operationReceiptSchema.parse(JSON.parse(transition.receiptJson) as unknown);
    if (receipt.outcome !== "committed") {
      return this.#taskNotImplemented(request, intent.kind);
    }
    const mutation: RuntimeTaskMutationResult = {
      operationId: intent.operationId,
      workspaceId,
      commandKind: intent.kind,
      workspaceRevision: receipt.workspaceRevision,
      projectionRevision: receipt.workspaceRevision,
      result: receipt.result,
    };
    const next = this.#world.task.states.find(({ id }) =>
      id === transition.toStateId);
    if (next === undefined) {
      throw new Error(`Direct transition ${transition.id} has no target state.`);
    }
    const nextState = parseHRADirectTaskProjectionState(next.projectionJson);
    this.#consumedMutationTransitionIds.add(transition.id);
    this.#taskState = nextState;
    this.#mutationReplays.set(intent.operationId, {
      commandFingerprint,
      mutation: structuredClone(mutation),
    });
    this.#emitOwnedEvent({
      type: "task.invalidated",
      invalidation: transition.invalidation,
    }, this.#snapshot);
    return this.#taskSuccess(request, { type: "taskMutation", mutation });
  }

  #accepted(request: RuntimeDispatchRequest): RuntimeDispatchResponse {
    return this.#success(request, { type: "accepted" });
  }

  #success(
    request: RuntimeDispatchRequest,
    result: Extract<RuntimeDispatchResponse, { readonly ok: true }>["result"],
  ): RuntimeDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result,
    };
  }

  #staleRevision(request: RuntimeDispatchRequest, revision: number): RuntimeDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error: {
        code: "stale_revision",
        message: `The account changed; its current revision is ${revision}.`,
        retryable: true,
        action: "retry",
      },
    };
  }

  #chatFailure(
    request: RuntimeDispatchRequest,
    code: Extract<RuntimeDispatchResponse, { readonly ok: false }>["error"]["code"],
    message: string,
  ): RuntimeDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error: {
        code,
        message,
        retryable: false,
        action: "none",
      },
    };
  }

  #taskSuccess(
    request: RuntimeTaskDispatchRequest,
    result: Extract<RuntimeTaskDispatchResponse, { readonly ok: true }>['result'],
  ): RuntimeTaskDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result,
    };
  }

  #taskNotImplemented(
    request: RuntimeTaskDispatchRequest,
    subject: string,
  ): RuntimeTaskDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error: {
        code: "not_implemented",
        message: `Direct has no fixture for ${subject}.`,
        retryable: false,
        action: "none",
      },
    };
  }

  #taskNotFound(
    request: RuntimeTaskDispatchRequest,
    subject: string,
  ): RuntimeTaskDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error: {
        code: "not_found",
        message: `Direct has no ${subject} fixture.`,
        retryable: false,
        action: "none",
      },
    };
  }

  #taskStaleRevision(
    request: RuntimeTaskDispatchRequest,
    revision: number,
  ): RuntimeTaskDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error: {
        code: "stale_revision",
        message: `The task workspace changed; its current revision is ${revision}.`,
        retryable: true,
        action: "retry",
      },
    };
  }

  #taskOperationConflict(
    request: RuntimeTaskDispatchRequest,
  ): RuntimeTaskDispatchResponse {
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error: {
        code: "conflict",
        message: "The task operation ID was already used for another command.",
        retryable: false,
        action: "none",
      },
    };
  }

  #requireChatPane(paneId: string): ChatPaneProjection {
    const pane = this.#snapshot.chat.panes.find(({ id }) => id === paneId);
    if (pane === undefined) throw new Error(`Unknown fixture pane: ${paneId}`);
    return pane;
  }

  #requireHarness(): HarnessSnapshot {
    const harness = this.#snapshot.harness;
    if (harness === null || harness === undefined) {
      throw new Error("Direct has no harness fixture.");
    }
    return harness;
  }

  #completedQueuedMessagePane(
    pane: ChatPaneProjection,
    message: ChatQueuedMessageProjection,
    messageQueue: ChatMessageQueueProjection,
  ): ChatPaneProjection {
    const prompt = message.text.trim() || "Attached file.";
    const response = `## Direct response\n\nCompleted: ${prompt}`;
    const turnId = `chatturn_${message.id.slice("chatmsg_".length)}`;
    return {
      ...pane,
      revision: pane.revision + 2,
      state: "ready",
      activity: {
        ordinal: pane.activity.ordinal + 2,
        kind: "responseCompleted",
      },
      messageQueue,
      turn: {
        id: turnId,
        status: "completed",
        startedAt: HRA_DIRECT_TIMESTAMP,
        completedAt: HRA_DIRECT_TIMESTAMP,
        continuationCount: 0,
        responseMarkdown: {
          tail: response,
          totalUtf8Bytes: new TextEncoder().encode(response).byteLength,
          truncatedPrefix: false,
        },
        reasoningSummary: {
          tail: "",
          totalUtf8Bytes: 0,
          truncatedPrefix: false,
        },
        reasoningSummaryVerified: false,
        tools: [],
        providerSubagents: { agents: [], overflowCount: 0 },
        routing: directRootTurnRouting(prompt, pane.turn?.routing ?? null),
      },
      attention: null,
      recoverablePrompt: false,
    };
  }

  #setHarness(
    harness: HarnessSnapshot,
    panes: readonly ChatPaneProjection[] = this.#snapshot.chat.panes,
  ): void {
    const chat = panes === this.#snapshot.chat.panes
      ? this.#snapshot.chat
      : {
          revision: this.#snapshot.chat.revision + 1,
          panes: [...panes],
        };
    this.#emitOwnedEvent(
      { type: "snapshot.invalidated", reason: "harnessChanged" },
      { ...this.#snapshot, chat, harness },
      true,
    );
  }

  #upsertChatPane(pane: ChatPaneProjection): void {
    const existing = this.#snapshot.chat.panes.findIndex(({ id }) => id === pane.id);
    const panes = existing < 0
      ? [...this.#snapshot.chat.panes, pane]
      : this.#snapshot.chat.panes.map((candidate, index) => index === existing ? pane : candidate);
    this.#emitOwnedEvent(
      { type: "chat.pane.upserted", revision: pane.revision, pane },
      {
        ...this.#snapshot,
        chat: { revision: this.#snapshot.chat.revision + 1, panes },
      },
    );
  }

  #changeChatPaneState(pane: ChatPaneProjection): void {
    const existing = this.#snapshot.chat.panes.findIndex(({ id }) => id === pane.id);
    if (existing < 0) throw new Error(`Unknown fixture pane: ${pane.id}`);
    const panes = this.#snapshot.chat.panes.map((candidate, index) =>
      index === existing ? pane : candidate
    );
    const event = runtimeChatPaneStateChangedEvent(this.#snapshot.lastSequence + 1, pane);
    this.#emitOwnedEvent(
      event,
      {
        ...this.#snapshot,
        chat: { revision: this.#snapshot.chat.revision + 1, panes },
      },
      event.type === "snapshot.invalidated",
    );
  }

  #changeChatMessageQueue(pane: ChatPaneProjection): void {
    const existing = this.#snapshot.chat.panes.findIndex(({ id }) => id === pane.id);
    if (existing < 0) throw new Error(`Unknown fixture pane: ${pane.id}`);
    const panes = this.#snapshot.chat.panes.map((candidate, index) =>
      index === existing ? pane : candidate
    );
    this.#emitOwnedEvent(
      {
        type: "chat.messageQueue.changed",
        paneId: pane.id,
        revision: pane.messageQueue.revision,
      },
      {
        ...this.#snapshot,
        chat: { revision: this.#snapshot.chat.revision + 1, panes },
      },
      true,
    );
  }

  #removeChatPane(pane: ChatPaneProjection): void {
    this.#emitOwnedEvent(
      {
        type: "chat.pane.removed",
        paneId: pane.id,
        revision: pane.revision + 1,
      },
      {
        ...this.#snapshot,
        chat: {
          revision: this.#snapshot.chat.revision + 1,
          panes: this.#snapshot.chat.panes.filter(({ id }) => id !== pane.id),
        },
      },
    );
  }

  #requireAccount(accountProfileId: string): AccountSummary {
    const account = this.#snapshot.accounts.find(({ id }) => id === accountProfileId);
    if (account === undefined) throw new Error(`Unknown fixture account: ${accountProfileId}`);
    return account;
  }

  #requireRetainedData(accountProfileId: string): RetainedAccountLocalData {
    const retained = this.#snapshot.retainedAccountLocalData.find(({ id }) => id === accountProfileId);
    if (retained === undefined) throw new Error(`Unknown retained fixture account: ${accountProfileId}`);
    return retained;
  }

  #upsertAccount(account: AccountSummary): void {
    const existing = this.#snapshot.accounts.findIndex(({ id }) => id === account.id);
    const accounts = existing < 0
      ? [...this.#snapshot.accounts, account]
      : this.#snapshot.accounts.map((candidate, index) => index === existing ? account : candidate);
    this.#emitOwnedEvent({ type: "account.upserted", account }, { ...this.#snapshot, accounts });
  }

  #removeAccount(accountProfileId: string): void {
    this.#emitOwnedEvent(
      { type: "account.removed", accountProfileId },
      {
        ...this.#snapshot,
        accounts: this.#snapshot.accounts.filter(({ id }) => id !== accountProfileId),
      },
    );
  }

  #upsertRetainedData(localData: RetainedAccountLocalData): void {
    const existing = this.#snapshot.retainedAccountLocalData.findIndex(({ id }) => id === localData.id);
    const retainedAccountLocalData = existing < 0
      ? [...this.#snapshot.retainedAccountLocalData, localData]
      : this.#snapshot.retainedAccountLocalData.map((candidate, index) => (
          index === existing ? localData : candidate
        ));
    this.#emitOwnedEvent(
      { type: "accountLocalData.upserted", localData },
      { ...this.#snapshot, retainedAccountLocalData },
    );
  }

  #removeRetainedData(accountProfileId: string): void {
    this.#emitOwnedEvent(
      { type: "accountLocalData.removed", accountProfileId },
      {
        ...this.#snapshot,
        retainedAccountLocalData: this.#snapshot.retainedAccountLocalData.filter(
          ({ id }) => id !== accountProfileId,
        ),
      },
    );
  }

  #setHumanAccount(humanAccount: RuntimeSnapshot["humanAccount"]): void {
    this.#emitOwnedEvent(
      { type: "humanAccount.changed", humanAccount },
      { ...this.#snapshot, humanAccount },
    );
  }

  #setSessionSyncStatus(status: SessionSyncStatusProjection): void {
    this.#emitOwnedEvent(
      { type: "sessionSync.statusChanged", status },
      {
        ...this.#snapshot,
        sessionSync: {
          status,
          localGridSlots: this.#snapshot.sessionSync.localGridSlots,
          remoteSessions: status.state === "active"
            ? this.#snapshot.sessionSync.remoteSessions
            : [],
        },
      },
    );
  }

  #removeRemoteSession(
    sessionId: RuntimeSnapshot["sessionSync"]["remoteSessions"][number]["sessionId"],
  ): void {
    this.#emitOwnedEvent(
      { type: "sessionSync.remote.removed", sessionId },
      {
        ...this.#snapshot,
        sessionSync: {
          ...this.#snapshot.sessionSync,
          remoteSessions: this.#snapshot.sessionSync.remoteSessions.filter(
            (session) => session.sessionId !== sessionId,
          ),
        },
      },
    );
  }

  #emitOwnedEvent(
    event: RuntimeEvent["event"],
    nextSnapshot: RuntimeSnapshot,
    authoritativeResnapshot = false,
  ): void {
    const sequence = this.#snapshot.lastSequence + 1;
    this.#snapshot = {
      ...nextSnapshot,
      revision: nextSnapshot.revision + 1,
      lastSequence: sequence,
    };
    if (authoritativeResnapshot || this.#ownedSnapshotOverride !== null) {
      this.#ownedSnapshotOverride = structuredClone(this.#snapshot);
    }
    const message: RuntimeEvent = { version: runtimeProtocolVersion, sequence, event };
    for (const listener of this.#listeners) listener(structuredClone(message));
  }

  #unreachable(value: never): never {
    throw new Error(`Unhandled Direct command: ${JSON.stringify(value)}`);
  }
}

export function createHRADirectTransport(
  worldInput: HRADirectWorld,
  runtimeSnapshot: LogicalRuntimeSnapshot,
): HRADirectTransportHarness {
  const world = parseHRADirectWorld(worldInput);
  const store = required(createDirectStore(world, parseHRADirectWorld));
  const logical = createLogicalRuntime(runtimeSnapshot);
  const activity = createDirectActivityScope(store, logical);
  const implementation = new DeterministicRuntimeTransport(world, logical, activity);
  return Object.freeze({
    transport: implementation.transport,
    store,
    logical,
    activity,
    dispose: () => implementation.dispose(),
    emitTaskStateInvalidation: (
      taskStateId: string,
      invalidation: PortableInvalidation,
    ) => implementation.emitTaskStateInvalidation(taskStateId, invalidation),
    emitTransportLifecycle: (lifecycle: RuntimeTransportLifecycle) =>
      implementation.emitTransportLifecycle(lifecycle),
    getSnapshot: () => implementation.getSnapshot(),
    recordBlockedNetworkRequest: () => implementation.recordBlockedNetworkRequest(),
  });
}

/** Build the product transport from resources owned by one Direct session. */
export function createHRADirectSessionTransport(
  context: DirectSessionContext<HRADirectWorld, HRADirectRoute>,
): HRADirectTransportHarness {
  const implementation = new DeterministicRuntimeTransport(
    context.world,
    context.clock,
    context.activity,
  );
  const dispose = (): undefined => {
    implementation.dispose();
    return undefined;
  };
  context.onDispose(dispose);
  return Object.freeze({
    transport: implementation.transport,
    store: context.store,
    logical: context.clock,
    activity: context.activity,
    dispose,
    emitTaskStateInvalidation: (
      taskStateId: string,
      invalidation: PortableInvalidation,
    ) => implementation.emitTaskStateInvalidation(taskStateId, invalidation),
    emitTransportLifecycle: (lifecycle: RuntimeTransportLifecycle) =>
      implementation.emitTransportLifecycle(lifecycle),
    getSnapshot: () => implementation.getSnapshot(),
    recordBlockedNetworkRequest: () => implementation.recordBlockedNetworkRequest(),
  });
}
