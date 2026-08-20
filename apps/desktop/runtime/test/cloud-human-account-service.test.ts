import { describe, expect, test } from "bun:test";
import {
  humanAuthenticationSchema,
  SecretStoreAccessDeniedError,
  type FetchLike,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyQuarantinePointer,
  type SecretStore,
} from "@hraness/hra-human-client";

import {
  HumanAccountService,
  HumanCredentialCustody,
  HRA_CLOUD_API_URL_ENV,
  HRA_WORKOS_CLIENT_ID_ENV,
  createHumanAccountRuntime,
  parseHRACloudConfiguration,
  type HumanAccountMetadata,
  type HumanAccountMetadataPort,
  type HumanAccountSnapshot,
  type HumanCredentialClearAuthority,
} from "../src/cloud";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const REQUEST_ID = `req_${LOCATOR}`;
const IDEMPOTENCY_KEY = "018f22c0-6b3c-7a91-8abc-123456789abc"; // gitleaks:allow - deterministic test vector
const API_ORIGIN = "https://hra.example.com";

class MemoryMetadata implements HumanAccountMetadataPort {
  journal: SecretCustodyJournal | null = null;
  account: HumanAccountMetadata | null = null;
  readonly quarantined: SecretCustodyQuarantinePointer[] = [];

  read(descriptor: SecretCustodyDescriptor): Promise<unknown> {
    void descriptor;
    return Promise.resolve(this.journal);
  }

