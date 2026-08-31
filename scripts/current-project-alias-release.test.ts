import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  assertCurrentAliasReleaseBunVersion,
  assertCurrentAliasReleaseScanCapacity,
  assertCurrentAliasReleaseStateCapacity,
  buildVercelEnvironment,
  currentAliasReleaseApiArguments,
  currentAliasReleaseIntentSchema,
  currentAliasReleasePlanDigest,
  currentAliasReleaseMutationKey,
  currentAliasReleaseReceiptSchema,
  currentAliasReleaseStateEntryMaximum,
  currentAliasReleaseStatePaths,
  CurrentAliasReleaseError,
  executeCurrentProjectAliasReleaseWithExplicitCapability,
  observeCurrentAliasAuthority,
  parseArguments,
  parseCurrentDeploymentReadback,
  parseCurrentProjectAliasReleasePlan,
  requiredAliasConfirmation,
  type CurrentAliasReadback,
  type CurrentDeploymentReadback,
  type CurrentProjectAliasEndpoint,
  type CurrentProjectAliasReleasePlan,
  type CurrentProjectAliasReleaseProvider,
  type CurrentProjectReadback,
} from "./current-project-alias-release";
import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
} from "./convex-target";
import {
  HRA_RELEASE_VERSION,
  HRA_REPOSITORY,
  HRA_REPOSITORY_ID,
  HRA_VERCEL_PROJECT_ID,
  HRA_VERCEL_TEAM_ID,
  readProtectedJson,
} from "./release-evidence";

const source: CurrentProjectAliasEndpoint = {
  deploymentId: "dpl_SourceCurrent1234567890123",
  deploymentUrl: "hra-source-current-hraness.vercel.app",
  sourceCommit: "1".repeat(40),
};

const target: CurrentProjectAliasEndpoint = {
  deploymentId: "dpl_TargetCurrent1234567890123",
  deploymentUrl: "hra-target-current-hraness.vercel.app",
  sourceCommit: "2".repeat(40),
};

const convex: ConvexTarget = {
  deploymentId: 5_089_017,
  deploymentName: "qualified-hummingbird-537",
  deploymentUrl: "https://qualified-hummingbird-537.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};

const plan: CurrentProjectAliasReleasePlan = {
  alias: "hra.sh",
  convex,
  idempotencyKey: "607f32a6-98a9-4597-b54e-32e72fe32b56",
  kind: "current-project-canonical-alias",
  repository: { id: HRA_REPOSITORY_ID, name: HRA_REPOSITORY },
  schemaVersion: 1,
  vercel: {
    projectId: HRA_VERCEL_PROJECT_ID,
    source,
    target,
    teamId: HRA_VERCEL_TEAM_ID,
  },
  version: HRA_RELEASE_VERSION,
};

const cliSourcePlan: CurrentProjectAliasReleasePlan = {
  ...plan,
  vercel: {
    ...plan.vercel,
    sourceProvenance: {
      actor: "cursor-cli",
      gitCommitRef: "HEAD",
      gitRootDirectory: "",
      kind: "vercel-cli-public-marker",
    },
  },
};

const withStateDirectory = async <Value>(
  operation: (directory: string) => Promise<Value>,
): Promise<Value> => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "hra-alias-release-state-")),
  );
  await chmod(directory, 0o700);
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const deploymentFor = (
  endpoint: CurrentProjectAliasEndpoint,
): CurrentDeploymentReadback => ({
  gitSource: {
    ref: "main",
    repoId: HRA_REPOSITORY_ID,
    sha: endpoint.sourceCommit,
    type: "github",
  },
  id: endpoint.deploymentId,
  projectId: HRA_VERCEL_PROJECT_ID,
  readyState: "READY",
  source: "git",
  target: "production",
  url: endpoint.deploymentUrl,
});

const cliDeploymentFor = (
  endpoint: CurrentProjectAliasEndpoint,
): CurrentDeploymentReadback => ({
  gitSource: null,
  id: endpoint.deploymentId,
  meta: {
    actor: "cursor-cli",
    gitCommitRef: "HEAD",
    gitCommitSha: endpoint.sourceCommit,
    gitRootDirectory: "",
  },
  projectId: HRA_VERCEL_PROJECT_ID,
  readyState: "READY",
  source: "cli",
  target: "production",
  url: endpoint.deploymentUrl,
});

const aliasFor = (endpoint: CurrentProjectAliasEndpoint): CurrentAliasReadback => ({
  alias: "hra.sh",
  deployment: { id: endpoint.deploymentId, url: endpoint.deploymentUrl },
  deploymentId: endpoint.deploymentId,
  projectId: HRA_VERCEL_PROJECT_ID,
});

const projectReadback: CurrentProjectReadback = {
  accountId: HRA_VERCEL_TEAM_ID,
  autoAssignCustomDomains: false,
  id: HRA_VERCEL_PROJECT_ID,
};

const markerFor = (endpoint: CurrentProjectAliasEndpoint): unknown => ({
  generation: 1,
  product: "HRA",
  repository: { id: HRA_REPOSITORY_ID, path: HRA_REPOSITORY },
  schemaVersion: 2,
  source: { commit: endpoint.sourceCommit },
  version: HRA_RELEASE_VERSION,
});

type AliasState = "source" | "target" | "unknown";
type TargetSetBehavior = "commit" | "commit-and-throw" | "noop" | "throw";

