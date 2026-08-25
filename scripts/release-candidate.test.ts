import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalDigest,
  canonicalJson,
  cutoverEvidenceSchema,
  deployEvidenceSchema,
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  HRA_RELEASE_TAG,
  HRA_REPOSITORY_ID,
  HRA_V0_VERCEL_PROJECT_ID,
  HRA_VERCEL_PROJECT_ID,
  liveAcceptanceEvidenceDocumentSchema,
  releaseCandidateReceiptSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type DeployEvidence,
  type RuntimeReleaseAttestation,
} from "./release-evidence";
import {
  createReleaseCandidateReceipt,
  candidateForwardPlan,
  candidateReversePlan,
  parseCandidateArguments,
  renderReleaseCandidateFailure,
  runReleaseCandidateProcess,
  SystemReleaseCandidateProvider,
  tagReleaseCandidate,
  verifyReleaseCandidateReceipt,
  type CandidateCiJob,
  type CandidateEvidencePaths,
  type CandidateReleaseState,
  type CandidateTagAuthority,
  type CandidateVercelAuthority,
  type ReleaseCandidateProvider,
} from "./release-candidate";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessInvocationGuard,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";

const roots: string[] = [];
const candidateCommit = "a".repeat(40);
const bootstrapCommit = "b".repeat(40);
const fallbackCommit = "443448b79e9016e00d52501f047fce3a408de092";
const target = {
  deploymentId: 5_089_017,
  deploymentName: "qualified-hummingbird-537",
  deploymentUrl: "https://qualified-hummingbird-537.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
} as const;

const makeRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-release-candidate-test-")));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

const runtime = (
  sourceCommit: string,
  deployedAtMs: number,
  previousDeployDigest: string | null,
  suffix: string,
): RuntimeReleaseAttestation => ({
  bound: true,
  deployedAtMs,
  previousDeployDigest,
  runtimeRevision: `00000000-0000-4000-8000-0000000000${suffix}`,
  runtimeSourceCommit: sourceCommit,
  schemaIdentity: "hra-release-attestation-v1",
  schemaVersion: 1,
});

const deploy = (
  phase: "bootstrap" | "candidate",
  sourceCommit: string,
  before: RuntimeReleaseAttestation | null,
  after: RuntimeReleaseAttestation,
  previousDeployDigest: string | null,
): DeployEvidence => deployEvidenceSchema.parse(withSelfDigest({
  after,
  before,
  kind: "convex-deploy" as const,
  overlaySha256: "4".repeat(64),
  phase,
  previousDeployDigest,
  schemaVersion: 1 as const,
  sourceCommit,
  target,
  targetDigest: canonicalDigest(target),
}));

const vercel: CandidateVercelAuthority = {
  candidate: {
    deploymentId: `dpl_${"N".repeat(24)}`,
    deploymentUrl: "hra-new-accepted.vercel.app",
    projectId: HRA_VERCEL_PROJECT_ID,
    repositoryId: HRA_REPOSITORY_ID,
    sourceCommit: candidateCommit,
    version: "0.1.0",
  },
  fallback: {
    deploymentId: `dpl_${"Q".repeat(24)}`,
    deploymentUrl: "hra-v0-accepted.vercel.app",
    projectId: HRA_V0_VERCEL_PROJECT_ID,
    repositoryId: 1_334_876_494,
    sourceCommit: fallbackCommit,
    version: "0.1.15",
  },
};

class FakeCandidateProvider implements ReleaseCandidateProvider {
  readonly calls: string[] = [];
  authorityDigest = "9".repeat(64);
  localTag: CandidateTagAuthority | null = null;
  releaseState: CandidateReleaseState = "absent";
  remoteTag: CandidateTagAuthority | null = null;
  runtime: RuntimeReleaseAttestation;
  surfaceDigest = "8".repeat(64);
  sourceValid = true;

  constructor(runtimeAttestation: RuntimeReleaseAttestation) {
    this.runtime = runtimeAttestation;
  }

  async verifyLocalSource(commit: string): Promise<void> {
    this.calls.push(`source:${commit}`);
    if (!this.sourceValid) throw new Error("source drift");
  }

  async readCiJobs(commit: string): Promise<readonly CandidateCiJob[]> {
    this.calls.push("ci");
    return ["Check (ubuntu-24.04)", "Required", "Check (macos-15)"].map((name) => ({
      completedAt: "2026-08-24T12:00:00.000Z",
      conclusion: "success",
      headCommit: commit,
      name: name as CandidateCiJob["name"],
      runAttempt: 2,
      runId: 123,
      workflow: "CI",
    }));
  }

