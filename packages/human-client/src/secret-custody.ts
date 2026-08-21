import { z } from "@hra-internal/schema";

const MAX_SECRET_BYTES = 1 * 1_024 * 1_024;
const MAX_SECRET_ENVELOPE_BYTES = MAX_SECRET_BYTES + 1_024;
const MAX_CAS_ATTEMPTS = 8;
const MAX_DELETING_POINTERS = 64;
const MAX_RECOVERY_STEPS =
  MAX_DELETING_POINTERS + MAX_CAS_ATTEMPTS * 2;

const boundedNameSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9._:/-]+$/u, "invalid secret custody name");

export const secretGenerationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const secretSlotSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u, "invalid secret slot");

export const secretCustodyDescriptorSchema = z
  .object({
    service: boundedNameSchema,
    name: boundedNameSchema,
  })
  .strict();

export type SecretCustodyDescriptor = z.infer<
  typeof secretCustodyDescriptorSchema
>;

export const secretPointerSchema = z
  .object({
    generation: secretGenerationSchema,
    slot: secretSlotSchema,
  })
  .strict();

export type SecretPointer = z.infer<typeof secretPointerSchema>;

const pendingSecretPointerSchema = z
  .object({
    pointer: secretPointerSchema,
    replacesGeneration: secretGenerationSchema.nullable(),
  })
  .strict();

export const secretCustodyJournalSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    latestGeneration: secretGenerationSchema,
    service: boundedNameSchema,
    name: boundedNameSchema,
    committed: secretPointerSchema.optional(),
    pending: pendingSecretPointerSchema.optional(),
    deleting: z
      .array(secretPointerSchema)
      .max(MAX_DELETING_POINTERS)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const pointers = [
      ...(value.committed === undefined
        ? []
        : [{ kind: "committed", pointer: value.committed }] as const),
      ...(value.pending === undefined
        ? []
        : [{ kind: "pending", pointer: value.pending.pointer }] as const),
      ...(value.deleting ?? []).map((pointer) => ({
        kind: "deleting" as const,
        pointer,
      })),
    ];
    const slots = new Set<string>();
    const generations = new Set<number>();
    for (const { pointer } of pointers) {
      if (pointer.generation > value.latestGeneration) {
        context.addIssue({
          code: "custom",
          message: "secret pointer exceeds the generation high-water mark",
        });
      }
      if (slots.has(pointer.slot)) {
        context.addIssue({
          code: "custom",
          message: "secret custody slots must be unique",
        });
      }
      slots.add(pointer.slot);
      if (generations.has(pointer.generation)) {
        context.addIssue({
          code: "custom",
          message: "secret custody generations must be unique",
        });
      }
      generations.add(pointer.generation);
    }

    if (value.pending !== undefined) {
      const committedGeneration = value.committed?.generation ?? null;
      if (value.pending.replacesGeneration !== committedGeneration) {
        context.addIssue({
          code: "custom",
          message: "pending secret does not replace the committed generation",
        });
      }
      if (value.pending.pointer.generation !== value.latestGeneration) {
        context.addIssue({
          code: "custom",
          message: "pending secret must retain the generation high-water mark",
        });
      }
      if (
        committedGeneration !== null &&
        value.pending.pointer.generation <= committedGeneration
      ) {
        context.addIssue({
          code: "custom",
          message: "pending secret generation must advance the committed generation",
        });
      }
    }
  });

export type SecretCustodyJournal = z.infer<
  typeof secretCustodyJournalSchema
>;

export const secretCustodyQuarantineReasonSchema = z.enum([
  "legacy_identity_access_denied",
  "invalid_pointer_preserved",
  "missing_pointer_abandoned",
]);

export const secretCustodyQuarantinePointerSchema = z
  .object({
    kind: z.enum(["committed", "pending", "deleting"]),
    pointer: secretPointerSchema,
    sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: secretCustodyQuarantineReasonSchema,
  })
  .strict();

export type SecretCustodyQuarantinePointer = z.infer<
  typeof secretCustodyQuarantinePointerSchema
>;

const secretEnvelopeSchema = z
  .object({
    version: z.literal(1),
    generation: secretGenerationSchema,
    value: z.string().min(1).max(MAX_SECRET_BYTES),
  })
  .strict();

export interface SecretStore {
  get(input: {
    readonly service: string;
    readonly name: string;
  }): Promise<string | null>;
  set(input: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }): Promise<void>;
  /**
   * Resolve `true` when removed and `false` only when the slot is confirmed
   * absent. Availability or indeterminate failures must reject.
   */
  delete(input: {
    readonly service: string;
    readonly name: string;
  }): Promise<boolean>;
}

/**
 * A store adapter may use this static error only after it has classified the
 * platform's exact access-control denial. Generic availability failures must
 * retain their ordinary rejection and can never authorize quarantine.
 */
export class SecretStoreAccessDeniedError extends Error {
  constructor() {
    super("secret store access was denied");
    this.name = "SecretStoreAccessDeniedError";
  }
}

/**
 * The desktop implementation stores this token-free journal in SQLite and
 * performs compare-and-swap in one transaction.
 */
export interface SecretCustodyMetadataStore {
  read(descriptor: SecretCustodyDescriptor): Promise<unknown>;
  compareAndSwap(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number | null;
    readonly next: SecretCustodyJournal;
  }): Promise<boolean>;
  /**
   * Atomically retires inaccessible pointers from the live journal and writes
   * their token-free evidence to separate durable quarantine storage.
   */
  compareAndSwapWithQuarantine(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number;
    readonly next: SecretCustodyJournal;
    readonly quarantined: readonly SecretCustodyQuarantinePointer[];
  }): Promise<boolean>;
  /** A quarantined Keychain item is preserved and its opaque slot is eternal. */
  isQuarantinedSlot(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly slot: string;
  }): Promise<boolean>;
}

export interface SecretSlotSource {
  (): string;
}