class FakeProvider implements CurrentProjectAliasReleaseProvider {
  activePlan: CurrentProjectAliasReleasePlan = plan;
  aliasState: AliasState = "source";
  afterReadMarker?: () => Promise<void> | void;
  beforeSetAlias?: (endpoint: CurrentProjectAliasEndpoint) => Promise<void> | void;
  breakTargetDeployment = false;
  breakTargetMarker = false;
  failSourceSet = false;
  failVerifyVercelAt = 0;
  mutationOldDeploymentIdOverride: string | undefined;
  readonly operations: string[] = [];
  sourceDeploymentOverride: CurrentDeploymentReadback | undefined;
  sourceVisibilityLagReads = 0;
  sourceSetCommitAndThrow = false;
  targetDeploymentOverride: CurrentDeploymentReadback | undefined;
  #staleAliasState: AliasState | undefined;
  #staleReadsRemaining = 0;
  targetVisibilityLagReads = 0;
  targetSetBehavior: TargetSetBehavior = "commit";
  #verifyVercelReads = 0;

  async verifyVercelVersion(): Promise<void> {
    this.#verifyVercelReads += 1;
    this.operations.push("verify-vercel");
    if (this.#verifyVercelReads === this.failVerifyVercelAt) {
      throw new CurrentAliasReleaseError("provider_command_failed");
    }
  }

  async verifyConvexTarget(targetValue: ConvexTarget): Promise<void> {
    this.operations.push(`verify-convex:${String(targetValue.deploymentId)}`);
    expect(targetValue).toEqual(convex);
  }

  async readProject(): Promise<CurrentProjectReadback> {
    this.operations.push("read-project");
    return projectReadback;
  }

  async readDeployment(deploymentId: string): Promise<CurrentDeploymentReadback> {
    this.operations.push(`read-deployment:${deploymentId}`);
    if (deploymentId === source.deploymentId) {
      if (this.sourceDeploymentOverride !== undefined) {
        return this.sourceDeploymentOverride;
      }
      return this.activePlan.vercel.sourceProvenance === undefined
        ? deploymentFor(source)
        : cliDeploymentFor(source);
    }
    const readback = this.targetDeploymentOverride ?? deploymentFor(target);
    return this.breakTargetDeployment
      ? { ...readback, url: "hra-wrong-current-hraness.vercel.app" }
      : readback;
  }

  async readAlias(): Promise<CurrentAliasReadback> {
    const observedState = this.#staleReadsRemaining > 0
      ? this.#staleAliasState ?? this.aliasState
      : this.aliasState;
    if (this.#staleReadsRemaining > 0) this.#staleReadsRemaining -= 1;
    this.operations.push(`read-alias:${observedState}`);
    if (observedState === "source") return aliasFor(source);
    if (observedState === "target") return aliasFor(target);
    return aliasFor({
      deploymentId: "dpl_UnknownCurrent12345678901",
      deploymentUrl: "hra-unknown-current-hraness.vercel.app",
      sourceCommit: "3".repeat(40),
    });
  }

  async readMarker(): Promise<unknown> {
    this.operations.push(`read-marker:${this.aliasState}`);
    const marker = this.aliasState === "target"
      ? this.breakTargetMarker ? markerFor(source) : markerFor(target)
      : markerFor(source);
    await this.afterReadMarker?.();
    return marker;
  }

  async setAlias(
    endpoint: CurrentProjectAliasEndpoint,
    idempotencyKey: string,
  ): Promise<Readonly<{
    alias: "hra.sh";
    created: number;
    oldDeploymentId: string;
    uid: string;
  }>> {
    const deploymentUrl = endpoint.deploymentUrl;
    const oldDeploymentId = this.aliasState === "source"
      ? source.deploymentId
      : this.aliasState === "target"
        ? target.deploymentId
        : "dpl_UnknownCurrent12345678901";
    const response = {
      alias: "hra.sh" as const,
      created: 1_787_961_600_000,
      oldDeploymentId: this.mutationOldDeploymentIdOverride ?? oldDeploymentId,
      uid: "alias_CurrentHra1234567890",
    };
    expect(idempotencyKey).toBe(currentAliasReleaseMutationKey(
      this.activePlan,
      deploymentUrl === source.deploymentUrl ? "restore-source" : "assign-target",
    ));
    await this.beforeSetAlias?.(endpoint);
    this.operations.push(`set-alias:${deploymentUrl}`);
    if (deploymentUrl === source.deploymentUrl) {
      if (this.failSourceSet) throw new Error("source restoration failed");
      this.#staleAliasState = this.aliasState;
      this.#staleReadsRemaining = this.sourceVisibilityLagReads;
      this.aliasState = "source";
      if (this.sourceSetCommitAndThrow) throw new Error("ambiguous source result");
      return response;
    }
    expect(deploymentUrl).toBe(target.deploymentUrl);
    if (this.targetSetBehavior === "commit" || this.targetSetBehavior === "commit-and-throw") {
      this.#staleAliasState = this.aliasState;
      this.#staleReadsRemaining = this.targetVisibilityLagReads;
      this.aliasState = "target";
    }
    if (this.targetSetBehavior === "commit-and-throw" || this.targetSetBehavior === "throw") {
      throw new Error("ambiguous provider result");
    }
    return response;
  }
}

const immediateClock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

const runExecuteCli = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  stateDirectory: string,
  options: Readonly<{
    afterIntentPublication?: () => void;
    receiptWriter?: () => void;
    timeoutMs?: number;
  }> = {},
): Promise<Readonly<{ exitCode: number; stderr: string[]; stdout: string[] }>> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
    {
      provider,
      ...(options.afterIntentPublication === undefined
        ? {}
        : { afterIntentPublication: options.afterIntentPublication }),
      ...(options.receiptWriter === undefined
        ? {}
        : { receiptWriter: options.receiptWriter }),
      stateDirectory,
    },
    {
      arguments: [
        "--execute",
        "--vercel-cli",
        "/safe/bin/vercel",
        "--confirm-exact",
        requiredAliasConfirmation(inputPlan),
      ],
      clock: immediateClock(),
      inputDocument: JSON.stringify(inputPlan),
      stderr: { write: (value) => {
        stderr.push(String(value));
        return true;
      } },
      stdout: { write: (value) => {
        stdout.push(String(value));
        return true;
      } },
      timeoutMs: options.timeoutMs ?? 1,
    },
  );
  return { exitCode, stderr, stdout };
};

