import { describe, expect, test } from "bun:test";

import type { CloudSecretCustodyPort } from "./local-control";
import {
  acquireCloudDeploymentAuthority,
  cloudDeploymentAuthorityFromEnvironment,
  cloudDeploymentSelectionFromEnvironment,
  DEFAULT_CLOUD_DEPLOYMENT_URL,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
  readCloudDeploymentAuthority,
} from "./identity-custody";

class MemoryCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(slot)) throw new Error("Invalid secret slot.");
    return Promise.resolve(this.values.get(slot) ?? null);
  }

  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(slot)) throw new Error("Invalid secret slot.");
    const current = this.values.get(slot) ?? null;
    if ((current?.generation ?? null) !== expectedGeneration) return Promise.resolve(null);
    const next = { generation: (current?.generation ?? -1) + 1, value };
    this.values.set(slot, next);
    return Promise.resolve(next);
  }

  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(slot)) throw new Error("Invalid secret slot.");
    const current = this.values.get(slot);
    if (current?.generation !== expectedGeneration) return Promise.resolve(false);
    this.values.delete(slot);
    return Promise.resolve(true);
  }
}

class LegacyWriteDuringAuthorityCasCustody extends MemoryCustody {
  #injected = false;

  override async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const committed = await super.compareAndSwap(slot, expectedGeneration, value);
    if (slot === "cloud-deployment-authority" && committed !== null && !this.#injected) {
      this.#injected = true;
      this.values.set("cloud-auth", { generation: 0, value: "late-legacy-auth" });
    }
    return committed;
  }
}

async function write(
  custody: CloudSecretCustodyPort,
  slot: string,
  value: string,
): Promise<void> {
  const current = await custody.read(slot);
  const committed = await custody.compareAndSwap(slot, current?.generation ?? null, value);
  if (committed === null) throw new Error("fixture CAS failed");
}

