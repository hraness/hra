import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES,
  HARNESS_MAX_HEAP_UTF8_BYTES,
  contextValueIdSchema,
} from "./domain";
import {
  deriveHarnessContextDigestKey,
  deriveHarnessContextValueKey,
  type HarnessContextKeyProvider,
} from "./key-custody";
import {
  HarnessObjectStoreError,
  harnessObjectDigest,
  type HarnessObjectPublication,
  type HarnessObjectStorePort,
} from "./object-store";

export const CONTEXT_VALUE_CHUNK_BYTES = 64 * 1024;
export const CONTEXT_VALUE_MAX_BYTES = 1024 * 1024;
export const CONTEXT_VALUE_MAX_CHUNKS = 16;
export const COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES =
  HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES;
export const COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS =
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES / CONTEXT_VALUE_CHUNK_BYTES;
export const CONTEXT_VALUE_MAX_OBJECT_BYTES = 2 * 1024 * 1024;

const operationIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{15,127}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const valueKindSchema = z.enum(["text", "json", "selection", "agentResult"]);
const valuePurposeSchema = z.enum([
  "heap",
  "completedPrefix",
  "currentInput",
  "agentResult",
  "proposal",
  "actorTask",
  "programSource",
  "programResult",
]);
const recoveryReasonSchema = z.enum([
  "ciphertext_invalid",
  "immutable_object_conflict",
  "metadata_conflict",
  "object_missing_after_activation",
]);

const chunkMetadataSchema = z.object({
  ordinal: z.number().int().min(0)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS - 1),
  plaintextBytes: z.number().int().min(0).max(CONTEXT_VALUE_CHUNK_BYTES),
  objectDigest: digestSchema,
  objectByteLength: z.number().int().positive()
    .max(CONTEXT_VALUE_MAX_OBJECT_BYTES),
}).strict();

const immutableShape = {
  version: z.literal(2),
  operationId: operationIdSchema,
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: valueKindSchema,
  purpose: valuePurposeSchema,
  schemaVersion: z.literal(1),
  nameDigest: digestSchema.nullable(),
  utf8Bytes: z.number().int().nonnegative()
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES),
  contentDigest: digestSchema,
  chunkSize: z.literal(CONTEXT_VALUE_CHUNK_BYTES),
  chunkCount: z.number().int().min(1)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS),
  chunks: z.array(chunkMetadataSchema).min(1)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS),
  manifestDigest: digestSchema,
  manifestByteLength: z.number().int().positive()
    .max(CONTEXT_VALUE_MAX_OBJECT_BYTES),
  quotaLimitBytes: z.number().int().positive()
    .min(1024 * 1024).max(HARNESS_MAX_HEAP_UTF8_BYTES)
    .refine((value) => value % (1024 * 1024) === 0),
} as const;

const contextValueRecordSchema = z.object({
  ...immutableShape,
  state: z.enum([
    "prepared",
    "effectStarted",
    "replayRequired",
    "active",
    "recoveryRequired",
  ]),
  recoveryReason: recoveryReasonSchema.nullable(),
  revision: z.number().int().positive().safe(),
}).strict().superRefine((value, context) => {
  validateValueCapacity(value, context);
  if (
    (value.state === "recoveryRequired") !== (value.recoveryReason !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "recovery reason must exactly match recoveryRequired state",
    });
  }
});

const prepareInputSchema = z.object({
  ...immutableShape,
}).strict().superRefine(validateValueCapacity);

const putCommandSchema = z.object({
  version: z.literal(2),
  operationId: operationIdSchema,
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: valueKindSchema,
  purpose: valuePurposeSchema,
  schemaVersion: z.literal(1),
  nameDigest: digestSchema.nullable().default(null),
  plaintext: z.string(),
  quotaLimitBytes: z.number().int().positive()
    .min(1024 * 1024).max(HARNESS_MAX_HEAP_UTF8_BYTES)
    .refine((value) => value % (1024 * 1024) === 0),
}).strict().superRefine((command, context) => {
  if (command.purpose === "completedPrefix" && command.kind !== "selection") {
    context.addIssue({
      code: "custom",
      message: "completed-prefix values must use the indexed selection kind",
      path: ["kind"],
    });
  }
});

const valueAddressSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
}).strict();

const byteRangeSchema = z.object({
  startByte: z.number().int().nonnegative().safe(),
  endByteExclusive: z.number().int().nonnegative().safe(),
}).strict().superRefine((range, context) => {
  if (range.endByteExclusive < range.startByte) {
    context.addIssue({
      code: "custom",
      message: "context-value range end precedes its start",
      path: ["endByteExclusive"],
    });
  }
});

const listInputSchema = z.object({
  epochId: actorEpochIdSchema,
  afterValueId: contextValueIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(128),
}).strict();

const recoveryScanInputSchema = z.object({
  afterOperationId: operationIdSchema.nullable().default(null),
  limit: z.number().int().min(1).max(128),
}).strict();

const base64UrlSchema = z.string().max(CONTEXT_VALUE_MAX_OBJECT_BYTES)
  .regex(/^[A-Za-z0-9_-]*$/u);
const encryptedRecordSchema = z.discriminatedUnion("record", [
  z.object({
    version: z.literal(2),
    cipher: z.literal("aes-256-gcm"),
    record: z.literal("manifest"),
    ordinal: z.null(),
    nonce: base64UrlSchema.length(16),
    ciphertext: base64UrlSchema,
    authenticationTag: base64UrlSchema.length(22),
  }).strict(),
  z.object({
    version: z.literal(2),
    cipher: z.literal("aes-256-gcm"),
    record: z.literal("chunk"),
    ordinal: z.number().int().min(0)
      .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS - 1),
    nonce: base64UrlSchema.length(16),
    ciphertext: base64UrlSchema,
    authenticationTag: base64UrlSchema.length(22),
  }).strict(),
]);

