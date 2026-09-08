import {
  canonicalMemoryCiphertextLimits,
  parseCanonicalMemoryHostedSpaceId,
} from "../domain/canonical-memory-sync";
import { snapshotForeignJson } from "../domain/guards";
import {
  hasExactKeys,
  isDigest,
  isRecord,
  parseEncryptedEnvelope,
  type EncryptedEnvelope,
} from "./contracts";

export const canonicalMemorySyncLimits = Object.freeze({
  adoptionProofCiphertextCharacters: canonicalMemoryCiphertextLimits.adoptionProof,
  descriptorCiphertextCharacters: canonicalMemoryCiphertextLimits.terminalHeadProof,
  listSpaces: 100,
  operationCiphertextCharacters: canonicalMemoryCiphertextLimits.operation,
  pullOperations: 1,
  pushOperations: 1,
  terminalHeadProofCiphertextCharacters: canonicalMemoryCiphertextLimits.terminalHeadProof,
  wrappedSpaceKeyCiphertextCharacters: canonicalMemoryCiphertextLimits.terminalHeadProof,
} as const);

export type CanonicalMemoryOperation = Readonly<{
  adoptionProof: EncryptedEnvelope | null;
  genesisToken: string;
  headToken: string;
  operation: EncryptedEnvelope;
  priorToken: string;
  sequence: number;
  terminalHeadProof: EncryptedEnvelope;
}>;

export type CanonicalMemoryPushRequest = Readonly<{
  expectedKeyVersion: number;
  expectedRevision: number;
  operations: readonly [CanonicalMemoryOperation];
  /** Opaque hosted routing ID, never the portable Oh canonical space ID. */
  spaceId: string;
}>;

export type CanonicalMemorySpaceSummary = Readonly<{
  bindingPolicy: "one_project_one_space";
  identityContract: 2;
  keyVersion: number;
  revision: number;
  /** Opaque hosted routing ID. The portable identity is inside the descriptor. */
  spaceId: string;
}>;

export type CanonicalMemorySpaceConfiguration = CanonicalMemorySpaceSummary & Readonly<{
  encryptedDescriptor: EncryptedEnvelope;
  genesisHeadProof: EncryptedEnvelope;
  genesisToken: string;
  wrappedSpaceKey: EncryptedEnvelope;
}>;

export type CanonicalMemoryCreateResult = CanonicalMemorySpaceConfiguration & Readonly<{
  replay: boolean;
}>;

export type CanonicalMemoryHead = Readonly<{
  genesisToken: string;
  headToken: string;
  keyVersion: number;
  revision: number;
  sequence: number;
  spaceId: string;
  terminalHeadProof: EncryptedEnvelope;
}>;

export type CanonicalMemoryWriteResult = Readonly<{
  acceptedHeadToken: string;
  acceptedSequence: number;
  acceptedTerminalHeadProof: EncryptedEnvelope;
  keyVersion: number;
  replay: boolean;
  revision: number;
  spaceId: string;
}>;

export type CanonicalMemoryPullPage = Readonly<{
  done: boolean;
  operations: readonly CanonicalMemoryOperation[];
  spaceId: string;
  terminalHeadToken: string;
  terminalSequence: number;
}>;

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function safePositiveInteger(value: unknown): value is number {
  return safeNonNegativeInteger(value) && value > 0;
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  const snapshot = snapshotForeignJson(value);
  return snapshot.ok && isRecord(snapshot.value) ? snapshot.value : null;
}