describe("cloud identity-scoped custody", () => {
  test("preserves isolated A to B to A device, key, state, outbox, journal, and attention authority", async () => {
    const raw = new MemoryCustody();
    const unbound = await IdentityScopedCloudSecretCustody.open(raw);
    expect(unbound.activeUserPublicId).toBeNull();
    expect(await unbound.read("cloud-device")).toBeNull();
    await expect(unbound.compareAndSwap("cloud-device", null, "unsafe"))
      .rejects.toThrow("daemon restart");

    expect(await unbound.activateIdentity("user_aaaaaaaa")).toEqual({
      restartRequired: true,
      userPublicId: "user_aaaaaaaa",
    });
    const identityA = await IdentityScopedCloudSecretCustody.open(raw);
    await write(identityA, "cloud-auth", "global-auth");
    await write(identityA, "cloud-device", "device-a");
    await write(identityA, "cloud-account-key", "key-a");
    await write(identityA, "cloud-account-deletion", "deletion-a");
    await write(identityA, "cloud-state", "state-a");
    await write(identityA, "cloud-command-outbox", "outbox-a");
    await write(identityA, "cloud-daemon-journal", "journal-a");
    await write(
      identityA,
      "cloud-attention-notification-reconciliation",
      "attention-a",
    );

    expect(await identityA.activateIdentity("user_bbbbbbbb")).toEqual({
      restartRequired: true,
      userPublicId: "user_bbbbbbbb",
    });
    const identityB = await IdentityScopedCloudSecretCustody.open(raw);
    expect(identityB.cacheNamespace).not.toBe(identityA.cacheNamespace);
    expect((await identityB.read("cloud-auth"))?.value).toBe("global-auth");
    for (const slot of [
      "cloud-device",
      "cloud-account-key",
      "cloud-account-deletion",
      "cloud-state",
      "cloud-command-outbox",
      "cloud-daemon-journal",
      "cloud-attention-notification-reconciliation",
    ]) expect(await identityB.read(slot)).toBeNull();
    await write(identityB, "cloud-device", "device-b");
    await write(identityB, "cloud-account-key", "key-b");
    await write(identityB, "cloud-account-deletion", "deletion-b");
    await write(identityB, "cloud-state", "state-b");
    await write(identityB, "cloud-command-outbox", "outbox-b");
    await write(identityB, "cloud-daemon-journal", "journal-b");
    await write(
      identityB,
      "cloud-attention-notification-reconciliation",
      "attention-b",
    );

    expect((await identityB.activateIdentity("user_aaaaaaaa")).restartRequired).toBe(true);
    const returnedA = await IdentityScopedCloudSecretCustody.open(raw);
    expect(returnedA.cacheNamespace).toBe(identityA.cacheNamespace);
    expect((await returnedA.read("cloud-device"))?.value).toBe("device-a");
    expect((await returnedA.read("cloud-account-key"))?.value).toBe("key-a");
    expect((await returnedA.read("cloud-account-deletion"))?.value).toBe("deletion-a");
    expect((await returnedA.read("cloud-state"))?.value).toBe("state-a");
    expect((await returnedA.read("cloud-command-outbox"))?.value).toBe("outbox-a");
    expect((await returnedA.read("cloud-daemon-journal"))?.value).toBe("journal-a");
    expect((await returnedA.read("cloud-attention-notification-reconciliation"))?.value)
      .toBe("attention-a");
  });

  test("fences one opened identity to its exact selector generation", async () => {
    const raw = new MemoryCustody();
    const unbound = await IdentityScopedCloudSecretCustody.open(raw);
    await unbound.assertCurrentIdentity(null);
    await unbound.activateIdentity("user_aaaaaaaa");
    await expect(unbound.assertCurrentIdentity(null))
      .rejects.toThrow("Cloud identity selection changed; restart HRA.");

    const identityA = await IdentityScopedCloudSecretCustody.open(raw);
    await identityA.assertCurrentIdentity("user_aaaaaaaa");
    await identityA.activateIdentity("user_bbbbbbbb");
    await expect(identityA.assertCurrentIdentity("user_aaaaaaaa"))
      .rejects.toThrow("Cloud identity selection changed; restart HRA.");

    const identityB = await IdentityScopedCloudSecretCustody.open(raw);
    await identityB.activateIdentity("user_aaaaaaaa");
    await expect(identityA.assertCurrentIdentity("user_aaaaaaaa"))
      .rejects.toThrow("Cloud identity selection changed; restart HRA.");
    const returnedA = await IdentityScopedCloudSecretCustody.open(raw);
    await returnedA.assertCurrentIdentity("user_aaaaaaaa");
  });

  test("fences only daemon attention custody before and after selector changes", async () => {
    const raw = new MemoryCustody();
    const unbound = await IdentityScopedCloudSecretCustody.open(raw);
    expect(await unbound.read("cloud-attention-notification-reconciliation")).toBeNull();
    await unbound.activateIdentity("user_aaaaaaaa");

    const identityA = await IdentityScopedCloudSecretCustody.open(raw);
    await write(
      identityA,
      "cloud-attention-notification-reconciliation",
      "receipt-a",
    );
    await identityA.activateIdentity("user_bbbbbbbb");
    await expect(identityA.read("cloud-attention-notification-reconciliation"))
      .rejects.toThrow("Cloud identity selection changed; restart HRA.");
    await expect(identityA.compareAndSwap(
      "cloud-attention-notification-reconciliation",
      0,
      "stale-write",
    )).rejects.toThrow("Cloud identity selection changed; restart HRA.");
    await expect(identityA.clearIfGeneration(
      "cloud-attention-notification-reconciliation",
      0,
    )).rejects.toThrow("Cloud identity selection changed; restart HRA.");

    const identityB = await IdentityScopedCloudSecretCustody.open(raw);
    expect(await identityB.read("cloud-attention-notification-reconciliation")).toBeNull();
  });

  test("fails closed on corrupt active identity custody", async () => {
    const raw = new MemoryCustody();
    await write(raw, "cloud-active-identity", JSON.stringify({
      userPublicId: "not valid",
      version: 1,
    }));
    await expect(IdentityScopedCloudSecretCustody.open(raw)).rejects.toThrow("corrupt");
  });

  test("selects the release deployment by default, validates overrides, and treats only explicit empty as disabled", () => {
    expect(cloudDeploymentSelectionFromEnvironment({})).toEqual({
      deploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
      explicit: false,
      kind: "enabled",
    });
    expect(cloudDeploymentSelectionFromEnvironment({ HRA_CONVEX_URL: "  " }))
      .toEqual({ kind: "disabled" });
    expect(cloudDeploymentSelectionFromEnvironment({
      HRA_CONVEX_URL: "https://EXAMPLE.convex.cloud/",
    })).toEqual({
      deploymentUrl: "https://example.convex.cloud",
      explicit: true,
      kind: "enabled",
    });
    for (const value of [
      "not a URL",
      "http://example.convex.cloud",
      "https://user@example.convex.cloud",
      "https://example.convex.cloud/path",
      "https://example.convex.cloud?target=other",
    ]) {
      expect(() => cloudDeploymentSelectionFromEnvironment({ HRA_CONVEX_URL: value }))
        .toThrow("HRA_CONVEX_URL is invalid.");
    }
  });

  test("atomically acquires one exact deployment generation under concurrent opens", async () => {
    const custody = new MemoryCustody();
    const selection = cloudDeploymentSelectionFromEnvironment({});
    if (selection.kind !== "enabled") throw new Error("fixture selection is disabled");
    const [first, second] = await Promise.all([
      acquireCloudDeploymentAuthority(custody, selection),
      acquireCloudDeploymentAuthority(custody, selection),
    ]);
    expect(first.deploymentUrl).toBe(DEFAULT_CLOUD_DEPLOYMENT_URL);
    expect(second.deploymentUrl).toBe(DEFAULT_CLOUD_DEPLOYMENT_URL);
    expect(first.generation).toBe(0);
    expect(second.generation).toBe(0);
    expect(custody.values.get("cloud-deployment-authority")?.generation).toBe(0);
    await Promise.all([first.assertCurrent(), second.assertCurrent()]);
  });

  test("allows only one deployment to win a competing first acquisition", async () => {
    const custody = new MemoryCustody();
    const firstSelection = cloudDeploymentSelectionFromEnvironment({
      HRA_CONVEX_URL: "https://first.convex.cloud",
    });
    const secondSelection = cloudDeploymentSelectionFromEnvironment({
      HRA_CONVEX_URL: "https://second.convex.cloud",
    });
    if (firstSelection.kind !== "enabled" || secondSelection.kind !== "enabled") {
      throw new Error("fixture selection is disabled");
    }
    const results = await Promise.allSettled([
      acquireCloudDeploymentAuthority(custody, firstSelection),
      acquireCloudDeploymentAuthority(custody, secondSelection),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { message: "Cloud deployment authority is bound to another deployment." },
    });
    if (fulfilled[0]?.status !== "fulfilled") throw new Error("fixture has no winner");
    await fulfilled[0].value.assertCurrent();
    expect(fulfilled[0].value.generation).toBe(0);
  });

  test("ignores a prior-version credential written concurrently after an implicit clean scan", async () => {
    const custody = new LegacyWriteDuringAuthorityCasCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(custody, {});
    if (authority === null) throw new Error("fixture authority is disabled");
    expect(authority.custodyMode).toBe("scoped");
    expect((await custody.read("cloud-auth"))?.value).toBe("late-legacy-auth");
    const deploymentCustody = new DeploymentScopedCloudSecretCustody(custody, authority);
    expect(await deploymentCustody.read("cloud-auth")).toBeNull();
    expect(await deploymentCustody.compareAndSwap("cloud-auth", null, "bound-auth"))
      .toMatchObject({ generation: 0, value: "bound-auth" });
    expect((await custody.read("cloud-auth"))?.value).toBe("late-legacy-auth");
    expect((await deploymentCustody.read("cloud-auth"))?.value).toBe("bound-auth");
  });

  test("requires an explicit one-time binding for legacy cloud custody", async () => {
    for (const slot of ["cloud-auth", "cloud-auth-logout", "cloud-active-identity"]) {
      const custody = new MemoryCustody();
      await write(custody, slot, "legacy");
      await expect(cloudDeploymentAuthorityFromEnvironment(custody, {}))
        .rejects.toThrow("requires an explicit HRA_CONVEX_URL");
      const bound = await cloudDeploymentAuthorityFromEnvironment(custody, {
        HRA_CONVEX_URL: "https://legacy-target.convex.cloud",
      });
      expect(bound?.deploymentUrl).toBe("https://legacy-target.convex.cloud");
      expect(bound?.custodyMode).toBe("legacy");
      if (bound === null) throw new Error("fixture authority is disabled");
      expect((await new DeploymentScopedCloudSecretCustody(custody, bound).read(slot))?.value)
        .toBe("legacy");
      await bound.assertCurrent();
    }
  });

  test("preserves legacy cache custody while new bindings isolate the same cloud identity", async () => {
    const activeIdentity = JSON.stringify({ userPublicId: "user_cache_12345678", version: 1 });
    const legacyRaw = new MemoryCustody();
    await write(legacyRaw, "cloud-active-identity", activeIdentity);
    const unboundLegacy = await IdentityScopedCloudSecretCustody.open(legacyRaw);
    const legacyAuthority = await cloudDeploymentAuthorityFromEnvironment(legacyRaw, {
      HRA_CONVEX_URL: "https://legacy-cache.convex.cloud",
    });
    if (legacyAuthority === null) throw new Error("fixture authority is disabled");
    const reboundLegacy = await IdentityScopedCloudSecretCustody.open(
      new DeploymentScopedCloudSecretCustody(legacyRaw, legacyAuthority),
    );
    expect(legacyAuthority.custodyMode).toBe("legacy");
    expect(reboundLegacy.cacheNamespace).toBe(unboundLegacy.cacheNamespace);

    const scopedRaw = new MemoryCustody();
    const scopedAuthority = await cloudDeploymentAuthorityFromEnvironment(scopedRaw, {});
    if (scopedAuthority === null) throw new Error("fixture authority is disabled");
    const deploymentCustody = new DeploymentScopedCloudSecretCustody(
      scopedRaw,
      scopedAuthority,
    );
    await write(deploymentCustody, "cloud-active-identity", activeIdentity);
    const scopedIdentity = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    expect(scopedAuthority.custodyMode).toBe("scoped");
    expect(scopedIdentity.cacheNamespace).not.toBe(unboundLegacy.cacheNamespace);
    expect((await scopedRaw.read("cloud-active-identity"))).toBeNull();
  });

  test("refuses another deployment and makes absent configuration mean the exact default", async () => {
    const customRaw = new MemoryCustody();
    const custom = await cloudDeploymentAuthorityFromEnvironment(customRaw, {
      HRA_CONVEX_URL: "https://custom.convex.cloud",
    });
    expect(custom?.deploymentUrl).toBe("https://custom.convex.cloud");
    expect(custom?.custodyMode).toBe("scoped");
    if (custom === null) throw new Error("fixture authority is disabled");
    const customCustody = new DeploymentScopedCloudSecretCustody(customRaw, custom);
    await write(customCustody, "cloud-state", "recoverable-state");
    await expect(cloudDeploymentAuthorityFromEnvironment(customRaw, {}))
      .rejects.toThrow("bound to another deployment");
    await expect(cloudDeploymentAuthorityFromEnvironment(customRaw, {
      HRA_CONVEX_URL: "https://other.convex.cloud",
    })).rejects.toThrow("bound to another deployment");
    const observedCustom = await readCloudDeploymentAuthority(customRaw);
    if (observedCustom === null) throw new Error("fixture authority is absent");
    expect((await new DeploymentScopedCloudSecretCustody(
      customRaw,
      observedCustom,
    ).read("cloud-state"))?.value).toBe("recoverable-state");

    const releaseCustody = new MemoryCustody();
    const explicit = await cloudDeploymentAuthorityFromEnvironment(releaseCustody, {
      HRA_CONVEX_URL: DEFAULT_CLOUD_DEPLOYMENT_URL,
    });
    const implicit = await cloudDeploymentAuthorityFromEnvironment(releaseCustody, {});
    expect(implicit?.generation).toBe(explicit?.generation);
    expect(implicit?.deploymentUrl).toBe(DEFAULT_CLOUD_DEPLOYMENT_URL);
  });

  test("fences changed, deleted, and delete-then-rebound authority observations", async () => {
    const custody = new MemoryCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(custody, {});
    if (authority === null) throw new Error("fixture authority is disabled");
    const committed = custody.values.get("cloud-deployment-authority");
    if (committed === undefined) throw new Error("fixture authority is absent");
    custody.values.set("cloud-deployment-authority", {
      generation: committed.generation + 1,
      value: committed.value,
    });
    await expect(authority.assertCurrent()).rejects.toThrow("not current");

    custody.values.delete("cloud-deployment-authority");
    await expect(authority.assertCurrent()).rejects.toThrow("not current");
    const rebound = await cloudDeploymentAuthorityFromEnvironment(custody, {});
    expect(rebound?.generation).toBe(0);
    await expect(authority.assertCurrent()).rejects.toThrow("not current");
    await rebound?.assertCurrent();
  });
});
