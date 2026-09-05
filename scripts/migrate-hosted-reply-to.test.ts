import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  defaultHraOtpReplyTo,
  hraOtpReplyToEnvironmentName,
} from "../convex/otpEmailConfig";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import {
  HOSTED_ENVIRONMENT_NAMES,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  ConvexTargetError,
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  executeHostedReplyToMigration,
  HOSTED_REPLY_TO_LEGACY_PREREQUISITE,
  HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
  HOSTED_REPLY_TO_VALUE_DIGEST,
  hostedReplyToMigrationIntentSchema,
  hostedReplyToMigrationReceiptSchema,
  migrateHostedReplyTo,
  parseHostedReplyToMigrationArguments,
  serializeHostedReplyToMigration,
} from "./migrate-hosted-reply-to";
import {
  canonicalDigest,
  deployEvidenceSchema,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type DeployEvidence,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const sourceCommit = "a".repeat(40);
const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};
const targetArguments = [
  "--deployment", target.deploymentName,
  "--team-id", String(target.teamId),
  "--project-id", String(target.projectId),
  "--deployment-id", String(target.deploymentId),
  "--deployment-url", target.deploymentUrl,
] as const;

const previousDeployDigest = "b".repeat(64);
const previousAttestation: RuntimeReleaseAttestation = {
  bound: true,
  deployedAtMs: 1_000,
  previousDeployDigest: null,
  runtimeRevision: "00000000-0000-4000-8000-000000000001",
  runtimeSourceCommit: "c".repeat(40),
  schemaIdentity: "hra-release-attestation-v1",
  schemaVersion: 1,
};
const candidateAttestation: RuntimeReleaseAttestation = {
  bound: true,
  deployedAtMs: 2_000,
  previousDeployDigest,
  runtimeRevision: "00000000-0000-4000-8000-000000000002",
  runtimeSourceCommit: sourceCommit,
  schemaIdentity: "hra-release-attestation-v1",
  schemaVersion: 1,
};

const candidateEvidence = (
  overrides: Partial<Omit<DeployEvidence, "selfDigest">> = {},
): DeployEvidence => deployEvidenceSchema.parse(withSelfDigest({
  after: candidateAttestation,
  before: previousAttestation,
  kind: "convex-deploy" as const,
  overlaySha256: "d".repeat(64),
  phase: "candidate" as const,
  previousDeployDigest,
  schemaVersion: 1 as const,
  sourceCommit,
  target,
  targetDigest: canonicalDigest(target),
  ...overrides,
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeProtectedDirectory = async (label: string): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), label)));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

type HarnessOptions = Readonly<{
  candidate?: DeployEvidence;
  getResults?: readonly CommandResult[];
  gitHead?: string;
  gitStatus?: string;
  names?: readonly string[];
  removeNameAfterPreflight?: string;
  removeNameAfterSet?: string;
  setError?: Error;
  setExitCode?: number;
  setMutates?: boolean;
  value?: string;
}>;

