import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SESSION_SYNC_PROTOCOL,
  acknowledgeScheduledChatRunRequestSchema,
  canonicalSessionSyncJson,
  clearScheduledChatRequestSchema,
  commitSyncVaultRootKey,
  createSyncDeviceKeyPairs,
  createSyncVaultRootKey,
  digestSyncMembershipStatement,
  digestSyncVaultRootWrapManifest,
  nextScheduledChatOccurrence,
  openScheduledChatDefinition,
  positiveSyncUint64Schema,
  putScheduledChatRequestSchema,
  sealedScheduledChatDefinitionSchema,
  sessionSyncBackendResponseSchema,
  signSyncMembershipStatement,
  syncBootIdSchema,
  syncDeviceIdSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncSha256DigestSchema,
  syncVaultCoordinateSchema,
  syncVaultRootWrapContextSchema,
  wrapSyncVaultRootKey,
  type ClearOrphanedScheduledChatAsHumanRequest,
  type PutScheduledChatRequest,
  type ReadScheduledChatRecoveryInventoryAsHumanRequest,
  type ScheduledChatRecoveryInventoryEntry,
  type ScheduledChatInventoryEntry,
  type ScheduledChatRun,
  type SessionSyncBackendRequest,
  type SessionSyncBackendResponse,
} from "@hraness/agent-tasks-protocol";

import {
  SessionSyncCoordinator,
  assertStoredScheduledChatsCanSignOut,
  type SessionSyncHumanScope,
} from "../src/cloud/session-sync-coordinator";
import type {
  SessionSyncKeyCustody,
  SessionSyncRecoveryKeyCustody,
} from "../src/cloud/session-sync-key-custody";
import type {
  SessionSyncBearerClient,
  SessionSyncSessionResult,
} from "../src/cloud/session-sync-http-client";
import { sessionSyncScheduledChatOrphanIdSchema } from "../../contracts/runtime";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";
import { ScheduledChatStore } from "../src/state/scheduled-chat-store";
import { SessionSyncOperationJournal } from "../src/state/session-sync-operation-journal";
import { SessionSyncStore } from "../src/state/session-sync-store";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const PANE = "pane_schedule_coordinator_01";
const ACCOUNT = "acct_schedule_coordinator_01";
const REPOSITORY = `repo_${"1".repeat(26)}`;
const RRULE = "DTSTART;TZID=America/Puerto_Rico:20260820T090000\nRRULE:FREQ=DAILY;INTERVAL=1";
const TIME_ZONE = "America/Puerto_Rico";
const PROMPT = "Summarize the overnight build failures and propose fixes.";
const SCOPE: SessionSyncHumanScope = {
  apiOrigin: "https://hra.example.com",
  signedIn: true,
  credentialGeneration: 7,
  userId: "user_scheduled_coordinator",
  organizationId: "organization_scheduled_coordinator",
};

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

function digest(character: string) {
  return syncSha256DigestSchema.parse(`sha256_${character.repeat(64)}`);
}

interface FixtureClientState {
  ambiguousFirstAck: boolean;
  ambiguousFirstPut: boolean;
  ambiguousFirstClear: boolean;
  ambiguousFirstPublish: boolean;
  acknowledged: boolean;
  deviceCustodyAvailable: boolean;
  dueRun: ScheduledChatRun | null;
  deviceInventory: ScheduledChatInventoryEntry[];
  forgedRecoveryOriginDeviceId: ReturnType<typeof syncDeviceIdSchema.parse> | null;
  readonly humanClears: ClearOrphanedScheduledChatAsHumanRequest[];
  readonly humanInventoryRequests: ReadScheduledChatRecoveryInventoryAsHumanRequest[];
  recoveryInventory: ScheduledChatRecoveryInventoryEntry[];
  humanScope: SessionSyncHumanScope;
  putGate: Promise<void> | null;
  rejectAckReplay: boolean;
  rejectMembership: boolean;
  resumeCalls: number;
  readonly requests: SessionSyncBackendRequest[];
}

