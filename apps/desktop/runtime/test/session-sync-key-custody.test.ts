import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  commitSyncVaultRootKey,
  digestSyncMembershipStatement,
  digestSyncVaultRootWrapManifest,
  generateSyncRecoveryKit,
  positiveSyncUint64Schema,
  signSyncMembershipStatement,
  syncDeviceIdSchema,
  syncMembershipStatementSchema,
  syncSha256DigestSchema,
  syncVaultCoordinateSchema,
  syncVaultRootKeyLinkContextSchema,
  syncVaultRootWrapContextSchema,
  wrapSyncParentVaultRootKey,
  wrapSyncVaultRootKey,
} from "@hraness/agent-tasks-protocol";
import type { SecretStore } from "@hraness/hra-human-client";

import {
  HRA_SESSION_SYNC_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
  SessionSyncKeyCustody,
  SessionSyncRecoveryKeyCustody,
  validateAndUnwrapSessionSyncMembershipRoots,
  verifySessionSyncRootKeyChainToGenesis,
} from "../src/cloud/session-sync-key-custody";
import {
  SessionSyncOperationJournal,
  digestSessionSyncJournalValue,
} from "../src/state/session-sync-operation-journal";
import { installSessionSyncSchema } from "../src/state/session-sync-store";

class MemorySecrets implements SecretStore {
  readonly descriptors: string[] = [];
  readonly values = new Map<string, string>();
  rejectSets = false;
  commitThenRejectSets = false;
  corruptReadbackAt: number | null = null;
  getCount = 0;

  get value(): string | null {
    return this.values.get(HRA_SESSION_SYNC_KEYCHAIN_NAME) ?? null;
  }

  set value(value: string | null) {
    if (value === null) this.values.delete(HRA_SESSION_SYNC_KEYCHAIN_NAME);
    else this.values.set(HRA_SESSION_SYNC_KEYCHAIN_NAME, value);
  }

  get(input: { readonly service: string; readonly name: string }) {
    this.descriptors.push(`get:${input.service}:${input.name}`);
    this.getCount += 1;
    if (this.getCount === this.corruptReadbackAt) {
      return Promise.resolve("{}");
    }
    return Promise.resolve(this.values.get(input.name) ?? null);
  }

  set(input: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }) {
    this.descriptors.push(`set:${input.service}:${input.name}`);
    if (this.rejectSets) return Promise.reject(new Error("denied"));
    this.values.set(input.name, input.value);
    if (this.commitThenRejectSets) return Promise.reject(new Error("lost ack"));
    return Promise.resolve();
  }

  delete(input: { readonly service: string; readonly name: string }) {
    this.descriptors.push(`delete:${input.service}:${input.name}`);
    const existed = this.values.delete(input.name);
    return Promise.resolve(existed);
  }
}

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

const vault = syncVaultCoordinateSchema.parse({
  tenantId: opaque("synctenant", "t"),
  organizationId: opaque("syncorg", "o"),
  ownerUserId: opaque("syncuser", "u"),
  vaultId: opaque("syncvault", "v"),
  vaultGeneration: "1",
});

function epoch(value: number) {
  return positiveSyncUint64Schema.parse(String(value));
}

function digest(character: string) {
  return syncSha256DigestSchema.parse(`sha256_${character.repeat(64)}`);
}

function root(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function journalDatabase(): Database {
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

async function twoDeviceMembershipFixture() {
  const firstCustody = new SessionSyncKeyCustody({ secrets: new MemorySecrets() });
  const secondCustody = new SessionSyncKeyCustody({ secrets: new MemorySecrets() });
  const firstMetadata = await firstCustody.ensureDevice();
  const secondMetadata = await secondCustody.ensureDevice();
  const firstRuntime = await firstCustody.loadRuntime();
  const secondRuntime = await secondCustody.loadRuntime();
  const firstDeviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "a"));
  const secondDeviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "b"));
  const rootKey = root(0x41);
  const rootKeyCommitment = await commitSyncVaultRootKey(rootKey);
  const genesisWrap = await wrapSyncVaultRootKey(
    rootKey,
    syncVaultRootWrapContextSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: epoch(1),
      rootKeyEpoch: epoch(1),
      recipientDeviceId: firstDeviceId,
      recipientAgreementKeyId: firstMetadata.publicKeys.agreement.keyId,
    }),
    firstMetadata.publicKeys.agreement.publicKey,
  );
  const genesisStatement = syncMembershipStatementSchema.parse({
    version: 1,
    ...vault,
    membershipEpoch: epoch(1),
    previousMembershipDigest: null,
    recoveryGeneration: epoch(1),
    enrollmentPairingDigest: null,
    rootKeyEpoch: epoch(1),
    rootKeyCommitment,
    rootWrapManifestDigest: await digestSyncVaultRootWrapManifest([genesisWrap]),
    rootKeyLinkDigest: null,
    recoveryRootWrapDigest: digest("a"),
    members: [{
      deviceId: firstDeviceId,
      name: "First Mac",
      status: "active",
      keys: firstMetadata.publicKeys,
      approvedAt: epoch(1),
    }],
  });
  const genesisHead = {
    statement: genesisStatement,
    statementDigest: await digestSyncMembershipStatement(genesisStatement),
    signatures: [await signSyncMembershipStatement(
      genesisStatement,
      firstDeviceId,
      firstMetadata.publicKeys.signing.keyId,
      firstRuntime.signingPrivateKey,
    )],
  };
  const wraps = await Promise.all([
    wrapSyncVaultRootKey(
      rootKey,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: epoch(2),
        rootKeyEpoch: epoch(1),
        recipientDeviceId: firstDeviceId,
        recipientAgreementKeyId: firstMetadata.publicKeys.agreement.keyId,
      }),
      firstMetadata.publicKeys.agreement.publicKey,
    ),
    wrapSyncVaultRootKey(
      rootKey,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: epoch(2),
        rootKeyEpoch: epoch(1),
        recipientDeviceId: secondDeviceId,
        recipientAgreementKeyId: secondMetadata.publicKeys.agreement.keyId,
      }),
      secondMetadata.publicKeys.agreement.publicKey,
    ),
  ]);
  const childStatement = syncMembershipStatementSchema.parse({
    ...genesisStatement,
    membershipEpoch: epoch(2),
    previousMembershipDigest: genesisHead.statementDigest,
    enrollmentPairingDigest: digest("b"),
    rootWrapManifestDigest: await digestSyncVaultRootWrapManifest(wraps),
    members: [
      genesisStatement.members[0],
      {
        deviceId: secondDeviceId,
        name: "Second Mac",
        status: "active",
        keys: secondMetadata.publicKeys,
        approvedAt: epoch(2),
      },
    ],
  });
  const childHead = {
    statement: childStatement,
    statementDigest: await digestSyncMembershipStatement(childStatement),
    signatures: [await signSyncMembershipStatement(
      childStatement,
      firstDeviceId,
      firstMetadata.publicKeys.signing.keyId,
      firstRuntime.signingPrivateKey,
    )],
  };
  return {
    childHead,
    firstRuntime,
    genesisHead,
    rootKey,
    secondDeviceId,
    secondMetadata,
    secondRuntime,
    wraps,
  };
}

