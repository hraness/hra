import { createHash } from "node:crypto";

import { hasExactKeys, isOpaqueIdentifier, isRecord } from "./contracts";

export interface CloudSecretCustodyPort {
  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null>;
  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null>;
  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean>;
}

const activeIdentitySlot = "cloud-active-identity";
const deploymentAuthoritySlot = "cloud-deployment-authority";
const attentionNotificationReconciliationSlot =
  "cloud-attention-notification-reconciliation";
const legacyCloudSlots = [
  "cloud-active-identity",
  "cloud-auth",
  "cloud-auth-logout",
] as const;
export const DEFAULT_CLOUD_DEPLOYMENT_URL = "https://qualified-hummingbird-537.convex.cloud";
const scopedSlots = new Set([
  "cloud-account-key",
  "cloud-account-deletion",
  attentionNotificationReconciliationSlot,
  "cloud-command-outbox",
  "cloud-daemon-journal",
  "cloud-device",
  "cloud-device-mutation",
  "cloud-device-registration",
  "cloud-device-replacement",
  "cloud-retired-devices",
  "cloud-state",
]);
const identityGenerationFencedSlots = new Set([
  attentionNotificationReconciliationSlot,
]);

type ActiveIdentity = Readonly<{
  userPublicId: string;
  version: 1;
}>;

type CloudDeploymentAuthorityValue = Readonly<{
  bindingId: string;
  custodyMode: "legacy" | "scoped";
  deploymentUrl: string;
  version: 1;
}>;

export type CloudDeploymentSelection =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{
      deploymentUrl: string;
      explicit: boolean;
      kind: "enabled";
    }>;

export type CloudDeploymentAuthorityErrorCode =
  | "concurrent_change"
  | "corrupt_custody"
  | "invalid_configuration"
  | "legacy_binding_required"
  | "stale_authority"
  | "target_mismatch";

export class CloudDeploymentAuthorityError extends Error {
  constructor(readonly code: CloudDeploymentAuthorityErrorCode, message: string) {
    super(message);
    this.name = "CloudDeploymentAuthorityError";
  }
}

export interface CloudDeploymentAuthority {
  readonly cacheNamespace: string | null;
  readonly custodyMode: "legacy" | "scoped";
  readonly deploymentUrl: string;
  readonly generation: number;
  assertCurrent(): Promise<void>;
  scopeCustodySlot(slot: string): string;
}

export function canonicalCloudDeploymentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudDeploymentAuthorityError(
      "invalid_configuration",
      "HRA_CONVEX_URL is invalid.",
    );
  }
  const localHttp = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !localHttp)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new CloudDeploymentAuthorityError(
      "invalid_configuration",
      "HRA_CONVEX_URL is invalid.",
    );
  }
  return url.origin;
}

export function cloudDeploymentSelectionFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CloudDeploymentSelection {
  const value = environment.HRA_CONVEX_URL;
  if (value === undefined) {
    return {
      deploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
      explicit: false,
      kind: "enabled",
    };
  }
  if (value.trim() === "") return { kind: "disabled" };
  return {
    deploymentUrl: canonicalCloudDeploymentUrl(value),
    explicit: true,
    kind: "enabled",
  };
}

function parseDeploymentAuthorityValue(value: string): CloudDeploymentAuthorityValue {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new CloudDeploymentAuthorityError(
      "corrupt_custody",
      "Cloud deployment authority custody is corrupt.",
    );
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["bindingId", "custodyMode", "deploymentUrl", "version"])
    || decoded.version !== 1
    || !isOpaqueIdentifier(decoded.bindingId)
    || (decoded.custodyMode !== "legacy" && decoded.custodyMode !== "scoped")
    || typeof decoded.deploymentUrl !== "string"
  ) {
    throw new CloudDeploymentAuthorityError(
      "corrupt_custody",
      "Cloud deployment authority custody is corrupt.",
    );
  }
  let deploymentUrl: string;
  try {
    deploymentUrl = canonicalCloudDeploymentUrl(decoded.deploymentUrl);
  } catch {
    throw new CloudDeploymentAuthorityError(
      "corrupt_custody",
      "Cloud deployment authority custody is corrupt.",
    );
  }
  if (deploymentUrl !== decoded.deploymentUrl) {
    throw new CloudDeploymentAuthorityError(
      "corrupt_custody",
      "Cloud deployment authority custody is corrupt.",
    );
  }
  return {
    bindingId: decoded.bindingId,
    custodyMode: decoded.custodyMode,
    deploymentUrl,
    version: 1,
  };
}

class ExactCloudDeploymentAuthority implements CloudDeploymentAuthority {
  readonly #bindingId: string;
  readonly #custody: CloudSecretCustodyPort;
  readonly #custodyMode: "legacy" | "scoped";
  readonly #deploymentUrl: string;
  readonly #generation: number;
  readonly #serialized: string;

  constructor(
    custody: CloudSecretCustodyPort,
    observation: Readonly<{ generation: number; value: string }>,
    parsed: CloudDeploymentAuthorityValue,
  ) {
    this.#bindingId = parsed.bindingId;
    this.#custody = custody;
    this.#custodyMode = parsed.custodyMode;
    this.#deploymentUrl = parsed.deploymentUrl;
    this.#generation = observation.generation;
    this.#serialized = observation.value;
  }