async function fixture(options: Readonly<{
  commitScheduledChatPostimage?: (
    paneId: string,
    commit: () => void,
  ) => Promise<void>;
}> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles(
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Scheduled account', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, new Date(NOW).toISOString());
  const schedules = new ScheduledChatStore(database);
  const panes = new ChatPaneStore(database, { scheduledChatStore: schedules });
  panes.create({
    paneId: PANE,
    repository: {
      id: REPOSITORY,
      name: "Scheduled fixture",
      workingDirectory: "/fixture/scheduled",
    },
    accountProfileId: ACCOUNT,
    now: new Date(NOW),
  });

  const store = new SessionSyncStore(database);
  const keys = await createSyncDeviceKeyPairs();
  const deviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "d"));
  const vault = syncVaultCoordinateSchema.parse({
    tenantId: opaque("synctenant", "t"),
    organizationId: opaque("syncorg", "o"),
    ownerUserId: opaque("syncuser", "u"),
    vaultId: opaque("syncvault", "v"),
    vaultGeneration: "1",
  });
  const rootKey = createSyncVaultRootKey();
  const wrappedRoot = await wrapSyncVaultRootKey(
    rootKey,
    syncVaultRootWrapContextSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "1",
      rootKeyEpoch: "1",
      recipientDeviceId: deviceId,
      recipientAgreementKeyId: keys.publicKeys.agreement.keyId,
    }),
    keys.publicKeys.agreement.publicKey,
  );
  const statement = syncMembershipStatementSchema.parse({
    version: 1,
    ...vault,
    membershipEpoch: "1",
    previousMembershipDigest: null,
    recoveryGeneration: "1",
    enrollmentPairingDigest: null,
    rootKeyEpoch: "1",
    rootKeyCommitment: await commitSyncVaultRootKey(rootKey),
    rootWrapManifestDigest: await digestSyncVaultRootWrapManifest([wrappedRoot]),
    rootKeyLinkDigest: null,
    recoveryRootWrapDigest: digest("e"),
    members: [{
      deviceId,
      name: "Studio Mac",
      status: "active",
      keys: keys.publicKeys,
      approvedAt: String(NOW),
    }],
  });
  const head = syncMembershipHeadSchema.parse({
    statement,
    statementDigest: await digestSyncMembershipStatement(statement),
    signatures: [await signSyncMembershipStatement(
      statement,
      deviceId,
      keys.publicKeys.signing.keyId,
      keys.signingPrivateKey,
    )],
  });
  store.setEnabled({
    expectedRevision: 0,
    enabled: true,
    deviceName: "Studio Mac",
    now: NOW,
  });
  const device = store.recordDeviceKeys({
    publicKeys: keys.publicKeys,
    credentialGeneration: SCOPE.credentialGeneration,
    now: NOW + 1,
  });
  store.recordEnrollmentState({
    expectedRevision: device.revision,
    state: "active",
    deviceId,
    now: NOW + 2,
  });
  store.replaceVault({
    expectedRevision: null,
    head,
    wrappedRoot,
    humanAuthority: {
      apiOrigin: SCOPE.apiOrigin,
      userId: SCOPE.userId!,
      organizationId: SCOPE.organizationId!,
    },
    now: NOW + 3,
  });
  const boot = store.beginBoot({
    bootId: syncBootIdSchema.parse(opaque("syncboot", "b")),
    now: NOW + 4,
  });
  if (!store.acknowledgeBoot({
    bootId: boot.bootId,
    bootGeneration: positiveSyncUint64Schema.parse("1"),
    heartbeatSequence: boot.heartbeatSequence,
    now: NOW + 5,
  })) throw new Error("failed to acknowledge fixture boot");
  store.bindEligibleLocalPanes({ vault, deviceId, now: NOW + 6 });
  const binding = store.paneBinding(PANE);
  const currentBoot = store.boot();
  if (
    binding === null
    || currentBoot === null
    || currentBoot.bootGeneration === null
  ) {
    throw new Error("failed to bind scheduled fixture pane");
  }
  const creationGrantDigest = digest("a");
  store.recordSessionReservation({
    paneId: PANE,
    expectedSessionId: binding.sessionId,
    creationGrantDigest,
    now: NOW + 7,
  });
  store.upsertLocalHead({
    sessionId: binding.sessionId,
    directoryOrdinal: positiveSyncUint64Schema.parse("1"),
    mirrorEpoch: positiveSyncUint64Schema.parse("1"),
    writerGeneration: positiveSyncUint64Schema.parse("1"),
    bootId: currentBoot.bootId,
    bootGeneration: currentBoot.bootGeneration,
    membershipEpoch: positiveSyncUint64Schema.parse("1"),
    keyEpoch: positiveSyncUint64Schema.parse("1"),
    acknowledgedSequence: positiveSyncUint64Schema.parse("1"),
    acknowledgedDigest: digest("b"),
    acknowledgedSourceRevision: 1,
    now: NOW + 8,
  });
  if (!store.markSessionBindingAccepted({
    sessionId: binding.sessionId,
    creationGrantDigest,
  })) throw new Error("failed to accept scheduled fixture binding");
  database.query("DELETE FROM session_sync_dirty_panes").run();

  const state: FixtureClientState = {
    ambiguousFirstAck: false,
    ambiguousFirstPut: false,
    ambiguousFirstClear: false,
    ambiguousFirstPublish: false,
    acknowledged: false,
    deviceCustodyAvailable: true,
    dueRun: null,
    deviceInventory: [],
    forgedRecoveryOriginDeviceId: null,
    humanClears: [],
    humanInventoryRequests: [],
    recoveryInventory: [],
    humanScope: SCOPE,
    putGate: null,
    rejectAckReplay: false,
    rejectMembership: false,
    resumeCalls: 0,
    requests: [],
  };
  const firstRunAt = nextScheduledChatOccurrence({
    rrule: RRULE,
    timeZone: TIME_ZONE,
    after: NOW + 20,
  });
  if (firstRunAt === null) throw new Error("fixture schedule has no occurrence");
  let putAttempts = 0;
  let clearAttempts = 0;
  let ackAttempts = 0;
  const client = {
    clearOrphanedScheduledChat: (
      request: ClearOrphanedScheduledChatAsHumanRequest,
    ): Promise<SessionSyncSessionResult<SessionSyncBackendResponse>> => {
      state.humanClears.push(structuredClone(request));
      state.recoveryInventory = state.recoveryInventory.map((entry) =>
        entry.sessionId === request.sessionId
          && entry.originDeviceId === request.originDeviceId
          && entry.generation === request.expectedGeneration
          && entry.ciphertextDigest === request.expectedCiphertextDigest
          ? {
              state: "cleared" as const,
              sessionId: entry.sessionId,
              originDeviceId: entry.originDeviceId,
              generation: entry.generation,
              ciphertextDigest: entry.ciphertextDigest,
            }
          : entry
      );
      return Promise.resolve({
        ok: true,
        data: sessionSyncBackendResponseSchema.parse({
          kind: "scheduled_chat_cleared",
          sessionId: request.sessionId,
          generation: request.expectedGeneration,
          replay: false,
        }),
      });
    },
    readScheduledChatRecoveryInventory: (
      request: ReadScheduledChatRecoveryInventoryAsHumanRequest,
    ): Promise<SessionSyncSessionResult<SessionSyncBackendResponse>> => {
      state.humanInventoryRequests.push(structuredClone(request));
      const forgedOriginDeviceId = state.forgedRecoveryOriginDeviceId;
      if (forgedOriginDeviceId !== null) {
        const data: Extract<
          SessionSyncBackendResponse,
          { kind: "scheduled_chat_recovery_inventory" }
        > = {
          kind: "scheduled_chat_recovery_inventory",
          vault,
          originDeviceId: request.originDeviceId,
          schedules: state.recoveryInventory.map((entry) => ({
            ...entry,
            originDeviceId: forgedOriginDeviceId,
          })),
          hasMore: false,
        };
        return Promise.resolve({
          ok: true,
          data,
        });
      }
      return Promise.resolve({
        ok: true,
        data: sessionSyncBackendResponseSchema.parse({
          kind: "scheduled_chat_recovery_inventory",
          vault,
          originDeviceId: request.originDeviceId,
          schedules: state.recoveryInventory,
          hasMore: false,
        }),
      });
    },
    execute: (
      request: SessionSyncBackendRequest,
    ): Promise<SessionSyncSessionResult<SessionSyncBackendResponse>> => {
      state.requests.push(structuredClone(request));
      switch (request.operation) {
        case "put_scheduled_chat":
          putAttempts += 1;
          if (state.ambiguousFirstPut) {
            state.ambiguousFirstPut = false;
            return Promise.resolve({
              ok: false,
              kind: "session",
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "lost response",
              },
            });
          }
          return (state.putGate ?? Promise.resolve()).then(() => ({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "scheduled_chat_put",
              sessionId: request.definition.header.sessionId,
              schedule: {
                generation: request.definition.header.generation,
                rrule: request.definition.header.rrule,
                timeZone: request.definition.header.timeZone,
                nextRunAt: firstRunAt,
              },
              ciphertextDigest: request.definition.ciphertextDigest,
              replay: putAttempts > 1,
            }),
          }));
        case "clear_scheduled_chat":
          clearAttempts += 1;
          if (state.ambiguousFirstClear && clearAttempts === 1) {
            return Promise.resolve({
              ok: false,
              kind: "session",
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "lost response",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "scheduled_chat_cleared",
              sessionId: request.sessionId,
              generation: request.expectedGeneration,
              replay: clearAttempts > 1,
            }),
          });
        case "read_membership":
          if (state.rejectMembership) {
            return Promise.resolve({
              ok: false,
              kind: "operation",
              error: { code: "NOT_FOUND" },
            });
          }
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "membership",
              head,
              wrappedRoot,
              wrappedRoots: [wrappedRoot],
              rootWrapManifest: [wrappedRoot],
              devicePresence: [{ deviceId, connection: "online" }],
            }),
          });
        case "list_enrollment_requests":
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "enrollment_requests",
              vault,
              requests: [],
            }),
          });
        case "begin_snapshot":
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "snapshot_started",
              vault,
              expiresAt: String(NOW + 60_000),
              snapshotId: request.snapshotId,
              snapshotVersion: "0",
            }),
          });
        case "scheduled_chat_inventory":
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "scheduled_chat_inventory",
              schedules: state.deviceInventory,
              hasMore: false,
            }),
          });
        case "scheduled_run_page":
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "scheduled_run_page",
              runs: state.dueRun === null || state.acknowledged
                ? []
                : [state.dueRun],
              hasMore: false,
            }),
          });
        case "ack_scheduled_run":
          ackAttempts += 1;
          state.acknowledged = true;
          if (state.ambiguousFirstAck && ackAttempts === 1) {
            return Promise.resolve({
              ok: false,
              kind: "session",
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "lost acknowledgment response",
              },
            });
          }
          if (state.rejectAckReplay) {
            return Promise.resolve({
              ok: false,
              kind: "session",
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "acknowledgment replay remains unavailable",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "scheduled_run_acknowledged",
              runId: request.runId,
              sessionId: request.sessionId,
              generation: request.scheduleGeneration,
              nextRunAt: firstRunAt + 86_400_000,
              replay: ackAttempts > 1,
            }),
          });
        case "acquire_writer":
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "writer_acquired",
              vault,
              bootGeneration: request.bootGeneration,
              bootId: request.bootId,
              mirrorEpoch: "1",
              writerGeneration: "2",
            }),
          });
        case "publish_session":
          if (
            state.ambiguousFirstPublish
            && state.requests.filter(({ operation }) =>
              operation === "publish_session"
            ).length === 1
          ) {
            return Promise.resolve({
              ok: false,
              kind: "session",
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "lost publication response",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "session_accepted",
              accepted: {
                envelope: request.envelope,
                createdDirectoryVersion: "1",
                directoryVersion: "1",
                serverObservedAt: String(NOW + 20),
              },
              replay: false,
            }),
          });
        case "admit_membership_proposal":
        case "update_membership":
        case "approve_enrollment":
        case "establish_boot":
        case "heartbeat":
        case "reserve_session":
        case "delete_session":
        case "clear_orphaned_scheduled_chat":
        case "snapshot_page":
        case "change_page":
        case "root_key_link_page":
          return Promise.resolve({
            ok: false,
            kind: "operation",
            error: { code: "SERVICE_UNAVAILABLE" },
          });
      }
    },
  } as unknown as SessionSyncBearerClient;
  const keyCustody = {
    loadRuntime: () => state.deviceCustodyAvailable
      ? Promise.resolve({
          ...keys,
          vaultRootKeyring: {
            vault,
            membershipEpoch: positiveSyncUint64Schema.parse("1"),
            currentRootKeyEpoch: positiveSyncUint64Schema.parse("1"),
            rootKeys: [{
              keyEpoch: positiveSyncUint64Schema.parse("1"),
              bytes: rootKey.slice(),
            }],
          },
        })
      : Promise.reject(new Error("device Keychain custody is unavailable")),
    pendingVaultRootTransitionMetadata: () => Promise.resolve(null),
  } as unknown as SessionSyncKeyCustody;
  const recoveryCustody = {
    pendingTransitionMetadata: () => Promise.resolve(null),
  } as unknown as SessionSyncRecoveryKeyCustody;
  const journal = new SessionSyncOperationJournal(database);
  const delivered: Parameters<NonNullable<
    ConstructorParameters<typeof SessionSyncCoordinator>[0]["enqueueScheduledOccurrence"]
  >>[0][] = [];
  const projected: string[] = [];
  const coordinator = new SessionSyncCoordinator({
    store,
    journal,
    keyCustody,
    recoveryCustody,
    client,
    projection: { publish: () => undefined },
    cloudConfigured: true,
    humanScope: () => state.humanScope,
    scheduledChatStore: schedules,
    enqueueScheduledOccurrence: (occurrence) => {
      delivered.push(structuredClone(occurrence));
      schedules.transaction(() => schedules.enqueueRunInTransaction({
        runId: occurrence.runId,
        paneId: occurrence.paneId,
        scheduleGeneration: positiveSyncUint64Schema.parse(
          occurrence.scheduleGeneration,
        ),
        occurrenceSequence: positiveSyncUint64Schema.parse(
          occurrence.occurrenceSequence,
        ),
        scheduledFor: occurrence.scheduledFor,
        definitionCiphertextDigest: syncSha256DigestSchema.parse(
          occurrence.definitionCiphertextDigest,
        ),
        now: NOW + 20,
        enqueue: () => undefined,
      }));
      return Promise.resolve();
    },
    commitScheduledChatPostimage:
      options.commitScheduledChatPostimage ?? ((paneId, commit) => {
        commit();
        projected.push(paneId);
        return Promise.resolve();
      }),
    resumeScheduledOccurrences: () => {
      state.resumeCalls += 1;
      return Promise.resolve();
    },
    now: () => NOW + 20,
    random: () => 0,
  });
  return {
    binding,
    client,
    coordinator,
    database,
    delivered,
    firstRunAt,
    journal,
    panes,
    projected,
    rootKey,
    schedules,
    state,
    store,
  };
}