describe("session sync Keychain custody", () => {
  test("creates one fixed device record and exposes only nonextractable runtime keys", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const concurrentCustody = new SessionSyncKeyCustody({ secrets });
    const [first, second] = await Promise.all([
      custody.ensureDevice(),
      concurrentCustody.ensureDevice(),
    ]);

    expect(first).toEqual(second);
    expect(first.vaultRootKeyring).toBeNull();
    expect(secrets.descriptors).toEqual([
      `get:${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}:${HRA_SESSION_SYNC_KEYCHAIN_NAME}`,
      `set:${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}:${HRA_SESSION_SYNC_KEYCHAIN_NAME}`,
      `get:${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}:${HRA_SESSION_SYNC_KEYCHAIN_NAME}`,
      `get:${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}:${HRA_SESSION_SYNC_KEYCHAIN_NAME}`,
    ]);
    const persisted = secrets.value;
    expect(persisted).not.toBeNull();
    expect(persisted).toContain("signingPkcs8");
    expect(persisted).toContain("agreementPkcs8");
    expect(JSON.stringify(first)).not.toContain("Pkcs8");

    const runtime = await custody.loadRuntime(first.publicKeys);
    expect(runtime.signingPrivateKey.extractable).toBeFalse();
    expect(runtime.agreementPrivateKey.extractable).toBeFalse();
    expect(runtime.vaultRootKeyring).toBeNull();
  });

  test("fails a corrupt Keychain readback closed while preserving the committed record for restart", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    // Initial lookup is read one; exact post-write verification is read two.
    secrets.corruptReadbackAt = 2;
    expect(custody.ensureDevice()).rejects.toThrow("unavailable");
    const restarted = new SessionSyncKeyCustody({ secrets });
    expect((await restarted.ensureDevice()).publicKeys).toBeDefined();
    expect(secrets.values.get(HRA_SESSION_SYNC_KEYCHAIN_NAME)).toContain(
      "signingPkcs8",
    );
  });

  test("atomically retains a bounded ordered root keyring without returning secrets as metadata", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const metadata = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(4),
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(2), rootKey: root(0x22) },
        { keyEpoch: epoch(1), rootKey: root(0x11) },
      ],
    });

    expect(metadata.vaultRootKeyring).toEqual({
      vault,
      membershipEpoch: epoch(4),
      currentRootKeyEpoch: epoch(2),
      keyEpochs: [epoch(1), epoch(2)],
    });
    expect(JSON.stringify(metadata)).not.toContain("ERER");
    expect(JSON.stringify(metadata)).not.toContain("IiIi");

    const runtime = await custody.loadRuntime(device.publicKeys);
    expect(runtime.vaultRootKeyring?.rootKeys.map(({ keyEpoch, bytes }) => ({
      keyEpoch,
      firstByte: bytes[0],
    }))).toEqual([
      { keyEpoch: epoch(1), firstByte: 0x11 },
      { keyEpoch: epoch(2), firstByte: 0x22 },
    ]);
    runtime.vaultRootKeyring?.rootKeys[0]?.bytes.fill(0xff);
    expect((await custody.loadRuntime(device.publicKeys))
      .vaultRootKeyring?.rootKeys[0]?.bytes[0]).toBe(0x11);
  });

  test("fences concurrent replacement, rollback, duplicates, and unbounded retention", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const installed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(3),
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root(1) },
        { keyEpoch: epoch(2), rootKey: root(2) },
      ],
    });

    const replace = (overrides: Partial<Parameters<
      SessionSyncKeyCustody["installVaultRootKeyring"]
    >[0]> = {}) => custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: installed.vaultRootKeyring,
      vault,
      membershipEpoch: epoch(4),
      currentRootKeyEpoch: epoch(3),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root(1) },
        { keyEpoch: epoch(2), rootKey: root(2) },
        { keyEpoch: epoch(3), rootKey: root(3) },
      ],
      ...overrides,
    });

    expect(replace({ expectedVaultRootKeyring: null })).rejects.toThrow(
      "changed concurrently",
    );
    expect(replace({
      membershipEpoch: epoch(2),
      currentRootKeyEpoch: epoch(1),
      rootKeys: [{ keyEpoch: epoch(1), rootKey: root(1) }],
    })).rejects.toThrow("cannot roll back");
    expect(replace({
      rootKeys: [
        { keyEpoch: epoch(3), rootKey: root(3) },
        { keyEpoch: epoch(3), rootKey: root(4) },
      ],
    })).rejects.toThrow();
    expect(replace({
      currentRootKeyEpoch: epoch(1),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root(1) },
        { keyEpoch: epoch(2), rootKey: root(2) },
      ],
    })).rejects.toThrow();
    expect(replace({
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root(1) },
        { keyEpoch: epoch(2), rootKey: root(1) },
      ],
    })).rejects.toThrow("root key material must be fresh");
    expect(replace({
      currentRootKeyEpoch: epoch(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS + 1),
      rootKeys: Array.from(
        { length: MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS + 1 },
        (_, index) => ({
          keyEpoch: epoch(index + 1),
          rootKey: root(index + 1),
        }),
      ),
    })).rejects.toThrow("too large");
  });

  test("replays the same root bytes but rejects different bytes under identical metadata", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const installed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(3),
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root(1) },
        { keyEpoch: epoch(2), rootKey: root(2) },
      ],
    });
    const expected = installed.vaultRootKeyring;
    if (expected === null) throw new Error("missing test keyring metadata");
    const setsBeforeReplay = secrets.descriptors.filter((entry) =>
      entry.startsWith("set:")
    ).length;

    const replayed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: expected,
      vault,
      membershipEpoch: epoch(3),
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(2), rootKey: root(2) },
        { keyEpoch: epoch(1), rootKey: root(1) },
      ],
    });
    expect(replayed).toEqual(installed);
    expect(secrets.descriptors.filter((entry) => entry.startsWith("set:")))
      .toHaveLength(setsBeforeReplay);

    let conflict: unknown;
    try {
      await custody.installVaultRootKeyring({
        expectedPublicKeys: device.publicKeys,
        expectedVaultRootKeyring: expected,
        vault,
        membershipEpoch: epoch(3),
        currentRootKeyEpoch: epoch(2),
        rootKeys: [
          { keyEpoch: epoch(1), rootKey: root(1) },
          { keyEpoch: epoch(2), rootKey: root(9) },
        ],
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain(
      "conflicts with installed keys",
    );
    expect((await custody.loadRuntime(device.publicKeys))
      .vaultRootKeyring?.rootKeys[1]?.bytes[0]).toBe(2);
  });

  test("device vault transition retains active roots until exact accepted-digest promotion", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const installed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(3),
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root(1) },
        { keyEpoch: epoch(2), rootKey: root(2) },
      ],
    });
    const current = installed.vaultRootKeyring;
    if (current === null) throw new Error("missing current keyring");
    const request = { operation: "update_membership", child: digest("c") };
    const requestDigest = digestSessionSyncJournalValue(request);
    const pending = await custody.prepareVaultRootTransition({
      operationId: "syncop_membership_transition",
      request,
      requestDigest,
      parentMembershipDigest: digest("a"),
      childMembershipDigest: digest("c"),
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: current,
      next: {
        vault,
        membershipEpoch: epoch(4),
        currentRootKeyEpoch: epoch(3),
        rootKeys: [
          { keyEpoch: epoch(1), rootKey: root(1) },
          { keyEpoch: epoch(2), rootKey: root(2) },
          { keyEpoch: epoch(3), rootKey: root(3) },
        ],
      },
    });
    expect(pending).toMatchObject({
      operationId: "syncop_membership_transition",
      requestDigest,
      parentMembershipDigest: digest("a"),
      childMembershipDigest: digest("c"),
      nextVaultRootKeyring: {
        membershipEpoch: epoch(4),
        currentRootKeyEpoch: epoch(3),
      },
    });
    expect((await custody.loadRuntime()).vaultRootKeyring?.currentRootKeyEpoch)
      .toBe(epoch(2));
    expect((await custody.loadPendingVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
    })).nextVaultRootKeyring.rootKeys.at(-1)?.bytes[0]).toBe(3);

    const restarted = new SessionSyncKeyCustody({ secrets });
    expect(restarted.promoteVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
      acceptedMembershipDigest: digest("b"),
    })).rejects.toThrow("changed concurrently");
    secrets.rejectSets = true;
    expect(restarted.promoteVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
      acceptedMembershipDigest: pending.childMembershipDigest,
    })).rejects.toThrow("unavailable");
    secrets.rejectSets = false;
    expect((await restarted.loadRuntime()).vaultRootKeyring?.currentRootKeyEpoch)
      .toBe(epoch(2));
    expect(await restarted.pendingVaultRootTransitionMetadata()).not.toBeNull();
    expect(await restarted.reconcileVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
      observedMembershipDigest: pending.parentMembershipDigest,
    })).toEqual({ disposition: "pending" });
    expect(await restarted.reconcileVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
      observedMembershipDigest: pending.childMembershipDigest,
    })).toEqual({ disposition: "promoted" });
    const promoted = await restarted.promoteVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
      acceptedMembershipDigest: digest("c"),
    });
    expect(promoted.vaultRootKeyring).toEqual(pending.nextVaultRootKeyring);
    expect(await restarted.promoteVaultRootTransition({
      operationId: pending.operationId,
      requestDigest,
      acceptedMembershipDigest: digest("c"),
    })).toEqual(promoted);
  });

  test("device vault transition rollback and Keychain denial never replace active roots", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const installed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(1),
      currentRootKeyEpoch: epoch(1),
      rootKeys: [{ keyEpoch: epoch(1), rootKey: root(1) }],
    });
    const current = installed.vaultRootKeyring;
    if (current === null) throw new Error("missing current keyring");
    const transition = {
      operationId: "syncop_membership_rollback",
      request: { operation: "update_membership", candidate: digest("b") },
      requestDigest: digestSessionSyncJournalValue({
        operation: "update_membership",
        candidate: digest("b"),
      }),
      parentMembershipDigest: digest("a"),
      childMembershipDigest: digest("b"),
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: current,
      next: {
        vault,
        membershipEpoch: epoch(2),
        currentRootKeyEpoch: epoch(2),
        rootKeys: [
          { keyEpoch: epoch(1), rootKey: root(1) },
          { keyEpoch: epoch(2), rootKey: root(2) },
        ],
      },
    } as const;
    secrets.rejectSets = true;
    expect(custody.prepareVaultRootTransition(transition)).rejects.toThrow(
      "unavailable",
    );
    secrets.rejectSets = false;
    expect(await custody.pendingVaultRootTransitionMetadata()).toBeNull();
    expect((await custody.loadRuntime()).vaultRootKeyring?.currentRootKeyEpoch)
      .toBe(epoch(1));

    const pending = await custody.prepareVaultRootTransition(transition);
    secrets.rejectSets = true;
    expect(custody.rollbackVaultRootTransition({
      operationId: pending.operationId,
      requestDigest: pending.requestDigest,
      observedMembershipDigest: pending.parentMembershipDigest,
      definitiveRejectionDigest: digest("e"),
    })).rejects.toThrow("unavailable");
    secrets.rejectSets = false;
    expect(await custody.pendingVaultRootTransitionMetadata()).not.toBeNull();
    expect(await custody.reconcileVaultRootTransition({
      operationId: pending.operationId,
      requestDigest: pending.requestDigest,
      observedMembershipDigest: pending.parentMembershipDigest,
      definitiveRejectionDigest: digest("e"),
    })).toEqual({ disposition: "rolled_back" });
    expect(await custody.rollbackVaultRootTransition({
      operationId: pending.operationId,
      requestDigest: pending.requestDigest,
      observedMembershipDigest: pending.parentMembershipDigest,
      definitiveRejectionDigest: digest("e"),
    })).toEqual(installed);
    expect((await custody.loadRuntime()).vaultRootKeyring?.rootKeys)
      .toHaveLength(1);
  });

  test("lost Keychain write acknowledgement leaves a restart-reconcilable pending vault transition", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const installed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(1),
      currentRootKeyEpoch: epoch(1),
      rootKeys: [{ keyEpoch: epoch(1), rootKey: root(1) }],
    });
    const request = { operation: "update_membership", candidate: digest("a") };
    if (installed.vaultRootKeyring === null) throw new Error("missing keyring");
    const transition = {
      operationId: "syncop_lost_keychain_ack",
      request,
      requestDigest: digestSessionSyncJournalValue(request),
      parentMembershipDigest: digest("a"),
      childMembershipDigest: digest("b"),
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: installed.vaultRootKeyring,
      next: {
        vault,
        membershipEpoch: epoch(2),
        currentRootKeyEpoch: epoch(2),
        rootKeys: [
          { keyEpoch: epoch(1), rootKey: root(1) },
          { keyEpoch: epoch(2), rootKey: root(2) },
        ],
      },
    } as const;
    secrets.commitThenRejectSets = true;
    expect(custody.prepareVaultRootTransition(transition)).rejects.toThrow(
      "unavailable",
    );
    secrets.commitThenRejectSets = false;

    const restarted = new SessionSyncKeyCustody({ secrets });
    const pending = await restarted.pendingVaultRootTransitionMetadata();
    expect(pending).toMatchObject({
      operationId: transition.operationId,
      requestDigest: transition.requestDigest,
    });
    expect((await restarted.loadRuntime()).vaultRootKeyring?.currentRootKeyEpoch)
      .toBe(epoch(1));
    expect(await restarted.reconcileVaultRootTransition({
      operationId: transition.operationId,
      requestDigest: transition.requestDigest,
      observedMembershipDigest: transition.childMembershipDigest,
    })).toEqual({ disposition: "promoted" });
    expect((await restarted.loadRuntime()).vaultRootKeyring?.currentRootKeyEpoch)
      .toBe(epoch(2));
  });

  test("validates membership quorum and the exact complete root-wrap cross product before unwrapping", async () => {
    const fixture = await twoDeviceMembershipFixture();
    const keyring = await validateAndUnwrapSessionSyncMembershipRoots({
      head: fixture.childHead,
      previousHead: fixture.genesisHead,
      expectedVault: vault,
      expectedDeviceId: fixture.secondDeviceId,
      expectedPublicKeys: fixture.secondMetadata.publicKeys,
      agreementPrivateKey: fixture.secondRuntime.agreementPrivateKey,
      wrappedRoots: [fixture.wraps[1]],
      rootWrapManifest: fixture.wraps,
    });
    expect(keyring).toMatchObject({
      vault,
      membershipEpoch: epoch(2),
      currentRootKeyEpoch: epoch(1),
    });
    expect(keyring.rootKeys).toHaveLength(1);
    expect(keyring.rootKeys[0]?.bytes).toEqual(fixture.rootKey);

    expect(validateAndUnwrapSessionSyncMembershipRoots({
      head: fixture.childHead,
      previousHead: fixture.genesisHead,
      expectedVault: vault,
      expectedDeviceId: fixture.secondDeviceId,
      expectedPublicKeys: fixture.secondMetadata.publicKeys,
      agreementPrivateKey: fixture.secondRuntime.agreementPrivateKey,
      wrappedRoots: [fixture.wraps[1]],
      rootWrapManifest: fixture.wraps.toReversed(),
    })).rejects.toThrow();
    expect(validateAndUnwrapSessionSyncMembershipRoots({
      head: fixture.childHead,
      previousHead: fixture.genesisHead,
      expectedVault: vault,
      expectedDeviceId: fixture.secondDeviceId,
      expectedPublicKeys: fixture.secondMetadata.publicKeys,
      agreementPrivateKey: fixture.secondRuntime.agreementPrivateKey,
      wrappedRoots: [fixture.wraps[1], fixture.wraps[1]],
      rootWrapManifest: fixture.wraps,
    })).rejects.toThrow("incomplete or reordered");
    expect(validateAndUnwrapSessionSyncMembershipRoots({
      head: { ...fixture.childHead, signatures: fixture.genesisHead.signatures },
      previousHead: fixture.genesisHead,
      expectedVault: vault,
      expectedDeviceId: fixture.secondDeviceId,
      expectedPublicKeys: fixture.secondMetadata.publicKeys,
      agreementPrivateKey: fixture.secondRuntime.agreementPrivateKey,
      wrappedRoots: [fixture.wraps[1]],
      rootWrapManifest: fixture.wraps,
    })).rejects.toThrow("signature is invalid");
    expect(validateAndUnwrapSessionSyncMembershipRoots({
      head: fixture.childHead,
      previousHead: fixture.genesisHead,
      expectedVault: syncVaultCoordinateSchema.parse({
        ...vault,
        vaultGeneration: epoch(2),
      }),
      expectedDeviceId: fixture.secondDeviceId,
      expectedPublicKeys: fixture.secondMetadata.publicKeys,
      agreementPrivateKey: fixture.secondRuntime.agreementPrivateKey,
      wrappedRoots: [fixture.wraps[1]],
      rootWrapManifest: fixture.wraps,
    })).rejects.toThrow("another vault");
  });

  test("authenticates immutable older root links to genesis without admitting a ninth direct root", async () => {
    const roots = Array.from({ length: 9 }, (_, index) => root(index + 1));
    const commitments = await Promise.all(roots.map(commitSyncVaultRootKey));
    const links = [];
    for (let child = 2; child <= roots.length; child += 1) {
      links.push(await wrapSyncParentVaultRootKey(
        roots[child - 2]!,
        roots[child - 1]!,
        syncVaultRootKeyLinkContextSchema.parse({
          version: 1,
          ...vault,
          membershipEpoch: epoch(child),
          parentRootKeyEpoch: epoch(child - 1),
          parentRootKeyCommitment: commitments[child - 2],
          childRootKeyEpoch: epoch(child),
          childRootKeyCommitment: commitments[child - 1],
        }),
      ));
    }
    const descending = links.toReversed();
    const firstPage = descending.slice(0, 4);
    const secondPage = descending.slice(4);
    const pages = [
      {
        request: { pageSize: 4 },
        response: {
          links: firstPage,
          hasMore: true,
          nextBeforeChildRootKeyEpoch:
            firstPage.at(-1)!.context.childRootKeyEpoch,
        },
      },
      {
        request: {
          pageSize: 4,
          beforeChildRootKeyEpoch:
            firstPage.at(-1)!.context.childRootKeyEpoch,
        },
        response: { links: secondPage, hasMore: false },
      },
    ] as const;
    expect(await verifySessionSyncRootKeyChainToGenesis({
      expectedVault: vault,
      currentMembershipEpoch: epoch(9),
      currentRootKeyEpoch: epoch(9),
      currentRootKeyCommitment: commitments[8]!,
      currentRootKeyLinkDigest: descending[0]!.linkDigest,
      currentRootKey: roots[8]!,
      pages,
    })).toEqual({
      genesisRootKeyCommitment: commitments[0]!,
      verifiedLinkCount: 8,
    });
    expect(verifySessionSyncRootKeyChainToGenesis({
      expectedVault: vault,
      currentMembershipEpoch: epoch(9),
      currentRootKeyEpoch: epoch(9),
      currentRootKeyCommitment: commitments[8]!,
      currentRootKeyLinkDigest: descending[0]!.linkDigest,
      currentRootKey: roots[8]!,
      pages: [{
        ...pages[0],
        response: { ...pages[0].response, links: firstPage.toReversed() },
      }, pages[1]],
    })).rejects.toThrow();
    expect(verifySessionSyncRootKeyChainToGenesis({
      expectedVault: vault,
      currentMembershipEpoch: epoch(9),
      currentRootKeyEpoch: epoch(9),
      currentRootKeyCommitment: commitments[8]!,
      currentRootKeyLinkDigest: descending[0]!.linkDigest,
      currentRootKey: roots[8]!,
      pages: [pages[0]],
    })).rejects.toThrow("history is incomplete");
    expect(verifySessionSyncRootKeyChainToGenesis({
      expectedVault: vault,
      currentMembershipEpoch: epoch(9),
      currentRootKeyEpoch: epoch(9),
      currentRootKeyCommitment: commitments[8]!,
      currentRootKeyLinkDigest: digest("9"),
      currentRootKey: roots[8]!,
      pages,
    })).rejects.toThrow("authority is invalid");
    expect(verifySessionSyncRootKeyChainToGenesis({
      expectedVault: vault,
      currentMembershipEpoch: epoch(9),
      currentRootKeyEpoch: epoch(9),
      currentRootKeyCommitment: commitments[8]!,
      currentRootKeyLinkDigest: descending[0]!.linkDigest,
      currentRootKey: roots[8]!,
      pages: [{
        ...pages[0],
        response: {
          ...pages[0].response,
          links: [firstPage[0]!, firstPage[0]!, ...firstPage.slice(2)],
        },
      }, pages[1]],
    })).rejects.toThrow("authority is invalid");
    expect(verifySessionSyncRootKeyChainToGenesis({
      expectedVault: vault,
      currentMembershipEpoch: epoch(9),
      currentRootKeyEpoch: epoch(9),
      currentRootKeyCommitment: commitments[8]!,
      currentRootKeyLinkDigest: descending[0]!.linkDigest,
      currentRootKey: roots[8]!,
      pages: [pages[0], {
        ...pages[1],
        request: {
          ...pages[1].request,
          beforeChildRootKeyEpoch: epoch(8),
        },
      }],
    })).rejects.toThrow("cursor is not contiguous");
  });

  test("clears only the exact observed keyring and then removes the fixed record", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncKeyCustody({ secrets });
    const device = await custody.ensureDevice();
    const installed = await custody.installVaultRootKeyring({
      expectedPublicKeys: device.publicKeys,
      expectedVaultRootKeyring: null,
      vault,
      membershipEpoch: epoch(1),
      currentRootKeyEpoch: epoch(1),
      rootKeys: [{ keyEpoch: epoch(1), rootKey: root(1) }],
    });
    const expected = installed.vaultRootKeyring;
    if (expected === null) throw new Error("missing test keyring metadata");

    expect(await custody.clearVaultRootKeyring({
      expectedVaultRootKeyring: { ...expected, membershipEpoch: epoch(2) },
    })).toBeFalse();
    expect(await custody.clearVaultRootKeyring({
      expectedVaultRootKeyring: expected,
    })).toBeTrue();
    expect((await custody.loadRuntime()).vaultRootKeyring).toBeNull();
    await custody.clearAll();
    expect(secrets.value).toBeNull();
    expect(secrets.descriptors.at(-1)).toBe(
      `delete:${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}:${HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME}`,
    );
  });

  test("rejects corrupt custody without echoing secret material", async () => {
    const secrets = new MemorySecrets();
    secrets.value = JSON.stringify({
      version: 1,
      publicKeys: {},
      privateKeys: { signingPkcs8: "top-secret", agreementPkcs8: "secret" },
      vaultRootKeyring: null,
    });
    const custody = new SessionSyncKeyCustody({ secrets });

    let message = "";
    try {
      await custody.ensureDevice();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Session sync key custody is invalid.");
    expect(message).not.toContain("top-secret");
  });

  test("keeps recovery authority in its own item and reveals it only explicitly", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncRecoveryKeyCustody({ secrets });
    const generated = await generateSyncRecoveryKit(vault, "1", "1", root(1));
    const first = await custody.installInitial(generated.recoveryKit);
    const replay = await custody.installInitial(generated.recoveryKit);

    expect(replay).toEqual(first);
    expect(first.authority).toEqual(generated.authority);
    expect(first.keyEpochs).toEqual([epoch(1)]);
    expect(JSON.stringify(first)).not.toContain("Pkcs8");
    expect(JSON.stringify(first)).not.toContain(generated.recoveryKit.vaultRootKeys[0]!.rootKey);
    expect(secrets.values.get(HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME)).toContain(
      "recoverySigningPkcs8",
    );
    expect(secrets.values.get(HRA_SESSION_SYNC_KEYCHAIN_NAME)).toBeUndefined();
    expect(await custody.loadForExplicitReveal(first.authority)).toEqual(
      generated.recoveryKit,
    );
    expect(secrets.descriptors.filter((descriptor) => descriptor.startsWith("set:")))
      .toHaveLength(1);

    const stored = JSON.parse(
      secrets.values.get(HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME)!,
    ) as {
      activeRecoveryKit: {
        vaultRootKeys: Array<{ rootKey: string }>;
      };
    };
    const acceptedRoot = stored.activeRecoveryKit.vaultRootKeys[0]!.rootKey;
    stored.activeRecoveryKit.vaultRootKeys[0]!.rootKey =
      `${acceptedRoot[0] === "A" ? "B" : "A"}${acceptedRoot.slice(1)}`;
    secrets.values.set(
      HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
      JSON.stringify(stored),
    );
    expect(custody.metadata()).rejects.toThrow(
      "Session sync recovery custody is invalid.",
    );
  });

  test("recovery authority transition preserves active custody until exact promotion", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncRecoveryKeyCustody({ secrets });
    const first = await generateSyncRecoveryKit(vault, "1", "1", root(1));
    const next = await generateSyncRecoveryKit(vault, "2", "2", root(2), [
      { keyEpoch: epoch(1), rootKey: root(1) },
    ]);
    const skipped = await generateSyncRecoveryKit(vault, "3", "3", root(3), [
      { keyEpoch: epoch(1), rootKey: root(1) },
    ]);
    const lossy = await generateSyncRecoveryKit(vault, "2", "2", root(2));
    const reused = await generateSyncRecoveryKit(vault, "2", "2", root(1), [
      { keyEpoch: epoch(1), rootKey: root(1) },
    ]);
    const metadata = await custody.installInitial(first.recoveryKit);

    const request = { operation: "recover_vault", generation: epoch(2) };
    const requestDigest = digestSessionSyncJournalValue(request);
    expect(custody.prepareRecoveryTransition({
      operationId: "syncop_recovery01",
      request,
      expectedAuthority: metadata.authority,
      nextRecoveryKit: skipped.recoveryKit,
      requestDigest,
      parentMembershipDigest: digest("1"),
      childMembershipDigest: digest("2"),
      expiresAt: epoch(100),
    })).rejects.toThrow("transition is invalid");
    expect(custody.prepareRecoveryTransition({
      operationId: "syncop_recovery_lossy",
      request,
      expectedAuthority: metadata.authority,
      nextRecoveryKit: lossy.recoveryKit,
      requestDigest,
      parentMembershipDigest: digest("1"),
      childMembershipDigest: digest("2"),
      expiresAt: epoch(100),
    })).rejects.toThrow("cannot discard authenticated root history");
    expect(custody.prepareRecoveryTransition({
      operationId: "syncop_recovery_reused",
      request,
      expectedAuthority: metadata.authority,
      nextRecoveryKit: reused.recoveryKit,
      requestDigest,
      parentMembershipDigest: digest("1"),
      childMembershipDigest: digest("2"),
      expiresAt: epoch(100),
    })).rejects.toThrow("reuses root key material");
    expect(await custody.loadForExplicitReveal(metadata.authority)).toEqual(
      first.recoveryKit,
    );
    const prepared = await custody.prepareRecoveryTransition({
      operationId: "syncop_recovery01",
      request,
      expectedAuthority: metadata.authority,
      nextRecoveryKit: next.recoveryKit,
      requestDigest,
      parentMembershipDigest: digest("1"),
      childMembershipDigest: digest("2"),
      expiresAt: epoch(100),
    });
    expect(prepared.requestDigest).toBe(requestDigest);
    expect(await custody.loadForExplicitReveal(metadata.authority)).toEqual(
      first.recoveryKit,
    );
    expect((await custody.loadPendingTransition({
      operationId: "syncop_recovery01",
      requestDigest,
    })).nextRecoveryKit).toEqual(next.recoveryKit);

    const restarted = new SessionSyncRecoveryKeyCustody({ secrets });
    secrets.rejectSets = true;
    expect(restarted.promoteRecoveryTransition({
      operationId: "syncop_recovery01",
      requestDigest,
      acceptedMembershipDigest: prepared.childMembershipDigest,
      acceptedAuthorityDigest: prepared.nextAuthorityDigest,
    })).rejects.toThrow("unavailable");
    secrets.rejectSets = false;
    expect(await restarted.pendingTransitionMetadata()).toEqual(prepared);
    expect(await restarted.loadForExplicitReveal(metadata.authority)).toEqual(
      first.recoveryKit,
    );
    expect(await restarted.reconcileRecoveryTransition({
      operationId: "syncop_recovery01",
      requestDigest,
      observedMembershipDigest: prepared.parentMembershipDigest,
      observedAuthorityDigest: prepared.expectedAuthorityDigest,
    })).toEqual({ disposition: "pending" });
    expect(await restarted.reconcileRecoveryTransition({
      operationId: "syncop_recovery01",
      requestDigest,
      observedMembershipDigest: prepared.childMembershipDigest,
      observedAuthorityDigest: prepared.nextAuthorityDigest,
    })).toEqual({ disposition: "promoted" });
    const installed = await restarted.promoteRecoveryTransition({
      operationId: "syncop_recovery01",
      requestDigest,
      acceptedMembershipDigest: prepared.childMembershipDigest,
      acceptedAuthorityDigest: prepared.nextAuthorityDigest,
    });
    expect(installed.authority).toEqual(next.authority);
    expect(await restarted.promoteRecoveryTransition({
      operationId: "syncop_recovery01",
      requestDigest,
      acceptedMembershipDigest: prepared.childMembershipDigest,
      acceptedAuthorityDigest: prepared.nextAuthorityDigest,
    })).toEqual(installed);
    expect(custody.loadForExplicitReveal(metadata.authority)).rejects.toThrow(
      "does not match",
    );
    expect(await custody.loadForExplicitReveal(next.authority)).toEqual(
      next.recoveryKit,
    );
  });

  test("recovery transition rollback is CAS-idempotent and never replaces the old kit", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncRecoveryKeyCustody({ secrets });
    const first = await generateSyncRecoveryKit(vault, "1", "1", root(1));
    const next = await generateSyncRecoveryKit(vault, "2", "2", root(2), [
      { keyEpoch: epoch(1), rootKey: root(1) },
    ]);
    const metadata = await custody.installInitial(first.recoveryKit);
    const request = { operation: "recover_vault", generation: epoch(2) };
    const requestDigest = digestSessionSyncJournalValue(request);
    await custody.prepareRecoveryTransition({
      operationId: "syncop_recovery02",
      request,
      expectedAuthority: metadata.authority,
      nextRecoveryKit: next.recoveryKit,
      requestDigest,
      parentMembershipDigest: digest("3"),
      childMembershipDigest: digest("4"),
      expiresAt: epoch(100),
    });
    const recoveryPending = await custody.pendingTransitionMetadata();
    if (recoveryPending === null) throw new Error("missing recovery transition");
    secrets.rejectSets = true;
    expect(custody.rollbackRecoveryTransition({
      operationId: "syncop_recovery02",
      requestDigest,
      observedMembershipDigest: recoveryPending.parentMembershipDigest,
      observedAuthorityDigest: recoveryPending.expectedAuthorityDigest,
      definitiveRejectionDigest: digest("5"),
    })).rejects.toThrow("unavailable");
    secrets.rejectSets = false;
    expect(await custody.pendingTransitionMetadata()).toEqual(recoveryPending);
    expect(await custody.reconcileRecoveryTransition({
      operationId: "syncop_recovery02",
      requestDigest,
      observedMembershipDigest: digest("3"),
      observedAuthorityDigest: recoveryPending.expectedAuthorityDigest,
      definitiveRejectionDigest: digest("5"),
    })).toEqual({ disposition: "rolled_back" });
    const rolledBack = await custody.rollbackRecoveryTransition({
      operationId: "syncop_recovery02",
      requestDigest,
      observedMembershipDigest: recoveryPending.parentMembershipDigest,
      observedAuthorityDigest: recoveryPending.expectedAuthorityDigest,
      definitiveRejectionDigest: digest("5"),
    });
    expect(rolledBack).toEqual(metadata);
    expect(await custody.rollbackRecoveryTransition({
      operationId: "syncop_recovery02",
      requestDigest,
      observedMembershipDigest: recoveryPending.parentMembershipDigest,
      observedAuthorityDigest: recoveryPending.expectedAuthorityDigest,
      definitiveRejectionDigest: digest("5"),
    })).toEqual(metadata);
    expect(await custody.loadForExplicitReveal(metadata.authority)).toEqual(
      first.recoveryKit,
    );
    expect(custody.promoteRecoveryTransition({
      operationId: "syncop_recovery02",
      requestDigest,
      acceptedMembershipDigest: digest("4"),
      acceptedAuthorityDigest: digest("6"),
    })).rejects.toThrow("missing");
  });

  test("recovery transition survives a committed Keychain write with a lost acknowledgement", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncRecoveryKeyCustody({ secrets });
    const first = await generateSyncRecoveryKit(vault, "1", "1", root(1));
    const next = await generateSyncRecoveryKit(vault, "2", "2", root(2), [
      { keyEpoch: epoch(1), rootKey: root(1) },
    ]);
    const active = await custody.installInitial(first.recoveryKit);
    const request = { operation: "recover_vault", generation: epoch(2) };
    const requestDigest = digestSessionSyncJournalValue(request);
    secrets.commitThenRejectSets = true;
    expect(custody.prepareRecoveryTransition({
      operationId: "syncop_recovery_lost_ack",
      request,
      expectedAuthority: active.authority,
      nextRecoveryKit: next.recoveryKit,
      requestDigest,
      parentMembershipDigest: digest("a"),
      childMembershipDigest: digest("b"),
      expiresAt: epoch(100),
    })).rejects.toThrow("unavailable");
    secrets.commitThenRejectSets = false;

    const restarted = new SessionSyncRecoveryKeyCustody({ secrets });
    const pending = await restarted.pendingTransitionMetadata();
    if (pending === null) throw new Error("missing recovery transition");
    expect(await restarted.reconcileRecoveryTransition({
      operationId: "syncop_recovery_lost_ack",
      requestDigest,
      observedMembershipDigest: digest("b"),
      observedAuthorityDigest: pending.nextAuthorityDigest,
    })).toEqual({ disposition: "promoted" });
    expect((await restarted.metadata())?.authority).toEqual(next.authority);
  });

  test("one sync operation ID correlates SQLite recovery intent and Keychain promotion across restart", async () => {
    const secrets = new MemorySecrets();
    const custody = new SessionSyncRecoveryKeyCustody({ secrets });
    const first = await generateSyncRecoveryKit(vault, "1", "1", root(1));
    const next = await generateSyncRecoveryKit(vault, "2", "2", root(2), [
      { keyEpoch: epoch(1), rootKey: root(1) },
    ]);
    const active = await custody.installInitial(first.recoveryKit);
    const database = journalDatabase();
    try {
      const operationId = "syncop_recovery_cross_store";
      const request = {
        operation: "recover_vault",
        recoveryGeneration: next.authority.recoveryGeneration,
        recoverySigningKeyId: next.authority.keyId,
      };
      const requestDigest = digestSessionSyncJournalValue(request);
      const prepared = new SessionSyncOperationJournal(database).prepare({
        operationId,
        kind: "recover_vault",
        request,
        keychainReferences: [{
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
        }],
        now: 1,
      });
      const pending = await custody.prepareRecoveryTransition({
        operationId,
        request,
        expectedAuthority: active.authority,
        nextRecoveryKit: next.recoveryKit,
        requestDigest,
        parentMembershipDigest: digest("7"),
        childMembershipDigest: digest("8"),
        expiresAt: epoch(100),
      });

      const restartedJournal = new SessionSyncOperationJournal(database);
      const restartedCustody = new SessionSyncRecoveryKeyCustody({ secrets });
      expect(restartedJournal.get(operationId)).toEqual(prepared);
      expect(await restartedCustody.pendingTransitionMetadata()).toEqual(pending);
      const promoted = await restartedCustody.promoteRecoveryTransition({
        operationId,
        requestDigest,
        acceptedMembershipDigest: pending.childMembershipDigest,
        acceptedAuthorityDigest: pending.nextAuthorityDigest,
      });
      const terminal = restartedJournal.settle({
        operationId,
        outcome: {
          kind: "recovery_promoted",
          nextAuthorityDigest: pending.nextAuthorityDigest,
        },
        now: 2,
      });
      expect(promoted.authority).toEqual(next.authority);
      expect(terminal).toMatchObject({
        operationId,
        requestDigest,
        state: "terminal",
      });
    } finally {
      database.close();
    }
  });

  test("recovery Keychain denial stays generic and never echoes supplied material", async () => {
    const generated = await generateSyncRecoveryKit(vault, "1", "1", root(1));
    const custody = new SessionSyncRecoveryKeyCustody({
      secrets: {
        get: () => Promise.reject(new Error("secret read detail")),
        set: () => Promise.reject(new Error("secret write detail")),
        delete: () => Promise.reject(new Error("secret delete detail")),
      },
    });
    let message = "";
    try {
      await custody.installInitial(generated.recoveryKit);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Session sync recovery custody is unavailable.");
    expect(message).not.toContain("secret");
    expect(message).not.toContain(generated.recoveryKit.recoverySigningPkcs8);
  });
});
