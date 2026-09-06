import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { OH_CONTRACT_MANIFEST_V1 } from "@hraness/oh";
import { OH_MEMORY_LIMITS_V1 } from "@hraness/oh/memory";
import {
  createOhSqliteStoreAuthorityV1,
  openOhSqliteDatabase,
  type OhSqliteCanonicalReplicationV1,
  type OhSqliteDatabase,
  type OhSqliteStoreAuthorityV1,
} from "@hraness/oh/sqlite";
import {
  OH_CANONICAL_STORE_PROFILE_V1,
  OH_WORKING_STORE_PROFILE_V1,
  emptyOhHeadV1,
  isOhConflictError,
  parseOhHeadV1,
  parseOhHeadRefV1,
  parseOhStoreBindingV1,
  type OhHeadRefV1,
  type OhHeadV1,
  type OhStoreAuthorityV1,
  type OhStoreV1,
} from "@hraness/oh/store";
import { z } from "zod";

import {
  digestFactsMemoryInspection,
  digestFactsMemoryReceipt,
  factsMemoryBindingSchema,
  factsMemoryCheckpointSchema,
  factsMemoryDigestSchema,
  factsMemoryHeadSchema,
  factsMemoryStoreInspectionSchema,
  factsMemoryStoreReceiptSchema,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryHead,
  type FactsMemoryStoreInspection,
  type FactsMemoryStoreReceipt,
} from "../domain/facts-memory";
import { digestProjectMemoryOhHead } from "../domain/project-memory";
import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "../domain/values";
import type { FactsMemoryBrokerInspection } from "../daemon/facts-memory-lifecycle";
import type { LocalOhFactsMemoryEnginePort } from "./local-facts-memory-broker";

const adapterMetadataName = ".hra-oh-adapter-v1.json";
const adapterMetadataPendingName = ".hra-oh-adapter-v1.pending";
const adapterMetadataMigrationName = ".hra-oh-adapter-v1.migrating";
const databaseName = "oh.sqlite";
const operationKeySchema = z.string().min(1).max(200);
const maximumForkRecords = 8_192;
const metadataMaximumBytes = 16 * 1024;
const hostActorId = "hra.memory.host";

export type OhSqliteDatabaseFileIdentity = Readonly<{
  device: number;
  inode: number;
}>;

export type OhCanonicalDatabaseInspection =
  | Readonly<{ state: "absent" }>
  | Readonly<{ file: OhSqliteDatabaseFileIdentity; state: "present" }>;

export type OhCanonicalDatabaseInspectionFailure = "unavailable" | "unsafe";

export class OhCanonicalDatabaseInspectionError extends Error {
  constructor(
    readonly failure: OhCanonicalDatabaseInspectionFailure,
    cause?: unknown,
  ) {
    super(
      failure === "unsafe"
        ? "FACTS_MEMORY_OH_CANONICAL_DATABASE_UNSAFE"
        : "FACTS_MEMORY_OH_CANONICAL_DATABASE_INSPECTION_UNAVAILABLE",
      { cause },
    );
    this.name = "OhCanonicalDatabaseInspectionError";
  }
}

export const HRA_OH_FACTS_MEMORY_LIMITS_V1 = Object.freeze({
  forkSnapshotBytes: OH_MEMORY_LIMITS_V1.snapshotBytesPerLane,
  // Oh persists an operation, its live records, search documents, and FTS
  // materialization. Keep bounded room for that storage amplification while
  // retaining a hard local database-plus-WAL ceiling.
  sqliteLogicalBytes: 16 * OH_MEMORY_LIMITS_V1.snapshotBytesPerLane,
});

export class OhFactsMemoryCustodyError extends Error {
  constructor(
    readonly lane: "canonical" | "working",
    code: string,
    cause: unknown,
  ) {
    super(code, { cause });
    this.name = "OhFactsMemoryCustodyError";
  }
}

const errorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error ? String(error.code) : null;

const custodyError = (
  lane: "canonical" | "working",
  error: unknown,
): Error => {
  if (error instanceof OhFactsMemoryCustodyError) return error;
  const code = error instanceof Error ? error.message : "";
  const externalCode = errorCode(error);
  if (externalCode === "SQLITE_FULL") {
    return new Error("FACTS_MEMORY_OH_DATABASE_TOO_LARGE", { cause: error });
  }
  if (externalCode !== null && (
    externalCode.startsWith("SQLITE_BUSY")
    || externalCode.startsWith("SQLITE_LOCKED")
  )) return new Error("FACTS_MEMORY_OH_DATABASE_BUSY", { cause: error });
  if (externalCode !== null && (
    externalCode.startsWith("SQLITE_CANTOPEN")
    || externalCode.startsWith("SQLITE_IOERR")
    || externalCode.startsWith("SQLITE_NOMEM")
    || externalCode.startsWith("SQLITE_PROTOCOL")
    || externalCode.startsWith("SQLITE_READONLY")
    || new Set([
      "EACCES", "EIO", "EMFILE", "ENFILE", "ENOMEM", "ENOSPC", "EPERM", "EROFS",
    ]).has(externalCode)
  )) return new Error("FACTS_MEMORY_OH_DATABASE_UNAVAILABLE", { cause: error });
  if (new Set([
    "FACTS_MEMORY_OH_DATABASE_BUSY",
    "FACTS_MEMORY_OH_DATABASE_TOO_LARGE",
    "FACTS_MEMORY_OH_DATABASE_LIMIT_UNAVAILABLE",
    "FACTS_MEMORY_OH_DATABASE_UNAVAILABLE",
  ]).has(code)) return error instanceof Error ? error : new Error(code);
  const stableCode = code.startsWith(`FACTS_MEMORY_OH_${lane.toUpperCase()}_`)
    ? code
    : `FACTS_MEMORY_OH_${lane.toUpperCase()}_INTEGRITY_ERROR`;
  return new OhFactsMemoryCustodyError(lane, stableCode, error);
};

const sqliteWalHeaderBytes = 32;
const sqliteWalFrameHeaderBytes = 24;

const adapterMetadataSchema = z.object({
  adapterDigest: factsMemoryDigestSchema,
  bindingDigest: factsMemoryDigestSchema,
  createdAt: unixMillisecondsSchema,
  createKind: z.enum(["create", "fork"]),
  handleHash: factsMemoryDigestSchema,
  initialHead: factsMemoryHeadSchema,
  ohBindingSha256: factsMemoryDigestSchema,
  operationKey: operationKeySchema,
  parent: factsMemoryCheckpointSchema.nullable(),
  receiptDigest: factsMemoryDigestSchema,
  version: z.literal(1),
}).strict().superRefine((value, context) => {
  if ((value.createKind === "create") !== (value.parent === null)) {
    context.addIssue({ code: "custom", message: "Oh adapter creation kind and parent disagree." });
  }
});

type AdapterMetadata = z.infer<typeof adapterMetadataSchema>;
const legacyHeadSchema = z.object({
  digest: factsMemoryDigestSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const legacyCheckpointSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  head: legacyHeadSchema,
  ownerId: profileIdSchema,
  sessionId: sessionIdSchema,
}).strict();
const legacyAdapterMetadataSchema = z.object({
  adapterDigest: factsMemoryDigestSchema,
  bindingDigest: factsMemoryDigestSchema,
  createdAt: unixMillisecondsSchema,
  createKind: z.enum(["create", "fork"]),
  handleHash: factsMemoryDigestSchema,
  initialHead: legacyHeadSchema,
  ohBindingSha256: factsMemoryDigestSchema,
  operationKey: operationKeySchema,
  parent: legacyCheckpointSchema.nullable(),
  receiptDigest: factsMemoryDigestSchema,
  version: z.literal(1),
}).strict().superRefine((value, context) => {
  if ((value.createKind === "create") !== (value.parent === null)) {
    context.addIssue({ code: "custom", message: "Legacy Oh adapter creation kind and parent disagree." });
  }
});
type LegacyAdapterMetadata = z.infer<typeof legacyAdapterMetadataSchema>;
type ParsedAdapterMetadata = Readonly<{ legacy: boolean; metadata: AdapterMetadata }>;
type CleanupMetadataAuthority = Readonly<{
  bindingDigest: string;
  handleHash: string;
  ohBindingSha256: string;
}>;
type PendingMetadata =
  | Readonly<{ status: "complete"; metadata: AdapterMetadata }>
  | Readonly<{ status: "incomplete" }>
  | Readonly<{ status: "missing" }>;

const normalizeLegacyMetadata = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const metadata = { ...(value as Record<string, unknown>) };
  if (
    metadata.initialHead !== null
    && typeof metadata.initialHead === "object"
    && !Array.isArray(metadata.initialHead)
  ) {
    const head = { ...(metadata.initialHead as Record<string, unknown>) };
    if (!Object.hasOwn(head, "operationSha256") && head.sequence === 0) {
      head.operationSha256 = null;
    }
    metadata.initialHead = head;
  }
  if (metadata.parent !== null && typeof metadata.parent === "object" && !Array.isArray(metadata.parent)) {
    const parent = { ...(metadata.parent as Record<string, unknown>) };
    if (!Object.hasOwn(parent, "epoch")) parent.epoch = 1;
    if (parent.head !== null && typeof parent.head === "object" && !Array.isArray(parent.head)) {
      const head = { ...(parent.head as Record<string, unknown>) };
      if (!Object.hasOwn(head, "operationSha256") && head.sequence === 0) {
        head.operationSha256 = null;
      }
      parent.head = head;
    }
    metadata.parent = parent;
  }
  return metadata;
};

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

export const digestOhHead = digestProjectMemoryOhHead;

export const projectOhHead = (value: unknown): FactsMemoryHead => {
  const head = parseOhHeadV1(value);
  if (head === null) throw new Error("FACTS_MEMORY_OH_HEAD_INVALID");
  return factsMemoryHeadSchema.parse({
    digest: digestOhHead(head),
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  });
};

const ohHeadRef = (head: FactsMemoryHead) => {
  const value = parseOhHeadRefV1({
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  });
  if (value === null) throw new Error("FACTS_MEMORY_OH_HEAD_INVALID");
  return value;
};

const metadataDigest = (value: Omit<AdapterMetadata, "adapterDigest">): string =>
  digestParts("hra-oh-adapter-metadata-v1", [
    value.bindingDigest,
    String(value.createdAt),
    value.createKind,
    value.handleHash,
    String(value.initialHead.sequence),
    ...(value.initialHead.operationSha256 === null ? [] : [value.initialHead.operationSha256]),
    value.initialHead.digest,
    value.ohBindingSha256,
    value.operationKey,
    value.parent?.bindingDigest ?? "no-parent",
    ...(value.parent === null || value.parent.epoch === 1 ? [] : [String(value.parent.epoch)]),
    value.parent?.ownerId ?? "no-parent",
    value.parent?.sessionId ?? "no-parent",
    value.parent === null ? "no-parent" : String(value.parent.head.sequence),
    value.parent?.head.operationSha256 ?? "no-parent",
    value.parent?.head.digest ?? "no-parent",
    value.receiptDigest,
    String(value.version),
  ]);

