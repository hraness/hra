import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  allocateSessionSyncNonce,
  canonicalSessionSyncJson,
  createSessionSyncNonceState,
  createSyncRecoveryNonce,
  createSyncDeviceKeyPairs,
  createSyncProofNonce,
  createSyncVaultRootKey,
  commitSyncVaultRootKey,
  deriveSessionContentKey,
  digestSyncMembershipStatement,
  digestSyncRequestBody,
  digestSyncRecoveryVaultRootWrap,
  digestSyncVaultRootWrapManifest,
  digestSyncVaultRootKeyLink,
  encodeSyncUint64,
  generateSyncRecoveryKit,
  generateSyncDeviceKeyCustody,
  importSyncDeviceKeyPairs,
  openSyncRecoveryKit,
  parseSessionSyncResponseJson,
  sealSessionSummary,
  sealedSessionSummarySchema,
  sessionContentKeyContextSchema,
  sessionSyncHttpRoutes,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  signSyncDeviceProof,
  signSyncEnrollmentPossessionProof,
  signSyncMembershipStatement,
  signSyncRecoveryStatement,
  recoverSyncVaultRequestSchema,
  syncRecoveryStatementSchema,
  syncRecoveryVaultRootWrapContextSchema,
  syncDeviceProofPayloadSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncEnrollmentPossessionProofPayloadSchema,
  syncNonceForSequence,
  syncVaultCoordinateSchema,
  syncVaultRootWrapContextSchema,
  syncVaultRootKeyLinkContextSchema,
  submitSyncEnrollmentIntentSchema,
  claimSyncEnrollmentIntentSchema,
  wrapSyncVaultRootKey,
  wrapSyncVaultRootKeyForRecovery,
  wrapSyncParentVaultRootKey,
  type SyncDeviceKeyPairs,
  type SessionSyncBackendResponse,
  type SyncMembershipHead,
  SYNC_ENROLLMENT_POSSESSION_PROOF_TTL_MS,
  MAX_SYNC_ACTIVE_STREAMS,
  MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
  MAX_SYNC_RETAINED_EVENTS,
} from "@hraness/agent-tasks-protocol";
import { makeFunctionReference } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";

import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  routeForSessionSyncRequest,
  sessionSyncBackendRequestSchema,
  type SessionSyncBackendRequest,
} from "./sessionSyncSchemas";

const WORKOS_CLIENT_ID = "client_session_sync";
const WORKOS_ORGANIZATION_ID = "org_sessionsync";
const WORKOS_USER_ID = "user_sessionsync";
const FOREIGN_WORKOS_USER_ID = "user_sessionsyncforeign";
const NOW = Date.now();

const modules = {
  "./_generated/api.ts": async () => await import("./_generated/api"),
  "./_generated/server.ts": async () => await import("./_generated/server"),
  "./http.ts": async () => await import("./http"),
  "./sessionSync.ts": async () => await import("./sessionSync"),
  "./sessionSyncHttp.ts": async () => await import("./sessionSyncHttp"),
  "./sessionSyncModel.ts": async () => await import("./sessionSyncModel"),
};

type SyncTest = TestConvex<typeof schema>;
type SyncActor = ReturnType<SyncTest["withIdentity"]>;
type BackendResult =
  | { readonly ok: true; readonly responseJson: string }
  | { readonly ok: false; readonly code: string; readonly retryAfterMs?: number };

const bootstrapRef = makeFunctionReference<
  "action",
  { requestJson: string; proofJson: string },
  BackendResult
>("sessionSync:bootstrapVault");
const executeRef = makeFunctionReference<
  "action",
  { requestJson: string; proofJson: string },
  BackendResult
>("sessionSync:execute");
const submitEnrollmentRef = makeFunctionReference<
  "action",
  { requestJson: string },
  BackendResult
>("sessionSync:submitEnrollment");
const claimEnrollmentRef = makeFunctionReference<
  "action",
  { requestJson: string },
  BackendResult
>("sessionSync:claimEnrollment");
const recoverVaultRef = makeFunctionReference<
  "action",
  { requestJson: string },
  BackendResult
>("sessionSync:recoverVault");
const retireExpiredRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  {
    expiredEnrollments: number;
    purgedEnrollments: number;
    expiredRateBuckets: number;
    retiredReservations: number;
    retiredSessions: number;
  }
>("sessionSyncModel:retireExpiredSyncState");
const commitAuthenticatedRef = makeFunctionReference<
  "mutation",
  { requestJson: string; proofJson: string; verifiedBodyDigest: string },
  BackendResult
>("sessionSyncModel:commitAuthenticatedRequest");

const originalClientId = process.env.WORKOS_CLIENT_ID;
const originalSyncEnabled = process.env.HRA_SESSION_SYNC_ENABLED;
const originalLegacySyncEnabled = process.env.OPRTE_SESSION_SYNC_ENABLED;

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

function identity(subject = WORKOS_USER_ID) {
  return {
    issuer: `https://api.workos.com/user_management/${WORKOS_CLIENT_ID}`,
    org_id: WORKOS_ORGANIZATION_ID,
    sid: `session_${subject}`,
    subject,
    tokenIdentifier: `${WORKOS_CLIENT_ID}|${subject}`,
  };
}

