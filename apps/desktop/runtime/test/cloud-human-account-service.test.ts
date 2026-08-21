import { describe, expect, test } from "bun:test";
import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  humanAuthenticationSchema,
  humanAuthenticationSnapshotSchema,
  SecretStoreAccessDeniedError,
  type FetchLike,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyQuarantinePointer,
  type SecretStore,
} from "@hraness/hra-human-client";
import type {
  OrganizationView,
  WorkspaceView,
} from "@hraness/agent-tasks-protocol";

import {
  HumanAccountService,
  HumanCredentialCustody,
  HRA_CLOUD_API_URL_ENV,
  HRA_CLOUD_WEB_URL_ENV,
  HRA_HUMAN_KEYCHAIN_NAME,
  createHumanAccountRuntime,
  parseHRACloudConfiguration,
  type HumanAccountMetadata,
  type HumanAccountMetadataPort,
  type HumanAccountSnapshot,
  type HumanCredentialClearAuthority,
  type LegacyHumanAccountMetadataReference,
} from "../src/cloud";
import { isolateRawDevelopmentSecrets } from
  "../src/development-isolation";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const REQUEST_ID = `req_${LOCATOR}`;
const IDEMPOTENCY_KEY = "018f22c0-6b3c-7a91-8abc-123456789abc"; // gitleaks:allow - deterministic test vector
const API_ORIGIN = "https://hra.example.com";
const WEB_ORIGIN = "https://app.hra.example.com";
const USER_ID = `usr_${LOCATOR}`;
const FOREIGN_USER_ID = "usr_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const COMMITTED_USER_ID = "usr_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PENDING_USER_ID = "usr_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const PAIRING_ID = `pair_${LOCATOR}`;
const ORGANIZATION = {
  id: "org_oprte",
  name: "OPRTE",
  role: "admin",
  status: "active",
} as const;
const WORKSPACE = {
  id: "workspace_oprte",
  organizationId: ORGANIZATION.id,
  slug: "oprte",
  name: "OPRTE",
  taskKeyPrefix: "OPR",
  roles: ["planner", "reviewer", "viewer"],
} as const;