const legacyMetadataDigest = (value: Omit<LegacyAdapterMetadata, "adapterDigest">): string =>
  digestParts("hra-oh-adapter-metadata-v1", [
    value.bindingDigest,
    String(value.createdAt),
    value.createKind,
    value.handleHash,
    String(value.initialHead.sequence),
    value.initialHead.digest,
    value.ohBindingSha256,
    value.operationKey,
    value.parent?.bindingDigest ?? "no-parent",
    value.parent?.ownerId ?? "no-parent",
    value.parent?.sessionId ?? "no-parent",
    value.parent === null ? "no-parent" : String(value.parent.head.sequence),
    value.parent?.head.digest ?? "no-parent",
    value.receiptDigest,
    String(value.version),
  ]);

const legacyReceiptDigest = (value: LegacyAdapterMetadata): string =>
  digestParts("hra-facts-memory-store-receipt-v1", [
    value.bindingDigest,
    value.handleHash,
    String(value.initialHead.sequence),
    value.initialHead.digest,
    String(value.createdAt),
  ]);

const parseAdapterMetadata = (value: unknown): ParsedAdapterMetadata => {
  const normalized = adapterMetadataSchema.safeParse(normalizeLegacyMetadata(value));
  if (normalized.success) {
    const { adapterDigest, ...body } = normalized.data;
    if (metadataDigest(body) === adapterDigest) {
      return { legacy: false, metadata: normalized.data };
    }
  }
  const legacy = legacyAdapterMetadataSchema.safeParse(value);
  if (!legacy.success) {
    if (normalized.success) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
    throw normalized.error;
  }
  const { adapterDigest, ...legacyBody } = legacy.data;
  if (legacyMetadataDigest(legacyBody) !== adapterDigest) {
    throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
  }
  if (
    legacy.data.initialHead.sequence !== 0
    || (legacy.data.parent !== null && legacy.data.parent.head.sequence !== 0)
  ) {
    throw new Error("FACTS_MEMORY_OH_LEGACY_NONEMPTY_RECOVERY_REQUIRED");
  }
  const normalizedLegacy = normalizeLegacyMetadata(legacy.data);
  if (normalizedLegacy === null || typeof normalizedLegacy !== "object" || Array.isArray(normalizedLegacy)) {
    throw new Error("FACTS_MEMORY_OH_METADATA_INVALID");
  }
  const currentWithPlaceholder = adapterMetadataSchema.parse({
    ...(normalizedLegacy as Record<string, unknown>),
    adapterDigest: "0".repeat(64),
  });
  return {
    legacy: true,
    metadata: adapterMetadataSchema.parse({
      ...currentWithPlaceholder,
      adapterDigest: metadataDigest(currentWithPlaceholder),
    }),
  };
};

const receiptFromMetadata = (metadata: AdapterMetadata): FactsMemoryStoreReceipt =>
  factsMemoryStoreReceiptSchema.parse({
    bindingDigest: metadata.bindingDigest,
    createdAt: metadata.createdAt,
    handleHash: metadata.handleHash,
    head: metadata.initialHead,
    receiptDigest: metadata.receiptDigest,
    version: metadata.version,
  });

const checkpointsEqual = (
  left: FactsMemoryCheckpoint | null,
  right: FactsMemoryCheckpoint | null,
): boolean => left === null || right === null
  ? left === right
  : left.bindingDigest === right.bindingDigest
    && left.epoch === right.epoch
    && left.ownerId === right.ownerId
    && left.sessionId === right.sessionId
    && left.head.sequence === right.head.sequence
    && left.head.operationSha256 === right.head.operationSha256
    && left.head.digest === right.head.digest;

const asSqlitePragmaInteger = (value: unknown, key: string): number => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FACTS_MEMORY_OH_DATABASE_LIMIT_UNAVAILABLE");
  }
  const integer = (value as Record<string, unknown>)[key];
  if (!Number.isSafeInteger(integer) || (integer as number) < 0) {
    throw new Error("FACTS_MEMORY_OH_DATABASE_LIMIT_UNAVAILABLE");
  }
  return integer as number;
};

const maximumBoundedSqlitePages = (pageSize: number): number => {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("FACTS_MEMORY_OH_DATABASE_LIMIT_UNAVAILABLE");
  }
  // With cache spilling disabled, one transaction writes at most one WAL
  // frame per database page. Reserving both the main page and its largest WAL
  // frame keeps the durable database plus WAL below the public byte ceiling,
  // including a checkpointed WAL file that retains its high-water size.
  const pages = Math.floor(
    (HRA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes - sqliteWalHeaderBytes)
      / (2 * pageSize + sqliteWalFrameHeaderBytes),
  );
  if (pages < 1) throw new Error("FACTS_MEMORY_OH_DATABASE_LIMIT_UNAVAILABLE");
  return pages;
};

const configureBoundedSqliteDatabase = (
  database: OhSqliteDatabase,
  directory: string,
): void => {
  const checkpoint = database.query<{
    busy: number;
    checkpointed: number;
    log: number;
  }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint === null || checkpoint.busy !== 0) {
    throw new Error("FACTS_MEMORY_OH_DATABASE_BUSY");
  }
  assertBoundedLogicalDatabase(directory);

  const pageSize = asSqlitePragmaInteger(
    database.query<{ page_size: number }, []>("PRAGMA page_size").get(),
    "page_size",
  );
  const maximumPages = maximumBoundedSqlitePages(pageSize);
  const configuredMaximum = asSqlitePragmaInteger(
    database.query<Record<string, number>, []>(
      `PRAGMA max_page_count = ${String(maximumPages)}`,
    ).get(),
    "max_page_count",
  );
  const currentPages = asSqlitePragmaInteger(
    database.query<{ page_count: number }, []>("PRAGMA page_count").get(),
    "page_count",
  );
  if (configuredMaximum !== maximumPages || currentPages > maximumPages) {
    throw new Error("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");
  }

  // A dirty page may otherwise be spilled to the WAL and written again in the
  // same transaction, invalidating the one-frame-per-page bound above.
  database.exec("PRAGMA cache_spill = OFF");
  database.exec("PRAGMA wal_autocheckpoint = 1");
};

const translateSqliteCapacityError = (error: unknown): never => {
  if (errorCode(error) === "SQLITE_FULL") {
    throw new Error("FACTS_MEMORY_OH_DATABASE_TOO_LARGE", { cause: error });
  }
  throw error;
};

const guardOhStoreCapacity = (store: OhStoreV1): OhStoreV1 => {
  const guarded: OhStoreV1 = {
    binding: store.binding,
    changesSince: async (from, options) => await store.changesSince(from, options),
    close: async () => await store.close(),
    commit: async (input) => {
      try {
        return await store.commit(input);
      } catch (error: unknown) {
        return translateSqliteCapacityError(error);
      }
    },
    exportDependencyClosure: async (input) => await store.exportDependencyClosure(input),
    head: async () => await store.head(),
    snapshot: async (options) => await store.snapshot(options),
    verify: async () => await store.verify(),
  };
  return Object.freeze(guarded);
};

const guardWorkingOnlyEphemeralStore = (store: OhStoreV1): OhStoreV1 => {
  const guarded: OhStoreV1 = {
    binding: store.binding,
    changesSince: async (from, options) => await store.changesSince(from, options),
    close: async () => {
      throw new Error("FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_HOST_OWNED");
    },
    commit: async () => {
      throw new Error("FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_READ_ONLY");
    },
    exportDependencyClosure: async (input) => await store.exportDependencyClosure(input),
    head: async () => await store.head(),
    snapshot: async (options) => await store.snapshot(options),
    verify: async () => await store.verify(),
  };
  return Object.freeze(guarded);
};

const workingOnlyEphemeralError = (
  error: unknown,
  code = "FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_INTEGRITY_ERROR",
): Error => {
  if (
    error instanceof Error
    && error.message.startsWith("FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_")
  ) return error;
  return new Error(code, { cause: error });
};

export type OhPinnedCanonicalReplicationV1 = Readonly<{
  exportBundle(input: Readonly<{
    after: OhHeadRefV1;
    limit?: number;
  }>): ReturnType<OhSqliteCanonicalReplicationV1["exportBundle"]>;
  importBundle(input: Readonly<{
    bundle: unknown;
  }>): ReturnType<OhSqliteCanonicalReplicationV1["importBundle"]>;
}>;

const guardOhCanonicalReplicationCapacity = (
  replication: OhSqliteCanonicalReplicationV1,
  pinnedHead: OhHeadV1,
): OhPinnedCanonicalReplicationV1 => {
  const expectedHead = Object.freeze({
    operationSha256: pinnedHead.operationSha256,
    sequence: pinnedHead.sequence,
  });
  const guarded: OhPinnedCanonicalReplicationV1 = {
    exportBundle: async (input) => await replication.exportBundle({
      after: input.after,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      through: expectedHead,
    }),
    importBundle: async (input) => {
      try {
        return await replication.importBundle({
          bundle: input.bundle,
          expectedHead,
        });
      } catch (error: unknown) {
        if (errorCode(error) === "SQLITE_FULL") return translateSqliteCapacityError(error);
        throw error;
      }
    },
  };
  return Object.freeze(guarded);
};

type BoundedOhStoreAuthority = Readonly<{
  database: OhSqliteDatabase;
  host: OhSqliteStoreAuthorityV1["host"];
  store: OhStoreV1;
}>;

const OH_SPACE_BEARING_TABLES = Object.freeze([
  "oh_spaces",
  "oh_space_bindings",
  "oh_operations",
  "oh_records",
  "oh_dependencies",
  "oh_sync_outbox",
  "oh_sync_state",
  "oh_search_documents",
  "oh_search_fts",
  "oh_space_purges",
] as const);
type OhSpaceBearingTable = typeof OH_SPACE_BEARING_TABLES[number];

const ohAnchorSpaceIds = (
  database: OhSqliteDatabase,
  table: "oh_space_bindings" | "oh_spaces",
): readonly string[] => {
  const rowSchema = z.object({ space_id: z.string() }).strict();
  return rowSchema.array().parse(
    database.query(`SELECT space_id FROM ${table} ORDER BY space_id LIMIT 2`).all(),
  ).map((row) => row.space_id);
};

const ohTableExists = (
  database: OhSqliteDatabase,
  table: OhSpaceBearingTable | "oh_operation_records",
): boolean => database.query(
  "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
).get(table) !== null;

const ohTableHasRows = (
  database: OhSqliteDatabase,
  table: OhSpaceBearingTable | "oh_operation_records",
): boolean => database.query(`SELECT 1 AS present FROM ${table} LIMIT 1`).get() !== null;

const ohTableHasAlienSpace = (
  database: OhSqliteDatabase,
  table: OhSpaceBearingTable,
  expectedSpaceId: string,
): boolean => database.query(
  `SELECT 1 AS present FROM ${table} WHERE space_id IS NOT ? LIMIT 1`,
).get(expectedSpaceId) !== null;