async function configure(coordinator: SessionSyncCoordinator): Promise<void> {
  await coordinator.configure({
    paneId: PANE,
    expectedRevision: 1,
    prompt: PROMPT,
    rrule: RRULE,
    timeZone: TIME_ZONE,
    now: NOW + 20,
  });
}

function syntheticScheduledDefinition(
  value: Awaited<ReturnType<typeof fixture>>,
  generationValue: number,
  digestCharacter: string,
) {
  const vaultState = value.store.vault();
  const head = value.store.localHead(value.binding.sessionId);
  const boot = value.store.boot();
  if (
    vaultState?.state !== "active"
    || head === null
    || boot === null
    || boot.bootGeneration === null
  ) throw new Error("fixture schedule authority is unavailable");
  return sealedScheduledChatDefinitionSchema.parse({
    header: {
      protocol: SESSION_SYNC_PROTOCOL,
      payloadKind: "scheduled_chat_definition",
      payloadVersion: 1,
      ...vaultState.vault,
      membershipEpoch: vaultState.membershipEpoch,
      originDeviceId: value.binding.originDeviceId,
      sessionId: value.binding.sessionId,
      mirrorEpoch: head.mirrorEpoch,
      writerGeneration: head.writerGeneration,
      bootId: boot.bootId,
      bootGeneration: boot.bootGeneration,
      keyEpoch: vaultState.rootKeyEpoch,
      previousGeneration: String(generationValue - 1),
      generation: String(generationValue),
      rrule: RRULE,
      timeZone: TIME_ZONE,
    },
    algorithm: "HKDF-SHA256-A256GCM",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA",
    ciphertextBytes: 17,
    ciphertextDigest: digest(digestCharacter),
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within<Value>(operation: Promise<Value>, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          500,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("scheduled chat session sync coordinator", () => {
  test("seals schedule definitions and projects put and clear only after relay success", async () => {
    const value = await fixture({
      commitScheduledChatPostimage: () => new Promise<void>(() => undefined),
    });
    try {
      await within(configure(value.coordinator), "non-reentrant schedule put");
      const putRequest = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (putRequest?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat put");
      }
      const put: PutScheduledChatRequest = putRequest;
      expect(canonicalSessionSyncJson(put)).not.toContain(PROMPT);
      const opened = await openScheduledChatDefinition({
        envelope: put.definition,
        expectedHeader: put.definition.header,
        rootKey: value.rootKey.slice(),
      });
      expect(opened.prompt).toBe(PROMPT);
      expect(value.schedules.get(PANE)).toMatchObject({
        sessionId: value.binding.sessionId,
        generation: "1",
        nextRunAt: value.firstRunAt,
      });
      expect(() => assertStoredScheduledChatsCanSignOut(value.schedules))
        .toThrow("Turn off scheduled chats");
      expect(value.panes.require(PANE).projection).toMatchObject({
        revision: 2,
        schedule: { rrule: RRULE },
      });
      expect(value.journal.listRecoverable()).toHaveLength(0);

      await within(value.coordinator.remove({
        paneId: PANE,
        expectedRevision: 2,
        now: NOW + 21,
      }), "non-reentrant schedule clear");
      expect(value.schedules.get(PANE)).toBeNull();
      expect(() => assertStoredScheduledChatsCanSignOut(value.schedules))
        .not.toThrow();
      expect(value.panes.require(PANE).projection).toMatchObject({
        revision: 3,
        schedule: null,
      });
      expect(value.schedules.generationHighWater(PANE, value.binding.sessionId)).toMatchObject({
        generation: "1",
      });
      await within(value.coordinator.configure({
        paneId: PANE,
        expectedRevision: 3,
        prompt: PROMPT,
        rrule: RRULE,
        timeZone: TIME_ZONE,
        now: NOW + 22,
      }), "generation-preserving schedule replacement");
      const puts = value.state.requests.filter((request) =>
        request.operation === "put_scheduled_chat"
      );
      expect(puts).toHaveLength(2);
      const replacement = puts[1];
      if (replacement?.operation !== "put_scheduled_chat") {
        throw new Error("missing replacement schedule definition");
      }
      expect(replacement.definition.header).toMatchObject({
        previousGeneration: "1",
        generation: "2",
      });
      expect(value.schedules.generationHighWater(PANE, value.binding.sessionId)).toMatchObject({
        generation: "2",
      });
      expect(value.panes.require(PANE).projection.revision).toBe(4);
      expect(value.projected).toEqual([]);
    } finally {
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("replays the exact sealed put after a lost response and settles atomically", async () => {
    const value = await fixture();
    try {
      value.state.ambiguousFirstPut = true;
      const putFailure = await configure(value.coordinator).then(
        () => null,
        (error: unknown) => error,
      );
      expect(putFailure).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.pendingMutations()).toHaveLength(1);
      expect(value.journal.listRecoverable()).toMatchObject([{
        kind: "put_scheduled_chat",
        state: "ambiguous",
      }]);

      value.coordinator.start();
      await waitFor(
        () => value.schedules.get(PANE) !== null,
        "exact scheduled-chat replay",
      );
      await value.coordinator.stop();
      const puts = value.state.requests.filter((request) =>
        request.operation === "put_scheduled_chat"
      );
      expect(puts).toHaveLength(2);
      expect(canonicalSessionSyncJson(puts[0])).toBe(
        canonicalSessionSyncJson(puts[1]),
      );
      expect(value.schedules.pendingMutations()).toHaveLength(0);
      expect(value.journal.listRecoverable()).toHaveLength(0);
      expect(value.panes.require(PANE).projection.revision).toBe(2);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("abandons an undispatched first put before device-custody recovery", async () => {
    const value = await fixture();
    try {
      const definition = syntheticScheduledDefinition(value, 1, "c");
      const request = putScheduledChatRequestSchema.parse({
        version: 1,
        operation: "put_scheduled_chat",
        definition,
      });
      const operationId = `syncop_${"p".repeat(32)}`;
      value.schedules.transaction(() => {
        value.journal.prepare({
          operationId,
          kind: "put_scheduled_chat",
          sessionId: value.binding.sessionId,
          request,
          now: NOW + 20,
        });
        value.schedules.preparePut({
          operationId,
          paneId: PANE,
          sessionId: value.binding.sessionId,
          expectedPaneRevision: 1,
          targetGeneration: positiveSyncUint64Schema.parse("1"),
          request,
          definition,
          nextRunAt: value.firstRunAt,
          now: NOW + 20,
        });
      });
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 1,
        now: NOW + 21,
      })).toMatchObject({ targetGeneration: "1" });
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.schedules.pendingMutations().length === 0
          && value.journal.get(operationId)?.state === "terminal",
        "undispatched scheduled put abandonment",
      );
      await value.coordinator.stop();
      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.panes.require(PANE).projection.revision).toBe(1);
      expect(value.state.requests.some((entry) =>
        entry.operation === "put_scheduled_chat"
        || entry.operation === "clear_scheduled_chat"
      )).toBeFalse();
      expect(value.journal.get(operationId)?.outcome).toMatchObject({
        kind: "restart_abandoned_before_dispatch",
      });
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("retargets off to the active generation after abandoning an undispatched update", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const active = value.schedules.get(PANE);
      if (active === null) throw new Error("missing active schedule");
      const definition = syntheticScheduledDefinition(value, 2, "d");
      const request = putScheduledChatRequestSchema.parse({
        version: 1,
        operation: "put_scheduled_chat",
        definition,
      });
      const operationId = `syncop_${"u".repeat(32)}`;
      value.schedules.transaction(() => {
        value.journal.prepare({
          operationId,
          kind: "put_scheduled_chat",
          sessionId: value.binding.sessionId,
          request,
          now: NOW + 21,
        });
        value.schedules.preparePut({
          operationId,
          paneId: PANE,
          sessionId: value.binding.sessionId,
          expectedPaneRevision: 2,
          targetGeneration: positiveSyncUint64Schema.parse("2"),
          request,
          definition,
          nextRunAt: value.firstRunAt,
          now: NOW + 21,
        });
      });
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 2,
        now: NOW + 22,
      })).toMatchObject({ targetGeneration: "2" });
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: active.generation,
        ciphertextDigest: active.definitionCiphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.schedules.pendingMutations().length === 0
          && value.journal.get(operationId)?.state === "terminal"
          && value.coordinator.orphanedScheduledChats().length === 1,
        "undispatched schedule update abandonment",
      );
      await value.coordinator.stop();
      expect(value.schedules.get(PANE)).toMatchObject({ generation: "1" });
      expect(value.schedules.desiredOff(PANE)).toMatchObject({
        targetGeneration: "1",
      });
      expect(value.panes.require(PANE).projection.revision).toBe(2);
      expect(value.state.requests.filter((entry) =>
        entry.operation === "put_scheduled_chat"
      )).toHaveLength(1);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("abandons an undispatched clear but preserves its active off recovery", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const active = value.schedules.get(PANE);
      const vaultState = value.store.vault();
      const head = value.store.localHead(value.binding.sessionId);
      const boot = value.store.boot();
      if (
        active === null
        || vaultState?.state !== "active"
        || head === null
        || boot === null
        || boot.bootGeneration === null
      ) throw new Error("missing scheduled clear authority");
      const request = clearScheduledChatRequestSchema.parse({
        version: 1,
        operation: "clear_scheduled_chat",
        ...vaultState.vault,
        membershipEpoch: vaultState.membershipEpoch,
        originDeviceId: value.binding.originDeviceId,
        sessionId: value.binding.sessionId,
        mirrorEpoch: head.mirrorEpoch,
        writerGeneration: head.writerGeneration,
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        keyEpoch: vaultState.rootKeyEpoch,
        expectedGeneration: active.generation,
      });
      const operationId = `syncop_${"q".repeat(32)}`;
      value.schedules.transaction(() => {
        value.journal.prepare({
          operationId,
          kind: "clear_scheduled_chat",
          sessionId: value.binding.sessionId,
          request,
          now: NOW + 21,
        });
        value.schedules.prepareClear({
          operationId,
          paneId: PANE,
          sessionId: value.binding.sessionId,
          expectedPaneRevision: 2,
          targetGeneration: active.generation,
          request,
          now: NOW + 21,
        });
      });
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 2,
        now: NOW + 22,
      })).toMatchObject({ targetGeneration: "1" });
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: active.generation,
        ciphertextDigest: active.definitionCiphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.schedules.pendingMutations().length === 0
          && value.journal.get(operationId)?.state === "terminal"
          && value.coordinator.orphanedScheduledChats().length === 1,
        "undispatched scheduled clear abandonment",
      );
      await value.coordinator.stop();
      expect(value.schedules.get(PANE)).toMatchObject({ generation: "1" });
      expect(value.schedules.desiredOff(PANE)).toMatchObject({
        targetGeneration: "1",
      });
      expect(value.panes.require(PANE).projection.revision).toBe(2);
      expect(value.state.requests.filter((entry) =>
        entry.operation === "clear_scheduled_chat"
      )).toHaveLength(0);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("abandons an undispatched run acknowledgment without consuming its run", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const active = value.schedules.get(PANE);
      const boot = value.store.boot();
      if (active === null || boot === null || boot.bootGeneration === null) {
        throw new Error("missing scheduled acknowledgment authority");
      }
      const runId = `syncrun_${"P".repeat(26)}`;
      value.schedules.transaction(() => {
        value.schedules.enqueueRunInTransaction({
          runId,
          paneId: PANE,
          scheduleGeneration: active.generation,
          occurrenceSequence: positiveSyncUint64Schema.parse("1"),
          scheduledFor: value.firstRunAt,
          definitionCiphertextDigest: active.definitionCiphertextDigest,
          now: NOW + 21,
          enqueue: () => undefined,
        });
      });
      const request = acknowledgeScheduledChatRunRequestSchema.parse({
        version: 1,
        operation: "ack_scheduled_run",
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        runId,
        sessionId: value.binding.sessionId,
        scheduleGeneration: active.generation,
        occurrenceSequence: "1",
        scheduledFor: value.firstRunAt,
      });
      const operationId = `syncop_${"r".repeat(32)}`;
      value.journal.prepare({
        operationId,
        kind: "ack_scheduled_run",
        sessionId: value.binding.sessionId,
        request,
        now: NOW + 22,
      });
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 2,
        now: NOW + 23,
      })).toMatchObject({ targetGeneration: "1" });
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: active.generation,
        ciphertextDigest: active.definitionCiphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.journal.get(operationId)?.state === "terminal"
          && value.coordinator.orphanedScheduledChats().length === 1,
        "undispatched scheduled acknowledgment abandonment",
      );
      await value.coordinator.stop();
      expect(value.schedules.run(runId)).toMatchObject({
        state: "enqueued",
        cancelledAt: null,
      });
      expect(value.schedules.get(PANE)).toMatchObject({ generation: "1" });
      expect(value.schedules.desiredOff(PANE)).toMatchObject({
        targetGeneration: "1",
      });
      expect(value.state.requests.filter((entry) =>
        entry.operation === "ack_scheduled_run"
      )).toHaveLength(0);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("explicit off after a lost first put replays then clears before any due run", async () => {
    const value = await fixture();
    try {
      value.state.ambiguousFirstPut = true;
      expect(configure(value.coordinator)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing lost scheduled chat put");
      }
      value.state.dueRun = {
        runId: `syncrun_${"D".repeat(26)}`,
        sessionId: value.binding.sessionId,
        scheduleGeneration: positiveSyncUint64Schema.parse("1"),
        occurrenceSequence: positiveSyncUint64Schema.parse("1"),
        scheduledFor: value.firstRunAt,
        definition: put.definition,
      };
      expect(value.panes.require(PANE).projection.revision).toBe(1);
      expect(value.database.query(`
        SELECT revision, archived_at, interaction_mode
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE)).toEqual({
        revision: 1,
        archived_at: null,
        interaction_mode: "chat",
      });
      expect(value.schedules.pendingMutations()).toMatchObject([{
        expectedPaneRevision: 1,
        targetGeneration: "1",
      }]);

      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 1,
        now: NOW + 21,
      })).toMatchObject({ targetGeneration: "1" });
      value.coordinator.start();
      await waitFor(
        () => value.state.requests.filter((request) =>
          request.operation === "clear_scheduled_chat"
        ).length === 1
          && value.schedules.get(PANE) === null
          && value.schedules.desiredOff(PANE) === null,
        "durable off-intent recovery",
        4_000,
      );

      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.schedules.pendingMutations()).toHaveLength(0);
      expect(value.journal.listRecoverable()).toHaveLength(0);
      expect(value.panes.require(PANE).projection).toMatchObject({
        revision: 3,
        schedule: null,
      });
      expect(value.state.requests.filter((request) =>
        request.operation === "put_scheduled_chat"
      )).toHaveLength(2);
      expect(value.state.requests.filter((request) =>
        request.operation === "clear_scheduled_chat"
      )).toHaveLength(1);

      await waitFor(
        () => value.state.requests.some((request) =>
          request.operation === "scheduled_run_page"
        ),
        "post-clear scheduled run observation",
      );
      expect(value.delivered).toEqual([]);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("explicit off after a lost schedule update clears the recovered generation", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.state.ambiguousFirstPut = true;
      const updateFailure = await value.coordinator.configure({
        paneId: PANE,
        expectedRevision: 2,
        prompt: `${PROMPT} Include flaky tests.`,
        rrule: RRULE,
        timeZone: TIME_ZONE,
        now: NOW + 21,
      }).then(() => null, (error: unknown) => error);
      expect(updateFailure).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(value.schedules.get(PANE)).toMatchObject({ generation: "1" });
      expect(value.schedules.pendingMutations()).toMatchObject([{
        kind: "put",
        targetGeneration: "2",
      }]);

      await value.coordinator.remove({
        paneId: PANE,
        expectedRevision: 2,
        now: NOW + 22,
      });

      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.schedules.pendingMutations()).toHaveLength(0);
      expect(value.schedules.generationHighWater(
        PANE,
        value.binding.sessionId,
      )).toMatchObject({ generation: "2" });
      expect(value.panes.require(PANE).projection).toMatchObject({
        revision: 4,
        schedule: null,
      });
      const puts = value.state.requests.filter((request) =>
        request.operation === "put_scheduled_chat"
      );
      expect(puts).toHaveLength(3);
      expect(canonicalSessionSyncJson(puts[1])).toBe(
        canonicalSessionSyncJson(puts[2]),
      );
      const clears = value.state.requests.filter((request) =>
        request.operation === "clear_scheduled_chat"
      );
      expect(clears).toHaveLength(1);
      expect(clears[0]).toMatchObject({ expectedGeneration: "2" });
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("replays a lost clear before reconciling its cleared human inventory", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const active = value.schedules.get(PANE);
      if (active === null) throw new Error("missing active scheduled chat");
      value.state.ambiguousFirstClear = true;
      const clearFailure = await value.coordinator.remove({
        paneId: PANE,
        expectedRevision: 2,
        now: NOW + 21,
      }).then(() => null, (error: unknown) => error);
      expect(clearFailure).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(value.schedules.pendingMutations()).toHaveLength(1);
      value.state.recoveryInventory = [{
        state: "cleared",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: active.generation,
        ciphertextDigest: active.definitionCiphertextDigest,
      }];

      value.coordinator.start();
      await waitFor(
        () => value.schedules.get(PANE) === null
          && value.schedules.pendingMutations().length === 0,
        "exact scheduled-chat clear replay",
      );
      await value.coordinator.stop();
      const clears = value.state.requests.filter((request) =>
        request.operation === "clear_scheduled_chat"
      );
      expect(clears).toHaveLength(2);
      expect(canonicalSessionSyncJson(clears[0])).toBe(
        canonicalSessionSyncJson(clears[1]),
      );
      expect(value.journal.listRecoverable()).toHaveLength(0);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("human recovery clears a lost first put after device custody is lost", async () => {
    const value = await fixture();
    try {
      value.state.ambiguousFirstPut = true;
      expect(configure(value.coordinator)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing lost scheduled chat put");
      }
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 1,
        now: NOW + 21,
      })).toMatchObject({ targetGeneration: "1" });
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("1"),
        ciphertextDigest: put.definition.ciphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.coordinator.orphanedScheduledChats().length === 1,
        "lost-put human recovery orphan",
      );
      await value.coordinator.stop();
      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.pendingMutations()).toHaveLength(1);
      const orphan = value.coordinator.orphanedScheduledChats()[0];
      if (orphan === undefined) throw new Error("missing lost-put orphan");

      await value.coordinator.clearOrphanedScheduledChat(orphan);
      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.pendingMutations()).toHaveLength(0);
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.schedules.generationHighWater(
        PANE,
        value.binding.sessionId,
      )).toMatchObject({ generation: "1" });
      expect(value.journal.listRecoverable()).toHaveLength(0);
      expect(value.panes.require(PANE).projection.revision).toBe(2);
      expect(value.delivered).toEqual([]);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("human recovery clears a lost schedule update after device custody is lost", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.state.ambiguousFirstPut = true;
      expect(value.coordinator.configure({
        paneId: PANE,
        expectedRevision: 2,
        prompt: `${PROMPT} Include deployment regressions.`,
        rrule: RRULE,
        timeZone: TIME_ZONE,
        now: NOW + 21,
      })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      const puts = value.state.requests.filter((request) =>
        request.operation === "put_scheduled_chat"
      );
      const update = puts[1];
      if (update?.operation !== "put_scheduled_chat") {
        throw new Error("missing lost scheduled chat update");
      }
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 2,
        now: NOW + 22,
      })).toMatchObject({ targetGeneration: "2" });
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("2"),
        ciphertextDigest: update.definition.ciphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.coordinator.orphanedScheduledChats().length === 1,
        "lost-update human recovery orphan",
      );
      await value.coordinator.stop();
      const orphan = value.coordinator.orphanedScheduledChats()[0];
      if (orphan === undefined) throw new Error("missing lost-update orphan");
      await value.coordinator.clearOrphanedScheduledChat(orphan);

      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.pendingMutations()).toHaveLength(0);
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.schedules.generationHighWater(
        PANE,
        value.binding.sessionId,
      )).toMatchObject({ generation: "2" });
      expect(value.journal.listRecoverable()).toHaveLength(0);
      expect(value.panes.require(PANE).projection.revision).toBe(3);
      expect(value.delivered).toEqual([]);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("cleared human inventory settles a lost clear after device custody is lost", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const active = value.schedules.get(PANE);
      if (active === null) throw new Error("missing active scheduled chat");
      value.state.ambiguousFirstClear = true;
      expect(value.coordinator.remove({
        paneId: PANE,
        expectedRevision: 2,
        now: NOW + 21,
      })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      value.state.recoveryInventory = [{
        state: "cleared",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: active.generation,
        ciphertextDigest: active.definitionCiphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.schedules.get(PANE) === null
          && value.schedules.pendingMutations().length === 0
          && value.schedules.desiredOff(PANE) === null,
        "lost-clear human inventory settlement",
      );
      await value.coordinator.stop();
      expect(value.journal.listRecoverable()).toHaveLength(0);
      expect(value.coordinator.orphanedScheduledChats()).toEqual([]);
      expect(value.state.humanClears).toEqual([]);
      expect(value.panes.require(PANE).projection.revision).toBe(3);
      expect(value.delivered).toEqual([]);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("a running coordinator self-replays a lost clear without a restart or another command", async () => {
    const value = await fixture();
    try {
      value.coordinator.start();
      await waitFor(
        () => value.state.humanInventoryRequests.length > 0,
        "initial scheduled recovery inventory",
      );
      await configure(value.coordinator);
      value.state.ambiguousFirstClear = true;

      expect(value.coordinator.remove({
        paneId: PANE,
        expectedRevision: 2,
        now: NOW + 21,
      })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(value.schedules.pendingMutations()).toHaveLength(1);

      await waitFor(
        () => value.schedules.get(PANE) === null
          && value.schedules.pendingMutations().length === 0,
        "live exact scheduled-chat clear replay",
        4_000,
      );
      const clears = value.state.requests.filter((request) =>
        request.operation === "clear_scheduled_chat"
      );
      expect(clears).toHaveLength(2);
      expect(canonicalSessionSyncJson(clears[0])).toBe(
        canonicalSessionSyncJson(clears[1]),
      );
      expect(value.journal.listRecoverable()).toHaveLength(0);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("decrypts one due occurrence, durably enqueues it once, and exactly acknowledges it", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat definition");
      }
      value.state.dueRun = {
        runId: `syncrun_${"A".repeat(26)}`,
        sessionId: value.binding.sessionId,
        scheduleGeneration: positiveSyncUint64Schema.parse("1"),
        occurrenceSequence: positiveSyncUint64Schema.parse("1"),
        scheduledFor: value.firstRunAt,
        definition: put.definition,
      };
      value.coordinator.start();
      await waitFor(
        () => value.schedules.run(value.state.dueRun!.runId)?.state
          === "acknowledged" || value.store.retry("observer") !== null,
        "scheduled occurrence acknowledgment",
      );
      if (value.store.retry("observer") !== null) {
        throw new Error(
          `Scheduled observer failed after ${value.state.requests.map(({ operation }) => operation).join(", ")}.`,
        );
      }
      await value.coordinator.stop();
      expect(value.delivered).toMatchObject([{
        paneId: PANE,
        sessionId: value.binding.sessionId,
        prompt: PROMPT,
        occurrenceSequence: "1",
      }]);
      expect(value.state.requests.filter((request) =>
        request.operation === "ack_scheduled_run"
      )).toHaveLength(1);
      expect(value.state.resumeCalls).toBeGreaterThanOrEqual(1);
      expect(value.schedules.get(PANE)?.nextRunAt).toBe(
        value.firstRunAt + 86_400_000,
      );
      expect(value.panes.require(PANE).projection.revision).toBe(3);
      expect(value.journal.listRecoverable()).toHaveLength(0);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("a running coordinator exactly replays a lost run acknowledgment", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat definition");
      }
      value.state.ambiguousFirstAck = true;
      value.state.dueRun = {
        runId: `syncrun_${"B".repeat(26)}`,
        sessionId: value.binding.sessionId,
        scheduleGeneration: positiveSyncUint64Schema.parse("1"),
        occurrenceSequence: positiveSyncUint64Schema.parse("1"),
        scheduledFor: value.firstRunAt,
        definition: put.definition,
      };

      value.coordinator.start();
      await waitFor(
        () => value.schedules.run(value.state.dueRun!.runId)?.state
          === "acknowledged",
        "live exact scheduled run acknowledgment replay",
        4_000,
      );
      const acknowledgments = value.state.requests.filter((request) =>
        request.operation === "ack_scheduled_run"
      );
      expect(acknowledgments).toHaveLength(2);
      expect(canonicalSessionSyncJson(acknowledgments[0])).toBe(
        canonicalSessionSyncJson(acknowledgments[1]),
      );
      expect(value.delivered).toHaveLength(1);
      expect(value.journal.listRecoverable()).toHaveLength(0);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("human clear supersedes a lost run acknowledgment after device custody is lost", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat definition");
      }
      value.state.ambiguousFirstAck = true;
      value.state.rejectAckReplay = true;
      value.state.dueRun = {
        runId: `syncrun_${"K".repeat(26)}`,
        sessionId: value.binding.sessionId,
        scheduleGeneration: positiveSyncUint64Schema.parse("1"),
        occurrenceSequence: positiveSyncUint64Schema.parse("1"),
        scheduledFor: value.firstRunAt,
        definition: put.definition,
      };

      value.coordinator.start();
      await waitFor(
        () => value.journal.listRecoverable().some((entry) =>
          entry.kind === "ack_scheduled_run" && entry.state === "ambiguous"
        ),
        "lost scheduled run acknowledgment",
      );
      await value.coordinator.stop();
      expect(value.delivered).toHaveLength(1);
      expect(value.schedules.requestDesiredOff({
        paneId: PANE,
        expectedPaneRevision: 2,
        now: NOW + 21,
      })).toMatchObject({ targetGeneration: "1" });
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("1"),
        ciphertextDigest: put.definition.ciphertextDigest,
      }];
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      await waitFor(
        () => value.coordinator.orphanedScheduledChats().length === 1,
        "lost-ack human recovery orphan",
      );
      await value.coordinator.stop();
      const orphan = value.coordinator.orphanedScheduledChats()[0];
      if (orphan === undefined) throw new Error("missing lost-ack orphan");
      await value.coordinator.clearOrphanedScheduledChat(orphan);

      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.schedules.run(value.state.dueRun.runId)).toMatchObject({
        state: "acknowledged",
      });
      expect(value.journal.listRecoverable()).toHaveLength(0);
      expect(value.coordinator.orphanedScheduledChats()).toEqual([]);
      expect(value.delivered).toHaveLength(1);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("an authenticated membership read adopts a legacy vault origin without migration stamping", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.database.query(`
        UPDATE session_sync_vault_state
        SET human_api_origin = NULL
        WHERE singleton = 1
      `).run();
      expect(value.store.vault()?.humanAuthority?.apiOrigin).toBeNull();
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: SCOPE.apiOrigin!,
        userId: SCOPE.userId!,
        organizationId: SCOPE.organizationId!,
      })).not.toThrow();
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: SCOPE.apiOrigin!,
        userId: "another_user",
        organizationId: SCOPE.organizationId!,
      })).toThrow("another cloud principal");
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: SCOPE.apiOrigin!,
        userId: SCOPE.userId!,
        organizationId: "another_organization",
      })).toThrow("another cloud principal");
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://unrelated-hra.example.com",
          userId: "another_user",
          organizationId: "another_organization",
        }],
        hasUnrecognizedValue: false,
      })).not.toThrow();
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://unrelated-hra.example.com",
          userId: SCOPE.userId!,
          organizationId: "another_organization",
        }],
        hasUnrecognizedValue: false,
      })).not.toThrow();
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://unproven-hra.example.com",
          userId: SCOPE.userId!,
          organizationId: SCOPE.organizationId!,
        }],
        hasUnrecognizedValue: false,
      })).toThrow("Turn off scheduled chats");

      value.coordinator.start();
      await waitFor(
        () => value.store.vault()?.humanAuthority?.apiOrigin === SCOPE.apiOrigin,
        "authenticated legacy vault origin adoption",
      );
      expect(value.schedules.get(PANE)).not.toBeNull();
      expect(value.state.requests.some(({ operation }) =>
        operation === "read_membership"
      )).toBeTrue();
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("a legacy vault keeps its origin unknown when another backend rejects membership", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.database.query(`
        UPDATE session_sync_vault_state
        SET human_api_origin = NULL
        WHERE singleton = 1
      `).run();
      value.state.humanScope = {
        ...SCOPE,
        apiOrigin: "https://another-hra.example.com",
      };
      value.state.rejectMembership = true;
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: value.state.humanScope.apiOrigin!,
        userId: SCOPE.userId!,
        organizationId: SCOPE.organizationId!,
      })).not.toThrow();

      value.coordinator.start();
      await waitFor(
        () => value.state.requests.some(({ operation }) =>
          operation === "read_membership"
        ),
        "rejected legacy membership proof",
      );
      expect(value.store.vault()?.humanAuthority?.apiOrigin).toBeNull();
      expect(value.schedules.get(PANE)).not.toBeNull();
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: SCOPE.apiOrigin!,
          userId: SCOPE.userId!,
          organizationId: SCOPE.organizationId!,
        }],
        hasUnrecognizedValue: false,
      })).toThrow("Turn off scheduled chats");
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("reacquires a restart-conflicted session head before schedule removal", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.store.markHeadConflict(value.binding.sessionId, NOW + 21);
      expect(value.store.localHead(value.binding.sessionId)?.syncState)
        .toBe("conflict");
      expect(value.store.attempt(value.binding.sessionId)).toBeNull();

      value.coordinator.start();
      await waitFor(
        () => value.state.requests.some(({ operation }) =>
          operation === "acquire_writer"
        ) && value.state.requests.some(({ operation }) =>
          operation === "publish_session"
        ) && value.store.localHead(value.binding.sessionId)?.syncState === "idle",
        "conflicted scheduled session publication repair",
      );
      await value.coordinator.stop();
      expect(value.store.localHead(value.binding.sessionId)).toMatchObject({
        writerGeneration: "2",
        syncState: "idle",
      });

      await value.coordinator.remove({
        paneId: PANE,
        expectedRevision: value.panes.require(PANE).projection.revision,
        now: NOW + 22,
      });
      expect(value.schedules.get(PANE)).toBeNull();
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("exactly replays a lost session publication from conflict before schedule removal", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.state.ambiguousFirstPublish = true;
      value.coordinator.start();
      await waitFor(
        () => value.state.requests.filter(({ operation }) =>
          operation === "publish_session"
        ).length === 1
          && value.journal.listRecoverable().some(({ kind }) =>
            kind === "publish_session"
          ),
        "lost session publication",
      );
      await value.coordinator.stop();
      expect(value.store.attempt(value.binding.sessionId)).not.toBeNull();
      value.store.markHeadConflict(value.binding.sessionId, NOW + 21);
      expect(value.store.localHead(value.binding.sessionId)?.syncState)
        .toBe("conflict");

      value.coordinator.start();
      await waitFor(
        () => value.state.requests.filter(({ operation }) =>
          operation === "publish_session"
        ).length >= 2
          && value.store.localHead(value.binding.sessionId)?.syncState === "idle"
          && value.store.attempt(value.binding.sessionId) === null,
        "exact publication replay after restart conflict",
      );
      await value.coordinator.stop();
      expect(value.journal.listRecoverable()).toHaveLength(0);

      await value.coordinator.remove({
        paneId: PANE,
        expectedRevision: value.panes.require(PANE).projection.revision,
        now: NOW + 23,
      });
      expect(value.schedules.get(PANE)).toBeNull();
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("surfaces an opaque orphan and lets the exact human authority clear it without device keys", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      value.state.deviceCustodyAvailable = false;
      value.coordinator.start();
      await waitFor(
        () => value.coordinator.orphanedScheduledChats().length === 1,
        "portable scheduled-chat recovery",
      );
      await value.coordinator.stop();
      expect(() => value.coordinator.assertScheduledChatsCanLoseSyncAuthority())
        .toThrow("Turn off scheduled chats");
      const orphan = value.coordinator.orphanedScheduledChats()[0];
      if (orphan === undefined) throw new Error("missing orphan recovery projection");
      expect(orphan.orphanId).toMatch(/^syncscheduleorphan_[a-f0-9]{32}$/u);
      expect(value.state.requests.some(({ operation }) =>
        operation === "scheduled_run_page"
      )).toBeFalse();

      const ordinaryOffFailure = await value.coordinator.remove({
        paneId: PANE,
        expectedRevision: value.panes.require(PANE).projection.revision,
        now: NOW + 21,
      }).then(() => null, (error: unknown) => error);
      expect(ordinaryOffFailure).not.toBeNull();
      expect(value.schedules.desiredOff(PANE)).toMatchObject({
        sessionId: value.binding.sessionId,
        targetGeneration: "1",
      });

      await value.coordinator.execute({
        type: "sessionSync.scheduledChat.orphan.clear",
        expectedRevision: value.store.settings().revision,
        orphanId: sessionSyncScheduledChatOrphanIdSchema.parse(orphan.orphanId),
      });
      expect(value.state.humanClears).toMatchObject([{
        operation: "clear_orphaned_scheduled_chat_as_human",
        sessionId: value.binding.sessionId,
        expectedGeneration: "1",
      }]);
      expect(value.schedules.get(PANE)).toBeNull();
      expect(value.schedules.desiredOff(PANE)).toBeNull();
      expect(value.coordinator.orphanedScheduledChats()).toEqual([]);
      expect(() => value.coordinator.assertScheduledChatsCanLoseSyncAuthority())
        .not.toThrow();
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("device inventory rebuilds a missing local schedule without leaving a destructive orphan", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat definition");
      }
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("1"),
        ciphertextDigest: put.definition.ciphertextDigest,
      }];
      value.state.deviceInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("1"),
        nextRunAt: value.firstRunAt,
        definition: put.definition,
      }];
      value.database.query("DELETE FROM chat_scheduled_chats WHERE pane_id = ?1")
        .run(PANE);

      value.coordinator.start();
      await waitFor(
        () => value.schedules.get(PANE)?.generation === "1"
          && value.coordinator.orphanedScheduledChats().length === 0,
        "device-proof schedule inventory reconstruction",
      );
      await value.coordinator.stop();
      expect(value.schedules.get(PANE)).toMatchObject({
        sessionId: value.binding.sessionId,
        definitionCiphertextDigest: put.definition.ciphertextDigest,
      });
      expect(value.state.humanClears).toEqual([]);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("discovers and explicitly clears a cloud-only orphan before authority loss", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat definition");
      }
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("1"),
        ciphertextDigest: put.definition.ciphertextDigest,
      }];
      value.database.query("DELETE FROM chat_scheduled_chats WHERE pane_id = ?1")
        .run(PANE);
      value.database.query("DELETE FROM session_sync_pane_bindings WHERE pane_id = ?1")
        .run(PANE);
      value.store.setEnabled({
        expectedRevision: value.store.settings().revision,
        enabled: false,
        deviceName: value.store.settings().deviceName,
        now: NOW + 30,
      });
      value.state.deviceCustodyAvailable = false;

      value.coordinator.start();
      expect(() => value.coordinator.assertScheduledChatsCanLoseSyncAuthority())
        .toThrow("Turn off scheduled chats");
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: "https://hra.example.com",
        userId: "another_user",
        organizationId: SCOPE.organizationId!,
      })).toThrow("another cloud principal");
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: "https://hra.example.com",
        userId: SCOPE.userId!,
      })).not.toThrow();
      await waitFor(
        () => value.coordinator.orphanedScheduledChats().length === 1,
        "same-human cloud schedule inventory",
      );
      await value.coordinator.stop();
      expect(value.state.humanInventoryRequests).toHaveLength(2);
      expect(value.store.settings().enabled).toBeFalse();
      expect(value.state.requests.some(({ operation }) =>
        operation === "scheduled_run_page"
      )).toBeFalse();

      const orphan = value.coordinator.orphanedScheduledChats()[0];
      if (orphan === undefined) throw new Error("missing cloud-only orphan projection");
      await value.coordinator.clearOrphanedScheduledChat(orphan);
      expect(value.state.humanClears).toMatchObject([{
        operation: "clear_orphaned_scheduled_chat_as_human",
        sessionId: value.binding.sessionId,
        expectedGeneration: "1",
        expectedCiphertextDigest: put.definition.ciphertextDigest,
      }]);
      expect(value.coordinator.orphanedScheduledChats()).toEqual([]);
      expect(() => value.coordinator.assertScheduledChatsCanLoseSyncAuthority())
        .not.toThrow();
      expect(() => value.coordinator.assertScheduledChatsCanAcceptAuthentication({
        apiUrl: "https://hra.example.com",
        userId: "another_user",
        organizationId: "another_organization",
      })).not.toThrow();
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("rejects a cross-origin recovery entry before it can become a clearable orphan", async () => {
    const value = await fixture();
    try {
      await configure(value.coordinator);
      const put = value.state.requests.find((request) =>
        request.operation === "put_scheduled_chat"
      );
      if (put?.operation !== "put_scheduled_chat") {
        throw new Error("missing scheduled chat definition");
      }
      value.state.recoveryInventory = [{
        state: "active",
        sessionId: value.binding.sessionId,
        originDeviceId: value.binding.originDeviceId,
        generation: positiveSyncUint64Schema.parse("1"),
        ciphertextDigest: put.definition.ciphertextDigest,
      }];
      value.state.forgedRecoveryOriginDeviceId = syncDeviceIdSchema.parse(
        opaque("syncdevice", "x"),
      );
      value.database.query("DELETE FROM chat_scheduled_chats WHERE pane_id = ?1")
        .run(PANE);
      value.database.query("DELETE FROM session_sync_pane_bindings WHERE pane_id = ?1")
        .run(PANE);

      expect(value.coordinator.authenticationChanged()).rejects.toThrow(
        "another vault",
      );
      expect(value.coordinator.orphanedScheduledChats()).toEqual([]);
      expect(value.state.humanClears).toEqual([]);
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("sign-out authority serializes both sides of schedule preparation", async () => {
    const signOutFirst = await fixture();
    try {
      await signOutFirst.coordinator.authenticationChanged();
      const releaseSignOut = deferred();
      let signOutEntered = false;
      const signingOut = signOutFirst.coordinator
        .withScheduledChatSignOutAuthority(async () => {
          signOutEntered = true;
          await releaseSignOut.promise;
          signOutFirst.state.humanScope = {
            apiOrigin: null,
            signedIn: false,
            credentialGeneration: 8,
            userId: null,
            organizationId: null,
          };
        });
      await waitFor(() => signOutEntered, "sign-out authority lease");
      const configuring = configure(signOutFirst.coordinator).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(signOutFirst.state.requests.some(({ operation }) =>
        operation === "put_scheduled_chat"
      )).toBeFalse();
      releaseSignOut.resolve();
      await signingOut;
      expect(await configuring).toBeInstanceOf(Error);
      expect(signOutFirst.state.requests.some(({ operation }) =>
        operation === "put_scheduled_chat"
      )).toBeFalse();
    } finally {
      await signOutFirst.coordinator.stop();
      signOutFirst.rootKey.fill(0);
      signOutFirst.database.close();
    }

    const scheduleFirst = await fixture();
    try {
      await scheduleFirst.coordinator.authenticationChanged();
      const releasePut = deferred();
      scheduleFirst.state.putGate = releasePut.promise;
      const configuring = configure(scheduleFirst.coordinator);
      await waitFor(
        () => scheduleFirst.state.requests.some(({ operation }) =>
          operation === "put_scheduled_chat"
        ),
        "prepared scheduled-chat put",
      );
      let signOutEntered = false;
      const signingOut = scheduleFirst.coordinator
        .withScheduledChatSignOutAuthority(() => {
          signOutEntered = true;
          return Promise.resolve();
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(signOutEntered).toBeFalse();
      releasePut.resolve();
      await configuring;
      const signOutFailure = await signingOut.then(
        () => null,
        (error: unknown) => error,
      );
      expect(signOutFailure).toBeInstanceOf(Error);
      if (!(signOutFailure instanceof Error)) {
        throw new Error("Expected sign-out authority rejection");
      }
      expect(signOutFailure.message).toContain("Turn off scheduled chats");
      expect(signOutEntered).toBeFalse();
      expect(scheduleFirst.schedules.get(PANE)).not.toBeNull();
    } finally {
      await scheduleFirst.coordinator.stop();
      scheduleFirst.rootKey.fill(0);
      scheduleFirst.database.close();
    }
  });

  test("credential-clear authority preserves the current-empty fast path and fences the bound principal", async () => {
    const value = await fixture();
    try {
      await value.coordinator.authenticationChanged();
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://hra.example.com",
          userId: SCOPE.userId!,
          organizationId: SCOPE.organizationId!,
        }],
        hasUnrecognizedValue: false,
      })).not.toThrow();

      await configure(value.coordinator);
      value.state.humanScope = {
        ...SCOPE,
        apiOrigin: "https://another-hra.example.com",
      };
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://hra.example.com",
          userId: SCOPE.userId!,
          organizationId: SCOPE.organizationId!,
        }],
        hasUnrecognizedValue: false,
      })).toThrow("Turn off scheduled chats");
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://hra.example.com",
          userId: "another_user",
          organizationId: "another_organization",
        }],
        hasUnrecognizedValue: false,
      })).not.toThrow();
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [{
          apiUrl: "https://another-hra.example.com",
          userId: SCOPE.userId!,
          organizationId: SCOPE.organizationId!,
        }],
        hasUnrecognizedValue: false,
      })).not.toThrow();
      expect(() => value.coordinator.assertScheduledChatsCanClearAuthentication({
        identities: [],
        hasUnrecognizedValue: true,
      })).toThrow("Turn off scheduled chats");
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }
  });

  test("authentication authority spans principal validation through commit", async () => {
    const value = await fixture();
    try {
      await value.coordinator.authenticationChanged();
      const releaseAuthentication = deferred();
      let authenticationEntered = false;
      const accepting = value.coordinator
        .withScheduledChatAuthenticationAuthority(
          {
            apiUrl: "https://hra.example.com",
            userId: "user_other_principal",
            organizationId: "organization_other_principal",
          },
          async () => {
            authenticationEntered = true;
            await releaseAuthentication.promise;
            value.state.humanScope = {
              apiOrigin: "https://hra.example.com",
              signedIn: true,
              credentialGeneration: 8,
              userId: "user_other_principal",
              organizationId: "organization_other_principal",
            };
          },
        );
      await waitFor(
        () => authenticationEntered,
        "authentication authority lease",
      );
      const configuring = configure(value.coordinator).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(value.state.requests.some(({ operation }) =>
        operation === "put_scheduled_chat"
      )).toBeFalse();
      releaseAuthentication.resolve();
      await accepting;
      expect(await configuring).toBeInstanceOf(Error);
      expect(value.state.requests.some(({ operation }) =>
        operation === "put_scheduled_chat"
      )).toBeFalse();
    } finally {
      await value.coordinator.stop();
      value.rootKey.fill(0);
      value.database.close();
    }

    const scheduleFirst = await fixture();
    try {
      await scheduleFirst.coordinator.authenticationChanged();
      const releasePut = deferred();
      scheduleFirst.state.putGate = releasePut.promise;
      const configuring = configure(scheduleFirst.coordinator);
      await waitFor(
        () => scheduleFirst.state.requests.some(({ operation }) =>
          operation === "put_scheduled_chat"
        ),
        "prepared schedule before authentication",
      );
      let authenticationEntered = false;
      const accepting = scheduleFirst.coordinator
        .withScheduledChatAuthenticationAuthority(
          {
            apiUrl: "https://hra.example.com",
            userId: "user_other_principal",
            organizationId: "organization_other_principal",
          },
          () => {
            authenticationEntered = true;
            return Promise.resolve();
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(authenticationEntered).toBeFalse();
      releasePut.resolve();
      await configuring;
      const acceptanceFailure = await accepting.then(
        () => null,
        (error: unknown) => error,
      );
      expect(acceptanceFailure).toBeInstanceOf(Error);
      if (!(acceptanceFailure instanceof Error)) {
        throw new Error("Expected authentication authority rejection");
      }
      expect(acceptanceFailure.message).toContain(
        "another cloud principal",
      );
      expect(authenticationEntered).toBeFalse();
      expect(scheduleFirst.schedules.get(PANE)).not.toBeNull();
    } finally {
      await scheduleFirst.coordinator.stop();
      scheduleFirst.rootKey.fill(0);
      scheduleFirst.database.close();
    }
  });
});
