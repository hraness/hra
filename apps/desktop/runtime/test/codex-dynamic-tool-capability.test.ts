import { describe, expect, test } from "bun:test";

import type { AccountSummary } from "../../contracts/runtime";
import {
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  PINNED_CODEX_DYNAMIC_TOOL_VERSION,
  isPinnedCodexDynamicToolProbeWitness,
} from "../src/codex/dynamic-tool";
import {
  PinnedCodexDynamicToolCapabilityResolver,
  createPinnedCodexDynamicToolCapabilityResolver,
  type PinnedCodexDynamicToolLifecycleProbe,
  type PinnedCodexDynamicToolLifecycleProbeInput,
} from "../src/codex/dynamic-tool-capability";
import type { RuntimePaths } from "../src/runtime-paths";

const nowMs = Date.parse("2026-08-06T12:00:00.000Z");
const binarySha256 = "a".repeat(64);
const accountA = "acct_capability_a" as AccountSummary["id"];
const accountB = "acct_capability_b" as AccountSummary["id"];

function paths(account: "a" | "b" = "a"): RuntimePaths {
  return {
    codexBinary: "/runtime/codex",
    codexHome: `/profiles/${account}/codex-home`,
    gitBinary: "/runtime/git/bin/git",
    gitRoot: "/runtime/git",
  };
}

function receipt(
  input: PinnedCodexDynamicToolLifecycleProbeInput,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "oprte.codex.dynamic-tool.direct-lifecycle-receipt",
    source: "signed-in-real-app-server",
    runId: "019fbd82-efa4-7542-af14-492556dcbcf7",
    startedAt: new Date(nowMs).toISOString(),
    finishedAt: new Date(nowMs).toISOString(),
    accountProfileId: input.accountProfileId,
    codexBinary: input.paths.codexBinary,
    codexHome: input.paths.codexHome,
    codexVersion: input.codexVersion,
    binarySha256: input.binarySha256,
    processGeneration: input.processGeneration,
    registration: {
      initializeExperimentalApi: true,
      carrierMethod: "thread/start",
      paramsField: "dynamicTools",
      namespace: "oprte",
      tool: "rlm_run",
      specSha256: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
    },
    observations: {
      registrationAccepted: true,
      exactThreadAndTurnIdentity: true,
      successfulCompletion: true,
      failedCompletion: true,
      cancellationResolution: true,
      duplicateCallObserved: true,
      duplicateCallRejected: true,
      restartGenerationScoped: true,
    },
    ...overrides,
  };
}

class RecordingProbe implements PinnedCodexDynamicToolLifecycleProbe {
  readonly calls: PinnedCodexDynamicToolLifecycleProbeInput[] = [];
  readonly #produce: (
    input: PinnedCodexDynamicToolLifecycleProbeInput,
  ) => unknown;

  constructor(
    produce: (
      input: PinnedCodexDynamicToolLifecycleProbeInput,
    ) => unknown = receipt,
  ) {
    this.#produce = produce;
  }

  async run(input: PinnedCodexDynamicToolLifecycleProbeInput): Promise<unknown> {
    this.calls.push(input);
    return await this.#produce(input);
  }
}

function resolver(
  probe: PinnedCodexDynamicToolLifecycleProbe,
  overrides: Readonly<{
    hashBinary?: (path: string) => Promise<unknown>;
    now?: () => number;
    readVersion?: (paths: RuntimePaths) => Promise<unknown>;
  }> = {},
): PinnedCodexDynamicToolCapabilityResolver {
  return new PinnedCodexDynamicToolCapabilityResolver({
    probe,
    hashBinary: overrides.hashBinary ?? (() => Promise.resolve(binarySha256)),
    now: overrides.now ?? (() => nowMs),
    readVersion: overrides.readVersion ??
      (() => Promise.resolve(PINNED_CODEX_DYNAMIC_TOOL_VERSION)),
  });
}

