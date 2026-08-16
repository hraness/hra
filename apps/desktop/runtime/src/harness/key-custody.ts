import {
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  contextValueIdSchema,
  ownedThreadIdSchema,
} from "./domain";

export const HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE =
  "com.0thernet.oprte.context-heap.v1";
export const HRA_HARNESS_KEYCHAIN_SERVICE =
  "com.0thernet.oprte.context-heap.v2";
export const HRA_HARNESS_KEYCHAIN_NAME = "installation-master";
export const HRA_HARNESS_RECONCILIATION_KEYCHAIN_NAME =
  "legacy-reconciliation";
export const HARNESS_INSTALL_MASTER_KEY_BYTES = 32;
export const HARNESS_ROOT_KEY_BYTES = 32;
export const HARNESS_CONTEXT_SCOPE_KEY_BYTES = 32;
export const HARNESS_CONTEXT_DIGEST_KEY_BYTES = 32;
export const HARNESS_CONTEXT_VALUE_KEY_BYTES = 32;

const base64UrlSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u);
const installKeyEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("hkdf-sha256"),
  key: base64UrlSchema,
}).strict();

const contextValueKeyIdentitySchema = z.object({
  version: z.literal(2),
  operationId: z.string().min(16).max(128)
    .regex(/^[A-Za-z][A-Za-z0-9_-]{15,127}$/u),
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: z.enum(["text", "json", "selection", "agentResult"]),
  purpose: z.enum([
    "heap",
    "completedPrefix",
    "currentInput",
    "agentResult",
    "proposal",
    "actorTask",
    "programSource",
    "programResult",
  ]),
  schemaVersion: z.literal(1),
  nameDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  utf8Bytes: z.number().int().nonnegative()
    .max(HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((identity, context) => {
  if (
    identity.purpose !== "completedPrefix" &&
    identity.utf8Bytes > HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "context-value identity exceeds its purpose-specific byte limit",
      path: ["utf8Bytes"],
    });
  }
  if (identity.purpose === "completedPrefix" && identity.kind !== "selection") {
    context.addIssue({
      code: "custom",
      message: "completed-prefix identities must use the selection kind",
      path: ["kind"],
    });
  }
});

export type HarnessContextValueKeyIdentity = z.infer<
  typeof contextValueKeyIdentitySchema
>;

export type HarnessKeyCustodyErrorCode =
  | "custody_unavailable"
  | "custody_deleted"
  | "custody_delete_reentrant"
  | "invalid_install_key"
  | "key_generation_failed";

/** Fixed messages ensure Keychain payloads never enter diagnostics. */
export class HarnessKeyCustodyError extends Error {
  readonly code: HarnessKeyCustodyErrorCode;

  constructor(code: HarnessKeyCustodyErrorCode) {
    super({
      custody_unavailable: "The Context Heap key is unavailable.",
      custody_deleted: "The Context Heap key custody has been deleted.",
      custody_delete_reentrant: "Context Heap key deletion cannot run inside a key operation.",
      invalid_install_key: "The Context Heap key is invalid.",
      key_generation_failed: "The Context Heap key could not be generated.",
    }[code]);
    this.name = "HarnessKeyCustodyError";
    this.code = code;
  }
}

export interface HarnessSecretDescriptor {
  readonly name: string;
  readonly service: string;
}

export interface HarnessSecretStore {
  get(input: HarnessSecretDescriptor): Promise<string | null>;
  set(input: HarnessSecretDescriptor & { readonly value: string }): Promise<void>;
  delete(input: HarnessSecretDescriptor): Promise<boolean>;
}

export const harnessContextKeyScopeSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
}).strict();

export type HarnessContextKeyScope = z.infer<
  typeof harnessContextKeyScopeSchema
>;