function parseOperationSnapshot(value: unknown): CanonicalMemoryOperation | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "adoptionProof",
    "genesisToken",
    "headToken",
    "operation",
    "priorToken",
    "sequence",
    "terminalHeadProof",
  ])) return null;
  const adoptionProof = value.adoptionProof === null
    ? null
    : parseEncryptedEnvelope(
        value.adoptionProof,
        canonicalMemorySyncLimits.adoptionProofCiphertextCharacters,
      );
  const operation = parseEncryptedEnvelope(
    value.operation,
    canonicalMemorySyncLimits.operationCiphertextCharacters,
  );
  const terminalHeadProof = parseEncryptedEnvelope(
    value.terminalHeadProof,
    canonicalMemorySyncLimits.terminalHeadProofCiphertextCharacters,
  );
  if (
    !isDigest(value.genesisToken)
    || !isDigest(value.headToken)
    || !isDigest(value.priorToken)
    || !safePositiveInteger(value.sequence)
    || value.headToken === value.priorToken
    || (value.adoptionProof !== null && adoptionProof === null)
    || operation === null
    || terminalHeadProof === null
    || (adoptionProof !== null && adoptionProof.keyVersion !== operation.keyVersion)
    || operation.keyVersion !== terminalHeadProof.keyVersion
  ) return null;
  return {
    adoptionProof,
    genesisToken: value.genesisToken,
    headToken: value.headToken,
    operation,
    priorToken: value.priorToken,
    sequence: value.sequence,
    terminalHeadProof,
  };
}

export function parseCanonicalMemoryOperation(
  value: unknown,
): CanonicalMemoryOperation | null {
  const snapshot = snapshotRecord(value);
  return snapshot === null ? null : parseOperationSnapshot(snapshot);
}

export function parseCanonicalMemoryPushRequest(
  value: unknown,
): CanonicalMemoryPushRequest | null {
  const snapshot = snapshotRecord(value);
  if (snapshot === null || !hasExactKeys(snapshot, [
    "expectedKeyVersion",
    "expectedRevision",
    "operations",
    "spaceId",
  ])) return null;
  const spaceId = parseCanonicalMemoryHostedSpaceId(snapshot.spaceId);
  if (
    !safePositiveInteger(snapshot.expectedKeyVersion)
    || !safePositiveInteger(snapshot.expectedRevision)
    || spaceId === null
    || !Array.isArray(snapshot.operations)
    || snapshot.operations.length !== canonicalMemorySyncLimits.pushOperations
  ) return null;
  const operation = parseOperationSnapshot(snapshot.operations[0]);
  if (operation === null || operation.operation.keyVersion !== snapshot.expectedKeyVersion) {
    return null;
  }
  return {
    expectedKeyVersion: snapshot.expectedKeyVersion,
    expectedRevision: snapshot.expectedRevision,
    operations: [operation],
    spaceId,
  };
}

function parseSpaceSummarySnapshot(
  value: unknown,
): CanonicalMemorySpaceSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "bindingPolicy",
    "identityContract",
    "keyVersion",
    "revision",
    "spaceId",
  ])) return null;
  const spaceId = parseCanonicalMemoryHostedSpaceId(value.spaceId);
  if (
    value.bindingPolicy !== "one_project_one_space"
    || value.identityContract !== 2
    || !safePositiveInteger(value.keyVersion)
    || !safePositiveInteger(value.revision)
    || spaceId === null
  ) return null;
  return {
    bindingPolicy: value.bindingPolicy,
    identityContract: value.identityContract,
    keyVersion: value.keyVersion,
    revision: value.revision,
    spaceId,
  };
}

export function parseCanonicalMemorySpaceSummary(
  value: unknown,
): CanonicalMemorySpaceSummary | null {
  const snapshot = snapshotRecord(value);
  return snapshot === null ? null : parseSpaceSummarySnapshot(snapshot);
}

export function parseCanonicalMemorySpaceList(
  value: unknown,
): readonly CanonicalMemorySpaceSummary[] | null {
  const snapshot = snapshotForeignJson(value);
  if (
    !snapshot.ok
    || !Array.isArray(snapshot.value)
    || snapshot.value.length > canonicalMemorySyncLimits.listSpaces
  ) return null;
  const spaces: CanonicalMemorySpaceSummary[] = [];
  const identifiers = new Set<string>();
  for (const candidate of snapshot.value) {
    const parsed = parseSpaceSummarySnapshot(candidate);
    if (parsed === null || identifiers.has(parsed.spaceId)) return null;
    identifiers.add(parsed.spaceId);
    spaces.push(parsed);
  }
  return spaces;
}