const runPreflightCli = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  stateDirectory: string,
): Promise<Readonly<{ exitCode: number; stderr: string[]; stdout: string[] }>> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
    { provider, stateDirectory },
    {
      arguments: ["preflight", "--vercel-cli", "/safe/bin/vercel"],
      inputDocument: JSON.stringify(inputPlan),
      stderr: { write: (value) => {
        stderr.push(String(value));
        return true;
      } },
      stdout: { write: (value) => {
        stdout.push(String(value));
        return true;
      } },
    },
  );
  return { exitCode, stderr, stdout };
};

describe("current-project alias plan", () => {
  test("parses the checked exact editorial-image release plan", async () => {
    const document = await readFile(
      join(import.meta.dir, "..", "docs", "hra-sh-80c20f7-plan.json"),
      "utf8",
    );
    const parsed = parseCurrentProjectAliasReleasePlan(document);

    expect(parsed.repository).toEqual({ id: 1_343_008_607, name: "hraness/hra" });
    expect(parsed.vercel.projectId).toBe("prj_8ciIt9t9foE3utG45frRN7cxckjS");
    expect(parsed.vercel.source.deploymentId).toBe("dpl_7pK5Y4G5G6rrNWzExGCYCjr6kMKN");
    expect(parsed.vercel.target.deploymentId).toBe("dpl_5um4zKKeN7WhLT58xoycxRkeoVKZ");
    expect(parsed.vercel.target.sourceCommit).toBe(
      "80c20f7b1aa06aaec4a8bc03dbea249911de4717",
    );
  });

  test("rejects retired and name-only provider identities", () => {
    const retiredVercel = structuredClone(plan) as Record<string, unknown>;
    (retiredVercel.vercel as Record<string, unknown>).projectId =
      "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
    const retiredConvex = structuredClone(plan) as Record<string, unknown>;
    (retiredConvex.convex as Record<string, unknown>).projectId = 2_680_173;
    const retiredDeployment = structuredClone(plan) as Record<string, unknown>;
    (retiredDeployment.convex as Record<string, unknown>).deploymentId = 4_677_913;
    const retiredRepository = structuredClone(plan) as Record<string, unknown>;
    (retiredRepository.repository as Record<string, unknown>).id = 1_334_876_494;
    const uppercaseKey = { ...plan, idempotencyKey: plan.idempotencyKey.toUpperCase() };

    for (const value of [
      retiredVercel,
      retiredConvex,
      retiredDeployment,
      retiredRepository,
      uppercaseKey,
      { ...plan, extra: true },
      { ...plan, vercel: { ...plan.vercel, target: source } },
    ]) {
      expect(() => parseCurrentProjectAliasReleasePlan(JSON.stringify(value)))
        .toThrow("input_invalid");
    }
  });

  test("derives one exact record confirmation including project, IDs, and hostnames", () => {
    expect(requiredAliasConfirmation(plan)).toBe(
      `reassign hra.sh in ${HRA_VERCEL_PROJECT_ID} from ${source.deploymentId}@${source.deploymentUrl} to ${target.deploymentId}@${target.deploymentUrl} using plan ${plan.idempotencyKey}`,
    );
    expect(requiredAliasConfirmation({
      ...plan,
      idempotencyKey: "e34dc7a8-7df7-42d3-9e9f-6e95bcf2541d",
    })).not.toBe(requiredAliasConfirmation(plan));
  });

  test("binds one plan digest to distinct forward and recovery mutation keys", () => {
    const targetKey = currentAliasReleaseMutationKey(plan, "assign-target");
    const sourceKey = currentAliasReleaseMutationKey(plan, "restore-source");

    expect(currentAliasReleasePlanDigest(plan)).toMatch(/^[0-9a-f]{64}$/u);
    expect(targetKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(sourceKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(targetKey).not.toBe(sourceKey);
    const changedPlan: CurrentProjectAliasReleasePlan = {
      ...plan,
      vercel: {
        ...plan.vercel,
        target: { ...plan.vercel.target, sourceCommit: "3".repeat(40) },
      },
    };
    expect(currentAliasReleaseMutationKey(changedPlan, "assign-target")).not.toBe(targetKey);
    expect(currentAliasReleaseMutationKey(changedPlan, "restore-source")).not.toBe(sourceKey);
  });

  test("binds the narrow current CLI source provenance into the plan digest", () => {
    expect(parseCurrentProjectAliasReleasePlan(JSON.stringify(cliSourcePlan)))
      .toEqual(cliSourcePlan);
    expect(currentAliasReleasePlanDigest(cliSourcePlan))
      .not.toBe(currentAliasReleasePlanDigest(plan));

    for (const sourceProvenance of [
      { ...cliSourcePlan.vercel.sourceProvenance, actor: "vercel-cli" },
      { ...cliSourcePlan.vercel.sourceProvenance, gitCommitRef: "main" },
      { ...cliSourcePlan.vercel.sourceProvenance, gitRootDirectory: "site" },
      { ...cliSourcePlan.vercel.sourceProvenance, kind: "marker-only" },
      { ...cliSourcePlan.vercel.sourceProvenance, extra: true },
    ]) {
      expect(() => parseCurrentProjectAliasReleasePlan(JSON.stringify({
        ...cliSourcePlan,
        vercel: { ...cliSourcePlan.vercel, sourceProvenance },
      }))).toThrow("input_invalid");
    }
  });

  test("parses only complete immutable deployment provenance records", () => {
    expect(parseCurrentDeploymentReadback(deploymentFor(target)))
      .toEqual(deploymentFor(target));
    expect(parseCurrentDeploymentReadback(cliDeploymentFor(source)))
      .toEqual(cliDeploymentFor(source));
    expect(() => parseCurrentDeploymentReadback({
      ...deploymentFor(target),
      source: "cli",
    })).toThrow("provider_readback_invalid");

    const validCli = cliDeploymentFor(source) as Extract<
      CurrentDeploymentReadback,
      { gitSource: null }
    >;
    for (const invalid of [
      { ...validCli, source: "git" },
      { ...validCli, gitSource: undefined },
      { ...validCli, meta: { ...validCli.meta, actor: "vercel-cli" } },
      { ...validCli, meta: { ...validCli.meta, gitCommitRef: "main" } },
      { ...validCli, meta: { ...validCli.meta, gitCommitSha: "not-a-commit" } },
      { ...validCli, meta: { ...validCli.meta, gitRootDirectory: "site" } },
      { ...validCli, readyState: "BUILDING" },
      { ...validCli, target: null },
    ]) {
      expect(() => parseCurrentDeploymentReadback(invalid))
        .toThrow("provider_readback_invalid");
    }
  });

  test("requires the exact reviewed Bun runtime before any authority work", async () => {
    expect(() => assertCurrentAliasReleaseBunVersion("1.3.14")).not.toThrow();
    expect(() => assertCurrentAliasReleaseBunVersion("1.3.15"))
      .toThrow("bun_version_unsupported");
    const implementation = await readFile(
      join(import.meta.dir, "current-project-alias-release.ts"),
      "utf8",
    );
    const main = implementation.indexOf("if (import.meta.main)");
    const runtimeGuard = implementation.indexOf(
      "assertCurrentAliasReleaseBunVersion();",
      main,
    );
    const journalRecovery = implementation.indexOf("recoverBoundedProcessJournal();", main);
    expect(main).toBeGreaterThanOrEqual(0);
    expect(runtimeGuard).toBeGreaterThan(main);
    expect(journalRecovery).toBeGreaterThan(runtimeGuard);
  });
});

describe("current-project alias authority", () => {
  test("preflight proves both deployments, current Convex, and exact source marker", async () => {
    const provider = new FakeProvider();

    expect(await observeCurrentAliasAuthority(plan, provider)).toEqual({
      reason: "exact_source",
      state: "source",
    });
    expect(provider.operations).toEqual([
      "verify-vercel",
      `verify-convex:${String(convex.deploymentId)}`,
      "read-project",
      `read-deployment:${source.deploymentId}`,
      `read-deployment:${target.deploymentId}`,
      "read-alias:source",
      "read-marker:source",
    ]);
    expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();
  });

  test("admits only the explicitly bound current CLI source and rechecks its alias", async () => {
    const provider = new FakeProvider();
    provider.activePlan = cliSourcePlan;

    expect(await observeCurrentAliasAuthority(cliSourcePlan, provider)).toEqual({
      reason: "exact_source",
      state: "source",
    });
    expect(provider.operations).toEqual([
      "verify-vercel",
      `verify-convex:${String(convex.deploymentId)}`,
      "read-project",
      `read-deployment:${source.deploymentId}`,
      `read-deployment:${target.deploymentId}`,
      "read-alias:source",
      "read-marker:source",
      "read-alias:source",
    ]);

    const unbound = new FakeProvider();
    unbound.sourceDeploymentOverride = cliDeploymentFor(source);
    await expect(observeCurrentAliasAuthority(plan, unbound))
      .rejects.toThrow("provider_readback_invalid");

    const wrongCommit = new FakeProvider();
    wrongCommit.activePlan = cliSourcePlan;
    const readback = cliDeploymentFor(source) as Extract<
      CurrentDeploymentReadback,
      { gitSource: null }
    >;
    wrongCommit.sourceDeploymentOverride = {
      ...readback,
      meta: { ...readback.meta, gitCommitSha: "4".repeat(40) },
    };
    await expect(observeCurrentAliasAuthority(cliSourcePlan, wrongCommit))
      .rejects.toThrow("provider_readback_invalid");

    const movedDuringMarkerRead = new FakeProvider();
    movedDuringMarkerRead.activePlan = cliSourcePlan;
    movedDuringMarkerRead.afterReadMarker = () => {
      movedDuringMarkerRead.aliasState = "target";
    };
    expect(await observeCurrentAliasAuthority(cliSourcePlan, movedDuringMarkerRead))
      .toEqual({ reason: "alias_not_planned", state: "blocked" });
  });

  test("keeps the target GitHub-main-only for a CLI-source plan", async () => {
    const provider = new FakeProvider();
    provider.activePlan = cliSourcePlan;
    provider.targetDeploymentOverride = cliDeploymentFor(target);

    await expect(observeCurrentAliasAuthority(cliSourcePlan, provider))
      .rejects.toThrow("provider_readback_invalid");
    expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();

    const hybrid = new FakeProvider();
    hybrid.activePlan = cliSourcePlan;
    hybrid.targetDeploymentOverride = {
      ...deploymentFor(target),
      source: "cli",
    } as unknown as CurrentDeploymentReadback;
    await expect(observeCurrentAliasAuthority(cliSourcePlan, hybrid))
      .rejects.toThrow("provider_readback_invalid");
    expect(hybrid.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();
  });

  test("moves from the proved CLI source to the exact GitHub target", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);

      const result = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        changed: true,
        targetSourceCommit: target.sourceCommit,
      });
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema))
        .toMatchObject({
          finalAuthority: {
            sourceProvenance: cliSourcePlan.vercel.sourceProvenance,
          },
          finalState: "target",
        });

      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));
      const replay = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout.join(""))).toMatchObject({
        replayed: true,
        status: "committed",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("restores and re-proves only the exact CLI source after target proof fails", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      provider.breakTargetMarker = true;

      const result = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
      expect(provider.operations.slice(-2)).toEqual([
        "read-marker:source",
        "read-alias:source",
      ]);
    });
  });

  test("does not receipt a CLI source restoration when its marker sandwich loses the alias", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      provider.breakTargetMarker = true;
      let restoredSourceMarkers = 0;
      provider.afterReadMarker = () => {
        if (
          provider.operations.includes(`set-alias:${source.deploymentUrl}`)
          && provider.operations.at(-1) === "read-marker:source"
        ) {
          restoredSourceMarkers += 1;
          if (restoredSourceMarkers === 2) provider.aliasState = "target";
        }
      };
      const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);

      const result = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const racedMarker = provider.operations.findIndex((operation, index, operations) =>
        operation === "read-marker:source" && operations[index + 1] === "read-alias:target");
      expect(racedMarker).toBeGreaterThanOrEqual(0);
    });
  });

  test("blocks an unknown alias and refuses target deployment drift before mutation", async () => {
    const unknown = new FakeProvider();
    unknown.aliasState = "unknown";
    expect(await observeCurrentAliasAuthority(plan, unknown)).toEqual({
      reason: "alias_not_planned",
      state: "blocked",
    });

    const drift = new FakeProvider();
    drift.breakTargetDeployment = true;
    await expect(observeCurrentAliasAuthority(plan, drift))
      .rejects.toThrow("provider_readback_invalid");
    expect(drift.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();
  });

  test("requires the exact user-confirmed record before any alias write", async () => {
    await withStateDirectory(async (stateDirectory) => {
      for (const confirmation of [undefined, "approve both", "reassign hra.sh"] as const) {
        const provider = new FakeProvider();
        const stderr: string[] = [];
        const arguments_ = ["--execute", "--vercel-cli", "/safe/bin/vercel"];
        if (confirmation !== undefined) arguments_.push("--confirm-exact", confirmation);
        const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
          { provider, stateDirectory },
          {
            arguments: arguments_,
            inputDocument: JSON.stringify(plan),
            stderr: { write: (value) => {
              stderr.push(String(value));
              return true;
            } },
            stdout: { write: () => true },
          },
        );
        expect(exitCode).toBe(1);
        expect(JSON.parse(stderr.join(""))).toMatchObject({ code: "confirmation_required" });
        expect(provider.operations).toEqual([]);
      }
    });
  });

  test("commits only the target alias and repeats every provider readback", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const result = await runExecuteCli(plan, provider, stateDirectory);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        changed: true,
        replayed: false,
      });
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
      expect(provider.operations.filter((operation) => operation === "verify-vercel"))
        .toHaveLength(3);
      expect(provider.operations.filter((operation) =>
        operation === `verify-convex:${String(convex.deploymentId)}`))
        .toHaveLength(3);
    });
  });

  test("does not infer a commit or dispatch recovery from a lost target response", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.targetSetBehavior = "commit-and-throw";
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const ambiguous = await runExecuteCli(plan, provider, stateDirectory);
      expect(ambiguous.exitCode).toBe(75);
      expect(JSON.parse(ambiguous.stderr.join(""))).toMatchObject({
        code: "target_result_ambiguous",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      const preflightProvider = new FakeProvider();
      preflightProvider.aliasState = "target";
      const preflight = await runPreflightCli(plan, preflightProvider, stateDirectory);
      expect(preflight.exitCode).toBe(75);
      expect(preflight.stdout).toEqual([]);
      expect(JSON.parse(preflight.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(preflightProvider.operations).toEqual([]);

      const replay = await runExecuteCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(75);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("rejects a target response that replaced an unplanned deployment", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.mutationOldDeploymentIdOverride = "dpl_UnknownCurrent12345678901";
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const conflict = await runExecuteCli(plan, provider, stateDirectory);
      expect(conflict.exitCode).toBe(75);
      expect(JSON.parse(conflict.stderr.join(""))).toMatchObject({
        code: "provider_readback_invalid",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toHaveLength(1);
    });
  });

  test("waits through stale source reads before committing the target", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.targetVisibilityLagReads = 2;

      expect((await runExecuteCli(plan, provider, stateDirectory, { timeoutMs: 1_000 })).exitCode)
        .toBe(0);
      expect(provider.operations.filter((operation) => operation === "read-alias:source").length)
        .toBeGreaterThanOrEqual(3);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
    });
  });

  test("replays an exact target state under the same exact confirmation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.aliasState = "target";

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        changed: false,
        replayed: true,
        status: "already_committed",
      });
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });

  test("restores only the exact same-project source when the target marker is wrong", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({ code: "alias_reverted" });
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
    });
  });

  test("waits through stale target reads while proving source restoration", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.sourceVisibilityLagReads = 2;

      const result = await runExecuteCli(plan, provider, stateDirectory, {
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(1);
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
      expect(provider.operations.filter((operation) => operation === "read-alias:target").length)
        .toBeGreaterThan(2);
    });
  });

  test("reports recovery required when exact source restoration cannot be proved", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.failSourceSet = true;

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
      });
      expect(provider.aliasState).toBe("target");
    });
  });

  test("stops every provider call immediately when the writer fence is lost", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      let markerReads = 0;
      provider.afterReadMarker = async () => {
        markerReads += 1;
        if (markerReads === 2) {
          await chmod(join(stateDirectory, ".canonical-alias-release.lock"), 0o644);
        }
      };

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });
});

