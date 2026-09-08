import { describe, expect, test } from "bun:test";

import {
  CanonicalMemoryTransportError,
  createCanonicalMemoryTransport,
  type CanonicalMemoryCreateRequest,
  type CanonicalMemoryPullRequest,
} from "./canonical-memory-transport";
import type {
  CloudAction,
  CloudArgs,
  CloudMutation,
  CloudQuery,
  CloudTransport,
} from "./client";
import {
  canonicalMemorySyncLimits,
  type CanonicalMemoryPushRequest,
} from "./memory-sync-contracts";

type Call = Readonly<{
  args: CloudArgs;
  kind: "action" | "mutation" | "query";
  name: string;
}>;

function scriptedTransport(input: Readonly<{
  mutation?: (name: CloudMutation, args: CloudArgs) => unknown;
  query?: (name: CloudQuery, args: CloudArgs) => unknown;
}> = {}) {
  const calls: Call[] = [];
  const transport: CloudTransport = {
    async action(name: CloudAction, args: CloudArgs) {
      calls.push({ args, kind: "action", name });
      throw new Error("unexpected action");
    },
    async mutation(name, args) {
      calls.push({ args, kind: "mutation", name });
      if (input.mutation === undefined) throw new Error("unexpected mutation");
      return await input.mutation(name, args);
    },
    async query(name, args) {
      calls.push({ args, kind: "query", name });
      if (input.query === undefined) throw new Error("unexpected query");
      return await input.query(name, args);
    },
  };
  return { calls, transport };
}

const spaceId = `memory_${"A".repeat(32)}`;
const foreignSpaceId = `memory_${"B".repeat(32)}`;
const genesisToken = "0".repeat(64);
const headToken1 = "1".repeat(64);
const headToken2 = "2".repeat(64);
const keyVersion = 3;
const revision = 1;

function envelope(version = keyVersion, fill = "A") {
  return {
    algorithm: "A256GCM" as const,
    ciphertext: fill.repeat(22),
    keyVersion: version,
    nonce: "B".repeat(16),
  };
}

const operation = {
  adoptionProof: null,
  genesisToken,
  headToken: headToken1,
  operation: envelope(keyVersion, "C"),
  priorToken: genesisToken,
  sequence: 1,
  terminalHeadProof: envelope(keyVersion, "D"),
} as const;

const createRequest: CanonicalMemoryCreateRequest = {
  bindingPolicy: "one_project_one_space",
  encryptedDescriptor: envelope(keyVersion, "E"),
  genesisHeadProof: envelope(keyVersion, "F"),
  genesisToken,
  identityContract: 2,
  keyVersion,
  spaceId,
  wrappedSpaceKey: envelope(7, "G"),
};

const configuration = {
  ...createRequest,
  revision,
};

const head = {
  genesisToken,
  headToken: headToken1,
  keyVersion,
  revision,
  sequence: 1,
  spaceId,
  terminalHeadProof: operation.terminalHeadProof,
};

const pushRequest: CanonicalMemoryPushRequest = {
  expectedKeyVersion: keyVersion,
  expectedRevision: revision,
  operations: [operation],
  spaceId,
};

const writeResult = {
  acceptedHeadToken: operation.headToken,
  acceptedSequence: operation.sequence,
  acceptedTerminalHeadProof: operation.terminalHeadProof,
  keyVersion,
  replay: false,
  revision,
  spaceId,
};

const pullRequest: CanonicalMemoryPullRequest = {
  afterHeadToken: genesisToken,
  afterSequence: 0,
  expectedGenesisToken: genesisToken,
  expectedKeyVersion: keyVersion,
  spaceId,
  terminalHeadToken: headToken1,
  terminalSequence: 1,
};

const pullPage = {
  done: true,
  operations: [operation],
  spaceId,
  terminalHeadToken: headToken1,
  terminalSequence: 1,
};

