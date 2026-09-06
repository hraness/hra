import { randomBytes, randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";

import {
  OhRecordCodecRegistry,
  canonicalSha256,
  parseOhOperationV1,
  type JsonPrimitive,
  type OhOperationV1,
} from "@hraness/oh";
import {
  OH_MEMORY_PAGE_RECORD_CODEC_V1,
  OhMemoryAdoptionConflictError,
  OhMemoryContinuationError,
  createOhMemoryAuthorityV1,
  createOhMemoryPageRecordV1,
  createOhMemoryPageValueV1,
  parseOhMemoryPageRecordV1,
  type OhMemoryExplanationV2,
  type OhMemoryFactDeclarationV1,
  type OhMemoryFactExtractorV1,
  type OhMemoryNamedProgramV2,
  type OhMemoryPageRecordV1,
  type OhMemoryProofV1,
} from "@hraness/oh/memory";
import {
  createOhProjectionLiteralV1,
  createOhProjectionQueryV1,
  createOhProjectionRulePackV1,
  createOhProjectionRuleV1,
  ohProjectionVariableV1,
  type OhProjectionTermV1,
} from "@hraness/oh/projection";
import { parseOhHeadRefV1, parseOhHeadV1, type OhHeadV1 } from "@hraness/oh/store";

import {
  type HraMemoryExplainInput,
  type HraMemoryQueryInput,
  type HraMemoryRememberInput,
  type HraMemoryShareInput,
} from "../domain/host-tools.ts";
import { createFactsMemoryBinding, type FactsMemoryHead } from "../domain/facts-memory.ts";
import { projectIdSchema, sessionIdSchema } from "../domain/values.ts";
import { factsMemorySessionDirectory } from "../storage/local-facts-memory-broker.ts";
import {
  digestOhHead,
  OhFactsMemoryCustodyError,
  projectOhHead,
  type OhMemoryStoreOperationResult,
  type OhSqliteFactsMemoryEngine,
  type OpenOhMemoryStores,
} from "../storage/oh-facts-memory-engine.ts";
import { ensurePrivateDirectory, type StatePaths } from "../storage/paths.ts";
import {
  MEMORY_SUBMISSION_RETAIN_AGE_MS,
  type MemorySubmissionRecord,
  type ProjectMemoryAuthorityRecord,
  type ProjectMemoryHeadRef,
  type StateStore,
} from "../storage/state-store.ts";
import type { HraFactsMemoryLifecyclePort } from "./facts-memory-lifecycle.ts";

const MEMORY_QUERY_CACHE_LIMIT = 128;
const MEMORY_QUERY_CACHE_BYTES = 32 * 1024 * 1024;
const MEMORY_GET_DATASET_LIMIT = 16;
const MEMORY_SESSION_QUERY_CACHE_LIMIT = 32;
const MEMORY_SESSION_GET_DATASET_LIMIT = 4;
const MEMORY_SESSION_CACHE_BYTES = 8 * 1024 * 1024;
const MEMORY_QUERY_EXPLANATION_TTL_MS = 15 * 60_000;
const MEMORY_WORKING_TTL_MS = 30 * 24 * 60 * 60_000;
const MEMORY_BODY_CHUNK_BYTES = 6 * 1024;
const MEMORY_TOKEN_BYTES = 128;
const MEMORY_QUERY_TOKEN_LIMIT = 4;
const MEMORY_INDEX_TOKEN_LIMIT = 12;
const MEMORY_PAGE_RELATION = "hra.memory.page";
const MEMORY_TOKEN_RELATION = "hra.memory.token";
const MEMORY_NOMINATION_ID = "hra.memory.share";
const MEMORY_DESTINATION_PURPOSE = "hra.project.canonical";
const MEMORY_SNAPSHOT_RECORD_LIMIT = 8_192;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MEMORY_SEARCH_POLICY = Object.freeze({
  bodyIndexed: false,
  indexMayBeTruncated: true,
  indexedFields: ["key", "title", "summary"] as const,
  match: "all-terms" as const,
  maximumIndexedTermsPerPage: MEMORY_INDEX_TOKEN_LIMIT,
  maximumQueryTerms: MEMORY_QUERY_TOKEN_LIMIT,
});

export type HraMemoryRefusalCode =
  | "MEMORY_CONTINUATION_REFUSED"
  | "MEMORY_CANONICAL_FROZEN"
  | "MEMORY_PROJECT_REFUSED"
  | "MEMORY_QUERY_EXPIRED"
  | "MEMORY_RECOVERY_REQUIRED"
  | "MEMORY_SEARCH_TERM_LIMIT"
  | "MEMORY_SHARE_ATTESTATION_REFUSED"
  | "MEMORY_SHARE_CLOSURE_REFUSED";

export class HraMemoryRefusalError extends Error {
  constructor(readonly code: HraMemoryRefusalCode) {
    super(code);
    this.name = "HraMemoryRefusalError";
  }
}

export interface HraMemoryPort {
  status(input: Readonly<{
    actorSessionId: string;
  }>): Promise<Readonly<Record<string, unknown>>>;
  remember(input: Readonly<{
    actorSessionId: string;
    idempotencyKey: string;
    requestDigest: string;
    value: HraMemoryRememberInput;
  }>): Promise<Readonly<Record<string, unknown>>>;
  query(input: Readonly<{
    actorSessionId: string;
    value: HraMemoryQueryInput;
  }>): Promise<Readonly<Record<string, unknown>>>;
  explain(input: Readonly<{
    actorSessionId: string;
    value: HraMemoryExplainInput;
  }>): Promise<Readonly<Record<string, unknown>>>;
  share(input: Readonly<{
    actorSessionId: string;
    idempotencyKey: string;
    requestDigest: string;
    value: HraMemoryShareInput;
  }>): Promise<Readonly<Record<string, unknown>>>;
  recover(): Promise<void>;
  forgetSession(actorSessionId: string): void;
  close(): Promise<void>;
}

type MemoryContext = Readonly<{
  actorId: string;
  actorSessionId: string;
  canonicalAuthorityId: string;
  canonicalDirectory: string;
  canonicalRealmId: string;
  canonicalSpaceId: string;
  control: ProjectMemoryAuthorityRecord | null;
  projectId: string;
  working: Readonly<{
    binding: ReturnType<typeof createFactsMemoryBinding>;
    directory: string;
    expectedHandleHash: string;
    expectedHead: FactsMemoryHead;
  }>;
  workingAuthorityId: string;
}>;

type CachedQuery = Readonly<{
  actorSessionId: string;
  bytes: number;
  createdAt: number;
  datasetId?: string;
  expiresAtMonotonic: number;
  projectId: string;
  rows: readonly Readonly<Record<string, unknown>>[];
  workingBindingDigest: string;
}>;

type GetDataset = Readonly<{
  actorSessionId: string;
  bytes: number;
  canonicalHead: ProjectMemoryHeadRef;
  conflicts: Readonly<Record<string, unknown>>;
  createdAt: number;
  explanations: readonly Readonly<Record<string, unknown>>[];
  expiresAtMonotonic: number;
  id: string;
  key: string;
  pageQueryIds: Map<number, string>;
  projectId: string;
  rows: readonly Readonly<Record<string, unknown>>[];
  workingBindingDigest: string;
  workingHead: ProjectMemoryHeadRef;
}>;

type GetContinuation = Readonly<{
  datasetId: string;
  offset: number;
}>;

const variable = (name: string) => ohProjectionVariableV1(name);
const literal = (relation: string, terms: readonly OhProjectionTermV1[]) =>
  createOhProjectionLiteralV1({ relation, terms });

const evaluation = Object.freeze({
  maximumDerivedTuples: 32_768,
  maximumProofDepth: 8,
  maximumProofNodes: 32,
  maximumResultBytes: 16 * 1024 * 1024,
  maximumRounds: 8,
  maximumTotalProofNodes: 65_536,
  maximumWorkUnits: 2_000_000,
});

const visibleRule = (
  id: string,
  sourceRelation: string,
  visibleRelation: string,
  terms: readonly OhProjectionTermV1[],
) => createOhProjectionRuleV1({
  body: [literal(sourceRelation, terms)],
  head: literal(visibleRelation, terms),
  ruleId: id,
});

const metadataTerms = (keyName = "key") => [
  variable("lane"),
  variable(keyName),
  variable("record_sha256"),
  variable("title"),
  variable("summary"),
  variable("language"),
  variable("created_at"),
  variable("updated_at"),
  variable("attested_at"),
  variable("actor_id"),
  variable("attestation_sha256"),
] as const;

const metadataFind = [
  "lane", "key", "record_sha256", "title", "summary", "language", "created_at", "updated_at",
  "attested_at", "actor_id", "attestation_sha256",
] as const;

const listProgram = (): OhMemoryNamedProgramV2 => {
  const terms = metadataTerms();
  const visible = "hra.memory.visible-page";
  return {
    evaluation,
    maximumPageBytes: 64 * 1024,
    maximumRows: 16_384,
    pageSize: 5,
    parameters: [],
    programId: "hra.memory.list",
    purpose: "hra.memory.list",
    query: createOhProjectionQueryV1({
      find: metadataFind,
      limit: 16_384,
      queryId: "hra.memory.list",
      where: [literal(visible, terms)],
    }),
    rulePack: createOhProjectionRulePackV1({
      rulePackId: "hra.memory.list",
      rulePackRevision: 1,
      rules: [visibleRule("hra.memory.list", MEMORY_PAGE_RELATION, visible, terms)],
    }),
    v: 2,
  };
};

const getProgram = (): OhMemoryNamedProgramV2 => {
  const terms = metadataTerms("lookup_key");
  const visible = "hra.memory.visible-selected-page";
  return {
    evaluation,
    maximumPageBytes: 64 * 1024,
    maximumRows: 2,
    pageSize: 2,
    parameters: ["lookup_key"],
    programId: "hra.memory.get",
    purpose: "hra.memory.get",
    query: createOhProjectionQueryV1({
      find: [
        "lane", "record_sha256", "title", "summary", "language", "created_at", "updated_at",
        "attested_at", "actor_id", "attestation_sha256",
      ],
      limit: 2,
      queryId: "hra.memory.get",
      where: [literal(visible, terms)],
    }),
    rulePack: createOhProjectionRulePackV1({
      rulePackId: "hra.memory.get",
      rulePackRevision: 1,
      rules: [visibleRule("hra.memory.get", MEMORY_PAGE_RELATION, visible, terms)],
    }),
    v: 2,
  };
};

const searchProgram = (tokenCount: number): OhMemoryNamedProgramV2 => {
  const terms = metadataTerms();
  const visible = "hra.memory.searchable-page";
  const tokenNames = Array.from({ length: tokenCount }, (_, index) => `token${index + 1}`);
  const tokenLiterals = tokenNames.map((name) => literal(MEMORY_TOKEN_RELATION, [
    variable("lane"), variable("key"), variable(name),
  ]));
  const suffix = String(tokenCount);
  return {
    evaluation,
    maximumPageBytes: 64 * 1024,
    maximumRows: 16_384,
    pageSize: 5,
    parameters: tokenNames,
    programId: `hra.memory.search-${suffix}`,
    purpose: "hra.memory.search",
    query: createOhProjectionQueryV1({
      find: metadataFind,
      limit: 16_384,
      queryId: `hra.memory.search-${suffix}`,
      where: [literal(visible, terms), ...tokenLiterals],
    }),
    rulePack: createOhProjectionRulePackV1({
      rulePackId: `hra.memory.search-${suffix}`,
      rulePackRevision: 1,
      rules: [visibleRule(
        `hra.memory.search-${suffix}`,
        MEMORY_PAGE_RELATION,
        visible,
        terms,
      )],
    }),
    v: 2,
  };
};

const MEMORY_PROGRAMS = Object.freeze([
  listProgram(),
  getProgram(),
  searchProgram(1),
  searchProgram(2),
  searchProgram(3),
  searchProgram(4),
]);

const utf8Chunks = (value: string): readonly string[] => {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes > 0 && bytes + characterBytes > MEMORY_BODY_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
};

const MEMORY_SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "will", "with",
]);