describe("current-project Vercel provider", () => {
  test("constructs only the direct alias endpoint request with the plan-bound key", async () => {
    const key = currentAliasReleaseMutationKey(plan, "assign-target");
    expect(currentAliasReleaseApiArguments(target, key)).toEqual([
      "api",
      `/v2/deployments/${target.deploymentId}/aliases`,
      "--method",
      "POST",
      "--raw-field",
      "alias=hra.sh",
      "--header",
      `Idempotency-Key:${key}`,
      "--scope",
      HRA_VERCEL_TEAM_ID,
      "--raw",
    ]);

    const implementation = await readFile(
      join(import.meta.dir, "current-project-alias-release.ts"),
      "utf8",
    );
    expect(implementation).not.toContain('"alias",\n      "set"');
    expect(implementation).not.toContain("/v4/domains");
    expect(implementation).not.toContain("certificates");
  });

  test("keeps only the explicit non-secret child environment", () => {
    expect(buildVercelEnvironment({
      HOME: "/safe/home",
      PATH: "/safe/bin",
      VERCEL_TOKEN: "secret",
      VERCEL_ORG_ID: "wrong-authority",
      VERCEL_PROJECT_ID: "wrong-project",
    })).toEqual({
      HOME: "/safe/home",
      NO_COLOR: "1",
      PATH: "/safe/bin",
      TERM: "dumb",
    });
  });

  test("does not expose ambient provider or fence bypasses on normal import", async () => {
    const module = await import("./current-project-alias-release");
    for (const name of [
      "currentProjectAliasReleaseTestHarness",
      "VercelCurrentProjectAliasProvider",
      "runVercelCommand",
      "acquireCurrentAliasReleaseExecutionLock",
      "executeCurrentProjectAliasRelease",
      "executeCurrentAliasReleasePlan",
    ]) expect(name in module).toBeFalse();
    expect("executeCurrentProjectAliasReleaseWithExplicitCapability" in module).toBeTrue();
  });

  test("rejects JavaScript-shaped missing capabilities without ambient fallback", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const invalidCapabilities: unknown[] = [
        { provider: undefined, stateDirectory },
        { provider: null, stateDirectory },
        { provider, stateDirectory: undefined },
        { provider, stateDirectory: null },
        { provider, stateDirectory: "relative/state" },
      ];

      for (const capability of invalidCapabilities) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
          capability as Parameters<
            typeof executeCurrentProjectAliasReleaseWithExplicitCapability
          >[0],
          {
            arguments: ["preflight", "--vercel-cli", "/provider/must-not-run"],
            inputDocument: JSON.stringify(plan),
            stderr: { write: (value) => {
              stderr.push(String(value));
              return true;
            } },
            stdout: { write: (value) => {
              stdout.push(String(value));
              return true;
            } },
          },
        );

        expect(exitCode).toBe(1);
        expect(stdout).toEqual([]);
        expect(JSON.parse(stderr.join(""))).toEqual({
          code: "usage_invalid",
          schemaVersion: 1,
          status: "refused",
        });
      }
      expect(provider.operations).toEqual([]);
      expect(await Bun.file(
        join(stateDirectory, ".canonical-alias-release.lock"),
      ).exists()).toBeFalse();
    });
  });
});