const makeHarness = async (options: HarnessOptions = {}) => {
  const deployDirectory = await makeProtectedDirectory("hra-reply-deploy-");
  const outputDirectory = await makeProtectedDirectory("hra-reply-output-");
  const deployEvidencePath = join(deployDirectory, "candidate.json");
  const evidencePath = join(outputDirectory, "migration.json");
  const candidate = options.candidate ?? candidateEvidence();
  writeProtectedJsonNoReplace(deployEvidencePath, candidate, deployEvidenceSchema);
  const names = new Set(options.names ?? [
    ...HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
    HOSTED_REPLY_TO_LEGACY_PREREQUISITE,
    "UNRELATED_PROVIDER_NAME",
  ]);
  let value = options.value;
  const getResults = [...(options.getResults ?? [])];
  const requests: CommandRequest[] = [];
  let setCalls = 0;
  let attestationReads = 0;
  let targetChecks = 0;
  let providerCalls = 0;
  let currentAttestation: RuntimeReleaseAttestation = candidate.after;
  let lastPhase = "";
  let verifyHook: ((phase: string, count: number) => void) | undefined;
  const runner: CommandRunner = async (request) => {
    requests.push(request);
    lastPhase = request.phase;
    if (request.executable === "/usr/bin/git") {
      if (request.arguments[0] === "rev-parse") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${options.gitHead ?? sourceCommit}\n`,
        };
      }
      return { exitCode: 0, stderr: "", stdout: options.gitStatus ?? "" };
    }
    providerCalls += 1;
    if (request.phase.endsWith("names") || request.phase === "hosted-reply-to-names-read") {
      const result = { exitCode: 0, stderr: "", stdout: `${[...names].join("\n")}\n` };
      if (
        request.phase === "hosted-reply-to-preflight-names"
        && options.removeNameAfterPreflight !== undefined
      ) names.delete(options.removeNameAfterPreflight);
      return result;
    }
    if (request.phase === "hosted-reply-to-set") {
      setCalls += 1;
      if (options.setMutates !== false) {
        names.add(hraOtpReplyToEnvironmentName);
        value = defaultHraOtpReplyTo;
      }
      if (options.removeNameAfterSet !== undefined) {
        names.delete(options.removeNameAfterSet);
      }
      if (options.setError !== undefined) throw options.setError;
      return {
        exitCode: options.setExitCode ?? 0,
        stderr: "provider-set-failure-sentinel",
        stdout: "provider-set-output-sentinel",
      };
    }
    if (request.phase === "hosted-reply-to-value-read") {
      const queued = getResults.shift();
      if (queued !== undefined) return queued;
      return value === undefined
        ? { exitCode: 0, stderr: "Environment variable not found", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: `${value}\n` };
    }
    throw new Error(`Unexpected request phase: ${request.phase}`);
  };
  const verifyTarget: ConvexTargetVerifier = async (valueToVerify) => {
    expect(valueToVerify).toEqual(target);
    targetChecks += 1;
    verifyHook?.(lastPhase, targetChecks);
  };
  const readAttestation = async (): Promise<RuntimeReleaseAttestation> => {
    attestationReads += 1;
    return currentAttestation;
  };
  const run = async () => await migrateHostedReplyTo({
    deployEvidencePath,
    environment: {
      HOME: "/safe/operator",
      HRA_AUTH_EMAIL_REPLY_TO: defaultHraOtpReplyTo,
      HRA_FAILURE_SENTINEL: "environment-failure-sentinel",
      PATH: `/safe/bin:${defaultHraOtpReplyTo}`,
    },
    evidencePath,
    readAttestation,
    repositoryRoot: "/repo",
    runner,
    sourceCommit,
    target,
    verifyTarget,
  });
  return {
    candidate,
    deployDirectory,
    deployEvidencePath,
    evidencePath,
    get attestationReads() { return attestationReads; },
    get currentAttestation() { return currentAttestation; },
    set currentAttestation(valueToSet: RuntimeReleaseAttestation) {
      currentAttestation = valueToSet;
    },
    get names() { return names; },
    get providerCalls() { return providerCalls; },
    requests,
    run,
    setRemoteReplyTo(nextValue: string | undefined) {
      value = nextValue;
      if (nextValue === undefined) names.delete(hraOtpReplyToEnvironmentName);
      else names.add(hraOtpReplyToEnvironmentName);
    },
    get setCalls() { return setCalls; },
    setVerifyHook(hook: ((phase: string, count: number) => void) | undefined) {
      verifyHook = hook;
    },
    get targetChecks() { return targetChecks; },
  };
};

const executeArguments = (
  deployEvidencePath: string,
  evidencePath: string,
): readonly string[] => [
  ...targetArguments,
  "--source-commit", sourceCommit,
  "--deploy-evidence", deployEvidencePath,
  "--evidence-path", evidencePath,
];

describe("hosted Reply-To migration operator", () => {
  test("requires the source, candidate evidence, output evidence, and complete target tuple", () => {
    expect(parseHostedReplyToMigrationArguments([
      ...targetArguments,
      "--source-commit", sourceCommit,
      "--deploy-evidence", "/protected/candidate.json",
      "--evidence-path", "/protected/migration.json",
    ])).toEqual({
      deployEvidencePath: "/protected/candidate.json",
      evidencePath: "/protected/migration.json",
      sourceCommit,
      target,
    });
    for (const omitted of ["--source-commit", "--deploy-evidence", "--evidence-path"]) {
      const complete = [
        ...targetArguments,
        "--source-commit", sourceCommit,
        "--deploy-evidence", "/protected/candidate.json",
        "--evidence-path", "/protected/migration.json",
      ];
      const index = complete.indexOf(omitted);
      complete.splice(index, 2);
      expect(() => parseHostedReplyToMigrationArguments(complete)).toThrow("usage_invalid");
    }
    expect(() => parseHostedReplyToMigrationArguments([
      ...targetArguments,
      "--source-commit", "HEAD",
      "--deploy-evidence", "/protected/candidate.json",
      "--evidence-path", "/protected/migration.json",
    ])).toThrow("usage_invalid");
  });

  test("documents the checkout-only candidate deploy, migration, then status sequence", async () => {
    const packageDocument = JSON.parse(
      await Bun.file(resolve(import.meta.dir, "..", "package.json")).text(),
    ) as { scripts: Record<string, string> };
    expect(packageDocument.scripts["hosted:migrate-reply-to"])
      .toBe("bun ./scripts/migrate-hosted-reply-to.ts");
    const runbook = await Bun.file(
      resolve(import.meta.dir, "..", "docs", "hosted-sync.md"),
    ).text();
    const normalizedRunbook = runbook.replaceAll(/\s+/gu, " ");
    expect(normalizedRunbook).toContain("checkout-only package entry");
    expect(runbook).toContain("--source-commit <N_COMMIT>");
    expect(runbook).toContain("--deploy-evidence /protected/release/candidate-deploy.json");
    expect(runbook).toContain("--evidence-path /protected/release/reply-to-migration.json");
    expect(normalizedRunbook).toContain(
      "candidate deploy, this migration, and then `hosted:status --require-passed`",
    );
  });

  test("requires the exact clean source before any provider or attestation read", async () => {
    for (const options of [
      { gitHead: "e".repeat(40) },
      { gitStatus: " M package.json\n" },
    ]) {
      const harness = await makeHarness(options);
      await expect(harness.run()).rejects.toThrow("source_changed");
      expect(harness.providerCalls).toBe(0);
      expect(harness.attestationReads).toBe(0);
      expect(harness.setCalls).toBe(0);
    }
  });

  test("refuses candidate evidence or live release-attestation binding drift before mutation", async () => {
    const wrongSource = await makeHarness({
      candidate: candidateEvidence({
        after: {
          ...candidateAttestation,
          runtimeSourceCommit: "e".repeat(40),
        },
        sourceCommit: "e".repeat(40),
      }),
    });
    await expect(wrongSource.run()).rejects.toThrow("candidate_deploy_evidence_invalid");
    expect(wrongSource.providerCalls).toBe(0);

    const attestationDrift = await makeHarness();
    attestationDrift.currentAttestation = {
      ...candidateAttestation,
      runtimeRevision: "00000000-0000-4000-8000-000000000099",
    };
    await expect(attestationDrift.run()).rejects.toThrow("release_attestation_invalid");
    expect(attestationDrift.providerCalls).toBe(0);
    expect(attestationDrift.setCalls).toBe(0);
  });

  test("requires the exact predecessor names and retains the retired From name for rollback", async () => {
    const complete = await makeHarness();
    const result = await complete.run();
    expect(result.replayed).toBe(false);
    expect(complete.setCalls).toBe(1);
    expect(complete.names.has(HOSTED_REPLY_TO_LEGACY_PREREQUISITE)).toBe(true);

    const missingLegacy = await makeHarness({
      names: HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
    });
    await expect(missingLegacy.run()).rejects.toThrow("migration_prerequisites_missing");
    expect(missingLegacy.setCalls).toBe(0);
    await expect(stat(`${missingLegacy.evidencePath}.intent`)).rejects.toThrow();

    const legacyDrift = await makeHarness({
      removeNameAfterPreflight: HOSTED_REPLY_TO_LEGACY_PREREQUISITE,
    });
    await expect(legacyDrift.run()).rejects.toThrow("migration_prerequisites_missing");
    expect(legacyDrift.setCalls).toBe(0);
    expect((await stat(`${legacyDrift.evidencePath}.intent`)).mode & 0o777).toBe(0o600);

    for (const missing of HOSTED_REPLY_TO_MIGRATION_PREREQUISITES) {
      const harness = await makeHarness({
        names: [
          ...HOSTED_REPLY_TO_MIGRATION_PREREQUISITES.filter((name) => name !== missing),
          HOSTED_REPLY_TO_LEGACY_PREREQUISITE,
        ],
      });
      await expect(harness.run()).rejects.toThrow("migration_prerequisites_missing");
      expect(harness.setCalls).toBe(0);
    }
    expect(HOSTED_REPLY_TO_MIGRATION_PREREQUISITES).toEqual([
      "SITE_URL",
      "JWT_PRIVATE_KEY",
      "JWKS",
      "HRA_AUTH_HMAC_SECRET",
      "HRA_RESEND_API_KEY",
    ]);
    expect(HOSTED_REPLY_TO_LEGACY_PREREQUISITE).toBe("HRA_AUTH_EMAIL_FROM");
    expect([...HOSTED_ENVIRONMENT_NAMES]).toEqual([
      ...HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
      hraOtpReplyToEnvironmentName,
    ]);
  });

  test("refuses a preexisting replacement without a matching durable intent", async () => {
    const harness = await makeHarness({
      names: [
        ...HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
        HOSTED_REPLY_TO_LEGACY_PREREQUISITE,
        hraOtpReplyToEnvironmentName,
      ],
      value: defaultHraOtpReplyTo,
    });
    await expect(harness.run()).rejects.toThrow("reply_to_already_configured");
    expect(harness.setCalls).toBe(0);
    await expect(stat(`${harness.evidencePath}.intent`)).rejects.toThrow();
    await expect(stat(harness.evidencePath)).rejects.toThrow();
  });

  test("reconciles an exact value under a matching intent with zero writes and refuses conflict", async () => {
    for (const remoteValue of [defaultHraOtpReplyTo, "other@example.com"]) {
      const harness = await makeHarness();
      const intent = hostedReplyToMigrationIntentSchema.parse(withSelfDigest({
        candidateDeployDigest: harness.candidate.selfDigest,
        fixedValueDigest: HOSTED_REPLY_TO_VALUE_DIGEST,
        kind: "hosted-reply-to-migration-intent" as const,
        schemaVersion: 1 as const,
        sourceCommit,
        target,
        targetDigest: canonicalDigest(target),
      }));
      writeProtectedJsonNoReplace(
        `${harness.evidencePath}.intent`,
        intent,
        hostedReplyToMigrationIntentSchema,
      );
      harness.setRemoteReplyTo(remoteValue);
      if (remoteValue === defaultHraOtpReplyTo) {
        expect((await harness.run()).replayed).toBe(true);
        expect((await stat(harness.evidencePath)).mode & 0o777).toBe(0o600);
      } else {
        await expect(harness.run()).rejects.toThrow("migration_recovery_incomplete");
        await expect(stat(harness.evidencePath)).rejects.toThrow();
      }
      expect(harness.setCalls).toBe(0);
    }

    const missingLegacy = await makeHarness({
      names: HOSTED_REPLY_TO_MIGRATION_PREREQUISITES,
    });
    const intent = hostedReplyToMigrationIntentSchema.parse(withSelfDigest({
      candidateDeployDigest: missingLegacy.candidate.selfDigest,
      fixedValueDigest: HOSTED_REPLY_TO_VALUE_DIGEST,
      kind: "hosted-reply-to-migration-intent" as const,
      schemaVersion: 1 as const,
      sourceCommit,
      target,
      targetDigest: canonicalDigest(target),
    }));
    writeProtectedJsonNoReplace(
      `${missingLegacy.evidencePath}.intent`,
      intent,
      hostedReplyToMigrationIntentSchema,
    );
    missingLegacy.setRemoteReplyTo(defaultHraOtpReplyTo);
    await expect(missingLegacy.run()).rejects.toThrow("migration_recovery_incomplete");
    expect(missingLegacy.setCalls).toBe(0);
  });

  test("reconciles a lost or nonzero set response in the same invocation with exactly one set", async () => {
    for (const setOutcome of [
      { setError: new Error("lost-set-response-sentinel") },
      { setExitCode: 1 },
    ]) {
      const harness = await makeHarness(setOutcome);
      const result = await harness.run();
      expect(result.replayed).toBe(false);
      expect(harness.setCalls).toBe(1);
      expect(harness.requests.filter((request) => request.phase === "hosted-reply-to-set"))
        .toHaveLength(1);
      const phases = harness.requests.map((request) => request.phase);
      const setIndex = phases.indexOf("hosted-reply-to-set");
      expect(phases.slice(setIndex + 1, setIndex + 3)).toEqual([
        "hosted-reply-to-value-read",
        "hosted-reply-to-names-read",
      ]);
    }
  });

  test("requires byte-exact get output and a complete seven-name readback", async () => {
    const getFailures: readonly CommandResult[] = [
      { exitCode: 0, stderr: "Environment variable not found", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "other@example.com\n" },
      { exitCode: 0, stderr: "", stdout: `${defaultHraOtpReplyTo}\nextra\n` },
      { exitCode: 0, stderr: "warning", stdout: `${defaultHraOtpReplyTo}\n` },
      { exitCode: 1, stderr: "provider-get-failure", stdout: `${defaultHraOtpReplyTo}\n` },
    ];
    for (const getResult of getFailures) {
      const harness = await makeHarness({ getResults: [getResult] });
      await expect(harness.run()).rejects.toThrow("convex_environment_set_failed");
      expect(harness.setCalls).toBe(1);
    }
    for (const removed of ["JWKS", HOSTED_REPLY_TO_LEGACY_PREREQUISITE]) {
      const incomplete = await makeHarness({ removeNameAfterSet: removed });
      await expect(incomplete.run()).rejects.toThrow("convex_environment_set_failed");
      expect(incomplete.setCalls).toBe(1);
    }
  });

  test("restarts from an exact intent by reading remote state and never issuing a second set", async () => {
    const harness = await makeHarness({
      getResults: [{ exitCode: 0, stderr: "", stdout: "" }],
    });
    await expect(harness.run()).rejects.toThrow("convex_environment_set_failed");
    expect(harness.setCalls).toBe(1);
    expect((await stat(`${harness.evidencePath}.intent`)).mode & 0o777).toBe(0o600);
    const result = await harness.run();
    expect(result.replayed).toBe(true);
    expect(harness.setCalls).toBe(1);
    expect((await stat(harness.evidencePath)).mode & 0o777).toBe(0o600);
  });

  test("stops on target drift around get and later reconciles without another set", async () => {
    const harness = await makeHarness();
    let drifted = false;
    harness.setVerifyHook((phase) => {
      if (phase === "hosted-reply-to-value-read" && !drifted) {
        drifted = true;
        throw new ConvexTargetError("target_mismatch");
      }
    });
    await expect(harness.run()).rejects.toThrow("target_mismatch");
    expect(harness.setCalls).toBe(1);
    harness.setVerifyHook(undefined);
    expect((await harness.run()).replayed).toBe(true);
    expect(harness.setCalls).toBe(1);
  });

  test("replays a receipt only after fresh source, target, environment, and attestation proof", async () => {
    const harness = await makeHarness();
    expect((await harness.run()).replayed).toBe(false);
    const firstAttestationReads = harness.attestationReads;
    const firstProviderCalls = harness.providerCalls;
    expect((await harness.run()).replayed).toBe(true);
    expect(harness.attestationReads).toBeGreaterThan(firstAttestationReads);
    expect(harness.providerCalls).toBe(firstProviderCalls + 2);
    expect(harness.setCalls).toBe(1);

    harness.names.delete(HOSTED_REPLY_TO_LEGACY_PREREQUISITE);
    await expect(harness.run()).rejects.toThrow("convex_environment_verification_failed");
    expect(harness.setCalls).toBe(1);
    harness.names.add(HOSTED_REPLY_TO_LEGACY_PREREQUISITE);

    harness.currentAttestation = {
      ...candidateAttestation,
      runtimeRevision: "00000000-0000-4000-8000-000000000099",
    };
    const providerCalls = harness.providerCalls;
    await expect(harness.run()).rejects.toThrow("release_attestation_invalid");
    expect(harness.providerCalls).toBe(providerCalls);
    expect(harness.setCalls).toBe(1);
  });

  test("persists exact protected evidence bound to source, target, candidate, intent, and value digests", async () => {
    const harness = await makeHarness();
    const result = await harness.run();
    const intent = readProtectedJson(
      `${harness.evidencePath}.intent`,
      hostedReplyToMigrationIntentSchema,
    );
    const receipt = readProtectedJson(
      harness.evidencePath,
      hostedReplyToMigrationReceiptSchema,
    );
    expect(intent.sourceCommit).toBe(sourceCommit);
    expect(intent.targetDigest).toBe(canonicalDigest(target));
    expect(intent.candidateDeployDigest).toBe(harness.candidate.selfDigest);
    expect(intent.fixedValueDigest).toBe(HOSTED_REPLY_TO_VALUE_DIGEST);
    expect(receipt.intentDigest).toBe(intent.selfDigest);
    expect(receipt).toEqual(result.receipt);
    for (const path of [harness.evidencePath, `${harness.evidencePath}.intent`]) {
      const metadata = await stat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
    }
  });

  test("refuses unprotected candidate or output evidence custody before mutation", async () => {
    const candidateMode = await makeHarness();
    await chmod(candidateMode.deployEvidencePath, 0o644);
    await expect(candidateMode.run()).rejects.toThrow("candidate_deploy_evidence_invalid");
    expect(candidateMode.setCalls).toBe(0);

    const outputMode = await makeHarness();
    await chmod(resolve(outputMode.evidencePath, ".."), 0o755);
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedReplyToMigration({
      arguments: executeArguments(outputMode.deployEvidencePath, outputMode.evidencePath),
      readAttestation: async () => candidateAttestation,
      repositoryRoot: "/repo",
      runner: async (request) => request.executable === "/usr/bin/git"
        ? request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: "" },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Hosted Reply-To migration refused (migration_evidence_invalid).\n",
    ]);
  });

  test("does not leak provider failures, inherited values, or the fixed mailbox", async () => {
    const harness = await makeHarness({ setExitCode: 1 });
    await harness.run();
    expect(harness.requests.every((request) => (
      !JSON.stringify(request.arguments).includes(defaultHraOtpReplyTo)
      && !JSON.stringify(request.environment).includes(defaultHraOtpReplyTo)
      && !JSON.stringify(request.environment).includes("environment-failure-sentinel")
    ))).toBe(true);
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedReplyToMigration({
      arguments: executeArguments(harness.deployEvidencePath, harness.evidencePath),
      environment: {
        HOME: "/safe/operator",
        HRA_FAILURE_SENTINEL: "environment-failure-sentinel",
        PATH: `/safe/bin:${defaultHraOtpReplyTo}`,
      },
      readAttestation: async () => candidateAttestation,
      repositoryRoot: "/repo",
      runner: async (request) => {
        if (request.executable === "/usr/bin/git") {
          return request.arguments[0] === "rev-parse"
            ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
            : { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.phase.endsWith("names") || request.phase === "hosted-reply-to-names-read") {
          return {
            exitCode: 0,
            stderr: "provider-read-failure-sentinel",
            stdout: "provider-read-output-sentinel",
          };
        }
        throw new Error("unexpected");
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    const publicSurface = JSON.stringify({ stderr, stdout });
    expect(publicSurface).not.toContain("provider-read");
    expect(publicSurface).not.toContain("environment-failure");
    expect(publicSurface).not.toContain(defaultHraOtpReplyTo);
    expect(serializeHostedReplyToMigration()).toBe(
      `${hraOtpReplyToEnvironmentName}='${defaultHraOtpReplyTo}'\n`,
    );
  });

  test("stops without readback on cleanup, recovery-journal, or authority failure", async () => {
    for (const error of [
      new BoundedProcessCleanupUnprovenError(42_432, "hosted-reply-to-set"),
      new BoundedProcessRecoveryJournalError(
        ["/private/operator/recovery.json"],
        "authority_recovery_required",
      ),
      new BoundedProcessContainmentUnavailableError("authority_unsupported_platform"),
    ]) {
      const harness = await makeHarness({ setError: error });
      await expect(harness.run()).rejects.toThrow();
      expect(harness.setCalls).toBe(1);
      expect(harness.requests.some((request) => (
        request.phase === "hosted-reply-to-value-read"
      ))).toBe(false);
    }
  });
});