  get cacheNamespace(): string | null {
    return this.#custodyMode === "legacy"
      ? null
      : createHash("sha256")
          .update(`hra-control-plane-cloud-deployment-cache:v1:${this.#bindingId}`)
          .digest("hex")
          .slice(0, 24);
  }

  get custodyMode(): "legacy" | "scoped" {
    return this.#custodyMode;
  }

  get deploymentUrl(): string {
    return this.#deploymentUrl;
  }

  get generation(): number {
    return this.#generation;
  }

  async assertCurrent(): Promise<void> {
    const current = await this.#custody.read(deploymentAuthoritySlot);
    if (
      current === null
      || current.generation !== this.generation
      || current.value !== this.#serialized
    ) {
      throw new CloudDeploymentAuthorityError(
        "stale_authority",
        "Cloud deployment authority is not current.",
      );
    }
    try {
      parseDeploymentAuthorityValue(current.value);
    } catch {
      throw new CloudDeploymentAuthorityError(
        "stale_authority",
        "Cloud deployment authority is not current.",
      );
    }
  }

  scopeCustodySlot(slot: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(slot)) throw new Error("Invalid cloud custody slot.");
    if (slot === deploymentAuthoritySlot || this.#custodyMode === "legacy") return slot;
    const namespace = createHash("sha256")
      .update(`hra-control-plane-cloud-deployment-custody:v1:${this.#bindingId}:${slot}`)
      .digest("hex")
      .slice(0, 48);
    return `d-${namespace}`;
  }
}

export class DeploymentScopedCloudSecretCustody implements CloudSecretCustodyPort {
  readonly #authority: CloudDeploymentAuthority;
  readonly #custody: CloudSecretCustodyPort;

  constructor(custody: CloudSecretCustodyPort, authority: CloudDeploymentAuthority) {
    this.#authority = authority;
    this.#custody = custody;
  }

  get cacheNamespace(): string | null {
    return this.#authority.cacheNamespace;
  }

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    await this.#authority.assertCurrent();
    const observed = await this.#custody.read(this.#authority.scopeCustodySlot(slot));
    await this.#authority.assertCurrent();
    return observed;
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    await this.#authority.assertCurrent();
    const committed = await this.#custody.compareAndSwap(
      this.#authority.scopeCustodySlot(slot),
      expectedGeneration,
      value,
    );
    await this.#authority.assertCurrent();
    return committed;
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    await this.#authority.assertCurrent();
    const cleared = await this.#custody.clearIfGeneration(
      this.#authority.scopeCustodySlot(slot),
      expectedGeneration,
    );
    await this.#authority.assertCurrent();
    return cleared;
  }
}

async function hasLegacyUnboundCloudCustody(custody: CloudSecretCustodyPort): Promise<boolean> {
  for (const slot of legacyCloudSlots) {
    if (await custody.read(slot) !== null) return true;
  }
  return false;
}

export async function acquireCloudDeploymentAuthority(
  custody: CloudSecretCustodyPort,
  selection: Extract<CloudDeploymentSelection, { kind: "enabled" }>,
): Promise<CloudDeploymentAuthority> {
  const deploymentUrl = canonicalCloudDeploymentUrl(selection.deploymentUrl);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await custody.read(deploymentAuthoritySlot);
    if (current !== null) {
      const parsed = parseDeploymentAuthorityValue(current.value);
      if (parsed.deploymentUrl !== deploymentUrl) {
        throw new CloudDeploymentAuthorityError(
          "target_mismatch",
          "Cloud deployment authority is bound to another deployment.",
        );
      }
      return new ExactCloudDeploymentAuthority(custody, current, parsed);
    }
    const hasLegacyCustody = await hasLegacyUnboundCloudCustody(custody);
    if (!selection.explicit && hasLegacyCustody) {
      throw new CloudDeploymentAuthorityError(
        "legacy_binding_required",
        "Legacy cloud custody requires an explicit HRA_CONVEX_URL before deployment binding.",
      );
    }
    const value = {
      bindingId: `binding_${crypto.randomUUID().replaceAll("-", "")}`,
      custodyMode: selection.explicit && hasLegacyCustody ? "legacy" : "scoped",
      deploymentUrl,
      version: 1,
    } satisfies CloudDeploymentAuthorityValue;
    const serialized = JSON.stringify(value);
    const committed = await custody.compareAndSwap(deploymentAuthoritySlot, null, serialized);
    if (committed !== null) {
      return new ExactCloudDeploymentAuthority(custody, committed, value);
    }
  }
  throw new CloudDeploymentAuthorityError(
    "concurrent_change",
    "Cloud deployment authority changed concurrently.",
  );
}

