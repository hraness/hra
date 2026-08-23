import { describe, expect, test } from "bun:test";

import type { CloudTransport } from "./client";
import {
  isRecord,
  parseEncryptedEnvelope,
  type EncryptedEnvelope,
  type WrappedKeyEnvelope,
} from "./contracts";
import { decodeBase64Url } from "./crypto";
import { IdentityScopedCloudSecretCustody } from "./identity-custody";
import {
  createLocalCloudControlFromEnvironment,
  LocalCloudControl,
  type CloudSecretCustodyPort,
} from "./local-control";
import { CustodyCloudDaemonIdentity } from "./daemon-bridge";
import {
  decryptRemoteCommand,
  encryptSessionMetadata,
  encryptUsageProjection,
} from "./payloads";
import { encryptCompactEvents } from "./projection";

const fixedNow = 1_700_000_000_000;
const signal = new AbortController().signal;
const userPublicId = "user_12345678";

class MemoryCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return this.values.get(slot) ?? null;
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const current = this.values.get(slot);
    if ((current?.generation ?? null) !== expectedGeneration) return null;
    const next = {
      generation: expectedGeneration === null ? 0 : expectedGeneration + 1,
      value,
    };
    this.values.set(slot, next);
    return next;
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    if (this.values.get(slot)?.generation !== expectedGeneration) return false;
    return this.values.delete(slot);
  }
}

type FakeDevice = {
  activatedAt?: number;
  encryptedLabel: EncryptedEnvelope;
  keyVersion: number;
  publicId: string;
  revision: number;
  status: "pending" | "active" | "revoked";
  wrappingPublicKey: string;
};

class FakeCloud {
  readonly userPublicId: string;
  readonly devices = new Map<string, FakeDevice>();
  readonly keyEnvelopes = new Map<string, WrappedKeyEnvelope[]>();
  heads: unknown[] = [];
  chunks = new Map<string, unknown[]>();
  accounts: unknown[] = [];
  snapshots = new Map<string, unknown[]>();
  readonly commands = new Map<string, Readonly<{
    payload: EncryptedEnvelope;
    requestDigest: string;
    response: Readonly<{
      publicId: string;
      replay: boolean;
      sessionPublicId: string;
      state: "pending";
      targetDevicePublicId: string;
    }>;
  }>>();
  readonly registrations = new Map<string, Readonly<Record<string, unknown>>>();
  readonly deletionRequests: Readonly<Record<string, unknown>>[] = [];
  deletion: null | {
    capability: string;
    status: {
      category: string;
      createdAt: number;
      jobId: string;
      state: "pending" | "draining" | "complete";
      updatedAt: number;
    };
  } = null;
  deletionDisabled = false;
  readonly acknowledgedCommands = new Set<string>();
  readonly commandStates = new Map<string, "pending" | "applied" | "failed" | "ambiguous">();
  readonly commandResultCodes = new Map<string, string>();
  readonly registrationAttempts: Readonly<Record<string, unknown>>[] = [];
  failNextApproveAfterEffect = false;
  failNextApproveBeforeEffect = false;
  failNextEnqueueAfterEffect = false;
  failNextEnqueueBeforeEffect = false;
  failNextAckAfterEffect = false;
  failNextRegisterAfterEffect = false;
  failNextRegistrationRecovery = false;
  failNextRevokeBeforeEffect = false;
  failNextSignOutAfterEffect = false;
  failNextSignOutBeforeEffect = false;
  failNextDeletionAfterEffect = false;
  failDeletionStatusCalls = 0;
  beforeAccountCurrentReturn?: () => Promise<void>;
  beforeRefreshReturn?: () => Promise<void>;
  beforeVerifyReturn?: () => Promise<void>;
  readonly approvalAttempts: Readonly<Record<string, unknown>>[] = [];
  readonly authAttempts: Readonly<Record<string, unknown>>[] = [];
  enqueueAttempts = 0;
  acknowledgementAttempts = 0;
  readonly revocationAttempts: Readonly<Record<string, unknown>>[] = [];
  lastEnqueue: Readonly<Record<string, unknown>> | null = null;
  signOutAttempts = 0;

  constructor(userIdentity = userPublicId) {
    this.userPublicId = userIdentity;
  }

