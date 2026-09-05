import { describe, expect, test } from "bun:test";

import type { CloudTransport } from "./client";
import type {
  AuthorityTuple,
  CommandKind,
  CommandState,
  DeviceCommandKind,
  EncryptedEnvelope,
} from "./contracts";
import {
  type ActiveCloudIdentity,
  type CloudCommandExecutorPort,
  type CloudDaemonIdentityPort,
  type CloudDeviceCommandExecutionResult,
  type CloudDeviceCommandExecutorPort,
  type CloudDaemonLocalSourcePort,
  type CloudLocalSessionHead,
  type CloudLocalSessionPage,
  type CloudLocalUsageSnapshot,
  createLocalCloudDaemonBridgeFromEnvironment,
  CustodyCloudDaemonIdentity,
  LocalCloudDaemonBridge,
  projectionRecoveryStatusFromJournalState,
  type RegisteredCloudIdentity,
} from "./daemon-bridge";
import {
  CloudDaemonJournalRecoveryBlocker,
  MemoryCloudDaemonJournal,
  MemoryCloudSessionSyncCursor,
  parseCloudDaemonJournal,
  type CloudCommandJournalEntry,
  type CloudDaemonJournalState,
  type CloudDaemonJournalInputState,
  type CloudDaemonJournalObservation,
  type CloudDaemonJournalPort,
  type CloudDeviceCommandJournalEntry,
  type CloudProjectionRecoveryBaselineInteraction,
  type CloudSessionSyncCursorPort,
} from "./daemon-journal";
import {
  cloudDeploymentAuthorityFromEnvironment,
  type CloudDeploymentAuthority,
} from "./identity-custody";
import {
  createLocalCloudControlFromEnvironment,
  type CloudSecretCustodyPort,
} from "./local-control";
import { PollingCloudDaemonLifecycle } from "./daemon-lifecycle";
import {
  createCloudPushWake,
  pendingCommandFingerprint,
  pushWakeBackoffMs,
  type CloudPushWakePort,
  type CloudPushWakeSubscriber,
} from "./push-wake";
import { hmacSha256Hex, sha256Hex } from "./crypto";
import {
  compareDeviceAuthority,
  deviceCommandRecoveryAdmitted,
  deviceCommandRecoveryReplayAdmitted,
} from "./device-commands";
import {
  decryptDeviceRegistry,
  decryptDeviceCommandResult,
  encryptDeviceCommand,
  encryptDeviceCommandResult,
  encryptRemoteCommand,
  type DeviceCommandPayload,
  type DeviceRegistryPayload,
  type RemoteCommandPayload,
} from "./payloads";
import { encryptCompactEvents, type CompactSessionEvent } from "./projection";

const fixedNow = 1_900_000_000_000;