async function failure(
  promise: Promise<unknown>,
  category: CanonicalMemoryTransportError["category"],
  effect: CanonicalMemoryTransportError["effect"],
): Promise<CanonicalMemoryTransportError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CanonicalMemoryTransportError);
    const parsed = error as CanonicalMemoryTransportError;
    expect(parsed.category).toBe(category);
    expect(parsed.effect).toBe(effect);
    expect(parsed.code.toLowerCase()).toBe(`canonical_memory_${category}`);
    return parsed;
  }
  throw new Error("Expected canonical memory transport failure.");
}

describe("canonical memory typed cloud transport", () => {
  test("uses the six closed functions with complete discovery and one-operation pull bounds", async () => {
    const world = scriptedTransport({
      mutation(name) {
        if (name === "memorySync:create") return { ...configuration, replay: false };
        if (name === "memorySync:push") return writeResult;
        throw new Error("unexpected mutation");
      },
      query(name) {
        if (name === "memorySync:list") return [{
          bindingPolicy: configuration.bindingPolicy,
          identityContract: configuration.identityContract,
          keyVersion,
          revision,
          spaceId,
        }];
        if (name === "memorySync:get") return configuration;
        if (name === "memorySync:head") return head;
        if (name === "memorySync:pull") return pullPage;
        throw new Error("unexpected query");
      },
    });
    const adapter = createCanonicalMemoryTransport(world.transport);

    await expect(adapter.create(createRequest)).resolves.toMatchObject({ replay: false, spaceId });
    await expect(adapter.list()).resolves.toHaveLength(1);
    await expect(adapter.get({ spaceId })).resolves.toEqual(configuration);
    await expect(adapter.head({ spaceId })).resolves.toEqual(head);
    await expect(adapter.push(pushRequest)).resolves.toEqual(writeResult);
    await expect(adapter.pull(pullRequest)).resolves.toEqual(pullPage);

    expect(world.calls.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "mutation:memorySync:create",
      "query:memorySync:list",
      "query:memorySync:get",
      "query:memorySync:head",
      "mutation:memorySync:push",
      "query:memorySync:pull",
    ]);
    expect(world.calls[1]?.args).toEqual({ limit: canonicalMemorySyncLimits.listSpaces });
    expect(world.calls[5]?.args).toEqual({
      afterHeadToken: pullRequest.afterHeadToken,
      afterSequence: pullRequest.afterSequence,
      limit: 1,
      spaceId,
      terminalHeadToken: pullRequest.terminalHeadToken,
      terminalSequence: pullRequest.terminalSequence,
    });
    expect(world.calls[0]?.args).toEqual(createRequest);
    expect(world.calls[0]?.args).not.toBe(createRequest);
  });

  test("accepts an exact advanced historical replay and rejects a current-head acknowledgement", async () => {
    const exact = scriptedTransport({
      mutation: () => ({ ...writeResult, replay: true }),
    });
    await expect(createCanonicalMemoryTransport(exact.transport).push(pushRequest))
      .resolves.toEqual({ ...writeResult, replay: true });
    expect(exact.calls).toHaveLength(1);

    for (const response of [
      {
        ...writeResult,
        acceptedHeadToken: headToken2,
        acceptedSequence: 2,
        acceptedTerminalHeadProof: envelope(keyVersion, "H"),
        replay: true,
      },
      { ...writeResult, keyVersion: keyVersion + 1, replay: true },
      { ...writeResult, revision: revision + 1, replay: true },
      { ...writeResult, spaceId: foreignSpaceId, replay: true },
      {
        ...writeResult,
        acceptedTerminalHeadProof: envelope(keyVersion, "H"),
        replay: true,
      },
    ]) {
      const world = scriptedTransport({ mutation: () => response });
      await failure(
        createCanonicalMemoryTransport(world.transport).push(pushRequest),
        "corrupt",
        "indeterminate",
      );
      expect(world.calls).toHaveLength(1);
    }
  });

  test("correlates create replay with every exact submitted byte and initial revision", async () => {
    await expect(createCanonicalMemoryTransport(scriptedTransport({
      mutation: () => ({ ...configuration, replay: true }),
    }).transport).create(createRequest)).resolves.toMatchObject({ replay: true, revision: 1 });

    for (const response of [
      { ...configuration, encryptedDescriptor: envelope(keyVersion, "Z"), replay: true },
      { ...configuration, genesisHeadProof: envelope(keyVersion, "Z"), replay: true },
      { ...configuration, wrappedSpaceKey: envelope(7, "Z"), replay: true },
      { ...configuration, revision: 2, replay: true },
      { ...configuration, spaceId: foreignSpaceId, replay: true },
    ]) {
      const world = scriptedTransport({ mutation: () => response });
      await failure(
        createCanonicalMemoryTransport(world.transport).create(createRequest),
        "corrupt",
        "indeterminate",
      );
      expect(world.calls).toHaveLength(1);
    }
  });

  test("rejects hostile or noncanonical outbound values before transport", async () => {
    let reads = 0;
    const accessor = { ...createRequest } as Record<string, unknown>;
    Object.defineProperty(accessor, "spaceId", {
      enumerable: true,
      get() {
        reads += 1;
        return spaceId;
      },
    });
    const world = scriptedTransport();
    const adapter = createCanonicalMemoryTransport(world.transport);
    await failure(
      adapter.create(accessor as CanonicalMemoryCreateRequest),
      "invalid",
      "none",
    );
    expect(reads).toBe(0);
    await failure(adapter.create({
      ...createRequest,
      keyVersion: -0,
    }), "invalid", "none");
    await failure(adapter.create({
      ...createRequest,
      encryptedDescriptor: {
        ...createRequest.encryptedDescriptor,
        ciphertext: "A".repeat(canonicalMemorySyncLimits.descriptorCiphertextCharacters + 1),
      },
    }), "invalid", "none");
    await failure(adapter.push({
      ...pushRequest,
      expectedRevision: -0,
    }), "invalid", "none");
    await failure(adapter.pull({
      ...pullRequest,
      afterSequence: -0,
    }), "invalid", "none");
    await failure(adapter.get(new Proxy({ spaceId }, {
      ownKeys() {
        throw new Error("must remain inert");
      },
    })), "invalid", "none");
    expect(world.calls).toEqual([]);
  });

  test("never retries create or push after an indeterminate transport failure", async () => {
    const secret = operation.operation.ciphertext;
    for (const kind of ["create", "push"] as const) {
      for (const diagnostic of [
        `network failed after dispatch ${secret} ${headToken1}`,
        `socket closed after dispatch; MEMORY_SYNC_CONFLICT ${secret}`,
        `proxy failed; MEMORY_SYNC_INVALID ${headToken1}`,
      ]) {
        const world = scriptedTransport({
          mutation() {
            throw new Error(diagnostic);
          },
        });
        const adapter = createCanonicalMemoryTransport(world.transport);
        const error = await failure(
          kind === "create" ? adapter.create(createRequest) : adapter.push(pushRequest),
          "transport",
          "indeterminate",
        );
        expect(world.calls).toHaveLength(1);
        expect(error.message).not.toContain(secret);
        expect(error.message).not.toContain(headToken1);
      }
    }
  });

  test("maps only closed server failures and never exposes the foreign diagnostic", async () => {
    const cases = [
      ["MEMORY_SYNC_INVALID", "invalid"],
      ["MEMORY_SYNC_CONFLICT", "conflict"],
      ["MEMORY_SPACE_MISSING", "missing"],
      ["MEMORY_SYNC_STORAGE_CORRUPT", "corrupt"],
    ] as const;
    for (const [serverCode, category] of cases) {
      const secret = `${operation.operation.ciphertext}-${headToken1}`;
      const world = scriptedTransport({
        query() {
          throw new Error(`[CONVEX] ${serverCode} ${secret}`);
        },
      });
      const error = await failure(
        createCanonicalMemoryTransport(world.transport).head({ spaceId }),
        category,
        "none",
      );
      expect(error.message).not.toContain(serverCode);
      expect(error.message).not.toContain(secret);
      expect(world.calls).toHaveLength(1);
    }
  });

  test("rejects malformed, oversized, hostile, and foreign-route query responses", async () => {
    let reads = 0;
    const accessorHead = { ...head } as Record<string, unknown>;
    Object.defineProperty(accessorHead, "spaceId", {
      enumerable: true,
      get() {
        reads += 1;
        return spaceId;
      },
    });
    const responses = [
      { ...head, spaceId: foreignSpaceId },
      { ...head, sequence: -0 },
      accessorHead,
      new Proxy(head, {
        ownKeys() {
          throw new Error("must remain inert");
        },
      }),
    ];
    for (const response of responses) {
      const world = scriptedTransport({ query: () => response });
      await failure(
        createCanonicalMemoryTransport(world.transport).head({ spaceId }),
        "corrupt",
        "none",
      );
      expect(world.calls).toHaveLength(1);
    }
    expect(reads).toBe(0);

    const oversizedList = Array.from(
      { length: canonicalMemorySyncLimits.listSpaces + 1 },
      (_, index) => ({
        bindingPolicy: "one_project_one_space",
        identityContract: 2,
        keyVersion,
        revision,
        spaceId: `memory_${index.toString(16).padStart(32, "0")}`,
      }),
    );
    const listWorld = scriptedTransport({ query: () => oversizedList });
    await failure(
      createCanonicalMemoryTransport(listWorld.transport).list(),
      "corrupt",
      "none",
    );
    expect(listWorld.calls[0]?.args).toEqual({ limit: 100 });
  });

  test("pins pull to the observed terminal and exact one-operation continuity", async () => {
    const twoStepRequest: CanonicalMemoryPullRequest = {
      ...pullRequest,
      terminalHeadToken: headToken2,
      terminalSequence: 2,
    };
    const firstPage = {
      ...pullPage,
      done: false,
      terminalHeadToken: headToken2,
      terminalSequence: 2,
    };
    await expect(createCanonicalMemoryTransport(scriptedTransport({
      query: () => firstPage,
    }).transport).pull(twoStepRequest)).resolves.toEqual(firstPage);

    for (const response of [
      { ...firstPage, spaceId: foreignSpaceId },
      { ...firstPage, terminalHeadToken: headToken1 },
      { ...firstPage, terminalSequence: 3 },
      { ...firstPage, done: true },
      { ...firstPage, operations: [] },
      { ...firstPage, operations: [{ ...operation, sequence: 2 }] },
      { ...firstPage, operations: [{ ...operation, priorToken: headToken2 }] },
      { ...firstPage, operations: [{ ...operation, genesisToken: "9".repeat(64) }] },
      {
        ...firstPage,
        operations: [{
          ...operation,
          operation: envelope(keyVersion + 1, "C"),
          terminalHeadProof: envelope(keyVersion + 1, "D"),
        }],
      },
      {
        ...firstPage,
        operations: [{
          ...operation,
          operation: {
            ...operation.operation,
            ciphertext: "X".repeat(
              canonicalMemorySyncLimits.operationCiphertextCharacters + 1,
            ),
          },
        }],
      },
    ]) {
      const world = scriptedTransport({ query: () => response });
      await failure(
        createCanonicalMemoryTransport(world.transport).pull(twoStepRequest),
        "corrupt",
        "none",
      );
      expect(world.calls).toHaveLength(1);
      expect(world.calls[0]?.args.limit).toBe(1);
    }

    const settledRequest: CanonicalMemoryPullRequest = {
      afterHeadToken: headToken1,
      afterSequence: 1,
      expectedGenesisToken: genesisToken,
      expectedKeyVersion: keyVersion,
      spaceId,
      terminalHeadToken: headToken1,
      terminalSequence: 1,
    };
    const settled = {
      done: true,
      operations: [],
      spaceId,
      terminalHeadToken: headToken1,
      terminalSequence: 1,
    };
    await expect(createCanonicalMemoryTransport(scriptedTransport({
      query: () => settled,
    }).transport).pull(settledRequest)).resolves.toEqual(settled);
  });
});
