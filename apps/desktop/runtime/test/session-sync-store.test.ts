import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_SYNC_DIRECTORY_PAGE_SIZE,
  MAX_SYNC_DIRECTORY_SESSIONS,
  SESSION_SYNC_PROTOCOL,
  acceptedSessionHeadSchema,
  allocateSessionSyncNonce,
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
  createSessionSyncNonceState,
  createSyncDeviceKeyPairs,
  createSyncVaultRootKey,
  deriveSessionContentKey,
  digestSyncMembershipStatement,
  digestSyncVaultRootWrapManifest,
  positiveSyncUint64Schema,
  openSessionSummary,
  retiredSessionIdFenceSchema,
  sealSessionSummary,
  sessionPublicIdSchema,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  signSyncMembershipStatement,
  syncBootIdSchema,
  syncDeviceIdSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncSha256DigestSchema,
  syncUint64Schema,
  syncVaultCoordinateSchema,
  syncVaultRootWrapContextSchema,
  wrapSyncVaultRootKey,
} from "@hraness/agent-tasks-protocol";

import { sealLocalSessionSyncIntent } from "../src/cloud/session-sync-local-crypto";
import {
  SessionSyncStore,
  SessionSyncStoreError,
  MAX_SESSION_SYNC_RETRY_DELAY_MS,
  fullJitterSessionSyncDelay,
  installSessionSyncSchema,
} from "../src/state/session-sync-store";

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

function epoch(value: number) {
  return positiveSyncUint64Schema.parse(String(value));
}

function uint64(value: number) {
  return syncUint64Schema.parse(String(value));
}

function digest(character: string) {
  return syncSha256DigestSchema.parse(`sha256_${character.repeat(64)}`);
}

function session(character: string) {
  return sessionPublicIdSchema.parse(opaque("syncsession", character));
}

const humanAuthority = {
  userId: "user_original",
  organizationId: "organization_original",
} as const;

function indexedSession(index: number) {
  return sessionPublicIdSchema.parse(
    `syncsession_${index.toString(16).padStart(32, "0")}`,
  );
}

function createDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE chat_panes (
      pane_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
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

function insertPane(
  database: Database,
  paneId: string,
  createdAt = 1,
): void {
  database.query(`
    INSERT INTO chat_panes(
      pane_id, revision, title, repository_name, reasoning_effort,
      state, activity_kind, attention_code, archived_at, created_at
    ) VALUES (?1, 1, ?2, ?3, 'max', 'ready', 'idle', NULL, NULL, ?4)
  `).run(
    paneId,
    "Inspect /Users/alice/private/repository without leaking it",
    "/Users/alice/private/repository",
    createdAt,
  );
}

async function createVaultAuthority(input: {
  readonly vault: ReturnType<typeof syncVaultCoordinateSchema.parse>;
  readonly deviceId: ReturnType<typeof syncDeviceIdSchema.parse>;
  readonly keys: Awaited<ReturnType<typeof createSyncDeviceKeyPairs>>;
}) {
  const rootKey = createSyncVaultRootKey();
  const wrappedRoot = await wrapSyncVaultRootKey(
    rootKey,
    syncVaultRootWrapContextSchema.parse({
      version: 1,
      ...input.vault,
      membershipEpoch: "1",
      rootKeyEpoch: "1",
      recipientDeviceId: input.deviceId,
      recipientAgreementKeyId: input.keys.publicKeys.agreement.keyId,
    }),
    input.keys.publicKeys.agreement.publicKey,
  );
  const statement = syncMembershipStatementSchema.parse({
    version: 1,
    ...input.vault,
    membershipEpoch: "1",
    previousMembershipDigest: null,
    enrollmentPairingDigest: null,
    recoveryGeneration: "1",
    rootKeyEpoch: "1",
    rootKeyCommitment: await commitSyncVaultRootKey(rootKey),
    rootWrapManifestDigest: await digestSyncVaultRootWrapManifest([
      wrappedRoot,
    ]),
    rootKeyLinkDigest: null,
    recoveryRootWrapDigest: `sha256_${"e".repeat(64)}`,
    members: [{
      deviceId: input.deviceId,
      name: "Studio Mac",
      status: "active",
      keys: input.keys.publicKeys,
      approvedAt: "100",
    }],
  });
  const signature = await signSyncMembershipStatement(
    statement,
    input.deviceId,
    input.keys.publicKeys.signing.keyId,
    input.keys.signingPrivateKey,
  );
  return {
    rootKey,
    wrappedRoot,
    head: syncMembershipHeadSchema.parse({
      statement,
      statementDigest: await digestSyncMembershipStatement(statement),
      signatures: [signature],
    }),
  };
}

async function activeFixture(input: { readonly paneCount?: number } = {}) {
  const database = createDatabase();
  const paneCount = input.paneCount ?? 1;
  for (let index = 0; index < paneCount; index += 1) {
    insertPane(database, `pane_${String(index).padStart(3, "0")}`, index);
  }
  const store = new SessionSyncStore(database);
  const deviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "d"));
  const keys = await createSyncDeviceKeyPairs();
  const vault = syncVaultCoordinateSchema.parse({
    tenantId: opaque("synctenant", "t"),
    organizationId: opaque("syncorg", "o"),
    ownerUserId: opaque("syncuser", "u"),
    vaultId: opaque("syncvault", "v"),
    vaultGeneration: "1",
  });
  const { head, rootKey, wrappedRoot } = await createVaultAuthority({
    vault,
    deviceId,
    keys,
  });

  store.setEnabled({
    expectedRevision: 0,
    enabled: true,
    deviceName: "Studio Mac",
    now: 100,
  });
  const device = store.recordDeviceKeys({
    publicKeys: keys.publicKeys,
    credentialGeneration: 1,
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
    humanAuthority,
    now: 103,
  });

  return {
    database,
    store,
    deviceId,
    keys,
    vault,
    head,
    rootKey,
    wrappedRoot,
  };
}

function bindOne(fixture: Awaited<ReturnType<typeof activeFixture>>) {
  const sessionId = session("s");
  expect(fixture.store.bindEligibleLocalPanes({
    vault: fixture.vault,
    deviceId: fixture.deviceId,
    now: 200,
    nextSessionId: () => sessionId,
  })).toEqual({
    status: "admitted",
    bindingCount: 1,
    addedSessionIds: [sessionId],
  });
  return sessionId;
}

function beginEmptyChangeStream(
  fixture: Awaited<ReturnType<typeof activeFixture>>,
  now: number,
): void {
  const snapshotId = `syncsnapshot_${"z".repeat(32)}`;
  const revision = fixture.store.beginSnapshot({
    vault: fixture.vault,
    snapshotId,
    snapshotVersion: uint64(0),
    now,
  });
  fixture.store.installSnapshotPage({
    snapshotId,
    expectedCursorRevision: revision,
    page: {
      version: 1,
      vault: fixture.vault,
      snapshotVersion: uint64(0),
      entries: [],
      complete: true,
    },
    localDeviceId: fixture.deviceId,
    now: now + 1,
  });
}

