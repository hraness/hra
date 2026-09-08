import { snapshotForeignJson } from "../domain/guards";
import { parseCanonicalMemoryHostedSpaceId } from "../domain/canonical-memory-sync";
import {
  hasExactKeys,
  isDigest,
  isRecord,
  parseEncryptedEnvelope,
  type EncryptedEnvelope,
} from "./contracts";
import type { CloudArgs, CloudTransport } from "./client";
import {
  canonicalMemorySyncLimits,
  parseCanonicalMemoryCreateResult,
  parseCanonicalMemoryHead,
  parseCanonicalMemoryPullPage,
  parseCanonicalMemoryPushRequest,
  parseCanonicalMemorySpaceConfiguration,
  parseCanonicalMemorySpaceList,
  parseCanonicalMemoryWriteResult,
  type CanonicalMemoryCreateResult,
  type CanonicalMemoryHead,
  type CanonicalMemoryPullPage,
  type CanonicalMemoryPushRequest,
  type CanonicalMemorySpaceConfiguration,
  type CanonicalMemorySpaceSummary,
  type CanonicalMemoryWriteResult,
} from "./memory-sync-contracts";

export type CanonicalMemoryTransportErrorCategory =
  | "invalid"
  | "conflict"
  | "missing"
  | "corrupt"
  | "transport";

export type CanonicalMemoryTransportEffect = "none" | "indeterminate";

const errorMessages: Readonly<Record<CanonicalMemoryTransportErrorCategory, string>> = {
  conflict: "Canonical memory operation conflicts with hosted state.",
  corrupt: "Canonical memory hosted state or response is corrupt.",
  invalid: "Canonical memory request is invalid.",
  missing: "Canonical memory space is missing.",
  transport: "Canonical memory transport is unavailable.",
};

export class CanonicalMemoryTransportError extends Error {
  readonly category: CanonicalMemoryTransportErrorCategory;
  readonly code: `CANONICAL_MEMORY_${Uppercase<CanonicalMemoryTransportErrorCategory>}`;
  readonly effect: CanonicalMemoryTransportEffect;

  constructor(
    category: CanonicalMemoryTransportErrorCategory,
    effect: CanonicalMemoryTransportEffect,
  ) {
    super(errorMessages[category]);
    this.name = "CanonicalMemoryTransportError";
    this.category = category;
    this.code = `CANONICAL_MEMORY_${category.toUpperCase()}` as typeof this.code;
    this.effect = effect;
  }
}

export type CanonicalMemoryCreateRequest = Readonly<{
  bindingPolicy: "one_project_one_space";
  encryptedDescriptor: EncryptedEnvelope;
  genesisHeadProof: EncryptedEnvelope;
  genesisToken: string;
  identityContract: 2;
  keyVersion: number;
  spaceId: string;
  wrappedSpaceKey: EncryptedEnvelope;
}>;

export type CanonicalMemorySpaceRequest = Readonly<{ spaceId: string }>;

export type CanonicalMemoryPullRequest = Readonly<{
  afterHeadToken: string;
  afterSequence: number;
  expectedGenesisToken: string;
  expectedKeyVersion: number;
  spaceId: string;
  terminalHeadToken: string;
  terminalSequence: number;
}>;

export interface CanonicalMemoryTransport {
  create(request: CanonicalMemoryCreateRequest): Promise<CanonicalMemoryCreateResult>;
  get(request: CanonicalMemorySpaceRequest): Promise<CanonicalMemorySpaceConfiguration>;
  head(request: CanonicalMemorySpaceRequest): Promise<CanonicalMemoryHead>;
  list(): Promise<readonly CanonicalMemorySpaceSummary[]>;
  pull(request: CanonicalMemoryPullRequest): Promise<CanonicalMemoryPullPage>;
  push(request: CanonicalMemoryPushRequest): Promise<CanonicalMemoryWriteResult>;
}