export interface HarnessContextKeyProvider {
  withContextKey<T>(
    scope: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T>;
}

/** Compatibility boundary for the unreleased root-thread heap and payloads. */
export interface HarnessRootKeyProvider {
  withRootKey<T>(
    rootThreadId: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T>;
}

const unavailableHarnessKeychain: HarnessSecretStore = {
  get: () => Promise.reject(new HarnessKeyCustodyError("custody_unavailable")),
  set: () => Promise.reject(new HarnessKeyCustodyError("custody_unavailable")),
  delete: () => Promise.reject(new HarnessKeyCustodyError("custody_unavailable")),
};

export const harnessInstallKeyDescriptor: HarnessSecretDescriptor =
  Object.freeze({
    service: HRA_HARNESS_KEYCHAIN_SERVICE,
    name: HRA_HARNESS_KEYCHAIN_NAME,
  });

export const harnessLegacyInstallKeyDescriptor: HarnessSecretDescriptor =
  Object.freeze({
    service: HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE,
    name: HRA_HARNESS_KEYCHAIN_NAME,
  });

export interface HarnessInstallKeyCustodyOptions {
  readonly secrets?: HarnessSecretStore;
  readonly randomMaster?: () => Uint8Array;
}

/**
 * Holds the only installation master in Keychain. Callers receive a key bound
 * to one durable epoch, owning actor, and nullable source turn for the duration
 * of one callback. Decoded master and derived key buffers are overwritten
 * before the callback settles.
 */
export class HarnessInstallKeyCustody
  implements HarnessContextKeyProvider, HarnessRootKeyProvider {
  readonly #randomMaster: () => Uint8Array;
  readonly #secrets: HarnessSecretStore;
  #generation = 1;
  #lifecycle: "active" | "deleting" | "deleted" = "active";
  #deletePending: Promise<boolean> | null = null;
  #quiescePending: Promise<void> | null = null;
  #masterLoad: {
    readonly generation: number;
    readonly pending: Promise<Uint8Array>;
    borrowers: number;
  } | null = null;
  readonly #pendingMasterLoads = new Set<Promise<Uint8Array>>();
  readonly #activeContextKeys = new Set<Uint8Array>();
  readonly #borrowerContext = new AsyncLocalStorage<number>();
  #borrowersDrained: Promise<void> | null = null;
  #resolveBorrowersDrained: (() => void) | null = null;

  constructor(options: HarnessInstallKeyCustodyOptions = {}) {
    this.#randomMaster = options.randomMaster ??
      (() => randomBytes(HARNESS_INSTALL_MASTER_KEY_BYTES));
    this.#secrets = options.secrets ?? unavailableHarnessKeychain;
  }

  async withContextKey<T>(
    scopeValue: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    const scope = harnessContextKeyScopeSchema.parse(scopeValue);
    const generation = this.#requireActiveGeneration();
    const master = await this.#loadOrCreateMaster(generation);
    this.#assertActiveGeneration(generation, master);
    let contextKey: Uint8Array;
    try {
      contextKey = deriveHarnessContextScopeKey(master, scope);
    } finally {
      master.fill(0);
    }
    this.#assertActiveGeneration(generation, contextKey);
    this.#activeContextKeys.add(contextKey);
    try {
      return await this.#borrowerContext.run(
        generation,
        async () => await operation(contextKey),
      );
    } finally {
      contextKey.fill(0);
      this.#activeContextKeys.delete(contextKey);
      if (this.#activeContextKeys.size === 0) {
        this.#resolveBorrowersDrained?.();
        this.#borrowersDrained = null;
        this.#resolveBorrowersDrained = null;
      }
    }
  }