function doneLocalSessionPage(
  sessions: readonly CloudLocalSessionHead[],
): CloudLocalSessionPage {
  return { continueAfterPublicId: null, isDone: true, sessions };
}
const usageServerAdmissionMinIntervalMs = 24 * 60 * 60 * 1_000;
const userPublicId = "user_12345678";
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function uuidV7(sequence: number, now: number = fixedNow): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  const suffix = sequence.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix}`;
}

let connectionUuidSequence = 0;

function connectionUuid(sequence: number): string {
  const suffix = sequence.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

type FakeHead = {
  compactHasRecoveryGap?: boolean;
  compactHeadSequence: number;
  compactStreamEpoch?: number;
  compactTailDigest?: string;
  createdAt: number;
  detailHeadSequence: number;
  detailTailDigest?: string;
  executionDevicePublicId: string;
  metadata?: EncryptedEnvelope;
  metadataRevision: number;
  projectionRevision: number;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
};

type FakeLease = {
  bootGeneration: number;
  bootId: string;
  devicePublicId: string;
  fence: number;
  heartbeatFingerprint: string;
  heartbeatSequence: number;
  leaseUntil: number;
};

type FakePresence = {
  connectionId: string;
  credentialGeneration: number;
  fingerprint: string;
  lastSeenAt: number;
  presenceUntil: number;
  sequence: number;
};

type FakeCommand = {
  boundAuthority?: AuthorityTuple;
  createdAt: number;
  deadline: number;
  kind: CommandKind;
  payload: EncryptedEnvelope;
  publicId: string;
  requestDigest: string;
  requestingDevicePublicId?: string;
  resultCode?: string;
  resultDigest?: string;
  sessionPublicId: string;
  state: CommandState;
  targetDevicePublicId: string;
  updatedAt: number;
};

function sameAuthorityTuple(left: AuthorityTuple, right: AuthorityTuple): boolean {
  return left.bootGeneration === right.bootGeneration
    && left.bootId === right.bootId
    && left.fence === right.fence;
}

type FakeDeviceCommand = {
  boundAuthority?: AuthorityTuple;
  createdAt: number;
  deadline: number;
  kind: DeviceCommandKind;
  payload: EncryptedEnvelope;
  publicId: string;
  requestDigest: string;
  requestingDevicePublicId: string;
  result?: EncryptedEnvelope;
  resultCode?: string;
  resultConsumed?: boolean;
  resultDigest?: string;
  singleUseResult?: boolean;
  state: CommandState;
  targetDevicePublicId: string;
  updatedAt: number;
};

class FakeCloud {
  now = fixedNow;
  offline = false;
  offlineMessage = "network offline";
  failMarkAfterEffectOnce = false;
  failPrepareOnce = false;
  failDeviceMarkAfterEffectOnce = false;
  failDeviceMarkBeforeEffectOnce = false;
  failDevicePrepareAfterEffectOnce = false;
  failDevicePrepareBeforeEffectOnce = false;
  failDeviceRecoveryAfterEffectOnce = false;
  revokeDeviceCommandAfterMarkOnce = false;
  revokeDeviceCommandBeforeSettleOnce = false;
  failRevokedDeviceCommandConfirmationOnce = false;
  failTerminalRecoveryConfirmationOnce = false;
  failSettleAfterEffectOnce = false;
  failEpochAfterEffectOnce = false;
  failUsageAccountAfterEffectOnce = false;
  failUsageAccountBeforeEffectOnce = false;
  failUsageSnapshotAfterEffectOnce = false;
  failUsageSnapshotAfterEffectRevision: number | null = null;
  failPresenceAfterEffectOnce = false;
  failPresenceBeforeEffectOnce = false;
  stallPresenceDisconnect = false;
  presenceTtlMs = 45_000;
  forcePendingPaginationIncomplete = false;
  stallLatestChunks = false;
  afterPendingScan?: () => Promise<void> | void;
  afterDeviceCommandPendingScan?: () => Promise<void> | void;
  readonly heads = new Map<string, FakeHead>();
  readonly chunks = new Map<string, unknown[]>();
  readonly leases = new Map<string, FakeLease>();
  readonly presences = new Map<string, FakePresence>();
  readonly credentialGenerations = new Map<string, number>();
  readonly revokedDevices = new Set<string>();
  readonly presenceMutationCalls: Array<Readonly<{
    args: Readonly<Record<string, unknown>>;
    devicePublicId: string;
    name: "presence:connect" | "presence:disconnect" | "presence:heartbeat";
  }>> = [];
  sessionHeadListCalls = 0;
  deviceListCalls = 0;
  deviceCommandPendingListCalls = 0;
  peerDevices: Array<Readonly<Record<string, unknown>>> = [];
  readonly commands = new Map<string, FakeCommand>();
  readonly deviceCommands = new Map<string, FakeDeviceCommand>();
  readonly failingCommandGets = new Set<string>();
  readonly failingHeadGets = new Set<string>();
  readonly headGetCalls: string[] = [];
  readonly commandGetCalls: string[] = [];
  readonly commandEffectStartCalls: string[] = [];
  readonly commandSettleCalls: string[] = [];
  readonly accounts = new Map<string, {
    encryptedLocalReference: EncryptedEnvelope;
    encryptedMetadata: EncryptedEnvelope;
    matchKey: string;
    sourceGeneration: number;
  }>();
  readonly snapshots = new Map<string, { digest: string; sourceRevision: number }>();
  readonly usageAdmissions = new Map<string, {
    digest: string;
    disposition: "coalesced" | "stored";
    lastAcceptedAt: number;
    observedAt: number;
    sourceRevision: number;
  }>();
  readonly snapshotAttempts: Array<Readonly<{
    accountPublicId: string;
    sourceRevision: number;
  }>> = [];
  readonly snapshotCommits = new Map<string, Readonly<{
    digest: string;
    observedAt: number;
  }>>();
  readonly sessionCreateCalls: string[] = [];
  readonly epochReceipts = new Map<string, Readonly<{
    requestDigest: string;
    response: Readonly<Record<string, unknown>>;
  }>>();
  epochBegins = 0;
  epochMutationCalls = 0;
  readonly usageAccountAttempts: Readonly<Record<string, unknown>>[] = [];

  async enqueue(
    requestingDevicePublicId: string,
    sessionPublicId: string,
    publicId: string,
    payload: RemoteCommandPayload,
  ): Promise<void> {
    const head = this.heads.get(sessionPublicId);
    if (head === undefined) throw new Error("missing session");
    const envelope = await encryptRemoteCommand(payload, key, {
      entityPublicId: publicId,
      keyVersion: 1,
      kind: "command",
      userPublicId,
    });
    this.commands.set(publicId, {
      createdAt: this.now,
      deadline: this.now + 60_000,
      kind: payload.kind,
      payload: envelope,
      publicId,
      requestDigest: "d".repeat(64),
      sessionPublicId,
      requestingDevicePublicId,
      state: "pending",
      targetDevicePublicId: head.executionDevicePublicId,
      updatedAt: this.now,
    });
  }

  async enqueueDeviceCommand(input: Readonly<{
    kind: DeviceCommandKind;
    payload: DeviceCommandPayload;
    publicId: string;
    requestingDevicePublicId: string;
    targetDevicePublicId?: string;
  }>): Promise<void> {
    const deadline = this.now + 60_000;
    const targetDevicePublicId = input.targetDevicePublicId ?? "device_daemon1";
    const envelope = await encryptDeviceCommand(input.payload, key, {
      entityPublicId: input.publicId,
      keyVersion: 1,
      kind: "device_command",
      userPublicId,
    });
    const requestDigest = await hmacSha256Hex(
      key,
      "device-command-enqueue",
      JSON.stringify({
        deadline,
        expectedTargetDevicePublicId: targetDevicePublicId,
        kind: input.kind,
        payload: envelope,
        publicId: input.publicId,
      }),
    );
    this.deviceCommands.set(input.publicId, {
      createdAt: this.now,
      deadline,
      kind: input.kind,
      payload: envelope,
      publicId: input.publicId,
      requestDigest,
      requestingDevicePublicId: input.requestingDevicePublicId,
      state: "pending",
      targetDevicePublicId,
      updatedAt: this.now,
    });
  }

  connect(devicePublicId: string): CloudTransport {
    const guard = (): void => {
      if (this.offline) throw new Error(this.offlineMessage);
    };
    const publicCommand = (command: FakeCommand) => ({
      ...(command.boundAuthority === undefined
        ? {}
        : { boundAuthority: command.boundAuthority }),
      createdAt: command.createdAt,
      deadline: command.deadline,
      kind: command.kind,
      payload: command.payload,
      publicId: command.publicId,
      sessionPublicId: command.sessionPublicId,
      ...(command.resultCode === undefined ? {} : { resultCode: command.resultCode }),
      state: command.state,
      updatedAt: command.updatedAt,
    });
    const publicCommandMetadata = (command: FakeCommand) => ({
      ...(command.boundAuthority === undefined
        ? {}
        : { boundAuthority: command.boundAuthority }),
      createdAt: command.createdAt,
      deadline: command.deadline,
      kind: command.kind,
      publicId: command.publicId,
      sessionPublicId: command.sessionPublicId,
      ...(command.resultCode === undefined ? {} : { resultCode: command.resultCode }),
      state: command.state,
      updatedAt: command.updatedAt,
    });
    const publicDeviceCommand = (command: FakeDeviceCommand) => ({
      ...(command.boundAuthority === undefined
        ? {}
        : { boundAuthority: command.boundAuthority }),
      createdAt: command.createdAt,
      deadline: command.deadline,
      kind: command.kind,
      payload: command.payload,
      publicId: command.publicId,
      requestingDevicePublicId: command.requestingDevicePublicId,
      ...(command.singleUseResult === true
        ? {
            resultConsumed: command.resultConsumed === true,
            resultSingleUse: true,
          }
        : command.result === undefined ? {} : { result: command.result }),
      ...(command.resultCode === undefined ? {} : { resultCode: command.resultCode }),
      state: command.state,
      updatedAt: command.updatedAt,
    });
    const publicPresence = (presence: FakePresence | undefined) => ({
      connectionId: presence?.connectionId ?? null,
      lastSeenAt: presence?.lastSeenAt ?? null,
      online: presence !== undefined && presence.presenceUntil > this.now,
      presenceUntil: presence?.presenceUntil ?? null,
      sequence: presence?.sequence ?? null,
      serverNow: this.now,
    });
    const requirePresenceAuthority = (credentialGeneration: unknown): number => {
      if (this.revokedDevices.has(devicePublicId)) {
        throw new Error("Cloud authority is not current.");
      }
      const current = this.credentialGenerations.get(devicePublicId) ?? 1;
      if (credentialGeneration !== current) {
        throw new Error("Cloud authority is not current.");
      }
      return current;
    };
    return {
      action: async () => {
        guard();
        throw new Error("unexpected action");
      },
      mutation: async (name, args) => {
        guard();
        if (
          name === "presence:connect"
          || name === "presence:heartbeat"
          || name === "presence:disconnect"
        ) {
          this.presenceMutationCalls.push({
            args: { ...args },
            devicePublicId,
            name,
          });
          if (name === "presence:disconnect" && this.stallPresenceDisconnect) {
            return await new Promise<never>(() => undefined);
          }
          if (name !== "presence:disconnect" && this.failPresenceBeforeEffectOnce) {
            this.failPresenceBeforeEffectOnce = false;
            throw new Error("presence unavailable before effect");
          }
          const credentialGeneration = args.credentialGeneration as number;
          if (name !== "presence:disconnect") {
            requirePresenceAuthority(credentialGeneration);
          } else if (this.revokedDevices.has(devicePublicId)) {
            throw new Error("Cloud authority is not current.");
          }
          const current = this.presences.get(devicePublicId);
          if (name === "presence:connect") {
            if (args.sequence !== 0) throw new Error("Cloud authority is not current.");
            const exactReplay = current !== undefined
              && current.connectionId === args.connectionId
              && current.credentialGeneration === credentialGeneration
              && current.fingerprint === args.fingerprint
              && current.sequence === args.sequence;
            if (!exactReplay) {
              if (current !== undefined && current.presenceUntil > this.now) {
                throw new Error("PRESENCE_CONNECTION_CONFLICT");
              }
              this.presences.set(devicePublicId, {
                connectionId: args.connectionId as string,
                credentialGeneration,
                fingerprint: args.fingerprint as string,
                lastSeenAt: this.now,
                presenceUntil: this.now + this.presenceTtlMs,
                sequence: 0,
              });
            }
          } else if (name === "presence:heartbeat") {
            if (
              current === undefined
              || current.connectionId !== args.connectionId
              || current.credentialGeneration !== credentialGeneration
            ) throw new Error("Cloud authority is not current.");
            if (args.sequence === current.sequence) {
              if (args.fingerprint !== current.fingerprint) {
                throw new Error("Cloud authority is not current.");
              }
            } else {
              if (args.sequence !== current.sequence + 1) {
                throw new Error("Cloud authority is not current.");
              }
              current.fingerprint = args.fingerprint as string;
              current.lastSeenAt = this.now;
              current.presenceUntil = this.now + this.presenceTtlMs;
              current.sequence = args.sequence as number;
            }
          } else {
            if (
              current === undefined
              || current.connectionId !== args.connectionId
              || current.credentialGeneration !== credentialGeneration
              || current.fingerprint !== args.fingerprint
              || current.sequence !== args.sequence
            ) throw new Error("Cloud authority is not current.");
            current.lastSeenAt = this.now;
            current.presenceUntil = this.now;
          }
          const response = publicPresence(this.presences.get(devicePublicId));
          if (name !== "presence:disconnect" && this.failPresenceAfterEffectOnce) {
            this.failPresenceAfterEffectOnce = false;
            throw new Error("lost presence response");
          }
          return response;
        }
        if (name === "sessions:create") {
          const publicId = args.publicId as string;
          this.sessionCreateCalls.push(publicId);
          if (!this.heads.has(publicId)) {
            this.heads.set(publicId, {
              compactHeadSequence: 0,
              createdAt: this.now,
              detailHeadSequence: 0,
              executionDevicePublicId: devicePublicId,
              metadata: args.metadata as EncryptedEnvelope,
              metadataRevision: 1,
              projectionRevision: 0,
              publicId,
              state: "active",
              updatedAt: this.now,
            });
          }
          return { metadataRevision: 1, projectionRevision: 0, publicId, state: "active" };
        }
        if (name === "sessions:updateMetadata") {
          const head = this.requireHead(args.sessionPublicId);
          if (head.metadataRevision !== args.expectedRevision) throw new Error("metadata conflict");
          head.metadata = args.metadata as EncryptedEnvelope;
          head.metadataRevision += 1;
          head.updatedAt = this.now;
          return {
            metadataRevision: head.metadataRevision,
            projectionRevision: head.projectionRevision,
            publicId: head.publicId,
            state: head.state,
          };
        }
        if (name === "sessions:beginCompactEpoch") {
          this.epochMutationCalls += 1;
          const idempotencyKey = args.idempotencyKey as string;
          const existing = this.epochReceipts.get(idempotencyKey);
          if (existing !== undefined) {
            if (existing.requestDigest !== args.requestDigest) {
              throw new Error("IDEMPOTENCY_CONFLICT");
            }
            return existing.response;
          }
          const idempotencyTimestamp = Number.parseInt(
            idempotencyKey.replaceAll("-", "").slice(0, 12),
            16,
          );
          if (idempotencyTimestamp < this.now - (7 * 24 * 60 * 60 * 1_000)) {
            throw new Error("Invalid idempotency authority.");
          }
          const head = this.requireHead(args.sessionPublicId);
          const lease = this.requireLease(args.sessionPublicId);
          const authority = args.authority as AuthorityTuple;
          if (
            lease.bootGeneration !== authority.bootGeneration
            || lease.bootId !== authority.bootId
            || lease.fence !== authority.fence
            || lease.leaseUntil <= this.now
          ) throw new Error("Cloud authority is not current.");
          if (
            head.compactHeadSequence !== args.expectedHeadSequence
            || head.compactTailDigest !== args.expectedTailDigest
            || (head.compactStreamEpoch ?? 0) !== args.expectedCompactStreamEpoch
          ) throw new Error("SESSION_COMPACT_EPOCH_CONFLICT");
          head.compactHasRecoveryGap = true;
          head.compactStreamEpoch = (head.compactStreamEpoch ?? 0) + 1;
          head.projectionRevision += 1;
          const response = {
            boundaryHeadSequence: head.compactHeadSequence,
            boundaryTailDigest: head.compactTailDigest,
            compactHasRecoveryGap: true,
            compactStreamEpoch: head.compactStreamEpoch,
            epochPublicId: args.epochPublicId,
            projectionRevision: head.projectionRevision,
            sessionPublicId: head.publicId,
          } as const;
          this.epochReceipts.set(idempotencyKey, {
            requestDigest: args.requestDigest as string,
            response,
          });
          this.epochBegins += 1;
          if (this.failEpochAfterEffectOnce) {
            this.failEpochAfterEffectOnce = false;
            throw new Error("lost compact epoch response");
          }
          return response;
        }
        if (name === "leases:acquire") {
          const sessionPublicId = args.sessionPublicId as string;
          const current = this.leases.get(sessionPublicId);
          const next: FakeLease = {
            bootGeneration: args.bootGeneration as number,
            bootId: args.bootId as string,
            devicePublicId,
            fence: current === undefined ? 1 : current.fence + 1,
            heartbeatFingerprint: "initial",
            heartbeatSequence: 0,
            leaseUntil: this.now + (args.leaseDurationMs as number),
          };
          this.leases.set(sessionPublicId, next);
          return next;
        }
        if (name === "leases:heartbeat") {
          const lease = this.requireLease(args.sessionPublicId);
          lease.heartbeatFingerprint = args.fingerprint as string;
          lease.heartbeatSequence = args.sequence as number;
          lease.leaseUntil = this.now + (args.leaseDurationMs as number);
          return lease;
        }
        if (name === "sessions:appendChunk") {
          const head = this.requireHead(args.sessionPublicId);
          const streamEpoch = head.compactStreamEpoch ?? 0;
          if (args.expectedStreamEpoch !== streamEpoch) throw new Error("epoch conflict");
          head.compactHeadSequence = args.lastSequence as number;
          head.compactTailDigest = args.digest as string;
          head.projectionRevision += 1;
          head.updatedAt = this.now;
          const chunks = this.chunks.get(head.publicId) ?? [];
          chunks.push({
            authority: args.authority,
            createdAt: this.now,
            digest: args.digest,
            envelope: args.envelope,
            firstSequence: args.firstSequence,
            lastSequence: args.lastSequence,
            ...(args.previousDigest === undefined
              ? {}
              : { previousDigest: args.previousDigest }),
            sourceDevicePublicId: devicePublicId,
            stream: "compact",
            streamEpoch,
          });
          this.chunks.set(head.publicId, chunks);
          return {
            digest: args.digest,
            headSequence: args.lastSequence,
            replay: false,
            streamEpoch,
          };
        }
        if (name === "sessions:updateState") {
          const head = this.requireHead(args.sessionPublicId);
          if (head.state !== args.expectedState) throw new Error("state conflict");
          head.state = args.state as FakeHead["state"];
          head.updatedAt = this.now;
          return { publicId: head.publicId, replay: false, state: head.state };
        }
        if (name === "usage:upsertAccount") {
          const accountPublicId = args.publicId as string;
          this.usageAccountAttempts.push(structuredClone(args));
          if (this.failUsageAccountBeforeEffectOnce) {
            this.failUsageAccountBeforeEffectOnce = false;
            throw new Error("usage account unavailable before effect");
          }
          const current = this.accounts.get(accountPublicId);
          if (current !== undefined && current.sourceGeneration > (args.sourceGeneration as number)) {
            throw new Error("account generation conflict");
          }
          this.accounts.set(accountPublicId, {
            encryptedLocalReference: args.encryptedLocalReference as EncryptedEnvelope,
            encryptedMetadata: args.encryptedMetadata as EncryptedEnvelope,
            matchKey: args.matchKey as string,
            sourceGeneration: args.sourceGeneration as number,
          });
          if (this.failUsageAccountAfterEffectOnce) {
            this.failUsageAccountAfterEffectOnce = false;
            throw new Error("lost usage account response");
          }
          return { publicId: accountPublicId, sourceGeneration: args.sourceGeneration };
        }
        if (name === "usage:upsertSnapshot") {
          const accountPublicId = args.accountPublicId as string;
          const sourceGeneration = args.sourceGeneration as number;
          const sourceRevision = args.sourceRevision as number;
          const digest = args.digest as string;
          const observedAt = args.observedAt as number;
          if (this.accounts.get(accountPublicId)?.sourceGeneration !== sourceGeneration) {
            throw new Error("usage snapshot generation conflict");
          }
          this.snapshotAttempts.push({ accountPublicId, sourceRevision });
          const admissionKey = `${accountPublicId}:${devicePublicId}`;
          const exactKey = `${admissionKey}:${sourceRevision}`;
          const exact = this.snapshotCommits.get(exactKey);
          if (
            exact !== undefined
            && (exact.digest !== digest || exact.observedAt !== observedAt)
          ) throw new Error("usage snapshot conflict");
          const admission = this.usageAdmissions.get(admissionKey);
          let disposition: "coalesced" | "replace" | "replay";
          if (exact !== undefined) {
            disposition = "replay";
          } else if (admission !== undefined && sourceRevision === admission.sourceRevision) {
            if (admission.digest !== digest || admission.observedAt !== observedAt) {
              throw new Error("usage snapshot conflict");
            }
            disposition = admission.disposition === "coalesced" ? "coalesced" : "replay";
          } else {
            if (admission !== undefined && sourceRevision < admission.sourceRevision) {
              throw new Error("usage snapshot stale");
            }
            if (
              admission !== undefined
              && this.now - admission.lastAcceptedAt < usageServerAdmissionMinIntervalMs
            ) {
              this.usageAdmissions.set(admissionKey, {
                digest,
                disposition: "coalesced",
                lastAcceptedAt: admission.lastAcceptedAt,
                observedAt,
                sourceRevision,
              });
              disposition = "coalesced";
            } else {
              const lastAcceptedAt = this.now;
              this.usageAdmissions.set(admissionKey, {
                digest,
                disposition: "stored",
                lastAcceptedAt,
                observedAt,
                sourceRevision,
              });
              this.snapshotCommits.set(exactKey, { digest, observedAt });
              this.snapshots.set(accountPublicId, { digest, sourceRevision });
              disposition = "replace";
            }
          }
          if (
            this.failUsageSnapshotAfterEffectOnce
            || this.failUsageSnapshotAfterEffectRevision === sourceRevision
          ) {
            this.failUsageSnapshotAfterEffectOnce = false;
            this.failUsageSnapshotAfterEffectRevision = null;
            throw new Error("lost usage snapshot response");
          }
          return {
            disposition,
            sourceRevision,
          };
        }
        if (name === "commands:prepare") {
          if (this.failPrepareOnce) {
            this.failPrepareOnce = false;
            throw new Error("prepare unavailable");
          }
          const command = this.requireCommand(args.commandPublicId);
          if (command.deadline <= this.now) {
            command.state = "expired";
            return { publicId: command.publicId, replay: false, state: "expired" };
          }
          command.boundAuthority = args.authority as AuthorityTuple;
          command.state = "prepared";
          return { publicId: command.publicId, replay: false, state: "prepared" };
        }
        if (name === "commands:markEffectStarted") {
          this.commandEffectStartCalls.push(args.commandPublicId as string);
          const command = this.requireCommand(args.commandPublicId);
          if (command.state === "prepared" && command.deadline <= this.now) {
            command.state = "expired";
            return { publicId: command.publicId, replay: false, state: "expired" };
          }
          if (command.state === "prepared") command.state = "effect_started";
          if (this.failMarkAfterEffectOnce) {
            this.failMarkAfterEffectOnce = false;
            throw new Error("lost mark response");
          }
          return { publicId: command.publicId, replay: false, state: "effect_started" };
        }
        if (name === "commands:settle") {
          this.commandSettleCalls.push(args.commandPublicId as string);
          const command = this.requireCommand(args.commandPublicId);
          if (command.state === args.state) {
            if (
              command.resultCode !== args.resultCode
              || command.resultDigest !== args.resultDigest
            ) throw new Error("result conflict");
            return { publicId: command.publicId, replay: true, state: command.state };
          }
          command.state = args.state as "applied" | "failed" | "ambiguous";
          command.resultCode = args.resultCode as string;
          command.resultDigest = args.resultDigest as string;
          if (this.failSettleAfterEffectOnce) {
            this.failSettleAfterEffectOnce = false;
            throw new Error("lost settle response");
          }
          return { publicId: command.publicId, replay: false, state: command.state };
        }
        if (name === "commands:recoverEffectStarted") {
          const command = this.requireCommand(args.commandPublicId);
          const recovery = args.recoveryAuthority as AuthorityTuple;
          const stale = args.staleAuthority as AuthorityTuple;
          if (recovery.fence <= stale.fence) throw new Error("stale recovery fence");
          command.resultCode = args.resultCode as string;
          command.resultDigest = args.resultDigest as string;
          command.state = args.state as "applied" | "failed" | "ambiguous";
          return { publicId: command.publicId, replay: false, state: command.state };
        }
        if (name === "deviceCommands:prepare") {
          if (this.failDevicePrepareBeforeEffectOnce) {
            this.failDevicePrepareBeforeEffectOnce = false;
            throw new Error("device command prepare unavailable");
          }
          const command = this.requireDeviceCommand(args.commandPublicId);
          const requested = args.authority as AuthorityTuple;
          if (
            (command.state === "pending" || command.state === "prepared")
            && command.deadline <= this.now
          ) {
            command.state = "expired";
            return { publicId: command.publicId, replay: false, state: "expired" };
          }
          if (command.state === "prepared") {
            const bound = command.boundAuthority;
            if (bound === undefined) throw new Error("device command bound authority missing");
            if (sameAuthorityTuple(bound, requested)) {
              return { publicId: command.publicId, replay: true, state: "prepared" };
            }
            if (requested.bootGeneration < bound.bootGeneration) {
              throw new Error("stale device command authority");
            }
            command.boundAuthority = requested;
            return { publicId: command.publicId, rebound: true, state: "prepared" };
          }
          if (command.state !== "pending") throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
          command.boundAuthority = requested;
          command.state = "prepared";
          if (this.failDevicePrepareAfterEffectOnce) {
            this.failDevicePrepareAfterEffectOnce = false;
            throw new Error("lost device command prepare response");
          }
          return { publicId: command.publicId, replay: false, state: "prepared" };
        }
        if (name === "deviceCommands:markEffectStarted") {
          if (this.failDeviceMarkBeforeEffectOnce) {
            this.failDeviceMarkBeforeEffectOnce = false;
            throw new Error("device command mark unavailable");
          }
          const command = this.requireDeviceCommand(args.commandPublicId);
          if (command.state === "prepared") command.state = "effect_started";
          if (this.failDeviceMarkAfterEffectOnce) {
            this.failDeviceMarkAfterEffectOnce = false;
            throw new Error("lost device command mark response");
          }
          if (this.revokeDeviceCommandAfterMarkOnce) {
            this.revokeDeviceCommandAfterMarkOnce = false;
            this.revokedDevices.add(command.requestingDevicePublicId);
            command.state = "ambiguous";
            throw new Error("lost device command mark response after requester revocation");
          }
          return { publicId: command.publicId, replay: false, state: "effect_started" };
        }
        if (name === "deviceCommands:settle") {
          const command = this.requireDeviceCommand(args.commandPublicId);
          if (this.revokeDeviceCommandBeforeSettleOnce) {
            this.revokeDeviceCommandBeforeSettleOnce = false;
            this.revokedDevices.add(command.requestingDevicePublicId);
            command.state = "ambiguous";
            throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
          }
          const legacyAppliedLoginReplay = command.kind === "account_login_start"
            && command.state === "applied"
            && args.state === "applied"
            && args.result === undefined
            && args.singleUseResult === undefined
            && command.singleUseResult === true
            && (command.result !== undefined || command.resultConsumed === true);
          if (command.state === args.state) {
            if (
              command.resultCode !== args.resultCode
              || command.resultDigest !== args.resultDigest
              || (!legacyAppliedLoginReplay
                && JSON.stringify(command.result) !== JSON.stringify(args.result))
              || (!legacyAppliedLoginReplay
                && command.singleUseResult !== (args.singleUseResult === true ? true : undefined))
            ) throw new Error("device command result conflict");
            return { publicId: command.publicId, replay: true, state: command.state };
          }
          if (command.state !== "effect_started") {
            throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
          }
          command.state = args.state as CommandState;
          command.resultCode = args.resultCode as string;
          command.resultDigest = args.resultDigest as string;
          if (args.result !== undefined) command.result = args.result as EncryptedEnvelope;
          if (args.singleUseResult === true) command.singleUseResult = true;
          if (this.failSettleAfterEffectOnce) {
            this.failSettleAfterEffectOnce = false;
            throw new Error("lost device command settle response");
          }
          return { publicId: command.publicId, replay: false, state: command.state };
        }
        if (name === "deviceCommands:confirmRevokedTerminal") {
          if (this.failRevokedDeviceCommandConfirmationOnce) {
            this.failRevokedDeviceCommandConfirmationOnce = false;
            throw new Error("revoked terminal confirmation unavailable");
          }
          const command = this.requireDeviceCommand(args.commandPublicId);
          const authority = args.authority as AuthorityTuple;
          if (
            command.state !== "ambiguous"
            || command.boundAuthority === undefined
            || !sameAuthorityTuple(command.boundAuthority, authority)
            || !this.revokedDevices.has(command.requestingDevicePublicId)
            || command.result !== undefined
            || command.resultCode !== undefined
            || command.resultDigest !== undefined
            || command.singleUseResult !== undefined
          ) throw new Error("DEVICE_COMMAND_REVOCATION_TERMINAL_CONFLICT");
          return { publicId: command.publicId, replay: true, state: "ambiguous" };
        }
        if (name === "deviceCommands:confirmTerminalRecovery") {
          if (this.failTerminalRecoveryConfirmationOnce) {
            this.failTerminalRecoveryConfirmationOnce = false;
            throw new Error("terminal recovery confirmation unavailable");
          }
          const command = this.requireDeviceCommand(args.commandPublicId);
          const localPhase = args.localPhase as "prepared_no_effect" | "effect_started";
          const staleAuthority = args.staleAuthority as AuthorityTuple;
          const authorityMatches = command.boundAuthority === undefined
            ? localPhase === "prepared_no_effect"
            : sameAuthorityTuple(command.boundAuthority, staleAuthority);
          const terminalMatches = command.state === "cancelled"
            || command.state === "expired"
            || (command.state === "ambiguous"
              && localPhase === "effect_started"
              && this.revokedDevices.has(command.requestingDevicePublicId));
          if (
            !authorityMatches
            || !terminalMatches
            || command.result !== undefined
            || command.resultCode !== undefined
            || command.resultConsumed === true
            || command.resultDigest !== undefined
            || command.singleUseResult !== undefined
          ) throw new Error("DEVICE_COMMAND_TERMINAL_RECOVERY_CONFLICT");
          return { publicId: command.publicId, replay: true, state: command.state };
        }
        if (name === "deviceCommands:recoverEffectStarted") {
          const command = this.requireDeviceCommand(args.commandPublicId);
          const recovery = args.recoveryAuthority as AuthorityTuple;
          const stale = args.staleAuthority as AuthorityTuple;
          if (command.state === args.state) {
            if (
              command.boundAuthority === undefined
              || !deviceCommandRecoveryReplayAdmitted({
                boundAuthority: command.boundAuthority,
                recoveryAuthority: recovery,
                staleAuthority: stale,
              })
              || command.resultCode !== args.resultCode
              || command.resultDigest !== args.resultDigest
            ) throw new Error("device command recovery conflict");
            return { publicId: command.publicId, replay: true, state: command.state };
          }
          const pendingWithoutAuthority = command.state === "pending"
            && command.boundAuthority === undefined;
          if (pendingWithoutAuthority) {
            const expectedState = args.localPhase === "prepared_no_effect"
              ? "failed"
              : "ambiguous";
            if (
              args.state !== expectedState
              || compareDeviceAuthority(recovery, stale) !== "after"
            ) throw new Error("stale device command recovery authority");
          } else if (
            (command.state !== "prepared" && command.state !== "effect_started")
            || !deviceCommandRecoveryAdmitted({
              recoveryAuthority: recovery,
              staleAuthority: stale,
              state: command.state,
              terminalState: args.state as "applied" | "failed" | "ambiguous",
            })
          ) throw new Error("stale device command recovery authority");
          command.boundAuthority = recovery;
          command.resultCode = args.resultCode as string;
          command.resultDigest = args.resultDigest as string;
          command.state = args.state as CommandState;
          if (this.failDeviceRecoveryAfterEffectOnce) {
            this.failDeviceRecoveryAfterEffectOnce = false;
            throw new Error("lost device command recovery response");
          }
          return { publicId: command.publicId, replay: false, state: command.state };
        }
        throw new Error(`unexpected mutation ${name}`);
      },
      query: async (name, args) => {
        guard();
        if (name === "presence:current") {
          if (this.revokedDevices.has(devicePublicId)) {
            throw new Error("Cloud authority is not current.");
          }
          return publicPresence(this.presences.get(devicePublicId));
        }
        if (name === "sessions:listHeads") {
          this.sessionHeadListCalls += 1;
          return [...this.heads.values()]
            .sort((left, right) =>
              right.updatedAt - left.updatedAt
              || left.publicId.localeCompare(right.publicId))
            .slice(0, args.limit as number);
        }
        if (name === "sessions:listHeadsPage") {
          this.sessionHeadListCalls += 1;
          const pagination = args.paginationOpts as Readonly<{
            cursor: string | null;
            numItems: number;
          }>;
          const start = pagination.cursor === null
            ? 0
            : Number.parseInt(pagination.cursor, 10);
          const heads = [...this.heads.values()].sort((left, right) =>
            right.updatedAt - left.updatedAt
            || left.publicId.localeCompare(right.publicId));
          const page = heads.slice(start, start + pagination.numItems);
          const next = start + page.length;
          return {
            continueCursor: String(next),
            isDone: next >= heads.length,
            page,
          };
        }
        if (name === "sessions:getHead") {
          const publicId = args.publicId as string;
          this.headGetCalls.push(publicId);
          if (this.failingHeadGets.has(publicId)) throw new Error("session head timeout");
          return this.heads.get(publicId) ?? null;
        }
        if (name === "sessions:getLatestChunks") {
          if (this.stallLatestChunks) return await new Promise<never>(() => undefined);
          const chunks = this.chunks.get(args.sessionPublicId as string) ?? [];
          return chunks.slice(Math.max(0, chunks.length - (args.limit as number)));
        }
        if (name === "leases:current") return this.leases.get(args.sessionPublicId as string) ?? null;
        if (
          name === "commands:listPendingForTarget"
          || name === "commands:listPendingForTargetPage"
          || name === "commands:listNonterminalForTargetPage"
        ) {
          const commands = [...this.commands.values()]
            .filter((command) =>
              command.targetDevicePublicId === devicePublicId
              && (name === "commands:listNonterminalForTargetPage"
                ? !["applied", "failed", "ambiguous", "cancelled", "expired"]
                  .includes(command.state)
                : command.state === "pending"))
            .map((command) => name === "commands:listNonterminalForTargetPage"
              ? publicCommandMetadata(command)
              : publicCommand(command));
          if (name === "commands:listPendingForTarget") return commands;
          if (this.forcePendingPaginationIncomplete) return {
            continueCursor: "0",
            isDone: false,
            page: [],
          };
          const pagination = args.paginationOpts as Readonly<{
            cursor: string | null;
            numItems: number;
          }>;
          const start = pagination.cursor === null
            ? 0
            : Number.parseInt(pagination.cursor, 10);
          const page = commands.slice(start, start + pagination.numItems);
          const next = start + page.length;
          if (next >= commands.length && this.afterPendingScan !== undefined) {
            const afterPendingScan = this.afterPendingScan;
            delete this.afterPendingScan;
            await afterPendingScan();
          }
          return {
            continueCursor: String(next),
            isDone: next >= commands.length,
            page,
          };
        }
        if (name === "commands:listForSession") {
          return [...this.commands.values()]
            .filter((command) => command.sessionPublicId === args.sessionPublicId)
            .map(publicCommand);
        }
        if (name === "commands:get") {
          const commandPublicId = args.commandPublicId as string;
          this.commandGetCalls.push(commandPublicId);
          if (this.failingCommandGets.has(commandPublicId)) {
            throw new Error("command recovery timeout");
          }
          const command = this.commands.get(commandPublicId);
          return command === undefined
            ? null
            : {
                ...publicCommand(command),
                requestDigest: command.requestDigest,
                ...(command.requestingDevicePublicId === undefined
                  ? {}
                  : { requestingDevicePublicId: command.requestingDevicePublicId }),
                targetDevicePublicId: command.targetDevicePublicId,
              };
        }
        if (name === "devices:list") {
          this.deviceListCalls += 1;
          return [
            {
              online: this.presences.get(devicePublicId) !== undefined,
              publicId: devicePublicId,
              status: "active",
            },
            ...this.peerDevices,
          ];
        }
        if (name === "devices:get") {
          const publicId = args.publicId as string;
          return {
            publicId,
            status: this.revokedDevices.has(publicId) ? "revoked" : "active",
          };
        }
        if (name === "usage:getAccountBinding") {
          const publicId = args.publicId as string;
          const account = this.accounts.get(publicId);
          return account === undefined
            ? null
            : {
                binding: {
                  encryptedLocalReference: account.encryptedLocalReference,
                  sourceGeneration: account.sourceGeneration,
                  state: "present",
                  usageSourceRevision: this.usageAdmissions
                    .get(`${publicId}:${devicePublicId}`)?.sourceRevision ?? 0,
                },
                encryptedMetadata: account.encryptedMetadata,
                matchKey: account.matchKey,
                publicId,
              };
        }
        if (name === "deviceCommands:listPendingForTarget") {
          this.deviceCommandPendingListCalls += 1;
          const commands = [...this.deviceCommands.values()]
            .filter((command) => command.state === "pending")
            .map(publicDeviceCommand);
          if (this.afterDeviceCommandPendingScan !== undefined) {
            const afterDeviceCommandPendingScan = this.afterDeviceCommandPendingScan;
            delete this.afterDeviceCommandPendingScan;
            await afterDeviceCommandPendingScan();
          }
          return commands;
        }
        if (name === "deviceCommands:get") {
          const command = this.deviceCommands.get(args.commandPublicId as string);
          return command === undefined
            ? null
            : {
                ...publicDeviceCommand(command),
                requestDigest: command.requestDigest,
                targetDevicePublicId: command.targetDevicePublicId,
              };
        }
        throw new Error(`unexpected query ${name}`);
      },
    };
  }

  requireDeviceCommand(value: unknown): FakeDeviceCommand {
    const command = typeof value === "string" ? this.deviceCommands.get(value) : undefined;
    if (command === undefined) throw new Error("missing device command");
    return command;
  }

  requireHead(value: unknown): FakeHead {
    const head = typeof value === "string" ? this.heads.get(value) : undefined;
    if (head === undefined) throw new Error("missing head");
    return head;
  }

  requireLease(value: unknown): FakeLease {
    const lease = typeof value === "string" ? this.leases.get(value) : undefined;
    if (lease === undefined) throw new Error("missing lease");
    return lease;
  }

  requireCommand(value: unknown): FakeCommand {
    const command = typeof value === "string" ? this.commands.get(value) : undefined;
    if (command === undefined) throw new Error("missing command");
    return command;
  }
}

class FakeLocal implements CloudDaemonLocalSourcePort {
  readonly events: CompactSessionEvent[];
  readonly sessionPublicId: string;
  readonly state: "idle" | "terminal";
  profileGeneration = 1;

  constructor(
    sessionPublicId: string,
    events: CompactSessionEvent[],
    state: "idle" | "terminal" = "idle",
  ) {
    this.sessionPublicId = sessionPublicId;
    this.events = events;
    this.state = state;
  }

  async listSessions() {
    return doneLocalSessionPage([{
      createdAt: fixedNow,
      metadata: { name: "Release", note: "Ship after the checks pass." },
      publicId: this.sessionPublicId,
      state: this.state,
      updatedAt: fixedNow,
    }]);
  }

  async readCompactEvents(input: { afterSequence: number; limit: number }) {
    const events = this.events
      .filter((event) => event.sequence > input.afterSequence)
      .slice(0, input.limit);
    return {
      cacheId: "cache_12345678",
      complete: events.at(-1)?.sequence === this.events.at(-1)?.sequence,
      events,
    };
  }

  async listUsage() {
    return [{
      localReference: "acct_local_12345678",
      matchReference: "reader@example.com",
      metadata: { label: "Primary", plan: "pro" },
      observedAt: fixedNow,
      projection: { state: "unavailable" as const },
      sourceGeneration: 1,
      sourceRevision: 1,
    }];
  }

  async resolveCommandAuthority(input: { sessionPublicId: string }) {
    if (input.sessionPublicId !== this.sessionPublicId) return null;
    return {
      localSessionId: this.sessionPublicId,
      profileGeneration: this.profileGeneration,
      profileId: "account_12345678",
      providerThreadId: "thread_12345678",
    };
  }
}

class EmptyLocal implements CloudDaemonLocalSourcePort {
  constructor(readonly sessionPublicId?: string) {}
  async listSessions(
    _input: Parameters<CloudDaemonLocalSourcePort["listSessions"]>[0],
  ): Promise<CloudLocalSessionPage> {
    void _input;
    return doneLocalSessionPage([]);
  }
  async readCompactEvents(_input: Parameters<
    CloudDaemonLocalSourcePort["readCompactEvents"]
  >[0]): Promise<Readonly<{
    cacheId: string;
    complete: boolean;
    events: readonly CompactSessionEvent[];
  }>> {
    void _input;
    return { cacheId: "cache_12345678", complete: true, events: [] };
  }
  async listUsage(
    _input: Parameters<CloudDaemonLocalSourcePort["listUsage"]>[0],
  ): Promise<readonly CloudLocalUsageSnapshot[]> {
    void _input;
    return [];
  }
  async resolveCommandAuthority(input: { sessionPublicId: string }) {
    if (input.sessionPublicId !== this.sessionPublicId) return null;
    return {
      localSessionId: input.sessionPublicId,
      profileGeneration: 1,
      profileId: "account_12345678",
      providerThreadId: "thread_12345678",
    };
  }
}

class FairPagedLocal extends EmptyLocal {
  #sessions: CloudLocalSessionHead[];
  readonly observedAfterPublicIds: Array<string | null> = [];

  constructor(count: number) {
    super();
    this.#sessions = Array.from({ length: count }, (_, index) => ({
      createdAt: fixedNow + index,
      metadata: { name: `Session ${index}`, note: null },
      publicId: `session_${index.toString().padStart(8, "0")}`,
      state: "idle" as const,
      updatedAt: fixedNow + index,
    }));
  }

  override async listSessions(input: {
    afterPublicId: string | null;
    limit: number;
  }): Promise<CloudLocalSessionPage> {
    this.observedAfterPublicIds.push(input.afterPublicId);
    const sorted = [...this.#sessions].sort((left, right) =>
      left.publicId.localeCompare(right.publicId));
    const remaining = input.afterPublicId === null
      ? sorted
      : sorted.filter((session) => session.publicId > input.afterPublicId!);
    const sessions = remaining.slice(0, input.limit);
    const isDone = remaining.length <= input.limit;
    return {
      continueAfterPublicId: isDone ? null : sessions.at(-1)?.publicId ?? null,
      isDone,
      sessions,
    };
  }

  touchNewest(count: number, updatedAt: number): void {
    const newest = new Set(
      [...this.#sessions]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, count)
        .map((session) => session.publicId),
    );
    this.#sessions = this.#sessions.map((session) => newest.has(session.publicId)
      ? { ...session, updatedAt }
      : session);
  }
}

class UsageBacklogLocal extends EmptyLocal {
  readonly accounts: readonly Readonly<{
    localReference: string;
    matchReference: string;
    snapshots: readonly CloudLocalUsageSnapshot[];
  }>[];

  constructor(input: readonly Readonly<{
    localReference: string;
    matchReference: string;
    revisions: number;
  }>[]) {
    super();
    this.accounts = input.map((account) => ({
      localReference: account.localReference,
      matchReference: account.matchReference,
      snapshots: Array.from({ length: account.revisions }, (_, index) => ({
        localReference: account.localReference,
        matchReference: account.matchReference,
        metadata: { label: account.localReference, plan: "pro" },
        observedAt: fixedNow - 1_000_000 + index + 1,
        projection: { state: "unavailable" as const },
        sourceGeneration: 1,
        sourceRevision: index + 1,
      })),
    }));
  }

  override async listUsage(input: { limit: number }) {
    return this.accounts.slice(0, input.limit).flatMap((account) => {
      const latest = account.snapshots.at(-1);
      return latest === undefined ? [] : [latest];
    });
  }

  async listUsageHistory(input: {
    afterSourceRevision: number;
    limit: number;
    localReference: string;
    sourceGeneration: number;
  }) {
    const account = this.accounts.find((candidate) =>
      candidate.localReference === input.localReference);
    if (account === undefined || input.sourceGeneration !== 1) return [];
    return account.snapshots
      .filter((snapshot) => snapshot.sourceRevision > input.afterSourceRevision)
      .slice(0, input.limit);
  }
}

class StalledProjectionLocal implements CloudDaemonLocalSourcePort {
  constructor(readonly sessionPublicId: string) {}

  async listSessions(input: { signal: AbortSignal }): Promise<never> {
    return await new Promise<never>((resolve, reject) => {
      const aborted = () => reject(input.signal.reason);
      if (input.signal.aborted) aborted();
      else input.signal.addEventListener("abort", aborted, { once: true });
      void resolve;
    });
  }

  async readCompactEvents() {
    return { cacheId: "cache_12345678", complete: true, events: [] };
  }
  async listUsage(): Promise<readonly never[]> {
    throw new Error("usage must remain behind the optional projection budget");
  }
  async resolveCommandAuthority(input: { sessionPublicId: string }) {
    if (input.sessionPublicId !== this.sessionPublicId) return null;
    return {
      localSessionId: this.sessionPublicId,
      profileGeneration: 1,
      profileId: "account_12345678",
      providerThreadId: "thread_12345678",
    };
  }
}

class IgnoreAbortProjectionLocal extends StalledProjectionLocal {
  listSessionCalls = 0;

  override async listSessions(): Promise<never> {
    this.listSessionCalls += 1;
    return await new Promise<never>(() => undefined);
  }
}

class DeferredIgnoreAbortProjectionLocal implements CloudDaemonLocalSourcePort {
  listSessionCalls = 0;
  readonly #pending: Promise<CloudLocalSessionPage>;
  #release!: (sessions: CloudLocalSessionPage) => void;

  constructor(readonly sessionPublicId: string) {
    this.#pending = new Promise((resolve) => { this.#release = resolve; });
  }

  async listSessions(): Promise<CloudLocalSessionPage> {
    this.listSessionCalls += 1;
    return await this.#pending;
  }

  async readCompactEvents() {
    return { cacheId: "cache_12345678", complete: true, events: [] };
  }
  async listUsage() { return []; }
  async resolveCommandAuthority() { return null; }

  release(sessions: readonly CloudLocalSessionHead[]): void {
    this.#release(doneLocalSessionPage(sessions));
  }
}

type RecoveryPlanInput = Parameters<NonNullable<
  CloudDaemonLocalSourcePort["planCompactProjectionRecovery"]
>>[0];
type RecoveryStageInput = Parameters<NonNullable<
  CloudDaemonLocalSourcePort["stageCompactProjectionRecovery"]
>>[0];
type RecoveryActivateInput = Parameters<NonNullable<
  CloudDaemonLocalSourcePort["activateCompactProjectionRecovery"]
>>[0];

class RecoveryLocal extends EmptyLocal {
  afterStage?: () => Promise<void>;
  activateCalls = 0;
  activated = false;
  baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[] = [];
  expectedBoundaryHeadSequence = 3;
  failActivationAfterEffectOnce = false;
  failDiscardOnce = false;
  observedInteractionIds: readonly string[] = [];
  planCalls = 0;
  stageCalls = 0;
  stageAuthorityCurrent = true;
  staged = false;
  terminal = false;
  readonly discardedRecoveryKeys: string[] = [];

  async planCompactProjectionRecovery(input: RecoveryPlanInput) {
    this.planCalls += 1;
    if (input.sessionPublicId !== this.sessionPublicId) throw new Error("wrong session");
    this.observedInteractionIds = input.observedInteractionIds;
    return {
      baselineCompletedTurns: [{ bodyDigest: "a".repeat(64), turnId: "turn_12345678" }],
      baselineInteractions: this.baselineInteractions,
      localAuthority: {
        profileGeneration: 1,
        profileId: "account_12345678",
        providerThreadId: "thread_12345678",
        providerUpdatedAt: fixedNow,
        sessionRevision: 1,
      },
      replacementCacheId: `cache_${input.idempotencyKey.replaceAll("-", "").slice(0, 48)}`,
      sessionPublicId: input.sessionPublicId,
      sourceCacheId: null,
    };
  }

  async stageCompactProjectionRecovery(input: RecoveryStageInput) {
    this.stageCalls += 1;
    if (!this.stageAuthorityCurrent) throw new Error("recovery local authority changed");
    if (
      input.sessionPublicId !== this.sessionPublicId
      || input.boundaryHeadSequence !== this.expectedBoundaryHeadSequence
      || input.compactStreamEpoch !== 1
    ) throw new Error("invalid recovery stage");
    this.staged = true;
    await this.afterStage?.();
  }

  async activateCompactProjectionRecovery(input: RecoveryActivateInput) {
    this.activateCalls += 1;
    if (!this.staged || input.sessionPublicId !== this.sessionPublicId) {
      throw new Error("recovery was not staged");
    }
    this.activated = true;
    if (this.failActivationAfterEffectOnce) {
      this.failActivationAfterEffectOnce = false;
      throw new Error("lost cache activation acknowledgement");
    }
  }

  discardCompactProjectionRecovery(input: { idempotencyKey: string }): Promise<void> {
    if (this.failDiscardOnce) {
      this.failDiscardOnce = false;
      return Promise.reject(new Error("lost recovery discard acknowledgement"));
    }
    this.discardedRecoveryKeys.push(input.idempotencyKey);
    this.staged = false;
    return Promise.resolve();
  }

  isSessionTerminal(sessionPublicId: string): boolean {
    return sessionPublicId === this.sessionPublicId && this.terminal;
  }
}

class RecoveryUploadingLocal extends RecoveryLocal {
  cacheId = "cache_recovery_pending";

  override async listSessions() {
    return doneLocalSessionPage([{
      createdAt: fixedNow,
      metadata: { name: "Recovered", note: null },
      publicId: this.sessionPublicId as string,
      state: "idle" as const,
      updatedAt: fixedNow,
    }]);
  }

  override async stageCompactProjectionRecovery(input: RecoveryStageInput) {
    await super.stageCompactProjectionRecovery(input);
    this.cacheId = input.replacementCacheId;
  }

  override async readCompactEvents(input: Parameters<
    CloudDaemonLocalSourcePort["readCompactEvents"]
  >[0]) {
    const projected: CompactSessionEvent[] = input.afterSequence < 4
      ? [{
          kind: "assistant_message",
          sequence: 4,
          text: "First post-recovery response",
          turnId: "turn_after_recovery",
        }]
      : [];
    return { cacheId: this.cacheId, complete: true, events: projected };
  }
}

class CommitThenThrowPreparedRecoveryJournal implements CloudDaemonJournalPort {
  readonly inner = new MemoryCloudDaemonJournal();
  #thrown = false;

  read(): Promise<CloudDaemonJournalObservation> {
    return this.inner.read();
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null> {
    const committed = await this.inner.compareAndSwap(expectedGeneration, state);
    if (
      committed !== null
      && !this.#thrown
      && committed.state.projectionRecoveries.some((entry) => entry.phase === "prepared")
    ) {
      this.#thrown = true;
      throw new Error("lost prepared journal acknowledgement");
    }
    return committed;
  }
}

class CommitThenThrowEffectStartedRecoveryJournal implements CloudDaemonJournalPort {
  readonly inner = new MemoryCloudDaemonJournal();
  #thrown = false;

  read(): Promise<CloudDaemonJournalObservation> {
    return this.inner.read();
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null> {
    const committed = await this.inner.compareAndSwap(expectedGeneration, state);
    if (
      committed !== null
      && !this.#thrown
      && committed.state.projectionRecoveries.some((entry) => entry.phase === "effect_started")
    ) {
      this.#thrown = true;
      throw new Error("lost effect-started journal acknowledgement");
    }
    return committed;
  }
}

class CommitThenThrowPreparedAndTerminalRecoveryJournal implements CloudDaemonJournalPort {
  readonly inner = new MemoryCloudDaemonJournal();
  #preparedThrown = false;
  #terminalThrown = false;

  read(): Promise<CloudDaemonJournalObservation> {
    return this.inner.read();
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null> {
    const committed = await this.inner.compareAndSwap(expectedGeneration, state);
    if (
      committed !== null
      && !this.#preparedThrown
      && committed.state.projectionRecoveries.some((entry) => entry.phase === "prepared")
    ) {
      this.#preparedThrown = true;
      throw new Error("lost prepared journal acknowledgement");
    }
    if (
      committed !== null
      && !this.#terminalThrown
      && committed.state.projectionRecoveryReceipts.length > 0
    ) {
      this.#terminalThrown = true;
      throw new Error("lost terminal recovery acknowledgement");
    }
    return committed;
  }
}

class CommitThenThrowTerminalRecoveryJournal implements CloudDaemonJournalPort {
  readonly inner = new MemoryCloudDaemonJournal();
  #thrown = false;

  read(): Promise<CloudDaemonJournalObservation> {
    return this.inner.read();
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null> {
    const committed = await this.inner.compareAndSwap(expectedGeneration, state);
    if (
      committed !== null
      && !this.#thrown
      && committed.state.projectionRecoveryReceipts.length > 0
    ) {
      this.#thrown = true;
      throw new Error("lost terminal recovery acknowledgement");
    }
    return committed;
  }
}

function identity(devicePublicId: string): CloudDaemonIdentityPort {
  const activeIdentity: ActiveCloudIdentity = {
    accountKey: key,
    devicePublicId,
    keyVersion: 1,
    userPublicId,
  };
  return {
    async requireActive() {
      return activeIdentity;
    },
    async requireRegistered() {
      return {
        activeIdentity,
        authEpoch: 1,
        credentialGeneration: 1,
        devicePublicId,
        status: "active",
        userPublicId,
      };
    },
  };
}

class MutableIdentity implements CloudDaemonIdentityPort {
  current: RegisteredCloudIdentity;

  constructor(current: RegisteredCloudIdentity) {
    this.current = current;
  }

  async requireActive(): Promise<ActiveCloudIdentity> {
    if (this.current.status !== "active") throw new Error("active identity was requested");
    return this.current.activeIdentity;
  }

  async requireRegistered(): Promise<RegisteredCloudIdentity> {
    return this.current;
  }
}

class IdentityCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return this.values.get(slot) ?? null;
  }

  async compareAndSwap(): Promise<null> {
    throw new Error("identity fixture must not refresh custody");
  }

  async clearIfGeneration(): Promise<boolean> {
    return false;
  }
}

class DeploymentCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return this.values.get(slot) ?? null;
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const current = this.values.get(slot) ?? null;
    if ((current?.generation ?? null) !== expectedGeneration) return null;
    const next = { generation: expectedGeneration === null ? 0 : expectedGeneration + 1, value };
    this.values.set(slot, next);
    return next;
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    if (this.values.get(slot)?.generation !== expectedGeneration) return false;
    return this.values.delete(slot);
  }
}

function pendingIdentity(input: Readonly<{
  authEpoch?: number;
  credentialGeneration?: number;
  devicePublicId?: string;
  userPublicId?: string;
}> = {}): RegisteredCloudIdentity {
  return {
    activeIdentity: null,
    authEpoch: input.authEpoch ?? 1,
    credentialGeneration: input.credentialGeneration ?? 1,
    devicePublicId: input.devicePublicId ?? "device_11111111",
    status: "pending",
    userPublicId: input.userPublicId ?? userPublicId,
  };
}

function activeIdentity(input: Readonly<{
  authEpoch?: number;
  credentialGeneration?: number;
  devicePublicId?: string;
  userPublicId?: string;
}> = {}): RegisteredCloudIdentity {
  const devicePublicId = input.devicePublicId ?? "device_11111111";
  const identityUserPublicId = input.userPublicId ?? userPublicId;
  return {
    activeIdentity: {
      accountKey: key,
      devicePublicId,
      keyVersion: 1,
      userPublicId: identityUserPublicId,
    },
    authEpoch: input.authEpoch ?? 1,
    credentialGeneration: input.credentialGeneration ?? 1,
    devicePublicId,
    status: "active",
    userPublicId: identityUserPublicId,
  };
}

class RecordingExecutor implements CloudCommandExecutorPort {
  readonly calls: Array<{ idempotencyKey: string; sessionPublicId: string }> = [];

  async execute(input: { idempotencyKey: string; sessionPublicId: string }) {
    this.calls.push({
      idempotencyKey: input.idempotencyKey,
      sessionPublicId: input.sessionPublicId,
    });
    return { code: "APPLIED", state: "applied" as const };
  }
}

function bridge(input: {
  cloud: FakeCloud;
  daemonAuthority?: AuthorityTuple;
  daemonAuthorityFence?: Readonly<{ assertCurrent(): Promise<void> }>;
  deploymentAuthority?: CloudDeploymentAuthority;
  device: string;
  deviceExecutor?: CloudDeviceCommandExecutorPort;
  executor?: RecordingExecutor;
  identity?: CloudDaemonIdentityPort;
  journal?: CloudDaemonJournalPort;
  local: CloudDaemonLocalSourcePort;
  now?: () => number;
  optionalSyncBudgetMs?: number;
  pushWake?: CloudPushWakePort;
  randomConnectionUuid?: () => string;
  sessionSyncCursor?: CloudSessionSyncCursorPort;
  transport?: CloudTransport;
}) {
  let uuidSequence = 100;
  return new LocalCloudDaemonBridge({
    daemonAuthority: input.daemonAuthority
      ?? { bootGeneration: 1, bootId: "boot_12345678", fence: 1 },
    daemonAuthorityFence: input.daemonAuthorityFence
      ?? { assertCurrent: () => Promise.resolve() },
    deploymentAuthority: input.deploymentAuthority ?? {
      assertCurrent: () => Promise.resolve(),
      cacheNamespace: null,
      custodyMode: "legacy",
      deploymentUrl: "https://example.convex.cloud",
      generation: 0,
      scopeCustodySlot: (slot) => slot,
    },
    ...(input.deviceExecutor === undefined ? {} : { deviceExecutor: input.deviceExecutor }),
    executor: input.executor ?? new RecordingExecutor(),
    identity: input.identity ?? identity(input.device),
    journal: input.journal ?? new MemoryCloudDaemonJournal(),
    leaseDurationMs: 5_000,
    local: input.local,
    now: input.now ?? (() => input.cloud.now),
    ...(input.optionalSyncBudgetMs === undefined
      ? {}
      : { optionalSyncBudgetMs: input.optionalSyncBudgetMs }),
    ...(input.pushWake === undefined ? {} : { pushWake: input.pushWake }),
    randomConnectionUuid: input.randomConnectionUuid
      ?? (() => connectionUuid(connectionUuidSequence += 1)),
    randomUuid: () => uuidV7(uuidSequence++, input.cloud.now),
    sessionSyncCursor: input.sessionSyncCursor ?? new MemoryCloudSessionSyncCursor(),
    transport: input.transport ?? input.cloud.connect(input.device),
  });
}

const events: CompactSessionEvent[] = [
  { kind: "user_message", sequence: 1, text: "Run the checks", turnId: "turn_12345678" },
  { kind: "assistant_message", sequence: 2, text: "All checks pass.", turnId: "turn_12345678" },
  {
    fast: false,
    filesTouched: ["src/index.ts"],
    gitActions: [{ kind: "status" }],
    kind: "turn_summary",
    model: "high",
    runtimeMs: 1_250,
    sequence: 3,
    turnId: "turn_12345678",
  },
];

async function installRecoverableHead(
  cloud: FakeCloud,
  sessionPublicId: string,
  compactEvents: readonly CompactSessionEvent[] = events,
): Promise<void> {
  const authority = {
    bootGeneration: 1,
    bootId: "boot_12345678",
    fence: 1,
  } as const;
  cloud.chunks.set(sessionPublicId, [{
    authority,
    createdAt: fixedNow,
    digest: "f".repeat(64),
    envelope: await encryptCompactEvents(compactEvents, key, {
      firstSequence: 1,
      keyVersion: 1,
      lastSequence: compactEvents.length,
      sessionPublicId,
      sourceBootId: authority.bootId,
      sourceDevicePublicId: "device_11111111",
      sourceFence: authority.fence,
      stream: "compact",
      userPublicId,
    }),
    firstSequence: 1,
    lastSequence: compactEvents.length,
    sourceDevicePublicId: "device_11111111",
    stream: "compact",
    streamEpoch: 0,
  }]);
  cloud.heads.set(sessionPublicId, {
    compactHeadSequence: compactEvents.length,
    compactTailDigest: "f".repeat(64),
    createdAt: fixedNow,
    detailHeadSequence: 0,
    executionDevicePublicId: "device_11111111",
    metadataRevision: 1,
    projectionRevision: 1,
    publicId: sessionPublicId,
    state: "idle",
    updatedAt: fixedNow,
  });
}

function saturatedCommandJournal(
  candidate: CloudCommandJournalEntry,
): CloudDaemonJournalState {
  const terminalCommands: CloudCommandJournalEntry[] = Array.from(
    { length: 95 },
    (_, index) => ({
      authority: {
        bootGeneration: 1,
        bootId: "boot_12345678",
        fence: 1,
      },
      commandPublicId: uuidV7(4_000 + index),
      kind: "stop",
      localAuthorityDigest: "a".repeat(64),
      payloadDigest: "b".repeat(64),
      phase: "terminal",
      resultCode: "APPLIED",
      resultDigest: "c".repeat(64),
      sessionPublicId: `session_saturated_${String(index).padStart(4, "0")}`,
      terminalState: "applied",
    }),
  );
  const pending = (ciphertextCharacters: number) => ({
    accountPublicId: "account_saturated_12345678",
    encryptedLocalReference: {
      algorithm: "A256GCM" as const,
      ciphertext: "d".repeat(22),
      keyVersion: 1,
      nonce: "e".repeat(16),
    },
    encryptedMetadata: {
      algorithm: "A256GCM" as const,
      ciphertext: "f".repeat(ciphertextCharacters),
      keyVersion: 1,
      nonce: "g".repeat(16),
    },
    idempotencyKey: uuidV7(4_100),
    matchKey: "d".repeat(64),
    requestDigest: "e".repeat(64),
    sourceGeneration: 1,
    sourceRevision: 0,
  });
  const build = (ciphertextCharacters: number): CloudDaemonJournalState => ({
    commands: terminalCommands,
    deviceCommands: [],
    pendingUsageAccount: pending(ciphertextCharacters),
    projectionRecoveries: [],
    projectionRecoveryReceipts: [],
    usageAccounts: [],
    version: 5,
  });
  const maximumBytes = 65_536;
  let lower = 22;
  let upper = 16_384;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const actual = JSON.stringify({
      ...build(middle),
      commands: [...terminalCommands, candidate],
    }).length;
    if (actual <= maximumBytes) lower = middle;
    else upper = middle - 1;
  }
  const state = parseCloudDaemonJournal(build(lower));
  expect(JSON.stringify({
    ...state,
    commands: [...state.commands, candidate],
  }).length).toBeLessThanOrEqual(maximumBytes);
  expect(JSON.stringify({
    ...state,
    commands: [...state.commands, {
      ...candidate,
      authority: {
        bootGeneration: Number.MAX_SAFE_INTEGER,
        bootId: "b".repeat(96),
        fence: Number.MAX_SAFE_INTEGER,
      },
      phase: "terminal",
      resultCode: "R".repeat(64),
      resultDigest: "f".repeat(64),
      terminalState: "ambiguous",
    }],
  }).length).toBeGreaterThan(maximumBytes);
  return state;
}

describe("cloud daemon bridge", () => {
  test("control and daemon factories converge on one bound deployment before transport", async () => {
    const custody = new DeploymentCustody();
    const environment = { HRA_CONVEX_URL: "https://shared.convex.cloud/" };
    let transportCalls = 0;
    const transport: CloudTransport = {
      action: async () => { transportCalls += 1; throw new Error("unexpected transport"); },
      mutation: async () => { transportCalls += 1; throw new Error("unexpected transport"); },
      query: async () => { transportCalls += 1; throw new Error("unexpected transport"); },
    };
    const control = await createLocalCloudControlFromEnvironment({
      environment,
      secretCustody: custody,
      transport,
    });
    if (control === null) throw new Error("fixture control is disabled");
    const daemon = await createLocalCloudDaemonBridgeFromEnvironment({
      daemonAuthority: { bootGeneration: 1, bootId: "boot_shared_target_12345678" },
      daemonAuthorityFence: { assertCurrent: () => Promise.resolve() },
      environment,
      executor: new RecordingExecutor(),
      local: new EmptyLocal(),
      registration: control,
      secretCustody: custody,
      transport,
    });
    expect(daemon).toBeInstanceOf(LocalCloudDaemonBridge);
    expect(transportCalls).toBe(0);
    const binding = custody.values.get("cloud-deployment-authority");
    expect(binding?.generation).toBe(0);
    expect(JSON.parse(binding?.value ?? "null")).toMatchObject({
      deploymentUrl: "https://shared.convex.cloud",
      version: 1,
    });
  });

  test("refuses stale deployment authority before identity credentials or transport", async () => {
    const custody = new DeploymentCustody();
    const deploymentAuthority = await cloudDeploymentAuthorityFromEnvironment(custody, {
      HRA_CONVEX_URL: "https://example.convex.cloud",
    });
    if (deploymentAuthority === null) throw new Error("fixture authority is disabled");
    const cloud = new FakeCloud();
    let identityCalls = 0;
    let transportCalls = 0;
    const guardedIdentity: CloudDaemonIdentityPort = {
      async requireActive() {
        identityCalls += 1;
        throw new Error("unexpected identity credential read");
      },
      async requireRegistered() {
        identityCalls += 1;
        throw new Error("unexpected identity credential read");
      },
    };
    const guardedTransport: CloudTransport = {
      action: async () => { transportCalls += 1; throw new Error("unexpected transport"); },
      mutation: async () => { transportCalls += 1; throw new Error("unexpected transport"); },
      query: async () => { transportCalls += 1; throw new Error("unexpected transport"); },
    };
    const daemon = bridge({
      cloud,
      deploymentAuthority,
      device: "device_11111111",
      identity: guardedIdentity,
      local: new EmptyLocal(),
      transport: guardedTransport,
    });
    custody.values.delete("cloud-deployment-authority");

    const result = await daemon.cycle(new AbortController().signal);
    expect(result.online).toBe(false);
    expect(result.errors).toEqual(["Cloud deployment authority is not current."]);
    expect(identityCalls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  test("reads current credential generation for registered pending devices and migrates legacy absence to one", async () => {
    const custody = new IdentityCustody();
    const publicKey = JSON.stringify({
      crv: "P-256",
      kty: "EC",
      x: "A".repeat(43),
      y: "B".repeat(43),
    });
    const privateKey = JSON.stringify({
      crv: "P-256",
      d: "C".repeat(43),
      kty: "EC",
      x: "A".repeat(43),
      y: "B".repeat(43),
    });
    custody.values.set("cloud-auth", {
      generation: 0,
      value: JSON.stringify({
        email: "reader@example.com",
        obtainedAt: fixedNow,
        refreshToken: "r".repeat(32),
        token: "t".repeat(32),
        version: 1,
      }),
    });
    custody.values.set("cloud-device", {
      generation: 0,
      value: JSON.stringify({
        publicId: "device_pending1",
        registered: true,
        signingPrivateKey: privateKey,
        signingPublicKey: publicKey,
        userPublicId,
        version: 1,
        wrappingPrivateKey: privateKey,
        wrappingPublicKey: publicKey,
      }),
    });
    let includeCredentialGeneration = true;
    const transport: CloudTransport = {
      async action() { throw new Error("unexpected action"); },
      async mutation() { throw new Error("unexpected mutation"); },
      async query(name) {
        if (name !== "account:current") throw new Error("unexpected query");
        return {
          authEpoch: 3,
          device: {
            ...(includeCredentialGeneration ? { credentialGeneration: 7 } : {}),
            keyVersion: 1,
            publicId: "device_pending1",
            revision: 9,
            status: "pending",
          },
          hasActiveDevices: true,
          userPublicId,
        };
      },
    };
    const observed = new CustodyCloudDaemonIdentity({
      custody,
      now: () => fixedNow,
      transport,
    });

    expect(await observed.requireRegistered(new AbortController().signal)).toEqual({
      activeIdentity: null,
      authEpoch: 3,
      credentialGeneration: 7,
      devicePublicId: "device_pending1",
      status: "pending",
      userPublicId,
    });
    includeCredentialGeneration = false;
    expect(await observed.requireRegistered(new AbortController().signal)).toMatchObject({
      credentialGeneration: 1,
      status: "pending",
    });
    await expect(observed.requireActive(new AbortController().signal)).rejects.toThrow(
      "active paired cloud device",
    );
  });

  test("registers before daemon identity acquisition and gives pending devices presence only", async () => {
    const cloud = new FakeCloud();
    const custody = new IdentityCustody();
    const publicKey = JSON.stringify({
      crv: "P-256",
      kty: "EC",
      x: "A".repeat(43),
      y: "B".repeat(43),
    });
    const privateKey = JSON.stringify({
      crv: "P-256",
      d: "C".repeat(43),
      kty: "EC",
      x: "A".repeat(43),
      y: "B".repeat(43),
    });
    custody.values.set("cloud-auth", {
      generation: 0,
      value: JSON.stringify({
        email: "pending@example.com",
        obtainedAt: fixedNow,
        refreshToken: "r".repeat(32),
        token: "t".repeat(32),
        version: 1,
      }),
    });
    let registered = false;
    let registrationCalls = 0;
    const observed = new CustodyCloudDaemonIdentity({
      custody,
      now: () => fixedNow,
      registration: {
        async ensureDeviceRegistered() {
          registrationCalls += 1;
          registered = true;
          custody.values.set("cloud-device", {
            generation: 0,
            value: JSON.stringify({
              publicId: "device_pending2",
              registered: true,
              signingPrivateKey: privateKey,
              signingPublicKey: publicKey,
              userPublicId,
              version: 1,
              wrappingPrivateKey: privateKey,
              wrappingPublicKey: publicKey,
            }),
          });
        },
      },
      transport: {
        async action() { throw new Error("unexpected action"); },
        async mutation() { throw new Error("unexpected mutation"); },
        async query(name) {
          if (name !== "account:current") throw new Error("unexpected query");
          return {
            authEpoch: 1,
            device: registered
              ? {
                  credentialGeneration: 1,
                  keyVersion: 1,
                  publicId: "device_pending2",
                  revision: 1,
                  status: "pending",
                }
              : null,
            hasActiveDevices: true,
            userPublicId,
          };
        },
      },
    });
    const adapter = bridge({
      cloud,
      device: "device_pending2",
      identity: observed,
      local: new EmptyLocal(),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result).toMatchObject({ errors: [], online: true, sessionsUploaded: 0 });
    expect(registrationCalls).toBe(1);
    expect(cloud.presences.get("device_pending2")).toMatchObject({ sequence: 0 });
    expect(cloud.sessionHeadListCalls).toBe(0);
    expect(custody.values.has("cloud-account-key")).toBe(false);
  });

  test("replays a lost presence request exactly before advancing its monotonic sequence", async () => {
    const cloud = new FakeCloud();
    const daemonConnectionId = "11111111-1111-4111-8111-111111111111";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      randomConnectionUuid: () => daemonConnectionId,
    });
    cloud.failPresenceAfterEffectOnce = true;

    const lost = await adapter.cycle(new AbortController().signal);
    expect(lost.online).toBe(false);
    expect(lost.errors.join(" ")).toContain("lost presence response");
    const first = cloud.presenceMutationCalls[0];
    expect(first).toMatchObject({ name: "presence:connect" });
    expect(first?.args).toEqual({
      connectionId: daemonConnectionId,
      credentialGeneration: 1,
      fingerprint: await sha256Hex([
        "hra-control-plane-cloud-presence:v1",
        userPublicId,
        "1",
        "device_11111111",
        "1",
        daemonConnectionId,
        "connect",
        "0",
      ].join("\n")),
      sequence: 0,
    });

    cloud.now += 40_001;
    const replayed = await adapter.cycle(new AbortController().signal);
    expect(replayed.errors).toEqual([]);
    expect(cloud.presenceMutationCalls[1]).toEqual(first);
    expect(cloud.presenceMutationCalls[2]).toMatchObject({
      args: {
        connectionId: daemonConnectionId,
        credentialGeneration: 1,
        sequence: 1,
      },
      name: "presence:heartbeat",
    });
    expect(cloud.presenceMutationCalls[2]?.args.fingerprint).toBe(await sha256Hex([
      "hra-control-plane-cloud-presence:v1",
      userPublicId,
      "1",
      "device_11111111",
      "1",
      daemonConnectionId,
      "heartbeat",
      "1",
    ].join("\n")));
    expect(cloud.presences.get("device_11111111")?.sequence).toBe(1);

    const advanced = await adapter.cycle(new AbortController().signal);
    expect(advanced.errors).toEqual([]);
    expect(cloud.presenceMutationCalls[3]).toMatchObject({
      args: {
        connectionId: daemonConnectionId,
        credentialGeneration: 1,
        sequence: 2,
      },
      name: "presence:heartbeat",
    });
  });

  test("rejects a competing live daemon connection until the prior server TTL expires", async () => {
    const cloud = new FakeCloud();
    const first = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      randomConnectionUuid: () => "11111111-1111-4111-8111-111111111111",
    });
    const restarted = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      randomConnectionUuid: () => "22222222-2222-4222-8222-222222222222",
    });
    expect((await first.cycle(new AbortController().signal)).errors).toEqual([]);
    const dataReads = cloud.sessionHeadListCalls;

    const conflicted = await restarted.cycle(new AbortController().signal);
    expect(conflicted.online).toBe(false);
    expect(conflicted.errors).toEqual(["PRESENCE_CONNECTION_CONFLICT"]);
    const crashedAttempt = cloud.presenceMutationCalls[1];
    expect(cloud.sessionHeadListCalls).toBe(dataReads);

    cloud.now += 45_001;
    expect((await restarted.cycle(new AbortController().signal)).errors).toEqual([]);
    expect(cloud.presenceMutationCalls[2]).toEqual(crashedAttempt);
    expect(cloud.presences.get("device_11111111")).toMatchObject({
      connectionId: "22222222-2222-4222-8222-222222222222",
      sequence: 0,
    });
    await first.close();
    await restarted.close();
  });

  test("reports pending-device presence without acquiring data authority", async () => {
    const cloud = new FakeCloud();
    const observedIdentity = new MutableIdentity(pendingIdentity());
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      identity: observedIdentity,
      local: new EmptyLocal(),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result).toMatchObject({ errors: [], online: true, sessionsUploaded: 0 });
    expect(cloud.presences.get("device_11111111")).toMatchObject({ sequence: 0 });
    expect(cloud.sessionHeadListCalls).toBe(0);
  });

  test("fences stale credential generations and revocation before cloud data work", async () => {
    const cloud = new FakeCloud();
    const observedIdentity = new MutableIdentity(activeIdentity());
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      identity: observedIdentity,
      local: new EmptyLocal(),
    });
    expect((await adapter.cycle(new AbortController().signal)).errors).toEqual([]);
    const firstConnection = cloud.presenceMutationCalls[0]?.args.connectionId;
    const dataReads = cloud.sessionHeadListCalls;

    cloud.credentialGenerations.set("device_11111111", 2);
    const stale = await adapter.cycle(new AbortController().signal);
    expect(stale.online).toBe(false);
    expect(stale.errors.join(" ")).toContain("Cloud authority is not current");
    expect(cloud.sessionHeadListCalls).toBe(dataReads);

    const presence = cloud.presences.get("device_11111111");
    if (presence === undefined) throw new Error("missing presence fixture");
    presence.presenceUntil = cloud.now;
    observedIdentity.current = activeIdentity({ credentialGeneration: 2 });
    expect((await adapter.cycle(new AbortController().signal)).errors).toEqual([]);
    expect(cloud.presenceMutationCalls.at(-1)).toMatchObject({
      args: { credentialGeneration: 2, sequence: 0 },
      name: "presence:connect",
    });
    expect(cloud.presenceMutationCalls.at(-1)?.args.connectionId).not.toBe(firstConnection);

    cloud.revokedDevices.add("device_11111111");
    const revoked = await adapter.cycle(new AbortController().signal);
    expect(revoked.online).toBe(false);
    expect(revoked.errors.join(" ")).toContain("Cloud authority is not current");
    expect(cloud.sessionHeadListCalls).toBe(dataReads + 2);
    await adapter.close();
  });

  test("resets connection and sequence on cloud user, device, auth epoch, or generation change", async () => {
    const cloud = new FakeCloud();
    const observedIdentity = new MutableIdentity(pendingIdentity());
    const uuids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    const dynamicTransport: CloudTransport = {
      async action(name, args) {
        return await cloud.connect(observedIdentity.current.devicePublicId).action(name, args);
      },
      async mutation(name, args) {
        return await cloud.connect(observedIdentity.current.devicePublicId).mutation(name, args);
      },
      async query(name, args) {
        return await cloud.connect(observedIdentity.current.devicePublicId).query(name, args);
      },
    };
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      identity: observedIdentity,
      local: new EmptyLocal(),
      randomConnectionUuid: () => {
        const next = uuids.shift();
        if (next === undefined) throw new Error("connection UUID fixture exhausted");
        return next;
      },
      transport: dynamicTransport,
    });
    await adapter.cycle(new AbortController().signal);
    const first = cloud.presences.get("device_11111111");
    if (first === undefined) throw new Error("missing first presence fixture");
    first.presenceUntil = cloud.now;

    observedIdentity.current = pendingIdentity({ userPublicId: "user_22222222" });
    await adapter.cycle(new AbortController().signal);
    observedIdentity.current = pendingIdentity({
      devicePublicId: "device_22222222",
      userPublicId: "user_22222222",
    });
    await adapter.cycle(new AbortController().signal);
    const secondDevice = cloud.presences.get("device_22222222");
    if (secondDevice === undefined) throw new Error("missing second presence fixture");
    secondDevice.presenceUntil = cloud.now;

    observedIdentity.current = pendingIdentity({
      authEpoch: 2,
      devicePublicId: "device_22222222",
      userPublicId: "user_22222222",
    });
    await adapter.cycle(new AbortController().signal);
    const secondEpoch = cloud.presences.get("device_22222222");
    if (secondEpoch === undefined) throw new Error("missing epoch presence fixture");
    secondEpoch.presenceUntil = cloud.now;
    cloud.credentialGenerations.set("device_22222222", 2);

    observedIdentity.current = pendingIdentity({
      authEpoch: 2,
      credentialGeneration: 2,
      devicePublicId: "device_22222222",
      userPublicId: "user_22222222",
    });
    await adapter.cycle(new AbortController().signal);

    expect(cloud.presenceMutationCalls).toHaveLength(5);
    expect(cloud.presenceMutationCalls.map((call) => call.name)).toEqual([
      "presence:connect",
      "presence:connect",
      "presence:connect",
      "presence:connect",
      "presence:connect",
    ]);
    expect(cloud.presenceMutationCalls.map((call) => call.args.sequence)).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(new Set(cloud.presenceMutationCalls.map((call) => call.args.connectionId)).size)
      .toBe(5);
  });

  test("disconnects with the exact possibly-committed heartbeat and never masks shutdown", async () => {
    const cloud = new FakeCloud();
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      optionalSyncBudgetMs: 1,
    });
    expect((await adapter.cycle(new AbortController().signal)).errors).toEqual([]);
    cloud.failPresenceAfterEffectOnce = true;
    expect((await adapter.cycle(new AbortController().signal)).errors.join(" "))
      .toContain("lost presence response");
    const heartbeat = cloud.presenceMutationCalls.at(-1);

    await adapter.close();

    expect(cloud.presenceMutationCalls.at(-1)).toEqual({
      args: heartbeat?.args ?? {},
      devicePublicId: "device_11111111",
      name: "presence:disconnect",
    });
    expect(cloud.presences.get("device_11111111")?.presenceUntil).toBe(cloud.now);

    const failedBeforeCloud = new FakeCloud();
    const failedBefore = bridge({
      cloud: failedBeforeCloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      optionalSyncBudgetMs: 10,
    });
    await failedBefore.cycle(new AbortController().signal);
    failedBeforeCloud.failPresenceBeforeEffectOnce = true;
    expect((await failedBefore.cycle(new AbortController().signal)).errors.join(" "))
      .toContain("presence unavailable before effect");
    await failedBefore.close();
    expect(failedBeforeCloud.presenceMutationCalls.slice(-2).map((call) => ({
      name: call.name,
      sequence: call.args.sequence,
    }))).toEqual([
      { name: "presence:disconnect", sequence: 1 },
      { name: "presence:disconnect", sequence: 0 },
    ]);
    expect(failedBeforeCloud.presences.get("device_11111111")?.presenceUntil)
      .toBe(failedBeforeCloud.now);

    const stalledCloud = new FakeCloud();
    const stalled = bridge({
      cloud: stalledCloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      optionalSyncBudgetMs: 1,
    });
    await stalled.cycle(new AbortController().signal);
    stalledCloud.stallPresenceDisconnect = true;
    await expect(Promise.race([
      stalled.close().then(() => "closed" as const),
      Bun.sleep(50).then(() => "timed_out" as const),
    ])).resolves.toBe("closed");
  });

  test("derives presence TTL from server time and rejects an excessive server lease", async () => {
    const healthyCloud = new FakeCloud();
    const healthy = bridge({
      cloud: healthyCloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      now: () => 1,
    });
    expect((await healthy.cycle(new AbortController().signal)).errors).toEqual([]);

    const malformedCloud = new FakeCloud();
    malformedCloud.presenceTtlMs = 120_001;
    const malformed = await bridge({
      cloud: malformedCloud,
      device: "device_11111111",
      local: new EmptyLocal(),
    }).cycle(new AbortController().signal);
    expect(malformed.online).toBe(false);
    expect(malformed.errors).toEqual(["Cloud presence response is invalid."]);
    expect(malformedCloud.sessionHeadListCalls).toBe(0);
  });

  test("uploads every stable local session page across hot updates and a daemon restart", async () => {
    const cloud = new FakeCloud();
    const local = new FairPagedLocal(60);
    const sessionSyncCursor = new MemoryCloudSessionSyncCursor();
    let daemon = bridge({
      cloud,
      device: "device_11111111",
      local,
      sessionSyncCursor,
    });

    expect((await daemon.cycle(new AbortController().signal)).errors).toEqual([]);
    await daemon.close();
    local.touchNewest(25, fixedNow + 10_000);
    daemon = bridge({
      cloud,
      device: "device_11111111",
      local,
      sessionSyncCursor,
    });
    expect((await daemon.cycle(new AbortController().signal)).errors).toEqual([]);
    local.touchNewest(25, fixedNow + 20_000);
    expect((await daemon.cycle(new AbortController().signal)).errors).toEqual([]);

    expect(local.observedAfterPublicIds).toEqual([
      null,
      "session_00000024",
      "session_00000049",
    ]);
    expect(new Set(cloud.sessionCreateCalls).size).toBe(60);
    expect(cloud.sessionCreateCalls).toContain("session_00000000");
    expect((await sessionSyncCursor.read()).state.localAfterPublicId).toBeNull();
  });

  test("pulls every remote session page while the newest page stays hot across restart", async () => {
    const cloud = new FakeCloud();
    const hottest = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const publicId = `session_${index.toString().padStart(8, "0")}`;
      if (index >= 35) hottest.add(publicId);
      cloud.heads.set(publicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow + index,
        detailHeadSequence: 0,
        executionDevicePublicId: "device_22222222",
        metadataRevision: 0,
        projectionRevision: 0,
        publicId,
        state: "idle",
        updatedAt: fixedNow + index,
      });
    }
    const sessionSyncCursor = new MemoryCloudSessionSyncCursor();
    let daemon = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      sessionSyncCursor,
    });
    const observed = new Set<string>();
    for (let cycleNumber = 0; cycleNumber < 3; cycleNumber += 1) {
      for (const publicId of hottest) {
        const head = cloud.heads.get(publicId);
        if (head !== undefined) head.updatedAt = fixedNow + 10_000 + cycleNumber;
      }
      const result = await daemon.cycle(new AbortController().signal);
      expect(result.errors).toEqual([]);
      for (const session of result.remoteSessions) observed.add(session.publicId);
      if (cycleNumber === 0) {
        expect((await sessionSyncCursor.read()).state.remoteContinueCursor).toBe("25");
        await daemon.close();
        daemon = bridge({
          cloud,
          device: "device_11111111",
          local: new EmptyLocal(),
          sessionSyncCursor,
        });
      }
    }

    expect(observed.size).toBe(60);
    expect(observed).toContain("session_00000000");
    expect((await sessionSyncCursor.read()).state.remoteContinueCursor).toBeNull();
  });

  test("rejects a nonadvancing remote page without changing durable cursor authority", async () => {
    const cloud = new FakeCloud();
    const sessionSyncCursor = new MemoryCloudSessionSyncCursor();
    const underlying = cloud.connect("device_11111111");
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      sessionSyncCursor,
      transport: {
        action: (name, args) => underlying.action(name, args),
        mutation: (name, args) => underlying.mutation(name, args),
        async query(name, args) {
          if (name === "sessions:listHeadsPage") {
            return { continueCursor: "", isDone: false, page: [] };
          }
          return await underlying.query(name, args);
        },
      },
    });

    await expect(daemon.pullRemoteSessions(new AbortController().signal)).rejects.toThrow(
      "Cloud session page is invalid.",
    );
    expect((await sessionSyncCursor.read()).state).toEqual({
      localAfterPublicId: null,
      remoteContinueCursor: null,
      remoteCycle: null,
      version: 2,
    });
  });

  test("rejects a durable remote cursor cycle across separate pull cycles", async () => {
    const cloud = new FakeCloud();
    const sessionSyncCursor = new MemoryCloudSessionSyncCursor();
    const underlying = cloud.connect("device_11111111");
    const continuations = ["cursor-a", "cursor-b", "cursor-a", "cursor-b"];
    let request = 0;
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
      sessionSyncCursor,
      transport: {
        action: (name, args) => underlying.action(name, args),
        mutation: (name, args) => underlying.mutation(name, args),
        async query(name, args) {
          if (name === "sessions:listHeadsPage") {
            const continueCursor = continuations[request];
            request += 1;
            if (continueCursor === undefined) throw new Error("Unexpected cursor request.");
            return { continueCursor, isDone: false, page: [] };
          }
          return await underlying.query(name, args);
        },
      },
    });

    for (let page = 0; page < 3; page += 1) {
      expect(await daemon.pullRemoteSessions(new AbortController().signal)).toEqual([]);
    }
    await expect(daemon.pullRemoteSessions(new AbortController().signal)).rejects.toThrow(
      "deterministic cursor cycle",
    );
    expect((await sessionSyncCursor.read()).state).toMatchObject({
      remoteContinueCursor: "cursor-a",
      remoteCycle: { pageCount: 3 },
      version: 2,
    });
  });

  test("begins one compact epoch and reads its exact terminal receipt after cloud identity becomes unavailable", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const mutableIdentity = new MutableIdentity(activeIdentity());
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      identity: mutableIdentity,
      local,
    });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(900),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    const first = await daemon.recoverCompactProjection(input);
    expect(first).toMatchObject({
      boundaryHeadSequence: 3,
      compactHasRecoveryGap: true,
      compactStreamEpoch: 1,
      idempotencyKey: input.idempotencyKey,
      phase: "applied",
      sessionPublicId,
    });
    expect(local.activated).toBe(true);
    expect(cloud.epochBegins).toBe(1);
    expect(cloud.epochMutationCalls).toBe(1);
    expect(local.planCalls).toBe(1);
    expect(await daemon.recoverCompactProjection(input)).toEqual(first);
    expect(cloud.epochMutationCalls).toBe(1);
    expect(local.planCalls).toBe(1);
    expect(local.activateCalls).toBe(1);
    cloud.now = fixedNow + (8 * 24 * 60 * 60 * 1_000);
    mutableIdentity.current = pendingIdentity();
    expect(await daemon.readCompactProjectionRecoveryReceipt(input)).toEqual({
      result: first,
      status: "found",
    });
    expect(await daemon.readCompactProjectionRecoveryReceipt({
      ...input,
      sessionPublicId: "session_recover_0002",
    })).toEqual({ status: "conflict" });
    expect(await daemon.readCompactProjectionRecoveryReceipt({
      ...input,
      idempotencyKey: uuidV7(901),
    })).toEqual({ status: "absent" });
    expect(await daemon.projectionRecoveryStatus()).toEqual({
      recoveries: [{
        cacheActivated: true,
        idempotencyKey: input.idempotencyKey,
        phase: "applied",
        sessionPublicId,
      }],
      recoveriesTruncated: false,
      totalRecoveries: 1,
    });
  });

  test("bounds projection recovery status while retaining the newest terminal receipts", () => {
    const receipts = Array.from({ length: 150 }, (_, index) => ({
      idempotencyKey: uuidV7(10_000 + index),
      phase: "rejected" as const,
      rejectionCode: "TEST_REJECTION",
      requestedAt: fixedNow + index,
      sessionPublicId: `session_recovery_status_${String(index).padStart(4, "0")}`,
      sourceDevicePublicId: null,
      userPublicId: null,
    }));
    const status = projectionRecoveryStatusFromJournalState({
      commands: [],
      deviceCommands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [],
      projectionRecoveryReceipts: receipts,
      usageAccounts: [],
      version: 5,
    });

    expect(status.recoveries).toHaveLength(128);
    expect(status).toMatchObject({
      recoveriesTruncated: true,
      totalRecoveries: 150,
    });
    expect(status.recoveries[0]).toMatchObject({
      idempotencyKey: receipts[22]?.idempotencyKey,
      sessionPublicId: receipts[22]?.sessionPublicId,
    });
    expect(status.recoveries.at(-1)).toMatchObject({
      idempotencyKey: receipts[149]?.idempotencyKey,
      sessionPublicId: receipts[149]?.sessionPublicId,
    });
  });

  test("rejects an old absent recovery key with typed fresh-attempt guidance", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_old_absent_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const daemon = bridge({ cloud, device: "device_11111111", local });

    await expect(daemon.recoverCompactProjection({
      acknowledgeGap: true,
      idempotencyKey: uuidV7(903, fixedNow - (8 * 24 * 60 * 60 * 1_000)),
      sessionPublicId,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "idempotency_authority_invalid",
      name: "CloudProjectionRecoveryAdmissionError",
    });
    expect(local.planCalls).toBe(0);
    expect(cloud.epochMutationCalls).toBe(0);
  });

  test("appends post-recovery events at the global sequence under the new epoch", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_0005";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryUploadingLocal(sessionPublicId);
    const daemon = bridge({ cloud, device: "device_11111111", local });
    await daemon.recoverCompactProjection({
      acknowledgeGap: true,
      idempotencyKey: uuidV7(904),
      sessionPublicId,
      signal: new AbortController().signal,
    });

    const cycle = await daemon.cycle(new AbortController().signal);
    expect(cycle.sessionsUploaded).toBe(1);
    const head = cloud.requireHead(sessionPublicId);
    expect(head).toMatchObject({
      compactHasRecoveryGap: true,
      compactHeadSequence: 4,
      compactStreamEpoch: 1,
    });
    expect(cloud.chunks.get(sessionPublicId)?.at(-1)).toMatchObject({
      firstSequence: 4,
      lastSequence: 4,
      previousDigest: "f".repeat(64),
      streamEpoch: 1,
    });
    expect(cycle.remoteSessions[0]).toMatchObject({
      complete: false,
      recoveryGap: { kind: "projection_cache_recovery", streamEpoch: 1 },
    });
  });

  test("rebinds a prepared recovery to a renewed lease before starting its effect", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_0002";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new CommitThenThrowPreparedRecoveryJournal();
    let observedNow = fixedNow;
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local,
      now: () => observedNow,
    });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(901),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost prepared journal acknowledgement",
    );
    expect(cloud.epochBegins).toBe(0);
    const original = (await journal.read()).state.projectionRecoveries[0];
    expect(original?.phase).toBe("prepared");
    observedNow = fixedNow + 10_000;
    cloud.now = observedNow;
    await expect(daemon.recoverCompactProjection({
      ...input,
      idempotencyKey: uuidV7(902, observedNow),
    })).rejects.toMatchObject({
      code: "unsettled_session",
      name: "CloudProjectionRecoveryAdmissionError",
    });
    expect(await daemon.recoverCompactProjection(input)).toMatchObject({ phase: "applied" });
    const receipt = (await journal.read()).state.projectionRecoveryReceipts[0];
    expect(receipt).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      phase: "applied",
    });
    expect(cloud.requireLease(sessionPublicId).fence).toBe(2);
    expect(cloud.epochReceipts.get(input.idempotencyKey)?.requestDigest)
      .not.toBe(original?.requestDigest);
    expect(local.planCalls).toBe(1);
    expect(cloud.epochBegins).toBe(1);
  });

  test("settles an expired prepared no-effect recovery before admitting a fresh key", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_expired_prepared_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new CommitThenThrowPreparedAndTerminalRecoveryJournal();
    let observedNow = fixedNow;
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local,
      now: () => observedNow,
    });
    const oldInput = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(903),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(oldInput)).rejects.toThrow(
      "lost prepared journal acknowledgement",
    );
    observedNow = fixedNow + (8 * 24 * 60 * 60 * 1_000);
    cloud.now = observedNow;
    const freshKey = uuidV7(904, observedNow);
    await expect(daemon.recoverCompactProjection({
      ...oldInput,
      idempotencyKey: freshKey,
    })).rejects.toMatchObject({
      code: "unsettled_session",
      name: "CloudProjectionRecoveryAdmissionError",
    });

    local.failDiscardOnce = true;
    await expect(daemon.recoverCompactProjection(oldInput)).rejects.toThrow(
      "lost recovery discard acknowledgement",
    );
    expect((await journal.read()).state.projectionRecoveries[0]?.phase).toBe("prepared");
    await expect(daemon.recoverCompactProjection(oldInput)).rejects.toThrow(
      "lost terminal recovery acknowledgement",
    );
    expect(local.discardedRecoveryKeys).toContain(oldInput.idempotencyKey);
    expect(await daemon.recoverCompactProjection(oldInput)).toEqual({
      idempotencyKey: oldInput.idempotencyKey,
      phase: "rejected",
      rejectionCode: "IDEMPOTENCY_AUTHORITY_INVALID_BEFORE_EFFECT",
      sessionPublicId,
    });
    expect(cloud.epochMutationCalls).toBe(0);
    expect((await journal.read()).state).toMatchObject({
      projectionRecoveries: [],
      projectionRecoveryReceipts: [{
        idempotencyKey: oldInput.idempotencyKey,
        phase: "rejected",
        rejectionCode: "IDEMPOTENCY_AUTHORITY_INVALID_BEFORE_EFFECT",
        sessionPublicId,
      }],
    });

    expect(await daemon.recoverCompactProjection({
      ...oldInput,
      idempotencyKey: freshKey,
    })).toMatchObject({ phase: "applied" });
    expect(local.planCalls).toBe(2);
    expect(cloud.epochBegins).toBe(1);
  });

  test("settles expired effect-started no-lineage authority after server validation", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_expired_started_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new CommitThenThrowEffectStartedRecoveryJournal();
    let observedNow = fixedNow;
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local,
      now: () => observedNow,
    });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(905),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost effect-started journal acknowledgement",
    );
    expect(cloud.epochMutationCalls).toBe(0);
    observedNow = fixedNow + (8 * 24 * 60 * 60 * 1_000);
    cloud.now = observedNow;

    expect(await daemon.recoverCompactProjection(input)).toEqual({
      idempotencyKey: input.idempotencyKey,
      phase: "rejected",
      rejectionCode: "IDEMPOTENCY_AUTHORITY_INVALID_BEFORE_EFFECT",
      sessionPublicId,
    });
    expect(cloud.epochMutationCalls).toBe(1);
    expect(local.discardedRecoveryKeys).toContain(input.idempotencyKey);
    expect((await journal.read()).state.projectionRecoveries).toEqual([]);
  });

  test("provider deletion fences recovery between staging and journal admission", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_delete_race_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new MemoryCloudDaemonJournal();
    const daemon = bridge({ cloud, device: "device_11111111", journal, local });
    let entered!: () => void;
    const staged = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    local.afterStage = async () => {
      entered();
      await gate;
    };
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(912),
      sessionPublicId,
      signal: new AbortController().signal,
    };
    const recovery = daemon.recoverCompactProjection(input);
    await staged;
    local.terminal = true;

    expect(await daemon.supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId))
      .toEqual({ superseded: false });
    release();
    await expect(recovery).resolves.toEqual({
      idempotencyKey: input.idempotencyKey,
      phase: "rejected",
      rejectionCode: "PROVIDER_THREAD_DELETED",
      sessionPublicId,
    });
    expect(cloud.epochMutationCalls).toBe(0);
    expect(local.activateCalls).toBe(0);
    expect(local.discardedRecoveryKeys).toContain(input.idempotencyKey);
    expect((await journal.read()).state).toMatchObject({
      projectionRecoveries: [],
      projectionRecoveryReceipts: [{
        idempotencyKey: input.idempotencyKey,
        phase: "rejected",
        rejectionCode: "PROVIDER_THREAD_DELETED",
        sessionPublicId,
      }],
    });
  });

  test("reopened terminal authority supersedes an effect-started recovery without replay", async () => {
    const cloud = new FakeCloud();
    cloud.failEpochAfterEffectOnce = true;
    const sessionPublicId = "session_recover_delete_restart_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new MemoryCloudDaemonJournal();
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(913),
      sessionPublicId,
      signal: new AbortController().signal,
    };
    const original = bridge({ cloud, device: "device_11111111", journal, local });
    await expect(original.recoverCompactProjection(input)).rejects.toThrow(
      "lost compact epoch response",
    );
    expect((await journal.read()).state.projectionRecoveries[0]?.phase)
      .toBe("effect_started");
    const mutationCalls = cloud.epochMutationCalls;
    local.terminal = true;
    const restarted = bridge({ cloud, device: "device_11111111", journal, local });

    expect(await restarted.supersedeTerminalCompactProjectionRecoveries())
      .toEqual({ superseded: 1 });
    expect(await restarted.recoverCompactProjection(input)).toEqual({
      idempotencyKey: input.idempotencyKey,
      phase: "rejected",
      rejectionCode: "PROVIDER_THREAD_DELETED",
      sessionPublicId,
    });
    expect(cloud.epochMutationCalls).toBe(mutationCalls);
    expect(local.activateCalls).toBe(0);
    expect((await journal.read()).state.projectionRecoveries).toEqual([]);
  });

  test("crash-replays a terminal local revision for an interaction observed only in old cloud", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_interaction_0001";
    const interactionId = "70000000-0000-4000-8000-000000000201";
    await installRecoverableHead(cloud, sessionPublicId, [
      ...events,
      {
        blocking: true,
        interactionId,
        interactionKind: "user_input",
        kind: "interaction_state",
        revision: 1,
        sequence: 4,
        state: "pending",
        summary: "Codex needs user input",
      },
    ]);
    const local = new RecoveryLocal(sessionPublicId);
    local.expectedBoundaryHeadSequence = 4;
    local.baselineInteractions = [{
      blocking: true,
      interactionId,
      interactionKind: "user_input",
      revision: 2,
      state: "resolved",
      summary: "Interaction state updated",
    }];
    const journal = new CommitThenThrowPreparedRecoveryJournal();
    const daemon = bridge({ cloud, device: "device_11111111", journal, local });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(911),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost prepared journal acknowledgement",
    );
    expect(local.observedInteractionIds).toEqual([interactionId]);
    const prepared = (await journal.read()).state.projectionRecoveries[0];
    expect(prepared).toMatchObject({
      baselineInteractions: local.baselineInteractions,
      phase: "prepared",
    });
    const privatePath = ["", "Users", "alice", "private"].join("/");
    for (const privateValue of [
      privatePath,
      "provider/request/private",
      "secret answer",
      "https://private.example/mcp",
      "f".repeat(64),
    ]) expect(JSON.stringify(prepared?.baselineInteractions)).not.toContain(privateValue);

    expect(await daemon.recoverCompactProjection(input)).toMatchObject({
      boundaryHeadSequence: 4,
      phase: "applied",
    });
    expect(local.planCalls).toBe(1);
    expect(local.stageCalls).toBe(2);
    expect(cloud.epochBegins).toBe(1);
  });

  test("reconciles a lost epoch response with the exact request and one server epoch", async () => {
    const cloud = new FakeCloud();
    cloud.failEpochAfterEffectOnce = true;
    const sessionPublicId = "session_recover_0003";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new MemoryCloudDaemonJournal();
    const daemon = bridge({ cloud, device: "device_11111111", journal, local });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(902),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost compact epoch response",
    );
    const blocker = new CloudDaemonJournalRecoveryBlocker(journal);
    expect((await journal.read()).state.projectionRecoveries[0]?.phase)
      .toBe("effect_started");
    expect(await blocker.isCompactProjectionRecoveryUnsettled(sessionPublicId)).toBe(true);
    expect(await blocker.isCompactProjectionRecoveryUnsettled("session_unrelated_0003")).toBe(false);
    cloud.now += 8 * 24 * 60 * 60 * 1_000;
    expect(await daemon.recoverCompactProjection(input)).toMatchObject({
      compactStreamEpoch: 1,
      phase: "applied",
    });
    expect(await blocker.isCompactProjectionRecoveryUnsettled(sessionPublicId)).toBe(false);
    expect(cloud.epochBegins).toBe(1);
    expect(cloud.epochMutationCalls).toBe(2);
    expect(local.planCalls).toBe(1);
  });

  test("revalidates local staging authority before replaying effect_started", async () => {
    const cloud = new FakeCloud();
    cloud.failEpochAfterEffectOnce = true;
    const sessionPublicId = "session_recover_authority_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const journal = new MemoryCloudDaemonJournal();
    const daemon = bridge({ cloud, device: "device_11111111", journal, local });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(907),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost compact epoch response",
    );
    expect((await journal.read()).state.projectionRecoveries[0]?.phase)
      .toBe("effect_started");
    expect(cloud.epochMutationCalls).toBe(1);
    local.stageAuthorityCurrent = false;

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "recovery local authority changed",
    );
    expect(cloud.epochMutationCalls).toBe(1);
    expect((await journal.read()).state.projectionRecoveries[0]?.phase)
      .toBe("effect_started");
  });

  test("rejects recovery custody under a different HRA user or source device", async () => {
    for (const mismatch of ["user", "device"] as const) {
      const cloud = new FakeCloud();
      cloud.failEpochAfterEffectOnce = true;
      const sessionPublicId = `session_recover_identity_${mismatch}_0001`;
      await installRecoverableHead(cloud, sessionPublicId);
      const local = new RecoveryLocal(sessionPublicId);
      const journal = new MemoryCloudDaemonJournal();
      const original = bridge({ cloud, device: "device_11111111", journal, local });
      const input = {
        acknowledgeGap: true as const,
        idempotencyKey: uuidV7(mismatch === "user" ? 908 : 909),
        sessionPublicId,
        signal: new AbortController().signal,
      };
      await expect(original.recoverCompactProjection(input)).rejects.toThrow(
        "lost compact epoch response",
      );
      const mutationCalls = cloud.epochMutationCalls;
      const wrongIdentity: CloudDaemonIdentityPort = {
        requireActive: () => Promise.resolve({
          accountKey: key,
          devicePublicId: mismatch === "device" ? "device_22222222" : "device_11111111",
          keyVersion: 1,
          userPublicId: mismatch === "user" ? "user_22222222" : userPublicId,
        }),
      };
      const restarted = bridge({
        cloud,
        device: mismatch === "device" ? "device_22222222" : "device_11111111",
        identity: wrongIdentity,
        journal,
        local,
      });

      await expect(restarted.recoverCompactProjection(input)).rejects.toMatchObject({
        code: "identity_or_session_conflict",
        name: "CloudProjectionRecoveryAdmissionError",
      });
      expect(cloud.epochMutationCalls).toBe(mutationCalls);
      expect((await journal.read()).state.projectionRecoveries[0]?.phase)
        .toBe("effect_started");
    }
  });

  test("keeps remote provider commands pending while exact projection recovery is unsettled", async () => {
    const cloud = new FakeCloud();
    cloud.failEpochAfterEffectOnce = true;
    const sessionPublicId = "session_recover_0006";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    const executor = new RecordingExecutor();
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      executor,
      local,
      optionalSyncBudgetMs: 5,
    });
    const recovery = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(905),
      sessionPublicId,
      signal: new AbortController().signal,
    };
    await expect(daemon.recoverCompactProjection(recovery)).rejects.toThrow(
      "lost compact epoch response",
    );
    const commandPublicId = uuidV7(906);
    await cloud.enqueue(
      "device_requester",
      sessionPublicId,
      commandPublicId,
      { kind: "stop" },
    );

    const blocked = await daemon.cycle(new AbortController().signal);
    expect(blocked.online).toBe(true);
    expect(blocked.commandsApplied).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("pending");

    await daemon.recoverCompactProjection(recovery);
    const resumed = await daemon.cycle(new AbortController().signal);
    expect(resumed.commandsApplied).toBe(1);
    expect(executor.calls).toHaveLength(1);
  });

  test("replays cache activation after its acknowledgement is lost without reopening the epoch", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_recover_0004";
    await installRecoverableHead(cloud, sessionPublicId);
    const local = new RecoveryLocal(sessionPublicId);
    local.failActivationAfterEffectOnce = true;
    const journal = new CommitThenThrowTerminalRecoveryJournal();
    const daemon = bridge({ cloud, device: "device_11111111", journal, local });
    const input = {
      acknowledgeGap: true as const,
      idempotencyKey: uuidV7(903),
      sessionPublicId,
      signal: new AbortController().signal,
    };

    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost cache activation acknowledgement",
    );
    const pendingActivation = (await journal.read()).state.projectionRecoveries[0];
    expect(pendingActivation).toMatchObject({ cacheActivated: false, phase: "applied" });
    cloud.now += 8 * 24 * 60 * 60 * 1_000;
    await expect(daemon.recoverCompactProjection(input)).rejects.toThrow(
      "lost terminal recovery acknowledgement",
    );
    expect((await journal.read()).state).toMatchObject({
      projectionRecoveries: [],
      projectionRecoveryReceipts: [{ phase: "applied" }],
    });
    expect(await daemon.recoverCompactProjection(input)).toMatchObject({ phase: "applied" });
    expect(cloud.epochBegins).toBe(1);
    expect(cloud.epochMutationCalls).toBe(1);
    expect(local.planCalls).toBe(1);
    expect(local.activateCalls).toBe(2);
  });

  test("syncs encrypted compact state and usage for a second device, then executes its command", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const sessionPublicId = "session_12345678";
    const first = bridge({
      cloud,
      device: "device_11111111",
      executor,
      local: new FakeLocal(sessionPublicId, events),
    });
    const second = bridge({
      cloud,
      device: "device_22222222",
      local: new EmptyLocal(sessionPublicId),
    });
    const initial = await first.cycle(new AbortController().signal);
    expect(initial.online).toBe(true);
    expect(initial.sessionsUploaded).toBe(1);
    expect(initial.usageUploaded).toBe(1);
    const uploadedUsage = cloud.snapshots.values().next().value as
      | { digest: string; sourceRevision: number }
      | undefined;
    expect(uploadedUsage?.digest).toBe(await hmacSha256Hex(
      key,
      "usage-projection",
      JSON.stringify({ state: "unavailable" }),
    ));
    expect(uploadedUsage?.digest).not.toBe(
      await sha256Hex(JSON.stringify({ state: "unavailable" })),
    );
    expect(initial.remoteSessions[0]).toMatchObject({
      complete: true,
      events,
      metadata: { name: "Release", note: "Ship after the checks pass." },
      publicId: sessionPublicId,
    });
    const pulled = await second.pullRemoteSessions(new AbortController().signal);
    expect(pulled[0]).toMatchObject({ events, publicId: sessionPublicId });

    const commandPublicId = uuidV7(1);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "set_fast", enabled: true },
    );
    const controlled = await first.cycle(new AbortController().signal);
    expect(controlled.commandsApplied).toBe(1);
    expect(executor.calls).toEqual([{
      idempotencyKey: commandPublicId,
      sessionPublicId,
    }]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("applied");
  });

  test("defers terminal state until a late interaction revision clears the compact backlog", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_terminal_backlog";
    const interactionId = "70000000-0000-4000-8000-000000000001";
    const backlog: CompactSessionEvent[] = [
      {
        blocking: true,
        interactionId,
        interactionKind: "user_input",
        kind: "interaction_state",
        revision: 1,
        sequence: 1,
        state: "pending",
        summary: "Codex needs user input",
      },
      ...Array.from({ length: 127 }, (_, index): CompactSessionEvent => ({
        kind: "assistant_message",
        sequence: index + 2,
        text: `Backlog event ${String(index + 1)}`,
        turnId: `turn_backlog_${String(index + 1).padStart(4, "0")}`,
      })),
      {
        blocking: true,
        interactionId,
        interactionKind: "user_input",
        kind: "interaction_state",
        revision: 2,
        sequence: 129,
        state: "resolved",
        summary: "Codex needs user input",
      },
    ];
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, backlog, "terminal"),
    });

    const first = await daemon.cycle(new AbortController().signal);
    expect(first.errors).toEqual([]);
    expect(first.sessionsUploaded).toBe(1);
    expect(cloud.requireHead(sessionPublicId)).toMatchObject({
      compactHeadSequence: 128,
      state: "active",
    });

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(second.sessionsUploaded).toBe(1);
    expect(cloud.requireHead(sessionPublicId)).toMatchObject({
      compactHeadSequence: 129,
      state: "terminal",
    });
    expect(second.remoteSessions[0]?.events.at(-1)).toMatchObject({
      interactionId,
      kind: "interaction_state",
      revision: 2,
      sequence: 129,
      state: "resolved",
    });

    const lateInteractionId = "70000000-0000-4000-8000-000000000002";
    backlog.push(
      {
        blocking: true,
        interactionId: lateInteractionId,
        interactionKind: "permission_approval",
        kind: "interaction_state",
        revision: 1,
        sequence: 130,
        state: "pending",
        summary: "Codex requests additional permissions",
      },
      {
        blocking: true,
        interactionId: lateInteractionId,
        interactionKind: "permission_approval",
        kind: "interaction_state",
        revision: 2,
        sequence: 131,
        state: "expired",
        summary: "Codex requests additional permissions",
      },
    );
    const third = await daemon.cycle(new AbortController().signal);
    expect(third.errors).toEqual([]);
    expect(third.sessionsUploaded).toBe(1);
    expect(cloud.requireHead(sessionPublicId)).toMatchObject({
      compactHeadSequence: 131,
      state: "terminal",
    });
    expect(third.remoteSessions[0]?.events.at(-1)).toMatchObject({
      interactionId: lateInteractionId,
      revision: 2,
      sequence: 131,
      state: "expired",
    });
  });

  test("resolves a local session by exact ID beyond the newest 25 cloud heads", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_older_exact";
    for (let index = 0; index < 25; index += 1) {
      const publicId = `session_newer_${String(index).padStart(4, "0")}`;
      cloud.heads.set(publicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow + index + 1,
        detailHeadSequence: 0,
        executionDevicePublicId: "device_11111111",
        metadataRevision: 0,
        projectionRevision: 0,
        publicId,
        state: "idle",
        updatedAt: fixedNow + index + 1,
      });
    }
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, events),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result.errors).toEqual([]);
    expect(cloud.sessionCreateCalls).not.toContain(sessionPublicId);
    expect(cloud.requireHead(sessionPublicId).compactHeadSequence).toBe(3);
  });

  test("never adopts a live lease from another daemon boot on the same device", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_old_daemon";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    cloud.leases.set(sessionPublicId, {
      bootGeneration: 1,
      bootId: "boot_other123",
      devicePublicId: "device_11111111",
      fence: 1,
      heartbeatFingerprint: "initial",
      heartbeatSequence: 0,
      leaseUntil: fixedNow + 5_000,
    });
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, events),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result.errors.join(" ")).toContain("another daemon generation");
    expect(cloud.requireHead(sessionPublicId).compactHeadSequence).toBe(0);
  });

  test("a replaced daemon cannot renew a lease or start a remote provider effect", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const sessionPublicId = "session_stale_daemon";
    let current = true;
    const adapter = bridge({
      cloud,
      daemonAuthorityFence: {
        assertCurrent: () => current
          ? Promise.resolve()
          : Promise.reject(new Error("daemon authority replaced")),
      },
      device: "device_11111111",
      executor,
      local: new FakeLocal(sessionPublicId, events),
    });
    expect((await adapter.cycle(new AbortController().signal)).online).toBe(true);
    const leaseBefore = structuredClone(cloud.requireLease(sessionPublicId));
    const commandPublicId = uuidV7(2_001);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "stop" },
    );
    current = false;

    const stale = await adapter.cycle(new AbortController().signal);

    expect(stale.online).toBe(false);
    expect(stale.errors.join(" ")).toContain("daemon authority replaced");
    expect(cloud.requireLease(sessionPublicId)).toEqual(leaseBefore);
    expect(cloud.requireCommand(commandPublicId).state).toBe("pending");
    expect(executor.calls).toEqual([]);
  });

  test("reacquires an expired lease from the same daemon under a new fence", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_same_boot";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    cloud.leases.set(sessionPublicId, {
      bootGeneration: 1,
      bootId: "boot_12345678",
      devicePublicId: "device_11111111",
      fence: 7,
      heartbeatFingerprint: "a".repeat(64),
      heartbeatSequence: 9,
      leaseUntil: fixedNow,
    });
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, events),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result.online).toBe(true);
    expect(cloud.requireLease(sessionPublicId)).toMatchObject({
      bootGeneration: 1,
      bootId: "boot_12345678",
      fence: 8,
      heartbeatFingerprint: "initial",
      heartbeatSequence: 0,
    });
  });

  test("rerolls an aged absent usage-account intent and keeps command polling online", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_usage_age";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local: new FakeLocal(sessionPublicId, events),
    });
    cloud.failUsageAccountBeforeEffectOnce = true;

    const failed = await adapter.cycle(new AbortController().signal);
    expect(failed.online).toBe(true);
    expect(failed.errors.join(" ")).toContain("usage account unavailable before effect");
    const pending = (await journal.read()).state.pendingUsageAccount;
    expect(pending).not.toBeNull();
    const oldKey = pending?.idempotencyKey;
    cloud.now += 7 * 24 * 60 * 60 * 1_000 + 1;

    const reconciled = await adapter.cycle(new AbortController().signal);

    expect(reconciled.online).toBe(true);
    expect((await journal.read()).state.pendingUsageAccount).toBeNull();
    expect(cloud.usageAccountAttempts).toHaveLength(2);
    expect(cloud.usageAccountAttempts[1]?.idempotencyKey).not.toBe(oldKey);
  });

  test("clears an aged usage-account intent only after exact committed evidence", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_usage_exact";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local: new FakeLocal(sessionPublicId, events),
    });
    cloud.failUsageAccountAfterEffectOnce = true;
    const failed = await adapter.cycle(new AbortController().signal);
    expect(failed.errors.join(" ")).toContain("lost usage account response");
    expect((await journal.read()).state.pendingUsageAccount).not.toBeNull();
    cloud.now += 7 * 24 * 60 * 60 * 1_000 + 1;

    const reconciled = await adapter.cycle(new AbortController().signal);

    expect(reconciled.online).toBe(true);
    expect((await journal.read()).state.pendingUsageAccount).toBeNull();
    expect(cloud.usageAccountAttempts).toHaveLength(1);
  });

  test("reconstructs an exact usage binding cursor after the daemon journal pointer is lost", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_usage_journal";
    const local = new FakeLocal(sessionPublicId, events);
    const first = bridge({
      cloud,
      device: "device_11111111",
      journal: new MemoryCloudDaemonJournal(),
      local,
    });
    expect((await first.cycle(new AbortController().signal)).errors).toEqual([]);
    expect(cloud.usageAccountAttempts).toHaveLength(1);
    await first.close();
    const replacementJournal = new MemoryCloudDaemonJournal();
    const restarted = bridge({
      cloud,
      device: "device_11111111",
      journal: replacementJournal,
      local,
    });

    expect((await restarted.cycle(new AbortController().signal)).errors).toEqual([]);

    expect(cloud.usageAccountAttempts).toHaveLength(1);
    expect((await replacementJournal.read()).state.usageAccounts).toEqual([
      expect.objectContaining({ sourceGeneration: 1, sourceRevision: 1 }),
    ]);
    expect(cloud.snapshotAttempts.map((attempt) => attempt.sourceRevision)).toEqual([1]);
  });

  test("retries a lost coalesced receipt without storing or rotating its revision", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const local = new UsageBacklogLocal([{
      localReference: "account_local_coalesced",
      matchReference: "coalesced@example.com",
      revisions: 2,
    }]);
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local,
    });
    cloud.failUsageSnapshotAfterEffectRevision = 2;

    const lost = await daemon.cycle(new AbortController().signal);

    expect(lost.usageUploaded).toBe(1);
    expect(lost.errors.join(" ")).toContain("lost usage snapshot response");
    expect((await journal.read()).state.usageAccounts).toEqual([
      expect.objectContaining({ sourceRevision: 1 }),
    ]);
    expect([...cloud.usageAdmissions.values()].map((entry) => ({
      disposition: entry.disposition,
      sourceRevision: entry.sourceRevision,
    }))).toEqual([{ disposition: "coalesced", sourceRevision: 2 }]);

    const replayed = await daemon.cycle(new AbortController().signal);

    expect(replayed.errors).toEqual([]);
    expect(replayed.usageUploaded).toBe(1);
    expect(cloud.snapshotAttempts.map((attempt) => attempt.sourceRevision)).toEqual([1, 2, 2]);
    expect(cloud.snapshotCommits.size).toBe(1);
    expect((await journal.read()).state.usageAccounts).toEqual([
      expect.objectContaining({ sourceRevision: 2 }),
    ]);
    await daemon.close();
  });

  test("drains and coalesces more than 200 offline usage samples across restart and a lost response", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const local = new UsageBacklogLocal([{
      localReference: "account_local_backlog",
      matchReference: "backlog@example.com",
      revisions: 205,
    }]);
    const first = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local,
    });
    cloud.failUsageSnapshotAfterEffectOnce = true;

    const lost = await first.cycle(new AbortController().signal);

    expect(lost.usageUploaded).toBe(0);
    expect(lost.errors.join(" ")).toContain("lost usage snapshot response");
    expect(cloud.snapshotAttempts.map((attempt) => attempt.sourceRevision)).toEqual([1]);
    expect((await journal.read()).state.usageAccounts).toEqual([
      expect.objectContaining({ sourceGeneration: 1, sourceRevision: 0 }),
    ]);
    await first.close();

    const restarted = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local,
    });
    const cycleUploads: number[] = [];
    for (let cycle = 0; cycle < 7; cycle += 1) {
      const result = await restarted.cycle(new AbortController().signal);
      expect(result.errors).toEqual([]);
      cycleUploads.push(result.usageUploaded);
      expect(result.usageUploaded).toBeLessThanOrEqual(32);
    }

    expect(cycleUploads).toEqual([32, 32, 32, 32, 32, 32, 13]);
    expect(cloud.snapshotAttempts.map((attempt) => attempt.sourceRevision)).toEqual([
      1,
      ...Array.from({ length: 205 }, (_, index) => index + 1),
    ]);
    expect(cloud.snapshotCommits.size).toBe(1);
    expect([...cloud.usageAdmissions.values()].map((entry) => ({
      disposition: entry.disposition,
      sourceRevision: entry.sourceRevision,
    }))).toEqual([{ disposition: "coalesced", sourceRevision: 205 }]);
    expect((await journal.read()).state.usageAccounts).toEqual([
      expect.objectContaining({ sourceGeneration: 1, sourceRevision: 205 }),
    ]);
    expect(JSON.stringify({
      attempts: cloud.snapshotAttempts,
      errors: lost.errors,
      journal: await journal.read(),
    })).not.toContain("account_local_backlog");
    await restarted.close();
  });

  test("shares each bounded usage cycle fairly across account backlogs", async () => {
    const cloud = new FakeCloud();
    const local = new UsageBacklogLocal([
      {
        localReference: "account_local_first",
        matchReference: "first@example.com",
        revisions: 40,
      },
      {
        localReference: "account_local_second",
        matchReference: "second@example.com",
        revisions: 40,
      },
    ]);
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      local,
    });

    const first = await daemon.cycle(new AbortController().signal);
    const accountIds = [...cloud.accounts.keys()];

    expect(first.errors).toEqual([]);
    expect(first.usageUploaded).toBe(32);
    expect(accountIds).toHaveLength(2);
    expect(cloud.snapshotAttempts).toEqual(
      Array.from({ length: 16 }, (_, index) => accountIds.map((accountPublicId) => ({
        accountPublicId,
        sourceRevision: index + 1,
      }))).flat(),
    );

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(second.usageUploaded).toBe(32);
    expect(cloud.snapshotAttempts.slice(32)).toEqual(
      Array.from({ length: 16 }, (_, index) => accountIds.map((accountPublicId) => ({
        accountPublicId,
        sourceRevision: index + 17,
      }))).flat(),
    );
    await daemon.close();
  });

  test("retries a lost terminal receipt without replaying the local effect", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_87654321";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new FakeLocal(sessionPublicId, events),
    });
    await adapter.cycle(new AbortController().signal);
    const commandPublicId = uuidV7(2);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "stop" },
    );
    cloud.failSettleAfterEffectOnce = true;
    const lost = await adapter.cycle(new AbortController().signal);
    expect(lost.errors.join(" ")).toContain("lost settle response");
    expect(executor.calls).toHaveLength(1);
    expect((await journal.read()).state.commands[0]).toMatchObject({ phase: "terminal" });
    cloud.now += 5_001;
    const reconciled = await adapter.cycle(new AbortController().signal);
    expect(reconciled.commandsUnsettled).toBe(0);
    expect(executor.calls).toHaveLength(1);
  });

  test("rejects a saturated command journal before prepare or local provider effect", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_capacity_0001";
    await installRecoverableHead(cloud, sessionPublicId);
    const commandPublicId = uuidV7(4_200);
    await cloud.enqueue(
      "device_requester_12345678",
      sessionPublicId,
      commandPublicId,
      { kind: "stop" },
    );
    const candidate: CloudCommandJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_12345678", fence: 1 },
      commandPublicId,
      kind: "stop",
      localAuthorityDigest: "a".repeat(64),
      payloadDigest: "b".repeat(64),
      phase: "prepared",
      sessionPublicId,
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, saturatedCommandJournal(candidate)))
      .not.toBeNull();
    const executor = new RecordingExecutor();
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new StalledProjectionLocal(sessionPublicId),
      optionalSyncBudgetMs: 1,
    });

    const result = await daemon.cycle(new AbortController().signal);

    expect(result.commandsApplied).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("pending");
    expect(result.errors.some((error) =>
      error.includes(commandPublicId) && error.includes("journal is corrupt"))).toBe(true);
  });

  test("drains a dense legacy prepared backlog in FIFO order without provider effects", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const authority = { bootGeneration: 1, bootId: "boot_12345678", fence: 1 };
    const commands: CloudCommandJournalEntry[] = [];
    for (let index = 0; index < 100; index += 1) {
      const sessionPublicId = `session_legacy_${index.toString().padStart(4, "0")}`;
      cloud.heads.set(sessionPublicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow,
        detailHeadSequence: 0,
        executionDevicePublicId: "device_11111111",
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: sessionPublicId,
        state: "idle",
        updatedAt: fixedNow,
      });
      const commandPublicId = uuidV7(8_000 + index);
      await cloud.enqueue(
        "device_requester_12345678",
        sessionPublicId,
        commandPublicId,
        { kind: "stop" },
      );
      const remote = cloud.requireCommand(commandPublicId);
      remote.boundAuthority = authority;
      remote.createdAt = fixedNow + index;
      remote.state = "prepared";
      remote.updatedAt = fixedNow + index;
      cloud.leases.set(sessionPublicId, {
        ...authority,
        devicePublicId: "device_11111111",
        heartbeatFingerprint: "initial",
        heartbeatSequence: 0,
        leaseUntil: fixedNow + 5_000,
      });
      commands.push({
        authority,
        commandPublicId,
        kind: "stop",
        localAuthorityDigest: "a".repeat(64),
        payloadDigest: await sha256Hex(JSON.stringify(remote.payload)),
        phase: "prepared",
        sessionPublicId,
      });
    }
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands,
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    })).not.toBeNull();
    const daemon = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new EmptyLocal(),
    });
    const expectedOutcome = {
      code: "LOCAL_JOURNAL_CAPACITY_BEFORE_EFFECT",
      state: "failed" as const,
    };
    const expectedResultDigest = await sha256Hex(JSON.stringify(expectedOutcome));
    const unsettledByCycle: number[] = [];

    for (let cycle = 0; cycle < 30; cycle += 1) {
      const result = await daemon.cycle(new AbortController().signal);
      expect(result.errors).toEqual([]);
      expect(result.commandsApplied).toBe(0);
      const remaining = (await journal.read()).state.commands;
      unsettledByCycle.push(remaining.length);
      if (cycle === 0) {
        expect(remaining).toEqual(commands.slice(4).map((entry) => ({
          ...entry,
          phase: "terminal",
          resultCode: expectedOutcome.code,
          resultDigest: expectedResultDigest,
          terminalState: "failed",
        })));
      }
      if (remaining.length === 0) break;
    }

    expect(unsettledByCycle).toEqual(
      Array.from({ length: 25 }, (_, index) => 96 - index * 4),
    );
    expect(executor.calls).toEqual([]);
    expect(cloud.commandEffectStartCalls).toEqual([]);
    expect(cloud.commandSettleCalls).toEqual(
      commands.map((entry) => entry.commandPublicId),
    );
    for (const entry of commands) {
      expect(cloud.requireCommand(entry.commandPublicId)).toMatchObject({
        boundAuthority: entry.authority,
        resultCode: expectedOutcome.code,
        resultDigest: expectedResultDigest,
        state: "failed",
      });
    }
  });

  test("keeps later same-session commands pending when the first prepare fails", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_fifo_fail";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new FakeLocal(sessionPublicId, events),
    });
    await adapter.cycle(new AbortController().signal);
    const firstId = uuidV7(31);
    const secondId = uuidV7(32);
    await cloud.enqueue("device_22222222", sessionPublicId, firstId, { kind: "stop" });
    await cloud.enqueue("device_22222222", sessionPublicId, secondId, { kind: "stop" });
    cloud.failPrepareOnce = true;

    const failed = await adapter.cycle(new AbortController().signal);

    expect(failed.errors.join(" ")).toContain("prepare unavailable");
    expect(executor.calls).toEqual([]);
    expect(cloud.requireCommand(firstId).state).toBe("pending");
    expect(cloud.requireCommand(secondId).state).toBe("pending");
    expect((await journal.read()).state.commands).toHaveLength(1);
  });

  test("preserves server insertion order for same-millisecond commands with reversed public IDs", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const sessionPublicId = "session_fifo_tie";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      local: new FakeLocal(sessionPublicId, events),
    });
    await adapter.cycle(new AbortController().signal);
    const firstInserted = uuidV7(99);
    const secondInserted = uuidV7(1);
    await cloud.enqueue("device_22222222", sessionPublicId, firstInserted, { kind: "stop" });
    await cloud.enqueue("device_22222222", sessionPublicId, secondInserted, { kind: "stop" });

    await adapter.cycle(new AbortController().signal);
    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([
      firstInserted,
      secondInserted,
    ]);
  });

  test("prioritizes an urgent session head beyond an earlier same-session backlog", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const device = "device_11111111";
    const backlogSession = "session_backlog1";
    const urgentSession = "session_urgent01";
    cloud.heads.set(backlogSession, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: device,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: backlogSession,
      state: "idle",
      updatedAt: fixedNow,
    });
    const adapter = bridge({
      cloud,
      device,
      executor,
      local: new FakeLocal(urgentSession, events),
    });
    await adapter.cycle(new AbortController().signal);
    const backlogIds: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const publicId = uuidV7(2_000 + index);
      backlogIds.push(publicId);
      await cloud.enqueue("device_22222222", backlogSession, publicId, { kind: "stop" });
      cloud.requireCommand(publicId).deadline = cloud.now + 24 * 60 * 60 * 1_000;
    }
    const urgentId = uuidV7(3_000);
    await cloud.enqueue("device_22222222", urgentSession, urgentId, { kind: "stop" });
    cloud.requireCommand(urgentId).deadline = cloud.now + 5 * 60 * 1_000;

    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([urgentId]);
    expect(cloud.requireCommand(urgentId).state).toBe("applied");
    expect(backlogIds.every((publicId) => cloud.requireCommand(publicId).state === "pending"))
      .toBe(true);
  });

  test("reserves fresh command progress ahead of many unrelated stalled journal recoveries", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const journal = new MemoryCloudDaemonJournal();
    const urgentSession = "session_fresh_stop";
    cloud.heads.set(urgentSession, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: urgentSession,
      state: "idle",
      updatedAt: fixedNow,
    });
    const recoveries = Array.from({ length: 20 }, (_, index) => {
      const commandPublicId = uuidV7(5_000 + index);
      cloud.failingCommandGets.add(commandPublicId);
      return {
        authority: { bootGeneration: 1, bootId: "boot_stale001", fence: 1 },
        commandPublicId,
        kind: "stop" as const,
        localAuthorityDigest: "a".repeat(64),
        payloadDigest: "b".repeat(64),
        phase: "terminal" as const,
        resultCode: "APPLIED",
        resultDigest: "c".repeat(64),
        sessionPublicId: `session_recovery_${String(index).padStart(2, "0")}`,
        terminalState: "applied" as const,
      };
    });
    await journal.compareAndSwap(null, {
      commands: recoveries,
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    });
    const commandPublicId = uuidV7(6_000);
    await cloud.enqueue("device_22222222", urgentSession, commandPublicId, { kind: "stop" });
    cloud.requireCommand(commandPublicId).deadline = cloud.now + 5 * 60 * 1_000;
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new EmptyLocal(urgentSession),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("applied");
    expect(result.errors.join(" ")).toContain("command recovery timeout");
    expect(cloud.commandGetCalls.filter((id) => cloud.failingCommandGets.has(id)))
      .toHaveLength(1);
    expect((await journal.read()).state.commands).toHaveLength(20);
  });

  test("executes the earliest stop before resolving later stalled session heads", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const urgentSession = "session_earliest_stop";
    cloud.heads.set(urgentSession, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: urgentSession,
      state: "idle",
      updatedAt: fixedNow,
    });
    const urgentId = uuidV7(6_100);
    await cloud.enqueue("device_22222222", urgentSession, urgentId, { kind: "stop" });
    cloud.requireCommand(urgentId).deadline = cloud.now + 5 * 60 * 1_000;
    for (let index = 0; index < 31; index += 1) {
      const sessionPublicId = `session_later_stall_${String(index).padStart(2, "0")}`;
      cloud.heads.set(sessionPublicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow,
        detailHeadSequence: 0,
        executionDevicePublicId: "device_11111111",
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: sessionPublicId,
        state: "idle",
        updatedAt: fixedNow,
      });
      const commandPublicId = uuidV7(6_200 + index);
      await cloud.enqueue("device_22222222", sessionPublicId, commandPublicId, { kind: "stop" });
      cloud.requireCommand(commandPublicId).deadline = cloud.now + 24 * 60 * 60 * 1_000;
      cloud.heads.delete(sessionPublicId);
      cloud.failingHeadGets.add(sessionPublicId);
    }
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      local: new EmptyLocal(urgentSession),
    });

    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([urgentId]);
    expect(cloud.requireCommand(urgentId).state).toBe("applied");
    expect(cloud.headGetCalls.filter((id) => cloud.failingHeadGets.has(id)))
      .toHaveLength(4);
  });

  test("executes pending commands before a stalled optional projection cycle", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const device = "device_11111111";
    const sessionPublicId = "session_stalled1";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: device,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    const commandPublicId = uuidV7(4_000);
    await cloud.enqueue("device_22222222", sessionPublicId, commandPublicId, { kind: "stop" });
    cloud.requireCommand(commandPublicId).deadline = cloud.now + 5 * 60 * 1_000;
    const adapter = bridge({
      cloud,
      device,
      executor,
      local: new StalledProjectionLocal(sessionPublicId),
      optionalSyncBudgetMs: 1,
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result.online).toBe(true);
    expect(result.errors.join(" ")).toContain("Optional cloud projection sync exceeded");
    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("applied");
  });

  test("polls a command that arrives immediately after a scan despite stalled projection work", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const device = "device_11111111";
    const sessionPublicId = "session_late_stop";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: device,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    const commandPublicId = uuidV7(4_100);
    cloud.afterPendingScan = async () => {
      await cloud.enqueue("device_22222222", sessionPublicId, commandPublicId, { kind: "stop" });
      cloud.requireCommand(commandPublicId).deadline = cloud.now + 5 * 60 * 1_000;
    };
    const adapter = bridge({
      cloud,
      device,
      executor,
      local: new StalledProjectionLocal(sessionPublicId),
      optionalSyncBudgetMs: 1,
    });

    await adapter.cycle(new AbortController().signal);
    expect(executor.calls).toEqual([]);
    await adapter.cycle(new AbortController().signal);
    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("applied");
  });

  test("hard-bounds optional work that ignores cancellation before the next command poll", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const device = "device_11111111";
    const sessionPublicId = "session_ignore_abort";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: device,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    const commandPublicId = uuidV7(4_200);
    cloud.afterPendingScan = async () => {
      await cloud.enqueue("device_22222222", sessionPublicId, commandPublicId, { kind: "stop" });
    };
    const local = new IgnoreAbortProjectionLocal(sessionPublicId);
    const adapter = bridge({
      cloud,
      device,
      executor,
      local,
      optionalSyncBudgetMs: 1,
    });

    await adapter.cycle(new AbortController().signal);
    await adapter.cycle(new AbortController().signal);
    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
    expect(local.listSessionCalls).toBe(1);
    await expect(Promise.race([
      adapter.close().then(() => "closed" as const),
      Bun.sleep(50).then(() => "timed_out" as const),
    ])).resolves.toBe("closed");
    expect(local.listSessionCalls).toBe(1);
  });

  test("a timed-out optional task cannot race a later cycle or commit after bounded close", async () => {
    const cloud = new FakeCloud();
    const device = "device_11111111";
    const sessionPublicId = "session_late_optional";
    const local = new DeferredIgnoreAbortProjectionLocal(sessionPublicId);
    const adapter = bridge({
      cloud,
      device,
      local,
      optionalSyncBudgetMs: 1,
    });

    const first = await adapter.cycle(new AbortController().signal);
    const second = await adapter.cycle(new AbortController().signal);
    expect(first.errors.join(" ")).toContain("exceeded its cycle budget");
    expect(second.errors.join(" ")).toContain("still settling");
    expect(local.listSessionCalls).toBe(1);
    await adapter.close();
    local.release([{
      createdAt: fixedNow,
      metadata: { name: "Late", note: null },
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    }]);
    await Bun.sleep(0);

    expect(cloud.sessionCreateCalls).toEqual([]);
    expect(cloud.heads.has(sessionPublicId)).toBe(false);
    await expect(adapter.cycle(new AbortController().signal)).rejects.toThrow("closed");
  });

  test("hard-bounds a remote compact-tail read before the next command poll", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const device = "device_11111111";
    const sessionPublicId = "session_remote_stall";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 1,
      compactTailDigest: "a".repeat(64),
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: device,
      metadataRevision: 0,
      projectionRevision: 1,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    cloud.stallLatestChunks = true;
    const commandPublicId = uuidV7(4_300);
    cloud.afterPendingScan = async () => {
      await cloud.enqueue("device_22222222", sessionPublicId, commandPublicId, { kind: "stop" });
    };
    const adapter = bridge({
      cloud,
      device,
      executor,
      local: new EmptyLocal(sessionPublicId),
      optionalSyncBudgetMs: 1,
    });

    await adapter.cycle(new AbortController().signal);
    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
  });

  test("retires a terminal journal receipt only after exact remote absence", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const commandPublicId = uuidV7(8_001);
    await journal.compareAndSwap(null, {
      commands: [{
        authority: { bootGeneration: 1, bootId: "boot_12345678", fence: 4 },
        commandPublicId,
        kind: "stop",
        localAuthorityDigest: "a".repeat(64),
        payloadDigest: "b".repeat(64),
        phase: "terminal",
        resultCode: "APPLIED",
        resultDigest: "c".repeat(64),
        sessionPublicId: "session_cleaned1",
        terminalState: "applied",
      }],
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    });
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local: new EmptyLocal(),
    });

    const result = await adapter.cycle(new AbortController().signal);

    expect(result.errors).toEqual([]);
    expect(result.commandsUnsettled).toBe(0);
    expect((await journal.read()).state.commands).toEqual([]);
  });

  test("finds pending commands beyond the first page before terminalizing a session", async () => {
    const cloud = new FakeCloud();
    const device = "device_11111111";
    const terminalSession = "session_terminal_pending";
    const otherSession = "session_pending_page";
    for (const publicId of [terminalSession, otherSession]) {
      cloud.heads.set(publicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow,
        detailHeadSequence: 0,
        executionDevicePublicId: device,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId,
        state: "active",
        updatedAt: fixedNow,
      });
    }
    const payload = await encryptRemoteCommand({ kind: "stop" }, key, {
      entityPublicId: uuidV7(9_000),
      keyVersion: 1,
      kind: "command",
      userPublicId,
    });
    for (let index = 0; index < 100; index += 1) {
      const publicId = uuidV7(9_100 + index);
      cloud.commands.set(publicId, {
        createdAt: fixedNow + index,
        deadline: fixedNow + 60_000,
        kind: "stop",
        payload,
        publicId,
        requestDigest: "d".repeat(64),
        sessionPublicId: otherSession,
        state: "pending",
        targetDevicePublicId: device,
        updatedAt: fixedNow + index,
      });
    }
    const lastPublicId = uuidV7(9_999);
    cloud.commands.set(lastPublicId, {
      createdAt: fixedNow + 1_000,
      deadline: fixedNow + 60_000,
      kind: "stop",
      payload,
      publicId: lastPublicId,
      requestDigest: "e".repeat(64),
      sessionPublicId: terminalSession,
      state: "pending",
      targetDevicePublicId: device,
      updatedAt: fixedNow + 1_000,
    });
    const adapter = bridge({
      cloud,
      device,
      local: new FakeLocal(terminalSession, [], "terminal"),
    });

    await adapter.cycle(new AbortController().signal);

    expect(cloud.requireHead(terminalSession).state).toBe("active");
    expect(cloud.requireCommand(lastPublicId).state).toBe("ambiguous");
  });

  test("does not infer command absence when the pending scan is incomplete", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_scan_guard";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "active",
      updatedAt: fixedNow,
    });
    cloud.forcePendingPaginationIncomplete = true;
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, [], "terminal"),
    });

    await adapter.cycle(new AbortController().signal);

    expect(cloud.requireHead(sessionPublicId).state).toBe("active");
  });

  test("fences a crash after effect-start and recovers ambiguous without redispatch", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_abcdefgh";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new FakeLocal(sessionPublicId, events),
    });
    await adapter.cycle(new AbortController().signal);
    const commandPublicId = uuidV7(3);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "send", message: "continue" },
    );
    cloud.failMarkAfterEffectOnce = true;
    await adapter.cycle(new AbortController().signal);
    expect(executor.calls).toHaveLength(0);
    expect((await journal.read()).state.commands[0]).toMatchObject({ phase: "effect_started" });

    cloud.now += 5_001;
    const recovered = await adapter.cycle(new AbortController().signal);
    expect(recovered.commandsUnsettled).toBe(0);
    expect(executor.calls).toHaveLength(0);
    expect(cloud.requireCommand(commandPublicId)).toMatchObject({
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      state: "ambiguous",
    });
  });

  for (const serverState of ["prepared", "effect_started"] as const) {
    test(`recovers a server ${serverState} command after the local journal pointer is lost`, async () => {
      const cloud = new FakeCloud();
      const executor = new RecordingExecutor();
      const sessionPublicId = `session_lost_${serverState}`;
      cloud.heads.set(sessionPublicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow,
        detailHeadSequence: 0,
        executionDevicePublicId: "device_11111111",
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: sessionPublicId,
        state: "idle",
        updatedAt: fixedNow,
      });
      const commandPublicId = uuidV7(serverState === "prepared" ? 7_001 : 7_002);
      await cloud.enqueue(
        "device_22222222",
        sessionPublicId,
        commandPublicId,
        { kind: "send", message: "continue" },
      );
      const staleAuthority = { bootGeneration: 1, bootId: "boot_stale001", fence: 1 };
      const command = cloud.requireCommand(commandPublicId);
      command.boundAuthority = staleAuthority;
      command.state = serverState;
      cloud.leases.set(sessionPublicId, {
        ...staleAuthority,
        devicePublicId: "device_11111111",
        heartbeatFingerprint: "initial",
        heartbeatSequence: 0,
        leaseUntil: cloud.now - 1,
      });
      const journal = new MemoryCloudDaemonJournal();
      const adapter = bridge({
        cloud,
        device: "device_11111111",
        executor,
        journal,
        local: new EmptyLocal(sessionPublicId),
      });

      await adapter.cycle(new AbortController().signal);

      expect(executor.calls).toEqual([]);
      expect(cloud.requireCommand(commandPublicId).state).toBe(
        serverState === "prepared" ? "failed" : "ambiguous",
      );
      expect((await journal.read()).state.commands).toEqual([]);
    });
  }

  test("prepares and executes a server pending command when the local journal is absent", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const sessionPublicId = "session_lost_pending";
    cloud.heads.set(sessionPublicId, {
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: "device_11111111",
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    });
    const commandPublicId = uuidV7(7_003);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "stop" },
    );
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal: new MemoryCloudDaemonJournal(),
      local: new EmptyLocal(sessionPublicId),
    });

    await adapter.cycle(new AbortController().signal);

    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("applied");
  });

  test("honours a remote decision only while its requesting device is active", async () => {
    const decision = {
      decision: "once" as const,
      interactionId: "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b",
      kind: "resolve_interaction" as const,
      revision: 1,
    };
    for (const revoked of [true, false]) {
      const cloud = new FakeCloud();
      const executor = new RecordingExecutor();
      const sessionPublicId = "session_remote_decision";
      cloud.heads.set(sessionPublicId, {
        compactHeadSequence: 0,
        createdAt: fixedNow,
        detailHeadSequence: 0,
        executionDevicePublicId: "device_11111111",
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: sessionPublicId,
        state: "idle",
        updatedAt: fixedNow,
      });
      if (revoked) cloud.revokedDevices.add("device_22222222");
      const commandPublicId = uuidV7(7_104);
      await cloud.enqueue("device_22222222", sessionPublicId, commandPublicId, decision);
      const adapter = bridge({
        cloud,
        device: "device_11111111",
        executor,
        journal: new MemoryCloudDaemonJournal(),
        local: new EmptyLocal(sessionPublicId),
      });
      const result = await adapter.cycle(new AbortController().signal);
      expect(result.errors).toEqual([]);
      const command = cloud.requireCommand(commandPublicId);
      if (revoked) {
        expect(executor.calls).toHaveLength(0);
        expect(command.state).toBe("failed");
        expect(command.resultCode).toBe("REQUESTING_DEVICE_INACTIVE");
      } else {
        expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([commandPublicId]);
        expect(command.state).toBe("applied");
      }
    }
  });

  test("reports an offline cycle without modifying durable command state", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    cloud.offline = true;
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      journal,
      local: new EmptyLocal(),
    });
    const result = await adapter.cycle(new AbortController().signal);
    expect(result).toMatchObject({ online: false, commandsUnsettled: 0 });
    expect(result.errors.join(" ")).toContain("network offline");
    expect((await journal.read()).state.commands).toEqual([]);
  });

  test("redacts paths, credentials, and terminal controls from cycle diagnostics", async () => {
    const cloud = new FakeCloud();
    cloud.offline = true;
    cloud.offlineMessage = [
      "Bearer",
      "secret-token-value",
      ["", "Users", "alice", "private"].join("/"),
      "\u001b]52;clipboard\u0007",
    ].join(" ");
    const result = await bridge({
      cloud,
      device: "device_11111111",
      local: new EmptyLocal(),
    }).cycle(new AbortController().signal);
    expect(result.errors).toEqual([
      "Cloud operation failed with a redacted diagnostic.",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(JSON.stringify(result)).not.toContain("Users");
    expect(JSON.stringify(result)).not.toContain("\u001b");
  });

  test("fails a no-effect prepared command after authority changes, then releases FIFO", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_authority1";
    const local = new FakeLocal(sessionPublicId, events);
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local,
    });
    await adapter.cycle(new AbortController().signal);
    const commandPublicId = uuidV7(4);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "set_model", preset: "ultra" },
    );
    cloud.failPrepareOnce = true;
    await adapter.cycle(new AbortController().signal);
    expect((await journal.read()).state.commands[0]).toMatchObject({ phase: "prepared" });
    const laterCommandPublicId = uuidV7(6);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      laterCommandPublicId,
      { kind: "stop" },
    );
    const target = cloud.requireCommand(commandPublicId);
    for (let index = 0; index < 101; index += 1) {
      const publicId = uuidV7(1_000 + index);
      cloud.commands.set(publicId, {
        createdAt: cloud.now + index + 1,
        deadline: cloud.now + 60_000,
        kind: "stop",
        payload: target.payload,
        publicId,
        requestDigest: "e".repeat(64),
        sessionPublicId,
        state: "applied",
        targetDevicePublicId: "device_11111111",
        updatedAt: cloud.now + index + 1,
      });
    }
    local.profileGeneration = 2;
    const changed = await adapter.cycle(new AbortController().signal);
    expect(changed.errors).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    expect(cloud.requireCommand(commandPublicId).state).toBe("failed");
    expect(cloud.requireCommand(laterCommandPublicId).state).toBe("pending");
    await adapter.cycle(new AbortController().signal);
    expect(executor.calls.map((call) => call.idempotencyKey)).toEqual([
      laterCommandPublicId,
    ]);
    expect(cloud.requireCommand(laterCommandPublicId).state).toBe("applied");
  });

  test("reconciles an expired prepare without starting or replaying a provider effect", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const journal = new MemoryCloudDaemonJournal();
    const sessionPublicId = "session_expired01";
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      journal,
      local: new FakeLocal(sessionPublicId, events),
    });
    await adapter.cycle(new AbortController().signal);
    const commandPublicId = uuidV7(5);
    await cloud.enqueue(
      "device_22222222",
      sessionPublicId,
      commandPublicId,
      { kind: "send", message: "too late" },
    );
    cloud.requireCommand(commandPublicId).deadline = cloud.now;

    const expired = await adapter.cycle(new AbortController().signal);

    expect(expired.errors).toEqual([]);
    expect(expired.commandsUnsettled).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(cloud.requireCommand(commandPublicId).state).toBe("expired");
    expect((await journal.read()).state.commands).toEqual([]);
    await adapter.cycle(new AbortController().signal);
    expect(executor.calls).toEqual([]);
  });

  test("a close that lands during a cycle ends the wake-gated wait at once", async () => {
    const manual = manualPushWake();
    let closing: Promise<void> | undefined;
    const bridge = {
      async close() { await manual.wake.close(); },
      async cycle() {
        // The daemon shuts down while this cycle is still running, so the
        // abort precedes the wait; the loop must not sleep the full interval.
        closing ??= lifecycle.close();
        return {
          commandsApplied: 0,
          commandsUnsettled: 0,
          errors: [],
          online: true,
          remoteSessions: [],
          sessionsUploaded: 0,
          usageUploaded: 0,
        };
      },
      async pullRemoteSessions() { return []; },
      pushWake() { return manual.wake; },
    };
    const lifecycle = new PollingCloudDaemonLifecycle({ bridge, intervalMs: 15_000 });
    const startedAt = Date.now();
    lifecycle.start();
    await until(() => closing !== undefined, "the cycle to request shutdown");
    await closing;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(manual.wake.status().state).toBe("closed");
  });

  test("close aborts and joins the polling lifecycle", async () => {
    let calls = 0;
    let closeCalls = 0;
    const lifecycle = new PollingCloudDaemonLifecycle({
      bridge: {
        async close() { closeCalls += 1; },
        async cycle() {
          calls += 1;
          return {
            commandsApplied: 0,
            commandsUnsettled: 0,
            errors: [],
            online: true,
            remoteSessions: [],
            sessionsUploaded: 0,
            usageUploaded: 0,
          };
        },
        async pullRemoteSessions() { return []; },
      },
      intervalMs: 1_000,
    });
    lifecycle.start();
    await lifecycle.close();
    await lifecycle.join();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(closeCalls).toBe(1);
  });
});

type ManualPushWake = Readonly<{
  deliver: (value: unknown) => void;
  wake: CloudPushWakePort;
}>;

function manualPushWake(): ManualPushWake {
  let handlers: Parameters<CloudPushWakeSubscriber>[0] | null = null;
  const wake = createCloudPushWake({
    subscribe: (next) => {
      handlers = next;
      return { close: async () => { handlers = null; } };
    },
  });
  return {
    deliver: (value: unknown) => { handlers?.onResult(value); },
    wake,
  };
}

function pendingRows(...commandPublicIds: readonly string[]): readonly unknown[] {
  return commandPublicIds.map((publicId, index) => ({
    publicId,
    sessionPublicId: "session_pushwake",
    state: "pending",
    updatedAt: fixedNow + index,
  }));
}

async function until(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await Bun.sleep(1);
  }
}

describe("cloud daemon push wake and adaptive cadence", () => {
  test("executes a pending command within 100ms of the subscription change", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const sessionPublicId = "session_pushwake1";
    const manual = manualPushWake();
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      local: new FakeLocal(sessionPublicId, events),
      pushWake: manual.wake,
    });
    let cycles = 0;
    // A very long timer proves the wake, not the poll interval, ran the command.
    const lifecycle = new PollingCloudDaemonLifecycle({
      bridge: adapter,
      intervalMs: 60_000,
      onCycle: () => { cycles += 1; },
    });
    manual.deliver(pendingRows());
    lifecycle.start();
    try {
      await until(() => cycles >= 1 && cloud.heads.has(sessionPublicId), "the first cycle");
      await Bun.sleep(20);
      expect(executor.calls).toEqual([]);

      const commandPublicId = uuidV7(9_001);
      await cloud.enqueue(
        "device_22222222",
        sessionPublicId,
        commandPublicId,
        { kind: "send", message: "steer from the phone" },
      );
      const wokeAt = performance.now();
      manual.deliver(pendingRows(commandPublicId));
      await until(() => executor.calls.length > 0, "the woken command execution", 5_000);
      const latencyMs = performance.now() - wokeAt;
      console.log(`push wake to command execution: ${latencyMs.toFixed(1)}ms`);
      expect(latencyMs).toBeLessThan(100);
      expect(executor.calls).toEqual([{ idempotencyKey: commandPublicId, sessionPublicId }]);
      expect(manual.wake.status()).toMatchObject({ state: "listening", wakes: 1 });
    } finally {
      await lifecycle.close();
    }
  }, 20_000);

  test("a wake latched during a cycle and the poll timer execute each command once", async () => {
    const cloud = new FakeCloud();
    const executor = new RecordingExecutor();
    const sessionPublicId = "session_pushwake2";
    const manual = manualPushWake();
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      executor,
      local: new FakeLocal(sessionPublicId, events),
      pushWake: manual.wake,
    });
    let cycles = 0;
    const lifecycle = new PollingCloudDaemonLifecycle({
      bridge: adapter,
      intervalMs: 1_000,
      onCycle: () => { cycles += 1; },
    });
    manual.deliver(pendingRows());
    lifecycle.start();
    try {
      await until(() => cycles >= 1 && cloud.heads.has(sessionPublicId), "the first cycle");
      const first = uuidV7(9_101);
      const second = uuidV7(9_102);
      await cloud.enqueue("device_22222222", sessionPublicId, first, { kind: "stop" });
      await cloud.enqueue(
        "device_22222222",
        sessionPublicId,
        second,
        { kind: "set_model", preset: "ultra" },
      );
      // The wake fires again from inside the very cycle that claims these
      // commands, so the next sleep returns immediately while the one-second
      // timer is also due. Neither may produce a second execution.
      cloud.afterPendingScan = () => { manual.deliver(pendingRows(first, second)); };
      manual.deliver(pendingRows(first));
      await until(
        () => cloud.requireCommand(first).state === "applied"
          && cloud.requireCommand(second).state === "applied",
        "both commands to settle",
      );
      const settledCycles = cycles;
      await until(() => cycles >= settledCycles + 3, "three further cycles");
      expect(executor.calls.filter((call) => call.idempotencyKey === first)).toHaveLength(1);
      expect(executor.calls.filter((call) => call.idempotencyKey === second)).toHaveLength(1);
      expect(executor.calls).toHaveLength(2);
    } finally {
      await lifecycle.close();
    }
  }, 30_000);

  test("reports the cadence hint from peer presence and local turn activity", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_cadence1";
    const local = new FakeLocal(sessionPublicId, events) as FakeLocal & {
      hasActiveTurn?: () => boolean;
    };
    const adapter = bridge({ cloud, device: "device_11111111", local });
    const signal = new AbortController().signal;

    const idle = await adapter.cycle(signal);
    expect(idle.errors).toEqual([]);
    expect(idle.activity).toEqual({ localTurnActive: false, peerDevicePresent: false });
    expect(cloud.deviceListCalls).toBe(1);

    // The probe is cached, so a peer that appears inside the window is not
    // observed until the cache expires.
    cloud.peerDevices = [{ online: true, publicId: "device_22222222", status: "active" }];
    expect((await adapter.cycle(signal)).activity)
      .toEqual({ localTurnActive: false, peerDevicePresent: false });
    expect(cloud.deviceListCalls).toBe(1);

    cloud.now += 11_000;
    expect((await adapter.cycle(signal)).activity)
      .toEqual({ localTurnActive: false, peerDevicePresent: true });

    // A revoked or offline peer, and this daemon's own row, never count.
    cloud.peerDevices = [
      { online: false, publicId: "device_22222222", status: "active" },
      { online: true, publicId: "device_33333333", status: "revoked" },
    ];
    cloud.now += 11_000;
    expect((await adapter.cycle(signal)).activity)
      .toEqual({ localTurnActive: false, peerDevicePresent: false });

    // A declared device class is believed when the summary carries one.
    cloud.peerDevices = [
      { deviceClass: "daemon", online: true, publicId: "device_44444444", status: "active" },
    ];
    cloud.now += 11_000;
    expect((await adapter.cycle(signal)).activity)
      .toEqual({ localTurnActive: false, peerDevicePresent: false });
    cloud.peerDevices = [
      { deviceClass: "browser", online: true, publicId: "device_55555555", status: "active" },
    ];
    cloud.now += 11_000;
    local.hasActiveTurn = () => true;
    expect((await adapter.cycle(signal)).activity)
      .toEqual({ localTurnActive: true, peerDevicePresent: true });
  }, 20_000);

  test("keeps the last cadence hint when the device probe fails", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_cadence2";
    const upstream = cloud.connect("device_11111111");
    let failDeviceList = false;
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, events),
      transport: {
        ...upstream,
        query: async (name, args) => {
          if (name === "devices:list" && failDeviceList) {
            throw new Error("device list unavailable");
          }
          return await upstream.query(name, args);
        },
      },
    });
    const signal = new AbortController().signal;
    cloud.peerDevices = [{ online: true, publicId: "device_22222222", status: "active" }];
    expect((await adapter.cycle(signal)).activity?.peerDevicePresent).toBe(true);

    failDeviceList = true;
    cloud.now += 11_000;
    const degraded = await adapter.cycle(signal);
    expect(degraded.activity).toEqual({ localTurnActive: false, peerDevicePresent: true });
    expect(degraded.errors).toEqual([]);
  }, 20_000);

  test("moves between the fast and idle intervals and publishes them in status", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_cadence3";
    const manual = manualPushWake();
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, events),
      pushWake: manual.wake,
    });
    let cycles = 0;
    const lifecycle = new PollingCloudDaemonLifecycle({
      bridge: adapter,
      intervalMs: 15_000,
      onCycle: () => { cycles += 1; },
    });
    expect(lifecycle.syncCadence()).toMatchObject({
      intervalMs: 15_000,
      mode: "idle",
      reason: "idle",
    });
    manual.deliver(pendingRows());
    lifecycle.start();
    try {
      await until(() => cycles >= 1, "the first cycle");
      expect(lifecycle.syncCadence()).toMatchObject({
        intervalMs: 15_000,
        mode: "idle",
        reason: "idle",
      });
      expect(lifecycle.syncCadence().pushWake).toMatchObject({ state: "listening" });

      cloud.peerDevices = [{ online: true, publicId: "device_22222222", status: "active" }];
      cloud.now += 11_000;
      const before = cycles;
      manual.deliver(pendingRows(uuidV7(9_201)));
      await until(() => cycles > before, "a woken cycle");
      expect(lifecycle.syncCadence()).toMatchObject({
        intervalMs: 1_000,
        mode: "active",
        reason: "browser_device_present",
      });
    } finally {
      await lifecycle.close();
    }
  }, 20_000);

  test("reports one push-wake diagnostic through the cycle result and closes the socket", async () => {
    const cloud = new FakeCloud();
    const sessionPublicId = "session_pushwake3";
    let closes = 0;
    const captured: { handlers: Parameters<CloudPushWakeSubscriber>[0] | null } = {
      handlers: null,
    };
    const wake = createCloudPushWake({
      subscribe: (next) => {
        captured.handlers = next;
        return { close: async () => { closes += 1; } };
      },
    });
    const adapter = bridge({
      cloud,
      device: "device_11111111",
      local: new FakeLocal(sessionPublicId, events),
      pushWake: wake,
    });
    const signal = new AbortController().signal;
    expect((await adapter.cycle(signal)).errors).toEqual([]);
    captured.handlers?.onError(new Error("push subscription refused"));
    const reported = await adapter.cycle(signal);
    expect(reported.errors).toEqual(["push wake: push subscription refused"]);
    expect((await adapter.cycle(signal)).errors).toEqual([]);
    expect(adapter.pushWake()).toBe(wake);
    await adapter.close();
    expect(wake.status().state).toBe("closed");
    expect(closes).toBeGreaterThanOrEqual(1);
    expect(pushWakeBackoffMs(1)).toBe(1_000);
    expect(pendingCommandFingerprint([])).toBe("0|");
  }, 20_000);
});

describe("device registry publication", () => {
  const registry = {
    accounts: [],
    daemonVersion: "0.3.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    heartbeatAt: 0,
    machineLabel: "Studio",
    projects: [],
    proseAutorespondConfigured: false,
    scheduledTasks: [],
    showThinkingDefault: false,
    version: 1,
  } as const;

  function registryWorld(readDeviceRegistry: () => Promise<DeviceRegistryPayload>) {
    const cloud = new FakeCloud();
    const device = "device_registry_1";
    const inner = cloud.connect(device);
    const rows = new Map<string, Readonly<{ envelope: EncryptedEnvelope; keyVersion: number; revision: number }>>();
    const writes: Array<Readonly<{ expectedRevision: number }>> = [];
    const local: CloudDaemonLocalSourcePort = Object.assign(new EmptyLocal(), { readDeviceRegistry });
    const transport: CloudTransport = {
      action: (name, args) => inner.action(name, args),
      mutation: async (name, args) => {
        if (name !== "devices:updateRegistry") return await inner.mutation(name, args);
        const expectedRevision = args.expectedRevision as number;
        writes.push({ expectedRevision });
        const current = rows.get(device);
        if ((current?.revision ?? 0) !== expectedRevision) {
          throw new Error("DEVICE_REGISTRY_REVISION_CONFLICT");
        }
        const revision = expectedRevision + 1;
        rows.set(device, {
          envelope: args.envelope as unknown as EncryptedEnvelope,
          keyVersion: args.keyVersion as number,
          revision,
        });
        return { devicePublicId: device, revision, updatedAt: cloud.now };
      },
      query: async (name, args) => {
        if (name !== "devices:getRegistry") return await inner.query(name, args);
        const row = rows.get(args.devicePublicId as string);
        return row === undefined ? null : { devicePublicId: device, ...row, updatedAt: cloud.now };
      },
    };
    return { cloud, device, local, rows, transport, writes };
  }

  test("publishes on start, republishes on change, and otherwise heartbeats at most once a minute", async () => {
    let projection: DeviceRegistryPayload = { ...registry, heartbeatAt: 1_000 };
    const world = registryWorld(() => Promise.resolve(projection));
    const daemon = bridge({
      cloud: world.cloud,
      device: world.device,
      local: world.local,
      now: () => world.cloud.now,
      transport: world.transport,
    });
    const signal = new AbortController().signal;

    expect((await daemon.cycle(signal)).errors).toEqual([]);
    expect(world.writes).toEqual([{ expectedRevision: 0 }]);
    const stored = world.rows.get(world.device);
    expect(stored?.revision).toBe(1);
    expect(await decryptDeviceRegistry(
      stored?.envelope as EncryptedEnvelope,
      key,
      {
        entityPublicId: world.device,
        keyVersion: 1,
        kind: "device_registry",
        userPublicId,
      },
    )).toEqual(projection);

    // Unchanged inputs inside the heartbeat window write nothing.
    projection = { ...projection, heartbeatAt: projection.heartbeatAt + 1_000 };
    expect((await daemon.cycle(signal)).errors).toEqual([]);
    expect(world.writes).toHaveLength(1);

    // A changed input republishes immediately under the returned revision.
    projection = { ...projection, showThinkingDefault: true };
    expect((await daemon.cycle(signal)).errors).toEqual([]);
    expect(world.writes).toEqual([{ expectedRevision: 0 }, { expectedRevision: 1 }]);
    expect(world.rows.get(world.device)?.revision).toBe(2);

    // With inputs unchanged, the heartbeat republishes after the interval.
    world.cloud.now += 60_000;
    expect((await daemon.cycle(signal)).errors).toEqual([]);
    expect(world.writes).toHaveLength(3);
    expect(world.rows.get(world.device)?.revision).toBe(3);
  });

  test("reports a registry failure without stopping the cycle and recovers the server revision", async () => {
    let failures = 1;
    const world = registryWorld(() => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("local registry unavailable"));
      }
      return Promise.resolve({ ...registry, heartbeatAt: 1_000 });
    });
    // A row written by an earlier daemon process: this process knows no
    // revision and must read the server's rather than assuming zero.
    world.rows.set(world.device, {
      envelope: { algorithm: "A256GCM", ciphertext: "AAAA", keyVersion: 1, nonce: "BBBB" },
      keyVersion: 1,
      revision: 7,
    });
    const daemon = bridge({
      cloud: world.cloud,
      device: world.device,
      local: world.local,
      now: () => world.cloud.now,
      transport: world.transport,
    });
    const signal = new AbortController().signal;

    const failed = await daemon.cycle(signal);
    expect(failed.online).toBe(true);
    expect(failed.errors).toEqual(["device registry: local registry unavailable"]);
    expect(world.writes).toEqual([]);

    expect((await daemon.cycle(signal)).errors).toEqual([]);
    expect(world.writes).toEqual([{ expectedRevision: 7 }]);
    expect(world.rows.get(world.device)?.revision).toBe(8);
  });
});

/*
 * Device commands on the daemon side. The loop mirrors `#processCommands`
 * exactly, so these cases prove the two things that differ: there is no lease,
 * and a stale journal entry left at `effect_started` by a previous boot is
 * closed as ambiguous rather than replayed.
 */
