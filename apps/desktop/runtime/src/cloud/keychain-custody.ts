import {
  GenerationalSecretCustody,
  HRA_HUMAN_KEYCHAIN_SERVICE,
  humanAuthenticationSchema,
  humanAuthenticationSnapshotSchema,
  humanProfileSchema,
  profileFromHumanAuthentication,
  secretCustodyJournalSchema,
  SecretCustodyError,
  SecretStoreAccessDeniedError,
  type HumanAuthentication,
  type HumanAuthenticationSnapshot,
  type HumanAuthenticationStore,
  type HumanProfile,
  type SecretCustodyJournal,
  type SecretCustodyMetadataStore,
  type SecretCustodyReconnectInspection,
  type SecretCustodyReconnectRecovery,
  type SecretCustodyRecovery,
  type SecretCustodyRecoveryCandidateInspection,
  type SecretCustodyRecoveryToken,
  type SecretStore,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";
import { randomBytes } from "node:crypto";

export const HRA_HUMAN_KEYCHAIN_NAME = "primary";
const MAX_METADATA_CAS_ATTEMPTS = 8;
const credentialGenerationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const humanAccountMetadataSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    credentialGeneration: credentialGenerationSchema,
    profile: humanProfileSchema.nullable(),
    credentialRecoveryPending: z.literal(true).optional(),
  })
  .strict();
export type HumanAccountMetadata = z.infer<typeof humanAccountMetadataSchema>;

export const legacyHumanAccountMetadataReferenceSchema = z
  .object({
    state: z.literal("legacy_profile"),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    credentialGeneration: credentialGenerationSchema,
  })
  .strict();
export type LegacyHumanAccountMetadataReference = z.infer<
  typeof legacyHumanAccountMetadataReferenceSchema
>;

export class LegacyHumanAccountMetadataError extends Error {
  constructor() {
    super("Legacy human account metadata requires explicit recovery.");
    this.name = "LegacyHumanAccountMetadataError";
  }
}

/**
 * SQLite owns the implementation. Both values are token-free and each CAS must
 * execute in one transaction. The custody journal must be stored verbatim.
 */
export interface HumanAccountMetadataPort extends SecretCustodyMetadataStore {
  readAccountMetadata(): Promise<unknown>;
  compareAndSwapAccountMetadata(input: {
    readonly expectedRevision: number | null;
    readonly next: HumanAccountMetadata;
  }): Promise<boolean>;
}

const legacyKeychainAccessDeniedSuffix = /\(code:\s*-25293\)\s*$/u;

export function isLegacyKeychainIdentityAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { readonly code?: unknown };
  const code = Object.prototype.hasOwnProperty.call(error, "code")
    ? candidate.code
    : undefined;
  return code === "ERR_SECRETS_AUTH_FAILED" &&
    legacyKeychainAccessDeniedSuffix.test(error.message);
}

export const bunHumanKeychain: SecretStore = {
  get: async (input) => {
    try {
      return await Bun.secrets.get(input);
    } catch (error: unknown) {
      if (isLegacyKeychainIdentityAccessDenied(error)) {
        throw new SecretStoreAccessDeniedError();
      }
      throw error;
    }
  },
  set: async (input) => {
    await Bun.secrets.set(input);
  },
  delete: async (input) => await Bun.secrets.delete(input),
};

export function createOpaqueHumanSecretSlot(): string {
  return `human_${randomBytes(24).toString("base64url")}`;
}

export type HumanCredentialRecoveryCandidateInspection =
  | Exclude<SecretCustodyRecoveryCandidateInspection, { state: "valid" }>
  | Readonly<{
      state: "product_invalid";
      role: "committed" | "pending";
      sourceRevision: number;
      token: SecretCustodyRecoveryToken;
    }>
  | Readonly<{
      state: "valid";
      role: "committed" | "pending";
      sourceRevision: number;
      snapshot: HumanAuthenticationSnapshot;
      token: SecretCustodyRecoveryToken;
    }>;

export interface HumanCredentialClearAuthority {
  readonly sourceRevision: number | null;
  readonly identities: readonly Readonly<{
    apiUrl: string;
    userId: string;
    organizationId?: string;
  }>[];
  readonly hasUnrecognizedValue: boolean;
}

export interface HumanScopeSelectionCustodyAuthority {
  readonly sourceRevision: number;
  readonly generation: number;
  readonly apiUrl: string;
  readonly userId: string;
}