  async withRootKey<T>(
    rootThreadIdValue: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    const rootThreadId = ownedThreadIdSchema.parse(rootThreadIdValue);
    const generation = this.#requireActiveGeneration();
    const master = await this.#loadOrCreateMaster(generation);
    this.#assertActiveGeneration(generation, master);
    let rootKey: Uint8Array;
    try {
      rootKey = deriveHarnessRootKey(master, rootThreadId);
    } finally {
      master.fill(0);
    }
    this.#assertActiveGeneration(generation, rootKey);
    this.#activeContextKeys.add(rootKey);
    try {
      return await this.#borrowerContext.run(
        generation,
        async () => await operation(rootKey),
      );
    } finally {
      rootKey.fill(0);
      this.#activeContextKeys.delete(rootKey);
      if (this.#activeContextKeys.size === 0) {
        this.#resolveBorrowersDrained?.();
        this.#borrowersDrained = null;
        this.#resolveBorrowersDrained = null;
      }
    }
  }

  async exists(): Promise<boolean> {
    if (this.#lifecycle === "deleted") return false;
    if (this.#lifecycle === "deleting") {
      await this.#deletePending;
      return false;
    }
    const stored = await this.#get();
    if (stored === null) return false;
    const key = parseInstallMaster(stored);
    key.fill(0);
    return true;
  }

  async delete(): Promise<boolean> {
    if (this.#borrowerContext.getStore() !== undefined) {
      throw new HarnessKeyCustodyError("custody_delete_reentrant");
    }
    if (this.#lifecycle === "deleted") return false;
    if (this.#deletePending !== null) return await this.#deletePending;

    const deletion = this.#deleteAfterQuiesce();
    this.#deletePending = deletion;
    try {
      return await deletion;
    } finally {
      if (this.#deletePending === deletion) this.#deletePending = null;
    }
  }

  /**
   * Fences creators and borrowers before a separately authenticated native
   * removal flow deletes the fixed Keychain descriptor. The current custody
   * instance remains permanently closed even if that later removal fails.
   */
  async quiesceForExternalDeletion(): Promise<void> {
    if (this.#borrowerContext.getStore() !== undefined) {
      throw new HarnessKeyCustodyError("custody_delete_reentrant");
    }
    if (this.#lifecycle === "deleted") return;
    if (this.#quiescePending !== null) return await this.#quiescePending;
    if (this.#lifecycle === "deleting") return;

    this.#lifecycle = "deleting";
    this.#generation += 1;
    this.#masterLoad = null;
    for (const contextKey of this.#activeContextKeys) contextKey.fill(0);
    const borrowersDrained = this.#waitForBorrowersToDrain();
    const loads = [...this.#pendingMasterLoads];
    const quiescing = this.#finishQuiesce(loads, borrowersDrained);
    this.#quiescePending = quiescing;
    try {
      await quiescing;
    } finally {
      if (this.#quiescePending === quiescing) this.#quiescePending = null;
    }
  }

  readonly #loadOrCreateMaster = async (
    generation: number,
  ): Promise<Uint8Array> => {
    // Serialize the read/create/read-back sequence inside the gateway. The
    // process-wide control-plane lifetime lock excludes a second writer.
    const load = this.#masterLoad?.generation === generation
      ? this.#masterLoad
      : {
      generation,
      pending: this.#trackMasterLoad(this.#loadOrCreateMasterOnce(generation)),
      borrowers: 0,
    };
    this.#masterLoad = load;
    load.borrowers += 1;
    let authoritative: Uint8Array | null = null;
    try {
      authoritative = await load.pending;
      this.#assertActiveGeneration(generation, authoritative);
      return Uint8Array.from(authoritative);
    } finally {
      load.borrowers -= 1;
      if (load.borrowers === 0 && this.#masterLoad === load) {
        authoritative?.fill(0);
        this.#masterLoad = null;
      }
    }
  };

  readonly #loadOrCreateMasterOnce = async (
    generation: number,
  ): Promise<Uint8Array> => {
    this.#assertActiveGeneration(generation);
    const existing = await this.#get();
    this.#assertActiveGeneration(generation);
    if (existing !== null) return parseInstallMaster(existing);

    let generated: Uint8Array;
    let generatedSource: Uint8Array | null = null;
    try {
      generatedSource = this.#randomMaster();
      generated = Uint8Array.from(generatedSource);
    } catch {
      throw new HarnessKeyCustodyError("key_generation_failed");
    } finally {
      generatedSource?.fill(0);
    }
    if (generated.byteLength !== HARNESS_INSTALL_MASTER_KEY_BYTES) {
      generated.fill(0);
      throw new HarnessKeyCustodyError("key_generation_failed");
    }
    const value = serializeHarnessInstallMaster(generated);
    try {
      this.#assertActiveGeneration(generation, generated);
      await this.#secrets.set({ ...harnessInstallKeyDescriptor, value });
    } catch (error: unknown) {
      generated.fill(0);
      if (
        error instanceof HarnessKeyCustodyError &&
        error.code === "custody_deleted"
      ) {
        throw error;
      }
      throw new HarnessKeyCustodyError("custody_unavailable");
    }
    generated.fill(0);

    // A delete may have fenced this creator while Keychain was committing the
    // value. The deletion path waits for this promise and removes that value
    // only after the creator can no longer write again.
    this.#assertActiveGeneration(generation);

    // Keychain is authoritative. Read back instead of trusting the attempted
    // write so an unexpected competing writer cannot split key custody.
    const committed = await this.#get();
    if (committed === null) {
      throw new HarnessKeyCustodyError("custody_unavailable");
    }
    return parseInstallMaster(committed);
  };

  #requireActiveGeneration(): number {
    if (this.#lifecycle !== "active") {
      throw new HarnessKeyCustodyError("custody_deleted");
    }
    return this.#generation;
  }

  #assertActiveGeneration(generation: number, secret?: Uint8Array): void {
    if (this.#lifecycle === "active" && this.#generation === generation) return;
    secret?.fill(0);
    throw new HarnessKeyCustodyError("custody_deleted");
  }

  #trackMasterLoad(pending: Promise<Uint8Array>): Promise<Uint8Array> {
    this.#pendingMasterLoads.add(pending);
    void pending.then(
      () => this.#pendingMasterLoads.delete(pending),
      () => this.#pendingMasterLoads.delete(pending),
    );
    return pending;
  }

  #waitForBorrowersToDrain(): Promise<void> {
    if (this.#activeContextKeys.size === 0) return Promise.resolve();
    if (this.#borrowersDrained === null) {
      this.#borrowersDrained = new Promise((resolve) => {
        this.#resolveBorrowersDrained = resolve;
      });
    }
    return this.#borrowersDrained;
  }

  readonly #finishQuiesce = async (
    loads: readonly Promise<Uint8Array>[],
    borrowersDrained: Promise<void>,
  ): Promise<void> => {
    await Promise.allSettled(loads);
    await borrowersDrained;
    for (const contextKey of this.#activeContextKeys) contextKey.fill(0);
  };

  readonly #deleteAfterQuiesce = async (): Promise<boolean> => {
    await this.quiesceForExternalDeletion();
    try {
      const deleted = await this.#secrets.delete(harnessInstallKeyDescriptor);
      this.#lifecycle = "deleted";
      return deleted;
    } catch {
      // Stay fenced. A later delete call may retry the exact descriptor, but
      // no borrower or creator can reactivate this custody instance.
      throw new HarnessKeyCustodyError("custody_unavailable");
    }
  };

  readonly #get = async (): Promise<string | null> => {
    try {
      const value = await this.#secrets.get(harnessInstallKeyDescriptor);
      return value;
    } catch {
      throw new HarnessKeyCustodyError("custody_unavailable");
    }
  };
}

export function deriveHarnessContextScopeKey(
  masterValue: unknown,
  scopeValue: unknown,
): Uint8Array {
  if (!(masterValue instanceof Uint8Array)) {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const master = Uint8Array.from(masterValue);
  if (master.byteLength !== HARNESS_INSTALL_MASTER_KEY_BYTES) {
    master.fill(0);
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const scope = harnessContextKeyScopeSchema.parse(scopeValue);
  const salt = createHash("sha256")
    .update("OPRTE Context Heap installation salt v2", "utf8")
    .digest();
  const info = Buffer.from(
    JSON.stringify({
      domain: "oprte-context-scope-key",
      version: 2,
      epochId: scope.epochId,
      ownerActorId: scope.ownerActorId,
      sourceTurnId: scope.sourceTurnId,
    }),
    "utf8",
  );
  let derived: Buffer | null = null;
  try {
    derived = Buffer.from(hkdfSync(
      "sha256",
      master,
      salt,
      info,
      HARNESS_CONTEXT_SCOPE_KEY_BYTES,
    ));
    return Uint8Array.from(derived);
  } finally {
    derived?.fill(0);
    master.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

/**
 * Legacy root-thread derivation retained as an explicit, domain-separated
 * compatibility path while v2 actor-scoped values use context keys. The two
 * formats share only the installation master, never a derived encryption key.
 */
export function deriveHarnessRootKey(
  masterValue: unknown,
  rootThreadIdValue: unknown,
): Uint8Array {
  if (!(masterValue instanceof Uint8Array)) {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const master = Uint8Array.from(masterValue);
  if (master.byteLength !== HARNESS_INSTALL_MASTER_KEY_BYTES) {
    master.fill(0);
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const rootThreadId = ownedThreadIdSchema.parse(rootThreadIdValue);
  const salt = createHash("sha256")
    .update("OPRTE Context Heap installation salt v1", "utf8")
    .digest();
  const info = Buffer.from(JSON.stringify({
    domain: "oprte-context-root-key",
    version: 1,
    rootThreadId,
  }), "utf8");
  let derived: Buffer | null = null;
  try {
    derived = Buffer.from(hkdfSync(
      "sha256",
      master,
      salt,
      info,
      HARNESS_ROOT_KEY_BYTES,
    ));
    return Uint8Array.from(derived);
  } finally {
    derived?.fill(0);
    master.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

/**
 * Derive a key for exactly one immutable context-value publication. The keyed
 * content digest and the complete semantic identity are both in HKDF info, so
 * deterministic record nonces can repeat across values without repeating a
 * nonce under the same AES key.
 */
export function deriveHarnessContextValueKey(
  contextKeyValue: unknown,
  identityValue: unknown,
): Uint8Array {
  if (!(contextKeyValue instanceof Uint8Array)) {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const contextKey = Uint8Array.from(contextKeyValue);
  if (contextKey.byteLength !== HARNESS_CONTEXT_SCOPE_KEY_BYTES) {
    contextKey.fill(0);
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const parsed = contextValueKeyIdentitySchema.safeParse(identityValue);
  if (!parsed.success) {
    contextKey.fill(0);
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const identity = parsed.data;
  const salt = createHash("sha256")
    .update("OPRTE context value encryption salt v3", "utf8")
    .digest();
  const info = Buffer.from(JSON.stringify({
    domain: "oprte-context-value-key",
    version: identity.version,
    operationId: identity.operationId,
    epochId: identity.epochId,
    ownerActorId: identity.ownerActorId,
    sourceTurnId: identity.sourceTurnId,
    valueId: identity.valueId,
    kind: identity.kind,
    purpose: identity.purpose,
    schemaVersion: identity.schemaVersion,
    nameDigest: identity.nameDigest,
    utf8Bytes: identity.utf8Bytes,
    contentDigest: identity.contentDigest,
  }), "utf8");
  let derived: Buffer | null = null;
  try {
    derived = Buffer.from(hkdfSync(
      "sha256",
      contextKey,
      salt,
      info,
      HARNESS_CONTEXT_VALUE_KEY_BYTES,
    ));
    return Uint8Array.from(derived);
  } finally {
    derived?.fill(0);
    contextKey.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

/** Use a purpose-specific HMAC key instead of the scoped key directly. */
export function deriveHarnessContextDigestKey(contextKeyValue: unknown): Uint8Array {
  if (!(contextKeyValue instanceof Uint8Array)) {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const contextKey = Uint8Array.from(contextKeyValue);
  if (contextKey.byteLength !== HARNESS_CONTEXT_SCOPE_KEY_BYTES) {
    contextKey.fill(0);
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const salt = createHash("sha256")
    .update("OPRTE context value digest salt v3", "utf8")
    .digest();
  const info = Buffer.from("OPRTE context value HMAC key v3", "utf8");
  let derived: Buffer | null = null;
  try {
    derived = Buffer.from(hkdfSync(
      "sha256",
      contextKey,
      salt,
      info,
      HARNESS_CONTEXT_DIGEST_KEY_BYTES,
    ));
    return Uint8Array.from(derived);
  } finally {
    derived?.fill(0);
    contextKey.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

export function serializeHarnessInstallMaster(key: Uint8Array): string {
  if (key.byteLength !== HARNESS_INSTALL_MASTER_KEY_BYTES) {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  return JSON.stringify({
    version: 1,
    algorithm: "hkdf-sha256",
    key: Buffer.from(key).toString("base64url"),
  });
}

export function canonicalHarnessInstallKeyEnvelope(value: unknown): string {
  const key = parseInstallMaster(value);
  try {
    return serializeHarnessInstallMaster(key);
  } finally {
    key.fill(0);
  }
}

function parseInstallMaster(value: unknown): Uint8Array {
  if (typeof value !== "string") {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  let source: unknown;
  try {
    source = JSON.parse(value) as unknown;
  } catch {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const parsed = installKeyEnvelopeSchema.safeParse(source);
  if (!parsed.success) {
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const decoded = Buffer.from(parsed.data.key, "base64url");
  if (
    decoded.byteLength !== HARNESS_INSTALL_MASTER_KEY_BYTES ||
    decoded.toString("base64url") !== parsed.data.key
  ) {
    decoded.fill(0);
    throw new HarnessKeyCustodyError("invalid_install_key");
  }
  const key = Uint8Array.from(decoded);
  decoded.fill(0);
  return key;
}