function parseSpaceConfigurationSnapshot(
  value: unknown,
): CanonicalMemorySpaceConfiguration | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "bindingPolicy",
    "encryptedDescriptor",
    "genesisHeadProof",
    "genesisToken",
    "identityContract",
    "keyVersion",
    "revision",
    "spaceId",
    "wrappedSpaceKey",
  ])) return null;
  const summary = parseSpaceSummarySnapshot({
    bindingPolicy: value.bindingPolicy,
    identityContract: value.identityContract,
    keyVersion: value.keyVersion,
    revision: value.revision,
    spaceId: value.spaceId,
  });
  const encryptedDescriptor = parseEncryptedEnvelope(
    value.encryptedDescriptor,
    canonicalMemorySyncLimits.descriptorCiphertextCharacters,
  );
  const genesisHeadProof = parseEncryptedEnvelope(
    value.genesisHeadProof,
    canonicalMemorySyncLimits.terminalHeadProofCiphertextCharacters,
  );
  const wrappedSpaceKey = parseEncryptedEnvelope(
    value.wrappedSpaceKey,
    canonicalMemorySyncLimits.wrappedSpaceKeyCiphertextCharacters,
  );
  if (
    summary === null
    || !isDigest(value.genesisToken)
    || encryptedDescriptor === null
    || encryptedDescriptor.keyVersion !== summary.keyVersion
    || genesisHeadProof === null
    || genesisHeadProof.keyVersion !== summary.keyVersion
    || wrappedSpaceKey === null
  ) return null;
  return {
    ...summary,
    encryptedDescriptor,
    genesisHeadProof,
    genesisToken: value.genesisToken,
    wrappedSpaceKey,
  };
}

export function parseCanonicalMemorySpaceConfiguration(
  value: unknown,
): CanonicalMemorySpaceConfiguration | null {
  const snapshot = snapshotRecord(value);
  return snapshot === null ? null : parseSpaceConfigurationSnapshot(snapshot);
}

export function parseCanonicalMemoryCreateResult(
  value: unknown,
): CanonicalMemoryCreateResult | null {
  const snapshot = snapshotRecord(value);
  if (snapshot === null || !hasExactKeys(snapshot, [
    "bindingPolicy",
    "encryptedDescriptor",
    "genesisHeadProof",
    "genesisToken",
    "identityContract",
    "keyVersion",
    "replay",
    "revision",
    "spaceId",
    "wrappedSpaceKey",
  ])) return null;
  const configuration = parseSpaceConfigurationSnapshot({
    bindingPolicy: snapshot.bindingPolicy,
    encryptedDescriptor: snapshot.encryptedDescriptor,
    genesisHeadProof: snapshot.genesisHeadProof,
    genesisToken: snapshot.genesisToken,
    identityContract: snapshot.identityContract,
    keyVersion: snapshot.keyVersion,
    revision: snapshot.revision,
    spaceId: snapshot.spaceId,
    wrappedSpaceKey: snapshot.wrappedSpaceKey,
  });
  return configuration === null || typeof snapshot.replay !== "boolean"
    ? null
    : { ...configuration, replay: snapshot.replay };
}

function parseHeadSnapshot(value: unknown): CanonicalMemoryHead | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "genesisToken",
    "headToken",
    "keyVersion",
    "revision",
    "sequence",
    "spaceId",
    "terminalHeadProof",
  ])) return null;
  const terminalHeadProof = parseEncryptedEnvelope(
    value.terminalHeadProof,
    canonicalMemorySyncLimits.terminalHeadProofCiphertextCharacters,
  );
  const spaceId = parseCanonicalMemoryHostedSpaceId(value.spaceId);
  if (
    !isDigest(value.genesisToken)
    || !isDigest(value.headToken)
    || !safePositiveInteger(value.keyVersion)
    || !safePositiveInteger(value.revision)
    || !safeNonNegativeInteger(value.sequence)
    || spaceId === null
    || (value.sequence === 0 && value.headToken !== value.genesisToken)
    || terminalHeadProof === null
    || terminalHeadProof.keyVersion !== value.keyVersion
  ) return null;
  return {
    genesisToken: value.genesisToken,
    headToken: value.headToken,
    keyVersion: value.keyVersion,
    revision: value.revision,
    sequence: value.sequence,
    spaceId,
    terminalHeadProof,
  };
}