const ohEmptySpaceRowIsExact = (
  database: OhSqliteDatabase,
  expectedSpaceId: string,
): boolean => {
  const row = z.object({
    contract_id: z.string(),
    generation: z.number().int().nonnegative(),
    graph_revision_sha256: z.string().nullable(),
    head_operation_sha256: z.string().nullable(),
    records_sha256: z.string(),
    sequence: z.number().int().nonnegative(),
  }).strict().parse(database.query(
    `SELECT contract_id,generation,graph_revision_sha256,head_operation_sha256,
       records_sha256,sequence FROM oh_spaces WHERE space_id=?`,
  ).get(expectedSpaceId));
  const empty = emptyOhHeadV1();
  return row.contract_id === OH_CONTRACT_MANIFEST_V1.contractId
    && row.generation === empty.generation
    && row.graph_revision_sha256 === empty.graphRevisionSha256
    && row.head_operation_sha256 === empty.operationSha256
    && row.records_sha256 === empty.recordsSha256
    && row.sequence === empty.sequence;
};

const throwOhSpaceIsolationRefusal = (
  profileKind: "canonical" | "working",
  cause?: unknown,
): never => {
  const message = `FACTS_MEMORY_OH_${profileKind.toUpperCase()}_MULTIPLE_SPACES_REFUSED`;
  if (cause instanceof Error && cause.message === message) throw cause;
  throw new Error(message, cause === undefined ? undefined : { cause });
};

const assertOhSpaceVacantOrExact = (
  database: OhSqliteDatabase,
  expectedSpaceId: string,
  profileKind: "canonical" | "working",
  requireBound = false,
  requireVacant = false,
): void => {
  try {
    const presentTables = OH_SPACE_BEARING_TABLES.filter((table) =>
      ohTableExists(database, table));
    for (const table of presentTables) {
      if (ohTableHasAlienSpace(database, table, expectedSpaceId)) {
        throwOhSpaceIsolationRefusal(profileKind);
      }
    }
    if (
      ohTableExists(database, "oh_space_purges")
      && ohTableHasRows(database, "oh_space_purges")
    ) throwOhSpaceIsolationRefusal(profileKind);
    if (database.query("PRAGMA foreign_key_check").get() !== null) {
      throwOhSpaceIsolationRefusal(profileKind);
    }

    const spacesTableExists = ohTableExists(database, "oh_spaces");
    const bindingsTableExists = ohTableExists(database, "oh_space_bindings");
    const spaces = spacesTableExists ? ohAnchorSpaceIds(database, "oh_spaces") : [];
    const bindings = bindingsTableExists
      ? ohAnchorSpaceIds(database, "oh_space_bindings")
      : [];
    const hasDataRows = (ohTableExists(database, "oh_operation_records")
      && ohTableHasRows(database, "oh_operation_records"))
      || presentTables
      .filter((table) => table !== "oh_spaces" && table !== "oh_space_bindings")
      .some((table) => ohTableHasRows(database, table));

    const uninitialized = !bindingsTableExists
      && (!spacesTableExists || spaces.length === 0)
      && !hasDataRows;
    const migratedButEmpty = spacesTableExists
      && spaces.length === 0
      && bindings.length === 0
      && !hasDataRows;
    const interruptedBeforeBinding = spaces.length === 1
      && spaces[0] === expectedSpaceId
      && bindings.length === 0
      && !hasDataRows
      && ohEmptySpaceRowIsExact(database, expectedSpaceId);
    const exact = spaces.length === 1
      && bindings.length === 1
      && spaces[0] === expectedSpaceId
      && bindings[0] === expectedSpaceId;
    if (
      (exact && (!requireVacant || !hasDataRows))
      || (!requireBound && (uninitialized || migratedButEmpty || interruptedBeforeBinding))
    ) return;
    throwOhSpaceIsolationRefusal(profileKind);
  } catch (cause: unknown) {
    return throwOhSpaceIsolationRefusal(profileKind, cause);
  }
};

const assertSingleOhSpace = (
  database: OhSqliteDatabase,
  authority: OhStoreAuthorityV1,
  requireVacant = false,
): void => {
  assertOhSpaceVacantOrExact(
    database,
    authority.host.binding.spaceId,
    authority.host.binding.profile.profileKind,
    true,
    requireVacant,
  );
};

const createBoundedOhAuthority = (input: Readonly<{
  directory: string;
  expectedDatabaseFile?: OhSqliteDatabaseFileIdentity;
  profile: typeof OH_CANONICAL_STORE_PROFILE_V1 | typeof OH_WORKING_STORE_PROFILE_V1;
  realmId: string;
  requireExisting?: boolean;
  requireVacant?: boolean;
  spaceId: string;
}>): BoundedOhStoreAuthority => {
  // Reject existing symlinked, linked, or foreign-owned SQLite files before
  // the driver can follow or mutate them. The post-open pass covers files the
  // driver created and the residual same-UID race documented by HRA's custody
  // model remains outside this process boundary.
  const databasePath = join(input.directory, databaseName);
  if (input.requireExisting === true && !existsSync(databasePath)) {
    throw new Error(input.profile.profileKind === "canonical"
      ? "FACTS_MEMORY_OH_CANONICAL_DATABASE_MISSING"
      : "FACTS_MEMORY_OH_DATABASE_MISSING");
  }
  if (input.expectedDatabaseFile !== undefined) {
    assertExpectedDatabaseFile(databasePath, input.expectedDatabaseFile);
  }
  enforcePrivateSqliteFiles(input.directory);
  const database = openOhSqliteDatabase(databasePath);
  try {
    enforcePrivateSqliteFiles(input.directory);
    if (input.expectedDatabaseFile !== undefined) {
      assertExpectedDatabaseFile(databasePath, input.expectedDatabaseFile);
    }
    configureBoundedSqliteDatabase(database, input.directory);
    assertOhSpaceVacantOrExact(
      database,
      input.spaceId,
      input.profile.profileKind,
      false,
      input.requireVacant ?? false,
    );
    const authority = createOhSqliteStoreAuthorityV1({
      database,
      profile: input.profile,
      realmId: input.realmId,
      spaceId: input.spaceId,
    });
    assertSingleOhSpace(database, authority, input.requireVacant ?? false);
    return Object.freeze({
      database,
      host: authority.host,
      store: guardOhStoreCapacity(authority.store),
    });
  } catch (error: unknown) {
    try {
      database.close();
    } catch {
      // Preserve the capacity, integrity, or profile failure that rejected the
      // authority. No caller received a store handle.
    }
    if (errorCode(error) === "SQLITE_FULL") return translateSqliteCapacityError(error);
    throw error;
  }
};

const assertPrivateDirectory = (directory: string): void => {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");
  }
  const metadata = lstatSync(directory);
  const owner = process.getuid?.();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (owner !== undefined && metadata.uid !== owner)
    || (metadata.mode & 0o077) !== 0
    || realpathSync(directory) !== directory
  ) throw new Error("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");
};

const assertPrivateDatabase = (path: string): void => {
  const metadata = lstatSync(path);
  const owner = process.getuid?.();
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (owner !== undefined && metadata.uid !== owner)
    || (metadata.mode & 0o077) !== 0
    || realpathSync(path) !== resolve(path)
  ) throw new Error("FACTS_MEMORY_OH_DATABASE_UNSAFE");
};

const readPrivateDatabaseFileIdentity = (
  path: string,
  lane: "canonical" | "working" = "canonical",
): OhSqliteDatabaseFileIdentity => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || (owner !== undefined && metadata.uid !== owner)
    ) throw new Error(`FACTS_MEMORY_OH_${lane.toUpperCase()}_DATABASE_UNSAFE`);
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } finally {
    closeSync(descriptor);
  }
};

const assertExpectedDatabaseFile = (
  path: string,
  expected: OhSqliteDatabaseFileIdentity,
  lane: "canonical" | "working" = "canonical",
): void => {
  let observed: OhSqliteDatabaseFileIdentity;
  try {
    observed = readPrivateDatabaseFileIdentity(path, lane);
  } catch (cause: unknown) {
    throw new Error(`FACTS_MEMORY_OH_${lane.toUpperCase()}_DATABASE_REPLACED`, { cause });
  }
  if (observed.device !== expected.device || observed.inode !== expected.inode) {
    throw new Error(`FACTS_MEMORY_OH_${lane.toUpperCase()}_DATABASE_REPLACED`);
  }
};

/**
 * Classifies a project-canonical database without creating, opening as SQLite,
 * chmodding, or otherwise mutating it. A present result is an inode receipt
 * that the later canonical open revalidates before and after SQLite access.
 */