export type HumanScopeSelectionContainment =
  | SecretCustodyReconnectRecovery
  | Readonly<{
      state: "newer_winner";
      snapshot: HumanAuthenticationSnapshot;
    }>;

export class HumanCredentialCustody implements HumanAuthenticationStore {
  readonly #custody: GenerationalSecretCustody;

  constructor(options: {
    readonly metadata: SecretCustodyMetadataStore;
    readonly secrets?: SecretStore;
    readonly nextSlot?: () => string;
  }) {
    this.#custody = new GenerationalSecretCustody({
      descriptor: {
        service: HRA_HUMAN_KEYCHAIN_SERVICE,
        name: HRA_HUMAN_KEYCHAIN_NAME,
      },
      metadata: options.metadata,
      secrets: options.secrets ?? bunHumanKeychain,
      nextSlot: options.nextSlot ?? createOpaqueHumanSecretSlot,
      requireExplicitPendingRecovery: true,
    });
  }

  async recover(
    options: {
      readonly abandonMissingPending: boolean;
      readonly candidate?: SecretCustodyRecoveryToken;
      readonly deferDeletingCleanup?: boolean;
    },
  ): Promise<SecretCustodyRecovery> {
    return await this.#custody.recover(options);
  }

  async inspectRecoveryAuthenticationCandidate(): Promise<
    HumanCredentialRecoveryCandidateInspection
  > {
    const inspected = await this.#custody.inspectRecoveryCandidate();
    if (inspected.state !== "valid") return inspected;
    const authentication = parseHumanAuthentication(inspected.value);
    if (authentication === null) {
      return {
        state: "product_invalid",
        role: inspected.role,
        sourceRevision: inspected.sourceRevision,
        token: inspected.token,
      };
    }
    return {
      state: "valid",
      role: inspected.role,
      sourceRevision: inspected.sourceRevision,
      token: inspected.token,
      snapshot: humanAuthenticationSnapshotSchema.parse({
        generation: inspected.pointer.generation,
        authentication,
      }),
    };
  }

  async inspectLegacyIdentityReconnect(): Promise<SecretCustodyReconnectInspection> {
    const inspected = await this.#custody.inspectLegacyIdentityReconnect();
    if (inspected.state === "required") return inspected;
    const anomalies = await this.#custody.inspectPointerAnomalies();
    if (anomalies.state === "required") {
      return {
        state: "required",
        inaccessiblePointerCount: anomalies.anomalousPointerCount,
      };
    }
    const committed = await this.#custody.inspectCommittedForRecovery();
    return committed.state === "missing" || committed.state === "invalid" ||
        (committed.state === "valid" &&
          parseHumanAuthentication(committed.value) === null)
      ? { state: "required", inaccessiblePointerCount: 1 }
      : { state: "not_required" };
  }

  async quarantineLegacyIdentityPointers(options: {
    readonly candidate?: SecretCustodyRecoveryToken;
  } = {}): Promise<SecretCustodyReconnectRecovery> {
    let recovered = await this.#custody.quarantineLegacyIdentityPointers(
      options,
    );
    if (recovered.state === "not_required") {
      recovered = await this.#custody.preservePointerAnomalies(options);
    }
    if (recovered.state === "quarantined") return recovered;
    const committed = await this.#custody.inspectCommittedForRecovery();
    if (
      committed.state === "empty" || committed.state === "inaccessible" ||
      (committed.state === "valid" &&
        parseHumanAuthentication(committed.value) !== null)
    ) {
      return { state: "not_required" };
    }
    return await this.#custody.preserveCommittedForRecovery(
      committed,
      committed.state === "missing"
        ? "missing_pointer_abandoned"
        : "invalid_pointer_preserved",
      options,
    );
  }

  async preserveRejectedPendingCandidate(
    token: SecretCustodyRecoveryToken,
  ): Promise<SecretCustodyReconnectRecovery> {
    return await this.#custody.preserveInspectedPendingForRecovery(token);
  }

  /**
   * Retire an indeterminate rotated session from live custody without deleting
   * any Keychain value. Every readable live value must still belong to the
   * exact API/user authority that initiated the server-side rotation. A
   * malformed committed value fails closed for explicit recovery; a malformed
   * pending value is allowed only alongside that exact readable committed
   * predecessor, which is the pre-Keychain failure shape of a local CAS.
   */
  async inspectScopeSelectionAuthority(
    snapshot: HumanAuthenticationSnapshot,
  ): Promise<HumanScopeSelectionCustodyAuthority> {
    const inspected = await this.#custody.inspectLiveValues();
    const committed = inspected.values.find(
      (value) => value.role === "committed",
    );
    const authentication = committed?.state === "valid"
      ? parseHumanAuthentication(committed.value)
      : null;
    if (
      inspected.sourceRevision === null || committed === undefined ||
      authentication === null ||
      committed.pointer.generation !== snapshot.generation ||
      JSON.stringify(authentication) !== JSON.stringify(snapshot.authentication)
    ) {
      throw new SecretCustodyError("concurrent_update");
    }
    return {
      sourceRevision: inspected.sourceRevision,
      generation: snapshot.generation,
      apiUrl: snapshot.authentication.apiUrl,
      userId: snapshot.authentication.user.id,
    };
  }

  async preserveIndeterminateScopeSession(options: {
    readonly authority: HumanScopeSelectionCustodyAuthority;
    readonly candidate?: HumanAuthenticationSnapshot;
  }): Promise<HumanScopeSelectionContainment> {
    const inspected = await this.#custody.inspectLiveValues();
    const committed = inspected.values.find(
      (value) => value.role === "committed",
    );
    const committedAuthentication = committed?.state === "valid"
      ? parseHumanAuthentication(committed.value)
      : null;
    if (
      committed !== undefined &&
      committed.pointer.generation > options.authority.generation
    ) {
      if (inspected.values.some((value) => value.role === "pending")) {
        throw new SecretCustodyError("concurrent_update");
      }
      if (committedAuthentication === null) {
        throw new SecretCustodyError("concurrent_update");
      }
      if (
        committedAuthentication.apiUrl !== options.authority.apiUrl ||
        committedAuthentication.user.id !== options.authority.userId
      ) {
        throw new SecretCustodyError("concurrent_update");
      }
      const snapshot = humanAuthenticationSnapshotSchema.parse({
        generation: committed.pointer.generation,
        authentication: committedAuthentication,
      });
      if (
        options.candidate !== undefined &&
        JSON.stringify(snapshot) === JSON.stringify(options.candidate)
      ) {
        return await this.#custody.preserveLiveValuesForRecovery(inspected);
      }
      return { state: "newer_winner", snapshot };
    }

    let candidateObserved = false;
    for (const value of inspected.values) {
      if (value.state !== "valid") {
        if (
          value.role === "committed" || options.candidate === undefined ||
          value.pointer.generation !== options.candidate.generation
        ) {
          throw new SecretCustodyError("concurrent_update");
        }
        candidateObserved = true;
        continue;
      }
      const authentication = parseHumanAuthentication(value.value);
      if (
        authentication === null ||
        authentication.apiUrl !== options.authority.apiUrl ||
        authentication.user.id !== options.authority.userId
      ) {
        throw new SecretCustodyError("concurrent_update");
      }
      if (
        options.candidate !== undefined &&
        value.pointer.generation === options.candidate.generation &&
        JSON.stringify(authentication) ===
          JSON.stringify(options.candidate.authentication)
      ) {
        candidateObserved = true;
      }
    }
    const exactAuthorityRemains = committed !== undefined &&
      committed.pointer.generation === options.authority.generation &&
      committedAuthentication !== null &&
      committedAuthentication.apiUrl === options.authority.apiUrl &&
      committedAuthentication.user.id === options.authority.userId;
    if (
      !exactAuthorityRemains && !candidateObserved &&
      inspected.values.length > 0
    ) {
      throw new SecretCustodyError("concurrent_update");
    }
    if (
      inspected.sourceRevision !== options.authority.sourceRevision &&
      !candidateObserved
    ) {
      throw new SecretCustodyError("concurrent_update");
    }
    return await this.#custody.preserveLiveValuesForRecovery(inspected);
  }

  /**
   * Retire one exact committed authentication generation after a remote
   * credential rotation or pairing commit becomes indeterminate. This is the
   * HumanAuthenticationStore containment primitive: it preserves every live
   * Keychain byte and atomically removes the inspected pointers from bearer
   * admission only when the committed product payload still matches the
   * caller's exact generation.
   */
  async preserveForRecovery(input: {
    readonly expectedGeneration: number;
  }): Promise<boolean> {
    const inspected = await this.#custody.inspectLiveValues();
    const committed = inspected.values.find(
      (value) => value.role === "committed",
    );
    if (
      committed === undefined ||
      committed.pointer.generation !== input.expectedGeneration ||
      committed.state !== "valid" ||
      parseHumanAuthentication(committed.value) === null
    ) {
      return false;
    }
    const recovery = await this.#custody.preserveLiveValuesForRecovery(
      inspected,
    );
    return recovery.state === "quarantined";
  }

  /**
   * A durable pairing intent proves these pointers were created by the local
   * pairing commit that must now be recovered explicitly. Preserve its exact
   * inspected inventory without promoting a pending value or deleting bytes.
   */
  async preserveMarkedCredentialForRecovery(
    expectedApiUrl?: string,
  ): Promise<SecretCustodyReconnectRecovery> {
    const inspected = await this.#custody.inspectLiveValues();
    for (const value of inspected.values) {
      if (value.state !== "valid") continue;
      const authentication = parseHumanAuthentication(value.value);
      if (
        authentication === null ||
        (expectedApiUrl !== undefined &&
          authentication.apiUrl !== expectedApiUrl)
      ) {
        throw new SecretCustodyError("concurrent_update");
      }
    }
    return await this.#custody.preserveLiveValuesForRecovery(inspected);
  }

  async inspectClearAuthority(): Promise<HumanCredentialClearAuthority> {
    const inspected = await this.#custody.inspectLiveValues();
    const identities: Array<{
      apiUrl: string;
      userId: string;
      organizationId?: string;
    }> = [];
    let hasUnrecognizedValue = false;
    for (const value of inspected.values) {
      const authentication = value.state === "valid"
        ? parseHumanAuthentication(value.value)
        : null;
      if (authentication === null) {
        hasUnrecognizedValue = true;
        continue;
      }
      const organizationId = authentication.organization?.id;
      identities.push({
        apiUrl: authentication.apiUrl,
        userId: authentication.user.id,
        ...(organizationId === undefined ? {} : { organizationId }),
      });
    }
    return {
      sourceRevision: inspected.sourceRevision,
      identities,
      hasUnrecognizedValue,
    };
  }

  async read(): Promise<HumanAuthenticationSnapshot | null> {
    const stored = await this.#custody.read();
    if (stored === null) return null;
    const authentication = parseHumanAuthentication(stored.value);
    if (authentication === null) {
      throw new Error("Human credential custody is invalid.");
    }
    return humanAuthenticationSnapshotSchema.parse({
      generation: stored.generation,
      authentication,
    });
  }

  async write(
    authenticationValue: HumanAuthentication,
  ): Promise<HumanAuthenticationSnapshot> {
    const authentication = humanAuthenticationSchema.parse(authenticationValue);
    const pointer = await this.#custody.write(JSON.stringify(authentication));
    return {
      generation: pointer.generation,
      authentication,
    };
  }

  async compareAndSwap(input: {
    readonly expectedGeneration: number;
    readonly next: HumanAuthenticationSnapshot;
  }): Promise<HumanAuthenticationSnapshot | null> {
    const next = humanAuthenticationSnapshotSchema.parse(input.next);
    if (next.generation !== input.expectedGeneration + 1) return null;
    const pointer = await this.#custody.compareAndSwap(
      input.expectedGeneration,
      JSON.stringify(next.authentication),
    );
    return pointer === null
      ? null
      : humanAuthenticationSnapshotSchema.parse({
          generation: pointer.generation,
          authentication: next.authentication,
        });
  }

  async clear(input: {
    readonly expectedGeneration: number;
    readonly onJournaled?: () => Promise<void>;
  }): Promise<boolean> {
    return await this.#custody.clearIfGeneration(
      input.expectedGeneration,
      input.onJournaled === undefined
        ? {}
        : { onJournaled: input.onJournaled },
    );
  }

  /** User-authorized sign-out removes committed and interrupted pending state. */
  async clearAllIfSourceRevision(
    expectedSourceRevision: number | null,
  ): Promise<boolean> {
    return await this.#custody.clearIfSourceRevision(expectedSourceRevision);
  }
}