async function sealDirty(
  fixture: Awaited<ReturnType<typeof activeFixture>>,
  paneId = "pane_000",
) {
  const dirty = fixture.store.listDirtyLocalIntents().find(
    (candidate) => candidate.paneId === paneId,
  );
  if (dirty === undefined) throw new Error("missing dirty pane fixture");
  const allocation = fixture.store.allocateLocalIntentNonce({
    sessionId: dirty.sessionId,
    keyEpoch: epoch(1),
  });
  return {
    dirty,
    sealed: await sealLocalSessionSyncIntent({
      intent: {
        version: dirty.version,
        sessionId: dirty.sessionId,
        sourceRevision: dirty.sourceRevision,
        eventKind: dirty.eventKind,
        title: dirty.title,
        ...(dirty.repositoryDisplayName === undefined
          ? {}
          : { repositoryDisplayName: dirty.repositoryDisplayName }),
        state: dirty.state,
        deleted: dirty.deleted,
      },
      vault: fixture.vault,
      keyEpoch: epoch(1),
      rootKey: fixture.rootKey,
      nonce: allocation,
    }),
  };
}

async function acceptedRemoteHead(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly sessionId: ReturnType<typeof session>;
  readonly originDeviceId: ReturnType<typeof syncDeviceIdSchema.parse>;
  readonly directoryOrdinal: number;
  readonly directoryVersion: number;
}) {
  const { fixture } = input;
  const bootId = syncBootIdSchema.parse(opaque("syncboot", "r"));
  const allocation = allocateSessionSyncNonce(
    createSessionSyncNonceState(epoch(1), epoch(1)),
  ).allocation;
  const contentKey = await deriveSessionContentKey(fixture.rootKey, {
    version: 1,
    ...fixture.vault,
    sessionId: input.sessionId,
    keyEpoch: epoch(1),
    originDeviceId: input.originDeviceId,
    mirrorEpoch: epoch(1),
    writerGeneration: epoch(1),
  }, ["encrypt"]);
  const header = sessionSyncHeaderSchema.parse({
    protocol: SESSION_SYNC_PROTOCOL,
    payloadVersion: 1,
    payloadKind: "session_summary",
    ...fixture.vault,
    membershipEpoch: "1",
    originDeviceId: input.originDeviceId,
    sessionId: input.sessionId,
    mirrorEpoch: "1",
    writerGeneration: "1",
    bootId,
    bootGeneration: "1",
    directoryOrdinal: String(input.directoryOrdinal),
    keyEpoch: "1",
    syncSequence: "1",
    sourceRevision: "1",
    eventKind: "created",
    previousDigest: null,
    creationGrantDigest: `sha256_${"c".repeat(64)}`,
  });
  const envelope = await sealSessionSummary(sessionSummarySchema.parse({
    version: 1,
    sessionId: input.sessionId,
    ownerDeviceId: input.originDeviceId,
    directoryOrdinal: String(input.directoryOrdinal),
    sourceRevision: "1",
    title: "Remote summary",
    repositoryDisplayName: "Example",
    state: "ready",
    deleted: false,
  }), header, contentKey, allocation);
  return acceptedSessionHeadSchema.parse({
    envelope,
    createdDirectoryVersion: String(input.directoryVersion),
    directoryVersion: String(input.directoryVersion),
    serverObservedAt: "500",
  });
}

function acceptedRemoteHeadAt(
  base: Awaited<ReturnType<typeof acceptedRemoteHead>>,
  index: number,
) {
  const directoryCoordinate = epoch(index);
  return acceptedSessionHeadSchema.parse({
    ...base,
    envelope: {
      ...base.envelope,
      header: {
        ...base.envelope.header,
        sessionId: indexedSession(index),
        directoryOrdinal: directoryCoordinate,
      },
    },
    createdDirectoryVersion: directoryCoordinate,
    directoryVersion: directoryCoordinate,
  });
}