function fail(
  category: CanonicalMemoryTransportErrorCategory,
  effect: CanonicalMemoryTransportEffect = "none",
): never {
  throw new CanonicalMemoryTransportError(category, effect);
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && !Object.is(value, -0);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  const snapshot = snapshotForeignJson(value);
  return snapshot.ok && isRecord(snapshot.value) ? snapshot.value : null;
}

function strictEnvelope(
  value: unknown,
  maximumCiphertextCharacters: number,
): EncryptedEnvelope | null {
  const snapshot = snapshotForeignJson(value);
  return snapshot.ok
    ? parseEncryptedEnvelope(snapshot.value, maximumCiphertextCharacters)
    : null;
}

function sameEnvelope(left: EncryptedEnvelope, right: EncryptedEnvelope): boolean {
  return left.ciphertext === right.ciphertext
    && left.keyVersion === right.keyVersion
    && left.nonce === right.nonce;
}

function parseCreateRequest(value: unknown): CanonicalMemoryCreateRequest | null {
  const record = snapshotRecord(value);
  if (record === null || !hasExactKeys(record, [
    "bindingPolicy",
    "encryptedDescriptor",
    "genesisHeadProof",
    "genesisToken",
    "identityContract",
    "keyVersion",
    "spaceId",
    "wrappedSpaceKey",
  ])) return null;
  const encryptedDescriptor = strictEnvelope(
    record.encryptedDescriptor,
    canonicalMemorySyncLimits.descriptorCiphertextCharacters,
  );
  const genesisHeadProof = strictEnvelope(
    record.genesisHeadProof,
    canonicalMemorySyncLimits.terminalHeadProofCiphertextCharacters,
  );
  const wrappedSpaceKey = strictEnvelope(
    record.wrappedSpaceKey,
    canonicalMemorySyncLimits.wrappedSpaceKeyCiphertextCharacters,
  );
  if (
    record.bindingPolicy !== "one_project_one_space"
    || record.identityContract !== 2
    || !isDigest(record.genesisToken)
    || !safePositiveInteger(record.keyVersion)
    || parseCanonicalMemoryHostedSpaceId(record.spaceId) === null
    || encryptedDescriptor === null
    || encryptedDescriptor.keyVersion !== record.keyVersion
    || genesisHeadProof === null
    || genesisHeadProof.keyVersion !== record.keyVersion
    || wrappedSpaceKey === null
  ) return null;
  return {
    bindingPolicy: record.bindingPolicy,
    encryptedDescriptor,
    genesisHeadProof,
    genesisToken: record.genesisToken,
    identityContract: record.identityContract,
    keyVersion: record.keyVersion,
    spaceId: record.spaceId as string,
    wrappedSpaceKey,
  };
}

function parseSpaceRequest(value: unknown): CanonicalMemorySpaceRequest | null {
  const record = snapshotRecord(value);
  return record !== null
    && hasExactKeys(record, ["spaceId"])
    && parseCanonicalMemoryHostedSpaceId(record.spaceId) !== null
    ? { spaceId: record.spaceId as string }
    : null;
}

function parsePullRequest(value: unknown): CanonicalMemoryPullRequest | null {
  const record = snapshotRecord(value);
  if (record === null || !hasExactKeys(record, [
    "afterHeadToken",
    "afterSequence",
    "expectedGenesisToken",
    "expectedKeyVersion",
    "spaceId",
    "terminalHeadToken",
    "terminalSequence",
  ])) return null;
  if (
    !isDigest(record.afterHeadToken)
    || !safeNonNegativeInteger(record.afterSequence)
    || !isDigest(record.expectedGenesisToken)
    || !safePositiveInteger(record.expectedKeyVersion)
    || parseCanonicalMemoryHostedSpaceId(record.spaceId) === null
    || !isDigest(record.terminalHeadToken)
    || !safeNonNegativeInteger(record.terminalSequence)
    || record.afterSequence > record.terminalSequence
    || (record.afterSequence === 0
      && record.afterHeadToken !== record.expectedGenesisToken)
    || (record.terminalSequence === 0
      && record.terminalHeadToken !== record.expectedGenesisToken)
    || (record.afterSequence === record.terminalSequence
      && record.afterHeadToken !== record.terminalHeadToken)
  ) return null;
  return {
    afterHeadToken: record.afterHeadToken,
    afterSequence: record.afterSequence,
    expectedGenesisToken: record.expectedGenesisToken,
    expectedKeyVersion: record.expectedKeyVersion,
    spaceId: record.spaceId as string,
    terminalHeadToken: record.terminalHeadToken,
    terminalSequence: record.terminalSequence,
  };
}