const lexicalMemoryTokens = (value: string): readonly string[] => {
  const normalized = value.toLocaleLowerCase("en-US").normalize("NFC");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = new Set<string>();
  for (const token of tokens) {
    if (Buffer.byteLength(token, "utf8") <= MEMORY_TOKEN_BYTES) unique.add(token);
  }
  return [...unique];
};

const meaningfulMemoryTokens = (value: string): readonly string[] => {
  const tokens = lexicalMemoryTokens(value);
  const meaningful = tokens.filter((token) => !MEMORY_SEARCH_STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
};

const memoryQueryTokens = (value: string): readonly string[] =>
  meaningfulMemoryTokens(value).slice(0, MEMORY_QUERY_TOKEN_LIMIT + 1).sort();

const memoryIndexTokens = (input: Readonly<{
  key: string;
  summary: string;
  title: string;
}>): readonly string[] => {
  const selected = new Set<string>();
  const take = (tokens: readonly string[], limit: number) => {
    let added = 0;
    for (const token of tokens) {
      if (selected.has(token)) continue;
      selected.add(token);
      added += 1;
      if (added >= limit || selected.size >= MEMORY_INDEX_TOKEN_LIMIT) break;
    }
  };
  take(meaningfulMemoryTokens(input.key), 1);
  take(meaningfulMemoryTokens(input.title), 3);
  take(meaningfulMemoryTokens(input.summary), 8);
  if (selected.size < MEMORY_INDEX_TOKEN_LIMIT) {
    take(meaningfulMemoryTokens(`${input.key}\n${input.title}\n${input.summary}`),
      MEMORY_INDEX_TOKEN_LIMIT - selected.size);
  }
  return [...selected].sort();
};

const userKey = (recordKey: string): string | null =>
  recordKey.startsWith("edition:") ? recordKey.slice("edition:".length) : null;

const MEMORY_FACT_EXTRACTOR: OhMemoryFactExtractorV1 = Object.freeze({
  extractorId: "hra.memory.page",
  extractorSha256: canonicalSha256({
    id: "hra.memory.page",
    normalization: "NFC",
    relations: [MEMORY_PAGE_RELATION, MEMORY_TOKEN_RELATION],
    revision: 3,
    searchFields: ["key", "title", "summary"],
    tokenByteLimit: MEMORY_TOKEN_BYTES,
    tokenLimit: MEMORY_INDEX_TOKEN_LIMIT,
    tokenQuotas: { key: 1, summary: 8, title: 3 },
    tokenizer: "unicode-letter-or-number-runs.v1",
    stopWords: [...MEMORY_SEARCH_STOP_WORDS].sort(),
    lowercaseLocale: "en-US",
  }),
  relations: [MEMORY_PAGE_RELATION, MEMORY_TOKEN_RELATION],
  extract({ lane, record }): readonly OhMemoryFactDeclarationV1[] {
    const page = parseOhMemoryPageRecordV1(record);
    const key = page === null ? null : userKey(page.key);
    if (page === null || key === null) return [];
    const metadata: readonly JsonPrimitive[] = [
      lane,
      key,
      page.recordSha256,
      page.value.title,
      page.value.summary,
      page.value.language ?? "",
      page.value.createdAt,
      page.value.updatedAt,
      page.value.provenance.attestedAt,
      page.value.provenance.actorId,
      page.value.provenance.attestationSha256,
    ];
    const facts: OhMemoryFactDeclarationV1[] = [
      { relation: MEMORY_PAGE_RELATION, tuple: metadata, v: 1 },
    ];
    for (const token of memoryIndexTokens({
      key,
      summary: page.value.summary,
      title: page.value.title,
    })) {
      facts.push({ relation: MEMORY_TOKEN_RELATION, tuple: [lane, key, token], v: 1 });
    }
    return facts;
  },
});

const codecs = (): OhRecordCodecRegistry => new OhRecordCodecRegistry()
  .register(OH_MEMORY_PAGE_RECORD_CODEC_V1);

const physicalKey = (key: string): string => `edition:${key}`;

const memoryContentDigest = (value: HraMemoryRememberInput): string => canonicalSha256({
  body: value.body,
  language: value.language ?? null,
  summary: value.summary,
  title: value.title,
  v: 1,
});

const memoryKeyDigest = (key: string): string => canonicalSha256({ key, v: 1 });

const memoryAttestationSha256 = (input: Readonly<{
  actorId: string;
  actorSessionId: string;
  attestedAt: string;
  contentDigest: string;
  idempotencyKey: string;
  keyDigest: string;
  projectId: string;
  requestDigest: string;
  submissionId: string;
  workingBindingDigest: string;
  workingEpoch: number;
}>) => canonicalSha256({
  actorId: input.actorId,
  actorSessionId: input.actorSessionId,
  attestedAt: input.attestedAt,
  contentDigest: input.contentDigest,
  domain: "hra.memory.host-attestation.v1",
  idempotencyKeySha256: canonicalSha256({ idempotencyKey: input.idempotencyKey, v: 1 }),
  keyDigest: input.keyDigest,
  projectId: input.projectId,
  requestDigest: input.requestDigest,
  submissionId: input.submissionId,
  v: 1,
  workingBindingDigest: input.workingBindingDigest,
  workingEpoch: input.workingEpoch,
});

const rememberRequestId = (submissionId: string): string =>
  submissionId.replace("memsub_", "memsub-");

const rememberOperationId = (input: Readonly<{
  actorId: string;
  bindingSha256: string;
  requestId: string;
}>): string => `memory_${canonicalSha256({
  actorId: input.actorId,
  bindingSha256: input.bindingSha256,
  requestId: input.requestId,
  v: 1,
}).slice(0, 48)}`;

const adoptionOperationId = (input: Readonly<{
  bindingSha256: string;
  nominationSha256: string;
  priorHead: OhHeadV1;
}>): string => `memory_adopt_${canonicalSha256({
  actorId: "hra.memory.host",
  bindingSha256: input.bindingSha256,
  nominationSha256: input.nominationSha256,
  priorHead: input.priorHead,
  v: 1,
}).slice(0, 48)}`;

const toProjectHead = (head: OhHeadV1): ProjectMemoryHeadRef => ({
  headDigest: digestOhHead(head),
  operationSha256: head.operationSha256,
  sequence: head.sequence,
});

const toFactsHead = (head: ProjectMemoryHeadRef): FactsMemoryHead => ({
  digest: head.headDigest,
  operationSha256: head.operationSha256,
  sequence: head.sequence,
});

const toOhHeadRef = (head: ProjectMemoryHeadRef) => {
  const parsed = parseOhHeadRefV1({
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  });
  if (parsed === null) throw new Error("MEMORY_HEAD_REF_INVALID");
  return parsed;
};

const projectHeadsEqual = (
  left: ProjectMemoryHeadRef,
  right: ProjectMemoryHeadRef,
): boolean => left.sequence === right.sequence
  && left.operationSha256 === right.operationSha256
  && left.headDigest === right.headDigest;

const factsHeadsEqual = (
  left: FactsMemoryHead,
  right: FactsMemoryHead,
): boolean => left.sequence === right.sequence
  && left.operationSha256 === right.operationSha256
  && left.digest === right.digest;

const canonicalCustodyFailure = (error: unknown): boolean => {
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => canonicalCustodyFailure(entry));
  }
  if (error instanceof OhFactsMemoryCustodyError) return error.lane === "canonical";
  if (!(error instanceof Error)) return false;
  if (new Set([
    "FACTS_MEMORY_OH_CANONICAL_BINDING_MISMATCH",
    "FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION",
    "FACTS_MEMORY_OH_CANONICAL_HEAD_REGRESSION",
    "FACTS_MEMORY_OH_CANONICAL_INTEGRITY_ERROR",
    "PROJECT_MEMORY_AUTHORITY_CONFLICT",
    "PROJECT_MEMORY_HEAD_CONFLICT",
    "PROJECT_MEMORY_UNBOUND_NONEMPTY_AUTHORITY",
  ]).has(error.message)) return true;
  return error.cause !== undefined && canonicalCustodyFailure(error.cause);
};

const headFromOperation = (operation: OhOperationV1): OhHeadV1 => ({
  generation: operation.sequence,
  graphRevisionSha256: operation.graphRevisionSha256,
  operationSha256: operation.operationSha256,
  recordsSha256: operation.recordsSha256,
  sequence: operation.sequence,
  v: 1,
});

const memoryPageByKeyDigest = (
  records: readonly unknown[],
  keyDigest: string,
): OhMemoryPageRecordV1 | null => {
  const matches: OhMemoryPageRecordV1[] = [];
  for (const value of records) {
    const page = parseOhMemoryPageRecordV1(value);
    const key = page === null ? null : userKey(page.key);
    if (page !== null && key !== null && memoryKeyDigest(key) === keyDigest) {
      matches.push(page);
    }
  }
  if (matches.length > 1) throw new Error("MEMORY_KEY_DIGEST_COLLISION");
  return matches[0] ?? null;
};

const publicHead = (head: ProjectMemoryHeadRef) => ({
  digest: head.headDigest,
  operationSha256: head.operationSha256,
  sequence: head.sequence,
});

const queryId = (): string => `memq_${randomUUID().replaceAll("-", "")}`;

const asString = (value: JsonPrimitive | undefined, label: string): string => {
  if (typeof value !== "string") throw new Error(`MEMORY_RESULT_${label}_INVALID`);
  return value;
};

const metadataRow = (values: readonly JsonPrimitive[]) => {
  if (values.length !== 11) throw new Error("MEMORY_RESULT_ROW_INVALID");
  return {
    lane: asString(values[0], "LANE"),
    key: asString(values[1], "KEY"),
    recordSha256: asString(values[2], "RECORD_SHA256"),
    title: asString(values[3], "TITLE"),
    summary: asString(values[4], "SUMMARY"),
    language: asString(values[5], "LANGUAGE") || null,
    createdAt: asString(values[6], "CREATED_AT"),
    updatedAt: asString(values[7], "UPDATED_AT"),
    provenance: {
      kind: "host-attested",
      attestedAt: asString(values[8], "ATTESTED_AT"),
      actorId: asString(values[9], "ACTOR_ID"),
      attestationSha256: asString(values[10], "ATTESTATION"),
      verification: "unverified",
    },
  };
};

const selectedMetadataRow = (key: string, values: readonly JsonPrimitive[]) => {
  const lane = values[0];
  if (lane === undefined) throw new Error("MEMORY_RESULT_ROW_INVALID");
  return metadataRow([lane, key, ...values.slice(1)]);
};

const compactProof = (proof: OhMemoryProofV1): Readonly<Record<string, unknown>> => {
  if (proof.kind === "fact") {
    return {
      kind: proof.kind,
      relation: proof.relation,
      factPolicy: proof.factPolicy,
      sources: proof.sources.map((source) => ({
        authorityId: source.authorityId,
        bindingSha256: source.bindingSha256,
        head: toProjectHead(source.head),
        key: userKey(source.key) ?? source.key,
        lane: source.lane,
        recordSha256: source.recordSha256,
        snapshotSha256: source.snapshotSha256,
      })),
    };
  }
  if (proof.kind === "truncated") {
    return { kind: proof.kind, reason: proof.reason, relation: proof.relation };
  }
  return {
    kind: proof.kind,
    relation: proof.relation,
    ruleId: proof.ruleId,
    ruleSha256: proof.ruleSha256,
    premisesTruncated: proof.premisesTruncated,
    premises: proof.premises.map(compactProof),
  };
};

const compactExplanation = (value: OhMemoryExplanationV2): Readonly<Record<string, unknown>> => ({
  authority: value.authority,
  explanationSha256: value.explanationSha256,
  premiseAuthority: value.premiseAuthority,
  premiseLanes: value.premiseLanes,
  proofs: value.proofs.map(compactProof),
  proofsTruncated: value.proofsTruncated,
  resultRowSha256: value.resultRowSha256,
  resultSha256: value.resultSha256,
  supportCount: value.supportCount,
});