const manifestSchema = z.object({
  domain: z.literal("oprte-context-value-manifest"),
  version: z.literal(2),
  utf8Bytes: z.number().int().nonnegative()
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES),
  contentDigest: digestSchema,
  chunkSize: z.literal(CONTEXT_VALUE_CHUNK_BYTES),
  chunks: z.array(chunkMetadataSchema).min(1)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS),
}).strict().superRefine((value, context) => {
  const synthetic = {
    utf8Bytes: value.utf8Bytes,
    chunkCount: value.chunks.length,
    chunks: value.chunks,
  };
  validateChunkMetadata(synthetic, context);
});

export const contextValueChunkMetadataSchema = chunkMetadataSchema;
export const contextValueLifecycleRecordSchema = contextValueRecordSchema;
export const contextValuePrepareInputSchema = prepareInputSchema;
export const contextValuePutCommandSchema = putCommandSchema;
export const contextValueRecoveryReasonSchema = recoveryReasonSchema;

export type ContextValueRecord = z.infer<typeof contextValueRecordSchema>;
export type ContextValuePrepareInput = z.infer<typeof prepareInputSchema>;
export type ContextValuePutCommand = z.infer<typeof putCommandSchema>;
export type ContextValueChunkMetadata = z.infer<typeof chunkMetadataSchema>;
export type ContextValueRecoveryReason = z.infer<typeof recoveryReasonSchema>;

/**
 * The SQLite implementation must compare the entire immutable input on every
 * repeated operation before returning a row. All transitions are atomic CAS
 * operations and every non-active state continues to reserve `utf8Bytes`.
 */
export interface ContextValueMetadataPort {
  prepareContextValue(input: ContextValuePrepareInput): Promise<unknown>;
  markContextValueEffectStarted(input: Readonly<{
    operationId: string;
    expectedRevision: number;
  }>): Promise<unknown>;
  markContextValueReplayRequired(input: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState: "effectStarted";
  }>): Promise<unknown>;
  activateContextValue(input: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState: "effectStarted" | "replayRequired";
    manifestDigest: string;
  }>): Promise<unknown>;
  markContextValueRecoveryRequired(input: Readonly<{
    operationId: string;
    expectedRevision: number;
    expectedState:
      | "prepared"
      | "effectStarted"
      | "replayRequired"
      | "active";
    reason: ContextValueRecoveryReason;
  }>): Promise<unknown>;
  readContextValueOperation(operationId: string): Promise<unknown>;
  readActiveContextValue(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
  }>): Promise<unknown>;
  listActiveContextValues(input: Readonly<{
    epochId: string;
    afterValueId: string | null;
    limit: number;
  }>): Promise<unknown>;
  listRecoverableContextValues(input: Readonly<{
    afterOperationId: string | null;
    limit: number;
  }>): Promise<unknown>;
}

export class ContextValueQuotaExceededError extends Error {
  constructor() {
    super("The encrypted context-value quota is exhausted.");
    this.name = "ContextValueQuotaExceededError";
  }
}

export type EncryptedContextValueErrorCode =
  | "content_mismatch"
  | "invalid_command"
  | "invalid_metadata"
  | "metadata_ambiguous"
  | "recovery_required"
  | "replay_required"
  | "value_missing";

export class EncryptedContextValueError extends Error {
  readonly code: EncryptedContextValueErrorCode;

  constructor(code: EncryptedContextValueErrorCode) {
    super({
      content_mismatch: "The encrypted context value failed verification.",
      invalid_command: "The encrypted context-value command is invalid.",
      invalid_metadata: "The encrypted context-value metadata is invalid.",
      metadata_ambiguous: "The context-value metadata outcome is ambiguous.",
      recovery_required: "The encrypted context value requires recovery.",
      replay_required: "The immutable context-value effect requires replay.",
      value_missing: "The encrypted context value is unavailable.",
    }[code]);
    this.name = "EncryptedContextValueError";
    this.code = code;
  }
}

export interface EncryptedContextValueStoreOptions {
  readonly keys: HarnessContextKeyProvider;
  readonly metadata: ContextValueMetadataPort;
  /** This boundary intentionally excludes object removal. */
  readonly objects: Pick<HarnessObjectStorePort, "publish" | "read">;
}

export interface ContextValuePutResult {
  readonly publication: "created" | "existing" | "mixed";
  readonly value: ContextValueRecord;
}

export interface ContextValueReadResult {
  readonly plaintext: string;
  readonly value: ContextValueRecord;
}

export interface ContextValueRangeReader {
  readonly value: ContextValueRecord;
  readRange(input: Readonly<{
    startByte: number;
    endByteExclusive: number;
  }>): Promise<Uint8Array>;
}

interface ConstructedValue {
  readonly intent: ContextValuePrepareInput;
  readonly chunks: readonly Uint8Array[];
  readonly manifest: Uint8Array;
}

class StoredEvidenceError extends Error {
  readonly kind: "missing" | "invalid";

  constructor(kind: "missing" | "invalid") {
    super(kind);
    this.kind = kind;
  }
}

export class EncryptedContextValueStore {
  readonly #keys: HarnessContextKeyProvider;
  readonly #metadata: ContextValueMetadataPort;
  readonly #objects: Pick<HarnessObjectStorePort, "publish" | "read">;

  constructor(options: EncryptedContextValueStoreOptions) {
    this.#keys = options.keys;
    this.#metadata = options.metadata;
    this.#objects = options.objects;
  }

