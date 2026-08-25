import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import {
  deployHostedSync,
  executeHostedDeploy,
  parseDeployArguments,
  resolvedTargetAssertionCommand,
} from "./deploy-hosted-sync";
import {
  parseDeployEvidenceFile,
  type RuntimeReleaseAttestation,
} from "./release-evidence";
import {
  HRA_EXPECTED_CONVEX_DEPLOY_URL,
  HRA_RESOLVED_CONVEX_DEPLOY_URL,
  resolvedConvexDeployTargetMatches,
} from "./assert-convex-deploy-target";
import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const sourceCommit = "a".repeat(40);
const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};
const targetArguments = [
  "--deployment",
  target.deploymentName,
  "--team-id",
  String(target.teamId),
  "--project-id",
  String(target.projectId),
  "--deployment-id",
  String(target.deploymentId),
  "--deployment-url",
  target.deploymentUrl,
] as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeTemporaryDirectory = async (label: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

describe("verified hosted deployment", () => {
  test("ships the Convex typecheck project required by the deploy gate", async () => {
    const configuration = JSON.parse(await readFile(
      join(import.meta.dir, "..", "convex", "tsconfig.json"),
      "utf8",
    )) as unknown;

    expect(configuration).toEqual({
      compilerOptions: {
        allowJs: true,
        allowImportingTsExtensions: true,
        allowSyntheticDefaultImports: true,
        exactOptionalPropertyTypes: true,
        forceConsistentCasingInFileNames: true,
        isolatedModules: true,
        jsx: "react-jsx",
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleDetection: "force",
        moduleResolution: "Bundler",
        noEmit: true,
        noFallthroughCasesInSwitch: true,
        noImplicitOverride: true,
        noUncheckedIndexedAccess: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2024",
      },
      exclude: ["./_generated", "./**/*.test.ts", "./test.setup.ts"],
      include: ["./**/*.ts"],
    });
  });

  test("binds deploy to one exact generated target and clean source without inheriting stale selectors", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-source-");
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-binding-");
    await writeFile(
      join(repositoryRoot, ".env.local"),
      "CONVEX_DEPLOYMENT=prod:stale-beaver-999\n",
      "utf8",
    );
    const requests: CommandRequest[] = [];
    let bindingDocument = "";
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      const envFileIndex = request.arguments.indexOf("--env-file");
      const envFile = request.arguments[envFileIndex + 1];
      if (envFile === undefined) throw new Error("missing test env file");
      bindingDocument = await readFile(envFile, "utf8");
      return {
        exitCode: 0,
        stderr: "provider-stderr-sentinel",
        stdout: "provider-stdout-sentinel",
      };
    };
    const verified: ConvexTarget[] = [];
    const verifyTarget: ConvexTargetVerifier = async (value) => {
      verified.push(value);
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const badKey = "hostile-deploy-key";

    const exitCode = await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      environment: {
        CONVEX_DEPLOYMENT: "prod:stale-beaver-999",
        CONVEX_DEPLOY_KEY: badKey,
        HOME: "/operator-home",
        PATH: "/safe/bin",
      },
      repositoryRoot,
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget,
    });

    expect(exitCode).toBe(0);
    expect(verified).toEqual([target, target]);
    expect(bindingDocument).toBe(`CONVEX_DEPLOYMENT=prod:${target.deploymentName}\n`);
    const deployRequest = requests.find((request) => request.executable !== "/usr/bin/git");
    if (deployRequest === undefined) throw new Error("missing deploy request");
    const bindingPath = deployRequest.arguments[3];
    if (bindingPath === undefined) throw new Error("missing deploy binding path");
    expect(deployRequest.arguments.slice(1)).toEqual([
      "deploy",
      "--env-file",
      bindingPath,
      "--yes",
      "--typecheck",
      "enable",
      "--codegen",
      "disable",
      "--cmd",
      resolvedTargetAssertionCommand,
      "--cmd-url-env-var-name",
      HRA_RESOLVED_CONVEX_DEPLOY_URL,
      "--skip-workos-check",
      "--message",
      `HRA source ${sourceCommit}`,
    ]);
    expect(deployRequest.environment).toEqual({
      HOME: "/operator-home",
      [HRA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
      NO_COLOR: "1",
      PATH: "/safe/bin",
      TERM: "dumb",
    });
    expect(deployRequest.timeoutMs).toBe(600_000);
    expect(deployRequest.outputMaximumBytes).toBe(524_288);
    expect(requests.filter((request) => request.executable === "/usr/bin/git" || request.executable === "/usr/bin/tar")
      .every((request) => request.containment === "local")).toBe(true);
    expect(requests.filter((request) => request.executable !== "/usr/bin/git" && request.executable !== "/usr/bin/tar")
      .every((request) => request.containment === "authority")).toBe(true);
    expect(requests.filter((request) => request.executable === "/usr/bin/git")).toHaveLength(4);
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect(stdout).toEqual([`Deployed exact source ${sourceCommit} to the verified target.\n`]);
    expect(stderr).toEqual([]);
    expect(JSON.stringify({ stderr, stdout })).not.toContain("provider-stdout-sentinel");
    expect(JSON.stringify({ stderr, stdout })).not.toContain("provider-stderr-sentinel");
  });

  test("the mandatory pre-push command refuses a deployment resolved after a default switch", () => {
    const environment = {
      [HRA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
      [HRA_RESOLVED_CONVEX_DEPLOY_URL]: "https://other-otter-999.convex.cloud",
    };
    expect(resolvedConvexDeployTargetMatches(environment)).toBeFalse();
    expect(resolvedTargetAssertionCommand).toContain("assert-convex-deploy-target.ts");
  });

  test("refuses an unavailable authority backend without postflight or cleanup-recovery output", async () => {
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-authority-unavailable-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: CommandRequest[] = [];
    let verifications = 0;
    expect(await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner: async (request) => {
        requests.push(request);
        if (request.containment === "authority") {
          throw new BoundedProcessContainmentUnavailableError(
            "authority_backend_unavailable",
          );
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).toBe(1);
    expect(requests.some((request) => request.containment === "authority")).toBe(true);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "authority_containment_unavailable",
      reason: "authority_backend_unavailable",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("process_cleanup_unproven");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("renders unproven deployment cleanup as a recovery-required temporary failure", async () => {
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-cleanup-unproven-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    let authorityCalls = 0;
    let verifications = 0;
    const recoveryPath = "/private/operator/process-recovery/local-deploy.json";
    const cleanup = new BoundedProcessCleanupUnprovenError(
      42_433,
      "convex-deploy",
    ).retainRecoveryPath(recoveryPath);
    expect(await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner: async (request) => {
        if (request.containment === "authority") {
          authorityCalls += 1;
          throw cleanup;
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).toBe(75);
    expect(authorityCalls).toBe(1);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    const preserved = await readdir(temporaryRoot);
    expect(preserved).toHaveLength(1);
    const bindingRecoveryPath = join(temporaryRoot, preserved[0] ?? "missing");
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "process_cleanup_unproven",
      phase: "convex-deploy",
      processGroupId: 42_433,
      processes: [{
        phase: "convex-deploy",
        recoveryIdentity: { containment: "local", processGroupId: 42_433 },
      }],
      recoveryPaths: [bindingRecoveryPath, recoveryPath].sort(),
      schemaVersion: 1,
      status: "recovery_required",
    });
  });

  test("preserves a blocked deployment recovery journal", async () => {
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-journal-blocked-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    let verifications = 0;
    const recoveryPath = "/private/operator/process-recovery/authority-deploy.json";
    expect(await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner: async (request) => {
        if (request.containment === "authority") {
          throw new BoundedProcessRecoveryJournalError(
            [recoveryPath],
            "authority_recovery_required",
          );
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).toBe(75);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "process_recovery_journal_blocked",
      reason: "authority_recovery_required",
      recoveryPaths: [recoveryPath],
      schemaVersion: 1,
      status: "recovery_required",
    });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("surfaces a source archive root when local preparation cleanup is unproven", async () => {
    for (const failedExecutable of ["/usr/bin/git", "/usr/bin/tar"] as const) {
      const repositoryRoot = await makeTemporaryDirectory("hra-hosted-archive-terminal-source-");
      const temporaryRoot = await makeTemporaryDirectory("hra-hosted-archive-terminal-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("hra-hosted-archive-terminal-evidence-"),
      );
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, "bootstrap.json");
      const processRecoveryPath = `/private/operator/process-recovery/${failedExecutable.endsWith("git") ? "git" : "tar"}.json`;
      const cleanup = new BoundedProcessCleanupUnprovenError(
        failedExecutable.endsWith("git") ? 42_451 : 42_452,
        failedExecutable.endsWith("git") ? "git-source-read" : "source-archive-extract",
      ).retainRecoveryPath(processRecoveryPath);
      const requests: CommandRequest[] = [];
      let verifications = 0;

      await expect(deployHostedSync({
        evidencePath,
        phase: "bootstrap",
        readAttestation: async () => null,
        repositoryRoot,
        revision: () => "00000000-0000-4000-8000-000000000051",
        runner: async (request) => {
          requests.push(request);
          if (
            request.executable === failedExecutable
            && (failedExecutable === "/usr/bin/tar" || request.arguments[0] === "archive")
          ) throw cleanup;
          return request.arguments[0] === "rev-parse"
            ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
            : { exitCode: 0, stderr: "", stdout: "" };
        },
        sourceCommit,
        target,
        temporaryRoot,
        verifyTarget: async () => { verifications += 1; },
      })).rejects.toBe(cleanup);

      const preserved = await readdir(temporaryRoot);
      expect(preserved).toHaveLength(1);
      const sourceRecoveryPath = join(temporaryRoot, preserved[0] ?? "missing");
      expect(cleanup.recoveryPaths).toEqual([
        evidencePath,
        `${evidencePath}.intent`,
        processRecoveryPath,
        sourceRecoveryPath,
      ].sort());
      expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
      expect(verifications).toBe(1);
      expect(requests.at(-1)?.executable).toBe(failedExecutable);
      expect(requests.some((request) => request.containment === "authority")).toBe(false);
    }
  });

  test("surfaces every preserved deploy root and durable intent without postflight", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-deploy-terminal-source-");
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-deploy-terminal-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("hra-hosted-deploy-terminal-evidence-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    const processRecoveryPath = "/private/operator/process-recovery/provider-deploy.json";
    const cleanup = new BoundedProcessCleanupUnprovenError(
      42_453,
      "convex-deploy",
    ).retainRecoveryPath(processRecoveryPath);
    const requests: CommandRequest[] = [];
    let verifications = 0;
    let authorityCalls = 0;

    await expect(deployHostedSync({
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => null,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000052",
      runner: async (request) => {
        requests.push(request);
        if (request.executable === "/usr/bin/tar") {
          const destination = request.arguments[3];
          if (destination === undefined) throw new Error("missing archive destination");
          await mkdir(join(destination, "convex"), { recursive: true, mode: 0o700 });
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.containment === "authority") {
          authorityCalls += 1;
          throw cleanup;
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).rejects.toBe(cleanup);

    const preserved = await readdir(temporaryRoot);
    expect(preserved).toHaveLength(2);
    expect(cleanup.recoveryPaths).toEqual([
      evidencePath,
      `${evidencePath}.intent`,
      processRecoveryPath,
      ...preserved.map((name) => join(temporaryRoot, name)),
    ].sort());
    expect(authorityCalls).toBe(1);
    expect(verifications).toBe(1);
    expect(requests.at(-1)?.phase).toBe("convex-deploy");
    expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
  });

  test("refuses a dirty or wrong source before target verification or provider mutation", async () => {
    const requests: CommandRequest[] = [];
    let verifications = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.arguments[0] === "rev-parse") {
        return { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` };
      }
      return { exitCode: 0, stderr: "", stdout: "?? hostile-untracked\n" };
    };

    await expect(deployHostedSync({
      repositoryRoot: "/repo",
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => {
        verifications += 1;
      },
    })).rejects.toThrow("source_changed");
    expect(verifications).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBe(true);
  });

  test("always performs numeric postflight after an attempted deploy and suppresses failure output", async () => {
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-failed-binding-");
    let verification = 0;
    const runner: CommandRunner = async (request) => {
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      return {
        exitCode: 1,
        stderr: "sensitive-provider-failure",
        stdout: "sensitive-provider-output",
      };
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => {
        verification += 1;
      },
    });

    expect(exitCode).toBe(1);
    expect(verification).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Hosted deploy refused (convex_deploy_failed).\n"]);
    expect(JSON.stringify({ stderr, stdout })).not.toContain("sensitive-provider");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("requires an exact lowercase source commit and closed target arguments", () => {
    expect(parseDeployArguments([...targetArguments, "--source-commit", sourceCommit]))
      .toEqual({ sourceCommit, target });
    expect(() => parseDeployArguments([...targetArguments, "--source-commit", "HEAD"]))
      .toThrow("usage_invalid");
    expect(() => parseDeployArguments([
      ...targetArguments.slice(0, 3),
      String(HRA_CONVEX_TEAM_ID + 1),
      ...targetArguments.slice(4),
      "--source-commit",
      sourceCommit,
    ])).toThrow("usage_invalid");
    expect(() => parseDeployArguments([
      ...targetArguments,
      "--source-commit",
      sourceCommit,
      "--force",
    ])).toThrow("usage_invalid");
  });

  test("deploys a deterministic archive overlay, reconciles a lost result, and replays without mutation", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-evidence-source-");
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-evidence-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("hra-hosted-evidence-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    const requests: CommandRequest[] = [];
    let runtime: RuntimeReleaseAttestation | null = null;
    let deploymentCalls = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable === "/usr/bin/git") {
        if (request.arguments[0] === "rev-parse") {
          return { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.executable === "/usr/bin/tar") {
        const destination = request.arguments[3];
        if (destination === undefined) throw new Error("missing archive destination");
        await mkdir(join(destination, "convex"), { recursive: true, mode: 0o700 });
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      deploymentCalls += 1;
      const overlay = await readFile(join(request.cwd, "convex", "releaseAttestation.ts"), "utf8");
      const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
      if (match?.[1] === undefined) throw new Error("missing attestation overlay");
      runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
      return { exitCode: 1, stderr: "lost provider response", stdout: "" };
    };
    const readAttestation = async (): Promise<RuntimeReleaseAttestation | null> => runtime;

    const first = await deployHostedSync({
      environment: { PATH: "/hostile/git-bin" },
      evidencePath,
      now: () => 1_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000010",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    });
    expect(first).toEqual(parseDeployEvidenceFile(evidencePath));
    expect(first).toMatchObject({
      after: {
        deployedAtMs: 1_000,
        runtimeRevision: "00000000-0000-4000-8000-000000000010",
        runtimeSourceCommit: sourceCommit,
      },
      before: null,
      phase: "bootstrap",
      sourceCommit,
    });
    expect(deploymentCalls).toBe(1);
    expect(requests.some((request) => request.arguments[0] === "archive")).toBe(true);
    expect(requests.find((request) => request.arguments[0] === "archive")).toMatchObject({
      environment: { PATH: "/hostile/git-bin" },
      executable: "/usr/bin/git",
    });
    expect(requests.find((request) => request.executable !== "/usr/bin/git" && request.executable !== "/usr/bin/tar")?.cwd)
      .toContain("hra-hosted-source-");

    const requestCount = requests.length;
    const replay = await deployHostedSync({
      environment: { PATH: "/hostile/git-bin" },
      evidencePath,
      now: () => 2_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000099",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    });
    expect(replay?.selfDigest).toBe(first?.selfDigest);
    expect(deploymentCalls).toBe(1);
    expect(requests.slice(requestCount).every((request) => request.executable === "/usr/bin/git"))
      .toBe(true);
  });

  test("reconciles a committed bootstrap intent across invocations without redeploying", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-crash-source-");
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-crash-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("hra-hosted-crash-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    let runtime: RuntimeReleaseAttestation | null = null;
    let deploymentCalls = 0;
    let authorityReads = 0;
    const runner: CommandRunner = async (request) => {
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.executable === "/usr/bin/tar") {
        const destination = request.arguments[3];
        if (destination === undefined) throw new Error("missing archive destination");
        await mkdir(join(destination, "convex"), { recursive: true, mode: 0o700 });
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      deploymentCalls += 1;
      const overlay = await readFile(join(request.cwd, "convex", "releaseAttestation.ts"), "utf8");
      const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
      if (match?.[1] === undefined) throw new Error("missing attestation overlay");
      runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
      return { exitCode: 0, stderr: "", stdout: "deployed" };
    };
    const readAttestation = async (): Promise<RuntimeReleaseAttestation | null> => {
      authorityReads += 1;
      if (authorityReads === 3) throw new Error("lost post-deploy authority read");
      return runtime;
    };

    await expect(deployHostedSync({
      evidencePath,
      now: () => 4_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000040",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("lost post-deploy authority read");
    expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
    expect(deploymentCalls).toBe(1);

    const reconciled = await deployHostedSync({
      evidencePath,
      now: () => 9_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000099",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    });
    expect(reconciled).toEqual(parseDeployEvidenceFile(evidencePath));
    expect(reconciled?.after.runtimeRevision)
      .toBe("00000000-0000-4000-8000-000000000040");
    expect(deploymentCalls).toBe(1);
  });

  test("does not reserve a bootstrap intent for a foreign committed runtime", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-foreign-source-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("hra-hosted-foreign-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    let deploymentCalls = 0;
    const foreignRuntime: RuntimeReleaseAttestation = {
      bound: true,
      deployedAtMs: 1,
      previousDeployDigest: null,
      runtimeRevision: "00000000-0000-4000-8000-000000000001",
      runtimeSourceCommit: "b".repeat(40),
      schemaIdentity: "hra-release-attestation-v1",
      schemaVersion: 1,
    };
    const runner: CommandRunner = async (request) => {
      if (request.executable !== "/usr/bin/git") deploymentCalls += 1;
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    };

    await expect(deployHostedSync({
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => foreignRuntime,
      repositoryRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("source_changed");
    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(deploymentCalls).toBe(0);
  });

  test("refuses an ambiguous bootstrap attestation pre-read before archive or provider mutation", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-preread-source-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("hra-hosted-preread-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const requests: CommandRequest[] = [];
    let authoritySignal: AbortSignal | undefined;
    const authorityFetch = Object.assign((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      authoritySignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    }, { preconnect: () => undefined }) as typeof fetch;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable !== "/usr/bin/git") throw new Error("unexpected mutation");
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    };

    const startedAt = performance.now();
    await expect(deployHostedSync({
      authorityFetch,
      authorityTimeoutMs: 10,
      evidencePath: join(evidenceDirectory, "bootstrap.json"),
      phase: "bootstrap",
      repositoryRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("convex_deploy_failed");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(authoritySignal?.aborted).toBeTrue();
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBe(true);
    expect(requests.some((request) => request.arguments[0] === "archive")).toBe(false);
  });

  test("refuses an invalid existing evidence destination before archive or deployment", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-invalid-evidence-source-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("hra-hosted-invalid-evidence-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    await writeFile(evidencePath, "{}\n", { mode: 0o644 });
    await chmod(evidencePath, 0o644);
    const requests: CommandRequest[] = [];
    let authorityReads = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable !== "/usr/bin/git") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    };

    await expect(deployHostedSync({
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => {
        authorityReads += 1;
        return null;
      },
      repositoryRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("evidence_file_invalid");
    expect(authorityReads).toBe(0);
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBeTrue();
    expect(requests.some((request) => request.arguments[0] === "archive")).toBeFalse();
  });
});