  async readRuntimeAttestation(): Promise<RuntimeReleaseAttestation> {
    this.calls.push("runtime");
    return this.runtime;
  }

  async readSurfaceDigest(): Promise<string> {
    this.calls.push("surface");
    return this.surfaceDigest;
  }

  async readVercelAuthorityDigest(): Promise<string> {
    this.calls.push("vercel");
    return this.authorityDigest;
  }

  async readRemoteTag(): Promise<CandidateTagAuthority | null> {
    this.calls.push("remote-tag");
    return this.remoteTag;
  }

  async readLocalTag(): Promise<CandidateTagAuthority | null> {
    this.calls.push("local-tag");
    return this.localTag;
  }

  async readReleaseState(): Promise<CandidateReleaseState> {
    this.calls.push("release");
    return this.releaseState;
  }

  async createLocalTag(commit: string, candidateDigest: string): Promise<void> {
    this.calls.push("mutate:create-tag");
    this.localTag = { candidateDigest, commit };
  }

  async pushTag(): Promise<void> {
    this.calls.push("mutate:push-tag");
    this.remoteTag = this.localTag;
  }
}

const writeEvidenceChain = async (
  root: string,
  invalidPlan?: "arbitrary" | "swapped",
): Promise<Readonly<{
  candidateRuntime: RuntimeReleaseAttestation;
  paths: CandidateEvidencePaths;
}>> => {
  const bootstrapRuntime = runtime(bootstrapCommit, 100, null, "01");
  const bootstrap = deploy("bootstrap", bootstrapCommit, null, bootstrapRuntime, null);
  const candidateRuntime = runtime(candidateCommit, 200, bootstrap.selfDigest, "02");
  const candidate = deploy(
    "candidate",
    candidateCommit,
    bootstrapRuntime,
    candidateRuntime,
    bootstrap.selfDigest,
  );
  const paths: CandidateEvidencePaths = {
    bootstrapDeploy: join(root, "bootstrap-deploy.json"),
    bootstrapLive: join(root, "bootstrap-live.json"),
    candidateDeploy: join(root, "candidate-deploy.json"),
    candidateLive: join(root, "candidate-live.json"),
    finalForwardCutover: join(root, "final-forward.json"),
    forwardCutover: join(root, "forward.json"),
    reverseCutover: join(root, "reverse.json"),
  };
  writeProtectedJsonNoReplace(paths.bootstrapDeploy, bootstrap, deployEvidenceSchema);
  writeProtectedJsonNoReplace(paths.candidateDeploy, candidate, deployEvidenceSchema);
  const live = (sourceCommit: string, runSuffix: string, completedAt: number) =>
    liveAcceptanceEvidenceDocumentSchema.parse(withSelfDigest({
      completedAt,
      deployEvidenceDigest: sourceCommit === bootstrapCommit
        ? bootstrap.selfDigest
        : candidate.selfDigest,
      evidenceDigest: runSuffix.repeat(32),
      kind: "live-acceptance" as const,
      packageVersion: "0.1.0" as const,
      runId: `00000000-0000-4000-8000-0000000000${runSuffix}`,
      runtimeRevision: sourceCommit === bootstrapCommit
        ? bootstrapRuntime.runtimeRevision
        : candidateRuntime.runtimeRevision,
      schemaVersion: 1 as const,
      sourceCommit,
      startedAt: completedAt - 10,
      status: "passed" as const,
      targetDigest: canonicalDigest(target),
    }));
  writeProtectedJsonNoReplace(
    paths.bootstrapLive,
    live(bootstrapCommit, "11", 300),
    liveAcceptanceEvidenceDocumentSchema,
  );
  writeProtectedJsonNoReplace(
    paths.candidateLive,
    live(candidateCommit, "12", 400),
    liveAcceptanceEvidenceDocumentSchema,
  );
  const cutover = (
    direction: "forward" | "reverse",
    sequence: 1 | 2 | 3,
    previousDigest: string | null,
  ) => cutoverEvidenceSchema.parse(withSelfDigest({
    changed: true,
    direction,
    finalAuthorityDigest: direction === "reverse" ? "a".repeat(64) : "9".repeat(64),
    kind: "domain-cutover" as const,
    planDigest: invalidPlan === "arbitrary" && sequence === 1
      ? "1".repeat(64)
      : invalidPlan === "swapped" && sequence === 1
        ? canonicalDigest(candidateReversePlan(vercel.candidate, vercel.fallback))
        : canonicalDigest(direction === "reverse"
          ? candidateReversePlan(vercel.candidate, vercel.fallback)
          : candidateForwardPlan(vercel.candidate, vercel.fallback)),
    previousDigest,
    replayed: false,
    schemaVersion: 1 as const,
    sequence,
    sourceCommit: candidateCommit,
  }));
  const forward = cutover("forward", 1, null);
  const reverse = cutover("reverse", 2, forward.selfDigest);
  const finalForward = cutover("forward", 3, reverse.selfDigest);
  writeProtectedJsonNoReplace(paths.forwardCutover, forward, cutoverEvidenceSchema);
  writeProtectedJsonNoReplace(paths.reverseCutover, reverse, cutoverEvidenceSchema);
  writeProtectedJsonNoReplace(paths.finalForwardCutover, finalForward, cutoverEvidenceSchema);
  return { candidateRuntime, paths };
};