  async put(commandValue: unknown): Promise<ContextValuePutResult> {
    const parsed = putCommandSchema.safeParse(commandValue);
    if (!parsed.success) throw new EncryptedContextValueError("invalid_command");
    const command = parsed.data;
    if (command.kind === "json") assertJsonValue(command.plaintext);
    const plaintext = Buffer.from(command.plaintext, "utf8");
    if (
      plaintext.byteLength > maxContextValueBytes(command.purpose) ||
      plaintext.byteLength > command.quotaLimitBytes
    ) {
      plaintext.fill(0);
      throw new EncryptedContextValueError("invalid_command");
    }
    try {
      return await this.#keys.withContextKey(command, async (contextKey) => {
        const constructed = constructValue(command, plaintext, contextKey);
        try {
          return await this.#publishConstructed(
            constructed,
            plaintext,
            contextKey,
          );
        } finally {
          constructed.manifest.fill(0);
          for (const chunk of constructed.chunks) chunk.fill(0);
        }
      });
    } finally {
      plaintext.fill(0);
    }
  }

  async recover(operationIdValue: unknown): Promise<Readonly<{
    state: "prepared" | "replayRequired" | "recoveryRequired" | "active";
    value: ContextValueRecord;
  }>> {
    const parsed = operationIdSchema.safeParse(operationIdValue);
    if (!parsed.success) throw new EncryptedContextValueError("invalid_command");
    const source = await metadataCall(() =>
      this.#metadata.readContextValueOperation(parsed.data)
    );
    if (source === null) throw new EncryptedContextValueError("value_missing");
    const value = parseRecord(source);
    if (value.operationId !== parsed.data) {
      throw new EncryptedContextValueError("invalid_metadata");
    }
    if (value.state === "prepared") return { state: "prepared", value };
    if (value.state === "recoveryRequired") {
      return { state: "recoveryRequired", value };
    }
    if (value.state === "active") {
      await this.#keys.withContextKey(value, async (contextKey) => {
        try {
          this.#readVerified(value, contextKey);
        } catch (error: unknown) {
          await this.#recoverFromEvidenceFailure(value, error, true);
        }
      });
      return { state: "active", value };
    }
    return await this.#keys.withContextKey(value, async (contextKey) => {
      try {
        const plaintext = this.#readVerified(value, contextKey);
        plaintext.fill(0);
      } catch (error: unknown) {
        if (isMissingEvidence(error)) {
          const replay = value.state === "effectStarted"
            ? await this.#markReplayRequired(value)
            : value;
          return { state: "replayRequired" as const, value: replay };
        }
        const recovery = await this.#markRecoveryRequired(
          value,
          "immutable_object_conflict",
        );
        return { state: "recoveryRequired" as const, value: recovery };
      }
      const active = await this.#activate(value);
      return { state: "active", value: active };
    });
  }

  async get(inputValue: unknown): Promise<ContextValueReadResult> {
    const parsed = valueAddressSchema.safeParse(inputValue);
    if (!parsed.success) throw new EncryptedContextValueError("invalid_command");
    const input = parsed.data;
    const source = await metadataCall(() =>
      this.#metadata.readActiveContextValue(input)
    );
    if (source === null) throw new EncryptedContextValueError("value_missing");
    const value = parseRecord(source);
    if (
      value.state !== "active" || value.epochId !== input.epochId ||
      value.ownerActorId !== input.ownerActorId ||
      value.sourceTurnId !== input.sourceTurnId || value.valueId !== input.valueId
    ) throw new EncryptedContextValueError("invalid_metadata");
    return await this.#keys.withContextKey(value, async (contextKey) => {
      let bytes: Uint8Array;
      try {
        bytes = this.#readVerified(value, contextKey);
      } catch (error: unknown) {
        await this.#recoverFromEvidenceFailure(value, error, true);
        throw new EncryptedContextValueError("recovery_required");
      }
      try {
        return { plaintext: decodePlaintext(value, bytes), value };
      } finally {
        bytes.fill(0);
      }
    });
  }

  async withRangeReader<Result>(
    inputValue: unknown,
    operation: (reader: ContextValueRangeReader) => Promise<Result> | Result,
  ): Promise<Result> {
    const parsed = valueAddressSchema.safeParse(inputValue);
    if (!parsed.success || typeof operation !== "function") {
      throw new EncryptedContextValueError("invalid_command");
    }
    const input = parsed.data;
    const source = await metadataCall(() =>
      this.#metadata.readActiveContextValue(input)
    );
    if (source === null) throw new EncryptedContextValueError("value_missing");
    const value = parseRecord(source);
    if (
      value.state !== "active" || value.epochId !== input.epochId ||
      value.ownerActorId !== input.ownerActorId ||
      value.sourceTurnId !== input.sourceTurnId || value.valueId !== input.valueId
    ) throw new EncryptedContextValueError("invalid_metadata");
    return await this.#keys.withContextKey(value, async (contextKey) => {
      const valueKey = deriveHarnessContextValueKey(contextKey, {
        version: value.version,
        operationId: value.operationId,
        epochId: value.epochId,
        ownerActorId: value.ownerActorId,
        sourceTurnId: value.sourceTurnId,
        valueId: value.valueId,
        kind: value.kind,
        purpose: value.purpose,
        schemaVersion: value.schemaVersion,
        nameDigest: value.nameDigest,
        utf8Bytes: value.utf8Bytes,
        contentDigest: value.contentDigest,
      });
      let open = true;
      try {
        try {
          this.#readVerifiedManifest(value, valueKey);
        } catch (error: unknown) {
          await this.#recoverFromEvidenceFailure(value, error, true);
        }
        const reader: ContextValueRangeReader = Object.freeze({
          value,
          readRange: async (rangeValue: Readonly<{
            startByte: number;
            endByteExclusive: number;
          }>) => {
            const range = byteRangeSchema.safeParse(rangeValue);
            if (
              !open || !range.success ||
              range.data.endByteExclusive > value.utf8Bytes
            ) throw new EncryptedContextValueError("invalid_command");
            try {
              return this.#readVerifiedRange(value, valueKey, range.data);
            } catch (error: unknown) {
              open = false;
              await this.#recoverFromEvidenceFailure(value, error, true);
              throw new EncryptedContextValueError("recovery_required");
            }
          },
        });
        return await operation(reader);
      } finally {
        open = false;
        valueKey.fill(0);
      }
    });
  }

  async list(inputValue: unknown): Promise<readonly ContextValueRecord[]> {
    const parsed = listInputSchema.safeParse(inputValue);
    if (!parsed.success) throw new EncryptedContextValueError("invalid_command");
    const input = parsed.data;
    const source = await metadataCall(() =>
      this.#metadata.listActiveContextValues(input)
    );
    if (!Array.isArray(source) || source.length > input.limit) {
      throw new EncryptedContextValueError("invalid_metadata");
    }
    const records = source.map(parseRecord);
    let previous = input.afterValueId;
    for (const record of records) {
      if (
        record.state !== "active" || record.epochId !== input.epochId ||
        (previous !== null && record.valueId <= previous)
      ) throw new EncryptedContextValueError("invalid_metadata");
      previous = record.valueId;
    }
    return records;
  }

  /** Boot-only scan; these rows remain invisible to ordinary value lookups. */
  async scanRecovery(inputValue: unknown): Promise<readonly ContextValueRecord[]> {
    const parsed = recoveryScanInputSchema.safeParse(inputValue);
    if (!parsed.success) throw new EncryptedContextValueError("invalid_command");
    const input = parsed.data;
    const source = await metadataCall(() =>
      this.#metadata.listRecoverableContextValues(input)
    );
    if (!Array.isArray(source) || source.length > input.limit) {
      throw new EncryptedContextValueError("invalid_metadata");
    }
    const records = source.map(parseRecord);
    let previous = input.afterOperationId;
    for (const record of records) {
      if (
        record.state === "active" ||
        (previous !== null && record.operationId <= previous)
      ) throw new EncryptedContextValueError("invalid_metadata");
      previous = record.operationId;
    }
    return records;
  }

  async #publishConstructed(
    constructed: ConstructedValue,
    plaintext: Uint8Array,
    contextKey: Uint8Array,
  ): Promise<ContextValuePutResult> {
    let record = parseRecord(await metadataCall(() =>
      this.#metadata.prepareContextValue(constructed.intent)
    ));
    assertRecordMatchesIntent(record, constructed.intent);
    if (record.state === "recoveryRequired") {
      throw new EncryptedContextValueError("recovery_required");
    }
    if (record.state === "active") {
      let stored: Uint8Array | null = null;
      try {
        stored = this.#readVerified(record, contextKey);
        assertEqualBytes(stored, plaintext);
      } catch (error: unknown) {
        await this.#recoverFromEvidenceFailure(record, error, true);
      } finally {
        stored?.fill(0);
      }
      return { publication: "existing", value: record };
    }
    if (record.state === "prepared") {
      const next = parseRecord(await metadataCall(() =>
        this.#metadata.markContextValueEffectStarted({
          operationId: record.operationId,
          expectedRevision: record.revision,
        })
      ));
      assertTransition(record, next, "effectStarted");
      record = next;
    }

    const publications: HarnessObjectPublication[] = [];
    try {
      for (let ordinal = 0; ordinal < constructed.chunks.length; ordinal += 1) {
        const publication = this.#objects.publish(constructed.chunks[ordinal]);
        assertPublication(publication, record.chunks[ordinal]);
        publications.push(publication);
      }
      const manifestPublication = this.#objects.publish(constructed.manifest);
      if (
        manifestPublication.digest !== record.manifestDigest ||
        manifestPublication.byteLength !== record.manifestByteLength
      ) throw new StoredEvidenceError("invalid");
      publications.push(manifestPublication);
      const stored = this.#readVerified(record, contextKey);
      try {
        assertEqualBytes(stored, plaintext);
      } finally {
        stored.fill(0);
      }
    } catch (error: unknown) {
      if (isReplayablePublicationFailure(error)) {
        if (record.state === "effectStarted") {
          await this.#markReplayRequired(record);
        }
        throw new EncryptedContextValueError("replay_required");
      }
      await this.#markRecoveryRequired(record, "immutable_object_conflict");
      throw new EncryptedContextValueError("recovery_required");
    }

    const active = await this.#activate(record);
    const created = publications.filter(({ state }) => state === "created").length;
    return {
      publication: created === 0
        ? "existing"
        : created === publications.length ? "created" : "mixed",
      value: active,
    };
  }

  #readVerified(
    value: ContextValueRecord,
    contextKey: Uint8Array,
  ): Uint8Array {
    const valueKey = deriveHarnessContextValueKey(contextKey, {
      version: value.version,
      operationId: value.operationId,
      epochId: value.epochId,
      ownerActorId: value.ownerActorId,
      sourceTurnId: value.sourceTurnId,
      valueId: value.valueId,
      kind: value.kind,
      purpose: value.purpose,
      schemaVersion: value.schemaVersion,
      nameDigest: value.nameDigest,
      utf8Bytes: value.utf8Bytes,
      contentDigest: value.contentDigest,
    });
    try {
      const encryptedManifest = readObject(this.#objects, value.manifestDigest);
      let manifestBytes: Uint8Array;
      try {
        manifestBytes = decryptRecord(
          value,
          valueKey,
          encryptedManifest,
          "manifest",
          null,
          value.manifestByteLength,
        );
      } finally {
        encryptedManifest.fill(0);
      }
      let manifest: z.infer<typeof manifestSchema>;
      try {
        manifest = parseManifest(manifestBytes);
      } finally {
        manifestBytes.fill(0);
      }
      assertManifestMatches(value, manifest);
      const plaintext = Buffer.alloc(value.utf8Bytes);
      let offset = 0;
      try {
        for (const chunk of value.chunks) {
          const encryptedChunk = readObject(this.#objects, chunk.objectDigest);
          let decrypted: Uint8Array;
          try {
            decrypted = decryptRecord(
              value,
              valueKey,
              encryptedChunk,
              "chunk",
              chunk.ordinal,
              chunk.objectByteLength,
            );
          } finally {
            encryptedChunk.fill(0);
          }
          try {
            if (decrypted.byteLength !== chunk.plaintextBytes) {
              throw new StoredEvidenceError("invalid");
            }
            plaintext.set(decrypted, offset);
            offset += decrypted.byteLength;
          } finally {
            decrypted.fill(0);
          }
        }
        if (offset !== value.utf8Bytes) throw new StoredEvidenceError("invalid");
        const aad = semanticAssociatedData(value);
        let digest: string;
        try {
          digest = keyedContentDigest(contextKey, aad, plaintext);
        } finally {
          aad.fill(0);
        }
        if (!safeDigestEqual(digest, value.contentDigest)) {
          throw new StoredEvidenceError("invalid");
        }
        return Uint8Array.from(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } catch (error: unknown) {
      if (error instanceof StoredEvidenceError) throw error;
      throw new StoredEvidenceError("invalid");
    } finally {
      valueKey.fill(0);
    }
  }

  #readVerifiedManifest(
    value: ContextValueRecord,
    valueKey: Uint8Array,
  ): void {
    const encryptedManifest = readObject(this.#objects, value.manifestDigest);
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = decryptRecord(
        value,
        valueKey,
        encryptedManifest,
        "manifest",
        null,
        value.manifestByteLength,
      );
    } finally {
      encryptedManifest.fill(0);
    }
    try {
      assertManifestMatches(value, parseManifest(manifestBytes));
    } finally {
      manifestBytes.fill(0);
    }
  }

  #readVerifiedRange(
    value: ContextValueRecord,
    valueKey: Uint8Array,
    range: Readonly<{ startByte: number; endByteExclusive: number }>,
  ): Uint8Array {
    const output = Buffer.alloc(range.endByteExclusive - range.startByte);
    if (output.byteLength === 0) return Uint8Array.from(output);
    const firstOrdinal = Math.floor(range.startByte / value.chunkSize);
    const lastOrdinal = Math.floor((range.endByteExclusive - 1) / value.chunkSize);
    let outputOffset = 0;
    try {
      for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal += 1) {
        const chunk = value.chunks[ordinal];
        if (chunk === undefined || chunk.ordinal !== ordinal) {
          throw new StoredEvidenceError("invalid");
        }
        const encryptedChunk = readObject(this.#objects, chunk.objectDigest);
        let decrypted: Uint8Array;
        try {
          decrypted = decryptRecord(
            value,
            valueKey,
            encryptedChunk,
            "chunk",
            ordinal,
            chunk.objectByteLength,
          );
        } finally {
          encryptedChunk.fill(0);
        }
        try {
          if (decrypted.byteLength !== chunk.plaintextBytes) {
            throw new StoredEvidenceError("invalid");
          }
          const chunkStart = ordinal * value.chunkSize;
          const copyStart = Math.max(range.startByte, chunkStart) - chunkStart;
          const copyEnd = Math.min(
            range.endByteExclusive,
            chunkStart + decrypted.byteLength,
          ) - chunkStart;
          output.set(decrypted.subarray(copyStart, copyEnd), outputOffset);
          outputOffset += copyEnd - copyStart;
        } finally {
          decrypted.fill(0);
        }
      }
      if (outputOffset !== output.byteLength) {
        throw new StoredEvidenceError("invalid");
      }
      return Uint8Array.from(output);
    } finally {
      output.fill(0);
    }
  }

  async #activate(value: ContextValueRecord): Promise<ContextValueRecord> {
    if (value.state !== "effectStarted" && value.state !== "replayRequired") {
      throw new EncryptedContextValueError("invalid_metadata");
    }
    const expectedState: "effectStarted" | "replayRequired" = value.state;
    const active = parseRecord(await metadataCall(() =>
      this.#metadata.activateContextValue({
        operationId: value.operationId,
        expectedRevision: value.revision,
        expectedState,
        manifestDigest: value.manifestDigest,
      })
    ));
    assertTransition(value, active, "active");
    return active;
  }

  async #markReplayRequired(
    value: ContextValueRecord,
  ): Promise<ContextValueRecord> {
    if (value.state === "replayRequired") return value;
    if (value.state !== "effectStarted") {
      throw new EncryptedContextValueError("invalid_metadata");
    }
    const replay = parseRecord(await metadataCall(() =>
      this.#metadata.markContextValueReplayRequired({
        operationId: value.operationId,
        expectedRevision: value.revision,
        expectedState: "effectStarted",
      })
    ));
    assertTransition(value, replay, "replayRequired");
    return replay;
  }

  async #markRecoveryRequired(
    value: ContextValueRecord,
    reason: ContextValueRecoveryReason,
  ): Promise<ContextValueRecord> {
    if (value.state === "recoveryRequired") return value;
    const expectedState:
      | "prepared" | "effectStarted" | "replayRequired" | "active" =
        value.state;
    const recovery = parseRecord(await metadataCall(() =>
      this.#metadata.markContextValueRecoveryRequired({
        operationId: value.operationId,
        expectedRevision: value.revision,
        expectedState,
        reason,
      })
    ));
    assertTransition(value, recovery, "recoveryRequired");
    if (recovery.recoveryReason !== reason) {
      throw new EncryptedContextValueError("invalid_metadata");
    }
    return recovery;
  }

  async #recoverFromEvidenceFailure(
    value: ContextValueRecord,
    error: unknown,
    activated: boolean,
  ): Promise<never> {
    await this.#markRecoveryRequired(
      value,
      activated && isMissingEvidence(error)
        ? "object_missing_after_activation"
        : "immutable_object_conflict",
    );
    throw new EncryptedContextValueError("recovery_required");
  }
}