const submissionResult = (
  record: MemorySubmissionRecord,
  replay: boolean,
): Readonly<Record<string, unknown>> => ({
  version: 1,
  ok: record.state === "applied",
  replay,
  idempotencyRetainedUntil: new Date(
    Math.min(MAX_DATE_MILLISECONDS, record.updatedAt + MEMORY_SUBMISSION_RETAIN_AGE_MS),
  ).toISOString(),
  submission: { id: record.id, kind: record.kind, state: record.state },
});

const rememberSubmissionResult = (
  record: MemorySubmissionRecord,
  replay: boolean,
  key: string,
): Readonly<Record<string, unknown>> => {
  const base = submissionResult(record, replay);
  if (record.state !== "applied") {
    return {
      ...base,
      code: record.state === "cancelled"
        ? "MEMORY_SUBMISSION_CANCELLED"
        : "MEMORY_REMEMBER_NOT_APPLIED",
    };
  }
  if (
    record.outcomeCode !== "remember_committed"
    || record.resultHead === undefined
    || record.effectRecordSha256 === undefined
    || record.receiptDigest === undefined
  ) throw new Error("MEMORY_REMEMBER_TERMINAL_EVIDENCE_INVALID");
  return {
    ...base,
    workingHead: publicHead(record.resultHead),
    page: {
      key,
      operationSha256: record.resultHead.operationSha256,
      recordSha256: record.effectRecordSha256,
    },
    receiptSha256: record.receiptDigest,
  };
};

const shareSubmissionResult = (
  record: MemorySubmissionRecord,
  replay: boolean,
  key: string,
): Readonly<Record<string, unknown>> => {
  const base = submissionResult(record, replay);
  if (record.state === "applied") {
    if (
      (record.outcomeCode !== "share_adopted"
        && record.outcomeCode !== "share_already_present")
      || record.resultHead === undefined
      || record.effectRecordSha256 === undefined
      || record.nominationSha256 === undefined
      || record.receiptDigest === undefined
    ) throw new Error("MEMORY_SHARE_TERMINAL_EVIDENCE_INVALID");
    return {
      ...base,
      canonicalHead: publicHead(record.resultHead),
      share: {
        key,
        nominationSha256: record.nominationSha256,
        operationSha256: record.outcomeCode === "share_adopted"
          ? record.resultHead.operationSha256
          : null,
        recordSha256: record.effectRecordSha256,
        status: record.outcomeCode === "share_adopted" ? "adopted" : "already-present",
      },
      receiptSha256: record.receiptDigest,
    };
  }
  if (record.outcomeCode === "share_conflict" && record.conflict !== undefined) {
    return {
      ...base,
      code: "MEMORY_SHARE_CONFLICT",
      conflict: {
        actualHead: publicHead(record.conflict.actualHead),
        expectedHead: publicHead(record.expectedHead),
        key,
        canonicalRecordSha256: record.conflict.canonicalRecordSha256,
        nominatedRecordSha256: record.conflict.nominatedRecordSha256,
      },
    };
  }
  return {
    ...base,
    code: record.state === "cancelled"
      ? "MEMORY_SUBMISSION_CANCELLED"
      : "MEMORY_SHARE_NOT_APPLIED",
  };
};

type MemoryRecoveryResolution =
  | Readonly<{
      kind: "settle";
      outcomeCode: "remember_committed" | "share_adopted" | "share_already_present";
      receiptDigest: string;
      resultHead: ProjectMemoryHeadRef;
      state: "applied";
    }>
  | Readonly<{
      conflict?: Readonly<{
        actualHead: ProjectMemoryHeadRef;
        canonicalRecordSha256: string | null;
        nominatedRecordSha256: string;
      }>;
      kind: "settle";
      outcomeCode: "remember_not_applied" | "share_conflict" | "share_not_applied";
      state: "failed";
    }>
  | Readonly<{
      canonicalDivergence?: ProjectMemoryHeadRef;
      kind: "unresolved";
    }>;

const rememberReceiptDigest = (input: Readonly<{
  actorId: string;
  authorityId: string;
  bindingSha256: string;
  head: OhHeadV1;
  instant: string;
  operationSha256: string;
  requestId: string;
}>): string => canonicalSha256({
  actorId: input.actorId,
  authorityId: input.authorityId,
  bindingSha256: input.bindingSha256,
  head: input.head,
  instant: input.instant,
  lane: "working",
  operationSha256: input.operationSha256,
  requestId: input.requestId,
  status: "committed",
  v: 1,
});

const adoptionReceiptDigest = (input: Readonly<{
  authorityId: string;
  bindingSha256: string;
  head: OhHeadV1;
  nominationSha256: string;
  operationSha256: string | null;
  priorHead: OhHeadV1;
  status: "adopted" | "already-present";
}>): string => canonicalSha256({
  actorId: "hra.memory.host",
  authorityId: input.authorityId,
  bindingSha256: input.bindingSha256,
  head: input.head,
  nominationSha256: input.nominationSha256,
  operationSha256: input.operationSha256,
  priorHead: input.priorHead,
  status: input.status,
  v: 1,
});

export class HraOhMemoryCoordinator implements HraMemoryPort {
  readonly #continuationKey: Uint8Array;
  readonly #engine: OhSqliteFactsMemoryEngine;
  readonly #factsMemory: HraFactsMemoryLifecyclePort;
  readonly #monotonicNow: () => number;
  readonly #now: () => number;
  readonly #paths: StatePaths;
  readonly #queries = new Map<string, CachedQuery>();
  readonly #quarantinedProjects = new Set<string>();
  #queryBytes = 0;
  readonly #getContinuations = new Map<string, GetContinuation>();
  readonly #getDatasets = new Map<string, GetDataset>();
  #getBytes = 0;
  readonly #store: StateStore;
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #workingTtlMs: number;
  #closed = false;

  constructor(input: Readonly<{
    continuationKey?: Uint8Array;
    engine: OhSqliteFactsMemoryEngine;
    factsMemory: HraFactsMemoryLifecyclePort;
    monotonicNow?: () => number;
    now?: () => number;
    paths: StatePaths;
    store: StateStore;
    workingTtlMs?: number;
  }>) {
    this.#continuationKey = Uint8Array.from(input.continuationKey ?? randomBytes(32));
    if (this.#continuationKey.byteLength < 32 || this.#continuationKey.byteLength > 64) {
      throw new TypeError("MEMORY_CONTINUATION_KEY_INVALID");
    }
    this.#engine = input.engine;
    this.#factsMemory = input.factsMemory;
    this.#monotonicNow = input.monotonicNow ?? (() => performance.now());
    this.#now = input.now ?? Date.now;
    this.#paths = input.paths;
    this.#store = input.store;
    this.#workingTtlMs = input.workingTtlMs ?? MEMORY_WORKING_TTL_MS;
  }