describe("sealed release candidate", () => {
  test("binds both generation-one cutover endpoints to their distinct repositories", () => {
    expect(candidateForwardPlan(vercel.candidate, vercel.fallback)).toMatchObject({
      source: {
        generation: 1,
        repositoryId: 1_334_876_494,
        sourceCommit: fallbackCommit,
        version: "0.1.15",
      },
      target: {
        generation: 1,
        repositoryId: HRA_REPOSITORY_ID,
        sourceCommit: candidateCommit,
        version: "0.1.0",
      },
    });
    expect(candidateReversePlan(vercel.candidate, vercel.fallback)).toMatchObject({
      source: { generation: 1, repositoryId: HRA_REPOSITORY_ID },
      target: { generation: 1, repositoryId: 1_334_876_494 },
    });
  });

  test("bounds subprocesses with TERM then KILL and refuses an aborted Convex authority read", async () => {
    const startedAt = performance.now();
    const processResult = await runReleaseCandidateProcess({
      arguments: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => undefined, 1_000);",
      ],
      containment: "local",
      cwd: import.meta.dir,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      phase: "candidate-timeout-proof",
      terminationGraceMs: 10,
      timeoutMs: 10,
    });
    expect(processResult.exitCode).toBe(124);
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    let aborted = false;
    const authorityFetch = Object.assign((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return reject(new Error("missing abort signal"));
      const refuse = (): void => {
        aborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) refuse();
      else signal.addEventListener("abort", refuse, { once: true });
    }), { preconnect: () => undefined }) as typeof fetch;
    const provider = new SystemReleaseCandidateProvider({
      authorityFetch,
      authorityTimeoutMs: 10,
      ghCli: "/not-used/gh",
      vercelCli: "/not-used/vercel",
    });
    await expect(provider.readRuntimeAttestation(target.deploymentUrl))
      .rejects.toThrow("convex_authority_invalid");
    expect(aborted).toBeTrue();
  });

  test("poisons tag mutation recovery without a reconciliation read", async () => {
    for (const mutation of ["create", "push"] as const) {
      const phase = mutation === "create" ? "git-local-tag-create" : "git-tag-push";
      const cleanup = new BoundedProcessCleanupUnprovenError(
        mutation === "create" ? 42_430 : 42_431,
        phase,
      );
      const receiptPath = `/tmp/hra-candidate-${mutation}.json`;
      const guard = new BoundedProcessInvocationGuard();
      guard.retainRecoveryPath(receiptPath);
      const phases: string[] = [];
      const containments: string[] = [];
      const executables: string[] = [];
      const provider = new SystemReleaseCandidateProvider({
        ghCli: "/not-used/gh",
        guard,
        runner: async (request) => {
          phases.push(request.phase);
          containments.push(request.containment);
          executables.push(request.executable);
          throw cleanup;
        },
        vercelCli: "/not-used/vercel",
      });
      const operation = mutation === "create"
        ? provider.createLocalTag(candidateCommit, "d".repeat(64))
        : provider.pushTag();
      await expect(operation).rejects.toBe(cleanup);
      await expect(provider.readRemoteTag()).rejects.toBe(cleanup);
      expect(phases).toEqual([phase]);
      expect(containments).toEqual([mutation === "create" ? "local" : "authority"]);
      expect(executables).toEqual(["/usr/bin/git"]);
      expect(cleanup.recoveryPaths).toContain(receiptPath);
    }
  });

  test("renders cleanup and journal custody as recovery-required temporary failures", () => {
    const cleanupPath = "/private/operator/process-recovery/local-release.json";
    const cleanup = new BoundedProcessCleanupUnprovenError(
      42_434,
      "git-tag-push",
    ).retainRecoveryPath(cleanupPath);
    const journalPath = "/private/operator/process-recovery/authority-release.json";
    const cases = [
      {
        error: cleanup,
        expected: {
          code: "process_cleanup_unproven",
          phase: "git-tag-push",
          processGroupId: 42_434,
          processes: [{
            phase: "git-tag-push",
            recoveryIdentity: { containment: "local", processGroupId: 42_434 },
          }],
          recoveryPaths: [cleanupPath],
          schemaVersion: 1,
          status: "recovery_required",
        },
      },
      {
        error: new BoundedProcessRecoveryJournalError(
          [journalPath],
          "authority_recovery_required",
        ),
        expected: {
          code: "process_recovery_journal_blocked",
          reason: "authority_recovery_required",
          recoveryPaths: [journalPath],
          schemaVersion: 1,
          status: "recovery_required",
        },
      },
    ] as const;
    for (const scenario of cases) {
      const stderr: string[] = [];
      expect(renderReleaseCandidateFailure(scenario.error, {
        write(chunk: string | Uint8Array): boolean {
          stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        },
      })).toBe(75);
      expect(JSON.parse(stderr.join(""))).toEqual(scenario.expected);
    }
  });

  test("seals deterministic source, CI, Convex, live, cutover, Vercel, and surface authority", async () => {
    const root = await makeRoot();
    const { candidateRuntime, paths } = await writeEvidenceChain(root);
    const provider = new FakeCandidateProvider(candidateRuntime);
    const outputPath = join(root, "candidate.json");
    const first = await createReleaseCandidateReceipt({
      evidence: paths,
      now: () => Date.parse("2026-08-24T13:00:00.000Z"),
      outputPath,
      provider,
      sourceCommit: candidateCommit,
      vercel,
    });
    expect(first.replayed).toBe(false);
    expect(first.receipt).toMatchObject({
      convex: {
        candidateRuntime,
        target,
      },
      sourceCommit: candidateCommit,
      tag: HRA_RELEASE_TAG,
      vercel: { authorityDigest: provider.authorityDigest },
    });
    expect(new Set(first.receipt.ci.map((job) => `${job.runId}:${job.runAttempt}:${job.headCommit}`)).size)
      .toBe(1);
    expect(canonicalJson(first.receipt)).not.toContain(root);
    expect(canonicalJson(first.receipt)).not.toContain("provider-payload");

    const { selfDigest: receiptDigest, ...unsigned } = first.receipt;
    expect(receiptDigest).toBe(first.receipt.selfDigest);
    const wrongCiRun = withSelfDigest({
      ...unsigned,
      ci: unsigned.ci.map((job, index) => index === 2 ? { ...job, runId: job.runId + 1 } : job),
    });
    const wrongDeployChain = withSelfDigest({
      ...unsigned,
      convex: {
        ...unsigned.convex,
        candidateRuntime: {
          ...unsigned.convex.candidateRuntime,
          previousDeployDigest: "f".repeat(64),
        },
      },
    });
    const liveBeforeDeploy = withSelfDigest({
      ...unsigned,
      convex: {
        ...unsigned.convex,
        candidateLive: {
          ...unsigned.convex.candidateLive,
          startedAt: unsigned.convex.candidateRuntime.deployedAtMs,
        },
      },
    });
    expect(releaseCandidateReceiptSchema.safeParse(wrongCiRun).success).toBeFalse();
    expect(releaseCandidateReceiptSchema.safeParse(wrongDeployChain).success).toBeFalse();
    expect(releaseCandidateReceiptSchema.safeParse(liveBeforeDeploy).success).toBeFalse();

    const replay = await createReleaseCandidateReceipt({
      evidence: paths,
      now: () => Date.parse("2026-08-24T14:00:00.000Z"),
      outputPath,
      provider,
      sourceCommit: candidateCommit,
      vercel,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.selfDigest).toBe(first.receipt.selfDigest);

    const interruptedPath = join(root, "interrupted-candidate.json");
    const interruptedTemporary = join(
      root,
      ".interrupted-candidate.json.0123456789abcdef0123456789abcdef.tmp",
    );
    await writeFile(
      interruptedTemporary,
      `${canonicalJson(first.receipt)}\n`,
      { mode: 0o600 },
    );
    await link(interruptedTemporary, interruptedPath);
    const interruptedReplay = await createReleaseCandidateReceipt({
      evidence: paths,
      now: () => Date.parse("2026-08-24T15:00:00.000Z"),
      outputPath: interruptedPath,
      provider,
      sourceCommit: candidateCommit,
      vercel,
    });
    expect(interruptedReplay.replayed).toBe(true);
    expect(interruptedReplay.receipt.selfDigest).toBe(first.receipt.selfDigest);
    expect((await lstat(interruptedPath)).nlink).toBe(1);
    expect(await Bun.file(interruptedTemporary).exists()).toBeFalse();
    expect(await verifyReleaseCandidateReceipt({
      expectedReleaseState: "absent",
      expectedTag: "absent",
      path: outputPath,
      provider,
    })).toEqual(first.receipt);
  });

  test("revalidates all volatile authority before both tag mutations and refuses drift with zero mutation", async () => {
    const root = await makeRoot();
    const { candidateRuntime, paths } = await writeEvidenceChain(root);
    const provider = new FakeCandidateProvider(candidateRuntime);
    const outputPath = join(root, "candidate.json");
    const sealed = await createReleaseCandidateReceipt({
      evidence: paths,
      now: () => Date.parse("2026-08-24T13:00:00.000Z"),
      outputPath,
      provider,
      sourceCommit: candidateCommit,
      vercel,
    });
    provider.calls.length = 0;

    const tagged = await tagReleaseCandidate({ path: outputPath, provider });
    expect(tagged).toEqual({
      candidateDigest: sealed.receipt.selfDigest,
      commit: candidateCommit,
      replayed: false,
      tag: HRA_RELEASE_TAG,
    });
    expect(provider.calls.filter((call) => call === "mutate:create-tag")).toHaveLength(1);
    expect(provider.calls.filter((call) => call === "mutate:push-tag")).toHaveLength(1);
    expect(provider.calls.lastIndexOf("runtime")).toBeLessThan(
      provider.calls.indexOf("mutate:push-tag"),
    );

    provider.remoteTag = null;
    provider.localTag = null;
    provider.runtime = { ...candidateRuntime, runtimeRevision: "00000000-0000-4000-8000-000000000099" };
    provider.calls.length = 0;
    await expect(tagReleaseCandidate({ path: outputPath, provider })).rejects.toThrow();
    expect(provider.calls.some((call) => call.startsWith("mutate:"))).toBe(false);
  });

  test("refuses arbitrary or swapped cutover plans before reading or mutating provider authority", async () => {
    for (const invalidPlan of ["arbitrary", "swapped"] as const) {
      const root = await makeRoot();
      const { candidateRuntime, paths } = await writeEvidenceChain(root, invalidPlan);
      const provider = new FakeCandidateProvider(candidateRuntime);
      await expect(createReleaseCandidateReceipt({
        evidence: paths,
        now: () => Date.parse("2026-08-24T13:00:00.000Z"),
        outputPath: join(root, "candidate.json"),
        provider,
        sourceCommit: candidateCommit,
        vercel,
      })).rejects.toThrow("evidence_chain_invalid");
      expect(provider.calls).toEqual([]);
      expect(provider.calls.some((call) => call.startsWith("mutate:"))).toBeFalse();
    }
  });

  test("the tag action alone requires both explicit irreversible acknowledgements", () => {
    const common = [
      "--candidate-receipt", "/protected/candidate.json",
      "--gh-cli", "/opt/homebrew/bin/gh",
      "--vercel-cli", "/opt/homebrew/bin/vercel",
    ];
    expect(parseCandidateArguments([
      "tag",
      ...common,
      "--execute",
      "--acknowledge-immutable-tag",
    ])).toEqual({
      action: "tag",
      candidateReceipt: "/protected/candidate.json",
      ghCli: "/opt/homebrew/bin/gh",
      vercelCli: "/opt/homebrew/bin/vercel",
    });
    expect(() => parseCandidateArguments(["tag", ...common, "--execute"])).toThrow();
    expect(() => parseCandidateArguments([
      "verify",
      ...common,
      "--acknowledge-immutable-tag",
    ])).toThrow();
  });
});
