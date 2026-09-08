import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";

import {
  canonicalJson,
  canonicalSha256,
  parseOhOperationV1,
  parseOhSyncBundleV1,
  type OhOperationV1,
} from "@hraness/oh";
import {
  emptyOhHeadV1,
  isOhConflictError,
  isOhDependencyError,
  isOhIntegrityError,
  parseOhHeadRefV1,
  type OhHeadV1,
} from "@hraness/oh/store";
import { parseOhMemoryPageRecordV1 } from "@hraness/oh/memory";
import { z } from "zod";

import {
  canonicalMemoryBindingDigest,
  decryptCanonicalMemoryDescriptor,
  decryptCanonicalMemoryOperation,
  decryptCanonicalMemoryTerminalHeadProof,
  deriveCanonicalMemoryGenesisToken,
  deriveCanonicalMemoryHeadToken,
  deriveCanonicalMemoryHostedSpaceId,
  encryptCanonicalMemoryAdoptionProof,
  encryptCanonicalMemoryDescriptor,
  encryptCanonicalMemoryOperation,
  encryptCanonicalMemoryTerminalHeadProof,
  generateCanonicalMemorySpaceKey,
  unwrapCanonicalMemorySpaceKey,
  wrapCanonicalMemorySpaceKey,
  type CanonicalMemoryAdoptionProofV1,
  type CanonicalMemoryBinding,
} from "./canonical-memory-crypto.ts";
import {
  CanonicalMemoryTransportError,
  type CanonicalMemoryTransport,
} from "./canonical-memory-transport.ts";
import type {
  CanonicalMemoryCloudAuthority,
  CanonicalMemoryCloudAuthoritySource,
} from "./local-control.ts";
import type {
  CanonicalMemoryCreateResult,
  CanonicalMemoryOperation,
  CanonicalMemorySpaceConfiguration,
} from "./memory-sync-contracts.ts";
import type {
  CanonicalMemoryHostedCreateResult,
  CanonicalMemoryHostedSpace,
  CanonicalMemorySyncReason,
  CanonicalMemorySyncResult,
  HraCanonicalMemorySyncPort,
} from "../daemon/canonical-memory-sync.ts";
import type { ProjectMemorySerialExecutor } from "../daemon/project-memory-serial.ts";
import {
  createPortableProjectMemoryCanonicalIdentity,
  deriveProjectMemoryCanonicalIdentity,
  PROJECT_MEMORY_EMPTY_HEAD,
} from "../domain/project-memory.ts";
import {
  memoryPageContentDigest,
  memoryPageKeyDigest,
  memoryPageUserKey,
} from "../domain/memory-page.ts";
import { projectIdSchema, type ProjectId } from "../domain/values.ts";
import {
  digestOhHead,
  inspectOhCanonicalDatabaseForRecovery,
  type OhCanonicalReplicationOperationResult,
  type OpenOhCanonicalReplication,
  type OhSqliteFactsMemoryEngine,
} from "../storage/oh-facts-memory-engine.ts";
import { ensurePrivateDirectory, type StatePaths } from "../storage/paths.ts";
import {
  type CanonicalMemoryHostedAttachmentRecord,
  type CanonicalMemoryHostedCreateIntentRecord,
  type CanonicalMemoryHostedCreateRequest,
  type CanonicalMemoryHostedCreateWinner,
  type CanonicalMemoryHostedRemoteObservation,
  type CanonicalMemoryPortableAdoptionProof,
  type CanonicalMemoryPortableAdoptionProofRecord,
  type CanonicalMemorySyncIntentRecord,
  type ProjectMemoryAuthorityRecord,
  type ProjectMemoryHeadRef,
  type StateStore,
} from "../storage/state-store.ts";

const MAXIMUM_OPERATIONS_PER_FOREGROUND_SYNC = 256;
export const CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS = 15_000;
export const CANONICAL_MEMORY_BACKGROUND_SYNC_BACKOFF_MAX_MS = 5 * 60_000;
const MAXIMUM_BACKGROUND_FAILURE_EXPONENT = 20;
const BACKGROUND_SYNC_WAKE = Symbol("canonical-memory-background-sync-wake");

export type CanonicalMemoryBackgroundFailure = Readonly<{
  code:
    | "CANONICAL_MEMORY_BACKGROUND_CREATE_RECOVERY_FAILED"
    | "CANONICAL_MEMORY_BACKGROUND_INVENTORY_FAILED"
    | "CANONICAL_MEMORY_BACKGROUND_PROJECT_SYNC_FAILED"
    | "CANONICAL_MEMORY_BACKGROUND_SUPERVISOR_FAILED";
  consecutiveFailures: number;
  projectId: ProjectId | null;
}>;

type CanonicalMemoryBackgroundProjectState = {
  consecutiveFailures: number;
  nextAt: number;
};

type CanonicalMemoryBackgroundFailureStage = "create_recovery" | "project_sync";

class CanonicalMemoryBackgroundProjectError extends Error {
  readonly stage: CanonicalMemoryBackgroundFailureStage;

  constructor(stage: CanonicalMemoryBackgroundFailureStage, cause: unknown) {
    super("Canonical memory background project operation failed.", { cause });
    this.name = "CanonicalMemoryBackgroundProjectError";
    this.stage = stage;
  }
}