async function seedHumanScope(t: SyncTest): Promise<void> {
  await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      publicId: "org_00000000000000000000007001",
      workosOrganizationId: WORKOS_ORGANIZATION_ID,
      name: "Session sync",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const [index, subject] of [WORKOS_USER_ID, FOREIGN_WORKOS_USER_ID].entries()) {
      const userId = await ctx.db.insert("users", {
        publicId: subject,
        workosUserId: subject,
        name: `Session sync ${index}`,
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("organizationMemberships", {
        organizationId,
        userId,
        role: "owner",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  });
}

const vault = syncVaultCoordinateSchema.parse({
  tenantId: opaque("synctenant", "t"),
  organizationId: opaque("syncorg", "o"),
  ownerUserId: opaque("syncuser", "u"),
  vaultId: opaque("syncvault", "v"),
  vaultGeneration: "1",
});

function methodFor(request: SessionSyncBackendRequest): "GET" | "POST" {
  return [
    "read_membership",
    "list_enrollment_requests",
    "snapshot_page",
    "change_page",
  ].includes(request.operation)
    ? "GET"
    : "POST";
}

async function proofFor(
  requestValue: unknown,
  keys: SyncDeviceKeyPairs,
  membershipEpoch = "1",
  deviceId = opaque("syncdevice", "d"),
) {
  const request = sessionSyncBackendRequestSchema.parse(requestValue);
  const issuedAt = Date.now();
  return await signSyncDeviceProof(syncDeviceProofPayloadSchema.parse({
    version: 1,
    ...vault,
    membershipEpoch,
    deviceId,
    method: methodFor(request),
    route: routeForSessionSyncRequest(request) as never,
    bodyDigest: await digestSyncRequestBody(request),
    nonce: createSyncProofNonce(),
    issuedAt: encodeSyncUint64(BigInt(issuedAt)),
    expiresAt: encodeSyncUint64(BigInt(issuedAt + 60_000)),
  }), keys.publicKeys.signing.keyId, keys.signingPrivateKey);
}

async function execute(
  actor: SyncActor,
  requestValue: unknown,
  keys: SyncDeviceKeyPairs,
  membershipEpoch = "1",
  deviceId = opaque("syncdevice", "d"),
): Promise<BackendResult> {
  const request = sessionSyncBackendRequestSchema.parse(requestValue);
  const proof = await proofFor(request, keys, membershipEpoch, deviceId);
  return await actor.action(executeRef, {
    requestJson: canonicalSessionSyncJson(request),
    proofJson: canonicalSessionSyncJson(proof),
  });
}

async function enrollmentPossessionProof(
  purpose: "submit" | "claim",
  intent: ReturnType<typeof submitSyncEnrollmentIntentSchema.parse>
    | ReturnType<typeof claimSyncEnrollmentIntentSchema.parse>,
  custody: Awaited<ReturnType<typeof generateSyncDeviceKeyCustody>>,
) {
  const issuedAt = Date.now();
  return await signSyncEnrollmentPossessionProof(
    syncEnrollmentPossessionProofPayloadSchema.parse({
      version: 1,
      purpose,
      vaultId: intent.vaultId,
      vaultGeneration: intent.vaultGeneration,
      deviceId: intent.deviceId,
      bodyDigest: await digestSyncRequestBody(intent),
      nonce: createSyncProofNonce(),
      issuedAt: encodeSyncUint64(BigInt(issuedAt)),
      expiresAt: encodeSyncUint64(
        BigInt(issuedAt + SYNC_ENROLLMENT_POSSESSION_PROOF_TTL_MS),
      ),
    }),
    custody.privateKeyMaterial,
    custody.publicKeys,
  );
}

function data(result: BackendResult): SessionSyncBackendResponse {
  if (!result.ok) throw new Error(`session sync request failed: ${result.code}`);
  expect(result.ok).toBeTrue();
  return parseSessionSyncResponseJson(result.responseJson);
}

async function bootstrap(
  actor: SyncActor,
  keys: SyncDeviceKeyPairs,
  rootKey: Uint8Array,
  recoveryAuthorityValue?: Awaited<ReturnType<typeof generateSyncRecoveryKit>>["authority"],
) {
  const deviceId = opaque("syncdevice", "d");
  const rootKeyCommitment = await commitSyncVaultRootKey(rootKey);
  const recoveryAuthority = recoveryAuthorityValue ?? (await generateSyncRecoveryKit(
    vault,
    "1",
    "1",
    rootKey,
  )).authority;
  const wrappedRoot = await wrapSyncVaultRootKey(rootKey, syncVaultRootWrapContextSchema.parse({
    version: 1,
    ...vault,
    membershipEpoch: "1",
    rootKeyEpoch: "1",
    recipientDeviceId: deviceId,
    recipientAgreementKeyId: keys.publicKeys.agreement.keyId,
  }), keys.publicKeys.agreement.publicKey);
  const recoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
    rootKey,
    syncRecoveryVaultRootWrapContextSchema.parse({
      version: 1,
      vault,
      membershipEpoch: "1",
      recoveryGeneration: "1",
      rootKeyEpoch: "1",
      rootKeyCommitment,
      recipientRecoveryAgreementKeyId: recoveryAuthority.agreementKeyId,
    }),
    recoveryAuthority,
  );
  const statement = syncMembershipStatementSchema.parse({
    version: 1 as const,
    ...vault,
    membershipEpoch: "1" as const,
    previousMembershipDigest: null,
    recoveryGeneration: "1" as const,
    enrollmentPairingDigest: null,
    rootKeyEpoch: "1",
    rootKeyCommitment,
    rootWrapManifestDigest: await digestSyncVaultRootWrapManifest([wrappedRoot]),
    rootKeyLinkDigest: null,
    recoveryRootWrapDigest: await digestSyncRecoveryVaultRootWrap(recoveryRootWrap),
    members: [{
      deviceId,
      name: "Owner Mac",
      status: "active" as const,
      keys: keys.publicKeys,
      approvedAt: encodeSyncUint64(BigInt(Date.now())),
    }],
  });
  const head: SyncMembershipHead = {
    statement,
    statementDigest: await digestSyncMembershipStatement(statement),
    signatures: [await signSyncMembershipStatement(
      statement,
      deviceId as never,
      keys.publicKeys.signing.keyId,
      keys.signingPrivateKey,
    )],
  };
  const request = {
    version: 1 as const,
    membershipHead: head,
    wrappedRoot,
    recoveryAuthority,
    recoveryRootWrap,
  };
  const issuedAt = Date.now();
  const proof = await signSyncDeviceProof(syncDeviceProofPayloadSchema.parse({
    version: 1,
    ...vault,
    membershipEpoch: "1",
    deviceId,
    method: "POST",
    route: "sync.membership.update",
    bodyDigest: await digestSyncRequestBody(request),
    nonce: createSyncProofNonce(),
    issuedAt: encodeSyncUint64(BigInt(issuedAt)),
    expiresAt: encodeSyncUint64(BigInt(issuedAt + 60_000)),
  }), keys.publicKeys.signing.keyId, keys.signingPrivateKey);
  return await actor.action(bootstrapRef, {
    requestJson: canonicalSessionSyncJson(request),
    proofJson: canonicalSessionSyncJson(proof),
  });
}

beforeEach(() => {
  process.env.WORKOS_CLIENT_ID = WORKOS_CLIENT_ID;
  process.env.HRA_SESSION_SYNC_ENABLED = "true";
  delete process.env.OPRTE_SESSION_SYNC_ENABLED;
});

afterEach(() => {
  if (originalClientId === undefined) delete process.env.WORKOS_CLIENT_ID;
  else process.env.WORKOS_CLIENT_ID = originalClientId;
  if (originalSyncEnabled === undefined) delete process.env.HRA_SESSION_SYNC_ENABLED;
  else process.env.HRA_SESSION_SYNC_ENABLED = originalSyncEnabled;
  if (originalLegacySyncEnabled === undefined) {
    delete process.env.OPRTE_SESSION_SYNC_ENABLED;
  } else {
    process.env.OPRTE_SESSION_SYNC_ENABLED = originalLegacySyncEnabled;
  }
});

describe("session sync Convex boundary", () => {
  test("fails closed unless the session-sync flag is the exact lowercase true literal", async () => {
    const t = convexTest(schema, modules);
    const actor = t.withIdentity(identity());
    for (const value of [undefined, "", "false", "TRUE", "True", " true "]) {
      if (value === undefined) delete process.env.HRA_SESSION_SYNC_ENABLED;
      else process.env.HRA_SESSION_SYNC_ENABLED = value;
      expect(await actor.action(bootstrapRef, {
        requestJson: "{}",
        proofJson: "{}",
      })).toEqual({ ok: false, code: "AUTHORIZATION_DENIED" });
    }
  });

  test("publishes, replays a lost acknowledgement, pages a pinned directory, and absorbs deletion", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    const rootKey = createSyncVaultRootKey();
    expect(data(await bootstrap(actor, keys, rootKey))).toMatchObject({ kind: "vault_created" });

    const bootId = opaque("syncboot", "b");
    expect(data(await execute(actor, {
      version: 1,
      operation: "establish_boot",
      bootId,
      bootGeneration: "1",
      heartbeatSequence: "1",
    }, keys))).toMatchObject({ kind: "boot_current" });

    const sessionId = opaque("syncsession", "s");
    const grantDigest = `sha256_${"1".repeat(64)}`;
    const reservation = data(await execute(actor, {
      version: 1,
      operation: "reserve_session",
      sessionId,
      creationGrantDigest: grantDigest,
    }, keys));
    expect(reservation).toMatchObject({ kind: "session_reserved", directoryOrdinal: "1" });
    const writer = data(await execute(actor, {
      version: 1,
      operation: "acquire_writer",
      sessionId,
      bootId,
      bootGeneration: "1",
      acknowledgedMirrorEpoch: "1",
      acknowledgedSequence: "0",
      acknowledgedDigest: null,
    }, keys));
    expect(writer).toMatchObject({ kind: "writer_acquired", writerGeneration: "1" });

    const contentKey = await deriveSessionContentKey(rootKey, sessionContentKeyContextSchema.parse({
      version: 1,
      ...vault,
      sessionId,
      keyEpoch: "1",
      originDeviceId: opaque("syncdevice", "d"),
      mirrorEpoch: "1",
      writerGeneration: "1",
    }));
    const nonce = allocateSessionSyncNonce(createSessionSyncNonceState("1"));
    const envelope = await sealSessionSummary(sessionSummarySchema.parse({
      version: 1,
      sessionId,
      ownerDeviceId: opaque("syncdevice", "d"),
      directoryOrdinal: "1",
      sourceRevision: "1",
      title: "Compiler recovery",
      state: "working",
      deleted: false,
    }), sessionSyncHeaderSchema.parse({
      protocol: "oprte.session-sync/v1",
      payloadVersion: 1,
      payloadKind: "session_summary",
      ...vault,
      membershipEpoch: "1",
      originDeviceId: opaque("syncdevice", "d"),
      sessionId,
      mirrorEpoch: "1",
      writerGeneration: "1",
      bootId,
      bootGeneration: "1",
      directoryOrdinal: "1",
      keyEpoch: "1",
      syncSequence: "1",
      sourceRevision: "1",
      eventKind: "created",
      previousDigest: null,
      creationGrantDigest: grantDigest,
    }), contentKey, nonce.allocation);
    expect(await execute(actor, {
      version: 1,
      operation: "publish_session",
      envelope: { ...envelope, nonce: "AAAAAAAAAAAAAAAA" },
    }, keys)).toEqual({ ok: false, code: "PROOF_INVALID" });
    const publicationProjection = async () => await t.run(async (ctx) => {
      const storedVault = (await ctx.db.query("syncVaults").collect())[0];
      const storedEntry = (await ctx.db.query("syncSessionEntries").collect())[0];
      return {
        vault: storedVault === undefined ? null : {
          directoryVersion: storedVault.directoryVersion,
          retainedEventCount: storedVault.retainedEventCount,
          retainedCiphertextBytes: storedVault.retainedCiphertextBytes,
        },
        entry: storedEntry === undefined ? null : {
          state: storedEntry.state,
          currentSequence: storedEntry.currentSequence,
          currentDigest: storedEntry.currentDigest,
          latestDirectoryVersion: storedEntry.latestDirectoryVersion,
          retainedEventCount: storedEntry.retainedEventCount,
          retainedCiphertextBytes: storedEntry.retainedCiphertextBytes,
        },
        eventCount: (await ctx.db.query("syncSessionEvents").collect()).length,
        changeCount: (await ctx.db.query("syncDirectoryChanges").collect()).length,
        headCount: (await ctx.db.query("syncSessionHeads").collect()).length,
      };
    });
    const beforeForeignPublication = await publicationProjection();
    const foreignCoordinates = [
      ["tenantId", opaque("synctenant", "x")],
      ["organizationId", opaque("syncorg", "x")],
      ["ownerUserId", opaque("syncuser", "x")],
      ["vaultId", opaque("syncvault", "x")],
      ["vaultGeneration", "2"],
    ] as const;
    for (const [field, value] of foreignCoordinates) {
      expect(await execute(actor, {
        version: 1,
        operation: "publish_session",
        envelope: {
          ...envelope,
          header: { ...envelope.header, [field]: value },
        },
      }, keys)).toEqual({ ok: false, code: "AUTHORIZATION_DENIED" });
      expect(await publicationProjection()).toEqual(beforeForeignPublication);
    }
    const publishRequest = { version: 1 as const, operation: "publish_session" as const, envelope };
    const accepted = data(await execute(actor, publishRequest, keys));
    expect(accepted).toMatchObject({ kind: "session_accepted", replay: false });
    const acceptedProjection = await t.run(async (ctx) => {
      const storedVault = (await ctx.db.query("syncVaults").collect())[0];
      const storedEntry = (await ctx.db.query("syncSessionEntries").collect())[0];
      return {
        vault: storedVault === undefined ? null : {
          directoryVersion: storedVault.directoryVersion,
          retainedEventCount: storedVault.retainedEventCount,
          retainedCiphertextBytes: storedVault.retainedCiphertextBytes,
        },
        entry: storedEntry === undefined ? null : {
          currentSequence: storedEntry.currentSequence,
          currentDigest: storedEntry.currentDigest,
          latestDirectoryVersion: storedEntry.latestDirectoryVersion,
          retainedEventCount: storedEntry.retainedEventCount,
          retainedCiphertextBytes: storedEntry.retainedCiphertextBytes,
        },
        eventCount: (await ctx.db.query("syncSessionEvents").collect()).length,
        changeCount: (await ctx.db.query("syncDirectoryChanges").collect()).length,
        headCount: (await ctx.db.query("syncSessionHeads").collect()).length,
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      };
    });
    expect(data(await execute(actor, publishRequest, keys))).toMatchObject({
      kind: "session_accepted",
      replay: true,
    });
    expect(await t.run(async (ctx) => {
      const storedVault = (await ctx.db.query("syncVaults").collect())[0];
      const storedEntry = (await ctx.db.query("syncSessionEntries").collect())[0];
      return {
        vault: storedVault === undefined ? null : {
          directoryVersion: storedVault.directoryVersion,
          retainedEventCount: storedVault.retainedEventCount,
          retainedCiphertextBytes: storedVault.retainedCiphertextBytes,
        },
        entry: storedEntry === undefined ? null : {
          currentSequence: storedEntry.currentSequence,
          currentDigest: storedEntry.currentDigest,
          latestDirectoryVersion: storedEntry.latestDirectoryVersion,
          retainedEventCount: storedEntry.retainedEventCount,
          retainedCiphertextBytes: storedEntry.retainedCiphertextBytes,
        },
        eventCount: (await ctx.db.query("syncSessionEvents").collect()).length,
        changeCount: (await ctx.db.query("syncDirectoryChanges").collect()).length,
        headCount: (await ctx.db.query("syncSessionHeads").collect()).length,
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      };
    })).toEqual(acceptedProjection);
    expect(acceptedProjection.vault).toEqual({
      directoryVersion: "1",
      retainedEventCount: 1,
      retainedCiphertextBytes: 96 + envelope.ciphertextBytes * 2,
    });

    const secondSessionId = opaque("syncsession", "x");
    const secondGrantDigest = `sha256_${"3".repeat(64)}`;
    expect(data(await execute(actor, {
      version: 1,
      operation: "reserve_session",
      sessionId: secondSessionId,
      creationGrantDigest: secondGrantDigest,
    }, keys))).toMatchObject({ directoryOrdinal: "2" });
    const liveReservationSnapshotId = opaque("syncsnapshot", "l");
    expect(data(await execute(actor, {
      version: 1,
      operation: "begin_snapshot",
      snapshotId: liveReservationSnapshotId,
    }, keys))).toMatchObject({ kind: "snapshot_started", snapshotVersion: "1" });
    expect(data(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId: liveReservationSnapshotId,
      pageSize: 8,
    }, keys))).toMatchObject({
      kind: "snapshot_page",
      page: {
        snapshotVersion: "1",
        complete: true,
        entries: [{
          kind: "head",
          accepted: { envelope: { header: { sessionId } } },
        }],
      },
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "acquire_writer",
      sessionId: secondSessionId,
      bootId,
      bootGeneration: "1",
      acknowledgedMirrorEpoch: "1",
      acknowledgedSequence: "0",
      acknowledgedDigest: null,
    }, keys))).toMatchObject({ writerGeneration: "1" });
    const secondContentKey = await deriveSessionContentKey(rootKey, sessionContentKeyContextSchema.parse({
      version: 1,
      ...vault,
      sessionId: secondSessionId,
      keyEpoch: "1",
      originDeviceId: opaque("syncdevice", "d"),
      mirrorEpoch: "1",
      writerGeneration: "1",
    }));
    const secondNonce = allocateSessionSyncNonce(createSessionSyncNonceState("1"));
    const secondEnvelope = await sealSessionSummary(sessionSummarySchema.parse({
      version: 1,
      sessionId: secondSessionId,
      ownerDeviceId: opaque("syncdevice", "d"),
      directoryOrdinal: "2",
      sourceRevision: "1",
      title: "Second pane",
      state: "ready",
      deleted: false,
    }), sessionSyncHeaderSchema.parse({
      protocol: "oprte.session-sync/v1",
      payloadVersion: 1,
      payloadKind: "session_summary",
      ...vault,
      membershipEpoch: "1",
      originDeviceId: opaque("syncdevice", "d"),
      sessionId: secondSessionId,
      mirrorEpoch: "1",
      writerGeneration: "1",
      bootId,
      bootGeneration: "1",
      directoryOrdinal: "2",
      keyEpoch: "1",
      syncSequence: "1",
      sourceRevision: "1",
      eventKind: "created",
      previousDigest: null,
      creationGrantDigest: secondGrantDigest,
    }), secondContentKey, secondNonce.allocation);
    const secondPublishRequest = {
      version: 1,
      operation: "publish_session" as const,
      envelope: secondEnvelope,
    };
    expect(data(await execute(actor, secondPublishRequest, keys))).toMatchObject({ kind: "session_accepted" });
    const postReservationChanges = data(await execute(actor, {
      version: 1,
      operation: "change_page",
      afterVersion: "1",
      pageSize: 8,
    }, keys));
    expect(postReservationChanges).toMatchObject({
      kind: "change_page",
      page: {
        changes: [{
          kind: "upsert",
          accepted: { envelope: { header: { sessionId: secondSessionId } } },
        }],
        nextVersion: "2",
        hasMore: false,
      },
    });
    if (postReservationChanges.kind !== "change_page") {
      throw new Error("post-reservation change page missing");
    }
    expect(postReservationChanges.page.changes).toHaveLength(1);
    await t.run(async (ctx) => {
      const event = (await ctx.db.query("syncSessionEvents").collect())
        .find((candidate) => candidate.sessionId === secondSessionId);
      if (event === undefined) throw new Error("second event missing");
      const changes = await ctx.db.query("syncDirectoryChanges").withIndex(
        "by_vault_and_version",
        (query) => query
          .eq("vaultId", event.vaultId)
          .lte("directoryVersionOrderKey", event.directoryVersionOrderKey),
      ).collect();
      const vaultRow = await ctx.db.get(event.vaultId);
      if (changes.length !== 2 || vaultRow === null) {
        throw new Error("second event retention projection missing");
      }
      let removedBytes = 0;
      let removedEvents = 0;
      const entryDeltas = new Map<Id<"syncSessionEntries">, { bytes: number; events: number }>();
      for (const change of changes) {
        if (change.eventId === undefined) throw new Error("event prefix change missing event");
        const retainedEvent = await ctx.db.get(change.eventId);
        if (retainedEvent === null) throw new Error("event prefix payload missing");
        removedBytes += retainedEvent.ciphertextBytes;
        removedEvents += 1;
        const prior = entryDeltas.get(retainedEvent.sessionEntryId) ?? { bytes: 0, events: 0 };
        entryDeltas.set(retainedEvent.sessionEntryId, {
          bytes: prior.bytes + retainedEvent.ciphertextBytes,
          events: prior.events + 1,
        });
        await ctx.db.delete(retainedEvent._id);
        await ctx.db.delete(change._id);
      }
      for (const [entryId, delta] of entryDeltas) {
        const retainedEntry = await ctx.db.get(entryId);
        if (retainedEntry === null) throw new Error("event prefix session missing");
        await ctx.db.patch(retainedEntry._id, {
          retainedEventCount: retainedEntry.retainedEventCount - delta.events,
          retainedCiphertextBytes: retainedEntry.retainedCiphertextBytes - delta.bytes,
        });
      }
      await ctx.db.patch(vaultRow._id, {
        changeFloorVersion: event.directoryVersion,
        retainedEventCount: vaultRow.retainedEventCount - removedEvents,
        retainedCiphertextBytes: vaultRow.retainedCiphertextBytes - removedBytes,
      });
    });
    expect(data(await execute(actor, secondPublishRequest, keys))).toMatchObject({
      kind: "session_accepted",
      replay: true,
      accepted: { envelope: { ciphertextDigest: secondEnvelope.ciphertextDigest } },
    });

    const snapshotId = opaque("syncsnapshot", "p");
    expect(data(await execute(actor, {
      version: 1,
      operation: "begin_snapshot",
      snapshotId,
    }, keys))).toMatchObject({ kind: "snapshot_started", snapshotVersion: "2" });
    const firstSnapshotPage = data(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId,
      pageSize: 1,
    }, keys));
    expect(firstSnapshotPage).toMatchObject({
      kind: "snapshot_page",
      page: { complete: false, snapshotVersion: "2" },
    });
    if (firstSnapshotPage.kind !== "snapshot_page" || firstSnapshotPage.page.nextCursor === undefined) {
      throw new Error("expected a continued snapshot page");
    }
    expect(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId,
      after: { directoryOrdinal: "1", sessionId: opaque("syncsession", "n") },
      pageSize: 1,
    }, keys)).toEqual({ ok: false, code: "CONFLICT" });
    expect(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId,
      after: { directoryOrdinal: "99", sessionId: opaque("syncsession", "n") },
      pageSize: 1,
    }, keys)).toEqual({ ok: false, code: "CONFLICT" });

    const unsignedSecondDelete = {
      version: 1 as const,
      operation: "delete_session" as const,
      sessionId: secondSessionId,
      originDeviceId: opaque("syncdevice", "d"),
      mirrorEpoch: "1" as const,
      writerGeneration: "1" as const,
      bootId,
      bootGeneration: "1" as const,
      membershipEpoch: "1" as const,
      keyEpoch: "1" as const,
      syncSequence: "2" as const,
      sourceRevision: "2" as const,
      previousDigest: secondEnvelope.ciphertextDigest,
    };
    const secondDeleteRequest = sessionSyncBackendRequestSchema.parse({
      ...unsignedSecondDelete,
      tombstoneDigest: await digestSyncRequestBody(unsignedSecondDelete),
    });
    expect(data(await execute(actor, secondDeleteRequest, keys))).toMatchObject({
      kind: "session_deleted",
      replay: false,
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId,
      after: firstSnapshotPage.page.nextCursor,
      pageSize: 1,
    }, keys))).toMatchObject({
      kind: "snapshot_page",
      page: {
        complete: true,
        snapshotVersion: "2",
        entries: [{
          kind: "head",
          accepted: { envelope: { ciphertextDigest: secondEnvelope.ciphertextDigest } },
        }],
      },
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId,
      after: { directoryOrdinal: "2", sessionId: secondSessionId },
      pageSize: 1,
    }, keys))).toMatchObject({
      kind: "snapshot_page",
      page: { complete: true, entries: [] },
    });

    const unsignedDelete = {
      version: 1 as const,
      operation: "delete_session" as const,
      sessionId,
      originDeviceId: opaque("syncdevice", "d"),
      mirrorEpoch: "1" as const,
      writerGeneration: "1" as const,
      bootId,
      bootGeneration: "1" as const,
      membershipEpoch: "1" as const,
      keyEpoch: "1" as const,
      syncSequence: "2" as const,
      sourceRevision: "2" as const,
      previousDigest: envelope.ciphertextDigest,
    };
    const deleteRequest = sessionSyncBackendRequestSchema.parse({
      ...unsignedDelete,
      tombstoneDigest: await digestSyncRequestBody(unsignedDelete),
    });
    expect(data(await execute(actor, deleteRequest, keys))).toMatchObject({
      kind: "session_deleted",
      replay: false,
    });
    expect(await execute(actor, publishRequest, keys)).toMatchObject({
      ok: false,
      code: "RETIRED",
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "change_page",
      afterVersion: "4",
      pageSize: 8,
    }, keys))).toMatchObject({ kind: "change_page", page: { changes: [], nextVersion: "4" } });
    for (const afterVersion of ["5", "18446744073709551615"] as const) {
      expect(data(await execute(actor, {
        version: 1,
        operation: "change_page",
        afterVersion,
        pageSize: 8,
      }, keys))).toEqual({
        kind: "resnapshot_required",
        vault,
        floorVersion: encodeSyncUint64(2n),
      });
    }
    await t.run(async (ctx) => {
      const pins = await ctx.db.query("syncSnapshotPins").collect();
      for (const pin of pins) await ctx.db.patch(pin._id, { expiresAt: 0 });
      const tombstones = await ctx.db.query("syncSessionTombstones").collect();
      const firstTombstone = tombstones.find((tombstone) => tombstone.sessionId === sessionId);
      if (firstTombstone === undefined) throw new Error("first tombstone missing");
      for (const tombstone of tombstones) await ctx.db.patch(tombstone._id, { purgeAfter: 0 });
    });
    expect(await t.mutation(retireExpiredRef, {})).toEqual({
      expiredEnrollments: 0,
      expiredRateBuckets: 0,
      purgedEnrollments: 0,
      retiredReservations: 0,
      retiredSessions: 2,
    });
    expect(await execute(actor, {
      version: 1,
      operation: "reserve_session",
      sessionId,
      creationGrantDigest: `sha256_${"2".repeat(64)}`,
    }, keys)).toMatchObject({ ok: false, code: "RETIRED" });
    expect(data(await execute(actor, {
      version: 1,
      operation: "change_page",
      afterVersion: "4",
      pageSize: 8,
    }, keys))).toMatchObject({
      kind: "change_page",
      page: {
        changes: [{ kind: "retired" }, { kind: "retired" }],
        nextVersion: "6",
        hasMore: false,
      },
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "change_page",
      afterVersion: "2",
      pageSize: 8,
    }, keys))).toEqual({
      kind: "resnapshot_required",
      vault,
      floorVersion: encodeSyncUint64(4n),
    });
    const recoverySnapshotId = opaque("syncsnapshot", "r");
    expect(data(await execute(actor, {
      version: 1,
      operation: "begin_snapshot",
      snapshotId: recoverySnapshotId,
    }, keys))).toMatchObject({ kind: "snapshot_started", snapshotVersion: "6" });
    expect(data(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId: recoverySnapshotId,
      pageSize: 8,
    }, keys))).toMatchObject({
      kind: "snapshot_page",
      page: { complete: true, snapshotVersion: "6" },
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "change_page",
      afterVersion: "6",
      pageSize: 8,
    }, keys))).toMatchObject({
      kind: "change_page",
      page: { changes: [], nextVersion: "6", hasMore: false },
    });
    expect(await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      if (vaultRow === undefined) throw new Error("sync vault missing");
      const entry = await ctx.db.query("syncSessionEntries").withIndex(
        "by_vault_and_session",
        (query) => query.eq("vaultId", vaultRow._id).eq("sessionId", sessionId),
      ).unique();
      if (entry === null) throw new Error("retired entry missing");
      return {
        fences: (await ctx.db.query("syncRetiredSessionIds").collect()).length,
        floorVersion: vaultRow.changeFloorVersion,
        retiredEvents: (await ctx.db.query("syncSessionEvents").withIndex(
          "by_session_and_directory_version",
          (query) => query.eq("sessionEntryId", entry._id),
        ).collect()).length,
        retiredHeads: (await ctx.db.query("syncSessionHeads").withIndex(
          "by_session_entry",
          (query) => query.eq("sessionEntryId", entry._id),
        ).collect()).length,
      };
    })).toEqual({ fences: 2, floorVersion: "4", retiredEvents: 0, retiredHeads: 0 });
  }, 30_000);

  test("makes bounded ciphertext pruning retryable and never commits a later rejected plan", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    const rootKey = createSyncVaultRootKey();
    expect((await bootstrap(actor, keys, rootKey)).ok).toBeTrue();
    const deviceId = opaque("syncdevice", "d");
    const bootId = opaque("syncboot", "q");
    expect(data(await execute(actor, {
      version: 1,
      operation: "establish_boot",
      bootId,
      bootGeneration: "1",
      heartbeatSequence: "1",
    }, keys))).toMatchObject({ kind: "boot_current" });
    const sessionId = opaque("syncsession", "q");
    const creationGrantDigest = `sha256_${"4".repeat(64)}`;
    expect(data(await execute(actor, {
      version: 1,
      operation: "reserve_session",
      sessionId,
      creationGrantDigest,
    }, keys))).toMatchObject({ kind: "session_reserved", directoryOrdinal: "1" });
    expect(data(await execute(actor, {
      version: 1,
      operation: "acquire_writer",
      sessionId,
      bootId,
      bootGeneration: "1",
      acknowledgedMirrorEpoch: "1",
      acknowledgedSequence: "0",
      acknowledgedDigest: null,
    }, keys))).toMatchObject({ kind: "writer_acquired", writerGeneration: "1" });
    const contentKey = await deriveSessionContentKey(rootKey, sessionContentKeyContextSchema.parse({
      version: 1,
      ...vault,
      sessionId,
      keyEpoch: "1",
      originDeviceId: deviceId,
      mirrorEpoch: "1",
      writerGeneration: "1",
    }));
    const baselineEnvelope = await sealSessionSummary(sessionSummarySchema.parse({
      version: 1,
      sessionId,
      ownerDeviceId: deviceId,
      directoryOrdinal: "1",
      sourceRevision: "1",
      title: "q",
      state: "ready",
      deleted: false,
    }), sessionSyncHeaderSchema.parse({
      protocol: "oprte.session-sync/v1",
      payloadVersion: 1,
      payloadKind: "session_summary",
      ...vault,
      membershipEpoch: "1",
      originDeviceId: deviceId,
      sessionId,
      mirrorEpoch: "1",
      writerGeneration: "1",
      bootId,
      bootGeneration: "1",
      directoryOrdinal: "1",
      keyEpoch: "1",
      syncSequence: "1",
      sourceRevision: "1",
      eventKind: "created",
      previousDigest: null,
      creationGrantDigest,
    }), contentKey, allocateSessionSyncNonce(
      createSessionSyncNonceState("1", "1"),
    ).allocation);
    expect(data(await execute(actor, {
      version: 1,
      operation: "publish_session",
      envelope: baselineEnvelope,
    }, keys))).toMatchObject({ kind: "session_accepted" });
    const quotaSnapshotId = opaque("syncsnapshot", "q");
    expect(data(await execute(actor, {
      version: 1,
      operation: "begin_snapshot",
      snapshotId: quotaSnapshotId,
    }, keys))).toMatchObject({ kind: "snapshot_started", snapshotVersion: "1" });

    const zeroEventPrefixCount = 300;
    const poisonEventCount = 1_600;
    await t.run(async (ctx) => {
      const vaultRow = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (vaultRow === null) throw new Error("quota vault missing");
      const entry = await ctx.db.query("syncSessionEntries").withIndex(
        "by_vault_and_session",
        (query) => query.eq("vaultId", vaultRow._id).eq("sessionId", sessionId),
      ).unique();
      if (entry === null) throw new Error("quota session missing");
      const baselineEvent = await ctx.db.query("syncSessionEvents").withIndex(
        "by_session_and_directory_version",
        (query) => query.eq("sessionEntryId", entry._id),
      ).unique();
      if (baselineEvent === null) throw new Error("quota baseline event missing");
      const baselineChange = await ctx.db.query("syncDirectoryChanges").withIndex(
        "by_vault_and_version",
        (query) => query
          .eq("vaultId", vaultRow._id)
          .eq("directoryVersionOrderKey", baselineEvent.directoryVersionOrderKey),
      ).unique();
      if (baselineChange === null) throw new Error("quota baseline change missing");
      await ctx.db.delete(baselineEvent._id);
      await ctx.db.delete(baselineChange._id);
      for (let offset = 0; offset < zeroEventPrefixCount; offset += 1) {
        const directoryVersion = String(offset + 2);
        await ctx.db.insert("syncDirectoryChanges", {
          vaultId: vaultRow._id,
          directoryVersion,
          directoryVersionOrderKey: directoryVersion.padStart(20, "0"),
          kind: "mirror_reset",
          sessionEntryId: entry._id,
          payloadJson: "{}",
          createdAt: offset,
        });
      }
      for (let offset = 0; offset < poisonEventCount; offset += 1) {
        const directoryVersion = String(zeroEventPrefixCount + offset + 2);
        const eventId = await ctx.db.insert("syncSessionEvents", {
          vaultId: vaultRow._id,
          sessionEntryId: entry._id,
          sessionId,
          directoryVersion,
          directoryVersionOrderKey: directoryVersion.padStart(20, "0"),
          mirrorEpoch: "9",
          syncSequence: String(offset + 1),
          sourceRevision: String(offset + 1),
          keyEpoch: "1",
          eventKind: "activity",
          ciphertextDigest: `sha256_${offset.toString(16).padStart(64, "0")}`,
          ciphertextBytes: 1,
          envelopeJson: "{}",
          observedAt: offset,
        });
        await ctx.db.insert("syncDirectoryChanges", {
          vaultId: vaultRow._id,
          directoryVersion,
          directoryVersionOrderKey: directoryVersion.padStart(20, "0"),
          kind: "upsert",
          sessionEntryId: entry._id,
          eventId,
          createdAt: offset,
        });
      }
      const directoryVersion = String(zeroEventPrefixCount + poisonEventCount + 1);
      await ctx.db.patch(entry._id, {
        retainedEventCount: MAX_SYNC_RETAINED_EVENTS,
        retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
      });
      await ctx.db.patch(vaultRow._id, {
        directoryVersion,
        directoryVersionOrderKey: directoryVersion.padStart(20, "0"),
        changeFloorVersion: "1",
        retainedEventCount: MAX_SYNC_RETAINED_EVENTS,
        retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
      });
    });
    const continuationHeader = { ...baselineEnvelope.header };
    delete continuationHeader.creationGrantDigest;
    const nextEnvelope = await sealSessionSummary(sessionSummarySchema.parse({
      version: 1,
      sessionId,
      ownerDeviceId: deviceId,
      directoryOrdinal: "1",
      sourceRevision: "2",
      title: "L".repeat(256),
      repositoryDisplayName: "R".repeat(160),
      state: "working",
      originUpdatedAt: encodeSyncUint64(BigInt(Date.now())),
      deleted: false,
    }), sessionSyncHeaderSchema.parse({
      ...continuationHeader,
      syncSequence: "2",
      sourceRevision: "2",
      eventKind: "turn_started",
      previousDigest: baselineEnvelope.ciphertextDigest,
    }), contentKey, allocateSessionSyncNonce(
      createSessionSyncNonceState("1", "2"),
    ).allocation);
    const publishNext = {
      version: 1 as const,
      operation: "publish_session" as const,
      envelope: nextEnvelope,
    };
    const pinnedState = await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      if (vaultRow === undefined) throw new Error("quota vault missing while pinned");
      return {
        floor: vaultRow.changeFloorVersion,
        eventCount: vaultRow.retainedEventCount,
        bytes: vaultRow.retainedCiphertextBytes,
        rows: (await ctx.db.query("syncSessionEvents").collect()).length,
      };
    });
    expect(await execute(actor, publishNext, keys)).toEqual({
      ok: false,
      code: "QUOTA_EXCEEDED",
    });
    expect(await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      if (vaultRow === undefined) throw new Error("quota vault missing after pinned rejection");
      return {
        floor: vaultRow.changeFloorVersion,
        eventCount: vaultRow.retainedEventCount,
        bytes: vaultRow.retainedCiphertextBytes,
        rows: (await ctx.db.query("syncSessionEvents").collect()).length,
      };
    })).toEqual(pinnedState);
    await t.run(async (ctx) => {
      const pin = (await ctx.db.query("syncSnapshotPins").collect())
        .find((row) => row.snapshotId === quotaSnapshotId);
      if (pin === undefined) throw new Error("quota snapshot pin missing");
      await ctx.db.patch(pin._id, { expiresAt: 0 });
    });
    expect(await t.mutation(retireExpiredRef, {})).toMatchObject({
      retiredReservations: 0,
      retiredSessions: 0,
    });
    expect(await execute(actor, publishNext, keys)).toEqual({
      ok: false,
      code: "RATE_LIMITED",
      retryAfterMs: 1,
    });
    const afterProgress = await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      const entry = (await ctx.db.query("syncSessionEntries").collect())
        .find((row) => row.sessionId === sessionId);
      if (vaultRow === undefined || entry === undefined) throw new Error("quota state missing");
      return {
        floor: vaultRow.changeFloorVersion,
        eventCount: vaultRow.retainedEventCount,
        bytes: vaultRow.retainedCiphertextBytes,
        rows: (await ctx.db.query("syncSessionEvents").collect()).length,
        entryId: entry._id,
        vaultId: vaultRow._id,
      };
    });
    expect(afterProgress.floor).toBe("257");
    expect(afterProgress.eventCount).toBe(MAX_SYNC_RETAINED_EVENTS);
    expect(afterProgress.bytes).toBe(MAX_SYNC_RETAINED_CIPHERTEXT_BYTES);
    expect(afterProgress.rows).toBe(poisonEventCount);

    const neededBytes = nextEnvelope.ciphertextBytes
      + nextEnvelope.ciphertextBytes
      - baselineEnvelope.ciphertextBytes;
    await t.run(async (ctx) => {
      await ctx.db.patch(afterProgress.entryId, {
        retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES - neededBytes + 1,
      });
      await ctx.db.patch(afterProgress.vaultId, {
        activeStreamCount: MAX_SYNC_ACTIVE_STREAMS,
        retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES - neededBytes + 1,
      });
    });
    const beforeLaterRejection = await t.run(async (ctx) => {
      const vaultRow = await ctx.db.get(afterProgress.vaultId);
      if (vaultRow === null) throw new Error("quota vault missing before later rejection");
      return {
        floor: vaultRow.changeFloorVersion,
        eventCount: vaultRow.retainedEventCount,
        bytes: vaultRow.retainedCiphertextBytes,
        rows: (await ctx.db.query("syncSessionEvents").collect()).length,
      };
    });
    expect(await execute(actor, publishNext, keys)).toEqual({ ok: false, code: "QUOTA_EXCEEDED" });
    expect(await t.run(async (ctx) => {
      const vaultRow = await ctx.db.get(afterProgress.vaultId);
      if (vaultRow === null) throw new Error("quota vault missing after later rejection");
      return {
        floor: vaultRow.changeFloorVersion,
        eventCount: vaultRow.retainedEventCount,
        bytes: vaultRow.retainedCiphertextBytes,
        rows: (await ctx.db.query("syncSessionEvents").collect()).length,
      };
    })).toEqual(beforeLaterRejection);

    await t.run(async (ctx) => {
      await ctx.db.patch(afterProgress.entryId, {
        retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
      });
      await ctx.db.patch(afterProgress.vaultId, {
        activeStreamCount: 0,
        retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
      });
    });
    let priorFloor = BigInt(afterProgress.floor);
    let accepted: SessionSyncBackendResponse | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await execute(actor, publishNext, keys);
      if (result.ok) {
        accepted = data(result);
        break;
      }
      expect(result).toEqual({ ok: false, code: "RATE_LIMITED", retryAfterMs: 1 });
      const nextFloor = await t.run(async (ctx) => {
        const vaultRow = await ctx.db.get(afterProgress.vaultId);
        if (vaultRow === null) throw new Error("quota vault missing during retry");
        return BigInt(vaultRow.changeFloorVersion);
      });
      expect(nextFloor).toBeGreaterThan(priorFloor);
      priorFloor = nextFloor;
    }
    expect(accepted).toMatchObject({ kind: "session_accepted", replay: false });
  }, 30_000);

  test("materializes and pages the full 512-entry encrypted directory in exact order", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    const rootKey = createSyncVaultRootKey();
    expect((await bootstrap(actor, keys, rootKey)).ok).toBeTrue();
    const expectedSessionIds: string[] = [];
    await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      const device = (await ctx.db.query("syncDevices").collect())[0];
      if (vaultRow === undefined || device === undefined) throw new Error("sync seed missing");
      const ciphertext = "A".repeat(1_366);
      for (let index = 1; index <= 512; index += 1) {
        const directoryOrdinal = index.toString();
        const sessionId = `syncsession_${index.toString(36).padStart(32, "0")}`;
        expectedSessionIds.push(sessionId);
        const grantDigest = `sha256_${"1".repeat(64)}`;
        const envelope = sealedSessionSummarySchema.parse({
          header: {
            protocol: "oprte.session-sync/v1",
            payloadVersion: 1,
            payloadKind: "session_summary",
            ...vault,
            membershipEpoch: "1",
            originDeviceId: device.deviceId,
            sessionId,
            mirrorEpoch: "1",
            writerGeneration: "1",
            bootId: opaque("syncboot", "m"),
            bootGeneration: "1",
            directoryOrdinal,
            keyEpoch: "1",
            syncSequence: "1",
            sourceRevision: "1",
            eventKind: "created",
            previousDigest: null,
            creationGrantDigest: grantDigest,
          },
          algorithm: "P256-HKDF-SHA256-A256GCM",
          nonce: syncNonceForSequence("1"),
          ciphertext,
          ciphertextBytes: 1_024,
          ciphertextDigest: `sha256_${"2".repeat(64)}`,
        });
        const entryId = await ctx.db.insert("syncSessionEntries", {
          vaultId: vaultRow._id,
          organizationId: vaultRow.organizationId,
          ownerUserId: vaultRow.ownerUserId,
          sessionId,
          originDeviceId: device._id,
          originDevicePublicId: device.deviceId,
          directoryOrdinal,
          directoryOrdinalOrderKey: directoryOrdinal.padStart(20, "0"),
          state: "active",
          creationGrantDigest: grantDigest,
          creationGrantExpiresAt: Date.now() + 60_000,
          creationGrantConsumedAt: Date.now(),
          createdDirectoryVersion: directoryOrdinal,
          mirrorEpoch: "1",
          writerGeneration: "1",
          writerBootId: opaque("syncboot", "m"),
          writerBootGeneration: "1",
          currentSequence: "1",
          currentDigest: envelope.ciphertextDigest,
          currentSourceRevision: "1",
          currentKeyEpoch: "1",
          streamActive: false,
          latestDirectoryVersion: directoryOrdinal,
          latestDirectoryVersionOrderKey: directoryOrdinal.padStart(20, "0"),
          retainedEventCount: 0,
          retainedCiphertextBytes: 1_024,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await ctx.db.insert("syncSessionHeads", {
          vaultId: vaultRow._id,
          sessionEntryId: entryId,
          sessionId,
          directoryOrdinal,
          directoryVersion: directoryOrdinal,
          mirrorEpoch: "1",
          writerGeneration: "1",
          bootId: opaque("syncboot", "m"),
          bootGeneration: "1",
          syncSequence: "1",
          sourceRevision: "1",
          keyEpoch: "1",
          ciphertextDigest: envelope.ciphertextDigest,
          ciphertextBytes: 1_024,
          envelopeJson: canonicalSessionSyncJson(envelope),
          observedAt: Date.now(),
        });
      }
      await ctx.db.patch(vaultRow._id, {
        directoryVersion: "512",
        directoryVersionOrderKey: "512".padStart(20, "0"),
        nextDirectoryOrdinal: "512",
        directorySessionCount: 512,
        retainedCiphertextBytes: 48 + 512 * 1_024,
      });
    });

    const snapshotId = opaque("syncsnapshot", "m");
    expect(data(await execute(actor, {
      version: 1,
      operation: "begin_snapshot",
      snapshotId,
    }, keys))).toMatchObject({ kind: "snapshot_started", snapshotVersion: "512" });
    const observedSessionIds: string[] = [];
    let after: { directoryOrdinal: string; sessionId: string } | undefined;
    for (;;) {
      const response = data(await execute(actor, {
        version: 1,
        operation: "snapshot_page",
        snapshotId,
        ...(after === undefined ? {} : { after }),
        pageSize: 100,
      }, keys));
      if (response.kind !== "snapshot_page") throw new Error("snapshot page missing");
      for (const entry of response.page.entries) {
        if (entry.kind !== "head") throw new Error("unexpected full-directory tombstone");
        observedSessionIds.push(entry.accepted.envelope.header.sessionId);
        expect(entry.accepted.envelope.ciphertextBytes).toBe(1_024);
      }
      if (response.page.complete) break;
      if (response.page.nextCursor === undefined) throw new Error("snapshot cursor missing");
      after = response.page.nextCursor;
    }
    expect(observedSessionIds).toEqual(expectedSessionIds);
    expect(await t.run(async (ctx) =>
      (await ctx.db.query("syncSnapshotEntries").collect()).length)).toBe(512);
  }, 60_000);

  test("requires possession beyond a stolen device selector and keeps tenants opaque", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const foreign = t.withIdentity(identity(FOREIGN_WORKOS_USER_ID));
    const ownerKeys = await createSyncDeviceKeyPairs();
    expect((await bootstrap(actor, ownerKeys, createSyncVaultRootKey())).ok).toBeTrue();

    const request = {
      version: 1 as const,
      operation: "establish_boot" as const,
      bootId: opaque("syncboot", "x"),
      bootGeneration: "1" as const,
      heartbeatSequence: "1" as const,
    };
    const attackerKeys = await createSyncDeviceKeyPairs();
    expect(await execute(actor, request, attackerKeys)).toMatchObject({
      ok: false,
      code: "AUTHORIZATION_DENIED",
    });
    expect(await execute(foreign, request, ownerKeys)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  }, 30_000);

  test("recovers quorum loss with a one-use authority, preserves the retained keyring, and fences lost origins", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const foreign = t.withIdentity(identity(FOREIGN_WORKOS_USER_ID));
    const ownerKeys = await createSyncDeviceKeyPairs();
    const replacementKeys = await createSyncDeviceKeyPairs();
    const rootKey1 = createSyncVaultRootKey();
    const initialRecovery = await generateSyncRecoveryKit(vault, "1", "1", rootKey1);
    expect((await bootstrap(actor, ownerKeys, rootKey1, initialRecovery.authority)).ok).toBeTrue();
    const initialHead = await t.run(async (ctx) => {
      const row = (await ctx.db.query("syncMembershipHeads").collect())[0];
      if (row === undefined) throw new Error("membership head missing");
      return syncMembershipHeadSchema.parse(JSON.parse(row.headJson) as unknown);
    });
    const lostSessionId = opaque("syncsession", "l");
    await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      if (vaultRow === undefined) throw new Error("vault missing");
      const owner = await ctx.db.query("syncDevices").withIndex(
        "by_vault_and_device",
        (query) => query.eq("vaultId", vaultRow._id).eq("deviceId", opaque("syncdevice", "d")),
      ).unique();
      if (owner === null) throw new Error("owner device missing");
      const entryId = await ctx.db.insert("syncSessionEntries", {
        vaultId: vaultRow._id,
        organizationId: vaultRow.organizationId,
        ownerUserId: vaultRow.ownerUserId,
        sessionId: lostSessionId,
        originDeviceId: owner._id,
        originDevicePublicId: owner.deviceId,
        directoryOrdinal: "1",
        directoryOrdinalOrderKey: "00000000000000000001",
        state: "active",
        creationGrantDigest: `sha256_${"4".repeat(64)}`,
        creationGrantExpiresAt: Date.now() + 60_000,
        creationGrantConsumedAt: Date.now(),
        createdDirectoryVersion: "1",
        mirrorEpoch: "1",
        writerGeneration: "1",
        writerBootId: opaque("syncboot", "l"),
        writerBootGeneration: "1",
        currentSequence: "1",
        currentDigest: `sha256_${"5".repeat(64)}`,
        currentSourceRevision: "1",
        currentKeyEpoch: "1",
        streamActive: true,
        latestDirectoryVersion: "1",
        latestDirectoryVersionOrderKey: "00000000000000000001",
        retainedEventCount: 1,
        retainedCiphertextBytes: 17,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("syncSessionEvents", {
        vaultId: vaultRow._id,
        sessionEntryId: entryId,
        sessionId: lostSessionId,
        directoryVersion: "1",
        directoryVersionOrderKey: "00000000000000000001",
        mirrorEpoch: "1",
        syncSequence: "1",
        sourceRevision: "1",
        keyEpoch: "1",
        eventKind: "activity",
        ciphertextDigest: `sha256_${"5".repeat(64)}`,
        ciphertextBytes: 17,
        envelopeJson: "{}",
        observedAt: Date.now(),
      });
      await ctx.db.patch(vaultRow._id, {
        directoryVersion: "1",
        directoryVersionOrderKey: "00000000000000000001",
        directorySessionCount: 1,
        activeStreamCount: 1,
        retainedEventCount: 1,
        retainedCiphertextBytes: vaultRow.retainedCiphertextBytes + 17,
      });
    });

    const openedInitial = await openSyncRecoveryKit(
      initialRecovery.recoveryKit,
      initialRecovery.authority,
    );
    const retainedRoot = openedInitial.vaultRootKeys[0];
    if (retainedRoot === undefined) throw new Error("recovery root key missing");
    const rootKey2 = createSyncVaultRootKey();
    const nextRecovery = await generateSyncRecoveryKit(
      vault,
      "2",
      "2",
      rootKey2,
      [{ keyEpoch: retainedRoot.keyEpoch, rootKey: retainedRoot.rootKey }],
    );
    const replacementId = opaque("syncdevice", "n");
    const replacementMember = {
      deviceId: replacementId,
      name: "Replacement Mac",
      status: "active" as const,
      keys: replacementKeys.publicKeys,
      approvedAt: encodeSyncUint64(BigInt(Date.now())),
    };
    const wrappedRoots = await Promise.all([
      ["1", rootKey1] as const,
      ["2", rootKey2] as const,
    ].map(async ([rootKeyEpoch, rootKey]) => await wrapSyncVaultRootKey(
      rootKey,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "2",
        rootKeyEpoch,
        recipientDeviceId: replacementId,
        recipientAgreementKeyId: replacementKeys.publicKeys.agreement.keyId,
      }),
      replacementKeys.publicKeys.agreement.publicKey,
    )));
    const rootKey2Commitment = await commitSyncVaultRootKey(rootKey2);
    const rootKeyLink = await wrapSyncParentVaultRootKey(
      rootKey1,
      rootKey2,
      syncVaultRootKeyLinkContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "2",
        parentRootKeyEpoch: "1",
        parentRootKeyCommitment: initialHead.statement.rootKeyCommitment,
        childRootKeyEpoch: "2",
        childRootKeyCommitment: rootKey2Commitment,
      }),
    );
    const recoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
      rootKey2,
      syncRecoveryVaultRootWrapContextSchema.parse({
        version: 1,
        vault,
        membershipEpoch: "2",
        recoveryGeneration: "2",
        rootKeyEpoch: "2",
        rootKeyCommitment: rootKey2Commitment,
        recipientRecoveryAgreementKeyId: nextRecovery.authority.agreementKeyId,
      }),
      nextRecovery.authority,
    );
    const replacementStatement = syncMembershipStatementSchema.parse({
      ...vault,
      version: 1,
      membershipEpoch: "2",
      previousMembershipDigest: initialHead.statementDigest,
      recoveryGeneration: "2",
      enrollmentPairingDigest: null,
      rootKeyEpoch: "2",
      rootKeyCommitment: rootKey2Commitment,
      rootWrapManifestDigest: await digestSyncVaultRootWrapManifest(wrappedRoots),
      rootKeyLinkDigest: await digestSyncVaultRootKeyLink(rootKeyLink),
      recoveryRootWrapDigest: await digestSyncRecoveryVaultRootWrap(recoveryRootWrap),
      members: [replacementMember],
    });
    const replacementHead = syncMembershipHeadSchema.parse({
      statement: replacementStatement,
      statementDigest: await digestSyncMembershipStatement(replacementStatement),
      signatures: [await signSyncMembershipStatement(
        replacementStatement,
        replacementId as never,
        replacementKeys.publicKeys.signing.keyId,
        replacementKeys.signingPrivateKey,
      )],
    });
    const issuedAt = Date.now();
    const recoveryStatement = syncRecoveryStatementSchema.parse({
      version: 1,
      vault,
      recoveryNonce: createSyncRecoveryNonce(),
      issuedAt: encodeSyncUint64(BigInt(issuedAt)),
      expiresAt: encodeSyncUint64(BigInt(issuedAt + 60_000)),
      currentMembershipEpoch: "1",
      currentMembershipDigest: initialHead.statementDigest,
      currentRecoveryGeneration: "1",
      currentRootKeyEpoch: "1",
      currentRootKeyCommitment: initialHead.statement.rootKeyCommitment,
      replacementDevice: replacementMember,
      replacementMembershipEpoch: "2",
      replacementMembershipDigest: replacementHead.statementDigest,
      replacementRootKeyEpoch: "2",
      replacementRootKeyCommitment: rootKey2Commitment,
      replacementRootWrapManifestDigest: replacementStatement.rootWrapManifestDigest,
      replacementRecoveryRootWrapDigest: replacementStatement.recoveryRootWrapDigest,
      replacementRootWraps: wrappedRoots.map((wrap) => ({
        keyEpoch: wrap.context.rootKeyEpoch,
        ciphertextDigest: wrap.ciphertextDigest,
      })),
      rootKeyLink,
      nextRecoveryAuthority: nextRecovery.authority,
    });
    const authorization = await signSyncRecoveryStatement(
      recoveryStatement,
      initialRecovery.authority.keyId,
      openedInitial.recoverySigningPrivateKey,
    );
    const replacementProof = await signSyncDeviceProof(syncDeviceProofPayloadSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "2",
      deviceId: replacementId,
      method: "POST",
      route: "sync.membership.recover",
      bodyDigest: authorization.statementDigest,
      nonce: createSyncProofNonce(),
      issuedAt: encodeSyncUint64(BigInt(issuedAt)),
      expiresAt: encodeSyncUint64(BigInt(issuedAt + 60_000)),
    }), replacementKeys.publicKeys.signing.keyId, replacementKeys.signingPrivateKey);
    const recoveryRequest = recoverSyncVaultRequestSchema.parse({
      version: 1,
      authorization,
      membershipHead: replacementHead,
      replacementDeviceProof: replacementProof,
      wrappedRoots,
      recoveryRootWrap,
    });
    const recoveryInvocation = { requestJson: canonicalSessionSyncJson(recoveryRequest) };
    expect(await foreign.action(recoverVaultRef, recoveryInvocation)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(data(await actor.action(recoverVaultRef, recoveryInvocation))).toMatchObject({
      kind: "vault_recovered",
      membershipEpoch: "2",
      recoveryGeneration: "2",
      rootKeyEpoch: "2",
      replay: false,
    });
    expect(data(await actor.action(recoverVaultRef, recoveryInvocation))).toMatchObject({
      kind: "vault_recovered",
      replay: true,
    });
    const refreshedReplacementProof = await signSyncDeviceProof(syncDeviceProofPayloadSchema.parse({
      ...replacementProof.payload,
      nonce: createSyncProofNonce(),
    }), replacementKeys.publicKeys.signing.keyId, replacementKeys.signingPrivateKey);
    const refreshedRecoveryRequest = recoverSyncVaultRequestSchema.parse({
      ...recoveryRequest,
      replacementDeviceProof: refreshedReplacementProof,
    });
    expect(data(await actor.action(recoverVaultRef, {
      requestJson: canonicalSessionSyncJson(refreshedRecoveryRequest),
    }))).toMatchObject({ kind: "vault_recovered", replay: true });
    const staleStatement = syncRecoveryStatementSchema.parse({
      ...recoveryStatement,
      recoveryNonce: createSyncRecoveryNonce(),
    });
    const staleAuthorization = await signSyncRecoveryStatement(
      staleStatement,
      initialRecovery.authority.keyId,
      openedInitial.recoverySigningPrivateKey,
    );
    const staleReplacementProof = await signSyncDeviceProof(syncDeviceProofPayloadSchema.parse({
      ...replacementProof.payload,
      bodyDigest: staleAuthorization.statementDigest,
      nonce: createSyncProofNonce(),
    }), replacementKeys.publicKeys.signing.keyId, replacementKeys.signingPrivateKey);
    const staleRecoveryRequest = recoverSyncVaultRequestSchema.parse({
      ...recoveryRequest,
      authorization: staleAuthorization,
      replacementDeviceProof: staleReplacementProof,
    });
    expect(await actor.action(recoverVaultRef, {
      requestJson: canonicalSessionSyncJson(staleRecoveryRequest),
    })).toEqual({ ok: false, code: "PROOF_INVALID" });
    expect(await execute(actor, {
      version: 1,
      operation: "read_membership",
    }, ownerKeys, "2")).toEqual({ ok: false, code: "AUTHORIZATION_DENIED" });
    const recoveredMembership = data(await execute(actor, {
      version: 1,
      operation: "read_membership",
    }, replacementKeys, "2", replacementId));
    expect(recoveredMembership).toMatchObject({
      kind: "membership",
      wrappedRoot: { context: { rootKeyEpoch: "2" } },
      wrappedRoots: [
        { context: { rootKeyEpoch: "1" } },
        { context: { rootKeyEpoch: "2" } },
      ],
      devicePresence: [{ deviceId: replacementId, connection: "unknown" }],
    });
    if (recoveredMembership.kind !== "membership") {
      throw new Error("recovered membership missing");
    }
    expect(Object.keys(recoveredMembership.devicePresence[0] ?? {}).sort()).toEqual([
      "connection",
      "deviceId",
    ]);
    const replacementBootId = opaque("syncboot", "n");
    expect(data(await execute(actor, {
      version: 1,
      operation: "establish_boot",
      bootId: replacementBootId,
      bootGeneration: "1",
      heartbeatSequence: "1",
    }, replacementKeys, "2", replacementId))).toMatchObject({ kind: "boot_current" });
    expect(data(await execute(actor, {
      version: 1,
      operation: "read_membership",
    }, replacementKeys, "2", replacementId))).toMatchObject({
      kind: "membership",
      devicePresence: [{ deviceId: replacementId, connection: "online" }],
    });
    expect(await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      const entry = (await ctx.db.query("syncSessionEntries").collect())[0];
      const devices = await ctx.db.query("syncDevices").collect();
      return {
        activeStreamCount: vaultRow?.activeStreamCount,
        recoveryGeneration: vaultRow?.recoveryGeneration,
        retainedRootKeyEpochs: vaultRow?.retainedRootKeyEpochs,
        mirrorEpoch: entry?.mirrorEpoch,
        streamActive: entry?.streamActive,
        statuses: devices.map((device) => [device.deviceId, device.status]).sort(),
        recoveryReceipts: (await ctx.db.query("syncRecoveryTransitions").collect()).length,
      };
    })).toEqual({
      activeStreamCount: 0,
      recoveryGeneration: "2",
      retainedRootKeyEpochs: ["1", "2"],
      mirrorEpoch: "2",
      streamActive: false,
      statuses: [
        [opaque("syncdevice", "d"), "revoked"],
        [replacementId, "active"],
      ].sort(),
      recoveryReceipts: 1,
    });
    for (const item of openedInitial.vaultRootKeys) item.rootKey.fill(0);
    rootKey1.fill(0);
    rootKey2.fill(0);
  }, 30_000);

  test("admits a quorum-approved device then makes revocation and root rotation immediate", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const foreign = t.withIdentity(identity(FOREIGN_WORKOS_USER_ID));
    const ownerKeys = await createSyncDeviceKeyPairs();
    const joiningCustody = await generateSyncDeviceKeyCustody();
    const joiningKeys = await importSyncDeviceKeyPairs(
      joiningCustody.privateKeyMaterial,
      joiningCustody.publicKeys,
    );
    const rootKey = createSyncVaultRootKey();
    const recovery = await generateSyncRecoveryKit(vault, "1", "1", rootKey);
    expect((await bootstrap(actor, ownerKeys, rootKey, recovery.authority)).ok).toBeTrue();
    const currentHead = await t.run(async (ctx) => {
      const row = await ctx.db.query("syncMembershipHeads").collect();
      if (row[0] === undefined) throw new Error("membership head missing");
      return syncMembershipHeadSchema.parse(JSON.parse(row[0].headJson) as unknown);
    });
    const ownerId = opaque("syncdevice", "d");
    const joiningId = opaque("syncdevice", "e");
    const enrollmentIntent = submitSyncEnrollmentIntentSchema.parse({
      version: 1 as const,
      vaultId: vault.vaultId,
      vaultGeneration: vault.vaultGeneration,
      deviceId: joiningId,
      name: "Observer Mac",
      keys: joiningKeys.publicKeys,
    });
    const enrollmentRequest = {
      ...enrollmentIntent,
      possessionProof: await enrollmentPossessionProof(
        "submit",
        enrollmentIntent,
        joiningCustody,
      ),
    };
    const submitted = data(await actor.action(submitEnrollmentRef, {
      requestJson: canonicalSessionSyncJson(enrollmentRequest),
    }));
    expect(submitted).toMatchObject({
      kind: "enrollment_submitted",
      deviceId: joiningId,
      replay: false,
    });
    if (submitted.kind !== "enrollment_submitted") {
      throw new Error("expected enrollment submission");
    }
    const claimIntent = claimSyncEnrollmentIntentSchema.parse({
      version: 1 as const,
      vaultId: vault.vaultId,
      vaultGeneration: vault.vaultGeneration,
      requestId: submitted.requestId,
      deviceId: joiningId,
      keys: joiningKeys.publicKeys,
      pairingDigest: submitted.pairingDigest,
    });
    const claimRequest = {
      ...claimIntent,
      possessionProof: await enrollmentPossessionProof("claim", claimIntent, joiningCustody),
    };
    expect(data(await actor.action(submitEnrollmentRef, {
      requestJson: canonicalSessionSyncJson(enrollmentRequest),
    }))).toMatchObject({
      kind: "enrollment_submitted",
      requestId: submitted.requestId,
      replay: true,
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "list_enrollment_requests",
    }, ownerKeys))).toMatchObject({
      kind: "enrollment_requests",
      vault,
      requests: [{ requestId: submitted.requestId, deviceId: joiningId }],
    });
    expect(data(await actor.action(claimEnrollmentRef, {
      requestJson: canonicalSessionSyncJson(claimRequest),
    }))).toMatchObject({
      kind: "enrollment_pending",
      requestId: submitted.requestId,
    });
    expect(await foreign.action(claimEnrollmentRef, {
      requestJson: canonicalSessionSyncJson(claimRequest),
    })).toEqual({ ok: false, code: "NOT_FOUND" });
    const epoch2Wraps = await Promise.all([
      [ownerId, ownerKeys] as const,
      [joiningId, joiningKeys] as const,
    ].map(async ([deviceId, keys]) => await wrapSyncVaultRootKey(rootKey, syncVaultRootWrapContextSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "2",
      rootKeyEpoch: "1",
      recipientDeviceId: deviceId,
      recipientAgreementKeyId: keys.publicKeys.agreement.keyId,
    }), keys.publicKeys.agreement.publicKey)));
    const epoch2RecoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
      rootKey,
      syncRecoveryVaultRootWrapContextSchema.parse({
        version: 1,
        vault,
        membershipEpoch: "2",
        recoveryGeneration: "1",
        rootKeyEpoch: "1",
        rootKeyCommitment: currentHead.statement.rootKeyCommitment,
        recipientRecoveryAgreementKeyId: recovery.authority.agreementKeyId,
      }),
      recovery.authority,
    );
    const epoch2Statement = syncMembershipStatementSchema.parse({
      ...currentHead.statement,
      membershipEpoch: "2",
      previousMembershipDigest: currentHead.statementDigest,
      enrollmentPairingDigest: submitted.pairingDigest,
      rootWrapManifestDigest: await digestSyncVaultRootWrapManifest(epoch2Wraps),
      recoveryRootWrapDigest: await digestSyncRecoveryVaultRootWrap(epoch2RecoveryRootWrap),
      members: [
        currentHead.statement.members[0],
        {
          deviceId: joiningId,
          name: "Observer Mac",
          status: "active",
          keys: joiningKeys.publicKeys,
          approvedAt: encodeSyncUint64(BigInt(Date.now())),
        },
      ],
    });
    const epoch2Head: SyncMembershipHead = {
      statement: epoch2Statement,
      statementDigest: await digestSyncMembershipStatement(epoch2Statement),
      signatures: [await signSyncMembershipStatement(
        epoch2Statement,
        ownerId as never,
        ownerKeys.publicKeys.signing.keyId,
        ownerKeys.signingPrivateKey,
      )],
    };
    const approvalRequest = {
      version: 1,
      operation: "approve_enrollment" as const,
      requestId: submitted.requestId,
      pairingDigest: submitted.pairingDigest,
      membershipHead: epoch2Head,
      wrappedRoots: epoch2Wraps,
      recoveryRootWrap: epoch2RecoveryRootWrap,
    };
    const epoch2Admission = {
      version: 1 as const,
      operation: "admit_membership_proposal" as const,
      proposalKind: "enrollment" as const,
      enrollmentRequestId: submitted.requestId,
      pairingDigest: submitted.pairingDigest,
      membershipCandidate: {
        statement: epoch2Head.statement,
        statementDigest: epoch2Head.statementDigest,
      },
      wrappedRoots: epoch2Wraps,
      recoveryRootWrap: epoch2RecoveryRootWrap,
    };
    expect(data(await execute(actor, epoch2Admission, ownerKeys))).toMatchObject({
      kind: "membership_pending",
      proposal: {
        candidate: { statementDigest: epoch2Head.statementDigest },
        collectedVotes: 0,
        irrevocable: true,
        signingIntentDeviceIds: [ownerId],
      },
    });
    expect(data(await execute(actor, approvalRequest, ownerKeys))).toMatchObject({
      kind: "enrollment_approved",
      requestId: submitted.requestId,
      membershipEpoch: "2",
    });
    expect(data(await execute(actor, approvalRequest, ownerKeys, "2"))).toMatchObject({
      kind: "enrollment_approved",
      requestId: submitted.requestId,
      membershipEpoch: "2",
    });
    expect(data(await actor.action(claimEnrollmentRef, {
      requestJson: canonicalSessionSyncJson(claimRequest),
    }))).toMatchObject({
      kind: "enrollment_claimed",
      requestId: submitted.requestId,
      head: { statementDigest: epoch2Head.statementDigest },
      wrappedRoot: { context: { recipientDeviceId: joiningId } },
    });

    const revokedOriginSessionId = opaque("syncsession", "r");
    const revokedOriginBootId = opaque("syncboot", "r");
    const revokedOriginContentKey = await deriveSessionContentKey(
      rootKey,
      sessionContentKeyContextSchema.parse({
        version: 1,
        ...vault,
        sessionId: revokedOriginSessionId,
        keyEpoch: "1",
        originDeviceId: joiningId,
        mirrorEpoch: "1",
        writerGeneration: "1",
      }),
    );
    const revokedOriginEnvelope = await sealSessionSummary(sessionSummarySchema.parse({
      version: 1,
      sessionId: revokedOriginSessionId,
      ownerDeviceId: joiningId,
      directoryOrdinal: "1",
      sourceRevision: "1",
      title: "Offline device work",
      state: "ready",
      deleted: false,
    }), sessionSyncHeaderSchema.parse({
      protocol: "oprte.session-sync/v1",
      payloadVersion: 1,
      payloadKind: "session_summary",
      ...vault,
      membershipEpoch: "2",
      originDeviceId: joiningId,
      sessionId: revokedOriginSessionId,
      mirrorEpoch: "1",
      writerGeneration: "1",
      bootId: revokedOriginBootId,
      bootGeneration: "1",
      directoryOrdinal: "1",
      keyEpoch: "1",
      syncSequence: "1",
      sourceRevision: "1",
      eventKind: "created",
      previousDigest: null,
      creationGrantDigest: `sha256_${"7".repeat(64)}`,
    }), revokedOriginContentKey, allocateSessionSyncNonce(
      createSessionSyncNonceState("1", "1"),
    ).allocation);
    const revokedOriginEnvelopeJson = canonicalSessionSyncJson(revokedOriginEnvelope);
    const revokedOriginRetainedBytes = revokedOriginEnvelope.ciphertextBytes * 2;
    await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      if (vaultRow === undefined) throw new Error("vault missing");
      const joined = await ctx.db.query("syncDevices").withIndex(
        "by_vault_and_device",
        (query) => query.eq("vaultId", vaultRow._id).eq("deviceId", joiningId),
      ).unique();
      if (joined === null) throw new Error("joined device missing");
      const entryId = await ctx.db.insert("syncSessionEntries", {
        vaultId: vaultRow._id,
        organizationId: vaultRow.organizationId,
        ownerUserId: vaultRow.ownerUserId,
        sessionId: revokedOriginSessionId,
        originDeviceId: joined._id,
        originDevicePublicId: joined.deviceId,
        directoryOrdinal: "1",
        directoryOrdinalOrderKey: "00000000000000000001",
        state: "active",
        creationGrantDigest: `sha256_${"7".repeat(64)}`,
        creationGrantExpiresAt: Date.now() + 60_000,
        creationGrantConsumedAt: Date.now(),
        createdDirectoryVersion: "1",
        mirrorEpoch: "1",
        writerGeneration: "1",
        writerBootId: revokedOriginBootId,
        writerBootGeneration: "1",
        currentSequence: "1",
        currentDigest: revokedOriginEnvelope.ciphertextDigest,
        currentSourceRevision: "1",
        currentKeyEpoch: "1",
        streamActive: true,
        latestDirectoryVersion: "1",
        latestDirectoryVersionOrderKey: "00000000000000000001",
        retainedEventCount: 1,
        retainedCiphertextBytes: revokedOriginRetainedBytes,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("syncSessionEvents", {
        vaultId: vaultRow._id,
        sessionEntryId: entryId,
        sessionId: revokedOriginSessionId,
        directoryVersion: "1",
        directoryVersionOrderKey: "00000000000000000001",
        mirrorEpoch: "1",
        syncSequence: "1",
        sourceRevision: "1",
        keyEpoch: "1",
        eventKind: "activity",
        ciphertextDigest: revokedOriginEnvelope.ciphertextDigest,
        ciphertextBytes: revokedOriginEnvelope.ciphertextBytes,
        envelopeJson: revokedOriginEnvelopeJson,
        observedAt: Date.now(),
      });
      await ctx.db.insert("syncSessionHeads", {
        vaultId: vaultRow._id,
        sessionEntryId: entryId,
        sessionId: revokedOriginSessionId,
        directoryOrdinal: "1",
        directoryVersion: "1",
        mirrorEpoch: "1",
        writerGeneration: "1",
        bootId: revokedOriginBootId,
        bootGeneration: "1",
        syncSequence: "1",
        sourceRevision: "1",
        keyEpoch: "1",
        ciphertextDigest: revokedOriginEnvelope.ciphertextDigest,
        ciphertextBytes: revokedOriginEnvelope.ciphertextBytes,
        envelopeJson: revokedOriginEnvelopeJson,
        observedAt: Date.now(),
      });
      await ctx.db.patch(vaultRow._id, {
        directoryVersion: "1",
        directoryVersionOrderKey: "00000000000000000001",
        directorySessionCount: 1,
        activeStreamCount: 1,
        retainedEventCount: 1,
        retainedCiphertextBytes:
          vaultRow.retainedCiphertextBytes + revokedOriginRetainedBytes,
      });
    });

    const rotatedRoot = createSyncVaultRootKey();
    const rotatedRootCommitment = await commitSyncVaultRootKey(rotatedRoot);
    const rotatedWraps = await Promise.all([
      ["1", rootKey] as const,
      ["2", rotatedRoot] as const,
    ].map(async ([rootKeyEpoch, key]) => await wrapSyncVaultRootKey(
      key,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "3",
        rootKeyEpoch,
        recipientDeviceId: ownerId,
        recipientAgreementKeyId: ownerKeys.publicKeys.agreement.keyId,
      }),
      ownerKeys.publicKeys.agreement.publicKey,
    )));
    const epoch3RootKeyLink = await wrapSyncParentVaultRootKey(
      rootKey,
      rotatedRoot,
      syncVaultRootKeyLinkContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "3",
        parentRootKeyEpoch: "1",
        parentRootKeyCommitment: currentHead.statement.rootKeyCommitment,
        childRootKeyEpoch: "2",
        childRootKeyCommitment: rotatedRootCommitment,
      }),
    );
    const epoch3RecoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
      rotatedRoot,
      syncRecoveryVaultRootWrapContextSchema.parse({
        version: 1,
        vault,
        membershipEpoch: "3",
        recoveryGeneration: "1",
        rootKeyEpoch: "2",
        rootKeyCommitment: rotatedRootCommitment,
        recipientRecoveryAgreementKeyId: recovery.authority.agreementKeyId,
      }),
      recovery.authority,
    );
    const epoch3Statement = syncMembershipStatementSchema.parse({
      ...epoch2Statement,
      membershipEpoch: "3",
      previousMembershipDigest: epoch2Head.statementDigest,
      enrollmentPairingDigest: null,
      rootKeyEpoch: "2",
      rootKeyCommitment: rotatedRootCommitment,
      rootWrapManifestDigest: await digestSyncVaultRootWrapManifest(rotatedWraps),
      rootKeyLinkDigest: await digestSyncVaultRootKeyLink(epoch3RootKeyLink),
      recoveryRootWrapDigest: await digestSyncRecoveryVaultRootWrap(epoch3RecoveryRootWrap),
      members: [
        epoch2Statement.members[0],
        {
          ...epoch2Statement.members[1],
          status: "revoked",
          revokedAt: encodeSyncUint64(BigInt(Date.now())),
        },
      ],
    });
    const epoch3Head: SyncMembershipHead = {
      statement: epoch3Statement,
      statementDigest: await digestSyncMembershipStatement(epoch3Statement),
      signatures: await Promise.all([
        [ownerId, ownerKeys] as const,
        [joiningId, joiningKeys] as const,
      ].map(async ([deviceId, keys]) => await signSyncMembershipStatement(
        epoch3Statement,
        deviceId as never,
        keys.publicKeys.signing.keyId,
        keys.signingPrivateKey,
      ))),
    };
    const epoch3AdmissionRequest = sessionSyncBackendRequestSchema.parse({
      version: 1,
      operation: "admit_membership_proposal",
      proposalKind: "update",
      membershipCandidate: {
        statement: epoch3Head.statement,
        statementDigest: epoch3Head.statementDigest,
      },
      wrappedRoots: rotatedWraps,
      rootKeyLink: epoch3RootKeyLink,
      recoveryRootWrap: epoch3RecoveryRootWrap,
    });
    const corruptedCurrentWrap = await t.run(async (ctx) => {
      const vaultRow = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (vaultRow === null) throw new Error("vault missing before corruption law");
      const rows = await ctx.db.query("syncVaultRootWraps").withIndex(
        "by_vault_and_membership",
        (query) => query.eq("vaultId", vaultRow._id).eq("membershipEpoch", "2"),
      ).collect();
      const ownerWrap = rows.find((row) => row.recipientDeviceId === ownerId);
      const joiningWrap = rows.find((row) => row.recipientDeviceId === joiningId);
      if (ownerWrap === undefined || joiningWrap === undefined) {
        throw new Error("epoch two wrap matrix missing");
      }
      await ctx.db.patch(ownerWrap._id, { wrappedRootJson: joiningWrap.wrappedRootJson });
      return { id: ownerWrap._id, wrappedRootJson: ownerWrap.wrappedRootJson };
    });
    expect(await execute(actor, epoch3AdmissionRequest, ownerKeys, "2")).toEqual({
      ok: false,
      code: "CONFLICT",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(corruptedCurrentWrap.id, {
        wrappedRootJson: corruptedCurrentWrap.wrappedRootJson,
      });
      const vaultRow = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (vaultRow === null) throw new Error("vault missing before combined quota law");
      await ctx.db.patch(vaultRow._id, {
        compatibilityEvidenceCiphertextBytes:
          MAX_SYNC_RETAINED_CIPHERTEXT_BYTES - vaultRow.retainedCiphertextBytes - 192 + 1,
      });
    });
    expect(await execute(actor, epoch3AdmissionRequest, ownerKeys, "2")).toEqual({
      ok: false,
      code: "QUOTA_EXCEEDED",
    });
    await t.run(async (ctx) => {
      const vaultRow = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (vaultRow === null) throw new Error("vault missing after combined quota law");
      await ctx.db.patch(vaultRow._id, {
        compatibilityEvidenceCiphertextBytes:
          MAX_SYNC_RETAINED_CIPHERTEXT_BYTES - vaultRow.retainedCiphertextBytes - 192,
      });
    });
    expect(data(await execute(actor, epoch3AdmissionRequest, ownerKeys, "2"))).toMatchObject({
      kind: "membership_pending",
      proposal: { collectedVotes: 0, irrevocable: true },
    });
    await t.run(async (ctx) => {
      const vaultRow = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (vaultRow === null) throw new Error("vault missing after exact combined quota law");
      await ctx.db.patch(vaultRow._id, { compatibilityEvidenceCiphertextBytes: 96 });
    });
    expect(data(await execute(
      actor,
      epoch3AdmissionRequest,
      joiningKeys,
      "2",
      joiningId,
    ))).toMatchObject({
      kind: "membership_pending",
      proposal: {
        collectedVotes: 0,
        irrevocable: true,
        signingIntentDeviceIds: expect.arrayContaining([ownerId, joiningId]),
      },
    });
    const epoch3UpdateRequest = sessionSyncBackendRequestSchema.parse({
      version: 1,
      operation: "update_membership",
      membershipHead: epoch3Head,
      wrappedRoots: rotatedWraps,
      rootKeyLink: epoch3RootKeyLink,
      recoveryRootWrap: epoch3RecoveryRootWrap,
    });
    const invalidSecondSignerRequest = sessionSyncBackendRequestSchema.parse({
      ...epoch3UpdateRequest,
      membershipHead: {
        ...epoch3Head,
        signatures: [
          epoch3Head.signatures[0],
          {
            ...epoch3Head.signatures[1],
            deviceId: opaque("syncdevice", "z"),
          },
        ],
      },
    });
    const invalidSecondSignerDigest = await digestSyncRequestBody(invalidSecondSignerRequest);
    const invalidSecondSignerProof = await proofFor(
      invalidSecondSignerRequest,
      ownerKeys,
      "2",
      ownerId,
    );
    expect(await actor.mutation(commitAuthenticatedRef, {
      requestJson: canonicalSessionSyncJson(invalidSecondSignerRequest),
      proofJson: canonicalSessionSyncJson(invalidSecondSignerProof),
      verifiedBodyDigest: invalidSecondSignerDigest,
    })).toEqual({ ok: false, code: "AUTHORIZATION_DENIED" });
    expect(await t.run(async (ctx) => (
      await ctx.db.query("syncMembershipVotes").collect()
    ).length)).toBe(0);
    expect(data(await execute(actor, epoch3UpdateRequest, ownerKeys, "2"))).toMatchObject({
      kind: "membership_accepted",
      membershipEpoch: "3",
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "read_membership",
    }, ownerKeys, "3"))).toMatchObject({
      kind: "membership",
      devicePresence: [
        { deviceId: ownerId, connection: "unknown" },
        { deviceId: joiningId, connection: "offline" },
      ],
    });
    expect(await t.run(async (ctx) => {
      const vaultRow = (await ctx.db.query("syncVaults").collect())[0];
      const joined = await ctx.db.query("syncDevices").withIndex(
        "by_vault_and_device",
        (query) => query.eq("vaultId", vaultRow!._id).eq("deviceId", joiningId),
      ).unique();
      const entry = await ctx.db.query("syncSessionEntries").withIndex(
        "by_vault_and_session",
        (query) => query.eq("vaultId", vaultRow!._id).eq("sessionId", revokedOriginSessionId),
      ).unique();
      const wraps = await ctx.db.query("syncVaultRootWraps").withIndex(
        "by_vault_and_membership",
        (query) => query
          .eq("vaultId", vaultRow!._id)
          .eq("membershipEpoch", "3"),
      ).filter((query) => query.eq(query.field("recipientDeviceId"), ownerId)).collect();
      const rootEvidence = await ctx.db.query("syncVaultRootWrapEvidence").collect();
      const recoveryEvidence = await ctx.db.query("syncRecoveryRootWrapEvidence").collect();
      const currentRecovery = await ctx.db.query("syncRecoveryRootWraps").collect();
      return {
        activeDeviceCount: vaultRow?.activeDeviceCount,
        activeStreamCount: vaultRow?.activeStreamCount,
        membershipEpoch: vaultRow?.membershipEpoch,
        rootKeyEpoch: vaultRow?.rootKeyEpoch,
        retainedRootKeyEpochs: vaultRow?.retainedRootKeyEpochs,
        joinedStatus: joined?.status,
        revokedMirrorEpoch: entry?.mirrorEpoch,
        revokedStreamActive: entry?.streamActive,
        retainedCiphertextBytes: vaultRow?.retainedCiphertextBytes,
        compatibilityEvidenceCiphertextBytes: vaultRow?.compatibilityEvidenceCiphertextBytes,
        rootEvidenceRows: rootEvidence.length,
        recoveryEvidenceRows: recoveryEvidence.length,
        currentRecoveryRows: currentRecovery.length,
        wrappedEpochs: wraps.map((wrap) => wrap.rootKeyEpoch).sort(),
      };
    })).toEqual({
      activeDeviceCount: 1,
      activeStreamCount: 0,
      membershipEpoch: "3",
      rootKeyEpoch: "2",
      retainedRootKeyEpochs: ["1", "2"],
      joinedStatus: "revoked",
      revokedMirrorEpoch: "2",
      revokedStreamActive: false,
      retainedCiphertextBytes: 192 + revokedOriginRetainedBytes,
      compatibilityEvidenceCiphertextBytes: 240,
      rootEvidenceRows: 3,
      recoveryEvidenceRows: 2,
      currentRecoveryRows: 1,
      wrappedEpochs: ["1", "2"],
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "change_page",
      afterVersion: "1",
      pageSize: 8,
    }, ownerKeys, "3"))).toMatchObject({
      kind: "change_page",
      page: {
        changes: [{ kind: "mirror_reset", sessionId: revokedOriginSessionId }],
        nextVersion: "2",
      },
    });
    const postRevocationSnapshotId = opaque("syncsnapshot", "v");
    expect(data(await execute(actor, {
      version: 1,
      operation: "begin_snapshot",
      snapshotId: postRevocationSnapshotId,
    }, ownerKeys, "3"))).toMatchObject({
      kind: "snapshot_started",
      vault,
      snapshotVersion: "2",
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "snapshot_page",
      snapshotId: postRevocationSnapshotId,
      pageSize: 8,
    }, ownerKeys, "3"))).toMatchObject({
      kind: "snapshot_page",
      page: {
        complete: true,
        entries: [{
          kind: "offline",
          accepted: {
            envelope: {
              ciphertextDigest: revokedOriginEnvelope.ciphertextDigest,
              header: { membershipEpoch: "2", mirrorEpoch: "1" },
            },
            directoryVersion: "1",
          },
          reset: {
            kind: "mirror_reset",
            sessionId: revokedOriginSessionId,
            directoryOrdinal: "1",
            directoryVersion: "2",
            mirrorEpoch: "2",
            resetDigest: revokedOriginEnvelope.ciphertextDigest,
          },
        }],
      },
    });
    const compactedWraps = await Promise.all([
      ["1", rootKey] as const,
      ["2", rotatedRoot] as const,
    ].map(async ([rootKeyEpoch, key]) => await wrapSyncVaultRootKey(
      key,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "4",
        rootKeyEpoch,
        recipientDeviceId: ownerId,
        recipientAgreementKeyId: ownerKeys.publicKeys.agreement.keyId,
      }),
      ownerKeys.publicKeys.agreement.publicKey,
    )));
    const compactedRecoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
      rotatedRoot,
      syncRecoveryVaultRootWrapContextSchema.parse({
        version: 1,
        vault,
        membershipEpoch: "4",
        recoveryGeneration: "1",
        rootKeyEpoch: "2",
        rootKeyCommitment: rotatedRootCommitment,
        recipientRecoveryAgreementKeyId: recovery.authority.agreementKeyId,
      }),
      recovery.authority,
    );
    const compactedStatement = syncMembershipStatementSchema.parse({
      ...epoch3Statement,
      membershipEpoch: "4",
      previousMembershipDigest: epoch3Head.statementDigest,
      enrollmentPairingDigest: null,
      rootWrapManifestDigest: await digestSyncVaultRootWrapManifest(compactedWraps),
      rootKeyLinkDigest: null,
      recoveryRootWrapDigest: await digestSyncRecoveryVaultRootWrap(compactedRecoveryRootWrap),
      members: [epoch3Statement.members[0]],
    });
    const compactedHead = syncMembershipHeadSchema.parse({
      statement: compactedStatement,
      statementDigest: await digestSyncMembershipStatement(compactedStatement),
      signatures: [await signSyncMembershipStatement(
        compactedStatement,
        ownerId as never,
        ownerKeys.publicKeys.signing.keyId,
        ownerKeys.signingPrivateKey,
      )],
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "admit_membership_proposal",
      proposalKind: "update",
      membershipCandidate: {
        statement: compactedHead.statement,
        statementDigest: compactedHead.statementDigest,
      },
      wrappedRoots: compactedWraps,
      recoveryRootWrap: compactedRecoveryRootWrap,
    }, ownerKeys, "3"))).toMatchObject({
      kind: "membership_pending",
      proposal: { collectedVotes: 0, irrevocable: true },
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "update_membership",
      membershipHead: compactedHead,
      wrappedRoots: compactedWraps,
      recoveryRootWrap: compactedRecoveryRootWrap,
    }, ownerKeys, "3"))).toMatchObject({ kind: "membership_accepted", membershipEpoch: "4" });
    expect(await t.run(async (ctx) => {
      const devices = await ctx.db.query("syncDevices").collect();
      const head = (await ctx.db.query("syncMembershipHeads").withIndex(
        "by_vault_and_digest",
        (query) => query.eq("vaultId", devices[0]!.vaultId).eq("statementDigest", compactedHead.statementDigest),
      ).unique());
      const vaultRow = await ctx.db.get(devices[0]!.vaultId);
      return {
        durableDeviceRows: devices.length,
        activeDevices: devices.filter((device) => device.status === "active").length,
        compactedMembers: syncMembershipHeadSchema.parse(JSON.parse(head!.headJson) as unknown)
          .statement.members.length,
        retainedCiphertextBytes: vaultRow?.retainedCiphertextBytes,
        compatibilityEvidenceCiphertextBytes: vaultRow?.compatibilityEvidenceCiphertextBytes,
        rootEvidenceRows: (await ctx.db.query("syncVaultRootWrapEvidence").collect()).length,
        recoveryEvidenceRows:
          (await ctx.db.query("syncRecoveryRootWrapEvidence").collect()).length,
        currentRootRows: (await ctx.db.query("syncVaultRootWraps").collect()).length,
        currentRecoveryRows: (await ctx.db.query("syncRecoveryRootWraps").collect()).length,
      };
    })).toEqual({
      durableDeviceRows: 2,
      activeDevices: 1,
      compactedMembers: 1,
      retainedCiphertextBytes: 192 + revokedOriginRetainedBytes,
      compatibilityEvidenceCiphertextBytes: 384,
      rootEvidenceRows: 5,
      recoveryEvidenceRows: 3,
      currentRootRows: 2,
      currentRecoveryRows: 1,
    });
  }, 30_000);

  test("consumes each signed proof once", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    expect((await bootstrap(actor, keys, createSyncVaultRootKey())).ok).toBeTrue();
    const request = {
      version: 1 as const,
      operation: "establish_boot" as const,
      bootId: opaque("syncboot", "r"),
      bootGeneration: "1" as const,
      heartbeatSequence: "1" as const,
    };
    const proof = await proofFor(request, keys);
    const args = {
      requestJson: canonicalSessionSyncJson(request),
      proofJson: canonicalSessionSyncJson(proof),
    };
    expect(await actor.action(executeRef, args)).toMatchObject({ ok: true });
    expect(await actor.action(executeRef, args)).toEqual({ ok: false, code: "PROOF_REPLAYED" });
  }, 30_000);

  test("authenticates, kill-switches, and rate-bounds negotiation before capability disclosure", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const request = (authorization: string) => ({
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        helloJson: JSON.stringify({
          protocol: "oprte.session-sync/v1",
          minimumVersion: 1,
          maximumVersion: 1,
          capabilities: [
            "device_enrollment",
            "summary_publication",
            "remote_observation",
          ],
        }),
      }),
    });

    process.env.HRA_SESSION_SYNC_ENABLED = "false";
    const disabled = await actor.fetch(
      sessionSyncHttpRoutes.negotiate,
      request("Bearer valid.fixture.token"),
    );
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual({ ok: false, code: "AUTHORIZATION_DENIED" });

    process.env.HRA_SESSION_SYNC_ENABLED = "true";
    for (const authorization of ["Bearer arbitrary-or-expired", "Basic malformed"]) {
      const unauthenticated = await t.fetch(
        sessionSyncHttpRoutes.negotiate,
        request(authorization),
      );
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({
        ok: false,
        code: "AUTHENTICATION_FAILED",
      });
    }

    const accepted = await actor.fetch(
      sessionSyncHttpRoutes.negotiate,
      request("Bearer valid.fixture.token"),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      outcome: "accepted",
      version: 1,
      capabilities: [
        "device_enrollment",
        "summary_publication",
        "remote_observation",
      ],
    });
    for (let attempt = 1; attempt < 30; attempt += 1) {
      expect((await actor.fetch(
        sessionSyncHttpRoutes.negotiate,
        request("Bearer valid.fixture.token"),
      )).status).toBe(200);
    }
    const limited = await actor.fetch(
      sessionSyncHttpRoutes.negotiate,
      request("Bearer valid.fixture.token"),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  }, 30_000);

  test("server-assigns a fenced boot generation after local database loss and replays only the exact establishment", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    expect((await bootstrap(actor, keys, createSyncVaultRootKey())).ok).toBeTrue();
    const firstBoot = {
      version: 1 as const,
      operation: "establish_boot" as const,
      bootId: opaque("syncboot", "f"),
      heartbeatSequence: "1" as const,
    };
    expect(data(await execute(actor, firstBoot, keys))).toMatchObject({
      kind: "boot_current",
      bootGeneration: "1",
      heartbeatSequence: "1",
    });
    expect(data(await execute(actor, firstBoot, keys))).toMatchObject({
      kind: "boot_current",
      bootGeneration: "1",
      heartbeatSequence: "1",
    });
    expect(data(await execute(actor, {
      version: 1,
      operation: "heartbeat",
      bootId: firstBoot.bootId,
      bootGeneration: "1",
      heartbeatSequence: "2",
    }, keys))).toMatchObject({ heartbeatSequence: "2" });
    expect(data(await execute(actor, firstBoot, keys))).toMatchObject({
      bootGeneration: "1",
      heartbeatSequence: "2",
    });
    const secondBoot = {
      ...firstBoot,
      bootId: opaque("syncboot", "g"),
    };
    expect(data(await execute(actor, secondBoot, keys))).toMatchObject({
      bootGeneration: "2",
      heartbeatSequence: "1",
    });
    expect(await execute(actor, {
      ...secondBoot,
      heartbeatSequence: "2",
    }, keys)).toEqual({ ok: false, code: "STALE_BOOT" });
  }, 30_000);

  test("admits one winner at the exact directory quota under concurrent reservations", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    expect((await bootstrap(actor, keys, createSyncVaultRootKey())).ok).toBeTrue();
    expect((await execute(actor, {
      version: 1,
      operation: "establish_boot",
      bootId: opaque("syncboot", "q"),
      bootGeneration: "1",
      heartbeatSequence: "1",
    }, keys)).ok).toBeTrue();
    await t.run(async (ctx) => {
      const current = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (current === null) throw new Error("sync vault missing");
      await ctx.db.patch(current._id, { directorySessionCount: 511 });
    });
    const results = await Promise.all([
      execute(actor, {
        version: 1,
        operation: "reserve_session",
        sessionId: opaque("syncsession", "a"),
        creationGrantDigest: `sha256_${"a".repeat(64)}`,
      }, keys),
      execute(actor, {
        version: 1,
        operation: "reserve_session",
        sessionId: opaque("syncsession", "z"),
        creationGrantDigest: `sha256_${"b".repeat(64)}`,
      }, keys),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "DIRECTORY_LIMIT" },
    ]);
    expect(await t.run(async (ctx) => {
      const current = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      return current?.directorySessionCount;
    })).toBe(512);
  }, 30_000);

  test("drains enrollment expiry and purge indexes beyond one bounded sweep page", async () => {
    const t = convexTest(schema, modules);
    await seedHumanScope(t);
    const actor = t.withIdentity(identity());
    const keys = await createSyncDeviceKeyPairs();
    expect((await bootstrap(actor, keys, createSyncVaultRootKey())).ok).toBeTrue();
    await t.run(async (ctx) => {
      const vaultRow = await ctx.db.query("syncVaults").withIndex(
        "by_vault_id",
        (query) => query.eq("vaultId", vault.vaultId),
      ).unique();
      if (vaultRow === null) throw new Error("sync vault missing");
      for (let index = 0; index < 130; index += 1) {
        const suffix = index.toString(16).padStart(32, "0");
        await ctx.db.insert("syncEnrollmentRequests", {
          vaultId: vaultRow._id,
          organizationId: vaultRow.organizationId,
          ownerUserId: vaultRow.ownerUserId,
          requestId: `syncenroll_${suffix}`,
          requestDigest: `sha256_${index.toString(16).padStart(64, "0")}`,
          deviceId: `syncdevice_${suffix}`,
          name: `Expired ${index}`,
          keysJson: "{}",
          pairingDigest: `sha256_${"a".repeat(64)}`,
          pairingCode: index.toString().padStart(6, "0").slice(-6),
          pairingTranscriptJson: "{}",
          state: "pending",
          requestedMembershipEpoch: vaultRow.membershipEpoch,
          expiresAt: 0,
          purgeAfter: 0,
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    const first = await t.mutation(retireExpiredRef, {});
    const second = await t.mutation(retireExpiredRef, {});
    const third = await t.mutation(retireExpiredRef, {});
    expect([
      first.expiredEnrollments,
      second.expiredEnrollments,
      third.expiredEnrollments,
    ]).toEqual([64, 64, 2]);
    expect(first.purgedEnrollments + second.purgedEnrollments + third.purgedEnrollments).toBe(130);
    expect(await t.run(async (ctx) => await ctx.db.query("syncEnrollmentRequests").collect())).toEqual([]);
  }, 30_000);
});