describe("pinned Codex dynamic-tool capability resolver", () => {
  test("uses the canonical HRA Codex client identity for direct probes", async () => {
    const source = await Bun.file(
      new URL("../src/codex/dynamic-tool-capability.ts", import.meta.url),
    ).text();

    expect(source).toMatch(
      /clientInfo:\s*\{\s*name:\s*"hra",\s*title:\s*"HRA",\s*version:\s*hraReleaseIdentity\.version,/u,
    );
    expect(source).not.toMatch(/clientInfo:\s*\{\s*name:\s*"oprte"/u);
    expect(source).toContain('"hra-dynamic-tool-probe-"');
    expect(source).toContain('clientUserMessageId: `hra-dynamic-tool-probe-');
    expect(source).not.toContain('"oprte-dynamic-tool-probe-"');
    expect(source).not.toContain('clientUserMessageId: `oprte-dynamic-tool-probe-');
    expect(source).toContain('kind: z.literal("oprte.codex.dynamic-tool.direct-lifecycle-receipt")');
    expect(source).toContain('kind: "oprte.codex.dynamic-tool.real-probe-witness"');
    expect(source).toContain("oprte/rlm_run");
  });

  test("brands only exact per-account, per-home, per-generation live evidence", async () => {
    const probe = new RecordingProbe();
    const hashed: string[] = [];
    const subject = resolver(probe, {
      hashBinary: (path) => {
        hashed.push(path);
        return Promise.resolve(binarySha256);
      },
    });

    const capability = await subject.resolve({
      accountProfileId: accountA,
      generation: 17,
      paths: paths("a"),
    });

    expect(capability).not.toBeNull();
    if (capability === null) throw new Error("fixture capability was not accepted");
    expect(capability.caller).toEqual({
      accountProfileId: accountA,
      accountGeneration: 17,
    });
    expect(capability.runtimeBinarySha256).toBe(binarySha256);
    expect(isPinnedCodexDynamicToolProbeWitness(capability.witness, {
      binarySha256,
      processGeneration: 17,
      nowMs,
    })).toBeTrue();
    expect(isPinnedCodexDynamicToolProbeWitness(capability.witness, {
      binarySha256,
      processGeneration: 18,
      nowMs,
    })).toBeFalse();
    expect(Object.isFrozen(capability)).toBeTrue();
    expect(Object.isFrozen(capability.caller)).toBeTrue();
    expect(Object.isFrozen(probe.calls[0])).toBeTrue();
    expect(Object.isFrozen(probe.calls[0]?.paths)).toBeTrue();
    expect(probe.calls[0]).toMatchObject({
      accountProfileId: accountA,
      binarySha256,
      codexVersion: "0.144.6",
      processGeneration: 17,
      paths: { codexHome: "/profiles/a/codex-home" },
    });
    expect(hashed).toEqual(["/runtime/codex", "/runtime/codex"]);
  });

  test("memoizes one immutable decision and advances only with the durable generation", async () => {
    const probe = new RecordingProbe();
    const subject = resolver(probe);
    const first = await subject.resolve({
      accountProfileId: accountA,
      generation: 5,
      paths: paths("a"),
    });
    const repeated = await subject.resolve({
      accountProfileId: accountA,
      generation: 5,
      paths: paths("a"),
    });
    expect(repeated).toBe(first);
    expect(probe.calls).toHaveLength(1);

    expect(await subject.resolve({
      accountProfileId: accountA,
      generation: 5,
      paths: paths("b"),
    })).toBeNull();
    expect(await subject.resolve({
      accountProfileId: accountA,
      generation: 4,
      paths: paths("a"),
    })).toBeNull();
    expect(probe.calls).toHaveLength(1);

    const next = await subject.resolve({
      accountProfileId: accountA,
      generation: 6,
      paths: paths("a"),
    });
    expect(next).not.toBeNull();
    expect(next).not.toBe(first);
    expect(probe.calls.map((call) => call.processGeneration)).toEqual([5, 6]);

    const sibling = await subject.resolve({
      accountProfileId: accountB,
      generation: 1,
      paths: paths("b"),
    });
    expect(sibling?.caller.accountProfileId).toBe(accountB);
    expect(probe.calls).toHaveLength(3);
  });

  test("caches a failed decision instead of repeatedly consuming a signed-in model", async () => {
    const probe = new RecordingProbe(() => Promise.reject(new Error("private")));
    const subject = resolver(probe);
    const input = {
      accountProfileId: accountA,
      generation: 9,
      paths: paths("a"),
    } as const;

    expect(await subject.resolve(input)).toBeNull();
    expect(await subject.resolve(input)).toBeNull();
    expect(probe.calls).toHaveLength(1);
  });

  test("fails closed for every drifted lifecycle binding", async () => {
    const cases: ReadonlyArray<Readonly<{
      label: string;
      change: (
        input: PinnedCodexDynamicToolLifecycleProbeInput,
      ) => Record<string, unknown>;
    }>> = [
      {
        label: "account",
        change: (input) => receipt(input, { accountProfileId: accountB }),
      },
      {
        label: "credential home",
        change: (input) => receipt(input, { codexHome: "/profiles/b/codex-home" }),
      },
      {
        label: "binary path",
        change: (input) => receipt(input, { codexBinary: "/runtime/other-codex" }),
      },
      {
        label: "binary digest",
        change: (input) => receipt(input, { binarySha256: "b".repeat(64) }),
      },
      {
        label: "version",
        change: (input) => receipt(input, { codexVersion: "0.145.0" }),
      },
      {
        label: "generation",
        change: (input) => receipt(input, { processGeneration: 18 }),
      },
      {
        label: "carrier field",
        change: (input) => receipt(input, {
          registration: {
            ...receipt(input).registration as Record<string, unknown>,
            paramsField: "tools",
          },
        }),
      },
      {
        label: "tool name",
        change: (input) => receipt(input, {
          registration: {
            ...receipt(input).registration as Record<string, unknown>,
            tool: "rlm.run",
          },
        }),
      },
      {
        label: "incomplete lifecycle",
        change: (input) => receipt(input, {
          observations: {
            ...receipt(input).observations as Record<string, unknown>,
            duplicateCallRejected: false,
          },
        }),
      },
      {
        label: "generic persisted evidence",
        change: (input) => ({
          ...receipt(input),
          persistedEvidencePath: "/tmp/evidence.json",
        }),
      },
    ];

    for (const { label, change } of cases) {
      const probe = new RecordingProbe(change);
      expect(await resolver(probe).resolve({
        accountProfileId: accountA,
        generation: 17,
        paths: paths("a"),
      }), label).toBeNull();
    }
  });

  test("fails closed on hash races, wrong binary versions, stale clocks, and hostile seams", async () => {
    const validProbe = new RecordingProbe();
    let hashRead = 0;
    expect(await resolver(validProbe, {
      hashBinary: () => Promise.resolve(hashRead++ === 0
        ? binarySha256
        : "b".repeat(64)),
    }).resolve({
      accountProfileId: accountA,
      generation: 1,
      paths: paths(),
    })).toBeNull();

    expect(await resolver(new RecordingProbe(), {
      readVersion: () => Promise.resolve("0.145.0"),
    }).resolve({
      accountProfileId: accountA,
      generation: 1,
      paths: paths(),
    })).toBeNull();

    expect(await resolver(new RecordingProbe(), {
      now: () => Number.NaN,
    }).resolve({
      accountProfileId: accountA,
      generation: 1,
      paths: paths(),
    })).toBeNull();

    const hostile = new Proxy({}, {
      get() { throw new Error("hostile getter"); },
      getPrototypeOf() { throw new Error("hostile prototype"); },
    });
    expect(await resolver(new RecordingProbe(() => hostile)).resolve({
      accountProfileId: accountA,
      generation: 1,
      paths: paths(),
    })).toBeNull();
  });

  test("factory is lazy and remains structurally compatible with the account router", async () => {
    const probe = new RecordingProbe();
    const resolve = createPinnedCodexDynamicToolCapabilityResolver({
      probe,
      hashBinary: () => Promise.resolve(binarySha256),
      now: () => nowMs,
      readVersion: () => Promise.resolve(PINNED_CODEX_DYNAMIC_TOOL_VERSION),
    });
    expect(probe.calls).toHaveLength(0);
    expect((await resolve({
      accountProfileId: accountA,
      generation: 3,
      paths: paths(),
    }))?.caller).toEqual({
      accountProfileId: accountA,
      accountGeneration: 3,
    });
    expect(probe.calls).toHaveLength(1);
  });
});