function constructValue(
  command: ContextValuePutCommand,
  plaintext: Uint8Array,
  contextKey: Uint8Array,
): ConstructedValue {
  const semanticAad = semanticAssociatedData({
    ...command,
    utf8Bytes: plaintext.byteLength,
  });
  const contentDigest = keyedContentDigest(contextKey, semanticAad, plaintext);
  const keyIdentity = {
    version: 2 as const,
    operationId: command.operationId,
    epochId: command.epochId,
    ownerActorId: command.ownerActorId,
    sourceTurnId: command.sourceTurnId,
    valueId: command.valueId,
    kind: command.kind,
    purpose: command.purpose,
    schemaVersion: command.schemaVersion,
    nameDigest: command.nameDigest,
    utf8Bytes: plaintext.byteLength,
    contentDigest,
  };
  const valueKey = deriveHarnessContextValueKey(contextKey, keyIdentity);
  try {
    const chunks: Uint8Array[] = [];
    const chunkMetadata: ContextValueChunkMetadata[] = [];
    const count = Math.max(1, Math.ceil(plaintext.byteLength / CONTEXT_VALUE_CHUNK_BYTES));
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const start = ordinal * CONTEXT_VALUE_CHUNK_BYTES;
      const end = Math.min(start + CONTEXT_VALUE_CHUNK_BYTES, plaintext.byteLength);
      const chunkPlaintext = plaintext.subarray(start, end);
      const encrypted = encryptRecord(
        keyIdentity,
        valueKey,
        "chunk",
        ordinal,
        chunkPlaintext,
      );
      chunks.push(encrypted);
      chunkMetadata.push({
        ordinal,
        plaintextBytes: chunkPlaintext.byteLength,
        objectDigest: harnessObjectDigest(encrypted),
        objectByteLength: encrypted.byteLength,
      });
    }
    const manifestPlaintext = Buffer.from(JSON.stringify({
      domain: "oprte-context-value-manifest",
      version: 2,
      utf8Bytes: plaintext.byteLength,
      contentDigest,
      chunkSize: CONTEXT_VALUE_CHUNK_BYTES,
      chunks: chunkMetadata,
    }), "utf8");
    let manifest: Uint8Array;
    try {
      manifest = encryptRecord(
        keyIdentity,
        valueKey,
        "manifest",
        null,
        manifestPlaintext,
      );
    } finally {
      manifestPlaintext.fill(0);
    }
    const intent = prepareInputSchema.parse({
      ...keyIdentity,
      nameDigest: command.nameDigest,
      utf8Bytes: plaintext.byteLength,
      chunkSize: CONTEXT_VALUE_CHUNK_BYTES,
      chunkCount: chunkMetadata.length,
      chunks: chunkMetadata,
      manifestDigest: harnessObjectDigest(manifest),
      manifestByteLength: manifest.byteLength,
      quotaLimitBytes: command.quotaLimitBytes,
    });
    return { intent, chunks, manifest };
  } finally {
    valueKey.fill(0);
    semanticAad.fill(0);
  }
}