  compareAndSwap(input: {
    readonly expectedRevision: number | null;
    readonly next: SecretCustodyJournal;
  }): Promise<boolean> {
    if ((this.journal?.revision ?? null) !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.journal = input.next;
    return Promise.resolve(true);
  }

  compareAndSwapWithQuarantine(input: {
    readonly expectedRevision: number;
    readonly next: SecretCustodyJournal;
    readonly quarantined: readonly SecretCustodyQuarantinePointer[];
  }): Promise<boolean> {
    if (this.journal?.revision !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.journal = input.next;
    this.quarantined.push(...input.quarantined);
    return Promise.resolve(true);
  }

  isQuarantinedSlot(input: { readonly slot: string }): Promise<boolean> {
    return Promise.resolve(
      this.quarantined.some(({ pointer }) => pointer.slot === input.slot),
    );
  }

  readAccountMetadata(): Promise<unknown> {
    return Promise.resolve(this.account);
  }

  compareAndSwapAccountMetadata(input: {
    readonly expectedRevision: number | null;
    readonly next: HumanAccountMetadata;
  }): Promise<boolean> {
    if ((this.account?.revision ?? null) !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.account = input.next;
    return Promise.resolve(true);
  }
}

function secretKey(input: {
  readonly service: string;
  readonly name: string;
}): string {
  return `${input.service}:${input.name}`;
}

function memorySecrets(): SecretStore & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: (input) => Promise.resolve(values.get(secretKey(input)) ?? null),
    set: (input) => {
      values.set(secretKey(input), input.value);
      return Promise.resolve();
    },
    delete: (input) => Promise.resolve(values.delete(secretKey(input))),
  };
}

function configuration() {
  return parseHRACloudConfiguration({
    [HRA_CLOUD_API_URL_ENV]: API_ORIGIN,
    [HRA_WORKOS_CLIENT_ID_ENV]: "client_public123",
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulDeviceFetch(): FetchLike {
  return (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/authorize/device")) {
      return Promise.resolve(json({
        device_code: "private-device-code-for-recovery",
        user_code: "RECOVER-ME",
        verification_uri: "https://auth.example.com/device",
        expires_in: 600,
        interval: 1,
      }));
    }
    if (url.pathname.endsWith("/authenticate")) {
      return Promise.resolve(json({
        access_token: "recovered-access-token-that-stays-private",
        refresh_token: "recovered-refresh-token-that-stays-private",
        user: {
          id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          email: "chef@example.com",
          name: "Chef",
        },
      }));
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  };
}

describe("optional desktop WorkOS account service", () => {
  test("exposes the human session only through the gateway-internal runtime factory", () => {
    const enabledMetadata = new MemoryMetadata();
    const enabled = createHumanAccountRuntime({
      configuration: configuration(),
      metadata: enabledMetadata,
      credentials: new HumanCredentialCustody({
        metadata: enabledMetadata,
        secrets: memorySecrets(),
        nextSlot: () => "factoryopaqueslot",
      }),
      fetch: successfulDeviceFetch(),
    });
    expect(enabled.session).not.toBeNull();
    expect(enabled.session).toBe(
      enabled.account.gatewaySessionCoordinator(),
    );
    expect(enabled.cloud).not.toBeNull();

    const disabledMetadata = new MemoryMetadata();
    const disabled = createHumanAccountRuntime({
      configuration: parseHRACloudConfiguration({}),
      metadata: disabledMetadata,
      credentials: new HumanCredentialCustody({
        metadata: disabledMetadata,
        secrets: memorySecrets(),
        nextSlot: () => "disabledfactoryslot",
      }),
    });
    expect(disabled.session).toBeNull();
    expect(disabled.account.gatewaySessionCoordinator()).toBeNull();
    expect(disabled.cloud).toBeNull();
  });

  test("emits only renderer-safe device state and preserves token-free selections", async () => {
    const deviceCode = "device-code-that-must-stay-private";
    const firstAccess = "first-access-token-that-must-stay-private";
    const firstRefresh = "first-refresh-token-that-must-stay-private";
    const rotatedAccess = "rotated-access-token-that-must-stay-private";
    const rotatedRefresh = "rotated-refresh-token-that-must-stay-private";
    const finalAccess = "final-access-token-that-must-stay-private";
    const finalRefresh = "final-refresh-token-that-must-stay-private";
    const emitted: HumanAccountSnapshot[] = [];
    const requests: Request[] = [];
    let authenticationCommitCount = 0;
    let authenticationAuthorityCount = 0;
    const metadata = new MemoryMetadata();
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: memorySecrets(),
      nextSlot: (() => {
        const slots = [
          "accountopaqueslot1",
          "accountopaqueslot2",
          "accountopaqueslot3",
        ];
        let index = 0;
        return () => slots[index++] ?? "accountopaqueslot4";
      })(),
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      withAuthenticationCommit: async (_authentication, commit) => {
        authenticationCommitCount += 1;
        return await commit();
      },
      withAuthenticationAuthority: async (_authority, operation) => {
        authenticationAuthorityCount += 1;
        return await operation();
      },
      emit: (snapshot) => emitted.push(snapshot),
      sleep: () => Promise.resolve(),
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.hostname === "api.workos.com" &&
            url.pathname.endsWith("/authorize/device")) {
          return Promise.resolve(json({
            device_code: deviceCode,
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.example.com/device",
            verification_uri_complete:
              "https://auth.example.com/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 1,
          }));
        }
        if (url.hostname === "api.workos.com" &&
            url.pathname.endsWith("/authenticate")) {
          return Promise.resolve(json({
            access_token: firstAccess,
            refresh_token: firstRefresh,
            user: {
              id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              email: "chef@example.com",
              name: "Chef",
            },
          }));
        }
        if (url.pathname === "/v1/organizations" && request.method === "GET") {
          return Promise.resolve(json({
            ok: true,
            data: {
              organizations: [{
                id: "org_oprte",
                name: "OPRTE",
                role: "admin",
                status: "active",
                workosOrganizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              }],
              cursor: null,
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/organizations" && request.method === "POST") {
          return Promise.resolve(json({
            ok: true,
            data: {
              organization: {
                id: "org_second",
                name: "Second OPRTE",
                role: "admin",
                status: "provisioning",
              },
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/auth/refresh") {
          const authorization = request.headers.get("authorization");
          if (authorization === null) {
            throw new Error("refresh authorization header was missing");
          }
          expect([`Bearer ${firstRefresh}`, `Bearer ${rotatedRefresh}`])
            .toContain(authorization);
          const firstRotation = authorization === `Bearer ${firstRefresh}`;
          return Promise.resolve(json({
            ok: true,
            data: {
              accessToken: firstRotation ? rotatedAccess : finalAccess,
              refreshToken: firstRotation ? rotatedRefresh : finalRefresh,
              user: {
                id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                email: "chef@example.com",
                name: "Chef",
              },
              workosOrganizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/hra/workspaces") {
          const authorization = request.headers.get("authorization");
          if (authorization === `Bearer ${rotatedAccess}`) {
            return Promise.resolve(json({
              error: {
                code: "AUTHENTICATION_FAILED",
                message: "Authentication failed.",
                requestId: REQUEST_ID,
                details: {},
              },
            }, 401));
          }
          expect(authorization).toBe(`Bearer ${finalAccess}`);
          return Promise.resolve(json({
            ok: true,
            data: {
              workspaces: [{
                id: `wsp_${LOCATOR}`,
                name: "OPRTE",
                slug: "oprte",
                keyPrefix: "KIT",
                revision: 3,
                authority: {
                  kind: "cloud",
                  cloudWorkspaceId: `wsp_${LOCATOR}`,
                },
                counts: {
                  all: { capped: false, value: 0 },
                  ready: { capped: false, value: 0 },
                  blocked: { capped: false, value: 0 },
                  deferred: { capped: false, value: 0 },
                  attention: { capped: false, value: 0 },
                  assigned: { capped: false, value: 0 },
                  review: { capped: false, value: 0 },
                },
              }],
              cursor: null,
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/workspaces") {
          expect(request.headers.get("authorization"))
            .toBe(`Bearer ${rotatedAccess}`);
          return Promise.resolve(json({
            ok: true,
            data: {
              workspaces: [{
                id: "workspace_oprte",
                organizationId: "org_oprte",
                slug: "oprte",
                name: "OPRTE",
                taskKeyPrefix: "KIT",
                roles: ["planner"],
              }],
              cursor: null,
            },
            requestId: REQUEST_ID,
          }));
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
      now: () => 1_000,
    });

    expect(await account.initialize()).toMatchObject({ state: "signed_out" });
    expect(account.startSignIn()).toMatchObject({ state: "signing_in" });
    expect(await account.signInCompletion()).toMatchObject({
      state: "signed_in",
      profile: { user: { email: "chef@example.com" } },
    });
    expect(authenticationCommitCount).toBe(1);
    const signedInBeforeDuplicateStart = account.snapshot();
    expect(account.startSignIn()).toBe(signedInBeforeDuplicateStart);
    expect(await account.createOrganization({
      name: "Second OPRTE",
      idempotencyKey: IDEMPOTENCY_KEY,
    })).toMatchObject({
      ok: true,
      data: { organization: { id: "org_second" } },
    });
    expect(await account.selectOrganization("org_oprte")).toMatchObject({
      ok: true,
      data: { organization: { id: "org_oprte" } },
    });
    expect(authenticationCommitCount).toBe(1);
    expect(authenticationAuthorityCount).toBe(1);
    expect(await account.selectWorkspace("workspace_oprte")).toMatchObject({
      ok: true,
      data: { workspace: { id: "workspace_oprte" } },
    });
    expect(account.snapshot()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 2,
      profile: {
        organization: { id: "org_oprte" },
        workspace: { id: "workspace_oprte" },
      },
    });
    const cloud = account.cloudWorkspaceClient();
    if (cloud === null) throw new Error("cloud client was not configured");
    expect(await cloud.listWorkspaces()).toMatchObject({
      ok: true,
      data: { workspaces: [{ id: `wsp_${LOCATOR}` }] },
    });
    expect(account.snapshot()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 3,
    });
    expect(authenticationCommitCount).toBe(1);
    expect(authenticationAuthorityCount).toBe(1);
    expect(metadata.account).toMatchObject({ credentialGeneration: 3 });

    const rendererSource = JSON.stringify(emitted);
    const sqliteSource = JSON.stringify({
      account: metadata.account,
      journal: metadata.journal,
    });
    for (const secret of [
      deviceCode,
      firstAccess,
      firstRefresh,
      rotatedAccess,
      rotatedRefresh,
      finalAccess,
      finalRefresh,
      "user_code=ABCD-EFGH",
    ]) {
      expect(rendererSource).not.toContain(secret);
      expect(sqliteSource).not.toContain(secret);
    }
    expect(rendererSource).toContain("ABCD-EFGH");
    expect(rendererSource).toContain("https://auth.example.com/device");
    expect(requests.filter(({ url }) => url.startsWith(API_ORIGIN)).length)
      .toBe(7);
  });

  test("cancels device polling and fences the stale completion before Keychain write", async () => {
    const metadata = new MemoryMetadata();
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: memorySecrets(),
      nextSlot: () => "cancelopaqueslot",
    });
    let polls = 0;
    let verificationResolve = (): void => undefined;
    const verificationSeen = new Promise<void>((resolve) => {
      verificationResolve = resolve;
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      sleep: () => new Promise(() => undefined),
      fetch: (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/authorize/device")) {
          return Promise.resolve(json({
            device_code: "cancelled-device-code-private",
            user_code: "CANCEL-ME",
            verification_uri: "https://auth.example.com/device",
            expires_in: 600,
            interval: 1,
          }));
        }
        polls += 1;
        return Promise.resolve(json({ error: "authorization_pending" }, 400));
      },
      emit: (snapshot) => {
        if (
          snapshot.state === "signing_in" &&
          snapshot.verification !== undefined
        ) {
          verificationResolve();
        }
      },
      now: () => 1_000,
    });

    expect(account.startSignIn()).toMatchObject({ state: "initializing" });
    expect(polls).toBe(0);
    expect(await account.initialize()).toMatchObject({ state: "signed_out" });
    account.startSignIn();
    await verificationSeen;
    expect(await account.cancelSignIn()).toMatchObject({ state: "signed_out" });
    expect(await credentials.read()).toBeNull();
    expect(metadata.account?.profile ?? null).toBeNull();
    expect(polls).toBe(0);
  });

  test("closed admission joins a detached sign-in custody write before teardown", async () => {
    const metadata = new MemoryMetadata();
    const backing = memorySecrets();
    let markWriteEntered = (): void => undefined;
    const writeEntered = new Promise<void>((resolve) => {
      markWriteEntered = resolve;
    });
    let releaseWrite = (): void => undefined;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const gatedSecrets: SecretStore = {
      get: async (input) => await backing.get(input),
      set: async (input) => {
        markWriteEntered();
        await writeReleased;
        await backing.set(input);
      },
      delete: async (input) => await backing.delete(input),
    };
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: gatedSecrets,
      nextSlot: () => "quiescedsignin01",
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulDeviceFetch(),
      sleep: () => Promise.resolve(),
      now: () => 1_000,
    });

    expect(await account.initialize()).toMatchObject({ state: "signed_out" });
    account.startSignIn();
    await writeEntered;
    account.closeAdmission();
    const cancellation = account.cancelSignIn();
    const settlement = account.settled();
    expect(account.hasActiveOperation()).toBeTrue();
    expect(await Promise.race([
      settlement.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5)),
    ])).toBe("blocked");

    releaseWrite();
    await Promise.all([cancellation, settlement]);
    expect(account.hasActiveOperation()).toBeFalse();
    expect(await credentials.read()).toBeNull();
    expect(backing.values.size).toBe(0);
    expect(await account.signOut().then(
      () => null,
      (error: unknown) => error,
    )).toBeInstanceOf(Error);
  });

  test("explicit sign-out abandons a crash before Keychain write and permits attachment again", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let rejectNextSet = true;
    const crashBeforeWrite: SecretStore = {
      get: async (input) => await secrets.get(input),
      set: async (input) => {
        if (rejectNextSet) {
          rejectNextSet = false;
          throw new Error("injected crash before Keychain write");
        }
        await secrets.set(input);
      },
      delete: async (input) => await secrets.delete(input),
    };
    const crashedCredentials = new HumanCredentialCustody({
      metadata,
      secrets: crashBeforeWrite,
      nextSlot: () => "crashedaccountslot",
    });
    const crashed = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials: crashedCredentials,
      fetch: successfulDeviceFetch(),
      sleep: () => Promise.resolve(),
      now: () => 1_000,
    });

    expect(await crashed.initialize()).toMatchObject({ state: "signed_out" });
    expect(crashed.startSignIn()).toMatchObject({ state: "signing_in" });
    expect(await crashed.signInCompletion()).toMatchObject({
      state: "error",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(metadata.journal?.pending).toMatchObject({
      pointer: { generation: 0, slot: "crashedaccountslot" },
      replacesGeneration: null,
    });
    expect(secrets.values.size).toBe(0);

    const recoveredCredentials = new HumanCredentialCustody({
      metadata,
      secrets: crashBeforeWrite,
      nextSlot: () => "recoveredacctslot",
    });
    const restarted = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials: recoveredCredentials,
      fetch: successfulDeviceFetch(),
      sleep: () => Promise.resolve(),
      now: () => 1_000,
    });
    const recovery = await restarted.initialize();
    expect(recovery).toMatchObject({ state: "recovery_required" });
    expect(await restarted.confirmLegacyCredentialReconnect(recovery.revision))
      .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
    expect(metadata.journal?.pending).toBeUndefined();
    expect(metadata.journal?.committed).toBeUndefined();
    expect(metadata.account?.profile ?? null).toBeNull();

    expect(restarted.startSignIn()).toMatchObject({ state: "signing_in" });
    expect(await restarted.signInCompletion()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 1,
    });
    expect(metadata.journal).toMatchObject({
      latestGeneration: 1,
      committed: { generation: 1, slot: "recoveredacctslot" },
    });
    expect(secrets.values.size).toBe(1);
  });

  test("explicit sign-out journal-deletes an invalid pending Keychain envelope", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    const pendingSlot = "invalidaccountslot";
    metadata.journal = {
      version: 1,
      revision: 0,
      latestGeneration: 0,
      service: "kitchen.hraness.cloud-human.v1",
      name: "primary",
      pending: {
        pointer: { generation: 0, slot: pendingSlot },
        replacesGeneration: null,
      },
    };
    secrets.values.set(
      `kitchen.hraness.cloud-human.v1:primary:slot:${pendingSlot}`,
      JSON.stringify({
        version: 1,
        generation: 41,
        value: "invalid-pending-human-credential",
      }),
    );
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "postinvalidacctslot",
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulDeviceFetch(),
    });

    const recovery = await account.initialize();
    expect(recovery).toMatchObject({ state: "recovery_required" });
    expect(await account.confirmLegacyCredentialReconnect(recovery.revision))
      .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
    expect(metadata.journal?.pending).toBeUndefined();
    expect(metadata.journal?.deleting).toBeUndefined();
    expect(secrets.values.size).toBe(1);
    expect(metadata.quarantined).toHaveLength(1);
  });

  test("direct account selection reconciles the actual generation after a custody gap", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let rejectNextSet = false;
    const faultedSecrets: SecretStore = {
      get: async (input) => await secrets.get(input),
      set: async (input) => {
        if (rejectNextSet) {
          rejectNextSet = false;
          throw new Error("injected pre-Keychain crash");
        }
        await secrets.set(input);
      },
      delete: async (input) => await secrets.delete(input),
    };
    const slotValues = [
      "servicegaporiginal",
      "servicegapmissing1",
      "servicegapactual02",
    ];
    let slotIndex = 0;
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: faultedSecrets,
      nextSlot: () => slotValues[slotIndex++] ?? "servicegapunused01",
    });
    const originalAuthentication = humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: API_ORIGIN,
      accessToken: "service-gap-original-access-token",
      refreshToken: "service-gap-original-refresh-token",
      user: {
        id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "chef@example.com",
        name: "Chef",
      },
    });
    const original = await credentials.write(originalAuthentication);
    rejectNextSet = true;
    expect(credentials.compareAndSwap({
      expectedGeneration: original.generation,
      next: {
        generation: 1,
        authentication: humanAuthenticationSchema.parse({
          ...originalAuthentication,
          accessToken: "service-gap-lost-access-token",
          refreshToken: "service-gap-lost-refresh-token",
        }),
      },
    })).rejects.toMatchObject({ reason: "custody_unavailable" });
    expect(
      await credentials.recover({ abandonMissingPending: true }),
    ).toMatchObject({
      state: "abandoned_missing_pending",
      generation: 0,
    });

    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/v1/organizations") {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${originalAuthentication.accessToken}`,
          );
          return Promise.resolve(json({
            ok: true,
            data: {
              organizations: [{
                id: "org_oprte",
                name: "OPRTE",
                role: "admin",
                status: "active",
                workosOrganizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              }],
              cursor: null,
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/auth/refresh") {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${originalAuthentication.refreshToken}`,
          );
          return Promise.resolve(json({
            ok: true,
            data: {
              accessToken: "service-gap-actual-access-token",
              refreshToken: "service-gap-actual-refresh-token",
              user: originalAuthentication.user,
              workosOrganizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            },
            requestId: REQUEST_ID,
          }));
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });
    expect(await account.initialize()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 0,
    });
    expect(await account.selectOrganization("org_oprte")).toMatchObject({
      ok: true,
      data: { organization: { id: "org_oprte" } },
    });
    expect(account.snapshot()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 2,
    });
    expect(metadata.account).toMatchObject({ credentialGeneration: 2 });
    expect(await credentials.read()).toMatchObject({ generation: 2 });
    expect(secrets.values.size).toBe(1);
  });

  test("session cleanup projects signed out before a retryable Keychain delete", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let rejectNextDelete = true;
    const flakyDelete: SecretStore = {
      get: async (input) => await secrets.get(input),
      set: async (input) => await secrets.set(input),
      delete: async (input) => {
        if (rejectNextDelete) {
          rejectNextDelete = false;
          throw new Error("injected Keychain deletion failure");
        }
        return await secrets.delete(input);
      },
    };
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: flakyDelete,
      nextSlot: () => "sessionclearslot01",
    });
    await credentials.write(humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: API_ORIGIN,
      accessToken: "expired-session-access-token-that-stays-private",
      refreshToken: "expired-session-refresh-token-that-stays-private",
      user: {
        id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "chef@example.com",
        name: "Chef",
      },
    }));
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        expect(["/v1/organizations", "/v1/auth/refresh"]).toContain(
          new URL(request.url).pathname,
        );
        return Promise.resolve(json({
          error: {
            code: "AUTHENTICATION_FAILED",
            message: "Authentication failed.",
            requestId: REQUEST_ID,
            details: {},
          },
        }, 401));
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });

    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(account.snapshot()).toMatchObject({ state: "signed_out" });
    expect(metadata.account?.profile ?? null).toBeNull();
    expect(metadata.journal?.committed).toBeUndefined();
    expect(metadata.journal?.deleting).toEqual([
      { generation: 0, slot: "sessionclearslot01" },
    ]);
    expect(secrets.values.size).toBe(1);

    expect(await account.signOut()).toMatchObject({ state: "signed_out" });
    expect(metadata.journal?.deleting).toBeUndefined();
    expect(secrets.values.size).toBe(0);
  });

  test("ordinary sign-out reports Keychain deletion failure and retries from its journal", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let rejectNextDelete = true;
    const flakyDelete: SecretStore = {
      get: async (input) => await secrets.get(input),
      set: async (input) => await secrets.set(input),
      delete: async (input) => {
        if (rejectNextDelete) {
          rejectNextDelete = false;
          throw new Error("injected Keychain deletion failure");
        }
        return await secrets.delete(input);
      },
    };
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: flakyDelete,
      nextSlot: () => "signoutopaqueslot",
    });
    await credentials.write(humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: API_ORIGIN,
      accessToken: "signed-in-access-token-that-stays-private",
      refreshToken: "signed-in-refresh-token-that-stays-private",
      user: {
        id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "chef@example.com",
        name: "Chef",
      },
    }));
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulDeviceFetch(),
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });

    expect(await account.signOut()).toMatchObject({
      state: "error",
      error: {
        code: "SERVICE_UNAVAILABLE",
        retryable: true,
      },
    });
    expect(metadata.journal?.committed).toBeUndefined();
    expect(metadata.journal?.deleting).toEqual([
      { generation: 0, slot: "signoutopaqueslot" },
    ]);
    expect(secrets.values.size).toBe(1);

    expect(await account.signOut()).toMatchObject({ state: "signed_out" });
    expect(metadata.journal?.deleting).toBeUndefined();
    expect(metadata.account?.profile ?? null).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  test("post-initialize session custody faults project a visible recovery path", async () => {
    for (const mode of ["denied", "missing", "invalid"] as const) {
      const metadata = new MemoryMetadata();
      const backing = memorySecrets();
      let access: typeof mode | "healthy" = "healthy";
      let deleteAttempts = 0;
      const secrets: SecretStore = {
        get: async (input) => {
          if (access === "denied") {
            throw new SecretStoreAccessDeniedError();
          }
          if (access === "missing") return null;
          if (access === "invalid") return "{malformed-keychain-envelope";
          return await backing.get(input);
        },
        set: async (input) => await backing.set(input),
        delete: () => {
          deleteAttempts += 1;
          return Promise.reject(new Error("session recovery must not delete"));
        },
      };
      const credentials = new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => "session_fault_slot01",
      });
      await credentials.write(humanAuthenticationSchema.parse({
        version: 1,
        apiUrl: API_ORIGIN,
        accessToken: "session-fault-private-access",
        refreshToken: "session-fault-private-refresh",
        user: {
          id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          email: "chef@example.com",
          name: "Chef",
        },
      }));
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulDeviceFetch(),
      });
      expect(await account.initialize()).toMatchObject({ state: "signed_in" });

      access = mode;
      expect(await account.listOrganizations()).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      const failed = account.snapshot();
      expect(failed).toMatchObject({
        state: "error",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      });
      const retried = await account.retryCredentialRecovery(failed.revision);
      expect(retried).toMatchObject({
        ok: true,
        snapshot: { state: "recovery_required" },
      });
      if (!retried.ok) throw new Error("credential reinspection was rejected");
      expect(await account.confirmLegacyCredentialReconnect(
        retried.snapshot.revision,
      )).toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
      expect(metadata.quarantined.map(({ reason }) => reason)).toEqual([
        mode === "denied"
          ? "legacy_identity_access_denied"
          : mode === "missing"
          ? "missing_pointer_abandoned"
          : "invalid_pointer_preserved",
      ]);
      expect(deleteAttempts).toBe(0);
    }
  });

  test("post-initialize sign-out denial and transient faults remain recoverable", async () => {
    for (const mode of ["denied", "transient"] as const) {
      const metadata = new MemoryMetadata();
      const backing = memorySecrets();
      let access: typeof mode | "healthy" = "healthy";
      let deleteAttempts = 0;
      const secrets: SecretStore = {
        get: async (input) => {
          if (access === "denied") {
            throw new SecretStoreAccessDeniedError();
          }
          if (access === "transient") throw new Error("temporary Keychain fault");
          return await backing.get(input);
        },
        set: async (input) => await backing.set(input),
        delete: async (input) => {
          deleteAttempts += 1;
          if (access === "healthy") return await backing.delete(input);
          throw new Error("injected Keychain deletion failure");
        },
      };
      const credentials = new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => "post_init_fault_001",
      });
      await credentials.write(humanAuthenticationSchema.parse({
        version: 1,
        apiUrl: API_ORIGIN,
        accessToken: "post-init-private-access",
        refreshToken: "post-init-private-refresh",
        user: {
          id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          email: "chef@example.com",
          name: "Chef",
        },
      }));
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulDeviceFetch(),
      });
      expect(await account.initialize()).toMatchObject({ state: "signed_in" });

      access = mode;
      const failed = await account.signOut();
      expect(failed).toMatchObject({
        state: "error",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      });
      expect(await account.retryCredentialRecovery(failed.revision - 1))
        .toMatchObject({ ok: false, kind: "revision_conflict" });
      const retried = await account.retryCredentialRecovery(failed.revision);
      expect(retried.ok).toBeTrue();
      if (!retried.ok) throw new Error("credential reinspection was rejected");

      if (mode === "transient") {
        expect(retried.snapshot).toMatchObject({
          state: "error",
          error: { code: "CREDENTIAL_RECOVERY_REQUIRED" },
        });
        const repeated = await account.retryCredentialRecovery(
          retried.snapshot.revision,
        );
        expect(repeated).toMatchObject({
          ok: true,
          snapshot: {
            state: "error",
            error: { code: "CREDENTIAL_RECOVERY_REQUIRED" },
          },
        });
        expect(metadata.quarantined).toHaveLength(0);
        access = "healthy";
        if (!repeated.ok) throw new Error("repeated reinspection was rejected");
        // Authority inspection failed before sign-out could durably clear any
        // credential. Recovery therefore restores the untouched principal;
        // the user can issue a fresh, fully-authorized sign-out.
        expect(await account.retryCredentialRecovery(
          repeated.snapshot.revision,
        )).toMatchObject({ ok: true, snapshot: { state: "signed_in" } });
      } else {
        expect(retried.snapshot).toMatchObject({ state: "recovery_required" });
        const recovered = await account.confirmLegacyCredentialReconnect(
          retried.snapshot.revision,
        );
        expect(recovered).toMatchObject({
          ok: true,
          snapshot: { state: "signed_out" },
        });
        expect(metadata.quarantined.map(({ reason }) => reason)).toEqual([
          "legacy_identity_access_denied",
        ]);
      }
      expect(deleteAttempts).toBe(mode === "transient" ? 0 : 1);
    }
  });

  test("failed sign-out preserves later missing or invalid deleting roles across restart", async () => {
    for (const anomaly of ["missing", "invalid"] as const) {
      const metadata = new MemoryMetadata();
      const backing = memorySecrets();
      let access: "healthy" | typeof anomaly = "healthy";
      let deleteAttempts = 0;
      const secrets: SecretStore = {
        get: async (input) => {
          if (access === "missing") return null;
          if (access === "invalid") return "{invalid-envelope";
          return await backing.get(input);
        },
        set: async (input) => await backing.set(input),
        delete: () => {
          deleteAttempts += 1;
          return Promise.reject(new Error("indeterminate Keychain delete"));
        },
      };
      const credentials = new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => "deleting_anomaly_01",
      });
      await credentials.write(humanAuthenticationSchema.parse({
        version: 1,
        apiUrl: API_ORIGIN,
        accessToken: "deleting-anomaly-private-access",
        refreshToken: "deleting-anomaly-private-refresh",
        user: {
          id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          email: "chef@example.com",
          name: "Chef",
        },
      }));
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulDeviceFetch(),
      });
      expect(await account.initialize()).toMatchObject({ state: "signed_in" });
      const failed = await account.signOut();
      expect(failed).toMatchObject({
        state: "error",
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(metadata.journal?.committed).toBeUndefined();
      expect(metadata.journal?.deleting).toHaveLength(1);

      access = anomaly;
      const retried = await account.retryCredentialRecovery(failed.revision);
      expect(retried).toMatchObject({
        ok: true,
        snapshot: { state: "recovery_required" },
      });
      if (!retried.ok) throw new Error("deleting role reinspection failed");
      expect(await account.confirmLegacyCredentialReconnect(
        retried.snapshot.revision,
      )).toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
      expect(deleteAttempts).toBe(1);
      expect(metadata.quarantined.map(({ reason }) => reason)).toEqual([
        anomaly === "missing"
          ? "missing_pointer_abandoned"
          : "invalid_pointer_preserved",
      ]);

      const restarted = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials: new HumanCredentialCustody({
          metadata,
          secrets,
          nextSlot: () => "restart_anomaly_001",
        }),
        fetch: successfulDeviceFetch(),
      });
      expect(await restarted.initialize()).toMatchObject({ state: "signed_out" });
      expect(deleteAttempts).toBe(1);
    }
  });

  test("explicit legacy reconnect preserves inaccessible slots and a fresh sign-in survives restart", async () => {
    const metadata = new MemoryMetadata();
    metadata.journal = {
      version: 1,
      revision: 4,
      latestGeneration: 1,
      service: "kitchen.hraness.cloud-human.v1",
      name: "primary",
      committed: { generation: 1, slot: "legacy_human_committed" },
      deleting: [{ generation: 0, slot: "legacy_human_deleting0" }],
    };
    const backing = memorySecrets();
    const legacyNames = new Set([
      "primary:slot:legacy_human_committed",
      "primary:slot:legacy_human_deleting0",
    ]);
    for (const [name, generation] of [
      ["primary:slot:legacy_human_committed", 1],
      ["primary:slot:legacy_human_deleting0", 0],
    ] as const) {
      backing.values.set(
        `kitchen.hraness.cloud-human.v1:${name}`,
        JSON.stringify({
          version: 1,
          generation,
          value: "opaque legacy credential that remains in Keychain",
        }),
      );
    }
    let legacyDeleteAttempts = 0;
    const transitionSecrets: SecretStore = {
      get: async (input) => legacyNames.has(input.name)
        ? await Promise.reject(new SecretStoreAccessDeniedError())
        : await backing.get(input),
      set: async (input) => await backing.set(input),
      delete: async (input) => {
        if (legacyNames.has(input.name)) {
          legacyDeleteAttempts += 1;
          throw new Error("legacy code requirement denied");
        }
        return await backing.delete(input);
      },
    };
    const slotCandidates = [
      "legacy_human_committed",
      "fresh_human_credential2",
    ];
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: transitionSecrets,
      nextSlot: () => slotCandidates.shift() ?? "unused_human_credential",
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulDeviceFetch(),
      sleep: () => Promise.resolve(),
    });

    expect(await account.initialize()).toEqual({
      state: "recovery_required",
      reason: "credential_reconnect_required",
      revision: 1,
    });
    expect(account.startSignIn()).toBe(account.snapshot());
    expect(await account.confirmLegacyCredentialReconnect(0)).toEqual({
      ok: false,
      kind: "revision_conflict",
      currentRevision: 1,
    });
    expect(await account.confirmLegacyCredentialReconnect(1)).toMatchObject({
      ok: true,
      snapshot: { state: "signed_out", revision: 2 },
    });
    expect(metadata.journal).toMatchObject({
      revision: 5,
      latestGeneration: 1,
    });
    expect(metadata.journal?.committed).toBeUndefined();
    expect(metadata.journal?.deleting).toBeUndefined();
    expect(metadata.quarantined).toHaveLength(2);
    expect(legacyDeleteAttempts).toBe(0);
    expect([...backing.values.keys()].filter((name) =>
      name.includes("legacy_human_")
    )).toHaveLength(2);

    expect(account.startSignIn()).toMatchObject({ state: "signing_in" });
    expect(await account.signInCompletion()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 2,
      profile: { user: { email: "chef@example.com" } },
    });
    expect(metadata.journal?.committed).toEqual({
      generation: 2,
      slot: "fresh_human_credential2",
    });
    expect(legacyDeleteAttempts).toBe(0);

    const restarted = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials: new HumanCredentialCustody({
        metadata,
        secrets: transitionSecrets,
        nextSlot: () => "restart_human_credential",
      }),
      fetch: successfulDeviceFetch(),
    });
    expect(await restarted.initialize()).toMatchObject({
      state: "signed_in",
      credentialGeneration: 2,
    });
    expect(legacyDeleteAttempts).toBe(0);
  });

  test("legacy reconnect cannot project a retained credential that fails schedule authority", async () => {
    const metadata = new MemoryMetadata();
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: memorySecrets(),
      nextSlot: () => "retained_foreign_identity",
    });
    await credentials.write(humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: API_ORIGIN,
      accessToken: "foreign-retained-access-token",
      refreshToken: "foreign-retained-refresh-token",
      user: {
        id: "user_foreignretainedidentity",
        email: "foreign@example.com",
        name: "Foreign",
      },
    }));
    Object.defineProperty(credentials, "inspectLegacyIdentityReconnect", {
      configurable: true,
      value: () => Promise.resolve({ state: "required" }),
    });
    Object.defineProperty(credentials, "quarantineLegacyIdentityPointers", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    let authenticationCommits = 0;
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      acceptAuthentication: () => {
        throw new Error("scheduled-chat authority mismatch");
      },
      withAuthenticationCommit: async (_authentication, commit) => {
        authenticationCommits += 1;
        return await commit();
      },
    });
    const recovery = await account.initialize();
    expect(recovery).toMatchObject({ state: "recovery_required" });
    const result = await account.confirmLegacyCredentialReconnect(
      recovery.revision,
    );
    expect(result).toMatchObject({ ok: false, kind: "failed" });
    expect(account.snapshot()).toBe(recovery);
    expect(authenticationCommits).toBe(0);
  });

  for (const rejectedPending of [
    "foreign_principal",
    "foreign_origin",
    "malformed_payload",
  ] as const) {
    test(`reconnect quarantines an exact ${rejectedPending} pending credential before restoring the committed authority`, async () => {
      const metadata = new MemoryMetadata();
      const secrets = memorySecrets();
      const committedSlot = `committed_${rejectedPending}`;
      const pendingSlot = `pending_${rejectedPending}`;
      const committedAuthentication = humanAuthenticationSchema.parse({
        version: 1,
        apiUrl: API_ORIGIN,
        accessToken: "committed-authority-access-token",
        refreshToken: "committed-authority-refresh-token",
        user: {
          id: "user_committedscheduleauthority",
          email: "committed@example.com",
          name: "Committed",
        },
      });
      const pendingValue = rejectedPending === "malformed_payload"
        ? "not a human authentication payload"
        : JSON.stringify(humanAuthenticationSchema.parse({
          version: 1,
          apiUrl: rejectedPending === "foreign_origin"
            ? "https://other-hra.example.com"
            : API_ORIGIN,
          accessToken: "rejected-pending-access-token",
          refreshToken: "rejected-pending-refresh-token",
          user: {
            id: rejectedPending === "foreign_principal"
              ? "user_foreignpendingauthority"
              : committedAuthentication.user.id,
            email: rejectedPending === "foreign_principal"
              ? "foreign@example.com"
              : committedAuthentication.user.email,
            name: rejectedPending === "foreign_principal"
              ? "Foreign"
              : committedAuthentication.user.name,
          },
        }));
      metadata.journal = {
        version: 1,
        revision: 8,
        latestGeneration: 1,
        service: "kitchen.hraness.cloud-human.v1",
        name: "primary",
        committed: { generation: 0, slot: committedSlot },
        pending: {
          pointer: { generation: 1, slot: pendingSlot },
          replacesGeneration: 0,
        },
      };
      secrets.values.set(
        `kitchen.hraness.cloud-human.v1:primary:slot:${committedSlot}`,
        JSON.stringify({
          version: 1,
          generation: 0,
          value: JSON.stringify(committedAuthentication),
        }),
      );
      secrets.values.set(
        `kitchen.hraness.cloud-human.v1:primary:slot:${pendingSlot}`,
        JSON.stringify({ version: 1, generation: 1, value: pendingValue }),
      );
      const credentials = new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => "unused_reconnect_slot",
      });
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        acceptAuthentication: (authentication) => {
          if (authentication.user.id !== committedAuthentication.user.id) {
            throw new Error("scheduled-chat authority mismatch");
          }
        },
        withAuthenticationCommit: async (_authentication, commit) =>
          await commit(),
      });

      const recovery = await account.initialize();
      expect(recovery).toMatchObject({ state: "recovery_required" });
      expect(metadata.journal).toMatchObject({
        revision: 8,
        committed: { generation: 0, slot: committedSlot },
        pending: { pointer: { generation: 1, slot: pendingSlot } },
      });

      const result = await account.confirmLegacyCredentialReconnect(
        recovery.revision,
      );
      expect(result).toMatchObject({
        ok: true,
        snapshot: {
          state: "signed_in",
          credentialGeneration: 0,
          profile: { user: { id: committedAuthentication.user.id } },
        },
      });
      expect(metadata.journal?.committed).toEqual({
        generation: 0,
        slot: committedSlot,
      });
      expect(metadata.journal?.pending).toBeUndefined();
      expect(metadata.quarantined).toHaveLength(1);
      expect(metadata.quarantined[0]).toMatchObject({
        kind: "pending",
        pointer: { generation: 1, slot: pendingSlot },
        sourceRevision: 8,
      });
      expect(secrets.values.has(
        `kitchen.hraness.cloud-human.v1:primary:slot:${pendingSlot}`,
      )).toBeTrue();
    });
  }

  test("recovery-required sign-out cannot delete a bound pending credential", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    const committedSlot = "committed_foreign_signout";
    const pendingSlot = "pending_bound_signout";
    const foreign = humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: API_ORIGIN,
      accessToken: "foreign-committed-access-token",
      refreshToken: "foreign-committed-refresh-token",
      user: {
        id: "user_foreigncommittedsignout",
        email: "foreign@example.com",
        name: "Foreign",
      },
    });
    const bound = humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: API_ORIGIN,
      accessToken: "bound-pending-access-token",
      refreshToken: "bound-pending-refresh-token",
      user: {
        id: "user_boundscheduleauthority",
        email: "bound@example.com",
        name: "Bound",
      },
      workosOrganizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      organization: {
        id: "organization_boundscheduleauthority",
        name: "Bound organization",
        role: "admin",
        status: "active",
        workosOrganizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
    metadata.journal = {
      version: 1,
      revision: 12,
      latestGeneration: 1,
      service: "kitchen.hraness.cloud-human.v1",
      name: "primary",
      committed: { generation: 0, slot: committedSlot },
      pending: {
        pointer: { generation: 1, slot: pendingSlot },
        replacesGeneration: 0,
      },
    };
    secrets.values.set(
      `kitchen.hraness.cloud-human.v1:primary:slot:${committedSlot}`,
      JSON.stringify({
        version: 1,
        generation: 0,
        value: JSON.stringify(foreign),
      }),
    );
    secrets.values.set(
      `kitchen.hraness.cloud-human.v1:primary:slot:${pendingSlot}`,
      JSON.stringify({
        version: 1,
        generation: 1,
        value: JSON.stringify(bound),
      }),
    );
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "unused_signout_slot",
    });
    const inspectedAuthorities: HumanCredentialClearAuthority[] = [];
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      acceptAuthentication: () => {
        throw new Error("scheduled-chat recovery authority is not settled");
      },
      withSignOutCommit: async (authority, commit) => {
        inspectedAuthorities.push(authority);
        if (authority.identities.some(({ userId }) =>
          userId === bound.user.id
        )) {
          throw new Error("Turn off scheduled chats before clearing their cloud credential.");
        }
        return await commit();
      },
    });
    expect(await account.initialize()).toMatchObject({
      state: "recovery_required",
    });
    const journalBefore = structuredClone(metadata.journal);

    expect(account.signOut()).rejects.toThrow("Turn off scheduled chats");
    const inspectedAuthority = inspectedAuthorities[0];
    if (inspectedAuthority === undefined) {
      throw new Error("credential clear authority was not inspected");
    }
    expect(inspectedAuthority.sourceRevision).toBe(12);
    expect(inspectedAuthority.hasUnrecognizedValue).toBeFalse();
    expect(inspectedAuthority.identities.some((identity) =>
      identity.apiUrl === foreign.apiUrl
      && identity.userId === foreign.user.id
    )).toBeTrue();
    expect(inspectedAuthority.identities.some((identity) =>
      identity.apiUrl === bound.apiUrl
      && identity.userId === bound.user.id
      && identity.organizationId === bound.organization?.id
    )).toBeTrue();
    expect(metadata.journal).toEqual(journalBefore);
    expect(secrets.values.has(
      `kitchen.hraness.cloud-human.v1:primary:slot:${pendingSlot}`,
    )).toBeTrue();
  });

  test("a foreign-origin committed credential remains exactly clearable", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "foreign_origin_clear_slot",
    });
    const foreignOrigin = humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: "https://foreign-hra.example.com",
      accessToken: "foreign-origin-access-token",
      refreshToken: "foreign-origin-refresh-token",
      user: {
        id: "user_sameidentitydifferentorigin",
        email: "same@example.com",
        name: "Same identity",
      },
    });
    await credentials.write(foreignOrigin);
    let clearAuthority: Parameters<
      NonNullable<ConstructorParameters<typeof HumanAccountService>[0]["withSignOutCommit"]>
    >[0] | null = null;
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      withSignOutCommit: async (authority, commit) => {
        clearAuthority = authority;
        return await commit();
      },
    });

    expect(await account.initialize()).toMatchObject({
      state: "error",
      error: { code: "CONFIGURATION_UNAVAILABLE", retryable: false },
    });
    expect(await account.signOut()).toMatchObject({ state: "signed_out" });
    expect(clearAuthority).toMatchObject({
      identities: [{
        apiUrl: foreignOrigin.apiUrl,
        userId: foreignOrigin.user.id,
      }],
      hasUnrecognizedValue: false,
    });
    expect(metadata.journal?.committed).toBeUndefined();
  });

  test("a configured-cloud sign-in replaces a foreign-origin credential with the same user identity", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    const slots = ["foreign_origin_existing_slot", "configured_origin_replacement_slot"];
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => slots.shift() ?? "unused_replacement_slot",
    });
    const userId = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await credentials.write(humanAuthenticationSchema.parse({
      version: 1,
      apiUrl: "https://foreign-hra.example.com",
      accessToken: "foreign-origin-access-token",
      refreshToken: "foreign-origin-refresh-token",
      user: {
        id: userId,
        email: "chef@example.com",
        name: "Chef",
      },
    }));
    const acceptedOrigins: string[] = [];
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulDeviceFetch(),
      sleep: () => Promise.resolve(),
      withAuthenticationCommit: async (authentication, commit) => {
        expect(authentication.user.id).toBe(userId);
        acceptedOrigins.push(authentication.apiUrl);
        return await commit();
      },
    });

    expect(await account.initialize()).toMatchObject({
      state: "error",
      error: { code: "CONFIGURATION_UNAVAILABLE", retryable: false },
    });
    expect(account.startSignIn()).toMatchObject({ state: "signing_in" });
    expect(await account.signInCompletion()).toMatchObject({
      state: "signed_in",
      profile: { user: { id: userId } },
    });
    expect(acceptedOrigins).toEqual([API_ORIGIN]);
    expect(await credentials.read()).toMatchObject({
      generation: 1,
      authentication: {
        apiUrl: API_ORIGIN,
        user: { id: userId },
      },
    });
  });
});