class MemoryMetadata implements HumanAccountMetadataPort {
  journal: SecretCustodyJournal | null = null;
  account: HumanAccountMetadata | null = null;
  legacyAccount: LegacyHumanAccountMetadataReference | null = null;
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
    return Promise.resolve(this.legacyAccount ?? this.account);
  }

  compareAndSwapAccountMetadata(input: {
    readonly expectedRevision: number | null;
    readonly next: HumanAccountMetadata;
  }): Promise<boolean> {
    const currentRevision = this.legacyAccount?.revision ??
      this.account?.revision ??
      null;
    if (currentRevision !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.legacyAccount = null;
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
    [HRA_CLOUD_WEB_URL_ENV]: WEB_ORIGIN,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pairedAuthentication(
  accessToken = "recovered-access-token-that-stays-private",
  refreshToken = "recovered-refresh-token-that-stays-private",
) {
  return {
    accessToken,
    refreshToken,
    user: {
      id: USER_ID,
      email: "chef@example.com",
      name: "Chef",
    },
    organization: ORGANIZATION,
    workspace: WORKSPACE,
  };
}

function storedAuthentication(input: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly apiUrl?: string;
  readonly userId?: string;
  readonly organization?: OrganizationView;
  readonly workspace?: WorkspaceView | null;
}) {
  return humanAuthenticationSchema.parse({
    version: 2,
    apiUrl: input.apiUrl ?? API_ORIGIN,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    user: {
      id: input.userId ?? USER_ID,
      email: "chef@example.com",
      name: "Chef",
    },
    organization: input.organization ?? ORGANIZATION,
    ...(input.workspace === undefined || input.workspace === null
      ? {}
      : { workspace: input.workspace }),
  });
}

function successfulPairingFetch(): FetchLike {
  return (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/auth/desktop-pairings") {
      return Promise.resolve(json({
        ok: true,
        data: {
          pairingId: PAIRING_ID,
          verificationUri: `${WEB_ORIGIN}/pair/desktop/${PAIRING_ID}`,
          comparisonCode: "ABCD-EFGH",
          expiresAt: Date.now() + 600_000,
          pollIntervalMs: 1_000,
        },
        requestId: REQUEST_ID,
      }));
    }
    if (url.pathname === `/v1/auth/desktop-pairings/${PAIRING_ID}/redeem`) {
      return Promise.resolve(json({
        ok: true,
        data: {
          status: "approved",
          authentication: pairedAuthentication(),
        },
        requestId: REQUEST_ID,
      }));
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  };
}

describe("optional desktop Convex account service", () => {
  test("raw development stays configuration-unavailable without production custody or network effects", async () => {
    const metadata = new MemoryMetadata();
    const productionSecrets = memorySecrets();
    const productionCredentialKey = secretKey({
      service: HRA_HUMAN_KEYCHAIN_SERVICE,
      name: HRA_HUMAN_KEYCHAIN_NAME,
    });
    productionSecrets.values.set(
      productionCredentialKey,
      "signed-production-credential-must-not-be-read",
    );
    let reads = 0;
    let writes = 0;
    let deletes = 0;
    const isolatedSecrets = isolateRawDevelopmentSecrets({
      get: async (input) => {
        reads += 1;
        return await productionSecrets.get(input);
      },
      set: async (input) => {
        writes += 1;
        await productionSecrets.set(input);
      },
      delete: async (input) => {
        deletes += 1;
        return await productionSecrets.delete(input);
      },
    });
    let networkRequests = 0;
    const account = new HumanAccountService({
      configuration: parseHRACloudConfiguration({}),
      metadata,
      credentials: new HumanCredentialCustody({
        metadata,
        secrets: isolatedSecrets,
        nextSlot: () => "raw_development_human_01",
      }),
      fetch: () => {
        networkRequests += 1;
        return Promise.reject(new Error("raw development must stay offline"));
      },
    });

    expect(await account.initialize()).toMatchObject({ state: "signed_out" });
    expect(account.startSignIn()).toMatchObject({
      state: "error",
      error: { code: "CONFIGURATION_UNAVAILABLE" },
    });
    expect(networkRequests).toBe(0);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(deletes).toBe(0);
    expect(metadata.journal).toBeNull();
    expect(productionSecrets.values).toEqual(new Map([[
      productionCredentialKey,
      "signed-production-credential-must-not-be-read",
    ]]));
  });

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
      fetch: successfulPairingFetch(),
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

  test("pairs through the browser and preserves token-free Convex selections", async () => {
    const firstAccess = "first-access-token-that-must-stay-private";
    const firstRefresh = "first-refresh-token-that-must-stay-private";
    const organizationAccess = "organization-access-token-that-must-stay-private";
    const organizationRefresh = "organization-refresh-token-that-must-stay-private";
    const workspaceAccess = "workspace-access-token-that-must-stay-private";
    const workspaceRefresh = "workspace-refresh-token-that-must-stay-private";
    const refreshedAccess = "refreshed-access-token-that-must-stay-private";
    const refreshedRefresh = "refreshed-refresh-token-that-must-stay-private";
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
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/v1/auth/desktop-pairings") {
          return Promise.resolve(json({
            ok: true,
            data: {
              pairingId: PAIRING_ID,
              verificationUri: `${WEB_ORIGIN}/pair/desktop/${PAIRING_ID}`,
              comparisonCode: "ABCD-EFGH",
              expiresAt: 601_000,
              pollIntervalMs: 1_000,
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === `/v1/auth/desktop-pairings/${PAIRING_ID}/redeem`) {
          return Promise.resolve(json({
            ok: true,
            data: {
              status: "approved",
              authentication: pairedAuthentication(firstAccess, firstRefresh),
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/organizations" && request.method === "GET") {
          return Promise.resolve(json({
            ok: true,
            data: {
              organizations: [ORGANIZATION],
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
                status: "active",
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
          expect(authorization).toBe(`Bearer ${workspaceRefresh}`);
          return Promise.resolve(json({
            ok: true,
            data: pairedAuthentication(refreshedAccess, refreshedRefresh),
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/auth/selection") {
          const body = JSON.parse(String(await request.text())) as {
            organizationId: string;
            workspaceId?: string;
          };
          expect(body.organizationId).toBe(ORGANIZATION.id);
          return Promise.resolve(json({
            ok: true,
            data: body.workspaceId === undefined
              ? {
                  accessToken: organizationAccess,
                  refreshToken: organizationRefresh,
                  user: pairedAuthentication().user,
                  organization: ORGANIZATION,
                }
              : pairedAuthentication(workspaceAccess, workspaceRefresh),
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/hra/workspaces") {
          const authorization = request.headers.get("authorization");
          if (authorization === `Bearer ${workspaceAccess}`) {
            return Promise.resolve(json({
              error: {
                code: "AUTHENTICATION_FAILED",
                message: "Authentication failed.",
                requestId: REQUEST_ID,
                details: {},
              },
            }, 401));
          }
          expect(authorization).toBe(`Bearer ${refreshedAccess}`);
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
            .toBe(`Bearer ${organizationAccess}`);
          return Promise.resolve(json({
            ok: true,
            data: {
              workspaces: [WORKSPACE],
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
    expect(authenticationAuthorityCount).toBe(2);
    expect(metadata.account).toMatchObject({ credentialGeneration: 3 });

    const emittedSource = JSON.stringify(emitted);
    const sqliteSource = JSON.stringify({
      account: metadata.account,
      journal: metadata.journal,
    });
    for (const secret of [
      firstAccess,
      firstRefresh,
      organizationAccess,
      organizationRefresh,
      workspaceAccess,
      workspaceRefresh,
      refreshedAccess,
      refreshedRefresh,
    ]) {
      expect(emittedSource).not.toContain(secret);
      expect(sqliteSource).not.toContain(secret);
    }
    expect(emittedSource).toContain("ABCD-EFGH");
    expect(emittedSource).toContain(`${WEB_ORIGIN}/pair/desktop/${PAIRING_ID}`);
    expect(requests.filter(({ url }) => url.startsWith(API_ORIGIN)).length)
      .toBe(10);
  });

  test("cancels pairing polling and fences stale completion before Keychain write", async () => {
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
        if (url.pathname === "/v1/auth/desktop-pairings") {
          return Promise.resolve(json({
            ok: true,
            data: {
              pairingId: PAIRING_ID,
              verificationUri: `${WEB_ORIGIN}/pair/desktop/${PAIRING_ID}`,
              comparisonCode: "CANC-EKME",
              expiresAt: 601_000,
              pollIntervalMs: 1_000,
            },
            requestId: REQUEST_ID,
          }));
        }
        polls += 1;
        return Promise.resolve(json({
          ok: true,
          data: { status: "pending", retryAfterMs: 1_000 },
          requestId: REQUEST_ID,
        }));
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
      fetch: successfulPairingFetch(),
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
    expect(backing.values.size).toBe(1);
    expect(metadata.quarantined.map(({ kind, reason }) => ({ kind, reason })))
      .toEqual([{
        kind: "committed",
        reason: "invalid_pointer_preserved",
      }]);
    expect(await account.signOut().then(
      () => null,
      (error: unknown) => error,
    )).toBeInstanceOf(Error);
  });

  test("cancel after a pairing write fails closed across preservation faults and restart", async () => {
    for (const mode of ["false", "throw"] as const) {
      const metadata = new MemoryMetadata();
      const backing = memorySecrets();
      let deleteAttempts = 0;
      const secrets: SecretStore = {
        get: async (input) => await backing.get(input),
        set: async (input) => await backing.set(input),
        delete: async (input) => {
          deleteAttempts += 1;
          return await backing.delete(input);
        },
      };
      const credentials = new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => `cancel_fault_${mode}`,
      });
      const originalWrite = credentials.write.bind(credentials);
      let markWriteCommitted = (): void => undefined;
      const writeCommitted = new Promise<void>((resolve) => {
        markWriteCommitted = resolve;
      });
      let releaseWrite = (): void => undefined;
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      Object.defineProperty(credentials, "write", {
        configurable: true,
        value: async (authentication: Parameters<HumanCredentialCustody["write"]>[0]) => {
          const snapshot = await originalWrite(authentication);
          markWriteCommitted();
          await writeReleased;
          return snapshot;
        },
      });
      Object.defineProperty(credentials, "preserveForRecovery", {
        configurable: true,
        value: mode === "false"
          ? () => Promise.resolve(false)
          : () => Promise.reject(new Error("injected containment failure")),
      });
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulPairingFetch(),
        sleep: () => Promise.resolve(),
        now: () => 1_000,
      });

      expect(await account.initialize()).toMatchObject({ state: "signed_out" });
      account.startSignIn();
      await writeCommitted;
      const cancellation = account.cancelSignIn();
      releaseWrite();
      const failed = await cancellation;
      expect(failed).toMatchObject({ state: "recovery_required" });
      expect(metadata.account?.credentialRecoveryPending).toBeTrue();
      expect(await credentials.read()).not.toBeNull();
      expect(account.startSignIn()).toEqual(failed);
      expect(deleteAttempts).toBe(0);

      const restartedCredentials = new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => `cancel_restart_${mode}`,
      });
      const restarted = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials: restartedCredentials,
        fetch: successfulPairingFetch(),
      });
      const recovery = await restarted.initialize();
      expect(recovery).toMatchObject({ state: "recovery_required" });
      expect(await restarted.confirmLegacyCredentialReconnect(recovery.revision))
        .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
      expect(await restartedCredentials.read()).toBeNull();
      expect(metadata.account?.credentialRecoveryPending).toBeUndefined();
      expect(metadata.quarantined.map(({ kind, reason }) => ({ kind, reason })))
        .toEqual([{
          kind: "committed",
          reason: "invalid_pointer_preserved",
        }]);
      expect(backing.values.size).toBe(1);
      expect(deleteAttempts).toBe(0);
    }
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
      fetch: successfulPairingFetch(),
      sleep: () => Promise.resolve(),
      now: () => 1_000,
    });

    expect(await crashed.initialize()).toMatchObject({ state: "signed_out" });
    expect(crashed.startSignIn()).toMatchObject({ state: "signing_in" });
    expect(await crashed.signInCompletion()).toMatchObject({
      state: "recovery_required",
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
      fetch: successfulPairingFetch(),
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
      fetch: successfulPairingFetch(),
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

  test("a version-1 credential is preserved for explicit recovery and never adopted", async () => {
    const metadata = new MemoryMetadata();
    metadata.legacyAccount = {
      state: "legacy_profile",
      revision: 0,
      credentialGeneration: 0,
    };
    const secrets = memorySecrets();
    const slot = "version_one_credential";
    metadata.journal = {
      version: 1,
      revision: 0,
      latestGeneration: 0,
      service: "kitchen.hraness.cloud-human.v1",
      name: "primary",
      committed: { generation: 0, slot },
    };
    const secretKey = `kitchen.hraness.cloud-human.v1:primary:slot:${slot}`;
    secrets.values.set(secretKey, JSON.stringify({
      version: 1,
      generation: 0,
      value: JSON.stringify({
        version: 1,
        apiUrl: API_ORIGIN,
        accessToken: "legacy-access-token-preserved-as-evidence",
        refreshToken: "legacy-refresh-token-preserved-as-evidence",
        user: { id: "legacy-user", email: "legacy@example.com" },
      }),
    }));
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials: new HumanCredentialCustody({
        metadata,
        secrets,
        nextSlot: () => "unused_version_two_slot",
      }),
    });

    const recovery = await account.initialize();
    expect(recovery).toMatchObject({ state: "recovery_required" });
    expect(secrets.values.has(secretKey)).toBeTrue();
    expect(metadata.quarantined).toHaveLength(0);

    expect(await account.confirmLegacyCredentialReconnect(recovery.revision))
      .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
    expect(metadata.quarantined).toHaveLength(1);
    expect(metadata.quarantined[0]).toMatchObject({
      kind: "committed",
      pointer: { generation: 0, slot },
      reason: "invalid_pointer_preserved",
    });
    expect(secrets.values.has(secretKey)).toBeTrue();
    expect(metadata.legacyAccount).toBeNull();
    expect(metadata.account).toMatchObject({
      revision: 1,
      credentialGeneration: 0,
      profile: null,
    });
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
    const originalAuthentication = storedAuthentication({
      accessToken: "service-gap-original-access-token",
      refreshToken: "service-gap-original-refresh-token",
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
      sleep: () => Promise.resolve(),
      now: () => 1_000,
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
              organizations: [ORGANIZATION],
              cursor: null,
            },
            requestId: REQUEST_ID,
          }));
        }
        if (url.pathname === "/v1/auth/selection") {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${originalAuthentication.accessToken}`,
          );
          return Promise.resolve(json({
            ok: true,
            data: {
              accessToken: "service-gap-selected-access-token",
              refreshToken: "service-gap-selected-refresh-token",
              user: originalAuthentication.user,
              organization: ORGANIZATION,
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

  test("selection binds refreshed replay authority and excludes a concurrent refresh before committing C", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let slot = 0;
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => `selection_refresh_${++slot}`,
    });
    const authorityA = await credentials.write(storedAuthentication({
      accessToken: "selection-authority-a-access-token",
      refreshToken: "selection-authority-a-refresh-token",
    }));
    const accessB = "selection-authority-b-access-token";
    const refreshB = "selection-authority-b-refresh-token";
    const accessC = "selection-authority-c-access-token";
    const refreshC = "selection-authority-c-refresh-token";
    let selectionAttempts = 0;
    let organizationRequests = 0;
    let selectionReplayInFlight = false;
    let markReplayEntered = (): void => undefined;
    const replayEntered = new Promise<void>((resolve) => {
      markReplayEntered = resolve;
    });
    let releaseReplay = (): void => undefined;
    const replayReleased = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const authorization = request.headers.get("authorization");
        if (path === "/v1/organizations") {
          organizationRequests += 1;
          if (selectionReplayInFlight) {
            return json({
              error: {
                code: "AUTHENTICATION_FAILED",
                message: "Authentication failed.",
                requestId: REQUEST_ID,
                details: {},
              },
            }, 401);
          }
          expect(authorization).toBe(
            organizationRequests === 1
              ? `Bearer ${authorityA.authentication.accessToken}`
              : `Bearer ${accessC}`,
          );
          return json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          });
        }
        if (path === "/v1/auth/selection") {
          selectionAttempts += 1;
          if (selectionAttempts === 1) {
            expect(authorization).toBe(
              `Bearer ${authorityA.authentication.accessToken}`,
            );
            return json({
              error: {
                code: "AUTHENTICATION_FAILED",
                message: "Authentication failed.",
                requestId: REQUEST_ID,
                details: {},
              },
            }, 401);
          }
          expect(authorization).toBe(`Bearer ${accessB}`);
          selectionReplayInFlight = true;
          markReplayEntered();
          await replayReleased;
          selectionReplayInFlight = false;
          return json({
            ok: true,
            data: {
              accessToken: accessC,
              refreshToken: refreshC,
              user: authorityA.authentication.user,
              organization: ORGANIZATION,
            },
            requestId: REQUEST_ID,
          });
        }
        if (path === "/v1/auth/refresh") {
          expect(authorization).toBe(
            `Bearer ${authorityA.authentication.refreshToken}`,
          );
          return json({
            ok: true,
            data: {
              accessToken: accessB,
              refreshToken: refreshB,
              user: authorityA.authentication.user,
              organization: authorityA.authentication.organization,
              workspace: authorityA.authentication.workspace,
            },
            requestId: REQUEST_ID,
          });
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });

    const selection = account.selectOrganization(ORGANIZATION.id);
    await replayEntered;
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(organizationRequests).toBe(1);
    releaseReplay();
    expect(await selection).toMatchObject({
      ok: true,
      data: { organization: { id: ORGANIZATION.id } },
    });

    expect(await credentials.read()).toMatchObject({
      generation: authorityA.generation + 2,
      authentication: {
        accessToken: accessC,
        refreshToken: refreshC,
      },
    });
    expect(account.snapshot()).toMatchObject({
      state: "signed_in",
      credentialGeneration: authorityA.generation + 2,
    });
    expect(metadata.account?.credentialRecoveryPending).toBeUndefined();
    expect(metadata.quarantined).toHaveLength(0);
    expect(secrets.values.size).toBe(1);
    expect(await account.listOrganizations()).toMatchObject({ ok: true });
    expect(organizationRequests).toBe(2);
  });

  test("selection containment leaves an unrelated newer writer live but never adopts it", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let slot = 0;
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => `selection_external_${++slot}`,
    });
    const authority = await credentials.write(storedAuthentication({
      accessToken: "selection-external-a-access-token",
      refreshToken: "selection-external-a-refresh-token",
    }));
    const externalWinner = humanAuthenticationSnapshotSchema.parse({
      generation: authority.generation + 1,
      authentication: storedAuthentication({
        accessToken: "selection-external-e-access-token",
        refreshToken: "selection-external-e-refresh-token",
      }),
    });
    let selectionAttempts = 0;
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/organizations") {
          return json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          });
        }
        if (path === "/v1/auth/selection") {
          selectionAttempts += 1;
          expect(await credentials.compareAndSwap({
            expectedGeneration: authority.generation,
            next: externalWinner,
          })).toEqual(externalWinner);
          return json({
            ok: true,
            data: {
              accessToken: "selection-external-c-access-token",
              refreshToken: "selection-external-c-refresh-token",
              user: authority.authentication.user,
              organization: ORGANIZATION,
            },
            requestId: REQUEST_ID,
          });
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });

    expect(await account.selectOrganization(ORGANIZATION.id)).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(account.snapshot()).toMatchObject({ state: "recovery_required" });
    expect(await credentials.read()).toEqual(externalWinner);
    expect(metadata.account?.credentialRecoveryPending).toBeTrue();
    expect(metadata.quarantined).toHaveLength(0);
    expect(secrets.values.size).toBe(1);
    expect(selectionAttempts).toBe(1);
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  test("selection drains older bearer work and stays closed when its refresh is indeterminate", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    const slotValues = ["refresh_race_old_01", "refresh_race_new_02"];
    let slotIndex = 0;
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => slotValues[slotIndex++] ?? "refresh_race_unused",
    });
    const original = await credentials.write(storedAuthentication({
      accessToken: "refresh-race-original-access-token",
      refreshToken: "refresh-race-original-refresh-token",
    }));
    let selectionAttempts = 0;
    let markRefreshEntered = (): void => undefined;
    const refreshEntered = new Promise<void>((resolve) => {
      markRefreshEntered = resolve;
    });
    let rejectRefresh: (error: Error) => void = () => undefined;
    const stalledRefresh = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const authorization = request.headers.get("authorization");
        if (path === "/v1/workspaces") {
          expect(authorization).toBe(`Bearer ${original.authentication.accessToken}`);
          return Promise.resolve(json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, 401));
        }
        if (path === "/v1/auth/refresh") {
          markRefreshEntered();
          return stalledRefresh;
        }
        if (path === "/v1/organizations") {
          if (authorization === null) {
            throw new Error("organization authorization header was missing");
          }
          expect(authorization).toBe(
            `Bearer ${original.authentication.accessToken}`,
          );
          return Promise.resolve(json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          }));
        }
        if (path === "/v1/auth/selection") {
          selectionAttempts += 1;
          throw new Error("selection must not cross indeterminate refresh containment");
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });
    expect(await account.initialize()).toMatchObject({
      state: "signed_in",
      credentialGeneration: original.generation,
    });

    const staleRequest = account.listWorkspaces();
    await refreshEntered;
    const selection = account.selectOrganization(ORGANIZATION.id);
    expect(await Promise.race([
      selection.then(() => "settled" as const),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 5)),
    ])).toBe("blocked");
    expect(selectionAttempts).toBe(0);
    rejectRefresh(new Error("older refresh response was lost"));
    expect(await staleRequest).toMatchObject({
      ok: false,
      error: { code: "AUTH_REFRESH_INDETERMINATE" },
    });
    expect(await selection).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(account.snapshot()).toMatchObject({ state: "recovery_required" });
    expect(await credentials.read()).toBeNull();
    expect(metadata.quarantined).toHaveLength(1);
    expect(secrets.values.size).toBe(1);
    expect(selectionAttempts).toBe(0);
  });

  test("a definitive rejected selection clears its pre-dispatch recovery intent", async () => {
    const metadata = new MemoryMetadata();
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: memorySecrets(),
      nextSlot: () => "selection_rejected_01",
    });
    const original = await credentials.write(storedAuthentication({
      accessToken: "selection-rejected-access-token",
      refreshToken: "selection-rejected-refresh-token",
    }));
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/organizations") {
          return Promise.resolve(json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          }));
        }
        if (path === "/v1/auth/selection") {
          return Promise.resolve(json({
            error: {
              code: "VALIDATION_ERROR",
              message: "The request is invalid.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, 400));
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });
    expect(await account.selectOrganization(ORGANIZATION.id)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(account.snapshot()).toMatchObject({
      state: "signed_in",
      credentialGeneration: original.generation,
    });
    expect(metadata.account?.credentialRecoveryPending).toBeUndefined();
    expect(await credentials.read()).toEqual(original);
  });

  test("a lost selection response preserves and quarantines the exact live session", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "lostselectionslot1",
    });
    const original = await credentials.write(storedAuthentication({
      accessToken: "lost-selection-original-access-token",
      refreshToken: "lost-selection-original-refresh-token",
    }));
    let organizationReads = 0;
    let selectionAttempts = 0;
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/organizations") {
          organizationReads += 1;
          return Promise.resolve(json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          }));
        }
        if (path === "/v1/auth/selection") {
          selectionAttempts += 1;
          return Promise.reject(new Error("response lost after session rotation"));
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });

    expect(await account.initialize()).toMatchObject({ state: "signed_in" });
    expect(await account.selectOrganization(ORGANIZATION.id)).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(account.snapshot()).toMatchObject({ state: "signed_out" });
    expect(await credentials.read()).toBeNull();
    expect(metadata.account).toMatchObject({ profile: null });
    expect(metadata.quarantined).toHaveLength(1);
    expect(metadata.quarantined[0]).toMatchObject({
      kind: "committed",
      pointer: { generation: original.generation },
      reason: "invalid_pointer_preserved",
    });
    expect(secrets.values.size).toBe(1);
    expect(selectionAttempts).toBe(1);
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "SIGNED_OUT" },
    });
    expect(organizationReads).toBe(1);
  });

  test("a selection custody CAS failure quarantines committed and pending values without deletion", async () => {
    const metadata = new MemoryMetadata();
    const secrets = memorySecrets();
    let rejectSelectionWrite = false;
    const faultedSecrets: SecretStore = {
      get: async (input) => await secrets.get(input),
      set: async (input) => {
        if (rejectSelectionWrite) {
          rejectSelectionWrite = false;
          throw new Error("injected selection Keychain write failure");
        }
        await secrets.set(input);
      },
      delete: async (input) => await secrets.delete(input),
    };
    const slotValues = ["selectionoriginal1", "selectionpending02"];
    let slotIndex = 0;
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets: faultedSecrets,
      nextSlot: () => slotValues[slotIndex++] ?? "selectionunused03",
    });
    await credentials.write(storedAuthentication({
      accessToken: "selection-cas-original-access-token",
      refreshToken: "selection-cas-original-refresh-token",
    }));
    const selectedAccessToken = "selection-cas-rotated-access-token";
    const selectedRefreshToken = "selection-cas-rotated-refresh-token";
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/organizations") {
          return Promise.resolve(json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          }));
        }
        if (path === "/v1/auth/selection") {
          rejectSelectionWrite = true;
          return Promise.resolve(json({
            ok: true,
            data: {
              accessToken: selectedAccessToken,
              refreshToken: selectedRefreshToken,
              user: pairedAuthentication().user,
              organization: ORGANIZATION,
            },
            requestId: REQUEST_ID,
          }));
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });

    expect(await account.initialize()).toMatchObject({ state: "signed_in" });
    expect(await account.selectOrganization(ORGANIZATION.id)).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(account.snapshot()).toMatchObject({ state: "signed_out" });
    expect(await credentials.read()).toBeNull();
    expect(metadata.quarantined.map(({ kind, reason }) => ({ kind, reason })))
      .toEqual([
        { kind: "committed", reason: "invalid_pointer_preserved" },
        { kind: "pending", reason: "invalid_pointer_preserved" },
      ]);
    expect(secrets.values.size).toBe(1);
    expect(JSON.stringify([...secrets.values.values()]))
      .not.toContain(selectedAccessToken);
    expect(JSON.stringify([...secrets.values.values()]))
      .not.toContain(selectedRefreshToken);
  });

  test("an unconfirmed scope rotation stays recovery-required across restart", async () => {
    const metadata = new MemoryMetadata();
    const backing = memorySecrets();
    let deleteAttempts = 0;
    const secrets: SecretStore = {
      get: async (input) => await backing.get(input),
      set: async (input) => await backing.set(input),
      delete: async (input) => {
        deleteAttempts += 1;
        return await backing.delete(input);
      },
    };
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "scope_restart_fault_01",
    });
    await credentials.write(storedAuthentication({
      accessToken: "scope-restart-original-access-token",
      refreshToken: "scope-restart-original-refresh-token",
    }));
    const before = new Map(backing.values);
    Object.defineProperty(credentials, "preserveIndeterminateScopeSession", {
      configurable: true,
      value: () => Promise.reject(new Error("injected scope containment fault")),
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/organizations") {
          return Promise.resolve(json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          }));
        }
        if (path === "/v1/auth/selection") {
          return Promise.reject(new Error("selection response was lost"));
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });
    expect(await account.selectOrganization(ORGANIZATION.id)).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(account.snapshot()).toMatchObject({ state: "recovery_required" });
    expect(metadata.account?.credentialRecoveryPending).toBeTrue();
    expect(await credentials.read()).not.toBeNull();
    expect(backing.values).toEqual(before);
    expect(deleteAttempts).toBe(0);

    const restartedCredentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "scope_restart_fault_02",
    });
    const restarted = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials: restartedCredentials,
      fetch: successfulPairingFetch(),
    });
    const recovery = await restarted.initialize();
    expect(recovery).toMatchObject({ state: "recovery_required" });
    expect(await restarted.confirmLegacyCredentialReconnect(recovery.revision))
      .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
    expect(await restartedCredentials.read()).toBeNull();
    expect(metadata.account?.credentialRecoveryPending).toBeUndefined();
    expect(metadata.quarantined).toMatchObject([{
      kind: "committed",
      reason: "invalid_pointer_preserved",
    }]);
    expect(backing.values).toEqual(before);
    expect(deleteAttempts).toBe(0);
  });

  test("session cleanup projects signed out and resolves a retryable Keychain delete", async () => {
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
    await credentials.write(storedAuthentication({
      accessToken: "expired-session-access-token-that-stays-private",
      refreshToken: "expired-session-refresh-token-that-stays-private",
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
    expect(metadata.journal?.deleting).toBeUndefined();
    expect(secrets.values.size).toBe(0);

    expect(await account.signOut()).toMatchObject({ state: "signed_out" });
    expect(metadata.journal?.deleting).toBeUndefined();
    expect(secrets.values.size).toBe(0);
  });

  test("indeterminate refresh quarantines exact custody and projects recovery required", async () => {
    const metadata = new MemoryMetadata();
    const backing = memorySecrets();
    let deleteAttempts = 0;
    const secrets: SecretStore = {
      get: async (input) => await backing.get(input),
      set: async (input) => await backing.set(input),
      delete: async (input) => {
        deleteAttempts += 1;
        return await backing.delete(input);
      },
    };
    let refreshSlot = 0;
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => `refresh_indeterminate_0${++refreshSlot}`,
    });
    await credentials.write(storedAuthentication({
      accessToken: "indeterminate-session-access-token",
      refreshToken: "indeterminate-session-refresh-token",
    }));
    const before = new Map(backing.values);
    let requests = 0;
    let healthy = false;
    const pairingFetch = successfulPairingFetch();
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      sleep: () => Promise.resolve(),
      now: () => 1_000,
      fetch: (input, init) => {
        requests += 1;
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (!healthy && pathname === "/v1/organizations") {
          return Promise.resolve(json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, 401));
        }
        if (!healthy && pathname === "/v1/auth/refresh") {
          return Promise.reject(new Error("refresh response was lost"));
        }
        if (healthy && pathname === "/v1/organizations") {
          return Promise.resolve(json({
            ok: true,
            data: { organizations: [ORGANIZATION], cursor: null },
            requestId: REQUEST_ID,
          }));
        }
        return pairingFetch(input, init);
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });

    let markOldOperationEntered = (): void => undefined;
    const oldOperationEntered = new Promise<void>((resolve) => {
      markOldOperationEntered = resolve;
    });
    let releaseOldOperation = (): void => undefined;
    const oldOperationReleased = new Promise<void>((resolve) => {
      releaseOldOperation = resolve;
    });
    const drainingOperation = account.gatewaySessionCoordinator()!.execute(
      async () => {
        markOldOperationEntered();
        await oldOperationReleased;
        return { ok: true as const, data: null };
      },
    );
    await oldOperationEntered;

    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "AUTH_REFRESH_INDETERMINATE" },
    });
    expect(account.snapshot()).toMatchObject({ state: "recovery_required" });
    expect(await credentials.read()).toBeNull();
    expect(backing.values).toEqual(before);
    expect(deleteAttempts).toBe(0);
    expect(metadata.quarantined.map(({ kind, reason }) => ({ kind, reason })))
      .toEqual([{
        kind: "committed",
        reason: "invalid_pointer_preserved",
      }]);

    const requestsAfterContainment = requests;
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(requests).toBe(requestsAfterContainment);

    const recovery = account.snapshot();
    expect(await account.confirmLegacyCredentialReconnect(recovery.revision))
      .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
    healthy = true;
    const originalWrite = credentials.write.bind(credentials);
    let markFreshPairingWritten = (): void => undefined;
    const freshPairingWritten = new Promise<void>((resolve) => {
      markFreshPairingWritten = resolve;
    });
    Object.defineProperty(credentials, "write", {
      configurable: true,
      value: async (authentication: Parameters<HumanCredentialCustody["write"]>[0]) => {
        const snapshot = await originalWrite(authentication);
        markFreshPairingWritten();
        return snapshot;
      },
    });
    expect(account.startSignIn()).toMatchObject({ state: "signing_in" });
    const fastRepair = account.signInCompletion();
    await freshPairingWritten;
    expect(await Promise.race([
      fastRepair.then(() => "completed" as const),
      new Promise<"draining">((resolve) =>
        setTimeout(() => resolve("draining"), 5)
      ),
    ])).toBe("draining");
    releaseOldOperation();
    await drainingOperation;
    expect(await fastRepair).toMatchObject({ state: "signed_in" });
    expect(await account.listOrganizations()).toMatchObject({
      ok: true,
      data: { organizations: [ORGANIZATION] },
    });

    expect(await account.signOut()).toMatchObject({ state: "signed_out" });
    account.closeAdmission();
    const requestsAtTerminalClose = requests;
    expect(account.startSignIn()).toMatchObject({ state: "signed_out" });
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(requests).toBe(requestsAtTerminalClose);
  });

  test("an unconfirmed refresh quarantine remains recovery-required after restart", async () => {
    const metadata = new MemoryMetadata();
    const backing = memorySecrets();
    let deleteAttempts = 0;
    const secrets: SecretStore = {
      get: async (input) => await backing.get(input),
      set: async (input) => await backing.set(input),
      delete: async (input) => {
        deleteAttempts += 1;
        return await backing.delete(input);
      },
    };
    const credentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "refresh_fault_restart_01",
    });
    await credentials.write(storedAuthentication({
      accessToken: "refresh-fault-access-token",
      refreshToken: "refresh-fault-refresh-token",
    }));
    const before = new Map(backing.values);
    Object.defineProperty(credentials, "preserveForRecovery", {
      configurable: true,
      value: () => Promise.reject(new Error("injected quarantine fault")),
    });
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/organizations") {
          return Promise.resolve(json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, 401));
        }
        if (pathname === "/v1/auth/refresh") {
          return Promise.reject(new Error("refresh response was lost"));
        }
        return Promise.reject(new Error(`unexpected request ${request.url}`));
      },
    });
    expect(await account.initialize()).toMatchObject({ state: "signed_in" });
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "AUTH_REFRESH_INDETERMINATE" },
    });
    expect(account.snapshot()).toMatchObject({ state: "recovery_required" });
    expect(metadata.account?.credentialRecoveryPending).toBeTrue();
    expect(await credentials.read()).not.toBeNull();
    expect(backing.values).toEqual(before);
    expect(deleteAttempts).toBe(0);

    const restartedCredentials = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "refresh_fault_restart_02",
    });
    const restarted = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials: restartedCredentials,
      fetch: successfulPairingFetch(),
    });
    const recovery = await restarted.initialize();
    expect(recovery).toMatchObject({ state: "recovery_required" });
    expect(await restarted.confirmLegacyCredentialReconnect(recovery.revision))
      .toMatchObject({ ok: true, snapshot: { state: "signed_out" } });
    expect(await restartedCredentials.read()).toBeNull();
    expect(metadata.account?.credentialRecoveryPending).toBeUndefined();
    expect(metadata.quarantined).toMatchObject([{
      kind: "committed",
      reason: "invalid_pointer_preserved",
    }]);
    expect(backing.values).toEqual(before);
    expect(deleteAttempts).toBe(0);
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
    await credentials.write(storedAuthentication({
      accessToken: "signed-in-access-token-that-stays-private",
      refreshToken: "signed-in-refresh-token-that-stays-private",
    }));
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulPairingFetch(),
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
      await credentials.write(storedAuthentication({
        accessToken: "session-fault-private-access",
        refreshToken: "session-fault-private-refresh",
      }));
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulPairingFetch(),
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
      await credentials.write(storedAuthentication({
        accessToken: "post-init-private-access",
        refreshToken: "post-init-private-refresh",
      }));
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulPairingFetch(),
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
      await credentials.write(storedAuthentication({
        accessToken: "deleting-anomaly-private-access",
        refreshToken: "deleting-anomaly-private-refresh",
      }));
      const account = new HumanAccountService({
        configuration: configuration(),
        metadata,
        credentials,
        fetch: successfulPairingFetch(),
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
        fetch: successfulPairingFetch(),
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
      fetch: successfulPairingFetch(),
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
      fetch: successfulPairingFetch(),
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
    await credentials.write(storedAuthentication({
      accessToken: "foreign-retained-access-token",
      refreshToken: "foreign-retained-refresh-token",
      userId: FOREIGN_USER_ID,
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
      const committedAuthentication = storedAuthentication({
        accessToken: "committed-authority-access-token",
        refreshToken: "committed-authority-refresh-token",
        userId: COMMITTED_USER_ID,
      });
      const pendingValue = rejectedPending === "malformed_payload"
        ? "not a human authentication payload"
        : JSON.stringify(storedAuthentication({
          apiUrl: rejectedPending === "foreign_origin"
            ? "https://other-hra.example.com"
            : API_ORIGIN,
          accessToken: "rejected-pending-access-token",
          refreshToken: "rejected-pending-refresh-token",
          userId: rejectedPending === "foreign_principal"
            ? PENDING_USER_ID
            : committedAuthentication.user.id,
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
    const foreign = storedAuthentication({
      accessToken: "foreign-committed-access-token",
      refreshToken: "foreign-committed-refresh-token",
      userId: FOREIGN_USER_ID,
    });
    const bound = storedAuthentication({
      accessToken: "bound-pending-access-token",
      refreshToken: "bound-pending-refresh-token",
      userId: COMMITTED_USER_ID,
      organization: {
        id: "organization_boundscheduleauthority",
        name: "Bound organization",
        role: "admin",
        status: "active",
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
    const foreignOrigin = storedAuthentication({
      apiUrl: "https://foreign-hra.example.com",
      accessToken: "foreign-origin-access-token",
      refreshToken: "foreign-origin-refresh-token",
      userId: FOREIGN_USER_ID,
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
    const userId = USER_ID;
    await credentials.write(storedAuthentication({
      apiUrl: "https://foreign-hra.example.com",
      accessToken: "foreign-origin-access-token",
      refreshToken: "foreign-origin-refresh-token",
      userId,
    }));
    const acceptedOrigins: string[] = [];
    const account = new HumanAccountService({
      configuration: configuration(),
      metadata,
      credentials,
      fetch: successfulPairingFetch(),
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