function semanticAssociatedData(value: Readonly<{
  version: 2;
  operationId: string;
  epochId: string;
  ownerActorId: string;
  sourceTurnId: string | null;
  valueId: string;
  kind: z.infer<typeof valueKindSchema>;
  purpose: z.infer<typeof valuePurposeSchema>;
  schemaVersion: 1;
  nameDigest?: string | null;
  utf8Bytes: number;
}>): Uint8Array {
  return Buffer.from(JSON.stringify({
    domain: "oprte-context-value",
    version: value.version,
    operationId: value.operationId,
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
    kind: value.kind,
    purpose: value.purpose,
    schemaVersion: value.schemaVersion,
    nameDigest: value.nameDigest ?? null,
    utf8Bytes: value.utf8Bytes,
  }), "utf8");
}

function recordAssociatedData(
  value: Pick<ContextValueRecord,
    | "version" | "operationId" | "epochId" | "ownerActorId"
    | "sourceTurnId" | "valueId" | "kind"
    | "purpose" | "schemaVersion" | "nameDigest" | "contentDigest"
    | "utf8Bytes"
  >,
  record: "manifest" | "chunk",
  ordinal: number | null,
): Uint8Array {
  return Buffer.from(JSON.stringify({
    domain: "oprte-context-value-record",
    version: value.version,
    operationId: value.operationId,
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
    kind: value.kind,
    purpose: value.purpose,
    schemaVersion: value.schemaVersion,
    nameDigest: value.nameDigest,
    contentDigest: value.contentDigest,
    utf8Bytes: value.utf8Bytes,
    record,
    ordinal,
  }), "utf8");
}

