import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  commitSyncVaultRootKey,
  createSyncDeviceKeyPairs,
  createSyncVaultRootKey,
  digestSyncMembershipStatement,
  digestSyncVaultRootWrapManifest,
  positiveSyncUint64Schema,
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
  type SessionSyncBackendRequest,
  type SessionSyncBackendResponse,
} from "@hraness/agent-tasks-protocol";

import {
  SessionSyncCoordinator,
  type SessionSyncHumanScope,
  type SessionSyncProjectionPort,
} from "../src/cloud/session-sync-coordinator";
import type {
  SessionSyncKeyCustody,
  SessionSyncRecoveryKeyCustody,
} from "../src/cloud/session-sync-key-custody";
import type {
  SessionSyncBearerClient,
  SessionSyncSessionResult,
} from "../src/cloud/session-sync-http-client";
import { SessionSyncOperationJournal } from "../src/state/session-sync-operation-journal";
import {
  SessionSyncStore,
  installSessionSyncSchema,
} from "../src/state/session-sync-store";

const humanScope: SessionSyncHumanScope = {
  signedIn: true,
  credentialGeneration: 7,
  userId: "user_capacity",
  organizationId: "organization_capacity",
};

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

function createDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE chat_panes (
      pane_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      state TEXT NOT NULL,
      activity_kind TEXT NOT NULL,
      attention_code TEXT,
      archived_at TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  installSessionSyncSchema(database);
  return database;
}

async function activeFixture() {
  const database = createDatabase();
  for (let index = 0; index < 64; index += 1) {
    database.query(`
      INSERT INTO chat_panes(
        pane_id, revision, title, repository_name, reasoning_effort,
        state, activity_kind, attention_code, archived_at, created_at
      ) VALUES (?1, 1, ?2, 'Example', 'max', 'ready', 'idle', NULL, NULL, ?3)
    `).run(
      `pane_${String(index).padStart(3, "0")}`,
      `Pane ${String(index)}`,
      index,
    );
  }
  const store = new SessionSyncStore(database);
  const keys = await createSyncDeviceKeyPairs();
  const deviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "p"));
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
    recoveryRootWrapDigest: `sha256_${"e".repeat(64)}`,
    members: [{
      deviceId,
      name: "Studio Mac",
      status: "active",
      keys: keys.publicKeys,
      approvedAt: "100",
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
    now: 100,
  });
  const device = store.recordDeviceKeys({
    publicKeys: keys.publicKeys,
    credentialGeneration: humanScope.credentialGeneration,
    now: 101,
  });
  store.recordEnrollmentState({
    expectedRevision: device.revision,
    state: "active",
    deviceId,
    now: 102,
  });
  store.replaceVault({
    expectedRevision: null,
    head,
    wrappedRoot,
    humanAuthority: {
      userId: humanScope.userId!,
      organizationId: humanScope.organizationId!,
    },
    now: 103,
  });
  const boot = store.beginBoot({
    bootId: syncBootIdSchema.parse(opaque("syncboot", "b")),
    now: 104,
  });
  if (!store.acknowledgeBoot({
    bootId: boot.bootId,
    bootGeneration: head.statement.membershipEpoch,
    heartbeatSequence: boot.heartbeatSequence,
    now: 105,
  })) throw new Error("failed to acknowledge fixture boot");
  return { database, deviceId, keys, rootKey, store, vault };
}