export type SecretCustodyFailureReason =
  | "invalid_metadata"
  | "stale_generation"
  | "pending_secret_missing"
  | "custody_unavailable"
  | "concurrent_update";

export class SecretCustodyError extends Error {
  readonly reason: SecretCustodyFailureReason;

  constructor(reason: SecretCustodyFailureReason) {
    const message =
      reason === "invalid_metadata"
        ? "secret custody metadata is invalid"
        : reason === "stale_generation"
          ? "secret custody generation is stale"
          : reason === "pending_secret_missing"
            ? "pending secret custody recovery is required"
            : reason === "concurrent_update"
              ? "secret custody changed concurrently"
              : "secret custody is unavailable";
    super(message);
    this.name = "SecretCustodyError";
    this.reason = reason;
  }

  toJSON(): Readonly<{ reason: SecretCustodyFailureReason; message: string }> {
    return { reason: this.reason, message: this.message };
  }
}

export interface SecretCustodyRead {
  readonly generation: number;
  readonly value: string;
}

export interface SecretCustodyRecovery {
  readonly state:
    | "empty"
    | "committed"
    | "abandoned_missing_pending"
    | "abandoned_invalid_pending";
  readonly generation?: number;
}

export type SecretCustodyReconnectInspection =
  | Readonly<{ state: "not_required" }>
  | Readonly<{
      state: "required";
      inaccessiblePointerCount: number;
    }>;

export type SecretCustodyReconnectRecovery =
  | Readonly<{ state: "not_required" }>
  | Readonly<{
      state: "quarantined";
      quarantinedPointerCount: number;
    }>;

export type SecretCustodyPointerAnomalyInspection =
  | Readonly<{ state: "not_required" }>
  | Readonly<{
      state: "required";
      anomalousPointerCount: number;
    }>;

export type SecretCustodyCommittedInspection =
  | Readonly<{ state: "empty" }>
  | Readonly<{
      state: "inaccessible" | "missing" | "invalid";
      pointer: SecretPointer;
      sourceRevision: number;
    }>
  | Readonly<{
      state: "valid";
      pointer: SecretPointer;
      sourceRevision: number;
      value: string;
    }>;

export type SecretCustodyRecoveryCandidateInspection =
  | Readonly<{ state: "empty" }>
  | Readonly<{
      state: "inaccessible" | "missing" | "invalid";
      role: "committed" | "pending";
      pointer: SecretPointer;
      sourceRevision: number;
    }>
  | Readonly<{
      state: "valid";
      role: "committed" | "pending";
      pointer: SecretPointer;
      sourceRevision: number;
      value: string;
      token: SecretCustodyRecoveryToken;
    }>;

declare const secretCustodyRecoveryTokenBrand: unique symbol;

/**
 * Process-local proof that a caller inspected one exact recovery candidate.
 * The custody instance revalidates the journal revision, pointer, and value
 * before this token can authorize a pending-to-committed transition.
 */
export interface SecretCustodyRecoveryToken {
  readonly [secretCustodyRecoveryTokenBrand]: true;
}

export type SecretCustodyLiveValueInspection =
  | Readonly<{
      role: "committed" | "pending";
      pointer: SecretPointer;
      state: "inaccessible" | "missing" | "invalid";
    }>
  | Readonly<{
      role: "committed" | "pending";
      pointer: SecretPointer;
      state: "valid";
      value: string;
    }>;

export interface SecretCustodyLiveInspection {
  readonly sourceRevision: number | null;
  readonly values: readonly SecretCustodyLiveValueInspection[];
}

interface SecretCustodyRecoveryAuthorization {
  readonly role: "committed" | "pending";
  readonly pointer: SecretPointer;
  readonly sourceRevision: number;
  readonly value: string;
}

interface SettledSecretCustody {
  readonly journal: SecretCustodyJournal | null;
  readonly abandonedPending: "missing" | "invalid" | null;
}

type SecretPointerAccess =
  | "inaccessible"
  | "missing"
  | "invalid"
  | "valid";

interface SecretPointerInspection {
  readonly kind: "committed" | "pending" | "deleting";
  readonly pointer: SecretPointer;
  readonly access: SecretPointerAccess;
}

function slotName(descriptor: SecretCustodyDescriptor, slot: string): string {
  return `${descriptor.name}:slot:${slot}`;
}

function deletingPointers(
  journal: SecretCustodyJournal,
): readonly SecretPointer[] {
  return journal.deleting ?? [];
}

function deletingJournalField(
  pointers: readonly SecretPointer[],
): Readonly<{ deleting?: readonly SecretPointer[] }> {
  return pointers.length === 0 ? {} : { deleting: [...pointers] };
}

function parseOwnedJournal(value: unknown): SecretCustodyJournal {
  const parsed = secretCustodyJournalSchema.safeParse(value);
  if (!parsed.success) throw new SecretCustodyError("invalid_metadata");
  return parsed.data;
}

function nextRevision(journal: SecretCustodyJournal): number {
  const revision = journal.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new SecretCustodyError("invalid_metadata");
  }
  return revision;
}