function safeErrorMessage(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string"
      && descriptor.value.length <= 4_096
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function classifyTransportError(
  error: unknown,
  mutation: boolean,
): CanonicalMemoryTransportError {
  // CloudTransport exposes only an unknown rejection. Text inside a network
  // or wrapper error cannot prove that a dispatched mutation was rejected by
  // the atomic server handler, so every thrown mutation remains indeterminate.
  if (mutation) return new CanonicalMemoryTransportError("transport", "indeterminate");
  const message = safeErrorMessage(error);
  if (message?.includes("MEMORY_SYNC_INVALID") === true) {
    return new CanonicalMemoryTransportError("invalid", "none");
  }
  if (message?.includes("MEMORY_SYNC_CONFLICT") === true) {
    return new CanonicalMemoryTransportError("conflict", "none");
  }
  if (message?.includes("MEMORY_SPACE_MISSING") === true) {
    return new CanonicalMemoryTransportError("missing", "none");
  }
  if (message?.includes("MEMORY_SYNC_STORAGE_CORRUPT") === true) {
    return new CanonicalMemoryTransportError("corrupt", "none");
  }
  return new CanonicalMemoryTransportError(
    "transport",
    "none",
  );
}

function requireResponse<T>(value: T | null, mutation = false): T {
  return value ?? fail("corrupt", mutation ? "indeterminate" : "none");
}

function requireHostedSpaceId(spaceId: string, mutation = false): void {
  if (parseCanonicalMemoryHostedSpaceId(spaceId) === null) {
    fail("corrupt", mutation ? "indeterminate" : "none");
  }
}

function configurationMatchesCreate(
  response: CanonicalMemoryCreateResult,
  request: CanonicalMemoryCreateRequest,
): boolean {
  return sameEnvelope(response.encryptedDescriptor, request.encryptedDescriptor)
    && sameEnvelope(response.genesisHeadProof, request.genesisHeadProof)
    && response.genesisToken === request.genesisToken
    && response.keyVersion === request.keyVersion
    && response.revision === 1
    && response.spaceId === request.spaceId
    && sameEnvelope(response.wrappedSpaceKey, request.wrappedSpaceKey);
}

function writeMatchesPush(
  response: CanonicalMemoryWriteResult,
  request: CanonicalMemoryPushRequest,
): boolean {
  const submitted = request.operations[0];
  return response.acceptedHeadToken === submitted.headToken
    && response.acceptedSequence === submitted.sequence
    && sameEnvelope(response.acceptedTerminalHeadProof, submitted.terminalHeadProof)
    && response.keyVersion === request.expectedKeyVersion
    && response.revision === request.expectedRevision
    && response.spaceId === request.spaceId;
}

function pullMatchesRequest(
  response: CanonicalMemoryPullPage,
  request: CanonicalMemoryPullRequest,
): boolean {
  if (
    response.spaceId !== request.spaceId
    || response.terminalHeadToken !== request.terminalHeadToken
    || response.terminalSequence !== request.terminalSequence
  ) return false;
  if (request.afterSequence === request.terminalSequence) {
    return response.done && response.operations.length === 0;
  }
  const operation = response.operations[0];
  return response.operations.length === 1
    && operation !== undefined
    && operation.genesisToken === request.expectedGenesisToken
    && operation.sequence === request.afterSequence + 1
    && operation.sequence <= request.terminalSequence
    && operation.priorToken === request.afterHeadToken
    && operation.operation.keyVersion === request.expectedKeyVersion
    && operation.terminalHeadProof.keyVersion === request.expectedKeyVersion
    && response.done === (operation.sequence === request.terminalSequence)
    && (!response.done || operation.headToken === request.terminalHeadToken);
}

export function createCanonicalMemoryTransport(
  transport: CloudTransport,
): CanonicalMemoryTransport {
  async function query(name: Parameters<CloudTransport["query"]>[0], args: CloudArgs) {
    try {
      return await transport.query(name, args);
    } catch (error: unknown) {
      throw classifyTransportError(error, false);
    }
  }

  async function mutation(
    name: Parameters<CloudTransport["mutation"]>[0],
    args: CloudArgs,
  ) {
    try {
      // CloudTransport deliberately performs one mutation attempt. This
      // adapter preserves that boundary and never speculatively replays it.
      return await transport.mutation(name, args);
    } catch (error: unknown) {
      throw classifyTransportError(error, true);
    }
  }

  return {
    async create(input) {
      const request = parseCreateRequest(input) ?? fail("invalid");
      const response = requireResponse(
        parseCanonicalMemoryCreateResult(await mutation("memorySync:create", request)),
        true,
      );
      requireHostedSpaceId(response.spaceId, true);
      if (!configurationMatchesCreate(response, request)) fail("corrupt", "indeterminate");
      return response;
    },

    async get(input) {
      const request = parseSpaceRequest(input) ?? fail("invalid");
      const response = requireResponse(parseCanonicalMemorySpaceConfiguration(
        await query("memorySync:get", request),
      ));
      requireHostedSpaceId(response.spaceId);
      if (response.spaceId !== request.spaceId) fail("corrupt");
      return response;
    },

    async head(input) {
      const request = parseSpaceRequest(input) ?? fail("invalid");
      const response = requireResponse(parseCanonicalMemoryHead(
        await query("memorySync:head", request),
      ));
      requireHostedSpaceId(response.spaceId);
      if (response.spaceId !== request.spaceId) fail("corrupt");
      return response;
    },

    async list() {
      const response = requireResponse(parseCanonicalMemorySpaceList(
        await query("memorySync:list", { limit: canonicalMemorySyncLimits.listSpaces }),
      ));
      for (const space of response) requireHostedSpaceId(space.spaceId);
      return response;
    },

    async pull(input) {
      const request = parsePullRequest(input) ?? fail("invalid");
      const response = requireResponse(parseCanonicalMemoryPullPage(
        await query("memorySync:pull", {
          afterHeadToken: request.afterHeadToken,
          afterSequence: request.afterSequence,
          limit: canonicalMemorySyncLimits.pullOperations,
          spaceId: request.spaceId,
          terminalHeadToken: request.terminalHeadToken,
          terminalSequence: request.terminalSequence,
        }),
      ));
      requireHostedSpaceId(response.spaceId);
      if (!pullMatchesRequest(response, request)) fail("corrupt");
      return response;
    },

    async push(input) {
      const request = parseCanonicalMemoryPushRequest(input);
      if (
        request === null
        || parseCanonicalMemoryHostedSpaceId(request.spaceId) === null
      ) fail("invalid");
      const response = requireResponse(parseCanonicalMemoryWriteResult(
        await mutation("memorySync:push", {
          expectedKeyVersion: request.expectedKeyVersion,
          expectedRevision: request.expectedRevision,
          operations: [request.operations[0]],
          spaceId: request.spaceId,
        }),
      ), true);
      requireHostedSpaceId(response.spaceId, true);
      if (!writeMatchesPush(response, request)) fail("corrupt", "indeterminate");
      return response;
    },
  };
}