export const sleepForCanonicalMemoryBackgroundSync = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolveSleep, rejectSleep) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectSleep(signal.reason));
    const timer = setTimeout(() => finish(resolveSleep), milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

type LoadedRemote = Readonly<{
  binding: CanonicalMemoryBinding;
  configuration: CanonicalMemorySpaceConfiguration;
  fullHead: OhHeadV1;
  observation: CanonicalMemoryHostedRemoteObservation;
  spaceKey: Uint8Array;
}>;

type PreparedSync = Readonly<{
  intent: CanonicalMemorySyncIntentRecord;
  localFullHead: OhHeadV1;
}>;

type PushPreparationDraft = Readonly<{
  attachmentGeneration: number;
  attachmentRevision: number;
  authorityHead: ProjectMemoryHeadRef;
  authorityRevision: number;
  exported: OhOperationV1;
  localFullHead: OhHeadV1;
  localHeadToken: string;
  portableAdoptionProof: CanonicalMemoryPortableAdoptionProofRecord | null;
}>;

type HostedCreateDriveResult = Readonly<{
  intent: CanonicalMemoryHostedCreateIntentRecord;
  replay: boolean;
}>;

class CanonicalMemoryRemoteStateError extends Error {
  readonly diagnosticCode: string;

  constructor(diagnosticCode: string, cause?: unknown) {
    super(diagnosticCode, cause === undefined ? undefined : { cause });
    this.name = "CanonicalMemoryRemoteStateError";
    this.diagnosticCode = diagnosticCode;
  }
}

const sameProjectHead = (
  left: ProjectMemoryHeadRef,
  right: ProjectMemoryHeadRef,
): boolean => left.sequence === right.sequence
  && left.operationSha256 === right.operationSha256
  && left.headDigest === right.headDigest;

const sameRemoteObservation = (
  left: CanonicalMemoryHostedRemoteObservation,
  right: CanonicalMemoryHostedRemoteObservation,
): boolean => left.genesisToken === right.genesisToken
  && sameProjectHead(left.head, right.head)
  && left.headProofDigest === right.headProofDigest
  && left.headToken === right.headToken
  && left.keyVersion === right.keyVersion
  && left.revision === right.revision;

const remoteObservationExtends = (
  pinned: CanonicalMemoryHostedRemoteObservation,
  current: CanonicalMemoryHostedRemoteObservation,
): boolean => current.genesisToken === pinned.genesisToken
  && current.keyVersion === pinned.keyVersion
  && current.revision === pinned.revision
  && (
    current.head.sequence > pinned.head.sequence
    || sameRemoteObservation(current, pinned)
  );

const toProjectHead = (head: OhHeadV1): ProjectMemoryHeadRef => ({
  headDigest: digestOhHead(head),
  operationSha256: head.operationSha256,
  sequence: head.sequence,
});

const toFactsHead = (head: ProjectMemoryHeadRef) => ({
  digest: head.headDigest,
  operationSha256: head.operationSha256,
  sequence: head.sequence,
});

const toOhHeadRef = (head: OhHeadV1) => {
  const parsed = parseOhHeadRefV1({
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  });
  if (parsed === null) throw new Error("CANONICAL_MEMORY_HEAD_INVALID");
  return parsed;
};

const headToken = async (
  binding: CanonicalMemoryBinding,
  head: OhHeadV1,
  spaceKey: Uint8Array,
): Promise<string> => head.sequence === 0
  ? await deriveCanonicalMemoryGenesisToken({ authority: binding, head, spaceKey })
  : await deriveCanonicalMemoryHeadToken({ authority: binding, head, spaceKey });

const proofDigest = (value: unknown): string => canonicalSha256({
  contract: "hra.canonical-memory.encrypted-head-proof.v1",
  envelope: value,
});

const toWireOperation = (
  operation: NonNullable<CanonicalMemorySyncIntentRecord["requestOperation"]>,
): CanonicalMemoryOperation => ({
    adoptionProof: operation.adoptionProof,
    genesisToken: operation.genesisToken,
    headToken: operation.headToken,
    operation: operation.operation,
    priorToken: operation.priorToken,
    sequence: operation.sequence,
    terminalHeadProof: operation.terminalHeadProof,
  });

const wireOperation = (intent: CanonicalMemorySyncIntentRecord): CanonicalMemoryOperation => {
  const operation = intent.requestOperation;
  if (operation === undefined) throw new Error("CANONICAL_MEMORY_SYNC_REQUEST_MISSING");
  return toWireOperation(operation);
};

const sameWireOperation = (
  left: CanonicalMemoryOperation,
  right: CanonicalMemoryOperation,
): boolean => canonicalJson(left) === canonicalJson(right);

const createRequestFromConfiguration = (
  configuration: CanonicalMemorySpaceConfiguration,
): CanonicalMemoryHostedCreateRequest => ({
  bindingPolicy: configuration.bindingPolicy,
  encryptedDescriptor: configuration.encryptedDescriptor,
  genesisHeadProof: configuration.genesisHeadProof,
  genesisToken: configuration.genesisToken,
  identityContract: configuration.identityContract,
  keyVersion: configuration.keyVersion,
  spaceId: configuration.spaceId,
  wrappedSpaceKey: configuration.wrappedSpaceKey,
});

const configurationMatchesCreateRequest = (
  configuration: CanonicalMemorySpaceConfiguration,
  request: CanonicalMemoryHostedCreateRequest,
): boolean => configuration.revision === 1
  && canonicalJson(createRequestFromConfiguration(configuration)) === canonicalJson(request);

const validatePortableAdoptionProof = (
  proof: CanonicalMemoryAdoptionProofV1,
  operation: OhOperationV1,
): CanonicalMemoryPortableAdoptionProof | null => {
  if (
    proof.operationSha256 !== operation.operationSha256
    || proof.sequence !== operation.sequence
    || operation.actorId !== "hra.memory.host"
  ) return null;
  const matchingPages = operation.changes.flatMap((change) => {
    if (change.kind !== "put") return [];
    const page = parseOhMemoryPageRecordV1(change.record);
    return page?.recordSha256 === proof.recordSha256 ? [page] : [];
  });
  if (matchingPages.length !== 1) return null;
  const page = matchingPages[0];
  const key = page === undefined ? null : memoryPageUserKey(page.key);
  if (
    page === undefined
    || key === null
    || page.dependencies.length !== 0
    || memoryPageKeyDigest(key) !== proof.keyDigest
    || memoryPageContentDigest({
      body: page.value.body,
      key,
      ...(page.value.language === null ? {} : { language: page.value.language }),
      summary: page.value.summary,
      title: page.value.title,
    }) !== proof.contentDigest
  ) return null;
  const { v: version, ...portable } = proof;
  void version;
  return portable;
};

export class HraCanonicalMemorySynchronizer implements HraCanonicalMemorySyncPort {
  readonly #authoritySource: CanonicalMemoryCloudAuthoritySource;
  readonly #backgroundBackoffMaxMs: number;
  readonly #backgroundIntervalMs: number;
  readonly #backgroundNow: () => number;
  readonly #backgroundProjectStates = new Map<ProjectId, CanonicalMemoryBackgroundProjectState>();
  readonly #backgroundSleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #onBackgroundFailure: (failure: CanonicalMemoryBackgroundFailure) => void;
  readonly #scheduledBackgroundProjects = new Set<ProjectId>();
  readonly #engine: OhSqliteFactsMemoryEngine;
  readonly #lifetime = new AbortController();
  #backgroundRecoveryStarted = false;
  #backgroundSleepAbort: AbortController | undefined;
  #backgroundSupervisorFailed = false;
  #backgroundTask: Promise<void> | undefined;
  #backgroundWakeRevision = 0;
  #networkTail: Promise<unknown> = Promise.resolve();
  readonly #paths: StatePaths;
  readonly #projectSerial: ProjectMemorySerialExecutor;
  readonly #store: StateStore;
  #closed = false;

  constructor(input: Readonly<{
    authoritySource: CanonicalMemoryCloudAuthoritySource;
    backgroundBackoffMaxMs?: number;
    backgroundIntervalMs?: number;
    backgroundNow?: () => number;
    backgroundSleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    engine: OhSqliteFactsMemoryEngine;
    onBackgroundFailure?: (failure: CanonicalMemoryBackgroundFailure) => void;
    paths: StatePaths;
    projectSerial: ProjectMemorySerialExecutor;
    store: StateStore;
  }>) {
    this.#authoritySource = input.authoritySource;
    this.#backgroundBackoffMaxMs = input.backgroundBackoffMaxMs
      ?? CANONICAL_MEMORY_BACKGROUND_SYNC_BACKOFF_MAX_MS;
    this.#backgroundIntervalMs = input.backgroundIntervalMs
      ?? CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.#backgroundIntervalMs)
      || this.#backgroundIntervalMs <= 0
      || !Number.isSafeInteger(this.#backgroundBackoffMaxMs)
      || this.#backgroundBackoffMaxMs < this.#backgroundIntervalMs
    ) throw new TypeError("CANONICAL_MEMORY_BACKGROUND_INTERVAL_INVALID");
    this.#backgroundNow = input.backgroundNow ?? Date.now;
    this.#backgroundSleep = input.backgroundSleep ?? sleepForCanonicalMemoryBackgroundSync;
    this.#engine = input.engine;
    this.#onBackgroundFailure = input.onBackgroundFailure ?? (() => undefined);
    this.#paths = input.paths;
    this.#projectSerial = input.projectSerial;
    this.#store = input.store;
  }

  async createHostedSpace(input: Readonly<{
    idempotencyKey: string;
    projectId: string;
  }>): Promise<CanonicalMemoryHostedCreateResult> {
    const projectId = projectIdSchema.parse(input.projectId);
    if (this.#closed) throw new Error("CANONICAL_MEMORY_SYNC_CLOSED");
    return await this.#serializeNetwork(async () => {
      const created = await this.#createHostedSpace(
        projectId,
        input.idempotencyKey,
      );
      // Creation attaches an empty hosted genesis. Converge any canonical
      // operations that already existed before ownership was requested while
      // the same network turn operation still owns the lifecycle fence.
      await this.#synchronizeProject(projectId);
      const authority = this.#requireAuthority(projectId);
      const attachment = this.#requireAttachment(projectId);
      return {
        attachment,
        canonicalSpaceId: authority.canonicalSpaceId,
        hostedSpaceId: created.intent.remoteSpaceId,
        projectId,
        replay: created.replay,
      };
    });
  }

  synchronizeProject(input: Readonly<{
    projectId: string;
    reason: CanonicalMemorySyncReason;
  }>): Promise<CanonicalMemorySyncResult> {
    const projectId = projectIdSchema.parse(input.projectId);
    void input.reason;
    if (this.#closed) return Promise.reject(new Error("CANONICAL_MEMORY_SYNC_CLOSED"));
    return this.#serializeNetwork(async () =>
      await this.#synchronizeProject(projectId));
  }

  scheduleProject(input: Readonly<{
    projectId: string;
    reason: Exclude<CanonicalMemorySyncReason, "before_canonical_mutation" | "owner">;
  }>): void {
    if (this.#closed) return;
    const projectId = projectIdSchema.parse(input.projectId);
    void input.reason;
    this.#scheduledBackgroundProjects.add(projectId);
    const state = this.#backgroundProjectStates.get(projectId);
    if (state === undefined) {
      this.#backgroundProjectStates.set(projectId, {
        consecutiveFailures: 0,
        nextAt: this.#backgroundNow(),
      });
    } else {
      state.nextAt = this.#backgroundNow();
    }
    this.#backgroundSupervisorFailed = false;
    this.#wakeBackground();
    this.#ensureBackgroundTask();
  }

  startBackgroundRecovery(): void {
    if (this.#closed) return;
    this.#backgroundRecoveryStarted = true;
    this.#backgroundSupervisorFailed = false;
    this.#wakeBackground();
    this.#ensureBackgroundTask();
  }

  async listHostedSpaces(): Promise<readonly CanonicalMemoryHostedSpace[]> {
    if (this.#closed) throw new Error("CANONICAL_MEMORY_SYNC_CLOSED");
    return await this.#serializeNetwork(async () => {
      const cloud = await this.#authoritySource.snapshotCanonicalMemoryAuthority(
        this.#lifetime.signal,
      );
      try {
        const summaries = await cloud.transport.list();
        const attachments = new Map(this.#store.listProjects().flatMap((project) => {
          const attachment = this.#store.readCanonicalMemoryHostedAttachment(project.id);
          return attachment?.state === "attached"
            ? [[attachment.remoteSpaceId, project.id] as const]
            : [];
        }));
        const spaces: CanonicalMemoryHostedSpace[] = [];
        for (const summary of summaries) {
          const loaded = await this.#loadRemote(cloud, summary.spaceId);
          try {
            if (
              summary.keyVersion !== loaded.configuration.keyVersion
              || summary.revision !== loaded.configuration.revision
            ) throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_LIST_CONFLICT");
            spaces.push({
              attachedProjectId: attachments.get(summary.spaceId) ?? null,
              canonicalSpaceId: loaded.binding.canonicalSpaceId,
              hostedSpaceId: summary.spaceId,
              keyVersion: loaded.configuration.keyVersion,
              revision: loaded.configuration.revision,
            });
          } finally {
            loaded.spaceKey.fill(0);
          }
        }
        return spaces;
      } finally {
        cloud.dispose();
      }
    });
  }

  async attachHostedSpace(input: Readonly<{
    hostedSpaceId: string;
    projectId: string;
  }>): Promise<CanonicalMemoryHostedAttachmentRecord> {
    const projectId = projectIdSchema.parse(input.projectId);
    if (this.#closed) throw new Error("CANONICAL_MEMORY_SYNC_CLOSED");
    const attached = await this.#serializeNetwork(async () => {
      const cloud = await this.#authoritySource.snapshotCanonicalMemoryAuthority(
        this.#lifetime.signal,
      );
      try {
        const loaded = await this.#loadRemote(cloud, input.hostedSpaceId);
        try {
          return await this.#projectSerial.run(projectId, async () => {
            if (this.#store.readProjectMemoryAuthority(projectId) === null) {
              this.#assertCanonicalDatabaseVacantForPortableReservation(projectId);
            }
            return this.#store.attachCanonicalMemoryHostedSpace({
              accountBindingDigest: cloud.accountBindingDigest,
              canonicalSpaceId: loaded.binding.canonicalSpaceId,
              projectId,
              remote: loaded.observation,
              remoteSpaceId: loaded.binding.hostedSpaceId,
            });
          });
        } finally {
          loaded.spaceKey.fill(0);
        }
      } finally {
        cloud.dispose();
      }
    });
    await this.synchronizeProject({ projectId, reason: "owner" });
    return this.#store.readCanonicalMemoryHostedAttachment(projectId) ?? attached;
  }

  async detachHostedSpace(input: Readonly<{
    expectedGeneration: number;
    projectId: string;
  }>): Promise<CanonicalMemoryHostedAttachmentRecord> {
    const projectId = projectIdSchema.parse(input.projectId);
    if (this.#closed) throw new Error("CANONICAL_MEMORY_SYNC_CLOSED");
    return await this.#projectSerial.run(projectId, async () =>
      this.#store.detachCanonicalMemoryHostedSpace({
        expectedGeneration: input.expectedGeneration,
        projectId,
      }));
  }

  async recover(): Promise<void> {
    if (this.#closed) throw new Error("CANONICAL_MEMORY_SYNC_CLOSED");
    // Enqueue the whole recovery sweep as one lifecycle unit. close() captures
    // this exact tail, so recovery cannot append work after the shutdown barrier
    // has already selected the promise it will join.
    await this.#serializeNetwork(async () => {
      // A create journal fences canonical mutation and may be the only durable
      // evidence that a lost create response won remotely. Resolve all creates
      // before treating newly attached spaces as ordinary sync participants.
      for (const project of this.#store.listProjects()) {
        const intent = this.#store.readUnresolvedCanonicalMemoryHostedCreateIntent(
          project.id,
        );
        if (intent === null) continue;
        await this.#recoverHostedCreate(intent);
      }
      for (const project of this.#store.listProjects()) {
        const attachment = this.#store.readCanonicalMemoryHostedAttachment(project.id);
        if (attachment?.state !== "attached") continue;
        await this.#synchronizeProject(project.id);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new Error("Canonical memory synchronizer stopped."));
    this.#backgroundSleepAbort?.abort(this.#lifetime.signal.reason);
    await Promise.allSettled([
      ...(this.#backgroundTask === undefined ? [] : [this.#backgroundTask]),
      this.#networkTail,
    ]);
    await this.#projectSerial.drain();
  }

  async #createHostedSpace(
    projectId: ProjectId,
    idempotencyKeyValue: string,
  ): Promise<HostedCreateDriveResult> {
    const idempotencyKey = z.string().uuid().parse(idempotencyKeyValue);
    const authority = await this.#projectSerial.run(projectId, async () => {
      let current = this.#store.readProjectMemoryAuthority(projectId);
      if (current === null) {
        this.#assertCanonicalDatabaseVacantForPortableReservation(projectId);
        const candidate = createPortableProjectMemoryCanonicalIdentity(projectId);
        current = this.#store.reserveProjectMemoryAuthority({
          canonicalSpaceId: candidate.canonicalSpaceId,
          head: PROJECT_MEMORY_EMPTY_HEAD,
          identityContract: candidate.identityContract,
          projectId,
        });
      }
      return await this.#ensureInitialized(projectId);
    });
    const cloud = await this.#authoritySource.snapshotCanonicalMemoryAuthority(
      this.#lifetime.signal,
    );
    try {
      const hostedSpaceId = await deriveCanonicalMemoryHostedSpaceId({
        accountBindingDigest: cloud.accountBindingDigest,
        canonicalSpaceId: authority.canonicalSpaceId,
      });
      await cloud.assertCurrent();
      const allocation = await this.#projectSerial.run(projectId, async () => {
        const current = this.#requireAuthority(projectId);
        if (
          current.canonicalSpaceId !== authority.canonicalSpaceId
          || current.bindingDigest !== authority.bindingDigest
        ) throw new Error("CANONICAL_MEMORY_HOSTED_CREATE_AUTHORITY_CONFLICT");
        return this.#store.allocateCanonicalMemoryHostedCreate({
          accountBindingDigest: cloud.accountBindingDigest,
          idempotencyKey,
          projectId,
          remoteSpaceId: hostedSpaceId,
        });
      });
      const intent = await this.#driveHostedCreate(cloud, allocation.record);
      return { intent, replay: allocation.replay };
    } finally {
      cloud.dispose();
    }
  }

  async #recoverHostedCreate(
    initial: CanonicalMemoryHostedCreateIntentRecord,
  ): Promise<void> {
    const cloud = await this.#authoritySource.snapshotCanonicalMemoryAuthority(
      this.#lifetime.signal,
    );
    try {
      if (initial.accountBindingDigest !== cloud.accountBindingDigest) {
        throw new Error("CANONICAL_MEMORY_ACCOUNT_BINDING_MISMATCH");
      }
      const authority = this.#requireAuthority(initial.projectId);
      if (authority.bindingDigest !== initial.canonicalBindingDigest) {
        throw new Error("CANONICAL_MEMORY_HOSTED_CREATE_AUTHORITY_CONFLICT");
      }
      const hostedSpaceId = await deriveCanonicalMemoryHostedSpaceId({
        accountBindingDigest: cloud.accountBindingDigest,
        canonicalSpaceId: authority.canonicalSpaceId,
      });
      if (hostedSpaceId !== initial.remoteSpaceId) {
        await this.#failHostedCreate(
          cloud,
          initial,
          "LOCAL_MEMORY_CREATE_ROUTE_CONFLICT",
          "error",
        );
      }
      await this.#driveHostedCreate(cloud, initial);
    } finally {
      cloud.dispose();
    }
  }

  async #driveHostedCreate(
    cloud: CanonicalMemoryCloudAuthority,
    initial: CanonicalMemoryHostedCreateIntentRecord,
  ): Promise<CanonicalMemoryHostedCreateIntentRecord> {
    let intent = initial;
    if (intent.accountBindingDigest !== cloud.accountBindingDigest) {
      throw new Error("CANONICAL_MEMORY_ACCOUNT_BINDING_MISMATCH");
    }
    for (let transition = 0; transition < 8; transition += 1) {
      if (intent.state === "settled") return intent;
      if (intent.state === "conflict" || intent.state === "error") {
        throw new Error(intent.diagnosticCode ?? "CANONICAL_MEMORY_HOSTED_CREATE_FROZEN");
      }
      if (intent.state === "allocating") {
        intent = await this.#stageHostedCreateKey(cloud, intent);
        continue;
      }
      if (intent.state === "key_staged") {
        intent = await this.#prepareHostedCreate(cloud, intent);
        continue;
      }
      if (intent.state === "prepared") {
        await cloud.assertCurrent();
        intent = await this.#projectSerial.run(intent.projectId, async () =>
          this.#store.markCanonicalMemoryHostedCreateEffectStarted(intent.id));
        intent = await this.#dispatchHostedCreate(cloud, intent);
        continue;
      }
      if (intent.state === "effect_started") {
        intent = await this.#reconcileHostedCreate(cloud, intent);
        continue;
      }
      await cloud.assertCurrent();
      intent = await this.#projectSerial.run(intent.projectId, async () =>
        this.#store.settleCanonicalMemoryHostedCreate(intent.id));
    }
    throw new Error("CANONICAL_MEMORY_HOSTED_CREATE_TRANSITION_LIMIT");
  }

  async #stageHostedCreateKey(
    cloud: CanonicalMemoryCloudAuthority,
    intent: CanonicalMemoryHostedCreateIntentRecord,
  ): Promise<CanonicalMemoryHostedCreateIntentRecord> {
    const spaceKey = generateCanonicalMemorySpaceKey();
    const wrappingKey = Uint8Array.from(spaceKey);
    let encryptionKey: Awaited<ReturnType<CanonicalMemoryCloudAuthority["openEncryptionKey"]>>
      | undefined;
    try {
      encryptionKey = await cloud.openEncryptionKey({
        bytes: cloud.accountKey.bytes,
        keyVersion: cloud.accountKey.keyVersion,
        usage: { kind: "account_data" },
      });
      const wrappedSpaceKey = await wrapCanonicalMemorySpaceKey({
        authority: {
          accountKeyVersion: cloud.accountKey.keyVersion,
          hostedSpaceId: intent.remoteSpaceId,
          spaceKeyVersion: 1,
        },
        encryptionKey,
        spaceKey: wrappingKey,
      });
      await cloud.assertCurrent();
      return await this.#projectSerial.run(intent.projectId, async () =>
        this.#store.stageCanonicalMemoryHostedCreateKey({
          intentId: intent.id,
          keyVersion: 1,
          wrappedSpaceKey,
        }));
    } finally {
      encryptionKey?.dispose();
      wrappingKey.fill(0);
      spaceKey.fill(0);
    }
  }

  async #prepareHostedCreate(
    cloud: CanonicalMemoryCloudAuthority,
    intent: CanonicalMemoryHostedCreateIntentRecord,
  ): Promise<CanonicalMemoryHostedCreateIntentRecord> {
    if (intent.keyVersion === undefined || intent.wrappedSpaceKey === undefined) {
      throw new Error("CANONICAL_MEMORY_HOSTED_CREATE_KEY_MISSING");
    }
    const spaceKey = await unwrapCanonicalMemorySpaceKey({
      accountKey: cloud.accountKey.bytes,
      authority: {
        accountKeyVersion: intent.wrappedSpaceKey.keyVersion,
        hostedSpaceId: intent.remoteSpaceId,
        spaceKeyVersion: intent.keyVersion,
      },
      envelope: intent.wrappedSpaceKey,
    });
    let encryptionKey: Awaited<ReturnType<CanonicalMemoryCloudAuthority["openEncryptionKey"]>>
      | undefined;
    try {
      encryptionKey = await cloud.openEncryptionKey({
        bytes: spaceKey,
        keyVersion: intent.keyVersion,
        usage: { hostedSpaceId: intent.remoteSpaceId, kind: "space" },
      });
      const binding: CanonicalMemoryBinding = {
        bindingDigest: intent.canonicalBindingDigest,
        canonicalSpaceId: this.#requireAuthority(intent.projectId).canonicalSpaceId,
        hostedSpaceId: intent.remoteSpaceId,
        keyVersion: intent.keyVersion,
      };
      const genesis = emptyOhHeadV1();
      const genesisToken = await deriveCanonicalMemoryGenesisToken({
        authority: binding,
        head: genesis,
        spaceKey,
      });
      const request: CanonicalMemoryHostedCreateRequest = {
        bindingPolicy: "one_project_one_space",
        encryptedDescriptor: await encryptCanonicalMemoryDescriptor({
          authority: binding,
          encryptionKey,
        }),
        genesisHeadProof: await encryptCanonicalMemoryTerminalHeadProof({
          authority: binding,
          encryptionKey,
          head: genesis,
          headToken: genesisToken,
        }),
        genesisToken,
        identityContract: 2,
        keyVersion: intent.keyVersion,
        spaceId: intent.remoteSpaceId,
        wrappedSpaceKey: intent.wrappedSpaceKey,
      };
      await cloud.assertCurrent();
      return await this.#projectSerial.run(intent.projectId, async () =>
        this.#store.prepareCanonicalMemoryHostedCreate({
          intentId: intent.id,
          request,
        }));
    } finally {
      encryptionKey?.dispose();
      spaceKey.fill(0);
    }
  }

  async #dispatchHostedCreate(
    cloud: CanonicalMemoryCloudAuthority,
    intent: CanonicalMemoryHostedCreateIntentRecord,
  ): Promise<CanonicalMemoryHostedCreateIntentRecord> {
    if (intent.request === undefined) {
      throw new Error("CANONICAL_MEMORY_HOSTED_CREATE_REQUEST_MISSING");
    }
    // One mutation attempt only. Any rejection remains indeterminate and the
    // effect_started journal is intentionally left recoverable.
    const winner = await cloud.transport.create(intent.request);
    return await this.#recordHostedCreateWinner(cloud, intent, winner);
  }

  async #reconcileHostedCreate(
    cloud: CanonicalMemoryCloudAuthority,
    intent: CanonicalMemoryHostedCreateIntentRecord,
  ): Promise<CanonicalMemoryHostedCreateIntentRecord> {
    if (intent.request === undefined) {
      throw new Error("CANONICAL_MEMORY_HOSTED_CREATE_REQUEST_MISSING");
    }
    let observed: CanonicalMemorySpaceConfiguration;
    try {
      observed = await cloud.transport.get({ spaceId: intent.remoteSpaceId });
    } catch (error: unknown) {
      if (
        error instanceof CanonicalMemoryTransportError
        && error.effect === "none"
        && error.category === "missing"
      ) {
        // A successful, authoritative absence proves the previous attempt did
        // not win. Re-submit the byte-identical durable request once.
        return await this.#dispatchHostedCreate(cloud, intent);
      }
      if (
        error instanceof CanonicalMemoryTransportError
        && error.effect === "none"
        && error.category !== "transport"
      ) {
        await this.#failHostedCreate(
          cloud,
          intent,
          "REMOTE_MEMORY_CREATE_CONFLICT",
          "conflict",
          error,
        );
      }
      throw error;
    }
    if (!configurationMatchesCreateRequest(observed, intent.request)) {
      await this.#failHostedCreate(
        cloud,
        intent,
        "REMOTE_MEMORY_CREATE_CONFLICT",
        "conflict",
      );
    }
    return await this.#recordHostedCreateWinner(cloud, intent, {
      ...observed,
      replay: true,
    });
  }

  async #recordHostedCreateWinner(
    cloud: CanonicalMemoryCloudAuthority,
    intent: CanonicalMemoryHostedCreateIntentRecord,
    winner: CanonicalMemoryCreateResult,
  ): Promise<CanonicalMemoryHostedCreateIntentRecord> {
    if (
      intent.request === undefined
      || !configurationMatchesCreateRequest(winner, intent.request)
    ) {
      await this.#failHostedCreate(
        cloud,
        intent,
        "REMOTE_MEMORY_CREATE_CONFLICT",
        "conflict",
      );
    }
    const durableWinner: CanonicalMemoryHostedCreateWinner = {
      ...createRequestFromConfiguration(winner),
      replay: winner.replay,
      revision: winner.revision,
    };
    await cloud.assertCurrent();
    return await this.#projectSerial.run(intent.projectId, async () =>
      this.#store.recordCanonicalMemoryHostedCreateWinner({
        intentId: intent.id,
        winner: durableWinner,
      }));
  }

  async #failHostedCreate(
    cloud: CanonicalMemoryCloudAuthority,
    intent: CanonicalMemoryHostedCreateIntentRecord,
    diagnosticCode: string,
    state: "conflict" | "error",
    cause?: unknown,
  ): Promise<never> {
    await cloud.assertCurrent();
    await this.#projectSerial.run(intent.projectId, async () => {
      this.#store.failCanonicalMemoryHostedCreate({
        diagnosticCode,
        intentId: intent.id,
        state,
      });
    });
    throw new CanonicalMemoryRemoteStateError(diagnosticCode, cause);
  }

  async #synchronizeProject(
    projectId: ProjectId,
  ): Promise<CanonicalMemorySyncResult> {
    const initialAttachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
    if (initialAttachment === null || initialAttachment.state === "detached") {
      return {
        attached: false,
        complete: true,
        localHead: this.#store.readProjectMemoryAuthority(projectId)?.head ?? null,
        operations: 0,
        projectId,
        remoteHead: null,
        state: "detached",
      };
    }
    if (initialAttachment.state !== "attached") {
      throw new Error("CANONICAL_MEMORY_HOSTED_ATTACHMENT_FROZEN");
    }

    const cloud = await this.#authoritySource.snapshotCanonicalMemoryAuthority(
      this.#lifetime.signal,
    );
    try {
      if (cloud.accountBindingDigest !== initialAttachment.accountBindingDigest) {
        throw new Error("CANONICAL_MEMORY_ACCOUNT_BINDING_MISMATCH");
      }
      await this.#projectSerial.run(projectId, async () => {
        await this.#ensureInitialized(projectId);
      });
      let operations = 0;
      while (operations < MAXIMUM_OPERATIONS_PER_FOREGROUND_SYNC) {
        const attachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
        if (attachment?.state !== "attached") {
          throw new Error("CANONICAL_MEMORY_HOSTED_ATTACHMENT_NOT_ACTIVE");
        }
        let loaded: LoadedRemote;
        try {
          loaded = await this.#loadRemote(cloud, attachment.remoteSpaceId, {
            bindingDigest: attachment.canonicalBindingDigest,
            canonicalSpaceId: this.#requireAuthority(projectId).canonicalSpaceId,
          });
        } catch (error: unknown) {
          if (error instanceof CanonicalMemoryRemoteStateError) {
            await this.#freezeRemoteState(projectId, error.diagnosticCode);
          }
          throw error;
        }
        try {
          const unresolved = this.#store.readUnresolvedCanonicalMemorySyncIntent(projectId);
          let prepared: PreparedSync | null;
          try {
            prepared = unresolved === null
              ? await this.#prepareNext(projectId, cloud, loaded)
              : await this.#resumePrepared(projectId, cloud, loaded, unresolved);
          } catch (error: unknown) {
            if (error instanceof CanonicalMemoryRemoteStateError) {
              await this.#freezeRemoteState(projectId, error.diagnosticCode);
            }
            throw error;
          }
          if (prepared === null) {
            const localHead = this.#requireAuthority(projectId).head;
            return {
              attached: true,
              complete: true,
              localHead,
              operations,
              projectId,
              remoteHead: loaded.observation.head,
              state: "converged",
            };
          }
          try {
            await this.#performAndSettle(projectId, cloud, loaded, prepared);
          } catch (error: unknown) {
            if (error instanceof CanonicalMemoryRemoteStateError) {
              await this.#freezeRemoteState(projectId, error.diagnosticCode);
            }
            throw error;
          }
          operations += 1;
        } finally {
          loaded.spaceKey.fill(0);
        }
      }
      const attachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
      return {
        attached: true,
        complete: false,
        localHead: this.#requireAuthority(projectId).head,
        operations,
        projectId,
        remoteHead: attachment?.remote.head ?? null,
        state: "incomplete",
      };
    } finally {
      cloud.dispose();
    }
  }

  async #loadRemote(
    cloud: CanonicalMemoryCloudAuthority,
    hostedSpaceId: string,
    expectedBinding?: Readonly<{ bindingDigest: string; canonicalSpaceId: string }>,
  ): Promise<LoadedRemote> {
    let configuration: CanonicalMemorySpaceConfiguration;
    let remoteHead: Awaited<ReturnType<CanonicalMemoryTransport["head"]>>;
    try {
      [configuration, remoteHead] = await Promise.all([
        cloud.transport.get({ spaceId: hostedSpaceId }),
        cloud.transport.head({ spaceId: hostedSpaceId }),
      ]);
    } catch (error: unknown) {
      if (
        error instanceof CanonicalMemoryTransportError
        && error.effect === "none"
        && error.category !== "transport"
      ) {
        throw new CanonicalMemoryRemoteStateError(
          error.category === "missing" ? "REMOTE_MEMORY_ERASED" : "REMOTE_MEMORY_INVALID",
          error,
        );
      }
      throw error;
    }
    if (
      configuration.spaceId !== hostedSpaceId
      || remoteHead.spaceId !== hostedSpaceId
      || configuration.keyVersion !== remoteHead.keyVersion
      || configuration.revision !== remoteHead.revision
      || configuration.genesisToken !== remoteHead.genesisToken
      || configuration.wrappedSpaceKey.keyVersion !== cloud.accountKey.keyVersion
    ) throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_CONFIGURATION_CONFLICT");
    let spaceKey: Uint8Array;
    try {
      spaceKey = await unwrapCanonicalMemorySpaceKey({
        accountKey: cloud.accountKey.bytes,
        authority: {
          accountKeyVersion: configuration.wrappedSpaceKey.keyVersion,
          hostedSpaceId,
          spaceKeyVersion: configuration.keyVersion,
        },
        envelope: configuration.wrappedSpaceKey,
      });
    } catch (error: unknown) {
      throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_KEY_CONFLICT", error);
    }
    try {
      const descriptor = await decryptCanonicalMemoryDescriptor({
        authority: { hostedSpaceId, keyVersion: configuration.keyVersion },
        envelope: configuration.encryptedDescriptor,
        ...(expectedBinding === undefined ? {} : { expectedBinding }),
        spaceKey,
      });
      const binding: CanonicalMemoryBinding = {
        bindingDigest: descriptor.bindingDigest,
        canonicalSpaceId: descriptor.canonicalSpaceId,
        hostedSpaceId,
        keyVersion: configuration.keyVersion,
      };
      if (
        binding.bindingDigest !== canonicalMemoryBindingDigest(binding.canonicalSpaceId)
        || (expectedBinding !== undefined
          && (binding.bindingDigest !== expectedBinding.bindingDigest
            || binding.canonicalSpaceId !== expectedBinding.canonicalSpaceId))
      ) throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_BINDING_CONFLICT");
      await decryptCanonicalMemoryTerminalHeadProof({
        authority: binding,
        envelope: configuration.genesisHeadProof,
        expectedHead: emptyOhHeadV1(),
        expectedHeadToken: configuration.genesisToken,
        expectedSequence: 0,
        spaceKey,
      });
      const terminal = await decryptCanonicalMemoryTerminalHeadProof({
        authority: binding,
        envelope: remoteHead.terminalHeadProof,
        expectedHeadToken: remoteHead.headToken,
        expectedSequence: remoteHead.sequence,
        spaceKey,
      });
      return {
        binding,
        configuration,
        fullHead: terminal.head,
        observation: {
          genesisToken: remoteHead.genesisToken,
          head: toProjectHead(terminal.head),
          headProofDigest: proofDigest(remoteHead.terminalHeadProof),
          headToken: remoteHead.headToken,
          keyVersion: remoteHead.keyVersion,
          revision: remoteHead.revision,
        },
        spaceKey,
      };
    } catch (error: unknown) {
      spaceKey.fill(0);
      throw error instanceof CanonicalMemoryRemoteStateError
        ? error
        : new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_INVALID", error);
    }
  }

  async #prepareNext(
    projectId: ProjectId,
    cloud: CanonicalMemoryCloudAuthority,
    loaded: LoadedRemote,
  ): Promise<PreparedSync | null> {
    const captured = await this.#projectSerial.run<PreparedSync | PushPreparationDraft | null>(
      projectId,
      async () => {
      await this.#ensureInitialized(projectId);
      let attachment = this.#requireAttachment(projectId);
      if (
        attachment.remoteSpaceId !== loaded.binding.hostedSpaceId
        || attachment.accountBindingDigest !== cloud.accountBindingDigest
        || attachment.canonicalBindingDigest !== loaded.binding.bindingDigest
      ) throw new Error("CANONICAL_MEMORY_SYNC_ATTACHMENT_CONFLICT");
      if (!sameRemoteObservation(attachment.remote, loaded.observation)) {
        attachment = this.#store.recordCanonicalMemoryHostedObservation({
          expectedGeneration: attachment.generation,
          expectedRevision: attachment.revision,
          projectId,
          remote: loaded.observation,
        });
      }
      const authority = this.#requireAuthority(projectId);
      const localFullHead = await this.#readFullLocalHead(projectId, authority);
      const localHead = toProjectHead(localFullHead);
      if (!sameProjectHead(localHead, authority.head)) {
        throw new Error("CANONICAL_MEMORY_LOCAL_HEAD_CONFLICT");
      }
      const localHeadToken = await headToken(loaded.binding, localFullHead, loaded.spaceKey);
      if (
        sameProjectHead(localHead, loaded.observation.head)
        && localHeadToken === loaded.observation.headToken
      ) {
        if (
          authority.syncState !== "settled"
          || authority.lastExchangeHead === undefined
          || !sameProjectHead(authority.lastExchangeHead, localHead)
        ) {
          this.#store.recordProjectMemorySyncObservation({
            exchangeHead: localHead,
            expectedHead: authority.head,
            expectedRevision: authority.revision,
            projectId,
            state: "settled",
          });
        }
        return null;
      }

      if (localHead.sequence <= loaded.observation.head.sequence) {
        const preparation = this.#store.prepareCanonicalMemorySync({
          direction: "pull",
          idempotencyKey: randomUUID(),
          localHeadToken,
          projectId,
        });
        return {
          intent: this.#store.markCanonicalMemorySyncEffectStarted(preparation.record.id),
          localFullHead,
        };
      }

      let exported: OhOperationV1;
      try {
        exported = await this.#exportOperation(
          projectId,
          authority,
          loaded.fullHead,
        );
      } catch (error: unknown) {
        if (isOhConflictError(error)) {
          throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_HISTORY_CONFLICT", error);
        }
        throw error;
      }
      return {
        attachmentGeneration: attachment.generation,
        attachmentRevision: attachment.revision,
        authorityHead: authority.head,
        authorityRevision: authority.revision,
        exported,
        localFullHead,
        localHeadToken,
        portableAdoptionProof: this.#store.readCanonicalMemoryPortableAdoptionProof({
          operationSha256: exported.operationSha256,
          projectId,
          sequence: exported.sequence,
        }),
        } satisfies PushPreparationDraft;
      },
    );
    if (captured === null || "intent" in captured) return captured;

    // Opening a cloud-custodied encryption capability can revalidate server
    // account authority. Keep that network-bearing work outside the project
    // tail, then reacquire and compare every captured control-plane pin before
    // making the durable request visible.
    const encryptionKey = await cloud.openEncryptionKey({
      bytes: loaded.spaceKey,
      keyVersion: loaded.binding.keyVersion,
      usage: { hostedSpaceId: loaded.binding.hostedSpaceId, kind: "space" },
    });
    let requestOperation: CanonicalMemoryOperation;
    try {
      requestOperation = await encryptCanonicalMemoryOperation({
        authority: loaded.binding,
        encryptionKey,
        genesisHead: emptyOhHeadV1(),
        operation: captured.exported,
        priorHead: loaded.fullHead,
      });
      if (captured.portableAdoptionProof !== null) {
        const { createdAt, projectId: proofProjectId, ...portable } =
          captured.portableAdoptionProof;
        void createdAt;
        void proofProjectId;
        const proof: CanonicalMemoryAdoptionProofV1 = { ...portable, v: 1 };
        if (validatePortableAdoptionProof(proof, captured.exported) === null) {
          throw new CanonicalMemoryRemoteStateError(
            "LOCAL_MEMORY_ADOPTION_PROOF_CORRUPT",
          );
        }
        requestOperation = {
          ...requestOperation,
          adoptionProof: await encryptCanonicalMemoryAdoptionProof({
            authority: loaded.binding,
            encryptionKey,
            operation: requestOperation,
            proof,
          }),
        };
      }
    } finally {
      encryptionKey.dispose();
    }
    await cloud.assertCurrent();

    return await this.#projectSerial.run(projectId, async () => {
      const attachment = this.#requireAttachment(projectId);
      const authority = this.#requireAuthority(projectId);
      if (
        attachment.remoteSpaceId !== loaded.binding.hostedSpaceId
        || attachment.accountBindingDigest !== cloud.accountBindingDigest
        || attachment.canonicalBindingDigest !== loaded.binding.bindingDigest
        || attachment.generation !== captured.attachmentGeneration
        || attachment.revision !== captured.attachmentRevision
        || !sameRemoteObservation(attachment.remote, loaded.observation)
        || authority.bindingDigest !== loaded.binding.bindingDigest
        || authority.revision !== captured.authorityRevision
        || !sameProjectHead(authority.head, captured.authorityHead)
      ) throw new Error("CANONICAL_MEMORY_SYNC_PREPARATION_PIN_CONFLICT");
      const preparation = this.#store.prepareCanonicalMemorySync({
        direction: "push",
        idempotencyKey: randomUUID(),
        localHeadToken: captured.localHeadToken,
        projectId,
        requestOperation,
      });
      return {
        intent: this.#store.markCanonicalMemorySyncEffectStarted(preparation.record.id),
        localFullHead: captured.localFullHead,
      };
    });
  }

  async #resumePrepared(
    projectId: ProjectId,
    cloud: CanonicalMemoryCloudAuthority,
    loaded: LoadedRemote,
    intent: CanonicalMemorySyncIntentRecord,
  ): Promise<PreparedSync> {
    return await this.#projectSerial.run(projectId, async () => {
      const attachment = this.#requireAttachment(projectId);
      const authority = this.#requireAuthority(projectId);
      if (
        attachment.remoteSpaceId !== loaded.binding.hostedSpaceId
        || attachment.accountBindingDigest !== cloud.accountBindingDigest
        || attachment.canonicalBindingDigest !== loaded.binding.bindingDigest
        || attachment.generation !== intent.attachmentGeneration
        || attachment.revision !== intent.attachmentRevision
        || authority.bindingDigest !== intent.canonicalBindingDigest
        || authority.revision !== intent.authorityRevision
        || !sameProjectHead(authority.head, intent.localHead)
      ) throw new Error("CANONICAL_MEMORY_SYNC_RECOVERY_PIN_CONFLICT");
      const strongestRemoteObservation = intent.responseObservation ?? intent.remoteObservation;
      if (!remoteObservationExtends(strongestRemoteObservation, loaded.observation)) {
        throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_RECOVERY_CONFLICT");
      }
      const localFullHead = await this.#readFullLocalHead(projectId, authority);
      const current = intent.state === "prepared"
        ? this.#store.markCanonicalMemorySyncEffectStarted(intent.id)
        : intent;
      return { intent: current, localFullHead };
    });
  }

  async #performAndSettle(
    projectId: ProjectId,
    cloud: CanonicalMemoryCloudAuthority,
    loaded: LoadedRemote,
    prepared: PreparedSync,
  ): Promise<void> {
    let intent = prepared.intent;
    if (intent.state === "response_observed") {
      if (intent.direction === "push") {
        await this.#assertRemoteContainsOperation(cloud, loaded, wireOperation(intent));
      } else if (intent.responseOperation !== undefined) {
        // A later remote head is not proof that the response operation remains
        // in its ancestry. Re-read the exact successor from the journaled prior
        // token before importing or settling a crash-left pull response.
        await this.#assertRemoteContainsOperation(
          cloud,
          loaded,
          toWireOperation(intent.responseOperation),
        );
      }
      await this.#settleObserved(projectId, loaded, intent);
      return;
    }
    if (intent.state !== "effect_started") {
      throw new Error("CANONICAL_MEMORY_SYNC_STATE_CONFLICT");
    }
    if (intent.direction === "push") {
      const operation = wireOperation(intent);
      if (loaded.observation.head.sequence >= operation.sequence) {
        await this.#assertRemoteContainsOperation(cloud, loaded, operation);
      } else {
        try {
          await cloud.transport.push({
            expectedKeyVersion: intent.remoteObservation.keyVersion,
            expectedRevision: intent.remoteObservation.revision,
            operations: [operation],
            spaceId: loaded.binding.hostedSpaceId,
          });
        } catch (error: unknown) {
          if (
            error instanceof CanonicalMemoryTransportError
            && error.effect === "none"
            && error.category !== "transport"
          ) {
            throw new CanonicalMemoryRemoteStateError(
              error.category === "missing"
                ? "REMOTE_MEMORY_ERASED"
                : "REMOTE_MEMORY_PUSH_CONFLICT",
              error,
            );
          }
          throw error;
        }
      }
      let terminal: Awaited<ReturnType<typeof decryptCanonicalMemoryTerminalHeadProof>>;
      try {
        terminal = await decryptCanonicalMemoryTerminalHeadProof({
          authority: loaded.binding,
          envelope: operation.terminalHeadProof,
          expectedHeadToken: operation.headToken,
          expectedSequence: operation.sequence,
          spaceKey: loaded.spaceKey,
        });
      } catch (error: unknown) {
        throw new CanonicalMemoryRemoteStateError("LOCAL_MEMORY_SYNC_SPOOL_CORRUPT", error);
      }
      const response: CanonicalMemoryHostedRemoteObservation = {
        genesisToken: operation.genesisToken,
        head: toProjectHead(terminal.head),
        headProofDigest: proofDigest(operation.terminalHeadProof),
        headToken: operation.headToken,
        keyVersion: operation.operation.keyVersion,
        revision: intent.remoteObservation.revision,
      };
      intent = this.#store.recordCanonicalMemorySyncResponse({
        intentId: intent.id,
        remote: response,
      });
    } else {
      let page: Awaited<ReturnType<CanonicalMemoryTransport["pull"]>>;
      try {
        page = await cloud.transport.pull({
          afterHeadToken: intent.localHeadToken,
          afterSequence: intent.localHead.sequence,
          expectedGenesisToken: intent.remoteObservation.genesisToken,
          expectedKeyVersion: intent.remoteObservation.keyVersion,
          spaceId: loaded.binding.hostedSpaceId,
          terminalHeadToken: intent.remoteObservation.headToken,
          terminalSequence: intent.remoteObservation.head.sequence,
        });
      } catch (error: unknown) {
        if (
          error instanceof CanonicalMemoryTransportError
          && error.effect === "none"
          && error.category !== "transport"
        ) {
          throw new CanonicalMemoryRemoteStateError(
            error.category === "missing" ? "REMOTE_MEMORY_ERASED" : "REMOTE_MEMORY_PULL_INVALID",
            error,
          );
        }
        throw error;
      }
      const wire = page.operations[0];
      let decrypted: Awaited<ReturnType<typeof decryptCanonicalMemoryOperation>> | null;
      try {
        decrypted = wire === undefined
          ? null
          : await decryptCanonicalMemoryOperation({
              authority: loaded.binding,
              expectedGenesisHead: emptyOhHeadV1(),
              expectedPriorHead: prepared.localFullHead,
              operation: wire,
              spaceKey: loaded.spaceKey,
            });
      } catch (error: unknown) {
        throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_OPERATION_INVALID", error);
      }
      intent = this.#store.recordCanonicalMemorySyncResponse({
        intentId: intent.id,
        ...(wire === undefined ? {} : { operation: wire }),
        remote: intent.remoteObservation,
      });
      if (decrypted !== null) {
        this.#store.authorizeCanonicalMemoryPullResult({
          intentId: intent.id,
          resultHead: toProjectHead(decrypted.head),
        });
      }
    }
    await this.#settleObserved(projectId, loaded, intent);
  }

  async #settleObserved(
    projectId: ProjectId,
    loaded: LoadedRemote,
    observed: CanonicalMemorySyncIntentRecord,
  ): Promise<void> {
    await this.#projectSerial.run(projectId, async () => {
      const intent = this.#store.readCanonicalMemorySyncIntent(observed.id);
      if (intent === null || intent.state !== "response_observed") {
        if (intent?.state === "settled") return;
        throw new Error("CANONICAL_MEMORY_SYNC_RESPONSE_MISSING");
      }
      if (intent.direction === "push") {
        const response = intent.responseObservation;
        if (response === undefined) {
          throw new Error("CANONICAL_MEMORY_SYNC_RESPONSE_MISSING");
        }
        const latestRemote = remoteObservationExtends(response, loaded.observation)
          ? loaded.observation
          : response;
        this.#store.settleCanonicalMemorySync({
          intentId: intent.id,
          latestRemote,
          resultHead: intent.localHead,
        });
        return;
      }
      if (intent.responseOperation === undefined) {
        this.#store.settleCanonicalMemorySync({
          intentId: intent.id,
          resultHead: intent.localHead,
        });
        return;
      }
      const authority = this.#requireAuthority(projectId);
      const opened = await this.#withReplication(projectId, authority, async (canonical) => {
          const pinnedHead = toProjectHead(canonical.expectedHead);
          if (!sameProjectHead(pinnedHead, intent.localHead)) {
            throw new Error("CANONICAL_MEMORY_IMPORT_RECOVERY_HEAD_CONFLICT");
          }
          let decrypted: Awaited<ReturnType<typeof decryptCanonicalMemoryOperation>>;
          try {
            decrypted = await decryptCanonicalMemoryOperation({
              authority: loaded.binding,
              expectedGenesisHead: emptyOhHeadV1(),
              expectedPriorHead: canonical.expectedHead,
              operation: toWireOperation(intent.responseOperation as NonNullable<
                CanonicalMemorySyncIntentRecord["responseOperation"]
              >),
              spaceKey: loaded.spaceKey,
            });
          } catch (error: unknown) {
            throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_OPERATION_INVALID", error);
          }
          const decryptedHead = toProjectHead(decrypted.head);
          if (
            intent.resultHead !== undefined
            && !sameProjectHead(intent.resultHead, decryptedHead)
          ) throw new Error("CANONICAL_MEMORY_SYNC_RESULT_AUTHORIZATION_CONFLICT");
          if (intent.resultHead === undefined) {
            this.#store.authorizeCanonicalMemoryPullResult({
              intentId: intent.id,
              resultHead: decryptedHead,
            });
          }
          const portableAdoptionProof = decrypted.adoptionProof.status === "unverified"
            ? validatePortableAdoptionProof(
                decrypted.adoptionProof.proof,
                decrypted.operation,
              )
            : null;
          try {
            await canonical.replication.importBundle({ bundle: decrypted.bundle });
            return portableAdoptionProof;
          } catch (error: unknown) {
            if (
              isOhConflictError(error)
              || isOhDependencyError(error)
              || isOhIntegrityError(error)
            ) {
              throw new CanonicalMemoryRemoteStateError(
                "REMOTE_MEMORY_OPERATION_INVALID",
                error,
              );
            }
            throw error;
          }
        });
      const resultHead = toProjectHead(opened.canonicalHead);
      const authorized = this.#store.readCanonicalMemorySyncIntent(intent.id)?.resultHead;
      if (authorized === undefined || !sameProjectHead(resultHead, authorized)) {
        throw new Error("CANONICAL_MEMORY_IMPORT_HEAD_MISMATCH");
      }
      this.#store.settleCanonicalMemorySync({
        intentId: intent.id,
        ...(opened.result === null ? {} : { portableAdoptionProof: opened.result }),
        resultHead,
      });
    });
  }

  async #assertRemoteContainsOperation(
    cloud: CanonicalMemoryCloudAuthority,
    loaded: LoadedRemote,
    operation: CanonicalMemoryOperation,
  ): Promise<void> {
    let page: Awaited<ReturnType<CanonicalMemoryTransport["pull"]>>;
    try {
      page = await cloud.transport.pull({
        afterHeadToken: operation.priorToken,
        afterSequence: operation.sequence - 1,
        expectedGenesisToken: operation.genesisToken,
        expectedKeyVersion: operation.operation.keyVersion,
        spaceId: loaded.binding.hostedSpaceId,
        terminalHeadToken: loaded.observation.headToken,
        terminalSequence: loaded.observation.head.sequence,
      });
    } catch (error: unknown) {
      if (
        error instanceof CanonicalMemoryTransportError
        && error.effect === "none"
        && error.category !== "transport"
      ) {
        throw new CanonicalMemoryRemoteStateError(
          error.category === "missing" ? "REMOTE_MEMORY_ERASED" : "REMOTE_MEMORY_REPLAY_INVALID",
          error,
        );
      }
      throw error;
    }
    const observed = page.operations[0];
    if (observed === undefined || !sameWireOperation(observed, operation)) {
      throw new CanonicalMemoryRemoteStateError("REMOTE_MEMORY_DIVERGENCE");
    }
  }

  async #ensureInitialized(projectId: ProjectId): Promise<ProjectMemoryAuthorityRecord> {
    let authority = this.#requireAuthority(projectId);
    if (authority.physicalState === "initialized") return authority;
    if (authority.physicalState !== "reserved") {
      throw new Error("PROJECT_MEMORY_AUTHORITY_NOT_INITIALIZABLE");
    }
    const opened = await this.#withReplication(projectId, authority, async (replication) => ({
      bindingSha256: replication.bindingSha256,
      head: replication.expectedHead,
    }));
    if (
      opened.result.bindingSha256 !== authority.bindingDigest
      || !sameProjectHead(toProjectHead(opened.canonicalHead), PROJECT_MEMORY_EMPTY_HEAD)
    ) throw new Error("PROJECT_MEMORY_AUTHORITY_INITIALIZATION_CONFLICT");
    authority = this.#store.markProjectMemoryAuthorityInitialized({
      expectedHead: authority.head,
      expectedRevision: authority.revision,
      projectId,
    });
    return authority;
  }

  async #readFullLocalHead(
    projectId: ProjectId,
    authority: ProjectMemoryAuthorityRecord,
  ): Promise<OhHeadV1> {
    const opened = await this.#withReplication(projectId, authority, async (replication) =>
      replication.expectedHead);
    return opened.result;
  }

  async #exportOperation(
    projectId: ProjectId,
    authority: ProjectMemoryAuthorityRecord,
    after: OhHeadV1,
  ): Promise<OhOperationV1> {
    const opened = await this.#withReplication(projectId, authority, async (replication) =>
      await replication.replication.exportBundle({ after: toOhHeadRef(after), limit: 1 }));
    const bundle = parseOhSyncBundleV1(opened.result.bundle);
    const operation = bundle?.operations[0];
    if (
      bundle === null
      || opened.result.hasMore !== (authority.head.sequence > after.sequence + 1)
      || bundle.operations.length !== 1
      || operation === undefined
      || parseOhOperationV1(operation) === null
      || operation.sequence !== after.sequence + 1
      || operation.parentOperationSha256 !== after.operationSha256
    ) throw new Error("CANONICAL_MEMORY_EXPORT_INVALID");
    return operation;
  }

  async #withReplication<T>(
    projectId: ProjectId,
    authority: ProjectMemoryAuthorityRecord,
    operation: (canonical: OpenOhCanonicalReplication) => Promise<T>,
  ): Promise<OhCanonicalReplicationOperationResult<T>> {
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: authority.canonicalSpaceId,
      identityContract: authority.identityContract,
      projectId,
    });
    const directory = this.#canonicalDirectory(projectId);
    const root = resolve(this.#paths.projectMemory);
    if (authority.physicalState === "reserved") {
      await ensurePrivateDirectory(root);
      await ensurePrivateDirectory(directory);
    }
    return await this.#engine.withCanonicalReplication({
      directory,
      expectedHead: toFactsHead(authority.head),
      realmId: identity.canonicalRealmId,
      requireExisting: authority.physicalState === "initialized",
      requireVacant: authority.physicalState === "reserved",
      spaceId: identity.canonicalSpaceId,
    }, operation);
  }

  #canonicalDirectory(projectId: ProjectId): string {
    const root = resolve(this.#paths.projectMemory);
    const digest = canonicalSha256({ projectId, v: 1 });
    const directory = resolve(join(root, digest));
    if (relative(root, directory) !== digest) {
      throw new Error("MEMORY_PROJECT_PATH_ESCAPE");
    }
    return directory;
  }

  #assertCanonicalDatabaseVacantForPortableReservation(projectId: ProjectId): void {
    const inspection = inspectOhCanonicalDatabaseForRecovery(
      this.#canonicalDirectory(projectId),
    );
    if (inspection.state !== "absent") {
      throw new Error("CANONICAL_MEMORY_DATABASE_RECOVERY_REQUIRED");
    }
  }

  #requireAuthority(projectId: ProjectId): ProjectMemoryAuthorityRecord {
    const authority = this.#store.readProjectMemoryAuthority(projectId);
    if (authority === null) throw new Error("PROJECT_MEMORY_AUTHORITY_MISSING");
    if (authority.identityContract !== 2) {
      throw new Error("CANONICAL_MEMORY_PORTABLE_IDENTITY_REQUIRED");
    }
    if (authority.syncState === "conflict" || authority.syncState === "error") {
      throw new Error("PROJECT_MEMORY_SYNC_FROZEN");
    }
    return authority;
  }

  #requireAttachment(projectId: ProjectId): CanonicalMemoryHostedAttachmentRecord {
    const attachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
    if (attachment?.state !== "attached") {
      throw new Error("CANONICAL_MEMORY_HOSTED_ATTACHMENT_NOT_ACTIVE");
    }
    return attachment;
  }

  async #freezeRemoteState(projectId: ProjectId, diagnosticCode: string): Promise<void> {
    await this.#projectSerial.run(projectId, async () => {
      const attachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
      if (attachment?.state !== "attached") return;
      const intent = this.#store.readUnresolvedCanonicalMemorySyncIntent(projectId);
      if (intent !== null) {
        this.#store.failCanonicalMemorySync({
          diagnosticCode,
          intentId: intent.id,
          state: "conflict",
        });
        return;
      }
      this.#store.failCanonicalMemoryHostedAttachment({
        diagnosticCode,
        expectedGeneration: attachment.generation,
        expectedRevision: attachment.revision,
        projectId,
        state: "conflict",
      });
    });
  }

  #backgroundBackoffDelay(consecutiveFailures: number): number {
    const exponent = Math.min(
      Math.max(0, consecutiveFailures - 1),
      MAXIMUM_BACKGROUND_FAILURE_EXPONENT,
    );
    return Math.min(
      this.#backgroundIntervalMs * 2 ** exponent,
      this.#backgroundBackoffMaxMs,
    );
  }

  #ensureBackgroundTask(): void {
    if (
      this.#closed
      || this.#backgroundSupervisorFailed
      || this.#backgroundTask !== undefined
    ) return;
    const task = this.#runBackground().catch(() => {
      // A failure in the timer/supervisor itself is already reduced to a
      // closed diagnostic by #runBackground. Do not restart a broken timer in
      // a tight loop; an owner sync remains available and close still joins
      // this exact task.
      this.#backgroundSupervisorFailed = true;
    });
    this.#backgroundTask = task;
    void task.then(() => {
      if (this.#backgroundTask === task) this.#backgroundTask = undefined;
      if (
        !this.#closed
        && !this.#backgroundSupervisorFailed
        && this.#scheduledBackgroundProjects.size > 0
      ) {
        this.#ensureBackgroundTask();
      }
    });
  }

  async #runBackground(): Promise<void> {
    const signal = this.#lifetime.signal;
    // AbortSignal changes across awaits even though its property is readonly.
    // Re-read it through a predicate instead of narrowing a stale loop check.
    const isAborted = (): boolean => signal.aborted;
    let inventoryFailures = 0;
    while (!isAborted()) {
      const wakeRevision = this.#backgroundWakeRevision;
      let waitMs: number | null;
      try {
        waitMs = await this.#backgroundTick(signal);
        inventoryFailures = 0;
      } catch (error: unknown) {
        if (isAborted()) return;
        inventoryFailures = Math.min(
          inventoryFailures + 1,
          MAXIMUM_BACKGROUND_FAILURE_EXPONENT + 1,
        );
        this.#reportBackgroundFailure({
          code: "CANONICAL_MEMORY_BACKGROUND_INVENTORY_FAILED",
          consecutiveFailures: inventoryFailures,
          projectId: null,
        });
        waitMs = this.#backgroundBackoffDelay(inventoryFailures);
        void error;
      }
      if (waitMs === null) return;
      if (waitMs <= 0 || wakeRevision !== this.#backgroundWakeRevision) continue;
      try {
        await this.#sleepForBackground(waitMs, signal);
      } catch (error: unknown) {
        if (isAborted()) return;
        this.#reportBackgroundFailure({
          code: "CANONICAL_MEMORY_BACKGROUND_SUPERVISOR_FAILED",
          consecutiveFailures: Math.max(1, inventoryFailures),
          projectId: null,
        });
        throw error;
      }
    }
  }

  async #backgroundTick(signal: AbortSignal): Promise<number | null> {
    signal.throwIfAborted();
    const now = this.#backgroundNow();
    const eligible = new Set<ProjectId>();
    if (this.#backgroundRecoveryStarted) {
      for (const project of this.#store.listProjects()) {
        const projectId = projectIdSchema.parse(project.id);
        const create = this.#store.readUnresolvedCanonicalMemoryHostedCreateIntent(projectId);
        const attachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
        if (create !== null || attachment?.state === "attached") eligible.add(projectId);
      }
    }
    for (const projectId of this.#scheduledBackgroundProjects) eligible.add(projectId);
    for (const projectId of this.#backgroundProjectStates.keys()) {
      if (!eligible.has(projectId)) this.#backgroundProjectStates.delete(projectId);
    }
    for (const projectId of eligible) {
      if (!this.#backgroundProjectStates.has(projectId)) {
        this.#backgroundProjectStates.set(projectId, {
          consecutiveFailures: 0,
          nextAt: now,
        });
      }
    }
    const selected = [...this.#backgroundProjectStates.entries()]
      .sort((left, right) => left[1].nextAt - right[1].nextAt
        || left[0].localeCompare(right[0]))[0];
    if (selected === undefined) {
      return this.#backgroundRecoveryStarted ? this.#backgroundIntervalMs : null;
    }
    const [projectId, state] = selected;
    if (state.nextAt > now) return state.nextAt - now;
    this.#scheduledBackgroundProjects.delete(projectId);
    try {
      await this.#recoverBackgroundProject(projectId, signal);
      state.consecutiveFailures = 0;
      state.nextAt = this.#backgroundNow() + this.#backgroundIntervalMs;
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      state.consecutiveFailures = Math.min(
        state.consecutiveFailures + 1,
        MAXIMUM_BACKGROUND_FAILURE_EXPONENT + 1,
      );
      state.nextAt = this.#backgroundNow()
        + this.#backgroundBackoffDelay(state.consecutiveFailures);
      const stage = error instanceof CanonicalMemoryBackgroundProjectError
        ? error.stage
        : "project_sync";
      this.#reportBackgroundFailure({
        code: stage === "create_recovery"
          ? "CANONICAL_MEMORY_BACKGROUND_CREATE_RECOVERY_FAILED"
          : "CANONICAL_MEMORY_BACKGROUND_PROJECT_SYNC_FAILED",
        consecutiveFailures: state.consecutiveFailures,
        projectId,
      });
    }
    // A local share may have requested this same project while its earlier
    // attempt was in flight. Preserve that coalesced wake instead of letting
    // the completion overwrite it with the ordinary periodic deadline.
    if (this.#scheduledBackgroundProjects.has(projectId)) {
      state.nextAt = this.#backgroundNow();
    }
    return 0;
  }

  async #recoverBackgroundProject(projectId: ProjectId, signal: AbortSignal): Promise<void> {
    try {
      const intent = this.#store.readUnresolvedCanonicalMemoryHostedCreateIntent(projectId);
      if (intent !== null) {
        await this.#serializeNetwork(async () => {
          signal.throwIfAborted();
          await this.#recoverHostedCreate(intent);
        });
      }
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      throw new CanonicalMemoryBackgroundProjectError("create_recovery", error);
    }
    signal.throwIfAborted();
    try {
      const attachment = this.#store.readCanonicalMemoryHostedAttachment(projectId);
      if (attachment?.state === "attached") {
        await this.#serializeNetwork(async () => {
          signal.throwIfAborted();
          await this.#synchronizeProject(projectId);
        });
      }
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      throw new CanonicalMemoryBackgroundProjectError("project_sync", error);
    }
  }

  #reportBackgroundFailure(failure: CanonicalMemoryBackgroundFailure): void {
    try {
      this.#onBackgroundFailure(failure);
    } catch {
      // Diagnostics are deliberately observational. A broken sink cannot stop
      // exact hosted-create reconciliation or the per-project retry loop.
    }
  }

  async #sleepForBackground(milliseconds: number, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onLifetimeAbort = (): void => controller.abort(signal.reason);
    this.#backgroundSleepAbort = controller;
    signal.addEventListener("abort", onLifetimeAbort, { once: true });
    if (signal.aborted) onLifetimeAbort();
    try {
      await this.#backgroundSleep(milliseconds, controller.signal);
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      if (controller.signal.reason === BACKGROUND_SYNC_WAKE) return;
      throw error;
    } finally {
      signal.removeEventListener("abort", onLifetimeAbort);
      if (this.#backgroundSleepAbort === controller) this.#backgroundSleepAbort = undefined;
    }
  }

  #wakeBackground(): void {
    this.#backgroundWakeRevision += 1;
    this.#backgroundSleepAbort?.abort(BACKGROUND_SYNC_WAKE);
  }

  #serializeNetwork<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#networkTail.catch(() => undefined).then(operation);
    this.#networkTail = current;
    return current;
  }
}
