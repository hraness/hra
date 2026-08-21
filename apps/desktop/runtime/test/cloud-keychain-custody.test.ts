import { describe, expect, test } from "bun:test";
import {
  humanAuthenticationSchema,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyQuarantinePointer,
  type SecretStore,
} from "@hraness/hra-human-client";

import {
  HumanAccountService,
  HumanCredentialCustody,
  HRA_CLOUD_API_URL_ENV,
  HRA_CLOUD_WEB_URL_ENV,
  HRA_HUMAN_KEYCHAIN_NAME,
  cloudAttachmentAvailability,
  isLegacyKeychainIdentityAccessDenied,
  parseHRACloudConfiguration,
  reconcileHumanAccountMetadata,
  type HumanAccountMetadata,
  type HumanAccountMetadataPort,
} from "../src/cloud";

function bunSecretsError(code: string, status: number): Error {
  const error = new Error(`localized keychain message (code: ${status})`);
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: code,
  });
  return error;
}

function key(input: { readonly service: string; readonly name: string }): string {
  return `${input.service}:${input.name}`;
}

function memorySecrets(): SecretStore & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: (input) => Promise.resolve(values.get(key(input)) ?? null),
    set: (input) => {
      values.set(key(input), input.value);
      return Promise.resolve();
    },
    delete: (input) => Promise.resolve(values.delete(key(input))),
  };
}

class MemoryHumanMetadata implements HumanAccountMetadataPort {
  journal: SecretCustodyJournal | null = null;
  account: HumanAccountMetadata | null = null;
  readonly quarantined: SecretCustodyQuarantinePointer[] = [];

  read(descriptor: SecretCustodyDescriptor): Promise<unknown> {
    void descriptor;
    return Promise.resolve(this.journal);
  }

  compareAndSwap(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number | null;
    readonly next: SecretCustodyJournal;
  }): Promise<boolean> {
    expect(input.descriptor.service).toBe("kitchen.hraness.cloud-human.v1");
    expect(input.descriptor.name).toBe(HRA_HUMAN_KEYCHAIN_NAME);
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

function authentication(access: string, refresh: string) {
  return humanAuthenticationSchema.parse({
    version: 2,
    apiUrl: "https://oprte.example.com",
    accessToken: access,
    refreshToken: refresh,
    user: {
      id: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      email: "chef@example.com",
      name: "Chef",
    },
    organization: {
      id: "org_oprte",
      name: "OPRTE",
      role: "owner",
      status: "active",
    },
  });
}

function slots(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("slot fixture exhausted");
    return value;
  };
}