class RecordingDeviceExecutor implements CloudDeviceCommandExecutorPort {
  readonly calls: Array<Readonly<{ idempotencyKey: string; kind: string; requester: string }>> = [];
  outcome: CloudDeviceCommandExecutionResult = { code: "APPLIED", state: "applied" };
  throwOnce = false;

  async executeDeviceCommand(input: Readonly<{
    idempotencyKey: string;
    payload: DeviceCommandPayload;
    requestingDevicePublicId: string;
  }>): Promise<CloudDeviceCommandExecutionResult> {
    this.calls.push({
      idempotencyKey: input.idempotencyKey,
      kind: input.payload.kind,
      requester: input.requestingDevicePublicId,
    });
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error("the provider connection dropped");
    }
    return this.outcome;
  }
}

describe("device command execution", () => {
  const commandPublicId = "018bcfe5-6800-7000-8000-0000000000d1";

  test("claims, executes, and settles a device command with its encrypted result", async () => {
    const cloud = new FakeCloud();
    const local = new FakeLocal("session_deviceco", events);
    const deviceExecutor = new RecordingDeviceExecutor();
    deviceExecutor.outcome = {
      code: "APPLIED",
      result: { accountsRefreshed: 2, kind: "usage_refresh" },
      state: "applied",
    };
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    const journal = new MemoryCloudDaemonJournal();
    const daemon = bridge({ cloud, device: "device_daemon1", deviceExecutor, journal, local });
    const result = await daemon.cycle(new AbortController().signal);

    expect(result.errors).toEqual([]);
    expect(deviceExecutor.calls).toEqual([
      { idempotencyKey: commandPublicId, kind: "usage_refresh", requester: "device_browser1" },
    ]);
    const settled = cloud.requireDeviceCommand(commandPublicId);
    expect(settled).toMatchObject({ resultCode: "APPLIED", state: "applied" });
    const digestInput = JSON.stringify({
      code: "APPLIED",
      result: { accountsRefreshed: 2, kind: "usage_refresh" },
      state: "applied",
    });
    expect(settled.resultDigest).toBe(await hmacSha256Hex(
      key,
      "device-command-result",
      digestInput,
    ));
    expect(settled.resultDigest).not.toBe(await sha256Hex(digestInput));
    expect(settled.resultDigest).not.toBe(await hmacSha256Hex(
      Uint8Array.from(key, (byte) => byte ^ 0xff),
      "device-command-result",
      digestInput,
    ));
    expect(settled.resultDigest).not.toBe(await hmacSha256Hex(
      key,
      "device-command-payload",
      digestInput,
    ));
    expect(settled.result).toBeDefined();
    expect(await decryptDeviceCommandResult(settled.result!, key, {
      entityPublicId: commandPublicId,
      keyVersion: 1,
      kind: "device_command_result",
      userPublicId,
    })).toEqual({ accountsRefreshed: 2, kind: "usage_refresh" });
    // Nothing is left behind: the journal entry is removed once it settles.
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("shares one eight-effect cycle budget across recovery and fresh commands", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    const authority = { bootGeneration: 1, bootId: "boot_12345678", fence: 1 } as const;
    const recoveryIds = Array.from({ length: 8 }, (_, index) => uuidV7(8_000 + index));
    const freshIds = Array.from({ length: 8 }, (_, index) => uuidV7(8_100 + index));
    const recoveries: CloudDeviceCommandJournalEntry[] = [];
    for (const publicId of [...recoveryIds, ...freshIds]) {
      await cloud.enqueueDeviceCommand({
        kind: "usage_refresh",
        payload: { kind: "usage_refresh" },
        publicId,
        requestingDevicePublicId: "device_browser1",
      });
      if (!recoveryIds.includes(publicId)) continue;
      const command = cloud.requireDeviceCommand(publicId);
      command.boundAuthority = authority;
      command.state = "prepared";
      recoveries.push({
        authority,
        commandPublicId: publicId,
        kind: command.kind,
        payloadDigest: await sha256Hex(JSON.stringify(command.payload)),
        phase: "prepared",
        requestingDevicePublicId: command.requestingDevicePublicId,
      });
    }
    const observed = await journal.read();
    await journal.compareAndSwap(observed.generation, {
      ...observed.state,
      deviceCommands: recoveries,
    });
    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });

    const first = await daemon.cycle(new AbortController().signal);
    expect(first.errors).toEqual([]);
    expect(first.commandsApplied).toBe(8);
    expect(deviceExecutor.calls.map((call) => call.idempotencyKey)).toEqual(recoveryIds);
    expect(cloud.deviceCommandPendingListCalls).toBe(0);
    expect(freshIds.map((publicId) => cloud.requireDeviceCommand(publicId).state))
      .toEqual(Array.from({ length: 8 }, () => "pending"));
    expect((await journal.read()).state.deviceCommands).toEqual([]);

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(second.commandsApplied).toBe(8);
    expect(deviceExecutor.calls).toHaveLength(16);
    expect(new Set(deviceExecutor.calls.map((call) => call.idempotencyKey)).size).toBe(16);
    expect(cloud.deviceCommandPendingListCalls).toBe(1);
    expect(freshIds.map((publicId) => cloud.requireDeviceCommand(publicId).state))
      .toEqual(Array.from({ length: 8 }, () => "applied"));
  });

  test("same-boot recovery resumes after prepare committed but its response was lost", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failDevicePrepareAfterEffectOnce = true;
    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });

    const first = await daemon.cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "prepared" });
    expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "prepared" }]);

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "APPLIED",
      state: "applied",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("same-boot recovery refuses an exact read whose enqueue digest is forged", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failDevicePrepareAfterEffectOnce = true;
    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });
    expect((await daemon.cycle(new AbortController().signal)).errors).toHaveLength(1);
    cloud.requireDeviceCommand(commandPublicId).requestDigest = "e".repeat(64);

    const recovered = await daemon.cycle(new AbortController().signal);
    expect(recovered.errors).toEqual([
      `device command ${commandPublicId}: Cloud device command recovery identity is invalid.`,
    ]);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId).state).toBe("prepared");
    expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "prepared" }]);
  });

  test("same-boot recovery retries prepare after a definite precommit failure", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failDevicePrepareBeforeEffectOnce = true;
    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });

    const first = await daemon.cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "pending" });
    expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "prepared" }]);

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "APPLIED",
      state: "applied",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("same-boot recovery fails closed after mark committed but its response was lost", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failDeviceMarkAfterEffectOnce = true;
    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });

    const first = await daemon.cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "effect_started" });
    expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "effect_started" }]);

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      state: "ambiguous",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("same-boot recovery retries mark after a definite precommit failure", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failDeviceMarkBeforeEffectOnce = true;
    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });

    const first = await daemon.cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "prepared" });
    expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "effect_started" }]);

    const second = await daemon.cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "APPLIED",
      state: "applied",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("encrypts the complete login handoff and marks it single use", async () => {
    const cloud = new FakeCloud();
    const deviceExecutor = new RecordingDeviceExecutor();
    deviceExecutor.outcome = {
      code: "APPLIED",
      result: {
        expiresAt: fixedNow + 60_000,
        handoffVersion: 2,
        kind: "account_login_start",
        loginUrl: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
      },
      singleUseResult: true,
      state: "applied",
    };
    await cloud.enqueueDeviceCommand({
      kind: "account_login_start",
      payload: {
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    const daemon = bridge({ cloud, device: "device_daemon1", deviceExecutor, local: new FakeLocal("session_deviceco", events) });
    await daemon.cycle(new AbortController().signal);
    const settled = cloud.requireDeviceCommand(commandPublicId);
    expect(settled).toMatchObject({
      singleUseResult: true,
      state: "applied",
    });
    expect(JSON.stringify(settled.result)).not.toContain("ABCD-EFGH");
    expect(await decryptDeviceCommandResult(settled.result!, key, {
      entityPublicId: commandPublicId,
      keyVersion: 1,
      kind: "device_command_result",
      userPublicId,
    })).toEqual({
      expiresAt: fixedNow + 60_000,
      handoffVersion: 2,
      kind: "account_login_start",
      loginUrl: "https://auth.example.test/device",
      userCode: "ABCD-EFGH",
    });
  });

  test("replays the exact encrypted login handoff after settlement response loss", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    deviceExecutor.outcome = {
      code: "APPLIED",
      result: {
        expiresAt: fixedNow + 60_000,
        handoffVersion: 2,
        kind: "account_login_start",
        loginUrl: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
      },
      singleUseResult: true,
      state: "applied",
    };
    await cloud.enqueueDeviceCommand({
      kind: "account_login_start",
      payload: {
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failSettleAfterEffectOnce = true;

    const first = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    const terminal = (await journal.read()).state.deviceCommands[0];
    expect(terminal).toMatchObject({
      phase: "terminal",
      singleUseResult: true,
      terminalState: "applied",
    });
    if (terminal?.phase !== "terminal" || terminal.result === undefined) {
      throw new Error("missing durable login result fixture");
    }
    const durableCiphertext = terminal.result;
    // Model a crashed daemon whose presence is allowed to expire before the
    // replacement boot opens the same durable journal.
    cloud.now += cloud.presenceTtlMs + 1;

    const second = await bridge({
      cloud,
      daemonAuthority: { bootGeneration: 2, bootId: "boot_22345678", fence: 1 },
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId).result).toEqual(durableCiphertext);
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("retires a v5 applied login journal after requester revocation wins the settle race", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    deviceExecutor.outcome = {
      code: "APPLIED",
      result: {
        expiresAt: fixedNow + 60_000,
        handoffVersion: 2,
        kind: "account_login_start",
        loginUrl: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
      },
      singleUseResult: true,
      state: "applied",
    };
    await cloud.enqueueDeviceCommand({
      kind: "account_login_start",
      payload: {
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.revokeDeviceCommandBeforeSettleOnce = true;
    cloud.failRevokedDeviceCommandConfirmationOnce = true;

    const first = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(deviceExecutor.calls).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "ambiguous" });
    expect(cloud.requireDeviceCommand(commandPublicId).result).toBeUndefined();
    expect((await journal.read()).state.deviceCommands).toMatchObject([{
      phase: "terminal",
      singleUseResult: true,
      terminalState: "applied",
    }]);

    cloud.now += cloud.presenceTtlMs + 1;
    const second = await bridge({
      cloud,
      daemonAuthority: { bootGeneration: 2, bootId: "boot_22345678", fence: 1 },
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "ambiguous" });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("reconciles a v4 result-less login terminal when remote settlement committed", async () => {
    for (const consumed of [false, true]) {
      const cloud = new FakeCloud();
      const journal = new MemoryCloudDaemonJournal();
      const staleAuthority = { bootGeneration: 1, bootId: "boot_00000000", fence: 1 };
      await cloud.enqueueDeviceCommand({
        kind: "account_login_start",
        payload: {
          accountPublicId: "acct_primary0001",
          handoffVersion: 2,
          kind: "account_login_start",
        },
        publicId: commandPublicId,
        requestingDevicePublicId: "device_browser1",
      });
      const command = cloud.requireDeviceCommand(commandPublicId);
      command.boundAuthority = staleAuthority;
      command.resultCode = "APPLIED";
      command.resultDigest = "a".repeat(64);
      command.singleUseResult = true;
      command.state = "applied";
      command.result = await encryptDeviceCommandResult({
        expiresAt: fixedNow + 60_000,
        handoffVersion: 2,
        kind: "account_login_start",
        loginUrl: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
      }, key, {
        entityPublicId: commandPublicId,
        keyVersion: 1,
        kind: "device_command_result",
        userPublicId,
      });
      if (consumed) {
        delete command.result;
        command.resultConsumed = true;
      }
      const observed = await journal.read();
      await journal.compareAndSwap(observed.generation, {
        ...observed.state,
        deviceCommands: [{
          authority: staleAuthority,
          commandPublicId,
          kind: "account_login_start",
          payloadDigest: await sha256Hex(JSON.stringify(command.payload)),
          phase: "terminal",
          requestingDevicePublicId: "device_browser1",
          resultCode: "APPLIED",
          resultDigest: "a".repeat(64),
          terminalState: "applied",
        }],
        version: 4,
      });

      const result = await bridge({
        cloud,
        device: "device_daemon1",
        deviceExecutor: new RecordingDeviceExecutor(),
        journal,
        local: new FakeLocal("session_deviceco", events),
      }).cycle(new AbortController().signal);
      expect(result.errors).toEqual([]);
      expect(cloud.requireDeviceCommand(commandPublicId).state).toBe("applied");
      expect((await journal.read()).state.deviceCommands).toEqual([]);
    }
  });

  test("closes a v4 result-less login terminal as ambiguous when settlement never committed", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const staleAuthority = { bootGeneration: 1, bootId: "boot_00000000", fence: 1 };
    await cloud.enqueueDeviceCommand({
      kind: "account_login_start",
      payload: {
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    const command = cloud.requireDeviceCommand(commandPublicId);
    command.boundAuthority = staleAuthority;
    command.state = "effect_started";
    const observed = await journal.read();
    await journal.compareAndSwap(observed.generation, {
      ...observed.state,
      deviceCommands: [{
        authority: staleAuthority,
        commandPublicId,
        kind: "account_login_start",
        payloadDigest: await sha256Hex(JSON.stringify(command.payload)),
        phase: "terminal",
        requestingDevicePublicId: "device_browser1",
        resultCode: "APPLIED",
        resultDigest: "a".repeat(64),
        terminalState: "applied",
      }],
      version: 4,
    });

    const result = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor: new RecordingDeviceExecutor(),
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(result.errors).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "LOCAL_RESULT_RECOVERY_REQUIRED",
      state: "ambiguous",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("retires a v4 result-less login journal after requester revocation terminalized the command", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    const staleAuthority = { bootGeneration: 1, bootId: "boot_00000000", fence: 1 };
    await cloud.enqueueDeviceCommand({
      kind: "account_login_start",
      payload: {
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    const command = cloud.requireDeviceCommand(commandPublicId);
    command.boundAuthority = staleAuthority;
    command.state = "ambiguous";
    cloud.revokedDevices.add(command.requestingDevicePublicId);
    const observed = await journal.read();
    await journal.compareAndSwap(observed.generation, {
      ...observed.state,
      deviceCommands: [{
        authority: staleAuthority,
        commandPublicId,
        kind: "account_login_start",
        payloadDigest: await sha256Hex(JSON.stringify(command.payload)),
        phase: "terminal",
        requestingDevicePublicId: "device_browser1",
        resultCode: "APPLIED",
        resultDigest: "a".repeat(64),
        terminalState: "applied",
      }],
      version: 4,
    });

    const result = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(result.errors).toEqual([]);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "ambiguous" });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("fails closed when the requesting device is revoked after the pending scan", async () => {
    const cloud = new FakeCloud();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.afterDeviceCommandPendingScan = () => {
      cloud.revokedDevices.add("device_browser1");
    };

    const result = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);

    expect(result.errors).toEqual([]);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "REQUESTING_DEVICE_INACTIVE",
      state: "failed",
    });
  });

  test("quarantines an executor failure after the effect boundary as ambiguous", async () => {
    const cloud = new FakeCloud();
    const deviceExecutor = new RecordingDeviceExecutor();
    deviceExecutor.throwOnce = true;
    await cloud.enqueueDeviceCommand({
      kind: "session_start",
      payload: {
        accountPublicId: "acct_primary0001",
        kind: "session_start",
        preset: "ultra",
        projectPublicId: "proj_alpha000001",
        prompt: "continue",
        provider: "codex",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    const daemon = bridge({ cloud, device: "device_daemon1", deviceExecutor, local: new FakeLocal("session_deviceco", events) });
    await daemon.cycle(new AbortController().signal);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "LOCAL_EFFECT_INDETERMINATE",
      state: "ambiguous",
    });
  });

  test("a later boot fails a prepared journal whose cloud prepare never committed", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    cloud.failDevicePrepareBeforeEffectOnce = true;
    const first = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({ state: "pending" });
    expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "prepared" }]);

    cloud.now += cloud.presenceTtlMs + 1;
    const second = await bridge({
      cloud,
      daemonAuthority: { bootGeneration: 2, bootId: "boot_22345678", fence: 1 },
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT",
      state: "failed",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  for (const hostedState of ["cancelled", "expired"] as const) {
    test(`a later boot retires a prepared journal after hosted ${hostedState} wins`, async () => {
      const cloud = new FakeCloud();
      const journal = new MemoryCloudDaemonJournal();
      const deviceExecutor = new RecordingDeviceExecutor();
      await cloud.enqueueDeviceCommand({
        kind: "account_login_start",
        payload: {
          accountPublicId: "acct_primary0001",
          handoffVersion: 2,
          kind: "account_login_start",
        },
        publicId: commandPublicId,
        requestingDevicePublicId: "device_browser1",
      });
      // The requester cancellation or hosted expiry lands after the daemon's
      // pending scan but before its prepare mutation reaches the server.
      cloud.afterDeviceCommandPendingScan = () => {
        cloud.requireDeviceCommand(commandPublicId).state = hostedState;
      };
      const first = await bridge({
        cloud,
        device: "device_daemon1",
        deviceExecutor,
        journal,
        local: new FakeLocal("session_deviceco", events),
      }).cycle(new AbortController().signal);
      expect(first.errors).toHaveLength(1);
      expect(deviceExecutor.calls).toEqual([]);
      expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "prepared" }]);

      cloud.now += cloud.presenceTtlMs + 1;
      const restarted = bridge({
        cloud,
        daemonAuthority: { bootGeneration: 2, bootId: "boot_22345678", fence: 1 },
        device: "device_daemon1",
        deviceExecutor,
        journal,
        local: new FakeLocal("session_deviceco", events),
      });
      if (hostedState === "cancelled") cloud.failTerminalRecoveryConfirmationOnce = true;
      const second = await restarted.cycle(new AbortController().signal);
      if (hostedState === "cancelled") {
        expect(second.errors).toHaveLength(1);
        expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase: "prepared" }]);
        expect((await restarted.cycle(new AbortController().signal)).errors).toEqual([]);
      } else {
        expect(second.errors).toEqual([]);
      }
      expect(deviceExecutor.calls).toEqual([]);
      expect(cloud.requireDeviceCommand(commandPublicId).state).toBe(hostedState);
      expect((await journal.read()).state.deviceCommands).toEqual([]);
    });
  }

  test("a later boot retires effect-started evidence after requester revocation", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "account_login_start",
      payload: {
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    // The hosted mark commits, then requester revocation terminalizes the row
    // before the daemon receives the mark response or invokes the provider.
    cloud.revokeDeviceCommandAfterMarkOnce = true;
    const first = await bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(first.errors).toHaveLength(1);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId).state).toBe("ambiguous");
    expect((await journal.read()).state.deviceCommands).toMatchObject([{
      phase: "effect_started",
    }]);

    cloud.now += cloud.presenceTtlMs + 1;
    const second = await bridge({
      cloud,
      daemonAuthority: { bootGeneration: 2, bootId: "boot_22345678", fence: 1 },
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    }).cycle(new AbortController().signal);
    expect(second.errors).toEqual([]);
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId).state).toBe("ambiguous");
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  for (const phase of ["prepared", "effect_started"] as const) {
    test(`a later boot replays a committed ${phase} recovery after response loss`, async () => {
      const cloud = new FakeCloud();
      const journal = new MemoryCloudDaemonJournal();
      const deviceExecutor = new RecordingDeviceExecutor();
      const staleAuthority = { bootGeneration: 1, bootId: "boot_00000000", fence: 1 };
      await cloud.enqueueDeviceCommand({
        kind: "account_login_start",
        payload: {
          accountPublicId: "acct_primary0001",
          handoffVersion: 2,
          kind: "account_login_start",
        },
        publicId: commandPublicId,
        requestingDevicePublicId: "device_browser1",
      });
      const command = cloud.requireDeviceCommand(commandPublicId);
      command.boundAuthority = staleAuthority;
      command.state = phase;
      const observed = await journal.read();
      await journal.compareAndSwap(observed.generation, {
        ...observed.state,
        deviceCommands: [{
          authority: staleAuthority,
          commandPublicId,
          kind: "account_login_start",
          payloadDigest: await sha256Hex(JSON.stringify(command.payload)),
          phase,
          requestingDevicePublicId: "device_browser1",
        }],
      });

      cloud.failDeviceRecoveryAfterEffectOnce = true;
      const recovering = await bridge({
        cloud,
        daemonAuthority: { bootGeneration: 2, bootId: "boot_22345678", fence: 1 },
        device: "device_daemon1",
        deviceExecutor,
        journal,
        local: new FakeLocal("session_deviceco", events),
      }).cycle(new AbortController().signal);
      expect(recovering.errors).toHaveLength(1);
      expect(deviceExecutor.calls).toEqual([]);
      expect(cloud.requireDeviceCommand(commandPublicId).state).toBe(
        phase === "prepared" ? "failed" : "ambiguous",
      );
      expect((await journal.read()).state.deviceCommands).toMatchObject([{ phase }]);

      cloud.now += cloud.presenceTtlMs + 1;
      const final = await bridge({
        cloud,
        daemonAuthority: { bootGeneration: 3, bootId: "boot_32345678", fence: 1 },
        device: "device_daemon1",
        deviceExecutor,
        journal,
        local: new FakeLocal("session_deviceco", events),
      }).cycle(new AbortController().signal);
      expect(final.errors).toEqual([]);
      expect(deviceExecutor.calls).toEqual([]);
      expect((await journal.read()).state.deviceCommands).toEqual([]);
    });
  }

  test("a later boot closes a stale effect_started entry without re-executing it", async () => {
    const cloud = new FakeCloud();
    const journal = new MemoryCloudDaemonJournal();
    const deviceExecutor = new RecordingDeviceExecutor();
    await cloud.enqueueDeviceCommand({
      kind: "session_start",
      payload: {
        accountPublicId: "acct_primary0001",
        kind: "session_start",
        preset: "ultra",
        projectPublicId: "proj_alpha000001",
        prompt: "continue",
        provider: "codex",
      },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    // A previous boot recorded that the start may already have happened.
    const command = cloud.requireDeviceCommand(commandPublicId);
    command.state = "effect_started";
    command.boundAuthority = { bootGeneration: 1, bootId: "boot_00000000", fence: 1 };
    const observed = await journal.read();
    await journal.compareAndSwap(observed.generation, {
      ...observed.state,
      deviceCommands: [{
        authority: { bootGeneration: 1, bootId: "boot_00000000", fence: 1 },
        commandPublicId,
        kind: "session_start",
        payloadDigest: await sha256Hex(JSON.stringify(command.payload)),
        phase: "effect_started",
        requestingDevicePublicId: "device_browser1",
      }],
    });

    const daemon = bridge({
      cloud,
      device: "device_daemon1",
      deviceExecutor,
      journal,
      local: new FakeLocal("session_deviceco", events),
    });
    await daemon.cycle(new AbortController().signal);

    // Never re-executed, and closed with the only honest terminal state.
    expect(deviceExecutor.calls).toEqual([]);
    expect(cloud.requireDeviceCommand(commandPublicId)).toMatchObject({
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      state: "ambiguous",
    });
    expect((await journal.read()).state.deviceCommands).toEqual([]);
  });

  test("a daemon without a device executor never reads the device command table", async () => {
    const cloud = new FakeCloud();
    await cloud.enqueueDeviceCommand({
      kind: "usage_refresh",
      payload: { kind: "usage_refresh" },
      publicId: commandPublicId,
      requestingDevicePublicId: "device_browser1",
    });
    const daemon = bridge({ cloud, device: "device_daemon1", local: new FakeLocal("session_deviceco", events) });
    const result = await daemon.cycle(new AbortController().signal);
    expect(result.errors).toEqual([]);
    // The row stays pending and expires on its own deadline.
    expect(cloud.requireDeviceCommand(commandPublicId).state).toBe("pending");
  });
});