export function contextValueRecordNonce(
  recordValue: unknown,
  ordinalValue: unknown,
): Uint8Array {
  const record = z.enum(["manifest", "chunk"]).safeParse(recordValue);
  const ordinal = z.number().int().min(0)
    .max(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS - 1)
    .safeParse(ordinalValue);
  if (!record.success || (record.data === "chunk" && !ordinal.success)) {
    throw new EncryptedContextValueError("invalid_command");
  }
  if (record.data === "manifest" && ordinalValue !== null) {
    throw new EncryptedContextValueError("invalid_command");
  }
  const nonce = Buffer.alloc(12);
  nonce.set(record.data === "manifest"
    ? [0x4f, 0x50, 0x4d, 0x02]
    : [0x4f, 0x50, 0x43, 0x02], 0);
  const nonceOrdinal = record.data === "manifest"
    ? 0
    : ordinal.success ? ordinal.data : 0;
  nonce.writeBigUInt64BE(BigInt(nonceOrdinal), 4);
  return nonce;
}

function encryptRecord(
  value: Parameters<typeof recordAssociatedData>[0],
  key: Uint8Array,
  record: "manifest" | "chunk",
  ordinal: number | null,
  plaintext: Uint8Array,
): Uint8Array {
  const nonce = contextValueRecordNonce(record, ordinal);
  const aad = recordAssociatedData(value, record, ordinal);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    try {
      return Buffer.from(JSON.stringify({
        version: 2,
        cipher: "aes-256-gcm",
        record,
        ordinal,
        nonce: Buffer.from(nonce).toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authenticationTag: tag.toString("base64url"),
      }), "utf8");
    } finally {
      ciphertext.fill(0);
      tag.fill(0);
    }
  } finally {
    nonce.fill(0);
    aad.fill(0);
  }
}

