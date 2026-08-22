import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  commitSyncVaultRootKey,
  createSyncDeviceKeyPairs,
  createSyncVaultRootKey,
  digestSyncMembershipStatement,
  digestSyncVaultRootWrapManifest,
  generateSyncRecoveryKit,
  signSyncMembershipStatement,
  syncDeviceIdSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncVaultCoordinateSchema,
  syncVaultRootWrapContextSchema,
  wrapSyncVaultRootKey,
} from "@hraness/agent-tasks-protocol";
import { HumanSessionCoordinator } from "@hraness/hra-human-client";

import {
  SessionSyncCoordinator,
  sessionSyncHumanAuthorityMatches,
  type SessionSyncHumanScope,
} from "../src/cloud/session-sync-coordinator";
import {
  SessionSyncRecoveryKeyCustody,
  type SessionSyncKeyCustody,
} from "../src/cloud/session-sync-key-custody";
import {
  SessionSyncBearerClient,
  SessionSyncHttpTransport,
} from "../src/cloud/session-sync-http-client";
import { SessionSyncOperationJournal } from "../src/state/session-sync-operation-journal";
import {
  SessionSyncStore,
  installSessionSyncSchema,
} from "../src/state/session-sync-store";

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

const originalScope: SessionSyncHumanScope = {
  apiOrigin: "https://oprte.example.com",
  signedIn: true,
  credentialGeneration: 7,
  userId: "user_original",
  organizationId: "organization_original",
};

describe("session sync coordinator human-authority fence", () => {
  test("matches exact user and organization while allowing credential refresh", () => {
    const bound = {
      apiOrigin: originalScope.apiOrigin,
      userId: originalScope.userId!,
      organizationId: originalScope.organizationId!,
    };
    expect(sessionSyncHumanAuthorityMatches(bound, originalScope)).toBeTrue();
    expect(sessionSyncHumanAuthorityMatches(bound, {
      ...originalScope,
      credentialGeneration: 8,
    })).toBeTrue();
    expect(sessionSyncHumanAuthorityMatches(bound, {
      ...originalScope,
      userId: "user_attacker",
    })).toBeFalse();
    expect(sessionSyncHumanAuthorityMatches(bound, {
      ...originalScope,
      organizationId: "organization_attacker",
    })).toBeFalse();
    expect(sessionSyncHumanAuthorityMatches(bound, {
      ...originalScope,
      apiOrigin: null,
      signedIn: false,
      userId: null,
      organizationId: null,
    })).toBeFalse();
    expect(sessionSyncHumanAuthorityMatches(null, originalScope)).toBeFalse();
  });

  test("never loads or acknowledges a prior account's recovery kit", async () => {
    const database = createDatabase();
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
      credentialGeneration: originalScope.credentialGeneration,
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
        apiOrigin: originalScope.apiOrigin,
        userId: originalScope.userId!,
        organizationId: originalScope.organizationId!,
      },
      now: 103,
    });

    let scope: SessionSyncHumanScope = originalScope;
    let now = 1_000;
    let loadCount = 0;
    const generatedRecovery = await generateSyncRecoveryKit(
      vault,
      "1",
      "1",
      rootKey.slice(),
    );
    class TestRecoveryCustody extends SessionSyncRecoveryKeyCustody {
      override pendingTransitionMetadata() {
        return Promise.resolve(null);
      }

      override metadata() {
        return Promise.resolve({
          authority: generatedRecovery.authority,
          keyEpochs: generatedRecovery.recoveryKit.vaultRootKeys.map(
            ({ keyEpoch }) => keyEpoch,
          ),
        });
      }

      override loadForExplicitReveal() {
        loadCount += 1;
        return Promise.resolve(structuredClone(generatedRecovery.recoveryKit));
      }
    }
    const recoveryCustody = new TestRecoveryCustody();
    const keyCustody = {
      pendingVaultRootTransitionMetadata: () => Promise.resolve(null),
    } as unknown as SessionSyncKeyCustody;
    const humanSession = new HumanSessionCoordinator({
      store: {
        read: () => Promise.resolve(null),
        compareAndSwap: () => Promise.resolve(null),
        clear: () => Promise.resolve(false),
      },
      refresh: {
        refresh: () => Promise.resolve({
          ok: false,
          outcome: "authentication_failed",
        }),
      },
    });
    const coordinator = new SessionSyncCoordinator({
      store,
      journal: new SessionSyncOperationJournal(database),
      keyCustody,
      recoveryCustody,
      client: new SessionSyncBearerClient({
        session: humanSession,
        transport: new SessionSyncHttpTransport({
          apiUrl: "https://oprte.example.com",
        }),
      }),
      projection: { publish: () => undefined },
      cloudConfigured: true,
      humanScope: () => scope,
      now: () => now,
    });
    const reveal = await coordinator.execute({
      type: "sessionSync.recovery.reveal",
      expectedRevision: 1,
    });
    expect(reveal.type).toBe("sessionSyncRecoveryKit");
    expect(loadCount).toBe(1);

    scope = { ...originalScope, userId: "user_attacker" };
    await coordinator.authenticationChanged();
    expect(coordinator.execute({
      type: "sessionSync.recovery.reveal",
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "authority_mismatch" });
    if (reveal.type !== "sessionSyncRecoveryKit") throw new Error("missing reveal fixture");
    expect(coordinator.execute({
      type: "sessionSync.recoveryKitSavedOffline",
      expectedRevision: 1,
      revealId: reveal.revealId,
    })).rejects.toMatchObject({ code: "authority_mismatch" });
    expect(loadCount).toBe(1);

    scope = originalScope;
    await coordinator.authenticationChanged();
    const expiringReveal = await coordinator.execute({
      type: "sessionSync.recovery.reveal",
      expectedRevision: 1,
    });
    if (expiringReveal.type !== "sessionSyncRecoveryKit") {
      throw new Error("missing expiring reveal fixture");
    }
    now = expiringReveal.expiresAt + 1;
    expect(coordinator.execute({
      type: "sessionSync.recoveryKitSavedOffline",
      expectedRevision: 1,
      revealId: expiringReveal.revealId,
    })).rejects.toMatchObject({ code: "invalid_state" });

    const stoppedReveal = await coordinator.execute({
      type: "sessionSync.recovery.reveal",
      expectedRevision: 1,
    });
    if (stoppedReveal.type !== "sessionSyncRecoveryKit") {
      throw new Error("missing stopped reveal fixture");
    }
    await coordinator.stop();
    expect(coordinator.execute({
      type: "sessionSync.recoveryKitSavedOffline",
      expectedRevision: 1,
      revealId: stoppedReveal.revealId,
    })).rejects.toMatchObject({ code: "invalid_state" });

    rootKey.fill(0);
    database.close();
  });
});