describe("durable current-project alias execution", () => {
  test("reserves room for a complete terminal pair at the bounded ledger edge", () => {
    expect(currentAliasReleaseStateEntryMaximum).toBe(4_097);
    expect(() => assertCurrentAliasReleaseStateCapacity(4_095, 2)).not.toThrow();
    expect(() => assertCurrentAliasReleaseStateCapacity(4_096, 2))
      .toThrow("durable_state_capacity_exhausted");
    expect(() => assertCurrentAliasReleaseStateCapacity(4_097, 0)).not.toThrow();
    expect(() => assertCurrentAliasReleaseStateCapacity(4_097, 1))
      .toThrow("durable_state_capacity_exhausted");
    expect(() => assertCurrentAliasReleaseScanCapacity(4_098)).not.toThrow();
    expect(() => assertCurrentAliasReleaseScanCapacity(4_099))
      .toThrow("durable_state_capacity_exhausted");
  });

  test("publishes the exact source intent before mutation and a target receipt after postflight", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      provider.beforeSetAlias = async (endpoint) => {
        if (endpoint.deploymentUrl !== target.deploymentUrl) return;
        const intent = readProtectedJson(paths.intent, currentAliasReleaseIntentSchema);
        expect(intent.idempotencyKey).toBe(plan.idempotencyKey);
        expect(intent.planDigest).toBe(currentAliasReleasePlanDigest(plan));
        expect(intent.sourceAuthority.marker.sourceCommit).toBe(source.sourceCommit);
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      };

      const first = await runExecuteCli(plan, provider, stateDirectory);
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toEqual([]);
      expect(JSON.parse(first.stdout.join(""))).toMatchObject({
        changed: true,
        idempotencyKey: plan.idempotencyKey,
        replayed: false,
        status: "committed",
      });
      const intent = readProtectedJson(paths.intent, currentAliasReleaseIntentSchema);
      const receipt = readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema);
      expect(receipt).toMatchObject({
        finalState: "target",
        idempotencyKey: plan.idempotencyKey,
        intentDigest: intent.selfDigest,
      });
      expect((await stat(paths.intent)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.receipt)).mode & 0o777).toBe(0o600);

      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));
      const replay = await runExecuteCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout.join(""))).toMatchObject({
        changed: true,
        replayed: true,
        status: "committed",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("renders a second authority-read failure after intent as recovery required", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.failVerifyVercelAt = 2;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const failed = await runExecuteCli(plan, provider, stateDirectory);
      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "provider_command_failed",
        idempotencyKey: plan.idempotencyKey,
        intentPath: paths.intent,
        receiptPath: paths.receipt,
        status: "recovery_required",
      });
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();

      const replayProvider = new FakeProvider();
      const replay = await runExecuteCli(plan, replayProvider, stateDirectory);
      expect(replay.exitCode).toBe(75);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(replayProvider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });

  test("treats failure after intent publication as durable recovery", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        afterIntentPublication: () => {
          throw new Error("post-link readback failed");
        },
      });
      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "intent_write_failed",
        idempotencyKey: plan.idempotencyKey,
        intentPath: paths.intent,
        receiptPath: paths.receipt,
        status: "recovery_required",
      });
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });

  test("blocks mutation when a target receipt publication leaves only an intent", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      });

      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "receipt_write_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      expect(recovered.exitCode).toBe(75);
      expect(JSON.parse(recovered.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writesBeforeReplay);
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("recovers a crash-durable temporary hardlink before blocking replay", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      });
      expect(failed.exitCode).toBe(75);
      const temporary = join(
        stateDirectory,
        `.${basename(paths.intent)}.${"a".repeat(32)}.tmp`,
      );
      await link(paths.intent, temporary);
      expect((await stat(paths.intent)).nlink).toBe(2);
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);

      expect(recovered.exitCode).toBe(75);
      expect(await Bun.file(temporary).exists()).toBeFalse();
      expect((await stat(paths.intent)).nlink).toBe(1);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writesBeforeReplay);
    });
  });

  test("dispatches no mutation when a proved source receipt was lost", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("source receipt unavailable");
        },
      });
      expect(failed.exitCode).toBe(75);
      expect(provider.aliasState).toBe("source");
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      const replayWrites = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:")).slice(writesBeforeReplay.length);

      expect(recovered.exitCode).toBe(75);
      expect(JSON.parse(recovered.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(replayWrites).toEqual([]);
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("does not receipt a source restoration whose mutation response was ambiguous", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.sourceSetCommitAndThrow = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const ambiguous = await runExecuteCli(plan, provider, stateDirectory);
      expect(ambiguous.exitCode).toBe(75);
      expect(JSON.parse(ambiguous.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("source");
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      provider.sourceSetCommitAndThrow = false;
      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      expect(recovered.exitCode).toBe(75);
      expect(JSON.parse(recovered.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("dispatches no mutation from a blocked unresolved intent", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      expect((await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("target receipt unavailable");
        },
      })).exitCode).toBe(75);
      expect(provider.aliasState).toBe("target");
      provider.breakTargetMarker = true;
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      const replayWrites = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:")).slice(writesBeforeReplay.length);

      expect(recovered.exitCode).toBe(75);
      expect(provider.aliasState).toBe("target");
      expect(replayWrites).toEqual([]);
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("records a proven source restoration and replays it without another write", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const reverted = await runExecuteCli(plan, provider, stateDirectory);

      expect(reverted.exitCode).toBe(1);
      expect(JSON.parse(reverted.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema).finalState)
        .toBe("source");
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      const replay = await runExecuteCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(1);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("serializes all plans behind one execution lock", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const firstProvider = new FakeProvider();
      let releaseFirst = (): void => undefined;
      let reportFirstHeld = (): void => undefined;
      const firstHeld = new Promise<void>((resolvePromise) => {
        reportFirstHeld = resolvePromise;
      });
      const firstMayContinue = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      firstProvider.beforeSetAlias = async (endpoint) => {
        if (endpoint.deploymentId !== target.deploymentId) return;
        reportFirstHeld();
        await firstMayContinue;
      };
      const first = runExecuteCli(plan, firstProvider, stateDirectory);
      await firstHeld;

      const secondProvider = new FakeProvider();
      const second = await runExecuteCli(plan, secondProvider, stateDirectory);
      expect(second.exitCode).toBe(1);
      expect(JSON.parse(second.stderr.join(""))).toMatchObject({
        code: "execution_locked",
        status: "refused",
      });
      expect(secondProvider.operations).toEqual([]);
      releaseFirst();
      expect((await first).exitCode).toBe(0);
    });
  });

  test("blocks a different plan behind an unresolved intent", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const failedProvider = new FakeProvider();
      failedProvider.breakTargetMarker = true;
      failedProvider.failSourceSet = true;
      expect((await runExecuteCli(plan, failedProvider, stateDirectory)).exitCode).toBe(75);

      const nextPlan = {
        ...plan,
        idempotencyKey: "e34dc7a8-7df7-42d3-9e9f-6e95bcf2541d",
      };
      const nextProvider = new FakeProvider();
      const blocked = await runExecuteCli(nextPlan, nextProvider, stateDirectory);
      const blockedResult = JSON.parse(blocked.stderr.join("")) as Record<string, unknown>;
      const priorPaths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const nextPaths = currentAliasReleaseStatePaths(nextPlan, stateDirectory);
      expect(blocked.exitCode).toBe(75);
      expect(blockedResult).toMatchObject({
        code: "unresolved_prior_intent",
        idempotencyKey: plan.idempotencyKey,
        intentPath: priorPaths.intent,
        receiptPath: priorPaths.receipt,
        status: "recovery_required",
      });
      expect(blockedResult.intentPath).not.toBe(nextPaths.intent);
      expect(blockedResult.receiptPath).not.toBe(nextPaths.receipt);
      expect(nextProvider.operations).toEqual([]);
    });
  });

  test("refuses changed reuse of an existing idempotency key before provider reads", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      expect((await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      })).exitCode).toBe(75);

      const changedPlan: CurrentProjectAliasReleasePlan = {
        ...plan,
        vercel: {
          ...plan.vercel,
          target: { ...plan.vercel.target, sourceCommit: "3".repeat(40) },
        },
      };
      const changedProvider = new FakeProvider();
      const refused = await runExecuteCli(changedPlan, changedProvider, stateDirectory);
      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(changedProvider.operations).toEqual([]);
    });
  });

  test("refuses removing CLI source provenance from a completed plan before provider reads", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      expect((await runExecuteCli(cliSourcePlan, provider, stateDirectory)).exitCode).toBe(0);

      const changedProvider = new FakeProvider();
      const refused = await runExecuteCli(plan, changedProvider, stateDirectory);
      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(changedProvider.operations).toEqual([]);
    });
  });

  test("does not publish a source intent for an unplanned provider state", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.aliasState = "unknown";
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const refused = await runExecuteCli(plan, provider, stateDirectory);

      expect(refused.exitCode).toBe(1);
      expect(await Bun.file(paths.intent).exists()).toBeFalse();
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });
});