  async recover(): Promise<void> {
    if (this.#closed) throw new Error("MEMORY_COORDINATOR_CLOSED");
    let after: Readonly<{ createdAt: number; id: string }> | undefined;
    for (;;) {
      const page = this.#store.listUnsettledMemorySubmissionsPage({
        limit: 100,
        ...(after === undefined ? {} : { after }),
      });
      for (const observed of page.records) {
        const current = this.#store.requireMemorySubmission(observed.id);
        if (current.state === "prepared") {
          this.#store.cancelPreparedMemorySubmission(current.id);
          continue;
        }
        if (current.state !== "effect_started" && current.state !== "ambiguous") continue;
        try {
          await this.#withProject(current.actorSessionId, async (context) => {
            if (context.projectId !== current.projectId) {
              throw new Error("MEMORY_SUBMISSION_PROJECT_CHANGED");
            }
            await this.#recoverSubmission(context, current.id);
          });
        } catch {
          this.#markAmbiguous(current, current.state);
        }
      }
      if (page.nextCursor === undefined) break;
      after = page.nextCursor;
    }
  }

  async status(input: Readonly<{
    actorSessionId: string;
  }>): Promise<Readonly<Record<string, unknown>>> {
    if (this.#closed) throw new Error("MEMORY_COORDINATOR_CLOSED");
    const actorSessionId = sessionIdSchema.parse(input.actorSessionId);
    const session = this.#store.requireSession(actorSessionId);
    const projectId = session.projectId === undefined
      ? null
      : projectIdSchema.parse(session.projectId);
    const read = (): Readonly<Record<string, unknown>> => {
      const currentSession = this.#store.requireSession(actorSessionId);
      const currentProjectId = currentSession.projectId === undefined
        ? null
        : projectIdSchema.parse(currentSession.projectId);
      if (currentProjectId !== projectId) {
        throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
      }
      const lifecycle = this.#factsMemory.readSession(actorSessionId);
      const control = projectId === null
        ? null
        : this.#store.readProjectMemoryAuthority(projectId);
      const processQuarantined = projectId !== null
        && this.#quarantinedProjects.has(projectId);
      const unsettled = projectId === null
        ? null
        : this.#store.readUnsettledMemorySubmissionForProject(projectId);
      const durableFrozen = control?.syncState === "conflict" || control?.syncState === "error";
      return {
        version: 1,
        ok: true,
        sessionId: currentSession.id,
        projectId,
        canonical: {
          initialized: control !== null,
          authorityDigest: control?.authorityDigest ?? null,
          bindingDigest: control?.bindingDigest ?? null,
          expectedHead: control === null ? null : publicHead(control.head),
          syncState: control?.syncState ?? null,
          frozen: processQuarantined || durableFrozen,
          diagnosticCode: control?.diagnosticCode
            ?? (processQuarantined ? "MEMORY_CANONICAL_PROCESS_QUARANTINED" : null),
          revision: control?.revision ?? null,
          lastExchangeAt: control?.lastExchangeAt ?? null,
          lastExchangeHead: control?.lastExchangeHead === undefined
            ? null
            : publicHead(control.lastExchangeHead),
        },
        working: lifecycle === null
          ? {
              state: "missing",
              ownerMatchesSession: null,
              bindingDigest: null,
              epoch: null,
              head: null,
            }
          : {
              state: lifecycle.state,
              ownerMatchesSession: lifecycle.ownerId === currentSession.profileId,
              bindingDigest: lifecycle.bindingDigest,
              epoch: lifecycle.epoch,
              head: lifecycle.head === null
                ? null
                : {
                    digest: lifecycle.head.digest,
                    operationSha256: lifecycle.head.operationSha256,
                    sequence: lifecycle.head.sequence,
                  },
            },
        unsettledSubmission: unsettled === null
          ? null
          : {
              id: unsettled.id,
              kind: unsettled.kind,
              state: unsettled.state,
              expectedHead: publicHead(unsettled.expectedHead),
              workingBindingDigest: unsettled.workingBindingDigest,
              workingEpoch: unsettled.workingEpoch,
              createdAt: unsettled.createdAt,
              updatedAt: unsettled.updatedAt,
            },
      };
    };
    if (projectId === null) return read();
    const prior = this.#tails.get(projectId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(read);
    this.#tails.set(projectId, current);
    return await current.finally(() => {
      if (this.#tails.get(projectId) === current) this.#tails.delete(projectId);
    });
  }

  remember(input: Readonly<{
    actorSessionId: string;
    idempotencyKey: string;
    requestDigest: string;
    value: HraMemoryRememberInput;
  }>): Promise<Readonly<Record<string, unknown>>> {
    const actorSessionId = sessionIdSchema.parse(input.actorSessionId);
    const contentDigest = memoryContentDigest(input.value);
    const keyDigest = memoryKeyDigest(input.value.key);
    return this.#withProject(actorSessionId, async (context) => {
      let submission: MemorySubmissionRecord | undefined;
      let expectedState: "effect_started" | "ambiguous" | undefined;
      try {
        const opened = await this.#withStores(context, async (stores, control) => {
          const prepared = this.#prepareSubmission({
            actorSessionId,
            contentDigest,
            expectedHead: toProjectHead(stores.working.expectedHead),
            idempotencyKey: input.idempotencyKey,
            keyDigest,
            kind: "remember",
            projectId: context.projectId,
            requestDigest: input.requestDigest,
            workingBindingDigest: context.working.binding.bindingDigest,
            workingEpoch: context.working.binding.epoch,
          });
          submission = prepared.record;
          if (prepared.record.state !== "prepared"
            && prepared.record.state !== "effect_started"
            && prepared.record.state !== "ambiguous") {
            return { control, terminal: prepared.record } as const;
          }
          if (prepared.record.state !== "prepared") {
            throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
          }
          if (!projectHeadsEqual(
            prepared.record.expectedHead,
            toProjectHead(stores.working.expectedHead),
          )) throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
          const authority = await this.#authority(context, stores, prepared.record.createdAt);
          const snapshot = await stores.working.store.snapshot({
            head: {
              operationSha256: stores.working.expectedHead.operationSha256,
              sequence: stores.working.expectedHead.sequence,
            },
            maximumRecords: 8_192,
          });
          const existing = snapshot.records
            .map(parseOhMemoryPageRecordV1)
            .find((record) => record?.key === physicalKey(input.value.key));
          const instant = new Date(prepared.record.createdAt).toISOString();
          const attestationSha256 = memoryAttestationSha256({
            actorId: context.actorId,
            actorSessionId,
            attestedAt: instant,
            contentDigest,
            idempotencyKey: input.idempotencyKey,
            keyDigest,
            projectId: context.projectId,
            requestDigest: input.requestDigest,
            submissionId: prepared.record.id,
            workingBindingDigest: context.working.binding.bindingDigest,
            workingEpoch: context.working.binding.epoch,
          });
          const page = createOhMemoryPageValueV1({
            body: input.value.body,
            createdAt: existing?.value.createdAt ?? instant,
            format: "oh.memory-page.v1",
            language: input.value.language ?? null,
            provenance: {
              actorId: context.actorId,
              attestationSha256,
              attestedAt: instant,
              kind: "host-attested",
              v: 1,
            },
            sources: [],
            summary: input.value.summary,
            title: input.value.title,
            updatedAt: instant,
            v: 1,
          });
          const record = createOhMemoryPageRecordV1({
            dependencies: [],
            key: physicalKey(input.value.key),
            value: page,
          });
          const requestId = rememberRequestId(prepared.record.id);
          const operationId = rememberOperationId({
            actorId: context.actorId,
            bindingSha256: stores.working.bindingSha256,
            requestId,
          });
          submission = this.#store.bindMemorySubmissionEffect({
            attestationSha256,
            effectRecordSha256: record.recordSha256,
            operationId,
            submissionId: prepared.record.id,
          });
          const begun = this.#store.beginMemorySubmission(
            prepared.record.id,
            input.idempotencyKey,
          );
          submission = begun;
          expectedState = begun.state as "effect_started" | "ambiguous";
          const receipt = await authority.agent.remember({
            expectedHead: {
              generation: stores.working.expectedHead.generation,
              operationSha256: stores.working.expectedHead.operationSha256,
            },
            puts: [{
              dependencies: [],
              key: physicalKey(input.value.key),
              kind: "edition",
              v: 1,
              value: record.value,
            }],
            requestId,
            tombstones: [],
            v: 1,
          });
          if (receipt.operationSha256 !== receipt.head.operationSha256) {
            throw new Error("MEMORY_REMEMBER_RECEIPT_HEAD_MISMATCH");
          }
          return { control, recordSha256: record.recordSha256, receipt, terminal: null } as const;
        });
        const observedCanonicalHead = toProjectHead(opened.canonicalHead);
        if (!projectHeadsEqual(observedCanonicalHead, opened.result.control.head)) {
          this.#recordCanonicalDivergence(context.projectId);
        }
        if (opened.result.terminal !== null) {
          return rememberSubmissionResult(opened.result.terminal, true, input.value.key);
        }
        if (submission === undefined || expectedState === undefined) {
          throw new Error("MEMORY_SUBMISSION_STATE_LOST");
        }
        const workingHead = toProjectHead(opened.workingHead);
        const effectHead = toProjectHead(opened.result.receipt.head);
        if (!projectHeadsEqual(workingHead, effectHead)) {
          throw new Error("MEMORY_WORKING_HEAD_DIVERGED_AFTER_REMEMBER");
        }
        const resumed = await this.#factsMemory.resumeSession({
          ownerId: this.#store.requireSession(actorSessionId).profileId,
          sessionId: actorSessionId,
        });
        if (
          resumed.head === null
          || !factsHeadsEqual(resumed.head, projectOhHead(opened.workingHead))
        ) {
          throw new Error("MEMORY_WORKING_HEAD_SETTLEMENT_MISMATCH");
        }
        const settled = this.#store.settleMemorySubmission({
          expectedState,
          outcomeCode: "remember_committed",
          receiptDigest: opened.result.receipt.receiptSha256,
          resultHead: effectHead,
          state: "applied",
          submissionId: submission.id,
        });
        if (settled.effectRecordSha256 !== opened.result.recordSha256) {
          throw new Error("MEMORY_REMEMBER_SETTLEMENT_RECORD_MISMATCH");
        }
        return rememberSubmissionResult(settled, false, input.value.key);
      } catch (error: unknown) {
        if (expectedState === undefined && submission?.state === "prepared") {
          try {
            this.#store.cancelPreparedMemorySubmission(submission.id);
          } catch {
            // Keep the primary pre-effect failure.
          }
        } else {
          this.#markAmbiguous(submission, expectedState);
          const recoveryContext = await this.#context(context.actorSessionId).catch(() => null);
          if (recoveryContext !== null) {
            await this.#recoverSubmission(recoveryContext, submission?.id).catch(() => undefined);
          }
        }
        throw error;
      }
    });
  }

  query(input: Readonly<{
    actorSessionId: string;
    value: HraMemoryQueryInput;
  }>): Promise<Readonly<Record<string, unknown>>> {
    const actorSessionId = sessionIdSchema.parse(input.actorSessionId);
    const getKey = input.value.mode === "get" ? input.value.key : null;
    const getContinuation = input.value.mode === "get" ? input.value.continuation : undefined;
    return this.#withProject(actorSessionId, async (context) => {
      this.#assertProjectRecovered(context.projectId);
      if (getKey !== null && getContinuation !== undefined) {
        const opened = await this.#withStores(context, async () =>
          await this.#continueGet(context, getKey, getContinuation));
        const control = this.#store.readProjectMemoryAuthority(context.projectId);
        const observedCanonicalHead = toProjectHead(opened.canonicalHead);
        if (control === null || !projectHeadsEqual(observedCanonicalHead, control.head)) {
          this.#recordCanonicalDivergence(context.projectId);
          throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
        }
        if (!projectHeadsEqual(toProjectHead(opened.workingHead), {
          headDigest: context.working.expectedHead.digest,
          operationSha256: context.working.expectedHead.operationSha256,
          sequence: context.working.expectedHead.sequence,
        })) throw new HraMemoryRefusalError("MEMORY_CONTINUATION_REFUSED");
        return opened.result;
      }
      try {
        const opened = await this.#withStores(context, async (stores, control) => {
          const authority = await this.#authority(context, stores, this.#now());
          const tokens = input.value.mode === "search"
            ? memoryQueryTokens(input.value.text)
            : [];
          if (tokens.length > MEMORY_QUERY_TOKEN_LIMIT) {
            throw new HraMemoryRefusalError("MEMORY_SEARCH_TERM_LIMIT");
          }
          if (
            input.value.mode === "search"
            && tokens.length === 0
            && input.value.continuation !== undefined
          ) throw new HraMemoryRefusalError("MEMORY_CONTINUATION_REFUSED");
          if (input.value.mode === "search" && tokens.length === 0) {
            return { control, emptySearch: true, explanations: [], query: null } as const;
          }
          const programId = input.value.mode === "list"
            ? "hra.memory.list"
            : input.value.mode === "get"
              ? "hra.memory.get"
              : `hra.memory.search-${String(tokens.length)}`;
          const bindings: Record<string, JsonPrimitive> = input.value.mode === "get"
            ? { lookup_key: input.value.key }
            : Object.fromEntries(tokens.map((token, index) => [`token${index + 1}`, token]));
          const continuation = input.value.mode === "get"
            ? null
            : input.value.continuation ?? null;
          const query = await authority.agent.query({
            bindings,
            continuation,
            programId,
            v: 2,
          });
          const explanations = await Promise.all(query.rows.map(async (_row, pageRow) =>
            compactExplanation(await authority.agent.explain({
              pageRow,
              resultSha256: query.resultSha256,
              token: query.explainCapability.token,
              v: 2,
            }))));
          if (input.value.mode !== "get") {
            return {
              control,
              emptySearch: false,
              explanations,
              materialized: null,
              query,
              tokens,
            } as const;
          }
          const materializedRows: Readonly<Record<string, unknown>>[] = [];
          const materializedExplanations: Readonly<Record<string, unknown>>[] = [];
          for (const [pageRow, row] of query.rows.entries()) {
            if (getKey === null) throw new Error("MEMORY_GET_KEY_LOST");
            const metadata = selectedMetadataRow(getKey, row.values);
            const lane = metadata.lane;
            if (lane !== "canonical" && lane !== "working") {
              throw new Error("MEMORY_RESULT_LANE_INVALID");
            }
            const selected = stores[lane];
            const snapshot = await selected.store.snapshot({
              head: {
                operationSha256: selected.expectedHead.operationSha256,
                sequence: selected.expectedHead.sequence,
              },
              maximumRecords: 8_192,
            });
            const page = snapshot.records
              .map(parseOhMemoryPageRecordV1)
              .find((record) => record?.key === physicalKey(getKey));
            if (page === undefined || page === null
              || page.recordSha256 !== metadata.recordSha256) {
              throw new Error("MEMORY_RESULT_RECORD_MISMATCH");
            }
            const verifiedMetadata = this.#annotateProvenance(
              metadata,
              this.#isAttestedPage(context, page, memoryKeyDigest(getKey), lane),
            );
            const chunks = utf8Chunks(page.value.body);
            const explanation = explanations[pageRow];
            if (explanation === undefined) throw new Error("MEMORY_EXPLANATION_LOST");
            chunks.forEach((bodyChunk, chunkIndex) => {
              materializedRows.push({
                ...verifiedMetadata,
                bodyChunk,
                chunkCount: chunks.length,
                chunkIndex,
              });
              materializedExplanations.push(explanation);
            });
          }
          return {
            control,
            emptySearch: false,
            explanations: materializedExplanations,
            materialized: materializedRows,
            query,
            tokens,
          } as const;
        });
        const observedCanonicalHead = toProjectHead(opened.canonicalHead);
        if (!projectHeadsEqual(observedCanonicalHead, opened.result.control.head)) {
          this.#recordCanonicalDivergence(context.projectId);
          throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
        }
        const canonicalHead = opened.result.control.head;
        const workingHead = toProjectHead(opened.workingHead);
        if (opened.result.emptySearch) {
          return {
            version: 1,
            ok: true,
            mode: input.value.mode,
            queryId: null,
            rows: [],
            continuation: null,
            matchedTokens: [],
            searchPolicy: MEMORY_SEARCH_POLICY,
            canonicalHead: publicHead(canonicalHead),
            workingHead: publicHead(workingHead),
          };
        }
        const result = opened.result.query;
        if (input.value.mode === "get") {
          const dataset = this.#createGetDataset({
            actorSessionId,
            canonicalHead,
            conflicts: result.conflicts,
            context,
            explanations: opened.result.explanations,
            key: getKey ?? (() => { throw new Error("MEMORY_GET_KEY_LOST"); })(),
            rows: opened.result.materialized ?? [],
            workingHead,
          });
          return this.#getPage(context, dataset, 0);
        }
        const id = queryId();
        const rows = result.rows.map((row, rowIndex) => {
          const metadata = metadataRow(row.values);
          return {
            row: rowIndex,
            ...this.#annotateProvenance(
              metadata,
              this.#isAttestedMetadata(context, metadata),
            ),
            premiseAuthority: row.premiseAuthority,
            premiseLanes: row.premiseLanes,
            resultRowSha256: row.resultRowSha256,
            supportCount: row.supportCount,
          };
        });
        this.#cacheQuery(id, context, opened.result.explanations);
        return {
          version: 1,
          ok: true,
          mode: input.value.mode,
          queryId: id,
          rows,
          continuation: result.continuation,
          page: result.page,
          conflicts: result.conflicts,
          ...(input.value.mode === "search"
            ? { matchedTokens: opened.result.tokens, searchPolicy: MEMORY_SEARCH_POLICY }
            : {}),
          canonicalHead: publicHead(canonicalHead),
          workingHead: publicHead(workingHead),
        };
      } catch (error: unknown) {
        if (error instanceof OhMemoryContinuationError) {
          throw new HraMemoryRefusalError("MEMORY_CONTINUATION_REFUSED");
        }
        throw error;
      }
    });
  }

  async explain(input: Readonly<{
    actorSessionId: string;
    value: HraMemoryExplainInput;
  }>): Promise<Readonly<Record<string, unknown>>> {
    if (this.#closed) throw new Error("MEMORY_COORDINATOR_CLOSED");
    const actorSessionId = sessionIdSchema.parse(input.actorSessionId);
    this.#pruneQueries();
    const query = this.#queries.get(input.value.queryId);
    const explanation = query?.rows[input.value.row];
    const session = this.#store.requireSession(actorSessionId);
    if (
      query === undefined
      || query.actorSessionId !== actorSessionId
      || session.projectId !== query.projectId
      || query.expiresAtMonotonic <= this.#monotonicNow()
      || explanation === undefined
    ) throw new HraMemoryRefusalError("MEMORY_QUERY_EXPIRED");
    const context = await this.#context(actorSessionId);
    this.#assertProjectRecovered(context.projectId);
    if (context.working.binding.bindingDigest !== query.workingBindingDigest) {
      throw new HraMemoryRefusalError("MEMORY_QUERY_EXPIRED");
    }
    return {
      version: 1,
      ok: true,
      queryId: input.value.queryId,
      row: input.value.row,
      explanation,
    };
  }

  share(input: Readonly<{
    actorSessionId: string;
    idempotencyKey: string;
    requestDigest: string;
    value: HraMemoryShareInput;
  }>): Promise<Readonly<Record<string, unknown>>> {
    const actorSessionId = sessionIdSchema.parse(input.actorSessionId);
    const keyDigest = memoryKeyDigest(input.value.key);
    return this.#withProject(actorSessionId, async (context) => {
      let submission: MemorySubmissionRecord | undefined;
      let expectedState: "effect_started" | "ambiguous" | undefined;
      try {
        const opened = await this.#withStores(context, async (stores, control) => {
          const priorSubmission = this.#store.readMemorySubmissionByIdempotencyKey(
            input.idempotencyKey,
          );
          if (priorSubmission === null) {
            this.#assertProjectRecovered(context.projectId);
            const observedHead = parseOhHeadV1(await stores.canonical.store.head());
            if (observedHead === null) throw new Error("MEMORY_CANONICAL_HEAD_INVALID");
            const observedProjectHead = toProjectHead(observedHead);
            if (!projectHeadsEqual(observedProjectHead, control.head)) {
              this.#recordCanonicalDivergence(context.projectId);
              throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
            }
          }
          const prepared = this.#prepareSubmission({
            actorSessionId,
            contentDigest: canonicalSha256({ reason: input.value.reason, v: 1 }),
            expectedHead: control.head,
            idempotencyKey: input.idempotencyKey,
            keyDigest,
            kind: "share",
            projectId: context.projectId,
            requestDigest: input.requestDigest,
            workingBindingDigest: context.working.binding.bindingDigest,
            workingEpoch: context.working.binding.epoch,
          });
          submission = prepared.record;
          if (prepared.record.state !== "prepared"
            && prepared.record.state !== "effect_started"
            && prepared.record.state !== "ambiguous") {
            return { conflict: null, receipt: null, terminal: prepared.record } as const;
          }
          if (prepared.record.state !== "prepared") {
            throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
          }
          if (control.syncState === "conflict" || control.syncState === "error") {
            throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
          }
          if (!projectHeadsEqual(prepared.record.expectedHead, control.head)) {
            throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
          }
          const authority = await this.#authority(context, stores, prepared.record.createdAt);
          const nomination = await authority.agent.nominate({
            nominationId: MEMORY_NOMINATION_ID,
            roots: [physicalKey(input.value.key)],
            v: 1,
          });
          const sourceHead = toProjectHead(nomination.source.head);
          if (
            nomination.source.authorityId !== context.workingAuthorityId
            || nomination.source.bindingSha256 !== stores.working.bindingSha256
            || nomination.closure.binding.bindingSha256 !== stores.working.bindingSha256
            || !projectHeadsEqual(sourceHead, toProjectHead(stores.working.expectedHead))
            || nomination.closure.roots.length !== 1
            || nomination.closure.roots[0] !== physicalKey(input.value.key)
            || nomination.closure.records.length !== 1
          ) throw new HraMemoryRefusalError("MEMORY_SHARE_CLOSURE_REFUSED");
          const page = parseOhMemoryPageRecordV1(nomination.closure.records[0]);
          if (
            page === null
            || page.key !== physicalKey(input.value.key)
            || page.dependencies.length !== 0
          ) throw new HraMemoryRefusalError("MEMORY_SHARE_CLOSURE_REFUSED");
          if (!this.#isAttestedPage(context, page, keyDigest, "working")) {
            throw new HraMemoryRefusalError("MEMORY_SHARE_ATTESTATION_REFUSED");
          }
          const dispatchHead = parseOhHeadV1(await stores.canonical.store.head());
          if (dispatchHead === null) throw new Error("MEMORY_CANONICAL_HEAD_INVALID");
          const dispatchProjectHead = toProjectHead(dispatchHead);
          if (!projectHeadsEqual(dispatchProjectHead, control.head)) {
            this.#recordCanonicalDivergence(context.projectId);
            throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
          }
          const operationId = adoptionOperationId({
            bindingSha256: stores.canonical.bindingSha256,
            nominationSha256: nomination.nominationSha256,
            priorHead: stores.canonical.expectedHead,
          });
          submission = this.#store.bindMemorySubmissionEffect({
            attestationSha256: page.value.provenance.attestationSha256,
            effectRecordSha256: page.recordSha256,
            nominationSha256: nomination.nominationSha256,
            operationId,
            sourceHead,
            submissionId: prepared.record.id,
          });
          const begun = this.#store.beginMemorySubmission(
            prepared.record.id,
            input.idempotencyKey,
          );
          submission = begun;
          expectedState = begun.state as "effect_started" | "ambiguous";
          try {
            const receipt = await authority.host.adoptNomination({
              expectedCanonicalHead: stores.canonical.expectedHead,
              nomination,
              v: 1,
            });
            return { conflict: null, pageRecordSha256: page.recordSha256,
              receipt, terminal: null } as const;
          } catch (error: unknown) {
            if (!(error instanceof OhMemoryAdoptionConflictError)) throw error;
            return { conflict: error.conflict, receipt: null, terminal: null } as const;
          }
        });
        const canonicalHead = toProjectHead(opened.canonicalHead);
        if (opened.result.terminal !== null) {
          const control = this.#store.readProjectMemoryAuthority(context.projectId);
          if (control !== null && !projectHeadsEqual(canonicalHead, control.head)) {
            this.#recordCanonicalDivergence(context.projectId);
          }
          return shareSubmissionResult(opened.result.terminal, true, input.value.key);
        }
        if (submission === undefined || expectedState === undefined) {
          throw new Error("MEMORY_SUBMISSION_STATE_LOST");
        }
        if (opened.result.conflict !== null) {
          const conflictRecord = opened.result.conflict.conflicts[0];
          const conflictHead = toProjectHead(opened.result.conflict.actualHead);
          if (
            opened.result.conflict.conflicts.length !== 1
            || conflictRecord === undefined
            || conflictRecord.key !== physicalKey(input.value.key)
            || !projectHeadsEqual(canonicalHead, conflictHead)
          ) throw new Error("MEMORY_SHARE_CONFLICT_EVIDENCE_INVALID");
          const failed = this.#store.settleMemorySubmission({
            conflict: {
              actualHead: conflictHead,
              canonicalRecordSha256: conflictRecord.canonicalRecordSha256,
              nominatedRecordSha256: conflictRecord.nominatedRecordSha256,
            },
            expectedState,
            outcomeCode: "share_conflict",
            state: "failed",
            submissionId: submission.id,
          });
          if (!projectHeadsEqual(conflictHead, submission.expectedHead)) {
            this.#recordCanonicalDivergence(context.projectId);
          }
          return shareSubmissionResult(failed, false, input.value.key);
        }
        const receiptHead = toProjectHead(opened.result.receipt.head);
        if (!projectHeadsEqual(canonicalHead, receiptHead)) {
          throw new Error("MEMORY_CANONICAL_POST_EFFECT_DIVERGENCE");
        }
        const settled = this.#store.settleMemorySubmission({
          expectedState,
          outcomeCode: opened.result.receipt.status === "adopted"
            ? "share_adopted"
            : "share_already_present",
          receiptDigest: opened.result.receipt.receiptSha256,
          resultHead: receiptHead,
          state: "applied",
          submissionId: submission.id,
        });
        if (settled.effectRecordSha256 !== opened.result.pageRecordSha256) {
          throw new Error("MEMORY_SHARE_SETTLEMENT_RECORD_MISMATCH");
        }
        return shareSubmissionResult(settled, false, input.value.key);
      } catch (error: unknown) {
        if (expectedState === undefined && submission?.state === "prepared") {
          try {
            this.#store.cancelPreparedMemorySubmission(submission.id);
          } catch {
            // Keep the primary pre-effect failure.
          }
        } else {
          this.#markAmbiguous(submission, expectedState);
          const recoveryContext = await this.#context(context.actorSessionId).catch(() => null);
          if (recoveryContext !== null) {
            await this.#recoverSubmission(recoveryContext, submission?.id).catch(() => undefined);
          }
        }
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queries.clear();
    this.#queryBytes = 0;
    this.#getContinuations.clear();
    this.#getDatasets.clear();
    this.#getBytes = 0;
    this.#quarantinedProjects.clear();
    await Promise.allSettled(this.#tails.values());
  }

  forgetSession(actorSessionId: string): void {
    const parsed = sessionIdSchema.parse(actorSessionId);
    for (const [id, query] of this.#queries) {
      if (query.actorSessionId === parsed) this.#deleteQuery(id);
    }
    for (const [id, dataset] of this.#getDatasets) {
      if (dataset.actorSessionId === parsed) this.#deleteGetDataset(id);
    }
  }

  #assertProjectRecovered(projectId: string): void {
    const parsed = projectIdSchema.parse(projectId);
    if (this.#quarantinedProjects.has(parsed)) {
      throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
    }
    if (this.#store.readUnsettledMemorySubmissionForProject(parsed) !== null) {
      throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
    }
    const control = this.#store.readProjectMemoryAuthority(parsed);
    if (control?.syncState === "conflict" || control?.syncState === "error") {
      throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
    }
  }

  #recordCanonicalDivergence(projectId: string): void {
    const parsed = projectIdSchema.parse(projectId);
    this.#quarantinedProjects.add(parsed);
    try {
      const current = this.#store.readProjectMemoryAuthority(parsed);
      if (current === null || current.syncState === "conflict" || current.syncState === "error") return;
      this.#store.recordProjectMemorySyncObservation({
        diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
        expectedHead: current.head,
        expectedRevision: current.revision,
        projectId: current.projectId,
        state: "error",
      });
    } catch {
      // The process-local quarantine above remains authoritative when the
      // durable CAS cannot be recorded. Only an explicit future reconciliation
      // path may thaw either fence.
    }
  }

  #annotateProvenance(
    metadata: ReturnType<typeof metadataRow>,
    verified: boolean,
  ): ReturnType<typeof metadataRow> {
    return {
      ...metadata,
      provenance: {
        ...metadata.provenance,
        verification: verified ? "local-ledger-verified" : "unverified",
      },
    };
  }

  #isAttestedMetadata(
    context: MemoryContext,
    metadata: ReturnType<typeof metadataRow>,
  ): boolean {
    if (metadata.lane !== "working" && metadata.lane !== "canonical") return false;
    const keyDigest = memoryKeyDigest(metadata.key);
    const attestation = this.#store.findMemoryPageAttestation(
      metadata.provenance.attestationSha256,
    );
    const authorityDigest = this.#memoryLaneAuthorityDigest(context, metadata.lane);
    if (attestation === null || authorityDigest === null) return false;
    const sourceActorId = `hra.session.${attestation.actorSessionId.replace("sess_", "sess-")}`;
    const expectedAttestation = memoryAttestationSha256({
      actorId: sourceActorId,
      actorSessionId: attestation.actorSessionId,
      attestedAt: metadata.provenance.attestedAt,
      contentDigest: attestation.contentDigest,
      idempotencyKey: attestation.idempotencyKey,
      keyDigest: attestation.keyDigest,
      projectId: attestation.projectId,
      requestDigest: attestation.requestDigest,
      submissionId: attestation.submissionId,
      workingBindingDigest: attestation.workingBindingDigest,
      workingEpoch: attestation.workingEpoch,
    });
    return attestation.projectId === context.projectId
      && attestation.keyDigest === keyDigest
      && attestation.effectRecordSha256 === metadata.recordSha256
      && attestation.attestationSha256 === metadata.provenance.attestationSha256
      && metadata.provenance.actorId === sourceActorId
      && metadata.provenance.attestedAt === new Date(attestation.createdAt).toISOString()
      && expectedAttestation === metadata.provenance.attestationSha256
      && this.#store.isMemoryPageAttestationReferenced({
        attestationSha256: attestation.attestationSha256,
        authorityDigest,
        keyDigest,
        lane: metadata.lane,
        projectId: context.projectId,
      });
  }

  #isAttestedPage(
    context: MemoryContext,
    page: OhMemoryPageRecordV1,
    keyDigest: string,
    lane: "working" | "canonical",
  ): boolean {
    const key = userKey(page.key);
    if (key === null || memoryKeyDigest(key) !== keyDigest || page.dependencies.length !== 0) {
      return false;
    }
    const attestation = this.#store.findMemoryPageAttestation(
      page.value.provenance.attestationSha256,
    );
    const authorityDigest = this.#memoryLaneAuthorityDigest(context, lane);
    if (attestation === null || authorityDigest === null) return false;
    const sourceActorId = `hra.session.${attestation.actorSessionId.replace("sess_", "sess-")}`;
    const contentDigest = memoryContentDigest({
      body: page.value.body,
      key,
      ...(page.value.language === null ? {} : { language: page.value.language }),
      summary: page.value.summary,
      title: page.value.title,
    });
    const expectedAttestation = memoryAttestationSha256({
      actorId: sourceActorId,
      actorSessionId: attestation.actorSessionId,
      attestedAt: page.value.provenance.attestedAt,
      contentDigest: attestation.contentDigest,
      idempotencyKey: attestation.idempotencyKey,
      keyDigest: attestation.keyDigest,
      projectId: attestation.projectId,
      requestDigest: attestation.requestDigest,
      submissionId: attestation.submissionId,
      workingBindingDigest: attestation.workingBindingDigest,
      workingEpoch: attestation.workingEpoch,
    });
    return attestation.projectId === context.projectId
      && attestation.keyDigest === keyDigest
      && attestation.contentDigest === contentDigest
      && attestation.effectRecordSha256 === page.recordSha256
      && attestation.attestationSha256 === page.value.provenance.attestationSha256
      && page.value.provenance.actorId === sourceActorId
      && page.value.provenance.attestedAt === new Date(attestation.createdAt).toISOString()
      && expectedAttestation === page.value.provenance.attestationSha256
      && this.#store.isMemoryPageAttestationReferenced({
        attestationSha256: attestation.attestationSha256,
        authorityDigest,
        keyDigest,
        lane,
        projectId: context.projectId,
      });
  }

  #memoryLaneAuthorityDigest(
    context: MemoryContext,
    lane: "working" | "canonical",
  ): string | null {
    if (lane === "working") return context.working.binding.bindingDigest;
    return this.#store.readProjectMemoryAuthority(context.projectId)?.authorityDigest ?? null;
  }

  async #recoverSubmission(
    context: MemoryContext,
    submissionId: string | undefined,
  ): Promise<void> {
    if (submissionId === undefined) return;
    let submission = this.#store.requireMemorySubmission(submissionId);
    if (submission.state === "prepared") {
      this.#store.cancelPreparedMemorySubmission(submission.id);
      return;
    }
    if (submission.state !== "effect_started" && submission.state !== "ambiguous") return;
    if (
      submission.projectId !== context.projectId
      || submission.workingBindingDigest !== context.working.binding.bindingDigest
      || submission.workingEpoch !== context.working.binding.epoch
    ) return;

    const opened = await this.#withStores(context, async (stores, control) => ({
      controlHead: control.head,
      resolution: submission.kind === "remember"
        ? await this.#inspectRememberRecovery(context, stores, submission)
        : await this.#inspectShareRecovery(context, stores, submission),
    }));
    const resolution = opened.result.resolution;
    const finalCanonicalHead = toProjectHead(opened.canonicalHead);
    const recoveredExpectedAdoption = submission.kind === "share"
      && resolution.kind === "settle"
      && resolution.outcomeCode === "share_adopted"
      && projectHeadsEqual(finalCanonicalHead, resolution.resultHead);
    if (
      !projectHeadsEqual(finalCanonicalHead, opened.result.controlHead)
      && !recoveredExpectedAdoption
    ) {
      this.#recordCanonicalDivergence(context.projectId);
    }
    if (resolution.kind === "unresolved") {
      if (resolution.canonicalDivergence !== undefined) {
        this.#recordCanonicalDivergence(context.projectId);
      }
      return;
    }

    if (
      submission.kind === "share"
      && resolution.outcomeCode !== "share_adopted"
      && !projectHeadsEqual(finalCanonicalHead, submission.expectedHead)
    ) {
      this.#recordCanonicalDivergence(context.projectId);
      return;
    }

    submission = this.#store.requireMemorySubmission(submission.id);
    if (submission.state !== "effect_started" && submission.state !== "ambiguous") return;
    const settled = this.#store.settleMemorySubmission({
      expectedState: submission.state,
      outcomeCode: resolution.outcomeCode,
      state: resolution.state,
      submissionId: submission.id,
      ...(resolution.state === "applied"
        ? { receiptDigest: resolution.receiptDigest, resultHead: resolution.resultHead }
        : {}),
      ...(resolution.state === "failed" && resolution.conflict !== undefined
        ? { conflict: resolution.conflict }
        : {}),
    });
    if (
      settled.kind === "share"
      && settled.outcomeCode === "share_adopted"
      && settled.resultHead !== undefined
      && !projectHeadsEqual(finalCanonicalHead, settled.resultHead)
    ) this.#recordCanonicalDivergence(context.projectId);
  }

  async #inspectRememberRecovery(
    context: MemoryContext,
    stores: OpenOhMemoryStores,
    submission: MemorySubmissionRecord,
  ): Promise<MemoryRecoveryResolution> {
    if (
      submission.effectRecordSha256 === undefined
      || submission.attestationSha256 === undefined
      || submission.operationId === undefined
    ) return { kind: "unresolved" };
    const expectedSnapshot = await stores.working.store.snapshot({
      head: toOhHeadRef(submission.expectedHead),
      maximumRecords: MEMORY_SNAPSHOT_RECORD_LIMIT,
    });
    if (!projectHeadsEqual(toProjectHead(expectedSnapshot.head), submission.expectedHead)) {
      return { kind: "unresolved" };
    }
    const currentHead = stores.working.expectedHead;
    const currentProjectHead = toProjectHead(currentHead);
    if (projectHeadsEqual(currentProjectHead, submission.expectedHead)) {
      return { kind: "settle", outcomeCode: "remember_not_applied", state: "failed" };
    }
    if (currentHead.sequence <= submission.expectedHead.sequence) return { kind: "unresolved" };
    const changes = await stores.working.store.changesSince(
      toOhHeadRef(submission.expectedHead), {
      limit: 2,
      through: {
        operationSha256: currentHead.operationSha256,
        sequence: currentHead.sequence,
      },
      });
    const operation = parseOhOperationV1(changes.operations[0]);
    const change = operation?.changes[0];
    const page = operation !== null
      && operation.changes.length === 1
      && change?.kind === "put"
      ? parseOhMemoryPageRecordV1(change.record)
      : null;
    const key = page === null ? null : userKey(page.key);
    const instant = new Date(submission.createdAt).toISOString();
    const expectedAttestation = memoryAttestationSha256({
      actorId: context.actorId,
      actorSessionId: submission.actorSessionId,
      attestedAt: instant,
      contentDigest: submission.contentDigest,
      idempotencyKey: submission.idempotencyKey,
      keyDigest: submission.keyDigest,
      projectId: submission.projectId,
      requestDigest: submission.requestDigest,
      submissionId: submission.id,
      workingBindingDigest: submission.workingBindingDigest,
      workingEpoch: submission.workingEpoch,
    });
    const exactOperationHead = operation === null ? null : headFromOperation(operation);
    if (
      operation === null
      || changes.operations.length !== 1
      || change?.kind !== "put"
      || page === null
      || key === null
      || operation.actorId !== context.actorId
      || operation.operationId !== submission.operationId
      || operation.spaceId !== stores.working.store.binding.spaceId
      || operation.parentOperationSha256 !== submission.expectedHead.operationSha256
      || operation.sequence !== submission.expectedHead.sequence + 1
      || operation.instant !== instant
      || page.dependencies.length !== 0
      || memoryKeyDigest(key) !== submission.keyDigest
      || page.recordSha256 !== submission.effectRecordSha256
      || page.value.provenance.attestationSha256 !== submission.attestationSha256
      || page.value.provenance.actorId !== context.actorId
      || page.value.provenance.attestedAt !== instant
      || page.value.updatedAt !== instant
      || page.value.sources.length !== 0
      || expectedAttestation !== submission.attestationSha256
      || memoryContentDigest({
        body: page.value.body,
        key,
        ...(page.value.language === null ? {} : { language: page.value.language }),
        summary: page.value.summary,
        title: page.value.title,
      }) !== submission.contentDigest
      || exactOperationHead === null
      || !projectHeadsEqual(currentProjectHead, toProjectHead(exactOperationHead))
    ) return { kind: "unresolved" };
    const head = exactOperationHead;
    return {
      kind: "settle",
      outcomeCode: "remember_committed",
      receiptDigest: rememberReceiptDigest({
        actorId: context.actorId,
        authorityId: context.workingAuthorityId,
        bindingSha256: stores.working.bindingSha256,
        head,
        instant: operation.instant,
        operationSha256: operation.operationSha256,
        requestId: rememberRequestId(submission.id),
      }),
      resultHead: toProjectHead(head),
      state: "applied",
    };
  }

  async #inspectShareRecovery(
    context: MemoryContext,
    stores: OpenOhMemoryStores,
    submission: MemorySubmissionRecord,
  ): Promise<MemoryRecoveryResolution> {
    if (
      submission.effectRecordSha256 === undefined
      || submission.attestationSha256 === undefined
      || submission.operationId === undefined
      || submission.sourceHead === undefined
      || submission.nominationSha256 === undefined
    ) return { kind: "unresolved" };
    const sourceSnapshot = await stores.working.store.snapshot({
      head: toOhHeadRef(submission.sourceHead),
      maximumRecords: MEMORY_SNAPSHOT_RECORD_LIMIT,
    });
    const sourcePage = memoryPageByKeyDigest(sourceSnapshot.records, submission.keyDigest);
    const sourceClosure = sourcePage === null
      ? null
      : await stores.working.store.exportDependencyClosure({
          head: toOhHeadRef(submission.sourceHead),
          maximumRecords: MEMORY_SNAPSHOT_RECORD_LIMIT,
          roots: [sourcePage.key],
        });
    const nominationPayload = sourceClosure === null
      ? null
      : {
          closure: sourceClosure,
          destinationPurpose: MEMORY_DESTINATION_PURPOSE,
          nominationId: MEMORY_NOMINATION_ID,
          source: {
            authorityId: context.workingAuthorityId,
            bindingSha256: stores.working.bindingSha256,
            head: sourceSnapshot.head,
            lane: "working",
            v: 1,
          },
          status: "prepared",
          v: 1,
        } as const;
    if (
      !projectHeadsEqual(toProjectHead(sourceSnapshot.head), submission.sourceHead)
      || sourcePage === null
      || sourceClosure === null
      || sourceClosure.roots.length !== 1
      || sourceClosure.roots[0] !== sourcePage.key
      || sourceClosure.records.length !== 1
      || sourceClosure.records[0]?.recordSha256 !== sourcePage.recordSha256
      || sourcePage.recordSha256 !== submission.effectRecordSha256
      || sourcePage.value.provenance.attestationSha256 !== submission.attestationSha256
      || !this.#isAttestedPage(context, sourcePage, submission.keyDigest, "working")
      || nominationPayload === null
      || canonicalSha256(nominationPayload) !== submission.nominationSha256
      || adoptionOperationId({
        bindingSha256: stores.canonical.bindingSha256,
        nominationSha256: submission.nominationSha256,
        priorHead: stores.canonical.expectedHead,
      }) !== submission.operationId
    ) return { kind: "unresolved" };

    const expectedHead = stores.canonical.expectedHead;
    if (!projectHeadsEqual(toProjectHead(expectedHead), submission.expectedHead)) {
      return { kind: "unresolved" };
    }
    const physicalHead = parseOhHeadV1(await stores.canonical.store.head());
    if (physicalHead === null) return { kind: "unresolved" };
    const physicalProjectHead = toProjectHead(physicalHead);
    const expectedSnapshot = await stores.canonical.store.snapshot({
      head: {
        operationSha256: expectedHead.operationSha256,
        sequence: expectedHead.sequence,
      },
      maximumRecords: MEMORY_SNAPSHOT_RECORD_LIMIT,
    });
    const expectedPage = memoryPageByKeyDigest(expectedSnapshot.records, submission.keyDigest);
    if (projectHeadsEqual(physicalProjectHead, submission.expectedHead)) {
      if (expectedPage?.recordSha256 === submission.effectRecordSha256) {
        return {
          kind: "settle",
          outcomeCode: "share_already_present",
          receiptDigest: adoptionReceiptDigest({
            authorityId: context.canonicalAuthorityId,
            bindingSha256: stores.canonical.bindingSha256,
            head: expectedHead,
            nominationSha256: submission.nominationSha256,
            operationSha256: null,
            priorHead: expectedHead,
            status: "already-present",
          }),
          resultHead: submission.expectedHead,
          state: "applied",
        };
      }
      if (expectedPage === null) {
        return { kind: "settle", outcomeCode: "share_not_applied", state: "failed" };
      }
      return {
        conflict: {
          actualHead: submission.expectedHead,
          canonicalRecordSha256: expectedPage.recordSha256,
          nominatedRecordSha256: submission.effectRecordSha256,
        },
        kind: "settle",
        outcomeCode: "share_conflict",
        state: "failed",
      };
    }
    if (physicalHead.sequence <= expectedHead.sequence) {
      return { canonicalDivergence: physicalProjectHead, kind: "unresolved" };
    }
    let changes: Awaited<ReturnType<OpenOhMemoryStores["canonical"]["store"]["changesSince"]>>;
    try {
      changes = await stores.canonical.store.changesSince({
        operationSha256: expectedHead.operationSha256,
        sequence: expectedHead.sequence,
      }, {
        limit: 2,
        through: {
          operationSha256: physicalHead.operationSha256,
          sequence: physicalHead.sequence,
        },
      });
    } catch {
      return { canonicalDivergence: physicalProjectHead, kind: "unresolved" };
    }
    const operation = parseOhOperationV1(changes.operations[0]);
    const change = operation?.changes[0];
    const page = operation !== null
      && operation.changes.length === 1
      && change?.kind === "put"
      ? parseOhMemoryPageRecordV1(change.record)
      : null;
    const key = page === null ? null : userKey(page.key);
    if (
      operation === null
      || change?.kind !== "put"
      || page === null
      || key === null
      || operation.actorId !== "hra.memory.host"
      || operation.operationId !== submission.operationId
      || operation.spaceId !== stores.canonical.store.binding.spaceId
      || operation.parentOperationSha256 !== expectedHead.operationSha256
      || operation.sequence !== expectedHead.sequence + 1
      || memoryKeyDigest(key) !== submission.keyDigest
      || page.recordSha256 !== submission.effectRecordSha256
      || page.value.provenance.attestationSha256 !== submission.attestationSha256
    ) return { canonicalDivergence: physicalProjectHead, kind: "unresolved" };
    const resultHead = headFromOperation(operation);
    return {
      kind: "settle",
      outcomeCode: "share_adopted",
      receiptDigest: adoptionReceiptDigest({
        authorityId: context.canonicalAuthorityId,
        bindingSha256: stores.canonical.bindingSha256,
        head: resultHead,
        nominationSha256: submission.nominationSha256,
        operationSha256: operation.operationSha256,
        priorHead: expectedHead,
        status: "adopted",
      }),
      resultHead: toProjectHead(resultHead),
      state: "applied",
    };
  }

  async #context(actorSessionId: string): Promise<MemoryContext> {
    if (this.#closed) throw new Error("MEMORY_COORDINATOR_CLOSED");
    const session = this.#store.requireSession(sessionIdSchema.parse(actorSessionId));
    if (session.projectId === undefined) {
      throw new HraMemoryRefusalError("MEMORY_PROJECT_REFUSED");
    }
    const projectId = projectIdSchema.parse(session.projectId);
    const expiresAt = Math.min(Number.MAX_SAFE_INTEGER, this.#now() + this.#workingTtlMs);
    const lifecycle = await this.#factsMemory.ensureSession({
      expiresAt,
      ownerId: session.profileId,
      sessionId: session.id,
    });
    if (lifecycle.state !== "active" || lifecycle.handleHash === null || lifecycle.head === null) {
      throw new Error("MEMORY_WORKING_AUTHORITY_UNAVAILABLE");
    }
    const binding = createFactsMemoryBinding({
      epoch: lifecycle.epoch,
      ownerId: session.profileId,
      sessionId: session.id,
    });
    if (binding.bindingDigest !== lifecycle.bindingDigest) {
      throw new Error("MEMORY_WORKING_BINDING_MISMATCH");
    }
    const projectDigest = canonicalSha256({ projectId, v: 1 });
    const canonicalRoot = await ensurePrivateDirectory(this.#paths.projectMemory);
    const canonicalDirectory = resolve(join(canonicalRoot, projectDigest));
    if (relative(canonicalRoot, canonicalDirectory) !== projectDigest) {
      throw new Error("MEMORY_PROJECT_PATH_ESCAPE");
    }
    await ensurePrivateDirectory(canonicalDirectory);
    return {
      actorId: `hra.session.${session.id.replace("sess_", "sess-")}`,
      actorSessionId: session.id,
      canonicalAuthorityId: `hra.memory.canonical.${projectDigest}`,
      canonicalDirectory,
      canonicalRealmId: `hra:project-memory:${projectDigest}`,
      canonicalSpaceId: `hra:project:${projectDigest}`,
      control: this.#store.readProjectMemoryAuthority(projectId),
      projectId,
      working: {
        binding,
        directory: factsMemorySessionDirectory(this.#paths.factsMemorySessions, binding),
        expectedHandleHash: lifecycle.handleHash,
        expectedHead: lifecycle.head,
      },
      workingAuthorityId: `hra.memory.working.${binding.bindingDigest}`,
    };
  }

  async #withStores<T>(
    context: MemoryContext,
    operation: (
      stores: OpenOhMemoryStores,
      control: ProjectMemoryAuthorityRecord,
    ) => Promise<T>,
  ): Promise<OhMemoryStoreOperationResult<T>> {
    try {
      return await this.#engine.withMemoryStores({
        canonical: {
          directory: context.canonicalDirectory,
          ...(context.control === null ? {} : { expectedHead: toFactsHead(context.control.head) }),
          realmId: context.canonicalRealmId,
          spaceId: context.canonicalSpaceId,
        },
        working: context.working,
      }, async (stores) => {
        let control = context.control;
        const physicalHead = toProjectHead(stores.canonical.expectedHead);
        const bindingDigest = stores.canonical.bindingSha256;
        const authorityDigest = canonicalSha256({
          bindingDigest,
          projectId: context.projectId,
          purpose: MEMORY_DESTINATION_PURPOSE,
          v: 1,
        });
        if (control === null) {
          if (physicalHead.sequence !== 0) {
            throw new Error("PROJECT_MEMORY_UNBOUND_NONEMPTY_AUTHORITY");
          }
          control = this.#store.initializeProjectMemoryAuthority({
            authorityDigest,
            bindingDigest,
            head: physicalHead,
            projectId: context.projectId,
          });
        }
        if (
          control.authorityDigest !== authorityDigest
          || control.bindingDigest !== bindingDigest
          || !projectHeadsEqual(control.head, physicalHead)
        ) throw new Error("PROJECT_MEMORY_AUTHORITY_CONFLICT");
        return await operation(stores, control);
      });
    } catch (error: unknown) {
      if (canonicalCustodyFailure(error)) {
        this.#recordCanonicalDivergence(context.projectId);
        throw new HraMemoryRefusalError("MEMORY_CANONICAL_FROZEN");
      }
      throw error;
    }
  }

  async #authority(
    context: MemoryContext,
    stores: OpenOhMemoryStores,
    clockMs: number,
  ) {
    return await createOhMemoryAuthorityV1({
      actorId: context.actorId,
      adoptionActorId: "hra.memory.host",
      canonical: {
        authorityId: context.canonicalAuthorityId,
        expectedBindingSha256: stores.canonical.bindingSha256,
        expectedHead: stores.canonical.expectedHead,
        store: stores.canonical.store,
      },
      continuationKey: this.#continuationKey,
      explainCapabilityLifetimeMs: MEMORY_QUERY_EXPLANATION_TTL_MS,
      extractors: [MEMORY_FACT_EXTRACTOR],
      monotonicNow: this.#monotonicNow,
      nominationRoutes: [{
        destinationPurpose: MEMORY_DESTINATION_PURPOSE,
        nominationId: MEMORY_NOMINATION_ID,
      }],
      now: () => new Date(clockMs),
      programs: MEMORY_PROGRAMS,
      working: {
        authorityId: context.workingAuthorityId,
        codecs: codecs(),
        expectedBindingSha256: stores.working.bindingSha256,
        store: stores.working.store,
      },
    });
  }

  #prepareSubmission(input: Readonly<{
    actorSessionId: string;
    contentDigest: string;
    expectedHead: ProjectMemoryHeadRef;
    idempotencyKey: string;
    keyDigest: string;
    kind: "remember" | "share";
    projectId: string;
    requestDigest: string;
    workingBindingDigest: string;
    workingEpoch: number;
  }>) {
    const existing = this.#store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey);
    if (existing !== null) {
      return this.#store.prepareMemorySubmission({
        actorSessionId: sessionIdSchema.parse(input.actorSessionId),
        contentDigest: input.contentDigest,
        expectedHead: existing.expectedHead,
        idempotencyKey: input.idempotencyKey,
        keyDigest: input.keyDigest,
        kind: input.kind,
        projectId: projectIdSchema.parse(input.projectId),
        requestDigest: input.requestDigest,
        workingBindingDigest: existing.workingBindingDigest,
        workingEpoch: existing.workingEpoch,
      });
    }
    const unsettled = this.#store.readUnsettledMemorySubmissionForProject(
      projectIdSchema.parse(input.projectId),
    );
    if (unsettled !== null) {
      throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
    }
    return this.#store.prepareMemorySubmission({
      actorSessionId: sessionIdSchema.parse(input.actorSessionId),
      contentDigest: input.contentDigest,
      expectedHead: input.expectedHead,
      idempotencyKey: input.idempotencyKey,
      keyDigest: input.keyDigest,
      kind: input.kind,
      projectId: projectIdSchema.parse(input.projectId),
      requestDigest: input.requestDigest,
      workingBindingDigest: input.workingBindingDigest,
      workingEpoch: input.workingEpoch,
    });
  }

  #markAmbiguous(
    submission: MemorySubmissionRecord | undefined,
    expectedState: "effect_started" | "ambiguous" | undefined,
  ): void {
    if (submission === undefined || expectedState === undefined) return;
    try {
      const current = this.#store.requireMemorySubmission(submission.id);
      if (current.state !== "effect_started" && current.state !== "ambiguous") return;
      this.#store.settleMemorySubmission({
        expectedState: current.state,
        state: "ambiguous",
        submissionId: current.id,
      });
    } catch {
      // The durable record may already be terminal. Never hide the original
      // physical-authority failure with a secondary reconciliation failure.
    }
  }

  #cacheQuery(
    id: string,
    context: MemoryContext,
    rows: readonly Readonly<Record<string, unknown>>[],
    sharedDatasetId?: string,
  ): void {
    this.#pruneQueries();
    this.#deleteQuery(id);
    // Get-page explanations are references into the already-accounted dataset;
    // charging their serialized form again could evict that dataset before its
    // continuation is issued.
    const bytes = sharedDatasetId === undefined
      ? Buffer.byteLength(JSON.stringify(rows), "utf8")
      : 0;
    if (bytes > MEMORY_QUERY_CACHE_BYTES) {
      throw new Error("MEMORY_EXPLANATION_CACHE_ENTRY_TOO_LARGE");
    }
    while (
      this.#sessionQueryCount(context.actorSessionId) >= MEMORY_SESSION_QUERY_CACHE_LIMIT
      || this.#sessionCacheBytes(context.actorSessionId) + bytes > MEMORY_SESSION_CACHE_BYTES
    ) {
      if (!this.#evictOldestCache(sharedDatasetId, context.actorSessionId)) break;
    }
    while (
      this.#queries.size >= MEMORY_QUERY_CACHE_LIMIT
      || this.#queryBytes + this.#getBytes + bytes > MEMORY_QUERY_CACHE_BYTES
    ) {
      if (!this.#evictOldestCache(sharedDatasetId)) break;
    }
    if (sharedDatasetId !== undefined && !this.#getDatasets.has(sharedDatasetId)) {
      throw new Error("MEMORY_GET_DATASET_EVICTED_BEFORE_EXPLANATION");
    }
    if (
      this.#sessionQueryCount(context.actorSessionId) >= MEMORY_SESSION_QUERY_CACHE_LIMIT
      || this.#sessionCacheBytes(context.actorSessionId) + bytes > MEMORY_SESSION_CACHE_BYTES
    ) throw new Error("MEMORY_SESSION_EXPLANATION_CACHE_LIMIT");
    const createdAt = this.#now();
    this.#queries.set(id, {
      actorSessionId: context.actorSessionId,
      bytes,
      createdAt,
      ...(sharedDatasetId === undefined ? {} : { datasetId: sharedDatasetId }),
      expiresAtMonotonic: this.#monotonicNow() + MEMORY_QUERY_EXPLANATION_TTL_MS,
      projectId: context.projectId,
      rows,
      workingBindingDigest: context.working.binding.bindingDigest,
    });
    this.#queryBytes += bytes;
  }

  #pruneQueries(): void {
    const now = this.#monotonicNow();
    for (const [id, query] of this.#queries) {
      if (query.expiresAtMonotonic <= now) this.#deleteQuery(id);
    }
    for (const [id, dataset] of this.#getDatasets) {
      if (dataset.expiresAtMonotonic <= now) this.#deleteGetDataset(id);
    }
  }

  #deleteQuery(id: string): void {
    const query = this.#queries.get(id);
    if (query !== undefined) this.#queryBytes -= query.bytes;
    this.#queries.delete(id);
  }

  #createGetDataset(input: Readonly<{
    actorSessionId: string;
    canonicalHead: ProjectMemoryHeadRef;
    conflicts: Readonly<Record<string, unknown>>;
    context: MemoryContext;
    explanations: readonly Readonly<Record<string, unknown>>[];
    key: string;
    rows: readonly Readonly<Record<string, unknown>>[];
    workingHead: ProjectMemoryHeadRef;
  }>): GetDataset {
    this.#pruneQueries();
    const bytes = Buffer.byteLength(JSON.stringify({
      canonicalHead: input.canonicalHead,
      conflicts: input.conflicts,
      explanations: input.explanations,
      key: input.key,
      rows: input.rows,
      workingHead: input.workingHead,
    }), "utf8");
    if (bytes > MEMORY_QUERY_CACHE_BYTES) {
      throw new Error("MEMORY_GET_CACHE_ENTRY_TOO_LARGE");
    }
    while (
      this.#sessionGetDatasetCount(input.actorSessionId) >= MEMORY_SESSION_GET_DATASET_LIMIT
      || this.#sessionCacheBytes(input.actorSessionId) + bytes > MEMORY_SESSION_CACHE_BYTES
    ) {
      if (!this.#evictOldestCache(undefined, input.actorSessionId)) break;
    }
    while (
      this.#getDatasets.size >= MEMORY_GET_DATASET_LIMIT
      || this.#queryBytes + this.#getBytes + bytes > MEMORY_QUERY_CACHE_BYTES
    ) {
      if (!this.#evictOldestCache()) break;
    }
    if (
      this.#sessionGetDatasetCount(input.actorSessionId) >= MEMORY_SESSION_GET_DATASET_LIMIT
      || this.#sessionCacheBytes(input.actorSessionId) + bytes > MEMORY_SESSION_CACHE_BYTES
    ) throw new Error("MEMORY_SESSION_GET_CACHE_LIMIT");
    const id = `memget_${randomUUID().replaceAll("-", "")}`;
    const dataset: GetDataset = {
      actorSessionId: input.actorSessionId,
      bytes,
      canonicalHead: input.canonicalHead,
      conflicts: input.conflicts,
      createdAt: this.#now(),
      explanations: input.explanations,
      expiresAtMonotonic: this.#monotonicNow() + MEMORY_QUERY_EXPLANATION_TTL_MS,
      id,
      key: input.key,
      pageQueryIds: new Map<number, string>(),
      projectId: input.context.projectId,
      rows: input.rows,
      workingBindingDigest: input.context.working.binding.bindingDigest,
      workingHead: input.workingHead,
    };
    this.#getDatasets.set(id, dataset);
    this.#getBytes += bytes;
    return dataset;
  }

  async #continueGet(
    context: MemoryContext,
    key: string,
    token: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#pruneQueries();
    const continuation = this.#getContinuations.get(token);
    const dataset = continuation === undefined
      ? undefined
      : this.#getDatasets.get(continuation.datasetId);
    if (
      continuation === undefined
      || dataset === undefined
      || dataset.actorSessionId !== context.actorSessionId
      || dataset.projectId !== context.projectId
      || dataset.key !== key
      || dataset.workingBindingDigest !== context.working.binding.bindingDigest
      || !projectHeadsEqual(dataset.workingHead, {
        headDigest: context.working.expectedHead.digest,
        operationSha256: context.working.expectedHead.operationSha256,
        sequence: context.working.expectedHead.sequence,
      })
      || context.control === null
      || !projectHeadsEqual(dataset.canonicalHead, context.control.head)
    ) throw new HraMemoryRefusalError("MEMORY_CONTINUATION_REFUSED");
    return this.#getPage(context, dataset, continuation.offset);
  }

  #getPage(
    context: MemoryContext,
    dataset: GetDataset,
    offset: number,
  ): Readonly<Record<string, unknown>> {
    const pageSize = 2;
    const rows = dataset.rows.slice(offset, offset + pageSize)
      .map((row, rowIndex) => ({ row: rowIndex, ...row }));
    const explanations = dataset.explanations.slice(offset, offset + pageSize);
    const id = dataset.pageQueryIds.get(offset) ?? queryId();
    dataset.pageQueryIds.set(offset, id);
    this.#cacheQuery(id, context, explanations, dataset.id);
    const endExclusive = offset + rows.length;
    let continuation: string | null = null;
    if (endExclusive < dataset.rows.length) {
      if (!this.#getDatasets.has(dataset.id)) {
        throw new Error("MEMORY_GET_DATASET_EVICTED_BEFORE_CONTINUATION");
      }
      continuation = this.#getContinuation(dataset.id, endExclusive);
    }
    return {
      version: 1,
      ok: true,
      mode: "get",
      queryId: id,
      rows,
      continuation,
      page: {
        completeness: continuation === null ? "complete" : "partial",
        endExclusive,
        hasMore: continuation !== null,
        pageSize,
        returnedRows: rows.length,
        start: offset,
        totalRows: dataset.rows.length,
      },
      conflicts: dataset.conflicts,
      canonicalHead: publicHead(dataset.canonicalHead),
      workingHead: publicHead(dataset.workingHead),
    };
  }

  #getContinuation(datasetId: string, offset: number): string {
    for (const [token, continuation] of this.#getContinuations) {
      if (continuation.datasetId === datasetId && continuation.offset === offset) return token;
    }
    const token = `memc_${randomUUID().replaceAll("-", "")}`;
    this.#getContinuations.set(token, { datasetId, offset });
    return token;
  }

  #deleteGetDataset(id: string): void {
    const dataset = this.#getDatasets.get(id);
    if (dataset !== undefined) this.#getBytes -= dataset.bytes;
    this.#getDatasets.delete(id);
    for (const [queryId, query] of this.#queries) {
      if (query.datasetId === id) this.#deleteQuery(queryId);
    }
    for (const [token, continuation] of this.#getContinuations) {
      if (continuation.datasetId === id) this.#getContinuations.delete(token);
    }
  }

  #sessionQueryCount(actorSessionId: string): number {
    let total = 0;
    for (const query of this.#queries.values()) {
      if (query.actorSessionId === actorSessionId) total += 1;
    }
    return total;
  }

  #sessionGetDatasetCount(actorSessionId: string): number {
    let total = 0;
    for (const dataset of this.#getDatasets.values()) {
      if (dataset.actorSessionId === actorSessionId) total += 1;
    }
    return total;
  }

  #sessionCacheBytes(actorSessionId: string): number {
    let total = 0;
    for (const query of this.#queries.values()) {
      if (query.actorSessionId === actorSessionId) total += query.bytes;
    }
    for (const dataset of this.#getDatasets.values()) {
      if (dataset.actorSessionId === actorSessionId) total += dataset.bytes;
    }
    return total;
  }

  #evictOldestCache(
    protectedDatasetId?: string,
    preferredActorSessionId?: string,
  ): boolean {
    const query = [...this.#queries.entries()]
      .find(([, value]) => preferredActorSessionId === undefined
        || value.actorSessionId === preferredActorSessionId);
    const dataset = [...this.#getDatasets.entries()]
      .find(([id, value]) => id !== protectedDatasetId
        && (preferredActorSessionId === undefined
          || value.actorSessionId === preferredActorSessionId));
    if (query === undefined && dataset === undefined) return false;
    if (query === undefined) {
      if (dataset === undefined) return false;
      this.#deleteGetDataset(dataset[0]);
    } else if (dataset === undefined || query[1].createdAt <= dataset[1].createdAt) {
      this.#deleteQuery(query[0]);
    } else {
      this.#deleteGetDataset(dataset[0]);
    }
    return true;
  }

  #withProject<T>(actorSessionId: string, operation: (context: MemoryContext) => Promise<T>): Promise<T> {
    const session = this.#store.requireSession(sessionIdSchema.parse(actorSessionId));
    if (session.projectId === undefined) {
      return Promise.reject(new HraMemoryRefusalError("MEMORY_PROJECT_REFUSED"));
    }
    const key = projectIdSchema.parse(session.projectId);
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(async () => {
      const context = await this.#context(actorSessionId);
      // The tail key and the physical canonical authority must describe the
      // same project. A queued operation may not follow a concurrent session
      // project change onto a different authority while still holding the old
      // project's serialization position.
      if (context.projectId !== key) {
        throw new HraMemoryRefusalError("MEMORY_RECOVERY_REQUIRED");
      }
      return await operation(context);
    });
    this.#tails.set(key, current);
    return current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    });
  }
}