describe("encrypted session-sync SQLite store", () => {
  test("persists exact human authority with the vault and rejects account replacement", async () => {
    const fixture = await activeFixture();
    try {
      expect(fixture.store.vault()?.humanAuthority).toEqual(humanAuthority);
      expect(() => fixture.store.replaceVault({
        expectedRevision: fixture.store.vault()?.revision ?? null,
        head: fixture.head,
        wrappedRoot: fixture.wrappedRoot,
        humanAuthority: {
          userId: "user_attacker",
          organizationId: humanAuthority.organizationId,
        },
        now: 104,
      })).toThrow("another human scope");
      expect(fixture.store.vault()?.humanAuthority).toEqual(humanAuthority);

      fixture.database.query(`
        UPDATE session_sync_vault_state
        SET human_user_id = NULL, human_organization_id = NULL
        WHERE singleton = 1
      `).run();
      expect(fixture.store.vault()?.humanAuthority).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  test("keeps local panes authoritative and persists only a redacted encrypted intent", async () => {
    const fixture = await activeFixture();
    try {
      bindOne(fixture);
      expect(fixture.store.localGridSlots()).toEqual([
        { paneId: "pane_000", gridPosition: 0 },
      ]);
      const { dirty, sealed } = await sealDirty(fixture);

      expect(dirty.title).toBe(
        "Inspect [local path] without leaking it",
      );
      expect(dirty.repositoryDisplayName).toBe("repository");
      expect(JSON.stringify(dirty)).not.toContain("/Users/alice");
      expect(fixture.store.storeSealedLocalIntent({
        paneId: dirty.paneId,
        expectedSourceRevision: Number(dirty.sourceRevision),
        barrier: dirty.barrier,
        sealed,
        now: 201,
      })).toBeTrue();

      const stored = fixture.database.query(`
        SELECT sealed_intent_json FROM session_sync_outbox_intents
      `).get() as { sealed_intent_json: string };
      expect(stored.sealed_intent_json).not.toContain(dirty.title);
      expect(stored.sealed_intent_json).not.toContain("repository");
      expect(stored.sealed_intent_json).not.toContain("/Users/alice");
      expect(fixture.store.outbox()).toHaveLength(1);
    } finally {
      fixture.database.close();
    }
  });

  test("coalesces replaceable activity while retaining semantic barriers", async () => {
    const fixture = await activeFixture();
    try {
      bindOne(fixture);
      const created = await sealDirty(fixture);
      fixture.store.storeSealedLocalIntent({
        paneId: created.dirty.paneId,
        expectedSourceRevision: 1,
        barrier: true,
        sealed: created.sealed,
        now: 201,
      });

      for (const [revision, state] of [[2, "streaming"], [3, "continuing"]] as const) {
        fixture.database.query(`
          UPDATE chat_panes SET revision = ?1, state = ?2,
            activity_kind = 'model_output' WHERE pane_id = 'pane_000'
        `).run(revision, state);
        const next = await sealDirty(fixture);
        expect(next.dirty.barrier).toBeFalse();
        fixture.store.storeSealedLocalIntent({
          paneId: next.dirty.paneId,
          expectedSourceRevision: revision,
          barrier: false,
          sealed: next.sealed,
          now: 200 + revision,
        });
      }
      expect(fixture.store.outbox().map(({ sourceRevision }) => sourceRevision))
        .toEqual([1, 3]);

      fixture.database.query(`
        UPDATE chat_panes SET revision = 4, state = 'attention',
          attention_code = 'needs_input' WHERE pane_id = 'pane_000'
      `).run();
      const attention = await sealDirty(fixture);
      expect(attention.dirty.barrier).toBeTrue();
      fixture.store.storeSealedLocalIntent({
        paneId: attention.dirty.paneId,
        expectedSourceRevision: 4,
        barrier: true,
        sealed: attention.sealed,
        now: 204,
      });
      expect(fixture.store.outbox().map(({ sourceRevision, barrier }) => ({
        sourceRevision,
        barrier,
      }))).toEqual([
        { sourceRevision: 1, barrier: true },
        { sourceRevision: 4, barrier: true },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  test("persists nonce allocation and attempted ciphertext before network delivery", async () => {
    const fixture = await activeFixture();
    try {
      const sessionId = bindOne(fixture);
      fixture.store.recordSessionReservation({
        paneId: "pane_000",
        expectedSessionId: sessionId,
        creationGrantDigest: digest("a"),
        now: 200,
      });
      const created = await sealDirty(fixture);
      fixture.store.storeSealedLocalIntent({
        paneId: created.dirty.paneId,
        expectedSourceRevision: 1,
        barrier: true,
        sealed: created.sealed,
        now: 201,
      });
      const bootId = syncBootIdSchema.parse(opaque("syncboot", "b"));
      fixture.store.upsertLocalHead({
        sessionId,
        directoryOrdinal: epoch(1),
        mirrorEpoch: epoch(1),
        writerGeneration: epoch(1),
        bootId,
        bootGeneration: epoch(1),
        membershipEpoch: epoch(1),
        keyEpoch: epoch(1),
        acknowledgedSequence: uint64(0),
        acknowledgedDigest: null,
        acknowledgedSourceRevision: 0,
        now: 202,
      });
      const prepared = fixture.store.prepareAttempt(sessionId);
      if (prepared === null) throw new Error("missing prepared attempt");
      const contentKey = await deriveSessionContentKey(fixture.rootKey, {
        version: 1,
        ...fixture.vault,
        sessionId,
        keyEpoch: epoch(1),
        originDeviceId: fixture.deviceId,
        mirrorEpoch: epoch(1),
        writerGeneration: epoch(1),
      }, ["encrypt"]);
      const header = sessionSyncHeaderSchema.parse({
        protocol: SESSION_SYNC_PROTOCOL,
        payloadVersion: 1,
        payloadKind: "session_summary",
        ...fixture.vault,
        membershipEpoch: "1",
        originDeviceId: fixture.deviceId,
        sessionId,
        mirrorEpoch: "1",
        writerGeneration: "1",
        bootId,
        bootGeneration: "1",
        directoryOrdinal: "1",
        keyEpoch: "1",
        syncSequence: prepared.nonce.sequence,
        sourceRevision: created.dirty.sourceRevision,
        eventKind: "created",
        previousDigest: null,
        creationGrantDigest: `sha256_${"a".repeat(64)}`,
      });
      const envelope = await sealSessionSummary(
        sessionSummarySchema.parse({
          version: 1,
          sessionId,
          ownerDeviceId: fixture.deviceId,
          directoryOrdinal: "1",
          sourceRevision: created.dirty.sourceRevision,
          title: created.dirty.title,
          repositoryDisplayName: created.dirty.repositoryDisplayName,
          state: created.dirty.state,
          deleted: false,
        }),
        header,
        contentKey,
        prepared.nonce,
      );
      fixture.store.recordAttempt({ expected: prepared, envelope, now: 203 });

      const restarted = new SessionSyncStore(fixture.database);
      const replay = restarted.attempt(sessionId);
      if (replay === null) throw new Error("missing persisted replay attempt");
      expect(replay.envelope).toEqual(envelope);
      expect(restarted.publicationWork(sessionId)).toEqual({
        kind: "replay",
        attempt: replay,
      });
      expect(restarted.prepareAttempt(sessionId)).toBeNull();
      expect(() => restarted.recordAttempt({
        expected: prepared,
        envelope,
        now: 204,
      })).toThrow("changed before attempt");
      expect(restarted.settleAccepted({
        accepted: acceptedSessionHeadSchema.parse({
          envelope,
          createdDirectoryVersion: "1",
          directoryVersion: "1",
          serverObservedAt: "204",
        }),
        now: 205,
      })).toBeTrue();
      expect(restarted.attempt(sessionId)).toBeNull();
      expect(restarted.outbox()).toEqual([]);
      expect(restarted.localHead(sessionId)).toMatchObject({
        acknowledgedSequence: "1",
        acknowledgedDigest: envelope.ciphertextDigest,
        syncState: "idle",
      });
      expect(restarted.paneBinding("pane_000")?.state).toBe("accepted");
    } finally {
      fixture.database.close();
    }
  });

  test("definitively expired pending grants retire only sync identity and rebind the same pane", async () => {
    const fixture = await activeFixture();
    try {
      const oldSessionId = bindOne(fixture);
      const oldGrant = digest("1");
      const nextSessionId = session("n");
      const nextGrant = digest("2");
      fixture.store.recordSessionReservation({
        paneId: "pane_000",
        expectedSessionId: oldSessionId,
        creationGrantDigest: oldGrant,
        now: 201,
      });
      const sealed = await sealDirty(fixture);
      expect(fixture.store.storeSealedLocalIntent({
        paneId: "pane_000",
        expectedSourceRevision: 1,
        barrier: true,
        sealed: sealed.sealed,
        now: 202,
      })).toBeTrue();
      fixture.store.upsertLocalHead({
        sessionId: oldSessionId,
        directoryOrdinal: null,
        mirrorEpoch: epoch(1),
        writerGeneration: uint64(0),
        bootId: syncBootIdSchema.parse(opaque("syncboot", "b")),
        bootGeneration: epoch(1),
        membershipEpoch: epoch(1),
        keyEpoch: epoch(1),
        acknowledgedSequence: uint64(0),
        acknowledgedDigest: null,
        acknowledgedSourceRevision: 0,
        now: 203,
      });
      const paneBefore = fixture.database.query(`
        SELECT * FROM chat_panes WHERE pane_id = 'pane_000'
      `).get();

      const rebound = fixture.store.rebindExpiredPendingSession({
        paneId: "pane_000",
        expectedSessionId: oldSessionId,
        expectedCreationGrantDigest: oldGrant,
        nextSessionId,
        nextCreationGrantDigest: nextGrant,
        reason: "grant_expired",
        now: 120_204,
      });
      expect(rebound).toMatchObject({
        paneId: "pane_000",
        sessionId: nextSessionId,
        creationGrantDigest: nextGrant,
        state: "pending",
      });
      expect(fixture.store.retiredPaneBinding(oldSessionId)).toMatchObject({
        retiredSessionId: oldSessionId,
        paneId: "pane_000",
        creationGrantDigest: oldGrant,
        reason: "grant_expired",
      });
      expect(fixture.store.outbox()).toEqual([]);
      expect(fixture.store.localHead(oldSessionId)).toBeNull();
      expect(fixture.database.query(`
        SELECT * FROM chat_panes WHERE pane_id = 'pane_000'
      `).get()).toEqual(paneBefore);
      expect(fixture.store.listDirtyLocalIntents()).toEqual([
        expect.objectContaining({
          paneId: "pane_000",
          sessionId: nextSessionId,
          sourceRevision: "1",
        }),
      ]);

      const restarted = new SessionSyncStore(fixture.database);
      expect(restarted.rebindExpiredPendingSession({
        paneId: "pane_000",
        expectedSessionId: oldSessionId,
        expectedCreationGrantDigest: oldGrant,
        nextSessionId,
        nextCreationGrantDigest: nextGrant,
        reason: "grant_expired",
        now: 120_205,
      })).toEqual(rebound);
    } finally {
      fixture.database.close();
    }
  });

  test("an accepted session identity can never take the reservation rebind exception", async () => {
    const fixture = await activeFixture();
    try {
      const sessionId = bindOne(fixture);
      const grant = digest("3");
      fixture.store.recordSessionReservation({
        paneId: "pane_000",
        expectedSessionId: sessionId,
        creationGrantDigest: grant,
        now: 201,
      });
      expect(fixture.store.markSessionBindingAccepted({
        sessionId,
        creationGrantDigest: grant,
      })).toBeTrue();
      expect(() => fixture.store.rebindExpiredPendingSession({
        paneId: "pane_000",
        expectedSessionId: sessionId,
        expectedCreationGrantDigest: grant,
        nextSessionId: session("x"),
        nextCreationGrantDigest: digest("4"),
        reason: "retired",
        now: 300,
      })).toThrow("accepted session identity");
      expect(fixture.store.retiredPaneBinding(sessionId)).toBeNull();
      expect(() => fixture.database.query(`
        UPDATE session_sync_pane_bindings
        SET binding_state = 'pending' WHERE pane_id = 'pane_000'
      `).run()).toThrow("cannot become pending");
      expect(() => fixture.database.query(`
        UPDATE session_sync_pane_bindings
        SET creation_grant_digest = ?1 WHERE pane_id = 'pane_000'
      `).run(`sha256_${"9".repeat(64)}`)).toThrow("creation grant is immutable");
    } finally {
      fixture.database.close();
    }
  });

  test("admits a deterministic bounded prefix and reports excess local panes", async () => {
    const fixture = await activeFixture({ paneCount: 65 });
    try {
      let sequence = 0;
      const admission = fixture.store.bindEligibleLocalPanes({
        vault: fixture.vault,
        deviceId: fixture.deviceId,
        now: 200,
        nextSessionId: () => indexedSession(++sequence),
      });
      expect(admission).toMatchObject({
        status: "capacity_reached",
        bindingCount: 64,
        skippedPaneCount: 1,
      });
      expect(admission.addedSessionIds).toHaveLength(64);
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_pane_bindings
      `).get() as { count: number }).count).toBe(64);
      expect(fixture.store.paneBinding("pane_063")).not.toBeNull();
      expect(fixture.store.paneBinding("pane_064")).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  test("retains an archived accepted identity and skips later panes deterministically at capacity", async () => {
    const fixture = await activeFixture({ paneCount: 64 });
    try {
      let sequence = 0;
      expect(fixture.store.bindEligibleLocalPanes({
        vault: fixture.vault,
        deviceId: fixture.deviceId,
        now: 200,
        nextSessionId: () => indexedSession(++sequence),
      })).toMatchObject({
        status: "admitted",
        bindingCount: 64,
      });
      const archived = fixture.store.paneBinding("pane_000");
      if (archived === null) throw new Error("missing archived binding fixture");
      const creationGrantDigest = digest("a");
      fixture.store.recordSessionReservation({
        paneId: archived.paneId,
        expectedSessionId: archived.sessionId,
        creationGrantDigest,
        now: 201,
      });
      expect(fixture.store.markSessionBindingAccepted({
        sessionId: archived.sessionId,
        creationGrantDigest,
      })).toBeTrue();
      fixture.database.query(`
        UPDATE chat_panes
        SET revision = revision + 1, archived_at = '2026-08-09T00:00:00.000Z'
        WHERE pane_id = 'pane_000'
      `).run();
      insertPane(fixture.database, "pane_newer", 65);
      insertPane(fixture.database, "pane_newest", 65);

      let generatedAfterCapacity = false;
      const atCapacity = fixture.store.bindEligibleLocalPanes({
        vault: fixture.vault,
        deviceId: fixture.deviceId,
        now: 202,
        nextSessionId: () => {
          generatedAfterCapacity = true;
          return indexedSession(65);
        },
      });
      expect(atCapacity).toEqual({
        status: "capacity_reached",
        bindingCount: 64,
        addedSessionIds: [],
        skippedPaneCount: 2,
      });
      expect(generatedAfterCapacity).toBeFalse();
      expect(fixture.store.localGridSlots()).toHaveLength(64);
      expect(fixture.store.paneBinding("pane_newer")).toBeNull();
      expect(fixture.store.paneBinding("pane_newest")).toBeNull();
      expect(fixture.store.paneBinding("pane_000")).toMatchObject({
        sessionId: archived.sessionId,
        state: "accepted",
      });
      expect(fixture.store.retiredPaneBinding(archived.sessionId)).toBeNull();
      expect(fixture.store.listDirtyLocalIntents().find(
        ({ paneId }) => paneId === "pane_000",
      )).toMatchObject({ eventKind: "archived", deleted: false });

      fixture.database.query(`
        UPDATE chat_panes SET created_at = CASE pane_id
          WHEN 'pane_newer' THEN 66 ELSE 64 END
        WHERE pane_id IN ('pane_newer', 'pane_newest')
      `).run();
      const restarted = new SessionSyncStore(fixture.database);
      expect(restarted.bindEligibleLocalPanes({
        vault: fixture.vault,
        deviceId: fixture.deviceId,
        now: 203,
        nextSessionId: () => {
          throw new Error("A restart must not allocate beyond retained capacity.");
        },
      })).toEqual(atCapacity);
      expect(restarted.paneBinding("pane_000")?.sessionId).toBe(archived.sessionId);
      expect(restarted.retiredPaneBinding(archived.sessionId)).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  test("detects local grid and dirty-intent overflow instead of truncating at 64", async () => {
    const fixture = await activeFixture({ paneCount: 65 });
    try {
      const insertPosition = fixture.database.query(`
        INSERT INTO session_sync_grid_positions(
          session_id, grid_position, origin, discovered_at
        ) VALUES (?1, ?2, 'local', 200)
      `);
      const insertBinding = fixture.database.query(`
        INSERT INTO session_sync_pane_bindings(
          pane_id, session_id, tenant_id, organization_id, owner_user_id,
          vault_id, vault_generation, origin_device_id, included, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 200)
      `);
      const insertDirty = fixture.database.query(`
        INSERT INTO session_sync_dirty_panes(
          pane_id, source_revision, event_kind, barrier, marked_at
        ) VALUES (?1, 1, 'created', 1, 200)
      `);
      fixture.database.transaction(() => {
        for (let index = 0; index < 65; index += 1) {
          const paneId = `pane_${String(index).padStart(3, "0")}`;
          const sessionId = indexedSession(index + 1);
          insertPosition.run(sessionId, index);
          insertBinding.run(
            paneId,
            sessionId,
            fixture.vault.tenantId,
            fixture.vault.organizationId,
            fixture.vault.ownerUserId,
            fixture.vault.vaultId,
            fixture.vault.vaultGeneration,
            fixture.deviceId,
          );
          insertDirty.run(paneId);
        }
      })();

      expect(() => fixture.store.localGridSlots()).toThrow(
        "grid exceeds its declared limit",
      );
      expect(() => fixture.store.listDirtyLocalIntents()).toThrow(
        "intents exceed their declared limit",
      );
    } finally {
      fixture.database.close();
    }
  });

  test("uses all 512 grid slots and fails before allocating a 513th", async () => {
    const fixture = await activeFixture();
    try {
      const insert = fixture.database.query(`
        INSERT INTO session_sync_grid_positions(
          session_id, grid_position, origin, discovered_at
        ) VALUES (?1, ?2, 'remote', 200)
      `);
      fixture.database.transaction(() => {
        for (let index = 0; index < MAX_SYNC_DIRECTORY_SESSIONS; index += 1) {
          insert.run(indexedSession(index + 1), index);
        }
      })();
      const remoteDeviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "g"));
      const accepted = await acceptedRemoteHead({
        fixture,
        sessionId: session("g"),
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const snapshotId = `syncsnapshot_${"w".repeat(32)}`;
      const revision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId,
        snapshotVersion: epoch(1),
        now: 201,
      });

      expect(() => fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(1),
          entries: [{ kind: "head", accepted }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 202,
      })).toThrow("grid reached its limit");
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_grid_positions
      `).get() as { count: number }).count).toBe(MAX_SYNC_DIRECTORY_SESSIONS);
      expect(fixture.store.directoryCursor()).toMatchObject({
        revision,
        mode: "snapshot",
      });
    } finally {
      fixture.database.close();
    }
  });

  test("replaces only this session's activity when the encrypted outbox is full", async () => {
    const fixture = await activeFixture();
    try {
      const localSessionId = bindOne(fixture);
      const initial = await sealDirty(fixture);
      expect(fixture.store.storeSealedLocalIntent({
        paneId: initial.dirty.paneId,
        expectedSourceRevision: 1,
        barrier: false,
        sealed: initial.sealed,
        now: 201,
      })).toBeTrue();
      const fillerSessionId = session("f");
      fixture.database.query(`
        INSERT INTO session_sync_grid_positions(
          session_id, grid_position, origin, discovered_at
        ) VALUES (?1, 1, 'local', 202)
      `).run(fillerSessionId);
      const insert = fixture.database.query(`
        INSERT INTO session_sync_outbox_intents(
          session_id, source_revision, event_kind, barrier,
          sealed_intent_json, ciphertext_digest, ciphertext_bytes, created_at
        ) VALUES (?1, ?2, 'activity', 1, ?3, ?4, ?5, 202)
      `);
      fixture.database.transaction(() => {
        for (let revision = 1; revision < 4_096; revision += 1) {
          insert.run(
            fillerSessionId,
            revision,
            JSON.stringify(initial.sealed),
            initial.sealed.ciphertextDigest,
            initial.sealed.ciphertextBytes,
          );
        }
      })();
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_outbox_intents
      `).get() as { count: number }).count).toBe(4_096);

      fixture.database.query(`
        UPDATE chat_panes SET revision = 2, state = 'streaming',
          activity_kind = 'model_output' WHERE pane_id = 'pane_000'
      `).run();
      const replacement = await sealDirty(fixture);
      expect(fixture.store.storeSealedLocalIntent({
        paneId: replacement.dirty.paneId,
        expectedSourceRevision: 2,
        barrier: false,
        sealed: replacement.sealed,
        now: 203,
      })).toBeTrue();
      expect(fixture.database.query(`
        SELECT source_revision FROM session_sync_outbox_intents
        WHERE session_id = ?1 AND barrier = 0
      `).get(localSessionId)).toEqual({ source_revision: 2 });

      fixture.database.query(`
        UPDATE session_sync_outbox_intents SET session_id = ?1
        WHERE session_id = ?2 AND barrier = 0
      `).run(fillerSessionId, localSessionId);
      fixture.database.query(`
        UPDATE chat_panes SET revision = 3, state = 'continuing'
        WHERE pane_id = 'pane_000'
      `).run();
      const unrelated = await sealDirty(fixture);
      expect(() => fixture.store.storeSealedLocalIntent({
        paneId: unrelated.dirty.paneId,
        expectedSourceRevision: 3,
        barrier: false,
        sealed: unrelated.sealed,
        now: 204,
      })).toThrow("reached its limit");
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_outbox_intents
      `).get() as { count: number }).count).toBe(4_096);
    } finally {
      fixture.database.close();
    }
  });

  test("installs pinned snapshots atomically, filters own echoes, and fences stale pages", async () => {
    const fixture = await activeFixture();
    try {
      const remoteDeviceId = syncDeviceIdSchema.parse(
        opaque("syncdevice", "r"),
      );
      const remoteSessionId = session("r");
      const ownEchoSessionId = session("e");
      const remote = await acceptedRemoteHead({
        fixture,
        sessionId: remoteSessionId,
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const ownEcho = await acceptedRemoteHead({
        fixture,
        sessionId: ownEchoSessionId,
        originDeviceId: fixture.deviceId,
        directoryOrdinal: 2,
        directoryVersion: 2,
      });
      const revision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId: `syncsnapshot_${"a".repeat(32)}`,
        snapshotVersion: epoch(2),
        now: 501,
      });
      expect(fixture.store.installSnapshotPage({
        snapshotId: `syncsnapshot_${"a".repeat(32)}`,
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          entries: [{ kind: "head", accepted: remote }],
          complete: false,
          nextCursor: {
            directoryOrdinal: epoch(1),
            sessionId: remoteSessionId,
          },
        },
        localDeviceId: fixture.deviceId,
        now: 502,
      })).toEqual({ complete: false, cursorRevision: revision + 1 });
      expect(fixture.store.remoteRecords(fixture.deviceId)).toEqual([]);

      expect(() => fixture.store.installSnapshotPage({
        snapshotId: `syncsnapshot_${"a".repeat(32)}`,
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          after: {
            directoryOrdinal: epoch(1),
            sessionId: remoteSessionId,
          },
          entries: [{ kind: "head", accepted: ownEcho }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 503,
      })).toThrow("stale");
      expect(fixture.store.remoteRecords(fixture.deviceId)).toEqual([]);

      expect(fixture.store.installSnapshotPage({
        snapshotId: `syncsnapshot_${"a".repeat(32)}`,
        expectedCursorRevision: revision + 1,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          after: {
            directoryOrdinal: epoch(1),
            sessionId: remoteSessionId,
          },
          entries: [{ kind: "head", accepted: ownEcho }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 504,
      })).toEqual({ complete: true, cursorRevision: revision + 2 });
      expect(fixture.store.remoteRecords(fixture.deviceId)).toMatchObject([{
        sessionId: remoteSessionId,
        originDeviceId: remoteDeviceId,
        recordKind: "head",
      }]);

      expect(() => fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId: `syncsnapshot_${"b".repeat(32)}`,
        snapshotVersion: epoch(1),
        now: 505,
      })).toThrow("stale scope");
      const foreignVault = syncVaultCoordinateSchema.parse({
        ...fixture.vault,
        vaultId: opaque("syncvault", "x"),
      });
      expect(() => fixture.store.applyChangePage({
        expectedCursorRevision: revision + 2,
        page: {
          version: 1,
          vault: foreignVault,
          afterVersion: uint64(2),
          changes: [],
          nextVersion: uint64(2),
          hasMore: false,
        },
        localDeviceId: fixture.deviceId,
        now: 506,
      })).toThrow("stale");
      expect(fixture.store.remoteRecords(fixture.deviceId)).toHaveLength(1);
    } finally {
      fixture.database.close();
    }
  });

  test("rejects a cross-page duplicate identity and preserves the pinned cursor until exact completion", async () => {
    const fixture = await activeFixture();
    try {
      const remoteDeviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "r"));
      const remoteSessionId = session("d");
      const accepted = await acceptedRemoteHead({
        fixture,
        sessionId: remoteSessionId,
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const snapshotId = `syncsnapshot_${"u".repeat(32)}`;
      const revision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId,
        snapshotVersion: epoch(2),
        now: 550,
      });
      const cursor = { directoryOrdinal: epoch(1), sessionId: remoteSessionId };
      const first = fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          entries: [{ kind: "head", accepted }],
          complete: false,
          nextCursor: cursor,
        },
        localDeviceId: fixture.deviceId,
        now: 551,
      });
      const duplicate = acceptedSessionHeadSchema.parse({
        ...accepted,
        envelope: {
          ...accepted.envelope,
          header: { ...accepted.envelope.header, directoryOrdinal: epoch(2) },
        },
        directoryVersion: epoch(2),
      });

      expect(() => fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: first.cursorRevision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          after: cursor,
          entries: [{ kind: "head", accepted: duplicate }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 552,
      })).toThrow("duplicate session identity");
      expect(fixture.store.directoryCursor()).toMatchObject({
        revision: first.cursorRevision,
        mode: "snapshot",
        snapshotCursor: cursor,
      });
      expect(fixture.database.query(`
        SELECT directory_ordinal, record_json
        FROM session_sync_snapshot_entries WHERE session_id = ?1
      `).get(remoteSessionId)).toEqual({
        directory_ordinal: epoch(1),
        record_json: canonicalSessionSyncJson({ kind: "upsert", accepted }),
      });

      expect(fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: first.cursorRevision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          after: cursor,
          entries: [],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 553,
      })).toEqual({ complete: true, cursorRevision: first.cursorRevision + 1 });
      expect(fixture.store.remoteRecords(fixture.deviceId)).toMatchObject([{
        sessionId: remoteSessionId,
        directoryOrdinal: epoch(1),
      }]);
    } finally {
      fixture.database.close();
    }
  });

  test("incremental mirror reset equals its offline snapshot and retains the decryptable head", async () => {
    const fixture = await activeFixture();
    try {
      beginEmptyChangeStream(fixture, 558);
      const remoteDeviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "m"));
      const remoteSessionId = session("m");
      const accepted = await acceptedRemoteHead({
        fixture,
        sessionId: remoteSessionId,
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const reset = {
        kind: "mirror_reset" as const,
        ...fixture.vault,
        sessionId: remoteSessionId,
        directoryOrdinal: epoch(1),
        directoryVersion: epoch(2),
        mirrorEpoch: epoch(2),
        resetDigest: accepted.envelope.ciphertextDigest,
      };
      let revision = fixture.store.applyChangePage({
        expectedCursorRevision: fixture.store.directoryCursor().revision,
        page: {
          version: 1,
          vault: fixture.vault,
          afterVersion: uint64(0),
          changes: [{ kind: "upsert", accepted }],
          nextVersion: uint64(1),
          hasMore: false,
        },
        localDeviceId: fixture.deviceId,
        now: 560,
      });
      revision = fixture.store.applyChangePage({
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          afterVersion: uint64(1),
          changes: [reset],
          nextVersion: uint64(2),
          hasMore: false,
        },
        localDeviceId: fixture.deviceId,
        now: 561,
      });
      const incremental = fixture.store.remoteRecords(fixture.deviceId)[0];
      expect(incremental).toMatchObject({
        recordKind: "head",
        directoryVersion: epoch(2),
        mirrorEpoch: epoch(2),
        ciphertextDigest: accepted.envelope.ciphertextDigest,
        record: { kind: "offline", accepted, reset },
      });
      const contentKey = await deriveSessionContentKey(fixture.rootKey, {
        version: 1,
        ...fixture.vault,
        sessionId: remoteSessionId,
        keyEpoch: accepted.envelope.header.keyEpoch,
        originDeviceId: remoteDeviceId,
        mirrorEpoch: accepted.envelope.header.mirrorEpoch,
        writerGeneration: accepted.envelope.header.writerGeneration,
      }, ["decrypt"]);
      expect(await openSessionSummary(
        accepted.envelope,
        accepted.envelope.header,
        contentKey,
      )).toMatchObject({ title: "Remote summary", state: "ready" });

      fixture.store.clearRemoteForScopeChange(562);
      const snapshotId = `syncsnapshot_${"v".repeat(32)}`;
      const snapshotRevision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId,
        snapshotVersion: epoch(2),
        now: 563,
      });
      fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: snapshotRevision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          entries: [{ kind: "offline", accepted, reset }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 564,
      });
      const snapshot = fixture.store.remoteRecords(fixture.deviceId)[0];
      expect({ ...snapshot, installedAt: 0 }).toEqual({
        ...incremental,
        installedAt: 0,
      });

      fixture.database.query(`
        UPDATE session_sync_directory_cursor
        SET change_version = '0', mode = 'changes', snapshot_id = NULL,
          snapshot_version = NULL, snapshot_cursor_json = NULL
        WHERE singleton = 1
      `).run();
      fixture.store.applyChangePage({
        expectedCursorRevision: fixture.store.directoryCursor().revision,
        page: {
          version: 1,
          vault: fixture.vault,
          afterVersion: uint64(0),
          changes: [{ kind: "upsert", accepted }],
          nextVersion: uint64(1),
          hasMore: false,
        },
        localDeviceId: fixture.deviceId,
        now: 565,
      });
      expect(fixture.store.remoteRecords(fixture.deviceId)[0]).toMatchObject({
        directoryVersion: epoch(2),
        mirrorEpoch: epoch(2),
        record: { kind: "offline" },
      });
      expect(revision).toBeGreaterThan(0);
    } finally {
      fixture.database.close();
    }
  });

  test("equal directory versions require exact replay and reset without a head forces snapshot", async () => {
    const fixture = await activeFixture();
    try {
      beginEmptyChangeStream(fixture, 568);
      const remoteDeviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "x"));
      const remoteSessionId = session("x");
      const accepted = await acceptedRemoteHead({
        fixture,
        sessionId: remoteSessionId,
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const applyVersionOne = (head: typeof accepted, now: number) =>
        fixture.store.applyChangePage({
          expectedCursorRevision: fixture.store.directoryCursor().revision,
          page: {
            version: 1,
            vault: fixture.vault,
            afterVersion: uint64(0),
            changes: [{ kind: "upsert", accepted: head }],
            nextVersion: uint64(1),
            hasMore: false,
          },
          localDeviceId: fixture.deviceId,
          now,
        });
      applyVersionOne(accepted, 570);
      const first = fixture.store.remoteRecords(fixture.deviceId)[0];
      fixture.database.query(`
        UPDATE session_sync_directory_cursor SET change_version = '0'
        WHERE singleton = 1
      `).run();
      applyVersionOne(accepted, 571);
      expect(fixture.store.remoteRecords(fixture.deviceId)[0]).toEqual(first);

      const drifted = acceptedSessionHeadSchema.parse({
        ...accepted,
        envelope: { ...accepted.envelope, ciphertextDigest: digest("f") },
      });
      fixture.database.query(`
        UPDATE session_sync_directory_cursor SET change_version = '0'
        WHERE singleton = 1
      `).run();
      expect(() => applyVersionOne(drifted, 572)).toThrow("exact replays");
      expect(fixture.store.remoteRecords(fixture.deviceId)[0]).toEqual(first);

      fixture.store.clearRemoteForScopeChange(573);
      beginEmptyChangeStream(fixture, 573);
      expect(() => fixture.store.applyChangePage({
        expectedCursorRevision: fixture.store.directoryCursor().revision,
        page: {
          version: 1,
          vault: fixture.vault,
          afterVersion: uint64(0),
          changes: [{
            kind: "mirror_reset",
            ...fixture.vault,
            sessionId: remoteSessionId,
            directoryOrdinal: epoch(1),
            directoryVersion: epoch(1),
            mirrorEpoch: epoch(2),
            resetDigest: accepted.envelope.ciphertextDigest,
          }],
          nextVersion: uint64(1),
          hasMore: false,
        },
        localDeviceId: fixture.deviceId,
        now: 574,
      })).toThrow("requires a fresh pinned snapshot");
      expect(fixture.store.directoryCursor().changeVersion).toBe(uint64(0));
    } finally {
      fixture.database.close();
    }
  });

  test("bounds snapshot staging across pages and rolls back the overflowing page", async () => {
    const fixture = await activeFixture();
    try {
      const remoteDeviceId = syncDeviceIdSchema.parse(
        opaque("syncdevice", "r"),
      );
      const base = await acceptedRemoteHead({
        fixture,
        sessionId: indexedSession(1),
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const entries = Array.from(
        { length: MAX_SYNC_DIRECTORY_SESSIONS + 1 },
        (_, offset) => ({
          kind: "head" as const,
          accepted: acceptedRemoteHeadAt(base, offset + 1),
        }),
      );
      const snapshotId = `syncsnapshot_${"c".repeat(32)}`;
      let revision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId,
        snapshotVersion: epoch(MAX_SYNC_DIRECTORY_SESSIONS + 1),
        now: 600,
      });
      let after: { directoryOrdinal: ReturnType<typeof epoch>; sessionId: ReturnType<typeof indexedSession> } | undefined;
      for (
        let offset = 0;
        offset < MAX_SYNC_DIRECTORY_SESSIONS;
        offset += MAX_SYNC_DIRECTORY_PAGE_SIZE
      ) {
        const pageEntries = entries.slice(
          offset,
          Math.min(
            offset + MAX_SYNC_DIRECTORY_PAGE_SIZE,
            MAX_SYNC_DIRECTORY_SESSIONS,
          ),
        );
        const last = pageEntries.at(-1);
        if (last === undefined) throw new Error("missing snapshot page fixture");
        const nextCursor = {
          directoryOrdinal: last.accepted.envelope.header.directoryOrdinal,
          sessionId: last.accepted.envelope.header.sessionId,
        };
        const installed = fixture.store.installSnapshotPage({
          snapshotId,
          expectedCursorRevision: revision,
          page: {
            version: 1,
            vault: fixture.vault,
            snapshotVersion: epoch(MAX_SYNC_DIRECTORY_SESSIONS + 1),
            ...(after === undefined ? {} : { after }),
            entries: pageEntries,
            complete: false,
            nextCursor,
          },
          localDeviceId: fixture.deviceId,
          now: 601 + offset,
        });
        revision = installed.cursorRevision;
        after = nextCursor;
      }
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_snapshot_entries
      `).get() as { count: number }).count).toBe(
        MAX_SYNC_DIRECTORY_SESSIONS,
      );

      const overflow = entries[MAX_SYNC_DIRECTORY_SESSIONS];
      if (overflow === undefined || after === undefined) {
        throw new Error("missing overflow fixture");
      }
      expect(() => fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(MAX_SYNC_DIRECTORY_SESSIONS + 1),
          after,
          entries: [overflow],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 700,
      })).toThrow("exceeds the directory limit");
      expect(fixture.store.directoryCursor()).toMatchObject({
        revision,
        mode: "snapshot",
        snapshotCursor: after,
      });
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_snapshot_entries
      `).get() as { count: number }).count).toBe(
        MAX_SYNC_DIRECTORY_SESSIONS,
      );
      expect(fixture.store.remoteRecords(fixture.deviceId)).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  test("releases remote grid positions omitted by a newer complete snapshot", async () => {
    const fixture = await activeFixture();
    try {
      const remoteDeviceId = syncDeviceIdSchema.parse(
        opaque("syncdevice", "r"),
      );
      const accepted = await acceptedRemoteHead({
        fixture,
        sessionId: session("r"),
        originDeviceId: remoteDeviceId,
        directoryOrdinal: 1,
        directoryVersion: 1,
      });
      const firstId = `syncsnapshot_${"d".repeat(32)}`;
      const firstRevision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId: firstId,
        snapshotVersion: epoch(1),
        now: 800,
      });
      fixture.store.installSnapshotPage({
        snapshotId: firstId,
        expectedCursorRevision: firstRevision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(1),
          entries: [{ kind: "head", accepted }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 801,
      });
      expect(fixture.store.remoteRecords(fixture.deviceId)).toHaveLength(1);

      const secondId = `syncsnapshot_${"e".repeat(32)}`;
      const secondRevision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId: secondId,
        snapshotVersion: epoch(2),
        now: 802,
      });
      fixture.store.installSnapshotPage({
        snapshotId: secondId,
        expectedCursorRevision: secondRevision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          entries: [],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 803,
      });
      expect(fixture.store.remoteRecords(fixture.deviceId)).toEqual([]);
      expect((fixture.database.query(`
        SELECT COUNT(*) AS count FROM session_sync_grid_positions
        WHERE origin = 'remote'
      `).get() as { count: number }).count).toBe(0);
    } finally {
      fixture.database.close();
    }
  });

  test("round trips a retired session fence through a complete snapshot", async () => {
    const fixture = await activeFixture();
    try {
      const fence = retiredSessionIdFenceSchema.parse({
        protocol: SESSION_SYNC_PROTOCOL,
        recordKind: "retired_session_id",
        ...fixture.vault,
        sessionId: session("q"),
        directoryOrdinal: "1",
        createdDirectoryVersion: "1",
        retirementDirectoryVersion: "2",
        retiredAt: "900",
        tombstoneDigest: `sha256_${"a".repeat(64)}`,
      });
      const snapshotId = `syncsnapshot_${"g".repeat(32)}`;
      const revision = fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId,
        snapshotVersion: epoch(2),
        now: 900,
      });
      fixture.store.installSnapshotPage({
        snapshotId,
        expectedCursorRevision: revision,
        page: {
          version: 1,
          vault: fixture.vault,
          snapshotVersion: epoch(2),
          entries: [{ kind: "retired", fence }],
          complete: true,
        },
        localDeviceId: fixture.deviceId,
        now: 901,
      });

      expect(fixture.store.remoteRecords(fixture.deviceId)).toEqual([{
        sessionId: fence.sessionId,
        gridPosition: 0,
        recordKind: "retired",
        originDeviceId: null,
        directoryOrdinal: fence.directoryOrdinal,
        directoryVersion: fence.retirementDirectoryVersion,
        mirrorEpoch: uint64(0),
        sourceRevision: uint64(0),
        record: { kind: "retired", fence },
        ciphertextDigest: null,
        installedAt: 901,
      }]);
    } finally {
      fixture.database.close();
    }
  });

  test("clears all vault-scoped state atomically while retaining API clock calibration", async () => {
    const fixture = await activeFixture();
    try {
      bindOne(fixture);
      fixture.store.recordMembershipSignature({
        membershipEpoch: fixture.head.statement.membershipEpoch,
        statementDigest: fixture.head.statementDigest,
        now: 900,
      });
      fixture.store.beginBoot({
        bootId: syncBootIdSchema.parse(opaque("syncboot", "s")),
        now: 901,
      });
      fixture.store.scheduleRetry({
        worker: "observer",
        expectedGeneration: null,
        errorCode: "SERVICE_UNAVAILABLE",
        now: 902,
      });
      const calibration = fixture.store.recordClockCalibration({
        expectedRevision: null,
        serverObservedAt: 10_000,
        clientObservedAt: 9_990,
        uncertaintyMs: 10,
        now: 903,
      });
      fixture.store.beginSnapshot({
        vault: fixture.vault,
        snapshotId: `syncsnapshot_${"f".repeat(32)}`,
        snapshotVersion: epoch(1),
        now: 904,
      });

      const replacementVault = syncVaultCoordinateSchema.parse({
        ...fixture.vault,
        vaultId: opaque("syncvault", "x"),
      });
      const replacement = await createVaultAuthority({
        vault: replacementVault,
        deviceId: fixture.deviceId,
        keys: fixture.keys,
      });
      fixture.store.replaceVault({
        expectedRevision: fixture.store.vault()?.revision ?? null,
        head: replacement.head,
        wrappedRoot: replacement.wrappedRoot,
        humanAuthority,
        now: 905,
      });

      for (const table of [
        "session_sync_signed_membership_epochs",
        "session_sync_boot_state",
        "session_sync_retry_state",
        "session_sync_pane_bindings",
        "session_sync_grid_positions",
        "session_sync_snapshot_entries",
        "session_sync_remote_entries",
      ]) {
        expect((fixture.database.query(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).get() as { count: number }).count).toBe(0);
      }
      expect(fixture.store.directoryCursor()).toMatchObject({
        mode: "idle",
        snapshotId: null,
        changeVersion: "0",
      });
      expect(fixture.store.clockCalibration()).toEqual(calibration);
      expect(fixture.store.vault()?.vault).toEqual(replacementVault);
      expect(fixture.store.device()?.enrollmentState).toBe("active");
      expect(fixture.store.settings().enabled).toBeTrue();
    } finally {
      fixture.database.close();
    }
  });

  test("fails closed when persisted vault authority columns disagree", async () => {
    const corruptions = [
      ["membership_epoch", "2"],
      ["membership_digest", `sha256_${"f".repeat(64)}`],
      ["root_key_epoch", "2"],
      ["vault_id", opaque("syncvault", "z")],
    ] as const;
    for (const [column, value] of corruptions) {
      const fixture = await activeFixture();
      try {
        fixture.database.query(`
          UPDATE session_sync_vault_state SET ${column} = ?1
          WHERE singleton = 1
        `).run(value);
        let error: unknown;
        try {
          fixture.store.vault();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(SessionSyncStoreError);
        expect((error as SessionSyncStoreError).code).toBe("corrupt_state");
      } finally {
        fixture.database.close();
      }
    }
  });

  test("persists server-assigned boot generations and monotonic clock calibration", async () => {
    const fixture = await activeFixture();
    try {
      const bootId = syncBootIdSchema.parse(opaque("syncboot", "b"));
      const competingBootId = syncBootIdSchema.parse(opaque("syncboot", "c"));
      expect(fixture.store.beginBoot({ bootId, now: 1_000 })).toMatchObject({
        bootId,
        bootGeneration: null,
        heartbeatSequence: "1",
        acknowledged: false,
      });
      expect(fixture.store.beginBoot({
        bootId: competingBootId,
        now: 1_001,
      }).bootId).toBe(bootId);
      expect(fixture.store.acknowledgeBoot({
        bootId,
        bootGeneration: epoch(7),
        heartbeatSequence: epoch(2),
        now: 1_002,
      })).toBeFalse();
      expect(fixture.store.acknowledgeBoot({
        bootId,
        bootGeneration: epoch(7),
        heartbeatSequence: epoch(1),
        now: 1_003,
      })).toBeTrue();
      expect(fixture.store.nextHeartbeat({
        bootId,
        bootGeneration: epoch(7),
        now: 1_004,
      })).toMatchObject({
        bootGeneration: "7",
        heartbeatSequence: "2",
        acknowledged: false,
      });

      const initial = fixture.store.recordClockCalibration({
        expectedRevision: null,
        serverObservedAt: 10_000,
        clientObservedAt: 9_900,
        uncertaintyMs: 20,
        now: 1_005,
      });
      expect(initial.revision).toBe(0);
      expect(() => fixture.store.recordClockCalibration({
        expectedRevision: null,
        serverObservedAt: 10_100,
        clientObservedAt: 10_000,
        uncertaintyMs: 20,
        now: 1_006,
      })).toThrow("changed concurrently");
      expect(() => fixture.store.recordClockCalibration({
        expectedRevision: initial.revision,
        serverObservedAt: 9_000,
        clientObservedAt: 10_100,
        uncertaintyMs: 20,
        now: 1_007,
      })).toThrow("cannot move backwards");
      expect(fixture.store.recordClockCalibration({
        expectedRevision: initial.revision,
        serverObservedAt: 9_990,
        clientObservedAt: 10_100,
        uncertaintyMs: 20,
        now: 1_008,
      }).revision).toBe(1);
    } finally {
      fixture.database.close();
    }
  });

  test("uses bounded full jitter and generation-fenced retry settlement", async () => {
    const fixture = await activeFixture();
    try {
      expect(fullJitterSessionSyncDelay(0, () => 0)).toBe(0);
      expect(fullJitterSessionSyncDelay(31, () => 0.999_999)).toBeLessThanOrEqual(
        60_000,
      );
      const retry = fixture.store.scheduleRetry({
        worker: "publisher",
        expectedGeneration: null,
        errorCode: "SERVICE_UNAVAILABLE",
        now: 1_000,
        random: () => 0.5,
      });
      expect(retry).toMatchObject({ attempt: 0, generation: 0 });
      expect(() => fixture.store.scheduleRetry({
        worker: "publisher",
        expectedGeneration: null,
        errorCode: "SERVICE_UNAVAILABLE",
        now: 1_001,
      })).toThrow("changed concurrently");
      expect(fixture.store.clearRetry({
        worker: "publisher",
        expectedGeneration: retry.generation + 1,
      })).toBeFalse();
      expect(fixture.store.clearRetry({
        worker: "publisher",
        expectedGeneration: retry.generation,
      })).toBeTrue();

      const serverBound = fixture.store.scheduleRetry({
        worker: "observer",
        expectedGeneration: null,
        errorCode: "RATE_LIMITED",
        now: 2_000,
        serverRetryAfterMs: 240_000,
        random: () => 0.999_999,
      });
      expect(serverBound.notBefore).toBe(242_000);
      expect(new SessionSyncStore(fixture.database).retry("observer")).toEqual(
        serverBound,
      );

      const capped = fixture.store.scheduleRetry({
        worker: "heartbeat",
        expectedGeneration: null,
        errorCode: "RATE_LIMITED",
        now: 3_000,
        serverRetryAfterMs: MAX_SESSION_SYNC_RETRY_DELAY_MS + 1,
        random: () => 0,
      });
      expect(capped.notBefore).toBe(
        3_000 + MAX_SESSION_SYNC_RETRY_DELAY_MS,
      );
      expect(() => fixture.store.scheduleRetry({
        worker: "enrollment",
        expectedGeneration: null,
        errorCode: "RATE_LIMITED",
        now: 4_000,
        serverRetryAfterMs: -1,
      })).toThrow("Retry-After delay is invalid");
      const secretBearing = fixture.store.scheduleRetry({
        worker: "enrollment",
        expectedGeneration: null,
        errorCode: "provider failed at /Users/private-person/token-secret",
        now: 5_000,
      });
      expect(secretBearing.errorCode).toBe("LOCAL_UNKNOWN");
      expect(fixture.database.query(`
        SELECT error_code FROM session_sync_retry_state
        WHERE worker = 'enrollment'
      `).get()).toEqual({ error_code: "LOCAL_UNKNOWN" });
    } finally {
      fixture.database.close();
    }
  });
});