  connect(): CloudTransport {
    let boundDevice: string | null = null;
    let bindChallenge: null | Readonly<{
      challengeId: string;
      devicePublicId: string;
      nonce: string;
    }> = null;
    return {
      action: async (name, args) => {
        if (name === "auth:signIn") {
          if (typeof args.provider === "string") {
            this.authAttempts.push(args);
            if (!isRecord(args.params) || typeof args.params.code !== "string") {
              return { tokens: null };
            }
            await this.beforeVerifyReturn?.();
          } else {
            await this.beforeRefreshReturn?.();
          }
          return {
            tokens: {
              refreshToken: "r".repeat(64),
              token: "t".repeat(64),
            },
          };
        }
        if (name === "auth:signOut") {
          this.signOutAttempts += 1;
          if (this.failNextSignOutBeforeEffect) {
            this.failNextSignOutBeforeEffect = false;
            throw new Error("sign out unavailable before effect");
          }
          boundDevice = null;
          if (this.failNextSignOutAfterEffect) {
            this.failNextSignOutAfterEffect = false;
            throw new Error("lost sign out response");
          }
          return null;
        }
        if (
          bindChallenge === null
          || args.challengeId !== bindChallenge.challengeId
          || typeof args.signature !== "string"
        ) throw new Error("invalid bind completion");
        boundDevice = bindChallenge.devicePublicId;
        const target = this.devices.get(boundDevice);
        bindChallenge = null;
        if (target === undefined) throw new Error("missing bind target");
        return {
          publicId: target.publicId,
          revision: target.revision,
          status: target.status,
        };
      },
      mutation: async (name, args) => {
        if (name === "accountDeletion:request") {
          if (
            typeof args.jobId !== "string"
            || typeof args.statusCapability !== "string"
          ) throw new Error("invalid account deletion input");
          this.deletionRequests.push(structuredClone(args));
          if (this.deletion !== null) {
            if (
              this.deletion.status.jobId !== args.jobId
              || this.deletion.capability !== args.statusCapability
            ) throw new Error("account deletion replay changed");
            return { ...this.deletion.status, replay: true };
          }
          this.deletion = {
            capability: args.statusCapability,
            status: {
              category: "commands_and_leases",
              createdAt: fixedNow,
              jobId: args.jobId,
              state: "pending",
              updatedAt: fixedNow,
            },
          };
          this.deletionDisabled = true;
          if (this.failNextDeletionAfterEffect) {
            this.failNextDeletionAfterEffect = false;
            throw new Error("lost account deletion response");
          }
          return {
            ...this.deletion.status,
            replay: false,
            statusCapability: args.statusCapability,
          };
        }
        if (this.deletionDisabled) throw new Error("Cloud authority is not current.");
        if (name === "devices:register" || name === "devices:recoverRegistration") {
          if (
            !isRecord(args.encryptedLabel)
            || typeof args.publicId !== "string"
            || typeof args.wrappingPublicKey !== "string"
          ) throw new Error("invalid registration fixture input");
          if (typeof args.idempotencyKey !== "string") {
            throw new Error("invalid registration idempotency key");
          }
          if (name === "devices:recoverRegistration" && this.failNextRegistrationRecovery) {
            this.failNextRegistrationRecovery = false;
            throw new Error("registration recovery unavailable");
          }
          this.registrationAttempts.push(structuredClone(args));
          const replay = this.registrations.get(args.idempotencyKey);
          if (name === "devices:recoverRegistration" && replay === undefined) return null;
          if (replay !== undefined) {
            if (JSON.stringify(replay) !== JSON.stringify(args)) {
              throw new Error("registration replay changed");
            }
            const existing = this.devices.get(args.publicId);
            if (existing === undefined) throw new Error("missing registration replay");
            boundDevice = existing.publicId;
            return {
              publicId: existing.publicId,
              revision: existing.revision,
              status: existing.status,
            };
          }
          const hasActive = [...this.devices.values()].some((device) => device.status === "active");
          const status = hasActive ? "pending" as const : "active" as const;
          if ((args.bootstrapKeyEnvelope !== undefined) !== !hasActive) {
            throw new Error("bootstrap envelope mismatch");
          }
          const device: FakeDevice = {
            ...(status === "active" ? { activatedAt: fixedNow } : {}),
            encryptedLabel: args.encryptedLabel as EncryptedEnvelope,
            keyVersion: 1,
            publicId: args.publicId,
            revision: 1,
            status,
            wrappingPublicKey: args.wrappingPublicKey,
          };
          this.devices.set(device.publicId, device);
          this.registrations.set(args.idempotencyKey, structuredClone(args));
          boundDevice = device.publicId;
          if (isRecord(args.bootstrapKeyEnvelope)) {
            this.keyEnvelopes.set(
              device.publicId,
              [args.bootstrapKeyEnvelope as WrappedKeyEnvelope],
            );
          }
          if (this.failNextRegisterAfterEffect) {
            this.failNextRegisterAfterEffect = false;
            throw new Error("lost registration response");
          }
          return { publicId: device.publicId, revision: 1, status };
        }
        if (name === "devices:approve") {
          if (
            typeof args.targetPublicId !== "string"
            || !isRecord(args.keyEnvelope)
          ) throw new Error("invalid approval fixture input");
          this.approvalAttempts.push(structuredClone(args));
          if (this.failNextApproveBeforeEffect) {
            this.failNextApproveBeforeEffect = false;
            throw new Error("approval unavailable before effect");
          }
          const target = this.devices.get(args.targetPublicId);
          if (target === undefined || target.status !== "pending") throw new Error("not pending");
          target.status = "active";
          target.revision += 1;
          target.activatedAt = fixedNow;
          this.keyEnvelopes.set(
            target.publicId,
            [args.keyEnvelope as WrappedKeyEnvelope],
          );
          if (this.failNextApproveAfterEffect) {
            this.failNextApproveAfterEffect = false;
            throw new Error("lost approval response");
          }
          return { publicId: target.publicId, revision: target.revision, status: target.status };
        }
        if (name === "devices:revoke") {
          if (typeof args.targetPublicId !== "string") throw new Error("invalid revoke input");
          this.revocationAttempts.push(structuredClone(args));
          if (this.failNextRevokeBeforeEffect) {
            this.failNextRevokeBeforeEffect = false;
            throw new Error("revocation unavailable before effect");
          }
          const target = this.devices.get(args.targetPublicId);
          if (target === undefined) throw new Error("missing device");
          target.status = "revoked";
          target.revision += 1;
          return { publicId: target.publicId, revision: target.revision, status: target.status };
        }
        if (name === "devices:beginBind") {
          if (
            typeof args.challengeId !== "string"
            || typeof args.devicePublicId !== "string"
            || typeof args.nonce !== "string"
            || this.devices.get(args.devicePublicId)?.status !== "active"
          ) throw new Error("invalid bind challenge");
          bindChallenge = {
            challengeId: args.challengeId,
            devicePublicId: args.devicePublicId,
            nonce: args.nonce,
          };
          return bindChallenge;
        }
        if (name === "commands:enqueue") {
          if (
            typeof args.idempotencyKey !== "string"
            || typeof args.publicId !== "string"
            || typeof args.requestDigest !== "string"
            || typeof args.sessionPublicId !== "string"
            || typeof args.expectedTargetDevicePublicId !== "string"
            || typeof args.kind !== "string"
            || !isRecord(args.payload)
          ) throw new Error("invalid command enqueue input");
          this.enqueueAttempts += 1;
          if (this.failNextEnqueueBeforeEffect) {
            this.failNextEnqueueBeforeEffect = false;
            throw new Error("enqueue unavailable before effect");
          }
          const head = this.heads.find((candidate) =>
            isRecord(candidate) && candidate.publicId === args.sessionPublicId);
          if (
            !isRecord(head)
            || head.executionDevicePublicId !== args.expectedTargetDevicePublicId
          ) throw new Error("command target changed");
          const scope = `${boundDevice ?? "none"}:${args.sessionPublicId}:${args.kind}:${args.idempotencyKey}`;
          const existing = this.commands.get(scope);
          if (existing !== undefined) {
            if (existing.requestDigest !== args.requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
            return { ...existing.response, replay: true };
          }
          const response = {
            publicId: args.publicId,
            replay: false,
            sessionPublicId: args.sessionPublicId,
            state: "pending" as const,
            targetDevicePublicId: args.expectedTargetDevicePublicId,
          };
          this.lastEnqueue = args as Readonly<Record<string, unknown>>;
          this.commands.set(scope, {
            payload: args.payload as EncryptedEnvelope,
            requestDigest: args.requestDigest,
            response,
          });
          if (this.failNextEnqueueAfterEffect) {
            this.failNextEnqueueAfterEffect = false;
            throw new Error("lost command enqueue response");
          }
          return response;
        }
        if (name === "commands:acknowledgeReceipt") {
          if (
            typeof args.commandPublicId !== "string"
            || typeof args.idempotencyKey !== "string"
            || typeof args.requestDigest !== "string"
          ) throw new Error("invalid command acknowledgement");
          const command = [...this.commands.entries()].find(([, candidate]) =>
            candidate.response.publicId === args.commandPublicId);
          if (
            command === undefined
            || command[1].requestDigest !== args.requestDigest
            || !command[0].endsWith(`:${args.idempotencyKey}`)
          ) throw new Error("invalid command acknowledgement authority");
          this.acknowledgementAttempts += 1;
          const replay = this.acknowledgedCommands.has(args.commandPublicId);
          this.acknowledgedCommands.add(args.commandPublicId);
          if (this.failNextAckAfterEffect) {
            this.failNextAckAfterEffect = false;
            throw new Error("lost command acknowledgement response");
          }
          return { acknowledgedAt: fixedNow, publicId: args.commandPublicId, replay };
        }
        throw new Error(`Unexpected mutation: ${name}`);
      },
      query: async (name, args) => {
        if (name === "accountDeletion:status") {
          if (this.failDeletionStatusCalls > 0) {
            this.failDeletionStatusCalls -= 1;
            throw new Error("account deletion status temporarily unavailable");
          }
          if (
            this.deletion === null
            || args.jobId !== this.deletion.status.jobId
            || args.statusCapability !== this.deletion.capability
          ) throw new Error("Account deletion status is unavailable.");
          return { ...this.deletion.status };
        }
        if (this.deletionDisabled) throw new Error("Cloud authority is not current.");
        if (name === "account:current") {
          const device = boundDevice === null ? undefined : this.devices.get(boundDevice);
          await this.beforeAccountCurrentReturn?.();
          return {
            authEpoch: 1,
            device: device === undefined
              ? null
              : {
                keyVersion: device.keyVersion,
                publicId: device.publicId,
                revision: device.revision,
                status: device.status,
              },
            hasActiveDevices: [...this.devices.values()]
              .some((candidate) => candidate.status === "active"),
            userPublicId: this.userPublicId,
          };
        }
        if (name === "devices:list" || name === "devices:listPage" || name === "devices:get") {
          const records = [...this.devices.values()].map((device) => ({
            ...(device.activatedAt === undefined ? {} : { activatedAt: device.activatedAt }),
            encryptedLabel: device.encryptedLabel,
            keyVersion: device.keyVersion,
            lastSeenAt: fixedNow,
            online: true,
            publicId: device.publicId,
            revision: device.revision,
            status: device.status,
            wrappingPublicKey: device.wrappingPublicKey,
          }));
          if (name === "devices:get") {
            return records.find((device) => device.publicId === args.publicId) ?? null;
          }
          if (name === "devices:list") return records;
          const pagination = args.paginationOpts;
          if (!isRecord(pagination) || typeof pagination.numItems !== "number") {
            throw new Error("invalid device pagination fixture");
          }
          const start = pagination.cursor === null
            ? 0
            : Number.parseInt(pagination.cursor as string, 10);
          const page = records.slice(start, start + pagination.numItems);
          const next = start + page.length;
          return {
            continueCursor: String(next),
            isDone: next >= records.length,
            page,
          };
        }
        if (name === "devices:listKeyEnvelopes") {
          if (boundDevice === null) return [];
          return (this.keyEnvelopes.get(boundDevice) ?? []).map((envelope) => ({
            createdAt: fixedNow,
            envelope,
          }));
        }
        if (name === "sessions:listHeads") return this.heads;
        if (name === "sessions:listHeadsPage") {
          const pagination = args.paginationOpts;
          if (!isRecord(pagination) || typeof pagination.numItems !== "number") {
            throw new Error("invalid pagination fixture");
          }
          if (pagination.cursor !== null && typeof pagination.cursor !== "string") {
            throw new Error("invalid pagination cursor fixture");
          }
          const start = pagination.cursor === null
            ? 0
            : Number.parseInt(pagination.cursor, 10);
          const page = this.heads.slice(start, start + pagination.numItems);
          const next = start + page.length;
          return {
            continueCursor: String(next),
            isDone: next >= this.heads.length,
            page,
          };
        }
        if (name === "sessions:getHead") {
          return this.heads.find((candidate) =>
            isRecord(candidate) && candidate.publicId === args.publicId) ?? null;
        }
        if (name === "sessions:getLatestChunks") {
          const id = args.sessionPublicId;
          if (typeof id !== "string") throw new Error("invalid session id");
          const chunks = this.chunks.get(id) ?? [];
          const limit = typeof args.limit === "number" ? args.limit : 0;
          return chunks.slice(Math.max(0, chunks.length - limit));
        }
        if (name === "commands:get") {
          const command = [...this.commands.values()].find((candidate) =>
            candidate.response.publicId === args.commandPublicId);
          return command === undefined
            ? null
            : {
                createdAt: fixedNow,
                deadline: fixedNow + 60_000,
                kind: "set_fast",
                payload: command.payload,
                publicId: command.response.publicId,
                requestDigest: command.requestDigest,
                ...(this.commandResultCodes.has(command.response.publicId)
                  ? { resultCode: this.commandResultCodes.get(command.response.publicId) }
                  : {}),
                sessionPublicId: command.response.sessionPublicId,
                state: this.commandStates.get(command.response.publicId) ?? command.response.state,
                targetDevicePublicId: command.response.targetDevicePublicId,
                updatedAt: fixedNow,
              };
        }
        if (name === "usage:listAccounts") return this.accounts;
        if (name === "usage:listSnapshots") {
          const id = args.accountPublicId;
          if (typeof id !== "string") throw new Error("invalid account id");
          return this.snapshots.get(id) ?? [];
        }
        throw new Error(`Unexpected query: ${name}`);
      },
    };
  }
}

function control(
  cloud: FakeCloud,
  custody: MemoryCustody,
  now: () => number = () => fixedNow,
): LocalCloudControl {
  return new LocalCloudControl({
    deploymentUrl: "https://example.convex.cloud",
    now,
    secretCustody: custody,
    transport: cloud.connect(),
  });
}

async function authenticate(adapter: LocalCloudControl): Promise<void> {
  expect(await adapter.auth({ email: "reader@example.com", signal }))
    .toEqual({ codeRequestedOrRejected: true, signedIn: false });
  expect(await adapter.auth({
    code: "12345678",
    email: "reader@example.com",
    signal,
  })).toMatchObject({
    automaticRegistrationPending: true,
    pairingRequired: false,
    signedIn: true,
  });
}

function accountKey(custody: MemoryCustody): Uint8Array {
  const value = custody.values.get("cloud-account-key")?.value;
  if (value === undefined) throw new Error("missing account key fixture");
  const decoded: unknown = JSON.parse(value) as unknown;
  if (!isRecord(decoded) || typeof decoded.key !== "string") {
    throw new Error("invalid account key fixture");
  }
  return decodeBase64Url(decoded.key);
}

function accountKeyIsProvisional(custody: MemoryCustody): boolean {
  const value = custody.values.get("cloud-account-key")?.value;
  if (value === undefined) throw new Error("missing account key fixture");
  const decoded: unknown = JSON.parse(value) as unknown;
  if (!isRecord(decoded) || typeof decoded.provisional !== "boolean") {
    throw new Error("invalid account key fixture");
  }
  return decoded.provisional;
}

function expectSignedOutCustody(custody: MemoryCustody): void {
  const value = custody.values.get("cloud-auth")?.value;
  expect(value).toBeString();
  expect(JSON.parse(value ?? "null")).toMatchObject({
    phase: "signed_out",
    version: 3,
  });
}

describe("local cloud control", () => {
  test("rejects account erasure without acknowledgement before cloud access", async () => {
    const cloud = new FakeCloud();
    const adapter = control(cloud, new MemoryCustody());
    await expect(adapter.deleteAccount({
      acknowledgeErasure: false,
      signal,
    })).rejects.toThrow("explicit acknowledgement");
    expect(cloud.authAttempts).toHaveLength(0);
    expect(cloud.deletionRequests).toHaveLength(0);
  });

  test("replays exact write-ahead erasure authority after a lost response and restart", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const adapter = control(cloud, custody);
    await authenticate(adapter);
    await adapter.pairDevice(signal);
    const retainedSlots = ["cloud-auth", "cloud-device", "cloud-account-key"] as const;
    const retained = new Map(retainedSlots.map((slot) => [slot, custody.values.get(slot)?.value]));

    cloud.failNextDeletionAfterEffect = true;
    cloud.failDeletionStatusCalls = 2;
    await expect(adapter.deleteAccount({ acknowledgeErasure: true, signal }))
      .rejects.toThrow("lost account deletion response");

    const restarted = control(cloud, custody);
    const result = await restarted.deleteAccount({ acknowledgeErasure: true, signal });
    expect(cloud.deletionRequests).toHaveLength(2);
    const first = cloud.deletionRequests[0];
    const replay = cloud.deletionRequests[1];
    expect(first?.jobId === replay?.jobId).toBe(true);
    expect(first?.statusCapability === replay?.statusCapability).toBe(true);
    for (const slot of retainedSlots) {
      expect(custody.values.get(slot)?.value === retained.get(slot)).toBe(true);
    }

    const recovery = custody.values.get("cloud-account-deletion")?.value;
    expect(recovery).toBeString();
    const decoded = JSON.parse(recovery ?? "null") as { statusCapability?: unknown };
    expect(typeof decoded.statusCapability === "string" && decoded.statusCapability.length === 43)
      .toBe(true);
    if (typeof decoded.statusCapability !== "string") throw new Error("Missing test recovery authority.");
    expect(JSON.stringify(result).includes(decoded.statusCapability)).toBe(false);
    expect(result).toMatchObject({
      deletion: {
        effectsDisabled: true,
        state: "pending",
        statusFresh: true,
      },
    });
    await expect(restarted.listDevices(signal))
      .rejects.toThrow("Cloud effects are unavailable while hosted account erasure is in progress.");
  });

  test("surfaces capability-only erasure progress through completion without secret leakage", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const adapter = control(cloud, custody);
    await authenticate(adapter);
    const requested = await adapter.deleteAccount({ acknowledgeErasure: true, signal });
    const recovery = custody.values.get("cloud-account-deletion")?.value;
    expect(recovery).toBeString();
    const decoded = JSON.parse(recovery ?? "null") as { statusCapability?: unknown };
    if (typeof decoded.statusCapability !== "string") throw new Error("Missing test recovery authority.");
    expect(JSON.stringify(requested).includes(decoded.statusCapability)).toBe(false);

    if (cloud.deletion === null) throw new Error("Missing deletion fixture.");
    cloud.deletion.status = {
      ...cloud.deletion.status,
      category: "session_heads",
      state: "draining",
      updatedAt: fixedNow + 1,
    };
    const draining = await adapter.status(signal);
    expect(draining).toMatchObject({
      deletion: {
        category: "session_heads",
        effectsDisabled: true,
        state: "draining",
        statusFresh: true,
      },
      signedIn: false,
    });
    expect(JSON.stringify(draining).includes(decoded.statusCapability)).toBe(false);

    cloud.deletion.status = {
      ...cloud.deletion.status,
      category: "complete",
      createdAt: fixedNow + 2,
      state: "complete",
      updatedAt: fixedNow + 2,
    };
    const complete = await adapter.status(signal);
    expect(complete).toMatchObject({
      deletion: { category: "complete", state: "complete", statusFresh: true },
      signedIn: false,
    });
    expect(JSON.stringify(complete).includes(decoded.statusCapability)).toBe(false);

    cloud.deletion = null;
    expect(await adapter.status(signal)).toMatchObject({
      deletion: { category: "complete", state: "complete", statusFresh: true },
    });
  });