describe("current-project alias CLI", () => {
  test("emits a read-only ready result with the exact required confirmation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
        { provider, stateDirectory },
        {
          arguments: ["preflight", "--vercel-cli", "/safe/bin/vercel"],
          inputDocument: JSON.stringify(plan),
          stderr: { write: (value) => {
            stderr.push(String(value));
            return true;
          } },
          stdout: { write: (value) => {
            stdout.push(String(value));
            return true;
          } },
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout.join(""))).toEqual({
        alias: "hra.sh",
        idempotencyKey: plan.idempotencyKey,
        nextAction: "confirm_exact_record_then_execute",
        observedState: "source",
        reason: "exact_source",
        requiredConfirmation: requiredAliasConfirmation(plan),
        schemaVersion: 1,
        sourceDeploymentId: source.deploymentId,
        status: "ready",
        targetDeploymentId: target.deploymentId,
        targetProjectId: HRA_VERCEL_PROJECT_ID,
      });
    });
  });

  test("renders failed compensation as terminal recovery instead of success", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.failSourceSet = true;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
        { provider, stateDirectory },
        {
          arguments: [
            "--execute",
            "--vercel-cli",
            "/safe/bin/vercel",
            "--confirm-exact",
            requiredAliasConfirmation(plan),
          ],
          clock: immediateClock(),
          inputDocument: JSON.stringify(plan),
          stderr: { write: (value) => {
            stderr.push(String(value));
            return true;
          } },
          stdout: { write: (value) => {
            stdout.push(String(value));
            return true;
          } },
          timeoutMs: 1,
        },
      );

      expect(exitCode).toBe(75);
      expect(stdout).toEqual([]);
      expect(JSON.parse(stderr.join(""))).toEqual({
        code: "compensation_failed",
        idempotencyKey: plan.idempotencyKey,
        intentPath: paths.intent,
        lockPath: join(stateDirectory, ".canonical-alias-release.lock"),
        receiptPath: paths.receipt,
        schemaVersion: 1,
        status: "recovery_required",
      });
    });
  });

  test("accepts only the closed preflight and execute argument surfaces", () => {
    expect(parseArguments([
      "preflight",
      "--vercel-cli",
      "/safe/bin/vercel",
    ])).toEqual({ operation: "preflight", planFd: 0, vercelCli: "/safe/bin/vercel" });
    expect(parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/bin/vercel",
      "--confirm-exact",
      requiredAliasConfirmation(plan),
      "--plan-fd",
      "3",
    ])).toEqual({
      confirmation: requiredAliasConfirmation(plan),
      operation: "execute",
      planFd: 3,
      vercelCli: "/safe/bin/vercel",
    });
    for (const arguments_ of [
      ["preflight", "--vercel-cli", "vercel"],
      ["preflight", "--vercel-cli", "/safe/bin/vercel", "--confirm-exact", "approve both"],
      ["--execute", "--vercel-cli", "/safe/bin/vercel", "--force"],
      ["--execute", "--vercel-cli", "/safe/bin/vercel", "--domain"],
      ["--execute", "--vercel-cli", "/safe/bin/vercel", "--dns"],
    ]) expect(() => parseArguments(arguments_)).toThrow("usage_invalid");
  });
});