function decryptRecord(
  value: ContextValueRecord,
  key: Uint8Array,
  object: Uint8Array,
  record: "manifest" | "chunk",
  ordinal: number | null,
  expectedObjectBytes: number,
): Uint8Array {
  if (object.byteLength !== expectedObjectBytes) throw new StoredEvidenceError("invalid");
  let source: unknown;
  try {
    source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object)) as unknown;
  } catch {
    throw new StoredEvidenceError("invalid");
  }
  const parsed = encryptedRecordSchema.safeParse(source);
  if (
    !parsed.success || parsed.data.record !== record ||
    parsed.data.ordinal !== ordinal
  ) throw new StoredEvidenceError("invalid");
  const expectedNonce = contextValueRecordNonce(record, ordinal);
  const nonce = decodeCanonicalBase64Url(parsed.data.nonce, 12);
  const ciphertext = decodeCanonicalBase64Url(parsed.data.ciphertext);
  const tag = decodeCanonicalBase64Url(parsed.data.authenticationTag, 16);
  const aad = recordAssociatedData(value, record, ordinal);
  try {
    if (!timingSafeEqual(expectedNonce, nonce)) throw new StoredEvidenceError("invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    try {
      return Uint8Array.from(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof StoredEvidenceError) throw error;
    throw new StoredEvidenceError("invalid");
  } finally {
    expectedNonce.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
    aad.fill(0);
  }
}

function keyedContentDigest(
  contextKey: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): string {
  const digestKey = deriveHarnessContextDigestKey(contextKey);
  try {
    return createHmac("sha256", digestKey)
      .update("OPRTE context value content digest v2\u0000", "utf8")
      .update(aad)
      .update(plaintext)
      .digest("hex");
  } finally {
    digestKey.fill(0);
  }
}

function readObject(
  objects: Pick<HarnessObjectStorePort, "read">,
  digest: string,
): Uint8Array {
  try {
    return objects.read(digest);
  } catch (error: unknown) {
    if (
      error instanceof HarnessObjectStoreError && error.code === "object_missing"
    ) throw new StoredEvidenceError("missing");
    throw new StoredEvidenceError("invalid");
  }
}

function parseManifest(bytes: Uint8Array): z.infer<typeof manifestSchema> {
  let source: unknown;
  try {
    source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new StoredEvidenceError("invalid");
  }
  const parsed = manifestSchema.safeParse(source);
  if (!parsed.success) throw new StoredEvidenceError("invalid");
  return parsed.data;
}

function assertManifestMatches(
  value: ContextValueRecord,
  manifest: z.infer<typeof manifestSchema>,
): void {
  if (
    manifest.utf8Bytes !== value.utf8Bytes ||
    manifest.contentDigest !== value.contentDigest ||
    manifest.chunkSize !== value.chunkSize ||
    JSON.stringify(manifest.chunks) !== JSON.stringify(value.chunks)
  ) throw new StoredEvidenceError("invalid");
}

function validateChunkMetadata(
  value: Readonly<{
    utf8Bytes: number;
    chunkCount: number;
    chunks: readonly ContextValueChunkMetadata[];
  }>,
  context: z.RefinementCtx,
): void {
  const expectedCount = Math.max(
    1,
    Math.ceil(value.utf8Bytes / CONTEXT_VALUE_CHUNK_BYTES),
  );
  if (value.chunkCount !== expectedCount || value.chunks.length !== expectedCount) {
    context.addIssue({ code: "custom", message: "invalid context-value chunk count" });
    return;
  }
  let bytes = 0;
  for (let ordinal = 0; ordinal < value.chunks.length; ordinal += 1) {
    const chunk = value.chunks[ordinal];
    if (chunk === undefined) {
      context.addIssue({ code: "custom", message: "missing context-value chunk" });
      return;
    }
    const expectedBytes = value.utf8Bytes === 0
      ? 0
      : Math.min(CONTEXT_VALUE_CHUNK_BYTES, value.utf8Bytes - bytes);
    if (chunk.ordinal !== ordinal || chunk.plaintextBytes !== expectedBytes) {
      context.addIssue({ code: "custom", message: "invalid context-value chunk layout" });
      return;
    }
    bytes += chunk.plaintextBytes;
  }
  if (bytes !== value.utf8Bytes) {
    context.addIssue({ code: "custom", message: "invalid context-value byte total" });
  }
}