describe("desktop cloud configuration", () => {
  test("classifies only Bun's exact legacy Keychain ACL denial", () => {
    expect(isLegacyKeychainIdentityAccessDenied(
      bunSecretsError("ERR_SECRETS_AUTH_FAILED", -25293),
    )).toBeTrue();

    for (const error of [
      bunSecretsError("ERR_SECRETS_AUTH_FAILED", -25308),
      bunSecretsError("ERR_SECRETS_INTERACTION_NOT_ALLOWED", -25308),
      bunSecretsError("ERR_SECRETS_INTERACTION_REQUIRED", -25315),
      bunSecretsError("ERR_SECRETS_USER_CANCELED", -128),
      bunSecretsError("ERR_SECRETS_ACCESS_DENIED", -25293),
      new Error("legacy access failed (code: -25293)"),
      { code: "ERR_SECRETS_AUTH_FAILED", message: "(code: -25293)" },
    ]) {
      expect(isLegacyKeychainIdentityAccessDenied(error)).toBeFalse();
    }
  });

  test("accepts HTTPS and exact loopback HTTP, and fails closed on conflicts", () => {
    expect(cloudAttachmentAvailability(parseHRACloudConfiguration({
      [HRA_CLOUD_API_URL_ENV]: "https://oprte.example.com",
      [HRA_CLOUD_WEB_URL_ENV]: "https://app.oprte.example.com",
    }))).toEqual({
      state: "enabled",
      apiOrigin: "https://oprte.example.com",
      webOrigin: "https://app.oprte.example.com",
    });

    expect(cloudAttachmentAvailability(parseHRACloudConfiguration({
      [HRA_CLOUD_API_URL_ENV]: "http://127.0.0.1:3210",
      [HRA_CLOUD_WEB_URL_ENV]: "http://127.0.0.1:5173",
    }))).toMatchObject({ state: "enabled" });

    expect(cloudAttachmentAvailability(parseHRACloudConfiguration({
      [HRA_CLOUD_API_URL_ENV]: "http://oprte.example.com",
      [HRA_CLOUD_WEB_URL_ENV]: "https://app.oprte.example.com",
    }))).toEqual({ state: "disabled", reason: "api_invalid" });

    expect(cloudAttachmentAvailability(parseHRACloudConfiguration({
      [HRA_CLOUD_API_URL_ENV]: "https://one.example.com",
      TASKCTL_API_URL: "https://two.example.com",
      [HRA_CLOUD_WEB_URL_ENV]: "https://app.oprte.example.com",
    }))).toEqual({ state: "disabled", reason: "api_conflicting" });

    expect(cloudAttachmentAvailability(parseHRACloudConfiguration({
      [HRA_CLOUD_API_URL_ENV]: "https://api.oprte.example.com",
      [HRA_CLOUD_WEB_URL_ENV]: "http://app.oprte.example.com",
    }))).toEqual({ state: "disabled", reason: "web_invalid" });
  });

  test("missing attachment configuration performs zero network operations", async () => {
    const metadata = new MemoryHumanMetadata();
    let requests = 0;
    const account = new HumanAccountService({
      configuration: parseHRACloudConfiguration({}),
      metadata,
      fetch: () => {
        requests += 1;
        return Promise.reject(new Error("network must remain disabled"));
      },
    });

    expect(await account.initialize()).toMatchObject({ state: "signed_out" });
    expect(account.availability()).toEqual({
      state: "disabled",
      reason: "api_missing",
    });
    expect(account.startSignIn()).toMatchObject({
      state: "error",
      error: { code: "CONFIGURATION_UNAVAILABLE" },
    });
    expect(await account.listOrganizations()).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION_UNAVAILABLE" },
    });
    expect(account.cloudWorkspaceClient()).toBeNull();
    expect(requests).toBe(0);
  });
});