function parseHumanAuthentication(value: string): HumanAuthentication | null {
  let source: unknown;
  try {
    source = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  const authentication = humanAuthenticationSchema.safeParse(source);
  return authentication.success ? authentication.data : null;
}

function tokenFreeProfile(
  authentication: HumanAuthentication,
): HumanProfile {
  return profileFromHumanAuthentication(authentication, "keychain");
}

/**
 * Reconcile token-free SQLite state from the committed Keychain generation.
 * The credential is the authority; a crash between the two stores is repaired
 * without copying either bearer token into metadata.
 */
export async function reconcileHumanAccountMetadata(
  store: HumanAccountMetadataPort,
  snapshot: HumanAuthenticationSnapshot | null,
  options: { readonly replaceLegacyProfile?: boolean } = {},
): Promise<HumanAccountMetadata> {
  const profile = snapshot === null
    ? null
    : tokenFreeProfile(snapshot.authentication);
  for (let attempt = 0; attempt < MAX_METADATA_CAS_ATTEMPTS; attempt += 1) {
    const source = await store.readAccountMetadata();
    const parsed = source === null
      ? null
      : humanAccountMetadataSchema.safeParse(source);
    const legacy = source === null || parsed?.success
      ? null
      : legacyHumanAccountMetadataReferenceSchema.safeParse(source);
    if (parsed !== null && !parsed.success && (legacy === null || !legacy.success)) {
      throw new Error("Human account metadata is invalid.");
    }
    const current = parsed?.data ?? null;
    const legacyCurrent = legacy?.success === true ? legacy.data : null;
    if (
      legacyCurrent !== null &&
      options.replaceLegacyProfile !== true
    ) {
      throw new LegacyHumanAccountMetadataError();
    }
    const currentRevision = current?.revision ?? legacyCurrent?.revision ?? null;
    const currentCredentialGeneration = current?.credentialGeneration ??
      legacyCurrent?.credentialGeneration;
    if (
      snapshot !== null &&
      currentCredentialGeneration !== undefined &&
      currentCredentialGeneration > snapshot.generation
    ) {
      throw new Error("Human credential generation moved backwards.");
    }
    const credentialGeneration = snapshot?.generation ??
      currentCredentialGeneration ??
      0;
    if (
      current !== null &&
      current.credentialRecoveryPending !== true &&
      current.credentialGeneration === credentialGeneration &&
      JSON.stringify(current.profile) === JSON.stringify(profile)
    ) {
      return current;
    }
    const next = humanAccountMetadataSchema.parse({
      version: 1,
      revision: (currentRevision ?? -1) + 1,
      credentialGeneration,
      profile,
    });
    if (
      await store.compareAndSwapAccountMetadata({
        expectedRevision: currentRevision,
        next,
      })
    ) {
      return next;
    }
  }
  throw new Error("Human account metadata changed concurrently.");
}

/**
 * Record a token-free, restart-durable intent before a pairing write or after
 * exact refresh containment cannot be proven. Normal metadata reconciliation
 * clears the marker. If the process stops mid-recovery, startup requires an
 * explicit quarantine decision instead of silently adopting the credential.
 */
export async function markHumanCredentialRecoveryPending(
  store: HumanAccountMetadataPort,
): Promise<HumanAccountMetadata> {
  for (let attempt = 0; attempt < MAX_METADATA_CAS_ATTEMPTS; attempt += 1) {
    const source = await store.readAccountMetadata();
    const parsed = source === null
      ? null
      : humanAccountMetadataSchema.safeParse(source);
    if (parsed !== null && !parsed.success) {
      throw new LegacyHumanAccountMetadataError();
    }
    const current = parsed?.data ?? null;
    if (current?.credentialRecoveryPending === true) return current;
    const next = humanAccountMetadataSchema.parse({
      version: 1,
      revision: (current?.revision ?? -1) + 1,
      credentialGeneration: current?.credentialGeneration ?? 0,
      profile: current?.profile ?? null,
      credentialRecoveryPending: true,
    });
    if (
      await store.compareAndSwapAccountMetadata({
        expectedRevision: current?.revision ?? null,
        next,
      })
    ) {
      return next;
    }
  }
  throw new Error("Human account metadata changed concurrently.");
}

export async function isHumanCredentialRecoveryPending(
  store: HumanAccountMetadataPort,
): Promise<boolean> {
  const source = await store.readAccountMetadata();
  if (source === null) return false;
  const parsed = humanAccountMetadataSchema.safeParse(source);
  if (!parsed.success) {
    if (legacyHumanAccountMetadataReferenceSchema.safeParse(source).success) {
      return false;
    }
    throw new Error("Human account metadata is invalid.");
  }
  return parsed.data.credentialRecoveryPending === true;
}

export function parseSecretCustodyJournal(
  value: unknown,
): SecretCustodyJournal | null {
  if (value === null) return null;
  return secretCustodyJournalSchema.parse(value);
}
