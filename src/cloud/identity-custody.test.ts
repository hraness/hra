import { describe, expect, test } from "bun:test";

import type { CloudSecretCustodyPort } from "./local-control";
import { IdentityScopedCloudSecretCustody } from "./identity-custody";

class MemoryCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return Promise.resolve(this.values.get(slot) ?? null);
  }

  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const current = this.values.get(slot) ?? null;
    if ((current?.generation ?? null) !== expectedGeneration) return Promise.resolve(null);
    const next = { generation: (current?.generation ?? -1) + 1, value };
    this.values.set(slot, next);
    return Promise.resolve(next);
  }

  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    const current = this.values.get(slot);
    if (current?.generation !== expectedGeneration) return Promise.resolve(false);
    this.values.delete(slot);
    return Promise.resolve(true);
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
  test("preserves isolated A to B to A device, key, state, outbox, and journal authority", async () => {
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
    ]) expect(await identityB.read(slot)).toBeNull();
    await write(identityB, "cloud-device", "device-b");
    await write(identityB, "cloud-account-key", "key-b");
    await write(identityB, "cloud-account-deletion", "deletion-b");
    await write(identityB, "cloud-state", "state-b");
    await write(identityB, "cloud-command-outbox", "outbox-b");
    await write(identityB, "cloud-daemon-journal", "journal-b");

    expect((await identityB.activateIdentity("user_aaaaaaaa")).restartRequired).toBe(true);
    const returnedA = await IdentityScopedCloudSecretCustody.open(raw);
    expect(returnedA.cacheNamespace).toBe(identityA.cacheNamespace);
    expect((await returnedA.read("cloud-device"))?.value).toBe("device-a");
    expect((await returnedA.read("cloud-account-key"))?.value).toBe("key-a");
    expect((await returnedA.read("cloud-account-deletion"))?.value).toBe("deletion-a");
    expect((await returnedA.read("cloud-state"))?.value).toBe("state-a");
    expect((await returnedA.read("cloud-command-outbox"))?.value).toBe("outbox-a");
    expect((await returnedA.read("cloud-daemon-journal"))?.value).toBe("journal-a");
  });

  test("fails closed on corrupt active identity custody", async () => {
    const raw = new MemoryCustody();
    await write(raw, "cloud-active-identity", JSON.stringify({
      userPublicId: "not valid",
      version: 1,
    }));
    await expect(IdentityScopedCloudSecretCustody.open(raw)).rejects.toThrow("corrupt");
  });
});