export const inspectOhCanonicalDatabaseForRecovery = (
  directory: string,
): OhCanonicalDatabaseInspection => {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new OhCanonicalDatabaseInspectionError("unsafe");
  }
  let directoryMetadata: ReturnType<typeof lstatSync>;
  try {
    directoryMetadata = lstatSync(directory);
  } catch (cause: unknown) {
    if (errorCode(cause) === "ENOENT") return Object.freeze({ state: "absent" });
    throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
  }
  const owner = process.getuid?.();
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || (owner !== undefined && directoryMetadata.uid !== owner)
    || (directoryMetadata.mode & 0o077) !== 0
  ) {
    throw new OhCanonicalDatabaseInspectionError("unsafe");
  }
  try {
    if (realpathSync(directory) !== directory) {
      throw new OhCanonicalDatabaseInspectionError("unsafe");
    }
  } catch (cause: unknown) {
    if (cause instanceof OhCanonicalDatabaseInspectionError) throw cause;
    throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
  }
  const databasePath = join(directory, databaseName);
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`] as const;
  let databaseMetadata: ReturnType<typeof lstatSync> | null = null;
  try {
    databaseMetadata = lstatSync(databasePath);
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") {
      throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
    }
  }
  if (databaseMetadata === null) {
    for (const sidecar of sidecars) {
      try {
        lstatSync(sidecar);
        throw new OhCanonicalDatabaseInspectionError("unsafe");
      } catch (cause: unknown) {
        if (cause instanceof OhCanonicalDatabaseInspectionError) throw cause;
        if (errorCode(cause) !== "ENOENT") {
          throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
        }
      }
    }
    return Object.freeze({ state: "absent" });
  }
  if (
    !databaseMetadata.isFile()
    || databaseMetadata.isSymbolicLink()
    || databaseMetadata.nlink !== 1
    || (owner !== undefined && databaseMetadata.uid !== owner)
  ) {
    throw new OhCanonicalDatabaseInspectionError("unsafe");
  }
  let file: OhSqliteDatabaseFileIdentity;
  try {
    file = readPrivateDatabaseFileIdentity(databasePath);
    if (realpathSync(databasePath) !== resolve(databasePath)) {
      throw new OhCanonicalDatabaseInspectionError("unsafe");
    }
  } catch (cause: unknown) {
    if (cause instanceof OhCanonicalDatabaseInspectionError) throw cause;
    if (cause instanceof Error
      && cause.message === "FACTS_MEMORY_OH_CANONICAL_DATABASE_UNSAFE") {
      throw new OhCanonicalDatabaseInspectionError("unsafe", cause);
    }
    throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
  }
  for (const sidecar of sidecars) {
    let sidecarMetadata: ReturnType<typeof lstatSync> | null = null;
    try {
      sidecarMetadata = lstatSync(sidecar);
    } catch (cause: unknown) {
      if (errorCode(cause) !== "ENOENT") {
        throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
      }
    }
    if (sidecarMetadata === null) continue;
    if (
      !sidecarMetadata.isFile()
      || sidecarMetadata.isSymbolicLink()
      || sidecarMetadata.nlink !== 1
      || (owner !== undefined && sidecarMetadata.uid !== owner)
    ) {
      throw new OhCanonicalDatabaseInspectionError("unsafe");
    }
    try {
      readPrivateDatabaseFileIdentity(sidecar);
      if (realpathSync(sidecar) !== resolve(sidecar)) {
        throw new OhCanonicalDatabaseInspectionError("unsafe");
      }
    } catch (cause: unknown) {
      if (cause instanceof OhCanonicalDatabaseInspectionError) throw cause;
      if (cause instanceof Error
        && cause.message === "FACTS_MEMORY_OH_CANONICAL_DATABASE_UNSAFE") {
        throw new OhCanonicalDatabaseInspectionError("unsafe", cause);
      }
      throw new OhCanonicalDatabaseInspectionError("unavailable", cause);
    }
  }
  return Object.freeze({ file, state: "present" });
};

const enforcePrivateSqliteFiles = (directory: string): void => {
  for (const name of [databaseName, `${databaseName}-wal`, `${databaseName}-shm`] as const) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(descriptor);
      const owner = process.getuid?.();
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || (owner !== undefined && metadata.uid !== owner)
      ) throw new Error("FACTS_MEMORY_OH_DATABASE_UNSAFE");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    assertPrivateDatabase(path);
  }
};

const assertBoundedLogicalDatabase = (directory: string): void => {
  let logicalBytes = 0;
  for (const name of [databaseName, `${databaseName}-wal`] as const) {
    const path = join(directory, name);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    try {
      const metadata = fstatSync(descriptor);
      const owner = process.getuid?.();
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0
        || (owner !== undefined && metadata.uid !== owner)
      ) throw new Error("FACTS_MEMORY_OH_DATABASE_UNSAFE");
      if (
        metadata.size > HRA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes - logicalBytes
      ) throw new Error("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");
      logicalBytes += metadata.size;
    } finally {
      closeSync(descriptor);
    }
  }
};

const assertBoundedForkSnapshot = (records: readonly unknown[]): void => {
  let encodedBytes = 2;
  for (const [index, record] of records.entries()) {
    const encoded = JSON.stringify(record);
    const separatorBytes = index === 0 ? 0 : 1;
    const recordBytes = Buffer.byteLength(encoded, "utf8");
    if (
      recordBytes + separatorBytes
      > HRA_OH_FACTS_MEMORY_LIMITS_V1.forkSnapshotBytes - encodedBytes
    ) throw new Error("FACTS_MEMORY_OH_FORK_SNAPSHOT_TOO_LARGE");
    encodedBytes += recordBytes + separatorBytes;
  }
};

function migrateLegacyMetadataFile(path: string, metadata: AdapterMetadata): void {
  const directory = dirname(path);
  const pendingPath = join(directory, adapterMetadataMigrationName);
  let descriptor: number;
  try {
    descriptor = openSync(
      pendingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const pending = readPendingMetadataFile(pendingPath);
    if (pending.status === "complete") {
      if (JSON.stringify(pending.metadata) !== JSON.stringify(metadata)) {
        throw new Error("FACTS_MEMORY_OH_METADATA_MIGRATION_CONFLICT");
      }
      renameSync(pendingPath, path);
      syncDirectory(directory);
      return;
    }
    try {
      descriptor = openSync(pendingPath, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error("FACTS_MEMORY_OH_METADATA_MIGRATION_CONFLICT");
    }
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (owner !== undefined && before.uid !== owner)
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pendingPath, path);
  syncDirectory(directory);
}

const readMetadataFile = (path: string): AdapterMetadata | null => {
  let descriptor: number | undefined;
  let result: ParsedAdapterMetadata;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || (owner !== undefined && before.uid !== owner)
      || before.size < 2
      || before.size > metadataMaximumBytes
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || Buffer.byteLength(text, "utf8") !== after.size
    ) throw new Error("FACTS_MEMORY_OH_METADATA_CHANGED");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("FACTS_MEMORY_OH_METADATA_INVALID");
    }
    result = parseAdapterMetadata(value);
    const receipt = receiptFromMetadata(result.metadata);
    if (
      digestFactsMemoryReceipt({
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
        version: receipt.version,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
  } finally {
    closeSync(descriptor);
  }
  if (result.legacy) {
    migrateLegacyMetadataFile(path, result.metadata);
    const migrated = readMetadataFile(path);
    if (migrated === null || JSON.stringify(migrated) !== JSON.stringify(result.metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_MIGRATION_READBACK_MISMATCH");
    }
    return migrated;
  }
  return result.metadata;
};

/** Cleanup-only authority reader. It never normalizes, migrates, or returns a head. */
const readCleanupMetadataAuthority = (path: string): CleanupMetadataAuthority | null => {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || (owner !== undefined && before.uid !== owner)
      || before.size < 2
      || before.size > metadataMaximumBytes
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || Buffer.byteLength(text, "utf8") !== after.size
    ) throw new Error("FACTS_MEMORY_OH_METADATA_CHANGED");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("FACTS_MEMORY_OH_METADATA_INVALID");
    }
    const current = adapterMetadataSchema.safeParse(value);
    let authority: CleanupMetadataAuthority;
    if (current.success) {
      const { adapterDigest, ...body } = current.data;
      const receipt = receiptFromMetadata(current.data);
      if (
        metadataDigest(body) !== adapterDigest
        || digestFactsMemoryReceipt({
          bindingDigest: receipt.bindingDigest,
          createdAt: receipt.createdAt,
          handleHash: receipt.handleHash,
          head: receipt.head,
          version: receipt.version,
        }) !== receipt.receiptDigest
      ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
      authority = current.data;
    } else {
      const legacy = legacyAdapterMetadataSchema.safeParse(value);
      if (!legacy.success) throw new Error("FACTS_MEMORY_OH_METADATA_INVALID");
      const { adapterDigest, ...body } = legacy.data;
      if (
        legacyMetadataDigest(body) !== adapterDigest
        || legacyReceiptDigest(legacy.data) !== legacy.data.receiptDigest
      ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
      authority = legacy.data;
    }
    if (
      authority.handleHash
      !== digestParts("hra-oh-handle-v1", [authority.bindingDigest, authority.ohBindingSha256])
    ) throw new Error("FACTS_MEMORY_OH_METADATA_AUTHORITY_MISMATCH");
    return {
      bindingDigest: authority.bindingDigest,
      handleHash: authority.handleHash,
      ohBindingSha256: authority.ohBindingSha256,
    };
  } finally {
    closeSync(descriptor);
  }
};

const readPendingMetadataFile = (path: string): PendingMetadata => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || (owner !== undefined && before.uid !== owner)
      || before.size > metadataMaximumBytes
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || Buffer.byteLength(text, "utf8") !== after.size
    ) throw new Error("FACTS_MEMORY_OH_METADATA_CHANGED");
    if (text.length < 2) return { status: "incomplete" };
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { status: "incomplete" };
    }
    let parsed: ParsedAdapterMetadata;
    try {
      parsed = parseAdapterMetadata(value);
    } catch (error: unknown) {
      if (
        error instanceof Error
        && (
          error.message === "FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH"
          || error.message === "FACTS_MEMORY_OH_LEGACY_NONEMPTY_RECOVERY_REQUIRED"
        )
      ) {
        throw error;
      }
      return { status: "incomplete" };
    }
    const receipt = receiptFromMetadata(parsed.metadata);
    if (
      digestFactsMemoryReceipt({
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
        version: receipt.version,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
    return { status: "complete", metadata: parsed.metadata };
  } finally {
    closeSync(descriptor);
  }
};

const syncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const publishMetadata = (directory: string, metadata: AdapterMetadata): void => {
  const finalPath = join(directory, adapterMetadataName);
  const pendingPath = join(directory, adapterMetadataPendingName);
  const existing = readMetadataFile(finalPath);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_REPLAY_MISMATCH");
    }
    return;
  }
  const pending = readPendingMetadataFile(pendingPath);
  if (pending.status === "complete") {
    if (JSON.stringify(pending.metadata) !== JSON.stringify(metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_PENDING_MISMATCH");
    }
    renameSync(pendingPath, finalPath);
    syncDirectory(directory);
    if (JSON.stringify(readMetadataFile(finalPath)) !== JSON.stringify(metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_READBACK_MISMATCH");
    }
    return;
  }
  const descriptor = openSync(pendingPath, pending.status === "missing"
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (owner !== undefined && before.uid !== owner)
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pendingPath, finalPath);
  syncDirectory(directory);
  if (JSON.stringify(readMetadataFile(finalPath)) !== JSON.stringify(metadata)) {
    throw new Error("FACTS_MEMORY_OH_METADATA_READBACK_MISMATCH");
  }
};

const makeReceipt = (input: Readonly<{
  binding: FactsMemoryBinding;
  createdAt: number;
  handleHash: string;
  head: FactsMemoryHead;
}>): FactsMemoryStoreReceipt => {
  const base = {
    bindingDigest: input.binding.bindingDigest,
    createdAt: unixMillisecondsSchema.parse(input.createdAt),
    handleHash: factsMemoryDigestSchema.parse(input.handleHash),
    head: factsMemoryHeadSchema.parse(input.head),
    version: 1 as const,
  };
  return factsMemoryStoreReceiptSchema.parse({
    ...base,
    receiptDigest: digestFactsMemoryReceipt(base),
  });
};

export type OpenOhMemoryStore = Readonly<{
  bindingSha256: OhStoreV1["binding"]["bindingSha256"];
  expectedHead: OhHeadV1;
  store: OhStoreV1;
}>;

export type OpenOhMemoryStores = Readonly<{
  canonical: OpenOhMemoryStore;
  working: OpenOhMemoryStore;
}>;

export type OpenOhWorkingMemoryStores = Readonly<{
  ephemeralCanonical: OpenOhMemoryStore;
  working: OpenOhMemoryStore;
}>;

export type OhMemoryStoreOperationResult<T> = Readonly<{
  canonicalHead: OhHeadV1;
  result: T;
  workingHead: OhHeadV1;
}>;

export type OhWorkingMemoryStoreOperationResult<T> = Readonly<{
  result: T;
  workingHead: OhHeadV1;
}>;

export type OhWorkingMemoryStoreInput = Readonly<{
  binding: FactsMemoryBinding;
  directory: string;
  expectedHandleHash: string;
  expectedHead: FactsMemoryHead;
}>;

export type OpenOhCanonicalReplication = Readonly<{
  bindingSha256: OhSqliteCanonicalReplicationV1["binding"]["bindingSha256"];
  expectedHead: OhHeadV1;
  replication: OhPinnedCanonicalReplicationV1;
}>;

export type OhCanonicalReplicationOperationResult<T> = Readonly<{
  canonicalHead: OhHeadV1;
  result: T;
}>;

export type OhCanonicalReplicationInput = Readonly<{
  directory: string;
  expectedDatabaseFile?: OhSqliteDatabaseFileIdentity;
  expectedHead: FactsMemoryHead;
  realmId: string;
  requireExisting?: boolean;
  requireVacant?: boolean;
  spaceId: string;
}>;

export type OhCanonicalMemorySnapshot = Readonly<{
  bindingSha256: string;
  head: OhHeadV1;
  records: readonly unknown[];
}>;

/**
 * Exact public Oh stable-memory working-profile adapter. Every Oh handle is host-owned,
 * directory-scoped, and closed before this lifecycle port resolves.
 */
export class OhSqliteFactsMemoryEngine implements LocalOhFactsMemoryEnginePort {
  readonly #forkAttestations: Readonly<{
    finalizeMemoryWorkingPageAttestationFork(input: Readonly<{
      childBindingDigest: string;
      childHead: FactsMemoryHead;
      parentBindingDigest: string;
      parentHead: FactsMemoryHead;
    }>): number;
  }>;
  readonly #now: () => number;
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: Readonly<{
    forkAttestations: Readonly<{
      finalizeMemoryWorkingPageAttestationFork(input: Readonly<{
        childBindingDigest: string;
        childHead: FactsMemoryHead;
        parentBindingDigest: string;
        parentHead: FactsMemoryHead;
      }>): number;
    }>;
    now?: () => number;
  }>) {
    this.#forkAttestations = options.forkAttestations;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reads one exact, verified canonical-memory snapshot without lending the
   * caller a store or filesystem capability. The control-plane head must be
   * the current physical head both before and after the snapshot; recovery,
   * rather than hosted projection, owns reconciling any drift.
   */
  inspectCanonicalMemorySnapshot(
    input: OhCanonicalReplicationInput,
    maximumRecordsValue = maximumForkRecords,
  ): Promise<OhCanonicalMemorySnapshot> {
    const expectedHead = factsMemoryHeadSchema.parse(input.expectedHead);
    const maximumRecords = z.number().int().min(1).max(maximumForkRecords)
      .parse(maximumRecordsValue);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      let authority: BoundedOhStoreAuthority;
      try {
        authority = await this.#openCanonical({
          directory,
          ...(input.expectedDatabaseFile === undefined
            ? {}
            : { expectedDatabaseFile: input.expectedDatabaseFile }),
          realmId: input.realmId,
          requireExisting: input.requireExisting ?? false,
          requireVacant: input.requireVacant ?? false,
          spaceId: input.spaceId,
        });
      } catch (error: unknown) {
        throw custodyError("canonical", error);
      }

      const failures: unknown[] = [];
      let snapshot: OhCanonicalMemorySnapshot | undefined;
      let openedDatabaseFile: OhSqliteDatabaseFileIdentity | undefined;
      try {
        try {
          openedDatabaseFile = readPrivateDatabaseFileIdentity(join(directory, databaseName));
          const initial = await this.#verifyCanonicalAuthority(
            authority,
            directory,
            openedDatabaseFile,
          );
          const pinned = await this.#pinCanonicalHead(authority, initial.head, expectedHead);
          if (JSON.stringify(projectOhHead(initial.head)) !== JSON.stringify(expectedHead)) {
            throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_NOT_SETTLED");
          }
          const read = await authority.store.snapshot({
            head: ohHeadRef(expectedHead),
            maximumRecords,
          });
          if (JSON.stringify(read.head) !== JSON.stringify(pinned)) {
            throw new Error("FACTS_MEMORY_OH_CANONICAL_SNAPSHOT_HEAD_MISMATCH");
          }
          snapshot = Object.freeze({
            bindingSha256: authority.store.binding.bindingSha256,
            head: read.head,
            records: Object.freeze([...read.records]),
          });

          const final = await this.#verifyCanonicalAuthority(
            authority,
            directory,
            openedDatabaseFile,
          );
          if (JSON.stringify(projectOhHead(final.head)) !== JSON.stringify(expectedHead)) {
            throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_NOT_SETTLED");
          }
        } catch (error: unknown) {
          failures.push(custodyError("canonical", error));
        }
      } finally {
        try {
          await authority.store.close();
        } catch (error: unknown) {
          failures.push(custodyError("canonical", error));
        }
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Oh canonical snapshot or authority cleanup failed.",
        );
      }
      if (snapshot === undefined) {
        throw new Error("FACTS_MEMORY_OH_CANONICAL_SNAPSHOT_INCOMPLETE");
      }
      return snapshot;
    });
  }

  /**
   * Opens only the project-canonical operation-replication authority. The
   * callback receives no database locator or ordinary semantic store, and a
   * captured replication capability is closed before this method settles.
   */
  withCanonicalReplication<T>(
    input: OhCanonicalReplicationInput,
    operation: (
      canonical: OpenOhCanonicalReplication,
    ) => Promise<T>,
  ): Promise<OhCanonicalReplicationOperationResult<T>> {
    const expectedHead = factsMemoryHeadSchema.parse(input.expectedHead);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      let authority: BoundedOhStoreAuthority;
      try {
        authority = await this.#openCanonical({
          directory,
          ...(input.expectedDatabaseFile === undefined
            ? {}
            : { expectedDatabaseFile: input.expectedDatabaseFile }),
          realmId: input.realmId,
          requireExisting: input.requireExisting ?? false,
          requireVacant: input.requireVacant ?? false,
          spaceId: input.spaceId,
        });
      } catch (error: unknown) {
        throw custodyError("canonical", error);
      }

      const failures: unknown[] = [];
      let callbackCompleted = false;
      let finalHead: OhHeadV1 | undefined;
      let initialHead: OhHeadV1 | undefined;
      let result: T | undefined;
      let openedDatabaseFile: OhSqliteDatabaseFileIdentity | undefined;
      try {
        let replication: OhPinnedCanonicalReplicationV1 | undefined;
        let replicationBindingSha256:
          OhSqliteCanonicalReplicationV1["binding"]["bindingSha256"] | undefined;
        let pinnedHead: OhHeadV1 | undefined;
        try {
          openedDatabaseFile = readPrivateDatabaseFileIdentity(join(directory, databaseName));
          const initialVerification = await this.#verifyCanonicalAuthority(
            authority,
            directory,
            openedDatabaseFile,
          );
          initialHead = initialVerification.head;
          pinnedHead = await this.#pinCanonicalHead(authority, initialHead, expectedHead);
          const hostReplication = authority.host.replication;
          if (
            hostReplication === null
            || hostReplication.binding.bindingSha256
              !== authority.store.binding.bindingSha256
          ) throw new Error("FACTS_MEMORY_OH_CANONICAL_REPLICATION_UNAVAILABLE");
          replicationBindingSha256 = hostReplication.binding.bindingSha256;
          replication = guardOhCanonicalReplicationCapacity(hostReplication, pinnedHead);
        } catch (error: unknown) {
          failures.push(custodyError("canonical", error));
        }

        if (
          failures.length === 0
          && replication !== undefined
          && replicationBindingSha256 !== undefined
          && pinnedHead !== undefined
          && initialHead !== undefined
          && openedDatabaseFile !== undefined
        ) {
          try {
            result = await operation(Object.freeze({
              bindingSha256: replicationBindingSha256,
              expectedHead: pinnedHead,
              replication,
            }));
            callbackCompleted = true;
          } catch (error: unknown) {
            failures.push(error);
          }

          try {
            const finalVerification = await this.#verifyCanonicalAuthority(
              authority,
              directory,
              openedDatabaseFile,
            );
            await this.#assertCanonicalDescendant(
              authority,
              finalVerification.head,
              initialHead,
            );
            finalHead = finalVerification.head;
          } catch (error: unknown) {
            failures.push(custodyError("canonical", error));
          }
        }
      } finally {
        try {
          await authority.store.close();
        } catch (error: unknown) {
          failures.push(custodyError("canonical", error));
        }
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Oh canonical replication operation or authority cleanup failed.",
        );
      }
      if (!callbackCompleted || finalHead === undefined) {
        throw new Error("FACTS_MEMORY_OH_CANONICAL_REPLICATION_INCOMPLETE");
      }
      return Object.freeze({ canonicalHead: finalHead, result: result as T });
    });
  }

  /**
   * Opens one verified working authority without receiving, inspecting, or
   * serializing a durable canonical directory. The second lane is a fresh,
   * read-only in-memory canonical store so callers can reuse Oh's two-lane
   * semantic authority without weakening canonical fail-closed behavior.
   */
  withWorkingMemoryStore<T>(
    input: OhWorkingMemoryStoreInput,
    operation: (
      stores: OpenOhWorkingMemoryStores,
    ) => Promise<T>,
  ): Promise<OhWorkingMemoryStoreOperationResult<T>> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const expectedHead = factsMemoryHeadSchema.parse(input.expectedHead);
    const expectedHandleHash = factsMemoryDigestSchema.parse(input.expectedHandleHash);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      const initialMetadata = readMetadataFile(join(directory, adapterMetadataName));
      if (initialMetadata === null) throw new Error("FACTS_MEMORY_OH_METADATA_MISSING");
      this.#assertMetadataBinding(initialMetadata, binding);

      const working = await this.#open(binding, directory, true);
      let ephemeral: OhSqliteStoreAuthorityV1 | undefined;
      const failures: unknown[] = [];
      let callbackCompleted = false;
      let initialized = false;
      let finalWorkingHead: OhHeadV1 | undefined;
      let result: T | undefined;
      try {
        try {
          this.#assertMetadataAuthority(initialMetadata, binding, working);
          if (initialMetadata.handleHash !== expectedHandleHash) {
            throw new Error("FACTS_MEMORY_OH_HANDLE_MISMATCH");
          }
          const openedDatabaseFile = readPrivateDatabaseFileIdentity(
            join(directory, databaseName),
            "working",
          );
          const workingVerification = await this.#verifyWorkingAuthority(
            working,
            directory,
            openedDatabaseFile,
          );
          if (JSON.stringify(projectOhHead(workingVerification.head)) !== JSON.stringify(expectedHead)) {
            throw new Error("FACTS_MEMORY_OH_WORKING_HEAD_CONFLICT");
          }

          try {
            ephemeral = createOhSqliteStoreAuthorityV1({
              path: ":memory:",
              profile: OH_CANONICAL_STORE_PROFILE_V1,
              realmId: `hra:working-only:${binding.bindingDigest}`,
              spaceId: `hra:working-only:${this.#spaceId(binding)}`,
            });
            await this.#verifyEmptyWorkingOnlyEphemeral(ephemeral);
          } catch (error: unknown) {
            throw workingOnlyEphemeralError(error);
          }

          initialized = true;
          try {
            result = await operation(Object.freeze({
              ephemeralCanonical: Object.freeze({
                bindingSha256: ephemeral.store.binding.bindingSha256,
                expectedHead: emptyOhHeadV1(),
                store: guardWorkingOnlyEphemeralStore(ephemeral.store),
              }),
              working: Object.freeze({
                bindingSha256: working.store.binding.bindingSha256,
                expectedHead: workingVerification.head,
                store: working.store,
              }),
            }));
            callbackCompleted = true;
          } catch (error: unknown) {
            failures.push(error);
          }

          try {
            const finalMetadata = readMetadataFile(join(directory, adapterMetadataName));
            if (finalMetadata === null) throw new Error("FACTS_MEMORY_OH_METADATA_MISSING");
            this.#assertMetadataBinding(finalMetadata, binding);
            this.#assertMetadataAuthority(finalMetadata, binding, working);
            if (
              finalMetadata.handleHash !== expectedHandleHash
              || JSON.stringify(finalMetadata) !== JSON.stringify(initialMetadata)
            ) throw new Error("FACTS_MEMORY_OH_HANDLE_MISMATCH");
            const finalWorking = await this.#verifyWorkingAuthority(
              working,
              directory,
              openedDatabaseFile,
            );
            await this.#assertWorkingDescendant(working, finalWorking.head, workingVerification.head);
            finalWorkingHead = finalWorking.head;
          } catch (error: unknown) {
            failures.push(custodyError("working", error));
          }

          try {
            await this.#verifyEmptyWorkingOnlyEphemeral(ephemeral);
          } catch (error: unknown) {
            failures.push(workingOnlyEphemeralError(error));
          }
        } catch (error: unknown) {
          failures.push(error);
        }
      } finally {
        const closeOperations: Promise<Readonly<{ lane: "ephemeral" | "working" }>>[] = [
          working.store.close().then(() => Object.freeze({ lane: "working" as const })),
        ];
        if (ephemeral !== undefined) {
          closeOperations.push(ephemeral.store.close()
            .then(() => Object.freeze({ lane: "ephemeral" as const })));
        }
        const closed = await Promise.allSettled(closeOperations);
        for (let index = 0; index < closed.length; index += 1) {
          const outcome = closed[index];
          if (outcome?.status !== "rejected") continue;
          failures.push(index === 0
            ? custodyError("working", outcome.reason)
            : workingOnlyEphemeralError(
              outcome.reason,
              "FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_CLOSE_FAILED",
            ));
        }
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Oh working-only memory operation or authority cleanup failed.",
        );
      }
      if (!initialized || !callbackCompleted || finalWorkingHead === undefined) {
        throw new Error("FACTS_MEMORY_OH_WORKING_ONLY_OPERATION_INCOMPLETE");
      }
      return Object.freeze({ result: result as T, workingHead: finalWorkingHead });
    });
  }

  /**
   * Opens the exact working and project-canonical authorities under one
   * directory-ordered lock. The callback owns no locator and both stores are
   * verified and closed before this method resolves.
   */
  withMemoryStores<T>(input: Readonly<{
    canonical: Readonly<{
      directory: string;
      expectedDatabaseFile?: OhSqliteDatabaseFileIdentity;
      expectedHead?: FactsMemoryHead;
      realmId: string;
      requireExisting?: boolean;
      requireVacant?: boolean;
      spaceId: string;
    }>;
    working: Readonly<{
      binding: FactsMemoryBinding;
      directory: string;
      expectedHandleHash: string;
      expectedHead: FactsMemoryHead;
    }>;
  }>, operation: (stores: OpenOhMemoryStores) => Promise<T>): Promise<OhMemoryStoreOperationResult<T>> {
    const binding = factsMemoryBindingSchema.parse(input.working.binding);
    const expectedWorkingHead = factsMemoryHeadSchema.parse(input.working.expectedHead);
    const expectedHandleHash = factsMemoryDigestSchema.parse(input.working.expectedHandleHash);
    const expectedCanonicalHead = input.canonical.expectedHead === undefined
      ? undefined
      : factsMemoryHeadSchema.parse(input.canonical.expectedHead);
    const workingDirectory = input.working.directory;
    const canonicalDirectory = input.canonical.directory;
    if (workingDirectory === canonicalDirectory) throw new Error("FACTS_MEMORY_OH_AUTHORITY_ALIAS");
    return this.#serializeDirectories([workingDirectory, canonicalDirectory], async () => {
      assertPrivateDirectory(workingDirectory);
      try {
        assertPrivateDirectory(canonicalDirectory);
      } catch (error: unknown) {
        throw custodyError("canonical", error);
      }
      const metadata = readMetadataFile(join(workingDirectory, adapterMetadataName));
      if (metadata === null) throw new Error("FACTS_MEMORY_OH_METADATA_MISSING");
      this.#assertMetadataBinding(metadata, binding);

      const working = await this.#open(binding, workingDirectory, true);
      let canonical: BoundedOhStoreAuthority | undefined;
      let completed: OhMemoryStoreOperationResult<T> | undefined;
      let operationFailed = false;
      let operationError: unknown;
      try {
        this.#assertMetadataAuthority(metadata, binding, working);
        if (metadata.handleHash !== expectedHandleHash) {
          throw new Error("FACTS_MEMORY_OH_HANDLE_MISMATCH");
        }
        const workingVerification = await this.#verifyBounded(working, workingDirectory);
        const currentWorkingHead = projectOhHead(workingVerification.head);
        if (JSON.stringify(currentWorkingHead) !== JSON.stringify(expectedWorkingHead)) {
          throw new Error("FACTS_MEMORY_OH_WORKING_HEAD_CONFLICT");
        }

        let pinnedCanonicalHead: OhHeadV1;
        try {
          canonical = await this.#openCanonical({
            directory: canonicalDirectory,
            ...(input.canonical.expectedDatabaseFile === undefined
              ? {}
              : { expectedDatabaseFile: input.canonical.expectedDatabaseFile }),
            realmId: input.canonical.realmId,
            requireExisting: input.canonical.requireExisting ?? false,
            requireVacant: input.canonical.requireVacant ?? false,
            spaceId: input.canonical.spaceId,
          });
          const canonicalVerification = await this.#verifyBounded(canonical, canonicalDirectory);
          pinnedCanonicalHead = canonicalVerification.head;
          if (expectedCanonicalHead !== undefined) {
            const currentCanonicalHead = projectOhHead(canonicalVerification.head);
            if (currentCanonicalHead.sequence < expectedCanonicalHead.sequence) {
              throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_REGRESSION");
            }
            if (currentCanonicalHead.sequence === expectedCanonicalHead.sequence) {
              if (JSON.stringify(currentCanonicalHead) !== JSON.stringify(expectedCanonicalHead)) {
                throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION");
              }
            } else {
              const pinned = await canonical.store.snapshot({
                head: ohHeadRef(expectedCanonicalHead),
                maximumRecords: maximumForkRecords,
              });
              if (JSON.stringify(projectOhHead(pinned.head)) !== JSON.stringify(expectedCanonicalHead)) {
                throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION");
              }
              pinnedCanonicalHead = pinned.head;
            }
          }
        } catch (error: unknown) {
          throw custodyError("canonical", error);
        }

        const result = await operation({
          canonical: {
            bindingSha256: canonical.store.binding.bindingSha256,
            expectedHead: pinnedCanonicalHead,
            store: canonical.store,
          },
          working: {
            bindingSha256: working.store.binding.bindingSha256,
            expectedHead: workingVerification.head,
            store: working.store,
          },
        });
        const [finalCanonical, finalWorking] = await Promise.all([
          this.#verifyBounded(canonical, canonicalDirectory)
            .catch((error: unknown) => { throw custodyError("canonical", error); }),
          this.#verifyBounded(working, workingDirectory)
            .catch((error: unknown) => { throw custodyError("working", error); }),
        ]);
        completed = {
          canonicalHead: finalCanonical.head,
          result,
          workingHead: finalWorking.head,
        };
      } catch (error: unknown) {
        operationFailed = true;
        operationError = error;
      }
      const closeOperations: Promise<void>[] = [working.store.close()];
      if (canonical !== undefined) closeOperations.push(canonical.store.close());
      const closed = await Promise.allSettled(closeOperations);
      const closeErrors: unknown[] = [];
      for (const outcome of closed) {
        if (outcome.status === "rejected") closeErrors.push(outcome.reason as unknown);
      }
      if (operationFailed) {
        if (closeErrors.length > 0) {
          throw new AggregateError(
            [operationError, ...closeErrors],
            "Oh memory operation and authority cleanup both failed.",
          );
        }
        throw operationError;
      }
      if (closeErrors.length > 0) {
        if (closeErrors.length === 1) throw closeErrors[0];
        throw new AggregateError(closeErrors, "Failed to close Oh memory authorities.");
      }
      if (completed === undefined) throw new Error("FACTS_MEMORY_OH_OPERATION_INCOMPLETE");
      return completed;
    });
  }

  create(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    operationKey: string;
  }>): Promise<FactsMemoryStoreReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    const operationKey = operationKeySchema.parse(input.operationKey);
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      const existing = readMetadataFile(join(directory, adapterMetadataName));
      if (existing !== null) {
        this.#assertCreation(existing, binding, operationKey, null);
        await this.#inspectComplete(binding, directory, existing);
        return receiptFromMetadata(existing);
      }
      const pending = readPendingMetadataFile(join(directory, adapterMetadataPendingName));
      if (pending.status === "complete") {
        this.#assertCreation(pending.metadata, binding, operationKey, null);
        await this.#inspectComplete(binding, directory, pending.metadata);
        publishMetadata(directory, pending.metadata);
        return receiptFromMetadata(pending.metadata);
      }
      const authority = await this.#open(binding, directory, false);
      let receipt: FactsMemoryStoreReceipt;
      let metadata: AdapterMetadata;
      try {
        const verification = await this.#verifyBounded(authority, directory);
        const initialHead = projectOhHead(verification.head);
        if (initialHead.sequence !== 0 || verification.operations !== 0 || verification.records !== 0) {
          throw new Error("FACTS_MEMORY_OH_CREATE_NOT_EMPTY");
        }
        const handleHash = this.#handleHash(binding, authority.store.binding.bindingSha256);
        receipt = makeReceipt({
          binding,
          createdAt: this.#now(),
          handleHash,
          head: initialHead,
        });
        metadata = this.#metadata({
          binding,
          createKind: "create",
          ohBindingSha256: authority.store.binding.bindingSha256,
          operationKey,
          parent: null,
          receipt,
        });
      } finally {
        await authority.store.close();
      }
      publishMetadata(directory, metadata);
      return receipt;
    });
  }

  fork(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    operationKey: string;
    parent: FactsMemoryCheckpoint;
    parentDirectory: string;
  }>): Promise<FactsMemoryStoreReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const parent = factsMemoryCheckpointSchema.parse(input.parent);
    const directory = input.directory;
    const parentDirectory = input.parentDirectory;
    const operationKey = operationKeySchema.parse(input.operationKey);
    if (binding.ownerId !== parent.ownerId) throw new Error("FACTS_MEMORY_PARENT_AUTHORITY_MISMATCH");
    if (binding.sessionId === parent.sessionId || directory === parentDirectory) {
      throw new Error("FACTS_MEMORY_SELF_FORK");
    }
    return this.#serializeDirectories([directory, parentDirectory], async () => {
      assertPrivateDirectory(directory);
      assertPrivateDirectory(parentDirectory);
      const existing = readMetadataFile(join(directory, adapterMetadataName));
      if (existing !== null) {
        this.#assertCreation(existing, binding, operationKey, parent);
        await this.#inspectComplete(binding, directory, existing);
        const receipt = receiptFromMetadata(existing);
        this.#finalizeForkAttestations(binding, receipt.head, parent);
        return receipt;
      }
      const pending = readPendingMetadataFile(join(directory, adapterMetadataPendingName));
      if (pending.status === "complete") {
        this.#assertCreation(pending.metadata, binding, operationKey, parent);
        await this.#inspectComplete(binding, directory, pending.metadata);
        const receipt = receiptFromMetadata(pending.metadata);
        this.#finalizeForkAttestations(binding, receipt.head, parent);
        publishMetadata(directory, pending.metadata);
        return receipt;
      }

      const parentBinding = factsMemoryBindingSchema.parse({
        bindingDigest: parent.bindingDigest,
        epoch: parent.epoch,
        ownerId: parent.ownerId,
        sessionId: parent.sessionId,
      });
      const parentMetadata = readMetadataFile(join(parentDirectory, adapterMetadataName));
      if (parentMetadata === null) throw new Error("FACTS_MEMORY_OH_PARENT_NOT_ACTIVE");
      this.#assertMetadataBinding(parentMetadata, parentBinding);
      const parentAuthority = await this.#open(parentBinding, parentDirectory, true);
      let snapshot: Awaited<ReturnType<typeof parentAuthority.store.snapshot>>;
      try {
        snapshot = await parentAuthority.store.snapshot({
          head: ohHeadRef(parent.head),
          maximumRecords: maximumForkRecords,
        });
        const snapshotHead = projectOhHead(snapshot.head);
        if (
          snapshotHead.sequence !== parent.head.sequence
          || snapshotHead.operationSha256 !== parent.head.operationSha256
          || snapshotHead.digest !== parent.head.digest
        ) {
          throw new Error("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");
        }
      } finally {
        await parentAuthority.store.close();
      }
      assertBoundedForkSnapshot(snapshot.records);

      const childAuthority = await this.#open(binding, directory, false);
      let receipt: FactsMemoryStoreReceipt;
      let metadata: AdapterMetadata;
      try {
        if (snapshot.records.length > 0) {
          await childAuthority.store.commit({
            actorId: hostActorId,
            changes: snapshot.records.map((record) => ({ kind: "put" as const, record, v: 1 as const })),
            expectedHead: { generation: 0, operationSha256: null },
            operationId: `hra.fork.${digestParts("hra-oh-fork-operation-v1", [operationKey])}`,
          });
        }
        const verification = await this.#verifyBounded(childAuthority, directory);
        if (
          verification.records !== snapshot.records.length
          || verification.head.recordsSha256 !== snapshot.head.recordsSha256
          || verification.operations !== (snapshot.records.length === 0 ? 0 : 1)
        ) throw new Error("FACTS_MEMORY_OH_FORK_COPY_MISMATCH");
        const initialHead = projectOhHead(verification.head);
        const handleHash = this.#handleHash(binding, childAuthority.store.binding.bindingSha256);
        receipt = makeReceipt({
          binding,
          createdAt: this.#now(),
          handleHash,
          head: initialHead,
        });
        this.#finalizeForkAttestations(binding, receipt.head, parent);
        metadata = this.#metadata({
          binding,
          createKind: "fork",
          ohBindingSha256: childAuthority.store.binding.bindingSha256,
          operationKey,
          parent,
          receipt,
        });
      } finally {
        await childAuthority.store.close();
      }
      publishMetadata(directory, metadata);
      return receipt;
    });
  }

  inspect(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    expectedHead?: FactsMemoryHead;
  }>): Promise<FactsMemoryBrokerInspection> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      let metadata = readMetadataFile(join(directory, adapterMetadataName));
      let recoveredInspection: FactsMemoryStoreInspection | undefined;
      if (metadata === null) {
        const pending = readPendingMetadataFile(join(directory, adapterMetadataPendingName));
        if (pending.status !== "complete") return { status: "missing" };
        metadata = pending.metadata;
        recoveredInspection = await this.#inspectComplete(
          binding,
          directory,
          metadata,
          input.expectedHead,
        );
        publishMetadata(directory, metadata);
      }
      return {
        inspection: recoveredInspection ?? await this.#inspectComplete(
          binding,
          directory,
          metadata,
          input.expectedHead,
        ),
        status: "present",
      };
    });
  }

  quiesceForPurge(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
  }>): Promise<Readonly<{ handleHash: string | null }>> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      let cleanupAuthority: CleanupMetadataAuthority | null = null;
      try {
        cleanupAuthority = readCleanupMetadataAuthority(join(directory, adapterMetadataName));
      } catch {
        // Inspection and the bounded database reopen below remain independent;
        // an invalid sidecar can never authorize oversized cleanup.
      }
      let metadata: AdapterMetadata | null = null;
      try {
        metadata = readMetadataFile(join(directory, adapterMetadataName));
      } catch {
        // Recovery cleanup owns the complete validated 0700 session directory.
        // A malformed or legacy sidecar cannot authorize reopening, but the Oh
        // database binding below can still prove the exact store before purge.
      }
      const databasePath = join(directory, databaseName);
      if (!existsSync(databasePath)) {
        if (metadata !== null) throw new Error("FACTS_MEMORY_OH_DATABASE_MISSING");
        return { handleHash: null };
      }
      try {
        assertBoundedLogicalDatabase(directory);
      } catch (error: unknown) {
        if (
          !(error instanceof Error)
          || error.message !== "FACTS_MEMORY_OH_DATABASE_TOO_LARGE"
          || cleanupAuthority === null
        ) throw error;
        if (
          cleanupAuthority.bindingDigest !== binding.bindingDigest
          || cleanupAuthority.handleHash
            !== this.#handleHash(binding, cleanupAuthority.ohBindingSha256)
        ) throw new Error("FACTS_MEMORY_OH_METADATA_BINDING_MISMATCH");
        return { handleHash: cleanupAuthority.handleHash };
      }
      const authority = await this.#open(binding, directory, true);
      try {
        const verification = await this.#verifyBounded(authority, directory);
        if (metadata !== null) {
          this.#assertMetadataAuthority(metadata, binding, authority);
          const head = projectOhHead(verification.head);
          if (
            head.sequence < metadata.initialHead.sequence
            || (head.sequence === metadata.initialHead.sequence
              && (head.operationSha256 !== metadata.initialHead.operationSha256
                || head.digest !== metadata.initialHead.digest))
          ) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
          if (head.sequence > metadata.initialHead.sequence) {
            await authority.store.changesSince(ohHeadRef(metadata.initialHead), { limit: 1 });
          }
        }
        return { handleHash: this.#handleHash(binding, authority.store.binding.bindingSha256) };
      } finally {
        await authority.store.close();
      }
    });
  }

  async #open(
    binding: FactsMemoryBinding,
    directory: string,
    requireExisting: boolean,
  ): Promise<BoundedOhStoreAuthority> {
    assertPrivateDirectory(directory);
    const path = join(directory, databaseName);
    if (requireExisting && !existsSync(path)) throw new Error("FACTS_MEMORY_OH_DATABASE_MISSING");
    enforcePrivateSqliteFiles(directory);
    assertBoundedLogicalDatabase(directory);
    const authority = createBoundedOhAuthority({
      directory,
      profile: OH_WORKING_STORE_PROFILE_V1,
      realmId: `hra:${binding.bindingDigest}`,
      spaceId: this.#spaceId(binding),
    });
    try {
      enforcePrivateSqliteFiles(directory);
      assertBoundedLogicalDatabase(directory);
      const persisted = parseOhStoreBindingV1(authority.store.binding);
      if (
        persisted === null
        || persisted.profile.profileSha256 !== OH_WORKING_STORE_PROFILE_V1.profileSha256
        || persisted.realmId !== `hra:${binding.bindingDigest}`
        || persisted.spaceId !== this.#spaceId(binding)
        || authority.host.binding.bindingSha256 !== persisted.bindingSha256
        || authority.host.replication !== null
      ) throw new Error("FACTS_MEMORY_OH_BINDING_MISMATCH");
      return authority;
    } catch (error: unknown) {
      try {
        await authority.store.close();
      } catch (closeError: unknown) {
        throw new AggregateError([error, closeError], "Failed to close rejected Oh authority.");
      }
      throw error;
    }
  }

  async #openCanonical(input: Readonly<{
    directory: string;
    expectedDatabaseFile?: OhSqliteDatabaseFileIdentity;
    realmId: string;
    requireExisting: boolean;
    requireVacant: boolean;
    spaceId: string;
  }>): Promise<BoundedOhStoreAuthority> {
    assertPrivateDirectory(input.directory);
    if (input.expectedDatabaseFile !== undefined) {
      assertExpectedDatabaseFile(join(input.directory, databaseName), input.expectedDatabaseFile);
    }
    enforcePrivateSqliteFiles(input.directory);
    if (input.expectedDatabaseFile !== undefined) {
      assertExpectedDatabaseFile(join(input.directory, databaseName), input.expectedDatabaseFile);
    }
    assertBoundedLogicalDatabase(input.directory);
    const authority = createBoundedOhAuthority({
      directory: input.directory,
      ...(input.expectedDatabaseFile === undefined
        ? {}
        : { expectedDatabaseFile: input.expectedDatabaseFile }),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: input.realmId,
      requireExisting: input.requireExisting,
      requireVacant: input.requireVacant,
      spaceId: input.spaceId,
    });
    try {
      enforcePrivateSqliteFiles(input.directory);
      assertBoundedLogicalDatabase(input.directory);
      const persisted = parseOhStoreBindingV1(authority.store.binding);
      if (
        persisted === null
        || persisted.profile.profileSha256 !== OH_CANONICAL_STORE_PROFILE_V1.profileSha256
        || persisted.realmId !== input.realmId
        || persisted.spaceId !== input.spaceId
        || authority.host.binding.bindingSha256 !== persisted.bindingSha256
        || authority.host.replication === null
        || authority.host.replication.binding.bindingSha256 !== persisted.bindingSha256
      ) throw new Error("FACTS_MEMORY_OH_CANONICAL_BINDING_MISMATCH");
      return authority;
    } catch (error: unknown) {
      try {
        await authority.store.close();
      } catch (closeError: unknown) {
        throw new AggregateError([error, closeError], "Failed to close rejected Oh canonical authority.");
      }
      throw error;
    }
  }

  async #inspectComplete(
    binding: FactsMemoryBinding,
    directory: string,
    metadata: AdapterMetadata,
    expectedHead?: FactsMemoryHead,
  ): Promise<FactsMemoryStoreInspection> {
    this.#assertMetadataBinding(metadata, binding);
    const authority = await this.#open(binding, directory, true);
    try {
      this.#assertMetadataAuthority(metadata, binding, authority);
      const verification = await this.#verifyBounded(authority, directory);
      const head = projectOhHead(verification.head);
      if (expectedHead !== undefined) {
        const expected = factsMemoryHeadSchema.parse(expectedHead);
        if (head.sequence < expected.sequence) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
        if (head.sequence === expected.sequence) {
          if (
            head.operationSha256 !== expected.operationSha256
            || head.digest !== expected.digest
          ) throw new Error("FACTS_MEMORY_OH_HEAD_EQUIVOCATION");
        } else {
          await authority.store.changesSince(ohHeadRef(expected), { limit: 1 });
        }
      }
      if (
        head.sequence < metadata.initialHead.sequence
        || (head.sequence === metadata.initialHead.sequence
          && (head.operationSha256 !== metadata.initialHead.operationSha256
            || head.digest !== metadata.initialHead.digest))
      ) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
      if (head.sequence > metadata.initialHead.sequence) {
        await authority.store.changesSince(ohHeadRef(metadata.initialHead), { limit: 1 });
      }
      const receipt = receiptFromMetadata(metadata);
      const base = {
        bindingDigest: binding.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head,
        initialHead: receipt.head,
        receiptDigest: receipt.receiptDigest,
        version: 1 as const,
      };
      return factsMemoryStoreInspectionSchema.parse({
        ...base,
        inspectionDigest: digestFactsMemoryInspection(base),
      });
    } finally {
      await authority.store.close();
    }
  }

  async #pinCanonicalHead(
    authority: BoundedOhStoreAuthority,
    current: OhHeadV1,
    expected: FactsMemoryHead,
  ): Promise<OhHeadV1> {
    const currentProjected = projectOhHead(current);
    if (currentProjected.sequence < expected.sequence) {
      throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_REGRESSION");
    }
    if (currentProjected.sequence === expected.sequence) {
      if (JSON.stringify(currentProjected) !== JSON.stringify(expected)) {
        throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION");
      }
      return current;
    }
    const expectedReference = ohHeadRef(expected);
    let pinned: Awaited<ReturnType<OhStoreV1["changesSince"]>>;
    try {
      pinned = await authority.store.changesSince(expectedReference, {
        limit: 1,
        through: expectedReference,
      });
    } catch (error: unknown) {
      if (isOhConflictError(error)) {
        throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION", { cause: error });
      }
      throw error;
    }
    if (
      pinned.operations.length !== 0
      || JSON.stringify(projectOhHead(pinned.through)) !== JSON.stringify(expected)
    ) {
      throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION");
    }
    return pinned.through;
  }

  async #assertCanonicalDescendant(
    authority: BoundedOhStoreAuthority,
    current: OhHeadV1,
    ancestor: OhHeadV1,
  ): Promise<void> {
    const currentProjected = projectOhHead(current);
    const ancestorProjected = projectOhHead(ancestor);
    if (currentProjected.sequence < ancestorProjected.sequence) {
      throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_REGRESSION");
    }
    if (currentProjected.sequence === ancestorProjected.sequence) {
      if (JSON.stringify(currentProjected) !== JSON.stringify(ancestorProjected)) {
        throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION");
      }
      return;
    }
    try {
      await authority.store.changesSince(ohHeadRef(ancestorProjected), {
        limit: 1,
        through: ohHeadRef(currentProjected),
      });
    } catch (error: unknown) {
      if (isOhConflictError(error)) {
        throw new Error("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION", { cause: error });
      }
      throw error;
    }
  }

  async #assertWorkingDescendant(
    authority: BoundedOhStoreAuthority,
    current: OhHeadV1,
    ancestor: OhHeadV1,
  ): Promise<void> {
    const currentProjected = projectOhHead(current);
    const ancestorProjected = projectOhHead(ancestor);
    if (currentProjected.sequence < ancestorProjected.sequence) {
      throw new Error("FACTS_MEMORY_OH_WORKING_HEAD_REGRESSION");
    }
    if (currentProjected.sequence === ancestorProjected.sequence) {
      if (JSON.stringify(currentProjected) !== JSON.stringify(ancestorProjected)) {
        throw new Error("FACTS_MEMORY_OH_WORKING_HEAD_EQUIVOCATION");
      }
      return;
    }
    try {
      await authority.store.changesSince(ohHeadRef(ancestorProjected), {
        limit: 1,
        through: ohHeadRef(currentProjected),
      });
    } catch (error: unknown) {
      if (isOhConflictError(error)) {
        throw new Error("FACTS_MEMORY_OH_WORKING_HEAD_EQUIVOCATION", { cause: error });
      }
      throw error;
    }
  }

  async #verifyEmptyWorkingOnlyEphemeral(
    authority: OhSqliteStoreAuthorityV1,
  ): Promise<void> {
    const binding = parseOhStoreBindingV1(authority.store.binding);
    if (
      binding === null
      || binding.profile.profileSha256 !== OH_CANONICAL_STORE_PROFILE_V1.profileSha256
      || authority.host.binding.bindingSha256 !== binding.bindingSha256
      || authority.host.replication === null
      || authority.host.replication.binding.bindingSha256 !== binding.bindingSha256
    ) throw new Error("FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_BINDING_MISMATCH");
    const verification = await authority.store.verify();
    if (
      verification.operations !== 0
      || verification.records !== 0
      || JSON.stringify(verification.head) !== JSON.stringify(emptyOhHeadV1())
    ) throw new Error("FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_NOT_EMPTY");
  }

  async #verifyCanonicalAuthority(
    authority: BoundedOhStoreAuthority,
    directory: string,
    expectedDatabaseFile: OhSqliteDatabaseFileIdentity,
  ): Promise<Awaited<ReturnType<OhStoreV1["verify"]>>> {
    const assertCustody = (): void => {
      assertPrivateDirectory(directory);
      assertExpectedDatabaseFile(join(directory, databaseName), expectedDatabaseFile);
      enforcePrivateSqliteFiles(directory);
      assertExpectedDatabaseFile(join(directory, databaseName), expectedDatabaseFile);
      assertBoundedLogicalDatabase(directory);
      assertSingleOhSpace(authority.database, authority);
    };
    assertCustody();
    const verification = await authority.store.verify();
    assertCustody();
    return verification;
  }

  async #verifyWorkingAuthority(
    authority: BoundedOhStoreAuthority,
    directory: string,
    expectedDatabaseFile: OhSqliteDatabaseFileIdentity,
  ): Promise<Awaited<ReturnType<OhStoreV1["verify"]>>> {
    const assertCustody = (): void => {
      assertPrivateDirectory(directory);
      assertExpectedDatabaseFile(
        join(directory, databaseName),
        expectedDatabaseFile,
        "working",
      );
      enforcePrivateSqliteFiles(directory);
      assertExpectedDatabaseFile(
        join(directory, databaseName),
        expectedDatabaseFile,
        "working",
      );
      assertBoundedLogicalDatabase(directory);
      assertSingleOhSpace(authority.database, authority);
    };
    assertCustody();
    const verification = await authority.store.verify();
    assertCustody();
    return verification;
  }

  async #verifyBounded(
    authority: BoundedOhStoreAuthority,
    directory: string,
  ): Promise<Awaited<ReturnType<OhStoreV1["verify"]>>> {
    assertBoundedLogicalDatabase(directory);
    const verification = await authority.store.verify();
    assertBoundedLogicalDatabase(directory);
    return verification;
  }

  #assertCreation(
    metadata: AdapterMetadata,
    binding: FactsMemoryBinding,
    operationKey: string,
    parent: FactsMemoryCheckpoint | null,
  ): void {
    this.#assertMetadataBinding(metadata, binding);
    if (
      metadata.operationKey !== operationKey
      || metadata.createKind !== (parent === null ? "create" : "fork")
      || !checkpointsEqual(metadata.parent, parent)
    ) throw new Error("FACTS_MEMORY_OH_CREATE_REPLAY_MISMATCH");
  }

  #assertMetadataBinding(metadata: AdapterMetadata, binding: FactsMemoryBinding): void {
    if (metadata.bindingDigest !== binding.bindingDigest) {
      throw new Error("FACTS_MEMORY_OH_METADATA_BINDING_MISMATCH");
    }
  }

  #assertMetadataAuthority(
    metadata: AdapterMetadata,
    binding: FactsMemoryBinding,
    authority: OhStoreAuthorityV1,
  ): void {
    const ohBindingSha256 = authority.store.binding.bindingSha256;
    if (
      metadata.ohBindingSha256 !== ohBindingSha256
      || metadata.handleHash !== this.#handleHash(binding, ohBindingSha256)
    ) throw new Error("FACTS_MEMORY_OH_METADATA_AUTHORITY_MISMATCH");
  }

  #handleHash(binding: FactsMemoryBinding, ohBindingSha256: string): string {
    return digestParts("hra-oh-handle-v1", [binding.bindingDigest, ohBindingSha256]);
  }

  #finalizeForkAttestations(
    binding: FactsMemoryBinding,
    childHead: FactsMemoryHead,
    parent: FactsMemoryCheckpoint,
  ): void {
    this.#forkAttestations.finalizeMemoryWorkingPageAttestationFork({
      childBindingDigest: binding.bindingDigest,
      childHead,
      parentBindingDigest: parent.bindingDigest,
      parentHead: parent.head,
    });
  }

  #spaceId(binding: FactsMemoryBinding): string {
    return binding.epoch === 1
      ? `hra:${binding.sessionId}`
      : `hra:${binding.sessionId}:epoch:${String(binding.epoch)}`;
  }

  #metadata(input: Readonly<{
    binding: FactsMemoryBinding;
    createKind: "create" | "fork";
    ohBindingSha256: string;
    operationKey: string;
    parent: FactsMemoryCheckpoint | null;
    receipt: FactsMemoryStoreReceipt;
  }>): AdapterMetadata {
    const body = {
      bindingDigest: input.binding.bindingDigest,
      createdAt: input.receipt.createdAt,
      createKind: input.createKind,
      handleHash: input.receipt.handleHash,
      initialHead: input.receipt.head,
      ohBindingSha256: factsMemoryDigestSchema.parse(input.ohBindingSha256),
      operationKey: input.operationKey,
      parent: input.parent,
      receiptDigest: input.receipt.receiptDigest,
      version: 1 as const,
    };
    return adapterMetadataSchema.parse({ ...body, adapterDigest: metadataDigest(body) });
  }

  #serializeDirectories<T>(directories: readonly string[], operation: () => Promise<T>): Promise<T> {
    const exact = [...new Set(directories)].sort();
    const acquire = (index: number): Promise<T> => index >= exact.length
      ? operation()
      : this.#serialize(exact[index] as string, async () => await acquire(index + 1));
    return acquire(0);
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.#tails.set(key, current);
    return current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    });
  }
}