export async function cloudDeploymentAuthorityFromEnvironment(
  custody: CloudSecretCustodyPort,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CloudDeploymentAuthority | null> {
  const selection = cloudDeploymentSelectionFromEnvironment(environment);
  return selection.kind === "disabled"
    ? null
    : await acquireCloudDeploymentAuthority(custody, selection);
}

export async function readCloudDeploymentAuthority(
  custody: CloudSecretCustodyPort,
): Promise<CloudDeploymentAuthority | null> {
  const current = await custody.read(deploymentAuthoritySlot);
  if (current === null) return null;
  return new ExactCloudDeploymentAuthority(
    custody,
    current,
    parseDeploymentAuthorityValue(current.value),
  );
}

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
  readonly #activeIdentity: Readonly<{
    generation: number;
    serialized: string;
    userPublicId: string;
  }> | null;
  readonly #custody: CloudSecretCustodyPort;

  private constructor(
    custody: CloudSecretCustodyPort,
    activeIdentity: Readonly<{ generation: number; value: string }> | null,
  ) {
    this.#activeIdentity = activeIdentity === null
      ? null
      : {
          generation: activeIdentity.generation,
          serialized: activeIdentity.value,
          userPublicId: parseActiveIdentity(activeIdentity.value).userPublicId,
        };
    this.#custody = custody;
  }

  static async open(custody: CloudSecretCustodyPort): Promise<IdentityScopedCloudSecretCustody> {
    const observation = await custody.read(activeIdentitySlot);
    return new IdentityScopedCloudSecretCustody(custody, observation);
  }

  get activeUserPublicId(): string | null {
    return this.#activeIdentity?.userPublicId ?? null;
  }

  async assertCurrentIdentity(expectedUserPublicId: string | null): Promise<void> {
    if (expectedUserPublicId === null) {
      if (this.#activeIdentity !== null || await this.#custody.read(activeIdentitySlot) !== null) {
        throw new Error("Cloud identity selection changed; restart HRA.");
      }
      return;
    }
    if (
      !isOpaqueIdentifier(expectedUserPublicId)
      || this.#activeIdentity?.userPublicId !== expectedUserPublicId
    ) throw new Error("Cloud identity selection changed; restart HRA.");
    const current = await this.#custody.read(activeIdentitySlot);
    if (
      current === null
      || current.generation !== this.#activeIdentity.generation
      || current.value !== this.#activeIdentity.serialized
      || parseActiveIdentity(current.value).userPublicId !== expectedUserPublicId
    ) throw new Error("Cloud identity selection changed; restart HRA.");
  }

  get cacheNamespace(): string | null {
    if (this.activeUserPublicId === null) return null;
    const identityNamespace = namespaceFor(this.activeUserPublicId);
    const deploymentNamespace = this.#custody instanceof DeploymentScopedCloudSecretCustody
      ? this.#custody.cacheNamespace
      : null;
    return deploymentNamespace === null
      ? identityNamespace
      : createHash("sha256")
          .update(`hra-control-plane-cloud-cache:v1:${deploymentNamespace}:${identityNamespace}`)
          .digest("hex")
          .slice(0, 24);
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
            restartRequired: this.activeUserPublicId !== userPublicId,
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
          restartRequired: this.activeUserPublicId !== userPublicId,
          userPublicId,
        };
      }
    }
    throw new Error("Cloud identity selector changed concurrently.");
  }

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    await this.#assertGenerationFencedSlotCurrent(slot);
    const physical = this.#physicalSlot(slot);
    const observed = physical === null ? null : await this.#custody.read(physical);
    await this.#assertGenerationFencedSlotCurrent(slot);
    return observed;
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    await this.#assertGenerationFencedSlotCurrent(slot);
    const physical = this.#physicalSlot(slot);
    if (physical === null) {
      throw new Error("Cloud identity selection requires a daemon restart.");
    }
    const committed = await this.#custody.compareAndSwap(physical, expectedGeneration, value);
    await this.#assertGenerationFencedSlotCurrent(slot);
    return committed;
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    await this.#assertGenerationFencedSlotCurrent(slot);
    const physical = this.#physicalSlot(slot);
    const cleared = physical === null
      ? false
      : await this.#custody.clearIfGeneration(physical, expectedGeneration);
    await this.#assertGenerationFencedSlotCurrent(slot);
    return cleared;
  }

  async #assertGenerationFencedSlotCurrent(slot: string): Promise<void> {
    if (!identityGenerationFencedSlots.has(slot)) return;
    await this.assertCurrentIdentity(this.activeUserPublicId);
  }

  #physicalSlot(slot: string): string | null {
    if (!scopedSlots.has(slot)) return slot;
    if (this.activeUserPublicId === null) return null;
    const identityNamespace = namespaceFor(this.activeUserPublicId);
    if (slot === attentionNotificationReconciliationSlot) {
      const slotNamespace = createHash("sha256")
        .update(`hra-control-plane-cloud-identity-slot:v1:${slot}`)
        .digest("hex")
        .slice(0, 32);
      return `i-${identityNamespace}-s-${slotNamespace}`;
    }
    return `i-${identityNamespace}-${slot}`;
  }
}

export function isIdentityScopedCloudCustody(
  custody: CloudSecretCustodyPort,
): custody is IdentityScopedCloudSecretCustody {
  return custody instanceof IdentityScopedCloudSecretCustody;
}