function parseEnvelope(source: string | null): z.infer<typeof secretEnvelopeSchema> | null {
  if (
    source === null ||
    new TextEncoder().encode(source).length > MAX_SECRET_ENVELOPE_BYTES
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(source);
    const parsed = secretEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class GenerationalSecretCustody {
  readonly #descriptor: SecretCustodyDescriptor;
  readonly #secrets: SecretStore;
  readonly #metadata: SecretCustodyMetadataStore;
  readonly #nextSlot: SecretSlotSource;
  readonly #requireExplicitPendingRecovery: boolean;
  readonly #recoveryAuthorizations = new WeakMap<
    SecretCustodyRecoveryToken,
    SecretCustodyRecoveryAuthorization
  >();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly secrets: SecretStore;
    readonly metadata: SecretCustodyMetadataStore;
    readonly nextSlot: SecretSlotSource;
    readonly requireExplicitPendingRecovery?: boolean;
  }) {
    this.#descriptor = secretCustodyDescriptorSchema.parse(options.descriptor);
    this.#secrets = options.secrets;
    this.#metadata = options.metadata;
    this.#nextSlot = options.nextSlot;
    this.#requireExplicitPendingRecovery =
      options.requireExplicitPendingRecovery ?? false;
  }

  async #exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    let release = (): void => undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #readJournal(): Promise<SecretCustodyJournal | null> {
    let value: unknown;
    try {
      value = await this.#metadata.read(this.#descriptor);
    } catch {
      throw new SecretCustodyError("custody_unavailable");
    }
    if (value === null) return null;
    const parsed = secretCustodyJournalSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.service !== this.#descriptor.service ||
      parsed.data.name !== this.#descriptor.name
    ) {
      throw new SecretCustodyError("invalid_metadata");
    }
    return parsed.data;
  }

  async #readPointer(pointer: SecretPointer): Promise<SecretCustodyRead | null> {
    let source: string | null;
    try {
      source = await this.#secrets.get({
        service: this.#descriptor.service,
        name: slotName(this.#descriptor, pointer.slot),
      });
    } catch {
      throw new SecretCustodyError("custody_unavailable");
    }
    if (source === null) return null;
    const envelope = parseEnvelope(source);
    if (envelope === null || envelope.generation !== pointer.generation) {
      throw new SecretCustodyError("stale_generation");
    }
    return { generation: envelope.generation, value: envelope.value };
  }

  async #swap(
    expectedRevision: number | null,
    next: SecretCustodyJournal,
  ): Promise<boolean> {
    try {
      return await this.#metadata.compareAndSwap({
        descriptor: this.#descriptor,
        expectedRevision,
        next,
      });
    } catch {
      throw new SecretCustodyError("custody_unavailable");
    }
  }

  async #isQuarantinedSlot(slot: string): Promise<boolean> {
    try {
      return await this.#metadata.isQuarantinedSlot({
        descriptor: this.#descriptor,
        slot,
      });
    } catch {
      throw new SecretCustodyError("custody_unavailable");
    }
  }

  async #swapWithQuarantine(
    journal: SecretCustodyJournal,
    next: SecretCustodyJournal,
    quarantined: readonly SecretCustodyQuarantinePointer[],
  ): Promise<boolean> {
    try {
      return await this.#metadata.compareAndSwapWithQuarantine({
        descriptor: this.#descriptor,
        expectedRevision: journal.revision,
        next,
        quarantined,
      });
    } catch {
      throw new SecretCustodyError("custody_unavailable");
    }
  }

  async #pointerAccess(
    pointer: SecretPointer,
  ): Promise<SecretPointerAccess> {
    let source: string | null;
    try {
      source = await this.#secrets.get({
        service: this.#descriptor.service,
        name: slotName(this.#descriptor, pointer.slot),
      });
    } catch (error: unknown) {
      if (error instanceof SecretStoreAccessDeniedError) {
        return "inaccessible";
      }
      throw new SecretCustodyError("custody_unavailable");
    }
    if (source === null) return "missing";
    const envelope = parseEnvelope(source);
    if (envelope === null || envelope.generation !== pointer.generation) {
      return "invalid";
    }
    return "valid";
  }

  async #inspectCommitted(
    pointer: SecretPointer,
  ): Promise<
    | Readonly<{ state: "inaccessible" | "missing" | "invalid" }>
    | Readonly<{ state: "valid"; value: string }>
  > {
    let source: string | null;
    try {
      source = await this.#secrets.get({
        service: this.#descriptor.service,
        name: slotName(this.#descriptor, pointer.slot),
      });
    } catch (error: unknown) {
      if (error instanceof SecretStoreAccessDeniedError) {
        return { state: "inaccessible" };
      }
      throw new SecretCustodyError("custody_unavailable");
    }
    if (source === null) return { state: "missing" };
    const envelope = parseEnvelope(source);
    if (envelope === null || envelope.generation !== pointer.generation) {
      return { state: "invalid" };
    }
    return {
      state: "valid",
      value: envelope.value,
    };
  }

  async inspectCommittedForRecovery(): Promise<SecretCustodyCommittedInspection> {
    return await this.#exclusive(async () => {
      const journal = await this.#readJournal();
      if (journal?.committed === undefined) return { state: "empty" };
      const inspected = await this.#inspectCommitted(journal.committed);
      return {
        ...inspected,
        pointer: journal.committed,
        sourceRevision: journal.revision,
      };
    });
  }

  /**
   * Non-mutating inspection of the identity that ordinary recovery would make
   * current. A valid pending write wins over the prior committed pointer.
   */
  async inspectRecoveryCandidate(): Promise<SecretCustodyRecoveryCandidateInspection> {
    return await this.#exclusive(async () => {
      const journal = await this.#readJournal();
      if (journal === null) return { state: "empty" };
      const candidate = journal.pending === undefined
        ? journal.committed === undefined
          ? null
          : { role: "committed" as const, pointer: journal.committed }
        : { role: "pending" as const, pointer: journal.pending.pointer };
      if (candidate === null) return { state: "empty" };
      const inspected = await this.#inspectCommitted(candidate.pointer);
      if (inspected.state !== "valid") {
        return {
          ...inspected,
          role: candidate.role,
          pointer: candidate.pointer,
          sourceRevision: journal.revision,
        };
      }
      const token = Object.freeze({}) as SecretCustodyRecoveryToken;
      this.#recoveryAuthorizations.set(token, {
        role: candidate.role,
        pointer: candidate.pointer,
        sourceRevision: journal.revision,
        value: inspected.value,
      });
      return {
        ...inspected,
        role: candidate.role,
        pointer: candidate.pointer,
        sourceRevision: journal.revision,
        token,
      };
    });
  }

  /** Non-mutating inventory of every value that a clear would retire. */
  async inspectLiveValues(): Promise<SecretCustodyLiveInspection> {
    return await this.#exclusive(async () => {
      const journal = await this.#readJournal();
      if (journal === null) return { sourceRevision: null, values: [] };
      const candidates = [
        ...(journal.committed === undefined
          ? []
          : [{ role: "committed" as const, pointer: journal.committed }]),
        ...(journal.pending === undefined
          ? []
          : [{ role: "pending" as const, pointer: journal.pending.pointer }]),
      ];
      const values: SecretCustodyLiveValueInspection[] = [];
      for (const candidate of candidates) {
        const inspected = await this.#inspectCommitted(candidate.pointer);
        values.push({
          ...candidate,
          ...inspected,
        });
      }
      return { sourceRevision: journal.revision, values };
    });
  }

  /**
   * Retire the exact live-value inventory after the owning product determines
   * that its credential rotation may have committed remotely. The committed
   * and pending pointers move atomically to durable quarantine, their Keychain
   * bytes remain untouched, and a valid pending value is never promoted.
   *
   * `invalid_pointer_preserved` also covers a structurally valid generic
   * envelope whose product-owned credential is no longer safe to execute.
   */
  async preserveLiveValuesForRecovery(
    inspected: SecretCustodyLiveInspection,
  ): Promise<SecretCustodyReconnectRecovery> {
    return await this.#exclusive(async () => {
      const journal = await this.#readJournal();
      if ((journal?.revision ?? null) !== inspected.sourceRevision) {
        throw new SecretCustodyError("concurrent_update");
      }
      const candidates = journal === null
        ? []
        : [
            ...(journal.committed === undefined
              ? []
              : [{ role: "committed" as const, pointer: journal.committed }]),
            ...(journal.pending === undefined
              ? []
              : [{ role: "pending" as const, pointer: journal.pending.pointer }]),
          ];
      if (candidates.length !== inspected.values.length) {
        throw new SecretCustodyError("concurrent_update");
      }

      const quarantined: SecretCustodyQuarantinePointer[] = [];
      for (const [index, candidate] of candidates.entries()) {
        const observation = inspected.values[index];
        if (
          observation === undefined ||
          observation.role !== candidate.role ||
          observation.pointer.generation !== candidate.pointer.generation ||
          observation.pointer.slot !== candidate.pointer.slot
        ) {
          throw new SecretCustodyError("concurrent_update");
        }
        const current = await this.#inspectCommitted(candidate.pointer);
        if (
          current.state !== observation.state ||
          (current.state === "valid" &&
            (observation.state !== "valid" || current.value !== observation.value))
        ) {
          throw new SecretCustodyError("concurrent_update");
        }
        quarantined.push(secretCustodyQuarantinePointerSchema.parse({
          kind: candidate.role,
          pointer: candidate.pointer,
          sourceRevision: journal?.revision,
          reason: "invalid_pointer_preserved",
        }));
      }

      if (journal === null || quarantined.length === 0) {
        return { state: "not_required" };
      }
      const next = parseOwnedJournal({
        version: 1,
        revision: nextRevision(journal),
        latestGeneration: journal.latestGeneration,
        service: journal.service,
        name: journal.name,
        ...deletingJournalField(deletingPointers(journal)),
      });
      if (!(await this.#swapWithQuarantine(journal, next, quarantined))) {
        throw new SecretCustodyError("concurrent_update");
      }
      return {
        state: "quarantined",
        quarantinedPointerCount: quarantined.length,
      };
    });
  }

  async #inspectPointers(
    journal: SecretCustodyJournal,
  ): Promise<readonly SecretPointerInspection[]> {
    const candidates = [
      ...(journal.committed === undefined
        ? []
        : [{ kind: "committed" as const, pointer: journal.committed }]),
      ...(journal.pending === undefined
        ? []
        : [{ kind: "pending" as const, pointer: journal.pending.pointer }]),
      ...(journal.deleting ?? []).map((pointer) => ({
        kind: "deleting" as const,
        pointer,
      })),
    ];
    const inspected: SecretPointerInspection[] = [];
    for (const candidate of candidates) {
      inspected.push({
        ...candidate,
        access: await this.#pointerAccess(candidate.pointer),
      });
    }
    return inspected;
  }

  #quarantineEvidence(
    journal: SecretCustodyJournal,
    inspected: readonly SecretPointerInspection[],
  ): readonly SecretCustodyQuarantinePointer[] {
    return inspected
      .filter(({ access }) => access === "inaccessible")
      .map(({ kind, pointer }) =>
        secretCustodyQuarantinePointerSchema.parse({
          kind,
          pointer,
          sourceRevision: journal.revision,
          reason: "legacy_identity_access_denied",
        })
      );
  }

  /**
   * Non-mutating recovery classification. It deliberately reports only an
   * access failure. Missing or malformed material stays on the ordinary,
   * stricter recovery path rather than being mislabeled as an identity change.
   */
  async inspectLegacyIdentityReconnect(): Promise<SecretCustodyReconnectInspection> {
    return await this.#exclusive(async () => {
      const journal = await this.#readJournal();
      if (journal === null) return { state: "not_required" };
      const inaccessible = this.#quarantineEvidence(
        journal,
        await this.#inspectPointers(journal),
      );
      return inaccessible.length === 0
        ? { state: "not_required" }
        : {
            state: "required",
            inaccessiblePointerCount: inaccessible.length,
          };
    });
  }

  /**
   * Non-mutating product recovery classification for durable pointer roles.
   * Exact access denial remains separately typed; unknown store failures throw.
   */
  async inspectPointerAnomalies(): Promise<
    SecretCustodyPointerAnomalyInspection
  > {
    return await this.#exclusive(async () => {
      const journal = await this.#readJournal();
      if (journal === null) return { state: "not_required" };
      const anomalousPointerCount = (await this.#inspectPointers(journal))
        .filter(({ access }) => access === "missing" || access === "invalid")
        .length;
      return anomalousPointerCount === 0
        ? { state: "not_required" }
        : { state: "required", anomalousPointerCount };
    });
  }

  /**
   * Explicit first-stable-identity recovery. Inaccessible Keychain items are
   * never deleted or overwritten. Their exact opaque pointers move atomically
   * to durable quarantine evidence while the generation high-water remains.
   */
  async quarantineLegacyIdentityPointers(options: {
    readonly candidate?: SecretCustodyRecoveryToken;
  } = {}): Promise<SecretCustodyReconnectRecovery> {
    return await this.#quarantinePointerAnomalies(false, options.candidate);
  }

  /** Explicit product-authorized recovery for missing or malformed pointers. */
  async preservePointerAnomalies(options: {
    readonly candidate?: SecretCustodyRecoveryToken;
  } = {}): Promise<SecretCustodyReconnectRecovery> {
    return await this.#quarantinePointerAnomalies(true, options.candidate);
  }

  async #quarantinePointerAnomalies(
    allowWithoutIdentityDenial: boolean,
    candidate: SecretCustodyRecoveryToken | undefined,
  ): Promise<SecretCustodyReconnectRecovery> {
    return await this.#exclusive(async () => {
      const authorization = this.#recoveryAuthorization(candidate);
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const journal = await this.#readJournal();
        await this.#assertRecoveryCandidateAuthorized(journal, authorization);
        if (journal === null) return { state: "not_required" };
        const inspected = await this.#inspectPointers(journal);
        const inaccessible = this.#quarantineEvidence(journal, inspected);
        if (!allowWithoutIdentityDenial && inaccessible.length === 0) {
          return { state: "not_required" };
        }
        const accessBySlot = new Map(
          inspected.map(({ pointer, access }) => [pointer.slot, access]),
        );
        const pendingAccess = journal.pending === undefined
          ? undefined
          : accessBySlot.get(journal.pending.pointer.slot);
        const committedAccess = journal.committed === undefined
          ? undefined
          : accessBySlot.get(journal.committed.slot);
        const dependentEvidence = inspected
          .filter(({ access }) => access === "missing" || access === "invalid")
          .map(({ kind, pointer, access }) =>
            secretCustodyQuarantinePointerSchema.parse({
              kind,
              pointer,
              sourceRevision: journal.revision,
              reason: access === "missing"
                ? "missing_pointer_abandoned"
                : "invalid_pointer_preserved",
            })
          );
        const quarantined = [...inaccessible, ...dependentEvidence];
        if (quarantined.length === 0) return { state: "not_required" };
        const promotePending = pendingAccess === "valid" &&
          committedAccess !== "valid";
        const nextCommitted = promotePending
          ? journal.pending?.pointer
          : committedAccess !== undefined && committedAccess !== "valid"
            ? undefined
            : journal.committed;
        const keepPending = pendingAccess === "valid" && !promotePending;
        const nextSource = {
          version: 1,
          revision: nextRevision(journal),
          latestGeneration: journal.latestGeneration,
          service: journal.service,
          name: journal.name,
          ...(nextCommitted === undefined ? {} : { committed: nextCommitted }),
          ...(keepPending && journal.pending !== undefined
            ? { pending: journal.pending }
            : {}),
          ...deletingJournalField(
            deletingPointers(journal).filter((pointer) =>
              accessBySlot.get(pointer.slot) === "valid"
            ),
          ),
        };
        const parsed = secretCustodyJournalSchema.safeParse(nextSource);
        if (!parsed.success) {
          throw new SecretCustodyError("invalid_metadata");
        }
        if (promotePending) {
          const staged = journal.pending === undefined
            ? null
            : await this.#readPointer(journal.pending.pointer);
          if (staged === null) {
            throw new SecretCustodyError("concurrent_update");
          }
          this.#assertPendingPromotionAuthorized(
            journal,
            staged,
            authorization,
          );
        }
        if (await this.#swapWithQuarantine(journal, parsed.data, quarantined)) {
          return {
            state: "quarantined",
            quarantinedPointerCount: quarantined.length,
          };
        }
      }
      throw new SecretCustodyError("concurrent_update");
    });
  }

  /**
   * Preserve a readable envelope whose product-owned payload failed its schema.
   * The caller must make that classification before requesting this explicit,
   * user-authorized transition. The opaque item remains in Keychain forever.
   */
  async preserveCommittedForRecovery(
    inspected: Exclude<SecretCustodyCommittedInspection, { state: "empty" }>,
    reason: "invalid_pointer_preserved" | "missing_pointer_abandoned",
    options: {
      readonly candidate?: SecretCustodyRecoveryToken;
    } = {},
  ): Promise<SecretCustodyReconnectRecovery> {
    return await this.#exclusive(async () => {
      const authorization = this.#recoveryAuthorization(options.candidate);
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const journal = await this.#readJournal();
        await this.#assertRecoveryCandidateAuthorized(journal, authorization);
        if (journal?.committed === undefined) return { state: "not_required" };
        if (
          journal.revision !== inspected.sourceRevision ||
          journal.committed.generation !== inspected.pointer.generation ||
          journal.committed.slot !== inspected.pointer.slot
        ) {
          throw new SecretCustodyError("concurrent_update");
        }
        const pointers = await this.#inspectPointers(journal);
        const currentCommitted = await this.#inspectCommitted(journal.committed);
        const sameObservation = currentCommitted.state === inspected.state &&
          (currentCommitted.state !== "valid" ||
            (inspected.state === "valid" &&
              currentCommitted.value === inspected.value));
        if (!sameObservation) {
          throw new SecretCustodyError("concurrent_update");
        }
        const accessBySlot = new Map(
          pointers.map(({ pointer, access }) => [pointer.slot, access]),
        );
        accessBySlot.set(journal.committed.slot, "invalid");
        const evidence = pointers
          .filter(({ pointer, access }) =>
            pointer.slot === journal.committed?.slot || access !== "valid"
          )
          .map(({ kind, pointer, access }) =>
            secretCustodyQuarantinePointerSchema.parse({
              kind,
              pointer,
              sourceRevision: journal.revision,
              reason: pointer.slot === journal.committed?.slot
                ? reason
                : access === "inaccessible"
                  ? "legacy_identity_access_denied"
                  : access === "missing"
                    ? "missing_pointer_abandoned"
                    : "invalid_pointer_preserved",
            })
          );
        const pendingAccess = journal.pending === undefined
          ? undefined
          : accessBySlot.get(journal.pending.pointer.slot);
        const promotePending = pendingAccess === "valid";
        const next = parseOwnedJournal({
          version: 1,
          revision: nextRevision(journal),
          latestGeneration: journal.latestGeneration,
          service: journal.service,
          name: journal.name,
          ...(promotePending && journal.pending !== undefined
            ? { committed: journal.pending.pointer }
            : {}),
          ...deletingJournalField(
            deletingPointers(journal).filter((pointer) =>
              accessBySlot.get(pointer.slot) === "valid"
            ),
          ),
        });
        if (promotePending) {
          const staged = journal.pending === undefined
            ? null
            : await this.#readPointer(journal.pending.pointer);
          if (staged === null) {
            throw new SecretCustodyError("concurrent_update");
          }
          this.#assertPendingPromotionAuthorized(
            journal,
            staged,
            authorization,
          );
        }
        if (await this.#swapWithQuarantine(journal, next, evidence)) {
          return {
            state: "quarantined",
            quarantinedPointerCount: evidence.length,
          };
        }
      }
      throw new SecretCustodyError("concurrent_update");
    });
  }

  /**
   * Quarantine one exact inspected pending value without ever making it
   * current. Product validation can use this after rejecting an otherwise
   * well-formed generic envelope.
   */
  async preserveInspectedPendingForRecovery(
    token: SecretCustodyRecoveryToken,
  ): Promise<SecretCustodyReconnectRecovery> {
    return await this.#exclusive(async () => {
      const authorization = this.#recoveryAuthorization(token);
      if (authorization?.role !== "pending") {
        throw new SecretCustodyError("concurrent_update");
      }
      const journal = await this.#readJournal();
      await this.#assertRecoveryCandidateAuthorized(journal, authorization);
      if (journal?.pending === undefined) {
        throw new SecretCustodyError("concurrent_update");
      }
      const next = parseOwnedJournal({
        version: 1,
        revision: nextRevision(journal),
        latestGeneration: journal.latestGeneration,
        service: journal.service,
        name: journal.name,
        ...(journal.committed === undefined
          ? {}
          : { committed: journal.committed }),
        ...deletingJournalField(deletingPointers(journal)),
      });
      const evidence = secretCustodyQuarantinePointerSchema.parse({
        kind: "pending",
        pointer: journal.pending.pointer,
        sourceRevision: journal.revision,
        reason: "invalid_pointer_preserved",
      });
      if (!(await this.#swapWithQuarantine(journal, next, [evidence]))) {
        throw new SecretCustodyError("concurrent_update");
      }
      return { state: "quarantined", quarantinedPointerCount: 1 };
    });
  }

  async #deletePointer(pointer: SecretPointer): Promise<void> {
    try {
      await this.#secrets.delete({
        service: this.#descriptor.service,
        name: slotName(this.#descriptor, pointer.slot),
      });
    } catch {
      throw new SecretCustodyError("custody_unavailable");
    }
  }

  #recoveryAuthorization(
    token: SecretCustodyRecoveryToken | undefined,
  ): SecretCustodyRecoveryAuthorization | undefined {
    if (token === undefined) return undefined;
    const authorization = this.#recoveryAuthorizations.get(token);
    if (authorization === undefined) {
      throw new SecretCustodyError("concurrent_update");
    }
    return authorization;
  }

  #assertPendingPromotionAuthorized(
    journal: SecretCustodyJournal,
    staged: SecretCustodyRead,
    authorization: SecretCustodyRecoveryAuthorization | undefined,
  ): void {
    const pending = journal.pending;
    if (pending === undefined) {
      throw new SecretCustodyError("concurrent_update");
    }
    if (authorization === undefined) {
      if (!this.#requireExplicitPendingRecovery) return;
      throw new SecretCustodyError("pending_secret_missing");
    }
    if (
      authorization.role !== "pending"
      || authorization.sourceRevision !== journal.revision
      || authorization.pointer.generation !== pending.pointer.generation
      || authorization.pointer.slot !== pending.pointer.slot
      || authorization.value !== staged.value
      || staged.generation !== pending.pointer.generation
    ) {
      throw new SecretCustodyError("concurrent_update");
    }
  }

  async #assertRecoveryCandidateAuthorized(
    journal: SecretCustodyJournal | null,
    authorization: SecretCustodyRecoveryAuthorization | undefined,
  ): Promise<void> {
    if (authorization === undefined) return;
    const candidate = journal?.pending === undefined
      ? journal?.committed === undefined
        ? null
        : { role: "committed" as const, pointer: journal.committed }
      : { role: "pending" as const, pointer: journal.pending.pointer };
    if (
      journal === null
      || candidate === null
      || journal.revision !== authorization.sourceRevision
      || candidate.role !== authorization.role
      || candidate.pointer.generation !== authorization.pointer.generation
      || candidate.pointer.slot !== authorization.pointer.slot
    ) {
      throw new SecretCustodyError("concurrent_update");
    }
    const current = await this.#readPointer(candidate.pointer);
    if (current === null || current.value !== authorization.value) {
      throw new SecretCustodyError("concurrent_update");
    }
  }

  /**
   * Resolve every journaled boundary. A superseded slot remains in `deleting`
   * until Keychain confirms deletion (including an already-absent result) and
   * a later metadata CAS retires the pointer. Repeating either half is safe.
   */
  async #settle(
    abandonMissingPending: boolean,
    authorization?: SecretCustodyRecoveryAuthorization,
    deferDeletingCleanup = false,
  ): Promise<SettledSecretCustody> {
    let abandonedPending: SettledSecretCustody["abandonedPending"] = null;
    let conflicts = 0;
    for (let step = 0; step < MAX_RECOVERY_STEPS; step += 1) {
      const journal = await this.#readJournal();
      await this.#assertRecoveryCandidateAuthorized(journal, authorization);
      if (journal === null) {
        return { journal: null, abandonedPending };
      }

      const pending = journal.pending;
      if (pending !== undefined) {
        let staged: SecretCustodyRead | null;
        try {
          staged = await this.#readPointer(pending.pointer);
        } catch (error) {
          if (
            !abandonMissingPending ||
            !(error instanceof SecretCustodyError) ||
            error.reason !== "stale_generation"
          ) {
            throw error;
          }
          const deleting = [
            ...deletingPointers(journal),
            pending.pointer,
          ];
          const abandoned = parseOwnedJournal({
            version: 1,
            revision: nextRevision(journal),
            latestGeneration: journal.latestGeneration,
            service: journal.service,
            name: journal.name,
            ...(journal.committed === undefined
              ? {}
              : { committed: journal.committed }),
            ...deletingJournalField(deleting),
          });
          if (!(await this.#swap(journal.revision, abandoned))) {
            conflicts += 1;
            if (conflicts >= MAX_CAS_ATTEMPTS) break;
            continue;
          }
          abandonedPending = "invalid";
          conflicts = 0;
          continue;
        }
        if (staged === null) {
          if (!abandonMissingPending) {
            throw new SecretCustodyError("pending_secret_missing");
          }
          const abandoned = parseOwnedJournal({
            version: 1,
            revision: nextRevision(journal),
            latestGeneration: journal.latestGeneration,
            service: journal.service,
            name: journal.name,
            ...(journal.committed === undefined
              ? {}
              : { committed: journal.committed }),
            ...deletingJournalField(deletingPointers(journal)),
          });
          if (!(await this.#swap(journal.revision, abandoned))) {
            conflicts += 1;
            if (conflicts >= MAX_CAS_ATTEMPTS) break;
            continue;
          }
          abandonedPending = "missing";
          conflicts = 0;
          continue;
        }

        this.#assertPendingPromotionAuthorized(
          journal,
          staged,
          authorization,
        );

        const deleting = [
          ...deletingPointers(journal),
          ...(journal.committed === undefined ? [] : [journal.committed]),
        ];
        const committed = parseOwnedJournal({
          version: 1,
          revision: nextRevision(journal),
          latestGeneration: journal.latestGeneration,
          service: journal.service,
          name: journal.name,
          committed: pending.pointer,
          ...deletingJournalField(deleting),
        });
        if (!(await this.#swap(journal.revision, committed))) {
          conflicts += 1;
          if (conflicts >= MAX_CAS_ATTEMPTS) break;
          continue;
        }
        if (authorization !== undefined) {
          authorization = {
            ...authorization,
            role: "committed",
            sourceRevision: committed.revision,
          };
        }
        if (deferDeletingCleanup) {
          return { journal: committed, abandonedPending };
        }
        conflicts = 0;
        continue;
      }

      const [deleting, ...remaining] = deletingPointers(journal);
      if (deleting === undefined) {
        return { journal, abandonedPending };
      }
      if (deferDeletingCleanup) {
        return { journal, abandonedPending };
      }
      await this.#deletePointer(deleting);
      const retired = parseOwnedJournal({
        version: 1,
        revision: nextRevision(journal),
        latestGeneration: journal.latestGeneration,
        service: journal.service,
        name: journal.name,
        ...(journal.committed === undefined
          ? {}
          : { committed: journal.committed }),
        ...deletingJournalField(remaining),
      });
      if (!(await this.#swap(journal.revision, retired))) {
        conflicts += 1;
        if (conflicts >= MAX_CAS_ATTEMPTS) break;
        continue;
      }
      if (authorization !== undefined) {
        authorization = {
          ...authorization,
          sourceRevision: retired.revision,
        };
      }
      conflicts = 0;
    }
    throw new SecretCustodyError("concurrent_update");
  }

  async read(): Promise<SecretCustodyRead | null> {
    return await this.#exclusive(async () => {
      const { journal } = await this.#settle(false);
      if (journal === null) return null;
      if (journal.committed === undefined) return null;
      const result = await this.#readPointer(journal.committed);
      if (result === null) throw new SecretCustodyError("stale_generation");
      return result;
    });
  }

  async #write(
    value: string,
    expectedGeneration: number | null | undefined,
  ): Promise<SecretPointer | null> {
    const encodedBytes = new TextEncoder().encode(value).length;
    if (value.length === 0 || encodedBytes > MAX_SECRET_BYTES) {
      throw new SecretCustodyError("invalid_metadata");
    }
    return await this.#exclusive(async () => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const { journal } = await this.#settle(false);
        if (
          expectedGeneration !== undefined &&
          (journal?.committed?.generation ?? null) !== expectedGeneration
        ) {
          return null;
        }

        const slot = secretSlotSchema.safeParse(this.#nextSlot());
        const reservedSlots = new Set([
          ...(journal?.committed === undefined
            ? []
            : [journal.committed.slot]),
          ...(journal?.pending === undefined
            ? []
            : [journal.pending.pointer.slot]),
          ...(journal?.deleting ?? []).map(({ slot: reserved }) => reserved),
        ]);
        if (!slot.success) {
          throw new SecretCustodyError("invalid_metadata");
        }
        if (
          reservedSlots.has(slot.data) ||
          await this.#isQuarantinedSlot(slot.data)
        ) {
          continue;
        }
        const generation = (journal?.latestGeneration ?? -1) + 1;
        if (!Number.isSafeInteger(generation)) {
          throw new SecretCustodyError("invalid_metadata");
        }
        const pointer = secretPointerSchema.parse({
          generation,
          slot: slot.data,
        });
        const pending = parseOwnedJournal({
          version: 1,
          revision: (journal?.revision ?? -1) + 1,
          latestGeneration: generation,
          service: this.#descriptor.service,
          name: this.#descriptor.name,
          ...(journal?.committed === undefined
            ? {}
            : { committed: journal.committed }),
          ...(journal === null
            ? {}
            : deletingJournalField(deletingPointers(journal))),
          pending: {
            pointer,
            replacesGeneration: journal?.committed?.generation ?? null,
          },
        });
        if (!(await this.#swap(journal?.revision ?? null, pending))) continue;

        try {
          await this.#secrets.set({
            service: this.#descriptor.service,
            name: slotName(this.#descriptor, pointer.slot),
            value: JSON.stringify({
              version: 1,
              generation: pointer.generation,
              value,
            }),
          });
        } catch {
          throw new SecretCustodyError("custody_unavailable");
        }

        const { journal: committed } = await this.#settle(false, {
          role: "pending",
          pointer,
          sourceRevision: pending.revision,
          value,
        });
        if (
          committed?.committed?.generation !== pointer.generation ||
          committed.committed.slot !== pointer.slot
        ) {
          throw new SecretCustodyError("concurrent_update");
        }
        return pointer;
      }
      throw new SecretCustodyError("concurrent_update");
    });
  }

  async write(value: string): Promise<SecretPointer> {
    const written = await this.#write(value, undefined);
    if (written === null) throw new SecretCustodyError("concurrent_update");
    return written;
  }

  /**
   * Replace only the exact generation previously read. `null` means that no
   * secret is currently committed; the retained high-water mark still prevents
   * a later sign-in from reusing an old generation.
   */
  async compareAndSwap(
    expectedGeneration: number | null,
    value: string,
  ): Promise<SecretPointer | null> {
    const parsedExpected = expectedGeneration === null
      ? null
      : secretGenerationSchema.parse(expectedGeneration);
    return await this.#write(value, parsedExpected);
  }

  /**
   * Run only when the owning process has exclusive authority. It may then
   * abandon a missing pre-Keychain write or journal-delete an invalid pending
   * envelope without racing a live writer.
   */
  async recover(options: {
    readonly abandonMissingPending: boolean;
    readonly candidate?: SecretCustodyRecoveryToken;
    readonly deferDeletingCleanup?: boolean;
  }): Promise<SecretCustodyRecovery> {
    return await this.#exclusive(async () => {
      const settled = await this.#settle(
        options.abandonMissingPending,
        this.#recoveryAuthorization(options.candidate),
        options.deferDeletingCleanup ?? false,
      );
      const committed = settled.journal?.committed;
      if (settled.abandonedPending !== null) {
        return {
          state: settled.abandonedPending === "missing"
            ? "abandoned_missing_pending"
            : "abandoned_invalid_pending",
          ...(committed === undefined
            ? {}
            : { generation: committed.generation }),
        };
      }
      return committed === undefined
        ? { state: "empty" }
        : {
            state: "committed",
            generation: committed.generation,
          };
    });
  }

  async #clear(
    expectedGeneration: number | undefined,
    onJournaled: (() => Promise<void>) | undefined,
    expectedSourceRevision?: number | null,
  ): Promise<boolean> {
    return await this.#exclusive(async () => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await this.#readJournal();
        if (
          expectedSourceRevision !== undefined
          && (current?.revision ?? null) !== expectedSourceRevision
        ) return false;
        if (
          expectedGeneration !== undefined &&
          current?.pending !== undefined
        ) {
          // A pending pointer owns the successor rotation. An exact-generation
          // clear may retire only its committed observation; it must never
          // absorb a queued G+1 write whose settlement or response faulted.
          return false;
        }
        const journal = current?.pending === undefined
          ? (await this.#settle(false)).journal
          : current;
        if (journal === null) return expectedGeneration === undefined;
        if (
          expectedGeneration !== undefined &&
          journal.committed?.generation !== expectedGeneration
        ) {
          return false;
        }
        if (
          journal.committed === undefined &&
          journal.pending === undefined
        ) return true;

        const deleting = [
          ...deletingPointers(journal),
          ...(journal.committed === undefined ? [] : [journal.committed]),
          ...(journal.pending === undefined ? [] : [journal.pending.pointer]),
        ];
        if (deleting.length > MAX_DELETING_POINTERS) {
          const [retiring, ...remaining] = deletingPointers(journal);
          if (retiring === undefined) {
            throw new SecretCustodyError("invalid_metadata");
          }
          await this.#deletePointer(retiring);
          const compacted = parseOwnedJournal({
            version: 1,
            revision: nextRevision(journal),
            latestGeneration: journal.latestGeneration,
            service: journal.service,
            name: journal.name,
            ...(journal.committed === undefined
              ? {}
              : { committed: journal.committed }),
            ...(journal.pending === undefined
              ? {}
              : { pending: journal.pending }),
            ...deletingJournalField(remaining),
          });
          if (!(await this.#swap(journal.revision, compacted))) continue;
          attempt -= 1;
          continue;
        }
        const cleared = parseOwnedJournal({
          version: 1,
          revision: nextRevision(journal),
          latestGeneration: journal.latestGeneration,
          service: journal.service,
          name: journal.name,
          ...deletingJournalField(deleting),
        });
        if (!(await this.#swap(journal.revision, cleared))) continue;
        await onJournaled?.();
        await this.#settle(false);
        return true;
      }
      throw new SecretCustodyError("concurrent_update");
    });
  }

  async clear(): Promise<void> {
    await this.#clear(undefined, undefined);
  }

  /** Clear only the exact live-value inventory previously inspected. */
  async clearIfSourceRevision(
    expectedSourceRevision: number | null,
  ): Promise<boolean> {
    return await this.#clear(
      undefined,
      undefined,
      expectedSourceRevision,
    );
  }

  /** Clear only the exact generation previously read. */
  async clearIfGeneration(
    expectedGeneration: number,
    options: {
      /**
       * Runs after the logical clear is durable and before physical cleanup.
       * A cleanup failure therefore cannot leave an observer signed in.
       */
      readonly onJournaled?: () => Promise<void>;
    } = {},
  ): Promise<boolean> {
    return await this.#clear(
      secretGenerationSchema.parse(expectedGeneration),
      options.onJournaled,
    );
  }
}