test("retained local capacity never blocks publication for an existing dirty binding", async () => {
  const fixture = await activeFixture();
  let coordinator: SessionSyncCoordinator | null = null;
  try {
    expect(fixture.store.bindEligibleLocalPanes({
      vault: fixture.vault,
      deviceId: fixture.deviceId,
      now: 106,
    })).toMatchObject({ status: "admitted", bindingCount: 64 });
    const archivedBinding = fixture.store.paneBinding("pane_000");
    const boot = fixture.store.boot();
    if (archivedBinding === null || boot === null || boot.bootGeneration === null) {
      throw new Error("missing accepted archived binding fixture");
    }
    const one = positiveSyncUint64Schema.parse("1");
    const creationGrantDigest = syncSha256DigestSchema.parse(
      `sha256_${"a".repeat(64)}`,
    );
    const acknowledgedDigest = syncSha256DigestSchema.parse(
      `sha256_${"f".repeat(64)}`,
    );
    fixture.store.recordSessionReservation({
      paneId: archivedBinding.paneId,
      expectedSessionId: archivedBinding.sessionId,
      creationGrantDigest,
      now: 107,
    });
    fixture.store.upsertLocalHead({
      sessionId: archivedBinding.sessionId,
      directoryOrdinal: one,
      mirrorEpoch: one,
      writerGeneration: one,
      bootId: boot.bootId,
      bootGeneration: boot.bootGeneration,
      membershipEpoch: one,
      keyEpoch: one,
      acknowledgedSequence: one,
      acknowledgedDigest,
      acknowledgedSourceRevision: 1,
      now: 108,
    });
    expect(fixture.store.markSessionBindingAccepted({
      sessionId: archivedBinding.sessionId,
      creationGrantDigest,
    })).toBeTrue();
    fixture.database.query(`
      DELETE FROM session_sync_dirty_panes
    `).run();
    fixture.database.query(`
      UPDATE chat_panes
      SET revision = revision + 1, archived_at = '2026-08-09T00:00:00.000Z'
      WHERE pane_id = 'pane_000'
    `).run();
    fixture.database.query(`
      INSERT INTO chat_panes(
        pane_id, revision, title, repository_name, reasoning_effort,
        state, activity_kind, attention_code, archived_at, created_at
      ) VALUES (
        'pane_new', 1, 'New pane', 'Example', 'max', 'ready', 'idle',
        NULL, NULL, 64
      )
    `).run();

    const requests: SessionSyncBackendRequest[] = [];
    const projections: Parameters<SessionSyncProjectionPort["publish"]>[0][] = [];
    let nextDirectoryOrdinal = 0;
    const ordinals = new Map<string, string>();
    const client = {
      execute: (
        request: SessionSyncBackendRequest,
      ): Promise<SessionSyncSessionResult<SessionSyncBackendResponse>> => {
        requests.push(structuredClone(request));
        if (request.operation === "reserve_session") {
          const directoryOrdinal = String(++nextDirectoryOrdinal);
          ordinals.set(request.sessionId, directoryOrdinal);
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "session_reserved",
              vault: fixture.vault,
              creationGrantDigest: request.creationGrantDigest,
              directoryOrdinal,
              expiresAt: "10000",
              sessionId: request.sessionId,
            }),
          });
        }
        if (request.operation === "acquire_writer") {
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "writer_acquired",
              vault: fixture.vault,
              bootGeneration: request.bootGeneration,
              bootId: request.bootId,
              mirrorEpoch: "1",
              writerGeneration: "1",
            }),
          });
        }
        if (request.operation === "publish_session") {
          const directoryVersion = ordinals.get(
            request.envelope.header.sessionId,
          ) ?? one;
          return Promise.resolve({
            ok: true,
            data: sessionSyncBackendResponseSchema.parse({
              kind: "session_accepted",
              accepted: {
                envelope: request.envelope,
                createdDirectoryVersion: directoryVersion,
                directoryVersion,
                serverObservedAt: "1000",
              },
              replay: false,
            }),
          });
        }
        return Promise.resolve({
          ok: false,
          kind: "operation",
          error: { code: "SERVICE_UNAVAILABLE" },
        });
      },
    } as unknown as SessionSyncBearerClient;
    const keyCustody = {
      loadRuntime: () => Promise.resolve({
        ...fixture.keys,
        vaultRootKeyring: {
          vault: fixture.vault,
          membershipEpoch: "1",
          currentRootKeyEpoch: "1",
          rootKeys: [{ keyEpoch: "1", bytes: fixture.rootKey.slice() }],
        },
      }),
      pendingVaultRootTransitionMetadata: () => Promise.resolve(null),
    } as unknown as SessionSyncKeyCustody;
    const recoveryCustody = {
      pendingTransitionMetadata: () => Promise.resolve(null),
    } as unknown as SessionSyncRecoveryKeyCustody;
    coordinator = new SessionSyncCoordinator({
      store: fixture.store,
      journal: new SessionSyncOperationJournal(fixture.database),
      keyCustody,
      recoveryCustody,
      client,
      projection: {
        publish: (event) => { projections.push(structuredClone(event)); },
      },
      cloudConfigured: true,
      humanScope: () => humanScope,
      now: () => 1_000,
      random: () => 0,
    });
    coordinator.start();
    await waitFor(
      () => requests.filter(({ operation }) => operation === "publish_session").length === 1
        || fixture.store.retry("publisher") !== null,
      "existing dirty session publications or a typed publisher failure",
    );
    const firstPublisherRetry = fixture.store.retry("publisher");
    if (firstPublisherRetry !== null) {
      throw new Error(
        `Publisher failed after operations: ${requests.map(({ operation }) => operation).join(", ")}; dirty=${String(fixture.store.listDirtyLocalIntents().length)}; outbox=${String(fixture.store.outbox().length)}; projections=${projections.map(({ type }) => type).join(", ")}.`,
      );
    }
    await waitFor(
      () => fixture.store.outbox().length === 0,
      "accepted session publication settlement",
    );

    const operations = new Set(requests.map(({ operation }) => operation));
    expect(operations.has("reserve_session")).toBeFalse();
    expect(operations.has("acquire_writer")).toBeFalse();
    expect(operations.has("publish_session")).toBeTrue();
    expect(fixture.store.paneBinding("pane_000")).toMatchObject({ state: "accepted" });
    expect(fixture.store.retiredPaneBinding(archivedBinding.sessionId)).toBeNull();
    expect(fixture.store.paneBinding("pane_new")).toBeNull();
    expect(fixture.store.localGridSlots()).toHaveLength(64);
    expect(fixture.store.retry("publisher")).toBeNull();
    expect(projections.some((event) =>
      event.type === "sessionSync.statusChanged"
      && event.status.state === "active"
      && event.status.health === "attention"
      && event.status.retryable === false
      && event.status.notice ===
        "This device retains 64 synced sessions. Additional panes remain local-only."
    )).toBeTrue();
  } finally {
    await coordinator?.stop();
    fixture.rootKey.fill(0);
    fixture.database.close();
  }
});

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