function validateValueCapacity(
  value: Readonly<{
    purpose: z.infer<typeof valuePurposeSchema>;
    kind: z.infer<typeof valueKindSchema>;
    utf8Bytes: number;
    chunkCount: number;
    chunks: readonly ContextValueChunkMetadata[];
  }>,
  context: z.RefinementCtx,
): void {
  const maxBytes = maxContextValueBytes(value.purpose);
  const maxChunks = maxContextValueChunks(value.purpose);
  if (value.utf8Bytes > maxBytes) {
    context.addIssue({
      code: "custom",
      message: "context value exceeds its purpose-specific byte limit",
      path: ["utf8Bytes"],
    });
  }
  if (value.chunkCount > maxChunks || value.chunks.length > maxChunks) {
    context.addIssue({
      code: "custom",
      message: "context value exceeds its purpose-specific chunk limit",
      path: ["chunkCount"],
    });
  }
  if (value.purpose === "completedPrefix" && value.kind !== "selection") {
    context.addIssue({
      code: "custom",
      message: "completed-prefix values must use the indexed selection kind",
      path: ["kind"],
    });
  }
  validateChunkMetadata(value, context);
}

export function maxContextValueBytes(
  purpose: z.infer<typeof valuePurposeSchema>,
): number {
  return purpose === "completedPrefix"
    ? COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES
    : CONTEXT_VALUE_MAX_BYTES;
}

export function maxContextValueChunks(
  purpose: z.infer<typeof valuePurposeSchema>,
): number {
  return purpose === "completedPrefix"
    ? COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS
    : CONTEXT_VALUE_MAX_CHUNKS;
}

function parseRecord(value: unknown): ContextValueRecord {
  const parsed = contextValueRecordSchema.safeParse(value);
  if (!parsed.success) throw new EncryptedContextValueError("invalid_metadata");
  return parsed.data;
}

function assertRecordMatchesIntent(
  record: ContextValueRecord,
  intent: ContextValuePrepareInput,
): void {
  if (
    JSON.stringify(immutableMetadata(record)) !==
      JSON.stringify(immutableMetadata(intent))
  ) {
    throw new EncryptedContextValueError("invalid_metadata");
  }
}

function assertTransition(
  before: ContextValueRecord,
  after: ContextValueRecord,
  expectedState: ContextValueRecord["state"],
): void {
  if (after.state !== expectedState || after.revision <= before.revision) {
    throw new EncryptedContextValueError("invalid_metadata");
  }
  if (
    JSON.stringify(immutableMetadata(before)) !==
      JSON.stringify(immutableMetadata(after))
  ) {
    throw new EncryptedContextValueError("invalid_metadata");
  }
}

function immutableMetadata(
  value: ContextValueRecord | ContextValuePrepareInput,
): ContextValuePrepareInput {
  return {
    version: value.version,
    operationId: value.operationId,
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
    kind: value.kind,
    purpose: value.purpose,
    schemaVersion: value.schemaVersion,
    nameDigest: value.nameDigest,
    utf8Bytes: value.utf8Bytes,
    contentDigest: value.contentDigest,
    chunkSize: value.chunkSize,
    chunkCount: value.chunkCount,
    chunks: value.chunks,
    manifestDigest: value.manifestDigest,
    manifestByteLength: value.manifestByteLength,
    quotaLimitBytes: value.quotaLimitBytes,
  };
}

function assertPublication(
  publication: HarnessObjectPublication,
  chunk: ContextValueChunkMetadata | undefined,
): void {
  if (
    chunk === undefined || publication.digest !== chunk.objectDigest ||
    publication.byteLength !== chunk.objectByteLength
  ) throw new StoredEvidenceError("invalid");
}

function decodePlaintext(value: ContextValueRecord, bytes: Uint8Array): string {
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (Buffer.byteLength(decoded, "utf8") !== value.utf8Bytes) {
      throw new EncryptedContextValueError("content_mismatch");
    }
    if (value.kind === "json") assertJsonValue(decoded);
    return decoded;
  } catch (error: unknown) {
    if (error instanceof EncryptedContextValueError) throw error;
    throw new EncryptedContextValueError("content_mismatch");
  }
}

function assertEqualBytes(actual: Uint8Array, expected: Uint8Array): void {
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) throw new EncryptedContextValueError("content_mismatch");
}

function decodeCanonicalBase64Url(value: string, byteLength?: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    (byteLength !== undefined && decoded.byteLength !== byteLength) ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    throw new StoredEvidenceError("invalid");
  }
  return decoded;
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  try {
    return leftBytes.byteLength === rightBytes.byteLength &&
      timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function isMissingEvidence(error: unknown): boolean {
  return error instanceof StoredEvidenceError && error.kind === "missing";
}

function isReplayablePublicationFailure(error: unknown): boolean {
  return isMissingEvidence(error) ||
    (error instanceof HarnessObjectStoreError && error.code === "publish_failed");
}

async function metadataCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (
      error instanceof EncryptedContextValueError ||
      error instanceof ContextValueQuotaExceededError
    ) throw error;
    throw new EncryptedContextValueError("metadata_ambiguous");
  }
}

function assertJsonValue(value: string): void {
  try {
    JSON.parse(value) as unknown;
  } catch {
    throw new EncryptedContextValueError("invalid_command");
  }
}
