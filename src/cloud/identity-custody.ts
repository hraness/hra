import { createHash } from "node:crypto";

import { hasExactKeys, isOpaqueIdentifier, isRecord } from "./contracts";
import type { CloudSecretCustodyPort } from "./local-control";

const activeIdentitySlot = "cloud-active-identity";
const scopedSlots = new Set([
  "cloud-account-key",
  "cloud-account-deletion",
  "cloud-command-outbox",
  "cloud-daemon-journal",
  "cloud-device",
  "cloud-device-mutation",
  "cloud-device-registration",
  "cloud-device-replacement",
  "cloud-retired-devices",
  "cloud-state",
]);

type ActiveIdentity = Readonly<{
  userPublicId: string;
  version: 1;
}>;

function parseActiveIdentity(value: string): ActiveIdentity {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud identity selector custody is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["userPublicId", "version"])
    || decoded.version !== 1
    || !isOpaqueIdentifier(decoded.userPublicId)
  ) throw new Error("Cloud identity selector custody is corrupt.");
  return { userPublicId: decoded.userPublicId, version: 1 };
}

function namespaceFor(userPublicId: string): string {
  if (!isOpaqueIdentifier(userPublicId)) throw new Error("Cloud identity is invalid.");
  return createHash("sha256").update(`hra-control-plane-cloud-identity:v1:${userPublicId}`).digest("hex").slice(0, 24);
}

export class IdentityScopedCloudSecretCustody implements CloudSecretCustodyPort {
  readonly #activeUserPublicId: string | null;
  readonly #custody: CloudSecretCustodyPort;

  private constructor(custody: CloudSecretCustodyPort, activeUserPublicId: string | null) {
    this.#activeUserPublicId = activeUserPublicId;
    this.#custody = custody;
  }

  static async open(custody: CloudSecretCustodyPort): Promise<IdentityScopedCloudSecretCustody> {
    const observation = await custody.read(activeIdentitySlot);
    const active = observation === null ? null : parseActiveIdentity(observation.value);
    return new IdentityScopedCloudSecretCustody(custody, active?.userPublicId ?? null);
  }

  get activeUserPublicId(): string | null {
    return this.#activeUserPublicId;
  }

  get cacheNamespace(): string | null {
    return this.#activeUserPublicId === null ? null : namespaceFor(this.#activeUserPublicId);
  }

  async activateIdentity(userPublicId: string): Promise<Readonly<{
    restartRequired: boolean;
    userPublicId: string;
  }>> {
    if (!isOpaqueIdentifier(userPublicId)) throw new Error("Cloud identity is invalid.");
    const serialized = JSON.stringify({ userPublicId, version: 1 } satisfies ActiveIdentity);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#custody.read(activeIdentitySlot);
      if (current !== null) {
        const selected = parseActiveIdentity(current.value);
        if (selected.userPublicId === userPublicId) {
          return {
            restartRequired: this.#activeUserPublicId !== userPublicId,
            userPublicId,
          };
        }
      }
      const committed = await this.#custody.compareAndSwap(
        activeIdentitySlot,
        current?.generation ?? null,
        serialized,
      );
      if (committed !== null) {
        return {
          restartRequired: this.#activeUserPublicId !== userPublicId,
          userPublicId,
        };
      }
    }
    throw new Error("Cloud identity selector changed concurrently.");
  }

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    const physical = this.#physicalSlot(slot);
    return physical === null ? null : await this.#custody.read(physical);
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const physical = this.#physicalSlot(slot);
    if (physical === null) {
      throw new Error("Cloud identity selection requires a daemon restart.");
    }
    return await this.#custody.compareAndSwap(physical, expectedGeneration, value);
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    const physical = this.#physicalSlot(slot);
    return physical === null
      ? false
      : await this.#custody.clearIfGeneration(physical, expectedGeneration);
  }

  #physicalSlot(slot: string): string | null {
    if (!scopedSlots.has(slot)) return slot;
    if (this.#activeUserPublicId === null) return null;
    return `i-${namespaceFor(this.#activeUserPublicId)}-${slot}`;
  }
}

export function isIdentityScopedCloudCustody(
  custody: CloudSecretCustodyPort,
): custody is IdentityScopedCloudSecretCustody {
  return custody instanceof IdentityScopedCloudSecretCustody;
}