export function parseCanonicalMemoryHead(value: unknown): CanonicalMemoryHead | null {
  const snapshot = snapshotRecord(value);
  return snapshot === null ? null : parseHeadSnapshot(snapshot);
}

export function parseCanonicalMemoryWriteResult(
  value: unknown,
): CanonicalMemoryWriteResult | null {
  const snapshot = snapshotRecord(value);
  if (snapshot === null || !hasExactKeys(snapshot, [
    "acceptedHeadToken",
    "acceptedSequence",
    "acceptedTerminalHeadProof",
    "keyVersion",
    "replay",
    "revision",
    "spaceId",
  ])) return null;
  const acceptedTerminalHeadProof = parseEncryptedEnvelope(
    snapshot.acceptedTerminalHeadProof,
    canonicalMemorySyncLimits.terminalHeadProofCiphertextCharacters,
  );
  const spaceId = parseCanonicalMemoryHostedSpaceId(snapshot.spaceId);
  if (
    !isDigest(snapshot.acceptedHeadToken)
    || !safePositiveInteger(snapshot.acceptedSequence)
    || acceptedTerminalHeadProof === null
    || !safePositiveInteger(snapshot.keyVersion)
    || acceptedTerminalHeadProof.keyVersion !== snapshot.keyVersion
    || typeof snapshot.replay !== "boolean"
    || !safePositiveInteger(snapshot.revision)
    || spaceId === null
  ) return null;
  return {
    acceptedHeadToken: snapshot.acceptedHeadToken,
    acceptedSequence: snapshot.acceptedSequence,
    acceptedTerminalHeadProof,
    keyVersion: snapshot.keyVersion,
    replay: snapshot.replay,
    revision: snapshot.revision,
    spaceId,
  };
}

export function parseCanonicalMemoryPullPage(
  value: unknown,
): CanonicalMemoryPullPage | null {
  const snapshot = snapshotRecord(value);
  if (snapshot === null || !hasExactKeys(snapshot, [
    "done",
    "operations",
    "spaceId",
    "terminalHeadToken",
    "terminalSequence",
  ])) return null;
  const spaceId = parseCanonicalMemoryHostedSpaceId(snapshot.spaceId);
  if (
    typeof snapshot.done !== "boolean"
    || !Array.isArray(snapshot.operations)
    || snapshot.operations.length > canonicalMemorySyncLimits.pullOperations
    || spaceId === null
    || !isDigest(snapshot.terminalHeadToken)
    || !safeNonNegativeInteger(snapshot.terminalSequence)
  ) return null;
  const operations: CanonicalMemoryOperation[] = [];
  for (const candidate of snapshot.operations) {
    const operation = parseOperationSnapshot(candidate);
    if (operation === null || operation.sequence > snapshot.terminalSequence) return null;
    operations.push(operation);
  }
  const operation = operations[0];
  if (
    (snapshot.terminalSequence === 0 && operations.length !== 0)
    || (operations.length === 0 && !snapshot.done)
    || (operation !== undefined
      && snapshot.done !== (operation.sequence === snapshot.terminalSequence))
    || (snapshot.done && operation !== undefined
      && operation.headToken !== snapshot.terminalHeadToken)
  ) return null;
  return {
    done: snapshot.done,
    operations,
    spaceId,
    terminalHeadToken: snapshot.terminalHeadToken,
    terminalSequence: snapshot.terminalSequence,
  };
}