  test("isolates erasure recovery when the active cloud identity changes", async () => {
    const raw = new MemoryCustody();
    const unbound = await IdentityScopedCloudSecretCustody.open(raw);
    const cloudA = new FakeCloud("user_identity_a");
    const authenticatingA = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => fixedNow,
      secretCustody: unbound,
      transport: cloudA.connect(),
    });
    await authenticatingA.auth({ email: "reader@example.com", signal });
    await authenticatingA.auth({ code: "12345678", email: "reader@example.com", signal });
    const identityA = await IdentityScopedCloudSecretCustody.open(raw);
    const controlA = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => fixedNow,
      secretCustody: identityA,
      transport: cloudA.connect(),
    });
    await controlA.deleteAccount({ acknowledgeErasure: true, signal });

    await identityA.activateIdentity("user_identity_b");
    const identityB = await IdentityScopedCloudSecretCustody.open(raw);
    const cloudB = new FakeCloud("user_identity_b");
    const controlB = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => fixedNow,
      secretCustody: identityB,
      transport: cloudB.connect(),
    });
    expect(await controlB.status(signal)).toMatchObject({ signedIn: true });
    expect(JSON.stringify(await controlB.status(signal))).not.toContain("deletion");

    await identityB.activateIdentity("user_identity_a");
    const returnedA = await IdentityScopedCloudSecretCustody.open(raw);
    const reopenedA = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => fixedNow,
      secretCustody: returnedA,
      transport: cloudA.connect(),
    });
    expect(await reopenedA.status(signal)).toMatchObject({
      deletion: { effectsDisabled: true, state: "pending" },
      signedIn: false,
    });
  });

  test("commits a cloud identity selector before requesting a daemon restart", async () => {
    const cloud = new FakeCloud("user_identity_a");
    const raw = new MemoryCustody();
    const scoped = await IdentityScopedCloudSecretCustody.open(raw);
    const adapter = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => fixedNow,
      secretCustody: scoped,
      transport: cloud.connect(),
    });
    await adapter.auth({ email: "reader@example.com", signal });
    expect(await adapter.auth({
      code: "12345678",
      email: "reader@example.com",
      signal,
    })).toEqual({
      automaticRegistrationPending: true,
      daemonRestartRequired: true,
      device: null,
      email: "reader@example.com",
      pairingRequired: false,
      signedIn: true,
    });
    const reopened = await IdentityScopedCloudSecretCustody.open(raw);
    expect(reopened.activeUserPublicId).toBe("user_identity_a");
  });

  test("forwards first-admission invites only to the HRA OTP provider", async () => {
    const cloud = new FakeCloud();
    const adapter = control(cloud, new MemoryCustody());
    const invite = `hra_invite_identity_v1_${"A".repeat(43)}`;
    expect(await adapter.auth({ email: "reader@example.com", invite, signal }))
      .toEqual({ codeRequestedOrRejected: true, signedIn: false });
    expect(cloud.authAttempts).toEqual([{
      params: { email: "reader@example.com", invite },
      provider: "hra-control-plane-otp-v1",
    }]);
    expect(JSON.stringify(cloud.authAttempts)).not.toContain(["hra", "otp"].join("-"));
  });

  test("is absent until the explicit Convex URL is configured", () => {
    const custody = new MemoryCustody();
    expect(createLocalCloudControlFromEnvironment({
      environment: {},
      secretCustody: custody,
    })).toBeNull();
    expect(createLocalCloudControlFromEnvironment({
      environment: { HRA_CONVEX_URL: "https://example.convex.cloud" },
      secretCustody: custody,
      transport: new FakeCloud().connect(),
    })).toBeInstanceOf(LocalCloudControl);
  });

  test("keeps OTP tokens in injected custody and preserves device keys on logout", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const adapter = control(cloud, custody);
    await authenticate(adapter);
    expect(JSON.stringify(await adapter.status(signal))).not.toContain("t".repeat(32));
    expect(custody.values.has("cloud-auth")).toBe(true);
    await adapter.pairDevice(signal);
    expect(custody.values.has("cloud-device")).toBe(true);
    expect(custody.values.has("cloud-account-key")).toBe(true);
    await adapter.logout(signal);
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-device")).toBe(true);
    expect(custody.values.has("cloud-account-key")).toBe(true);
    await authenticate(adapter);
    expect(await adapter.pairDevice(signal)).toMatchObject({ paired: true, rebound: true });
  });

  test("keeps exact auth custody until sign-out is confirmed and retires an unresolved intent after the total session lifetime", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    let localNow = fixedNow;
    const adapter = control(cloud, custody, () => localNow);
    await authenticate(adapter);
    cloud.failNextSignOutBeforeEffect = true;
    await expect(adapter.logout(signal)).rejects.toThrow("before effect");
    expect(custody.values.has("cloud-auth")).toBe(true);
    expect(custody.values.has("cloud-auth-logout")).toBe(true);
    await expect(adapter.auth({ email: "other@example.com", signal })).rejects.toThrow(
      "sign-out intent",
    );
    await adapter.logout(signal);
    expect(cloud.signOutAttempts).toBe(2);
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-auth-logout")).toBe(false);

    await authenticate(adapter);
    cloud.failNextSignOutAfterEffect = true;
    await expect(adapter.logout(signal)).rejects.toThrow("lost sign out response");
    expect(custody.values.has("cloud-auth")).toBe(true);
    expect(custody.values.has("cloud-auth-logout")).toBe(true);
    localNow += 7 * 24 * 60 * 60 * 1_000;
    expect(await adapter.auth({ email: "reader@example.com", signal })).toEqual({
      codeRequestedOrRejected: true,
      signedIn: false,
    });
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-auth-logout")).toBe(false);
  });

  test("keeps a logout marker across a concurrent daemon refresh CAS until exact retry", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    let localNow = fixedNow;
    const transport = cloud.connect();
    const adapter = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => localNow,
      secretCustody: custody,
      transport,
    });
    await authenticate(adapter);
    await adapter.pairDevice(signal);
    localNow += 11 * 60 * 1_000;
    let releaseAccount!: () => void;
    let accountReadStarted!: () => void;
    const started = new Promise<void>((resolve) => { accountReadStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseAccount = resolve; });
    cloud.beforeAccountCurrentReturn = async () => {
      delete cloud.beforeAccountCurrentReturn;
      accountReadStarted();
      await released;
    };
    const identity = new CustodyCloudDaemonIdentity({
      custody,
      now: () => localNow,
      transport,
    });
    const refreshing = identity.requireActive(signal);
    await started;
    cloud.failNextSignOutAfterEffect = true;
    await expect(adapter.logout(signal)).rejects.toThrow("lost sign out response");
    expect(custody.values.has("cloud-auth")).toBe(true);
    expect(custody.values.has("cloud-auth-logout")).toBe(true);
    releaseAccount();
    await expect(refreshing).rejects.toThrow("sign-out recovery started");
    expect(custody.values.has("cloud-auth")).toBe(true);
    expect(custody.values.has("cloud-auth-logout")).toBe(true);

    await adapter.logout(signal);
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-auth-logout")).toBe(false);
  });

  test("an older local refresh cannot resurrect auth after logout claims the exact custody generation", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    let localNow = fixedNow;
    const transport = cloud.connect();
    const refreshingControl = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => localNow,
      secretCustody: custody,
      transport,
    });
    const logoutControl = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => localNow,
      secretCustody: custody,
      transport,
    });
    await authenticate(refreshingControl);
    localNow += 11 * 60 * 1_000;
    let refreshStarted!: () => void;
    let releaseRefresh!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    cloud.beforeRefreshReturn = async () => {
      delete cloud.beforeRefreshReturn;
      refreshStarted();
      await release;
    };

    const refreshing = refreshingControl.status(signal);
    await started;
    await logoutControl.logout(signal);
    releaseRefresh();

    await expect(refreshing).rejects.toThrow(/auth changed|sign-out recovery/iu);
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-auth-logout")).toBe(false);
  });

  test("logout fences an in-flight first login even when auth custody was initially absent", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const transport = cloud.connect();
    const authenticatingControl = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      secretCustody: custody,
      transport,
    });
    const logoutControl = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      secretCustody: custody,
      transport,
    });
    expect(await authenticatingControl.auth({ email: "reader@example.com", signal }))
      .toEqual({ codeRequestedOrRejected: true, signedIn: false });
    let verifyStarted!: () => void;
    let releaseVerify!: () => void;
    const started = new Promise<void>((resolve) => { verifyStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseVerify = resolve; });
    cloud.beforeVerifyReturn = async () => {
      delete cloud.beforeVerifyReturn;
      verifyStarted();
      await release;
    };

    const authenticating = authenticatingControl.auth({
      code: "12345678",
      email: "reader@example.com",
      signal,
    });
    await started;
    await logoutControl.logout(signal);
    expectSignedOutCustody(custody);
    releaseVerify();

    await expect(authenticating).rejects.toThrow("Cloud auth changed during authentication");
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-auth-logout")).toBe(false);
    expect(cloud.signOutAttempts).toBe(0);
    await authenticate(authenticatingControl);
  });

  test("logout retries after a refreshed generation wins immediately before the auth claim CAS", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    let localNow = fixedNow;
    const transport = cloud.connect();
    const adapter = new LocalCloudControl({
      deploymentUrl: "https://example.convex.cloud",
      now: () => localNow,
      secretCustody: custody,
      transport,
    });
    await authenticate(adapter);
    await adapter.pairDevice(signal);
    localNow += 11 * 60 * 1_000;
    const identity = new CustodyCloudDaemonIdentity({
      custody,
      now: () => localNow,
      transport,
    });
    const compareAndSwap = custody.compareAndSwap.bind(custody);
    let claimEntered!: () => void;
    let releaseClaim!: () => void;
    const entered = new Promise<void>((resolve) => { claimEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let paused = false;
    custody.compareAndSwap = async (slot, generation, value) => {
      const decoded = JSON.parse(value) as unknown;
      if (
        slot === "cloud-auth"
        && !paused
        && isRecord(decoded)
        && decoded.phase === "logout_claim"
      ) {
        paused = true;
        claimEntered();
        await release;
      }
      return await compareAndSwap(slot, generation, value);
    };

    const loggingOut = adapter.logout(signal);
    await entered;
    await identity.requireActive(signal);
    releaseClaim();
    await expect(loggingOut).rejects.toThrow("changed concurrently");
    expect(custody.values.has("cloud-auth-logout")).toBe(false);

    custody.compareAndSwap = compareAndSwap;
    await adapter.logout(signal);
    expectSignedOutCustody(custody);
    expect(custody.values.has("cloud-auth-logout")).toBe(false);
  });

  test("fails closed before reusing another HRA identity's local custody", async () => {
    const firstCloud = new FakeCloud("user_first000");
    const custody = new MemoryCustody();
    const first = control(firstCloud, custody);
    await authenticate(first);
    const firstPair = await first.pairDevice(signal) as { device: { publicId: string } };
    await first.logout(signal);

    const secondCloud = new FakeCloud("user_second00");
    const second = control(secondCloud, custody);
    await authenticate(second);
    const protectedBefore = new Map([...custody.values].filter(([slot]) => slot !== "cloud-auth"));
    await expect(second.pairDevice(signal)).rejects.toThrow("different HRA identity");
    expect(new Map([...custody.values].filter(([slot]) => slot !== "cloud-auth"))).toEqual(protectedBefore);
    expect(secondCloud.registrationAttempts).toHaveLength(0);

    await second.logout(signal);
    await authenticate(first);
    expect(await first.pairDevice(signal)).toMatchObject({
      device: { publicId: firstPair.device.publicId },
      paired: true,
      rebound: true,
    });
  });

  test("automatically registers a fresh first device and promotes only its bootstrap key", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const adapter = control(cloud, custody);
    await authenticate(adapter);

    const registered = await adapter.ensureDeviceRegistered(signal);

    expect(registered).toMatchObject({
      device: { status: "active" },
      paired: true,
    });
    expect(cloud.devices.size).toBe(1);
    expect(accountKeyIsProvisional(custody)).toBe(false);
    expect(custody.values.has("cloud-device-registration")).toBe(false);
  });

  test("automatically registers later installations as pending with zero account-data authority", async () => {
    const cloud = new FakeCloud();
    const firstCustody = new MemoryCustody();
    const pendingCustody = new MemoryCustody();
    const first = control(cloud, firstCustody);
    const pending = control(cloud, pendingCustody);
    await authenticate(first);
    await first.ensureDeviceRegistered(signal);
    await authenticate(pending);

    const registration = await pending.ensureDeviceRegistered(signal) as {
      device: { publicId: string };
    };

    expect(registration).toMatchObject({
      device: { status: "pending" },
      paired: false,
    });
    expect(accountKeyIsProvisional(pendingCustody)).toBe(true);
    expect(accountKey(pendingCustody)).not.toEqual(accountKey(firstCustody));
    await first.approveDevice(registration.device.publicId, signal);
    expect(await pending.ensureDeviceRegistered(signal)).toMatchObject({
      device: { status: "active" },
      registered: true,
    });
    expect(accountKeyIsProvisional(pendingCustody)).toBe(true);
    expect(await pending.status(signal)).toMatchObject({
      automaticRegistrationPending: false,
      pairingRequired: true,
    });
    expect(await pending.pairDevice(signal)).toMatchObject({ paired: true });
    expect(accountKey(pendingCustody)).toEqual(accountKey(firstCustody));
    expect(await pending.status(signal)).toMatchObject({ pairingRequired: false });
  });

  test("automatically resolves simultaneous first registration without duplicate authority", async () => {
    const cloud = new FakeCloud();
    const firstCustody = new MemoryCustody();
    const secondCustody = new MemoryCustody();
    const first = control(cloud, firstCustody);
    const second = control(cloud, secondCustody);
    await Promise.all([authenticate(first), authenticate(second)]);

    const results = await Promise.all([
      first.ensureDeviceRegistered(signal),
      second.ensureDeviceRegistered(signal),
    ]) as Array<{ device: { publicId: string; status: "active" | "pending" } }>;

    expect(results.map((result) => result.device.status).sort()).toEqual([
      "active",
      "pending",
    ]);
    expect(new Set(results.map((result) => result.device.publicId)).size).toBe(2);
    expect(cloud.devices.size).toBe(2);
    expect(cloud.registrations.size).toBe(2);
  });

  test("automatically replays exact lost registration custody after restart and auth rotation", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const first = control(cloud, custody);
    await authenticate(first);
    cloud.failNextRegisterAfterEffect = true;
    cloud.failNextRegistrationRecovery = true;
    await expect(first.ensureDeviceRegistered(signal)).rejects.toThrow(
      "lost registration response",
    );
    const exactAttempt = JSON.stringify(cloud.registrationAttempts[0]);
    const exactDevice = [...cloud.devices.keys()][0];
    expect(exactDevice).toBeString();

    await first.logout(signal);
    const restarted = control(cloud, custody);
    await authenticate(restarted);
    expect(await restarted.ensureDeviceRegistered(signal)).toMatchObject({
      device: { publicId: exactDevice, status: "active" },
      replay: true,
    });
    expect(cloud.registrationAttempts).toHaveLength(2);
    expect(JSON.stringify(cloud.registrationAttempts[1])).toBe(exactAttempt);
    expect(cloud.devices.size).toBe(1);
    expect(custody.values.has("cloud-device-registration")).toBe(false);
  });

  test("automatic registration refuses another identity's unscoped device custody", async () => {
    const firstCloud = new FakeCloud("user_auto_first");
    const custody = new MemoryCustody();
    const first = control(firstCloud, custody);
    await authenticate(first);
    await first.ensureDeviceRegistered(signal);
    await first.logout(signal);

    const secondCloud = new FakeCloud("user_auto_second");
    const second = control(secondCloud, custody);
    await authenticate(second);
    const protectedBefore = new Map([...custody.values].filter(([slot]) => slot !== "cloud-auth"));
    await expect(second.ensureDeviceRegistered(signal)).rejects.toThrow(
      "different HRA identity",
    );
    expect(new Map([...custody.values].filter(([slot]) => slot !== "cloud-auth")))
      .toEqual(protectedBefore);
    expect(secondCloud.registrationAttempts).toHaveLength(0);
  });

  test("bootstraps the first device and approves and revokes a second device", async () => {
    const cloud = new FakeCloud();
    const first = control(cloud, new MemoryCustody());
    const second = control(cloud, new MemoryCustody());
    await authenticate(first);
    const firstPair = await first.pairDevice(signal) as { device: { publicId: string } };
    expect(firstPair).toMatchObject({ paired: true, device: { status: "active" } });
    await authenticate(second);
    const secondPair = await second.pairDevice(signal) as { device: { publicId: string } };
    expect(secondPair).toMatchObject({ paired: false, device: { status: "pending" } });
    cloud.failNextApproveAfterEffect = true;
    await expect(first.approveDevice(secondPair.device.publicId.slice(0, 16), signal))
      .rejects.toThrow("lost approval response");
    expect(await first.approveDevice(secondPair.device.publicId.slice(0, 16), signal))
      .toMatchObject({
        device: { publicId: secondPair.device.publicId, status: "active" },
        replay: true,
      });
    expect(await second.pairDevice(signal)).toMatchObject({ paired: true });
    expect(await first.revokeDevice(secondPair.device.publicId, signal))
      .toMatchObject({ device: { status: "revoked" } });
    expect(await first.listDevices(signal)).toMatchObject({
      currentDevicePublicId: firstPair.device.publicId,
      devices: expect.arrayContaining([
        expect.objectContaining({ publicId: secondPair.device.publicId, status: "revoked" }),
      ]),
    });
  });

  test("explicitly replaces a revoked local device after reauthentication", async () => {
    const cloud = new FakeCloud();
    const firstCustody = new MemoryCustody();
    const secondCustody = new MemoryCustody();
    const first = control(cloud, firstCustody);
    const second = control(cloud, secondCustody);
    await authenticate(first);
    await first.pairDevice(signal);
    await authenticate(second);
    const secondPair = await second.pairDevice(signal) as { device: { publicId: string } };
    const retiredPublicId = secondPair.device.publicId;
    await first.approveDevice(retiredPublicId, signal);
    await second.pairDevice(signal);
    await first.revokeDevice(retiredPublicId, signal);

    expect(await second.pairDevice(signal)).toMatchObject({
      device: { publicId: retiredPublicId, status: "revoked" },
      paired: false,
      reauthenticationRequired: true,
      replacementPrepared: true,
    });
    expect(secondCustody.values.has("cloud-device-replacement")).toBe(true);

    await second.logout(signal);
    await authenticate(second);
    const replacement = await second.pairDevice(signal) as {
      device: { publicId: string; status: string };
      paired: boolean;
    };
    expect(replacement).toMatchObject({
      device: { status: "pending" },
      paired: false,
    });
    expect(replacement.device.publicId).not.toBe(retiredPublicId);
    expect(cloud.devices.get(retiredPublicId)?.status).toBe("revoked");
    expect(secondCustody.values.has("cloud-device-replacement")).toBe(false);
    expect(secondCustody.values.has("cloud-device-registration")).toBe(false);

    const history = secondCustody.values.get("cloud-retired-devices")?.value;
    expect(history).toContain(retiredPublicId);
    expect(history).not.toContain("signingPrivateKey");
    expect(history).not.toContain("wrappingPrivateKey");

    await first.approveDevice(replacement.device.publicId, signal);
    expect(await second.pairDevice(signal)).toMatchObject({
      device: { publicId: replacement.device.publicId, status: "active" },
      paired: true,
    });
    expect(accountKey(secondCustody)).toEqual(accountKey(firstCustody));
  });

  test("downgrades a concurrent first-device registration loser to pending after exact absence", async () => {
    const cloud = new FakeCloud();
    const firstCustody = new MemoryCustody();
    const secondCustody = new MemoryCustody();
    const first = control(cloud, firstCustody);
    const second = control(cloud, secondCustody);
    await Promise.all([authenticate(first), authenticate(second)]);

    const results = await Promise.all([
      first.pairDevice(signal),
      second.pairDevice(signal),
    ]) as Array<{ device: { status: "active" | "pending" }; paired: boolean }>;

    expect(results.map((result) => result.device.status).sort()).toEqual([
      "active",
      "pending",
    ]);
    expect(results.filter((result) => result.paired)).toHaveLength(1);
    expect(cloud.devices.size).toBe(2);
    expect(firstCustody.values.has("cloud-device-registration")).toBe(false);
    expect(secondCustody.values.has("cloud-device-registration")).toBe(false);
  });

  test("rerolls aged uncommitted approvals and revocations with exact outbox CAS", async () => {
    const cloud = new FakeCloud();
    let localNow = fixedNow;
    const first = control(cloud, new MemoryCustody(), () => localNow);
    const second = control(cloud, new MemoryCustody());
    await authenticate(first);
    await first.pairDevice(signal);
    await authenticate(second);
    const secondPair = await second.pairDevice(signal) as { device: { publicId: string } };
    cloud.failNextApproveBeforeEffect = true;

    await expect(first.approveDevice(secondPair.device.publicId, signal)).rejects.toThrow(
      "approval unavailable before effect",
    );
    const oldKey = cloud.approvalAttempts[0]?.idempotencyKey;
    localNow += 7 * 24 * 60 * 60 * 1_000 + 1;

    expect(await first.approveDevice(secondPair.device.publicId, signal)).toMatchObject({
      device: { publicId: secondPair.device.publicId, status: "active" },
      replay: true,
    });
    expect(cloud.approvalAttempts).toHaveLength(2);
    expect(cloud.approvalAttempts[1]?.idempotencyKey).not.toBe(oldKey);

    cloud.failNextRevokeBeforeEffect = true;
    await expect(first.revokeDevice(secondPair.device.publicId, signal)).rejects.toThrow(
      "revocation unavailable before effect",
    );
    const oldRevokeKey = cloud.revocationAttempts[0]?.idempotencyKey;
    localNow += 7 * 24 * 60 * 60 * 1_000 + 1;
    expect(await first.revokeDevice(secondPair.device.publicId, signal)).toMatchObject({
      device: { publicId: secondPair.device.publicId, status: "revoked" },
      replay: true,
    });
    expect(cloud.revocationAttempts).toHaveLength(2);
    expect(cloud.revocationAttempts[1]?.idempotencyKey).not.toBe(oldRevokeKey);
  });

  test("paginates every device and resolves an exact device beyond the first page", async () => {
    const cloud = new FakeCloud();
    const adapter = control(cloud, new MemoryCustody());
    await authenticate(adapter);
    await adapter.pairDevice(signal);
    const template = [...cloud.devices.values()][0];
    if (template === undefined) throw new Error("missing device template");
    for (let index = 0; index < 125; index += 1) {
      const publicId = `device_bulk_${String(index).padStart(4, "0")}`;
      cloud.devices.set(publicId, {
        encryptedLabel: template.encryptedLabel,
        keyVersion: template.keyVersion,
        publicId,
        revision: 1,
        status: "pending",
        wrappingPublicKey: template.wrappingPublicKey,
      });
    }

    const listed = await adapter.listDevices(signal) as { devices: unknown[] };
    expect(listed.devices).toHaveLength(126);
    expect(await adapter.approveDevice("device_bulk_0124", signal)).toMatchObject({
      device: { publicId: "device_bulk_0124", status: "active" },
    });
  });

  test("replays the exact first-device registration outbox after a lost response and new auth", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const adapter = control(cloud, custody);
    await authenticate(adapter);
    cloud.failNextRegisterAfterEffect = true;
    cloud.failNextRegistrationRecovery = true;

    await expect(adapter.pairDevice(signal)).rejects.toThrow("lost registration response");
    expect(cloud.devices.size).toBe(1);
    expect(custody.values.has("cloud-device-registration")).toBe(true);
    expect(cloud.registrationAttempts).toHaveLength(1);
    const firstAttempt = JSON.stringify(cloud.registrationAttempts[0]);

    await adapter.logout(signal);
    await authenticate(adapter);
    expect(await adapter.pairDevice(signal)).toMatchObject({
      device: { status: "active" },
      paired: true,
      replay: true,
    });
    expect(cloud.devices.size).toBe(1);
    expect(cloud.registrationAttempts).toHaveLength(2);
    expect(JSON.stringify(cloud.registrationAttempts[1])).toBe(firstAttempt);
    expect(custody.values.has("cloud-device-registration")).toBe(false);
  });

  test("reconciles an aged registration by exact durable identity without replaying a new device", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const first = control(cloud, custody);
    await authenticate(first);
    cloud.failNextRegisterAfterEffect = true;
    cloud.failNextRegistrationRecovery = true;
    await expect(first.pairDevice(signal)).rejects.toThrow("lost registration response");
    const original = custody.values.get("cloud-device-registration")?.value;
    if (original === undefined) throw new Error("missing registration outbox fixture");
    const recovered = control(
      cloud,
      custody,
      () => fixedNow + 7 * 24 * 60 * 60 * 1_000 + 1,
    );
    const clear = custody.clearIfGeneration.bind(custody);
    let raced = false;
    custody.clearIfGeneration = async (slot, generation) => {
      if (slot === "cloud-device-registration" && !raced) {
        raced = true;
        const current = custody.values.get(slot);
        if (current === undefined) throw new Error("missing registration race fixture");
        await custody.compareAndSwap(slot, generation, current.value);
        return false;
      }
      return await clear(slot, generation);
    };
    await expect(recovered.pairDevice(signal)).rejects.toThrow(
      "Cloud secret state changed concurrently",
    );
    expect(custody.values.has("cloud-device-registration")).toBe(true);
    custody.clearIfGeneration = clear;
    expect(await recovered.pairDevice(signal)).toMatchObject({ paired: true });
    expect(cloud.devices.size).toBe(1);
    expect(JSON.stringify(cloud.registrationAttempts.at(-1))).toBe(original.replace(
      /,"userPublicId":"[^"]+","version":1/u,
      "",
    ));
    expect(custody.values.has("cloud-device-registration")).toBe(false);
  });

  test("never promotes a later device's provisional registration key after approval races recovery", async () => {
    const cloud = new FakeCloud();
    const firstCustody = new MemoryCustody();
    const secondCustody = new MemoryCustody();
    const first = control(cloud, firstCustody);
    const second = control(cloud, secondCustody);
    await authenticate(first);
    await first.pairDevice(signal);
    const sharedKey = accountKey(firstCustody);

    await authenticate(second);
    cloud.failNextRegisterAfterEffect = true;
    cloud.failNextRegistrationRecovery = true;
    await expect(second.pairDevice(signal)).rejects.toThrow("lost registration response");
    const provisionalKey = accountKey(secondCustody);
    expect(provisionalKey).not.toEqual(sharedKey);
    const pendingDevice = [...cloud.devices.values()].find((device) =>
      device.status === "pending");
    if (pendingDevice === undefined) throw new Error("missing pending device fixture");
    await first.approveDevice(pendingDevice.publicId, signal);

    await second.logout(signal);
    await authenticate(second);
    expect(await second.pairDevice(signal)).toMatchObject({ paired: true, replay: true });
    expect(accountKey(secondCustody)).toEqual(sharedKey);
    expect(accountKey(secondCustody)).not.toEqual(provisionalKey);
  });

  test("decrypts bounded compact sessions and usage and records a secret-free sync summary", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    let localNow = fixedNow;
    const adapter = control(cloud, custody, () => localNow);
    await authenticate(adapter);
    const pair = await adapter.pairDevice(signal) as { device: { publicId: string } };
    const key = accountKey(custody);
    const sessionPublicId = "session_12345678";
    const accountPublicId = "account_12345678";
    const digest = "a".repeat(64);
    const interactionId = "70000000-0000-4000-8000-000000000001";
    const events = [
      {
        kind: "user_message",
        sequence: 1,
        text: "hello",
        turnId: "turn_12345678",
      },
      {
        blocking: true,
        interactionId,
        interactionKind: "user_input",
        kind: "interaction_state",
        revision: 1,
        sequence: 2,
        state: "pending",
        summary: "Codex needs one answer",
      },
    ] as const;
    const sessionEnvelope = await encryptCompactEvents(events, key, {
      firstSequence: 1,
      keyVersion: 1,
      lastSequence: 2,
      sessionPublicId,
      sourceBootId: "boot_12345678",
      sourceDevicePublicId: pair.device.publicId,
      sourceFence: 1,
      stream: "compact",
      userPublicId,
    });
    const metadata = await encryptSessionMetadata({ name: "Release", note: null }, key, {
      entityPublicId: sessionPublicId,
      keyVersion: 1,
      kind: "session_metadata",
      userPublicId,
    });
    cloud.heads = [{
      compactHeadSequence: 2,
      compactTailDigest: digest,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: pair.device.publicId,
      metadata,
      metadataRevision: 1,
      projectionRevision: 1,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    }];
    cloud.chunks.set(sessionPublicId, [{
      authority: { bootGeneration: 1, bootId: "boot_12345678", fence: 1 },
      createdAt: fixedNow,
      digest,
      envelope: sessionEnvelope,
      firstSequence: 1,
      lastSequence: 2,
      sourceDevicePublicId: pair.device.publicId,
      stream: "compact",
    }]);
    const usageEnvelope = await encryptUsageProjection({ state: "unavailable" }, key, {
      entityPublicId: accountPublicId,
      keyVersion: 1,
      kind: "usage",
      userPublicId,
    });
    cloud.accounts = [{
      encryptedMetadata: metadata,
      publicId: accountPublicId,
      updatedAt: fixedNow,
    }];
    cloud.snapshots.set(accountPublicId, [{
      digest: "b".repeat(64),
      envelope: usageEnvelope,
      observedAt: fixedNow,
      receivedAt: fixedNow,
      sourceRevision: 1,
    }]);

    expect(await adapter.sync(signal)).toMatchObject({
      accountCount: 1,
      sessionCount: 1,
      synced: true,
      truncated: false,
      usageSnapshotCount: 1,
    });
    const state = custody.values.get("cloud-state")?.value ?? "";
    expect(state).not.toContain("hello");
    expect(state).not.toContain("t".repeat(32));
    expect(JSON.stringify(sessionEnvelope)).not.toContain(interactionId);
    expect(JSON.stringify(sessionEnvelope)).not.toContain("Codex needs one answer");
    expect(await adapter.status(signal)).toMatchObject({
      lastSync: { accountCount: 1, sessionCount: 1, usageSnapshotCount: 1 },
    });

    const selector = {
      executionDevicePublicId: pair.device.publicId,
      publicId: sessionPublicId,
    };
    expect(await adapter.listRemoteSessionHeads({ limit: 25, signal })).toEqual({
      sessions: [{
        compactHasRecoveryGap: false,
        compactHeadSequence: 2,
        compactStreamEpoch: 0,
        createdAt: fixedNow,
        executionDevicePublicId: pair.device.publicId,
        metadata: { name: "Release", note: null },
        publicId: sessionPublicId,
        state: "idle",
        updatedAt: fixedNow,
      }],
      truncated: false,
    });
    cloud.heads = Array.from({ length: 101 }, (_, index) => ({
      compactHeadSequence: 0,
      createdAt: fixedNow - index,
      detailHeadSequence: 0,
      executionDevicePublicId: pair.device.publicId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: `session_history_${String(index).padStart(4, "0")}_end`,
      state: "idle" as const,
      updatedAt: fixedNow - index,
    }));
    expect(await adapter.resolveRemoteSession({
      selector: "session_history_0100_",
      signal,
    })).toEqual({
      executionDevicePublicId: pair.device.publicId,
      publicId: "session_history_0100_end",
    });
    cloud.heads = [cloud.heads[0]!, {
      compactHeadSequence: 2,
      compactTailDigest: digest,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: pair.device.publicId,
      metadata,
      metadataRevision: 1,
      projectionRevision: 1,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    }];
    expect(await adapter.pullRemoteSession({ selector, signal })).toMatchObject({
      complete: true,
      events,
      executionDevicePublicId: pair.device.publicId,
      publicId: sessionPublicId,
    });
    await expect(adapter.pullRemoteSession({
      selector: { ...selector, executionDevicePublicId: "device_stale000" },
      signal,
    })).rejects.toThrow("execution authority changed");

    const request = {
      commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
      deadline: fixedNow + 60_000,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000002",
      payload: { kind: "set_fast", enabled: true } as const,
      selector,
      signal,
    };
    cloud.failNextEnqueueAfterEffect = true;
    await expect(adapter.enqueueRemoteCommand(request)).rejects.toThrow("lost command enqueue response");
    expect(custody.values.has("cloud-command-outbox")).toBe(true);
    expect(await adapter.enqueueRemoteCommand(request)).toEqual({
      commandPublicId: request.commandPublicId,
      idempotencyKey: request.idempotencyKey,
      kind: "set_fast",
      replay: true,
      sessionPublicId,
      state: "pending",
      targetDevicePublicId: pair.device.publicId,
    });
    expect(custody.values.has("cloud-command-outbox")).toBe(false);
    const commandEnvelope = parseEncryptedEnvelope(cloud.lastEnqueue?.payload);
    if (commandEnvelope === null) throw new Error("missing encrypted command fixture");
    expect(await decryptRemoteCommand(commandEnvelope, key, {
      entityPublicId: request.commandPublicId,
      keyVersion: commandEnvelope.keyVersion,
      kind: "command",
      userPublicId,
    })).toEqual(request.payload);
    cloud.commandStates.set(request.commandPublicId, "failed");
    cloud.commandResultCodes.set(request.commandPublicId, "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT");
    expect(await adapter.getRemoteCommandStatus({
      commandPublicId: request.commandPublicId,
      signal,
    })).toEqual({
      commandPublicId: request.commandPublicId,
      kind: "set_fast",
      resultCode: "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT",
      sessionPublicId,
      state: "failed",
      targetDevicePublicId: pair.device.publicId,
    });

    const racedRequest = {
      ...request,
      commandPublicId: "018bcfe5-6800-7000-8000-000000000005",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000006",
    };
    cloud.failNextEnqueueAfterEffect = true;
    await expect(adapter.enqueueRemoteCommand(racedRequest)).rejects.toThrow(
      "lost command enqueue response",
    );
    const clear = custody.clearIfGeneration.bind(custody);
    let raced = false;
    custody.clearIfGeneration = async (slot, generation) => {
      if (slot === "cloud-command-outbox" && !raced) {
        raced = true;
        const current = custody.values.get(slot);
        if (current === undefined) throw new Error("missing command race fixture");
        await custody.compareAndSwap(slot, generation, current.value);
        return false;
      }
      return await clear(slot, generation);
    };
    await expect(adapter.enqueueRemoteCommand(racedRequest)).rejects.toThrow(
      "Cloud secret state changed concurrently",
    );
    expect(custody.values.has("cloud-command-outbox")).toBe(true);
    custody.clearIfGeneration = clear;
    expect(await adapter.enqueueRemoteCommand(racedRequest)).toMatchObject({ replay: true });

    const ackLostRequest = {
      ...request,
      commandPublicId: "018bcfe5-6800-7000-8000-000000000007",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000008",
    };
    const enqueueAttemptsBeforeAckLoss = cloud.enqueueAttempts;
    cloud.failNextAckAfterEffect = true;
    await expect(adapter.enqueueRemoteCommand(ackLostRequest)).rejects.toThrow(
      "lost command acknowledgement response",
    );
    expect(custody.values.has("cloud-command-outbox")).toBe(true);
    expect(await adapter.enqueueRemoteCommand(ackLostRequest)).toMatchObject({
      commandPublicId: ackLostRequest.commandPublicId,
      replay: true,
    });
    expect(cloud.enqueueAttempts).toBe(enqueueAttemptsBeforeAckLoss + 2);
    expect(cloud.acknowledgementAttempts).toBeGreaterThanOrEqual(2);
    expect(custody.values.has("cloud-command-outbox")).toBe(false);

    const firstSamePayload = {
      ...request,
      commandPublicId: "018bcfe5-6800-7000-8000-000000000021",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000022",
    };
    const freshSamePayload = {
      ...request,
      commandPublicId: "018bcfe5-6800-7000-8000-000000000023",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000024",
    };
    cloud.failNextEnqueueAfterEffect = true;
    await expect(adapter.enqueueRemoteCommand(firstSamePayload)).rejects.toThrow(
      "lost command enqueue response",
    );
    const countAfterLostResponse = cloud.commands.size;
    await expect(adapter.enqueueRemoteCommand(freshSamePayload)).rejects.toThrow(
      `Recovered cloud command ${firstSamePayload.commandPublicId}`,
    );
    expect(cloud.commands.size).toBe(countAfterLostResponse);
    expect(await adapter.enqueueRemoteCommand(freshSamePayload)).toMatchObject({
      commandPublicId: freshSamePayload.commandPublicId,
      replay: false,
    });
    expect(cloud.commands.size).toBe(countAfterLostResponse + 1);

    const abandoned = {
      ...request,
      commandPublicId: "018bcfe5-6800-7000-8000-000000000003",
      deadline: fixedNow + 7 * 24 * 60 * 60 * 1_000,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000004",
    };
    cloud.failNextEnqueueBeforeEffect = true;
    await expect(adapter.enqueueRemoteCommand(abandoned)).rejects.toThrow(
      "enqueue unavailable before effect",
    );
    localNow = fixedNow + 7 * 24 * 60 * 60 * 1_000 + 1;
    await expect(adapter.enqueueRemoteCommand(abandoned)).rejects.toThrow(
      "absent remotely and has been abandoned",
    );
    expect(custody.values.has("cloud-command-outbox")).toBe(false);

    const futureUuid = {
      ...request,
      commandPublicId: "0f7b3736-4000-7000-8000-000000000001",
      deadline: fixedNow + 7 * 24 * 60 * 60 * 1_000,
      idempotencyKey: "0f7b3736-4000-7000-8000-000000000002",
    };
    localNow = fixedNow;
    cloud.failNextEnqueueAfterEffect = true;
    await expect(adapter.enqueueRemoteCommand(futureUuid)).rejects.toThrow(
      "lost command enqueue response",
    );
    cloud.commandStates.set(futureUuid.commandPublicId, "applied");
    localNow = fixedNow + 30 * 24 * 60 * 60 * 1_000;
    expect([...cloud.commands.values()].some((command) =>
      command.response.publicId === futureUuid.commandPublicId)).toBe(true);
    expect(await adapter.enqueueRemoteCommand(futureUuid)).toMatchObject({
      commandPublicId: futureUuid.commandPublicId,
      replay: true,
      state: "applied",
    });
    expect(custody.values.has("cloud-command-outbox")).toBe(false);
    const freshAfterRetention = {
      ...futureUuid,
      commandPublicId: "0f7b3736-4000-7000-8000-000000000003",
      deadline: localNow + 60_000,
      idempotencyKey: "0f7b3736-4000-7000-8000-000000000004",
    };
    const attemptsBeforeFresh = cloud.enqueueAttempts;
    expect(await adapter.enqueueRemoteCommand(freshAfterRetention)).toMatchObject({
      commandPublicId: freshAfterRetention.commandPublicId,
      replay: false,
    });
    expect(cloud.enqueueAttempts).toBe(attemptsBeforeFresh + 1);
  });

  test("does not dispatch a durable command after its deadline", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    let localNow = fixedNow;
    const adapter = control(cloud, custody, () => localNow);
    await authenticate(adapter);
    const pair = await adapter.pairDevice(signal) as { device: { publicId: string } };
    const sessionPublicId = "session_deadline1";
    cloud.heads = [{
      compactHeadSequence: 0,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: pair.device.publicId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow,
    }];
    const request = {
      commandPublicId: "018bcfe5-6800-7000-8000-000000000011",
      deadline: fixedNow + 60_000,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000012",
      payload: { kind: "stop" } as const,
      selector: {
        executionDevicePublicId: pair.device.publicId,
        publicId: sessionPublicId,
      },
      signal,
    };
    cloud.failNextEnqueueBeforeEffect = true;
    await expect(adapter.enqueueRemoteCommand(request)).rejects.toThrow(
      "enqueue unavailable before effect",
    );
    localNow = request.deadline;

    await expect(adapter.enqueueRemoteCommand(request)).rejects.toThrow(
      "abandoned without dispatch",
    );
    expect(cloud.enqueueAttempts).toBe(1);
    expect(custody.values.has("cloud-command-outbox")).toBe(false);
  });

  test("returns the authenticated latest eight chunks when a compact session has nine", async () => {
    const cloud = new FakeCloud();
    const custody = new MemoryCustody();
    const adapter = control(cloud, custody);
    await authenticate(adapter);
    const pair = await adapter.pairDevice(signal) as { device: { publicId: string } };
    const key = accountKey(custody);
    const sessionPublicId = "session_ninechunks";
    const chunks: unknown[] = [];
    let previousDigest: string | undefined;
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      const digest = sequence.toString(16).repeat(64);
      const envelope = await encryptCompactEvents([{
        kind: "assistant_message",
        sequence,
        text: `response ${String(sequence)}`,
        turnId: `turn_chunk_${String(sequence).padStart(2, "0")}`,
      }], key, {
        firstSequence: sequence,
        keyVersion: 1,
        lastSequence: sequence,
        ...(previousDigest === undefined ? {} : { previousDigest }),
        sessionPublicId,
        sourceBootId: "boot_12345678",
        sourceDevicePublicId: pair.device.publicId,
        sourceFence: 1,
        stream: "compact",
        userPublicId,
      });
      chunks.push({
        authority: { bootGeneration: 1, bootId: "boot_12345678", fence: 1 },
        createdAt: fixedNow + sequence,
        digest,
        envelope,
        firstSequence: sequence,
        lastSequence: sequence,
        ...(previousDigest === undefined ? {} : { previousDigest }),
        sourceDevicePublicId: pair.device.publicId,
        stream: "compact",
        streamEpoch: sequence >= 6 ? 1 : 0,
      });
      previousDigest = digest;
    }
    cloud.chunks.set(sessionPublicId, chunks);
    cloud.heads = [{
      compactHasRecoveryGap: true,
      compactHeadSequence: 9,
      compactStreamEpoch: 1,
      compactTailDigest: previousDigest,
      createdAt: fixedNow,
      detailHeadSequence: 0,
      executionDevicePublicId: pair.device.publicId,
      metadataRevision: 0,
      projectionRevision: 9,
      publicId: sessionPublicId,
      state: "idle",
      updatedAt: fixedNow + 9,
    }];

    const pulled = await adapter.pullRemoteSession({
      selector: { executionDevicePublicId: pair.device.publicId, publicId: sessionPublicId },
      signal,
    });
    expect(pulled.complete).toBe(false);
    expect(pulled.recoveryGap).toEqual({
      kind: "projection_cache_recovery",
      streamEpoch: 1,
    });
    expect(pulled.events.map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pulled.events.at(-1)).toMatchObject({ text: "response 9" });
  });
});