describe("desktop generational Keychain custody", () => {
  test("retains a high-water generation across logout and keeps metadata token-free", async () => {
    const metadata = new MemoryHumanMetadata();
    const secrets = memorySecrets();
    const custody = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: slots(
        "firstopaqueslot1",
        "secondopaqueslot",
      ),
    });
    const first = authentication(
      "access-token-that-must-never-enter-sqlite",
      "refresh-token-that-must-never-enter-sqlite",
    );
    const second = authentication(
      "second-access-token-that-stays-in-keychain",
      "second-refresh-token-that-stays-in-keychain",
    );

    const written = await custody.write(first);
    expect(written.generation).toBe(0);
    await reconcileHumanAccountMetadata(metadata, written);
    expect(await custody.clear({ expectedGeneration: 0 })).toBeTrue();
    await reconcileHumanAccountMetadata(metadata, null);
    const signedOutRevision = metadata.account?.revision;
    await reconcileHumanAccountMetadata(metadata, null);
    expect(metadata.account?.revision).toBe(signedOutRevision);
    const replaced = await custody.write(second);
    expect(replaced.generation).toBe(1);
    await reconcileHumanAccountMetadata(metadata, replaced);

    const sqliteSource = JSON.stringify({
      journal: metadata.journal,
      account: metadata.account,
    });
    for (const secret of [
      first.accessToken,
      first.refreshToken,
      second.accessToken,
      second.refreshToken,
    ]) {
      expect(sqliteSource).not.toContain(secret);
    }
    expect(metadata.journal).toMatchObject({
      latestGeneration: 1,
      committed: { generation: 1 },
    });
    expect(metadata.account).toMatchObject({
      credentialGeneration: 1,
      profile: {
        apiUrl: "https://oprte.example.com",
        secretStore: "keychain",
      },
    });
    expect(secrets.values.size).toBe(1);
    expect([...secrets.values.keys()][0]).toContain(
      "kitchen.hraness.cloud-human.v1:primary:slot:",
    );
  });

  test("rejects stale refresh and logout generations under a keychain race", async () => {
    const metadata = new MemoryHumanMetadata();
    const custody = new HumanCredentialCustody({
      metadata,
      secrets: memorySecrets(),
      nextSlot: slots(
        "raceopaqueslot01",
        "raceopaqueslot02",
      ),
    });
    const first = await custody.write(authentication(
      "initial-access-token-that-is-long-enough",
      "initial-refresh-token-that-is-long-enough",
    ));
    const next = {
      generation: first.generation + 1,
      authentication: authentication(
        "rotated-access-token-that-is-long-enough",
        "rotated-refresh-token-that-is-long-enough",
      ),
    };

    expect(await custody.compareAndSwap({
      expectedGeneration: first.generation,
      next,
    })).toEqual(next);
    expect(await custody.compareAndSwap({
      expectedGeneration: first.generation,
      next,
    })).toBeNull();
    expect(await custody.clear({ expectedGeneration: first.generation }))
      .toBeFalse();
    expect((await custody.read())?.authentication.user.email)
      .toBe("chef@example.com");
  });

  test("preserves one exact authentication generation without deleting Keychain bytes", async () => {
    const metadata = new MemoryHumanMetadata();
    const secrets = memorySecrets();
    const custody = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "refreshcontainment01",
    });
    const written = await custody.write(authentication(
      "indeterminate-refresh-access-token",
      "indeterminate-refresh-token",
    ));
    const before = new Map(secrets.values);

    expect(await custody.preserveForRecovery({
      expectedGeneration: written.generation + 1,
    })).toBeFalse();
    expect(await custody.read()).toEqual(written);

    expect(await custody.preserveForRecovery({
      expectedGeneration: written.generation,
    })).toBeTrue();
    expect(await custody.read()).toBeNull();
    expect(secrets.values).toEqual(before);
    expect(metadata.quarantined).toMatchObject([{
      kind: "committed",
      pointer: { generation: written.generation },
      reason: "invalid_pointer_preserved",
    }]);

    const restarted = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: () => "refreshcontainment02",
    });
    expect(await restarted.read()).toBeNull();
    expect(secrets.values).toEqual(before);
  });

  test("stale scope containment leaves a newer same-user generation live", async () => {
    const metadata = new MemoryHumanMetadata();
    const secrets = memorySecrets();
    const custody = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: slots("scope_old_generation", "scope_new_generation"),
    });
    const old = await custody.write(authentication(
      "scope-old-access-token",
      "scope-old-refresh-token",
    ));
    const authority = await custody.inspectScopeSelectionAuthority(old);
    const next = {
      generation: old.generation + 1,
      authentication: authentication(
        "scope-new-access-token",
        "scope-new-refresh-token",
      ),
    };
    expect(await custody.compareAndSwap({
      expectedGeneration: old.generation,
      next,
    })).toEqual(next);

    expect(await custody.preserveIndeterminateScopeSession({ authority }))
      .toEqual({ state: "newer_winner", snapshot: next });
    expect(await custody.read()).toEqual(next);
    expect(metadata.quarantined).toHaveLength(0);
    expect(secrets.values.size).toBe(1);
  });

  test("stale scope containment never projects a newer committed value beside pending custody", async () => {
    const metadata = new MemoryHumanMetadata();
    const backing = memorySecrets();
    let rejectPendingWrite = false;
    const secrets: SecretStore = {
      get: async (input) => await backing.get(input),
      set: async (input) => {
        if (rejectPendingWrite) {
          rejectPendingWrite = false;
          throw new Error("injected pending write fault");
        }
        await backing.set(input);
      },
      delete: async (input) => await backing.delete(input),
    };
    const custody = new HumanCredentialCustody({
      metadata,
      secrets,
      nextSlot: slots(
        "scope_pending_old_01",
        "scope_pending_new_02",
        "scope_pending_gap_03",
      ),
    });
    const old = await custody.write(authentication(
      "scope-pending-old-access",
      "scope-pending-old-refresh",
    ));
    const authority = await custody.inspectScopeSelectionAuthority(old);
    const newer = {
      generation: old.generation + 1,
      authentication: authentication(
        "scope-pending-new-access",
        "scope-pending-new-refresh",
      ),
    };
    expect(await custody.compareAndSwap({
      expectedGeneration: old.generation,
      next: newer,
    })).toEqual(newer);
    rejectPendingWrite = true;
    expect(custody.compareAndSwap({
      expectedGeneration: newer.generation,
      next: {
        generation: newer.generation + 1,
        authentication: authentication(
          "scope-pending-gap-access",
          "scope-pending-gap-refresh",
        ),
      },
    })).rejects.toMatchObject({ reason: "custody_unavailable" });

    expect(custody.preserveIndeterminateScopeSession({ authority }))
      .rejects.toMatchObject({ reason: "concurrent_update" });
    expect(metadata.quarantined).toHaveLength(0);
    expect(metadata.journal).toMatchObject({
      committed: { generation: newer.generation },
      pending: { pointer: { generation: newer.generation + 1 } },
    });
    expect(backing.values.size).toBe(1);
  });

  test("requires explicit proof before abandoning an indeterminate pre-Keychain crash", async () => {
    const metadata = new MemoryHumanMetadata();
    metadata.journal = {
      version: 1,
      revision: 0,
      latestGeneration: 0,
      service: "kitchen.hraness.cloud-human.v1",
      name: HRA_HUMAN_KEYCHAIN_NAME,
      pending: {
        pointer: {
          generation: 0,
          slot: "missingopaqueslot",
        },
        replacesGeneration: null,
      },
    };
    const custody = new HumanCredentialCustody({
      metadata,
      secrets: memorySecrets(),
      nextSlot: () => "recoveredslot001",
    });

    expect(custody.recover({ abandonMissingPending: false }))
      .rejects.toThrow("recovery is required");
    expect(metadata.journal.pending).toBeDefined();
    expect(await custody.recover({ abandonMissingPending: true })).toEqual({
      state: "abandoned_missing_pending",
    });
    const next = await custody.write(authentication(
      "post-recovery-access-token-is-generation-one",
      "post-recovery-refresh-token-is-generation-one",
    ));
    expect(next.generation).toBe(1);
  });

  test("returns the actual generation after an abandoned refresh gap", async () => {
    const metadata = new MemoryHumanMetadata();
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
    const custody = new HumanCredentialCustody({
      metadata,
      secrets: faultedSecrets,
      nextSlot: slots(
        "gapaccountslot01",
        "gapmissingslot01",
        "gapactualslot002",
      ),
    });
    const original = await custody.write(authentication(
      "original-gap-access-token-is-long-enough",
      "original-gap-refresh-token-is-long-enough",
    ));
    const requested = {
      generation: original.generation + 1,
      authentication: authentication(
        "replacement-gap-access-token-is-long-enough",
        "replacement-gap-refresh-token-is-long-enough",
      ),
    };
    rejectNextSet = true;
    expect(custody.compareAndSwap({
      expectedGeneration: original.generation,
      next: requested,
    })).rejects.toMatchObject({ reason: "custody_unavailable" });
    expect(
      await custody.recover({ abandonMissingPending: true }),
    ).toEqual({
      state: "abandoned_missing_pending",
      generation: 0,
    });

    const replaced = await custody.compareAndSwap({
      expectedGeneration: original.generation,
      next: requested,
    });
    expect(replaced).toMatchObject({
      generation: 2,
      authentication: requested.authentication,
    });
    expect(await custody.read()).toEqual(replaced);
    expect(metadata.journal).toMatchObject({
      latestGeneration: 2,
      committed: { generation: 2, slot: "gapactualslot002" },
    });
    expect(secrets.values.size).toBe(1);
  });
});
