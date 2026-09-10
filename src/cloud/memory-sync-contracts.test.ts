import { describe, expect, test } from "bun:test";

import {
  canonicalMemorySyncLimits,
  parseCanonicalMemoryCreateResult,
  parseCanonicalMemoryHead,
  parseCanonicalMemoryPullPage,
  parseCanonicalMemoryPushRequest,
  parseCanonicalMemorySpaceConfiguration,
  parseCanonicalMemorySpaceList,
  parseCanonicalMemoryWriteResult,
} from "./memory-sync-contracts";

const envelope = (ciphertext = "A".repeat(22)) => ({
  algorithm: "A256GCM" as const,
  ciphertext,
  keyVersion: 1,
  nonce: "B".repeat(16),
});
const operation = {
  adoptionProof: null,
  genesisToken: "1".repeat(64),
  headToken: "3".repeat(64),
  operation: envelope(),
  priorToken: "2".repeat(64),
  sequence: 1,
  terminalHeadProof: envelope(),
};
const request = {
  expectedKeyVersion: 1,
  expectedRevision: 1,
  operations: [operation] as const,
  spaceId: `memory_${"A".repeat(32)}`,
};

describe("canonical memory sync wire contracts", () => {
  test("accepts one bounded encrypted operation and no plaintext fields", () => {
    expect(parseCanonicalMemoryPushRequest(request)).toEqual(request);
    const withAdoptionProof = {
      ...request,
      operations: [{ ...operation, adoptionProof: envelope("P".repeat(22)) }] as const,
    };
    expect(parseCanonicalMemoryPushRequest(withAdoptionProof)).toEqual(withAdoptionProof);
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [{
        ...operation,
        adoptionProof: envelope("Q".repeat(
          canonicalMemorySyncLimits.adoptionProofCiphertextCharacters + 1,
        )),
      }],
    })).toBeNull();
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [{ ...operation, adoptionProof: { ...envelope(), keyVersion: 2 } }],
    })).toBeNull();
    const missingAdoptionProof = {
      genesisToken: operation.genesisToken,
      headToken: operation.headToken,
      operation: operation.operation,
      priorToken: operation.priorToken,
      sequence: operation.sequence,
      terminalHeadProof: operation.terminalHeadProof,
    };
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [missingAdoptionProof],
    })).toBeNull();
    // Wire parsing deliberately does not attempt local cryptographic or page-
    // semantic validation. Any bounded, well-shaped ciphertext remains opaque.
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [{ ...operation, adoptionProof: envelope("Z".repeat(22)) }],
    })).not.toBeNull();
    expect(canonicalMemorySyncLimits.operationCiphertextCharacters).toBeLessThan(350_000);
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [{
        ...operation,
        operation: envelope("A".repeat(
          canonicalMemorySyncLimits.operationCiphertextCharacters + 1,
        )),
      }],
    })).toBeNull();
    expect(parseCanonicalMemoryPushRequest({ ...request, plaintext: "fact" })).toBeNull();
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      spaceId: "memory_space_001",
    })).toBeNull();
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [operation, { ...operation, sequence: 2 }],
    })).toBeNull();
  });

  test("keeps the hosted routing id separate from the encrypted portable descriptor", () => {
    const configuration = {
      bindingPolicy: "one_project_one_space" as const,
      encryptedDescriptor: envelope("D".repeat(22)),
      genesisHeadProof: envelope("E".repeat(22)),
      genesisToken: operation.genesisToken,
      identityContract: 2 as const,
      keyVersion: 1,
      revision: 1,
      spaceId: request.spaceId,
      wrappedSpaceKey: { ...envelope("F".repeat(22)), keyVersion: 7 },
    };
    expect(parseCanonicalMemorySpaceConfiguration(configuration)).toEqual(configuration);
    expect(parseCanonicalMemoryCreateResult({ ...configuration, replay: false }))
      .toEqual({ ...configuration, replay: false });
    expect(parseCanonicalMemorySpaceList([{
      bindingPolicy: configuration.bindingPolicy,
      identityContract: configuration.identityContract,
      keyVersion: configuration.keyVersion,
      revision: configuration.revision,
      spaceId: configuration.spaceId,
    }])).toHaveLength(1);
    expect(parseCanonicalMemorySpaceConfiguration({
      ...configuration,
      spaceId: "oompa:project:space-0123456789abcdef0123456789abcdef",
    })).toBeNull();
    expect(parseCanonicalMemorySpaceConfiguration({
      ...configuration,
      encryptedDescriptor: { ...configuration.encryptedDescriptor, keyVersion: 2 },
    })).toBeNull();
  });

  test("rejects negative zero, accessors, symbols, and hostile proxies without invoking them", () => {
    expect(parseCanonicalMemoryPushRequest({ ...request, expectedRevision: -0 })).toBeNull();
    expect(parseCanonicalMemoryPushRequest({
      ...request,
      operations: [{ ...operation, sequence: -0 }],
    })).toBeNull();

    let reads = 0;
    const accessor = { ...request } as Record<string, unknown>;
    Object.defineProperty(accessor, "spaceId", {
      enumerable: true,
      get() {
        reads += 1;
        return `memory_${"A".repeat(32)}`;
      },
    });
    expect(parseCanonicalMemoryPushRequest(accessor)).toBeNull();
    expect(reads).toBe(0);

    const symbolled = { ...request, [Symbol("hidden")]: true };
    expect(parseCanonicalMemoryPushRequest(symbolled)).toBeNull();
    expect(parseCanonicalMemoryPushRequest(new Proxy(request, {
      ownKeys() {
        throw new Error("trap");
      },
    }))).toBeNull();
  });

  test("parses an encrypted terminal head and a terminal-bounded pull page", () => {
    const head = {
      genesisToken: operation.genesisToken,
      headToken: operation.headToken,
      keyVersion: 1,
      revision: 2,
      sequence: 1,
      spaceId: request.spaceId,
      terminalHeadProof: envelope(),
    };
    expect(parseCanonicalMemoryHead(head)).toEqual(head);
    expect(parseCanonicalMemoryWriteResult({
      acceptedHeadToken: operation.headToken,
      acceptedSequence: operation.sequence,
      acceptedTerminalHeadProof: operation.terminalHeadProof,
      keyVersion: 1,
      replay: true,
      revision: 1,
      spaceId: request.spaceId,
    })).not.toBeNull();
    const page = {
      done: true,
      operations: [operation],
      spaceId: request.spaceId,
      terminalHeadToken: operation.headToken,
      terminalSequence: 1,
    };
    expect(parseCanonicalMemoryPullPage(page)).toEqual(page);
    expect(parseCanonicalMemoryPullPage({ ...page, done: false })).toBeNull();
    expect(parseCanonicalMemoryPullPage({ ...page, terminalSequence: -0 })).toBeNull();
    expect(parseCanonicalMemoryPullPage({
      ...page,
      terminalHeadToken: "4".repeat(64),
    })).toBeNull();
  });
});
